/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ftsReconcile.test.js — Tests for FTS boot-time reconciliation stale-entry cleanup
//
// Tests _reconcileCleanupStaleEntries (Phase 2 of runPostInitReconcile):
// After indexing current messages, the reconciler queries FTS entries in the
// reconcile window and removes any whose messages no longer exist in TB.

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
  _reconcileCleanupStaleEntries,
  isReconcilePending,
  getLastSyncEventMs,
  _testExports,
} = await import('../fts/incrementalIndexer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFtsSearch({
  queryByDateRangeResults = [],
  removeBatchResult = { count: 0 },
} = {}) {
  // Support multiple calls returning different results.
  // Account liveness is now checked lazily per entry (no pre-check query),
  // so only the main cursor loop consumes queryByDateRange responses.
  const queryFn = vi.fn();
  if (Array.isArray(queryByDateRangeResults[0])) {
    // Array of arrays — each call returns the next array
    for (const result of queryByDateRangeResults) {
      queryFn.mockResolvedValueOnce(result);
    }
  } else {
    // Single array — main loop, then empty
    queryFn.mockResolvedValueOnce(queryByDateRangeResults); // main loop
    queryFn.mockResolvedValueOnce([]);                       // end of cursor
  }

  return {
    queryByDateRange: queryFn,
    removeBatch: vi.fn(async () => removeBatchResult),
    stats: vi.fn(async () => ({ totalDocs: 0 })),
  };
}

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

