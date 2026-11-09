/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarRecurrenceFormat.test.js: the calendar tools read a recurring event's
// rule in the same fields the create and edit tools write, so the model can
// pass back exactly what it read. Pinned here, through the real bridge:
//   - the read side shows those fields, with `until` as the last day of the
//     series in the event's zone (never the UTC date of the UNTIL instant);
//   - writing what was read and reading it back gives the same fields, and the
//     named last day's occurrence stays in the series;
//   - writing a rule keeps the series' excluded and added dates;
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
  loadCalendarBridge, fakeDate, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem,
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

function series(rrule, { allDay = false, extraItems = [] } = {}) {
  const startDate = allDay ? fakeDate(START_DAY) : fakeDateTime(START_DAY, 17);
  const endDate = allDay ? fakeDate('2099-10-02') : fakeDateTime(START_DAY, 18);
  const ev = fakeEvent({ id: 'ser', title: 'Sync', startDate, endDate });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', rrule), ...extraItems]);
  return ev;
}

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

  it('a DATE or floating UNTIL is read by its digits', async () => {
    const allDay = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY;UNTIL=20991031', { allDay: true })] });
    expect(await readFields(allDay.api)).toEqual({ freq: 'DAILY', until: LAST_DAY });
    const floating = loadCalendarBridge(bridgeUrl, { items: [series('FREQ=DAILY;UNTIL=20991031T170000')] });
    expect(await readFields(floating.api)).toEqual({ freq: 'DAILY', until: LAST_DAY });
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
    savedItem(calendar).setProperty('RRULE', 'FREQ=WEEKLY;BYDAY=MO');
    await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: {} });
    const saved = savedItem(calendar);
    expect(saved.recurrenceInfo).toBeNull();
    expect(saved.getProperty('RRULE')).toBeNull();
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
    { freq: 'DAILY', until: '2099-10-31T17:00:00' },
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
