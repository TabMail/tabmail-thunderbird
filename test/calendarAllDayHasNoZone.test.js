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
//     refused and keeps every occurrence on one side or the other.

// West of UTC, where a zoned DATE's midnight is after the same day's UTC one.
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
const AFTER_LAST_DAY = '2099-11-05';
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

// The days a series has occurrences on, as Thunderbird expands it.
const occurrenceDays = (item) => seriesOccurrences(item, fakeDate(START_DAY), fakeDate(AFTER_LAST_DAY))
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
    const { item } = await created({ timezone: 'America/New_York' });
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

function guardLength(list, n) {
  if (list.length !== n) throw new Error(`expected ${n} items, got ${list.length}`);
}
