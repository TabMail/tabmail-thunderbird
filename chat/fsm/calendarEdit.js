// calendarEdit.js – FSM states for calendar_event_edit (TB 141+, MV3)

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import {
  formatTimestampForAgent,
  streamText
} from "../modules/helpers.js";

async function formatEventDetailsForDisplay(details, editArgs) {
  try {
    const d = details || {};
    const lines = [];

    // Try to resolve calendar name from calendar_id in editArgs if calendarName is not available
    if (d.calendarName) {
      lines.push(`Calendar: ${d.calendarName}`);
    } else if (editArgs?.calendar_id) {
      try {
        const calendarInfo = await browser.tmCalendar.getCalendars();
        if (calendarInfo?.ok && calendarInfo.calendars) {
          const targetCalendar = calendarInfo.calendars.find(
            (cal) => cal.id === editArgs.calendar_id
          );
          if (targetCalendar?.name) {
            lines.push(`Calendar: ${targetCalendar.name}`);
          } else {
            lines.push(`Calendar ID: ${editArgs.calendar_id}`);
          }
        }
      } catch (e) {
        log(`[CalendarEdit] Failed to resolve calendar name: ${e}`, "warn");
        if (editArgs.calendar_id) {
          lines.push(`Calendar ID: ${editArgs.calendar_id}`);
        }
      }
    }

    if (d.id) lines.push(`Event ID: ${d.id}`);
    if (d.title) lines.push(`Title: ${d.title}`);
    if (d.start)
      lines.push(`Start: ${formatTimestampForAgent(new Date(d.start))}`);
    if (d.end) lines.push(`End: ${formatTimestampForAgent(new Date(d.end))}`);
    if (typeof d.isAllDay !== "undefined")
      lines.push(`All-day: ${d.isAllDay ? "yes" : "no"}`);
    if (d.location) lines.push(`Location: ${d.location}`);
    if (d.organizer) lines.push(`Organizer: ${d.organizer}`);
    if (typeof d.transparency === "string") {
      const mapped = d.transparency === "free" ? "free" : "busy";
      lines.push(`Transparency: ${mapped}`);
    }
    if (Number.isFinite(d.attendees)) lines.push(`Attendees: ${d.attendees}`);
    if (d.description) {
      const preview =
        d.description.length > 100
          ? d.description.slice(0, 100) + "..."
          : d.description;
      lines.push(`Description: ${preview}`);
    }
    return lines.join("\n");
  } catch (e) {
    return "(Failed to format event details)";
  }
}

function formatChangesForDisplay(editArgs, currentDetails) {
  try {
    const lines = [];
    const a = editArgs || {};
    const d = currentDetails || {};

    // Show what fields are being changed with bold markdown and clear arrows
    if (a.title && a.title !== d.title) {
      lines.push(`**Title:**`);
      lines.push(`  ${d.title || "(empty)"} → **${a.title}**`);
    }
    if (a.start_iso) {
      const oldStart = d.start
        ? formatTimestampForAgent(new Date(d.start))
        : "(not set)";
      const newStart = formatTimestampForAgent(new Date(a.start_iso));
      if (oldStart !== newStart) {
        lines.push(`**Start time:**`);
        lines.push(`  ${oldStart} → **${newStart}**`);
      }
    }
    if (a.end_iso) {
      const oldEnd = d.end
        ? formatTimestampForAgent(new Date(d.end))
        : "(not set)";
      const newEnd = formatTimestampForAgent(new Date(a.end_iso));
      if (oldEnd !== newEnd) {
        lines.push(`**End time:**`);
        lines.push(`  ${oldEnd} → **${newEnd}**`);
      }
    }
    if (typeof a.all_day !== "undefined" && a.all_day !== d.isAllDay) {
      lines.push(`**All-day event:**`);
      lines.push(
        `  ${d.isAllDay ? "yes" : "no"} → **${a.all_day ? "yes" : "no"}**`
      );
    }
    if (a.location && a.location !== d.location) {
      lines.push(`**Location:**`);
      lines.push(`  ${d.location || "(empty)"} → **${a.location}**`);
    }
    if (a.description) {
      const oldDesc = d.description
        ? d.description.length > 50
          ? d.description.slice(0, 50) + "..."
          : d.description
        : "(empty)";
      const newDesc =
        a.description.length > 50
          ? a.description.slice(0, 50) + "..."
          : a.description;
      if (a.description !== d.description) {
        lines.push(`**Description:**`);
        lines.push(`  ${oldDesc} → **${newDesc}**`);
      }
    }
    if (typeof a.transparency === "string") {
      const oldT =
        typeof d.transparency === "string"
          ? d.transparency === "free"
            ? "free"
            : "busy"
          : "(unchanged)";
      const newT = a.transparency === "free" ? "free" : "busy";
      if (oldT !== newT) {
        lines.push(`**Transparency:**`);
        lines.push(`  ${oldT} → **${newT}**`);
      }
    }
    if (Array.isArray(a.attendees)) {
      const oldCount = Number.isFinite(d.attendees) ? d.attendees : 0;
      const newCount = a.attendees.length;
      if (oldCount !== newCount) {
        lines.push(`**Attendees:**`);
        lines.push(`  ${oldCount} invitee(s) → **${newCount} invitee(s)**`);
        // Show first few new attendees
        if (a.attendees.length > 0) {
          a.attendees.slice(0, 3).forEach((att) => {
            const name = att.name || att.email || "(unknown)";
            lines.push(`    • ${name}`);
          });
          if (a.attendees.length > 3) {
            lines.push(`    • ... and ${a.attendees.length - 3} more`);
          }
        }
      }
    }
    if (a.recurrence) {
      lines.push(`**Recurrence:** *(updated)*`);
    }
    if (Array.isArray(a.exdates_add) && a.exdates_add.length > 0) {
      lines.push(`**Excluded dates:** *(+${a.exdates_add.length} dates)*`);
    }

    return lines.length > 0 ? lines.join("\n") : "*(no changes detected)*";
  } catch (e) {
    return "(Failed to format changes)";
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
    log(`[CalendarEdit] getCalendarEventDetails failed: ${e}`, "warn");
  }
  return { ok: false, error: "details API not available" };
}

