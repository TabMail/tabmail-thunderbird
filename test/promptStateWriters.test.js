/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptStateWriters.test.js — every read-change-save of the stores a received `prompt_state` also writes
// (the action compaction settings and the disabled-reminders map; the templates have their own matrix in
// templateWriters.test.js) runs in one hold of the device's prompt semaphore (DS-SEMAPHORE, #194), from
// the background, the prompts page and the chat window, on a simulated device running the real
// promptStore.js, deviceSync.js, reminderStateStore.js, actionCompactConfig.js and prompts/modules/storage.js.
//
// The invariant, over every writer: an older update that resumes after a newer action never replaces it,
// and a local edit landing during an incoming apply is never replaced by the peer's older value. An older
// writer is held right after one of its reads or writes of these stores (each in turn) until its lease
// ends; a newer action runs meanwhile (a local edit from another context, a newer received message, or a
// sign-out and then a local edit); the older one then resumes. The newer action's result must be kept.
// Controls: the same writer uninterrupted, and one that only waits, both land with the newer edit kept.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';
import { createRealm } from './support/deviceRealm.js';

const REMINDERS = 'agent/modules/reminderStateStore.js';
const ACTION_CONFIG = 'agent/modules/actionCompactConfig.js';
const TEMPLATES = 'agent/modules/templateManager.js';
const STORAGE = 'prompts/modules/storage.js';
const ACTION_KEY = 'user_prompts:action_config';
const ACTION_TS = 'device_sync_ts:actionConfig';
const MAP_KEY = 'disabled_reminders_v2';
const MAP_TS = 'device_sync_ts:disabledReminders';
const V1_KEY = 'disabled_reminders';
const DAY = 86400 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

/** What every writer starts from: settings and a map edited two days ago, one entry old enough for the
 * clean-up to remove. */
function storedState() {
  return {
    [ACTION_KEY]: { compact_threshold: 150, compact_threshold_chars: 20000 },
    [ACTION_TS]: ago(2 * DAY),
    [MAP_KEY]: { 'm:own': { enabled: false, ts: ago(2 * DAY) }, 'm:stale': { enabled: false, ts: ago(100 * DAY) } },
    [MAP_TS]: ago(2 * DAY),
  };
}

const devices = [];

afterEach(async () => {
  for (const d of devices.splice(0)) await d.sync.cleanupDeviceSync();
});

/** The prompts page's sliders, as saveActionConfig reads them. */
function sliders(rules, chars) {
  const elements = { 'action-compact-threshold': { value: String(rules) }, 'action-compact-threshold-chars': { value: String(chars) } };
  return { getElementById: (id) => elements[id] ?? null };
}

async function device({ leaseMs = 15000, values = {} } = {}) {
  const store = new DeviceStore({ ...storedState(), prompt_history_migrated: true, ...values });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete store.values[key];
  const d = await new BulletDevice('A', store, new BulletRelay(), { files: [REMINDERS, ACTION_CONFIG], leaseMs }).start();
  d.sync.setupStorageListener();
  devices.push(d);
  const chat = d.page([REMINDERS]);
  return {
    d,
    store,
    /** reminderStateStore.js as the background runs it (its reminder commands, the reminder list). */
    background: d.realm.require(REMINDERS),
    /** reminderStateStore.js as the chat window runs it (reminder_del, the reminder list). */
    page: chat.require(REMINDERS),
    /** The prompts page's saveActionConfig with its sliders at `rules`, `chars`. */
    saveActionConfig: (rules, chars) => d.page([ACTION_CONFIG, STORAGE, 'prompts/modules/markdown.js'], {}, { document: sliders(rules, chars) }).require(STORAGE).saveActionConfig(),
  };
}

const map = (store) => store.values[MAP_KEY] ?? {};
const actionConfig = (store) => store.values[ACTION_KEY];

/** Whether a storage read or write touches these stores. */
function touchesStores(keys) {
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
  return list.some((key) => [ACTION_KEY, ACTION_TS, MAP_KEY, MAP_TS, V1_KEY].includes(key));
}

/** Holds the `k`-th read or write of these stores (from 1) after it lands, until `open()`. */
function holdIO(store, k = 1) {
  const { promise, open } = gate();
  let reached;
  const held = new Promise((resolve) => { reached = resolve; });
  const io = { count: 0, ops: [] };
  store.afterIO = async (op, keys) => {
    if (!touchesStores(keys)) return;
    io.ops.push(op);
    if (++io.count !== k) return;
    reached();
    await promise;
  };
  return { held, open, io };
}

