import { describe, it, expect } from 'vitest';
import {
  simulateBuyFill,
  simulateSellFill,
  checkSlippageTolerance,
  computeFee,
  computeSlippageBps,
} from '../useFillSimulator.js';
import { DEFAULT_SLIPPAGE_TOLERANCE, FEE_MIN } from '../constants.js';

describe('computeFee', () => {
  it('uses Polymarket formula: (bps/10000) * min(p, 1-p) * cost', () => {
    // bps=100, p=0.5, cost=$100 → 0.01 * 0.5 * 100 = 0.50
    expect(computeFee(0.5, 100)).toBeCloseTo(0.5, 6);
  });

  it('symmetric around 0.5 (uses min(p, 1-p))', () => {
    expect(computeFee(0.2, 100)).toBeCloseTo(computeFee(0.8, 100), 6);
  });

  it('enforces minimum fee of 0.0001 when result would be smaller', () => {
    // p=0.001, cost=$0.10 → 0.01 * 0.001 * 0.10 = 0.000001 → floored to FEE_MIN
    expect(computeFee(0.001, 0.10)).toBe(FEE_MIN);
  });

  it('returns 0 when feeRateBps=0', () => {
    expect(computeFee(0.5, 100, 0)).toBe(0);
  });

  it('returns 0 for non-positive cost', () => {
    expect(computeFee(0.5, 0)).toBe(0);
    expect(computeFee(0.5, -1)).toBe(0);
  });
});

describe('computeSlippageBps', () => {
  it('returns 0 when avgPrice equals midpoint', () => {
    expect(computeSlippageBps(0.5, 0.5)).toBe(0);
  });

  it('returns positive bps when avgPrice > midpoint (paid more than mid)', () => {
    // (0.51 - 0.5) / 0.5 * 10000 = 200 bps
    expect(computeSlippageBps(0.51, 0.5)).toBeCloseTo(200, 6);
  });

  it('returns 0 when midpoint is 0 or undefined', () => {
    expect(computeSlippageBps(0.5, 0)).toBe(0);
  });
});

describe('simulateBuyFill', () => {
  it('returns null when book is empty', () => {
    expect(simulateBuyFill([], [], 100)).toBeNull();
  });

  it('returns null when amount is 0 or negative', () => {
    expect(simulateBuyFill([{ price: '0.5', size: '100' }], [], 0)).toBeNull();
    expect(simulateBuyFill([{ price: '0.5', size: '100' }], [], -10)).toBeNull();
  });

  it('handles string price/size from CLOB API', () => {
    const r = simulateBuyFill(
      [{ price: '0.50', size: '100' }],
      [{ price: '0.49', size: '100' }],
      10
    );
    expect(r).not.toBeNull();
    expect(r.avgPrice).toBe(0.5);
    expect(r.totalShares).toBe(20);
  });

  it('fills entire single level when liquidity exceeds amount', () => {
    const r = simulateBuyFill(
      [{ price: 0.5, size: 100 }],
      [{ price: 0.49, size: 100 }],
      25
    );
    expect(r.totalCost).toBe(25);
    expect(r.totalShares).toBe(50);
    expect(r.avgPrice).toBe(0.5);
    expect(r.levelsFilled).toBe(1);
    expect(r.isPartial).toBe(false);
  });

  it('walks multiple levels with weighted-average price', () => {
    // $50 at 0.50 (100 shares) + $20 at 0.55 (~36.36 shares) = 136.36 shares for $70
    // avgPrice ≈ 70 / 136.36 ≈ 0.5133
    const r = simulateBuyFill(
      [
        { price: 0.5, size: 100 },
        { price: 0.55, size: 100 },
      ],
      [{ price: 0.49, size: 100 }],
      70
    );
    expect(r.totalCost).toBeCloseTo(70, 6);
    expect(r.totalShares).toBeCloseTo(100 + 20 / 0.55, 4);
    expect(r.avgPrice).toBeCloseTo(70 / (100 + 20 / 0.55), 4);
    expect(r.levelsFilled).toBe(2);
  });

  it('sorts asks ascending even if input is unsorted', () => {
    const r = simulateBuyFill(
      [
        { price: 0.55, size: 100 },
        { price: 0.50, size: 100 },
      ],
      [{ price: 0.49, size: 100 }],
      10
    );
    expect(r.avgPrice).toBe(0.5);
  });

  it('FOK rejects when full amount cannot fill', () => {
    // Only 50 shares × $0.50 = $25 available, but asking for $100
    const r = simulateBuyFill(
      [{ price: 0.5, size: 50 }],
      [{ price: 0.49, size: 100 }],
      100,
      'fok'
    );
    expect(r).toBeNull();
  });

  it('FAK accepts partial fill when liquidity insufficient', () => {
    const r = simulateBuyFill(
      [{ price: 0.5, size: 50 }],
      [{ price: 0.49, size: 100 }],
      100,
      'fak'
    );
    expect(r).not.toBeNull();
    expect(r.totalCost).toBe(25);
    expect(r.totalShares).toBe(50);
    expect(r.isPartial).toBe(true);
  });

  it('computes slippage vs midpoint correctly', () => {
    // bestAsk=0.50, bestBid=0.48, mid=0.49, fill=0.50 → +200bps approx (1/49 ≈ 204)
    const r = simulateBuyFill(
      [{ price: 0.5, size: 100 }],
      [{ price: 0.48, size: 100 }],
      10
    );
    expect(r.midpoint).toBe(0.49);
    expect(r.slippageBps).toBeCloseTo((0.5 - 0.49) / 0.49 * 10_000, 4);
  });

  it('falls back to bestAsk when bid side is empty', () => {
    const r = simulateBuyFill([{ price: 0.5, size: 100 }], [], 10);
    expect(r.midpoint).toBe(0.5);
    expect(r.slippageBps).toBe(0);
  });

  it('skips zero-size levels', () => {
    const r = simulateBuyFill(
      [
        { price: 0.5, size: 0 },
        { price: 0.55, size: 100 },
      ],
      [{ price: 0.49, size: 100 }],
      10
    );
    expect(r.avgPrice).toBe(0.55);
  });
});

