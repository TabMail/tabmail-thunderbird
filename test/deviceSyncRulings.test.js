/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// deviceSyncRulings.test.js — what Thunderbird does around the bullet fields beyond the merge, on
// simulated devices (bulletDevices.js): the request_state it sends and answers, a prompt history
// restore, and sign-out and sign-in, which delete nothing (DS-DEVICE); an upgrade not saved yet, an AI write
// against a newer change (DS-AI), and a field sent in many parts; and the default catalog against the texts
// the add-on ships.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultState, EPOCH_ZERO, parse, render, SYNC_FIELDS } from '../agent/modules/bullets.js';
import { addItems } from '../prompts/modules/markdown.js';
import { BulletDevice, BulletRelay, builtInSkeleton, defaultCatalog, DeviceStore, PROMPT_KEYS, storeStates } from './support/bulletDevices.js';

/** The fields `prompt_state` still carries. */
const LEGACY_FIELDS = ['templates', 'disabledReminders', 'taskCache', 'actionConfig'];

function hex(value) {
  return value.toString(16).padStart(8, '0');
}

/** Device `index`'s k-th writer name. */
function nameOf(index, k) {
  return `${hex(index)}${hex(k)}`;
}

function device(id, index, relay, store = new DeviceStore()) {
  return new BulletDevice(id, store, relay, { name: (k) => nameOf(index, k) });
}

async function quiesce(relay) {
  while (await relay.deliverOldest()) { /* every pending part */ }
}

function texts(state) {
  return state.bullets.map((bullet) => [bullet.section, bullet.text]).sort();
}

/** What a device sent, parsed: `bullet_state` parts of `field`, oldest first. */
function bulletParts(relay, from, field) {
  return [...relay.snapshots.values()].filter((snapshot) => snapshot.from === from && snapshot.field === field).flatMap((snapshot) => snapshot.parts.map((text) => JSON.parse(text)));
}

/** The catalog defaults of `field` as DS-RESET stores them. */
function defaults(field) {
  const entries = defaultCatalog.defaults.filter((entry) => entry.field === field);
  return {
    texts: entries.map((entry) => [entry.section, entry.text]).sort(),
    seen: Object.fromEntries(entries.map((entry) => [`default:${entry.id}`, 1])),
  };
}

