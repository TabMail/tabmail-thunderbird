/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendar_event_create.js – creates a calendar event (FSM tool)

// FSM tool — requires user confirmation before executing.
// `fsm = true` lets core.js classify this tool as FSM (multi-step / confirmation-required).
export const fsm = true;

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { toNaiveIso, toIsoNoMs } from "../modules/helpers.js";
import { recurrenceArgError } from "../modules/recurrence.js";
import { toShownIso, wallClockAt } from "../modules/repeatedHour.js";

function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};
  
  // Include all valid string properties (schema allows empty strings)
  if (typeof a.title === "string") out.title = a.title;
  // Normalize ISO strings to naive format (remove timezone offsets); a time
  // given with a timezone keeps its digits, that zone's wall clock.
  const zone = typeof a.timezone === "string" && a.timezone ? a.timezone : undefined;
  if (typeof a.start_iso === "string") out.start_iso = toNaiveIso(a.start_iso, zone);
  if (typeof a.end_iso === "string") out.end_iso = toNaiveIso(a.end_iso, zone);
  if (typeof a.location === "string") out.location = a.location;
  if (typeof a.description === "string") out.description = a.description;
  if (typeof a.calendar_id === "string") out.calendar_id = a.calendar_id;
  if (typeof a.transparency === "string") {
    const t = a.transparency.toLowerCase();
    if (t === "busy" || t === "free") out.transparency = t;
  }
  
  // Include boolean properties
  if (typeof a.all_day === "boolean") out.all_day = a.all_day;
  if (typeof a.send_invitations === "boolean") out.send_invitations = a.send_invitations;
  
  // Attendees array (include even if empty since it's a valid state)
  if (Array.isArray(a.attendees)) {
    out.attendees = a.attendees.filter(Boolean).map((p) => ({
      email: typeof p?.email === "string" ? p.email : (typeof p === "string" ? p : ""),
      name: typeof p?.name === "string" ? p.name : "",
    }));
  }
  
  // Only include organizer property if it has actual value
  if (typeof a.organizer_email === "string" && a.organizer_email) {
    out.organizer_email = a.organizer_email;
  }
  
  // Recurrence (pass-through; checked by recurrenceArgError before the card).
  if (a && a.recurrence !== undefined && a.recurrence !== null) {
    out.recurrence = a.recurrence;
  }

  // Timezone override (IANA identifier)
  if (typeof a.timezone === "string" && a.timezone) out.timezone = a.timezone;

  return out;
}

/**
 * Resolve the user's preferred default event duration (Options →
 * Calendar Settings). Falls back to the compile-time setting when the user
 * hasn't customized it. Range-clamped so a stray storage value can't yield
 * zero-length or absurdly long events.
 */
async function getDefaultEventDurationMinutes() {
  const fallback = Number(CHAT_SETTINGS.createEventDefaultDurationMinutes) || 45;
  try {
    const { defaultEventDurationMinutes } = await browser.storage.local.get({
      defaultEventDurationMinutes: null,
    });
    const n = Number(defaultEventDurationMinutes);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.max(Math.round(n), 5), 12 * 60);
  } catch (_) {
    return fallback;
  }
}

const MINUTE_MS = 60 * 1000;
// Wider than any clock change (an hour or two), narrower than the time
// between two changes of one zone.
const DAY_MS = 24 * 60 * MINUTE_MS;
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

// The instant Thunderbird's calendar stores a naive start at: its digits
// placed in `zone`, or with no zone on the user's clock (the bridge's
// toCalIDateTime, after toNaiveIso has read a bare start there), as ical.js
// places them (Timezone.utcOffset): a time the clocks repeat is the second
// pass, a time they skip takes the offset after the change. Offsets from
// repeatedHour's wallClockAt, the clock the tools print times on.
function instantOfWallClockInZone(naive, zone) {
  const wallMs = Date.parse(`${naive}Z`);
  const offsetMs = (utcMs) => wallClockAt(utcMs, zone).offsetMinutes * MINUTE_MS;
  const after = offsetMs(wallMs + DAY_MS);
  const before = offsetMs(wallMs - DAY_MS);
  const holds = (offset) => offsetMs(wallMs - offset) === offset;
  return wallMs - (holds(after) || !holds(before) ? after : before);
}