describe('simulateSellFill', () => {
  it('returns null when bid side is empty', () => {
    expect(simulateSellFill([{ price: 0.5, size: 100 }], [], 10)).toBeNull();
  });

  it('walks bids descending and computes weighted avg', () => {
    // 50 shares @ 0.50 + 50 shares @ 0.45 = $47.50 for 100 shares → avg 0.475
    const r = simulateSellFill(
      [{ price: 0.55, size: 100 }],
      [
        { price: 0.5, size: 50 },
        { price: 0.45, size: 100 },
      ],
      100
    );
    expect(r.totalShares).toBe(100);
    expect(r.totalProceeds).toBeCloseTo(47.5, 6);
    expect(r.avgPrice).toBeCloseTo(0.475, 6);
  });

  it('FOK rejects when shares cannot fully sell', () => {
    expect(
      simulateSellFill(
        [{ price: 0.55, size: 100 }],
        [{ price: 0.5, size: 10 }],
        100,
        'fok'
      )
    ).toBeNull();
  });
});

describe('checkSlippageTolerance', () => {
  const tol = DEFAULT_SLIPPAGE_TOLERANCE; // 4 / 10 / 25

  it('uses above40c tier when price >= 0.40', () => {
    expect(checkSlippageTolerance(300, 0.5, tol)).toBe(true); // 3% < 4%
    expect(checkSlippageTolerance(500, 0.5, tol)).toBe(false); // 5% > 4%
  });

  it('uses between18_40c tier when 0.18 <= price < 0.40', () => {
    expect(checkSlippageTolerance(800, 0.25, tol)).toBe(true); // 8% < 10%
    expect(checkSlippageTolerance(1100, 0.25, tol)).toBe(false); // 11% > 10%
  });

  it('uses below18c tier when price < 0.18', () => {
    expect(checkSlippageTolerance(2000, 0.10, tol)).toBe(true); // 20% < 25%
    expect(checkSlippageTolerance(3000, 0.10, tol)).toBe(false); // 30% > 25%
  });

  it('exact 0.40 boundary uses above40c tier', () => {
    expect(checkSlippageTolerance(400, 0.40, tol)).toBe(true); // 4% == 4%
    expect(checkSlippageTolerance(401, 0.40, tol)).toBe(false);
  });

  it('exact 0.18 boundary uses between18_40c tier (not below)', () => {
    // At 18c: between18_40c tier, 10% allowed
    expect(checkSlippageTolerance(1000, 0.18, tol)).toBe(true);
    expect(checkSlippageTolerance(1001, 0.18, tol)).toBe(false);
    // At 17.99c: below18c tier, 25% allowed
    expect(checkSlippageTolerance(2400, 0.1799, tol)).toBe(true);
  });
});
