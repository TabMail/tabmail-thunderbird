/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetAttachmentFlags, mockIndexMessages, mockLog, mockNativeMemoryIndex, mockNativeMemorySearch, mockNativeMemoryTrim, mockNativeOptimize, mockRebuildEmbeddings } = vi.hoisted(() => ({
  mockGetAttachmentFlags: vi.fn(),
  mockIndexMessages: vi.fn(),
  mockLog: vi.fn(),
  mockNativeMemoryIndex: vi.fn(),
  mockNativeMemorySearch: vi.fn(),
  mockNativeMemoryTrim: vi.fn(),
  mockNativeOptimize: vi.fn(),
  mockRebuildEmbeddings: vi.fn(),
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
  getUniqueMessageKeyCandidates: vi.fn(),
  headerIDToWeID: vi.fn(),
  recheckMessageInFolder: vi.fn(),
}));
vi.mock('../fts/nativeEngine.js', () => ({
  initNativeFts: vi.fn(async () => true),
  nativeFtsSearch: {
    checkReindexNeeded: vi.fn(async () => ({ needsReindex: false, isFirstRun: false })),
    getAttachmentFlags: (...args) => mockGetAttachmentFlags(...args),
    getHostAvailability: vi.fn(() => true),
    getHostStatus: vi.fn(() => ({ status: 'available' })),
    markVersionAsIndexed: vi.fn(async () => {}),
    optimize: (...args) => mockNativeOptimize(...args),
    rebuildEmbeddings: (...args) => mockRebuildEmbeddings(...args),
    stats: vi.fn(async () => ({ docs: 0, vecDocs: 0 })),
    supportsFolderMembership: vi.fn(() => true),
    getConnectionGeneration: vi.fn(() => 7),
    addConnectionListener: vi.fn(() => 'unsubscribe'),
  },
  nativeMemorySearch: {
    indexBatch: (...args) => mockNativeMemoryIndex(...args),
    search: (...args) => mockNativeMemorySearch(...args),
    trim: (...args) => mockNativeMemoryTrim(...args),
  },
}));
vi.mock('../fts/incrementalIndexer.js', () => ({
  initIncrementalIndexer: vi.fn(async () => {}),
}));
vi.mock('../fts/memoryIndexer.js', async importOriginal => ({
  ...await importOriginal(),
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
  mockNativeMemoryIndex.mockReset();
  mockNativeMemorySearch.mockReset();
  mockNativeMemoryTrim.mockReset();
  mockRebuildEmbeddings.mockReset();
  mockIndexMessages.mockResolvedValue({
    scanned: 0,
    newlyIndexed: 0,
    skipped: 0,
    correctionDetails: [],
  });
});

afterEach(async () => {
  if (runtimeEngine) {
    runtimeEngine._resetFtsEngineForTests();
    runtimeEngine = null;
  }
});

describe('native optimize maintenance contract', () => {
  it('exposes the native connection contract that reconciliation binds its proofs to', async () => {
    const { nativeFtsSearch } = await import('../fts/nativeEngine.js');
    const { ftsSearch } = await import('../fts/engine.js');
    const listener = () => {};

    expect(ftsSearch.supportsFolderMembership()).toBe(true);
    expect(ftsSearch.getConnectionGeneration()).toBe(7);
    expect(ftsSearch.addConnectionListener(listener)).toBe('unsubscribe');
    expect(nativeFtsSearch.addConnectionListener).toHaveBeenCalledWith(listener);
  });

  it('shares one engine initialization across concurrent recovery callers', async () => {
    const pending = deferred();
    const { initNativeFts } = await import('../fts/nativeEngine.js');
    const { initIncrementalIndexer } = await import('../fts/incrementalIndexer.js');
    vi.mocked(initNativeFts).mockImplementationOnce(() => pending.promise);
    runtimeEngine = await import('../fts/engine.js');

    const first = runtimeEngine.initFtsEngine();
    const second = runtimeEngine.initFtsEngine();
    expect(second).toBe(first);
    expect(initNativeFts).toHaveBeenCalledTimes(1);

    pending.resolve(true);
    await Promise.all([first, second]);
    expect(initIncrementalIndexer).toHaveBeenCalledTimes(1);

    // A later UI/alarm probe must reuse the completed engine, not reattach
    // listeners or restart the boot reconciliation.
    await expect(runtimeEngine.initFtsEngine()).resolves.toBe(runtimeEngine.ftsSearch);
    expect(initNativeFts).toHaveBeenCalledTimes(1);
    expect(initIncrementalIndexer).toHaveBeenCalledTimes(1);
  });

  it('retries engine initialization after the native helper was missing', async () => {
    const { initNativeFts } = await import('../fts/nativeEngine.js');
    const { initIncrementalIndexer } = await import('../fts/incrementalIndexer.js');
    vi.mocked(initNativeFts).mockRejectedValueOnce(new Error('helper missing'));
    runtimeEngine = await import('../fts/engine.js');

    await expect(runtimeEngine.initFtsEngine()).rejects.toThrow('helper missing');
    await expect(runtimeEngine.initFtsEngine()).resolves.toBe(runtimeEngine.ftsSearch);
    expect(initNativeFts).toHaveBeenCalledTimes(2);
    expect(initIncrementalIndexer).toHaveBeenCalledTimes(1);
  });

  it('does not report startup complete when incremental reconciliation failed to start', async () => {
    const { initIncrementalIndexer } = await import('../fts/incrementalIndexer.js');
    vi.mocked(initIncrementalIndexer).mockRejectedValueOnce(new Error('marker write failed'));
    runtimeEngine = await import('../fts/engine.js');

    await expect(runtimeEngine.initFtsEngine()).rejects.toThrow('marker write failed');
    await expect(runtimeEngine.initFtsEngine()).resolves.toBe(runtimeEngine.ftsSearch);
    expect(initIncrementalIndexer).toHaveBeenCalledTimes(2);
    expect(browser.runtime.onMessage.addListener).toHaveBeenCalledTimes(2);
    expect(browser.runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);
  });

  it('does not queue a second embedding rebuild when indexer startup retries', async () => {
    const { nativeFtsSearch } = await import('../fts/nativeEngine.js');
    const { initIncrementalIndexer } = await import('../fts/incrementalIndexer.js');
    const pending = deferred();
    vi.mocked(nativeFtsSearch.checkReindexNeeded).mockResolvedValue({
      needsReindex: true, lastSchemaVersion: 1, currentSchemaVersion: 2,
    });
    mockRebuildEmbeddings.mockImplementationOnce(() => pending.promise);
    vi.mocked(initIncrementalIndexer).mockRejectedValueOnce(new Error('marker write failed'));
    runtimeEngine = await import('../fts/engine.js');

    await expect(runtimeEngine.initFtsEngine()).rejects.toThrow('marker write failed');
    await vi.waitFor(() => expect(mockRebuildEmbeddings).toHaveBeenCalledTimes(1));
    await runtimeEngine.initFtsEngine();
    expect(getFtsOperationState().foregroundWaiting).toBe(0);
    expect(mockRebuildEmbeddings).toHaveBeenCalledTimes(1);

    pending.resolve({ ok: true, emailEmbedded: 0, emailTotal: 0, memoryEmbedded: 0, memoryTotal: 0 });
    await vi.waitFor(() => expect(nativeFtsSearch.markVersionAsIndexed).toHaveBeenCalledTimes(1));
  });

  it('retries an embedding rebuild after its failed attempt releases ownership', async () => {
    const { nativeFtsSearch } = await import('../fts/nativeEngine.js');
    const { initIncrementalIndexer } = await import('../fts/incrementalIndexer.js');
    vi.mocked(nativeFtsSearch.checkReindexNeeded).mockResolvedValue({
      needsReindex: true, lastSchemaVersion: 1, currentSchemaVersion: 2,
    });
    mockRebuildEmbeddings
      .mockRejectedValueOnce(new Error('synthetic rebuild failure'))
      .mockResolvedValueOnce({ ok: true, emailEmbedded: 0, emailTotal: 0, memoryEmbedded: 0, memoryTotal: 0 });
    vi.mocked(initIncrementalIndexer).mockRejectedValueOnce(new Error('marker write failed'));
    runtimeEngine = await import('../fts/engine.js');

    await expect(runtimeEngine.initFtsEngine()).rejects.toThrow('marker write failed');
    await vi.waitFor(() => expect(mockRebuildEmbeddings).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(getFtsOperationState().exclusive).toBe(false));
    await runtimeEngine.initFtsEngine();
    await vi.waitFor(() => expect(mockRebuildEmbeddings).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(nativeFtsSearch.markVersionAsIndexed).toHaveBeenCalledTimes(1));
  });

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

// inbox_read in the chat window asks the background for the index's attachment flags over this
// command, because only the background owns the native helper's port (fts/ftsRequest.js).
describe('attachment flags command', () => {
  it('answers with the helper\'s flags for the msgIds asked', async () => {
    mockGetAttachmentFlags.mockResolvedValueOnce({ ok: true, flags: [true, null] });
    runtimeEngine = await import('../fts/engine.js');
    await runtimeEngine.initFtsEngine();
    const sendResponse = vi.fn();

    const msgIds = ['account1:/INBOX:a@example.com', 'account1:/INBOX:b@example.com'];
    expect(runtimeListener({ type: 'fts', cmd: 'getAttachmentFlags', msgIds }, {}, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, flags: [true, null] }));
    expect(mockGetAttachmentFlags).toHaveBeenCalledWith(msgIds);
  });

  it('answers a helper error as an error', async () => {
    mockGetAttachmentFlags.mockRejectedValueOnce(new Error('Unknown method: getAttachmentFlags'));
    runtimeEngine = await import('../fts/engine.js');
    await runtimeEngine.initFtsEngine();
    const sendResponse = vi.fn();

    runtimeListener({ type: 'fts', cmd: 'getAttachmentFlags', msgIds: ['account1:/INBOX:a@example.com'] }, {}, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ error: 'Unknown method: getAttachmentFlags' }));
  });
});

