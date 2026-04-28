// calendar_event_delete.js – deletes a calendar event

// FSM tool — requires user confirmation before executing.
// Used by core.js to detect and block consecutive FSM calls (see BLOCK_CONSECUTIVE_FSM_CALLS).
export const fsm = true;

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";

function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};
  
  // event_id is required for delete operations
  if (typeof a.event_id === "string" && a.event_id) out.event_id = a.event_id;
  
  // calendar_id is required for disambiguation
  if (typeof a.calendar_id === "string" && a.calendar_id) out.calendar_id = a.calendar_id;
  
  // confirm defaults to false if not provided
  if (typeof a.confirm === "boolean") {
    out.confirm = a.confirm;
  } else {
    out.confirm = false;
  }
  
  // Include invitation properties
  if (typeof a.send_invitations === "boolean") {
    out.send_invitations = a.send_invitations;
  }
  if (typeof a.organizer_email === "string" && a.organizer_email) {
    out.organizer_email = a.organizer_email;
  }
  
  return out;
}

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] calendar_event_delete: Tool called with args: ${JSON.stringify(args)}`);

    // Immediately schedule the actual routine to the next frame to let WS set up the waiter
    try {
      requestAnimationFrame(() => {
        _runDeleteCalendarEvent(args, options).catch((e) => {
          try { log(`[TMDBG Tools] calendar_event_delete scheduled run failed: ${e}`, "error"); } catch (_) {}
        });
      });
      log(`[TMDBG Tools] calendar_event_delete: scheduled _runDeleteCalendarEvent for next frame`);
    } catch (e) {
      log(`[TMDBG Tools] calendar_event_delete: failed to schedule _runDeleteCalendarEvent: ${e}`, "error");
    }

    // Inform WS layer this is an FSM tool
    const pid = options && typeof options.callId === "string" ? options.callId : options.callId || null;
    return { fsm: true, tool: "calendar_event_delete", pid, startedAt: Date.now() };
  } catch (e) {
    log(`[TMDBG Tools] calendar_event_delete failed: ${e}`, "error");
    return { error: String(e || "unknown error in calendar_event_delete") };
  }
}

async function _runDeleteCalendarEvent(args = {}, options = {}) {
  // Init FSM session BEFORE validation so any early-return failure path can
  // set failReason and drive `exec_fail` — otherwise the converse-side waiter
  // at converse.js:655 sits forever (same bug pattern as calendar_event_edit
  // had pre-fix). Mirrors calendar_event_create's structure.
  try { ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null; } catch (_) {}
  ctx.toolExecutionMode = "calendar_event_delete";
  const pid = ctx.activeToolCallId || 0;
  try {
    if (pid) {
      initFsmSession(pid, "calendar_event_delete");
      log(`[TMDBG Tools] calendar_event_delete: Initialized FSM session with system prompt for pid=${pid}`);
      ctx.activePid = pid;
      ctx.awaitingPid = pid;
    }
  } catch (_) {}

  const failOut = async (reason) => {
    log(`[TMDBG Tools] calendar_event_delete: ${reason}`, "error");
    try {
      if (pid && ctx.fsmSessions[pid]) ctx.fsmSessions[pid].failReason = reason;
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
  };

  // Validation of bridge and arguments
  if (!browser?.tmCalendar?.deleteCalendarEvent) {
    await failOut("Calendar bridge not available");
    return;
  }

  const norm = normalizeArgs(args);
  if (!norm.event_id) {
    await failOut("event_id is required. Use calendar_search or calendar_read to look up the event_id of the calendar event you want to delete, then retry.");
    return;
  }

  if (!norm.calendar_id) {
    await failOut("calendar_id is required. Use calendar_search or calendar_read on the target event to obtain its calendar_id, then retry calendar_event_delete with both event_id and calendar_id.");
    return;
  }

  // Enter FSM state and stash delete args
  ctx.state = "calendar_event_delete_list";
  try {
    if (pid && ctx.fsmSessions[pid]) {
      ctx.fsmSessions[pid].deleteEventArgs = norm;
    }
  } catch (_) {}

  // Record that we entered the initial FSM state for this tool in session history
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    if (pid) {
      ctx.fsmSessions[pid].fsmPrevState = "calendar_event_delete_list";
    }
  } catch (_) {}

  // Establish FSM marker in chat history IMMEDIATELY
  const originalRequest = ctx.rawUserTexts[ctx.rawUserTexts.length - 1] || "";
  const fakeUserText = `Now help me delete a calendar event according to my earlier request: ${originalRequest}`;
  ctx.rawUserTexts.push(fakeUserText);
  log(`[TMDBG Tools] calendar_event_delete: Established FSM marker in chat history`);

  // Optionally validate existence of event here by fetching details
  try {
    const details = await safeFetchEventDetails(norm.event_id);
    if (details && details.ok) {
      try { const pid = ctx.activePid || ctx.activeToolCallId || 0; if (pid) ctx.fsmSessions[pid].deleteEventDetails = details; } catch (_) {}
      log(`[TMDBG Tools] calendar_event_delete: pre-fetched event details for id=${norm.event_id}`);
    } else {
      log(`[TMDBG Tools] calendar_event_delete: event details not confirmed pre-list: ${(details && details.error) || "unknown"}`, "warn");
    }
  } catch (e) {
    log(`[TMDBG Tools] calendar_event_delete: failed to prefetch details: ${e}`, "warn");
  }

  // Use the agent bubble from tool orchestration
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(`[TMDBG Tools] calendar_event_delete: No agent bubble provided, creating fallback`, "warn");
    agentBubble = await createNewAgentBubble("Preparing delete preview...");
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
    log(`[TMDBG Tools] calendar_event_delete: safeFetchEventDetails failed: ${e}`, "warn");
  }
  return { ok: false, error: "details not available" };
}

export function resetPaginationSessions() {}

// FSM tool completion handler – returns structured result with deletion details
export async function completeExecution(currentState, prevState) {
  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid && ctx.fsmSessions && ctx.fsmSessions[pid] ? ctx.fsmSessions[pid] : null;
  const failReason = sess?.failReason || "";
  
  if (failReason) {
    log(`[TMDBG Tools] calendar_event_delete.completeExecution: failed – ${failReason}`);
    return { error: failReason };
  }
  
  if (prevState === "calendar_event_delete_exec" && sess?.deleteResult) {
    log(`[TMDBG Tools] calendar_event_delete.completeExecution: deleted event successfully`);
    return {
      result: "Calendar event deleted successfully.",
      // event_id: sess.deleteResult.event_id,
      // invitations: sess.deleteResult.invitations,
    };
  }
  
  log(`[TMDBG Tools] calendar_event_delete.completeExecution: completed`);
  return { result: "Delete workflow completed." };
}
