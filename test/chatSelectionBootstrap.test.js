import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { experimentFunctions } from './helpers/experimentFunctions.js';
import { CHAT_SETTINGS } from '../chat/modules/chatConfig.js';

it('starts selection recovery from the registered Chat DOMContentLoaded callback', async () => {
  const source = readFileSync(new URL('../chat/chat.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const configImport = ast.body.find(node => node.type === 'ImportDeclaration'
    && node.source.value === './modules/chatConfig.js');
  expect(configImport?.specifiers.some(specifier => specifier.imported?.name === 'CHAT_SETTINGS')).toBe(true);
  const initializer = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'initMessageSelectionTracking');
  const registration = ast.body.find(node => node.type === 'ExpressionStatement'
    && node.expression.callee?.object?.name === 'window'
    && node.expression.arguments?.[0]?.value === 'DOMContentLoaded');
  const startupCall = registration?.expression.arguments[1].body.body.find(node => node.type === 'ExpressionStatement'
    && node.expression.callee?.name === 'initMessageSelectionTracking');
  expect(initializer).toBeDefined();
  expect(startupCall).toBeDefined();

  // Execute the real startup callback through its selection call. The earlier
  // setup blocks are retained; later unrelated Chat UI setup is omitted.
  const startupSource = `${source.slice(initializer.start, initializer.end)}\n${source.slice(registration.start, startupCall.end)}\n});`;
  const timers = [];
  const updates = [];
  let onReady;
  const response = { ok: true, selectedMessageIds: ['synthetic:ready'], selectionCount: 1 };
  const sendMessage = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(response);
  const globals = {
    CHAT_SETTINGS,
    ctx: {},
    messageSelectionListener: null,
    cleanupMessageSelectionListener: vi.fn(),
    updateSelectionFromMessage: message => updates.push(message.selectedMessageIds),
    browser: { runtime: { onMessage: { addListener: vi.fn() }, sendMessage } },
    window: { addEventListener: (name, callback) => { if (name === 'DOMContentLoaded') onReady = callback; } },
    document: { getElementById: () => null, addEventListener: vi.fn() },
    setTimeout: callback => { timers.push(callback); },
    log: vi.fn(),
  };
  runInNewContext(startupSource, globals);
  expect(onReady).toBeTypeOf('function');
  await onReady();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(timers).toHaveLength(1);
  timers.shift()();
  await vi.waitFor(() => expect(updates.at(-1)).toEqual(['synthetic:ready']));
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(timers).toHaveLength(0);
});

it('does not let an older startup reply replace a newer selection event', async () => {
  let resolveReply;
  let onMessage;
  const updates = [];
  const globals = {
    CHAT_SETTINGS,
    browser: { runtime: {
      onMessage: { addListener: fn => { onMessage = fn; } },
      sendMessage: () => new Promise(resolve => { resolveReply = resolve; }),
    } },
    messageSelectionListener: null,
    cleanupMessageSelectionListener: vi.fn(),
    updateSelectionFromMessage: message => updates.push(message.selectedMessageIds),
    log: vi.fn(),
    setTimeout: vi.fn(),
  };
  const { initMessageSelectionTracking } = experimentFunctions(
    new URL('../chat/chat.js', import.meta.url), ['initMessageSelectionTracking'], globals,
  );
  const startup = initMessageSelectionTracking();
  onMessage({ command: 'selection-changed', selectedMessageIds: ['new'], selectionCount: 1 });
  resolveReply({ ok: true, selectedMessageIds: ['old'], selectionCount: 1 });
  await startup;
  expect(updates).toEqual([['new']]);
});

it('rechecks an initially empty selection while the mail window finishes loading', async () => {
  const timers = [];
  const updates = [];
  const sendMessage = vi.fn()
    .mockResolvedValueOnce({ ok: true, selectedMessageIds: [], selectionCount: 0 })
    .mockResolvedValueOnce({ ok: true, selectedMessageIds: ['ready'], selectionCount: 1 });
  const globals = {
    CHAT_SETTINGS,
    browser: { runtime: { onMessage: { addListener: vi.fn() }, sendMessage } },
    messageSelectionListener: null,
    cleanupMessageSelectionListener: vi.fn(),
    updateSelectionFromMessage: message => updates.push(message.selectedMessageIds),
    log: vi.fn(),
    setTimeout: fn => { timers.push(fn); },
  };
  const { initMessageSelectionTracking } = experimentFunctions(
    new URL('../chat/chat.js', import.meta.url), ['initMessageSelectionTracking'], globals,
  );
  await initMessageSelectionTracking();
  expect(timers).toHaveLength(1);
  timers.shift()();
  await vi.waitFor(() => expect(updates.at(-1)).toEqual(['ready']));
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(updates.at(-1)).toEqual(['ready']);
});

