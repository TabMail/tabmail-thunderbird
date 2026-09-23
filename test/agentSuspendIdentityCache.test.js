import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

vi.mock('../agent/modules/utils.js', () => ({ log() {} }));
import * as senderFilter from '../agent/modules/senderFilter.js';

function startAgent() {
  let source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const edits = [];
  const globals = {
    console: { log() {}, error() {}, warn() {} }, Date, performance,
    window: {}, navigator: {}, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  };
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    for (const specifier of node.specifiers) {
      const name = specifier.local.name;
      globals[name] = name === 'SETTINGS' ? {} : name === 'idb' ? {} : () => Promise.resolve({});
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
      events.set(path, {
        listeners,
        addListener: fn => listeners.add(fn),
        removeListener: fn => listeners.delete(fn),
        hasListener: fn => listeners.has(fn),
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
    browser: globals.browser, event,
    setEmail: email => { accounts = [{ id: 'synthetic', type: 'imap', identities: [{ email }] }]; },
  };
}

async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

describe('sender identity cache after canceled background suspension', () => {
  it('classifies the newest account identity after successive edits', async () => {
    const app = startAgent();
    const previous = globalThis.browser;
    globalThis.browser = app.browser;
    try {
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
