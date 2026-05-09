// Backend switcher. Consumers import from this module; under the hood it's
// either browser IndexedDB (Phase 1, default) or Supabase (Phase 2).
//
// Controlled by VITE_STORAGE_MODE env var:
//   'idb' (default) — usePaperDB.js (IndexedDB)
//   'api'           — paperApi.js   (Supabase)
//
// Same surface area on both: registry / accounts / trades / positions /
// marketCache helpers + openDB / closeDB. Internals differ; consumers don't care.

import * as idb from './usePaperDB.js';
import * as api from './paperApi.js';

const mode = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_STORAGE_MODE) || 'idb';
const backend = mode === 'api' ? api : idb;

export const STORAGE_MODE = mode;

export const registry    = backend.registry;
export const accounts    = backend.accounts;
export const trades      = backend.trades;
export const positions   = backend.positions;
export const marketCache = backend.marketCache;

export const openDB        = backend.openDB        ?? (async () => null);
export const closeDB       = backend.closeDB       ?? (() => {});
export const _resetDBCache = backend._resetDBCache ?? (() => {});

// Team-code helpers — only meaningful in 'api' mode. In 'idb' they're no-ops.
export const getTeamCode  = api.getTeamCode  ?? (() => null);
export const setTeamCode  = api.setTeamCode  ?? (() => {});
export const createTeam   = api.createTeam   ?? (async () => { throw new Error('Team mode requires VITE_STORAGE_MODE=api'); });
export const joinTeam     = api.joinTeam     ?? (async () => { throw new Error('Team mode requires VITE_STORAGE_MODE=api'); });
export const leaveTeam    = api.leaveTeam    ?? (() => {});
