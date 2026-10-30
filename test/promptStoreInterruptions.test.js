/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptStoreInterruptions.test.js — on simulated devices running the real promptStore.js and deviceSync.js:
// every commit that saved a change moves the counter, so an AI write read before it is refused, and one that
// saved nothing leaves it (DS-COUNTER, DS-AI); a received message waiting when its connection ends is
// dropped, messages waiting as busy are each applied in arrival order, and more waiting than the bound
// renews the connection (DS-RECEIVE); a reset and a merge record the state they replace (DS-HISTORY); a
// history read or write in a hold that ran past its lease saves nothing then, and does the next time
// (DS-LEASE); signed out, startup reads the texts (DS-DEVICE).

import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, PROMPT_KEYS } from './support/bulletDevices.js';

async function devices(options = {}) {
  const relay = new BulletRelay();
  const a = await new BulletDevice('A', new DeviceStore(), relay, options).start();
  const b = await new BulletDevice('B', new DeviceStore(), relay, options).start();
  return { relay, a, b };
}

async function connected(options = {}) {
  const { relay, a, b } = await devices({ retries: 2, busyReapplyMs: 20, ...options });
  await a.connect();
  await b.connect();
  await flush(relay);
  return { relay, a, b };
}

async function flush(relay) {
  while (await relay.deliverOldest()) { /* every pending part */ }
}

/** A promise and the function that settles it. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

/** Holds `d`'s semaphore until the returned `open()`. */
async function holdOn(d, label = 'a slow writer') {
  const { promise, open } = gate();
  let held = false;
  const done = d.prompts.withPromptStore(async () => {
    held = true;
    await promise;
  }, { label });
  await vi.waitFor(() => expect(held).toBe(true), { interval: 1 });
  return { open, done };
}

const texts = async (d, field = 'kb') => (await d.state(field)).bullets.map((bullet) => bullet.text);

describe('every commit that saved a change moves the counter: an AI write read before it is refused', () => {
  it("a peer's state that adds a note; one with nothing new saves nothing and leaves the counter", async () => {
    const { relay, a, b } = await connected();
    await a.add('kb', '', 'Own note');
    await flush(relay);

    // Nothing new: nothing is saved, so an AI write read before it is saved.
    const unchanged = await a.prompts.readBeforeAI('kb', 'refine');
    const change = a.prompts.change;
    await b.prompts.sendBulletState(['kb']);
    await flush(relay);
    expect(a.prompts.change).toBe(change);
    expect(await a.prompts.writeAfterRead('kb', unchanged, `${unchanged.content}\n- Refined note`, 'refine')).toEqual({ outcome: 'saved' });
    await flush(relay);

    // A peer's note: saved, so an AI write read before it is refused.
    const read = await a.prompts.readBeforeAI('kb', 'refine');
    await b.add('kb', '', 'Peer note');
    await flush(relay);
    expect(await texts(a)).toContain('Peer note');
    expect(a.prompts.change).not.toBe(read.change);
    await expect(a.prompts.writeAfterRead('kb', read, `${read.content}\n- Second refined note`, 'refine')).rejects.toMatchObject({ changed: true });
    expect(await texts(a)).not.toContain('Second refined note');
  });

  it("a released device's texts that add a note", async () => {
    const { a } = await connected();
    const read = await a.prompts.readBeforeAI('kb', 'refine');

    await a.receive({ type: 'prompt_state', data: { kb: '- Released device note', kb_updated_at: new Date().toISOString() } });

    expect(await texts(a)).toContain('Released device note');
    await expect(a.prompts.writeAfterRead('kb', read, `${read.content}\n- Refined note`, 'refine')).rejects.toMatchObject({ changed: true });
  });

  it('a history restore, which first records the state it replaces', async () => {
    const { a } = await devices();
    await a.add('kb', '', 'Before the restore');
    const read = await a.prompts.readBeforeAI('kb', 'refine');

    await a.restore({ kb: '- Restored note' });

    expect(await texts(a)).toEqual(['Restored note']);
    const replaced = a.store.values.prompt_history.filter((entry) => entry.source === 'reset');
    expect(replaced.at(-1).kb).toContain('Before the restore');
    await expect(a.prompts.writeAfterRead('kb', read, `${read.content}\n- Refined note`, 'refine')).rejects.toMatchObject({ changed: true });
  });
});

