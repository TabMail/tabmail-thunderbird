/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarRecurrenceFormat.test.js: the calendar tools read a recurring event's
// rule in the same fields the create and edit tools write, so the model can
// pass back exactly what it read. Pinned here, through the real bridge:
//   - the read side shows those fields, with `until` as the last day the stored
//     bound admits, computed the way Thunderbird expands it (never the UTC date
//     of the UNTIL instant), for an event in the user's zone, in another zone,
//     floating, and all-day;
//   - writing what was read admits the same occurrences, and a written last day's
//     occurrence stays in the series;
//   - writing a rule on an edit keeps the series' excluded and added dates;
//   - the rule is read from where Thunderbird stores it, never an in-memory echo;
//   - a series with more than one rule shows the others and is never restated
//     to one rule;
//   - `{}` clears the rule;
//   - the argument shapes Thunderbird delivers (omitted fields null) keep the
//     rule on an edit that does not mention it;
//   - a last day after a daylight saving change keeps its frame;
//   - a "this and following" split keeps the series: the two parts' occurrences
//     together are the series' (rules, excluded and added dates, changed
//     occurrences), or the split is refused and writes nothing;
//   - a rule the tools cannot write is refused before the confirmation card.

// West of UTC, so a UTC UNTIL instant names the NEXT day in UTC digits.
process.env.TZ = 'America/Vancouver';

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));

const {
  loadCalendarBridge, fakeCalDateTime, fakeDate, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem,
  recurrenceDate, seriesOccurrences, fixedZone, FLOATING_ZONE, UTC_ZONE, LOCAL_ZONE,
} = await import('./helpers/calendarBridgeHarness.js');
const {
  recurrenceArgError, otherPartsRefusal, formatRecurrenceLine, recurrenceMark, OTHER_PARTS_NOTE,
} = await import('../chat/modules/recurrence.js');

// A far-future series start: 2099 is the dated-test exception (never goes stale).
const START_DAY = '2099-10-01';
const LAST_DAY = '2099-10-31';
const pad2 = (n) => String(n).padStart(2, '0');

// The UTC instant of a local wall-clock time, as an RRULE UNTIL value.
function utcUntil(day, hour, minute = 0, second = 0) {
  const [y, m, d] = day.split('-').map(Number);
  const u = new Date(y, m - 1, d, hour, minute, second);
  return `${u.getUTCFullYear()}${pad2(u.getUTCMonth() + 1)}${pad2(u.getUTCDate())}T${pad2(u.getUTCHours())}${pad2(u.getUTCMinutes())}${pad2(u.getUTCSeconds())}Z`;
}

function series(rrule, { allDay = false, extraItems = [], startDate = null, exceptions = [] } = {}) {
  const start = startDate || (allDay ? fakeDate(START_DAY) : fakeDateTime(START_DAY, 17));
  const endDate = start.isDate ? fakeDate('2099-10-02') : fakeCalDateTime({ ...start, hour: start.hour + 1 });
  const ev = fakeEvent({ id: 'ser', title: 'Sync', startDate: start, endDate });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', rrule), ...extraItems], { exceptions });
  ev.recurrenceInfo.item = ev;
  return ev;
}

// East of UTC, so a bound's day differs from the user's (Vancouver) zone.
const EAST = fixedZone('Test/East+0900', 9 * 60);
// West of the user's zone, so a DATE's day starts after it does for the user.
const WEST = fixedZone('Test/West-1000', -10 * 60);
const CAL_UTILS = 'resource:///modules/calendar/calUtils.sys.mjs';
const DAY_MS = 86400 * 1000;
const dayString = (ms) => { const u = new Date(ms); return `${u.getUTCFullYear()}-${pad2(u.getUTCMonth() + 1)}-${pad2(u.getUTCDate())}`; };

// The kinds of start a series can have: each is expanded in its own frame.
const START_KINDS = {
  "timed in the user's zone": () => fakeDateTime(START_DAY, 17),
  'timed in another zone, east of UTC': () => fakeDateTime(START_DAY, 17, 0, EAST),
  'floating': () => fakeDateTime(START_DAY, 17, 0, FLOATING_ZONE),
  'all-day': () => fakeDate(START_DAY),
};
// The value type a written UNTIL must have for each kind of start (RFC 5545
// 3.3.10: UNTIL has DTSTART's value type): a DATE for an all-day start, a local
// DATE-TIME for a floating one, and a UTC DATE-TIME for a start in a zone.
const UNTIL_SHAPE = {
  "timed in the user's zone": /^\d{8}T\d{6}Z$/,
  'timed in another zone, east of UTC': /^\d{8}T\d{6}Z$/,
  'floating': /^\d{8}T\d{6}$/,
  'all-day': /^\d{8}$/,
};

// The last day whose occurrence a DAILY series from `start` admits under
// `until`, the way Thunderbird (ical.js) expands it: the series ends at the
// first occurrence that compares after UNTIL (inclusive bound); a `Z` value is
// that instant and a DATE or floating value its digits at offset 0; each
// occurrence is the start's wall-clock time on its day in the start's zone (an
// all-day occurrence is its DATE, at offset 0). Independent of the bridge.
function lastDayAdmitted(start, until) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(until);
  expect(m).not.toBeNull();
  const bound = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  let last = null;
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(start.year, start.month, start.day) + i * DAY_MS);
    const occurrence = fakeCalDateTime({ ...start, year: day.getUTCFullYear(), month: day.getUTCMonth(), day: day.getUTCDate() });
    if (occurrence.nativeTime / 1000 > bound) break;
    last = day.getTime();
  }
  return last === null ? null : dayString(last);
}

const untilOf = (rule) => (/UNTIL=([0-9TZ]+)/.exec(rule) || [])[1];

async function readFields(api) {
  const details = await api.getCalendarEventDetails('ser', 'cal1');
  expect(details.ok).toBe(true);
  return details.recurrence;
}

function savedItem(calendar) {
  return calendar.items.find((it) => it.id === 'ser');
}

function ruleValues(item) {
  return (item.recurrenceInfo?.getRecurrenceItems() || [])
    .filter((r) => r.icalProperty.propertyName === 'RRULE')
    .map((r) => r.icalProperty.value);
}

describe('read: the rule in the edit tool\'s own fields', () => {
  it('a UTC UNTIL instant is read as the last day in the event\'s zone, not its UTC date', async () => {
    // 23:00 local on the last day is already the next day in UTC.
    const until = utcUntil(LAST_DAY, 23);
    expect(until.startsWith('20991101')).toBe(true);
    const { api } = loadCalendarBridge(bridgeUrl, { items: [series(`FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=${until}`)] });
    expect(await readFields(api)).toEqual({ freq: 'WEEKLY', until: LAST_DAY, byDay: ['MO', 'WE'] });
  });

  it('every writable field is shown, and the rule in recurrenceInfo is found when the property is empty', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, {
      items: [series('FREQ=YEARLY;INTERVAL=1;WKST=MO;COUNT=5;BYMONTH=3,9;BYMONTHDAY=1,-1')],
    });
    expect(await readFields(api)).toEqual({ freq: 'YEARLY', count: 5, byMonthDay: [1, -1], byMonth: [3, 9] });
  });

  it('a non-default interval and week start are shown', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=TU')] });
    expect(await readFields(api)).toEqual({ freq: 'WEEKLY', interval: 2, byDay: ['TU'], wkst: 'SU' });
  });

  // Thunderbird 140 to 158 expand BYDAY=TU;BYSETPOS=2 differently from
  // BYDAY=2TU when the series start is not itself an occurrence, so no
  // BYSETPOS is folded into an ordinal byDay: it stays in `other`, and
  // restating it is refused.
  it('BYSETPOS is shown as `other`, never folded into an ordinal byDay', async () => {
    for (const [rule, fields] of [
      ['FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2', { freq: 'MONTHLY', byDay: ['TU'], other: 'BYSETPOS=2' }],
      ['FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1', { freq: 'MONTHLY', byDay: ['FR'], other: 'BYSETPOS=-1' }],
      ['FREQ=YEARLY;BYMONTH=3;BYDAY=TU;BYSETPOS=2', { freq: 'YEARLY', byDay: ['TU'], byMonth: [3], other: 'BYSETPOS=2' }],
      ['FREQ=YEARLY;BYDAY=MO;BYSETPOS=-20', { freq: 'YEARLY', byDay: ['MO'], other: 'BYSETPOS=-20' }],
      ['FREQ=DAILY;BYDAY=TU;BYSETPOS=1', { freq: 'DAILY', byDay: ['TU'], other: 'BYSETPOS=1' }],
    ]) {
      const { api } = loadCalendarBridge(bridgeUrl, { items: [series(rule)] });
      const read = await readFields(api);
      expect(read, rule).toEqual(fields);
      const { other, ...restated } = read;
      expect(otherPartsRefusal(restated, read), rule).toMatch(/BYSETPOS/);
    }
  });

  it('parts the fields cannot express are shown as `other`', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')] });
    expect(await readFields(api)).toEqual({ freq: 'MONTHLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], other: 'BYSETPOS=-1' });
    const weekNo = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO')] });
    expect(await readFields(weekNo.api)).toEqual({ freq: 'YEARLY', byDay: ['MO'], other: 'BYWEEKNO=20' });
  });

  // Bounds every writer has stored: earlier versions (UTC midnight of the named
  // day), a date-time `until` (an instant), this version (end of the day in the
  // start's value type), other apps (DATE, floating), and bounds exactly at an
  // occurrence in each zone.
  const BOUNDS = [
    '20991031T000000Z', '20991031T235959Z', '20991101T065959Z', utcUntil(LAST_DAY, 23), utcUntil(LAST_DAY, 17),
    '20991031T080000Z', '20991031T075959Z', '20991031', '20991031T170000', '20991031T165959', '20991031T235959',
  ];
  for (const [kind, makeStart] of Object.entries(START_KINDS)) {
    it(`${kind}: until is the last day the stored bound admits`, async () => {
      for (const bound of BOUNDS) {
        const start = makeStart();
        const { api } = loadCalendarBridge(bridgeUrl, { items: [series(`FREQ=DAILY;UNTIL=${bound}`, { startDate: start })] });
        expect({ bound, until: (await readFields(api)).until }).toEqual({ bound, until: lastDayAdmitted(start, bound) });
      }
    });
  }

  // 2099-10-01 is a Thursday. A weekly rule's weeks start with the start's own
  // week (Monday 09-28, before the start), so the first Monday is 10-05, or
  // 10-12 every other week.
  it('the rule is read from the recurrence info, not an older in-memory RRULE property', async () => {
    const ev = series('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
    ev.setProperty('RRULE', 'FREQ=WEEKLY;BYDAY=MO');
    const { api } = loadCalendarBridge(bridgeUrl, { items: [ev] });
    expect(await readFields(api)).toEqual({ freq: 'WEEKLY', interval: 2, byDay: ['MO'] });
    const rows = await api.queryCalendarItems('2099-10-12T00:00:00', '2099-10-13T00:00:00', ['cal1']);
    expect(rows).toHaveLength(1);
    expect(rows[0].recurrence).toEqual({ freq: 'WEEKLY', interval: 2, byDay: ['MO'] });
  });

  it('the query rows carry the same fields', async () => {
    const until = utcUntil(LAST_DAY, 23);
    const ev = series(`FREQ=WEEKLY;BYDAY=MO;UNTIL=${until}`);
    const { api } = loadCalendarBridge(bridgeUrl, { items: [ev] });
    const rows = await api.queryCalendarItems('2099-10-05T00:00:00', '2099-10-06T00:00:00', ['cal1']);
    expect(rows).toHaveLength(1);
    expect(rows[0].recurrence).toEqual({ freq: 'WEEKLY', until: LAST_DAY, byDay: ['MO'] });
    expect(rows[0].isRecurring).toBe(true);
  });

  it('the tools print the object the edit tool takes, and flag parts it cannot write', () => {
    expect(formatRecurrenceLine({ freq: 'WEEKLY', byDay: ['MO'] })).toBe('recurrence: {"freq":"WEEKLY","byDay":["MO"]}');
    expect(formatRecurrenceLine({ freq: 'YEARLY', other: 'BYWEEKNO=20' })).toBe(`recurrence: {"freq":"YEARLY","other":"BYWEEKNO=20"} (${OTHER_PARTS_NOTE})`);
    expect(formatRecurrenceLine(null)).toBe('');
    expect(recurrenceMark({ freq: 'DAILY', count: 3 })).toBe(' (↻ {"freq":"DAILY","count":3})');
  });
});

