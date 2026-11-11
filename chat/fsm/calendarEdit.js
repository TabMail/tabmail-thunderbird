/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarEdit.js – FSM states for calendar_event_edit (TB 141+, MV3)

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import { formatCardTime, streamText } from "../modules/helpers.js";
import { shownEventTimesIso } from "../tools/calendar_event_read.js";
import { restatedFields } from "../tools/calendar_event_edit.js";
import { relayFsmConfirmation } from "../../chatlink/modules/fsm.js";

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

// The changes an edit makes, as the confirmation card lists them. `check` is
// the calendar's check before the card: `times`, the start and end as the read
// tools print them before and after the edit (of the occurrence the edit
// names), and `resetsChangedOccurrences`, whether a new start resets
// occurrences changed on their own.
function formatChangesForDisplay(editArgs, currentDetails, check = {}) {
  try {
    const lines = [];
    const a = editArgs || {};
    const d = currentDetails || {};
    // A field the edit only restates is no change: one comparison, shared
    // with the edit tool, which drops it from a series edit before the write.
    const restated = restatedFields(a, d);

    // Show what fields are being changed with bold markdown and clear arrows
    if (a.title && !restated.includes("title")) {
      lines.push(`**Title:**`);
      lines.push(`  ${d.title || "(empty)"} → **${a.title}**`);
    }
    // The times come from the check, which reads them as the calendar
    // stores them: a line for each side whose printed value or kind changes,
    // labelled by its new kind. A time the edit only restates is no change and
    // has no line; a start alone also moves the end, which is shown.
    const oldAllDay = d.isAllDay === true;
    const times = check?.times;
    if (times?.from && times?.to) {
      for (const [key, label] of [["start_iso", "Start"], ["end_iso", "End"]]) {
        const was = times.from, now = times.to;
        if (was[key] === now[key] && was.all_day === now.all_day) continue;
        const shown = (side) => (side[key]
          ? formatCardTime(side[key], { allDay: side.all_day, endAfter: key === "end_iso" ? side.start_iso : undefined })
          : "(not set)");
        lines.push(now.all_day ? `**${label} date:**` : `**${label} time:**`);
        lines.push(`  ${shown(was)} → **${shown(now)}**`);
      }
    }
    if (typeof a.all_day !== "undefined" && a.all_day !== d.isAllDay) {
      lines.push(`**All-day event:**`);
      lines.push(
        `  ${d.isAllDay ? "yes" : "no"} → **${a.all_day ? "yes" : "no"}**`
      );
    }
    if (a.location && !restated.includes("location")) {
      lines.push(`**Location:**`);
      lines.push(`  ${d.location || "(empty)"} → **${a.location}**`);
    }
    if (a.description && !restated.includes("description")) {
      const oldDesc = d.description
        ? d.description.length > 50
          ? d.description.slice(0, 50) + "..."
          : d.description
        : "(empty)";
      const newDesc =
        a.description.length > 50
          ? a.description.slice(0, 50) + "..."
          : a.description;
      lines.push(`**Description:**`);
      lines.push(`  ${oldDesc} → **${newDesc}**`);
    }
    if (typeof a.transparency === "string" && !restated.includes("transparency")) {
      const oldT =
        typeof d.transparency === "string"
          ? d.transparency === "free"
            ? "free"
            : "busy"
          : "(unchanged)";
      const newT = a.transparency === "free" ? "free" : "busy";
      lines.push(`**Transparency:**`);
      lines.push(`  ${oldT} → **${newT}**`);
    }
    // The guest change, as the people added and removed. The calendar bridge
    // applies it to each item the edit covers, whose lists can differ, so no
    // count is shown.
    const cardAddsCount = (Array.isArray(a.add_attendees) ? a.add_attendees : []).length;
    const cardRemovesCount = (Array.isArray(a.remove_attendees) ? a.remove_attendees : []).length;
    const hasAttendeeDelta = cardAddsCount > 0 || cardRemovesCount > 0;
    if (hasAttendeeDelta) {
      lines.push(`**Attendees:**`);
      const adds = (a.add_attendees || []).filter((p) => p && p.email && p.email !== "*");
      const removes = (a.remove_attendees || []).filter((p) => p && p.email);
      adds.slice(0, 3).forEach((att) => {
        const label = att.name || att.email;
        lines.push(`    + ${label}`);
      });
      if (adds.length > 3) lines.push(`    + ... and ${adds.length - 3} more`);
      removes.slice(0, 3).forEach((att) => {
        lines.push(`    − ${att.email === "*" ? "(all attendees)" : att.email}`);
      });
      if (removes.length > 3) lines.push(`    − ... and ${removes.length - 3} more`);
    }
    if (a.recurrence) {
      lines.push(`**Recurrence:** *(updated)*`);
    }
    if (Array.isArray(a.exdates_add) && a.exdates_add.length > 0) {
      lines.push(`**Excluded dates:** *(+${a.exdates_add.length} dates)*`);
    }

    // Recurring-event scope — surface this prominently so the user sees that
    // the edit will only apply to part of the series (or just one occurrence).
    // An all-day occurrence is named by its date.
    const scope = typeof a.edit_scope === "string" ? a.edit_scope : null;
    const occurrence = (naiveIso) => (oldAllDay ? formatCardTime(naiveIso, { allDay: true }) : naiveIso);
    if (scope === "this_only" && a.recurrence_id) {
      lines.push(`**Scope:** Just this occurrence (${occurrence(a.recurrence_id)})`);
    } else if (scope === "this_and_following" && a.recurrence_id) {
      // Named by the start the user sees; an occurrence moved off its usual
      // time also shows that original time, where the following part starts
      // unless the edit gives a new start.
      const originally = d.recurrenceIdSlot ? `, originally ${occurrence(d.recurrenceIdSlot)}` : "";
      lines.push(`**Scope:** This occurrence and all future occurrences (starting ${occurrence(a.recurrence_id)}${originally})`);
    } else if (scope === "all") {
      lines.push(`**Scope:** Entire recurring series`);
    }
    if (check?.resetsChangedOccurrences) {
      lines.push(`**Note:** Occurrences you changed individually will be reset, and deleted ones will come back.`);
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
    // Keep the details in the session, so this state does not read the event
    // again when it is entered again.
    if (details && details.ok) {
      try {
        const pid = ctx.activePid || ctx.activeToolCallId || 0;
        if (pid && ctx.fsmSessions[pid]) {
          ctx.fsmSessions[pid].editEventDetails = details;
        }
      } catch (_) {}
    }
  }

  agentBubble.classList.remove("loading");
  let assistantText = "";
  if (details && details.ok) {
    const formattedCurrent = await formatEventDetailsForDisplay(
      details,
      editArgs
    );
    let check = {};
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      const sess = (pid && ctx.fsmSessions[pid]) || {};
      check = { times: sess.editTimes, resetsChangedOccurrences: sess.editResetsChangedOccurrences };
    } catch (_) {}
    const formattedChanges = formatChangesForDisplay(editArgs, details, check);
    assistantText = `I found this calendar event:\n\n${formattedCurrent}\n\nProposed changes:\n${formattedChanges}`;
    streamText(agentBubble, assistantText);
  } else {
    const errMsg =
      details && details.error ? String(details.error) : "unknown error";
    // Internal log keeps the real id (we want it for debugging); the
    // LLM-facing failReason MUST NOT include it because the translator only
    // rewrites ids embedded with a recognized `event_id:` / `[Event](…)`
    // prefix — bare realIds in free-form strings leak through and the LLM
    // will echo them back in subsequent calls (see CalendarEditFollowupBug).
    log(
      `[CalendarEdit] details fetch failed for id=${eventId}: ${errMsg}`,
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

  // Relay confirmation to ChatLink (WhatsApp) if applicable
  try {
    await relayFsmConfirmation(`${assistantText}\n\n${bubbleText}`, "yes");
  } catch (e) {
    log(`[CalendarEdit] ChatLink relay failed (non-fatal): ${e}`, "warn");
  }

  try {
    ctx.pendingSuggestion = "yes";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}
  awaitUserInput();
}

export async function runStateEditCalendarEventExec() {
  const agentBubble = await createNewAgentBubble("Updating calendar event...");

  const execPid = ctx.activePid || ctx.activeToolCallId || 0;
  const execSess = execPid ? (ctx.fsmSessions[execPid] ||= {}) : {};
  let editArgs = execSess?.editEventArgs || null;

  if (!editArgs || !editArgs.event_id) {
    agentBubble.classList.remove("loading");
    const msg = "Edit failed because event details are missing.";
    streamText(agentBubble, msg);
    try {
      if (execPid)
        ctx.fsmSessions[execPid].failReason = "Missing editEventArgs in exec.";
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  // A guest change goes to the calendar bridge as given: it applies the
  // change to each item the edit covers.

  // Route by edit_scope (calendar_event_edit-v1.5.21+). Default: "all" when no
  // recurrence_id, "this_only" when recurrence_id is present (back-compat with
  // earlier schema where recurrence_id alone meant single-occurrence override).
  const explicitScope = (typeof editArgs.edit_scope === "string") ? editArgs.edit_scope : null;
  const editScope = explicitScope
    || (editArgs.recurrence_id ? "this_only" : "all");
  // A scope that needs recurrence_id without one is the bridge's refusal,
  // made already by the tool's check before the card.

  let resultMsg = "";
  let editResult = null;
  try {
    // The bridge's modifyCalendarEvent is the single entry point for all three
    // scopes — its schema accepts `edit_scope` and routes internally:
    //   - "all"               → series edit
    //   - "this_only"         → single-occurrence override (uses recurrence_id)
    //   - "this_and_following" → delegates to splitRecurringEvent inside the bridge
    // So we just pass editArgs through; no JS-side routing.
    log(`[CalendarEdit] modifyCalendarEvent edit_scope=${editScope}`);
    const res = await browser.tmCalendar.modifyCalendarEvent(editArgs);
    const ok = !!(res && (res.ok === true || res === true));
    if (!ok) {
      const err = (res && res.error) || "failed to modify event";
      log(`[CalendarEdit] edit failed: ${err}`, "error");
      throw new Error(String(err));
    }

    // Store result in session for completeExecution to retrieve.
    // `edit_scope` is the RESOLVED scope (explicit or inferred) — echoed back
    // so the LLM knows what slice of the series actually changed. Critical for
    // the inferred case (recurrence_id without edit_scope → "this_only").
    editResult = {
      event_id: res.event_id,
      calendar_id: res.calendar_id,
      event_title: res.title,
      edit_scope: editScope,
      recurrence_id: editArgs.recurrence_id || null,
      invitations: res.invitations,
    };
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].editResult = editResult;
      }
    } catch (_) {}

    resultMsg = "Calendar event updated";
    if (editScope === "this_only") {
      resultMsg += ` (only the occurrence on ${editArgs.recurrence_id}; other occurrences untouched)`;
    } else if (editScope === "this_and_following") {
      resultMsg += ` (this and all later occurrences from ${editArgs.recurrence_id}; earlier ones untouched)`;
    } else {
      resultMsg += " (entire event/series)";
    }
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