describe('a message refused as busy on a connection that ended', () => {
  it('a message refused as busy on a connection that ended, though a new one began before the semaphore freed', async () => {
    const { relay, a, b } = await connected({ busyReapplyMs: 20 });
    const { open, done } = await holdOn(a, 'a long writer');
    await b.add('kb', '', 'Peer note');
    const toA = relay.pending.filter((entry) => entry.to === 'A');
    // Delivered without waiting: a part refused as busy keeps its delivery waiting, as its socket's handler.
    const delivering = Promise.all(toA.map((entry) => relay.deliver(entry.snapshot.id, 'A', entry.part)));
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true), { timeout: 2000 });

    await a.disconnect();
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('was dropped: its connection ended'))).toBe(true), { timeout: 2000 });
    // The new connection's own send waits for the holder like any other message.
    const reconnecting = a.connect();
    open();
    await done;
    await Promise.all([reconnecting, delivering]);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await texts(a)).not.toContain('Peer note');
    // B's next connect sends its state again, which brings it.
    await b.disconnect();
    await b.connect();
    await flush(relay);
    await vi.waitFor(async () => expect(await texts(a)).toContain('Peer note'), { timeout: 2000 });
  });
});

describe("a released device's messages refused as busy", () => {
  it('are each applied again, in arrival order: none replaces another', async () => {
    const { a } = await connected();
    const { open, done } = await holdOn(a, 'a long writer');
    const now = new Date().toISOString();
    const first = a.receive({ type: 'prompt_state', data: { kb: '- First released note', kb_updated_at: now } });
    const second = a.receive({ type: 'prompt_state', data: { kb: '- Second released note', kb_updated_at: now } });
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true), { timeout: 2000 });
    expect(await texts(a)).not.toContain('First released note');
    open();
    await done;
    await Promise.all([first, second]);

    await vi.waitFor(async () => expect(await texts(a)).toEqual(expect.arrayContaining(['First released note', 'Second released note'])), { timeout: 2000 });
  });
});

describe('a reset and a merge record the state they replace (DS-HISTORY)', () => {
  const history = (d, source) => (d.store.values.prompt_history ?? []).filter((entry) => entry.source === source);

  it('a whole-field reset records the text it replaced, before its commit', async () => {
    const { a } = await devices();
    await a.add('kb', '', 'Before the reset');

    await a.reset('kb');

    expect(await texts(a)).not.toContain('Before the reset');
    expect(history(a, 'reset').at(-1)).toMatchObject({ fields: ['kb'], kb: expect.stringContaining('Before the reset') });
  });

  it("a peer's merge that changes the text records the text it replaced", async () => {
    const { relay, a, b } = await connected();
    await a.add('kb', '', 'Own note');
    await flush(relay);
    await b.add('kb', '', 'Peer note');
    await flush(relay);

    expect(await texts(a)).toContain('Peer note');
    const entry = history(a, 'sync_receive').at(-1);
    expect(entry.fields).toContain('kb');
    expect(entry.kb).toContain('Own note');
    expect(entry.kb).not.toContain('Peer note');
  });
});

