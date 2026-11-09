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
// RFC 5545 floating time: ical.js gives it offset 0, so it compares by its digits.
export const FLOATING_ZONE = { tzid: 'floating' };
/** A zone other than the user's, at a fixed offset from UTC (minutes east). */
export function fixedZone(tzid, offsetMinutes) {
  return { tzid, offsetMinutes };
}

const pad2 = (n) => String(n).padStart(2, '0');

export function fakeCalDateTime({ year, month, day, hour = 0, minute = 0, second = 0, isDate = false, timezone } = {}) {
  const dt = { year, month, day, hour, minute, second, isDate, timezone: timezone || (isDate ? UTC_ZONE : LOCAL_ZONE) };
  dt.resetTo = (y, mo, d, h, mi, s, tz) => {
    Object.assign(dt, { year: y, month: mo, day: d, hour: h, minute: mi, second: s, timezone: tz || LOCAL_ZONE });
    return dt;
  };
  const epochMs = () => {
    if (dt.isDate) return Date.UTC(dt.year, dt.month, dt.day);
    const utcDigits = Date.UTC(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second);
    if (dt.timezone === UTC_ZONE || dt.timezone === FLOATING_ZONE) return utcDigits;
    if (typeof dt.timezone?.offsetMinutes === 'number') return utcDigits - dt.timezone.offsetMinutes * 60000;
    return new Date(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second).getTime();
  };
  Object.defineProperty(dt, 'nativeTime', { get: () => epochMs() * 1000 });
  dt.getInTimezone = (tz) => {
    if (dt.isDate) return dt; // ical.js: no conversion for DATE values
    const offsetMs = tz === UTC_ZONE || tz === FLOATING_ZONE ? 0 : (typeof tz?.offsetMinutes === 'number' ? tz.offsetMinutes * 60000 : null);
    if (offsetMs !== null) {
      const u = new Date(epochMs() + offsetMs);
      return fakeCalDateTime({ year: u.getUTCFullYear(), month: u.getUTCMonth(), day: u.getUTCDate(), hour: u.getUTCHours(), minute: u.getUTCMinutes(), second: u.getUTCSeconds(), timezone: tz });
    }
    const u = new Date(epochMs());
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

/** A wall-clock date-time from "YYYY-MM-DD" digits and an hour, in the user's zone unless `timezone` names another. */
export function fakeDateTime(dayStr, hour, minute = 0, timezone = undefined) {
  const [y, m, d] = dayStr.split('-').map(Number);
  return fakeCalDateTime({ year: y, month: m - 1, day: d, hour, minute, timezone });
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
      c.parentItem = ev.parentItem; c.calendar = ev.calendar;
      // CalItemBase.cloneItemBaseInto clones the recurrence info, so a change to
      // the clone's rule never reaches the stored item before modifyItem.
      c.recurrenceInfo = typeof ev.recurrenceInfo?.clone === 'function' ? ev.recurrenceInfo.clone(c) : ev.recurrenceInfo;
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

/**
 * A calIRecurrenceInfo holding RRULE / RDATE / EXDATE items, each an object
 * whose `icalProperty` names the property (`{ propertyName, value }`), as
 * CalRecurrenceRule and CalRecurrenceDate expose it, and changed occurrences
 * (`exceptions`, items with a `recurrenceId`). `getRecurrenceItems` returns the
 * LIVE list, as CalRecurrenceInfo does, so a caller deleting while iterating it
 * skips items exactly as in Thunderbird. As in CalRecurrenceInfo, appending
 * needs the item the info belongs to (`item`, set by the owner), and `clone`
 * copies the items and changed occurrences for a cloned owner.
 */
export function fakeRecurrenceInfo(items = [], { exceptions = [] } = {}) {
  const list = [...items];
  const changed = [...exceptions];
  const info = {
    item: null,
    occurrences: [],
    getRecurrenceItems: () => list,
    appendRecurrenceItem: (r) => {
      if (!info.item) throw new Error('NS_ERROR_NOT_INITIALIZED: recurrence info has no base item');
      list.push(r);
    },
    clone: (newItem) => Object.assign(fakeRecurrenceInfo(list, { exceptions: changed }), { item: newItem }),
    deleteRecurrenceItem: (r) => { const i = list.indexOf(r); if (i >= 0) list.splice(i, 1); },
    getOccurrenceFor: () => null,
    getExceptionIds: () => changed.map((ex) => ex.recurrenceId),
    getExceptionFor: (rid) => changed.find((ex) => ex.recurrenceId.toString() === rid.toString()) || null,
    removeExceptionFor: (rid) => { const i = changed.findIndex((ex) => ex.recurrenceId.toString() === rid.toString()); if (i >= 0) changed.splice(i, 1); },
  };
  return info;
}

// An RRULE or EXRULE value as Thunderbird reads it back: CalRecurrenceRule keeps
// the parsed ical.js Recur and re-serializes it (Recur.toJSON) as FREQ, COUNT,
// INTERVAL when above 1, the BY-parts in the order given, UNTIL, then WKST
// unless it is MO. So a rule is never read back in the order it was written.
export function canonicalRule(value) {
  const parts = new Map();
  for (const part of String(value).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) parts.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }
  const out = [`FREQ=${parts.get('FREQ')}`];
  if (parts.has('COUNT')) out.push(`COUNT=${parts.get('COUNT')}`);
  if (parts.has('INTERVAL') && Number(parts.get('INTERVAL')) > 1) out.push(`INTERVAL=${parts.get('INTERVAL')}`);
  for (const [k, v] of parts) if (!['FREQ', 'COUNT', 'INTERVAL', 'UNTIL', 'WKST'].includes(k)) out.push(`${k}=${v}`);
  if (parts.has('UNTIL')) out.push(`UNTIL=${parts.get('UNTIL')}`);
  if (parts.has('WKST') && parts.get('WKST').toUpperCase() !== 'MO') out.push(`WKST=${parts.get('WKST')}`);
  return out.join(';');
}

// A calIRecurrenceRule: setting its icalProperty parses the rule, reading it
// back gives the re-serialized value (canonicalRule). Like CalRecurrenceRule, it
// is always a positive rule whose property is RRULE, so an imported EXRULE reads
// back as one more RRULE (Thunderbird before comm-central bug 2082832, which
// keeps an EXRULE as EXRULE).
function fakeRecurrenceRule() {
  let prop = null;
  return {
    get icalProperty() { return prop; },
    set icalProperty(p) { prop = { propertyName: 'RRULE', value: canonicalRule(p.value) }; },
  };
}

/**
 * A recurrence item for `fakeRecurrenceInfo`, e.g. recurrenceItem('EXDATE', '20991020T170000').
 * An RDATE or EXDATE also carries its `date` (calIRecurrenceDate), read from the
 * value's digits in the user's zone (a `Z` value in UTC, a bare date as a DATE).
 */
export function recurrenceItem(propertyName, value) {
  if (propertyName === 'RRULE' || propertyName === 'EXRULE') {
    const rule = fakeRecurrenceRule();
    rule.icalProperty = { propertyName, value };
    return rule;
  }
  const item = { icalProperty: { propertyName, value } };
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value);
  if (m) {
    const [, y, mo, d, hh, mi, ss, z] = m;
    item.date = hh
      ? fakeCalDateTime({ year: +y, month: +mo - 1, day: +d, hour: +hh, minute: +mi, second: +ss, timezone: z ? UTC_ZONE : LOCAL_ZONE })
      : fakeCalDateTime({ year: +y, month: +mo - 1, day: +d, isDate: true });
  }
  return item;
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
export function loadCalendarBridge(bridgePath, { items = [], calendarId = 'cal1', console = { log() {}, warn() {}, error() {} } } = {}) {
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
    // CalMemoryCalendar.addItem gives a new item an id when it has none.
    async addItem(item) {
      if (!item.id) item.id = `added-${items.length + 1}`;
      item.calendar = calendar;
      items.push(item);
      return item;
    },
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
    icsService: { createIcalProperty: (propertyName) => ({ propertyName, value: '' }) },
  };
  const ctx = vm.createContext({
    Date, ReadableStream, Intl,
    console,
    Ci: { calICalendar: { ITEM_FILTER_TYPE_EVENT, ITEM_FILTER_INCLUDE_OCCURRENCES }, calIDateTime: {}, calIRecurrenceRule: {}, calIRecurrenceInfo: {}, nsITimer: {} },
    // The datetime contract is the only XPCOM lookup the query/details/modify
    // paths need; timers are optional (the bridge resolves without them).
    Cc: new Proxy({}, {
      get(_t, key) {
        if (key === '@mozilla.org/calendar/datetime;1') return { createInstance: () => fakeCalDateTime() };
        if (key === '@mozilla.org/calendar/recurrence-rule;1') return { createInstance: () => fakeRecurrenceRule() };
        if (key === '@mozilla.org/calendar/recurrence-info;1') return { createInstance: () => fakeRecurrenceInfo() };
        if (key === '@mozilla.org/calendar/event;1') {
          return { createInstance: () => Object.assign(fakeEvent({ id: null, title: '', startDate: null, endDate: null }), { addAttendee() {} }) };
        }
        if (key === '@mozilla.org/calendar/attendee;1') return { createInstance: () => ({}) };
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
  return { api, getItemsCalls, modifications, calendar, ctx };
}
