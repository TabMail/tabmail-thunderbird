const { ExtensionCommon: ExtensionCommonTMCal } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

// tmCalendar experiment API (clean)

function getCalendarManager() {
  try {
    const Ci = globalThis.Ci;
    const Cc = globalThis.Cc;
    if (!Cc || !Ci) {
      console.error("[tmCalendar] Cc/Ci not available in parent context");
      return null;
    }
    const mgr = Cc["@mozilla.org/calendar/manager;1"].getService(Ci.calICalendarManager);
    return mgr || null;
  } catch (e) {
    console.error("[tmCalendar] Failed to get calendar manager via Cc/Ci:", e);
    return null;
  }
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

function ensureRecurrenceInfo(item) {
  try {
    const Ci = globalThis.Ci; const Cc = globalThis.Cc;
    if (item.recurrenceInfo) return item.recurrenceInfo;
    const rinfo = Cc["@mozilla.org/calendar/recurrence-info;1"].createInstance(Ci.calIRecurrenceInfo);
    rinfo.item = item;
    item.recurrenceInfo = rinfo;
    return rinfo;
  } catch (_) { return null; }
}

function addExdateToItem(item, isoString, startDateLike) {
  try {
    const Ci = globalThis.Ci; const Cc = globalThis.Cc;
    const rinfo = ensureRecurrenceInfo(item);
    if (!rinfo) return false;
    // Build calIDateTime aligned with the event's value type
    const base = startDateLike || item.startDate;
    const isAllDay = !!base?.isDate;
    let caldt = toCalIDateTime(String(isoString));
    if (!caldt) return false;
    try { if (isAllDay) caldt.isDate = true; } catch (_) {}
    // Create negative recurrence date (EXDATE)
    const exd = Cc["@mozilla.org/calendar/recurrence-date;1"].createInstance(Ci.calIRecurrenceDate);
    exd.isNegative = true; // EXDATE
    exd.date = caldt;
    if (typeof rinfo.appendRecurrenceItem === "function") rinfo.appendRecurrenceItem(exd);
    else if (typeof rinfo.addRecurrenceItem === "function") rinfo.addRecurrenceItem(exd);
    try { console.log("[tmCalendar] addExdateToItem: added", exd.icalProperty?.value || caldt.toString()); } catch (_) {}
    return true;
  } catch (e) {
    try { console.warn("[tmCalendar] addExdateToItem failed:", e); } catch (_) {}
    return false;
  }
}

function buildRRuleValueFromDetails(details) {
  try {
    if (!details || typeof details !== "object") return null;
    // Default to WEEKLY if freq omitted (enabled recurrence defaults)
    const freq = String(details.freq || "WEEKLY").toUpperCase();
    const parts = [`FREQ=${freq}`];
    const intervalNum = Number(details.interval);
    if (Number.isFinite(intervalNum) && intervalNum > 1) parts.push(`INTERVAL=${intervalNum}`);
    if (Number.isFinite(details.count) && details.count > 0) parts.push(`COUNT=${Number(details.count)}`);
    if (details.until) {
      const until = toIcsUntil(details.until);
      if (until) parts.push(`UNTIL=${until}`);
    }
    if (Array.isArray(details.byDay) && details.byDay.length) parts.push(`BYDAY=${details.byDay.map(String).join(",")}`);
    if (Array.isArray(details.byMonthDay) && details.byMonthDay.length) parts.push(`BYMONTHDAY=${details.byMonthDay.map(n => Number(n)).join(",")}`);
    if (Array.isArray(details.byMonth) && details.byMonth.length) parts.push(`BYMONTH=${details.byMonth.map(n => Number(n)).join(",")}`);
    if (details.wkst) parts.push(`WKST=${String(details.wkst).toUpperCase()}`);
    return parts.join(";").trim();
  } catch (e) {
    try { console.warn("[tmCalendar] buildRRuleValueFromDetails failed:", e); } catch (_) {}
    return null;
  }
}

function applyRecurrenceToItem(item, recurrenceDetails) {
  try {
    if (!recurrenceDetails || typeof recurrenceDetails !== "object") return { applied: false, cleared: false };
    const value = buildRRuleValueFromDetails(recurrenceDetails);
    if (!value) {
      console.warn("[tmCalendar] applyRecurrenceToItem: invalid recurrence details, skipping");
      return { applied: false, cleared: false };
    }
    try { item.setProperty("RRULE", value); } catch (_) {}
    // Best-effort: also construct recurrenceInfo so providers expand occurrences immediately
    try {
      const Ci = globalThis.Ci; const Cc = globalThis.Cc;
      const icsService = Cc["@mozilla.org/calendar/ics-service;1"].getService(Ci.calIICSService);
      const prop = icsService.createIcalProperty("RRULE");
      prop.value = value;
      const rule = Cc["@mozilla.org/calendar/recurrence-rule;1"].createInstance(Ci.calIRecurrenceRule);
      rule.icalProperty = prop;
      const rinfo = Cc["@mozilla.org/calendar/recurrence-info;1"].createInstance(Ci.calIRecurrenceInfo);
      rinfo.item = item;
      if (typeof rinfo.appendRecurrenceItem === "function") {
        rinfo.appendRecurrenceItem(rule);
      } else if (typeof rinfo.addRecurrenceItem === "function") {
        rinfo.addRecurrenceItem(rule);
      }
      item.recurrenceInfo = rinfo;
    } catch (re) {
      try { console.warn("[tmCalendar] applyRecurrenceToItem: recurrenceInfo construction failed:", re); } catch (_) {}
    }
    console.log("[tmCalendar] applyRecurrenceToItem: applied RRULE=", value);
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
        let excludedByWindow = 0;
        for (const occurrence of (items || [])) {
          // Include any item that OVERLAPS [start, end), not only those starting inside it.
          let overlaps = true;
          try {
            const sd = occurrence.startDate;
            const ed = occurrence.endDate;
            if (sd && ed && typeof sd.compare === "function" && typeof ed.compare === "function") {
              // overlap if start < end && end > start
              const startsBeforeWindowEnd = sd.compare(end) < 0;
              const endsAfterWindowStart = ed.compare(start) > 0;
              overlaps = startsBeforeWindowEnd && endsAfterWindowStart;
            }
          } catch (_) {}
          if (!overlaps) { excludedByWindow += 1; continue; }
          const org = occurrence.organizer || null;
          const attendeesArr = safeGetAttendees(occurrence);
          const attendeesList = formatAttendees(attendeesArr);
          const desc = String(occurrence.getProperty?.("DESCRIPTION") || "");
          const url = String(occurrence.getProperty?.("URL") || "");

          // Use stable IDs: occurrence.id preserves suffix, master.id sometimes doesn't
          const master = occurrence.parentItem || occurrence;
          const isOccurrence = !!occurrence.recurrenceId;
          // Prefer the occurrence's id (Google shows suffix there even when master is bare)
          const seriesId = String(occurrence.id || master.id || "");
          
          const resultItem = {
            id: seriesId,                                   // use occurrence's id to preserve suffix
            recurrenceId: isOccurrence ? String(occurrence.recurrenceId?.toString() || "") : "",
            isOccurrence,
            calendarId: String(calObj.id || ""),
            title: String(occurrence.title || ""),
            startDate: String(occurrence.startDate?.toString() || ""),
            endDate: String(occurrence.endDate?.toString() || ""),
            startMs: toEpochMsUTC(occurrence.startDate),
            endMs: toEpochMsUTC(occurrence.endDate),
            isAllDay: !!occurrence.startDate?.isDate,
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
                console.log("[tmCalendar] item TRANSP=", raw || "(empty)", "mapped=", mapped);
                return mapped;
              } catch (_) { return "busy"; }
            })(),
          };
          try {
            // master already defined above
            let rruleStr = "";
            try {
              const rinfo = master?.recurrenceInfo || null;
              if (rinfo && typeof rinfo.getRecurrenceItems === "function") {
                const items = rinfo.getRecurrenceItems({});
                for (const r of (items || [])) {
                  try {
                    if (r && typeof r.icalProperty === "object" && r.icalProperty && String(r.icalProperty.value || "").includes("FREQ=")) {
                      rruleStr = String(r.icalProperty.value || "");
                      break;
                    }
                  } catch (_) {}
                }
              }
              if (!rruleStr) {
                try { rruleStr = String(master.getProperty?.("RRULE") || ""); } catch (_) {}
              }
            } catch (_) {}
            resultItem.isRecurring = !!(master && (master.recurrenceInfo || (rruleStr && rruleStr.includes("FREQ="))));
            if (rruleStr) resultItem.recurrenceRRule = rruleStr;
            // Also surface EXDATEs
            try {
              const exd = extractExdatesFromItem(master);
              if (exd) resultItem.exdates = exd;
            } catch (_) {}
            try { if (rruleStr) console.log("[tmCalendar] item RRULE=", rruleStr, "id=", resultItem.id); } catch (_) {}
          } catch (_) {}
          try {
            console.log(`[tmCalendar] item cal=${String(calObj.id || "")} id=${resultItem.id} title='${resultItem.title}' att=${attendeesArr.length} descLen=${desc.length} url=${url ? "yes" : "no"}`);
          } catch (_) {}
          allResults.push(resultItem);
        }
        if (excludedByWindow) {
          try { console.log(`[tmCalendar] cal ${String(calObj.id || "")} excluded ${excludedByWindow} items outside window`); } catch (_) {}
        }
      } catch (_) {}
    }
    console.log(`[tmCalendar] query: total ${allResults.length} items across ${selected.length} calendars in ${Date.now() - tStart}ms`);
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
 * @returns {calIDateTime|null} - Thunderbird calendar datetime object or null if invalid
 */
