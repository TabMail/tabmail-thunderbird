/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The stored chat turns' queue (chat/modules/storedTurnsQueue.js) when
// storage fails or is slow: what a caller is told, what is kept, what a
// restart applies, what readers see meanwhile, and the queue's bounds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}), getAllKeys: vi.fn(async () => []),
}));

const copy = value => (value === undefined ? undefined : structuredClone(value));
let data, queue, store, settings, faults;

// Storage that keeps copies; `faults` can fail or hold a call before it acts.
function storage() {
  const pick = keys => {
    if (typeof keys === 'string') keys = [keys];
    return Object.fromEntries(keys.filter(k => k in data).map(k => [k, copy(data[k])]));
  };
  const step = async (kind, keys) => {
    for (const fault of faults) {
      if (fault.kind === kind && fault.match(keys)) {
        if (fault.times !== undefined && fault.times-- <= 0) continue;
        if (fault.hold) await fault.hold;
        if (fault.error) throw new Error(fault.error);
      }
    }
  };
  return {
    get: vi.fn(async keys => { await step('get', keys); return pick(keys); }),
    set: vi.fn(async values => { await step('set', values); for (const [k, v] of Object.entries(values)) data[k] = copy(v); }),
    remove: vi.fn(async keys => { await step('remove', keys); for (const k of [keys].flat()) delete data[k]; }),
  };
}

const turnsRead = keys => keys === 'chat_turns';
const turnsWrite = values => 'chat_turns' in values;
const queueRead = keys => keys === 'chat_turns_pending';
const queueWrite = values => 'chat_turns_pending' in values;
const held = () => {
  let release;
  const hold = new Promise(r => { release = r; });
  return { hold, release };
};

async function start() {
  vi.resetModules();
  store = await import('../chat/modules/persistentChatStore.js');
  ({ CHAT_SETTINGS: settings } = await import('../chat/modules/chatConfig.js'));
  queue = await import('../chat/modules/storedTurnsQueue.js');
}

// The background stops (its timers and anything waiting on storage with it)
// and starts again.
async function restart() {
  vi.clearAllTimers();
  for (const fault of faults) fault.hold && fault.dropped?.();
  faults = [];
  await start();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  data = { chat_turns: [{ _id: 'a', _ts: 100, _chars: 1 }, { _id: 'b', _ts: 200, _chars: 1 }] };
  faults = [];
  globalThis.browser = {
    storage: { local: storage() },
    alarms: {
      onAlarm: { addListener() {} },
      create: vi.fn(async () => {}), clear: vi.fn(async () => {}), get: vi.fn(async () => undefined),
    },
  };
  await start();
  await vi.advanceTimersByTimeAsync(0);
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.browser;
});

const stored = () => (data.chat_turns || []).map(t => t._id);
const journal = () => (data.chat_turns_pending || []).map(item => item.id);
let n = 0;
const change = (op, id = `change-${++n}`) => queue.enqueueTurnsChange(op, id);
const answeredBy = async (promise, ms) => {
  let answer = 'no answer';
  promise.then(value => { answer = value; });
  await vi.advanceTimersByTimeAsync(ms);
  return answer;
};

