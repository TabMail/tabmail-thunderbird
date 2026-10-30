/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// signOut.test.js — supabaseAuth.signOut() (R34): it removes the session and the consent flag (the
// signed-out account's status) and deletes nothing else. The prompts, templates, history, Device Sync
// state, settings and the AI cache stay: they are this device's (DS-DEVICE). It closes the Device Sync
// transport and never waits for the prompt semaphore.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "acorn";

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

// Mock deviceSync — track the account change the sign-out makes (it stores the session it is given).
const mockChangeAccount = vi.fn(async (storeSession) => storeSession());
vi.mock("../agent/modules/deviceSync.js", () => ({
  changeAccount: mockChangeAccount,
  cleanupDeviceSync: vi.fn(),
  disconnect: vi.fn(),
  connect: vi.fn(),
  isConnected: vi.fn(() => false),
  addStatusListener: vi.fn(),
  setupStorageListener: vi.fn(),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

const { signOut, getSession, initSessionHost } = await import(
  "../agent/modules/supabaseAuth.js"
);
// As the background page, the one place the session is stored.
initSessionHost();

// ─── Tests ───────────────────────────────────────────────────────────────────

/** Every key Device Sync carries (deviceSync.js FIELD_KEYS and TIMESTAMP_KEYS), read from its source so a
 * newly synced field is counted too. */
function deviceSyncKeys() {
  const source = readFileSync(new URL("../agent/modules/deviceSync.js", import.meta.url), "utf8");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const objectValues = (name) => {
    const decl = ast.body.flatMap((node) => node.type === "VariableDeclaration" ? node.declarations : [])
      .find((d) => d.id.name === name);
    return decl.init.properties.map((p) => p.value.value);
  };
  return [...objectValues("FIELD_KEYS"), ...objectValues("TIMESTAMP_KEYS")];
}

describe("signOut (R34)", () => {
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

  it("closes the Device Sync transport and never reaches the prompt store, so it never waits for it", async () => {
    setStorage({ supabaseSession: { access_token: "tok" } });

    expect(await signOut()).toBe(true);

    expect(mockChangeAccount).toHaveBeenCalledTimes(1);
    expect(mockChangeAccount.mock.calls[0][1]).toBe(false);
    const source = readFileSync(new URL("../agent/modules/supabaseAuth.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/promptStore/);
  });

  it("deletes nothing but the session and the consent flag: every synced field, its state, the history and the settings stay", async () => {
    const keys = deviceSyncKeys();
    expect(keys).toContain("user_prompts:user_kb.md");
    expect(keys).toContain("user_templates");
    expect(keys).toContain("device_sync_ts:actionConfig");
    const ts = new Date().toISOString();
    const kept = {
      ...Object.fromEntries(keys.map((k) => [k, ts])),
      "bullet_state:kb": { bullets: [] },
      "bullet_state:composition": { bullets: [] },
      "bullet_state:action": { bullets: [] },
      "device_sync_auto_enabled": true,
      "device_sync_backups": "{}",
      "prompt_history": '[{"ts": 1}]',
      "prompt_history_migrated": true,
      "defaultCalendarId": "cal-123",
      "defaultAddressBookId": "ab-9",
      "some_unrelated_key": "keep me",
    };
    setStorage({ supabaseSession: { access_token: "tok" }, tabmailConsentRequired: false, ...kept });

    expect(await signOut()).toBe(true);

    expect(storageData).toEqual(kept);
    expect(browserMock.storage.local.remove.mock.calls.flat(2).sort()).toEqual(["supabaseSession", "tabmailConsentRequired"]);
  });

  it("never clears the AI cache: sign-out does not reach the action cache", () => {
    const source = readFileSync(new URL("../agent/modules/supabaseAuth.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/actionCache/);
  });

  it("closes Device Sync even when the session read fails (signed out is never the same account)", async () => {
    setStorage({ supabaseSession: { access_token: "tok" } });
    browserMock.storage.local.get.mockRejectedValueOnce(new Error("storage unavailable"));

    expect(await signOut()).toBe(true);

    expect(mockChangeAccount).toHaveBeenCalledTimes(1);
    expect(await getSession()).toBeNull();
  });
});
