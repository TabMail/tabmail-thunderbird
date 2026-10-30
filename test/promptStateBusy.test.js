/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptStateBusy.test.js — a change of the disabled-reminders map or the action compaction settings that
// the prompt store refused because it stayed busy through every try is reported as busy, with its retry
// notice, by every caller (DS-NO-BUSY-UI), and nothing is saved: the store's writers from the background
// and the chat window, the background's reminder replies (setupRuntimeMessageListener from
// agent/background.js), the prompts page's reminder and task toggles and its compaction sliders, and the
// chat tool reminder_del. On a simulated device running the real promptStore.js, deviceSync.js,
// reminderStateStore.js and the callers. The templates have their own in templateCommands.test.js.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';
import { openPage } from './support/promptsPage.js';

const ROOT = new URL('../', import.meta.url);
const REMINDERS = 'agent/modules/reminderStateStore.js';
const STORAGE = 'prompts/modules/storage.js';
const ACTION_CONFIG = 'agent/modules/actionCompactConfig.js';
/** The prompts page's two compaction sliders: [id, the setting it saves, its stored value]. */
const SLIDERS = [['action-compact-threshold', 'compact_threshold', 150], ['action-compact-threshold-chars', 'compact_threshold_chars', 20000]];
const MAP_KEY = 'disabled_reminders_v2';
const ACTION_KEY = 'user_prompts:action_config';
const DAY = 86400 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const devices = [];
const pages = [];

afterEach(async () => {
  for (const page of pages.splice(0)) page.dom.window.close();
  for (const d of devices.splice(0)) await d.sync.cleanupDeviceSync();
});

async function device() {
  const store = new DeviceStore({
    [MAP_KEY]: { 'm:own': { enabled: false, ts: ago(2 * DAY) }, 'm:stale': { enabled: false, ts: ago(100 * DAY) } },
    'device_sync_ts:disabledReminders': ago(2 * DAY),
    [ACTION_KEY]: { compact_threshold: 150, compact_threshold_chars: 20000 },
    'device_sync_ts:actionConfig': ago(2 * DAY),
    prompt_history_migrated: true,
  });
  const d = await new BulletDevice('A', store, new BulletRelay(), { files: [REMINDERS, ACTION_CONFIG], acquireWaitMs: 50 }).start();
  // The prompts page reads the stored settings through the real module.
  const stubs = d.stubs.bind(d);
  d.stubs = () => ({ ...stubs(), [ACTION_CONFIG]: d.realm.require(ACTION_CONFIG) });
  devices.push(d);
  return { d, store, reminders: d.realm.require(REMINDERS) };
}

/** Holds the device's prompt semaphore as another writer would, until `release()`. */
async function holdSemaphore(d) {
  let release;
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const done = d.prompts.withPromptStore(() => { entered(); return new Promise((resolve) => { release = resolve; }); }, { label: 'another writer' });
  await inside;
  return async () => { release(); await done; };
}

/** background.js's runtime-message listener, as the background registers it, its reminder commands
 * running `reminders`. Returns `request(message)` → the reply. */
function registrar(reminders) {
  const source = readFileSync(new URL('agent/background.js', ROOT), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const node = ast.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'setupRuntimeMessageListener');
  let listener;
  const context = vm.createContext({
    log() {}, cleanupRuntimeListeners() {},
    browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    __import: async (path) => {
      if (path === './modules/reminderStateStore.js') return reminders;
      throw new Error(`unexpected import ${path}`);
    },
  });
  vm.runInContext(source.slice(node.start, node.end).replaceAll('import(', '__import('), context);
  vm.runInContext('setupRuntimeMessageListener()', context);
  return (message) => new Promise((resolve, reject) => {
    try {
      const returned = listener(structuredClone(message), {}, (reply) => resolve(structuredClone(reply)));
      if (returned !== true) Promise.resolve(returned).then(resolve, reject);
    } catch (error) { reject(error); }
  });
}

