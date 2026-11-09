/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Turns Chat History removes leave nothing of theirs behind (#256, #257): a
// removed turn's stored thinking goes with it, and once the chat window opens
// its id map holds only the stored turns' message references, also when a
// window that was open during the removal saved its own map afterwards. The
// turns that stay keep their thinking and references.
//
// This runs the real settings page (prompts/prompts.html) for Delete Old and
// Clear All, the real background writer of the stored turns, and the real
// chat-window start (initAndGreetUser), against one storage that, as
// Thunderbird's does, keeps copies.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { storedTurnsRoute } from './support/storedTurnsRoute.js';

// The turns' stored thinking, kept as IndexedDB would keep it, across windows.
const idb = vi.hoisted(() => ({ data: new Map() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async keys => Object.fromEntries([keys].flat().filter(k => idb.data.has(k)).map(k => [k, idb.data.get(k)]))),
  set: vi.fn(async values => { for (const [k, v] of Object.entries(values)) idb.data.set(k, v); }),
  remove: vi.fn(async keys => { for (const k of [keys].flat()) idb.data.delete(k); }),
  getAllKeys: vi.fn(async () => [...idb.data.keys()]),
}));
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/inboxContext.js', () => ({ buildInboxContext: async () => '[]' }));
vi.mock('../agent/modules/promptGenerator.js', () => ({ getUserKBPrompt: async () => '' }));
vi.mock('../agent/modules/reminderBuilder.js', () => ({
  buildReminderList: async () => ({ reminders: [] }), getRandomReminders: async () => ({ reminders: [] }), formatRemindersForDisplay: () => '',
}));
vi.mock('../agent/modules/knowledgebase.js', () => ({ periodicKbUpdate: async () => {} }));
vi.mock('../agent/modules/proactiveCheckin.js', () => ({ consumePendingProactiveMessage: async () => null }));
vi.mock('../chat/modules/helpers.js', () => ({ getUserName: async () => 'Reader', streamText: vi.fn(async () => {}) }));
vi.mock('../chat/modules/mentionAutocomplete.js', () => ({ updateEmailCacheForMentions: async () => {} }));
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chat/modules/markdown.js', () => ({ renderMarkdown: async s => s }));
vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: async () => {
    const row = document.createElement('div');
    const bubble = document.createElement('div');
    row.append(bubble);
    document.getElementById('chat-container').append(row);
    return bubble;
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const copy = value => (value === undefined ? undefined : structuredClone(value));
let data, doc;

// The chat as kept: an exchange 40 days old and one a day old, each answer
// naming one message, with its thinking stored.
function seed() {
  const now = Date.now();
  const turn = (id, role, daysAgo, content, refs) => ({
    _id: id, _ts: now - daysAgo * DAY_MS, _type: 'normal', _chars: 10, role, content, _refs: refs,
  });
  return {
    chat_turns_migration_v1: 1, chat_turns_migration_v2: 1, chat_turns_migration_v3: 1, chat_refs_migration_v1: 1,
    chat_turns: [
      turn('old-user', 'user', 40, 'What came in?', []),
      turn('old-assistant', 'assistant', 40, 'See [Email](1)', [1]),
      turn('recent-user', 'user', 1, 'And today?', []),
      turn('recent-assistant', 'assistant', 1, 'See [Email](2)', [2]),
    ],
    chat_meta: { lastActivityTs: now - DAY_MS, lastKbUpdateTs: 0, kbCursorId: null },
    chat_id_map: { entries: [[1, 'old-message'], [2, 'recent-message']], nextNumericId: 3, freeIds: [], refCounts: [[1, 1], [2, 1]] },
  };
}

// What the background answers: the stored turns' writer (its real handler),
// and the memory helper.
async function background(msg) {
  if (msg?.command === 'chat-turns-change') return storedTurnsRoute(await import('../chat/modules/storedTurnsQueue.js'))(msg);
  switch (msg?.cmd) {
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
  doc = dom.window.document;
  doc.body.insertAdjacentHTML('beforeend', '<div id="chat-container"></div>');
  globalThis.document = doc;
  globalThis.Option = dom.window.Option;
  globalThis.window = {};
  data = seed();
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
    runtime: { getManifest: () => ({ version: 'synthetic' }), sendMessage: vi.fn(msg => background(msg)) },
  };
  idb.data.clear();
  const store = await import('../chat/modules/persistentChatStore.js');
  await store.saveThinking('old-assistant', 'old thinking');
  await store.saveThinking('recent-assistant', 'recent thinking');
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.browser;
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.Option;
});

