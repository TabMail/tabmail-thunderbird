/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarSeriesTimeMove.test.js: a time change of a whole repeating series
// works as calendar apps make it (#287), through the real bridge and edit tool:
//   - named from the series' first occurrence (or with no occurrence named, on
//     the series' own date), every occurrence moves by the same amount: the
//     days the rule names, the excluded and added dates, and each changed
//     occurrence, at its slot or moved on its own; the series ends where it did,
//     moved by that amount (UNTIL), or after as many occurrences (COUNT);
//   - named from a later occurrence, the occurrences before it stay as they
//     were, and the ones from it on move as above (this and following, #328);
//   - with no occurrence named and another date, the tool asks the user which
//     one they mean;
//   - a move the rule's days cannot follow, a time change of a rule with set
//     hours, and a new rule given with a move to another day are refused and
//     write nothing.
// Every start kind: the user's zone, a zone east of UTC, UTC, floating, and
// all-day (made in UTC and in a zone east of UTC).

// West of UTC, so an instant read in the user's zone has other digits than in
// UTC or in a zone east of UTC. Every occurrence here and its move stay in
// October 2099, inside one daylight-saving period.
process.env.TZ = 'America/Vancouver';

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

globalThis.browser = {
  tmCalendar: {
    getCalendars: vi.fn(async () => ({ ok: false })),
    queryCalendarItems: vi.fn(async () => []),
    getCalendarEventDetails: vi.fn(async () => ({ ok: false, error: 'event not found' })),
    modifyCalendarEvent: vi.fn(async () => ({ ok: true })),
  },
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => undefined) },
};
globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
// The real toNaiveIso: the read tool shows an instant in the user's zone with it.
vi.mock('../chat/modules/helpers.js', async () => {
  const actual = await vi.importActual('../chat/modules/helpers.js');
  return { toNaiveIso: actual.toNaiveIso, toIsoNoMs: actual.toIsoNoMs, streamText: vi.fn() };
});
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

const {
  loadCalendarBridge, fakeAttendee, fakeCalDateTime, fakeDate, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem,
  recurrenceDate, seriesOccurrences, fixedZone, FLOATING_ZONE, UTC_ZONE, LOCAL_ZONE,
} = await import('./helpers/calendarBridgeHarness.js');
const { run: editRun } = await import('../chat/tools/calendar_event_edit.js');
const { ctx } = await import('../chat/modules/context.js');

// A far-future series start, a Thursday: 2099 is the dated-test exception.
const START_DAY = '2099-10-01';
const pad2 = (n) => String(n).padStart(2, '0');
const EAST = fixedZone('Test/East+0900', 9 * 60);
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Wide enough for every occurrence these series make.
const RANGE = [fakeDate('2099-09-01'), fakeDate('2110-01-01')];

const START_KINDS = {
  "timed in the user's zone": () => fakeDateTime(START_DAY, 17),
  'timed in another zone, east of UTC': () => fakeDateTime(START_DAY, 17, 0, EAST),
  'timed in UTC': () => fakeDateTime(START_DAY, 17, 0, UTC_ZONE),
  'floating': () => fakeDateTime(START_DAY, 17, 0, FLOATING_ZONE),
  'all-day': () => fakeDate(START_DAY),
  'all-day, made in a zone east of UTC': () => fakeDate(START_DAY, EAST),
};

// A value `days` days and `hours` hours after `start`, in its frame.
const after = (start, days, hours = 0) => {
  const dt = fakeCalDateTime({ ...start });
  dt.addDuration({ inSeconds: days * 86400 + hours * 3600, isNegative: false });
  return dt;
};
// An UNTIL value in the start's value type (RFC 5545 3.3.10).
const untilAfter = (start, days) => {
  const dt = after(start, days);
  return dt.isDate || dt.timezone === FLOATING_ZONE ? dt.toString() : dt.getInTimezone(UTC_ZONE).toString();
};
// A start_iso as the read tools show it: in the user's zone (floating time by
// its digits, an all-day value as its date at midnight).
const startIsoOf = (dt) => {
  if (dt.isDate) return `${dt.year}-${pad2(dt.month + 1)}-${pad2(dt.day)}T00:00:00`;
  const d = dt.timezone === FLOATING_ZONE ? dt : dt.getInTimezone(LOCAL_ZONE);
  return `${d.year}-${pad2(d.month + 1)}-${pad2(d.day)}T${pad2(d.hour)}:${pad2(d.minute)}:${pad2(d.second)}`;
};
// The new times of an edit that moves `at` by `days` days and `hours` hours.
const movedTo = (at, days, hours) => (at.isDate
  ? { start_iso: startIsoOf(after(at, days)), all_day: true }
  : { start_iso: startIsoOf(after(at, days, hours)) });

// The series' occurrences: an instant (a DATE by its digits), and for a changed
// occurrence its own start and title.
const instantKey = (dt) => (dt.isDate ? dt.toString() : new Date(dt.nativeTime / 1000).toISOString());
const occurrenceKeys = (item) => seriesOccurrences(item, ...RANGE)
  .map(({ start, item: occ }) => (occ.recurrenceId ? `changed ${instantKey(start)} ${occ.title}` : instantKey(start)))
  .sort();
// Changed occurrences given their own time ('Moved'): a move of the series
// keeps that time, as calendar apps keep the user's edits; one changed only in
// its details follows the series.
const OWN_TIME_TITLES = new Set(['Moved']);
// A key moved by `days` days and `hours` hours (a DATE by its days alone).
function shiftedKey(key, days, hours) {
  const one = (k) => {
    if (/^\d{8}$/.test(k)) {
      const u = new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8)) + days * DAY_MS);
      return `${u.getUTCFullYear()}${pad2(u.getUTCMonth() + 1)}${pad2(u.getUTCDate())}`;
    }
    return new Date(Date.parse(k) + days * DAY_MS + hours * HOUR_MS).toISOString();
  };
  const m = /^changed (\S+) (.*)$/.exec(key);
  if (m && OWN_TIME_TITLES.has(m[2])) return key;
  return m ? `changed ${one(m[1])} ${m[2]}` : one(key);
}
const shiftAll = (keys, days, hours) => keys.map((k) => shiftedKey(k, days, hours)).sort();

