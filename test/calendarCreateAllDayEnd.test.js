/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarCreateAllDayEnd.test.js: an all-day create whose end is on or before
// its start would write a zero-length event (an all-day end is the day after
// the last day). From the create tool's `run`, with the real argument reader,
// against the real calendar bridge: it fails before the confirmation card and
// nothing is written; the bridge's own create refuses it too.

// West of UTC, so the user's zone is not UTC.
process.env.TZ = 'America/Vancouver';

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

globalThis.browser = {
  tmCalendar: {},
  storage: { local: { get: vi.fn(async () => ({ defaultCalendarId: 'cal1' })), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => undefined) },
};
globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../chat/modules/helpers.js', async () => {
  const actual = await vi.importActual('../chat/modules/helpers.js');
  return { toNaiveIso: actual.toNaiveIso, toIsoNoMs: actual.toIsoNoMs, streamText: vi.fn() };
});
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: vi.fn(async () => ({ textContent: '', classList: { add: vi.fn(), remove: vi.fn() } })) }));
vi.mock('../chat/modules/context.js', () => ({
  ctx: { activePid: 0, awaitingPid: 0, activeToolCallId: null, fsmSessions: Object.create(null), state: null, toolExecutionMode: null, rawUserTexts: ['original request'] },
  initFsmSession: vi.fn(),
}));
vi.mock('../chat/fsm/core.js', () => ({ executeAgentAction: vi.fn(async () => {}) }));

const { loadCalendarBridge } = await import('./helpers/calendarBridgeHarness.js');
const { run } = await import('../chat/tools/calendar_event_create.js');
const { ctx } = await import('../chat/modules/context.js');

const REFUSAL = /^an all-day event's end_iso is the day after its last day, so it must be later than start_iso/;

let nextPid = 0;
// Runs the tool to the point it either fails or stores the event for the card.
async function runCreate(args) {
  const loaded = loadCalendarBridge(bridgeUrl, { items: [] });
  globalThis.browser.tmCalendar = loaded.api;
  const pid = `pid-create-${nextPid += 1}`;
  ctx.fsmSessions[pid] = {};
  ctx.state = null;
  await run({ title: 'Offsite', calendar_id: 'cal1', ...args }, { callId: pid });
  await new Promise((r) => setTimeout(r, 5));
  return { sess: ctx.fsmSessions[pid], loaded };
}

// 2099 is the dated-test exception (never goes stale).
describe('calendar_event_create against the real bridge, before the confirmation card', () => {
  for (const [name, args] of [
    ['its end on its start, as bare dates', { start_iso: '2099-10-20', end_iso: '2099-10-20' }],
    ['its end on its start, at midnight', { start_iso: '2099-10-20T00:00:00', end_iso: '2099-10-20T00:00:00' }],
    ['its end later the same day', { start_iso: '2099-10-20T09:00:00', end_iso: '2099-10-20T17:00:00' }],
    ['its end before its start', { start_iso: '2099-10-20', end_iso: '2099-10-18' }],
  ]) {
    it(`an all-day event with ${name} fails with what to send instead, and nothing is written`, async () => {
      const { sess, loaded } = await runCreate({ all_day: true, ...args });
      expect(sess.failReason).toMatch(REFUSAL);
      expect(ctx.state).toBe('exec_fail');
      expect(sess.createEventArgs).toBeUndefined();
      expect(loaded.calendar.items).toHaveLength(0);
    });
  }

  for (const [name, args] of [
    ['an all-day event ending the day after its start', { all_day: true, start_iso: '2099-10-20', end_iso: '2099-10-21' }],
    ['an all-day event over three days', { all_day: true, start_iso: '2099-10-20T00:00:00', end_iso: '2099-10-23T00:00:00' }],
    ['an all-day event given no end', { all_day: true, start_iso: '2099-10-20' }],
    ['a timed event', { start_iso: '2099-10-20T09:00:00', end_iso: '2099-10-20T10:00:00' }],
  ]) {
    it(`${name} reaches the card, with nothing written yet`, async () => {
      const { sess, loaded } = await runCreate(args);
      expect(sess.failReason).toBeUndefined();
      expect(sess.createEventArgs).toMatchObject({ title: 'Offsite' });
      expect(sess.createEventArgs).not.toHaveProperty('check_only');
      expect(loaded.calendar.items).toHaveLength(0);
    });
  }
});

describe('the bridge\'s create', () => {
  it('refuses an all-day event whose end is on its start, and writes nothing', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [] });
    const res = await api.createCalendarEvent({ title: 'Offsite', calendar_id: 'cal1', all_day: true, start_iso: '2099-10-20T00:00:00', end_iso: '2099-10-20T00:00:00' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(REFUSAL);
    expect(calendar.items).toHaveLength(0);
  });

  it('writes an all-day event ending the day after its start, as dates', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [] });
    const res = await api.createCalendarEvent({ title: 'Offsite', calendar_id: 'cal1', all_day: true, start_iso: '2099-10-20T00:00:00', end_iso: '2099-10-21T00:00:00' });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(calendar.items).toHaveLength(1);
    if (calendar.items.length !== 1) return;
    expect(calendar.items[0].startDate.isDate).toBe(true);
    expect(calendar.items[0].endDate.compare(calendar.items[0].startDate)).toBeGreaterThan(0);
  });

  it('asked only to check, writes nothing for an event it would make', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [] });
    const res = await api.createCalendarEvent({ calendar_id: 'cal1', all_day: true, start_iso: '2099-10-20T00:00:00', end_iso: '2099-10-21T00:00:00', check_only: true });
    expect(res).toEqual({ ok: true });
    expect(calendar.items).toHaveLength(0);
  });
});
