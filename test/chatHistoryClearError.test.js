/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #146: the Chat History tab's Clear All says the history was cleared only
// when the helper cleared its memory. The FTS engine answers a failed
// memoryClear with `{ error }` rather than rejecting, so the page must read
// the reply. This runs the real page (prompts/prompts.html) through the
// Clear All confirmation against a fake helper that holds memory rows and
// whose memoryClear succeeds, answers an error, or rejects. Storage keeps
// what is written, and the chat store's migration and memory writer are the
// real ones, so a failed clear is checked against what happens next.

import { afterEach, describe, expect, it, vi } from 'vitest';
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
const HOUR_MS = 60 * 60 * 1000;

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

// A helper holding memory rows; `helper.clear` sets how memoryClear answers.
function fakeHelper() {
  const memory = new Map();
  const helper = { memory, clear: 'ok' };
  helper.sendMessage = vi.fn(async msg => {
    switch (msg.cmd) {
      case 'memoryStats':
        return { docs: memory.size, usedBytes: memory.size, dbBytes: memory.size };
      case 'memorySearch':
        return [];
      case 'memoryIndexBatch':
        for (const row of msg.rows) memory.set(row.memId, row);
        return { ok: true, count: msg.rows.length };
      case 'memoryClear':
        if (helper.clear === 'error') return { error: 'clear' };
        if (helper.clear === 'rejection') throw new Error('Native FTS helper not connected');
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
    async clearAll() {
      history.showClearAllConfirmation();
      d.getElementById('modal-confirm').click();
      await vi.waitFor(() => expect([CLEARED, FAILED]).toContain(statusEl.textContent));
    },
    status: () => statusEl.textContent,
    statusIsError: () => statusEl.className === 'error',
  };
}

describe('Chat History Clear All reports what the helper did (#146)', () => {
  it('says cleared when the helper clears its memory', async () => {
    const page = await openPage();
    await page.indexChatTurn('request', 'reply', 'old', Date.now() - HOUR_MS);
    expect(page.helper.memory.size).toBe(1);
    await page.clearAll();
    expect(page.status()).toBe(CLEARED);
    expect(page.statusIsError()).toBe(false);
    expect(page.helper.memory.size).toBe(0);
  });

  for (const [failure, answer] of [['error', 'an error'], ['rejection', 'a rejection']]) {
    it(`says it failed when the helper's memoryClear answers with ${answer}`, async () => {
      const page = await openPage();
      page.helper.clear = failure;
      await page.clearAll();
      expect(page.status()).toBe(FAILED);
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
      expect(page.status()).toBe(FAILED);
      expect(page.helper.memory.has('turn:old')).toBe(true);

      page.helper.clear = 'ok';
      await page.indexChatTurn('new request', 'new reply', 'newer', Date.now());
      await page.store.migrateFromSessions();
      expect(page.helper.memory.has('turn:newer')).toBe(true);
    });
  }
});