/** Two connected devices, each with `Alpha` on the other already. */
async function twoDevices() {
  const relay = new BulletRelay();
  const a = await device('A', 1, relay).start();
  const b = await device('B', 2, relay).start();
  await a.connect();
  await b.connect();
  await quiesce(relay);
  await a.add('kb', '', 'Alpha');
  await quiesce(relay);
  return { relay, a, b };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('request_state (R9)', () => {
  it('names only the prompt_state fields, whatever sends it', async () => {
    const relay = new BulletRelay();
    const a = await device('A', 1, relay).start();
    await a.connect();
    await a.sync.syncNow();
    await a.sync.resetFieldToDefault('templates', []);

    const requests = relay.legacy.filter((entry) => entry.from === 'A' && entry.message.type === 'request_state').map((entry) => entry.message.fields);
    // A new device's connect probe, Sync Now's probe, and a templates reset's request.
    expect(requests).toEqual([LEGACY_FIELDS, LEGACY_FIELDS, ['templates']]);
    for (const fields of requests) for (const field of SYNC_FIELDS) expect(fields).not.toContain(field);
  });

  it('is answered with the texts empty at epoch zero and every other field as stored (DS-LEGACY-OUT)', async () => {
    const relay = new BulletRelay();
    const store = new DeviceStore({
      user_templates: [{ id: 'template-1', name: 'Synthetic template', updatedAt: '2099-01-02T00:00:00.000Z' }],
      'device_sync_ts:templates': '2099-01-02T00:00:00.000Z',
      'device_sync_ts:kb': '2099-01-03T00:00:00.000Z',
    });
    storeStates(store, { kb: { bullets: [['', 'Stored fact', 'default:kb-1', 1]], seen: { 'default:kb-1': 1 } } });
    const a = await device('A', 1, relay, store).start();
    await a.connect();
    relay.legacy.length = 0;

    await a.receive({ type: 'request_state', fields: ['kb', 'templates'] });
    await a.receive({ type: 'request_state' });

    const answers = relay.legacy.filter((entry) => entry.from === 'A' && entry.message.type === 'prompt_state').map((entry) => entry.message.data);
    expect(answers).toHaveLength(2);
    for (const data of answers) {
      expect(data.kb).toBe('');
      expect(data.kb_updated_at).toBe(EPOCH_ZERO);
      expect(data.templates).toEqual(store.values.user_templates);
      expect(data.templates_updated_at).toBe('2099-01-02T00:00:00.000Z');
    }
    expect(Object.keys(answers[0]).filter((key) => !key.endsWith('_updated_at') && key !== 'updatedAt').sort()).toEqual(['kb', 'templates']);
    for (const field of ['composition', 'action']) {
      expect(answers[1][field]).toBe('');
      expect(answers[1][`${field}_updated_at`]).toBe(EPOCH_ZERO);
    }
  });
});

describe('restoring a prompt history entry (R10)', () => {
  it('deletes the labels whose text the entry lacks, adds its texts under the same writer name, and both devices agree', async () => {
    const { relay, a, b } = await twoDevices();
    await b.add('kb', '', 'Beta');
    await quiesce(relay);
    const entry = {
      kb: render('kb', { bullets: [{ section: '', text: 'Alpha' }, { section: '', text: 'Gamma' }] }),
      composition: await a.prompts.readText('composition'),
      action: await a.prompts.readText('action'),
      templatesJSON: '[]',
    };
    const before = await a.state('kb');

    await a.sync.restoreFromHistory(entry);
    await quiesce(relay);

    const after = await a.state('kb');
    expect(texts(after)).toEqual([['', 'Alpha'], ['', 'Gamma']]);
    // Alpha keeps its label; Gamma is labelled with the name Alpha was added under.
    expect(after.bullets.find((bullet) => bullet.text === 'Alpha')).toEqual(before.bullets.find((bullet) => bullet.text === 'Alpha'));
    expect(after.bullets.find((bullet) => bullet.text === 'Gamma').name).toBe(nameOf(1, 1));
    expect(texts(await b.state('kb'))).toEqual(texts(after));
    // The other two fields were restored as they were: nothing about them changed.
    for (const field of ['composition', 'action']) expect(texts(await b.state(field))).toEqual(texts(await a.state(field)));
  });

  it('leaves the bullets of a section this app does not show (R6)', async () => {
    const relay = new BulletRelay();
    const store = new DeviceStore();
    storeStates(store, {
      composition: {
        bullets: [['general', 'Shown rule', '00000000000000ff', 1], ['future-section', 'Unknown section rule', '00000000000000ff', 2]],
        seen: { '00000000000000ff': 2 },
      },
    });
    const a = await device('A', 1, relay, store).start();
    const entry = { composition: render('composition', { ...builtInSkeleton('composition'), bullets: [{ section: 'general', text: 'Restored rule' }] }), templatesJSON: '[]' };

    await a.sync.restoreFromHistory(entry);

    expect(texts(await a.state('composition'))).toEqual([['future-section', 'Unknown section rule'], ['general', 'Restored rule']]);
  });

  it('changes nothing when the restore cannot be saved', async () => {
    const { relay, a, b } = await twoDevices();
    const kbBefore = await a.state('kb');
    const sentBefore = relay.sent('A', 'kb');
    a.store.failNext = true;

    await expect(a.sync.restoreFromHistory({ kb: '- Other', templatesJSON: '[]' })).rejects.toThrow('could not be restored');

    expect(await a.state('kb')).toEqual(kbBefore);
    expect(relay.sent('A', 'kb')).toBe(sentBefore);
    expect(texts(await b.state('kb'))).toEqual(texts(kbBefore));
  });
});

/** What supabaseAuth.signOut does to Device Sync: the transport closed. It never reaches the prompt store,
 * and nothing is removed (DS-DEVICE). */
async function signOut(d) {
  await d.sync.cleanupDeviceSync();
}

describe('sign-out and the next sign-in delete nothing (R34)', () => {
  it('keeps every field with its labels and seen map for the next read', async () => {
    const { a } = await twoDevices();
    await a.add('composition', 'general', 'Custom rule');
    const stored = Object.fromEntries(SYNC_FIELDS.flatMap((field) => [`bullet_state:${field}`, PROMPT_KEYS[field]].map((key) => [key, structuredClone(a.store.values[key])])));
    const states = Object.fromEntries(await Promise.all(SYNC_FIELDS.map(async (field) => [field, await a.state(field)])));

    await signOut(a);

    for (const [key, value] of Object.entries(stored)) expect(a.store.values[key], key).toEqual(value);
    for (const field of SYNC_FIELDS) expect(await a.state(field)).toEqual(states[field]);
  });

  it('sends no bullet_state while signed out; at the next sign-in it sends the kept bullets under the kept writer name', async () => {
    const { relay, a, b } = await twoDevices();
    const sentBefore = Object.fromEntries(SYNC_FIELDS.map((field) => [field, relay.sent('A', field)]));

    await signOut(a);
    await a.add('kb', '', 'Signed-out note');
    await a.reset('composition');

    for (const field of SYNC_FIELDS) expect(relay.sent('A', field)).toBe(sentBefore[field]);
    // Not even tried: the parent would refuse a send on the closed socket before the relay saw it.
    expect(relay.closedSends.filter(({ from }) => from === 'A')).toEqual([]);

    await a.connect();
    const kb = bulletParts(relay, 'A', 'kb').at(-1);
    expect(kb.bullets.find(([, text]) => text === 'Alpha')[2]).toBe(nameOf(1, 1));
    expect(kb.bullets.find(([, text]) => text === 'Signed-out note')[2]).toBe(nameOf(1, 1));
    await quiesce(relay);
    expect(texts(await b.state('kb'))).toContainEqual(['', 'Alpha']);
    expect(texts(await b.state('kb'))).toContainEqual(['', 'Signed-out note']);
  });
});

describe('an upgrade from the texts of a released version (DS-UPGRADE)', () => {
  function legacyStore() {
    return new DeviceStore({ [PROMPT_KEYS.kb]: '- Alpha\n- Beta' });
  }

  it('is sent nothing of until it is saved, then everything it holds', async () => {
    const relay = new BulletRelay();
    const store = legacyStore();
    store.failing = true;
    const a = await device('A', 1, relay, store).start();
    const b = await device('B', 2, relay).start();
    await b.connect();
    await a.connect();
    await quiesce(relay);

    expect(texts(await a.state('kb'))).toEqual([['', 'Alpha'], ['', 'Beta']]);
    for (const field of SYNC_FIELDS) expect(relay.sent('A', field)).toBe(0);

    store.failing = false;
    await a.disconnect();
    await a.connect();
    await quiesce(relay);
    expect(texts(await b.state('kb'))).toEqual(expect.arrayContaining([['', 'Alpha'], ['', 'Beta']]));
  });

  /** R20: the upgrade's write failed on connect, and a later read saves it: sent then, not at the next
   * connect. */
  it('saved by a read after a failed write on connect, is sent at once, every field it saved', async () => {
    const relay = new BulletRelay();
    const store = legacyStore();
    store.values[PROMPT_KEYS.composition] = '# Language (DO NOT EDIT/DELETE THIS SECTION HEADER)\n- Write in French.';
    store.failing = true;
    const a = await device('A', 1, relay, store).start();
    const b = await device('B', 2, relay).start();
    await b.connect();
    await a.connect();
    await quiesce(relay);
    expect(relay.sent('A', 'kb')).toBe(0);

    store.failing = false;
    // The app's own read of the text, through the prompt store, saves the upgrade.
    expect(await a.prompts.readText('kb')).toBe('- Alpha\n- Beta');
    expect(store.values['bullet_state:composition']).toBeDefined();
    await vi.waitFor(() => expect(relay.sent('A', 'composition')).toBeGreaterThan(0));
    await quiesce(relay);
    expect(texts(await b.state('kb'))).toEqual(expect.arrayContaining([['', 'Alpha'], ['', 'Beta']]));
    expect(texts(await b.state('composition'))).toContainEqual(['language', 'Write in French.']);
  });

  /** R20: an upgrade saved by a commit of another field sends the upgraded field too. */
  it('saved by an edit of another field, is sent with it', async () => {
    const relay = new BulletRelay();
    const store = legacyStore();
    store.failing = true;
    const a = await device('A', 1, relay, store).start();
    const b = await device('B', 2, relay).start();
    await b.connect();
    await a.connect();
    await quiesce(relay);

    store.failing = false;
    await a.add('composition', 'general', 'Sign off briefly.');
    await vi.waitFor(() => expect(relay.sent('A', 'kb')).toBeGreaterThan(0));
    await quiesce(relay);
    expect(texts(await b.state('composition'))).toContainEqual(['general', 'Sign off briefly.']);
    expect(texts(await b.state('kb'))).toEqual(expect.arrayContaining([['', 'Alpha'], ['', 'Beta']]));
  });

  it('takes no snapshot in before it is saved, so no text it held is lost', async () => {
    const store = legacyStore();
    store.failNext = true;
    const a = await device('A', 1, new BulletRelay(), store).start();
    const peer = 'ffffffff00000001';
    await a.receive({ type: 'bullet_state', v: 1, field: 'kb', sender: 'ffffffffffffffff', snap: '0000000000000001', part: 1, parts: 1, bullets: [['', 'Gamma', peer, 1]], seen: { [peer]: 1 } });

    expect(texts(await a.state('kb'))).toEqual(expect.arrayContaining([['', 'Alpha'], ['', 'Beta']]));
  });

  it('discards the released merge\'s peer bases once it is saved, and nothing else', async () => {
    const store = legacyStore();
    const peerBases = ['kb', 'composition', 'action'].flatMap((field) => [`device_peer_base:${field}`, `device_peer_base_ts:${field}`]);
    const time = new Date().toISOString();
    for (const key of peerBases) store.values[key] = time;
    store.values['device_sync_ts:templates'] = time;

    const a = await device('A', 1, new BulletRelay(), store).start();
    // The upgrade is saved by the first read through the prompt store, not at startup.
    await a.prompts.readText('kb');

    expect(store.values['bullet_state:kb']).toBeDefined();
    for (const key of peerBases) expect(store.values[key], key).toBeUndefined();
    expect(store.values['device_sync_ts:templates']).toBe(time);
  });
});

/** A store whose saves of the knowledge base fail while `kbFailing` is set: the upgrade, which saves
 * every field in one write, fails while a save of the rules alone would not. */
class KbFailingStore extends DeviceStore {
  api() {
    const api = super.api();
    const set = api.local.set;
    api.local.set = async (values) => {
      if (this.kbFailing && Object.hasOwn(values, 'bullet_state:kb')) throw new Error('synthetic storage failure');
      return set(values);
    };
    return api;
  }
}

describe('an edit while the upgrade cannot be saved (DS-UPGRADE)', () => {
  it('is refused, and every bullet of the released texts is there once the upgrade is saved', async () => {
    const bundled = parse('composition', readFileSync(new URL('../prompts/user_composition.md', import.meta.url), 'utf8'));
    const released = render('composition', {
      ...bundled,
      bullets: [...bundled.bullets, { section: 'general', text: 'Custom released rule', name: 'default:x', n: 1 }],
      seen: new Map(),
    });
    const store = new KbFailingStore({ [PROMPT_KEYS.kb]: '- Alpha', [PROMPT_KEYS.composition]: released });
    store.kbFailing = true;
    const a = await device('A', 1, new BulletRelay(), store).start();

    // The page shows a failed save; nothing commits against the unsaved upgrade.
    expect(await a.add('composition', 'general', 'Edited rule')).toEqual({ outcome: 'unsaved' });
    expect(store.values['bullet_state:composition']).toBeUndefined();

    store.kbFailing = false;
    await a.add('kb', '', 'Later');
    expect(store.values['bullet_state:composition']).toBeDefined();
    expect(texts(await a.state('composition'))).toContainEqual(['general', 'Custom released rule']);
    expect(texts(await a.state('kb'))).toEqual(expect.arrayContaining([['', 'Alpha'], ['', 'Later']]));
  });

  // R22: a read then shows labels the upgrade's save does not use, and a deletion committed against them
  // after it is saved would delete nothing; so the read shows the text but captures nothing to write against.
  it('shows the text but captures nothing, refuses a restore, and a deletion read once it is saved is applied (R22)', async () => {
    const store = new DeviceStore({ [PROMPT_KEYS.kb]: '- Alpha\n- Beta' });
    store.failing = true;
    const a = await device('A', 1, new BulletRelay(), store).start();

    const early = await a.startEdit('kb');
    expect(early.content).toBe('- Alpha\n- Beta');
    expect(early.captured).toBeNull();
    expect(await a.commitRead('kb', '', early, (list) => list.filter((text) => text !== 'Beta'))).toEqual({ outcome: 'unsaved' });
    await expect(a.restore({ kb: '- Alpha' })).rejects.toThrow('the history entry could not be restored');
    expect(texts(await a.state('kb'))).toEqual([['', 'Alpha'], ['', 'Beta']]);

    store.failing = false;
    const read = await a.startEdit('kb');
    expect((await a.commitRead('kb', '', read, (list) => list.filter((text) => text !== 'Beta'))).outcome).toBe('saved');
    expect(texts(await a.state('kb'))).toEqual([['', 'Alpha']]);
  });

  it('refuses a restore begun while the upgrade could not be saved, and applies the next one once it is (R22)', async () => {
    const store = new DeviceStore({ [PROMPT_KEYS.kb]: '- Alpha\n- Beta' });
    store.failing = true;
    const a = await device('A', 1, new BulletRelay(), store).start();
    store.failing = false;
    store.failNext = true;

    await expect(a.restore({ kb: '- Alpha' })).rejects.toThrow('the history entry could not be restored');
    await a.restore({ kb: '- Alpha' });
    expect(texts(await a.state('kb'))).toEqual([['', 'Alpha']]);
  });
});

describe('the prompts page (DS-CAPTURE)', () => {
  async function page() {
    const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay(), { name: (k) => nameOf(1, k), files: ['prompts/modules/markdown.js', 'prompts/modules/storage.js'] }).start();
    return { a, storage: a.realm.require('prompts/modules/storage.js') };
  }

  it('keeps a bullet that arrives in a section it does not show when it saves (R6)', async () => {
    const { a, storage } = await page();
    const peer = 'ffffffff00000001';
    await a.receive({ type: 'bullet_state', v: 1, field: 'composition', sender: 'ffffffffffffffff', snap: '0000000000000001', part: 1, parts: 1, bullets: [['future', 'Hidden rule', peer, 1]], seen: { [peer]: 1 } });
    expect(texts(await a.state('composition'))).toContainEqual(['future', 'Hidden rule']);

    const view = await a.prompts.readView('composition');
    expect(await storage.editShown('composition', view, (shown) => shown.replace('- Strictly follow these instructions in future responses.', '- Strictly follow these instructions.'))).toBe('saved');

    expect(texts(await a.state('composition'))).toContainEqual(['future', 'Hidden rule']);
  });

  it('keeps an edited line outside the bullets in the stored state and the text (DS-SKELETON)', async () => {
    const { a, storage } = await page();
    const view = await a.prompts.readView('composition');
    expect(await storage.editShown('composition', view, (shown) => shown.replace('- Strictly follow these instructions in future responses.', '- Strictly follow these instructions, always.'))).toBe('saved');

    expect(a.store.values['bullet_state:composition'].head).toContain('- Strictly follow these instructions, always.');
    expect(a.store.values[PROMPT_KEYS.composition]).toContain('- Strictly follow these instructions, always.');
    expect(texts(await a.state('composition'))).toEqual(defaults('composition').texts);
  });
});

