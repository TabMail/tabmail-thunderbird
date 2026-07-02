/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ftsCursorScan.test.js — Tests for the per-folder msgKey/UID cursor scan
// (Phase 1b of runPostInitReconcile) and the heartbeat cursor advance.
// See PLAN_RECONCILE_CURSOR.md / ADR-020.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  parseUniqueId: vi.fn(),
  recheckMessageInFolder: vi.fn(),
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
          return { [keyOrDefault]: storageData[keyOrDefault] || null };
        }
        const result = {};
        for (const [k, def] of Object.entries(keyOrDefault)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => { Object.assign(storageData, obj); }),
      remove: vi.fn(async (key) => { delete storageData[key]; }),
    },
  },
};

const { logFtsOperation } = await import('../agent/modules/eventLogger.js');
const { onExperimentMessageAdded, _testExports } = await import('../fts/incrementalIndexer.js');
const {
  _runCursorScan,
  _heartbeatAdvanceCursors,
  _noteSessionMaxKey,
  _getSessionMaxKeyByFolder,
  _clearSessionMaxKeyByFolder,
  _getPendingUpdates,
  _setIsEnabled,
  _setExperimentListenersActive,
  _setFtsSearch,
  _setIndexerDisposed,
  _setLastSyncEventMs,
  _getLastSyncEventMs,
  CURSOR_STORAGE_KEY,
  CURSOR_FULL_SCAN_MAX_KEYS,
} = _testExports;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const URI_A = 'imap://user@host/INBOX';
const URI_B = 'imap://user@host/%5BGmail%5D/All%20Mail';

function folderA(over = {}) {
  return {
    accountId: 'account1',
    folderPath: '/INBOX',
    folderURI: URI_A,
    uidValidity: 111,
    highWater: 100,
    totalMessages: 10,
    ...over,
  };
}

function folderB(over = {}) {
  return {
    accountId: 'account3',
    folderPath: '/[Gmail]/All Mail',
    folderURI: URI_B,
    uidValidity: 333,
    highWater: 500,
    totalMessages: 50,
    ...over,
  };
}

function infoForKey(folder, key) {
  return {
    headerMessageId: `msg-${key}@example.com`,
    weMsgId: null,
    weFolderId: null,
    folderPath: folder.folderPath,
    accountId: folder.accountId,
    subject: `subject ${key}`,
    author: 'a@example.com',
    dateMs: 0,
    msgKey: key,
    eventType: 'cursorScan',
  };
}

/**
 * Install a browser.tmMsgNotify mock. keysByURI maps folderURI ->
 * listKeysAboveKey result; infos are derived from the folder + keys unless
 * infosByURI overrides (set to { error } to simulate RPC failure).
 */
function mockNotify(folders, { keysByURI = {}, infosByURI = {} } = {}) {
  const byURI = Object.fromEntries(folders.map(f => [f.folderURI, f]));
  const api = {
    getCursorFolders: vi.fn(async () => folders),
    listKeysAboveKey: vi.fn(async (uri, _sinceKey, _maxKeys) =>
      keysByURI[uri] || { keys: [], truncated: false, totalAbove: 0 }
    ),
    getMessageInfosForKeys: vi.fn(async (uri, keys) => {
      if (infosByURI[uri]) return infosByURI[uri];
      const f = byURI[uri];
      return { infos: keys.map(k => infoForKey(f, k)) };
    }),
  };
  globalThis.browser.tmMsgNotify = api;
  return api;
}

function storedCursors() {
  return storageData[CURSOR_STORAGE_KEY];
}

function seedCursorStore(folders) {
  storageData[CURSOR_STORAGE_KEY] = {
    version: 1,
    seededAtMs: Date.now() - 1000000,
    folders,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) delete storageData[key];
  delete globalThis.browser.tmMsgNotify;
  _getPendingUpdates().clear();
  _clearSessionMaxKeyByFolder();
  _setIsEnabled(true);
  _setExperimentListenersActive(true);
  // No FTS engine: enqueues land in the pending map but the drain loop
  // early-returns, keeping tests deterministic.
  _setFtsSearch(null);
  _setIndexerDisposed(false);
});

