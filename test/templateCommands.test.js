/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// templateCommands.test.js — the callers of the template writers (#193), on a simulated device running the
// real templateManager.js, promptStore.js and deviceSync.js: the templates page (templates/templates.js in
// a JSDOM document) through the background's runtime-message listener (setupRuntimeMessageListener from
// agent/background.js), and the chat window's template tools and flows.
//
// - A store that stays busy through every try is reported as busy, with its retry notice, by every caller
//   (DS-NO-BUSY-UI): the manager's writers, the background's replies, the page's status line, the chat
//   tool's result and the chat flows' failure text. Nothing is saved.
// - The page's duplicate clean-up removes duplicates from the stored list as it is when the background
//   runs it, never from the page's older copy: a template saved after the page loaded is kept.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';
import { createRealm } from './support/deviceRealm.js';
import { settleMany } from './support/promptsPage.js';

const ROOT = new URL('../', import.meta.url);
const MANAGER = 'agent/modules/templateManager.js';
const PAGE = 'templates/templates.js';
const DAY = 86400 * 1000;

const template = (id, name, extra = {}) => ({
  id, name, enabled: true, instructions: [], exampleReply: '', deleted: false, deletedAt: null,
  createdAt: new Date(Date.now() - 2 * DAY).toISOString(), updatedAt: new Date(Date.now() - 2 * DAY).toISOString(), ...extra,
});

const devices = [];
const doms = [];

afterEach(async () => {
  for (const dom of doms.splice(0)) dom.window.close();
  for (const d of devices.splice(0)) await d.sync.cleanupDeviceSync();
});

async function device(templates, options = {}) {
  const store = new DeviceStore({ user_templates: templates, templates_migrated: true, prompt_history_migrated: true });
  const d = await new BulletDevice('A', store, new BulletRelay(), { files: [MANAGER], ...options }).start();
  devices.push(d);
  return { d, store, manager: d.realm.require(MANAGER) };
}

/** background.js's runtime-message listener, as the background registers it, its template commands
 * running `manager`. Returns `request(message)` → the reply. */