describe('accepting a change', () => {
  it('refuses a change whose queue cannot be saved, and applies none of it', async () => {
    faults.push({ kind: 'set', match: queueWrite, error: 'synthetic save failure', times: 1 });
    const refused = await change({ clear: true }, 'refused-clear');
    expect(refused).toEqual({ applied: false, error: 'Error: synthetic save failure' });

    await expect(change({ append: [{ _id: 'c' }] })).resolves.toEqual({ applied: true, removed: 0 });
    expect(stored()).toEqual(['a', 'b', 'c']);
    expect(journal()).toEqual([]);
    await restart();
    expect(stored()).toEqual(['a', 'b', 'c']);
  });

  it('answers within its wait when the queue is slow to restore, and does not queue it later', async () => {
    data.chat_turns_pending = [];
    const slow = held();
    faults.push({ kind: 'get', match: queueRead, hold: slow.hold });
    await start();
    const answer = await answeredBy(change({ clear: true }, 'late'), settings.turnsQueue.applyWaitMs);
    expect(answer).toEqual({ applied: false, error: 'not accepted in time' });
    slow.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toEqual(['a', 'b']);
    expect(journal()).toEqual([]);
  });

  it('answers within its wait when saving the queue is slow, saying so, and applies it once saved', async () => {
    const slow = held();
    faults.push({ kind: 'set', match: queueWrite, hold: slow.hold, times: 1 });
    const answer = await answeredBy(change({ remove: ['a'] }), settings.turnsQueue.applyWaitMs);
    expect(answer).toEqual({ applied: false, error: queue.CHANGE_UNCONFIRMED });
    slow.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toEqual(['b']);
  });

  it('refuses changes beyond the queue limit while the head cannot be applied, keeping every accepted one', async () => {
    settings.turnsQueue.maxQueued = 3;
    faults.push({ kind: 'get', match: turnsRead, error: 'synthetic read failure' });
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(change({ append: [{ _id: `t${i}` }] }));
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.applyWaitMs);
    const replies = await Promise.all(answers);
    expect(replies.slice(0, 3)).toEqual(Array(3).fill({ applied: false, queued: true }));
    expect(replies.slice(3).map(r => r.error)).toEqual(Array(2).fill('Error: queue full (3 changes not yet applied)'));
    expect(data.chat_turns_pending.map(item => item.op.append[0]._id)).toEqual(['t0', 't1', 't2']);

    faults = [];
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.retryDelayMs);
    expect(stored()).toEqual(['a', 'b', 't0', 't1', 't2']);
  });

  it('holds at most the queue limit of changes waiting for a restore that does not finish, refusing the rest at once', async () => {
    data.chat_turns_pending = [];
    const slow = held();
    faults.push({ kind: 'get', match: queueRead, hold: slow.hold });
    await start();
    settings.turnsQueue.maxQueued = 3;
    const waiting = [0, 1, 2].map(i => change({ append: [{ _id: `w${i}` }] }));
    const refused = await answeredBy(change({ append: [{ _id: 'beyond' }] }), 0);
    expect(refused).toEqual({ applied: false, error: 'Error: queue full (3 changes not yet applied)' });

    await vi.advanceTimersByTimeAsync(settings.turnsQueue.applyWaitMs);
    expect(await Promise.all(waiting)).toEqual(Array(3).fill({ applied: false, error: 'not accepted in time' }));
    // Their callers have their answers; while the restore still has not
    // finished, nothing more is held.
    const later = await answeredBy(change({ append: [{ _id: 'later' }] }), 0);
    expect(later).toEqual({ applied: false, error: 'Error: queue full (3 changes not yet applied)' });

    slow.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toEqual(['a', 'b']);
    expect(journal()).toEqual([]);
    await expect(change({ append: [{ _id: 'c' }] })).resolves.toEqual({ applied: true, removed: 0 });
    expect(stored()).toEqual(['a', 'b', 'c']);
  });

  it('holds at most the queue limit when the restore brings back saved changes while others wait for it', async () => {
    data.chat_turns_pending = [{ id: 's0', op: { append: [{ _id: 's0' }] } }, { id: 's1', op: { append: [{ _id: 's1' }] } }];
    const slow = held();
    faults.push({ kind: 'get', match: queueRead, hold: slow.hold, times: 1 });
    faults.push({ kind: 'get', match: turnsRead, error: 'synthetic read failure' });
    await start();
    settings.turnsQueue.maxQueued = 3;
    const waiting = [0, 1, 2].map(i => change({ append: [{ _id: `w${i}` }] }, `w${i}`));
    slow.release();
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.applyWaitMs);
    const answers = await Promise.all(waiting);
    expect(journal()).toEqual(['s0', 's1', 'w0']);
    expect(answers).toEqual([
      { applied: false, queued: true },
      { applied: false, error: 'Error: queue full (3 changes not yet applied)' },
      { applied: false, error: 'Error: queue full (3 changes not yet applied)' },
    ]);
  });

  it('gives back the queue room of a change whose wait for the restore failed', async () => {
    faults.push({ kind: 'get', match: queueRead, error: 'synthetic restore failure', times: 3 });
    await start();
    settings.turnsQueue.maxQueued = 2;
    await vi.advanceTimersByTimeAsync(0);
    expect(await change({ append: [{ _id: 'x' }] })).toEqual({ applied: false, error: 'Error: synthetic restore failure' });
    expect(await change({ append: [{ _id: 'y' }] })).toEqual({ applied: false, error: 'Error: synthetic restore failure' });
    // Accepted (the drain is waiting out the restore's retry delay), then applied.
    const answer = await answeredBy(change({ append: [{ _id: 'c' }] }), settings.turnsQueue.retryDelayMs);
    expect(answer).toEqual({ applied: false, queued: true });
    expect(stored()).toEqual(['a', 'b', 'c']);
    expect(journal()).toEqual([]);
  });
});

