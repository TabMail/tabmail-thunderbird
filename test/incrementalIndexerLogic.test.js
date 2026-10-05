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
const { _testExports } = incrementalIndexer;
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
  // Start from a settled session (folders completed this generation, orphan
  // stage done, quiet) so the work an abandonment owes is observable: its
  // walk marks are recorded and the orphan tail's quiet predicate, which
  // the next tick consults before completing, refuses.
  const settleSession = () => {
    _testExports._setFolderReconEphemeralEvidenceForTests({
      sessionDone: ['account1:/A', 'account1:/B'],
      orphanDone: true,
    });
    expect(quiet()).toBe(true);
  };
  const quiet = () => _testExports._folderReconQuietSince(
    _testExports._getFolderReconGeneration(),
    _testExports._getFolderReconEventSerial(),
  );
  const orphanDone = () => _testExports._getFolderReconEphemeralEvidence().orphanDone;

  it('dirties exact folders and reopens orphan completion before dropping mixed add/move/delete failures', async () => {
    settleSession();
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
    expect(orphanDone()).toBe(false);
    expect(quiet()).toBe(false);
  });

  it('abandons without any storage dependency, so unavailable storage cannot strand the queue', async () => {
    settleSession();
    const captured = [entry('account1:/A:add@example.com', 'new', 1, 'account1:/A')];
    _getPendingUpdates().set(captured[0].uniqueKey, captured[0]);
    globalThis.browser.storage.local.set.mockRejectedValue(new Error('disk full'));
    globalThis.browser.storage.local.remove.mockRejectedValue(new Error('disk full'));

    const result = await _abandonPendingUpdates(captured, 'unparseable');

    expect(result).toMatchObject({ dropped: 1, retained: 0 });
    expect(_getFolderReconDirty()).toEqual(new Set(['account1:/A']));
    expect(orphanDone()).toBe(false);
    expect(quiet()).toBe(false);
    expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
    expect(globalThis.browser.storage.local.remove).not.toHaveBeenCalled();
  });

  it('never drops a newer timestamp or changed operation requeued under the same key', async () => {
    const old = entry('account1:/A:same@example.com', 'new', 1, 'account1:/A');
    _getPendingUpdates().set(old.uniqueKey, { ...old, type: 'deleted', timestamp: 2 });

    const result = await _abandonPendingUpdates([old], 'empty_header_batch');

    expect(result).toMatchObject({ dropped: 0, retained: 1 });
    expect(_getPendingUpdates().get(old.uniqueKey)).toMatchObject({ type: 'deleted', timestamp: 2 });
    expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('never drops a same-type intention requeued in the same millisecond', async () => {
    settleSession();
    const old = entry('account1:/A:same@example.com', 'new', 1, 'account1:/A');
    const requeued = { ...old };
    _getPendingUpdates().set(old.uniqueKey, requeued);

    const result = await _abandonPendingUpdates([old], 'empty_header_batch');

    expect(result).toMatchObject({ dropped: 0, retained: 1 });
    expect(_getPendingUpdates().get(old.uniqueKey)).toBe(requeued);
    // Nothing was dropped, so no walk is owed and orphan completion stands.
    expect(_getFolderReconDirty()).toEqual(new Set());
    expect(orphanDone()).toBe(true);
  });

  it('writes no storage across repeated abandonments of the same folder', async () => {
    settleSession();
    const first = entry('account1:/A:one@example.com', 'new', 1, 'account1:/A');
    const second = entry('account1:/A:two@example.com', 'deleted', 2, 'account1:/A');
    _getPendingUpdates().set(first.uniqueKey, first);
    await _abandonPendingUpdates([first], 'stuck');
    _getPendingUpdates().set(second.uniqueKey, second);
    await _abandonPendingUpdates([second], 'stuck');

    expect(_getPendingUpdates().size).toBe(0);
    expect(_getFolderReconDirty()).toEqual(new Set(['account1:/A']));
    expect(quiet()).toBe(false);
    expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('owes a walk of every completed folder for an admitted legacy entry without a folder identity', async () => {
    _testExports._setFolderReconEphemeralEvidenceForTests({ sessionDone: ['account1:/A', 'account1:/B'] });
    const legacy = entry('legacy-unparseable', 'new', 1, undefined);
    _getPendingUpdates().set(legacy.uniqueKey, legacy);

    await _abandonPendingUpdates([legacy], 'unparseable');

    expect(_getFolderReconDirty()).toEqual(new Set(['account1:/A', 'account1:/B']));
    expect(_testExports._getFolderReconSessionDone().size).toBe(0);
    expect(quiet()).toBe(false);
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
  it('marks the queued entry in place with a recent lastFailedAt, keeping its other fields', () => {
    const before = Date.now();
    const update = {
      uniqueKey: 'test-key-3',
      type: 'update',
      timestamp: 12345,
      metadata: { subject: 'Test' },
    };
    _getPendingUpdates().set(update.uniqueKey, update);
    _markResolveFailed(update);
    const stored = _getPendingUpdates().get('test-key-3');
    expect(stored).toBe(update);
    expect(stored).toMatchObject({
      uniqueKey: 'test-key-3', type: 'update', timestamp: 12345, metadata: { subject: 'Test' }, hasFailed: true,
    });
    expect(stored.lastFailedAt).toBeGreaterThanOrEqual(before);
    expect(stored.lastFailedAt).toBeLessThanOrEqual(Date.now());
  });

  it('stores the updated entry in _pendingUpdates while it is still the queued intention', () => {
    const update = { uniqueKey: 'test-key-4', type: 'add', timestamp: Date.now() };
    _getPendingUpdates().set(update.uniqueKey, update);
    _markResolveFailed(update);
    const stored = _getPendingUpdates().get('test-key-4');
    expect(stored).toBeDefined();
    expect(stored.hasFailed).toBe(true);
  });

  // The drain marks the entry it captured before an await; a newer intention
  // queued meanwhile wins, and a dequeued or abandoned one stays gone.
  it('never overwrites a newer queued intention or resurrects a removed one', () => {
    const captured = { uniqueKey: 'test-key-5', type: 'add', timestamp: Date.now() };
    const newer = { uniqueKey: 'test-key-5', type: 'delete', timestamp: captured.timestamp + 1 };
    _getPendingUpdates().set(newer.uniqueKey, newer);
    _markResolveFailed(captured);
    expect(_getPendingUpdates().get('test-key-5')).toBe(newer);

    const removed = { uniqueKey: 'test-key-6', type: 'add', timestamp: Date.now() };
    _markResolveFailed(removed);
    expect(_getPendingUpdates().has('test-key-6')).toBe(false);
  });

  // Events can share a millisecond, so the type is part of the identity.
  it('never overwrites an opposite intention queued in the same millisecond', () => {
    const captured = { uniqueKey: 'test-key-7', type: 'add', timestamp: Date.now() };
    const newer = { uniqueKey: 'test-key-7', type: 'delete', timestamp: captured.timestamp };
    _getPendingUpdates().set(newer.uniqueKey, newer);
    _markResolveFailed(captured);
    expect(_getPendingUpdates().get('test-key-7')).toBe(newer);
  });

  // Type + millisecond is not an identity: a remove and a re-add can both
  // land in the millisecond of the captured add.
  it('never marks a same-type intention queued in the same millisecond', () => {
    const captured = { uniqueKey: 'test-key-9', type: 'add', timestamp: Date.now() };
    const newer = { ...captured };
    _getPendingUpdates().set(newer.uniqueKey, newer);
    _markResolveFailed(captured);
    expect(_getPendingUpdates().get('test-key-9')).toBe(newer);
    expect(newer.hasFailed).toBeUndefined();
  });

  // The same message can be added, removed and added again: a later
  // intention of the same type is still a different one.
  it('never marks a same-type intention queued later', () => {
    const captured = { uniqueKey: 'test-key-8', type: 'add', timestamp: Date.now() };
    const newer = { uniqueKey: 'test-key-8', type: 'add', timestamp: captured.timestamp + 1 };
    _getPendingUpdates().set(newer.uniqueKey, newer);
    _markResolveFailed(captured);
    expect(_getPendingUpdates().get('test-key-8')).toBe(newer);
    expect(newer.hasFailed).toBeUndefined();
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