export async function runStateEditCalendarEventList() {
  const agentBubble = await createNewAgentBubble("Preparing edit preview...");
  let eventId = null;
  let editArgs = null;
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    editArgs = sess?.editEventArgs || null;
    eventId = editArgs?.event_id || null;
  } catch (_) {}

  if (!eventId || !editArgs) {
    agentBubble.classList.remove("loading");
    const msg = "I cannot find the event id or edit details.";
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid)
        ctx.fsmSessions[pid].failReason =
          "Missing event_id or editEventArgs in session.";
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
      (pid && ctx.fsmSessions[pid] && ctx.fsmSessions[pid].editEventDetails) ||
      null;
  } catch (_) {}
  if (!details) {
    details = await fetchEventDetails(eventId);
  }

  agentBubble.classList.remove("loading");
  let assistantText = "";
  if (details && details.ok) {
    const formattedCurrent = await formatEventDetailsForDisplay(
      details,
      editArgs
    );
    const formattedChanges = formatChangesForDisplay(editArgs, details);
    assistantText = `I found this calendar event:\n\n${formattedCurrent}\n\nProposed changes:\n${formattedChanges}`;
    streamText(agentBubble, assistantText);
  } else {
    const errMsg =
      details && details.error ? String(details.error) : "unknown error";
    const failMsg = `Failed to read event details for id ${eventId}: ${errMsg}`;
    log(
      `[CalendarEdit] details fetch failed for id=${eventId}: ${errMsg}`,
      "error"
    );
    streamText(agentBubble, failMsg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) ctx.fsmSessions[pid].failReason = failMsg;
    } catch (_) {}
    log(`[CalendarEdit] moving to state = exec_fail`);
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  const confirmBubble = await createNewAgentBubble("Thinking...");
  confirmBubble.classList.remove("loading");
  const bubbleText =
    "Should I go ahead and apply these changes to the calendar event?";
  streamText(confirmBubble, bubbleText);

  try {
    ctx.pendingSuggestion = "yes";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}
  awaitUserInput();
}

export async function runStateEditCalendarEventExec() {
  const agentBubble = await createNewAgentBubble("Updating calendar event...");

  let editArgs = null;
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    editArgs = sess?.editEventArgs || null;
  } catch (_) {}

  if (!editArgs || !editArgs.event_id) {
    agentBubble.classList.remove("loading");
    const msg = "Edit failed because event details are missing.";
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid)
        ctx.fsmSessions[pid].failReason = "Missing editEventArgs in exec.";
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  let resultMsg = "";
  let editResult = null;
  try {
    const res = await browser.tmCalendar.modifyCalendarEvent(editArgs);
    const ok = !!(res && (res.ok === true || res === true));
    if (!ok) {
      const err = (res && res.error) || "failed to modify event";
      log(`[CalendarEdit] edit failed: ${err}`, "error");
      throw new Error(String(err));
    }

    // Store result in session for completeExecution to retrieve
    editResult = {
      event_id: res.event_id,
      calendar_id: res.calendar_id,
      event_title: res.title,
      invitations: res.invitations,
    };
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].editResult = editResult;
      }
    } catch (_) {}

    resultMsg = "Calendar event updated";
    if (res.invitations) {
      if (res.invitations.ok) {
        if (typeof res.invitations.recipients !== "undefined") {
          resultMsg += `. Updates sent to ${res.invitations.recipients} attendees.`;
        } else if (res.invitations.message) {
          resultMsg += `. ${res.invitations.message}`;
        } else {
          resultMsg += `. Updates sent to attendees.`;
        }
      } else {
        resultMsg += `. Warning: Failed to send updates (${res.invitations.error}).`;
      }
    }
  } catch (e) {
    agentBubble.classList.remove("loading");
    const msg = `Failed to update the event: ${e}`;
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