/** A prompts page tab (reminders.js or tasks.js) on the device, its reminder commands answered by the
 * background's listener. Returns the tab's module, with its toggle exposed, and the statuses it showed. */
function promptsTab(d, file, toggle) {
  const statuses = [];
  const request = registrar(d.realm.require(REMINDERS));
  const realm = d.page([REMINDERS, file], {
    'prompts/modules/utils.js': { showStatus: (message, isError) => statuses.push([message, isError === true]) },
  }, {
    // The tab's list, which it reloads after a failed toggle.
    document: { querySelector: () => null, getElementById: () => ({ innerHTML: '' }) },
    browser: {
      storage: d.store.api(),
      runtime: { sendMessage: async (message) => (message.command.endsWith('-reminder') ? request(message) : { ok: false, error: 'not loaded here' }) },
    },
  }, { [file]: [toggle] });
  return { tab: realm.require(file), statuses };
}

/** A reminder card in the chat, as markdown.js renders it, with its dismiss handler
 * (attachSpecialLinkListeners) sending to the background's reminder replies (`reply`). */
async function chatCard(d, reply) {
  const source = readFileSync(new URL('chat/modules/markdown.js', ROOT), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const node = ast.body.map((n) => n.declaration ?? n).find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'attachSpecialLinkListeners');
  const dom = new JSDOM('<main><div class="tm-reminder-card" data-reminder-index="0"><span class="tm-reminder-card-text">Reply about the synthetic invoice</span><span class="tm-reminder-dismiss">don\'t show again</span></div></main>');
  const context = vm.createContext({
    document: dom.window.document, window: dom.window, log() {},
    browser: { runtime: { sendMessage: reply } },
    __import: async (path) => {
      if (path.endsWith('/reminderBuilder.js')) return { getDisplayedReminderHashes: () => ['m:card'] };
      if (path.endsWith('/reminderStateStore.js')) return d.page([REMINDERS]).require(REMINDERS);
      throw new Error(`unexpected import ${path}`);
    },
  });
  vm.runInContext(source.slice(node.start, node.end).replaceAll('import(', '__import('), context);
  context.container = dom.window.document.querySelector('main');
  vm.runInContext('attachSpecialLinkListeners(container)', context);
  const card = dom.window.document.querySelector('.tm-reminder-card');
  await vi.waitFor(() => expect(card.getAttribute('data-hash')).toBe('m:card'));
  return { dom, card, button: card.querySelector('.tm-reminder-dismiss') };
}

