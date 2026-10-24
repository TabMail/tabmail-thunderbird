/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #146: the Chat History tab's Clear All says the history was cleared only
// when the helper cleared its memory. The FTS engine answers a failed
// memoryClear with `{ error }` rather than rejecting, so the page must read
// the reply. This runs the real page (prompts/prompts.html) through the
// Clear All confirmation against a fake helper whose memoryClear succeeds,
// answers an error, or rejects.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/persistentChatStore.js', () => ({ clearAllThinking: vi.fn() }));

const CLEARED = 'Chat history cleared';
const FAILED = 'Failed to clear chat history';

afterEach(() => {
  delete globalThis.browser;
  delete globalThis.document;
  delete globalThis.Option;
});

// A helper whose memoryClear answers with `clear()`.
function fakeHelper(clear) {
  const sendMessage = vi.fn(async msg => {
    switch (msg.cmd) {
      case 'memoryStats':
        return { docs: 1, usedBytes: 1, dbBytes: 1 };
      case 'memorySearch':
        return [];
      case 'memoryClear':
        return clear();
      default:
        throw new Error(`unexpected helper command: ${msg.cmd}`);
    }
  });
  return { sendMessage };
}

async function openPage(helper) {
  vi.resetModules();
  const dom = new JSDOM(readFileSync(resolve('prompts/prompts.html'), 'utf8'));
  globalThis.document = dom.window.document;
  globalThis.Option = dom.window.Option;
  globalThis.browser = {
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { sendMessage: helper.sendMessage },
  };
  const history = await import('../prompts/modules/history.js');
  await history.loadChatHistory();
  history.initHistoryHandlers();
  const d = dom.window.document;
  const statusEl = d.getElementById('status-message');
  return {
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
    const page = await openPage(fakeHelper(async () => ({ ok: true })));
    await page.clearAll();
    expect(page.status()).toBe(CLEARED);
    expect(page.statusIsError()).toBe(false);
  });

  for (const [name, clear] of [
    ['answers an error', async () => ({ error: 'clear' })],
    ['rejects', async () => { throw new Error('Native FTS helper not connected'); }],
  ]) {
    it(`says it failed when the helper's memoryClear ${name}`, async () => {
      const page = await openPage(fakeHelper(clear));
      await page.clearAll();
      expect(page.status()).toBe(FAILED);
      expect(page.statusIsError()).toBe(true);
    });
  }
});
