/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #146: the Chat History tab's Clear All says the history was cleared only
// when the helper cleared its memory. The FTS engine answers a failed
// memoryClear with `{ error }` rather than rejecting, so the page must read
// the reply. This runs the real page (prompts/prompts.html) through the
// Clear All confirmation against a fake helper that holds memory rows and
// whose memoryClear succeeds, answers an error, rejects, gets no reply, or
// answers without confirming it (#248). Storage keeps
// what is written, and the chat store's migration and memory writer are the
// real ones, so a clear, failed or confirmed, is checked against what happens
// next.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendToBackground } from './support/storedTurnsRoute.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  getAllKeys: vi.fn(async () => []),
}));

const CLEARED = 'Chat history cleared';
const FAILED = 'Failed to clear chat history';
// What the status says for each way memoryClear can fail: the helper's
// reason, or that it did not confirm the clear.
const FAILED_BECAUSE = {
  error: `${FAILED}: clear`,
  rejection: `${FAILED}: Native FTS helper not connected`,
  'no reply': `${FAILED}: the search helper did not confirm it`,
  'unconfirmed reply': `${FAILED}: the search helper did not confirm it`,
};
const HOUR_MS = 60 * 60 * 1000;
// What the one-time migrations wrote once they ran. Each is read at startup;
// the chat store's v2 migration clears memory when its flag is missing.
const MIGRATION_FLAGS = [
  'memory_fts_migration_v1_done',
  'memory_fts_migrated_sessions',
  'chat_turns_migration_v1',
  'chat_turns_migration_v2',
  'chat_refs_migration_v1',
];

afterEach(() => {
  delete globalThis.browser;
  delete globalThis.document;
  delete globalThis.Option;
});

function fakeStorage() {
  const data = {};
  const pick = keys => {
    if (keys == null) return { ...data };
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]]));
    return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in data ? data[k] : v]));
  };
  return {
    data,
    onChanged: { addListener() {} },
    local: {
      get: vi.fn(async keys => pick(keys)),
      set: vi.fn(async patch => { Object.assign(data, patch); }),
      remove: vi.fn(async keys => { for (const k of [keys].flat()) delete data[k]; }),
    },
  };
}

// A helper holding memory rows; `helper.clear` sets how memoryClear answers,
// and `helper.clearHeld`, when set, is awaited before it answers.
function fakeHelper() {
  const memory = new Map();
  const helper = { memory, clear: 'ok', clearHeld: null };
  helper.sendMessage = vi.fn(async msg => {
    if (msg.command === 'chat-turns-change') return sendToBackground(msg);
    switch (msg.cmd) {
      case 'memoryStats':
        return { docs: memory.size, usedBytes: memory.size, dbBytes: memory.size };
      case 'memorySearch':
        return [];
      case 'memoryIndexBatch':
        for (const row of msg.rows) memory.set(row.memId, row);
        return { ok: true, count: msg.rows.length };
      case 'memoryClear':
        if (helper.clearHeld) await helper.clearHeld;
        if (helper.clear === 'error') return { error: 'clear' };
        if (helper.clear === 'rejection') throw new Error('Native FTS helper not connected');
        // No listener answers while the background starts or reloads.
        if (helper.clear === 'no reply') return undefined;
        if (helper.clear === 'unconfirmed reply') return {};
        memory.clear();
        return { ok: true };
      default:
        throw new Error(`unexpected helper command: ${msg.cmd}`);
    }
  });
  return helper;
}

async function openPage() {
  vi.resetModules();
  const dom = new JSDOM(readFileSync(resolve('prompts/prompts.html'), 'utf8'));
  globalThis.document = dom.window.document;
  globalThis.Option = dom.window.Option;
  const storage = fakeStorage();
  const helper = fakeHelper();
  globalThis.browser = { storage, runtime: { sendMessage: helper.sendMessage } };
  const store = await import('../chat/modules/persistentChatStore.js');
  const { indexChatTurn } = await import('../fts/memoryIndexer.js');
  const history = await import('../prompts/modules/history.js');
  await history.loadChatHistory();
  history.initHistoryHandlers();
  const d = dom.window.document;
  const statusEl = d.getElementById('status-message');
  return {
    storage,
    helper,
    store,
    indexChatTurn,
    // Clear All as the user does it: open the confirmation, then confirm.
    startClearAll() {
      history.showClearAllConfirmation();
      d.getElementById('modal-confirm').click();
    },
    async clearAll() {
      this.startClearAll();
      await vi.waitFor(() => expect(statusEl.textContent === CLEARED || statusEl.textContent.startsWith(FAILED)).toBe(true));
    },
    status: () => statusEl.textContent,
    statusIsError: () => statusEl.className === 'error',
  };
}

