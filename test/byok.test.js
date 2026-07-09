/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// byok.test.js — BYOK storage payload, model-access, and smoke logic.
// Covers PLAN_BYOK_SUPPORT.md §6.1 (Thunderbird): wire-shape parity with iOS,
// autocomplete never carried, snake_case keys, and the connectivity smoke.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

// byokSmoke imports llm.js (heavy / browser-only) — stub it.
vi.mock("../agent/modules/llm.js", () => ({
  sendChatCompletions: vi.fn(),
}));

// byokSettings imports these for the catalog/list-models fetches — stub them
// the same way (heavy / browser-only); network itself is stubbed per-test via
// globalThis.fetch.
vi.mock("../agent/modules/config.js", () => ({
  getBackendUrl: vi.fn(async () => "https://api.tabmail.ai"),
}));
vi.mock("../agent/modules/supabaseAuth.js", () => ({
  getAccessToken: vi.fn(async () => "test-token"),
}));

function makeStorageMock() {
  const store = {};
  return {
    get: vi.fn(async (defaults) => {
      const out = {};
      if (defaults && typeof defaults === "object") {
        for (const k of Object.keys(defaults)) out[k] = k in store ? store[k] : defaults[k];
      }
      return out;
    }),
    set: vi.fn(async (obj) => { Object.assign(store, obj); }),
    remove: vi.fn(async (k) => { delete store[k]; }),
    _store: store,
  };
}

// A throwing storage.sync so any accidental Firefox-Sync write of a BYOK key
// (which would carry it off-device, violating the §7 "never leaves the device"
// invariant) is caught loudly by the test below.
function makeSyncSpy() {
  return {
    get: vi.fn(async () => { throw new Error("BYOK must not read storage.sync"); }),
    set: vi.fn(async () => { throw new Error("BYOK must not write storage.sync"); }),
    remove: vi.fn(async () => { throw new Error("BYOK must not touch storage.sync"); }),
  };
}

globalThis.browser = { storage: { local: makeStorageMock(), sync: makeSyncSpy() } };

const {
  assembleByokPayload,
  buildByokPayload,
  isModelAvailable,
  setTierProvider,
  setTierModel,
  getTierModel,
  setProviderKey,
  getTierProvider,
} = await import("../agent/modules/byokStorage.js");

const {
  makeSmokeFixture,
  smokeUserMessage,
  evaluateCompletion,
  runProviderSmoke,
} = await import("../config/modules/byokSmoke.js");

const {
  _testExports: byokSettingsTestExports,
  handleByokInput,
  handleByokClick,
} = await import("../config/modules/byokSettings.js");

beforeEach(() => {
  globalThis.browser.storage.local = makeStorageMock();
  globalThis.browser.storage.sync = makeSyncSpy();
});

// ---------------------------------------------------------------------------
describe("assembleByokPayload — wire shape", () => {
  it("maps Light→background, Heavy→interactive with snake_case api_key", () => {
    const out = assembleByokPayload({
      light: { provider: "openai", apiKey: "sk-x", model: "gpt-5.4-mini" },
      heavy: { provider: "anthropic", apiKey: "sk-ant-y", model: "claude-opus-4-7" },
    });
    expect(out).toEqual({
      background: { provider: "openai", api_key: "sk-x", model: "gpt-5.4-mini" },
      interactive: { provider: "anthropic", api_key: "sk-ant-y", model: "claude-opus-4-7" },
    });
  });

  it("never emits an autocomplete tier", () => {
    const out = assembleByokPayload({
      light: { provider: "google", apiKey: "AIza", model: "gemini-3.5-flash" },
    });
    expect(out.autocomplete).toBeUndefined();
    expect(Object.keys(out)).toEqual(["background"]);
  });

  it("omits a tier whose provider is tabmail", () => {
    const out = assembleByokPayload({
      light: { provider: "tabmail", apiKey: "", model: "" },
      heavy: { provider: "openai", apiKey: "sk-x", model: "gpt-5.5" },
    });
    expect(out.background).toBeUndefined();
    expect(out.interactive).toEqual({ provider: "openai", api_key: "sk-x", model: "gpt-5.5" });
  });

  it("omits a tier missing a key or a model", () => {
    expect(assembleByokPayload({ light: { provider: "openai", apiKey: "", model: "gpt-5.5" } })).toEqual({});
    expect(assembleByokPayload({ heavy: { provider: "openai", apiKey: "sk-x", model: "" } })).toEqual({});
  });

  it("returns {} for empty/undefined config", () => {
    expect(assembleByokPayload({})).toEqual({});
    expect(assembleByokPayload(undefined)).toEqual({});
  });
});

