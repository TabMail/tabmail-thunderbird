// reminderStateStoreCrdt.test.js — Tests for CRDT functions in agent/modules/reminderStateStore.js
//
// Tests getDisabledMap, getDisabledHashes, setEnabled, mergeIncoming, gcStaleEntries
// with mocked browser.storage.local.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
  },
}));

vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));

vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

// Mock p2pSync to prevent real broadcast calls
vi.mock('../agent/modules/p2pSync.js', () => ({
  broadcastState: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Browser storage mock
// ---------------------------------------------------------------------------

const storageData = {};

function makeGetMock() {
  return async (keysOrDefault) => {
    if (Array.isArray(keysOrDefault)) {
      const result = {};
      for (const k of keysOrDefault) {
        if (storageData[k] !== undefined) result[k] = storageData[k];
      }
      return result;
    }
    if (typeof keysOrDefault === 'object') {
      const result = {};
      for (const [k, def] of Object.entries(keysOrDefault)) {
        result[k] = storageData[k] !== undefined ? storageData[k] : def;
      }
      return result;
    }
    return {};
  };
}

function makeSetMock() {
  return async (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      storageData[k] = v;
    }
  };
}

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(makeGetMock()),
      set: vi.fn(makeSetMock()),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const {
  hashReminder,
  getDisabledMap,
  getDisabledHashes,
  setEnabled,
  mergeIncoming,
  gcStaleEntries,
} = await import('../agent/modules/reminderStateStore.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function resetStorageMocks() {
  for (const key of Object.keys(storageData)) delete storageData[key];
  browser.storage.local.get.mockImplementation(makeGetMock());
  browser.storage.local.set.mockImplementation(makeSetMock());
}

describe('getDisabledMap', () => {
  beforeEach(() => {
    resetStorageMocks();
  });

  it('returns empty object when no data stored', async () => {
    const map = await getDisabledMap();
    expect(map).toEqual({});
  });

  it('returns stored v2 map', async () => {
    storageData.disabled_reminders_v2 = {
      'k:abc': { enabled: false, ts: '2025-01-01T00:00:00Z' },
    };
    const map = await getDisabledMap();
    expect(map).toEqual({
      'k:abc': { enabled: false, ts: '2025-01-01T00:00:00Z' },
    });
  });

  it('returns empty object when storage.get throws', async () => {
    // First call for migration succeeds, second call for actual get throws
    let callCount = 0;
    browser.storage.local.get.mockImplementation(async (arg) => {
      callCount++;
      // Migration call (array arg)
      if (Array.isArray(arg)) return {};
      // Actual get call - throw
      throw new Error('storage error');
    });
    const map = await getDisabledMap();
    expect(map).toEqual({});
  });
});

describe('getDisabledHashes', () => {
  beforeEach(() => {
    resetStorageMocks();
  });

  it('returns empty set when no data', async () => {
    const hashes = await getDisabledHashes();
    expect(hashes).toBeInstanceOf(Set);
    expect(hashes.size).toBe(0);
  });

  it('returns only disabled hashes (enabled=false)', async () => {
    storageData.disabled_reminders_v2 = {
      'k:abc': { enabled: false, ts: '2025-01-01T00:00:00Z' },
      'k:def': { enabled: true, ts: '2025-01-01T00:00:00Z' },
      'k:ghi': { enabled: false, ts: '2025-01-02T00:00:00Z' },
    };
    const hashes = await getDisabledHashes();
    expect(hashes.size).toBe(2);
    expect(hashes.has('k:abc')).toBe(true);
    expect(hashes.has('k:ghi')).toBe(true);
    expect(hashes.has('k:def')).toBe(false);
  });
});

describe('setEnabled', () => {
  beforeEach(() => {
    resetStorageMocks();
  });

  it('sets a hash as disabled (enabled=false)', async () => {
    await setEnabled('k:test', false);
    const map = storageData.disabled_reminders_v2;
    expect(map['k:test'].enabled).toBe(false);
    expect(typeof map['k:test'].ts).toBe('string');
  });

  it('sets a hash as enabled (tombstone)', async () => {
    await setEnabled('k:test', true);
    const map = storageData.disabled_reminders_v2;
    expect(map['k:test'].enabled).toBe(true);
  });

  it('overwrites existing entry with new timestamp', async () => {
    storageData.disabled_reminders_v2 = {
      'k:test': { enabled: false, ts: '2020-01-01T00:00:00Z' },
    };
    await setEnabled('k:test', true);
    const map = storageData.disabled_reminders_v2;
    expect(map['k:test'].enabled).toBe(true);
    expect(map['k:test'].ts).not.toBe('2020-01-01T00:00:00Z');
  });

  it('broadcasts to P2P peers after setting', async () => {
    const { broadcastState } = await import('../agent/modules/p2pSync.js');
    await setEnabled('k:test', false);
    expect(broadcastState).toHaveBeenCalledWith(['disabledReminders']);
  });
});

describe('mergeIncoming', () => {
  beforeEach(() => {
    resetStorageMocks();
  });

  it('adds new entries from incoming map', async () => {
    storageData.disabled_reminders_v2 = {};
    const incoming = {
      'k:new1': { enabled: false, ts: '2025-06-01T00:00:00Z' },
      'k:new2': { enabled: true, ts: '2025-06-01T00:00:00Z' },
    };
    await mergeIncoming(incoming);
    const map = storageData.disabled_reminders_v2;
    expect(map['k:new1']).toEqual({ enabled: false, ts: '2025-06-01T00:00:00Z' });
    expect(map['k:new2']).toEqual({ enabled: true, ts: '2025-06-01T00:00:00Z' });
  });

  it('overwrites local entry when incoming has newer timestamp', async () => {
    storageData.disabled_reminders_v2 = {
      'k:test': { enabled: false, ts: '2025-01-01T00:00:00Z' },
    };
    const incoming = {
      'k:test': { enabled: true, ts: '2025-06-01T00:00:00Z' },
    };
    await mergeIncoming(incoming);
    const map = storageData.disabled_reminders_v2;
    expect(map['k:test'].enabled).toBe(true);
    expect(map['k:test'].ts).toBe('2025-06-01T00:00:00Z');
  });

  it('keeps local entry when incoming has older timestamp', async () => {
    storageData.disabled_reminders_v2 = {
      'k:test': { enabled: true, ts: '2025-06-01T00:00:00Z' },
    };
    const incoming = {
      'k:test': { enabled: false, ts: '2025-01-01T00:00:00Z' },
    };
    await mergeIncoming(incoming);
    const map = storageData.disabled_reminders_v2;
    expect(map['k:test'].enabled).toBe(true);
    expect(map['k:test'].ts).toBe('2025-06-01T00:00:00Z');
  });

  it('skips entries with invalid structure', async () => {
    storageData.disabled_reminders_v2 = {};
    const incoming = {
      'k:valid': { enabled: false, ts: '2025-06-01T00:00:00Z' },
      'k:no_ts': { enabled: false },
      'k:no_enabled': { ts: '2025-06-01T00:00:00Z' },
      'k:null': null,
      'k:wrong_ts_type': { enabled: true, ts: 12345 },
      'k:wrong_enabled_type': { enabled: 'yes', ts: '2025-06-01T00:00:00Z' },
    };
    await mergeIncoming(incoming);
    const map = storageData.disabled_reminders_v2;
    expect(Object.keys(map)).toEqual(['k:valid']);
  });

  it('does not overwrite local entry with older incoming timestamp', async () => {
    // Set up initial state: local has newer timestamp
    await setEnabled('k:test', true);
    const localTs = storageData.disabled_reminders_v2['k:test'].ts;

    // Incoming has much older timestamp
    const incoming = {
      'k:test': { enabled: false, ts: '2020-01-01T00:00:00Z' },
    };
    await mergeIncoming(incoming);
    // Local entry should still be enabled=true with its original timestamp
    const map = storageData.disabled_reminders_v2;
    expect(map['k:test'].enabled).toBe(true);
    expect(map['k:test'].ts).toBe(localTs);
  });
});

describe('gcStaleEntries', () => {
  beforeEach(() => {
    resetStorageMocks();
  });

  it('does nothing when map is empty', async () => {
    storageData.disabled_reminders_v2 = {};
    const freshHashes = new Set();
    await gcStaleEntries(freshHashes);
    expect(storageData.disabled_reminders_v2).toEqual({});
  });

  it('keeps entries that are in the fresh set', async () => {
    storageData.disabled_reminders_v2 = {
      'k:fresh': { enabled: false, ts: '2020-01-01T00:00:00Z' },
    };
    const freshHashes = new Set(['k:fresh']);
    await gcStaleEntries(freshHashes);
    expect(storageData.disabled_reminders_v2['k:fresh']).toBeDefined();
  });

  it('removes entries not in fresh set and older than 90 days', async () => {
    // Use a very old date (1 year ago) to ensure it's definitely stale
    const oldDate = '2024-01-01T00:00:00.000Z';
    storageData.disabled_reminders_v2 = {
      'k:stale': { enabled: false, ts: oldDate },
    };
    const freshHashes = new Set();
    await gcStaleEntries(freshHashes);
    expect(storageData.disabled_reminders_v2['k:stale']).toBeUndefined();
  });

  it('keeps entries not in fresh set but newer than 90 days', async () => {
    const recentDate = new Date().toISOString();
    storageData.disabled_reminders_v2 = {
      'k:recent': { enabled: false, ts: recentDate },
    };
    const freshHashes = new Set();
    await gcStaleEntries(freshHashes);
    expect(storageData.disabled_reminders_v2['k:recent']).toBeDefined();
  });

  it('removes only stale entries and keeps fresh ones', async () => {
    const oldDate = '2024-01-01T00:00:00.000Z';
    const recentDate = new Date().toISOString();
    storageData.disabled_reminders_v2 = {
      'k:old_not_fresh': { enabled: false, ts: oldDate },
      'k:fresh_entry': { enabled: false, ts: oldDate },
      'k:recent_not_fresh': { enabled: true, ts: recentDate },
    };
    const freshHashes = new Set(['k:fresh_entry']);
    await gcStaleEntries(freshHashes);
    expect(storageData.disabled_reminders_v2['k:old_not_fresh']).toBeUndefined();
    expect(storageData.disabled_reminders_v2['k:fresh_entry']).toBeDefined();
    expect(storageData.disabled_reminders_v2['k:recent_not_fresh']).toBeDefined();
  });
});
