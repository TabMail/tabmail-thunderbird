/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// maintenanceStartupTick.test.js — Tests for the deferred startup maintenance
// tick in fts/maintenanceScheduler.js (_scheduleStartupTickWhenQuiet).
//
// Background (2026-06-10 diagnosis): a due weekly scan firing immediately at
// TB launch races the startup folder sync — messages.query can return
// inconsistent snapshots and cleanupMissingEntries marks valid entries stale.
// The startup tick must wait for the sync quiet period AND boot reconcile
// completion, with a hard cap so it eventually runs regardless.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockGetLastSyncEventMs, mockIsReconcilePending } = vi.hoisted(() => ({
  mockGetLastSyncEventMs: vi.fn(),
  mockIsReconcilePending: vi.fn(),
}));

vi.mock('../fts/incrementalIndexer.js', () => ({
  getLastSyncEventMs: mockGetLastSyncEventMs,
  isReconcilePending: mockIsReconcilePending,
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {},
}));
vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsOperation: vi.fn(),
  logFtsBatchOperation: vi.fn(),
  logMessageEventBatch: vi.fn(),
  logMoveEvent: vi.fn(),
}));
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  headerIDToWeID: vi.fn(),
  parseUniqueId: vi.fn(),
  recheckMessageInFolder: vi.fn(),
}));

