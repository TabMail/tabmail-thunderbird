// calendar_search.js – returns a compact, calendar-like summary grouped by calendar and date

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";

// ====================================================================
// UNIFIED TIME NORMALIZATION SYSTEM
// ====================================================================

/**
 * Normalize any incoming time data to a consistent internal Date object in user timezone.
 * This is the SINGLE point of entry for all time data coming into our calendar logic.
 * 
 * @param {number|string|Date} timeInput - Timestamp in ms, ISO string, or Date object
 * @param {string} userTz - User timezone (optional, defaults to browser timezone)
 * @returns {Date} Normalized Date object in user timezone
 */
function normalizeTimeInput(timeInput, userTz = null) {
  try {
    const tz = userTz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    
    let date;
    if (typeof timeInput === "number") {
      date = new Date(timeInput);
    } else if (typeof timeInput === "string") {
      date = new Date(timeInput);
    } else if (timeInput instanceof Date) {
      date = new Date(timeInput.getTime());
    } else {
      log(`[TMDBG TimeNorm] Invalid time input: ${timeInput}`, "error");
      return new Date();
    }
    
    if (isNaN(date.getTime())) {
      log(`[TMDBG TimeNorm] Invalid date created from: ${timeInput}`, "error");
      return new Date();
    }
    
    // Convert to user timezone by creating a new Date that represents the same moment
    // but adjusted for display/calculation in the user's timezone
    const normalized = new Date(date.toLocaleString("en-US", { timeZone: tz }));
    
    log(`[TMDBG TimeNorm] Normalized ${timeInput} (${typeof timeInput}) -> ${normalized.toISOString()} in tz=${tz}`);
    return normalized;
  } catch (e) {
    log(`[TMDBG TimeNorm] Error normalizing time input ${timeInput}: ${e}`, "error");
    return new Date();
  }
}

/**
 * Create a day key from a normalized Date object.
 * Input MUST be already normalized via normalizeTimeInput().
 * 
 * @param {Date} normalizedDate - Date object already in user timezone
 * @returns {string} Day key in format "YYYY-MM-DD"
 */
function makeDayKeyFromNormalized(normalizedDate) {
  try {
    if (!normalizedDate || !(normalizedDate instanceof Date) || isNaN(normalizedDate.getTime())) {
      log(`[TMDBG TimeNorm] Invalid normalized date: ${normalizedDate}`, "error");
      return null;
    }
    
    const year = normalizedDate.getFullYear();
    const month = String(normalizedDate.getMonth() + 1).padStart(2, "0");
    const day = String(normalizedDate.getDate()).padStart(2, "0");
    
    const dayKey = `${year}-${month}-${day}`;
    log(`[TMDBG TimeNorm] Created day key: ${dayKey} from normalized date ${normalizedDate.toISOString()}`);
    return dayKey;
  } catch (e) {
    log(`[TMDBG TimeNorm] Error creating day key from normalized date ${normalizedDate}: ${e}`, "error");
    return null;
  }
}

let summarySessions = {};

export function resetPaginationSessions() {
  try {
    summarySessions = {};
    log(`[TMDBG Tools] calendar_search: pagination sessions reset`);
  } catch (_) {}
}

function normalizeArgs(args = {}) {
  return {
    from_date: args?.from_date || "",
    to_date: args?.to_date || "",
    query: typeof args?.query === "string" ? args.query : "",
  };
}

function sessionKey(args) {
  const norm = normalizeArgs(args);
  return JSON.stringify(norm);
}

function resolvePageSize() {
  const defSize = Number(CHAT_SETTINGS.calendarPageSizeDefault) || 10;
  const maxSize = Number(CHAT_SETTINGS.calendarPageSizeMax) || 100;
  let size = defSize;
  if (!Number.isFinite(size) || size <= 0) size = 10;
  if (size > maxSize) size = maxSize;
  return size;
}

/**
 * Args:
 * - from_date: optional ISO string (inclusive)
 * - to_date: optional ISO string (exclusive)
 * - page_index: optional page number (1-based), defaults to 1
 */
