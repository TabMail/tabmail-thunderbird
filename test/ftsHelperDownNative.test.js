/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #175, over the real native adapter (nativeEngine.js) and a stand-in helper
// port, so readiness, the missing error and the connect wait are the real ones.
//
// 1. A page's memory-changing request is refused while the helper is missing,
//    and waits while it connects: it never changes memory before the helper is
//    ready, and it is never answered with a success the helper did not give.
// 2. One storage failure while the engine starts must not leave search down for
//    the rest of the session: once storage works again, the background's own
//    recheck (alarm or a UI's availability probe) brings search back.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { memoryManagement: { nativeRpcTimeoutMs: 60000, memorySizeLimitDefaultBytes: 1024 ** 3, memorySizeLimitChoicesBytes: [1024 ** 3] } },
}));
vi.mock('../fts/incrementalIndexer.js', () => ({ initIncrementalIndexer: vi.fn(async () => {}) }));
vi.mock('../fts/maintenanceScheduler.js', () => ({ initMaintenanceScheduler: vi.fn(async () => {}) }));
vi.mock('../fts/memoryIndexer.js', () => ({ migrateExistingChatHistory: vi.fn(async () => ({ migrated: false })) }));
vi.mock('../fts/indexer.js', () => ({ indexMessages: vi.fn(async () => ({ ok: true, scanned: 0 })) }));

const NOT_CONNECTED = 'Native FTS helper not connected';
const SEARCH_HIT = [{ uniqueId: 'account1:/INBOX:trip@example.com', subject: 'Harbour trip plan' }];
const PRIOR = { memId: 'turn:prior', content: 'earlier memory', dateMs: Date.now() };

// A stand-in helper behind connectNative. While `missing`, it never answers and
// drops the port, as the browser does for an uninstalled host. While
// `slowManifest`, the adapter's update-manifest fetch waits until released.
function makeBrowser(h, store) {
  return {
    storage: { local: {
      get: vi.fn(async keys => {
        if (h.failGet?.(keys)) throw new Error('storage read failed');
        if (typeof keys === 'string') return { [keys]: store[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, store[k]]));
        return { ...keys, ...store };
      }),
      set: vi.fn(async values => {
        if (h.failSet?.(values)) throw new Error('storage write failed');
        Object.assign(store, values);
      }),
      remove: vi.fn(async keys => { for (const k of [keys].flat()) delete store[k]; }),
    } },
    runtime: {
      getManifest: () => ({ version: '1.9.3' }),
      getPlatformInfo: async () => ({ os: 'mac', arch: 'aarch64' }),
      onMessage: { addListener: fn => h.listeners.add(fn), removeListener: fn => h.listeners.delete(fn) },
      sendMessage: vi.fn(async () => undefined),
      connectNative: vi.fn(() => {
        const receives = [];
        const disconnects = [];
        const port = {
          onMessage: { addListener: fn => receives.push(fn) },
          onDisconnect: { addListener: fn => disconnects.push(fn) },
          disconnect: vi.fn(() => { if (!port.closed) { port.closed = true; disconnects.forEach(fn => fn()); } }),
          postMessage(msg) {
            h.methods.push(msg.method);
            if (h.missing) return;
            let result = { ok: true };
            if (msg.method === 'hello') result = { hostVersion: '0.11.5', schemaVersion: 1, canSelfUpdate: h.slowManifest, capabilities: { memorySizeLimitV1: true, memoryPreviewV1: true, memoryFilterBeforeLimitV1: true } };
            if (msg.method === 'init') result = { dbPath: '/test/profile/index.sqlite' };
            if (msg.method === 'stats') result = { ok: true, docs: 1, vecDocs: 1 };
            if (msg.method === 'search') result = SEARCH_HIT;
            if (msg.method === 'memoryClear') h.memory = [];
            if (msg.method === 'memoryTrim') { h.memory = []; result = { ok: true, trimmed: 1, withinLimit: true }; }
            if (msg.method === 'updateCheck') result = { needsUpdate: false, canUpdate: true };
            queueMicrotask(() => receives.forEach(fn => fn({ id: msg.id, result })));
          },
        };
        if (h.missing) queueMicrotask(() => port.disconnect());
        return port;
      }),
    },
    tmMsgNotify: { getFtsDataDir: async () => '/test/profile/extension-data' },
    tmUpdates: { showUpdateBar: vi.fn(async () => {}) },
    alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: fn => { h.alarm = fn; } } },
  };
}

