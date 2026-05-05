import { describe, it, expect } from 'vitest';
import {
  evaluatePreFillGuards,
  evaluateFillGuards,
  computeRawStake,
} from '../evaluateGuards.js';
import { DEFAULT_SLIPPAGE_TOLERANCE } from '../constants.js';

const baseRegistry = {
  id: 'r1',
  walletAddr: '0xabc',
  status: 'active',
  copyMode: 'buys_only',
  newMarketsOnly: false,
  sizingMode: 'fixed',
  fixedAmt: 10,
  pctAmt: 50,
  safetyCap: null,
  maxTradesDay: null,
  minTradeSize: null,
  maxTradeSize: null,
  minPrice: null,
  maxPrice: null,
  blockedCategories: [],
  blockedMarkets: [],
  perQuestionCap: null,
  perEventCap: null,
  maxEventsOpen: null,
  totalBudget: null,
  dailyLossLimit: null,
  weeklyLossLimit: null,
  lifetimeLossLimit: null,
  slippageTolerance: DEFAULT_SLIPPAGE_TOLERANCE,
  startBalance: 100,
};

const baseAccount = { cash: 100 };

const baseTrade = {
  conditionId: 'cond-1',
  outcome: 'YES',
  avgPrice: 0.5,
  totalBought: 100,
  side: 'BUY',
  category: 'sports',
  timestamp: 1700000000,
  title: 'Will X win?',
};

const baseCtx = {
  leaderTrade: baseTrade,
  registry: baseRegistry,
  account: baseAccount,
  openPositions: [],
  todayCount: 0,
  todayLossUsd: 0,
  weekLossUsd: 0,
  lifetimeLossUsd: 0,
  leaderHadPriorPosition: false,
  eventId: null,
};

describe('computeRawStake', () => {
  it('fixed mode returns fixedAmt', () => {
    expect(computeRawStake(baseRegistry, baseTrade)).toBe(10);
  });
  it('percentage mode = leader $ * pct/100', () => {
    expect(computeRawStake({ ...baseRegistry, sizingMode: 'percentage', pctAmt: 25 }, baseTrade))
      .toBe(100 * 0.5 * 0.25);
  });
  it('portfolio mode falls back to fixed in MVP', () => {
    expect(computeRawStake({ ...baseRegistry, sizingMode: 'portfolio' }, baseTrade)).toBe(10);
  });
});

describe('evaluatePreFillGuards — pass case', () => {
  it('returns skip:false with computed stake when nothing fails', () => {
    const r = evaluatePreFillGuards(baseCtx);
    expect(r.skip).toBe(false);
    expect(r.stake).toBe(10);
  });
});

describe('status guards', () => {
  it('TRADER_PAUSED is transient', () => {
    const r = evaluatePreFillGuards({ ...baseCtx, registry: { ...baseRegistry, status: 'paused' } });
    expect(r).toMatchObject({ skip: true, reason: 'TRADER_PAUSED', isPermanent: false });
  });
  it('TRADER_STOPPED is permanent', () => {
    const r = evaluatePreFillGuards({ ...baseCtx, registry: { ...baseRegistry, status: 'stopped' } });
    expect(r).toMatchObject({ skip: true, reason: 'TRADER_STOPPED', isPermanent: true });
  });
  it('NO_BALANCE when cash <= 0', () => {
    const r = evaluatePreFillGuards({ ...baseCtx, account: { cash: 0 } });
    expect(r.reason).toBe('NO_BALANCE');
  });
});

describe('side filter', () => {
  it('SELL_FILTERED in buys_only mode when side=SELL', () => {
    const r = evaluatePreFillGuards({ ...baseCtx, leaderTrade: { ...baseTrade, side: 'SELL' } });
    expect(r).toMatchObject({ skip: true, reason: 'SELL_FILTERED', isPermanent: true });
  });
  it('passes when side missing (treat as buy)', () => {
    const r = evaluatePreFillGuards({ ...baseCtx, leaderTrade: { ...baseTrade, side: undefined } });
    expect(r.skip).toBe(false);
  });
});

