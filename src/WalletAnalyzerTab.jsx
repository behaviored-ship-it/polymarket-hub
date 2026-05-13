// src/WalletAnalyzerTab.jsx
//
// Standalone Wallet Analyzer page. Decoupled from the global WR-tracker fetch:
// has its own wallet input and pulls two feeds at once — closed positions (for
// the existing archetype classifier) and the activity feed (for the new
// extended metrics: avg buy vs sell, hold time, buy-price distribution).
//
// Deep-link entry point: parent passes `initialWallet` (and triggers a fetch
// on mount when non-empty) so the "Open in Wallet Analyzer →" button from
// Paper Trader Detail can hand off a wallet without the user re-typing.

import { useEffect, useRef, useState } from 'react';
import WalletAnalyzer, { computeExtendedMetrics } from './wallet-analyzer.jsx';
import { fetchActivity } from './paper/api.js';

const PROXY_BASE = 'https://polymarket-hub.vercel.app/api/positions';

const C = {
  green:   '#00ff9d',
  gold:    '#f0c040',
  red:     '#ff4070',
  muted:   '#8090b0',
  light:   '#b0bcd0',
  bg0:     '#0d0d1f',
  bg1:     '#001510',
  panel:   '#0d0d1f',
  border:  '#1e2040',
};

