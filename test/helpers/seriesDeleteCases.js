/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Deleting part of a repeating event (calendar_event_delete's delete_scope),
// as the user sees it: the real delete tool (its check before the card), the
// real card states and the real bridge, on Thunderbird's own dates, the user
// in `userTz` and a second series zone `otherTz`. A test file mocks the chat
// modules (as calendarSeriesTimeRefusals.test.js does), sets process.env.TZ
// to `userTz` and calls deleteScopeCases. Every date is relative to today.
//
// The invariants, by the occurrences Thunderbird returns for the stored series
// before and after the confirmed delete, each named by its slot (its
// RECURRENCE-ID) with its start, end, kind, title and location:
//   I1  exactly the scope goes: the named occurrence (this_only), every
//       occurrence whose slot is at or after the named one's (following), or
//       the whole item (all);
//   I2  nothing is added or lengthened: after is a subset of before, over a
//       window past the series' end;
//   I3  every occurrence before the cut keeps all its values (a changed one
//       its own), and excluded and added dates before the cut stay;
//   I4  the card states the scope and the named occurrence as the read tool
//       prints it, the ChatLink relay sends that card, and the result and the
//       bubble after the write name what went;
//   I5  every refusal comes before the card, writes nothing and tells the
//       assistant why;
//   I6  following from the first occurrence deletes the whole series; an
//       event that does not repeat is deleted as it is, whatever the scope;
//   I7  an occurrence moved on its own is named by where it is now, and a
//       following delete there cuts at its slot;
//   I8  an all-day series keeps the day before the cut, and every value it
//       writes is a plain date;
//   I9  following at the last occurrence equals this_only on it, and a COUNT
//       series keeps exactly its first occurrences;
//   I10 across the next clock change, the cut keeps the day before it;
//   I11 a this-and-following split or delete named after a COUNT series' end
//       is refused and leaves the series as it was (it never lengthens it);
//   I12 a floating timed series is cut by a floating UNTIL (no Z), and the
//       named occurrence goes with every later one.
// Every stored series is read-only (readOnlySeries), as Thunderbird's are: a
// delete that changed the stored item instead of a copy fails.

import { describe, it, expect } from 'vitest';
import { onCalendar, seriesOf, remove, edit, dayPlus, iso, field, asCard, readSeries, readOccurrence, occurrencesOf } from './seriesEditFlow.js';
import { at, dateOn, digits, zone, UTC } from './nativeCalendarDates.js';
import { fakeEvent, fakeRecurrenceInfo, recurrenceItem, recurrenceDate, readOnlySeries } from './calendarBridgeHarness.js';

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();

const SERIES_LINE = 'Repeating event: every occurrence will be deleted';
const OCCURRENCE_LINE = 'One occurrence of a repeating event; the rest of the series stays.';
const FOLLOWING_LINE = 'This and every later occurrence will be deleted; earlier ones stay.';
const RESULT = {
  this_only: 'Occurrence deleted successfully; the rest of the series stays.',
  this_and_following: 'This and every later occurrence deleted successfully; earlier ones stay.',
  all: 'Repeating event deleted successfully: every occurrence.',
};
const ASK = 'This event repeats. Ask the user "Just this one, this and following, or all of them?" (unless their words already said which), then call calendar_event_delete again with delete_scope \'this_only\', \'this_and_following\' or \'all\', and for \'this_only\' or \'this_and_following\' with recurrence_id (the occurrence\'s start_iso as calendar_event_read shows it).';

/** The cases, the user in `userTz`, a second series zone `otherTz`. */
export function deleteScopeCases({ userTz, otherTz }) {
  const today = localDay(new Date());
  // The first Monday at least two weeks ahead: a weekly MO,WE series starts
  // on an occurrence of its own rule.
  const S = (() => {
    let d = dayPlus(today, 14);
    while (weekday(d) !== 1) d = dayPlus(d, 1);
    return d;
  })();
  const day = (n) => dayPlus(S, n);
  const FROM = day(-1);
  const TO = day(70);

  // The start the read tools show for a value: the user's wall clock.
  const shown = (dt) => digits(dt.getInTimezone(zone(userTz)));
  const utcUntil = (dt) => `${digits(dt.getInTimezone(UTC)).replace(/[-:]/g, '')}Z`;

  /** The series' occurrences in [from, to), by slot, with their values. */
  function occurrences(item, from = FROM, to = TO) {
    if (!item?.recurrenceInfo) return [];
    return occurrencesOf(item, from, to).map((o) => ({
      slot: digits(o.occ.recurrenceId), start: o.start, end: o.end, isDate: o.isDate,
      title: o.occ.title, location: o.occ.getProperty('LOCATION'),
    }));
  }
  const storedOf = (loaded) => loaded.calendar.items.find((it) => it.id === 'ser') || null;

  // A series in `tz` with excluded dates, added dates and changed occurrences
  // on both sides of day 8 (the cut), by `rule`.
  function richSeries(tz, rule, { exdates = [2, 13], changed = [3, 12], rdates = [[4, 8], [30, 22]] } = {}) {
    const ev = seriesOf({
      tzid: tz, day: S, hour: 22, rule,
      exdates: exdates.map((n) => at(tz, day(n), 22)),
      changed: changed.map((n, i) => ({
        rid: at(tz, day(n), 22), start: at(tz, day(n), 20), end: at(tz, day(n), 21),
        title: `Changed ${i ? 'late' : 'early'}`, location: `Room ${n}`,
      })),
    });
    for (const [n, hour] of rdates) ev.recurrenceInfo.appendRecurrenceItem(recurrenceDate('RDATE', at(tz, day(n), hour)));
    return ev;
  }

  /**
   * The delete of `args` on `items` (the series 'ser' read-only), confirmed.
   * Returns the occurrences before and after, the run and the calendar.
   */
  async function deleted(items, args, { from = FROM, to = TO, confirm = true } = {}) {
    const loaded = onCalendar(items, userTz);
    const series = storedOf(loaded);
    if (series?.recurrenceInfo) readOnlySeries(series);
    const before = occurrences(series, from, to);
    const run = await remove({ event_id: 'ser', ...args }, { confirm });
    const item = storedOf(loaded);
    return { loaded, run, before, after: occurrences(item, from, to), item };
  }

  function confirmed(run) {
    expect(run.failReason, 'refused').toBeUndefined();
    expect(run.card, 'no card').toBeTruthy();
    expect(run.state).toBe('exec_success');
  }

  describe(`delete by scope, the user in ${userTz}`, () => {
    // ---- I1, I3, I4: every scope, three rules, in both zones ----
    const rules = [
      ['a daily COUNT rule', (tz) => richSeries(tz, 'FREQ=DAILY;COUNT=20'), 8],
      ['a weekly MO,WE rule with no end', (tz) => richSeries(tz, 'FREQ=WEEKLY;BYDAY=MO,WE', { exdates: [2, 16], changed: [7, 21], rdates: [[3, 8], [24, 8]] }), 14],
      ['a daily UNTIL rule', (tz) => richSeries(tz, `FREQ=DAILY;UNTIL=${utcUntil(at(tz, day(19), 22))}`), 8],
    ];
    for (const tz of [userTz, otherTz]) {
      for (const [name, make, cutDay] of rules) {
        for (const scope of ['this_only', 'this_and_following', 'all']) {
          it(`${scope}, ${name} in ${tz}: exactly that goes, the rest keeps every value, and the card says so (I1, I3, I4)`, async () => {
            const named = at(tz, day(cutDay), 22);
            const rid = shown(named);
            // What the read tools show before the delete: the named
            // occurrence, or for the whole series its first occurrence.
            onCalendar([make(tz)], userTz);
            const read = scope === 'all' ? await readSeries() : await readOccurrence(rid);
            if (scope !== 'all') expect(read.start_iso, 'the named occurrence is read').toBe(rid);

            const args = scope === 'all' ? { delete_scope: 'all' } : { delete_scope: scope, recurrence_id: rid };
            const { run, before, after, loaded, item } = await deleted([make(tz)], args);
            confirmed(run);
            const cut = digits(named);
            expect(before.some((o) => o.slot === cut), 'the cut is an occurrence').toBe(true);
            // I1 (and I3: the occurrences that stay keep every value).
            if (scope === 'this_only') expect(after).toEqual(before.filter((o) => o.slot !== cut));
            if (scope === 'this_and_following') expect(after).toEqual(before.filter((o) => o.slot < cut));
            if (scope === 'all') {
              expect(item).toBeNull();
              expect(loaded.deletions.map((it) => it.id)).toEqual(['ser']);
            } else {
              expect(loaded.deletions).toEqual([]);
            }
            // I4: the card.
            expect(field(run.card, 'Start')).toBe(await asCard(read.start_iso));
            const scopeLine = { this_only: OCCURRENCE_LINE, this_and_following: FOLLOWING_LINE, all: SERIES_LINE }[scope];
            expect(run.card.split('\n')).toContain(scopeLine);
            expect(/^Repeats /m.test(run.card)).toBe(scope !== 'this_only');
            expect(run.relayed.startsWith(run.card)).toBe(true);
            expect(run.result).toEqual({ result: RESULT[scope] });
            const done = {
              this_only: 'Occurrence deleted',
              this_and_following: 'This and every later occurrence deleted; earlier ones stay',
              all: 'Repeating event deleted: every occurrence',
            }[scope];
            expect(run.done).toBe(done);
          });
        }
      }

      it(`this_and_following, a series of added dates alone in ${tz}: the added dates from the named one on go (I1)`, async () => {
        const make = () => {
          const ev = fakeEvent({ id: 'ser', title: 'Clinic', startDate: at(tz, S, 22), endDate: at(tz, S, 23), properties: { LOCATION: 'Ward A' } });
          ev.recurrenceInfo = fakeRecurrenceInfo([3, 6, 9].map((n) => recurrenceDate('RDATE', at(tz, day(n), 22))));
          ev.recurrenceInfo.item = ev;
          return ev;
        };
        const named = at(tz, day(6), 22);
        const { run, before, after } = await deleted([make()], { delete_scope: 'this_and_following', recurrence_id: shown(named) });
        confirmed(run);
        // Thunderbird expands a series with no rule to its added dates alone.
        expect(before.map((o) => o.slot.slice(0, 10))).toEqual([day(3), day(6), day(9)]);
        expect(after).toEqual(before.filter((o) => o.slot < digits(named)));
      });
    }

    // ---- I2: never lengthens or adds ----
    const bounded = [
      ['a COUNT rule', () => richSeries(userTz, 'FREQ=DAILY;COUNT=10', { rdates: [] }), 6],
      ['an UNTIL rule', () => richSeries(userTz, `FREQ=DAILY;UNTIL=${utcUntil(at(userTz, day(9), 22))}`, { rdates: [] }), 6],
      ['a rule that ended before an added date', () => richSeries(userTz, 'FREQ=DAILY;COUNT=5', { exdates: [], changed: [], rdates: [[14, 22], [20, 22]] }), 14],
    ];
    for (const [name, make, cutDay] of bounded) {
      for (const scope of ['this_only', 'this_and_following']) {
        it(`${scope}, ${name}: nothing is added or lengthened, over a window past the series' end (I2)`, async () => {
          const { run, before, after } = await deleted([make()], { delete_scope: scope, recurrence_id: iso(day(cutDay), 22) }, { to: day(120) });
          confirmed(run);
          expect(after.length).toBeLessThan(before.length);
          for (const o of after) expect(before, `${o.slot} was not there before`).toContainEqual(o);
        });
      }
    }

    // ---- I5: refusals ----
    const refusals = [
      ['a repeating event and no scope', {}, ASK],
      ['an unknown scope', { delete_scope: 'Future', recurrence_id: iso(day(8), 22) }, `delete_scope "future" is not one of 'this_only', 'this_and_following' or 'all'.`],
      ['this_only without recurrence_id', { delete_scope: 'this_only' }, "delete_scope 'this_only' needs recurrence_id"],
      ['this_and_following without recurrence_id', { delete_scope: 'this_and_following' }, "delete_scope 'this_and_following' needs recurrence_id"],
      ['a recurrence_id that is not a date', { delete_scope: 'this_only', recurrence_id: 'next Tuesday' }, 'recurrence_id "next Tuesday" is not a date and time the calendar can read'],
      ['a recurrence_id that names no occurrence', { delete_scope: 'this_only', recurrence_id: iso(day(8), 21) }, `recurrence_id ${iso(day(8), 21)} is not the start of an occurrence of this series`],
      ['a recurrence_id that names an excluded occurrence', { delete_scope: 'this_and_following', recurrence_id: iso(day(2), 22) }, `recurrence_id ${iso(day(2), 22)} is not the start of an occurrence of this series`],
    ];
    for (const [name, args, text] of refusals) {
      it(`${name}: refused before the card, nothing written (I5)`, async () => {
        const { run, loaded, before, after } = await deleted([richSeries(userTz, 'FREQ=DAILY;COUNT=20')], args);
        expect(run.card).toBeNull();
        expect(run.state).toBe('exec_fail');
        expect(run.failReason).toContain(text);
        expect(run.result).toEqual({ error: run.failReason });
        expect(loaded.modifications).toEqual([]);
        expect(loaded.deletions).toEqual([]);
        expect(after).toEqual(before);
      });
    }
    const seriesRefusals = [
      ['a series that cancels occurrences by a rule', () => {
        const ev = richSeries(userTz, 'FREQ=DAILY;COUNT=20', { rdates: [] });
        // As Thunderbird keeps one from comm-central bug 2082832 on (the
        // harness's rule items read back as RRULE, as before that change).
        ev.recurrenceInfo.appendRecurrenceItem({ icalProperty: { propertyName: 'EXRULE', value: 'FREQ=WEEKLY;BYDAY=SA' } });
        return ev;
      }, 'this series cancels occurrences by a rule (EXRULE)'],
      ['a series whose count cannot be read', () => richSeries(userTz, 'FREQ=DAILY;COUNT=30x', { rdates: [] }), "this series' count cannot be read (COUNT=30x)"],
    ];
    for (const [name, make, text] of seriesRefusals) {
      it(`this_and_following on ${name}: refused before the card, nothing written (I5)`, async () => {
        const { run, loaded } = await deleted([make()], { delete_scope: 'this_and_following', recurrence_id: iso(day(8), 22) });
        expect(run.card).toBeNull();
        expect(run.state).toBe('exec_fail');
        expect(run.failReason).toContain(text);
        expect(loaded.modifications).toEqual([]);
        expect(loaded.deletions).toEqual([]);
      });
    }

    // ---- I6: routing ----
    it('this_and_following from the first occurrence: the card says every occurrence goes and the series is deleted (I6)', async () => {
      const { run, loaded, item } = await deleted([richSeries(userTz, 'FREQ=DAILY;COUNT=20')], { delete_scope: 'this_and_following', recurrence_id: iso(S, 22) });
      confirmed(run);
      expect(run.card.split('\n')).toContain(SERIES_LINE);
      expect(item).toBeNull();
      expect(loaded.deletions.map((it) => it.id)).toEqual(['ser']);
      expect(run.result).toEqual({ result: RESULT.all });
    });

    it('this_only at the first occurrence: only it goes, the series stays (I6)', async () => {
      const { run, before, after, loaded, item } = await deleted([richSeries(userTz, 'FREQ=DAILY;COUNT=20')], { delete_scope: 'this_only', recurrence_id: iso(S, 22) });
      confirmed(run);
      const first = digits(at(userTz, S, 22));
      expect(before[0].slot).toBe(first);
      expect(after).toEqual(before.filter((o) => o.slot !== first));
      expect(item).not.toBeNull();
      expect(loaded.deletions).toEqual([]);
      expect(run.card.split('\n')).toContain(OCCURRENCE_LINE);
      expect(field(run.card, 'Start')).toBe(await asCard(iso(S, 22)));
      expect(run.result).toEqual({ result: RESULT.this_only });
    });

    it('an event that does not repeat, given a scope and an occurrence: deleted as it is, no scope line (I6)', async () => {
      const one = fakeEvent({ id: 'ser', title: 'Dentist', startDate: at(userTz, day(1), 10), endDate: at(userTz, day(1), 11) });
      const { run, loaded } = await deleted([one], { delete_scope: 'this_only', recurrence_id: iso(day(1), 10) });
      confirmed(run);
      expect(run.card).not.toMatch(/occurrence|Repeat/);
      expect(loaded.deletions.map((it) => it.id)).toEqual(['ser']);
      expect(run.result).toEqual({ result: 'Calendar event deleted successfully.' });
      expect(run.done).toBe('Calendar event deleted');
    });

    // ---- I7: occurrences moved on their own ----
    it('this_only on an occurrence moved to another day, named where it is now: only it goes (I7a)', async () => {
      const ev = seriesOf({
        tzid: userTz, day: S, hour: 22, rule: 'FREQ=DAILY;COUNT=20',
        changed: [{ rid: at(userTz, day(5), 22), start: at(userTz, day(6), 8), end: at(userTz, day(6), 9), title: 'Moved' }],
      });
      const { run, before, after } = await deleted([ev], { delete_scope: 'this_only', recurrence_id: iso(day(6), 8) });
      confirmed(run);
      expect(field(run.card, 'Start')).toBe(await asCard(iso(day(6), 8)));
      expect(after).toEqual(before.filter((o) => o.slot !== digits(at(userTz, day(5), 22))));
      expect(after.filter((o) => o.start.startsWith(day(6))).map((o) => o.start)).toEqual([iso(day(6), 22)]);
    });

    it('this_and_following at a moved occurrence cuts at its slot: a later one moved before goes, an earlier one moved past stays (I7b)', async () => {
      const ev = seriesOf({
        tzid: userTz, day: S, hour: 22, rule: 'FREQ=DAILY;COUNT=20',
        changed: [
          { rid: at(userTz, day(10), 22), start: at(userTz, day(12), 9), end: at(userTz, day(12), 10), title: 'Named' },
          { rid: at(userTz, day(11), 22), start: at(userTz, day(9), 10), end: at(userTz, day(9), 11), title: 'Later, moved earlier' },
          { rid: at(userTz, day(9), 22), start: at(userTz, day(13), 7), end: at(userTz, day(13), 8), title: 'Earlier, moved later' },
        ],
      });
      const { run, before, after } = await deleted([ev], { delete_scope: 'this_and_following', recurrence_id: iso(day(12), 9) });
      confirmed(run);
      const cut = digits(at(userTz, day(10), 22));
      expect(after).toEqual(before.filter((o) => o.slot < cut));
      expect(after.map((o) => o.title)).toContain('Earlier, moved later');
      expect(after.map((o) => o.title)).not.toContain('Later, moved earlier');
      expect(run.card.split('\n')).toContain(`This and every later occurrence will be deleted (from ${await asCard(iso(day(12), 9))}, originally ${await asCard(iso(day(10), 22))}); earlier ones stay.`);
      // The bubble after the write names no date: the cut was at the slot,
      // and an occurrence ("Later, moved earlier") before the named one's
      // current start went too.
      expect(run.done).toBe('This and every later occurrence deleted; earlier ones stay');
    });

    // ---- The check before the card failing (I5) ----
    for (const [name, answer] of [['throws', async () => { throw new Error('the bridge rejected the call'); }], ['answers nothing', async () => undefined]]) {
      it(`the bridge check before the card ${name}: refused, nothing written, no hang (I5)`, async () => {
        const loaded = onCalendar([richSeries(userTz, 'FREQ=DAILY;COUNT=20')], userTz);
        const bridge = globalThis.browser.tmCalendar;
        const write = bridge.deleteCalendarEvent;
        bridge.deleteCalendarEvent = (d) => (d?.check_only ? answer() : write(d));
        const run = await remove({ event_id: 'ser', delete_scope: 'this_only', recurrence_id: iso(day(8), 22) });
        expect(run.card).toBeNull();
        expect(run.state).toBe('exec_fail');
        expect(run.failReason).toContain('the calendar could not check this delete');
        expect(run.result).toEqual({ error: run.failReason });
        expect(loaded.modifications).toEqual([]);
        expect(loaded.deletions).toEqual([]);
      });
    }

    // ---- I11: never lengthened past a COUNT series' end (split and delete) ----
    it('this_and_following named after a COUNT series ends: the split and the delete are refused, the series unchanged (I11)', async () => {
      const make = () => seriesOf({ tzid: userTz, day: S, hour: 22, rule: 'FREQ=DAILY;COUNT=10' });
      const after = iso(day(15), 22);
      const notOne = `recurrence_id ${after} is not the start of an occurrence of this series`;
      for (const run of [
        async () => edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: after, title: 'Renamed' }),
        async () => remove({ event_id: 'ser', delete_scope: 'this_and_following', recurrence_id: after }),
      ]) {
        const loaded = onCalendar([make()], userTz);
        const series = storedOf(loaded);
        readOnlySeries(series);
        const before = occurrences(series, FROM, day(120));
        const out = await run();
        expect(out.card).toBeNull();
        expect(out.state).toBe('exec_fail');
        expect(out.failReason).toContain(notOne);
        expect(loaded.modifications).toEqual([]);
        expect(loaded.deletions).toEqual([]);
        expect(loaded.calendar.items).toEqual([series]);
        expect(occurrences(storedOf(loaded), FROM, day(120))).toEqual(before);
        expect(before).toHaveLength(10);
      }
    });

    // ---- I12: a floating timed series ----
    for (const [hour, minute] of [[0, 30], [9, 0], [23, 30]]) {
      it(`this_and_following, a floating daily series at ${iso(S, hour, minute).slice(11, 16)}: a floating UNTIL, and the named occurrence goes (I12)`, async () => {
        const named = iso(day(5), hour, minute);
        const { run, before, after, item } = await deleted([seriesOf({ tzid: 'floating', day: S, hour, minute, rule: 'FREQ=DAILY;COUNT=20' })], { delete_scope: 'this_and_following', recurrence_id: named });
        confirmed(run);
        expect(before.map((o) => o.start)).toContain(named);
        expect(after.map((o) => o.start)).toEqual(before.map((o) => o.start).filter((st) => st < named));
        expect(after.map((o) => o.start)).not.toContain(named);
        expect(item.startDate.timezone.tzid).toBe('floating');
        const untils = [...item.recurrenceInfo.getRecurrenceItems({})]
          .map((r) => /(?:^|;)UNTIL=([^;]*)/i.exec(String(r.icalProperty?.value || ''))?.[1]).filter(Boolean);
        expect(untils).toHaveLength(1);
        expect(untils[0], 'a floating start has a floating UNTIL').toMatch(/^\d{8}T\d{6}$/);
      });
    }

    // ---- I8: all-day ----
    for (const tz of ['floating', userTz]) {
      const allDaySeries = () => {
        const ev = fakeEvent({ id: 'ser', title: 'Leave', startDate: dateOn(S, tz), endDate: dateOn(day(1), tz), properties: { LOCATION: 'Home' } });
        ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=20')]);
        ev.recurrenceInfo.item = ev;
        return ev;
      };
      const kind = tz === 'floating' ? 'plain dates' : `dates in ${tz}`;
      it(`this_and_following, an all-day series of ${kind}: the day before is the last, every value a plain date (I8)`, async () => {
        const { run, before, after, item } = await deleted([allDaySeries()], { delete_scope: 'this_and_following', recurrence_id: day(6) });
        confirmed(run);
        expect(after).toEqual(before.filter((o) => o.slot.slice(0, 10) < day(6)));
        expect(after.at(-1).slot.slice(0, 10)).toBe(day(5));
        expect(item.startDate.isDate).toBe(true);
        expect(item.startDate.timezone.tzid).toBe('floating');
        const rule = item.recurrenceInfo.getRecurrenceItems().map((r) => r.icalProperty?.value || '').find((v) => v.startsWith('FREQ='));
        expect(rule).toMatch(/UNTIL=\d{8}(;|$)/);
      });
      it(`this_only, an all-day series of ${kind}: that day alone goes, excluded as a plain date (I8)`, async () => {
        const { run, before, after, item } = await deleted([allDaySeries()], { delete_scope: 'this_only', recurrence_id: day(6) });
        confirmed(run);
        expect(after).toEqual(before.filter((o) => o.slot.slice(0, 10) !== day(6)));
        expect(item.startDate.timezone.tzid).toBe('floating');
        const exdates = item.recurrenceInfo.getRecurrenceItems().filter((r) => r.isNegative && r.date);
        expect(exdates.map((r) => [digits(r.date).slice(0, 10), r.date.isDate, r.date.timezone.tzid])).toEqual([[day(6), true, 'floating']]);
      });
    }

    // ---- I9: the ends ----
    it('this_and_following at the last occurrence equals this_only on it (I9)', async () => {
      const make = () => seriesOf({ tzid: userTz, day: S, hour: 22, rule: 'FREQ=DAILY;COUNT=10' });
      const last = iso(day(9), 22);
      const following = await deleted([make()], { delete_scope: 'this_and_following', recurrence_id: last });
      const only = await deleted([make()], { delete_scope: 'this_only', recurrence_id: last });
      confirmed(following.run);
      confirmed(only.run);
      expect(following.after).toEqual(only.after);
      expect(following.after).toHaveLength(9);
    });

    it('this_and_following on a COUNT series keeps exactly its first occurrences (I9)', async () => {
      const { run, before, after } = await deleted([seriesOf({ tzid: userTz, day: S, hour: 22, rule: 'FREQ=DAILY;COUNT=10' })], { delete_scope: 'this_and_following', recurrence_id: iso(day(4), 22) }, { to: day(120) });
      confirmed(run);
      expect(after).toEqual(before.slice(0, 4));
    });

    // ---- I10: the next clock change from today ----
    const offsetAt = (day) => new Intl.DateTimeFormat('en-US', { timeZone: userTz, timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${day}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value;
    const C = (() => {
      for (let n = 1; n < 400; n++) if (offsetAt(dayPlus(today, n)) !== offsetAt(dayPlus(today, n - 1))) return dayPlus(today, n);
      throw new Error(`no clock change in ${userTz} within a year`);
    })();
    for (const [named, last] of [[0, -1], [1, 0]]) {
      it(`a daily series across the clock change: following at the change day ${named ? 'plus one ' : ''}keeps ${last ? 'the day before' : 'the change day'} as the last (I10)`, async () => {
        const ev = seriesOf({ tzid: userTz, day: dayPlus(C, -5), hour: 0, minute: 30, rule: 'FREQ=DAILY;COUNT=12' });
        const { run, after } = await deleted([ev], { delete_scope: 'this_and_following', recurrence_id: iso(dayPlus(C, named), 0, 30) }, { from: dayPlus(C, -6), to: dayPlus(C, 30) });
        confirmed(run);
        expect(after.map((o) => o.start)).toEqual(Array.from({ length: 5 + named }, (_, i) => iso(dayPlus(C, i - 5), 0, 30)));
        expect(after.at(-1).start.slice(0, 10)).toBe(dayPlus(C, last));
      });
    }
  });
}
