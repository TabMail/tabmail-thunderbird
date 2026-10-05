/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ftsReconcile.test.js — Tests for FTS boot-time reconciliation: the orphan
// tail's quiet predicate and the fingerprint startup path. (The legacy
// date-window stale-entry cleanup had no production caller and was deleted,
// with its tests, in PR 3b.)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
    eventLogger: { enabled: false },
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsOperation: vi.fn(),
  logFtsBatchOperation: vi.fn(),
  logMessageEventBatch: vi.fn(),
  logMoveEvent: vi.fn(),
}));

// Mock headerIDToWeID + recheckMessageInFolder + getUniqueMessageKey at
// module level — tests override per-case
const mockHeaderIDToWeID = vi.fn();
const mockRecheckMessageInFolder = vi.fn();
const mockGetUniqueMessageKey = vi.fn();
vi.mock('../agent/modules/utils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    headerIDToWeID: (...args) => mockHeaderIDToWeID(...args),
    recheckMessageInFolder: (...args) => mockRecheckMessageInFolder(...args),
    getUniqueMessageKey: (...args) => mockGetUniqueMessageKey(...args),
    log: vi.fn(),
  };
});

// Mock indexer.js (imported by incrementalIndexer but not used in reconcile)
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
        if (Array.isArray(keyOrDefault)) {
          return Object.fromEntries(keyOrDefault.map(key => [key, storageData[key]]));
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
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  messages: {
    get: vi.fn(),
    query: vi.fn(),
    continueList: vi.fn(),
  },
  folders: {
    query: vi.fn(async () => [{ id: 1, path: '/INBOX' }]),  // Default: folders available
    getSubFolders: vi.fn(),
  },
  accounts: {
    list: vi.fn(async () => []),
    get: vi.fn(async (id) => ({ id })),  // Default: account exists
  },
};

const { logFtsBatchOperation, logFtsOperation } = await import('../agent/modules/eventLogger.js');
const {
  getIncrementalIndexerStatus,
  onExperimentMessageRemoved,
  _testExports,
} = await import('../fts/incrementalIndexer.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockHeaderIDToWeID.mockReset();
  mockRecheckMessageInFolder.mockReset();
  mockGetUniqueMessageKey.mockReset();
  // Default: recheck confirms absence, so removal-path tests behave as before.
  // Verify-then-remove tests override this per-case.
  mockRecheckMessageInFolder.mockResolvedValue('absent');
  mockGetUniqueMessageKey.mockResolvedValue('account1:/INBOX:default-key@example.com');
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
});

// ---------------------------------------------------------------------------
// The orphan tail's quiet predicate (replaces the deleted volatile pending flag)
// ---------------------------------------------------------------------------

