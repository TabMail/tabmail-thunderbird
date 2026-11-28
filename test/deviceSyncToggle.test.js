/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// deviceSyncToggle.test.js — the Device Sync toggle on the prompts, prompt history and templates pages
// (TB-219). The background alone stores the setting and opens or closes the socket, so a page closed right
// after the click still leaves the setting and the socket in step; the button shows only what is stored and
// whether the socket is open, never a change the background did not make; and every status poll a turn-on
// starts ends by itself. The real pages, on a simulated device whose background runs the real deviceSync.js.

import { describe, expect, it, vi } from 'vitest';
import { loadPage } from './support/addonPage.js';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';
import { openPage, settleMany } from './support/promptsPage.js';

const SYNC_AUTO_KEY = 'device_sync_auto_enabled';
const TOGGLES = ['device-sync-enable', 'device-sync-disable'];

/** Device A with Device Sync on or off, its socket open when on. */
async function device(on) {
  const a = await new BulletDevice('A', new DeviceStore({ [SYNC_AUTO_KEY]: on }), new BulletRelay()).start();
  if (on) await a.connect();
  expect(a.relay.isConnected(a.id)).toBe(on);
  return a;
}

/** The background's answers to a page's Device Sync requests, as background.js gives them: enable and
 * disable through setAutoEnabled, the socket's state from the transport, and on the first listener request
 * the connection state mirrored into storage for the pages. `mirror: false` leaves the mirror out (a
 * background that woke without it); `parentOpen` answers whether the socket is open in place of the relay
 * (a socket still connecting). */