function seriesFrom(start, rules, { extraItems = [], exceptions = [], attendees = [] } = {}) {
  const endDate = start.isDate ? after(start, 1) : after(start, 0, 1);
  const ev = fakeEvent({ id: 'ser', title: 'Sync', startDate: start, endDate, attendees });
  ev.recurrenceInfo = fakeRecurrenceInfo([...rules.map((r) => recurrenceItem('RRULE', r)), ...extraItems], { exceptions });
  ev.recurrenceInfo.item = ev;
  return ev;
}
// A changed occurrence at `rid`: at its slot, or moved on its own.
function changedAt(rid, title, movedOnItsOwn) {
  const start = movedOnItsOwn ? (rid.isDate ? after(rid, 1) : after(rid, 0, 2)) : rid.clone();
  const end = start.isDate ? after(start, 1) : after(start, 0, 1);
  return fakeEvent({ id: 'ser', title, startDate: start, endDate: end, recurrenceId: rid.clone() });
}
const ruleDatesOf = (rule, start) => recurrenceItem('RRULE', rule).getOccurrences(start, start, RANGE[1], 0);

// Thursdays and Saturdays, ending after 24 days or after 8 occurrences, with an
// excluded date, two added dates, one changed occurrence at its slot and one
// moved on its own: every part a move must carry.
const RULES = (start) => [`FREQ=WEEKLY;BYDAY=TH,SA;UNTIL=${untilAfter(start, 24)}`, 'FREQ=WEEKLY;BYDAY=TH,SA;COUNT=8'];
function fullSeries(start, rule) {
  const dates = ruleDatesOf(rule, start);
  const series = seriesFrom(start, [rule], {
    extraItems: [
      recurrenceDate('EXDATE', dates[6]),
      recurrenceDate('RDATE', after(start, 1)), recurrenceDate('RDATE', after(dates[3], 1)),
    ],
    exceptions: [changedAt(dates[4], 'Kept', false), changedAt(dates[5], 'Moved', true)],
  });
  return { series, dates };
}

function load(master) {
  const loaded = loadCalendarBridge(bridgeUrl, { items: [master] });
  const { cal } = loaded.ctx.ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');
  cal.timezoneService.getTimezone = (tzid) => (tzid === EAST.tzid ? EAST : null);
  return loaded;
}
const ruleValues = (item) => (item.recurrenceInfo?.getRecurrenceItems() || [])
  .filter((r) => r.icalProperty.propertyName === 'RRULE').map((r) => r.icalProperty.value);

describe('a whole series named from its first occurrence moves as one', () => {
  for (const [kind, makeStart] of Object.entries(START_KINDS)) {
    for (const rule of RULES(makeStart())) {
      it(`a series ${kind} (${rule.replace(/;UNTIL=.*/, ';UNTIL')}): a day and an hour later moves every occurrence by that much`, async () => {
        const start = makeStart();
        const { series } = fullSeries(start, rule);
        const before = occurrenceKeys(series);
        expect(before.filter((k) => k.startsWith('changed '))).toHaveLength(2);
        expect(before.length).toBeGreaterThan(8);
        const { api, calendar } = load(series);
        const res = await api.modifyCalendarEvent({
          event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: startIsoOf(start), ...movedTo(start, 1, 1),
        });
        expect(res, res.error).toMatchObject({ ok: true });
        const saved = calendar.items[0];
        // A timed series keeps its zone; an all-day date has none (note 034).
        if (!start.isDate) expect(saved.startDate.timezone).toBe(start.timezone);
        expect(occurrenceKeys(saved)).toEqual(shiftAll(before, 1, start.isDate ? 0 : 1));
      });
    }
  }

  it('the first occurrence named by its own start after it was moved on its own is still the first: the series moves as one, and that occurrence takes the new time', async () => {
    const start = makeUserStart();
    const rule = RULES(start)[0];
    const dates = ruleDatesOf(rule, start);
    const first = changedAt(dates[0], 'Early', true);
    const series = seriesFrom(start, [rule], { exceptions: [first, changedAt(dates[3], 'Kept', false)] });
    const before = occurrenceKeys(series);
    const { api, calendar } = load(series);
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: startIsoOf(first.startDate), ...movedTo(start, 1, 1),
    });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(calendar.items).toHaveLength(1);
    const others = before.filter((k) => !k.endsWith(' Early'));
    expect(occurrenceKeys(calendar.items[0])).toEqual([...shiftAll(others, 1, 1), `changed ${instantKey(after(start, 1, 1))} Early`].sort());
  });

  it('with no occurrence named, a first occurrence moved on its own keeps its own time while the series moves', async () => {
    const start = makeUserStart();
    const rule = RULES(start)[0];
    const dates = ruleDatesOf(rule, start);
    const series = seriesFrom(start, [rule], { exceptions: [changedAt(dates[0], 'Early', true), changedAt(dates[3], 'Kept', false)] });
    const before = occurrenceKeys(series);
    const early = before.find((k) => k.endsWith(' Early'));
    const { api, calendar } = load(series);
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', ...movedTo(start, 0, 1) });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(occurrenceKeys(calendar.items[0])).toEqual([...shiftAll(before.filter((k) => k !== early), 0, 1), early].sort());
  });

  it('with no occurrence named, a new time on the series\' own date moves every occurrence, a changed one given its own time keeping it', async () => {
    const start = makeUserStart();
    const { series } = fullSeries(start, RULES(start)[0]);
    const before = occurrenceKeys(series);
    const { api, calendar } = load(series);
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', ...movedTo(start, 0, 1) });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(occurrenceKeys(calendar.items[0])).toEqual(shiftAll(before, 0, 1));
  });

  // Day parts a whole number of days can move: the month days of a monthly
  // rule, and a month a move within it keeps.
  for (const [what, day, rule, days] of [
    ['a monthly rule on two month days', '2099-10-10', 'FREQ=MONTHLY;BYMONTHDAY=10,20;COUNT=4', 1],
    ['a yearly rule in a month the move stays in', START_DAY, 'FREQ=YEARLY;BYMONTH=10;COUNT=3', 1],
    ['a weekly rule on two days moved back across the week start', START_DAY, 'FREQ=WEEKLY;BYDAY=TH,SA;COUNT=6', -4],
    // ical.js groups the days of a rule every few weeks into weeks from its week
    // start, so a day moved across it would land in the skipped week.
    ['every other week on two days, moved back across the week start', '2099-10-05', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=4', -1],
    ['a weekly rule moved back past Sunday', '2099-10-05', 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4', -2],
    ['every other week on two days with a Sunday week start, moved forward across it', '2099-10-05', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;WKST=SU;COUNT=4', 2],
    ['a monthly rule moved onto the 28th', '2099-10-27', 'FREQ=MONTHLY;BYMONTHDAY=27;COUNT=3', 1],
    ['a monthly rule on its start\'s day, moved within the month', '2099-10-10', 'FREQ=MONTHLY;COUNT=3', 2],
    ['a yearly rule on its start\'s day, moved to the end of the month', '2099-10-30', 'FREQ=YEARLY;COUNT=3', 1],
  ]) {
    it(`${what}: a move of ${days} days moves every occurrence by that much`, async () => {
      const start = fakeDateTime(day, 17);
      const series = seriesFrom(start, [rule]);
      const before = occurrenceKeys(series);
      const { api, calendar } = load(series);
      const res = await api.modifyCalendarEvent({
        event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: startIsoOf(start), ...movedTo(start, days, 0),
      });
      expect(res, res.error).toMatchObject({ ok: true });
      expect(occurrenceKeys(calendar.items[0])).toEqual(shiftAll(before, days, 0));
    });
  }
});

function makeUserStart() { return START_KINDS["timed in the user's zone"](); }

describe('a series named from a later occurrence changes it and the following ones', () => {
  for (const [kind, makeStart] of Object.entries(START_KINDS)) {
    for (const rule of RULES(makeStart())) {
      it(`a series ${kind} (${rule.replace(/;UNTIL=.*/, ';UNTIL')}): a day and an hour later leaves the earlier occurrences and moves the following ones`, async () => {
        const start = makeStart();
        const at = fullSeries(start, rule).dates[3];
        // The two parts as a split there makes them, with no change of time.
        const plain = load(fullSeries(start, rule).series);
        const plainRes = await plain.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(at), title: 'Sync' });
        expect(plainRes, plainRes.error).toMatchObject({ ok: true });
        const earlier = occurrenceKeys(plain.calendar.items.find((it) => it.id === 'ser'));
        const following = occurrenceKeys(plain.calendar.items.find((it) => it.id !== 'ser'));
        expect(following.filter((k) => k.startsWith('changed '))).toHaveLength(2);

        const { api, calendar } = load(fullSeries(start, rule).series);
        const res = await api.modifyCalendarEvent({
          event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(at), ...movedTo(at, 1, 1),
        });
        expect(res, res.error).toMatchObject({ ok: true });
        expect(occurrenceKeys(calendar.items.find((it) => it.id === 'ser'))).toEqual(earlier);
        expect(occurrenceKeys(calendar.items.find((it) => it.id !== 'ser'))).toEqual(shiftAll(following, 1, start.isDate ? 0 : 1));
      });
    }
  }
});

