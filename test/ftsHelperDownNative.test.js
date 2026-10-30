/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #175, over the real native adapter (nativeEngine.js) and a stand-in helper
// port, so readiness, the missing error and the connect wait are the real ones.
//
// 1. A page's memory-changing request is refused while the helper is missing,
//    and waits while it connects: it never changes memory before the helper is
//    ready, and it is never answered with a success the helper did not give.
// 2. Every other helper-backed request a page sends is answered too: the
//    helper's error while it is missing, with nothing changed, and the helper's
//    result once it is back.
// 3. One storage failure while the engine starts must not leave search down for
//    the rest of the session: once storage works again, the background's own
//    recheck (alarm or a UI's availability probe) brings search back.
// 4. A scan left running by an interrupted session is not shown as running
//    once the engine has started, even with incremental indexing off.

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
const MAIL_KEY = 'account1:/INBOX:prior@example.com';
const MAIL = { msgId: MAIL_KEY, uniqueId: MAIL_KEY, subject: 'Harbour trip plan', body: 'the full mail body' };

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
      getKeys: vi.fn(async () => Object.keys(store)),
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
            if (msg.method === 'stats') result = h.stats;
            if (msg.method === 'search') result = SEARCH_HIT;
            if (msg.method === 'getMessageByMsgId') result = h.mail.find(r => r.msgId === msg.params.msgId) || null;
            if (msg.method === 'getAttachmentFlags') result = { ok: true, flags: [true] };
            if (msg.method === 'memoryStats') result = { ok: true, docs: h.memory.length };
            if (msg.method === 'memoryRead') result = h.memory;
            if (msg.method === 'indexBatch') h.mail.push(...msg.params.rows);
            if (msg.method === 'removeBatch') h.mail = h.mail.filter(r => !msg.params.ids.includes(r.msgId));
            if (msg.method === 'clear') h.mail = [];
            if (msg.method === 'memoryIndexBatch') h.memory.push(...msg.params.rows);
            if (msg.method === 'memoryRemoveBatch') h.memory = h.memory.filter(r => !msg.params.ids.includes(r.memId));
            if (msg.method === 'memoryClear') h.memory = [];
            if (msg.method === 'memoryTrim') { h.memory = []; result = { ok: true, trimmed: 1, withinLimit: true }; }
            if (msg.method === 'updateCheck') result = { needsUpdate: false, canUpdate: true };
            result = structuredClone(result);
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
  const h = {
    missing, slowManifest, failGet, failSet, methods: [], listeners: new Set(),
    mail: [{ ...MAIL }], memory: [PRIOR], stats: { ok: true, docs: 1, vecDocs: 1 },
  };
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

// [page command, its fields, the helper method it reaches, the answer once the helper is back]
const NEW_MEMORY = { memId: 'turn:new', content: 'new memory', dateMs: Date.now() };
const COMMANDS = [
  ['stats', {}, 'stats', { ok: true, docs: 1, vecDocs: 1 }],
  ['getMessageByMsgId', { msgId: MAIL_KEY }, 'getMessageByMsgId', MAIL],
  ['getAttachmentFlags', { msgIds: [MAIL_KEY] }, 'getAttachmentFlags', { ok: true, flags: [true] }],
  ['indexBatch', { rows: [{ ...MAIL, msgId: `${MAIL_KEY}:new` }] }, 'indexBatch', { ok: true }],
  ['removeBatch', { ids: [MAIL_KEY] }, 'removeBatch', { ok: true }],
  ['clear', {}, 'clear', { ok: true }],
  ['reindexAll', {}, 'clear', { ok: true, scanned: 0 }],
  ['memoryStats', {}, 'memoryStats', { ok: true, docs: 1 }],
  ['memoryRead', { timestampMs: PRIOR.dateMs, toleranceMs: 0 }, 'memoryRead', [PRIOR]],
  ['memoryIndexBatch', { rows: [NEW_MEMORY] }, 'memoryIndexBatch', { ok: true }],
  ['memoryRemoveBatch', { ids: [PRIOR.memId] }, 'memoryRemoveBatch', { ok: true }],
];
// What each command leaves in the helper once it has run.
const EFFECTS = {
  indexBatch: h => expect(h.mail).toHaveLength(2),
  removeBatch: h => expect(h.mail).toEqual([]),
  clear: h => expect(h.mail).toEqual([]),
  reindexAll: h => expect(h.mail).toEqual([]),
  memoryIndexBatch: h => expect(h.memory).toEqual([PRIOR, NEW_MEMORY]),
  memoryRemoveBatch: h => expect(h.memory).toEqual([]),
};

