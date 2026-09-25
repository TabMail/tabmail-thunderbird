import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

vi.mock('../agent/modules/actionCache.js', () => ({ clearActions: vi.fn() }));
vi.mock('../agent/modules/autoUpdateUserPrompt.js', () => ({ autoUpdateUserPromptOnMove: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { agentQueues: { ftsIncremental: {} }, onMoved: { staleTagSweep: { enabled: true, intervalMinutes: 15 } } },
}));
vi.mock('../agent/modules/eventLogger.js', () => ({
  logMessageEvent: vi.fn(), logMoveEvent: vi.fn(), logMessageEventBatch: vi.fn(),
  logFtsBatchOperation: vi.fn(), logFtsOperation: vi.fn(),
}));
vi.mock('../agent/modules/folderUtils.js', () => ({ getAllFoldersForAccount: vi.fn(), isInboxFolder: vi.fn(() => false) }));
vi.mock('../agent/modules/gmailLabelSync.js', () => ({ removeTmLabelsFromGmailMessage: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({}));
vi.mock('../agent/modules/inboxContext.js', () => ({ getInboxForAccount: vi.fn() }));
vi.mock('../agent/modules/tagHelper.js', () => ({ ACTION_TAG_IDS: {}, recomputeThreadForInboxMessage: vi.fn() }));
vi.mock('../agent/modules/utils.js', () => ({
  clearAlarm: vi.fn(async () => {}), ensureAlarm: vi.fn(async () => {}),
  getArchiveFolderForHeader: vi.fn(), getTrashFolderForHeader: vi.fn(),
  getUniqueMessageKey: vi.fn(async msg => `${msg.folder.accountId}:${msg.folder.path}:${msg.headerMessageId}`),
  indexHeader: vi.fn(), log: vi.fn(), removeHeaderIndexForDeletedMessage: vi.fn(),
  updateHeaderIndexForMovedMessage: vi.fn(),
  getForegroundFetchPressure: vi.fn(() => ({ active: 0, waiting: 0, chatTyping: false })),
  getUniqueMessageKeyCandidates: vi.fn(), headerIDToWeID: vi.fn(), parseUniqueId: vi.fn(),
  recheckMessageInFolder: vi.fn(), resolveUniqueMessageKey: vi.fn(),
}));
vi.mock('../fts/indexer.js', () => ({ buildBatchHeader: vi.fn(), populateBatchBody: vi.fn() }));
vi.mock('../theme/modules/snippetCache.js', () => ({ moveSnippet: vi.fn(async () => {}), removeSnippet: vi.fn(async () => {}) }));

import { attachOnMovedListeners, cleanupOnMovedListeners } from '../agent/modules/onMoved.js';
import { _testExports } from '../fts/incrementalIndexer.js';
import { ensureAlarm, removeHeaderIndexForDeletedMessage } from '../agent/modules/utils.js';
import { moveSnippet, removeSnippet } from '../theme/modules/snippetCache.js';

const folder = path => ({ id: path, accountId: 'synthetic', path });
const header = (id, path) => ({ id, folder: folder(path), headerMessageId: `${id}@example.test` });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
let events;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.clearAllMocks();
  events = Object.fromEntries(['onMoved', 'onCopied', 'onDeleted', 'onUpdated'].map(name => {
    const listeners = new Set();
    return [name, { listeners, addListener: vi.fn(fn => listeners.add(fn)), removeListener: vi.fn(fn => listeners.delete(fn)) }];
  }));
  globalThis.browser = {
    messages: { ...events, get: vi.fn(async () => null), update: vi.fn(), move: vi.fn(), delete: vi.fn() },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  };
  _testExports._setIsEnabled(true);
  _testExports._setFtsSearch({});
  _testExports._getPendingUpdates().clear();
});

afterEach(() => {
  cleanupOnMovedListeners();
  _testExports._getPendingUpdates().clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete globalThis.browser;
});