describe('write: what was read, written back, reads the same', () => {
  const cases = [
    { name: 'weekly with a last day', allDay: false, fields: { freq: 'WEEKLY', byDay: ['MO', 'WE'], until: LAST_DAY } },
    { name: 'monthly on the second Tuesday', allDay: false, fields: { freq: 'MONTHLY', byDay: ['2TU'], count: 6 } },
    { name: 'every other year in March and September', allDay: false, fields: { freq: 'YEARLY', interval: 2, byMonth: [3, 9], byMonthDay: [15], wkst: 'SU' } },
    { name: 'all-day daily with a last day', allDay: true, fields: { freq: 'DAILY', until: LAST_DAY } },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY', { allDay: c.allDay })] });
      expect(await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: c.fields })).toMatchObject({ ok: true });
      expect(ruleValues(savedItem(calendar))).toHaveLength(1);
      expect(await readFields(api)).toEqual(c.fields);
    });
  }

  for (const [kind, makeStart] of Object.entries(START_KINDS)) {
    it(`${kind}: a written last day is the last day admitted, and restating any stored bound admits the same days`, async () => {
      const start = makeStart();
      const fresh = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY', { startDate: start })] });
      await fresh.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'DAILY', until: LAST_DAY } });
      const [written] = ruleValues(savedItem(fresh.calendar));
      expect(untilOf(written)).toMatch(UNTIL_SHAPE[kind]);
      expect(lastDayAdmitted(start, untilOf(written))).toBe(LAST_DAY);
      expect((await readFields(fresh.api)).until).toBe(LAST_DAY);
      for (const bound of ['20991031T000000Z', '20991101T065959Z', '20991031T075959Z', '20991031', '20991031T165959']) {
        const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series(`FREQ=DAILY;UNTIL=${bound}`, { startDate: makeStart() })] });
        await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: await readFields(api) });
        const [restated] = ruleValues(savedItem(calendar));
        expect({ bound, until: untilOf(restated) }).toEqual({ bound, until: expect.stringMatching(UNTIL_SHAPE[kind]) });
        expect({ bound, admitted: lastDayAdmitted(start, untilOf(restated)) }).toEqual({ bound, admitted: lastDayAdmitted(start, bound) });
      }
    });
  }

  // Thunderbird expands every rule a series holds, and (before comm-central bug
  // 2082832) an imported EXRULE is one more of them, so a second rule adds its
  // own occurrences. The fields name one
  // rule; restating them would leave only that one.
  for (const secondName of ['RRULE', 'EXRULE']) {
    it(`a series with a second rule (stored as ${secondName}) shows it, so restating is refused and {} clears both`, async () => {
      const make = () => series('FREQ=WEEKLY;BYDAY=MO', { extraItems: [recurrenceItem(secondName, 'FREQ=MONTHLY;BYMONTHDAY=1')] });
      const read = loadCalendarBridge(bridgeUrl, { items: [make()] });
      const fields = await readFields(read.api);
      expect(fields).toEqual({ freq: 'WEEKLY', byDay: ['MO'], other: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1' });
      expect(otherPartsRefusal({ freq: 'WEEKLY', byDay: ['MO'], until: LAST_DAY }, fields)).toMatch(/RRULE:FREQ=MONTHLY;BYMONTHDAY=1/);
      expect(otherPartsRefusal({}, fields)).toBeNull();

      const cleared = loadCalendarBridge(bridgeUrl, { items: [make()] });
      expect(await cleared.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: {} })).toMatchObject({ ok: true });
      expect(ruleValues(savedItem(cleared.calendar))).toEqual([]);
      expect(await readFields(cleared.api)).toBeNull();
    });
  }

  it('a series created with a last day stores it in the start\'s value type', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [] });
    const res = await api.createCalendarEvent({ calendar_id: 'cal1', title: 'Daily', start_iso: '2099-10-01T00:00:00', end_iso: '2099-10-02T00:00:00', all_day: true, recurrence: { freq: 'DAILY', until: LAST_DAY } });
    expect(res).toMatchObject({ ok: true });
    expect(ruleValues(calendar.items[0])).toEqual(['FREQ=DAILY;UNTIL=20991031']);
  });

  it('a plain-date until on a timed series keeps the last day\'s occurrence in the series', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY')] });
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'DAILY', until: LAST_DAY } });
    const [rule] = ruleValues(savedItem(calendar));
    const m = /UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(rule);
    expect(m).not.toBeNull();
    const untilMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const [y, mo, d] = LAST_DAY.split('-').map(Number);
    expect(untilMs).toBeGreaterThanOrEqual(new Date(y, mo - 1, d, 17).getTime()); // the last occurrence
    expect(untilMs).toBeLessThan(new Date(y, mo - 1, d + 1, 17).getTime()); // and not the one after
  });

  it('an all-day series gets a bare DATE until', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY', { allDay: true })] });
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'DAILY', until: LAST_DAY } });
    expect(ruleValues(savedItem(calendar))).toEqual(['FREQ=DAILY;UNTIL=20991031']);
  });

  it('writing a rule keeps the series\' excluded and added dates, and its changed occurrences', async () => {
    const exdate = recurrenceItem('EXDATE', '20991020T170000');
    const rdate = recurrenceItem('RDATE', '20991102T170000');
    const moved = fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime('2099-10-12', 19), endDate: fakeDateTime('2099-10-12', 20), recurrenceId: fakeDateTime('2099-10-12', 17) });
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=WEEKLY;BYDAY=MO', { extraItems: [exdate, rdate], exceptions: [moved] })] });
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'WEEKLY', byDay: ['TU'] } });
    const info = savedItem(calendar).recurrenceInfo;
    // The saved item holds copies (cloning an item clones its recurrence).
    const items = info.getRecurrenceItems().map((r) => r.icalProperty);
    expect(items).toContainEqual(exdate.icalProperty);
    expect(items).toContainEqual(rdate.icalProperty);
    expect(ruleValues(savedItem(calendar))).toEqual(['FREQ=WEEKLY;BYDAY=TU']);
    expect(info.getExceptionIds().map(String)).toEqual(['20991012T170000']);
    const kept = info.getExceptionFor(fakeDateTime('2099-10-12', 17));
    expect(kept.title).toBe('Moved');
    expect(kept.startDate.toString()).toBe('20991012T190000');
    expect(kept.endDate.toString()).toBe('20991012T200000');
  });

  it('a rule written over a series with two rules leaves only the rule written', async () => {
    const extra = recurrenceItem('RRULE', 'FREQ=MONTHLY;BYMONTHDAY=1');
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=WEEKLY;BYDAY=MO', { extraItems: [extra] })] });
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'WEEKLY', byDay: ['TU'] } });
    expect(ruleValues(savedItem(calendar))).toEqual(['FREQ=WEEKLY;BYDAY=TU']);
  });

  it('`{}` clears the rule, and the event no longer repeats', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=WEEKLY;BYDAY=MO')] });
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: {} });
    const saved = savedItem(calendar);
    expect(saved.recurrenceInfo).toBeNull();
    const details = await api.getCalendarEventDetails('ser', 'cal1');
    expect(details.recurrence).toBeNull();
    expect(details.isRecurring).toBe(false);
  });

  it('an edit without recurrence keeps the stored rule', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=WEEKLY;BYDAY=MO')] });
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', title: 'Renamed' });
    expect(ruleValues(savedItem(calendar))).toEqual(['FREQ=WEEKLY;BYDAY=MO']);
  });
});

// The days a MONTHLY rule names in each of `months` months from `year`/`month0`,
// as RFC 5545 expands it, independent of the bridge: BYMONTHDAY and a plain
// BYDAY filter the month's days, an ordinal BYDAY (2TU, -1FR) picks that
// weekday's nth day of the whole month, and BYSETPOS then picks positions in the
// sorted set. Only the parts these tests store are understood.
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function monthlyDays(rule, year, month0, months) {
  const parts = Object.fromEntries(rule.split(';').map((p) => p.split('=')));
  expect(parts.FREQ).toBe('MONTHLY');
  for (const k of Object.keys(parts)) expect(['FREQ', 'BYDAY', 'BYMONTHDAY', 'BYSETPOS']).toContain(k);
  const list = (v) => (v ? v.split(',') : []);
  const days = [];
  for (let i = 0; i < months; i++) {
    const first = new Date(Date.UTC(year, month0 + i, 1));
    const y = first.getUTCFullYear(); const m = first.getUTCMonth();
    const length = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const weekday = (d) => WEEKDAYS[new Date(Date.UTC(y, m, d)).getUTCDay()];
    let set = Array.from({ length }, (_, k) => k + 1);
    const monthDays = list(parts.BYMONTHDAY).map(Number).map((n) => (n > 0 ? n : length + 1 + n));
    if (monthDays.length) set = set.filter((d) => monthDays.includes(d));
    const byDay = list(parts.BYDAY);
    if (byDay.length) {
      set = set.filter((d) => byDay.some((code) => {
        const [, n, wd] = /^([+-]?\d*)([A-Z]{2})$/.exec(code);
        if (weekday(d) !== wd) return false;
        if (!n) return true;
        const same = Array.from({ length }, (_, k) => k + 1).filter((x) => weekday(x) === wd);
        return same.at(Number(n) > 0 ? Number(n) - 1 : Number(n)) === d;
      }));
    }
    const setPos = list(parts.BYSETPOS).map(Number);
    if (setPos.length) set = setPos.map((n) => set.at(n > 0 ? n - 1 : n)).filter((d) => d !== undefined);
    for (const d of [...new Set(set)].sort((a, b) => a - b)) days.push(`${y}-${pad2(m + 1)}-${pad2(d)}`);
  }
  return days;
}

describe('a monthly rule read and written back names the same days, or restating it is refused', () => {
  const STORED = [
    'FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2',
    'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1',
    'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1',
    'FREQ=MONTHLY;BYDAY=WE;BYSETPOS=5',
    'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=-2',
    'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=1,2,3,4,5,6,7,8,9,10,11,12,13,14;BYSETPOS=-1',
    'FREQ=MONTHLY;BYDAY=TU;BYMONTHDAY=8,9,10,11,12,13,14;BYSETPOS=1',
    'FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1',
    'FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1,3',
  ];
  for (const stored of STORED) {
    it(stored, async () => {
      const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series(stored)] });
      const read = await readFields(api);
      if (read.other) {
        const { other, ...restated } = read;
        expect(otherPartsRefusal(restated, read)).not.toBeNull();
        return;
      }
      expect(await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: read })).toMatchObject({ ok: true });
      const [written] = ruleValues(savedItem(calendar));
      expect({ written, days: monthlyDays(written, 2099, 9, 24) }).toEqual({ written, days: monthlyDays(stored, 2099, 9, 24) });
    });
  }

  it('the enumerator tells a folded rule from one that names other days', () => {
    expect(monthlyDays('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1', 2099, 9, 1)).toEqual(['2099-10-30']);
    expect(monthlyDays('FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=1,2,3,4,5,6,7,8,9,10,11,12,13,14;BYSETPOS=-1', 2099, 9, 1)).toEqual(['2099-10-09']);
    expect(monthlyDays('FREQ=MONTHLY;BYDAY=-1FR;BYMONTHDAY=1,2,3,4,5,6,7,8,9,10,11,12,13,14', 2099, 9, 1)).toEqual([]);
  });
});

