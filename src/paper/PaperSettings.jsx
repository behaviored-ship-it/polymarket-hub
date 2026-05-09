import { useEffect, useMemo, useState } from 'react';
import { registry as registryStore } from './paperStore.js';
import { DEFAULT_SLIPPAGE_TOLERANCE } from './constants.js';

const colors = {
  panel: '#0d0d1f', border: '#1e2040',
  green: '#00ff9d', red: '#ff4d6d', amber: '#f0c040',
  blue: '#4090ff',
  dim: '#7080a0', label: '#c0cce0', text: '#fff',
};

const PRESETS = [5, 10, 50, 100, 200, 500];

// ── small helpers / form atoms ───────────────────────────────────────────────
const inp = {
  background: '#0a0a1a', border: `1px solid ${colors.border}`, color: colors.text,
  fontFamily: "'JetBrains Mono',monospace", fontSize: 13, padding: '7px 10px',
  outline: 'none', borderRadius: 1, width: '100%', boxSizing: 'border-box',
};
const label = { fontSize: 10, letterSpacing: 1.5, color: colors.label, marginBottom: 4, display: 'block', textTransform: 'uppercase' };
const helpText = { fontSize: 10, color: colors.dim, marginTop: 4, lineHeight: 1.4 };

function NumInput({ value, onChange, placeholder = '', min, max, step = 'any', suffix }) {
  return (
    <div style={{ position: 'relative' }}>
      <input
        type="number" min={min} max={max} step={step}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : parseFloat(e.target.value))}
        placeholder={placeholder}
        style={{ ...inp, paddingRight: suffix ? 28 : 10 }}
      />
      {suffix && (
        <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: colors.dim }}>
          {suffix}
        </span>
      )}
    </div>
  );
}

function Toggle({ on, onChange, label: lbl }) {
  return (
    <label style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
      fontSize: 12, color: colors.label,
    }}>
      <span style={{
        position: 'relative', width: 32, height: 18, borderRadius: 10,
        background: on ? colors.green : '#252845', transition: 'background 0.15s',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: on ? 16 : 2,
          width: 14, height: 14, borderRadius: '50%', background: '#fff',
          transition: 'left 0.15s',
        }} />
      </span>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} style={{ display: 'none' }} />
      {lbl && <span>{lbl}</span>}
    </label>
  );
}

