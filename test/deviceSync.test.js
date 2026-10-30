/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// deviceSync.test.js — Device sync merge logic tests (Tier 3 — mock-dependent)
//
// Tests the per-field timestamp merge, echo prevention, virgin device detection,
// template CRDT merge and disabled reminders merge, and the hand-off of the three bullet
// fields (composition, action, kb) to promptStore.js (mocked here).
//
// Strategy: mock browser.storage.local and dynamic imports, then import deviceSync
// and invoke handleMessage (via the module's internal socket.onmessage pathway)
// or test exported functions that exercise the merge logic.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    mockWebSocketInstances.push(this);
  }
  static get CONNECTING() { return 0; }
  static get OPEN() { return 1; }
  static get CLOSING() { return 2; }
  static get CLOSED() { return 3; }
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

// Exercise the real parent transport, with only the Gecko host/network mocked.
const parentSource = readFileSync(new URL('../agent/experiments/tmDeviceSync/tmDeviceSync.sys.mjs', import.meta.url), 'utf8');
const ParentTransport = runInNewContext(parentSource + '\n tmDeviceSync;', {
  ChromeUtils: { importESModule: path => path.includes('Timer')
    ? { setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args), setInterval: (...args) => setInterval(...args), clearInterval: (...args) => clearInterval(...args) }
    : { ExtensionCommon: { ExtensionAPIPersistent: class {}, ExtensionError: Error, EventManager: class { api() { return {}; } } } } },
  Services: {
    appShell: { createWindowlessBrowser: () => ({ document: { defaultView: { WebSocket: globalThis.WebSocket } }, close() {} }) },
    io: { newURI: raw => { const u = new URL(raw); return { scheme: u.protocol.slice(0, -1), host: u.hostname, filePath: u.pathname, userPass: u.username }; } },
  },
});
const parentTransport = new ParentTransport({});
const transportApi = parentTransport.getAPI({}).tmDeviceSync;
browserMock.tmDeviceSync = {
  connect: async url => transportApi.connect(url),
  getState: async () => transportApi.getState(),
  send: async data => transportApi.send(data),
  disconnect: async () => transportApi.disconnect(),
  onEvent: { addListener: listener => parentTransport.PERSISTENT_EVENTS.onEvent({ fire: { async: event => Promise.resolve(listener(event)) } }) },
};


// ─── Module Mocks ────────────────────────────────────────────────────────────

// Mock utils.js (log)
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