/** supabaseAuth.js on the device's background, for its sign-out. */
function auth(d) {
  return createRealm({
    files: ['agent/modules/supabaseAuth.js'],
    stubs: {
      'agent/modules/config.js': { SETTINGS: {}, getBackendUrl: async () => 'https://backend.example.com' },
      'agent/modules/utils.js': { log() {} },
      'agent/modules/deviceSync.js': d.sync,
      'agent/modules/promptStore.js': d.prompts,
    },
    globals: { browser: { storage: d.store.api() }, setTimeout, clearTimeout },
  }).require('agent/modules/supabaseAuth.js');
}

/** A released peer's prompt_state, a minute old: newer than this device's stored state, older than an
 * edit made now. */
function peerState({ actionConfig = true } = {}) {
  const at = ago(60 * 1000);
  return {
    type: 'prompt_state',
    data: {
      updatedAt: at,
      ...(actionConfig ? { actionConfig: { compact_threshold: 300, compact_threshold_chars: 40000 }, actionConfig_updated_at: at } : {}),
      disabledReminders: { 'm:peer': { enabled: false, ts: at } }, disabledReminders_updated_at: at,
    },
  };
}

/**
 * Every local and received writer of these stores: where it runs, how it is started, what it leaves.
 * `values` overrides the stored state it starts from; `setup` runs before it is started; `reapplied`: a
 * message refused is applied again until it lands (DS-RECEIVE).
 */
const WRITERS = [
  {
    name: 'Device Sync apply of a received prompt_state', contexts: ['background'], reapplied: true,
    setup: ({ d }) => d.connect(),
    run: (env) => env.d.receive(peerState()),
    landed: (s) => map(s)['m:peer']?.enabled === false,
  },
  {
    // Only the map: its own refusal, with no later write in the message to be refused, applies it again.
    name: 'Device Sync apply of a received reminder map', contexts: ['background'], reapplied: true,
    setup: ({ d }) => d.connect(),
    run: (env) => env.d.receive(peerState({ actionConfig: false })),
    landed: (s) => map(s)['m:peer']?.enabled === false,
  },
  {
    name: 'compaction sliders (prompts page)', contexts: ['prompts page'],
    run: (env) => env.saveActionConfig(250, 30000),
    landed: (s) => actionConfig(s)?.compact_threshold === 250,
  },
  {
    name: 'disable a reminder (background command, chat tool)', contexts: ['background', 'chat window'],
    run: (env, m) => m.setEnabled('m:older', false),
    landed: (s) => map(s)['m:older']?.enabled === false,
  },
  {
    name: 'disable a reminder on a device still holding the v1 list', contexts: ['background', 'chat window'],
    values: { [MAP_KEY]: undefined, [MAP_TS]: undefined, [V1_KEY]: ['m:v1'] },
    run: (env, m) => m.setEnabled('m:older', false),
    landed: (s) => map(s)['m:older']?.enabled === false && map(s)['m:v1']?.enabled === false,
  },
  {
    name: 'clean-up of stale entries (reminder list)', contexts: ['background', 'chat window'],
    run: (env, m) => m.gcStaleEntries(new Set(['m:own'])),
    landed: (s) => !('m:stale' in map(s)) && map(s)['m:own']?.enabled === false,
  },
  {
    name: 'hash migration (reminder list)', contexts: ['background', 'chat window'],
    run: (env, m) => m.migrateEntries({ 'm:migrated': { enabled: false, ts: new Date().toISOString() } }),
    landed: (s) => map(s)['m:migrated']?.enabled === false,
  },
];

const CASES = WRITERS.flatMap((writer) => writer.contexts.map((context) => ({ ...writer, context })));
const managerFor = (env, context) => (context === 'chat window' ? env.page : env.background);

/** The newer local edit: the compaction sliders moved on the prompts page, and a reminder disabled from
 * the context the older writer is not in. Returns when it started. */
async function newerEdit(env, writer) {
  const at = new Date().toISOString();
  await env.saveActionConfig(400, 50000);
  await managerFor(env, writer.context === 'background' ? 'chat window' : 'background').setEnabled('m:newer', false);
  return at;
}

const keptNewerEdit = (env, at, label) => {
  expect(actionConfig(env.store), label).toEqual({ compact_threshold: 400, compact_threshold_chars: 50000 });
  expect(env.store.values[ACTION_TS] >= at, `${label}: the edit's timestamp`).toBe(true);
  expect(map(env.store)['m:newer'], label).toMatchObject({ enabled: false });
  expect(map(env.store)['m:newer'].ts >= at, `${label}: the entry's timestamp`).toBe(true);
};

