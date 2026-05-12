import { useState } from 'react';
import { isValidWallet } from './registryDefaults.js';

const PRESETS = [5, 10, 50, 100, 200, 500];

// Bank-size sizing recommendations. The thresholds and ranges come from the
// V1 review write-up — small banks can't realistically copy aggressive
// scalpers without burning into the floor; large banks can afford full-mirror.
const BANK_SIZE_TIERS = [
  { min: 5000, concurrent: 'easy copy',  perTrade: 'any',     strategy: 'all strategies viable' },
  { min: 2500, concurrent: '≤80',        perTrade: '$25–50',  strategy: 'all strategies viable' },
  { min: 1000, concurrent: '≤40',        perTrade: '$20–40',  strategy: 'full-copy ok' },
  { min: 500,  concurrent: '≤25',        perTrade: '$15–30',  strategy: 'selective copy' },
  { min: 200,  concurrent: '≤14',        perTrade: '$10–25',  strategy: '1-per-market only' },
  { min: 100,  concurrent: '≤4',         perTrade: '$5–10',   strategy: '1-per-market, conservative' },
  { min: 0,    concurrent: '≤2',         perTrade: '$2–5',    strategy: 'tight — friction eats most edge below $100' },
];

function tierFor(balance) {
  for (const t of BANK_SIZE_TIERS) if (balance >= t.min) return t;
  return BANK_SIZE_TIERS[BANK_SIZE_TIERS.length - 1];
}

function BankSizeHint({ balance }) {
  if (!(balance > 0)) return null;
  const t = tierFor(balance);
  return (
    <div style={{
      marginTop: 8, padding: '8px 10px',
      background: '#0a0a1a', border: '1px solid #1e2040', borderRadius: 2,
      fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#8090b0', lineHeight: 1.55,
    }}>
      <span style={{ color: '#a0b0c8', letterSpacing: 1.5, textTransform: 'uppercase' }}>
        At ${balance.toFixed(0)}:
      </span>{' '}
      <span style={{ color: '#c0cce0' }}>
        ~{t.concurrent} concurrent · {t.perTrade}/trade · {t.strategy}
      </span>
    </div>
  );
}

