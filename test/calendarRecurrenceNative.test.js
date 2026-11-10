/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The recurrence bridge against Thunderbird's own date and recurrence code
// (test/fixtures/mozilla), not a fake of it. The fakes in calendarBridgeHarness
// convert zones with JavaScript dates, which keep the instant and never land in
// a skipped hour; Thunderbird's conversion does both near a daylight saving
// change. Each case checks the property the read format promises: a rule read
// in the tools' fields and written back expands to the same occurrences, and a
// last day shown is the series' last day, or the read shows the part it cannot
// express in `other`, so restating it is refused.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
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

function vtimezone(tzid, daylight, standard) {
  return new ICAL.Timezone({
    tzid,
    component: new ICAL.Component(ICAL.parse([
      'BEGIN:VTIMEZONE', `TZID:${tzid}`,
      'BEGIN:DAYLIGHT', ...daylight, 'END:DAYLIGHT',
      'BEGIN:STANDARD', ...standard, 'END:STANDARD',
      'END:VTIMEZONE', '',
    ].join('\r\n'))),
  });
}

// North American rule: the clock skips 02:00-03:00 on the second Sunday of
// March (8 March 2099) and repeats 01:00-02:00 on the first Sunday of
// November (1 November 2099).
const pacific = vtimezone('Test/Pacific',
  ['DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700'],
  ['DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800']);
// A zone that changes at midnight: the clock skips 00:00-01:00 on the second
// Sunday of September (13 September 2099) and repeats 23:00-24:00 before the
// first Sunday of April (5 April 2099).
const midnight = vtimezone('Test/Midnight',
  ['DTSTART:20070909T000000', 'RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=2SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0300'],
  ['DTSTART:20070401T000000', 'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU', 'TZOFFSETFROM:-0300', 'TZOFFSETTO:-0400']);

const at = (zone, month, day, hour, minute) =>
  new NativeDateTime(new ICAL.Time({ year: 2099, month, day, hour, minute, second: 0, isDate: false }, zone));
const pad2 = (n) => String(n).padStart(2, '0');
const dayString = (month, day) => `2099-${pad2(month)}-${pad2(day)}`;
const clock = ([hour, minute]) => `${hour}:${pad2(minute)}`;

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

function nativeBridge(rule, start, zone) {
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
  cal.timezoneService.defaultTimezone = new NativeZone(zone);
  return loaded;
}

const storedRule = (loaded) => loaded.calendar.items[0].recurrenceInfo.getRecurrenceItems()[0].icalProperty.value;

// Reads the series, then either writes the read fields back and returns both
// expansions, or confirms the read shows the unexpressible part in `other`
// and an edit restating it is refused. A last day shown is the day of the
// last occurrence.
async function readAndRestate(loaded) {
  const before = expanded(storedRule(loaded), loaded.calendar.items[0].startDate);
  const details = await loaded.api.getCalendarEventDetails('ser', 'cal1');
  expect(details.ok).toBe(true);
  const read = details.recurrence;
  if (read.until) expect(read.until.replaceAll('-', ''), 'the last day shown is the last occurrence\'s').toBe(before.at(-1).slice(0, 8));
  if (read.other) {
    const { other, ...fields } = read;
    expect(otherPartsRefusal(fields, read)).not.toBeNull();
    return { read, before, after: null };
  }
  const res = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: read });
  expect(res.ok).toBe(true);
  return { read, before, after: expanded(storedRule(loaded), loaded.calendar.items[0].startDate) };
}

// One day before or after each change, and the change day itself.
const changes = [
  { zone: pacific, name: 'spring, at 02:00', month: 3, days: [5, 6, 7, 8, 9, 10, 11], starts: [[0, 30], [1, 1], [1, 30], [1, 59], [2, 30], [12, 0], [23, 30]] },
  { zone: pacific, name: 'autumn, at 02:00', month: 11, days: [1, 2, 3, 4], starts: [[0, 30], [1, 30], [2, 30], [12, 0], [23, 30]] },
  { zone: pacific, name: 'autumn, at 02:00 (late October)', month: 10, days: [27, 28, 29, 30, 31], starts: [[0, 30], [1, 30], [12, 0], [23, 30]] },
  { zone: midnight, name: 'spring, at midnight', month: 9, days: [10, 11, 12, 13, 14, 15], starts: [[0, 0], [0, 30], [0, 59], [1, 30], [12, 0], [23, 0], [23, 30], [23, 59]] },
  { zone: midnight, name: 'autumn, at midnight', month: 4, days: [2, 3, 4, 5, 6, 7], starts: [[0, 30], [12, 0], [22, 30], [23, 0], [23, 30], [23, 59]] },
];