async function setup({ missing = false, slowManifest = false, store = {}, failGet, failSet } = {}) {
  vi.resetModules();
  const h = { missing, slowManifest, failGet, failSet, methods: [], memory: [PRIOR], listeners: new Set() };
  globalThis.browser = makeBrowser(h, { ftsLastIndexedSchemaVersion: 1, ...store });
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (h.slowManifest) await new Promise(resolve => { h.finishManifest = resolve; });
    return { ok: true, json: async () => ({ latest: { version: '0.11.5', downloadUrl: 'https://example.com/helper', sha256: 'fixture-sha', signature: 'fixture-signature' } }) };
  }));
  h.engine = await import('../fts/engine.js');
  // A page's {type: "fts"} message reaches the background's listeners; with no
  // listener keeping the channel open it resolves undefined.
  h.send = message => new Promise(resolve => {
    let open = false;
    for (const fn of h.listeners) if (fn({ type: 'fts', ...message }, {}, resolve) === true) open = true;
    if (!open) resolve(undefined);
  });
  return h;
}

const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('a page changing chat memory while the helper is not ready (#175)', () => {
  it('a missing helper refuses memoryTrim and leaves memory as it was', async () => {
    const h = await setup({ missing: true });
    await expect(h.engine.initFtsEngine()).rejects.toThrow();
    expect(await h.send({ cmd: 'memoryTrim' })).toEqual({ error: NOT_CONNECTED });
    expect(h.memory).toEqual([PRIOR]);
    expect(h.methods).not.toContain('memoryTrim');
  });

  it('a connecting helper holds memoryClear until it is ready, then clears', async () => {
    vi.useFakeTimers();
    const h = await setup({ slowManifest: true });
    const starting = h.engine.initFtsEngine();
    await flush();
    expect(h.finishManifest).toBeTypeOf('function');
    let answer = 'unanswered';
    const clearing = h.send({ cmd: 'memoryClear' }).then(value => { answer = value; });
    await vi.advanceTimersByTimeAsync(10000);
    expect(answer).toBe('unanswered');
    expect(h.memory).toEqual([PRIOR]);
    expect(h.methods).not.toContain('memoryClear');
    h.finishManifest();
    await starting;
    await clearing;
    expect(answer).toEqual({ ok: true });
    expect(h.memory).toEqual([]);
    expect(h.methods.indexOf('memoryClear')).toBeGreaterThan(h.methods.indexOf('init'));
  });
});

// Runs the background's real FTS startup and recheck code (chat/background.js,
// from the recheck alarm's name to the next section) against the real engine.
function startBackground(h) {
  const source = readFileSync(new URL('../chat/background.js', import.meta.url), 'utf8');
  const start = source.indexOf('const FTS_RECHECK_ALARM =');
  const end = source.indexOf('// Reflect "consent required"', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const attempts = [];
  const scope = {
    browser,
    ...h.engine,
    initFtsEngine: (...args) => { const p = h.engine.initFtsEngine(...args); attempts.push(p); return p; },
    setWarning: vi.fn(async () => {}),
    checkAndRunInitialFtsScan: vi.fn(async () => {}),
    log: vi.fn(),
  };
  vm.createContext(scope);
  vm.runInContext(`${source.slice(start, end)}\nthis.probe = probeFtsAvailability;`, scope);
  return { scope, attempts };
}

describe('one storage failure while the engine starts (#175)', () => {
  // An interrupted scan from the previous session is left in storage.
  const store = { fts_scan_status: { isScanning: true, scanType: 'smart', sessionId: 'previous-session', runId: 'previous-run' } };
  const faults = {
    'reading the scan status': () => {
      let failed = false;
      return { failGet: keys => !failed && keys === 'fts_scan_status' && (failed = true) };
    },
    'writing the scan status': () => {
      let failed = false;
      return { failSet: values => !failed && Object.hasOwn(values, 'fts_scan_status') && (failed = true) };
    },
  };
  for (const [name, fault] of Object.entries(faults)) {
    it(`${name}: the alarm and the UI probe bring search back once storage works`, async () => {
      const h = await setup({ store, ...fault() });
      const { scope, attempts } = startBackground(h);
      await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(0));
      await Promise.allSettled([attempts[0]]);
      await flush();
      for (let n = 0; n < 3; n++) {
        h.alarm({ name: 'tabmail-fts-helper-recheck' });
        await scope.probe();
      }
      await flush();
      expect(await h.send({ cmd: 'search', q: 'harbour' })).toEqual(SEARCH_HIT);
      expect(h.engine.getFtsHelperAvailable()).toBe(true);
      expect(h.listeners.size).toBe(1);
      expect(browser.runtime.connectNative).toHaveBeenCalledTimes(1);
      expect(scope.checkAndRunInitialFtsScan).toHaveBeenCalledTimes(1);
    });
  }
});
