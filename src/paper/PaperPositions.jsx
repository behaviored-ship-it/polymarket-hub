import { useEffect, useMemo, useState } from 'react';
import { fetchOpenPositions } from './api.js';

const colors = {
  panel: '#0d0d1f', border: '#1e2040',
  green: '#00ff9d', red: '#ff4d6d', amber: '#f0c040',
  dim: '#7080a0', label: '#c0cce0', text: '#fff',
};
const LIVE_PRICE_INTERVAL_MS = 30_000;

const fmtUsd = (n) => n == null ? '—' : n === 0 ? '$0.00' : `${n > 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
const fmtUsdPlain = (n) => n == null ? '—' : `$${n.toFixed(2)}`;
const fmtPrice = (n) => n == null ? '—' : n.toFixed(3);
const fmtShares = (n) => n == null ? '—' : n.toFixed(2);
const colorFor = (n) => n == null ? colors.dim : n > 0 ? colors.green : n < 0 ? colors.red : colors.dim;

function relTime(unixSec) {
  if (!unixSec) return '—';
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function FilterPill({ label, count, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: active ? '#001f10' : '#0d0d1f',
      border: `1px solid ${active ? colors.green : '#252845'}`,
      color: active ? colors.green : '#b0bcd0',
      fontFamily: "'JetBrains Mono',monospace",
      fontSize: 11, letterSpacing: 1, padding: '6px 12px',
      cursor: 'pointer', borderRadius: 3, display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>
      {label}
      <span style={{ color: active ? colors.green : colors.dim, fontSize: 10 }}>{count}</span>
    </button>
  );
}

function Row({ children }) {
  return (
    <tr style={{ borderBottom: '1px solid #131330' }}>{children}</tr>
  );
}
function Cell({ children, color, align = 'left', minWidth }) {
  return (
    <td style={{
      padding: '8px 10px', fontSize: 12,
      color: color || colors.text, textAlign: align, minWidth,
      fontVariantNumeric: 'tabular-nums',
    }}>{children}</td>
  );
}
function HeadCell({ children, align = 'left' }) {
  return (
    <th style={{
      padding: '8px 10px', fontSize: 10, letterSpacing: 1.5,
      color: colors.dim, textAlign: align, fontWeight: 'normal',
      textTransform: 'uppercase', borderBottom: `1px solid ${colors.border}`,
    }}>{children}</th>
  );
}

function OutcomeBadge({ outcome }) {
  const isYes = String(outcome).toLowerCase() === 'yes';
  const color = isYes ? colors.green : colors.red;
  return (
    <span style={{
      background: isYes ? '#001f10' : '#200008', border: `1px solid ${color}`, color,
      fontSize: 9, letterSpacing: 1, padding: '2px 6px', borderRadius: 2, fontWeight: 'bold',
    }}>{String(outcome).toUpperCase()}</span>
  );
}

function ResultBadge({ price }) {
  if (price == null) return null;
  const won = price >= 0.99;
  const color = won ? colors.green : colors.red;
  return (
    <span style={{
      background: won ? '#001f10' : '#200008', border: `1px solid ${color}`, color,
      fontSize: 9, letterSpacing: 1, padding: '2px 6px', borderRadius: 2, fontWeight: 'bold',
    }}>{won ? 'WIN' : 'LOSS'}</span>
  );
}

// ── Live prices: poll /api/positions for the leader's wallet ─────────────────
function useLivePrices(registry, enabled) {
  const [prices, setPrices] = useState({}); // conditionId+outcome → curPrice
  const [stamp, setStamp] = useState(null);

  useEffect(() => {
    if (!enabled || !registry?.walletAddr) return;
    let active = true;
    const tick = async () => {
      try {
        const data = await fetchOpenPositions(registry.walletAddr);
        if (!active || !Array.isArray(data)) return;
        const next = {};
        for (const p of data) {
          if (!p.conditionId) continue;
          const key = `${p.conditionId}_${String(p.outcome ?? '').toLowerCase()}`;
          next[key] = parseFloat(p.curPrice);
        }
        setPrices(next);
        setStamp(Date.now());
      } catch (_) { /* swallow — UI shows last known */ }
    };
    tick();
    const id = setInterval(tick, LIVE_PRICE_INTERVAL_MS);
    return () => { active = false; clearInterval(id); };
  }, [enabled, registry?.walletAddr]);

  return { prices, stamp };
}

export default function PaperPositions({ registry, positions: allPositions }) {
  const [filter, setFilter] = useState('all'); // all | open | closed | resolved
  const [sort, setSort] = useState('recent');
  const [search, setSearch] = useState('');
  const [livePrices, setLivePrices] = useState(false);

  const counts = useMemo(() => {
    const open = allPositions.filter((p) => !p.isResolved).length;
    const resolved = allPositions.filter((p) => p.isResolved).length;
    // "Closed" doesn't really exist for paper trading (no manual close in MVP),
    // but we keep the pill to match the GodEye spec — counts manual closes
    // when sells are added in v1.1.
    const closed = 0;
    return { all: allPositions.length, open, closed, resolved };
  }, [allPositions]);

  const live = useLivePrices(registry, livePrices);

  const visible = useMemo(() => {
    let list = allPositions.slice();
    if (filter === 'open') list = list.filter((p) => !p.isResolved);
    else if (filter === 'resolved') list = list.filter((p) => p.isResolved);
    else if (filter === 'closed') list = []; // see counts comment above

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((p) => (p.title || '').toLowerCase().includes(q));
    }

    if (sort === 'recent') {
      list.sort((a, b) => (b.resolvedAt ?? b.id?.length ?? 0) - (a.resolvedAt ?? a.id?.length ?? 0));
    } else if (sort === 'pnl') {
      list.sort((a, b) => (b.realizedPnl ?? 0) - (a.realizedPnl ?? 0));
    } else if (sort === 'alpha') {
      list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }
    return list;
  }, [allPositions, filter, sort, search]);

  return (
    <div>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <FilterPill label="All" count={counts.all} active={filter === 'all'} onClick={() => setFilter('all')} />
        <FilterPill label="Open" count={counts.open} active={filter === 'open'} onClick={() => setFilter('open')} />
        <FilterPill label="Closed" count={counts.closed} active={filter === 'closed'} onClick={() => setFilter('closed')} />
        <FilterPill label="Resolved" count={counts.resolved} active={filter === 'resolved'} onClick={() => setFilter('resolved')} />

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search markets…"
            style={{
              background: '#0a0a1a', border: `1px solid ${colors.border}`, color: colors.text,
              fontFamily: "'JetBrains Mono',monospace", fontSize: 12, padding: '6px 10px',
              borderRadius: 2, outline: 'none', width: 180,
            }}
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            style={{
              background: '#0a0a1a', border: `1px solid ${colors.border}`, color: colors.text,
              fontFamily: "'JetBrains Mono',monospace", fontSize: 12, padding: '6px 8px',
              borderRadius: 2, outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="recent">Recent</option>
            <option value="pnl">P&L</option>
            <option value="alpha">Alphabetical</option>
          </select>
          <span style={{ fontSize: 11, color: colors.dim, letterSpacing: 1 }}>
            {visible.length} positions
          </span>
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: colors.label,
            cursor: 'pointer', letterSpacing: 1, padding: '6px 10px', borderRadius: 3,
            border: `1px solid ${livePrices ? colors.green : '#252845'}`,
            background: livePrices ? '#001f10' : '#0d0d1f',
          }}>
            <input type="checkbox" checked={livePrices} onChange={(e) => setLivePrices(e.target.checked)}
                   style={{ accentColor: colors.green, cursor: 'pointer' }} />
            <span style={{ color: livePrices ? colors.green : colors.label }}>
              ◉ LIVE PRICES{live.stamp ? ` · ${relTime(Math.floor(live.stamp / 1000))}` : ''}
            </span>
          </label>
        </div>
      </div>

      {/* Table */}
      {visible.length === 0 ? (
        <div style={{
          background: colors.panel, border: `1px dashed ${colors.border}`,
          padding: '60px 20px', textAlign: 'center', borderRadius: 3,
        }}>
          <div style={{ fontSize: 36, opacity: 0.4, marginBottom: 10 }}>⬡</div>
          <div style={{ fontSize: 12, color: colors.dim, letterSpacing: 1.5, textTransform: 'uppercase' }}>
            No positions found · No positions match this filter
          </div>
        </div>
      ) : (
        <div style={{ background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 2, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'JetBrains Mono',monospace" }}>
            <thead>
              <Row>
                <HeadCell>Market</HeadCell>
                <HeadCell>Outcome</HeadCell>
                <HeadCell align="right">Entry</HeadCell>
                <HeadCell align="right">Current / Exit</HeadCell>
                <HeadCell align="right">P&L</HeadCell>
                <HeadCell align="right">Shares</HeadCell>
                <HeadCell align="right">Stake</HeadCell>
                <HeadCell align="right">When</HeadCell>
                <HeadCell align="center">Status</HeadCell>
              </Row>
            </thead>
            <tbody>
              {visible.map((p) => {
                const key = `${p.conditionId}_${String(p.outcome ?? '').toLowerCase()}`;
                const cur = p.isResolved ? p.resolvedPrice
                          : (live.prices[key] ?? p.curPrice ?? null);
                const pnl = p.isResolved
                  ? p.realizedPnl
                  : (cur != null ? (cur - p.avgEntryPrice) * p.shares : null);
                const when = p.isResolved
                  ? `resolved ${relTime(p.resolvedAt)}`
                  : `opened ${relTime(parseInt(String(p.id).split('_').pop()) || null)}`;
                return (
                  <Row key={p.id}>
                    <Cell minWidth={220}>
                      <span style={{ display: 'block', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.title}>
                        {p.title || p.conditionId}
                      </span>
                    </Cell>
                    <Cell><OutcomeBadge outcome={p.outcome} /></Cell>
                    <Cell align="right">{fmtPrice(p.avgEntryPrice)}</Cell>
                    <Cell align="right" color={p.isResolved ? colorFor(pnl) : colors.text}>
                      {fmtPrice(cur)}
                    </Cell>
                    <Cell align="right" color={colorFor(pnl)}>{fmtUsd(pnl)}</Cell>
                    <Cell align="right">{fmtShares(p.shares)}</Cell>
                    <Cell align="right">{fmtUsdPlain(p.totalCost)}</Cell>
                    <Cell align="right" color={colors.dim}>{when}</Cell>
                    <Cell align="center">
                      {p.isResolved ? <ResultBadge price={p.resolvedPrice} /> : (
                        <span style={{
                          background: '#001f10', border: `1px solid ${colors.green}`, color: colors.green,
                          fontSize: 9, letterSpacing: 1, padding: '2px 6px', borderRadius: 2, fontWeight: 'bold',
                        }}>OPEN</span>
                      )}
                    </Cell>
                  </Row>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
