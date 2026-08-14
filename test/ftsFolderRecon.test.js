/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Startup UID/index membership proof and exact two-way folder reconciliation.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    agentQueues: { ftsIncremental: {} },
    eventLogger: { enabled: false },
  },
}));

vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsBatchOperation: vi.fn(),
  logFtsOperation: vi.fn(),
  logMessageEventBatch: vi.fn(),
  logMoveEvent: vi.fn(),
}));

vi.mock('../agent/modules/utils.js', () => ({
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
  buildBatchHeader: vi.fn(),
  populateBatchBody: vi.fn(),
}));

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrDefault) => {
        if (typeof keyOrDefault === 'string') {
          return { [keyOrDefault]: storageData[keyOrDefault] ?? null };
        }
        return Object.fromEntries(Object.entries(keyOrDefault).map(([key, fallback]) => [
          key,
          storageData[key] === undefined ? fallback : storageData[key],
        ]));
      }),
      set: vi.fn(async (obj) => Object.assign(storageData, obj)),
      remove: vi.fn(async (key) => { delete storageData[key]; }),
    },
  },
  accounts: { list: vi.fn(async () => []) },
};

const { logFtsBatchOperation, logFtsOperation } = await import('../agent/modules/eventLogger.js');
const { recheckMessageInFolder } = await import('../agent/modules/utils.js');
const { _testExports } = await import('../fts/incrementalIndexer.js');
const {
  _getFolderReconDrainSkipped,
  _getPendingUpdates,
  _maybeScheduleFolderReconRerun,
  _resetFolderReconState,
  _runFolderReconcile,
  _setExperimentListenersActive,
  _setFolderReconBudgetOverride,
  _setFolderReconInProgress,
  _setFtsSearch,
  _setIndexerDisposed,
  _setIsEnabled,
  onExperimentMessageRemoved,
  FOLDER_RECON_INITIAL_SCAN_KEY,
  FOLDER_RECON_STORAGE_KEY,
} = _testExports;

const URI_A = 'imap://user@host/INBOX';
const URI_B = 'imap://user@host/%5BGmail%5D/All%20Mail';
const URI_C = 'imap://user@host/INBOX/a%3Ab';
const KEY_A = (id) => `account1:/INBOX:${id}`;
const KEY_B = (id) => `account3:/[Gmail]/All Mail:${id}`;

