/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// templateWriters.test.js — every template read-change-save runs in one hold of the device's prompt
// semaphore (DS-SEMAPHORE, #193), from the background (the templates page's commands, Device Sync, the
// history restore, startup) and from a page (the chat window's template tools and flows), on a simulated
// device running the real templateManager.js, promptStore.js and deviceSync.js.
//
// The invariant, over every writer: an older template update that resumes after a newer action never
// replaces it. An older writer is held right after one of its template reads or writes (each in turn)
// until its lease ends; a newer action runs meanwhile (a newer edit from the other context, a reset to
// the defaults, or a sign-out and then a newer edit); the older one then resumes. The newer action's
// result must be kept.
// Controls: the same writer uninterrupted, and one that only waits, both land with the newer edit kept.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';
import { createRealm } from './support/deviceRealm.js';

const MANAGER = 'agent/modules/templateManager.js';
const DAY = 86400 * 1000;

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

const template = (id, name, extra = {}) => ({
  id, name, enabled: true, instructions: [], exampleReply: '', deleted: false, deletedAt: null,
  createdAt: new Date(Date.now() - 2 * DAY).toISOString(), updatedAt: new Date(Date.now() - 2 * DAY).toISOString(), ...extra,
});

/** The stored templates every writer starts from: two of the user's, one duplicated id, and a tombstone
 * old enough for Device Sync's clean-up to remove. */
function storedTemplates() {
  const longAgo = new Date(Date.now() - 100 * DAY).toISOString();
  return [
    template('own', 'Own'),
    template('other', 'Other'),
    template('dup', 'Dup'),
    template('dup', 'Dup copy'),
    template('gone', 'Gone', { deleted: true, deletedAt: longAgo, updatedAt: longAgo }),
  ];
}

const devices = [];

/** Lets work queued behind a resumed writer (a reapplied message, a page's reply) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function device({ leaseMs = 15000, values = {} } = {}) {
  const store = new DeviceStore({
    user_templates: storedTemplates(),
    templates_migrated: true,
    prompt_history_migrated: true,
    ...values,
  });
  const relay = new BulletRelay();
  const d = await new BulletDevice('A', store, relay, { files: [MANAGER], leaseMs, retries: 12 }).start();
  devices.push(d);
  return {
    d,
    store,
    /** templateManager.js as the background runs it (host of the prompt store). */
    background: d.realm.require(MANAGER),
    /** templateManager.js as the chat window runs it: the store reached by runtime message. */
    page: d.page([MANAGER]).require(MANAGER),
  };
}

afterEach(async () => {
  for (const d of devices.splice(0)) await d.sync.cleanupDeviceSync();
});

const stored = (store) => store.values.user_templates ?? [];
const named = (store, name) => stored(store).filter((t) => t.name === name && !t.deleted);

/** Whether a storage read or write is one a template writer makes: the templates, or the first-run flag. */
function touchesTemplates(keys) {
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
  return list.includes('user_templates') || list.includes('templates_migrated');
}

/** Holds the `k`-th template read or write (from 1) after it lands, until `open()`; `held` resolves once
 * it is held. Counts them in `io.count`, and names each in `io.ops` ('get' or 'set'). */
