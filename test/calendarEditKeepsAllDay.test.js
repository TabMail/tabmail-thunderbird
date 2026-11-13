/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarEditKeepsAllDay.test.js: an edit that leaves `all_day` out keeps the
// event's kind, as the edit tool documents it ("Leave empty to keep existing").
// An all-day event moved to new dates stays all-day, and a timed one stays
// timed; only an `all_day` the edit gives changes the kind. Pinned through the
// real bridge, west of UTC (where an all-day date read as a time is the
// previous evening at UTC), for every edit that writes new times: a whole
// event, a series, a new start or end alone, one occurrence, and a "this and
// following" split (a start alone keeps the length, an end alone keeps the
// start). An all-day event given a time of day without all_day, or
// an all-day end on or before its start, is refused before anything is
// written, and the assistant is told to ask the user.

process.env.TZ = 'America/Vancouver';

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

const {
  loadCalendarBridge, fakeDate, fakeDateTime, fakeEvent, seriesOccurrences, FLOATING_ZONE, LOCAL_ZONE,
} = await import('./helpers/calendarBridgeHarness.js');

// A far-future series (2099 is the dated-test exception: never goes stale).
const START_DAY = '2099-10-01';
const LAST_DAY = '2099-10-31';
const RANGE_END = '2099-11-30';
const SPLIT_DAY = '2099-10-15';
const MOVED_DAY = '2099-10-20';

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
const occurrenceDays = (item) => seriesOccurrences(item, fakeDate(START_DAY), fakeDate(RANGE_END))
  .map((o) => dayOf(o.start)).sort();

