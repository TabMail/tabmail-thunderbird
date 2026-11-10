/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarToolDates.test.js: how the calendar create and edit tools read the
// dates they are given, from their `run`, with the real date reader. A bare
// date is that calendar date; a date that cannot be read is refused before
// the confirmation card, never replaced by a guess.

import { describe, it, expect, vi } from 'vitest';

globalThis.browser = {
  tmCalendar: {
    modifyCalendarEvent: vi.fn(async () => ({ ok: true })),
    createCalendarEvent: vi.fn(async () => ({ ok: true })),
    getCalendars: vi.fn(async () => ({ ok: true, calendars: [{ id: 'cal1', name: 'Personal' }] })),
    // A time change reads the event first (a repeating series is routed by its
    // occurrences); evt is an event that does not repeat.
    queryCalendarItems: vi.fn(async () => []),
    getCalendarEventDetails: vi.fn(async (eventId) => (eventId === 'evt' ? { ok: true, id: 'evt', isRecurring: false } : { ok: false, error: 'event not found' })),
  },
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

const { run: editRun } = await import('../chat/tools/calendar_event_edit.js');
const { run: createRun } = await import('../chat/tools/calendar_event_create.js');
const { ctx } = await import('../chat/modules/context.js');

let nextPid = 0;
async function runTool(run, args) {
  const pid = `pid-dates-${nextPid += 1}`;
  ctx.fsmSessions[pid] = {};
  ctx.state = null;
  await run(args, { callId: pid });
  await new Promise((r) => setTimeout(r, 5));
  return ctx.fsmSessions[pid];
}

// 2099 is the dated-test exception (never goes stale).
describe('the calendar tools read a bare date as that calendar date', () => {
  it('an edit naming bare dates reaches the card with those dates at midnight', async () => {
    const sess = await runTool(editRun, { event_id: 'evt', start_iso: '2099-10-20', end_iso: '2099-10-21', recurrence_id: '2099-10-06' });
    expect(sess.failReason).toBeUndefined();
    expect(sess.editEventArgs).toMatchObject({ start_iso: '2099-10-20T00:00:00', end_iso: '2099-10-21T00:00:00', recurrence_id: '2099-10-06T00:00:00' });
  });

  it('a create naming bare dates reaches the card with those dates at midnight', async () => {
    const sess = await runTool(createRun, { title: 'Offsite', all_day: true, start_iso: '2099-10-20', end_iso: '2099-10-21' });
    expect(sess.failReason).toBeUndefined();
    expect(JSON.stringify(sess)).toContain('2099-10-20T00:00:00');
    expect(JSON.stringify(sess)).toContain('2099-10-21T00:00:00');
  });
});

describe('a date the calendar tools cannot read is refused before the card', () => {
  for (const field of ['start_iso', 'end_iso', 'recurrence_id']) {
    it(`an edit whose ${field} is not a date fails, naming the field and the value`, async () => {
      const sess = await runTool(editRun, { event_id: 'evt', title: 'Renamed', [field]: 'next tuesday-ish' });
      expect(sess.failReason).toBe(`${field} "next tuesday-ish" is not a date and time the calendar can read. Use YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD for a date, then retry.`);
      expect(ctx.state).toBe('exec_fail');
      expect(sess.editEventArgs).toBeUndefined();
    });
  }

  for (const field of ['start_iso', 'end_iso']) {
    it(`a create whose ${field} is not a date fails, naming the field and the value`, async () => {
      const sess = await runTool(createRun, { title: 'Offsite', start_iso: '2099-10-20T09:00:00', end_iso: '2099-10-20T10:00:00', [field]: '2099-13-45' });
      expect(sess.failReason).toBe(`${field} "2099-13-45" is not a date and time the calendar can read. Use YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD for a date, then retry.`);
      expect(ctx.state).toBe('exec_fail');
    });
  }

  it('a date and time the tools can read is not refused', async () => {
    const edit = await runTool(editRun, { event_id: 'evt', start_iso: '2099-10-20T15:00:00Z' });
    expect(edit.failReason).toBeUndefined();
    const create = await runTool(createRun, { title: 'Sync', start_iso: '2099-10-20T15:00:00', end_iso: '2099-10-20T16:00:00' });
    expect(create.failReason).toBeUndefined();
  });
});