// ---------------------------------------------------------------------------
// _runCursorScan
// ---------------------------------------------------------------------------

describe('_runCursorScan', () => {
  it('first run seeds all folders to highWater without enumeration', async () => {
    const api = mockNotify([folderA(), folderB()]);

    const stats = await _runCursorScan();

    expect(stats.foldersSeeded).toBe(2);
    expect(stats.foldersScanned).toBe(0);
    expect(api.listKeysAboveKey).not.toHaveBeenCalled();
    expect(api.getMessageInfosForKeys).not.toHaveBeenCalled();

    const cur = storedCursors();
    expect(cur.folders['account1:/INBOX']).toMatchObject({ uidValidity: 111, highestKeySeen: 100 });
    expect(cur.folders['account3:/[Gmail]/All Mail']).toMatchObject({ uidValidity: 333, highestKeySeen: 500 });
    expect(_getPendingUpdates().size).toBe(0);
  });

  it('unchanged folder (same uidValidity, highWater == cursor) does zero scan work', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });
    const api = mockNotify([folderA()]);

    const stats = await _runCursorScan();

    expect(stats.foldersUnchanged).toBe(1);
    expect(api.listKeysAboveKey).not.toHaveBeenCalled();
    expect(_getPendingUpdates().size).toBe(0);
  });

  it('diff path enqueues keys above the cursor and advances it', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });
    const api = mockNotify([folderA({ highWater: 105 })], {
      keysByURI: { [URI_A]: { keys: [101, 102, 103, 104, 105], truncated: false, totalAbove: 5 } },
    });

    const stats = await _runCursorScan();

    expect(api.listKeysAboveKey).toHaveBeenCalledWith(URI_A, 100, CURSOR_FULL_SCAN_MAX_KEYS);
    expect(stats.keysEnqueued).toBe(5);
    expect(stats.foldersAdvanced).toBe(1);

    const pending = _getPendingUpdates();
    expect(pending.size).toBe(5);
    const entry = pending.get('account1:/INBOX:msg-101@example.com');
    expect(entry).toBeTruthy();
    expect(entry.type).toBe('new');
    expect(entry.metadata.fromCursorScan).toBe(true);

    expect(storedCursors().folders['account1:/INBOX'].highestKeySeen).toBe(105);
  });

  it('RPC failure in one folder keeps its cursor while other folders advance', async () => {
    seedCursorStore({
      'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 },
      'account3:/[Gmail]/All Mail': { uidValidity: 333, highestKeySeen: 490, updatedAtMs: 1 },
    });
    mockNotify([folderA({ highWater: 102 }), folderB({ highWater: 500 })], {
      keysByURI: {
        [URI_A]: { keys: [101, 102], truncated: false, totalAbove: 2 },
        [URI_B]: { keys: [491, 492], truncated: false, totalAbove: 2 },
      },
      infosByURI: { [URI_B]: { infos: [], error: 'native boom' } },
    });

    const stats = await _runCursorScan();

    expect(stats.foldersAdvanced).toBe(1);
    expect(stats.foldersSkipped).toBe(1);
    const cur = storedCursors();
    expect(cur.folders['account1:/INBOX'].highestKeySeen).toBe(102);
    // Failed folder keeps the old cursor → retried next boot
    expect(cur.folders['account3:/[Gmail]/All Mail'].highestKeySeen).toBe(490);
  });

  it('UIDVALIDITY mismatch triggers a full scan from key 0 and re-mints the cursor', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });
    const api = mockNotify([folderA({ uidValidity: 999, highWater: 50 })], {
      keysByURI: { [URI_A]: { keys: [10, 20, 50], truncated: false, totalAbove: 3 } },
    });

    const stats = await _runCursorScan();

    expect(api.listKeysAboveKey).toHaveBeenCalledWith(URI_A, 0, CURSOR_FULL_SCAN_MAX_KEYS);
    expect(stats.keysEnqueued).toBe(3);
    expect(storedCursors().folders['account1:/INBOX']).toMatchObject({
      uidValidity: 999,
      highestKeySeen: 50,
    });
  });

  it('a folder without a cursor after first run is fully scanned from key 0', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });
    const api = mockNotify([folderA(), folderB({ highWater: 7 })], {
      keysByURI: { [URI_B]: { keys: [3, 7], truncated: false, totalAbove: 2 } },
    });

    const stats = await _runCursorScan();

    expect(api.listKeysAboveKey).toHaveBeenCalledWith(URI_B, 0, CURSOR_FULL_SCAN_MAX_KEYS);
    expect(stats.keysEnqueued).toBe(2);
    expect(storedCursors().folders['account3:/[Gmail]/All Mail']).toMatchObject({
      uidValidity: 333,
      highestKeySeen: 7,
    });
  });

  it('truncated full scan enqueues the returned newest keys, logs it, and still advances', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });
    mockNotify([folderA({ uidValidity: 999, highWater: 9000 })], {
      keysByURI: { [URI_A]: { keys: [8998, 8999, 9000], truncated: true, totalAbove: 9000 } },
    });

    const stats = await _runCursorScan();

    expect(stats.truncatedScans).toBe(1);
    expect(stats.keysEnqueued).toBe(3);
    expect(stats.foldersAdvanced).toBe(1);
    expect(logFtsOperation).toHaveBeenCalledWith('cursor_scan', 'truncated', expect.objectContaining({
      totalAbove: 9000,
    }));
    expect(storedCursors().folders['account1:/INBOX'].highestKeySeen).toBe(9000);
  });

  it('corrupt cursor entry (non-numeric highestKeySeen) triggers a re-minting full scan', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 'garbage', updatedAtMs: 1 } });
    const api = mockNotify([folderA({ highWater: 3 })], {
      keysByURI: { [URI_A]: { keys: [1, 2, 3], truncated: false, totalAbove: 3 } },
    });

    const stats = await _runCursorScan();

    expect(api.listKeysAboveKey).toHaveBeenCalledWith(URI_A, 0, CURSOR_FULL_SCAN_MAX_KEYS);
    expect(stats.keysEnqueued).toBe(3);
    expect(storedCursors().folders['account1:/INBOX']).toMatchObject({
      uidValidity: 111,
      highestKeySeen: 3,
    });
  });

  it('resolves keys in chunks of CURSOR_KEYS_CHUNK and advances past the last chunk', async () => {
    const total = _testExports.CURSOR_KEYS_CHUNK + 1; // forces two RPC calls
    const keys = Array.from({ length: total }, (_, i) => 101 + i);
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });
    const api = mockNotify([folderA({ highWater: 100 + total })], {
      keysByURI: { [URI_A]: { keys, truncated: false, totalAbove: total } },
    });

    const stats = await _runCursorScan();

    expect(api.getMessageInfosForKeys).toHaveBeenCalledTimes(2);
    expect(api.getMessageInfosForKeys.mock.calls[0][1]).toHaveLength(_testExports.CURSOR_KEYS_CHUNK);
    expect(api.getMessageInfosForKeys.mock.calls[1][1]).toEqual([100 + total]);
    expect(stats.keysEnqueued).toBe(total);
    expect(storedCursors().folders['account1:/INBOX'].highestKeySeen).toBe(100 + total);
  });

  it('is skipped cleanly when the experiment API is unavailable', async () => {
    // no browser.tmMsgNotify installed
    const result = await _runCursorScan();

    expect(result.skipped).toBe(true);
    expect(storedCursors()).toBeUndefined();
  });

  it('folder reported with an msgDB error is skipped — never seeded or advanced', async () => {
    const api = mockNotify([folderA(), folderB({ error: 'summary out of date' })]);

    const stats = await _runCursorScan();

    expect(stats.foldersSeeded).toBe(1);
    expect(stats.foldersSkipped).toBe(1);
    expect(api.listKeysAboveKey).not.toHaveBeenCalled();
    const cur = storedCursors();
    expect(cur.folders['account1:/INBOX']).toBeTruthy();
    expect(cur.folders['account3:/[Gmail]/All Mail']).toBeUndefined();
  });

  it('getCursorFolders throwing skips the scan without writing cursors', async () => {
    globalThis.browser.tmMsgNotify = {
      getCursorFolders: vi.fn(async () => { throw new Error('ipc dead'); }),
    };

    const result = await _runCursorScan();

    expect(result.skipped).toBe(true);
    expect(storedCursors()).toBeUndefined();
  });

  it('cursor-scan enqueues do NOT bump the sync-quiet signal (unlike live events)', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });
    mockNotify([folderA({ highWater: 101 })], {
      keysByURI: { [URI_A]: { keys: [101], truncated: false, totalAbove: 1 } },
    });

    _setLastSyncEventMs(12345);
    await _runCursorScan();
    expect(_getLastSyncEventMs()).toBe(12345);

    // Live event path DOES bump it
    await onExperimentMessageAdded(infoForKey(folderA(), 200));
    expect(_getLastSyncEventMs()).toBeGreaterThan(12345);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat cursor advance
