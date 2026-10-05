import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  log: null,
  indexMessages: null,
  logSmartReindexRun: null,
  repairedAccounts: null,
  accounts: null,
  stored: {},
  listener: null,
}));

vi.mock('../agent/modules/config.js', () => ({ SETTINGS: {} }));
vi.mock('../agent/modules/utils.js', () => ({ log: (...args) => h.log(...args) }));
vi.mock('../fts/nativeEngine.js', () => ({
  initNativeFts: vi.fn(async () => {}),
  nativeFtsSearch: {
    checkReindexNeeded: vi.fn(async () => ({ needsReindex: false, isFirstRun: false })),
    stats: vi.fn(async () => ({ docs: 0, vecDocs: 0 })),
  },
  nativeMemorySearch: {},
}));
vi.mock('../fts/operationCoordinator.js', () => ({
  acquireFtsExclusiveOperation: vi.fn(async () => ({ release: vi.fn() })),
  clearOwnedFtsScanStatus: vi.fn(async () => {}),
  normalizeInterruptedFtsScanStatus: vi.fn(async () => {}),
  runFtsMembershipMutation: vi.fn(),
  writeOwnedFtsScanStatus: vi.fn(async () => {}),
}));
vi.mock('../fts/indexer.js', () => ({ indexMessages: (...args) => h.indexMessages(...args) }));
vi.mock('../fts/incrementalIndexer.js', () => ({ initIncrementalIndexer: vi.fn(async () => {}) }));
vi.mock('../fts/maintenanceScheduler.js', () => ({
  initMaintenanceScheduler: vi.fn(async () => {}),
  logSmartReindexRun: (...args) => h.logSmartReindexRun(...args),
}));
vi.mock('../fts/memoryIndexer.js', () => ({
  migrateExistingChatHistory: vi.fn(async () => ({ migrated: false })),
}));
vi.mock('../fts/attachmentFlags.js', () => ({
  getAttachmentRepairedAccounts: () => h.repairedAccounts(),
}));

async function startEngine() {
  vi.resetModules();
  const engine = await import('../fts/engine.js');
  await engine.initFtsEngine();
  return engine;
}

function sendFts(cmd, extra = {}) {
  return new Promise((resolve) => {
    expect(h.listener({ type: 'fts', cmd, ...extra }, {}, resolve)).toBe(true);
  });
}

const logLines = () => h.log.mock.calls.map(([line]) => String(line));

describe('attachment flag repair startup trigger', () => {
  beforeEach(() => {
    h.log = vi.fn();
    h.indexMessages = vi.fn(async () => ({ attachmentRepair: { repaired: 3, failedBatches: 0 } }));
    h.logSmartReindexRun = vi.fn(async () => {});
    h.repairedAccounts = vi.fn(async () => new Set(['account1']));
    h.accounts = [{ id: 'account1', rootFolder: { id: 'r1' } }, { id: 'account2', rootFolder: { id: 'r2' } }];
    h.stored = { fts_initial_scan_complete: true };
    h.listener = null;
    globalThis.browser = {
      storage: { local: {
        get: vi.fn(async (key) => (typeof key === 'string' ? { [key]: h.stored[key] } : { ...h.stored })),
      } },
      accounts: { list: vi.fn(async () => h.accounts) },
      runtime: {
        sendMessage: vi.fn(async () => {}),
        onMessage: { addListener: vi.fn((fn) => { h.listener = fn; }), removeListener: vi.fn() },
      },
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.browser;
  });

  it('runs a full smart reindex in the background while a loaded account is unrepaired', async () => {
    await startEngine();

    await vi.waitFor(() => expect(logLines().some(l => l.includes('repair smart reindex finished'))).toBe(true));
    expect(h.indexMessages).toHaveBeenCalledTimes(1);
    // A full scan: no date range, no progress callback for the background run.
    expect(h.indexMessages.mock.calls[0][1]).toBeUndefined();
    expect(h.indexMessages.mock.calls[0]).toHaveLength(2);
    expect(h.logSmartReindexRun).toHaveBeenCalledWith({ attachmentRepair: { repaired: 3, failedBatches: 0 } });
    expect(logLines().find(l => l.includes('repair smart reindex finished')))
      .toContain('{"repaired":3,"failedBatches":0}');
  });

  it('does not hold up engine initialization while the repair reindex runs', async () => {
    let finishScan;
    h.indexMessages = vi.fn(() => new Promise((resolve) => { finishScan = resolve; }));
    await startEngine();

    // Initialization has resolved while the reindex is still running.
    await vi.waitFor(() => expect(h.indexMessages).toHaveBeenCalledTimes(1));
    expect(logLines().some(l => l.includes('FTS engine initialized successfully'))).toBe(true);
    expect(logLines().some(l => l.includes('repair smart reindex finished'))).toBe(false);

    finishScan({ attachmentRepair: { repaired: 1, failedBatches: 0 } });
    await vi.waitFor(() => expect(logLines().some(l => l.includes('repair smart reindex finished'))).toBe(true));
  });

  it.each([
    ['every loaded account is repaired', () => { h.repairedAccounts = vi.fn(async () => new Set(['account1', 'account2'])); }],
    ['the only unrepaired account has no root folder', () => { h.accounts[1] = { id: 'account2' }; }],
    ['Thunderbird has not loaded the unrepaired account yet', () => { h.accounts = h.accounts.slice(0, 1); }],
    ['the initial scan has not finished', () => { h.stored = {}; }],
  ])('does not reindex when %s', async (_name, arrange) => {
    arrange();
    await startEngine();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(h.indexMessages).not.toHaveBeenCalled();
  });

  it('keeps the engine initialized when the repair reindex fails', async () => {
    h.indexMessages = vi.fn(async () => { throw new Error('scan exploded'); });
    const engine = await startEngine();

    await vi.waitFor(() => expect(logLines().some(l => l.includes('repair smart reindex failed'))).toBe(true));
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('scan exploded'), 'error');
    await expect(engine.initFtsEngine()).resolves.toBeDefined();
  });

  it('keeps the engine initialized when the repair check fails', async () => {
    h.repairedAccounts = vi.fn(async () => { throw new Error('storage gone'); });
    await startEngine();

    expect(h.indexMessages).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('Attachment flag repair check failed'), 'warn');
    expect(logLines().some(l => l.includes('FTS engine initialized successfully'))).toBe(true);
  });

  it('serves the smartReindex command through the same full reindex', async () => {
    h.repairedAccounts = vi.fn(async () => new Set(['account1', 'account2']));
    await startEngine();

    const response = await sendFts('smartReindex', { progress: true });

    expect(response).toEqual({ attachmentRepair: { repaired: 3, failedBatches: 0 } });
    expect(h.indexMessages).toHaveBeenCalledTimes(1);
    const progress = h.indexMessages.mock.calls[0][1];
    expect(typeof progress).toBe('function');
    await progress({ folder: 'Inbox', totalIndexed: 5, totalBatches: 1 });
    expect(globalThis.browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ftsProgress', folder: 'Inbox', totalIndexed: 5 }),
    );
    expect(h.logSmartReindexRun).toHaveBeenCalledTimes(1);
  });
});