describe('a rule the tools cannot write is refused, naming the field and value', () => {
  const refused = [
    [{ freq: 'HOURLY' }, 'recurrence.freq has an invalid value "HOURLY": one of DAILY, WEEKLY, MONTHLY, YEARLY (use {} to clear the rule)'],
    [{ interval: 2 }, 'recurrence.freq has an invalid value "": one of DAILY, WEEKLY, MONTHLY, YEARLY (use {} to clear the rule)'],
    [{ freq: 'DAILY', interval: 0 }, 'recurrence.interval has an invalid value "0": a positive integer'],
    [{ freq: 'DAILY', interval: 1.5 }, 'recurrence.interval has an invalid value "1.5": a positive integer'],
    [{ freq: 'DAILY', count: '3' }, 'recurrence.count has an invalid value "3": a positive integer'],
    [{ freq: 'DAILY', until: '2099-02-30' }, 'recurrence.until has an invalid value "2099-02-30": a date YYYY-MM-DD (the last day of the series)'],
    [{ freq: 'DAILY', until: 'next friday' }, 'recurrence.until has an invalid value "next friday": a date YYYY-MM-DD (the last day of the series)'],
    [{ freq: 'DAILY', until: '2099-10-31T17:00:00' }, 'recurrence.until has an invalid value "2099-10-31T17:00:00": a date YYYY-MM-DD (the last day of the series)'],
    [{ freq: 'MONTHLY', byDay: ['TU'], bySetPos: [2] }, 'recurrence.bySetPos is not a recurrence field: use freq, interval, count, until, byDay, byMonthDay, byMonth, wkst'],
    [{ freq: 'DAILY', byHour: [9] }, 'recurrence.byHour is not a recurrence field: use freq, interval, count, until, byDay, byMonthDay, byMonth, wkst'],
    ['FREQ=WEEKLY;BYDAY=MO', 'recurrence has an invalid value "FREQ=WEEKLY;BYDAY=MO": an object of recurrence fields, or {} to clear the rule'],
    [{ freq: 'WEEKLY', byDay: ['MO', 'MONDAY'] }, 'recurrence.byDay has an invalid value "MONDAY": day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'WEEKLY', byDay: ['MO;BYHOUR=9'] }, 'recurrence.byDay has an invalid value "MO;BYHOUR=9": day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'MONTHLY', byDay: ['54MO'] }, 'recurrence.byDay has an invalid value "54MO": day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'MONTHLY', byDay: ['0MO'] }, 'recurrence.byDay has an invalid value "0MO": day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'MONTHLY', byDay: ['+0MO'] }, 'recurrence.byDay has an invalid value "+0MO": day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'MONTHLY', byDay: ['+MO'] }, 'recurrence.byDay has an invalid value "+MO": day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'MONTHLY', byDay: ['-TU'] }, 'recurrence.byDay has an invalid value "-TU": day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'WEEKLY', byDay: 'MO' }, 'recurrence.byDay has an invalid value "MO": a list of day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'MONTHLY', byMonthDay: [0] }, 'recurrence.byMonthDay has an invalid value "0": integers from 1 to 31 or -31 to -1'],
    [{ freq: 'MONTHLY', byMonthDay: [32] }, 'recurrence.byMonthDay has an invalid value "32": integers from 1 to 31 or -31 to -1'],
    [{ freq: 'MONTHLY', byMonthDay: [-32] }, 'recurrence.byMonthDay has an invalid value "-32": integers from 1 to 31 or -31 to -1'],
    [{ freq: 'YEARLY', byMonth: [13] }, 'recurrence.byMonth has an invalid value "13": integers from 1 to 12'],
    [{ freq: 'YEARLY', byMonth: [0] }, 'recurrence.byMonth has an invalid value "0": integers from 1 to 12'],
    [{ freq: 'WEEKLY', wkst: 'monday' }, 'recurrence.wkst has an invalid value "monday": one of MO, TU, WE, TH, FR, SA, SU'],
    [{ freq: 'YEARLY', other: 'BYWEEKNO=20' }, `recurrence.other has an invalid value "BYWEEKNO=20": ${OTHER_PARTS_NOTE}`],
    [[], 'recurrence has an invalid value "[]": an object of recurrence fields, or {} to clear the rule'],
  ];
  for (const [arg, message] of refused) {
    it(JSON.stringify(arg), () => {
      expect(recurrenceArgError(arg, { canClear: true })).toBe(message);
    });
  }

  // Create has no rule to clear or keep. Every create refusal is edit's text
  // without the `{}` hint (and, for `other`, create's own note), so it names the
  // same field, value and allowed form, and none points the model at a value
  // that would make an event that does not repeat: not `{}`, not leaving
  // recurrence out to "keep" a rule. Leaving it out is named only as the way to
  // make a one-off event.
  for (const [arg, message] of refused) {
    it(`on create, ${JSON.stringify(arg)} is refused without pointing at a one-off event`, () => {
      const onCreate = recurrenceArgError(arg, { canClear: false });
      expect(onCreate).toBe(message
        .replace(', or {} to clear the rule', '')
        .replace(' (use {} to clear the rule)', '')
        .replace(OTHER_PARTS_NOTE, 'the create tool cannot write these; tell the user to create this series in the calendar app'));
      expect(onCreate).not.toContain('{}');
      expect(onCreate).not.toMatch(/keep/i);
      if (/omit recurrence/i.test(onCreate)) expect(onCreate).toContain('omit recurrence for an event that does not repeat');
    });
  }
  it('on create, {} is refused, naming freq', () => {
    expect(recurrenceArgError({}, { canClear: false })).toBe(
      'recurrence {} sets no rule: give freq, such as {"freq":"WEEKLY"}, or omit recurrence for an event that does not repeat');
  });

  const accepted = [
    {},
    { freq: 'WEEKLY', byDay: ['MO', 'WE'], until: LAST_DAY },
    { freq: 'MONTHLY', byDay: ['2TU', '-1FR', '+3WE'], interval: 3, wkst: 'SU' },
    { freq: 'YEARLY', byMonth: [1, 12], byMonthDay: [31, -31], count: 10 },
    { freq: 'MONTHLY', byDay: ['5FR', '-5MO'] },
    { freq: 'YEARLY', byDay: ['20MO'] },
  ];
  for (const arg of accepted) {
    it(`accepts ${JSON.stringify(arg)}`, () => {
      expect(recurrenceArgError(arg, { canClear: true })).toBeNull();
      if (Object.keys(arg).length) expect(recurrenceArgError(arg, { canClear: false })).toBeNull();
    });
  }

  it('restating a series whose stored rule has `other` parts is refused; omitting or clearing it is not', () => {
    const stored = { freq: 'YEARLY', byDay: ['MO'], other: 'BYWEEKNO=20' };
    expect(otherPartsRefusal({ freq: 'YEARLY', byDay: ['MO'] }, stored)).toBe(
      'this series repeats in a way the edit tool cannot express (BYWEEKNO=20); omit recurrence to keep it, or change the repeat in the calendar app');
    expect(otherPartsRefusal({}, stored)).toBeNull();
    expect(otherPartsRefusal(undefined, stored)).toBeNull();
    expect(otherPartsRefusal({ freq: 'WEEKLY' }, { freq: 'WEEKLY' })).toBeNull();
  });
});

describe('split: the capped rule and the following part\'s rule', () => {
  async function splitAt(master, recurrenceId, patch = { title: 'Renamed' }) {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [master] });
    const res = await loaded.api.splitRecurringEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence_id: recurrenceId, patch });
    expect(res).toMatchObject({ ok: true });
    return {
      ...loaded,
      capped: loaded.calendar.items.find((it) => it.id === 'ser'),
      fresh: loaded.calendar.items.find((it) => it.id !== 'ser'),
    };
  }
  it('the capped series ends the day before the split, and reads and restates that way', async () => {
    const start = fakeDateTime(START_DAY, 17);
    const { api, calendar, capped, fresh } = await splitAt(series('FREQ=DAILY', { startDate: start }), '2099-10-15T17:00:00');
    const [cap] = ruleValues(capped);
    expect(lastDayAdmitted(start, untilOf(cap))).toBe('2099-10-14');
    expect(fresh.startDate.toString()).toBe('20991015T170000');
    expect((await readFields(api)).until).toBe('2099-10-14');
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { ...(await readFields(api)), interval: 2 } });
    expect(lastDayAdmitted(start, untilOf(ruleValues(savedItem(calendar))[0]))).toBe('2099-10-14');
  });

  it('caps and continues the rule in the recurrence info, not an older in-memory echo', async () => {
    const master = series('FREQ=DAILY;INTERVAL=2');
    master.setProperty('RRULE', 'FREQ=DAILY');
    const { capped, fresh } = await splitAt(master, '2099-10-15T17:00:00');
    expect(ruleValues(capped)[0]).toMatch(/^FREQ=DAILY;INTERVAL=2;UNTIL=/);
    expect(ruleValues(fresh)).toEqual(['FREQ=DAILY;INTERVAL=2']);
  });

  it('a new rule for the following part is written in the start\'s value type', async () => {
    const master = series('FREQ=DAILY', { allDay: true });
    const { fresh } = await splitAt(master, '2099-10-15T00:00:00', { recurrence: { freq: 'DAILY', until: LAST_DAY } });
    expect(ruleValues(fresh)).toEqual(['FREQ=DAILY;UNTIL=20991031']);
  });

  it('a rule Thunderbird stores in another part order (a week start) is split too', async () => {
    const start = fakeDateTime(START_DAY, 17);
    const { capped, fresh } = await splitAt(series('FREQ=DAILY;WKST=SU', { startDate: start }), '2099-10-15T17:00:00');
    const [cap] = ruleValues(capped);
    expect(lastDayAdmitted(start, untilOf(cap))).toBe('2099-10-14');
    expect(cap).toMatch(/WKST=SU/);
    expect(ruleValues(fresh)).toEqual(['FREQ=DAILY;WKST=SU']);
  });

  // An added date is not bounded by UNTIL, so one left on the earlier part
  // would still happen after the split, beside the following part.
  it('no added date or changed occurrence from the split on stays on the earlier part', async () => {
    const atSplit = recurrenceItem('RDATE', '20991015T170000');
    const later = recurrenceItem('RDATE', '20991020T090000');
    const moved = fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime('2099-10-18', 19), endDate: fakeDateTime('2099-10-18', 20), recurrenceId: fakeDateTime('2099-10-18', 17) });
    const { capped } = await splitAt(series('FREQ=DAILY', { extraItems: [atSplit, later], exceptions: [moved] }), '2099-10-15T17:00:00');
    const kept = capped.recurrenceInfo.getRecurrenceItems().filter((r) => r.icalProperty.propertyName === 'RDATE');
    expect(kept.filter((r) => r.date.compare(fakeDateTime('2099-10-15', 17)) >= 0)).toEqual([]);
    expect(capped.recurrenceInfo.getExceptionIds().filter((rid) => rid.compare(fakeDateTime('2099-10-15', 17)) >= 0)).toEqual([]);
  });

  it('a split whose capped rule cannot be set changes nothing in the calendar', async () => {
    // Thunderbird throws when an immutable item is changed; here the earlier
    // part's rule cannot be rewritten.
    const master = series('FREQ=DAILY');
    const clone = master.clone.bind(master);
    master.clone = () => {
      const copy = clone();
      for (const r of copy.recurrenceInfo.getRecurrenceItems()) {
        Object.defineProperty(r, 'icalProperty', { get: () => ({ propertyName: 'RRULE', value: 'FREQ=DAILY' }), set: () => { throw new Error('item is immutable'); } });
      }
      return copy;
    };
    const { api, calendar, modifications } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const res = await api.splitRecurringEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence_id: '2099-10-15T17:00:00', patch: { title: 'Renamed' } });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/item is immutable/);
    expect(modifications).toEqual([]);
    expect(calendar.items).toHaveLength(1);
    expect(calendar.items[0]).toBe(master);
    expect(ruleValues(master)).toEqual(['FREQ=DAILY']);
  });
});

