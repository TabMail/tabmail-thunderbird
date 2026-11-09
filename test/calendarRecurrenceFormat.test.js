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
//   - writing a rule keeps the series' excluded and added dates and changed
//     occurrences, on an edit and on the earlier part of a split;
//   - the rule is read from where Thunderbird stores it, never an in-memory echo;
//   - `{}` clears the rule;
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
  fixedZone, FLOATING_ZONE,
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
  return ev;
}

// East of UTC, so a bound's day differs from the user's (Vancouver) zone.
const EAST = fixedZone('Test/East+0900', 9 * 60);
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

  it('defaults are omitted, every writable field is shown, and the rule in recurrenceInfo is found when the property is empty', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, {
      items: [series('FREQ=YEARLY;INTERVAL=1;WKST=MO;COUNT=5;BYMONTH=3,9;BYMONTHDAY=1,-1')],
    });
    expect(await readFields(api)).toEqual({ freq: 'YEARLY', count: 5, byMonthDay: [1, -1], byMonth: [3, 9] });
  });

  it('a non-default interval and week start are shown', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=TU')] });
    expect(await readFields(api)).toEqual({ freq: 'WEEKLY', interval: 2, byDay: ['TU'], wkst: 'SU' });
  });

  it('one weekday at one BYSETPOS folds to its ordinal byDay', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2')] });
    expect(await readFields(api)).toEqual({ freq: 'MONTHLY', byDay: ['2TU'] });
    const last = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1')] });
    expect(await readFields(last.api)).toEqual({ freq: 'MONTHLY', byDay: ['-1FR'] });
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

  it('the rule is read from the recurrence info, not an older in-memory RRULE property', async () => {
    const ev = series('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
    ev.setProperty('RRULE', 'FREQ=WEEKLY;BYDAY=MO');
    const occ = fakeEvent({ id: 'ser', title: 'Sync', startDate: fakeDateTime(START_DAY, 17), endDate: fakeDateTime(START_DAY, 18), recurrenceId: fakeDateTime(START_DAY, 17) });
    ev.recurrenceInfo.occurrences.push(occ);
    occ.parentItem = ev;
    const { api } = loadCalendarBridge(bridgeUrl, { items: [ev] });
    expect(await readFields(api)).toEqual({ freq: 'WEEKLY', interval: 2, byDay: ['MO'] });
    const rows = await api.queryCalendarItems(`${START_DAY}T00:00:00`, '2099-10-02T00:00:00', ['cal1']);
    expect(rows[0].recurrence).toEqual({ freq: 'WEEKLY', interval: 2, byDay: ['MO'] });
  });

  it('BYSETPOS folds only where the ordinal names the same days', async () => {
    const twoMonths = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=YEARLY;BYMONTH=3,9;BYDAY=TU;BYSETPOS=2')] });
    expect(await readFields(twoMonths.api)).toEqual({ freq: 'YEARLY', byDay: ['TU'], byMonth: [3, 9], other: 'BYSETPOS=2' });
    const oneMonth = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=YEARLY;BYMONTH=3;BYDAY=TU;BYSETPOS=2')] });
    expect(await readFields(oneMonth.api)).toEqual({ freq: 'YEARLY', byDay: ['2TU'], byMonth: [3] });
    const daily = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY;BYDAY=TU;BYSETPOS=1')] });
    expect(await readFields(daily.api)).toEqual({ freq: 'DAILY', byDay: ['TU'], other: 'BYSETPOS=1' });
    const monthDay = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1,2,3,4,5,6,7;BYDAY=TU;BYSETPOS=1')] });
    expect((await readFields(monthDay.api)).other).toBe('BYSETPOS=1');
  });

  it('the query rows carry the same fields', async () => {
    const until = utcUntil(LAST_DAY, 23);
    const ev = series(`FREQ=WEEKLY;BYDAY=MO;UNTIL=${until}`);
    const occ = fakeEvent({ id: 'ser', title: 'Sync', startDate: fakeDateTime(START_DAY, 17), endDate: fakeDateTime(START_DAY, 18), recurrenceId: fakeDateTime(START_DAY, 17) });
    ev.recurrenceInfo.occurrences.push(occ);
    occ.parentItem = ev;
    const { api } = loadCalendarBridge(bridgeUrl, { items: [ev] });
    const rows = await api.queryCalendarItems(`${START_DAY}T00:00:00`, '2099-10-02T00:00:00', ['cal1']);
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

  it('writing a rule leaves exactly one rule, even where the series had two', async () => {
    const second = recurrenceItem('RRULE', 'FREQ=MONTHLY;BYMONTHDAY=1');
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=WEEKLY;BYDAY=MO', { extraItems: [second] })] });
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'DAILY' } });
    expect(ruleValues(savedItem(calendar))).toEqual(['FREQ=DAILY']);
  });

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

  it('writing a rule keeps the series\' excluded and added dates', async () => {
    const exdate = recurrenceItem('EXDATE', '20991020T170000');
    const rdate = recurrenceItem('RDATE', '20991102T170000');
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=WEEKLY;BYDAY=MO', { extraItems: [exdate, rdate] })] });
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'WEEKLY', byDay: ['TU'] } });
    const items = savedItem(calendar).recurrenceInfo.getRecurrenceItems();
    expect(items).toContain(exdate);
    expect(items).toContain(rdate);
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
    [{ freq: 'WEEKLY', byDay: ['2TU'] }, 'recurrence.byDay has an invalid value "2TU": a position such as 2TU only with freq MONTHLY or YEARLY'],
    [{ freq: 'DAILY', byDay: ['-1FR'] }, 'recurrence.byDay has an invalid value "-1FR": a position such as 2TU only with freq MONTHLY or YEARLY'],
    [{ freq: 'MONTHLY', byDay: ['TU', '6TU'] }, 'recurrence.byDay has an invalid value "6TU": with freq MONTHLY a position from 1 to 5 or -5 to -1'],
    [{ freq: 'MONTHLY', byDay: ['-6TU'] }, 'recurrence.byDay has an invalid value "-6TU": with freq MONTHLY a position from 1 to 5 or -5 to -1'],
    [{ freq: 'WEEKLY', byMonthDay: [15] }, 'recurrence.byMonthDay has an invalid value "[15]": not with freq WEEKLY (RFC 5545)'],
    [{ freq: 'MONTHLY', byDay: ['TU'], bySetPos: [2] }, 'recurrence.bySetPos is not a recurrence field: use freq, interval, count, until, byDay, byMonthDay, byMonth, wkst'],
    [{ freq: 'DAILY', byHour: [9] }, 'recurrence.byHour is not a recurrence field: use freq, interval, count, until, byDay, byMonthDay, byMonth, wkst'],
    ['FREQ=WEEKLY;BYDAY=MO', 'recurrence has an invalid value "FREQ=WEEKLY;BYDAY=MO": an object of recurrence fields, or {} to clear the rule'],
    [{ freq: 'DAILY', count: 3, until: LAST_DAY }, `recurrence.until has an invalid value "${LAST_DAY}": count and until cannot both be set; give one of them`],
    [{ freq: 'WEEKLY', byDay: ['MO', 'MONDAY'] }, 'recurrence.byDay has an invalid value "MONDAY": day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'WEEKLY', byDay: ['MO;BYHOUR=9'] }, 'recurrence.byDay has an invalid value "MO;BYHOUR=9": day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'MONTHLY', byDay: ['54MO'] }, 'recurrence.byDay has an invalid value "54MO": day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'WEEKLY', byDay: 'MO' }, 'recurrence.byDay has an invalid value "MO": a list of day codes MO..SU, optionally with a position such as 2TU or -1FR'],
    [{ freq: 'MONTHLY', byMonthDay: [0] }, 'recurrence.byMonthDay has an invalid value "0": integers from 1 to 31 or -31 to -1'],
    [{ freq: 'MONTHLY', byMonthDay: [32] }, 'recurrence.byMonthDay has an invalid value "32": integers from 1 to 31 or -31 to -1'],
    [{ freq: 'YEARLY', byMonth: [13] }, 'recurrence.byMonth has an invalid value "13": integers from 1 to 12'],
    [{ freq: 'WEEKLY', wkst: 'monday' }, 'recurrence.wkst has an invalid value "monday": one of MO, TU, WE, TH, FR, SA, SU'],
    [{ freq: 'YEARLY', other: 'BYWEEKNO=20' }, `recurrence.other has an invalid value "BYWEEKNO=20": ${OTHER_PARTS_NOTE}`],
    [[], 'recurrence has an invalid value "[]": an object of recurrence fields, or {} to clear the rule'],
  ];
  for (const [arg, message] of refused) {
    it(JSON.stringify(arg), () => {
      expect(recurrenceArgError(arg)).toBe(message);
    });
  }

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
      expect(recurrenceArgError(arg)).toBeNull();
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

