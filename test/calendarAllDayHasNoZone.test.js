/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarAllDayHasNoZone.test.js: every all-day value the bridge writes is a
// DATE with no zone (floating), as Thunderbird's own event dialog writes one. A
// DATE that carries a zone has its epoch time at midnight in that zone, and
// ical.js compares a rule's UNTIL with each occurrence by instant, so west of
// UTC a series' last day fell after a bare-date UNTIL naming it and was
// dropped. Pinned here, through the real bridge, west of UTC:
//   - a created all-day event, and a created all-day daily series with a last
//     day, which keeps every day up to and including that day;
//   - a whole-series edit (an all-day series moved, a timed event made all-day,
//     a new start alone with the end following it);
//   - a one-occurrence edit;
//   - a "this and following" split of a series TabMail created, which is not
//     refused and keeps every occurrence on one side or the other;
//   - a series stored with a zoned all-day start (as TabMail wrote them before):
//     an edit of the whole series (its rule, its dates, or its title alone) and
//     a split (both parts) write every all-day value as a plain date with the
//     same day (start, end, excluded and added dates, and each changed
//     occurrence's RECURRENCE-ID, start and end), so a rule keeps the last day
//     its UNTIL names, a daily split is not refused, and none of its dates move.

// West of UTC, where a zoned DATE's midnight is after the same day's UTC one.
process.env.TZ = 'America/Vancouver';

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

const {
  loadCalendarBridge, fakeDate, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem, recurrenceDate, seriesOccurrences,
  fixedZone, FLOATING_ZONE, LOCAL_ZONE,
} = await import('./helpers/calendarBridgeHarness.js');

// A far-future series (2099 is the dated-test exception: never goes stale).
const START_DAY = '2099-10-01';
const LAST_DAY = '2099-10-31';
const RANGE_END = '2099-11-30';
const SPLIT_DAY = '2099-10-15';
const MOVED_DAY = '2099-10-20';
const EAST = fixedZone('Test/East+0900', 9 * 60);

const dayOf = (dt) => `${dt.year}-${String(dt.month + 1).padStart(2, '0')}-${String(dt.day).padStart(2, '0')}`;
const nextDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
const daysFrom = (first, last) => {
  const out = [];
  for (let day = first; day <= last; day = nextDay(day)) out.push(day);
  return out;
};

// The days a series has occurrences on, as Thunderbird expands it.
const occurrenceDays = (item) => seriesOccurrences(item, fakeDate(START_DAY), fakeDate(RANGE_END))
  .map((o) => dayOf(o.start)).sort();

// An all-day value with no zone, on `day`.
function expectAllDayWithoutZone(dt, day) {
  expect(dt).toBeTruthy();
  expect({ isDate: dt.isDate, zone: dt.timezone, day: dayOf(dt) }).toEqual({ isDate: true, zone: FLOATING_ZONE, day });
}

async function created(fields = {}) {
  const loaded = loadCalendarBridge(bridgeUrl, { items: [] });
  const res = await loaded.api.createCalendarEvent({
    calendar_id: 'cal1', title: 'Offsite', start_iso: `${START_DAY}T00:00:00`, end_iso: `${nextDay(START_DAY)}T00:00:00`, all_day: true, ...fields,
  });
  expect(res).toMatchObject({ ok: true });
  expect(loaded.calendar.items).toHaveLength(1);
  return { ...loaded, res, item: loaded.calendar.items[0] };
}

const createdSeries = () => created({ recurrence: { freq: 'DAILY', until: LAST_DAY } });

describe('precondition: the process zone is west of UTC', () => {
  it('a DATE in the user\'s zone is later than the same day at UTC midnight', () => {
    expect(fakeDate(START_DAY, LOCAL_ZONE).nativeTime).toBeGreaterThan(fakeDate(START_DAY, FLOATING_ZONE).nativeTime);
  });
});