describe("buildByokPayload — storage round-trip", () => {
  it("reads saved per-tier provider/model + per-provider key", async () => {
    await setTierProvider("heavy", "openai");
    await setProviderKey("openai", "sk-live-xyz");
    await setTierModel("heavy", "openai", "gpt-5.5");

    const payload = await buildByokPayload();
    expect(payload).toEqual({ interactive: { provider: "openai", api_key: "sk-live-xyz", model: "gpt-5.5" } });
  });

  it("returns {} when both tiers default to tabmail", async () => {
    expect(await buildByokPayload()).toEqual({});
    expect(await getTierProvider("light")).toBe("tabmail");
  });

  it("R-CLIENT-3: never reads or writes storage.sync (keys stay on-device)", async () => {
    // Exercise every BYOK storage write/read path; the throwing sync spy fails
    // the test if any of them touch Firefox Sync.
    await setTierProvider("light", "google");
    await setProviderKey("google", "AIza-secret");
    await setTierModel("light", "google", "gemini-3.5-flash");
    await buildByokPayload();
    expect(browser.storage.sync.set).not.toHaveBeenCalled();
    expect(browser.storage.sync.get).not.toHaveBeenCalled();
    expect(browser.storage.sync.remove).not.toHaveBeenCalled();
  });

  it("shares one key across tiers using the same provider", async () => {
    await setProviderKey("anthropic", "sk-ant-shared");
    await setTierProvider("light", "anthropic");
    await setTierModel("light", "anthropic", "claude-haiku-4-5");
    await setTierProvider("heavy", "anthropic");
    await setTierModel("heavy", "anthropic", "claude-opus-4-7");

    const payload = await buildByokPayload();
    expect(payload.background.api_key).toBe("sk-ant-shared");
    expect(payload.interactive.api_key).toBe("sk-ant-shared");
    expect(payload.background.model).toBe("claude-haiku-4-5");
    expect(payload.interactive.model).toBe("claude-opus-4-7");
  });
});

describe("R-CLIENT-2: TabMail device-sync excludes BYOK keys", () => {
  // deviceSync.js syncs a fixed allow-list of prompt/settings fields off-device
  // (to the sync worker). It must never carry a BYOK key. The allow-list isn't
  // exported, so guard at the source level: deviceSync.js must not reference
  // `byok` at all. If someone wires a BYOK field into the sync envelope, the
  // substring appears and this fails — same intent as iOS R-CLIENT-2.
  it("deviceSync.js does not reference byok", () => {
    const src = readFileSync(new URL("../agent/modules/deviceSync.js", import.meta.url), "utf8");
    expect(src.toLowerCase()).not.toContain("byok");
  });
});

