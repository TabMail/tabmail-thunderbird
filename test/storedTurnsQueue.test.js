/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The stored chat turns' queue (chat/modules/storedTurnsQueue.js): what each
// operation does to the stored turns, and how the queue is persisted and
// restored. The open-window and window-start cases are in
// chatClearAllOpenWindow.test.js and chatInitStoredTurns.test.js.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storedTurnsRoute } from './support/storedTurnsRoute.js';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}), getAllKeys: vi.fn(async () => []),
}));

const copy = value => (value === undefined ? undefined : structuredClone(value));
let data, queue, alarms, alarmListeners;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  data = {
    chat_turns: [
      { _id: 'a', _ts: 100, _chars: 1 },
      { _id: 'b', _ts: 200, _chars: 1 },
      { _id: 'c', _ts: 300, _chars: 1 },
    ],
  };
  alarms = new Map();
  alarmListeners = [];
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async key => (key in data ? { [key]: copy(data[key]) } : {})),
        set: vi.fn(async values => { for (const [k, v] of Object.entries(values)) data[k] = copy(v); }),
        remove: vi.fn(async keys => { for (const k of [keys].flat()) delete data[k]; }),
      },
    },
    alarms: {
      onAlarm: { addListener: fn => alarmListeners.push(fn) },
      create: vi.fn(async (name, info) => { alarms.set(name, info); }),
      clear: vi.fn(async name => alarms.delete(name)),
      get: vi.fn(async name => alarms.get(name)),
    },
  };
  queue = await import('../chat/modules/storedTurnsQueue.js');
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.browser;
});

const stored = () => (data.chat_turns || []).map(t => t._id);
let n = 0;
const change = op => queue.enqueueTurnsChange(op, `change-${++n}`);

describe('operations', () => {
  it('appends after the stored turns, once per id', async () => {
    await expect(change({ append: [{ _id: 'b', _ts: 1 }, { _id: 'd', _ts: 400 }] })).resolves.toEqual({ applied: true, removed: 0 });
    expect(stored()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the stored turns within the budget when appending', async () => {
    await change({ append: [{ _id: 'big', _ts: 400, _chars: 25000 }] });
    expect(stored()).toEqual(['big']);
  });

  it('removes the turns with the given ids', async () => {
    await expect(change({ remove: ['a', 'c', 'missing'] })).resolves.toEqual({ applied: true, removed: 2 });
    expect(stored()).toEqual(['b']);
  });

  it('removes the turns older than keepFrom, keeping one at it', async () => {
    await expect(change({ keepFrom: 200 })).resolves.toEqual({ applied: true, removed: 1 });
    expect(stored()).toEqual(['b', 'c']);
  });

  it('replaces stored turns by id with update, adding none', async () => {
    await change({ update: [{ _id: 'b', _ts: 200, _refs: [1] }, { _id: 'gone', _ts: 1 }] });
    expect(data.chat_turns[1]).toEqual({ _id: 'b', _ts: 200, _refs: [1] });
    expect(stored()).toEqual(['a', 'b', 'c']);
  });

  it('clears by removing the key', async () => {
    await expect(change({ clear: true })).resolves.toEqual({ applied: true, removed: 3 });
    expect('chat_turns' in data).toBe(false);
  });

  it('writes nothing when the stored turns cannot be read, and keeps the change', async () => {
    const get = browser.storage.local.get.getMockImplementation();
    browser.storage.local.get.mockImplementation(async key => {
      if (key === 'chat_turns') throw new Error('synthetic read failure');
      return get(key);
    });
    const reads = () => browser.storage.local.get.mock.calls.filter(([key]) => key === 'chat_turns').length;
    const before = reads();
    const pending = change({ append: [{ _id: 'd' }] });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(pending).resolves.toEqual({ applied: false, queued: true });
    expect(stored()).toEqual(['a', 'b', 'c']);
    // Tried again only after the retry delay, not at once.
    expect(reads() - before).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads() - before).toBe(2);
    expect(data.chat_turns_pending.map(item => item.op)).toEqual([{ append: [{ _id: 'd' }] }]);
    expect(alarms.has('tabmail-chat-turns-retry')).toBe(true);

    browser.storage.local.get.mockImplementation(get);
    await alarmListeners[0]({ name: 'tabmail-chat-turns-retry' });
    expect(stored()).toEqual(['a', 'b', 'c', 'd']);
    expect(data.chat_turns_pending).toEqual([]);
    expect(alarms.has('tabmail-chat-turns-retry')).toBe(false);
  });
});

