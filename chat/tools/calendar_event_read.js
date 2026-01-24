// calendar_event_read.js – returns detailed entry/entries matching by calendar and start time

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";
import { toNaiveIso } from "../modules/helpers.js";

export function resetPaginationSessions() {}

/**
 * Args:
 * - event_id: optional string; if provided with calendar_id, fetches the event directly
 * - calendar_id: optional string; used with event_id for direct lookup
 * - start_iso: ISO8601 start datetime (user timezone or UTC); only needed when event_id is not available
 * - title: optional string; if provided, used to further filter matching entries (for start_iso search)
 * 
 * When event_id + calendar_id are provided, uses direct lookup.
 * Otherwise, searches ALL calendars by start time.
 */
export async function run(args = {}, options = {}) {
  try {
    if (!browser.tmCalendar) return { ok: false, error: "calendar bridge not available" };

    const eventId = String(args?.event_id || "").trim();
    const calendarId = String(args?.calendar_id || "").trim();
    const startIso = String(args?.start_iso || "").trim();
    const titleFilter = typeof args?.title === "string" ? args.title.trim() : "";
    
    // Direct lookup path: when event_id is provided
    if (eventId) {
      log(`[TMDBG Tools] calendar_event_read: direct lookup for event_id=${eventId}, calendar_id=${calendarId || "(all)"}`);
      try {
        const details = await browser.tmCalendar.getCalendarEventDetails(eventId, calendarId || null);
        log(`[TMDBG Tools] calendar_event_read: getCalendarEventDetails returned ok=${details?.ok}`);
        if (details && details.ok) {
          // Format the response using the same formatDetailed function
          const formattedResult = formatFromDetails(details);
          return { ok: true, results: formattedResult };
        } else {
          const errMsg = details?.error || "event not found";
          log(`[TMDBG Tools] calendar_event_read: direct lookup failed: ${errMsg}`, "warn");
          return { ok: false, error: errMsg };
        }
      } catch (e) {
        log(`[TMDBG Tools] calendar_event_read: direct lookup exception: ${e}`, "error");
        return { ok: false, error: String(e || "direct lookup failed") };
      }
    }
    
    // Fallback: search by start_iso (original behavior)
    if (!startIso) return { ok: false, error: "missing required argument: provide either 'event_id' or 'start_iso'" };

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    // Get all calendars
    let allCalendars = [];
    try {
      allCalendars = await browser.tmCalendar.listCalendars();
    } catch (e) {
      log(`[TMDBG Tools] calendar_event_read: listCalendars failed: ${e}`, "error");
      return { ok: false, error: `failed to list calendars: ${String(e)}` };
    }
    if (!Array.isArray(allCalendars)) allCalendars = [];

    // Always search ALL calendars
    const targetCalendars = allCalendars;
    log(`[TMDBG Tools] calendar_event_read: searching ALL calendars (${allCalendars.length} total)`);

    // Build a tight query window around the provided start
    const start = new Date(startIso);
    if (isNaN(start.getTime())) return { ok: false, error: `invalid start datetime: ${startIso}` };
    const tol = Number(CHAT_SETTINGS.calendarEntryMatchToleranceMs) || 60000;
    const windowStart = new Date(start.getTime() - tol);
    const windowEnd = new Date(start.getTime() + tol);

    // Query all target calendars
    let allItems = [];
    for (const cal of targetCalendars) {
      try {
        const items = await browser.tmCalendar.queryCalendarItems(windowStart.toISOString(), windowEnd.toISOString(), [cal.id]);
        if (Array.isArray(items)) {
          allItems.push(...items);
          log(`[TMDBG CalendarEntry] queried calId=${cal.id} returned=${items.length} items`);
        }
      } catch (e) {
        log(`[TMDBG Tools] calendar_event_read: queryCalendarItems failed for ${cal.id}: ${e}`, "warn");
        // Continue with other calendars instead of failing completely
      }
    }

    log(`[TMDBG CalendarEntry] total items from ${targetCalendars.length} calendars: ${allItems.length}`);
    try {
      const sampleKeys = Object.keys(allItems[0] || {});
      log(`[TMDBG CalendarEntry] window=[${windowStart.toISOString()}..${windowEnd.toISOString()}] sampleKeys=${sampleKeys.join(",")}`);
    } catch (_) {}

    // Filter by exact start (within tolerance) and optional title
    const matches = [];
    for (const it of allItems) {
      try {
        const s = normalizeDate(it.startMs);
        if (!isWithinTolerance(s, start, tol)) continue;
        if (titleFilter && (String(it.title || "").trim() !== titleFilter)) continue;
        // Debug: log raw item shape for filtering
        try {
          const keys = Object.keys(it || {});
          const attendeesMeta = Array.isArray(it.attendeeList)
            ? `list_len=${it.attendeeList.length}`
            : `type=${typeof it.attendees}`;
          const descMeta = typeof it.description === "string" ? `len=${it.description.length}` : `type=${typeof it.description}`;
          log(`[TMDBG CalendarEntry] match calId=${it.calendarId || "unknown"} itemId=${it.id || ""} title='${it.title || ""}' startMs=${it.startMs} endMs=${it.endMs} attendees=${attendeesMeta} description=${descMeta} keys=${keys.join(",")}`);
        } catch (_) {}
        
        // Find the calendar object for this item
        const itemCal = allCalendars.find(c => c.id === it.calendarId) || { id: it.calendarId || "unknown" };
        matches.push(formatDetailed(it, itemCal));
      } catch (e) {
        log(`[TMDBG Tools] calendar_event_read: format error: ${e}`, "warn");
      }
    }

    if (matches.length === 0) {
      try {
        const calIds = targetCalendars.map(c => c.id).join(",");
        log(`[TMDBG CalendarEntry] no-match calIds=[${calIds}] start_iso='${startIso}' tolMs=${tol} window=[${windowStart.toISOString()}..${windowEnd.toISOString()}] titleFilter='${titleFilter}' itemsQueried=${allItems.length}`);
      } catch (_) {}
      return { ok: true, results: "No entries matched." };
    }
    return { ok: true, results: matches.join("\n-----\n") };
  } catch (e) {
    log(`[TMDBG Tools] calendar_event_read failed: ${e}`, "error");
    return { ok: false, error: String(e || "unknown error in calendar_event_read") };
  }
}

