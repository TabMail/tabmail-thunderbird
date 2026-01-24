// calendar_event_create.js – creates a calendar event (FSM tool)

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { toNaiveIso } from "../modules/helpers.js";

function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};
  
  // Include all valid string properties (schema allows empty strings)
  if (typeof a.title === "string") out.title = a.title;
  // Normalize ISO strings to naive format (remove timezone offsets)
  if (typeof a.start_iso === "string") out.start_iso = toNaiveIso(a.start_iso);
  if (typeof a.end_iso === "string") out.end_iso = toNaiveIso(a.end_iso);
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
  
  // Recurrence (pass-through object if provided)
  if (a && typeof a.recurrence === "object" && a.recurrence) {
    out.recurrence = a.recurrence;
  }
  
  return out;
}

function ensureTimes(details) {
  let { start_iso, end_iso, all_day } = details;
  try {
    if (!start_iso) {
      const now = new Date();
      start_iso = now.toISOString();
    }
    if (!end_iso && !all_day) {
      const minutes = Number(CHAT_SETTINGS.createEventDefaultDurationMinutes) || 60;
      const end = new Date(new Date(start_iso).getTime() + minutes * 60 * 1000);
      end_iso = end.toISOString();
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

  const norm = ensureTimes(normalizeArgs(args));

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

  // Use the agent bubble from wsTools
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
    };
  }
  
  log(`[TMDBG Tools] calendar_event_create.completeExecution: completed`);
  return { result: "Create workflow completed." };
}


