/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Chat History's Clear All and Delete Old remove turns from storage while the
// chat window may be open. The window keeps its turns in memory for display
// and the model's context; it must never write that copy back, or the removed
// turns return at the next open. Every change to the stored turns is an
// operation (append, remove, keep newer than, clear) sent to the background's
// one writer and applied there in order, so a removal and a new turn never
// overwrite each other.
//
// This runs the real settings page (prompts/prompts.html) for Clear All and
// Delete Old, the real chat store for the window, the real window-close save
// from chat.js, and the real scheduled-task delivery, against one storage
// that, as Thunderbird's does, keeps copies.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { parse } from 'acorn';
import { experimentFunctions } from './helpers/experimentFunctions.js';
import { storedTurnsRoute } from './support/storedTurnsRoute.js';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  getAllKeys: vi.fn(async () => []),
}));
// The scheduled task's delivery, run for real with these around it.
vi.mock('../agent/modules/reminderStateStore.js', () => ({ hashReminder: r => r.hash, getDisabledHashes: async () => new Set() }));
vi.mock('../agent/modules/reminderBuilder.js', () => ({ buildReminderList: async () => ({ reminders: [] }), formatRemindersForDisplay: () => '', getRandomReminders: async () => ({ reminders: [] }) }));
vi.mock('../chat/modules/helpers.js', () => ({ getUserName: async () => 'Reader', streamText: vi.fn() }));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: async () => ({ classList: { add() {}, remove() {} } }) }));
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: async () => {} }));
vi.mock('../chat/modules/mentionAutocomplete.js', () => ({ updateEmailCacheForMentions: async () => {} }));
vi.mock('../agent/modules/promptStore.js', () => ({ withPromptStore: async body => body({
  holds: () => true,
  field: async () => ({ value: (await browser.storage.local.get('task_execution_cache')).task_execution_cache }),
  saveField: async (field, value) => browser.storage.local.set({ task_execution_cache: value }),
}) }));
vi.mock('../agent/modules/promptGenerator.js', () => ({ getUserKBPrompt: vi.fn(async () => '') }));
vi.mock('../chat/modules/markdown.js', () => ({ renderMarkdown: async s => s }));
vi.mock('../agent/modules/llm.js', () => ({ sendChat: vi.fn(async () => ({ assistant: 'Synthetic scheduled result' })) }));
vi.mock('../chat/tools/core.js', () => ({ executeToolsHeadless: async () => { throw new Error('forbidden tools'); } }));
vi.mock('../chat/modules/chatWindowUtils.js', () => ({ isChatWindowOpen: vi.fn(async () => true), openOrFocusChatWindow: vi.fn(async () => {}) }));

const DAY_MS = 24 * 60 * 60 * 1000;
const copy = value => (value === undefined ? undefined : structuredClone(value));

let data, alarmListeners;
let store, ctx, ids, history, doc;

// Hold a promise-returning step until released.
function hold() {
  let reached, release;
  const atHold = new Promise(r => { reached = r; });
  const released = new Promise(r => { release = r; });
  return { atHold, reached, released, release };
}

// Hold the next read of `key` (after it has read) until released: the
// writer's own read of the stored turns, or a page's or the task delivery's.
function holdNextRead(key) {
  const h = hold();
  const get = browser.storage.local.get.getMockImplementation();
  let armed = true;
  browser.storage.local.get.mockImplementation(async keys => {
    const value = await get(keys);
    if (armed && [keys].flat().includes(key)) { armed = false; h.reached(); await h.released; }
    return value;
  });
  return h;
}

// What the chat window has kept: an exchange 40 days old (with the session
// break before it) and one a day old.
function seed() {
  const now = Date.now();
  const turn = (id, role, daysAgo) => ({
    _id: id, _ts: now - daysAgo * DAY_MS, _type: 'normal', _chars: 10, role, content: `${id} text`,
  });
  return {
    'task.enabled': true,
    'notifications.proactive_enabled': false,
    chat_turns: [
      { _id: 'old-break', _ts: now - 41 * DAY_MS, _type: 'session_break', _chars: 0, role: 'assistant', content: 'break' },
      turn('old-user', 'user', 40),
      turn('old-assistant', 'assistant', 40),
      turn('recent-user', 'user', 1),
      turn('recent-assistant', 'assistant', 1),
    ],
    chat_meta: { lastActivityTs: now - DAY_MS, totalChars: 40, lastKbUpdateTs: 0, kbCursorId: null },
  };
}

