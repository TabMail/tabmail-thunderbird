/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarCardAllDayDates.test.js: every calendar confirmation card (edit,
// delete, create) prints an all-day value as a DATE, `<Weekday> YYYY/MM/DD`,
// read from its own day digits, with no time and no zone, and an all-day end
// as the last day (the stored end is the day after it), never before the
// start, as Google Calendar shows one. A DATE's epoch is midnight UTC (or in
// its zone), so reading it as an instant named the previous day west of UTC.
// A timed event's card lines are unchanged. Through the real bridge on
// Thunderbird's own dates (test/fixtures/mozilla), the real tools and the real
// card states, once with the user west of UTC and once east of it.

process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import ICAL from './fixtures/mozilla/Ical.sys.mjs';

globalThis.browser = {
  tmCalendar: {},
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => undefined) },
};
globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/helpers.js', async () => {
  const actual = await vi.importActual('../chat/modules/helpers.js');
  return { ...actual, streamText: vi.fn() };
});
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chatlink/modules/fsm.js', () => ({ relayFsmConfirmation: vi.fn() }));
vi.mock('../chat/modules/context.js', () => ({
  ctx: {
    activePid: 0, awaitingPid: 0, activeToolCallId: null,
    fsmSessions: Object.create(null), state: null, toolExecutionMode: null, rawUserTexts: ['original request'],
  },
  initFsmSession: vi.fn(),
}));
vi.mock('../chat/modules/markdown.js', () => ({ attachSpecialLinkListeners: vi.fn(), renderMarkdown: vi.fn() }));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: vi.fn(async () => ({ textContent: '', classList: { add: vi.fn(), remove: vi.fn() } })) }));
vi.mock('../chat/fsm/core.js', () => ({ executeAgentAction: vi.fn(async () => {}) }));

const { loadCalendarBridge, fakeDate, fakeEvent, fakeRecurrenceInfo, recurrenceItem } = await import('./helpers/calendarBridgeHarness.js');
const { run: runEdit } = await import('../chat/tools/calendar_event_edit.js');
const { run: runDelete } = await import('../chat/tools/calendar_event_delete.js');
const { run: runCreate } = await import('../chat/tools/calendar_event_create.js');
const { runStateEditCalendarEventList } = await import('../chat/fsm/calendarEdit.js');
const { runStateDeleteCalendarEventList } = await import('../chat/fsm/calendarDelete.js');
const { runStateCreateCalendarEventList } = await import('../chat/fsm/calendarCreate.js');
const { streamText, formatTimestampForAgent, formatNaiveIsoInTimezone, formatCardTime } = await import('../chat/modules/helpers.js');
const { ctx } = await import('../chat/modules/context.js');
const { checked } = await import('./helpers/calendarSchemaCheck.js');

// ---------- Thunderbird's own dates (as calendarRecurrenceNative.test.js) ----------
class NativeZone {
  constructor(innerObject) { this.innerObject = innerObject; this.wrappedJSObject = this; }
  get tzid() { return this.innerObject.tzid; }
}
const nativeScope = vm.createContext({
  ICAL,
  Components: { ID: (x) => x },
  ChromeUtils: {
    generateQI: () => () => {},
    defineESModuleGetters(target) { target.CalTimezone = NativeZone; },
  },
});
vm.runInContext(readFileSync(resolve('test/fixtures/mozilla/CalDateTime.sys.mjs'), 'utf8')
  .replace('import ICAL from "resource:///modules/calendar/Ical.sys.mjs";', '')
  .replace('export function CalDateTime', 'function CalDateTime'), nativeScope);
const NativeDateTime = nativeScope.CalDateTime;

function vtimezone(tzid, daylight, standard) {
  return new ICAL.Timezone({
    tzid,
    component: new ICAL.Component(ICAL.parse([
      'BEGIN:VTIMEZONE', `TZID:${tzid}`,
      'BEGIN:DAYLIGHT', ...daylight, 'END:DAYLIGHT',
      'BEGIN:STANDARD', ...standard, 'END:STANDARD',
      'END:VTIMEZONE', '',
    ].join('\r\n'))),
  });
}

