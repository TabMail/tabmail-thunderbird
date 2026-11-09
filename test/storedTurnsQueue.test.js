/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The stored chat turns' writer (chat/modules/storedTurnsQueue.js): what each
// operation does to the stored turns, and that changes are applied one at a
// time in the order sent, each answered with what happened to it. The
// open-window and window-start cases are in chatClearAllOpenWindow.test.js
// and chatInitStoredTurns.test.js.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storedTurnsRoute } from './support/storedTurnsRoute.js';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}), getAllKeys: vi.fn(async () => []),
}));

const copy = value => (value === undefined ? undefined : structuredClone(value));
let data, queue;

beforeEach(async () => {
  vi.resetModules();
  data = {
    chat_turns: [
      { _id: 'a', _ts: 100, _chars: 1 },
      { _id: 'b', _ts: 200, _chars: 1 },
      { _id: 'c', _ts: 300, _chars: 1 },
    ],
  };
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async key => (key in data ? { [key]: copy(data[key]) } : {})),
        set: vi.fn(async values => { for (const [k, v] of Object.entries(values)) data[k] = copy(v); }),
        remove: vi.fn(async keys => { for (const k of [keys].flat()) delete data[k]; }),
      },
    },
  };
  queue = await import('../chat/modules/storedTurnsQueue.js');
});

afterEach(() => {
  delete globalThis.browser;
});

const stored = () => (data.chat_turns || []).map(t => t._id);
const change = op => queue.enqueueTurnsChange(op);

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

  it('writes nothing when the stored turns cannot be read, and answers that it failed', async () => {
    browser.storage.local.get.mockRejectedValueOnce(new Error('synthetic read failure'));
    await expect(change({ append: [{ _id: 'd' }] }))
      .resolves.toEqual({ applied: false, error: 'Error: synthetic read failure' });
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(stored()).toEqual(['a', 'b', 'c']);
  });
});

describe('order', () => {
  // Holds every storage call until released, so a test can see which change
  // has started and whether two ever run at once.
  function holdStorage() {
    const calls = [];
    let active = 0;
    let overlapped = false;
    for (const name of ['get', 'set', 'remove']) {
      const run = browser.storage.local[name].getMockImplementation();
      browser.storage.local[name].mockImplementation(async arg => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise(resolve => calls.push({ name, resolve }));
        active -= 1;
        return run(arg);
      });
    }
    const releaseAll = async () => {
      for (let i = 0; i < 100 && (calls.length > 0 || active > 0); i++) {
        calls.splice(0).forEach(call => call.resolve());
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    };
    return { calls, releaseAll, overlapped: () => overlapped };
  }

  it('applies changes one at a time, in the order sent, so a Clear All is never undone by an older change', async () => {
    const held = holdStorage();
    const append = change({ append: [{ _id: 'd', _ts: 400 }] });
    const clear = change({ clear: true });
    const after = change({ append: [{ _id: 'e', _ts: 500 }] });
    await vi.waitFor(() => expect(held.calls.length).toBe(1));
    // Only the first change has started: one read, nothing of the others.
    expect(held.calls.map(c => c.name)).toEqual(['get']);
    await held.releaseAll();

    await expect(append).resolves.toEqual({ applied: true, removed: 0 });
    await expect(clear).resolves.toEqual({ applied: true, removed: 4 });
    await expect(after).resolves.toEqual({ applied: true, removed: 0 });
    expect(stored()).toEqual(['e']);
    expect(held.overlapped()).toBe(false);
  });

  it('applies the changes after one that failed, and answers each with its own result', async () => {
    browser.storage.local.set.mockRejectedValueOnce(new Error('synthetic write failure'));
    const failed = change({ append: [{ _id: 'd', _ts: 400 }] });
    const next = change({ remove: ['a'] });

    await expect(failed).resolves.toEqual({ applied: false, error: 'Error: synthetic write failure' });
    await expect(next).resolves.toEqual({ applied: true, removed: 1 });
    expect(stored()).toEqual(['b', 'c']);
  });

  it('answers a change sent to the background, and a failed one with its error', async () => {
    const send = storedTurnsRoute(queue);
    await expect(send({ command: 'chat-turns-change', op: { remove: ['a'] } })).resolves.toEqual({ applied: true, removed: 1 });
    expect(stored()).toEqual(['b', 'c']);
    browser.storage.local.get.mockRejectedValueOnce(new Error('synthetic read failure'));
    await expect(send({ command: 'chat-turns-change', op: { clear: true } }))
      .resolves.toEqual({ applied: false, error: 'Error: synthetic read failure' });
    expect(stored()).toEqual(['b', 'c']);
  });
});
