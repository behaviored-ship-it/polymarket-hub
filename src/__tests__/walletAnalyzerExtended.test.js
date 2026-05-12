import { describe, it, expect } from 'vitest';
import {
  buyPriceDistribution,
  maxDrawdown,
  buyVsSellSplit,
  holdTimeStats,
  computeExtendedMetrics,
} from '../wallet-analyzer.jsx';

// ─── buyPriceDistribution ───────────────────────────────────────────────────

describe('buyPriceDistribution', () => {
  it('returns null on empty input', () => {
    expect(buyPriceDistribution([])).toBe(null);
    expect(buyPriceDistribution(null)).toBe(null);
  });

  it('ignores trades with zero/missing price', () => {
    const trades = [
      { avgPrice: 0 },
      { avgPrice: null },
      { avgPrice: 0.50 },
    ];
    const r = buyPriceDistribution(trades);
    expect(r.n).toBe(1);
    expect(r.min).toBe(0.50);
    expect(r.max).toBe(0.50);
  });

  it('computes P10/P50/P90 with linear interpolation', () => {
    // 11 evenly-spaced prices [0.00, 0.10, ..., 1.00] — indices 0..10, so
    // P10 = idx 1.0 = 0.10, P50 = idx 5.0 = 0.50, P90 = idx 9.0 = 0.90
    const trades = Array.from({ length: 11 }, (_, i) => ({ avgPrice: i / 10 }));
    // Drop the 0.00 — filtered out — so we have 10 values [0.1..1.0]
    const valid = trades.filter(t => t.avgPrice > 0);
    const r = buyPriceDistribution(valid);
    expect(r.n).toBe(10);
    expect(r.min).toBeCloseTo(0.10, 6);
    expect(r.max).toBeCloseTo(1.00, 6);
    // 10 sorted values [0.1, 0.2, ..., 1.0], indices 0..9
    // P10 = idx 0.9, between [0.1] and [0.2] → 0.1 + 0.9*0.1 = 0.19
    expect(r.p10).toBeCloseTo(0.19, 6);
    // P50 = idx 4.5, between [0.5] and [0.6] → 0.55
    expect(r.p50).toBeCloseTo(0.55, 6);
    // P90 = idx 8.1, between [0.9] and [1.0] → 0.91
    expect(r.p90).toBeCloseTo(0.91, 6);
  });

  it('exposes a spread trader: tight P10..P90 band lies, wide band tells the truth', () => {
    // Lebandito-like: most trades cluster at extremes (longshots + near-certain)
    const spread = [
      ...Array.from({ length: 5 }, () => ({ avgPrice: 0.01 })),
      ...Array.from({ length: 5 }, () => ({ avgPrice: 0.99 })),
    ];
    const r = buyPriceDistribution(spread);
    // Mean would be ~0.50 and hide the bimodal nature.
    // P10 should sit near the low cluster, P90 near the high cluster.
    expect(r.p10).toBeLessThan(0.50);
    expect(r.p90).toBeGreaterThan(0.50);
    expect(r.p90 - r.p10).toBeGreaterThan(0.50); // wide spread visible
  });
});

// ─── maxDrawdown ─────────────────────────────────────────────────────────────

describe('maxDrawdown', () => {
  it('returns null on empty input', () => {
    expect(maxDrawdown([])).toBe(null);
    expect(maxDrawdown(null)).toBe(null);
  });

  it('measures peak-to-trough on cumulative PnL', () => {
    // PnL series: +100, +50, -200, +30, -10
    // Cum:        100, 150,  -50,  -20, -30
    // Peak at 150; trough at -50; max DD = 200, peak-relative = 200/150 = 133.3%
    const trades = [
      { timestamp: 1, realizedPnl: 100, result: 'win'  },
      { timestamp: 2, realizedPnl:  50, result: 'win'  },
      { timestamp: 3, realizedPnl:-200, result: 'loss' },
      { timestamp: 4, realizedPnl:  30, result: 'win'  },
      { timestamp: 5, realizedPnl: -10, result: 'loss' },
    ];
    const r = maxDrawdown(trades);
    expect(r.maxDrawdownUsd).toBeCloseTo(200, 6);
    expect(r.maxDrawdownPct).toBeCloseTo((200 / 150) * 100, 4);
  });

  it('handles monotonic-up curve as zero drawdown', () => {
    const trades = [
      { timestamp: 1, realizedPnl:  50 },
      { timestamp: 2, realizedPnl:  50 },
      { timestamp: 3, realizedPnl: 100 },
    ];
    const r = maxDrawdown(trades);
    expect(r.maxDrawdownUsd).toBe(0);
    expect(r.maxDrawdownPct).toBe(0);
  });

  it('orders trades by timestamp before computing', () => {
    // Same PnL events, scrambled order — result must match the time-ordered run
    const scrambled = [
      { timestamp: 3, realizedPnl:-200 },
      { timestamp: 5, realizedPnl: -10 },
      { timestamp: 1, realizedPnl: 100 },
      { timestamp: 4, realizedPnl:  30 },
      { timestamp: 2, realizedPnl:  50 },
    ];
    const r = maxDrawdown(scrambled);
    expect(r.maxDrawdownUsd).toBeCloseTo(200, 6);
  });

  it('handles all-losses (peak stays at 0, %-of-peak undefined ⇒ 0)', () => {
    const trades = [
      { timestamp: 1, realizedPnl: -50 },
      { timestamp: 2, realizedPnl: -25 },
    ];
    const r = maxDrawdown(trades);
    expect(r.maxDrawdownUsd).toBeCloseTo(75, 6);
    // Peak never went positive, so % of peak isn't a meaningful number — we
    // surface 0 rather than NaN/Infinity. The $ figure is the truth here.
    expect(r.maxDrawdownPct).toBe(0);
  });
});

