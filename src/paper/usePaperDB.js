import { DB_NAME, DB_VERSION, STORES } from './constants.js';

let _db = null;
let _dbPromise = null;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(STORES.REGISTRY)) {
        const s = db.createObjectStore(STORES.REGISTRY, { keyPath: 'id' });
        s.createIndex('walletAddr', 'walletAddr', { unique: false });
        s.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.ACCOUNTS)) {
        db.createObjectStore(STORES.ACCOUNTS, { keyPath: 'registryId' });
      }
      if (!db.objectStoreNames.contains(STORES.TRADES)) {
        const s = db.createObjectStore(STORES.TRADES, { keyPath: 'id' });
        s.createIndex('registryId', 'registryId', { unique: false });
        s.createIndex('byRegistryAndOpened', ['registryId', 'openedAt'], { unique: false });
        s.createIndex('conditionId', 'conditionId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.POSITIONS)) {
        const s = db.createObjectStore(STORES.POSITIONS, { keyPath: 'id' });
        s.createIndex('registryId', 'registryId', { unique: false });
        s.createIndex('byRegistryAndResolved', ['registryId', 'isResolved'], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.MARKET_CACHE)) {
        db.createObjectStore(STORES.MARKET_CACHE, { keyPath: 'cacheKey' });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      // Auto-close if another tab/test wants to upgrade or delete
      _db.onversionchange = () => {
        _db?.close();
        _db = null;
        _dbPromise = null;
      };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

// Closes the open connection and clears the cached promise.
// Required before calling indexedDB.deleteDatabase(DB_NAME).
export function closeDB() {
  if (_db) {
    try { _db.close(); } catch (_) {}
  }
  _db = null;
  _dbPromise = null;
}

// Back-compat alias used by tests; calls closeDB.
export const _resetDBCache = closeDB;

function tx(db, storeName, mode = 'readonly') {
  const t = db.transaction(storeName, mode);
  return { tx: t, store: t.objectStore(storeName) };
}

function awaitTx(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function awaitReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(storeName, value) {
  const db = await openDB();
  const { tx: t, store } = tx(db, storeName, 'readwrite');
  store.put(value);
  await awaitTx(t);
  return value;
}

export async function bulkPut(storeName, values) {
  if (!values || values.length === 0) return [];
  const db = await openDB();
  const { tx: t, store } = tx(db, storeName, 'readwrite');
  for (const v of values) store.put(v);
  await awaitTx(t);
  return values;
}

export async function get(storeName, key) {
  const db = await openDB();
  const { store } = tx(db, storeName);
  return awaitReq(store.get(key));
}

export async function getAll(storeName) {
  const db = await openDB();
  const { store } = tx(db, storeName);
  return awaitReq(store.getAll());
}

export async function del(storeName, key) {
  const db = await openDB();
  const { tx: t, store } = tx(db, storeName, 'readwrite');
  store.delete(key);
  await awaitTx(t);
}

export async function clear(storeName) {
  const db = await openDB();
  const { tx: t, store } = tx(db, storeName, 'readwrite');
  store.clear();
  await awaitTx(t);
}

// Get all records matching an indexed value. e.g. tradesForRegistry(id) →
// queryByIndex('pt_trades', 'registryId', id)
export async function queryByIndex(storeName, indexName, value) {
  const db = await openDB();
  const { store } = tx(db, storeName);
  const idx = store.index(indexName);
  return awaitReq(idx.getAll(value));
}

// Bulk delete by indexed value — used when wiping all rows for a registry.
export async function deleteByIndex(storeName, indexName, value) {
  const db = await openDB();
  const { tx: t, store } = tx(db, storeName, 'readwrite');
  const idx = store.index(indexName);
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(value);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });
  await awaitTx(t);
}

// ── Convenience helpers per store ────────────────────────────────────────────

export const registry = {
  put: (r) => put(STORES.REGISTRY, r),
  get: (id) => get(STORES.REGISTRY, id),
  list: () => getAll(STORES.REGISTRY),
  remove: (id) => del(STORES.REGISTRY, id),
  byWallet: (addr) => queryByIndex(STORES.REGISTRY, 'walletAddr', addr.toLowerCase()),
  active: async () => {
    const all = await getAll(STORES.REGISTRY);
    return all.filter((r) => r.status === 'active');
  },
};

export const accounts = {
  put: (a) => put(STORES.ACCOUNTS, a),
  get: (registryId) => get(STORES.ACCOUNTS, registryId),
  remove: (registryId) => del(STORES.ACCOUNTS, registryId),
};

export const trades = {
  put: (t) => put(STORES.TRADES, t),
  bulkPut: (ts) => bulkPut(STORES.TRADES, ts),
  get: (id) => get(STORES.TRADES, id),
  list: () => getAll(STORES.TRADES),
  forRegistry: (registryId) => queryByIndex(STORES.TRADES, 'registryId', registryId),
  deleteForRegistry: (registryId) => deleteByIndex(STORES.TRADES, 'registryId', registryId),
};

export const positions = {
  put: (p) => put(STORES.POSITIONS, p),
  bulkPut: (ps) => bulkPut(STORES.POSITIONS, ps),
  get: (id) => get(STORES.POSITIONS, id),
  list: () => getAll(STORES.POSITIONS),
  forRegistry: (registryId) => queryByIndex(STORES.POSITIONS, 'registryId', registryId),
  openForRegistry: async (registryId) => {
    const all = await queryByIndex(STORES.POSITIONS, 'registryId', registryId);
    return all.filter((p) => !p.isResolved);
  },
  deleteForRegistry: (registryId) => deleteByIndex(STORES.POSITIONS, 'registryId', registryId),
};

export const marketCache = {
  put: (entry) => put(STORES.MARKET_CACHE, entry),
  get: (cacheKey) => get(STORES.MARKET_CACHE, cacheKey),
  remove: (cacheKey) => del(STORES.MARKET_CACHE, cacheKey),
};