// What the background answers: the stored turns' writer (its real handler),
// and the memory helper.
let queue;
function background(msg) {
  if (msg?.command === 'chat-turns-change') return storedTurnsRoute(queue)(msg);
  return Promise.resolve(helperReply(msg));
}

function helperReply(msg) {
  switch (msg.cmd) {
    case 'memoryStats': return { docs: 0, usedBytes: 0, dbBytes: 0 };
    case 'memorySearch': return [];
    case 'memoryRemoveBatch': return { ok: true, count: msg.ids.length };
    case 'memoryClear': return { ok: true };
    default: return undefined;
  }
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const dom = new JSDOM(readFileSync(resolve('prompts/prompts.html'), 'utf8'));
  globalThis.document = dom.window.document;
  globalThis.Option = dom.window.Option;
  globalThis.window = {};
  doc = dom.window.document;
  data = seed();
  alarmListeners = new Set();
  const pick = keys => {
    if (keys == null) return copy(data);
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in data).map(k => [k, copy(data[k])]));
    return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in data ? copy(data[k]) : v]));
  };
  globalThis.browser = {
    storage: {
      onChanged: { addListener: () => {}, removeListener: () => {} },
      local: {
        get: vi.fn(async keys => pick(keys)),
        set: vi.fn(async values => { for (const [k, v] of Object.entries(values)) data[k] = copy(v); }),
        remove: vi.fn(async keys => { for (const k of [keys].flat()) delete data[k]; }),
      },
    },
    alarms: {
      onAlarm: { addListener: fn => alarmListeners.add(fn), removeListener: fn => alarmListeners.delete(fn) },
      create: async () => {},
      clear: async () => {},
      get: async () => undefined,
    },
    runtime: { getManifest: () => ({ version: 'synthetic' }), sendMessage: vi.fn(msg => background(msg)) },
    notifications: { create: async () => {} },
  };

  store = await import('../chat/modules/persistentChatStore.js');
  ({ ctx } = await import('../chat/modules/context.js'));
  ids = await import('../chat/modules/idTranslator.js');
  history = await import('../prompts/modules/history.js');
  queue = await import('../chat/modules/storedTurnsQueue.js');

  // The chat window as it opens: its turns and metadata loaded.
  ctx.persistedTurns = await store.loadTurns();
  ctx.chatMeta = await store.loadMeta();
  ctx.agentConverseMessages = [{ role: 'system', content: 'system_prompt_agent' }];
  await ids.initIdTranslation();
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.browser;
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.Option;
});

const SEEDED = ['old-break', 'old-user', 'old-assistant', 'recent-user', 'recent-assistant'];
const storedIds = () => (data.chat_turns || []).map(t => t._id);
// What the window shows when it is opened again.
const reopenedIds = async () => (await store.loadTurns()).map(t => t._id);

// One more message, as the chat window persists one.
let sent = 0;
async function send() {
  sent += 1;
  const turn = { _id: `new-${sent}`, _ts: Date.now(), _type: 'normal', _chars: 5, role: 'user', content: `new ${sent}` };
  await store.appendTurn(turn, ctx.persistedTurns);
  return turn;
}