// ─── buyVsSellSplit ─────────────────────────────────────────────────────────

describe('buyVsSellSplit', () => {
  it('returns null on empty input', () => {
    expect(buyVsSellSplit(null)).toBe(null);
    expect(buyVsSellSplit([])).toBe(null);
  });

  it('USD-weights the average across fills', () => {
    // Two buys: 100 shares @ $0.50 ($50) and 900 shares @ $0.90 ($810).
    // Simple-mean of prices = 0.70. USD-weighted = (0.5*50 + 0.9*810)/860 ≈ 0.877.
    const activity = [
      { side: 'BUY', avgPrice: 0.50, totalBought: 100 },
      { side: 'BUY', avgPrice: 0.90, totalBought: 900 },
    ];
    const r = buyVsSellSplit(activity);
    expect(r.avgBuyPrice).toBeCloseTo((0.5*50 + 0.9*810) / 860, 4);
    expect(r.avgSellPrice).toBe(null);
    expect(r.buyCount).toBe(2);
    expect(r.sellCount).toBe(0);
  });

  it('splits buys from sells', () => {
    const activity = [
      { side: 'BUY',  avgPrice: 0.60, totalBought: 100 }, // $60
      { side: 'SELL', avgPrice: 0.80, totalBought: 100 }, // $80
      { side: 'SELL', avgPrice: 0.85, totalBought: 200 }, // $170
    ];
    const r = buyVsSellSplit(activity);
    expect(r.avgBuyPrice).toBeCloseTo(0.60, 6);
    expect(r.avgSellPrice).toBeCloseTo((0.8*80 + 0.85*170) / 250, 4);
    expect(r.buyVolumeUsd).toBeCloseTo(60, 4);
    expect(r.sellVolumeUsd).toBeCloseTo(250, 4);
  });

  it('skips fills with missing price or shares', () => {
    const activity = [
      { side: 'BUY', avgPrice: 0, totalBought: 100 },
      { side: 'BUY', avgPrice: 0.50, totalBought: 0 },
      { side: 'BUY', avgPrice: 0.70, totalBought: 200 },
    ];
    const r = buyVsSellSplit(activity);
    expect(r.buyCount).toBe(1);
    expect(r.avgBuyPrice).toBeCloseTo(0.70, 6);
  });
});

// ─── holdTimeStats ──────────────────────────────────────────────────────────

