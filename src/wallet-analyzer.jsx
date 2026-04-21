// src/wallet-analyzer.jsx
//
// Wallet Analyzer — archetype classifier + verdict banner for Polymarket Hub.
//
// Consumes the `trades` state from polymarket-hub.jsx. Each trade is an aggregated
// closed position with this shape:
//
//   {
//     id, conditionId,
//     dateET, hourET, timestamp,
//     result: 'win' | 'loss',
//     avgPrice,                  // price of shares bought
//     size,                      // shares remaining after resolution (often 0)
//     realizedPnl,               // $ profit/loss after settlement
//     totalBought,               // dollar value of position at entry
//     title,                     // "Bitcoin Up or Down - April 17, 10:20AM-10:25AM ET"
//   }
//
// IMPORTANT: This is aggregated closed-position data, not raw fills.
// - No 'outcome' / 'side' field to tell us Up vs Down — limits both-sides detection.
// - No SELLs by definition — every record is one settled buy.
// - 'result' gives reliable win/loss; 'realizedPnl' gives the $.
//
// Classifier strategy (given the constraints):
//   - Use WR + PnL skew asymmetry as the primary archetype signal
//   - A 50% WR with meaningfully positive PnL ⇒ MM-skew / scalper (asymmetric $/trade)
//   - A >55% WR with positive PnL ⇒ directional edge
//   - Compute "windows with multiple entries" via conditionId grouping as a proxy for both-sides
//     (slip-me enters the same market multiple times — directional traders typically don't)

import { useMemo } from 'react';

// ─── Theme (match polymarket-hub.jsx palette) ───
const C = {
  green:   '#00ff9d',
  gold:    '#f0c040',
  red:     '#ff4070',
  muted:   '#8090b0',
  light:   '#b0bcd0',
  bg0:     '#0d0d1f',
  bg1:     '#001510',
  border:  '#1e2040',
  borderG: '#005528',
};

// ─── Thresholds ───
const MIN_TRADES_FOR_CONFIDENT = 300;
const MIN_DAYS_ACTIVE          = 3;

const WR_FLAT_EPSILON          = 0.03;    // WR within 50% ± 3% = "coin-flip"
const WR_DIRECTIONAL_MIN       = 0.55;    // >55% WR suggests directional edge
const MULTI_ENTRY_MM           = 0.60;    // >60% of markets had multiple entries ⇒ MM-ish
const POSITION_CV_BOT          = 0.55;    // uniform sizing → bot
const ASYM_RATIO_MM_SKEW       = 1.5;     // avg win $ / avg loss $ ≥ 1.5 ⇒ asymmetric edge

// ─── Helpers (matches actual Polymarket Hub trade shape) ───

function dollarValueOf(t) {
  return Number(t.totalBought ?? 0);
}

function priceOf(t) {
  return Number(t.avgPrice ?? 0);
}

function windowKeyOf(t) {
  // Each conditionId is one Polymarket market (e.g. one 5-min BTC window)
  return t.conditionId || t.id || 'unknown';
}

function pnlOf(t) {
  return Number(t.realizedPnl ?? 0);
}

function isWin(t)  { return t.result === 'win'; }
function isLoss(t) { return t.result === 'loss'; }

function tsOf(t) {
  return Number(t.timestamp ?? 0);
}

function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a,b)=>a+b, 0) / xs.length;
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x-m)*(x-m))));
}

// ─── Metric computation ───

