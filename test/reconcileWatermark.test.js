/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// reconcileWatermark.test.js — Tests for the persistent watermark that
// bounds the boot reconcile window, plus the runtime heartbeat that
// advances it. See PLAN_RECONCILE_WATERMARK.md.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (mirrors ftsReconcile.test.js setup)
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

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrDefault) => {
        if (typeof keyOrDefault === 'string') {
          return { [keyOrDefault]: storageData[keyOrDefault] };
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
  messages: { get: vi.fn(), query: vi.fn(), continueList: vi.fn() },
  folders: { query: vi.fn(), getSubFolders: vi.fn() },
  accounts: { list: vi.fn(async () => []), get: vi.fn() },
};

const { _testExports } = await import('../fts/incrementalIndexer.js');
const {
  _getReconcileFrom,
  _writeWatermark,
  _heartbeatBumpWatermark,
  _startWatermarkHeartbeat,
  _stopWatermarkHeartbeat,
  _hasWatermarkHeartbeatTimer,
  _setIndexerDisposed,
  _getIndexerDisposed,
  _setExperimentListenersActive,
  _setIsEnabled,
  _getPendingUpdates,
  WATERMARK_KEY,
  HEARTBEAT_INTERVAL_MS,
  RECONCILE_OVERLAP_MS,
  RECONCILE_FALLBACK_WINDOW_MS,
} = _testExports;

const ONE_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(storageData)) delete storageData[k];
  _stopWatermarkHeartbeat();
  _setIndexerDisposed(false);
  _setExperimentListenersActive(true);
  _setIsEnabled(true);
  // Clear pending updates map
  const pending = _getPendingUpdates();
  pending.clear();
});

afterEach(() => {
  _stopWatermarkHeartbeat();
  _setIndexerDisposed(false);
  // Reset to default state
  _setExperimentListenersActive(false);
  _setIsEnabled(false);
});

// ---------------------------------------------------------------------------
// _getReconcileFrom
// ---------------------------------------------------------------------------

