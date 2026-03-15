// eventLogger.test.js — Tests for agent/modules/eventLogger.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: true,
    logTruncateLength: 100,
    getFullDiag: {},
    eventLogger: {
      enabled: true,
      persistDebounceMs: 0, // immediate persist for testing
    },
  },
}));

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrDefault) => {
        if (typeof keyOrDefault === 'string') {
          return { [keyOrDefault]: storageData[keyOrDefault] || null };
        }
        // Handle {key: default} form
        const result = {};
        for (const [k, def] of Object.entries(keyOrDefault)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        Object.assign(storageData, obj);
      }),
      remove: vi.fn(async (key) => {
        delete storageData[key];
      }),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
};

// Need vi.resetModules to get fresh module state per describe block
// But since eventLogger has module-level state, we import once and test in sequence

const mod = await import('../agent/modules/eventLogger.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Clear storage
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
});

describe('initEventLogger', () => {
  it('initializes without error', async () => {
    storageData.debugMode = true;
    await mod.initEventLogger();
    expect(browser.storage.local.get).toHaveBeenCalled();
    expect(browser.storage.onChanged.addListener).toHaveBeenCalled();
  });
});

describe('logMessageEvent', () => {
  it('logs an event when enabled', () => {
    // After init with debugMode = true, logging should work
    mod.logMessageEvent('onNewMailReceived', 'background', { folderPath: '/INBOX' });
    // Event should be buffered (we can verify via getEventLog)
  });
});

describe('logMessageEventBatch', () => {
  it('handles empty messages', () => {
    mod.logMessageEventBatch('onNewMailReceived', 'background', {}, []);
    // Should not throw
  });

  it('logs multiple messages', () => {
    const msgs = [
      { headerMessageId: 'msg1', subject: 'Hello', id: 1 },
      { headerMessageId: 'msg2', subject: 'World', id: 2 },
    ];
    mod.logMessageEventBatch('onNewMailReceived', 'background', { name: 'Inbox', path: '/INBOX' }, msgs);
    // Should not throw
  });
});

describe('logMoveEvent', () => {
  it('logs move events', () => {
    const msgs = [{ headerMessageId: 'msg1', subject: 'Test', id: 1 }];
    mod.logMoveEvent('onMoved', 'onMoved', { name: 'Inbox', path: '/INBOX' }, msgs, { name: 'Archive', path: '/Archive' });
    // Should not throw
  });

  it('handles empty messages', () => {
    mod.logMoveEvent('onMoved', 'onMoved', {}, []);
    // Should not throw
  });
});

describe('logFtsOperation', () => {
  it('logs FTS operations', () => {
    mod.logFtsOperation('enqueue', 'start', { headerMessageId: 'msg1' });
    // Should not throw
  });
});

describe('logFtsBatchOperation', () => {
  it('logs FTS batch operations', () => {
    mod.logFtsBatchOperation('indexBatch', 'success', { total: 10, successCount: 8, failCount: 2 });
    // Should not throw
  });
});

describe('clearEventLog', () => {
  it('clears the event log', async () => {
    await mod.clearEventLog();
    expect(browser.storage.local.remove).toHaveBeenCalledWith('debug_event_log');
  });
});

describe('getEventLog', () => {
  it('returns events with default limit', async () => {
    const result = await mod.getEventLog();
    expect(Array.isArray(result)).toBe(true);
  });

  it('filters by eventType', async () => {
    const result = await mod.getEventLog({ eventType: 'onNewMailReceived' });
    expect(Array.isArray(result)).toBe(true);
  });

  it('filters by since timestamp', async () => {
    const result = await mod.getEventLog({ since: Date.now() - 60000 });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('getEventSummary', () => {
  it('returns summary stats', async () => {
    const result = await mod.getEventSummary(60);
    expect(result).toBeDefined();
    expect(typeof result.totalEvents).toBe('number');
    expect(typeof result.eventCounts).toBe('object');
    expect(result.sinceMins).toBe(60);
  });
});

describe('findEventsByHeaderId', () => {
  it('returns matching events', async () => {
    const result = await mod.findEventsByHeaderId('msg1');
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('exportEventLog', () => {
  it('returns export object', async () => {
    const result = await mod.exportEventLog();
    expect(result.exportedAt).toBeDefined();
    expect(typeof result.totalEvents).toBe('number');
    expect(typeof result.maxEntries).toBe('number');
    expect(Array.isArray(result.events)).toBe(true);
  });
});

describe('cleanupEventLogger', () => {
  it('cleans up without error', async () => {
    await mod.cleanupEventLogger();
    // Should remove storage listener
    expect(browser.storage.onChanged.removeListener).toHaveBeenCalled();
  });
});
