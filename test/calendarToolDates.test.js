/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarToolDates.test.js: how the calendar create and edit tools read the
// dates they are given, from their `run`, with the real date reader. A bare
// date is that calendar date; a date that cannot be read is refused before
// the confirmation card, never replaced by a guess.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import ICAL from './fixtures/mozilla/Ical.sys.mjs';

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
const { CHAT_SETTINGS } = await import('../chat/modules/chatConfig.js');

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
      expect(sess.failReason).toBe(`${field} "next tuesday-ish" is not a date and time the calendar can read. Use YYYY-MM-DDTHH:MM:SS (followed by its offset, e.g. " (UTC-4)", only when calendar_event_read shows one), or YYYY-MM-DD for a date, then retry.`);
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

// A time given with a `timezone` is that zone's wall clock. The computer's
// own clock changes never move it: a time in the computer's own skipped hour
// exists in the named zone and reaches the calendar as given (#385).
describe('a time given in another zone keeps its digits on the computer\'s own clock change', () => {
  const DAYS_SEARCHED = 800;
  const COMPUTER = 'America/Los_Angeles';
  const NAMED = 'Australia/Sydney';
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayDigits = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;

  // Run `fn` with the process on `zone`'s clock.
  function onClock(zone, fn) {
    const was = process.env.TZ;
    process.env.TZ = zone;
    try { return fn(); } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  }

  // The first wall time from today at half past an hour that `zone`'s clocks
  // skip, as "YYYY-MM-DDTHH:30:00".
  function skippedWallTime(zone) {
    return onClock(zone, () => {
      const today = new Date();
      for (let i = 0; i < DAYS_SEARCHED; i += 1) {
        const noon = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i, 12);
        for (let h = 0; h < 24; h += 1) {
          const at = new Date(noon.getFullYear(), noon.getMonth(), noon.getDate(), h, 30);
          if (at.getHours() !== h) return `${dayDigits(noon)}T${pad2(h)}:30:00`;
        }
      }
      throw new Error(`no skipped hour in ${zone}`);
    });
  }

  // Whether `naive` exists on `zone`'s clock (reads back as the same digits).
  const existsIn = (naive, zone) => onClock(zone, () => {
    const at = new Date(naive);
    return `${dayDigits(at)}T${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}` === naive;
  });

  const inComputersGap = skippedWallTime(COMPUTER);
  const endOf = (naive) => naive.replace(/T(\d{2})/, (_, h) => `T${pad2(Number(h) + 1)}`);

  // The tools run on the computer's clock for every test below (they read
  // the dates a frame later, so the zone stays set for the whole run).
  let was;
  beforeAll(() => { was = process.env.TZ; process.env.TZ = COMPUTER; });
  afterAll(() => {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  });

  it('the computer skips the given time and the named zone has it', () => {
    expect(existsIn(inComputersGap, COMPUTER)).toBe(false);
    expect(existsIn(inComputersGap, NAMED)).toBe(true);
  });

  it('an edit reaches the card with the time as given in the named zone', async () => {
    const sess = await runTool(editRun, { event_id: 'evt', start_iso: inComputersGap, end_iso: endOf(inComputersGap), timezone: NAMED });
    expect(sess.failReason).toBeUndefined();
    expect(sess.editEventArgs).toMatchObject({ start_iso: inComputersGap, end_iso: endOf(inComputersGap), timezone: NAMED });
  });

  it('an edit of the end alone reaches the card with the end as given in the named zone', async () => {
    const sess = await runTool(editRun, { event_id: 'evt', end_iso: inComputersGap, timezone: NAMED });
    expect(sess.failReason).toBeUndefined();
    expect(sess.editEventArgs).toMatchObject({ end_iso: inComputersGap, timezone: NAMED });
  });

  it('a create reaches the card with the time as given in the named zone', async () => {
    const sess = await runTool(createRun, { title: 'Sync', start_iso: inComputersGap, end_iso: endOf(inComputersGap), timezone: NAMED });
    expect(sess.failReason).toBeUndefined();
    expect(sess.createEventArgs).toMatchObject({ start_iso: inComputersGap, end_iso: endOf(inComputersGap), timezone: NAMED });
  });
});

