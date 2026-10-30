/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// gestureOrder.test.js — a change the user made first never replaces one they made after it. Each change
// is a hold of the prompt store; when the store is busy, the first change waits for it. If the second
// change starts after the store is free again and completes, the first must not land on top of it: it
// lands first, or not at all. Covered for every change a user makes to the prompt_state stores, from the
// background and from a page.

import { afterEach, describe, expect, it } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';

const TEMPLATES = 'agent/modules/templateManager.js';
const REMINDERS = 'agent/modules/reminderStateStore.js';
const ACTION_CONFIG = 'agent/modules/actionCompactConfig.js';
const STORAGE = 'prompts/modules/storage.js';
const ACTION_KEY = 'user_prompts:action_config';
const MAP_KEY = 'disabled_reminders_v2';
const DAY = 86400 * 1000;
/** How long the first change waits before the store is freed: long enough to have asked for it. */
const WAITING_MS = 70;

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const template = (id, name) => ({ id, name, enabled: true, instructions: [], exampleReply: '', deleted: false, deletedAt: null, createdAt: ago(2 * DAY), updatedAt: ago(2 * DAY) });

const devices = [];

afterEach(async () => {
  for (const d of devices.splice(0)) await d.sync.cleanupDeviceSync();
});

/** The prompts page's sliders, as saveActionConfig reads them. */
function sliders(rules, chars) {
  const elements = { 'action-compact-threshold': { value: String(rules) }, 'action-compact-threshold-chars': { value: String(chars) } };
  return { getElementById: (id) => elements[id] ?? null };
}

async function device() {
  const store = new DeviceStore({
    prompt_history_migrated: true,
    templates_migrated: true,
    user_templates: [template('own', 'Own'), template('other', 'Other')],
    [ACTION_KEY]: { compact_threshold: 150, compact_threshold_chars: 20000 },
    'device_sync_ts:actionConfig': ago(2 * DAY),
    [MAP_KEY]: {},
  });
  const d = await new BulletDevice('A', store, new BulletRelay(), { files: [TEMPLATES, REMINDERS, ACTION_CONFIG], retries: 12 }).start();
  devices.push(d);
  const page = d.page([TEMPLATES, REMINDERS]);
  return {
    d,
    store,
    /** The modules as the background runs them, and as a page (the chat window) runs them. */
    in: {
      background: { templates: d.realm.require(TEMPLATES), reminders: d.realm.require(REMINDERS) },
      page: { templates: page.require(TEMPLATES), reminders: page.require(REMINDERS) },
    },
    /** The prompts page's slider save, its sliders at `rules`, `chars`. */
    saveSliders: (rules, chars) => d.page([ACTION_CONFIG, STORAGE, 'prompts/modules/markdown.js'], {}, { document: sliders(rules, chars) }).require(STORAGE).saveActionConfig(),
  };
}

/** Holds the prompt store from the background until the returned function is called. */
async function occupy(d) {
  let release;
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const done = d.prompts.withPromptStore(() => {
    entered();
    return new Promise((resolve) => { release = resolve; });
  }, { label: 'test holder' });
  await inside;
  return async () => {
    release();
    await done;
  };
}

const stored = (store) => store.values.user_templates ?? [];
const own = (store) => stored(store).find((t) => t.id === 'own');
const entry = (store, hash) => store.values[MAP_KEY]?.[hash];

/**
 * Pairs of changes to the same value. `first` and `then` run where their context says; `kept` is what the
 * second leaves, `untouched` that the first has not landed yet while the store is held.
 */
