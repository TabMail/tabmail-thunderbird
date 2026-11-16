import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: {
  agentQueues: { ftsRemovedAccountPurge: { pageKeys: 2 } },
  memoryManagement: { nativeRpcTimeoutMs: 60000,
    memorySizeLimitDefaultBytes: 1024 ** 3, memorySizeLimitChoicesBytes: [1024 ** 3] },
} }));

const flush = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete globalThis.browser;
});

// The real native adapter, engine, coordinator and purge over a helper port
// whose writer queue can stall while its reader keeps answering.
async function start() {
  vi.resetModules();
  vi.useFakeTimers();
  const storage = {};
  const rows = new Map([['account2:INBOX:kept@example.com', 'invoice from the other account']]);
  const listeners = new Set();
  const methods = [];
  let pendingIndex = null;
  let releaseWriter = null;
  let writerReleased = false;
  const queuedWrites = [];
  globalThis.browser = {
    accounts: { onDeleted: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
    storage: { local: {
      get: async key => typeof key === 'string'
        ? (key in storage ? { [key]: structuredClone(storage[key]) } : {})
        : { ...key, ...structuredClone(storage) },
      set: async value => { Object.assign(storage, structuredClone(value)); },
    } },
    tmMsgNotify: { getFtsDataDir: async () => '/test/profile/extension-data' },
    tmUpdates: { showUpdateBar: vi.fn(async () => {}) },
    runtime: {
      getManifest: () => ({ version: '1.9.3' }),
      getPlatformInfo: async () => ({ os: 'mac', arch: 'aarch64' }),
      sendMessage: vi.fn(async () => undefined),
      connectNative: () => {
        const receives = [];
        const answer = (msg, result) => queueMicrotask(() => receives.forEach(fn => fn({ id: msg.id, result })));
        return {
          onMessage: { addListener: fn => receives.push(fn) },
          onDisconnect: { addListener() {} },
          disconnect() {},
          postMessage(msg) {
            methods.push(msg.method);
            let result = { ok: true };
            if (msg.method === 'hello') result = { hostVersion: '0.11.5', schemaVersion: 1,
              canSelfUpdate: false, capabilities: { folderMembershipV1: true,
                memorySizeLimitV1: true, memoryPreviewV1: true, memoryFilterBeforeLimitV1: true } };
            if (msg.method === 'init') result = { dbPath: '/test/profile/index.sqlite' };
            if (msg.method === 'indexBatch') {
              pendingIndex = msg;
              // The native writer is occupied. Reader RPCs use another
              // connection and continue answering from committed state.
              releaseWriter = () => {
                writerReleased = true;
                for (const row of msg.params.rows) rows.set(row.msgId, row.body);
                answer(msg, { ok: true, count: msg.params.rows.length });
                for (const queued of queuedWrites) queued();
              };
              return;
            }
            if (msg.method === 'listMsgIdRange' || msg.method === 'countMsgIdRange') {
              const { startKey, endKey, afterKey, limit } = msg.params;
              const keys = [...rows.keys()].sort().filter(k => k >= startKey && k < endKey && (afterKey == null || k > afterKey));
              result = msg.method === 'countMsgIdRange' ? { count: keys.length }
                : { msgIds: keys.slice(0, limit), done: keys.length <= limit };
            }
            if (msg.method === 'removeBatch') {
              const remove = () => {
                for (const key of msg.params.ids) rows.delete(key);
                answer(msg, { ok: true, count: msg.params.ids.length });
              };
              if (pendingIndex && !writerReleased) queuedWrites.push(remove);
              else remove();
              return;
            }
            if (msg.method === 'search') result = [...rows].filter(([, body]) => body.includes(msg.params.q)).map(([msgId]) => ({ msgId }));
            answer(msg, result);
          },
        };
      },
    },
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ latest: { version: '0.11.5' } }) })));
  const native = await import('../fts/nativeEngine.js');
  const engine = await import('../fts/engine.js');
  const purge = await import('../fts/removedAccountPurge.js');
  await native.initNativeFts();
  purge.setupRemovedAccountPurgeListeners();
  await purge.initRemovedAccountPurge(engine.ftsSearch);

  return { storage, rows, listeners, methods, engine, purge,
    get pendingIndex() { return pendingIndex; }, releaseWriter: () => releaseWriter() };
}

it('keeps a removed account absent after an already-dispatched native write times out then commits', async () => {
  const t = await start();
  const { storage, rows, listeners, methods, engine, purge } = t;
  const writeResult = engine.ftsSearch.indexBatch([{ msgId: 'account1:INBOX:late@example.com',
    folderId: 'tm-folder:v1:["account1","INBOX"]', body: 'late invoice' }]).catch(e => e);
  await flush();
  expect(t.pendingIndex?.method).toBe('indexBatch');
  for (const listener of listeners) listener('account1');
  await flush();
  await vi.advanceTimersByTimeAsync(60001);
  const writeError = await writeResult;
  expect(writeError.message).toContain('timed out');
  await flush();
  expect(purge.isRemovedAccountKey('account1:INBOX:late@example.com')).toBe(true);

  t.releaseWriter();
  await flush();
  const purgeIdle = purge._removedAccountPurgeIdleForTests();
  await vi.advanceTimersByTimeAsync(1);
  await purgeIdle;
  expect(storage.fts_removed_account_purges).toEqual([]);
  expect(methods).toContain('countMsgIdRange');
  const hits = await engine.ftsSearch.search('invoice');
  expect(rows.has('account2:INBOX:kept@example.com')).toBe(true);
  purge._resetRemovedAccountPurgeForTests();
  expect(hits.filter(hit => hit.msgId.startsWith('account1:'))).toEqual([]);
});

it('keeps the record when the writer queue does not acknowledge before the purge lists', async () => {
  const t = await start();
  const { storage, rows, listeners, engine, purge } = t;
  engine.ftsSearch.indexBatch([{ msgId: 'account1:INBOX:late@example.com',
    folderId: 'tm-folder:v1:["account1","INBOX"]', body: 'late invoice' }]).catch(() => {});
  await flush();
  expect(t.pendingIndex?.method).toBe('indexBatch');
  for (const listener of listeners) listener('account1');
  await flush();
  // The stalled write and then the purge's queued acknowledgment time out.
  await vi.advanceTimersByTimeAsync(60001);
  await flush();
  const purgeIdle = purge._removedAccountPurgeIdleForTests();
  await vi.advanceTimersByTimeAsync(60001);
  await flush();
  await vi.advanceTimersByTimeAsync(1);
  await purgeIdle;
  expect(storage.fts_removed_account_purges).toEqual(['account1']);
  purge._resetRemovedAccountPurgeForTests();
  expect(rows.has('account2:INBOX:kept@example.com')).toBe(true);
});
