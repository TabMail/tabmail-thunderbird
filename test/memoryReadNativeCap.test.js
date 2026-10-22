/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// TB-194 (#151): the chat's memory_read tool keeps every helper reply under
// the native-messaging cap and still returns each entry it shows whole.
// Thunderbird refuses a helper message over 1 MiB and disconnects the helper;
// memory entries are stored whole. This runs the real tool with the shipped
// settings against a fake helper that answers memorySearch and memoryRead as
// the helper does (previewChars cuts content in the reply, both date bounds
// inclusive, a listing newest first; a read oldest first, at most 50) and
// refuses an over-cap reply. Any other command fails.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));

const { run } = await import('../chat/tools/memory_read.js');

const NATIVE_MESSAGE_CAP_BYTES = 1024 * 1024;
// A tool that never stops asking fails here, not by exhausting the worker.
const MAX_HELPER_REQUESTS = 5_000;
const MINUTE_MS = 60_000;

afterEach(() => {
  delete globalThis.browser;
});

// An entry `offsetMs` from `anchorMs` of about `chars` characters, ending in its id.
function entry(id, anchorMs, offsetMs, chars = 10) {
  return { memId: id, sessionId: 'persistent_chat', role: 'exchange', content: `[USER]: ${'u'.repeat(chars)}\n\n[AGENT]: done ${id}`, dateMs: anchorMs + offsetMs };
}

// `shuffleTies`: entries sharing a millisecond come back in a new order each
// request, as the helper gives no order among them.
function fakeHelper(entries, { previews = true, shuffleTies = false } = {}) {
  const stored = [...entries];
  const replies = { overCap: 0, largest: 0, calls: [] };
  const reply = result => {
    const bytes = Buffer.byteLength(JSON.stringify({ id: 1, result }), 'utf8');
    replies.largest = Math.max(replies.largest, bytes);
    if (bytes > NATIVE_MESSAGE_CAP_BYTES) {
      replies.overCap += 1;
      return { error: 'Native helper disconnected' };
    }
    return result;
  };
  const cut = (text, n) => (previews && Number.isInteger(n) && n > 0 ? [...text].slice(0, n).join('') : text);
  const bound = (v, none) => (v === undefined || v === '' || v === null ? none : v);
  globalThis.browser = {
    runtime: {
      sendMessage: vi.fn(async msg => {
        replies.calls.push(msg);
        if (replies.calls.length > MAX_HELPER_REQUESTS) throw new Error('runaway: too many helper requests');
        switch (msg.cmd) {
          case 'memorySearch': {
            if (msg.q !== '') throw new Error('memory_read only lists');
            const from = msg.ignoreDate ? -Infinity : bound(msg.from, -Infinity);
            const to = msg.ignoreDate ? Infinity : bound(msg.to, Infinity);
            return reply(stored
              .filter(e => e.dateMs >= from && e.dateMs <= to)
              .map(e => ({ e, tie: shuffleTies ? Math.random() : 0 }))
              .sort((a, b) => b.e.dateMs - a.e.dateMs || a.tie - b.tie)
              .map(({ e }) => e)
              .slice(0, msg.limit)
              .map(e => ({ ...e, content: cut(e.content, msg.previewChars), snippet: null, rank: 0 })));
          }
          case 'memoryRead':
            return reply(stored
              .filter(e => Math.abs(e.dateMs - msg.timestampMs) <= msg.toleranceMs)
              .sort((a, b) => a.dateMs - b.dateMs)
              .slice(0, 50));
          default:
            throw new Error(`unexpected helper command: ${msg.cmd}`);
        }
      }),
    },
  };
  return { stored, replies };
}

// The entries a result shows, by the id each one ends in, and whether each is whole.
const shownIds = result => [...result.matchAll(/done (\S+)\n?/g)].map(m => m[1]);
const sectionOf = (result, id) => result.split('--- Conversation from').find(s => s.includes(`done ${id}`));