// #265: a "this and following" split divides the series in two. The earlier
// part keeps everything before the split and the following part everything
// from the split on, so together they make exactly the occurrences the series
// made: every rule (UNTIL kept, COUNT reduced to the occurrences still to come),
// excluded and added dates, and changed occurrences. Checked by expanding all
// three with Thunderbird's own recurrence code (seriesOccurrences), for each
// kind of start.
describe('split: the two parts make the series\' occurrences', () => {
  // Wide enough for every occurrence these series make.
  const RANGE = [fakeDate('2099-09-01'), fakeDate('2101-01-01')];
  const instantKey = (dt) => (dt.isDate ? dt.toString() : new Date(dt.nativeTime / 1000).toISOString());
  const occurrenceKeys = (item) => seriesOccurrences(item, ...RANGE)
    .map(({ start, item: occ }) => (occ.recurrenceId ? `changed ${instantKey(start)} ${occ.title}` : instantKey(start)))
    .sort();
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
  // A recurrence_id as the read tools show it: the occurrence's start_iso, in
  // the user's zone (floating time by its digits, an all-day occurrence as its
  // date at midnight).
  const startIsoOf = (dt) => {
    if (dt.isDate) return `${dt.year}-${pad2(dt.month + 1)}-${pad2(dt.day)}T00:00:00`;
    const d = dt.timezone === FLOATING_ZONE ? dt : dt.getInTimezone(LOCAL_ZONE);
    return `${d.year}-${pad2(d.month + 1)}-${pad2(d.day)}T${pad2(d.hour)}:${pad2(d.minute)}:${pad2(d.second)}`;
  };
  // Every kind of start, a start in UTC, a plain all-day date, and all-day
  // series stored with a zone (as TabMail wrote them before it wrote plain
  // dates, and as some other apps do): a DATE's epoch time depends on its zone,
  // so the split's day arithmetic must not use it (east of UTC its day starts
  // the day before in UTC; west of UTC it starts after the UTC midnight that an
  // UNTIL date names).
  // West of UTC, ical.js, which compares a rule's UNTIL by instant, ends a
  // series whose all-day start carries the zone a day before the date its
  // bare-date UNTIL names. A split writes every all-day value of both parts as
  // a plain date (its digits kept), so the capped part keeps the day before the
  // split, and a rule's UNTIL keeps the day it names.
  const WEST_ALL_DAY_KINDS = {
    "all-day, made in the user's zone (west of UTC)": () => fakeDate(START_DAY, LOCAL_ZONE),
    "all-day, made in a zone west of the user's": () => fakeDate(START_DAY, WEST),
  };
  const ZONED_ALL_DAY_KINDS = {
    'all-day, made in a zone east of UTC': () => fakeDate(START_DAY, EAST),
    ...WEST_ALL_DAY_KINDS,
  };
  const SPLIT_START_KINDS = {
    ...START_KINDS,
    'timed in UTC': () => fakeDateTime(START_DAY, 17, 0, UTC_ZONE),
    'all-day, a plain date': () => fakeDate(START_DAY, FLOATING_ZONE),
    ...ZONED_ALL_DAY_KINDS,
  };
  // A value with no zone, its digits kept: what an all-day value names.
  const plain = (dt) => (dt.isDate ? fakeCalDateTime({ ...dt, timezone: FLOATING_ZONE }) : dt);
  // Every all-day value an item holds (its start and end, its excluded and
  // added dates, and each changed occurrence's RECURRENCE-ID, start and end),
  // as "NAME digits zone".
  const allDayValues = (item) => {
    const info = item.recurrenceInfo;
    const named = [['DTSTART', item.startDate], ['DTEND', item.endDate]];
    for (const r of info?.getRecurrenceItems() || []) if (r.date) named.push([r.icalProperty.propertyName, r.date]);
    for (const rid of info?.getExceptionIds() || []) {
      const ex = info.getExceptionFor(rid);
      named.push(['RECURRENCE-ID', ex.recurrenceId], ['changed DTSTART', ex.startDate], ['changed DTEND', ex.endDate]);
    }
    return named.filter(([, dt]) => dt?.isDate).map(([name, dt]) => `${name} ${dt.toString()} ${dt.timezone.tzid}`);
  };
  // Every all-day value of `item` is a plain date (no zone).
  const expectPlainDates = (item, label) => {
    const values = allDayValues(item);
    expect(values.length, label).toBeGreaterThanOrEqual(2);
    expect(values.filter((v) => !v.endsWith(` ${FLOATING_ZONE.tzid}`)), label).toEqual([]);
  };
  // A part's changed occurrences, each as its RECURRENCE-ID's date and its own
  // start's: where it belongs and where it shows.
  const changedPairs = (item) => item.recurrenceInfo.getExceptionIds()
    .map((rid) => `${rid.toString()}>${item.recurrenceInfo.getExceptionFor(rid).startDate.toString()}`);
  const changedAt = (start, days, title = 'Moved') => {
    const rid = after(start, days);
    const moved = start.isDate ? after(start, days + 1) : after(start, days, 2);
    return fakeEvent({ id: 'ser', title, startDate: moved, endDate: start.isDate ? after(start, days + 2) : after(start, days, 3), recurrenceId: rid });
  };
  function seriesFrom(start, rules, { extraItems = [], exceptions = [] } = {}) {
    const endDate = after(start, start.isDate ? 1 : 0, start.isDate ? 0 : 1);
    const ev = fakeEvent({ id: 'ser', title: 'Sync', startDate: start, endDate });
    ev.recurrenceInfo = fakeRecurrenceInfo([...rules.map((r) => recurrenceItem('RRULE', r)), ...extraItems], { exceptions });
    ev.recurrenceInfo.item = ev;
    return ev;
  }
  async function split(master, recurrenceId, patch = { title: 'Renamed' }) {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [master] });
    const res = await loaded.api.splitRecurringEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence_id: recurrenceId, patch });
    return {
      ...loaded,
      res,
      capped: loaded.calendar.items.find((it) => it.id === 'ser'),
      fresh: loaded.calendar.items.find((it) => it.id !== 'ser'),
    };
  }
  const itemValues = (item, name) => item.recurrenceInfo.getRecurrenceItems().filter((r) => r.icalProperty.propertyName === name).map((r) => r.icalProperty.value);

  // The last occurrence before the split, among `keys`.
  const lastBefore = (keys, at) => keys.filter((k) => !k.startsWith('changed ') && k < instantKey(at)).at(-1);

  for (const [kind, makeStart] of Object.entries(SPLIT_START_KINDS)) {
    it(`a series ${kind}: the two parts together make the series' occurrences, its changed occurrences included`, async () => {
      const probe = makeStart();
      const weekly = `FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=${untilAfter(probe, 60)}`;
      for (const rule of ['FREQ=DAILY', 'FREQ=DAILY;COUNT=30', weekly]) {
        const seriesStarting = (start) => {
          const timedShift = start.isDate ? 0 : 2;
          return seriesFrom(start, [rule], {
            extraItems: [
              recurrenceDate('EXDATE', after(start, 3)), recurrenceDate('EXDATE', after(start, 20)),
              recurrenceDate('RDATE', after(start, 5, timedShift)), recurrenceDate('RDATE', after(start, 22, timedShift)),
            ],
            exceptions: [changedAt(start, 7), changedAt(start, 18)],
          });
        };
        const start = makeStart();
        const master = seriesStarting(start);
        const before = occurrenceKeys(master);
        // The occurrences the series' dates name: the same series with plain
        // dates. They are the series' own, but for a zoned all-day series west
        // of UTC, which Thunderbird ends a day before the date its UNTIL names.
        const named = occurrenceKeys(seriesStarting(plain(start)));
        expect(named.filter((k) => !before.includes(k)), rule).toEqual(kind in WEST_ALL_DAY_KINDS && /UNTIL=/.test(rule) ? [untilAfter(start, 60)] : []);
        expect(before.filter((k) => !named.includes(k)), rule).toEqual([]);
        expect(before.length, rule).toBeGreaterThan(20);
        expect(before.filter((k) => k.startsWith('changed ')), rule).toHaveLength(2);
        const ruleDates = master.recurrenceInfo.getRecurrenceItems()[0].getOccurrences(start, start, RANGE[1], 0);
        const at = ruleDates[12];
        const { res, capped, fresh } = await split(master, startIsoOf(at));
        expect(res, `${rule}: ${res.error}`).toMatchObject({ ok: true });
        expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort(), rule).toEqual(named);
        expect(lastBefore(occurrenceKeys(capped), at), rule).toBe(lastBefore(named, at));
        expect(fresh.startDate.toString(), rule).toBe(at.toString());
        expect(fresh.startDate.timezone, rule).toBe(start.isDate ? FLOATING_ZONE : start.timezone);
        // Each excluded and added date, and each changed occurrence, keeps its
        // date and its occurrence, in one part or the other.
        for (const name of ['EXDATE', 'RDATE']) {
          expect([...itemValues(capped, name), ...itemValues(fresh, name)].sort(), `${rule} ${name}`).toEqual(itemValues(master, name).sort());
        }
        expect([...changedPairs(capped), ...changedPairs(fresh)].sort(), rule).toEqual(changedPairs(master).sort());
        if (start.isDate) {
          expectPlainDates(capped, `${rule}: the part before`);
          expectPlainDates(fresh, `${rule}: the part from the split on`);
        }
        // The earlier part's end is written in its start's value type (RFC 5545
        // 3.3.10). A floating start's is still a UTC value, filed as #270.
        if (kind !== 'floating') {
          const shape = start.isDate ? /^\d{8}$/ : /^\d{8}T\d{6}Z$/;
          for (const value of ruleValues(capped).filter((v) => /UNTIL=/.test(v))) expect(untilOf(value), `${rule}: ${value}`).toMatch(shape);
        }
        for (const part of [capped, fresh]) {
          for (const rid of part.recurrenceInfo.getExceptionIds()) {
            const ex = part.recurrenceInfo.getExceptionFor(rid);
            expect(ex.parentItem, rule).toBe(part);
            expect(ex.id, rule).toBe(part.id);
          }
        }
      }
    });
  }

  // West of UTC, the day before the split is the one Thunderbird would drop
  // from a part capped with a bare-date UNTIL while its start kept the zone.
  for (const [kind, makeStart] of Object.entries(WEST_ALL_DAY_KINDS)) {
    for (const rule of ['FREQ=DAILY', 'FREQ=DAILY;COUNT=30']) {
      it(`a series ${kind} (${rule}): the part before the split keeps the day before it, written as plain dates`, async () => {
        const start = makeStart();
        const master = seriesFrom(start, [rule], { exceptions: [changedAt(start, 7)] });
        const before = occurrenceKeys(master);
        const at = after(start, 12);
        const { res, capped, fresh, modifications } = await split(master, startIsoOf(at));
        expect(res, res.error).toMatchObject({ ok: true });
        expect(modifications).toHaveLength(1);
        expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before);
        expect(lastBefore(occurrenceKeys(capped), at)).toBe(after(start, 11).toString());
        expect(ruleValues(capped)).toEqual([`FREQ=DAILY;UNTIL=${after(start, 11).toString()}`]);
        expectPlainDates(capped, 'the part before');
        expectPlainDates(fresh, 'the part from the split on');
      });
    }
  }

  it('a series bounded by COUNT: the following part has the occurrences still to come', async () => {
    const { res, capped, fresh } = await split(series('FREQ=DAILY;COUNT=20'), '2099-10-15T17:00:00');
    expect(res).toMatchObject({ ok: true });
    expect(ruleValues(fresh)).toEqual(['FREQ=DAILY;COUNT=6']);
    expect(ruleValues(capped)[0]).toMatch(/^FREQ=DAILY;UNTIL=/);
    expect(lastDayAdmitted(fakeDateTime(START_DAY, 17), untilOf(ruleValues(capped)[0]))).toBe('2099-10-14');
  });

  it('a rule that ended before the split stays on the earlier part, unchanged, and is not carried on', async () => {
    const ended = `FREQ=DAILY;INTERVAL=3;UNTIL=${utcUntil('2099-10-07', 17)}`;
    const master = series('FREQ=DAILY;INTERVAL=2', { extraItems: [recurrenceItem('RRULE', ended)] });
    const before = occurrenceKeys(master);
    const { res, capped, fresh } = await split(master, '2099-10-15T17:00:00');
    expect(res).toMatchObject({ ok: true });
    expect(ruleValues(capped)).toEqual([expect.stringMatching(/^FREQ=DAILY;INTERVAL=2;UNTIL=/), ended]);
    expect(ruleValues(fresh)).toEqual(['FREQ=DAILY;INTERVAL=2']);
    expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before);
  });

  it('a split at an added date after the rule ended keeps that date as the following part', async () => {
    const master = series('FREQ=DAILY;COUNT=5', { extraItems: [recurrenceItem('RDATE', '20991015T170000')] });
    const before = occurrenceKeys(master);
    const { res, capped, fresh } = await split(master, '2099-10-15T17:00:00');
    expect(res).toMatchObject({ ok: true });
    expect(ruleValues(capped)).toEqual(['FREQ=DAILY;COUNT=5']);
    expect(ruleValues(fresh)).toEqual([]);
    expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before);
  });

  // 2099-10-01 and 2099-10-15 are Thursdays; 2099-10-22 is a Thursday but not the 15th.
  it('two rules that both make an occurrence at the split are both carried on', async () => {
    const master = series('FREQ=WEEKLY;BYDAY=TH', { extraItems: [recurrenceItem('RRULE', 'FREQ=MONTHLY;BYMONTHDAY=15')] });
    const before = occurrenceKeys(master);
    const { res, capped, fresh } = await split(master, '2099-10-15T17:00:00');
    expect(res).toMatchObject({ ok: true });
    expect(ruleValues(fresh)).toEqual(['FREQ=WEEKLY;BYDAY=TH', 'FREQ=MONTHLY;BYMONTHDAY=15']);
    expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before);
  });

  it('the excluded and added dates and changed occurrences from the split on go to the following part', async () => {
    const moved = fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime('2099-10-18', 19), endDate: fakeDateTime('2099-10-18', 20), recurrenceId: fakeDateTime('2099-10-18', 17) });
    const early = fakeEvent({ id: 'ser', title: 'Early', startDate: fakeDateTime('2099-10-08', 19), endDate: fakeDateTime('2099-10-08', 20), recurrenceId: fakeDateTime('2099-10-08', 17) });
    const master = series('FREQ=DAILY', {
      extraItems: [recurrenceItem('EXDATE', '20991005T170000'), recurrenceItem('EXDATE', '20991020T170000'), recurrenceItem('RDATE', '20991022T190000')],
      exceptions: [early, moved],
    });
    const { res, capped, fresh } = await split(master, '2099-10-15T17:00:00');
    expect(res).toMatchObject({ ok: true });
    expect(itemValues(fresh, 'EXDATE')).toEqual(['20991020T170000']);
    expect(itemValues(fresh, 'RDATE')).toEqual(['20991022T190000']);
    expect(itemValues(capped, 'EXDATE')).toEqual(['20991005T170000']);
    expect(itemValues(capped, 'RDATE')).toEqual([]);
    expect(fresh.recurrenceInfo.getExceptionIds().map(String)).toEqual(['20991018T170000']);
    expect(capped.recurrenceInfo.getExceptionIds().map(String)).toEqual(['20991008T170000']);
    const kept = fresh.recurrenceInfo.getExceptionFor(fakeDateTime('2099-10-18', 17));
    expect(kept).toMatchObject({ title: 'Moved', id: fresh.id });
    expect(kept.parentItem).toBe(fresh);
  });

  it('a new time for the following part moves its dates with it, as an edit of a whole series does', async () => {
    const moved = fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime('2099-10-18', 19), endDate: fakeDateTime('2099-10-18', 20), recurrenceId: fakeDateTime('2099-10-18', 17) });
    const master = series(`FREQ=DAILY;UNTIL=${utcUntil('2099-10-30', 17)}`, { extraItems: [recurrenceItem('EXDATE', '20991020T170000')], exceptions: [moved] });
    const following = occurrenceKeys(master).filter((k) => k.startsWith('changed') || k >= instantKey(fakeDateTime('2099-10-15', 17)));
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: '2099-10-15T17:00:00', start_iso: '2099-10-15T18:00:00' });
    expect(res).toMatchObject({ ok: true });
    const fresh = calendar.items.find((it) => it.id !== 'ser');
    expect(fresh.startDate.toString()).toBe('20991015T180000');
    expect(fresh.endDate.toString()).toBe('20991015T190000');
    expect(itemValues(fresh, 'EXDATE')).toEqual(['20991020T180000']);
    expect(fresh.recurrenceInfo.getExceptionIds().map(String)).toEqual(['20991018T180000']);
    const hourLater = (k) => (k.startsWith('changed') ? k : new Date(Date.parse(k) + 3600 * 1000).toISOString());
    expect(following.length).toBeGreaterThan(10);
    expect(occurrenceKeys(fresh)).toEqual(following.map(hourLater).sort());
    expect(lastDayAdmitted(fresh.startDate, untilOf(ruleValues(fresh)[0]))).toBe('2099-10-30');
  });

  // A new time is read in the user's zone and written in the series' frame (its
  // own zone at the same instant; floating at the user's clock digits), so the
  // part, or the whole series, keeps its weekdays, and its excluded and added
  // dates and changed occurrences move with it and still meet its occurrences.
  // At 09:00, a start east of UTC is the day before in the user's zone.
  const TIMED_KINDS = {
    "timed in the user's zone": () => fakeDateTime(START_DAY, 9),
    'timed in another zone, east of UTC': () => fakeDateTime(START_DAY, 9, 0, EAST),
    'timed in UTC': () => fakeDateTime(START_DAY, 9, 0, UTC_ZONE),
    'floating': () => fakeDateTime(START_DAY, 9, 0, FLOATING_ZONE),
  };
  const anHourLater = (k) => (k.startsWith('changed') ? k : new Date(Date.parse(k) + 3600 * 1000).toISOString());
  function timedSeries(makeStart) {
    const start = makeStart();
    return seriesFrom(start, [`FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=${untilAfter(start, 60)}`], {
      extraItems: [
        recurrenceDate('EXDATE', after(start, 4)), recurrenceDate('EXDATE', after(start, 20)),
        recurrenceDate('RDATE', after(start, 5, 2)), recurrenceDate('RDATE', after(start, 22, 2)),
      ],
      exceptions: [changedAt(start, 6), changedAt(start, 18)],
    });
  }
  // The edit's `timezone` says how to read its new times: the same instant,
  // given as its digits in EAST. A floating time stands for the user's clock.
  const digitsOf = (d) => `${d.year}-${pad2(d.month + 1)}-${pad2(d.day)}T${pad2(d.hour)}:${pad2(d.minute)}:${pad2(d.second)}`;
  const inEastDigits = (dt) => digitsOf((dt.timezone === FLOATING_ZONE ? fakeCalDateTime({ ...dt, timezone: LOCAL_ZONE }) : dt).getInTimezone(EAST));
  const loadKnowingEast = (master) => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [master] });
    const { cal } = loaded.ctx.ChromeUtils.importESModule(CAL_UTILS);
    cal.timezoneService.getTimezone = (tzid) => (tzid === EAST.tzid ? EAST : null);
    return loaded;
  };
  for (const [kind, makeStart] of Object.entries(TIMED_KINDS)) {
    // A new time alone keeps the event's length: a new start moves the end, and
    // a new end moves the start, so either way the occurrences move with it.
    for (const [change, newTime, field, newValue, moved] of [
      ['a new start', (at) => ({ start_iso: startIsoOf(after(at, 0, 1)) }), 'startDate', (at) => after(at, 0, 1), anHourLater],
      ['a new end', (at) => ({ end_iso: startIsoOf(after(at, 0, 2)) }), 'endDate', (at) => after(at, 0, 2), anHourLater],
      ['a new start given in another zone', (at) => ({ start_iso: inEastDigits(after(at, 0, 1)), timezone: EAST.tzid }), 'startDate', (at) => after(at, 0, 1), anHourLater],
    ]) {
      it(`a series ${kind}: ${change} an hour later for this and the following occurrences keeps the series' frame and dates`, async () => {
        const start = makeStart();
        const ruleDates = timedSeries(makeStart).recurrenceInfo.getRecurrenceItems()[0].getOccurrences(start, start, RANGE[1], 0);
        const at = ruleDates[6];
        const plain = await split(timedSeries(makeStart), startIsoOf(at), {});
        expect(plain.res, plain.res.error).toMatchObject({ ok: true });
        const following = occurrenceKeys(plain.fresh);
        expect(following.filter((k) => k.startsWith('changed '))).toHaveLength(1);
        const { api, calendar } = loadKnowingEast(timedSeries(makeStart));
        const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(at), ...newTime(at) });
        expect(res, res.error).toMatchObject({ ok: true });
        const capped = calendar.items.find((it) => it.id === 'ser');
        const fresh = calendar.items.find((it) => it.id !== 'ser');
        expect(fresh[field].timezone).toBe(start.timezone);
        expect(fresh[field].toString()).toBe(newValue(at).toString());
        expect(occurrenceKeys(capped)).toEqual(occurrenceKeys(plain.capped));
        expect(occurrenceKeys(fresh)).toEqual(following.map(moved).sort());
      });

      it(`a series ${kind}: ${change} an hour later for the whole series keeps the series' frame and dates`, async () => {
        const start = makeStart();
        const master = timedSeries(makeStart);
        const before = occurrenceKeys(master);
        expect(before.filter((k) => k.startsWith('changed '))).toHaveLength(2);
        const { api, calendar } = loadKnowingEast(master);
        const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', ...newTime(start) });
        expect(res, res.error).toMatchObject({ ok: true });
        const saved = calendar.items[0];
        expect(saved[field].timezone).toBe(start.timezone);
        expect(saved[field].toString()).toBe(newValue(start).toString());
        expect(occurrenceKeys(saved)).toEqual(before.map(moved).sort());
      });
    }
  }

  // A change to all-day uses the given date as read: put in the series' zone,
  // west of the user's, its midnight would fall on the day before.
  it('a timed series in a zone west of the user\'s, changed to all-day, starts on the given day', async () => {
    const start = fakeDateTime(START_DAY, 9, 0, WEST);
    const whole = loadCalendarBridge(bridgeUrl, { items: [seriesFrom(start, ['FREQ=DAILY'])] });
    const res = await whole.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', start_iso: `${START_DAY}T00:00:00`, end_iso: '2099-10-02T00:00:00', all_day: true });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(whole.calendar.items[0].startDate.isDate).toBe(true);
    expect(whole.calendar.items[0].startDate.toString()).toBe('20991001');
    const following = loadCalendarBridge(bridgeUrl, { items: [seriesFrom(start, ['FREQ=DAILY'])] });
    const res2 = await following.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: startIsoOf(after(start, 14)), start_iso: '2099-10-15T00:00:00', end_iso: '2099-10-16T00:00:00', all_day: true });
    expect(res2, res2.error).toMatchObject({ ok: true });
    const fresh = following.calendar.items.find((it) => it.id !== 'ser');
    expect(fresh.startDate.isDate).toBe(true);
    expect(fresh.startDate.toString()).toBe('20991015');
  });

  // Thunderbird prints a UTC RECURRENCE-ID with a trailing Z (ical.js Time.toString).
  it('a recurrence_id with Z names that instant, and the following part keeps the series\' zone', async () => {
    const utcSeries = seriesFrom(fakeDateTime(START_DAY, 17, 0, UTC_ZONE), ['FREQ=DAILY']);
    const inUtc = await split(utcSeries, '2099-10-15T17:00:00Z');
    expect(inUtc.res).toMatchObject({ ok: true });
    expect(inUtc.fresh.startDate.toString()).toBe('20991015T170000Z');
    const local = series('FREQ=DAILY');
    const before = occurrenceKeys(local);
    const instant = new Date(2099, 9, 15, 17).toISOString().replace('.000', '');
    const inLocal = await split(local, instant);
    expect(inLocal.res).toMatchObject({ ok: true });
    expect(inLocal.fresh.startDate.toString()).toBe('20991015T170000');
    expect(inLocal.fresh.startDate.timezone).toBe(local.startDate.timezone);
    expect([...occurrenceKeys(inLocal.capped), ...occurrenceKeys(inLocal.fresh)].sort()).toEqual(before);
  });

  it('a new rule for the following part replaces a COUNT rule with no occurrence before the split', async () => {
    // 2099-10-01 is a Thursday: the rule's first occurrence is Monday 10-05.
    const master = series('FREQ=WEEKLY;BYDAY=MO;COUNT=3', { extraItems: [recurrenceItem('RDATE', '20991003T170000')] });
    const { res, fresh } = await split(master, '2099-10-03T17:00:00', { recurrence: { freq: 'WEEKLY', byDay: ['SA'] } });
    expect(res).toMatchObject({ ok: true });
    expect(ruleValues(fresh)).toEqual(['FREQ=WEEKLY;BYDAY=SA']);
  });

  it('excluded dates in the edit go to the part they fall in, one at the split to the following part', async () => {
    const { res, capped, fresh } = await split(series('FREQ=DAILY'), '2099-10-15T17:00:00', { exdates_add: ['2099-10-10T17:00:00', '2099-10-15T17:00:00', '2099-10-20T17:00:00'] });
    expect(res).toMatchObject({ ok: true });
    expect(itemValues(capped, 'EXDATE')).toEqual(['20991010T170000']);
    expect(itemValues(fresh, 'EXDATE')).toEqual(['20991015T170000', '20991020T170000']);
  });

  // An excluded date names an occurrence as the read tools show it, by its
  // start; Thunderbird removes an occurrence by its RECURRENCE-ID, which for a
  // changed occurrence is its slot, not its start.
  it('an excluded date that names a changed occurrence by its start removes it from the part it is in', async () => {
    const start = fakeDateTime(START_DAY, 17);
    const master = seriesFrom(start, ['FREQ=DAILY'], { exceptions: [changedAt(start, 6), changedAt(start, 17)] });
    const before = occurrenceKeys(master);
    const early = `changed ${instantKey(fakeDateTime('2099-10-07', 19))} Moved`;
    const late = `changed ${instantKey(fakeDateTime('2099-10-18', 19))} Moved`;
    expect(before).toEqual(expect.arrayContaining([early, late]));
    const { res, capped, fresh } = await split(master, '2099-10-15T17:00:00', { exdates_add: ['2099-10-07T19:00:00', '2099-10-18T19:00:00'] });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(itemValues(capped, 'EXDATE')).toEqual(['20991007T170000']);
    expect(itemValues(fresh, 'EXDATE')).toEqual(['20991018T170000']);
    expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before.filter((k) => k !== early && k !== late));
  });

  it('an excluded date names an occurrence of the series before the edit, so a new time for the following part moves it with the part', async () => {
    const master = series('FREQ=DAILY');
    const { res, fresh } = await split(master, '2099-10-15T17:00:00', { start_iso: '2099-10-15T18:00:00', exdates_add: ['2099-10-20T17:00:00'] });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(itemValues(fresh, 'EXDATE')).toEqual(['20991020T180000']);
    const days = occurrenceKeys(fresh).map((k) => k.slice(0, 10));
    expect(days).not.toContain(new Date(2099, 9, 20, 18).toISOString().slice(0, 10));
    expect(days).toContain(new Date(2099, 9, 21, 18).toISOString().slice(0, 10));
  });

  // A changed occurrence is named by its own start, as the read tools show it,
  // and the series divides at its slot (its RECURRENCE-ID), where it belongs.
  it('a split at a changed occurrence names it by its start and divides the series at its slot', async () => {
    const start = fakeDateTime(START_DAY, 17);
    const master = seriesFrom(start, ['FREQ=DAILY'], { exceptions: [changedAt(start, 14)] });
    const before = occurrenceKeys(master);
    const { res, capped, fresh } = await split(master, '2099-10-15T19:00:00', {});
    expect(res, res.error).toMatchObject({ ok: true });
    expect(fresh.startDate.toString()).toBe('20991015T170000');
    expect(fresh.recurrenceInfo.getExceptionIds().map(String)).toEqual(['20991015T170000']);
    expect(capped.recurrenceInfo.getExceptionIds()).toEqual([]);
    expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before);
  });

  // The last occurrence: the following part is that occurrence alone. (West of
  // UTC, an all-day series bounded by a DATE UNTIL has no occurrence on that
  // day in Thunderbird, as above.)
  for (const [kind, makeStart, until, recurrenceId] of [
    ['timed', () => fakeDateTime(START_DAY, 17), utcUntil('2099-10-20', 17), '2099-10-20T17:00:00'],
    ['all-day, made in a zone east of UTC', () => fakeDate(START_DAY, EAST), '20991020', '2099-10-20T00:00:00'],
  ]) {
    it(`a split at the last occurrence of a series bounded by UNTIL (${kind}) keeps that occurrence, once`, async () => {
      const master = seriesFrom(makeStart(), [`FREQ=DAILY;UNTIL=${until}`]);
      const before = occurrenceKeys(master);
      const { res, capped, fresh } = await split(master, recurrenceId);
      expect(res, res.error).toMatchObject({ ok: true });
      expect(occurrenceKeys(fresh)).toHaveLength(1);
      expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before);
    });
  }

  // The same splits of an all-day series stored with a zone, east and west of
  // UTC. Both parts are written as plain dates, so together they make the
  // occurrences the series' dates name (the same series with plain dates): its
  // own, and west of UTC the day each bare-date UNTIL names, which Thunderbird
  // drops from the zoned series. 2099-10-01 and 2099-10-15 are Thursdays.
  for (const [kind, makeStart] of Object.entries(ZONED_ALL_DAY_KINDS)) {
    const changedWithRid = (start, rid) => fakeEvent({ id: 'ser', title: 'Moved', startDate: after(plain(rid), 1), endDate: after(plain(rid), 2), recurrenceId: rid });
    for (const [name, seriesStarting, recurrenceId, patch, excluded] of [
      ['two rules that both make an occurrence at the split', (s) => seriesFrom(s, ['FREQ=WEEKLY;BYDAY=TH', 'FREQ=MONTHLY;BYMONTHDAY=15']), '2099-10-15T00:00:00', {}, []],
      ['a rule that ended before the split, on a day only it makes', (s) => seriesFrom(s, ['FREQ=DAILY;INTERVAL=2', 'FREQ=DAILY;INTERVAL=3;UNTIL=20991010']), '2099-10-15T00:00:00', {}, []],
      ['excluded dates in the edit, one at the split', (s) => seriesFrom(s, ['FREQ=DAILY']), '2099-10-15T00:00:00', { exdates_add: ['2099-10-10T00:00:00', '2099-10-15T00:00:00', '2099-10-20T00:00:00'] }, ['20991010', '20991015', '20991020']],
      ['a changed occurrence whose RECURRENCE-ID is stored in UTC, on each side', (s) => seriesFrom(s, ['FREQ=DAILY'], { exceptions: [changedWithRid(s, fakeDate('2099-10-08', UTC_ZONE)), changedWithRid(s, fakeDate('2099-10-18', UTC_ZONE))] }), '2099-10-15T00:00:00', {}, []],
      ['a split at the last day Thunderbird shows of a rule bounded by UNTIL', (s) => seriesFrom(s, ['FREQ=DAILY;UNTIL=20991020']), '2099-10-19T00:00:00', {}, []],
    ]) {
      it(`a series ${kind}, ${name}: the two parts make the occurrences its dates name, as plain dates`, async () => {
        const start = makeStart();
        const master = seriesStarting(start);
        const named = occurrenceKeys(seriesStarting(plain(start))).filter((k) => !excluded.includes(k));
        const { res, capped, fresh } = await split(master, recurrenceId, patch);
        expect(res, res.error).toMatchObject({ ok: true });
        expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(named);
        const at = fakeDate(recurrenceId.slice(0, 10));
        expect(lastBefore(occurrenceKeys(capped), at)).toBe(lastBefore(named, at));
        expect([...changedPairs(capped), ...changedPairs(fresh)].sort()).toEqual(changedPairs(master).sort());
        expect([...itemValues(capped, 'EXDATE'), ...itemValues(fresh, 'EXDATE')].sort()).toEqual(excluded);
        expectPlainDates(capped, 'the part before');
        expectPlainDates(fresh, 'the part from the split on');
        for (const value of ruleValues(capped).filter((v) => /UNTIL=/.test(v))) expect(untilOf(value), value).toMatch(/^\d{8}$/);
      });
    }
  }

  it('when the following part cannot be added, the earlier part is put back as it was', async () => {
    const master = series('FREQ=DAILY');
    const rules = ruleValues(master);
    const loaded = loadCalendarBridge(bridgeUrl, { items: [master] });
    loaded.calendar.addItem = async () => { throw new Error('the calendar is read-only'); };
    const res = await loaded.api.splitRecurringEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence_id: '2099-10-15T17:00:00', patch: { title: 'Renamed' } });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/failed to create new series/);
    expect(loaded.calendar.items).toHaveLength(1);
    expect(loaded.calendar.items[0]).toBe(master);
    expect(ruleValues(loaded.calendar.items[0])).toEqual(rules);
  });

  it('a this-and-following edit gives the following part its new end, and its all-day change', async () => {
    const timed = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY')] });
    const res = await timed.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: '2099-10-15T17:00:00', start_iso: '2099-10-15T17:00:00', end_iso: '2099-10-15T19:30:00' });
    expect(res, res.error).toMatchObject({ ok: true });
    const fresh = timed.calendar.items.find((it) => it.id !== 'ser');
    expect(fresh.startDate.toString()).toBe('20991015T170000');
    expect(fresh.endDate.toString()).toBe('20991015T193000');
    const allDay = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY')] });
    const res2 = await allDay.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: '2099-10-15T17:00:00', start_iso: '2099-10-15T00:00:00', end_iso: '2099-10-16T00:00:00', all_day: true });
    expect(res2, res2.error).toMatchObject({ ok: true });
    const fresh2 = allDay.calendar.items.find((it) => it.id !== 'ser');
    expect(fresh2.startDate.isDate).toBe(true);
    expect(fresh2.startDate.toString()).toBe('20991015');
  });

  it('a new rule for the following part does not let a time that is not an occurrence through', async () => {
    const master = series('FREQ=DAILY');
    const rules = ruleValues(master);
    const { res, calendar, modifications } = await split(master, '2099-10-15T18:00:00', { recurrence: { freq: 'WEEKLY', byDay: ['SA'] } });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/not the start of an occurrence of this series/);
    expect(modifications).toEqual([]);
    expect(calendar.items).toEqual([master]);
    expect(ruleValues(master)).toEqual(rules);
  });

  it('excluded dates given with a this-and-following edit go to the part they fall in', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY')] });
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: '2099-10-15T17:00:00',
      exdates_add: ['2099-10-10T17:00:00', '2099-10-15T17:00:00', '2099-10-20T17:00:00'],
    });
    expect(res, res.error).toMatchObject({ ok: true });
    const capped = calendar.items.find((it) => it.id === 'ser');
    const fresh = calendar.items.find((it) => it.id !== 'ser');
    expect(itemValues(capped, 'EXDATE')).toEqual(['20991010T170000']);
    expect(itemValues(fresh, 'EXDATE')).toEqual(['20991015T170000', '20991020T170000']);
  });

  // A RECURRENCE-ID can be stored in another zone than the series' start (some
  // servers write UTC). 20:00 in Vancouver is the next day in UTC and in a zone
  // east of UTC, so a following part started in that zone would repeat on other
  // weekdays.
  for (const [zoneName, zone] of [['UTC', UTC_ZONE], ['a zone east of UTC', EAST]]) {
    it(`a split at a changed occurrence whose RECURRENCE-ID is stored in ${zoneName} keeps the series' zone and weekdays`, async () => {
      const start = fakeDateTime(START_DAY, 20);
      const rid = fakeDateTime('2099-10-15', 20).getInTimezone(zone);
      expect(rid.day).toBe(16);
      const moved = fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime('2099-10-15', 21), endDate: fakeDateTime('2099-10-15', 22), recurrenceId: rid });
      const master = seriesFrom(start, ['FREQ=WEEKLY;BYDAY=TH'], { exceptions: [moved] });
      const before = occurrenceKeys(master);
      expect(before.filter((k) => k.startsWith('changed '))).toHaveLength(1);
      const { res, capped, fresh } = await split(master, '2099-10-15T21:00:00', {});
      expect(res, res.error).toMatchObject({ ok: true });
      expect(fresh.startDate.timezone).toBe(start.timezone);
      expect(fresh.startDate.toString()).toBe('20991015T200000');
      expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before);
    });
  }

  // RFC 5545 needs EXDATE, RDATE, UNTIL and RECURRENCE-ID in DTSTART's value
  // type, and moving the start between all-day and timed keeps theirs.
  const toAllDay = { recurrence_id: '2099-10-15T17:00:00', start_iso: '2099-10-15T00:00:00', end_iso: '2099-10-16T00:00:00', all_day: true };
  const toTimed = { recurrence_id: '2099-10-15T00:00:00', start_iso: '2099-10-15T09:00:00', end_iso: '2099-10-15T10:00:00', all_day: false };
  for (const [name, make, change] of [
    ['to all-day, carrying an excluded date', () => series('FREQ=DAILY', { extraItems: [recurrenceItem('EXDATE', '20991020T170000')] }), toAllDay],
    ['to all-day, carrying an added date', () => series('FREQ=DAILY', { extraItems: [recurrenceItem('RDATE', '20991020T190000')] }), toAllDay],
    ['to all-day, carrying a changed occurrence', () => series('FREQ=DAILY', { exceptions: [fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime('2099-10-20', 19), endDate: fakeDateTime('2099-10-20', 20), recurrenceId: fakeDateTime('2099-10-20', 17) })] }), toAllDay],
    ['to all-day, carrying an end date', () => series(`FREQ=DAILY;UNTIL=${utcUntil('2099-10-30', 17)}`), toAllDay],
    ['to timed, carrying an excluded date', () => series('FREQ=DAILY', { allDay: true, extraItems: [recurrenceItem('EXDATE', '20991020')] }), toTimed],
  ]) {
    it(`a this-and-following change ${name} is refused and writes nothing`, async () => {
      const master = make();
      const rules = ruleValues(master);
      const { api, calendar, modifications } = loadCalendarBridge(bridgeUrl, { items: [master] });
      const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', ...change });
      expect(res).toMatchObject({ ok: false });
      expect(res.error).toMatch(/between all-day and timed/);
      expect(modifications).toEqual([]);
      expect(calendar.items).toEqual([master]);
      expect(ruleValues(master)).toEqual(rules);
    });
  }

  it('a this-and-following change to all-day with a new rule writes that rule as a date, so an end date is no bar', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series(`FREQ=DAILY;UNTIL=${utcUntil('2099-10-30', 17)}`)] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', ...toAllDay, recurrence: { freq: 'DAILY', until: '2099-10-30' } });
    expect(res, res.error).toMatchObject({ ok: true });
    const fresh = calendar.items.find((it) => it.id !== 'ser');
    expect(fresh.startDate.isDate).toBe(true);
    expect(ruleValues(fresh)).toEqual(['FREQ=DAILY;UNTIL=20991030']);
  });

  // `recurrence: {}` ends the series at the split, leaving one event built from
  // the series there.
  it('ending the series at an occurrence that was changed on its own is refused, so its changes are kept', async () => {
    const start = fakeDateTime(START_DAY, 17);
    const master = seriesFrom(start, ['FREQ=DAILY'], { exceptions: [changedAt(start, 14)] });
    const rules = ruleValues(master);
    const { res, calendar, modifications } = await split(master, '2099-10-15T19:00:00', { recurrence: {} });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/changed on its own/);
    expect(modifications).toEqual([]);
    expect(calendar.items).toEqual([master]);
    expect(ruleValues(master)).toEqual(rules);
  });

  // A changed occurrence is carried into the following part with its own time
  // and details, so a change to them there would not reach it: the named
  // occurrence would stay as it was while the edit reports success. (A guest
  // change does reach it: it is made on each changed occurrence's own list.)
  for (const [name, change] of [
    ['a new start', { start_iso: '2099-10-15T18:00:00' }],
    ['its own start restated', { start_iso: '2099-10-15T19:00:00' }],
    ['a new end', { end_iso: '2099-10-15T21:00:00' }],
    ['a new title', { title: 'Renamed' }],
    ['a new location', { location: 'Room 9' }],
    ['a new description', { description: 'New agenda' }],
    ['a new busy/free', { transparency: 'free' }],
  ]) {
    it(`a this-and-following change with ${name} at an occurrence changed on its own is refused and writes nothing`, async () => {
      const start = fakeDateTime(START_DAY, 17);
      const master = seriesFrom(start, ['FREQ=DAILY'], { exceptions: [changedAt(start, 14)] });
      const rules = ruleValues(master);
      const { res, calendar, modifications } = await split(master, '2099-10-15T19:00:00', change);
      expect(res).toMatchObject({ ok: false });
      expect(res.error).toMatch(/changed on its own, so this change would not reach it/);
      expect(modifications).toEqual([]);
      expect(calendar.items).toEqual([master]);
      expect(ruleValues(master)).toEqual(rules);
    });
  }

  it('a this-and-following change of only the dates at an occurrence changed on its own keeps that occurrence as it was', async () => {
    const start = fakeDateTime(START_DAY, 17);
    const master = seriesFrom(start, ['FREQ=DAILY'], { exceptions: [changedAt(start, 14)] });
    const removed = instantKey(fakeDateTime('2099-10-20', 17));
    const before = occurrenceKeys(master);
    expect(before).toContain(removed);
    const { res, capped, fresh } = await split(master, '2099-10-15T19:00:00', { exdates_add: ['2099-10-20T17:00:00'], all_day: false });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(occurrenceKeys(fresh)).toContain(`changed ${instantKey(fakeDateTime('2099-10-15', 19))} Moved`);
    expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before.filter((k) => k !== removed));
  });

  // The edit tool fills in the organizer from the calendar for every edit that
  // names one, so the organizer is no change of the occurrence's.
  it('a this-and-following edit at an occurrence changed on its own that only excludes dates is made, with the organizer the edit tool fills in', async () => {
    const start = fakeDateTime(START_DAY, 17);
    const master = seriesFrom(start, ['FREQ=DAILY'], { exceptions: [changedAt(start, 14)] });
    const removed = instantKey(fakeDateTime('2099-10-20', 17));
    const before = occurrenceKeys(master);
    expect(before).toContain(removed);
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: '2099-10-15T19:00:00',
      organizer_email: 'organizer@example.com', exdates_add: ['2099-10-20T17:00:00'],
    });
    expect(res, res.error).toMatchObject({ ok: true });
    const capped = calendar.items.find((it) => it.id === 'ser');
    const fresh = calendar.items.find((it) => it.id !== 'ser');
    expect(occurrenceKeys(fresh)).toContain(`changed ${instantKey(fakeDateTime('2099-10-15', 19))} Moved`);
    expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before.filter((k) => k !== removed));
  });

  it('ending the series at an ordinary occurrence leaves that occurrence as one event', async () => {
    const { res, capped, fresh } = await split(series('FREQ=DAILY'), '2099-10-15T17:00:00', { recurrence: {} });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(fresh.recurrenceInfo).toBeNull();
    expect(fresh.startDate.toString()).toBe('20991015T170000');
    expect(ruleValues(capped)[0]).toMatch(/^FREQ=DAILY;UNTIL=/);
  });

  const exrule = { icalProperty: { propertyName: 'EXRULE', value: 'FREQ=WEEKLY;BYDAY=SA' } };
  for (const [name, make, recurrenceId, error] of [
    ['a time that is not an occurrence', () => series('FREQ=DAILY'), '2099-10-15T18:00:00', /not the start of an occurrence of this series/],
    ['an occurrence\'s time in the series\' zone rather than the user\'s', () => series('FREQ=DAILY', { startDate: fakeDateTime(START_DAY, 17, 0, EAST) }), '2099-10-15T17:00:00', /not the start of an occurrence of this series/],
    ['the slot of a changed occurrence, where nothing starts now', () => series('FREQ=DAILY', { exceptions: [fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime('2099-10-15', 19), endDate: fakeDateTime('2099-10-15', 20), recurrenceId: fakeDateTime('2099-10-15', 17) })] }), '2099-10-15T17:00:00', /not the start of an occurrence of this series/],
    ['a time two occurrences start at', () => series('FREQ=DAILY', { exceptions: [fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime('2099-10-15', 17), endDate: fakeDateTime('2099-10-15', 18), recurrenceId: fakeDateTime('2099-10-14', 17) })] }), '2099-10-15T17:00:00', /more than one occurrence/],
    ['an occurrence of one rule but not of the other', () => series('FREQ=WEEKLY;BYDAY=TH', { extraItems: [recurrenceItem('RRULE', 'FREQ=MONTHLY;BYMONTHDAY=15')] }), '2099-10-22T17:00:00', /not an occurrence of this series' rule FREQ=MONTHLY;BYMONTHDAY=15/],
    ['the first occurrence', () => series('FREQ=DAILY'), '2099-10-01T17:00:00', /edit the whole series/],
    ['a time before the series', () => series('FREQ=DAILY'), '2099-09-20T17:00:00', /not the start of an occurrence of this series/],
    ['a series that cancels occurrences by a rule', () => series('FREQ=DAILY', { extraItems: [exrule] }), '2099-10-15T17:00:00', /EXRULE/],
    // ical.js reads the leading digits of a count; the split reads only digits.
    ['a series whose count cannot be read', () => series('FREQ=DAILY;COUNT=30x'), '2099-10-15T17:00:00', /count cannot be read \(COUNT=30x\)/],
    ['a series whose end cannot be read', () => series('FREQ=DAILY;UNTIL=2099x'), '2099-10-15T17:00:00', /end cannot be read \(UNTIL=2099x\)/],
    ['a series repeated only by added dates', () => {
      const ev = fakeEvent({ id: 'ser', title: 'Sync', startDate: fakeDateTime(START_DAY, 17), endDate: fakeDateTime(START_DAY, 18) });
      ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RDATE', '20991015T170000'), recurrenceItem('RDATE', '20991020T170000')]);
      ev.recurrenceInfo.item = ev;
      return ev;
    }, '2099-10-15T17:00:00', /no parseable RRULE/],
  ]) {
    it(`a split at ${name} is refused and writes nothing`, async () => {
      const master = make();
      const rules = ruleValues(master);
      const { res, calendar, modifications } = await split(master, recurrenceId);
      expect(res).toMatchObject({ ok: false });
      expect(res.error).toMatch(error);
      expect(modifications).toEqual([]);
      expect(calendar.items).toEqual([master]);
      expect(ruleValues(master)).toEqual(rules);
    });
  }
});

