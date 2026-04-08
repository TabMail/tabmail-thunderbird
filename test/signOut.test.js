// signOut.test.js — Tests for supabaseAuth.signOut() security cleanup
//
// Verifies that signing out clears ALL user-specific data:
// - Supabase session token
// - Device sync connection + userId
// - User prompts, templates, task cache
// - Device sync state (timestamps, peer base, auto-enabled)
// - Prompt history
// - IndexedDB AI cache (summaries, actions, replies)
// - Consent and calendar state

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Storage Mock ────────────────────────────────────────────────────────────

const storageData = {};

function setStorage(data) {
  Object.assign(storageData, data);
}

function clearStorage() {
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
}

const browserMock = {
  storage: {
    local: {
      get: vi.fn(async (keys) => {
        const result = {};
        if (Array.isArray(keys)) {
          for (const k of keys) {
            if (storageData[k] !== undefined) result[k] = storageData[k];
          }
        } else if (typeof keys === "string") {
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

// ─── Module Mocks ────────────────────────────────────────────────────────────

vi.mock("../agent/modules/utils.js", () => ({
  log: vi.fn(),
}));

vi.mock("../agent/modules/config.js", () => ({
  getBackendUrl: vi.fn(async () => "https://backend.tabmail.ai"),
  SETTINGS: { deviceSync: { broadcastDebounceMs: 500 } },
}));

// Mock deviceSync — track calls to cleanupDeviceSync
const mockCleanupDeviceSync = vi.fn();
vi.mock("../agent/modules/deviceSync.js", () => ({
  cleanupDeviceSync: mockCleanupDeviceSync,
  disconnect: vi.fn(),
  connect: vi.fn(),
  isConnected: vi.fn(() => false),
  addStatusListener: vi.fn(),
  setupStorageListener: vi.fn(),
}));

// Mock idbStorage — track calls to clear
const mockIdbClear = vi.fn(async () => {});
vi.mock("../agent/modules/idbStorage.js", () => ({
  clear: mockIdbClear,
  get: vi.fn(async () => ({})),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

const { signOut, getSession } = await import(
  "../agent/modules/supabaseAuth.js"
);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("signOut security cleanup", () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it("clears Supabase session from storage", async () => {
    setStorage({ supabaseSession: { access_token: "tok", refresh_token: "ref" } });

    const result = await signOut();

    expect(result).toBe(true);
    const session = await getSession();
    expect(session).toBeNull();
  });

  it("calls cleanupDeviceSync to disconnect WebSocket and clear userId", async () => {
    setStorage({ supabaseSession: { access_token: "tok" } });

    await signOut();

    expect(mockCleanupDeviceSync).toHaveBeenCalledTimes(1);
  });

  it("clears IndexedDB AI cache", async () => {
    setStorage({ supabaseSession: { access_token: "tok" } });

    await signOut();

    expect(mockIdbClear).toHaveBeenCalledTimes(1);
  });

  it("clears all user prompt storage keys", async () => {
    const userPromptKeys = {
      "user_prompts:user_composition.md": "my composition",
      "user_prompts:user_action.md": "my action",
      "user_prompts:user_kb.md": "my kb",
      "user_templates": '{"t1": "template"}',
      "disabled_reminders_v2": '["r1"]',
      "task_execution_cache": '{"c1": "cached"}',
    };
    setStorage({ supabaseSession: { access_token: "tok" }, ...userPromptKeys });

    await signOut();

    for (const key of Object.keys(userPromptKeys)) {
      expect(storageData[key]).toBeUndefined();
    }
  });

  it("clears all device sync state keys", async () => {
    const syncKeys = {
      "device_sync_auto_enabled": true,
      "device_sync_backups": "{}",
      "device_sync_ts:composition": "2026-01-01T00:00:00Z",
      "device_sync_ts:action": "2026-01-01T00:00:00Z",
      "device_sync_ts:kb": "2026-01-01T00:00:00Z",
      "device_sync_ts:templates": "2026-01-01T00:00:00Z",
      "device_sync_ts:disabledReminders": "2026-01-01T00:00:00Z",
      "device_sync_ts:taskCache": "2026-01-01T00:00:00Z",
    };
    setStorage({ supabaseSession: { access_token: "tok" }, ...syncKeys });

    await signOut();

    for (const key of Object.keys(syncKeys)) {
      expect(storageData[key]).toBeUndefined();
    }
  });

  it("clears all peer base state keys", async () => {
    const peerBaseKeys = {
      "device_peer_base:composition": "base text",
      "device_peer_base:action": "base action",
      "device_peer_base:kb": "base kb",
      "device_peer_base_ts:composition": "2026-01-01T00:00:00Z",
      "device_peer_base_ts:action": "2026-01-01T00:00:00Z",
      "device_peer_base_ts:kb": "2026-01-01T00:00:00Z",
    };
    setStorage({ supabaseSession: { access_token: "tok" }, ...peerBaseKeys });

    await signOut();

    for (const key of Object.keys(peerBaseKeys)) {
      expect(storageData[key]).toBeUndefined();
    }
  });

  it("clears prompt history", async () => {
    setStorage({
      supabaseSession: { access_token: "tok" },
      "prompt_history": '[{"ts": 1}]',
      "prompt_history_migrated": true,
    });

    await signOut();

    expect(storageData["prompt_history"]).toBeUndefined();
    expect(storageData["prompt_history_migrated"]).toBeUndefined();
  });

  it("clears consent and calendar state", async () => {
    setStorage({
      supabaseSession: { access_token: "tok" },
      "tabmailConsentRequired": false,
      "defaultCalendarId": "cal-123",
    });

    await signOut();

    expect(storageData["tabmailConsentRequired"]).toBeUndefined();
    expect(storageData["defaultCalendarId"]).toBeUndefined();
  });

  it("returns true even if deviceSync cleanup fails", async () => {
    mockCleanupDeviceSync.mockImplementationOnce(() => {
      throw new Error("WebSocket error");
    });
    setStorage({ supabaseSession: { access_token: "tok" } });

    const result = await signOut();

    expect(result).toBe(true);
    // Session should still be cleared
    const session = await getSession();
    expect(session).toBeNull();
  });

  it("returns true even if IndexedDB clear fails", async () => {
    mockIdbClear.mockRejectedValueOnce(new Error("IDB error"));
    setStorage({ supabaseSession: { access_token: "tok" } });

    const result = await signOut();

    expect(result).toBe(true);
  });

  it("does not clear unrelated storage keys", async () => {
    setStorage({
      supabaseSession: { access_token: "tok" },
      "some_unrelated_key": "keep me",
      "another_key": 42,
    });

    await signOut();

    expect(storageData["some_unrelated_key"]).toBe("keep me");
    expect(storageData["another_key"]).toBe(42);
  });
});
