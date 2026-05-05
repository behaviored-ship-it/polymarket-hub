import { useEffect, useState } from 'react';
import { fetchOpenPositions } from './api.js';
import { API } from './constants.js';

// Apples-to-apples comparison vs the leader's actual P&L over the SAME trade
// set we attempted to copy. We pull the leader's CLOSED positions for the
// matching wallet, intersect by conditionId+outcome with our paper positions,
// and sum.
//
// What this does NOT do (intentionally):
// - Compute the leader's lifetime ROI — that depends on their portfolio size
//   which we don't observe. The fair comparison is "$ on the same trades."
// - Include trades the leader made that we filtered out (slippage, blocked,
//   newMarketsOnly). That's correct: friction = "what we lost vs what they
//   captured on the trades we DID try to copy."

async function fetchClosedPositions(walletAddr, maxPages = 20) {
  const collected = [];
  for (let i = 0; i < maxPages; i++) {
    const url = `${API.POSITIONS_PROXY}?wallet=${walletAddr}&type=closed&offset=${i * 50}`;
    const resp = await fetch(url);
    if (!resp.ok) break;
    const batch = await resp.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    collected.push(...batch);
    if (batch.length < 50) break;
  }
  return collected;
}

export function useVsActual(registry, paperPositions, paperTrades) {
  const [data, setData] = useState({ loading: true });

  useEffect(() => {
    if (!registry?.walletAddr) return;
    let active = true;

    (async () => {
      try {
        const [leaderClosed, leaderOpen] = await Promise.all([
          fetchClosedPositions(registry.walletAddr).catch(() => []),
          fetchOpenPositions(registry.walletAddr).catch(() => []),
        ]);
        if (!active) return;

        // Build lookup of leader's per-(condition, outcome) realized P&L
        const leaderByKey = new Map();
        for (const p of leaderClosed) {
          if (!p.conditionId) continue;
          const key = `${p.conditionId}_${String(p.outcome ?? '').toLowerCase()}`;
          const pnl = parseFloat(p.realizedPnl ?? 0);
          leaderByKey.set(key, (leaderByKey.get(key) ?? 0) + (Number.isFinite(pnl) ? pnl : 0));
        }
        // Open positions still in flight count toward leader's "in-progress" P&L
        const leaderOpenByKey = new Map();
        for (const p of leaderOpen) {
          if (!p.conditionId) continue;
          const key = `${p.conditionId}_${String(p.outcome ?? '').toLowerCase()}`;
          leaderOpenByKey.set(key, parseFloat(p.curPrice));
        }

        // Intersect with paper positions
        let leaderRealOnOurTrades = 0;
        let paperRealOnSame = 0;
        let matched = 0;
        let unmatched = 0;

        for (const p of paperPositions) {
          const key = `${p.conditionId}_${String(p.outcome ?? '').toLowerCase()}`;
          const leaderPnl = leaderByKey.get(key);
          if (leaderPnl != null) {
            leaderRealOnOurTrades += leaderPnl;
            if (p.isResolved) paperRealOnSame += (p.realizedPnl ?? 0);
            matched++;
          } else {
            unmatched++;
          }
        }

        const totalLeaderClosedPnl = leaderClosed
          .reduce((s, p) => s + (parseFloat(p.realizedPnl ?? 0) || 0), 0);

        // Total fees paid by us across all paper trades
        const totalFees = paperTrades.reduce((s, t) => s + (t.fee ?? 0), 0);
        const avgSlippage = (() => {
          const filled = paperTrades.filter((t) => t.slippageBps != null);
          if (filled.length === 0) return null;
          return filled.reduce((s, t) => s + t.slippageBps, 0) / filled.length;
        })();

        setData({
          loading: false,
          leaderRealOnOurTrades,
          paperRealOnSame,
          frictionUsd: leaderRealOnOurTrades - paperRealOnSame,
          totalLeaderClosedPnl,
          totalFees,
          avgSlippageBps: avgSlippage,
          matched,
          unmatched,
          window: { from: registry.createdAt, to: Math.floor(Date.now() / 1000) },
        });
      } catch (err) {
        if (active) setData({ loading: false, error: err.message });
      }
    })();

    return () => { active = false; };
  }, [registry?.id, registry?.walletAddr, paperPositions.length, paperTrades.length]);

  return data;
}
