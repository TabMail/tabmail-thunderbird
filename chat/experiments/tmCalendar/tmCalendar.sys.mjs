/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Diagnostic console.log output, off in shipped builds; failures use console.warn and stay visible.
// `var` makes the flag a property of the experiment global, so it can be switched on there.
var TM_CALENDAR_DEBUG = false;
function tmCalendarDebugLog(...args) { if (TM_CALENDAR_DEBUG) console.log(...args); }

const { ExtensionCommon: ExtensionCommonTMCal } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

// tmCalendar experiment API (clean)

// -------- Duration preservation --------
// Apply start/end updates to `clone`, as Google Calendar makes them: a start
// alone keeps the event's length (the end is derived from the existing
// duration), and an end alone changes only the end, so the start stays and the
// event gets longer or shorter. Without the derivation, "move it to 3pm"
// (start_iso only) would leave the old end untouched and silently change the
// event's length, or end it before it starts. An end before the start is
// refused after this (editTimesError).
//
// IMPORTANT: TB experiment .sys.mjs files are loaded as classic scripts, NOT
// ESM modules, despite the extension. `export` here would fail at parse time
// with "export declarations may only appear at top level of a module" and
// break the entire tmCalendar API. The exported, vitest-loadable mirror lives
// in ./durationPreservationLogic.js; test/calendarDurationPreservation.test.js
// pins the function bodies to match (drift guard).
function applyDurationPreservation({
  base,
  clone,
  patch,
  toCalIDateTime,
  editTzOverride,
  log = () => {},
}) {
  // Capture original duration BEFORE we touch clone.startDate/endDate. Once
  // either side is reassigned the subtractDate result no longer reflects the
  // event's original length.
  let origDuration = null;
  try {
    if (base && base.startDate && base.endDate) {
      origDuration = base.endDate.subtractDate(base.startDate);
      // Skip derivation if duration is zero or negative. Mirrors iOS
      // GoogleCalendarProvider.mergeExistingEventWithPatch (`d > 0 ? d : nil`).
      // calIDuration exposes `.inSeconds`; the mock backs it the same way.
      if (origDuration) {
        const seconds = typeof origDuration.inSeconds === "number" ? origDuration.inSeconds : null;
        if (origDuration.isNegative || seconds === 0) origDuration = null;
      }
    }
  } catch (_) {
    origDuration = null;
  }

  const hasStartPatch = typeof patch.start_iso === "string" && !!patch.start_iso;
  const hasEndPatch = typeof patch.end_iso === "string" && !!patch.end_iso;

  if (hasStartPatch) {
    const s = toCalIDateTime(String(patch.start_iso), editTzOverride);
    if (s) clone.startDate = s;
  }
  if (hasEndPatch) {
    const e = toCalIDateTime(String(patch.end_iso), editTzOverride);
    if (e) clone.endDate = e;
  }

  if (hasStartPatch && !hasEndPatch && origDuration) {
    try {
      const newEnd = clone.startDate.clone();
      newEnd.addDuration(origDuration);
      clone.endDate = newEnd;
      log("derived endDate from new start + existing duration");
      return { derived: "end" };
    } catch (e) {
      log("failed to derive endDate from duration: " + e);
      return { derived: null, error: e };
    }
  }
  return { derived: null };
}

// -------- Calendar service accessors --------
// Thunderbird de-XPCOM'd its calendar back end. The XPCOM contracts we used to
// reach the calendar *services* through are now either unregistered or point at
// a module-level singleton instance that XPCOM still tries to `new`, so
// `getService()` fails:
//
//   @mozilla.org/calendar/manager;1          registered, but CalCalendarManager
//                                            is `export const … = new (class{})`
//                                            => "… is not a constructor",
//                                            surfaced as
//                                            NS_ERROR_XPC_GS_RETURNED_FAILURE
//   @mozilla.org/calendar/timezone-service;1 same shape, same failure
//   @mozilla.org/calendar/ics-service;1      contract removed outright
//
// Thunderbird itself reaches these three services only through the `cal`
// namespace -- no in-tree caller resolves manager, timezone-service or
// ics-service through Cc[] any more. `cal` resolves them on both the old
// (XPCOMUtils.defineLazyServiceGetter, TB 140 ESR) and current
// (ChromeUtils.defineESModuleGetters) layouts, so one code path covers this
// add-on's whole declared 140.0-155.* range. Use it here for the same reason.
// (Thunderbird does still use Cc[] for other calendar contracts -- ics-parser,
// alarm-service and friends -- so this is not a blanket "no Cc[] for calendar"
// rule; see the construction contracts below.)
//
// Object *construction* contracts (event, attendee, recurrence-*, datetime,
// ics-serializer, itip-item) still register real constructors and keep working,
// so they are deliberately left on Cc[].createInstance.
//
// No module-level cache on purpose. ChromeUtils.importESModule already hands
// back the one cached namespace object per URL, so a local cache would buy
// nothing but a mutable binding -- and every experiment parent script in this
// add-on is executed into ONE shared global (ExtensionCommon's SchemaAPIManager
// runs them all into `this.global`, via loadSubScript or script.executeInGlobal
// depending on the path), where each additional top-level binding is one more
// thing to collide with a sibling experiment or to break on re-evaluation.
// test/calendarServiceAcquisition.test.js pins the cache-free behaviour, so
// "optimising" this later has to argue with a red test.
function getCalNamespace() {
  const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
  return cal;
}

// One acquisition chokepoint. Returns the service or null, and ALWAYS logs on
// failure -- including the quiet case where calUtils imports fine but no longer
// carries the property. The Cc[].getService() this replaced threw on every
// failure, so it was always loud; returning a bare `cal[name] || null` would
// have been strictly quieter than the code it replaced, and a silent null here
// is precisely the shape that made this outage hard to diagnose in the first
// place (the user's console errors are what identified it).
function calService(name) {
  try {
    const service = getCalNamespace()[name];
    if (!service) {
      console.error(`[tmCalendar] cal.${name} is unavailable (calUtils resolved, service missing)`);
      return null;
    }
    return service;
  } catch (e) {
    console.error(`[tmCalendar] Failed to get cal.${name}:`, e);
    return null;
  }
}

function getCalendarManager() {
  return calService("manager");
}

function getTimezoneService() {
  return calService("timezoneService");
}

function getIcsService() {
  return calService("icsService");
}

// -------- Provider detection & invite policy --------
function isExchangeLike(calendar) {
  const t = String(calendar?.type || "").toLowerCase();
  // Extend list if your connector reports a different type string
  return /^(exchangecalendar|ews|owl|m365|graph)$/.test(t);
}

function isGoogleCalDAV(calendar) {
  const t = String(calendar?.type || "").toLowerCase();
  const u = String(calendar?.uri?.spec || "").toLowerCase();
  // Matches Google CalDAV endpoints seen in the wild
  return t === "caldav" &&
    /(google\.com|googleapis\.com|apidata\.googleusercontent\.com)/.test(u);
}

/**
 * Returns "server" (provider-side scheduling) or "mail" (TB iMIP).
 * Default policy:
 *   - Exchange-like: "server"
 *   - Google CalDAV: "server" (can be overridden per-calendar)
 *   - Other providers: "mail"
 *
 * Per-calendar override (string): calendar.getProperty("tabmail.google_invites")
 *   - "server" => rely on Google notifications / provider
 *   - "mail"   => send iMIP via Thunderbird
 */
function getInvitePolicy(calendar) {
  try {
    if (isExchangeLike(calendar)) return "server";
    if (isGoogleCalDAV(calendar)) {
      const override = calendar?.getProperty?.("tabmail.google_invites");
      if (override === "mail" || override === "server") return override;
      return "server"; // DEFAULT for Google as it seems to work?
    }
  } catch {}
  return "mail"; // default for everything else
}

// Optional fallback for UID matching without ICS parsing
function uidCandidates(uid) {
  const s = String(uid || "");
  const m = s.match(/^(.*)@([A-Za-z0-9.-]+)$/);
  return m ? [s, m[1]] : [s];
}

function listCalendarsInternal() {
  const mgr = getCalendarManager();
  if (!mgr) return [];
  try {
    const cals = Array.from(mgr.getCalendars({}));
    const out = cals.map((c) => ({
      id: String(c.id || ""),
      name: String((c.name || c.uri?.spec || c.id || "").toString()),
      type: String(c.type || ""),
      uri: String((c.uri && c.uri.spec) || ""),
      readOnly: !!c.readOnly,
    }));
    // debug listing suppressed
    return out;
  } catch (e) {
    console.error("[tmCalendar] listCalendarsInternal failed:", e);
    return [];
  }
}

function toIcsUntil(iso) {
  try {
    if (!iso) return null;
    const d = new Date(String(iso));
    if (isNaN(d.getTime())) return null;
    const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = d.getUTCDate().toString().padStart(2, "0");
    const hh = d.getUTCHours().toString().padStart(2, "0");
    const mi = d.getUTCMinutes().toString().padStart(2, "0");
    const ss = d.getUTCSeconds().toString().padStart(2, "0");
    return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
  } catch (_) { return null; }
}

function toIcsLocalDateTime(dt) {
  try {
    const d = dt instanceof Date ? dt : new Date(String(dt));
    if (isNaN(d.getTime())) return null;
    const yyyy = d.getFullYear().toString().padStart(4, "0");
    const mm = (d.getMonth() + 1).toString().padStart(2, "0");
    const dd = d.getDate().toString().padStart(2, "0");
    const hh = d.getHours().toString().padStart(2, "0");
    const mi = d.getMinutes().toString().padStart(2, "0");
    const ss = d.getSeconds().toString().padStart(2, "0");
    return `${yyyy}${mm}${dd}T${hh}${mi}${ss}`;
  } catch (_) { return null; }
}

function serializeItemToIcs(item) {
  try {
    const Ci = globalThis.Ci; const Cc = globalThis.Cc;
    const serializer = Cc["@mozilla.org/calendar/ics-serializer;1"].createInstance(Ci.calIIcsSerializer);
    serializer.addItems([item]);
    return String(serializer.serializeToString() || "");
  } catch (_) { return ""; }
}

function extractExdatesFromItem(item) {
  try {
    // Prefer direct property first
    let exd = "";
    try { exd = String(item.getProperty?.("EXDATE") || ""); } catch (_) {}
    if (exd) return exd;
    // Fallback: parse ICS for EXDATE lines
    const ics = serializeItemToIcs(item);
    if (!ics) return "";
    const lines = ics.split(/\r?\n/);
    const values = [];
    for (const ln of lines) {
      if (/^EXDATE[:;]/i.test(ln)) {
        const idx = ln.indexOf(":");
        if (idx > 0) {
          const val = ln.slice(idx + 1).trim();
          if (val) values.push(val);
        }
      }
    }
    return values.join(",");
  } catch (_) { return ""; }
}

// Excludes the occurrence whose RECURRENCE-ID is `rid`, at that RECURRENCE-ID
// written in the series' zone, as the split point is: Thunderbird's own
// removeOccurrenceAt, which adds the EXDATE and removes the occurrence's changed
// copy with it. An EXDATE alone would not do: Thunderbird applies one only to a
// query whose range holds its date (CalRecurrenceInfo.calculateDates), so a
// changed copy moved to another day would still show there. An all-day
// RECURRENCE-ID is written as a plain date (asAllDayDate), its day kept.
function addExdateToItem(item, rid) {
  const at = rid.isDate ? asAllDayDate(rid.clone()) : rid.getInTimezone(item.startDate.timezone);
  item.recurrenceInfo.removeOccurrenceAt(at);
  tmCalendarDebugLog("[tmCalendar] addExdateToItem: removed the occurrence at", at.toString());
}

// -------- Recurrence: one format for reading and writing --------
// The tools read a rule in the same fields they write it with (freq, interval,
// count, until, byDay, byMonthDay, byMonth, wkst), so a rule read from an event
// can be passed back unchanged. `until` is a plain date: the last day of the
// series in the event's own zone. Parts those fields cannot express are shown
// as `other` and are never written.

// Also the frequencies whose occurrences are all at the start's time of day
// (absent BYHOUR, BYMINUTE, BYSECOND), which the `until` read relies on.
const RECURRENCE_FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

// How far either side of a recurrence_id the series is expanded to find the
// occurrence starting there (occurrenceNamedBy): more than any zone's offset from
// the user's, so a DATE or a time in another zone is always inside.
const OCCURRENCE_LOOKUP_REACH_MS = 2 * 86400 * 1000;
// How many doubling windows firstOccurrenceOf searches (from 2 days: about
// 2^16 days, beyond any series' first gap).
const FIRST_OCCURRENCE_WINDOWS = 16;

function pad2(n) { return String(n).padStart(2, "0"); }

// The event's rules as RRULE values, in stored order, from its recurrence info:
// the only place Thunderbird stores and expands a rule. Its RRULE property is
// never read: it is neither imported from nor written to the stored event, so it
// can hold an older rule than the one the series follows. Thunderbird expands
// EVERY rule item, and before comm-central bug 2082832 an imported EXRULE
// becomes one more of them (its rule object is always positive and names itself
// RRULE; from that change on it stays a negative EXRULE, which isRuleItem
// skips), so a series can repeat by more than one rule even though RFC 5545
// says it SHOULD NOT.
function ruleValuesOfItem(item) {
  const values = [];
  try {
    const rinfo = item?.recurrenceInfo;
    const items = rinfo && typeof rinfo.getRecurrenceItems === "function" ? (rinfo.getRecurrenceItems({}) || []) : [];
    for (const r of items) {
      const raw = String(r?.icalProperty?.value || "");
      if (isRuleItem(r) && /\bFREQ=/i.test(raw)) values.push(raw);
    }
  } catch (_) {}
  return values;
}

// The event's first rule, the one the tools' fields describe (any further rule
// is shown as `other`), or "" when it does not repeat.
function rruleOfItem(item) {
  return ruleValuesOfItem(item)[0] || "";
}

// The zone a timed event's occurrences are expanded in: its start's own zone.
// Null for an all-day or floating event, whose values Thunderbird (ical.js)
// compares at offset 0, by their digits.
function zonedStartZone(item) {
  const start = item?.startDate;
  const tz = start && !start.isDate ? start.timezone : null;
  return tz && tz.tzid && tz.tzid !== "floating" ? tz : null;
}

// An RRULE UNTIL value as the last day of the series, "YYYY-MM-DD": the day of
// the last occurrence the bound admits. UNTIL is inclusive (RFC 5545 3.3.10). A
// `Z` value is that instant; a DATE or floating value is its digits at offset 0,
// as ical.js compares them. Read in the frame occurrences are expanded in (the
// start's zone, or offset 0), the bound's day is the last day when its time of
// day is at or after the occurrences' start time, otherwise the day before.
// Returns "" for a value that is not an UNTIL, and for a timed series' bound
// whose day Thunderbird's own comparison does not confirm (below).
function untilDayFromIcs(value, item) {
  const bound = boundFromIcs(value);
  if (!bound) return "";
  const start = item?.startDate;
  const inFrame = bound.getInTimezone(zonedStartZone(item) || getTimezoneService().UTC);
  let day = Date.UTC(inFrame.year, inFrame.month, inFrame.day);
  if (start && !start.isDate) {
    const boundTime = (inFrame.hour * 60 + inFrame.minute) * 60 + inFrame.second;
    const startTime = (start.hour * 60 + start.minute) * 60 + start.second;
    if (boundTime < startTime) day -= 86400 * 1000;
  }
  const last = new Date(day);
  const shown = `${last.getUTCFullYear()}-${pad2(last.getUTCMonth() + 1)}-${pad2(last.getUTCDate())}`;
  if (!start || start.isDate) return shown;
  // Near a daylight saving change the wall clock read above can be off by the
  // zone's shift (Thunderbird's zone conversion can move the instant, and a
  // time in the skipped interval reads that much late). The day is shown only when Thunderbird's
  // own comparison, by instant, agrees: the stored bound and the bound the edit
  // tool writes for that day each keep that day's occurrence and not the next
  // day's. Otherwise the bound stays in `other`, and restating it is refused.
  const written = boundFromIcs(untilForRRule(shown, item));
  const lastOnly = (b) => !!b && occurrenceInstantOn(day, item) <= b.nativeTime
    && occurrenceInstantOn(day + 86400 * 1000, item) > b.nativeTime;
  return lastOnly(bound) && lastOnly(written) ? shown : "";
}

// An UNTIL value as an instant: a `Z` value is that instant; a DATE or floating
// value is its digits at offset 0, as ical.js compares them. Null otherwise.
function boundFromIcs(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(String(value || "").trim());
  if (!m) return null;
  const [, y, mo, d, hh = "00", mi = "00", ss = "00"] = m;
  const bound = Cc["@mozilla.org/calendar/datetime;1"].createInstance(Ci.calIDateTime);
  bound.resetTo(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss), getTimezoneService().UTC);
  return bound;
}

// The instant of a timed series' occurrence on a day (`dayMs`, that day's UTC
// midnight) at the start's time of day, in the frame occurrences are expanded
// in, as Thunderbird computes it.
function occurrenceInstantOn(dayMs, item) {
  const start = item.startDate;
  const day = new Date(dayMs);
  const at = Cc["@mozilla.org/calendar/datetime;1"].createInstance(Ci.calIDateTime);
  at.resetTo(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), start.hour, start.minute, start.second, zonedStartZone(item) || getTimezoneService().UTC);
  return at.nativeTime;
}

// An event's rule in the tools' fields, or null when it does not repeat.
function recurrenceFieldsOfItem(item) {
  const [rrule, ...furtherRules] = ruleValuesOfItem(item);
  if (!rrule) return null;
  const f = {};
  const other = [];
  // `until` is read as the day of the last occurrence at the start's time of
  // day. A rule that also repeats at other times of day (BYHOUR, BYMINUTE,
  // BYSECOND, or a frequency finer than a day) can end on another day, so its
  // UNTIL goes to `other`.
  const keyed = new Map(rrule.split(";").map((part) => part.split("=").map((s) => s.trim().toUpperCase())));
  const startTimeOnly = RECURRENCE_FREQS.includes(keyed.get("FREQ"))
    && !["BYHOUR", "BYMINUTE", "BYSECOND"].some((k) => keyed.has(k));
  for (const part of rrule.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const val = part.slice(eq + 1).trim();
    if (key === "FREQ" && RECURRENCE_FREQS.includes(val.toUpperCase())) f.freq = val.toUpperCase();
    else if (key === "INTERVAL" && /^\d+$/.test(val)) f.interval = Number(val);
    else if (key === "COUNT" && /^\d+$/.test(val)) f.count = Number(val);
    else if (key === "UNTIL" && startTimeOnly && untilDayFromIcs(val, item)) f.until = untilDayFromIcs(val, item);
    else if (key === "BYDAY") f.byDay = val.toUpperCase().split(",");
    else if (key === "BYMONTHDAY") f.byMonthDay = val.split(",").map(Number);
    else if (key === "BYMONTH") f.byMonth = val.split(",").map(Number);
    else if (key === "WKST") f.wkst = val.toUpperCase();
    // Anything else goes to `other`, BYSETPOS included: it is never folded
    // into an ordinal byDay, because the Thunderbird versions this add-on
    // supports do not all expand BYDAY=TU;BYSETPOS=2 and BYDAY=2TU to the
    // same days.
    else other.push(part.trim());
  }
  // A further rule adds its own occurrences, which the fields above cannot
  // express: shown in `other`, so restating the fields (which would leave one
  // rule) is refused and the series keeps every rule.
  for (const further of furtherRules) other.push(`RRULE:${further}`);
  const out = {};
  for (const k of ["freq", "interval", "count", "until", "byDay", "byMonthDay", "byMonth", "wkst"]) if (k in f) out[k] = f[k];
  if (other.length) out.other = other.join(";");
  return out;
}

// `until` for an RRULE, from the tools' plain date (the last day of the
// series): the end of that day in the value type of the start (RFC 5545
// 3.3.10). A bare DATE on an all-day event, a floating 23:59:59 on a floating
// one, otherwise 23:59:59 in the start's zone rendered as UTC, so the named
// day's occurrence is in the series. "" for anything else (the tools refuse it).
function untilForRRule(until, item) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(until));
  if (!m) return "";
  const [, y, mo, d] = m;
  const zone = zonedStartZone(item);
  if (item?.startDate?.isDate) return `${y}${mo}${d}`;
  if (!zone) return `${y}${mo}${d}T235959`;
  const dt = Cc["@mozilla.org/calendar/datetime;1"].createInstance(Ci.calIDateTime);
  dt.resetTo(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, zone);
  const u = dt.getInTimezone(getTimezoneService().UTC);
  return `${u.year}${pad2(u.month + 1)}${pad2(u.day)}T${pad2(u.hour)}${pad2(u.minute)}${pad2(u.second)}Z`;
}