function normalizeDate(msOrIso) {
  if (typeof msOrIso === "number") return new Date(msOrIso);
  if (typeof msOrIso === "string") return new Date(msOrIso);
  if (msOrIso && typeof msOrIso === "object" && typeof msOrIso.toISOString === "function") return new Date(msOrIso.toISOString());
  return new Date(0);
}

function isWithinTolerance(a, b, tolMs) {
  try { return Math.abs(a.getTime() - b.getTime()) <= tolMs; } catch (_) { return false; }
}

function safeGetCalendarName(cals, id) {
  try {
    const m = (cals || []).find((c) => c.id === id);
    return (m && (m.name || m.title || m.id)) || String(id || "");
  } catch (_) { return String(id || ""); }
}

function formatDetailed(it, cal) {
  const lines = [
    `calendar_id: ${cal.id}`,
    `event_id: ${it.id || ""}`,
  ];
  
  // Show recurrence info for occurrences
  if (it.isOccurrence && it.recurrenceId) {
    lines.push(`recurrence_id: ${it.recurrenceId}`);
  }
  
  // Use naive ISO format for consistency with LLM input format
  lines.push(`title: ${it.title || "(No title)"}`,
    `start_iso: ${toNaiveIso(it.startMs)}`,
    `end_iso: ${toNaiveIso(it.endMs)}`,
    `all_day: ${it.isAllDay ? "yes" : "no"}`);
  if (it.isRecurring) lines.push(`recurring: yes`);
  if (typeof it.recurrenceRRule === "string" && it.recurrenceRRule) {
    lines.push(`RRULE: ${it.recurrenceRRule}`);
  }
  if (it.location) lines.push(`Location: ${it.location}`);
  if (it.organizer) lines.push(`Organizer: ${it.organizer}`);
  if (typeof it.transparency === "string") {
    const mapped = it.transparency === "free" ? "free" : "busy";
    lines.push(`transparency: ${mapped}`);
  }
  if (typeof it.exdates === "string" && it.exdates) {
    lines.push(`EXDATE: ${it.exdates}`);
  }
  // Attendees: prefer attendeeList (detailed), otherwise try to expand known structures
  const attendeeLines = buildAttendeeLines(it);
  if (attendeeLines.length) {
    lines.push(`attendees:`);
    lines.push(...attendeeLines.map(v => `- ${v}`));
  } else if (typeof it.attendees !== "undefined") {
    const count = Number(it.attendees) || 0;
    lines.push(`attendees: ${count}`);
  }
  if (typeof it.description === "string" && it.description.trim().length) {
    lines.push(`description: ${it.description}`);
  }
  if (it.conference_url) lines.push(`conference_url: ${it.conference_url}`);
  return lines.join("\n");
}

