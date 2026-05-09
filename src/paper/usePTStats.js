import { useEffect, useState, useCallback } from 'react';
import { registry as registryStore, accounts, trades, positions } from './paperStore.js';
import { subscribe as subscribeEvents } from './eventLog.js';
import { RANK_MIN_RESOLVED } from './constants.js';

// ── Time helpers ─────────────────────────────────────────────────────────────
function toET(unixSec) {
  return new Date(new Date(unixSec * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
function tsToETDate(unixSec) {
  const d = toET(unixSec);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// timeframe: '7d' | '30d' | '90d' | 'all'
function inWindow(unixSec, timeframe) {
  if (timeframe === 'all' || !unixSec) return true;
  const now = Math.floor(Date.now() / 1000);
  const days = timeframe === '7d' ? 7 : timeframe === '30d' ? 30 : 90;
  return unixSec >= now - days * 86400;
}

// ── Pure stats computation ───────────────────────────────────────────────────
export function computeStats(registry, account, regTrades, regPositions, timeframe = 'all') {
  const startBalance = registry.startBalance ?? 100;
  const allFilled = regTrades.filter((t) => t.status !== 'skipped');
  const filled = allFilled.filter((t) => inWindow(t.openedAt, timeframe));
  const allResolved = regPositions.filter((p) => p.isResolved);
  const resolved = allResolved.filter((p) => inWindow(p.resolvedAt, timeframe));

  const wins = resolved.filter((p) => p.resolvedPrice >= 0.99);
  const losses = resolved.filter((p) => p.resolvedPrice <= 0.01);
  const winRate = resolved.length > 0 ? (wins.length / resolved.length) * 100 : null;

  // Realized P&L = sum of position-level P&L for resolved positions in window
  const realizedPnl = resolved.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
  const roi = (realizedPnl / startBalance) * 100;

  const grossWins = wins.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
  const grossLosses = Math.abs(losses.reduce((s, p) => s + (p.realizedPnl ?? 0), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : null;

  const volume = filled.reduce((s, t) => s + (t.stake ?? 0), 0);
  const totalFees = filled.reduce((s, t) => s + (t.fee ?? 0), 0);

  // Per-trade P&L from resolved trades — for best/worst
  const resolvedTrades = filled.filter((t) => t.status === 'resolved' && t.pnl != null);
  const bestTrade = resolvedTrades.length > 0
    ? resolvedTrades.reduce((m, t) => (t.pnl > m ? t.pnl : m), -Infinity)
    : null;
  const worstTrade = resolvedTrades.length > 0
    ? resolvedTrades.reduce((m, t) => (t.pnl < m ? t.pnl : m), Infinity)
    : null;

  const slippFilled = filled.filter((t) => t.slippageBps != null);
  const avgSlippageBps = slippFilled.length > 0
    ? slippFilled.reduce((s, t) => s + t.slippageBps, 0) / slippFilled.length
    : null;

  const delayFilled = filled.filter((t) => t.pollDelayMs != null);
  const avgPollDelayMs = delayFilled.length > 0
    ? delayFilled.reduce((s, t) => s + t.pollDelayMs, 0) / delayFilled.length
    : null;

  const open = regPositions.filter((p) => !p.isResolved).length;

  // Sharpe — group by ET date, compute daily returns
  const sharpe = computeSharpe(filled, startBalance);

  // Equity curve for the window — chronological cumulative P&L
  const equity = buildEquityCurve(filled, resolved, startBalance);

  return {
    timeframe,
    startBalance,
    cash: account?.cash ?? startBalance,
    roi,
    realizedPnl,
    winRate,
    wins: wins.length,
    losses: losses.length,
    resolvedCount: resolved.length,
    tradesCopied: filled.length,
    open,
    volume,
    totalFees,
    bestTrade,
    worstTrade,
    profitFactor,
    avgSlippageBps,
    avgPollDelayMs,
    sharpe,
    equity,
    qualifies: allResolved.length >= RANK_MIN_RESOLVED,
  };
}

function buildEquityCurve(filled, resolved, startBalance) {
  // Order all events chronologically; emit a balance point after each
  const events = [
    ...filled.map((t) => ({ ts: t.openedAt, type: 'fill', stake: t.stake ?? 0, fee: t.fee ?? 0 })),
    ...resolved.map((p) => ({ ts: p.resolvedAt, type: 'resolve', pnl: p.realizedPnl ?? 0, totalCost: p.totalCost ?? 0, shares: p.shares ?? 0, exit: p.resolvedPrice ?? 0 })),
  ].filter((e) => e.ts).sort((a, b) => a.ts - b.ts);

  const out = [{ x: 0, bal: startBalance, ts: events[0]?.ts ?? Math.floor(Date.now() / 1000) }];
  let bal = startBalance;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'fill') {
      bal -= (e.stake + e.fee);
    } else if (e.type === 'resolve') {
      bal += e.shares * e.exit;
    }
    out.push({ x: out.length, bal: parseFloat(bal.toFixed(2)), ts: e.ts });
  }
  return out;
}

function computeSharpe(filled, startBalance) {
  if (filled.length < 2) return null;
  // Group resolved trades by ET date
  const byDate = new Map();
  for (const t of filled) {
    if (t.status !== 'resolved' || t.pnl == null) continue;
    const d = tsToETDate(t.resolvedAt ?? t.openedAt);
    byDate.set(d, (byDate.get(d) ?? 0) + t.pnl);
  }
  if (byDate.size < 2) return null;
  const dailyReturns = Array.from(byDate.values()).map((pnl) => pnl / startBalance);
  const mean = dailyReturns.reduce((s, x) => s + x, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((s, x) => s + (x - mean) ** 2, 0) / dailyReturns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  return (mean / std) * Math.sqrt(365);
}

// ── Hook for a single registry's stats, live-updating ────────────────────────
export function usePTStats(registryId, timeframe = 'all') {
  const [data, setData] = useState({ loading: true, registry: null, stats: null });

  const refresh = useCallback(async () => {
    if (!registryId) return;
    const reg = await registryStore.get(registryId);
    if (!reg) {
      setData({ loading: false, registry: null, stats: null });
      return;
    }
    const acct = await accounts.get(registryId);
    const ts = await trades.forRegistry(registryId);
    const ps = await positions.forRegistry(registryId);
    const stats = computeStats(reg, acct, ts, ps, timeframe);
    setData({ loading: false, registry: reg, stats, account: acct, trades: ts, positions: ps });
  }, [registryId, timeframe]);

  useEffect(() => {
    refresh();
    const unsub = subscribeEvents((evt) => {
      if (!evt?.registryId || evt.registryId === registryId) refresh();
    });
    return unsub;
  }, [refresh, registryId]);

  return { ...data, refresh };
}