// The RRULE value for validated fields (the tools refuse invalid ones before the
// confirmation card). Returns "" for `{}`, which clears the rule.
function buildRRuleValueFromDetails(details, item) {
  if (!details || typeof details !== "object" || !details.freq) return "";
  const parts = [`FREQ=${details.freq}`];
  if (Number(details.interval) > 1) parts.push(`INTERVAL=${details.interval}`);
  if (details.count) parts.push(`COUNT=${details.count}`);
  const until = details.until ? untilForRRule(details.until, item) : "";
  if (until) parts.push(`UNTIL=${until}`);
  if (Array.isArray(details.byDay) && details.byDay.length) parts.push(`BYDAY=${details.byDay.join(",")}`);
  if (Array.isArray(details.byMonthDay) && details.byMonthDay.length) parts.push(`BYMONTHDAY=${details.byMonthDay.join(",")}`);
  if (Array.isArray(details.byMonth) && details.byMonth.length) parts.push(`BYMONTH=${details.byMonth.join(",")}`);
  if (details.wkst) parts.push(`WKST=${details.wkst}`);
  return parts.join(";");
}

function isRuleItem(r) {
  try { return String(r?.icalProperty?.propertyName || "").toUpperCase() === "RRULE"; } catch (_) { return false; }
}

// A series' rule cancelling occurrences (EXRULE). Thunderbird keeps one as a
// negative rule from comm-central bug 2082832 on (see ruleValuesOfItem).
function isNegativeRuleItem(r) {
  try { return String(r?.icalProperty?.propertyName || "").toUpperCase() === "EXRULE"; } catch (_) { return false; }
}

// Writes `value` into one rule item, in place, so the rule keeps its position
// among the series' rules (the first is the one the tools' fields describe).
// Every writer of a rule value goes through here.
function writeRuleItem(rule, value) {
  const prop = getIcsService().createIcalProperty("RRULE");
  prop.value = value;
  rule.icalProperty = prop;
}

// Writes `value` as the item's rule. Replaces only the RRULE items in the item's
// own recurrence info, so its excluded dates (EXDATE), added dates (RDATE) and
// changed occurrences stay with the series; creates the recurrence info when the
// item has none.
function setRuleOnItem(item, value) {
  const rule = Cc["@mozilla.org/calendar/recurrence-rule;1"].createInstance(Ci.calIRecurrenceRule);
  writeRuleItem(rule, value);
  let rinfo = item.recurrenceInfo;
  if (rinfo) {
    // A copy: the native list is live, and deleting from it while iterating
    // skips the item after each one deleted.
    for (const r of [...(rinfo.getRecurrenceItems({}) || [])]) {
      if (isRuleItem(r)) rinfo.deleteRecurrenceItem(r);
    }
  } else {
    rinfo = Cc["@mozilla.org/calendar/recurrence-info;1"].createInstance(Ci.calIRecurrenceInfo);
    rinfo.item = item;
    item.recurrenceInfo = rinfo;
  }
  rinfo.appendRecurrenceItem(rule);
}

// The occurrence of `item`'s series that a recurrence_id names, for every edit
// that targets occurrences (one occurrence, or this and the following ones), and
// that an exdates_add value names (`field`, for the error).
// The tools document recurrence_id as the occurrence's start_iso, which the read
// tools print in the user's zone (a floating time at its own digits, asShown),
// and for an all-day series as its date. It is read in the user's zone whatever
// `timezone` the edit names: that zone is for the edit's new times. Thunderbird's own expansion of the series (every
// rule, added and excluded date, and a changed occurrence at its own time)
// decides which occurrence starts there. `{ occurrence }`, whose recurrenceId is
// the series' own RECURRENCE-ID for it, or `{ error }` when no occurrence, or
// more than one, starts there: nothing is ever written for a time that is not
// an occurrence (getOccurrenceFor would make one up for any time).
function occurrenceNamedBy(item, iso, field = "recurrence_id") {
  const at = toCalIDateTime(String(iso || ""));
  if (!at) return { error: `invalid ${field} format (expected ISO8601)` };
  if (item?.startDate?.isDate) at.isDate = true;
  // A range wide enough for any zone's offset from the user's; only an
  // occurrence that starts exactly there counts.
  const ms = at.nativeTime / 1000;
  const from = boundFromIcs(toIcsUntil(new Date(ms - OCCURRENCE_LOOKUP_REACH_MS).toISOString()));
  const to = boundFromIcs(toIcsUntil(new Date(ms + OCCURRENCE_LOOKUP_REACH_MS).toISOString()));
  if (!from || !to || !item?.recurrenceInfo) return { error: `${field} ${iso} is not the start of an occurrence of this series` };
  const starting = [...(item.recurrenceInfo.getOccurrences(from, to, 0) || [])]
    .filter((occ) => occ?.startDate && occ.startDate.compare(at) === 0);
  if (starting.length === 1) return { occurrence: starting[0] };
  return {
    error: starting.length
      ? `${field} ${iso} is the start of more than one occurrence of this series; change it in the calendar app`
      : `${field} ${iso} is not the start of an occurrence of this series; pass the occurrence's start_iso as the read tools show it`,
  };
}

// The first occurrence `series` actually has, as Thunderbird expands it
// (getOccurrences: a changed occurrence at its own time, an excluded date
// gone), or null when it has none. It is not always the series' DTSTART: the
// occurrence there may be moved (earlier or later) or excluded. No occurrence
// starts before the earliest of DTSTART and every changed occurrence's start,
// so getOccurrences runs from just before that (the reach covers a floating
// or zone-relabelled value) to an end that doubles until it holds one.
function firstOccurrenceOf(series) {
  const info = series?.recurrenceInfo;
  if (!info || !series.startDate) return null;
  const startMs = series.startDate.nativeTime / 1000;
  let earliestMs = startMs;
  for (const rid of info.getExceptionIds?.() || []) {
    const ex = info.getExceptionFor(rid);
    if (ex?.startDate) earliestMs = Math.min(earliestMs, ex.startDate.nativeTime / 1000);
  }
  const from = boundFromIcs(toIcsUntil(new Date(earliestMs - OCCURRENCE_LOOKUP_REACH_MS).toISOString()));
  let reach = OCCURRENCE_LOOKUP_REACH_MS;
  for (let i = 0; i < FIRST_OCCURRENCE_WINDOWS; i++, reach *= 2) {
    const to = boundFromIcs(toIcsUntil(new Date(startMs + reach).toISOString()));
    if (!from || !to) return null;
    const found = [...(info.getOccurrences(from, to, 0) || [])].filter((occ) => occ?.startDate);
    if (found.length) {
      return found.reduce((a, b) => (b.startDate.compare(a.startDate) < 0 ? b : a));
    }
  }
  return null;
}

// Whether `rid`, a RECURRENCE-ID of `master`'s series, is its first occurrence:
// the one Thunderbird expands first (firstOccurrenceOf), the one the read tools
// show for the series. It is the series' own start unless that occurrence is
// excluded or moved (#386). A whole-series time change names this one (#287),
// and a split here would leave no occurrence before it.
function isFirstOccurrence(master, rid) {
  const first = firstOccurrenceOf(master);
  return !!first && first.recurrenceId.compare(rid) === 0;
}

// The fields an edit can name other than its times, as stored on `item` (an
// event, a series, or one occurrence of a series), for getCalendarEventDetails:
// the title, the place, the notes as queryCalendarItems reads them, and
// busy/free.
function editableFieldsOf(item) {
  return {
    title: item.title || "",
    location: item.getProperty ? String(item.getProperty("LOCATION") || "") : "",
    description: String(item.getProperty?.("DESCRIPTION") || ""),
    transparency: (() => {
      try {
        const raw = String(item.getProperty?.("TRANSP") || "");
        const mapped = raw.toUpperCase() === "TRANSPARENT" ? "free" : "busy";
        tmCalendarDebugLog("[tmCalendar] getCalendarEventDetails: TRANSP=", raw || "(empty)", "mapped=", mapped);
        return mapped;
      } catch (_) { return "busy"; }
    })(),
  };
}

// The RECURRENCE-IDs of the occurrences an edit's exdates_add names, each by its
// start as the read tools show it (occurrenceNamedBy), in the series as it is
// before the edit. An EXDATE removes an occurrence by its RECURRENCE-ID, which
// for a changed occurrence is not its start. `{ rids }`, or `{ error }` when a
// value names no occurrence: nothing is written then.
function exdatesNamedBy(item, isos) {
  const rids = [];
  for (const iso of isos) {
    const named = occurrenceNamedBy(item, iso, "exdates_add");
    if (named.error) return { error: named.error };
    rids.push(named.occurrence.recurrenceId);
  }
  return { rids };
}

// A DATE's day `days` days away, as [YYYY, MM, DD] from its own digits. A DATE's
// epoch time depends on the zone it carries (an all-day event TabMail made
// before #303 is a DATE in the user's zone), so all-day day arithmetic never
// uses it.
function dayDigitsFrom(date, days) {
  const d = new Date(Date.UTC(date.year, date.month, date.day + days));
  return [String(d.getUTCFullYear()).padStart(4, "0"), pad2(d.getUTCMonth() + 1), pad2(d.getUTCDate())];
}

// The DATE `days` days after `date`, in its zone.
function dayDateFrom(date, days) {
  const [y, m, d] = dayDigitsFrom(date, days).map(Number);
  const out = date.clone();
  out.resetTo(y, m - 1, d, 0, 0, 0, date.timezone);
  out.isDate = true;
  return out;
}

// The day-naming parts of a rule a plain shift can move (#287): a weekday list
// and a list of month days. Any other part that names days (an ordinal or
// last-of weekday, a set position, a year day, a week number, a month crossed)
// cannot be moved by a whole number of days and is refused.
const RULE_SHIFT_WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
// The week start a rule has when it names none (RFC 5545 3.3.10).
const RULE_DEFAULT_WKST = "MO";
// The last month day every month has: a rule on a later one skips the shorter
// months, so a move onto or off one would drop or add occurrences.
const DAYS_IN_SHORTEST_MONTH = 28;
const FEBRUARY = 1; // calIDateTime months count from 0
const LEAP_DAY = 29;
const SET_TIME_PARTS = /^(BYHOUR|BYMINUTE|BYSECOND)=/i;