// The chat memory_search tool sends its search through this command; the
// preview length it asks must reach the helper.
describe('memory search command', () => {
  it('passes the search, with its preview length, to the helper and answers its rows', async () => {
    const rows = [{ memId: 'turn:1', dateMs: 1, content: '[USER]: hi', snippet: null }];
    mockNativeMemorySearch.mockResolvedValueOnce(rows);
    runtimeEngine = await import('../fts/engine.js');
    await runtimeEngine.initFtsEngine();
    const sendResponse = vi.fn();

    runtimeListener({ type: 'fts', cmd: 'memorySearch', q: '', from: '', to: '', limit: 6, ignoreDate: true, previewChars: 400 }, {}, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(rows));
    expect(mockNativeMemorySearch).toHaveBeenCalledWith('', { from: '', to: '', limit: 6, ignoreDate: true, previewChars: 400 });
  });

  it('cuts a conversation only when a preview is asked for: Chat History gets it whole', async () => {
    const content = '[USER]: ' + 'trip '.repeat(200) + 'END OF THE CONVERSATION';
    const row = { memId: 'turn:1', dateMs: Date.now() - 60_000, sessionId: 'persistent_chat', content, snippet: 'trip' };
    // Like the helper: the content is cut to the preview length only when one is sent.
    mockNativeMemorySearch.mockImplementation(async (_q, options) => [
      { ...row, content: options.previewChars ? content.slice(0, options.previewChars) : content },
    ]);
    runtimeEngine = await import('../fts/engine.js');
    await runtimeEngine.initFtsEngine();

    const toolResponse = vi.fn();
    runtimeListener({ type: 'fts', cmd: 'memorySearch', q: 'trip', limit: 6, ignoreDate: true, previewChars: 400 }, {}, toolResponse);
    await vi.waitFor(() => expect(toolResponse).toHaveBeenCalledTimes(1));
    expect(toolResponse.mock.calls[0][0][0].content).toBe(content.slice(0, 400));

    // Chat History's search sends no preview length.
    const historyResponse = vi.fn();
    runtimeListener({ type: 'fts', cmd: 'memorySearch', q: 'trip', limit: 200, ignoreDate: true }, {}, historyResponse);
    await vi.waitFor(() => expect(historyResponse).toHaveBeenCalledTimes(1));
    expect(historyResponse.mock.calls[0][0][0].content).toBe(content);
    expect(historyResponse.mock.calls[0][0][0].content.endsWith('END OF THE CONVERSATION')).toBe(true);
  });
});

