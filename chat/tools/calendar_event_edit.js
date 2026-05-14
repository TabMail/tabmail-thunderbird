// calendar_event_edit.js – edits an existing calendar event (FSM tool)

// FSM tool — requires user confirmation before executing.
// `fsm = true` lets core.js classify this tool as FSM (multi-step / confirmation-required).
export const fsm = true;

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { toNaiveIso } from "../modules/helpers.js";

function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};
  
  // event_id is required for edit operations
  if (typeof a.event_id === "string" && a.event_id) out.event_id = a.event_id;
  
  // calendar_id is OPTIONAL — provided as a hint for faster lookup. When omitted,
  // the tmCalendar bridge auto-scans every calendar to find the event_id.
  if (typeof a.calendar_id === "string" && a.calendar_id) out.calendar_id = a.calendar_id;
  
  // recurrence_id — the start datetime of a specific occurrence (RECURRENCE-ID).
  // Required when edit_scope is "this_only" or "this_and_following".
  if (typeof a.recurrence_id === "string" && a.recurrence_id) out.recurrence_id = toNaiveIso(a.recurrence_id);

  // edit_scope (v1.5.21+) — "all" | "this_only" | "this_and_following".
  // Normalize to the supported set; default is inferred at exec time (see calendarEdit.js).
  if (typeof a.edit_scope === "string") {
    const s = a.edit_scope.toLowerCase().trim();
    if (s === "all" || s === "this_only" || s === "this_and_following") {
      out.edit_scope = s;
    }
  }
  
  // Only include properties that have meaningful values
  if (typeof a.title === "string" && a.title) out.title = a.title;
  // Normalize ISO strings to naive format (remove timezone offsets)
  if (typeof a.start_iso === "string" && a.start_iso) out.start_iso = toNaiveIso(a.start_iso);
  if (typeof a.end_iso === "string" && a.end_iso) out.end_iso = toNaiveIso(a.end_iso);
  if (typeof a.all_day === "boolean") out.all_day = a.all_day;
  if (typeof a.location === "string" && a.location) out.location = a.location;
  if (typeof a.description === "string" && a.description) out.description = a.description;
  if (typeof a.transparency === "string") {
    const t = a.transparency.toLowerCase();
    if (t === "busy" || t === "free") out.transparency = t;
  }
  
  // Attendees are delta-based (calendar_event_edit-v1.5.21+):
  //   add_attendees: [{email, name?}] — appended to existing list
  //   remove_attendees: [{email}]   — dropped from existing list ("*" = clear all)
  // The FSM exec state resolves these against the event's current attendee list and
  // produces the flat `attendees` payload that browser.tmCalendar.modifyCalendarEvent
  // expects. Legacy whole-list `attendees` is intentionally NOT accepted here; the
  // backend version-pins older clients to the v1.5.7 schema instead.
  if (Array.isArray(a.add_attendees)) {
    out.add_attendees = a.add_attendees
      .filter(Boolean)
      .map((p) => ({
        email: typeof p?.email === "string"
          ? p.email
          : (typeof p === "string" ? p : ""),
        name: typeof p?.name === "string" ? p.name : "",
      }))
      .filter((p) => p.email && p.email !== "*");
  }
  if (Array.isArray(a.remove_attendees)) {
    out.remove_attendees = a.remove_attendees
      .filter(Boolean)
      .map((p) => ({
        email: typeof p?.email === "string"
          ? p.email
          : (typeof p === "string" ? p : ""),
      }))
      .filter((p) => p.email);
  }
  
  // Include invitation properties
  if (typeof a.send_invitations === "boolean") {
    out.send_invitations = a.send_invitations;
  }
  if (typeof a.organizer_email === "string" && a.organizer_email) {
    out.organizer_email = a.organizer_email;
  }
  
  // Recurrence (pass-through object if provided)
  if (a && typeof a.recurrence === "object") {
    out.recurrence = a.recurrence;
  }
  
  // EXDATE additions (exclude specific occurrences)
  if (Array.isArray(a.exdates_add)) {
    out.exdates_add = a.exdates_add.filter(Boolean).map((v) => String(v));
  }

  // Timezone override (IANA identifier)
  if (typeof a.timezone === "string" && a.timezone) out.timezone = a.timezone;

  return out;
}

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] calendar_event_edit: Tool called with args: ${JSON.stringify(args)}`);

    // Immediately schedule the actual routine to the next frame to let WS set up the waiter
    try {
      requestAnimationFrame(() => {
        _runEditCalendarEvent(args, options).catch((e) => {
          try { log(`[TMDBG Tools] calendar_event_edit scheduled run failed: ${e}`, "error"); } catch (_) {}
        });
      });
      log(`[TMDBG Tools] calendar_event_edit: scheduled _runEditCalendarEvent for next frame`);
    } catch (e) {
      log(`[TMDBG Tools] calendar_event_edit: failed to schedule _runEditCalendarEvent: ${e}`, "error");
    }

    // Inform WS layer this is an FSM tool
    const pid = options && typeof options.callId === "string" ? options.callId : options.callId || null;
    return { fsm: true, tool: "calendar_event_edit", pid, startedAt: Date.now() };
  } catch (e) {
    log(`[TMDBG Tools] calendar_event_edit failed: ${e}`, "error");
    return { error: String(e || "unknown error in calendar_event_edit") };
  }
}

async function _runEditCalendarEvent(args = {}, options = {}) {
  // Mark FSM context + init the session BEFORE validation so any early-return
  // failure path can set failReason and drive `exec_fail` — otherwise the
  // converse-side waiter at converse.js:655 sits forever (see
  // CalendarEditStuckBug). Mirrors calendar_event_create's structure.
  try { ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null; } catch (_) {}
  ctx.toolExecutionMode = "calendar_event_edit";
  const pid = ctx.activeToolCallId || 0;
  try {
    if (pid) {
      initFsmSession(pid, "calendar_event_edit");
      log(`[TMDBG Tools] calendar_event_edit: Initialized FSM session with system prompt for pid=${pid}`);
      ctx.activePid = pid;
      ctx.awaitingPid = pid;
    }
  } catch (_) {}

  const failOut = async (reason) => {
    log(`[TMDBG Tools] calendar_event_edit: ${reason}`, "error");
    try {
      if (pid && ctx.fsmSessions[pid]) ctx.fsmSessions[pid].failReason = reason;
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
  };

  // Validation of bridge and arguments
  if (!browser?.tmCalendar?.modifyCalendarEvent) {
    await failOut("Calendar bridge not available");
    return;
  }

  const norm = normalizeArgs(args);

  if (!norm.event_id) {
    await failOut("event_id is required. Use calendar_search or calendar_read to look up the event_id of the calendar event you want to edit, then retry.");
    return;
  }

  // edit_scope="this_only" or "this_and_following" requires the recurrence_id of
  // the target occurrence. Fail early — before showing a confirmation card — so
  // the LLM gets actionable feedback to retry with the missing field.
  if ((norm.edit_scope === "this_only" || norm.edit_scope === "this_and_following") && !norm.recurrence_id) {
    await failOut(`edit_scope='${norm.edit_scope}' requires recurrence_id (the start_iso of the target occurrence — use calendar_event_read or calendar_read to find it). Retry the call including recurrence_id.`);
    return;
  }

  // calendar_id is OPTIONAL — the bridge (tmCalendar.modifyCalendarEvent) auto-scans
  // every calendar when none is supplied (see tmCalendar.sys.mjs lines 1340-1369).
  // Don't reject here; the schema description tells the LLM the system will resolve
  // it, and matching that contract avoids consecutive-FSM-style retry loops where
  // the LLM has to call calendar_search just to fetch a calendar_id it already
  // implicitly knows from prior context.

  // Auto-extract organizer email from calendar if a calendar_id was provided.
  if (!norm.organizer_email && norm.calendar_id) {
    try {
      const calendarInfo = await browser.tmCalendar.getCalendars();
      if (calendarInfo?.ok && calendarInfo.calendars) {
        const targetCalendar = calendarInfo.calendars.find(cal => cal.id === norm.calendar_id);
        if (targetCalendar?.organizer_email) {
          norm.organizer_email = targetCalendar.organizer_email;
          log(`[TMDBG Tools] calendar_event_edit: auto-extracted organizer email: ${norm.organizer_email}`);
        }
      }
    } catch (e) {
      log(`[TMDBG Tools] calendar_event_edit: failed to auto-extract organizer email: ${e}`, "warn");
    }
  }

  // Enter FSM state and stash edit args
  ctx.state = "calendar_event_edit_list";
  try {
    if (pid && ctx.fsmSessions[pid]) {
      ctx.fsmSessions[pid].editEventArgs = norm;
    }
  } catch (_) {}

  // Record that we entered the initial FSM state for this tool in session history
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    if (pid) {
      ctx.fsmSessions[pid].fsmPrevState = "calendar_event_edit_list";
    }
  } catch (_) {}

  // Establish FSM marker in chat history IMMEDIATELY
  const originalRequest = ctx.rawUserTexts[ctx.rawUserTexts.length - 1] || "";
  const fakeUserText = `Now help me edit a calendar event according to my earlier request: ${originalRequest}`;
  ctx.rawUserTexts.push(fakeUserText);
  log(`[TMDBG Tools] calendar_event_edit: Established FSM marker in chat history`);

  // Optionally validate existence of event here by fetching details
  try {
    const details = await safeFetchEventDetails(norm.event_id);
    if (details && details.ok) {
      try { const pid = ctx.activePid || ctx.activeToolCallId || 0; if (pid) ctx.fsmSessions[pid].editEventDetails = details; } catch (_) {}
      log(`[TMDBG Tools] calendar_event_edit: pre-fetched event details for id=${norm.event_id}`);
    } else {
      log(`[TMDBG Tools] calendar_event_edit: event details not confirmed pre-list: ${(details && details.error) || "unknown"}`, "warn");
    }
  } catch (e) {
    log(`[TMDBG Tools] calendar_event_edit: failed to prefetch details: ${e}`, "warn");
  }

  // Use the agent bubble from tool orchestration
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(`[TMDBG Tools] calendar_event_edit: No agent bubble provided, creating fallback`, "warn");
    agentBubble = await createNewAgentBubble("Preparing edit preview...");
  }

  // Kick off FSM immediately now that waiter should be registered
  const core = await import("../fsm/core.js");
  await core.executeAgentAction();
}

async function safeFetchEventDetails(eventId) {
  try {
    if (browser?.tmCalendar?.getCalendars && browser?.tmCalendar?.queryCalendarItems) {
      // Use experimental helper if exposed (later we can add a dedicated getEventDetails)
      // For now, try a broad query of today and match id client-side if available in cache
      // but primary path: use a dedicated bridge call if present
      if (typeof browser.tmCalendar.getCalendarEventDetails === "function") {
        return await browser.tmCalendar.getCalendarEventDetails(String(eventId));
      }
    }
  } catch (e) {
    log(`[TMDBG Tools] calendar_event_edit: safeFetchEventDetails failed: ${e}`, "warn");
  }
  return { ok: false, error: "details not available" };
}

export function resetPaginationSessions() {}

// FSM tool completion handler – returns structured result with event details
export async function completeExecution(currentState, prevState) {
  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid && ctx.fsmSessions && ctx.fsmSessions[pid] ? ctx.fsmSessions[pid] : null;
  const failReason = sess?.failReason || "";
  
  if (failReason) {
    log(`[TMDBG Tools] calendar_event_edit.completeExecution: failed – ${failReason}`);
    return { ok: false, error: failReason };
  }
  
  if (prevState === "calendar_event_edit_exec" && sess?.editResult) {
    log(`[TMDBG Tools] calendar_event_edit.completeExecution: edited event successfully scope=${sess.editResult.edit_scope}`);
    // Echo the RESOLVED edit_scope (+ recurrence_id) back to the LLM so it can
    // accurately tell the user what slice of the series changed — especially
    // the inferred case (recurrence_id without edit_scope → "this_only").
    const scope = sess.editResult.edit_scope || "all";
    const rid = sess.editResult.recurrence_id;
    let result;
    if (scope === "this_only") {
      result = `Calendar event modified successfully — edit_scope: this_only (only the occurrence on ${rid}; other occurrences untouched).`;
    } else if (scope === "this_and_following") {
      result = `Calendar event modified successfully — edit_scope: this_and_following (this and all later occurrences from ${rid}; earlier ones untouched).`;
    } else {
      result = "Calendar event modified successfully — edit_scope: all (the entire event/series).";
    }
    return {
      ok: true,
      result,
      event_id: sess.editResult.event_id,
      event_title: sess.editResult.event_title,
      calendar_id: sess.editResult.calendar_id,
      edit_scope: scope,
      recurrence_id: rid,
      invitations: sess.editResult.invitations,
    };
  }
  
  log(`[TMDBG Tools] calendar_event_edit.completeExecution: completed`);
  return { ok: true, result: "Edit workflow completed." };
}
