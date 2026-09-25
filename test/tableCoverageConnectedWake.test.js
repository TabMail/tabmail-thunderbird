import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

const state = vi.hoisted(() => ({ stored: {}, processed: [], cached: new Set() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { agentQueues: { processMessage: {
  watchIntervalMs: 0, kickDelayMs: -1, persistDebounceMs: 0, batchSize: 10, retryDelayMs: 1000,
} } } }));
vi.mock('../agent/modules/utils.js', () => ({
  log() {},
  getUniqueMessageKey: async message =>
    `${message.folder.accountId}:${message.folder.path}:${message.headerMessageId}`,
  getUniqueMessageKeyCandidates: () => [],
  resolveUniqueMessageKey: async () => ({ weID: 701 }),
}));
vi.mock('../agent/modules/actionCache.js', () => ({
  beginAutomaticWork() {}, finishAutomaticWork() {},
}));
vi.mock('../agent/modules/messageProcessor.js', () => ({
  processMessage: async (message, opts) => {
    state.processed.push({ message, opts }); state.cached.add(message.id); return { ok: true };
  },
}));
vi.mock('../agent/modules/proactiveCheckin.js', () => ({ onInboxUpdated() {} }));

let queue;
beforeEach(async () => {
  vi.resetModules();
  state.stored = {}; state.processed = []; state.cached.clear();
  globalThis.browser = { storage: { local: {
    get: async key => ({ [key]: state.stored[key] }),
    set: async value => Object.assign(state.stored, structuredClone(value)),
    remove: async key => { delete state.stored[key]; },
  } } };
  queue = await import('../agent/modules/messageProcessorQueue.js');
});
afterEach(async () => {
  await queue.cleanupProcessMessageQueue();
  vi.clearAllTimers(); vi.useRealTimers(); delete globalThis.browser;
});
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function startNativeRow() {
  const window = makeWindow();
  const hdr = window.hdr;
  hdr.folder = { URI: 'mailbox://synthetic/Inbox', flags: 1 };
  hdr.getStringProperty = () => '';
  window.view.getMsgHdrAt = index => index === 2 ? hdr : null;
  window.view.getMessageHdrAt = window.view.getMsgHdrAt;
  class Row {
    constructor() {
      this._index = 2; this.view = window.view; this.nativeCalls = 0;
      this.classList = { contains: () => false, add() {}, remove() {} };
      this.style = { setProperty() {}, removeProperty() {} };
    }
    fillRow() { this.nativeCalls++; }
    querySelector() { return null; }
  }
  const row = new Row();
  window.cw.customElements = { get: name => name === 'thread-row' ? Row : undefined };
  window.tree.querySelectorAll = () => [row];
  window.doc.querySelector = selector => selector === '[is="thread-row"]' ? row : null;
  const native = experiment('theme/experiments/tmMessageListTableView/tmMessageListTableView.sys.mjs',
    'tmMessageListTableView', { windows: [window.win] });
  native.context.extension.messageManager.convert = vi.fn(header =>
    ({ id: header.messageKey === 1 ? 701 : 702 }));
  return { native, row, hdr };
}

function startRealCoverageConsumer(message, decoy) {
  const listeners = new Set();
  const event = {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: messages => Promise.all([...listeners].map(listener => listener(messages))),
  };
  const messages = new Map([[701, message], [1, decoy]]);
  browser.messages = {
    get: vi.fn(async id => {
      if (!messages.has(id)) throw new Error('missing message');
      return messages.get(id);
    }),
    query: vi.fn(async ({ headerMessageId }) => ({
      messages: [...messages.values()].filter(item => item.headerMessageId === headerMessageId),
    })),
  };
  browser.tmMessageListTableView = { onUntaggedInboxMessages: event };
  const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const names = new Set(['handleUntaggedInboxMessages', 'attachUntaggedCoverageListener']);
  const functions = ast.body.filter(node => node.type === 'FunctionDeclaration' && names.has(node.id.name));
  expect(functions).toHaveLength(2);
  const attach = ast.body.find(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression'
    && node.expression.callee.name === 'attachUntaggedCoverageListener');
  expect(attach).toBeDefined();
  const scope = { browser, log() {}, hasCachedAction: async item => state.cached.has(item.id),
    enqueueProcessMessage: queue.enqueueProcessMessage };
  vm.runInNewContext(`let _untaggedCoverageListener = null;\n${functions.map(node =>
    source.slice(node.start, node.end)).join('\n')}\n${source.slice(attach.start, attach.end)}`,
  scope, { filename: 'agent/background-coverage.js' });
  expect(listeners.size).toBe(1);
  return { event, messages };
}

