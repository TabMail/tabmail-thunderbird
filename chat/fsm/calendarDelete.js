/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarDelete.js – FSM states for calendar_event_delete (TB 141+, MV3)

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import { formatCardTime, streamText } from "../modules/helpers.js";
import { relayFsmConfirmation } from "../../chatlink/modules/fsm.js";
import { recurrenceInWords } from "../modules/recurrence.js";
import { shownEventTimesIso } from "../tools/calendar_event_read.js";
import { deleteCallArgs } from "../tools/calendar_event_delete.js";
import { guestNoticeBubbleText } from "../modules/calendarGuestNotice.js";

// A repeating event is deleted by scope (delete_scope, routed by the tool):
// "all" removes the whole item, every occurrence; "this_only" the occurrence
// recurrence_id names; "this_and_following" that occurrence and every later
// one. The card says which, and the write does exactly that.
const SERIES_DELETE_NOTE = "Repeating event: every occurrence will be deleted";
const OCCURRENCE_DELETE_NOTE = "One occurrence of a repeating event; the rest of the series stays.";

// An occurrence time as the card's Start line states it: a date alone for a
// date (an all-day occurrence, or the slot of one).
function cardTime(naiveIso) {
  return formatCardTime(naiveIso, { allDay: /^\d{4}-\d{2}-\d{2}$/.test(String(naiveIso)) });
}

// "This and every later occurrence" from the named one; an occurrence moved
// off its usual time also shows that original time (its slot), where the
// series is cut.
function followingDeleteNote(details) {
  const d = details || {};
  if (!d.recurrenceIdSlot) return "This and every later occurrence will be deleted; earlier ones stay.";
  const shown = shownEventTimesIso(d);
  const start = formatCardTime(shown.start_iso, { allDay: d.isAllDay === true });
  return `This and every later occurrence will be deleted (from ${start}, originally ${cardTime(d.recurrenceIdSlot)}); earlier ones stay.`;
}

function formatEventDetailsForDisplay(details, scope = null) {
  try {
    const d = details || {};
    const lines = [];
    if (d.calendarName) lines.push(`Calendar: ${d.calendarName}`);
    if (d.id) lines.push(`Event ID: ${d.id}`);
    if (d.title) lines.push(`Title: ${d.title}`);
    // The stored times as the read tools show them: an all-day DATE from its
    // own day digits, never its epoch (UTC midnight, the day before west of UTC).
    const shown = shownEventTimesIso(d);
    const allDay = d.isAllDay === true;
    if (shown.start_iso)
      lines.push(`Start: ${formatCardTime(shown.start_iso, { allDay })}`);
    if (shown.end_iso)
      lines.push(`End: ${formatCardTime(shown.end_iso, { allDay, endAfter: shown.start_iso })}`);
    if (typeof d.isAllDay !== "undefined")
      lines.push(`All-day: ${d.isAllDay ? "yes" : "no"}`);
    // Keyed on isRecurring, not recurrence: a series repeating by added dates
    // alone has no rule fields and is still deleted by scope. The rule is
    // named only when it can be fully stated (recurrenceInWords), and not for
    // one occurrence, which the rule does not change.
    if (d.isRecurring) {
      if (scope === "this_only") {
        lines.push(OCCURRENCE_DELETE_NOTE);
      } else {
        lines.push(scope === "this_and_following" ? followingDeleteNote(d) : SERIES_DELETE_NOTE);
        const words = recurrenceInWords(d.recurrence);
        if (words) lines.push(`Repeats ${words}`);
      }
    }
    if (d.location) lines.push(`Location: ${d.location}`);
    if (d.organizer) lines.push(`Organizer: ${d.organizer}`);
    if (Number.isFinite(d.attendees)) lines.push(`Attendees: ${d.attendees}`);
    return lines.join("\n");
  } catch (e) {
    return "(Failed to format event details)";
  }
}

async function fetchEventDetails(eventId) {
  try {
    if (typeof browser?.tmCalendar?.getCalendarEventDetails === "function") {
      const res = await browser.tmCalendar.getCalendarEventDetails(
        String(eventId)
      );
      if (res && res.ok) return res;
      return res || { ok: false, error: "unknown error" };
    }
  } catch (e) {
    log(`[CalendarDelete] getCalendarEventDetails failed: ${e}`, "warn");
  }
  return { ok: false, error: "details API not available" };
}

// What went, by the scope the bridge deleted, for the user. "This and every
// later" names no date: the cut is at the occurrence's slot, which for one
// moved on its own is not where it is now (the card states both).
function deletedText(scope) {
  if (scope === "this_only") return "Occurrence deleted";
  if (scope === "this_and_following") return "This and every later occurrence deleted; earlier ones stay";
  if (scope === "all") return "Repeating event deleted: every occurrence";
  return "Calendar event deleted";
}