function holdTemplateIO(store, k = 1) {
  const { promise, open } = gate();
  let reached;
  const held = new Promise((resolve) => { reached = resolve; });
  const io = { count: 0, ops: [] };
  store.afterIO = async (op, keys) => {
    if (!touchesTemplates(keys)) return;
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

/** A prompt_state from a released peer carrying one newer template. */
function peerTemplates() {
  const now = new Date().toISOString();
  return { type: 'prompt_state', data: { templates: [template('peer', 'Peer', { updatedAt: now })], templates_updated_at: now } };
}

/**
 * Every template writer: where it runs, how it is started, and what it leaves when it lands.
 * `values` overrides the stored state it starts from; `setup` runs before it is started.
 */
const WRITERS = [
  { name: 'add (templates page, chat window)', contexts: ['background', 'page'], run: (m) => m.addTemplate({ name: 'Added' }), landed: (s) => named(s, 'Added').length === 1 },
  { name: 'update (templates page, chat window)', contexts: ['background', 'page'], run: (m) => m.updateTemplate('other', { name: 'Other renamed' }), landed: (s) => named(s, 'Other renamed').length === 1 },
  { name: 'delete (templates page, chat window)', contexts: ['background', 'page'], run: (m) => m.deleteTemplate('other'), landed: (s) => stored(s).find((t) => t.id === 'other').deleted === true },
  { name: 'reorder (templates page)', contexts: ['background'], run: (m) => m.reorderTemplates(['other', 'own']), landed: (s) => stored(s)[0].id === 'other' },
  { name: 'import (templates page)', contexts: ['background'], run: (m) => m.importTemplates(JSON.stringify([{ id: 'imported', name: 'Imported' }])), landed: (s) => named(s, 'Imported').length === 1 },
  { name: 'duplicate clean-up (templates page)', contexts: ['background'], run: (m) => m.dedupeTemplates(), landed: (s) => stored(s).filter((t) => t.id === 'dup').length === 1 },
  { name: 'reset to defaults (templates page)', contexts: ['background'], run: (m) => m.resetToDefaultTemplates(), landed: (s) => named(s, 'Own').length === 0 && stored(s).length > 0 },
  {
    name: 'first-run defaults (startup)', contexts: ['background'], values: { user_templates: [], templates_migrated: false },
    run: (m) => m.ensureMigration(), landed: (s) => s.values.templates_migrated === true && stored(s).length > 1,
  },
  {
    // A received message refused is applied again until it lands (DS-RECEIVE).
    name: 'Device Sync merge and tombstone clean-up', contexts: ['background'], reapplied: true,
    setup: ({ d }) => d.connect(),
    run: (m, { d }) => d.receive(peerTemplates()),
    landed: (s) => named(s, 'Peer').length === 1 && !stored(s).some((t) => t.id === 'gone'),
  },
  {
    name: 'history restore', contexts: ['background'],
    run: (m, { d }) => d.sync.restoreFromHistory({ id: 'entry', templatesJSON: JSON.stringify([template('restored', 'Restored')]) }),
    landed: (s) => named(s, 'Restored').length === 1,
  },
];

const CASES = WRITERS.flatMap((writer) => writer.contexts.map((context) => ({ ...writer, context })));
const other = (context) => (context === 'background' ? 'page' : 'background');

/** The newer edit: the user adds a template from the other context. */
const newerEdit = (managers, context) => managers[other(context)].addTemplate({ name: 'Newer action' });

/** A device set up for `writer`, its setup done. */
async function deviceFor(writer, options = {}) {
  const env = await device({ ...options, values: writer.values });
  await writer.setup?.(env);
  return env;
}

/** The template reads and writes `writer` makes, run uninterrupted ('get' or 'set', in order). */
async function templateIO(writer) {
  const env = await deviceFor(writer);
  const { io } = holdTemplateIO(env.store, 0);
  await writer.run(env[writer.context], env);
  await vi.waitFor(() => expect(writer.landed(env.store)).toBe(true), { timeout: 2000 });
  return io.ops.slice();
}

/**
 * The newer actions run while an older writer is held past its lease. `run` returns what `kept` checks.
 * `replaces`: the newer action replaces the whole list, so a received message the older writer finished
 * applying first is gone after it. A received message a sign-out ends is not applied again (DS-RECEIVE
 * needs a connection).
 */
const NEWER_ACTIONS = [
  {
    name: 'a newer edit',
    run: async (env, writer) => expect(await newerEdit(env, writer.context)).toMatchObject({ name: 'Newer action' }),
    kept: (env, _, at) => expect(named(env.store, 'Newer action'), at).toHaveLength(1),
  },
  {
    name: 'a reset to the defaults', replaces: true,
    run: async (env) => {
      expect(await env.background.resetToDefaultTemplates()).toBeGreaterThan(0);
      return structuredClone(stored(env.store));
    },
    // A message applied again after the reset adds its own template to the reset list; nothing else changes.
    kept: (env, reset, at, writer) => {
      if (!writer.reapplied) return expect(stored(env.store), at).toEqual(reset);
      for (const t of reset) expect(stored(env.store), at).toContainEqual(t);
    },
  },
  {
    name: 'a sign-out, then a newer edit', signsOut: true,
    run: async (env, writer) => {
      expect(await auth(env.d).signOut()).toBe(true);
      expect(await newerEdit(env, writer.context)).toMatchObject({ name: 'Newer action' });
    },
    kept: (env, _, at) => expect(named(env.store, 'Newer action'), at).toHaveLength(1),
  },
];

describe('an older template update that resumes after a newer action never replaces it (#193)', () => {
  it.each(CASES.flatMap((writer) => NEWER_ACTIONS.map((newer) => ({ ...writer, newer }))))('$name, from the $context, held at each template read and write it makes, then $newer.name', async (writer) => {
    const ops = await templateIO(writer);
    expect(ops).toContain('get');
    expect(ops).toContain('set');
    for (let k = 1; k <= ops.length; k++) {
      const at = `held after ${ops[k - 1]} ${k} of ${ops.length}`;
      const env = await deviceFor(writer, { leaseMs: 40 });
      const { held, open } = holdTemplateIO(env.store, k);
      const older = Promise.resolve().then(() => writer.run(env[writer.context], env)).then(() => 'done', (e) => `refused: ${e}`);
      await held;
      // The older writer's hold ends at its lease; the newer action then runs.
      const result = await writer.newer.run(env, writer);
      open();
      await older;
      if (writer.reapplied && !writer.newer.signsOut && !writer.newer.replaces) await vi.waitFor(() => expect(writer.landed(env.store), at).toBe(true), { timeout: 2000 });
      await settle();
      writer.newer.kept(env, result, at, writer);
    }
  });
});

describe('controls: the same writers land, and a writer that waits applies to what the holder saved', () => {
  it.each(CASES)('$name, from the $context, uninterrupted', async (writer) => {
    const env = await deviceFor(writer);
    await writer.run(env[writer.context], env);
    await vi.waitFor(() => expect(writer.landed(env.store)).toBe(true), { timeout: 2000 });
    expect(await newerEdit(env, writer.context)).toMatchObject({ name: 'Newer action' });
    expect(writer.landed(env.store)).toBe(true);
    expect(named(env.store, 'Newer action')).toHaveLength(1);
  });

  it.each(CASES)('$name, from the $context, while a newer edit waits for it', async (writer) => {
    const env = await deviceFor(writer);
    const { held, open } = holdTemplateIO(env.store);
    const older = Promise.resolve().then(() => writer.run(env[writer.context], env));
    await held;
    const newer = newerEdit(env, writer.context);
    open();
    await older;
    expect(await newer).toMatchObject({ name: 'Newer action' });
    await vi.waitFor(() => expect(writer.landed(env.store)).toBe(true), { timeout: 2000 });
    expect(named(env.store, 'Newer action')).toHaveLength(1);
  });
});

/** Whether a read or write touches the template list. */
const namesTemplates = (keys) => (typeof keys === 'string' ? keys === 'user_templates' : Array.isArray(keys) ? keys.includes('user_templates') : Object.hasOwn(keys ?? {}, 'user_templates'));

const FAULTS = [
  ['read', (store) => { store.beforeGet = async (keys) => { if (namesTemplates(keys)) throw new Error('synthetic template read failure'); }; }],
  ['write', (store) => { store.beforeSet = async (values) => { if (namesTemplates(values)) throw new Error('synthetic template write failure'); }; }],
];
const LOCAL_CASES = CASES.filter((writer) => !writer.reapplied && writer.name !== 'history restore');
// A reset replaces the list without reading it (only its history record of what it replaces does).
const reads = (writer) => !writer.name.startsWith('reset');

describe('a template read or write that fails refuses the change, keeps what was stored, and lets the next change land', () => {
  it.each(LOCAL_CASES.flatMap((writer) => FAULTS.filter(([fault]) => fault === 'write' || reads(writer)).map(([fault, inject]) => ({ ...writer, fault, inject }))))('$name, from the $context, its template $fault failing', async (writer) => {
    const env = await deviceFor(writer);
    const before = structuredClone({ templates: env.store.values.user_templates, migrated: env.store.values.templates_migrated });
    writer.inject(env.store);
    await expect(Promise.resolve().then(() => writer.run(env[writer.context], env))).rejects.toThrow(`synthetic template ${writer.fault} failure`);
    expect({ templates: env.store.values.user_templates, migrated: env.store.values.templates_migrated }).toEqual(before);
    env.store.beforeGet = null;
    env.store.beforeSet = null;
    await writer.run(env[writer.context], env);
    expect(writer.landed(env.store)).toBe(true);
  });
});

describe('the sequence from the issue', () => {
  it('an older update of a template resumes after a newer update of it: the newer value is kept', async () => {
    const env = await device({ leaseMs: 40 });
    const { held, open } = holdTemplateIO(env.store);
    const older = env.background.updateTemplate('own', { name: 'Older action' });
    await held;
    expect(await env.page.updateTemplate('own', { name: 'Newer action' })).toMatchObject({ name: 'Newer action' });
    open();
    await expect(older).rejects.toMatchObject({ changed: true });
    expect(stored(env.store).find((t) => t.id === 'own').name).toBe('Newer action');
  });

  it('first-run defaults waiting for the bundled list never revive a default imported and deleted meanwhile', async () => {
    const env = await device({ values: { user_templates: [], templates_migrated: false } });
    const defaults = JSON.parse(readFileSync(new URL('../templates/default_templates.json', import.meta.url), 'utf8'));
    const { promise, open } = gate();
    let fetched;
    const fetching = new Promise((resolve) => { fetched = resolve; });
    env.d.realm.context.fetch = async () => { fetched(); await promise; return { ok: true, json: async () => structuredClone(defaults) }; };
    const older = env.background.initializeDefaultTemplates();
    await fetching;
    const [first] = defaults;
    await env.page.importTemplates(JSON.stringify([first]));
    expect(await env.page.deleteTemplate(first.id)).toBe(true);
    const tombstone = structuredClone(stored(env.store).find((t) => t.id === first.id));
    open();
    await older;
    expect(stored(env.store).filter((t) => t.id === first.id)).toEqual([tombstone]);
    expect(tombstone.deleted).toBe(true);
    expect(env.store.values.templates_migrated).toBe(true);
    expect(stored(env.store).length).toBe(defaults.length);
  });
});