// The user's zone, in Thunderbird and in the process (the card's own clock).
const ZONES = [
  {
    name: 'west of UTC', tz: 'America/Los_Angeles',
    zone: vtimezone('America/Los_Angeles',
      ['DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700'],
      ['DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800']),
  },
  {
    name: 'east of UTC', tz: 'Asia/Tokyo',
    zone: vtimezone('Asia/Tokyo',
      ['DTSTART:20070101T000000', 'RRULE:FREQ=YEARLY;BYMONTH=1;BYDAY=1SU', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900'],
      ['DTSTART:20070701T000000', 'RRULE:FREQ=YEARLY;BYMONTH=7;BYDAY=1SU', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900']),
  },
];

// ---------- Days relative to today, a month out ----------
const pad2 = (n) => String(n).padStart(2, '0');
function dayDate(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 30 + n);
  return d;
}
const day = (n) => { const d = dayDate(n); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// The card's date for day n: the weekday from the local calendar at noon (an
// oracle independent of the formatter, which reads digits only).
const cardDate = (n) => `${WEEKDAYS[dayDate(n).getDay()]} ${day(n).replaceAll('-', '/')}`;
const midnight = (n) => `${day(n)}T00:00:00`;
const at = (n, hour) => `${day(n)}T${pad2(hour)}:00:00`;

const parts = (n) => { const [year, month, d] = day(n).split('-').map(Number); return { year, month, day: d }; };
// A plain DATE (no zone, as Google sync, Thunderbird's dialog and TabMail write
// one) and a DATE in the user's zone (as older TabMail and some apps did).
const KINDS = [
  { kind: 'plain DATE', zoneOf: () => ICAL.Timezone.localTimezone },
  { kind: 'zoned DATE', zoneOf: (zone) => zone },
];
const dateOn = (n, zone) => new NativeDateTime(new ICAL.Time({ ...parts(n), isDate: true }, zone));
const timeOn = (n, hour, zone) => new NativeDateTime(new ICAL.Time({ ...parts(n), hour, minute: 0, second: 0, isDate: false }, zone));

const allDayEvent = (zone, lastDay = 0) => fakeEvent({ id: 'evt', title: 'Holiday', startDate: dateOn(0, zone), endDate: dateOn(lastDay + 1, zone) });

// The harness's own dates: its recurrence code does not take Thunderbird's.
function harnessLoaded(items) {
  const loaded = loadCalendarBridge(resolve('chat/experiments/tmCalendar/tmCalendar.sys.mjs'), { items });
  globalThis.browser.tmCalendar = checked(loaded.api, []);
  return loaded;
}

function nativeLoaded(items, zone) {
  const loaded = loadCalendarBridge(resolve('chat/experiments/tmCalendar/tmCalendar.sys.mjs'), { items });
  const fakeCc = loaded.ctx.Cc;
  loaded.ctx.Cc = new Proxy({}, {
    get: (_t, key) => (key === '@mozilla.org/calendar/datetime;1' ? { createInstance: () => new NativeDateTime() } : fakeCc[key]),
  });
  const { cal } = loaded.ctx.ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');
  cal.timezoneService.UTC = new NativeZone(ICAL.Timezone.utcTimezone);
  cal.timezoneService.floating = new NativeZone(ICAL.Timezone.localTimezone);
  cal.timezoneService.defaultTimezone = new NativeZone(zone);
  // The user's zone, and the other test zone for an edit given another `timezone`.
  cal.timezoneService.getTimezone = (tzid) => {
    const known = ZONES.find((z) => z.tz === tzid);
    return known ? new NativeZone(known.zone) : null;
  };
  globalThis.browser.tmCalendar = checked(loaded.api, []);
  return loaded;
}

let nextPid = 0;
async function cardOf(runTool, runState, args, startsWith) {
  const pid = `pid-card-${nextPid += 1}`;
  ctx.fsmSessions[pid] = {};
  ctx.state = null;
  ctx.activePid = pid;
  streamText.mockClear();
  try {
    await runTool(args, { callId: pid });
    await new Promise((r) => setTimeout(r, 5));
    expect(ctx.fsmSessions[pid].failReason).toBeUndefined();
    streamText.mockClear();
    await runState();
  } finally {
    ctx.activePid = 0;
  }
  const text = streamText.mock.calls.map((c) => String(c[1])).find((t) => t.startsWith(startsWith));
  expect(text).toBeTruthy();
  return text;
}

async function editCard(items, zone, args) {
  const loaded = zone ? nativeLoaded(items, zone) : harnessLoaded(items);
  const text = await cardOf(runEdit, runStateEditCalendarEventList, { event_id: 'evt', calendar_id: 'cal1', ...args }, 'I found this calendar event');
  expect(loaded.modifications).toHaveLength(0);
  const [details, changes] = text.split('Proposed changes:');
  return { details, changes, text };
}

async function deleteCard(items, zone) {
  const loaded = nativeLoaded(items, zone);
  const text = await cardOf(runDelete, runStateDeleteCalendarEventList, { event_id: 'evt', calendar_id: 'cal1' }, 'I found this calendar event');
  expect(loaded.deletions).toHaveLength(0);
  return text;
}

async function createCard(zone, args) {
  const loaded = nativeLoaded([], zone);
  const text = await cardOf(runCreate, runStateCreateCalendarEventList, { calendar_id: 'cal1', title: 'Holiday', ...args }, "I'm ready to create");
  expect(loaded.calendar.items).toHaveLength(0);
  return text;
}

const line = (text, label) => (text.match(new RegExp(`^${label}: .*$`, 'm')) || [])[0] || null;
// A change on the edit card: the bold label and the line after it.
function change(changes, label) {
  const at = changes.split('\n').findIndex((l) => l === `**${label}:**`);
  return at < 0 ? null : changes.split('\n')[at + 1];
}
// No Start or End line on a card names a time of day or a zone.
function expectDatesOnly(text) {
  const startEnd = text.split('\n').filter((l, i, all) => /^(Start|End)/.test(l) || /^\*\*(Start|End)/.test(all[i - 1] || ''));
  expect(startEnd.length).toBeGreaterThan(0);
  for (const l of startEnd) {
    expect(l, l).not.toMatch(/\d{2}:\d{2}/);
    expect(l, l).not.toMatch(/\b(PT|PST|PDT|JST|GMT|UTC)\b|GMT[+-]/);
  }
}

// Four years and a day: always holds 48 month ends, 4 year ends and a leap day.
const SWEEP_DAYS = 4 * 365 + 1;

for (const { name, tz, zone } of ZONES) {
  // Another zone than the user's, for an edit given a `timezone`.
  const otherTz = ZONES.find((z) => z.tz !== tz).tz;
  describe(`calendar cards print all-day dates from their digits, the user ${name}`, () => {
    let was;
    beforeAll(() => { was = process.env.TZ; process.env.TZ = tz; });
    afterAll(() => { process.env.TZ = was; });

    it('the process clock is in that zone', () => {
      const offset = new Date().getTimezoneOffset();
      expect(name === 'west of UTC' ? offset > 0 : offset < 0).toBe(true);
    });

    for (const { kind, zoneOf } of KINDS) {
      it(`${kind}: a one-day event moved to the next day reads Start date and End date, old and new, as those days`, async () => {
        const { changes, text } = await editCard([allDayEvent(zoneOf(zone))], zone, { start_iso: midnight(1), end_iso: midnight(2) });
        expect(change(changes, 'Start date')).toBe(`  ${cardDate(0)} → **${cardDate(1)}**`);
        expect(change(changes, 'End date')).toBe(`  ${cardDate(0)} → **${cardDate(1)}**`);
        expect(change(changes, 'Start time')).toBeNull();
        expect(change(changes, 'End time')).toBeNull();
        expectDatesOnly(text);
      });

      it(`${kind}: the edit card's event lines name the stored days, the end as the last day`, async () => {
        const { details } = await editCard([allDayEvent(zoneOf(zone), 2)], zone, { title: 'Renamed' });
        expect(line(details, 'Start')).toBe(`Start: ${cardDate(0)}`);
        expect(line(details, 'End')).toBe(`End: ${cardDate(2)}`);
      });

      it(`${kind}: the delete card names the stored days, the end as the last day`, async () => {
        const one = await deleteCard([allDayEvent(zoneOf(zone))], zone);
        expect(line(one, 'Start')).toBe(`Start: ${cardDate(0)}`);
        expect(line(one, 'End')).toBe(`End: ${cardDate(0)}`);
        const three = await deleteCard([allDayEvent(zoneOf(zone), 2)], zone);
        expect(line(three, 'Start')).toBe(`Start: ${cardDate(0)}`);
        expect(line(three, 'End')).toBe(`End: ${cardDate(2)}`);
        expectDatesOnly(three);
      });

      it(`${kind}: the start restated unchanged with a later end shows no Start line, and the end as last days`, async () => {
        const { changes } = await editCard([allDayEvent(zoneOf(zone))], zone, { start_iso: midnight(0), end_iso: midnight(3) });
        expect(change(changes, 'Start date')).toBeNull();
        expect(change(changes, 'Start time')).toBeNull();
        expect(change(changes, 'End date')).toBe(`  ${cardDate(0)} → **${cardDate(2)}**`);
      });

      it(`${kind}: a stored end equal to the start shows that day as the end, never the day before`, async () => {
        const zeroLength = fakeEvent({ id: 'evt', title: 'Holiday', startDate: dateOn(0, zoneOf(zone)), endDate: dateOn(0, zoneOf(zone)) });
        const card = await deleteCard([zeroLength], zone);
        expect(line(card, 'End')).toBe(`End: ${cardDate(0)}`);
      });

      it(`${kind}: an all-day event changed to timed shows the old date and the new time`, async () => {
        const { changes } = await editCard([allDayEvent(zoneOf(zone))], zone, { all_day: false, start_iso: at(1, 9), end_iso: at(1, 10) });
        expect(change(changes, 'Start time')).toBe(`  ${cardDate(0)} → **${formatTimestampForAgent(new Date(at(1, 9)))}**`);
        expect(change(changes, 'End time')).toBe(`  ${cardDate(0)} → **${formatTimestampForAgent(new Date(at(1, 10)))}**`);
      });

      // The new end's last day is never before the start the edit leaves: the
      // given start, else the stored one.
      it(`${kind}: an end given alone prints its last day against the stored start, with no Start line`, async () => {
        const { changes, text } = await editCard([allDayEvent(zoneOf(zone))], zone, { end_iso: midnight(3) });
        expect(change(changes, 'Start date')).toBeNull();
        expect(change(changes, 'Start time')).toBeNull();
        expect(change(changes, 'End date')).toBe(`  ${cardDate(0)} → **${cardDate(2)}**`);
        expectDatesOnly(text);
      });

      it(`${kind}: a one-day event moved earlier than its own day prints the new end against the new start`, async () => {
        const later = fakeEvent({ id: 'evt', title: 'Holiday', startDate: dateOn(5, zoneOf(zone)), endDate: dateOn(6, zoneOf(zone)) });
        const { changes } = await editCard([later], zone, { start_iso: midnight(0), end_iso: midnight(1) });
        expect(change(changes, 'Start date')).toBe(`  ${cardDate(5)} → **${cardDate(0)}**`);
        expect(change(changes, 'End date')).toBe(`  ${cardDate(5)} → **${cardDate(0)}**`);
      });

      it(`${kind}: an all-day edit given a timezone prints dates only, and a restated day shows no line`, async () => {
        const { changes, text } = await editCard([allDayEvent(zoneOf(zone))], zone, { start_iso: midnight(0), end_iso: midnight(3), timezone: otherTz });
        expect(change(changes, 'Start date')).toBeNull();
        expect(change(changes, 'Start time')).toBeNull();
        expect(change(changes, 'End date')).toBe(`  ${cardDate(0)} → **${cardDate(2)}**`);
        expect(changes).toContain(`**Timezone:**\n  ${otherTz}`);
        expectDatesOnly(text);
      });

      it(`${kind}: an all-day event changed to timed on its own day at 00:00 keeps the Start line`, async () => {
        const { changes } = await editCard([allDayEvent(zoneOf(zone))], zone, { all_day: false, start_iso: at(0, 0), end_iso: at(0, 1) });
        expect(change(changes, 'Start time')).toBe(`  ${cardDate(0)} → **${formatTimestampForAgent(new Date(at(0, 0)))}**`);
        expect(change(changes, 'End time')).toBe(`  ${cardDate(0)} → **${formatTimestampForAgent(new Date(at(0, 1)))}**`);
      });
    }

    it('a timed edit with the same digits in another timezone shows the Start and End time lines', async () => {
      const timed = fakeEvent({ id: 'evt', title: 'Sync', startDate: timeOn(0, 9, zone), endDate: timeOn(0, 10, zone) });
      const { changes } = await editCard([timed], zone, { start_iso: at(0, 9), end_iso: at(0, 10), timezone: otherTz });
      expect(change(changes, 'Start time')).toBe(`  ${formatTimestampForAgent(new Date(at(0, 9)))} → **${formatNaiveIsoInTimezone(at(0, 9), otherTz)}**`);
      expect(change(changes, 'End time')).toBe(`  ${formatTimestampForAgent(new Date(at(0, 10)))} → **${formatNaiveIsoInTimezone(at(0, 10), otherTz)}**`);
    });

    it('a timed 09:00 event made all-day on its own day keeps the Start line', async () => {
      const timed = fakeEvent({ id: 'evt', title: 'Sync', startDate: timeOn(0, 9, zone), endDate: timeOn(0, 10, zone) });
      const { changes } = await editCard([timed], zone, { all_day: true, start_iso: midnight(0), end_iso: midnight(1) });
      expect(change(changes, 'Start date')).toBe(`  ${formatTimestampForAgent(new Date(at(0, 9)))} → **${cardDate(0)}**`);
      expect(change(changes, 'End date')).toBe(`  ${formatTimestampForAgent(new Date(at(0, 10)))} → **${cardDate(0)}**`);
    });

    // A sweep over about four years of days from today (every month end, year
    // end and leap day in it), against an oracle that walks the process's own
    // calendar at local noon, independent of the formatter.
    it('every all-day day for four years from today prints its weekday and date, and an end its last day', () => {
      const sweepDay = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
      const digitsOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const printed = (d) => `${WEEKDAYS[d.getDay()]} ${digitsOf(d).replaceAll('-', '/')}`;
      const seen = { monthEnds: 0, yearEnds: 0, leapDays: 0 };
      for (let n = 0; n <= SWEEP_DAYS; n += 1) {
        const d = sweepDay(n);
        const next = sweepDay(n + 1);
        const iso = `${digitsOf(d)}T00:00:00`;
        const nextIso = `${digitsOf(next)}T00:00:00`;
        const prevIso = `${digitsOf(sweepDay(n - 1))}T00:00:00`;
        expect(formatCardTime(iso, { allDay: true }), iso).toBe(printed(d));
        // A one-day event's exclusive end is the next day; its last day is this one.
        expect(formatCardTime(nextIso, { allDay: true, endAfter: iso }), nextIso).toBe(printed(d));
        // A two-day event whose last day is this one: its start is the day before,
        // so a last day computed too early is not raised to the answer by the floor.
        expect(formatCardTime(nextIso, { allDay: true, endAfter: prevIso }), nextIso).toBe(printed(d));
        // A stored end equal to the start is never printed before the start.
        expect(formatCardTime(iso, { allDay: true, endAfter: iso }), iso).toBe(printed(d));
        if (next.getDate() === 1) seen.monthEnds += 1;
        if (next.getDate() === 1 && next.getMonth() === 0) seen.yearEnds += 1;
        if (d.getMonth() === 1 && d.getDate() === 29) seen.leapDays += 1;
      }
      expect(seen.monthEnds).toBeGreaterThanOrEqual(48);
      expect(seen.yearEnds).toBeGreaterThanOrEqual(4);
      expect(seen.leapDays).toBeGreaterThanOrEqual(1);
    });

    // On the harness's dates: an occurrence on day 7 moved on its own to day 8.
    it('a this-and-following edit of an all-day series names the occurrence and its original slot by their dates', async () => {
      const moved = fakeEvent({ id: 'evt', title: 'Moved', startDate: fakeDate(day(8)), endDate: fakeDate(day(9)), recurrenceId: fakeDate(day(7)) });
      const ev = fakeEvent({ id: 'evt', title: 'Leave', startDate: fakeDate(day(0)), endDate: fakeDate(day(1)) });
      ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=WEEKLY;COUNT=4')], { exceptions: [moved] });
      ev.recurrenceInfo.item = ev;
      const { changes } = await editCard([ev], null, { edit_scope: 'this_and_following', recurrence_id: midnight(8), title: 'Away' });
      expect(changes).toContain(`**Scope:** This occurrence and all future occurrences (starting ${cardDate(8)}, originally ${cardDate(7)})`);
    });

    it('a timed event changed to all-day shows the old time and the new date', async () => {
      const timed = fakeEvent({ id: 'evt', title: 'Sync', startDate: timeOn(0, 17, zone), endDate: timeOn(0, 18, zone) });
      const { changes } = await editCard([timed], zone, { all_day: true, start_iso: midnight(1), end_iso: midnight(2) });
      expect(change(changes, 'Start date')).toBe(`  ${formatTimestampForAgent(new Date(at(0, 17)))} → **${cardDate(1)}**`);
      expect(change(changes, 'End date')).toBe(`  ${formatTimestampForAgent(new Date(at(0, 18)))} → **${cardDate(1)}**`);
    });

    it('the create card prints an all-day event\'s dates, the end as the last day', async () => {
      const card = await createCard(zone, { all_day: true, start_iso: midnight(0), end_iso: midnight(3) });
      expect(line(card, 'Start')).toBe(`Start: ${cardDate(0)}`);
      expect(line(card, 'End')).toBe(`End: ${cardDate(2)}`);
      expectDatesOnly(card);
    });

    // On the harness's dates: its recurrence code does not take Thunderbird's.
    it('one occurrence of an all-day series is named on the Scope line by its date', async () => {
      const ev = fakeEvent({ id: 'evt', title: 'Leave', startDate: fakeDate(day(0)), endDate: fakeDate(day(1)) });
      ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=WEEKLY;COUNT=4')]);
      ev.recurrenceInfo.item = ev;
      const { changes } = await editCard([ev], null, { edit_scope: 'this_only', recurrence_id: midnight(7), title: 'Away' });
      expect(changes).toContain(`**Scope:** Just this occurrence (${cardDate(7)})`);
    });

    // Pin (green before the all-day change too): a timed event's card lines
    // are the ones the cards always printed, character for character.
    it('a timed event\'s card lines are unchanged', async () => {
      const timed = () => fakeEvent({ id: 'evt', title: 'Sync', startDate: timeOn(0, 17, zone), endDate: timeOn(0, 18, zone) });
      const oldStart = formatTimestampForAgent(new Date(at(0, 17)));
      const oldEnd = formatTimestampForAgent(new Date(at(0, 18)));
      const { details, changes } = await editCard([timed()], zone, { start_iso: at(0, 16), end_iso: at(0, 18) });
      expect(line(details, 'Start')).toBe(`Start: ${oldStart}`);
      expect(line(details, 'End')).toBe(`End: ${oldEnd}`);
      expect(changes).toContain(`**Start time:**\n  ${oldStart} → **${formatTimestampForAgent(new Date(at(0, 16)))}**`);
      expect(changes).not.toContain('**End time:**');
      const del = await deleteCard([timed()], zone);
      expect(line(del, 'Start')).toBe(`Start: ${oldStart}`);
      expect(line(del, 'End')).toBe(`End: ${oldEnd}`);
      const create = await createCard(zone, { start_iso: at(2, 9), end_iso: at(2, 10) });
      expect(line(create, 'Start')).toBe(`Start: ${formatTimestampForAgent(new Date(at(2, 9)))}`);
      expect(line(create, 'End')).toBe(`End: ${formatTimestampForAgent(new Date(at(2, 10)))}`);
    });
  });
}
