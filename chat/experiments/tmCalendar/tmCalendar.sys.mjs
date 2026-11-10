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
// Apply start/end updates to `clone` with duration preservation: when only one
// side of start/end was patched, derive the missing side from the event's
// existing duration so the length stays the same. Mirrors iOS
// GoogleCalendarProvider.mergeExistingEventWithPatch — without this, "move it
// to 3pm" (start_iso only) leaves the old end untouched and silently changes
// the event's length, or produces a negative duration if start moves past end.
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
    if (s) {
      if (patch.all_day) s.isDate = true;
      clone.startDate = s;
    }
  }
  if (hasEndPatch) {
    const e = toCalIDateTime(String(patch.end_iso), editTzOverride);
    if (e) {
      if (patch.all_day) e.isDate = true;
      clone.endDate = e;
    }
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
  if (hasEndPatch && !hasStartPatch && origDuration) {
    try {
      const negDur = origDuration.clone();
      negDur.isNegative = !negDur.isNegative;
      const newStart = clone.endDate.clone();
      newStart.addDuration(negDur);
      clone.startDate = newStart;
      log("derived startDate from new end + existing duration");
      return { derived: "start" };
    } catch (e) {
      log("failed to derive startDate from duration: " + e);
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
// changed copy moved to another day would still show there.
function addExdateToItem(item, rid) {
  const at = rid.isDate ? rid.clone() : rid.getInTimezone(item.startDate.timezone);
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

// The edit fields that change an occurrence itself (its times or details), as
// opposed to the series' rule or dates. A changed occurrence keeps its own copy
// of each, so a split at one cannot apply them to it (splitRecurringEvent).
// all_day alone changes nothing; a change to or from all-day comes with times.
// organizer_email is not one: the edit tool fills it in from the calendar for
// every edit that names one, so it is no change of the occurrence's.
const SPLIT_FIELDS_OF_AN_OCCURRENCE = ["title", "location", "description", "transparency", "attendees",
  "start_iso", "end_iso"];

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
// epoch time depends on the zone it carries (an all-day event TabMail creates is
// a DATE in the user's zone), so all-day day arithmetic never uses it.
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

// Sets or clears an item's rule (`setRuleOnItem`). `{}` removes the recurrence.
function applyRecurrenceToItem(item, recurrenceDetails) {
  try {
    if (!recurrenceDetails || typeof recurrenceDetails !== "object") return { applied: false, cleared: false };
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
 *   zone instead of the user's TB-default zone. Unknown ids fall back to
 *   defaultTimezone with a warn.
 * @returns {calIDateTime|null} - Thunderbird calendar datetime object or null if invalid
 */
function toCalIDateTime(iso, tzId) {
  try {
    const Ci = globalThis.Ci;
    const Cc = globalThis.Cc;
    const tzService = getTimezoneService();
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

    // Resolve the override timezone if the caller passed one. Mozilla's
    // calITimezoneService.getTimezone returns null/UTC for unknown ids on
    // some builds — guard via tzid round-trip.
    let overrideTimezone = null;
    if (typeof tzId === "string" && tzId) {
      try {
        const candidate = tzService.getTimezone(tzId);
        if (candidate && candidate.tzid && candidate.tzid !== "floating") {
          overrideTimezone = candidate;
        } else {
          console.warn(`[tmCalendar] toCalIDateTime: unknown tzId '${tzId}', falling back to defaultTimezone`);
        }
      } catch (e) {
        console.warn(`[tmCalendar] toCalIDateTime: getTimezone('${tzId}') threw, falling back: ${e}`);
      }
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

// An attendee's address without "mailto:", in lower case: Thunderbird matches
// attendees by address without regard to case (getAttendeeById).
function attendeeAddress(id) {
  return String(id || "").replace(/^mailto:/i, "").trim().toLowerCase();
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

// Naive ISO shape the tools expect for an all-day date. `toNaiveIso` in the
// tool layer re-parses a bare "YYYY-MM-DD" as UTC midnight (JS Date semantics)
// and would shift it a day west of UTC; the "T00:00:00" suffix parses as a
// local wall clock and round-trips unchanged through `toCalIDateTime`.
function allDayNaiveIso(dayStr) {
  return dayStr ? `${dayStr}T00:00:00` : "";
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

// toCalIDateTime for an edit of `item`, whose new times it gives in the item's
// frame, as Thunderbird's event dialog keeps an event's zone: in a zoned item's
// own zone at the same instant, and for a floating item at the user's clock
// digits, kept floating (the inverse of asShown). A new start read in the
// user's zone would otherwise move the item into it: its rule would expand
// there (a weekday in the series' zone can be another in the user's), and its
// excluded and added dates and changed occurrences, which Thunderbird moves
// with the start (onStartDateChange), would no longer meet its occurrences.
// An all-day value, and an edit to or from all day, are given as read.
function toCalIDateTimeInFrameOf(item, patch) {
  const start = item && item.startDate;
  return (iso, tzId) => {
    const dt = toCalIDateTime(iso, tzId);
    if (!dt || dt.isDate || patch.all_day || !start || start.isDate) return dt;
    const zone = start.timezone;
    if (zone?.tzid !== "floating") return dt.getInTimezone(zone);
    const shown = dt.getInTimezone(getTimezoneService().defaultTimezone);
    const kept = shown.clone();
    kept.resetTo(shown.year, shown.month, shown.day, shown.hour, shown.minute, shown.second, zone);
    return kept;
  };
}

// Whether two event times are the same: two DATEs on the same day, or two
// date-times at the same instant, a floating time only with another floating
// one. A time relabelled into another zone at the same instant is the same.
function sameTime(a, b) {
  if (!a || !b || !!a.isDate !== !!b.isDate) return false;
  if (a.isDate) return a.compare(b) === 0;
  return (a.timezone?.tzid === "floating") === (b.timezone?.tzid === "floating") && a.nativeTime === b.nativeTime;
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
        async getCalendarEventDetails(event_id, calendar_id = null) {
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
            const details = {
              id: eid,
              title: targetEvent.title || "",
              start: (() => { try { return targetEvent.startDate ? asShown(targetEvent.startDate).nativeTime / 1000 : null; } catch { return null; } })(),
              end: (() => { try { return targetEvent.endDate ? asShown(targetEvent.endDate).nativeTime / 1000 : null; } catch { return null; } })(),
              isAllDay: !!(targetEvent.startDate && targetEvent.startDate.isDate),
              startDay: targetEvent.startDate?.isDate ? toDayString(targetEvent.startDate) : "",
              endDay: targetEvent.endDate?.isDate ? toDayString(targetEvent.endDate) : "",
              location: targetEvent.getProperty ? String(targetEvent.getProperty("LOCATION") || "") : "",
              organizer: (() => { try { return String(targetEvent.organizer ? (targetEvent.organizer.commonName || targetEvent.organizer.id || "") : ""); } catch { return ""; } })(),
              attendees: attendeesCount,
              attendeeList: attendeeList,
              calendarId: String(targetCalendar?.id || ""),
              calendarName: String(targetCalendar?.name || targetCalendar?.id || ""),
              isRecurring: !!targetEvent.recurrenceInfo,
              // The rule in the create/edit tools' own fields (see
              // recurrenceFieldsOfItem); null when the event does not repeat.
              recurrence: recurrenceFieldsOfItem(targetEvent.parentItem || targetEvent),
              transparency: (() => {
                try {
                  const raw = String(targetEvent.getProperty?.("TRANSP") || "");
                  const mapped = raw.toUpperCase() === "TRANSPARENT" ? "free" : "busy";
                  tmCalendarDebugLog("[tmCalendar] getCalendarEventDetails: TRANSP=", raw || "(empty)", "mapped=", mapped);
                  return mapped;
                } catch (_) { return "busy"; }
              })()
            };
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
            const Ci = globalThis.Ci; const Cc = globalThis.Cc;
            const mgr = getCalendarManager();
            if (!mgr) {
              console.error("[tmCalendar] deleteCalendarEvent: calendar manager unavailable");
              return { ok: false, error: "calendar manager unavailable" };
            }
            const d = details || {};
            const eventId = String(d.event_id || "");
            const calendar_id = String(d.calendar_id || "");  // optional calendar ID for faster lookup
            const confirm = !!d.confirm;
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

            // Delete the event
            try {
              if (!confirm) {
                // Show confirmation dialog
                const wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
                const w = wm.getMostRecentWindow("mail:3pane");
                if (w && w.confirm) {
                  const eventTitle = targetEvent.title || "this event";
                  const confirmMsg = `Are you sure you want to delete "${eventTitle}"?`;
                  if (!w.confirm(confirmMsg)) {
                    return { ok: false, error: "user cancelled deletion" };
                  }
                }
              }
              
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
              
              tmCalendarDebugLog("[tmCalendar] deleteCalendarEvent: deleting event:", eventId);
              await targetCalendar.deleteItem(targetEvent);
              tmCalendarDebugLog("[tmCalendar] deleteCalendarEvent: event deleted successfully");
              // Return the item's own id
              const returnedId = String(targetEvent.id || "");
              return { 
                ok: true,
                id: returnedId,
                invitations: invitationResult
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
            if (start) { if (details.all_day) start.isDate = true; ev.startDate = start; }
            if (end) { if (details.all_day) end.isDate = true; ev.endDate = end; }
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

            // Set organizer BEFORE adding to calendar (to avoid immutability issues)
            if (details.send_invitations && details.organizer_email) {
              try {
                const org = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
                org.id = details.organizer_email.startsWith("mailto:") ? details.organizer_email : `mailto:${details.organizer_email}`;
                org.commonName = details.organizer_email;
                org.isOrganizer = true;
                ev.organizer = org;
              } catch (e) {
                console.warn("[tmCalendar] createCalendarEvent: failed to set organizer:", e);
              }
            }

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
              invitations: invitationResult
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
            if (editScope === "this_and_following") {
              if (!recurIdStr) {
                return { ok: false, error: "edit_scope='this_and_following' requires recurrence_id" };
              }
              // Re-pack the LLM-style top-level patch fields into the shape splitRecurringEvent expects.
              const splitPatch = {};
              for (const k of ["title", "location", "description", "transparency", "attendees",
                               "send_invitations", "organizer_email", "recurrence",
                               "start_iso", "end_iso", "all_day", "exdates_add"]) {
                if (details[k] !== undefined) splitPatch[k] = details[k];
              }
              return await tmCalApi.splitRecurringEvent({
                event_id: eventId,
                calendar_id: calendar_id || undefined,
                recurrence_id: recurIdStr,
                timezone: details.timezone,
                patch: splitPatch,
              });
            }
            if (editScope === "this_only" && !recurIdStr) {
              return { ok: false, error: "edit_scope='this_only' requires recurrence_id" };
            }

            // Validate attendees when invitations are requested
            const sendInvites = !!details.send_invitations;
            const attendees = Array.isArray(details.attendees) ? details.attendees : [];
            if (sendInvites && attendees.length === 0) {
              return { ok: false, error: "send_invitations=true requires at least one attendee" };
            }

            const patch = details.patch || details; // Allow patch to be in details directly

            // Honor an explicit timezone on the modify call so naive ISO
            // patches land in the requested zone, mirroring createCalendarEvent.
            // recurrence_id is not: it is the occurrence's start_iso as the read
            // tools print it, in the user's zone (occurrenceNamedBy).
            const editTzOverride = typeof patch.timezone === "string" && patch.timezone
              ? patch.timezone
              : (typeof details.timezone === "string" && details.timezone ? details.timezone : null);

            // Resolve the exact item: the event, or with a recurrence_id the
            // occurrence of its series that starts there (occurrenceNamedBy),
            // which refuses a time that is not an occurrence. The first calendar
            // that holds the event decides: a refusal there is the answer, and
            // no other calendar's copy of the id is edited instead.
            const all = Array.from(mgr.getCalendars({}));
            let item = null, cal = null, lookupError = null, parentFound = false;
            const targetIn = (parent) => {
              parentFound = true;
              if (!recurIdStr) return parent;
              const named = occurrenceNamedBy(parent, recurIdStr);
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
                      tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: found ${recurIdStr ? `occurrence for recurrenceId: ${recurIdStr}` : `item: ${eventId}`} in calendar: ${calendar_id}`);
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
                    tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: found ${recurIdStr ? `occurrence for recurrenceId: ${recurIdStr}` : `item: ${eventId}`} in calendar: ${c.id}`);
                  }
                  break;
                } catch (e) {
                  console.warn(`[tmCalendar] modifyCalendarEvent: error finding item in calendar ${c.id}:`, e);
                }
              }
            }

            if (!item) return { ok: false, error: lookupError || "event not found (id/recurrenceId mismatch)" };

            // The occurrences exdates_add names, in the series as it is before
            // the edit; a value that names none is refused before anything is written.
            const exdates = Array.isArray(details.exdates_add) ? exdatesNamedBy(item.parentItem || item, details.exdates_add) : { rids: [] };
            if (exdates.error) return { ok: false, error: exdates.error };

            // Use proper target selection for editing
            const { base, scope, isOccurrence, hasSeries } = pickEditTarget(item, details);
            const clone = base.clone();
            tmCalendarDebugLog(`[tmCalendar] modifyCalendarEvent: editing target - scope: ${scope}, isOccurrence: ${isOccurrence}, hasSeries: ${hasSeries}`);

            // An edit of the series excludes them before its time change, which
            // moves them with the series (onStartDateChange), as its other dates.
            if (scope === "series") {
              for (const rid of exdates.rids) addExdateToItem(clone, rid);
              if (exdates.rids.length) tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: EXDATE added to series, count=", exdates.rids.length);
            }
            
            if (typeof patch.title === "string") clone.title = patch.title;

            // Apply start/end with duration preservation when only one side
            // moves. Extracted to durationPreservation.js so the math is
            // unit-testable without a full Mozilla cal runtime.
            const durationResult = applyDurationPreservation({
              base,
              clone,
              patch,
              toCalIDateTime: toCalIDateTimeInFrameOf(base, patch),
              editTzOverride,
              log: (m) => tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: " + m),
            });
            // The edit still saves; this is the only trace that the event's length changed.
            if (durationResult.error) {
              console.warn("[tmCalendar] modifyCalendarEvent: duration preservation failed:", durationResult.error);
            }
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

            // Handle attendees updates
            if (Array.isArray(patch.attendees)) {
              // Clear existing attendees and add new ones
              try {
                const existing = clone.getAttendees();
                for (const att of existing) {
                  clone.removeAttendee(att);
                }
                for (const a of patch.attendees) {
                  const email = a?.email || a?.id || a?.address;
                  if (!email) continue;
                  const att = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
                  att.id = String(email).startsWith("mailto:") ? String(email) : `mailto:${String(email)}`;
                  if (a?.name) try { att.commonName = String(a.name); } catch {}
                  try { att.rsvp = "TRUE"; } catch {}
                  try { clone.addAttendee(att); } catch {}
                }
              } catch (e) {
                console.warn("[tmCalendar] modifyCalendarEvent: failed to update attendees:", e);
              }
            }

            // Recurrence update
            if (Object.prototype.hasOwnProperty.call(patch, "recurrence")) {
              const recRes = applyRecurrenceToItem(clone, patch.recurrence);
              try { if (recRes.value) tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: RRULE=", recRes.value); } catch (_) {}
            }

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

            // IMPORTANT: Don't set organizer during modify operations to avoid provider rejections

            // Log complete state before save
            tmCalendarDebugLog("[tmCalendar] modifyCalendarEvent: attempting calendar modification...");
            tmCalendarDebugLog("BEFORE save:",
              "descriptionText.len=", (clone.descriptionText || "").length,
              "DESCRIPTION.len=", (clone.getProperty?.("DESCRIPTION")||"").length,
              "ALT.len=",  (clone.getProperty?.("X-ALT-DESC")||"").length,
              "X-MOZ-HTML=", clone.getProperty?.("X-MOZ-HTML") || "");
            
            // Always modify using the same calendar as BASE
            const modified = await base.calendar.modifyItem(clone, base);
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
            
            // Return the item's own event_id
            const returnedId = String((modified?.id) || (base?.id) || "");
            return { 
              ok: true, 
              calendar_id: cal?.id || null,
              event_id: returnedId, 
              title: modified?.title || null,
              invitations: invitationResult
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
        //   series: title, location, description, transparency, attendees,
        //   send_invitations, organizer_email, recurrence, start_iso, end_iso,
        //   all_day, exdates_add), timezone? (for start_iso and end_iso)
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

            // Validate attendees when invitations are requested
            const patchAttendees = Array.isArray(patch.attendees) ? patch.attendees : [];
            if (sendInvites && patchAttendees.length === 0) {
              return { ok: false, error: "send_invitations=true requires at least one attendee on the new series" };
            }

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
            if (!master || !cal) return { ok: false, error: "event not found" };

            // 2. The series must be recurring for a split to make sense.
            if (!master.recurrenceInfo) {
              return { ok: false, error: "event is not recurring — use modifyCalendarEvent for one-off events" };
            }

            // 3. The split point: the occurrence recurrence_id names
            // (occurrenceNamedBy, which refuses a time that is not one). The
            // series divides at that occurrence's RECURRENCE-ID, read in the
            // series' own zone (a RECURRENCE-ID can be stored in another, e.g.
            // UTC), so a changed occurrence splits where it belongs and the
            // following part keeps the series' zone, in which its rule expands.
            const named = occurrenceNamedBy(master, splitIso);
            if (named.error) return { ok: false, error: named.error };
            const splitRid = named.occurrence.recurrenceId;
            const splitDt = splitRid.isDate ? splitRid.clone() : splitRid.getInTimezone(master.startDate.timezone);
            if (splitDt.compare(master.startDate) <= 0) {
              return { ok: false, error: "recurrence_id is the series' first occurrence: to change every occurrence, edit the whole series (edit_scope 'all')" };
            }
            // An occurrence that was changed on its own is carried into the
            // following part with its own time and fields, which the edit's
            // would not reach. Such an edit is refused; the occurrence can be
            // changed alone, and the following ones from the next occurrence.
            if (master.recurrenceInfo.getExceptionFor(splitRid)
                && SPLIT_FIELDS_OF_AN_OCCURRENCE.some((k) => patch[k] != null)) {
              return { ok: false, error: `the occurrence at ${splitIso} was changed on its own, so this change would not reach it: change it alone (edit_scope 'this_only'), then this and the following ones from the next occurrence` };
            }
            // The occurrences exdates_add names, in the series as it is before
            // the split; each goes to the part its RECURRENCE-ID falls in.
            const exdates = Array.isArray(patch.exdates_add) ? exdatesNamedBy(master, patch.exdates_add) : { rids: [] };
            if (exdates.error) return { ok: false, error: exdates.error };

            // 4. Compute UNTIL so the master ends BEFORE `splitDt` (the first
            // occurrence that should belong to the new series), and the bound
            // just after the split (the next day for an all-day series; the next
            // second otherwise), which bounds the check that a rule makes an
            // occurrence at the split.
            //
            // RFC 5545 §3.3.10: the UNTIL value type MUST match DTSTART's.
            //   - All-day master (DTSTART is VALUE=DATE) → UNTIL must be a bare
            //     DATE `YYYYMMDD`. Use (split − 1 day), from the DATE's own digits.
            //   - Timed master → UNTIL must be a UTC date-time `…THHMMSSZ`.
            //     Use (split − 1 second).
            // `toIcsUntil` only emits the date-time form, so the all-day branch
            // formats the bare DATE itself.
            const isAllDayMaster = !!master.startDate?.isDate;
            let untilValue, afterSplit;
            if (isAllDayMaster) {
              untilValue = dayDigitsFrom(splitDt, -1).join("");
              afterSplit = dayDateFrom(splitDt, 1);
            } else {
              const splitMs = splitDt.nativeTime / 1000;
              untilValue = toIcsUntil(new Date(splitMs - 1000).toISOString());
              afterSplit = boundFromIcs(toIcsUntil(new Date(splitMs + 1000).toISOString()));
            }
            if (!untilValue || !afterSplit) return { ok: false, error: "failed to compute UNTIL value" };

            // 5. How each rule divides at the split (splitRule). The series'
            // items are read from its recurrence info, the only place
            // Thunderbird stores and expands them; `plans` follows their order,
            // which a clone of the recurrence info keeps.
            const masterItems = [...(master.recurrenceInfo.getRecurrenceItems({}) || [])];
            if (masterItems.some(isNegativeRuleItem)) {
              return { ok: false, error: "this series cancels occurrences by a rule (EXRULE), which a split cannot keep; change it in the calendar app" };
            }
            const isSeriesRule = (r) => isRuleItem(r) && /\bFREQ=/i.test(String(r?.icalProperty?.value || ""));
            if (!masterItems.some(isSeriesRule)) {
              return { ok: false, error: "master event has no parseable RRULE (its recurrenceInfo holds no FREQ=… rule)" };
            }
            // A rule carried on must make an occurrence at the split to keep its
            // dates. A new rule for the following part replaces every rule it
            // would carry on, so then their alignment does not matter; the split
            // point is an occurrence of the series either way (step 3).
            const newRule = !!(patch.recurrence && typeof patch.recurrence === "object");
            const plans = [];
            for (const r of masterItems) {
              if (!isSeriesRule(r)) { plans.push(null); continue; }
              const plan = splitRule(r, master, splitDt, afterSplit, untilValue);
              if (plan.error) return { ok: false, error: plan.error };
              if (!newRule && plan.following && !plan.aligned) {
                return { ok: false, error: `recurrence_id ${splitIso} is not an occurrence of this series' rule ${String(r.icalProperty.value)}, so the part from there on cannot keep its dates; split at an occurrence every rule makes, or give the following part its own recurrence` };
              }
              plans.push(plan);
            }
            const fromSplitOn = (dt) => !!dt && dt.compare(splitDt) >= 0;

            // 6. The earlier part: the series before the split. Each rule is
            // capped there; excluded and added dates and changed occurrences
            // from the split on leave it. Nothing is written yet.
            // Note: we don't send any "series-ended" notification here — only the
            // new series triggers an invitation (controlled by patch.send_invitations).
            const cappedClone = master.clone();
            try {
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
              // In Thunderbird's own expansion, the earlier part must keep every
              // occurrence the series has just before the split. A rule capped
              // with a bare-DATE UNTIL can end it a day early: ical.js compares
              // by instant, and an all-day start that carries a zone west of
              // UTC falls after an UNTIL of the same day. Refused, not written.
              const lookBack = boundFromIcs(toIcsUntil(new Date(splitDt.nativeTime / 1000 - OCCURRENCE_LOOKUP_REACH_MS).toISOString()));
              const ridsNear = (info, keep) => [...(info.getOccurrences(lookBack, afterSplit, 0) || [])]
                .map((occ) => occ.recurrenceId).filter(keep).map((rid) => rid.nativeTime).sort().join(",");
              if (ridsNear(earlierInfo, () => true) !== ridsNear(master.recurrenceInfo, (rid) => !fromSplitOn(rid))) {
                return { ok: false, error: `the part before ${splitIso} would not keep every occurrence the series has just before it in Thunderbird, so the series cannot be split there; change it in the calendar app` };
              }
              for (const rid of exdates.rids) if (!fromSplitOn(rid)) addExdateToItem(cappedClone, rid);
            } catch (re) {
              console.error("[tmCalendar] splitRecurringEvent: aborting — capping the earlier part failed:", re);
              return { ok: false, error: `failed to apply capped RRULE: ${re}` };
            }

            // 7. Build the new series, the following part: a copy of the series,
            // made as Thunderbird copies an event (calendar-clipboard.js: a
            // clone with a new id), so it keeps every property, reminder,
            // attachment and attendee the series has. Its id is cleared for the
            // calendar to give it one when it is added. Its recurrence is the
            // series' from the split on (below); until then it has none, so
            // setting its start moves nothing with it.
            const newEv = master.clone();
            newEv.recurrenceInfo = null;
            newEv.id = null;

            // Title
            if (typeof patch.title === "string" && patch.title) newEv.title = patch.title;

            // Start = splitDt, End = splitDt + (master.endDate - master.startDate):
            // the occurrence at the split as the series has it.
            try {
              newEv.startDate = splitDt;
              const dur = master.endDate.subtractDate(master.startDate);
              const newEnd = splitDt.clone();
              newEnd.addDuration(dur);
              newEv.endDate = newEnd;
            } catch (e) {
              return { ok: false, error: `failed to compute new start/end: ${e}` };
            }
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

            // Attendees: the series', each with its answer and details. A changed
            // list (patch.attendees, the edit's additions and removals already
            // applied by the JS layer) keeps the series' entry for everyone still
            // on it, in the list's order, and adds the others, who have not
            // answered yet.
            if (Array.isArray(patch.attendees)) {
              const onSeries = new Map(newEv.getAttendees().map((a) => [attendeeAddress(a.id), a]));
              newEv.removeAllAttendees();
              for (const a of patch.attendees) {
                const email = String(a?.email || a?.id || "");
                if (!email) continue;
                const kept = onSeries.get(attendeeAddress(email));
                if (kept) {
                  newEv.addAttendee(kept);
                  continue;
                }
                const att = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
                att.id = email.startsWith("mailto:") ? email : `mailto:${email}`;
                if (a?.name) att.commonName = String(a.name);
                att.participationStatus = "NEEDS-ACTION";
                att.rsvp = "TRUE";
                newEv.addAttendee(att);
              }
            }

            // Organizer — the series' (copied with it) unless patch provides one
            try {
              const orgEmail = (typeof patch.organizer_email === "string" && patch.organizer_email) ? patch.organizer_email : "";
              if (orgEmail) {
                const org = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
                org.id = orgEmail.startsWith("mailto:") ? orgEmail : `mailto:${orgEmail}`;
                org.commonName = (master.organizer && master.organizer.commonName) || orgEmail;
                org.isOrganizer = true;
                newEv.organizer = org;
              }
            } catch (e) {
              console.warn("[tmCalendar] splitRecurringEvent: failed to set organizer:", e);
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
              // Before the time change below, which moves them with the part.
              for (const rid of exdates.rids) if (fromSplitOn(rid)) addExdateToItem(newEv, rid);
            } catch (re) {
              console.error("[tmCalendar] splitRecurringEvent: aborting — building the following part's recurrence failed:", re);
              return { ok: false, error: `failed to build the new series' recurrence: ${re}` };
            }

            // The edit's time change, on the following part only. Setting the
            // start of an event that has a recurrence info makes Thunderbird move
            // its excluded and added dates, each rule's UNTIL and the changed
            // occurrences' RECURRENCE-IDs by the same amount (onStartDateChange),
            // so the part keeps its dates, as an edit of a whole series does.
            const durationResult = applyDurationPreservation({
              base: newEv,
              clone: newEv,
              patch,
              toCalIDateTime: toCalIDateTimeInFrameOf(newEv, patch),
              editTzOverride: tzOverride,
              log: (m) => tmCalendarDebugLog("[tmCalendar] splitRecurringEvent: " + m),
            });
            // The split still saves; this is the only trace that the event's length changed.
            if (durationResult.error) {
              console.warn("[tmCalendar] splitRecurringEvent: duration preservation failed:", durationResult.error);
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

            // A start that changes between all-day and timed: RFC 5545 needs the
            // excluded and added dates, each UNTIL and the changed occurrences'
            // RECURRENCE-IDs in the start's value type, and moving the start
            // keeps theirs. A following part that carries any of them is refused.
            if (!!newEv.startDate?.isDate !== isAllDayMaster && newEv.recurrenceInfo) {
              const info = newEv.recurrenceInfo;
              const items = [...(info.getRecurrenceItems({}) || [])];
              const carriesDates = items.some((r) => !isRuleItem(r))
                || (info.getExceptionIds({}) || []).length > 0
                || (!newRule && items.some((r) => isRuleItem(r) && /\bUNTIL=/i.test(String(r.icalProperty?.value || ""))));
              if (carriesDates) {
                return { ok: false, error: "changing these occurrences between all-day and timed would leave their excluded or added dates, end date or changed occurrences in the other form; change it in the calendar app" };
              }
            }

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
            if (reschedules) {
              const organizer = attendeeAddress(newEv.organizer?.id);
              for (const att of newEv.getAttendees()) {
                if (organizer && attendeeAddress(att.id) === organizer) continue;
                att.participationStatus = "NEEDS-ACTION";
                att.rsvp = "TRUE";
              }
            }

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
              old_event_id: eventId,
              title: created?.title || null,
              invitations: invitationResult,
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



