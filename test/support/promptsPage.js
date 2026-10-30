/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The prompts page as it runs, for tests: the shipped prompts.html and the real page module on a device
// of bulletDevices.js, reaching the device's prompt store through runtime messages as every page does.

import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { SECTION_HEADERS } from '../../agent/modules/bullets.js';
import { bundledFetch, defaultCatalog } from './bulletDevices.js';
import { createRealm } from './deviceRealm.js';

const ROOT = new URL('../../', import.meta.url);
const noop = () => {};
export const settle = () => new Promise((resolve) => setImmediate(resolve));
export const settleMany = async (n = 40) => {
  for (let i = 0; i < n; i++) await settle();
};

/**
 * The page on device `a`, `DOMContentLoaded` fired. `commands` answers the runtime messages that are not
 * the prompt store's (Compact Now, Compress, Sync Now), each recorded in `ui.commands`; `beforeStore`
 * runs before each prompt-store message reaches the background, with the message; `afterStore` runs
 * after the background answered it, with the message, before the page gets the answer.
 */
export async function openPage(a, { commands = {}, beforeStore = async () => {}, afterStore = async () => {} } = {}) {
  const dom = new JSDOM(readFileSync(new URL('prompts/prompts.html', ROOT), 'utf8'));
  await settle();
  const document = dom.window.document;
  const statuses = [];
  const sent = [];
  const storage = a.store.api();
  const realm = createRealm({
    files: ['agent/modules/bullets.js', 'agent/modules/bulletSync.js', 'agent/modules/retryWithBackoff.js', 'agent/modules/promptStore.js', 'prompts/modules/storage.js', 'prompts/modules/markdown.js', 'prompts/prompts.js'],
    expose: { 'prompts/prompts.js': ['shown'] },
    stubs: {
      ...a.stubs(),
      'prompts/modules/utils.js': { autoGrowTextarea: noop, flashBorder: noop, flashButton: noop, showStatus: (...args) => statuses.push(args) },
      'prompts/modules/developer.js': { clearTestOutput: noop, runKbRefineTest: noop },
      'prompts/modules/history.js': { initHistoryHandlers: noop, loadChatHistory: noop, showClearAllConfirmation: noop },
      'prompts/modules/reminders.js': { loadReminders: noop },
      'prompts/modules/tasks.js': { loadTasks: noop },
      'theme/palette/palette.js': { injectPaletteIntoDocument: async () => {} },
    },
    globals: {
      document,
      window: dom.window,
      navigator: { platform: 'MacIntel' },
      confirm: () => true,
      requestAnimationFrame: noop,
      // The page's own UI timers (a button's label put back after a second and more) never run; the
      // prompt semaphore's short backoff sleeps do, so an edit waiting for another one goes ahead.
      setTimeout: (run, ms) => (ms < 1000 ? globalThis.setTimeout(run, ms) : 1),
      clearTimeout: noop,
      setInterval: () => 1,
      clearInterval: noop,
      TextEncoder,
      crypto: globalThis.crypto,
      fetch: bundledFetch(defaultCatalog),
      console: { log: noop, warn: noop },
      browser: {
        storage,
        runtime: {
          getURL: (path) => `moz-extension://synthetic/${path}`,
          sendMessage: async (message) => {
            if (message.command === 'prompt-store') {
              await beforeStore(message);
              const answer = structuredClone(await a.prompts.handlePromptStoreMessage(structuredClone(message)));
              await afterStore(message);
              return answer;
            }
            sent.push(message.command);
            return commands[message.command] ? commands[message.command](message) : { ok: true, connected: true };
          },
        },
      },
    },
  });
  const page = realm.require('prompts/prompts.js');
  document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await settleMany();
  const loading = () => ['composition', 'action', 'kb'].some((field) => page.shown[field] === null);
  for (let n = 0; n < 2000 && loading(); n++) await settle();
  for (const field of ['composition', 'action', 'kb']) expect(page.shown[field], `${field} is loaded`).not.toBeNull();

  function section(field, key, copy = 0) {
    const name = SECTION_HEADERS[field].find(([k]) => k === key)[1];
    return [...document.querySelectorAll(`#${field}-sections .section-container`)].filter((el) => el.querySelector('h3').firstChild.textContent === name)[copy];
  }
  const ui = {
    dom,
    document,
    page,
    statuses,
    commands: sent,
    lastStatus: () => statuses.at(-1),
    tab: async (name) => {
      document.querySelector(`.prompt-tab[data-prompt="${name}"]`).click();
      await settle();
    },
    click: async (selector) => {
      document.querySelector(selector).click();
      await settleMany();
    },
    section,
    /** The editor of `field`'s section `key` ('' for the knowledge base), the `copy`-th shown. */
    editor: (field, key, copy = 0) => (field === 'kb' ? document.querySelector('#kb-content-container .bullet-list-editor') : section(field, key, copy).querySelector('.bullet-list-editor')),
    items: (field, key, copy = 0) => [...ui.editor(field, key, copy).querySelectorAll('.bullet-text')].map((el) => el.textContent),
    /** Clicks the remove button of the item `text` (not waiting for the save). */
    removeNow: (field, key, text, copy = 0) => {
      const item = [...ui.editor(field, key, copy).querySelectorAll('.bullet-item')].find((el) => el.querySelector('.bullet-text').textContent === text);
      expect(item, `"${text}" is shown`).toBeDefined();
      item.querySelector('.bullet-delete-btn').click();
    },
    remove: async (field, key, text, copy = 0) => {
      ui.removeNow(field, key, text, copy);
      await settleMany();
    },
    type: (field, key, text, copy = 0) => {
      const input = ui.editor(field, key, copy).querySelector('.bullet-add-input');
      input.value = text;
      input.dispatchEvent(new dom.window.Event('input'));
      return input;
    },
    /** Types `text` into the add box and presses Enter. */
    enter: async (field, key, text, copy = 0) => {
      ui.type(field, key, text, copy).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settleMany();
    },
    /** Types `text` into the add box and presses its Add button. */
    add: async (field, key, text, copy = 0) => {
      ui.type(field, key, text, copy);
      ui.editor(field, key, copy).querySelector('.bullet-add-btn').click();
      await settleMany();
    },
    box: (field, key, copy = 0) => ({
      value: ui.editor(field, key, copy).querySelector('.bullet-add-input').value,
      error: ui.editor(field, key, copy).querySelector('.bullet-add-error').textContent,
    }),
    resetSection: async (field, key, copy = 0) => {
      section(field, key, copy).querySelector('.reset-section-btn').click();
      await settleMany();
    },
    /** What the page shows for `field`: [section key, item text] pairs, every copy of a section. */
    shown: (field) => {
      if (field === 'kb') return [...document.querySelectorAll('#kb-content-container .bullet-text')].map((el) => ['', el.textContent]);
      const names = new Map(SECTION_HEADERS[field].map(([key, name]) => [name, key]));
      return [...document.querySelectorAll(`#${field}-sections .section-container`)].flatMap((el) => {
        const key = names.get(el.querySelector('h3').firstChild.textContent);
        return [...el.querySelectorAll('.bullet-text')].map((item) => [key, item.textContent]);
      });
    },
    raw: (field) => document.getElementById(`raw-${field}-content`).value,
    /** Where the page shows `text` of `field`: { key, copy }, the first place it is shown. */
    locate: (field, text) => {
      const names = new Map(SECTION_HEADERS[field].map(([key, name]) => [name, key]));
      const copies = new Map();
      for (const el of document.querySelectorAll(`#${field}-sections .section-container`)) {
        const key = names.get(el.querySelector('h3').firstChild.textContent);
        const copy = copies.get(key) ?? 0;
        copies.set(key, copy + 1);
        if ([...el.querySelectorAll('.bullet-text')].some((item) => item.textContent === text)) return { key, copy };
      }
      return undefined;
    },
  };
  return ui;
}
