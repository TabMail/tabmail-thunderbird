/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// supabaseAuthRefreshTimeout.test.js — issue #55: a token refresh that never
// answers must not wedge every caller behind the shared refresh promise.
//
// Invariant pinned here (not the mechanism): when the refresh endpoint stalls —
// either before headers or while the body is being read — every getAccessToken()
// waiter settles within the bounded retry budget, the stored session survives
// (transient failure), the shared in-progress slot clears so a later healthy
// refresh can run, no timers leak, and a downstream sendChat() releases its
// semaphore slot so queued AI work stays retryable.
//
// Red-before evidence: on pre-fix supabaseAuth.js the stalled fetch has no
// deadline, so the waiters never settle and every test below times out.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const RETRIES = 3;
const REFRESH_TIMEOUT_MS = 5000;

vi.mock("../agent/modules/config.js", () => ({
  getBackendUrl: vi.fn(async () => "https://test.api"),
  SETTINGS: {
    supabaseUrl: "https://auth.example.com",
    supabaseAnonKey: "test-anon-key",
    authTokenRefreshRetries: RETRIES,
    authTokenRefreshTimeoutMs: REFRESH_TIMEOUT_MS,
    // llm.js settings for the downstream slot-release test
    sseMaxTimeoutSec: 600,
    sseToolListenTimeoutSec: 600,
    maxAgentWorkers: 1,
  },
}));
vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn(), normalizeUnicode: (s) => s }));
vi.mock("../agent/modules/thinkBuffer.js", () => ({ setThink: vi.fn() }));
vi.mock("../chat/modules/privacySettings.js", () => ({ assertAiBackendAllowed: vi.fn(async () => {}) }));
vi.mock("../agent/modules/byokStorage.js", () => ({ buildByokPayload: vi.fn(async () => null) }));
vi.mock("../config/modules/webSearch.js", () => ({ getWebSearchEnabled: vi.fn(async () => false) }));

// ─── Storage mock ────────────────────────────────────────────────────────────

const storageData = {};
function resetStorage(data) {
  for (const k of Object.keys(storageData)) delete storageData[k];
  Object.assign(storageData, data);
}

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (key) => (storageData[key] !== undefined ? { [key]: storageData[key] } : {})),
      set: vi.fn(async (obj) => { Object.assign(storageData, obj); }),
      remove: vi.fn(async (key) => { delete storageData[key]; }),
    },
  },
  runtime: { getManifest: vi.fn(() => ({ version: "9.9.9" })) },
};

const auth = await import("../agent/modules/supabaseAuth.js");
const llm = await import("../agent/modules/llm.js");

// ─── Fetch models ────────────────────────────────────────────────────────────

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * A fetch that never answers on its own. It only ever settles by rejecting
 * with AbortError when the caller's signal fires — exactly what a real fetch
 * does. `stallAt: "connect"` parks before headers; `stallAt: "body"` returns
 * headers immediately and parks inside response.json().
 */
function stalledFetch(stallAt, signals) {
  return vi.fn((_url, opts = {}) => {
    const signal = opts.signal;
    signals.push(signal);
    return new Promise((resolve, reject) => {
      if (!signal) return; // pre-fix shape: nothing can ever settle this
      if (signal.aborted) return reject(abortError());
      if (stallAt === "connect") {
        signal.addEventListener("abort", () => reject(abortError()));
        return;
      }
      resolve({
        ok: true,
        status: 200,
        json: () => new Promise((_res, rej) => {
          if (signal.aborted) return rej(abortError());
          signal.addEventListener("abort", () => rej(abortError()));
        }),
      });
    });
  });
}

function healthyFetch(newToken) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: newToken,
      refresh_token: "synthetic-refresh-2",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  }));
}

function rejectedFetch(status) {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({ error: "invalid_grant" }),
  }));
}

function expiredSession() {
  return {
    access_token: "synthetic-old",
    refresh_token: "synthetic-refresh",
    expires_at: Math.floor(Date.now() / 1000) - 1,
  };
}

/** Total wall time for RETRIES stalled attempts plus the 1s/2s/... backoffs. */
function exhaustedBudgetMs() {
  let ms = RETRIES * REFRESH_TIMEOUT_MS;
  for (let a = 1; a < RETRIES; a++) ms += 1000 * Math.pow(2, a - 1);
  return ms;
}

