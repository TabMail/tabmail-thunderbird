/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptSemaphore.test.js — the one prompt semaphore of a device (DS-SEMAPHORE), on simulated devices running
// the real promptStore.js: `withPromptStore` is the only way to read or change the knowledge base, the
// writing style and the action rules. It never blocks forever (released on every exit, a lease, no nested
// hold, a bounded wait in line), callers get it in the order they asked, and a sign-out or sign-in never waits for it and never reaches it. Nothing is per
// account (DS-DEVICE): signed out, the prompts are read and written as when signed in, a sign-out or a
// different account's sign-in deletes nothing, and work pending across one is saved like any other.

import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, PROMPT_KEYS, SIGNED_IN } from './support/bulletDevices.js';

const HISTORY = 'prompt_history';
/** A timer can fire up to this much before `Date.now()` shows its delay passed. */
const TIMER_SLACK_MS = 2;

async function device(options = {}) {
  const relay = new BulletRelay();
  const a = await new BulletDevice('A', new DeviceStore(), relay, options).start();
  const b = await new BulletDevice('B', new DeviceStore(), relay, options).start();
  return { relay, a, b };
}

/** A promise and the function that settles it. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

/** Holds `d`'s semaphore until the returned `open()`; `held` resolves once it is held. */
async function holdOn(d, label = 'a slow writer') {
  const { promise, open } = gate();
  let store;
  const done = d.prompts.withPromptStore(async (hold) => {
    store = hold;
    await promise;
  }, { label });
  await vi.waitFor(() => expect(store).toBeDefined(), { interval: 1 });
  return { open, done, store: () => store };
}

/** Signs `d` out as supabaseAuth's signOut does: the session removed, then Device Sync closed. The prompt
 * store is not reached, and nothing else is removed. */
async function signOut(d) {
  delete d.store.values.supabaseSession;
  await d.sync.cleanupDeviceSync();
}

/** Signs `d` in, to any account, as supabaseAuth's sign-in does: the session stored. */
async function signIn(d) {
  d.store.values.supabaseSession = structuredClone(SIGNED_IN);
}

/** Delivers every pending part, oldest first, without waiting for it: a part refused as busy keeps the
 * delivery that carried it waiting, as its socket's handler does, until it applies or its connection ends. */
function deliverAll(relay) {
  return (async () => { while (await relay.deliverOldest()) { /* each in arrival order */ } })();
}

/** What `d` stores, its session aside. */
function storedState(d) {
  const { supabaseSession, ...rest } = structuredClone(d.store.values);
  return rest;
}