describe("isModelAvailable", () => {
  it("exact match", () => {
    expect(isModelAvailable("gpt-5.5", ["gpt-5.5", "gpt-5.4-mini"])).toBe(true);
  });
  it("Anthropic dated alias match", () => {
    expect(isModelAvailable("claude-haiku-4-5", ["claude-haiku-4-5-20251001"])).toBe(true);
  });
  it("no false positive on a different model", () => {
    expect(isModelAvailable("gpt-5.5", ["gpt-5.4-mini"])).toBe(false);
    expect(isModelAvailable("claude-haiku-4-5", ["claude-haiku-4-5-pro"])).toBe(false); // suffix not digits
  });
  it("tolerates a non-array available list", () => {
    expect(isModelAvailable("gpt-5.5", null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("makeSmokeFixture", () => {
  it("produces a future YYYY-MM-DD with a matching UTC weekday", () => {
    const f = makeSmokeFixture(new Date(Date.UTC(2026, 4, 26)));
    expect(f.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number(f.date.slice(0, 4))).toBe(2031);
    const recomputed = new Date(f.date + "T00:00:00Z");
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    expect(f.dayName).toBe(names[recomputed.getUTCDay()]);
  });
});

describe("smokeUserMessage", () => {
  it("forces date_to_day with the fixture date and forbids guessing", () => {
    const msg = smokeUserMessage({ date: "2031-07-19", dayName: "Saturday" });
    expect(msg).toContain("date_to_day");
    expect(msg).toContain("2031-07-19");
    expect(msg.toLowerCase()).toContain("must call");
  });
});

describe("evaluateCompletion", () => {
  it("passes when routed + non-empty + fragment present", () => {
    expect(evaluateCompletion({ byok_routed: true, assistant: "It is Saturday." }, "Saturday", "OpenAI")).toBeNull();
  });
  it("fails on transport error", () => {
    expect(evaluateCompletion({ err: "network" }, "Saturday", "OpenAI")).toContain("failed");
  });
  it("fails on provider error_code", () => {
    const f = evaluateCompletion({ byok_routed: true, error_code: "byok_key_rejected" }, "Saturday", "OpenAI");
    expect(f).toContain("byok_key_rejected");
  });
  it("fails when not routed (fell back to pool)", () => {
    const f = evaluateCompletion({ byok_routed: false, byok_skip_reason: "tier_entry_invalid" }, "Saturday", "OpenAI");
    expect(f).toContain("did not route");
    expect(f).toContain("tier_entry_invalid");
  });
  it("fails on empty response", () => {
    expect(evaluateCompletion({ byok_routed: true, assistant: "" }, "Saturday", "OpenAI")).toContain("empty");
  });
  it("fails when the expected fragment is missing", () => {
    expect(evaluateCompletion({ byok_routed: true, assistant: "Hello there" }, "Saturday", "OpenAI")).toContain("expected");
  });
});

describe("runProviderSmoke", () => {
  const tier = { ui: "heavy", wire: "interactive", label: "Heavy" };
  const allDays = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday";
  const getCatalog = async () => ({ openai: { interactive: ["gpt-5.5"] } });
  const catalogModelsFor = (cat, p, t) => cat?.[p]?.[t] ?? [];

  it("stops with a clear failure when the key is rejected", async () => {
    const listByokModels = vi.fn(async () => ({ ok: false, error_code: "byok_key_rejected", error_detail: "Incorrect API key" }));
    const failures = await runProviderSmoke({
      provider: "openai", apiKey: "sk-bad", tier, model: "gpt-5.5",
      listByokModels, getCatalog, catalogModelsFor,
      sendFn: vi.fn(),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("byok_key_rejected");
  });

  it("flags a model that is not in the account", async () => {
    const listByokModels = vi.fn(async () => ({ ok: true, models: ["gpt-5.4-mini"] }));
    const sendFn = vi.fn(async () => ({ byok_routed: true, assistant: allDays }));
    const failures = await runProviderSmoke({
      provider: "openai", apiKey: "sk-x", tier, model: "gpt-5.5",
      listByokModels, getCatalog, catalogModelsFor, sendFn,
    });
    expect(failures.some((f) => f.includes("not in your") && f.includes("gpt-5.5"))).toBe(true);
  });

  it("passes when key + model + completion all succeed", async () => {
    const listByokModels = vi.fn(async () => ({ ok: true, models: ["gpt-5.5"] }));
    const sendFn = vi.fn(async () => ({ byok_routed: true, assistant: allDays }));
    const failures = await runProviderSmoke({
      provider: "openai", apiKey: "sk-x", tier, model: "gpt-5.5",
      listByokModels, getCatalog, catalogModelsFor, sendFn,
    });
    expect(failures).toEqual([]);
    // The completion was sent with an explicit interactive BYOK override.
    const sentPayload = sendFn.mock.calls[0][0];
    expect(sentPayload.byok.interactive).toMatchObject({ provider: "openai", api_key: "sk-x", model: "gpt-5.5" });
    expect(sentPayload.messages[0]).toEqual({ role: "system", content: "system_prompt_agent" });
  });

  it("sends the user's saved model VERBATIM even when it's not in the interactive catalog (gateway accepts any id)", async () => {
    // Historical: the smoke used to substitute an interactive-catalog model
    // whenever the saved model wasn't in the interactive catalog (the catalog
    // was the gateway's allow-list, and a Light-only saved pick triggered
    // tier_entry_invalid). The backend now accepts any well-formed id — the
    // catalog is just the recommended list — so Test Connectivity MUST
    // exercise the user's REAL saved model (e.g. a live-only pick from the
    // "All models (from your API key)" group), never a silent stand-in.
    const listByokModels = vi.fn(async () => ({ ok: true, models: ["gemini-3.1-flash-lite", "gemini-3.5-flash"] }));
    const sendFn = vi.fn(async () => ({ byok_routed: true, assistant: allDays }));
    const googleCatalog = async () => ({
      google: { interactive: ["gemini-3.5-flash", "gemini-3.1-pro-preview"] },
    });
    const failures = await runProviderSmoke({
      provider: "google", apiKey: "AIza-x", tier, model: "gemini-3.1-flash-lite",
      listByokModels, getCatalog: googleCatalog, catalogModelsFor, sendFn,
    });
    expect(sendFn.mock.calls[0][0].byok.interactive.model).toBe("gemini-3.1-flash-lite");
    expect(failures).toEqual([]);
  });

  it("falls back to the first interactive-catalog model when nothing is saved", async () => {
    const listByokModels = vi.fn(async () => ({ ok: true, models: ["gemini-3.5-flash"] }));
    const sendFn = vi.fn(async () => ({ byok_routed: true, assistant: allDays }));
    const googleCatalog = async () => ({ google: { interactive: ["gemini-3.5-flash"] } });
    const failures = await runProviderSmoke({
      provider: "google", apiKey: "AIza-x", tier, model: "",
      listByokModels, getCatalog: googleCatalog, catalogModelsFor, sendFn,
    });
    expect(sendFn.mock.calls[0][0].byok.interactive.model).toBe("gemini-3.5-flash");
    expect(failures).toEqual([]);
  });

  it("ignores a noisy list-models accessible set — picks from the catalog, not the intersection", async () => {
    // Real-world Google `/byok/list-models` can return versioned aliases /
    // names that don't textually match the catalog. The smoke must NOT use the
    // accessible set to GATE what it sends — only the catalog gates that.
    const listByokModels = vi.fn(async () => ({ ok: true, models: ["something-weird-v2", "another-name"] }));
    const sendFn = vi.fn(async () => ({ byok_routed: true, assistant: allDays }));
    const googleCatalog = async () => ({ google: { interactive: ["gemini-3.5-flash"] } });
    const failures = await runProviderSmoke({
      provider: "google", apiKey: "AIza-x", tier, model: "gemini-3.5-flash",
      listByokModels, getCatalog: googleCatalog, catalogModelsFor, sendFn,
    });
    // Catalog still drives selection; the user's model "gemini-3.5-flash" is in
    // the catalog so it's sent through.
    expect(sendFn.mock.calls[0][0].byok.interactive.model).toBe("gemini-3.5-flash");
    // But the model-access check (which still uses isModelAvailable vs accessible)
    // correctly reports "not in your account" because the accessible set lacks it.
    expect(failures.some((f) => f.includes("not in your") && f.includes("gemini-3.5-flash"))).toBe(true);
    // The completion still ran — the model-access check is independent of routing.
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it("empty interactive catalog: still tests a saved model verbatim; fails only when nothing is configured at all", async () => {
    const emptyCatalog = async () => ({ google: { interactive: [] } });

    // A saved model with an empty catalog (e.g. a live-only pick) still runs
    // the completion with the saved model — the catalog is not an allow-list.
    const listByokModels = vi.fn(async () => ({ ok: true, models: ["gemini-x-test"] }));
    const sendFn = vi.fn(async () => ({ byok_routed: true, assistant: allDays }));
    const failures = await runProviderSmoke({
      provider: "google", apiKey: "AIza-x", tier, model: "gemini-x-test",
      listByokModels, getCatalog: emptyCatalog, catalogModelsFor, sendFn,
    });
    expect(sendFn.mock.calls[0][0].byok.interactive.model).toBe("gemini-x-test");
    expect(failures).toEqual([]);

    // No saved model AND an empty catalog → clear failure, nothing sent.
    const sendFn2 = vi.fn();
    const failures2 = await runProviderSmoke({
      provider: "google", apiKey: "AIza-x", tier, model: "",
      listByokModels, getCatalog: emptyCatalog, catalogModelsFor, sendFn: sendFn2,
    });
    expect(failures2.some((f) => f.includes("interactive tier"))).toBe(true);
    expect(sendFn2).not.toHaveBeenCalled();
  });

  it("appends a self-diagnostic line on tier_entry_invalid (so the user can spot wrong key length / catalog mismatch)", async () => {
    const listByokModels = vi.fn(async () => ({ ok: true, models: ["gemini-3.5-flash"] }));
    const sendFn = vi.fn(async () => ({ byok_routed: false, byok_skip_reason: "tier_entry_invalid" }));
    const googleCatalog = async () => ({ google: { interactive: ["gemini-3.5-flash"] } });
    const failures = await runProviderSmoke({
      provider: "google", apiKey: "AIza" + "x".repeat(40), tier, model: "gemini-3.5-flash",
      listByokModels, getCatalog: googleCatalog, catalogModelsFor, sendFn,
    });
    // Primary failure (from evaluateCompletion) + a follow-up diagnostic line.
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures.some((f) => f.includes("did not route") && f.includes("tier_entry_invalid"))).toBe(true);
    const diag = failures.find((f) => f.startsWith("↳"));
    expect(diag).toBeDefined();
    expect(diag).toContain("len=44");        // diagnostic surfaces the actual length, no judgment
    expect(diag).toContain('first4="AIza"');
    expect(diag).toContain('model="gemini-3.5-flash"');
    expect(diag).toContain("gemini-3.5-flash"); // catalog list
    expect(diag).toContain("catalog");          // points at the catalog as the now-only-remaining cause
  });

  it("surfaces a provider error from the completion leg", async () => {
    const listByokModels = vi.fn(async () => ({ ok: true, models: ["gpt-5.5"] }));
    const sendFn = vi.fn(async () => ({ byok_routed: true, error_code: "byok_rate_limited", error_detail: "slow down" }));
    const failures = await runProviderSmoke({
      provider: "openai", apiKey: "sk-x", tier, model: "gpt-5.5",
      listByokModels, getCatalog, catalogModelsFor, sendFn,
    });
    expect(failures.some((f) => f.includes("byok_rate_limited"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Model picker: Recommended (catalog) + "All models (from your API key)"
// (live /v1/models via the user's own key). Backend now accepts ANY
// well-formed BYOK model id — the catalog is just the recommended subset.
// ---------------------------------------------------------------------------

describe("dedupeLiveModels", () => {
  const { dedupeLiveModels } = byokSettingsTestExports;

  it("removes an exact match to a Recommended id", () => {
    expect(dedupeLiveModels(["gpt-x-test"], ["gpt-x-test", "gpt-y-test"])).toEqual(["gpt-y-test"]);
  });

  it("removes a dated variant of a dateless Recommended id", () => {
    expect(dedupeLiveModels(["claude-x-test"], ["claude-x-test-20260101", "claude-y-test"])).toEqual([
      "claude-y-test",
    ]);
  });

  it("keeps a live id whose suffix isn't a pure date (not a dated variant)", () => {
    expect(dedupeLiveModels(["claude-x-test"], ["claude-x-test-preview"])).toEqual(["claude-x-test-preview"]);
  });

  it("preserves live list order (backend already sorts it)", () => {
    expect(dedupeLiveModels([], ["z-test", "a-test", "m-test"])).toEqual(["z-test", "a-test", "m-test"]);
  });

  it("returns [] for a non-array live list", () => {
    expect(dedupeLiveModels(["gpt-x-test"], null)).toEqual([]);
    expect(dedupeLiveModels(["gpt-x-test"], undefined)).toEqual([]);
  });

  it("tolerates a non-array recommended list", () => {
    expect(dedupeLiveModels(null, ["gpt-x-test"])).toEqual(["gpt-x-test"]);
  });

  it("dedupes repeated ids within the live list itself (iOS seen-Set parity)", () => {
    expect(dedupeLiveModels([], ["gpt-x-a", "gpt-x-a", "gpt-x-b", "gpt-x-a"])).toEqual(["gpt-x-a", "gpt-x-b"]);
  });
});

describe("computeModelGroups", () => {
  const { computeModelGroups } = byokSettingsTestExports;
  const recommended = ["gpt-x-light", "gpt-x-heavy"];

  it("recommended-only (live null) — selects the saved current when valid", () => {
    const r = computeModelGroups(recommended, null, "gpt-x-heavy");
    expect(r).toEqual({ recommended, live: [], selected: "gpt-x-heavy", changed: false });
  });

  it("recommended-only (live null) — fills the first entry ONLY when current is empty", () => {
    const r = computeModelGroups(recommended, null, "");
    expect(r.selected).toBe("gpt-x-light");
    expect(r.changed).toBe(true);
  });

  it("NEVER overwrites a non-empty current, even when it's in neither group (transient failure safety)", () => {
    // "Absent from one fetch" is not evidence the model is gone — a saved
    // model in neither group must be kept AND not re-persisted.
    const r = computeModelGroups(recommended, null, "gpt-x-my-saved-live-only-model");
    expect(r.selected).toBe("gpt-x-my-saved-live-only-model");
    expect(r.changed).toBe(false);
  });

  it("empty catalog + successful live fetch — fills live[0] only when current is empty", () => {
    const r = computeModelGroups([], ["gpt-x-live-a", "gpt-x-live-b"], "");
    expect(r.selected).toBe("gpt-x-live-a");
    expect(r.changed).toBe(true);
  });

  it("empty catalog + FAILED live fetch (null) — leaves an empty current empty (no persist)", () => {
    const r = computeModelGroups([], null, "");
    expect(r.selected).toBe("");
    expect(r.changed).toBe(false);
  });

  it("merged — keeps current when it's a live-only (non-Recommended) id", () => {
    const r = computeModelGroups(recommended, ["gpt-x-live-only"], "gpt-x-live-only");
    expect(r.live).toEqual(["gpt-x-live-only"]);
    expect(r.selected).toBe("gpt-x-live-only");
    expect(r.changed).toBe(false);
  });

  it("merged — dedupes a dated variant of a Recommended id out of the live group", () => {
    const r = computeModelGroups(["claude-x-test"], ["claude-x-test-20260101", "claude-x-extra"], "claude-x-test");
    expect(r.live).toEqual(["claude-x-extra"]);
    expect(r.selected).toBe("claude-x-test"); // present in Recommended
    expect(r.changed).toBe(false);
  });

  it("merged — a non-empty current in neither group is still kept (never overwritten)", () => {
    const r = computeModelGroups(recommended, ["gpt-x-live-only"], "gpt-x-removed");
    expect(r.selected).toBe("gpt-x-removed");
    expect(r.changed).toBe(false);
  });
});

// --- Minimal hand-rolled DOM (no jsdom dependency in this repo; matches the
// pattern used by test/helpersDom.test.js) covering <select>/<optgroup>/<option>.
function makeMockEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    _children: [],
    value: "",
    label: "",
    disabled: false,
    get textContent() {
      return this._text ?? "";
    },
    set textContent(v) {
      this._text = v;
      if (v === "") this._children = []; // sel.textContent = "" clears options
    },
    appendChild(child) {
      this._children.push(child);
      return child;
    },
  };
  return el;
}

function optgroupLabels(sel) {
  return sel._children.filter((c) => c.tagName === "OPTGROUP").map((g) => g.label);
}

function optgroupValues(sel, label) {
  const g = sel._children.find((c) => c.tagName === "OPTGROUP" && c.label === label);
  return g ? g._children.map((o) => o.value) : null;
}

/** Values of BARE <option> children (a saved model covered by neither group). */
function bareOptionValues(sel) {
  return sel._children.filter((c) => c.tagName === "OPTION").map((o) => o.value);
}

function makeDomRegistry() {
  const registry = {};
  globalThis.document = {
    createElement: (tag) => makeMockEl(tag),
    getElementById: (id) => registry[id] || null,
  };
  return registry;
}

describe("populateModelSelect (DOM integration)", () => {
  const tier = { ui: "light", wire: "background" };
  let registry;

  beforeEach(() => {
    registry = makeDomRegistry();
    byokSettingsTestExports.resetCatalogCache();
    byokSettingsTestExports.resetLiveModelsCache();
    byokSettingsTestExports._setCatalogCache({
      openai: { background: ["gpt-x-light-a", "gpt-x-light-b"] },
    });
  });

  it("renders Recommended-only when the provider has no saved key", async () => {
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;

    await byokSettingsTestExports.populateModelSelect(tier, "openai", vi.fn());

    expect(optgroupLabels(sel)).toEqual(["Recommended"]);
    expect(optgroupValues(sel, "Recommended")).toEqual(["gpt-x-light-a", "gpt-x-light-b"]);
    expect(sel.value).toBe("gpt-x-light-a"); // default = first (cheapest) recommended entry
    expect(sel.disabled).toBe(false);
  });

  it("renders both groups when a key is present, deduping dated variants", async () => {
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    // Pre-seed the live cache directly (isolates DOM/selection logic from the
    // network path, which getLiveModels() tests cover separately).
    byokSettingsTestExports._setLiveModelsCache("openai", ["gpt-x-light-a-20260101", "gpt-x-new"]);

    await byokSettingsTestExports.populateModelSelect(tier, "openai", vi.fn());

    expect(optgroupLabels(sel)).toEqual(["Recommended", "All models (from your API key)"]);
    expect(optgroupValues(sel, "Recommended")).toEqual(["gpt-x-light-a", "gpt-x-light-b"]);
    // The dated variant of gpt-x-light-a is deduped away; the genuinely new id stays.
    expect(optgroupValues(sel, "All models (from your API key)")).toEqual(["gpt-x-new"]);
  });

  it("keeps the saved selection when it's a live-only model", async () => {
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    byokSettingsTestExports._setLiveModelsCache("openai", ["gpt-x-new"]);
    await setTierModel("light", "openai", "gpt-x-new");

    await byokSettingsTestExports.populateModelSelect(tier, "openai", vi.fn());

    expect(sel.value).toBe("gpt-x-new");
    // Selection was valid already — must not have been rewritten in storage.
    expect(await getTierModel("light", "openai")).toBe("gpt-x-new");
  });

  it("(audit a) a saved live-only model SURVIVES a transient live-fetch failure — storage untouched, rendered as an option", async () => {
    // Audit reproduction: saved "gpt-x-my-saved-live-only-model" + fetch throw
    // used to overwrite storage with rec[0]. Must never happen.
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    await setProviderKey("openai", "sk-live-key");
    await setTierModel("light", "openai", "gpt-x-my-saved-live-only-model");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("transient network failure");
    });
    const log = vi.fn();

    await byokSettingsTestExports.populateModelSelect(tier, "openai", log);

    expect(await getTierModel("light", "openai")).toBe("gpt-x-my-saved-live-only-model");
    expect(sel.value).toBe("gpt-x-my-saved-live-only-model");
    // The select must actually DISPLAY the saved choice: a bare <option> is
    // appended (a value with no matching option renders as selectedIndex -1).
    expect(bareOptionValues(sel)).toEqual(["gpt-x-my-saved-live-only-model"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("transient network failure"), "warn");
  });

  it("(audit b) a saved live-only model absent from a SUCCESSFUL live fetch is still kept and rendered", async () => {
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    await setProviderKey("openai", "sk-live-key");
    await setTierModel("light", "openai", "gpt-x-my-saved-live-only-model");
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: true, models: ["gpt-x-other"] }) }));

    await byokSettingsTestExports.populateModelSelect(tier, "openai", vi.fn());

    expect(await getTierModel("light", "openai")).toBe("gpt-x-my-saved-live-only-model");
    expect(sel.value).toBe("gpt-x-my-saved-live-only-model");
    expect(bareOptionValues(sel)).toEqual(["gpt-x-my-saved-live-only-model"]);
    expect(optgroupValues(sel, "All models (from your API key)")).toEqual(["gpt-x-other"]);
  });

  it("(audit c) empty current + empty catalog + successful live fetch — live[0] persisted, picker enabled", async () => {
    byokSettingsTestExports._setCatalogCache({ openai: { background: [] } });
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    await setProviderKey("openai", "sk-live-key");
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: true, models: ["gpt-x-live-a", "gpt-x-live-b"] }) }));

    await byokSettingsTestExports.populateModelSelect(tier, "openai", vi.fn());

    expect(await getTierModel("light", "openai")).toBe("gpt-x-live-a");
    expect(sel.value).toBe("gpt-x-live-a");
    expect(sel.disabled).toBe(false);
    expect(optgroupLabels(sel)).toEqual(["All models (from your API key)"]);
    expect(optgroupValues(sel, "All models (from your API key)")).toEqual(["gpt-x-live-a", "gpt-x-live-b"]);
  });

  it("(audit f) duplicate ids within the live list render only one option", async () => {
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    byokSettingsTestExports._setLiveModelsCache("openai", ["gpt-x-new", "gpt-x-new"]);

    await byokSettingsTestExports.populateModelSelect(tier, "openai", vi.fn());

    expect(optgroupValues(sel, "All models (from your API key)")).toEqual(["gpt-x-new"]);
  });

  it("(audit e) phase-1 race: an older populate resolving later does not clobber the newer render", async () => {
    // The older (openai) call's getTierModel storage read is artificially
    // slowed, so it resolves AFTER the newer (anthropic) call fully rendered.
    // Without a generation check after every await, the older call would clear
    // the select and render openai's Recommended list on top.
    byokSettingsTestExports._setCatalogCache({
      openai: { background: ["gpt-x-light-a"] },
      anthropic: { background: ["claude-x-light-a"] },
    });
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;

    const realGet = globalThis.browser.storage.local.get;
    globalThis.browser.storage.local.get = async (defaults) => {
      const out = await realGet(defaults);
      if (defaults && Object.prototype.hasOwnProperty.call(defaults, "byok.light.openai.model")) {
        await new Promise((r) => setTimeout(r, 25)); // inject latency into the OLDER call only
      }
      return out;
    };

    // Start the older call and let it get PAST the post-getCatalog guard and
    // into its slow getTierModel read before the newer call begins — so the
    // only thing standing between it and the DOM clear is the guard right
    // before the clear (the exact spot the audit's reproduction hit).
    const older = byokSettingsTestExports.populateModelSelect(tier, "openai", vi.fn());
    await new Promise((r) => setTimeout(r, 0));
    const newer = byokSettingsTestExports.populateModelSelect(tier, "anthropic", vi.fn());
    await Promise.all([older, newer]);

    expect(optgroupValues(sel, "Recommended")).toEqual(["claude-x-light-a"]);
    expect(sel.value).toBe("claude-x-light-a");
  });

  it("live-fetch failure (ok:false) falls back to Recommended-only and logs the failure visibly", async () => {
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    await setProviderKey("openai", "sk-live-key");
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: false, error_code: "byok_key_rejected" }) }));
    const log = vi.fn();

    await byokSettingsTestExports.populateModelSelect(tier, "openai", log);

    expect(optgroupLabels(sel)).toEqual(["Recommended"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("byok_key_rejected"), "warn");
  });

  it("live-fetch failure (network throw) falls back to Recommended-only and logs the failure visibly", async () => {
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    await setProviderKey("openai", "sk-live-key");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const log = vi.fn();

    await byokSettingsTestExports.populateModelSelect(tier, "openai", log);

    expect(optgroupLabels(sel)).toEqual(["Recommended"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("network down"), "warn");
  });

  it("guards against a provider switch mid-flight — only the latest call's live group is appended", async () => {
    byokSettingsTestExports._setCatalogCache({
      openai: { background: ["gpt-x-light-a"] },
      anthropic: { background: ["claude-x-light-a"] },
    });
    byokSettingsTestExports._setLiveModelsCache("openai", ["gpt-x-b"]);
    byokSettingsTestExports._setLiveModelsCache("anthropic", ["claude-x-b"]);

    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;

    // Both start before either resolves; anthropic is issued second so it has
    // the higher generation and should "win" the live-group append.
    await Promise.all([
      byokSettingsTestExports.populateModelSelect(tier, "openai", vi.fn()),
      byokSettingsTestExports.populateModelSelect(tier, "anthropic", vi.fn()),
    ]);

    const liveGroups = sel._children.filter((c) => c.label === "All models (from your API key)");
    expect(liveGroups).toHaveLength(1);
    expect(liveGroups[0]._children.map((o) => o.value)).toEqual(["claude-x-b"]);
  });

  it("disables the select and renders no groups when the catalog has no entries for this provider+tier", async () => {
    byokSettingsTestExports._setCatalogCache({ openai: { background: [] } });
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;

    await byokSettingsTestExports.populateModelSelect(tier, "openai", vi.fn());

    expect(sel.disabled).toBe(true);
    expect(sel._children).toEqual([]);
  });
});

