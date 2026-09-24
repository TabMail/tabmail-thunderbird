import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

async function startTheme({ failFirstCardRegistration = false } = {}) {
  const source = readFileSync(new URL('../theme/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let script = source;
  const performTaggedAction = vi.fn(async () => {});
  const snippetStart = vi.fn();
  const snippetStop = vi.fn();
  const calls = [];
  const globals = {
    console: { log() {}, error() {}, warn() {} }, Date, performance, URL,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  };
  for (const entry of ast.body.filter(node => node.type === 'ImportDeclaration').reverse()) {
    for (const specifier of entry.specifiers) {
      const name = specifier.local.name;
      globals[name] = name === 'SETTINGS' ? {}
        : name === 'createCardSnippetProvider' ? () => ({ start: snippetStart, stop: snippetStop })
          : () => Promise.resolve({});
    }
    script = script.slice(0, entry.start)
      + script.slice(entry.start, entry.end).replace(/[^\r\n]/g, ' ')
      + script.slice(entry.end);
  }
  globals.performTaggedAction = performTaggedAction;
  const events = new Map();
  let cardRegistrationFailurePending = failFirstCardRegistration;
  function event(path) {
    if (!events.has(path)) {
      const listeners = new Set();
      events.set(path, {
        listeners,
        addListener: callback => {
          if (path === 'browser.tmMessageListCardView.onActionChipClick'
              && cardRegistrationFailurePending) {
            cardRegistrationFailurePending = false;
            throw new Error('synthetic startup registration failure');
          }
          listeners.add(callback);
        },
        removeListener: callback => listeners.delete(callback),
        emit: (...args) => Promise.all([...listeners].map(callback => callback(...args))),
      });
    }
    return events.get(path);
  }
  function api(path = 'browser') {
    return new Proxy((...args) => {
      calls.push(path);
      if (path === 'browser.tabs.query') return Promise.resolve([]);
      return Promise.resolve({});
    }, {
      get(_target, key) {
        if (key === 'then') return undefined;
        const next = `${path}.${String(key)}`;
        if (String(key).startsWith('on')) return event(next);
        return api(next);
      },
    });
  }
  globals.browser = api();
  script = script.replace('// Immediate init for hot-reloads\ninitTheme();',
    '// Immediate init for hot-reloads\nglobalThis.__initPromise = initTheme();');
  vm.runInNewContext(script, globals, { filename: 'theme/background.js' });
  await globals.__initPromise;
  return { event, calls, performTaggedAction, snippetStart, snippetStop };
}

describe('theme background startup and canceled suspend', () => {
  it('retries a failed synchronous card-listener registration during theme init', async () => {
    const app = await startTheme({ failFirstCardRegistration: true });
    const chip = app.event('browser.tmMessageListCardView.onActionChipClick');
    expect(chip.listeners.size).toBe(1);
    await chip.emit({ source: 'synthetic', weMsgId: 1 });
    expect(app.performTaggedAction).toHaveBeenCalledTimes(1);
  });

  it('keeps native theme and action-chip delivery active in the same generation', async () => {
    const app = await startTheme();
    expect(app.calls).toContain('browser.tmTheme.init');
    expect(app.calls).toContain('browser.tmPreviewGate.init');
    const chip = app.event('browser.tmMessageListCardView.onActionChipClick');
    const headerChip = app.event('browser.tmMessageHeaderChip.onActionChipClick');
    const multiChip = app.event('browser.tmMultiMessageChip.onActionChipClick');
    const suspend = app.event('browser.runtime.onSuspend');
    expect(chip.listeners.size).toBe(1);
    expect(headerChip.listeners.size).toBe(1);
    expect(multiChip.listeners.size).toBe(1);
    expect(app.snippetStart).toHaveBeenCalled();
    await chip.emit({ source: 'synthetic', weMsgId: 3 });
    await headerChip.emit({ weMsgId: 1, source: 'synthetic' });
    await multiChip.emit({ weMsgId: 2, source: 'synthetic' });
    await Promise.resolve();
    expect(app.performTaggedAction).toHaveBeenCalledTimes(3);
    await suspend.emit();
    await chip.emit({ source: 'synthetic', weMsgId: 3 });
    await headerChip.emit({ weMsgId: 1, source: 'synthetic' });
    await multiChip.emit({ weMsgId: 2, source: 'synthetic' });
    await Promise.resolve();
    expect(app.performTaggedAction).toHaveBeenCalledTimes(6);
    expect(chip.listeners.size).toBe(1);
    expect(headerChip.listeners.size).toBe(1);
    expect(multiChip.listeners.size).toBe(1);
    expect(app.snippetStop).not.toHaveBeenCalled();
    expect(app.calls).not.toContain('browser.tmTheme.shutdown');
    expect(app.calls).not.toContain('browser.tmPreviewGate.shutdown');
    expect(app.calls).not.toContain('browser.tmMessageHeaderChip.shutdown');
    expect(app.calls).not.toContain('browser.tmMultiMessageChip.shutdown');
    expect(app.calls).not.toContain('browser.staleRowFilter.shutdown');
  });
});