describe('every helper request a page sends is answered (#175)', () => {
  for (const [cmd, fields, method, expected] of COMMANDS) {
    it(`${cmd}: the helper's error while it is missing, its result once it is back`, async () => {
      const h = await setup({ missing: true });
      await expect(h.engine.initFtsEngine()).rejects.toThrow();
      const before = structuredClone({ mail: h.mail, memory: h.memory });
      const calls = () => h.methods.filter(m => m === method).length;
      expect(await h.send({ cmd, ...fields })).toEqual({ error: NOT_CONNECTED });
      expect({ mail: h.mail, memory: h.memory }).toEqual(before);
      expect(calls()).toBe(0);

      h.missing = false;
      expect(await h.engine.recheckFtsHelperAvailable()).toBe(true);
      await h.engine.initFtsEngine();
      const callsBefore = calls();
      expect(await h.send({ cmd, ...fields })).toEqual(expected);
      expect(calls()).toBe(callsBefore + 1);
      expect(h.listeners.size).toBe(1);
      EFFECTS[cmd]?.(h);
    });
  }
});

describe('a scan left running by an interrupted session (#175)', () => {
  it('is not shown as running once the engine starts, with incremental indexing off', async () => {
    // A rebuild that stopped half way, with no resume checkpoint, so nothing
    // starts a new rebuild; with incremental indexing off no reconcile runs.
    vi.doUnmock('../fts/incrementalIndexer.js');
    try {
      const { JSDOM } = await import('jsdom');
      const interrupted = { isScanning: true, scanType: 'embeddingRebuild', sessionId: 'previous-session', runId: 'previous-run', progress: { phase: 'email', processed: 500, embedded: 500, total: 1000 } };
      const h = await setup({ store: { chat_ftsIncrementalEnabled: false, fts_initial_scan_complete: true, fts_scan_status: interrupted } });
      h.stats = { ok: true, docs: 1000, vecDocs: 500 };
      await h.engine.initFtsEngine();
      const { getFtsOperationState } = await import('../fts/operationCoordinator.js');
      expect(getFtsOperationState().exclusive).toBe(false);

      const dom = new JSDOM('<div id="fts-not-installed"></div><div id="fts-stats"></div><div id="fts-host-version"></div><div id="fts-progress" style="display:none"></div><progress id="fts-progress-bar"></progress><div id="fts-progress-text"></div>');
      vi.stubGlobal('document', dom.window.document);
      browser.runtime.sendMessage = vi.fn(msg => (msg.command === 'getFtsAvailability'
        ? Promise.resolve({ available: true, status: 'available' })
        : h.send(msg)));
      vi.useFakeTimers();
      const { updateFtsStatus } = await import('../config/modules/fts.js');
      await updateFtsStatus();
      expect(document.getElementById('fts-progress').style.display).not.toBe('block');
      expect(document.getElementById('fts-progress-text').textContent).not.toContain('Rebuilding embeddings');
      // The settings page polls only while it shows a rebuild.
      browser.storage.local.get.mockClear();
      await vi.advanceTimersByTimeAsync(60000);
      expect(browser.storage.local.get.mock.calls.filter(([key]) => key === 'fts_scan_status')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.doMock('../fts/incrementalIndexer.js', () => ({ initIncrementalIndexer: vi.fn(async () => {}) }));
    }
  });
});