describe('a move the series cannot follow is refused and writes nothing', () => {
  const RULE_DAYS = 'this series repeats on days its rule names in a way a move cannot carry (for example the second Tuesday, or the last day of the month), so it cannot be moved to another day here; move only its time of day, or tell the user to change its days in their calendar app';
  const cases = [
    ['an ordinal weekday', START_DAY, ['FREQ=MONTHLY;BYDAY=1TH;COUNT=3'], 1, 0, {}, RULE_DAYS],
    ['a set position', START_DAY, ['FREQ=MONTHLY;BYDAY=TH;BYSETPOS=1;COUNT=3'], 1, 0, {}, RULE_DAYS],
    ['a month day moved past the 28th', '2099-10-28', ['FREQ=MONTHLY;BYMONTHDAY=28;COUNT=3'], 1, 0, {}, RULE_DAYS],
    ['a month day moved before the 1st', START_DAY, ['FREQ=MONTHLY;BYMONTHDAY=1;COUNT=3'], -1, 0, {}, RULE_DAYS],
    ['a month the move leaves', START_DAY, ['FREQ=YEARLY;BYMONTH=10;COUNT=3'], -1, 0, {}, RULE_DAYS],
    ['a year day', START_DAY, ['FREQ=YEARLY;BYYEARDAY=274;COUNT=3'], 1, 0, {}, RULE_DAYS],
    ['a month day already past the 28th, moved down', '2099-10-30', ['FREQ=MONTHLY;BYMONTHDAY=30;COUNT=3'], -5, 0, {}, RULE_DAYS],
    ['a monthly rule on its start\'s day moved onto the 29th', '2099-10-10', ['FREQ=MONTHLY;COUNT=3'], 19, 0, {}, RULE_DAYS],
    ['a monthly rule on its start\'s day already past the 28th, moved down', '2099-10-30', ['FREQ=MONTHLY;COUNT=5'], -5, 0, {}, RULE_DAYS],
    ['a monthly rule on its start\'s day moved into the next month', '2099-10-27', ['FREQ=MONTHLY;COUNT=3'], 5, 0, {}, RULE_DAYS],
    ['a yearly rule on its start\'s day moved across the end of February', '2100-02-27', ['FREQ=YEARLY;COUNT=3'], 3, 0, {}, RULE_DAYS],
    ['a yearly rule on a leap day', '2104-02-29', ['FREQ=YEARLY;COUNT=2'], -1, 0, {}, RULE_DAYS],
    ['weekdays in a named month', START_DAY, ['FREQ=YEARLY;BYMONTH=10;BYDAY=TH;COUNT=3'], 1, 0, {}, RULE_DAYS],
    ['a weekday every other month', START_DAY, ['FREQ=MONTHLY;INTERVAL=2;BYDAY=TH;COUNT=3'], 1, 0, {}, RULE_DAYS],
    ['a daily rule in a named month', START_DAY, ['FREQ=DAILY;BYMONTH=10;COUNT=3'], 1, 0, {}, RULE_DAYS],
    ['a time change of a rule with set hours', START_DAY, ['FREQ=DAILY;BYHOUR=17,20;COUNT=4'], 0, 1, {},
      'this series repeats at set hours or minutes, so its time cannot be moved here; tell the user to change it in their calendar app'],
    ['a new repeat rule with a move to another day', START_DAY, ['FREQ=WEEKLY;BYDAY=TH;COUNT=5'], 1, 0, { recurrence: { freq: 'WEEKLY', count: 3 } },
      'a new repeat rule cannot be given with a move of the series to another day; make the move first, then change the repeat in a second edit (calendar_event_read then shows the moved end)'],
  ];
  for (const [what, day, rules, days, hours, extra, error] of cases) {
    it(`${what}`, async () => {
      const start = fakeDateTime(day, 17);
      const series = seriesFrom(start, rules, { exceptions: [changedAt(ruleDatesOf(rules[0], start)[1], 'Kept', false)] });
      const rulesBefore = ruleValues(series);
      const before = occurrenceKeys(series);
      const { api, calendar, modifications } = load(series);
      const res = await api.modifyCalendarEvent({
        event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: startIsoOf(start), ...movedTo(start, days, hours), ...extra,
      });
      expect(res).toEqual({ ok: false, error });
      expect(modifications).toEqual([]);
      expect(calendar.items).toEqual([series]);
      expect(ruleValues(series)).toEqual(rulesBefore);
      expect(occurrenceKeys(series)).toEqual(before);
    });
  }

  it('a move to another day of a series that cancels occurrences by a rule (EXRULE)', async () => {
    const start = makeUserStart();
    const exrule = { isNegative: true, icalProperty: { propertyName: 'EXRULE', value: 'FREQ=WEEKLY;BYDAY=SA' } };
    const series = seriesFrom(start, ['FREQ=WEEKLY;BYDAY=TH,SA;COUNT=6'], { extraItems: [exrule] });
    const before = occurrenceKeys(series);
    const { api, calendar, modifications } = load(series);
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: startIsoOf(start), ...movedTo(start, 1, 0) });
    expect(res).toEqual({ ok: false, error: 'this series cancels occurrences by a rule (EXRULE), which a move to another day cannot carry; tell the user to move it in their calendar app' });
    expect(modifications).toEqual([]);
    expect(calendar.items).toEqual([series]);
    expect(occurrenceKeys(series)).toEqual(before);
  });

  it('a series that cancels occurrences by a rule (EXRULE) still takes a new time of day', async () => {
    const start = makeUserStart();
    const exrule = { isNegative: true, icalProperty: { propertyName: 'EXRULE', value: 'FREQ=WEEKLY;BYDAY=SA' } };
    const series = seriesFrom(start, ['FREQ=WEEKLY;BYDAY=TH,SA;COUNT=6'], { extraItems: [exrule] });
    const before = occurrenceKeys(series);
    const { api, calendar } = load(series);
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', ...movedTo(start, 0, 1) });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(occurrenceKeys(calendar.items[0])).toEqual(shiftAll(before, 0, 1));
  });

  // Thunderbird moves a series' excluded and added dates, UNTIL and changed
  // occurrences' RECURRENCE-IDs by the start's change in UTC and keeps their
  // value type, so a change between all-day and timed would leave them off
  // their occurrences, on its own day as on another.
  const KIND_CHANGE = 'changing these occurrences between all-day and timed would leave their excluded or added dates, end date or changed occurrences in the other form; change it in the calendar app';
  const KIND_CHANGE_UNTIL = 'changing these occurrences between all-day and timed would leave their end date (UNTIL) in the other form; give the repeat rule again, its end included, in the same edit (a move to another day goes first, in its own edit)';
  const dayOf = (dt, days) => startIsoOf(after(dt, days)).slice(0, 10);
  const asAllDay = (dt, days) => ({ start_iso: `${dayOf(dt, days)}T00:00:00`, end_iso: `${dayOf(dt, days + 1)}T00:00:00`, all_day: true });
  const asTimed = (dt, days) => ({ start_iso: `${dayOf(dt, days)}T09:00:00`, end_iso: `${dayOf(dt, days)}T10:00:00`, all_day: false });
  const timedWithDatesOnly = (start, kinds = ['EXDATE', 'RDATE']) => {
    const rule = RULES(start)[1];
    const dates = ruleDatesOf(rule, start);
    const made = { EXDATE: recurrenceDate('EXDATE', dates[2]), RDATE: recurrenceDate('RDATE', after(dates[3], 1)) };
    return seriesFrom(start, [rule], { extraItems: kinds.map((k) => made[k]) });
  };
  const allDayWithOneChanged = () => {
    const start = fakeDate(START_DAY);
    const rule = RULES(start)[1];
    return seriesFrom(start, [rule], { exceptions: [changedAt(ruleDatesOf(rule, start)[5], 'Moved', true)] });
  };
  for (const [name, make, change, error] of [
    ['a timed series with changed occurrences and excluded and added dates, made all-day on its own day', () => fullSeries(makeUserStart(), RULES(makeUserStart())[1]).series, (s) => asAllDay(s, 0), KIND_CHANGE],
    ['a timed series with changed occurrences and excluded and added dates, made all-day on the next day', () => fullSeries(makeUserStart(), RULES(makeUserStart())[1]).series, (s) => asAllDay(s, 1), KIND_CHANGE],
    ['a timed series with an excluded and an added date only, made all-day on the next day', () => timedWithDatesOnly(makeUserStart()), (s) => asAllDay(s, 1), KIND_CHANGE],
    ['a timed series with an excluded date only, made all-day on its own day', () => timedWithDatesOnly(makeUserStart(), ['EXDATE']), (s) => asAllDay(s, 0), KIND_CHANGE],
    ['a timed series with an added date only, made all-day on its own day', () => timedWithDatesOnly(makeUserStart(), ['RDATE']), (s) => asAllDay(s, 0), KIND_CHANGE],
    ['an all-day series with one changed occurrence, made timed on the next day', allDayWithOneChanged, (s) => asTimed(s, 1), KIND_CHANGE],
    ['an all-day series with one changed occurrence, made timed on its own day', allDayWithOneChanged, (s) => asTimed(s, 0), KIND_CHANGE],
    ['a timed series with an end date (UNTIL), made all-day on its own day', () => seriesFrom(makeUserStart(), [RULES(makeUserStart())[0]]), (s) => asAllDay(s, 0), KIND_CHANGE_UNTIL],
  ]) {
    it(`${name}: refused, and nothing is written`, async () => {
      const series = make();
      const before = occurrenceKeys(series);
      const { api, calendar, modifications } = load(series);
      const res = await api.modifyCalendarEvent({
        event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: startIsoOf(series.startDate), ...change(series.startDate),
      });
      expect(res).toEqual({ ok: false, error });
      expect(modifications).toEqual([]);
      expect(calendar.items).toEqual([series]);
      expect(occurrenceKeys(series)).toEqual(before);
    });
  }

  it('a timed series with no dates of its own is made all-day on the next day, its days moved with it', async () => {
    const start = makeUserStart();
    const { api, calendar } = load(seriesFrom(start, [RULES(start)[1].replace('COUNT=8', 'COUNT=4')]));
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: startIsoOf(start), ...asAllDay(start, 1) });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(occurrenceKeys(calendar.items[0])).toEqual(['20991002', '20991004', '20991009', '20991011']);
  });

  it('a timed series with an end date is made all-day on its own day when its rule is given again', async () => {
    const start = makeUserStart();
    const { api, calendar } = load(seriesFrom(start, [`FREQ=DAILY;UNTIL=${untilAfter(start, 5)}`]));
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: startIsoOf(start), ...asAllDay(start, 0), recurrence: { freq: 'DAILY', until: dayOf(start, 5) },
    });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(ruleValues(calendar.items[0])).toEqual([`FREQ=DAILY;UNTIL=${dayOf(start, 5).replace(/-/g, '')}`]);
    expect(occurrenceKeys(calendar.items[0])).toEqual([0, 1, 2, 3, 4, 5].map((d) => dayOf(start, d).replace(/-/g, '')));
  });

  // The following part of a split goes through the same check.
  for (const [name, make, change] of [
    ['a timed series with changed occurrences and excluded and added dates, made all-day on the next day', () => fullSeries(makeUserStart(), RULES(makeUserStart())[1]).series, (at) => asAllDay(at, 1)],
    ['an all-day series with one changed occurrence, made timed on the next day', allDayWithOneChanged, (at) => asTimed(at, 1)],
  ]) {
    it(`from a later occurrence, ${name}: refused, and nothing is written`, async () => {
      const series = make();
      const at = ruleDatesOf(RULES(series.startDate)[1], series.startDate)[3];
      const before = occurrenceKeys(series);
      const { api, calendar, modifications } = load(series);
      const res = await api.modifyCalendarEvent({
        event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(at), ...change(at),
      });
      expect(res).toEqual({ ok: false, error: KIND_CHANGE });
      expect(modifications).toEqual([]);
      expect(calendar.items).toEqual([series]);
      expect(occurrenceKeys(series)).toEqual(before);
    });
  }

  it('from an occurrence changed in its details on, a new time is made in one write: it takes the time, keeps its name and asks its guests again; later ones keep their own times or follow', async () => {
    const start = makeUserStart();
    const rule = RULES(start)[1];
    const dates = ruleDatesOf(rule, start);
    const planning = fakeEvent({
      id: 'ser', title: 'Planning', startDate: dates[3].clone(), endDate: after(dates[3], 0, 1), recurrenceId: dates[3].clone(),
      attendees: [fakeAttendee({ id: 'mailto:ana@example.com', participationStatus: 'ACCEPTED' })],
    });
    const series = seriesFrom(start, [rule], { exceptions: [planning, changedAt(dates[5], 'Kept', false), changedAt(dates[6], 'Moved', true)] });
    const before = occurrenceKeys(series);
    const splitMs = dates[3].nativeTime / 1000;
    const keyMs = (k) => Date.parse(k.replace(/^changed (\S+) .*$/, '$1'));
    const earlier = before.filter((k) => keyMs(k) < splitMs);
    const following = before.filter((k) => keyMs(k) >= splitMs);
    const { api, calendar } = load(series);
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(dates[3]), ...movedTo(dates[3], 0, 2),
    });
    expect(res, res.error).toMatchObject({ ok: true });
    const capped = calendar.items.find((it) => it.id === 'ser');
    const fresh = calendar.items.find((it) => it.id !== 'ser');
    expect(occurrenceKeys(capped)).toEqual(earlier);
    expect(occurrenceKeys(fresh)).toEqual(shiftAll(following, 0, 2));
    const x = fresh.recurrenceInfo.getExceptionFor(fresh.startDate);
    expect(x.title).toBe('Planning');
    expect(x.getAttendees().map((a) => [a.id, a.participationStatus])).toEqual([['mailto:ana@example.com', 'NEEDS-ACTION']]);
  });

  // Guests answer for an occurrence's own time and place.
  const guest = (name, status = 'ACCEPTED') => fakeAttendee({ id: `mailto:${name}@example.com`, participationStatus: status });
  const answers = (item) => item.getAttendees().map((a) => [a.id, a.participationStatus]);
  const changedNamed = (item, title) => item.recurrenceInfo.getExceptionIds().map((rid) => item.recurrenceInfo.getExceptionFor(rid)).find((ex) => ex.title === title);
  const withGuests = (ex, guests) => fakeEvent({ id: 'ser', title: ex.title, startDate: ex.startDate, endDate: ex.endDate, recurrenceId: ex.recurrenceId, attendees: guests });

  it('from a changed occurrence on, a new title alone keeps its guests\' answers', async () => {
    const start = makeUserStart();
    const rule = RULES(start)[1];
    const dates = ruleDatesOf(rule, start);
    const own = withGuests(changedAt(dates[3], 'Planning', true), [guest('ana')]);
    const { api, calendar } = load(seriesFrom(start, [rule], { exceptions: [own] }));
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(own.startDate), title: 'Review',
    });
    expect(res, res.error).toMatchObject({ ok: true });
    const fresh = calendar.items.find((it) => it.id !== 'ser');
    expect(answers(changedNamed(fresh, 'Review'))).toEqual([['mailto:ana@example.com', 'ACCEPTED']]);
  });

  it('a split that moves a later changed occurrence asks its guests again; one that keeps its own time keeps their answers', async () => {
    const start = makeUserStart();
    const rule = RULES(start)[1];
    const dates = ruleDatesOf(rule, start);
    const series = seriesFrom(start, [rule], {
      exceptions: [withGuests(changedAt(dates[5], 'Kept', false), [guest('ana')]), withGuests(changedAt(dates[6], 'Moved', true), [guest('bo')])],
    });
    const { api, calendar } = load(series);
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(dates[3]), ...movedTo(dates[3], 0, 2),
    });
    expect(res, res.error).toMatchObject({ ok: true });
    const fresh = calendar.items.find((it) => it.id !== 'ser');
    expect(answers(changedNamed(fresh, 'Kept'))).toEqual([['mailto:ana@example.com', 'NEEDS-ACTION']]);
    expect(answers(changedNamed(fresh, 'Moved'))).toEqual([['mailto:bo@example.com', 'ACCEPTED']]);
  });

  it('from an occurrence moved on its own, a new time equal to the series\' asks its guests again', async () => {
    const start = makeUserStart();
    const rule = RULES(start)[1];
    const dates = ruleDatesOf(rule, start);
    const own = withGuests(changedAt(dates[3], 'Planning', true), [guest('ana')]);
    const { api, calendar } = load(seriesFrom(start, [rule], { exceptions: [own] }));
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(own.startDate), start_iso: startIsoOf(dates[3]),
    });
    expect(res, res.error).toMatchObject({ ok: true });
    const fresh = calendar.items.find((it) => it.id !== 'ser');
    const x = changedNamed(fresh, 'Planning');
    expect(x.startDate.toString()).toBe(fresh.startDate.toString());
    expect(answers(x)).toEqual([['mailto:ana@example.com', 'NEEDS-ACTION']]);
  });

  it('a whole-series move named from a changed first occurrence gives that occurrence the edit\'s place too', async () => {
    const start = makeUserStart();
    const rule = RULES(start)[1];
    const first = changedAt(ruleDatesOf(rule, start)[0], 'Early', true);
    const { api, calendar } = load(seriesFrom(start, [rule], { exceptions: [first] }));
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: startIsoOf(first.startDate), ...movedTo(start, 0, 1), location: 'Room 9',
    });
    expect(res, res.error).toMatchObject({ ok: true });
    const x = changedNamed(calendar.items[0], 'Early');
    expect(x.getProperty('LOCATION')).toBe('Room 9');
    expect(x.startDate.toString()).toBe(calendar.items[0].startDate.toString());
  });

  it('a whole-series move named from a changed first occurrence that adds a guest gives the guest to the series, to a changed occurrence it moves and to that first occurrence', async () => {
    const start = makeUserStart();
    const rule = RULES(start)[1];
    const dates = ruleDatesOf(rule, start);
    const first = withGuests(changedAt(dates[0], 'Early', true), [guest('ana')]);
    const kept = withGuests(changedAt(dates[3], 'Kept', false), [guest('ana')]);
    const { api, calendar } = load(seriesFrom(start, [rule], { exceptions: [first, kept], attendees: [guest('ana')] }));
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: startIsoOf(first.startDate), ...movedTo(start, 1, 1),
      add_attendees: [{ email: 'dee@example.com' }],
    });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(calendar.items).toHaveLength(1);
    const saved = calendar.items[0];
    const ids = (item) => item.getAttendees().map((a) => a.id);
    const both = ['mailto:ana@example.com', 'mailto:dee@example.com'];
    expect(ids(saved)).toEqual(both);
    const movedKept = changedNamed(saved, 'Kept');
    expect(movedKept.startDate.toString()).toBe(after(dates[3], 1, 1).toString());
    expect(ids(movedKept)).toEqual(both);
    const named = changedNamed(saved, 'Early');
    expect(named.startDate.toString()).toBe(saved.startDate.toString());
    expect(ids(named)).toEqual(both);
  });

  it('stopping the repeat from a later occurrence while making it all-day is made, though the series has excluded and added dates', async () => {
    const start = makeUserStart();
    const series = timedWithDatesOnly(start);
    const at = ruleDatesOf(RULES(start)[1], start)[3];
    const { api, calendar } = load(series);
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(at), ...asAllDay(at, 0), recurrence: {},
    });
    expect(res, res.error).toMatchObject({ ok: true });
    const following = calendar.items.find((it) => it.id !== 'ser');
    expect(following.recurrenceInfo).toBeFalsy();
    expect(following.startDate.isDate).toBe(true);
    expect(following.startDate.toString()).toBe(dayOf(at, 0).replace(/-/g, ''));
  });

  it('stopping the repeat from a later occurrence with a move to another day is made, even for a rule a move could not carry', async () => {
    const start = makeUserStart();
    const rule = 'FREQ=MONTHLY;BYDAY=1TH;COUNT=6';
    const at = ruleDatesOf(rule, start)[3];
    const { api, calendar } = load(seriesFrom(start, [rule]));
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(at), ...movedTo(at, 1, 0), recurrence: {},
    });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(calendar.items).toHaveLength(2);
    const following = calendar.items.find((it) => it.id !== 'ser');
    expect(following.recurrenceInfo).toBeFalsy();
    expect(following.startDate.toString()).toBe(after(at, 1).toString());
  });

  it('stopping the repeat with a move to another day is made, even for a rule a move could not carry', async () => {
    const start = makeUserStart();
    const series = seriesFrom(start, ['FREQ=MONTHLY;BYDAY=1TH;COUNT=3']);
    const { api, calendar } = load(series);
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', ...movedTo(start, 1, 0), recurrence: {} });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(ruleValues(calendar.items[0])).toEqual([]);
    expect(calendar.items[0].startDate.toString()).toBe(after(start, 1).toString());
  });

  it('a whole-series time change named from a later occurrence is refused at the bridge, naming this_and_following', async () => {
    const start = makeUserStart();
    const { series, dates } = fullSeries(start, RULES(start)[0]);
    const before = occurrenceKeys(series);
    const { api, calendar, modifications } = load(series);
    const rid = startIsoOf(dates[2]);
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence_id: rid, ...movedTo(dates[2], 0, 1) });
    expect(res).toEqual({ ok: false, error: `recurrence_id ${rid} is a later occurrence: a time change from it on is edit_scope 'this_and_following' with that recurrence_id; a change of every occurrence names the first one` });
    expect(modifications).toEqual([]);
    expect(calendar.items).toEqual([series]);
    expect(occurrenceKeys(series)).toEqual(before);
  });

  it('a following part moved to another day with a new repeat rule is refused, and the series is kept', async () => {
    const start = makeUserStart();
    const { series, dates } = fullSeries(start, RULES(start)[0]);
    const before = occurrenceKeys(series);
    const { api, calendar } = load(series);
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(dates[3]),
      ...movedTo(dates[3], 1, 0), recurrence: { freq: 'DAILY', count: 3 },
    });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/^a new repeat rule cannot be given with a move of the series to another day/) });
    expect(calendar.items).toEqual([series]);
    expect(occurrenceKeys(series)).toEqual(before);
  });

  // The edit tool asks the bridge to check an edit of the times before the
  // confirmation card (check_only): each refusal of the move is made by that
  // check, so the user is never shown a card for an edit that is then refused,
  // and the check writes nothing.
  const SET_HOURS = 'this series repeats at set hours or minutes, so its time cannot be moved here; tell the user to change it in their calendar app';
  const EXRULE_MOVE = 'this series cancels occurrences by a rule (EXRULE), which a move to another day cannot carry; tell the user to move it in their calendar app';
  const NEW_RULE_MOVE = 'a new repeat rule cannot be given with a move of the series to another day; make the move first, then change the repeat in a second edit (calendar_event_read then shows the moved end)';
  const withExrule = (start) => seriesFrom(start, ['FREQ=WEEKLY;BYDAY=TH,SA;COUNT=12'], {
    extraItems: [{ isNegative: true, icalProperty: { propertyName: 'EXRULE', value: 'FREQ=WEEKLY;BYDAY=SA' } }],
  });
  // Each case: the series, the occurrence the edit is named from (the first
  // one, or a later one for this and following), the edit, and the refusal.
  const CHECKED_REFUSALS = [
    ['the rule\'s days', () => seriesFrom(makeUserStart(), ['FREQ=MONTHLY;BYDAY=1TH;COUNT=6']), (at) => movedTo(at, 1, 0), RULE_DAYS],
    ['set hours', () => seriesFrom(makeUserStart(), ['FREQ=DAILY;BYHOUR=17,20;COUNT=8']), (at) => movedTo(at, 0, 1), SET_HOURS],
    ['a rule that cancels occurrences (EXRULE)', () => withExrule(makeUserStart()), (at) => movedTo(at, 1, 0), EXRULE_MOVE],
    ['a change between timed and all-day', () => fullSeries(makeUserStart(), RULES(makeUserStart())[1]).series, (at) => asAllDay(at, 1), KIND_CHANGE],
    ['a change between all-day and timed', allDayWithOneChanged, (at) => asTimed(at, 1), KIND_CHANGE],
    ['a new repeat rule with a move to another day', () => fullSeries(makeUserStart(), RULES(makeUserStart())[0]).series, (at) => ({ ...movedTo(at, 1, 0), recurrence: { freq: 'DAILY', count: 3 } }), NEW_RULE_MOVE],
  ];
  // A later occurrence the rule makes, at the series' own time of day.
  const laterOccurrence = (series) => {
    const rule = ruleValues(series)[0];
    return ruleDatesOf(rule, series.startDate).filter((dt) => dt.isDate || dt.hour === series.startDate.hour)[3];
  };
  async function checkOnly(series, args) {
    const before = occurrenceKeys(series);
    const rulesBefore = ruleValues(series);
    const { api, calendar, modifications } = load(series);
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', ...args, check_only: true });
    expect(modifications).toEqual([]);
    expect(calendar.items).toEqual([series]);
    expect(ruleValues(series)).toEqual(rulesBefore);
    expect(occurrenceKeys(series)).toEqual(before);
    return res;
  }
  for (const [what, make, change, error] of CHECKED_REFUSALS) {
    it(`the check before the card refuses a whole-series move for ${what}, writing nothing`, async () => {
      const series = make();
      const res = await checkOnly(series, { edit_scope: 'all', recurrence_id: startIsoOf(series.startDate), ...change(series.startDate) });
      expect(res).toEqual({ ok: false, error });
    });

    it(`the check before the card refuses a move from a later occurrence on for ${what}, writing nothing`, async () => {
      const series = make();
      const at = laterOccurrence(series);
      const res = await checkOnly(series, { edit_scope: 'this_and_following', recurrence_id: startIsoOf(at), ...change(at) });
      // A split refuses a series with an EXRULE before it moves anything.
      expect(res).toEqual({ ok: false, error: what.includes('EXRULE') ? 'this series cancels occurrences by a rule (EXRULE), which a split cannot keep; change it in the calendar app' : error });
    });
  }
});