// An edit of one occurrence names it the way the read tools show it: by its
// start, in the user's zone. A time no occurrence starts at is refused and
// writes nothing: Thunderbird's getOccurrenceFor would make one up for any time,
// and saving it adds an occurrence the series never had.
describe('an edit of one occurrence names it by its start, and refuses a time that is not one', () => {
  for (const withCalendarHint of [true, false]) {
    const hint = withCalendarHint ? { calendar_id: 'cal1' } : {};
    const label = withCalendarHint ? 'with the calendar' : 'searching every calendar';
    it(`a time no occurrence starts at is refused and writes nothing (${label})`, async () => {
      const master = series('FREQ=DAILY');
      const { api, modifications } = loadCalendarBridge(bridgeUrl, { items: [master] });
      const res = await api.modifyCalendarEvent({ event_id: 'ser', ...hint, edit_scope: 'this_only', recurrence_id: '2099-10-15T18:00:00', title: 'Renamed' });
      expect(res).toMatchObject({ ok: false });
      expect(res.error).toMatch(/not the start of an occurrence of this series/);
      expect(modifications).toEqual([]);
      expect(master.recurrenceInfo.getExceptionIds()).toEqual([]);
    });

    // 17:00 in a zone nine hours east of UTC is 01:00 the same day in Vancouver
    // (UTC-7 in October).
    it(`an occurrence's start in the user's zone edits that occurrence alone (${label})`, async () => {
      const master = series('FREQ=DAILY', { startDate: fakeDateTime(START_DAY, 17, 0, EAST) });
      const { api, calendar, modifications } = loadCalendarBridge(bridgeUrl, { items: [master] });
      const res = await api.modifyCalendarEvent({ event_id: 'ser', ...hint, edit_scope: 'this_only', recurrence_id: '2099-10-15T01:00:00', title: 'Renamed' });
      expect(res, res.error).toMatchObject({ ok: true });
      expect(modifications).toHaveLength(1);
      const saved = calendar.items[0];
      expect(saved.title).toBe('Sync');
      expect(saved.recurrenceInfo.getExceptionIds().map(String)).toEqual(['20991015T170000']);
      const [rid] = saved.recurrenceInfo.getExceptionIds();
      expect(saved.recurrenceInfo.getExceptionFor(rid).title).toBe('Renamed');
    });

    it(`an all-day occurrence of a series made in a zone west of the user's is named by its date (${label})`, async () => {
      const master = series('FREQ=DAILY', { startDate: fakeDate(START_DAY, WEST) });
      const { api, calendar, modifications } = loadCalendarBridge(bridgeUrl, { items: [master] });
      const res = await api.modifyCalendarEvent({ event_id: 'ser', ...hint, edit_scope: 'this_only', recurrence_id: '2099-10-15T00:00:00', title: 'Renamed' });
      expect(res, res.error).toMatchObject({ ok: true });
      expect(modifications).toHaveLength(1);
      const saved = calendar.items[0];
      expect(saved.recurrenceInfo.getExceptionIds().map(String)).toEqual(['20991015']);
      const [rid] = saved.recurrenceInfo.getExceptionIds();
      expect(saved.recurrenceInfo.getExceptionFor(rid).title).toBe('Renamed');
    });

    // Two calendars hold the id. The first that holds it decides: a time its
    // series refuses is not looked for in the other calendar's copy.
    it(`a time the first calendar's series refuses is not edited in another calendar's copy (${label})`, async () => {
      const first = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY')] });
      const other = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY', { startDate: fakeDateTime(START_DAY, 18) })], calendarId: 'cal2' });
      const { cal } = first.ctx.ChromeUtils.importESModule(CAL_UTILS);
      cal.manager.getCalendars = () => [first.calendar, other.calendar];
      const res = await first.api.modifyCalendarEvent({ event_id: 'ser', ...hint, edit_scope: 'this_only', recurrence_id: '2099-10-15T18:00:00', title: 'Renamed' });
      expect(res).toMatchObject({ ok: false });
      expect(res.error).toMatch(/not the start of an occurrence of this series/);
      expect(first.modifications).toEqual([]);
      expect(other.modifications).toEqual([]);
    });
  }

  // The edit's `timezone` is for its new times. recurrence_id is the start the
  // read tools printed, in the user's zone.
  function inEastZone(master) {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [master] });
    const { cal } = loaded.ctx.ChromeUtils.importESModule(CAL_UTILS);
    cal.timezoneService.getTimezone = (tzid) => (tzid === EAST.tzid ? EAST : null);
    return loaded;
  }

  it('an edit of one occurrence given another zone still names it by its start in the user\'s zone', async () => {
    const { api, calendar } = inEastZone(series('FREQ=DAILY'));
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_only', recurrence_id: '2099-10-15T17:00:00', timezone: EAST.tzid, title: 'Renamed' });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(calendar.items[0].recurrenceInfo.getExceptionIds().map(String)).toEqual(['20991015T170000']);
  });

  it('a split given another zone still names the occurrence by its start in the user\'s zone', async () => {
    const { api, calendar } = inEastZone(series('FREQ=DAILY'));
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: '2099-10-15T17:00:00', timezone: EAST.tzid, title: 'Renamed' });
    expect(res, res.error).toMatchObject({ ok: true });
    const fresh = calendar.items.find((it) => it.id !== 'ser');
    expect(fresh.startDate.toString()).toBe('20991015T170000');
  });
});

