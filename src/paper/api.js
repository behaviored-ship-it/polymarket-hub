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
export async function fetchOrderBook(tokenId, { useProxy = false } = {}) {
  const base = useProxy ? API.CLOB_PROXY : API.CLOB_BOOK;
  const url = `${base}?token_id=${encodeURIComponent(tokenId)}`;
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

// Returns { yes: tokenId, no: tokenId } looked up by outcome string,
// NOT by index. Cached in IndexedDB indefinitely (token IDs don't change).
export async function fetchTokenIds(conditionId) {
  const cacheKey = `tokens:${conditionId}`;
  const cached = await marketCache.get(cacheKey);
  if (cached?.data) {
    try { return JSON.parse(cached.data); } catch (_) { /* fall through */ }
  }
  const market = await fetchGammaMarketRaw(conditionId);
  if (!market?.tokens) return { yes: null, no: null };
  const tokens = Array.isArray(market.tokens) ? market.tokens : [];
  const yes = tokens.find((t) => String(t.outcome).toLowerCase() === 'yes')?.token_id ?? null;
  const no  = tokens.find((t) => String(t.outcome).toLowerCase() === 'no')?.token_id ?? null;
  const out = { yes, no };
  await marketCache.put({
    cacheKey,
    data: JSON.stringify(out),
    fetchedAt: Date.now(),
    ttlSec: null,
  });
  return out;
}

// Pulls the Gamma market for resolution checks (outcomePrices). NOT cached
// because resolution state changes.
export async function fetchGammaResolution(conditionId) {
  const market = await fetchGammaMarketRaw(conditionId);
  if (!market) return null;
  return {
    outcomePrices: Array.isArray(market.outcomePrices)
      ? market.outcomePrices
      : (typeof market.outcomePrices === 'string'
          ? safeJsonParseArray(market.outcomePrices)
          : []),
    closed: !!market.closed,
  };
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
