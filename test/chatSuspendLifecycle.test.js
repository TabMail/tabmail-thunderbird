import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

function startChat({ runDelayed = true } = {}) {
  const source = readFileSync(new URL('../chat/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let script = source;
  const openOrFocusChatWindow = vi.fn(async () => {});
  const initMessageSelectionListener = vi.fn(async () => {});
  const globals = {
    console: { log() {}, error() {}, warn() {} }, Date, performance,
    window: {}, navigator: {}, setInterval: () => 1, clearInterval() {}, clearTimeout() {},
  };
  const timers = [];
  globals.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  for (const entry of ast.body.filter(node => node.type === 'ImportDeclaration').reverse()) {
    for (const specifier of entry.specifiers) {
      const name = specifier.local.name;
      if (entry.source.value === './modules/messageSelection.js' && name === 'handleMessageSelectionRequest') {
        globals[name] = message => message?.command === 'get-current-selection'
          ? { ok: true, selectedMessageIds: ['synthetic-selected'], selectionCount: 1 }
          : undefined;
      } else if (entry.source.value === './modules/messageSelection.js' && name === 'initMessageSelectionListener') {
        globals[name] = initMessageSelectionListener;
      } else {
        globals[name] = name === 'CHAT_SETTINGS'
          ? { openChatHotkeyEnabled: true }
          : () => Promise.resolve({});
      }
    }
    script = script.slice(0, entry.start)
      + script.slice(entry.start, entry.end).replace(/[^\r\n]/g, ' ')
      + script.slice(entry.end);
  }
  globals.openOrFocusChatWindow = openOrFocusChatWindow;
  const events = new Map();
  function event(path) {
    if (!events.has(path)) {
      const listeners = new Set();
      events.set(path, {
        listeners,
        addListener: callback => listeners.add(callback),
        removeListener: callback => listeners.delete(callback),
        emit: (...args) => Promise.all([...listeners].map(callback => callback(...args))),
      });
    }
    return events.get(path);
  }
  const fallback = () => Promise.resolve({});
  function api(path = 'browser') {
    return new Proxy(fallback, {
      get(_target, key) {
        if (key === 'then') return undefined;
        const next = `${path}.${String(key)}`;
        if (String(key).startsWith('on')) return event(next);
        return api(next);
      },
    });
  }
  globals.browser = api();
  vm.runInNewContext(script, globals, { filename: 'chat/background.js' });
  if (runDelayed) for (const timer of timers.filter(item => item.delay === 100)) timer.fn();
  return { event, timers, openOrFocusChatWindow, initMessageSelectionListener,
    setupRuntimeMessageListener: globals.setupRuntimeMessageListener };
}

it('registers both runtime consumers before startup timers and keeps one owner', async () => {
  const app = startChat({ runDelayed: false });
  const runtime = app.event('browser.runtime.onMessage');
  expect(runtime.listeners.size).toBe(2);
  expect(app.timers.some(item => item.delay === 100)).toBe(false);
  expect((await runtime.emit({ command: 'get-current-selection' })).filter(Boolean)).toEqual([
    { ok: true, selectedMessageIds: ['synthetic-selected'], selectionCount: 1 },
  ]);
  const chatListener = [...runtime.listeners].find(listener => listener.name === 'chatRuntimeMessageListener');
  // A Promise resolving to undefined still claims a runtime response in Gecko.
  expect(chatListener({ type: 'fts', cmd: 'stats' })).toBeUndefined();
  const ftsConsumer = vi.fn(message => message?.type === 'fts' ? { source: 'fts' } : undefined);
  runtime.addListener(ftsConsumer);
  expect((await runtime.emit({ type: 'fts', cmd: 'stats' })).filter(Boolean)).toEqual([{ source: 'fts' }]);
  expect(ftsConsumer).toHaveBeenCalledTimes(1);
  expect((await runtime.emit({ command: 'getFtsScanStatus' })).filter(Boolean)[0]).toMatchObject({
    initialComplete: false, isScanning: false, scanType: 'none',
  });
  expect((await runtime.emit({ command: 'open-chat-window' })).filter(Boolean)).toEqual([{ ok: true }]);
  expect(app.openOrFocusChatWindow).toHaveBeenCalledTimes(1);
  app.setupRuntimeMessageListener();
  expect(runtime.listeners.size).toBe(3);
  expect((await runtime.emit({ command: 'open-chat-window' })).filter(Boolean)).toEqual([{ ok: true }]);
  expect(app.openOrFocusChatWindow).toHaveBeenCalledTimes(2);
});

describe('chat background startup and canceled suspend', () => {
  it('preserves command, runtime and selection startup behavior', async () => {
    const app = startChat();
    expect(app.initMessageSelectionListener).toHaveBeenCalledTimes(1);
    const command = app.event('browser.commands.onCommand');
    const hotkey = app.event('browser.keyOverride.onChatHotkey');
    const runtime = app.event('browser.runtime.onMessage');
    const suspend = app.event('browser.runtime.onSuspend');
    expect(command.listeners.size).toBe(1);
    expect(hotkey.listeners.size).toBe(1);
    expect(runtime.listeners.size).toBe(2);
    await command.emit('open-chat-window');
    await hotkey.emit();
    expect(app.openOrFocusChatWindow).toHaveBeenCalledTimes(2);
    expect((await runtime.emit({ type: 'restart-thunderbird' }, {})).filter(Boolean)[0]).toMatchObject({ ok: true });
    await suspend.emit();
    await command.emit('open-chat-window');
    await hotkey.emit();
    expect(app.openOrFocusChatWindow).toHaveBeenCalledTimes(4);
    expect((await runtime.emit({ type: 'restart-thunderbird' }, {})).filter(Boolean)[0]).toMatchObject({ ok: true });
    expect(command.listeners.size).toBe(1);
    expect(hotkey.listeners.size).toBe(1);
    expect(runtime.listeners.size).toBe(2);
  });
});