describe("getLiveModels (network path)", () => {
  beforeEach(() => {
    byokSettingsTestExports.resetLiveModelsCache();
  });

  it("returns null without fetching when there's no saved key", async () => {
    globalThis.fetch = vi.fn();
    const result = await byokSettingsTestExports.getLiveModels("openai", vi.fn());
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetches and caches the live list on success; a second call reuses the cache", async () => {
    await setProviderKey("openai", "sk-live-key");
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: true, models: ["gpt-x-a", "gpt-x-b"] }) }));

    const first = await byokSettingsTestExports.getLiveModels("openai", vi.fn());
    expect(first).toEqual(["gpt-x-a", "gpt-x-b"]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const second = await byokSettingsTestExports.getLiveModels("openai", vi.fn());
    expect(second).toEqual(["gpt-x-a", "gpt-x-b"]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // cached, no re-fetch
  });

  it("logs a visible warning and returns null on a malformed response", async () => {
    await setProviderKey("openai", "sk-live-key");
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: true, models: "not-an-array" }) }));
    const log = vi.fn();

    const result = await byokSettingsTestExports.getLiveModels("openai", log);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.any(String), "warn");
  });

  it("(audit d) an in-flight fetch resolving AFTER invalidation does not poison the cache (epoch guard)", async () => {
    // Audit reproduction: fetch started with the old key resolves after
    // "Remove key" — its result must NOT be written into _liveModelsCache.
    await setProviderKey("openai", "sk-live-key");
    let resolveFetch;
    globalThis.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const inflight = byokSettingsTestExports.getLiveModels("openai", vi.fn());
    // Let the call reach its fetch await, then invalidate mid-flight (the
    // remove-key / key-replaced scenario bumps the epoch).
    await new Promise((r) => setTimeout(r, 0));
    byokSettingsTestExports.invalidateLiveModels("openai");
    resolveFetch({ json: async () => ({ ok: true, models: ["gpt-x-stale"] }) });
    await inflight;

    // The stale result was returned to its caller (display is the caller's
    // generation-guard problem) but must NOT have been cached: a fresh call
    // re-fetches and sees the new list.
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: true, models: ["gpt-x-fresh"] }) }));
    const fresh = await byokSettingsTestExports.getLiveModels("openai", vi.fn());
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // re-fetched, not served from a poisoned cache
    expect(fresh).toEqual(["gpt-x-fresh"]);
  });
});