const GESTURES = [
  {
    name: 'compaction sliders moved twice (prompts page)', contexts: [['page', 'page']],
    first: (env) => env.saveSliders(250, 30000),
    then: (env) => env.saveSliders(400, 50000),
    untouched: (s) => s.values[ACTION_KEY].compact_threshold === 150,
    kept: (s) => expect(s.values[ACTION_KEY]).toEqual({ compact_threshold: 400, compact_threshold_chars: 50000 }),
  },
  {
    name: 'a reminder disabled, then enabled', contexts: [['background', 'page'], ['page', 'background'], ['background', 'background'], ['page', 'page']],
    first: (env, m) => m.reminders.setEnabled('m:one', false),
    then: (env, m) => m.reminders.setEnabled('m:one', true),
    untouched: (s) => entry(s, 'm:one') === undefined,
    kept: (s) => expect(entry(s, 'm:one')).toMatchObject({ enabled: true }),
  },
  {
    name: 'a reminder enabled, then disabled', contexts: [['background', 'page'], ['page', 'background']],
    first: (env, m) => m.reminders.setEnabled('m:one', true),
    then: (env, m) => m.reminders.setEnabled('m:one', false),
    untouched: (s) => entry(s, 'm:one') === undefined,
    kept: (s) => expect(entry(s, 'm:one')).toMatchObject({ enabled: false }),
  },
  {
    name: 'a template renamed twice', contexts: [['background', 'page'], ['page', 'background'], ['background', 'background'], ['page', 'page']],
    first: (env, m) => m.templates.updateTemplate('own', { name: 'First name' }),
    then: (env, m) => m.templates.updateTemplate('own', { name: 'Second name' }),
    untouched: (s) => own(s).name === 'Own',
    kept: (s) => expect(own(s)).toMatchObject({ name: 'Second name', deleted: false }),
  },
  {
    name: 'a template renamed, then deleted', contexts: [['background', 'page'], ['page', 'background']],
    first: (env, m) => m.templates.updateTemplate('own', { name: 'First name' }),
    then: (env, m) => m.templates.deleteTemplate('own'),
    untouched: (s) => own(s).name === 'Own',
    kept: (s) => expect(own(s).deleted).toBe(true),
  },
  {
    name: 'templates reordered twice (templates page)', contexts: [['background', 'background']],
    first: (env, m) => m.templates.reorderTemplates(['other', 'own']),
    then: (env, m) => m.templates.reorderTemplates(['own', 'other']),
    untouched: (s) => stored(s)[0].id === 'own',
    kept: (s) => expect(stored(s).map((t) => t.id)).toEqual(['own', 'other']),
  },
  {
    name: 'a template imported over, then renamed (templates page)', contexts: [['background', 'background']],
    first: (env, m) => m.templates.importTemplates(JSON.stringify([{ id: 'own', name: 'Imported' }]), true),
    then: (env, m) => m.templates.updateTemplate('own', { name: 'Second name' }),
    untouched: (s) => own(s).name === 'Own',
    kept: (s) => expect(stored(s).filter((t) => t.id === 'own' && !t.deleted).map((t) => t.name)).toEqual(['Second name']),
  },
  {
    name: 'templates reset to the defaults, then one added (templates page)', contexts: [['background', 'background']],
    first: (env, m) => m.templates.resetToDefaultTemplates(),
    then: (env, m) => m.templates.addTemplate({ name: 'Added after' }),
    untouched: (s) => own(s)?.name === 'Own' && !own(s).deleted,
    kept: (s) => expect(stored(s).filter((t) => t.name === 'Added after' && !t.deleted)).toHaveLength(1),
  },
];

const CASES = GESTURES.flatMap((gesture) => gesture.contexts.map(([firstIn, thenIn]) => ({ ...gesture, firstIn, thenIn })));

describe('a change waiting for the busy prompt store never lands on top of a change made after it', () => {
  it.each(CASES)('$name: the first from the $firstIn, waiting; the second from the $thenIn, after the store is free', async (gesture) => {
    const env = await device();
    const release = await occupy(env.d);
    const first = Promise.resolve().then(() => gesture.first(env, env.in[gesture.firstIn])).then(() => 'done', (e) => `refused: ${e}`);
    await new Promise((resolve) => setTimeout(resolve, WAITING_MS));
    // The first change is waiting for the store, not saved yet.
    expect(gesture.untouched(env.store)).toBe(true);
    await release();
    await gesture.then(env, env.in[gesture.thenIn]);
    expect(await first).toBe('done');
    gesture.kept(env.store);
  });

  it.each(GESTURES.map((gesture) => ({ ...gesture, firstIn: gesture.contexts[0][0], thenIn: gesture.contexts[0][1] })))('control: $name, one after the other with the store free, keeps the second', async (gesture) => {
    const env = await device();
    await gesture.first(env, env.in[gesture.firstIn]);
    await gesture.then(env, env.in[gesture.thenIn]);
    gesture.kept(env.store);
  });
});
