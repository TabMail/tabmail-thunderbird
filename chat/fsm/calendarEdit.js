// calendarEdit.js – FSM states for calendar_event_edit (TB 141+, MV3)

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import {
  formatNaiveIsoInTimezone,
  formatTimestampForAgent,
  streamText
} from "../modules/helpers.js";
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
      const newStart = formatNaiveIsoInTimezone(a.start_iso, a.timezone);
      if (oldStart !== newStart) {
        lines.push(`**Start time:**`);
        lines.push(`  ${oldStart} → **${newStart}**`);
      }
    }
    if (a.end_iso) {
      const oldEnd = d.end
        ? formatTimestampForAgent(new Date(d.end))
        : "(not set)";
      const newEnd = formatNaiveIsoInTimezone(a.end_iso, a.timezone);
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
    // Delta-based attendees (v1.5.21+). Compute the projected merged list against
    // the event's current attendee list (d.attendeeList) and show old → new count
    // plus the actual people being added/removed.
    const cardAddsCount = (Array.isArray(a.add_attendees) ? a.add_attendees : []).length;
    const cardRemovesCount = (Array.isArray(a.remove_attendees) ? a.remove_attendees : []).length;
    const hasAttendeeDelta = cardAddsCount > 0 || cardRemovesCount > 0;
    if (hasAttendeeDelta) {
      const base = Array.isArray(d.attendeeList) ? d.attendeeList : [];
      const merged = applyAttendeeDelta(base, a.add_attendees || [], a.remove_attendees || []);
      const oldCount = base.length;
      const newCount = merged.length;
      lines.push(`**Attendees:**`);
      lines.push(`  ${oldCount} invitee(s) → **${newCount} invitee(s)**`);
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
    if (a.timezone) {
      lines.push(`**Timezone:**`);
      lines.push(`  ${a.timezone}`);
    }
    if (Array.isArray(a.exdates_add) && a.exdates_add.length > 0) {
      lines.push(`**Excluded dates:** *(+${a.exdates_add.length} dates)*`);
    }

    // Recurring-event scope — surface this prominently so the user sees that
    // the edit will only apply to part of the series (or just one occurrence).
    const scope = typeof a.edit_scope === "string" ? a.edit_scope : null;
    if (scope === "this_only" && a.recurrence_id) {
      lines.push(`**Scope:** Just this occurrence (${a.recurrence_id})`);
    } else if (scope === "this_and_following" && a.recurrence_id) {
      lines.push(`**Scope:** This occurrence and all future occurrences (starting ${a.recurrence_id})`);
    } else if (scope === "all") {
      lines.push(`**Scope:** Entire recurring series`);
    }

    return lines.length > 0 ? lines.join("\n") : "*(no changes detected)*";
  } catch (e) {
    return "(Failed to format changes)";
  }
}

/// Strip an optional `mailto:` URI prefix from an attendee email (case-insensitive).
/// TB attendee.id frequently arrives in `mailto:foo@bar.com` form via getCalendarEventDetails.
function stripMailto(raw) {
  const s = String(raw || "").trim();
  return /^mailto:/i.test(s) ? s.replace(/^mailto:/i, "") : s;
}

