/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// templateWriters.test.js — every template read-change-save runs in one hold of the device's prompt
// semaphore (DS-SEMAPHORE, #193), from the background (the templates page's commands, Device Sync, the
// history restore, startup) and from a page (the chat window's template tools and flows), on a simulated
// device running the real templateManager.js, promptStore.js and deviceSync.js.
//
// The invariant, over every writer: an older template update that resumes after a newer one never
// replaces the newer value. An older writer is held right after one of its template reads (each in turn)
// until its lease ends; a newer edit from the other context saves meanwhile; the older one then resumes.
// The newer value must be kept.
// Controls: the same writer uninterrupted, and one that only waits, both land with the newer edit kept.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';

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

/** Whether a storage read is one a template writer makes: the templates, or the first-run flag. */
function readsTemplates(keys) {
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
  return list.includes('user_templates') || list.includes('templates_migrated');
}

/** Holds the `k`-th template read (from 1) after it lands, until `open()`; `held` resolves once it is
 * held. Counts the template reads in `reads.count`. */
function holdTemplateRead(store, k = 1) {
  const { promise, open } = gate();
  let reached;
  const held = new Promise((resolve) => { reached = resolve; });
  const reads = { count: 0 };
  store.afterIO = async (op, keys) => {
    if (op !== 'get' || !readsTemplates(keys)) return;
    if (++reads.count !== k) return;
    reached();
    await promise;
  };
  return { held, open, reads };
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

/** How many template reads `writer` makes, run uninterrupted. */
async function templateReads(writer) {
  const env = await deviceFor(writer);
  const { reads } = holdTemplateRead(env.store, 0);
  await writer.run(env[writer.context], env);
  await vi.waitFor(() => expect(writer.landed(env.store)).toBe(true), { timeout: 2000 });
  return reads.count;
}

describe('an older template update that resumes after a newer one never replaces it (#193)', () => {
  it.each(CASES)('$name, from the $context, held at each template read it makes', async (writer) => {
    const count = await templateReads(writer);
    expect(count).toBeGreaterThan(0);
    for (let k = 1; k <= count; k++) {
      const env = await deviceFor(writer, { leaseMs: 40 });
      const { held, open } = holdTemplateRead(env.store, k);
      const older = Promise.resolve().then(() => writer.run(env[writer.context], env)).then(() => 'done', (e) => `refused: ${e}`);
      await held;
      // The older writer's hold ends at its lease; the newer edit then saves.
      expect(await newerEdit(env, writer.context), `held at read ${k} of ${count}`).toMatchObject({ name: 'Newer action' });
      open();
      await older;
      await vi.waitFor(() => expect(named(env.store, 'Newer action'), `held at read ${k} of ${count}`).toHaveLength(1), { timeout: 2000 });
      if (writer.reapplied) await vi.waitFor(() => expect(writer.landed(env.store), `held at read ${k} of ${count}`).toBe(true), { timeout: 2000 });
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
    const { held, open } = holdTemplateRead(env.store);
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

describe('the sequence from the issue', () => {
  it('an older update of a template resumes after a newer update of it: the newer value is kept', async () => {
    const env = await device({ leaseMs: 40 });
    const { held, open } = holdTemplateRead(env.store);
    const older = env.background.updateTemplate('own', { name: 'Older action' });
    await held;
    expect(await env.page.updateTemplate('own', { name: 'Newer action' })).toMatchObject({ name: 'Newer action' });
    open();
    expect(await older).toBeNull();
    expect(stored(env.store).find((t) => t.id === 'own').name).toBe('Newer action');
  });
});
