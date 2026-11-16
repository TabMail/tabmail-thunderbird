import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ initPurge: null, log: null }));

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
vi.mock('../fts/incrementalIndexer.js', () => ({ initIncrementalIndexer: vi.fn(async () => {}) }));
vi.mock('../fts/maintenanceScheduler.js', () => ({ initMaintenanceScheduler: vi.fn(async () => {}) }));
vi.mock('../fts/memoryIndexer.js', () => ({
  migrateExistingChatHistory: vi.fn(async () => ({ migrated: false })),
}));
vi.mock('../fts/attachmentFlags.js', () => ({ getAttachmentRepairedAccounts: async () => new Set() }));
vi.mock('../fts/removedAccountPurge.js', () => ({
  initRemovedAccountPurge: (...args) => h.initPurge(...args),
}));

describe('FTS engine start finishes recorded removed-account purges', () => {
  beforeEach(() => {
    h.log = vi.fn();
    h.initPurge = vi.fn(async () => {});
    globalThis.browser = {
      storage: { local: { get: vi.fn(async () => ({})) } },
      accounts: { list: vi.fn(async () => []) },
      runtime: {
        sendMessage: vi.fn(async () => {}),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
  });

  afterEach(() => {
    delete globalThis.browser;
  });

  it('hands the ready index to the purge', async () => {
    vi.resetModules();
    const engine = await import('../fts/engine.js');
    await engine.initFtsEngine();
    expect(h.initPurge).toHaveBeenCalledTimes(1);
    expect(h.initPurge.mock.calls[0][0]).toBe(engine.ftsSearch);
  });

  it('keeps the engine initialized when the purge fails', async () => {
    h.initPurge = vi.fn(async () => { throw new Error('purge exploded'); });
    vi.resetModules();
    const engine = await import('../fts/engine.js');
    await expect(engine.initFtsEngine()).resolves.toBeDefined();
    await vi.waitFor(() => expect(h.log).toHaveBeenCalledWith(expect.stringContaining('purge exploded'), 'warn'));
  });
});
