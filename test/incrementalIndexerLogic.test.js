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
  headerIDToWeID: vi.fn(),
  log: vi.fn(),
  parseUniqueId: vi.fn(),
}));

vi.mock('../fts/indexer.js', () => ({
  buildBatchHeader: vi.fn(),
  populateBatchBody: vi.fn(),
}));

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (defaults) => defaults),
      set: vi.fn(async () => {}),
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

const { _testExports } = await import('../fts/incrementalIndexer.js');
const {
  _getRetryConfig,
  _shouldDropFailedUpdates,
  _markResolveFailed,
  _resetNoProgressCounter,
  _incrementNoProgressCounter,
  _getConsecutiveNoProgressCycles,
  _setConsecutiveNoProgressCycles,
  _getPendingUpdates,
} = _testExports;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _setConsecutiveNoProgressCycles(0);
  _getPendingUpdates().clear();
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
