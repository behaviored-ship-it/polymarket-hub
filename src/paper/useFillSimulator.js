import {
  FEE_RATE_BPS,
  FEE_MIN,
  SLIP_BOUNDARY_HIGH,
  SLIP_BOUNDARY_LOW,
} from './constants.js';

const toNum = (x) => (typeof x === 'string' ? parseFloat(x) : x);

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((l) => ({ price: toNum(l.price), size: toNum(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
}

export function computeFee(avgPrice, totalCost, feeRateBps = FEE_RATE_BPS) {
  if (!(totalCost > 0) || feeRateBps <= 0) return 0;
  const raw = (feeRateBps / 10_000) * Math.min(avgPrice, 1 - avgPrice) * totalCost;
  return Math.max(raw, FEE_MIN);
}

export function computeSlippageBps(avgPrice, midpoint) {
  if (!(midpoint > 0)) return 0;
  return ((avgPrice - midpoint) / midpoint) * 10_000;
}

// Walks ASK side from lowest price up. Returns null if no liquidity or FOK rejected.
// Match orderType: 'fak' (default, accepts partial) or 'fok' (reject if can't fill).
export function simulateBuyFill(asksRaw, bidsRaw, amountUsd, orderType = 'fak') {
  if (!(amountUsd > 0)) return null;

  const asks = normalizeLevels(asksRaw).sort((a, b) => a.price - b.price);
  const bids = normalizeLevels(bidsRaw).sort((a, b) => b.price - a.price);
  if (asks.length === 0) return null;

  let remaining = amountUsd;
  let totalShares = 0;
  let totalCost = 0;
  const fills = [];

  for (const lvl of asks) {
    if (remaining <= 0) break;
    const levelCost = lvl.size * lvl.price;
    if (levelCost <= remaining) {
      totalShares += lvl.size;
      totalCost += levelCost;
      remaining -= levelCost;
      fills.push({ price: lvl.price, size: lvl.size });
    } else {
      const partialShares = remaining / lvl.price;
      totalShares += partialShares;
      totalCost += remaining;
      fills.push({ price: lvl.price, size: partialShares });
      remaining = 0;
      break;
    }
  }

  if (fills.length === 0 || totalShares <= 0) return null;
  if (orderType === 'fok' && remaining > 0.01) return null;

  const avgPrice = totalCost / totalShares;
  const bestAsk = asks[0].price;
  const bestBid = bids[0]?.price ?? 0;
  const midpoint = bestBid > 0 ? (bestAsk + bestBid) / 2 : bestAsk;
  const slippageBps = computeSlippageBps(avgPrice, midpoint);
  const fee = computeFee(avgPrice, totalCost);

  return {
    avgPrice,
    totalShares,
    totalCost,
    fee,
    slippageBps,
    midpoint,
    levelsFilled: fills.length,
    isPartial: remaining > 0.01,
    fills,
  };
}

// Walks BID side from highest price down. Mirror of simulateBuyFill.
// Used for sell-side simulation (deferred to v1.1 in MVP, but kept symmetric).
export function simulateSellFill(asksRaw, bidsRaw, sharesToSell, orderType = 'fak') {
  if (!(sharesToSell > 0)) return null;

  const asks = normalizeLevels(asksRaw).sort((a, b) => a.price - b.price);
  const bids = normalizeLevels(bidsRaw).sort((a, b) => b.price - a.price);
  if (bids.length === 0) return null;

  let remainingShares = sharesToSell;
  let totalShares = 0;
  let totalProceeds = 0;
  const fills = [];

  for (const lvl of bids) {
    if (remainingShares <= 0) break;
    if (lvl.size <= remainingShares) {
      totalShares += lvl.size;
      totalProceeds += lvl.size * lvl.price;
      remainingShares -= lvl.size;
      fills.push({ price: lvl.price, size: lvl.size });
    } else {
      totalShares += remainingShares;
      totalProceeds += remainingShares * lvl.price;
      fills.push({ price: lvl.price, size: remainingShares });
      remainingShares = 0;
      break;
    }
  }

  if (fills.length === 0 || totalShares <= 0) return null;
  if (orderType === 'fok' && remainingShares > 0.0001) return null;

  const avgPrice = totalProceeds / totalShares;
  const bestBid = bids[0].price;
  const bestAsk = asks[0]?.price ?? 1;
  const midpoint = bestAsk < 1 ? (bestAsk + bestBid) / 2 : bestBid;
  // For sell, slippage is negative when avgPrice < midpoint (you got worse than mid)
  const slippageBps = computeSlippageBps(midpoint, avgPrice);
  const fee = computeFee(avgPrice, totalProceeds);

  return {
    avgPrice,
    totalShares,
    totalProceeds,
    fee,
    slippageBps,
    midpoint,
    levelsFilled: fills.length,
    isPartial: remainingShares > 0.0001,
    fills,
  };
}

// Returns true if slippage is within configured tolerance for the price tier.
// `slippageBps` from simulateBuyFill, `avgPrice` is the fill price (0..1).
// `tolerance` shape: { above40c, between18_40c, below18c } as percentages (e.g. 4 = 4%).
export function checkSlippageTolerance(slippageBps, avgPrice, tolerance) {
  const slipPct = slippageBps / 100; // bps → %
  let limit;
  if (avgPrice >= SLIP_BOUNDARY_HIGH) limit = tolerance.above40c;
  else if (avgPrice >= SLIP_BOUNDARY_LOW) limit = tolerance.between18_40c;
  else limit = tolerance.below18c;
  return slipPct <= limit;
}
