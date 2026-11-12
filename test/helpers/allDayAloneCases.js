/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The cases of calendarAllDayAlone{West,East}.test.js: an edit that gives
// `all_day` and no start or end, through the real edit tool, card states and
// bridge on Thunderbird's own dates (seriesEditFlow.js), the user and every
// event in `userTzid`. The test file mocks the chat modules and sets
// process.env.TZ to `userTzid` first, then imports this module.
//
// The invariant (both directions, a one-off event and a series edited as a
// whole, one occurrence, and from an occurrence on): an `all_day` that differs
// from the stored kind either changes the stored kind of what the edit covers,
// or is refused before the card with nothing written. It never reports success
// with the event unchanged, and a split never leaves two series of the same
// content. The assertion is that disjunction, so it holds whether the fix
// refuses the edit or derives the new dates from the stored ones.
//
// One rule for every scope: a change to timed that gives a start and no end is
// the same defect. It is refused before the card, or the end is the start plus
// one hour (Google Calendar's default length); never a timed event that keeps
// the all-day length (24 hours).

import { describe, it, expect } from 'vitest';
import { onCalendar, seriesOf, edit, iso, occurrencesOf, clockDiff } from './seriesEditFlow.js';
import { at, dateOn, digits } from './nativeCalendarDates.js';
import { fakeEvent, fakeRecurrenceInfo, recurrenceItem } from './calendarBridgeHarness.js';

const NOTHING_CHANGED = 'Nothing changed: the event already has every time and value this edit gives, so nothing was written and no confirmation was shown.';

const FIRST_DAY = '2099-01-10';
const NAMED_DAY = '2099-01-13';
const RULE = 'FREQ=DAILY;COUNT=10';
const WINDOW = ['2099-01-01', '2099-02-01'];
// The length of a timed event made from an all-day one with a start only, as
// Google Calendar gives a new event: one hour.
const ONE_HOUR = 3600;
const ALL_DAY_LENGTH = 86400;

/** The four stored events, in `tzid`: a one-off and a series, timed and all-day. */
function fixtures(tzid) {
  const allDaySeries = () => {
    const ev = fakeEvent({ id: 'ser', title: 'Retreat', startDate: dateOn(FIRST_DAY), endDate: dateOn('2099-01-11') });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', RULE)]);
    ev.recurrenceInfo.item = ev;
    return ev;
  };
  return {
    timedOne: () => fakeEvent({ id: 'one', title: 'Review', startDate: at(tzid, FIRST_DAY, 10), endDate: at(tzid, FIRST_DAY, 11) }),
    allDayOne: () => fakeEvent({ id: 'one', title: 'Holiday', startDate: dateOn(FIRST_DAY), endDate: dateOn('2099-01-11') }),
    timedSeries: () => seriesOf({ tzid, day: FIRST_DAY, hour: 10, rule: RULE }),
    allDaySeries,
  };
}

/**
 * Every occurrence the stored items make in the window, in day order: its day
 * (the start's digits, in the user's zone or a DATE's own), its start's and
 * end's kinds and its wall-clock length. A one-off event is its own one row.
 */
function table(items) {
  const rows = [];
  for (const it of items) {
    if (it.recurrenceInfo) {
      for (const o of occurrencesOf(it, ...WINDOW)) {
        rows.push({ day: o.start.slice(0, 10), clock: o.start.slice(11), isDate: o.isDate, endIsDate: !!o.occ.endDate.isDate, length: clockDiff(o.end, o.start) });
      }
    } else {
      const s = digits(it.startDate), e = digits(it.endDate);
      rows.push({ day: s.slice(0, 10), clock: s.slice(11), isDate: !!it.startDate.isDate, endIsDate: !!it.endDate.isDate, length: clockDiff(e, s) });
    }
  }
  return rows.sort((a, b) => a.day.localeCompare(b.day) || Number(a.isDate) - Number(b.isDate));
}

/**
 * Runs `args` on `items` and checks the invariant. `covers(day)` says which
 * occurrences the edit covers; `toAllDay` the kind it asks for; `startClock`,
 * for a change to timed given a start only, the clock time ("HH:MM:SS") each
 * covered occurrence then starts at, lasting one hour.
 */
async function kindChangedOrRefused(userTzid, items, args, { toAllDay, covers, startClock = null }) {
  const loaded = onCalendar(items, userTzid);
  const ids = loaded.calendar.items.map((it) => it.id);
  const before = table(loaded.calendar.items);
  expect(before.length, 'fixture').toBeGreaterThan(0);
  expect(before.every((r) => r.isDate === !toAllDay), 'fixture: the stored kind differs from the one asked').toBe(true);

  const run = await edit({ ...args, all_day: toAllDay });
  const after = table(loaded.calendar.items);
  const stored = loaded.calendar.items;

  // Never two series of the same content: a split's parts differ in kind.
  if (stored.length === 2) {
    expect(!!stored[0].startDate.isDate, 'a split must not leave two series of the same kind (identical parts)').not.toBe(!!stored[1].startDate.isDate);
  }

  const refusedBeforeCard = run.card === null && run.result?.ok === false;
  if (refusedBeforeCard) {
    // Refused before the card: nothing written, every occurrence as stored.
    expect(run.state).toBe('exec_fail');
    expect(run.failReason, 'the assistant is told why').toBeTruthy();
    expect(loaded.modifications).toHaveLength(0);
    expect(stored.map((it) => it.id)).toEqual(ids);
    expect(after).toEqual(before);
    return;
  }
  // Otherwise it is made, and the stored kind is the one asked.
  expect(run.result, 'an all_day that differs from the stored kind is never "Nothing changed"').not.toEqual({ ok: true, result: NOTHING_CHANGED });
  expect(run.card, 'made: through the card').toBeTruthy();
  expect(run.state, `made: ${run.failReason || ''}`).toBe('exec_success');
  expect(after.map((r) => r.day), 'every occurrence keeps its day; none lost or added').toEqual(before.map((r) => r.day));
  for (const r of after) {
    const want = covers(r.day) ? toAllDay : !toAllDay;
    expect(r.isDate, `${r.day}: reported success, so the stored kind must be ${want ? 'all-day' : 'timed'} (or the edit refused before the card)`).toBe(want);
    expect(r.endIsDate, `${r.day}: start and end of one kind`).toBe(r.isDate);
    expect(r.length, `${r.day}: ends after it starts`).toBeGreaterThan(0);
    if (startClock && covers(r.day)) {
      expect(r.length, `${r.day}: a change to timed with a start only never keeps the all-day length`).not.toBe(ALL_DAY_LENGTH);
      expect(r.clock, `${r.day}: starts at the start given`).toBe(startClock);
      expect(r.length, `${r.day}: a start only, no end: the end is the start plus one hour (or the edit refused before the card)`).toBe(ONE_HOUR);
    }
  }
}

