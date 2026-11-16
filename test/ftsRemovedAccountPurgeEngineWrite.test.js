import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real engine, coordinator and purge over a native index stand-in: an
// index write read before an account's removal never lands after its purge.
const h = vi.hoisted(() => ({ store: null, holdIndex: null }));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { agentQueues: { ftsRemovedAccountPurge: { pageKeys: 2 } } },
}));
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../fts/nativeEngine.js', () => {
  const sorted = () => [...h.store.keys()].sort();
  const inRange = (k, s, e) => k >= s && k < e;
  return {
    initNativeFts: vi.fn(async () => {}),
    nativeMemorySearch: {},
    nativeFtsSearch: {
      async indexBatch(rows) {
        if (h.holdIndex) await h.holdIndex;
        for (const row of rows) h.store.set(row.msgId, row.body);
        return { count: rows.length };
      },
      async removeBatch(ids) {
        for (const id of ids) h.store.delete(id);
        return { removed: ids.length };
      },
      async listMsgIdRange(startKey, endKey, afterKey, limit) {
        const keys = sorted().filter(k => inRange(k, startKey, endKey) && (afterKey == null || k > afterKey));
        return { msgIds: keys.slice(0, limit), done: keys.length < limit };
      },
      async countMsgIdRange(startKey, endKey) {
        return { count: sorted().filter(k => inRange(k, startKey, endKey)).length };
      },
    },
  };
});

let accounts;
let storage;

function makeEvent() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    fire: (...a) => { for (const fn of listeners) fn(...a); } };
}

beforeEach(() => {
  vi.resetModules();
  h.store = new Map([
    ['account1:INBOX:a@example.com', 'invoice'],
    ['account2:INBOX:b@example.com', 'invoice'],
  ]);
  h.holdIndex = null;
  storage = {};
  accounts = { onDeleted: makeEvent() };
  globalThis.browser = {
    accounts,
    storage: { local: {
      get: async key => (key in storage ? { [key]: structuredClone(storage[key]) } : {}),
      set: async obj => { Object.assign(storage, structuredClone(obj)); },
    } },
  };
});

afterEach(() => {
  delete globalThis.browser;
});

const account1Rows = () => [...h.store.keys()].filter(k => k.startsWith('account1:'));

async function load() {
  const engine = await import('../fts/engine.js');
  const purge = await import('../fts/removedAccountPurge.js');
  purge.setupRemovedAccountPurgeListeners();
  await purge.initRemovedAccountPurge(engine.ftsSearch);
  return { engine, purge };
}

describe('index writes against a removed account', () => {
  it('a batch already being written when the account is removed is gone once the purge ends', async () => {
    const { engine, purge } = await load();
    let release;
    h.holdIndex = new Promise(resolve => { release = resolve; });
    const write = engine.ftsSearch.indexBatch([{ msgId: 'account1:INBOX:late@example.com', body: 'late invoice' }]);
    await new Promise(resolve => setTimeout(resolve, 0));
    accounts.onDeleted.fire('account1');
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    await write;
    await purge._removedAccountPurgeIdleForTests();
    expect(account1Rows()).toEqual([]);
    expect(h.store.has('account2:INBOX:b@example.com')).toBe(true);
    purge._resetRemovedAccountPurgeForTests();
  });

  it('a batch read before the removal and written after the purge is refused', async () => {
    const { engine, purge } = await load();
    accounts.onDeleted.fire('account1');
    await purge._removedAccountPurgeIdleForTests();
    expect(account1Rows()).toEqual([]);

    const result = await engine.ftsSearch.indexBatch([
      { msgId: 'account1:INBOX:late@example.com', body: 'late invoice' },
      { msgId: 'account2:INBOX:c@example.com', body: 'invoice' },
    ]);
    expect(result.count).toBe(1);
    expect(account1Rows()).toEqual([]);
    expect(h.store.has('account2:INBOX:c@example.com')).toBe(true);
    purge._resetRemovedAccountPurgeForTests();
  });
});
