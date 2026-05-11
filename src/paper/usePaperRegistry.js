import { useEffect, useState, useCallback } from 'react';
import { registry as registryStore, accounts, trades, positions } from './paperStore.js';
import { startScheduler } from './scheduler.js';
import { subscribe as subscribeEvents } from './eventLog.js';
import { defaultRegistry } from './registryDefaults.js';
import { RANK_MIN_RESOLVED } from './constants.js';

function computeCardStats(registry, regTrades, regPositions) {
  const filled = regTrades.filter((t) => t.status !== 'skipped');
  const resolved = regPositions.filter((p) => p.isResolved);
  const wins = resolved.filter((p) => p.resolvedPrice >= 0.99).length;
  const losses = resolved.filter((p) => p.resolvedPrice <= 0.01).length;
  const realizedPnl = regPositions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
  const roi = registry.startBalance > 0 ? (realizedPnl / registry.startBalance) * 100 : 0;
  const wr = resolved.length > 0 ? (wins / resolved.length) * 100 : null;
  const open = regPositions.filter((p) => !p.isResolved).length;
  return {
    roi,
    wr,
    realizedPnl,
    tradesCopied: filled.length,
    open,
    resolvedCount: resolved.length,
    wins,
    losses,
    qualifies: resolved.length >= RANK_MIN_RESOLVED,
  };
}

function assignRanks(cards) {
  // Primary sort: qualified first (sorted by ROI desc), then unqualified
  const qualified = cards.filter((c) => c.stats.qualifies)
    .sort((a, b) => b.stats.roi - a.stats.roi);
  const unqualified = cards.filter((c) => !c.stats.qualifies)
    .sort((a, b) => b.stats.roi - a.stats.roi);
  qualified.forEach((c, i) => { c.rank = i + 1; });
  unqualified.forEach((c) => { c.rank = null; });
  return [...qualified, ...unqualified];
}

export function usePaperRegistry() {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const regs = await registryStore.list();
    const allTrades = await trades.list();
    const allPositions = await positions.list();
    const built = regs.map((r) => {
      const rt = allTrades.filter((t) => t.registryId === r.id);
      const rp = allPositions.filter((p) => p.registryId === r.id);
      return { registry: r, stats: computeCardStats(r, rt, rp) };
    });
    setCards(assignRanks(built));
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    startScheduler();
    // Re-render whenever an event lands so card stats stay live
    const unsub = subscribeEvents(() => { refresh(); });
    return unsub;
  }, [refresh]);

  const addTrader = useCallback(async (input) => {
    const r = defaultRegistry(input);
    await registryStore.put(r);
    await accounts.put({
      registryId: r.id,
      cash: r.startBalance,
      peakBalance: r.startBalance,
      createdAt: r.createdAt,
    });
    await refresh();
    return r;
  }, [refresh]);

  const pauseTrader = useCallback(async (id) => {
    const r = await registryStore.get(id);
    if (!r) return;
    await registryStore.put({ ...r, status: 'paused', pauseReason: 'manual' });
    await refresh();
  }, [refresh]);

  const resumeTrader = useCallback(async (id) => {
    const r = await registryStore.get(id);
    if (!r) return;
    await registryStore.put({ ...r, status: 'active', pauseReason: null });
    await refresh();
  }, [refresh]);

  const stopTrader = useCallback(async (id) => {
    const r = await registryStore.get(id);
    if (!r) return;
    await registryStore.put({ ...r, status: 'stopped' });
    await refresh();
  }, [refresh]);

  const deleteTrader = useCallback(async (id) => {
    // Hard delete — registry, account, all trades, all positions
    await trades.deleteForRegistry(id);
    await positions.deleteForRegistry(id);
    await accounts.remove(id);
    await registryStore.remove(id);
    await refresh();
  }, [refresh]);

  const resetTrader = useCallback(async (id) => {
    const r = await registryStore.get(id);
    if (!r) return;
    // Reset wipes trades + positions and restores starting balance.
    // Use this when you want a clean slate for the SAME wallet config.
    await trades.deleteForRegistry(id);
    await positions.deleteForRegistry(id);
    // lastPollTs = now so RESET doesn't re-trigger a wallet-history backfill
    await registryStore.put({ ...r, lastPollTs: Math.floor(Date.now() / 1000), status: 'active', pauseReason: null });
    await accounts.put({
      registryId: id,
      cash: r.startBalance,
      peakBalance: r.startBalance,
      createdAt: r.createdAt,
    });
    await refresh();
  }, [refresh]);

  return {
    cards, loading, refresh,
    addTrader, pauseTrader, resumeTrader, stopTrader, deleteTrader, resetTrader,
  };
}