function digest(keys) {
  const hash = createHash('sha256');
  for (const key of [...new Set(keys)].sort()) {
    const bytes = Buffer.from(key, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function folderA(over = {}) {
  return {
    accountId: 'account1',
    folderPath: '/INBOX',
    folderURI: URI_A,
    serverType: 'imap',
    stableUidKeys: true,
    uidValidity: 7,
    uidCount: 2,
    uidSha256: 'uid-a',
    highestModSeq: '42',
    ...over,
  };
}

function folderB(over = {}) {
  return {
    accountId: 'account3',
    folderPath: '/[Gmail]/All Mail',
    folderURI: URI_B,
    serverType: 'imap',
    stableUidKeys: true,
    uidValidity: 8,
    uidCount: 1,
    uidSha256: 'uid-b',
    highestModSeq: '99',
    ...over,
  };
}

function inRange(keys, start, end, after = null) {
  return [...keys].sort().filter(key => key >= start && key < end && (after == null || key > after));
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
    findByHeaderMessageId: vi.fn(async () => []),
    stats: vi.fn(async () => ({ ok: true, docs: keys.size })),
  };
}

function mockNotify(folders, {
  actualKeysByURI = {},
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
  const api = {
    getFolderState: vi.fn(async (accountId, folderPath) => byIdentity[`${accountId}:${folderPath}`]),
    fingerprintFolderMessages: vi.fn(async (uri) => {
      const keys = actualKeysByURI[uri] || [];
      return { ok: true, count: new Set(keys).size, sha256: digest(keys), unkeyedCount: 0 };
    }),
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
      return {
        infos: keys.map(key => ({
          accountId: folder.accountId,
          folderPath: folder.folderPath,
          headerMessageId: `msg-${key}@example.com`,
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

function seedMemo(folders, version = 2) {
  storageData[FOLDER_RECON_STORAGE_KEY] = { version, folders };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) delete storageData[key];
  storageData[FOLDER_RECON_INITIAL_SCAN_KEY] = true;
  delete globalThis.browser.tmMsgNotify;
  globalThis.browser.accounts.list.mockImplementation(async () => []);
  recheckMessageInFolder.mockImplementation(async () => 'absent');
  _getPendingUpdates().clear();
  _resetFolderReconState();
  _setIsEnabled(true);
  _setExperimentListenersActive(true);
  _setFtsSearch(null);
  _setIndexerDisposed(false);
});

describe('startup membership proof', () => {
  it('establishes a v2 verified checkpoint from exact matching fingerprints', async () => {
    const keys = [KEY_A('a@example.com'), KEY_A('b@example.com')];
    const fts = makeFtsStore(keys);
    const api = mockNotify([folderA()], { actualKeysByURI: { [URI_A]: keys } });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersClean).toBe(1);
    expect(api.fingerprintFolderMessages).toHaveBeenCalledOnce();
    expect(api.probeMessageIds).not.toHaveBeenCalled();
    expect(fts.listMsgIdRange).not.toHaveBeenCalled();
    expect(storageData[FOLDER_RECON_STORAGE_KEY]).toMatchObject({
      version: 2,
      folders: {
        'account1:/INBOX': {
          verified: true,
          expectedCount: 2,
          expectedSha256: digest(keys),
          ftsSha256: digest(keys),
          uidValidity: 7,
          uidSha256: 'uid-a',
        },
      },
    });
  });

  it('uses UID + FTS checkpoint equality without walking headers', async () => {
    const keys = [KEY_A('a@example.com'), KEY_A('b@example.com')];
    seedMemo({
      'account1:/INBOX': {
        verified: true,
        expectedCount: 2,
        expectedSha256: digest(keys),
        ftsCount: 2,
        ftsSha256: digest(keys),
        uidValidity: 7,
        uidCount: 2,
        uidSha256: 'uid-a',
        updatedAtMs: 1,
      },
    });
    const fts = makeFtsStore(keys);
    const api = mockNotify([folderA()], { actualKeysByURI: { [URI_A]: keys } });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersMemoHit).toBe(1);
    expect(api.fingerprintFolderMessages).not.toHaveBeenCalled();
    expect(api.probeMessageIds).not.toHaveBeenCalled();
  });

  it('rehashes headers when UID membership changes, then refreshes the checkpoint', async () => {
    const keys = [KEY_A('a@example.com'), KEY_A('c@example.com')];
    seedMemo({
      'account1:/INBOX': {
        verified: true,
        ftsCount: 2,
        ftsSha256: digest(keys),
        uidValidity: 7,
        uidCount: 2,
        uidSha256: 'old-uid-set',
      },
    });
    const fts = makeFtsStore(keys);
    const api = mockNotify([folderA({ uidSha256: 'new-uid-set' })], {
      actualKeysByURI: { [URI_A]: keys },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersClean).toBe(1);
    expect(api.fingerprintFolderMessages).toHaveBeenCalledOnce();
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'].uidSha256).toBe('new-uid-set');
  });

  it('never trusts the old count memo schema', async () => {
    seedMemo({ 'account1:/INBOX': { lastCleanMsgCount: 2, lastCleanFtsCount: 2 } }, 1);
    const keys = [KEY_A('a@example.com'), KEY_A('b@example.com')];
    const fts = makeFtsStore(keys);
    const api = mockNotify([folderA()], { actualKeysByURI: { [URI_A]: keys } });

    await _runFolderReconcile(fts);

    expect(api.fingerprintFolderMessages).toHaveBeenCalledOnce();
    expect(storageData[FOLDER_RECON_STORAGE_KEY].version).toBe(2);
  });

  it('non-IMAP folders take the exact local-header proof path every boot', async () => {
    const local = folderA({ serverType: 'none', stableUidKeys: false });
    const keys = [KEY_A('a@example.com')];
    const fts = makeFtsStore(keys);
    const api = mockNotify([local], { actualKeysByURI: { [URI_A]: keys } });

    await _runFolderReconcile(fts);
    await _runFolderReconcile(fts);

    expect(api.fingerprintFolderMessages).toHaveBeenCalledTimes(2);
  });
});

describe('exact mismatch repair', () => {
  it('detects and repairs an equal-cardinality stale/missing key swap', async () => {
    const nativeKeys = [KEY_A('same@example.com'), KEY_A('ghost@example.com')];
    const actualKeys = [KEY_A('same@example.com'), KEY_A('msg-2@example.com')];
    const fts = makeFtsStore(nativeKeys);
    mockNotify([folderA({ uidSha256: 'changed' })], {
      actualKeysByURI: { [URI_A]: actualKeys },
      msgDbByURI: { [URI_A]: new Set(['same@example.com', 'msg-2@example.com']) },
      keysByURI: { [URI_A]: [1, 2] },
      infosByURI: { [URI_A]: { infos: [
        { accountId: 'account1', folderPath: '/INBOX', headerMessageId: 'same@example.com', msgKey: 1, eventType: 'cursorScan' },
        { accountId: 'account1', folderPath: '/INBOX', headerMessageId: 'msg-2@example.com', msgKey: 2, eventType: 'cursorScan' },
      ] } },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.staleRemoved).toBe(1);
    expect(stats.missingEnqueued).toBe(1);
    expect(fts._keys.has(KEY_A('ghost@example.com'))).toBe(false);
    expect(_getPendingUpdates().has(KEY_A('msg-2@example.com'))).toBe(true);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'].verified).toBe(false);
    expect(_getFolderReconDrainSkipped().has('account1:/INBOX')).toBe(true);

    // Simulate the normal drain, then prove exact equality on its one-shot rerun.
    fts._keys.add(KEY_A('msg-2@example.com'));
    _getPendingUpdates().clear();
    _setFtsSearch(fts);
    await _maybeScheduleFolderReconRerun();
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX']).toMatchObject({
      verified: true,
      expectedSha256: digest(actualKeys),
      ftsSha256: digest(actualKeys),
    });
  });

  it('keeps an unconfirmed stale candidate and leaves the folder unverified', async () => {
    const nativeKeys = [KEY_A('ok@example.com'), KEY_A('unsure@example.com')];
    const actualKeys = [KEY_A('ok@example.com')];
    const fts = makeFtsStore(nativeKeys);
    mockNotify([folderA({ uidCount: 1, uidSha256: 'changed' })], {
      actualKeysByURI: { [URI_A]: actualKeys },
      msgDbByURI: { [URI_A]: new Set(['ok@example.com']) },
      keysByURI: { [URI_A]: [1] },
    });
    recheckMessageInFolder.mockImplementation(async () => 'error');

    const stats = await _runFolderReconcile(fts);

    expect(stats.recheckKeptError).toBe(1);
    expect(stats.foldersFailed).toBe(1);
    expect(fts._keys.has(KEY_A('unsure@example.com'))).toBe(true);
    expect(storageData[FOLDER_RECON_STORAGE_KEY]).toBeUndefined();
  });

  it('persists an explicitly unverified cursor when a repair budget truncates', async () => {
    _setFolderReconBudgetOverride({ enqueues: 1 });
    const actualKeys = [KEY_A('msg-1@example.com'), KEY_A('msg-2@example.com')];
    const fts = makeFtsStore([]);
    mockNotify([folderA({ uidSha256: 'changed' })], {
      actualKeysByURI: { [URI_A]: actualKeys },
      msgDbByURI: { [URI_A]: new Set(['msg-1@example.com', 'msg-2@example.com']) },
      keysByURI: { [URI_A]: [1, 2] },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersBudgetPartial).toBe(1);
    expect(stats.missingEnqueued).toBe(1);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX']).toMatchObject({
      verified: false,
      missingBackfillKey: 1,
      partialExpectedSha256: digest(actualKeys),
    });
  });
});

describe('gating and drain coordination', () => {
  it('skips a drain-busy folder and rechecks it once after drain empty', async () => {
    const keysA = [KEY_A('a@example.com')];
    const keysB = [KEY_B('b@example.com')];
    const fts = makeFtsStore([...keysA, ...keysB]);
    const api = mockNotify([folderA({ uidCount: 1 }), folderB()], {
      actualKeysByURI: { [URI_A]: keysA, [URI_B]: keysB },
    });
    _getPendingUpdates().set(KEY_A('inflight@example.com'), {
      type: 'new', uniqueKey: KEY_A('inflight@example.com'), timestamp: 1, metadata: {},
    });

    const stats = await _runFolderReconcile(fts);
    expect(stats.foldersDrainBusy).toBe(1);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account3:/[Gmail]/All Mail'].verified).toBe(true);

    _getPendingUpdates().clear();
    _setFtsSearch(fts);
    const calls = api.getFolderState.mock.calls.length;
    await _maybeScheduleFolderReconRerun();
    expect(api.getFolderState).toHaveBeenCalledTimes(calls + 1);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'].verified).toBe(true);
    _getFolderReconDrainSkipped().add('account1:/INBOX');
    expect(_maybeScheduleFolderReconRerun()).toBeUndefined();
  });

  it('defers the rerun without consuming it while reconciliation is active', () => {
    _setFtsSearch(makeFtsStore([]));
    _getFolderReconDrainSkipped().add('account1:/INBOX');
    _setFolderReconInProgress(true);
    expect(_maybeScheduleFolderReconRerun()).toBeUndefined();
    expect(_getFolderReconDrainSkipped().has('account1:/INBOX')).toBe(true);
    _setFolderReconInProgress(false);
    expect(_maybeScheduleFolderReconRerun()).toBeInstanceOf(Promise);
  });

  it('does not let a clean scoped rerun mask another folder\'s boot error', async () => {
    const keysA = [KEY_A('a@example.com')];
    const fts = makeFtsStore(keysA);
    mockNotify([folderA({ uidCount: 1 }), folderB({ error: 'summary unavailable' })], {
      actualKeysByURI: { [URI_A]: keysA },
    });
    storageData.fts_reconcile_pending = 123;
    _getPendingUpdates().set(KEY_A('inflight@example.com'), {
      type: 'new', uniqueKey: KEY_A('inflight@example.com'), timestamp: 1, metadata: {},
    });

    await _runFolderReconcile(fts);
    _getPendingUpdates().clear();
    _setFtsSearch(fts);
    await _maybeScheduleFolderReconRerun();

    expect(storageData.fts_reconcile_pending).toBe(123);
  });

  it('requires the completed initial index', async () => {
    delete storageData[FOLDER_RECON_INITIAL_SCAN_KEY];
    const fts = makeFtsStore([]);
    const api = mockNotify([folderA()]);
    const result = await _runFolderReconcile(fts);
    expect(result).toMatchObject({ skipped: true, reason: 'initial_scan_incomplete' });
    expect(api.getFolderState).not.toHaveBeenCalled();
  });

  it('feature-detects native helper 0.11 once and then stays disabled', async () => {
    const fts = makeFtsStore([]);
    fts.fingerprintMsgIdRange.mockRejectedValue(new Error('Unknown reader method'));
    const api = mockNotify([folderA()]);
    expect(await _runFolderReconcile(fts)).toMatchObject({ skipped: true, reason: 'native_unsupported' });
    expect(await _runFolderReconcile(fts)).toMatchObject({ skipped: true, reason: 'native_unsupported' });
    expect(fts.fingerprintMsgIdRange).toHaveBeenCalledOnce();
    expect(api.getFolderState).not.toHaveBeenCalled();
    expect(logFtsBatchOperation.mock.calls.filter(([op, state]) => op === 'folder_recon' && state === 'unsupported')).toHaveLength(1);
  });

  it('requires the new experiment fingerprint methods', async () => {
    const fts = makeFtsStore([]);
    globalThis.browser.tmMsgNotify = { getFolderCounts: vi.fn(), probeMessageIds: vi.fn() };
    expect(await _runFolderReconcile(fts)).toMatchObject({ skipped: true, reason: 'no_experiment' });
    expect(fts.fingerprintMsgIdRange).not.toHaveBeenCalled();
  });
});

describe('orphan prefixes and event hardening', () => {
  it('removes a key owned by no current folder after independent confirmation', async () => {
    const actualA = [KEY_A('a@example.com')];
    const edge = 'account1:/INBOX/a:b:y@example.com';
    const ghost = 'ghostAcct:/Gone:x@example.com';
    const fts = makeFtsStore([...actualA, edge, ghost]);
    const folderC = {
      accountId: 'account1', folderPath: '/INBOX/a:b', folderURI: URI_C,
      serverType: 'imap', stableUidKeys: true, uidValidity: 7, uidCount: 1, uidSha256: 'uid-c',
    };
    mockNotify([folderA({ uidCount: 1 }), folderC], {
      actualKeysByURI: { [URI_A]: actualA, [URI_C]: [edge] },
    });
    globalThis.browser.accounts.list.mockResolvedValue([{
      id: 'account1',
      rootFolder: { path: '/', subFolders: [{ path: '/INBOX', subFolders: [{ path: '/INBOX/a:b', subFolders: [] }] }] },
    }]);

    const stats = await _runFolderReconcile(fts);

    expect(stats.orphanRemoved).toBe(1);
    expect(fts._keys.has(ghost)).toBe(false);
    expect(fts._keys.has(edge)).toBe(true);
  });

  it('rejects partial removal-event keys instead of queueing malformed deletes', async () => {
    await onExperimentMessageRemoved({
      accountId: '', folderPath: '/INBOX', headerMessageId: 'x@example.com', eventType: 'deleted',
    });
    await onExperimentMessageRemoved({
      accountId: 'account1', folderPath: '', headerMessageId: 'x@example.com', eventType: 'deleted',
    });
    expect(_getPendingUpdates().size).toBe(0);
  });

  it('pins the experiment schema and source contracts for UID/delete payloads', () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../agent/experiments/tmMsgNotify/schema.json', import.meta.url)), 'utf8'));
    const names = schema[0].functions.map(fn => fn.name);
    expect(names).toEqual(expect.arrayContaining(['getFolderState', 'fingerprintFolderMessages']));
    const removed = schema[0].events.find(event => event.name === 'onMessageRemoved');
    expect(removed.parameters[0].properties.msgKey).toBeTruthy();
    const experimentSource = readFileSync(fileURLToPath(new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url)), 'utf8');
    expect(experimentSource).not.toContain('new TextEncoder');
    expect(experimentSource).toContain('function encodeUtf8');
  });

  it('keeps the drain-empty rerun hook wired into the queue processor', () => {
    const source = readFileSync(fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url)), 'utf8');
    const branch = source.match(/if \(_pendingUpdates\.size === 0\) \{[\s\S]*?\} else \{/);
    expect(branch?.[0]).toContain('_maybeScheduleFolderReconRerun()');
    expect(logFtsOperation).toBeDefined();
  });
});