// The chat window closing: chat.js's own save on beforeunload, run as written
// against the real modules it imports.
async function closeWindow() {
  const source = readFileSync(resolve('chat/chat.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let save = null;
  (function visit(node) {
    if (save || !node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.property?.name === 'addEventListener'
      && node.arguments[0]?.value === 'beforeunload'
      && source.slice(node.start, node.end).includes('persistIdMapImmediate')) {
      save = node.arguments[1].body.body[0];
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  })(ast);
  expect(save?.type).toBe('TryStatement');
  const modules = {
    './modules/context.js': { ctx },
    './modules/persistentChatStore.js': store,
    './modules/idTranslator.js': ids,
    '../agent/modules/utils.js': { log: () => {} },
  };
  const globals = {};
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration' || !modules[node.source.value]) continue;
    for (const s of node.specifiers) globals[s.local.name] = modules[node.source.value][s.imported.name];
  }
  runInNewContext(source.slice(save.start, save.end), globals);
  await vi.advanceTimersByTimeAsync(1000);
}

// Delete Old from the page's own controls; `beforeConfirm` runs just before
// the confirmation is clicked.
async function startDeleteOld(days, beforeConfirm = () => {}) {
  await history.loadChatHistory();
  history.initHistoryHandlers();
  // The page has listed the turns.
  await vi.waitFor(() => expect(browser.storage.local.get).toHaveBeenCalledWith('chat_turns'));
  await vi.advanceTimersByTimeAsync(0);
  beforeConfirm();
  doc.getElementById('delete-old-history').click();
  doc.getElementById('delete-days-input').value = String(days);
  doc.getElementById('modal-confirm').click();
}
const status = () => doc.getElementById('status-message').textContent;

// A scheduled task falling due now, delivered by the real background code.
async function dueTask() {
  const { getNowInTimezone } = await import('../agent/modules/taskScheduler.js');
  const now = getNowInTimezone('UTC');
  const pad = n => String(n).padStart(2, '0');
  const { getUserKBPrompt } = await import('../agent/modules/promptGenerator.js');
  getUserKBPrompt.mockResolvedValue(`[Task] Schedule daily ${pad(now.hours === 24 ? 0 : now.hours)}:${pad(now.minutes)} [UTC], Synthetic summary`);
  const proactive = await import('../agent/modules/proactiveCheckin.js');
  proactive.primeProactiveAlarmListener();
  return Promise.all([...alarmListeners].map(fn => fn({ name: 'tabmail-task-eval' })));
}

// The open window receives the task result as chat.js passes it on.
function windowReceivesTaskResults() {
  const delivered = [];
  browser.runtime.sendMessage.mockImplementation(async msg => {
    if (msg.isTaskResult) {
      delivered.push(msg);
      const { insertTaskResultBubble } = await import('../chat/modules/init.js');
      return insertTaskResultBubble(msg.message, msg.taskTurns);
    }
    return background(msg);
  });
  return delivered;
}

it.each(['closed', 'left open'])('keeps a Clear All done with the chat window open, and the message after it, with the window %s', async how => {
  await history.clearChatHistory();
  const next = await send();
  // The model's context for that message leaves the cleared turns out.
  expect(await store.filterAndConvertTurns()).toEqual([{ role: 'user', content: next.content }]);
  if (how === 'closed') await closeWindow();
  else await vi.advanceTimersByTimeAsync(1000);

  expect(storedIds()).toEqual([next._id]);
  expect(await reopenedIds()).toEqual([next._id]);
});

it('keeps a Clear All when the chat window closes without another message', async () => {
  await history.clearChatHistory();
  await closeWindow();

  expect(await reopenedIds()).toEqual([]);
});

it('keeps a Clear All done after the window saved a message, through the window closing', async () => {
  const next = await send();
  await history.clearChatHistory();
  await vi.advanceTimersByTimeAsync(1000);
  await closeWindow();

  expect(storedIds()).not.toContain(next._id);
  expect(await reopenedIds()).toEqual([]);
});

it('keeps a Delete Old done with the chat window open, with the turns it kept and the message after it', async () => {
  await startDeleteOld(30);
  await vi.waitFor(() => expect(status()).toMatch(/^Deleted 3 turns/));
  await vi.advanceTimersByTimeAsync(1000);
  expect(storedIds()).toEqual(['recent-user', 'recent-assistant']);

  const next = await send();
  await closeWindow();

  expect(await reopenedIds()).toEqual(['recent-user', 'recent-assistant', next._id]);
});

it('keeps both a message sent while Delete Old is removing and the removal', async () => {
  let read;
  await startDeleteOld(30, () => { read = holdNextRead('chat_turns'); });
  await read.atHold;

  const sending = send();
  await vi.advanceTimersByTimeAsync(1000);
  read.release();
  const next = await sending;
  await vi.waitFor(() => expect(status()).toMatch(/^Deleted 3 turns/));
  await vi.advanceTimersByTimeAsync(1000);

  expect(storedIds()).toEqual(['recent-user', 'recent-assistant', next._id]);
  await closeWindow();
  expect(await reopenedIds()).toEqual(['recent-user', 'recent-assistant', next._id]);
});

// A scheduled task read the turns before Clear All and stores its result
// after it: the result is added, the cleared turns are not written back.
it('does not bring back cleared turns with a scheduled task result that read them before the Clear All', async () => {
  windowReceivesTaskResults();
  const read = holdNextRead('chat_turns');
  const running = dueTask();
  await read.atHold;

  await history.clearChatHistory();
  read.release();
  await running;
  await vi.advanceTimersByTimeAsync(1000);

  // Only what the task added: its session break and its result.
  expect(data.chat_turns.map(t => t._type)).toEqual(['session_break', 'task_result']);
  expect(storedIds().filter(id => SEEDED.includes(id))).toEqual([]);
  await closeWindow();
  expect((await reopenedIds()).filter(id => SEEDED.includes(id))).toEqual([]);
});

// A task result stored, then cleared by Clear All before it reaches the open
// window: the window shows it, and does not store it or the cleared turns.
it('does not store a scheduled task result Clear All removed before it reached the open window', async () => {
  const { isChatWindowOpen } = await import('../chat/modules/chatWindowUtils.js');
  const delivery = hold();
  isChatWindowOpen.mockImplementationOnce(async () => { delivery.reached(); await delivery.released; return true; });
  const running = dueTask();
  await delivery.atHold;
  const resultId = data.chat_turns.find(t => t._type === 'task_result')._id;

  await history.clearChatHistory();
  const delivered = windowReceivesTaskResults();
  delivery.release();
  await running;
  await vi.advanceTimersByTimeAsync(1000);

  expect(delivered.some(msg => msg.taskTurns.some(t => t._id === resultId))).toBe(true);
  expect(ctx.persistedTurns.some(t => t._id === resultId)).toBe(true);
  expect(storedIds()).toEqual([]);
  await closeWindow();
  expect(await reopenedIds()).toEqual([]);
});

// A scheduled task result whose write fails is logged as not stored, never as
// stored.
it('logs a scheduled task result whose write fails as not stored', async () => {
  const { log } = await import('../agent/modules/utils.js');
  const set = browser.storage.local.set.getMockImplementation();
  browser.storage.local.set.mockImplementation(async values => {
    if ('chat_turns' in values) throw new Error('synthetic save failure');
    return set(values);
  });
  await dueTask();
  await vi.advanceTimersByTimeAsync(0);

  const logged = log.mock.calls.map(([line]) => String(line));
  expect(logged.some(line => line.includes('Failed to persist task result') && line.includes('synthetic save failure'))).toBe(true);
  expect(logged.some(line => line.includes('Persisted task result'))).toBe(false);
  expect(storedIds()).toEqual(SEEDED);
});

// Retry after a failed reply removes the message it sends again. Run as
// written in converse.js, with the re-send itself stubbed.
it('keeps a Clear All when a message sent before it is retried after it', async () => {
  const next = await send();
  ctx.lastUserMessage = next.content;
  await history.clearChatHistory();

  const agentConverse = vi.fn(async () => {});
  const { retryLastMessage } = experimentFunctions(resolve('chat/modules/converse.js'), ['retryLastMessage'], {
    document: { getElementById: () => null }, window: {}, agentConverse,
  }, {
    './persistentChatStore.js': store,
    './idTranslator.js': ids,
    './context.js': { ctx },
    '../../agent/modules/utils.js': { log: () => {} },
  });
  await retryLastMessage();
  await vi.advanceTimersByTimeAsync(1000);

  expect(agentConverse).toHaveBeenCalledWith(next.content);
  expect(ctx.persistedTurns.map(t => t._id)).not.toContain(next._id);
  expect(storedIds()).toEqual([]);
  await closeWindow();
  expect(await reopenedIds()).toEqual([]);
});

// Retry removes the message it sends again from the stored turns too, so the
// re-sent one is not stored twice.
it('removes a retried message from the stored turns', async () => {
  const next = await send();
  ctx.lastUserMessage = next.content;
  const agentConverse = vi.fn(async () => {});
  const { retryLastMessage } = experimentFunctions(resolve('chat/modules/converse.js'), ['retryLastMessage'], {
    document: { getElementById: () => null }, window: {}, agentConverse,
  }, {
    './persistentChatStore.js': store,
    './idTranslator.js': ids,
    './context.js': { ctx },
    '../../agent/modules/utils.js': { log: () => {} },
  });
  expect(storedIds()).toContain(next._id);

  await retryLastMessage();
  await vi.advanceTimersByTimeAsync(1000);

  expect(agentConverse).toHaveBeenCalledWith(next.content);
  expect(storedIds()).toEqual(SEEDED);
});

// Delete Old whose write fails says it failed, never that it deleted, and the
// turns stay.
it('says Delete Old failed when its write fails, keeping the turns', async () => {
  const set = browser.storage.local.set.getMockImplementation();
  browser.storage.local.set.mockImplementation(async values => {
    if ('chat_turns' in values) throw new Error('synthetic save failure');
    return set(values);
  });
  await startDeleteOld(30);

  await vi.waitFor(() => expect(status()).toMatch(/^Failed to delete old history/));
  expect(status()).toContain('synthetic save failure');
  expect(storedIds()).toEqual(SEEDED);
});

const memoryCleared = () => browser.runtime.sendMessage.mock.calls.some(([msg]) => msg?.cmd === 'memoryClear');

// Clear All from the page's own controls.
async function startClearAll() {
  await history.loadChatHistory();
  history.initHistoryHandlers();
  await vi.advanceTimersByTimeAsync(0);
  history.showClearAllConfirmation();
  doc.getElementById('modal-confirm').click();
}

// A Clear All whose write fails says it failed, and clears nothing that goes
// with the turns: the turns stay, and so do their metadata and memory.
it('says Clear All failed when its write fails, keeping the turns, their metadata and memory', async () => {
  const remove = browser.storage.local.remove.getMockImplementation();
  browser.storage.local.remove.mockImplementation(async keys => {
    if ([keys].flat().includes('chat_turns')) throw new Error('synthetic save failure');
    return remove(keys);
  });
  await startClearAll();

  await vi.waitFor(() => expect(status()).toMatch(/^Failed to clear chat history/));
  expect(status()).toContain('synthetic save failure');
  expect(storedIds()).toEqual(SEEDED);
  expect(data.chat_meta).toBeDefined();
  expect(memoryCleared()).toBe(false);
});

// A task result after a session break adds no second break.
it('adds a scheduled task result after a stored session break without another break', async () => {
  data.chat_turns.push({ _id: 'last-break', _ts: Date.now(), _type: 'session_break', _chars: 0, role: 'assistant', content: '' });
  windowReceivesTaskResults();
  await dueTask();
  await vi.advanceTimersByTimeAsync(1000);

  expect(data.chat_turns.slice(-2).map(t => t._type)).toEqual(['session_break', 'task_result']);
  expect(data.chat_turns.at(-2)._id).toBe('last-break');
});

// The writer every change to the stored turns goes through.
const turnAt = id => ({ _id: id, _ts: Date.now(), _type: 'normal', _chars: 1, role: 'user', content: id });

it('applies changes in the order they were sent', async () => {
  const read = holdNextRead('chat_turns');
  const first = store.changeTurns({ keepFrom: Date.now() - 30 * DAY_MS });
  await read.atHold;
  const second = store.changeTurns({ append: [turnAt('a')] });
  const third = store.changeTurns({ append: [turnAt('b')] });
  read.release();
  await Promise.all([first, second, third]);

  expect(storedIds()).toEqual(['recent-user', 'recent-assistant', 'a', 'b']);
});

it('says a change whose write fails was not stored, and applies the ones after it', async () => {
  const set = browser.storage.local.set.getMockImplementation();
  browser.storage.local.set.mockImplementation(async values => {
    if ('chat_turns' in values && values.chat_turns.some(t => t._id === 'refused') && !data.refusedOnce) {
      data.refusedOnce = true;
      throw new Error('synthetic write failure');
    }
    return set(values);
  });
  const sending = send();
  const refused = expect(store.changeTurns({ append: [turnAt('refused')] })).rejects.toThrow('synthetic write failure');
  const after = store.changeTurns({ append: [turnAt('after')] });
  const next = await sending;
  await refused;
  await expect(after).resolves.toEqual({ applied: true, removed: 0 });
  expect(storedIds()).toEqual([...SEEDED, next._id, 'after']);
});

it('stores a message the window sent while another change was applying, though the window closed meanwhile', async () => {
  let read;
  await startDeleteOld(30, () => { read = holdNextRead('chat_turns'); });
  await read.atHold;
  const sending = send();
  await vi.advanceTimersByTimeAsync(0);
  // The window's change is with the background before it closes; closing
  // saves no turns.
  await closeWindow();

  read.release();
  await sending;
  await vi.waitFor(() => expect(status()).toMatch(/^Deleted 3 turns/));
  expect(await reopenedIds()).toEqual(['recent-user', 'recent-assistant', 'new-' + sent]);
});