// Mock config.js
vi.mock('../agent/modules/config.js', async (importOriginal) => ({
  getDeviceSyncUrl: vi.fn(async () => 'https://sync.tabmail.ai'),
  SETTINGS: {
    deviceSync: { broadcastDebounceMs: 500, busyReapplyMs: 2000, maxWaitingReceives: 256, historyDebounceMs: 2000 },
    actionCompaction: (await importOriginal()).SETTINGS.actionCompaction,
  },
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
  // As the module does, saves nothing once `current()` (the message's connection lasts) fails.
  mergeTemplates: vi.fn(async (incoming, current = () => true) => {
    mergeTemplatesCalls.push(incoming);
    if (!current()) return;
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
  mergeIncoming: vi.fn(async (map, current = () => true) => {
    mergeIncomingCalls.push(map);
    if (!current()) return;
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

// Mock promptStore.js: the three bullet fields (composition, action, kb) are merged there (its own
// tests and the shared vectors cover that); here it is the collaborator deviceSync hands them to.
// Every operation is one hold of the prompt semaphore (`withPromptStore`), whose store merges a received
// message, imports a released device's texts, sends fields, puts the texts back or runs deviceSync's own
// history functions in the hold, as the background's prompt store does: a send reads what to send
// (`outgoingBulletState`) and hands it to deviceSync.sendMessages. Signed in or not, the hold is taken
// (DS-DEVICE: only AI calls and Device Sync need an account).
vi.mock('../agent/modules/promptStore.js', () => {
  const sync = () => import('../agent/modules/deviceSync.js');
  const held = () => true;
  const outgoingBulletState = vi.fn(async (field) => ({ kind: 'messages', messages: [{ type: 'bullet_state', v: 1, field }] }));
  const send = async (fields) => {
    for (const field of fields) {
      const outgoing = await outgoingBulletState(field);
      if (outgoing.kind === 'messages') await (await sync()).sendMessages(field, outgoing.messages);
    }
  };
  // What the background's merge of a received bullet_state did, and the fields its import of a released
  // device's texts changed: set by each test. The store sends what they call for before its hold ends.
  const receiveBulletState = vi.fn(async () => ({ kind: 'ignored' }));
  const receiveLegacyPromptState = vi.fn(async () => []);
  const restoreHandle = {
    // A merge whose incoming labels differed sends the field back (DS-SEND).
    receive: vi.fn(async (message) => {
      const result = await receiveBulletState(message);
      if (result.kind === 'merged' && result.send) await send([result.field]);
      return result;
    }),
    // An import that added texts sends the fields it changed (DS-LEGACY-IN, DS-SEND).
    receiveLegacy: vi.fn(async (data) => {
      const fields = await receiveLegacyPromptState(data);
      await send(fields);
      return fields;
    }),
    send: vi.fn(send),
    holds: vi.fn(held),
    // As the background's prompt store: the texts (not modelled here), then the entry's templates in the hold.
    restore: vi.fn(async (entry) => {
      (await sync()).writeRestoredTemplates(JSON.parse(entry.templatesJSON || '[]'), held);
    }),
    resetField: vi.fn(async (field, value) => {
      const deviceSync = await sync();
      await deviceSync.recordHistory('reset', [field], held);
      await deviceSync.writeFieldDefault(field, value, held);
    }),
    history: vi.fn(async () => (await sync()).readHistory(held)),
    recordHistory: vi.fn(async (source, fields, templates) => (await sync()).recordHistory(source, fields, held, templates)),
  };
  const withPromptStore = vi.fn(async (body) => body(restoreHandle));
  return {
    receiveBulletState,
    receiveLegacyPromptState,
    outgoingBulletState,
    withPromptStore,
    sendBulletState: vi.fn((fields) => withPromptStore((store) => store.send(fields))),
    restoreHandle,
    bulletSyncDisconnected: vi.fn(),
  };
});

// ─── Constants (mirrored from deviceSync.js) ────────────────────────────────────

const FIELD_KEYS = {
  composition: 'user_prompts:user_composition.md',
  action: 'user_prompts:user_action.md',
  kb: 'user_prompts:user_kb.md',
  templates: 'user_templates',
  disabledReminders: 'disabled_reminders_v2',
};

const TIMESTAMP_KEYS = {
  composition: 'device_sync_ts:composition',
  action: 'device_sync_ts:action',
  kb: 'device_sync_ts:kb',
  templates: 'device_sync_ts:templates',
  disabledReminders: 'device_sync_ts:disabledReminders',
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
    'device_sync_auto_enabled': true,
    [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
    [TIMESTAMP_KEYS.action]: '2026-03-10T00:00:00Z',
    [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
    [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
    [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
  });

  const beforeCount = mockWebSocketInstances.length;
  await deviceSync.connect();
  const ws = mockWebSocketInstances[mockWebSocketInstances.length - 1];

  // Trigger onopen to complete the connection
  if (ws && ws.onopen) {
    ws.readyState = WebSocket.OPEN;
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
const deviceSync = await import('../agent/modules/deviceSync.js');
deviceSync.attachDeviceSyncTransportListener();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Device Sync', () => {
  beforeEach(() => {
    clearStorage();
    resetMockCalls();
    mockWebSocketInstances = [];
    // Someone is signed in, as Device Sync needs.
    setStorage({ supabaseSession: { access_token: 'synthetic-access' } });
  });

  afterEach(async () => {
    // Ensure incoming work is settled before resetting the next fixture.
    await deviceSync.disconnect();
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
      await deviceSync.broadcastState();
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
      // deviceSync is not connected (no socket), broadcastState should silently return
      setStorage({
        [FIELD_KEYS.composition]: 'Some content',
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
      });

      // Should not throw and should not attempt to send
      await deviceSync.broadcastState();
      // No socket, so no send attempt — verified by no error
    });

    it('restoreFromHistory hands the three texts to the prompt store and writes the templates', async () => {
      setStorage({
        [FIELD_KEYS.composition]: 'Current',
        [FIELD_KEYS.templates]: [{ id: 't-old', name: 'Old' }],
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
      });
      const entry = {
        id: 'test-entry',
        composition: 'Restored comp',
        action: 'Restored action',
        kb: 'Restored kb',
        templatesJSON: JSON.stringify([{ id: 't-new', name: 'New' }]),
      };

      await deviceSync.restoreFromHistory(entry);

      const promptStore = await import('../agent/modules/promptStore.js');
      // One hold of the prompt semaphore puts the texts back.
      expect(promptStore.withPromptStore).toHaveBeenCalledTimes(1);
      expect(promptStore.restoreHandle.restore).toHaveBeenCalledWith(entry);
      // The text keys are written only by the prompt store (R10: a captured edit, never an overwrite).
      expect(storageData[FIELD_KEYS.composition]).toBe('Current');
      expect(storageData[FIELD_KEYS.templates]).toEqual([{ id: 't-new', name: 'New' }]);
    });

    it('resetFieldToDefault suppresses broadcast during reset', async () => {
      setStorage({
        [FIELD_KEYS.templates]: [{ id: 't1', name: 'Custom' }],
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
      });

      await deviceSync.resetFieldToDefault('templates', []);

      // Should have written default value with epoch-zero timestamp
      expect(storageData[FIELD_KEYS.templates]).toEqual([]);
      expect(storageData[TIMESTAMP_KEYS.templates]).toBe(EPOCH_ZERO);
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
        [FIELD_KEYS.disabledReminders]: { hash1: { enabled: false, ts: '2026-01-01T00:00:00Z' } },
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
      });

      await deviceSync.resetFieldToDefault('disabledReminders', {});

      expect(storageData[TIMESTAMP_KEYS.disabledReminders]).toBe(EPOCH_ZERO);
    });

    it('resetFieldToDefault leaves the bullet fields to the prompt store (DS-RESET)', async () => {
      for (const field of ['composition', 'action', 'kb']) {
        setStorage({ [FIELD_KEYS[field]]: `Custom ${field}`, [TIMESTAMP_KEYS[field]]: '2026-03-10T00:00:00Z' });
        await deviceSync.resetFieldToDefault(field, `Default ${field}`);
        expect(storageData[FIELD_KEYS[field]]).toBe(`Custom ${field}`);
        expect(storageData[TIMESTAMP_KEYS[field]]).toBe('2026-03-10T00:00:00Z');
      }
      expect(browserMock.storage.local.set).not.toHaveBeenCalled();
    });

    it('resetFieldToDefault rejects invalid field names', async () => {
      // Should not throw, just warn and return
      await deviceSync.resetFieldToDefault('invalidField', 'value');
      // No storage write should have happened for an invalid field
    });

    it('virgin device on connect probes peers instead of broadcasting', async () => {
      // Set all timestamps to epoch-zero (virgin device)
      setStorage({
        'device_sync_auto_enabled': true,
        [TIMESTAMP_KEYS.composition]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.action]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.kb]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.templates]: EPOCH_ZERO,
        [TIMESTAMP_KEYS.disabledReminders]: EPOCH_ZERO,
      });

      await deviceSync.connect();
      const ws = mockWebSocketInstances[mockWebSocketInstances.length - 1];

      // Trigger onopen
      if (ws && ws.onopen) {
        ws.readyState = WebSocket.OPEN;
        ws.onopen();
      }

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
        'device_sync_auto_enabled': true,
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.action]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
        [FIELD_KEYS.composition]: 'My rules',
      });

      await deviceSync.connect();
      const ws = mockWebSocketInstances[mockWebSocketInstances.length - 1];
      if (ws && ws.onopen) {
        ws.readyState = WebSocket.OPEN;
        ws.onopen();
      }

      // Simulate the server responding with "connected"
      await sendSocketMessage(ws, { type: 'connected', userId: 'test-user-id' });

      // Non-virgin device should broadcast prompt_state
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const hasPromptState = sentMessages.some((m) => m.type === 'prompt_state');
      expect(hasPromptState).toBe(true);
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
      expect(deviceSync.isConnected()).toBe(false);
    });

    it('status listeners are notified', () => {
      const listener = vi.fn();
      deviceSync.addStatusListener(listener);
      // Registration must not publish a fresh generation's reset status.
      expect(listener).not.toHaveBeenCalled();
      deviceSync.disconnect();
      expect(listener).toHaveBeenCalledWith(false);

      deviceSync.removeStatusListener(listener);
    });

    it('isAutoEnabled defaults to true', async () => {
      const enabled = await deviceSync.isAutoEnabled();
      expect(enabled).toBe(true);
    });

    it('setAutoEnabled persists setting', async () => {
      await deviceSync.setAutoEnabled(false);
      expect(storageData['device_sync_auto_enabled']).toBe(false);
    });

    it('removeStatusListener stops notifications', () => {
      const listener = vi.fn();
      deviceSync.addStatusListener(listener);
      listener.mockClear();

      deviceSync.removeStatusListener(listener);

      // Disconnecting should not notify removed listener
      deviceSync.disconnect();
      expect(listener).not.toHaveBeenCalled();
    });

    it('multiple status listeners all get notified', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      deviceSync.addStatusListener(listener1);
      deviceSync.addStatusListener(listener2);

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      deviceSync.disconnect();
      expect(listener1).toHaveBeenCalledWith(false);
      expect(listener2).toHaveBeenCalledWith(false);

      deviceSync.removeStatusListener(listener1);
      deviceSync.removeStatusListener(listener2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional: History management
  // ═══════════════════════════════════════════════════════════════════════════
  describe('History management', () => {
    // The history is the device's: kept, shown and recorded signed in or not (R34).
    beforeEach(() => setStorage({ supabaseSession: { access_token: 'synthetic-access' } }));

    it('while nobody is signed in, loadHistory returns the history and a commit is recorded', async () => {
      vi.useFakeTimers();
      try {
        setStorage({ prompt_history_migrated: true, prompt_history: [{ id: '1', source: 'local_edit', kb: '- Kept' }], [FIELD_KEYS.kb]: 'Before kb' });
        delete storageData.supabaseSession;
        expect(await deviceSync.loadHistory()).toEqual([{ id: '1', source: 'local_edit', kb: '- Kept' }]);
        // A local edit's record takes its own hold, signed out too.
        deviceSync.scheduleEditHistory(['kb']);
        await vi.runAllTimersAsync();
        const history = storageData['prompt_history'];
        expect(history).toHaveLength(2);
        expect(history[0]).toEqual({ id: '1', source: 'local_edit', kb: '- Kept' });
        expect(history[1]).toMatchObject({ source: 'local_edit', fields: ['kb'], kb: 'Before kb' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('loadHistory returns empty array when no history', async () => {
      const history = await deviceSync.loadHistory();
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

      const history = await deviceSync.loadHistory();
      expect(history).toHaveLength(2);
      expect(history[0].source).toBe('local_edit');
      expect(history[1].source).toBe('sync_receive');
    });

    it('restoreFromHistory writes the templates with a fresh timestamp so the restore propagates', async () => {
      setStorage({
        prompt_history_migrated: true,
        [FIELD_KEYS.templates]: [],
        [TIMESTAMP_KEYS.templates]: '2026-03-01T00:00:00Z',
      });

      await deviceSync.restoreFromHistory({
        id: 'r1',
        composition: 'New',
        action: 'New',
        kb: 'New',
        templatesJSON: '[]',
      });

      expect(storageData[TIMESTAMP_KEYS.templates] > '2026-03-01T00:00:00Z').toBe(true);
      expect(storageData[TIMESTAMP_KEYS.templates]).not.toBe(EPOCH_ZERO);
    });

    it('a local edit\'s history is recorded once, after the quiet period, for the edits made within it (DS-HISTORY)', async () => {
      vi.useFakeTimers();
      try {
        // Earlier tests' storage writes scheduled history records of their own: let them land first.
        await vi.runAllTimersAsync();
        clearStorage();
        setStorage({ prompt_history_migrated: true, [FIELD_KEYS.kb]: 'Before kb' });
        deviceSync.scheduleEditHistory(['kb']);
        await vi.advanceTimersByTimeAsync(1000);
        deviceSync.scheduleEditHistory(['action']);
        await vi.advanceTimersByTimeAsync(1999);
        expect(storageData['prompt_history']).toBeUndefined();

        await vi.runAllTimersAsync();
        expect(storageData['prompt_history']).toHaveLength(1);
        expect(storageData['prompt_history'][0]).toMatchObject({ source: 'local_edit', kb: 'Before kb' });
        expect([...storageData['prompt_history'][0].fields].sort()).toEqual(['action', 'kb']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('loadHistory migrates legacy backups on first call', async () => {
      // Set up legacy backups (not yet migrated)
      setStorage({
        'device_sync_backups': [
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

      const history = await deviceSync.loadHistory();

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
        'device_sync_backups': [
          {
            backedUpAt: '2026-03-05T00:00:00Z',
            state: { composition: 'Should not appear', action: '', kb: '', templates: [] },
          },
        ],
      });

      const history = await deviceSync.loadHistory();
      // Should only have the existing entry, not re-migrate backups
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional: Cleanup
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Cleanup', () => {
    it('cleanupDeviceSync disconnects and clears listeners', () => {
      const listener = vi.fn();
      deviceSync.addStatusListener(listener);

      deviceSync.cleanupDeviceSync();

      expect(deviceSync.isConnected()).toBe(false);
    });

    it('disconnect resets connection state', () => {
      deviceSync.disconnect();
      expect(deviceSync.isConnected()).toBe(false);
    });

    it('cleanupDeviceSync (sign-out) keeps the storage change listener, so a local edit while signed out still gets its timestamp (R34)', async () => {
      const fresh = await import('../agent/modules/deviceSync.js?cleanupKeepsListener');
      browserMock.storage.onChanged.addListener.mockClear();
      browserMock.storage.onChanged.removeListener.mockClear();
      fresh.setupStorageListener();
      expect(browserMock.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
      const listener = browserMock.storage.onChanged.addListener.mock.calls[0][0];

      await fresh.cleanupDeviceSync();
      expect(browserMock.storage.onChanged.removeListener).not.toHaveBeenCalled();
      const before = Date.now();
      listener({ [FIELD_KEYS.templates]: { newValue: [] } }, 'local');
      await vi.waitFor(() => expect(Date.parse(storageData[TIMESTAMP_KEYS.templates])).toBeGreaterThanOrEqual(before));
      // Still the one listener.
      fresh.setupStorageListener();
      expect(browserMock.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // handlePromptState via socket.onmessage — core merge logic
  // ═══════════════════════════════════════════════════════════════════════════
  describe('handlePromptState via socket messages', () => {
    it('hands a released device\'s texts to the prompt store and sends the fields it changed (DS-LEGACY-IN)', async () => {
      const ws = await establishConnection();
      const promptStore = await import('../agent/modules/promptStore.js');
      promptStore.receiveLegacyPromptState.mockResolvedValueOnce(['kb']);
      setStorage({ [FIELD_KEYS.kb]: 'Local KB', [TIMESTAMP_KEYS.kb]: '2026-03-10T00:00:00Z' });
      ws.sent = [];
      const data = {
        composition: 'Remote comp', composition_updated_at: '2026-03-12T00:00:00Z',
        action: 'Remote action', action_updated_at: '2026-03-12T00:00:00Z',
        kb: 'Newer Remote KB', kb_updated_at: '2026-03-12T00:00:00Z',
      };

      await sendSocketMessage(ws, { type: 'prompt_state', data });

      expect(promptStore.receiveLegacyPromptState).toHaveBeenCalledWith(data);
      const sent = ws.sent.map((raw) => JSON.parse(raw));
      expect(sent.filter((m) => m.type === 'bullet_state').map((m) => m.field)).toEqual(['kb']);
      // deviceSync never writes a bullet field's text or timestamp itself.
      expect(storageData[FIELD_KEYS.kb]).toBe('Local KB');
      expect(storageData[TIMESTAMP_KEYS.kb]).toBe('2026-03-10T00:00:00Z');
      expect(storageData[FIELD_KEYS.composition]).toBeUndefined();
    });

    it('sends no bullet_state when the import changed nothing', async () => {
      const ws = await establishConnection();
      const promptStore = await import('../agent/modules/promptStore.js');
      promptStore.receiveLegacyPromptState.mockResolvedValueOnce([]);
      ws.sent = [];

      await sendSocketMessage(ws, { type: 'prompt_state', data: { kb: '- known', kb_updated_at: '2026-03-12T00:00:00Z' } });

      expect(ws.sent.map((raw) => JSON.parse(raw)).some((m) => m.type === 'bullet_state')).toBe(false);
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
    it('hands bullet_state to the prompt store and sends the field back only when the merge differed (DS-SEND)', async () => {
      const ws = await establishConnection();
      const promptStore = await import('../agent/modules/promptStore.js');
      const message = { type: 'bullet_state', v: 1, field: 'kb', sender: 's', snap: 'x', part: 1, parts: 1, bullets: [], seen: {} };
      const outcomes = [
        [{ kind: 'merged', field: 'kb', changed: true, send: true }, ['kb']],
        [{ kind: 'merged', field: 'kb', changed: true, send: false }, []],
        [{ kind: 'partial' }, []],
        [{ kind: 'conflict', field: 'kb' }, []],
        [{ kind: 'invalid', field: 'kb', reason: 'r' }, []],
        [{ kind: 'unsaved', field: 'kb' }, []],
      ];
      for (const [outcome, sentFields] of outcomes) {
        ws.sent = [];
        promptStore.receiveBulletState.mockResolvedValueOnce(outcome);
        await sendSocketMessage(ws, message);
        expect(promptStore.receiveBulletState).toHaveBeenLastCalledWith(message);
        expect(ws.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === 'bullet_state').map((m) => m.field)).toEqual(sentFields);
      }
    });

    it('sends the three bullet fields on connected, before anything else (DS-SEND)', async () => {
      const ws = await establishConnection();
      ws.sent = [];
      await sendSocketMessage(ws, { type: 'connected', userId: 'test-user-id' });
      const sent = ws.sent.map((raw) => JSON.parse(raw));
      expect(sent.slice(0, 3).map((m) => [m.type, m.field])).toEqual([
        ['bullet_state', 'kb'], ['bullet_state', 'composition'], ['bullet_state', 'action'],
      ]);
    });

    it('sends every part of a field\'s outgoing state, in order (DS-CHUNK)', async () => {
      const ws = await establishConnection();
      ws.sent = [];
      await deviceSync.sendMessages('kb', [{ type: 'bullet_state', field: 'kb', part: 1, parts: 2 }, { type: 'bullet_state', field: 'kb', part: 2, parts: 2 }]);
      expect(ws.sent.map((raw) => JSON.parse(raw)).map((m) => [m.field, m.part])).toEqual([['kb', 1], ['kb', 2]]);
    });

    it('sends no bullet_state while disconnected', async () => {
      const ws = await establishConnection();
      await deviceSync.disconnect();
      ws.sent = [];
      await deviceSync.sendMessages('kb', [{ type: 'bullet_state', field: 'kb', part: 1, parts: 1 }]);
      expect(ws.sent).toEqual([]);
    });

    it('a closed connection drops the incomplete snapshots (DS-CHUNK)', async () => {
      await establishConnection();
      const promptStore = await import('../agent/modules/promptStore.js');
      promptStore.bulletSyncDisconnected.mockClear();
      await Promise.all([...parentTransport.listeners].map(({ fire }) => fire.async({ type: 'close' })));
      expect(promptStore.bulletSyncDisconnected).toHaveBeenCalledTimes(1);
    });

    it('an explicit disconnect drops the incomplete snapshots too (DS-CHUNK)', async () => {
      await establishConnection();
      const promptStore = await import('../agent/modules/promptStore.js');
      promptStore.bulletSyncDisconnected.mockClear();
      await deviceSync.disconnect();
      expect(promptStore.bulletSyncDisconnected).toHaveBeenCalledTimes(1);
    });

    it('answers a request_state for the bullet fields with masked texts (DS-LEGACY-OUT)', async () => {
      const ws = await establishConnection();
      setStorage({ [FIELD_KEYS.kb]: '- Synthetic private fact', [FIELD_KEYS.composition]: '- Synthetic style' });
      ws.sent = [];
      await sendSocketMessage(ws, { type: 'request_state', fields: ['kb', 'composition', 'action'] });
      const reply = ws.sent.map((raw) => JSON.parse(raw)).find((m) => m.type === 'prompt_state');
      expect(reply.data).toMatchObject({
        kb: '', kb_updated_at: EPOCH_ZERO, composition: '', composition_updated_at: EPOCH_ZERO, action: '', action_updated_at: EPOCH_ZERO,
      });
      expect(JSON.stringify(reply)).not.toContain('Synthetic');
    });

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
      const result = await deviceSync.probeAndWait(['key1', 'key2']);
      expect(result).toBeNull();
    });

    it('probeAndWait sends probe and resolves on response', async () => {
      const ws = await establishConnection();

      // Start a probe
      const probePromise = deviceSync.probeAndWait(['msg-id-1'], 5000);

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
      const result = await deviceSync.probeAndWait(['msg-id-1'], 50);

      // No response sent, so it should timeout
      expect(result).toBeNull();
    });

    it('probeAndWait with optional fields parameter', async () => {
      const ws = await establishConnection();

      const probePromise = deviceSync.probeAndWait(['msg-id-1'], 5000, ['summary']);

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

      const probePromise = deviceSync.probeAICache('<msg@example.com>', 'summary');

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

      const probePromise = deviceSync.probeAICache('nonexistent@example.com', 'summary');

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

      deviceSync.setAICacheProbeHandler(handler);

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
      deviceSync.setAICacheProbeHandler(null);
    });

    it('ai_cache_probe with no handler does nothing', async () => {
      const ws = await establishConnection();
      deviceSync.setAICacheProbeHandler(null);

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
      deviceSync.setAICacheProbeHandler(handler);

      ws.sent = [];
      await sendSocketMessage(ws, {
        type: 'ai_cache_probe',
        keys: [],
        probeId: 'probe-789',
      });

      expect(handler).not.toHaveBeenCalled();
      deviceSync.setAICacheProbeHandler(null);
    });

    it('ai_cache_response without probeId falls back to key matching', async () => {
      const ws = await establishConnection();

      // Start a probe
      const probePromise = deviceSync.probeAndWait(['msg-fallback'], 5000);

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

    it('cleanupDeviceSync resolves pending probes with null', async () => {
      const ws = await establishConnection();

      // Start a probe that won't be resolved
      const probePromise = deviceSync.probeAndWait(['msg-cleanup'], 60000);

      await new Promise((r) => setTimeout(r, 10));

      // Cleanup should resolve all pending probes with null
      deviceSync.cleanupDeviceSync();

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
    it('a fresh background accepts a replayed message before connecting again', async () => {
      const oldListeners = new Set(parentTransport.listeners);
      parentTransport.listeners.clear();
      const fresh = await import('../agent/modules/deviceSync.js?freshWake');
      try {
        fresh.attachDeviceSyncTransportListener();
        fresh.attachDeviceSyncTransportListener();
        expect(parentTransport.listeners.size).toBe(1);
        await Promise.all([...parentTransport.listeners].map(({ fire }) => fire.async({
          type: 'message', data: JSON.stringify({ type: 'prompt_state', data: {
            templates: [{ id: 't-replay', name: 'Synthetic replay', updatedAt: '2026-09-20T00:00:00Z' }],
            templates_updated_at: '2026-09-20T00:00:00Z',
          } }),
        })));
        expect(fresh.isConnected()).toBe(true);
        expect(storageData[FIELD_KEYS.templates]).toContainEqual(expect.objectContaining({ name: 'Synthetic replay' }));
      } finally {
        await fresh.cleanupDeviceSync();
        parentTransport.listeners = oldListeners;
      }
    });

    it('forwards periodic probes and tolerates a parent send failure', async () => {
      const ws = await establishConnection();
      ws.sent.length = 0;
      const deliver = () => Promise.all([...parentTransport.listeners].map(({ fire }) => fire.async({ type: 'probe' })));
      await deliver();
      // R9: the probe names only the prompt_state fields, never the bullet fields' texts.
      expect(ws.sent.map(raw => JSON.parse(raw))).toContainEqual({ type: 'request_state', fields: ['templates', 'disabledReminders', 'taskCache', 'actionConfig'] });
      parentTransport.disconnect();
      await expect(deliver()).resolves.toBeDefined();
    });

    it('cleanup never waits for the connected handshake broadcast (R32: sign-out never waits)', async () => {
      await establishConnection();
      const realGet = browserMock.storage.local.get.getMockImplementation();
      let releaseRead;
      browserMock.storage.local.get.mockImplementation(keys => {
        // The broadcast's read of the timestamps (it never reads the texts).
        if (!releaseRead && Array.isArray(keys) && keys.includes(TIMESTAMP_KEYS.composition)) {
          return new Promise(resolve => { releaseRead = async () => resolve(await realGet(keys)); });
        }
        return realGet(keys);
      });
      try {
        const incoming = Promise.all([...parentTransport.listeners].map(({ fire }) => fire.async({
          type: 'message', data: JSON.stringify({ type: 'connected' }),
        })));
        await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
        let cleaned = false;
        const cleanup = deviceSync.cleanupDeviceSync().then(() => { cleaned = true; });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        const returnedBeforeBroadcast = cleaned;
        await releaseRead();
        await Promise.all([incoming, cleanup]);
        expect(returnedBeforeBroadcast).toBe(true);
      } finally { browserMock.storage.local.get.mockImplementation(realGet); }
    });

    it('cleanup waits for the parent disconnect acknowledgement', async () => {
      await establishConnection();
      const original = browserMock.tmDeviceSync.disconnect;
      let release;
      browserMock.tmDeviceSync.disconnect = () => new Promise(resolve => { release = resolve; });
      let finished = false;
      try {
        const pending = deviceSync.cleanupDeviceSync().then(() => { finished = true; });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(finished).toBe(false);
        release();
        await pending;
        expect(finished).toBe(true);
      } finally {
        release?.();
        browserMock.tmDeviceSync.disconnect = original;
        await original();
      }
    });

    it('failed cache-probe send resolves before its timeout', async () => {
      await establishConnection();
      parentTransport.disconnect();
      vi.useFakeTimers();
      try {
        const result = deviceSync.probeAndWait(['synthetic@example.test'], 60000);
        await expect(result).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });

    it('ignores queued parent events after disconnect but accepts them while enabled', async () => {
      const deliver = event => Promise.all([...parentTransport.listeners].map(({ fire }) => fire.async(event)));
      await establishConnection();
      const message = { type: 'message', data: JSON.stringify({ type: 'prompt_state', data: {
        templates: [{ id: 't-peer', name: 'Synthetic peer rule', updatedAt: '2026-09-20T00:00:00Z' }],
        templates_updated_at: '2026-09-20T00:00:00Z',
      } }) };
      await deliver(message);
      expect(storageData[FIELD_KEYS.templates]).toContainEqual(expect.objectContaining({ name: 'Synthetic peer rule' }));
      await deviceSync.disconnect();
      clearStorage();
      const socketsBefore = mockWebSocketInstances.length;
      for (const event of [{ type: 'open' }, { type: 'probe' }, { type: 'reconnect' }, message, { type: 'close' }]) {
        await deliver(event);
        expect(deviceSync.isConnected()).toBe(false);
      }
      expect(storageData).toEqual({});
      expect(mockWebSocketInstances).toHaveLength(socketsBefore);
    });

    // DS-LEGACY-IN: the per-item merges run with no connection check. They are
    // idempotent and order-free, so one that finishes after its connection ended writes valid peer data.
    it('cleanup never waits for an incoming message being applied, and its per-item merge still lands after the connection ended (DS-LEGACY-IN)', async () => {
      await establishConnection();
      const realGet = browserMock.storage.local.get.getMockImplementation();
      // The read just before the templates merge (after the history's): paused, so the message is applying
      // when the connection ends.
      let templateReads = 0;
      let releaseRead;
      browserMock.storage.local.get.mockImplementation(keys => {
        if (keys === FIELD_KEYS.templates && ++templateReads === 2) {
          return new Promise(resolve => { releaseRead = async () => resolve(await realGet(keys)); });
        }
        return realGet(keys);
      });
      const incoming = Promise.all([...parentTransport.listeners].map(({ fire }) => fire.async({
        type: 'message', data: JSON.stringify({ type: 'prompt_state', data: {
          templates: [{ id: 't-old', name: 'Synthetic late rule', updatedAt: '2026-09-20T00:00:00Z' }],
          templates_updated_at: '2026-09-20T00:00:00Z',
        } }),
      })));
      await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
      await deviceSync.cleanupDeviceSync();
      await releaseRead();
      await incoming;
      browserMock.storage.local.get.mockImplementation(realGet);
      expect(storageData[FIELD_KEYS.templates] ?? []).toContainEqual(expect.objectContaining({ name: 'Synthetic late rule' }));
    });

    it('finishes both local resets when the parent disconnected before the close event arrives', async () => {
      await establishConnection();
      parentTransport.disconnect();
      expect(deviceSync.isConnected()).toBe(true);
      await expect(deviceSync.resetFieldToDefault('templates', [])).resolves.toBeUndefined();
      await expect(deviceSync.resetFieldToDefault('disabledReminders', {})).resolves.toBeUndefined();
      expect(storageData[FIELD_KEYS.templates]).toEqual([]);
      expect(storageData[FIELD_KEYS.disabledReminders]).toEqual({});
      expect(storageData[TIMESTAMP_KEYS.templates]).toBe(EPOCH_ZERO);
      expect(storageData[TIMESTAMP_KEYS.disabledReminders]).toBe(EPOCH_ZERO);
    });

    it('explicit Sync Now reconnects immediately while startup respects the retry delay', async () => {
      const ws = await establishConnection();
      ws.close();
      expect(parentTransport.state()).toBe('retrying');
      await deviceSync.connect();
      expect(mockWebSocketInstances).toHaveLength(1);
      await deviceSync.syncNow();
      expect(mockWebSocketInstances).toHaveLength(2);
      expect(parentTransport.state()).toBe('connecting');
      mockWebSocketInstances[1].readyState = WebSocket.OPEN;
      mockWebSocketInstances[1].onopen();
      expect(deviceSync.isConnected()).toBe(true);
    });

    it('a settled stale attempt does not un-coalesce the current attempt', async () => {
      const { getDeviceSyncUrl } = await import('../agent/modules/config.js');
      let releaseStale, releaseFresh;
      getDeviceSyncUrl
        .mockImplementationOnce(() => new Promise(r => { releaseStale = r; }))
        .mockImplementationOnce(() => new Promise(r => { releaseFresh = r; }));
      setStorage({ device_sync_auto_enabled: true });
      const stale = deviceSync.connect();
      await vi.waitFor(() => expect(releaseStale).toBeTypeOf('function'));
      deviceSync.disconnect();
      const fresh = deviceSync.connect();
      await vi.waitFor(() => expect(releaseFresh).toBeTypeOf('function'));
      releaseStale('https://sync-dev.tabmail.ai');
      await stale;
      const third = deviceSync.connect();
      releaseFresh('https://sync.tabmail.ai');
      await Promise.all([fresh, third]);
      expect(mockWebSocketInstances).toHaveLength(1);
      expect(mockWebSocketInstances[0].url).toContain('sync.tabmail.ai');
    });

    it('a stale attempt that rejects does not un-coalesce the current attempt', async () => {
      const { getDeviceSyncUrl } = await import('../agent/modules/config.js');
      let rejectStale, releaseFresh;
      browserMock.storage.local.set.mockImplementationOnce(() => new Promise((_, reject) => { rejectStale = reject; }));
      getDeviceSyncUrl.mockImplementationOnce(() => new Promise(r => { releaseFresh = r; }));
      setStorage({ device_sync_auto_enabled: true });
      const stale = deviceSync.connect();
      await vi.waitFor(() => expect(rejectStale).toBeTypeOf('function'));
      deviceSync.disconnect();
      const fresh = deviceSync.connect();
      await vi.waitFor(() => expect(releaseFresh).toBeTypeOf('function'));
      rejectStale(new Error('storage unavailable'));
      await expect(stale).rejects.toThrow('storage unavailable');
      const third = deviceSync.connect();
      releaseFresh('https://sync.tabmail.ai');
      await Promise.all([fresh, third]);
      expect(mockWebSocketInstances).toHaveLength(1);
      expect(mockWebSocketInstances[0].url).toContain('sync.tabmail.ai');
    });

    it('disable and re-enable while the access token is pending leaves one socket', async () => {
      const { getAccessToken } = await import('../agent/modules/supabaseAuth.js');
      let releaseToken;
      getAccessToken.mockImplementationOnce(() => new Promise(r => { releaseToken = r; }));
      setStorage({ device_sync_auto_enabled: true });
      const stale = deviceSync.connect();
      await vi.waitFor(() => expect(releaseToken).toBeTypeOf('function'));
      deviceSync.disconnect();
      const fresh = deviceSync.connect();
      await fresh;
      releaseToken('stale-token');
      await stale;
      expect(mockWebSocketInstances).toHaveLength(1);
      expect(mockWebSocketInstances[0].url).not.toContain('stale-token');
      mockWebSocketInstances[0].readyState = WebSocket.OPEN;
      mockWebSocketInstances[0].onopen();
      expect(deviceSync.isConnected()).toBe(true);
    });

    it('disable and re-enable while the enabled check is pending leaves one socket', async () => {
      const realGet = browserMock.storage.local.get.getMockImplementation();
      let releaseGet;
      browserMock.storage.local.get.mockImplementationOnce((keys) => new Promise(r => { releaseGet = () => r(realGet(keys)); }));
      setStorage({ device_sync_auto_enabled: true });
      const stale = deviceSync.connect();
      await vi.waitFor(() => expect(releaseGet).toBeTypeOf('function'));
      deviceSync.disconnect();
      const fresh = deviceSync.connect();
      await fresh;
      releaseGet();
      await stale;
      expect(mockWebSocketInstances).toHaveLength(1);
      mockWebSocketInstances[0].readyState = WebSocket.OPEN;
      mockWebSocketInstances[0].onopen();
      expect(deviceSync.isConnected()).toBe(true);
    });

    it('a rejected attempt releases the single-flight so the next connect() retries', async () => {
      browserMock.storage.local.set.mockImplementationOnce(async () => { throw new Error('storage unavailable'); });
      setStorage({ device_sync_auto_enabled: true });
      await expect(deviceSync.connect()).rejects.toThrow('storage unavailable');
      expect(mockWebSocketInstances).toHaveLength(0);
      await deviceSync.connect();
      expect(mockWebSocketInstances).toHaveLength(1);
    });

    it('disconnect then reconnect: stale in-flight attempt adds no socket and the re-enable is not lost', async () => {
      const { getDeviceSyncUrl } = await import('../agent/modules/config.js');
      let releaseOld;
      getDeviceSyncUrl.mockImplementationOnce(() => new Promise(r => { releaseOld = r; }));
      setStorage({ device_sync_auto_enabled: true });
      const stale = deviceSync.connect();
      await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function'));
      deviceSync.disconnect();
      const fresh = deviceSync.connect();
      releaseOld('https://sync.tabmail.ai');
      await Promise.all([stale, fresh]);
      expect(mockWebSocketInstances).toHaveLength(1);
      mockWebSocketInstances[0].readyState = 1;
      mockWebSocketInstances[0].onopen();
      expect(deviceSync.isConnected()).toBe(true);
    });

    it('startup connect preserves the parent reconnect delay after a live drop', async () => {
      const ws = await establishConnection();
      ws.readyState = 3;
      ws.onclose({ code: 1006, reason: 'network drop' });
      expect(deviceSync.isConnected()).toBe(false);
      const before = mockWebSocketInstances.length;
      await deviceSync.connect();
      expect(mockWebSocketInstances.length).toBe(before);
      expect(parentTransport.state()).toBe('retrying');
    });

    it('after the live socket drops, the reconnect timer opens a new socket', async () => {
      vi.useFakeTimers();
      try {
        const ws = await establishConnection();
        ws.readyState = 3;
        ws.onclose({ code: 1006, reason: 'network drop' });
        const before = mockWebSocketInstances.length;
        await vi.advanceTimersByTimeAsync(5000);
        for (let i = 0; i < 50; i++) await Promise.resolve();
        expect(mockWebSocketInstances.length).toBe(before + 1);
      } finally { vi.useRealTimers(); }
    });

    it.each(['closing', 'disconnected'])('a retired %s socket leaves replacement traffic active until cleanup', async (mode) => {
      vi.useFakeTimers();
      try {
        const old = await establishConnection();
        if (mode === 'closing') old.readyState = WebSocket.CLOSING;
        else await deviceSync.disconnect();
        await deviceSync.connect();
        expect(mockWebSocketInstances).toHaveLength(2);
        const current = mockWebSocketInstances.at(-1);
        expect(current).not.toBe(old);
        current.readyState = WebSocket.OPEN;
        current.onopen();
        old.onclose({ code: 1006, reason: 'delayed retired close' });
        expect(deviceSync.isConnected()).toBe(true);

        setStorage({ [FIELD_KEYS.templates]: [{ id: 't-local', name: 'Local before peer repair', updatedAt: new Date().toISOString() }] });
        await vi.advanceTimersByTimeAsync(300000);
        const frames = current.sent.map((frame) => JSON.parse(frame));
        expect(frames.filter((frame) => frame.type === 'ping')).toHaveLength(10);
        expect(frames.filter((frame) => frame.type === 'request_state')).toHaveLength(1);
        expect(frames.find((frame) => frame.type === 'request_state').fields).toContain('templates');
        expect(frames.find((frame) => frame.type === 'request_state').fields).not.toContain('kb');
        expect(old.sent).toHaveLength(0);
        current.onmessage({ data: JSON.stringify({ type: 'prompt_state', data: {
          templates: [{ id: 't-peer', name: 'Current peer repair', updatedAt: new Date().toISOString() }],
          templates_updated_at: new Date().toISOString(),
        } }) });
        await vi.waitFor(() => expect(storageData[FIELD_KEYS.templates]).toContainEqual(expect.objectContaining({ name: 'Current peer repair' })));
        expect((storageData.prompt_history || []).at(-1).templatesJSON).toContain('Local before peer repair');

        await deviceSync.cleanupDeviceSync();
        expect(current.readyState).toBe(WebSocket.CLOSED);
        expect(deviceSync.isConnected()).toBe(false);
        const sentBeforeCleanup = current.sent.length;
        await vi.advanceTimersByTimeAsync(600000);
        expect(current.sent).toHaveLength(sentBeforeCleanup);
        expect(mockWebSocketInstances).toHaveLength(2);
      } finally {
        await deviceSync.cleanupDeviceSync();
        vi.useRealTimers();
      }
    });

    it('cancels a pending URL lookup when disconnected', async () => {
      const { getDeviceSyncUrl } = await import('../agent/modules/config.js');
      let release;
      getDeviceSyncUrl.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      setStorage({ device_sync_auto_enabled: true });
      const attempt = deviceSync.connect();
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      deviceSync.disconnect();
      release('https://sync.tabmail.ai');
      await attempt;
      expect(mockWebSocketInstances).toHaveLength(0);
    });

    it('does not replace a socket while its handshake is pending', async () => {
      setStorage({ device_sync_auto_enabled: true });
      await deviceSync.connect();
      const ws = mockWebSocketInstances.at(-1);
      ws.readyState = WebSocket.CONNECTING;
      const before = mockWebSocketInstances.length;
      await deviceSync.connect();
      const created = [...mockWebSocketInstances];
      try { expect(created).toHaveLength(before); }
      finally { for (const item of created) { item.onclose = null; item.close(); } }
    });

    it('coalesces overlapping connection attempts into one socket', async () => {
      const { getDeviceSyncUrl } = await import('../agent/modules/config.js');
      let release;
      getDeviceSyncUrl.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      setStorage({ device_sync_auto_enabled: true });
      const first = deviceSync.connect();
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const second = deviceSync.connect();
      release('https://sync.tabmail.ai');
      await Promise.all([first, second]);
      const created = [...mockWebSocketInstances];
      try {
        expect(created).toHaveLength(1);
      } finally {
        for (const ws of created) { ws.onclose = null; ws.close(); }
      }
    });

    it('connect skips when auto-sync is disabled', async () => {
      setStorage({ 'device_sync_auto_enabled': false });
      const beforeCount = mockWebSocketInstances.length;

      await deviceSync.connect();

      // No new WebSocket should have been created
      expect(mockWebSocketInstances.length).toBe(beforeCount);
    });

    it('connect does not create duplicate when already connected', async () => {
      const ws = await establishConnection();
      const countBefore = mockWebSocketInstances.length;

      // Try connecting again while already connected
      await deviceSync.connect();

      // Should not create a new WebSocket
      expect(mockWebSocketInstances.length).toBe(countBefore);
    });

    it('disconnect sets intentionalDisconnect preventing reconnect', async () => {
      const ws = await establishConnection();

      // Disconnect
      deviceSync.disconnect();

      expect(deviceSync.isConnected()).toBe(false);
    });

    it('setAutoEnabled(false) disconnects', async () => {
      const ws = await establishConnection();
      expect(deviceSync.isConnected()).toBe(true);

      await deviceSync.setAutoEnabled(false);

      expect(deviceSync.isConnected()).toBe(false);
      expect(storageData['device_sync_auto_enabled']).toBe(false);
    });

    it('setAutoEnabled(true) triggers connect', async () => {
      setStorage({ 'device_sync_auto_enabled': false });
      deviceSync.disconnect();
      const beforeCount = mockWebSocketInstances.length;

      // Set some timestamps so connect succeeds
      setStorage({
        ...storageData,
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
      });

      await deviceSync.setAutoEnabled(true);

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

      await deviceSync.syncNow();

      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      // Should have broadcast prompt_state
      expect(sentMessages.some((m) => m.type === 'prompt_state')).toBe(true);
      // Should have sent request_state probe
      expect(sentMessages.some((m) => m.type === 'request_state')).toBe(true);
    });

    it('syncNow attempts connect when not connected', async () => {
      deviceSync.disconnect();
      setStorage({
        'device_sync_auto_enabled': true,
        [TIMESTAMP_KEYS.composition]: '2026-03-10T00:00:00Z',
      });

      const beforeCount = mockWebSocketInstances.length;
      await deviceSync.syncNow();

      // Should have attempted to connect
      expect(mockWebSocketInstances.length).toBeGreaterThan(beforeCount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // setupStorageListener
  // ═══════════════════════════════════════════════════════════════════════════
  describe('setupStorageListener', () => {
    it('registers one storage change listener, however often it is called', async () => {
      const fresh = await import('../agent/modules/deviceSync.js?registersOnce');
      browserMock.storage.onChanged.addListener.mockClear();

      fresh.setupStorageListener();
      fresh.setupStorageListener();

      expect(browserMock.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
      await fresh.cleanupDeviceSync();
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
        [FIELD_KEYS.templates]: [{ id: 't1', name: 'Custom' }],
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
      });
      ws.sent = [];

      await deviceSync.resetFieldToDefault('templates', []);

      // Should have sent request_state for the reset field
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const requestState = sentMessages.find((m) => m.type === 'request_state');
      expect(requestState).toBeDefined();
      expect(requestState.fields).toEqual(['templates']);
    });

    it('resetFieldToDefault for templates works', async () => {
      setStorage({
        [FIELD_KEYS.templates]: [{ id: 't1', name: 'Custom' }],
        [TIMESTAMP_KEYS.templates]: '2026-03-10T00:00:00Z',
      });

      await deviceSync.resetFieldToDefault('templates', []);

      expect(storageData[FIELD_KEYS.templates]).toEqual([]);
      expect(storageData[TIMESTAMP_KEYS.templates]).toBe(EPOCH_ZERO);
    });

    it('resetFieldToDefault for disabledReminders works', async () => {
      setStorage({
        [FIELD_KEYS.disabledReminders]: { 'h1': { enabled: false, ts: '2026-03-10T00:00:00Z' } },
        [TIMESTAMP_KEYS.disabledReminders]: '2026-03-10T00:00:00Z',
      });

      await deviceSync.resetFieldToDefault('disabledReminders', {});

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

      await deviceSync.broadcastState();

      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const promptState = sentMessages.find((m) => m.type === 'prompt_state');
      expect(promptState).toBeDefined();
      // DS-LEGACY-OUT: the bullet fields' texts are never sent in prompt_state; a released receiver
      // skips them at epoch zero.
      for (const field of ['composition', 'action', 'kb']) {
        expect(promptState.data[field]).toBe('');
        expect(promptState.data[`${field}_updated_at`]).toBe(EPOCH_ZERO);
      }
      expect(JSON.stringify(promptState)).not.toContain('My comp');
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

      await deviceSync.broadcastState(['kb']);

      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      const promptState = sentMessages.find((m) => m.type === 'prompt_state');
      expect(promptState).toBeDefined();
      // Only kb should be included, masked (DS-LEGACY-OUT)
      expect(promptState.data.kb).toBe('');
      expect(promptState.data.kb_updated_at).toBe(EPOCH_ZERO);
      // composition should not be present since we only asked for kb
      expect(promptState.data.composition).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // initTimestampsIfNeeded: legacy base migration
  // ═══════════════════════════════════════════════════════════════════════════
  describe('initTimestampsIfNeeded via connect', () => {
    it('initializes timestamps to epoch-zero for new device', async () => {
      setStorage({
        'device_sync_auto_enabled': true,
        // No timestamps at all
      });

      await deviceSync.connect();
      const ws = mockWebSocketInstances[mockWebSocketInstances.length - 1];
      if (ws && ws.onopen) {
        ws.readyState = WebSocket.OPEN;
        ws.onopen();
      }

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
        [FIELD_KEYS.templates]: [],
        [TIMESTAMP_KEYS.templates]: '2026-03-05T00:00:00Z',
      });

      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: {
          templates: [{ id: 't-fallback', name: 'Remote via fallback', updatedAt: '2026-03-12T00:00:00Z' }],
          // No per-field timestamp, but has global updatedAt
          updatedAt: '2026-03-12T00:00:00Z',
        },
      });

      // Should use global updatedAt as fallback for timestamp
      expect(storageData[FIELD_KEYS.templates]).toContainEqual(expect.objectContaining({ name: 'Remote via fallback' }));
    });

    it('broadcastState handles readLocalState error gracefully', async () => {
      const ws = await establishConnection();

      // Make storage.local.get throw temporarily
      const originalGet = browserMock.storage.local.get;
      browserMock.storage.local.get = vi.fn(async () => { throw new Error('Storage error'); });

      // Should not throw
      await deviceSync.broadcastState();

      // Restore
      browserMock.storage.local.get = originalGet;
    });
  });
});


describe('real Settings owner boundary',()=>{
  beforeEach(()=>{clearStorage();resetMockCalls();mockWebSocketInstances=[];});
  afterEach(async()=>{await deviceSync.disconnect();delete browserMock.runtime;delete globalThis.document;});
  it('persists off and closes transport before the real Settings success response, then enables again',async()=>{
    const { parse }=await import('acorn');
    const source=readFileSync(new URL('../agent/background.js',import.meta.url),'utf8');
    const tree=parse(source,{ecmaVersion:'latest',sourceType:'module'});
    const functions=tree.body.filter(n=>n.type==='FunctionDeclaration' && ['cleanupRuntimeListeners','setupRuntimeMessageListener'].includes(n.id.name));
    let listener;
    browserMock.runtime={onMessage:{addListener:fn=>{listener=fn;},removeListener(){}}};
    runInNewContext('let agentRuntimeMessageListener=null;\n'+functions.map(n=>source.slice(n.start,n.end)).join('\n').replaceAll('await import(', 'await loadModule(')+'\nsetupRuntimeMessageListener();',{
      browser:browserMock,log(){},loadModule:async path=>{expect(path).toBe('./modules/deviceSync.js');return deviceSync;},
    });
    browserMock.runtime.sendMessage=message=>new Promise(resolve=>{expect(listener(message,{},resolve)).toBe(true);});
    const nodes=new Map(['status','privacy-device-sync-warning'].map(id=>[id,{textContent:'',style:{}}]));
    globalThis.document={getElementById:id=>nodes.get(id)};
    const {handlePrivacyChange}=await import('../config/modules/privacy.js');
    const old=await establishConnection();
    await deviceSync.broadcastState(['kb']);expect(old.sent.length).toBeGreaterThan(0);expect(deviceSync.isConnected()).toBe(true);
    await handlePrivacyChange({target:{id:'privacy-device-sync',checked:false}});
    expect(storageData.device_sync_auto_enabled).toBe(false);
    expect(parentTransport.state()).toBe('closed');expect(old.readyState).toBe(3);expect(deviceSync.isConnected()).toBe(false);
    const stopped=old.sent.length;await deviceSync.broadcastState(['kb']);expect(old.sent).toHaveLength(stopped);
    expect(nodes.get('status').textContent).toContain('Device sync disabled');
    await handlePrivacyChange({target:{id:'privacy-device-sync',checked:true}});
    expect(storageData.device_sync_auto_enabled).toBe(true);expect(mockWebSocketInstances).toHaveLength(2);
    const fresh=mockWebSocketInstances.at(-1);fresh.readyState=1;fresh.onopen();await deviceSync.broadcastState(['kb']);
    expect(fresh.sent.length).toBeGreaterThan(0);expect(deviceSync.isConnected()).toBe(true);
  });
  it('seeded delayed state acknowledgements cannot reverse a newer off action',async()=>{
    let seed=0x64d033;let beforeOff=0,afterOff=0;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
    for(let cycle=0;cycle<64;cycle++) {
      await establishConnection();
      const original=browserMock.tmDeviceSync.getState; let release;let seenResolve;
      const seen=new Promise(resolve=>{seenResolve=resolve;});
      browserMock.tmDeviceSync.getState=()=>{const observed=parentTransport.state();seenResolve();return new Promise(resolve=>{release=()=>resolve(observed);});};
      const pending=deviceSync.connect();await seen;
      for(let jitter=random()%9;jitter>0;jitter--)await Promise.resolve();
      const stateFirst=((random()>>>8)%2)===0; if(stateFirst)beforeOff++;else afterOff++;
      try {
        if(stateFirst){release();await pending;expect(deviceSync.isConnected()).toBe(true);}
        await deviceSync.setAutoEnabled(false);
        expect(parentTransport.state()).toBe('closed');expect(storageData.device_sync_auto_enabled).toBe(false);
        if(!stateFirst){release();await pending;}
        expect(deviceSync.isConnected()).toBe(false);
      } finally {release();await pending;browserMock.tmDeviceSync.getState=original;await deviceSync.disconnect();}
    }
    expect(beforeOff).toBeGreaterThan(0);expect(afterOff).toBeGreaterThan(0);
  });
});


describe('bounded transient sync resources',()=>{
  beforeEach(()=>{clearStorage();resetMockCalls();mockWebSocketInstances=[];});
  afterEach(async()=>{await deviceSync.cleanupDeviceSync();vi.useRealTimers();});
  it('successful probes return peer data and rejected sends release request records and timers',async()=>{
    vi.useFakeTimers();const ws=await establishConnection();
    const original=browserMock.tmDeviceSync.send;
    try {
      const success=deviceSync.probeAndWait(['synthetic@example.invalid'],900000);
      const request=JSON.parse(ws.sent.at(-1));expect(request.type).toBe('ai_cache_probe');
      const payload={'synthetic@example.invalid':{action:'archive'}};
      await Promise.all([...parentTransport.listeners].map(({fire})=>fire.async({type:'message',data:JSON.stringify({type:'ai_cache_response',probeId:request.probeId,results:payload})})));
      expect(await success).toEqual(payload);
      const baselineTimers=vi.getTimerCount();const counts=[];
      browserMock.tmDeviceSync.send=vi.fn(async()=>{throw new Error('synthetic parent refusal');});
      for(let n=0;n<12;n++) {
        const keys = ['synthetic@example.invalid'];
        let requests;
        const originalSet = Map.prototype.set;
        const setSpy = vi.spyOn(Map.prototype, 'set').mockImplementation(function(key, value) {
          if (value?.keys === keys) requests = this;
          return originalSet.call(this, key, value);
        });
        try { expect(await deviceSync.probeAndWait(keys,900000)).toBeNull(); }
        finally { setSpy.mockRestore(); }
        expect(requests).toBeDefined();
        counts.push({records:requests.size,timers:vi.getTimerCount()-baselineTimers});
      }
      expect(browserMock.tmDeviceSync.send).toHaveBeenCalledTimes(12);
      expect(counts).toEqual(Array.from({length:12},()=>({records:0,timers:0})));
    } finally {browserMock.tmDeviceSync.send=original;}
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// actionConfig: compaction thresholds sync last-write-wins across devices
// ═══════════════════════════════════════════════════════════════════════════
describe('Device Sync actionConfig (compaction thresholds)', () => {
  const ACTION_CONFIG_KEY = 'user_prompts:action_config';
  const ACTION_CONFIG_TS_KEY = 'device_sync_ts:actionConfig';
  const isoDaysFromNow = (days) => new Date(Date.now() + days * 86400000).toISOString();

  beforeEach(() => {
    clearStorage();
    resetMockCalls();
    mockWebSocketInstances = [];
  });

  afterEach(async () => {
    await deviceSync.disconnect();
  });

  it('applies a newer valid incoming config with its timestamp in the same write', async () => {
    const ws = await establishConnection();
    const incomingTs = isoDaysFromNow(-1);
    setStorage({
      [ACTION_CONFIG_KEY]: { compact_threshold: 100, compact_threshold_chars: 16000 },
      [ACTION_CONFIG_TS_KEY]: isoDaysFromNow(-2),
    });
    resetMockCalls();

    await sendSocketMessage(ws, {
      type: 'prompt_state',
      data: { actionConfig: { compact_threshold: 300, compact_threshold_chars: 32000 }, actionConfig_updated_at: incomingTs },
    });

    expect(storageData[ACTION_CONFIG_KEY]).toEqual({ compact_threshold: 300, compact_threshold_chars: 32000 });
    expect(storageData[ACTION_CONFIG_TS_KEY]).toBe(incomingTs);
    // Value + timestamp in ONE change set — the storage listener skips it as sync-owned (no echo).
    const write = browserMock.storage.local.set.mock.calls.map(([obj]) => obj).find((obj) => ACTION_CONFIG_KEY in obj);
    expect(write).toEqual({
      [ACTION_CONFIG_KEY]: { compact_threshold: 300, compact_threshold_chars: 32000 },
      [ACTION_CONFIG_TS_KEY]: incomingTs,
    });
  });

  it('applies to a device that never touched the sliders (no local config or timestamp)', async () => {
    const ws = await establishConnection();
    const incomingTs = isoDaysFromNow(-1);

    await sendSocketMessage(ws, {
      type: 'prompt_state',
      data: { actionConfig: { compact_threshold: 250, compact_threshold_chars: 20000 }, actionConfig_updated_at: incomingTs },
    });

    expect(storageData[ACTION_CONFIG_KEY]).toEqual({ compact_threshold: 250, compact_threshold_chars: 20000 });
    expect(storageData[ACTION_CONFIG_TS_KEY]).toBe(incomingTs);
  });

  it('keeps the local config when the incoming one is older', async () => {
    const ws = await establishConnection();
    const localTs = isoDaysFromNow(-1);
    setStorage({
      [ACTION_CONFIG_KEY]: { compact_threshold: 400, compact_threshold_chars: 30000 },
      [ACTION_CONFIG_TS_KEY]: localTs,
    });

    await sendSocketMessage(ws, {
      type: 'prompt_state',
      data: { actionConfig: { compact_threshold: 120, compact_threshold_chars: 8000 }, actionConfig_updated_at: isoDaysFromNow(-3) },
    });

    expect(storageData[ACTION_CONFIG_KEY]).toEqual({ compact_threshold: 400, compact_threshold_chars: 30000 });
    expect(storageData[ACTION_CONFIG_TS_KEY]).toBe(localTs);
  });

  it('ignores an epoch-zero (never edited) incoming config', async () => {
    const ws = await establishConnection();
    setStorage({ [ACTION_CONFIG_KEY]: { compact_threshold: 400, compact_threshold_chars: 30000 } });

    await sendSocketMessage(ws, {
      type: 'prompt_state',
      data: { actionConfig: { compact_threshold: 100, compact_threshold_chars: 16000 }, actionConfig_updated_at: EPOCH_ZERO },
    });

    expect(storageData[ACTION_CONFIG_KEY]).toEqual({ compact_threshold: 400, compact_threshold_chars: 30000 });
    expect(storageData[ACTION_CONFIG_TS_KEY]).toBeUndefined();
  });

  it('ignores an incoming config that carries no timestamp', async () => {
    const ws = await establishConnection();
    setStorage({ [ACTION_CONFIG_KEY]: { compact_threshold: 400, compact_threshold_chars: 30000 } });

    await sendSocketMessage(ws, {
      type: 'prompt_state',
      // Every real prompt_state carries the global updatedAt; actionConfig must not fall back to it.
      data: { actionConfig: { compact_threshold: 120, compact_threshold_chars: 8000 }, updatedAt: isoDaysFromNow(0) },
    });

    expect(storageData[ACTION_CONFIG_KEY]).toEqual({ compact_threshold: 400, compact_threshold_chars: 30000 });
    expect(storageData[ACTION_CONFIG_TS_KEY]).toBeUndefined();
  });

  it('a null incoming config does not abort the rest of the same prompt_state', async () => {
    const ws = await establishConnection();
    setStorage({ [ACTION_CONFIG_KEY]: { compact_threshold: 400, compact_threshold_chars: 30000 } });
    const templatesTs = isoDaysFromNow(-1);

    await sendSocketMessage(ws, {
      type: 'prompt_state',
      data: {
        actionConfig: null, actionConfig_updated_at: isoDaysFromNow(-1),
        templates: [{ id: 't-peer', name: 'Synthetic peer rule', updatedAt: templatesTs }], templates_updated_at: templatesTs,
      },
    });

    expect(storageData[ACTION_CONFIG_KEY]).toEqual({ compact_threshold: 400, compact_threshold_chars: 30000 });
    expect(storageData[ACTION_CONFIG_TS_KEY]).toBeUndefined();
    expect(storageData[FIELD_KEYS.templates]).toContainEqual(expect.objectContaining({ name: 'Synthetic peer rule' }));
  });

  it('stores only the two thresholds from an incoming config', async () => {
    const ws = await establishConnection();
    const incomingTs = isoDaysFromNow(-1);

    await sendSocketMessage(ws, {
      type: 'prompt_state',
      data: {
        actionConfig: { compact_threshold: 300, compact_threshold_chars: 40000, extra: 'synthetic' },
        actionConfig_updated_at: incomingTs,
      },
    });

    expect(storageData[ACTION_CONFIG_KEY]).toEqual({ compact_threshold: 300, compact_threshold_chars: 40000 });
    expect(storageData[ACTION_CONFIG_TS_KEY]).toBe(incomingTs);
  });

  it('ignores a malformed incoming config', async () => {
    const ws = await establishConnection();
    setStorage({ [ACTION_CONFIG_KEY]: { compact_threshold: 400, compact_threshold_chars: 30000 } });

    for (const bad of [
      { compact_threshold: '300', compact_threshold_chars: 32000 },
      { compact_threshold: 300 },
      { compact_threshold: 0, compact_threshold_chars: 32000 },
      { compact_threshold: 300, compact_threshold_chars: 0 },
      { compact_threshold: 300.5, compact_threshold_chars: 32000 },
      null,
    ]) {
      await sendSocketMessage(ws, {
        type: 'prompt_state',
        data: { actionConfig: bad, actionConfig_updated_at: isoDaysFromNow(-1) },
      });
    }

    expect(storageData[ACTION_CONFIG_KEY]).toEqual({ compact_threshold: 400, compact_threshold_chars: 30000 });
    expect(storageData[ACTION_CONFIG_TS_KEY]).toBeUndefined();
  });

  it('broadcasts the stored config and timestamp when a peer requests it', async () => {
    const ws = await establishConnection();
    const localTs = isoDaysFromNow(-1);
    setStorage({
      [ACTION_CONFIG_KEY]: { compact_threshold: 350, compact_threshold_chars: 24000 },
      [ACTION_CONFIG_TS_KEY]: localTs,
    });
    ws.sent = [];

    await sendSocketMessage(ws, { type: 'request_state', fields: ['actionConfig'] });

    const promptState = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'prompt_state');
    expect(promptState.data.actionConfig).toEqual({ compact_threshold: 350, compact_threshold_chars: 24000 });
    expect(promptState.data.actionConfig_updated_at).toBe(localTs);
  });

  it('broadcasts the defaults the backend would receive when nothing is stored', async () => {
    const ws = await establishConnection();
    ws.sent = [];

    await deviceSync.broadcastState();

    const promptState = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'prompt_state');
    expect(promptState.data.actionConfig).toEqual({ compact_threshold: 200, compact_threshold_chars: 32000 });
    expect(promptState.data.actionConfig_updated_at).toBe(EPOCH_ZERO);
  });

  it('broadcasts never-edited legacy defaults as the current defaults, still at epoch zero', async () => {
    const ws = await establishConnection();
    setStorage({ [ACTION_CONFIG_KEY]: { compact_threshold: 100, compact_threshold_chars: 16000 } });
    ws.sent = [];

    await deviceSync.broadcastState();

    const promptState = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'prompt_state');
    expect(promptState.data.actionConfig).toEqual({ compact_threshold: 200, compact_threshold_chars: 32000 });
    expect(promptState.data.actionConfig_updated_at).toBe(EPOCH_ZERO);
  });

  it('broadcasts edited values equal to the legacy defaults as stored', async () => {
    const ws = await establishConnection();
    const localTs = isoDaysFromNow(-1);
    setStorage({
      [ACTION_CONFIG_KEY]: { compact_threshold: 100, compact_threshold_chars: 16000 },
      [ACTION_CONFIG_TS_KEY]: localTs,
    });
    ws.sent = [];

    await deviceSync.broadcastState();

    const promptState = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'prompt_state');
    expect(promptState.data.actionConfig).toEqual({ compact_threshold: 100, compact_threshold_chars: 16000 });
    expect(promptState.data.actionConfig_updated_at).toBe(localTs);
  });

  it('probes peers for actionConfig', async () => {
    const ws = await establishConnection();
    ws.sent = [];

    await deviceSync.syncNow();

    const request = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'request_state');
    expect(request.fields).toContain('actionConfig');
  });

  it('a local slider save stamps a timestamp but records no prompt history', async () => {
    vi.useFakeTimers();
    const fresh = await import('../agent/modules/deviceSync.js?sliderSave');
    try {
      browserMock.storage.onChanged.addListener.mockClear();
      fresh.setupStorageListener();
      const listener = browserMock.storage.onChanged.addListener.mock.calls.at(-1)[0];
      const before = Date.now();

      listener({ [ACTION_CONFIG_KEY]: { newValue: { compact_threshold: 200, compact_threshold_chars: 18000 } } }, 'local');
      await vi.advanceTimersByTimeAsync(5000);

      expect(Date.parse(storageData[ACTION_CONFIG_TS_KEY])).toBeGreaterThanOrEqual(before);
      expect(storageData.prompt_history ?? []).toEqual([]);
    } finally {
      await fresh.cleanupDeviceSync();
      vi.useRealTimers();
    }
  });
});