describe('waking to apply', () => {
  const RETRY_ALARM = 'tabmail-chat-turns-retry';

  it('arms the retry alarm when the saved queue cannot be restored, and applies it when the alarm wakes the background', async () => {
    data.chat_turns_pending = [{ id: 'queued-clear', op: { clear: true } }];
    let wake;
    browser.alarms.onAlarm.addListener = fn => { wake = fn; };
    browser.alarms.create.mockClear();
    browser.alarms.clear.mockClear();
    faults.push({ kind: 'get', match: queueRead, error: 'synthetic restore failure' });
    await start();
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.alarms.create).toHaveBeenCalledWith(RETRY_ALARM, expect.objectContaining({ periodInMinutes: expect.any(Number) }));
    expect(browser.alarms.clear).not.toHaveBeenCalled();

    // The background is suspended (its timers go with it); storage works again.
    vi.clearAllTimers();
    faults = [];
    expect(stored()).toEqual(['a', 'b']);
    await wake({ name: RETRY_ALARM });
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toEqual([]);
    expect(journal()).toEqual([]);
    expect(browser.alarms.clear).toHaveBeenCalledWith(RETRY_ALARM);
  });

  it('arms the retry alarm before an accepted change is applied, so a background stopped meanwhile is woken to apply it', async () => {
    browser.alarms.create.mockClear();
    const never = held();
    faults.push({ kind: 'set', match: turnsWrite, hold: never.hold });
    change({ append: [{ _id: 'c' }] }, 'append-c');
    await vi.advanceTimersByTimeAsync(0);
    expect(journal()).toEqual(['append-c']);
    expect(browser.alarms.create).toHaveBeenCalledWith(RETRY_ALARM, expect.objectContaining({ periodInMinutes: expect.any(Number) }));

    await restart();
    expect(stored()).toEqual(['a', 'b', 'c']);
    expect(journal()).toEqual([]);
  });
});

describe('applying without the alarm', () => {
  it('applies a change when the retry alarm cannot be set', async () => {
    browser.alarms.get.mockRejectedValue(new Error('synthetic alarms failure'));
    browser.alarms.create.mockRejectedValue(new Error('synthetic alarms failure'));
    await expect(change({ append: [{ _id: 'c' }] })).resolves.toEqual({ applied: true, removed: 0 });
    expect(stored()).toEqual(['a', 'b', 'c']);
    expect(journal()).toEqual([]);
  });
});