describe("refreshProviderModels — cache invalidation on key save/clear", () => {
  const tier = { ui: "heavy", wire: "interactive" };

  beforeEach(() => {
    byokSettingsTestExports.resetCatalogCache();
    byokSettingsTestExports.resetLiveModelsCache();
    byokSettingsTestExports._setCatalogCache({ anthropic: { interactive: ["claude-x-heavy"] } });
  });

  it("invalidates the cached live list so a subsequent populate re-fetches", async () => {
    const registry = makeDomRegistry();
    const sel = makeMockEl("select");
    registry["byok-heavy-model"] = sel;
    await setTierProvider("heavy", "anthropic");

    byokSettingsTestExports._setLiveModelsCache("anthropic", ["claude-x-old"]);
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: true, models: ["claude-x-fresh"] }) }));
    await setProviderKey("anthropic", "sk-ant-new");

    await byokSettingsTestExports.refreshProviderModels("anthropic", vi.fn());

    // The stale seeded cache is gone; refreshProviderModels re-fetched via the
    // (mocked) network and the fresh list is what's rendered.
    expect(optgroupValues(sel, "All models (from your API key)")).toEqual(["claude-x-fresh"]);
  });
});

describe("handleByokInput / handleByokClick — live-model refresh wiring", () => {
  beforeEach(() => {
    byokSettingsTestExports.resetCatalogCache();
    byokSettingsTestExports.resetLiveModelsCache();
    byokSettingsTestExports._setCatalogCache({ openai: { background: ["gpt-x-a"] } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("handleByokInput (key saved as typed) debounces the live-model refresh", async () => {
    vi.useFakeTimers();
    const registry = makeDomRegistry();
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    await setTierProvider("light", "openai");
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: true, models: ["gpt-x-new"] }) }));

    const e = { target: { id: "byok-key-openai-input", value: "sk-live-key" } };
    await handleByokInput(e, vi.fn());

    // Not fired yet — still debouncing.
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(byokSettingsTestExports.BYOK_LIVE_REFRESH_DEBOUNCE_MS);

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(optgroupValues(sel, "All models (from your API key)")).toEqual(["gpt-x-new"]);
  });

  it("handleByokInput coalesces rapid keystrokes into a single refresh", async () => {
    vi.useFakeTimers();
    const registry = makeDomRegistry();
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    await setTierProvider("light", "openai");
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: true, models: ["gpt-x-new"] }) }));

    for (const partial of ["s", "sk", "sk-l", "sk-live-key"]) {
      await handleByokInput({ target: { id: "byok-key-openai-input", value: partial } }, vi.fn());
    }

    await vi.advanceTimersByTimeAsync(byokSettingsTestExports.BYOK_LIVE_REFRESH_DEBOUNCE_MS);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("handleByokClick's remove handler drops the live group immediately (no debounce wait)", async () => {
    const registry = makeDomRegistry();
    const sel = makeMockEl("select");
    registry["byok-light-model"] = sel;
    await setTierProvider("light", "openai");
    await setProviderKey("openai", "sk-live-key");
    byokSettingsTestExports._setLiveModelsCache("openai", ["gpt-x-old"]);
    await byokSettingsTestExports.populateModelSelect({ ui: "light", wire: "background" }, "openai", vi.fn());
    expect(optgroupValues(sel, "All models (from your API key)")).toEqual(["gpt-x-old"]);

    const clickEvent = {
      target: { id: "byok-key-openai-remove", closest: () => ({ id: "byok-key-openai-remove" }) },
    };
    const handled = await handleByokClick(clickEvent, vi.fn());

    expect(handled).toBe(true);
    // Key removed -> no key -> live group dropped, no timer needed.
    expect(optgroupLabels(sel)).toEqual(["Recommended"]);
  });

  it("handleByokClick's remove handler cancels a pending debounced refresh", async () => {
    vi.useFakeTimers();
    await setTierProvider("light", "openai");

    await handleByokInput({ target: { id: "byok-key-openai-input", value: "sk-live-key" } }, vi.fn());
    expect(byokSettingsTestExports._hasScheduledLiveModelsRefresh("openai")).toBe(true);

    const clickEvent = {
      target: { id: "byok-key-openai-remove", closest: () => ({ id: "byok-key-openai-remove" }) },
    };
    await handleByokClick(clickEvent, vi.fn());

    expect(byokSettingsTestExports._hasScheduledLiveModelsRefresh("openai")).toBe(false);
  });
});
