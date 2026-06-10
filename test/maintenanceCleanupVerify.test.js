/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// maintenanceCleanupVerify.test.js — Tests for the verify-then-remove pass
// (Phase 2.5) in fts/maintenanceScheduler.js cleanupMissingEntries.
//
// Background (2026-06-10 diagnosis): the weekly maintenance scan removed a
// live [Gmail]/Bin message as "missing" (folder-constrained messages.query
// transiently empty during sync) and only re-indexed it a week later. Every
// stale candidate must now be confirmed by a fresh, SUCCESSFUL global query
// before removal.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (same pattern as ftsReconcile.test.js)
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    // Explicit 0 delays so tests run fast — production reads these with ??
    // (not ||) so 0 is honored. validationBatchSize is small so the Phase
    // 2/2.5 keepalive cadence is reachable with tiny fixtures.
    ftsCleanup: {
      queryChunkSize: 5, // small so cursor-pagination edge cases are reachable
      validationBatchSize: 2,
      removeBatchSize: 2, // small so partial Phase-3 failures are reachable
      batchDelayMs: 0,
      entryDelayMs: 0,
    },
    ftsMaintenanceLog: { maxCorrectionEntriesPerRun: 50 },
    eventLogger: { enabled: false },
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
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

const mockHeaderIDToWeID = vi.fn();
const mockRecheckMessageInFolder = vi.fn();
vi.mock('../agent/modules/utils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    headerIDToWeID: (...args) => mockHeaderIDToWeID(...args),
    recheckMessageInFolder: (...args) => mockRecheckMessageInFolder(...args),
    log: vi.fn(),
  };
});

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrDefault) => {
        if (typeof keyOrDefault === 'string') return { [keyOrDefault]: null };
        const result = {};
        for (const [k, def] of Object.entries(keyOrDefault)) result[k] = def;
        return result;
      }),
      set: vi.fn(async () => {}),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  messages: { get: vi.fn(), query: vi.fn() },
  folders: {
    query: vi.fn(async () => [{ id: 1, path: '/INBOX' }]), // accounts queryable
    getSubFolders: vi.fn(),
  },
  accounts: {
    list: vi.fn(async () => []),
    get: vi.fn(async (id) => ({ id })),
  },
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    getAll: vi.fn(async () => []),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const { logFtsOperation } = await import('../agent/modules/eventLogger.js');
const { _testExports } = await import('../fts/maintenanceScheduler.js');
const { cleanupMissingEntries } = _testExports;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFtsSearch(entries) {
  return {
    // Single chunk smaller than the chunk size ends the cursor loop
    queryByDateRange: vi.fn(async () => entries),
    // Honest count: removal happens in chunks of removeBatchSize, so a fixed
    // per-call count would double-count across chunks
    removeBatch: vi.fn(async (ids) => ({ count: ids.length })),
    stats: vi.fn(async () => ({ totalDocs: 0 })),
  };
}