describe('applying in order', () => {
  it('keeps a change in the saved queue until it is applied and that is saved, and applies nothing after it before', async () => {
    faults.push({ kind: 'set', match: values => queueWrite(values) && values.chat_turns_pending.length === 0, error: 'synthetic save failure', times: 1 });
    const appended = change({ append: [{ _id: 'c' }] }, 'append-c');
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toEqual(['a', 'b', 'c']);
    expect(journal()).toEqual(['append-c']);

    const cleared = change({ clear: true }, 'clear');
    await vi.advanceTimersByTimeAsync(0);
    // The clear is accepted but waits: 'append-c' has not left the saved queue.
    expect(stored()).toEqual(['a', 'b', 'c']);
    expect(journal()).toEqual(['clear']);
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.applyWaitMs);
    expect(await appended).toEqual({ applied: false, queued: true });
    expect(await cleared).toEqual({ applied: false, queued: true });
    expect(stored()).toEqual(['a', 'b', 'c']);

    // A restart now applies the clear only.
    await restart();
    expect(stored()).toEqual([]);
    expect(journal()).toEqual([]);
  });

  it('applies no change before its queue is saved, and none whose save fails, sent while the change before it is finishing', async () => {
    // The change before it is applied; saving the queue without it is slow.
    const finishing = held();
    faults.push({ kind: 'set', match: values => queueWrite(values) && values.chat_turns_pending.length === 0, hold: finishing.hold, times: 1 });
    faults.push({ kind: 'set', match: values => queueWrite(values) && values.chat_turns_pending.some(item => item.id === 'refused-clear'), error: 'synthetic save failure', times: 1 });
    const appended = change({ append: [{ _id: 'c' }] }, 'append-c');
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toEqual(['a', 'b', 'c']);

    const refused = change({ clear: true }, 'refused-clear');
    await vi.advanceTimersByTimeAsync(0);
    finishing.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await refused).toEqual({ applied: false, error: 'Error: synthetic save failure' });
    expect(await appended).toEqual({ applied: true, removed: 0 });
    expect(stored()).toEqual(['a', 'b', 'c']);

    // The next change is applied, not lost in its place.
    await expect(change({ append: [{ _id: 'd' }] })).resolves.toEqual({ applied: true, removed: 0 });
    expect(stored()).toEqual(['a', 'b', 'c', 'd']);
    expect(journal()).toEqual([]);
  });

  it('waits for a write already issued instead of overtaking it, then applies the next change', async () => {
    const slow = held();
    faults.push({ kind: 'set', match: turnsWrite, hold: slow.hold, times: 1 });
    const first = change({ append: [{ _id: 'c' }] });
    const second = change({ append: [{ _id: 'd' }] });
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.applyTimeoutMs + settings.turnsQueue.retryDelayMs);
    expect(stored()).toEqual(['a', 'b']);

    slow.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toEqual(['a', 'b', 'c', 'd']);
    expect(await first).toEqual({ applied: false, queued: true });
    expect(await second).toEqual({ applied: false, queued: true });
  });

  it('retries a change that cannot be applied after its delay only, however many changes are sent meanwhile', async () => {
    faults.push({ kind: 'get', match: turnsRead, error: 'synthetic read failure' });
    const reads = () => browser.storage.local.get.mock.calls.filter(([keys]) => turnsRead(keys)).length;
    const before = reads();
    const sent = [];
    for (let i = 0; i < 8; i++) {
      sent.push(change({ append: [{ _id: `t${i}` }] }));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(reads() - before).toBe(1);
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.retryDelayMs);
    expect(reads() - before).toBe(2);
    faults = [];
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.retryDelayMs);
    expect(stored()).toEqual(['a', 'b', ...Array.from({ length: 8 }, (_, i) => `t${i}`)]);
    await Promise.all(sent);
  });

  it('retries a head that keeps failing once per delay, however many alarms woke it meanwhile', async () => {
    let wake;
    browser.alarms.onAlarm.addListener = fn => { wake = fn; };
    await start();
    await vi.advanceTimersByTimeAsync(0);
    faults.push({ kind: 'get', match: turnsRead, error: 'synthetic read failure' });
    const reads = () => browser.storage.local.get.mock.calls.filter(([keys]) => turnsRead(keys)).length;
    change({ append: [{ _id: 'c' }] });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      await wake({ name: 'tabmail-chat-turns-retry' });
      await vi.advanceTimersByTimeAsync(0);
    }
    const before = reads();
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.retryDelayMs * 6);
    expect(reads() - before).toBe(6);
    faults = [];
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.retryDelayMs);
    expect(stored()).toEqual(['a', 'b', 'c']);
  });
});

describe('reading while changes are queued', () => {
  it('leaves turns a queued Clear All or Delete Old removes out of what is loaded and of the model context', async () => {
    // The stored turns read fine; writing them fails, so the changes stay queued.
    faults.push({ kind: 'set', match: turnsWrite, error: 'synthetic write failure' });
    const old = change({ keepFrom: 150 });
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.applyWaitMs);
    expect(await old).toEqual({ applied: false, queued: true });
    expect(stored()).toEqual(['a', 'b']);
    expect((await store.loadTurns()).map(t => t._id)).toEqual(['b']);

    const cleared = change({ clear: true });
    const added = change({ append: [{ _id: 'after', _ts: 300, role: 'user', content: 'after the clear' }] });
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.applyWaitMs);
    await Promise.all([cleared, added]);
    expect((await store.loadTurns()).map(t => t._id)).toEqual(['after']);
    const context = await store.filterAndConvertTurns();
    expect(context.map(m => m.content)).toEqual(['after the clear']);
  });

  it('leaves a turn a queued removal names out of what is loaded and of the model context, keeping the others', async () => {
    data.chat_turns = [
      { _id: 'a', _ts: 100, _chars: 1, role: 'user', content: 'first' },
      { _id: 'b', _ts: 200, _chars: 1, role: 'assistant', content: 'second' },
    ];
    faults.push({ kind: 'set', match: turnsWrite, error: 'synthetic write failure' });
    const removing = change({ remove: ['a'] }, 'remove-a');
    await vi.advanceTimersByTimeAsync(settings.turnsQueue.applyWaitMs);
    expect(await removing).toEqual({ applied: false, queued: true });
    expect(journal()).toEqual(['remove-a']);
    expect(stored()).toEqual(['a', 'b']);

    expect((await store.loadTurns()).map(t => t._id)).toEqual(['b']);
    const context = await store.filterAndConvertTurns();
    expect(context.map(m => m.content)).toEqual(['second']);
  });
});
