import { DEFAULT_SLIPPAGE_TOLERANCE } from './constants.js';

// Returns a complete PTRegistry with all fields defaulted. Required so the
// registry doc shape is stable across UI edits — fields the user hasn't seen
// yet still need to exist (null) for guards to short-circuit cleanly.
export function defaultRegistry({ walletAddr, nickname, startBalance, sizingMode, fixedAmt, pctAmt }) {
  return {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `reg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    walletAddr: walletAddr.toLowerCase(),
    nickname: (nickname || '').trim(),
    startBalance: Number(startBalance) || 100,

    sizingMode: sizingMode || 'fixed',
    fixedAmt: Number(fixedAmt) || 10,
    pctAmt: Number(pctAmt) || 50,
    multiplier: 1,

    copyMode: 'buys_only',     // MVP locked
    newMarketsOnly: false,
    safetyCap: null,
    maxTradesDay: null,

    minTradeSize: null,
    maxTradeSize: null,
    minPrice: null,
    maxPrice: null,

    perQuestionCap: null,
    perEventCap: null,
    maxEventsOpen: null,
    totalBudget: null,
    dailyLossLimit: null,
    weeklyLossLimit: null,
    lifetimeLossLimit: null,

    perPositionStopLoss:    { enabled: false, pct: null },
    perPositionTakeProfit:  { enabled: false, pct: null },
    perPositionTrailingStop:{ enabled: false, pct: null },

    autoPause: { lossPct: null, lossUsd: null, profitPct: null, profitUsd: null },
    slippageTolerance: { ...DEFAULT_SLIPPAGE_TOLERANCE },

    blockedCategories: [],
    blockedMarkets: [],

    status: 'active',
    pauseReason: null,
    // lastPollTs starts at createdAt so the first poll only sees trades made
    // AFTER this paper trader was set up — not the wallet's whole history.
    lastPollTs: Math.floor(Date.now() / 1000),
    createdAt: Math.floor(Date.now() / 1000),
  };
}

export function isValidWallet(addr) {
  return typeof addr === 'string' && /^0x[a-f0-9]{40}$/i.test(addr.trim());
}

export function shortAddr(addr) {
  if (!addr) return '';
  const a = addr.trim();
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