export async function run(args = {}, options = {}) {
  try {
    const bypass = options && options.__bypassQueryRequirement === true;
    const q = typeof args?.query === "string" ? args.query.trim() : "";
    if (!bypass && q.length === 0) {
      log(`[TMDBG Tools] calendar_search: missing required 'query'` , "error");
      return { error: "calendar_search requires a non-empty 'query' string" };
    }
    try {
      const hasSlash = /[\\\/]/.test(q);
      const previewLen = Number(CHAT_SETTINGS.calendarQueryLogPreviewChars) || 120;
      if (hasSlash) {
        log(`[TMDBG Tools] calendar_search: query contains slash/backslash; raw='${q.slice(0,previewLen)}'`);
      } else {
        log(`[TMDBG Tools] calendar_search: query does not contain slash/backslash; len=${q.length}`);
      }
    } catch (_) {}
    const pageSize = resolvePageSize();
    const sKey = sessionKey(args);
    if (!summarySessions[sKey]) {
      if (!browser.tmCalendar) {
        return { error: "calendar bridge not available" };
      }
      log(`[TMDBG Tools] calendar_search: using tmCalendar experiment bridge (new session)`);
      const { days, order } = await buildCalendarSummary(args);
      const flat = [];
      // Flatten per-day payloads for pagination stability
      for (const dayKey of order) {
        const dayPayload = days[dayKey];
        flat.push(dayPayload);
      }
      summarySessions[sKey] = {
        key: sKey,
        items: flat,
        pageSize,
        total: flat.length,
      };
      log(`[TMDBG Tools] calendar_search: session created pageSize=${pageSize} totalDays=${flat.length}`);
    }

    const session = summarySessions[sKey];
    const totalPages = Math.max(1, Math.ceil(session.total / session.pageSize));
    const pageIndexArg = Number.isFinite(args?.page_index) ? Number(args.page_index) : 1;
    const pageIndex = Math.max(0, pageIndexArg - 1);
    const safeIndex = Math.min(pageIndex, totalPages - 1);

    const start = safeIndex * session.pageSize;
    const end = start + session.pageSize;
    const pageItems = session.items.slice(start, end);

    // Guard against empty day payloads to avoid blank-only outputs
    const nonEmptyItems = pageItems.filter(
      (s) => typeof s === "string" && s.trim().length > 0
    );
    const results = nonEmptyItems.join("\n\n");
    const result = {
      results,
      page: safeIndex + 1,
      totalPages,
      // pageCount: pageItems.length,
      totalItems: session.total,
    };
    if (safeIndex + 1 < totalPages) {
      result.comment = `There are more pages of results. To get the next page, call this tool again with page_index: ${safeIndex + 2}`;
    }
    if (nonEmptyItems.length === 0) {
      log(`[TMDBG Tools] calendar_search: page ${safeIndex + 1} produced only blank items (pageItems=${pageItems.length})`);
    }
    log(`[TMDBG Tools] calendar_search: returning page ${safeIndex + 1} of ${totalPages} (daysOnPage=${pageItems.length}, nonEmptyDays=${nonEmptyItems.length})`);
    return result;
  } catch (e) {
    log(`[TMDBG Tools] calendar_search failed: ${e}`, "error");
    return { error: String(e || "unknown error in calendar_search") };
  }
}