it('retries a failed early table subscriber without stacking it during init', () => {
  const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const attach = ast.body.find(node => node.type === 'FunctionDeclaration'
    && node.id?.name === 'attachUntaggedCoverageListener');
  const init = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'init');
  expect(source.slice(init.start, init.end)).toContain('attachUntaggedCoverageListener();');
  const listeners = new Set();
  let fail = true;
  const event = { addListener: vi.fn(listener => {
    if (fail) { fail = false; throw new Error('synthetic registration failure'); }
    listeners.add(listener);
  }) };
  const context = {
    browser: { tmMessageListTableView: { onUntaggedInboxMessages: event } },
    handleUntaggedInboxMessages: vi.fn(), log: vi.fn(),
  };
  vm.createContext(context);
  vm.runInContext(`let _untaggedCoverageListener = null;\n${source.slice(attach.start, attach.end)}\nthis.attach = attachUntaggedCoverageListener;`, context);
  context.attach();
  expect(listeners.size).toBe(0);
  context.attach();
  context.attach();
  expect(listeners.size).toBe(1);
  expect(event.addListener).toHaveBeenCalledTimes(2);
});

it('replays one suspended native paint into durable work for its original message', async () => {
  const { native, row, hdr } = startNativeRow();
  await native.api.init();
  const pending = [];
  const registration = native.api.onUntaggedInboxMessages.testPersistentRegistration()
    .prime({ wakeup: vi.fn(async () => {}), async: async info => { pending.push(info); } });
  row.fillRow();
  expect(pending).toHaveLength(1);
  expect(pending[0][0]).toMatchObject({ messageKey: 1, weMsgId: 701,
    messageId: hdr.messageId, rowIndex: 2 });
  // Thunderbird may reuse this DOM row before the suspended background wakes.
  row._index = 9;
  const folder = { id: 'folder-opaque', accountId: 'synthetic', path: '/Inbox', type: 'inbox' };
  const message = { id: 701, headerMessageId: hdr.messageId, folder, subject: 'Synthetic' };
  const decoy = { ...message, id: 1, headerMessageId: '<decoy@example.test>' };
  const consumer = startRealCoverageConsumer(message, decoy);
  registration.convert({ async: info => consumer.event.emit(info) });
  await consumer.event.emit(pending[0]);
  await settle();
  expect(browser.messages.get).toHaveBeenCalledExactlyOnceWith(701);
  expect(queue.getProcessMessageQueueStatus().pending).toBe(1);
  expect(state.stored.agent_processmessage_pending).toMatchObject([{
    uniqueKey: `synthetic:/Inbox:${hdr.messageId}`,
    opts: { isPriority: false, source: 'tagSort:coverage' },
  }]);
  row._index = 2; row.fillRow(); await settle();
  expect(browser.messages.get).toHaveBeenCalledTimes(2);
  expect(state.stored.agent_processmessage_pending).toHaveLength(1);
  expect(state.processed).toEqual([]);
  vi.useFakeTimers();
  await queue.drainProcessMessageQueue();
  expect(state.processed).toMatchObject([{ message, opts: { source: 'tagSort:coverage' } }]);
  expect(queue.getProcessMessageQueueStatus().pending).toBe(0);
  registration.unregister(); native.instance.onShutdown(false);
  expect(native.instance._untaggedSubscriptions_MLTV.size).toBe(0);
});

for (const mode of ['cached', 'non-inbox', 'missing-message-id', 'no-subscriber',
  'already-classified-reply', 'already-classified-archive', 'already-classified-none']) {
  it(`does not queue ${mode} table-row work`, async () => {
    const { native, row, hdr } = startNativeRow();
    await native.api.init();
    const nativeEmission = vi.spyOn(native.context.extension, 'emit');
    const pending = [];
    const registration = mode === 'no-subscriber' ? null
      : native.api.onUntaggedInboxMessages.testPersistentRegistration()
        .prime({ wakeup: vi.fn(async () => {}), async: async info => { pending.push(info); } });
    if (mode === 'non-inbox') hdr.folder.flags = 0;
    if (mode === 'missing-message-id') hdr.messageId = '';
    if (mode.startsWith('already-classified-')) hdr.getStringProperty = name =>
      name === 'tm-action' ? mode.slice('already-classified-'.length) : '';
    if (mode === 'cached') state.cached.add(701);
    row.fillRow();
    if (mode === 'cached') {
      expect(pending).toHaveLength(1);
      expect(nativeEmission).toHaveBeenCalledOnce();
      const folder = { id: 'folder-opaque', accountId: 'synthetic', path: '/Inbox', type: 'inbox' };
      const message = { id: 701, headerMessageId: hdr.messageId, folder, subject: 'Synthetic' };
      const consumer = startRealCoverageConsumer(message, { ...message, id: 1 });
      await consumer.event.emit(pending[0]);
      expect(browser.messages.get).toHaveBeenCalledExactlyOnceWith(701);
    } else {
      expect(pending).toHaveLength(0);
      expect(nativeEmission).not.toHaveBeenCalled();
    }
    await settle();
    expect(queue.getProcessMessageQueueStatus().pending).toBe(0);
    expect(state.stored.agent_processmessage_pending).toBeUndefined();
    registration?.unregister(); native.instance.onShutdown(false);
  });
}
