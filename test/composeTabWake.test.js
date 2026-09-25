import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

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
