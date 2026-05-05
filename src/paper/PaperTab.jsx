import { useState } from 'react';
import { usePaperRegistry } from './usePaperRegistry.js';
import PaperAddModal from './PaperAddModal.jsx';
import PaperTraderDetail from './PaperTraderDetail.jsx';
import { shortAddr } from './registryDefaults.js';

const colors = {
  bg: '#080818', panel: '#0d0d1f', border: '#1e2040',
  green: '#00ff9d', red: '#ff4d6d', amber: '#f0c040',
  dim: '#7080a0', label: '#c0cce0', text: '#fff',
};

const fmtPct = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const fmtUsd = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}`;
const colorFor = (n) => n == null ? colors.dim : n > 0 ? colors.green : n < 0 ? colors.red : colors.dim;

function StatusBadge({ status }) {
  const styles = {
    active:  { bg: '#001f10', border: colors.green, color: colors.green, label: '● ACTIVE' },
    paused:  { bg: '#1a1400', border: colors.amber, color: colors.amber, label: '⏸ PAUSED' },
    stopped: { bg: '#200008', border: colors.red,   color: colors.red,   label: '■ STOPPED' },
  };
  const s = styles[status] || styles.stopped;
  return (
    <span style={{
      display: 'inline-block', background: s.bg, border: `1px solid ${s.border}`, color: s.color,
      fontSize: 10, letterSpacing: 1.5, padding: '2px 8px', borderRadius: 2, fontWeight: 'bold',
    }}>{s.label}</span>
  );
}

function RankBadge({ rank }) {
  if (rank == null) {
    return <span style={{
      background: '#0a0a1a', border: '1px solid #252845', color: '#7080a0',
      fontSize: 10, letterSpacing: 1.5, padding: '2px 8px', borderRadius: 2,
    }}>UNRANKED</span>;
  }
  return <span style={{
    background: '#1a1400', border: `1px solid ${colors.amber}`, color: colors.amber,
    fontSize: 11, letterSpacing: 1.5, padding: '2px 9px', borderRadius: 2, fontWeight: 'bold',
  }}>#{rank}</span>;
}

function CardStat({ label, value, color, sub }) {
  return (
    <div>
      <div style={{ fontSize: 9, letterSpacing: 2, color: colors.dim, marginBottom: 3, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 'bold', color: color || colors.text, lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10, color: colors.dim, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function TraderCard({ card, onPause, onResume, onStop, onDelete, onReset, onOpen }) {
  const r = card.registry;
  const s = card.stats;
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div style={{
      background: colors.panel, border: `1px solid ${colors.border}`,
      padding: '14px 16px', borderRadius: 3, position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <RankBadge rank={card.rank} />
        <span style={{ fontSize: 13, color: colors.text, fontWeight: 'bold' }}>{shortAddr(r.walletAddr)}</span>
        {r.nickname && (
          <span style={{ fontSize: 12, color: colors.dim }}>· {r.nickname}</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <StatusBadge status={r.status} />
          <button
            onClick={() => setMenuOpen((v) => !v)}
            style={iconBtn}
            title="More"
          >⋯</button>
        </div>
      </div>

      {menuOpen && (
        <div style={{
          position: 'absolute', right: 16, top: 44, zIndex: 10,
          background: colors.panel, border: `1px solid ${colors.border}`,
          padding: '6px 0', borderRadius: 3, minWidth: 140,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}>
          <MenuItem onClick={() => { setMenuOpen(false); onReset(r.id); }}>RESET BALANCE</MenuItem>
          <MenuItem onClick={() => { setMenuOpen(false); if (window.confirm(`Delete paper trader for ${shortAddr(r.walletAddr)}? This cannot be undone.`)) onDelete(r.id); }} danger>DELETE</MenuItem>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 12 }}>
        <CardStat
          label="ROI"
          value={fmtPct(s.roi)}
          color={colorFor(s.roi)}
        />
        <CardStat
          label="Win Rate"
          value={s.wr == null ? '—' : `${s.wr.toFixed(1)}%`}
          sub={`${s.wins}W / ${s.losses}L`}
        />
        <CardStat
          label="Realized P&L"
          value={fmtUsd(s.realizedPnl)}
          color={colorFor(s.realizedPnl)}
        />
        <CardStat
          label="Trades Copied"
          value={s.tradesCopied}
        />
        <CardStat
          label="Open Positions"
          value={s.open}
        />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => onOpen(r.id)} style={primaryBtn}>OPEN</button>
        {r.status === 'active' && (
          <button onClick={() => onPause(r.id)} style={secBtn}>PAUSE</button>
        )}
        {r.status === 'paused' && (
          <button onClick={() => onResume(r.id)} style={secBtn}>RESUME</button>
        )}
        {r.status !== 'stopped' && (
          <button onClick={() => { if (window.confirm(`Stop polling ${shortAddr(r.walletAddr)}?`)) onStop(r.id); }}
            style={dangerBtn}>STOP</button>
        )}
      </div>
    </div>
  );
}

function MenuItem({ children, onClick, danger }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '7px 14px', fontSize: 11, letterSpacing: 1.5,
        color: danger ? colors.red : colors.label, cursor: 'pointer',
        textTransform: 'uppercase',
      }}
      onMouseEnter={(e) => e.currentTarget.style.background = '#151530'}
      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >{children}</div>
  );
}

const iconBtn = {
  background: 'transparent', border: '1px solid #252845', color: '#9090c0',
  width: 26, height: 26, borderRadius: 3, cursor: 'pointer',
  fontSize: 16, lineHeight: '20px', padding: 0,
};
const primaryBtn = {
  background: '#001f10', border: `1px solid ${colors.green}`, color: colors.green,
  fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: 2,
  padding: '6px 16px', cursor: 'pointer', borderRadius: 3, fontWeight: 'bold',
};
const secBtn = {
  background: '#151530', border: '1px solid #303060', color: '#9090c0',
  fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: 2,
  padding: '6px 14px', cursor: 'pointer', borderRadius: 3,
};
const dangerBtn = {
  background: 'transparent', border: `1px solid ${colors.red}`, color: colors.red,
  fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: 2,
  padding: '6px 14px', cursor: 'pointer', borderRadius: 3,
};

export default function PaperTab() {
  const reg = usePaperRegistry();
  const [showAdd, setShowAdd] = useState(false);
  const [openId, setOpenId] = useState(null);

  if (openId) {
    return <PaperTraderDetail registryId={openId} onBack={() => setOpenId(null)} />;
  }

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 14, letterSpacing: 3, color: colors.green, fontWeight: 'bold' }}>
            ⬡ PAPER TRADERS
          </div>
          <div style={{ fontSize: 11, letterSpacing: 1.5, color: colors.dim, marginTop: 3 }}>
            Live copy-trade simulators · ranked by ROI
          </div>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          style={{
            marginLeft: 'auto',
            background: '#001f10', border: `1px solid ${colors.green}`, color: colors.green,
            fontFamily: "'JetBrains Mono',monospace", fontSize: 12, letterSpacing: 2,
            padding: '8px 16px', cursor: 'pointer', borderRadius: 3, fontWeight: 'bold',
          }}
        >+ ADD PAPER TRADER</button>
      </div>

      <div style={{
        background: '#1a1400', border: `1px solid ${colors.amber}`,
        padding: '8px 14px', fontSize: 11, color: colors.amber, letterSpacing: 1,
        marginBottom: 16, borderRadius: 2,
      }}>
        ⓘ TRACKING ACTIVE ONLY WHILE THIS TAB IS OPEN — closing the browser pauses polling. Always-on backend is Phase 2.
      </div>

      {reg.loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: colors.dim, fontSize: 13, letterSpacing: 2 }}>
          LOADING…
        </div>
      ) : reg.cards.length === 0 ? (
        <div style={{
          background: colors.panel, border: `1px dashed ${colors.border}`, borderRadius: 3,
          padding: '60px 20px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 42, marginBottom: 12, opacity: 0.4 }}>⬡</div>
          <div style={{ fontSize: 13, color: colors.label, letterSpacing: 2, marginBottom: 6, textTransform: 'uppercase' }}>
            No paper traders yet
          </div>
          <div style={{ fontSize: 12, color: colors.dim, marginBottom: 20 }}>
            Add a wallet to start shadowing its trades with virtual funds.
          </div>
          <button
            onClick={() => setShowAdd(true)}
            style={{
              background: '#001f10', border: `1px solid ${colors.green}`, color: colors.green,
              fontFamily: "'JetBrains Mono',monospace", fontSize: 12, letterSpacing: 2,
              padding: '10px 22px', cursor: 'pointer', borderRadius: 3, fontWeight: 'bold',
            }}
          >+ ADD PAPER TRADER</button>
        </div>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 14,
        }}>
          {reg.cards.map((c) => (
            <TraderCard
              key={c.registry.id}
              card={c}
              onPause={reg.pauseTrader}
              onResume={reg.resumeTrader}
              onStop={reg.stopTrader}
              onDelete={reg.deleteTrader}
              onReset={reg.resetTrader}
              onOpen={(id) => setOpenId(id)}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <PaperAddModal onCreate={reg.addTrader} onClose={() => setShowAdd(false)} />
      )}
    </div>
  );
}