describe('the prompt semaphore never blocks forever', () => {
  it('is released however the body ends: returned, thrown, or refused by the background', async () => {
    const { a } = await device();
    await a.prompts.withPromptStore(async (store) => store.read('kb'));
    expect(a.prompts.holder).toBeNull();
    await expect(a.prompts.withPromptStore(async () => { throw new Error('synthetic body failure'); })).rejects.toThrow('synthetic body failure');
    expect(a.prompts.holder).toBeNull();
    await expect(a.prompts.withPromptStore((store) => store.writeAI('kb', { captured: [] }, '- Note'))).rejects.toThrow('an AI write needs the change counter its read returned');
    expect(a.prompts.holder).toBeNull();
    await expect(a.prompts.withPromptStore(async () => {
      const reply = await a.prompts.handlePromptStoreMessage({ command: 'prompt-store', op: 'read', token: a.prompts.holder.token, field: 'templates' });
      if (!reply.ok) throw new Error(`refused by the background: ${reply.error}`);
    })).rejects.toThrow('refused by the background');
    expect(a.prompts.holder).toBeNull();
    // The next caller acquires it at once, with nobody left in line.
    await a.prompts.withPromptStore((store) => store.read('kb'));
    expect(a.prompts.waiting).toEqual([]);
  });

  it('a hold that ends cannot be used again', async () => {
    const { a } = await device();
    let kept;
    await a.prompts.withPromptStore(async (store) => { kept = store; });
    await expect(kept.read('kb')).rejects.toThrow('the prompt store was used after its hold ended (read)');
  });

  // A lease expiry is no change of the device (DS-COUNTER): it ends the stuck holder's hold, not the work
  // of others, so an AI write read before it is saved.
  it('a holder past its lease loses the semaphore: its write is refused, and an AI write read before it is saved', async () => {
    const { a } = await device({ leaseMs: 30 });
    await a.add('kb', '', 'Own note');
    const before = await a.prompts.readBeforeAI('kb', 'refine');
    const { open, done, store } = await holdOn(a);
    const read = await store().read('kb');
    await vi.waitFor(() => expect(a.prompts.holder).toBeNull(), { timeout: 2000 });
    expect(a.logs.some(({ level, message }) => level === 'error' && message.includes('held the prompt semaphore past its lease'))).toBe(true);

    await expect(store().write('kb', read.captured, `${read.content}\n- Late note`)).rejects.toMatchObject({ changed: true });
    open();
    await done;
    expect(await a.prompts.writeAfterRead('kb', before, `${before.content}\n- Refined note`, 'refine')).toEqual({ outcome: 'saved' });
    const texts = (await a.state('kb')).bullets.map((bullet) => bullet.text);
    expect(texts).toContain('Own note');
    expect(texts).not.toContain('Late note');
    expect(texts).toContain('Refined note');
  });

  it('a call inside a hold waits its wait in line and is refused as busy; the outer hold goes on and is released', async () => {
    const { a } = await device({ acquireWaitMs: 30 });
    const outcome = await a.prompts.withPromptStore(async (store) => {
      const started = Date.now();
      const inner = await a.prompts.withPromptStore((nested) => nested.read('kb')).catch((e) => e);
      const waited = Date.now() - started;
      const after = await store.read('kb');
      return { inner, waited, after };
    }, { label: 'outer' });
    expect(outcome.inner).toMatchObject({ busy: true, message: 'the prompt store is busy (outer)' });
    expect(outcome.waited).toBeGreaterThanOrEqual(30 - TIMER_SLACK_MS);
    expect(outcome.after.captured).not.toBeNull();
    expect(a.prompts.holder).toBeNull();
    expect(a.prompts.waiting).toEqual([]);
  });

  it('a waiting call gets the semaphore as soon as the holder lets go, within its wait', async () => {
    const { a } = await device({ acquireWaitMs: 2000 });
    const { open, done } = await holdOn(a);
    const waiting = a.prompts.withPromptStore((store) => store.text('kb'), { label: 'waiting reader' });
    await vi.waitFor(() => expect(a.prompts.waiting.map(({ label }) => label)).toEqual(['waiting reader']), { interval: 1 });
    open();
    await done;
    expect(typeof (await waiting)).toBe('string');
  });

  it('a holder that never lets go makes the others give up after their wait in line, never wait forever', async () => {
    const { a } = await device({ acquireWaitMs: 30 });
    const { open, done } = await holdOn(a, 'a stuck writer');
    const started = Date.now();
    await expect(a.prompts.readText('kb')).rejects.toMatchObject({ busy: true, message: 'the prompt store is busy (a stuck writer)' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30 - TIMER_SLACK_MS);
    expect(a.prompts.waiting).toEqual([]);
    open();
    await done;
  });
});

describe('callers wait in line for the semaphore, first come first served (DS-SEMAPHORE request order)', () => {
  /** Starts `run` and waits until it is the `n`th in line, so the order of asking is fixed. Returns
   * { done }, its promise (wrapped, so awaiting this does not wait for it). */
  async function inLine(d, run, n) {
    const done = run();
    await vi.waitFor(() => expect(d.prompts.waiting).toHaveLength(n), { interval: 1 });
    return { done };
  }

  it('the background, the prompts page and a chat window get it in the order they asked', async () => {
    const { a } = await device({ acquireWaitMs: 4000 });
    const promptsPage = a.page([]).require('agent/modules/promptStore.js');
    const chatWindow = a.page([]).require('agent/modules/promptStore.js');
    const order = [];
    const ask = (prompts, label) => () => prompts.withPromptStore(async () => { order.push(label); }, { label });
    const { open, done } = await holdOn(a);
    const asked = [
      await inLine(a, ask(a.prompts, 'background first'), 1),
      await inLine(a, ask(promptsPage, 'prompts page'), 2),
      await inLine(a, ask(chatWindow, 'chat window'), 3),
      await inLine(a, ask(a.prompts, 'background last'), 4),
    ];
    expect(a.prompts.waiting.map(({ label }) => label)).toEqual(['background first', 'prompts page', 'chat window', 'background last']);
    open();
    await done;
    await Promise.all(asked.map(({ done }) => done));
    expect(order).toEqual(['background first', 'prompts page', 'chat window', 'background last']);
    expect(a.prompts.holder).toBeNull();
    expect(a.prompts.waiting).toEqual([]);
  });

  it('a caller asking as the holder lets go still waits behind the one already in line', async () => {
    const { a } = await device({ acquireWaitMs: 4000 });
    const order = [];
    const { open, done } = await holdOn(a);
    const earlier = await inLine(a, () => a.prompts.withPromptStore(async () => { order.push('earlier'); }, { label: 'earlier' }), 1);
    open();
    await done;
    // Released: the one in line holds it already, so a caller asking now still comes after it.
    const later = a.prompts.withPromptStore(async () => { order.push('later'); }, { label: 'later' });
    await Promise.all([earlier.done, later]);
    expect(order).toEqual(['earlier', 'later']);
  });

  it('a waiter whose wait ran out leaves the line: it is refused as busy and the semaphore goes past it', async () => {
    const { a } = await device({ acquireWaitMs: 40 });
    const { open, done } = await holdOn(a, 'a slow writer');
    const started = Date.now();
    const refused = await a.prompts.withPromptStore(() => 'ran', { label: 'impatient' }).catch((e) => e);
    expect(refused).toMatchObject({ busy: true, message: 'the prompt store is busy (a slow writer)' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40 - TIMER_SLACK_MS);
    expect(a.prompts.waiting).toEqual([]);
    open();
    await done;
    // Free at once, not handed to the caller that already gave up.
    expect(a.prompts.holder).toBeNull();
    expect(await a.prompts.withPromptStore(() => 'ran')).toBe('ran');
  });

  it('a head whose caller has gone loses the semaphore with its lease, and the next in line then gets it', async () => {
    const leaseMs = 50;
    const { a } = await device({ leaseMs, acquireWaitMs: 4000 });
    // Two pages that asked and closed: nobody uses or releases what they are handed.
    const closed = (label) => a.prompts.handlePromptStoreMessage({ command: 'prompt-store', op: 'acquire', label });
    const first = await closed('a closed page');
    expect(first).toMatchObject({ ok: true, outcome: 'acquired' });
    const second = closed('another closed page');
    await vi.waitFor(() => expect(a.prompts.waiting).toHaveLength(1), { interval: 1 });
    const started = Date.now();
    expect(await a.prompts.withPromptStore(() => 'ran', { label: 'live caller' })).toBe('ran');
    expect(Date.now() - started).toBeGreaterThanOrEqual(leaseMs - TIMER_SLACK_MS);
    expect(await second).toMatchObject({ ok: true, outcome: 'acquired' });
    expect(a.logs.filter(({ message }) => message.includes('held the prompt semaphore past its lease')).map(({ message }) => message.split(' held')[0]))
      .toEqual([expect.stringContaining('a closed page'), expect.stringContaining('another closed page')]);
    expect(a.prompts.holder).toBeNull();
  });

  it('a sign-out completes at once while callers wait in line, and they then get the semaphore in order', async () => {
    const { a } = await device({ acquireWaitMs: 4000 });
    await a.connect();
    const order = [];
    const { open, done } = await holdOn(a);
    const asked = [
      await inLine(a, () => a.prompts.withPromptStore(async () => { order.push('first'); }, { label: 'first' }), 1),
      await inLine(a, () => a.prompts.withPromptStore(async () => { order.push('second'); }, { label: 'second' }), 2),
    ];
    await signOut(a);
    expect(a.prompts.waiting.map(({ label }) => label)).toEqual(['first', 'second']);
    open();
    await Promise.all([done, ...asked.map((caller) => caller.done)]);
    expect(order).toEqual(['first', 'second']);
  });
});

describe('a caller whose lease ran out releases nothing when it finally finishes (DS-LEASE)', () => {
  it('the holder after it keeps the semaphore, and the next in line starts only when that holder finishes', async () => {
    const { a } = await device({ leaseMs: 100, acquireWaitMs: 2000 });
    const expired = gate();
    const current = gate();
    let expiredStarted = false;
    let currentStarted = false;
    const events = [];
    const old = a.prompts.withPromptStore(async () => { expiredStarted = true; await expired.promise; }, { label: 'expired caller' });
    await vi.waitFor(() => expect(expiredStarted).toBe(true), { interval: 1 });
    await vi.waitFor(() => expect(a.prompts.holder).toBeNull(), { interval: 2 });
    const now = a.prompts.withPromptStore(async () => { currentStarted = true; events.push('current started'); await current.promise; events.push('current finished'); }, { label: 'current caller' });
    await vi.waitFor(() => expect(currentStarted).toBe(true), { interval: 1 });
    const last = a.prompts.withPromptStore(async () => { events.push('last writer'); }, { label: 'last writer' });
    try {
      expired.open();
      await old.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(events).toEqual(['current started']);
    } finally {
      current.open();
      await Promise.allSettled([old, now, last]);
    }
    expect(events).toEqual(['current started', 'current finished', 'last writer']);
  });
});

describe('a sign-out never waits for the semaphore and never reaches it (DS-DEVICE)', () => {
  it('completes while a holder never lets go, deletes nothing, and the holder goes on and saves', async () => {
    const { a } = await device();
    await a.connect();
    await a.add('kb', '', 'Old account note');
    const { open, done, store } = await holdOn(a, 'a stuck writer');
    const read = await store().read('kb');

    await signOut(a);
    expect(a.prompts.holder).not.toBeNull();
    expect(a.store.values[PROMPT_KEYS.kb]).toContain('Old account note');

    await signIn(a);
    expect(await store().write('kb', read.captured, `${read.content}\n- Late note`)).toEqual({ outcome: 'saved' });
    open();
    await done;
    const texts = (await a.state('kb')).bullets.map((bullet) => bullet.text);
    expect(texts).toEqual(expect.arrayContaining(['Old account note', 'Late note']));
  });
});

describe('while nobody is signed in, the prompts are read and written as when signed in (DS-DEVICE)', () => {
  it('reads, edits, resets, restores and loads the history through the one API', async () => {
    const { a } = await device();
    await a.add('kb', '', 'Kept note');
    await a.add('composition', 'general', 'Kept rule');
    await signOut(a);

    expect(await a.prompts.readText('kb')).toContain('Kept note');
    expect(await a.prompts.readText('composition')).toContain('Kept rule');
    const read = await a.prompts.readBeforeAI('kb', 'refine');
    expect((await a.prompts.writeAfterRead('kb', read, `${read.content}\n- Signed-out note`, 'refine')).outcome).toBe('saved');
    expect(await a.prompts.readText('kb')).toContain('Signed-out note');
    await a.prompts.withPromptStore((store) => store.restore({ kb: '- Restored note' }));
    expect(await a.prompts.readText('kb')).toContain('Restored note');
    expect(Array.isArray(await a.sync.loadHistory())).toBe(true);
    await a.prompts.withPromptStore((store) => store.reset(['composition']));
    expect(await a.prompts.readText('composition')).not.toContain('Kept rule');
    expect(a.prompts.holder).toBeNull();
  });
});

describe('a sign-out or a sign-in deletes nothing, whichever account signs in (DS-DEVICE)', () => {
  it('keeps the texts, the bullet labels, the seen map, the history and the writer name', async () => {
    const { a, b } = await device();
    await a.connect();
    await b.connect();
    await b.add('kb', '', 'Peer note');
    await a.add('kb', '', 'Own note');
    a.store.values[HISTORY] = [{ id: 'h1', kb: '- Own note', composition: '', action: '', templatesJSON: '[]' }];
    const before = storedState(a);
    const state = await a.state('kb');
    const names = a.names;

    await signOut(a);
    expect(storedState(a)).toEqual(before);
    await signIn(a);
    expect(storedState(a)).toEqual(before);
    expect(await a.state('kb')).toEqual(state);

    // The writer name is kept: the next bullet is this writer's next, no fresh name taken.
    await a.add('kb', '', 'Note after the sign-in');
    expect(a.names).toBe(names);
    const own = (await a.state('kb')).bullets.filter((bullet) => bullet.text === 'Own note' || bullet.text === 'Note after the sign-in');
    expect(new Set(own.map((bullet) => bullet.name)).size).toBe(1);
  });

  // DS-COUNTER: sign-in and sign-out don't move the change counter, so a late AI result is ordinary device
  // data. The control: an edit in between does refuse it.
  it('saves a late AI result read before a sign-out, and one read before a sign-in, keeping the texts', async () => {
    const { a } = await device();
    await a.add('kb', '', 'Kept note');
    for (const [change, label] of [[signOut, 'after a sign-out'], [signIn, 'after a sign-in']]) {
      const read = await a.prompts.readBeforeAI('kb', 'refine');
      await change(a);
      expect(await a.prompts.writeAfterRead('kb', read, `${read.content}\n- Late refine ${label}`, 'refine')).toEqual({ outcome: 'saved' });
      expect(await a.prompts.readText('kb')).toContain('Kept note');
      expect(await a.prompts.readText('kb')).toContain(`Late refine ${label}`);
    }
    const read = await a.prompts.readBeforeAI('kb', 'refine');
    await a.add('kb', '', 'Edit in between');
    await expect(a.prompts.writeAfterRead('kb', read, `${read.content}\n- Refused refine`, 'refine')).rejects.toMatchObject({ changed: true });
    expect(await a.prompts.readText('kb')).not.toContain('Refused refine');
  });
});

// DS-RECEIVE: a received message whose apply found the semaphore held through every try is not lost: it is
// applied again once the semaphore is free, with both devices still connected and nobody editing, and every
// message received after it waits behind it.
describe('a sync message received while the semaphore stays busy', () => {
  async function connected(options) {
    const { relay, a, b } = await device({ acquireWaitMs: 5, busyReapplyMs: 20, ...options });
    await a.connect();
    await b.connect();
    while (await relay.deliverOldest()) { /* the connect exchange */ }
    return { relay, a, b };
  }
  const texts = async (d) => (await d.state('kb')).bullets.map((bullet) => bullet.text);

  it('is applied again when the semaphore frees, with no reconnect and no edit', async () => {
    const { relay, a, b } = await connected();
    const { open, done } = await holdOn(a, 'a long writer');
    await b.add('kb', '', 'Peer note');
    const delivered = deliverAll(relay);
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true), { timeout: 2000 });
    expect(await texts(a)).not.toContain('Peer note');

    open();
    await done;
    await delivered;
    await vi.waitFor(async () => expect(await texts(a)).toContain('Peer note'), { timeout: 2000 });
    // A's merge sends its state on, so both hold the same.
    await deliverAll(relay);
    expect((await texts(b)).sort()).toEqual((await texts(a)).sort());
  });

  it('keeps trying while the semaphore stays busy, then applies', async () => {
    const { relay, a, b } = await connected();
    const { open, done } = await holdOn(a, 'a long writer');
    await b.add('kb', '', 'Peer note');
    const delivered = deliverAll(relay);
    await vi.waitFor(() => expect(a.logs.filter(({ message }) => message.includes('is applied again shortly')).length).toBeGreaterThan(2), { timeout: 2000 });
    expect(await texts(a)).not.toContain('Peer note');
    open();
    await done;
    await delivered;
    await vi.waitFor(async () => expect(await texts(a)).toContain('Peer note'), { timeout: 2000 });
  });

  it("a newer snapshot from the same peer waits behind the older one, and both peers' notes arrive", async () => {
    const { relay, a, b } = await connected();
    const { open, done } = await holdOn(a, 'a long writer');
    await b.add('kb', '', 'First peer note');
    const first = deliverAll(relay);
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true), { timeout: 2000 });
    await b.add('kb', '', 'Second peer note');
    const second = deliverAll(relay);
    open();
    await done;
    await Promise.all([first, second]);
    await deliverAll(relay);
    await vi.waitFor(async () => expect(await texts(a)).toEqual(expect.arrayContaining(['First peer note', 'Second peer note'])), { timeout: 2000 });
  });

  it('is dropped when the connection ends: the next connect sends every state again', async () => {
    const { relay, a, b } = await connected();
    const { open, done } = await holdOn(a, 'a long writer');
    await b.add('kb', '', 'Peer note');
    const delivered = deliverAll(relay);
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true), { timeout: 2000 });
    await a.disconnect();
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('was dropped: its connection ended'))).toBe(true), { timeout: 2000 });
    open();
    await done;
    await delivered;
    expect(await texts(a)).not.toContain('Peer note');
    await a.connect();
    await b.disconnect();
    await b.connect();
    await deliverAll(relay);
    expect(await texts(a)).toContain('Peer note');
  });

  it("a released device's message refused as busy is applied again whole, with nothing half applied first", async () => {
    const { a } = await connected();
    const { open, done } = await holdOn(a, 'a long writer');
    const received = a.receive({ type: 'prompt_state', data: { kb: '- Released device note', kb_updated_at: new Date().toISOString() } });
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true), { timeout: 2000 });
    expect(await texts(a)).not.toContain('Released device note');
    open();
    await done;
    await received;
    await vi.waitFor(async () => expect(await texts(a)).toContain('Released device note'), { timeout: 2000 });
  });
});

