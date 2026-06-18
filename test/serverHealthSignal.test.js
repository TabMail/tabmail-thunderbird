/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// serverHealthSignal.test.js — passive backend-health derivation (issue #12).
//
// sendChatCompletions writes `tabmailServerHealthy` to storage as a side-effect
// of real traffic (no health poll). The background turns that into the toolbar
// "server" dot. These tests pin the classification:
//   200 / 4xx / 401 (auth)  → reachable  → healthy=true
//   5xx / network / timeout  → unreachable/unhealthy → healthy=false
//   user-initiated abort     → NOT a server signal → no write
// We bypass the retry wrapper (_internal_no_retry=true) to isolate one attempt.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Controllable auth mock state.
let _isAuthErrorReturn = false;
let _handleAuthErrorReturn = false;

vi.mock("../agent/modules/config.js", () => ({
  getBackendUrl: vi.fn(async () => "https://test.api"),
  SETTINGS: { sseMaxTimeoutSec: 600, sseToolListenTimeoutSec: 600 },
}));
vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn(), normalizeUnicode: (s) => s }));
vi.mock("../agent/modules/thinkBuffer.js", () => ({ setThink: vi.fn() }));
vi.mock("../chat/modules/privacySettings.js", () => ({ assertAiBackendAllowed: vi.fn(async () => {}) }));
vi.mock("../agent/modules/supabaseAuth.js", () => ({
  getAccessToken: vi.fn(async () => "test-token"),
  isAuthError: vi.fn(() => _isAuthErrorReturn),
  handleAuthError: vi.fn(async () => _handleAuthErrorReturn),
}));
vi.mock("../agent/modules/byokStorage.js", () => ({ buildByokPayload: vi.fn(async () => ({})) }));
vi.mock("../config/modules/webSearch.js", () => ({ getWebSearchEnabled: vi.fn(async () => false) }));

const llm = await import("../agent/modules/llm.js");
const { sendChatCompletions, _testExports } = llm;
const { resetForbiddenBackoff, _resetServerHealthSignal } = _testExports;

let setSpy;

function installBrowser() {
  setSpy = vi.fn(async () => {});
  globalThis.browser = {
    storage: { local: { get: vi.fn(async () => ({})), set: setSpy } },
    runtime: { getManifest: vi.fn(() => ({ version: "9.9.9" })) },
  };
}

function jsonResponse({ ok, status }) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => ({ assistant: "hi" }),
    text: async () => "body",
  };
}

function lastHealthWrite() {
  const calls = setSpy.mock.calls.filter(
    (c) => c[0] && Object.prototype.hasOwnProperty.call(c[0], "tabmailServerHealthy")
  );
  return calls.length ? calls[calls.length - 1][0].tabmailServerHealthy : undefined;
}

const PAYLOAD = { messages: [{ content: "system_prompt_summary", role: "system" }] };

describe("passive server-health signal", () => {
  beforeEach(() => {
    installBrowser();
    resetForbiddenBackoff();
    _resetServerHealthSignal();
    _isAuthErrorReturn = false;
    _handleAuthErrorReturn = false;
  });

  it("marks healthy=true on a 200 response", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true, status: 200 }));
    await sendChatCompletions(PAYLOAD, null, null, true);
    expect(lastHealthWrite()).toBe(true);
  });

  it("marks healthy=false on a 5xx response", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: false, status: 503 }));
    await expect(sendChatCompletions(PAYLOAD, null, null, true)).rejects.toThrow();
    expect(lastHealthWrite()).toBe(false);
  });

  it("marks healthy=true on a non-auth 4xx (server reachable)", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: false, status: 400 }));
    await expect(sendChatCompletions(PAYLOAD, null, null, true)).rejects.toThrow();
    expect(lastHealthWrite()).toBe(true);
  });

  it("marks healthy=true on a 401 auth error (reachable, not an outage)", async () => {
    _isAuthErrorReturn = true;
    _handleAuthErrorReturn = false; // → throws "Authentication required"
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: false, status: 401 }));
    await expect(sendChatCompletions(PAYLOAD, null, null, true)).rejects.toThrow();
    expect(lastHealthWrite()).toBe(true);
  });

  it("marks healthy=false on a network error (fetch throws TypeError)", async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(sendChatCompletions(PAYLOAD, null, null, true)).rejects.toThrow();
    expect(lastHealthWrite()).toBe(false);
  });

  it("does NOT write a health signal on a user-initiated abort", async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    // External abortSignal supplied (truthy) → no internal connect-timeout controller,
    // so this is classified as a user abort, not a server outage.
    await expect(sendChatCompletions(PAYLOAD, {}, null, true)).rejects.toThrow();
    expect(lastHealthWrite()).toBeUndefined();
  });

  it("dedups: steady-state success does not rewrite storage every call", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true, status: 200 }));
    await sendChatCompletions(PAYLOAD, null, null, true);
    await sendChatCompletions(PAYLOAD, null, null, true);
    const healthWrites = setSpy.mock.calls.filter(
      (c) => c[0] && Object.prototype.hasOwnProperty.call(c[0], "tabmailServerHealthy")
    );
    expect(healthWrites).toHaveLength(1);
  });
});
