/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIndexMessages, mockLog, mockNativeOptimize } = vi.hoisted(() => ({
  mockIndexMessages: vi.fn(),
  mockLog: vi.fn(),
  mockNativeOptimize: vi.fn(),
}));

vi.mock('../fts/indexer.js', () => ({
  indexMessages: mockIndexMessages,
}));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    ftsCleanup: {
      queryChunkSize: 5,
      validationBatchSize: 2,
      removeBatchSize: 2,
      batchDelayMs: 0,
      entryDelayMs: 0,
    },
    ftsMaintenanceLog: { maxCorrectionEntriesPerRun: 0 },
  },
}));
vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsOperation: vi.fn(),
  logFtsBatchOperation: vi.fn(),
  logMessageEventBatch: vi.fn(),
  logMoveEvent: vi.fn(),
}));
vi.mock('../agent/modules/utils.js', () => ({
  log: mockLog,
  headerIDToWeID: vi.fn(),
  parseUniqueId: vi.fn(),
  recheckMessageInFolder: vi.fn(),
}));
vi.mock('../fts/nativeEngine.js', () => ({
  initNativeFts: vi.fn(async () => true),
  nativeFtsSearch: {
    checkReindexNeeded: vi.fn(async () => ({ needsReindex: false, isFirstRun: false })),
    getHostAvailability: vi.fn(() => true),
    getHostStatus: vi.fn(() => ({ status: 'available' })),
    markVersionAsIndexed: vi.fn(async () => {}),
    optimize: (...args) => mockNativeOptimize(...args),
    stats: vi.fn(async () => ({ docs: 0, vecDocs: 0 })),
  },
  nativeMemorySearch: {},
}));
vi.mock('../fts/incrementalIndexer.js', () => ({
  disposeIncrementalIndexer: vi.fn(async () => {}),
  initIncrementalIndexer: vi.fn(async () => {}),
}));
vi.mock('../fts/memoryIndexer.js', () => ({
  migrateExistingChatHistory: vi.fn(async () => ({ migrated: false })),
}));

const storageData = {};
let runtimeListener = null;
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrDefaults) => {
        if (typeof keyOrDefaults === 'string') {
          return { [keyOrDefaults]: storageData[keyOrDefaults] };
        }
        return Object.fromEntries(Object.entries(keyOrDefaults || {}).map(([key, fallback]) => [
          key,
          storageData[key] === undefined ? fallback : storageData[key],
        ]));
      }),
      set: vi.fn(async values => Object.assign(storageData, values)),
    },
  },
  runtime: {
    onMessage: {
      addListener: vi.fn(listener => { runtimeListener = listener; }),
      removeListener: vi.fn(listener => {
        if (runtimeListener === listener) runtimeListener = null;
      }),
    },
    sendMessage: vi.fn(async () => {}),
  },
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    getAll: vi.fn(async () => []),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  folders: { query: vi.fn(async () => []) },
  accounts: { get: vi.fn(async () => null) },
};

const { _testExports, triggerMaintenanceScan } = await import('../fts/maintenanceScheduler.js');
const {
  _resetFtsOperationCoordinatorForTests,
  getFtsOperationState,
} = await import('../fts/operationCoordinator.js');

function makeFtsSearch(optimizeResult) {
  return {
    optimize: vi.fn(async () => optimizeResult),
    queryByDateRange: vi.fn(async () => []),
  };
}

function loggedText() {
  return mockLog.mock.calls.map(([message]) => String(message)).join('\n');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

let runtimeEngine = null;

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) delete storageData[key];
  _resetFtsOperationCoordinatorForTests();
  mockNativeOptimize.mockReset();
  mockIndexMessages.mockResolvedValue({
    scanned: 0,
    newlyIndexed: 0,
    skipped: 0,
    correctionDetails: [],
  });
});

afterEach(async () => {
  if (runtimeEngine) {
    await runtimeEngine.disposeFtsEngine();
    runtimeEngine = null;
  }
});

