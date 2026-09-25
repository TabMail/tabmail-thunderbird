import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { IDBFactory } from 'fake-indexeddb';

it('registers the compose-tab consumer before startup can await', () => {
  let source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const tabsCreated = new Set();
  const received = [];
  const composeListener = tab => received.push(tab.id);
  const initComposeHandlers = vi.fn(() => tabsCreated.add(composeListener));
  const globals = {
    console: { log() {}, warn() {}, error() {} }, Date, performance,
    window: {}, navigator: {}, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, initComposeHandlers,
    // Hold the first awaited startup dependency. A late registration cannot
    // receive an event while a new background generation is starting.
    ensureActionTags: () => new Promise(() => {}),
  };
  for (const entry of ast.body.filter(node => node.type === 'ImportDeclaration').reverse()) {
    for (const specifier of entry.specifiers) {
      const name = specifier.local.name;
      if (name === 'initComposeHandlers' || name === 'ensureActionTags') continue;
      globals[name] = name === 'SETTINGS' ? {} : name === 'idb' ? {} : () => Promise.resolve({});
    }
    source = source.slice(0, entry.start)
      + source.slice(entry.start, entry.end).replace(/[^\r\n]/g, ' ')
      + source.slice(entry.end);
  }
  const events = new Map();
  const event = path => {
    if (!events.has(path)) events.set(path, {
      addListener: fn => (path === 'browser.tabs.onCreated' ? tabsCreated : new Set()).add(fn),
      removeListener: fn => tabsCreated.delete(fn),
    });
    return events.get(path);
  };
  function api(path = 'browser') {
    return new Proxy(() => Promise.resolve({}), {
      get(_, key) {
        if (key === 'then') return undefined;
        if (key === 'getManifest') return () => ({ version: 'synthetic' });
        const next = `${path}.${String(key)}`;
        return String(key).startsWith('on') ? event(next) : api(next);
      },
    });
  }
  globals.browser = api();
  vm.runInNewContext(source, globals, { filename: 'agent/background.js' });

  expect(initComposeHandlers).toHaveBeenCalledTimes(1);
  expect(tabsCreated.size).toBe(1);
  for (const listener of tabsCreated) listener({ id: 41 });
  expect(received).toEqual([41]);
});