describe('create: an all-day event is written as dates with no zone', () => {
  it('a single all-day event', async () => {
    const { item } = await created();
    expectAllDayWithoutZone(item.startDate, START_DAY);
    expectAllDayWithoutZone(item.endDate, nextDay(START_DAY));
  });

  it('a daily series with a last day keeps every day up to and including it', async () => {
    const { item } = await createdSeries();
    expectAllDayWithoutZone(item.startDate, START_DAY);
    expect(occurrenceDays(item)).toEqual(daysFrom(START_DAY, LAST_DAY));
  });

  it('an all-day event made in another zone is still its date with no zone', async () => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [] });
    const { cal } = loaded.ctx.ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');
    cal.timezoneService.getTimezone = (tzid) => (tzid === EAST.tzid ? EAST : null);
    const res = await loaded.api.createCalendarEvent({
      calendar_id: 'cal1', title: 'Offsite', start_iso: `${START_DAY}T00:00:00`, end_iso: `${nextDay(START_DAY)}T00:00:00`, all_day: true, timezone: EAST.tzid,
    });
    expect(res).toMatchObject({ ok: true });
    const [item] = loaded.calendar.items;
    expectAllDayWithoutZone(item.startDate, START_DAY);
    expectAllDayWithoutZone(item.endDate, nextDay(START_DAY));
  });
});

describe('whole-series edit: the new all-day dates have no zone', () => {
  // Thunderbird moves a series' UNTIL with its start, so the series keeps its days.
  it('an all-day series moved a day later keeps all its days, its last one moved too', async () => {
    const { api, calendar, res } = await createdSeries();
    const edit = await api.modifyCalendarEvent({
      event_id: res.event_id, calendar_id: 'cal1', all_day: true, start_iso: `${nextDay(START_DAY)}T00:00:00`, end_iso: `${nextDay(nextDay(START_DAY))}T00:00:00`,
    });
    expect(edit).toMatchObject({ ok: true });
    const [item] = calendar.items;
    expectAllDayWithoutZone(item.startDate, nextDay(START_DAY));
    expectAllDayWithoutZone(item.endDate, nextDay(nextDay(START_DAY)));
    expect(occurrenceDays(item)).toEqual(daysFrom(nextDay(START_DAY), nextDay(LAST_DAY)));
  });

  it('a series stored with a zoned all-day start keeps its last day once its dates are restated', async () => {
    const start = fakeDate(START_DAY, LOCAL_ZONE);
    const ev = fakeEvent({ id: 'ser', title: 'Old', startDate: start, endDate: fakeDate(nextDay(START_DAY), LOCAL_ZONE) });
    const loaded = loadCalendarBridge(bridgeUrl, { items: [ev] });
    const edit = await loaded.api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', all_day: true, start_iso: `${START_DAY}T00:00:00`, end_iso: `${nextDay(START_DAY)}T00:00:00`,
      recurrence: { freq: 'DAILY', until: LAST_DAY },
    });
    expect(edit).toMatchObject({ ok: true });
    const item = loaded.calendar.items.find((it) => it.id === 'ser');
    expectAllDayWithoutZone(item.startDate, START_DAY);
    expect(occurrenceDays(item)).toEqual(daysFrom(START_DAY, LAST_DAY));
  });

  it('a timed event made all-day', async () => {
    const ev = fakeEvent({ id: 'evt', title: 'Talk', startDate: fakeDateTime(START_DAY, 17), endDate: fakeDateTime(START_DAY, 18) });
    const loaded = loadCalendarBridge(bridgeUrl, { items: [ev] });
    const edit = await loaded.api.modifyCalendarEvent({
      event_id: 'evt', calendar_id: 'cal1', all_day: true, start_iso: `${START_DAY}T00:00:00`, end_iso: `${nextDay(START_DAY)}T00:00:00`,
    });
    expect(edit).toMatchObject({ ok: true });
    const item = loaded.calendar.items.find((it) => it.id === 'evt');
    expectAllDayWithoutZone(item.startDate, START_DAY);
    expectAllDayWithoutZone(item.endDate, nextDay(START_DAY));
  });

  it('a new start alone: the end follows it, with no zone', async () => {
    const { api, calendar, res } = await created();
    const edit = await api.modifyCalendarEvent({ event_id: res.event_id, calendar_id: 'cal1', all_day: true, start_iso: `${MOVED_DAY}T00:00:00` });
    expect(edit).toMatchObject({ ok: true });
    const [item] = calendar.items;
    expectAllDayWithoutZone(item.startDate, MOVED_DAY);
    expectAllDayWithoutZone(item.endDate, nextDay(MOVED_DAY));
  });
});

