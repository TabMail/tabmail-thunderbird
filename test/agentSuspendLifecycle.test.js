import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

function startAgent({ welcome = false } = {}) {
  const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let script = source;
  const enqueueProcessMessage = vi.fn(async () => ({ ok: true }));
  const signalChatTyping = vi.fn();
  const globals = {
    console: { log() {}, error() {}, warn() {} }, Date, performance,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    window: {}, navigator: {},
  };
  for (const entry of ast.body.filter(node => node.type === 'ImportDeclaration').reverse()) {
    for (const specifier of entry.specifiers) {
      const name = specifier.local.name;
      globals[name] = name === 'SETTINGS' ? {} : name === 'idb' ? {} : () => Promise.resolve({});
    }
    script = script.slice(0, entry.start)
      + script.slice(entry.start, entry.end).replace(/[^\r\n]/g, ' ')
      + script.slice(entry.end);
  }
  globals.enqueueProcessMessage = enqueueProcessMessage;
  globals.signalChatTyping = signalChatTyping;
  globals.isInboxFolder = () => true;
  const events = new Map();
  let accounts = [];
  const createdWindows = [];
  function event(path) {
    if (!events.has(path)) {
      const listeners = new Set();
      events.set(path, {
        listeners,
        addListener: callback => listeners.add(callback),
        removeListener: callback => listeners.delete(callback),
        hasListener: callback => listeners.has(callback),
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
        if (welcome && next === 'browser.accounts.list') return async () => accounts;
        if (welcome && next === 'browser.storage.local.get') return async () => ({ tabmailWelcomeCompleted: false });
        if (welcome && next === 'browser.windows.getAll') return async () => [];
        if (welcome && next === 'browser.windows.create') return async options => { createdWindows.push(options); return { id: 7 }; };
        if (welcome && next === 'browser.runtime.getURL') return path => `moz-extension://synthetic/${path}`;
        if (key === 'getManifest') return () => ({ version: 'synthetic' });
        return api(next);
      },
    });
  }
  globals.browser = api();
  vm.runInNewContext(script, globals, { filename: 'agent/background.js' });
  return { event, enqueueProcessMessage, signalChatTyping, createdWindows,
    addAccount: () => { accounts = [{ id: 'synthetic', type: 'imap' }]; } };
}

describe('agent background startup and canceled suspend', () => {
  it('opens onboarding when the first account arrives after a canceled suspend', async () => {
    for (const cancelSuspend of [false, true]) {
      const app = startAgent({ welcome: true });
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(app.createdWindows).toEqual([]);
      const created = app.event('browser.accounts.onCreated');
      expect(created.listeners.size).toBeGreaterThan(0);
      if (cancelSuspend) {
        await app.event('browser.runtime.onSuspend').emit();
        await app.event('browser.runtime.onSuspendCanceled').emit();
      }
      app.addAccount();
      await created.emit('synthetic', { type: 'imap' });
      expect(app.createdWindows.map(options => options.url))
        .toEqual(['moz-extension://synthetic/welcome/welcome.html']);
    }
  });
  it('continues handling runtime and new-mail events in the same generation', async () => {
    const app = startAgent();
    const runtime = app.event('browser.runtime.onMessage');
    const mail = app.event('browser.messages.onNewMailReceived');
    const nativeMail = app.event('browser.tmMsgNotify.onMessageAdded');
    const suspend = app.event('browser.runtime.onSuspend');
    expect(runtime.listeners.size).toBe(1);
    expect(mail.listeners.size).toBe(1);
    expect(nativeMail.listeners.size).toBe(1);
    await runtime.emit({ command: 'chat-typing' }, {});
    const folder = { name: 'Inbox', type: 'inbox', path: '/Inbox', accountId: 'synthetic' };
    const message = { id: 1, subject: 'Synthetic', folder };
    await mail.emit(folder, { messages: [message] });
    const nativeInfo = { eventType: 'msgAdded', folderPath: '/Inbox', subject: 'Synthetic',
      headerMessageId: 'synthetic@example.test', weFolderId: 'folder-1', weMsgId: 1, isInbox: true };
    await nativeMail.emit(nativeInfo);
    expect(app.signalChatTyping).toHaveBeenCalledTimes(1);
    expect(app.enqueueProcessMessage).toHaveBeenCalledTimes(2);
    await suspend.emit();
    await runtime.emit({ command: 'chat-typing' }, {});
    await mail.emit(folder, { messages: [message] });
    await nativeMail.emit(nativeInfo);
    expect(app.signalChatTyping).toHaveBeenCalledTimes(2);
    expect(app.enqueueProcessMessage).toHaveBeenCalledTimes(4);
    expect(runtime.listeners.size).toBe(1);
    expect(mail.listeners.size).toBe(1);
    expect(nativeMail.listeners.size).toBe(1);
  });
});
