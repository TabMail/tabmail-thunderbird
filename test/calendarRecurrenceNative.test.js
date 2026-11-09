/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The recurrence bridge against Thunderbird's own date and recurrence code
// (test/fixtures/mozilla), not a fake of it. The fakes in calendarBridgeHarness
// convert zones with JavaScript dates, which keep the instant; Thunderbird's
// conversion does not always (near the autumn change), and its iterator
// expands a yearly ordinal differently from BYSETPOS. Each case here checks
// the property the read format promises: a rule read in the tools' fields
// and written back expands to the same occurrences, or the read shows the
// part it cannot express in `other`, so restating it is refused.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import ICAL from './fixtures/mozilla/Ical.sys.mjs';
import { loadCalendarBridge, fakeEvent, fakeRecurrenceInfo, recurrenceItem } from './helpers/calendarBridgeHarness.js';
import { otherPartsRefusal } from '../chat/modules/recurrence.js';

class NativeZone {
  constructor(innerObject) { this.innerObject = innerObject; this.wrappedJSObject = this; }
  get tzid() { return this.innerObject.tzid; }
}

const nativeScope = vm.createContext({
  ICAL,
  Components: { ID: (x) => x },
  ChromeUtils: {
    generateQI: () => () => {},
    defineESModuleGetters(target) { target.CalTimezone = NativeZone; },
  },
});
vm.runInContext(readFileSync(resolve('test/fixtures/mozilla/CalDateTime.sys.mjs'), 'utf8')
  .replace('import ICAL from "resource:///modules/calendar/Ical.sys.mjs";', '')
  .replace('export function CalDateTime', 'function CalDateTime'), nativeScope);
const NativeDateTime = nativeScope.CalDateTime;

// A zone with North American daylight saving time (second Sunday of March to
// first Sunday of November), as a calendar's VTIMEZONE carries it.
const pacific = new ICAL.Timezone({
  tzid: 'Test/Pacific',
  component: new ICAL.Component(ICAL.parse([
    'BEGIN:VTIMEZONE', 'TZID:Test/Pacific',
    'BEGIN:DAYLIGHT', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800', 'END:STANDARD',
    'END:VTIMEZONE', '',
  ].join('\r\n'))),
});

const at = (month, day, hour, minute) =>
  new NativeDateTime(new ICAL.Time({ year: 2099, month, day, hour, minute, second: 0, isDate: false }, pacific));

// Occurrences as Thunderbird expands them. Every rule expanded here is bounded
// (COUNT or UNTIL) and has occurrences, so the cap only guards a mistake.
function expanded(rule, start) {
  const iterator = ICAL.Recur.fromString(rule).iterator(start.innerObject);
  const out = [];
  for (let i = 0; i < 400; i++) {
    const next = iterator.next();
    if (!next) return out;
    out.push(next.toICALString());
  }
  throw new Error(`expansion of ${rule} did not end within 400 occurrences`);
}

function nativeBridge(rule, start) {
  const end = start.clone();
  end.hour += 1;
  const ev = fakeEvent({ id: 'ser', title: 'Series', startDate: start, endDate: end });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', rule)]);
  ev.recurrenceInfo.item = ev;
  const loaded = loadCalendarBridge(resolve('chat/experiments/tmCalendar/tmCalendar.sys.mjs'), { items: [ev] });
  const fakeCc = loaded.ctx.Cc;
  loaded.ctx.Cc = new Proxy({}, {
    get: (_t, key) => (key === '@mozilla.org/calendar/datetime;1' ? { createInstance: () => new NativeDateTime() } : fakeCc[key]),
  });
  const { cal } = loaded.ctx.ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');
  cal.timezoneService.UTC = new NativeZone(ICAL.Timezone.utcTimezone);
  cal.timezoneService.defaultTimezone = new NativeZone(pacific);
  return loaded;
}

const storedRule = (loaded) => loaded.calendar.items[0].recurrenceInfo.getRecurrenceItems()[0].icalProperty.value;

// Reads the series, then either writes the read fields back and returns both
// expansions, or confirms the read shows the unexpressible part in `other`
// and an edit restating it is refused.
async function readAndRestate(loaded) {
  const before = expanded(storedRule(loaded), loaded.calendar.items[0].startDate);
  const details = await loaded.api.getCalendarEventDetails('ser', 'cal1');
  expect(details.ok).toBe(true);
  const read = details.recurrence;
  if (read.other) {
    const { other, ...fields } = read;
    expect(otherPartsRefusal(fields, read)).not.toBeNull();
    return { read, before, after: null };
  }
  const res = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: read });
  expect(res.ok).toBe(true);
  return { read, before, after: expanded(storedRule(loaded), loaded.calendar.items[0].startDate) };
}

