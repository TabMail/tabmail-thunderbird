/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The hour the clocks repeat. The night the clocks go back, the times of one
// hour (in a few zones half an hour) happen twice, so their naive ISO digits
// name two moments. The tools print such a time with its UTC offset in
// parentheses, "2026-11-01T01:30:00 (UTC-4)" for the first pass and
// "2026-11-01T01:30:00 (UTC-5)" for the second, and every other time without
// one; the calendar tools take that form back and read it as the moment it
// names. The calendar bridge (tmCalendar.sys.mjs) has its own twins
// (shownIso, parseShownIso), since it cannot import this module.
//
// No imports, so any module can load it. A value with the offset is never
// given to `new Date`: the engine's lenient parser may skip a note in
// parentheses and read another moment.

const MINUTE_MS = 60 * 1000;
// Wide enough to reach past any zone's offset from UTC on either side of a
// time, and short enough that no zone changes its offset twice in between.
const PROBE_MS = 24 * 60 * MINUTE_MS;
// The largest UTC offset a clock has (UTC+14, Kiritimati; the farthest west
// is UTC-12).
const MAX_UTC_OFFSET_MINUTES = 14 * 60;

const pad2 = (n) => String(n).padStart(2, "0");

// "YYYY-MM-DDTHH:MM[:SS]" of a real calendar date and wall time (checked by
// reading the digits as UTC and back), followed by "(UTC±H[:MM])".
const SHOWN_ISO = /^\s*(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?\s*\(UTC([+-])(0|[1-9]|1[0-4])(?::([0-5]\d))?\)\s*$/;
const NAIVE_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/**
 * A moment's wall-clock digits ("YYYY-MM-DDTHH:MM:SS") and UTC offset
 * (minutes east) in `timeZone`, or on the JavaScript clock (the digits
 * toNaiveIso prints) when no zone is named.
 * @param {number} ms
 * @param {string} [timeZone] - IANA zone
 * @returns {{digits: string, offsetMinutes: number}}
 */
export function wallClockAt(ms, timeZone) {
  const d = new Date(ms);
  if (!timeZone) {
    const digits = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    return { digits, offsetMinutes: -d.getTimezoneOffset() };
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const digits = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const wallAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const wholeSecond = ms - (((ms % 1000) + 1000) % 1000);
  return { digits, offsetMinutes: Math.round((wallAsUtc - wholeSecond) / MINUTE_MS) };
}

/**
 * Every moment (epoch ms, ascending) at which the clock of `timeZone` (or the
 * JavaScript clock) reads `digits`: one, two inside the hour the clocks
 * repeat, none inside the hour they skip. The offsets the zone has a day
 * either side of the digits are every offset they can be read with.
 * @param {string} digits - "YYYY-MM-DDTHH:MM:SS"
 * @param {string} [timeZone]
 * @returns {number[]}
 */
export function instantsOnClock(digits, timeZone) {
  const m = NAIVE_ISO.exec(String(digits));
  if (!m) return [];
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const found = new Set();
  for (const probe of [wallAsUtc - PROBE_MS, wallAsUtc + PROBE_MS]) {
    const ms = wallAsUtc - wallClockAt(probe, timeZone).offsetMinutes * MINUTE_MS;
    if (wallClockAt(ms, timeZone).digits === digits) found.add(ms);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The label of a UTC offset (minutes east): "UTC-4", "UTC+5:30", "UTC+0".
 * @param {number} offsetMinutes
 * @returns {string}
 */
export function utcOffsetLabel(offsetMinutes) {
  const abs = Math.abs(offsetMinutes);
  const minutes = abs % 60;
  return `UTC${offsetMinutes < 0 ? "-" : "+"}${Math.floor(abs / 60)}${minutes ? `:${pad2(minutes)}` : ""}`;
}

/**
 * The UTC offset label a moment is printed with, or null: only a moment
 * whose digits in `timeZone` (or on the JavaScript clock) name two moments,
 * the hour the clocks repeat, has one.
 * @param {number} ms
 * @param {string} [timeZone]
 * @returns {string|null}
 */
export function repeatedHourOffset(ms, timeZone) {
  if (!Number.isFinite(ms)) return null;
  const { digits, offsetMinutes } = wallClockAt(ms, timeZone);
  return instantsOnClock(digits, timeZone).length > 1 ? utcOffsetLabel(offsetMinutes) : null;
}

/**
 * A moment as the tools print it: its naive ISO digits in `timeZone` (or on
 * the JavaScript clock), followed by " (UTC±H[:MM])" only in the hour the
 * clocks repeat.
 * @param {number} ms
 * @param {string} [timeZone]
 * @returns {string}
 */
export function toShownIso(ms, timeZone) {
  const { digits } = wallClockAt(ms, timeZone);
  const label = repeatedHourOffset(ms, timeZone);
  return label ? `${digits} (${label})` : digits;
}

/**
 * A value printed with its UTC offset, read back: its digits (seconds
 * added), the offset (minutes east) and the moment it names (epoch ms), or
 * null for any other string. The offset is taken as given, whatever clock
 * printed it.
 * @param {string} s
 * @returns {{digits: string, offsetMinutes: number, ms: number}|null}
 */
export function parseShownIso(s) {
  const m = SHOWN_ISO.exec(String(s ?? ""));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const sec = Number(m[6] || 0);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, sec);
  const digits = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${pad2(sec)}`;
  if (isNaN(wallAsUtc) || new Date(wallAsUtc).toISOString().slice(0, 19) !== digits) return null;
  const offsetMinutes = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9] || 0));
  if (Math.abs(offsetMinutes) > MAX_UTC_OFFSET_MINUTES) return null;
  return { digits, offsetMinutes, ms: wallAsUtc - offsetMinutes * MINUTE_MS };
}

/**
 * A value printed with its UTC offset in the form the tools print it
 * ("YYYY-MM-DDTHH:MM:SS (UTC±H[:MM])"), or null for any other string, which
 * the caller reads as a naive time (toNaiveIso).
 * @param {string} s
 * @returns {string|null}
 */
export function canonicalShownIso(s) {
  const shown = parseShownIso(s);
  return shown ? `${shown.digits} (${utcOffsetLabel(shown.offsetMinutes)})` : null;
}
