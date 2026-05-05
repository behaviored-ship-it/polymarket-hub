import { fetchActivity, fetchOrderBook, fetchTokenIds, fetchOpenPositions, fetchGammaResolution } from './api.js';
import { simulateBuyFill } from './useFillSimulator.js';
import { evaluatePreFillGuards, evaluateFillGuards } from './evaluateGuards.js';
import { resolvePosition, AmbiguousResolutionError } from './resolvePosition.js';
import { registry as registryStore, accounts, trades, positions } from './usePaperDB.js';
import { log } from './eventLog.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function tsToETDateString(unixSec) {
  const d = new Date(new Date(unixSec * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function tsToETHour(unixSec) {
  return new Date(new Date(unixSec * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
}
const todayETString = () => tsToETDateString(Date.now() / 1000);

// Sums realized P&L for losing trades within a time window
async function lossStatsForRegistry(registryId) {
  const ts = await trades.forRegistry(registryId);
  const today = todayETString();
  const todayCutoff = Math.floor(new Date(today + 'T00:00:00-05:00').getTime() / 1000);
  const weekCutoff = todayCutoff - 7 * 24 * 3600;

  let todayCount = 0, todayLoss = 0, weekLoss = 0, lifetimeLoss = 0;
  for (const t of ts) {
    if (t.status === 'skipped') continue;
    if ((t.openedAt ?? 0) >= todayCutoff) todayCount++;
    if (t.result === 'loss') {
      const loss = Math.abs(t.pnl ?? 0);
      lifetimeLoss += loss;
      if ((t.resolvedAt ?? 0) >= weekCutoff) weekLoss += loss;
      if ((t.resolvedAt ?? 0) >= todayCutoff) todayLoss += loss;
    }
  }
  return { todayCount, todayLoss, weekLoss, lifetimeLoss };
}

// ── Skip recording ───────────────────────────────────────────────────────────
async function recordSkip(registry, leaderTrade, reason, isPermanent) {
  const id = `pt_${registry.id}_${leaderTrade.conditionId}_${leaderTrade.timestamp}_skip`;
  const trade = {
    id,
    registryId: registry.id,
    conditionId: leaderTrade.conditionId,
    tokenId: null,
    title: leaderTrade.title || '',
    category: leaderTrade.category || '',
    outcome: leaderTrade.outcome || '',
    entryPrice: null,
    stake: null,
    shares: null,
    fee: null,
    slippageBps: null,
    midpointAtFill: null,
    levelsFilled: null,
    isPartial: false,
    leaderStake: (leaderTrade.totalBought ?? 0) * (leaderTrade.avgPrice ?? 0),
    leaderPrice: leaderTrade.avgPrice ?? null,
    leaderTradeTs: leaderTrade.timestamp ?? null,
    openedAt: Math.floor(Date.now() / 1000),
    pollDelayMs: leaderTrade.timestamp ? Date.now() - leaderTrade.timestamp * 1000 : null,
    dateET: todayETString(),
    hourET: tsToETHour(Date.now() / 1000),
    status: 'skipped',
    skipReason: reason,
    isPermanentSkip: isPermanent,
    exitPrice: null,
    result: null,
    pnl: null,
    resolvedAt: null,
  };
  await trades.put(trade);
  log.skip(registry.id, leaderTrade, reason, isPermanent);
  return trade;
}

// ── Single-trade execution (called per new leader trade) ─────────────────────
export async function executeOnLeaderTrade(registry, leaderTrade) {
  try {
    const account = await accounts.get(registry.id);
    if (!account) {
      log.error(registry.id, 'no account row — paper trader not initialized');
      return;
    }
    const openPositions = await positions.openForRegistry(registry.id);
    const lossStats = await lossStatsForRegistry(registry.id);
    const leaderHadPriorPosition = openPositions.some((p) => p.conditionId === leaderTrade.conditionId);

    const ctx = {
      leaderTrade, registry, account, openPositions,
      todayCount: lossStats.todayCount,
      todayLossUsd: lossStats.todayLoss,
      weekLossUsd: lossStats.weekLoss,
      lifetimeLossUsd: lossStats.lifetimeLoss,
      leaderHadPriorPosition,
      eventId: leaderTrade.eventId,
    };

    const pre = evaluatePreFillGuards(ctx);
    if (pre.skip) return recordSkip(registry, leaderTrade, pre.reason, pre.isPermanent);

    const tokenInfo = await fetchTokenIds(leaderTrade.conditionId);
    const outcomeKey = String(leaderTrade.outcome ?? '').trim().toLowerCase();
    const tokenId = tokenInfo.tokens?.[outcomeKey] ?? null;
    if (!tokenId) {
      // Multi-outcome markets where Gamma returns no tokens, or leader's outcome
      // string doesn't match any token (e.g. abbreviation mismatch). Permanent —
      // re-fetching won't help and the cache prevents the spam loop.
      return recordSkip(registry, leaderTrade, 'TOKEN_NOT_FOUND', true);
    }

    let book;
    try {
      book = await fetchOrderBook(tokenId);
    } catch (err) {
      return recordSkip(registry, leaderTrade, 'BOOK_FETCH_FAILED', !err.transient);
    }

    const fill = simulateBuyFill(book.asks, book.bids, pre.stake);
    const fillCheck = evaluateFillGuards(registry, fill);
    if (fillCheck.skip) return recordSkip(registry, leaderTrade, fillCheck.reason, fillCheck.isPermanent);

    // Record successful fill
    const id = `pt_${registry.id}_${leaderTrade.conditionId}_${leaderTrade.timestamp}`;
    const tradeRow = {
      id,
      registryId: registry.id,
      conditionId: leaderTrade.conditionId,
      tokenId,
      title: leaderTrade.title || '',
      category: leaderTrade.category || '',
      outcome: leaderTrade.outcome || '',
      entryPrice: fill.avgPrice,
      stake: fill.totalCost,
      shares: fill.totalShares,
      fee: fill.fee,
      slippageBps: fill.slippageBps,
      midpointAtFill: fill.midpoint,
      levelsFilled: fill.levelsFilled,
      isPartial: fill.isPartial,
      leaderStake: (leaderTrade.totalBought ?? 0) * (leaderTrade.avgPrice ?? 0),
      leaderPrice: leaderTrade.avgPrice ?? null,
      leaderTradeTs: leaderTrade.timestamp ?? null,
      openedAt: Math.floor(Date.now() / 1000),
      pollDelayMs: leaderTrade.timestamp ? Date.now() - leaderTrade.timestamp * 1000 : null,
      dateET: todayETString(),
      hourET: tsToETHour(Date.now() / 1000),
      status: 'filled',
      skipReason: null,
      isPermanentSkip: false,
      exitPrice: null,
      result: null,
      pnl: null,
      resolvedAt: null,
    };
    await trades.put(tradeRow);

    // Upsert position (weighted-average entry on duplicate market+outcome)
    const posId = `${registry.id}_${leaderTrade.conditionId}_${String(leaderTrade.outcome).toLowerCase()}`;
    const existing = await positions.get(posId);
    const newShares = (existing?.shares ?? 0) + fill.totalShares;
    const newCost = (existing?.totalCost ?? 0) + fill.totalCost + fill.fee;
    const newAvg = newCost / newShares;
    await positions.put({
      id: posId,
      registryId: registry.id,
      conditionId: leaderTrade.conditionId,
      tokenId,
      title: leaderTrade.title || '',
      outcome: leaderTrade.outcome || '',
      shares: newShares,
      avgEntryPrice: newAvg,
      totalCost: newCost,
      realizedPnl: existing?.realizedPnl ?? 0,
      peakUnrealizedPct: existing?.peakUnrealizedPct ?? 0,
      isResolved: false,
      resolvedAt: null,
      resolvedPrice: null,
      resolutionSource: null,
      curPrice: null,
      lastPriceTs: null,
    });

    // Decrement cash
    const newCash = account.cash - fill.totalCost - fill.fee;
    const newPeak = Math.max(account.peakBalance ?? newCash, newCash);
    await accounts.put({ ...account, cash: newCash, peakBalance: newPeak });

    log.buy(registry.id, tradeRow);

    // Check auto-pause based on realized P&L (unaffected here, but cheap to check)
    await checkAndApplyAutoPause(registry);
  } catch (err) {
    log.error(registry.id, err.message || err);
  }
}

// ── Auto-pause ───────────────────────────────────────────────────────────────
export async function checkAndApplyAutoPause(registry) {
  const account = await accounts.get(registry.id);
  if (!account) return;
  const ap = registry.autoPause || {};
  const realizedPnl = account.cash - registry.startBalance;
  const pctOfStart = (realizedPnl / registry.startBalance) * 100;

  let trip = null;
  if (ap.lossUsd != null && realizedPnl <= -ap.lossUsd) trip = `loss_usd_${ap.lossUsd}`;
  else if (ap.lossPct != null && pctOfStart <= -ap.lossPct) trip = `loss_pct_${ap.lossPct}`;
  else if (ap.profitUsd != null && realizedPnl >= ap.profitUsd) trip = `profit_usd_${ap.profitUsd}`;
  else if (ap.profitPct != null && pctOfStart >= ap.profitPct) trip = `profit_pct_${ap.profitPct}`;

  if (trip && registry.status === 'active') {
    const updated = { ...registry, status: 'paused', pauseReason: trip };
    await registryStore.put(updated);
    log.pause(registry.id, trip);
    return updated;
  }
  return null;
}

// ── Polling cycle for one registry ───────────────────────────────────────────
export async function pollOnce(registry) {
  if (registry.status !== 'active') return;
  let fresh;
  try {
    fresh = await fetchActivity(registry.walletAddr, registry.lastPollTs ?? 0);
  } catch (err) {
    log.error(registry.id, `activity fetch failed: ${err.message}`);
    return;
  }
  // Filter to BUYs in tradeable markets only (MVP).
  // Activity feed includes non-trade events (rewards, splits, conversions) that
  // don't have a conditionId — those would spam Gamma with empty queries.
  const buys = fresh.filter(
    (t) =>
      t.conditionId &&
      t.outcome &&
      (!t.side || String(t.side).toUpperCase() === 'BUY')
  );
  for (const t of buys) {
    await executeOnLeaderTrade(registry, t);
  }
  if (fresh.length > 0) {
    const maxTs = Math.max(...fresh.map((t) => t.timestamp ?? 0));
    if (maxTs > (registry.lastPollTs ?? 0)) {
      await registryStore.put({ ...registry, lastPollTs: maxTs });
    }
  }
}

// ── Resolution sweep for one registry ────────────────────────────────────────
export async function resolveOpenForRegistry(registry) {
  const open = await positions.openForRegistry(registry.id);
  if (open.length === 0) return;
  let leaderOpen = null;
  try {
    leaderOpen = await fetchOpenPositions(registry.walletAddr);
  } catch (_) { /* fallback to Gamma per-position */ }

  for (const pos of open) {
    let gamma = null;
    let res = null;
    try {
      res = resolvePosition(pos, leaderOpen, null);
      if (!res.resolved) {
        gamma = await fetchGammaResolution(pos.conditionId);
        res = resolvePosition(pos, leaderOpen, gamma);
      }
    } catch (err) {
      if (err instanceof AmbiguousResolutionError) {
        log.error(registry.id, `ambiguous resolution for ${pos.conditionId}`);
        continue;
      }
      log.error(registry.id, `resolution check failed: ${err.message}`);
      continue;
    }
    if (!res.resolved) continue;

    // Mark position resolved + compute realized P&L
    const proceeds = pos.shares * res.price;
    const realized = proceeds - pos.totalCost;
    await positions.put({
      ...pos,
      isResolved: true,
      resolvedAt: Math.floor(Date.now() / 1000),
      resolvedPrice: res.price,
      resolutionSource: res.source,
      realizedPnl: (pos.realizedPnl ?? 0) + realized,
    });

    // Update related trade rows for this position to mark resolved with P&L
    const allTrades = await trades.forRegistry(registry.id);
    const related = allTrades.filter(
      (t) => t.conditionId === pos.conditionId && t.status === 'filled' && !t.resolvedAt
    );
    for (const t of related) {
      const tradeProceeds = t.shares * res.price;
      const tradePnl = tradeProceeds - t.stake - (t.fee ?? 0);
      await trades.put({
        ...t,
        status: 'resolved',
        exitPrice: res.price,
        result: res.price >= 0.99 ? 'win' : 'loss',
        pnl: tradePnl,
        resolvedAt: Math.floor(Date.now() / 1000),
      });
    }

    // Credit proceeds to cash
    const account = await accounts.get(registry.id);
    if (account) {
      const newCash = account.cash + proceeds;
      const newPeak = Math.max(account.peakBalance ?? newCash, newCash);
      await accounts.put({ ...account, cash: newCash, peakBalance: newPeak });
    }

    log.resolve(registry.id, { ...pos, realizedPnl: realized },
                res.price >= 0.99 ? 'win' : 'loss');

    // Auto-pause may trip after a loss
    await checkAndApplyAutoPause(registry);
  }
}
