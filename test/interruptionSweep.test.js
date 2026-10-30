/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// DS-LEASE's invariant at every await: each receive path (a single-part bullet_state, every part of a
// multi-part one, a released device's prompt_state), a history restore and a template reset is held after
// each of its storage reads and writes in turn while its hold runs past its lease. Only the invariant is
// asserted: everything saves, or the work stays retryable and saves later, without a reconnect (a received
// message by itself, DS-RECEIVE; a user's restore or reset when the user does it again).

import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, PROMPT_KEYS } from './support/bulletDevices.js';

const OPTIONS = { leaseMs: 100, acquireWaitMs: 0, busyReapplyMs: 20 };
const WAIT = { timeout: 3000, interval: 10 };
const gate = () => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
};

const kbHas = (store, text) => (store.values[PROMPT_KEYS.kb] ?? '').includes(text);
const compositionHas = (store, text) => (store.values[PROMPT_KEYS.composition] ?? '').includes(text);
const templateIds = (store) => (store.values.user_templates ?? []).map((t) => t.id);

/** Each operation: `setup()` gives { a, others, received, run(), present(store) → { name: bool } }, `run`
 * the operation (it may reject; a user's restore or reset is run again after a refusal). */
const OPERATIONS = {
  'a single-part bullet_state': async () => {
    const relay = new BulletRelay();
    const a = await new BulletDevice('A', new DeviceStore(), relay, OPTIONS).start();
    const b = await new BulletDevice('B', new DeviceStore(), relay).start();
    await a.connect();
    await b.connect();
    while (await relay.deliverOldest());
    await b.add('kb', '', 'Peer note');
    const snapshot = [...relay.snapshots.values()].filter((s) => s.from === 'B' && s.field === 'kb').at(-1);
    relay.drop(snapshot.id);
    return {
      a, others: [b], received: true,
      run: () => relay.deliver(snapshot.id, 'A', 1),
      present: (store) => ({ peer: kbHas(store, 'Peer note') }),
    };
  },
  'every part of a multi-part bullet_state': async () => {
    const relay = new BulletRelay();
    const a = await new BulletDevice('A', new DeviceStore(), relay, OPTIONS).start();
    const b = await new BulletDevice('B', new DeviceStore(), relay, { budget: 480 }).start();
    await a.connect();
    await b.connect();
    while (await relay.deliverOldest());
    const first = `First peer note ${'x'.repeat(180)}`;
    const second = `Second peer note ${'y'.repeat(180)}`;
    await b.add('kb', '', first);
    await b.add('kb', '', second);
    const snapshots = [...relay.snapshots.values()].filter((s) => s.from === 'B' && s.field === 'kb');
    for (const s of snapshots) relay.drop(s.id);
    const snapshot = snapshots.at(-1);
    expect(snapshot.parts.length).toBeGreaterThanOrEqual(2);
    return {
      a, others: [b], received: true,
      run: async () => {
        for (let part = 1; part <= snapshot.parts.length; part += 1) {
          if (!relay.isConnected('A')) return;
          await relay.deliver(snapshot.id, 'A', part);
        }
      },
      present: (store) => ({ first: kbHas(store, first), second: kbHas(store, second) }),
    };
  },
  "a released device's prompt_state": async () => {
    const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay(), OPTIONS).start();
    await a.connect();
    const now = new Date().toISOString();
    const data = {
      kb: '- First legacy note', kb_updated_at: now,
      composition: '# General writing style (DO NOT EDIT/DELETE THIS SECTION HEADER)\n- Second legacy note', composition_updated_at: now,
    };
    return {
      a, others: [], received: true,
      run: () => a.receive({ type: 'prompt_state', data }),
      present: (store) => ({ kb: kbHas(store, 'First legacy note'), composition: compositionHas(store, 'Second legacy note') }),
    };
  },
  'a history restore': async () => {
    const store = new DeviceStore({ user_templates: [{ id: 'initial', name: 'Initial template' }], prompt_history_migrated: true });
    const a = await new BulletDevice('A', store, new BulletRelay(), OPTIONS).start();
    await a.add('kb', '', 'Before restore');
    const entry = { id: 'older-entry', kb: '- Restored knowledge', templatesJSON: JSON.stringify([{ id: 'restored', name: 'Restored template' }]) };
    return {
      a, others: [], received: false,
      run: () => a.sync.restoreFromHistory(entry),
      present: (s) => ({ kb: kbHas(s, 'Restored knowledge'), templates: templateIds(s).includes('restored') }),
    };
  },
  'a template reset': async () => {
    const store = new DeviceStore({ user_templates: [{ id: 'initial', name: 'Initial template' }], prompt_history_migrated: true });
    const a = await new BulletDevice('A', store, new BulletRelay(), OPTIONS).start();
    return {
      a, others: [], received: false,
      run: () => a.sync.resetFieldToDefault('templates', [{ id: 'default', name: 'Default template' }]),
      present: (s) => ({ templates: templateIds(s).includes('default') }),
    };
  },
};

