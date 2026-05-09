import { POLL_TRADES_MS, POLL_RESOLUTION_MS, SCHEDULER_TICK_MS, POLL_JITTER_MS } from './constants.js';
import { registry as registryStore } from './paperStore.js';
import { pollOnce, resolveOpenForRegistry } from './tradeExecutor.js';

// ── Module state ─────────────────────────────────────────────────────────────
let _interval = null;
let _resolutionInterval = null;
let _running = false;
const _state = new Map(); // registryId → { lastPollAt, lastResolveAt, jitter, inflight }

function getState(id) {
  let s = _state.get(id);
  if (!s) {
    s = {
      lastPollAt: 0,
      lastResolveAt: 0,
      jitter: Math.random() * POLL_JITTER_MS,
      inflight: false,
    };
    _state.set(id, s);
  }
  return s;
}

// Pause polling when the tab is hidden (battery, mobile data).
function tabVisible() {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

async function tradeTick() {
  if (!tabVisible()) return;
  const active = await registryStore.active().catch(() => []);
  const now = Date.now();
  for (const r of active) {
    const s = getState(r.id);
    if (s.inflight) continue;
    const due = now - s.lastPollAt >= POLL_TRADES_MS + s.jitter;
    if (!due) continue;
    s.inflight = true;
    s.lastPollAt = now;
    pollOnce(r)
      .catch(() => { /* tradeExecutor already logs */ })
      .finally(() => { s.inflight = false; });
  }
}

async function resolutionTick() {
  if (!tabVisible()) return;
  const active = await registryStore.active().catch(() => []);
  const now = Date.now();
  for (const r of active) {
    const s = getState(r.id);
    const due = now - s.lastResolveAt >= POLL_RESOLUTION_MS;
    if (!due) continue;
    s.lastResolveAt = now;
    resolveOpenForRegistry(r).catch(() => { /* logs in executor */ });
  }
}

export function startScheduler() {
  if (_running) return;
  _running = true;
  // Two intervals — decoupled cadences per spec §2.2
  _interval = setInterval(tradeTick, SCHEDULER_TICK_MS);
  _resolutionInterval = setInterval(resolutionTick, SCHEDULER_TICK_MS * 3);
  // Kick once immediately so users don't wait the full tick on add
  tradeTick();
  resolutionTick();
}

export function stopScheduler() {
  if (_interval) clearInterval(_interval);
  if (_resolutionInterval) clearInterval(_resolutionInterval);
  _interval = null;
  _resolutionInterval = null;
  _running = false;
  _state.clear();
}

export function isRunning() {
  return _running;
}

// Diagnostic — exposed for the dev console / debug panels
export function schedulerState() {
  return {
    running: _running,
    perTrader: Array.from(_state.entries()).map(([id, s]) => ({
      registryId: id,
      lastPollAt: s.lastPollAt,
      lastResolveAt: s.lastResolveAt,
      jitterMs: s.jitter,
      inflight: s.inflight,
    })),
  };
}
