/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Runs the REAL tmCalendar.sys.mjs as a classic script (as Thunderbird's
// experiment loader does) against an in-memory calendar provider, so tests
// drive the bridge's query/details/modify producers rather than a hand-written
// mock of their output.
//
// calIDateTime is a fake that keeps the semantics these tests depend on:
//   - an RFC 5545 DATE has no zone and no instant; its `nativeTime` is UTC
//     midnight of its digits (what ical.js yields when it skips conversion);
//   - `compare` is date-only when either side is a DATE.
// The provider mirrors CalMemoryCalendar.getItems: it honours the event-type
// filter, the count bound (0 = unlimited) and cal.item.checkIfInRange over
// [rangeStart, rangeEnd), expanding a recurring master into its occurrences.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const UTC_ZONE = { tzid: 'UTC' };
export const LOCAL_ZONE = { tzid: 'floating-local' };

const pad2 = (n) => String(n).padStart(2, '0');

export function fakeCalDateTime({ year, month, day, hour = 0, minute = 0, second = 0, isDate = false, timezone } = {}) {
  const dt = { year, month, day, hour, minute, second, isDate, timezone: timezone || (isDate ? UTC_ZONE : LOCAL_ZONE) };
  dt.resetTo = (y, mo, d, h, mi, s, tz) => {
    Object.assign(dt, { year: y, month: mo, day: d, hour: h, minute: mi, second: s, timezone: tz || LOCAL_ZONE });
    return dt;
  };
  const epochMs = () => {
    if (dt.isDate) return Date.UTC(dt.year, dt.month, dt.day);
    return dt.timezone === UTC_ZONE
      ? Date.UTC(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)
      : new Date(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second).getTime();
  };
  Object.defineProperty(dt, 'nativeTime', { get: () => epochMs() * 1000 });
  dt.getInTimezone = (tz) => {
    if (dt.isDate) return dt; // ical.js: no conversion for DATE values
    const u = new Date(epochMs());
    return tz === UTC_ZONE
      ? fakeCalDateTime({ year: u.getUTCFullYear(), month: u.getUTCMonth(), day: u.getUTCDate(), hour: u.getUTCHours(), minute: u.getUTCMinutes(), second: u.getUTCSeconds(), timezone: UTC_ZONE })
      : fakeCalDateTime({ year: u.getFullYear(), month: u.getMonth(), day: u.getDate(), hour: u.getHours(), minute: u.getMinutes(), second: u.getSeconds(), timezone: LOCAL_ZONE });
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
  dt.subtractDate = (other) => {
    const seconds = Math.round((epochMs() - other.nativeTime / 1000) / 1000);
    return { inSeconds: Math.abs(seconds), isNegative: seconds < 0 };
  };
  dt.addDuration = (dur) => {
    const u = new Date(epochMs() + (dur.isNegative ? -1 : 1) * dur.inSeconds * 1000);
    dt.resetTo(u.getFullYear(), u.getMonth(), u.getDate(), u.getHours(), u.getMinutes(), u.getSeconds(), LOCAL_ZONE);
    return dt;
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
 * A calIEvent-like item. `occurrences` (on a master) makes it a recurring
 * series: each occurrence gets `parentItem`, shares the master's id (a
 * RECURRENCE-ID distinguishes them, exactly as in Thunderbird) and its own
 * `recurrenceId`.
 */
export function fakeEvent({ id, title, startDate, endDate, recurrenceId = null, properties = {}, occurrences = null }) {
  const props = new Map(Object.entries(properties));
  const ev = {
    id, title, startDate, endDate, recurrenceId, parentItem: null, calendar: null, recurrenceInfo: null,
    descriptionText: '',
    isEvent: () => true,
    getProperty: (k) => (props.has(k) ? props.get(k) : null),
    setProperty: (k, v) => { props.set(k, v); },
    deleteProperty: (k) => { props.delete(k); },
    getAttendees: () => [],
    clone() {
      const c = fakeEvent({ id: ev.id, title: ev.title, startDate: ev.startDate.clone(), endDate: ev.endDate.clone(), recurrenceId: ev.recurrenceId, properties: Object.fromEntries(props) });
      c.parentItem = ev.parentItem; c.calendar = ev.calendar; c.recurrenceInfo = ev.recurrenceInfo;
      return c;
    },
  };
  if (occurrences) {
    for (const occ of occurrences) { occ.parentItem = ev; occ.id = ev.id; }
    ev.recurrenceInfo = {
      occurrences,
      getRecurrenceItems: () => [],
      // CalRecurrenceInfo keys exceptions by icalString: a DATE ("20261007")
      // and a same-day DATE-TIME ("20261007T000000") are different identities,
      // so the lookup is type-sensitive, never `compare`. On a miss the native
      // implementation does NOT return null: it hands back a fresh proxy
      // occurrence for that RECURRENCE-ID (item.createProxy), which a later
      // modifyItem persists as a NEW exception. A fake that returned null here
      // would let the calendar scan repair a wrongly-typed lookup and hide it.
      getOccurrenceFor: (rid) => {
        const hit = occurrences.find((o) => o.recurrenceId.toString() === rid.toString());
        if (hit) return hit;
        const proxy = fakeEvent({ id: ev.id, title: ev.title, startDate: rid.clone(), endDate: ev.endDate.clone(), recurrenceId: rid.clone(), properties: Object.fromEntries(props) });
        proxy.parentItem = ev; proxy.calendar = ev.calendar; proxy.recurrenceInfo = null;
        return proxy;
      },
    };
  }
  return ev;
}

// cal.dtz.ensureDateTime: a DATE takes part in range checks as a date-time.
function ensureDateTime(dt) {
  if (!dt || !dt.isDate) return dt;
  const c = dt.clone(); c.isDate = false; return c;
}

// cal.item.checkIfInRange for events (calItemUtils.sys.mjs).
function inRange(item, rangeStart, rangeEnd) {
  const start = ensureDateTime(item.startDate);
  const end = ensureDateTime(item.endDate || item.startDate);
  const qs = ensureDateTime(rangeStart), qe = ensureDateTime(rangeEnd);
  if (start.compare(end) === 0) {
    return (!qs || start.compare(qs) >= 0) && (!qe || start.compare(qe) < 0);
  }
  return (!qe || start.compare(qe) < 0) && (!qs || end.compare(qs) > 0);
}

const ITEM_FILTER_TYPE_EVENT = 1;
const ITEM_FILTER_INCLUDE_OCCURRENCES = 2;

/**
 * Load the bridge with one in-memory calendar holding `items` (masters; a
 * recurring master carries its occurrences). Returns the experiment API, the
 * recorded provider calls, and the provider itself for state assertions.
 */
export function loadCalendarBridge(bridgePath, { items = [], calendarId = 'cal1' } = {}) {
  const getItemsCalls = [];
  const modifications = [];
  const calendar = {
    id: calendarId,
    name: 'Personal',
    items,
    getItems(filter, count, start, end) {
      getItemsCalls.push({ filter, count, start, end });
      const found = [];
      if (filter & ITEM_FILTER_TYPE_EVENT) {
        for (const master of items) {
          if ((filter & ITEM_FILTER_INCLUDE_OCCURRENCES) && master.recurrenceInfo) {
            for (const occ of master.recurrenceInfo.occurrences) if (inRange(occ, start, end)) found.push(occ);
          } else if (inRange(master, start, end)) {
            found.push(master);
          }
        }
      }
      const bounded = count > 0 ? found.slice(0, count) : found;
      return new ReadableStream({ start(c) { c.enqueue(bounded); c.close(); } });
    },
    async getItem(id) { return items.find((it) => String(it.id) === String(id)) || null; },
    async modifyItem(newItem, oldItem) {
      modifications.push({ newItem, oldItem });
      if (oldItem.parentItem) {
        // An occurrence edit persists through recurrenceInfo.modifyException:
        // keyed by the RECURRENCE-ID's icalString, replacing the exception with
        // that key or ADDING one (the proxy-on-miss path above lands here).
        const list = oldItem.parentItem.recurrenceInfo.occurrences;
        const key = newItem.recurrenceId.toString();
        const idx = list.findIndex((o) => o.recurrenceId.toString() === key);
        if (idx < 0) list.push(newItem); else list[idx] = newItem;
        return newItem;
      }
      // A master/single item is replaced by identity, exactly one row.
      const idx = items.indexOf(oldItem);
      if (idx < 0) throw new Error('modifyItem: unknown target');
      items[idx] = newItem;
      return newItem;
    },
  };
  for (const master of items) {
    master.calendar = calendar;
    for (const occ of master.recurrenceInfo?.occurrences || []) occ.calendar = calendar;
  }
  const cal = {
    manager: { getCalendars: () => [calendar] },
    timezoneService: { UTC: UTC_ZONE, defaultTimezone: LOCAL_ZONE, getTimezone: () => null },
  };
  const ctx = vm.createContext({
    Date, ReadableStream, Intl,
    console: { log() {}, warn() {}, error() {} },
    Ci: { calICalendar: { ITEM_FILTER_TYPE_EVENT, ITEM_FILTER_INCLUDE_OCCURRENCES }, calIDateTime: {}, nsITimer: {} },
    // The datetime contract is the only XPCOM lookup the query/details/modify
    // paths need; timers are optional (the bridge resolves without them).
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
  return { api, getItemsCalls, modifications, calendar };
}
