// calendarDelete.js – FSM states for calendar_event_delete (TB 141+, MV3)

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import { formatTimestampForAgent, streamText } from "../modules/helpers.js";
import { relayFsmConfirmation } from "../../chatlink/modules/fsm.js";

function formatEventDetailsForDisplay(details) {
  try {
    const d = details || {};
    const lines = [];
    if (d.calendarName) lines.push(`Calendar: ${d.calendarName}`);
    if (d.id) lines.push(`Event ID: ${d.id}`);
    if (d.title) lines.push(`Title: ${d.title}`);
    if (d.start)
      lines.push(`Start: ${formatTimestampForAgent(new Date(d.start))}`);
    if (d.end) lines.push(`End: ${formatTimestampForAgent(new Date(d.end))}`);
    if (typeof d.isAllDay !== "undefined")
      lines.push(`All-day: ${d.isAllDay ? "yes" : "no"}`);
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

export async function runStateDeleteCalendarEventList() {
  const agentBubble = await createNewAgentBubble("Preparing event preview...");
  let eventId = null;
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    eventId = sess?.deleteEventArgs?.event_id || null;
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
    const formatted = formatEventDetailsForDisplay(details);
    assistantText = `I found this calendar event:\n\n${formatted}`;
    streamText(agentBubble, assistantText);
  } else {
    const errMsg =
      details && details.error ? String(details.error) : "unknown error";
    const failMsg = `Failed to read event details for id ${eventId}: ${errMsg}`;
    log(
      `[CalendarDelete] details fetch failed for id=${eventId}: ${errMsg}`,
      "error"
    );
    streamText(agentBubble, failMsg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) ctx.fsmSessions[pid].failReason = failMsg;
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
  let sendInvitations = undefined;
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    eventId = sess?.deleteEventArgs?.event_id || null;
    organizerEmail = sess?.deleteEventArgs?.organizer_email || null;
    sendInvitations = sess?.deleteEventArgs?.send_invitations;
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
      event_id: eventId,
      confirm: true,
      organizer_email: organizerEmail,
      send_invitations: sendInvitations,
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
      invitations: res.invitations,
    };
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].deleteResult = deleteResult;
      }
    } catch (_) {}

    resultMsg = "Calendar event deleted";
    if (res.invitations) {
      if (res.invitations.ok) {
        if (typeof res.invitations.recipients !== "undefined") {
          resultMsg += `. Cancellations sent to ${res.invitations.recipients} attendees.`;
        } else if (res.invitations.message) {
          resultMsg += `. ${res.invitations.message}`;
        } else {
          resultMsg += `. Cancellations sent to attendees.`;
        }
      } else {
        resultMsg += `. Warning: Failed to send cancellations (${res.invitations.error}).`;
      }
    }
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
