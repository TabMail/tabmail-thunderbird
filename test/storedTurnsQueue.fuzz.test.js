/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// storedTurnsQueue.fuzz.test.js — the stored chat turns' queue
// (chat/modules/storedTurnsQueue.js) driven by a seeded generator: changes
// (append, remove, keep from a time, update, clear) sent at random times,
// every storage call failing or slowed (past the read's time limit too) at
// random, and the background restarting whenever no storage call is under way.
// A change counts as accepted once a saved queue held it. Invariants:
//
// - Q1 (in order, once): settled, the stored turns are what applying every
//   accepted change, once each, in the order sent, gives; nothing else is
//   applied.
// - Q2 (nothing left): settled, the saved queue is empty.
// - Q3 (one writer at a time): writes of the stored turns never overlap.
// - Q4 (truthful replies): a change answered as applied or queued was accepted;
//   one refused was not, unless the refusal said it was not confirmed in time.
//
// A failure names its seed and step; STORED_TURNS_FUZZ_SEEDS runs more seeds.

import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}), getAllKeys: vi.fn(async () => []),
}));

const seeds = Number(process.env.STORED_TURNS_FUZZ_SEEDS ?? 150);
const steps = 80;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const copy = value => (value === undefined ? undefined : structuredClone(value));

class Run {
  constructor(seed) {
    this.next = random(seed);
    this.data = {};
    this.failRate = this.next() * 0.3;
    this.slowRate = this.next() * 0.4;
    this.faulty = true;
    this.inFlight = 0;
    this.turnWrites = 0;
    this.maxTurnWrites = 0;
    this.everSaved = new Set();
    this.sent = []; // [{ id, op }] in the order sent
    this.replies = new Map();
    this.turnCount = 0;
    this.log = [];
  }

  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }

  storage() {
    const run = this;
    const call = async (kind, keys, act) => {
      run.inFlight += 1;
      const writesTurns = kind !== 'get' && (kind === 'remove' ? [keys].flat().includes('chat_turns') : 'chat_turns' in keys);
      if (writesTurns) {
        run.turnWrites += 1;
        run.maxTurnWrites = Math.max(run.maxTurnWrites, run.turnWrites);
      }
      try {
        if (run.faulty && run.next() < run.slowRate) {
          await new Promise(resolve => setTimeout(resolve, Math.floor(run.next() * 2 * run.settings.turnsQueue.applyTimeoutMs)));
        }
        if (run.faulty && run.next() < run.failRate) throw new Error(`synthetic ${kind} failure`);
        return act();
      } finally {
        run.inFlight -= 1;
        if (writesTurns) run.turnWrites -= 1;
      }
    };
    return {
      get: keys => call('get', keys, () => {
        const list = typeof keys === 'string' ? [keys] : keys;
        return Object.fromEntries(list.filter(k => k in run.data).map(k => [k, copy(run.data[k])]));
      }),
      set: values => call('set', values, () => {
        for (const [k, v] of Object.entries(values)) run.data[k] = copy(v);
        if ('chat_turns_pending' in values) for (const item of values.chat_turns_pending) run.everSaved.add(item.id);
      }),
      remove: keys => call('remove', keys, () => {
        for (const k of [keys].flat()) delete run.data[k];
      }),
    };
  }

  async start() {
    vi.resetModules();
    this.store = await import('../chat/modules/persistentChatStore.js');
    ({ CHAT_SETTINGS: this.settings } = await import('../chat/modules/chatConfig.js'));
    this.queue = await import('../chat/modules/storedTurnsQueue.js');
  }

  op() {
    const known = Array.from({ length: this.turnCount }, (_, i) => `t${i}`);
    const roll = this.next();
    if (roll < 0.45 || known.length === 0) {
      const append = Array.from({ length: 1 + Math.floor(this.next() * 2) }, () => {
        const n = this.turnCount++;
        return { _id: `t${n}`, _ts: (n + 1) * 10, _chars: 1 };
      });
      return { append };
    }
    if (roll < 0.65) return { remove: [this.pick(known), this.pick(known)] };
    if (roll < 0.8) return { update: [{ _id: this.pick(known), _ts: 1, _chars: 1, _refs: [`r${this.sent.length}`] }] };
    if (roll < 0.95) return { keepFrom: Math.floor(this.next() * (this.turnCount + 1) * 10) };
    return { clear: true };
  }

  send() {
    const id = `change-${this.sent.length}`;
    const op = this.op();
    this.sent.push({ id, op });
    this.log.push(`send ${id} ${JSON.stringify(op)}`);
    this.queue.enqueueTurnsChange(op, id).then(reply => this.replies.set(id, reply));
  }

  // Stop the background (its timers with it) and start it again.
  async restart() {
    this.log.push('restart');
    this.restarts = (this.restarts || 0) + 1;
    vi.clearAllTimers();
    await this.start();
  }
}

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.browser;
});