// A create given in a named zone with no end lasts the default length from
// its start in that zone, whatever the computer's own zone (#393). The end is
// that zone's wall clock, as the start is, so the card and the calendar read
// both in the same zone. The oracle reads each value on the named zone's own
// clock (the process zone set to it), not through the tool's zone arithmetic.
describe('a create in another zone with no end ends the default length after its start in that zone', () => {
  const NAMED = 'Europe/London';
  const COMPUTERS = ['America/Los_Angeles', 'Asia/Tokyo'];
  const DAYS_AHEAD = 30;
  const DAYS_SEARCHED = 800;
  const MINUTE_MS = 60 * 1000;
  const minutes = CHAT_SETTINGS.createEventDefaultDurationMinutes;
  const pad2 = (n) => String(n).padStart(2, '0');
  const NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

  async function onClockAsync(zone, fn) {
    const was = process.env.TZ;
    process.env.TZ = zone;
    try { return await fn(); } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  }
  function onClock(zone, fn) {
    const was = process.env.TZ;
    process.env.TZ = zone;
    try { return fn(); } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  }
  const naiveOf = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
  // The instant `naive` names on `zone`'s clock.
  const instantIn = (zone, naive) => onClock(zone, () => new Date(naive).getTime());

  // 10:00 on the named zone's clock, DAYS_AHEAD days from today.
  const plainStart = onClock(NAMED, () => {
    const t = new Date();
    return naiveOf(new Date(t.getFullYear(), t.getMonth(), t.getDate() + DAYS_AHEAD, 10));
  });
  // Half an hour before the named zone's next spring-forward: the default
  // length crosses the skipped hour, so its end on the clock is an hour later
  // than the start's digits plus the length.
  const beforeSkippedHour = onClock(NAMED, () => {
    const t = new Date();
    for (let i = 0; i < DAYS_SEARCHED; i += 1) {
      for (let h = 1; h < 24; h += 1) {
        const at = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i, h, 30);
        if (at.getHours() !== h) return naiveOf(new Date(t.getFullYear(), t.getMonth(), t.getDate() + i, h - 1, 30));
      }
    }
    throw new Error(`no skipped hour in ${NAMED}`);
  });

  it('the start before the skipped hour is crossed by the default length', () => {
    const start = instantIn(NAMED, beforeSkippedHour);
    const end = onClock(NAMED, () => naiveOf(new Date(start + minutes * MINUTE_MS)));
    const byDigits = onClock('UTC', () => naiveOf(new Date(new Date(`${beforeSkippedHour}Z`).getTime() + minutes * MINUTE_MS)));
    expect(end).not.toBe(byDigits);
  });

  for (const computer of COMPUTERS) {
    for (const [label, startIso] of [['an ordinary day', plainStart], ['a start just before the zone skips an hour', beforeSkippedHour]]) {
      it(`on a computer in ${computer}, ${label}: the end is the start in ${NAMED} plus the default length`, async () => {
        const sess = await onClockAsync(computer, () => runTool(createRun, { title: 'Sync', start_iso: startIso, timezone: NAMED }));
        expect(sess.failReason).toBeUndefined();
        const args = sess.createEventArgs;
        expect(args).toMatchObject({ start_iso: startIso, timezone: NAMED });
        // The calendar reads an end with Z as that instant, one without as the
        // named zone's wall clock (toCalIDateTime).
        const endAt = /Z$/.test(args.end_iso) ? Date.parse(args.end_iso) : instantIn(NAMED, args.end_iso);
        expect(endAt - instantIn(NAMED, args.start_iso)).toBe(minutes * MINUTE_MS);
        // The card prints the end on the named zone's clock, as the start.
        expect(args.end_iso).toMatch(NAIVE);
      });
    }
  }
});

// Around a clock change of the named zone, the default end is read as
// Thunderbird's calendar reads the start and the end it is given: through
// Thunderbird's own ical.js (test/fixtures/mozilla), in a zone with New York's
// rules (the clocks skip 02:00-03:00 on 8 March 2099 and repeat 01:00-02:00 on
// 1 November 2099; 2099 is the dated-test exception). A start the clocks
// repeat is their second pass there, one they skip takes the offset after the
// change. Each event lasts the default length as the calendar stores it.
describe('a create in another zone with no end lasts the default length as the calendar reads it, across the zone\'s clock changes', () => {
  const NAMED = 'America/New_York';
  const COMPUTER = 'America/Los_Angeles';
  const minutes = CHAT_SETTINGS.createEventDefaultDurationMinutes;
  const zone = new ICAL.Timezone({
    tzid: NAMED,
    component: new ICAL.Component(ICAL.parse([
      'BEGIN:VTIMEZONE', `TZID:${NAMED}`,
      'BEGIN:DAYLIGHT', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD',
      'END:VTIMEZONE', '',
    ].join('\r\n'))),
  });
  // The instant the calendar stores for `naive` placed in the zone.
  const storedAt = (naive) => {
    const [y, mo, d, h, mi, s] = naive.split(/[-T:]/).map(Number);
    return new ICAL.Time({ year: y, month: mo, day: d, hour: h, minute: mi, second: s, isDate: false }, zone).toUnixTime() * 1000;
  };

  const cases = [
    ['an ordinary day', '2099-06-15T10:00:00'],
    ['a start before the skipped hour, the length crossing it', '2099-03-08T01:30:00'],
    ['a start in the skipped hour', '2099-03-08T02:30:00'],
    ['a start in the repeated hour', '2099-11-01T01:30:00'],
    ['a start after the repeated hour', '2099-11-01T02:15:00'],
  ];
  for (const [label, startIso] of cases) {
    it(`${label}: the stored event lasts the default length`, async () => {
      const was = process.env.TZ;
      process.env.TZ = COMPUTER;
      let sess;
      try { sess = await runTool(createRun, { title: 'Sync', start_iso: startIso, timezone: NAMED }); } finally {
        if (was === undefined) delete process.env.TZ;
        else process.env.TZ = was;
      }
      expect(sess.failReason).toBeUndefined();
      const args = sess.createEventArgs;
      expect(args.start_iso).toBe(startIso);
      expect(args.end_iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(storedAt(args.end_iso) - storedAt(args.start_iso)).toBe(minutes * 60 * 1000);
    });
  }
});
