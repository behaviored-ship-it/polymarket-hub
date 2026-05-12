import { API, ACTIVITY_PAGE_LIMIT } from './constants.js';
import { marketCache } from './paperStore.js';

// Detects "rate limit / try again" responses we should back off on.
function isRateLimited(resp) {
  return resp.status === 429 || resp.status === 503;
}

async function getJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status} for ${url}`);
    err.status = resp.status;
    err.transient = isRateLimited(resp) || resp.status >= 500;
    throw err;
  }
  return resp.json();
}

// ── Activity ─────────────────────────────────────────────────────────────────
// Returns trades (any side) sorted DESC by timestamp, paginating until we
// pass `sinceTs`. Caller filters by side / type.
//
// `sinceTs` is a Unix seconds timestamp. We stop paging once the oldest trade
// in a page is <= sinceTs (no more new trades possible).
export async function fetchActivity(walletAddr, sinceTs = 0, opts = {}) {
  const limit = opts.limit ?? ACTIVITY_PAGE_LIMIT;
  const maxPages = opts.maxPages ?? 10;
  const collected = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const url =
      `${API.ACTIVITY}?user=${walletAddr.toLowerCase()}` +
      `&limit=${limit}&offset=${offset}` +
      `&sortBy=TIMESTAMP&sortDirection=DESC`;
    const batch = await getJson(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    collected.push(...batch);
    const oldest = batch[batch.length - 1];
    const oldestTs = oldest?.timestamp ?? 0;
    if (oldestTs <= sinceTs) break;
    if (batch.length < limit) break;
    offset += limit;
  }
  // Filter to strictly newer than sinceTs and return ascending so callers
  // process oldest-first (correct order for opening positions).
  return collected
    .filter((t) => (t.timestamp ?? 0) > sinceTs)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

// ── CLOB order book ──────────────────────────────────────────────────────────
// Always uses our /api/clob proxy (vite proxies in dev, Vercel function in prod).
// Direct calls usually work but went through proxy for consistency + CORS safety.
export async function fetchOrderBook(tokenId) {
  if (!tokenId) return { asks: [], bids: [] };
  const url = `${API.CLOB_PROXY}?token_id=${encodeURIComponent(tokenId)}`;
  const data = await getJson(url);
  return {
    asks: Array.isArray(data?.asks) ? data.asks : [],
    bids: Array.isArray(data?.bids) ? data.bids : [],
  };
}

// ── Gamma market metadata + token IDs ────────────────────────────────────────
async function fetchGammaMarketRaw(conditionId, { closed = false } = {}) {
  let url = `${API.GAMMA_MARKETS}?condition_ids=${encodeURIComponent(conditionId)}`;
  if (closed) url += '&closed=true';
  const data = await getJson(url);
  // Gamma returns either an array or a single object depending on filter shape
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

// Returns { tokens: { [outcomeLowercase]: tokenId }, outcomes: ['Yes','No' | team names...] }
// Works for both binary (Yes/No) and categorical (multi-team, multi-option) markets.
//
// Polymarket has two response shapes:
//   - Newer (BTC up/down 5-min, sports, most modern): tokens=null, but
//     clobTokenIds is a parallel array to outcomes.
//   - Older: tokens=[{outcome, token_id}, ...]
//
// We try clobTokenIds first, then fall back to the tokens array.
// Cache key v3 — bumps to invalidate v2 entries that wrongly said "no tokens"
// because they only inspected the tokens field.
const NEG_CACHE_TTL_SEC = 600; // 10 min

const empty = () => ({ tokens: {}, outcomes: [] });

export async function fetchTokenIds(conditionId) {
  if (!conditionId) return empty();
  const cacheKey = `tokens_v3:${conditionId}`;
  const cached = await marketCache.get(cacheKey);
  if (cached?.data) {
    const ttl = cached.ttlSec;
    const ageSec = (Date.now() - (cached.fetchedAt ?? 0)) / 1000;
    const fresh = ttl == null || ageSec < ttl;
    if (fresh) {
      try {
        const parsed = JSON.parse(cached.data);
        if (parsed && typeof parsed.tokens === 'object') return parsed;
      } catch (_) { /* refetch */ }
    }
  }

  let market = null;
  try {
    market = await fetchGammaMarketRaw(conditionId);
  } catch (err) {
    await marketCache.put({
      cacheKey, data: JSON.stringify(empty()),
      fetchedAt: Date.now(), ttlSec: NEG_CACHE_TTL_SEC,
    });
    return empty();
  }

  if (!market) {
    await marketCache.put({
      cacheKey, data: JSON.stringify(empty()),
      fetchedAt: Date.now(), ttlSec: NEG_CACHE_TTL_SEC,
    });
    return empty();
  }

  const tokens = {};
  const outcomes = [];

  // New-style: parallel outcomes[] + clobTokenIds[] arrays
  let outcomesRaw = market.outcomes;
  if (typeof outcomesRaw === 'string') outcomesRaw = safeJsonParseArray(outcomesRaw);
  let clobIds = market.clobTokenIds;
  if (typeof clobIds === 'string') clobIds = safeJsonParseArray(clobIds);

  if (Array.isArray(outcomesRaw) && Array.isArray(clobIds) && outcomesRaw.length === clobIds.length) {
    for (let i = 0; i < outcomesRaw.length; i++) {
      const outcome = String(outcomesRaw[i] ?? '').trim();
      const tokenId = clobIds[i] != null ? String(clobIds[i]).trim() : '';
      if (!outcome || !tokenId) continue;
      tokens[outcome.toLowerCase()] = tokenId;
      outcomes.push(outcome);
    }
  }

  // Fallback: legacy tokens array shape
  if (Object.keys(tokens).length === 0 && Array.isArray(market.tokens)) {
    for (const t of market.tokens) {
      const outcome = String(t.outcome ?? '').trim();
      if (!outcome || !t.token_id) continue;
      tokens[outcome.toLowerCase()] = t.token_id;
      outcomes.push(outcome);
    }
  }

  if (Object.keys(tokens).length === 0) {
    await marketCache.put({
      cacheKey, data: JSON.stringify(empty()),
      fetchedAt: Date.now(), ttlSec: NEG_CACHE_TTL_SEC,
    });
    return empty();
  }

  const out = { tokens, outcomes };
  await marketCache.put({
    cacheKey, data: JSON.stringify(out),
    fetchedAt: Date.now(), ttlSec: null, // permanent — token IDs don't change
  });
  return out;
}

// Pulls the Gamma market for resolution checks (outcomePrices + outcomes order).
// NOT cached because resolution state changes; outcomes are needed to map our
// position's outcome string to the right index in outcomePrices.
export async function fetchGammaResolution(conditionId) {
  // Gamma's default /markets query excludes closed markets, so short-lived
  // ones (5-min BTC up/down, etc.) are gone by the time we resolve. Retry
  // with closed=true if the default returns nothing.
  let market = await fetchGammaMarketRaw(conditionId);
  if (!market) market = await fetchGammaMarketRaw(conditionId, { closed: true });
  if (!market) return null;
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === 'string' ? safeJsonParseArray(market.outcomePrices) : []);
  const outcomes = Array.isArray(market.outcomes)
    ? market.outcomes
    : (typeof market.outcomes === 'string' ? safeJsonParseArray(market.outcomes) : []);
  return { outcomePrices, outcomes, closed: !!market.closed };
}

function safeJsonParseArray(s) {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

// ── Open positions for a wallet (via existing Hub proxy) ─────────────────────
export async function fetchOpenPositions(walletAddr) {
  const url = `${API.POSITIONS_PROXY}?wallet=${walletAddr}&type=open`;
  return getJson(url);
}