async function ensureTimes(details) {
  let { start_iso, end_iso, all_day } = details;
  try {
    if (!start_iso) {
      const now = new Date();
      start_iso = toIsoNoMs(now);
    }
    if (!end_iso && !all_day) {
      const minutes = await getDefaultEventDurationMinutes();
      // A given start is a wall clock, in the named zone or on the user's
      // clock (normalizeArgs); its end is the default length after the start
      // as the calendar stores it (#393), on the same clock, printed as the
      // tools print a time: in the hour the clocks repeat, with its UTC
      // offset, which the bridge reads as that exact moment. The current time
      // (no start given) is an instant.
      if (NAIVE_ISO.test(start_iso)) {
        end_iso = toShownIso(instantOfWallClockInZone(start_iso, details.timezone) + minutes * MINUTE_MS, details.timezone);
      } else {
        end_iso = toIsoNoMs(new Date(new Date(start_iso).getTime() + minutes * MINUTE_MS));
      }
      log(`[TMDBG Tools] calendar_event_create: default end ${end_iso} (${minutes} min after ${start_iso}${details.timezone ? ` in ${details.timezone}` : ""})`);
    }
  } catch (_) {}
  return { ...details, start_iso, end_iso };
}

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] calendar_event_create: Tool called with args: ${JSON.stringify(args)}`);

    // Immediately schedule the actual routine to the next frame to let WS set up the waiter
    try {
      requestAnimationFrame(() => {
        _runCreateCalendarEvent(args, options).catch((e) => {
          try { log(`[TMDBG Tools] calendar_event_create scheduled run failed: ${e}`, "error"); } catch (_) {}
        });
      });
      log(`[TMDBG Tools] calendar_event_create: scheduled _runCreateCalendarEvent for next frame`);
    } catch (e) {
      log(`[TMDBG Tools] calendar_event_create: failed to schedule _runCreateCalendarEvent: ${e}`, "error");
    }

    // Inform WS layer this is an FSM tool
    const pid = options && typeof options.callId === "string" ? options.callId : options.callId || null;
    return { fsm: true, tool: "calendar_event_create", pid, startedAt: Date.now() };
  } catch (e) {
    log(`[TMDBG Tools] calendar_event_create failed: ${e}`, "error");
    return { error: String(e || "unknown error in calendar_event_create") };
  }
}

async function _runCreateCalendarEvent(args = {}, options = {}) {
  // Mark FSM context using MCP tool call id when available - do this FIRST
  try { ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null; } catch (_) {}
  
  // Set tool execution mode early so FSM knows which tool is running
  ctx.toolExecutionMode = "calendar_event_create";
  
  // Initialize FSM session early so we can set failReason if needed
  const pid = ctx.activeToolCallId || 0;
  try {
    if (pid) {
      initFsmSession(pid, "calendar_event_create");
      log(`[TMDBG Tools] calendar_event_create: Initialized FSM session with system prompt for pid=${pid}`);
      ctx.activePid = pid;
      ctx.awaitingPid = pid;
    }
  } catch (_) {}
  
  // Validation of bridge and arguments
  if (!browser?.tmCalendar?.createCalendarEvent) {
    const errorMsg = "Calendar bridge not available";
    log(`[TMDBG Tools] calendar_event_create: ${errorMsg}`, "error");
    try {
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].failReason = errorMsg;
      }
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }

  const read = normalizeArgs(args);
  const badDate = ["start_iso", "end_iso"].find((f) => typeof args?.[f] === "string" && args[f].trim() && !read[f]);
  const norm = await ensureTimes(read);

  // A date the tool cannot read, or a rule it cannot write, is refused before
  // the confirmation card, so the model can correct it instead of the date
  // being guessed or a part being silently dropped.
  // (toNaiveIso gives null for a date it cannot read.)
  const recurrenceError = badDate
    ? `${badDate} "${args[badDate]}" is not a date and time the calendar can read. Use YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD for a date, then retry.`
    : ("recurrence" in norm ? recurrenceArgError(norm.recurrence, { canClear: false }) : null);
  if (recurrenceError) {
    log(`[TMDBG Tools] calendar_event_create: ${recurrenceError}`, "error");
    try {
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].failReason = recurrenceError;
      }
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }

  // If no calendar_id provided, try to use the default calendar
  if (!norm.calendar_id) {
    try {
      const { defaultCalendarId } = await browser.storage.local.get({ defaultCalendarId: null });
      if (defaultCalendarId) {
        norm.calendar_id = defaultCalendarId;
        log(`[TMDBG Tools] calendar_event_create: using default calendar: ${defaultCalendarId}`);
      } else {
        const errorMsg = "No calendar_id provided and no default calendar set";
        log(`[TMDBG Tools] calendar_event_create: ${errorMsg}`, "error");
        try {
          if (pid && ctx.fsmSessions[pid]) {
            ctx.fsmSessions[pid].failReason = errorMsg;
          }
        } catch (_) {}
        ctx.state = "exec_fail";
        const core = await import("../fsm/core.js");
        await core.executeAgentAction();
        return;
      }
    } catch (e) {
      const errorMsg = "Failed to get default calendar";
      log(`[TMDBG Tools] calendar_event_create: ${errorMsg}`, "error");
      try {
        if (pid && ctx.fsmSessions[pid]) {
          ctx.fsmSessions[pid].failReason = errorMsg;
        }
      } catch (_) {}
      ctx.state = "exec_fail";
      const core = await import("../fsm/core.js");
      await core.executeAgentAction();
      return;
    }
  }

  // An all-day end the bridge would refuse (on or before the start) is refused
  // here, before the confirmation card, so the assistant can correct the
  // call. The bridge reads the times as the create will and writes nothing
  // (check_only), so the rule lives in one place. A refusal the bridge returns
  // fails the call here, before the card; a check call that throws (rejects)
  // is not a refusal and the create goes on to the card, where the write
  // itself still refuses such an end.
  if (norm.all_day && norm.end_iso) {
    let check = null;
    try {
      check = await browser.tmCalendar.createCalendarEvent({
        calendar_id: norm.calendar_id, start_iso: norm.start_iso, end_iso: norm.end_iso, all_day: true,
        ...(norm.timezone ? { timezone: norm.timezone } : {}), check_only: true,
      });
    } catch (e) {
      log(`[TMDBG Tools] calendar_event_create: pre-card check failed to run: ${e}`, "warn");
    }
    if (check && check.ok === false) {
      const errorMsg = String(check.error || "the calendar refused this event");
      log(`[TMDBG Tools] calendar_event_create: ${errorMsg}`, "error");
      try {
        if (pid && ctx.fsmSessions[pid]) {
          ctx.fsmSessions[pid].failReason = errorMsg;
        }
      } catch (_) {}
      ctx.state = "exec_fail";
      const core = await import("../fsm/core.js");
      await core.executeAgentAction();
      return;
    }
  }

  // Auto-extract organizer email from calendar if not provided
  if (!norm.organizer_email && norm.calendar_id) {
    try {
      const calendarInfo = await browser.tmCalendar.getCalendars();
      if (calendarInfo?.ok && calendarInfo.calendars) {
        const targetCalendar = calendarInfo.calendars.find(cal => cal.id === norm.calendar_id);
        if (targetCalendar?.organizer_email) {
          norm.organizer_email = targetCalendar.organizer_email;
          log(`[TMDBG Tools] calendar_event_create: auto-extracted organizer email: ${norm.organizer_email}`);
        }
      }
    } catch (e) {
      log(`[TMDBG Tools] calendar_event_create: failed to auto-extract organizer email: ${e}`, "warn");
    }
  }

  // Store normalized args in FSM session
  try {
    if (pid && ctx.fsmSessions[pid]) {
      ctx.fsmSessions[pid].createEventArgs = norm;
    }
  } catch (_) {}

  // Enter FSM state
  ctx.state = "calendar_event_create_list";

  // Record that we entered the initial FSM state for this tool in session history
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    if (pid) {
      ctx.fsmSessions[pid].fsmPrevState = "calendar_event_create_list";
    }
  } catch (_) {}

  // Establish FSM marker in chat history IMMEDIATELY
  const originalRequest = ctx.rawUserTexts[ctx.rawUserTexts.length - 1] || "";
  const fakeUserText = `Now help me create a calendar event according to my earlier request: ${originalRequest}`;
  ctx.rawUserTexts.push(fakeUserText);
  log(`[TMDBG Tools] calendar_event_create: Established FSM marker in chat history`);

  // Use the agent bubble from tool orchestration
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(`[TMDBG Tools] calendar_event_create: No agent bubble provided, creating fallback`, "warn");
    agentBubble = await createNewAgentBubble("Preparing event details...");
  }

  // Kick off FSM immediately now that waiter should be registered
  const core = await import("../fsm/core.js");
  await core.executeAgentAction();
}

export function resetPaginationSessions() {}

// FSM tool completion handler – returns structured result with event details
export async function completeExecution(currentState, prevState) {
  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid && ctx.fsmSessions && ctx.fsmSessions[pid] ? ctx.fsmSessions[pid] : null;
  const failReason = sess?.failReason || "";
  
  if (failReason) {
    log(`[TMDBG Tools] calendar_event_create.completeExecution: failed – ${failReason}`);
    return { error: failReason };
  }
  
  if (prevState === "calendar_event_create_exec" && sess?.createResult) {
    log(`[TMDBG Tools] calendar_event_create.completeExecution: created event successfully`);
    return {
      result: "Calendar event created successfully.",
      event_id: sess.createResult.event_id,
      event_title: sess.createResult.event_title,
      calendar_id: sess.createResult.calendar_id,
      invitations: sess.createResult.invitations,
      ...(sess.createResult.guest_notice ? { guest_notice: sess.createResult.guest_notice } : {}),
    };
  }
  
  log(`[TMDBG Tools] calendar_event_create.completeExecution: completed`);
  return { result: "Create workflow completed." };
}