describe('a line holding a section marker (R23)', () => {
  const markers = ['Keep DO NOT EDIT/DELETE THIS SECTION HEADER here', 'Use ====END USER INSTRUCTIONS==== here'];

  it('is made no bullet by a restore of an entry recorded before', async () => {
    const a = await device('A', 1, new BulletRelay()).start();
    const entry = {
      composition: render('composition', { ...builtInSkeleton('composition'), bullets: [{ section: 'general', text: 'Plain style rule' }, ...markers.map((text) => ({ section: 'general', text }))] }),
      action: render('action', { ...builtInSkeleton('action'), bullets: [{ section: 'delete', text: 'Plain action rule' }, ...markers.map((text) => ({ section: 'delete', text }))] }),
      templatesJSON: '[]',
    };

    await a.sync.restoreFromHistory(entry);

    for (const [field, plain] of [['composition', 'Plain style rule'], ['action', 'Plain action rule']]) {
      const shown = texts(await a.state(field)).map(([, text]) => text);
      expect(shown).toContain(plain);
      expect(shown.filter((text) => text.includes('DO NOT EDIT') || text.includes('====END'))).toEqual([]);
    }
  });

  it('is refused by the prompts page with a plain message, and nothing changes', async () => {
    const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay(), { name: (k) => nameOf(1, k), files: ['prompts/modules/markdown.js', 'prompts/modules/storage.js'] }).start();
    const storage = a.realm.require('prompts/modules/storage.js');
    for (const [field, key] of [['composition', 'general'], ['action', 'delete']]) {
      const before = structuredClone(a.store.values);
      for (const line of ['Keep DO NOT EDIT/DELETE THIS SECTION HEADER here', 'Use ====END USER INSTRUCTIONS==== here', '====END USER INSTRUCTIONS====']) {
        await expect(storage.addLine(field, await a.prompts.readView(field), { key, copy: 0 }, line)).rejects.toThrow("can't contain");
      }
      expect(a.store.values).toEqual(before);
      expect(await storage.addLine(field, await a.prompts.readView(field), { key, copy: 0 }, 'Plain added rule')).toBe('saved');
      expect(texts(await a.state(field)).map(([, text]) => text)).toContain('Plain added rule');
    }
  });

  // R1: the knowledge base has no sections and no END line, so such a line is a plain kb bullet.
  it('is saved as a plain bullet of the knowledge base', async () => {
    const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay(), { name: (k) => nameOf(1, k), files: ['prompts/modules/markdown.js', 'prompts/modules/storage.js'] }).start();
    const storage = a.realm.require('prompts/modules/storage.js');

    for (const line of ['Keep DO NOT EDIT/DELETE THIS SECTION HEADER here', '====END USER INSTRUCTIONS====']) {
      expect(await storage.addLine('kb', await a.prompts.readView('kb'), { key: '', copy: 0 }, line)).toBe('saved');
    }

    const kb = texts(await a.state('kb')).map(([, text]) => text);
    expect(kb).toContain('Keep DO NOT EDIT/DELETE THIS SECTION HEADER here');
    expect(kb).toContain('====END USER INSTRUCTIONS====');
  });

  // An END line or rule typed in a section would end the rules early, wherever it is typed.
  it.each([
    ['an END line typed in the last section of the writing style', 'composition', 'links', '====END USER INSTRUCTIONS===='],
    ['a rule holding the END marker last in the action rules', 'action', 'none', 'Use ====END USER INSTRUCTIONS==== here'],
    ["an END line typed before the action rules' other sections", 'action', 'delete', '====END USER INSTRUCTIONS===='],
  ])('is refused by the prompts page: %s', async (_, field, key, line) => {
    const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay(), { name: (k) => nameOf(1, k), files: ['prompts/modules/markdown.js', 'prompts/modules/storage.js'] }).start();
    const storage = a.realm.require('prompts/modules/storage.js');
    const view = await a.prompts.readView(field);
    const before = structuredClone(a.store.values);

    await expect(storage.addLine(field, view, { key, copy: 0 }, line)).rejects.toThrow("can't contain");

    expect(a.store.values).toEqual(before);
  });

  // An edit that would make a marked line a rule (the END rule removed before it) is refused whole by
  // the store, not saved without that line.
  it('refuses an edit of the prompts page that would make a marked line a rule, with nothing changed', async () => {
    const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay(), { name: (k) => nameOf(1, k), files: ['prompts/modules/markdown.js', 'prompts/modules/storage.js'] }).start();
    const storage = a.realm.require('prompts/modules/storage.js');
    const view = await a.prompts.readView('action');
    const before = structuredClone(a.store.values);

    await expect(storage.editShown('action', view, (shown) => shown.replace('# Emails to be marked as `archive` (DO NOT EDIT/DELETE THIS SECTION HEADER)', '# Emails to be marked as `archive` (DO NOT EDIT/DELETE THIS SECTION HEADER)\n- Keep DO NOT EDIT/DELETE THIS SECTION HEADER here'))).rejects.toThrow("can't contain");

    expect(a.store.values).toEqual(before);
  });
});