describe('native optimize maintenance contract', () => {
  it.each(['daily', 'weekly', 'monthly'])(
    'treats exact {ok:true} as one full call without invented progress telemetry for %s maintenance',
    async scheduleType => {
      const fts = makeFtsSearch({ ok: true });
      _testExports._setFtsSearchForTest(fts);

      await expect(triggerMaintenanceScan(scheduleType, true)).resolves.toMatchObject({
        ok: true,
        scheduleType,
      });

      expect(fts.optimize).toHaveBeenCalledTimes(1);
      expect(fts.optimize.mock.calls[0]).toEqual([]);

      const text = loggedText();
      expect(text).toContain('Native FTS5 optimize completed');
      expect(text).not.toMatch(/pageBudget|stepTimeMs|maxSteps|\bsteps\b|total changes|Δ=|dbSizeMB|size=undefined|converged|will continue next/);
      expect(text).not.toContain('undefined');
    },
  );

  it('does not optimize during hourly maintenance', async () => {
    const fts = makeFtsSearch({ ok: true });
    _testExports._setFtsSearchForTest(fts);

    await expect(triggerMaintenanceScan('hourly', true)).resolves.toMatchObject({
      ok: true,
      scheduleType: 'hourly',
    });

    expect(fts.optimize).not.toHaveBeenCalled();
    expect(loggedText()).not.toMatch(/native FTS5 optimize/i);
  });

  it.each([
    ['missing ok', {}],
    ['false ok', { ok: false }],
    ['null response', null],
    ['invented slice telemetry', { steps: 1, totalChanges: 0, converged: true }],
  ])('fails the optimize phase closed for a %s response', async (_label, optimizeResult) => {
    const fts = makeFtsSearch(optimizeResult);
    _testExports._setFtsSearchForTest(fts);

    await expect(triggerMaintenanceScan('daily', true)).resolves.toMatchObject({ ok: true });

    expect(fts.optimize).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain('Native FTS5 optimize failed: invalid response');
    expect(loggedText()).not.toContain('Native FTS5 optimize completed');
    expect(getFtsOperationState()).toMatchObject({ exclusive: false, reconcile: false });
  });

  it('logs a rejected native call as non-critical and releases maintenance ownership', async () => {
    const fts = makeFtsSearch({ ok: true });
    fts.optimize.mockRejectedValueOnce(new Error('native optimize rejected'));
    _testExports._setFtsSearchForTest(fts);

    await expect(triggerMaintenanceScan('daily', true)).resolves.toMatchObject({ ok: true });

    expect(loggedText()).toContain('Native FTS5 optimize failed: native optimize rejected');
    expect(loggedText()).not.toContain('Native FTS5 optimize completed');
    expect(getFtsOperationState()).toMatchObject({ exclusive: false, reconcile: false });
  });

  it('holds the maintenance lease through the full native call, then releases it', async () => {
    const pending = deferred();
    const fts = makeFtsSearch({ ok: true });
    fts.optimize.mockImplementationOnce(() => pending.promise);
    _testExports._setFtsSearchForTest(fts);

    const run = triggerMaintenanceScan('daily', true);
    await vi.waitFor(() => expect(fts.optimize).toHaveBeenCalledTimes(1));
    expect(getFtsOperationState()).toMatchObject({
      exclusive: true,
      exclusiveKind: 'maintenance:daily',
    });

    pending.resolve({ ok: true });
    await expect(run).resolves.toMatchObject({ ok: true });
    expect(getFtsOperationState()).toMatchObject({ exclusive: false, reconcile: false });
  });

  it('keeps the runtime optimize command owned until the native call resolves', async () => {
    const pending = deferred();
    mockNativeOptimize.mockImplementationOnce(() => pending.promise);
    runtimeEngine = await import('../fts/engine.js');
    await runtimeEngine.initFtsEngine();
    const sendResponse = vi.fn();

    expect(runtimeListener({ type: 'fts', cmd: 'optimize' }, {}, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(mockNativeOptimize).toHaveBeenCalledTimes(1));
    expect(mockNativeOptimize).toHaveBeenCalledWith();
    expect(getFtsOperationState()).toMatchObject({
      exclusive: true,
      exclusiveKind: 'optimize',
    });
    expect(sendResponse).not.toHaveBeenCalled();

    pending.resolve({ ok: true });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(getFtsOperationState()).toMatchObject({ exclusive: false, reconcile: false });
  });

  it('reports a rejected runtime optimize and releases its owned lifetime', async () => {
    const pending = deferred();
    mockNativeOptimize.mockImplementationOnce(() => pending.promise);
    runtimeEngine = await import('../fts/engine.js');
    await runtimeEngine.initFtsEngine();
    const sendResponse = vi.fn();

    expect(runtimeListener({ type: 'fts', cmd: 'optimize' }, {}, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(mockNativeOptimize).toHaveBeenCalledTimes(1));
    expect(mockNativeOptimize).toHaveBeenCalledWith();
    expect(getFtsOperationState()).toMatchObject({
      exclusive: true,
      exclusiveKind: 'optimize',
    });

    pending.reject(new Error('runtime native optimize rejected'));
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
      error: 'runtime native optimize rejected',
    }));
    expect(getFtsOperationState()).toMatchObject({ exclusive: false, reconcile: false });
  });
});