function SectionPanel({ title, badge, defaultOpen, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{
      background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 2,
      marginBottom: 8,
    }}>
      <button onClick={() => setOpen((v) => !v)} style={{
        background: 'none', border: 'none', color: colors.text,
        fontFamily: "'JetBrains Mono',monospace", fontSize: 12, letterSpacing: 1.5,
        padding: '12px 14px', cursor: 'pointer', width: '100%', display: 'flex',
        alignItems: 'center', textAlign: 'left',
      }}>
        <span style={{ flex: 1 }}>{title}</span>
        {badge > 0 && (
          <span style={{
            background: '#1a1400', border: `1px solid ${colors.amber}`, color: colors.amber,
            fontSize: 9, letterSpacing: 1, padding: '2px 6px', borderRadius: 2, marginRight: 8, fontWeight: 'bold',
          }}>{badge} SET</span>
        )}
        <span style={{ color: colors.dim }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div style={{ padding: '4px 14px 14px', borderTop: `1px solid ${colors.border}` }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Default counter — counts non-null, non-default fields ────────────────────
const isSet = (v, defaultV = null) => v != null && v !== defaultV && !(typeof v === 'string' && v === '');
const countSet = (...vals) => vals.filter((v) => isSet(v)).length;
function tradeSettingsBadge(s) {
  return countSet(s.newMarketsOnly || null, s.safetyCap, s.maxTradesDay);
}
function riskMgmtBadge(s) {
  return [s.perPositionStopLoss, s.perPositionTakeProfit, s.perPositionTrailingStop]
    .filter((x) => x?.enabled && x?.pct != null).length;
}
function budgetBadge(s) {
  return countSet(s.perQuestionCap, s.perEventCap, s.maxEventsOpen, s.totalBudget,
    s.dailyLossLimit, s.weeklyLossLimit, s.lifetimeLossLimit);
}
function tradeFilterBadge(s) {
  return countSet(s.minTradeSize, s.maxTradeSize, s.minPrice, s.maxPrice);
}
function blocklistBadge(s) {
  return (s.blockedCategories?.length || 0) + (s.blockedMarkets?.length || 0);
}
function slippageBadge(s) {
  const t = s.slippageTolerance || {};
  let n = 0;
  if (t.above40c !== DEFAULT_SLIPPAGE_TOLERANCE.above40c) n++;
  if (t.between18_40c !== DEFAULT_SLIPPAGE_TOLERANCE.between18_40c) n++;
  if (t.below18c !== DEFAULT_SLIPPAGE_TOLERANCE.below18c) n++;
  return n;
}
function autoPauseBadge(s) {
  const a = s.autoPause || {};
  return countSet(a.lossPct, a.lossUsd, a.profitPct, a.profitUsd);
}

// ── Main form ────────────────────────────────────────────────────────────────
export default function PaperSettings({ registry, onSaved }) {
  const [s, setS] = useState(registry);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => { setS(registry); }, [registry?.id]);

  const setField = (k, v) => setS((prev) => ({ ...prev, [k]: v }));
  const setNested = (parent, k, v) => setS((prev) => ({ ...prev, [parent]: { ...prev[parent], [k]: v } }));

  const dirty = useMemo(() => JSON.stringify(s) !== JSON.stringify(registry), [s, registry]);

  const save = async () => {
    setSaving(true);
    try {
      await registryStore.put(s);
      setSavedAt(Date.now());
      onSaved?.(s);
    } finally {
      setSaving(false);
    }
  };

  if (!s) return null;

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Wallet (read-only) */}
      <div style={{ marginBottom: 14 }}>
        <span style={label}>TRADER WALLET ADDRESS</span>
        <input value={s.walletAddr} readOnly style={{ ...inp, color: colors.dim, cursor: 'default' }} />
      </div>

      {/* Nickname */}
      <div style={{ marginBottom: 14 }}>
        <span style={label}>NICKNAME <span style={{ color: colors.dim }}>(optional)</span></span>
        <input
          value={s.nickname ?? ''}
          onChange={(e) => setField('nickname', e.target.value)}
          placeholder="e.g. Whale Alpha, Safe Plays…"
          style={inp}
        />
      </div>

      {/* Sizing mode */}
      <div style={{ marginBottom: 14 }}>
        <span style={label}>HOW TO SIZE TRADES</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button onClick={() => setField('sizingMode', 'percentage')} style={modeBtn(s.sizingMode === 'percentage')}>
            <div style={{ fontWeight: 'bold' }}>PERCENTAGE</div>
            <div style={{ fontSize: 10, opacity: 0.7, marginTop: 3 }}>scale with their bets</div>
          </button>
          <button onClick={() => setField('sizingMode', 'fixed')} style={modeBtn(s.sizingMode === 'fixed')}>
            <div style={{ fontWeight: 'bold' }}>{s.sizingMode === 'fixed' ? '✓ ' : ''}FIXED $</div>
            <div style={{ fontSize: 10, opacity: 0.7, marginTop: 3 }}>same $ every time</div>
          </button>
        </div>
      </div>

      {/* Amount */}
      {s.sizingMode === 'fixed' ? (
        <div style={{ marginBottom: 14 }}>
          <span style={label}>AMOUNT PER TRADE</span>
          <NumInput value={s.fixedAmt} onChange={(v) => setField('fixedAmt', v)} suffix="$" min={0.01} step={0.01} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {PRESETS.map((p) => (
              <button key={p} onClick={() => setField('fixedAmt', p)} style={presetBtn(Number(s.fixedAmt) === p)}>${p}</button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          <span style={label}>PERCENTAGE OF LEADER STAKE</span>
          <NumInput value={s.pctAmt} onChange={(v) => setField('pctAmt', v)} suffix="%" min={1} max={100} />
        </div>
      )}

      {/* ── Trade Settings ────────────────────────────────────── */}
      <SectionPanel title="◉ Trade Settings" badge={tradeSettingsBadge(s)} defaultOpen>
        <div style={{ marginBottom: 12 }}>
          <span style={label}>WHAT TO COPY</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button disabled style={{ ...modeBtn(false), opacity: 0.5, cursor: 'not-allowed' }}>
              <div style={{ fontWeight: 'bold' }}>BUYS & SELLS</div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 3 }}>v1.1</div>
            </button>
            <button onClick={() => setField('copyMode', 'buys_only')} style={modeBtn(s.copyMode === 'buys_only')}>
              <div style={{ fontWeight: 'bold' }}>{s.copyMode === 'buys_only' ? '✓ ' : ''}BUYS ONLY</div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 3 }}>MVP default</div>
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, color: colors.label }}>NEW MARKETS ONLY</span>
          <Toggle on={!!s.newMarketsOnly} onChange={(v) => setField('newMarketsOnly', v)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <span style={label}>SAFETY CAP $</span>
            <NumInput value={s.safetyCap} onChange={(v) => setField('safetyCap', v)} placeholder="No limit" suffix="$" />
          </div>
          <div>
            <span style={label}>MAX TRADES/DAY</span>
            <NumInput value={s.maxTradesDay} onChange={(v) => setField('maxTradesDay', v)} placeholder="No limit" />
          </div>
        </div>
        <div style={helpText}>
          Hard caps on your stake per trade and how many trades to copy per day (ET).
        </div>
      </SectionPanel>

      {/* ── Risk Management (per-position) ────────────────────── */}
      <SectionPanel title="↗ Risk Management" badge={riskMgmtBadge(s)}>
        {[
          { key: 'perPositionStopLoss',    title: 'Stop Loss',     help: 'Close position when unrealized P&L falls this many %.' },
          { key: 'perPositionTakeProfit',  title: 'Take Profit',   help: 'Close position when unrealized P&L hits this many %.' },
          { key: 'perPositionTrailingStop',title: 'Trailing Stop', help: 'Close when unrealized P&L falls this many % from its peak.' },
        ].map(({ key, title, help }) => {
          const v = s[key] || { enabled: false, pct: null };
          return (
            <div key={key} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #131330' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: colors.label }}>{title.toUpperCase()}</span>
                <Toggle on={!!v.enabled} onChange={(on) => setField(key, { ...v, enabled: on })} />
              </div>
              {v.enabled && (
                <>
                  <NumInput value={v.pct} onChange={(p) => setField(key, { ...v, pct: p })} placeholder="—" suffix="%" />
                  <div style={helpText}>{help}</div>
                </>
              )}
            </div>
          );
        })}
      </SectionPanel>

      {/* ── Position & Budget Limits ──────────────────────────── */}
      <SectionPanel title="◧ Position & Budget Limits" badge={budgetBadge(s)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <span style={label}>PER QUESTION $</span>
            <NumInput value={s.perQuestionCap} onChange={(v) => setField('perQuestionCap', v)} placeholder="No limit" suffix="$" />
          </div>
          <div>
            <span style={label}>PER EVENT $</span>
            <NumInput value={s.perEventCap} onChange={(v) => setField('perEventCap', v)} placeholder="No limit" suffix="$" />
          </div>
          <div>
            <span style={label}>MAX EVENTS OPEN</span>
            <NumInput value={s.maxEventsOpen} onChange={(v) => setField('maxEventsOpen', v)} placeholder="No limit" />
          </div>
          <div>
            <span style={label}>TOTAL BUDGET $</span>
            <NumInput value={s.totalBudget} onChange={(v) => setField('totalBudget', v)} placeholder="No limit" suffix="$" />
          </div>
        </div>
        <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>
          <span style={label}>LOSS LIMITS <span style={{ color: colors.dim }}>(skip trades when reached)</span></span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginTop: 4 }}>
            <NumInput value={s.dailyLossLimit} onChange={(v) => setField('dailyLossLimit', v)} placeholder="Daily Off" suffix="$" />
            <NumInput value={s.weeklyLossLimit} onChange={(v) => setField('weeklyLossLimit', v)} placeholder="Weekly Off" suffix="$" />
            <NumInput value={s.lifetimeLossLimit} onChange={(v) => setField('lifetimeLossLimit', v)} placeholder="Lifetime Off" suffix="$" />
          </div>
        </div>
      </SectionPanel>

      {/* ── Trade Size Filter ─────────────────────────────────── */}
      <SectionPanel title="◎ Trade Size Filter" badge={tradeFilterBadge(s)}>
        <span style={label}>ONLY COPY TRADES WITHIN THIS RANGE</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <NumInput value={s.minTradeSize} onChange={(v) => setField('minTradeSize', v)} placeholder="Min trade $" suffix="$" />
          <NumInput value={s.maxTradeSize} onChange={(v) => setField('maxTradeSize', v)} placeholder="Max trade $" suffix="$" />
        </div>
        <span style={label}>ONLY COPY WHEN SHARE PRICE IS WITHIN</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <NumInput value={s.minPrice} onChange={(v) => setField('minPrice', v)} placeholder="Min price" min={0} max={1} step={0.01} suffix="¢" />
          <NumInput value={s.maxPrice} onChange={(v) => setField('maxPrice', v)} placeholder="Max price" min={0} max={1} step={0.01} suffix="¢" />
        </div>
        <div style={helpText}>
          Skips trades at extreme prices (near 0¢ or 99¢) where liquidity is thin.
        </div>
      </SectionPanel>

      {/* ── Blocklist ─────────────────────────────────────────── */}
      <SectionPanel title="⊘ Blocklist" badge={blocklistBadge(s)}>
        <div style={{ marginBottom: 12 }}>
          <span style={label}>BLOCKED CATEGORIES</span>
          <input
            value={(s.blockedCategories || []).join(', ')}
            onChange={(e) => setField('blockedCategories', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
            placeholder="sports, politics, crypto…"
            style={inp}
          />
          <div style={helpText}>Comma-separated. Matches against the trade's category field.</div>
        </div>
        <div>
          <span style={label}>BLOCKED MARKETS (CONDITION IDs)</span>
          <textarea
            value={(s.blockedMarkets || []).join('\n')}
            onChange={(e) => setField('blockedMarkets', e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))}
            placeholder={'0x...\n0x...'}
            style={{ ...inp, minHeight: 60, resize: 'vertical', fontFamily: "'JetBrains Mono',monospace" }}
          />
          <div style={helpText}>One conditionId per line.</div>
        </div>
      </SectionPanel>

      {/* ── Slippage Tolerance ────────────────────────────────── */}
      <SectionPanel title="≋ Slippage Tolerance" badge={slippageBadge(s)} defaultOpen>
        <span style={label}>MAX SLIPPAGE BY TOKEN PRICE</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
          <div>
            <div style={{ fontSize: 10, color: colors.dim, marginBottom: 4 }}>40c+</div>
            <NumInput value={s.slippageTolerance?.above40c} onChange={(v) => setNested('slippageTolerance', 'above40c', v)} suffix="%" min={0} step={0.1} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: colors.dim, marginBottom: 4 }}>18-40c</div>
            <NumInput value={s.slippageTolerance?.between18_40c} onChange={(v) => setNested('slippageTolerance', 'between18_40c', v)} suffix="%" min={0} step={0.1} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: colors.dim, marginBottom: 4 }}>Under 18c</div>
            <NumInput value={s.slippageTolerance?.below18c} onChange={(v) => setNested('slippageTolerance', 'below18c', v)} suffix="%" min={0} step={0.1} />
          </div>
        </div>
        <div style={helpText}>
          Cheap tokens need higher tolerance — less liquidity, wider spreads.
        </div>
      </SectionPanel>

      {/* ── Auto-Pause on P&L ─────────────────────────────────── */}
      <SectionPanel title="◐ Auto-Pause on P&L" badge={autoPauseBadge(s)}>
        <span style={label}>PAUSE ON LOSS</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <NumInput value={s.autoPause?.lossPct} onChange={(v) => setNested('autoPause', 'lossPct', v)} placeholder="% of invested" suffix="%" min={0} step={0.1} />
          <NumInput value={s.autoPause?.lossUsd} onChange={(v) => setNested('autoPause', 'lossUsd', v)} placeholder="Dollar amount" suffix="$" min={0} step={1} />
        </div>
        <span style={label}>PAUSE ON PROFIT</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <NumInput value={s.autoPause?.profitPct} onChange={(v) => setNested('autoPause', 'profitPct', v)} placeholder="% of invested" suffix="%" min={0} step={0.1} />
          <NumInput value={s.autoPause?.profitUsd} onChange={(v) => setNested('autoPause', 'profitUsd', v)} placeholder="Dollar amount" suffix="$" min={0} step={1} />
        </div>
        <div style={helpText}>
          Based on realized P&L (closed positions). Either threshold pauses.
        </div>
      </SectionPanel>

      {/* Save */}
      <button
        onClick={save}
        disabled={!dirty || saving}
        style={{
          marginTop: 14, width: '100%',
          background: dirty ? colors.blue : '#0d0d1f',
          border: `1px solid ${dirty ? colors.blue : '#252845'}`,
          color: dirty ? '#fff' : colors.dim,
          fontFamily: "'JetBrains Mono',monospace", fontSize: 13, letterSpacing: 2,
          padding: '11px 0', cursor: dirty ? 'pointer' : 'not-allowed', borderRadius: 3,
          fontWeight: 'bold',
        }}
      >
        {saving ? 'SAVING…' : '✦ UPDATE CONFIG'}
      </button>
      {savedAt && !dirty && (
        <div style={{ textAlign: 'center', marginTop: 8, fontSize: 11, color: colors.green, letterSpacing: 1 }}>
          ✓ SAVED {new Date(savedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

function modeBtn(active) {
  return {
    background: active ? '#001f10' : '#0a0a1a',
    border: `1px solid ${active ? colors.green : '#252845'}`,
    color: active ? colors.green : colors.label,
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 12, letterSpacing: 1, padding: '12px 8px',
    cursor: 'pointer', borderRadius: 3, transition: 'all 0.15s',
    textAlign: 'center',
  };
}
function presetBtn(active) {
  return {
    background: active ? '#001f10' : '#0a0a1a',
    border: `1px solid ${active ? colors.green : '#252845'}`,
    color: active ? colors.green : colors.label,
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11, letterSpacing: 1, padding: '5px 10px',
    cursor: 'pointer', borderRadius: 2,
  };
}
