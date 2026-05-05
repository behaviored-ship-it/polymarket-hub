import { useMemo, useState } from 'react';

const colors = {
  panel: '#0d0d1f', border: '#1e2040',
  green: '#00ff9d', red: '#ff4d6d', amber: '#f0c040',
  dim: '#7080a0', label: '#c0cce0', text: '#fff',
};

const fmtUsd = (n) => n == null ? '—' : n === 0 ? '$0.00' : `${n > 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
const fmtPrice = (n) => n == null ? '—' : n.toFixed(3);
const colorFor = (n) => n == null ? colors.dim : n > 0 ? colors.green : n < 0 ? colors.red : colors.dim;

function fmtDateTime(unixSec) {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
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
      {count != null && <span style={{ color: active ? colors.green : colors.dim, fontSize: 10 }}>{count}</span>}
    </button>
  );
}

function ResultBadge({ trade }) {
  if (trade.status === 'skipped') {
    return (
      <span style={{
        background: '#1a1400', border: `1px solid ${colors.amber}`, color: colors.amber,
        fontSize: 9, letterSpacing: 1, padding: '2px 6px', borderRadius: 2, fontWeight: 'bold',
      }}>SKIP</span>
    );
  }
  if (trade.status === 'filled') {
    return (
      <span style={{
        background: '#001f10', border: `1px solid ${colors.green}`, color: colors.green,
        fontSize: 9, letterSpacing: 1, padding: '2px 6px', borderRadius: 2, fontWeight: 'bold',
      }}>OPEN</span>
    );
  }
  if (trade.status === 'resolved') {
    const won = trade.result === 'win';
    const c = won ? colors.green : colors.red;
    return (
      <span style={{
        background: won ? '#001f10' : '#200008', border: `1px solid ${c}`, color: c,
        fontSize: 9, letterSpacing: 1, padding: '2px 6px', borderRadius: 2, fontWeight: 'bold',
      }}>{won ? 'WIN' : 'LOSS'}</span>
    );
  }
  return null;
}

function OutcomeBadge({ outcome }) {
  const isYes = String(outcome).toLowerCase() === 'yes';
  const c = isYes ? colors.green : colors.red;
  return (
    <span style={{
      background: isYes ? '#001f10' : '#200008', border: `1px solid ${c}`, color: c,
      fontSize: 9, letterSpacing: 1, padding: '2px 6px', borderRadius: 2, fontWeight: 'bold',
    }}>{String(outcome).toUpperCase()}</span>
  );
}

function HeadCell({ children, align = 'left' }) {
  return (
    <th style={{
      padding: '8px 10px', fontSize: 10, letterSpacing: 1.5,
      color: colors.dim, textAlign: align, fontWeight: 'normal',
      textTransform: 'uppercase', borderBottom: `1px solid ${colors.border}`,
      position: 'sticky', top: 0, background: colors.panel, zIndex: 1,
    }}>{children}</th>
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

export default function PaperTradeLog({ trades }) {
  const [outcome, setOutcome] = useState('all'); // all | success | failed
  const [side, setSide] = useState('all');       // all | buy | sell

  const counts = useMemo(() => {
    const success = trades.filter((t) => t.status === 'filled' || t.status === 'resolved').length;
    const failed = trades.filter((t) => t.status === 'skipped').length;
    return { all: trades.length, success, failed };
  }, [trades]);

  const visible = useMemo(() => {
    let list = trades.slice();
    if (outcome === 'success') list = list.filter((t) => t.status === 'filled' || t.status === 'resolved');
    else if (outcome === 'failed') list = list.filter((t) => t.status === 'skipped');
    // side filter — MVP is buys-only so SELL pill always returns nothing,
    // but keep it for v1.1 parity with GodEye
    if (side === 'sell') list = [];
    list.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
    return list;
  }, [trades, outcome, side]);

  return (
    <div>
      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <FilterPill label="All" count={counts.all} active={outcome === 'all'} onClick={() => setOutcome('all')} />
        <FilterPill label="Success" count={counts.success} active={outcome === 'success'} onClick={() => setOutcome('success')} />
        <FilterPill label="Failed" count={counts.failed} active={outcome === 'failed'} onClick={() => setOutcome('failed')} />
        <span style={{ color: colors.dim, fontSize: 10, padding: '0 4px' }}>·</span>
        <FilterPill label="All Sides" active={side === 'all'} onClick={() => setSide('all')} />
        <FilterPill label="BUY" active={side === 'buy'} onClick={() => setSide('buy')} />
        <FilterPill label="SELL" active={side === 'sell'} onClick={() => setSide('sell')} />
        <span style={{ color: colors.dim, fontSize: 10, marginLeft: 6 }}>(SELL = v1.1)</span>
      </div>

      {/* Table */}
      {visible.length === 0 ? (
        <div style={{
          background: colors.panel, border: `1px dashed ${colors.border}`,
          padding: '60px 20px', textAlign: 'center', borderRadius: 3,
        }}>
          <div style={{ fontSize: 12, color: colors.dim, letterSpacing: 1.5, textTransform: 'uppercase' }}>
            No trade logs found
          </div>
        </div>
      ) : (
        <div style={{
          background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 2,
          overflowX: 'auto', maxHeight: 600, overflowY: 'auto',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'JetBrains Mono',monospace" }}>
            <thead>
              <tr>
                <HeadCell>Market</HeadCell>
                <HeadCell>Out</HeadCell>
                <HeadCell align="right">Leader</HeadCell>
                <HeadCell align="right">Fill</HeadCell>
                <HeadCell align="right">Slip bps</HeadCell>
                <HeadCell align="right">Stake</HeadCell>
                <HeadCell align="right">P&L</HeadCell>
                <HeadCell align="center">Status</HeadCell>
                <HeadCell align="right">When</HeadCell>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid #131330' }}>
                  <Cell minWidth={220}>
                    <span style={{ display: 'block', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.title}>
                      {t.title || t.conditionId}
                    </span>
                    {t.status === 'skipped' && (
                      <span style={{ display: 'block', fontSize: 10, color: colors.amber, marginTop: 2, letterSpacing: 1 }}>
                        ↳ {t.skipReason}{t.isPermanentSkip ? ' (permanent)' : ''}
                      </span>
                    )}
                  </Cell>
                  <Cell><OutcomeBadge outcome={t.outcome} /></Cell>
                  <Cell align="right">{fmtPrice(t.leaderPrice)}</Cell>
                  <Cell align="right">{fmtPrice(t.entryPrice)}</Cell>
                  <Cell align="right" color={t.slippageBps == null ? colors.dim : t.slippageBps > 50 ? colors.amber : colors.text}>
                    {t.slippageBps == null ? '—' : t.slippageBps.toFixed(0)}
                  </Cell>
                  <Cell align="right">{t.stake == null ? '—' : `$${t.stake.toFixed(2)}`}</Cell>
                  <Cell align="right" color={colorFor(t.pnl)}>{fmtUsd(t.pnl)}</Cell>
                  <Cell align="center"><ResultBadge trade={t} /></Cell>
                  <Cell align="right" color={colors.dim}>{fmtDateTime(t.openedAt)}</Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
