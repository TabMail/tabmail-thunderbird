/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// incrementalIndexerLogic.test.js — Tests for pure retry/progress functions in fts/incrementalIndexer.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    agentQueues: {
      ftsIncremental: {
        maxConsecutiveNoProgress: 5,
        retryDelayMs: 3000,
      },
    },
  },
}));

vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsBatchOperation: vi.fn(),
  logFtsOperation: vi.fn(),
  logMessageEventBatch: vi.fn(),
  logMoveEvent: vi.fn(),
}));

vi.mock('../agent/modules/utils.js', () => ({
  getForegroundFetchPressure: vi.fn(() => ({ active: 0, waiting: 0, chatTyping: false })),
  headerIDToWeID: vi.fn(),
  log: vi.fn(),
  parseUniqueId: vi.fn(),
  recheckMessageInFolder: vi.fn(),
}));

vi.mock('../fts/indexer.js', () => ({
  buildBatchHeader: vi.fn(),
  populateBatchBody: vi.fn(),
}));

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrDefaults) => {
        if (typeof keyOrDefaults === 'string') return { [keyOrDefaults]: storageData[keyOrDefaults] };
        if (Array.isArray(keyOrDefaults)) {
          return Object.fromEntries(keyOrDefaults.map(key => [key, storageData[key]]));
        }
        return Object.fromEntries(Object.entries(keyOrDefaults || {}).map(([key, fallback]) => [
          key,
          storageData[key] === undefined ? fallback : storageData[key],
        ]));
      }),
      set: vi.fn(async obj => Object.assign(storageData, obj)),
      remove: vi.fn(async keyOrKeys => {
        for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) delete storageData[key];
      }),
    },
  },
  messages: {
    get: vi.fn(async () => null),
    getFull: vi.fn(async () => null),
    list: vi.fn(async () => ({ messages: [] })),
    onNewMailReceived: { addListener: vi.fn(), removeListener: vi.fn() },
    onMoved: { addListener: vi.fn(), removeListener: vi.fn() },
    onDeleted: { addListener: vi.fn(), removeListener: vi.fn() },
    onCopied: { addListener: vi.fn(), removeListener: vi.fn() },
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  folders: {
    getParentFolders: vi.fn(async () => []),
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const incrementalIndexer = await import('../fts/incrementalIndexer.js');
const { _testExports, clearPendingUpdates } = incrementalIndexer;
const {
  _getRetryConfig,
  _shouldDropFailedUpdates,
  _markResolveFailed,
  _resetNoProgressCounter,
  _incrementNoProgressCounter,
  _getConsecutiveNoProgressCycles,
  _setConsecutiveNoProgressCycles,
  _getPendingUpdates,
  _abandonPendingUpdates,
  _getFolderReconDirty,
  _resetFolderReconState,
} = _testExports;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.browser.storage.local.get.mockImplementation(async (keyOrDefaults) => {
    if (typeof keyOrDefaults === 'string') return { [keyOrDefaults]: storageData[keyOrDefaults] };
    if (Array.isArray(keyOrDefaults)) {
      return Object.fromEntries(keyOrDefaults.map(key => [key, storageData[key]]));
    }
    return Object.fromEntries(Object.entries(keyOrDefaults || {}).map(([key, fallback]) => [
      key,
      storageData[key] === undefined ? fallback : storageData[key],
    ]));
  });
  globalThis.browser.storage.local.set.mockImplementation(async obj => Object.assign(storageData, obj));
  globalThis.browser.storage.local.remove.mockImplementation(async keyOrKeys => {
    for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) delete storageData[key];
  });
  for (const key of Object.keys(storageData)) delete storageData[key];
  _setConsecutiveNoProgressCycles(0);
  _getPendingUpdates().clear();
  _resetFolderReconState();
});

