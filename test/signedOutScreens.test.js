/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// signedOutScreens.test.js — signed out, every screen shows and edits what is on this device (R34): the
// prompts page shows the knowledge base and the rules and saves an edit, the prompt history page loads the
// history, the templates page lists the templates, and the popup's Prompts and Templates entries open their
// pages. A sign-out takes nothing off a page that is open. Only the AI calls and Device Sync need an
// account. The real pages, on simulated devices.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, PROMPT_KEYS } from './support/bulletDevices.js';
import { createRealm } from './support/deviceRealm.js';
import { openPage, settleMany } from './support/promptsPage.js';

const ROOT = new URL('../', import.meta.url);
const noop = () => {};

async function signedInDevice() {
  const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay()).start();
  await a.add('kb', '', 'Private note');
  await a.add('composition', 'general', 'Private rule');
  a.store.values.prompt_history = [{ id: 'h1', timestamp: new Date().toISOString(), source: 'local_edit', fields: ['kb'], kb: '- Private note', composition: '', action: '', templatesJSON: '[]' }];
  return a;
}

/** Signs `a` out as supabaseAuth.signOut does: the stored session removed and Device Sync closed. The
 * prompt store is not reached (DS-DEVICE). */
async function signOut(a) {
  await a.store.api().local.remove('supabaseSession');
  await a.sync.cleanupDeviceSync();
  await settleMany(5);
}

/** `browser` for a page: the device's storage, `runtime` from `runtime`, and for anything else an API whose
 * every call resolves to nothing, recorded in `calls`. */
function pageBrowser(a, runtime, calls) {
  const any = (path) => new Proxy(function api() {}, {
    get: (_, name) => (name === 'then' ? undefined : any(`${path}.${String(name)}`)),
    apply: (_, __, args) => {
      calls.push([path, ...args]);
      return Promise.resolve(undefined);
    },
  });
  const known = { storage: a.store.api(), runtime: { getURL: (path) => `moz-extension://synthetic/${path}`, ...runtime } };
  return new Proxy(known, { get: (target, name) => target[name] ?? any(String(name)) });
}

/** One of the add-on's pages, its module loaded on device `a` with `stubs` for the imports it needs. */
async function loadPage(a, { html, files, stubs = {}, runtime = {} }) {
  const dom = new JSDOM(readFileSync(new URL(html, ROOT), 'utf8'));
  // JSDOM's own DOMContentLoaded goes by before the page's module is loaded; the test fires the page's.
  await settleMany(2);
  const calls = [];
  const messages = [];
  const sendMessage = async (message) => {
    messages.push(message);
    return { ok: true, connected: false, entries: [] };
  };
  const realm = createRealm({
    files,
    stubs: {
      'agent/modules/utils.js': { log: noop },
      'theme/palette/palette.js': { injectPaletteIntoDocument: async () => {} },
      ...stubs,
    },
    globals: {
      document: dom.window.document,
      window: dom.window,
      navigator: { platform: 'MacIntel' },
      getComputedStyle: dom.window.getComputedStyle,
      setTimeout: () => 1,
      clearTimeout: noop,
      setInterval: () => 1,
      clearInterval: noop,
      console: { log: noop, warn: noop, error: noop, debug: noop, info: noop },
      browser: pageBrowser(a, { sendMessage, ...runtime }, calls),
    },
  });
  for (const file of files) realm.require(file);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await settleMany();
  return { document: dom.window.document, dom, calls, messages };
}

describe('the prompts page while nobody is signed in', () => {
  it('shows the knowledge base and the rules, and saves an edit', async () => {
    const a = await signedInDevice();
    delete a.store.values.supabaseSession;
    const ui = await openPage(a);
    expect(ui.shown('kb')).toContainEqual(['', 'Private note']);
    expect(ui.shown('composition')).toContainEqual(['general', 'Private rule']);
    await ui.add('kb', '', 'Signed-out note');
    expect(ui.shown('kb')).toContainEqual(['', 'Signed-out note']);
    expect(await a.prompts.readText('kb')).toContain('Signed-out note');
    ui.dom.window.close();
  });

  it('an open page keeps every text when the user signs out', async () => {
    const a = await signedInDevice();
    const ui = await openPage(a);
    await signOut(a);
    expect(ui.shown('kb')).toContainEqual(['', 'Private note']);
    expect(ui.shown('composition')).toContainEqual(['general', 'Private rule']);
    expect(await a.prompts.readText('kb')).toContain('Private note');
    ui.dom.window.close();
  });
});