export async function runStateDeleteCalendarEventList() {
  const agentBubble = await createNewAgentBubble("Preparing event preview...");
  let eventId = null;
  let scope = null;
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    eventId = sess?.deleteEventArgs?.event_id || null;
    scope = sess?.deleteEventArgs?.delete_scope || null;
  } catch (_) {}

  if (!eventId) {
    agentBubble.classList.remove("loading");
    const msg = "I cannot find the event id to delete.";
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) ctx.fsmSessions[pid].failReason = "Missing event_id in session.";
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  let details = null;
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    details =
      (pid &&
        ctx.fsmSessions[pid] &&
        ctx.fsmSessions[pid].deleteEventDetails) ||
      null;
  } catch (_) {}
  if (!details) {
    details = await fetchEventDetails(eventId);
  }

  agentBubble.classList.remove("loading");
  let assistantText = "";
  if (details && details.ok) {
    const formatted = formatEventDetailsForDisplay(details, scope);
    assistantText = `I found this calendar event:\n\n${formatted}`;
    streamText(agentBubble, assistantText);
  } else {
    const errMsg =
      details && details.error ? String(details.error) : "unknown error";
    // Same realId-leak guard as calendarEdit — keep id in internal log only.
    log(
      `[CalendarDelete] details fetch failed for id=${eventId}: ${errMsg}`,
      "error"
    );
    const userFacing = `Failed to read event details: ${errMsg}.`;
    streamText(agentBubble, userFacing);
    const llmFacing =
      `Failed to read event details: ${errMsg}. The event_id you supplied may not refer to a calendar event on the user's calendars (it could be stale, deleted, or a different kind of id). ` +
      `Use calendar_search or calendar_read to look up a valid event_id, then retry — do not retry with the same event_id.`;
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) ctx.fsmSessions[pid].failReason = llmFacing;
    } catch (_) {}
    log(`[CalendarDelete] moving to state = exec_fail`);
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  const confirmBubble = await createNewAgentBubble("Thinking...");
  confirmBubble.classList.remove("loading");
  const bubbleText = "Should I go ahead and delete this calendar event?";
  streamText(confirmBubble, bubbleText);

  // Relay confirmation to ChatLink (WhatsApp) if applicable
  try {
    await relayFsmConfirmation(`${assistantText}\n\n${bubbleText}`, "yes");
  } catch (e) {
    log(`[CalendarDelete] ChatLink relay failed (non-fatal): ${e}`, "warn");
  }

  try {
    ctx.pendingSuggestion = "yes";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}
  awaitUserInput();
}

export async function runStateDeleteCalendarEventExec() {
  const agentBubble = await createNewAgentBubble("Deleting calendar event...");

  let eventId = null;
  let organizerEmail = null;
  // The call's arguments as the tool stashed them (scope as routed): the
  // write is the delete the card stated.
  let args = {};
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    args = sess?.deleteEventArgs || {};
    eventId = args.event_id || null;
    organizerEmail = args.organizer_email || null;
  } catch (_) {}

  if (!eventId) {
    agentBubble.classList.remove("loading");
    const msg = "Delete failed because event_id is missing.";
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) ctx.fsmSessions[pid].failReason = "Missing event_id in exec.";
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  // Ensure organizer_email if possible
  if (!organizerEmail) {
    try {
      const calendarInfo = await browser.tmCalendar.getCalendars();
      if (calendarInfo?.ok && calendarInfo.calendars) {
        const calWithId = calendarInfo.calendars.find((c) => c.organizer_email);
        if (calWithId?.organizer_email)
          organizerEmail = calWithId.organizer_email;
      }
    } catch (e) {
      log(`[CalendarDelete] auto-extract organizer failed: ${e}`, "warn");
    }
  }

  let resultMsg = "";
  let deleteResult = null;
  try {
    const res = await browser.tmCalendar.deleteCalendarEvent({
      ...deleteCallArgs(args),
      organizer_email: organizerEmail,
    });
    const ok = !!(res && (res.ok === true || res === true));
    if (!ok) {
      const err = (res && res.error) || "failed to delete event";
      log(`[CalendarDelete] delete failed: ${err}`, "error");
      throw new Error(String(err));
    }

    // Store result in session for completeExecution to retrieve
    deleteResult = {
      event_id: eventId,
      scope: res.scope || null,
      invitations: res.invitations,
    };
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].deleteResult = deleteResult;
      }
    } catch (_) {}

    resultMsg = deletedText(res.scope);
    const guestNotice = guestNoticeBubbleText(res.invitations);
    if (guestNotice) resultMsg += `. ${guestNotice}`;
  } catch (e) {
    agentBubble.classList.remove("loading");
    const msg = `Failed to delete the event: ${e}`;
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) ctx.fsmSessions[pid].failReason = String(e);
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  agentBubble.classList.remove("loading");
  streamText(agentBubble, resultMsg);

  ctx.state = "exec_success";
  const core = await import("./core.js");
  await core.executeAgentAction();
}