describe('one-occurrence edit: the changed occurrence\'s new dates have no zone', () => {
  it('an occurrence of a created series moved to another day', async () => {
    const { api, calendar, res } = await createdSeries();
    const edit = await api.modifyCalendarEvent({
      event_id: res.event_id, calendar_id: 'cal1', edit_scope: 'this_only', recurrence_id: `${SPLIT_DAY}T00:00:00`,
      all_day: true, start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${nextDay(MOVED_DAY)}T00:00:00`,
    });
    expect(edit).toMatchObject({ ok: true });
    const [item] = calendar.items;
    const changed = item.recurrenceInfo.getExceptionIds().map((rid) => item.recurrenceInfo.getExceptionFor(rid));
    expect(changed).toHaveLength(1);
    guardLength(changed, 1);
    expect(dayOf(changed[0].recurrenceId)).toBe(SPLIT_DAY);
    expectAllDayWithoutZone(changed[0].startDate, MOVED_DAY);
    expectAllDayWithoutZone(changed[0].endDate, nextDay(MOVED_DAY));
  });
});

describe('"this and following" split of a series TabMail created', () => {
  async function splitCreated(patch) {
    const loaded = await createdSeries();
    const res = await loaded.api.modifyCalendarEvent({
      event_id: loaded.res.event_id, calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: `${SPLIT_DAY}T00:00:00`, ...patch,
    });
    return {
      res,
      capped: loaded.calendar.items.find((it) => it.id === loaded.res.event_id),
      fresh: loaded.calendar.items.find((it) => it.id !== loaded.res.event_id),
    };
  }

  it('is not refused, and every day is on one side or the other', async () => {
    const { res, capped, fresh } = await splitCreated({ title: 'Renamed' });
    expect(res).toMatchObject({ ok: true });
    expect(occurrenceDays(capped)).toEqual(daysFrom(START_DAY, '2099-10-14'));
    expect(occurrenceDays(fresh)).toEqual(daysFrom(SPLIT_DAY, LAST_DAY));
    expectAllDayWithoutZone(fresh.startDate, SPLIT_DAY);
    expectAllDayWithoutZone(fresh.endDate, nextDay(SPLIT_DAY));
  });

  it('new all-day dates for the following part have no zone', async () => {
    const { res, fresh } = await splitCreated({ all_day: true, start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${nextDay(MOVED_DAY)}T00:00:00` });
    expect(res).toMatchObject({ ok: true });
    expectAllDayWithoutZone(fresh.startDate, MOVED_DAY);
    expectAllDayWithoutZone(fresh.endDate, nextDay(MOVED_DAY));
  });
});

// A series as TabMail stored an all-day one before #303: its dates are DATEs in
// the user's zone, with an excluded date, an added date and an occurrence
// changed on its own, each event `days` days long.
function storedZonedSeries(rule, { excluded, added, changed, days = 1 }) {
  const day = (d) => fakeDate(d, LOCAL_ZONE);
  const after = (d, n) => { let out = d; for (let i = 0; i < n; i++) out = nextDay(out); return out; };
  const ev = fakeEvent({ id: 'ser', title: 'Old', startDate: day(START_DAY), endDate: day(after(START_DAY, days)) });
  const exception = fakeEvent({ id: 'ser', title: 'Changed', startDate: day(changed), endDate: day(after(changed, days)), recurrenceId: day(changed), properties: { LOCATION: 'Changed room' } });
  ev.recurrenceInfo = fakeRecurrenceInfo([
    recurrenceItem('RRULE', rule), recurrenceDate('EXDATE', day(excluded)), recurrenceDate('RDATE', day(added)),
  ], { exceptions: [exception] });
  ev.recurrenceInfo.item = ev;
  return ev;
}
const exceptionDays = (item) => item.recurrenceInfo.getExceptionIds().map(dayOf).sort();
const excludedDays = (item) => item.recurrenceInfo.getRecurrenceItems().filter((r) => r.date && r.isNegative).map((r) => dayOf(r.date)).sort();
const addedDays = (item) => item.recurrenceInfo.getRecurrenceItems().filter((r) => r.date && !r.isNegative).map((r) => dayOf(r.date)).sort();
const without = (days, ...gone) => days.filter((d) => !gone.includes(d));
const dayCount = (from, to) => Math.round((Date.UTC(to.year, to.month, to.day) - Date.UTC(from.year, from.month, from.day)) / 86400000);