describe('position dedup', () => {
  it('POSITION_EXISTS when same condition+outcome already open', () => {
    const open = [{ conditionId: 'cond-1', outcome: 'yes', totalCost: 5 }];
    const r = evaluatePreFillGuards({ ...baseCtx, openPositions: open });
    expect(r.reason).toBe('POSITION_EXISTS');
  });
  it('does not match different outcome on same condition', () => {
    const open = [{ conditionId: 'cond-1', outcome: 'no', totalCost: 5 }];
    const r = evaluatePreFillGuards({ ...baseCtx, openPositions: open });
    expect(r.skip).toBe(false);
  });
});

describe('newMarketsOnly', () => {
  it('NOT_NEW_MARKET when leader had prior position and flag set', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, newMarketsOnly: true },
      leaderHadPriorPosition: true,
    });
    expect(r.reason).toBe('NOT_NEW_MARKET');
  });
});

describe('size and price filters', () => {
  it('TRADE_TOO_SMALL', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, minTradeSize: 100 }, // leader $ = 50
    });
    expect(r.reason).toBe('TRADE_TOO_SMALL');
  });
  it('TRADE_TOO_LARGE', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, maxTradeSize: 10 },
    });
    expect(r.reason).toBe('TRADE_TOO_LARGE');
  });
  it('PRICE_TOO_LOW', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, minPrice: 0.6 },
    });
    expect(r.reason).toBe('PRICE_TOO_LOW');
  });
  it('PRICE_TOO_HIGH', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, maxPrice: 0.4 },
    });
    expect(r.reason).toBe('PRICE_TOO_HIGH');
  });
});

describe('blocklist', () => {
  it('BLOCKED_CATEGORY', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, blockedCategories: ['sports'] },
    });
    expect(r.reason).toBe('BLOCKED_CATEGORY');
  });
  it('BLOCKED_MARKET', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, blockedMarkets: ['cond-1'] },
    });
    expect(r.reason).toBe('BLOCKED_MARKET');
  });
});

describe('limits', () => {
  it('DAILY_LIMIT is transient', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, maxTradesDay: 5 },
      todayCount: 5,
    });
    expect(r).toMatchObject({ reason: 'DAILY_LIMIT', isPermanent: false });
  });
  it('LIFETIME_LOSS is permanent', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, lifetimeLossLimit: 50 },
      lifetimeLossUsd: 50,
    });
    expect(r).toMatchObject({ reason: 'LIFETIME_LOSS', isPermanent: true });
  });
  it('BUDGET_CAP fires when totalCost reached', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, totalBudget: 50 },
      openPositions: [{ totalCost: 50, conditionId: 'x', outcome: 'yes' }],
    });
    expect(r.reason).toBe('BUDGET_CAP');
  });
  it('QUESTION_CAP fires per conditionId', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, perQuestionCap: 5 },
      openPositions: [{ totalCost: 10, conditionId: 'cond-1', outcome: 'no' }],
    });
    expect(r.reason).toBe('QUESTION_CAP');
  });
});

describe('safety cap', () => {
  it('SAFETY_CAP fires when stake > cap', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      registry: { ...baseRegistry, fixedAmt: 50, safetyCap: 25 },
    });
    expect(r).toMatchObject({ reason: 'SAFETY_CAP', isPermanent: true });
  });
});

describe('cash trim', () => {
  it('caps stake to available cash without skipping', () => {
    const r = evaluatePreFillGuards({
      ...baseCtx,
      account: { cash: 3 }, // less than fixedAmt = 10
      registry: { ...baseRegistry, fixedAmt: 10 },
    });
    expect(r.skip).toBe(false);
    expect(r.stake).toBe(3);
  });
});

describe('evaluateFillGuards', () => {
  it('NO_LIQUIDITY when fillResult is null', () => {
    expect(evaluateFillGuards(baseRegistry, null))
      .toMatchObject({ skip: true, reason: 'NO_LIQUIDITY', isPermanent: false });
  });
  it('SLIPPAGE_EXCEEDED when slippage above tier', () => {
    // 0.5 price → above40c tier → 4% allowed → 500 bps = 5% > 4%
    const r = evaluateFillGuards(baseRegistry, { avgPrice: 0.5, slippageBps: 500 });
    expect(r.reason).toBe('SLIPPAGE_EXCEEDED');
  });
  it('passes when within tolerance', () => {
    const r = evaluateFillGuards(baseRegistry, { avgPrice: 0.5, slippageBps: 200 });
    expect(r.skip).toBe(false);
  });
});