// exdates_add names each occurrence by its start, as the read tools show it,
// in the series as it is before the edit. Thunderbird removes an occurrence by
// its RECURRENCE-ID, which for a changed occurrence is its slot, not its start.
describe('excluded dates name occurrences by their start, as the read tools show them', () => {
  const RANGE = [fakeDate('2099-09-01'), fakeDate('2100-01-01')];
  const starts = (item) => seriesOccurrences(item, ...RANGE).map(({ start }) => start.toString());
  const exdates = (item) => item.recurrenceInfo.getRecurrenceItems().filter((r) => r.icalProperty.propertyName === 'EXDATE').map((r) => r.icalProperty.value);
  // The day's 17:00 occurrence, moved to 19:00.
  const movedOn = (day) => fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime(day, 19), endDate: fakeDateTime(day, 20), recurrenceId: fakeDateTime(day, 17) });

  it('an edit of the whole series that excludes a changed occurrence by its start removes it', async () => {
    const master = series('FREQ=DAILY', { exceptions: [movedOn('2099-10-07')] });
    expect(starts(master)).toContain('20991007T190000');
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', exdates_add: ['2099-10-07T19:00:00'] });
    expect(res, res.error).toMatchObject({ ok: true });
    const saved = calendar.items[0];
    expect(exdates(saved)).toEqual(['20991007T170000']);
    expect(starts(saved)).not.toContain('20991007T190000');
    expect(starts(saved)).not.toContain('20991007T170000');
    expect(starts(saved)).toContain('20991008T170000');
  });

  // Thunderbird applies an EXDATE only to a query whose range holds its date
  // (CalRecurrenceInfo.calculateDates), so a changed occurrence moved to
  // another day is excluded only once its changed copy is removed too: a query
  // over the day it moved to must not show it.
  const movedAway = (slotDay, toDay) => fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime(toDay, 19), endDate: fakeDateTime(toDay, 20), recurrenceId: fakeDateTime(slotDay, 17) });
  const startsOn = (item, day, nextDay) => seriesOccurrences(item, fakeDateTime(day, 0), fakeDateTime(nextDay, 0)).map(({ start }) => start.toString()).sort();

  it('an edit of the whole series that excludes a changed occurrence moved to another day removes it from that day too', async () => {
    const master = series('FREQ=DAILY', { exceptions: [movedAway('2099-10-07', '2099-10-10')] });
    expect(startsOn(master, '2099-10-10', '2099-10-11')).toEqual(['20991010T170000', '20991010T190000']);
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', exdates_add: ['2099-10-10T19:00:00'] });
    expect(res, res.error).toMatchObject({ ok: true });
    const saved = calendar.items[0];
    expect(exdates(saved)).toEqual(['20991007T170000']);
    expect(saved.recurrenceInfo.getExceptionFor(fakeDateTime('2099-10-07', 17))).toBeNull();
    expect(startsOn(saved, '2099-10-10', '2099-10-11')).toEqual(['20991010T170000']);
    expect(starts(saved)).not.toContain('20991007T170000');
  });

  it('a this-and-following edit that excludes changed occurrences moved to other days removes each from its part, and from the day it moved to', async () => {
    const master = series('FREQ=DAILY', { exceptions: [movedAway('2099-10-07', '2099-10-10'), movedAway('2099-10-18', '2099-10-21')] });
    expect(startsOn(master, '2099-10-21', '2099-10-22')).toEqual(['20991021T170000', '20991021T190000']);
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const res = await api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: '2099-10-15T17:00:00',
      exdates_add: ['2099-10-10T19:00:00', '2099-10-21T19:00:00'],
    });
    expect(res, res.error).toMatchObject({ ok: true });
    const capped = calendar.items.find((it) => it.id === 'ser');
    const fresh = calendar.items.find((it) => it.id !== 'ser');
    expect(exdates(capped)).toEqual(['20991007T170000']);
    expect(exdates(fresh)).toEqual(['20991018T170000']);
    expect(capped.recurrenceInfo.getExceptionIds()).toEqual([]);
    expect(fresh.recurrenceInfo.getExceptionIds()).toEqual([]);
    expect(startsOn(capped, '2099-10-10', '2099-10-11')).toEqual(['20991010T170000']);
    expect(startsOn(fresh, '2099-10-21', '2099-10-22')).toEqual(['20991021T170000']);
  });

  it('an edit of the whole series that moves its start excludes the occurrence it named before the move', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY')] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', start_iso: '2099-10-01T18:00:00', exdates_add: ['2099-10-20T17:00:00'] });
    expect(res, res.error).toMatchObject({ ok: true });
    const saved = calendar.items[0];
    expect(exdates(saved)).toEqual(['20991020T180000']);
    expect(starts(saved)).not.toContain('20991020T180000');
    expect(starts(saved)).toContain('20991021T180000');
  });

  for (const [name, args] of [
    ['the whole series', {}],
    ['one occurrence', { edit_scope: 'this_only', recurrence_id: '2099-10-15T17:00:00' }],
    ['this and following', { edit_scope: 'this_and_following', recurrence_id: '2099-10-15T17:00:00' }],
  ]) {
    it(`an excluded date no occurrence starts at is refused and writes nothing (${name})`, async () => {
      const master = series('FREQ=DAILY');
      const rules = ruleValues(master);
      const { api, calendar, modifications } = loadCalendarBridge(bridgeUrl, { items: [master] });
      const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', ...args, title: 'Renamed', exdates_add: ['2099-10-20T17:00:00', '2099-10-20T18:00:00'] });
      expect(res).toMatchObject({ ok: false });
      expect(res.error).toMatch(/exdates_add 2099-10-20T18:00:00 is not the start of an occurrence of this series/);
      expect(modifications).toEqual([]);
      expect(calendar.items).toEqual([master]);
      expect(master.title).toBe('Sync');
      expect(ruleValues(master)).toEqual(rules);
      expect(exdates(master)).toEqual([]);
      expect(master.recurrenceInfo.getExceptionIds()).toEqual([]);
    });
  }
});

