// icsParser.js – Defensive ICS → JSON extraction and compact display formatter
// Thunderbird 141+, MV3. No external deps. Best-effort parsing with warnings.

import { log } from "../../agent/modules/utils.js";
import { formatTimestampForAgent } from "./helpers.js";

export const ICS_PARSER_SETTINGS = {
  attendeeDisplayLimit: 5,
  notesBriefMaxChars: 400,
  joinUrlMaxScanChars: 120000,
};

// Minimal Windows → IANA TZID mapping for common zones. Extend as needed.
const WINDOWS_TZ_TO_IANA = {
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "India Standard Time": "Asia/Kolkata",
  "Greenwich Standard Time": "Europe/London",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
};

function safeLog(msg, level) {
  try { log(`[TMDBG ICS] ${msg}`, level); } catch (_) {}
}

function unfoldIcsLines(text) {
  try {
    // Normalize newlines then unfold RFC5545 folded lines (CRLF + space/tab)
    const norm = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = norm.split("\n");
    const out = [];
    for (const line of lines) {
      if ((/^\s/).test(line) && out.length) {
        out[out.length - 1] += line.replace(/^\s/, "");
      } else {
        out.push(line);
      }
    }
    return out.filter(l => l && /:/.test(l));
  } catch (e) {
    safeLog(`unfoldIcsLines failed: ${e}`);
    return [];
  }
}

function parseProperty(line) {
  // NAME;PARAM=VALUE;PARAM2="VALUE":VAL
  try {
    const idx = line.indexOf(":");
    if (idx === -1) return null;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const parts = left.split(";");
    const name = (parts.shift() || "").toUpperCase();
    const params = {};
    for (const p of parts) {
      const eq = p.indexOf("=");
      if (eq === -1) { params[p.toUpperCase()] = ""; continue; }
      const k = p.slice(0, eq).toUpperCase();
      const v = p.slice(eq + 1).replace(/^"|"$/g, "");
      params[k] = v;
    }
    return { name, params, value };
  } catch (e) {
    safeLog(`parseProperty failed for line='${line?.slice(0,120)}': ${e}`, "warn");
    return null;
  }
}