// A rule value shifted by `days` days, `{ value }`, or `{ error }` when its
// occurrences cannot all move by that much. `was` and `now` are the series'
// start before and after the move, in its own frame. The refusals are the
// cases where ical.js would, or could, expand the shifted rule to other dates
// than the old occurrences moved by `days` (a leap day is refused either way).
function ruleShiftedByDays(value, days, was, now) {
  const refused = { error: "this series repeats on days its rule names in a way a move cannot carry (for example the second Tuesday, or the last day of the month), so it cannot be moved to another day here; move only its time of day, or tell the user to change its days in their calendar app" };
  const parts = String(value).split(";").map((p) => p.trim()).filter(Boolean);
  const valueOf = (key) => {
    const part = parts.find((p) => p.split("=")[0].toUpperCase() === key);
    return part === undefined ? null : String(part.split("=")[1] || "").toUpperCase();
  };
  const freq = valueOf("FREQ");
  const interval = Number(valueOf("INTERVAL") || 1);
  const monthChanged = was.month !== now.month || was.year !== now.year;
  const shiftDay = (code) => RULE_SHIFT_WEEKDAYS[(((RULE_SHIFT_WEEKDAYS.indexOf(code) + days) % 7) + 7) % 7];
  const inEveryMonth = (day) => day >= 1 && day <= DAYS_IN_SHORTEST_MONTH;
  // A rule with no day part repeats on its start's day: monthly on its day of
  // the month, yearly on its day of the year.
  const dayFromStart = ["BYDAY", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO"].every((key) => valueOf(key) === null);
  if (dayFromStart && freq === "MONTHLY" && (monthChanged || !inEveryMonth(was.day) || !inEveryMonth(now.day))) return refused;
  if (dayFromStart && freq === "YEARLY") {
    const isLeapDay = (d) => d.month === FEBRUARY && d.day === LEAP_DAY;
    const ms = (d) => Date.UTC(d.year, d.month, d.day);
    const [from, to] = [ms(was), ms(now)].sort((a, b) => a - b);
    // The end of February moves with the leap years, so a move across it does not
    // keep the days between the occurrences.
    const crossesMarch = [was.year, now.year].some((y) => from < Date.UTC(y, FEBRUARY + 1, 1) && Date.UTC(y, FEBRUARY + 1, 1) <= to);
    if (isLeapDay(was) || isLeapDay(now) || crossesMarch) return refused;
  }
  const out = [];
  for (const part of parts) {
    const [name, list] = part.split("=");
    const key = String(name).toUpperCase();
    if (key === "BYDAY") {
      // A weekday list moves exactly only where every occurrence's week or
      // period is cut where the moved days are: not inside named months, and,
      // when it repeats every few weeks, with its week start moved too (below).
      if (valueOf("BYMONTH") !== null) return refused;
      if (interval > 1 && freq !== "WEEKLY" && freq !== "DAILY") return refused;
      const shifted = [];
      for (const day of String(list).split(",")) {
        const code = day.trim().toUpperCase();
        if (!RULE_SHIFT_WEEKDAYS.includes(code)) return refused;
        shifted.push(shiftDay(code));
      }
      out.push(`BYDAY=${shifted.join(",")}`);
    } else if (key === "BYMONTHDAY") {
      const shifted = [];
      for (const day of String(list).split(",")) {
        if (!/^\d+$/.test(day.trim())) return refused;
        const moved = Number(day) + days;
        if (!inEveryMonth(Number(day)) || !inEveryMonth(moved)) return refused;
        shifted.push(String(moved));
      }
      out.push(`BYMONTHDAY=${shifted.join(",")}`);
    } else if (key === "BYMONTH") {
      // Named months keep a monthly or yearly series' days when its start stays
      // in its month; a daily or weekly one is cut at each month's end.
      if (monthChanged || (freq !== "MONTHLY" && freq !== "YEARLY")) return refused;
      out.push(part);
    } else if (key === "BYSETPOS" || key === "BYYEARDAY" || key === "BYWEEKNO") {
      return refused;
    } else if (key === "WKST") {
      // Written below when it moves.
    } else {
      out.push(part);
    }
  }
  // Every few weeks on several days: ical.js groups the days into weeks from
  // the week start, so the week start moves with the days.
  const wkst = valueOf("WKST");
  if (freq === "WEEKLY" && interval > 1 && valueOf("BYDAY") !== null) {
    out.push(`WKST=${shiftDay(wkst || RULE_DEFAULT_WKST)}`);
  } else if (wkst !== null) {
    out.push(`WKST=${wkst}`);
  }
  return { value: out.join(";") };
}

// The scopes a delete of a repeating event takes (delete_scope), the same
// values as an edit's edit_scope.
const DELETE_SCOPES = ["this_only", "this_and_following", "all"];

// An edit's event_id that names no event on the user's calendars: the id may
// be stale or another kind of id, so the assistant looks it up again rather
// than retrying it.
const EDIT_EVENT_NOT_FOUND_ERROR = "event not found: the event_id may not refer to a calendar event on the user's calendars (it could be stale, deleted, or a different kind of id). Use calendar_search or calendar_read to look up a valid event_id, then retry — do not retry with the same event_id.";

// A series' start that changes between all-day and timed. RFC 5545 needs its
// excluded and added dates, each UNTIL and its changed occurrences'
// RECURRENCE-IDs in the start's value type. Thunderbird keeps theirs and moves
// them by the start's change in UTC (onStartDateChange), which for a DATE and a
// timed start is their time and zone offset, not whole days, even on the same
// day: excluded dates come back. A series (or the following part of a split)
// carrying any of them is refused, with one check for both edits, made before
// anything else moves. A change between all-day and timed is made with a new
// start, which has reset the changed occurrences and the excluded dates
// already (resetChangedOccurrences), so only the dates the same edit excludes
// and the added dates are left to refuse here. A new rule
// is written in the start's value type and replaces each UNTIL, so a series
// whose only such date is its end takes the change with its rule given again
// (on its own day: a new rule is refused with a move to another day).
const KIND_CHANGE_ERROR = "changing these occurrences between all-day and timed would leave their excluded or added dates or end date in the other form; change it in the calendar app";
const KIND_CHANGE_UNTIL_ERROR = "changing these occurrences between all-day and timed would leave their end date (UNTIL) in the other form; give the repeat rule again, its end included, in the same edit (a move to another day goes first, in its own edit)";
function kindChangeError(item, oldStart, patch) {
  const info = item.recurrenceInfo;
  if (!info || !oldStart || !item.startDate || !!item.startDate.isDate === !!oldStart.isDate) return null;
  const items = [...(info.getRecurrenceItems({}) || [])];
  if (items.some((r) => !isRuleItem(r))) return KIND_CHANGE_ERROR;
  const untilKept = !patch.recurrence?.freq && items.some((r) => isRuleItem(r) && /\bUNTIL=/i.test(String(r.icalProperty?.value || "")));
  return untilKept ? KIND_CHANGE_UNTIL_ERROR : null;
}

// A whole-series time change as a plain shift, as calendar apps make it (#287):
// called after `item`'s start has moved from `oldStart` (a series, or the
// following part of a split). Thunderbird has already moved the excluded and
// added dates and each UNTIL by the start's change in UTC
// (onStartDateChange). This moves the rest: on a move to another day, the days
// the rule names. A new start has reset every changed occurrence first
// (resetChangedOccurrences), as Google Calendar's "All events" does, so none is
// moved here. Called only when an edit leaves a new start; the new start is in
// the item's own frame (resolveEditTimes), so the two starts' digits are read
// as they are. `{ error }` when the move cannot be made; nothing is saved then.
// One that stops the series repeating changes nothing here.
function shiftSeriesWithStart(item, oldStart, patch) {
  const newStart = item.startDate;
  const info = item.recurrenceInfo;
  const stopsRepeating = !!patch.recurrence && typeof patch.recurrence === "object" && !patch.recurrence.freq;
  if (stopsRepeating || !info || !oldStart || !newStart) return {};
  // Before the same-start return: compare() takes only the date of a DATE.
  const kindError = kindChangeError(item, oldStart, patch);
  if (kindError) return { error: kindError };
  if (newStart.compare(oldStart) === 0) return {};
  const was = oldStart, now = newStart;
  const days = Math.round((Date.UTC(now.year, now.month, now.day) - Date.UTC(was.year, was.month, was.day)) / 86400000);
  const timeChanged = !newStart.isDate && (was.hour !== now.hour || was.minute !== now.minute || was.second !== now.second);
  const items = [...(info.getRecurrenceItems({}) || [])];
  const rules = items.filter((r) => isRuleItem(r) && /\bFREQ=/i.test(String(r.icalProperty?.value || "")));
  if (timeChanged && rules.some((r) => String(r.icalProperty.value).split(";").some((p) => SET_TIME_PARTS.test(p.trim())))) {
    return { error: "this series repeats at set hours or minutes, so its time cannot be moved here; tell the user to change it in their calendar app" };
  }
  if (days !== 0) {
    if (patch.recurrence?.freq) {
      return { error: "a new repeat rule cannot be given with a move of the series to another day; make the move first, then change the repeat in a second edit (calendar_event_read then shows the moved end)" };
    }
    if (items.some(isNegativeRuleItem)) {
      return { error: "this series cancels occurrences by a rule (EXRULE), which a move to another day cannot carry; tell the user to move it in their calendar app" };
    }
    const shifted = [];
    for (const r of rules) {
      const res = ruleShiftedByDays(r.icalProperty.value, days, was, now);
      if (res.error) return { error: res.error };
      shifted.push([r, res.value]);
    }
    for (const [r, value] of shifted) if (value !== String(r.icalProperty.value)) writeRuleItem(r, value);
  }
  return {};
}

// Every occurrence changed on its own that `item` keeps takes each field the
// edit names, as `item` does and as Google Calendar's "All events" edit makes
// it: title, location, description, busy/free. `item` is the series on a
// whole-series edit, or the following part of a split, whose changed
// occurrences (the one it starts at included) take the fields in that one
// write; the earlier part's keep their own. Fields the edit does not name keep
// the occurrence's own value, and no time is written here: its start and end
// are the time path's. Guest changes are not made here:
// applyGuestChangeToSeries makes them on every item the edit covers.
function applyEditToChangedOccurrences(item, patch) {
  const info = item.recurrenceInfo;
  for (const rid of [...(info?.getExceptionIds({}) || [])]) {
    const named = info.getExceptionFor(rid).clone();
    if (typeof patch.title === "string" && patch.title) named.title = patch.title;
    if (typeof patch.location === "string") named.setProperty("LOCATION", patch.location);
    // A new description replaces the occurrence's in every form (see the split).
    if (typeof patch.description === "string") {
      named.descriptionText = patch.description;
      for (const name of ["X-ALT-DESC", "X-MOZ-HTML", "X-MOZ-ALT-DESC"]) named.deleteProperty(name);
    }
    if (typeof patch.transparency === "string") {
      named.setProperty("TRANSP", patch.transparency.toLowerCase() === "free" ? "TRANSPARENT" : "OPAQUE");
    }
    info.modifyException(named, false);
  }
}

// How one rule of `master`'s series divides at `split`, the first occurrence of
// the following part (#265). `afterSplit` is just after the split (the next day
// for an all-day series, the next second otherwise), and `cap` the UNTIL value
// that ends a rule just before it.
//   - earlier: the rule's value for the earlier part, capped at the split; null
//     when the rule already ends before it and stays as it is.
//   - following: its value for the following part; null when it has nothing
//     left. UNTIL stays, and COUNT becomes the occurrences still to come.
//   - aligned: whether the split is one of the rule's own occurrences. A rule
//     is expanded from its event's start, and the following part starts at the
//     split, so only a rule that makes an occurrence there keeps its dates when
//     it carries on.
// `{ error }` when the rule's end or count cannot be read. A rule Thunderbird
// does not support expands to nothing, so it is never aligned.
function splitRule(rule, master, split, afterSplit, cap) {
  const value = String(rule?.icalProperty?.value || "");
  const parts = value.split(";").map((p) => p.trim()).filter(Boolean);
  const valueOf = (key) => {
    const part = parts.find((p) => p.slice(0, p.indexOf("=")).trim().toUpperCase() === key);
    return part === undefined ? null : part.slice(part.indexOf("=") + 1).trim();
  };
  const capped = parts.filter((p) => !/^(UNTIL|COUNT)=/i.test(p)).concat(`UNTIL=${cap}`).join(";");
  const carriedOn = (following) => ({
    earlier: capped,
    following,
    aligned: rule.getOccurrences(master.startDate, split, afterSplit, 0).length > 0,
  });
  const until = valueOf("UNTIL");
  if (until !== null) {
    const bound = boundFromIcs(until);
    if (!bound) return { error: `this series' end cannot be read (UNTIL=${until})` };
    // compare, not epoch times: an all-day split is a DATE, compared by its
    // digits, and its epoch time depends on its zone.
    return bound.compare(split) < 0 ? { earlier: null, following: null, aligned: false } : carriedOn(value);
  }
  const count = valueOf("COUNT");
  if (count !== null) {
    if (!/^\d+$/.test(count)) return { error: `this series' count cannot be read (COUNT=${count})` };
    const left = Number(count) - rule.getOccurrences(master.startDate, master.startDate, split, 0).length;
    if (!(left > 0)) return { earlier: null, following: null, aligned: false };
    return carriedOn(parts.map((p) => (/^COUNT=/i.test(p) ? `COUNT=${left}` : p)).join(";"));
  }
  return carriedOn(value);
}

// The series before the occurrence whose RECURRENCE-ID is `rid`: every rule
// capped just before it (splitRule), added and excluded dates and changed
// occurrences from it on dropped, all-day dates written as plain dates. It is
// the earlier part of a split ("this and following"), and what a delete of an
// occurrence and every later one keeps. Built on a copy of `master`; nothing
// is written. `{ part, splitDt, untilValue, plans, fromSplitOn }`: `splitDt`
// is `rid` read in the series' own zone, `untilValue` the cap, `plans` each
// recurrence item's splitRule result in the series' order (null for an item
// that is not a rule with FREQ), `fromSplitOn` whether a date is at or after
// the cut. `{ error }` when the series cannot be cut there.
function earlierPartBefore(master, rid) {
  // The series divides at the occurrence's RECURRENCE-ID, read in the series'
  // own zone (a RECURRENCE-ID can be stored in another, e.g. UTC), so a changed
  // occurrence divides where it belongs.
  const splitDt = rid.isDate ? rid.clone() : rid.getInTimezone(master.startDate.timezone);

  // Compute UNTIL so the master ends BEFORE `splitDt` (the first
  // occurrence that should belong to the new series), and the bound
  // just after the split (the next day for an all-day series; the next
  // second otherwise), which bounds the check that a rule makes an
  // occurrence at the split.
  //
  // RFC 5545 §3.3.10: the UNTIL value type MUST match DTSTART's.
  //   - All-day master (DTSTART is VALUE=DATE) → UNTIL must be a bare
  //     DATE `YYYYMMDD`. Use (split − 1 day), from the DATE's own digits.
  //   - Zoned timed master → UNTIL is a UTC date-time `…THHMMSSZ`.
  //     Use (split − 1 second).
  //   - Floating timed master → UNTIL is a floating date-time
  //     `…THHMMSS` (no Z), (split − 1 second) by its digits. A
  //     floating value's instant is its digits at offset 0, so these
  //     are the UTC digits of that instant without the Z.
  // `toIcsUntil` only emits the date-time form, so the all-day branch
  // formats the bare DATE itself.
  const isAllDayMaster = !!master.startDate?.isDate;
  let untilValue, afterSplit;
  if (isAllDayMaster) {
    untilValue = dayDigitsFrom(splitDt, -1).join("");
    afterSplit = dayDateFrom(splitDt, 1);
  } else {
    const splitMs = splitDt.nativeTime / 1000;
    const capUtc = toIcsUntil(new Date(splitMs - 1000).toISOString());
    untilValue = zonedStartZone(master) ? capUtc : capUtc?.replace(/Z$/, "");
    afterSplit = boundFromIcs(toIcsUntil(new Date(splitMs + 1000).toISOString()));
  }
  if (!untilValue || !afterSplit) return { error: "failed to compute UNTIL value" };

  // How each rule divides at the split (splitRule). The series'
  // items are read from its recurrence info, the only place
  // Thunderbird stores and expands them; `plans` follows their order,
  // which a clone of the recurrence info keeps.
  const masterItems = [...(master.recurrenceInfo.getRecurrenceItems({}) || [])];
  if (masterItems.some(isNegativeRuleItem)) {
    return { error: "this series cancels occurrences by a rule (EXRULE), which a split cannot keep; change it in the calendar app" };
  }
  const isSeriesRule = (r) => isRuleItem(r) && /\bFREQ=/i.test(String(r?.icalProperty?.value || ""));
  const plans = [];
  for (const r of masterItems) {
    if (!isSeriesRule(r)) { plans.push(null); continue; }
    const plan = splitRule(r, master, splitDt, afterSplit, untilValue);
    if (plan.error) return { error: plan.error };
    plans.push(plan);
  }
  const fromSplitOn = (dt) => !!dt && dt.compare(splitDt) >= 0;

  // The earlier part: the series before the split. Each rule is
  // capped there; excluded and added dates and changed occurrences
  // from the split on leave it.
  // An all-day part is written as plain dates (asAllDayItem), so its
  // bare-date UNTIL keeps the day before the split: ical.js compares
  // UNTIL by instant, and a start that kept a zone west of UTC would
  // fall after an UNTIL of its own day.
  const cappedClone = master.clone();
  try {
    asAllDayItem(cappedClone);
    const earlierInfo = cappedClone.recurrenceInfo;
    [...(earlierInfo.getRecurrenceItems({}) || [])].forEach((r, i) => {
      if (plans[i]) {
        if (plans[i].earlier) writeRuleItem(r, plans[i].earlier);
      } else if (fromSplitOn(r.date)) {
        earlierInfo.deleteRecurrenceItem(r);
      }
    });
    for (const rid of [...(earlierInfo.getExceptionIds({}) || [])]) {
      if (fromSplitOn(rid)) earlierInfo.removeExceptionFor(rid);
    }
  } catch (re) {
    console.error("[tmCalendar] earlierPartBefore: capping the earlier part failed:", re);
    return { error: `failed to apply capped RRULE: ${re}` };
  }
  return { part: cappedClone, splitDt, untilValue, plans, fromSplitOn };
}

// Sets or clears an item's rule (`setRuleOnItem`). `{}` removes the recurrence.
// An all-day item's dates are first written with no zone (asAllDayItem): its
// UNTIL is a bare date, which ical.js compares with each occurrence by instant
// at offset 0, so a start stored in a zone west of UTC (as TabMail wrote
// all-day dates before #303) would end the series a day before the day named.
function applyRecurrenceToItem(item, recurrenceDetails) {
  try {
    if (!recurrenceDetails || typeof recurrenceDetails !== "object") return { applied: false, cleared: false };
    if (recurrenceDetails.freq) asAllDayItem(item);
    const value = buildRRuleValueFromDetails(recurrenceDetails, item);
    if (!value) {
      item.recurrenceInfo = null;
      tmCalendarDebugLog("[tmCalendar] applyRecurrenceToItem: cleared recurrence");
      return { applied: false, cleared: true };
    }
    setRuleOnItem(item, value);
    tmCalendarDebugLog("[tmCalendar] applyRecurrenceToItem: applied RRULE=", value);
    return { applied: true, cleared: false, value };
  } catch (e) {
    console.warn("[tmCalendar] applyRecurrenceToItem failed:", e);
    return { applied: false, cleared: false, error: String(e) };
  }
}

async function queryCalendarItemsInternal(startIso, endIso, calendarIds) {
  const mgr = getCalendarManager();
  if (!mgr) return [];
  try {
    const Ci = globalThis.Ci;
    const Cc = globalThis.Cc;
    if (!startIso || !endIso) {
      console.error("[tmCalendar] queryCalendarItemsInternal: missing start/end ISO", startIso, endIso);
      return [];
    }
    // initial request logging is handled by API layer
    const selected = Array.isArray(calendarIds) && calendarIds.length > 0
      ? Array.from(mgr.getCalendars({})).filter((c) => calendarIds.includes(String(c.id)))
      : Array.from(mgr.getCalendars({}));

    const start = toCalIDateTime(startIso);
    const end = toCalIDateTime(endIso);
    
    if (!start || !end) {
      console.error("[tmCalendar] queryCalendarItemsInternal: failed to construct calIDateTime from given ISO strings");
      return [];
    }
    const typeEvent = Ci?.calICalendar?.ITEM_FILTER_TYPE_EVENT || 0;
    const includeOcc = (Ci?.calICalendar?.ITEM_FILTER_INCLUDE_OCCURRENCES ?? 0) || (Ci?.calICalendar?.ITEM_FILTER_CLASS_OCCURRENCES ?? 0) || 0;
    const filter = typeEvent | includeOcc;
    // filter computed

    // Per-calendar query only (no composite, minimal logging)
    const allResults = [];
    const tStart = Date.now();
    for (const calObj of selected) {
      try {
        const MAX_COUNT = 100;
        const items = await getItemsPromise(calObj, filter, MAX_COUNT, start, end);
        // The provider's getItems(filter, count, start, end) is the window
        // filter. A second compare-based overlap pass here is not equivalent:
        // calIDateTime.compare treats an all-day DATE as equal to any
        // date-time on the same day, so a tight window (start_iso ±60s) that
        // the provider satisfies was dropped again by the bridge (#47).
        for (const occurrence of (items || [])) {
          const org = occurrence.organizer || null;
          const attendeesArr = safeGetAttendees(occurrence);
          const attendeesList = formatAttendees(attendeesArr);
          const desc = String(occurrence.getProperty?.("DESCRIPTION") || "");
          const url = String(occurrence.getProperty?.("URL") || "");

          // Use stable IDs: occurrence.id preserves suffix, master.id sometimes doesn't
          const master = occurrence.parentItem || occurrence;
          const isOccurrence = !!occurrence.recurrenceId;
          const isAllDay = !!occurrence.startDate?.isDate;
          // Prefer the occurrence's id (Google shows suffix there even when master is bare)
          const seriesId = String(occurrence.id || master.id || "");
          
          const resultItem = {
            id: seriesId,                                   // use occurrence's id to preserve suffix
            // An all-day RECURRENCE-ID is a DATE; emit it in the naive shape the
            // edit/delete tools can round-trip (see allDayNaiveIso).
            recurrenceId: (() => {
              if (!isOccurrence) return "";
              const rid = occurrence.recurrenceId;
              if (rid?.isDate) return allDayNaiveIso(toDayString(rid));
              return String(rid?.toString() || "");
            })(),
            isOccurrence,
            calendarId: String(calObj.id || ""),
            title: String(occurrence.title || ""),
            startDate: String(occurrence.startDate?.toString() || ""),
            endDate: String(occurrence.endDate?.toString() || ""),
            startMs: toEpochMsUTC(asShown(occurrence.startDate)),
            endMs: toEpochMsUTC(asShown(occurrence.endDate)),
            isAllDay,
            startDay: isAllDay ? toDayString(occurrence.startDate) : "",
            endDay: isAllDay ? toDayString(occurrence.endDate) : "",
            location: String(occurrence.getProperty?.("LOCATION") || ""),
            organizer: org ? String(org.commonName || org.id || "") : "",
            attendees: attendeesArr.length,
            attendeeList: attendeesList,
            description: desc,
            url,
            transparency: (() => {
              try {
                const raw = String(occurrence.getProperty?.("TRANSP") || master.getProperty?.("TRANSP") || "");
                const mapped = raw.toUpperCase() === "TRANSPARENT" ? "free" : "busy";
                tmCalendarDebugLog("[tmCalendar] item TRANSP=", raw || "(empty)", "mapped=", mapped);
                return mapped;
              } catch (_) { return "busy"; }
            })(),
          };
          try {
            const recurrence = recurrenceFieldsOfItem(master);
            resultItem.isRecurring = !!(master && master.recurrenceInfo);
            if (recurrence) resultItem.recurrence = recurrence;
            // Also surface EXDATEs
            try {
              const exd = extractExdatesFromItem(master);
              if (exd) resultItem.exdates = exd;
            } catch (_) {}
            if (recurrence) tmCalendarDebugLog("[tmCalendar] item recurrence=", JSON.stringify(recurrence), "id=", resultItem.id);
          } catch (_) {}
          try {
            tmCalendarDebugLog(`[tmCalendar] item cal=${String(calObj.id || "")} id=${resultItem.id} title='${resultItem.title}' att=${attendeesArr.length} descLen=${desc.length} url=${url ? "yes" : "no"}`);
          } catch (_) {}
          allResults.push(resultItem);
        }
      } catch (_) {}
    }
    tmCalendarDebugLog(`[tmCalendar] query: total ${allResults.length} items across ${selected.length} calendars in ${Date.now() - tStart}ms`);
    return allResults;
  } catch (e) {
    // suppressed
    return [];
  }
}

/**
 * Converts an ISO8601 datetime string to a Thunderbird calIDateTime object.
 * 
 * IMPORTANT: For correct DST handling, the input MUST be a "naive" ISO string
 * without timezone offset (e.g., "2025-01-15T14:00:00"), NOT with offset
 * (e.g., "2025-01-15T14:00:00-07:00"). 
 * 
 * DST Handling:
 * - JavaScript's Date object correctly applies DST rules based on the TARGET date,
 *   not the current date. For example, creating a January event in October will
 *   correctly use PST (winter) timezone offset, not PDT (summer).
 * - However, if the input has an explicit timezone offset (e.g., -07:00 for PDT),
 *   that offset is preserved, which causes a 1-hour error when crossing DST boundaries.
 * - The extracted date components are passed to TB's calendar API with the user's
 *   timezone (tzService.defaultTimezone), which also knows DST rules.
 * - This ensures events created across DST boundaries are stored correctly.
 * 
 * @param {string} iso - ISO8601 datetime string (preferably without timezone offset)
 * @param {string} [tzId] - Optional IANA tz id (e.g. "America/Los_Angeles"). When
 *   set and the ISO is naive, the wall-clock components are anchored in this
 *   zone instead of the user's TB-default zone. An id Thunderbird does not
 *   know throws, naming it: the create or edit that gave it fails with that
 *   error before anything is saved, so the assistant can correct the zone.
 * @returns {calIDateTime|null} - Thunderbird calendar datetime object or null if invalid
 */
function toCalIDateTime(iso, tzId) {
  const tzService = getTimezoneService();
  // The zone the caller names, resolved outside the try below so a refusal is
  // never turned into null. Mozilla's calITimezoneService.getTimezone returns
  // null for an unknown id; guard via the tzid round-trip too.
  let overrideTimezone = null;
  if (typeof tzId === "string" && tzId) {
    const candidate = tzService.getTimezone(tzId);
    if (!candidate || !candidate.tzid || candidate.tzid === "floating") {
      throw new Error(`timezone "${tzId}" is not a time zone the calendar knows. Use an IANA time zone id (for example Asia/Tokyo), or leave timezone out for the user's own zone, then retry.`);
    }
    overrideTimezone = candidate;
  }
  try {
    const Ci = globalThis.Ci;
    const Cc = globalThis.Cc;
    const dt = Cc["@mozilla.org/calendar/datetime;1"].createInstance(Ci.calIDateTime);

    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      console.warn(`[tmCalendar] toCalIDateTime: Invalid date string '${iso}'`);
      return null;
    }

    // Detect timezone format and warn if offset is present (potential DST issue)
    const hasOffset = /[zZ]|[+\-]\d{2}:?\d{2}$/.test(String(iso));
    if (hasOffset && !iso.endsWith('Z') && !/[+\-]00:?00$/.test(iso)) {
      console.warn(`[tmCalendar] toCalIDateTime: WARNING - ISO string '${iso}' has timezone offset. This may cause DST boundary errors. Use naive format without offset instead.`);
    }

    let timezone;

    if (hasOffset) {
      // If ISO has explicit timezone, preserve it
      if (iso.endsWith('Z') || iso.includes('+00:00') || iso.includes('-00:00')) {
        timezone = tzService.UTC;
        dt.resetTo(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), timezone);
        tmCalendarDebugLog(`[tmCalendar] toCalIDateTime: UTC datetime '${iso}' -> ${dt.toString()}`);
      } else {
        // Use local timezone for offset-aware times (user's input with timezone)
        timezone = overrideTimezone || tzService.defaultTimezone || tzService.UTC;
        dt.resetTo(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), timezone);
        tmCalendarDebugLog(`[tmCalendar] toCalIDateTime: Offset-aware '${iso}' -> ${dt.toString()} in ${timezone.tzid || 'UTC'}`);
      }
    } else {
      // For naive times (no timezone), use the override if present, else the
      // user's TB-configured zone. We must extract the wall-clock components
      // without going through `new Date(iso)` (which would re-interpret in the
      // local zone) when an override is specified — parse the digits directly.
      timezone = overrideTimezone || tzService.defaultTimezone || tzService.UTC;
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(iso));
      let year, month, day, hours, minutes, seconds;
      if (m && overrideTimezone) {
        // Wall-clock parse — bypass JS Date's local-zone reinterpretation so
        // "2026-04-29T22:00:00" with tzId="Asia/Seoul" lands at 22:00 KST
        // even when TB is configured to PT.
        year = Number(m[1]);
        month = Number(m[2]) - 1;
        day = Number(m[3]);
        hours = Number(m[4] || "0");
        minutes = Number(m[5] || "0");
        seconds = Number(m[6] || "0");
        dt.resetTo(year, month, day, hours, minutes, seconds, timezone);
        tmCalendarDebugLog(`[tmCalendar] toCalIDateTime: Naive datetime '${iso}' anchored in '${timezone.tzid}' (override) -> ${dt.toString()}`);
      } else {
        // Default behaviour: parse via JS Date (uses TB's local zone) and
        // copy wall-clock components — DST applied by the calendar API.
        const localDate = new Date(iso + (iso.includes('T') ? '' : 'T00:00:00'));
        year = localDate.getFullYear();
        month = localDate.getMonth();
        day = localDate.getDate();
        hours = localDate.getHours();
        minutes = localDate.getMinutes();
        seconds = localDate.getSeconds();
        dt.resetTo(year, month, day, hours, minutes, seconds, timezone);
        const offset = localDate.getTimezoneOffset();
        const isDST = offset < (new Date(year, 0, 1).getTimezoneOffset());
        tmCalendarDebugLog(`[tmCalendar] toCalIDateTime: Naive datetime '${iso}' -> ${dt.toString()} in ${timezone.tzid || 'UTC'} (UTC offset: ${-offset/60}hrs, DST: ${isDST})`);
      }
    }

    dt.isDate = false; // ensure date-time, not all-day date
    return dt;
  } catch (e) {
    console.warn("[tmCalendar] toCalIDateTime failed:", e);
    return null;
  }
}

function getItemsPromise(calObj, filter, count, start, end, label = "cal") {
  return new Promise(async (resolve) => {
    const results = [];
    const calId = String(calObj?.id || label || "");
    const startedAt = Date.now();
    let timer = null;
    let cancelTimer = null;
    let resolved = false;

    // Ask provider to refresh, then wait for ready
    try {
      if (typeof calObj.refresh === 'function') {
        try { calObj.refresh(); } catch (re) {}
      }
    } catch (_) {}
    try {
      const ready = await waitForCalendarReady(calObj, calId);
      // ready flag obtained
    } catch (e) {
      // suppressed
    }

    // Progress timer
    try {
      const Ci = globalThis.Ci; const Cc = globalThis.Cc;
      timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.init(() => {
        try {
          const elapsed = Date.now() - startedAt;
          console.warn(`[tmCalendar] getItemsPromise: still waiting for cal ${calId} after ${elapsed}ms (accum=${results.length})`);
        } catch (_) {}
      }, 2000, Ci.nsITimer.TYPE_REPEATING_SLACK);
    } catch (e) {
      // suppressed
    }

    let stream = null;
    try {
      stream = calObj.getItems(filter, count, start, end);
      // stream obtained
    } catch (e) {
      // suppressed
      resolve(results);
      return;
    }

    // Timeboxed cancel of reader
    try {
      const Ci = globalThis.Ci; const Cc = globalThis.Cc;
      cancelTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      const CANCEL_AFTER_MS = 10000; // 10s
      cancelTimer.init(async () => {
        try {
          if (stream && typeof stream.cancel === 'function') {
            try { await stream.cancel(); } catch (ce) {}
          }
        } catch (_) {}
        if (!resolved) {
          try { if (timer) timer.cancel(); } catch (_) {}
          resolved = true;
          resolve(results);
        }
      }, CANCEL_AFTER_MS, Ci.nsITimer.TYPE_ONE_SHOT);
    } catch (tErr) {
      // suppressed
    }

    // Consume the ReadableStream
    try {
      if (stream && typeof stream.getReader === 'function') {
        const reader = stream.getReader();
        let chunkIndex = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunkIndex += 1;
          try {
            const arr = Array.isArray(value) ? value : (value && Array.from(value)) || [];
            if (arr.length) results.push(...arr);
            // chunk received
          } catch (ce) {
            // suppressed
          }
        }
      } else if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        let chunkIndex = 0;
        for await (const value of stream) {
          chunkIndex += 1;
          const arr = Array.isArray(value) ? value : (value && Array.from(value)) || [];
          if (arr.length) results.push(...arr);
          // chunk received
        }
      } else {
        // unsupported return type
      }
    } catch (e) {
      // suppressed
    } finally {
      try { if (timer) timer.cancel(); } catch (_) {}
      try { if (cancelTimer) cancelTimer.cancel(); } catch (_) {}
      resolved = true;
      resolve(results);
    }
  });
}