describe('_folderReconQuietSince (orphan tail quiet predicate)', () => {
  afterEach(() => {
    _testExports._getPendingUpdates().clear();
    _testExports._setIsEnabled(false);
  });

  it('holds for a quiet generation and has no side effect', () => {
    _testExports._setIsEnabled(true);
    _testExports._resetFolderReconState();
    const generation = _testExports._getFolderReconGeneration();
    const eventSerial = _testExports._getFolderReconEventSerial();
    expect(_testExports._folderReconQuietSince(generation, eventSerial)).toBe(true);
    // A pure predicate: asking again changes nothing.
    expect(_testExports._folderReconQuietSince(generation, eventSerial)).toBe(true);
  });

  it('refuses after a message event since the pass started, or a generation change', async () => {
    _testExports._setIsEnabled(true);
    _testExports._resetFolderReconState();
    const generation = _testExports._getFolderReconGeneration();
    // A real message event in the same millisecond as the pass start: only
    // its serial tells it apart.
    vi.useFakeTimers();
    try {
      _testExports._setLastSyncEventMs(Date.now());
      const eventSerial = _testExports._getFolderReconEventSerial();
      await onExperimentMessageRemoved({ accountId: 'account1', folderPath: '/INBOX', headerMessageId: '' });
      expect(_testExports._getLastSyncEventMs()).toBe(Date.now());
      expect(_testExports._folderReconQuietSince(generation, eventSerial)).toBe(false);
      // Control: a serial read after the event is quiet.
      expect(_testExports._folderReconQuietSince(
        generation,
        _testExports._getFolderReconEventSerial(),
      )).toBe(true);

      _testExports._resetFolderReconState();
      expect(_testExports._folderReconQuietSince(
        generation,
        _testExports._getFolderReconEventSerial(),
      )).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses while an update is queued', () => {
    _testExports._setIsEnabled(true);
    _testExports._resetFolderReconState();
    const generation = _testExports._getFolderReconGeneration();
    const eventSerial = _testExports._getFolderReconEventSerial();
    _testExports._getPendingUpdates().set('account1:/INBOX:queued@example.com', {
      uniqueKey: 'account1:/INBOX:queued@example.com',
      type: 'new',
      timestamp: Date.now(),
    });
    expect(_testExports._folderReconQuietSince(generation, eventSerial)).toBe(false);
    _testExports._getPendingUpdates().clear();
    expect(_testExports._folderReconQuietSince(generation, eventSerial)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Automatic startup path: fingerprint proof, not date-window scans
// ---------------------------------------------------------------------------

describe('runPostInitReconcile fingerprint path', () => {
  afterEach(() => {
    _testExports._setIsEnabled(false);
    delete browser.tmMsgNotify;
    browser.messages.query.mockReset();
    browser.messages.continueList.mockReset();
    _testExports._resetFolderReconState();
  });

  function arrangeFingerprintReconcile({ fingerprintImpl } = {}) {
    _testExports._setIsEnabled(true);
    _testExports._resetFolderReconState();
    storageData.fts_initial_scan_complete = true;
    browser.accounts.list.mockResolvedValue([{
      id: 'account1',
      type: 'imap',
      rootFolder: {
        path: '/',
        isRoot: true,
        subFolders: [{ path: '/INBOX', subFolders: [] }],
      },
    }]);
    browser.tmMsgNotify = {
      getFolderState: vi.fn(async () => ({
        accountId: 'account1',
        folderPath: '/INBOX',
        folderURI: 'imap://host/INBOX',
        serverType: 'imap',
        stableUidKeys: true,
        uidValidity: 1,
        uidCount: 0,
        uidSha256: 'empty-uids',
      })),
      probeMessageIds: vi.fn(async () => ({ missing: [] })),
      beginFolderMessageScan: vi.fn(async () => ({
        token: 'scan-1',
        accountId: 'account1',
        folderPath: '/INBOX',
        stableUidKeys: true,
        uidValidity: 1,
      })),
      readFolderMessageScanPage: vi.fn(async () => ({ rows: [], done: true })),
      cancelFolderMessageScan: vi.fn(async () => ({ cancelled: true })),
      listKeysAboveKey: vi.fn(async () => ({ keys: [] })),
      getMessageInfosForKeys: vi.fn(async () => ({ infos: [] })),
    };
    const empty = {
      ok: true,
      count: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };
    return {
      fingerprintMsgIdRange: vi.fn(fingerprintImpl || (async () => empty)),
      countMsgIdRange: vi.fn(async () => ({ ok: true, count: 0 })),
      listMsgIdRange: vi.fn(async () => ({ ok: true, msgIds: [], done: true })),
      removeBatch: vi.fn(async () => ({ count: 0 })),
      filterNewMessages: vi.fn(async () => ({ newMsgIds: [] })),
      getMessageByMsgId: vi.fn(async () => null),
      stats: vi.fn(async () => ({ docs: 0 })),
    };
  }

  it('proves folder membership without invoking the old date-window message APIs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T00:00:00Z'));
    try {
      const ftsSearch = arrangeFingerprintReconcile();
      _testExports._setFtsSearch(ftsSearch);
      _testExports._setLastSyncEventMs(0);

      await _testExports.runPostInitReconcile(ftsSearch);
      const result = await _testExports._runFolderReconSchedulerTick(ftsSearch);

      expect(browser.messages.query).not.toHaveBeenCalled();
      expect(browser.messages.continueList).not.toHaveBeenCalled();
      expect(ftsSearch.queryByDateRange).toBeUndefined();
      expect(browser.tmMsgNotify.getFolderState).toHaveBeenCalledOnce();
      expect(storageData.fts_folder_recon_memo.folders['account1:/INBOX'].verified).toBe(true);
      // The session completed through the orphan tail's quiet predicate.
      expect(result).toMatchObject({ complete: true });
      expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(true);
      expect(storageData.fts_reconcile_watermark).toBeUndefined();
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  it('leaves the session incomplete when the proof throws', async () => {
    const ftsSearch = arrangeFingerprintReconcile({
      fingerprintImpl: async () => {
        throw new Error('native disconnected');
      },
    });
    _testExports._setFtsSearch(ftsSearch);

    await _testExports.runPostInitReconcile(ftsSearch);

    // Feature detection is fail-closed inside the phase, so the current run
    // completes as unsupported; the per-folder checkpoint is not written and
    // the session stays incomplete: no folder is verified and the next tick
    // does not complete.
    expect(storageData.fts_folder_recon_memo).toBeUndefined();
    expect(_testExports._getFolderReconSessionDone()).not.toContain('account1:/INBOX');
    const next = await _testExports._runFolderReconSchedulerTick(ftsSearch);
    expect(next?.complete).not.toBe(true);
    expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
    expect(storageData.fts_reconcile_watermark).toBeUndefined();
  });
});