async function buildCalendarSummary(args) {
  // Step 1: Get user timezone for consistent normalization
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  log(`[TMDBG CalendarSummary] Using user timezone: ${userTz}`);
  
  // Step 2: Normalize date range inputs
  const { fromIso, toIso } = resolveDateRange(args);
  const normalizedFromDate = normalizeTimeInput(fromIso, userTz);
  const normalizedToDate = normalizeTimeInput(toIso, userTz);
  log(`[TMDBG CalendarSummary] Normalized date range: ${normalizedFromDate.toISOString()} to ${normalizedToDate.toISOString()}`);
  
  const targetCalendars = await resolveTargetCalendars(args);
  log(`[TMDBG CalendarSummary] query calendars=${targetCalendars.length} window=[${fromIso}..${toIso}]`);

  let items = [];
  try {
    items = await browser.tmCalendar.queryCalendarItems(fromIso, toIso, targetCalendars.map(c => c.id));
  } catch (e) {
    log(`[TMDBG CalendarSummary] queryCalendarItems failed: ${e}`, "error");
    return { days: {}, order: [] };
  }
  if (!Array.isArray(items)) items = [];
  
  // Step 3: Normalize ALL calendar items immediately after retrieval
  const normalizedItems = items.map((item, index) => {
    try {
      const normalizedStart = normalizeTimeInput(item.startMs, userTz);
      const normalizedEnd = normalizeTimeInput(item.endMs, userTz);
      const dayKey = makeDayKeyFromNormalized(normalizedStart);
      
      const normalized = {
        ...item,
        normalizedStart,
        normalizedEnd,
        dayKey,
        originalStartMs: item.startMs,
        originalEndMs: item.endMs
      };
      
      log(`[TMDBG CalendarSummary] Item ${index}: ${item.title} -> dayKey=${dayKey} start=${normalizedStart.toISOString()}`);
      return normalized;
    } catch (e) {
      log(`[TMDBG CalendarSummary] Failed to normalize item ${index}: ${e}`, "error");
      return null;
    }
  }).filter(item => item !== null);
  
  log(`[TMDBG CalendarSummary] Normalized ${items.length} raw items -> ${normalizedItems.length} valid items`);
  try {
    const sampleKeys = Object.keys(normalizedItems[0] || {});
    log(`[TMDBG CalendarSummary] Sample normalized item keys: ${sampleKeys.join(",")}`);
  } catch (_) {}

  // Step 4: Optional post-filter by query across multiple fields (use normalized items)
  let filteredItems = normalizedItems;
  try {
    const raw = (args?.query || "").trim();
    if (raw) {
      // Parse quoted phrase and tokens
      let phrase = "";
      try {
        const m = raw.match(/"([^"]+)"/);
        if (m && m[1]) phrase = m[1].trim();
      } catch (_) {}
      let remainder = raw;
      try { remainder = raw.replace(/"[^"]+"/g, " "); } catch (_) {}

      // Replace path-like separators in unquoted remainder with spaces so "a/b" becomes tokens ["a","b"]
      let remainderSanitized = remainder;
      try {
        const before = remainder;
        remainderSanitized = remainder.replace(/[\\\/]+/g, " ");
        if (before !== remainderSanitized) {
          log(`[TMDBG CalendarSummary] sanitized separators in query (slashes->space)`);
        }
      } catch (_) {}

      const terms = remainderSanitized
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const lcPhrase = (phrase || "").toLowerCase();
      const lcTerms = terms.map((t) => t.toLowerCase());
      const hasQuoted = !!lcPhrase;
      try {
        const termsCount = Number(CHAT_SETTINGS.calendarQueryLogTermsPreviewCount) || 5;
        const termsPreview = lcTerms.slice(0, termsCount).join(" | ");
        const slashInTerms = lcTerms.some(t => /[\\\/]/.test(t));
        log(`[TMDBG CalendarSummary] post-filter parse: terms=${lcTerms.length} phrase='${(phrase||'').slice(0,80)}' preview='${termsPreview}' slashInTerms=${slashInTerms}`);
      } catch (_) { log(`[TMDBG CalendarSummary] post-filter parse: terms=${lcTerms.length} phrase='${(phrase||'').slice(0,80)}'`); }

      filteredItems = normalizedItems.filter((it) => {
        try {
          const hay = [
            String(it.title || ""),
            String(it.description || ""),
            String(it.location || ""),
            String(it.organizer || ""),
            String(it.attendeeList || ""),
            String(it.url || ""),
          ]
            .join("\n")
            .toLowerCase();

          // All terms must match (AND)
          for (const t of lcTerms) {
            if (!hay.includes(t)) return false;
          }
          // Optional exact phrase match
          if (hasQuoted && !hay.includes(lcPhrase)) return false;
          return true;
        } catch (_) {
          return false;
        }
      });
      const previewLen = Number(CHAT_SETTINGS.calendarQueryLogPreviewChars) || 120;
      log(`[TMDBG CalendarSummary] post-filter applied raw='${raw.slice(0,previewLen)}' terms=${lcTerms.length} phrase=${hasQuoted} kept=${filteredItems.length}/${normalizedItems.length}`);
    }
  } catch (e) {
    log(`[TMDBG CalendarSummary] post-filter error: ${e}`, "warn");
  }

  // Step 5: Group by day, then by calendar (using pre-normalized data)
  const days = {};
  const order = [];

  // Determine if we should pre-create all days in range or only days with events
  const hasQueryFilter = args?.query && typeof args.query === "string" && args.query.trim().length > 0;
  
  const allDayKeys = new Set();
  
  // If there's a query filter, only include days that have matching events
  // If there's no query, show all days in the range (even if empty)
  if (!hasQueryFilter) {
    log(`[TMDBG CalendarSummary] No query filter - pre-creating all days in range`);
    // Add query range days
    for (let d = new Date(normalizedFromDate); d < normalizedToDate; d.setDate(d.getDate() + 1)) {
      const dayKey = makeDayKeyFromNormalized(new Date(d));
      if (dayKey) {
        allDayKeys.add(dayKey);
      }
    }
  }
  
  // Add days from all filtered items (these are the days with actual matching events)
  for (const it of filteredItems) {
    if (it.dayKey) {
      allDayKeys.add(it.dayKey);
    }
  }
  
  log(`[TMDBG CalendarSummary] hasQueryFilter=${hasQueryFilter} filteredItems=${filteredItems.length} uniqueDays=${allDayKeys.size}`);
  
  // Create day headers for all unique day keys
  const sortedDayKeys = Array.from(allDayKeys).sort();
  for (const dayKey of sortedDayKeys) {
    const dayHeader = formatDayHeader(dayKey, userTz);
    days[dayKey] = dayHeader;
    order.push(dayKey);
    log(`[TMDBG CalendarSummary] PRE-INIT: created day '${dayKey}' -> ${JSON.stringify(dayHeader)}`);
  }
  
  log(`[TMDBG CalendarSummary] PRE-INIT COMPLETE: total days=${Object.keys(days).length}, order=${order.length}`);
  log(`[TMDBG CalendarSummary] PRE-INIT KEYS: ${JSON.stringify(Object.keys(days))}`);
  log(`[TMDBG CalendarSummary] PRE-INIT ORDER: ${JSON.stringify(order)}`);

  // Process items using pre-computed normalized data
  for (const it of filteredItems) {
    try {
      const calId = String(it.calendarId || "");
      const title = it.title || "(No title)";
      const dayKey = it.dayKey; // Already computed during normalization
      
      if (!dayKey) {
        log(`[TMDBG CalendarSummary] SKIPPING ITEM: no dayKey for '${title}'`, "warn");
        continue;
      }
      
      // Only process items that fall within our requested date range
      const requestedDayKeys = new Set();
      for (let d = new Date(normalizedFromDate); d < normalizedToDate; d.setDate(d.getDate() + 1)) {
        const requestedDayKey = makeDayKeyFromNormalized(new Date(d));
        if (requestedDayKey) {
          requestedDayKeys.add(requestedDayKey);
        }
      }
      
      if (!requestedDayKeys.has(dayKey)) {
        log(`[TMDBG CalendarSummary] SKIPPING ITEM: dayKey '${dayKey}' not in requested range`, "warn");
        continue;
      }
      
      log(`[TMDBG CalendarSummary] PROCESSING ITEM: title='${title}' dayKey='${dayKey}' normalizedStart=${it.normalizedStart.toISOString()}`);
      
      const beforeInsert = days[dayKey];
      log(`[TMDBG CalendarSummary] BEFORE INSERT: dayKey='${dayKey}' exists=${!!beforeInsert} type=${typeof beforeInsert}`);
      
      const recurMark = it.isRecurring ? " (↻)" : "";
      const eventId = it.id || "unknown";
      const line = `${formatHour(it.normalizedStart)} - ${formatHour(it.normalizedEnd)}: ${title}${recurMark}\tevent_id: ${eventId}`;
      const result = insertLine(days[dayKey], calId, line);
      days[dayKey] = result;
      
      log(`[TMDBG CalendarSummary] AFTER INSERT: dayKey='${dayKey}' result=${!!result} type=${typeof result}`);
    } catch (e) {
      log(`[TMDBG CalendarSummary] item format error: ${e}`, "warn");
    }
  }

  // Convert structure to printable strings per day
  log(`[TMDBG CalendarSummary] CONVERT TO STRINGS: starting with ${Object.keys(days).length} days`);
  for (const dayKey of Object.keys(days)) {
    log(`[TMDBG CalendarSummary] CONVERT: processing dayKey='${dayKey}'`);
    const d = days[dayKey];
    log(`[TMDBG CalendarSummary] CONVERT: dayKey='${dayKey}' d=${!!d} type=${typeof d} hasCalendars=${!!(d && d.calendars)}`);
    if (!d) {
      log(`[TMDBG CalendarSummary] CONVERT ERROR: dayKey='${dayKey}' d is ${d}`, "error");
      continue;
    }
    if (!d.calendars) {
      log(`[TMDBG CalendarSummary] CONVERT ERROR: dayKey='${dayKey}' d.calendars is ${d.calendars}`, "error");
      continue;
    }
    const calendars = Object.keys(d.calendars).sort((a, b) => a.localeCompare(b));
    const lines = [];
    // For each calendar on this date, print in requested order
    for (const calName of calendars) {
      const entries = d.calendars[calName] || [];
      if (!entries.length) continue; // omit calendars with no entries
      lines.push(`calendar_id: ${calName}`); // calendar id
      lines.push(`date: ${d.prettyDate}`);
      lines.push(`timezone: ${d.timezone}`);
      entries.sort((a, b) => a.localeCompare(b));
      for (const entry of entries) {
        lines.push(entry);
      }
      lines.push("");
    }
    d.payload = lines.join("\n").trim();
    try {
      const calendarsEmitted = calendars.filter(cid => (d.calendars[cid] || []).length > 0);
      log(`[TMDBG CalendarSummary] day='${dayKey}' calendarsEmitted=${calendarsEmitted.length} totalCalendars=${calendars.length}`);
    } catch (_) {}
  }

  const flattened = {};
  for (const k of order) flattened[k] = days[k].payload;
  return { days: flattened, order };
}

