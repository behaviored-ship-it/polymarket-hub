import { describe, it, expect } from 'vitest';
import { resolvePosition, AmbiguousResolutionError } from '../resolvePosition.js';

const yesPos = { conditionId: 'c1', outcome: 'YES' };
const noPos = { conditionId: 'c1', outcome: 'NO' };

describe('resolvePosition — primary (redeemable)', () => {
  it('redeemable + curPrice >= 0.99 → win', () => {
    const r = resolvePosition(yesPos, [{ conditionId: 'c1', outcome: 'yes', redeemable: true, curPrice: 0.995 }], null);
    expect(r).toEqual({ resolved: true, price: 1.0, source: 'redeemable' });
  });

  it('redeemable + curPrice <= 0.01 → loss', () => {
    const r = resolvePosition(yesPos, [{ conditionId: 'c1', outcome: 'yes', redeemable: true, curPrice: 0.005 }], null);
    expect(r).toEqual({ resolved: true, price: 0.0, source: 'redeemable' });
  });

  it('redeemable but middle curPrice → not yet resolved', () => {
    const r = resolvePosition(yesPos, [{ conditionId: 'c1', outcome: 'yes', redeemable: true, curPrice: 0.6 }], null);
    expect(r.resolved).toBe(false);
  });

  it('not redeemable → not resolved via primary', () => {
    const r = resolvePosition(yesPos, [{ conditionId: 'c1', outcome: 'yes', redeemable: false, curPrice: 0.99 }], null);
    expect(r.resolved).toBe(false);
  });

  it('matches by conditionId + outcome (case-insensitive)', () => {
    const r = resolvePosition(yesPos, [{ conditionId: 'c1', outcome: 'Yes', redeemable: true, curPrice: 1 }], null);
    expect(r.resolved).toBe(true);
  });
});

describe('resolvePosition — secondary (Gamma outcomePrices)', () => {
  it('YES wins when outcomePrices=[1,0] and our outcome=YES', () => {
    const r = resolvePosition(yesPos, null, { outcomePrices: ['1', '0'] });
    expect(r).toEqual({ resolved: true, price: 1.0, source: 'outcomePrices' });
  });

  it('YES loses when outcomePrices=[0,1] and our outcome=YES', () => {
    const r = resolvePosition(yesPos, null, { outcomePrices: ['0', '1'] });
    expect(r).toEqual({ resolved: true, price: 0.0, source: 'outcomePrices' });
  });

  it('NO wins when outcomePrices=[0,1] and our outcome=NO', () => {
    const r = resolvePosition(noPos, null, { outcomePrices: ['0', '1'] });
    expect(r).toEqual({ resolved: true, price: 1.0, source: 'outcomePrices' });
  });

  it('not yet resolved when both outcomes = 0.5', () => {
    const r = resolvePosition(yesPos, null, { outcomePrices: ['0.5', '0.5'] });
    expect(r.resolved).toBe(false);
  });

  it('throws AmbiguousResolutionError when multiple winners', () => {
    expect(() =>
      resolvePosition(yesPos, null, { outcomePrices: ['1', '1'] })
    ).toThrow(AmbiguousResolutionError);
  });

  it('handles parsed-number outcomePrices', () => {
    const r = resolvePosition(yesPos, null, { outcomePrices: [1, 0] });
    expect(r.resolved).toBe(true);
  });
});

describe('layered behavior', () => {
  it('falls back to gamma when redeemable response missing the position', () => {
    const r = resolvePosition(yesPos, [{ conditionId: 'c2', redeemable: true, curPrice: 1 }],
      { outcomePrices: ['0', '1'] });
    expect(r.source).toBe('outcomePrices');
    expect(r.price).toBe(0.0);
  });

  it('returns not resolved when neither source resolves', () => {
    expect(resolvePosition(yesPos, [], { outcomePrices: ['0.4', '0.6'] }).resolved).toBe(false);
    expect(resolvePosition(yesPos, null, null).resolved).toBe(false);
  });
});
