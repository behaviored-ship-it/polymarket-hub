// src/wallet-analyzer.jsx
//
// Wallet Analyzer — archetype classifier + verdict banner for Polymarket Hub.
//
// Consumes the existing `trades` state from polymarket-hub.jsx and produces:
//   1. Archetype label (MM / Scalper-MM / Directional / News-Event / Insufficient Data)
//   2. Polygun Copyability Score (0-100) with reasoning
//   3. PolySignal Reverse-Engineer Score (0-100) with reasoning
//   4. Key discriminating metrics (WR, PnL-per-trade asymmetry, both-sides %, position size CV)
//
// Pure classifier logic is exported separately so it can be unit-tested or reused
// in a backend worker later without carrying React along.
//
// Trade shape expected (matches Polymarket closed-positions / fills pattern):
//   { id, conditionId, eventSlug, side ("Up"|"Down"|outcome str), size,
//     avgPrice or price, pnl (for closed), ts (epoch sec), ... }
//
// The component is defensive — missing fields fall back gracefully; low sample
// sizes render as "Insufficient Data" rather than a confident wrong answer.

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

// ─── Thresholds (tune based on real data) ───
const MIN_TRADES_FOR_CONFIDENT = 300;
const MIN_DAYS_ACTIVE          = 3;

const WR_FLAT_EPSILON      = 0.015;   // WR within ±1.5% across time blocks = "flat"
const BOTH_SIDES_MM        = 0.80;    // >80% of windows had both Up and Down → MM-ish
const POSITION_CV_BOT      = 0.40;    // position size coefficient of variation; <0.40 = uniform = bot
const ASYM_RATIO_MM_SKEW   = 1.8;     // avg win $ / avg loss $; >1.8 = asymmetric payoff edge
const BUY_ONLY_THRESHOLD   = 0.95;    // >95% BUY orders with 0 SELLs = no-exit archetype

// ─── Pure helpers ───

/** Extract window key from a trade. eventSlug like "btc-updown-5m-2026-04-21-1025" */
function windowKeyOf(t) {
  return t.eventSlug || t.conditionId || 'unknown';
}

function sideOf(t) {
  // normalize — polymarket uses "Up"/"Down" as outcome, BUY/SELL as side
  return (t.outcome || t.side || '').toString();
}

function priceOf(t) {
  return Number(t.avgPrice ?? t.price ?? 0);
}

function sizeOf(t) {
  return Number(t.size ?? t.shares ?? 0);
}

function dollarValueOf(t) {
  return sizeOf(t) * priceOf(t);
}

function isBuy(t) {
  const s = (t.action || t.txType || t.side || '').toString().toUpperCase();
  return s.includes('BUY') || s === '';  // default to BUY if field missing (Polymarket closed positions are buys)
}

