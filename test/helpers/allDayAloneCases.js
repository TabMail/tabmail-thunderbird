/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The cases of calendarAllDayAlone{West,East}.test.js: an edit that asks for
// a kind (`all_day`) other than the stored one, through the real edit tool,
// card states and bridge on Thunderbird's own dates (seriesEditFlow.js), the
// user and every event in `userTzid`. The test file mocks the chat modules and
// sets process.env.TZ to `userTzid` first, then imports this module.
//
// The rule, on every scope (a one-off event, and a series edited as a whole,
// one occurrence, and from an occurrence on): a change of kind comes with both
// start_iso and end_iso, or it is refused before the confirmation card with
// nothing written, and the assistant is told to give both (an all-day end is
// the day after the last day). Before, all_day alone showed the change on the
// card, wrote nothing and reported success (from an occurrence on, it split the
// series into two identical parts), and a change to timed with a start only
// kept the all-day length as a 24-hour timed event.
//
// Two guards hold whatever the outcome: an edit that reports success has
// changed what is stored, and a split never leaves two parts of the same kind.
// An all_day equal to the stored kind is "Nothing changed".

import { describe, it, expect } from 'vitest';
import { onCalendar, seriesOf, edit, iso, occurrencesOf, clockDiff, timeChange } from './seriesEditFlow.js';
import { at, dateOn, digits } from './nativeCalendarDates.js';
import { fakeEvent, fakeRecurrenceInfo, recurrenceItem } from './calendarBridgeHarness.js';

const NOTHING_CHANGED = 'Nothing changed: the event already has every time and value this edit gives, so nothing was written and no confirmation was shown.';

const FIRST_DAY = '2099-01-10';
const NAMED_DAY = '2099-01-13';
const RULE = 'FREQ=DAILY;COUNT=10';
const WINDOW = ['2099-01-01', '2099-02-01'];