function dateRange() {
  // Dynamic dates per testing rules — 21 days back to now
  const end = new Date();
  const start = new Date(end.getTime() - 21 * 24 * 60 * 60 * 1000);
  return { start, end };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHeaderIDToWeID.mockReset();
  mockRecheckMessageInFolder.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleanupMissingEntries verify-then-remove (Phase 2.5)', () => {
  it('does not recheck or remove entries that pass the first existence check', async () => {
    const { start, end } = dateRange();
    const ftsSearch = makeFtsSearch([
      { msgId: 'account1:/INBOX:still-here@example.com', subject: 'Here', dateMs: end.getTime() - 3600000 },
    ]);

    mockHeaderIDToWeID.mockResolvedValue(42);

    const result = await cleanupMissingEntries(ftsSearch, start, end);

    expect(result.processed).toBe(1);
    expect(result.removed).toBe(0);
    expect(mockRecheckMessageInFolder).not.toHaveBeenCalled();
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
  });

  it('removes a stale candidate only after the recheck confirms absence', async () => {
    const { start, end } = dateRange();
    const ftsSearch = makeFtsSearch(
      [{ msgId: 'account1:/[Gmail]/Bin:really-gone@example.com', subject: 'Expunged', dateMs: end.getTime() - 3600000 }],
    );

    mockHeaderIDToWeID.mockResolvedValue(null);
    mockRecheckMessageInFolder.mockResolvedValue('absent');

    const result = await cleanupMissingEntries(ftsSearch, start, end);

    expect(result.removed).toBe(1);
    expect(ftsSearch.removeBatch).toHaveBeenCalledWith(['account1:/[Gmail]/Bin:really-gone@example.com']);
    expect(mockRecheckMessageInFolder).toHaveBeenCalledWith(
      'really-gone@example.com',
      { accountId: 'account1', path: '/[Gmail]/Bin' },
    );
    expect(result.removedDetails).toEqual([
      expect.objectContaining({
        action: 'removedMissing',
        msgId: 'account1:/[Gmail]/Bin:really-gone@example.com',
        folderPath: '/[Gmail]/Bin',
      }),
    ]);
  });

  it('keeps a candidate when the recheck finds the message still present (transient miss)', async () => {
    const { start, end } = dateRange();
    const ftsSearch = makeFtsSearch([
      { msgId: 'account1:/[Gmail]/Bin:still-in-bin@example.com', subject: 'Live', dateMs: end.getTime() - 3600000 },
    ]);

    mockHeaderIDToWeID.mockResolvedValue(null);
    mockRecheckMessageInFolder.mockResolvedValue('present');

    const result = await cleanupMissingEntries(ftsSearch, start, end);

    expect(result.removed).toBe(0);
    expect(result.removedDetails).toEqual([]);
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
    expect(logFtsOperation).toHaveBeenCalledWith(
      'maintenance_stale',
      'recheck_present',
      expect.objectContaining({ msgId: 'account1:/[Gmail]/Bin:still-in-bin@example.com' }),
    );
  });

  it('keeps a candidate when the recheck errors (unconfirmed)', async () => {
    const { start, end } = dateRange();
    const ftsSearch = makeFtsSearch([
      { msgId: 'account1:/INBOX:unknown@example.com', subject: 'Unknown', dateMs: end.getTime() - 3600000 },
    ]);

    mockHeaderIDToWeID.mockResolvedValue(null);
    mockRecheckMessageInFolder.mockResolvedValue('error');

    const result = await cleanupMissingEntries(ftsSearch, start, end);

    expect(result.removed).toBe(0);
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
    expect(logFtsOperation).toHaveBeenCalledWith(
      'maintenance_stale',
      'recheck_error',
      expect.objectContaining({ msgId: 'account1:/INBOX:unknown@example.com' }),
    );
  });

  it('mixed batch: removes confirmed-absent, keeps present and errored candidates', async () => {
    const { start, end } = dateRange();
    const ftsSearch = makeFtsSearch(
      [
        { msgId: 'account1:/[Gmail]/Bin:false-positive@example.com', subject: 'A', dateMs: end.getTime() - 1000 },
        { msgId: 'account1:/[Gmail]/Bin:really-gone@example.com', subject: 'B', dateMs: end.getTime() - 2000 },
        { msgId: 'account1:/INBOX:errored@example.com', subject: 'C', dateMs: end.getTime() - 3000 },
      ],
    );

    mockHeaderIDToWeID.mockResolvedValue(null);
    mockRecheckMessageInFolder
      .mockResolvedValueOnce('present')
      .mockResolvedValueOnce('absent')
      .mockResolvedValueOnce('error');

    const result = await cleanupMissingEntries(ftsSearch, start, end);

    expect(result.removed).toBe(1);
    expect(ftsSearch.removeBatch).toHaveBeenCalledWith(['account1:/[Gmail]/Bin:really-gone@example.com']);
    expect(result.removedDetails).toHaveLength(1);
    expect(result.removedDetails[0].msgId).toBe('account1:/[Gmail]/Bin:really-gone@example.com');
  });

  it('Phase 2.5 pings the native FTS keepalive on the validation-batch cadence', async () => {
    const { start, end } = dateRange();
    // 3 stale candidates with validationBatchSize=2 (mock config):
    //   Phase 2 pings stats() after each validation batch → 2 calls
    //   Phase 2.5 pings at recheckedCount=2 (2 % 2 === 0)   → 1 call
    const ftsSearch = makeFtsSearch(
      [
        { msgId: 'account1:/[Gmail]/Bin:gone-1@example.com', subject: 'A', dateMs: end.getTime() - 1000 },
        { msgId: 'account1:/[Gmail]/Bin:gone-2@example.com', subject: 'B', dateMs: end.getTime() - 2000 },
        { msgId: 'account1:/[Gmail]/Bin:gone-3@example.com', subject: 'C', dateMs: end.getTime() - 3000 },
      ],
    );

    mockHeaderIDToWeID.mockResolvedValue(null);
    mockRecheckMessageInFolder.mockResolvedValue('absent');

    const result = await cleanupMissingEntries(ftsSearch, start, end);

    expect(result.removed).toBe(3);
    expect(ftsSearch.stats).toHaveBeenCalledTimes(3);
  });

  it('honors explicit 0ms delays (?? not ||) — no sleep timers scheduled', async () => {
    const { start, end } = dateRange();
    const ftsSearch = makeFtsSearch([
      { msgId: 'account1:/[Gmail]/Bin:gone-1@example.com', subject: 'A', dateMs: end.getTime() - 1000 },
      { msgId: 'account1:/[Gmail]/Bin:gone-2@example.com', subject: 'B', dateMs: end.getTime() - 2000 },
    ]);

    mockHeaderIDToWeID.mockResolvedValue(null);
    mockRecheckMessageInFolder.mockResolvedValue('absent');

    // With the mocked config's batchDelayMs/entryDelayMs of 0 honored, the
    // cleanup never schedules its 50ms/100ms sleeps. A `||` regression would
    // silently fall back to the production defaults — caught here.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await cleanupMissingEntries(ftsSearch, start, end);
      const sleepCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 50 || ms === 100);
      expect(sleepCalls).toEqual([]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('does not skip same-millisecond entries at a full-chunk boundary (inclusive cursor + dedup)', async () => {
    const { start, end } = dateRange();
    // 8 entries, 4 sharing one dateMs spanning the 5-entry chunk boundary —
    // an exclusive `oldestMs - 1` cursor would skip the tied entries beyond
    // the boundary forever.
    const base = end.getTime() - 1000;
    const TIE_MS = base - 3 * 1000;
    const allEntries = Array.from({ length: 8 }, (_, i) => ({
      msgId: `account1:/INBOX:tie-${i}@example.com`,
      subject: `Msg ${i}`,
      dateMs: (i >= 3 && i <= 6) ? TIE_MS : base - i * 1000,
    }));

    // Real cursor semantics: filter by the passed end date, DESC, limited
    const ftsSearch = {
      queryByDateRange: vi.fn(async (s, e, limit) =>
        allEntries
          .filter((entry) => entry.dateMs >= s.getTime() && entry.dateMs <= e.getTime())
          .sort((a, b) => b.dateMs - a.dateMs)
          .slice(0, limit),
      ),
      removeBatch: vi.fn(async () => ({ count: 0 })),
      stats: vi.fn(async () => ({ totalDocs: 0 })),
    };

    mockHeaderIDToWeID.mockResolvedValue(42); // everything still exists

    const result = await cleanupMissingEntries(ftsSearch, start, end);

    expect(result.processed).toBe(8); // every entry validated, none tie-skipped
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
  });

  it('prunes removedDetails for a Phase-3 remove chunk that fails (history reports only real removals)', async () => {
    const { start, end } = dateRange();
    // 4 confirmed-stale entries, removeBatchSize=2 → two remove chunks;
    // first chunk succeeds, second throws.
    const ftsSearch = makeFtsSearch(
      [
        { msgId: 'account1:/[Gmail]/Bin:gone-1@example.com', subject: 'A', dateMs: end.getTime() - 1000 },
        { msgId: 'account1:/[Gmail]/Bin:gone-2@example.com', subject: 'B', dateMs: end.getTime() - 2000 },
        { msgId: 'account1:/[Gmail]/Bin:gone-3@example.com', subject: 'C', dateMs: end.getTime() - 3000 },
        { msgId: 'account1:/[Gmail]/Bin:gone-4@example.com', subject: 'D', dateMs: end.getTime() - 4000 },
      ],
    );
    ftsSearch.removeBatch = vi.fn()
      .mockResolvedValueOnce({ count: 2 })
      .mockRejectedValueOnce(new Error('native disconnected'));

    mockHeaderIDToWeID.mockResolvedValue(null);
    mockRecheckMessageInFolder.mockResolvedValue('absent');

    const result = await cleanupMissingEntries(ftsSearch, start, end);

    expect(result.removed).toBe(2);
    // Only the successfully-removed chunk appears in the history details
    expect(result.removedDetails.map((d) => d.msgId)).toEqual([
      'account1:/[Gmail]/Bin:gone-1@example.com',
      'account1:/[Gmail]/Bin:gone-2@example.com',
    ]);
  });

  it('Phase 2.5 keepalive failure is non-fatal — rechecks and removal proceed', async () => {
    const { start, end } = dateRange();
    const ftsSearch = makeFtsSearch(
      [
        { msgId: 'account1:/[Gmail]/Bin:gone-1@example.com', subject: 'A', dateMs: end.getTime() - 1000 },
        { msgId: 'account1:/[Gmail]/Bin:gone-2@example.com', subject: 'B', dateMs: end.getTime() - 2000 },
        { msgId: 'account1:/[Gmail]/Bin:gone-3@example.com', subject: 'C', dateMs: end.getTime() - 3000 },
      ],
    );
    ftsSearch.stats = vi.fn(async () => { throw new Error('native gone'); });

    mockHeaderIDToWeID.mockResolvedValue(null);
    mockRecheckMessageInFolder.mockResolvedValue('absent');

    const result = await cleanupMissingEntries(ftsSearch, start, end);

    expect(result.removed).toBe(3);
    // 3 entries with removeBatchSize=2 (mock config) → two remove chunks
    expect(ftsSearch.removeBatch).toHaveBeenCalledTimes(2);
  });
});
