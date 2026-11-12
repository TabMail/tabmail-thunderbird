/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The case table for a "this and following" split of a floating timed series
// (a start with no zone), shared by calendarSplitFloatingWest.test.js and
// calendarSplitFloatingEast.test.js, which set process.env.TZ and mock the
// chat modules first, as seriesEditFlow.js needs.
//
// The invariant, read from Thunderbird's own expansion of the two stored
// parts: the occurrence the split names and every later one belong to the
// following part only, and every earlier one stays in the earlier part, so
// together the parts make exactly the series' occurrences, each once. A
// floating occurrence has no instant: Thunderbird (ical.js) compares it with
// the earlier part's UNTIL at offset 0, by its digits, wherever the user is.

import { describe, it, expect } from 'vitest';
import { onCalendar, seriesOf, edit, occurrencesOf, dayPlus, iso } from './seriesEditFlow.js';

// Each case: the series starts on FIRST at `hour`:`minute` (floating) and
// repeats by `rule`; the split names the occurrence on the day SPLIT_AFTER days
// later at the same time. The six-hourly rule has occurrences earlier on the
// split day, which stay in the earlier part.
const FIRST = '2099-10-10';
const SPLIT_AFTER = 5;
const DAYS_SHOWN = 12;
const CASES = [
  ...[[0, 0], [0, 30], [9, 0], [12, 0], [17, 0], [23, 30]].map(([hour, minute]) => ({ hour, minute, rule: 'FREQ=DAILY' })),
  { hour: 15, minute: 0, rule: 'FREQ=HOURLY;INTERVAL=6' },
];

/** Every occurrence start Thunderbird returns for `item` over the days shown. */
const startsOf = (item) => occurrencesOf(item, dayPlus(FIRST, -1), dayPlus(FIRST, DAYS_SHOWN)).map((o) => o.start);

/** The UNTIL values of an item's rules, as stored. */
const untilsOf = (item) => [...item.recurrenceInfo.getRecurrenceItems({})]
  .map((r) => /(?:^|;)UNTIL=([^;]*)/i.exec(String(r.icalProperty?.value || ''))?.[1])
  .filter(Boolean);

export function floatingSplitCases(userTzid) {
  describe(`a split of a floating timed series, the user in ${userTzid}: the named occurrence and every later one are the following part's only`, () => {
    for (const { hour, minute, rule } of CASES) {
      it(`a ${rule} series at ${iso(FIRST, hour, minute).slice(11, 16)}, split ${SPLIT_AFTER} days on`, async () => {
        const series = seriesOf({ tzid: 'floating', day: FIRST, hour, minute, rule });
        const before = startsOf(series);
        const splitDay = dayPlus(FIRST, SPLIT_AFTER);
        const named = iso(splitDay, hour, minute);
        expect(before, 'the series makes the named occurrence').toContain(named);

        const loaded = onCalendar([series], userTzid);
        const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: named, title: 'Late shift' });
        expect(run.failReason, 'refused').toBeUndefined();
        expect(run.state).toBe('exec_success');

        const earlier = loaded.calendar.items.find((it) => it.id === 'ser');
        const part = loaded.calendar.items.find((it) => it.id !== 'ser');
        expect(earlier.startDate.timezone.tzid).toBe('floating');
        expect(part.startDate.timezone.tzid).toBe('floating');
        const partStarts = startsOf(part);
        const earlierStarts = startsOf(earlier);
        expect(earlierStarts, 'every occurrence before the named one stays in the earlier part')
          .toEqual(before.filter((s) => s < named));
        expect(partStarts, 'the named occurrence and every later one are the following part\'s')
          .toEqual(before.filter((s) => s >= named));
        expect(earlierStarts, 'the named occurrence is not in the earlier part').not.toContain(named);

        // RFC 5545 3.3.10: UNTIL has DTSTART's value type, so the earlier
        // part of a floating series ends at a floating UNTIL (no Z), before
        // the named occurrence by its digits.
        const untils = untilsOf(earlier);
        expect(untils, 'the earlier part has one UNTIL').toHaveLength(1);
        expect(untils[0], 'a floating start has a floating UNTIL').toMatch(/^\d{8}T\d{6}$/);
        const untilDigits = untils[0].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6');
        expect(untilDigits < named, `UNTIL ${untilDigits} is before the named occurrence`).toBe(true);
        expect(earlierStarts.every((s) => s <= untilDigits), 'every earlier occurrence is within UNTIL').toBe(true);
      });
    }
  });
}