/** The newer actions run while an older writer is held past its lease. */
const NEWER_ACTIONS = [
  { name: 'a newer local edit', run: (env, writer) => newerEdit(env, writer), kept: keptNewerEdit },
  {
    // Received messages are applied one after another (DS-RECEIVE): one never runs while an older one is
    // held, so this action does not interrupt the received writer.
    name: 'a newer received message', received: true,
    run: async (env) => {
      await env.d.connect();
      const at = new Date().toISOString();
      await env.d.receive({ type: 'prompt_state', data: { updatedAt: at, actionConfig: { compact_threshold: 350, compact_threshold_chars: 45000 }, actionConfig_updated_at: at, disabledReminders: { 'm:peer2': { enabled: false, ts: at } }, disabledReminders_updated_at: at } });
      return at;
    },
    kept: (env, at, label) => {
      expect(actionConfig(env.store), label).toEqual({ compact_threshold: 350, compact_threshold_chars: 45000 });
      expect(env.store.values[ACTION_TS], label).toBe(at);
      expect(map(env.store)['m:peer2'], label).toEqual({ enabled: false, ts: at });
    },
  },
  {
    name: 'a sign-out, then a newer local edit', signsOut: true,
    run: async (env, writer) => {
      expect(await auth(env.d).signOut()).toBe(true);
      return newerEdit(env, writer);
    },
    kept: keptNewerEdit,
  },
];

/** A device set up for `writer`, its setup done. */
async function deviceFor(writer, options = {}) {
  const env = await device({ ...options, values: writer.values });
  await writer.setup?.(env);
  return env;
}

const start = (env, writer) => writer.run(env, managerFor(env, writer.context));

/** The reads and writes of these stores `writer` makes, run uninterrupted ('get' or 'set', in order). */
async function storeIO(writer) {
  const env = await deviceFor(writer);
  const { io } = holdIO(env.store, 0);
  await start(env, writer);
  await vi.waitFor(() => expect(writer.landed(env.store)).toBe(true), { timeout: 2000 });
  return io.ops.slice();
}