// DS-AI: a writer that asks a model reads in one hold of the prompt semaphore and writes in another with the
// change counter its read returned; any accepted change of the device in between refuses that write.
describe('an AI write read before another write (DS-AI)', () => {
  it('a write read before any other write of the device is refused; one read after it is saved', async () => {
    const relay = new BulletRelay();
    const a = await device('A', 1, relay).start();
    await a.connect();
    await a.add('kb', '', 'Own note');
    const kb = await a.prompts.readBeforeAI('kb', 'refine');

    await a.add('composition', 'general', 'Typed rule');

    await expect(a.prompts.writeAfterRead('kb', kb, `${kb.content}\n- Refined note`, 'refine')).rejects.toMatchObject({ changed: true });
    expect(texts(await a.state('kb'))).not.toContainEqual(['', 'Refined note']);
    const again = await a.prompts.readBeforeAI('kb', 'refine');
    expect(await a.prompts.writeAfterRead('kb', again, `${again.content}\n- Refined note`, 'refine')).toEqual({ outcome: 'saved' });
    expect(texts(await a.state('kb'))).toContainEqual(['', 'Refined note']);
  });
});

describe("the prompts page's reset (DS-RESET)", () => {
  it('resets the knowledge base alone to its defaults, under a new writer name, and sends it', async () => {
    const relay = new BulletRelay();
    const a = await device('A', 1, relay).start();
    await a.connect();
    await a.add('kb', '', 'Own note');
    await a.add('composition', 'general', 'Own rule');
    await a.add('action', 'delete', 'Own action rule');
    const before = { composition: texts(await a.state('composition')), action: texts(await a.state('action')) };
    const sent = relay.sent('A', 'kb');

    await a.reset('kb');

    expect(texts(await a.state('kb'))).toEqual(defaults('kb').texts);
    expect(texts(await a.state('composition'))).toEqual(before.composition);
    expect(texts(await a.state('action'))).toEqual(before.action);
    expect(relay.sent('A', 'kb')).toBeGreaterThan(sent);
    expect(bulletParts(relay, 'A', 'kb').at(-1).bullets.map(([, text]) => text).sort()).toEqual(defaults('kb').texts.map(([, text]) => text));
    await a.add('kb', '', 'After the reset');
    const added = (await a.state('kb')).bullets.find((bullet) => bullet.text === 'After the reset');
    expect(added.name).toBe(nameOf(1, 2));
  });
});

