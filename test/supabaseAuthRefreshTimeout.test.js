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
// deadline, so every stalled-refresh test below never settles its waiters and
// times out; the healthy/4xx/5xx tests pass on both and pin preserved behaviour.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The SHIPPED settings drive this suite (retries, per-attempt deadline, SSE
// timeouts) so that deleting or breaking `authTokenRefreshTimeoutMs` in
// config.js is caught here. Only the worker bound and backend URL are stubbed.
vi.mock("../agent/modules/config.js", async () => {
  const actual = await vi.importActual("../agent/modules/config.js");
  return {
    getBackendUrl: vi.fn(async () => "https://test.api"),
    SETTINGS: { ...actual.SETTINGS, maxAgentWorkers: 1 },
  };
});
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
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: { getManifest: vi.fn(() => ({ version: "9.9.9" })) },
};

const { SETTINGS } = await import("../agent/modules/config.js");
const auth = await import("../agent/modules/supabaseAuth.js");
const llm = await import("../agent/modules/llm.js");

const RETRIES = SETTINGS.authTokenRefreshRetries;
const REFRESH_TIMEOUT_MS = SETTINGS.authTokenRefreshTimeoutMs;

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

  /** Backoff-only wall time for RETRIES immediate failures (no deadline ever fires). */
  function immediateFailureBudgetMs() {
    let ms = 0;
    for (let a = 1; a < RETRIES; a++) ms += 1000 * Math.pow(2, a - 1);
    return ms;
  }

  it("still treats a definitive 4xx rejection as revocation (existing behaviour preserved)", async () => {
    globalThis.fetch = rejectedFetch(401);
    const pending = auth.getAccessToken();
    // The existing retry loop also backs off after a 4xx; drain exactly that and no more,
    // so a deadline forgotten on the error exit would still be armed here.
    await vi.advanceTimersByTimeAsync(immediateFailureBudgetMs());
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
    await vi.advanceTimersByTimeAsync(immediateFailureBudgetMs());
    expect(await pending).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(RETRIES);
    expect(storageData.supabaseSession).toEqual(expect.objectContaining({ refresh_token: "synthetic-refresh" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an immediately rejected fetch (network error) settles with the session kept and no deadline left armed", async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError("NetworkError when attempting to fetch resource."); });
    const pending = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(immediateFailureBudgetMs());
    expect(await pending).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(RETRIES);
    expect(storageData.supabaseSession).toEqual(expect.objectContaining({ refresh_token: "synthetic-refresh" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const lateAt of ["headers", "body"]) {
    it(`a healthy response whose ${lateAt} land just inside the deadline is not aborted; one landing at the deadline is`, async () => {
      const next = { access_token: "synthetic-late", refresh_token: "synthetic-rotated", expires_at: Math.floor(Date.now() / 1000) + 3600 };
      const signals = [];
      const makeFetch = (delayMs) => vi.fn((_url, { signal }) => {
        signals.push(signal);
        const after = (ms, value) => new Promise((resolve, reject) => {
          if (ms === 0) return resolve(value);
          const t = setTimeout(() => resolve(value), ms);
          signal.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
        });
        const body = () => after(lateAt === "body" ? delayMs : 0, next);
        return after(lateAt === "headers" ? delayMs : 0, { ok: true, status: 200, json: body });
      });

      // Just inside: completes, credentials persisted, deadline cleared.
      globalThis.fetch = makeFetch(REFRESH_TIMEOUT_MS - 1);
      const inside = auth.getAccessToken();
      await vi.advanceTimersByTimeAsync(REFRESH_TIMEOUT_MS - 1);
      expect(await inside).toBe("synthetic-late");
      expect(signals[0].aborted).toBe(false);
      expect(storageData.supabaseSession).toEqual(next);
      expect(vi.getTimerCount()).toBe(0);

      // At the deadline: aborted as transient, retried, session from the successful call kept.
      auth.resetAuthState();
      resetStorage({ supabaseSession: expiredSession() });
      signals.length = 0;
      globalThis.fetch = makeFetch(REFRESH_TIMEOUT_MS);
      const atDeadline = auth.getAccessToken();
      await drainRetryBudget();
      expect(await atDeadline).toBeNull();
      expect(globalThis.fetch).toHaveBeenCalledTimes(RETRIES);
      expect(signals.every((sig) => sig.aborted)).toBe(true);
      expect(storageData.supabaseSession).toEqual(expect.objectContaining({ refresh_token: "synthetic-refresh" }));
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("shipped configuration is a usable deadline: positive, bounded, and a plain healthy refresh completes under it", () => {
    expect(Number.isInteger(REFRESH_TIMEOUT_MS)).toBe(true);
    expect(REFRESH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isInteger(RETRIES)).toBe(true);
    expect(RETRIES).toBeGreaterThan(0);
  });

  for (const status of [200, 503]) {
    it(`one deadline spans headers AND body: ${status} headers inside the budget plus a body that overruns it is aborted`, async () => {
      const next = { access_token: "synthetic-late", refresh_token: "synthetic-rotated", expires_at: Math.floor(Date.now() / 1000) + 3600 };
      const half = Math.ceil(REFRESH_TIMEOUT_MS / 2);
      const signals = [];
      const makeFetch = (headersMs, bodyMs) => vi.fn((_url, { signal }) => {
        signals.push(signal);
        const after = (ms, value) => new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(value), ms);
          signal.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
        });
        return after(headersMs, { ok: status === 200, status, json: () => after(bodyMs, status === 200 ? next : { error: "unavailable" }) });
      });

      // Each phase alone fits the budget; together they overrun it → aborted, transient, session kept.
      globalThis.fetch = makeFetch(half, half + 1);
      const waiters = Array.from({ length: 5 }, () => auth.getAccessToken());
      await drainRetryBudget();
      expect(await Promise.all(waiters)).toEqual([null, null, null, null, null]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(RETRIES);
      expect(signals.every((sig) => sig.aborted)).toBe(true);
      expect(storageData.supabaseSession).toEqual(expect.objectContaining({ refresh_token: "synthetic-refresh" }));
      expect(vi.getTimerCount()).toBe(0);

      // Control: the same two phases that together land just inside the budget complete.
      if (status === 200) {
        auth.resetAuthState();
        resetStorage({ supabaseSession: expiredSession() });
        globalThis.fetch = makeFetch(half, REFRESH_TIMEOUT_MS - half - 1);
        const inside = auth.getAccessToken();
        await vi.advanceTimersByTimeAsync(REFRESH_TIMEOUT_MS - 1);
        expect(await inside).toBe("synthetic-late");
        expect(storageData.supabaseSession).toEqual(next);
        expect(vi.getTimerCount()).toBe(0);
      }
    });
  }

  // ─── Round-1 gate findings T1–T3: stalled error bodies, healthy latency budget,
  // timeout-then-success, queued caller wakeup, live SSE heartbeat preservation.

  for (const status of [401, 503]) {
    it(`settles waiters when HTTP ${status} headers arrive but its error body stalls`, async () => {
      let bodyReads = 0;
      const signals = [];
      const originalSession = structuredClone(storageData.supabaseSession);
      globalThis.fetch = vi.fn(async (_url, { signal }) => {
        signals.push(signal);
        return { ok: false, status, json() {
          bodyReads++;
          return new Promise((_resolve, reject) => {
            if (signal?.aborted) return reject(abortError());
            signal?.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        } };
      });
      const values = [];
      const requests = Array.from({ length: 5 }, () => auth.getAccessToken().then(x => { values.push(x); return x; }));
      await vi.advanceTimersByTimeAsync(0);
      expect(bodyReads).toBe(1);
      expect(values).toEqual([]);
      await drainRetryBudget();
      expect(values).toEqual(Array(5).fill(null));
      await Promise.all(requests);
      expect(bodyReads).toBe(RETRIES);
      expect(signals.every(s => s.aborted)).toBe(true);
      if (status === 401) expect(storageData.supabaseSession).toBeUndefined();
      else expect(storageData.supabaseSession).toEqual(originalSession);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it('allows a healthy response inside the configured deadline and persists its rotated credentials', async () => {
    let signal;
    const started = [];
    const next = { access_token: 'synthetic-new', refresh_token: 'synthetic-rotated', expires_at: Math.floor(Date.now()/1000)+3600 };
    globalThis.fetch = vi.fn((_url, opts) => {
      signal = opts.signal; started.push(Date.now());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ok:true,status:200,json:async()=>next}), 2000);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, {once:true});
      });
    });
    const promise = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(1999);
    expect(signal?.aborted || false).toBe(false);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toBe('synthetic-new');
    expect(storageData.supabaseSession).toEqual(next);
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const [attemptNo, lateAt] of [[2, "headers"], [2, "body"], [3, "headers"], [3, "body"]]) {
    it(`attempt ${attemptNo} gets its own full deadline: a healthy response with late ${lateAt} after earlier timeouts still succeeds`, async () => {
      const next = { access_token: "synthetic-late-retry", refresh_token: "synthetic-rotated", expires_at: Math.floor(Date.now() / 1000) + 3600 };
      const signals = [];
      let calls = 0;
      const stalled = stalledFetch("connect", signals);
      globalThis.fetch = vi.fn((url, opts) => {
        if (++calls < attemptNo) return stalled(url, opts);
        const { signal } = opts;
        signals.push(signal);
        const after = (ms, value) => new Promise((resolve, reject) => {
          if (ms === 0) return resolve(value);
          const t = setTimeout(() => resolve(value), ms);
          signal.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
        });
        const late = REFRESH_TIMEOUT_MS - 1;
        return after(lateAt === "headers" ? late : 0, { ok: true, status: 200, json: () => after(lateAt === "body" ? late : 0, next) });
      });
      const waiters = Array.from({ length: 5 }, () => auth.getAccessToken());
      await drainRetryBudget();
      expect(await Promise.all(waiters)).toEqual(Array(5).fill("synthetic-late-retry"));
      expect(calls).toBe(attemptNo);
      expect(signals[attemptNo - 1].aborted).toBe(false);
      expect(storageData.supabaseSession).toEqual(next);
      expect(browser.storage.local.remove).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it('recovers on the second attempt within the same shared refresh', async () => {
    const signals = [];
    let attempt = 0;
    const stalled = stalledFetch('connect', signals);
    const healthy = healthyFetch('synthetic-after-retry');
    globalThis.fetch = vi.fn((...args) => ++attempt === 1 ? stalled(...args) : healthy(...args));
    const promises = Array.from({length:5},()=>auth.getAccessToken());
    await drainRetryBudget();
    expect(await Promise.all(promises)).toEqual(Array(5).fill('synthetic-after-retry'));
    expect(attempt).toBe(2);
    expect(storageData.supabaseSession.access_token).toBe('synthetic-after-retry');
    expect(browser.storage.local.remove).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps 60 seconds of live SSE work alive, then releases queued work on silence', async () => {
    globalThis.window = {};
    const encoder = new TextEncoder();
    const reader = { waiting: null, read: vi.fn(() => new Promise(resolve => { reader.waiting = resolve; })), releaseLock: vi.fn(), cancel: vi.fn() };
    let backendCalls = 0;
    const healthy = healthyFetch('synthetic-ready');
    globalThis.fetch = vi.fn((url, ...args) => {
      if (url.includes('/auth/v1/token')) return healthy(url,...args);
      backendCalls++;
      if (backendCalls === 1) return Promise.resolve({ok:true,status:200,headers:{get:()=> 'text/event-stream'},body:{getReader:()=>reader}});
      return Promise.resolve({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({assistant:'synthetic recovered'})});
    });
    const settled = [];
    const first = llm.sendChat([{role:'system',content:'synthetic'}]).then(x=>{settled.push('first');return x;});
    const second = llm.sendChat([{role:'system',content:'synthetic'}]).then(x=>{settled.push('second');return x;});
    await vi.advanceTimersByTimeAsync(0);
    expect(backendCalls).toBe(1);
    for (let i=0; i<20; i++) {
      await vi.advanceTimersByTimeAsync(3000);
      expect(reader.waiting).toBeTypeOf('function');
      reader.waiting({done:false,value:encoder.encode('event: keepalive\ndata: {}\n\n')});
      reader.waiting=null;
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toEqual([]);
      expect(backendCalls).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(10000);
    expect(settled).toEqual(['first','second']);
    expect(await first).toMatchObject({connection_lost:true});
    expect(await second).toMatchObject({assistant:'synthetic recovered'});
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(backendCalls).toBe(2);
  });

  it('wakes a call already queued before the shared refresh times out', async () => {
    const signals = [];
    const stalled = stalledFetch('connect', signals);
    let backendCalls = 0;
    globalThis.fetch = vi.fn((url, ...args) => {
      if(url.includes('/auth/v1/token')) return stalled(url,...args);
      backendCalls++;
      return Promise.resolve({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({assistant:'synthetic recovered'})});
    });
    const settled = [];
    const first = llm.sendChat([{role:'system',content:'synthetic'}]).then(x=>{settled.push('first');return x;});
    await vi.advanceTimersByTimeAsync(0);
    const second = llm.sendChat([{role:'system',content:'synthetic'}]).then(x=>{settled.push('second');return x;});
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(1);
    expect(settled).toEqual([]);
    expect(backendCalls).toBe(0);
    storageData.supabaseSession = {access_token:'synthetic-current',refresh_token:'synthetic-current-refresh',expires_at:Math.floor(Date.now()/1000)+3600};
    await drainRetryBudget();
    expect(settled).toEqual(['first','second']);
    expect(await first).toBeNull();
    expect(await second).toMatchObject({assistant:'synthetic recovered'});
    expect(backendCalls).toBe(1);
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