// Thunderbird's schema layer hands an experiment every optional property the
// schema declares and the caller omitted as null, recursively (Schemas.sys.mjs),
// so the bridge never sees an absent `recurrence`: an edit that does not mention
// the rule passes `recurrence: null`, and `{}` arrives with every field null.
// The bridge tests above pass plain objects; these pass the shapes Thunderbird
// delivers. The invariant: an edit that does not mention the rule keeps it.
describe('Thunderbird\'s argument shapes: an edit that does not mention the rule keeps it', () => {
  const NULL_RECURRENCE_FIELDS = { freq: null, interval: null, count: null, until: null, byDay: null, byMonthDay: null, byMonth: null, wkst: null };
  const followingPart = (calendar) => calendar.items.find((it) => it.id !== 'ser');

  it('a series edit with recurrence null keeps the rule', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=WEEKLY;BYDAY=MO')] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', title: 'Renamed', recurrence: null, patch: null, exdates_add: null, edit_scope: null, recurrence_id: null });
    expect(res).toMatchObject({ ok: true });
    expect(ruleValues(savedItem(calendar))).toEqual(['FREQ=WEEKLY;BYDAY=MO']);
  });

  it('a this-and-following edit with recurrence null keeps the rule on the following part', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY')] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: '2099-10-15T17:00:00', title: 'Renamed', recurrence: null, patch: null });
    expect(res).toMatchObject({ ok: true });
    expect(ruleValues(followingPart(calendar))).toEqual(['FREQ=DAILY']);
  });

  it('{} with every field null on a this-and-following edit stops the following part repeating', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY')] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: '2099-10-15T17:00:00', recurrence: { ...NULL_RECURRENCE_FIELDS } });
    expect(res).toMatchObject({ ok: true });
    expect(ruleValues(followingPart(calendar))).toEqual([]);
  });

  it('a rule whose omitted fields are null is written without them', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY')] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { ...NULL_RECURRENCE_FIELDS, freq: 'WEEKLY', byDay: ['MO'] } });
    expect(res).toMatchObject({ ok: true });
    expect(ruleValues(savedItem(calendar))).toEqual(['FREQ=WEEKLY;BYDAY=MO']);
  });
});