describe("the add-on's own writer names (DS-NAME)", () => {
  // Nothing injected: independent devices, one restarted and one copied from another's store, each add
  // under a name of their own, so every addition reaches every device.
  it("keep every device's additions, after a restart and from a copy", async () => {
    const relay = new BulletRelay();
    const a = await new BulletDevice('A', new DeviceStore(), relay).start();
    const b = await new BulletDevice('B', new DeviceStore(), relay).start();
    await b.add('kb', '', 'Second note');
    await a.add('kb', '', 'First note');
    const copy = await new BulletDevice('C', a.store.copy(), relay).start();
    await copy.add('kb', '', 'Copied note');
    await b.restart();
    await b.add('kb', '', 'After restart');

    for (const device of [a, b, copy]) await device.connect();
    await quiesce(relay);

    for (const device of [a, b, copy]) {
      const shown = texts(await device.state('kb')).map(([, text]) => text).filter((text) => text.endsWith('note') || text === 'After restart');
      expect(shown.sort()).toEqual(['After restart', 'Copied note', 'First note', 'Second note']);
    }
  });
});

describe('the prompt store route', () => {
  it.each(['read', 'write'])('refuses %s of a field that is not one of the three, inside a hold, and writes nothing', async (op) => {
    const a = await device('A', 1, new BulletRelay()).start();
    await a.prompts.readText('kb');
    const before = structuredClone(a.store.values);

    const replies = await a.prompts.withPromptStore(async () => {
      const message = { command: 'prompt-store', op, token: a.prompts.holder.token, captured: [], content: '- Synthetic template' };
      return [await a.prompts.handlePromptStoreMessage({ ...message, field: 'templates' }), await a.prompts.handlePromptStoreMessage({ ...message, field: 'kb' })];
    });

    expect(replies[0].ok).toBe(false);
    // The control: the same message for one of the three is answered.
    expect(replies[1].ok).toBe(true);
    if (op === 'read') expect(a.store.values).toEqual(before);
    else expect(a.store.values['bullet_state:templates']).toBeUndefined();
  });
});