// The Chat History tab applies a changed memory size limit through this
// command, because only the background owns the native helper's port.
describe('memory trim command', () => {
  it('applies the limit once through the helper and answers with its result', async () => {
    const result = { ok: true, trimmed: 4, usedBytes: 10, withinLimit: true };
    mockNativeMemoryTrim.mockResolvedValueOnce(result);
    runtimeEngine = await import('../fts/engine.js');
    await runtimeEngine.initFtsEngine();
    const sendResponse = vi.fn();

    expect(runtimeListener({ type: 'fts', cmd: 'memoryTrim' }, {}, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(result));
    expect(mockNativeMemoryTrim).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('answers a helper failure as an error', async () => {
    mockNativeMemoryTrim.mockRejectedValueOnce(new Error('Native RPC timed out'));
    runtimeEngine = await import('../fts/engine.js');
    await runtimeEngine.initFtsEngine();
    const sendResponse = vi.fn();

    runtimeListener({ type: 'fts', cmd: 'memoryTrim' }, {}, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ error: 'Native RPC timed out' }));
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });
});

// A chat exchange and a finished session reach the helper's memory write
// whole, through the background's command when the caller does not own the
// helper's port.
describe('memory writes from chat', () => {
  async function connected() {
    const written = new Map();
    mockNativeMemoryIndex.mockImplementation(async rows => {
      for (const row of rows) written.set(row.memId, structuredClone(row));
      return { ok: true, count: rows.length };
    });
    runtimeEngine = await import('../fts/engine.js');
    await runtimeEngine.initFtsEngine();
    browser.runtime.sendMessage.mockImplementation(msg => new Promise(resolve => runtimeListener(msg, {}, resolve)));
    const indexer = await import('../fts/memoryIndexer.js');
    return { written, ...indexer };
  }

  afterEach(() => {
    browser.runtime.sendMessage.mockImplementation(async () => {});
  });

  it('keeps a whole exchange sent through the background command', async () => {
    const { written, indexChatTurn } = await connected();
    const text = 'full fixture content '.repeat(1000);
    const now = Date.now();
    await indexChatTurn(text, 'answer', 'fixture-turn', now);
    expect([...written.keys()]).toEqual(['turn:fixture-turn']);
    expect(written.get('turn:fixture-turn').content).toBe(`[USER]: ${text}\n\n[AGENT]: answer`);
    expect(written.get('turn:fixture-turn').dateMs).toBe(now);
  });

  it('keeps a whole session sent through the background command when the direct write fails', async () => {
    const { written, indexChatSession } = await connected();
    mockNativeMemoryIndex.mockRejectedValueOnce(new Error('Native FTS helper not connected'));
    const text = 'full fixture content '.repeat(1000);
    const now = Date.now();
    await indexChatSession('fixture-session', [{ role: 'user', content: text }, { role: 'assistant', content: 'answer' }], now);
    expect(mockNativeMemoryIndex).toHaveBeenCalledTimes(2);
    expect([...written.keys()]).toEqual(['chat:fixture-session']);
    expect(written.get('chat:fixture-session').content).toBe(`[USER]: ${text}\n\n[AGENT]: answer`);
    expect(written.get('chat:fixture-session').dateMs).toBe(now);
  });
});
