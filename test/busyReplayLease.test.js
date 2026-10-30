/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// DS-RECEIVE and DS-LEASE: a received message refused as busy waits and is applied again until it applies or
// its connection ends. A hold stuck at a slow storage read loses the semaphore at its lease, and the waiting
// message is then applied while that read is still stuck: there is no engine lock behind the semaphore. With
// both peers connected and nobody editing, the peer's bullet arrives without a reconnect.

import { expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, PROMPT_KEYS } from './support/bulletDevices.js';

async function flush(relay) {
  for (let i = 0; i < 100; i++) if (!(await relay.deliverOldest())) return;
  throw new Error('bounded relay flush exceeded');
}
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

it.each([false, true])('a message refused as busy is applied without a reconnect, also while a stuck read\'s hold ended at its lease (lease ended: %s)', async (expire) => {
  const relay = new BulletRelay();
  const options = { leaseMs: 100, retries: 0, busyReapplyMs: 20 };
  const a = await new BulletDevice('A', new DeviceStore(), relay, options).start();
  const b = await new BulletDevice('B', new DeviceStore(), relay, options).start();
  await a.connect();
  await b.connect();
  await a.add('kb', '', 'Own durable note');
  await flush(relay);
  const stop = gate();
  let paused = false;
  a.store.beforeGet = async (key) => {
    if (key === 'bullet_state:kb' && !paused) {
      paused = true;
      await stop.promise;
    }
  };
  // A real show-only read holds the engine at an asynchronous storage read.
  const reading = a.prompts.readText('kb').catch((e) => e);
  await vi.waitFor(() => expect(paused).toBe(true), { interval: 1 });
  await b.add('kb', '', 'Peer note whose first apply was busy');
  await flush(relay);
  expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true);
  try {
    if (expire) {
      // The stuck read loses its hold at its lease; the busy message is then applied while the read is stuck.
      await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('past its lease'))).toBe(true), { interval: 5, timeout: 1500 });
      await vi.waitFor(() => expect(a.store.values[PROMPT_KEYS.kb] ?? '').toContain('Peer note whose first apply was busy'), { interval: 5, timeout: 1500 });
    }
  } finally { stop.open(); }
  await reading;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await flush(relay);
  const state = {
    bothConnected: relay.isConnected('A') && relay.isConnected('B'),
    local: (a.store.values[PROMPT_KEYS.kb] ?? '').includes('Peer note whose first apply was busy'),
    peer: (b.store.values[PROMPT_KEYS.kb] ?? '').includes('Peer note whose first apply was busy'),
  };
  await a.sync.cleanupDeviceSync();
  await b.sync.cleanupDeviceSync();
  expect(state).toEqual({ bothConnected: true, local: true, peer: true });
});

it.each([false, true])('a released device\'s prompt_state refused as busy is applied without a reconnect, also while a stuck read\'s hold ended at its lease (lease ended: %s)', async (expire) => {
  const relay = new BulletRelay();
  const options = { leaseMs: 100, retries: 0, busyReapplyMs: 20 };
  const a = await new BulletDevice('A', new DeviceStore(), relay, options).start();
  await a.connect();
  await a.add('kb', '', 'Own durable note');
  const stop = gate();
  let paused = false;
  a.store.beforeGet = async (key) => {
    if (key === 'bullet_state:kb' && !paused) {
      paused = true;
      await stop.promise;
    }
  };
  const reading = a.prompts.readText('kb').catch((e) => e);
  await vi.waitFor(() => expect(paused).toBe(true), { interval: 1 });
  const applying = a.receive({ type: 'prompt_state', data: { kb: '- Legacy peer note whose first apply was busy', kb_updated_at: new Date().toISOString() } });
  await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true), { interval: 5 });
  try {
    if (expire) {
      await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('past its lease'))).toBe(true), { interval: 5, timeout: 1500 });
      await vi.waitFor(() => expect(a.store.values[PROMPT_KEYS.kb] ?? '').toContain('Legacy peer note whose first apply was busy'), { interval: 5, timeout: 1500 });
    }
  } finally { stop.open(); }
  await reading;
  await applying;
  await vi.waitFor(() => expect(a.store.values[PROMPT_KEYS.kb] ?? '').toContain('Legacy peer note whose first apply was busy'), { interval: 5, timeout: 1500 });
  expect(relay.isConnected('A')).toBe(true);
  await a.sync.cleanupDeviceSync();
});

// DS-VALIDATE before DS-RECEIVE: a part whose sender, field or snap is not a string is dropped as it arrives,
// before it joins the arrival chain, so it never waits behind a busy message, never counts toward the bound and
// never touches a valid message waiting there.
it('drops a part with a malformed identity at once, while a valid busy one waits, which is then applied', async () => {
  const relay = new BulletRelay();
  const options = { retries: 0, busyReapplyMs: 20 };
  const a = await new BulletDevice('A', new DeviceStore(), relay, options).start();
  const b = await new BulletDevice('B', new DeviceStore(), relay, options).start();
  await a.connect();
  await b.connect();
  await flush(relay);
  const hold = gate();
  let held = false;
  const holding = a.prompts.withPromptStore(async () => { held = true; await hold.promise; }, { label: 'a long writer' });
  await vi.waitFor(() => expect(held).toBe(true), { interval: 1 });
  await b.add('kb', '', 'Valid peer note');
  const valid = relay.pending.find((entry) => entry.to === 'A' && entry.snapshot.field === 'kb');
  const text = valid.snapshot.parts[valid.part - 1];
  const delivering = relay.deliver(valid.snapshot.id, 'A', valid.part);
  let arrivals = [];
  const dropped = () => a.logs.filter(({ message }) => message.includes('bullet_state part dropped')).length;
  try {
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true), { timeout: 2000 });
    const malformed = [{ sender: 7 }, { field: null }, { snap: { id: 'x' } }].map((change) => ({ ...JSON.parse(text), ...change }));
    arrivals = malformed.map((message) => a.receive(message));
    // Dropped while the semaphore is still held: none of them waited in the chain behind the busy message.
    await vi.waitFor(() => expect(dropped()).toBe(malformed.length), { timeout: 1000 });
  } finally {
    hold.open();
  }
  await holding;
  await delivering;
  await Promise.all(arrivals);
  await vi.waitFor(() => expect(a.store.values[PROMPT_KEYS.kb] ?? '').toContain('Valid peer note'), { timeout: 2000 });
  expect(dropped()).toBe(3);
});