describe('what is sent (DS-SEEN-OUT)', () => {
  it('does not grow with the snapshots merged before', async () => {
    const a = await device('A', 1, new BulletRelay()).start();
    const sent = async () => {
      const outgoing = await a.prompts.outgoingBulletState('kb');
      expect(outgoing.kind).toBe('messages');
      return outgoing.messages.map((message) => ({ ...message, snap: '' }));
    };
    const empty = await sent();
    // The knowledge base's defaults: its own bullets.
    const ownNames = empty.flatMap((message) => Object.keys(message.seen));
    expect(ownNames.length).toBeGreaterThan(0);
    for (let round = 1; round <= 30; round += 1) {
      const writer = nameOf(100 + round, 1);
      const snapshot = (snap, bullets) => ({ type: 'bullet_state', v: 1, field: 'kb', sender: 'ffffffffffffffff', snap, part: 1, parts: 1, bullets, seen: { [writer]: 1 } });
      expect(await a.receive(snapshot(`${round}-add`, [['', `Fact ${round}`, writer, 1]]))).toMatchObject({ kind: 'merged', changed: true });
      expect(new Set((await sent()).flatMap((message) => Object.keys(message.seen)))).toEqual(new Set([...ownNames, writer]));
      expect(await a.receive(snapshot(`${round}-delete`, []))).toMatchObject({ kind: 'merged', changed: true });
      expect(await sent()).toEqual(empty);
    }
  });
});