test(`the stored turns' queue applies every accepted change once, in order, through failures, delays and restarts (${seeds} seeds)`, { timeout: 600000 }, async () => {
  // What the seeds exercised, so a generator that stops reaching a case fails.
  const seen = { restarts: 0, sent: 0, accepted: 0, applied: 0, queued: 0, refused: 0, unconfirmed: 0 };
  for (let seed = 1; seed <= seeds; seed += 1) {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const run = new Run(seed);
    const fail = message => {
      throw new Error(`seed ${seed}: ${message}\n${run.log.slice(-30).join('\n')}`);
    };
    globalThis.browser = {
      storage: { local: run.storage() },
      alarms: { onAlarm: { addListener() {} }, create: async () => {}, clear: async () => {}, get: async () => undefined },
    };
    await run.start();

    for (let step = 0; step < steps; step += 1) {
      const roll = run.next();
      if (roll < 0.6) run.send();
      await vi.advanceTimersByTimeAsync(Math.floor(run.next() * 3000));
      if (roll > 0.95 && run.inFlight === 0) await run.restart();
      if (run.maxTurnWrites > 1) fail(`step ${step}: overlapping writes of the stored turns (Q3)`);
    }

    // Settle: storage works again.
    run.faulty = false;
    for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(run.settings.turnsQueue.retryDelayMs);

    let expected = [];
    for (const { id, op } of run.sent) {
      if (run.everSaved.has(id)) expected = run.store.applyTurnsOperation(expected, op).turns;
    }
    const stored = run.data.chat_turns || [];
    if (JSON.stringify(stored) !== JSON.stringify(expected)) {
      fail(`stored ${JSON.stringify(stored.map(t => t._id))}, expected ${JSON.stringify(expected.map(t => t._id))} (Q1)`);
    }
    if ((run.data.chat_turns_pending || []).length !== 0) fail(`saved queue not empty: ${JSON.stringify(run.data.chat_turns_pending)} (Q2)`);
    if (run.maxTurnWrites > 1) fail('overlapping writes of the stored turns (Q3)');
    for (const [id, reply] of run.replies) {
      if ((reply.applied || reply.queued) && !run.everSaved.has(id)) fail(`${id} answered ${JSON.stringify(reply)} but never saved (Q4)`);
      if (reply.error && reply.error !== run.queue.CHANGE_UNCONFIRMED && run.everSaved.has(id)) fail(`${id} refused (${reply.error}) but saved (Q4)`);
    }
    seen.restarts += run.restarts || 0;
    seen.sent += run.sent.length;
    seen.accepted += run.sent.filter(({ id }) => run.everSaved.has(id)).length;
    for (const reply of run.replies.values()) {
      if (reply.applied) seen.applied += 1;
      else if (reply.queued) seen.queued += 1;
      else if (reply.error === run.queue.CHANGE_UNCONFIRMED) seen.unconfirmed += 1;
      else seen.refused += 1;
    }
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  expect(seeds).toBeGreaterThan(0);
  if (process.env.STORED_TURNS_FUZZ_STATS) process.stdout.write(`${JSON.stringify(seen)}\n`);
  if (seeds >= 50) {
    for (const [name, count] of Object.entries(seen)) expect(count, name).toBeGreaterThan(seeds / 10);
    expect(seen.accepted).toBeLessThan(seen.sent);
  }
});
