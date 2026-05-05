import { useState } from 'react';
import { usePTStats } from './usePTStats.js';
import { shortAddr } from './registryDefaults.js';
import PaperOverview from './PaperOverview.jsx';

const colors = {
  panel: '#0d0d1f', border: '#1e2040',
  green: '#00ff9d', red: '#ff4d6d', amber: '#f0c040',
  dim: '#7080a0', label: '#c0cce0', text: '#fff',
};

const TIMEFRAMES = [['7d', '7D'], ['30d', '30D'], ['90d', '90D'], ['all', 'ALL TIME']];
const SUB_TABS = [
  ['overview', 'OVERVIEW'],
  ['compare', 'TRADE COMPARISON'],
  ['positions', 'POSITIONS'],
  ['settings', 'SETTINGS'],
];

function StatusBadge({ status }) {
  const map = {
    active:  { bg: '#001f10', border: colors.green, color: colors.green, label: '● ACTIVE' },
    paused:  { bg: '#1a1400', border: colors.amber, color: colors.amber, label: '⏸ PAUSED' },
    stopped: { bg: '#200008', border: colors.red,   color: colors.red,   label: '■ STOPPED' },
  };
  const s = map[status] || map.stopped;
  return (
    <span style={{
      background: s.bg, border: `1px solid ${s.border}`, color: s.color,
      fontSize: 10, letterSpacing: 1.5, padding: '2px 8px', borderRadius: 2, fontWeight: 'bold',
    }}>{s.label}</span>
  );
}

function RankBadge({ qualifies }) {
  return qualifies ? null : (
    <span style={{
      background: '#0a0a1a', border: '1px solid #252845', color: colors.dim,
      fontSize: 10, letterSpacing: 1.5, padding: '2px 8px', borderRadius: 2,
    }}>UNRANKED</span>
  );
}

const PaperBadge = () => (
  <span style={{
    background: '#1a1400', border: `1px solid ${colors.amber}`, color: colors.amber,
    fontSize: 10, letterSpacing: 1.5, padding: '2px 8px', borderRadius: 2, fontWeight: 'bold',
  }}>PAPER</span>
);

function Placeholder({ tab }) {
  return (
    <div style={{ padding: 60, textAlign: 'center', color: colors.dim, fontSize: 13, letterSpacing: 2 }}>
      {tab.toUpperCase()} — COMING IN NEXT BATCH
    </div>
  );
}

export default function PaperTraderDetail({ registryId, onBack }) {
  const [tf, setTf] = useState('all');
  const [sub, setSub] = useState('overview');
  const { loading, registry, stats } = usePTStats(registryId, tf);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: colors.dim, letterSpacing: 2 }}>LOADING…</div>;
  }
  if (!registry) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{ color: colors.red, fontSize: 13, letterSpacing: 2, marginBottom: 12 }}>PAPER TRADER NOT FOUND</div>
        <button onClick={onBack} style={backBtn}>← BACK TO REGISTRY</button>
      </div>
    );
  }

  const created = new Date((registry.createdAt || 0) * 1000).toLocaleDateString();

  return (
    <div style={{ padding: 20 }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <button onClick={onBack} style={backBtn}>← BACK</button>
        <span style={{ fontSize: 14, color: colors.text, fontWeight: 'bold', fontFamily: "'JetBrains Mono',monospace" }}>
          {shortAddr(registry.walletAddr)}
        </span>
        {registry.nickname && (
          <span style={{ fontSize: 13, color: colors.dim }}>· {registry.nickname}</span>
        )}
        <RankBadge qualifies={stats.qualifies} />
        <PaperBadge />
        <StatusBadge status={registry.status} />
        <span style={{ fontSize: 11, color: colors.dim, marginLeft: 4 }}>
          created {created}
        </span>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${colors.border}`, background: '#0a0a1a', marginBottom: 12 }}>
        {SUB_TABS.map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} style={subTabStyle(sub === k)}>{l}</button>
        ))}
      </div>

      {/* Time filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {TIMEFRAMES.map(([k, l]) => (
          <button key={k} onClick={() => setTf(k)} style={tfBtn(tf === k)}>{l}</button>
        ))}
      </div>

      {/* Body */}
      {sub === 'overview' && <PaperOverview registry={registry} stats={stats} />}
      {sub === 'compare' && <Placeholder tab="Trade Comparison" />}
      {sub === 'positions' && <Placeholder tab="Positions" />}
      {sub === 'settings' && <Placeholder tab="Settings" />}
    </div>
  );
}

const backBtn = {
  background: 'transparent', border: '1px solid #303060', color: '#9090c0',
  fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: 2,
  padding: '6px 14px', cursor: 'pointer', borderRadius: 3,
};
function subTabStyle(active) {
  return {
    background: 'none', border: 'none',
    color: active ? colors.green : '#a0b0c8',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11, letterSpacing: 2, padding: '8px 16px', cursor: 'pointer',
    borderBottom: active ? `2px solid ${colors.green}` : '2px solid transparent',
    textTransform: 'uppercase',
  };
}
function tfBtn(active) {
  return {
    background: active ? '#001f10' : '#0d0d1f',
    border: `1px solid ${active ? colors.green : '#252845'}`,
    color: active ? colors.green : '#b0bcd0',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11, letterSpacing: 1, padding: '6px 12px',
    cursor: 'pointer', borderRadius: 3,
  };
}