describe('a refused part (R19)', () => {
  /** R19 discards by (sender, field) only when the refused part's sender is a string: an array of that
   * sender's id reads as the same key, and is not that sender. */
  it('whose sender is not a string drops no snapshot', async () => {
    const a = await device('A', 1, new BulletRelay()).start();
    const peer = 'ffffffff00000001';
    const part = (snap, index, text, extra = {}) => ({
      type: 'bullet_state', v: 1, field: 'kb', sender: 'ffffffffffffffff', snap, part: index, parts: 2, bullets: [['', text, peer, index]], seen: { [peer]: 2 }, ...extra,
    });

    expect(await a.receive(part('0000000000000001', 1, 'Gamma'))).toEqual({ kind: 'partial' });
    expect((await a.receive(part('0000000000000002', 1, 'Other', { v: 2, sender: ['ffffffffffffffff'] }))).kind).toBe('invalid');
    expect(await a.receive(part('0000000000000001', 2, 'Delta'))).toMatchObject({ kind: 'merged', changed: true });

    expect(texts(await a.state('kb'))).toEqual(expect.arrayContaining([['', 'Gamma'], ['', 'Delta']]));
  });
});

describe('a field in many parts (DS-CHUNK)', () => {
  it('keeps every part within the budget at ten parts or more, whatever the budget', async () => {
    const store = new DeviceStore();
    storeStates(store, { kb: { bullets: Array.from({ length: 30 }, (_, i) => ['', `Fact number ${i + 1} of thirty`, nameOf(9, 1), i + 1]), seen: { [nameOf(9, 1)]: 30 } } });
    const a = await device('A', 1, new BulletRelay(), store).start();
    let most = 0;
    for (let budget = 360; budget <= 440; budget += 1) {
      a.options.budget = budget;
      const outgoing = await a.prompts.engine.outgoing('kb');
      expect(outgoing.kind, `budget ${budget}`).toBe('messages');
      most = Math.max(most, outgoing.messages.length);
      for (const message of outgoing.messages) expect(new TextEncoder().encode(JSON.stringify(message)).length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(outgoing.messages.flatMap((message) => message.bullets).map((bullet) => bullet[1])).toEqual((await a.state('kb')).bullets.map((bullet) => bullet.text));
    }
    expect(most).toBeGreaterThanOrEqual(10);
  });

  // DS-CHUNK buffers parts per (sender, field): two peers' snapshots of one field, their parts
  // interleaved, are both applied.
  it("applies two senders' snapshots of one field whose parts interleave", async () => {
    const a = await device('A', 1, new BulletRelay()).start();
    const part = (sender, peer, index, text) => ({
      type: 'bullet_state', v: 1, field: 'kb', sender, snap: '0000000000000001', part: index, parts: 2, bullets: [['', text, peer, index]], seen: { [peer]: 2 },
    });
    const [first, second] = [['eeeeeeeeeeeeeeee', 'eeeeeeee00000001'], ['dddddddddddddddd', 'dddddddd00000001']];

    expect(await a.receive(part(...first, 1, 'First one'))).toEqual({ kind: 'partial' });
    expect(await a.receive(part(...second, 1, 'Second one'))).toEqual({ kind: 'partial' });
    expect(await a.receive(part(...first, 2, 'First two'))).toMatchObject({ kind: 'merged', changed: true });
    expect(await a.receive(part(...second, 2, 'Second two'))).toMatchObject({ kind: 'merged', changed: true });

    expect(texts(await a.state('kb'))).toEqual(expect.arrayContaining([['', 'First one'], ['', 'First two'], ['', 'Second one'], ['', 'Second two']]));
  });
});

describe('a save stopped at any point (DS-ATOMIC)', () => {
  /** A store that keeps a copy of all it holds after each write and removal: what the add-on finds if
   * it stops right there. */
  class SnapshotStore extends DeviceStore {
    snapshots = [];

    api() {
      const api = super.api();
      const { set, remove } = api.local;
      api.local.set = async (values) => {
        await set(values);
        this.snapshots.push(structuredClone(this.values));
      };
      api.local.remove = async (keys) => {
        await remove(keys);
        this.snapshots.push(structuredClone(this.values));
      };
      return api;
    }
  }

  const stored = (values, field) => {
    const value = values[`bullet_state:${field}`];
    return value && { ...value, bullets: value.bullets.map(([section, text, name, n]) => ({ section, text, name, n })) };
  };

  it('leaves every field whole after each write: its labels counted in seen, its text rendered from it, and read back so', async () => {
    const relay = new BulletRelay();
    const store = new SnapshotStore({ [PROMPT_KEYS.kb]: '- Alpha\n- Beta' });
    const a = await device('A', 1, relay, store).start();
    const b = await device('B', 2, relay).start();
    await a.connect();
    await b.connect();
    await quiesce(relay);
    await b.add('kb', '', 'Gamma');
    await b.add('composition', 'general', 'Peer rule');
    await quiesce(relay);
    await a.add('composition', 'language', 'Own rule');
    await a.delete('kb', '', 'Beta');
    await a.reset('action');
    await quiesce(relay);
    expect(texts(await a.state('kb'))).toEqual(expect.arrayContaining([['', 'Alpha'], ['', 'Gamma']]));
    expect(texts(await a.state('kb'))).not.toContainEqual(['', 'Beta']);
    expect(texts(await a.state('composition'))).toContainEqual(['general', 'Peer rule']);
    expect(store.snapshots.length).toBeGreaterThan(5);

    for (const [index, values] of store.snapshots.entries()) {
      const restarted = await device(`R${index}`, 3, new BulletRelay(), new DeviceStore(values)).start();
      for (const field of SYNC_FIELDS) {
        const state = stored(values, field);
        if (state === undefined) continue;
        for (const bullet of state.bullets) expect(state.seen[bullet.name] ?? 0, `${field} ${bullet.name} at write ${index}`).toBeGreaterThanOrEqual(bullet.n);
        expect(values[PROMPT_KEYS[field]], `${field} at write ${index}`).toBe(render(field, state));
        expect((await restarted.state(field)).bullets, `${field} read back at write ${index}`).toEqual(state.bullets);
      }
    }
  });
});

describe('the default catalog', () => {
  it.each(SYNC_FIELDS)('is %s\'s bundled text: its defaults render it, each line trimmed (R2)', (field) => {
    const bundled = readFileSync(new URL(`../prompts/user_${field}.md`, import.meta.url), 'utf8');
    const rendered = render(field, defaultState(field, builtInSkeleton(field), defaultCatalog));
    expect(rendered).toBe(bundled.split('\n').map((line) => (line.startsWith('- ') ? line.trimEnd() : line)).join('\n'));
    expect(parse(field, bundled).bullets.map((bullet) => [bullet.section, bullet.text])).toEqual(defaultCatalog.defaults.filter((entry) => entry.field === field).map((entry) => [entry.section, entry.text]));
  });
});
