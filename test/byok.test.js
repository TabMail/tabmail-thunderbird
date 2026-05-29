// byok.test.js — BYOK storage payload, model-access, and smoke logic.
// Covers PLAN_BYOK_SUPPORT.md §6.1 (Thunderbird): wire-shape parity with iOS,
// autocomplete never carried, snake_case keys, and the connectivity smoke.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// byokSmoke imports llm.js (heavy / browser-only) — stub it.
vi.mock("../agent/modules/llm.js", () => ({
  sendChatCompletions: vi.fn(),
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
  setProviderKey,
  getTierProvider,
} = await import("../agent/modules/byokStorage.js");

const {
  makeSmokeFixture,
  smokeUserMessage,
  evaluateCompletion,
  runProviderSmoke,
} = await import("../config/modules/byokSmoke.js");

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

  it("picks an interactive-catalog model when the user's saved model is non-interactive (Light-only) — fixes Google tier_entry_invalid", async () => {
    // Repro of the user-reported bug: Light tier configured with a model that is
    // ONLY in Google's autocomplete/background catalogs (gemini-3.1-flash-lite),
    // not interactive. The smoke sends through system_prompt_agent (→
    // interactive), so it MUST pick from interactiveModels — never fall back to
    // the user's saved Light-only model, which the backend rejects as
    // `tier_entry_invalid`.
    const listByokModels = vi.fn(async () => ({ ok: true, models: ["gemini-3.1-flash-lite", "gemini-3.5-flash"] }));
    const sendFn = vi.fn(async () => ({ byok_routed: true, assistant: allDays }));
    const googleCatalog = async () => ({
      google: { interactive: ["gemini-3.5-flash", "gemini-3.1-pro-preview"] },
    });
    const failures = await runProviderSmoke({
      provider: "google", apiKey: "AIza-x", tier, model: "gemini-3.1-flash-lite",
      listByokModels, getCatalog: googleCatalog, catalogModelsFor, sendFn,
    });
    const sentModel = sendFn.mock.calls[0][0].byok.interactive.model;
    expect(["gemini-3.5-flash", "gemini-3.1-pro-preview"]).toContain(sentModel);
    expect(sentModel).not.toBe("gemini-3.1-flash-lite");
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

  it("fails clearly when the interactive catalog is empty (no model to send)", async () => {
    const listByokModels = vi.fn(async () => ({ ok: true, models: ["anything"] }));
    const sendFn = vi.fn();
    const emptyCatalog = async () => ({ google: { interactive: [] } });
    const failures = await runProviderSmoke({
      provider: "google", apiKey: "AIza-x", tier, model: "gemini-3.5-flash",
      listByokModels, getCatalog: emptyCatalog, catalogModelsFor, sendFn,
    });
    expect(failures.some((f) => f.includes("interactive tier"))).toBe(true);
    expect(sendFn).not.toHaveBeenCalled();
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