const allSaved = (present) => Object.values(present).every(Boolean);

/** Runs `name` held after its `at`-th storage read or write (0: never held) until its lease ran out;
 * returns the invariant's failure, or null. Also returns how many reads and writes the run made. */
async function attempt(name, at) {
  const op = await OPERATIONS[name]();
  const { a } = op;
  const stop = gate();
  const held = gate();
  let count = 0;
  let armed = true;
  a.store.afterIO = async () => {
    if (!armed) return;
    count += 1;
    if (count !== at) return;
    armed = false;
    held.open();
    await stop.promise;
  };
  let refused = null;
  const running = op.run().catch((e) => { refused = e; });
  let failure = null;
  try {
    if (at > 0) {
      const reached = await Promise.race([held.promise.then(() => true), running.then(() => false)]);
      if (!reached) return { failure: null, count };
      const holder = a.prompts.holder;
      if (holder) await vi.waitFor(() => expect(a.prompts.holder).not.toBe(holder), WAIT);
      stop.open();
      await running;
      if (refused !== null && !op.received) {
        // The user is told the restore or reset failed, and does it again.
        if (!/changed|busy|try again/i.test(String(refused?.message ?? refused))) failure = `refused with ${refused}`;
        await op.run();
      }
      await vi.waitFor(() => expect(allSaved(op.present(a.store))).toBe(true), WAIT).catch(() => {
        failure ??= `not all saved: ${JSON.stringify(op.present(a.store))}`;
      });
      if (op.received && !a.relay.isConnected('A')) failure ??= 'needed a reconnect';
    } else {
      await running;
      if (refused !== null) failure = `refused uninterrupted: ${refused}`;
      await vi.waitFor(() => expect(allSaved(op.present(a.store))).toBe(true), WAIT).catch(() => {
        failure ??= `not all saved uninterrupted: ${JSON.stringify(op.present(a.store))}`;
      });
    }
    return { failure, count };
  } finally {
    stop.open();
    a.store.afterIO = undefined;
    await running;
    for (const device of [a, ...op.others]) await device.sync.cleanupDeviceSync();
  }
}

describe('every await of every receive path, restore and reset keeps the invariant (DS-LEASE)', () => {
  for (const name of Object.keys(OPERATIONS)) {
    it(`${name}, its lease running out at each storage read and write`, async () => {
      const { failure: control, count } = await attempt(name, 0);
      expect(control).toBeNull();
      expect(count).toBeGreaterThan(0);
      const failures = [];
      for (let at = 1; at <= count; at += 1) {
        const { failure } = await attempt(name, at);
        if (failure !== null) failures.push(`at ${at} of ${count}: ${failure}`);
      }
      expect(failures).toEqual([]);
    }, 120000);
  }
});