describe('the prompt history page while nobody is signed in', () => {
  it('loads the history', async () => {
    const a = await signedInDevice();
    delete a.store.values.supabaseSession;
    const page = await loadPage(a, { html: 'prompts/sync-history.html', files: ['prompts/sync-history.js'] });
    expect(page.messages.map((message) => message.command)).toContain('prompt-history-load');
  });

  it('shows the history the prompt store sends, and reads no text from storage itself (R32)', async () => {
    const a = await signedInDevice();
    const read = [];
    a.store.beforeGet = async (keys) => { read.push(...(Array.isArray(keys) ? keys : [keys])); };
    const entries = a.store.values.prompt_history;
    const page = await loadPage(a, {
      html: 'prompts/sync-history.html',
      files: ['prompts/sync-history.js'],
      runtime: { sendMessage: async () => ({ ok: true, entries }) },
    });
    expect(page.document.body.textContent).toContain('Private note');
    expect(read.filter((key) => typeof key === 'string' && (Object.values(PROMPT_KEYS).includes(key) || key === 'user_templates'))).toEqual([]);
  });
});

describe('the templates page while nobody is signed in', () => {
  it('lists the templates', async () => {
    const a = await signedInDevice();
    a.store.values.user_templates = [{ id: 't1', name: 'Private template', instructions: [], exampleReply: '', enabled: true, deleted: false }];
    delete a.store.values.supabaseSession;
    const page = await loadPage(a, {
      html: 'templates/templates.html',
      files: ['templates/templates.js'],
      stubs: { 'agent/modules/config.js': { getTemplateWorkerUrl: async () => 'https://templates.example.com' } },
      runtime: {
        sendMessage: async (message) => (message.command === 'templates-load'
          ? { ok: true, templates: structuredClone(a.store.values.user_templates) }
          : { ok: true, connected: false, entries: [] }),
      },
    });
    expect(page.document.documentElement.innerHTML).toContain('Private template');
  });
});

describe("the popup's Prompts and Templates entries", () => {
  const POPUP = {
    html: 'popup/popup.html',
    files: ['popup/popup.js'],
    stubs: {
      'agent/modules/config.js': { getBackendUrl: async () => 'https://backend.example.com', SETTINGS: {} },
      'agent/modules/setupChecks.js': { checkSetupConfiguration: async () => ({ ok: true, issues: [] }) },
      'agent/modules/billingBanner.js': { bannerFromWhoami: () => null, isZeroQuotaPlan: () => false },
      'agent/modules/byokStorage.js': { buildByokPayload: async () => null },
      'fts/helperPrompt.js': { FTS_HELPER_DOWNLOAD_URL: 'https://example.com/helper', getFtsHelperPrompt: async () => null },
    },
  };

  it('open their pages while nobody is signed in', async () => {
    const a = await signedInDevice();
    delete a.store.values.supabaseSession;
    const popup = await loadPage(a, POPUP);
    for (const id of ['open-prompts', 'open-templates']) {
      const entry = popup.document.getElementById(id);
      expect(entry.hasAttribute('aria-disabled')).toBe(false);
      entry.click();
    }
    await settleMany();
    expect(popup.calls.filter(([path]) => path === 'tabs.query')).toEqual([
      ['tabs.query', { url: 'moz-extension://synthetic/prompts/prompts.html' }],
      ['tabs.query', { url: 'moz-extension://synthetic/templates/templates.html' }],
    ]);
  });
});

vi.setConfig({ testTimeout: 20000 });