describe('recurrence read and restate against Thunderbird\'s own date and recurrence code', () => {
  it('the vendored Thunderbird files are the copies the fixture README pins', () => {
    const readme = readFileSync(resolve('test/fixtures/mozilla/README.md'), 'utf8');
    for (const file of ['Ical.sys.mjs', 'CalDateTime.sys.mjs']) {
      const pinned = new RegExp(`\\| \`${file.replace('.', '\\.')}\` \\|[^|]*\\| \`([0-9a-f]{64})\` \\|`).exec(readme);
      expect(pinned, file).not.toBeNull();
      expect(createHash('sha256').update(readFileSync(resolve('test/fixtures/mozilla', file))).digest('hex'), file).toBe(pinned[1]);
    }
  });

  // The bound a split writes: the split occurrence minus one second.
  for (const { zone, name, month, days, starts } of changes) {
    it(`a series capped just before an occurrence, around the ${name} change, keeps its occurrences and reads its last day, or reads as \`other\``, async () => {
      for (const start of starts) {
        for (const day of days) {
          const cut = at(zone, month, day, ...start).innerObject.toUnixTime() - 1;
          const bound = new Date(cut * 1000).toISOString().replace(/[-:]/g, '').replace('.000', '');
          const loaded = nativeBridge(`FREQ=DAILY;UNTIL=${bound}`, at(zone, month - 1, 20, ...start), zone);
          const { read, before, after } = await readAndRestate(loaded);
          const label = `${clock(start)} cut before ${dayString(month, day)}`;
          if (after) expect(after, label).toEqual(before);
          else expect(read.other, label).toBe(`UNTIL=${bound}`);
        }
      }
    });
  }

  // A last day written by the tools. At the midnight spring change, a start in
  // the first hour is left out: the bound written for the day before keeps the
  // change day's occurrence too (#280).
  for (const { zone, name, month, days, starts } of changes) {
    it(`a last day written around the ${name} change is the last occurrence, and reads back as that day or as \`other\``, async () => {
      for (const start of starts.filter(([hour]) => name !== 'spring, at midnight' || hour !== 0)) {
        for (const day of days) {
          const until = dayString(month, day);
          const loaded = nativeBridge('FREQ=DAILY', at(zone, month - 1, 20, ...start), zone);
          const written = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'DAILY', until } });
          expect(written.ok).toBe(true);
          const { read, before, after } = await readAndRestate(loaded);
          const label = `${clock(start)} until ${until}`;
          expect(before.at(-1).slice(0, 8), label).toBe(until.replaceAll('-', ''));
          if (after) {
            expect(read.until, label).toBe(until);
            expect(after, label).toEqual(before);
          } else {
            expect(read.other, label).toMatch(/^UNTIL=/);
          }
        }
      }
    });
  }

  it('away from a daylight saving change, a written last day reads back as that day for every start time', async () => {
    for (const start of [[0, 30], [1, 30], [12, 0], [23, 30]]) {
      const loaded = nativeBridge('FREQ=DAILY', at(pacific, 6, 1, ...start), pacific);
      await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence: { freq: 'DAILY', until: '2099-06-20' } });
      const { read, after, before } = await readAndRestate(loaded);
      expect(read).toEqual({ freq: 'DAILY', until: '2099-06-20' });
      expect(after).toEqual(before);
    }
  });

  for (const [bound, startMonth] of [['20991101T073000Z', 10], ['20991101T083000Z', 10], ['20991102T083000Z', 10], ['20990308T093000Z', 3]]) {
    it(`a bound another app stored (UNTIL=${bound}) keeps its occurrences, or reads as \`other\``, async () => {
      const loaded = nativeBridge(`FREQ=DAILY;UNTIL=${bound}`, at(pacific, startMonth, 1, 0, 30), pacific);
      const { read, before, after } = await readAndRestate(loaded);
      if (after) expect(after).toEqual(before);
      else expect(read.other).toBe(`UNTIL=${bound}`);
    });
  }

  it('a BYSETPOS rule is never restated: it reads with BYSETPOS in `other`', async () => {
    for (const rule of [
      'FREQ=MONTHLY;COUNT=8;BYDAY=TU;BYSETPOS=2',
      'FREQ=MONTHLY;COUNT=8;BYDAY=TU;BYSETPOS=-1',
      'FREQ=MONTHLY;COUNT=2;BYDAY=MO;BYSETPOS=-10',
      'FREQ=YEARLY;COUNT=4;BYMONTH=3;BYDAY=TU;BYSETPOS=2',
      'FREQ=YEARLY;COUNT=3;BYDAY=MO;BYSETPOS=-20',
    ]) {
      const loaded = nativeBridge(rule, at(pacific, 1, 1, 9, 0), pacific);
      const { read, after } = await readAndRestate(loaded);
      expect(read.other, rule).toBe(/BYSETPOS=[^;]+/.exec(rule)[0]);
      expect(after, rule).toBeNull();
    }
  });
});
