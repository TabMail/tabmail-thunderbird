/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// byokImportContract.test.js — guards the cross-module IMPORT BINDINGS of the
// BYOK modules against their REAL targets (no vi.mock).
//
// Why this exists: byok.test.js mocks llm.js with vi.mock(), which fabricates a
// `sendChatCompletions` export. That made a real "doesn't provide an export
// named 'sendChatCompletions'" mismatch invisible to the unit tests — it only
// blew up at load time inside Thunderbird. This file loads the modules for REAL
// (with a browser/window stub) so a missing/renamed export fails CI, not prod.

import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  // llm.js (and its transitive imports) register listeners + read storage at
  // module load. Provide a no-op WebExtension surface so the real modules load.
  const onX = () => ({ addListener: () => {}, removeListener: () => {}, hasListener: () => false });
  globalThis.browser = {
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: onX(),
    },
    runtime: { onMessage: onX(), onSuspend: onX(), sendMessage: async () => {}, getManifest: () => ({ version: "1.0.0" }) },
    alarms: { create: () => {}, clear: async () => {}, getAll: async () => [], onAlarm: onX() },
    tabs: { create: async () => {}, onUpdated: onX() },
  };
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
});

describe("BYOK module import bindings (real modules, no mocks)", () => {
  it("llm.js exports sendChatCompletions (the binding byokSmoke imports)", async () => {
    const llm = await import("../agent/modules/llm.js");
    expect(typeof llm.sendChatCompletions).toBe("function");
  });

  it("byokSmoke.js loads against the real llm.js + byokStorage", async () => {
    // Throws "doesn't provide an export named …" here if any import is wrong.
    const smoke = await import("../config/modules/byokSmoke.js");
    expect(typeof smoke.runProviderSmoke).toBe("function");
    expect(typeof smoke.makeSmokeFixture).toBe("function");
    expect(typeof smoke.evaluateCompletion).toBe("function");
  });

  it("byokStorage.js exports the primitives llm.js + byokSettings import", async () => {
    const s = await import("../agent/modules/byokStorage.js");
    for (const name of [
      "TIERS",
      "buildByokPayload",
      "assembleByokPayload",
      "isModelAvailable",
      "getTierProvider",
      "setTierProvider",
      "getTierModel",
      "setTierModel",
      "getProviderKey",
      "setProviderKey",
      "clearProviderKey",
    ]) {
      expect(s[name], `byokStorage must export ${name}`).toBeDefined();
    }
  });

  it("byokSettings.js loads against all its real imports", async () => {
    const settings = await import("../config/modules/byokSettings.js");
    for (const name of ["loadByokSettings", "handleByokChange", "handleByokClick", "handleByokInput"]) {
      expect(typeof settings[name], `byokSettings must export ${name}`).toBe("function");
    }
  });
});
