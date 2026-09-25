import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

vi.mock('../agent/modules/actionCache.js', () => ({
  ACTIONS: { DELETE: 'delete', ARCHIVE: 'archive', REPLY: 'reply' },
  getActionForWeId: async () => 'archive',
}));
vi.mock('../agent/modules/composeTracker.js', () => ({ trackComposeWindow() {} }));
vi.mock('../agent/modules/utils.js', () => ({
  getArchiveFolderForHeader: async () => ({ id: 'archive', path: '/Archive' }),
  getTrashFolderForHeader: async () => ({ id: 'trash', path: '/Trash' }),
  getIdentityForMessage: async () => ({}),
  getUniqueMessageKey: async () => 'synthetic@example.test',
  log() {},
}));
import { registerTabKeyHandlers, cleanupTagActionKeyListeners } from '../agent/modules/tagActionKey.js';

function startAgent({ welcome = false, tabKeyRegistrar, updatedRegistrar, coverageMessage } = {}) {
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
      globals[name] = name === 'SETTINGS' ? {} : name === 'idb' ? {}
        : name === 'registerTabKeyHandlers' && tabKeyRegistrar
          ? tabKeyRegistrar : () => Promise.resolve({});
      if (name === 'attachOnUpdatedListener' && updatedRegistrar) globals[name] = updatedRegistrar;
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
        if (coverageMessage && next === 'browser.messages.get') return async id =>
          id === coverageMessage.id ? structuredClone(coverageMessage) : null;
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
  it('registers the stock message-update wake listener before async startup', () => {
    const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const calls = ast.body.filter(node => node.type === 'ExpressionStatement'
      && node.expression?.type === 'CallExpression')
      .map(node => ({ name: node.expression.callee?.name, at: node.start }));
    expect(calls.find(call => call.name === 'attachOnUpdatedListener')?.at)
      .toBeLessThan(calls.find(call => call.name === 'init')?.at);
    const register = vi.fn();
    startAgent({ updatedRegistrar: register });
    expect(register).toHaveBeenCalledOnce();
  });

  it('registers table coverage before async startup and enqueues the event identity after suspend', async () => {
    const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const calls = ast.body.filter(node => node.type === 'ExpressionStatement'
      && node.expression?.type === 'CallExpression')
      .map(node => ({ name: node.expression.callee?.name, at: node.start }));
    expect(calls.find(call => call.name === 'attachUntaggedCoverageListener')?.at)
      .toBeLessThan(calls.find(call => call.name === 'init')?.at);

    const message = { id: 91, subject: 'Synthetic coverage',
      folder: { id: 'inbox', accountId: 'synthetic', path: '/Inbox' } };
    const app = startAgent({ coverageMessage: message });
    const coverage = app.event('browser.tmMessageListTableView.onUntaggedInboxMessages');
    expect(coverage.listeners.size).toBe(1);
    const payload = [{ weMsgId: 91, messageId: '<synthetic-coverage@example.test>',
      messageKey: 7, folderUri: 'mailbox://synthetic/Inbox', rowIndex: 2 }];
    await coverage.emit(payload);
    expect(app.enqueueProcessMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 91, subject: 'Synthetic coverage' }),
      { isPriority: false, source: 'tagSort:coverage' }
    );
    expect(app.enqueueProcessMessage).toHaveBeenCalledTimes(1);

    await app.event('browser.runtime.onSuspend').emit();
    expect(coverage.listeners.size).toBe(1);
    await coverage.emit(payload);
    expect(app.enqueueProcessMessage).toHaveBeenCalledTimes(2);
    expect(app.enqueueProcessMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 91 }), { isPriority: false, source: 'tagSort:coverage' }
    );
  });

  it('registers the Tab listener at module load before asynchronous initialization', () => {
    const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const calls = ast.body.filter(node => node.type === 'ExpressionStatement'
      && node.expression?.type === 'CallExpression')
      .map(node => ({ name: node.expression.callee?.name, at: node.start }));
    const register = calls.find(call => call.name === 'registerTabKeyHandlers');
    const init = calls.find(call => call.name === 'init');
    expect(register).toBeDefined();
    expect(init).toBeDefined();
    expect(register.at).toBeLessThan(init.at);
  });

  it('registers the real Tab consumer before async startup and acts on the pressed target', async () => {
    const first = makeWindow();
    const second = makeWindow();
    const native = experiment('theme/experiments/keyOverride/keyOverride.sys.mjs', 'keyOverride', {
      windows: [first.win, second.win],
      moduleOverrides: {
        getActualSelectedMessages: pane => pane === first.cw ? [first.hdr] : [second.hdr],
      },
    });
    native.context.extension.messageManager.convert = header => ({
      id: header === first.hdr ? 1 : 2,
    });
    const rows = new Map([1, 2].map(id => [id, {
      id, read: false, folder: { id: 'inbox', accountId: 'synthetic' },
    }]));
    globalThis.browser = {
      keyOverride: native.api,
      messages: {
        get: vi.fn(async id => structuredClone(rows.get(id))),
        update: vi.fn(async (id, fields) => Object.assign(rows.get(id), fields)),
        move: vi.fn(async (ids, folder) => {
          for (const id of ids) rows.get(id).folder.id = folder;
        }),
      },
      mailTabs: {
        query: vi.fn(async () => [{ id: 7 }]),
        getSelectedMessages: vi.fn(async () => ({ messages: [rows.get(2)] })),
      },
    };
    try {
      startAgent({ tabKeyRegistrar: registerTabKeyHandlers });
      expect(native.instance._tabSubscriptions.size).toBe(1);
      native.api.init();
      const event = {
        code: 'Tab', key: 'Tab', shiftKey: false,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
      };
      first.win.dispatch('keydown', event);
      await new Promise(resolve => setImmediate(resolve));
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(rows.get(1).folder.id).toBe('archive');
      expect(rows.get(2).folder.id).toBe('inbox');
      expect(browser.mailTabs.query).not.toHaveBeenCalled();
    } finally {
      cleanupTagActionKeyListeners();
      native.instance.onShutdown(false);
      delete globalThis.browser;
    }
  });
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
