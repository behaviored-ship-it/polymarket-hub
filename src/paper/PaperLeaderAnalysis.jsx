// src/paper/PaperLeaderAnalysis.jsx
//
// Compact "is this leader worth copying?" panel inside the Paper Trader detail
// view. Pulls the same two feeds the Wallet Analyzer tab uses — closed
// positions (for archetype + copyability score) and activity (for hold-time +
// hedge/spread signals) — but only renders the high-signal disqualifiers.
// "Analyze Leader →" hands off to the full Wallet Analyzer tab via the
// onAnalyzeWallet callback threaded down from App.

import { useEffect, useState } from 'react';
import {
  computeMetrics,
  classifyArchetype,
  scoreCopyability,
  computeExtendedMetrics,
} from '../wallet-analyzer.jsx';
import { fetchActivity } from './api.js';

const PROXY_BASE = 'https://polymarket-hub.vercel.app/api/positions';

const C = {
  green:  '#00ff9d',
  gold:   '#f0c040',
  red:    '#ff4070',
  muted:  '#8090b0',
  light:  '#b0bcd0',
  panel:  '#0d0d1f',
  bg1:    '#001510',
  border: '#1e2040',
  text:   '#fff',
};

const fmtPrice = (n) => n == null ? '—' : n.toFixed(3);
const fmtPct = (n) => n == null ? '—' : `${n.toFixed(1)}%`;
const fmtHours = (n) => {
  if (n == null) return '—';
  if (n < 1)  return `${(n * 60).toFixed(1)} min`;
  if (n < 48) return `${n.toFixed(1)} hr`;
  return `${(n / 24).toFixed(1)} days`;
};

function holdTimeVerdict(median) {
  if (median == null) return { color: C.muted, label: 'no matched buy/sell pairs' };
  if (median < 1 / 6) return { color: C.red,   label: 'scalper — likely uncopyable' };
  if (median < 1)     return { color: C.gold,  label: 'short hold — execution-sensitive' };
  if (median <= 30)   return { color: C.green, label: 'in copy-friendly range' };
  return                       { color: C.gold, label: 'long hold — bag-holder risk' };
}

function copyabilityColor(score) {
  if (score == null) return C.muted;
  if (score >= 65) return C.green;
  if (score >= 40) return C.gold;
  return C.red;
}

async function fetchClosedTrades(address) {
  const all = [];
  let offset = 0;
  while (true) {
    const url = `${PROXY_BASE}?wallet=${address.toLowerCase()}&offset=${offset}&type=closed`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`positions API ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 50) break;
    offset += 50;
  }
  return all
    .filter((t) => parseFloat(t.realizedPnl) !== 0)
    .map((t) => {
      const p = parseFloat(t.realizedPnl);
      return {
        id: t.id || `${t.conditionId}_${t.timestamp}`,
        conditionId: t.conditionId || '',
        result: p > 0 ? 'win' : 'loss',
        avgPrice: parseFloat(t.avgPrice || 0.5),
        size: parseFloat(t.size || 0),
        realizedPnl: p,
        totalBought: parseFloat(t.totalBought || 0),
        timestamp: t.timestamp,
        title: t.title || '',
      };
    });
}

function SummaryRow({ label, value, sub, color }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      padding: '10px 14px', borderBottom: `1px solid ${C.border}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1.5, textTransform: 'uppercase' }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>{sub}</div>}
      </div>
      <div style={{ fontSize: 16, color: color ?? C.text, fontWeight: 'bold', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
        {value}
      </div>
    </div>
  );
}