describe('_reconcileCleanupStaleEntries', () => {
  it('returns zeros when FTS has no entries in the window', async () => {
    const ftsSearch = makeFtsSearch({ queryByDateRangeResults: [] });

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result).toEqual({ checked: 0, removed: 0, accountsSkipped: 0, removeFailed: false });
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
  });

  it('keeps entries that still exist in TB at their indexed folder', async () => {
    const entry = {
      msgId: 'account1:/INBOX:msg-header-id-1@example.com',
      subject: 'Test message',
      dateMs: Date.now() - 3600000,
    };

    const ftsSearch = makeFtsSearch({ queryByDateRangeResults: [entry] });

    // Message still exists at its folder
    mockHeaderIDToWeID.mockResolvedValue(42);

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();

    // Verify headerIDToWeID was called with correct args (no global fallback)
    expect(mockHeaderIDToWeID).toHaveBeenCalledWith(
      'msg-header-id-1@example.com',
      { accountId: 'account1', path: '/INBOX' },
      false,
      false,
    );
  });

  it('removes entries for messages no longer at their indexed folder', async () => {
    const staleEntry = {
      msgId: 'account1:/INBOX:moved-msg@example.com',
      subject: 'Moved to archive',
      dateMs: Date.now() - 3600000,
    };

    const ftsSearch = makeFtsSearch({
      queryByDateRangeResults: [staleEntry],
      removeBatchResult: { count: 1 },
    });

    // Message no longer exists at INBOX (was moved)
    mockHeaderIDToWeID.mockResolvedValue(null);

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(1);
    expect(ftsSearch.removeBatch).toHaveBeenCalledWith(['account1:/INBOX:moved-msg@example.com']);
  });

  it('handles mix of stale and current entries', async () => {
    const entries = [
      {
        msgId: 'account1:/INBOX:still-here@example.com',
        subject: 'Still in inbox',
        dateMs: Date.now() - 3600000,
      },
      {
        msgId: 'account1:/INBOX:moved-away@example.com',
        subject: 'Moved to archive',
        dateMs: Date.now() - 7200000,
      },
      {
        msgId: 'account1:/Deleted Messages:permanently-deleted@example.com',
        subject: 'Expunged',
        dateMs: Date.now() - 10800000,
      },
    ];

    const ftsSearch = makeFtsSearch({
      queryByDateRangeResults: entries,
      removeBatchResult: { count: 2 },
    });

    // First message exists, second and third don't
    mockHeaderIDToWeID
      .mockResolvedValueOnce(10) // still-here: exists
      .mockResolvedValueOnce(null) // moved-away: gone
      .mockResolvedValueOnce(null); // permanently-deleted: gone

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(3);
    expect(result.removed).toBe(2);
    expect(ftsSearch.removeBatch).toHaveBeenCalledWith([
      'account1:/INBOX:moved-away@example.com',
      'account1:/Deleted Messages:permanently-deleted@example.com',
    ]);
  });

  it('skips entries with unparseable msgId format', async () => {
    const entries = [
      {
        msgId: 'bad-format-no-colons',
        subject: 'Broken',
        dateMs: Date.now() - 3600000,
      },
      {
        msgId: 'account1:/INBOX:valid-msg@example.com',
        subject: 'Valid',
        dateMs: Date.now() - 3600000,
      },
    ];

    const ftsSearch = makeFtsSearch({ queryByDateRangeResults: entries });

    // Only the valid one gets checked
    mockHeaderIDToWeID.mockResolvedValue(42);

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(2); // both counted as checked
    expect(result.removed).toBe(0);
    expect(mockHeaderIDToWeID).toHaveBeenCalledTimes(1); // only valid one
  });

  it('does not remove entries when headerIDToWeID throws', async () => {
    const entry = {
      msgId: 'account1:/INBOX:error-msg@example.com',
      subject: 'Error checking',
      dateMs: Date.now() - 3600000,
    };

    const ftsSearch = makeFtsSearch({ queryByDateRangeResults: [entry] });

    // Error during existence check — should NOT remove (conservative)
    mockHeaderIDToWeID.mockRejectedValue(new Error('IMAP disconnected'));

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
  });

  it('handles pagination when FTS returns full chunks', async () => {
    // Simulate two chunks: first chunk is full (200 entries), second is partial
    const chunk1 = Array.from({ length: 200 }, (_, i) => ({
      msgId: `account1:/INBOX:msg-${i}@example.com`,
      subject: `Msg ${i}`,
      dateMs: Date.now() - (i + 1) * 60000, // 1 min apart, newest first
    }));
    const chunk2 = [
      {
        msgId: 'account1:/INBOX:msg-200@example.com',
        subject: 'Msg 200',
        dateMs: Date.now() - 201 * 60000,
      },
    ];

    const ftsSearch = makeFtsSearch({
      queryByDateRangeResults: [chunk1, chunk2],
    });

    // All messages still exist
    mockHeaderIDToWeID.mockResolvedValue(1);

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(201);
    expect(result.removed).toBe(0);
    // queryByDateRange: 2 pagination calls (no pre-check — liveness is lazy)
    expect(ftsSearch.queryByDateRange).toHaveBeenCalledTimes(2);
  });

  it('logs reconcile_stale events for each stale entry found', async () => {
    const staleEntry = {
      msgId: 'account1:/INBOX:stale@example.com',
      subject: 'Stale message',
      dateMs: Date.now() - 3600000,
    };

    const ftsSearch = makeFtsSearch({
      queryByDateRangeResults: [staleEntry],
      removeBatchResult: { count: 1 },
    });

    mockHeaderIDToWeID.mockResolvedValue(null);

    await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(logFtsOperation).toHaveBeenCalledWith(
      'reconcile_stale',
      'found',
      expect.objectContaining({
        msgId: 'account1:/INBOX:stale@example.com',
        folderPath: '/INBOX',
        headerID: 'stale@example.com',
      }),
    );
  });

  it('logs reconcile_phase2 start and complete events', async () => {
    const ftsSearch = makeFtsSearch({ queryByDateRangeResults: [] });

    await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(logFtsBatchOperation).toHaveBeenCalledWith(
      'reconcile_phase2',
      'start',
      expect.objectContaining({
        startDate: expect.any(String),
        endDate: expect.any(String),
      }),
    );

    expect(logFtsBatchOperation).toHaveBeenCalledWith(
      'reconcile_phase2',
      'complete',
      expect.objectContaining({
        checked: 0,
        staleFound: 0,
        removed: 0,
      }),
    );
  });

  it('verify-then-remove: keeps candidate when recheck finds the message still present', async () => {
    const falseStaleEntry = {
      msgId: 'account1:/[Gmail]/Bin:still-in-bin@example.com',
      subject: 'Live message, transient query miss',
      dateMs: Date.now() - 3600000,
    };

    const ftsSearch = makeFtsSearch({ queryByDateRangeResults: [falseStaleEntry] });

    // First-pass folder-constrained lookup misses (transient msgDB state)...
    mockHeaderIDToWeID.mockResolvedValue(null);
    // ...but the global recheck finds it still in its indexed folder.
    mockRecheckMessageInFolder.mockResolvedValue('present');

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();

    // Recheck called with the parsed headerID + weFolder
    expect(mockRecheckMessageInFolder).toHaveBeenCalledWith(
      'still-in-bin@example.com',
      { accountId: 'account1', path: '/[Gmail]/Bin' },
    );

    expect(logFtsOperation).toHaveBeenCalledWith(
      'reconcile_stale',
      'recheck_present',
      expect.objectContaining({ msgId: 'account1:/[Gmail]/Bin:still-in-bin@example.com' }),
    );
  });

  it('verify-then-remove: keeps candidate when recheck errors (unconfirmed)', async () => {
    const entry = {
      msgId: 'account1:/INBOX:recheck-error@example.com',
      subject: 'Recheck errored',
      dateMs: Date.now() - 3600000,
    };

    const ftsSearch = makeFtsSearch({ queryByDateRangeResults: [entry] });

    mockHeaderIDToWeID.mockResolvedValue(null);
    mockRecheckMessageInFolder.mockResolvedValue('error');

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.removed).toBe(0);
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();

    expect(logFtsOperation).toHaveBeenCalledWith(
      'reconcile_stale',
      'recheck_error',
      expect.objectContaining({ msgId: 'account1:/INBOX:recheck-error@example.com' }),
    );
  });

  it('verify-then-remove: removes only recheck-confirmed candidates in a mixed batch', async () => {
    const entries = [
      {
        msgId: 'account1:/[Gmail]/Bin:false-positive@example.com',
        subject: 'Transient miss',
        dateMs: Date.now() - 3600000,
      },
      {
        msgId: 'account1:/[Gmail]/Bin:really-gone@example.com',
        subject: 'Expunged for real',
        dateMs: Date.now() - 7200000,
      },
    ];

    const ftsSearch = makeFtsSearch({
      queryByDateRangeResults: entries,
      removeBatchResult: { count: 1 },
    });

    // Both miss on the first-pass folder-constrained lookup
    mockHeaderIDToWeID.mockResolvedValue(null);
    // Recheck: first is still present, second confirmed absent
    mockRecheckMessageInFolder
      .mockResolvedValueOnce('present')
      .mockResolvedValueOnce('absent');

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(2);
    expect(result.removed).toBe(1);
    expect(ftsSearch.removeBatch).toHaveBeenCalledWith([
      'account1:/[Gmail]/Bin:really-gone@example.com',
    ]);
  });

  it('handles removeBatch failure gracefully', async () => {
    const staleEntry = {
      msgId: 'account1:/INBOX:stale@example.com',
      subject: 'Stale',
      dateMs: Date.now() - 3600000,
    };

    const ftsSearch = makeFtsSearch({ queryByDateRangeResults: [staleEntry] });
    ftsSearch.removeBatch = vi.fn().mockRejectedValue(new Error('native disconnected'));

    mockHeaderIDToWeID.mockResolvedValue(null);

    // Should not throw
    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0); // removeBatch failed, so removed stays 0
    // Confirmed-stale entries are still in FTS — caller must NOT advance the watermark
    expect(result.removeFailed).toBe(true);
  });

  it('handles queryByDateRange failure gracefully', async () => {
    const ftsSearch = {
      queryByDateRange: vi.fn().mockRejectedValue(new Error('native crash')),
      removeBatch: vi.fn(),
      stats: vi.fn(),
    };

    // Should not throw
    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(0);
    expect(result.removed).toBe(0);
    // A Phase 2 exception means the window was NOT verified — the caller
    // must not advance the watermark (same contract as a removeBatch throw)
    expect(result.removeFailed).toBe(true);

    // Should log error
    expect(logFtsBatchOperation).toHaveBeenCalledWith(
      'reconcile_phase2',
      'error',
      expect.objectContaining({ error: expect.stringContaining('native crash') }),
    );
  });

  it('checks account liveness lazily per entry and skips unavailable accounts', async () => {
    const entries = [
      {
        msgId: 'account1:/INBOX:gone-from-live-account@example.com',
        subject: 'Live account',
        dateMs: Date.now() - 3600000,
      },
      {
        msgId: 'account9:/INBOX:msg-in-dead-account@example.com',
        subject: 'Unavailable account',
        dateMs: Date.now() - 7200000,
      },
    ];

    const ftsSearch = makeFtsSearch({
      queryByDateRangeResults: entries,
      removeBatchResult: { count: 1 },
    });

    mockHeaderIDToWeID.mockResolvedValue(null);
    // default recheck mock: 'absent'

    // account9 is not queryable
    browser.accounts.get.mockImplementation(async (id) => (id === 'account9' ? null : { id }));
    try {
      const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

      expect(result.checked).toBe(2);
      expect(result.accountsSkipped).toBe(1);
      // Only the live account's entry was nominated and removed
      expect(ftsSearch.removeBatch).toHaveBeenCalledWith([
        'account1:/INBOX:gone-from-live-account@example.com',
      ]);
      // The dead account's entry never reached existence checking
      expect(mockHeaderIDToWeID).toHaveBeenCalledTimes(1);
    } finally {
      browser.accounts.get.mockImplementation(async (id) => ({ id }));
    }
  });

  it('does not skip same-millisecond entries at a full-chunk boundary (inclusive cursor + dedup)', async () => {
    // Date headers have second granularity, so dateMs ties are routine.
    // 205 entries where 6 share one dateMs spanning the 200-entry chunk
    // boundary — an exclusive `oldestMs - 1` cursor would skip the tied
    // entries beyond the boundary forever.
    const base = Date.now() - 1000;
    const TIE_MS = base - 197 * 1000;
    const allEntries = Array.from({ length: 205 }, (_, i) => ({
      msgId: `account1:/INBOX:tie-${i}@example.com`,
      subject: `Msg ${i}`,
      dateMs: (i >= 197 && i <= 202) ? TIE_MS : base - i * 1000,
    }));

    // Real cursor semantics: filter by the passed end date, DESC, limited
    const ftsSearch = {
      queryByDateRange: vi.fn(async (start, end, limit) =>
        allEntries
          .filter((e) => e.dateMs >= start.getTime() && e.dateMs <= end.getTime())
          .sort((a, b) => b.dateMs - a.dateMs)
          .slice(0, limit),
      ),
      removeBatch: vi.fn(async () => ({ count: 0 })),
      stats: vi.fn(async () => ({ totalDocs: 0 })),
    };

    // Everything still exists — we only care about coverage
    mockHeaderIDToWeID.mockResolvedValue(42);

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.checked).toBe(205); // every entry verified, none tie-skipped
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
  });

  it('recheck loop pings the native FTS keepalive every 50 candidates', async () => {
    // 51 stale candidates → exactly one ping (at recheckedCount === 50).
    const entries = Array.from({ length: 51 }, (_, i) => ({
      msgId: `account1:/[Gmail]/Bin:gone-${i}@example.com`,
      subject: `Gone ${i}`,
      dateMs: Date.now() - (i + 1) * 60000,
    }));

    const ftsSearch = makeFtsSearch({
      queryByDateRangeResults: entries,
      removeBatchResult: { count: 51 },
    });

    mockHeaderIDToWeID.mockResolvedValue(null);
    // default recheck mock: 'absent' → all confirmed

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result.removed).toBe(51);
    expect(ftsSearch.stats).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Real implementations of the startup-tick readiness signals
// (maintenanceStartupTick.test.js mocks these — this covers the real code)
// ---------------------------------------------------------------------------

describe('isReconcilePending / getLastSyncEventMs (real implementations)', () => {
  afterEach(() => {
    _testExports._setIsEnabled(false);
  });

  it('returns true when enabled and the pending flag is set', async () => {
    _testExports._setIsEnabled(true);
    _testExports._setLastSyncEventMs(0);
    storageData['fts_reconcile_pending'] = Date.now();
    expect(await isReconcilePending()).toBe(true);
  });

  it('returns false when enabled and no flag is set', async () => {
    _testExports._setIsEnabled(true);
    expect(await isReconcilePending()).toBe(false);
  });

  it('returns false when incremental indexing is disabled, even with a stale flag', async () => {
    // A stale flag from an interrupted earlier session must not stall the
    // startup tick to its max-wait cap when reconcile will never run.
    _testExports._setIsEnabled(false);
    storageData['fts_reconcile_pending'] = Date.now();
    expect(await isReconcilePending()).toBe(false);
  });

  it('fails closed when the storage read throws', async () => {
    _testExports._setIsEnabled(true);
    storageData['fts_reconcile_pending'] = Date.now();
    browser.storage.local.get.mockImplementationOnce(async () => {
      throw new Error('storage gone');
    });
    await expect(isReconcilePending()).rejects.toThrow('storage gone');
  });

  it('getLastSyncEventMs reflects the tracked sync-event timestamp', () => {
    const before = getLastSyncEventMs();
    expect(typeof before).toBe('number');
    const marker = Date.now() - 12345;
    _testExports._setLastSyncEventMs(marker);
    expect(getLastSyncEventMs()).toBe(marker);
    _testExports._setLastSyncEventMs(before);
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
    storageData.fts_initial_scan_complete = true;
    storageData.fts_reconcile_pending = Date.now();
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
      await _testExports._runFolderReconSchedulerTick(ftsSearch);

      expect(browser.messages.query).not.toHaveBeenCalled();
      expect(browser.messages.continueList).not.toHaveBeenCalled();
      expect(ftsSearch.queryByDateRange).toBeUndefined();
      expect(browser.tmMsgNotify.getFolderState).toHaveBeenCalledOnce();
      expect(storageData.fts_folder_recon_memo.folders['account1:/INBOX'].verified).toBe(true);
      expect(storageData.fts_reconcile_pending).toBeUndefined();
      expect(storageData.fts_reconcile_watermark).toBeUndefined();
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  it('leaves the pending marker when the proof throws', async () => {
    const ftsSearch = arrangeFingerprintReconcile({
      fingerprintImpl: async () => {
        throw new Error('native disconnected');
      },
    });
    _testExports._setFtsSearch(ftsSearch);

    await _testExports.runPostInitReconcile(ftsSearch);

    // Feature detection is fail-closed inside the phase, so the current run
    // completes as unsupported; the per-folder checkpoint is not written and
    // the startup-pending marker remains for the next helper/app restart.
    expect(storageData.fts_folder_recon_memo).toBeUndefined();
    expect(storageData.fts_reconcile_pending).toBeTruthy();
    expect(storageData.fts_reconcile_watermark).toBeUndefined();
  });
});