/** Lets work queued behind a resumed writer (a reapplied message) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('an older update of the prompt_state stores that resumes after a newer action never replaces it (#194)', () => {
  it.each(CASES.flatMap((writer) => NEWER_ACTIONS.filter((newer) => !(newer.received && writer.reapplied)).map((newer) => ({ ...writer, newer }))))('$name, from the $context, held at each read and write it makes, then $newer.name', async (writer) => {
    const ops = await storeIO(writer);
    // The sliders' save writes without reading; every other writer reads and writes.
    expect(ops).toContain('set');
    for (let k = 1; k <= ops.length; k++) {
      const label = `held after ${ops[k - 1]} ${k} of ${ops.length}`;
      const env = await deviceFor(writer, { leaseMs: 40 });
      const { held, open } = holdIO(env.store, k);
      const older = Promise.resolve().then(() => start(env, writer)).then(() => 'done', (e) => `refused: ${e}`);
      await held;
      // The older writer's hold ends at its lease; the newer action then runs.
      const at = await writer.newer.run(env, writer);
      open();
      await older;
      if (writer.reapplied && !writer.newer.signsOut) await vi.waitFor(() => expect(writer.landed(env.store), label).toBe(true), { timeout: 2000 });
      await settle();
      writer.newer.kept(env, at, label);
    }
  });
});

describe('controls: the same writers land, and a writer that waits applies to what the holder saved', () => {
  it.each(CASES)('$name, from the $context, uninterrupted', async (writer) => {
    const env = await deviceFor(writer);
    await start(env, writer);
    await vi.waitFor(() => expect(writer.landed(env.store)).toBe(true), { timeout: 2000 });
    const at = await newerEdit(env, writer);
    expect(writer.landed(env.store) || writer.contexts.includes('prompts page')).toBe(true);
    keptNewerEdit(env, at, 'after');
  });

  it.each(CASES)('$name, from the $context, while a newer edit waits for it', async (writer) => {
    const env = await deviceFor(writer);
    const { held, open } = holdIO(env.store);
    const older = Promise.resolve().then(() => start(env, writer));
    await held;
    const newer = newerEdit(env, writer);
    open();
    await older;
    const at = await newer;
    await vi.waitFor(() => expect(writer.landed(env.store) || writer.contexts.includes('prompts page')).toBe(true), { timeout: 2000 });
    keptNewerEdit(env, at, 'after');
  });
});

describe('a received prompt_state is applied as received', () => {
  // It keeps the peer's timestamps, is not sent back to peers and is not recorded as a local edit; a local
  // edit is (control).
  it('a received map and settings are not stamped now, sent back or recorded as a local edit', async () => {
    const env = await device();
    await env.d.connect();
    const stamps = { map: env.store.values[MAP_TS] };
    const sent = () => env.d.relay.legacy.filter(({ from, message }) => from === 'A' && message.type === 'prompt_state');
    const before = sent().length;
    const message = peerState();
    await env.d.receive(message);
    expect(map(env.store)['m:peer']).toEqual(message.data.disabledReminders['m:peer']);
    expect(env.store.values[ACTION_TS]).toBe(message.data.actionConfig_updated_at);
    // Past the broadcast and edit-history debounces.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(env.store.values[MAP_TS]).toBe(stamps.map);
    expect(env.store.values[ACTION_TS]).toBe(message.data.actionConfig_updated_at);
    expect(sent().length).toBe(before);
    expect((env.store.values.prompt_history ?? []).filter((entry) => entry.source === 'local_edit')).toEqual([]);

    await env.background.setEnabled('m:local', false);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(sent().length).toBe(before + 1);
    expect(sent().at(-1).message.data.disabledReminders['m:local']).toMatchObject({ enabled: false });
    expect((env.store.values.prompt_history ?? []).filter((entry) => entry.source === 'local_edit')).toHaveLength(1);
  }, 10000);

  it('a received template merge and its tombstone clean-up are not stamped now, sent back or recorded as a local edit', async () => {
    const old = ago(2 * DAY);
    const store = new DeviceStore({
      prompt_history_migrated: true,
      user_templates: [{ id: 'gone', name: 'Gone', deleted: true, deletedAt: ago(100 * DAY), updatedAt: ago(100 * DAY) }],
      'device_sync_ts:templates': old,
    });
    const d = await new BulletDevice('A', store, new BulletRelay(), { files: [TEMPLATES] }).start();
    devices.push(d);
    await d.connect();
    const sent = () => d.relay.legacy.filter(({ from, message }) => from === 'A' && message.type === 'prompt_state');
    const localEdits = () => (store.values.prompt_history ?? []).filter((entry) => entry.source === 'local_edit');
    const before = sent().length;
    const incoming = { id: 'peer', name: 'Peer', enabled: true, instructions: [], exampleReply: '', updatedAt: ago(60 * 1000) };
    await d.receive({ type: 'prompt_state', data: { templates: [incoming], templates_updated_at: incoming.updatedAt } });
    expect(store.values.user_templates.map((t) => t.id)).toEqual(['peer']);
    // Past the broadcast and edit-history debounces.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(store.values['device_sync_ts:templates']).toBe(old);
    expect(sent().length).toBe(before);
    expect(localEdits()).toEqual([]);

    await d.realm.require(TEMPLATES).addTemplate({ name: 'Local' });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(store.values['device_sync_ts:templates'] > old).toBe(true);
    expect(sent().length).toBe(before + 1);
    expect(localEdits()).toHaveLength(1);
  }, 10000);
});

describe('a device that has only the old disabled-reminders list', () => {
  it('sends it as the map with its timestamp, without storing the map, and a peer with an older enabled entry takes it', async () => {
    const at = ago(DAY);
    const store = new DeviceStore({ prompt_history_migrated: true, [V1_KEY]: ['m:legacy'], [MAP_TS]: at });
    const a = await new BulletDevice('A', store, new BulletRelay(), { files: [REMINDERS, ACTION_CONFIG] }).start();
    devices.push(a);
    await a.connect();
    const payload = a.relay.legacy.find(({ from, message }) => from === 'A' && message.type === 'prompt_state')?.message;
    expect(payload?.data.disabledReminders).toEqual({ 'm:legacy': { enabled: false, ts: at } });
    expect(payload.data.disabledReminders_updated_at).toBe(at);
    expect(store.values[MAP_KEY]).toBeUndefined();

    const peer = new DeviceStore({ prompt_history_migrated: true, [MAP_KEY]: { 'm:legacy': { enabled: true, ts: ago(2 * DAY) } } });
    const b = await new BulletDevice('B', peer, a.relay, { files: [REMINDERS, ACTION_CONFIG] }).start();
    devices.push(b);
    await b.connect();
    await b.receive(payload);
    expect(peer.values[MAP_KEY]['m:legacy']).toEqual({ enabled: false, ts: at });
  });
});

describe('the sequence from the issue', () => {
  it('the compaction sliders moved while a received prompt_state is applied keep their value and timestamp', async () => {
    const env = await device({ leaseMs: 40 });
    await env.d.connect();
    // Held at the apply's first write of these stores (its reminder merge), past its lease.
    const { held, open } = holdIO(env.store, 3);
    const apply = env.d.receive(peerState()).catch(() => {});
    await held;
    const at = new Date().toISOString();
    await env.saveActionConfig(400, 50000);
    open();
    await apply;
    await settle();
    expect(actionConfig(env.store)).toEqual({ compact_threshold: 400, compact_threshold_chars: 50000 });
    expect(env.store.values[ACTION_TS] >= at).toBe(true);
  });
});