export default function PaperLeaderAnalysis({ registry, onAnalyzeWallet }) {
  const wallet = registry?.walletAddr;
  const [status, setStatus] = useState('idle');
  const [msg, setMsg] = useState('');
  const [trades, setTrades] = useState([]);
  const [activity, setActivity] = useState([]);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    setStatus('loading');
    setMsg('Fetching leader history…');
    (async () => {
      const [closed, act] = await Promise.allSettled([
        fetchClosedTrades(wallet),
        fetchActivity(wallet),
      ]);
      if (cancelled) return;
      const closedTrades = closed.status === 'fulfilled' ? closed.value : [];
      const activityRows = act.status === 'fulfilled' ? act.value : [];
      setTrades(closedTrades);
      setActivity(activityRows);
      const errs = [];
      if (closed.status === 'rejected') errs.push('closed fetch failed');
      if (act.status === 'rejected') errs.push('activity fetch failed');
      setStatus(closedTrades.length || activityRows.length ? 'ready' : 'error');
      setMsg(
        closedTrades.length || activityRows.length
          ? `${closedTrades.length} closed positions · ${activityRows.length} activity rows${errs.length ? ` (${errs.join('; ')})` : ''}`
          : (errs.join('; ') || 'No data')
      );
    })();
    return () => { cancelled = true; };
  }, [wallet]);

  // Run the full classifier + extended metrics, but only render the disqualifier
  // headline numbers. The deep dive lives in the Wallet Analyzer tab.
  const metrics = trades.length ? computeMetrics(trades) : null;
  const arch = metrics ? classifyArchetype(metrics) : null;
  const copy = metrics && arch ? scoreCopyability(metrics, arch, null) : null;
  const ext = trades.length || activity.length
    ? computeExtendedMetrics({ trades, activity })
    : null;

  const holdVerdict = holdTimeVerdict(ext?.holdTime?.medianHoldHours);
  const copyColor = copyabilityColor(copy?.score);

  return (
    <div>
      {/* Header row: status + Open in Wallet Analyzer */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3,
        padding: '10px 14px', marginBottom: 14,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, textTransform: 'uppercase' }}>
            Leader Wallet
          </div>
          <div style={{ fontSize: 13, color: C.text, fontFamily: "'JetBrains Mono', monospace", marginTop: 3, wordBreak: 'break-all' }}>
            {wallet || '—'}
          </div>
          {msg && (
            <div style={{ fontSize: 10, color: status === 'error' ? C.red : C.muted, marginTop: 4 }}>
              {msg}
            </div>
          )}
        </div>
        <button
          onClick={() => onAnalyzeWallet?.(wallet)}
          disabled={!wallet || !onAnalyzeWallet}
          style={{
            background: '#003318',
            border: `1px solid ${C.green}`,
            color: C.green,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: 2,
            padding: '8px 14px', cursor: onAnalyzeWallet ? 'pointer' : 'not-allowed',
            borderRadius: 2, textTransform: 'uppercase', whiteSpace: 'nowrap',
            opacity: wallet && onAnalyzeWallet ? 1 : 0.4,
          }}
        >
          Analyze Leader →
        </button>
      </div>

      {/* Verdict tiles */}
      {status === 'loading' ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.muted, letterSpacing: 2 }}>LOADING…</div>
      ) : !metrics && !ext ? (
        <div style={{
          background: C.panel, border: `1px dashed ${C.border}`, borderRadius: 3,
          padding: '40px 20px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 12, color: C.muted, letterSpacing: 1.5, textTransform: 'uppercase' }}>
            Not enough data yet
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
            Classifier needs at least 20 closed trades. Open in Wallet Analyzer for the raw feed.
          </div>
        </div>
      ) : (
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 3 }}>
          <SummaryRow
            label="Archetype"
            value={arch?.label ?? '—'}
            sub={arch?.confidence ? `confidence ${(arch.confidence * 100).toFixed(0)}%` : null}
            color={arch?.archetype === 'directional' ? C.green
                 : arch?.archetype === 'losing'      ? C.red
                 : arch?.archetype === 'mm_skew'     ? C.gold
                 : C.text}
          />
          <SummaryRow
            label="Copyability score"
            value={copy?.score != null ? `${copy.score}/100` : '—'}
            sub={copy?.verdict ?? null}
            color={copyColor}
          />
          <SummaryRow
            label="Median hold time"
            value={fmtHours(ext?.holdTime?.medianHoldHours)}
            sub={holdVerdict.label}
            color={holdVerdict.color}
          />
          <SummaryRow
            label="Hedged markets"
            value={metrics?.multiEntryPct != null ? fmtPct(metrics.multiEntryPct * 100) : '—'}
            sub="markets where leader entered both Up and Down"
            color={metrics?.multiEntryPct > 0.5 ? C.red
                 : metrics?.multiEntryPct > 0.2 ? C.gold
                 : C.text}
          />
          <SummaryRow
            label="Avg buy price"
            value={fmtPrice(ext?.buySellSplit?.avgBuyPrice ?? metrics?.priceMean)}
            sub={
              ext?.buyDistribution
                ? `P10 ${fmtPrice(ext.buyDistribution.p10)} · P90 ${fmtPrice(ext.buyDistribution.p90)}`
                : null
            }
            color={
              (ext?.buySellSplit?.avgBuyPrice ?? metrics?.priceMean) > 0.85 ? C.gold : C.text
            }
          />
          <SummaryRow
            label="Max drawdown"
            value={ext?.drawdown ? `$${ext.drawdown.maxDrawdownUsd.toFixed(0)}` : '—'}
            sub={ext?.drawdown ? `${fmtPct(ext.drawdown.maxDrawdownPct)} of peak` : null}
            color={ext?.drawdown && ext.drawdown.maxDrawdownPct > 50 ? C.gold : C.text}
          />
        </div>
      )}

      <div style={{ fontSize: 10, color: C.muted, marginTop: 14, lineHeight: 1.5 }}>
        These are the high-signal disqualifiers. Open in Wallet Analyzer for the full classifier reasoning, copyability breakdown, and extended-metrics panel.
      </div>
    </div>
  );
}