function background(a, { mirror = true, parentOpen = async () => a.relay.isConnected(a.id) } = {}) {
  let mirrored = false;
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
    'device-sync-status': async () => ({ ok: true, connected: await parentOpen() }),
    'device-sync-add-listener': async () => {
      if (mirror && !mirrored) {
        mirrored = true;
        a.sync.addStatusListener((connected) => { a.store.api().local.set({ _deviceSyncConnected: connected }).catch(() => {}); });
      }
      return { ok: true, connected: await parentOpen() };
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

/** Records what the page asks the background (`sent`, by command) and the keys of every write the page
 * itself makes to storage (`writes`). */
function recorder() {
  const sent = [];
  const writes = [];
  const wrap = (browser) => {
    const local = { ...browser.storage.local, set: (values) => { writes.push(...Object.keys(values)); return browser.storage.local.set(values); } };
    const storage = { ...browser.storage, local };
    const runtime = { ...browser.runtime, sendMessage: (message) => { sent.push(message.command); return browser.runtime.sendMessage(message); } };
    return new Proxy(browser, { get: (target, name) => (name === 'storage' ? storage : name === 'runtime' ? runtime : target[name]) });
  };
  return { sent, writes, wrap };
}

/** The page's intervals, run by the test: `tick` runs each live one once, as 500 ms passing would. */
function clock() {
  const live = new Map();
  let next = 0;
  return {
    live,
    timers: {
      setInterval: (run) => { next += 1; live.set(next, run); return next; },
      clearInterval: (id) => { live.delete(id); },
    },
    tick: async () => {
      for (const [id, run] of [...live]) if (live.has(id)) run();
      await settleMany();
    },
  };
}

/** Counts every write of the setting, the page's and the background's, as the store receives them. */
function countSettingWrites(a) {
  const count = { n: 0 };
  a.store.beforeSet = async (values) => { if (SYNC_AUTO_KEY in values) count.n += 1; };
  return count;
}

const rejectSettingWrite = async (values) => { if (SYNC_AUTO_KEY in values) throw new Error('synthetic storage failure'); };

/** Answers a page's runtime messages from `answers`; the page's own loads get an empty list. */
const answering = (answers) => async (message) => (answers[message.command] ? answers[message.command](message) : { ok: true, entries: [], templates: [] });

const PAGES = [
  ['the prompts page', (a, answers, wrapBrowser, timers) => openPage(a, { commands: answers, wrapBrowser, timers })],
  ['the prompt history page', (a, answers, wrapBrowser, timers) => loadPage(a, {
    html: 'prompts/sync-history.html',
    files: ['prompts/sync-history.js'],
    runtime: { sendMessage: answering(answers) },
    wrapBrowser,
    timers,
  })],
  ['the templates page', (a, answers, wrapBrowser, timers) => loadPage(a, {
    html: 'templates/templates.html',
    files: ['templates/templates.js', 'agent/modules/templateManager.js', 'agent/modules/statusLine.js'],
    stubs: { 'agent/modules/config.js': { getTemplateWorkerUrl: async () => 'https://templates.example.com' } },
    runtime: { sendMessage: answering(answers) },
    wrapBrowser,
    timers,
  })],
];

describe.each(PAGES)('the Device Sync toggle on %s', (_name, open) => {
  const label = (ui) => ui.document.getElementById('sync-toggle-label').textContent;
  const click = (ui) => ui.document.getElementById('sync-toggle').click();
  const same = (browser) => browser;

  it('turned off and the page closed at once: the setting is off and the socket closed', async () => {
    const a = await device(true);
    const page = { closed: false };
    const ui = await open(a, background(a), closable(page));
    expect(label(ui)).toBe('Syncing');

    click(ui);
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

    click(ui);
    page.closed = true;
    await vi.waitFor(() => expect(a.relay.isConnected(a.id)).toBe(true));

    expect(a.store.values[SYNC_AUTO_KEY]).toBe(true);
    ui.dom.window.close();
  });

  it.each([
    ['off', true, 'Sync Off'],
    ['on', false, 'Syncing'],
  ])('turned %s with the page open: the background alone stores it, and the page shows the result', async (_to, from, shown) => {
    const a = await device(from);
    const rec = recorder();
    const ui = await open(a, background(a), rec.wrap);
    const asked = rec.sent.length;
    const writes = countSettingWrites(a);

    click(ui);
    await vi.waitFor(() => expect(label(ui)).toBe(shown));

    expect(a.store.values[SYNC_AUTO_KEY]).toBe(!from);
    expect(a.relay.isConnected(a.id)).toBe(!from);
    expect(rec.sent.slice(asked).filter((command) => TOGGLES.includes(command))).toEqual([from ? 'device-sync-disable' : 'device-sync-enable']);
    // One write of the setting reached the store (the control), and it was not the page's.
    expect(writes.n).toBe(1);
    expect(rec.writes).not.toContain(SYNC_AUTO_KEY);
    ui.dom.window.close();
  });

  it.each([
    ['refuses', async () => ({ ok: false, error: 'synthetic refusal' })],
    ['does not answer', async () => { throw new Error('synthetic: no background'); }],
  ])('a turn-off the background %s changes nothing the page shows, before or after its answer', async (_how, answer) => {
    const a = await device(true);
    let answerNow;
    const answered = new Promise((resolve) => { answerNow = resolve; });
    const ui = await open(a, { ...background(a), 'device-sync-disable': async () => { await answered; return answer(); } }, same);

    click(ui);
    await settleMany();
    expect(label(ui)).toBe('Syncing');

    answerNow();
    await settleMany();
    expect(label(ui)).toBe('Syncing');
    expect(a.store.values[SYNC_AUTO_KEY]).toBe(true);
    expect(a.relay.isConnected(a.id)).toBe(true);
    ui.dom.window.close();
  });

  it('a turn-off whose setting cannot be stored: the page still shows sync on, asks once and writes nothing', async () => {
    const a = await device(true);
    const rec = recorder();
    const ui = await open(a, background(a), rec.wrap);
    const asked = rec.sent.length;
    a.store.beforeSet = rejectSettingWrite;

    click(ui);
    await settleMany();

    expect(label(ui)).toBe('Syncing');
    expect(a.store.values[SYNC_AUTO_KEY]).toBe(true);
    expect(a.relay.isConnected(a.id)).toBe(true);
    expect(rec.sent.slice(asked)).toEqual(['device-sync-disable']);
    expect(rec.writes).toEqual([]);
    ui.dom.window.close();
  });

  it('a turn-off that fails after the setting is stored: the page shows the stored setting, asks once and writes nothing', async () => {
    const a = await device(true);
    const rec = recorder();
    const ui = await open(a, background(a), rec.wrap);
    const asked = rec.sent.length;
    a.store.afterIO = async (op, values) => { if (op === 'set' && SYNC_AUTO_KEY in values) throw new Error('synthetic failure after the write'); };

    click(ui);
    await settleMany();

    expect(a.store.values[SYNC_AUTO_KEY]).toBe(false);
    expect(label(ui)).toBe('Sync Off');
    expect(rec.sent.slice(asked)).toEqual(['device-sync-disable']);
    expect(rec.writes).toEqual([]);
    ui.dom.window.close();
  });

  it.each([
    ['cannot store the setting', (a) => { a.store.beforeSet = rejectSettingWrite; return background(a); }],
    ['gives no answer', (a) => ({ ...background(a), 'device-sync-enable': async () => undefined })],
  ])('a turn-on the background %s starts no status requests', async (_how, answers) => {
    const a = await device(false);
    const rec = recorder();
    const time = clock();
    const ui = await open(a, answers(a), rec.wrap, time.timers);
    const asked = rec.sent.length;

    click(ui);
    await settleMany();
    for (let i = 0; i < 3; i++) await time.tick();

    expect(rec.sent.slice(asked)).toEqual(['device-sync-enable']);
    expect(time.live.size).toBe(0);
    expect(label(ui)).toBe('Sync Off');
    expect(a.store.values[SYNC_AUTO_KEY]).toBe(false);
    expect(a.relay.isConnected(a.id)).toBe(false);
    ui.dom.window.close();
  });

  it('turned on with no status mirror: the poll shows the socket once it opens, then stops', async () => {
    const a = await device(false);
    let parentOpen = false;
    const rec = recorder();
    const time = clock();
    const ui = await open(a, background(a, { mirror: false, parentOpen: async () => parentOpen }), rec.wrap, time.timers);
    const asked = rec.sent.length;
    const statusRequests = () => rec.sent.slice(asked).filter((command) => command === 'device-sync-status').length;

    click(ui);
    await settleMany();
    expect(label(ui)).toBe('Sync');
    await time.tick();
    expect(statusRequests()).toBe(1);
    expect(label(ui)).toBe('Sync');

    parentOpen = true;
    await time.tick();
    expect(label(ui)).toBe('Syncing');
    expect(time.live.size).toBe(0);
    for (let i = 0; i < 3; i++) await time.tick();
    expect(statusRequests()).toBe(2);
    ui.dom.window.close();
  });

  it('turned on while the socket never opens: the poll asks at most 10 times and ends', async () => {
    const a = await device(false);
    const rec = recorder();
    const time = clock();
    const ui = await open(a, background(a, { mirror: false, parentOpen: async () => false }), rec.wrap, time.timers);
    const asked = rec.sent.length;

    click(ui);
    await settleMany();
    for (let i = 0; i < 15; i++) await time.tick();

    expect(rec.sent.slice(asked).filter((command) => command === 'device-sync-status').length).toBe(10);
    expect(time.live.size).toBe(0);
    expect(label(ui)).toBe('Sync');
    ui.dom.window.close();
  });

  it('turned off while the poll runs: the poll asks no more and ends', async () => {
    const a = await device(false);
    const rec = recorder();
    const time = clock();
    const ui = await open(a, background(a, { mirror: false, parentOpen: async () => false }), rec.wrap, time.timers);
    const asked = rec.sent.length;
    const statusRequests = () => rec.sent.slice(asked).filter((command) => command === 'device-sync-status').length;

    click(ui);
    await settleMany();
    await time.tick();
    await time.tick();
    expect(statusRequests()).toBe(2);

    click(ui);
    await settleMany();
    for (let i = 0; i < 3; i++) await time.tick();

    expect(statusRequests()).toBe(2);
    expect(time.live.size).toBe(0);
    expect(label(ui)).toBe('Sync Off');
    expect(a.store.values[SYNC_AUTO_KEY]).toBe(false);
    expect(a.relay.isConnected(a.id)).toBe(false);
    ui.dom.window.close();
  });

  it('turned on, off and on again while the first turn-on is still answering: every poll ends', async () => {
    const a = await device(false);
    const rec = recorder();
    const time = clock();
    const answers = background(a, { mirror: false, parentOpen: async () => false });
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    let enables = 0;
    const enable = answers['device-sync-enable'];
    answers['device-sync-enable'] = async (message) => {
      enables += 1;
      const result = await enable(message);
      if (enables === 1) await firstHeld;
      return result;
    };
    const ui = await open(a, answers, rec.wrap, time.timers);
    const asked = rec.sent.length;

    click(ui);
    await settleMany();
    expect(a.store.values[SYNC_AUTO_KEY]).toBe(true);
    click(ui);
    await settleMany();
    expect(a.store.values[SYNC_AUTO_KEY]).toBe(false);
    click(ui);
    await settleMany();
    expect(a.store.values[SYNC_AUTO_KEY]).toBe(true);
    releaseFirst();
    await settleMany();
    expect(time.live.size).toBe(2);

    for (let i = 0; i < 15; i++) await time.tick();

    expect(time.live.size).toBe(0);
    expect(rec.sent.slice(asked).filter((command) => command === 'device-sync-status').length).toBe(20);
    expect(rec.sent.slice(asked).filter((command) => TOGGLES.includes(command))).toEqual(['device-sync-enable', 'device-sync-disable', 'device-sync-enable']);
    ui.dom.window.close();
  });
});

vi.setConfig({ testTimeout: 20000 });