function formatDayHeader(dayKey, tz) {
  const [y, m, d] = dayKey.split("-").map(x => Number(x));
  const noonHour = Number(CHAT_SETTINGS.middayHourForDateHeader) || 12;
  const dt = new Date(Date.UTC(y, m - 1, d, noonHour, 0, 0));
  const pretty = dt.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: tz });
  return { timezone: tz, prettyDate: pretty, calendars: {} };
}


function insertLine(dayObj, calName, line) {
  if (!dayObj) return dayObj;
  const map = dayObj.calendars;
  if (!map[calName]) map[calName] = [];
  map[calName].push(line);
  return dayObj;
}

// ensureDate function removed - replaced by normalizeTimeInput

function formatHour(d) {
  try {
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  } catch (_) { return ""; }
}

// makeDayKey function removed - replaced by makeDayKeyFromNormalized

// enumerateDayKeys function removed - replaced by direct date iteration with normalized dates

function resolveDateRange(args) {
  let fromIso;
  let toIso;
  
  // Get user timezone for proper date handling
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  
  if (typeof args.from_date === "string" || typeof args.to_date === "string") {
    // Handle from_date
    if (typeof args.from_date === "string" && args.from_date) {
      // If no time component provided (only date), parse directly to avoid UTC midnight issues
      if (args.from_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        // Date-only format: parse year-month-day directly to create local date
        const [year, month, day] = args.from_date.split("-").map(x => parseInt(x, 10));
        const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
        fromIso = startOfDay.toISOString();
        log(`[TMDBG DateRange] from_date date-only detected: '${args.from_date}' -> parsed as y=${year} m=${month} d=${day} -> ${fromIso}`);
      } else {
        const fromDate = new Date(args.from_date);
        fromIso = fromDate.toISOString();
        log(`[TMDBG DateRange] from_date with time: ${fromIso}`);
      }
    } else {
      fromIso = new Date().toISOString();
    }
    
    // Handle to_date
    if (typeof args.to_date === "string" && args.to_date) {
      // If no time component provided (only date), parse directly to avoid UTC midnight issues
      if (args.to_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        // Date-only format: parse year-month-day directly to create local date at end of day
        const [year, month, day] = args.to_date.split("-").map(x => parseInt(x, 10));
        const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
        toIso = endOfDay.toISOString();
        log(`[TMDBG DateRange] to_date date-only detected: '${args.to_date}' -> parsed as y=${year} m=${month} d=${day} -> ${toIso}`);
      } else {
        const toDate = new Date(args.to_date);
        toIso = toDate.toISOString();
        log(`[TMDBG DateRange] to_date with time: ${toIso}`);
      }
    } else {
      const step = Number(CHAT_SETTINGS.msPerDay) || 86400000;
      const fallbackEnd = new Date(new Date(fromIso).getTime() + step).toISOString();
      toIso = fallbackEnd;
    }
  } else {
    // Default behavior when no dates provided
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const step = Number(CHAT_SETTINGS.msPerDay) || 86400000;
    const end = new Date(start.getTime() + step);
    fromIso = start.toISOString();
    toIso = end.toISOString();
  }
  
  log(`[TMDBG DateRange] resolved range: ${fromIso} to ${toIso}`);
  return { fromIso, toIso };
}

async function resolveTargetCalendars(args) {
  let calendars = [];
  try {
    calendars = await browser.tmCalendar.listCalendars();
  } catch (e) {
    log(`[TMDBG Tools] calendar_search: tmCalendar.listCalendars failed: ${e}`, "error");
    return [];
  }
  const allCalendars = Array.isArray(calendars) ? calendars : [];
  
  log(`[TMDBG Tools] calendar_search: including all calendars; total=${allCalendars.length}`);
  return allCalendars;
}