export function computeMetrics(trades) {
  if (!trades || trades.length < 20) return null;

  const dollars = trades.map(dollarValueOf).filter(v => v > 0);
  const posMean = mean(dollars);
  const posStdev = stdev(dollars);
  const posCV = posMean > 0 ? posStdev / posMean : 0;

  const prices = trades.map(priceOf).filter(v => v > 0);
  const priceMean = mean(prices);
  const priceStdev = stdev(prices);

  // Multi-entry per market — proxy for MM-skew / scalper pattern
  const windowCounts = {};
  for (const t of trades) {
    const k = windowKeyOf(t);
    windowCounts[k] = (windowCounts[k] || 0) + 1;
  }
  const winKeys = Object.keys(windowCounts);
  const multiEntryCount = winKeys.filter(k => windowCounts[k] > 1).length;
  const multiEntryPct = winKeys.length > 0 ? multiEntryCount / winKeys.length : 0;
  const tradesPerWindow = winKeys.length > 0 ? trades.length / winKeys.length : 0;

  // PnL stats — from reliable result + realizedPnl fields
  const wins   = trades.filter(isWin);
  const losses = trades.filter(isLoss);
  const totalPnl = trades.reduce((s, t) => s + pnlOf(t), 0);
  const decided = wins.length + losses.length;
  const winRate = decided > 0 ? wins.length / decided : null;

  const avgWin  = wins.length   ? mean(wins.map(pnlOf))          : 0;
  const avgLoss = losses.length ? Math.abs(mean(losses.map(pnlOf))) : 0;
  const asymRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

  // Activity window
  const timestamps = trades.map(tsOf).filter(Boolean);
  const daysActive = timestamps.length >= 2
    ? (Math.max(...timestamps) - Math.min(...timestamps)) / 86400
    : 0;

  // Daily Sharpe
  const byDay = {};
  for (const t of trades) {
    const ts = tsOf(t);
    if (!ts) continue;
    const day = Math.floor(ts / 86400);
    byDay[day] = (byDay[day] || 0) + pnlOf(t);
  }
  const dailyPnls = Object.values(byDay);
  const dailyMean = mean(dailyPnls);
  const dailyStd = stdev(dailyPnls);
  const sharpeDaily = dailyStd > 0 ? dailyMean / dailyStd : 0;

  return {
    tradeCount: trades.length,
    windowCount: winKeys.length,
    daysActive,
    tradesPerWindow,
    multiEntryPct,
    positionMean: posMean,
    positionStdev: posStdev,
    positionCV: posCV,
    priceMean,
    priceStdev,
    winRate,
    winCount: wins.length,
    lossCount: losses.length,
    decidedCount: decided,
    totalPnl,
    avgWin,
    avgLoss,
    asymRatio,
    sharpeDaily,
    dailySamples: dailyPnls.length,
  };
}

// ─── Archetype classifier ───

export function classifyArchetype(metrics) {
  if (!metrics || metrics.tradeCount < MIN_TRADES_FOR_CONFIDENT || metrics.daysActive < MIN_DAYS_ACTIVE) {
    return {
      archetype: 'insufficient',
      label: 'Insufficient Data',
      confidence: 0,
      reasons: [
        !metrics ? 'No trades loaded' : null,
        metrics && metrics.tradeCount < MIN_TRADES_FOR_CONFIDENT
          ? `Only ${metrics?.tradeCount ?? 0} trades (need ${MIN_TRADES_FOR_CONFIDENT}+)` : null,
        metrics && metrics.daysActive < MIN_DAYS_ACTIVE
          ? `Only ${metrics?.daysActive.toFixed(1) ?? 0} days active (need ${MIN_DAYS_ACTIVE}+)` : null,
      ].filter(Boolean),
    };
  }

  const m = metrics;
  const reasons = [];

  const wrIsFlat        = m.winRate != null && Math.abs(m.winRate - 0.5) < WR_FLAT_EPSILON;
  const wrIsDirectional = m.winRate != null && m.winRate >= WR_DIRECTIONAL_MIN;
  const hasMultiEntry   = m.multiEntryPct > MULTI_ENTRY_MM;
  const uniformSize     = m.positionCV < POSITION_CV_BOT;
  const profitable      = m.totalPnl > 0;
  const asymmetric      = m.asymRatio >= ASYM_RATIO_MM_SKEW;

  // MM-SKEW / SCALPER — 50% WR but profitable via $-skew
  if (wrIsFlat && profitable && (hasMultiEntry || asymmetric || uniformSize)) {
    reasons.push(`WR = ${(m.winRate*100).toFixed(1)}% (coin-flip) but PnL = $${Math.round(m.totalPnl).toLocaleString()}`);
    if (asymmetric) {
      reasons.push(`Avg win / avg loss = ${m.asymRatio.toFixed(2)}x — asymmetric $ edge, not directional`);
    } else {
      reasons.push(`Profitable at 50% WR ⇒ edge is $-per-trade, not direction-picking`);
    }
    if (hasMultiEntry) {
      reasons.push(`${(m.multiEntryPct*100).toFixed(0)}% of markets entered >1x (scalper/MM pattern)`);
    }
    if (uniformSize) {
      reasons.push(`Pos size CV = ${m.positionCV.toFixed(2)} — uniform sizing ⇒ bot`);
    }
    return { archetype: 'mm_skew', label: 'Scalper / MM-Skew', confidence: 0.9, reasons };
  }

  // DIRECTIONAL
  if (wrIsDirectional && profitable) {
    reasons.push(`WR = ${(m.winRate*100).toFixed(1)}% — directional edge`);
    reasons.push(`$${Math.round(m.totalPnl).toLocaleString()} PnL over ${m.decidedCount} decided trades`);
    reasons.push(`${m.tradesPerWindow.toFixed(1)} trades/window avg`);
    if (m.sharpeDaily > 0.8 && m.dailySamples >= 5) {
      reasons.push(`Daily Sharpe ${m.sharpeDaily.toFixed(2)} — smooth upward equity`);
    }
    const strong = m.winRate > 0.58 && m.totalPnl > 500;
    return {
      archetype: 'directional',
      label: strong ? 'Directional Alpha' : 'Directional (weak edge)',
      confidence: strong ? 0.9 : 0.7,
      reasons,
    };
  }

  // LOSING
  if (m.totalPnl < -100) {
    reasons.push(`Net PnL = $${Math.round(m.totalPnl).toLocaleString()} — losing wallet`);
    if (m.winRate != null) reasons.push(`WR = ${(m.winRate*100).toFixed(1)}%`);
    return { archetype: 'losing', label: 'Losing', confidence: 0.85, reasons };
  }

  // Ambiguous / noise
  reasons.push(`WR = ${m.winRate != null ? (m.winRate*100).toFixed(1)+'%' : '—'}, PnL = $${Math.round(m.totalPnl).toLocaleString()}`);
  reasons.push(`${m.tradeCount} trades, ${m.tradesPerWindow.toFixed(1)}/window, pos CV ${m.positionCV.toFixed(2)}`);
  return { archetype: 'noise', label: 'Mixed / Unclassified', confidence: 0.5, reasons };
}