// ---------------------------------------------------------------------------

describe('_heartbeatAdvanceCursors', () => {
  it('advances existing cursors from session-max keys delivered by events', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });

    await onExperimentMessageAdded(infoForKey(folderA(), 150));
    expect(_getSessionMaxKeyByFolder().get('account1:/INBOX')).toBe(150);

    await _heartbeatAdvanceCursors();

    expect(storedCursors().folders['account1:/INBOX'].highestKeySeen).toBe(150);
  });

  it('never advances backwards and ignores lower session keys', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });

    _noteSessionMaxKey({ accountId: 'account1', folderPath: '/INBOX', msgKey: 90 });
    await _heartbeatAdvanceCursors();

    expect(storedCursors().folders['account1:/INBOX'].highestKeySeen).toBe(100);
  });

  it('refuses to create the cursor store (boot scan is the sole minter)', async () => {
    _noteSessionMaxKey({ accountId: 'account1', folderPath: '/INBOX', msgKey: 150 });

    await _heartbeatAdvanceCursors();

    expect(storedCursors()).toBeUndefined();
  });

  it('refuses to create entries for folders the boot scan has not minted', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });

    _noteSessionMaxKey({ accountId: 'account9', folderPath: '/Other', msgKey: 5 });
    await _heartbeatAdvanceCursors();

    expect(storedCursors().folders['account9:/Other']).toBeUndefined();
  });

  it('is skipped while the drain queue is stalled', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });
    _noteSessionMaxKey({ accountId: 'account1', folderPath: '/INBOX', msgKey: 150 });

    // A pending update older than 2× the heartbeat interval = stalled drain
    _getPendingUpdates().set('account1:/INBOX:stuck@example.com', {
      type: 'new',
      uniqueKey: 'account1:/INBOX:stuck@example.com',
      timestamp: Date.now() - 25 * 60 * 1000,
      metadata: {},
    });

    await _heartbeatAdvanceCursors();

    expect(storedCursors().folders['account1:/INBOX'].highestKeySeen).toBe(100);
  });

  it('does nothing when disposed', async () => {
    seedCursorStore({ 'account1:/INBOX': { uidValidity: 111, highestKeySeen: 100, updatedAtMs: 1 } });
    _noteSessionMaxKey({ accountId: 'account1', folderPath: '/INBOX', msgKey: 150 });
    _setIndexerDisposed(true);

    await _heartbeatAdvanceCursors();

    expect(storedCursors().folders['account1:/INBOX'].highestKeySeen).toBe(100);
  });
});
