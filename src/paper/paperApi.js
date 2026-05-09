// Supabase-backed implementation of the same surface as usePaperDB.js.
//
// Loaded by paperStore.js when VITE_STORAGE_MODE=api. The team code lives in
// localStorage (set by TeamGate); every Supabase REST call sends it as the
// `x-team-code` header so RLS scopes rows to the team.
//
// Field names: SQL is snake_case, JS is camelCase. Translation happens at this
// boundary — consumers (PaperTab, hooks, executor) keep using camelCase keys.

import { createClient } from '@supabase/supabase-js';
import { STORES } from './constants.js';

const TEAM_CODE_KEY = 'paper_team_code';
const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ── Team code helpers (localStorage-backed) ──────────────────────────────────
export function getTeamCode() {
  try { return localStorage.getItem(TEAM_CODE_KEY); } catch (_) { return null; }
}

export function setTeamCode(code) {
  try {
    if (code) localStorage.setItem(TEAM_CODE_KEY, code);
    else localStorage.removeItem(TEAM_CODE_KEY);
  } catch (_) { /* ignore */ }
  _client = null; // force re-create with new headers
}

// ── Lazy Supabase client ─────────────────────────────────────────────────────
let _client = null;
function client() {
  if (_client) return _client;
  if (!URL || !ANON_KEY) {
    throw new Error('Supabase URL/anon key not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }
  const headers = {};
  const code = getTeamCode();
  if (code) headers['x-team-code'] = code;
  _client = createClient(URL, ANON_KEY, { global: { headers } });
  return _client;
}

// ── Snake/camel converters ───────────────────────────────────────────────────
const toSnake = (s) => s.replace(/([A-Z0-9]+)/g, (_, c, i) => (i > 0 ? '_' : '') + c.toLowerCase());
const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

function camelizeRow(obj) {
  if (!obj) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[toCamel(k)] = v;
  return out;
}
function snakeifyRow(obj) {
  if (!obj) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[toSnake(k)] = v;
  return out;
}
function camelizeMany(rows) { return Array.isArray(rows) ? rows.map(camelizeRow) : []; }

async function _injectTeamId(row) {
  // For team-scoped writes, ensure team_id is set. We resolve the current
  // team's id by selecting from the teams table (RLS allows the current team
  // to be read).
  if (row.team_id || row.teamId) return row;
  const code = getTeamCode();
  if (!code) throw new Error('No team code — call setTeamCode() before writing');
  const { data, error } = await client().from('teams').select('id').eq('code', code).single();
  if (error || !data) throw new Error(`team lookup failed: ${error?.message ?? 'no team for code'}`);
  return { ...row, team_id: data.id };
}

function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// ── openDB / closeDB shims (no-op for API; kept for shape parity) ───────────
export async function openDB() { return null; }
export function closeDB() { _client = null; }
export const _resetDBCache = closeDB;

// ── Generic helpers ──────────────────────────────────────────────────────────
async function tablePut(table, row, opts = {}) {
  const snake = snakeifyRow(row);
  const withTeam = opts.scoped ? await _injectTeamId(snake) : snake;
  unwrap(await client().from(table).upsert(withTeam, opts.upsertOpts));
  return row;
}
async function tableBulkPut(table, rows, opts = {}) {
  if (!rows || rows.length === 0) return [];
  const snake = rows.map(snakeifyRow);
  const withTeam = opts.scoped ? await Promise.all(snake.map(_injectTeamId)) : snake;
  unwrap(await client().from(table).upsert(withTeam, opts.upsertOpts));
  return rows;
}
async function tableGet(table, key, keyCol = 'id') {
  const { data, error } = await client().from(table).select('*').eq(keyCol, key).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? camelizeRow(data) : undefined;
}
async function tableGetAll(table) {
  const data = unwrap(await client().from(table).select('*'));
  return camelizeMany(data);
}
async function tableDelete(table, key, keyCol = 'id') {
  unwrap(await client().from(table).delete().eq(keyCol, key));
}
async function tableQueryEq(table, col, val) {
  const data = unwrap(await client().from(table).select('*').eq(col, val));
  return camelizeMany(data);
}
async function tableDeleteEq(table, col, val) {
  unwrap(await client().from(table).delete().eq(col, val));
}

// ── registry ─────────────────────────────────────────────────────────────────
export const registry = {
  put: (r) => tablePut(STORES.REGISTRY, r, { scoped: true }),
  get: (id) => tableGet(STORES.REGISTRY, id),
  list: () => tableGetAll(STORES.REGISTRY),
  remove: (id) => tableDelete(STORES.REGISTRY, id),
  byWallet: (addr) => tableQueryEq(STORES.REGISTRY, 'wallet_addr', addr.toLowerCase()),
  active: async () => {
    const data = unwrap(
      await client().from(STORES.REGISTRY).select('*').eq('status', 'active')
    );
    return camelizeMany(data);
  },
};

// ── accounts ─────────────────────────────────────────────────────────────────
export const accounts = {
  put: (a) => tablePut(STORES.ACCOUNTS, a, { upsertOpts: { onConflict: 'registry_id' } }),
  get: (registryId) => tableGet(STORES.ACCOUNTS, registryId, 'registry_id'),
  remove: (registryId) => tableDelete(STORES.ACCOUNTS, registryId, 'registry_id'),
};

// ── trades ───────────────────────────────────────────────────────────────────
export const trades = {
  put: (t) => tablePut(STORES.TRADES, t, { scoped: true }),
  bulkPut: (ts) => tableBulkPut(STORES.TRADES, ts, { scoped: true }),
  get: (id) => tableGet(STORES.TRADES, id),
  list: () => tableGetAll(STORES.TRADES),
  forRegistry: (registryId) => tableQueryEq(STORES.TRADES, 'registry_id', registryId),
  deleteForRegistry: (registryId) => tableDeleteEq(STORES.TRADES, 'registry_id', registryId),
};

// ── positions ────────────────────────────────────────────────────────────────
export const positions = {
  put: (p) => tablePut(STORES.POSITIONS, p, { scoped: true }),
  bulkPut: (ps) => tableBulkPut(STORES.POSITIONS, ps, { scoped: true }),
  get: (id) => tableGet(STORES.POSITIONS, id),
  list: () => tableGetAll(STORES.POSITIONS),
  forRegistry: (registryId) => tableQueryEq(STORES.POSITIONS, 'registry_id', registryId),
  openForRegistry: async (registryId) => {
    const data = unwrap(
      await client().from(STORES.POSITIONS).select('*')
        .eq('registry_id', registryId).eq('is_resolved', false)
    );
    return camelizeMany(data);
  },
  deleteForRegistry: (registryId) => tableDeleteEq(STORES.POSITIONS, 'registry_id', registryId),
};

// ── marketCache (NOT team-scoped — token IDs are public market data) ────────
export const marketCache = {
  put: (entry) => tablePut(STORES.MARKET_CACHE, entry, { upsertOpts: { onConflict: 'cache_key' } }),
  get: (cacheKey) => tableGet(STORES.MARKET_CACHE, cacheKey, 'cache_key'),
  remove: (cacheKey) => tableDelete(STORES.MARKET_CACHE, cacheKey, 'cache_key'),
};

// ── Team management — used by TeamGate (Batch 2.3) ──────────────────────────
function makeCode(len = 7) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skip 0/O/1/I for clarity
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function createTeam(name = null) {
  // Server doesn't enforce auth on insert; row visible only via header on subsequent reads.
  let code, attempts = 0;
  while (attempts < 5) {
    code = makeCode();
    const { error } = await client().from('teams').insert({ code, name });
    if (!error) {
      setTeamCode(code);
      return { code, name };
    }
    if (!String(error.message).includes('duplicate')) throw new Error(error.message);
    attempts++;
  }
  throw new Error('Could not allocate unique team code after 5 attempts');
}

export async function joinTeam(code) {
  const trimmed = String(code || '').trim().toUpperCase();
  setTeamCode(trimmed); // headers picked up on next call
  const { data, error } = await client().from('teams').select('id, code, name').eq('code', trimmed).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    setTeamCode(null);
    throw new Error('No team with that code');
  }
  return data;
}

export function leaveTeam() {
  setTeamCode(null);
}
