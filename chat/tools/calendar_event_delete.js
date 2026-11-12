/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendar_event_delete.js – deletes a calendar event

// FSM tool — requires user confirmation before executing.
// `fsm = true` lets core.js classify this tool as FSM (multi-step / confirmation-required).
export const fsm = true;

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { toNaiveIso } from "../modules/helpers.js";

// The scopes a delete of a repeating event takes (delete_scope), as the edit's
// edit_scope. There is no default: the user is asked when it is unclear.
const DELETE_SCOPES = ["this_only", "this_and_following", "all"];

// The question for the user when a repeating event is to be deleted and the
// call names no scope.
const ASK_DELETE_SCOPE = "This event repeats. Ask the user \"Just this one, this and following, or all of them?\" (unless their words already said which), then call calendar_event_delete again with delete_scope 'this_only', 'this_and_following' or 'all', and for 'this_only' or 'this_and_following' with recurrence_id (the occurrence's start_iso as calendar_event_read shows it).";

function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};
  
  // event_id is required for delete operations
  if (typeof a.event_id === "string" && a.event_id) out.event_id = a.event_id;
  
  // calendar_id is required for disambiguation
  if (typeof a.calendar_id === "string" && a.calendar_id) out.calendar_id = a.calendar_id;

  // recurrence_id — the start of the occurrence to delete, or to delete from,
  // as the read tools show it (null when it is not a date: refused below).
  if (typeof a.recurrence_id === "string" && a.recurrence_id) out.recurrence_id = toNaiveIso(a.recurrence_id);

  // delete_scope — "this_only" | "this_and_following" | "all". Any other value
  // is kept, so it is refused by name rather than dropped.
  if (typeof a.delete_scope === "string" && a.delete_scope.trim()) out.delete_scope = a.delete_scope.toLowerCase().trim();

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

  // Every later step reads this snapshot of the call's arguments (and the
  // card and the write read it from the session).
  const norm = normalizeArgs(args);

  // A date the tool cannot read is refused, never replaced by a guess.
  if (typeof args?.recurrence_id === "string" && args.recurrence_id.trim() && !norm.recurrence_id) {
    await failOut(`recurrence_id "${args.recurrence_id}" is not a date and time the calendar can read. Use YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD for a date, then retry.`);
    return;
  }

  if (!norm.event_id) {
    await failOut("event_id is required. Use calendar_search or calendar_read to look up the event_id of the calendar event you want to delete, then retry.");
    return;
  }

  if (!norm.calendar_id) {
    await failOut("calendar_id is required. Use calendar_search or calendar_read on the target event to obtain its calendar_id, then retry calendar_event_delete with both event_id and calendar_id.");
    return;
  }

  // The event as the card shows it: the occurrence recurrence_id names, unless
  // the whole series goes. A read that fails is stashed as it is, and the list
  // state reports it (no card, nothing deleted).
  let details = await safeFetchEventDetails(norm.event_id, norm.delete_scope === "all" ? null : norm.recurrence_id);
  if (details?.ok) {
    log(`[TMDBG Tools] calendar_event_delete: pre-fetched event details for id=${norm.event_id}`);
  } else {
    log(`[TMDBG Tools] calendar_event_delete: event details not confirmed pre-list: ${details?.error || "unknown"}`, "warn");
  }

  if (!details?.ok) {
    // Reported by the list state.
  } else if (!details.isRecurring) {
    // An event that does not repeat is deleted as it is; a scope means nothing.
    delete norm.delete_scope;
    delete norm.recurrence_id;
  } else {
    // A repeating event: the scope is named (never a default), and an
    // occurrence scope names its occurrence.
    if (!norm.delete_scope) {
      await failOut(ASK_DELETE_SCOPE);
      return;
    }
    if (!DELETE_SCOPES.includes(norm.delete_scope)) {
      await failOut(`delete_scope "${norm.delete_scope}" is not one of 'this_only', 'this_and_following' or 'all'. ${ASK_DELETE_SCOPE}`);
      return;
    }
    if (norm.delete_scope !== "all" && !norm.recurrence_id) {
      await failOut(`delete_scope '${norm.delete_scope}' needs recurrence_id: the occurrence's start_iso as calendar_event_read or calendar_read shows it (every occurrence of a repeating event has the series' event_id).`);
      return;
    }
    // This and every later occurrence, from the first: the whole series.
    if (norm.delete_scope === "this_and_following" && details.recurrenceIdIsFirst === true) {
      norm.delete_scope = "all";
      const series = await safeFetchEventDetails(norm.event_id, null);
      if (!series?.ok) {
        await failOut(`could not read this event (${series?.error || "unknown error"}); try again`);
        return;
      }
      details = series;
    }
    if (norm.delete_scope === "all") delete norm.recurrence_id;

    // Every delete the bridge would refuse (an occurrence that is not one, a
    // series it cannot cut there, ...) is refused here, before the card: the
    // bridge runs the same delete up to its first write and writes nothing.
    let check = null;
    try {
      check = await browser.tmCalendar.deleteCalendarEvent({ ...deleteCallArgs(norm), check_only: true });
      if (!check) throw new Error("no answer");
    } catch (e) {
      await failOut(`the calendar could not check this delete (${e}); try again`);
      return;
    }
    if (check.ok === false) {
      await failOut(String(check.error || "the calendar refused this delete"));
      return;
    }
  }

  // Enter FSM state and stash delete args
  ctx.state = "calendar_event_delete_list";
  try {
    if (pid && ctx.fsmSessions[pid]) {
      ctx.fsmSessions[pid].deleteEventArgs = norm;
      ctx.fsmSessions[pid].deleteEventDetails = details;
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

async function safeFetchEventDetails(eventId, recurrenceId = null) {
  try {
    if (browser?.tmCalendar?.getCalendars && browser?.tmCalendar?.queryCalendarItems) {
      // Use experimental helper if exposed (later we can add a dedicated getEventDetails)
      // For now, try a broad query of today and match id client-side if available in cache
      // but primary path: use a dedicated bridge call if present
      if (typeof browser.tmCalendar.getCalendarEventDetails === "function") {
        // No calendar: the first calendar holding the id, the item the delete
        // (which is given no calendar either) finds.
        if (recurrenceId) return await browser.tmCalendar.getCalendarEventDetails(String(eventId), "", String(recurrenceId));
        return await browser.tmCalendar.getCalendarEventDetails(String(eventId));
      }
    }
  } catch (e) {
    log(`[TMDBG Tools] calendar_event_delete: safeFetchEventDetails failed: ${e}`, "warn");
  }
  return { ok: false, error: "details not available" };
}

// The arguments the bridge delete is given, for the check before the card and
// for the confirmed write alike, so both act on the same item: no calendar,
// the first calendar holding the id, as the card's details read finds it.
export function deleteCallArgs(norm) {
  const out = { event_id: norm.event_id };
  if (norm.delete_scope) out.delete_scope = norm.delete_scope;
  if (norm.recurrence_id) out.recurrence_id = norm.recurrence_id;
  return out;
}

export function resetPaginationSessions() {}

// What the assistant is told went, by the scope the bridge deleted.
const DELETED_RESULT = {
  this_only: "Occurrence deleted successfully; the rest of the series stays.",
  this_and_following: "This and every later occurrence deleted successfully; earlier ones stay.",
  all: "Repeating event deleted successfully: every occurrence.",
};

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
    log(`[TMDBG Tools] calendar_event_delete.completeExecution: deleted event successfully (scope ${sess.deleteResult.scope || "none"})`);
    return {
      result: DELETED_RESULT[sess.deleteResult.scope] || "Calendar event deleted successfully.",
      // event_id: sess.deleteResult.event_id,
      // invitations: sess.deleteResult.invitations,
    };
  }
  
  log(`[TMDBG Tools] calendar_event_delete.completeExecution: completed`);
  return { result: "Delete workflow completed." };
}