describe('the edit tool routes a whole-series time change before the card', () => {
  const ASK = "ask the user whether they mean just that date, or that date and every later one; then pass recurrence_id (the occurrence's start_iso as calendar_event_read shows it) with edit_scope 'this_only' or 'this_and_following'";
  const settle = () => new Promise((r) => setTimeout(r, 20));
  let n = 0;
  async function runEdit(master, args, eventId = 'ser') {
    const loaded = load(master);
    browser.tmCalendar.getCalendarEventDetails.mockImplementation((...a) => loaded.api.getCalendarEventDetails(...a));
    const pid = `pid-move-${n++}`;
    ctx.fsmSessions[pid] = {};
    ctx.state = null;
    try {
      await editRun({ event_id: eventId, calendar_id: 'cal1', ...args }, { callId: pid });
      await settle();
    } finally {
      browser.tmCalendar.getCalendarEventDetails.mockReset();
    }
    return { sess: ctx.fsmSessions[pid], ...loaded };
  }

  for (const [kind, makeStart] of Object.entries(START_KINDS)) {
    it(`a series ${kind}: with no occurrence named, a start on another date asks the user; on the series' own date it reaches the card for the whole series`, async () => {
      const start = makeStart();
      const { series, dates } = fullSeries(start, RULES(start)[0]);
      const asked = await runEdit(series, movedTo(dates[3], 0, 1));
      expect(asked.sess.failReason).toBe(ASK);
      expect(asked.sess.editEventArgs).toBeUndefined();
      expect(asked.modifications).toEqual([]);
      const own = await runEdit(fullSeries(start, RULES(start)[0]).series, movedTo(start, 0, 1));
      expect(own.sess.failReason).toBeUndefined();
      expect(own.sess.editEventArgs).not.toHaveProperty('edit_scope');
    });

    it(`a series ${kind}: a whole-series move named from a later occurrence becomes this and following, and the earlier occurrences stay`, async () => {
      const start = makeStart();
      const { series, dates } = fullSeries(start, RULES(start)[0]);
      const at = dates[3];
      const before = occurrenceKeys(series);
      const { sess, api, calendar } = await runEdit(series, { edit_scope: 'all', recurrence_id: startIsoOf(at), ...movedTo(at, 1, 1) });
      expect(sess.failReason).toBeUndefined();
      expect(sess.editEventArgs).toMatchObject({ edit_scope: 'this_and_following', recurrence_id: startIsoOf(at) });
      // The card's edit, as the confirmation hands it to the bridge.
      const res = await api.modifyCalendarEvent(sess.editEventArgs);
      expect(res, res.error).toMatchObject({ ok: true });
      expect(calendar.items).toHaveLength(2);
      const atKey = instantKey(at);
      const earlierExpected = before.filter((k) => !k.startsWith('changed ') && k < atKey);
      expect(occurrenceKeys(calendar.items.find((it) => it.id === 'ser')).filter((k) => !k.startsWith('changed '))).toEqual(earlierExpected);
    });

    it(`a series ${kind}: a whole-series move named from the first occurrence stays a change of every occurrence`, async () => {
      const start = makeStart();
      const { sess } = await runEdit(fullSeries(start, RULES(start)[0]).series, { edit_scope: 'all', recurrence_id: startIsoOf(start), ...movedTo(start, 1, 1) });
      expect(sess.failReason).toBeUndefined();
      expect(sess.editEventArgs).toMatchObject({ edit_scope: 'all' });
    });
  }

  it('an end alone on another date than the series\' end asks the user; on its own end date it reaches the card', async () => {
    const start = makeUserStart();
    const { series, dates } = fullSeries(start, RULES(start)[0]);
    const asked = await runEdit(series, { end_iso: startIsoOf(after(dates[3], 0, 2)) });
    expect(asked.sess.failReason).toBe(ASK);
    const own = await runEdit(fullSeries(start, RULES(start)[0]).series, { end_iso: startIsoOf(after(start, 0, 2)) });
    expect(own.sess.failReason).toBeUndefined();
  });

  it('a time change of an event that cannot be read is refused before the card', async () => {
    const start = makeUserStart();
    const { sess } = await runEdit(fullSeries(start, RULES(start)[0]).series, movedTo(start, 0, 1), 'missing');
    expect(sess.failReason).toBe('could not read this event (event not found); try again');
    expect(sess.editEventArgs).toBeUndefined();
  });

  it('a recurrence_id that names no occurrence is refused before the card', async () => {
    const start = makeUserStart();
    // Three hours after the first occurrence: no rule date, added date or changed occurrence.
    const rid = startIsoOf(after(start, 0, 3));
    const { sess } = await runEdit(fullSeries(start, RULES(start)[0]).series, { edit_scope: 'all', recurrence_id: rid, ...movedTo(start, 0, 1) });
    expect(sess.failReason).toBe(`recurrence_id ${rid} is not the start of an occurrence of this series; pass the occurrence's start_iso as the read tools show it`);
    expect(sess.editEventArgs).toBeUndefined();
  });

  it('a new repeat rule with a move to another day is refused before the card, named from the first occurrence or a later one', async () => {
    const start = makeUserStart();
    for (const at of [start, fullSeries(start, RULES(start)[0]).dates[3]]) {
      const { sess } = await runEdit(fullSeries(start, RULES(start)[0]).series, {
        edit_scope: 'all', recurrence_id: startIsoOf(at), ...movedTo(at, 1, 0), recurrence: { freq: 'DAILY', count: 3 },
      });
      expect(sess.failReason).toBe('a new repeat rule cannot be given with a move of the series to another day; make the move first, then change the repeat in a second edit (calendar_event_read then shows the moved end)');
    }
  });

  it('other edits are not routed: one occurrence, stopping the repeat, no new time, and an event that does not repeat', async () => {
    const start = makeUserStart();
    const { dates } = fullSeries(start, RULES(start)[0]);
    const oneOccurrence = await runEdit(fullSeries(start, RULES(start)[0]).series, { recurrence_id: startIsoOf(dates[3]), ...movedTo(dates[3], 1, 1) });
    expect(oneOccurrence.sess.failReason).toBeUndefined();
    expect(oneOccurrence.sess.editEventArgs).not.toHaveProperty('edit_scope');
    const stops = await runEdit(fullSeries(start, RULES(start)[0]).series, { ...movedTo(dates[3], 0, 1), recurrence: {} });
    expect(stops.sess.failReason).toBeUndefined();
    const titleOnly = await runEdit(fullSeries(start, RULES(start)[0]).series, { edit_scope: 'all', recurrence_id: startIsoOf(dates[3]), title: 'Renamed' });
    expect(titleOnly.sess.failReason).toBeUndefined();
    expect(titleOnly.sess.editEventArgs).toMatchObject({ edit_scope: 'all' });
    const single = fakeEvent({ id: 'ser', title: 'Once', startDate: fakeDateTime(START_DAY, 17), endDate: fakeDateTime(START_DAY, 18) });
    const once = await runEdit(single, movedTo(after(start, 5), 0, 1));
    expect(once.sess.failReason).toBeUndefined();
  });
});