/** "Nothing changed": no card, no write, no split. */
async function nothingChanged(userTzid, items, args) {
  const loaded = onCalendar(items, userTzid);
  const before = table(loaded.calendar.items);
  const run = await edit(args);
  expect(run.failReason).toBeUndefined();
  expect(run.card).toBeNull();
  expect(run.result).toEqual({ ok: true, result: NOTHING_CHANGED });
  expect(loaded.modifications).toHaveLength(0);
  expect(loaded.calendar.items).toHaveLength(1);
  expect(table(loaded.calendar.items)).toEqual(before);
}

export function defineAllDayAloneSuite(userTzid) {
  const f = fixtures(userTzid);
  const all = () => true;
  const named = (day) => day === NAMED_DAY;
  const fromNamed = (day) => day >= NAMED_DAY;
  const timedRid = iso(NAMED_DAY, 10);
  const allDayRid = NAMED_DAY;

  describe(`${userTzid}: all_day alone, other than the stored kind, changes the kind or is refused before the card`, () => {
    it('timed one-off made all-day', async () => {
      await kindChangedOrRefused(userTzid, [f.timedOne()], { event_id: 'one' }, { toAllDay: true, covers: all });
    });
    it('all-day one-off made timed', async () => {
      await kindChangedOrRefused(userTzid, [f.allDayOne()], { event_id: 'one' }, { toAllDay: false, covers: all });
    });
    it('timed series made all-day, edit_scope all', async () => {
      await kindChangedOrRefused(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'all' }, { toAllDay: true, covers: all });
    });
    it('all-day series made timed, edit_scope all', async () => {
      await kindChangedOrRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'all' }, { toAllDay: false, covers: all });
    });
    it('timed series, one occurrence made all-day, edit_scope this_only', async () => {
      await kindChangedOrRefused(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'this_only', recurrence_id: timedRid }, { toAllDay: true, covers: named });
    });
    it('all-day series, one occurrence made timed, edit_scope this_only', async () => {
      await kindChangedOrRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_only', recurrence_id: allDayRid }, { toAllDay: false, covers: named });
    });
    it('timed series made all-day from an occurrence on, edit_scope this_and_following', async () => {
      await kindChangedOrRefused(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: timedRid }, { toAllDay: true, covers: fromNamed });
    });
    it('all-day series made timed from an occurrence on, edit_scope this_and_following', async () => {
      await kindChangedOrRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: allDayRid }, { toAllDay: false, covers: fromNamed });
    });
  });

  describe(`${userTzid}: all_day: false with a start only, on an all-day event, is made timed for one hour or refused before the card`, () => {
    // kindChangedOrRefused adds all_day: false.
    const at9 = (day) => ({ start_iso: iso(day, 9) });
    const asked = { toAllDay: false, startClock: '09:00:00' };
    it('one-off', async () => {
      await kindChangedOrRefused(userTzid, [f.allDayOne()], { event_id: 'one', ...at9(FIRST_DAY) }, { ...asked, covers: all });
    });
    it('series, edit_scope all', async () => {
      await kindChangedOrRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'all', ...at9(FIRST_DAY) }, { ...asked, covers: all });
    });
    it('series, one occurrence, edit_scope this_only', async () => {
      await kindChangedOrRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_only', recurrence_id: allDayRid, ...at9(NAMED_DAY) }, { ...asked, covers: named });
    });
    it('series, from an occurrence on, edit_scope this_and_following', async () => {
      await kindChangedOrRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: allDayRid, ...at9(NAMED_DAY) }, { ...asked, covers: fromNamed });
    });
  });

  describe(`${userTzid}: all_day alone, equal to the stored kind, is "Nothing changed"`, () => {
    it('one-off, timed and all-day', async () => {
      await nothingChanged(userTzid, [f.timedOne()], { event_id: 'one', all_day: false });
      await nothingChanged(userTzid, [f.allDayOne()], { event_id: 'one', all_day: true });
    });
    it('timed series: all, this_only and this_and_following (no split)', async () => {
      await nothingChanged(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'all', all_day: false });
      await nothingChanged(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'this_only', recurrence_id: timedRid, all_day: false });
      await nothingChanged(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: timedRid, all_day: false });
    });
    it('all-day series: all, this_only and this_and_following (no split)', async () => {
      await nothingChanged(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'all', all_day: true });
      await nothingChanged(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_only', recurrence_id: allDayRid, all_day: true });
      await nothingChanged(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: allDayRid, all_day: true });
    });
  });
}