describe('recurrence read and restate against Thunderbird\'s own date and recurrence code', () => {
  // A last day written by the tools, for a series starting early, at midday
  // and late in the evening, across each daylight saving change.
  const sweeps = [
    { name: 'autumn', startMonth: 10, month: 10, days: [25, 26, 27, 28, 29, 30, 31] },
    { name: 'autumn', startMonth: 10, month: 11, days: [1, 2, 3, 4, 5] },
    { name: 'spring', startMonth: 2, month: 3, days: [5, 6, 7, 8, 9, 10, 11, 12, 13] },
  ];
  for (const { name, startMonth, month, days } of sweeps) {
    for (const [hour, minute] of [[0, 30], [12, 0], [23, 30]]) {
      it(`a written last day around the ${name} change (start ${hour}:${String(minute).padStart(2, '0')}, ${month}/${days[0]}..${days.at(-1)}) is kept, and reads back as that day or as \`other\``, async () => {
        for (const day of days) {
          const until = `2099-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const loaded = nativeBridge('FREQ=DAILY', at(startMonth, 1, hour, minute));
          const written = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'DAILY', until } });
          expect(written.ok).toBe(true);
          const { read, before, after } = await readAndRestate(loaded);
          expect(before.at(-1).slice(0, 8), `${until} is the last occurrence`).toBe(until.replaceAll('-', ''));
          if (after) {
            expect(read.until, until).toBe(until);
            expect(after, until).toEqual(before);
          } else {
            expect(read.other, until).toMatch(/^UNTIL=/);
          }
        }
      });
    }
  }

  it('away from a daylight saving change, a written last day reads back as that day for every start time', async () => {
    for (const [hour, minute] of [[0, 30], [12, 0], [23, 30]]) {
      const loaded = nativeBridge('FREQ=DAILY', at(6, 1, hour, minute));
      await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'DAILY', until: '2099-06-20' } });
      const { read, after, before } = await readAndRestate(loaded);
      expect(read).toEqual({ freq: 'DAILY', until: '2099-06-20' });
      expect(after).toEqual(before);
    }
  });

  for (const [bound, startMonth] of [['20991101T073000Z', 10], ['20991101T083000Z', 10], ['20991102T083000Z', 10], ['20990308T093000Z', 3]]) {
    it(`a bound another app stored (UNTIL=${bound}) keeps its occurrences, or reads as \`other\``, async () => {
      const loaded = nativeBridge(`FREQ=DAILY;UNTIL=${bound}`, at(startMonth, 1, 0, 30));
      const { read, before, after } = await readAndRestate(loaded);
      if (after) expect(after).toEqual(before);
      else expect(read.other).toBe(`UNTIL=${bound}`);
    });
  }

  for (const pos of [1, 2, 3, 4, -1, -2]) {
    it(`MONTHLY BYDAY=TU;BYSETPOS=${pos} reads as ${pos}TU and restates to the same occurrences`, async () => {
      const loaded = nativeBridge(`FREQ=MONTHLY;COUNT=8;BYDAY=TU;BYSETPOS=${pos}`, at(1, 1, 9, 0));
      const { read, before, after } = await readAndRestate(loaded);
      expect(read).toEqual({ freq: 'MONTHLY', count: 8, byDay: [`${pos}TU`] });
      expect(after).toEqual(before);
    });
  }

  for (const pos of [1, 2, -1]) {
    it(`YEARLY BYMONTH=3;BYDAY=TU;BYSETPOS=${pos} reads as ${pos}TU and restates to the same occurrences`, async () => {
      const loaded = nativeBridge(`FREQ=YEARLY;COUNT=4;BYMONTH=3;BYDAY=TU;BYSETPOS=${pos}`, at(1, 1, 9, 0));
      const { read, before, after } = await readAndRestate(loaded);
      expect(read).toEqual({ freq: 'YEARLY', count: 4, byDay: [`${pos}TU`], byMonth: [3] });
      expect(after).toEqual(before);
    });
  }

  for (const pos of [-20, -10, 2]) {
    it(`YEARLY BYDAY=MO;BYSETPOS=${pos} over the whole year keeps BYSETPOS in \`other\``, async () => {
      const loaded = nativeBridge(`FREQ=YEARLY;COUNT=3;BYDAY=MO;BYSETPOS=${pos}`, at(1, 1, 0, 30));
      const { read, after } = await readAndRestate(loaded);
      expect(read).toEqual({ freq: 'YEARLY', count: 3, byDay: ['MO'], other: `BYSETPOS=${pos}` });
      expect(after).toBeNull();
    });
  }

  it('a monthly position no month holds (BYSETPOS=-10) keeps BYSETPOS in `other`', async () => {
    const loaded = nativeBridge('FREQ=MONTHLY;COUNT=2;BYDAY=MO;BYSETPOS=-10', at(1, 1, 0, 30));
    const details = await loaded.api.getCalendarEventDetails('ser', 'cal1');
    expect(details.recurrence).toEqual({ freq: 'MONTHLY', count: 2, byDay: ['MO'], other: 'BYSETPOS=-10' });
  });
});