it('primes stock move, copy, and permanent-delete consumers without starting the sweep alarm', async () => {
  attachOnMovedListeners({ scheduleSweep: false });
  for (const name of ['onMoved', 'onCopied', 'onDeleted']) expect(events[name].listeners.size).toBe(1);
  expect(ensureAlarm).not.toHaveBeenCalled();
  attachOnMovedListeners();
  for (const name of ['onMoved', 'onCopied', 'onDeleted']) expect(events[name].listeners.size).toBe(1);
  expect(ensureAlarm).toHaveBeenCalledOnce();

  const before = header(51, '/Source');
  const after = header(52, '/Destination');
  await [...events.onMoved.listeners][0]({ messages: [before] }, { messages: [after] });
  await settle();
  expect([..._testExports._getPendingUpdates()].map(([key, value]) => [key, value.type])).toEqual([
    ['synthetic:/Source:51@example.test', 'deleted'],
    ['synthetic:/Destination:52@example.test', 'moved'],
  ]);
  expect(moveSnippet).toHaveBeenCalledWith('synthetic:/Source:51@example.test', 'synthetic:/Destination:52@example.test');

  _testExports._getPendingUpdates().clear();
  const copied = header(62, '/Copied');
  await [...events.onCopied.listeners][0]({ messages: [header(61, '/Source')] }, { messages: [copied] });
  await settle();
  expect([..._testExports._getPendingUpdates()].map(([key, value]) => [key, value.type])).toEqual([
    ['synthetic:/Copied:62@example.test', 'new'],
  ]);

  _testExports._getPendingUpdates().clear();
  const deleted = header(71, '/Trash');
  await [...events.onDeleted.listeners][0]({ messages: [deleted] });
  await settle();
  expect([..._testExports._getPendingUpdates()].map(([key, value]) => [key, value.type])).toEqual([
    ['synthetic:/Trash:71@example.test', 'deleted'],
  ]);
  expect(removeHeaderIndexForDeletedMessage).toHaveBeenCalledWith(deleted);
  expect(removeSnippet).toHaveBeenCalledWith('synthetic:/Trash:71@example.test');
  expect(browser.messages.update).not.toHaveBeenCalled();
  expect(browser.messages.move).not.toHaveBeenCalled();
  expect(browser.messages.delete).not.toHaveBeenCalled();
});

it('places stock mutation registration before asynchronous agent initialization', () => {
  const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const calls = ast.body.filter(node => node.type === 'ExpressionStatement' && node.expression?.type === 'CallExpression')
    .map(node => ({ name: node.expression.callee?.name, at: node.start, args: node.expression.arguments }));
  const prime = calls.find(call => call.name === 'attachOnMovedListeners');
  const init = calls.find(call => call.name === 'init');
  expect(prime?.at).toBeLessThan(init?.at);
  expect(prime?.args?.[0]?.properties?.[0]?.key?.name).toBe('scheduleSweep');
  expect(prime?.args?.[0]?.properties?.[0]?.value?.value).toBe(false);
});

it.each(['onMoved', 'onCopied', 'onDeleted'])('retries a failed %s subscription during late initialization', async name => {
  events[name].addListener.mockImplementationOnce(() => { throw new Error('synthetic addListener failure'); });
  attachOnMovedListeners({ scheduleSweep: false });
  expect(events[name].listeners.size).toBe(0);
  expect(ensureAlarm).not.toHaveBeenCalled();

  attachOnMovedListeners();
  expect(events.onMoved.listeners.size).toBe(1);
  expect(events.onCopied.listeners.size).toBe(1);
  expect(events.onDeleted.listeners.size).toBe(1);
  const listener = [...events[name].listeners][0];
  if (name === 'onDeleted') await listener({ messages: [header(81, '/Trash')] });
  else await listener({ messages: [header(80, '/Source')] }, { messages: [header(81, '/Destination')] });
  await settle();
  const expectedKey = name === 'onDeleted' ? 'synthetic:/Trash:81@example.test' : 'synthetic:/Destination:81@example.test';
  expect(_testExports._getPendingUpdates().get(expectedKey)?.type).toBe(
    name === 'onMoved' ? 'moved' : name === 'onCopied' ? 'new' : 'deleted',
  );
});