// ─── Copyability & Reverse-Engineer scores ───

export function scoreCopyability(metrics, arch, backtest) {
  if (!metrics || !arch || arch.archetype === 'insufficient') {
    return { score: 0, verdict: 'unknown', reasons: ['Insufficient data'] };
  }
  let score = 50;
  const reasons = [];

  if (arch.archetype === 'mm_skew')     { score -= 35; reasons.push('MM-skew edge requires cheap maker fills; taker copy destroys it (-35)'); }
  if (arch.archetype === 'directional') { score += 25; reasons.push('Directional entries are copyable same-block (+25)'); }
  if (arch.archetype === 'losing')      { score -= 40; reasons.push('Negative PnL — copying loses money (-40)'); }
  if (arch.archetype === 'noise')       { score -= 20; reasons.push('No clear edge to copy (-20)'); }

  if (backtest && Number.isFinite(backtest.roi)) {
    if (backtest.roi <= -0.5) { score -= 30; reasons.push(`Backtest ROI ${(backtest.roi*100).toFixed(0)}% — copy wipes out (-30)`); }
    else if (backtest.roi <= -0.1) { score -= 15; reasons.push(`Backtest ROI ${(backtest.roi*100).toFixed(0)}% — copy loses money (-15)`); }
    else if (backtest.roi >= 0.20) { score += 20; reasons.push(`Backtest ROI +${(backtest.roi*100).toFixed(0)}% — copy holds edge (+20)`); }
    else if (backtest.roi >= 0.05) { score += 10; reasons.push(`Backtest ROI +${(backtest.roi*100).toFixed(0)}% — copy profitable (+10)`); }
  }

  if (metrics.tradeCount > 1000 && metrics.daysActive > 14) {
    score += 5;
    reasons.push(`${metrics.tradeCount} trades / ${metrics.daysActive.toFixed(0)}d — statistically meaningful (+5)`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 65 ? 'copy' : score >= 40 ? 'caution' : 'avoid';
  return { score, verdict, reasons };
}

export function scoreReverseEngineer(metrics, arch) {
  if (!metrics || !arch || arch.archetype === 'insufficient') {
    return { score: 0, verdict: 'unknown', reasons: ['Insufficient data'] };
  }
  let score = 40;
  const reasons = [];

  if (arch.archetype === 'mm_skew')     { score += 35; reasons.push('MM-skew edge is rule-based and feature-extractable (+35)'); }
  if (arch.archetype === 'directional') { score += 25; reasons.push('Directional decisions map to observable features (+25)'); }
  if (arch.archetype === 'losing')      { score -= 30; reasons.push('Losing wallet — no edge to extract (-30)'); }
  if (arch.archetype === 'noise')       { score -= 25; reasons.push('No discernible strategy (-25)'); }

  if (metrics.tradeCount > 2000) { score += 15; reasons.push(`${metrics.tradeCount} trades — high statistical power (+15)`); }
  else if (metrics.tradeCount > 500) { score += 8; reasons.push(`${metrics.tradeCount} trades — sufficient for clustering (+8)`); }

  if (metrics.totalPnl > 10000) { score += 15; reasons.push(`Highly profitable ($${Math.round(metrics.totalPnl).toLocaleString()}) — edge is real (+15)`); }
  else if (metrics.totalPnl > 500) { score += 8; reasons.push(`Profitable ($${Math.round(metrics.totalPnl).toLocaleString()}) (+8)`); }
  else if (metrics.totalPnl < 0) { score -= 20; reasons.push(`Unprofitable — no edge to reverse-engineer (-20)`); }

  if (metrics.sharpeDaily > 1.0 && metrics.dailySamples >= 5) {
    score += 10;
    reasons.push(`High daily Sharpe (${metrics.sharpeDaily.toFixed(2)}) — consistent strategy (+10)`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 65 ? 'high' : score >= 40 ? 'medium' : 'low';
  return { score, verdict, reasons };
}

// ─── UI component ───

const S = {
  root: {
    background: C.bg0,
    border: `1px solid ${C.border}`,
    borderLeft: `3px solid ${C.green}`,
    padding: '14px 20px',
    marginBottom: 12,
    fontFamily: 'inherit',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  pill: {
    display: 'inline-block',
    padding: '3px 10px',
    border: `1px solid ${C.borderG}`,
    background: C.bg1,
    color: C.green,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontWeight: 'bold',
  },
  archetypeLabel: {
    fontSize: 14,
    color: C.light,
    letterSpacing: 1,
  },
  archetypeName: {
    color: C.green,
    fontWeight: 'bold',
    fontSize: 14,
    marginLeft: 4,
  },
  scoreRow: {
    display: 'flex',
    gap: 24,
    flexWrap: 'wrap',
    marginTop: 8,
  },
  scoreBlock: {
    flex: '1 1 280px',
    minWidth: 260,
    padding: '10px 12px',
    background: C.bg1,
    border: `1px solid ${C.border}`,
  },
  scoreTitle: {
    fontSize: 10,
    letterSpacing: 1.5,
    color: C.muted,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  scoreValue: {
    fontSize: 22,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  verdict: {
    fontSize: 11,
    marginLeft: 8,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontWeight: 'bold',
  },
  reasonList: {
    listStyle: 'none',
    padding: 0,
    margin: '6px 0 0 0',
    fontSize: 11,
    color: C.light,
    lineHeight: 1.55,
  },
  reason: {
    marginBottom: 2,
  },
  metricsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: 8,
    marginTop: 10,
  },
  metricCell: {
    padding: '4px 0',
  },
  metricLabel: {
    fontSize: 9,
    color: C.muted,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  metricValue: {
    fontSize: 13,
    color: C.light,
    fontFamily: 'monospace',
  },
  hint: {
    marginTop: 8,
    fontSize: 10,
    color: C.muted,
    fontStyle: 'italic',
  },
};

function scoreColor(score) {
  if (score >= 65) return C.green;
  if (score >= 40) return C.gold;
  return C.red;
}

function verdictLabel(archetype, copy, reveng) {
  if (archetype === 'insufficient') return null;
  if (copy.verdict === 'copy')    return { text: 'POLYGUN CANDIDATE', color: C.green };
  if (reveng.verdict === 'high')  return { text: 'POLYSIGNAL TARGET', color: C.gold };
  if (copy.verdict === 'avoid' && reveng.verdict !== 'high') return { text: 'IGNORE', color: C.red };
  return { text: 'REVIEW', color: C.muted };
}

export default function WalletAnalyzer({ trades, backtest }) {
  const metrics  = useMemo(() => computeMetrics(trades || []), [trades]);
  const arch     = useMemo(() => classifyArchetype(metrics), [metrics]);
  const copy     = useMemo(() => scoreCopyability(metrics, arch, backtest), [metrics, arch, backtest]);
  const reveng   = useMemo(() => scoreReverseEngineer(metrics, arch), [metrics, arch]);
  const flag     = verdictLabel(arch.archetype, copy, reveng);

  if (!trades || trades.length === 0) {
    return (
      <div style={S.root}>
        <div style={{ color: C.muted, fontSize: 12 }}>
          <span style={{ color: C.green, letterSpacing: 1.5 }}>ANALYZER</span>{' '}
          — fetch a wallet to classify archetype.
        </div>
      </div>
    );
  }

  if (arch.archetype === 'insufficient') {
    return (
      <div style={S.root}>
        <div style={{ color: C.muted, fontSize: 12 }}>
          <span style={{ color: C.gold, letterSpacing: 1.5 }}>ANALYZER — INSUFFICIENT DATA</span>
        </div>
        <ul style={S.reasonList}>
          {arch.reasons.map((r, i) => <li key={i} style={S.reason}>› {r}</li>)}
        </ul>
      </div>
    );
  }

  return (
    <div style={S.root}>
      <div style={S.header}>
        <span style={S.pill}>ANALYZER</span>
        <span style={S.archetypeLabel}>
          ARCHETYPE:<span style={S.archetypeName}>{arch.label.toUpperCase()}</span>
        </span>
        {flag && (
          <span style={{ ...S.pill, borderColor: flag.color, color: flag.color, background: 'transparent' }}>
            {flag.text}
          </span>
        )}
      </div>

      <div style={S.scoreRow}>
        <div style={S.scoreBlock}>
          <div style={S.scoreTitle}>Polygun Copyability</div>
          <div>
            <span style={{ ...S.scoreValue, color: scoreColor(copy.score) }}>{copy.score}</span>
            <span style={{ color: C.muted, fontSize: 13 }}>/100</span>
            <span style={{ ...S.verdict, color: scoreColor(copy.score) }}>
              {copy.verdict === 'copy' ? 'COPY' : copy.verdict === 'caution' ? 'CAUTION' : 'AVOID'}
            </span>
          </div>
          <ul style={S.reasonList}>
            {copy.reasons.slice(0, 4).map((r, i) => <li key={i} style={S.reason}>› {r}</li>)}
          </ul>
        </div>

        <div style={S.scoreBlock}>
          <div style={S.scoreTitle}>PolySignal Reverse-Engineer</div>
          <div>
            <span style={{ ...S.scoreValue, color: scoreColor(reveng.score) }}>{reveng.score}</span>
            <span style={{ color: C.muted, fontSize: 13 }}>/100</span>
            <span style={{ ...S.verdict, color: scoreColor(reveng.score) }}>
              {reveng.verdict === 'high' ? 'HIGH' : reveng.verdict === 'medium' ? 'MEDIUM' : 'LOW'}
            </span>
          </div>
          <ul style={S.reasonList}>
            {reveng.reasons.slice(0, 4).map((r, i) => <li key={i} style={S.reason}>› {r}</li>)}
          </ul>
        </div>
      </div>

      <div style={S.metricsGrid}>
        <Metric label="Trades" value={metrics.tradeCount.toLocaleString()} />
        <Metric label="Days Active" value={metrics.daysActive.toFixed(1)} />
        <Metric label="Trades/Window" value={metrics.tradesPerWindow.toFixed(1)} />
        <Metric label="Multi-Entry %" value={`${(metrics.multiEntryPct*100).toFixed(0)}%`} />
        <Metric label="Pos Size CV" value={metrics.positionCV.toFixed(2)} />
        <Metric label="Win Rate" value={metrics.winRate != null ? `${(metrics.winRate*100).toFixed(1)}%` : '—'} />
        <Metric label="Asym Ratio" value={metrics.asymRatio ? `${metrics.asymRatio.toFixed(2)}x` : '—'} />
        <Metric label="Daily Sharpe" value={metrics.sharpeDaily ? metrics.sharpeDaily.toFixed(2) : '—'} />
        <Metric label="Avg Position" value={`$${metrics.positionMean.toFixed(2)}`} />
        <Metric label="Total PnL" value={`$${Math.round(metrics.totalPnl).toLocaleString()}`} />
      </div>

      <div style={S.hint}>
        Confidence: {Math.round(arch.confidence * 100)}% · reasoning based on aggregated closed positions.
        {backtest && Number.isFinite(backtest.roi) ? '' : ' (Run a backtest for ROI-adjusted copyability.)'}
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div style={S.metricCell}>
      <div style={S.metricLabel}>{label}</div>
      <div style={S.metricValue}>{value}</div>
    </div>
  );
}