/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Opening the chat window changes the stored turns: it drops trailing
// greetings and extra session breaks, keeps the list within the budget, adds
// the first greeting or a session break, and adds message references to old
// turns once. Each is an operation on the stored turns, never a write of the
// window's copy, so a turn another page stored while the window was opening
// (a scheduled task's result) stays.
//
// This runs the real chat-window start (initAndGreetUser) against one
// storage that, as Thunderbird's does, keeps copies.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { storedTurnsRoute } from './support/storedTurnsRoute.js';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}), getAllKeys: vi.fn(async () => []),
}));
vi.mock('../agent/modules/inboxContext.js', () => ({ buildInboxContext: async () => '[]' }));
vi.mock('../agent/modules/promptGenerator.js', () => ({ getUserKBPrompt: async () => '' }));
vi.mock('../agent/modules/reminderBuilder.js', () => ({
  buildReminderList: async () => ({ reminders: [] }), getRandomReminders: async () => ({ reminders: [] }), formatRemindersForDisplay: () => '',
}));
// The session break starts a KB update without waiting for it; under load it
// can run into the next case and read the stored turns before that window does.
vi.mock('../agent/modules/knowledgebase.js', () => ({ periodicKbUpdate: async () => {} }));
vi.mock('../agent/modules/proactiveCheckin.js', () => ({ consumePendingProactiveMessage: async () => null }));
vi.mock('../chat/modules/helpers.js', () => ({ getUserName: async () => 'Reader', streamText: vi.fn(async () => {}) }));
vi.mock('../chat/modules/mentionAutocomplete.js', () => ({ updateEmailCacheForMentions: async () => {} }));
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chat/modules/markdown.js', () => ({ renderMarkdown: async s => s }));
vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: async () => {
    const row = document.createElement('div');
    row.className = 'message-row';
    const bubble = document.createElement('div');
    row.append(bubble);
    document.getElementById('chat-container').append(row);
    return bubble;
  },
}));

const copy = value => (value === undefined ? undefined : structuredClone(value));
let data;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const dom = new JSDOM('<div id="chat-container"></div>');
  globalThis.document = dom.window.document;
  globalThis.window = {};
  data = { chat_refs_migration_v1: 1, chat_turns_migration_v1: 1, chat_turns_migration_v2: 1 };
  const pick = keys => {
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
    // The background's answer: the stored turns' queue, through its real handler.
    runtime: {
      sendMessage: vi.fn(async msg => {
        const queue = await import('../chat/modules/storedTurnsQueue.js');
        return storedTurnsRoute(queue)(msg);
      }),
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.browser;
  delete globalThis.document;
  delete globalThis.window;
});

const turn = (id, type = 'normal', role = 'user', chars = 1) => ({
  _id: id, _ts: Date.now(), _type: type, _chars: chars, role, content: `${id} text`,
});
const storedIds = () => (data.chat_turns || []).map(t => t._id);

// Open the chat window; while it opens, after it has read the stored turns,
// another page stores a scheduled task's result.
async function openWindowWhileATaskStoresItsResult() {
  const store = await import('../chat/modules/persistentChatStore.js');
  const get = browser.storage.local.get.getMockImplementation();
  let stored = false;
  browser.storage.local.get.mockImplementation(async keys => {
    const value = await get(keys);
    if ([keys].flat().includes('chat_turns') && !stored) {
      stored = true;
      await store.changeTurns({ append: [turn('task', 'task_result', 'assistant')] });
    }
    return value;
  });
  const { initAndGreetUser } = await import('../chat/modules/init.js');
  await initAndGreetUser();
  await vi.advanceTimersByTimeAsync(1000);
  const { ctx } = await import('../chat/modules/context.js');
  return ctx;
}

it('removes trailing greetings and extra session breaks by id, keeping a turn stored meanwhile', async () => {
  data.chat_turns = [turn('u1'), turn('a1', 'normal', 'assistant'), turn('break-1', 'session_break', 'assistant', 0),
    turn('greeting', 'welcome_back', 'assistant'), turn('break-2', 'session_break', 'assistant', 0)];

  const ctx = await openWindowWhileATaskStoresItsResult();

  expect(storedIds()).toEqual(['u1', 'a1', 'break-2', 'task']);
  expect(ctx.persistedTurns.map(t => t._id)).toEqual(['u1', 'a1', 'break-2']);
});