describe('TB-194: memory_read and the native-messaging cap', () => {
  it('returns the 20 entries around the timestamp whole when 21 sessions of 200 KB are within ten minutes', async () => {
    const ts = Date.now() - 86_400_000;
    const entries = Array.from({ length: 50 }, (_, i) => entry(`k${i - 25}`, ts, (i - 25) * MINUTE_MS, 200_000));
    const helper = fakeHelper(entries);

    const result = await run({ timestamp: ts });
    expect(typeof result).toBe('string');
    // Within ±10 minutes: -10..10; the 20 centered on the timestamp, oldest first.
    expect(shownIds(result)).toEqual(Array.from({ length: 20 }, (_, i) => `k${i - 10}`));
    for (const id of shownIds(result)) {
      const whole = entries.find(e => e.memId === id).content;
      expect(sectionOf(result, id)).toContain(whole);
    }
    expect(helper.replies.overCap).toBe(0);
    // Each read asks for one millisecond.
    const reads = helper.replies.calls.filter(m => m.cmd === 'memoryRead');
    expect(reads).toHaveLength(20);
    expect(reads.every(m => m.toleranceMs === 0)).toBe(true);
    expect(helper.stored).toEqual(entries);
  });

  it('centers on the timestamp in a window of more than 50 entries', async () => {
    const ts = Date.now() - 86_400_000;
    // 200 a second apart, the timestamp at the 100th: the helper's own read
    // answered only the oldest 50, so the entries around it were never shown.
    const entries = Array.from({ length: 200 }, (_, i) => entry(`s${i - 100}`, ts, (i - 100) * 1000));
    fakeHelper(entries);

    expect(shownIds(await run({ timestamp: ts }))).toEqual(Array.from({ length: 20 }, (_, i) => `s${i - 10}`));
    expect(shownIds(await run({ timestamp: ts, max_turns: 5 }))).toEqual(['s-2', 's-1', 's0', 's1', 's2']);
  });

  it('returns at most 50 entries, as the helper read did', async () => {
    const ts = Date.now() - 86_400_000;
    fakeHelper(Array.from({ length: 200 }, (_, i) => entry(`s${i - 100}`, ts, (i - 100) * 1000)));
    expect(shownIds(await run({ timestamp: ts, max_turns: 500 }))).toHaveLength(50);
  });

  it('lists only as far back as it shows', async () => {
    const ts = Date.now() - 86_400_000;
    // A day of entries before the timestamp, a minute apart, and a wide window.
    const helper = fakeHelper(Array.from({ length: 1440 }, (_, i) => entry(`b${i}`, ts, -i * MINUTE_MS)));
    const result = await run({ timestamp: ts, tolerance_minutes: 2000 });
    expect(shownIds(result)).toEqual(Array.from({ length: 20 }, (_, i) => `b${19 - i}`));
    expect(helper.replies.calls.filter(m => m.cmd === 'memorySearch')).toHaveLength(1);
  });

  it('lists entries sharing one millisecond across a page boundary once each, and reads each whole', async () => {
    const ts = Date.now() - 86_400_000;
    const entries = [
      ...Array.from({ length: 15 }, (_, i) => entry(`after${i}`, ts, (i + 1) * 1000)),
      ...Array.from({ length: 30 }, (_, i) => entry(`tie${i}`, ts, 0)),
    ];
    const helper = fakeHelper(entries);
    const result = await run({ timestamp: ts, max_turns: 50 });
    const ids = shownIds(result);
    expect(ids).toHaveLength(45);
    expect(new Set(ids)).toEqual(new Set(entries.map(e => e.memId)));
    for (const e of entries) expect(sectionOf(result, e.memId)).toContain(e.content);
    // The 30 at one millisecond are read in one request.
    expect(helper.replies.calls.filter(m => m.cmd === 'memoryRead' && m.timestampMs === ts)).toHaveLength(1);
    expect(helper.replies.overCap).toBe(0);
  });

  it('lists each tied entry once whatever order the helper gives them in', async () => {
    const ts = Date.now() - 86_400_000;
    const entries = [
      ...Array.from({ length: 15 }, (_, i) => entry(`after${i}`, ts, (i + 1) * 1000)),
      ...Array.from({ length: 30 }, (_, i) => entry(`tie${i}`, ts, 0)),
      ...Array.from({ length: 10 }, (_, i) => entry(`before${i}`, ts, -(i + 1) * 1000)),
    ];
    fakeHelper(entries, { shuffleTies: true });
    for (let round = 0; round < 20; round++) {
      const ids = shownIds(await run({ timestamp: ts, max_turns: 50 }));
      expect(ids).toHaveLength(50);
      expect(new Set(ids).size).toBe(50);
    }
  });

  it('returns the newest max_turns when the timestamp is at the newest end of the window', async () => {
    const ts = Date.now() - 86_400_000;
    // 60 a second apart ending at the timestamp, and one a second after it.
    fakeHelper([...Array.from({ length: 60 }, (_, i) => entry(`y${i}`, ts, -i * 1000)), entry('after', ts, 1000)]);
    expect(shownIds(await run({ timestamp: ts, max_turns: 30 }))).toEqual([...Array.from({ length: 29 }, (_, i) => `y${28 - i}`), 'after']);
    // None after it, and max_turns one more than a page of 20.
    fakeHelper(Array.from({ length: 60 }, (_, i) => entry(`x${i}`, ts, -i * 1000)));
    expect(shownIds(await run({ timestamp: ts, max_turns: 21 }))).toEqual(Array.from({ length: 21 }, (_, i) => `x${20 - i}`));
  });

  it('uses the default max_turns for one that is not a number', async () => {
    const ts = Date.now() - 86_400_000;
    const helper = fakeHelper(Array.from({ length: 300 }, (_, i) => entry(`n${i - 150}`, ts, (i - 150) * 1000)));
    for (const max_turns of ['all', 'max', 'twenty', {}]) {
      helper.replies.calls.length = 0;
      expect(shownIds(await run({ timestamp: ts, max_turns }))).toEqual(Array.from({ length: 20 }, (_, i) => `n${i - 10}`));
      expect(helper.replies.calls.filter(m => m.cmd === 'memoryRead')).toHaveLength(20);
    }
  });

  it('leaves out an entry removed between the listing and its read', async () => {
    const ts = Date.now() - 86_400_000;
    const helper = fakeHelper([entry('a', ts, 0), entry('b', ts, 1000), entry('c', ts, 2000)]);
    const answer = browser.runtime.sendMessage.getMockImplementation();
    browser.runtime.sendMessage.mockImplementation(async msg => {
      const result = await answer(msg);
      if (msg.cmd === 'memorySearch') helper.stored.splice(helper.stored.findIndex(e => e.memId === 'b'), 1);
      return result;
    });
    expect(shownIds(await run({ timestamp: ts }))).toEqual(['a', 'c']);
    // Every entry listed is gone by its read.
    browser.runtime.sendMessage.mockImplementation(async msg => {
      const result = await answer(msg);
      if (msg.cmd === 'memorySearch') helper.stored.length = 0;
      return result;
    });
    expect(await run({ timestamp: ts })).toBe('No conversation found around this timestamp.');
  });

  it('works with a helper that lists whole entries (no previews), a page of 20 at a time', async () => {
    const ts = Date.now() - 86_400_000;
    const entries = Array.from({ length: 60 }, (_, i) => entry(`o${i - 30}`, ts, (i - 30) * 1000));
    const helper = fakeHelper(entries, { previews: false });
    const result = await run({ timestamp: ts, max_turns: 30 });
    expect(shownIds(result)).toEqual(Array.from({ length: 30 }, (_, i) => `o${i - 15}`));
    // Each request asks for 20 more than those already listed at its first
    // millisecond (here one), so a reply of whole entries stays small.
    const listings = helper.replies.calls.filter(c => c.cmd === 'memorySearch');
    expect(listings.length).toBeGreaterThanOrEqual(3);
    expect(listings.map(m => m.limit)).toEqual([20, ...listings.slice(1).map(() => 21)]);
  });

  it('uses the default window for a tolerance that is not a positive number', async () => {
    const ts = Date.now() - 86_400_000;
    const helper = fakeHelper([entry('near', ts, 5 * MINUTE_MS), entry('far', ts, 11 * MINUTE_MS)]);
    for (const tolerance_minutes of ['soon', -5, 0]) {
      expect(shownIds(await run({ timestamp: ts, tolerance_minutes }))).toEqual(['near']);
    }
    const listings = helper.replies.calls.filter(m => m.cmd === 'memorySearch');
    expect(listings.every(m => m.from === ts - 10 * MINUTE_MS && m.to === ts + 10 * MINUTE_MS)).toBe(true);
  });

  it('keeps a short positive tolerance: both bounds in, older and newer out, each whole and in order', async () => {
    const ts = Date.now() - 86_400_000;
    const helper = fakeHelper([
      entry('older', ts, -2 * MINUTE_MS),
      entry('lower', ts, -MINUTE_MS),
      entry('anchor', ts, 0),
      entry('upper', ts, MINUTE_MS),
      entry('newer', ts, 2 * MINUTE_MS),
    ]);
    const result = await run({ timestamp: ts, tolerance_minutes: 1 });
    expect(shownIds(result)).toEqual(['lower', 'anchor', 'upper']);
    for (const id of ['lower', 'anchor', 'upper']) expect(sectionOf(result, id)).toContain(`[USER]: ${'u'.repeat(10)}`);
    expect(helper.replies.calls.filter(m => m.cmd === 'memoryRead').map(m => m.timestampMs)).toEqual([ts - MINUTE_MS, ts, ts + MINUTE_MS]);
    expect(helper.stored.map(e => e.memId)).toEqual(['older', 'lower', 'anchor', 'upper', 'newer']);
  });

  it('reports a failed listing or read', async () => {
    const ts = Date.now() - 86_400_000;
    fakeHelper([entry('a', ts, 0)]);
    const answer = browser.runtime.sendMessage.getMockImplementation();
    for (const [cmd, failure] of [
      ['memorySearch', { error: 'Native helper disconnected' }],
      ['memorySearch', new Error('Could not establish connection')],
      ['memoryRead', { error: 'Native RPC timed out' }],
      ['memoryRead', new Error('Could not establish connection')],
    ]) {
      browser.runtime.sendMessage.mockImplementation(async msg => {
        if (msg.cmd !== cmd) return answer(msg);
        if (failure instanceof Error) throw failure;
        return failure;
      });
      const result = await run({ timestamp: ts });
      expect(result).toEqual({ error: `memory read failed: ${failure.message ?? failure.error}` });
    }
    // No answer at all (nothing handled the message) is a failure too, not an empty memory; a
    // listing that fails reads nothing.
    for (const cmd of ['memorySearch', 'memoryRead']) {
      browser.runtime.sendMessage.mockClear();
      browser.runtime.sendMessage.mockImplementation(async msg => (msg.cmd === cmd ? undefined : answer(msg)));
      expect(await run({ timestamp: ts })).toEqual({ error: 'memory read failed: invalid response format' });
      expect(browser.runtime.sendMessage.mock.calls.map(([m]) => m.cmd)).toEqual(cmd === 'memorySearch' ? ['memorySearch'] : ['memorySearch', 'memoryRead']);
    }
  });
});
