import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { agentQueues: { ftsIncremental: {} }, eventLogger: { enabled: false } },
}));
vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsBatchOperation: vi.fn(), logFtsOperation: vi.fn(),
  logMessageEventBatch: vi.fn(), logMoveEvent: vi.fn(),
}));
vi.mock('../agent/modules/utils.js', () => ({
  getForegroundFetchPressure: vi.fn(() => ({ active: 0, waiting: 0, chatTyping: false })),
  getUniqueMessageKey: vi.fn(), getUniqueMessageKeyCandidates: vi.fn(),
  headerIDToWeID: vi.fn(), log: vi.fn(), parseUniqueId: vi.fn(),
  recheckMessageInFolder: vi.fn(), resolveUniqueMessageKey: vi.fn(),
}));
vi.mock('../fts/indexer.js', () => ({
  buildBatchHeader: vi.fn(), populateBatchBody: vi.fn(),
}));

const stored = {};
globalThis.browser = { storage: { local: {
  get: vi.fn(async value => typeof value === 'string'
    ? { [value]: stored[value] } : { ...value, ...stored }),
  set: vi.fn(async value => Object.assign(stored, structuredClone(value))),
  remove: vi.fn(async key => { delete stored[key]; }),
} } };

const indexer = await import('../fts/incrementalIndexer.js');
const experimentSource = readFileSync(
  new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url), 'utf8',
);
const work = [];
const header = {
  folder: { URI: 'mailbox://synthetic/Inbox' },
  messageId: 'added@example.test', messageKey: 17,
  subject: 'Synthetic', author: 'sender@example.test', flags: 0,
};

function bridge() {
  const native = new Set();
  const extension = {
    folderManager: { convert: folder => ({
      id: folder.URI, path: '/Inbox', accountId: 'synthetic',
    }) },
    messageManager: { convert: () => ({ id: 17 }) },
  };

  class EventManager {
    constructor(options) { this.options = options; }

    api() {
      const subscriptions = new Map();
      const { extensionApi, event } = this.options;
      return {
        addListener(fn) {
          if (subscriptions.has(fn)) return;
          const registration = extensionApi.PERSISTENT_EVENTS[event]({ fire: {
            async(value) {
              const pending = Promise.resolve(fn(value));
              work.push(pending);
              return pending;
            },
          } });
          subscriptions.set(fn, registration);
        },
        removeListener(fn) {
          subscriptions.get(fn)?.unregister();
          subscriptions.delete(fn);
        },
      };
    }
  }

  const scope = {
    ChromeUtils: { importESModule(path) {
      if (path.includes('ExtensionCommon')) return { ExtensionCommon: {
        ExtensionAPIPersistent: class {
          constructor(value) { this.extension = value; }
          primeListener(event, fire) { return this.PERSISTENT_EVENTS[event]({ fire }); }
        },
        EventManager,
      } };
      if (path.includes('MailServices')) return { MailServices: { mfn: {
        addListener: listener => native.add(listener),
        removeListener: listener => native.delete(listener),
      } } };
      if (path.includes('MailUtils')) return { MailUtils: {} };
      if (path.includes('Timer')) return { setInterval: () => 1, clearInterval() {} };
      throw new Error(path);
    } },
    console: { log() {}, error: vi.fn() },
    Ci: { nsMsgMessageFlags: { IMAPDeleted: 1, Expunged: 2 } },
  };
  vm.runInNewContext(`${experimentSource}\nthis.Experiment = tmMsgNotify;`, scope);
  const instance = new scope.Experiment(extension);
  browser.tmMsgNotify = instance.getAPI({ extension }).tmMsgNotify;
  return { instance, native, getListener: () => [...native][0] };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const key of Object.keys(stored)) delete stored[key];
  work.length = 0;
  indexer._testExports._getPendingUpdates().clear();
  indexer._testExports._setExperimentListenersActive(false);
  indexer._testExports._setIsEnabled(false);
});

afterEach(async () => {
  await indexer.disposeIncrementalIndexer();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('native additions and deletions reach the exact durable FTS account/folder intentions', async () => {
  const state = bridge();
  indexer._testExports._setIsEnabled(true);
  await indexer.setupExperimentListeners();
  expect(state.native.size).toBe(1);
  expect(indexer._testExports._getPendingUpdates().size).toBe(0);

  state.getListener().msgAdded(header);
  state.getListener().msgsDeleted([{ ...header, messageId: 'removed@example.test' }]);
  await Promise.all(work);
  expect([...indexer._testExports._getPendingUpdates()].map(([key, value]) => [key, value.type])).toEqual([
    ['synthetic:/Inbox:added@example.test', 'new'],
    ['synthetic:/Inbox:removed@example.test', 'deleted'],
  ]);

  await indexer.disposeIncrementalIndexer();
  expect(stored.fts_pending_updates.map(row => [row.uniqueKey, row.type, row.folderKey])).toEqual([
    ['synthetic:/Inbox:added@example.test', 'new', 'synthetic:/Inbox'],
    ['synthetic:/Inbox:removed@example.test', 'deleted', 'synthetic:/Inbox'],
  ]);
  state.instance.onShutdown(false);
});

it('native addition reaches the production agent queue with its Thunderbird message identity', async () => {
  const state = bridge();
  const accepted = [];
  const code = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const attach = ast.body.find(node => node.type === 'FunctionDeclaration'
    && node.id.name === 'attachTmMsgNotifyListeners');
  expect(attach).toBeTruthy();

  const folder = { id: header.folder.URI, path: '/Inbox', accountId: 'synthetic', type: 'inbox' };
  const message = { id: 17, headerMessageId: header.messageId, subject: header.subject, folder };
  browser.folders = { get: vi.fn(async id => id === folder.id ? folder : null) };
  browser.messages = { get: vi.fn(async id => id === 17 ? message : null) };
  const context = {
    browser, log() {}, logMessageEvent() {},
    isInboxFolder: value => value?.type === 'inbox',
    hasCachedAction: async () => false,
    enqueueProcessMessage: async (value, options) => accepted.push({ msg: value, options }),
    scheduleCacheCleanup() {},
  };
  vm.runInNewContext(
    `let _tmMsgNotifyAddedListener = null;\n${code.slice(attach.start, attach.end)}\nattachTmMsgNotifyListeners();`,
    context,
  );
  expect(state.native.size).toBe(1);
  expect(accepted).toEqual([]);

  state.getListener().msgAdded(header);
  await Promise.all(work);
  expect(accepted).toEqual([{ msg: message, options: {
    isPriority: false, source: 'tmMsgNotify.onMessageAdded',
  } }]);
  expect(browser.messages.get.mock.calls).toEqual([[17]]);
  state.instance.onShutdown(false);
});