/// Apply an add/remove delta on top of `base` attendees. Removals are matched
/// case-insensitively on email (after stripping `mailto:`). A remove list containing
/// `{email: "*"}` clears every base entry. Adds are appended after removes and de-duped
/// case-insensitively against whatever's left. When the same email appears in `base`
/// and `adds` with a different name, the base entry's name is kept.
/// Mirrors `email_reply.js applyDelta` and iOS `CalendarToolHelpers.applyAttendeeDelta`.
export function applyAttendeeDelta(base, adds, removes) {
  const baseList = Array.isArray(base) ? base : [];
  const addList = Array.isArray(adds) ? adds : [];
  const removeList = Array.isArray(removes) ? removes : [];

  const clearAll = removeList.some(
    (r) => String(r?.email || "").trim() === "*"
  );
  const removeSet = new Set(
    removeList
      .map((r) => stripMailto(r?.email).toLowerCase())
      .filter((e) => e && e !== "*")
  );

  const filtered = clearAll
    ? []
    : baseList.filter((r) => !removeSet.has(stripMailto(r?.email).toLowerCase()));

  // Carry forward base entries with their stored name; emit {email, name}.
  const result = filtered.map((r) => ({
    email: stripMailto(r?.email),
    name: String(r?.name || ""),
  }));
  const seen = new Set(result.map((r) => r.email.toLowerCase()));

  for (const add of addList) {
    const email = stripMailto(add?.email);
    if (!email || email === "*") continue;
    const key = email.toLowerCase();
    if (!seen.has(key)) {
      result.push({ email, name: String(add?.name || "") });
      seen.add(key);
    }
  }
  return result;
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
    // Persist the locally-fetched details back to the session so the exec step
    // can fall back to this snapshot when its own re-fetch fails — without
    // this, an empty-base resolution could silently wipe existing attendees
    // for the delta-attendee path (calendar_event_edit-v1.5.21+).
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
    const formattedChanges = formatChangesForDisplay(editArgs, details);
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

  // calendar_event_edit-v1.5.21+: attendees arrive as add/remove deltas. Re-fetch
  // the event right before applying so we merge against the freshest attendee list
  // (the cached editEventDetails from the confirm step may be seconds-to-minutes stale),
  // then collapse the delta into a flat `attendees` array — which is what the
  // tmCalendar.modifyCalendarEvent bridge expects.
  const addsCount = (Array.isArray(editArgs.add_attendees) ? editArgs.add_attendees : []).length;
  const removesCount = (Array.isArray(editArgs.remove_attendees) ? editArgs.remove_attendees : []).length;
  const hasAttendeeDelta = addsCount > 0 || removesCount > 0;
  if (hasAttendeeDelta) {
    let base = [];
    let baseSource = "empty";
    try {
      const fresh = await fetchEventDetails(editArgs.event_id);
      if (fresh && fresh.ok && Array.isArray(fresh.attendeeList)) {
        base = fresh.attendeeList;
        baseSource = "fresh";
      } else if (Array.isArray(execSess?.editEventDetails?.attendeeList)) {
        // Fallback to the confirm-time snapshot if the re-fetch failed; better than
        // resolving against an empty list (which would silently drop existing attendees).
        base = execSess.editEventDetails.attendeeList;
        baseSource = "cached";
      }
    } catch (e) {
      log(`[CalendarEdit] re-fetch for attendee merge failed (using cached): ${e}`, "warn");
      if (Array.isArray(execSess?.editEventDetails?.attendeeList)) {
        base = execSess.editEventDetails.attendeeList;
        baseSource = "cached";
      }
    }

    // Safety net: if we have NO base info, abort UNLESS the delta is an
    // explicit clear-all (remove "*"). Reason: without knowing the current
    // attendee list, the merge result would also collapse to an unknown
    // truth — an adds-only delta would emit `attendees: [adds]` and wipe
    // anything we didn't know about, and a removes-specific delta would
    // emit `attendees: []` (the wipe). Clear-all is intentional wipe so
    // it's safe to apply regardless of base. The user/LLM can retry once
    // the calendar is reachable.
    const isClearAll = (Array.isArray(editArgs.remove_attendees) ? editArgs.remove_attendees : []).some(
      (r) => String(r?.email || "").trim() === "*"
    );
    if (baseSource === "empty" && !isClearAll) {
      agentBubble.classList.remove("loading");
      const failMsg =
        "Could not load the current attendee list for this event — refusing to edit attendees blindly, as the merge could overwrite the existing list. Please retry once the calendar is reachable.";
      streamText(agentBubble, failMsg);
      try {
        if (execPid) ctx.fsmSessions[execPid].failReason = failMsg;
      } catch (_) {}
      log(`[CalendarEdit] aborted attendee delta — base unknown (+${addsCount}/-${removesCount}, clearAll=${isClearAll})`, "error");
      ctx.state = "exec_fail";
      const core = await import("./core.js");
      await core.executeAgentAction();
      return;
    }

    const merged = applyAttendeeDelta(
      base,
      editArgs.add_attendees || [],
      editArgs.remove_attendees || []
    );
    editArgs = { ...editArgs, attendees: merged };
    delete editArgs.add_attendees;
    delete editArgs.remove_attendees;
    log(
      `[CalendarEdit] resolved attendee delta (${baseSource}): base=${base.length} +${addsCount} -${removesCount} → ${merged.length}`
    );
  } else {
    // No actual delta (empty arrays or absent keys) — strip the keys so they
    // don't reach modifyCalendarEvent (which doesn't read them anyway, but
    // keeping the editArgs clean avoids surprise downstream).
    if (Array.isArray(editArgs.add_attendees) || Array.isArray(editArgs.remove_attendees)) {
      editArgs = { ...editArgs };
      delete editArgs.add_attendees;
      delete editArgs.remove_attendees;
    }
  }

  // Route by edit_scope (calendar_event_edit-v1.5.21+). Default: "all" when no
  // recurrence_id, "this_only" when recurrence_id is present (back-compat with
  // earlier schema where recurrence_id alone meant single-occurrence override).
  const explicitScope = (typeof editArgs.edit_scope === "string") ? editArgs.edit_scope : null;
  const editScope = explicitScope
    || (editArgs.recurrence_id ? "this_only" : "all");
  if (editScope !== "all" && !editArgs.recurrence_id) {
    agentBubble.classList.remove("loading");
    const failMsg = `edit_scope='${editScope}' requires recurrence_id (the start datetime of the target occurrence).`;
    streamText(agentBubble, failMsg);
    try { if (execPid) ctx.fsmSessions[execPid].failReason = failMsg; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

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