describe('more received messages waiting than the bound (DS-RECEIVE)', () => {
  it('renews the connection: the waiting ones are dropped, and a peer state sent on the new connection lands', async () => {
    const { relay, a, b } = await connected({ maxWaitingReceives: 2 });
    const { open, done } = await holdOn(a, 'a long writer');
    const now = new Date().toISOString();
    // Not awaited: each waits for the holder, as its socket's handler would.
    const waiting = ['First', 'Second'].map((name) => a.receive({ type: 'prompt_state', data: { kb: `- ${name} waiting note`, kb_updated_at: now } }));
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true), { timeout: 2000 });
    const past = a.receive({ type: 'prompt_state', data: { kb: '- Past the bound note', kb_updated_at: now } });

    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('received messages are waiting: the connection is renewed'))).toBe(true), { timeout: 2000 });
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('was dropped: its connection ended'))).toBe(true), { timeout: 2000 });
    open();
    await done;
    await Promise.all([...waiting, past]);
    await vi.waitFor(() => expect(relay.isConnected('A')).toBe(true), { timeout: 2000 });
    for (const name of ['First waiting note', 'Second waiting note', 'Past the bound note']) expect(await texts(a)).not.toContain(name);

    await b.add('kb', '', 'Peer note on the new connection');
    await flush(relay);
    await vi.waitFor(async () => expect(await texts(a)).toContain('Peer note on the new connection'), { timeout: 2000 });
  });
});

describe('while nobody is signed in, startup reads the texts as when signed in (DS-DEVICE)', () => {
  it("a released version's texts are read", async () => {
    const store = new DeviceStore({ [PROMPT_KEYS.kb]: '- Released note', device_sync_auto_enabled: true });
    const d = new BulletDevice('A', store, new BulletRelay());
    delete store.values.supabaseSession;

    await d.start();

    expect(await d.prompts.readText('kb')).toContain('Released note');
  });
});

vi.setConfig({ testTimeout: 20000 });

describe('the prompt history read in a hold that runs past its lease (DS-LEASE)', () => {
  /** `d`'s first read of `key` after this is paused, its result already copied, until `open()`. */
  function pauseAfterRead(d, key) {
    const get = d.realm.context.browser.storage.local.get;
    const stop = gate();
    const state = { paused: false, open: stop.open };
    d.realm.context.browser.storage.local.get = async (keys) => {
      const snapshot = await get(keys);
      if (keys === key && !state.paused) {
        state.paused = true;
        await stop.promise;
      }
      return snapshot;
    };
    return state;
  }

  it('history already read is refused as changed when the hold ran past its lease, and kept', async () => {
    const { a } = await devices({ leaseMs: 40 });
    await a.add('kb', '', 'History note');
    await a.prompts.withPromptStore((store) => store.recordHistory('local_edit', ['kb']));
    expect((await a.sync.loadHistory()).at(-1).kb).toContain('History note');
    const pause = pauseAfterRead(a, 'prompt_history');
    const reading = a.sync.loadHistory().then((value) => ({ value }), (error) => ({ changed: error.changed === true }));
    try {
      await vi.waitFor(() => expect(pause.paused).toBe(true));
      await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('past its lease'))).toBe(true), { timeout: 2000 });
    } finally {
      pause.open();
    }
    expect(await reading).toEqual({ changed: true });
    expect(a.store.values.prompt_history.at(-1).kb).toContain('History note');
  });

  it("a released version's backups are not saved as history once the hold ran past its lease, and are the next time", async () => {
    const backups = { device_sync_backups: [{ source: 'sync_receive', backedUpAt: new Date().toISOString(), state: { kb: '- A released backup note' } }] };
    const a = await new BulletDevice('A', new DeviceStore(backups), new BulletRelay(), { leaseMs: 40 }).start();
    const pause = pauseAfterRead(a, 'prompt_history');
    const reading = a.sync.loadHistory().catch(() => []);
    try {
      await vi.waitFor(() => expect(pause.paused).toBe(true));
      await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('past its lease'))).toBe(true), { timeout: 2000 });
    } finally {
      pause.open();
    }
    await reading;
    expect(a.store.values.prompt_history).toBeUndefined();
    expect((await a.sync.loadHistory())[0].kb).toContain('A released backup note');
  });
});
