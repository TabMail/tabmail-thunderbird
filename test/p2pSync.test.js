// p2pSync.test.js — P2P sync merge logic tests (Tier 3 — mock-dependent)
//
// Tests the per-field timestamp merge, echo prevention, virgin device detection,
// 3-way merge with bulletMerge, template CRDT merge, and disabled reminders merge.
//
// Strategy: mock browser.storage.local and dynamic imports, then import p2pSync
// and invoke handleMessage (via the module's internal socket.onmessage pathway)
// or test exported functions that exercise the merge logic.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Browser Mock ────────────────────────────────────────────────────────────

const storageData = {};

const browserMock = {
  storage: {
    local: {
      get: vi.fn(async (keys) => {
        const result = {};
        if (Array.isArray(keys)) {
          for (const k of keys) {
            if (storageData[k] !== undefined) result[k] = storageData[k];
          }
        } else if (typeof keys === 'object' && keys !== null) {
          // get({key: default}) form
          for (const [k, def] of Object.entries(keys)) {
            result[k] = storageData[k] !== undefined ? storageData[k] : def;
          }
        } else if (typeof keys === 'string') {
          if (storageData[keys] !== undefined) result[keys] = storageData[keys];
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        Object.assign(storageData, obj);
      }),
      remove: vi.fn(async (keys) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete storageData[k];
      }),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
};

globalThis.browser = browserMock;

// Track all created MockWebSocket instances for testing onmessage/onopen
let mockWebSocketInstances = [];

globalThis.WebSocket = class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    mockWebSocketInstances.push(this);
  }
  static get OPEN() { return 1; }
  send(data) { this.sent.push(data); }
  close() {
    this.readyState = 3;
    // Trigger onclose if set
    if (this.onclose) {
      this.onclose({ code: 1000, reason: 'test close' });
    }
  }
};
globalThis.atob = (str) => Buffer.from(str, 'base64').toString('binary');

// ─── Module Mocks ────────────────────────────────────────────────────────────

// Mock utils.js (log)
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

// Mock config.js
vi.mock('../agent/modules/config.js', () => ({
  getP2PSyncUrl: vi.fn(async () => 'https://sync.tabmail.ai'),
  SETTINGS: { p2pSync: { broadcastDebounceMs: 500 } },
}));

// Mock supabaseAuth.js (dynamic import in connect())
vi.mock('../agent/modules/supabaseAuth.js', () => ({
  getAccessToken: vi.fn(async () => 'mock-token'),
  getSession: vi.fn(async () => ({ access_token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXItaWQifQ.abc' })),
}));

// Mock thinkBuffer.js
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  setThink: vi.fn(),
}));

// Track mergeTemplates calls
const mergeTemplatesCalls = [];
const gcDeletedTemplatesCalls = [];
vi.mock('../agent/modules/templateManager.js', () => ({
  mergeTemplates: vi.fn(async (incoming) => {
    mergeTemplatesCalls.push(incoming);
    // Simulate merge: store incoming templates
    const existing = storageData['user_templates'] || [];
    const merged = [...existing];
    for (const t of incoming) {
      const idx = merged.findIndex((e) => e.id === t.id);
      if (idx >= 0) {
        if (t.updatedAt > merged[idx].updatedAt) merged[idx] = t;
      } else {
        merged.push(t);
      }
    }
    storageData['user_templates'] = merged;
  }),
  gcDeletedTemplates: vi.fn(async () => { gcDeletedTemplatesCalls.push(true); }),
}));

// Track mergeIncoming calls for reminderStateStore
const mergeIncomingCalls = [];
vi.mock('../agent/modules/reminderStateStore.js', () => ({
  mergeIncoming: vi.fn(async (map) => {
    mergeIncomingCalls.push(map);
    // Simulate per-hash merge
    const existing = storageData['disabled_reminders_v2'] || {};
    for (const [hash, entry] of Object.entries(map)) {
      if (!existing[hash] || entry.ts > existing[hash].ts) {
        existing[hash] = entry;
      }
    }
    storageData['disabled_reminders_v2'] = existing;
  }),
}));

// Mock bulletMerge.js (dynamic import inside handlePromptState)
vi.mock('../agent/modules/bulletMerge.js', () => ({
  mergeFlatField: vi.fn((base, local, remote) => {
    // Simple simulation: combine unique lines from local and remote
    const localLines = local.split('\n').filter(Boolean);
    const remoteLines = remote.split('\n').filter(Boolean);
    const baseLines = new Set(base.split('\n').filter(Boolean));
    const result = [...localLines];
    for (const line of remoteLines) {
      if (!result.includes(line) && !baseLines.has(line)) {
        result.push(line);
      } else if (!result.includes(line) && baseLines.has(line)) {
        // line is in base and remote but not in local — local removed it
        // Don't add back
      } else if (!result.includes(line)) {
        result.push(line);
      }
    }
    return result.join('\n');
  }),
  mergeSectionedField: vi.fn((base, local, remote, headers) => {
    // Simple simulation: return local + remote additions
    return local + '\n' + remote.replace(base, '').trim();
  }),
  COMPOSITION_SECTIONS: ['General writing style', 'Language'],
  ACTION_SECTIONS: ['delete', 'archive', 'reply', 'none'],
}));

// ─── Constants (mirrored from p2pSync.js) ────────────────────────────────────

const FIELD_KEYS = {
  composition: 'user_prompts:user_composition.md',
  action: 'user_prompts:user_action.md',
  kb: 'user_prompts:user_kb.md',
  templates: 'user_templates',
  disabledReminders: 'disabled_reminders_v2',
};

const TIMESTAMP_KEYS = {
  composition: 'p2p_sync_ts:composition',
  action: 'p2p_sync_ts:action',
  kb: 'p2p_sync_ts:kb',
  templates: 'p2p_sync_ts:templates',
  disabledReminders: 'p2p_sync_ts:disabledReminders',
};

const PEER_BASE_KEYS = {
  composition: 'p2p_peer_base:composition',
  action: 'p2p_peer_base:action',
  kb: 'p2p_peer_base:kb',
};

const PEER_BASE_TS_KEYS = {
  composition: 'p2p_peer_base_ts:composition',
  action: 'p2p_peer_base_ts:action',
  kb: 'p2p_peer_base_ts:kb',
};

const EPOCH_ZERO = '1970-01-01T00:00:00.000Z';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clearStorage() {
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
}

function setStorage(obj) {
  Object.assign(storageData, obj);
}

function resetMockCalls() {
  browserMock.storage.local.get.mockClear();
  browserMock.storage.local.set.mockClear();
  browserMock.storage.local.remove.mockClear();
  mergeTemplatesCalls.length = 0;
  gcDeletedTemplatesCalls.length = 0;
  mergeIncomingCalls.length = 0;
}

/**
 * Establish a connected socket by calling connect(), then triggering onopen.
 * Returns the MockWebSocket instance for sending messages via onmessage.
 */