function toCalIDateTime(iso) {
  try {
    const Ci = globalThis.Ci;
    const Cc = globalThis.Cc;
    const tzService = Cc["@mozilla.org/calendar/timezone-service;1"].getService(Ci.calITimezoneService);
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
        console.log(`[tmCalendar] toCalIDateTime: UTC datetime '${iso}' -> ${dt.toString()}`);
      } else {
        // Use local timezone for offset-aware times (user's input with timezone)
        timezone = tzService.defaultTimezone || tzService.UTC;
        dt.resetTo(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), timezone);
        console.log(`[tmCalendar] toCalIDateTime: Offset-aware '${iso}' -> ${dt.toString()} in ${timezone.tzid || 'UTC'}`);
      }
    } else {
      // For naive times (no timezone), assume user's local timezone
      // JavaScript's Date correctly applies DST rules for the target date
      timezone = tzService.defaultTimezone || tzService.UTC;
      const localDate = new Date(iso + (iso.includes('T') ? '' : 'T00:00:00'));
      
      // Extract wall-clock components
      const year = localDate.getFullYear();
      const month = localDate.getMonth();
      const day = localDate.getDate();
      const hours = localDate.getHours();
      const minutes = localDate.getMinutes();
      const seconds = localDate.getSeconds();
      
      // Pass to calendar API - it will apply correct DST for this date
      dt.resetTo(year, month, day, hours, minutes, seconds, timezone);
      
      // Log DST info for debugging
      const offset = localDate.getTimezoneOffset();
      const isDST = offset < (new Date(year, 0, 1).getTimezoneOffset());
      console.log(`[tmCalendar] toCalIDateTime: Naive datetime '${iso}' -> ${dt.toString()} in ${timezone.tzid || 'UTC'} (UTC offset: ${-offset/60}hrs, DST: ${isDST})`);
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

function toEpochMsUTC(calDt) {
  try {
    if (!calDt) return null;
    const Ci = globalThis.Ci; const Cc = globalThis.Cc;
    const tzService = Cc["@mozilla.org/calendar/timezone-service;1"].getService(Ci.calITimezoneService);
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
      console.log("[tmCalendar] wireEventEditorCallbacks: wired callbacks to dialog iframe");
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
          console.log("[tmCalendar] wireEventEditorCallbacks: wired callbacks to tab iframe after", attempts, "attempts");
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
    const icsService = Cc["@mozilla.org/calendar/ics-service;1"].getService(Ci.calIICSService);
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
    console.log("[tmCalendar] iTIP QI ok?", (() => { try { itip.QueryInterface(Ci.calIItipItem); return true; } catch { return false; } })());
    console.log("[tmCalendar] has getItemList?", typeof itip.getItemList === "function");
    try {
      const list = itip.getItemList();
      console.log("[tmCalendar] itemList size:", Array.isArray(list) ? list.length : "(not array)");
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
      console.log("[tmCalendar] Using MAIL iTIP transport");
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
            console.log(`[tmCalendar] sendCalendarInvitations: sent ${method} to ${recipients.length} recipients`);
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
    // API exposed
    return {
      tmCalendar: {
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
            console.log(`[tmCalendar] queryCalendarItems invoked start='${s}' end='${e}' calIds=${JSON.stringify(ids)}`);
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
            
            console.log(`[tmCalendar] getCalendars: found ${calendars.length} calendars`);
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
              start: (() => { try { return targetEvent.startDate ? targetEvent.startDate.nativeTime / 1000 : null; } catch { return null; } })(),
              end: (() => { try { return targetEvent.endDate ? targetEvent.endDate.nativeTime / 1000 : null; } catch { return null; } })(),
              isAllDay: !!(targetEvent.startDate && targetEvent.startDate.isDate),
              location: targetEvent.getProperty ? String(targetEvent.getProperty("LOCATION") || "") : "",
              organizer: (() => { try { return String(targetEvent.organizer ? (targetEvent.organizer.commonName || targetEvent.organizer.id || "") : ""); } catch { return ""; } })(),
              attendees: attendeesCount,
              attendeeList: attendeeList,
              calendarId: String(targetCalendar?.id || ""),
              calendarName: String(targetCalendar?.name || targetCalendar?.id || ""),
              isRecurring: !!targetEvent.recurrenceInfo,
              recurrenceRRule: (() => { try { return String(targetEvent.getProperty?.("RRULE") || ""); } catch { return ""; } })(),
              transparency: (() => {
                try {
                  const raw = String(targetEvent.getProperty?.("TRANSP") || "");
                  const mapped = raw.toUpperCase() === "TRANSPARENT" ? "free" : "busy";
                  console.log("[tmCalendar] getCalendarEventDetails: TRANSP=", raw || "(empty)", "mapped=", mapped);
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
                      console.log(`[tmCalendar] deleteCalendarEvent: found event ${eventId} in calendar: ${calendar_id}`);
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
                      console.log(`[tmCalendar] deleteCalendarEvent: found event ${eventId} in calendar: ${cal.id}`);
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
                  console.log(`[tmCalendar] deleteCalendarEvent: invite policy=${policy}`);
                  if (policy === "mail") {
                    console.log("[tmCalendar] deleteCalendarEvent: iMIP cancellation invitations not implemented yet");
                    invitationResult = { ok: false, error: "Email cancellation invitations via Thunderbird are not implemented yet. Please contact the developer or wait for future releases. For now, you can delete events without sending cancellation notices." };
                    // OLD CODE that was WIP -- does not work yet and fails to find iMIP transport
                    // invitationResult = await sendCalendarInvitations(targetEvent, targetCalendar, "CANCEL", details.organizer_email);
                  } else {
                    console.log("[tmCalendar] deleteCalendarEvent: relying on provider/server notifications; no cancellation emails sent");
                    invitationResult = { ok: true, message: "provider/server notifications assumed" };
                  }
                }
              }
              
              console.log("[tmCalendar] deleteCalendarEvent: deleting event:", eventId);
              await targetCalendar.deleteItem(targetEvent);
              console.log("[tmCalendar] deleteCalendarEvent: event deleted successfully");
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
            const start = toCalIDateTime(String(details.start_iso || ""));
            const end = toCalIDateTime(String(details.end_iso || ""));
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
              console.log("[tmCalendar] createCalendarEvent: TRANSP set from", before || "(none)", "to", transVal);
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
              try { if (recRes.value) console.log("[tmCalendar] createCalendarEvent: RRULE=", recRes.value); } catch (_) {}
            }

            // Persist (returns the created item)
            const created = await cal.addItem(ev);
            console.log("[tmCalendar] createCalendarEvent: created event with id:", created?.id);
            try { const transpSaved = String(created?.getProperty?.("TRANSP") || ""); console.log("[tmCalendar] createCalendarEvent: initial TRANSP on created:", transpSaved || "(empty)"); } catch (_) {}
            try {
              let rruleStr = "";
              try { rruleStr = String(created?.getProperty?.("RRULE") || ev?.getProperty?.("RRULE") || ""); } catch (_) {}
              const rApplied = !!(rruleStr && rruleStr.includes("FREQ="));
              console.log("[tmCalendar] createCalendarEvent: recurrence applied?", rApplied, rruleStr ? `RRULE=${rruleStr}` : "(no RRULE)");
              // Verify persisted copy by re-fetching from calendar
              try {
                const verify = created?.id ? await cal.getItem(created.id) : null;
                let persisted = "";
                try { persisted = String(verify?.getProperty?.("RRULE") || ""); } catch (_) {}
                if (persisted) console.log("[tmCalendar] createCalendarEvent: persisted RRULE=", persisted);
                try { const transp = String(verify?.getProperty?.("TRANSP") || ""); console.log("[tmCalendar] createCalendarEvent: persisted TRANSP=", transp || "(empty)"); } catch (_) {}
              } catch (ve) { console.warn("[tmCalendar] createCalendarEvent: verify fetch failed:", ve); }
            } catch (_) {}
            
            let invitationResult = null;
            if (details.send_invitations && (details.attendees?.length > 0)) {
              const policy = getInvitePolicy(cal);
              console.log(`[tmCalendar] createCalendarEvent: invite policy=${policy}`);
              if (policy === "mail") {
                console.log("[tmCalendar] createCalendarEvent: iMIP invitations not implemented yet");
                invitationResult = { ok: false, error: "Email invitations via Thunderbird are not implemented yet. Please contact the developer or wait for future releases. For now, you can create events without sending invitations." };
                // OLD CODE that was WIP -- does not work yet and fails to find iMIP transport
                // invitationResult = await sendCalendarInvitations(created || ev, cal, "REQUEST", details.organizer_email);
              } else {
                console.log("[tmCalendar] createCalendarEvent: relying on provider/server notifications; no iMIP sent");
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
            
            // Validate attendees when invitations are requested
            const sendInvites = !!details.send_invitations;
            const attendees = Array.isArray(details.attendees) ? details.attendees : [];
            if (sendInvites && attendees.length === 0) {
              return { ok: false, error: "send_invitations=true requires at least one attendee" };
            }
            
            const patch = details.patch || details; // Allow patch to be in details directly
            
            // Resolve the exact item using (id, recurrenceId) pair
            const all = Array.from(mgr.getCalendars({}));
            let item = null, cal = null;
            
            // If calendar_id is provided, search that calendar first
            if (calendar_id) {
              const targetCal = all.find(c => String(c.id) === String(calendar_id));
              if (targetCal) {
                try {
                  const parent = await targetCal.getItem(eventId);
                  if (parent) {
                    if (recurIdStr) {
                      // Find specific occurrence from the parent
                      const rinfo = parent.recurrenceInfo;
                      if (rinfo) {
                        // Build a calIDateTime from the recurrenceId string
                        const rid = toCalIDateTime(recurIdStr);
                        if (rid) {
                          // Important: recurrenceId must match the value type (all-day vs date-time)
                          rid.isDate = !!parent.startDate?.isDate;
                          const occ = rinfo.getOccurrenceFor(rid);
                          if (occ) {
                            item = occ; cal = targetCal;
                            console.log(`[tmCalendar] modifyCalendarEvent: found occurrence for recurrenceId: ${recurIdStr} in calendar: ${calendar_id}`);
                          }
                        }
                      }
                    } else {
                      // Non-recurring or series-parent edit
                      item = parent; cal = targetCal;
                      console.log(`[tmCalendar] modifyCalendarEvent: found master item: ${eventId} in calendar: ${calendar_id}`);
                    }
                  }
                } catch (e) {
                  console.warn(`[tmCalendar] modifyCalendarEvent: error finding item in calendar ${calendar_id}:`, e);
                }
              }
            }
            
            // If not found in specific calendar (or no calendar_id provided), search all calendars
            if (!item) {
              for (const c of all) {
                try {
                  const parent = await c.getItem(eventId);
                  if (!parent) continue;

                  if (recurIdStr) {
                    // Find specific occurrence from the parent
                    const rinfo = parent.recurrenceInfo;
                    if (!rinfo) { continue; } // it wasn't a series after all
                    // Build a calIDateTime from the recurrenceId string
                    const rid = toCalIDateTime(recurIdStr);
                    if (!rid) { continue; }
                    // Important: recurrenceId must match the value type (all-day vs date-time)
                    rid.isDate = !!parent.startDate?.isDate;
                    const occ = rinfo.getOccurrenceFor(rid);
                    if (!occ) { continue; }
                    item = occ; cal = c;
                    console.log(`[tmCalendar] modifyCalendarEvent: found occurrence for recurrenceId: ${recurIdStr} in calendar: ${c.id}`);
                  } else {
                    // Non-recurring or series-parent edit
                    item = parent; cal = c;
                    console.log(`[tmCalendar] modifyCalendarEvent: found master item: ${eventId} in calendar: ${c.id}`);
                  }
                  if (item) break;
                } catch (e) {
                  console.warn(`[tmCalendar] modifyCalendarEvent: error finding item in calendar ${c.id}:`, e);
                }
              }
            }
            
            if (!item) return { ok: false, error: "event not found (id/recurrenceId mismatch)" };

            // Use proper target selection for editing
            const { base, scope, isOccurrence, hasSeries } = pickEditTarget(item, details);
            const clone = base.clone();
            console.log(`[tmCalendar] modifyCalendarEvent: editing target - scope: ${scope}, isOccurrence: ${isOccurrence}, hasSeries: ${hasSeries}`);
            
            // Capture original RRULE for preservation when only adding EXDATEs
            let originalRrule = "";
            try { originalRrule = String(base.getProperty?.("RRULE") || ""); } catch (_) {}

            if (typeof patch.title === "string") clone.title = patch.title;
            if (patch.start_iso) {
              const s = toCalIDateTime(String(patch.start_iso));
              if (s) { if (patch.all_day) s.isDate = true; clone.startDate = s; }
            }
            if (patch.end_iso) {
              const e = toCalIDateTime(String(patch.end_iso));
              if (e) { if (patch.all_day) e.isDate = true; clone.endDate = e; }
            }
            if (typeof patch.location === "string") try { clone.setProperty("LOCATION", patch.location); } catch {}
            
            // Transparency (availability): apply only if provided
            if (typeof patch.transparency === "string") {
              try {
                const requested = String(patch.transparency).toLowerCase();
                const transVal = requested === "free" ? "TRANSPARENT" : "OPAQUE";
                const before = String(clone.getProperty?.("TRANSP") || "");
                clone.setProperty("TRANSP", transVal);
                console.log("[tmCalendar] modifyCalendarEvent: TRANSP set from", before || "(none)", "to", transVal);
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

              console.log(`[tmCalendar] modifyCalendarEvent: setting description to: ${textDesc}`);
              
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
                  console.log(`[tmCalendar] modifyCalendarEvent: set HTML alt description (length: ${patch.description_html.length})`);
                } else {
                  // No HTML given → make sure old HTML doesn't override your new TEXT
                  if (typeof clone.deleteProperty === "function") {
                    clone.deleteProperty("X-ALT-DESC");
                    clone.deleteProperty("X-MOZ-HTML");
                    // Seen in the wild with some add-ons:
                    clone.deleteProperty("X-MOZ-ALT-DESC");
                    console.log(`[tmCalendar] modifyCalendarEvent: cleared HTML alt description properties`);
                  }
                }
                
                // Log what will actually be saved
                console.log(`[tmCalendar] modifyCalendarEvent: will save DESCRIPTION length = ${String(clone.getProperty?.("DESCRIPTION")||"").length}, X-ALT-DESC present = ${!!clone.getProperty?.("X-ALT-DESC")}`);
                
                // Verify the description was set on the clone
                const verifyDesc = String(clone.getProperty?.("DESCRIPTION") || "");
                console.log(`[tmCalendar] modifyCalendarEvent: description verification on clone - length: ${verifyDesc.length}, matches: ${verifyDesc === textDesc}`);
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
              try { if (recRes.value) console.log("[tmCalendar] modifyCalendarEvent: RRULE=", recRes.value); } catch (_) {}
              // If recurrence explicitly set, refresh captured RRULE
              try { originalRrule = String(clone.getProperty?.("RRULE") || originalRrule || ""); } catch (_) {}
            }

            // EXDATE additions (exclude specific occurrences) - route to correct target
            if (Array.isArray(details.exdates_add) && details.exdates_add.length) {
              if (scope !== "series") {
                // Switch to parent just for EXDATE edits
                const parent = item.parentItem || item;
                const parentOld = parent.clone();
                let added = 0;
                for (const iso of details.exdates_add) {
                  try { if (addExdateToItem(parent, String(iso), parent.startDate)) added += 1; } catch (_) {}
                }
                console.log("[tmCalendar] modifyCalendarEvent: EXDATE added to parent, count=", added);
                await parent.calendar.modifyItem(parent, parentOld);
              } else {
                // We're already editing the series, add to clone
                try {
                  let added = 0;
                  for (const iso of details.exdates_add) {
                    try { if (addExdateToItem(clone, String(iso), clone.startDate)) added += 1; } catch (_) {}
                  }
                  console.log("[tmCalendar] modifyCalendarEvent: EXDATE added to series, count=", added);
                } catch (xe) {
                  console.warn("[tmCalendar] modifyCalendarEvent: failed to add EXDATE:", xe);
                }
              }
            }

            // Preserve RRULE if not explicitly changed
            try {
              const currentRrule = String(clone.getProperty?.("RRULE") || "");
              if (originalRrule && !currentRrule) {
                clone.setProperty("RRULE", originalRrule);
                console.log("[tmCalendar] modifyCalendarEvent: preserved RRULE from base");
              }
            } catch (_) {}

            // IMPORTANT: Don't set organizer during modify operations to avoid provider rejections

            // Log complete state before save
            console.log("[tmCalendar] modifyCalendarEvent: attempting calendar modification...");
            console.log("BEFORE save:",
              "descriptionText.len=", (clone.descriptionText || "").length,
              "DESCRIPTION.len=", (clone.getProperty?.("DESCRIPTION")||"").length,
              "ALT.len=",  (clone.getProperty?.("X-ALT-DESC")||"").length,
              "X-MOZ-HTML=", clone.getProperty?.("X-MOZ-HTML") || "");
            
            // Always modify using the same calendar as BASE
            const modified = await base.calendar.modifyItem(clone, base);
            console.log("[tmCalendar] modifyCalendarEvent: modifyItem completed");
            console.log("[tmCalendar] modifyCalendarEvent: modified event with id:", modified?.id);
            
            // Verify description was persisted after modifyItem - re-fetch fresh copy
            try {
              const fresh = await base.calendar.getItem(modified.id);
              console.log("AFTER save (fresh):",
                "descriptionText.len=", (fresh?.descriptionText || "").length,
                "DESCRIPTION.len=",    (fresh?.getProperty?.("DESCRIPTION") || "").length,
                "match=", (String(fresh?.descriptionText || "") === String(fresh?.getProperty?.("DESCRIPTION") || "")),
                "ALT.len=",  (fresh?.getProperty?.("X-ALT-DESC")||"").length,
                "X-MOZ-HTML=", fresh?.getProperty?.("X-MOZ-HTML") || "");
              try { const transp = String(fresh?.getProperty?.("TRANSP") || ""); console.log("[tmCalendar] modifyCalendarEvent: persisted TRANSP=", transp || "(empty)"); } catch (_) {}
              
              const savedDescText = String(fresh?.descriptionText || "");
              const savedDescProp = String(fresh?.getProperty?.("DESCRIPTION") || "");
              const savedAltDesc = String(fresh?.getProperty?.("X-ALT-DESC") || "");
              
              if (typeof patch.description === "string") {
                const textMatches = savedDescText === patch.description;
                const propMatches = savedDescProp === patch.description;
                console.log(`[tmCalendar] modifyCalendarEvent: descriptionText matches: ${textMatches}, DESCRIPTION matches: ${propMatches}`);
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
              try { rruleStr = String(modified?.getProperty?.("RRULE") || clone?.getProperty?.("RRULE") || ""); } catch (_) {}
              const rApplied = !!(rruleStr && rruleStr.includes("FREQ="));
              console.log("[tmCalendar] modifyCalendarEvent: recurrence applied?", rApplied, rruleStr ? `RRULE=${rruleStr}` : "(no RRULE)");
              // Verify persisted copy by re-fetching from calendar
              try {
                const verify = modified?.id ? await cal.getItem(modified.id) : null;
                let persisted = "";
                try { persisted = String(verify?.getProperty?.("RRULE") || ""); } catch (_) {}
                if (persisted) console.log("[tmCalendar] modifyCalendarEvent: persisted RRULE=", persisted);
                const exd = verify ? extractExdatesFromItem(verify) : "";
                if (exd) console.log("[tmCalendar] modifyCalendarEvent: persisted EXDATE=", exd);
              } catch (ve) { console.warn("[tmCalendar] modifyCalendarEvent: verify fetch failed:", ve); }
            } catch (_) {}
            
            let invitationResult = null;
            if (details.send_invitations && modified) {
              const attendees = modified.getAttendees ? modified.getAttendees() : [];
              if (attendees.length > 0) {
                const policy = getInvitePolicy(cal);
                console.log(`[tmCalendar] modifyCalendarEvent: invite policy=${policy}`);
                if (policy === "mail") {
                  console.log("[tmCalendar] modifyCalendarEvent: iMIP invitations not implemented yet");
                  invitationResult = { ok: false, error: "Email invitations via Thunderbird are not implemented yet. Please contact the developer or wait for future releases. For now, you can modify events without sending invitations." };
                  // OLD CODE that was WIP -- does not work yet and fails to find iMIP transport
                  // invitationResult = await sendCalendarInvitations(created || ev, cal, "REQUEST", details.organizer_email);
                } else {
                  console.log("[tmCalendar] modifyCalendarEvent: relying on provider/server notifications; no iMIP sent");
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
      },
    };
  }
};

this.tmCalendar = tmCalendar;



