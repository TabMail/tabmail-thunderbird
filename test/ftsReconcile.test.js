// ftsReconcile.test.js — Tests for FTS boot-time reconciliation stale-entry cleanup
//
// Tests _reconcileCleanupStaleEntries (Phase 2 of runPostInitReconcile):
// After indexing current messages, the reconciler queries FTS entries in the
// reconcile window and removes any whose messages no longer exist in TB.

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Mock headerIDToWeID at module level — tests override per-case
const mockHeaderIDToWeID = vi.fn();
vi.mock('../agent/modules/utils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    headerIDToWeID: (...args) => mockHeaderIDToWeID(...args),
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
const { _reconcileCleanupStaleEntries } = await import('../fts/incrementalIndexer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFtsSearch({
  queryByDateRangeResults = [],
  removeBatchResult = { count: 0 },
} = {}) {
  // Support multiple calls returning different results.
  // Note: _reconcileCleanupStaleEntries calls queryByDateRange once for
  // the account liveness pre-check, then again for the main cursor loop.
  const queryFn = vi.fn();
  if (Array.isArray(queryByDateRangeResults[0])) {
    // Array of arrays — each call returns the next array
    // Add pre-check call: return first array for pre-check too
    queryFn.mockResolvedValueOnce(queryByDateRangeResults[0]);
    for (const result of queryByDateRangeResults) {
      queryFn.mockResolvedValueOnce(result);
    }
  } else {
    // Single array — return for pre-check, then main loop, then empty
    queryFn.mockResolvedValueOnce(queryByDateRangeResults); // pre-check
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
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
});

describe('_reconcileCleanupStaleEntries', () => {
  it('returns zeros when FTS has no entries in the window', async () => {
    const ftsSearch = makeFtsSearch({ queryByDateRangeResults: [] });

    const result = await _reconcileCleanupStaleEntries(ftsSearch, Date.now() - 86400000);

    expect(result).toEqual({ checked: 0, removed: 0 });
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
    // queryByDateRange: 1 pre-check + 2 pagination = 3 calls
    expect(ftsSearch.queryByDateRange).toHaveBeenCalledTimes(3);
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

    // Should log error
    expect(logFtsBatchOperation).toHaveBeenCalledWith(
      'reconcile_phase2',
      'error',
      expect.objectContaining({ error: expect.stringContaining('native crash') }),
    );
  });
});