function waitForCalendarReady(calObj, label) {
  return new Promise((resolve) => {
    try {
      const Ci = globalThis.Ci; const Cc = globalThis.Cc;
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      let resolved = false;
      let observer = null;
      try {
        const __obsQI = ChromeUtils.generateQI([globalThis.Ci?.calIObserver || "calIObserver"]);
        observer = {
          QueryInterface(iid) { return __obsQI.call(this, iid); },
          onLoad: (_cal) => {
            if (resolved) return;
            try { if (timer) timer.cancel(); } catch (_) {}
            resolved = true;
            try { calObj.removeObserver(observer); } catch (_) {}
            resolve(true);
          },
          onAddItem() {}, onModifyItem() {}, onDeleteItem() {}, onError() {}, onStartBatch() {}, onEndBatch() {}, onPropertyChanged() {}, onPropertyDeleting() {},
        };
        try {
          if (typeof calObj.addObserver === 'function') {
            calObj.addObserver(observer);
          }
        } catch (oErr) {
          // suppressed
        }
      } catch (_) {}
      timer.init(() => {
        if (resolved) return;
        resolved = true;
        try { if (observer && typeof calObj.removeObserver === 'function') calObj.removeObserver(observer); } catch (_) {}
        resolve(false);
      }, 1200, Ci.nsITimer.TYPE_ONE_SHOT);
    } catch (e) {
      // If timer/observer not available, resolve immediately
      resolve(false);
    }
  });
}

function safeGetAttendees(item) {
  try {
    const arr = item.getAttendees?.();
    if (Array.isArray(arr)) return arr;
  } catch (_) {}
  return [];
}

function formatAttendees(attArr) {
  try {
    const out = [];
    for (const a of (attArr || [])) {
      try {
        const rec = {
          name: String(a.commonName || ""),
          email: (() => { try { return String(a.id || "").replace(/^mailto:/i, ""); } catch { return ""; } })(),
        };
        try { if (a.participationRole) rec.role = String(a.participationRole); } catch {}
        try { if (a.participationStatus) rec.status = String(a.participationStatus); } catch {}
        out.push(rec);
      } catch (_) {}
    }
    return out;
  } catch (_) { return []; }
}

// An address without "mailto:", in the case it was written. Spaces around it
// and a repeated "mailto:" are dropped, so a stored id and an address an edit
// gives are read the same way.
function addressAsWritten(id) {
  let s = String(id || "").trim();
  while (/^mailto:/i.test(s)) s = s.slice(7).trim();
  return s;
}
// The address attendees are matched by, in lower case: Thunderbird matches
// attendees by address without regard to case (getAttendeeById).
function attendeeAddress(id) {
  return addressAsWritten(id).toLowerCase();
}

// What the reply says when an event with guests is saved on a calendar with
// no email address of its own: no organizer is set, so its server does not
// notify them. Never claims anyone was emailed.
const NO_CALENDAR_ADDRESS_NOTICE = "This calendar has no email address of its own, so the event was saved without an organizer and its server is not told to notify the guests.";
// What the reply says when an event with guests is saved to a calendar kept
// only on this computer (Thunderbird's local calendar, CalStorageCalendar,
// type "storage"): there is no server, and the add-on sends nothing.
const LOCAL_CALENDAR_NOTICE = "This calendar is kept only on this computer, so no one is emailed about it.";

// The reply's guest notice for a write, from the organizer results of the
// items it wrote (null for an item without guests): a local calendar says no
// one is emailed; otherwise a calendar with no address says so. Plain CalDAV,
// Google and Outlook calendars with an address say nothing.
function guestNoticeOf(calendar, results) {
  const withGuests = results.filter((r) => r !== null && r !== undefined);
  if (withGuests.length === 0) return {};
  if (String(calendar?.type || "") === "storage") return { guest_notice: LOCAL_CALENDAR_NOTICE };
  if (withGuests.includes("none")) return { guest_notice: NO_CALENDAR_ADDRESS_NOTICE };
  return {};
}

// An event the assistant saves with guests and no organizer is organized by
// the calendar's own address: calendar.getProperty("organizerId"), the
// property Thunderbird's event dialog uses (CalDAV: the server's
// calendar-user-address-set; otherwise the calendar's email identity). A
// scheduling server notifies guests only of an event whose ORGANIZER is its
// user. An existing organizer is never changed (the user may be a guest of
// someone else's meeting), an event without guests gets none, and nothing is
// ever taken from the model. A series counts as having guests when it or any
// changed occurrence has some, and every changed occurrence without an
// organizer takes the series' (RFC 6638 3.2.4.2: every component of one
// resource carries the same ORGANIZER). Returns "set" when it set one, "kept"
// when one was there, "none" when the event has guests but the calendar has no
// address (saved without an organizer), and null when it has no guests.
function exceptionsOf(item) {
  const info = item?.recurrenceInfo;
  return info ? [...(info.getExceptionIds({}) || [])].map((rid) => info.getExceptionFor(rid)) : [];
}
function hasGuests(item) {
  return item.getAttendees().length > 0 || exceptionsOf(item).some((ex) => ex.getAttendees().length > 0);
}
// Gives a series an organizer where it has none, and each changed occurrence
// without one a copy of the series'. Says whether anything changed.
function giveSeriesOrganizer(series, organizer) {
  let changed = false;
  if (!series.organizer) { series.organizer = organizer.clone(); changed = true; }
  const info = series.recurrenceInfo;
  for (const ex of exceptionsOf(series)) {
    if (ex.organizer) continue;
    const copy = ex.clone();
    copy.organizer = series.organizer.clone();
    info.modifyException(copy, true);
    changed = true;
  }
  return changed;
}
function setOwnOrganizerIfGuests(item, calendar) {
  if (!item || !hasGuests(item)) return null;
  if (item.organizer) { giveSeriesOrganizer(item, item.organizer); return "kept"; }
  let id = "";
  let cn = "";
  try { id = String(calendar?.getProperty?.("organizerId") || "").trim(); } catch {}
  if (!addressAsWritten(id)) return "none";
  try { cn = String(calendar?.getProperty?.("organizerCN") || "").trim(); } catch {}
  const org = globalThis.Cc["@mozilla.org/calendar/attendee;1"].createInstance(globalThis.Ci.calIAttendee);
  org.id = /^mailto:/i.test(id) ? id : `mailto:${id}`;
  if (cn) org.commonName = cn;
  org.isOrganizer = true;
  giveSeriesOrganizer(item, org);
  return "set";
}

// An edit's guest change, or null when it gives none.
function guestChangeOf(patch) {
  const add = Array.isArray(patch.add_attendees) ? patch.add_attendees : [];
  const remove = Array.isArray(patch.remove_attendees) ? patch.remove_attendees : [];
  return add.length || remove.length ? { add, remove } : null;
}

// Applies an edit's guest change to one item's own list, the only place the
// change is merged. Removals come first: "*" alone removes everyone, an
// address removes that guest whatever its case. Each addition not already
// listed is then appended once, in the order given, as a guest who has not
// answered. Everyone who stays keeps their entry as stored (their answer,
// role and other details), as Thunderbird's own event dialog does; so does
// a guest the change removes and adds back (a list restated after "*").
function applyGuestChange(item, { add, remove }) {
  const Ci = globalThis.Ci; const Cc = globalThis.Cc;
  const clearAll = remove.some((r) => String(r?.email ?? "").trim() === "*");
  const gone = new Set(remove.map((r) => attendeeAddress(r?.email)).filter((a) => a && a !== "*"));
  const stored = item.getAttendees();
  const kept = clearAll ? [] : stored.filter((a) => !gone.has(attendeeAddress(a.id)));
  const listed = new Set(kept.map((a) => attendeeAddress(a.id)));
  item.removeAllAttendees();
  for (const a of kept) item.addAttendee(a);
  for (const a of add) {
    const address = attendeeAddress(a?.email);
    if (!address || address === "*" || listed.has(address)) continue;
    listed.add(address);
    const was = stored.find((s) => attendeeAddress(s.id) === address);
    if (was) { item.addAttendee(was); continue; }
    const att = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
    att.id = `mailto:${addressAsWritten(a.email)}`;
    if (a?.name) att.commonName = String(a.name);
    att.participationStatus = "NEEDS-ACTION";
    att.rsvp = "TRUE";
    item.addAttendee(att);
  }
}

// Applies an edit's guest change to a series and to each occurrence of it
// that was changed on its own: such an occurrence has its own guest list,
// which keeps its own differences apart from what the change names.
function applyGuestChangeToSeries(series, change) {
  applyGuestChange(series, change);
  const info = series.recurrenceInfo;
  for (const rid of [...(info?.getExceptionIds({}) || [])]) {
    const ex = info.getExceptionFor(rid).clone();
    applyGuestChange(ex, change);
    info.modifyException(ex, true);
  }
}

// An all-day value is an RFC 5545 DATE: it has no zone and no instant. ical.js
// deliberately skips zone conversion for `isDate` values, so `toEpochMsUTC`
// yields UTC midnight of the calendar date — and every consumer that renders
// that epoch in the user's zone then names the PREVIOUS day west of UTC (#47).
// Carry the date's own digits instead; consumers key all-day items by these.
function toDayString(calDt) {
  try {
    if (!calDt) return "";
    const y = Number(calDt.year);
    const m = Number(calDt.month) + 1; // calIDateTime months are 0-based
    const d = Number(calDt.day);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return "";
    const pad2 = (n) => String(n).padStart(2, "0");
    return `${y}-${pad2(m)}-${pad2(d)}`;
  } catch (_) { return ""; }
}

// Naive ISO shape the tools expect for an all-day date: the "T00:00:00"
// suffix parses as a local wall clock and round-trips unchanged through
// `toNaiveIso` in the tool layer (which reads a bare "YYYY-MM-DD" as this
// same shape) and `toCalIDateTime`.
function allDayNaiveIso(dayStr) {
  return dayStr ? `${dayStr}T00:00:00` : "";
}