function isSell(t) {
  const s = (t.action || t.txType || t.side || '').toString().toUpperCase();
  return s.includes('SELL');
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

/**
 * Compute the features that discriminate archetypes.
 * Returns null if insufficient data.
 */
export function computeMetrics(trades) {
  if (!trades || trades.length < 20) return null;

  // Dollar sizes for uniformity detection
  const dollars = trades.map(dollarValueOf).filter(v => v > 0);
  const posMean = mean(dollars);
  const posStdev = stdev(dollars);
  const posCV = posMean > 0 ? posStdev / posMean : 0;

  // BUY/SELL breakdown
  const buys = trades.filter(isBuy).length;
  const sells = trades.filter(isSell).length;
  const buyRatio = trades.length > 0 ? buys / trades.length : 0;

  // Windows: group by eventSlug, track if both Up and Down appear
  const windows = {};
  for (const t of trades) {
    const k = windowKeyOf(t);
    const s = sideOf(t);
    if (!windows[k]) windows[k] = { up: 0, down: 0 };
    if (s === 'Up')   windows[k].up++;
    if (s === 'Down') windows[k].down++;
  }
  const winKeys = Object.keys(windows);
  const bothSidesCount = winKeys.filter(k => windows[k].up > 0 && windows[k].down > 0).length;
  const bothSidesPct = winKeys.length > 0 ? bothSidesCount / winKeys.length : 0;

  // PnL stats (for closed positions with .pnl present)
  const pnls = trades.map(t => Number(t.pnl ?? 0)).filter(v => Number.isFinite(v));
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const totalPnl = pnls.reduce((a,b)=>a+b, 0);
  const winRate = (wins.length + losses.length) > 0
    ? wins.length / (wins.length + losses.length)
    : null;

  const avgWin  = wins.length   ? mean(wins)                  : 0;
  const avgLoss = losses.length ? Math.abs(mean(losses))      : 0;
  const asymRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

  // Time span / activity
  const timestamps = trades.map(t => Number(t.ts ?? t.timestamp ?? 0)).filter(Boolean);
  const daysActive = timestamps.length >= 2
    ? (Math.max(...timestamps) - Math.min(...timestamps)) / 86400
    : 0;
  const tradesPerWindow = winKeys.length > 0 ? trades.length / winKeys.length : 0;

  // Equity curve smoothness (low stdev of daily PnL relative to mean = smooth)
  const byDay = {};
  for (const t of trades) {
    const ts = Number(t.ts ?? t.timestamp ?? 0);
    if (!ts) continue;
    const day = Math.floor(ts / 86400);
    byDay[day] = (byDay[day] || 0) + Number(t.pnl ?? 0);
  }
  const dailyPnls = Object.values(byDay);
  const dailyMean = mean(dailyPnls);
  const dailyStd = stdev(dailyPnls);
  // Sharpe-like (daily); positive and high = smooth upward grind
  const sharpeDaily = dailyStd > 0 ? dailyMean / dailyStd : 0;

  return {
    tradeCount: trades.length,
    windowCount: winKeys.length,
    daysActive,
    tradesPerWindow,
    buyCount: buys,
    sellCount: sells,
    buyRatio,
    bothSidesPct,
    positionMean: posMean,
    positionStdev: posStdev,
    positionCV: posCV,
    winRate,
    winCount: wins.length,
    lossCount: losses.length,
    totalPnl,
    avgWin,
    avgLoss,
    asymRatio,
    sharpeDaily,
    dailySamples: dailyPnls.length,
  };
}

// ─── Archetype classifier ───

/**
 * Classify a wallet into one of:
 *   'insufficient' — not enough data
 *   'mm'           — true market maker (both sides, uniform, equal BUY/SELL)
 *   'mm_skew'      — scalper / MM-skew (both sides, uniform, no SELLs; wins by $-skew)
 *   'directional'  — single-side entries, selective
 *   'news'         — sporadic large trades around catalysts (fallback)
 *   'noise'        — random, no apparent edge
 */
export function classifyArchetype(metrics) {
  if (!metrics || metrics.tradeCount < MIN_TRADES_FOR_CONFIDENT || metrics.daysActive < MIN_DAYS_ACTIVE) {
    return {
      archetype: 'insufficient',
      label: 'Insufficient Data',
      confidence: 0,
      reasons: [
        !metrics ? 'No trades loaded' : null,
        metrics && metrics.tradeCount < MIN_TRADES_FOR_CONFIDENT ? `Only ${metrics?.tradeCount ?? 0} trades (need ${MIN_TRADES_FOR_CONFIDENT}+)` : null,
        metrics && metrics.daysActive < MIN_DAYS_ACTIVE ? `Only ${metrics?.daysActive.toFixed(1) ?? 0} days active (need ${MIN_DAYS_ACTIVE}+)` : null,
      ].filter(Boolean),
    };
  }

  const m = metrics;
  const reasons = [];

  // True MM — two-sided + SELLs ≈ BUYs
  const buySellBalance = Math.abs(m.buyRatio - 0.5) < 0.10;
  const uniformSize = m.positionCV < POSITION_CV_BOT;
  const twoSided = m.bothSidesPct > BOTH_SIDES_MM;

  if (twoSided && buySellBalance && uniformSize) {
    reasons.push(`${(m.bothSidesPct*100).toFixed(0)}% of windows had both Up and Down`);
    reasons.push(`BUY/SELL ratio near 50/50 (${(m.buyRatio*100).toFixed(0)}% BUY)`);
    reasons.push(`Position size CV = ${m.positionCV.toFixed(2)} (uniform → automated)`);
    return { archetype: 'mm', label: 'Market Maker', confidence: 0.9, reasons };
  }

  // MM-skew / late-window scalper — both sides, but BUY-heavy or BUY-only
  const buyHeavy = m.buyRatio > BUY_ONLY_THRESHOLD;
  if (twoSided && buyHeavy && uniformSize) {
    reasons.push(`${(m.bothSidesPct*100).toFixed(0)}% of windows had both Up and Down (two-sided)`);
    reasons.push(`${(m.buyRatio*100).toFixed(0)}% BUY orders (no exits — hold to resolution)`);
    reasons.push(`Position size CV = ${m.positionCV.toFixed(2)} (uniform sizing → bot)`);
    if (m.asymRatio >= ASYM_RATIO_MM_SKEW) {
      reasons.push(`Avg win / avg loss = ${m.asymRatio.toFixed(2)}x (asymmetric $-edge)`);
    }
    if (m.winRate != null && Math.abs(m.winRate - 0.5) < WR_FLAT_EPSILON) {
      reasons.push(`WR = ${(m.winRate*100).toFixed(1)}% — not directional; edge is $-per-trade skew`);
    }
    return { archetype: 'mm_skew', label: 'Scalper / MM-Skew', confidence: 0.9, reasons };
  }

  // Directional — rarely trades both sides, varied or uniform sizing, BUY-heavy
  if (m.bothSidesPct < 0.20) {
    reasons.push(`Only ${(m.bothSidesPct*100).toFixed(0)}% of windows had both sides (one-directional)`);
    reasons.push(`${m.tradesPerWindow.toFixed(1)} trades/window avg`);
    if (m.winRate != null) reasons.push(`WR = ${(m.winRate*100).toFixed(1)}%`);
    if (m.sharpeDaily > 0.5) reasons.push(`Smooth upward equity (daily Sharpe ${m.sharpeDaily.toFixed(2)})`);
    const strong = m.winRate != null && m.winRate > 0.55 && m.totalPnl > 0;
    return {
      archetype: 'directional',
      label: strong ? 'Directional Alpha' : 'Directional (weak edge)',
      confidence: strong ? 0.85 : 0.6,
      reasons,
    };
  }

  // Fallback — ambiguous / noise
  reasons.push(`${m.tradeCount} trades, ${(m.bothSidesPct*100).toFixed(0)}% both-sides, ${(m.buyRatio*100).toFixed(0)}% BUY`);
  if (m.winRate != null) reasons.push(`WR = ${(m.winRate*100).toFixed(1)}%, PnL $${m.totalPnl.toFixed(0)}`);
  return { archetype: 'noise', label: 'Mixed / Unclassified', confidence: 0.5, reasons };
}

// ─── Copyability & Reverse-Engineer scores ───

/**
 * Polygun copyability score (0-100). How well does same-block taker-copy
 * preserve this wallet's edge?
 *
 * Inputs: metrics + archetype + optional backtest result.
 * Backtest result (if present): { roi, endBalance, startBalance, skipped, tradesUsed }
 */
export function scoreCopyability(metrics, arch, backtest) {
  if (!metrics || !arch || arch.archetype === 'insufficient') {
    return { score: 0, verdict: 'unknown', reasons: ['Insufficient data'] };
  }
  let score = 50;
  const reasons = [];

  // Archetype baseline
  if (arch.archetype === 'mm')          { score -= 40; reasons.push('Market makers earn the spread; taker copy pays it (-40)'); }
  if (arch.archetype === 'mm_skew')     { score -= 35; reasons.push('MM-skew edge requires cheap maker fills; taker copy destroys it (-35)'); }
  if (arch.archetype === 'directional') { score += 25; reasons.push('Directional entries are copyable same-block (+25)'); }
  if (arch.archetype === 'noise')       { score -= 20; reasons.push('No clear edge to copy (-20)'); }

  // Backtest is the ground truth if available
  if (backtest && Number.isFinite(backtest.roi)) {
    if (backtest.roi <= -0.5) { score -= 30; reasons.push(`Backtest ROI ${(backtest.roi*100).toFixed(0)}% — copy wipes out (-30)`); }
    else if (backtest.roi <= -0.1) { score -= 15; reasons.push(`Backtest ROI ${(backtest.roi*100).toFixed(0)}% — copy loses money (-15)`); }
    else if (backtest.roi >= 0.20) { score += 20; reasons.push(`Backtest ROI +${(backtest.roi*100).toFixed(0)}% — copy holds edge (+20)`); }
    else if (backtest.roi >= 0.05) { score += 10; reasons.push(`Backtest ROI +${(backtest.roi*100).toFixed(0)}% — copy profitable (+10)`); }
  }

  // Sample size / days active boost
  if (metrics.tradeCount > 1000 && metrics.daysActive > 14) {
    score += 5; reasons.push(`${metrics.tradeCount} trades / ${metrics.daysActive.toFixed(0)}d — statistically meaningful (+5)`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 65 ? 'copy' : score >= 40 ? 'caution' : 'avoid';
  return { score, verdict, reasons };
}

/**
 * PolySignal reverse-engineer score (0-100). How useful is this wallet as a
 * feature-extraction target for the bot's signal layer?
 */
export function scoreReverseEngineer(metrics, arch) {
  if (!metrics || !arch || arch.archetype === 'insufficient') {
    return { score: 0, verdict: 'unknown', reasons: ['Insufficient data'] };
  }
  let score = 40;
  const reasons = [];

  // Archetype baseline — MM-skew is gold for rule extraction
  if (arch.archetype === 'mm_skew')     { score += 35; reasons.push('MM-skew edge is rule-based and feature-extractable (+35)'); }
  if (arch.archetype === 'directional') { score += 25; reasons.push('Directional decisions map to observable features (+25)'); }
  if (arch.archetype === 'mm')          { score -= 15; reasons.push('True MM edge is structural (spread/rebates), not predictive (-15)'); }
  if (arch.archetype === 'noise')       { score -= 30; reasons.push('No discernible strategy to extract (-30)'); }

  // Volume boost — more trades = more statistical power for clustering
  if (metrics.tradeCount > 2000) { score += 15; reasons.push(`${metrics.tradeCount} trades — high statistical power (+15)`); }
  else if (metrics.tradeCount > 500) { score += 8; reasons.push(`${metrics.tradeCount} trades — sufficient for clustering (+8)`); }

  // Profitability — strategies that lose money aren't worth extracting
  if (metrics.totalPnl > 1000) { score += 10; reasons.push(`Profitable wallet ($${metrics.totalPnl.toFixed(0)}) — edge is real (+10)`); }
  else if (metrics.totalPnl < 0) { score -= 20; reasons.push(`Losing wallet — no edge to reverse-engineer (-20)`); }

  // Smooth equity = consistent strategy = extractable
  if (metrics.sharpeDaily > 1.0 && metrics.dailySamples >= 5) {
    score += 10; reasons.push(`High daily Sharpe (${metrics.sharpeDaily.toFixed(2)}) — consistent strategy (+10)`);
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

function scoreColor(score, inverted = false) {
  // For copyability: high=good=green. For reverse-engineer: high=good=green.
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

/**
 * Main component — drop this anywhere in polymarket-hub.jsx, ideally right
 * after the HISTORY/status banner and before the tab nav, so the verdict is
 * the first thing visible after fetch.
 *
 * Props:
 *   trades   — array of loaded trades (from existing state)
 *   backtest — optional { roi, endBalance, startBalance } from current Backtest state.
 *              Pass whatever you currently have; nulls are fine.
 */
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
        <Metric label="Both-Sides %" value={`${(metrics.bothSidesPct*100).toFixed(0)}%`} />
        <Metric label="BUY Ratio" value={`${(metrics.buyRatio*100).toFixed(0)}%`} />
        <Metric label="Pos Size CV" value={metrics.positionCV.toFixed(2)} />
        <Metric label="Win Rate" value={metrics.winRate != null ? `${(metrics.winRate*100).toFixed(1)}%` : '—'} />
        <Metric label="Asym Ratio" value={metrics.asymRatio ? `${metrics.asymRatio.toFixed(2)}x` : '—'} />
        <Metric label="Daily Sharpe" value={metrics.sharpeDaily ? metrics.sharpeDaily.toFixed(2) : '—'} />
        <Metric label="Total PnL" value={`$${metrics.totalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
      </div>

      {arch.archetype !== 'insufficient' && (
        <div style={S.hint}>
          Confidence: {Math.round(arch.confidence * 100)}% · reasoning based on trade patterns, not market outcomes.
          {backtest && Number.isFinite(backtest.roi) ? '' : ' (Run a backtest for copyability to incorporate ROI.)'}
        </div>
      )}
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