// Every all-day value an item holds that still carries a zone: its start and
// end, its excluded and added dates, and each changed occurrence's
// RECURRENCE-ID, start and end. A plain date has none.
function zonedAllDayValues(item) {
  const info = item.recurrenceInfo;
  const values = [['DTSTART', item.startDate], ['DTEND', item.endDate]];
  for (const r of info?.getRecurrenceItems() || []) if (r.date) values.push([r.icalProperty.propertyName, r.date]);
  for (const rid of info?.getExceptionIds() || []) {
    const ex = info.getExceptionFor(rid);
    values.push(['RECURRENCE-ID', ex.recurrenceId], ['changed DTSTART', ex.startDate], ['changed DTEND', ex.endDate]);
  }
  return values.filter(([, dt]) => dt?.isDate && dt.timezone !== FLOATING_ZONE).map(([name, dt]) => `${name} ${dayOf(dt)} ${dt.timezone.tzid}`);
}

describe('a series stored with a zoned all-day start', () => {
  const DAILY = { rule: 'FREQ=DAILY;UNTIL=20991031', excluded: '2099-10-05', added: '2099-11-10', changed: '2099-10-08' };
  const stored = () => storedZonedSeries(DAILY.rule, DAILY);
  const datesOf = (item) => ({ excluded: excludedDays(item), added: addedDays(item), changed: exceptionDays(item) });
  const DAILY_DATES = { excluded: [DAILY.excluded], added: [DAILY.added], changed: [DAILY.changed] };

  it('precondition: as stored, west of UTC, it ends a day before its UNTIL', () => {
    expect(occurrenceDays(stored())).toEqual([...without(daysFrom(START_DAY, '2099-10-30'), DAILY.excluded), DAILY.added]);
    expect(zonedAllDayValues(stored())).toHaveLength(7);
  });

  it('a rule-only edit keeps the last day it names, moves none of its dates, and writes every one as a plain date', async () => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [stored()] });
    const edit = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'DAILY', until: '2099-10-25' } });
    expect(edit).toMatchObject({ ok: true });
    const item = loaded.calendar.items.find((it) => it.id === 'ser');
    expectAllDayWithoutZone(item.startDate, START_DAY);
    expectAllDayWithoutZone(item.endDate, nextDay(START_DAY));
    expect(occurrenceDays(item)).toEqual([...without(daysFrom(START_DAY, '2099-10-25'), DAILY.excluded), DAILY.added]);
    expect(datesOf(item)).toEqual(DAILY_DATES);
    expect(zonedAllDayValues(item)).toEqual([]);
  });

  it('a whole-series edit restating its dates moves none of its dates, keeps the last day its UNTIL names, and writes every one as a plain date', async () => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [stored()] });
    const edit = await loaded.api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', all_day: true, start_iso: `${START_DAY}T00:00:00`, end_iso: `${nextDay(START_DAY)}T00:00:00`,
    });
    expect(edit).toMatchObject({ ok: true });
    const item = loaded.calendar.items.find((it) => it.id === 'ser');
    expectAllDayWithoutZone(item.startDate, START_DAY);
    expect(occurrenceDays(item)).toEqual([...without(daysFrom(START_DAY, LAST_DAY), DAILY.excluded), DAILY.added]);
    expect(datesOf(item)).toEqual(DAILY_DATES);
    expect(zonedAllDayValues(item)).toEqual([]);
  });

  it('a whole-series edit of its title alone writes every date as a plain date, keeping each day and the last day its UNTIL names', async () => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [stored()] });
    const edit = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', title: 'Renamed' });
    expect(edit).toMatchObject({ ok: true });
    const item = loaded.calendar.items.find((it) => it.id === 'ser');
    expect(item.title).toBe('Renamed');
    expectAllDayWithoutZone(item.startDate, START_DAY);
    expectAllDayWithoutZone(item.endDate, nextDay(START_DAY));
    expect(occurrenceDays(item)).toEqual([...without(daysFrom(START_DAY, LAST_DAY), DAILY.excluded), DAILY.added]);
    expect(datesOf(item)).toEqual(DAILY_DATES);
    expect(zonedAllDayValues(item)).toEqual([]);
    // The changed occurrence is still keyed to its day, and is the same
    // occurrence: it takes the title the edit names, as every occurrence of
    // the series does (#351), and keeps its own place, which the edit does
    // not name.
    const changed = item.recurrenceInfo.getExceptionFor(fakeDate(DAILY.changed));
    expect(changed).toMatchObject({ title: 'Renamed' });
    expect(changed.getProperty('LOCATION')).toBe('Changed room');
    expect(changed.parentItem).toBe(item);
  });

  it('a one-occurrence edit restating its dates changes that occurrence alone, and its dates, restated, are kept as the series stores them', async () => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [stored()] });
    const before = occurrenceDays(stored());
    const edit = await loaded.api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_only', recurrence_id: '2099-10-12T00:00:00',
      all_day: true, start_iso: '2099-10-12T00:00:00', end_iso: '2099-10-13T00:00:00', title: 'One',
    });
    expect(edit).toMatchObject({ ok: true });
    const item = loaded.calendar.items.find((it) => it.id === 'ser');
    expect(occurrenceDays(item)).toEqual(before);
    expect({ excluded: excludedDays(item), changed: exceptionDays(item) }).toEqual({ excluded: [DAILY.excluded], changed: [DAILY.changed, '2099-10-12'] });
    const one = item.recurrenceInfo.getExceptionFor(item.recurrenceInfo.getExceptionIds().find((rid) => dayOf(rid) === '2099-10-12'));
    // A restated date is no change, so nothing rewrites it: the occurrence keeps
    // the date Thunderbird built it with, in the series' stored zone.
    expect(one.title).toBe('One');
    expect({ isDate: one.startDate.isDate, zone: one.startDate.timezone, day: dayOf(one.startDate) }).toEqual({ isDate: true, zone: LOCAL_ZONE, day: '2099-10-12' });
  });

  async function splitStored(series, patch) {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [series] });
    const res = await loaded.api.modifyCalendarEvent({
      event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: `${SPLIT_DAY}T00:00:00`, ...patch,
    });
    expect(res, res.error).toMatchObject({ ok: true });
    return {
      capped: loaded.calendar.items.find((it) => it.id === 'ser'),
      fresh: loaded.calendar.items.find((it) => it.id !== 'ser'),
    };
  }

  // Daily, so the day before the split is an occurrence: the capped part's
  // bare-date UNTIL names it, and it stays because the part's start is a plain date.
  it('a daily split keeps every day on one side or the other, each part written as plain dates', async () => {
    const { capped, fresh } = await splitStored(stored(), { title: 'Renamed' });
    expect(occurrenceDays(capped)).toEqual(without(daysFrom(START_DAY, '2099-10-14'), DAILY.excluded));
    expect(occurrenceDays(fresh)).toEqual([...daysFrom(SPLIT_DAY, LAST_DAY), DAILY.added]);
    expect(datesOf(capped)).toEqual({ excluded: [DAILY.excluded], added: [], changed: [DAILY.changed] });
    expect(datesOf(fresh)).toEqual({ excluded: [], added: [DAILY.added], changed: [] });
    expect(zonedAllDayValues(capped)).toEqual([]);
    expect(zonedAllDayValues(fresh)).toEqual([]);
  });

  const WEEKLY = { rule: 'FREQ=WEEKLY;UNTIL=20991031', excluded: '2099-10-22', added: '2099-10-24', changed: '2099-10-08' };
  const storedWeekly = (days = 1) => storedZonedSeries(WEEKLY.rule, { ...WEEKLY, days });

  it('a split giving the following part a new rule keeps the last day it names', async () => {
    const { capped, fresh } = await splitStored(storedWeekly(), { recurrence: { freq: 'WEEKLY', until: '2099-11-05' } });
    expectAllDayWithoutZone(fresh.startDate, SPLIT_DAY);
    expect(occurrenceDays(fresh)).toEqual([SPLIT_DAY, WEEKLY.added, '2099-10-29', '2099-11-05']);
    expect(excludedDays(fresh)).toEqual([WEEKLY.excluded]);
    expect(occurrenceDays(capped)).toEqual([START_DAY, WEEKLY.changed]);
    expect(exceptionDays(capped)).toEqual([WEEKLY.changed]);
    expect(zonedAllDayValues(capped)).toEqual([]);
    expect(zonedAllDayValues(fresh)).toEqual([]);
  });

  it('a split restating the following part\'s dates moves none of its dates', async () => {
    const { capped, fresh } = await splitStored(storedWeekly(), { all_day: true, start_iso: `${SPLIT_DAY}T00:00:00`, end_iso: `${nextDay(SPLIT_DAY)}T00:00:00` });
    expectAllDayWithoutZone(fresh.startDate, SPLIT_DAY);
    expect(occurrenceDays(fresh)).toEqual([SPLIT_DAY, WEEKLY.added, '2099-10-29']);
    expect(excludedDays(fresh)).toEqual([WEEKLY.excluded]);
    expect(occurrenceDays(capped)).toEqual([START_DAY, WEEKLY.changed]);
    expect(exceptionDays(capped)).toEqual([WEEKLY.changed]);
    expect(zonedAllDayValues(capped)).toEqual([]);
    expect(zonedAllDayValues(fresh)).toEqual([]);
  });

  it('a split of a series of three-day events keeps three days for each event of both parts', async () => {
    const { capped, fresh } = await splitStored(storedWeekly(3), { title: 'Renamed' });
    for (const part of [capped, fresh]) {
      expect(dayCount(part.startDate, part.endDate)).toBe(3);
      const changed = part.recurrenceInfo.getExceptionIds().map((rid) => part.recurrenceInfo.getExceptionFor(rid));
      for (const ex of changed) expect(dayCount(ex.startDate, ex.endDate)).toBe(3);
      for (const o of seriesOccurrences(part, fakeDate(START_DAY), fakeDate(RANGE_END))) expect(dayCount(o.start, (o.item.recurrenceId ? o.item : o.item.createProxy(o.start)).endDate)).toBe(3);
    }
    expectAllDayWithoutZone(fresh.endDate, '2099-10-18');
    expect(occurrenceDays(capped)).toEqual([START_DAY, WEEKLY.changed]);
    expect(occurrenceDays(fresh)).toEqual([SPLIT_DAY, WEEKLY.added, '2099-10-29']);
    expect(zonedAllDayValues(capped)).toEqual([]);
    expect(zonedAllDayValues(fresh)).toEqual([]);
  });

  // An occurrence of an all-day series moved to a time of day, and an excluded
  // date-time, stay timed: only the series' dates become plain dates.
  const TIMED_CHANGED = '2099-10-08';
  const TIMED_EXCLUDED = '2099-10-05';
  function storedWithTimedValues() {
    const series = stored();
    const info = series.recurrenceInfo;
    const rid = info.getExceptionIds()[0];
    const ex = info.getExceptionFor(rid).clone();
    ex.startDate = fakeDateTime(TIMED_CHANGED, 9, 0, LOCAL_ZONE);
    ex.endDate = fakeDateTime(TIMED_CHANGED, 10, 0, LOCAL_ZONE);
    info.modifyException(ex, true);
    for (const r of [...info.getRecurrenceItems()]) if (r.date && r.isNegative) info.deleteRecurrenceItem(r);
    info.appendRecurrenceItem(recurrenceDate('EXDATE', fakeDateTime(TIMED_EXCLUDED, 0, 0, LOCAL_ZONE)));
    return series;
  }
  const timedValues = (item) => {
    const info = item.recurrenceInfo;
    const rid = info.getExceptionIds().find((r) => dayOf(r) === TIMED_CHANGED);
    const ex = rid && info.getExceptionFor(rid);
    const exdate = info.getRecurrenceItems().find((r) => r.date && r.isNegative)?.date;
    const asTimed = (dt) => dt && { isDate: dt.isDate, zone: dt.timezone?.tzid, at: dt.nativeTime };
    return { rid: rid && { isDate: rid.isDate, zone: rid.timezone?.tzid }, start: asTimed(ex?.startDate), end: asTimed(ex?.endDate), exdate: asTimed(exdate) };
  };
  const TIMED_EXPECTED = () => ({
    rid: { isDate: true, zone: FLOATING_ZONE.tzid },
    start: { isDate: false, zone: LOCAL_ZONE.tzid, at: fakeDateTime(TIMED_CHANGED, 9, 0, LOCAL_ZONE).nativeTime },
    end: { isDate: false, zone: LOCAL_ZONE.tzid, at: fakeDateTime(TIMED_CHANGED, 10, 0, LOCAL_ZONE).nativeTime },
    exdate: { isDate: false, zone: LOCAL_ZONE.tzid, at: fakeDateTime(TIMED_EXCLUDED, 0, 0, LOCAL_ZONE).nativeTime },
  });

  it('a whole-series edit of its title alone keeps an occurrence moved to a time of day and an excluded date-time timed', async () => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [storedWithTimedValues()] });
    const edit = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', title: 'Renamed' });
    expect(edit).toMatchObject({ ok: true });
    const item = loaded.calendar.items.find((it) => it.id === 'ser');
    expectAllDayWithoutZone(item.startDate, START_DAY);
    expect(timedValues(item)).toEqual(TIMED_EXPECTED());
  });

  it('a daily split keeps an occurrence moved to a time of day and an excluded date-time timed in the part before it', async () => {
    const { capped } = await splitStored(storedWithTimedValues(), { title: 'Renamed' });
    expectAllDayWithoutZone(capped.startDate, START_DAY);
    expect(timedValues(capped)).toEqual(TIMED_EXPECTED());
  });

  // East of UTC, a date-time UNTIL at local midnight names that day as the last
  // one; the split's following part keeps it, written as a plain date.
  it('east of UTC, a split\'s following part keeps the last day a date-time UNTIL gives it', async () => {
    const day = (d) => fakeDate(d, EAST);
    const ev = fakeEvent({ id: 'ser', title: 'Old', startDate: day(START_DAY), endDate: day(nextDay(START_DAY)) });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;UNTIL=20991024T150000Z')]);
    ev.recurrenceInfo.item = ev;
    expect(occurrenceDays(ev).at(-1), 'as stored').toBe('2099-10-25');
    const { capped, fresh } = await splitStored(ev, { title: 'Renamed' });
    expect(occurrenceDays(capped)).toEqual(daysFrom(START_DAY, '2099-10-14'));
    expect(occurrenceDays(fresh)).toEqual(daysFrom(SPLIT_DAY, '2099-10-25'));
    const ruleOf = (item) => item.recurrenceInfo.getRecurrenceItems().find((r) => !r.date).icalProperty.value;
    expect(ruleOf(fresh)).toBe('FREQ=DAILY;UNTIL=20991025');
    expect(zonedAllDayValues(fresh)).toEqual([]);
  });
});

describe('a single all-day event stored with a zone that is given a rule', () => {
  it('writes its dates as plain dates, so the rule keeps the last day it names', async () => {
    const ev = fakeEvent({ id: 'one', title: 'Once', startDate: fakeDate(START_DAY, LOCAL_ZONE), endDate: fakeDate(nextDay(START_DAY), LOCAL_ZONE) });
    const loaded = loadCalendarBridge(bridgeUrl, { items: [ev] });
    const edit = await loaded.api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', recurrence: { freq: 'DAILY', until: LAST_DAY } });
    expect(edit).toMatchObject({ ok: true });
    const item = loaded.calendar.items.find((it) => it.id === 'one');
    expectAllDayWithoutZone(item.startDate, START_DAY);
    expectAllDayWithoutZone(item.endDate, nextDay(START_DAY));
    expect(occurrenceDays(item)).toEqual(daysFrom(START_DAY, LAST_DAY));
  });
});

function guardLength(list, n) {
  if (list.length !== n) throw new Error(`expected ${n} items, got ${list.length}`);
}