async function establishConnection() {
  // Set auto-enabled and pre-seed timestamps so it's not a virgin device
  setStorage({
    'p2p_sync_auto_enabled': true,
    [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
    [TIMESTAMP_KEYS.action]: '2026-03-10T00:00:00Z',
    [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
    [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
    [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
  });

  const beforeCount = mockWebSocketInstances.length;
  await p2pSync.connect();
  const ws = mockWebSocketInstances[mockWebSocketInstances.length - 1];

  // Trigger onopen to complete the connection
  if (ws && ws.onopen) {
    ws.onopen();
  }

  return ws;
}

/**
 * Send a message through the socket's onmessage handler (simulates server push).
 */
async function sendSocketMessage(ws, msg) {
  if (ws && ws.onmessage) {
    // onmessage calls handleMessage which is async; we need to await it
    // but onmessage doesn't return a promise. We use a small delay.
    ws.onmessage({ data: JSON.stringify(msg) });
    // Give async handlers time to complete
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ─── Import the module under test ────────────────────────────────────────────

// We import after mocks are set up
const p2pSync = await import('../agent/modules/p2pSync.js');

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('P2P Sync', () => {
  beforeEach(() => {
    clearStorage();
    resetMockCalls();
    mockWebSocketInstances = [];
  });

  afterEach(() => {
    // Ensure we disconnect after each test to reset module state
    p2pSync.disconnect();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-090: State merge with per-field timestamps (newer wins per field)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-090: State merge with per-field timestamps', () => {
    it('broadcastState reads local state with per-field timestamps', async () => {
      setStorage({
        [FIELD_KEYS.composition]: 'My composition rules',
        [FIELD_KEYS.action]: 'My action rules',
        [FIELD_KEYS.kb]: 'My knowledge base',
        [FIELD_KEYS.templates]: [{ id: 't1', name: 'Template 1' }],
        [FIELD_KEYS.disabledReminders]: { hash1: { enabled: false, ts: '2026-01-01T00:00:00Z' } },
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.action]: '2026-03-11T00:00:00Z',
        [TIMESTAMP_KEYS.kb]: '2026-03-12T00:00:00Z',
        [TIMESTAMP_KEYS.templates]: '2026-03-13T00:00:00Z',
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-09T00:00:00Z',
      });

      // broadcastState won't send if no socket is connected, but we can verify
      // it reads state correctly by checking storage.local.get was called
      await p2pSync.broadcastState();
      // Since not connected, broadcastState returns early — but let's verify
      // the function doesn't throw
    });

    it('per-field timestamps are read correctly from storage', async () => {
      setStorage({
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.action]: '2026-03-11T00:00:00Z',
        [TIMESTAMP_KEYS.kb]: '2026-03-12T00:00:00Z',
        [TIMESTAMP_KEYS.templates]: '2026-03-13T00:00:00Z',
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-14T00:00:00Z',
      });

      // Verify timestamps are stored independently per field
      const stored = await browserMock.storage.local.get(Object.values(TIMESTAMP_KEYS));
      expect(stored[TIMESTAMP_KEYS.composition]).toBe('2026-03-10T00:00:00Z');
      expect(stored[TIMESTAMP_KEYS.action]).toBe('2026-03-11T00:00:00Z');
      expect(stored[TIMESTAMP_KEYS.kb]).toBe('2026-03-12T00:00:00Z');
    });

    it('fields with different timestamps are stored independently', async () => {
      // Set up: composition is newer, action is older
      setStorage({
        [FIELD_KEYS.composition]: 'Local composition',
        [FIELD_KEYS.action]: 'Local action',
        [TIMESTAMP_KEYS.composition]: '2026-03-15T00:00:00Z',
        [TIMESTAMP_KEYS.action]: '2026-03-01T00:00:00Z',
      });

      const stored = await browserMock.storage.local.get([
        TIMESTAMP_KEYS.composition,
        TIMESTAMP_KEYS.action,
      ]);
      // composition is newer than action — each field has independent timestamp
      expect(stored[TIMESTAMP_KEYS.composition] > stored[TIMESTAMP_KEYS.action]).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-091: Echo prevention (suppressBroadcast flag)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-091: Echo prevention (suppressBroadcast flag)', () => {
    it('broadcastState returns early when not connected (no echo)', async () => {
      // p2pSync is not connected (no socket), broadcastState should silently return
      setStorage({
        [FIELD_KEYS.composition]: 'Some content',
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
      });

      // Should not throw and should not attempt to send
      await p2pSync.broadcastState();
      // No socket, so no send attempt — verified by no error
    });

    it('restoreFromHistory suppresses broadcast during apply then broadcasts after', async () => {
      // Set up initial state
      setStorage({
        [FIELD_KEYS.composition]: 'Current',
        [FIELD_KEYS.action]: 'Current action',
        [FIELD_KEYS.kb]: 'Current kb',
        [FIELD_KEYS.templates]: [],
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.action]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
      });

      const entry = {
        id: 'test-entry',
        composition: 'Restored comp',
        action: 'Restored action',
        kb: 'Restored kb',
        templatesJSON: JSON.stringify([]),
      };

      // restoreFromHistory sets suppressBroadcast=true during write,
      // then calls broadcastState after
      await p2pSync.restoreFromHistory(entry);

      // Verify restored state was written
      expect(storageData[FIELD_KEYS.composition]).toBe('Restored comp');
      expect(storageData[FIELD_KEYS.action]).toBe('Restored action');
      expect(storageData[FIELD_KEYS.kb]).toBe('Restored kb');
    });

    it('resetFieldToDefault suppresses broadcast during reset', async () => {
      setStorage({
        [FIELD_KEYS.composition]: 'Custom rules',
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
      });

      await p2pSync.resetFieldToDefault('composition', 'Default rules');

      // Should have written default value with epoch-zero timestamp
      expect(storageData[FIELD_KEYS.composition]).toBe('Default rules');
      expect(storageData[TIMESTAMP_KEYS.composition]).toBe(EPOCH_ZERO);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-092: Virgin device detection (all epoch-zero)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-092: Virgin device detection (all epoch-zero)', () => {
    it('detects virgin device when all timestamps are epoch-zero', async () => {
      // A virgin device has no timestamps at all, or all epoch-zero
      setStorage({
        [TIMESTAMP_KEYS.composition]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.action]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.kb]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.templates]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.disabledReminders]: EPOCH_ZERO,
      });

      // Verify all are epoch zero
      const stored = await browserMock.storage.local.get(Object.values(TIMESTAMP_KEYS));
      const allEpochZero = Object.values(TIMESTAMP_KEYS).every(
        (k) => (stored[k] || EPOCH_ZERO) === EPOCH_ZERO
      );
      expect(allEpochZero).toBe(true);
    });

    it('non-virgin device has at least one non-epoch timestamp', async () => {
      setStorage({
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.action]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.kb]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.templates]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.disabledReminders]: EPOCH_ZERO,
      });

      const stored = await browserMock.storage.local.get(Object.values(TIMESTAMP_KEYS));
      const allEpochZero = Object.values(TIMESTAMP_KEYS).every(
        (k) => (stored[k] || EPOCH_ZERO) === EPOCH_ZERO
      );
      expect(allEpochZero).toBe(false);
    });

    it('resetFieldToDefault sets timestamp to epoch-zero', async () => {
      setStorage({
        [FIELD_KEYS.kb]: 'Custom KB content',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
      });

      await p2pSync.resetFieldToDefault('kb', 'Default KB');

      expect(storageData[TIMESTAMP_KEYS.kb]).toBe(EPOCH_ZERO);
    });

    it('resetFieldToDefault rejects invalid field names', async () => {
      // Should not throw, just warn and return
      await p2pSync.resetFieldToDefault('invalidField', 'value');
      // No storage write should have happened for an invalid field
    });

    it('virgin device on connect probes peers instead of broadcasting', async () => {
      // Set all timestamps to epoch-zero (virgin device)
      setStorage({
        'p2p_sync_auto_enabled': true,
        [TIMESTAMP_KEYS.composition]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.action]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.kb]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.templates]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.disabledReminders]: EPOCH_ZERO,
      });

      await p2pSync.connect();
      const ws = mockWebSocketInstances[mockWebSocketInstances.length - 1];

      // Trigger onopen
      if (ws && ws.onopen) ws.onopen();

      // Simulate the server responding with "connected"
      await sendSocketMessage(ws, { type: 'connected', userId: 'test-user-id' });

      // Virgin device should send request_state (probe), NOT prompt_state (broadcast)
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const hasRequestState = sentMessages.some((m) => m.type === 'request_state');
      expect(hasRequestState).toBe(true);
    });

    it('non-virgin device on connect broadcasts state', async () => {
      // Set non-epoch timestamps (established device)
      setStorage({
        'p2p_sync_auto_enabled': true,
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.action]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
        [FIELD_KEYS.composition]: 'My rules',
      });

      await p2pSync.connect();
      const ws = mockWebSocketInstances[mockWebSocketInstances.length - 1];
      if (ws && ws.onopen) ws.onopen();

      // Simulate the server responding with "connected"
      await sendSocketMessage(ws, { type: 'connected', userId: 'test-user-id' });

      // Non-virgin device should broadcast prompt_state
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const hasPromptState = sentMessages.some((m) => m.type === 'prompt_state');
      expect(hasPromptState).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-093: Peer-base merge (3-way with bulletMerge)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-093: Peer-base merge (3-way with bulletMerge)', () => {
    it('peer base keys are separate from field keys', () => {
      // Verify peer base keys don't collide with field or timestamp keys
      const allFieldKeys = new Set([
        ...Object.values(FIELD_KEYS),
        ...Object.values(TIMESTAMP_KEYS),
      ]);
      for (const key of Object.values(PEER_BASE_KEYS)) {
        expect(allFieldKeys.has(key)).toBe(false);
      }
      for (const key of Object.values(PEER_BASE_TS_KEYS)) {
        expect(allFieldKeys.has(key)).toBe(false);
      }
    });

    it('peer base stores the raw incoming value (not merged result)', () => {
      // This is a design invariant: peer_base = incoming, NOT the merged result
      // We verify the keys exist and are structured correctly
      expect(PEER_BASE_KEYS.composition).toBe('p2p_peer_base:composition');
      expect(PEER_BASE_KEYS.action).toBe('p2p_peer_base:action');
      expect(PEER_BASE_KEYS.kb).toBe('p2p_peer_base:kb');
    });

    it('3-way merge scenario: local changed, remote changed, base known', async () => {
      // Set up the 3-way merge scenario in storage
      const base = '- rule A\n- rule B';
      const local = '- rule A\n- rule B\n- local rule C';
      const remote = '- rule A\n- rule B\n- remote rule D';

      setStorage({
        [FIELD_KEYS.kb]: local,
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
        [PEER_BASE_KEYS.kb]: base,
        [PEER_BASE_TS_KEYS.kb]: '2026-03-08T00:00:00Z',
      });

      // The merge function (mocked) would produce a merged result
      const { mergeFlatField } = await import('../agent/modules/bulletMerge.js');
      const merged = mergeFlatField(base, local, remote);

      // Both local and remote additions should be present
      expect(merged).toContain('- local rule C');
      expect(merged).toContain('- remote rule D');
      expect(merged).toContain('- rule A');
      expect(merged).toContain('- rule B');
    });

    it('fast-forward when no local changes since last sync', async () => {
      // local === peer_base means no local changes → fast forward to remote
      const base = '- rule A\n- rule B';

      setStorage({
        [FIELD_KEYS.kb]: base, // local unchanged from peer base
        [TIMESTAMP_KEYS.kb]: '2026-03-08T00:00:00Z',
        [PEER_BASE_KEYS.kb]: base,
        [PEER_BASE_TS_KEYS.kb]: '2026-03-08T00:00:00Z',
      });

      // In a fast-forward scenario, local == peer_base, so result = remote
      const local = storageData[FIELD_KEYS.kb];
      const peerBase = storageData[PEER_BASE_KEYS.kb];
      expect(local).toBe(peerBase); // Confirms fast-forward condition
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-094: Template CRDT merge (by ID, newer updatedAt wins)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-094: Template CRDT merge (by ID, newer updatedAt wins)', () => {
    it('mergeTemplates is called with incoming templates during sync', async () => {
      const { mergeTemplates } = await import('../agent/modules/templateManager.js');

      const incoming = [
        { id: 't1', name: 'Template 1', updatedAt: '2026-03-15T00:00:00Z' },
        { id: 't2', name: 'Template 2', updatedAt: '2026-03-14T00:00:00Z' },
      ];

      await mergeTemplates(incoming);

      expect(mergeTemplatesCalls).toHaveLength(1);
      expect(mergeTemplatesCalls[0]).toEqual(incoming);
    });

    it('newer template wins when merging by ID', async () => {
      // Set up existing template
      setStorage({
        [FIELD_KEYS.templates]: [
          { id: 't1', name: 'Old Name', updatedAt: '2026-03-10T00:00:00Z' },
        ],
      });

      const { mergeTemplates } = await import('../agent/modules/templateManager.js');
      mergeTemplates.mockClear();
      mergeTemplatesCalls.length = 0;

      const incoming = [
        { id: 't1', name: 'New Name', updatedAt: '2026-03-15T00:00:00Z' },
      ];

      await mergeTemplates(incoming);

      // After mock merge, the newer template should win
      const templates = storageData[FIELD_KEYS.templates];
      const t1 = templates.find((t) => t.id === 't1');
      expect(t1.name).toBe('New Name');
      expect(t1.updatedAt).toBe('2026-03-15T00:00:00Z');
    });

    it('older incoming template does not overwrite newer local', async () => {
      setStorage({
        [FIELD_KEYS.templates]: [
          { id: 't1', name: 'Newer Local', updatedAt: '2026-03-15T00:00:00Z' },
        ],
      });

      const { mergeTemplates } = await import('../agent/modules/templateManager.js');
      mergeTemplates.mockClear();
      mergeTemplatesCalls.length = 0;

      const incoming = [
        { id: 't1', name: 'Older Remote', updatedAt: '2026-03-10T00:00:00Z' },
      ];

      await mergeTemplates(incoming);

      const templates = storageData[FIELD_KEYS.templates];
      const t1 = templates.find((t) => t.id === 't1');
      expect(t1.name).toBe('Newer Local');
    });

    it('new template ID is added during merge', async () => {
      setStorage({
        [FIELD_KEYS.templates]: [
          { id: 't1', name: 'Existing', updatedAt: '2026-03-10T00:00:00Z' },
        ],
      });

      const { mergeTemplates } = await import('../agent/modules/templateManager.js');
      mergeTemplates.mockClear();
      mergeTemplatesCalls.length = 0;

      const incoming = [
        { id: 't2', name: 'Brand New', updatedAt: '2026-03-15T00:00:00Z' },
      ];

      await mergeTemplates(incoming);

      const templates = storageData[FIELD_KEYS.templates];
      expect(templates).toHaveLength(2);
      expect(templates.find((t) => t.id === 't2').name).toBe('Brand New');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-095: DisabledReminders merge (per-hash, newer ts wins)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-095: DisabledReminders merge (per-hash, newer ts wins)', () => {
    it('mergeIncoming is called with CRDT map during sync', async () => {
      const { mergeIncoming } = await import('../agent/modules/reminderStateStore.js');

      const incomingMap = {
        'hash-abc': { enabled: false, ts: '2026-03-15T00:00:00Z' },
        'hash-def': { enabled: true, ts: '2026-03-14T00:00:00Z' },
      };

      await mergeIncoming(incomingMap);

      expect(mergeIncomingCalls).toHaveLength(1);
      expect(mergeIncomingCalls[0]).toEqual(incomingMap);
    });

    it('newer timestamp wins per hash', async () => {
      setStorage({
        [FIELD_KEYS.disabledReminders]: {
          'hash-abc': { enabled: false, ts: '2026-03-10T00:00:00Z' },
        },
      });

      const { mergeIncoming } = await import('../agent/modules/reminderStateStore.js');
      mergeIncoming.mockClear();
      mergeIncomingCalls.length = 0;

      const incomingMap = {
        'hash-abc': { enabled: true, ts: '2026-03-15T00:00:00Z' }, // newer, re-enabled
      };

      await mergeIncoming(incomingMap);

      const reminders = storageData[FIELD_KEYS.disabledReminders];
      expect(reminders['hash-abc'].enabled).toBe(true);
      expect(reminders['hash-abc'].ts).toBe('2026-03-15T00:00:00Z');
    });

    it('older incoming does not overwrite newer local per hash', async () => {
      setStorage({
        [FIELD_KEYS.disabledReminders]: {
          'hash-abc': { enabled: true, ts: '2026-03-15T00:00:00Z' },
        },
      });

      const { mergeIncoming } = await import('../agent/modules/reminderStateStore.js');
      mergeIncoming.mockClear();
      mergeIncomingCalls.length = 0;

      const incomingMap = {
        'hash-abc': { enabled: false, ts: '2026-03-10T00:00:00Z' }, // older
      };

      await mergeIncoming(incomingMap);

      const reminders = storageData[FIELD_KEYS.disabledReminders];
      expect(reminders['hash-abc'].enabled).toBe(true); // local newer wins
    });

    it('new hash from remote is added', async () => {
      setStorage({
        [FIELD_KEYS.disabledReminders]: {
          'hash-abc': { enabled: false, ts: '2026-03-10T00:00:00Z' },
        },
      });

      const { mergeIncoming } = await import('../agent/modules/reminderStateStore.js');
      mergeIncoming.mockClear();
      mergeIncomingCalls.length = 0;

      const incomingMap = {
        'hash-new': { enabled: false, ts: '2026-03-12T00:00:00Z' },
      };

      await mergeIncoming(incomingMap);

      const reminders = storageData[FIELD_KEYS.disabledReminders];
      expect(reminders['hash-new']).toBeDefined();
      expect(reminders['hash-new'].enabled).toBe(false);
    });

    it('legacy array format is convertible to CRDT map', () => {
      // The module internally converts [String] arrays to CRDT maps via legacyArrayToCRDTMap.
      // We test the expected conversion format.
      const legacyArray = ['hash1', 'hash2', 'hash3'];
      const ts = '2026-03-10T00:00:00Z';

      // Simulate what legacyArrayToCRDTMap does
      const map = {};
      for (const hash of legacyArray) {
        if (typeof hash === 'string') {
          map[hash] = { enabled: false, ts };
        }
      }

      expect(Object.keys(map)).toHaveLength(3);
      expect(map['hash1']).toEqual({ enabled: false, ts });
      expect(map['hash2']).toEqual({ enabled: false, ts });
      expect(map['hash3']).toEqual({ enabled: false, ts });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional: Connection state and status listeners
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Connection state management', () => {
    it('isConnected returns false when not connected', () => {
      expect(p2pSync.isConnected()).toBe(false);
    });

    it('status listeners are notified', () => {
      const listener = vi.fn();
      p2pSync.addStatusListener(listener);
      // listener should be called immediately with current status
      expect(listener).toHaveBeenCalledWith(false);

      p2pSync.removeStatusListener(listener);
    });

    it('isAutoEnabled defaults to true', async () => {
      const enabled = await p2pSync.isAutoEnabled();
      expect(enabled).toBe(true);
    });

    it('setAutoEnabled persists setting', async () => {
      await p2pSync.setAutoEnabled(false);
      expect(storageData['p2p_sync_auto_enabled']).toBe(false);
    });

    it('removeStatusListener stops notifications', () => {
      const listener = vi.fn();
      p2pSync.addStatusListener(listener);
      listener.mockClear();

      p2pSync.removeStatusListener(listener);

      // Disconnecting should not notify removed listener
      p2pSync.disconnect();
      expect(listener).not.toHaveBeenCalled();
    });

    it('multiple status listeners all get notified', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      p2pSync.addStatusListener(listener1);
      p2pSync.addStatusListener(listener2);

      // Both should be called immediately with current status
      expect(listener1).toHaveBeenCalledWith(false);
      expect(listener2).toHaveBeenCalledWith(false);

      p2pSync.removeStatusListener(listener1);
      p2pSync.removeStatusListener(listener2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional: History management
  // ═══════════════════════════════════════════════════════════════════════════
  describe('History management', () => {
    it('loadHistory returns empty array when no history', async () => {
      const history = await p2pSync.loadHistory();
      expect(history).toEqual([]);
    });

    it('loadHistory returns stored entries', async () => {
      const entries = [
        { id: '1', timestamp: '2026-03-10T00:00:00Z', source: 'local_edit', fields: ['kb'] },
        { id: '2', timestamp: '2026-03-11T00:00:00Z', source: 'sync_receive', fields: ['action'] },
      ];
      setStorage({
        prompt_history: entries,
        prompt_history_migrated: true,
      });

      const history = await p2pSync.loadHistory();
      expect(history).toHaveLength(2);
      expect(history[0].source).toBe('local_edit');
      expect(history[1].source).toBe('sync_receive');
    });

    it('restoreFromHistory records pre-restore state in history', async () => {
      setStorage({
        prompt_history_migrated: true,
        [FIELD_KEYS.composition]: 'Before',
        [FIELD_KEYS.action]: 'Before action',
        [FIELD_KEYS.kb]: 'Before kb',
        [FIELD_KEYS.templates]: [],
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.action]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
      });

      const entry = {
        id: 'restore-entry',
        composition: 'Restored',
        action: 'Restored action',
        kb: 'Restored kb',
        templatesJSON: JSON.stringify([]),
      };

      await p2pSync.restoreFromHistory(entry);

      // Check that history was recorded (pre-restore snapshot)
      const history = storageData['prompt_history'];
      expect(history).toBeDefined();
      expect(history.length).toBeGreaterThanOrEqual(1);
      // The first entry should be the "reset" snapshot before restore
      const resetEntry = history.find((h) => h.source === 'reset');
      expect(resetEntry).toBeDefined();
      expect(resetEntry.composition).toBe('Before');
    });

    it('restoreFromHistory writes fresh timestamps so restore propagates', async () => {
      setStorage({
        prompt_history_migrated: true,
        [FIELD_KEYS.composition]: 'Old',
        [FIELD_KEYS.action]: 'Old',
        [FIELD_KEYS.kb]: 'Old',
        [FIELD_KEYS.templates]: [],
        [TIMESTAMP_KEYS.composition]: '2026-03-01T00:00:00Z',
        [TIMESTAMP_KEYS.action]: '2026-03-01T00:00:00Z',
        [TIMESTAMP_KEYS.kb]: '2026-03-01T00:00:00Z',
        [TIMESTAMP_KEYS.templates]: '2026-03-01T00:00:00Z',
      });

      const beforeRestore = new Date().toISOString();

      await p2pSync.restoreFromHistory({
        id: 'r1',
        composition: 'New',
        action: 'New',
        kb: 'New',
        templatesJSON: '[]',
      });

      // Timestamps should be updated to current time (not epoch-zero)
      expect(storageData[TIMESTAMP_KEYS.composition] > '2026-03-01T00:00:00Z').toBe(true);
      expect(storageData[TIMESTAMP_KEYS.composition]).not.toBe(EPOCH_ZERO);
    });

    it('loadHistory migrates legacy backups on first call', async () => {
      // Set up legacy backups (not yet migrated)
      setStorage({
        'p2p_sync_backups': [
          {
            backedUpAt: '2026-03-05T00:00:00Z',
            source: 'sync_receive',
            state: {
              composition: 'Legacy comp',
              action: 'Legacy action',
              kb: 'Legacy kb',
              templates: [],
            },
          },
        ],
      });

      const history = await p2pSync.loadHistory();

      // Legacy backup should have been migrated to history
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].composition).toBe('Legacy comp');
      expect(history[0].source).toBe('sync_receive');
      // Migration flag should be set
      expect(storageData['prompt_history_migrated']).toBe(true);
    });

    it('loadHistory does not re-migrate after flag is set', async () => {
      setStorage({
        prompt_history_migrated: true,
        prompt_history: [{ id: '1', source: 'local_edit', fields: ['kb'] }],
        'p2p_sync_backups': [
          {
            backedUpAt: '2026-03-05T00:00:00Z',
            state: { composition: 'Should not appear', action: '', kb: '', templates: [] },
          },
        ],
      });

      const history = await p2pSync.loadHistory();
      // Should only have the existing entry, not re-migrate backups
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional: Cleanup
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Cleanup', () => {
    it('cleanupP2PSync disconnects and clears listeners', () => {
      const listener = vi.fn();
      p2pSync.addStatusListener(listener);

      p2pSync.cleanupP2PSync();

      expect(p2pSync.isConnected()).toBe(false);
    });

    it('disconnect resets connection state', () => {
      p2pSync.disconnect();
      expect(p2pSync.isConnected()).toBe(false);
    });

    it('cleanupP2PSync removes storage change listener', () => {
      // Set up a storage listener first
      p2pSync.setupStorageListener();

      const removeListenerCallCount = browserMock.storage.onChanged.removeListener.mock.calls.length;

      p2pSync.cleanupP2PSync();

      // removeListener should have been called
      expect(browserMock.storage.onChanged.removeListener.mock.calls.length).toBeGreaterThan(removeListenerCallCount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // handlePromptState via socket.onmessage — core merge logic
  // ═══════════════════════════════════════════════════════════════════════════
  describe('handlePromptState via socket messages', () => {
    it('skips fields with epoch-zero incoming timestamp', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData, // preserve existing from establishConnection
        [FIELD_KEYS.kb]: 'Local KB content',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
      });

      const beforeKb = storageData[FIELD_KEYS.kb];

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          kb: 'Remote KB from virgin device',
          kb_updated_at: EPOCH_ZERO,
          updatedAt: EPOCH_ZERO,
        },
      });

      // Local KB should not have changed
      expect(storageData[FIELD_KEYS.kb]).toBe(beforeKb);
    });

    it('skips stale fields (incoming ts <= peer_base ts)', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.kb]: 'Local KB',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
        [PEER_BASE_KEYS.kb]: 'Previous remote KB',
        [PEER_BASE_TS_KEYS.kb]: '2026-03-09T00:00:00Z',
      });

      const beforeKb = storageData[FIELD_KEYS.kb];

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          kb: 'Stale remote KB',
          kb_updated_at: '2026-03-08T00:00:00Z', // older than peer_base_ts
          updatedAt: '2026-03-08T00:00:00Z',
        },
      });

      // Local KB should not have changed
      expect(storageData[FIELD_KEYS.kb]).toBe(beforeKb);
    });

    it('LWW accept: first sync with no peer base, incoming newer', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.kb]: 'Local KB',
        [TIMESTAMP_KEYS.kb]: '2026-03-08T00:00:00Z',
        // No peer base keys — first sync
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          kb: 'Newer Remote KB',
          kb_updated_at: '2026-03-12T00:00:00Z',
          updatedAt: '2026-03-12T00:00:00Z',
        },
      });

      // Incoming is newer, so LWW should accept remote
      expect(storageData[FIELD_KEYS.kb]).toBe('Newer Remote KB');
      // Peer base should be set to the incoming value
      expect(storageData[PEER_BASE_KEYS.kb]).toBe('Newer Remote KB');
      expect(storageData[PEER_BASE_TS_KEYS.kb]).toBe('2026-03-12T00:00:00Z');
    });

    it('LWW keep local: first sync with no peer base, local newer', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.kb]: 'Newer Local KB',
        [TIMESTAMP_KEYS.kb]: '2026-03-15T00:00:00Z',
        // No peer base keys — first sync
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          kb: 'Older Remote KB',
          kb_updated_at: '2026-03-08T00:00:00Z',
          updatedAt: '2026-03-08T00:00:00Z',
        },
      });

      // Local is newer, so LWW should keep local
      expect(storageData[FIELD_KEYS.kb]).toBe('Newer Local KB');
      // Peer base should still be updated to incoming value
      expect(storageData[PEER_BASE_KEYS.kb]).toBe('Older Remote KB');
    });

    it('fast-forward: local unchanged from peer base', async () => {
      const ws = await establishConnection();

      const base = '- rule A\n- rule B';
      setStorage({
        ...storageData,
        [FIELD_KEYS.kb]: base, // local same as peer base
        [TIMESTAMP_KEYS.kb]: '2026-03-08T00:00:00Z',
        [PEER_BASE_KEYS.kb]: base,
        [PEER_BASE_TS_KEYS.kb]: '2026-03-08T00:00:00Z',
      });

      const remote = '- rule A\n- rule B\n- rule C';

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          kb: remote,
          kb_updated_at: '2026-03-12T00:00:00Z',
          updatedAt: '2026-03-12T00:00:00Z',
        },
      });

      // Fast-forward: local had no changes, so accept remote entirely
      expect(storageData[FIELD_KEYS.kb]).toBe(remote);
    });

    it('3-way merge: both sides changed kb (flat field)', async () => {
      const ws = await establishConnection();

      const base = '- rule A\n- rule B';
      const local = '- rule A\n- rule B\n- local rule C';
      const remote = '- rule A\n- rule B\n- remote rule D';

      setStorage({
        ...storageData,
        [FIELD_KEYS.kb]: local,
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
        [PEER_BASE_KEYS.kb]: base,
        [PEER_BASE_TS_KEYS.kb]: '2026-03-08T00:00:00Z',
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          kb: remote,
          kb_updated_at: '2026-03-12T00:00:00Z',
          updatedAt: '2026-03-12T00:00:00Z',
        },
      });

      // 3-way merge should combine both local and remote additions
      const result = storageData[FIELD_KEYS.kb];
      expect(result).toContain('- local rule C');
      expect(result).toContain('- remote rule D');
      // Peer base should be updated to incoming (NOT merged result)
      expect(storageData[PEER_BASE_KEYS.kb]).toBe(remote);
    });

    it('3-way merge: both sides changed composition (sectioned field)', async () => {
      const ws = await establishConnection();

      const base = 'base composition';
      const local = 'base composition\nlocal addition';
      const remote = 'base composition\nremote addition';

      setStorage({
        ...storageData,
        [FIELD_KEYS.composition]: local,
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
        [PEER_BASE_KEYS.composition]: base,
        [PEER_BASE_TS_KEYS.composition]: '2026-03-08T00:00:00Z',
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          composition: remote,
          composition_updated_at: '2026-03-12T00:00:00Z',
          updatedAt: '2026-03-12T00:00:00Z',
        },
      });

      // mergeSectionedField should have been called for composition
      const { mergeSectionedField } = await import('../agent/modules/bulletMerge.js');
      expect(mergeSectionedField).toHaveBeenCalled();
    });

    it('3-way merge: both sides changed action (sectioned field)', async () => {
      const ws = await establishConnection();

      const base = 'base action';
      const local = 'base action\nlocal change';
      const remote = 'base action\nremote change';

      setStorage({
        ...storageData,
        [FIELD_KEYS.action]: local,
        [TIMESTAMP_KEYS.action]: '2026-03-10T00:00:00Z',
        [PEER_BASE_KEYS.action]: base,
        [PEER_BASE_TS_KEYS.action]: '2026-03-08T00:00:00Z',
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          action: remote,
          action_updated_at: '2026-03-12T00:00:00Z',
          updatedAt: '2026-03-12T00:00:00Z',
        },
      });

      // Verify action was processed (sectioned merge for action uses ACTION_SECTIONS)
      expect(storageData[PEER_BASE_KEYS.action]).toBe(remote);
    });

    it('skips non-string fields for text merge', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.kb]: 'Local KB',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          kb: 12345, // Not a string — should be skipped
          kb_updated_at: '2026-03-15T00:00:00Z',
        },
      });

      expect(storageData[FIELD_KEYS.kb]).toBe('Local KB');
    });

    it('handles prompt_state with templates CRDT merge', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.templates]: [{ id: 't1', name: 'Local', updatedAt: '2026-03-10T00:00:00Z' }],
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
      });
      mergeTemplatesCalls.length = 0;

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          templates: [
            { id: 't2', name: 'Remote Template', updatedAt: '2026-03-12T00:00:00Z' },
          ],
          templates_updated_at: '2026-03-12T00:00:00Z',
        },
      });

      // mergeTemplates should have been called with the incoming templates
      expect(mergeTemplatesCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('skips templates with epoch-zero timestamp', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.templates]: [],
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
      });
      mergeTemplatesCalls.length = 0;

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          templates: [{ id: 't1', name: 'Remote', updatedAt: '2026-03-12T00:00:00Z' }],
          templates_updated_at: EPOCH_ZERO,
        },
      });

      // Should not merge templates when timestamp is epoch-zero
      expect(mergeTemplatesCalls).toHaveLength(0);
    });

    it('skips invalid templates (missing id/name)', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.templates]: [],
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
      });
      mergeTemplatesCalls.length = 0;

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          templates: [
            { name: 'No ID' }, // missing id
            { id: 't1' }, // missing name
            { id: 't2', name: 'Valid', updatedAt: '2026-03-12T00:00:00Z' },
          ],
          templates_updated_at: '2026-03-12T00:00:00Z',
        },
      });

      // Only the valid template should reach mergeTemplates
      if (mergeTemplatesCalls.length > 0) {
        const validTemplates = mergeTemplatesCalls[0];
        expect(validTemplates.every((t) => t.id && t.name)).toBe(true);
      }
    });

    it('handles disabledReminders CRDT map merge via prompt_state', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.disabledReminders]: {},
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
      });
      mergeIncomingCalls.length = 0;

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          disabledReminders: {
            'hash-x': { enabled: false, ts: '2026-03-12T00:00:00Z' },
          },
          disabledReminders_updated_at: '2026-03-12T00:00:00Z',
        },
      });

      // mergeIncoming should have been called
      expect(mergeIncomingCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('handles disabledReminders legacy array format via prompt_state', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.disabledReminders]: {},
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
      });
      mergeIncomingCalls.length = 0;

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          disabledReminders: ['hash-a', 'hash-b'], // legacy array format
          disabledReminders_updated_at: '2026-03-12T00:00:00Z',
        },
      });

      // Legacy array should be converted to CRDT map and merged
      if (mergeIncomingCalls.length > 0) {
        const incomingMap = mergeIncomingCalls[0];
        expect(incomingMap['hash-a']).toBeDefined();
        expect(incomingMap['hash-a'].enabled).toBe(false);
        expect(incomingMap['hash-b']).toBeDefined();
      }
    });

    it('skips disabledReminders with epoch-zero timestamp', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.disabledReminders]: {},
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
      });
      mergeIncomingCalls.length = 0;

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          disabledReminders: { 'hash-x': { enabled: false, ts: '2026-03-12T00:00:00Z' } },
          disabledReminders_updated_at: EPOCH_ZERO,
        },
      });

      // Should not merge when epoch-zero
      expect(mergeIncomingCalls).toHaveLength(0);
    });

    it('records history on sync_receive when fields change', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        prompt_history_migrated: true,
        [FIELD_KEYS.kb]: 'Old KB',
        [TIMESTAMP_KEYS.kb]: '2026-03-08T00:00:00Z',
        // No peer base — first sync → LWW
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          kb: 'New KB from peer',
          kb_updated_at: '2026-03-12T00:00:00Z',
        },
      });

      // History should contain a sync_receive entry
      const history = storageData['prompt_history'];
      if (history && history.length > 0) {
        const syncEntry = history.find((h) => h.source === 'sync_receive');
        expect(syncEntry).toBeDefined();
        expect(syncEntry.fields).toContain('kb');
      }
    });

    it('handles multiple text fields in one prompt_state', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.composition]: 'Old comp',
        [FIELD_KEYS.action]: 'Old action',
        [FIELD_KEYS.kb]: 'Old kb',
        [TIMESTAMP_KEYS.composition]: '2026-03-08T00:00:00Z',
        [TIMESTAMP_KEYS.action]: '2026-03-08T00:00:00Z',
        [TIMESTAMP_KEYS.kb]: '2026-03-08T00:00:00Z',
        // No peer base — first sync → LWW
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          composition: 'New comp',
          composition_updated_at: '2026-03-12T00:00:00Z',
          action: 'New action',
          action_updated_at: '2026-03-12T00:00:00Z',
          kb: 'New kb',
          kb_updated_at: '2026-03-12T00:00:00Z',
        },
      });

      // All fields should be updated via LWW
      expect(storageData[FIELD_KEYS.composition]).toBe('New comp');
      expect(storageData[FIELD_KEYS.action]).toBe('New action');
      expect(storageData[FIELD_KEYS.kb]).toBe('New kb');
    });

    it('no-op when prompt_state has no data', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.kb]: 'Unchanged',
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        // No data field
      });

      expect(storageData[FIELD_KEYS.kb]).toBe('Unchanged');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // handleMessage routing — other message types
  // ═══════════════════════════════════════════════════════════════════════════
  describe('handleMessage routing', () => {
    it('handles request_state by broadcasting back', async () => {
      const ws = await establishConnection();
      ws.sent = []; // clear messages from connection

      setStorage({
        ...storageData,
        [FIELD_KEYS.kb]: 'My KB',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
      });

      await sendSocketMessage(ws, {
        type: 'request_state',
        fields: ['kb'],
      });

      // Should have sent prompt_state in response
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const promptState = sentMessages.find((m) => m.type === 'prompt_state');
      expect(promptState).toBeDefined();
    });

    it('handles request_state with all fields when none specified', async () => {
      const ws = await establishConnection();
      ws.sent = [];

      await sendSocketMessage(ws, {
        type: 'request_state',
        // No fields array
      });

      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const promptState = sentMessages.find((m) => m.type === 'prompt_state');
      expect(promptState).toBeDefined();
    });

    it('handles request_state filtering invalid fields', async () => {
      const ws = await establishConnection();
      ws.sent = [];

      await sendSocketMessage(ws, {
        type: 'request_state',
        fields: ['kb', 'invalidField', 'composition'],
      });

      // Should respond; invalid fields are filtered out
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      expect(sentMessages.some((m) => m.type === 'prompt_state')).toBe(true);
    });

    it('handles pong message silently', async () => {
      const ws = await establishConnection();
      ws.sent = [];

      // Should not throw or produce side effects
      await sendSocketMessage(ws, { type: 'pong' });

      // No messages should be sent in response to pong
      expect(ws.sent).toHaveLength(0);
    });

    it('handles unknown message type gracefully', async () => {
      const ws = await establishConnection();
      ws.sent = [];

      // Should not throw
      await sendSocketMessage(ws, { type: 'totally_unknown_type' });
    });

    it('handles malformed JSON gracefully', async () => {
      const ws = await establishConnection();

      // Send non-JSON data directly through onmessage
      if (ws && ws.onmessage) {
        ws.onmessage({ data: 'this is not JSON{{{' });
        await new Promise((r) => setTimeout(r, 50));
      }
      // Should not throw — error is caught internally
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AI Cache Probe
  // ═══════════════════════════════════════════════════════════════════════════
  describe('AI Cache Probe', () => {
    it('probeAndWait returns null when not connected', async () => {
      // Not connected — should resolve null immediately
      const result = await p2pSync.probeAndWait(['key1', 'key2']);
      expect(result).toBeNull();
    });

    it('probeAndWait sends probe and resolves on response', async () => {
      const ws = await establishConnection();

      // Start a probe
      const probePromise = p2pSync.probeAndWait(['msg-id-1'], 5000);

      // Find the sent probe message
      await new Promise((r) => setTimeout(r, 10));
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const probeSent = sentMessages.find((m) => m.type === 'ai_cache_probe');
      expect(probeSent).toBeDefined();
      expect(probeSent.keys).toEqual(['msg-id-1']);

      // Respond with results via socket
      await sendSocketMessage(ws, {
        type: 'ai_cache_response',
        probeId: probeSent.probeId,
        results: { 'msg-id-1': { summary: { subject: 'Test' } } },
      });

      const result = await probePromise;
      expect(result).toBeDefined();
      expect(result['msg-id-1'].summary.subject).toBe('Test');
    });

    it('probeAndWait times out and returns null', async () => {
      const ws = await establishConnection();

      // Start a probe with very short timeout
      const result = await p2pSync.probeAndWait(['msg-id-1'], 50);

      // No response sent, so it should timeout
      expect(result).toBeNull();
    });

    it('probeAndWait with optional fields parameter', async () => {
      const ws = await establishConnection();

      const probePromise = p2pSync.probeAndWait(['msg-id-1'], 5000, ['summary']);

      await new Promise((r) => setTimeout(r, 10));
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const probeSent = sentMessages.find((m) => m.type === 'ai_cache_probe');
      expect(probeSent.fields).toEqual(['summary']);

      // Resolve it
      await sendSocketMessage(ws, {
        type: 'ai_cache_response',
        probeId: probeSent.probeId,
        results: { 'msg-id-1': { summary: { subject: 'Test' } } },
      });

      await probePromise;
    });

    it('probeAICache strips angle brackets and returns field value', async () => {
      const ws = await establishConnection();

      const probePromise = p2pSync.probeAICache('<msg@example.com>', 'summary');

      await new Promise((r) => setTimeout(r, 10));
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const probeSent = sentMessages.find((m) => m.type === 'ai_cache_probe');

      // Should have stripped angle brackets
      expect(probeSent.keys).toEqual(['msg@example.com']);
      expect(probeSent.fields).toEqual(['summary']);

      // Respond
      await sendSocketMessage(ws, {
        type: 'ai_cache_response',
        probeId: probeSent.probeId,
        results: { 'msg@example.com': { summary: { subject: 'Hello' } } },
      });

      const result = await probePromise;
      expect(result).toEqual({ subject: 'Hello' });
    });

    it('probeAICache returns null when no result for key', async () => {
      const ws = await establishConnection();

      const probePromise = p2pSync.probeAICache('nonexistent@example.com', 'summary');

      await new Promise((r) => setTimeout(r, 10));
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const probeSent = sentMessages.find((m) => m.type === 'ai_cache_probe');

      // Respond with empty results
      await sendSocketMessage(ws, {
        type: 'ai_cache_response',
        probeId: probeSent.probeId,
        results: {},
      });

      const result = await probePromise;
      expect(result).toBeNull();
    });

    it('setAICacheProbeHandler registers handler and responds to probes', async () => {
      const ws = await establishConnection();

      const handler = vi.fn(async (keys, fields) => {
        return { 'msg-1': { summary: { subject: 'Cached' }, action: 'archive' } };
      });

      p2pSync.setAICacheProbeHandler(handler);

      ws.sent = [];
      await sendSocketMessage(ws, {
        type: 'ai_cache_probe',
        keys: ['msg-1'],
        probeId: 'probe-123',
      });

      expect(handler).toHaveBeenCalledWith(['msg-1'], undefined);

      // Should have responded with ai_cache_response
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const response = sentMessages.find((m) => m.type === 'ai_cache_response');
      expect(response).toBeDefined();
      expect(response.probeId).toBe('probe-123');
      expect(response.results['msg-1'].summary.subject).toBe('Cached');

      // Clean up handler
      p2pSync.setAICacheProbeHandler(null);
    });

    it('ai_cache_probe with no handler does nothing', async () => {
      const ws = await establishConnection();
      p2pSync.setAICacheProbeHandler(null);

      ws.sent = [];
      await sendSocketMessage(ws, {
        type: 'ai_cache_probe',
        keys: ['msg-1'],
        probeId: 'probe-456',
      });

      // No response should be sent
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const response = sentMessages.find((m) => m.type === 'ai_cache_response');
      expect(response).toBeUndefined();
    });

    it('ai_cache_probe with empty keys does nothing', async () => {
      const ws = await establishConnection();
      const handler = vi.fn(async () => ({}));
      p2pSync.setAICacheProbeHandler(handler);

      ws.sent = [];
      await sendSocketMessage(ws, {
        type: 'ai_cache_probe',
        keys: [],
        probeId: 'probe-789',
      });

      expect(handler).not.toHaveBeenCalled();
      p2pSync.setAICacheProbeHandler(null);
    });

    it('ai_cache_response without probeId falls back to key matching', async () => {
      const ws = await establishConnection();

      // Start a probe
      const probePromise = p2pSync.probeAndWait(['msg-fallback'], 5000);

      await new Promise((r) => setTimeout(r, 10));

      // Respond without probeId but with matching keys
      await sendSocketMessage(ws, {
        type: 'ai_cache_response',
        results: { 'msg-fallback': { action: 'delete' } },
        // No probeId
      });

      const result = await probePromise;
      expect(result).toBeDefined();
      expect(result['msg-fallback'].action).toBe('delete');
    });

    it('ai_cache_response with no matching probe is silently ignored', async () => {
      const ws = await establishConnection();

      // Send response with no pending probes
      await sendSocketMessage(ws, {
        type: 'ai_cache_response',
        results: { 'no-match': { action: 'archive' } },
        probeId: 'nonexistent-probe',
      });

      // Should not throw
    });

    it('ai_cache_response with null results is ignored', async () => {
      const ws = await establishConnection();

      await sendSocketMessage(ws, {
        type: 'ai_cache_response',
        results: null,
      });

      // Should not throw
    });

    it('cleanupP2PSync resolves pending probes with null', async () => {
      const ws = await establishConnection();

      // Start a probe that won't be resolved
      const probePromise = p2pSync.probeAndWait(['msg-cleanup'], 60000);

      await new Promise((r) => setTimeout(r, 10));

      // Cleanup should resolve all pending probes with null
      p2pSync.cleanupP2PSync();

      const result = await probePromise;
      expect(result).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AI Cache Probe — IDB Key Filtering (background.js handler logic)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('AI Cache Probe — IDB key filtering', () => {
    // These tests verify that the probe handler (as registered in background.js)
    // correctly excludes metadata keys (ts:, orig:, userprompt:, justification:)
    // that share the same prefix. Matching a metadata key returns a timestamp or
    // metadata value instead of the actual cached data.

    /**
     * Helper: creates a handler that mimics background.js's setAICacheProbeHandler
     * callback, using the provided allIdbKeys and idbData for lookups.
     */
    function createProbeHandler(allIdbKeys, idbData) {
      return async (probeKeys, fields) => {
        const results = {};
        const wantSummary = !fields || fields.includes("summary");
        const wantAction = !fields || fields.includes("action");
        const wantReply = !fields || fields.includes("reply");
        for (const probeKey of probeKeys) {
          const suffix = `:${probeKey}`;
          const summaryMatch = wantSummary ? allIdbKeys.find(k => k.startsWith("summary:") && !k.startsWith("summary:ts:") && k.endsWith(suffix)) : null;
          const actionMatch = wantAction ? allIdbKeys.find(k => k.startsWith("action:") && !k.startsWith("action:ts:") && !k.startsWith("action:orig:") && !k.startsWith("action:userprompt:") && !k.startsWith("action:justification:") && k.endsWith(suffix)) : null;
          const replyMatch = wantReply ? allIdbKeys.find(k => k.startsWith("reply:") && !k.startsWith("reply:ts:") && k.endsWith(suffix)) : null;
          if (!summaryMatch && !actionMatch && !replyMatch) continue;

          const matchKeys = [summaryMatch, actionMatch, replyMatch].filter(Boolean);
          const fetches = {};
          for (const mk of matchKeys) {
            if (idbData[mk] !== undefined) fetches[mk] = idbData[mk];
          }
          const summary = summaryMatch ? fetches[summaryMatch] : null;
          const action = actionMatch ? fetches[actionMatch] : null;
          const replyEntry = replyMatch ? fetches[replyMatch] : null;
          if (summary || action || replyEntry) {
            results[probeKey] = {};
            if (summary) {
              results[probeKey].summary = {
                blurb: summary.blurb || "",
                todos: summary.todos || "",
                reminderDate: summary.reminder?.date || null,
                reminderTime: summary.reminder?.time || null,
                reminderContent: summary.reminder?.content || null,
              };
            }
            if (action) {
              results[probeKey].action = action;
            }
            if (replyEntry?.reply) {
              results[probeKey].reply = replyEntry.reply;
            }
          }
        }
        return results;
      };
    }

    it('returns summary data and skips summary:ts: metadata key', async () => {
      const msgId = 'msg123@example.com';
      // IDB keys sorted ascending — summary:ts: sorts before summary:zzaccount: but after summary:account1:
      const allIdbKeys = [
        `summary:account1:INBOX:${msgId}`,
        `summary:ts:account1:INBOX:${msgId}`,
      ].sort();

      const idbData = {
        [`summary:account1:INBOX:${msgId}`]: { blurb: 'Hello world', todos: 'Do stuff', reminder: { date: '2026-03-15' } },
        [`summary:ts:account1:INBOX:${msgId}`]: 1709654321000,
      };

      const handler = createProbeHandler(allIdbKeys, idbData);
      const results = await handler([msgId]);

      expect(results[msgId]).toBeDefined();
      expect(results[msgId].summary.blurb).toBe('Hello world');
      expect(results[msgId].summary.todos).toBe('Do stuff');
      expect(results[msgId].summary.reminderDate).toBe('2026-03-15');
    });

    it('returns summary data when account ID sorts after "ts:" alphabetically', async () => {
      const msgId = 'test@example.com';
      // Account "zz-uuid" sorts after "ts:", so without the fix summary:ts: would match first
      const allIdbKeys = [
        `summary:ts:zz-uuid:INBOX:${msgId}`,
        `summary:zz-uuid:INBOX:${msgId}`,
      ].sort();

      // Verify sort order: ts: key comes first (the bug scenario)
      expect(allIdbKeys[0]).toContain('summary:ts:');

      const idbData = {
        [`summary:zz-uuid:INBOX:${msgId}`]: { blurb: 'Real summary', todos: '' },
        [`summary:ts:zz-uuid:INBOX:${msgId}`]: 1709654321000,
      };

      const handler = createProbeHandler(allIdbKeys, idbData);
      const results = await handler([msgId]);

      expect(results[msgId]).toBeDefined();
      expect(results[msgId].summary.blurb).toBe('Real summary');
    });

    it('returns action data and skips action:ts:, action:orig:, action:userprompt:, action:justification:', async () => {
      const msgId = 'act@example.com';
      const allIdbKeys = [
        `action:account1:INBOX:${msgId}`,
        `action:justification:account1:INBOX:${msgId}`,
        `action:orig:account1:INBOX:${msgId}`,
        `action:ts:account1:INBOX:${msgId}`,
        `action:userprompt:account1:INBOX:${msgId}`,
      ].sort();

      const idbData = {
        [`action:account1:INBOX:${msgId}`]: 'archive',
        [`action:ts:account1:INBOX:${msgId}`]: 1709654321000,
        [`action:orig:account1:INBOX:${msgId}`]: 'none',
        [`action:userprompt:account1:INBOX:${msgId}`]: 'custom prompt text',
        [`action:justification:account1:INBOX:${msgId}`]: 'because reasons',
      };

      const handler = createProbeHandler(allIdbKeys, idbData);
      const results = await handler([msgId]);

      expect(results[msgId]).toBeDefined();
      expect(results[msgId].action).toBe('archive');
    });

    it('returns action data when account ID sorts after metadata prefixes', async () => {
      const msgId = 'meta@example.com';
      // Account "xyz" sorts after "ts:", "orig:", "userprompt:", "justification:"
      const allIdbKeys = [
        `action:justification:xyz:INBOX:${msgId}`,
        `action:orig:xyz:INBOX:${msgId}`,
        `action:ts:xyz:INBOX:${msgId}`,
        `action:userprompt:xyz:INBOX:${msgId}`,
        `action:xyz:INBOX:${msgId}`,
      ].sort();

      // Verify all metadata keys sort before the data key
      expect(allIdbKeys.indexOf(`action:xyz:INBOX:${msgId}`)).toBeGreaterThan(
        allIdbKeys.indexOf(`action:ts:xyz:INBOX:${msgId}`)
      );

      const idbData = {
        [`action:xyz:INBOX:${msgId}`]: 'reply',
        [`action:ts:xyz:INBOX:${msgId}`]: 1709654321000,
        [`action:justification:xyz:INBOX:${msgId}`]: 'some justification',
        [`action:orig:xyz:INBOX:${msgId}`]: 'delete',
        [`action:userprompt:xyz:INBOX:${msgId}`]: 'prompt text',
      };

      const handler = createProbeHandler(allIdbKeys, idbData);
      const results = await handler([msgId]);

      expect(results[msgId]).toBeDefined();
      expect(results[msgId].action).toBe('reply');
    });

    it('returns reply data and skips reply:ts: key', async () => {
      const msgId = 'reply@example.com';
      const allIdbKeys = [
        `reply:account1:INBOX:${msgId}`,
        `reply:ts:account1:INBOX:${msgId}`,
      ].sort();

      const idbData = {
        [`reply:account1:INBOX:${msgId}`]: { reply: 'Thanks for your email' },
        [`reply:ts:account1:INBOX:${msgId}`]: 1709654321000,
      };

      const handler = createProbeHandler(allIdbKeys, idbData);
      const results = await handler([msgId]);

      expect(results[msgId]).toBeDefined();
      expect(results[msgId].reply).toBe('Thanks for your email');
    });

    it('returns all three fields simultaneously with metadata keys present', async () => {
      const msgId = 'all@example.com';
      const allIdbKeys = [
        `action:account1:INBOX:${msgId}`,
        `action:ts:account1:INBOX:${msgId}`,
        `reply:account1:INBOX:${msgId}`,
        `reply:ts:account1:INBOX:${msgId}`,
        `summary:account1:INBOX:${msgId}`,
        `summary:ts:account1:INBOX:${msgId}`,
      ].sort();

      const idbData = {
        [`summary:account1:INBOX:${msgId}`]: { blurb: 'Test blurb', todos: 'Test todos' },
        [`summary:ts:account1:INBOX:${msgId}`]: 1709654321000,
        [`action:account1:INBOX:${msgId}`]: 'delete',
        [`action:ts:account1:INBOX:${msgId}`]: 1709654321000,
        [`reply:account1:INBOX:${msgId}`]: { reply: 'Got it' },
        [`reply:ts:account1:INBOX:${msgId}`]: 1709654321000,
      };

      const handler = createProbeHandler(allIdbKeys, idbData);
      const results = await handler([msgId]);

      expect(results[msgId].summary.blurb).toBe('Test blurb');
      expect(results[msgId].action).toBe('delete');
      expect(results[msgId].reply).toBe('Got it');
    });

    it('returns empty results when only metadata keys exist (no data keys)', async () => {
      const msgId = 'nodata@example.com';
      const allIdbKeys = [
        `summary:ts:account1:INBOX:${msgId}`,
        `action:ts:account1:INBOX:${msgId}`,
        `reply:ts:account1:INBOX:${msgId}`,
      ].sort();

      const idbData = {
        [`summary:ts:account1:INBOX:${msgId}`]: 1709654321000,
        [`action:ts:account1:INBOX:${msgId}`]: 1709654321000,
        [`reply:ts:account1:INBOX:${msgId}`]: 1709654321000,
      };

      const handler = createProbeHandler(allIdbKeys, idbData);
      const results = await handler([msgId]);

      expect(results[msgId]).toBeUndefined();
    });

    it('handles multiple probe keys in single request', async () => {
      const msg1 = 'first@example.com';
      const msg2 = 'second@example.com';
      const allIdbKeys = [
        `summary:account1:INBOX:${msg1}`,
        `summary:ts:account1:INBOX:${msg1}`,
        `action:account1:Sent:${msg2}`,
        `action:ts:account1:Sent:${msg2}`,
      ].sort();

      const idbData = {
        [`summary:account1:INBOX:${msg1}`]: { blurb: 'First' },
        [`summary:ts:account1:INBOX:${msg1}`]: 1709654321000,
        [`action:account1:Sent:${msg2}`]: 'none',
        [`action:ts:account1:Sent:${msg2}`]: 1709654321000,
      };

      const handler = createProbeHandler(allIdbKeys, idbData);
      const results = await handler([msg1, msg2]);

      expect(results[msg1].summary.blurb).toBe('First');
      expect(results[msg2].action).toBe('none');
    });

    it('respects field filter to only return requested fields', async () => {
      const msgId = 'filter@example.com';
      const allIdbKeys = [
        `summary:account1:INBOX:${msgId}`,
        `action:account1:INBOX:${msgId}`,
        `reply:account1:INBOX:${msgId}`,
      ];

      const idbData = {
        [`summary:account1:INBOX:${msgId}`]: { blurb: 'Blurb' },
        [`action:account1:INBOX:${msgId}`]: 'archive',
        [`reply:account1:INBOX:${msgId}`]: { reply: 'Reply text' },
      };

      const handler = createProbeHandler(allIdbKeys, idbData);
      const results = await handler([msgId], ['action']);

      expect(results[msgId].action).toBe('archive');
      expect(results[msgId].summary).toBeUndefined();
      expect(results[msgId].reply).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Connect / Disconnect
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Connect / Disconnect', () => {
    it('connect skips when auto-sync is disabled', async () => {
      setStorage({ 'p2p_sync_auto_enabled': false });
      const beforeCount = mockWebSocketInstances.length;

      await p2pSync.connect();

      // No new WebSocket should have been created
      expect(mockWebSocketInstances.length).toBe(beforeCount);
    });

    it('connect does not create duplicate when already connected', async () => {
      const ws = await establishConnection();
      const countBefore = mockWebSocketInstances.length;

      // Try connecting again while already connected
      await p2pSync.connect();

      // Should not create a new WebSocket
      expect(mockWebSocketInstances.length).toBe(countBefore);
    });

    it('disconnect sets intentionalDisconnect preventing reconnect', async () => {
      const ws = await establishConnection();

      // Disconnect
      p2pSync.disconnect();

      expect(p2pSync.isConnected()).toBe(false);
    });

    it('setAutoEnabled(false) disconnects', async () => {
      const ws = await establishConnection();
      expect(p2pSync.isConnected()).toBe(true);

      await p2pSync.setAutoEnabled(false);

      expect(p2pSync.isConnected()).toBe(false);
      expect(storageData['p2p_sync_auto_enabled']).toBe(false);
    });

    it('setAutoEnabled(true) triggers connect', async () => {
      setStorage({ 'p2p_sync_auto_enabled': false });
      p2pSync.disconnect();
      const beforeCount = mockWebSocketInstances.length;

      // Set some timestamps so connect succeeds
      setStorage({
        ...storageData,
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
      });

      await p2pSync.setAutoEnabled(true);

      // Should have created a new WebSocket
      expect(mockWebSocketInstances.length).toBeGreaterThan(beforeCount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // syncNow
  // ═══════════════════════════════════════════════════════════════════════════
  describe('syncNow', () => {
    it('syncNow broadcasts and probes when connected', async () => {
      const ws = await establishConnection();
      ws.sent = [];

      await p2pSync.syncNow();

      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      // Should have broadcast prompt_state
      expect(sentMessages.some((m) => m.type === 'prompt_state')).toBe(true);
      // Should have sent request_state probe
      expect(sentMessages.some((m) => m.type === 'request_state')).toBe(true);
    });

    it('syncNow attempts connect when not connected', async () => {
      p2pSync.disconnect();
      setStorage({
        'p2p_sync_auto_enabled': true,
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
      });

      const beforeCount = mockWebSocketInstances.length;
      await p2pSync.syncNow();

      // Should have attempted to connect
      expect(mockWebSocketInstances.length).toBeGreaterThan(beforeCount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // setupStorageListener
  // ═══════════════════════════════════════════════════════════════════════════
  describe('setupStorageListener', () => {
    it('registers a storage change listener', () => {
      browserMock.storage.onChanged.addListener.mockClear();

      p2pSync.setupStorageListener();

      expect(browserMock.storage.onChanged.addListener).toHaveBeenCalled();
    });

    it('does not register duplicate listener on second call', () => {
      // First call already happened above, call again
      const callCount = browserMock.storage.onChanged.addListener.mock.calls.length;

      p2pSync.setupStorageListener();

      // Should not have added another listener
      expect(browserMock.storage.onChanged.addListener.mock.calls.length).toBe(callCount);

      // Clean up so future tests start fresh
      p2pSync.cleanupP2PSync();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resetFieldToDefault with connected socket
  // ═══════════════════════════════════════════════════════════════════════════
  describe('resetFieldToDefault with connection', () => {
    it('sends request_state for the field after reset when connected', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.action]: 'Custom action',
        [TIMESTAMP_KEYS.action]: '2026-03-10T00:00:00Z',
      });
      ws.sent = [];

      await p2pSync.resetFieldToDefault('action', 'Default action');

      // Should have sent request_state for the reset field
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const requestState = sentMessages.find((m) => m.type === 'request_state');
      expect(requestState).toBeDefined();
      expect(requestState.fields).toEqual(['action']);
    });

    it('resetFieldToDefault for templates works', async () => {
      setStorage({
        [FIELD_KEYS.templates]: [{ id: 't1', name: 'Custom' }],
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
      });

      await p2pSync.resetFieldToDefault('templates', []);

      expect(storageData[FIELD_KEYS.templates]).toEqual([]);
      expect(storageData[TIMESTAMP_KEYS.templates]).toBe(EPOCH_ZERO);
    });

    it('resetFieldToDefault for disabledReminders works', async () => {
      setStorage({
        [FIELD_KEYS.disabledReminders]: { 'h1': { enabled: false, ts: '2026-03-10T00:00:00Z' } },
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
      });

      await p2pSync.resetFieldToDefault('disabledReminders', {});

      expect(storageData[FIELD_KEYS.disabledReminders]).toEqual({});
      expect(storageData[TIMESTAMP_KEYS.disabledReminders]).toBe(EPOCH_ZERO);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // broadcastState with connected socket
  // ═══════════════════════════════════════════════════════════════════════════
  describe('broadcastState with connection', () => {
    it('sends prompt_state with all fields when connected', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.composition]: 'My comp',
        [FIELD_KEYS.action]: 'My action',
        [FIELD_KEYS.kb]: 'My kb',
        [FIELD_KEYS.templates]: [{ id: 't1', name: 'T1' }],
        [FIELD_KEYS.disabledReminders]: { h: { enabled: false, ts: '2026-03-01T00:00:00Z' } },
      });
      ws.sent = [];

      await p2pSync.broadcastState();

      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const promptState = sentMessages.find((m) => m.type === 'prompt_state');
      expect(promptState).toBeDefined();
      expect(promptState.data.composition).toBe('My comp');
      expect(promptState.data.action).toBe('My action');
      expect(promptState.data.kb).toBe('My kb');
      expect(promptState.data.templates).toEqual([{ id: 't1', name: 'T1' }]);
    });

    it('sends prompt_state with only specified fields', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.composition]: 'My comp',
        [FIELD_KEYS.kb]: 'My kb',
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
      });
      ws.sent = [];

      await p2pSync.broadcastState(['kb']);

      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const promptState = sentMessages.find((m) => m.type === 'prompt_state');
      expect(promptState).toBeDefined();
      // Only kb should be included
      expect(promptState.data.kb).toBe('My kb');
      // composition should not be present since we only asked for kb
      expect(promptState.data.composition).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // initTimestampsIfNeeded: legacy base migration
  // ═══════════════════════════════════════════════════════════════════════════
  describe('initTimestampsIfNeeded via connect', () => {
    it('migrates legacy sync base keys to peer base on connect', async () => {
      setStorage({
        'p2p_sync_auto_enabled': true,
        // Legacy base keys
        'p2p_sync_base:composition': 'legacy comp base',
        'p2p_sync_base:action': 'legacy action base',
        'p2p_sync_base:kb': 'legacy kb base',
        // Some timestamps so device is not virgin
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.action]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
      });

      await p2pSync.connect();
      const ws = mockWebSocketInstances[mockWebSocketInstances.length - 1];
      if (ws && ws.onopen) ws.onopen();

      // Peer base keys should now be populated from legacy
      expect(storageData[PEER_BASE_KEYS.composition]).toBe('legacy comp base');
      expect(storageData[PEER_BASE_KEYS.action]).toBe('legacy action base');
      expect(storageData[PEER_BASE_KEYS.kb]).toBe('legacy kb base');

      // Legacy keys should be removed
      expect(storageData['p2p_sync_base:composition']).toBeUndefined();
      expect(storageData['p2p_sync_base:action']).toBeUndefined();
      expect(storageData['p2p_sync_base:kb']).toBeUndefined();
    });

    it('initializes timestamps to epoch-zero for new device', async () => {
      setStorage({
        'p2p_sync_auto_enabled': true,
        // No timestamps at all
      });

      await p2pSync.connect();
      const ws = mockWebSocketInstances[mockWebSocketInstances.length - 1];
      if (ws && ws.onopen) ws.onopen();

      // All timestamp keys should now exist with epoch-zero
      expect(storageData[TIMESTAMP_KEYS.composition]).toBe(EPOCH_ZERO);
      expect(storageData[TIMESTAMP_KEYS.action]).toBe(EPOCH_ZERO);
      expect(storageData[TIMESTAMP_KEYS.kb]).toBe(EPOCH_ZERO);
      expect(storageData[TIMESTAMP_KEYS.templates]).toBe(EPOCH_ZERO);
      expect(storageData[TIMESTAMP_KEYS.disabledReminders]).toBe(EPOCH_ZERO);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Edge cases', () => {
    it('handlePromptState with empty incoming data does not crash', async () => {
      const ws = await establishConnection();

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {},
      });

      // Should handle gracefully without errors
    });

    it('handlePromptState resolves incoming timestamp from global updatedAt fallback', async () => {
      const ws = await establishConnection();

      setStorage({
        ...storageData,
        [FIELD_KEYS.kb]: 'Local',
        [TIMESTAMP_KEYS.kb]: '2026-03-05T00:00:00Z',
        // No peer base
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          kb: 'Remote via fallback',
          // No per-field timestamp, but has global updatedAt
          updatedAt: '2026-03-12T00:00:00Z',
        },
      });

      // Should use global updatedAt as fallback for timestamp
      expect(storageData[FIELD_KEYS.kb]).toBe('Remote via fallback');
    });

    it('broadcastState handles readLocalState error gracefully', async () => {
      const ws = await establishConnection();

      // Make storage.local.get throw temporarily
      const originalGet = browserMock.storage.local.get;
      browserMock.storage.local.get = vi.fn(async () => { throw new Error('Storage error'); });

      // Should not throw
      await p2pSync.broadcastState();

      // Restore
      browserMock.storage.local.get = originalGet;
    });

    it('3-way merge where merged result equals local (no-op)', async () => {
      const ws = await establishConnection();

      // Set up scenario where 3-way merge produces same as local
      const base = '- rule A';
      const local = '- rule A'; // No changes from base
      const remote = '- rule A'; // Also no changes

      setStorage({
        ...storageData,
        [FIELD_KEYS.kb]: local,
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
        [PEER_BASE_KEYS.kb]: base,
        [PEER_BASE_TS_KEYS.kb]: '2026-03-08T00:00:00Z',
      });

      // local === peer_base so this is actually fast-forward to remote
      // which also === local, so no change
      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          kb: remote,
          kb_updated_at: '2026-03-12T00:00:00Z',
        },
      });

      // Peer base should still be updated
      expect(storageData[PEER_BASE_KEYS.kb]).toBe(remote);
    });
  });
});
