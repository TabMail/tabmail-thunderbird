/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The backend picks the add-on's prompts and chat tools by the protocol version
// it sends (`X-Client-Protocol`). Every completions request carries it: the
// first send, the retry after a rate limit, and the retry after a new sign-in.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../agent/modules/config.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getBackendUrl: async () => "https://backend.example.com",
}));
vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn(), normalizeUnicode: (t) => t }));
vi.mock("../agent/modules/thinkBuffer.js", () => ({ setThink: vi.fn() }));
vi.mock("../chat/modules/privacySettings.js", () => ({ assertAiBackendAllowed: vi.fn() }));
vi.mock("../config/modules/webSearch.js", () => ({ getWebSearchEnabled: async () => false }));
vi.mock("../agent/modules/byokStorage.js", () => ({ buildByokPayload: async () => null }));
vi.mock("../chat/chat.js", () => ({ createNewAgentBubble: async () => ({ classList: { add() {} }, remove() {} }) }));
vi.mock("../chat/modules/helpers.js", () => ({ setBubbleText: vi.fn() }));
vi.mock("../agent/modules/supabaseAuth.js", () => ({
  getAccessToken: vi.fn(async () => "access-token"),
  isAuthError: (response) => response.status === 401 || response.status === 403,
  handleAuthError: vi.fn(async () => true),
}));

const ADDON_VERSION = "9.8.7";

globalThis.window = globalThis.window || {};
globalThis.browser = {
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { getManifest: () => ({ version: ADDON_VERSION }) },
};

const { SETTINGS } = await import("../agent/modules/config.js");
const { sendChatCompletions, _testExports } = await import("../agent/modules/llm.js");

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("completions request headers", () => {
  beforeEach(() => {
    _testExports.resetForbiddenBackoff();
  });

  it("send the protocol version and the add-on version on the first send and on both retries", async () => {
    const responses = [
      json(429, { retry_after_seconds: 0.001 }), // first send: rate limited
      json(403, { error: "forbidden" }), // the retry after the wait: sign-in expired
      json(500, { error: "unavailable" }), // the retry after a new sign-in
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendChatCompletions({ messages: [{ role: "user", content: "hello" }] }, null, null, true),
    ).rejects.toThrow("Request failed after re-auth: 500");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(SETTINGS.protocolVersion).toMatch(/^\d+\.\d+\.\d+$/);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options.headers).toEqual({
        "Content-Type": "application/json",
        "Authorization": "Bearer access-token",
        "X-Client-Version": ADDON_VERSION,
        "X-Client-Protocol": SETTINGS.protocolVersion,
      });
    }
    vi.unstubAllGlobals();
  });
});