describe('_getReconcileFrom', () => {
  it('returns 7-day fallback when watermark is missing', async () => {
    const before = Date.now();
    const result = await _getReconcileFrom();
    const after = Date.now();
    // result should be approximately (now - 7d)
    expect(result).toBeGreaterThanOrEqual(before - RECONCILE_FALLBACK_WINDOW_MS - 10);
    expect(result).toBeLessThanOrEqual(after - RECONCILE_FALLBACK_WINDOW_MS + 10);
  });

  it('returns (completedAtMs - 1d) when watermark is fresh', async () => {
    const now = Date.now();
    const wmCompletedAt = now - 5 * 60 * 1000; // 5 min ago
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: now - 7 * ONE_DAY,
      completedAtMs: wmCompletedAt,
    };

    const result = await _getReconcileFrom();
    expect(result).toBe(wmCompletedAt - RECONCILE_OVERLAP_MS);
  });

  it('returns (completedAtMs - 1d) when watermark is 15 days old (the May 2026 regression)', async () => {
    const now = Date.now();
    const wmCompletedAt = now - 15 * ONE_DAY;
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: now - 16 * ONE_DAY,
      completedAtMs: wmCompletedAt,
    };

    const result = await _getReconcileFrom();
    expect(result).toBe(wmCompletedAt - RECONCILE_OVERLAP_MS);
    // Window covers ~16 days back from now
    expect(now - result).toBeGreaterThan(15 * ONE_DAY);
    expect(now - result).toBeLessThan(17 * ONE_DAY);
  });

  it('falls back to 7d when completedAtMs is future-dated (clock skew)', async () => {
    const now = Date.now();
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: now - ONE_DAY,
      completedAtMs: now + 2 * ONE_DAY, // 2 days in the future
    };

    const result = await _getReconcileFrom();
    expect(result).toBeLessThanOrEqual(now - RECONCILE_FALLBACK_WINDOW_MS + 100);
    expect(result).toBeGreaterThanOrEqual(now - RECONCILE_FALLBACK_WINDOW_MS - 100);
  });

  it('falls back to 7d when completedAtMs is zero or negative (corrupt)', async () => {
    const now = Date.now();
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: now - ONE_DAY,
      completedAtMs: 0,
    };

    let result = await _getReconcileFrom();
    expect(result).toBeLessThanOrEqual(now - RECONCILE_FALLBACK_WINDOW_MS + 100);

    storageData[WATERMARK_KEY].completedAtMs = -1;
    result = await _getReconcileFrom();
    expect(result).toBeLessThanOrEqual(now - RECONCILE_FALLBACK_WINDOW_MS + 100);
  });

  it('falls back to 7d when watermark fields are wrong type', async () => {
    const now = Date.now();

    storageData[WATERMARK_KEY] = { version: 1, fromMs: 'not-a-number', completedAtMs: now };
    let result = await _getReconcileFrom();
    expect(result).toBeLessThanOrEqual(now - RECONCILE_FALLBACK_WINDOW_MS + 100);

    storageData[WATERMARK_KEY] = { version: 1, fromMs: now, completedAtMs: null };
    result = await _getReconcileFrom();
    expect(result).toBeLessThanOrEqual(now - RECONCILE_FALLBACK_WINDOW_MS + 100);

    // NaN and Infinity must also fall back — Number.isFinite catches them.
    storageData[WATERMARK_KEY] = { version: 1, fromMs: NaN, completedAtMs: now };
    result = await _getReconcileFrom();
    expect(result).toBeLessThanOrEqual(now - RECONCILE_FALLBACK_WINDOW_MS + 100);

    storageData[WATERMARK_KEY] = { version: 1, fromMs: now, completedAtMs: Infinity };
    result = await _getReconcileFrom();
    expect(result).toBeLessThanOrEqual(now - RECONCILE_FALLBACK_WINDOW_MS + 100);
  });

  it('returns a very-old window when watermark is 200 days old (no sanity floor)', async () => {
    const now = Date.now();
    const wmCompletedAt = now - 200 * ONE_DAY;
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: now - 201 * ONE_DAY,
      completedAtMs: wmCompletedAt,
    };

    const result = await _getReconcileFrom();
    expect(result).toBe(wmCompletedAt - RECONCILE_OVERLAP_MS);
    // No floor — window is genuinely 201 days
    expect(now - result).toBeGreaterThan(200 * ONE_DAY);
  });

  it('falls back to 7d when storage read throws', async () => {
    const origGet = browser.storage.local.get;
    browser.storage.local.get = vi.fn(async () => { throw new Error('storage broken'); });

    const now = Date.now();
    const result = await _getReconcileFrom();
    expect(result).toBeLessThanOrEqual(now - RECONCILE_FALLBACK_WINDOW_MS + 100);
    expect(result).toBeGreaterThanOrEqual(now - RECONCILE_FALLBACK_WINDOW_MS - 100);

    browser.storage.local.get = origGet;
  });
});

// ---------------------------------------------------------------------------
// _writeWatermark
// ---------------------------------------------------------------------------

describe('_writeWatermark', () => {
  it('writes a fresh watermark with fromMs + completedAtMs ≈ now', async () => {
    const fromMs = Date.now() - ONE_DAY;
    const before = Date.now();
    await _writeWatermark(fromMs);
    const after = Date.now();

    const wm = storageData[WATERMARK_KEY];
    expect(wm).toBeDefined();
    expect(wm.version).toBe(1);
    expect(wm.fromMs).toBe(fromMs);
    expect(wm.completedAtMs).toBeGreaterThanOrEqual(before);
    expect(wm.completedAtMs).toBeLessThanOrEqual(after);
  });

  it('swallows storage write failures (non-fatal)', async () => {
    const origSet = browser.storage.local.set;
    browser.storage.local.set = vi.fn(async () => { throw new Error('full disk'); });

    // Should not throw
    await expect(_writeWatermark(Date.now() - ONE_DAY)).resolves.toBeUndefined();

    browser.storage.local.set = origSet;
  });
});

// ---------------------------------------------------------------------------
// _heartbeatBumpWatermark
// ---------------------------------------------------------------------------

