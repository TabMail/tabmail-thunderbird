/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// maintenanceStartupTick.test.js — the maintenance scheduler's startup is a
// retirement migration only: it clears legacy schedules and alarms and arms
// no startup maintenance tick (the deferred tick, ADR-017, had no production
// caller and was deleted in PR 3b).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  getUniqueMessageKeyCandidates: vi.fn(),
  headerIDToWeID: vi.fn(),
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
  _setInitializedForTest,
  _setFtsSearchForTest,
} = _testExports;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  // Simulate an initialized scheduler; the test below undoes it.
  _setInitializedForTest(true);
  _setFtsSearchForTest({ stats: vi.fn() });
});

afterEach(() => {
  _setInitializedForTest(false);
  _setFtsSearchForTest(null);
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initMaintenanceScheduler retirement migration', () => {
  it('clears legacy schedules and does not create a startup tick or alarm', async () => {
    // beforeEach simulates an initialized scheduler — undo that so init runs
    _setInitializedForTest(false);
    await scheduler.initMaintenanceScheduler({ stats: vi.fn() });

    // No startup tick timer (or any other timer) is armed.
    expect(vi.getTimerCount()).toBe(0);
    expect(browser.alarms.create).not.toHaveBeenCalled();
    expect(browser.alarms.clear).toHaveBeenCalled();
    expect(browser.alarms.onAlarm.addListener).not.toHaveBeenCalled();

    expect(browser.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
      chat_ftsMaintenanceEnabled: false,
      chat_ftsMaintenanceWeeklyEnabled: false,
      fts_periodic_scans_retired_v1: true,
    }));

    // No maintenance scan started: fts_scan_status never set to isScanning=true
    const scanningWrites = browser.storage.local.set.mock.calls.filter(
      ([obj]) => obj?.fts_scan_status?.isScanning === true,
    );
    expect(scanningWrites).toHaveLength(0);

    expect(vi.getTimerCount()).toBe(0);
  });
});
