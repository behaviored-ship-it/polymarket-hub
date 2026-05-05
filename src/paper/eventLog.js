// In-memory ring buffer for the COPY RESULTS feed shown in the Overview tab.
// Keeps last N events across all paper traders. Subscribers re-render on push.

const MAX_EVENTS = 500;
const _events = [];
const _subscribers = new Set();

export function pushEvent(evt) {
  const entry = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), ...evt };
  _events.unshift(entry);
  if (_events.length > MAX_EVENTS) _events.length = MAX_EVENTS;
  for (const fn of _subscribers) {
    try { fn(entry); } catch (_) { /* ignore subscriber errors */ }
  }
  return entry;
}

export function recentEvents(limit = 100, filter = null) {
  const list = filter ? _events.filter(filter) : _events;
  return list.slice(0, limit);
}

export function subscribe(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

export function clearEvents() {
  _events.length = 0;
}

// Convenience helpers — keep event shapes consistent.
export const log = {
  buy: (registryId, trade) =>
    pushEvent({ kind: 'BUY', registryId, conditionId: trade.conditionId, title: trade.title,
                stake: trade.stake, entryPrice: trade.entryPrice }),
  skip: (registryId, leaderTrade, reason, isPermanent) =>
    pushEvent({ kind: 'SKIP', registryId, conditionId: leaderTrade.conditionId,
                title: leaderTrade.title, reason, isPermanent }),
  resolve: (registryId, position, result) =>
    pushEvent({ kind: result === 'win' ? 'WIN' : 'LOSS', registryId,
                conditionId: position.conditionId, title: position.title,
                pnl: position.realizedPnl }),
  pause: (registryId, reason) =>
    pushEvent({ kind: 'PAUSE', registryId, reason }),
  error: (registryId, msg) =>
    pushEvent({ kind: 'ERROR', registryId, message: String(msg) }),
};
