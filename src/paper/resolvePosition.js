import { WIN_PRICE_THRESHOLD, LOSS_PRICE_THRESHOLD } from './constants.js';

export class AmbiguousResolutionError extends Error {
  constructor(conditionId) {
    super(`Multiple winning outcomes for ${conditionId}`);
    this.conditionId = conditionId;
    this.name = 'AmbiguousResolutionError';
  }
}

// Resolves a position using the layered strategy from spec §6.3.
//
// Inputs:
//   position           — PTPosition we're checking
//   openPositionsResp  — array from /api/positions for the LEADER wallet (or null)
//   gammaResp          — { outcomePrices, closed } from fetchGammaResolution (or null)
//
// Returns:
//   { resolved: true, price: 0.0|1.0, source: 'redeemable'|'outcomePrices' }
//   { resolved: false }
//
// Throws AmbiguousResolutionError if multiple Gamma outcomes show as winning.
export function resolvePosition(position, openPositionsResp, gammaResp) {
  // Primary: redeemable + curPrice from leader's open positions endpoint
  const open = Array.isArray(openPositionsResp)
    ? openPositionsResp.find(
        (p) =>
          p.conditionId === position.conditionId &&
          (!p.outcome || String(p.outcome).toLowerCase() === String(position.outcome).toLowerCase())
      )
    : null;

  if (open?.redeemable) {
    if (open.curPrice >= WIN_PRICE_THRESHOLD) {
      return { resolved: true, price: 1.0, source: 'redeemable' };
    }
    if (open.curPrice <= LOSS_PRICE_THRESHOLD) {
      return { resolved: true, price: 0.0, source: 'redeemable' };
    }
  }

  // Secondary: Gamma outcomePrices (use this NOT winningOutcome — it's unreliable)
  if (gammaResp?.outcomePrices?.length) {
    const prices = gammaResp.outcomePrices.map((p) => parseFloat(p));
    const winners = prices
      .map((p, i) => ({ p, i }))
      .filter((x) => x.p >= WIN_PRICE_THRESHOLD);
    if (winners.length > 1) throw new AmbiguousResolutionError(position.conditionId);
    if (winners.length === 1) {
      // Find OUR outcome's index in the market's outcomes array.
      // Binary markets: outcomes = ['Yes','No'] — our position.outcome is 'Yes' or 'No'.
      // Categorical: outcomes = ['T1','FULL SENSE',...] — match by string.
      // Falls back to binary index lookup if outcomes array is missing.
      const outcomes = Array.isArray(gammaResp.outcomes) ? gammaResp.outcomes : [];
      const ourOutcome = String(position.outcome ?? '').trim().toLowerCase();
      let ourIndex = outcomes.findIndex((o) => String(o).trim().toLowerCase() === ourOutcome);
      if (ourIndex === -1) {
        // No outcomes array OR no match — fall back to binary assumption.
        // Don't resolve if we can't be sure (silent return = retry next sweep).
        if (outcomes.length === 0) {
          ourIndex = ourOutcome === 'yes' ? 0 : ourOutcome === 'no' ? 1 : -1;
        }
      }
      if (ourIndex === -1) return { resolved: false };
      const won = winners[0].i === ourIndex;
      return { resolved: true, price: won ? 1.0 : 0.0, source: 'outcomePrices' };
    }
    if (prices.length > 0 && prices.every((p) => p === 0.5)) {
      return { resolved: false }; // explicitly not yet resolved
    }
  }

  return { resolved: false };
}