// Exercise the real tracker through the real background startup. The simpler
// test above pins timing; this one pins recovery and its durable reply effect.
async function startWithRealTracker(failFirstAdd, {
  secondReply = false, deferredGeneration = false, holdCacheRead = false,
} = {}) {
  const events = new Map();
  let addAttempts = 0;
  const details = new Map([
    [41, { type: 'reply', relatedMessageId: 7 }],
    [42, { type: 'reply', relatedMessageId: 7 }],
    [43, { type: 'forward', relatedMessageId: 7 }],
    [44, {}],
    [45, { type: 'reply', relatedMessageId: 8 }],
  ]);
  const event = path => {
    if (!events.has(path)) {
      const listeners = new Set();
      events.set(path, {
        listeners,
        addListener(fn) {
          if (path === 'browser.tabs.onCreated' && ++addAttempts === 1 && failFirstAdd) {
            throw new Error('synthetic registration failure');
          }
          listeners.add(fn);
        },
        removeListener: fn => listeners.delete(fn),
        emit: async (...args) => {
          for (const fn of [...listeners]) await fn(...args);
        },
      });
    }
    return events.get(path);
  };
  const overrides = {
    'browser.runtime.getManifest': () => ({ version: 'synthetic' }),
    'browser.compose.getComposeDetails': async id => details.get(id) || {},
    'browser.accounts.list': async () => [],
    'browser.storage.local.get': async value => value,
    'browser.windows.getAll': async () => [],
  };
  function api(path = 'browser') {
    return new Proxy(() => Promise.resolve({}), {
      get(_, key) {
        if (key === 'then') return undefined;
        const next = `${path}.${String(key)}`;
        return String(key).startsWith('on') ? event(next) : overrides[next] || api(next);
      },
    });
  }
  const browser = api();
  const quietConsole = { log() {}, warn() {}, error() {} };
  function evaluate(file, scope) {
    let source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const edits = [];
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        for (const specifier of node.specifiers) {
          const name = specifier.local.name;
          if (!(name in scope)) scope[name] = name === 'SETTINGS' ? {} : () => Promise.resolve({});
        }
        edits.push({ start: node.start, end: node.end, text: source.slice(node.start, node.end).replace(/[^\r\n]/g, ' ') });
      }
      if (node.type === 'ExportNamedDeclaration') {
        edits.push({ start: node.start, end: node.declaration.start, text: ' '.repeat(node.declaration.start - node.start) });
      }
    }
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ImportExpression') edits.push({ start: node.start, end: node.start + 6, text: '__loadModule' });
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(ast);
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    }
    const context = vm.createContext(scope);
    vm.runInContext(source, context, { filename: file });
    return context;
  }
  const idb = evaluate('agent/modules/idbStorage.js', {
    indexedDB: new IDBFactory(), browser, console: quietConsole,
  });
  const replyKey = 'reply:synthetic-account:/Inbox:thread@example.test';
  const otherReplyKey = 'reply:synthetic-account:/Inbox:other@example.test';
  if (!deferredGeneration) {
    await idb.set({ [replyKey]: { reply: 'Synthetic reply.', directReplace: true } });
  }
  if (secondReply) {
    await idb.set({ [otherReplyKey]: { reply: 'Unrelated draft.', directReplace: true } });
  }
  let releaseCacheRead;
  const cacheReadStarted = vi.fn();
  if (holdCacheRead) {
    const getAndClearFlag = idb.getAndClearFlag;
    idb.getAndClearFlag = async (...args) => {
      cacheReadStarted();
      await new Promise(resolve => { releaseCacheRead = resolve; });
      return getAndClearFlag(...args);
    };
  }
  let now = 0;
  let releaseGeneration;
  const createReply = vi.fn(async () => {
    if (!deferredGeneration) throw new Error('cached reply should be used');
    await new Promise(resolve => { releaseGeneration = resolve; });
    await idb.set({ [replyKey]: { reply: 'Generated reply.', directReplace: false } });
  });
  const tracker = evaluate('agent/modules/composeTracker.js', {
    browser, idb, console: quietConsole, Date, performance: { now: () => now },
    setTimeout: (fn, ms) => { now += ms; queueMicrotask(fn); return 1; },
    log() {}, formatForLog: value => value,
    getUniqueMessageKey: async id => (id === 7 ? replyKey : otherReplyKey).slice(6),
    createReply,
    STORAGE_PREFIX: 'reply:', ACTIONS: { REPLY: 'reply' },
    getActionForWeId: async () => null, getSentFoldersForAccount: async () => [],
    applyPriorityTag: async () => {},
  });
  let releaseStartup;
  const scanAllInboxes = vi.fn(async () => {});
  evaluate('agent/background.js', {
    browser, idb, console: quietConsole, Date, performance, window: {}, navigator: {},
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    initComposeHandlers: tracker.initComposeHandlers,
    isAnyComposeOpen: tracker.isAnyComposeOpen,
    ensureActionTags: () => new Promise(resolve => { releaseStartup = resolve; }),
    scanAllInboxes,
    __loadModule: async () => new Proxy({}, { get: (_, key) => key === 'then' ? undefined : () => Promise.resolve({}) }),
    log() {},
  });
  return {
    idb, tracker, event, createReply, scanAllInboxes, cacheReadStarted,
    get addAttempts() { return addAttempts; },
    async finishStartup() {
      releaseStartup();
      for (let i = 0; i < 100; i++) await Promise.resolve();
      await new Promise(resolve => setImmediate(resolve));
    },
    replyKey, otherReplyKey,
    releaseGeneration() {
      if (!releaseGeneration) throw new Error('generation has not started');
      releaseGeneration();
    },
    releaseCacheRead() {
      if (!releaseCacheRead) throw new Error('cache read has not started');
      releaseCacheRead();
    },
  };
}

it('recovers a failed early add through init without stacking or losing the reply', async () => {
  const run = await startWithRealTracker(true);
  const created = run.event('browser.tabs.onCreated');
  expect(run.addAttempts).toBe(1);
  expect(created.listeners.size).toBe(0);
  await run.finishStartup();
  expect(run.addAttempts).toBe(2);
  expect(created.listeners.size).toBe(1);
  await created.emit({ id: 41 });
  expect((await run.idb.get('activePrecompose:41'))['activePrecompose:41']).toEqual({
    content: 'Synthetic reply.', directReplace: true,
  });
  expect((await run.idb.get(run.replyKey))[run.replyKey].directReplace).toBe(false);
  run.tracker.initComposeHandlers();
  expect(run.addAttempts).toBe(2);
  expect(created.listeners.size).toBe(1);
});