describe('split: the earlier part keeps its exceptions and the stored rule', () => {
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
  const named = (item, name) => item.recurrenceInfo.getRecurrenceItems()
    .filter((r) => r.icalProperty.propertyName === name).map((r) => r.icalProperty.value);

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

  it('cancelled, added and moved occurrences before the split stay; added and moved ones from it on go', async () => {
    const exdate = recurrenceItem('EXDATE', '20991008T170000');
    const earlyAdded = recurrenceItem('RDATE', '20991009T090000');
    const lateAdded = recurrenceItem('RDATE', '20991020T090000');
    const moved = (day) => fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime(day, 19), endDate: fakeDateTime(day, 20), recurrenceId: fakeDateTime(day, 17) });
    const master = series('FREQ=DAILY', { extraItems: [exdate, earlyAdded, lateAdded], exceptions: [moved('2099-10-05'), moved('2099-10-18')] });
    const { capped } = await splitAt(master, '2099-10-15T17:00:00');
    expect(named(capped, 'EXDATE')).toEqual(['20991008T170000']);
    expect(named(capped, 'RDATE')).toEqual(['20991009T090000']);
    expect(capped.recurrenceInfo.getExceptionIds().map(String)).toEqual(['20991005T170000']);
    expect(ruleValues(capped)).toHaveLength(1);
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
});
