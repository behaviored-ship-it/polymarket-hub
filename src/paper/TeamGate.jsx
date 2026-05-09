import { useState } from 'react';

const colors = {
  panel: '#0d0d1f', border: '#1e2040',
  green: '#00ff9d', red: '#ff4d6d', amber: '#f0c040',
  dim: '#7080a0', label: '#c0cce0', text: '#fff',
};

export default function TeamGate({ team }) {
  const [mode, setMode] = useState('choose'); // 'choose' | 'create' | 'join' | 'created'
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [createdCode, setCreatedCode] = useState(null);
  const [copied, setCopied] = useState(false);

  const submitCreate = async () => {
    try {
      const t = await team.create(name);
      setCreatedCode(t.code);
      setMode('created');
    } catch (_) { /* error stored in team.error */ }
  };

  const submitJoin = async () => {
    try {
      await team.join(joinCode);
      // If join succeeds, the parent re-renders and removes this gate.
    } catch (_) { /* error stored in team.error */ }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(createdCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) { /* ignore */ }
  };

  return (
    <div style={{
      padding: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '60vh', fontFamily: "'JetBrains Mono',monospace",
    }}>
      <div style={{
        background: colors.panel, border: `1px solid ${colors.border}`,
        padding: '28px 32px', borderRadius: 4, width: 460, maxWidth: '92vw',
      }}>
        <div style={{ fontSize: 14, letterSpacing: 3, color: colors.green, marginBottom: 14, textTransform: 'uppercase' }}>
          ⬡ JOIN A PAPER TRADER TEAM
        </div>
        <div style={{ fontSize: 12, color: colors.label, marginBottom: 22, lineHeight: 1.6 }}>
          Paper traders are now stored on a server, so you can use the same data
          across devices. Create a team and share the code with your friend, or
          join an existing team's code.
        </div>

        {mode === 'choose' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button onClick={() => setMode('create')} style={modeBtn(true)}>
              <div style={{ fontWeight: 'bold' }}>CREATE TEAM</div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 5 }}>get a new code</div>
            </button>
            <button onClick={() => setMode('join')} style={modeBtn(false)}>
              <div style={{ fontWeight: 'bold' }}>JOIN TEAM</div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 5 }}>enter friend's code</div>
            </button>
          </div>
        )}

        {mode === 'create' && (
          <div>
            <label style={lblStyle}>TEAM NAME <span style={{ color: colors.dim }}>(optional)</span></label>
            <input
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              style={inpStyle}
            />
            {team.error && <div style={errStyle}>✕ {team.error}</div>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setMode('choose')} style={cancelBtn}>← BACK</button>
              <button onClick={submitCreate} disabled={team.busy} style={primaryBtn(!team.busy)}>
                {team.busy ? 'CREATING…' : '+ CREATE TEAM'}
              </button>
            </div>
          </div>
        )}

        {mode === 'join' && (
          <div>
            <label style={lblStyle}>TEAM CODE</label>
            <input
              autoFocus value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="e.g. K7M9XPN"
              maxLength={12}
              style={{ ...inpStyle, letterSpacing: 4, textAlign: 'center', fontSize: 18 }}
            />
            <div style={{ fontSize: 10, color: colors.dim, marginTop: 6 }}>
              7-character code your friend shared with you.
            </div>
            {team.error && <div style={errStyle}>✕ {team.error}</div>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setMode('choose')} style={cancelBtn}>← BACK</button>
              <button onClick={submitJoin} disabled={team.busy || joinCode.length < 6} style={primaryBtn(!team.busy && joinCode.length >= 6)}>
                {team.busy ? 'JOINING…' : '→ JOIN'}
              </button>
            </div>
          </div>
        )}

        {mode === 'created' && createdCode && (
          <div>
            <div style={{ fontSize: 11, letterSpacing: 2, color: colors.dim, marginBottom: 10, textTransform: 'uppercase' }}>
              YOUR TEAM CODE
            </div>
            <div style={{
              background: '#001f10', border: `1px solid ${colors.green}`, borderRadius: 3,
              padding: '20px 0', textAlign: 'center', marginBottom: 14,
            }}>
              <div style={{ fontSize: 32, letterSpacing: 8, color: colors.green, fontWeight: 'bold' }}>
                {createdCode}
              </div>
            </div>
            <button onClick={copyCode} style={copyBtn}>
              {copied ? '✓ COPIED' : '⎘ COPY CODE'}
            </button>
            <div style={{ fontSize: 11, color: colors.label, lineHeight: 1.6, marginTop: 16 }}>
              <strong style={{ color: colors.amber }}>Save this code.</strong> Share it with anyone you want on your team.
              They go to PAPER → click JOIN TEAM → paste this code. You'll both see and edit
              the same paper traders.
            </div>
            <div style={{ fontSize: 11, color: colors.dim, marginTop: 10 }}>
              The code stays in this browser's localStorage — you don't need to enter it again on this device.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inpStyle = {
  background: '#0a0a1a', border: `1px solid ${colors.border}`, color: colors.text,
  fontFamily: "'JetBrains Mono',monospace", fontSize: 13, padding: '9px 12px',
  outline: 'none', borderRadius: 1, width: '100%', boxSizing: 'border-box',
};
const lblStyle = {
  fontSize: 11, letterSpacing: 1.5, color: colors.label, marginBottom: 6,
  display: 'block', textTransform: 'uppercase',
};
const errStyle = {
  marginTop: 10, fontSize: 11, color: colors.red, letterSpacing: 1,
};
function modeBtn(emphasis) {
  return {
    background: emphasis ? '#001f10' : '#0a0a1a',
    border: `1px solid ${emphasis ? colors.green : '#252845'}`,
    color: emphasis ? colors.green : colors.label,
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 12, letterSpacing: 1, padding: '18px 8px',
    cursor: 'pointer', borderRadius: 3, textAlign: 'center',
  };
}
const cancelBtn = {
  background: '#151530', border: '1px solid #303060', color: '#9090c0',
  fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: 2,
  padding: '8px 16px', cursor: 'pointer', borderRadius: 3,
};
function primaryBtn(enabled) {
  return {
    background: enabled ? '#001f10' : '#0d0d1f',
    border: `1px solid ${enabled ? colors.green : '#252845'}`,
    color: enabled ? colors.green : '#404468',
    fontFamily: "'JetBrains Mono',monospace", fontSize: 12, letterSpacing: 2,
    padding: '8px 22px', cursor: enabled ? 'pointer' : 'not-allowed',
    borderRadius: 3, fontWeight: 'bold',
  };
}
const copyBtn = {
  background: 'transparent', border: `1px solid ${colors.green}`, color: colors.green,
  fontFamily: "'JetBrains Mono',monospace", fontSize: 12, letterSpacing: 2,
  padding: '10px 0', cursor: 'pointer', borderRadius: 3, width: '100%',
};
