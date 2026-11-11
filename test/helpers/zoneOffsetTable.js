/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The 2099 clocks of the three zones nativeCalendarDates.js registers, written
// by hand from the rules (no ical.js), so a test can judge Thunderbird's own
// date code against an oracle that shares none of it. The two IANA zones are
// cross-checked against Intl by calendarSeriesTimePrimitives.test.js.
//
// Each zone: its standard and daylight offsets (minutes east of UTC) and the
// two 2099 changes as UTC instants. Only 2099 is described.

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;

export const OFFSET_TABLE = {
  // Daylight from 8 March 02:00 PST (10:00Z) to 1 November 02:00 PDT (09:00Z).
  'America/Los_Angeles': {
    standard: -480, daylight: -420,
    daylightFrom: Date.UTC(2099, 2, 8, 10), daylightUntil: Date.UTC(2099, 10, 1, 9),
  },
  // Standard from 5 April 03:00 AEDT (4 April 16:00Z) to 4 October 02:00 AEST
  // (3 October 16:00Z); daylight outside it.
  'Australia/Sydney': {
    standard: 600, daylight: 660,
    standardFrom: Date.UTC(2099, 3, 4, 16), standardUntil: Date.UTC(2099, 9, 3, 16),
  },
  // Standard (+10:30) from 5 April 02:00 (+11, 4 April 15:00Z) to 4 October
  // 02:00 (+10:30, 3 October 15:30Z); daylight (+11) outside it.
  'Australia/Lord_Howe': {
    standard: 630, daylight: 660,
    standardFrom: Date.UTC(2099, 3, 4, 15), standardUntil: Date.UTC(2099, 9, 3, 15, 30),
  },
};

/** The zone's offset from UTC, in minutes east, at the UTC instant `ms` (2099 only). */
export function offsetAt(tzid, ms) {
  const z = OFFSET_TABLE[tzid];
  if (!z) throw new Error(`no offset table for ${tzid}`);
  if (new Date(ms).getUTCFullYear() !== 2099) throw new Error('the offset table describes 2099 only');
  if ('daylightFrom' in z) return ms >= z.daylightFrom && ms < z.daylightUntil ? z.daylight : z.standard;
  return ms >= z.standardFrom && ms < z.standardUntil ? z.standard : z.daylight;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** "YYYY-MM-DDTHH:MM:SS" of the zone's clock at the UTC instant `ms`. */
export function clockAt(tzid, ms) {
  const d = new Date(ms + offsetAt(tzid, ms) * MINUTE);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Every UTC instant at which the zone's clock reads `digits`
 * ("YYYY-MM-DDTHH:MM:SS"), earliest first: none for skipped digits, two for
 * digits in the hour the clocks repeat (the first pass, then the second).
 */
export function instantsOf(tzid, digits) {
  const [date, time] = digits.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, s] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const z = OFFSET_TABLE[tzid];
  return [...new Set([z.standard, z.daylight])]
    .map((offset) => asUtc - offset * MINUTE)
    .filter((ms) => clockAt(tzid, ms) === digits)
    .sort((a, b) => a - b);
}

/** Whether the zone's clock skips `digits`. */
export const isSkipped = (tzid, digits) => instantsOf(tzid, digits).length === 0;

/** Whether the UTC instant `ms` is the first of two at which the zone's clock reads the same. */
export function inFirstPass(tzid, ms) {
  const both = instantsOf(tzid, clockAt(tzid, ms));
  return both.length === 2 && both[0] === ms;
}

/** The zone's offset at `ms` as Intl reports it (the system's zone data), in minutes east. */
export function intlOffsetAt(tzid, ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((local - Math.floor(ms / 1000) * 1000) / MINUTE);
}

export { HOUR, MINUTE };
