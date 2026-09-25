import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

vi.mock('../agent/modules/utils.js', () => ({ log() {} }));
import * as senderFilter from '../agent/modules/senderFilter.js';

function startAgent({ failedEvent } = {}) {
  let source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const edits = [];
  let releaseStartup;
  const heldStartup = new Promise(resolve => { releaseStartup = resolve; });
  const globals = {
    console: { log() {}, error() {}, warn() {} }, Date, performance,
    window: {}, navigator: {}, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  };
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    for (const specifier of node.specifiers) {
      const name = specifier.local.name;
      globals[name] = name === 'SETTINGS' ? {} : name === 'idb' ? {}
        : name === 'ensureActionTags' ? () => heldStartup
        : name === 'invalidateUserEmailCache' ? senderFilter.invalidateUserEmailCache
        : () => Promise.resolve({});
    }
    edits.push({ start: node.start, end: node.end,
      text: source.slice(node.start, node.end).replace(/[^\r\n]/g, ' ') });
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression') {
      edits.push({ start: node.start, end: node.start + 6, text: '__loadModule' });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  globals.__loadModule = async path => path === './modules/senderFilter.js'
    ? senderFilter
    : new Proxy({}, { get: (_, key) => key === 'then' ? undefined : () => Promise.resolve({}) });
  const events = new Map();
  function event(path) {
    if (!events.has(path)) {
      const listeners = new Set();
      let failOnce = path === failedEvent;
      events.set(path, {
        listeners,
        addListener: fn => {
          if (failOnce) { failOnce = false; throw new Error('synthetic add failure'); }
          listeners.add(fn);
        },
        removeListener: fn => listeners.delete(fn),
        hasListener: fn => listeners.has(fn),
        emitNow: (...args) => { for (const fn of [...listeners]) fn(...args); },
        emit: async (...args) => { for (const fn of [...listeners]) await fn(...args); },
      });
    }
    return events.get(path);
  }
  let accounts = [{ id: 'synthetic', type: 'imap', identities: [{ email: 'one@example.test' }] }];
  function api(path = 'browser') {
    return new Proxy(() => Promise.resolve({}), {
      get(_, key) {
        if (key === 'then') return undefined;
        const next = `${path}.${String(key)}`;
        if (String(key).startsWith('on')) return event(next);
        if (next === 'browser.accounts.list') return async () => accounts;
        if (next === 'browser.accounts.get') return async () => accounts[0];
        if (key === 'getManifest') return () => ({ version: 'synthetic' });
        return api(next);
      },
    });
  }
  globals.browser = api();
  vm.runInNewContext(source, globals, { filename: 'agent/background.js' });
  return {
    browser: globals.browser, event, releaseStartup,
    setEmail: email => { accounts = [{ id: 'synthetic', type: 'imap', identities: [{ email }] }]; },
  };
}

async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

describe('sender identity cache after canceled background suspension', () => {
  const invalidationEvents = [
    'browser.accounts.onCreated', 'browser.accounts.onDeleted', 'browser.accounts.onUpdated',
    'browser.identities.onCreated', 'browser.identities.onUpdated', 'browser.identities.onDeleted',
  ];

  it('registers every stock invalidation listener before the first startup await, then does not stack them', async () => {
    const app = startAgent();
    for (const name of invalidationEvents) expect(app.event(name).listeners.size).toBe(1);
    app.releaseStartup();
    await drain();
    for (const name of invalidationEvents) expect(app.event(name).listeners.size).toBe(1);
  });

  it.each(invalidationEvents)('%s invalidates the cached identity while startup is held', async name => {
    const app = startAgent();
    const previous = globalThis.browser;
    globalThis.browser = app.browser;
    try {
      senderFilter.invalidateUserEmailCache();
      expect(await senderFilter.isInternalSender({ author: 'one@example.test' })).toBe(true);
      app.setEmail('new@example.test');
      await app.event(name).emit('synthetic', {});
      await drain();
      expect(await senderFilter.isInternalSender({ author: 'new@example.test' })).toBe(true);
      expect(await senderFilter.isInternalSender({ author: 'one@example.test' })).toBe(false);
    } finally {
      app.releaseStartup();
      await drain();
      senderFilter.invalidateUserEmailCache();
      if (previous === undefined) delete globalThis.browser;
      else globalThis.browser = previous;
    }
  });

  it('invalidates synchronously when an identity event races a cache read', async () => {
    const app = startAgent();
    const previous = globalThis.browser;
    globalThis.browser = app.browser;
    try {
      senderFilter.invalidateUserEmailCache();
      expect(await senderFilter.isInternalSender({ author: 'one@example.test' })).toBe(true);
      app.setEmail('new@example.test');
      app.event('browser.identities.onUpdated').emitNow('synthetic', {});
      expect(await senderFilter.isInternalSender({ author: 'new@example.test' })).toBe(true);
      expect(await senderFilter.isInternalSender({ author: 'one@example.test' })).toBe(false);
    } finally {
      app.releaseStartup();
      await drain();
      senderFilter.invalidateUserEmailCache();
      if (previous === undefined) delete globalThis.browser;
      else globalThis.browser = previous;
    }
  });

  it('retries only an event whose early subscription failed', async () => {
    const failedEvent = 'browser.identities.onUpdated';
    const app = startAgent({ failedEvent });
    const previous = globalThis.browser;
    globalThis.browser = app.browser;
    try {
      for (const name of invalidationEvents) {
        expect(app.event(name).listeners.size).toBe(name === failedEvent ? 0 : 1);
      }
      senderFilter.invalidateUserEmailCache();
      expect(await senderFilter.isInternalSender({ author: 'one@example.test' })).toBe(true);
      app.releaseStartup();
      await drain();
      for (const name of invalidationEvents) expect(app.event(name).listeners.size).toBe(1);
      app.setEmail('retried@example.test');
      await app.event(failedEvent).emit('synthetic', {});
      await drain();
      expect(await senderFilter.isInternalSender({ author: 'retried@example.test' })).toBe(true);
      expect(await senderFilter.isInternalSender({ author: 'one@example.test' })).toBe(false);
    } finally {
      app.releaseStartup();
      senderFilter.invalidateUserEmailCache();
      if (previous === undefined) delete globalThis.browser;
      else globalThis.browser = previous;
    }
  });

  it('classifies the newest account identity after successive edits', async () => {
    const app = startAgent();
    const previous = globalThis.browser;
    globalThis.browser = app.browser;
    try {
      app.releaseStartup();
      await drain();
      senderFilter.invalidateUserEmailCache();
      expect(await senderFilter.isInternalSender({ author: 'one@example.test' })).toBe(true);
      const edited = app.event('browser.identities.onUpdated');
      expect(edited.listeners.size).toBeGreaterThan(0);
      app.setEmail('two@example.test');
      await edited.emit('synthetic', {});await drain();
      expect(await senderFilter.isInternalSender({ author: 'two@example.test' })).toBe(true);
      expect(await senderFilter.isInternalSender({ author: 'one@example.test' })).toBe(false);
      await app.event('browser.runtime.onSuspend').emit();
      await app.event('browser.runtime.onSuspendCanceled').emit();
      app.setEmail('three@example.test');
      await edited.emit('synthetic', {});await drain();
      expect(await senderFilter.isInternalSender({ author: 'three@example.test' })).toBe(true);
      expect(await senderFilter.isInternalSender({ author: 'two@example.test' })).toBe(false);
    } finally {
      senderFilter.invalidateUserEmailCache();
      if (previous === undefined) delete globalThis.browser;
      else globalThis.browser = previous;
    }
  });
});
