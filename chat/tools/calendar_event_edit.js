// calendar_event_edit.js – edits an existing calendar event (FSM tool)

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { toNaiveIso } from "../modules/helpers.js";

function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};
  
  // event_id is required for edit operations
  if (typeof a.event_id === "string" && a.event_id) out.event_id = a.event_id;
  
  // calendar_id is required for disambiguation
  if (typeof a.calendar_id === "string" && a.calendar_id) out.calendar_id = a.calendar_id;
  
  // recurrence_id for editing specific occurrences
  if (typeof a.recurrence_id === "string" && a.recurrence_id) out.recurrence_id = a.recurrence_id;
  
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
  
  // Attendees array (include even if empty since it's a valid state)
  if (Array.isArray(a.attendees)) {
    out.attendees = a.attendees.filter(Boolean).map((p) => ({
      email: typeof p?.email === "string" ? p.email : (typeof p === "string" ? p : ""),
      name: typeof p?.name === "string" ? p.name : "",
    }));
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
  // Validation of bridge and arguments first (logs only)
  if (!browser?.tmCalendar?.modifyCalendarEvent) {
    log("[TMDBG Tools] calendar_event_edit: calendar bridge not available", "error");
    return;
  }

  const norm = normalizeArgs(args);
  
  if (!norm.event_id) {
    log("[TMDBG Tools] calendar_event_edit: event_id is required", "error");
    return;
  }
  
  if (!norm.calendar_id) {
    log("[TMDBG Tools] calendar_event_edit: calendar_id is required", "error");
    return;
  }

  // Auto-extract organizer email from calendar if not provided
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

  // Mark FSM context using MCP tool call id when available and enter FSM state
  try { ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null; } catch (_) {}
  ctx.toolExecutionMode = "calendar_event_edit";
  ctx.state = "calendar_event_edit_list";

  // Initialize FSM session
  try {
    const pid = ctx.activeToolCallId || 0;
    if (pid) {
      initFsmSession(pid, "calendar_event_edit");
      // Store edit args in session
      ctx.fsmSessions[pid].editEventArgs = norm;
      log(`[TMDBG Tools] calendar_event_edit: Initialized FSM session with system prompt for pid=${pid}`);
      ctx.activePid = pid;
      ctx.awaitingPid = pid;
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

  // Use the agent bubble from wsTools
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
    log(`[TMDBG Tools] calendar_event_edit.completeExecution: edited event successfully`);
    return {
      ok: true,
      result: "Calendar event modified successfully.",
      event_id: sess.editResult.event_id,
      event_title: sess.editResult.event_title,
      calendar_id: sess.editResult.calendar_id,
      invitations: sess.editResult.invitations,
    };
  }
  
  log(`[TMDBG Tools] calendar_event_edit.completeExecution: completed`);
  return { ok: true, result: "Edit workflow completed." };
}