function registrar(d, manager) {
  const source = readFileSync(new URL('agent/background.js', ROOT), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const node = ast.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'setupRuntimeMessageListener');
  let listener;
  const context = vm.createContext({
    log() {}, cleanupRuntimeListeners() {},
    browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    handlePromptStoreMessage: d.prompts.handlePromptStoreMessage,
    __import: async (path) => {
      if (path === './modules/templateManager.js') return manager;
      if (path === './modules/deviceSync.js') return d.sync;
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

/** The templates page open on the device, its commands answered by `request`; `onSent(command, reply)`
 * runs once each reply is back, before the page gets it. Returns the page's document and the
 * module-level functions a user's clicks run. */
async function templatesPage(store, request, onSent = async () => {}) {
  const dom = new JSDOM(readFileSync(new URL('templates/templates.html', ROOT), 'utf8'));
  doms.push(dom);
  const absorb = new Proxy(function () {}, { get: (_, name) => (name === 'then' ? undefined : absorb), apply: () => Promise.resolve(undefined) });
  const browser = new Proxy({
    storage: store.api(),
    runtime: {
      getURL: (path) => `moz-extension://synthetic/${path}`,
      sendMessage: async (message) => {
        const reply = await request(message);
        await onSent(message.command, reply);
        return reply;
      },
    },
  }, { get: (target, name) => target[name] ?? absorb });
  const realm = createRealm({
    files: [PAGE, MANAGER],
    stubs: {
      'agent/modules/utils.js': { log() {} },
      'theme/palette/palette.js': { injectPaletteIntoDocument: async () => {} },
      'agent/modules/config.js': { getTemplateWorkerUrl: async () => 'https://templates.example.com' },
    },
    expose: {
      [PAGE]: ['loadTemplates', 'addNewTemplate', 'saveCurrentTemplate', 'duplicateCurrentTemplate', 'deleteCurrentTemplate',
        'toggleTemplateEnabled', 'confirmImport', 'resetToDefaults', 'selectTemplate', 'onDragStart', 'onDrop'],
    },
    globals: {
      document: dom.window.document, window: dom.window, navigator: { platform: 'MacIntel' }, getComputedStyle: dom.window.getComputedStyle,
      confirm: () => true, requestAnimationFrame: (fn) => { fn(); return 1; }, browser, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
      console: { log() {}, warn() {}, error() {} },
    },
  });
  const page = realm.require(PAGE);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await settleMany(50);
  const document = dom.window.document;
  return { page, document, status: () => document.getElementById('status-message').textContent, list: () => document.getElementById('template-list').textContent };
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

describe('a template change refused because the prompt store stayed busy is reported as busy (DS-NO-BUSY-UI)', () => {
  const stored = () => [template('own', 'Own'), template('dup', 'Dup'), template('dup', 'Dup copy')];

  const WRITERS = [
    ['add', (m) => m.addTemplate({ name: 'Added' })],
    ['update', (m) => m.updateTemplate('own', { name: 'Renamed' })],
    ['delete', (m) => m.deleteTemplate('own')],
    ['reorder', (m) => m.reorderTemplates(['dup', 'own'])],
    ['import', (m) => m.importTemplates(JSON.stringify([{ id: 'imported', name: 'Imported' }]))],
    ['duplicate clean-up', (m) => m.dedupeTemplates()],
    ['reset to defaults', (m) => m.resetToDefaultTemplates()],
  ];

  it.each(WRITERS.flatMap(([name, run]) => ['background', 'chat window'].map((context) => [name, context, run])))('%s, from the %s: rejects with the busy notice, nothing saved', async (_, context, run) => {
    const { d, store, manager } = await device(stored(), { acquireWaitMs: 50 });
    const m = context === 'background' ? manager : d.page([MANAGER]).require(MANAGER);
    const before = structuredClone(store.values.user_templates);
    const release = await holdSemaphore(d);
    await expect(run(m)).rejects.toMatchObject({ busy: true, message: manager.TEMPLATES_BUSY_ERROR });
    await release();
    expect(store.values.user_templates).toEqual(before);
  });

  const COMMANDS = [
    { command: 'templates-add', template: { name: 'Added' } },
    { command: 'templates-update', id: 'own', updates: { name: 'Renamed' } },
    { command: 'templates-delete', id: 'own' },
    { command: 'templates-reorder', orderedIds: ['dup', 'own'] },
    { command: 'templates-import', json: JSON.stringify([{ id: 'imported', name: 'Imported' }]) },
    { command: 'templates-dedupe' },
    { command: 'templates-reset' },
  ];

  it.each(COMMANDS)('the background replies busy to $command', async (message) => {
    const { d, store, manager } = await device(stored(), { acquireWaitMs: 50 });
    const before = structuredClone(store.values.user_templates);
    const request = registrar(d, manager);
    const release = await holdSemaphore(d);
    const reply = await request(message);
    await release();
    expect(reply).toMatchObject({ ok: false, busy: true });
    expect(reply.error).toContain(manager.TEMPLATES_BUSY_ERROR);
    expect(store.values.user_templates).toEqual(before);
  });

  const PAGE_ACTIONS = [
    ['add', async (page) => page.addNewTemplate()],
    ['save', async (page, document) => { page.selectTemplate('own'); document.getElementById('template-name').value = 'Renamed'; await page.saveCurrentTemplate(); }],
    ['duplicate', async (page) => { page.selectTemplate('own'); await page.duplicateCurrentTemplate(); }],
    ['delete', async (page) => { page.selectTemplate('own'); await page.deleteCurrentTemplate(); }],
    ['enable or disable', async (page) => page.toggleTemplateEnabled('own', false)],
    ['reorder', async (page) => { page.onDragStart({ dataTransfer: { setData() {}, effectAllowed: '' }, target: { closest: () => ({ classList: { add() {} } }) } }, 'dup'); await page.onDrop({ preventDefault() {} }, 'own'); }],
    ['import', async (page, document) => { document.getElementById('import-textarea').value = JSON.stringify([{ id: 'imported', name: 'Imported' }]); await page.confirmImport(); }],
    ['reset to defaults', async (page) => page.resetToDefaults()],
    // Duplicates that arrived after the page opened (its own load cleaned up the first ones).
    ['duplicate clean-up on load', async (page) => page.loadTemplates(), (store) => { store.values.user_templates = stored(); }],
  ];

  it.each(PAGE_ACTIONS)('the templates page shows the busy notice for %s', async (_, act, prepare) => {
    const { d, store, manager } = await device(stored(), { acquireWaitMs: 50 });
    const request = registrar(d, manager);
    const { page, document, status } = await templatesPage(store, request);
    prepare?.(store);
    const before = structuredClone(store.values.user_templates);
    const release = await holdSemaphore(d);
    await act(page, document);
    await release();
    expect(status()).toBe(manager.TEMPLATES_BUSY_ERROR);
    expect(store.values.user_templates).toEqual(before);
  });

  /** A chat window's template flow at its exec step, with the session's args. Returns what it showed
   * and the reason it failed with. */
  async function chatFlow(d, file, exec, args) {
    const shown = [];
    const ctx = { activePid: 1, fsmSessions: { 1: { ...args } }, state: null };
    const realm = d.page([MANAGER, file], {
      'chat/chat.js': { createNewAgentBubble: async () => ({ classList: { remove() {} } }) },
      'chat/modules/context.js': { ctx },
      'chat/modules/converse.js': { awaitUserInput() {} },
      'chat/modules/helpers.js': { streamText: (_, text) => shown.push(text) },
      'chatlink/modules/fsm.js': { relayFsmConfirmation: async () => {} },
      'chat/fsm/core.js': { executeAgentAction: async () => {} },
      'agent/modules/config.js': { ...d.stubs()['agent/modules/config.js'], getTemplateWorkerUrl: async () => 'https://templates.example.com' },
    });
    await realm.require(file)[exec]();
    return { shown, failReason: ctx.fsmSessions[1].failReason, state: ctx.state };
  }

  const FLOWS = [
    ['template_create', 'chat/fsm/templateCreate.js', 'runStateCreateTemplateExec', { createTemplateArgs: { name: 'Created', instructions: [], exampleReply: '' } }],
    ['template_edit', 'chat/fsm/templateEdit.js', 'runStateEditTemplateExec', { editTemplateArgs: { templateId: 'own', updates: { name: 'Renamed' } } }],
    ['template_delete', 'chat/fsm/templateDelete.js', 'runStateDeleteTemplateExec', { deleteTemplateArgs: { templateId: 'own', template: { name: 'Own' } } }],
    ['template download', 'chat/fsm/templateDownload.js', 'runStateDownloadTemplateExec', { downloadTemplateData: { id: 'market', name: 'Market' } }],
  ];

  it.each(FLOWS)('the chat flow %s fails with the busy notice', async (_, file, exec, args) => {
    const { d, store, manager } = await device(stored(), { acquireWaitMs: 50 });
    const before = structuredClone(store.values.user_templates);
    const release = await holdSemaphore(d);
    const { shown, failReason, state } = await chatFlow(d, file, exec, args);
    await release();
    expect(state).toBe('exec_fail');
    expect(failReason).toContain(manager.TEMPLATES_BUSY_ERROR);
    expect(shown.join('\n')).toContain(manager.TEMPLATES_BUSY_ERROR);
    expect(store.values.user_templates).toEqual(before);
  });

  it('the chat tool template_toggle tells the model the templates are busy', async () => {
    const { d, store, manager } = await device(stored(), { acquireWaitMs: 50 });
    const toggle = d.page([MANAGER, 'chat/tools/template_toggle.js']).require('chat/tools/template_toggle.js');
    const release = await holdSemaphore(d);
    const result = await toggle.run({ template_id: 'own', enabled: false });
    await release();
    expect(result.error).toContain(manager.TEMPLATES_BUSY_ERROR);
    expect(store.values.user_templates.find((t) => t.id === 'own').enabled).toBe(true);
  });

  it('control: each caller saves once the store is free', async () => {
    const { d, store, manager } = await device(stored(), { acquireWaitMs: 50 });
    const request = registrar(d, manager);
    expect(await request({ command: 'templates-update', id: 'own', updates: { name: 'Renamed' } })).toMatchObject({ ok: true });
    expect(await request({ command: 'templates-reorder', orderedIds: ['dup', 'own'] })).toEqual({ ok: true });
    expect(store.values.user_templates.map((t) => t.id)).toEqual(['dup', 'own']);
    const toggle = d.page([MANAGER, 'chat/tools/template_toggle.js']).require('chat/tools/template_toggle.js');
    expect(await toggle.run({ template_id: 'own', enabled: false })).toMatchObject({ ok: true });
    const flow = await chatFlow(d, FLOWS[0][1], FLOWS[0][2], FLOWS[0][3]);
    expect(flow.state).toBe('exec_success');
    const { page, status } = await templatesPage(store, request);
    page.onDragStart({ dataTransfer: { setData() {}, effectAllowed: '' }, target: { closest: () => ({ classList: { add() {} } }) } }, 'own');
    await page.onDrop({ preventDefault() {} }, store.values.user_templates[0].id);
    expect(status()).toBe('Template order saved');
    await page.addNewTemplate();
    expect(status()).toBe('Template created');
    const own = store.values.user_templates.find((t) => t.id === 'own');
    expect(own).toMatchObject({ name: 'Renamed', enabled: false });
    expect(store.values.user_templates.filter((t) => t.name === 'Created' || t.name === 'New Template')).toHaveLength(2);
  });
});

describe('the templates page removes duplicates from the stored list, never from its older copy (#193)', () => {
  const duplicated = () => [template('dup', 'Old first'), template('dup', 'Old second'), template('gone', 'Tombstone', { deleted: true, deletedAt: new Date().toISOString() })];

  it('a template saved after the page loaded is kept, the duplicate removed, the tombstone kept, and the page shows the stored list', async () => {
    const { d, store, manager } = await device(duplicated());
    const request = registrar(d, manager);
    let raced = false;
    const { list } = await templatesPage(store, request, async (command) => {
      if (command !== 'templates-load' || raced) return;
      raced = true;
      // After the page got its list, before it asks for the clean-up: newer saves from another context.
      expect(await manager.updateTemplate('dup', { name: 'Newer stored edit' })).toMatchObject({ name: 'Newer stored edit' });
      expect(await manager.addTemplate({ id: 'new', name: 'Newer added template' })).toMatchObject({ id: 'new' });
    });
    expect(raced).toBe(true);
    const saved = store.values.user_templates;
    expect(saved.filter((t) => t.id === 'dup')).toHaveLength(1);
    expect(saved.find((t) => t.id === 'dup').name).toBe('Newer stored edit');
    expect(saved.find((t) => t.id === 'new').name).toBe('Newer added template');
    expect(saved.find((t) => t.id === 'gone').deleted).toBe(true);
    expect(list()).toContain('Newer stored edit');
    expect(list()).toContain('Newer added template');
    expect(list()).not.toContain('Old second');
  });

  it('control: with nothing saved meanwhile, the first of each duplicated id is kept', async () => {
    const { d, store, manager } = await device(duplicated());
    const { list } = await templatesPage(store, registrar(d, manager));
    expect(store.values.user_templates.map((t) => [t.id, t.name])).toEqual([['dup', 'Old first'], ['gone', 'Tombstone']]);
    expect(list()).toContain('Old first');
    expect(list()).not.toContain('Old second');
  });
});