describe('a reminder or settings change refused because the prompt store stayed busy is reported as busy (DS-NO-BUSY-UI)', () => {
  const WRITERS = [
    ['disable a reminder', (m) => m.setEnabled('m:new', false)],
    ['enable a reminder', (m) => m.setEnabled('m:own', true)],
    ['clean-up of stale entries', (m) => m.gcStaleEntries(new Set(['m:own']))],
    ['hash migration', (m) => m.migrateEntries({ 'm:migrated': { enabled: false, ts: new Date().toISOString() } })],
  ];

  it.each(WRITERS.flatMap(([name, run]) => ['background', 'chat window'].map((context) => [name, context, run])))('%s, from the %s: rejects with the busy notice, nothing saved', async (_, context, run) => {
    const { d, store, reminders } = await device();
    const m = context === 'background' ? reminders : d.page([REMINDERS]).require(REMINDERS);
    const before = structuredClone(store.values[MAP_KEY]);
    const release = await holdSemaphore(d);
    await expect(run(m)).rejects.toMatchObject({ busy: true, message: reminders.REMINDERS_BUSY_ERROR });
    await release();
    expect(store.values[MAP_KEY]).toEqual(before);
  });

  it.each(['disable-reminder', 'enable-reminder'])('the background replies busy to %s', async (command) => {
    const { d, store, reminders } = await device();
    const before = structuredClone(store.values[MAP_KEY]);
    const request = registrar(reminders);
    const release = await holdSemaphore(d);
    const reply = await request({ command, hash: 'm:own' });
    await release();
    expect(reply).toMatchObject({ ok: false, busy: true });
    expect(reply.error).toContain(reminders.REMINDERS_BUSY_ERROR);
    expect(store.values[MAP_KEY]).toEqual(before);
  });

  it.each([
    ['reminders', 'prompts/modules/reminders.js', 'handleReminderToggle'],
    ['tasks', 'prompts/modules/tasks.js', 'handleTaskToggle'],
  ])('the prompts page\'s %s tab shows the busy notice for a toggle', async (_, file, toggle) => {
    const { d, store, reminders } = await device();
    const before = structuredClone(store.values[MAP_KEY]);
    const { tab, statuses } = promptsTab(d, file, toggle);
    const release = await holdSemaphore(d);
    await tab[toggle]('m:own', true);
    await release();
    expect(statuses[0]).toEqual([reminders.REMINDERS_BUSY_ERROR, true]);
    expect(store.values[MAP_KEY]).toEqual(before);
  });

  it('the prompts page saving the compaction sliders rejects with the busy notice, nothing saved', async () => {
    const { d, store } = await device();
    const before = structuredClone(store.values[ACTION_KEY]);
    const elements = { 'action-compact-threshold': { value: '250' }, 'action-compact-threshold-chars': { value: '30000' } };
    const storage = d.page(['agent/modules/actionCompactConfig.js', STORAGE, 'prompts/modules/markdown.js'], {}, { document: { getElementById: (id) => elements[id] ?? null } }).require(STORAGE);
    const release = await holdSemaphore(d);
    await expect(storage.saveActionConfig()).rejects.toMatchObject({ busy: true, message: storage.ACTION_SETTINGS_BUSY_ERROR });
    await release();
    expect(store.values[ACTION_KEY]).toEqual(before);
  });

  it.each(SLIDERS)('the prompts page shows the busy notice once when the %s slider is not saved, and shows the stored value again', async (id, _, stored) => {
    const { d, store } = await device();
    const before = structuredClone(store.values[ACTION_KEY]);
    const ui = await openPage(d);
    pages.push(ui);
    const slider = ui.document.getElementById(id);
    expect(Number(slider.value)).toBe(stored);
    const release = await holdSemaphore(d);
    const count = ui.statuses.length;
    slider.value = String(stored * 2);
    slider.dispatchEvent(new ui.dom.window.Event('change'));
    // The store answers busy after its wait; then the page has had time to report anything else.
    await vi.waitFor(() => expect(ui.statuses.length).toBeGreaterThan(count), { timeout: 1000 });
    await ui.settled(ui.statuses.length);
    const { ACTION_SETTINGS_BUSY_ERROR } = d.page([ACTION_CONFIG, STORAGE, 'prompts/modules/markdown.js']).require(STORAGE);
    expect(ui.statuses.slice(count)).toEqual([[ACTION_SETTINGS_BUSY_ERROR, true]]);
    await vi.waitFor(() => expect(Number(slider.value)).toBe(stored), { timeout: 1000 });
    await release();
    expect(store.values[ACTION_KEY]).toEqual(before);
  });

  it.each(SLIDERS)('control: the %s slider saves its value once the store is free', async (id, setting, stored) => {
    const { d, store } = await device();
    const ui = await openPage(d);
    pages.push(ui);
    const slider = ui.document.getElementById(id);
    const before = structuredClone(store.values[ACTION_KEY]);
    slider.value = String(stored * 2);
    slider.dispatchEvent(new ui.dom.window.Event('change'));
    await vi.waitFor(() => expect(store.values[ACTION_KEY][setting]).toBe(stored * 2), { timeout: 1000 });
    expect(store.values[ACTION_KEY]).toEqual({ ...before, [setting]: stored * 2 });
    expect(store.values['device_sync_ts:actionConfig'] > before.ts || Date.parse(store.values['device_sync_ts:actionConfig']) > Date.now() - DAY).toBe(true);
  });

  it('the chat tool reminder_del tells the model the reminders are busy', async () => {
    const { d, store, reminders } = await device();
    const before = structuredClone(store.values[MAP_KEY]);
    const tool = d.page([REMINDERS, 'chat/tools/reminder_del.js'], { 'agent/modules/patchApplier.js': { applyKBPatch() {} } }, {}, { 'chat/tools/reminder_del.js': ['snoozeEmailReminder'] }).require('chat/tools/reminder_del.js');
    const release = await holdSemaphore(d);
    const result = await tool.snoozeEmailReminder({ hash: 'm:new', content: 'Reply about the synthetic invoice' });
    await release();
    expect(result.error).toBe(reminders.REMINDERS_BUSY_ERROR);
    expect(store.values[MAP_KEY]).toEqual(before);
  });

  it('the chat window\'s reminder card shows the busy notice once, keeps its button, and saves on the next click once the store is free', async () => {
    const { d, store, reminders } = await device();
    const before = structuredClone(store.values[MAP_KEY]);
    const reply = registrar(reminders);
    const replies = [];
    const ui = await chatCard(d, async (message) => { const r = await reply(message); replies.push(r); return r; });
    try {
      const release = await holdSemaphore(d);
      ui.button.dispatchEvent(new ui.dom.window.Event('click'));
      await vi.waitFor(() => expect(ui.button.textContent).toBe(reminders.REMINDERS_BUSY_ERROR), { timeout: 1000 });
      expect(replies).toEqual([expect.objectContaining({ ok: false, busy: true })]);
      expect(ui.card.textContent.split(reminders.REMINDERS_BUSY_ERROR)).toHaveLength(2);
      expect(store.values[MAP_KEY]).toEqual(before);
      await release();
      ui.button.dispatchEvent(new ui.dom.window.Event('click'));
      await vi.waitFor(() => expect(ui.button.textContent).toBe('hidden'), { timeout: 1000 });
      expect(store.values[MAP_KEY]['m:card']).toMatchObject({ enabled: false });
    } finally {
      ui.dom.window.close();
    }
  });

  it('control: the chat window\'s reminder card hides the reminder when the store is free', async () => {
    const { d, store, reminders } = await device();
    const ui = await chatCard(d, registrar(reminders));
    try {
      ui.button.dispatchEvent(new ui.dom.window.Event('click'));
      await vi.waitFor(() => expect(ui.button.textContent).toBe('hidden'), { timeout: 1000 });
      expect(store.values[MAP_KEY]['m:card']).toMatchObject({ enabled: false });
    } finally {
      ui.dom.window.close();
    }
  });

  it('control: each caller saves once the store is free', async () => {
    const { d, store, reminders } = await device();
    expect(await registrar(reminders)({ command: 'disable-reminder', hash: 'm:background' })).toMatchObject({ ok: true });
    const tool = d.page([REMINDERS, 'chat/tools/reminder_del.js'], { 'agent/modules/patchApplier.js': { applyKBPatch() {} } }, {}, { 'chat/tools/reminder_del.js': ['snoozeEmailReminder'] }).require('chat/tools/reminder_del.js');
    expect(await tool.snoozeEmailReminder({ hash: 'm:chat', content: 'Reply about the synthetic invoice' })).toMatchObject({ ok: true });
    const { tab, statuses } = promptsTab(d, 'prompts/modules/tasks.js', 'handleTaskToggle');
    await tab.handleTaskToggle('m:own', true);
    expect(statuses[0]).toEqual(['Task enabled', false]);
    const ui = await openPage(d);
    pages.push(ui);
    const slider = ui.document.getElementById('action-compact-threshold');
    const count = ui.statuses.length;
    slider.value = '250';
    slider.dispatchEvent(new ui.dom.window.Event('change'));
    await ui.settled(count);
    expect(store.values[MAP_KEY]).toMatchObject({ 'm:background': { enabled: false }, 'm:chat': { enabled: false }, 'm:own': { enabled: true } });
    expect(store.values[ACTION_KEY]).toMatchObject({ compact_threshold: 250 });
  });
});