// Daylight saving time ends in the user's zone (America/Vancouver) on
// 2099-11-01, so a bound in November has a different UTC offset from a start in
// October. The last day is computed with the offset of that day, never the
// start's.
describe('a last day after daylight saving time ends keeps its frame', () => {
  it('a split after the change reads its cap as the day before the split', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY')] });
    const res = await api.splitRecurringEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence_id: '2099-11-15T17:00:00', patch: { title: 'Renamed' } });
    expect(res).toMatchObject({ ok: true });
    expect((await readFields(api)).until).toBe('2099-11-14');
  });

  it('a last day after the change keeps that day\'s late-evening occurrence', async () => {
    const start = fakeDateTime(START_DAY, 23, 30);
    const ev = fakeEvent({ id: 'ser', title: 'Sync', startDate: start, endDate: fakeDateTime(START_DAY, 23, 50) });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY')]);
    ev.recurrenceInfo.item = ev;
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [ev] });
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'DAILY', until: '2099-11-30' } });
    const [rule] = ruleValues(savedItem(calendar));
    const m = /UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(rule);
    expect(m).not.toBeNull();
    expect(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toBeGreaterThanOrEqual(new Date(2099, 10, 30, 23, 30).getTime());
    expect(lastDayAdmitted(start, untilOf(rule))).toBe('2099-11-30');
  });
});