describe('_heartbeatBumpWatermark', () => {
  it('is a no-op when no watermark exists', async () => {
    await _heartbeatBumpWatermark();
    expect(storageData[WATERMARK_KEY]).toBeUndefined();
  });

  it('is a no-op when _isEnabled is false', async () => {
    const wm = { version: 1, fromMs: Date.now() - ONE_DAY, completedAtMs: Date.now() - 60000 };
    storageData[WATERMARK_KEY] = { ...wm };
    _setIsEnabled(false);

    await _heartbeatBumpWatermark();
    expect(storageData[WATERMARK_KEY].completedAtMs).toBe(wm.completedAtMs);
  });

  it('is a no-op when listener is inactive', async () => {
    const wm = { version: 1, fromMs: Date.now() - ONE_DAY, completedAtMs: Date.now() - 60000 };
    storageData[WATERMARK_KEY] = { ...wm };
    _setExperimentListenersActive(false);

    await _heartbeatBumpWatermark();
    expect(storageData[WATERMARK_KEY].completedAtMs).toBe(wm.completedAtMs);
  });

  it('is a no-op when indexer is disposed', async () => {
    const wm = { version: 1, fromMs: Date.now() - ONE_DAY, completedAtMs: Date.now() - 60000 };
    storageData[WATERMARK_KEY] = { ...wm };
    _setIndexerDisposed(true);

    await _heartbeatBumpWatermark();
    expect(storageData[WATERMARK_KEY].completedAtMs).toBe(wm.completedAtMs);
  });

  it('advances completedAtMs and keeps fromMs unchanged when healthy', async () => {
    const originalFromMs = Date.now() - 7 * ONE_DAY;
    const originalCompletedAt = Date.now() - 30 * 60 * 1000; // 30 min ago
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: originalFromMs,
      completedAtMs: originalCompletedAt,
    };

    const before = Date.now();
    await _heartbeatBumpWatermark();
    const after = Date.now();

    const wm = storageData[WATERMARK_KEY];
    expect(wm.fromMs).toBe(originalFromMs); // unchanged
    expect(wm.completedAtMs).toBeGreaterThanOrEqual(before);
    expect(wm.completedAtMs).toBeLessThanOrEqual(after);
  });

  it('skips when drain queue has stalled pending updates', async () => {
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: Date.now() - ONE_DAY,
      completedAtMs: Date.now() - 30 * 60 * 1000,
    };
    const originalCompletedAt = storageData[WATERMARK_KEY].completedAtMs;

    // Inject a pending update older than 2× HEARTBEAT_INTERVAL_MS
    const pending = _getPendingUpdates();
    pending.set('stuck-key', {
      type: 'new',
      uniqueKey: 'stuck-key',
      timestamp: Date.now() - 3 * HEARTBEAT_INTERVAL_MS,
      metadata: {},
    });

    await _heartbeatBumpWatermark();
    expect(storageData[WATERMARK_KEY].completedAtMs).toBe(originalCompletedAt);
  });

  it('proceeds when pending updates are all fresh', async () => {
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: Date.now() - ONE_DAY,
      completedAtMs: Date.now() - 30 * 60 * 1000,
    };
    const originalCompletedAt = storageData[WATERMARK_KEY].completedAtMs;

    // Pending update that just arrived
    const pending = _getPendingUpdates();
    pending.set('fresh-key', {
      type: 'new',
      uniqueKey: 'fresh-key',
      timestamp: Date.now() - 1000,
      metadata: {},
    });

    await _heartbeatBumpWatermark();
    expect(storageData[WATERMARK_KEY].completedAtMs).toBeGreaterThan(originalCompletedAt);
  });

  it('refuses to write if disposal happens after the storage read', async () => {
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: Date.now() - ONE_DAY,
      completedAtMs: Date.now() - 30 * 60 * 1000,
    };
    const originalCompletedAt = storageData[WATERMARK_KEY].completedAtMs;

    // Patch storage.local.get to flip the dispose flag mid-await.
    const origGet = browser.storage.local.get;
    browser.storage.local.get = vi.fn(async (key) => {
      _setIndexerDisposed(true);
      return { [key]: storageData[key] };
    });

    await _heartbeatBumpWatermark();
    expect(storageData[WATERMARK_KEY].completedAtMs).toBe(originalCompletedAt);

    browser.storage.local.get = origGet;
  });
});

// ---------------------------------------------------------------------------
// _startWatermarkHeartbeat / _stopWatermarkHeartbeat
// ---------------------------------------------------------------------------

