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

function framedDigest(keys) {
  const hash = createHash('sha256');
  for (const key of [...keys].sort()) {
    const bytes = Buffer.from(key, 'utf8');
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

function keyMapDigest(entries) {
  return framedDigest(entries.map(([key, uniqueKey]) => `${Number(key) >>> 0}:${uniqueKey}`));
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
  const api = {
    getFolderState: vi.fn(async (accountId, folderPath) => byIdentity[`${accountId}:${folderPath}`]),
    fingerprintFolderMessages: vi.fn(async (uri) => {
      const folder = byURI[uri];
      const headerIdsByKey = headerIdsByKeyByURI[uri];
      const keyedRows = headerIdsByKey
        ? Object.entries(headerIdsByKey).map(([key, headerMessageId]) => [
          key,
          `${folder.accountId}:${folder.folderPath}:${headerMessageId}`,
        ])
        : [];
      const keys = headerIdsByKey ? keyedRows.map(([, uniqueKey]) => uniqueKey) : (actualKeysByURI[uri] || []);
      return {
        ok: true,
        count: new Set(keys).size,
        sha256: digest(keys),
        ...(headerIdsByKey ? {
          // Source-accurate: the producer fingerprints the full mapping array,
          // while only the FTS-key membership fingerprint de-duplicates IDs.
          keyMapCount: keyedRows.length,
          keyMapSha256: keyMapDigest(keyedRows),
        } : {}),
        unkeyedCount: 0,
      };
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

function seedMemo(folders, version = 2) {
  storageData[FOLDER_RECON_STORAGE_KEY] = { version, folders };
}

beforeEach(() => {
  vi.restoreAllMocks();
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

  it('normalizes a signed high-bit UIDVALIDITY to the same protocol epoch', async () => {
    const keys = [KEY_A('a@example.com'), KEY_A('b@example.com')];
    seedMemo({
      'account1:/INBOX': {
        verified: true,
        expectedCount: 2,
        expectedSha256: digest(keys),
        ftsCount: 2,
        ftsSha256: digest(keys),
        uidValidity: 0xffffffff,
        uidCount: 2,
        uidSha256: 'uid-a',
      },
    });
    const fts = makeFtsStore(keys);
    const api = mockNotify([folderA({ uidValidity: -1 })], { actualKeysByURI: { [URI_A]: keys } });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersMemoHit).toBe(1);
    expect(api.fingerprintFolderMessages).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['missing', undefined],
    ['fractional', 1.5],
    ['string', '7'],
    ['oversized', 0x100000000],
    ['out-of-range negative', -0x80000001],
  ])('does not trust %s UID evidence as a verified checkpoint', async (_label, uidValidity) => {
    const nativeKeys = [KEY_A('same@example.com'), KEY_A('old@example.com')];
    const headerIdsByKey = { 1: 'same@example.com', 2: 'new@example.com' };
    seedMemo({
      'account1:/INBOX': {
        verified: true,
        ftsCount: 2,
        ftsSha256: digest(nativeKeys),
        uidValidity,
        uidCount: 2,
        uidSha256: 'same-uid-set',
      },
    });
    const fts = makeFtsStore(nativeKeys);
    const api = mockNotify([folderA({ uidValidity, uidCount: 2, uidSha256: 'same-uid-set' })], {
      headerIdsByKeyByURI: { [URI_A]: headerIdsByKey },
      msgDbByURI: { [URI_A]: new Set(Object.values(headerIdsByKey)) },
      keysByURI: { [URI_A]: [1, 2] },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersMemoHit).toBe(0);
    expect(api.fingerprintFolderMessages).toHaveBeenCalledOnce();
    expect(fts._keys.has(KEY_A('old@example.com'))).toBe(false);
    expect(_getPendingUpdates().has(KEY_A('new@example.com'))).toBe(true);
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

  it('gives every mismatching folder bounded scan progress in the same pass', async () => {
    _setFolderReconBudgetOverride({ scans: 2 });
    const actualA = [1, 2, 3].map(key => KEY_A(`msg-${key}@example.com`));
    const actualB = [1, 2, 3].map(key => KEY_B(`msg-${key}@example.com`));
    const fts = makeFtsStore([]);
    mockNotify([
      folderA({ uidCount: 3, uidSha256: 'uid-a-3' }),
      folderB({ uidCount: 3, uidSha256: 'uid-b-3' }),
    ], {
      actualKeysByURI: { [URI_A]: actualA, [URI_B]: actualB },
      keysByURI: { [URI_A]: [1, 2, 3], [URI_B]: [1, 2, 3] },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersBudgetPartial).toBe(2);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders).toMatchObject({
      'account1:/INBOX': { verified: false, missingBackfillKey: 2 },
      'account3:/[Gmail]/All Mail': { verified: false, missingBackfillKey: 2 },
    });
  });

  it('still gives a zero-stale folder its cheap scan allowance after shared rechecks are exhausted', async () => {
    _setFolderReconBudgetOverride({ rechecks: 1, scans: 2, enqueues: 1 });
    const ghostA = KEY_A('ghost@example.com');
    const existingB = KEY_B('existing@example.com');
    const missingB = KEY_B('missing@example.com');
    const fts = makeFtsStore([ghostA, existingB]);
    const realList = fts.listMsgIdRange.getMockImplementation();
    let forcedNonterminalBPage = false;
    fts.listMsgIdRange.mockImplementation(async (...args) => {
      const result = await realList(...args);
      if (!forcedNonterminalBPage && args[0].startsWith('account3:') && result.msgIds.length > 0) {
        forcedNonterminalBPage = true;
        return { ...result, done: false };
      }
      return result;
    });
    const api = mockNotify([
      folderA({ uidCount: 0, uidSha256: 'uid-a-empty' }),
      folderB({ uidCount: 2, uidSha256: 'uid-b-two' }),
    ], {
      actualKeysByURI: { [URI_A]: [], [URI_B]: [existingB, missingB] },
      headerIdsByKeyByURI: { [URI_B]: { 1: 'existing@example.com', 2: 'missing@example.com' } },
      msgDbByURI: { [URI_A]: new Set(), [URI_B]: new Set(['existing@example.com', 'missing@example.com']) },
      keysByURI: { [URI_A]: [], [URI_B]: [1, 2] },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.staleRemoved).toBe(1);
    expect(stats.missingEnqueued).toBe(1);
    expect(stats.foldersBudgetPartial).toBe(0);
    expect(api.listKeysAboveKey).toHaveBeenCalledWith(URI_B, 0, 0);
    expect(logFtsOperation).not.toHaveBeenCalledWith(
      'folder_recon',
      'recheck_budget_truncated',
      expect.objectContaining({ folderPath: '/[Gmail]/All Mail' }),
    );
  });

  it('treats an exactly full terminal recheck page as complete, not truncated', async () => {
    _setFolderReconBudgetOverride({ rechecks: 1 });
    const ghost = KEY_A('ghost@example.com');
    const fts = makeFtsStore([ghost]);
    mockNotify([folderA({ uidCount: 0, uidSha256: 'uid-empty' })], {
      actualKeysByURI: { [URI_A]: [] },
      msgDbByURI: { [URI_A]: new Set() },
      keysByURI: { [URI_A]: [] },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.staleRemoved).toBe(1);
    expect(stats.foldersBudgetPartial).toBe(0);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
      .toMatchObject({ verified: true, expectedCount: 0, ftsCount: 0 });
  });

  it('runs the fail-closed missing direction even when stale rechecks truncate', async () => {
    _setFolderReconBudgetOverride({ rechecks: 0, scans: 1, enqueues: 1 });
    const ghost = KEY_A('ghost@example.com');
    const missing = KEY_A('missing@example.com');
    const fts = makeFtsStore([ghost]);
    mockNotify([folderA({ uidCount: 1, uidSha256: 'uid-a-one' })], {
      actualKeysByURI: { [URI_A]: [missing] },
      headerIdsByKeyByURI: { [URI_A]: { 1: 'missing@example.com' } },
      msgDbByURI: { [URI_A]: new Set(['missing@example.com']) },
      keysByURI: { [URI_A]: [1] },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersBudgetPartial).toBe(1);
    expect(stats.staleRemoved).toBe(0);
    expect(fts._keys.has(ghost)).toBe(true);
    expect(stats.missingEnqueued).toBe(1);
    expect(_getPendingUpdates().has(missing)).toBe(true);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'].verified).toBe(false);
  });

  it('preserves earned missing progress without failure backoff when only stale rechecks truncate', async () => {
    _setFolderReconBudgetOverride({ rechecks: 0, scans: 1, enqueues: 1 });
    const indexed = KEY_A('indexed@example.com');
    const ghost = KEY_A('ghost@example.com');
    const fts = makeFtsStore([indexed, ghost]);
    mockNotify([folderA({ uidCount: 1, uidSha256: 'uid-one' })], {
      actualKeysByURI: { [URI_A]: [indexed] },
      headerIdsByKeyByURI: { [URI_A]: { 1: 'indexed@example.com' } },
      msgDbByURI: { [URI_A]: new Set(['indexed@example.com']) },
      keysByURI: { [URI_A]: [1] },
    });

    const stats = await _runFolderReconcile(fts);
    const checkpoint = storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'];

    expect(stats.foldersBudgetPartial).toBe(1);
    expect(stats.foldersFailed).toBe(0);
    expect(stats.foldersBackoff).toBe(0);
    expect(stats.missingEnqueued).toBe(0);
    expect(checkpoint).toMatchObject({
      verified: false,
      missingBackfillKey: 1,
    });
    expect(checkpoint).not.toHaveProperty('partialPostVerifyFailureCount');
    expect(checkpoint).not.toHaveProperty('partialRetryNotBeforeMs');
  });

  it('converges in bounded passes when stable UID membership grows between passes', async () => {
    _setFolderReconBudgetOverride({ scans: 2 });
    const folder = folderA({ uidCount: 5, uidSha256: 'uid-set-5' });
    const msgDbKeys = [1, 2, 3, 4, 5];
    const msgDbIds = new Set(msgDbKeys.map(key => `msg-${key}@example.com`));
    const actualKeys = msgDbKeys.map(key => KEY_A(`msg-${key}@example.com`));
    const fts = makeFtsStore(actualKeys.slice(0, 4));
    mockNotify([folder], {
      actualKeysByURI: { [URI_A]: actualKeys },
      msgDbByURI: { [URI_A]: msgDbIds },
      keysByURI: { [URI_A]: msgDbKeys },
    });

    await _runFolderReconcile(fts);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'].missingBackfillKey).toBe(2);

    // A new IMAP UID changes the exact Message-ID digest, but no key at or
    // below the old cursor can be newly introduced under the same UIDVALIDITY.
    msgDbKeys.push(6);
    msgDbIds.add('msg-6@example.com');
    actualKeys.push(KEY_A('msg-6@example.com'));
    folder.uidCount = 6;
    folder.uidSha256 = 'uid-set-6';

    await _runFolderReconcile(fts);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'].missingBackfillKey).toBe(4);

    await _runFolderReconcile(fts);
    expect(_getPendingUpdates().has(KEY_A('msg-5@example.com'))).toBe(true);
    expect(_getPendingUpdates().has(KEY_A('msg-6@example.com'))).toBe(true);

    // Simulate the durable drain, then the next bounded pass must establish
    // exact equality rather than revisit the leading keys forever.
    fts._keys.add(KEY_A('msg-5@example.com'));
    fts._keys.add(KEY_A('msg-6@example.com'));
    _getPendingUpdates().clear();
    await _runFolderReconcile(fts);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX']).toMatchObject({
      verified: true,
      expectedSha256: digest(actualKeys),
      ftsSha256: digest(actualKeys),
    });
  });

  it('makes bounded progress when IMAP UIDVALIDITY is unavailable but the exact key mapping is unchanged', async () => {
    _setFolderReconBudgetOverride({ scans: 2 });
    const msgDbKeys = [1, 2, 3, 4, 5];
    const actualKeys = msgDbKeys.map(key => KEY_A(`msg-${key}@example.com`));
    const headerIdsByKey = Object.fromEntries(msgDbKeys.map(key => [key, `msg-${key}@example.com`]));
    const msgDbIds = new Set(Object.values(headerIdsByKey));
    const fts = makeFtsStore(actualKeys.slice(0, 4));
    mockNotify([folderA({ uidValidity: 0, uidCount: 5, uidSha256: 'uid-set-5' })], {
      actualKeysByURI: { [URI_A]: actualKeys },
      headerIdsByKeyByURI: { [URI_A]: headerIdsByKey },
      msgDbByURI: { [URI_A]: msgDbIds },
      keysByURI: { [URI_A]: msgDbKeys },
    });

    const cursors = [];
    for (let pass = 0; pass < 3; pass++) {
      const stats = await _runFolderReconcile(fts);
      expect(stats.staleRemoved).toBe(0);
      cursors.push(storageData[FOLDER_RECON_STORAGE_KEY]
        .folders['account1:/INBOX'].missingBackfillKey);
    }

    expect(cursors).toEqual([2, 4, 5]);
    expect(_getPendingUpdates().has(KEY_A('msg-5@example.com'))).toBe(true);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX']).toMatchObject({
      partialKeyMapCount: 5,
      partialKeyMapSha256: keyMapDigest(Object.entries(headerIdsByKey)
        .map(([key, headerMessageId]) => [key, KEY_A(headerMessageId)])),
    });
  });

  it('makes bounded progress across growth under a signed high-bit UIDVALIDITY epoch', async () => {
    _setFolderReconBudgetOverride({ scans: 2 });
    const folder = folderA({ uidValidity: -1, uidCount: 5, uidSha256: 'uid-set-5' });
    const msgDbKeys = [1, 2, 3, 4, 5];
    const headerIdsByKey = Object.fromEntries(msgDbKeys.map(key => [key, `msg-${key}@example.com`]));
    const msgDbIds = new Set(Object.values(headerIdsByKey));
    const actualKeys = Object.values(headerIdsByKey).map(KEY_A);
    const fts = makeFtsStore(actualKeys.slice(0, 4));
    mockNotify([folder], {
      headerIdsByKeyByURI: { [URI_A]: headerIdsByKey },
      msgDbByURI: { [URI_A]: msgDbIds },
      keysByURI: { [URI_A]: msgDbKeys },
    });

    await _runFolderReconcile(fts);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX']).toMatchObject({
      missingBackfillKey: 2,
      partialUidValidity: 0xffffffff,
    });

    msgDbKeys.push(6);
    headerIdsByKey[6] = 'msg-6@example.com';
    msgDbIds.add('msg-6@example.com');
    folder.uidCount = 6;
    folder.uidSha256 = 'uid-set-6';
    await _runFolderReconcile(fts);

    expect(storageData[FOLDER_RECON_STORAGE_KEY]
      .folders['account1:/INBOX'].missingBackfillKey).toBe(4);
  });

  it.each([
    ['unknown IMAP epoch', { uidValidity: 0 }],
    ['non-stable folder', { serverType: 'none', stableUidKeys: false }],
  ])('restarts a %s when the same Message-ID set remaps below the partial cursor', async (_label, overrides) => {
    _setFolderReconBudgetOverride({ scans: 2 });
    const headerIdsByKey = {
      1: 'msg-b@example.com',
      2: 'msg-c@example.com',
      3: 'msg-d@example.com',
      4: 'msg-a@example.com',
    };
    const expectedKeys = Object.values(headerIdsByKey).map(KEY_A);
    const fts = makeFtsStore(expectedKeys.filter(key => key !== KEY_A('msg-a@example.com')));
    mockNotify([folderA({ uidCount: 4, uidSha256: 'same-uid-set', ...overrides })], {
      headerIdsByKeyByURI: { [URI_A]: headerIdsByKey },
      msgDbByURI: { [URI_A]: new Set(Object.values(headerIdsByKey)) },
      keysByURI: { [URI_A]: [1, 2, 3, 4] },
    });

    await _runFolderReconcile(fts);
    expect(storageData[FOLDER_RECON_STORAGE_KEY]
      .folders['account1:/INBOX'].missingBackfillKey).toBe(2);

    // The set and UID-key digest are unchanged, but the missing ID moved from
    // key 4 to key 1. Resuming above key 2 would skip it.
    headerIdsByKey[1] = 'msg-a@example.com';
    headerIdsByKey[4] = 'msg-b@example.com';
    await _runFolderReconcile(fts);

    expect(_getPendingUpdates().has(KEY_A('msg-a@example.com'))).toBe(true);
  });

  it('counts every numeric key in a duplicate-Message-ID mapping fingerprint', async () => {
    const duplicate = KEY_A('duplicate@example.com');
    const headerIdsByKey = { 1: 'duplicate@example.com', 2: 'duplicate@example.com' };
    const api = mockNotify([folderA({ uidCount: 2, uidSha256: 'two-keys' })], {
      headerIdsByKeyByURI: { [URI_A]: headerIdsByKey },
      keysByURI: { [URI_A]: [1, 2] },
    });

    const fingerprint = await api.fingerprintFolderMessages(URI_A);

    expect(fingerprint).toMatchObject({
      count: 1,
      sha256: digest([duplicate]),
      keyMapCount: 2,
      keyMapSha256: keyMapDigest([[1, duplicate], [2, duplicate]]),
    });
  });

  it('restarts below a partial cursor when UIDVALIDITY changes but the exact Message-ID set does not', async () => {
    _setFolderReconBudgetOverride({ scans: 1 });
    const actualKeys = [1, 3, 4].map(key => KEY_A(`msg-${key}@example.com`));
    seedMemo({
      'account1:/INBOX': {
        verified: false,
        partialExpectedSha256: digest(actualKeys),
        missingBackfillKey: 2,
        partialStableUidKeys: true,
        partialUidValidity: 7,
      },
    });
    // The epoch-7 sweep had reached UID 2. The exact Message-ID set survives
    // epoch 8, but the missing ID now maps below that cursor while a populated
    // tail keeps an erroneous resume budget-partial instead of reaching its
    // terminal mismatch reset.
    const fts = makeFtsStore(actualKeys.slice(1));
    mockNotify([folderA({ uidValidity: 8, uidCount: 3, uidSha256: 'new-epoch' })], {
      actualKeysByURI: { [URI_A]: actualKeys },
      keysByURI: { [URI_A]: [1, 3, 4] },
    });

    await _runFolderReconcile(fts);

    expect(_getPendingUpdates().has(KEY_A('msg-1@example.com'))).toBe(true);
  });

  it('restarts a changed non-IMAP membership below its partial cursor', async () => {
    _setFolderReconBudgetOverride({ scans: 1 });
    seedMemo({
      'account1:/INBOX': {
        verified: false,
        partialExpectedSha256: digest([KEY_A('old@example.com')]),
        missingBackfillKey: 2,
      },
    });
    const actualKeys = [KEY_A('msg-1@example.com')];
    const fts = makeFtsStore([]);
    mockNotify([folderA({ serverType: 'none', stableUidKeys: false })], {
      actualKeysByURI: { [URI_A]: actualKeys },
      keysByURI: { [URI_A]: [1] },
    });

    await _runFolderReconcile(fts);

    expect(_getPendingUpdates().has(KEY_A('msg-1@example.com'))).toBe(true);
  });

  it('enqueues a filter-reported missing header even when its info has no numeric msgKey', async () => {
    const actualKeys = [KEY_A('no-key@example.com')];
    const fts = makeFtsStore([]);
    mockNotify([folderA({ uidCount: 1, uidSha256: 'uid-no-key' })], {
      actualKeysByURI: { [URI_A]: actualKeys },
      keysByURI: { [URI_A]: [1] },
      infosByURI: { [URI_A]: { infos: [{
        accountId: 'account1',
        folderPath: '/INBOX',
        headerMessageId: 'no-key@example.com',
        msgKey: null,
        eventType: 'cursorScan',
      }] } },
    });

    const first = await _runFolderReconcile(fts);

    expect(first.missingEnqueued).toBe(1);
    expect(_getPendingUpdates().has(KEY_A('no-key@example.com'))).toBe(true);

    fts._keys.add(KEY_A('no-key@example.com'));
    _getPendingUpdates().clear();
    await _runFolderReconcile(fts);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'].verified).toBe(true);
  });

  it('fails closed when native filtering returns a row absent from its input', async () => {
    const actual = KEY_A('expected@example.com');
    const fts = makeFtsStore([]);
    fts.filterNewMessages.mockResolvedValue({
      ok: true,
      newMsgIds: [KEY_A('unmapped@example.com')],
    });
    mockNotify([folderA({ uidCount: 1, uidSha256: 'uid-one' })], {
      actualKeysByURI: { [URI_A]: [actual] },
      keysByURI: { [URI_A]: [1] },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersFailed).toBe(1);
    expect(stats.missingEnqueued).toBe(0);
    expect(_getPendingUpdates().size).toBe(0);
    expect(storageData[FOLDER_RECON_STORAGE_KEY]).toBeUndefined();
    expect(logFtsOperation).toHaveBeenCalledWith('folder_recon', 'filter_result_unmapped', {
      msgId: KEY_A('unmapped@example.com'),
      folderPath: '/INBOX',
    });
  });

  it('prefers a numeric duplicate over a keyless row without double-charging replay work', async () => {
    _setFolderReconBudgetOverride({ enqueues: 2 });
    const duplicate = KEY_A('duplicate@example.com');
    const second = KEY_A('second@example.com');
    const fts = makeFtsStore([]);
    mockNotify([folderA({ uidCount: 2, uidSha256: 'uid-two' })], {
      actualKeysByURI: { [URI_A]: [duplicate, second] },
      keysByURI: { [URI_A]: [1, 2] },
      infosByURI: { [URI_A]: { infos: [
        { accountId: 'account1', folderPath: '/INBOX', headerMessageId: 'duplicate@example.com', msgKey: null, eventType: 'cursorScan' },
        { accountId: 'account1', folderPath: '/INBOX', headerMessageId: 'duplicate@example.com', msgKey: 1, eventType: 'cursorScan' },
        { accountId: 'account1', folderPath: '/INBOX', headerMessageId: 'second@example.com', msgKey: 2, eventType: 'cursorScan' },
      ] } },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.missingEnqueued).toBe(2);
    expect(_getPendingUpdates().has(duplicate)).toBe(true);
    expect(_getPendingUpdates().has(second)).toBe(true);
  });

  it('restarts safely from zero when a persisted partial cursor is corrupt', async () => {
    _setFolderReconBudgetOverride({ scans: 1 });
    const missing = KEY_A('msg-1@example.com');
    seedMemo({
      'account1:/INBOX': {
        verified: false,
        partialExpectedSha256: digest([missing]),
        missingBackfillKey: '1',
        partialStableUidKeys: true,
        partialUidValidity: 7,
      },
    });
    const fts = makeFtsStore([]);
    mockNotify([folderA({ uidCount: 1, uidSha256: 'uid-one' })], {
      actualKeysByURI: { [URI_A]: [missing] },
      keysByURI: { [URI_A]: [1] },
    });

    await _runFolderReconcile(fts);

    expect(_getPendingUpdates().has(missing)).toBe(true);
  });

  it.each([
    ['fractional', 1.5],
    ['below the signed-int32 compatibility floor', -0x80000001],
    ['above uint32', 0x100000001],
    ['the signed nsMsgKey_None sentinel', -1],
    ['the unsigned nsMsgKey_None sentinel', 0xffffffff],
  ])('restarts from zero for a %s partial cursor without skipping a missing low key', async (_kind, corruptCursor) => {
    _setFolderReconBudgetOverride({ scans: 2 });
    const missingLow = KEY_A('low@example.com');
    const indexedTail = KEY_A('tail@example.com');
    seedMemo({
      'account1:/INBOX': {
        verified: false,
        partialExpectedCount: 2,
        partialExpectedSha256: digest([missingLow, indexedTail]),
        missingBackfillKey: corruptCursor,
        partialStableUidKeys: true,
        partialUidValidity: 7,
      },
    });
    const fts = makeFtsStore([indexedTail]);
    const api = mockNotify([folderA({ uidCount: 2, uidSha256: 'uid-two' })], {
      actualKeysByURI: { [URI_A]: [missingLow, indexedTail] },
      headerIdsByKeyByURI: { [URI_A]: {
        1: 'low@example.com',
        2: 'tail@example.com',
      } },
      keysByURI: { [URI_A]: [1, 2] },
    });

    await _runFolderReconcile(fts);

    expect(api.listKeysAboveKey).toHaveBeenCalledWith(URI_A, 0, 0);
    expect(_getPendingUpdates().has(missingLow)).toBe(true);
  });

  it('canonicalizes a legitimate signed high-bit partial cursor instead of restarting it', async () => {
    _setFolderReconBudgetOverride({ scans: 1 });
    const indexedBeforeCursor = KEY_A('before-cursor@example.com');
    const missingAfterCursor = KEY_A('after-cursor@example.com');
    seedMemo({
      'account1:/INBOX': {
        verified: false,
        partialExpectedCount: 2,
        partialExpectedSha256: digest([indexedBeforeCursor, missingAfterCursor]),
        missingBackfillKey: -0x80000000,
        partialStableUidKeys: true,
        partialUidValidity: 7,
      },
    });
    const fts = makeFtsStore([indexedBeforeCursor]);
    const api = mockNotify([folderA({ uidCount: 2, uidSha256: 'uid-high' })], {
      actualKeysByURI: { [URI_A]: [indexedBeforeCursor, missingAfterCursor] },
      headerIdsByKeyByURI: { [URI_A]: {
        [0x80000000]: 'before-cursor@example.com',
        [0x80000001]: 'after-cursor@example.com',
      } },
      keysByURI: { [URI_A]: [0x80000000, 0x80000001] },
    });

    await _runFolderReconcile(fts);

    expect(api.listKeysAboveKey).toHaveBeenCalledWith(URI_A, 0x80000000, 0);
    expect(_getPendingUpdates().has(missingAfterCursor)).toBe(true);
  });

  it('replays a no-msgKey row when the enqueue budget is initially exhausted', async () => {
    _setFolderReconBudgetOverride({ enqueues: 0 });
    const actualKeys = [KEY_A('no-key@example.com')];
    const fts = makeFtsStore([]);
    mockNotify([folderA({ uidCount: 1, uidSha256: 'uid-no-key' })], {
      actualKeysByURI: { [URI_A]: actualKeys },
      keysByURI: { [URI_A]: [1] },
      infosByURI: { [URI_A]: { infos: [{
        accountId: 'account1',
        folderPath: '/INBOX',
        headerMessageId: 'no-key@example.com',
        msgKey: null,
        eventType: 'cursorScan',
      }] } },
    });

    const first = await _runFolderReconcile(fts);
    expect(first.foldersBudgetPartial).toBe(1);
    expect(_getPendingUpdates().size).toBe(0);

    _setFolderReconBudgetOverride({ enqueues: 1 });
    await _runFolderReconcile(fts);
    expect(_getPendingUpdates().has(KEY_A('no-key@example.com'))).toBe(true);
  });

  it('replays a completed sweep after a transient filter false-negative', async () => {
    const actualKeys = [KEY_A('msg-1@example.com')];
    const fts = makeFtsStore([]);
    const realFilter = fts.filterNewMessages.getMockImplementation();
    fts.filterNewMessages.mockResolvedValueOnce({ ok: true, newMsgIds: [] });
    mockNotify([folderA({ uidCount: 1, uidSha256: 'uid-one' })], {
      actualKeysByURI: { [URI_A]: actualKeys },
      keysByURI: { [URI_A]: [1] },
    });

    const first = await _runFolderReconcile(fts);
    expect(first.foldersFailed).toBe(1);
    expect(_getPendingUpdates().size).toBe(0);

    fts.filterNewMessages.mockImplementation(realFilter);
    await _runFolderReconcile(fts);

    expect(_getPendingUpdates().has(KEY_A('msg-1@example.com'))).toBe(true);
  });

  it('backs off repeated unchanged terminal failures while preserving eventual retry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const actual = KEY_A('msg-1@example.com');
    const headerIdsByKey = { 1: 'msg-1@example.com' };
    const fts = makeFtsStore([]);
    const realFilter = fts.filterNewMessages.getMockImplementation();
    fts.filterNewMessages.mockResolvedValueOnce({ ok: true, newMsgIds: [] });
    mockNotify([folderA({ uidValidity: 0, uidCount: 1, uidSha256: 'uid-one' })], {
      headerIdsByKeyByURI: { [URI_A]: headerIdsByKey },
      keysByURI: { [URI_A]: [1] },
    });

    // First terminal miss is replayed immediately so a transient false
    // negative does not incur a delay.
    await _runFolderReconcile(fts);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
      .toMatchObject({ partialPostVerifyFailureCount: 1, missingBackfillKey: 0 });

    // The immediate replay queues the row. Its high-water checkpoint must
    // retain the terminal-failure history across the simulated failed drain.
    fts.filterNewMessages.mockImplementation(realFilter);
    await _runFolderReconcile(fts);
    expect(_getPendingUpdates().has(actual)).toBe(true);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
      .toMatchObject({ partialPostVerifyFailureCount: 1, missingBackfillKey: 1 });
    _getPendingUpdates().clear();

    await _runFolderReconcile(fts);
    const delayed = storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'];
    expect(delayed.partialPostVerifyFailureCount).toBe(2);
    expect(delayed.partialRetryNotBeforeMs).toBeGreaterThan(Date.now());

    const filterCalls = fts.filterNewMessages.mock.calls.length;
    const skipped = await _runFolderReconcile(fts);
    expect(skipped.foldersBackoff).toBe(1);
    expect(skipped.missingEnqueued).toBe(0);
    expect(fts.filterNewMessages).toHaveBeenCalledTimes(filterCalls);

    now.mockReturnValue(delayed.partialRetryNotBeforeMs + 1);
    await _runFolderReconcile(fts);
    expect(_getPendingUpdates().has(actual)).toBe(true);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
      .toMatchObject({ partialPostVerifyFailureCount: 2, missingBackfillKey: 1 });
    now.mockRestore();
  });

  it('bypasses terminal-failure backoff when the exact key mapping changes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const actual = KEY_A('same@example.com');
    seedMemo({
      'account1:/INBOX': {
        verified: false,
        partialExpectedCount: 1,
        partialExpectedSha256: digest([actual]),
        partialKeyMapCount: 1,
        partialKeyMapSha256: keyMapDigest([[2, actual]]),
        missingBackfillKey: 2,
        partialPostVerifyFailureCount: 3,
        partialRetryNotBeforeMs: 9_000_000,
      },
    });
    const fts = makeFtsStore([]);
    mockNotify([folderA({ uidValidity: 0, uidCount: 1, uidSha256: 'same-set' })], {
      headerIdsByKeyByURI: { [URI_A]: { 1: 'same@example.com' } },
      keysByURI: { [URI_A]: [1] },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersBackoff).toBe(0);
    expect(_getPendingUpdates().has(actual)).toBe(true);
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
      .not.toHaveProperty('partialPostVerifyFailureCount');
    now.mockRestore();
  });

  it('lets later folders use the shared enqueue budget while an unchanged failure is backed off', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const missingA = KEY_A('stuck@example.com');
    const missingB = KEY_B('healable@example.com');
    seedMemo({
      'account1:/INBOX': {
        verified: false,
        partialExpectedCount: 1,
        partialExpectedSha256: digest([missingA]),
        partialKeyMapCount: 1,
        partialKeyMapSha256: keyMapDigest([[1, missingA]]),
        missingBackfillKey: 0,
        partialPostVerifyFailureCount: 2,
        partialRetryNotBeforeMs: 9_000_000,
      },
    });
    const fts = makeFtsStore([]);
    _setFolderReconBudgetOverride({ enqueues: 1 });
    mockNotify([
      folderA({ uidValidity: 0, uidCount: 1, uidSha256: 'uid-a-one' }),
      folderB({ uidCount: 1, uidSha256: 'uid-b-one' }),
    ], {
      headerIdsByKeyByURI: {
        [URI_A]: { 1: 'stuck@example.com' },
        [URI_B]: { 1: 'healable@example.com' },
      },
      keysByURI: { [URI_A]: [1], [URI_B]: [1] },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersBackoff).toBe(1);
    expect(stats.missingEnqueued).toBe(1);
    expect(_getPendingUpdates().has(missingA)).toBe(false);
    expect(_getPendingUpdates().has(missingB)).toBe(true);
    now.mockRestore();
  });

  it('caps exponential terminal-failure retry delay while preserving eventual retries', async () => {
    const nowMs = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const actual = KEY_A('stuck@example.com');
    seedMemo({
      'account1:/INBOX': {
        verified: false,
        partialExpectedCount: 1,
        partialExpectedSha256: digest([actual]),
        partialKeyMapCount: 1,
        partialKeyMapSha256: keyMapDigest([[1, actual]]),
        missingBackfillKey: 1,
        partialPostVerifyFailureCount: 40,
        partialRetryNotBeforeMs: nowMs - 1,
      },
    });
    const fts = makeFtsStore([]);
    mockNotify([folderA({ uidValidity: 0, uidCount: 1, uidSha256: 'uid-one' })], {
      headerIdsByKeyByURI: { [URI_A]: { 1: 'stuck@example.com' } },
      keysByURI: { [URI_A]: [1] },
    });

    await _runFolderReconcile(fts);

    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
      .toMatchObject({
        partialPostVerifyFailureCount: 41,
        partialRetryNotBeforeMs: nowMs + (7 * 24 * 60 * 60 * 1000),
      });
    now.mockRestore();
  });

  it('clamps and persists a corrupt retry deadline beyond the seven-day cap', async () => {
    const nowMs = 1_000_000;
    const maxBackoffMs = 7 * 24 * 60 * 60 * 1000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const actual = KEY_A('stuck@example.com');
    seedMemo({
      'account1:/INBOX': {
        verified: false,
        partialExpectedCount: 1,
        partialExpectedSha256: digest([actual]),
        partialKeyMapCount: 1,
        partialKeyMapSha256: keyMapDigest([[1, actual]]),
        missingBackfillKey: 1,
        partialPostVerifyFailureCount: 3,
        partialRetryNotBeforeMs: nowMs + maxBackoffMs + 123_456,
      },
    });
    const fts = makeFtsStore([KEY_A('stale@example.com')]);
    // Persistence of the sanitized memo must not depend on the later repair
    // pass succeeding.
    fts.listMsgIdRange.mockRejectedValue(new Error('simulated list failure'));
    const api = mockNotify([folderA({ uidValidity: 0, uidCount: 1, uidSha256: 'uid-one' })], {
      headerIdsByKeyByURI: { [URI_A]: { 1: 'stuck@example.com' } },
      keysByURI: { [URI_A]: [1] },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersFailed).toBe(1);
    expect(api.listKeysAboveKey).not.toHaveBeenCalled();
    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
      .toMatchObject({
        partialPostVerifyFailureCount: 3,
        partialRetryNotBeforeMs: nowMs + maxBackoffMs,
      });
    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      [FOLDER_RECON_STORAGE_KEY]: storageData[FOLDER_RECON_STORAGE_KEY],
    });
    now.mockRestore();
  });

  it('sanitizes a rollback-skewed retry deadline once without extending it on every read', async () => {
    const firstNowMs = 2_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    const maxBackoffMs = 7 * dayMs;
    const now = vi.spyOn(Date, 'now').mockReturnValue(firstNowMs);
    const actual = KEY_A('stuck@example.com');
    seedMemo({
      'account1:/INBOX': {
        verified: false,
        partialExpectedCount: 1,
        partialExpectedSha256: digest([actual]),
        partialKeyMapCount: 1,
        partialKeyMapSha256: keyMapDigest([[1, actual]]),
        missingBackfillKey: 1,
        partialPostVerifyFailureCount: 4,
        // Represents a deadline minted before the wall clock rolled back.
        partialRetryNotBeforeMs: firstNowMs + (30 * dayMs),
      },
    });
    const fts = makeFtsStore([]);
    mockNotify([folderA({ uidValidity: 0, uidCount: 1, uidSha256: 'uid-one' })], {
      headerIdsByKeyByURI: { [URI_A]: { 1: 'stuck@example.com' } },
      keysByURI: { [URI_A]: [1] },
    });

    await _runFolderReconcile(fts);
    const sanitizedDeadline = storageData[FOLDER_RECON_STORAGE_KEY]
      .folders['account1:/INBOX'].partialRetryNotBeforeMs;
    expect(sanitizedDeadline).toBe(firstNowMs + maxBackoffMs);

    now.mockReturnValue(firstNowMs + dayMs);
    await _runFolderReconcile(fts);

    expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX']
      .partialRetryNotBeforeMs).toBe(sanitizedDeadline);
    now.mockRestore();
  });

  it('retries immediately when a persisted retry deadline is beyond safe integer precision', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const actual = KEY_A('stuck@example.com');
      seedMemo({
        'account1:/INBOX': {
          verified: false,
          partialExpectedCount: 1,
          partialExpectedSha256: digest([actual]),
          partialKeyMapCount: 1,
          partialKeyMapSha256: keyMapDigest([[1, actual]]),
          missingBackfillKey: 0,
          partialPostVerifyFailureCount: 3,
          partialRetryNotBeforeMs: 1e300,
        },
      });
      const fts = makeFtsStore([]);
      const api = mockNotify([folderA({ uidValidity: 0, uidCount: 1, uidSha256: 'uid-one' })], {
        headerIdsByKeyByURI: { [URI_A]: { 1: 'stuck@example.com' } },
        keysByURI: { [URI_A]: [1] },
      });

      const stats = await _runFolderReconcile(fts);

      expect(stats.foldersBackoff).toBe(0);
      expect(stats.missingEnqueued).toBe(1);
      expect(api.listKeysAboveKey).toHaveBeenCalledWith(URI_A, 0, 0);
      expect(_getPendingUpdates().has(actual)).toBe(true);
      expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
        .not.toHaveProperty('partialRetryNotBeforeMs');
    } finally {
      now.mockRestore();
    }
  });

  it('clears terminal-failure backoff immediately when exact equality is restored', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const actual = KEY_A('same@example.com');
      seedMemo({
        'account1:/INBOX': {
          verified: false,
          partialExpectedCount: 1,
          partialExpectedSha256: digest([actual]),
          partialKeyMapCount: 1,
          partialKeyMapSha256: keyMapDigest([[1, actual]]),
          missingBackfillKey: 0,
          partialPostVerifyFailureCount: 3,
          partialRetryNotBeforeMs: 9_000_000,
        },
      });
      const fts = makeFtsStore([actual]);
      mockNotify([folderA({ uidValidity: 0, uidCount: 1, uidSha256: 'same-set' })], {
        headerIdsByKeyByURI: { [URI_A]: { 1: 'same@example.com' } },
        msgDbByURI: { [URI_A]: new Set(['same@example.com']) },
        keysByURI: { [URI_A]: [1] },
      });

      const stats = await _runFolderReconcile(fts);

      expect(stats.foldersClean).toBe(1);
      expect(stats.foldersReconciled).toBe(0);
      expect(stats.foldersBackoff).toBe(0);
      expect(fts.listMsgIdRange).not.toHaveBeenCalled();
      expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX']).toMatchObject({
        verified: true,
        expectedSha256: digest([actual]),
      });
      expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
        .not.toHaveProperty('partialPostVerifyFailureCount');
      expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
        .not.toHaveProperty('partialRetryNotBeforeMs');
    } finally {
      now.mockRestore();
    }
  });

  it('clears active terminal-failure backoff when stale removal restores exact equality', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const actual = KEY_A('same@example.com');
      const ghost = KEY_A('ghost@example.com');
      seedMemo({
        'account1:/INBOX': {
          verified: false,
          partialExpectedCount: 1,
          partialExpectedSha256: digest([actual]),
          partialKeyMapCount: 1,
          partialKeyMapSha256: keyMapDigest([[1, actual]]),
          missingBackfillKey: 0,
          partialPostVerifyFailureCount: 3,
          partialRetryNotBeforeMs: 9_000_000,
        },
      });
      const fts = makeFtsStore([actual, ghost]);
      const api = mockNotify([folderA({ uidValidity: 0, uidCount: 1, uidSha256: 'same-set' })], {
        headerIdsByKeyByURI: { [URI_A]: { 1: 'same@example.com' } },
        msgDbByURI: { [URI_A]: new Set(['same@example.com']) },
        keysByURI: { [URI_A]: [1] },
      });

      expect(fts._keys).toEqual(new Set([actual, ghost]));
      const stats = await _runFolderReconcile(fts);

      expect(stats.staleRemoved).toBe(1);
      expect(stats.foldersReconciled).toBe(1);
      expect(stats.foldersBackoff).toBe(0);
      expect(api.listKeysAboveKey).not.toHaveBeenCalled();
      expect(fts._keys).toEqual(new Set([actual]));
      expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX']).toMatchObject({
        verified: true,
        expectedSha256: digest([actual]),
      });
      expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
        .not.toHaveProperty('partialPostVerifyFailureCount');
      expect(storageData[FOLDER_RECON_STORAGE_KEY].folders['account1:/INBOX'])
        .not.toHaveProperty('partialRetryNotBeforeMs');
    } finally {
      now.mockRestore();
    }
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
    const folderFingerprint = schema[0].functions.find(fn => fn.name === 'fingerprintFolderMessages');
    expect(folderFingerprint.returns.properties.keyMapCount).toBeTruthy();
    expect(folderFingerprint.returns.properties.keyMapSha256).toBeTruthy();
    const experimentSource = readFileSync(fileURLToPath(new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url)), 'utf8');
    expect(experimentSource).not.toContain('new TextEncoder');
    expect(experimentSource).toContain('function encodeUtf8');
    expect(experimentSource).toContain('keyMappings.push(`${key >>> 0}:${uniqueKey}`)');
    expect(experimentSource).toContain('keyMapSha256: keyMapFingerprint.sha256');
  });

  it('keeps the drain-empty rerun hook wired into the queue processor', () => {
    const source = readFileSync(fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url)), 'utf8');
    const branch = source.match(/if \(_pendingUpdates\.size === 0\) \{[\s\S]*?\} else \{/);
    expect(branch?.[0]).toContain('_maybeScheduleFolderReconRerun()');
    expect(logFtsOperation).toBeDefined();
  });
});