// A value as the read tools print a start_iso: an all-day date at midnight, a
// time on the user's clock (a floating one at its own digits, asShown). A time
// is printed from its instant exactly as the tool layer prints one (toNaiveIso:
// the local digits of a JavaScript Date), never through getInTimezone, which
// lands an hour off near a clock change; so a time the read tools printed,
// given back, is the same string (restates).
function shownNaiveIso(calDt) {
  if (calDt.isDate) return allDayNaiveIso(toDayString(calDt));
  const d = new Date(asShown(calDt).nativeTime / 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// A value as Thunderbird shows it. A floating time (RFC 5545 local time, no
// zone) is shown at its own digits on the user's clock, but ical.js gives it
// offset 0, so its epoch is its digits read as UTC and the read tools would
// print it shifted by the user's offset; it is relabelled into the user's zone.
// The edit tools name an occurrence by the start the read tools print, and
// CalDateTime.compare reads a zoned value against a floating one by its digits,
// so the start printed for a floating occurrence names it. A DATE and a zoned
// time are returned as they are.
function asShown(calDt) {
  if (!calDt || calDt.isDate || calDt.timezone?.tzid !== "floating") return calDt;
  const shown = calDt.clone();
  shown.resetTo(calDt.year, calDt.month, calDt.day, calDt.hour, calDt.minute, calDt.second, getTimezoneService().defaultTimezone);
  return shown;
}

// `dt`'s date as an all-day value, written as Thunderbird's event dialog writes
// one: a DATE with no zone (floating). A DATE that carries a zone has its epoch
// time at midnight in that zone, and ical.js compares a rule's UNTIL with each
// occurrence by instant, so west of UTC a series' last day would fall after a
// bare-date UNTIL naming it and be dropped (#303).
function asAllDayDate(dt) {
  dt.isDate = true;
  dt.timezone = getTimezoneService().floating;
  return dt;
}

// Writes every all-day value of an all-day item as a DATE with no zone
// (asAllDayDate), as Thunderbird's event dialog writes one and as Google
// Calendar keeps them: its start and end, its excluded and added dates, and
// each changed occurrence's RECURRENCE-ID and its own start and end. A series
// stored with zoned DATEs (TabMail's before #303, or another app's) is
// otherwise expanded by instant against a bare-date UNTIL, which west of UTC
// ends it a day before the date the UNTIL names (asAllDayDate). Every write of
// an all-day series' own dates goes through here first: an edit of the whole
// series, a rule written onto one (applyRecurrenceToItem), and both parts of a
// split. A one-occurrence edit writes none of the series' dates and leaves it
// as stored. A rule's date-time UNTIL (older TabMail versions wrote every
// UNTIL as one, and so do some apps) is written as the plain date of the last
// day Thunderbird shows now: the bound's date in the start's stored zone, since
// ical.js compares it with each zoned date at midnight in that zone (RFC 5545
// 3.3.10: UNTIL takes DTSTART's value type); `stored` is that start, the
// item's own unless its start has been written already (a split's following
// part, which starts at the split as a plain date). A date UNTIL is kept as
// written.
// Each value keeps its digits, so no occurrence moves: Thunderbird diffs the
// two starts in UTC (onStartDateChange), where a DATE keeps its day, and keys a
// changed occurrence and an excluded date by the RECURRENCE-ID's date
// (getRidKey), which the relabel keeps, so each stays attached to its
// occurrence. Timed values (a timed item, or a date-time in its lists) are left
// as they are.
function asAllDayItem(item, stored = item?.startDate) {
  if (!item?.startDate?.isDate) return;
  const info = item.recurrenceInfo;
  const zone = stored.timezone?.tzid && stored.timezone.tzid !== "floating"
    ? stored.timezone : getTimezoneService().UTC;
  for (const r of info?.getRecurrenceItems({}) || []) {
    if (r.date?.isDate) r.date = asAllDayDate(r.date.clone());
    if (!isRuleItem(r)) continue;
    const value = String(r.icalProperty?.value || "");
    const until = /(?:^|;)UNTIL=(\d{8}T\d{6}Z?)(?=;|$)/i.exec(value);
    const bound = until && boundFromIcs(until[1]);
    if (!bound) continue;
    const day = bound.getInTimezone(zone);
    const date = `${day.year}${pad2(day.month + 1)}${pad2(day.day)}`;
    writeRuleItem(r, value.replace(until[0], until[0].replace(until[1], date)));
  }
  item.startDate = asAllDayDate(item.startDate.clone());
  if (item.endDate?.isDate) item.endDate = asAllDayDate(item.endDate.clone());
  for (const rid of [...(info?.getExceptionIds({}) || [])]) {
    if (!rid.isDate) continue;
    const ex = info.getExceptionFor(rid).clone();
    ex.recurrenceId = asAllDayDate(rid.clone());
    if (ex.startDate?.isDate) ex.startDate = asAllDayDate(ex.startDate.clone());
    if (ex.endDate?.isDate) ex.endDate = asAllDayDate(ex.endDate.clone());
    info.modifyException(ex, true);
  }
}

// Whether an edit's start_iso or end_iso names a time of day. A date alone, or
// at midnight (the read tools show an all-day date as `${day}T00:00:00`),
// names none.
function namesTimeOfDay(iso) {
  const m = /[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(iso || ""));
  return !!m && (Number(m[1]) > 0 || Number(m[2]) > 0 || Number(m[3] || 0) > 0);
}

// Why an edit that gave `item` new times is refused, or null. The item has its
// new times: a start alone keeps the length, an end alone keeps the start (the
// item's own: the event's, one occurrence's, a split's slot). Nothing has been
// written yet, and the assistant is told what to give or to ask the user:
// - All-day, with a time of day and no all_day: the user may want it timed, or
//   all-day on that date, and dropping the time would keep it all-day without
//   asking.
// - A start and an end of different kinds (one all-day, one timed): RFC 5545
//   needs DTEND in DTSTART's value type, and a side the edit leaves out keeps
//   its kind.
// - An all-day end on or before the start: an all-day end is the day after the
//   last day (RFC 5545: DTEND is exclusive and later than DTSTART), so this
//   would be a zero-length event.
// - A timed end before the start. An end at the start is written (a
//   zero-length event, as Google Calendar makes one).
// - A change of kind (kindChangeTimesError) without both a start and an end,
//   checked first and also for an edit that gives no time at all. `stored`
//   is the item as stored (`item` already has the edit's times), whose kind
//   the edit keeps or changes.
function editTimesError(item, patch, stored) {
  const s = item.startDate, e = item.endDate;
  if (!s || !e) return null;
  return editTimesErrorOf({ itemIsDate: !!stored.startDate?.isDate, startIsDate: !!s.isDate, endIsDate: !!e.isDate, order: e.compare(s) }, patch);
}

// Why an edit that changes an item's kind is refused, or null: an all_day
// other than the stored kind (`storedIsDate`) comes with both start_iso and
// end_iso, or nothing is written. The dates are not derived from the stored
// ones: a timed event made all-day can span other days, and one made timed
// needs the time of day and the length the user wants, so the assistant asks.
// Without this, all_day alone (or with one side) wrote nothing, or kept the
// all-day length as a 24-hour timed event, while the card showed the change.
function kindChangeTimesError(storedIsDate, patch) {
  if (typeof patch.all_day !== "boolean" || patch.all_day === storedIsDate) return null;
  if (patch.start_iso && patch.end_iso) return null;
  const to = patch.all_day ? "all-day" : "timed";
  return `the edit makes this ${storedIsDate ? "all-day" : "timed"} event ${to}, which needs both start_iso and end_iso: give both with all_day (for an all-day event, end_iso is the day after its last day). Ask the user for the ${patch.all_day ? "days" : "start time and how long it lasts"} if they did not say`;
}

// editTimesError's refusals, from the kinds and order of an edit's new
// times: `itemIsDate` the item's kind (a time of day for an all-day item needs
// all_day), `startIsDate` and `endIsDate` the new start's and end's, and
// `order` the end against the start (negative, 0 or positive). The series
// path (resolveEditTimes) gives the order of its wall-clock length, so it
// refuses in the same order with the same texts and reads no date twice.
function editTimesErrorOf({ itemIsDate, startIsDate, endIsDate, order }, patch) {
  const kindError = kindChangeTimesError(itemIsDate, patch);
  if (kindError) return kindError;
  if (!patch.start_iso && !patch.end_iso) return null;
  const timed = "become a timed event (all_day: false, with the start time and how long it lasts), then retry with their answer";
  if (itemIsDate && typeof patch.all_day !== "boolean" && (namesTimeOfDay(patch.start_iso) || namesTimeOfDay(patch.end_iso))) {
    return `this is an all-day event, and the edit gives a time of day without all_day. Ask the user whether it should stay all-day (dates only, with end_iso the day after its last day) or ${timed}`;
  }
  if (startIsDate !== endIsDate) {
    return `the edit would leave the start ${startIsDate ? "all-day" : "timed"} and the end ${endIsDate ? "all-day" : "timed"}: a start or end the edit leaves out keeps its kind. Give both start_iso and end_iso, with all_day`;
  }
  if (startIsDate) {
    if (order > 0) return null;
    return `this is an all-day event, so its end_iso is the day after its last day and must be later than start_iso. Ask the user how many days it should last, or whether it should ${timed}`;
  }
  if (order >= 0) return null;
  const ask = patch.start_iso ? "Ask" : "An end_iso alone changes only the end and keeps the start; to move the event, give start_iso too, or ask";
  return `the event would end before it starts. ${ask} the user when it should start and end`;
}

// toCalIDateTime for an edit of `item`, whose new times it gives in the item's
// frame, as Thunderbird's event dialog keeps an event's zone: in a zoned item's
// own zone at the same instant, and for a floating item at the user's clock
// digits, kept floating (the inverse of asShown). The one conversion is
// intoFrameOf, which throws the refusal for a time the item's zone cannot store
// at that instant or that the given zone skips, as an unknown zone already
// throws: the edit fails then, before anything is written. A new start read in the
// user's zone would otherwise move the item into it: its rule would expand
// there (a weekday in the series' zone can be another in the user's), and its
// excluded and added dates and changed occurrences, which Thunderbird moves
// with the start (onStartDateChange), would no longer meet its occurrences.
// An all-day value is the date as read, with no zone (asAllDayDate); an edit
// from all day to timed is given as read. An edit that leaves all_day out keeps
// the item's kind, as the edit tool documents ("Leave empty to keep existing"):
// read as timed, a new date for an all-day event made it a timed one (#309).
// An all-day value keeps only the date: a time of day given for an all-day
// item without all_day is refused once the times are applied (editTimesError).
function toCalIDateTimeInFrameOf(item, patch) {
  const start = item && item.startDate;
  const allDay = typeof patch.all_day === "boolean" ? patch.all_day : !!start?.isDate;
  return (iso, tzId) => {
    const dt = toCalIDateTime(iso, tzId);
    if (dt && allDay) return asAllDayDate(dt);
    if (!dt || dt.isDate || !start || start.isDate) return dt;
    return intoFrameOf(start, dt);
  };
}

// -------- Series time edits: one reading of an edit's times --------
// A time change of a repeating series (or of the part a split starts) works as
// Google Calendar's "All events" (#287, #351): its times are read against the
// occurrence the edit names as Thunderbird builds it, and a time that only
// restates what the read tools print for it is no change. Its length is
// wall-clock: the digits from the start to the end given, which every
// occurrence takes the way Thunderbird builds a plain one (its own start plus
// the length by the clock, CalEvent.createProxy). A stored time is never
// converted into another zone: getInTimezone lands an hour off near a clock
// change. A given time reaches the event's zone only through
// atInstantInFrameOf, which returns null rather than a value Thunderbird would
// read at another instant; a null is a refusal before anything is written.
// test/calendarSeriesTimeFence.test.js pins which of these may measure or add
// a length.

// The refusals of this reading. Each names what the user can give instead.
const FIRST_NIGHT_REPEATED_HOUR_ERROR = "the first occurrence would end inside the hour the clocks repeat that night, which the calendar cannot store as the length asked; ask the user for another end time, or to start the change from another occurrence";
const NAMED_OTHER_KIND_ERROR = "the occurrence this edit names was made all-day or timed on its own, so the new length of the other occurrences cannot be measured from it; give start_iso too, or name another occurrence";
function skippedTimeError(given) {
  return `${digitsOf(given)} does not exist in ${given.timezone.tzid}: the clocks skip that time that day; ask the user for another time`;
}
function repeatedHourError(given, tzid) {
  return `${digitsOf(given)} in ${given.timezone.tzid} falls in the first of the two passes of the hour the clocks repeat in this event's time zone (${tzid}) that night, which the calendar cannot store for this event; ask the user for a time outside that hour`;
}

// A value's own digits, "YYYY-MM-DDTHH:MM:SS", as given.
function digitsOf(dt) {
  return `${toDayString(dt)}T${pad2(dt.hour)}:${pad2(dt.minute)}:${pad2(dt.second)}`;
}

// A calIDuration of `seconds` (signed), through its construction contract
// (registered on every Thunderbird the add-on supports).
function durationOf(seconds) {
  const duration = Cc["@mozilla.org/calendar/duration;1"].createInstance(Ci.calIDuration);
  duration.inSeconds = seconds;
  return duration;
}

// The wall-clock seconds from `b` to `a`: the difference of their digits, each
// read as it is (a DATE's time of day is 0, so all-day lengths are whole days).
function clockSeconds(a, b) {
  return (Date.UTC(a.year, a.month, a.day, a.hour, a.minute, a.second)
    - Date.UTC(b.year, b.month, b.day, b.hour, b.minute, b.second)) / 1000;
}

// The value, in `start`'s frame, that Thunderbird reads `seconds` of elapsed
// time after `start` (subtractDate), or null when there is none: a clock add,
// corrected by the drift a clock change makes. Null only when the value would
// fall in the first pass of the hour the clocks repeat, which the zone cannot
// store. A series' stored end is this value, so Thunderbird's own length of
// the series (DTEND minus DTSTART, elapsed) is the length asked.
function afterElapsed(start, seconds) {
  const out = start.clone();
  out.addDuration(durationOf(seconds));
  const drift = seconds - out.subtractDate(start).inSeconds;
  if (drift) out.addDuration(durationOf(drift));
  return out.subtractDate(start).inSeconds === seconds ? out : null;
}

// `target`'s instant as a value in `anchor`'s frame, or null when that frame
// cannot store it (the first pass of its repeated hour): from `anchor` moved by
// whole days (86400 seconds each) to a day before `target`, then the elapsed
// time to it.
function atInstantInFrameOf(anchor, target) {
  const from = anchor.clone();
  from.addDuration(durationOf((Math.floor(target.subtractDate(anchor).inSeconds / 86400) - 1) * 86400));
  return afterElapsed(from, target.subtractDate(from).inSeconds);
}

// A timed value given for an edit (toCalIDateTime's), in the frame of
// `anchor`, the stored start it is read against. Throws the refusal, as
// toCalIDateTime throws an unknown zone: digits the given zone skips; a time
// in another zone that `anchor`'s zone cannot store at that instant. In
// `anchor`'s own zone the value is kept as given; a floating anchor takes the
// digits of the user's clock, kept floating (the inverse of asShown).
function intoFrameOf(anchor, given) {
  const back = atInstantInFrameOf(given, given);
  if (!back || clockSeconds(back, given) !== 0) throw new Error(skippedTimeError(given));
  if (anchor.timezone.tzid === given.timezone.tzid) return given;
  if (anchor.timezone.tzid === "floating") {
    const user = getTimezoneService().defaultTimezone;
    const shown = given.timezone.tzid === user.tzid ? given : atInstantInFrameOf(asShown(anchor), given);
    if (!shown) throw new Error(repeatedHourError(given, user.tzid));
    const kept = shown.clone();
    kept.resetTo(shown.year, shown.month, shown.day, shown.hour, shown.minute, shown.second, anchor.timezone);
    return kept;
  }
  const out = atInstantInFrameOf(anchor, given);
  if (!out) throw new Error(repeatedHourError(given, anchor.timezone.tzid));
  return out;
}

// Whether an edit's start_iso or end_iso (`iso`, given in `tz` or on the user's
// clock) is the stored value `stored` as the read tools print it. A given
// all_day other than the stored kind never restates. On the user's clock, and
// for a date, the strings are compared, never the instants: inside the hour
// the clocks repeat, the printed string is read back as the later pass.
function restates(iso, tz, stored, allDay) {
  if (typeof allDay === "boolean" && allDay !== !!stored.isDate) return false;
  if (stored.isDate || !tz || tz === getTimezoneService().defaultTimezone?.tzid) return iso === shownNaiveIso(stored);
  return toCalIDateTime(iso, tz).subtractDate(asShown(stored)).inSeconds === 0;
}

// The one rule for a time an edit only restates, on every scope: of `patch`'s
// start_iso and end_iso, those left once a value that restates `ref`'s (the
// event, the occurrence, or the occurrence a series edit names) is dropped.
// An end is dropped only when no new start is left: with a new start, the end
// given sets the length from it.
function timesLeft(ref, patch, tz) {
  const start_iso = patch.start_iso && !restates(patch.start_iso, tz, ref.startDate, patch.all_day) ? patch.start_iso : undefined;
  const end_iso = patch.end_iso && (start_iso || !ref.endDate || !restates(patch.end_iso, tz, ref.endDate, patch.all_day)) ? patch.end_iso : undefined;
  return { start_iso, end_iso };
}

// Thunderbird's own length of a series (its duration: DTEND minus DTSTART,
// elapsed), which every plain occurrence adds to its start by the clock.
function seriesLength(item) {
  return item.endDate.subtractDate(item.startDate).inSeconds;
}

// The one decision point for a time change of a series, or of the part a split
// starts (`item`, an all-day one already through asAllDayItem): the edit's
// times read against the occurrence it names (`namedRid`, or the first one),
// as Thunderbird builds it. Returns `{ error }`, or `{ start, length, ref,
// refIsChanged, named }`: the item's new start in its frame (or null), the
// wall-clock length (or null when no time is left), the occurrence read
// against, whether it was changed on its own, and the named occurrence's slot
// once written (its new start, or its slot when no start is left). Throws the
// refusals of reading a time (intoFrameOf), as toCalIDateTime throws an
// unknown zone.
function resolveEditTimes(item, patch, tz, namedRid) {
  const info = item.recurrenceInfo;
  // The named occurrence's slot in the item's frame. It is the item's start
  // unless the occurrences before it are excluded (#386): the series then
  // moves by the named occurrence's change, from its slot.
  const slotStart = !namedRid ? item.startDate : namedRid.isDate ? namedRid.clone() : intoFrameOf(item.startDate, namedRid);
  const slot = item.createProxy(slotStart);
  let ref = namedRid ? info.getOccurrenceFor(namedRid) : slot;
  let refIsChanged = !!(namedRid && info.getExceptionFor(namedRid));
  // An edit named at an occurrence changed on its own is read against the
  // series' plain occurrence there (`slot`) when it changes the series' kind,
  // or gives the series' own start, and does not change that occurrence's
  // kind: then it changes the series, not that occurrence. The series' own
  // start is the time the series already has: no change, as in Google
  // Calendar (the moved occurrence keeps its own time), and an end is
  // measured from that start. A change of kind (all_day other than the
  // series') at an occurrence already of that kind, given that occurrence's
  // own dates, changes every other occurrence: read against the occurrence,
  // its times would restate and be dropped, and the edit would be answered
  // "Nothing changed". An edit that changes the named occurrence's kind is
  // read against it (its old times are the card's).
  const changesSeriesKind = typeof patch.all_day === "boolean" && patch.all_day !== !!item.startDate.isDate;
  const changesNamedKind = typeof patch.all_day === "boolean" && patch.all_day !== !!ref.startDate.isDate;
  if (refIsChanged && !changesNamedKind && (changesSeriesKind || (patch.start_iso && restates(patch.start_iso, tz, slot.startDate, patch.all_day)
    && !restates(patch.start_iso, tz, ref.startDate, patch.all_day)))) {
    ref = slot;
    refIsChanged = false;
  }
  // The one check of a change of kind here: against the occurrence read
  // against, it needs both times (a time given with a kind other than that
  // occurrence's never restates it, so none is dropped).
  const kindError = kindChangeTimesError(!!ref.startDate.isDate, patch);
  if (kindError) return { error: kindError };
  const left = timesLeft(ref, patch, tz);
  if (!left.start_iso && !left.end_iso) return { start: null, length: null, ref, refIsChanged };
  if (!left.start_iso && refIsChanged && !!ref.startDate.isDate !== !!item.startDate.isDate) {
    return { error: NAMED_OTHER_KIND_ERROR };
  }
  const start = left.start_iso ? toCalIDateTimeInFrameOf(item, patch)(left.start_iso, tz) : null;
  const end = left.end_iso ? toCalIDateTimeInFrameOf(start ? item : ref, patch)(left.end_iso, tz) : null;
  const startIsDate = start ? !!start.isDate : !!(end ? ref : item).startDate.isDate;
  const endIsDate = end ? !!end.isDate : !!item.endDate.isDate;
  let length = null;
  if (startIsDate === endIsDate) length = end ? clockSeconds(end, start || ref.startDate) : seriesLength(item);
  const error = editTimesErrorOf({ itemIsDate: !!item.startDate.isDate, startIsDate, endIsDate, order: Math.sign(length) }, { ...left, all_day: patch.all_day });
  if (error) return { error };
  return { start: start && seriesStartFor(item, slotStart, start), length, ref, refIsChanged, named: start || slotStart };
}

// The start of `item`'s series that puts the occurrence at `slotStart` (a slot
// in the item's frame) at `start`: `start` moved back by the clock from the
// item's start to that slot, in whole days by the date digits when `start` is
// a date. `start` itself when the slot is the item's start.
function seriesStartFor(item, slotStart, start) {
  const gap = start.isDate
    ? (Date.UTC(slotStart.year, slotStart.month, slotStart.day) - Date.UTC(item.startDate.year, item.startDate.month, item.startDate.day)) / 1000
    : clockSeconds(slotStart, item.startDate);
  if (!gap) return start;
  const out = start.clone();
  out.addDuration(durationOf(-gap));
  return out;
}

// Writes a series' (or a split part's) times: `start` when given, and the end
// Thunderbird reads `length` after it (afterElapsed), so every plain occurrence
// lasts `length` by the clock. `{ error }` when the first occurrence would end
// in the first pass of the hour the clocks repeat; nothing is written then.
// The only writer of a series' or part's times.
function writeSeriesTimes(item, start, length) {
  const end = afterElapsed(start || item.startDate, length);
  if (!end) return { error: FIRST_NIGHT_REPEATED_HOUR_ERROR };
  if (start) item.startDate = start;
  item.endDate = end;
  return {};
}

// A series' new length on each of its changed occurrences of its own kind:
// the occurrence's own start plus `length` by the clock, as Thunderbird builds
// a plain occurrence there. Its start, fields and guests are kept. One made
// all-day or timed on its own keeps its times.
function applyNewLength(item, length) {
  const info = item.recurrenceInfo;
  for (const rid of [...(info?.getExceptionIds({}) || [])]) {
    const ex = info.getExceptionFor(rid);
    if (!ex?.startDate || !!ex.startDate.isDate !== !!item.startDate.isDate) continue;
    const resized = ex.clone();
    const end = ex.startDate.clone();
    end.addDuration(durationOf(length));
    resized.endDate = end;
    info.modifyException(resized, false);
  }
}

// Whether a recurrence item excludes a date (EXDATE).
function isExdateItem(r) {
  return !!r?.isNegative && !!r.date;
}

// A new start of a series (or of the following part of a split) resets it, as
// Google Calendar's "All events" does: every occurrence changed on its own goes
// back to the series' times and fields, and every excluded date comes back.
// Called before the edit's own excluded dates are added, so those stay. An edit
// that stops the series repeating resets nothing. Returns whether anything was
// reset (the card says so).
function resetChangedOccurrences(item, patch) {
  const info = item.recurrenceInfo;
  const stopsRepeating = !!patch.recurrence && typeof patch.recurrence === "object" && !patch.recurrence.freq;
  if (!info || stopsRepeating) return false;
  const changed = [...(info.getExceptionIds({}) || [])];
  const excluded = [...(info.getRecurrenceItems({}) || [])].filter(isExdateItem);
  for (const rid of changed) info.removeExceptionFor(rid);
  for (const r of excluded) info.deleteRecurrenceItem(r);
  return changed.length + excluded.length > 0;
}

// The times an edit changes, as the confirmation card shows them: `from` and
// `to` items (their start and end as the read tools print them, and their
// kind), or undefined when neither string nor kind differs.
function shownEditTimes(from, to) {
  const side = (it) => ({
    start_iso: it.startDate ? shownNaiveIso(it.startDate) : "",
    end_iso: it.endDate ? shownNaiveIso(it.endDate) : "",
    all_day: !!it.startDate?.isDate,
  });
  const a = side(from), b = side(to);
  if (a.start_iso === b.start_iso && a.end_iso === b.end_iso && a.all_day === b.all_day) return undefined;
  return { from: a, to: b };
}

// The card's times for a series or split part `item` once its times are
// written: from the occurrence the edit named (`resolved.ref`) to that
// occurrence as written. An end alone at an occurrence changed on its own
// resized that one; otherwise the occurrence is the named one at its slot as
// written (a new start has reset every changed occurrence). Its slot is the
// item's start unless the occurrences before it are excluded (#386).
function seriesEditTimes(item, resolved) {
  const to = !resolved.start && resolved.refIsChanged
    ? item.recurrenceInfo.getExceptionFor(resolved.ref.recurrenceId)
    : item.createProxy(resolved.named);
  return shownEditTimes(resolved.ref, to);
}

// Whether two event times are the same: two DATEs on the same day, or two
// date-times at the same instant in the same zone (floating with floating). A
// time relabelled into another zone is a change even at the same instant: the
// series' later occurrences follow that zone's daylight saving time, and
// Thunderbird's prepareSequence compares DTSTART with its TZID.
function sameTime(a, b) {
  if (!a || !b || !!a.isDate !== !!b.isDate) return false;
  if (a.isDate) return a.compare(b) === 0;
  return a.timezone?.tzid === b.timezone?.tzid && a.nativeTime === b.nativeTime;
}

function toEpochMsUTC(calDt) {
  try {
    if (!calDt) return null;
    const tzService = getTimezoneService();
    const asUtc = typeof calDt.getInTimezone === 'function' ? calDt.getInTimezone(tzService.UTC) : calDt;
    const y = Number(asUtc.year);
    const m = Number(asUtc.month);
    const d = Number(asUtc.day);
    const hh = Number(asUtc.hour || 0);
    const mm = Number(asUtc.minute || 0);
    const ss = Number(asUtc.second || 0);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    return Date.UTC(y, m, d, hh, mm, ss);
  } catch (_) { return null; }
}

function wireEventEditorCallbacks(onAccept, onCancel) {
  try {
    const Ci = globalThis.Ci, Cc = globalThis.Cc;
    const wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);

    // Try dialog window first
    const dlg = wm.getMostRecentWindow("Calendar:EventDialog") || wm.getMostRecentWindow("Calendar:EventDialog:Edit");
    if (dlg && dlg.document) {
      // In newer TB, the editor lives in an iframe: #calendar-item-iframe
      const iframe = dlg.document.getElementById("calendar-item-iframe");
      const targetWin = iframe?.contentWindow || dlg;
      targetWin.onAcceptCallback = onAccept;
      targetWin.onCancelCallback = onCancel;
      tmCalendarDebugLog("[tmCalendar] wireEventEditorCallbacks: wired callbacks to dialog iframe");
      return true;
    }

    // Fallback: editor opened in a TAB inside the 3pane
    const w3 = wm.getMostRecentWindow("mail:3pane");
    if (w3 && w3.document) {
      // Look for the editor browser/iframe in the current tab
      // (IDs can vary; grab by src or id heuristics)
      const editorSelector =
        'browser[src*="calendar-event-dialog.xhtml"], ' +
        'iframe#calendar-item-iframe, ' +
        'browser#calendar-item-iframe';

      // Give the tab a moment to mount the editor iframe
      const { nsITimer } = Ci;
      const timer = Cc["@mozilla.org/timer;1"].createInstance(nsITimer);
      let attempts = 0;

      timer.init(function tick() {
        attempts += 1;
        const el = w3.document.querySelector(editorSelector);
        const targetWin = el?.contentWindow;
        if (targetWin) {
          targetWin.onAcceptCallback = onAccept;
          targetWin.onCancelCallback = onCancel;
          tmCalendarDebugLog("[tmCalendar] wireEventEditorCallbacks: wired callbacks to tab iframe after", attempts, "attempts");
          try { timer.cancel(); } catch {}
          return;
        }
        if (attempts >= 30) { // ~3s total if 100ms step
          console.warn("[tmCalendar] wireEventEditorCallbacks: failed to find editor iframe after 30 attempts");
          try { timer.cancel(); } catch {}
          return;
        }
        // reschedule
        timer.init(tick, 100, nsITimer.TYPE_ONE_SHOT);
      }, 100, nsITimer.TYPE_ONE_SHOT);

      return true;
    }
  } catch (e) {
    console.warn("[tmCalendar] wireEventEditorCallbacks failed:", e);
  }
  return false;
}

// UNREACHABLE WIP: every call site is commented out ("does not work yet and
// fails to find iMIP transport"). Two of its XPCOM lookups are dead in current
// Thunderbird and are deliberately left as-is rather than half-fixed here:
//   @mozilla.org/calendar/itip-service;1    contract AND the calIItipService
//                                           interface are gone; the
//                                           calIItipItem construction below is
//                                           already the live path
//   @mozilla.org/calendar/itip-transport;1  never registered bare — Thunderbird
//                                           only registers the
//                                           "?type=email" form, which is why
//                                           this function could never resolve a
//                                           transport
// Reviving iMIP send means starting from those two facts.
async function sendCalendarInvitations(event, calendar, method = "REQUEST", organizerEmail = null) {
  try {
    const Ci = globalThis.Ci, Cc = globalThis.Cc;

    // 0) Make a mutable working copy
    let work = event?.clone ? event.clone() : event;
    if (!work) return { ok: false, error: "no event/clone to send" };

    // 1) Gather attendees
    const attendees = work.getAttendees ? work.getAttendees() : [];
    if (!attendees.length) return { ok: true, message: "no attendees to invite" };

    // 2) Ensure ORGANIZER is set on the clone (optional but nice)
    if (!work.organizer && organizerEmail) {
      const org = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
      org.id = organizerEmail.startsWith("mailto:") ? organizerEmail : `mailto:${organizerEmail}`;
      try { org.commonName = organizerEmail; } catch {}
      try { org.isOrganizer = true; } catch {}
      try { work.organizer = org; } catch {}
    }

    // 3) Build ICS with METHOD using the serializer
    const icsService = getIcsService();
    const serializer = Cc["@mozilla.org/calendar/ics-serializer;1"].createInstance(Ci.calIIcsSerializer);
    serializer.addItems([work]);

    const methodProp = icsService.createIcalProperty("METHOD");
    methodProp.value = method;
    serializer.addProperty(methodProp);

    const ics = serializer.serializeToString();

    // 4) Create a real calIItipItem via the service (preferred), with fallback.
    let itip;
    try {
      const itipSvc = Cc["@mozilla.org/calendar/itip-service;1"].getService(Ci.calIItipService);
      itip = itipSvc.createItipItem(ics, null);
    } catch (_) {}
    if (!itip) {
      itip = Cc["@mozilla.org/calendar/itip-item;1"].createInstance(Ci.calIItipItem);
      itip.init(ics);
    }
    // Sanity check: ensure we really have the interface (and its native method)
    try { itip.QueryInterface(Ci.calIItipItem); } catch (e) {
      return { ok: false, error: "failed to construct calIItipItem" };
    }
    if (typeof itip.getItemList !== "function") {
      return { ok: false, error: "calIItipItem missing getItemList()" };
    }

    // 5) Hint flags (safe assignments that exist on the interface)
    try { itip.isSend = true; } catch {}
    try { itip.targetCalendar = calendar; } catch {}

    // Debug logging to verify the iTIP item is properly constructed
    tmCalendarDebugLog("[tmCalendar] iTIP QI ok?", (() => { try { itip.QueryInterface(Ci.calIItipItem); return true; } catch { return false; } })());
    tmCalendarDebugLog("[tmCalendar] has getItemList?", typeof itip.getItemList === "function");
    try {
      const list = itip.getItemList();
      tmCalendarDebugLog("[tmCalendar] itemList size:", Array.isArray(list) ? list.length : "(not array)");
    } catch (e) {
      console.warn("[tmCalendar] getItemList threw:", e);
    }

    // 6) Resolve identity & FORCE the global mail (iMIP) transport.
    let identity = null;
    try { identity = calendar?.getProperty?.("imip.identity") || null; } catch {}
    let transport = null;
    try {
      transport = Cc["@mozilla.org/calendar/itip-transport;1"]
        .getService(Ci.calIItipTransport);
      tmCalendarDebugLog("[tmCalendar] Using MAIL iTIP transport");
    } catch (e) {
      console.error("[tmCalendar] No mail transport available:", e);
      return { ok: false, error: "no mail transport available" };
    }

    // 7) Recipients (exclude organizer)
    const recipients = attendees.filter(a => !a.isOrganizer).map(a => a.id.replace(/^mailto:/i, ""));

    if (!recipients.length) return { ok: true, message: "no recipients to invite" };

    // 8) Send
    return await new Promise((resolve) => {
      const cb = {
        QueryInterface: ChromeUtils.generateQI([Ci.calIItipTransportCallback]),
        onResult: (_op, rc, detail) => {
          if (Components.isSuccessCode(rc)) {
            tmCalendarDebugLog(`[tmCalendar] sendCalendarInvitations: sent ${method} to ${recipients.length} recipients`);
            resolve({ ok: true, recipients: recipients.length, method });
          } else {
            console.error(`[tmCalendar] sendCalendarInvitations: failed to send ${method}:`, detail || rc);
            resolve({ ok: false, error: detail || String(rc) });
          }
        },
      };
      try {
        transport.sendItems(
          itip,
          recipients,
          work.title || "Calendar Invitation",
          method,
          identity || null,
          cb
        );
      } catch (e) {
        console.error("[tmCalendar] sendCalendarInvitations: transport.sendItems failed:", e);
        resolve({ ok: false, error: String(e) });
      }
    });
  } catch (e) {
    console.error("[tmCalendar] sendCalendarInvitations failed (outer):", e);
    return { ok: false, error: String(e) };
  }
}

function pickEditTarget(item, details) {
  // occurrence if it has a recurrenceId
  const isOccurrence = !!item.recurrenceId;
  // does this item (or its parent) represent a recurring series?
  const hasSeries = !!(item.recurrenceInfo || item.parentItem?.recurrenceInfo);

  // scope selection:
  // - explicit details.scope wins if provided ("this" or "series")
  // - otherwise: occurrences -> "this", series parent -> "series", non-recurring -> "this"
  const explicit = (details && (details.scope === "this" || details.scope === "series")) ? details.scope : null;
  const scope = explicit || (isOccurrence ? "this" : (hasSeries ? "series" : "this"));

  const base = scope === "series" ? (item.parentItem || item) : item;
  return { base, scope, isOccurrence, hasSeries };
}

var tmCalendar = class extends ExtensionCommonTMCal.ExtensionAPI {
  getAPI(context) {
    // Lexical self-reference so methods can call sibling methods without
    // relying on `this` (the WebExtension framework can rebind `this` on
    // experiment APIs, so `this.splitRecurringEvent` would not be reliable
    // inside `modifyCalendarEvent`'s edit_scope routing).
    const tmCalApi = {
        async listCalendars() {
          try {
            const res = listCalendarsInternal();
            return res;
          } catch (e) {
            // suppressed
            return [];
          }
        },
        async queryCalendarItems(start, end, calendarIds) {
          try {
            const s = String(start || "");
            const e = String(end || "");
            const ids = Array.isArray(calendarIds) ? calendarIds.map(String) : [];
            tmCalendarDebugLog(`[tmCalendar] queryCalendarItems invoked start='${s}' end='${e}' calIds=${JSON.stringify(ids)}`);
            const res = await queryCalendarItemsInternal(s, e, ids);
            return res;
          } catch (e) {
            // suppressed
            return [];
          }
        },
        async getCalendars() {
          try {
            const mgr = getCalendarManager();
            if (!mgr) {
              console.error("[tmCalendar] getCalendars: calendar manager unavailable");
              return { ok: false, error: "calendar manager unavailable" };
            }
            
            const calendars = Array.from(mgr.getCalendars({})).map(cal => {
              let organizerEmail = null;
              try {
                const identity = cal.getProperty && cal.getProperty("imip.identity");
                if (identity && typeof identity === "object" && "email" in identity && identity.email) {
                  organizerEmail = String(identity.email);
                }
              } catch (_) {}
              
              return {
                id: String(cal.id),
                name: String(cal.name || cal.id),
                type: String(cal.type || 'unknown'),
                readOnly: Boolean(cal.readOnly),
                color: String(cal.getProperty?.("color") || ""),
                uri: String(cal.uri?.spec || ""),
                organizer_email: organizerEmail
              };
            });
            
            tmCalendarDebugLog(`[tmCalendar] getCalendars: found ${calendars.length} calendars`);
            return { ok: true, calendars };
          } catch (e) {
            console.error("[tmCalendar] getCalendars failed:", e);
            return { ok: false, error: String(e) };
          }
        },
        async getCalendarEventDetails(event_id, calendar_id = null, recurrence_id = null) {
          try {
            const Ci = globalThis.Ci; const Cc = globalThis.Cc;
            const mgr = getCalendarManager();
            if (!mgr) return { ok: false, error: "calendar manager unavailable" };
            const eid = String(event_id || "");
            if (!eid) return { ok: false, error: "event_id is required" };
            let targetEvent = null;
            let targetCalendar = null;
            const allCalendars = Array.from(mgr.getCalendars({}));
            
            // If calendar_id is provided, search that calendar first
            if (calendar_id) {
              const cal = allCalendars.find(c => String(c.id) === String(calendar_id));
              if (cal) {
                try {
                  const item = await cal.getItem(eid);
                  if (item) { targetEvent = item; targetCalendar = cal; }
                } catch (_) {}
              }
            }
            
            // If not found in specific calendar (or no calendar_id provided), search all calendars
            if (!targetEvent) {
              for (const cal of allCalendars) {
                try {
                  const item = await cal.getItem(eid);
                  if (item) { targetEvent = item; targetCalendar = cal; break; }
                } catch (_) {}
              }
            }
            
            if (!targetEvent) return { ok: false, error: "event not found" };
            let attendeesCount = 0;
            let attendeeList = [];
            try { 
              const list = targetEvent.getAttendees ? targetEvent.getAttendees() : []; 
              attendeesCount = Array.isArray(list) ? list.length : 0;
              attendeeList = Array.isArray(list) ? list.map(attendee => ({
                name: attendee.commonName || "",
                email: attendee.id || "",
                status: attendee.participationStatus || "NEEDS-ACTION"
              })) : [];
            } catch (_) {}
            // The event as Thunderbird shows it: with a recurrence_id that names
            // an occurrence, that occurrence (its own times and kind when it was
            // changed on its own, #369); a series without one, its first
            // occurrence as Thunderbird expands it (firstOccurrenceOf: not
            // DTSTART when the occurrence there is excluded or moved, #386,
            // #404; a plain one is its start plus the series' length by the
            // clock, which is what Thunderbird shows for every occurrence even
            // when the stored end of a first one that spans a clock change
            // differs). A series with no occurrence left shows its stored start.
            const series = targetEvent.parentItem || targetEvent;
            const named = recurrence_id && series.recurrenceInfo ? occurrenceNamedBy(series, recurrence_id) : null;
            const shown = named?.occurrence
              || (targetEvent.recurrenceInfo ? firstOccurrenceOf(targetEvent) || targetEvent.createProxy(targetEvent.startDate) : targetEvent);
            const details = {
              id: eid,
              ...editableFieldsOf(targetEvent),
              start: (() => { try { return shown.startDate ? asShown(shown.startDate).nativeTime / 1000 : null; } catch { return null; } })(),
              end: (() => { try { return shown.endDate ? asShown(shown.endDate).nativeTime / 1000 : null; } catch { return null; } })(),
              isAllDay: !!(shown.startDate && shown.startDate.isDate),
              startDay: shown.startDate?.isDate ? toDayString(shown.startDate) : "",
              endDay: shown.endDate?.isDate ? toDayString(shown.endDate) : "",
              organizer: (() => { try { return String(targetEvent.organizer ? (targetEvent.organizer.commonName || targetEvent.organizer.id || "") : ""); } catch { return ""; } })(),
              attendees: attendeesCount,
              attendeeList: attendeeList,
              calendarId: String(targetCalendar?.id || ""),
              calendarName: String(targetCalendar?.name || targetCalendar?.id || ""),
              isRecurring: !!targetEvent.recurrenceInfo,
              // The rule in the create/edit tools' own fields (see
              // recurrenceFieldsOfItem); null when the event does not repeat.
              recurrence: recurrenceFieldsOfItem(targetEvent.parentItem || targetEvent),
            };
            // Whether a given recurrence_id names the series' first occurrence: a
            // whole-series time change names that one, and one named from a
            // later occurrence is a change from it on (#287). One that names no
            // occurrence is left to the edit, which refuses it. An occurrence
            // moved off its slot also gives its original time (the slot), which
            // the confirmation card states: a part split there starts at it
            // unless the edit gives a new start. The fields an edit can name
            // (title, place, notes, busy/free) are then that occurrence's own,
            // as the calendar shows it, so an occurrence changed on its own is
            // compared and shown with its own values, as its times and kind
            // are (above).
            if (named?.occurrence) {
              const { recurrenceId: slot, startDate } = named.occurrence;
              details.recurrenceIdIsFirst = isFirstOccurrence(series, slot);
              if (shownNaiveIso(startDate) !== shownNaiveIso(slot)) details.recurrenceIdSlot = shownNaiveIso(slot);
              Object.assign(details, editableFieldsOf(named.occurrence));
            }
            // Return the event's own id, not re-derived from master
            const returnedId = String(targetEvent.id || targetEvent.parentItem?.id || "");
            return { ok: true, id: returnedId, ...details };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        async setGoogleInvitePolicy(calendarId, policy) {
          // policy: "mail" | "server"
          try {
            const Ci = globalThis.Ci, Cc = globalThis.Cc;
            const mgr = getCalendarManager();
            if (!mgr) return { ok: false, error: "calendar manager unavailable" };
            const cal = Array.from(mgr.getCalendars({}))
              .find(c => String(c.id) === String(calendarId));
            if (!cal) return { ok: false, error: "calendar not found" };
            if (!isGoogleCalDAV(cal)) return { ok: false, error: "not a Google CalDAV calendar" };
            if (policy !== "mail" && policy !== "server") return { ok: false, error: "invalid policy" };
            try { cal.setProperty?.("tabmail.google_invites", policy); } catch {}
            return { ok: true, policy };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        async deleteCalendarEvent(details) {
          try {
            const mgr = getCalendarManager();
            if (!mgr) {
              console.error("[tmCalendar] deleteCalendarEvent: calendar manager unavailable");
              return { ok: false, error: "calendar manager unavailable" };
            }
            const d = details || {};
            const eventId = String(d.event_id || "");
            const calendar_id = String(d.calendar_id || "");  // optional calendar ID for faster lookup
            if (!eventId) {
              console.error("[tmCalendar] deleteCalendarEvent: event_id is required");
              return { ok: false, error: "event_id is required" };
            }

            // Find the event by ID, optionally starting with specific calendar
            let targetEvent = null;
            let targetCalendar = null;
            try {
              const allCalendars = Array.from(mgr.getCalendars({}));
              
              // If calendar_id is provided, search that calendar first
              if (calendar_id) {
                const cal = allCalendars.find(c => String(c.id) === String(calendar_id));
                if (cal) {
                  try {
                    const item = await cal.getItem(eventId);
                    if (item) {
                      targetEvent = item;
                      targetCalendar = cal;
                      tmCalendarDebugLog(`[tmCalendar] deleteCalendarEvent: found event ${eventId} in calendar: ${calendar_id}`);
                    }
                  } catch (e) {
                    console.warn(`[tmCalendar] deleteCalendarEvent: error finding event in calendar ${calendar_id}:`, e);
                  }
                }
              }
              
              // If not found in specific calendar (or no calendar_id provided), search all calendars
              if (!targetEvent) {
                for (const cal of allCalendars) {
                  try {
                    const item = await cal.getItem(eventId);
                    if (item) {
                      targetEvent = item;
                      targetCalendar = cal;
                      tmCalendarDebugLog(`[tmCalendar] deleteCalendarEvent: found event ${eventId} in calendar: ${cal.id}`);
                      break;
                    }
                  } catch (e) {
                    // Continue searching other calendars
                  }
                }
              }
            } catch (e) {
              console.error("[tmCalendar] deleteCalendarEvent: error finding event:", e);
              return { ok: false, error: "failed to find event" };
            }

            if (!targetEvent) {
              console.error("[tmCalendar] deleteCalendarEvent: event not found with id:", eventId);
              return { ok: false, error: "event not found" };
            }

            // A repeating event is deleted by scope (delete_scope), which it
            // must name: there is no default. "all" deletes the stored series;
            // "this_only" excludes the occurrence recurrence_id names (as the
            // series edit's exdates_add does, on a copy); "this_and_following"
            // writes the series before that occurrence (earlierPartBefore, the
            // split's earlier part), so it and every later occurrence go. An
            // event that does not repeat is deleted whatever the scope says.
            // `replacement` is the series written in place of the stored one,
            // or null when the stored item is deleted.
            const series = targetEvent.parentItem || targetEvent;
            let scope = null;
            let replacement = null;
            if (series.recurrenceInfo) {
              scope = String(d.delete_scope || "");
              if (!DELETE_SCOPES.includes(scope)) {
                return { ok: false, error: "delete_scope is required for a repeating event: 'this_only', 'this_and_following' or 'all'" };
              }
              if (scope !== "all") {
                const recurIdStr = String(d.recurrence_id || "");
                if (!recurIdStr) {
                  return { ok: false, error: `delete_scope='${scope}' requires recurrence_id (the start_iso of the target occurrence — use calendar_event_read or calendar_read to find it). Retry the call including recurrence_id.` };
                }
                const named = occurrenceNamedBy(series, recurIdStr);
                if (named.error) return { ok: false, error: named.error };
                const rid = named.occurrence.recurrenceId;
                if (scope === "this_only") {
                  replacement = series.clone();
                  asAllDayItem(replacement);
                  addExdateToItem(replacement, rid);
                } else {
                  if (isFirstOccurrence(series, rid)) {
                    return { ok: false, error: "recurrence_id is the series' first occurrence: to delete every occurrence, use delete_scope 'all'" };
                  }
                  const earlier = earlierPartBefore(series, rid);
                  if (earlier.error) return { ok: false, error: earlier.error };
                  replacement = earlier.part;
                }
              }
            }
            // A check before the confirmation card stops here, before any
            // write: every refusal is above.
            if (d.check_only) return { ok: true, scope };
            // The series written in place of the stored one names the
            // calendar's own address as organizer when it has guests and none.
            // A whole-event delete writes nothing, so it is left as stored.
            const organizerResult = replacement ? setOwnOrganizerIfGuests(replacement, targetCalendar) : null;

            try {
              // Send cancellation invitations before deleting (if requested)
              let invitationResult = null;
              if (details.send_invitations && targetEvent) {
                const attendees = targetEvent.getAttendees ? targetEvent.getAttendees() : [];
                if (attendees.length > 0) {
                  const policy = getInvitePolicy(targetCalendar);
                  tmCalendarDebugLog(`[tmCalendar] deleteCalendarEvent: invite policy=${policy}`);
                  if (policy === "mail") {
                    tmCalendarDebugLog("[tmCalendar] deleteCalendarEvent: iMIP cancellation invitations not implemented yet");
                    invitationResult = { ok: false, error: "Email cancellation invitations via Thunderbird are not implemented yet. Please contact the developer or wait for future releases. For now, you can delete events without sending cancellation notices." };
                    // OLD CODE that was WIP -- does not work yet and fails to find iMIP transport
                    // invitationResult = await sendCalendarInvitations(targetEvent, targetCalendar, "CANCEL", details.organizer_email);
                  } else {
                    tmCalendarDebugLog("[tmCalendar] deleteCalendarEvent: relying on provider/server notifications; no cancellation emails sent");
                    invitationResult = { ok: true, message: "provider/server notifications assumed" };
                  }
                }
              }
              
              if (replacement) {
                tmCalendarDebugLog(`[tmCalendar] deleteCalendarEvent: deleting occurrences (${scope}) of:`, eventId);
                await targetCalendar.modifyItem(replacement, series);
              } else {
                tmCalendarDebugLog("[tmCalendar] deleteCalendarEvent: deleting event:", eventId);
                await targetCalendar.deleteItem(targetEvent);
              }
              tmCalendarDebugLog("[tmCalendar] deleteCalendarEvent: event deleted successfully");
              // Return the item's own id
              const returnedId = String(targetEvent.id || "");
              return { 
                ok: true,
                id: returnedId,
                scope,
                invitations: invitationResult,
                ...guestNoticeOf(targetCalendar, [organizerResult])
              };
            } catch (e) {
              console.error("[tmCalendar] deleteCalendarEvent failed:", e);
              return { ok: false, error: String(e) };
            }
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        async createCalendarEvent(details) {
          try {
            const Ci = globalThis.Ci; const Cc = globalThis.Cc;
            const mgr = getCalendarManager();
            if (!mgr) return { ok: false, error: "calendar manager unavailable" };
            
            // Validate attendees when invitations are requested
            const sendInvites = !!details.send_invitations;
            const attendees = Array.isArray(details.attendees) ? details.attendees : [];
            if (sendInvites && attendees.length === 0) {
              return { ok: false, error: "send_invitations=true requires at least one attendee" };
            }
            
            const cal = (() => {
              const all = Array.from(mgr.getCalendars({}));
              if (details.calendar_id) {
                return all.find(c => String(c.id) === String(details.calendar_id)) || all[0] || null;
              }
              return all[0] || null;
            })();
            if (!cal) return { ok: false, error: "no calendar available" };

            const ev = Cc["@mozilla.org/calendar/event;1"].createInstance(Ci.calIEvent);
            if (details.title) ev.title = String(details.title);
            const tzOverride = typeof details.timezone === "string" && details.timezone ? details.timezone : null;
            const start = toCalIDateTime(String(details.start_iso || ""), tzOverride);
            const end = toCalIDateTime(String(details.end_iso || ""), tzOverride);
            if (start) { if (details.all_day) asAllDayDate(start); ev.startDate = start; }
            if (end) { if (details.all_day) asAllDayDate(end); ev.endDate = end; }
            // An all-day end is the day after the last day (RFC 5545: DTEND
            // is exclusive and later than DTSTART). One on or before the
            // start would make a zero-length event, so it is refused before
            // anything is written; check_only stops here, for the create
            // tool to refuse it before its confirmation card.
            if (details.all_day && start && end && end.compare(start) <= 0) {
              return { ok: false, error: "an all-day event's end_iso is the day after its last day, so it must be later than start_iso: for an event on one day, give the next day as end_iso, then retry" };
            }
            if (details.check_only) return { ok: true };
            if (details.location) { try { ev.setProperty("LOCATION", String(details.location)); } catch {} }
            
            // Handle description with optional conference URL
            let fullDesc = String(details.description || "");
            if (details.conference_url) {
              const joinLine = fullDesc ? "\n\nJoin: " : "Join: ";
              fullDesc = `${fullDesc}${joinLine}${String(details.conference_url)}`;
            }
            if (fullDesc) { try { ev.setProperty("DESCRIPTION", fullDesc); } catch {} }

            // Transparency: default to busy (OPAQUE) if not provided
            try {
              const requested = String(details.transparency || "busy").toLowerCase();
              const transVal = requested === "free" ? "TRANSPARENT" : "OPAQUE";
              const before = String(ev.getProperty?.("TRANSP") || "");
              ev.setProperty("TRANSP", transVal);
              tmCalendarDebugLog("[tmCalendar] createCalendarEvent: TRANSP set from", before || "(none)", "to", transVal);
            } catch (e) {
              console.warn("[tmCalendar] createCalendarEvent: failed to set TRANSP:", e);
            }

            // attendees
            if (Array.isArray(details.attendees)) {
              for (const a of details.attendees) {
                const email = a?.email || a?.id || a?.address;
                if (!email) continue;
                const att = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
                att.id = String(email).startsWith("mailto:") ? String(email) : `mailto:${String(email)}`;
                if (a?.name) try { att.commonName = String(a.name); } catch {}
                try { att.rsvp = "TRUE"; } catch {}
                try { ev.addAttendee(att); } catch {}
              }
            }

            // The organizer, BEFORE adding to the calendar (to avoid
            // immutability issues): the calendar's own address when the event
            // has guests, never one the model gave (setOwnOrganizerIfGuests).
            const organizerResult = setOwnOrganizerIfGuests(ev, cal);

            // Recurrence
            if (details.recurrence && typeof details.recurrence === "object") {
              const recRes = applyRecurrenceToItem(ev, details.recurrence);
              try { if (recRes.value) tmCalendarDebugLog("[tmCalendar] createCalendarEvent: RRULE=", recRes.value); } catch (_) {}
            }

            // Persist (returns the created item)
            const created = await cal.addItem(ev);
            tmCalendarDebugLog("[tmCalendar] createCalendarEvent: created event with id:", created?.id);
            try { const transpSaved = String(created?.getProperty?.("TRANSP") || ""); tmCalendarDebugLog("[tmCalendar] createCalendarEvent: initial TRANSP on created:", transpSaved || "(empty)"); } catch (_) {}
            try {
              let rruleStr = "";
              try { rruleStr = rruleOfItem(created) || rruleOfItem(ev); } catch (_) {}
              const rApplied = !!(rruleStr && rruleStr.includes("FREQ="));
              tmCalendarDebugLog("[tmCalendar] createCalendarEvent: recurrence applied?", rApplied, rruleStr ? `RRULE=${rruleStr}` : "(no RRULE)");
              // Verify persisted copy by re-fetching from calendar
              try {
                const verify = created?.id ? await cal.getItem(created.id) : null;
                let persisted = "";
                try { persisted = rruleOfItem(verify); } catch (_) {}
                if (persisted) tmCalendarDebugLog("[tmCalendar] createCalendarEvent: persisted RRULE=", persisted);
                try { const transp = String(verify?.getProperty?.("TRANSP") || ""); tmCalendarDebugLog("[tmCalendar] createCalendarEvent: persisted TRANSP=", transp || "(empty)"); } catch (_) {}
              } catch (ve) { console.warn("[tmCalendar] createCalendarEvent: verify fetch failed:", ve); }
            } catch (_) {}
            
            let invitationResult = null;
            if (details.send_invitations && (details.attendees?.length > 0)) {
              const policy = getInvitePolicy(cal);
              tmCalendarDebugLog(`[tmCalendar] createCalendarEvent: invite policy=${policy}`);
              if (policy === "mail") {
                tmCalendarDebugLog("[tmCalendar] createCalendarEvent: iMIP invitations not implemented yet");
                invitationResult = { ok: false, error: "Email invitations via Thunderbird are not implemented yet. Please contact the developer or wait for future releases. For now, you can create events without sending invitations." };
                // OLD CODE that was WIP -- does not work yet and fails to find iMIP transport
                // invitationResult = await sendCalendarInvitations(created || ev, cal, "REQUEST", details.organizer_email);
              } else {
                tmCalendarDebugLog("[tmCalendar] createCalendarEvent: relying on provider/server notifications; no iMIP sent");
                invitationResult = { ok: true, message: "provider/server notifications assumed" };
              }
            }
            
            return { 
              ok: true, 
              calendar_id: cal?.id || null,
              event_id: created?.id || null, 
              title: created?.title || null,
              invitations: invitationResult,
              ...guestNoticeOf(cal, [organizerResult])
            };
          } catch (e) {
            console.error("[tmCalendar] createCalendarEvent failed:", e);
            return { ok: false, error: String(e) };
          }
        },
        async modifyCalendarEvent(details) {
          try {
            const Ci = globalThis.Ci;
            const mgr = getCalendarManager();
            if (!mgr) return { ok: false, error: "calendar manager unavailable" };

            const eventId = String(details.event_id || "");            // master UID
            const recurIdStr = String(details.recurrence_id || "");    // optional occurrence recurrenceId
            const calendar_id = String(details.calendar_id || "");       // optional calendar ID for faster lookup
            if (!eventId) return { ok: false, error: "event_id is required" };

            // edit_scope routing (calendar_event_edit-v1.5.21+):
            //   - "all"               → series edit (default when no recurrence_id)
            //   - "this_only"         → single-occurrence override (existing recurrence_id path below)
            //   - "this_and_following" → delegate to splitRecurringEvent so the master is
            //                            capped and a new series is created in one bridge call.
            // We resolve the scope here so the callers don't need a separate JS routing layer.
            const rawScope = typeof details.edit_scope === "string" ? details.edit_scope.toLowerCase() : null;
            const editScope = rawScope || (recurIdStr ? "this_only" : "all");
            // An edit of one occurrence, or of it and the following ones, names
            // that occurrence.
            if ((editScope === "this_only" || editScope === "this_and_following") && !recurIdStr) {
              return { ok: false, error: `edit_scope='${editScope}' requires recurrence_id (the start_iso of the target occurrence — use calendar_event_read or calendar_read to find it). Retry the call including recurrence_id.` };
            }
            if (editScope === "this_and_following") {
              // Re-pack the LLM-style top-level patch fields into the shape splitRecurringEvent expects.
              const splitPatch = {};
              for (const k of ["title", "location", "description", "transparency",
                               "add_attendees", "remove_attendees", "send_invitations", "recurrence",
                               "start_iso", "end_iso", "all_day", "exdates_add"]) {
                if (details[k] !== undefined) splitPatch[k] = details[k];
              }
              return await tmCalApi.splitRecurringEvent({
                event_id: eventId,
                calendar_id: calendar_id || undefined,
                recurrence_id: recurIdStr,
                timezone: details.timezone,
                patch: splitPatch,
                check_only: details.check_only,
              });
            }
            // Only a "this_only" edit targets one occurrence. "all" edits the
            // series and ignores recurrence_id, so the lookup below reads it
            // only for "this_only".
            const occurrenceIdStr = editScope === "this_only" ? recurIdStr : "";

            const patch = details.patch || details; // Allow patch to be in details directly

            // Honor an explicit timezone on the modify call so naive ISO
            // patches land in the requested zone, mirroring createCalendarEvent.
            // recurrence_id is not: it is the occurrence's start_iso as the read
            // tools print it, in the user's zone (occurrenceNamedBy).
            const editTzOverride = typeof patch.timezone === "string" && patch.timezone
              ? patch.timezone
              : (typeof details.timezone === "string" && details.timezone ? details.timezone : null);

            // Resolve the exact item: the event, or for a "this_only" edit the
            // occurrence of its series that recurrence_id names (occurrenceNamedBy),
            // which refuses a time that is not an occurrence. The first calendar
            // that holds the event decides: a refusal there is the answer, and
            // no other calendar's copy of the id is edited instead.
            const all = Array.from(mgr.getCalendars({}));
            let item = null, cal = null, lookupError = null, parentFound = false;
            const targetIn = (parent) => {
              parentFound = true;
              if (!occurrenceIdStr) return parent;
              const named = occurrenceNamedBy(parent, occurrenceIdStr);
              if (named.error) { lookupError = named.error; return null; }
              return named.occurrence;
            };

            // If calendar_id is provided, search that calendar first
            if (calendar_id) {
              const targetCal = all.find(c => String(c.id) === String(calendar_id));
              if (targetCal) {
                try {
                  const parent = await targetCal.getItem(eventId);
                  if (parent) {
                    item = targetIn(parent);
                    if (item) {
                      cal = targetCal;
                      tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: found ${occurrenceIdStr ? `occurrence for recurrenceId: ${occurrenceIdStr}` : `item: ${eventId}`} in calendar: ${calendar_id}`);
                    }
                  }
                } catch (e) {
                  console.warn(`[tmCalendar] modifyCalendarEvent: error finding item in calendar ${calendar_id}:`, e);
                }
              }
            }

            // If not found in specific calendar (or no calendar_id provided), search all calendars
            if (!parentFound) {
              for (const c of all) {
                try {
                  const parent = await c.getItem(eventId);
                  if (!parent) continue;
                  item = targetIn(parent);
                  if (item) {
                    cal = c;
                    tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: found ${occurrenceIdStr ? `occurrence for recurrenceId: ${occurrenceIdStr}` : `item: ${eventId}`} in calendar: ${c.id}`);
                  }
                  break;
                } catch (e) {
                  console.warn(`[tmCalendar] modifyCalendarEvent: error finding item in calendar ${c.id}:`, e);
                }
              }
            }

            if (!item) return { ok: false, error: lookupError || EDIT_EVENT_NOT_FOUND_ERROR };

            // The occurrences exdates_add names, in the series as it is before
            // the edit; a value that names none is refused before anything is written.
            const exdates = Array.isArray(details.exdates_add) ? exdatesNamedBy(item.parentItem || item, details.exdates_add) : { rids: [] };
            if (exdates.error) return { ok: false, error: exdates.error };

            // Use proper target selection for editing
            const { base, scope, isOccurrence, hasSeries } = pickEditTarget(item, details);
            // A whole-series time change is made from the series' first
            // occurrence (#287); one named from a later occurrence is a change of
            // it and the following ones (the edit tool routes it there first).
            const movesSeries = scope === "series" && !!base.recurrenceInfo && !!(patch.start_iso || patch.end_iso)
              && !(patch.recurrence && typeof patch.recurrence === "object" && !patch.recurrence.freq);
            // With no recurrence_id the edit names the first occurrence the
            // read tools show for the series (firstOccurrenceOf, #404).
            let namedRid = null;
            if (movesSeries && recurIdStr) {
              const named = occurrenceNamedBy(base, recurIdStr);
              if (named.error) return { ok: false, error: named.error };
              if (!isFirstOccurrence(base, named.occurrence.recurrenceId)) {
                return { ok: false, error: `recurrence_id ${recurIdStr} is a later occurrence: a time change from it on is edit_scope 'this_and_following' with that recurrence_id; a change of every occurrence names the first one` };
              }
              namedRid = named.occurrence.recurrenceId;
            } else if (movesSeries) {
              namedRid = firstOccurrenceOf(base)?.recurrenceId || null;
            }
            const clone = base.clone();
            tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: editing target - scope: ${scope}, isOccurrence: ${isOccurrence}, hasSeries: ${hasSeries}`);

            // An edit of the series writes its all-day dates as plain dates
            // (asAllDayItem).
            if (scope === "series") asAllDayItem(clone);

            // A series' time change: its times read against the occurrence the
            // edit names (resolveEditTimes); a new start resets every changed
            // occurrence and excluded date first, as Google Calendar's "All
            // events" does.
            const resolved = movesSeries ? resolveEditTimes(clone, patch, editTzOverride, namedRid) : null;
            if (resolved?.error) return { ok: false, error: resolved.error };
            const resets = resolved?.start ? resetChangedOccurrences(clone, patch) : false;

            // The dates the edit excludes, after the reset so they stay, and
            // before the time change, which moves them with the series
            // (onStartDateChange), as its other dates.
            if (scope === "series") {
              for (const rid of exdates.rids) addExdateToItem(clone, rid);
              if (exdates.rids.length) tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: EXDATE added to series, count=", exdates.rids.length);
            }

            if (typeof patch.title === "string") clone.title = patch.title;

            let times;
            if (movesSeries) {
              // The series' times (writeSeriesTimes); a new start moves the
              // rule's days with it, an end alone gives every changed
              // occurrence the new length from its own start.
              if (resolved.length !== null) {
                const written = writeSeriesTimes(clone, resolved.start, resolved.length);
                if (written.error) return { ok: false, error: written.error };
                if (resolved.start) {
                  const shifted = shiftSeriesWithStart(clone, base.startDate, patch);
                  if (shifted.error) return { ok: false, error: shifted.error };
                } else {
                  applyNewLength(clone, resolved.length);
                }
              }
              times = resolved.length !== null ? seriesEditTimes(clone, resolved) : undefined;
            } else {
              // An event, one occurrence, a series given no time, or one that
              // stops repeating: a start alone keeps the length, an end alone
              // keeps the start, once a time that only restates the event's is
              // dropped (timesLeft, the same rule as a series'). Mirrored in
              // durationPreservationLogic.js so the math is unit-testable
              // without a full Mozilla cal runtime.
              const kept = { ...patch, ...timesLeft(base, patch, editTzOverride) };
              const durationResult = applyDurationPreservation({
                base,
                clone,
                patch: kept,
                toCalIDateTime: toCalIDateTimeInFrameOf(base, kept),
                editTzOverride,
                log: (m) => tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: " + m),
              });
              // The edit still saves; this is the only trace that the event's length changed.
              if (durationResult.error) {
                console.warn("[tmCalendar] modifyCalendarEvent: duration preservation failed:", durationResult.error);
              }
              const editError = editTimesError(clone, kept, base);
              if (editError) return { ok: false, error: editError };
              times = shownEditTimes(base, clone);
            }

            // The guest change, on every item the edit covers: the event, the
            // one occurrence, or the series and each of its changed occurrences.
            const guestChange = guestChangeOf(patch);
            if (guestChange) {
              if (scope === "series") applyGuestChangeToSeries(clone, guestChange);
              else applyGuestChange(clone, guestChange);
            }
            // Invitations need someone to invite, once the change is applied.
            if (details.send_invitations && clone.getAttendees().length === 0) {
              return { ok: false, error: "send_invitations=true requires at least one attendee" };
            }
            // The organizer, once the guests are known: the calendar's own
            // address when the edited item has guests and no organizer (the
            // series for an `all` edit, the occurrence for a this_only one).
            // One occurrence takes its series' organizer when it has none of
            // its own; its series gets the same one below (RFC 6638: one
            // ORGANIZER for every component of the resource).
            const seriesOfOccurrence = scope !== "series" ? base.parentItem : null;
            if (seriesOfOccurrence?.organizer && !clone.organizer) clone.organizer = seriesOfOccurrence.organizer.clone();
            const organizerResult = setOwnOrganizerIfGuests(clone, base.calendar);
            if (typeof patch.location === "string") try { clone.setProperty("LOCATION", patch.location); } catch {}
            
            // Transparency (availability): apply only if provided
            if (typeof patch.transparency === "string") {
              try {
                const requested = String(patch.transparency).toLowerCase();
                const transVal = requested === "free" ? "TRANSPARENT" : "OPAQUE";
                const before = String(clone.getProperty?.("TRANSP") || "");
                clone.setProperty("TRANSP", transVal);
                tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: TRANSP set from", before || "(none)", "to", transVal);
              } catch (e) {
                console.warn("[tmCalendar] modifyCalendarEvent: failed to set TRANSP:", e);
              }
            }
            
            // Helper to strip HTML to plain text
            function stripHtmlToText(html) {
              try {
                // Simple fallback; good enough for calendar notes
                return String(html).replace(/<[^>]*>/g, "").replace(/\s+\n/g, "\n").trim();
              } catch { 
                return String(html || ""); 
              }
            }

            // Handle description with HTML alt-description normalization
            if (typeof patch.description === "string" || patch.description_html) {
              // Decide which source is authoritative
              const hasHtml = typeof patch.description_html === "string";
              let textDesc = hasHtml ? stripHtmlToText(patch.description_html) 
                                     : patch.description;

              tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: setting description to: ${textDesc}`);
              
              try { 
                // 1) Set both the typed field and the ICS property
                clone.descriptionText = textDesc;                 // typed field
                clone.setProperty("DESCRIPTION", textDesc);       // ICS property
                
                // 2) Handle HTML alt description properly
                if (hasHtml) {
                  // Write the HTML alt description so TB will show your new body
                  clone.setProperty("X-ALT-DESC", String(patch.description_html));
                  // Some old items carry this flag; keep it aligned with HTML presence
                  clone.setProperty("X-MOZ-HTML", "true");
                  tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: set HTML alt description (length: ${patch.description_html.length})`);
                } else {
                  // No HTML given → make sure old HTML doesn't override your new TEXT
                  if (typeof clone.deleteProperty === "function") {
                    clone.deleteProperty("X-ALT-DESC");
                    clone.deleteProperty("X-MOZ-HTML");
                    // Seen in the wild with some add-ons:
                    clone.deleteProperty("X-MOZ-ALT-DESC");
                    tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: cleared HTML alt description properties`);
                  }
                }
                
                // Log what will actually be saved
                tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: will save DESCRIPTION length = ${String(clone.getProperty?.("DESCRIPTION")||"").length}, X-ALT-DESC present = ${!!clone.getProperty?.("X-ALT-DESC")}`);
                
                // Verify the description was set on the clone
                const verifyDesc = String(clone.getProperty?.("DESCRIPTION") || "");
                tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: description verification on clone - length: ${verifyDesc.length}, matches: ${verifyDesc === textDesc}`);
                if (verifyDesc !== textDesc) {
                  console.warn(`[tmCalendar] modifyCalendarEvent: description mismatch! Set: "${textDesc.slice(0,50)}..." Got: "${verifyDesc.slice(0,50)}..."`);
                }
              } catch (e) {
                console.warn("[tmCalendar] modifyCalendarEvent: failed to set description:", e);
              }
            }

            // Recurrence update
            if (Object.prototype.hasOwnProperty.call(patch, "recurrence")) {
              const recRes = applyRecurrenceToItem(clone, patch.recurrence);
              try { if (recRes.value) tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: RRULE=", recRes.value); } catch (_) {}
            }

            // The series' changed occurrences take the fields the edit names.
            if (scope === "series") applyEditToChangedOccurrences(clone, patch);

            // A check before the confirmation card stops here, at the first
            // write: every refusal is above, and everything above changed only
            // the unsaved clone. It says whether the edit changes anything
            // (each term is the guard of the write it stands for, after the
            // drops above; an omitted field arrives as null. A change of kind
            // is in `times`: it comes with both times or is refused above,
            // kindChangeTimesError), the times the card shows, and whether a
            // new start resets changed occurrences.
            const changes = !!times || typeof patch.title === "string" || typeof patch.location === "string"
              || typeof patch.transparency === "string" || typeof patch.description === "string" || !!patch.description_html
              || !!guestChange || exdates.rids.length > 0 || (!!patch.recurrence && typeof patch.recurrence === "object")
              || details.send_invitations === true;
            if (details.check_only) return { ok: true, changes, times, resetsChangedOccurrences: resets };

            // EXDATE additions on an edit of one occurrence go to its series.
            if (exdates.rids.length && scope !== "series") {
              const parent = item.parentItem || item;
              const parentOld = parent.clone();
              let added = 0;
              for (const rid of exdates.rids) {
                try { addExdateToItem(parent, rid); added += 1; } catch (xe) { console.warn("[tmCalendar] modifyCalendarEvent: failed to add EXDATE:", xe); }
              }
              tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: EXDATE added to parent, count=", added);
              await parent.calendar.modifyItem(parent, parentOld);
            }

            // The organizer was set above (setOwnOrganizerIfGuests), only when
            // the item has guests and none; an existing one is never changed.

            // Log complete state before save
            tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: attempting calendar modification...");
            tmCalendarDebugLog("BEFORE save:",
              "descriptionText.len=", (clone.descriptionText || "").length,
              "DESCRIPTION.len=", (clone.getProperty?.("DESCRIPTION")||"").length,
              "ALT.len=",  (clone.getProperty?.("X-ALT-DESC")||"").length,
              "X-MOZ-HTML=", clone.getProperty?.("X-MOZ-HTML") || "");
            
            // Always modify using the same calendar as BASE
            // The series of an edited occurrence carries the occurrence's
            // organizer too, as does each of its changed occurrences, where
            // they have none (never changing one they have): then the series
            // is written once, with the occurrence as its changed occurrence,
            // so every component of the resource names the same organizer.
            const seriesWithOrganizer = (() => {
              if (!seriesOfOccurrence || !clone.organizer) return null;
              const copy = seriesOfOccurrence.clone();
              return giveSeriesOrganizer(copy, clone.organizer) ? copy : null;
            })();
            let modified;
            if (seriesWithOrganizer) {
              seriesWithOrganizer.recurrenceInfo.modifyException(clone, false);
              modified = await base.calendar.modifyItem(seriesWithOrganizer, seriesOfOccurrence);
            } else {
              modified = await base.calendar.modifyItem(clone, base);
            }
            tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: modifyItem completed");
            tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: modified event with id:", modified?.id);
            
            // Verify description was persisted after modifyItem - re-fetch fresh copy
            try {
              const fresh = await base.calendar.getItem(modified.id);
              tmCalendarDebugLog("AFTER save (fresh):",
                "descriptionText.len=", (fresh?.descriptionText || "").length,
                "DESCRIPTION.len=",    (fresh?.getProperty?.("DESCRIPTION") || "").length,
                "match=", (String(fresh?.descriptionText || "") === String(fresh?.getProperty?.("DESCRIPTION") || "")),
                "ALT.len=",  (fresh?.getProperty?.("X-ALT-DESC")||"").length,
                "X-MOZ-HTML=", fresh?.getProperty?.("X-MOZ-HTML") || "");
              try { const transp = String(fresh?.getProperty?.("TRANSP") || ""); tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: persisted TRANSP=", transp || "(empty)"); } catch (_) {}
              
              const savedDescText = String(fresh?.descriptionText || "");
              const savedDescProp = String(fresh?.getProperty?.("DESCRIPTION") || "");
              const savedAltDesc = String(fresh?.getProperty?.("X-ALT-DESC") || "");
              
              if (typeof patch.description === "string") {
                const textMatches = savedDescText === patch.description;
                const propMatches = savedDescProp === patch.description;
                tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: descriptionText matches: ${textMatches}, DESCRIPTION matches: ${propMatches}`);
                if (!textMatches && !propMatches) {
                  console.warn(`[tmCalendar] modifyCalendarEvent: BOTH DESCRIPTION FIELDS MISMATCH! Expected: "${patch.description.slice(0,50)}..." Got descriptionText: "${savedDescText.slice(0,50)}..." Got DESCRIPTION: "${savedDescProp.slice(0,50)}..."`);
                }
                if (savedAltDesc.length > 0) {
                  console.warn(`[tmCalendar] modifyCalendarEvent: X-ALT-DESC still present after text-only update - this may override the UI display!`);
                }
              }
            } catch (e) {
              console.warn("[tmCalendar] modifyCalendarEvent: failed to verify saved description:", e);
            }
            try {
              let rruleStr = "";
              try { rruleStr = rruleOfItem(modified) || rruleOfItem(clone); } catch (_) {}
              const rApplied = !!(rruleStr && rruleStr.includes("FREQ="));
              tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: recurrence applied?", rApplied, rruleStr ? `RRULE=${rruleStr}` : "(no RRULE)");
              // Verify persisted copy by re-fetching from calendar
              try {
                const verify = modified?.id ? await cal.getItem(modified.id) : null;
                let persisted = "";
                try { persisted = rruleOfItem(verify); } catch (_) {}
                if (persisted) tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: persisted RRULE=", persisted);
                const exd = verify ? extractExdatesFromItem(verify) : "";
                if (exd) tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: persisted EXDATE=", exd);
              } catch (ve) { console.warn("[tmCalendar] modifyCalendarEvent: verify fetch failed:", ve); }
            } catch (_) {}
            
            let invitationResult = null;
            if (details.send_invitations && modified) {
              const attendees = modified.getAttendees ? modified.getAttendees() : [];
              if (attendees.length > 0) {
                const policy = getInvitePolicy(cal);
                tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: invite policy=${policy}`);
                if (policy === "mail") {
                  tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: iMIP invitations not implemented yet");
                  invitationResult = { ok: false, error: "Email invitations via Thunderbird are not implemented yet. Please contact the developer or wait for future releases. For now, you can modify events without sending invitations." };
                  // OLD CODE that was WIP -- does not work yet and fails to find iMIP transport
                  // invitationResult = await sendCalendarInvitations(created || ev, cal, "REQUEST", details.organizer_email);
                } else {
                  tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: relying on provider/server notifications; no iMIP sent");
                  invitationResult = { ok: true, message: "provider/server notifications assumed" };
                }
              }
            }
            
            // Return the item's own event_id. An occurrence edit resolves with
            // the PARENT series (CalMemoryCalendar.modifyItem), so the title is
            // the occurrence's as written (the clone), not the series'. Its
            // recurrence_id is its start as written, as the read tools print it
            // in their recurrence_id (and occurrenceNamedBy takes it back), so
            // a moved occurrence is named by its new start.
            const returnedId = String((modified?.id) || (base?.id) || "");
            return { 
              ok: true, 
              calendar_id: cal?.id || null,
              event_id: returnedId, 
              recurrence_id: isOccurrence ? shownNaiveIso(clone.startDate) : null,
              title: (isOccurrence ? clone.title : modified?.title) || null,
              invitations: invitationResult,
              ...guestNoticeOf(base.calendar, [organizerResult])
            };
          } catch (e) {
            console.error("[tmCalendar] modifyCalendarEvent failed:", e);
            return { ok: false, error: String(e) };
          }
        },

        // splitRecurringEvent — atomic-ish "this and following events" split for a
        // recurring series (#265). The original (master) series becomes the
        // earlier part: each rule is capped just before recurrence_id (no
        // invitation fired to attendees about that), and it keeps its excluded
        // dates, added dates and changed occurrences from before the split. A
        // NEW series, the following part, starts at recurrence_id with the rest:
        // each rule that carries on (UNTIL kept, COUNT reduced to the occurrences
        // still to come) and the dates and changed occurrences from the split on,
        // with the caller's `patch` applied on top. Together the two parts make
        // the same occurrences as the series did. Invitations (if
        // send_invitations=true) fire exactly once, on the new series.
        //
        // Both parts are built before anything is written, and a split that
        // cannot keep the series is refused then. If the new-series creation
        // fails after the master cap succeeded, we attempt to revert the cap
        // (best-effort).
        //
        // details = {
        //   event_id, calendar_id?, recurrence_id (required: the start, as the
        //   read tools show it, of the occurrence that becomes the NEW series'
        //   first; for a changed occurrence that is its own start, not its
        //   RECURRENCE-ID), patch (object with fields to apply to the new
        //   series: title, location, description, transparency, add_attendees,
        //   remove_attendees, send_invitations, recurrence, start_iso, end_iso, all_day,
        //   exdates_add), timezone? (for start_iso and end_iso)
        // The new series keeps the series' organizer: an edit names none (the
        // edit tool fills organizer_email with the calendar's own address, and
        // an edit of the whole series never sets one either).
        // }
        async splitRecurringEvent(details) {
          try {
            const Ci = globalThis.Ci; const Cc = globalThis.Cc;
            const mgr = getCalendarManager();
            if (!mgr) return { ok: false, error: "calendar manager unavailable" };

            const eventId = String(details.event_id || "");
            const calendarIdHint = String(details.calendar_id || "");
            const splitIso = String(details.recurrence_id || "");
            const patch = (details && details.patch && typeof details.patch === "object") ? details.patch : {};
            const sendInvites = !!patch.send_invitations;
            const tzOverride = typeof details.timezone === "string" && details.timezone ? details.timezone : null;

            if (!eventId) return { ok: false, error: "event_id is required" };
            if (!splitIso) return { ok: false, error: "recurrence_id is required for splitRecurringEvent" };

            // 1. Locate the master event (series parent) — scan all calendars if no hint.
            const allCals = Array.from(mgr.getCalendars({}));
            let master = null, cal = null;
            const visit = async (c) => {
              try {
                const item = await c.getItem(eventId);
                if (item) {
                  master = item.parentItem || item;
                  cal = c;
                  return true;
                }
              } catch (e) {
                console.warn(`[tmCalendar] splitRecurringEvent: getItem failed on ${c.id}:`, e);
              }
              return false;
            };
            if (calendarIdHint) {
              const targetCal = allCals.find(c => String(c.id) === calendarIdHint);
              if (targetCal) await visit(targetCal);
            }
            if (!master) {
              for (const c of allCals) {
                if (await visit(c)) break;
              }
            }
            if (!master || !cal) return { ok: false, error: EDIT_EVENT_NOT_FOUND_ERROR };

            // 2. The series must be recurring for a split to make sense.
            if (!master.recurrenceInfo) {
              return { ok: false, error: "event is not recurring — use modifyCalendarEvent for one-off events" };
            }

            // 3. The split point: the occurrence recurrence_id names
            // (occurrenceNamedBy, which refuses a time that is not one).
            const named = occurrenceNamedBy(master, splitIso);
            if (named.error) return { ok: false, error: named.error };
            const splitRid = named.occurrence.recurrenceId;
            if (isFirstOccurrence(master, splitRid)) {
              return { ok: false, error: "recurrence_id is the series' first occurrence: to change every occurrence, edit the whole series (edit_scope 'all')" };
            }
            // The occurrences exdates_add names, in the series as it is before
            // the split; each goes to the part its RECURRENCE-ID falls in.
            const exdates = Array.isArray(patch.exdates_add) ? exdatesNamedBy(master, patch.exdates_add) : { rids: [] };
            if (exdates.error) return { ok: false, error: exdates.error };

            // 4-6. The earlier part: the series before the split, every rule
            // capped there (earlierPartBefore, which a delete of this and the
            // following occurrences writes too). The series divides at the
            // occurrence's RECURRENCE-ID read in its own zone (`splitDt`), so the
            // following part keeps the series' zone, in which its rule expands.
            // Nothing is written yet.
            // Note: we don't send any "series-ended" notification here — only the
            // new series triggers an invitation (controlled by patch.send_invitations).
            const earlier = earlierPartBefore(master, splitRid);
            if (earlier.error) return { ok: false, error: earlier.error };
            const { part: cappedClone, splitDt, untilValue, plans, fromSplitOn } = earlier;
            const isAllDayMaster = !!master.startDate?.isDate;
            // The following part carries the series' rules on, so it needs one.
            if (!plans.some(Boolean)) {
              return { ok: false, error: "master event has no parseable RRULE (its recurrenceInfo holds no FREQ=… rule)" };
            }
            // A rule carried on must make an occurrence at the split to keep its
            // dates. A new rule for the following part replaces every rule it
            // would carry on, so then their alignment does not matter; the split
            // point is an occurrence of the series either way (step 3).
            const newRule = !!(patch.recurrence && typeof patch.recurrence === "object");
            const masterItems = [...(master.recurrenceInfo.getRecurrenceItems({}) || [])];
            for (const [i, plan] of plans.entries()) {
              if (!newRule && plan?.following && !plan.aligned) {
                return { ok: false, error: `recurrence_id ${splitIso} is not an occurrence of this series' rule ${String(masterItems[i].icalProperty.value)}, so the part from there on cannot keep its dates; split at an occurrence every rule makes, or give the following part its own recurrence` };
              }
            }
            // The excluded dates the edit names before the split go to the
            // earlier part.
            try {
              for (const rid of exdates.rids) if (!fromSplitOn(rid)) addExdateToItem(cappedClone, rid);
            } catch (re) {
              console.error("[tmCalendar] splitRecurringEvent: aborting — capping the earlier part failed:", re);
              return { ok: false, error: `failed to apply capped RRULE: ${re}` };
            }

            // 7. Build the new series, the following part: a copy of the series,
            // made as Thunderbird copies an event (calendar-clipboard.js: a
            // clone with a new id), so it keeps every property, reminder,
            // attachment and attendee the series has, and its organizer. Its id is
            // cleared for the calendar to give it one when it is added. Its
            // recurrence is replaced (below) by the series' from the split on.
            const newEv = master.clone();
            newEv.id = null;

            // Title
            if (typeof patch.title === "string" && patch.title) newEv.title = patch.title;

            // The part starts at the split, as long as the series' occurrences
            // (Thunderbird's own length of the series, which it adds to each
            // occurrence's start by the clock): the occurrence at the split as
            // the series has it. Refused when that occurrence would end in the
            // first pass of the hour the clocks repeat, which the part's stored
            // end cannot give.
            const partTimes = writeSeriesTimes(newEv, isAllDayMaster ? asAllDayDate(splitDt.clone()) : splitDt, seriesLength(cappedClone));
            if (partTimes.error) return { ok: false, error: partTimes.error };
            const slotStart = newEv.startDate.clone();
            const slotEnd = newEv.endDate.clone();

            // Location ("" removes it)
            if (typeof patch.location === "string") newEv.setProperty("LOCATION", patch.location);

            // Description: a new one replaces the series' in every form, as an
            // edit's does. Thunderbird's own HTML version goes with the text it
            // replaces (descriptionText), and so do the HTML copies other
            // calendars write, which would otherwise still show the old one.
            if (typeof patch.description === "string") {
              newEv.descriptionText = patch.description;
              for (const name of ["X-ALT-DESC", "X-MOZ-HTML", "X-MOZ-ALT-DESC"]) newEv.deleteProperty(name);
            }

            // Transparency (busy/free)
            if (typeof patch.transparency === "string") {
              newEv.setProperty("TRANSP", patch.transparency.toLowerCase() === "free" ? "TRANSPARENT" : "OPAQUE");
            }

            // Recurrence — the master's from the split on: each rule that carries
            // on (splitRule), and the excluded and added dates and changed
            // occurrences from the split on. The clone's changed occurrences take
            // the new series as their parent, and its id when the calendar gives
            // it one (Thunderbird's onIdChange).
            try {
              const followingInfo = master.recurrenceInfo.clone();
              followingInfo.item = newEv;
              [...(followingInfo.getRecurrenceItems({}) || [])].forEach((r, i) => {
                if (plans[i]) {
                  if (!plans[i].following) followingInfo.deleteRecurrenceItem(r);
                  else if (plans[i].following !== String(r.icalProperty.value)) writeRuleItem(r, plans[i].following);
                } else if (!fromSplitOn(r.date)) {
                  followingInfo.deleteRecurrenceItem(r);
                }
              });
              for (const rid of [...(followingInfo.getExceptionIds({}) || [])]) {
                if (!fromSplitOn(rid)) followingInfo.removeExceptionFor(rid);
              }
              newEv.recurrenceInfo = followingInfo;
              // The rules' UNTIL is read in the series' stored zone: the
              // part's start is already a plain date.
              asAllDayItem(newEv, master.startDate);
            } catch (re) {
              console.error("[tmCalendar] splitRecurringEvent: aborting — building the following part's recurrence failed:", re);
              return { ok: false, error: `failed to build the new series' recurrence: ${re}` };
            }

            // The edit's time change, on the following part only, as on a
            // whole series: its times read against the occurrence the split
            // names (resolveEditTimes); a new start resets the part's changed
            // occurrences and excluded dates first (the earlier part keeps
            // its own).
            const resolved = resolveEditTimes(newEv, patch, tzOverride, splitRid);
            if (resolved.error) return { ok: false, error: resolved.error };
            const resets = resolved.start ? resetChangedOccurrences(newEv, patch) : false;
            // The guest change, on the new series and each changed occurrence
            // it carries; the earlier part keeps its guests.
            const guestChange = guestChangeOf(patch);
            if (guestChange) applyGuestChangeToSeries(newEv, guestChange);
            // After the reset so they stay, and before the time change below,
            // which moves them with the part (onStartDateChange).
            for (const rid of exdates.rids) if (fromSplitOn(rid)) addExdateToItem(newEv, rid);
            // The part's times (writeSeriesTimes); a new start moves the rule's
            // days with it, as a whole series' does (#287), an end alone gives
            // every changed occurrence the part carries the new length.
            if (resolved.length !== null) {
              const written = writeSeriesTimes(newEv, resolved.start, resolved.length);
              if (written.error) return { ok: false, error: written.error };
              if (resolved.start) {
                const followingShift = shiftSeriesWithStart(newEv, slotStart, patch);
                if (followingShift.error) return { ok: false, error: followingShift.error };
              } else {
                applyNewLength(newEv, resolved.length);
              }
            }
            const times = resolved.length !== null ? seriesEditTimes(newEv, resolved) : undefined;
            // Invitations need someone to invite, once the change is applied.
            if (sendInvites && newEv.getAttendees().length === 0) {
              return { ok: false, error: "send_invitations=true requires at least one attendee on the new series" };
            }

            // A new rule for the following part (written in its start's value
            // type, after the time change); `{}` stops it repeating.
            if (newRule) {
              const recRes = applyRecurrenceToItem(newEv, patch.recurrence);
              if (recRes.error) return { ok: false, error: `failed to apply the new series' recurrence: ${recRes.error}` };
              // `{}` makes the following part one event built from the series.
              // A changed occurrence at the split would lose its changes.
              if (recRes.cleared && master.recurrenceInfo.getExceptionFor(splitRid)) {
                return { ok: false, error: `the occurrence at ${splitIso} was changed on its own, and ending the series there would lose its changes; change it in the calendar app` };
              }
            }

            // Every changed occurrence carried into the following part takes
            // the fields the edit names, as on a whole-series edit. Before the
            // answers below, so a new place asks its attendees again.
            applyEditToChangedOccurrences(newEv, patch);

            // The attendees answered for the series' times and place. When the
            // split moves the following occurrences (their start or end, all-day
            // or timed, or a rule other than the one carried on) or changes their
            // location, everyone but the organizer is asked again: Thunderbird
            // asks every attendee again when an organizer moves a meeting
            // (CalItipMessageSender, on a major change), and RFC 6638 3.2.8 has
            // a scheduling server reset their answers. The following part is a
            // new event, which a server's reset never reaches. A value the split
            // only restates is no change.
            const carriedRules = plans.filter((p) => p?.following).map((p) => p.following).sort().join("\n");
            const reschedules = !sameTime(newEv.startDate, slotStart)
              || !sameTime(newEv.endDate, slotEnd)
              || (newRule && ruleValuesOfItem(newEv).sort().join("\n") !== carriedRules)
              || (typeof patch.location === "string" && patch.location !== String(master.getProperty("LOCATION") || ""));
            // Both parts name the calendar's own address as organizer when they
            // have guests and none, before the answers below are asked again,
            // so the organizer is never reset to NEEDS-ACTION.
            const organizerResult = setOwnOrganizerIfGuests(newEv, cal);
            const earlierOrganizerResult = setOwnOrganizerIfGuests(cappedClone, cal);
            const organizer = attendeeAddress(newEv.organizer?.id);
            const askAgain = (item) => {
              for (const att of item.getAttendees()) {
                if (organizer && attendeeAddress(att.id) === organizer) continue;
                att.participationStatus = "NEEDS-ACTION";
                att.rsvp = "TRUE";
              }
            };
            if (reschedules) askAgain(newEv);
            // Each changed occurrence of the part carries its own attendees,
            // who answered for its own time and place: they are asked again
            // when the split moves it or changes its place. A new start has
            // reset every changed occurrence, so one left never moved: its
            // stored self is at the same RECURRENCE-ID.
            const partInfo = newEv.recurrenceInfo;
            if (partInfo) {
              for (const rid of [...(partInfo.getExceptionIds({}) || [])]) {
                const ex = partInfo.getExceptionFor(rid);
                const stored = master.recurrenceInfo.getExceptionFor(rid);
                const changed = !stored || !sameTime(ex.startDate, stored.startDate) || !sameTime(ex.endDate, stored.endDate)
                  || String(ex.getProperty("LOCATION") || "") !== String(stored.getProperty("LOCATION") || "");
                if (!changed) continue;
                const asked = ex.clone();
                askAgain(asked);
                partInfo.modifyException(asked, false);
              }
            }

            // A check before the confirmation card stops here, at the first
            // write: every refusal is above, and both parts are still unsaved
            // copies. It says whether the split changes anything (each term
            // is the guard of a write above; a split that changes nothing is
            // not made. A change of kind is in `times`: it comes with both
            // times or is refused above, kindChangeTimesError), the times the
            // card shows, and whether a new start resets the part's changed
            // occurrences.
            const changes = !!times || (typeof patch.title === "string" && !!patch.title) || newRule
              || exdates.rids.length > 0 || !!guestChange || typeof patch.location === "string"
              || typeof patch.description === "string" || typeof patch.transparency === "string"
              || patch.send_invitations === true;
            if (details.check_only) return { ok: true, changes, times, resetsChangedOccurrences: resets };

            // 8. Write the earlier part.
            let cappedMaster;
            try {
              cappedMaster = await cal.modifyItem(cappedClone, master);
              tmCalendarDebugLog(`[tmCalendar] splitRecurringEvent: capped master series ${eventId} with UNTIL=${untilValue}`);
            } catch (e) {
              return { ok: false, error: `failed to cap master series: ${e}` };
            }

            // 9. Persist the new series.
            let created;
            try {
              created = await cal.addItem(newEv);
              tmCalendarDebugLog("[tmCalendar] splitRecurringEvent: created new series with id:", created?.id);
            } catch (e) {
              // Revert master cap — best-effort recovery so we don't leave the calendar
              // in a "series ended, no replacement" state.
              try {
                await cal.modifyItem(master, cappedMaster);
                tmCalendarDebugLog("[tmCalendar] splitRecurringEvent: reverted master cap after new-series creation failure");
              } catch (revertErr) {
                console.error("[tmCalendar] splitRecurringEvent: REVERT FAILED — master is capped but new series was not created:", revertErr);
              }
              return { ok: false, error: `failed to create new series: ${e}` };
            }

            // 10. Invitations — fire exactly once, on the new series only.
            let invitationResult = null;
            if (sendInvites && newEv.getAttendees().length > 0) {
              const policy = getInvitePolicy(cal);
              tmCalendarDebugLog(`[tmCalendar] splitRecurringEvent: invite policy=${policy}`);
              if (policy === "mail") {
                invitationResult = { ok: false, error: "Email invitations via Thunderbird are not implemented yet." };
              } else {
                invitationResult = { ok: true, message: "provider/server notifications assumed (new series only)" };
              }
            }

            return {
              ok: true,
              calendar_id: cal?.id || null,
              event_id: created?.id || null,
              // The new part's first occurrence as Thunderbird expands it (a
              // changed occurrence at its own time, an excluded one skipped),
              // its start as the read tools print it in recurrence_id: the
              // occurrence event_id now names. Not DTSTART, which may be moved
              // or excluded, nor the recurrence_id the edit named (of the old
              // series).
              recurrence_id: (() => {
                const first = firstOccurrenceOf(created);
                return first ? shownNaiveIso(first.startDate) : null;
              })(),
              old_event_id: eventId,
              title: created?.title || null,
              invitations: invitationResult,
              ...guestNoticeOf(cal, [organizerResult, earlierOrganizerResult]),
              split_at: splitIso,
            };
          } catch (e) {
            console.error("[tmCalendar] splitRecurringEvent failed:", e);
            return { ok: false, error: String(e) };
          }
        },
    };
    return { tmCalendar: tmCalApi };
  }
};

this.tmCalendar = tmCalendar;



