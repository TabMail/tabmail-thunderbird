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
async function startWithRealTracker(failFirstAdd) {
  const events = new Map();
  let addAttempts = 0;
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
    'browser.compose.getComposeDetails': async () => ({ type: 'reply', relatedMessageId: 7 }),
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
  await idb.set({ [replyKey]: { reply: 'Synthetic reply.', directReplace: true } });
  let now = 0;
  const tracker = evaluate('agent/modules/composeTracker.js', {
    browser, idb, console: quietConsole, Date, performance: { now: () => now },
    setTimeout: (fn, ms) => { now += ms; queueMicrotask(fn); return 1; },
    log() {}, formatForLog: value => value,
    getUniqueMessageKey: async () => replyKey.slice(6),
    createReply: async () => { throw new Error('cached reply should be used'); },
    STORAGE_PREFIX: 'reply:', ACTIONS: { REPLY: 'reply' },
    getActionForWeId: async () => null, getSentFoldersForAccount: async () => [],
    applyPriorityTag: async () => {},
  });
  let releaseStartup;
  evaluate('agent/background.js', {
    browser, idb, console: quietConsole, Date, performance, window: {}, navigator: {},
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    initComposeHandlers: tracker.initComposeHandlers,
    isAnyComposeOpen: tracker.isAnyComposeOpen,
    ensureActionTags: () => new Promise(resolve => { releaseStartup = resolve; }),
    __loadModule: async () => new Proxy({}, { get: (_, key) => key === 'then' ? undefined : () => Promise.resolve({}) }),
    log() {},
  });
  return {
    idb, tracker, event, get addAttempts() { return addAttempts; },
    async finishStartup() {
      releaseStartup();
      for (let i = 0; i < 100; i++) await Promise.resolve();
      await new Promise(resolve => setImmediate(resolve));
    },
    replyKey,
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
  await run.finishStartup();
  expect(run.addAttempts).toBe(1);
  expect(run.event('browser.tabs.onCreated').listeners.size).toBe(1);
});
