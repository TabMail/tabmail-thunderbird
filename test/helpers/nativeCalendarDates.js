/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Thunderbird's own date and length code (test/fixtures/mozilla: CalDateTime,
// CalDuration and ical.js, unmodified), for tests that run the calendar bridge
// on the values Thunderbird gives it rather than on the harness's fake dates.
// The fakes convert zones with JavaScript dates, which keep the instant and
// never land in a skipped hour; Thunderbird's own conversion does both near a
// daylight saving change, and its clock arithmetic (addDuration) steps a
// value's digits, not its instant.
//
// The zones are registered under real IANA ids, with the rules those zones
// follow in 2099, so the process clock (process.env.TZ, which the tool layer
// and the read tools print with) and Thunderbird's zone agree:
//   - America/Los_Angeles: the clocks skip 02:00-03:00 on 8 March 2099 and
//     repeat 01:00-02:00 on 1 November 2099;
//   - America/New_York: the same days and hours as Los Angeles, three hours
//     earlier in UTC;
//   - Australia/Sydney: the clocks repeat 02:00-03:00 on 5 April 2099 and skip
//     02:00-03:00 on 4 October 2099;
//   - Australia/Lord_Howe: the clocks move by 30 minutes, repeating
//     01:30-02:00 on 5 April 2099 and skipping 02:00-02:30 on 4 October 2099.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ICAL from '../fixtures/mozilla/Ical.sys.mjs';
import { loadCalendarBridge } from './calendarBridgeHarness.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`../fixtures/mozilla/${name}`, import.meta.url)), 'utf8');
export const BRIDGE_PATH = fileURLToPath(new URL('../../chat/experiments/tmCalendar/tmCalendar.sys.mjs', import.meta.url));

/** A calITimezone over an ical.js zone, as CalTimezone wraps one. */
export class NativeZone {
  constructor(innerObject) { this.innerObject = innerObject; this.wrappedJSObject = this; }
  get tzid() { return this.innerObject.tzid; }
}

// CalDuration and CalDateTime in one context, CalDateTime's lazy getters
// resolving to them (Thunderbird's defineESModuleGetters).
const scope = vm.createContext({
  ICAL,
  Components: { ID: (x) => x },
  ChromeUtils: {
    generateQI: () => () => {},
    defineESModuleGetters(target) {
      target.CalTimezone = NativeZone;
      target.CalDuration = scope.CalDuration;
    },
  },
});
const asScript = (source, name) => source
  .replace('import ICAL from "resource:///modules/calendar/Ical.sys.mjs";', '')
  .replace(`export function ${name}`, `function ${name}`);
vm.runInContext(asScript(fixture('CalDuration.sys.mjs'), 'CalDuration'), scope);
vm.runInContext(asScript(fixture('CalDateTime.sys.mjs'), 'CalDateTime'), scope);
export const NativeDateTime = scope.CalDateTime;
export const NativeDuration = scope.CalDuration;

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

export const ZONES = {
  'America/Los_Angeles': vtimezone('America/Los_Angeles',
    ['DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700'],
    ['DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800']),
  'America/New_York': vtimezone('America/New_York',
    ['DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400'],
    ['DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500']),
  'Australia/Sydney': vtimezone('Australia/Sydney',
    ['DTSTART:20081005T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU', 'TZOFFSETFROM:+1000', 'TZOFFSETTO:+1100'],
    ['DTSTART:20080406T030000', 'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU', 'TZOFFSETFROM:+1100', 'TZOFFSETTO:+1000']),
  'Australia/Lord_Howe': vtimezone('Australia/Lord_Howe',
    ['DTSTART:20081005T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU', 'TZOFFSETFROM:+1030', 'TZOFFSETTO:+1100'],
    ['DTSTART:20080406T020000', 'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU', 'TZOFFSETFROM:+1100', 'TZOFFSETTO:+1030']),
};

export const UTC = new NativeZone(ICAL.Timezone.utcTimezone);
export const FLOATING = new NativeZone(ICAL.Timezone.localTimezone);
/** The zone with that id: UTC, floating, or one of ZONES. */
export function zone(tzid) {
  if (tzid === 'UTC') return UTC;
  if (tzid === 'floating') return FLOATING;
  if (!ZONES[tzid]) throw new Error(`no test zone ${tzid}`);
  return new NativeZone(ZONES[tzid]);
}

/** A date-time at `day` ("YYYY-MM-DD") and the given clock time in `tzid`. */
export function at(tzid, day, hour = 0, minute = 0, second = 0) {
  const [year, month, d] = day.split('-').map(Number);
  return new NativeDateTime(new ICAL.Time({ year, month, day: d, hour, minute, second, isDate: false }, zone(tzid).innerObject));
}

/** A DATE (all-day value) on `day`, with no zone unless `tzid` names one. */
export function dateOn(day, tzid = 'floating') {
  const [year, month, d] = day.split('-').map(Number);
  return new NativeDateTime(new ICAL.Time({ year, month, day: d, isDate: true }, zone(tzid).innerObject));
}

/** A calIDuration of `seconds` (signed). */
export function seconds(n) {
  const d = new NativeDuration();
  d.inSeconds = n;
  return d;
}

/** "YYYY-MM-DDTHH:MM:SS" of a value's own digits (a DATE at midnight). */
export function digits(dt) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(dt.year).padStart(4, '0')}-${p(dt.month + 1)}-${p(dt.day)}T${p(dt.hour)}:${p(dt.minute)}:${p(dt.second)}`;
}

/**
 * The real bridge over the calendar harness, on Thunderbird's own dates and
 * lengths, the user in `userTzid` (Thunderbird's zone; set process.env.TZ to
 * the same id). The datetime and duration contracts make native values, and
 * the timezone service knows UTC, floating and the zones above.
 */
export function nativeLoaded(items, userTzid) {
  const loaded = loadCalendarBridge(BRIDGE_PATH, { items });
  const fakeCc = loaded.ctx.Cc;
  loaded.ctx.Cc = new Proxy({}, {
    get: (_t, key) => {
      if (key === '@mozilla.org/calendar/datetime;1') return { createInstance: () => new NativeDateTime() };
      if (key === '@mozilla.org/calendar/duration;1') return { createInstance: () => new NativeDuration() };
      return fakeCc[key];
    },
  });
  const { cal } = loaded.ctx.ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');
  cal.timezoneService.UTC = UTC;
  cal.timezoneService.floating = FLOATING;
  cal.timezoneService.defaultTimezone = zone(userTzid);
  cal.timezoneService.getTimezone = (tzid) => (tzid === 'UTC' ? UTC : ZONES[tzid] ? zone(tzid) : null);
  return loaded;
}