describe('heartbeat timer lifecycle', () => {
  it('start sets the timer; stop clears it', () => {
    expect(_hasWatermarkHeartbeatTimer()).toBe(false);
    _startWatermarkHeartbeat();
    expect(_hasWatermarkHeartbeatTimer()).toBe(true);
    _stopWatermarkHeartbeat();
    expect(_hasWatermarkHeartbeatTimer()).toBe(false);
  });

  it('start is idempotent (replaces prior timer)', () => {
    _startWatermarkHeartbeat();
    const firstTimerActive = _hasWatermarkHeartbeatTimer();
    _startWatermarkHeartbeat();
    const secondTimerActive = _hasWatermarkHeartbeatTimer();
    expect(firstTimerActive).toBe(true);
    expect(secondTimerActive).toBe(true);
    // No assertion-able way to confirm only one timer is now active without
    // observing fired callbacks, but the implementation calls clearInterval
    // on the prior handle before assigning a new one.
    _stopWatermarkHeartbeat();
  });

  it('fires _heartbeatBumpWatermark on interval', async () => {
    vi.useFakeTimers();
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: Date.now() - ONE_DAY,
      completedAtMs: Date.now() - 30 * 60 * 1000,
    };
    const originalCompletedAt = storageData[WATERMARK_KEY].completedAtMs;

    _startWatermarkHeartbeat();

    // Advance past one heartbeat interval
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 1);
    // Let the async heartbeat resolve
    await vi.runOnlyPendingTimersAsync();

    expect(storageData[WATERMARK_KEY].completedAtMs).toBeGreaterThan(originalCompletedAt);

    _stopWatermarkHeartbeat();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// May 2026 regression fixture
// ---------------------------------------------------------------------------

describe('May 2026 regression: long-offline boot', () => {
  it('returns ~15-day window when watermark is 15 days old', async () => {
    // Simulate: TB ran cleanly on Apr 28, set watermark with completedAtMs
    // = that date. TB then offline for ~15 days. Now boots on May 13.
    const may13 = Date.UTC(2026, 4, 13, 16, 19, 0);
    const apr28 = Date.UTC(2026, 3, 28, 12, 0, 0);

    vi.useFakeTimers();
    vi.setSystemTime(may13);

    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: apr28 - ONE_DAY,
      completedAtMs: apr28,
    };

    const reconcileFrom = await _getReconcileFrom();
    // Window starts at apr28 - 1d
    expect(reconcileFrom).toBe(apr28 - ONE_DAY);
    // Window covers ~16 days from reconcileFrom to now
    expect(may13 - reconcileFrom).toBeGreaterThan(15 * ONE_DAY);
    expect(may13 - reconcileFrom).toBeLessThan(17 * ONE_DAY);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 7-day-on / 2-day-off scenario
// ---------------------------------------------------------------------------

describe('7-on / 2-off scenario: heartbeat keeps window tight', () => {
  it('produces ~3-day window after 7d uptime + 2d offline', async () => {
    vi.useFakeTimers();
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(t0);

    // Boot reconcile completes at t0
    storageData[WATERMARK_KEY] = {
      version: 1,
      fromMs: t0 - ONE_DAY,
      completedAtMs: t0,
    };

    _startWatermarkHeartbeat();

    // Simulate 7 days of TB uptime with heartbeats firing on schedule.
    // Use one tick per HEARTBEAT_INTERVAL_MS to keep the test fast.
    const totalUptimeMs = 7 * ONE_DAY;
    let elapsed = 0;
    while (elapsed < totalUptimeMs) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      elapsed += HEARTBEAT_INTERVAL_MS;
    }

    // After 7d of heartbeats, completedAtMs should be near t0 + 7d
    const afterUptime = storageData[WATERMARK_KEY].completedAtMs;
    expect(afterUptime).toBeGreaterThanOrEqual(t0 + totalUptimeMs - HEARTBEAT_INTERVAL_MS);
    expect(afterUptime).toBeLessThanOrEqual(t0 + totalUptimeMs + HEARTBEAT_INTERVAL_MS);

    // TB shutdown → 2 days offline
    _stopWatermarkHeartbeat();
    const tBoot = t0 + totalUptimeMs + 2 * ONE_DAY;
    vi.setSystemTime(tBoot);

    // Next boot computes the window
    const reconcileFrom = await _getReconcileFrom();
    const windowSize = tBoot - reconcileFrom;
    // Window should be ~3 days (2 day gap + 1 day overlap + heartbeat slack)
    expect(windowSize).toBeGreaterThanOrEqual(3 * ONE_DAY - HEARTBEAT_INTERVAL_MS);
    expect(windowSize).toBeLessThanOrEqual(3 * ONE_DAY + HEARTBEAT_INTERVAL_MS + ONE_DAY);

    vi.useRealTimers();
  });
});
