import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { createHash } from 'node:crypto';
import { setImmediate as realImmediate } from 'node:timers/promises';

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { agentQueues: { ftsIncremental: {} }, eventLogger: { enabled: false } },
}));
vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsBatchOperation: vi.fn(), logFtsOperation: vi.fn(),
  logMessageEventBatch: vi.fn(), logMoveEvent: vi.fn(),
}));
vi.mock('../agent/modules/utils.js', () => ({
  getForegroundFetchPressure: vi.fn(() => ({ active: 0, waiting: 0, chatTyping: false })),
  headerIDToWeID: vi.fn(),
  log: vi.fn(),
  parseUniqueId: vi.fn((uniqueId) => {
    if (!uniqueId || typeof uniqueId !== 'string') return null;
    const i1 = uniqueId.indexOf(':');
    const i2 = uniqueId.indexOf(':', i1 + 1);
    if (i1 < 0 || i2 < 0 || i2 === uniqueId.length - 1) return null;
    return {
      weFolder: { accountId: uniqueId.slice(0, i1), path: uniqueId.slice(i1 + 1, i2) },
      headerID: uniqueId.slice(i2 + 1),
    };
  }),
  recheckMessageInFolder: vi.fn(async () => 'absent'),
  getUniqueMessageKey: vi.fn(),
}));

vi.mock('../fts/indexer.js', () => ({
  buildBatchHeader: vi.fn(), populateBatchBody: vi.fn(),
}));

const stored = {};
globalThis.browser = { storage: { local: {
  get: vi.fn(async value => typeof value === 'string'
    ? { [value]: stored[value] } : Array.isArray(value)
      ? Object.fromEntries(value.map(key => [key, stored[key]]))
      : Object.fromEntries(Object.entries(value).map(([key, fallback]) => [key, stored[key] ?? fallback]))),
  set: vi.fn(async value => Object.assign(stored, structuredClone(value))),
  remove: vi.fn(async keys => { for (const key of [keys].flat()) delete stored[key]; }),
} } };

const indexer = await import('../fts/incrementalIndexer.js');
const experimentSource = readFileSync(
  new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url), 'utf8',
);
const work = [];
const header = {
  folder: { URI: 'mailbox://synthetic/Inbox' },
  messageId: 'added@example.test', messageKey: 17,
  subject: 'Synthetic', author: 'sender@example.test', flags: 0,
};

function bridge() {
  const native = new Set();
  const extension = {
    folderManager: { convert: folder => ({
      id: folder.URI, path: '/Inbox', accountId: 'synthetic',
    }) },
    messageManager: { convert: () => ({ id: 17 }) },
  };

  class EventManager {
    constructor(options) { this.options = options; }

    api() {
      const subscriptions = new Map();
      const { extensionApi, event } = this.options;
      return {
        addListener(fn) {
          if (subscriptions.has(fn)) return;
          const registration = extensionApi.PERSISTENT_EVENTS[event]({ fire: {
            async(value) {
              const pending = Promise.resolve(fn(value));
              work.push(pending);
              return pending;
            },
          } });
          subscriptions.set(fn, registration);
        },
        removeListener(fn) {
          subscriptions.get(fn)?.unregister();
          subscriptions.delete(fn);
        },
      };
    }
  }

  const scope = {
    ChromeUtils: { importESModule(path) {
      if (path.includes('ExtensionCommon')) return { ExtensionCommon: {
        ExtensionAPIPersistent: class {
          constructor(value) { this.extension = value; }
          primeListener(event, fire) { return this.PERSISTENT_EVENTS[event]({ fire }); }
        },
        EventManager,
      } };
      if (path.includes('MailServices')) return { MailServices: { mfn: {
        addListener: listener => native.add(listener),
        removeListener: listener => native.delete(listener),
      } } };
      if (path.includes('MailUtils')) return { MailUtils: {} };
      if (path.includes('Timer')) return { setInterval: () => 1, clearInterval() {} };
      throw new Error(path);
    } },
    console: { log() {}, error: vi.fn() },
    Ci: { nsMsgMessageFlags: { IMAPDeleted: 1, Expunged: 2 } },
  };
  vm.runInNewContext(`${experimentSource}\nthis.Experiment = tmMsgNotify;`, scope);
  const instance = new scope.Experiment(extension);
  browser.tmMsgNotify = instance.getAPI({ extension }).tmMsgNotify;
  return { instance, native, getListener: () => [...native][0] };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const key of Object.keys(stored)) delete stored[key];
  work.length = 0;
  indexer._testExports._getPendingUpdates().clear();
  indexer._testExports._setExperimentListenersActive(false);
  indexer._testExports._setIsEnabled(false);
});