// Open the chat window: the real start, then its debounced id-map save.
async function openWindow() {
  const { initAndGreetUser } = await import('../chat/modules/init.js');
  await initAndGreetUser();
  await vi.advanceTimersByTimeAsync(1000);
  const { ctx } = await import('../chat/modules/context.js');
  return { ctx, ids: await import('../chat/modules/idTranslator.js'), store: await import('../chat/modules/persistentChatStore.js') };
}

// The window closes and a new one opens later: its own copy of the modules.
async function reopenWindow() {
  vi.resetModules();
  return openWindow();
}

// Delete Old from the settings page's own controls.
async function deleteOld(days) {
  const history = await import('../prompts/modules/history.js');
  await history.loadChatHistory();
  history.initHistoryHandlers();
  doc.getElementById('delete-old-history').click();
  doc.getElementById('delete-days-input').value = String(days);
  doc.getElementById('modal-confirm').click();
  await vi.waitFor(() => expect(doc.getElementById('status-message').textContent).toMatch(/^Deleted 2 turns/));
}

const thinkingKept = async () => {
  const { loadThinkingBatch } = await import('../chat/modules/persistentChatStore.js');
  const found = await loadThinkingBatch(['old-assistant', 'recent-assistant']);
  return Object.keys(found).filter(id => found[id] !== null);
};
// The message references the saved id map keeps.
const savedReferences = () => Object.fromEntries(data.chat_id_map.entries);
const windowReferences = ctx => Object.fromEntries(ctx.idTranslation.idMap);

it('Delete Old with the chat window closed: the removed turns\' thinking goes, and their references once the window opens', async () => {
  await deleteOld(30);
  expect(await thinkingKept()).toEqual(['recent-assistant']);

  const { ctx } = await openWindow();
  expect(windowReferences(ctx)).toEqual({ 2: 'recent-message' });
  expect(savedReferences()).toEqual({ 2: 'recent-message' });
  expect(await thinkingKept()).toEqual(['recent-assistant']);
});

it('Delete Old with the chat window open: the window keeps the references of the turns it still shows; the next open releases them', async () => {
  const { ctx, ids } = await openWindow();
  await deleteOld(30);
  expect(await thinkingKept()).toEqual(['recent-assistant']);
  // The open window still shows the old answer, and its reference still
  // names the same message.
  expect(windowReferences(ctx)).toEqual({ 1: 'old-message', 2: 'recent-message' });

  // The window saves its map as it closes, references of the removed turns included.
  await ids.persistIdMapImmediate();
  expect(savedReferences()).toEqual({ 1: 'old-message', 2: 'recent-message' });

  const reopened = await reopenWindow();
  expect(windowReferences(reopened.ctx)).toEqual({ 2: 'recent-message' });
  expect(savedReferences()).toEqual({ 2: 'recent-message' });
});

it('Clear All with the chat window open: what the window saves back afterwards is released at the next open, and a message sent after it stays', async () => {
  const { ctx, ids, store } = await openWindow();
  const history = await import('../prompts/modules/history.js');
  await history.clearChatHistory();
  expect(await thinkingKept()).toEqual([]);
  expect(data.chat_id_map).toBeUndefined();

  // A message sent in that window after the Clear All, naming a new message:
  // the window's debounced save writes its whole map back.
  const n = ids.toNumericId('new-message');
  const turn = { _id: 'new-user', _ts: Date.now(), _type: 'normal', _chars: 5, role: 'user', content: 'chat_converse', user_message: `About [Email](${n})` };
  turn._refs = ids.collectTurnRefs(turn);
  ids.registerTurnRefs(turn);
  await store.appendTurn(turn, ctx.persistedTurns);
  await vi.advanceTimersByTimeAsync(1000);
  expect(savedReferences()).toEqual({ 1: 'old-message', 2: 'recent-message', [n]: 'new-message' });

  const reopened = await reopenWindow();
  expect(windowReferences(reopened.ctx)).toEqual({ [n]: 'new-message' });
  expect(savedReferences()).toEqual({ [n]: 'new-message' });
});