describe('persistence', () => {
  it('persists a change before applying it', async () => {
    const order = [];
    const set = browser.storage.local.set.getMockImplementation();
    browser.storage.local.set.mockImplementation(async values => { order.push(Object.keys(values)[0]); return set(values); });
    await change({ append: [{ _id: 'd' }] });
    expect(order).toEqual(['chat_turns_pending', 'chat_turns', 'chat_turns_pending']);
  });

  it('applies the queue it restores when the background starts, skipping what is not a change, before any change is sent', async () => {
    data.chat_turns_pending = [
      { id: 'restored', op: { append: [{ _id: 'r' }] } },
      { id: 'broken', op: null },
      { op: { clear: true } },
      { id: 'restored-2', op: { remove: ['a'] } },
    ];
    vi.resetModules();
    queue = await import('../chat/modules/storedTurnsQueue.js');
    await vi.waitFor(() => expect(data.chat_turns_pending).toEqual([]));
    expect(stored()).toEqual(['b', 'c', 'r']);
    await change({ append: [{ _id: 'later' }] });
    expect(stored()).toEqual(['b', 'c', 'r', 'later']);
  });

  it('ignores alarms that are not its own', async () => {
    const get = browser.storage.local.get.getMockImplementation();
    browser.storage.local.get.mockImplementation(async key => {
      if (key === 'chat_turns') throw new Error('synthetic read failure');
      return get(key);
    });
    const pending = change({ clear: true });
    await vi.advanceTimersByTimeAsync(6000);
    await pending;
    browser.storage.local.get.mockImplementation(get);

    await alarmListeners[0]({ name: 'another-alarm' });
    expect(stored()).toEqual(['a', 'b', 'c']);
    await alarmListeners[0]({ name: 'tabmail-chat-turns-retry' });
    expect(stored()).toEqual([]);
  });

  it('applies a change sent while the queue is finishing the one before it', async () => {
    await change({ remove: ['a'] });
    let reached, release;
    const atClear = new Promise(r => { reached = r; });
    const held = new Promise(r => { release = r; });
    const clear = browser.alarms.clear.getMockImplementation();
    browser.alarms.clear.mockImplementationOnce(async name => { reached(); await held; return clear(name); });
    const first = change({ remove: ['b'] });
    await atClear;
    const second = change({ remove: ['c'] });
    release();

    await expect(first).resolves.toEqual({ applied: true, removed: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toEqual([]);
    await expect(second).resolves.toEqual({ applied: true, removed: 1 });
  });

  it('answers a change sent to the background, and a failed one with its error', async () => {
    const send = storedTurnsRoute(queue);
    await expect(send({ command: 'chat-turns-change', id: 'm1', op: { remove: ['a'] } })).resolves.toEqual({ applied: true, removed: 1 });
    expect(stored()).toEqual(['b', 'c']);
    browser.storage.local.get.mockImplementation(async key => {
      if (key === 'chat_turns_pending') throw new Error('synthetic restore failure');
      return key in data ? { [key]: copy(data[key]) } : {};
    });
    vi.resetModules();
    const fresh = await import('../chat/modules/storedTurnsQueue.js');
    await expect(storedTurnsRoute(fresh)({ command: 'chat-turns-change', id: 'm2', op: { clear: true } }))
      .resolves.toEqual({ applied: false, error: 'Error: synthetic restore failure' });
  });
});