describe('holdTimeStats', () => {
  it('returns zero pairs on empty / no matches', () => {
    expect(holdTimeStats([]).pairCount).toBe(0);
    expect(holdTimeStats(null).pairCount).toBe(0);

    // BUY with no matching SELL — no pair
    const onlyBuys = [{ side: 'BUY', conditionId: 'A', outcome: 'yes', avgPrice: 0.5, totalBought: 100, timestamp: 1000 }];
    expect(holdTimeStats(onlyBuys).pairCount).toBe(0);
  });

  it('pairs one BUY with one SELL inside the same (conditionId, outcome)', () => {
    // BUY at t=0h, SELL at t=2h → hold = 2h
    const activity = [
      { side: 'BUY',  conditionId: 'A', outcome: 'yes', avgPrice: 0.5, totalBought: 100, timestamp: 0 },
      { side: 'SELL', conditionId: 'A', outcome: 'yes', avgPrice: 0.7, totalBought: 100, timestamp: 7200 },
    ];
    const r = holdTimeStats(activity);
    expect(r.pairCount).toBe(1);
    expect(r.meanHoldHours).toBeCloseTo(2, 6);
    expect(r.medianHoldHours).toBeCloseTo(2, 6);
    expect(r.usdWeightedMeanHoldHours).toBeCloseTo(2, 6);
  });

  it('FIFO-pairs across multiple BUYs and SELLs', () => {
    // BUY 100 @ t=0, BUY 100 @ t=3600 (1h), SELL 150 @ t=7200 (2h)
    // FIFO: 100 from first BUY (hold=2h, $50), 50 from second BUY (hold=1h, $25)
    const activity = [
      { side: 'BUY',  conditionId: 'A', outcome: 'yes', avgPrice: 0.5, totalBought: 100, timestamp: 0 },
      { side: 'BUY',  conditionId: 'A', outcome: 'yes', avgPrice: 0.5, totalBought: 100, timestamp: 3600 },
      { side: 'SELL', conditionId: 'A', outcome: 'yes', avgPrice: 0.7, totalBought: 150, timestamp: 7200 },
    ];
    const r = holdTimeStats(activity);
    expect(r.pairCount).toBe(2);
    // Plain mean of [2h, 1h] = 1.5h
    expect(r.meanHoldHours).toBeCloseTo(1.5, 6);
    // USD-weighted: pair1 = 2h, $50; pair2 = 1h, $25 → (2*50 + 1*25)/75 = 5/3 ≈ 1.667h
    expect(r.usdWeightedMeanHoldHours).toBeCloseTo(5 / 3, 4);
  });

  it('does not pair across different outcomes (Up vs Down) of the same market', () => {
    const activity = [
      { side: 'BUY',  conditionId: 'M', outcome: 'up',   avgPrice: 0.5, totalBought: 100, timestamp: 0    },
      { side: 'SELL', conditionId: 'M', outcome: 'down', avgPrice: 0.5, totalBought: 100, timestamp: 3600 },
    ];
    const r = holdTimeStats(activity);
    expect(r.pairCount).toBe(0);
  });

  it('flags scalpers: tiny median hold time', () => {
    // 5 buys, 5 sells, all under a minute — Lebandito-like
    const activity = [];
    for (let i = 0; i < 5; i++) {
      const cid = `mkt${i}`;
      activity.push({ side: 'BUY',  conditionId: cid, outcome: 'yes', avgPrice: 0.5, totalBought: 100, timestamp: i * 100 });
      activity.push({ side: 'SELL', conditionId: cid, outcome: 'yes', avgPrice: 0.7, totalBought: 100, timestamp: i * 100 + 30 });
    }
    const r = holdTimeStats(activity);
    expect(r.pairCount).toBe(5);
    expect(r.medianHoldHours).toBeLessThan(0.02); // < 1.2 min
  });
});

// ─── computeExtendedMetrics (wrapper) ───────────────────────────────────────

describe('computeExtendedMetrics', () => {
  it('runs all four formulas and returns them in one object', () => {
    const trades = [
      { avgPrice: 0.5, timestamp: 1, realizedPnl: 100, result: 'win'  },
      { avgPrice: 0.6, timestamp: 2, realizedPnl: -50, result: 'loss' },
    ];
    const activity = [
      { side: 'BUY',  conditionId: 'A', outcome: 'yes', avgPrice: 0.5, totalBought: 100, timestamp: 0    },
      { side: 'SELL', conditionId: 'A', outcome: 'yes', avgPrice: 0.7, totalBought: 100, timestamp: 3600 },
    ];
    const r = computeExtendedMetrics({ trades, activity });
    expect(r.buyDistribution.n).toBe(2);
    expect(r.drawdown.maxDrawdownUsd).toBeCloseTo(50, 6);
    expect(r.buySellSplit.avgBuyPrice).toBeCloseTo(0.5, 6);
    expect(r.holdTime.pairCount).toBe(1);
  });

  it('tolerates missing data shapes', () => {
    const r1 = computeExtendedMetrics({ trades: [], activity: [] });
    expect(r1.buyDistribution).toBe(null);
    expect(r1.drawdown).toBe(null);
    expect(r1.buySellSplit).toBe(null);
    expect(r1.holdTime.pairCount).toBe(0);

    const r2 = computeExtendedMetrics({});
    expect(r2.buyDistribution).toBe(null);
  });
});