function expectAllDay(dt, day) {
  expect(dt).toBeTruthy();
  expect({ isDate: dt.isDate, zone: dt.timezone, day: dayOf(dt) }).toEqual({ isDate: true, zone: FLOATING_ZONE, day });
}
function expectTimed(dt, day, hour) {
  expect(dt).toBeTruthy();
  expect({ isDate: !!dt.isDate, day: dayOf(dt), hour: dt.hour }).toEqual({ isDate: false, day, hour });
}
function guardLength(list, n) {
  if (list.length !== n) throw new Error(`expected ${n} items, got ${list.length}`);
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

async function edited(loaded, eventId, fields) {
  const edit = await loaded.api.modifyCalendarEvent({ event_id: eventId, calendar_id: 'cal1', ...fields });
  expect(edit).toMatchObject({ ok: true });
  return loaded.calendar.items.find((it) => it.id === eventId);
}

describe('an all-day event edited without all_day stays all-day', () => {
  it('new start and end', async () => {
    const loaded = await created();
    const item = await edited(loaded, loaded.res.event_id, { start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${nextDay(MOVED_DAY)}T00:00:00` });
    expectAllDay(item.startDate, MOVED_DAY);
    expectAllDay(item.endDate, nextDay(MOVED_DAY));
  });

  it('a new start alone: the end follows it by its length in days', async () => {
    const loaded = await created({ end_iso: `${nextDay(nextDay(START_DAY))}T00:00:00` });
    const item = await edited(loaded, loaded.res.event_id, { start_iso: `${MOVED_DAY}T00:00:00` });
    expectAllDay(item.startDate, MOVED_DAY);
    expectAllDay(item.endDate, nextDay(nextDay(MOVED_DAY)));
  });

  it('a new end alone: the start stays, and the event lasts until the new end', async () => {
    const loaded = await created();
    const item = await edited(loaded, loaded.res.event_id, { end_iso: `${nextDay(MOVED_DAY)}T00:00:00` });
    expectAllDay(item.startDate, START_DAY);
    expectAllDay(item.endDate, nextDay(MOVED_DAY));
  });

  it('an all-day event stored with dates in a zone stays all-day', async () => {
    const ev = fakeEvent({ id: 'evt', title: 'Holiday', startDate: fakeDate(START_DAY, LOCAL_ZONE), endDate: fakeDate(nextDay(START_DAY), LOCAL_ZONE) });
    const item = await edited(loadCalendarBridge(bridgeUrl, { items: [ev] }), 'evt', { start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${nextDay(MOVED_DAY)}T00:00:00` });
    expectAllDay(item.startDate, MOVED_DAY);
    expectAllDay(item.endDate, nextDay(MOVED_DAY));
  });

  it('a whole series moved a day later keeps all its days, its last one moved too', async () => {
    const loaded = await createdSeries();
    const item = await edited(loaded, loaded.res.event_id, { start_iso: `${nextDay(START_DAY)}T00:00:00` });
    expectAllDay(item.startDate, nextDay(START_DAY));
    expectAllDay(item.endDate, nextDay(nextDay(START_DAY)));
    expect(occurrenceDays(item)).toEqual(daysFrom(nextDay(START_DAY), nextDay(LAST_DAY)));
  });

  it('one occurrence moved to another day', async () => {
    const loaded = await createdSeries();
    const item = await edited(loaded, loaded.res.event_id, {
      edit_scope: 'this_only', recurrence_id: `${SPLIT_DAY}T00:00:00`, start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${nextDay(MOVED_DAY)}T00:00:00`,
    });
    const changed = item.recurrenceInfo.getExceptionIds().map((rid) => item.recurrenceInfo.getExceptionFor(rid));
    expect(changed).toHaveLength(1);
    guardLength(changed, 1);
    expect(dayOf(changed[0].recurrenceId)).toBe(SPLIT_DAY);
    expectAllDay(changed[0].startDate, MOVED_DAY);
    expectAllDay(changed[0].endDate, nextDay(MOVED_DAY));
  });

  it('"this and following" with a new start: the following part stays all-day and keeps its days', async () => {
    const loaded = await createdSeries();
    const res = await loaded.api.modifyCalendarEvent({
      event_id: loaded.res.event_id, calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: `${SPLIT_DAY}T00:00:00`,
      start_iso: `${nextDay(SPLIT_DAY)}T00:00:00`,
    });
    expect(res).toMatchObject({ ok: true });
    const capped = loaded.calendar.items.find((it) => it.id === loaded.res.event_id);
    const fresh = loaded.calendar.items.find((it) => it.id !== loaded.res.event_id);
    expectAllDay(fresh.startDate, nextDay(SPLIT_DAY));
    expectAllDay(fresh.endDate, nextDay(nextDay(SPLIT_DAY)));
    expect(occurrenceDays(capped)).toEqual(daysFrom(START_DAY, '2099-10-14'));
    expect(occurrenceDays(fresh)).toEqual(daysFrom(nextDay(SPLIT_DAY), nextDay(LAST_DAY)));
  });
});

describe('the kind changes only when the edit gives all_day', () => {
  it('a timed event edited without all_day stays timed', async () => {
    const ev = fakeEvent({ id: 'evt', title: 'Talk', startDate: fakeDateTime(START_DAY, 17), endDate: fakeDateTime(START_DAY, 18) });
    const item = await edited(loadCalendarBridge(bridgeUrl, { items: [ev] }), 'evt', { start_iso: `${MOVED_DAY}T09:00:00` });
    expectTimed(item.startDate, MOVED_DAY, 9);
    expectTimed(item.endDate, MOVED_DAY, 10);
  });

  it('a timed event edited at midnight without all_day stays timed', async () => {
    const ev = fakeEvent({ id: 'evt', title: 'Talk', startDate: fakeDateTime(START_DAY, 17), endDate: fakeDateTime(START_DAY, 18) });
    const item = await edited(loadCalendarBridge(bridgeUrl, { items: [ev] }), 'evt', { start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${MOVED_DAY}T01:00:00` });
    expectTimed(item.startDate, MOVED_DAY, 0);
    expectTimed(item.endDate, MOVED_DAY, 1);
  });

  it('all_day: false makes an all-day event timed', async () => {
    const loaded = await created();
    const item = await edited(loaded, loaded.res.event_id, { all_day: false, start_iso: `${MOVED_DAY}T09:00:00`, end_iso: `${MOVED_DAY}T10:00:00` });
    expectTimed(item.startDate, MOVED_DAY, 9);
    expectTimed(item.endDate, MOVED_DAY, 10);
  });

  it('all_day: true with a time of day keeps the date, all-day', async () => {
    const loaded = await created();
    const item = await edited(loaded, loaded.res.event_id, { all_day: true, start_iso: `${MOVED_DAY}T15:00:00` });
    expectAllDay(item.startDate, MOVED_DAY);
    expectAllDay(item.endDate, nextDay(MOVED_DAY));
  });

  it('all_day: true makes a timed event all-day', async () => {
    const ev = fakeEvent({ id: 'evt', title: 'Talk', startDate: fakeDateTime(START_DAY, 17), endDate: fakeDateTime(START_DAY, 18) });
    const item = await edited(loadCalendarBridge(bridgeUrl, { items: [ev] }), 'evt', { all_day: true, start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${nextDay(MOVED_DAY)}T00:00:00` });
    expectAllDay(item.startDate, MOVED_DAY);
    expectAllDay(item.endDate, nextDay(MOVED_DAY));
  });
});

// A time of day for an all-day event, without all_day, could mean a timed event
// or that date all day: the edit is refused before anything is written, and the
// assistant is told to ask the user which. A date at midnight is a date.
describe('an all-day event given a time of day without all_day is refused, asking the user', () => {
  const REFUSAL = /all-day event.*time of day without all_day.*Ask the user.*stay all-day.*all_day: false/;

  async function refused(loaded, fields) {
    const res = await loaded.api.modifyCalendarEvent({ event_id: loaded.res.event_id, calendar_id: 'cal1', ...fields });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(REFUSAL);
    expect(loaded.modifications).toEqual([]);
    return res;
  }

  it('a new start with a time of day', async () => {
    const loaded = await created();
    await refused(loaded, { start_iso: `${MOVED_DAY}T15:00:00` });
    expectAllDay(loaded.calendar.items[0].startDate, START_DAY);
    expectAllDay(loaded.calendar.items[0].endDate, nextDay(START_DAY));
  });

  it('a new end alone with a time of day', async () => {
    const loaded = await created();
    await refused(loaded, { end_iso: `${MOVED_DAY}T17:30:00` });
    expectAllDay(loaded.calendar.items[0].startDate, START_DAY);
  });

  it('a date start and an end with a time of day', async () => {
    const loaded = await created();
    await refused(loaded, { start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${MOVED_DAY}T00:30` });
  });

  it('times of one day', async () => {
    const loaded = await created();
    await refused(loaded, { start_iso: `${MOVED_DAY}T09:00:00`, end_iso: `${MOVED_DAY}T17:00:00` });
  });

  it('a whole series given a time of day: its days stay', async () => {
    const loaded = await createdSeries();
    await refused(loaded, { start_iso: `${nextDay(START_DAY)}T09:00:00` });
    expect(occurrenceDays(loaded.calendar.items[0])).toEqual(daysFrom(START_DAY, LAST_DAY));
  });

  it('"this and following" with times of one day: nothing is written', async () => {
    const loaded = await createdSeries();
    await refused(loaded, {
      edit_scope: 'this_and_following', recurrence_id: `${SPLIT_DAY}T00:00:00`, start_iso: `${SPLIT_DAY}T09:00:00`, end_iso: `${SPLIT_DAY}T17:00:00`,
    });
    expect(loaded.calendar.items).toHaveLength(1);
    expect(occurrenceDays(loaded.calendar.items[0])).toEqual(daysFrom(START_DAY, LAST_DAY));
  });

  it('one occurrence given a time of day: nothing is written', async () => {
    const loaded = await createdSeries();
    await refused(loaded, {
      edit_scope: 'this_only', recurrence_id: `${SPLIT_DAY}T00:00:00`, start_iso: `${MOVED_DAY}T09:00:00`,
    });
    const [item] = loaded.calendar.items;
    expect(item.recurrenceInfo.getExceptionIds()).toEqual([]);
    expect(occurrenceDays(item)).toEqual(daysFrom(START_DAY, LAST_DAY));
  });

  it('a check before the confirmation card gives the same refusals and writes nothing', async () => {
    const loaded = await created();
    await refused(loaded, { start_iso: `${MOVED_DAY}T15:00:00`, check_only: true });
    const series = await createdSeries();
    await refused(series, {
      edit_scope: 'this_and_following', recurrence_id: `${SPLIT_DAY}T00:00:00`, start_iso: `${SPLIT_DAY}T09:00:00`, check_only: true,
    });
  });

  it('a check of an edit that would be written passes and writes nothing: whole event, one occurrence, a split', async () => {
    const loaded = await createdSeries();
    const moved = { start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${nextDay(MOVED_DAY)}T00:00:00`, check_only: true };
    for (const scope of [{}, { edit_scope: 'this_only', recurrence_id: `${SPLIT_DAY}T00:00:00` }, { edit_scope: 'this_and_following', recurrence_id: `${SPLIT_DAY}T00:00:00` }]) {
      const res = await loaded.api.modifyCalendarEvent({ event_id: loaded.res.event_id, calendar_id: 'cal1', ...scope, ...moved });
      expect(res).toMatchObject({ ok: true, changes: true });
    }
    expect(loaded.modifications).toEqual([]);
    expect(loaded.calendar.items).toHaveLength(1);
    expectAllDay(loaded.calendar.items[0].startDate, START_DAY);
    expect(occurrenceDays(loaded.calendar.items[0])).toEqual(daysFrom(START_DAY, LAST_DAY));
  });

  it('a date at midnight, with or without seconds, is a date', async () => {
    const loaded = await created();
    const item = await edited(loaded, loaded.res.event_id, { start_iso: `${MOVED_DAY}T00:00`, end_iso: `${nextDay(MOVED_DAY)}T00:00:00` });
    expectAllDay(item.startDate, MOVED_DAY);
    expectAllDay(item.endDate, nextDay(MOVED_DAY));
  });
});

// An all-day end is the day after the last day, so an end on or before the
// start would make the event zero-length: the edit is refused before anything
// is written, and the assistant is told to ask the user how many days it lasts.
describe('an edit that would end an all-day event on or before its start is refused', () => {
  const REFUSAL = /all-day event.*end_iso is the day after its last day.*Ask the user how many days.*all_day: false/;

  it('dates of one day, without all_day', async () => {
    const loaded = await created();
    const res = await loaded.api.modifyCalendarEvent({
      event_id: loaded.res.event_id, calendar_id: 'cal1', start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${MOVED_DAY}T00:00:00`,
    });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(REFUSAL);
    expect(loaded.modifications).toEqual([]);
    expectAllDay(loaded.calendar.items[0].startDate, START_DAY);
    expectAllDay(loaded.calendar.items[0].endDate, nextDay(START_DAY));
  });

  it('all_day: true with the end on the start\'s day', async () => {
    const ev = fakeEvent({ id: 'evt', title: 'Talk', startDate: fakeDateTime(START_DAY, 17), endDate: fakeDateTime(START_DAY, 18) });
    const loaded = loadCalendarBridge(bridgeUrl, { items: [ev] });
    const res = await loaded.api.modifyCalendarEvent({
      event_id: 'evt', calendar_id: 'cal1', all_day: true, start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${MOVED_DAY}T00:00:00`,
    });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(REFUSAL);
    expect(loaded.modifications).toEqual([]);
  });

  it('"this and following" with dates of one day: nothing is written', async () => {
    const loaded = await createdSeries();
    const res = await loaded.api.modifyCalendarEvent({
      event_id: loaded.res.event_id, calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: `${SPLIT_DAY}T00:00:00`,
      start_iso: `${SPLIT_DAY}T00:00:00`, end_iso: `${SPLIT_DAY}T00:00:00`,
    });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(REFUSAL);
    expect(loaded.modifications).toEqual([]);
    expect(loaded.calendar.items).toHaveLength(1);
    expect(occurrenceDays(loaded.calendar.items[0])).toEqual(daysFrom(START_DAY, LAST_DAY));
  });

  it('a new start alone, past the end of an event stored with its end on its start', async () => {
    const ev = fakeEvent({ id: 'evt', title: 'Holiday', startDate: fakeDate(START_DAY), endDate: fakeDate(START_DAY) });
    const loaded = loadCalendarBridge(bridgeUrl, { items: [ev] });
    const res = await loaded.api.modifyCalendarEvent({ event_id: 'evt', calendar_id: 'cal1', start_iso: `${MOVED_DAY}T00:00:00` });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(REFUSAL);
    expect(loaded.modifications).toEqual([]);
  });

  it('one occurrence given dates of one day: nothing is written', async () => {
    const loaded = await createdSeries();
    const res = await loaded.api.modifyCalendarEvent({
      event_id: loaded.res.event_id, calendar_id: 'cal1', edit_scope: 'this_only', recurrence_id: `${SPLIT_DAY}T00:00:00`,
      start_iso: `${MOVED_DAY}T00:00:00`, end_iso: `${MOVED_DAY}T00:00:00`,
    });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(REFUSAL);
    expect(loaded.modifications).toEqual([]);
    const [item] = loaded.calendar.items;
    expect(item.recurrenceInfo.getExceptionIds()).toEqual([]);
    expect(occurrenceDays(item)).toEqual(daysFrom(START_DAY, LAST_DAY));
  });

  it('a timed event given an end on its start is not refused', async () => {
    const ev = fakeEvent({ id: 'evt', title: 'Talk', startDate: fakeDateTime(START_DAY, 17), endDate: fakeDateTime(START_DAY, 18) });
    const item = await edited(loadCalendarBridge(bridgeUrl, { items: [ev] }), 'evt', { start_iso: `${MOVED_DAY}T09:00:00`, end_iso: `${MOVED_DAY}T09:00:00` });
    expectTimed(item.startDate, MOVED_DAY, 9);
    expectTimed(item.endDate, MOVED_DAY, 9);
  });

  it('an edit giving no times still saves an all-day event stored with its end on its start', async () => {
    const ev = fakeEvent({ id: 'evt', title: 'Holiday', startDate: fakeDate(START_DAY), endDate: fakeDate(START_DAY) });
    const item = await edited(loadCalendarBridge(bridgeUrl, { items: [ev] }), 'evt', { title: 'Renamed' });
    expect(item.title).toBe('Renamed');
  });
});