it('retains one real compose-tab consumer across normal startup', async () => {
  const run = await startWithRealTracker(false);
  await run.event('browser.tabs.onCreated').emit({ id: 41 });
  expect((await run.idb.get('activePrecompose:41'))['activePrecompose:41']).toEqual({
    content: 'Synthetic reply.', directReplace: true,
  });
  expect((await run.idb.get(run.replyKey))[run.replyKey].directReplace).toBe(false);
  expect(run.tracker.isAnyComposeOpen()).toBe(true);
  await run.finishStartup();
  expect(run.scanAllInboxes).not.toHaveBeenCalled();
  expect(run.addAttempts).toBe(1);
  expect(run.event('browser.tabs.onCreated').listeners.size).toBe(1);
  await run.event('browser.tabs.onCreated').emit({ id: 42 });
  expect((await run.idb.get('activePrecompose:42'))['activePrecompose:42'].directReplace).toBe(false);
  await run.event('browser.tabs.onRemoved').emit(41);
  await run.event('browser.tabs.onRemoved').emit(42);
  expect((await run.idb.get('activePrecompose:41'))['activePrecompose:41']).toBeUndefined();
  expect((await run.idb.get('activePrecompose:42'))['activePrecompose:42']).toBeUndefined();
  expect(run.tracker.isAnyComposeOpen()).toBe(false);
});

it('scans when no compose window opened during startup', async () => {
  const run = await startWithRealTracker(false);
  await run.finishStartup();
  expect(run.scanAllInboxes).toHaveBeenCalledTimes(1);
  expect(run.tracker.isAnyComposeOpen()).toBe(false);
});

it('does not activate a cached reply for a forward or ordinary tab', async () => {
  const run = await startWithRealTracker(false);
  const created = run.event('browser.tabs.onCreated');
  await created.emit({ id: 43 });
  await created.emit({ id: 44 });
  for (const id of [43, 44]) {
    expect((await run.idb.get(`activePrecompose:${id}`))[`activePrecompose:${id}`]).toBeUndefined();
  }
  expect((await run.idb.get(run.replyKey))[run.replyKey].directReplace).toBe(true);
  expect(run.tracker.isAnyComposeOpen()).toBe(false);
  expect(run.createReply).not.toHaveBeenCalled();
  // The same cached proposal must still activate a genuine reply.
  await created.emit({ id: 41 });
  expect((await run.idb.get('activePrecompose:41'))['activePrecompose:41'].content).toBe('Synthetic reply.');
  expect((await run.idb.get(run.replyKey))[run.replyKey].directReplace).toBe(false);
});

it('activates only the draft belonging to each message on first wake', async () => {
  const run = await startWithRealTracker(false, { secondReply: true });
  const created = run.event('browser.tabs.onCreated');
  await created.emit({ id: 41 });
  expect((await run.idb.get('activePrecompose:41'))['activePrecompose:41'].content).toBe('Synthetic reply.');
  expect((await run.idb.get(run.replyKey))[run.replyKey].directReplace).toBe(false);
  expect((await run.idb.get(run.otherReplyKey))[run.otherReplyKey]).toEqual({
    reply: 'Unrelated draft.', directReplace: true,
  });
  await created.emit({ id: 45 });
  expect((await run.idb.get('activePrecompose:45'))['activePrecompose:45'].content).toBe('Unrelated draft.');
  expect((await run.idb.get(run.otherReplyKey))[run.otherReplyKey].directReplace).toBe(false);
  expect(run.createReply).not.toHaveBeenCalled();
});

it('waits for a cache-miss reply before activating the compose tab', async () => {
  const run = await startWithRealTracker(false, { deferredGeneration: true });
  const created = run.event('browser.tabs.onCreated');
  const delivery = created.emit({ id: 41 });
  await vi.waitFor(() => expect(run.createReply).toHaveBeenCalledWith(7, true));
  expect((await run.idb.get('activePrecompose:41'))['activePrecompose:41']).toBeUndefined();
  expect(run.tracker.isAnyComposeOpen()).toBe(true);
  await run.finishStartup();
  expect(run.scanAllInboxes).not.toHaveBeenCalled();
  run.releaseGeneration();
  await delivery;
  expect((await run.idb.get(run.replyKey))[run.replyKey].reply).toBe('Generated reply.');
  expect((await run.idb.get('activePrecompose:41'))['activePrecompose:41']).toEqual({
    content: 'Generated reply.', directReplace: false,
  });
});

it('tracks an early reply while the real cache read is pending', async () => {
  const run = await startWithRealTracker(false, { holdCacheRead: true });
  const delivery = run.event('browser.tabs.onCreated').emit({ id: 41 });
  await vi.waitFor(() => expect(run.cacheReadStarted).toHaveBeenCalledTimes(1));
  expect(run.tracker.isAnyComposeOpen()).toBe(true);
  await run.finishStartup();
  expect(run.scanAllInboxes).not.toHaveBeenCalled();
  expect((await run.idb.get('activePrecompose:41'))['activePrecompose:41']).toBeUndefined();
  run.releaseCacheRead();
  await delivery;
  expect((await run.idb.get('activePrecompose:41'))['activePrecompose:41']).toEqual({
    content: 'Synthetic reply.', directReplace: true,
  });
  expect((await run.idb.get(run.replyKey))[run.replyKey].directReplace).toBe(false);
});
