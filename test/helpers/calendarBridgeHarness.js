/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Runs the REAL tmCalendar.sys.mjs as a classic script (as Thunderbird's
// experiment loader does) against a minimal in-memory calendar, so tests can
// drive the bridge's query/details producers rather than a hand-written mock
// of their output. calIDateTime is replaced by a fake that keeps the ONE
// semantic these tests depend on: an RFC 5545 DATE has no zone and no instant,
// and `compare` treats it as equal to any date-time on the same day.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const UTC_ZONE = { tzid: 'UTC' };
const LOCAL_ZONE = { tzid: 'floating-local' };

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Fake calIDateTime. `month` is 0-based like the real interface. A DATE
 * (`isDate: true`) reports UTC midnight of its digits as `nativeTime`, which
 * is what ical.js does when it skips zone conversion for date-only values.
 */
export function fakeCalDateTime({ year, month, day, hour = 0, minute = 0, second = 0, isDate = false, timezone = LOCAL_ZONE } = {}) {
  const dt = { year, month, day, hour, minute, second, isDate, timezone };
  dt.resetTo = (y, mo, d, h, mi, s, tz) => {
    Object.assign(dt, { year: y, month: mo, day: d, hour: h, minute: mi, second: s, timezone: tz || LOCAL_ZONE });
    return dt;
  };
  const epochMs = () => (dt.isDate
    ? Date.UTC(dt.year, dt.month, dt.day)
    : (dt.timezone === UTC_ZONE
      ? Date.UTC(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)
      : new Date(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second).getTime()));
  Object.defineProperty(dt, 'nativeTime', { get: () => epochMs() * 1000 });
  dt.getInTimezone = (tz) => {
    if (dt.isDate) return dt; // ical.js: no conversion for DATE values
    const u = new Date(epochMs());
    if (tz === UTC_ZONE) {
      return fakeCalDateTime({ year: u.getUTCFullYear(), month: u.getUTCMonth(), day: u.getUTCDate(), hour: u.getUTCHours(), minute: u.getUTCMinutes(), second: u.getUTCSeconds(), timezone: UTC_ZONE });
    }
    return fakeCalDateTime({ year: u.getFullYear(), month: u.getMonth(), day: u.getDate(), hour: u.getHours(), minute: u.getMinutes(), second: u.getSeconds(), timezone: LOCAL_ZONE });
  };
  dt.clone = () => fakeCalDateTime({ ...dt });
  dt.compare = (other) => {
    if (dt.isDate || other.isDate) {
      // CalDateTime.compare: date-only comparison when either side is a DATE.
      const a = dt.getInTimezone(LOCAL_ZONE), b = other.getInTimezone(LOCAL_ZONE);
      const ka = [a.year, a.month, a.day], kb = [b.year, b.month, b.day];
      for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    }
    return Math.sign(epochMs() - other.nativeTime / 1000);
  };
  dt.toString = () => (dt.isDate
    ? `${dt.year}${pad2(dt.month + 1)}${pad2(dt.day)}`
    : `${dt.year}${pad2(dt.month + 1)}${pad2(dt.day)}T${pad2(dt.hour)}${pad2(dt.minute)}${pad2(dt.second)}${dt.timezone === UTC_ZONE ? 'Z' : ''}`);
  return dt;
}

/** A DATE value from "YYYY-MM-DD" digits. */
export function fakeDate(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  return fakeCalDateTime({ year: y, month: m - 1, day: d, isDate: true });
}

/** A local wall-clock date-time from "YYYY-MM-DD" digits and an hour. */
export function fakeDateTime(dayStr, hour, minute = 0) {
  const [y, m, d] = dayStr.split('-').map(Number);
  return fakeCalDateTime({ year: y, month: m - 1, day: d, hour, minute });
}

/**
 * Load the bridge with one in-memory calendar holding `items`. Returns the
 * experiment API plus the recorded provider calls, so a test can assert the
 * provider's bounded range query is the ONLY window filter.
 */
export function loadCalendarBridge(bridgePath, { items = [], calendarId = 'cal1' } = {}) {
  const getItemsCalls = [];
  const calendar = {
    id: calendarId,
    name: 'Personal',
    getItems(filter, count, start, end) {
      getItemsCalls.push({ filter, count, start, end });
      return new ReadableStream({ start(c) { c.enqueue(items.slice()); c.close(); } });
    },
    async getItem(id) { return items.find((it) => String(it.id) === String(id)) || null; },
  };
  const cal = {
    manager: { getCalendars: () => [calendar] },
    timezoneService: { UTC: UTC_ZONE, defaultTimezone: LOCAL_ZONE, getTimezone: () => null },
  };
  const ctx = vm.createContext({
    Date, ReadableStream, Intl,
    console: { log() {}, warn() {}, error() {} },
    Ci: { calICalendar: { ITEM_FILTER_TYPE_EVENT: 1, ITEM_FILTER_INCLUDE_OCCURRENCES: 2 }, calIDateTime: {}, nsITimer: {} },
    // The datetime contract is the only XPCOM lookup the query/details paths
    // need; timers are optional (the bridge resolves without them).
    Cc: new Proxy({}, {
      get(_t, key) {
        if (key === '@mozilla.org/calendar/datetime;1') return { createInstance: () => fakeCalDateTime() };
        throw new Error(`XPCOM Cc[${String(key)}] lookup`);
      },
    }),
    ChromeUtils: {
      importESModule(url) {
        if (url.includes('ExtensionCommon')) return { ExtensionCommon: { ExtensionAPI: class {} } };
        if (url.includes('calUtils')) return { cal };
        throw new Error(`unexpected importESModule(${url})`);
      },
      generateQI: () => () => {},
    },
  });
  vm.runInContext(readFileSync(bridgePath, 'utf8'), ctx, { filename: 'tmCalendar.sys.mjs' });
  const api = new ctx.tmCalendar().getAPI({}).tmCalendar;
  return { api, getItemsCalls, calendar };
}
