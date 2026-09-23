import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

function startChat() {
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
      globals[name] = name === 'CHAT_SETTINGS'
        ? { openChatHotkeyEnabled: true }
        : () => Promise.resolve({});
    }
    script = script.slice(0, entry.start)
      + script.slice(entry.start, entry.end).replace(/[^\r\n]/g, ' ')
      + script.slice(entry.end);
  }
  globals.openOrFocusChatWindow = openOrFocusChatWindow;
  globals.initMessageSelectionListener = initMessageSelectionListener;
  globals.handleMessageSelectionRequest = () => undefined;
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
  for (const timer of timers.filter(item => item.delay === 100)) timer.fn();
  return { event, openOrFocusChatWindow, initMessageSelectionListener };
}

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
    expect(runtime.listeners.size).toBe(1);
    await command.emit('open-chat-window');
    await hotkey.emit();
    expect(app.openOrFocusChatWindow).toHaveBeenCalledTimes(2);
    expect((await runtime.emit({ type: 'restart-thunderbird' }, {}))[0]).toMatchObject({ ok: true });
    await suspend.emit();
    await command.emit('open-chat-window');
    await hotkey.emit();
    expect(app.openOrFocusChatWindow).toHaveBeenCalledTimes(4);
    expect((await runtime.emit({ type: 'restart-thunderbird' }, {}))[0]).toMatchObject({ ok: true });
    expect(command.listeners.size).toBe(1);
    expect(hotkey.listeners.size).toBe(1);
    expect(runtime.listeners.size).toBe(1);
  });
});
