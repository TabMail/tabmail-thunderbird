import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: null, helperReady: false, onReady: null }));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { agentQueues: { ftsRemovedAccountPurge: { pageKeys: 2 } } },
}));
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../fts/nativeEngine.js', () => ({
  initNativeFts: async () => { h.helperReady = true; h.onReady?.(); },
  nativeMemorySearch: {},
  nativeFtsSearch: {
    checkReindexNeeded: async () => ({ needsReindex: false, isFirstRun: false }),
    stats: async () => ({ docs: 0, vecDocs: 0 }),
    listMsgIdRange: async (start, end, after, limit) => {
      const keys = [...h.rows.keys()].sort().filter(k => k >= start && k < end && (after == null || k > after));
      return { msgIds: keys.slice(0, limit), done: keys.length <= limit };
    },
    countMsgIdRange: async (start, end) => ({ count: [...h.rows.keys()].filter(k => k >= start && k < end).length }),
    removeBatch: async ids => { for (const id of ids) h.rows.delete(id); return { count: ids.length }; },
    search: async term => [...h.rows].filter(([, body]) => body.includes(term)).map(([msgId]) => ({ msgId })),
  },
}));
vi.mock('../fts/incrementalIndexer.js', () => ({ initIncrementalIndexer: async () => {} }));
vi.mock('../fts/maintenanceScheduler.js', () => ({ initMaintenanceScheduler: async () => {} }));
vi.mock('../fts/memoryIndexer.js', () => ({ migrateExistingChatHistory: async () => ({ migrated: false }) }));
vi.mock('../fts/attachmentFlags.js', () => ({ getAttachmentRepairedAccounts: async () => new Set() }));

afterEach(() => { delete globalThis.browser; });

it('purges an observed removal during a startup storage outage once the native helper is already ready', async () => {
  vi.resetModules();
  h.helperReady = false;
  h.rows = new Map([
    ['account1:INBOX:removed@example.com', 'invoice'],
    ['account2:INBOX:kept@example.com', 'invoice'],
  ]);
  let storageFails = false;
  // The setting read and native bootstrap may succeed. The outage begins
  // immediately after operational native readiness, before scan-status I/O.
  h.onReady = () => { storageFails = true; };
  const storage = {};
  const listeners = new Set();
  globalThis.browser = {
    accounts: { list: async () => [], onDeleted: {
      addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    } },
    runtime: {
      sendMessage: async () => {},
      onMessage: { addListener() {}, removeListener() {} },
    },
    storage: { local: {
      get: async key => { if (storageFails) throw new Error('storage unreadable'); return { [key]: storage[key] }; },
      set: async value => { if (storageFails) throw new Error('storage unwritable'); Object.assign(storage, value); },
    } },
  };
  const firstEngine = await import('../fts/engine.js');
  const firstPurge = await import('../fts/removedAccountPurge.js');
  firstPurge.setupRemovedAccountPurgeListeners();
  await expect(firstEngine.initFtsEngine()).rejects.toThrow('storage unreadable');
  expect(h.helperReady).toBe(true);
  expect(listeners.size).toBe(1);
  for (const listener of listeners) listener('account1');
  await firstPurge._removedAccountPurgeIdleForTests();
  expect(firstPurge.isRemovedAccountKey('account1:INBOX:removed@example.com')).toBe(true);
  expect(storage.fts_removed_account_purges).toBeUndefined();

  firstPurge._resetRemovedAccountPurgeForTests();
  vi.resetModules();
  storageFails = false;
  h.onReady = null;
  const nextEngine = await import('../fts/engine.js');
  const nextPurge = await import('../fts/removedAccountPurge.js');
  await nextEngine.initFtsEngine();
  await nextPurge._removedAccountPurgeIdleForTests();
  const hits = await nextEngine.ftsSearch.search('invoice');
  nextPurge._resetRemovedAccountPurgeForTests();
  expect(h.rows.has('account2:INBOX:kept@example.com')).toBe(true);
  expect(hits.filter(hit => hit.msgId.startsWith('account1:'))).toEqual([]);
});