// A removal the background refuses at the window's start leaves the stored
// turns as they were and does not stop the window from opening.
it('opens the window when the background refuses its load-time removal, storing what it adds after', async () => {
  data.chat_turns = [turn('u1'), turn('a1', 'normal', 'assistant'), turn('greeting', 'welcome_back', 'assistant')];
  const send = browser.runtime.sendMessage.getMockImplementation();
  browser.runtime.sendMessage.mockImplementation(async msg => (msg.op?.remove ? { applied: false, error: 'synthetic refusal' } : send(msg)));

  const { initAndGreetUser } = await import('../chat/modules/init.js');
  await initAndGreetUser();
  await vi.advanceTimersByTimeAsync(1000);

  const { awaitUserInput } = await import('../chat/modules/converse.js');
  const { ctx } = await import('../chat/modules/context.js');
  expect(awaitUserInput).toHaveBeenCalled();
  const added = ctx.persistedTurns.at(-1);
  expect(added._type).toBe('session_break');
  expect(ctx.persistedTurns.map(t => t._id)).toEqual(['u1', 'a1', added._id]);
  expect(storedIds()).toEqual(['u1', 'a1', 'greeting', added._id]);
});

it('removes the turns over the budget by id, keeping a turn stored meanwhile', async () => {
  data.chat_turns = Array.from({ length: 102 }, (_, i) => turn(`t${i}`, 'normal', i % 2 ? 'assistant' : 'user'));

  const ctx = await openWindowWhileATaskStoresItsResult();

  // The window dropped the two oldest; the store, holding the task's result
  // and then the window's session break too, dropped two more.
  expect(ctx.persistedTurns[0]._id).toBe('t2');
  expect(storedIds()).toHaveLength(100);
  expect(storedIds().slice(0, 1)).toEqual(['t4']);
  expect(storedIds().slice(-3)).toEqual(['t101', 'task', ctx.persistedTurns.at(-1)._id]);
});

// The turns the window drops over the budget have their message references
// released; they leave the stored turns even when nothing the window adds is
// stored, so a later start does not drop and release them again.
it('removes the turns over the budget from the stored turns when nothing the window adds is stored', async () => {
  data.chat_turns = Array.from({ length: 102 }, (_, i) => turn(`t${i}`, 'normal', i % 2 ? 'assistant' : 'user'));
  const send = browser.runtime.sendMessage.getMockImplementation();
  browser.runtime.sendMessage.mockImplementation(async msg => (msg.op?.append ? undefined : send(msg)));

  const { initAndGreetUser } = await import('../chat/modules/init.js');
  await initAndGreetUser();
  await vi.advanceTimersByTimeAsync(1000);

  expect(storedIds()).toEqual(Array.from({ length: 100 }, (_, i) => `t${i + 2}`));
});

it('adds a session break after the stored turns, keeping a turn stored meanwhile', async () => {
  data.chat_turns = [turn('u1'), turn('a1', 'normal', 'assistant')];

  const ctx = await openWindowWhileATaskStoresItsResult();

  const added = ctx.persistedTurns.at(-1);
  expect(added._type).toBe('session_break');
  expect(storedIds()).toEqual(['u1', 'a1', 'task', added._id]);
});

it('adds the first greeting, keeping a turn stored meanwhile', async () => {
  const ctx = await openWindowWhileATaskStoresItsResult();

  const greeting = ctx.persistedTurns.at(-1);
  expect(ctx.persistedTurns).toHaveLength(1);
  expect(storedIds()).toEqual(['task', greeting._id]);
});

it('adds message references to the stored turns once, changing no others', async () => {
  delete data.chat_refs_migration_v1;
  data.chat_turns = [turn('u1'), turn('a1', 'normal', 'assistant')];

  await openWindowWhileATaskStoresItsResult();

  expect(data.chat_turns.find(t => t._id === 'u1')._refs).toEqual([]);
  expect(data.chat_turns.find(t => t._id === 'task')._refs).toBeUndefined();
  expect(storedIds().slice(0, 3)).toEqual(['u1', 'a1', 'task']);
  expect(data.chat_refs_migration_v1).toBeTruthy();
});

it('opens the window after a change sent before it failed, and applies the window\'s own changes after it', async () => {
  data.chat_turns = [turn('u1'), turn('a1', 'normal', 'assistant'), turn('greeting', 'welcome_back', 'assistant')];
  // A change another page sent first (adding references to a1), whose write fails.
  browser.storage.local.set.mockRejectedValueOnce(new Error('synthetic write failure'));
  const store = await import('../chat/modules/persistentChatStore.js');
  const first = store.changeTurns({ update: [{ ...turn('a1', 'normal', 'assistant'), _refs: ['r'] }] });

  const { initAndGreetUser } = await import('../chat/modules/init.js');
  const { awaitUserInput } = await import('../chat/modules/converse.js');
  await initAndGreetUser();

  await expect(first).rejects.toThrow('synthetic write failure');
  const { ctx } = await import('../chat/modules/context.js');
  expect(awaitUserInput).toHaveBeenCalled();
  const sessionBreak = ctx.persistedTurns.at(-1);
  expect(sessionBreak._type).toBe('session_break');
  // The greeting's removal and the session break were applied after the failure.
  expect(storedIds()).toEqual(['u1', 'a1', sessionBreak._id]);
  expect(data.chat_turns[1]._refs).toBeUndefined();
});
