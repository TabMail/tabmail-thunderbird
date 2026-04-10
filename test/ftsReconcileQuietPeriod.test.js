// ftsReconcileQuietPeriod.test.js — Tests for _scheduleReconcileWhenQuiet
//
// Verifies that reconcile is deferred until TB's startup sync has quieted down.
// During active sync, messages.query can return inconsistent snapshots, causing
// Phase 2 to mark valid entries as stale. Waiting for a quiet period prevents
// this race.

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
    eventLogger: { enabled: false },
    agentQueues: {
      ftsIncremental: {
        maxConsecutiveNoProgress: 5,
        retryDelayMs: 3000,
      },
    },
  },
}));

vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsBatchOperation: vi.fn(),
  logFtsOperation: vi.fn(),
  logMessageEventBatch: vi.fn(),
  logMoveEvent: vi.fn(),
}));

vi.mock('../agent/modules/utils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    headerIDToWeID: vi.fn(),
    log: vi.fn(),
  };
});

vi.mock('../fts/indexer.js', () => ({
  buildBatchHeader: vi.fn(),
  populateBatchBody: vi.fn(),
}));

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (defaults) => defaults),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  messages: {
    get: vi.fn(),
    query: vi.fn(),
  },
  folders: { query: vi.fn(), getSubFolders: vi.fn() },
  accounts: { list: vi.fn(async () => []), get: vi.fn() },
};

const { _testExports } = await import('../fts/incrementalIndexer.js');
const {
  _scheduleReconcileWhenQuiet,
  _getLastSyncEventMs,
  _setLastSyncEventMs,
  _hasReconcileQuietTimer,
  _clearReconcileQuietTimer,
  RECONCILE_QUIET_PERIOD_MS,
  RECONCILE_QUIET_CHECK_INTERVAL_MS,
  RECONCILE_MAX_WAIT_MS,
} = _testExports;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  _clearReconcileQuietTimer();
});

afterEach(() => {
  _clearReconcileQuietTimer();
  vi.useRealTimers();
});

// Helper: tick time forward and allow interval callbacks to fire
async function advanceTime(ms) {
  await vi.advanceTimersByTimeAsync(ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('_scheduleReconcileWhenQuiet', () => {
  it('runs reconcile after quiet period elapses with no events', async () => {
    const mockRunner = vi.fn(async () => ({ ok: true }));
    const mockFtsSearch = {};

    _scheduleReconcileWhenQuiet(mockFtsSearch, mockRunner);
    expect(_hasReconcileQuietTimer()).toBe(true);
    expect(mockRunner).not.toHaveBeenCalled();

    // Advance to just before quiet period — should not fire yet
    await advanceTime(RECONCILE_QUIET_PERIOD_MS - 1000);
    expect(mockRunner).not.toHaveBeenCalled();

    // Advance past quiet period (and past the check interval) — should fire
    await advanceTime(RECONCILE_QUIET_CHECK_INTERVAL_MS + 1000);
    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(mockRunner).toHaveBeenCalledWith(mockFtsSearch);
    expect(_hasReconcileQuietTimer()).toBe(false);
  });

  it('defers reconcile when a sync event fires during the wait', async () => {
    const mockRunner = vi.fn(async () => ({ ok: true }));

    _scheduleReconcileWhenQuiet({}, mockRunner);

    // Advance most of the quiet period
    await advanceTime(RECONCILE_QUIET_PERIOD_MS - 5000);
    expect(mockRunner).not.toHaveBeenCalled();

    // Simulate a sync event — this should reset the quiet period
    _setLastSyncEventMs(Date.now());

    // Advance by another chunk (shorter than full quiet period from now)
    await advanceTime(RECONCILE_QUIET_PERIOD_MS - 5000);
    expect(mockRunner).not.toHaveBeenCalled();

    // Advance the rest of the quiet period — should fire now
    await advanceTime(RECONCILE_QUIET_CHECK_INTERVAL_MS + 5000);
    expect(mockRunner).toHaveBeenCalledTimes(1);
  });

  it('runs reconcile after max wait even if events keep firing', async () => {
    const mockRunner = vi.fn(async () => ({ ok: true }));

    _scheduleReconcileWhenQuiet({}, mockRunner);

    // Simulate a busy inbox: keep firing sync events just below the quiet period threshold
    const busyInterval = RECONCILE_QUIET_PERIOD_MS - 5000; // fire events every ~55s
    const iterations = Math.ceil(RECONCILE_MAX_WAIT_MS / busyInterval) + 1;

    for (let i = 0; i < iterations; i++) {
      await advanceTime(busyInterval);
      _setLastSyncEventMs(Date.now());
    }

    // By now, max wait should have been exceeded → reconcile should have fired
    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(_hasReconcileQuietTimer()).toBe(false);
  });

  it('clears any existing quiet timer when rescheduled', async () => {
    const mockRunner1 = vi.fn(async () => ({ ok: true }));
    const mockRunner2 = vi.fn(async () => ({ ok: true }));

    _scheduleReconcileWhenQuiet({}, mockRunner1);
    expect(_hasReconcileQuietTimer()).toBe(true);

    // Reschedule — should clear the old timer and start fresh
    _scheduleReconcileWhenQuiet({}, mockRunner2);
    expect(_hasReconcileQuietTimer()).toBe(true);

    // Advance past quiet period
    await advanceTime(RECONCILE_QUIET_PERIOD_MS + RECONCILE_QUIET_CHECK_INTERVAL_MS + 1000);

    // Only the second runner should have been called
    expect(mockRunner1).not.toHaveBeenCalled();
    expect(mockRunner2).toHaveBeenCalledTimes(1);
  });

  it('handles runner errors without crashing', async () => {
    const failingRunner = vi.fn(async () => {
      throw new Error('simulated reconcile failure');
    });

    _scheduleReconcileWhenQuiet({}, failingRunner);

    // Should not throw when timer fires
    await advanceTime(RECONCILE_QUIET_PERIOD_MS + RECONCILE_QUIET_CHECK_INTERVAL_MS + 1000);

    expect(failingRunner).toHaveBeenCalledTimes(1);
    expect(_hasReconcileQuietTimer()).toBe(false);
  });

  it('initializes _lastSyncEventMs to scheduling time', () => {
    const before = Date.now();
    _scheduleReconcileWhenQuiet({}, vi.fn());
    const after = Date.now();

    const lastSync = _getLastSyncEventMs();
    expect(lastSync).toBeGreaterThanOrEqual(before);
    expect(lastSync).toBeLessThanOrEqual(after);
  });

  it('does NOT fire reconcile before the first check interval', async () => {
    const mockRunner = vi.fn(async () => ({ ok: true }));

    _scheduleReconcileWhenQuiet({}, mockRunner);

    // Advance by less than the check interval
    await advanceTime(RECONCILE_QUIET_CHECK_INTERVAL_MS - 100);
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('configuration sanity: quiet period < max wait, check interval < quiet period', () => {
    expect(RECONCILE_QUIET_CHECK_INTERVAL_MS).toBeLessThan(RECONCILE_QUIET_PERIOD_MS);
    expect(RECONCILE_QUIET_PERIOD_MS).toBeLessThan(RECONCILE_MAX_WAIT_MS);
  });
});
