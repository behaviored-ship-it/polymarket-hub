import { useMemo, useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { recentEvents, subscribe as subscribeEvents } from './eventLog.js';
import { useVsActual } from './useVsActual.js';

const colors = {
  panel: '#0d0d1f', border: '#1e2040',
  green: '#00ff9d', red: '#ff4d6d', amber: '#f0c040',
  dim: '#7080a0', label: '#c0cce0', text: '#fff',
};

const fmtPct = (n) => n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
const fmtUsd = (n) => n == null ? '—' : n === 0 ? '$0.00' : `${n > 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
const fmtUsdPlain = (n) => n == null ? '—' : `$${n.toFixed(2)}`;
const colorFor = (n) => n == null ? colors.dim : n > 0 ? colors.green : n < 0 ? colors.red : colors.dim;

function StatCell({ label, value, color, sub }) {
  return (
    <div style={{ background: colors.panel, border: `1px solid ${colors.border}`, padding: '12px 14px', borderRadius: 2 }}>
      <div style={{ fontSize: 10, letterSpacing: 2, color: colors.dim, marginBottom: 5, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 'bold', color: color || colors.text, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: colors.dim, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function EquityChart({ equity }) {
  if (!equity || equity.length < 2) {
    return (
      <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.dim, fontSize: 12, letterSpacing: 1 }}>
        NO DATA YET — EQUITY CURVE APPEARS AFTER FIRST RESOLUTION
      </div>
    );
  }
  const start = equity[0]?.bal ?? 0;
  const end = equity[equity.length - 1]?.bal ?? 0;
  const lineColor = end >= start ? colors.green : colors.red;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={equity} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
        <XAxis dataKey="x" tick={{ fill: colors.dim, fontSize: 10 }} axisLine={{ stroke: colors.border }} tickLine={false} />
        <YAxis tick={{ fill: colors.dim, fontSize: 10 }} axisLine={{ stroke: colors.border }} tickLine={false}
               domain={['auto', 'auto']} width={50} />
        <ReferenceLine y={start} stroke={colors.dim} strokeDasharray="3 3" />
        <Tooltip
          contentStyle={{ background: colors.panel, border: `1px solid ${colors.border}`, fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}
          labelStyle={{ color: colors.dim }}
          formatter={(v) => [`$${v.toFixed(2)}`, 'BALANCE']}
        />
        <Line type="monotone" dataKey="bal" stroke={lineColor} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function CopyResultsFeed({ registryId }) {
  const [events, setEvents] = useState(() => recentEvents(50, (e) => e.registryId === registryId));
  useEffect(() => {
    setEvents(recentEvents(50, (e) => e.registryId === registryId));
    return subscribeEvents(() => setEvents(recentEvents(50, (e) => e.registryId === registryId)));
  }, [registryId]);

  if (events.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: colors.dim, fontSize: 12, letterSpacing: 1 }}>
        WAITING FOR EVENTS…
      </div>
    );
  }
  return (
    <div style={{ maxHeight: 200, overflowY: 'auto' }}>
      {events.map((e) => (
        <EventRow key={e.id} evt={e} />
      ))}
    </div>
  );
}

function EventRow({ evt }) {
  const kindColor = {
    BUY: colors.green, SKIP: colors.dim, WIN: colors.green,
    LOSS: colors.red, PAUSE: colors.amber, ERROR: colors.red,
  }[evt.kind] || colors.label;
  const time = new Date(evt.ts).toLocaleTimeString('en-US', { hour12: false });
  const detail = (() => {
    if (evt.kind === 'BUY') return `${(evt.title || '').slice(0, 50)} · $${(evt.stake ?? 0).toFixed(2)} @ ${(evt.entryPrice ?? 0).toFixed(3)}`;
    if (evt.kind === 'SKIP') return `${(evt.title || '').slice(0, 50)} · ${evt.reason}`;
    if (evt.kind === 'WIN' || evt.kind === 'LOSS') return `${(evt.title || '').slice(0, 50)} · ${fmtUsd(evt.pnl)}`;
    if (evt.kind === 'PAUSE') return `auto-paused: ${evt.reason}`;
    if (evt.kind === 'ERROR') return evt.message || '';
    return '';
  })();
  return (
    <div style={{ display: 'flex', gap: 10, padding: '5px 12px', fontSize: 11, borderBottom: '1px solid #131330' }}>
      <span style={{ color: colors.dim, minWidth: 60, fontVariantNumeric: 'tabular-nums' }}>{time}</span>
      <span style={{ color: kindColor, minWidth: 48, fontWeight: 'bold' }}>{evt.kind}</span>
      <span style={{ color: colors.label, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span>
    </div>
  );
}

function VsActualBanner({ registry, positions: ps, trades: ts }) {
  const v = useVsActual(registry, ps, ts);
  if (v.loading) return (
    <div style={bannerStyle()}>
      <span style={{ color: colors.dim, fontSize: 11, letterSpacing: 1 }}>LOADING VS ACTUAL…</span>
    </div>
  );
  if (v.error) return null;
  if (v.matched === 0) return (
    <div style={bannerStyle()}>
      <span style={{ color: colors.dim, fontSize: 11, letterSpacing: 1 }}>
        VS ACTUAL — waiting for resolved trades to compare
      </span>
    </div>
  );
  const fricColor = v.frictionUsd >= 0 ? colors.red : colors.green;
  return (
    <div style={bannerStyle()}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'baseline' }}>
        <div>
          <div style={{ fontSize: 9, letterSpacing: 2, color: colors.dim, textTransform: 'uppercase', marginBottom: 2 }}>WALLET MADE (same trades)</div>
          <div style={{ fontSize: 18, fontWeight: 'bold', color: colorFor(v.leaderRealOnOurTrades) }}>{fmtUsd(v.leaderRealOnOurTrades)}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, letterSpacing: 2, color: colors.dim, textTransform: 'uppercase', marginBottom: 2 }}>YOU WOULD HAVE MADE</div>
          <div style={{ fontSize: 18, fontWeight: 'bold', color: colorFor(v.paperRealOnSame) }}>{fmtUsd(v.paperRealOnSame)}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, letterSpacing: 2, color: colors.dim, textTransform: 'uppercase', marginBottom: 2 }}>COPY FRICTION</div>
          <div style={{ fontSize: 18, fontWeight: 'bold', color: fricColor }}>{fmtUsd(-v.frictionUsd)}</div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 10, color: colors.dim, letterSpacing: 1 }}>
          {v.matched} matched markets · avg slippage {v.avgSlippageBps == null ? '—' : `${v.avgSlippageBps.toFixed(1)} bps`}
          {' · '}fees {fmtUsdPlain(v.totalFees)}
        </div>
      </div>
    </div>
  );
}
function bannerStyle() {
  return {
    background: '#0a0f1a', border: `1px solid ${colors.border}`,
    borderLeft: `3px solid ${colors.amber}`,
    padding: '12px 16px', marginBottom: 12, borderRadius: 2,
  };
}

export default function PaperOverview({ registry, stats, positions: regPositions = [], trades: regTrades = [] }) {
  const skewColor = colorFor(stats.realizedPnl);
  const wrPct = stats.winRate;
  const wrColor = wrPct == null ? colors.dim : wrPct >= 60 ? colors.green : wrPct >= 50 ? colors.amber : colors.red;

  return (
    <div>
      <VsActualBanner registry={registry} positions={regPositions} trades={regTrades} />
      {/* ── Top row: Realized P&L + WR/ROI ──────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
        <div style={{ background: colors.panel, border: `1px solid ${colors.border}`, padding: '18px 20px', borderRadius: 2 }}>
          <div style={{ fontSize: 11, letterSpacing: 3, color: colors.dim, marginBottom: 6, textTransform: 'uppercase' }}>
            REALIZED P&L
          </div>
          <div style={{ fontSize: 36, fontWeight: 'bold', color: skewColor, lineHeight: 1, marginBottom: 14 }}>
            {fmtUsd(stats.realizedPnl)}
          </div>
          <EquityChart equity={stats.equity} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: colors.panel, border: `1px solid ${colors.border}`, padding: '18px 20px', borderRadius: 2, flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: 3, color: colors.dim, marginBottom: 6, textTransform: 'uppercase' }}>
              WIN RATE
            </div>
            <div style={{ fontSize: 28, fontWeight: 'bold', color: wrColor, lineHeight: 1 }}>
              {wrPct == null ? '—' : `${wrPct.toFixed(1)}%`}
            </div>
            <div style={{ fontSize: 12, color: colors.dim, marginTop: 6 }}>
              {stats.wins}W / {stats.losses}L · {stats.timeframe.toUpperCase()}
            </div>
          </div>
          <div style={{ background: colors.panel, border: `1px solid ${colors.border}`, padding: '18px 20px', borderRadius: 2, flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: 3, color: colors.dim, marginBottom: 6, textTransform: 'uppercase' }}>
              ROI
            </div>
            <div style={{ fontSize: 28, fontWeight: 'bold', color: colorFor(stats.roi), lineHeight: 1 }}>
              {fmtPct(stats.roi)}
            </div>
            <div style={{ fontSize: 12, color: colors.dim, marginTop: 6 }}>
              vs ${stats.startBalance.toFixed(0)} start
            </div>
          </div>
        </div>
      </div>

      {/* ── 8-stat grid ──────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
        <StatCell label="Volume" value={fmtUsdPlain(stats.volume)} />
        <StatCell label="Trades Copied" value={stats.tradesCopied} sub={`${stats.resolvedCount} resolved`} />
        <StatCell label="Best Trade" value={stats.bestTrade == null ? '—' : fmtUsd(stats.bestTrade)} color={colorFor(stats.bestTrade)} />
        <StatCell label="Worst Trade" value={stats.worstTrade == null ? '—' : fmtUsd(stats.worstTrade)} color={colorFor(stats.worstTrade)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
        <StatCell label="Profit Factor" value={stats.profitFactor == null ? '—' : stats.profitFactor.toFixed(2)} />
        <StatCell label="Avg Slippage" value={stats.avgSlippageBps == null ? '—' : `${stats.avgSlippageBps.toFixed(1)} bps`} />
        <StatCell label="Sharpe" value={stats.sharpe == null ? '—' : stats.sharpe.toFixed(2)} sub="annualized" />
        <StatCell label="Open Positions" value={stats.open} />
      </div>

      {/* ── Cumulative + Copy Results split ─────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ background: colors.panel, border: `1px solid ${colors.border}`, padding: '14px 16px', borderRadius: 2 }}>
          <div style={{ fontSize: 11, letterSpacing: 3, color: colors.dim, marginBottom: 10, textTransform: 'uppercase' }}>
            CUMULATIVE BALANCE
          </div>
          <EquityChart equity={stats.equity} />
          <div style={{ fontSize: 10, color: colors.dim, marginTop: 6, letterSpacing: 1 }}>
            Cash: {fmtUsdPlain(stats.cash)} · Total fees: {fmtUsdPlain(stats.totalFees)}
            {stats.avgPollDelayMs != null && ` · Avg poll delay: ${(stats.avgPollDelayMs / 1000).toFixed(1)}s`}
          </div>
        </div>
        <div style={{ background: colors.panel, border: `1px solid ${colors.border}`, padding: '14px 0 0', borderRadius: 2 }}>
          <div style={{ fontSize: 11, letterSpacing: 3, color: colors.dim, marginBottom: 8, textTransform: 'uppercase', padding: '0 16px' }}>
            COPY RESULTS
          </div>
          <CopyResultsFeed registryId={registry.id} />
        </div>
      </div>
    </div>
  );
}