describe('a chunked sync message received while the semaphore stays busy', () => {
  it("an older snapshot's waiting part is applied before a newer snapshot's parts: both complete, with every note", async () => {
    const relay = new BulletRelay();
    const options = { acquireWaitMs: 5, busyReapplyMs: 300, budget: 450 };
    const a = await new BulletDevice('A', new DeviceStore(), relay, options).start();
    const b = await new BulletDevice('B', new DeviceStore(), relay, options).start();
    await a.connect();
    await b.connect();
    while (await relay.deliverOldest()) { /* the connect exchange */ }
    const toA = () => relay.pending.filter((item) => item.to === 'A' && item.snapshot.field === 'kb');

    // The older snapshot's first part is buffered; its second is refused as busy and waits.
    await b.add('kb', '', 'First peer note');
    const older = toA();
    expect(older.length).toBeGreaterThan(1);
    await relay.deliver(older[0].snapshot.id, 'A', older[0].part);
    const { open, done } = await holdOn(a, 'a long writer');
    const waiting = relay.deliver(older[1].snapshot.id, 'A', older[1].part);
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true), { timeout: 2000 });
    open();
    await done;
    relay.drop(older[0].snapshot.id);

    // Before the waiting part is applied again, a newer snapshot starts arriving: its parts wait behind it.
    await b.add('kb', '', 'Second peer note');
    const newer = toA();
    expect(newer.length).toBeGreaterThan(1);
    const rest = deliverAll(relay);
    await Promise.all([waiting, rest]);

    const texts = (await a.state('kb')).bullets.map((bullet) => bullet.text);
    expect(texts).toEqual(expect.arrayContaining(['First peer note', 'Second peer note']));
  });
});
