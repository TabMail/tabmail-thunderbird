/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// taskCacheSemaphore.test.js — the task-result cache is changed only in a hold of the prompt semaphore
// (DS-SEMAPHORE): a task result this device saves, or a clean-up it runs, while a peer's cache is being merged
// keeps both changes, and a merge whose hold ran out before its save saves nothing and is applied again
// (DS-LEASE, DS-RECEIVE). The real Device Sync, prompt store and task cache modules, on a simulated device.

import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';

const CACHE_KEY = 'task_execution_cache';
const CACHE_FILE = 'agent/modules/taskExecutionCache.js';
const DAY_MS = 86400 * 1000;

const dateOf = (offsetDays) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
const keysOf = (keys) => (typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {}));

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

async function device(store, options = {}) {
  const relay = new BulletRelay();
  const a = await new BulletDevice('A', store, relay, { acquireWaitMs: 2000, busyReapplyMs: 5, files: [CACHE_FILE], ...options }).start();
  await a.connect();
  while (await relay.deliverOldest()) { /* the connect's own messages */ }
  return { a, cache: a.realm.require(CACHE_FILE) };
}

/** Holds the merge's own read of the cache map (that key alone, not the whole state a history entry reads),
 * once, after it read: it goes on when `resume` opens. */
function pauseMergeRead(a) {
  const reached = gate();
  const resume = gate();
  let paused = false;
  a.store.afterIO = async (op, keys) => {
    if (paused || op !== 'get' || keysOf(keys).join() !== CACHE_KEY || a.prompts.holder?.label !== 'legacy sync apply') return;
    paused = true;
    reached.open();
    await resume.promise;
  };
  return { reached: reached.promise, resume: resume.open };
}

function peerMessage(key) {
  const ts = new Date().toISOString();
  return { type: 'prompt_state', data: { taskCache: { [key]: { content: 'Peer result', sessionId: 'peer-session', ts } }, taskCache_updated_at: ts } };
}

const stored = (a) => a.store.values[CACHE_KEY] ?? {};

describe('the task cache while a peer cache is merged (DS-SEMAPHORE)', () => {
  const peerKey = `t:peer_${dateOf(0)}`;
  const localKey = `t:local_${dateOf(0)}`;
  const orphanKey = `t:gone_${dateOf(-100)}`;
  const orphan = { content: 'Old result', sessionId: 'old-session', ts: new Date(Date.now() - 100 * DAY_MS).toISOString() };

  const writers = [
    {
      name: 'a task result saved',
      seed: {},
      run: (cache) => cache.setCachedResult('t:local', dateOf(0), 'Local result', 'local-session'),
      check: (values) => expect(values[localKey]?.content).toBe('Local result'),
    },
    {
      name: 'a clean-up of an old result',
      seed: { [orphanKey]: orphan },
      run: (cache) => cache.gcOrphanedEntries(new Set()),
      check: (values) => expect(values[orphanKey]).toBeUndefined(),
    },
  ];

  for (const writer of writers) {
    it(`keeps ${writer.name} and the peer's result, when the save lands during the merge`, async () => {
      const { a, cache } = await device(new DeviceStore({ [CACHE_KEY]: writer.seed }));
      const pause = pauseMergeRead(a);
      const receiving = a.receive(peerMessage(peerKey));
      await pause.reached;
      const writing = writer.run(cache);
      // Long enough for an unguarded save to read and write the map while the merge holds what it read.
      await new Promise((resolve) => setTimeout(resolve, 20));
      pause.resume();
      await Promise.all([receiving, writing]);

      expect(stored(a)[peerKey]?.content).toBe('Peer result');
      writer.check(stored(a));
    });

    it(`keeps ${writer.name} and the peer's result with no merge under way (control)`, async () => {
      const { a, cache } = await device(new DeviceStore({ [CACHE_KEY]: writer.seed }));
      await a.receive(peerMessage(peerKey));
      await writer.run(cache);

      expect(stored(a)[peerKey]?.content).toBe('Peer result');
      writer.check(stored(a));
    });
  }

  it("a merge held past its lease saves nothing over a newer task result, and is applied again (DS-LEASE, DS-RECEIVE)", async () => {
    const { a, cache } = await device(new DeviceStore(), { leaseMs: 40 });
    const pause = pauseMergeRead(a);
    const receiving = a.receive(peerMessage(peerKey));
    await pause.reached;
    await vi.waitFor(() => expect(a.logs.some(({ message }) => message.includes('past its lease'))).toBe(true), { timeout: 2000 });
    await cache.setCachedResult('t:local', dateOf(0), 'Local result', 'local-session');
    expect(stored(a)[localKey]?.content).toBe('Local result');
    pause.resume();
    await receiving;

    expect(stored(a)[localKey]?.content).toBe('Local result');
    expect(stored(a)[peerKey]?.content).toBe('Peer result');
    expect(a.logs.some(({ message }) => message.includes('is applied again shortly'))).toBe(true);
  });

  it('a task result that cannot get the semaphore is not cached, and the check-in goes on', async () => {
    const { a, cache } = await device(new DeviceStore(), { acquireWaitMs: 0 });
    const hold = gate();
    let held = false;
    const holding = a.prompts.withPromptStore(async () => { held = true; await hold.promise; }, { label: 'a long writer' });
    await vi.waitFor(() => expect(held).toBe(true), { interval: 1 });
    try {
      await expect(cache.setCachedResult('t:local', dateOf(0), 'Local result', 'local-session')).resolves.toBeUndefined();
      await expect(cache.gcOrphanedEntries(new Set())).resolves.toBeUndefined();
    } finally {
      hold.open();
    }
    await holding;
    expect(stored(a)[localKey]).toBeUndefined();
    expect(a.logs.some(({ message }) => message.includes(`Result for ${localKey} not cached`))).toBe(true);
  });
});
