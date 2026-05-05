import { checkSlippageTolerance } from './useFillSimulator.js';

// Skip with a permanent flag (never retry this exact leader trade)
const PERM = (reason) => ({ skip: true, reason, isPermanent: true });
// Skip transiently (may succeed on next poll if conditions change)
const TRANS = (reason) => ({ skip: true, reason, isPermanent: false });
const PASS = (extras = {}) => ({ skip: false, ...extras });

// Computes the dollar stake before any safety-cap or balance trimming.
// Returns null if the sizing mode is unsupported in MVP (e.g. portfolio).
export function computeRawStake(registry, leaderTrade) {
  const dollars = (leaderTrade.totalBought ?? 0) * (leaderTrade.avgPrice ?? 0);
  if (registry.sizingMode === 'fixed') {
    return registry.fixedAmt ?? 0;
  }
  if (registry.sizingMode === 'percentage') {
    return dollars * ((registry.pctAmt ?? 0) / 100);
  }
  if (registry.sizingMode === 'portfolio') {
    // MVP: portfolio mode requires leader portfolio snapshot at trade time
    // which we don't compute live. Fall back to fixed amount.
    return registry.fixedAmt ?? 0;
  }
  return 0;
}

// Pre-fill guards — run BEFORE fetching the CLOB book. Cheap checks first.
//
// ctx: {
//   leaderTrade,       // { conditionId, outcome, avgPrice, totalBought, side, category }
//   registry,          // PTRegistry
//   account,           // PTAccount { cash }
//   openPositions,     // PTPosition[] for this trader
//   todayCount,        // # paper trades opened today (ET)
//   todayLossUsd,
//   weekLossUsd,
//   lifetimeLossUsd,
//   leaderHadPriorPosition, // for newMarketsOnly check
//   eventId,           // optional, for per-event cap (Polymarket eventId)
// }
//
// Returns { skip, reason, isPermanent } on failure or { skip: false, stake } on pass.
export function evaluatePreFillGuards(ctx) {
  const { leaderTrade, registry, account, openPositions } = ctx;
  const r = registry;

  if (r.status === 'paused') return TRANS('TRADER_PAUSED');
  if (r.status === 'stopped') return PERM('TRADER_STOPPED');
  if (!(account?.cash > 0)) return TRANS('NO_BALANCE');

  // Side filter — MVP is buys-only
  if (r.copyMode === 'buys_only' && leaderTrade.side && leaderTrade.side !== 'BUY') {
    return PERM('SELL_FILTERED');
  }

  // Already open in same conditionId+outcome
  const dup = openPositions?.some(
    (p) =>
      p.conditionId === leaderTrade.conditionId &&
      String(p.outcome).toLowerCase() === String(leaderTrade.outcome).toLowerCase()
  );
  if (dup) return PERM('POSITION_EXISTS');

  if (r.newMarketsOnly && ctx.leaderHadPriorPosition) return PERM('NOT_NEW_MARKET');

  const leaderDollars = (leaderTrade.totalBought ?? 0) * (leaderTrade.avgPrice ?? 0);
  if (r.minTradeSize != null && leaderDollars < r.minTradeSize) return PERM('TRADE_TOO_SMALL');
  if (r.maxTradeSize != null && leaderDollars > r.maxTradeSize) return PERM('TRADE_TOO_LARGE');
  if (r.minPrice != null && leaderTrade.avgPrice < r.minPrice) return PERM('PRICE_TOO_LOW');
  if (r.maxPrice != null && leaderTrade.avgPrice > r.maxPrice) return PERM('PRICE_TOO_HIGH');

  if (r.blockedCategories?.length && leaderTrade.category &&
      r.blockedCategories.includes(leaderTrade.category)) {
    return PERM('BLOCKED_CATEGORY');
  }
  if (r.blockedMarkets?.length && r.blockedMarkets.includes(leaderTrade.conditionId)) {
    return PERM('BLOCKED_MARKET');
  }

  if (r.maxTradesDay != null && (ctx.todayCount ?? 0) >= r.maxTradesDay)
    return TRANS('DAILY_LIMIT');
  if (r.dailyLossLimit != null && (ctx.todayLossUsd ?? 0) >= r.dailyLossLimit)
    return TRANS('DAILY_LOSS');
  if (r.weeklyLossLimit != null && (ctx.weekLossUsd ?? 0) >= r.weeklyLossLimit)
    return TRANS('WEEKLY_LOSS');
  if (r.lifetimeLossLimit != null && (ctx.lifetimeLossUsd ?? 0) >= r.lifetimeLossLimit)
    return PERM('LIFETIME_LOSS');

  // Position & budget caps
  if (r.maxEventsOpen != null && ctx.eventId) {
    const distinctEvents = new Set(openPositions?.map((p) => p.eventId).filter(Boolean));
    if (!distinctEvents.has(ctx.eventId) && distinctEvents.size >= r.maxEventsOpen)
      return TRANS('MAX_EVENTS');
  }

  const totalExposure = openPositions?.reduce((s, p) => s + (p.totalCost ?? 0), 0) ?? 0;
  if (r.totalBudget != null && totalExposure >= r.totalBudget) return TRANS('BUDGET_CAP');

  if (r.perQuestionCap != null) {
    const qExposure = openPositions
      ?.filter((p) => p.conditionId === leaderTrade.conditionId)
      ?.reduce((s, p) => s + (p.totalCost ?? 0), 0) ?? 0;
    if (qExposure >= r.perQuestionCap) return PERM('QUESTION_CAP');
  }
  if (r.perEventCap != null && ctx.eventId) {
    const eExposure = openPositions
      ?.filter((p) => p.eventId === ctx.eventId)
      ?.reduce((s, p) => s + (p.totalCost ?? 0), 0) ?? 0;
    if (eExposure >= r.perEventCap) return PERM('EVENT_CAP');
  }

  // Compute stake now that all filters passed
  const rawStake = computeRawStake(r, leaderTrade);
  if (!(rawStake > 0)) return PERM('STAKE_ZERO');

  let stake = rawStake;
  if (r.safetyCap != null && stake > r.safetyCap) {
    // Safety cap is a HARD permanent skip per GodEye semantics — not a clip
    return PERM('SAFETY_CAP');
  }

  // Trim to available cash (this is not a skip — partial copy is acceptable)
  if (stake > account.cash) stake = account.cash;
  if (!(stake > 0)) return TRANS('NO_BALANCE');

  return PASS({ stake });
}

// Fill guards — run AFTER fetching the CLOB book and simulating the fill.
export function evaluateFillGuards(registry, fillResult) {
  if (!fillResult) return TRANS('NO_LIQUIDITY');
  const ok = checkSlippageTolerance(
    fillResult.slippageBps,
    fillResult.avgPrice,
    registry.slippageTolerance
  );
  if (!ok) return TRANS('SLIPPAGE_EXCEEDED');
  return PASS();
}