function tsToETDate(ts) {
  const d = new Date(new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function tsToETHour(ts) {
  return new Date(new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
}

// ── Helpers for the extended-metrics panel ─────────────────────────────────
const fmtPrice = (n) => n == null ? '—' : n.toFixed(3);
const fmtUsd = (n) => n == null ? '—' : (n >= 0 ? '+' : '-') + `$${Math.abs(n).toFixed(2)}`;
const fmtUsdPlain = (n) => n == null ? '—' : `$${n.toFixed(2)}`;
const fmtPct = (n) => n == null ? '—' : `${n.toFixed(1)}%`;
const fmtHours = (n) => {
  if (n == null) return '—';
  if (n < 1)  return `${(n * 60).toFixed(1)} min`;
  if (n < 48) return `${n.toFixed(1)} hr`;
  return `${(n / 24).toFixed(1)} days`;
};

function holdTimeVerdict(median) {
  if (median == null) return null;
  if (median < 1 / 6) return { color: C.red,   label: 'scalper — uncopyable via market orders' };
  if (median < 1)     return { color: C.gold,  label: 'short-hold — execution edge matters' };
  if (median <= 30)   return { color: C.green, label: 'in copy-friendly range' };
  return                       { color: C.gold, label: 'long-hold — risk of bag-holding' };
}

function MetricCard({ label, primary, secondary, color }) {
  return (
    <div style={{
      background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 3,
      padding: '12px 14px', minWidth: 0,
    }}>
      <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, color: color ?? '#fff', fontWeight: 'bold', fontVariantNumeric: 'tabular-nums' }}>
        {primary}
      </div>
      {secondary != null && (
        <div style={{ fontSize: 10, color: C.muted, marginTop: 4, lineHeight: 1.4 }}>{secondary}</div>
      )}
    </div>
  );
}

function ExtendedMetricsPanel({ ext }) {
  if (!ext) return null;
  const { buyDistribution: bd, drawdown: dd, buySellSplit: bs, holdTime: ht } = ext;

  const holdVerdict = holdTimeVerdict(ht?.medianHoldHours);

  return (
    <div style={{
      background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3,
      padding: 16, margin: '20px 20px 0',
    }}>
      <div style={{ fontSize: 11, letterSpacing: 2, color: C.muted, marginBottom: 12, textTransform: 'uppercase' }}>
        EXTENDED METRICS
      </div>

      {/* Top row: hold time, drawdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 10 }}>
        <MetricCard
          label="Median hold"
          primary={fmtHours(ht?.medianHoldHours)}
          secondary={
            ht?.pairCount
              ? `${ht.pairCount} matched pairs · ${holdVerdict?.label ?? ''}`
              : 'No matched BUY→SELL pairs in activity'
          }
          color={holdVerdict?.color}
        />
        <MetricCard
          label="USD-weighted hold"
          primary={fmtHours(ht?.usdWeightedMeanHoldHours)}
          secondary="Weighted by dollar size — where the money sits"
        />
        <MetricCard
          label="Max drawdown"
          primary={dd ? fmtUsdPlain(dd.maxDrawdownUsd) : '—'}
          secondary={dd ? `${fmtPct(dd.maxDrawdownPct)} of peak` : 'Needs trades with PnL + timestamps'}
          color={dd && dd.maxDrawdownUsd > 0 ? C.gold : '#fff'}
        />
      </div>

      {/* Second row: buy distribution + buy/sell prices */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <MetricCard
          label="Buy price · P50"
          primary={fmtPrice(bd?.p50)}
          secondary={bd ? `P10 ${fmtPrice(bd.p10)} · P90 ${fmtPrice(bd.p90)}` : '—'}
        />
        <MetricCard
          label="Buy price · range"
          primary={bd ? `${fmtPrice(bd.min)} – ${fmtPrice(bd.max)}` : '—'}
          secondary={bd ? `${bd.n} buys analyzed` : '—'}
        />
        <MetricCard
          label="Avg buy (vol-weighted)"
          primary={fmtPrice(bs?.avgBuyPrice)}
          secondary={bs ? `${bs.buyCount} fills · ${fmtUsdPlain(bs.buyVolumeUsd)} vol` : 'Needs activity feed'}
        />
        <MetricCard
          label="Avg sell (vol-weighted)"
          primary={fmtPrice(bs?.avgSellPrice)}
          secondary={bs ? `${bs.sellCount} fills · ${fmtUsdPlain(bs.sellVolumeUsd)} vol` : 'Needs activity feed'}
          color={bs?.avgSellPrice != null && bs.avgSellPrice > 0.90 ? C.gold : undefined}
        />
      </div>
    </div>
  );
}

// ── Data fetching ───────────────────────────────────────────────────────────
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
  // Normalize to the closed-position shape consumed by computeMetrics. PnL=0
  // rows are scratch trades that don't tell us about edge; drop them like WR
  // tracker does.
  return all
    .filter((t) => parseFloat(t.realizedPnl) !== 0)
    .map((t) => {
      const p = parseFloat(t.realizedPnl);
      return {
        id: t.id || `${t.conditionId}_${t.timestamp}`,
        conditionId: t.conditionId || '',
        dateET: tsToETDate(t.timestamp),
        hourET: tsToETHour(t.timestamp),
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

// ── Component ───────────────────────────────────────────────────────────────
export default function WalletAnalyzerTab({ initialWallet, wrWallet, backtest }) {
  const [input, setInput] = useState(initialWallet || '');
  const [status, setStatus] = useState('idle');   // idle | loading | ready | error
  const [msg, setMsg] = useState('');
  const [trades, setTrades] = useState([]);
  const [activity, setActivity] = useState([]);
  const lastFetched = useRef(null);

  // Only feed the backtest result into the copyability score when the analyzer
  // is looking at the SAME wallet the backtest was run on. Otherwise we'd be
  // mixing wallet A's ROI into wallet B's score — silently misleading.
  const analyzerWallet = (lastFetched.current || input || '').trim().toLowerCase();
  const backtestWallet = (wrWallet || '').trim().toLowerCase();
  const backtestForThisWallet = (backtest && analyzerWallet && analyzerWallet === backtestWallet)
    ? backtest
    : null;

  const run = async (addr) => {
    const address = (addr ?? input).trim();
    if (!address.startsWith('0x') || address.length < 10) {
      setStatus('error');
      setMsg('Paste a wallet address starting with 0x');
      return;
    }
    setStatus('loading');
    setMsg('Fetching closed positions + activity...');
    try {
      // Two independent fetches in parallel — neither blocks the other on a
      // slow Polymarket endpoint. Each panel gracefully renders empty if its
      // feed errors.
      const [closed, act] = await Promise.allSettled([
        fetchClosedTrades(address),
        fetchActivity(address),
      ]);
      const closedTrades = closed.status === 'fulfilled' ? closed.value : [];
      const activityRows = act.status === 'fulfilled' ? act.value : [];
      setTrades(closedTrades);
      setActivity(activityRows);
      lastFetched.current = address;
      const errs = [];
      if (closed.status === 'rejected') errs.push(`closed: ${closed.reason?.message ?? 'failed'}`);
      if (act.status === 'rejected') errs.push(`activity: ${act.reason?.message ?? 'failed'}`);
      setStatus(closedTrades.length || activityRows.length ? 'ready' : 'error');
      setMsg(
        closedTrades.length || activityRows.length
          ? `${closedTrades.length} closed positions · ${activityRows.length} activity rows${errs.length ? ` (warn: ${errs.join('; ')})` : ''}`
          : `No data returned${errs.length ? ` — ${errs.join('; ')}` : ''}`
      );
    } catch (err) {
      setStatus('error');
      setMsg(`Error: ${err.message}`);
    }
  };

  // Deep-link: when initialWallet changes (parent navigated us here from
  // Paper Trader), auto-fetch — but only once per address change so toggling
  // tabs doesn't re-fire.
  useEffect(() => {
    if (initialWallet && initialWallet !== lastFetched.current) {
      setInput(initialWallet);
      run(initialWallet);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWallet]);

  const ext = trades.length || activity.length
    ? computeExtendedMetrics({ trades, activity })
    : null;

  return (
    <div>
      {/* ── Input row ─────────────────────────────────────────────── */}
      <div style={{
        background: C.bg0, borderBottom: `1px solid ${C.border}`,
        padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <span style={{
          fontSize: 11, color: C.muted, letterSpacing: 2, textTransform: 'uppercase', marginRight: 4,
        }}>
          Wallet
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
          placeholder="0x..."
          style={{
            flex: '1 1 360px', minWidth: 240,
            background: '#0a0a1a', border: `1px solid ${C.border}`, color: '#fff',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12, padding: '8px 10px',
            outline: 'none', borderRadius: 2,
          }}
        />
        <button
          onClick={() => run()}
          disabled={status === 'loading'}
          style={{
            background: status === 'loading' ? '#252845' : '#003318',
            border: `1px solid ${status === 'loading' ? C.border : C.green}`,
            color: status === 'loading' ? C.muted : C.green,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: 2,
            padding: '8px 16px', cursor: status === 'loading' ? 'wait' : 'pointer',
            borderRadius: 2, textTransform: 'uppercase',
          }}
        >
          {status === 'loading' ? 'Fetching…' : 'Analyze'}
        </button>
        {msg && (
          <span style={{
            fontSize: 11, color: status === 'error' ? C.red : C.muted, letterSpacing: 1,
            marginLeft: 'auto', flex: '0 0 auto',
          }}>
            {msg}
          </span>
        )}
      </div>

      {/* ── Body ─────────────────────────────────────────────────── */}
      {status === 'idle' && !trades.length ? (
        <div style={{ padding: 60, textAlign: 'center' }}>
          <div style={{ fontSize: 36, opacity: 0.4, marginBottom: 14 }}>⬡</div>
          <div style={{ fontSize: 12, color: C.muted, letterSpacing: 2, textTransform: 'uppercase' }}>
            Paste any Polymarket wallet to analyze
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
            Pulls closed positions for the archetype classifier and the activity feed for hold-time + buy/sell metrics.
          </div>
        </div>
      ) : (
        <>
          <WalletAnalyzer trades={trades} backtest={backtestForThisWallet} />
          {ext && <ExtendedMetricsPanel ext={ext} />}
        </>
      )}
    </div>
  );
}
