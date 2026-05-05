import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDB,
  _resetDBCache,
  registry,
  accounts,
  trades,
  positions,
  marketCache,
} from '../usePaperDB.js';
import { DB_NAME } from '../constants.js';

beforeEach(async () => {
  // Wipe the IDB between tests for isolation
  _resetDBCache();
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe('openDB', () => {
  it('creates all 5 stores on first open', async () => {
    const db = await openDB();
    const names = Array.from(db.objectStoreNames).sort();
    expect(names).toEqual([
      'pt_accounts',
      'pt_market_cache',
      'pt_positions',
      'pt_registry',
      'pt_trades',
    ]);
  });

  it('returns the same DB instance on repeat calls', async () => {
    const db1 = await openDB();
    const db2 = await openDB();
    expect(db1).toBe(db2);
  });
});

describe('registry CRUD', () => {
  const sample = {
    id: 'reg-1',
    walletAddr: '0xabc',
    nickname: 'Whale Alpha',
    startBalance: 100,
    status: 'active',
    createdAt: 1_700_000_000_000,
  };

  it('put + get round-trip', async () => {
    await registry.put(sample);
    const got = await registry.get('reg-1');
    expect(got).toEqual(sample);
  });

  it('list returns all rows', async () => {
    await registry.put(sample);
    await registry.put({ ...sample, id: 'reg-2', nickname: 'B' });
    const list = await registry.list();
    expect(list).toHaveLength(2);
  });

  it('byWallet uses index and lowercases input', async () => {
    await registry.put(sample);
    const got = await registry.byWallet('0xABC');
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe('reg-1');
  });

  it('active filters by status', async () => {
    await registry.put(sample);
    await registry.put({ ...sample, id: 'reg-2', status: 'paused' });
    const act = await registry.active();
    expect(act).toHaveLength(1);
    expect(act[0].id).toBe('reg-1');
  });

  it('remove deletes the row', async () => {
    await registry.put(sample);
    await registry.remove('reg-1');
    expect(await registry.get('reg-1')).toBeUndefined();
  });
});

describe('trades and positions indexed by registryId', () => {
  it('forRegistry returns only that registry’s trades', async () => {
    await trades.bulkPut([
      { id: 't1', registryId: 'r1', conditionId: 'c1', openedAt: 1 },
      { id: 't2', registryId: 'r1', conditionId: 'c2', openedAt: 2 },
      { id: 't3', registryId: 'r2', conditionId: 'c1', openedAt: 3 },
    ]);
    const r1 = await trades.forRegistry('r1');
    expect(r1.map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('positions.openForRegistry filters resolved out', async () => {
    await positions.bulkPut([
      { id: 'p1', registryId: 'r1', conditionId: 'c1', isResolved: false },
      { id: 'p2', registryId: 'r1', conditionId: 'c2', isResolved: true },
    ]);
    const open = await positions.openForRegistry('r1');
    expect(open.map((p) => p.id)).toEqual(['p1']);
  });
});

describe('accounts and marketCache', () => {
  it('account put + get', async () => {
    const a = { registryId: 'r1', cash: 100, peakBalance: 100, createdAt: 0 };
    await accounts.put(a);
    expect(await accounts.get('r1')).toEqual(a);
  });

  it('marketCache key is cacheKey, stores arbitrary JSON-shaped data', async () => {
    const entry = {
      cacheKey: 'tokens:0xabc',
      data: JSON.stringify({ yes: 'token-yes', no: 'token-no' }),
      fetchedAt: Date.now(),
      ttlSec: null,
    };
    await marketCache.put(entry);
    const got = await marketCache.get('tokens:0xabc');
    expect(got).toEqual(entry);
  });
});