function stripHtmlAndNormalize(html) {
  try {
    const tmp = document.createElement("div");
    tmp.innerHTML = String(html || "");
    const text = tmp.textContent || tmp.innerText || "";
    return text.replace(/\s+/g, " ").trim();
  } catch (_) {
    return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
}

function parseDurationToMs(s) {
  // DURATION like P[n]DT[n]H[n]M[n]S or P[n]W
  try {
    const m = String(s || "").match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
    if (!m) return null;
    const weeks = parseInt(m[1] || "0", 10);
    const days = parseInt(m[2] || "0", 10);
    const hours = parseInt(m[3] || "0", 10);
    const mins = parseInt(m[4] || "0", 10);
    const secs = parseInt(m[5] || "0", 10);
    const ms = (((weeks * 7 + days) * 24 + hours) * 60 + mins) * 60000 + (secs * 1000);
    return ms;
  } catch (_) { return null; }
}

function parseDateTimeBasic(val) {
  // Handles Zulu and local naive forms, and VALUE=DATE (YYYYMMDD)
  // Returns { kind: 'date-time'|'date', utcMs|null, components }
  const s = String(val || "");
  if (/^\d{8}$/.test(s)) {
    const y = parseInt(s.slice(0,4),10);
    const m = parseInt(s.slice(4,6),10);
    const d = parseInt(s.slice(6,8),10);
    const utcMs = Date.UTC(y, m-1, d, 0, 0, 0);
    return { kind: "date", utcMs, components: { y, m, d } };
  }
  const z = /Z$/i.test(s);
  const mOff = s.match(/([\+\-]\d{2})(\d{2})$/);
  if (z) {
    const iso = s.replace(/Z$/i, "Z");
    const d = new Date(iso);
    const ok = !isNaN(d.getTime());
    return { kind: "date-time", utcMs: ok ? d.getTime() : null };
  }
  if (mOff) {
    // Convert +HHMM to +HH:MM for ISO
    const base = s.slice(0, s.length - 5);
    const sign = mOff[1][0];
    const hh = mOff[1].slice(1);
    const mm = mOff[2];
    const iso = `${base}${sign}${hh}:${mm}`;
    const d = new Date(iso);
    const ok = !isNaN(d.getTime());
    return { kind: "date-time", utcMs: ok ? d.getTime() : null };
  }
  // Naive local time (no zone info). Will need TZID to resolve.
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (m) {
    const y = parseInt(m[1],10), mon = parseInt(m[2],10), d = parseInt(m[3],10);
    const hh = parseInt(m[4],10), mi = parseInt(m[5],10), ss = parseInt(m[6],10);
    return { kind: "date-time", utcMs: null, components: { y, mon, d, hh, mi, ss } };
  }
  return { kind: "date-time", utcMs: null };
}

function tryMapTzid(tzid, warnings) {
  if (!tzid) return { tzidRaw: "", tzidMapped: null };
  const raw = String(tzid);
  if (/\//.test(raw)) return { tzidRaw: raw, tzidMapped: raw };
  const mapped = WINDOWS_TZ_TO_IANA[raw] || null;
  if (mapped) {
    warnings.push(`Non-IANA TZID '${raw}' mapped to '${mapped}'`);
  } else {
    warnings.push(`Unknown TZID '${raw}' – unable to map to IANA`);
  }
  return { tzidRaw: raw, tzidMapped: mapped };
}

function offsetMinutesForZoneAt(timeZone, utcMs) {
  // Requires ICU support for shortOffset. If unavailable, throw to caller.
  const d = new Date(utcMs);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = fmt.formatToParts(d);
  const tzp = parts.find(p => p.type === "timeZoneName");
  const name = tzp?.value || ""; // e.g., GMT-4 or UTC+01:00
  const m = name.match(/([\+\-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) throw new Error(`shortOffset parse failed for '${name}'`);
  const sign = m[1] === "-" ? -1 : 1;
  const hh = parseInt(m[2] || "0", 10);
  const mm = parseInt(m[3] || "0", 10);
  return sign * (hh * 60 + mm);
}

function wallTimeInZoneToUtcMs(components, timeZone) {
  // Fixed-point iteration: U = wallUTC - offset(zone, U)
  // components: { y, mon, d, hh, mi, ss }
  const baseUtc = Date.UTC(components.y, components.mon - 1, components.d, components.hh || 0, components.mi || 0, components.ss || 0);
  let guess = baseUtc;
  for (let i = 0; i < 3; i += 1) {
    const off = offsetMinutesForZoneAt(timeZone, guess);
    const next = baseUtc - off * 60000;
    if (Math.abs(next - guess) < 1000) return next;
    guess = next;
  }
  return guess;
}

function findJoinUrl(text) {
  try {
    const src = String(text || "").slice(0, ICS_PARSER_SETTINGS.joinUrlMaxScanChars);
    const re = /(https?:\/\/[^\s"']*(?:zoom\.(?:us|com)|teams\.microsoft|teams\.live|meet\.google|webex\.com|gotomeeting|whereby\.com|bluejeans\.com)[^\s"']*)/i;
    const m = src.match(re);
    if (m) return m[1];
    const soft = src.match(/https?:\/\/[^\s"']+/i);
    return soft ? soft[0] : "";
  } catch (_) { return ""; }
}

function parseMailto(uri) {
  try {
    // mailto:foo@example.com
    const s = String(uri || "");
    if (/^mailto:/i.test(s)) return s.replace(/^mailto:/i, "");
    return s;
  } catch (_) { return String(uri || ""); }
}

function normalizePerson(params, value) {
  const email = parseMailto(value || "");
  const name = params?.CN ? params.CN : "";
  return { name, email };
}

export function parseIcsToEvents(icsText, icsFilename = "") {
  const warnings = [];
  const lines = unfoldIcsLines(icsText);
  const top = {};
  const events = [];

  let current = null;
  for (const raw of lines) {
    const prop = parseProperty(raw);
    if (!prop) continue;
    const { name, params, value } = prop;
    if (name === "BEGIN" && value === "VEVENT") {
      current = { __params: {}, attendees: [], parse_warnings: [], source: { ics_filename: icsFilename, prodid: top.PRODID || "", method: top.METHOD || "" } };
      continue;
    }
    if (name === "END" && value === "VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) {
      // top-level metadata
      if (name === "PRODID") top.PRODID = value;
      if (name === "METHOD") top.METHOD = value;
      continue;
    }
    // Capture fields of interest on current event
    switch (name) {
      case "UID": current.uid = value; break;
      case "SUMMARY": current.title = (value || "").trim(); if (params?.LANGUAGE) current.language = params.LANGUAGE; break;
      case "LOCATION": current.location = (value || "").trim(); break;
      case "DESCRIPTION": current.__desc = value; if (params?.LANGUAGE) current.language = params.LANGUAGE; break;
      case "X-ALT-DESC": current.__desc_alt = value; break;
      case "DTSTART": current.__dtstart = { value, params }; break;
      case "DTEND": current.__dtend = { value, params }; break;
      case "DURATION": current.__duration = value; break;
      case "ORGANIZER": current.organizer = normalizePerson(params, value); break;
      case "ATTENDEE": current.attendees.push(normalizePerson(params, value)); break;
      default: break;
    }
  }

  // Normalize each event
  const out = [];
  for (const ev of events) {
    const evWarnings = [];
    const srcProdid = top.PRODID || "";
    const srcMethod = top.METHOD || "";
    // Description and notes
    let rawNotes = ev.__desc_alt || ev.__desc || "";
    let notesBrief = stripHtmlAndNormalize(rawNotes);
    if (notesBrief.length > ICS_PARSER_SETTINGS.notesBriefMaxChars) {
      notesBrief = notesBrief.slice(0, ICS_PARSER_SETTINGS.notesBriefMaxChars).trim();
      evWarnings.push("HTML body truncated");
    }

    // Join URL
    const joinUrl = findJoinUrl(rawNotes || ev.location || "");
    if (!joinUrl) evWarnings.push("No join URL found");

    // DTSTART/DTEND and TZ
    let tzidRaw = "";
    let tzidMapped = null;
    let startUtcMs = null;
    let endUtcMs = null;
    let userTz = "";
    try { userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) { userTz = ""; }

    // DTSTART
    if (ev.__dtstart) {
      tzidRaw = ev.__dtstart.params?.TZID || "";
      const m = tryMapTzid(tzidRaw, evWarnings);
      tzidMapped = m.tzidMapped;
      const p = parseDateTimeBasic(ev.__dtstart.value);
      if (p.utcMs !== null) {
        startUtcMs = p.utcMs;
      } else if (p.components && tzidMapped) {
        try {
          startUtcMs = wallTimeInZoneToUtcMs({ y: p.components.y, mon: p.components.mon, d: p.components.d, hh: p.components.hh, mi: p.components.mi, ss: p.components.ss }, tzidMapped);
        } catch (e) {
          evWarnings.push(`Failed to resolve TZ '${tzidMapped}' for DTSTART`);
        }
      } else if (p.components && !tzidMapped && tzidRaw) {
        evWarnings.push("TZID present but not mappable; cannot resolve DTSTART");
      }
    }

    // DTEND or DURATION
    if (ev.__dtend) {
      const p = parseDateTimeBasic(ev.__dtend.value);
      if (p.utcMs !== null) {
        endUtcMs = p.utcMs;
      } else if (p.components && tzidMapped) {
        try {
          endUtcMs = wallTimeInZoneToUtcMs({ y: p.components.y, mon: p.components.mon, d: p.components.d, hh: p.components.hh, mi: p.components.mi, ss: p.components.ss }, tzidMapped);
        } catch (e) {
          evWarnings.push(`Failed to resolve TZ '${tzidMapped}' for DTEND`);
        }
      } else if (p.components && !tzidMapped && tzidRaw) {
        evWarnings.push("TZID present but not mappable; cannot resolve DTEND");
      }
    }
    if (!endUtcMs && ev.__duration && startUtcMs) {
      const ms = parseDurationToMs(ev.__duration);
      if (ms !== null) {
        endUtcMs = startUtcMs + ms;
        evWarnings.push("DTEND missing; computed from DURATION");
      }
    }

    let durationMinutes = 0;
    if (startUtcMs !== null && endUtcMs !== null) {
      durationMinutes = Math.max(0, Math.round((endUtcMs - startUtcMs) / 60000));
    }

    // Organizer
    const organizer = ev.organizer || { name: "", email: "" };

    // Attendees (truncate)
    const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
    const attendeesTrunc = attendees.slice(0, ICS_PARSER_SETTINGS.attendeeDisplayLimit);
    const attendeesMoreCount = Math.max(0, attendees.length - attendeesTrunc.length);

    const eventOut = {
      uid: ev.uid || "",
      title: ev.title || "",
      start: {
        tzid_raw: tzidRaw || "",
        tzid_mapped: tzidMapped || null,
        start_local: startUtcMs !== null ? formatTimestampForAgent(new Date(startUtcMs)) : "",
        start_utc: startUtcMs !== null ? new Date(startUtcMs).toISOString() : "",
      },
      end: {
        end_local: endUtcMs !== null ? formatTimestampForAgent(new Date(endUtcMs)) : "",
        end_utc: endUtcMs !== null ? new Date(endUtcMs).toISOString() : "",
      },
      duration_minutes: durationMinutes,
      user_local: {
        tzid: userTz || "",
        start_local: startUtcMs !== null ? formatTimestampForAgent(new Date(startUtcMs)) : "",
        end_local: endUtcMs !== null ? formatTimestampForAgent(new Date(endUtcMs)) : "",
      },
      location: ev.location || "",
      join_url: joinUrl || "",
      organizer: { name: organizer.name || "", email: organizer.email || "" },
      attendees_truncated: attendeesTrunc.map(a => ({ name: a.name || "", email: a.email || "" })),
      attendees_more_count: attendeesMoreCount,
      language: ev.language || "",
      notes_brief: notesBrief || "",
      source: { ics_filename: icsFilename || "", prodid: srcProdid, method: srcMethod },
      parse_warnings: [...warnings, ...evWarnings],
    };

    out.push(eventOut);
  }

  safeLog(`Parsed ICS into ${out.length} event(s)`);
  return out;
}

export function formatEventsForDisplay(events) {
  const lines = [];
  const list = Array.isArray(events) ? events : [];
  list.forEach((ev, idx) => {
    try {
      lines.push(`Event ${idx + 1}: ${ev.title || "(No title)"}`);
      if (ev.start?.start_local) lines.push(`When: ${ev.start.start_local}${ev.end?.end_local ? ` → ${ev.end.end_local}` : ""}`);
      if (Number.isFinite(ev.duration_minutes)) lines.push(`Duration: ${ev.duration_minutes} minutes`);
      if (ev.location) lines.push(`Location: ${ev.location}`);
      if (ev.join_url) lines.push(`Join: ${ev.join_url}`);
      if (ev.organizer?.email || ev.organizer?.name) {
        const org = [ev.organizer.name, ev.organizer.email].filter(Boolean).join(" ");
        lines.push(`Organizer: ${org}`);
      }
      if (Array.isArray(ev.attendees_truncated) && ev.attendees_truncated.length) {
        const att = ev.attendees_truncated.map(a => {
          const name = a.name || "";
          const email = String(a.email || "").replace(/^mailto:/i, "").trim();
          if (name && email) {
            return `${name} <${email}>`;
          } else if (email) {
            return `<${email}>`;
          } else if (name) {
            return name;
          }
          return "";
        }).filter(Boolean).join(", ");
        const more = ev.attendees_more_count ? ` (+${ev.attendees_more_count} more)` : "";
        lines.push(`Attendees: ${att}${more}`);
      }
      if (ev.source?.method || ev.source?.prodid || ev.source?.ics_filename) {
        const srcBits = [];
        if (ev.source.method) srcBits.push(`method=${ev.source.method}`);
        if (ev.source.prodid) srcBits.push(`prodid=${ev.source.prodid}`);
        if (ev.source.ics_filename) srcBits.push(`file=${ev.source.ics_filename}`);
        if (srcBits.length) lines.push(`Source: ${srcBits.join(" ")}`);
      }
      if (Array.isArray(ev.parse_warnings) && ev.parse_warnings.length) {
        lines.push(`Parse warnings: ${ev.parse_warnings.join("; ")}`);
      }
      // Spacer between events
      if (idx < list.length - 1) lines.push("");
    } catch (e) {
      safeLog(`formatEventsForDisplay failed: ${e}`, "warn");
    }
  });
  return lines.join("\n");
}


// Helper function to extract and format ICS attachments as compact string
// This can be reused by FTS indexing to store parsed data
export function formatIcsAttachmentsAsString(icsAttachments) {
  if (!icsAttachments || !Array.isArray(icsAttachments) || icsAttachments.length === 0) {
    return "";
  }
  
  const lines = [];
  lines.push("ICS Attachments (parsed):");
  
  icsAttachments.forEach((att, idx) => {
    try {
      lines.push(`ICS[${idx + 1}] filename='${att.filename || ""}' contentType='${att.contentType || ""}' part='${att.partName || ""}'`);
      const events = parseIcsToEvents(att.text || "", att.filename || "");
      
      if (Array.isArray(events) && events.length) {
        const display = formatEventsForDisplay(events);
        if (display && display.trim()) lines.push(display);
        // Also include compact JSON for downstream reasoning in a single line per event
        events.forEach((ev, eIdx) => {
          try {
            const compact = JSON.stringify(ev);
            lines.push(`ICS_JSON[${idx + 1}.${eIdx + 1}]: ${compact}`);
          } catch (_) {}
        });
      } else {
        lines.push("(No events parsed)");
      }
    } catch (e) {
      log(`[icsParser] formatIcsAttachmentsAsString: ICS parse failure for part='${att.partName || ''}': ${e}`, "warn");
      lines.push("(Failed to parse ICS)");
    }
  });
  
  return lines.join("\n");
}


// Recursively scans message parts for ICS attachments and returns their text content
export async function extractIcsFromParts(root, messageId) {
  const results = [];

  const headerFirst = (headers, key) => {
    if (!headers) return "";
    return headers[key]?.[0] || headers[key.toUpperCase()]?.[0] || "";
  };

  const getHeaderFilename = (headers) => {
    const cd = headerFirst(headers, "content-disposition");
    const matchCd = cd && cd.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (matchCd && matchCd[1]) return matchCd[1];
    const ct = headerFirst(headers, "content-type");
    const matchCt = ct && ct.match(/name\s*=\s*"?([^";]+)"?/i);
    if (matchCt && matchCt[1]) return matchCt[1];
    return "";
  };

  const isIcsLike = (part) => {
    const ct = (part?.contentType || "").toLowerCase();
    if (ct.includes("text/calendar")) return true;
    // Some providers use generic types but with .ics filename
    const name = (part?.name || getHeaderFilename(part?.headers) || "").toLowerCase();
    if (name.endsWith(".ics")) return true;
    // Also check headers' content-type parameter
    const hct = headerFirst(part?.headers, "content-type");
    if (hct && /text\/calendar/i.test(hct)) return true;
    return false;
  };

  const collect = async (parts) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      try {
        if (isIcsLike(part)) {
          const partName = part?.partName || "";
          const filename = part?.name || getHeaderFilename(part?.headers) || "";
          const contentType = part?.contentType || headerFirst(part?.headers, "content-type") || "";
          let text = "";

          if (typeof part?.body === "string" && part.body.length > 0) {
            text = part.body;
            try { log(`[icsParser] ICS inline body part='${partName}' filename='${filename}' len=${text.length}`); } catch (_) {}
          } else if (messageId && partName) {
            try {
              const file = await browser.messages.getAttachmentFile(messageId, partName);
              text = await file.text();
              try { log(`[icsParser] ICS fetched via attachment file part='${partName}' filename='${filename}' len=${text.length}`); } catch (_) {}
            } catch (e) {
              log(`[icsParser] failed to fetch ICS attachment for part='${partName}': ${e}`);
            }
          }

          results.push({ filename, contentType, partName, text });
        }
      } catch (e) {
        log(`[icsParser] error scanning part for ICS: ${e}`);
      }

      if (Array.isArray(part?.parts) && part.parts.length > 0) {
        await collect(part.parts);
      }
    }
  };

  try {
    const topParts = Array.isArray(root?.parts) ? root.parts : [];
    // try { log(`[icsParser] starting ICS scan parts=${topParts.length}`); } catch (_) {}
    await collect(topParts);
  } catch (e) {
    log(`[icsParser] ICS scan failed: ${e}`);
  }

  return results;
}
