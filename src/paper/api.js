import { API, ACTIVITY_PAGE_LIMIT } from './constants.js';
import { marketCache } from './usePaperDB.js';

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
async function fetchGammaMarketRaw(conditionId) {
  const url = `${API.GAMMA_MARKETS}?condition_ids=${encodeURIComponent(conditionId)}`;
  const data = await getJson(url);
  // Gamma returns either an array or a single object depending on filter shape
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

// Returns { tokens: { [outcomeLowercase]: tokenId }, outcomes: ['Yes','No' | team names...] }
// Works for both binary (Yes/No) and categorical (multi-team, multi-option) markets.
// Cached indefinitely on success, briefly on miss so a single bad market doesn't
// get re-fetched every 30s poll. Cache key v2 — bumps invalidates old binary-only entries.
const NEG_CACHE_TTL_SEC = 600; // 10 min

const empty = () => ({ tokens: {}, outcomes: [] });

export async function fetchTokenIds(conditionId) {
  if (!conditionId) return empty();
  const cacheKey = `tokens_v2:${conditionId}`;
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

  if (!market?.tokens) {
    await marketCache.put({
      cacheKey, data: JSON.stringify(empty()),
      fetchedAt: Date.now(), ttlSec: NEG_CACHE_TTL_SEC,
    });
    return empty();
  }

  const tokenList = Array.isArray(market.tokens) ? market.tokens : [];
  const tokens = {};
  const outcomes = [];
  for (const t of tokenList) {
    const outcome = String(t.outcome ?? '').trim();
    if (!outcome || !t.token_id) continue;
    tokens[outcome.toLowerCase()] = t.token_id;
    outcomes.push(outcome);
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
  const market = await fetchGammaMarketRaw(conditionId);
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