it('retries an unanswered startup request and applies the selected identity from the response', async () => {
  const response = {
    ok: true,
    selectedMessageIds: ['synthetic-account:/Inbox:message-7'],
    selectionCount: 1,
  };
  const timers = [];
  const updates = [];
  const sendMessage = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(response);
  const globals = {
    CHAT_SETTINGS,
    browser: {
      runtime: {
        onMessage: { addListener: vi.fn() },
        sendMessage,
      },
    },
    messageSelectionListener: null,
    cleanupMessageSelectionListener: vi.fn(),
    updateSelectionFromMessage: message => updates.push(message),
    updateSelectionIndicator: vi.fn(),
    log: vi.fn(),
    setTimeout: fn => { timers.push(fn); return timers.length; },
  };
  const { initMessageSelectionTracking } = experimentFunctions(
    new URL('../chat/chat.js', import.meta.url), ['initMessageSelectionTracking'], globals,
  );

  await initMessageSelectionTracking();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(timers).toHaveLength(1);
  timers.shift()();
  await vi.waitFor(() => expect(updates).toHaveLength(1));
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(updates).toEqual([response]);
  expect(timers).toHaveLength(0);
});

it('bounds failed startup requests, retries rejected transport, and logs exhaustion', async () => {
  const timers = [];
  const log = vi.fn();
  const sendMessage = vi.fn()
    .mockRejectedValueOnce(new Error('background unavailable'))
    .mockResolvedValue({ ok: false, error: 'not ready' });
  const globals = {
    CHAT_SETTINGS,
    browser: { runtime: { onMessage: { addListener: vi.fn() }, sendMessage } },
    messageSelectionListener: null,
    cleanupMessageSelectionListener: vi.fn(),
    updateSelectionFromMessage: vi.fn(),
    log,
    setTimeout: fn => { timers.push(fn); },
  };
  const { initMessageSelectionTracking } = experimentFunctions(
    new URL('../chat/chat.js', import.meta.url), ['initMessageSelectionTracking'], globals,
  );
  await initMessageSelectionTracking();
  for (let attempt = 0; attempt < CHAT_SETTINGS.messageSelectionBootstrapMaxRetries; attempt++) {
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    timers.shift()();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(attempt + 2));
    await Promise.resolve();
  }
  expect(timers).toHaveLength(0);
  expect(sendMessage).toHaveBeenCalledTimes(CHAT_SETTINGS.messageSelectionBootstrapMaxRetries + 1);
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(
    expect.stringContaining('unavailable after startup retries'), 'warn',
  ));
});

it('does not apply or retry a response that arrives after Chat listener cleanup', async () => {
  let resolveReply;
  const sendMessage = vi.fn(() => new Promise(resolve => { resolveReply = resolve; }));
  const updates = vi.fn();
  const timers = [];
  const globals = {
    CHAT_SETTINGS,
    browser: { runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() }, sendMessage } },
    messageSelectionListener: null,
    updateSelectionFromMessage: updates,
    log: vi.fn(),
    setTimeout: fn => { timers.push(fn); },
  };
  const { initMessageSelectionTracking, cleanupMessageSelectionListener } = experimentFunctions(
    new URL('../chat/chat.js', import.meta.url),
    ['initMessageSelectionTracking', 'cleanupMessageSelectionListener'], globals,
  );
  const startup = initMessageSelectionTracking();
  cleanupMessageSelectionListener();
  resolveReply({ ok: true, selectedMessageIds: ['stale'], selectionCount: 1 });
  await startup;
  expect(updates).not.toHaveBeenCalled();
  expect(timers).toHaveLength(0);
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

it('updates the real Chat mention selection state from a successful reply', async () => {
  const ctx = { selectedMessageIds: [] };
  const order = [];
  const globals = {
    CHAT_SETTINGS,
    browser: { runtime: {
      onMessage: { addListener: () => order.push('listen') },
      sendMessage: async () => {
        order.push('request');
        return { ok: true, selectedMessageIds: ['synthetic-a', 'synthetic-b'], selectionCount: 2 };
      },
    } },
    ctx,
    currentSelectionCount: 0,
    messageSelectionListener: null,
    cleanupMessageSelectionListener: vi.fn(),
    log: vi.fn(),
    setTimeout: vi.fn(),
  };
  const { initMessageSelectionTracking } = experimentFunctions(
    new URL('../chat/chat.js', import.meta.url),
    ['initMessageSelectionTracking', 'updateSelectionFromMessage'], globals,
  );
  await initMessageSelectionTracking();
  expect(order).toEqual(['listen', 'request']);
  expect(ctx.selectedMessageIds).toEqual(['synthetic-a', 'synthetic-b']);
});
