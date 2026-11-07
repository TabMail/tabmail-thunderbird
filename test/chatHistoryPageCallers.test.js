/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #153: the settings page's own controls list Chat History's newest entries.
// This loads the real prompts.js and history module into one realm, against a
// fake memory helper, and clicks the History tab and its Refresh button as a
// user does; chatHistoryNativeCap.test.js covers the tab's own behaviour.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { createRealm } from './support/deviceRealm.js';

const noop = () => {};

afterEach(() => {
  delete globalThis.browser;
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

// Entries about `word`, a minute apart, newest first.
const entriesOf = (count, word, newestMs = Date.now() - 60_000) => Array.from({ length: count }, (_, i) => ({
  memId: `${word}${i}`,
  sessionId: 'persistent_chat',
  role: 'exchange',
  content: `[USER]: ${word} request ${i}\n\n[AGENT]: ${word} reply ${i}`,
  dateMs: newestMs - i * 60_000,
}));

// Memory as the helper answers it: stats, and the newest entries for a listing.
function fakeHelper(entries) {
  const stored = [...entries];
  const calls = [];
  const sendMessage = async msg => {
    calls.push(msg);
    if (msg.cmd === 'memoryStats') return { docs: stored.length, usedBytes: 1, dbBytes: 1 };
    if (msg.cmd === 'memorySearch' && msg.q === '') return [...stored].sort((a, b) => b.dateMs - a.dateMs).slice(0, msg.limit);
    throw new Error(`unexpected helper command: ${msg.cmd}`);
  };
  return { stored, calls, sendMessage };
}

async function openSettingsPage(helper) {
  const dom = new JSDOM(readFileSync(resolve('prompts/prompts.html'), 'utf8'));
  const document = dom.window.document;
  // The shipped settings, which read storage when they load.
  globalThis.browser = { storage: { onChanged: { addListener: noop } } };
  const { SETTINGS } = await import('../agent/modules/config.js');
  const { CHAT_SETTINGS } = await import('../chat/modules/chatConfig.js');
  const browser = {
    storage: { onChanged: { addListener: noop }, local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: {
      sendMessage: async msg => (msg.type === 'fts' ? helper.sendMessage(msg) : { ok: true, connected: false }),
      getURL: path => `moz-extension://example/${path}`,
    },
  };
  const realm = createRealm({
    files: ['prompts/prompts.js', 'prompts/modules/history.js', 'prompts/modules/utils.js', 'fts/memorySizeLimit.js'],
    stubs: {
      'agent/modules/utils.js': { log: noop },
      'agent/modules/config.js': { SETTINGS },
      'chat/modules/chatConfig.js': { CHAT_SETTINGS },
      'agent/modules/actionCompactConfig.js': { ACTION_CONFIG_TS_KEY: 'action-config-ts' },
      'theme/palette/palette.js': { injectPaletteIntoDocument: async () => {} },
      'prompts/modules/developer.js': { clearTestOutput: noop, runKbRefineTest: noop },
      'chat/modules/persistentChatStore.js': { clearAllThinking: async () => {} },
      'agent/modules/promptStore.js': { BULLET_STATE_KEYS: {}, PROMPT_KEYS: {}, SECTION_MARKER_REFUSAL: 'refused', readView: async () => ({ content: '', captured: {} }) },
      'prompts/modules/markdown.js': { pageSections: () => [{ key: '', title: 'Section', copy: 0, items: [] }], removeItem: noop },
      'prompts/modules/reminders.js': { loadReminders: noop },
      'prompts/modules/tasks.js': { loadTasks: noop },
      'prompts/modules/storage.js': Object.fromEntries(['addLine', 'editShown', 'loadActionConfig', 'loadKbConfig', 'resetSection', 'resetWholeField', 'saveActionConfig', 'saveKbConfig'].map(name => [name, async () => {}])),
    },
    globals: {
      document, window: dom.window, Option: dom.window.Option, browser, navigator: { platform: 'MacIntel' },
      requestAnimationFrame: noop, confirm: () => true, setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
      console: { log: noop, warn: noop },
    },
  });
  realm.require('prompts/prompts.js');
  document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await flush();
  const shown = () => [...document.querySelectorAll('#history-list .history-search-result-request')].map(el => el.textContent);
  return { document, shown };
}

const listings = helper => helper.calls.filter(m => m.cmd === 'memorySearch' && m.q === '');

describe('Chat History is listed from the settings page controls (#153)', () => {
  it('opening the History tab lists the newest entries', async () => {
    const helper = fakeHelper(entriesOf(2, 'harbour'));
    const page = await openSettingsPage(helper);
    expect(listings(helper)).toHaveLength(0);
    page.document.querySelector('.prompt-tab[data-prompt="history"]').click();
    await flush();
    expect(listings(helper)).toHaveLength(1);
    expect(page.shown()).toEqual(['harbour request 0', 'harbour request 1']);
    expect(page.document.querySelector('#history-list .history-section-header').textContent).toBe('Newest Conversations');
  });

  it('Refresh lists what memory holds now, an entry kept since included', async () => {
    const helper = fakeHelper(entriesOf(1, 'harbour'));
    const page = await openSettingsPage(helper);
    page.document.querySelector('.prompt-tab[data-prompt="history"]').click();
    await flush();
    expect(page.shown()).toEqual(['harbour request 0']);
    helper.stored.unshift(entriesOf(1, 'lantern', Date.now())[0]);
    page.document.getElementById('refresh-history').click();
    await flush();
    expect(listings(helper)).toHaveLength(2);
    expect(page.shown()).toEqual(['lantern request 0', 'harbour request 0']);
  });
});
