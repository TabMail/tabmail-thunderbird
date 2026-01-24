// calendarCreate.js – FSM states for calendar_event_create (TB 141+, MV3)

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import {
  formatTimestampForAgent,
  streamText
} from "../modules/helpers.js";

async function formatEventArgsForDisplay(args) {
  try {
    const a = args || {};
    const lines = [];

    // Resolve calendar name first if calendar_id is present
    if (a.calendar_id) {
      try {
        const calendarInfo = await browser.tmCalendar.getCalendars();
        if (calendarInfo?.ok && calendarInfo.calendars) {
          const targetCalendar = calendarInfo.calendars.find(
            (cal) => cal.id === a.calendar_id
          );
          if (targetCalendar?.name) {
            lines.push(`Calendar: ${targetCalendar.name}`);
          } else {
            lines.push(`Calendar ID: ${a.calendar_id}`);
          }
        }
      } catch (e) {
        log(`[CalendarCreate] Failed to resolve calendar name: ${e}`, "warn");
        lines.push(`Calendar ID: ${a.calendar_id}`);
      }
    }

    if (a.title) lines.push(`Title: ${a.title}`);
    if (a.start_iso)
      lines.push(`Start: ${formatTimestampForAgent(new Date(a.start_iso))}`);
    if (a.end_iso)
      lines.push(`End: ${formatTimestampForAgent(new Date(a.end_iso))}`);
    if (typeof a.all_day !== "undefined")
      lines.push(`All-day: ${a.all_day ? "yes" : "no"}`);
    if (a.location) lines.push(`Location: ${a.location}`);
    if (a.description) {
      const preview =
        a.description.length > 100
          ? a.description.slice(0, 100) + "..."
          : a.description;
      lines.push(`Description: ${preview}`);
    }
    if (Array.isArray(a.attendees) && a.attendees.length > 0) {
      lines.push(`Attendees: ${a.attendees.length} invitee(s)`);
      a.attendees.slice(0, 3).forEach((att) => {
        const name = att.name || "";
        const email = String(att.email || "").replace(/^mailto:/i, "").trim();
        let display = "";
        if (name && email) {
          display = `${name} <${email}>`;
        } else if (email) {
          display = `<${email}>`;
        } else if (name) {
          display = name;
        } else {
          display = "(unknown)";
        }
        lines.push(`  - ${display}`);
      });
      if (a.attendees.length > 3) {
        lines.push(`  ... and ${a.attendees.length - 3} more`);
      }
    }
    if (a.organizer_email) lines.push(`Organizer: ${a.organizer_email}`);
    if (a.recurrence) {
      lines.push(`Recurrence: ${JSON.stringify(a.recurrence)}`);
    }
    return lines.join("\n");
  } catch (e) {
    return "(Failed to format event details)";
  }
}

export async function runStateCreateCalendarEventList() {
  const agentBubble = await createNewAgentBubble("Preparing event preview...");
  let createArgs = null;
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    createArgs = sess?.createEventArgs || null;
  } catch (_) {}

  if (!createArgs) {
    agentBubble.classList.remove("loading");
    const msg = "I cannot find the event details to create.";
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid)
        ctx.fsmSessions[pid].failReason = "Missing createEventArgs in session.";
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  agentBubble.classList.remove("loading");
  const formatted = await formatEventArgsForDisplay(createArgs);
  let assistantText = `I'm ready to create this calendar event:\n\n${formatted}`;
  streamText(agentBubble, assistantText);

  const confirmBubble = await createNewAgentBubble("Thinking...");
  confirmBubble.classList.remove("loading");
  const bubbleText = "Should I go ahead and create this calendar event?";
  streamText(confirmBubble, bubbleText);

  try {
    ctx.pendingSuggestion = "yes";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}
  awaitUserInput();
}

export async function runStateCreateCalendarEventExec() {
  const agentBubble = await createNewAgentBubble("Creating calendar event...");

  let createArgs = null;
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    createArgs = sess?.createEventArgs || null;
  } catch (_) {}

  if (!createArgs) {
    agentBubble.classList.remove("loading");
    const msg = "Create failed because event details are missing.";
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid)
        ctx.fsmSessions[pid].failReason = "Missing createEventArgs in exec.";
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  let resultMsg = "";
  let createResult = null;
  try {
    const res = await browser.tmCalendar.createCalendarEvent(createArgs);
    const ok = !!(res && (res.ok === true || res === true));
    if (!ok) {
      const err = (res && res.error) || "failed to create event";
      log(`[CalendarCreate] create failed: ${err}`, "error");
      throw new Error(String(err));
    }

    // Store result in session for completeExecution to retrieve
    createResult = {
      event_id: res.event_id,
      calendar_id: res.calendar_id,
      event_title: res.title,
      invitations: res.invitations,
    };
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].createResult = createResult;
      }
    } catch (_) {}

    resultMsg = "Calendar event created";
    if (res.event_id) {
      resultMsg += ` with ID: ${res.event_id}`;
    }
    if (res.invitations) {
      if (res.invitations.ok) {
        if (typeof res.invitations.recipients !== "undefined") {
          resultMsg += `. Invitations sent to ${res.invitations.recipients} attendees.`;
        } else if (res.invitations.message) {
          resultMsg += `. ${res.invitations.message}`;
        } else {
          resultMsg += `. Invitations sent to attendees.`;
        }
      } else {
        resultMsg += `. Warning: Failed to send invitations (${res.invitations.error}).`;
      }
    }
  } catch (e) {
    agentBubble.classList.remove("loading");
    const msg = `Failed to create the event: ${e}`;
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