/** Settle the whole retry budget: each abort schedules the next attempt's timer. */
async function drainRetryBudget() {
  await vi.advanceTimersByTimeAsync(exhaustedBudgetMs());
}

beforeEach(() => {
  vi.useFakeTimers();
  auth.resetAuthState();
  browser.storage.local.remove.mockClear();
  resetStorage({ supabaseSession: expiredSession() });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("token refresh timeout (issue #55)", () => {
  for (const stallAt of ["connect", "body"]) {
    describe(`refresh stalled at ${stallAt}`, () => {
      it("settles every concurrent waiter, keeps the session, and lets a later healthy refresh run", async () => {
        const signals = [];
        globalThis.fetch = stalledFetch(stallAt, signals);

        const settled = [];
        const waiters = Array.from({ length: 5 }, () =>
          auth.getAccessToken().then((r) => { settled.push(r); return r; })
        );
        await vi.advanceTimersByTimeAsync(0);

        // One shared refresh, one deadline armed for it. Nobody has settled yet.
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
        expect(settled).toHaveLength(0);

        // Expiry must abort the HTTP operation itself, not just the waiter.
        await vi.advanceTimersByTimeAsync(REFRESH_TIMEOUT_MS);
        expect(signals[0]).toBeTruthy();
        expect(signals[0].aborted).toBe(true);

        await drainRetryBudget();
        const results = await Promise.all(waiters);

        expect(results).toEqual([null, null, null, null, null]);
        expect(globalThis.fetch).toHaveBeenCalledTimes(RETRIES);
        expect(signals.every((s) => s && s.aborted)).toBe(true);
        // Transient failure: stored session is preserved for a later retry.
        expect(storageData.supabaseSession).toEqual(expect.objectContaining({ refresh_token: "synthetic-refresh" }));
        expect(browser.storage.local.remove).not.toHaveBeenCalled();
        // No leaked deadline timers.
        expect(vi.getTimerCount()).toBe(0);

        // Recovery: the shared in-progress slot cleared, a fresh refresh starts and completes.
        globalThis.fetch = healthyFetch("synthetic-new");
        const token = await auth.getAccessToken();
        expect(token).toBe("synthetic-new");
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(storageData.supabaseSession.access_token).toBe("synthetic-new");
        expect(vi.getTimerCount()).toBe(0);
      });
    });
  }

  it("clears the deadline timer after a successful refresh", async () => {
    globalThis.fetch = healthyFetch("synthetic-new");
    const token = await auth.getAccessToken();
    expect(token).toBe("synthetic-new");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still treats a definitive 4xx rejection as revocation (existing behaviour preserved)", async () => {
    globalThis.fetch = rejectedFetch(401);
    const pending = auth.getAccessToken();
    // The existing retry loop also backs off after a 4xx; drain it unchanged.
    await drainRetryBudget();
    const token = await pending;
    expect(token).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(RETRIES);
    expect(storageData.supabaseSession).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still treats a 5xx as transient: session kept, no timer left behind (existing behaviour preserved)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "unavailable", error_description: "synthetic outage" }),
    }));
    const pending = auth.getAccessToken();
    await drainRetryBudget();
    expect(await pending).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(RETRIES);
    expect(storageData.supabaseSession).toEqual(expect.objectContaining({ refresh_token: "synthetic-refresh" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stalled refresh releases the downstream AI semaphore slot so the next call proceeds", async () => {
    // maxAgentWorkers is 1: if the first sendChat never unwinds, the second can never start.
    const signals = [];
    globalThis.fetch = stalledFetch("connect", signals);

    const first = llm.sendChat([{ role: "system", content: "synthetic" }]);
    await vi.advanceTimersByTimeAsync(0);
    await drainRetryBudget();
    // Auth failed transiently → sendChat returns null (retryable by the caller), no throw.
    await expect(first).resolves.toBeNull();

    // Token now valid and the backend answers: the slot must have been released.
    resetStorage({ supabaseSession: { ...expiredSession(), expires_at: Math.floor(Date.now() / 1000) + 3600 } });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ assistant: "ok" }),
      text: async () => "",
    }));
    const secondPromise = llm.sendChat([{ role: "system", content: "synthetic" }]);
    await vi.advanceTimersByTimeAsync(0);
    const second = await secondPromise;
    expect(second).toEqual(expect.objectContaining({ assistant: "ok" }));
  });
});