globalThis.browser = {
  storage: {
    local: {
      // Return passed-in defaults (object form) so getMaintenanceSettings sees
      // its own defaults; string-key form returns empty.
      get: vi.fn(async (keyOrDefault) => {
        if (typeof keyOrDefault === 'string') return { [keyOrDefault]: null };
        return { ...keyOrDefault };
      }),
      set: vi.fn(async () => {}),
    },
  },
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    getAll: vi.fn(async () => []),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const scheduler = await import('../fts/maintenanceScheduler.js');
const { _testExports } = scheduler;
const {
  _scheduleStartupTickWhenQuiet,
  _hasStartupTickTimer,
  _clearStartupTickTimer,
  _setInitializedForTest,
  _setFtsSearchForTest,
  STARTUP_TICK_QUIET_PERIOD_MS,
  STARTUP_TICK_CHECK_INTERVAL_MS,
  STARTUP_TICK_MAX_WAIT_MS,
} = _testExports;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let runner;

beforeEach(() => {
  vi.useFakeTimers();
  mockGetLastSyncEventMs.mockReset();
  mockIsReconcilePending.mockReset();
  runner = vi.fn(async () => ({ ok: true, ran: false }));
  // Simulate an initialized scheduler so the timer callback doesn't bail
  _setInitializedForTest(true);
  _setFtsSearchForTest({ stats: vi.fn() });
});

afterEach(() => {
  _clearStartupTickTimer();
  _setInitializedForTest(false);
  _setFtsSearchForTest(null);
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('_scheduleStartupTickWhenQuiet', () => {
  it('does not run the tick while sync events keep arriving', async () => {
    // Sync events keep firing — quietFor is always ~0
    mockGetLastSyncEventMs.mockImplementation(() => Date.now());
    mockIsReconcilePending.mockResolvedValue(false);

    _scheduleStartupTickWhenQuiet(runner);
    expect(_hasStartupTickTimer()).toBe(true);

    await vi.advanceTimersByTimeAsync(STARTUP_TICK_QUIET_PERIOD_MS * 3);

    expect(runner).not.toHaveBeenCalled();
    expect(_hasStartupTickTimer()).toBe(true);
  });

  it('runs the tick once the quiet period is reached and reconcile is done', async () => {
    const t0 = Date.now();
    mockGetLastSyncEventMs.mockReturnValue(t0); // no further sync events
    mockIsReconcilePending.mockResolvedValue(false);

    _scheduleStartupTickWhenQuiet(runner);

    // Just before the quiet period: not yet
    await vi.advanceTimersByTimeAsync(STARTUP_TICK_QUIET_PERIOD_MS - STARTUP_TICK_CHECK_INTERVAL_MS);
    expect(runner).not.toHaveBeenCalled();

    // Cross the quiet period boundary
    await vi.advanceTimersByTimeAsync(STARTUP_TICK_CHECK_INTERVAL_MS * 2);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith('startup');
    expect(_hasStartupTickTimer()).toBe(false); // one-shot: timer cleared
  });

  it('keeps waiting while boot reconcile is pending, runs after it clears', async () => {
    const t0 = Date.now();
    mockGetLastSyncEventMs.mockReturnValue(t0);
    let pending = true;
    mockIsReconcilePending.mockImplementation(async () => pending);

    _scheduleStartupTickWhenQuiet(runner);

    // Quiet period long passed, but reconcile still pending
    await vi.advanceTimersByTimeAsync(STARTUP_TICK_QUIET_PERIOD_MS * 2);
    expect(runner).not.toHaveBeenCalled();

    // Reconcile completes
    pending = false;
    await vi.advanceTimersByTimeAsync(STARTUP_TICK_CHECK_INTERVAL_MS * 2);

    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('runs the tick at the max-wait cap when never quiet but reconcile is done', async () => {
    // Permanently busy mailbox, reconcile completed
    mockGetLastSyncEventMs.mockImplementation(() => Date.now());
    mockIsReconcilePending.mockResolvedValue(false);

    _scheduleStartupTickWhenQuiet(runner);

    await vi.advanceTimersByTimeAsync(STARTUP_TICK_MAX_WAIT_MS - STARTUP_TICK_CHECK_INTERVAL_MS);
    expect(runner).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STARTUP_TICK_CHECK_INTERVAL_MS * 2);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(_hasStartupTickTimer()).toBe(false);
  });

  it('SKIPS the tick at the max-wait cap while reconcile is still pending (no concurrent scan)', async () => {
    // Reconcile stuck pending — forcing the scan would race it; the hourly
    // alarm is the backstop instead.
    mockGetLastSyncEventMs.mockImplementation(() => Date.now());
    mockIsReconcilePending.mockResolvedValue(true);

    _scheduleStartupTickWhenQuiet(runner);

    await vi.advanceTimersByTimeAsync(STARTUP_TICK_MAX_WAIT_MS + STARTUP_TICK_CHECK_INTERVAL_MS * 2);

    expect(runner).not.toHaveBeenCalled();
    expect(_hasStartupTickTimer()).toBe(false); // timer cleared, not left polling
  });

  it('double-fire guard: overlapping slow callbacks run the tick exactly once', async () => {
    // Quiet immediately (last sync event far in the past)
    mockGetLastSyncEventMs.mockReturnValue(Date.now() - STARTUP_TICK_QUIET_PERIOD_MS * 2);

    // isReconcilePending hangs until we release it — both interval callbacks
    // get past the guard checks and park on this await.
    const resolvers = [];
    mockIsReconcilePending.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );

    _scheduleStartupTickWhenQuiet(runner);

    // Two interval firings, both now awaiting isReconcilePending
    await vi.advanceTimersByTimeAsync(STARTUP_TICK_CHECK_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(STARTUP_TICK_CHECK_INTERVAL_MS);
    expect(resolvers.length).toBe(2);
    expect(runner).not.toHaveBeenCalled();

    // Release both — both proceed to the decision point; only one may fire
    for (const resolve of resolvers) resolve(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('runner throwing is contained: no unhandled rejection, timer cleared', async () => {
    mockGetLastSyncEventMs.mockReturnValue(Date.now() - STARTUP_TICK_QUIET_PERIOD_MS * 2);
    mockIsReconcilePending.mockResolvedValue(false);
    runner = vi.fn(async () => {
      throw new Error('scan exploded');
    });

    _scheduleStartupTickWhenQuiet(runner);

    await vi.advanceTimersByTimeAsync(STARTUP_TICK_CHECK_INTERVAL_MS * 2);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(_hasStartupTickTimer()).toBe(false);
  });

  it('stops without running when the scheduler is disposed while waiting', async () => {
    const t0 = Date.now();
    mockGetLastSyncEventMs.mockReturnValue(t0);
    mockIsReconcilePending.mockResolvedValue(false);

    _scheduleStartupTickWhenQuiet(runner);

    // Dispose mid-wait
    _setInitializedForTest(false);
    await vi.advanceTimersByTimeAsync(STARTUP_TICK_QUIET_PERIOD_MS * 2);

    expect(runner).not.toHaveBeenCalled();
    expect(_hasStartupTickTimer()).toBe(false);
  });

  it('treats indexer state as quiet if the indexer module is unavailable', async () => {
    mockGetLastSyncEventMs.mockImplementation(() => {
      throw new Error('indexer gone');
    });
    mockIsReconcilePending.mockResolvedValue(false);

    _scheduleStartupTickWhenQuiet(runner);

    // First check should already pass (quietFor treated as Infinity)
    await vi.advanceTimersByTimeAsync(STARTUP_TICK_CHECK_INTERVAL_MS * 2);

    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe('initMaintenanceScheduler startup-tick deferral', () => {
  it('schedules the deferred tick instead of running maintenance synchronously', async () => {
    mockGetLastSyncEventMs.mockImplementation(() => Date.now());
    mockIsReconcilePending.mockResolvedValue(true);

    // beforeEach simulates an initialized scheduler — undo that so init runs
    _setInitializedForTest(false);
    await scheduler.initMaintenanceScheduler({ stats: vi.fn() });

    // Timer scheduled, but nothing ran yet (no scan status writes beyond init cleanup)
    expect(_hasStartupTickTimer()).toBe(true);

    // No maintenance scan started: fts_scan_status never set to isScanning=true
    const scanningWrites = browser.storage.local.set.mock.calls.filter(
      ([obj]) => obj?.fts_scan_status?.isScanning === true,
    );
    expect(scanningWrites).toHaveLength(0);

    // Dispose clears the pending startup tick
    await scheduler.disposeMaintenanceScheduler();
    expect(_hasStartupTickTimer()).toBe(false);
  });
});