afterEach(async () => {
  await indexer.disposeIncrementalIndexer();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function framedDigest(keys) {
  const hash = createHash('sha256');
  const encoded = [...keys].map(key => Buffer.from(key, 'utf8'));
  encoded.sort(Buffer.compare);
  for (const bytes of encoded) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function digest(keys) {
  return framedDigest(new Set(keys));
}

function sqliteBinaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function inRange(keys, start, end, after = null) {
  return [...keys]
    .filter(key => sqliteBinaryCompare(key, start) >= 0
      && sqliteBinaryCompare(key, end) < 0
      && (after == null || sqliteBinaryCompare(key, after) > 0))
    .sort(sqliteBinaryCompare);
}

function makeFtsStore(initialKeys = []) {
  const keys = new Set(initialKeys);
  return {
    _keys: keys,
    fingerprintMsgIdRange: vi.fn(async (start, end) => {
      const rows = inRange(keys, start, end);
      return { ok: true, count: rows.length, sha256: digest(rows) };
    }),
    countMsgIdRange: vi.fn(async (start, end) => ({
      ok: true,
      count: inRange(keys, start, end).length,
    })),
    listMsgIdRange: vi.fn(async (start, end, after, limit) => {
      const rows = inRange(keys, start, end, after);
      const page = rows.slice(0, limit);
      return { ok: true, msgIds: page, done: page.length < limit };
    }),
    removeBatch: vi.fn(async (ids) => {
      let count = 0;
      for (const id of ids) count += keys.delete(id) ? 1 : 0;
      return { ok: true, count };
    }),
    getMessageByMsgId: vi.fn(async (id) => (keys.has(id) ? { msgId: id } : null)),
    filterNewMessages: vi.fn(async (rows) => ({
      ok: true,
      newMsgIds: rows.map(row => row.msgId).filter(id => !keys.has(id)),
    })),
    stats: vi.fn(async () => ({ ok: true, docs: keys.size })),
  };
}

function mockNotify(folders, {
  actualKeysByURI = {},
  headerIdsByKeyByURI = {},
  msgDbByURI = {},
  keysByURI = {},
  infosByURI = {},
  probeErrorByURI = {},
} = {}) {
  const byURI = Object.fromEntries(folders.map(folder => [folder.folderURI, folder]));
  const byIdentity = Object.fromEntries(folders.map(folder => [`${folder.accountId}:${folder.folderPath}`, folder]));
  const grouped = new Map();
  for (const folder of folders) {
    if (!grouped.has(folder.accountId)) grouped.set(folder.accountId, []);
    grouped.get(folder.accountId).push({ path: folder.folderPath, subFolders: [] });
  }
  globalThis.browser.accounts.list.mockResolvedValue([...grouped].map(([id, subFolders]) => ({
    id,
    type: folders.find(folder => folder.accountId === id)?.serverType || 'imap',
    rootFolder: { path: '/', isRoot: true, subFolders },
  })));
  let nextScan = 1;
  const scans = new Map();
  const scanRows = (uri) => {
    const folder = byURI[uri];
    const headerIdsByKey = headerIdsByKeyByURI[uri];
    if (headerIdsByKey) {
      return Object.entries(headerIdsByKey).map(([key, headerMessageId]) => ({
        msgKey: Number(key),
        headerMessageId,
      }));
    }
    const actual = actualKeysByURI[uri] || [];
    const numericKeys = keysByURI[uri] || [];
    const prefix = `${folder.accountId}:${folder.folderPath}:`;
    return actual.map((uniqueKey, index) => ({
      msgKey: numericKeys[index] ?? index + 1,
      headerMessageId: uniqueKey.slice(prefix.length),
    }));
  };
  const api = {
    getFolderState: vi.fn(async (accountId, folderPath) => byIdentity[`${accountId}:${folderPath}`]),
    beginFolderMessageScan: vi.fn(async (uri, includeMessageIds = true) => {
      const folder = byURI[uri];
      if (!folder) return { error: 'folder_not_found' };
      const token = `scan-${nextScan++}`;
      scans.set(token, { rows: scanRows(uri), offset: 0, includeMessageIds });
      return {
        token,
        accountId: folder.accountId,
        folderPath: folder.folderPath,
        stableUidKeys: folder.stableUidKeys,
        uidValidity: folder.uidValidity,
        highestModSeq: folder.highestModSeq,
      };
    }),
    readFolderMessageScanPage: vi.fn(async (token, maxItems) => {
      const scan = scans.get(token);
      if (!scan) return { rows: [], done: true, error: 'scan_not_found' };
      const rows = scan.rows.slice(scan.offset, scan.offset + maxItems).map(row => (
        scan.includeMessageIds ? row : { msgKey: row.msgKey }
      ));
      scan.offset += rows.length;
      const done = scan.offset >= scan.rows.length;
      if (done) scans.delete(token);
      return { rows, done };
    }),
    cancelFolderMessageScan: vi.fn(async token => ({ cancelled: scans.delete(token) })),
    probeMessageIds: vi.fn(async (uri, ids) => {
      if (probeErrorByURI[uri]) return { missing: [], error: probeErrorByURI[uri] };
      const present = msgDbByURI[uri] || new Set();
      return { missing: ids.filter(id => !present.has(id)) };
    }),
    listKeysAboveKey: vi.fn(async (uri, since) => {
      const keys = (keysByURI[uri] || []).filter(key => key > (since || 0)).sort((a, b) => a - b);
      return { keys, truncated: false, totalAbove: keys.length };
    }),
    getMessageInfosForKeys: vi.fn(async (uri, keys) => {
      if (infosByURI[uri]) return infosByURI[uri];
      const folder = byURI[uri];
      const headerIdsByKey = headerIdsByKeyByURI[uri];
      return {
        infos: keys.map(key => ({
          accountId: folder.accountId,
          folderPath: folder.folderPath,
          headerMessageId: headerIdsByKey?.[key] || `msg-${key}@example.com`,
          msgKey: key,
          subject: `subject ${key}`,
          eventType: 'cursorScan',
        })),
      };
    }),
  };
  globalThis.browser.tmMsgNotify = api;
  return api;
}


it('startup recovery removes a deletion replayed before FTS readiness and preserves a live row', async () => {
  const deleted = 'synthetic:/Inbox:removed@example.test';
  const live = 'synthetic:/Inbox:live@example.test';
  const folder = {
    accountId: 'synthetic', folderPath: '/Inbox', folderURI: header.folder.URI,
    serverType: 'imap', stableUidKeys: true, uidValidity: 7,
  };
  const engine = makeFtsStore();
  // This is the native index writer's contract, representing rows indexed in
  // the preceding session, before the background went to sleep.
  engine.indexBatch = vi.fn(async rows => {
    for (const row of rows) engine._keys.add(row.msgId);
    return { ok: true, count: rows.length };
  });
  await engine.indexBatch([{msgId: deleted}, {msgId: live}]);
  expect([...engine._keys].sort()).toEqual([live, deleted].sort());
  stored.fts_initial_scan_complete = true;
  browser.accounts = { list: vi.fn() };
  indexer._testExports._resetFolderReconState();
  const state = bridge();
  const events = browser.tmMsgNotify;
  const api = mockNotify([folder], {
    actualKeysByURI: { [folder.folderURI]: [live] },
    msgDbByURI: { [folder.folderURI]: new Set(['live@example.test']) },
  });
  Object.assign(events, api);
  browser.tmMsgNotify = events;
  await indexer.setupExperimentListeners();
  expect(state.native.size).toBe(1);
  state.getListener().msgsDeleted([{ ...header, messageId: 'removed@example.test' }]);
  await Promise.all(work);
  expect(work).toHaveLength(1);
  expect(indexer._testExports._getPendingUpdates().size).toBe(0);
  expect([...engine._keys].sort()).toEqual([live, deleted].sort());
  expect(engine.removeBatch).not.toHaveBeenCalled();

  // Exercise the public initializer and its actual timers; never call a
  // reconcile helper or substitute the scheduler's runner.
  await indexer.initIncrementalIndexer(engine);
  await vi.advanceTimersByTimeAsync(59_000);
  expect([...engine._keys].sort()).toEqual([live, deleted].sort());
  for (let tick = 0; tick < 100 && (engine._keys.has(deleted) || indexer._testExports._getPendingUpdates().size > 0); tick++) {
    await vi.advanceTimersByTimeAsync(1000);
    await realImmediate();
  }
  expect([...engine._keys]).toEqual([live]);
  expect(engine.removeBatch.mock.calls.flatMap(([keys]) => keys)).toEqual([deleted]);
  expect(api.probeMessageIds).toHaveBeenCalledWith(folder.folderURI, ['live@example.test', 'removed@example.test']);
  expect([...indexer._testExports._getPendingUpdates()]).toEqual([]);
  state.instance.onShutdown(false);
});

// The pending-update queue is not persisted (owner 2026-10-04): a previous
// session's stored queue is never applied, so its stale deletion cannot
// remove a row that is live now. The startup walk re-derives pending work.
it('never applies a previous session\'s stored queue: its stale deletion keeps a live row', async () => {
  const live = 'synthetic:/Inbox:live@example.test';
  const control = 'synthetic:/Inbox:other@example.test';
  const engine = makeFtsStore([live]);
  stored.fts_pending_updates = [live, control].map(uniqueKey => ({
    type: 'deleted', uniqueKey, folderKey: 'synthetic:/Inbox', timestamp: 1,
    hasFailed: false, lastFailedAt: 0, metadata: {},
  }));
  stored.chat_ftsIncrementalEnabled = true;
  stored.chat_ftsIncrementalBatchDelay = 5000;
  const state = bridge();
  await indexer.initIncrementalIndexer(engine);
  expect(indexer._testExports._getPendingUpdates().size).toBe(0);
  expect(stored.fts_pending_updates).toBeUndefined();

  await vi.advanceTimersByTimeAsync(5001);
  expect(engine.removeBatch).not.toHaveBeenCalled();
  expect([...engine._keys]).toEqual([live]);
  // Control: a deletion received in this session still drains.
  state.getListener().msgsDeleted([{ ...header, messageId: 'live@example.test' }]);
  await Promise.all(work);
  await vi.advanceTimersByTimeAsync(5001);
  expect(engine.removeBatch.mock.calls.flatMap(([keys]) => keys)).toEqual([live]);
  expect(stored.fts_pending_updates).toBeUndefined();
  state.instance.onShutdown(false);
});

it('a live native deletion drains without a later mail event', async () => {
  const deleted = 'synthetic:/Inbox:removed@example.test';
  const live = 'synthetic:/Inbox:live@example.test';
  const engine = makeFtsStore([deleted, live]);
  stored.chat_ftsIncrementalEnabled = true;
  stored.chat_ftsIncrementalBatchDelay = 5000;
  const state = bridge();
  await indexer.initIncrementalIndexer(engine);
  state.getListener().msgsDeleted([{ ...header, messageId: 'removed@example.test' }]);
  await Promise.all(work);
  expect(indexer._testExports._getPendingUpdates().get(deleted)?.type).toBe('deleted');

  await vi.advanceTimersByTimeAsync(5001);
  expect([...engine._keys]).toEqual([live]);
  expect(engine.removeBatch.mock.calls.flatMap(([keys]) => keys)).toEqual([deleted]);
  expect(indexer._testExports._getPendingUpdates().size).toBe(0);
  expect(stored.fts_pending_updates).toBeUndefined();
  state.instance.onShutdown(false);
});

// Deletions still queued at shutdown are not persisted; the next startup's
// reconciliation removes them without a later native event.
it('a deletion burst queued at shutdown is reconciled after restart', async () => {
  const live = 'synthetic:/Inbox:live@example.test';
  const count = indexer._testExports.FOLDER_RECON_PENDING_HIGH_WATER;
  const dead = Array.from(
    { length: count }, (_, i) => `synthetic:/Inbox:removed-${i}@example.test`,
  );
  const engine = makeFtsStore([...dead, live]);
  stored.chat_ftsIncrementalEnabled = true;
  stored.chat_ftsIncrementalBatchDelay = 5000;
  stored.fts_initial_scan_complete = true;
  let state = bridge();
  await indexer.initIncrementalIndexer(engine);
  state.getListener().msgsDeleted(dead.map((key, i) => ({
    ...header, messageKey: i + 17, messageId: `removed-${i}@example.test`,
  })));
  await Promise.all(work);
  expect(indexer._testExports._getPendingUpdates().size).toBe(count);

  await indexer.disposeIncrementalIndexer();
  expect(stored.fts_pending_updates).toBeUndefined();
  state.instance.onShutdown(false);
  state = bridge();
  const events = browser.tmMsgNotify;
  browser.accounts = { list: vi.fn() };
  const folder = {
    accountId: 'synthetic', folderPath: '/Inbox', folderURI: header.folder.URI,
    serverType: 'imap', stableUidKeys: true, uidValidity: 7,
  };
  const api = mockNotify([folder], {
    actualKeysByURI: { [folder.folderURI]: [live] },
    msgDbByURI: { [folder.folderURI]: new Set(['live@example.test']) },
  });
  Object.assign(events, api);
  browser.tmMsgNotify = events;
  await indexer.initIncrementalIndexer(engine);
  expect(indexer._testExports._getPendingUpdates().size).toBe(0);
  expect(engine._keys.size).toBe(count + 1);

  const settled = () => engine._keys.size === 1
    && indexer._testExports._getPendingUpdates().size === 0;
  // Ten virtual minutes in one-second steps, yielding to the real event loop
  // after each so real-latency work (membership digests) settles under load.
  for (let second = 0; second < 600 && !settled(); second++) {
    await vi.advanceTimersByTimeAsync(1000);
    await realImmediate();
  }
  expect([...engine._keys]).toEqual([live]);
  expect(indexer._testExports._getPendingUpdates().size).toBe(0);
  expect(stored.fts_pending_updates).toBeUndefined();
  await vi.advanceTimersByTimeAsync(60_000);
  expect([...engine._keys]).toEqual([live]);
  expect(indexer._testExports._getPendingUpdates().size).toBe(0);
  state.instance.onShutdown(false);
});

it('removes stored legacy reconcile-pending and pending-queue keys once and keeps no completion state in storage', async () => {
  const engine = makeFtsStore([]);
  stored.chat_ftsIncrementalEnabled = true;
  stored.fts_reconcile_pending = Date.now() - 60_000;
  stored.fts_pending_updates = [{ type: 'new', uniqueKey: 'synthetic:/Inbox:old@example.test' }];
  let state = bridge();
  browser.storage.local.remove.mockClear();

  await indexer.initIncrementalIndexer(engine);

  expect(stored.fts_reconcile_pending).toBeUndefined();
  expect(stored.fts_pending_updates).toBeUndefined();
  expect(browser.storage.local.remove.mock.calls.flatMap(([keys]) => [keys].flat()))
    .toEqual(['fts_reconcile_pending', 'fts_pending_updates']);
  // A new session starts incomplete; nothing about it is persisted.
  expect((await indexer.getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);

  // A later session finds no legacy key and writes nothing for the flag.
  await indexer.disposeIncrementalIndexer();
  state.instance.onShutdown(false);
  browser.storage.local.remove.mockClear();
  state = bridge();
  await indexer.initIncrementalIndexer(engine);
  expect(browser.storage.local.remove).not.toHaveBeenCalled();
  expect(stored.fts_reconcile_pending).toBeUndefined();
  expect(stored.fts_pending_updates).toBeUndefined();
  expect((await indexer.getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
  state.instance.onShutdown(false);
});

it('starts normally when the legacy reconcile-pending cleanup cannot read storage', async () => {
  const engine = makeFtsStore([]);
  stored.chat_ftsIncrementalEnabled = true;
  stored.fts_reconcile_pending = Date.now() - 60_000;
  const state = bridge();
  const originalGet = browser.storage.local.get.getMockImplementation();
  browser.storage.local.get.mockImplementation(value => ([value].flat().includes('fts_reconcile_pending')
    ? Promise.reject(new Error('storage unavailable'))
    : originalGet(value)));
  try {
    await expect(indexer.initIncrementalIndexer(engine)).resolves.toBeUndefined();
    expect((await indexer.getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
    expect(stored.fts_reconcile_pending).toBeDefined();
  } finally {
    browser.storage.local.get.mockImplementation(originalGet);
    state.instance.onShutdown(false);
  }
});
