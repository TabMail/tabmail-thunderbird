/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// deviceSyncToggle.test.js — the Device Sync toggle on the prompts, prompt history and templates pages
// (TB-219). The background alone stores the setting and opens or closes the socket, so a page closed right
// after the click still leaves the setting and the socket in step; a change the background could not make
// shows what is stored and whether the socket is open. The real pages, on a simulated device whose
// background runs the real deviceSync.js.

import { describe, expect, it, vi } from 'vitest';
import { loadPage } from './support/addonPage.js';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';
import { openPage, settleMany } from './support/promptsPage.js';

const SYNC_AUTO_KEY = 'device_sync_auto_enabled';

/** Device A with Device Sync on or off, its socket open when on. */
async function device(on) {
  const a = await new BulletDevice('A', new DeviceStore({ [SYNC_AUTO_KEY]: on }), new BulletRelay()).start();
  if (on) await a.connect();
  expect(a.relay.isConnected(a.id)).toBe(on);
  return a;
}

/** The background's answers to a page's Device Sync requests, as background.js gives them: enable and
 * disable through setAutoEnabled, the socket's state from the transport, and on the first listener request
 * the connection state mirrored into storage for the pages. */
function background(a) {
  let mirrored = false;
  const open = async () => a.relay.isConnected(a.id);
  const setTo = (enabled) => async () => {
    try {
      await a.sync.setAutoEnabled(enabled);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  };
  return {
    'device-sync-enable': setTo(true),
    'device-sync-disable': setTo(false),
    'device-sync-status': async () => ({ ok: true, connected: await open() }),
    'device-sync-add-listener': async () => {
      if (!mirrored) {
        mirrored = true;
        a.sync.addStatusListener((connected) => { a.store.api().local.set({ _deviceSyncConnected: connected }).catch(() => {}); });
      }
      return { ok: true, connected: await open() };
    },
  };
}

/** Wraps a page's `browser` so that, once `page.closed` is set, no answer reaches the page: a call it made
 * still takes effect, as Thunderbird keeps a closed page's requests and drops their answers. */
function closable(page) {
  const held = (call) => Promise.resolve(call).then(
    (value) => (page.closed ? new Promise(() => {}) : value),
    (error) => (page.closed ? new Promise(() => {}) : Promise.reject(error)),
  );
  const wrap = (api, names) => ({ ...api, ...Object.fromEntries(names.map((name) => [name, (...args) => held(api[name](...args))])) });
  return (browser) => {
    const storage = { ...browser.storage, local: wrap(browser.storage.local, ['get', 'set', 'remove']) };
    const runtime = wrap(browser.runtime, ['sendMessage']);
    return new Proxy(browser, { get: (target, name) => (name === 'storage' ? storage : name === 'runtime' ? runtime : target[name]) });
  };
}

/** Answers a page's runtime messages from `answers`; the page's own loads get an empty list. */
const answering = (answers) => async (message) => (answers[message.command] ? answers[message.command](message) : { ok: true, entries: [], templates: [] });

const PAGES = [
  ['the prompts page', (a, answers, wrapBrowser) => openPage(a, { commands: answers, wrapBrowser })],
  ['the prompt history page', (a, answers, wrapBrowser) => loadPage(a, {
    html: 'prompts/sync-history.html',
    files: ['prompts/sync-history.js'],
    runtime: { sendMessage: answering(answers) },
    wrapBrowser,
  })],
  ['the templates page', (a, answers, wrapBrowser) => loadPage(a, {
    html: 'templates/templates.html',
    files: ['templates/templates.js', 'agent/modules/templateManager.js', 'agent/modules/statusLine.js'],
    stubs: { 'agent/modules/config.js': { getTemplateWorkerUrl: async () => 'https://templates.example.com' } },
    runtime: { sendMessage: answering(answers) },
    wrapBrowser,
  })],
];

describe.each(PAGES)('the Device Sync toggle on %s', (_name, open) => {
  const label = (ui) => ui.document.getElementById('sync-toggle-label').textContent;

  it('turned off and the page closed at once: the setting is off and the socket closed', async () => {
    const a = await device(true);
    const page = { closed: false };
    const ui = await open(a, background(a), closable(page));
    expect(label(ui)).toBe('Syncing');

    ui.document.getElementById('sync-toggle').click();
    page.closed = true;
    await settleMany();

    expect(a.store.values[SYNC_AUTO_KEY]).toBe(false);
    expect(a.relay.isConnected(a.id)).toBe(false);
    ui.dom.window.close();
  });

  it('turned on and the page closed at once: the setting is on and the socket open', async () => {
    const a = await device(false);
    const page = { closed: false };
    const ui = await open(a, background(a), closable(page));
    expect(label(ui)).toBe('Sync Off');

    ui.document.getElementById('sync-toggle').click();
    page.closed = true;
    await vi.waitFor(() => expect(a.relay.isConnected(a.id)).toBe(true));

    expect(a.store.values[SYNC_AUTO_KEY]).toBe(true);
    ui.dom.window.close();
  });

  it('turned on with the page open: the page shows the socket open', async () => {
    const a = await device(false);
    const ui = await open(a, background(a), (browser) => browser);

    ui.document.getElementById('sync-toggle').click();
    await vi.waitFor(() => expect(label(ui)).toBe('Syncing'));

    expect(a.store.values[SYNC_AUTO_KEY]).toBe(true);
    expect(a.relay.isConnected(a.id)).toBe(true);
    ui.dom.window.close();
  });

  it.each([
    ['refused', async () => ({ ok: false, error: 'synthetic refusal' })],
    ['not answered', async () => { throw new Error('synthetic: no background'); }],
  ])('a turn-off the background %s shows what is stored and that the socket is open', async (_how, answer) => {
    const a = await device(true);
    const ui = await open(a, { ...background(a), 'device-sync-disable': answer }, (browser) => browser);

    ui.document.getElementById('sync-toggle').click();
    await settleMany();

    expect(label(ui)).toBe('Syncing');
    expect(a.store.values[SYNC_AUTO_KEY]).toBe(true);
    expect(a.relay.isConnected(a.id)).toBe(true);
    ui.dom.window.close();
  });
});

vi.setConfig({ testTimeout: 20000 });