describe('atomic queue abandonment', () => {
  const entry = (uniqueKey, type, timestamp, folderKey) => ({
    uniqueKey, type, timestamp, folderKey, metadata: {}, hasFailed: true,
  });

  it('durably dirties exact folders once before dropping mixed add/move/delete failures', async () => {
    const captured = [
      entry('account1:/A:add@example.com', 'new', 1, 'account1:/A'),
      entry('account1:/A:move@example.com', 'moved', 2, 'account1:/A'),
      entry('account1:/B:delete@example.com', 'deleted', 3, 'account1:/B'),
    ];
    for (const update of captured) _getPendingUpdates().set(update.uniqueKey, update);

    const result = await _abandonPendingUpdates(captured, 'queue_stuck');

    expect(result).toMatchObject({ dropped: 3, retained: 0 });
    expect(_getPendingUpdates().size).toBe(0);
    expect(_getFolderReconDirty()).toEqual(new Set(['account1:/A', 'account1:/B']));
    expect(globalThis.browser.storage.local.set.mock.calls.filter(
      ([obj]) => Object.hasOwn(obj, 'fts_reconcile_pending'),
    )).toHaveLength(1);
  });

  it('retains every captured entry when the durable dirty marker write fails', async () => {
    const captured = [entry('account1:/A:add@example.com', 'new', 1, 'account1:/A')];
    _getPendingUpdates().set(captured[0].uniqueKey, captured[0]);
    globalThis.browser.storage.local.set.mockRejectedValueOnce(new Error('disk full'));

    await expect(_abandonPendingUpdates(captured, 'unparseable')).rejects.toThrow('disk full');
    expect(_getPendingUpdates().get(captured[0].uniqueKey)).toEqual(captured[0]);
  });

  it('never drops a newer timestamp or changed operation requeued under the same key', async () => {
    const old = entry('account1:/A:same@example.com', 'new', 1, 'account1:/A');
    _getPendingUpdates().set(old.uniqueKey, { ...old, type: 'deleted', timestamp: 2 });

    const result = await _abandonPendingUpdates([old], 'empty_header_batch');

    expect(result).toMatchObject({ dropped: 0, retained: 1 });
    expect(_getPendingUpdates().get(old.uniqueKey)).toMatchObject({ type: 'deleted', timestamp: 2 });
    expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('coalesces a persisted dirty marker instead of writing once per dropped key or wake', async () => {
    const first = entry('account1:/A:one@example.com', 'new', 1, 'account1:/A');
    const second = entry('account1:/A:two@example.com', 'deleted', 2, 'account1:/A');
    _getPendingUpdates().set(first.uniqueKey, first);
    await _abandonPendingUpdates([first], 'stuck');
    _getPendingUpdates().set(second.uniqueKey, second);
    await _abandonPendingUpdates([second], 'stuck');

    expect(globalThis.browser.storage.local.set.mock.calls.filter(
      ([obj]) => Object.hasOwn(obj, 'fts_reconcile_pending'),
    )).toHaveLength(1);
  });

  it('maps an admitted legacy entry without a folder identity to __all__', async () => {
    const legacy = entry('legacy-unparseable', 'new', 1, undefined);
    _getPendingUpdates().set(legacy.uniqueKey, legacy);

    await _abandonPendingUpdates([legacy], 'unparseable');

    expect(_getFolderReconDirty()).toEqual(new Set(['__all__']));
  });

  it('manual clear durably dirties admitted work instead of silently erasing it', async () => {
    const pending = entry('account1:/A:manual@example.com', 'new', 1, 'account1:/A');
    _getPendingUpdates().set(pending.uniqueKey, pending);

    await clearPendingUpdates();

    expect(_getPendingUpdates().size).toBe(0);
    expect(storageData.fts_reconcile_pending).toBeTruthy();
    expect(_getFolderReconDirty()).toContain('account1:/A');
  });
});

// ---------------------------------------------------------------------------
// _getRetryConfig
// ---------------------------------------------------------------------------

describe('_getRetryConfig', () => {
  it('returns values from SETTINGS when configured', () => {
    const cfg = _getRetryConfig();
    expect(cfg.maxConsecutiveNoProgress).toBe(5);
    expect(cfg.retryDelayMs).toBe(3000);
  });

  it('returns an object with maxConsecutiveNoProgress and retryDelayMs keys', () => {
    const cfg = _getRetryConfig();
    expect(cfg).toHaveProperty('maxConsecutiveNoProgress');
    expect(cfg).toHaveProperty('retryDelayMs');
    expect(typeof cfg.maxConsecutiveNoProgress).toBe('number');
    expect(typeof cfg.retryDelayMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// _shouldDropFailedUpdates
// ---------------------------------------------------------------------------

describe('_shouldDropFailedUpdates', () => {
  it('returns false when counter is below max', () => {
    _setConsecutiveNoProgressCycles(0);
    expect(_shouldDropFailedUpdates()).toBe(false);
  });

  it('returns false when counter is one below max', () => {
    _setConsecutiveNoProgressCycles(4);
    expect(_shouldDropFailedUpdates()).toBe(false);
  });

  it('returns true when counter equals max', () => {
    _setConsecutiveNoProgressCycles(5);
    expect(_shouldDropFailedUpdates()).toBe(true);
  });

  it('returns true when counter exceeds max', () => {
    _setConsecutiveNoProgressCycles(10);
    expect(_shouldDropFailedUpdates()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _markResolveFailed
// ---------------------------------------------------------------------------

describe('_markResolveFailed', () => {
  it('sets hasFailed to true on the update', () => {
    const update = { uniqueKey: 'test-key-1', type: 'add', timestamp: Date.now() };
    const result = _markResolveFailed(update);
    expect(result.hasFailed).toBe(true);
  });

  it('sets lastFailedAt to a recent timestamp', () => {
    const before = Date.now();
    const update = { uniqueKey: 'test-key-2', type: 'delete', timestamp: Date.now() };
    const result = _markResolveFailed(update);
    expect(result.lastFailedAt).toBeGreaterThanOrEqual(before);
    expect(result.lastFailedAt).toBeLessThanOrEqual(Date.now());
  });

  it('preserves other fields from the original update', () => {
    const update = {
      uniqueKey: 'test-key-3',
      type: 'update',
      timestamp: 12345,
      metadata: { subject: 'Test' },
    };
    const result = _markResolveFailed(update);
    expect(result.type).toBe('update');
    expect(result.timestamp).toBe(12345);
    expect(result.metadata).toEqual({ subject: 'Test' });
    expect(result.uniqueKey).toBe('test-key-3');
  });

  it('stores the updated entry in _pendingUpdates', () => {
    const update = { uniqueKey: 'test-key-4', type: 'add', timestamp: Date.now() };
    _markResolveFailed(update);
    const stored = _getPendingUpdates().get('test-key-4');
    expect(stored).toBeDefined();
    expect(stored.hasFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _resetNoProgressCounter
// ---------------------------------------------------------------------------

describe('_resetNoProgressCounter', () => {
  it('resets counter to 0 when it was positive', () => {
    _setConsecutiveNoProgressCycles(7);
    _resetNoProgressCounter();
    expect(_getConsecutiveNoProgressCycles()).toBe(0);
  });

  it('is a no-op when counter is already 0', () => {
    _setConsecutiveNoProgressCycles(0);
    _resetNoProgressCounter();
    expect(_getConsecutiveNoProgressCycles()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _incrementNoProgressCounter
// ---------------------------------------------------------------------------

describe('_incrementNoProgressCounter', () => {
  it('increments counter by 1 from zero', () => {
    _setConsecutiveNoProgressCycles(0);
    _incrementNoProgressCounter();
    expect(_getConsecutiveNoProgressCycles()).toBe(1);
  });

  it('increments counter by 1 from a positive value', () => {
    _setConsecutiveNoProgressCycles(3);
    _incrementNoProgressCounter();
    expect(_getConsecutiveNoProgressCycles()).toBe(4);
  });

  it('increments correctly over multiple calls', () => {
    _setConsecutiveNoProgressCycles(0);
    _incrementNoProgressCounter();
    _incrementNoProgressCounter();
    _incrementNoProgressCounter();
    expect(_getConsecutiveNoProgressCycles()).toBe(3);
  });
});