function buildAttendeeLines(it) {
  try {
    const lines = [];
    if (Array.isArray(it.attendeeList)) {
      for (const a of it.attendeeList) {
        const parts = [];
        if (a.name) parts.push(a.name);
        // Extract email from various possible fields, removing mailto: prefix if present
        let email = "";
        if (a.email) {
          email = String(a.email).replace(/^mailto:/i, "").trim();
        } else if (a.id) {
          email = String(a.id).replace(/^mailto:/i, "").trim();
        } else if (a.mail) {
          email = String(a.mail).replace(/^mailto:/i, "").trim();
        } else if (a.address) {
          email = String(a.address).replace(/^mailto:/i, "").trim();
        }
        // Always show email if available (this is the email used to add the attendee)
        if (email) parts.push(`<${email}>`);
        const role = a.role || a.participationRole || "";
        const status = a.participationStatus || a.status || "";
        const extra = [role, status].filter(Boolean).join(", ");
        const base = parts.join(" ");
        lines.push(extra ? `${base} (${extra})` : base);
      }
      return lines;
    }
    // Sometimes providers include attendees as a string array or object
    if (Array.isArray(it.attendees)) {
      for (const at of it.attendees) {
        if (typeof at === "string") {
          // If it's a string, try to extract email from mailto: format
          const email = at.replace(/^mailto:/i, "").trim();
          lines.push(email || at);
        } else if (at && typeof at === "object") {
          const nm = at.name || at.displayName || "";
          // Extract email from various possible fields, removing mailto: prefix if present
          let em = "";
          if (at.email) {
            em = String(at.email).replace(/^mailto:/i, "").trim();
          } else if (at.id) {
            em = String(at.id).replace(/^mailto:/i, "").trim();
          } else if (at.mail) {
            em = String(at.mail).replace(/^mailto:/i, "").trim();
          } else if (at.address) {
            em = String(at.address).replace(/^mailto:/i, "").trim();
          }
          // Always show email if available
          const base = [nm, em ? `<${em}>` : ""].filter(Boolean).join(" ");
          lines.push(base || JSON.stringify(at));
        }
      }
      return lines;
    }
    return lines;
  } catch (_) {
    return [];
  }
}

/**
 * Format event details from getCalendarEventDetails API response
 * (different structure from queryCalendarItems)
 */
function formatFromDetails(details) {
  const lines = [
    `calendar_id: ${details.calendarId || ""}`,
    `event_id: ${details.id || ""}`,
  ];
  
  // Title
  lines.push(`title: ${details.title || "(No title)"}`);
  
  // Format start/end times (details.start/end are in ms since epoch)
  if (details.start) {
    lines.push(`start_iso: ${toNaiveIso(details.start)}`);
  }
  if (details.end) {
    lines.push(`end_iso: ${toNaiveIso(details.end)}`);
  }
  
  lines.push(`all_day: ${details.isAllDay ? "yes" : "no"}`);
  
  if (details.isRecurring) lines.push(`recurring: yes`);
  if (details.recurrenceRRule) lines.push(`RRULE: ${details.recurrenceRRule}`);
  if (details.location) lines.push(`Location: ${details.location}`);
  if (details.organizer) {
    // Clean up organizer - remove mailto: prefix if present
    const organizer = String(details.organizer).replace(/^mailto:/i, "").trim();
    lines.push(`Organizer: ${organizer}`);
  }
  if (details.transparency) {
    lines.push(`transparency: ${details.transparency}`);
  }
  
  // Attendees
  if (Array.isArray(details.attendeeList) && details.attendeeList.length > 0) {
    lines.push(`attendees:`);
    for (const a of details.attendeeList) {
      const parts = [];
      if (a.name) parts.push(a.name);
      let email = "";
      if (a.email) {
        email = String(a.email).replace(/^mailto:/i, "").trim();
      }
      if (email) parts.push(`<${email}>`);
      const status = a.status || "";
      const base = parts.join(" ");
      lines.push(`- ${status ? `${base} (${status})` : base}`);
    }
  } else if (typeof details.attendees === "number" && details.attendees > 0) {
    lines.push(`attendees: ${details.attendees}`);
  }
  
  return lines.join("\n");
}


