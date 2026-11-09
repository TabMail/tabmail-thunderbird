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
// The turns' stored thinking, kept as IndexedDB would keep it.
const idb = vi.hoisted(() => ({ data: new Map() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async keys => Object.fromEntries([keys].flat().filter(k => idb.data.has(k)).map(k => [k, idb.data.get(k)]))),
  set: vi.fn(async values => { for (const [k, v] of Object.entries(values)) idb.data.set(k, v); }),
  remove: vi.fn(async keys => { for (const k of [keys].flat()) idb.data.delete(k); }),
  getAllKeys: vi.fn(async () => [...idb.data.keys()]),
}));

const copy = value => (value === undefined ? undefined : structuredClone(value));
let data, queue, store;

beforeEach(async () => {
  vi.resetModules();
  idb.data.clear();
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
  store = await import('../chat/modules/persistentChatStore.js');
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

// A turn's stored thinking lasts as long as the stored turn: whatever removes
// the turn (Chat History's Clear All or Delete Old, the chat window, the
// budget) removes its thinking, and nothing else does (#256).
describe('a removed turn takes its thinking with it', () => {
  const thinkingOf = async ids => Object.keys(Object.fromEntries(
    Object.entries(await store.loadThinkingBatch(ids)).filter(([, text]) => text !== null)));

  beforeEach(async () => {
    for (const id of ['a', 'b', 'c']) await store.saveThinking(id, `${id} thinking`);
  });

  it.each([
    ['Clear All', { clear: true }, []],
    ['a removal by id', { remove: ['b'] }, ['a', 'c']],
    ['Delete Old', { keepFrom: 250 }, ['c']],
    ['a change that adds nothing', { update: [{ _id: 'b', _ts: 200 }] }, ['a', 'b', 'c']],
  ])('%s', async (_, op, kept) => {
    await expect(change(op)).resolves.toMatchObject({ applied: true });
    expect(stored()).toEqual(expect.arrayContaining(kept));
    expect(await thinkingOf(['a', 'b', 'c'])).toEqual(kept);
  });

  it('the budget dropping turns to fit a new one, keeping the new one\'s', async () => {
    await store.saveThinking('big', 'big thinking');
    await change({ append: [{ _id: 'big', _ts: 400, _chars: 25000 }] });
    expect(stored()).toEqual(['big']);
    expect(await thinkingOf(['a', 'b', 'c', 'big'])).toEqual(['big']);
  });

  it('a change whose thinking cannot be removed is still applied, and the failure logged', async () => {
    const { remove } = await import('../agent/modules/idbStorage.js');
    remove.mockRejectedValueOnce(new Error('synthetic IDB failure'));
    await expect(change({ remove: ['b'] })).resolves.toEqual({ applied: true, removed: 1 });
    expect(stored()).toEqual(['a', 'c']);
    const { log } = await import('../agent/modules/utils.js');
    expect(log.mock.calls.some(([line]) => String(line).includes('synthetic IDB failure'))).toBe(true);
  });

  it('a change that fails to write removes no thinking', async () => {
    browser.storage.local.set.mockRejectedValueOnce(new Error('synthetic write failure'));
    await expect(change({ keepFrom: 250 })).resolves.toMatchObject({ applied: false });
    expect(await thinkingOf(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});