describe('Chat History Clear All reports what the helper did (#146)', () => {
  // A Clear All removes what is kept, never the record that the one-time
  // migrations ran: without it the next startup would run them again, and
  // the chat store's would clear what the user said after the Clear All.
  for (const kind of ['ok', 'error', 'rejection', 'no reply', 'unconfirmed reply']) {
    it(`keeps every migration flag through a Clear All answered with ${kind}`, async () => {
      const page = await openPage();
      for (const key of MIGRATION_FLAGS) page.storage.data[key] = 1;
      page.helper.clear = kind;
      await page.clearAll();
      expect(page.status()).toBe(kind === 'ok' ? CLEARED : FAILED_BECAUSE[kind]);
      expect(MIGRATION_FLAGS.filter(key => !(key in page.storage.data))).toEqual([]);
    });
  }

  it('keeps memory written after a confirmed Clear All through the next chat-window open', async () => {
    const page = await openPage();
    await page.store.migrateFromSessions();
    await page.indexChatTurn('old request', 'old reply', 'old', Date.now() - HOUR_MS);
    await page.clearAll();
    expect(page.status()).toBe(CLEARED);
    expect(page.helper.memory.size).toBe(0);

    // The chat window stays open and keeps the next exchange.
    await page.indexChatTurn('new request', 'new reply', 'newer', Date.now());
    await page.store.migrateFromSessions();
    expect(page.helper.memory.has('turn:newer')).toBe(true);
  });

  // Until the helper answers, nothing is said done: a slow clear (the helper
  // connecting, or near its deadline) reads as pending, then as it answered.
  for (const kind of ['ok', 'no reply']) {
    it(`says it is clearing, never cleared, until memoryClear answers (${kind})`, async () => {
      const page = await openPage();
      page.helper.clear = kind;
      let release;
      page.helper.clearHeld = new Promise(resolve => { release = resolve; });
      page.startClearAll();
      await vi.waitFor(() => expect(page.helper.sendMessage.mock.calls.some(([m]) => m.cmd === 'memoryClear')).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(page.status()).toBe('Clearing chat history...');
      release();
      await vi.waitFor(() => expect(page.status()).toBe(kind === 'ok' ? CLEARED : FAILED_BECAUSE[kind]));
    });
  }

  it('says cleared when the helper clears its memory', async () => {
    const page = await openPage();
    await page.indexChatTurn('request', 'reply', 'old', Date.now() - HOUR_MS);
    expect(page.helper.memory.size).toBe(1);
    await page.clearAll();
    expect(page.status()).toBe(CLEARED);
    expect(page.statusIsError()).toBe(false);
    expect(page.helper.memory.size).toBe(0);
  });

  for (const [failure, answer] of [['error', 'an error'], ['rejection', 'a rejection'], ['no reply', 'no reply'], ['unconfirmed reply', 'a reply that does not confirm it']]) {
    it(`says it failed, and why, when the helper's memoryClear answers with ${answer}`, async () => {
      const page = await openPage();
      page.helper.clear = failure;
      await page.clearAll();
      expect(page.status()).toBe(FAILED_BECAUSE[failure]);
      expect(page.statusIsError()).toBe(true);
    });

    // The chat store's startup migration clears memory unless its flag says
    // it already ran; a failed Clear All must not let that later wipe what
    // the user said after it.
    it(`keeps memory written after a failed clear (${failure}) through the next startup`, async () => {
      const page = await openPage();
      await page.store.migrateFromSessions();
      await page.indexChatTurn('old request', 'old reply', 'old', Date.now() - HOUR_MS);
      page.helper.clear = failure;
      await page.clearAll();
      expect(page.status()).toBe(FAILED_BECAUSE[failure]);
      expect(page.helper.memory.has('turn:old')).toBe(true);

      page.helper.clear = 'ok';
      await page.indexChatTurn('new request', 'new reply', 'newer', Date.now());
      await page.store.migrateFromSessions();
      expect(page.helper.memory.has('turn:newer')).toBe(true);
    });
  }
});