/** `day` ("YYYY-MM-DD") plus one day. */
function dayAfter(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The stored events, in `tzid`: a one-off and a series, timed and all-day. */
function fixtures(tzid) {
  const allDaySeries = () => {
    const ev = fakeEvent({ id: 'ser', title: 'Retreat', startDate: dateOn(FIRST_DAY), endDate: dateOn('2099-01-11') });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', RULE)]);
    ev.recurrenceInfo.item = ev;
    return ev;
  };
  // A series with one occurrence (on `day`) changed on its own to the other
  // kind: a timed series' occurrence made all-day, an all-day series' made
  // timed (10:00 to 11:00).
  const timedSeriesWithAllDayOn = (day) => seriesOf({ tzid, day: FIRST_DAY, hour: 10, rule: RULE, changed: [{ rid: at(tzid, day, 10), start: dateOn(day), end: dateOn(dayAfter(day)) }] });
  const allDaySeriesWithTimedOn = (day) => {
    const ev = allDaySeries();
    const ex = fakeEvent({ id: 'ser', title: 'Retreat', startDate: at(tzid, day, 10), endDate: at(tzid, day, 11), recurrenceId: dateOn(day) });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', RULE)], { exceptions: [ex] });
    ev.recurrenceInfo.item = ev;
    return ev;
  };
  // A series with one occurrence (on `day`) changed on its own and kept of
  // the series' kind: a timed one moved to 14:00-14:30, an all-day one made
  // two days long.
  const timedSeriesMovedOn = (day) => seriesOf({ tzid, day: FIRST_DAY, hour: 10, rule: RULE, changed: [{ rid: at(tzid, day, 10), start: at(tzid, day, 14), end: at(tzid, day, 14, 30) }] });
  const allDaySeriesLongerOn = (day) => {
    const ev = allDaySeries();
    const ex = fakeEvent({ id: 'ser', title: 'Retreat', startDate: dateOn(day), endDate: dateOn(dayAfter(dayAfter(day))), recurrenceId: dateOn(day) });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', RULE)], { exceptions: [ex] });
    ev.recurrenceInfo.item = ev;
    return ev;
  };
  return {
    timedSeriesMovedOn,
    allDaySeriesLongerOn,
    timedSeriesWithAllDayOn,
    allDaySeriesWithTimedOn,
    // A timed event from midnight to the next midnight: made all-day on its
    // own day, its printed start and end do not change, only its kind.
    midnightOne: () => fakeEvent({ id: 'one', title: 'Offsite', startDate: at(tzid, FIRST_DAY, 0), endDate: at(tzid, dayAfter(FIRST_DAY), 0) }),
    timedOne: () => fakeEvent({ id: 'one', title: 'Review', startDate: at(tzid, FIRST_DAY, 10), endDate: at(tzid, FIRST_DAY, 11) }),
    allDayOne: () => fakeEvent({ id: 'one', title: 'Holiday', startDate: dateOn(FIRST_DAY), endDate: dateOn('2099-01-11') }),
    timedSeries: () => seriesOf({ tzid, day: FIRST_DAY, hour: 10, rule: RULE }),
    allDaySeries,
  };
}

/**
 * Every occurrence the stored items make in the window, in day order: its day
 * and clock time (the start's digits, in the user's zone or a DATE's own), its
 * start's and end's kinds and its wall-clock length. A one-off event is its
 * own one row.
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
 * Runs a change of kind given without both times (`args` plus all_day:
 * `toAllDay`) and asserts it is refused before the card with nothing written,
 * the assistant told to give both start_iso and end_iso.
 */
async function kindChangeRefused(userTzid, items, args, { toAllDay, onlyNamedDiffers = false }) {
  const loaded = onCalendar(items, userTzid);
  const ids = loaded.calendar.items.map((it) => it.id);
  const before = table(loaded.calendar.items);
  expect(before.length, 'fixture').toBeGreaterThan(0);
  // `onlyNamedDiffers`: the series is of the kind asked; only the occurrence
  // the edit names (changed on its own) is of the other kind.
  expect(!!loaded.calendar.items[0].startDate.isDate, 'fixture: the stored kind against the one asked').toBe(onlyNamedDiffers ? toAllDay : !toAllDay);
  if (onlyNamedDiffers) {
    expect(before.filter((r) => r.isDate !== toAllDay), 'fixture: one occurrence of the other kind').toHaveLength(1);
  }

  const run = await edit({ ...args, all_day: toAllDay });
  const after = table(loaded.calendar.items);
  const stored = loaded.calendar.items;

  // Guards: never success with nothing changed, never two parts of one kind.
  if (run.result?.ok) {
    expect(run.result, 'a change of kind is never "Nothing changed"').not.toEqual({ ok: true, result: NOTHING_CHANGED });
    expect(after, 'an edit that reports success has changed what is stored').not.toEqual(before);
  }
  if (stored.length === 2) {
    expect(!!stored[0].startDate.isDate, 'a split must not leave two parts of the same kind (identical parts)').not.toBe(!!stored[1].startDate.isDate);
  }

  // Refused before the card, nothing written, every occurrence as stored.
  expect(run.card, 'refused before the card').toBeNull();
  expect(run.state).toBe('exec_fail');
  expect(run.result).toMatchObject({ ok: false });
  expect(run.failReason).toContain('needs both start_iso and end_iso');
  expect(run.failReason).toContain('end_iso is the day after its last day');
  expect(loaded.modifications).toHaveLength(0);
  expect(stored.map((it) => it.id)).toEqual(ids);
  expect(after).toEqual(before);
}

/**
 * A change of kind with both times is made: every occurrence `covers(day)`
 * names has the new kind and the others keep theirs, none lost or added.
 */
async function kindChangeMade(userTzid, items, args, { toAllDay, covers, clock = null, length = null, timesOn = covers }) {
  const loaded = onCalendar(items, userTzid);
  const before = table(loaded.calendar.items);
  expect(before.length, 'fixture').toBeGreaterThan(0);
  const run = await edit({ ...args, all_day: toAllDay });
  expect(run.result, 'a change of kind is never "Nothing changed"').not.toEqual({ ok: true, result: NOTHING_CHANGED });
  expect(run.failReason).toBeUndefined();
  expect(run.card).toBeTruthy();
  expect(run.state).toBe('exec_success');
  const after = table(loaded.calendar.items);
  expect(after.map((r) => r.day)).toEqual(before.map((r) => r.day));
  for (const r of after) {
    expect(r.isDate, r.day).toBe(covers(r.day) ? toAllDay : !toAllDay);
    expect(r.endIsDate, r.day).toBe(r.isDate);
    expect(r.length, r.day).toBeGreaterThan(0);
    // The times given, on every occurrence the edit covers.
    if (timesOn(r.day) && clock !== null) expect(r.clock, r.day).toBe(clock);
    if (timesOn(r.day) && length !== null) expect(r.length, r.day).toBe(length);
  }
  return run;
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
  const timedRid = iso(NAMED_DAY, 10);
  const allDayRid = NAMED_DAY;

  describe(`${userTzid}: all_day alone, other than the stored kind, is refused before the card`, () => {
    it('timed one-off made all-day', async () => {
      await kindChangeRefused(userTzid, [f.timedOne()], { event_id: 'one' }, { toAllDay: true });
    });
    it('all-day one-off made timed', async () => {
      await kindChangeRefused(userTzid, [f.allDayOne()], { event_id: 'one' }, { toAllDay: false });
    });
    it('timed series made all-day, edit_scope all', async () => {
      await kindChangeRefused(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'all' }, { toAllDay: true });
    });
    it('all-day series made timed, edit_scope all', async () => {
      await kindChangeRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'all' }, { toAllDay: false });
    });
    it('timed series, one occurrence made all-day, edit_scope this_only', async () => {
      await kindChangeRefused(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'this_only', recurrence_id: timedRid }, { toAllDay: true });
    });
    it('all-day series, one occurrence made timed, edit_scope this_only', async () => {
      await kindChangeRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_only', recurrence_id: allDayRid }, { toAllDay: false });
    });
    it('timed series made all-day from an occurrence on, edit_scope this_and_following: no split', async () => {
      await kindChangeRefused(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: timedRid }, { toAllDay: true });
    });
    it('all-day series made timed from an occurrence on, edit_scope this_and_following: no split', async () => {
      await kindChangeRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: allDayRid }, { toAllDay: false });
    });
  });

  describe(`${userTzid}: a change of kind with one time only is refused before the card, never a 24-hour timed event`, () => {
    const at9 = (day) => ({ start_iso: iso(day, 9) });
    it('all-day one-off made timed, start only', async () => {
      await kindChangeRefused(userTzid, [f.allDayOne()], { event_id: 'one', ...at9(FIRST_DAY) }, { toAllDay: false });
    });
    it('all-day series made timed, start only, edit_scope all', async () => {
      await kindChangeRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'all', ...at9(FIRST_DAY) }, { toAllDay: false });
    });
    it('all-day series, one occurrence made timed, start only, edit_scope this_only', async () => {
      await kindChangeRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_only', recurrence_id: allDayRid, ...at9(NAMED_DAY) }, { toAllDay: false });
    });
    it('all-day series made timed from an occurrence on, start only, edit_scope this_and_following', async () => {
      await kindChangeRefused(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: allDayRid, ...at9(NAMED_DAY) }, { toAllDay: false });
    });
    it('timed one-off made all-day, start only and end only', async () => {
      await kindChangeRefused(userTzid, [f.timedOne()], { event_id: 'one', start_iso: FIRST_DAY }, { toAllDay: true });
      await kindChangeRefused(userTzid, [f.timedOne()], { event_id: 'one', end_iso: '2099-01-11' }, { toAllDay: true });
    });
    it('timed series made all-day from an occurrence on, end only, edit_scope this_and_following', async () => {
      await kindChangeRefused(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: timedRid, end_iso: '2099-01-14' }, { toAllDay: true });
    });
  });

  describe(`${userTzid}: a change of kind with both times is made (controls)`, () => {
    it('all-day one-off made timed', async () => {
      await kindChangeMade(userTzid, [f.allDayOne()], { event_id: 'one', start_iso: iso(FIRST_DAY, 9), end_iso: iso(FIRST_DAY, 10) }, { toAllDay: false, covers: all });
    });
    it('timed one-off made all-day', async () => {
      await kindChangeMade(userTzid, [f.timedOne()], { event_id: 'one', start_iso: FIRST_DAY, end_iso: '2099-01-11' }, { toAllDay: true, covers: all });
    });
    it('all-day series, one occurrence made timed, edit_scope this_only', async () => {
      await kindChangeMade(userTzid, [f.allDaySeries()], { event_id: 'ser', edit_scope: 'this_only', recurrence_id: allDayRid, start_iso: iso(NAMED_DAY, 9), end_iso: iso(NAMED_DAY, 10) }, { toAllDay: false, covers: named });
    });
  });

  describe(`${userTzid}: a change of kind given at an occurrence already of that kind, with its own dates, changes the series`, () => {
    // The occurrence the edit names was changed on its own to the kind asked;
    // the edit gives that occurrence's own dates. Every other occurrence it
    // covers takes the new kind (never "Nothing changed").
    const from = (day) => day >= NAMED_DAY;
    const allDayAt = { start_iso: NAMED_DAY, end_iso: dayAfter(NAMED_DAY) };
    const timedAt = { start_iso: iso(NAMED_DAY, 10), end_iso: iso(NAMED_DAY, 11) };
    it('timed series made all-day from an occurrence made all-day on its own, edit_scope this_and_following', async () => {
      await kindChangeMade(userTzid, [f.timedSeriesWithAllDayOn(NAMED_DAY)], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: NAMED_DAY, ...allDayAt }, { toAllDay: true, covers: from });
    });
    it('all-day series made timed from an occurrence made timed on its own, edit_scope this_and_following', async () => {
      await kindChangeMade(userTzid, [f.allDaySeriesWithTimedOn(NAMED_DAY)], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso(NAMED_DAY, 10), ...timedAt }, { toAllDay: false, covers: from });
    });
    it('timed series, edit_scope all named there: routed to from that occurrence on', async () => {
      await kindChangeMade(userTzid, [f.timedSeriesWithAllDayOn(NAMED_DAY)], { event_id: 'ser', edit_scope: 'all', recurrence_id: NAMED_DAY, ...allDayAt }, { toAllDay: true, covers: from });
    });
    it('all-day series, edit_scope all named there: routed to from that occurrence on', async () => {
      await kindChangeMade(userTzid, [f.allDaySeriesWithTimedOn(NAMED_DAY)], { event_id: 'ser', edit_scope: 'all', recurrence_id: iso(NAMED_DAY, 10), ...timedAt }, { toAllDay: false, covers: from });
    });
    it('timed series made all-day, edit_scope all, named at its first occurrence made all-day on its own', async () => {
      await kindChangeMade(userTzid, [f.timedSeriesWithAllDayOn(FIRST_DAY)], { event_id: 'ser', edit_scope: 'all', recurrence_id: FIRST_DAY, start_iso: FIRST_DAY, end_iso: dayAfter(FIRST_DAY) }, { toAllDay: true, covers: all });
    });
    it('all-day series made timed, edit_scope all, named at its first occurrence made timed on its own', async () => {
      await kindChangeMade(userTzid, [f.allDaySeriesWithTimedOn(FIRST_DAY)], { event_id: 'ser', edit_scope: 'all', recurrence_id: iso(FIRST_DAY, 10), start_iso: iso(FIRST_DAY, 10), end_iso: iso(FIRST_DAY, 11) }, { toAllDay: false, covers: all });
    });
    it('all_day alone there is refused before the card, both kinds', async () => {
      await kindChangeRefused(userTzid, [f.timedSeriesWithAllDayOn(NAMED_DAY)], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: NAMED_DAY }, { toAllDay: true });
      await kindChangeRefused(userTzid, [f.allDaySeriesWithTimedOn(NAMED_DAY)], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso(NAMED_DAY, 10) }, { toAllDay: false });
    });
  });

  describe(`${userTzid}: all_day alone, equal to the series' kind but not to the occurrence named (changed on its own), is refused before the card`, () => {
    // The user asks for that occurrence, and those after it, to take the
    // other kind: it needs both times, as every other change of kind does.
    const timedSeriesFrom = (day, scope) => kindChangeRefused(userTzid, [f.timedSeriesWithAllDayOn(day)], { event_id: 'ser', edit_scope: scope, recurrence_id: day }, { toAllDay: false, onlyNamedDiffers: true });
    const allDaySeriesFrom = (day, scope) => kindChangeRefused(userTzid, [f.allDaySeriesWithTimedOn(day)], { event_id: 'ser', edit_scope: scope, recurrence_id: iso(day, 10) }, { toAllDay: true, onlyNamedDiffers: true });
    it('timed series, all_day:false from an occurrence made all-day on its own, edit_scope this_and_following', async () => {
      await timedSeriesFrom(NAMED_DAY, 'this_and_following');
    });
    it('all-day series, all_day:true from an occurrence made timed on its own, edit_scope this_and_following', async () => {
      await allDaySeriesFrom(NAMED_DAY, 'this_and_following');
    });
  });

  describe(`${userTzid}: all_day of the series' kind, with times, at an occurrence made the other kind on its own, changes that occurrence's kind`, () => {
    // The kind changed is the named occurrence's: with both times the change
    // is made from it on (never "Nothing changed", and the card and the write
    // agree); a start alone is refused for both times, whatever its time.
    // Every occurrence ends of the series' kind; the times given hold from
    // the named one on.
    const from = { covers: all, timesOn: (day) => day >= NAMED_DAY };
    const HOUR = 3600, DAY = 86400;
    const timedFrom = (extra, day = NAMED_DAY, scope = 'this_and_following') => [[f.timedSeriesWithAllDayOn(day)], { event_id: 'ser', edit_scope: scope, recurrence_id: day, ...extra }];
    const allDayFrom = (extra, day = NAMED_DAY, scope = 'this_and_following') => [[f.allDaySeriesWithTimedOn(day)], { event_id: 'ser', edit_scope: scope, recurrence_id: iso(day, 10), ...extra }];
    it('(a) the series\' own times: timed from that occurrence on, at 10:00 for an hour', async () => {
      await kindChangeMade(userTzid, ...timedFrom({ start_iso: iso(NAMED_DAY, 10), end_iso: iso(NAMED_DAY, 11) }), { toAllDay: false, ...from, clock: '10:00:00', length: HOUR });
    });
    it('(a) mirror: the series\' own dates: all-day from that occurrence on, one day each', async () => {
      await kindChangeMade(userTzid, ...allDayFrom({ start_iso: NAMED_DAY, end_iso: dayAfter(NAMED_DAY) }), { toAllDay: true, ...from, clock: '00:00:00', length: DAY });
    });
    it('(a) edit_scope all named at a first occurrence made the other kind on its own, both kinds', async () => {
      await kindChangeMade(userTzid, ...timedFrom({ start_iso: iso(FIRST_DAY, 10), end_iso: iso(FIRST_DAY, 11) }, FIRST_DAY, 'all'), { toAllDay: false, covers: all, clock: '10:00:00', length: HOUR });
      await kindChangeMade(userTzid, ...allDayFrom({ start_iso: FIRST_DAY, end_iso: dayAfter(FIRST_DAY) }, FIRST_DAY, 'all'), { toAllDay: true, covers: all, clock: '00:00:00', length: DAY });
    });
    it('(b) a start alone at the series\' own time is refused, nothing written, both kinds', async () => {
      await kindChangeRefused(userTzid, ...timedFrom({ start_iso: iso(NAMED_DAY, 10) }), { toAllDay: false, onlyNamedDiffers: true });
      await kindChangeRefused(userTzid, ...allDayFrom({ start_iso: NAMED_DAY }), { toAllDay: true, onlyNamedDiffers: true });
    });
    it('(d) a start alone at another time is refused, nothing written, both kinds', async () => {
      await kindChangeRefused(userTzid, ...timedFrom({ start_iso: iso(NAMED_DAY, 14) }), { toAllDay: false, onlyNamedDiffers: true });
      await kindChangeRefused(userTzid, ...allDayFrom({ start_iso: dayAfter(NAMED_DAY) }), { toAllDay: true, onlyNamedDiffers: true });
    });
    it('(c) the series\' own start with another end: the card and the write agree, timed for 2 hours', async () => {
      const run = await kindChangeMade(userTzid, ...timedFrom({ start_iso: iso(NAMED_DAY, 10), end_iso: iso(NAMED_DAY, 12) }), { toAllDay: false, ...from, clock: '10:00:00', length: 2 * HOUR });
      expect(run.changes).toContain('**All-day event:**');
    });
    it('(c) mirror: the series\' own start day with a later end: all-day for 2 days', async () => {
      const run = await kindChangeMade(userTzid, ...allDayFrom({ start_iso: NAMED_DAY, end_iso: dayAfter(dayAfter(NAMED_DAY)) }), { toAllDay: true, ...from, clock: '00:00:00', length: 2 * DAY });
      expect(run.changes).toContain('**All-day event:**');
    });
  });

  describe(`${userTzid}: a change of kind at an occurrence changed on its own and of the series' kind shows that occurrence's old times on the card`, () => {
    const MOVED_DAY = '2099-01-12';
    it('timed series, the occurrence moved to 14:00-14:30, made all-day from it on: the card\'s old start and end are 14:00 and 14:30', async () => {
      const run = await kindChangeMade(userTzid, [f.timedSeriesMovedOn(MOVED_DAY)], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso(MOVED_DAY, 14), start_iso: MOVED_DAY, end_iso: dayAfter(MOVED_DAY) }, { toAllDay: true, covers: (day) => day >= MOVED_DAY });
      expect(timeChange(run.changes, 'Start')?.from).toContain('14:00');
      expect(timeChange(run.changes, 'End')?.from).toContain('14:30');
    });
    it('timed series, edit_scope all named at a first occurrence moved to 14:00-14:30: the card\'s old start and end are 14:00 and 14:30', async () => {
      const run = await kindChangeMade(userTzid, [f.timedSeriesMovedOn(FIRST_DAY)], { event_id: 'ser', edit_scope: 'all', recurrence_id: iso(FIRST_DAY, 14), start_iso: FIRST_DAY, end_iso: dayAfter(FIRST_DAY) }, { toAllDay: true, covers: all });
      expect(timeChange(run.changes, 'Start')?.from).toContain('14:00');
      expect(timeChange(run.changes, 'End')?.from).toContain('14:30');
    });
    it('mirror: all-day series, the occurrence made two days long, made timed from it on: the card\'s old end is its own last day', async () => {
      const run = await kindChangeMade(userTzid, [f.allDaySeriesLongerOn(MOVED_DAY)], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: MOVED_DAY, start_iso: iso(MOVED_DAY, 9), end_iso: iso(MOVED_DAY, 10) }, { toAllDay: false, covers: (day) => day >= MOVED_DAY });
      expect(timeChange(run.changes, 'End')?.from).toContain('2099/01/13');
    });
  });

  describe(`${userTzid}: a change of kind with both times is made where only the kind differs, and on a split (controls)`, () => {
    it('a timed event from midnight to the next midnight made all-day on its own day', async () => {
      await kindChangeMade(userTzid, [f.midnightOne()], { event_id: 'one', start_iso: FIRST_DAY, end_iso: dayAfter(FIRST_DAY) }, { toAllDay: true, covers: all });
    });
    it('timed series made all-day from an occurrence on, edit_scope this_and_following', async () => {
      await kindChangeMade(userTzid, [f.timedSeries()], { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: timedRid, start_iso: NAMED_DAY, end_iso: dayAfter(NAMED_DAY) }, { toAllDay: true, covers: (day) => day >= NAMED_DAY });
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