export default function PaperAddModal({ onCreate, onClose }) {
  const [walletAddr, setWalletAddr] = useState('');
  const [nickname, setNickname] = useState('');
  const [startBalance, setStartBalance] = useState(100);
  const [sizingMode, setSizingMode] = useState('fixed'); // 'fixed' | 'percentage'
  const [fixedAmt, setFixedAmt] = useState(10);
  const [pctAmt, setPctAmt] = useState(50);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const walletOk = isValidWallet(walletAddr);
  const balanceOk = Number(startBalance) > 0;
  const sizeOk = sizingMode === 'fixed'
    ? Number(fixedAmt) > 0
    : Number(pctAmt) > 0 && Number(pctAmt) <= 100;
  const canSubmit = walletOk && balanceOk && sizeOk && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErr('');
    try {
      await onCreate({
        walletAddr: walletAddr.trim(),
        nickname,
        startBalance: Number(startBalance),
        sizingMode,
        fixedAmt: Number(fixedAmt),
        pctAmt: Number(pctAmt),
      });
      onClose();
    } catch (e) {
      setErr(e.message || 'Failed to create paper trader');
      setSubmitting(false);
    }
  };

  const inp = {
    background: '#0a0a1a', border: '1px solid #1e2040', color: '#fff',
    fontFamily: "'JetBrains Mono',monospace", fontSize: 13, padding: '8px 10px',
    outline: 'none', borderRadius: 1, width: '100%', boxSizing: 'border-box',
  };
  const lbl = { fontSize: 11, letterSpacing: 2, color: '#c0cce0', marginBottom: 6, display: 'block' };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div style={{
        background: '#0d0d1f', border: '1px solid #1e2040', padding: '24px 28px',
        borderRadius: 4, width: 440, maxWidth: '92vw',
        fontFamily: "'JetBrains Mono',monospace",
      }}>
        <div style={{ fontSize: 14, letterSpacing: 3, color: '#00ff9d', marginBottom: 18, textTransform: 'uppercase' }}>
          ⬡ ADD PAPER TRADER
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>TRADER WALLET ADDRESS</label>
          <input
            value={walletAddr}
            onChange={(e) => setWalletAddr(e.target.value)}
            placeholder="0x…"
            style={{
              ...inp,
              borderColor: walletAddr && !walletOk ? '#ff4d6d' : '#1e2040',
            }}
            autoFocus
          />
          {walletAddr && !walletOk && (
            <div style={{ color: '#ff4d6d', fontSize: 11, marginTop: 4 }}>
              Must be a 0x-prefixed 40-char hex address
            </div>
          )}
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>NICKNAME <span style={{ color: '#7080a0' }}>(optional)</span></label>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="e.g. Whale Alpha, Safe Plays…"
            style={inp}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>STARTING BALANCE ($)</label>
          <input
            type="number"
            min="1"
            value={startBalance}
            onChange={(e) => setStartBalance(e.target.value)}
            style={inp}
          />
          <BankSizeHint balance={Number(startBalance)} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>HOW TO SIZE TRADES</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button
              type="button"
              onClick={() => setSizingMode('percentage')}
              style={modeBtn(sizingMode === 'percentage')}
            >
              <div style={{ fontWeight: 'bold' }}>PERCENTAGE</div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 3 }}>scale with their bets</div>
            </button>
            <button
              type="button"
              onClick={() => setSizingMode('fixed')}
              style={modeBtn(sizingMode === 'fixed')}
            >
              <div style={{ fontWeight: 'bold' }}>{sizingMode === 'fixed' ? '✓ ' : ''}FIXED $</div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 3 }}>same $ every time</div>
            </button>
          </div>
        </div>

        {sizingMode === 'fixed' ? (
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>AMOUNT PER TRADE ($)</label>
            <input
              type="number" min="0.01" step="0.01"
              value={fixedAmt}
              onChange={(e) => setFixedAmt(e.target.value)}
              style={{ ...inp, marginBottom: 8 }}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setFixedAmt(p)}
                  style={presetBtn(Number(fixedAmt) === p)}
                >${p}</button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>PERCENTAGE OF LEADER STAKE</label>
            <input
              type="number" min="1" max="100"
              value={pctAmt}
              onChange={(e) => setPctAmt(e.target.value)}
              style={inp}
            />
          </div>
        )}

        {err && (
          <div style={{ color: '#ff4d6d', fontSize: 12, marginBottom: 10, letterSpacing: 1 }}>
            ✕ {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button onClick={onClose} style={cancelBtn}>CANCEL</button>
          <button
            disabled={!canSubmit}
            onClick={submit}
            style={createBtn(canSubmit)}
          >{submitting ? 'CREATING…' : '+ CREATE'}</button>
        </div>
      </div>
    </div>
  );
}

function modeBtn(active) {
  return {
    background: active ? '#001f10' : '#0a0a1a',
    border: `1px solid ${active ? '#00ff9d' : '#252845'}`,
    color: active ? '#00ff9d' : '#c0cce0',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 12, letterSpacing: 1, padding: '12px 8px',
    cursor: 'pointer', borderRadius: 3, transition: 'all 0.15s',
    textAlign: 'center',
  };
}
function presetBtn(active) {
  return {
    background: active ? '#001f10' : '#0a0a1a',
    border: `1px solid ${active ? '#00ff9d' : '#252845'}`,
    color: active ? '#00ff9d' : '#b0bcd0',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11, letterSpacing: 1, padding: '5px 10px',
    cursor: 'pointer', borderRadius: 2,
  };
}
const cancelBtn = {
  background: '#151530', border: '1px solid #303060', color: '#9090c0',
  fontFamily: "'JetBrains Mono',monospace", fontSize: 12, letterSpacing: 2,
  padding: '8px 18px', cursor: 'pointer', borderRadius: 3,
};
function createBtn(enabled) {
  return {
    background: enabled ? '#001f10' : '#0d0d1f',
    border: `1px solid ${enabled ? '#00ff9d' : '#252845'}`,
    color: enabled ? '#00ff9d' : '#404468',
    fontFamily: "'JetBrains Mono',monospace", fontSize: 12, letterSpacing: 2,
    padding: '8px 22px', cursor: enabled ? 'pointer' : 'not-allowed',
    borderRadius: 3, fontWeight: 'bold',
  };
}
