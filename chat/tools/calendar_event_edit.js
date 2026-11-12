/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendar_event_edit.js – edits an existing calendar event (FSM tool)

// FSM tool — requires user confirmation before executing.
// `fsm = true` lets core.js classify this tool as FSM (multi-step / confirmation-required).
export const fsm = true;

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { toNaiveIso } from "../modules/helpers.js";
import { shownEventTimesIso } from "./calendar_event_read.js";
import { isClearRecurrence, otherPartsRefusal, recurrenceArgError } from "../modules/recurrence.js";

function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};
  
  // event_id is required for edit operations
  if (typeof a.event_id === "string" && a.event_id) out.event_id = a.event_id;
  
  // calendar_id is OPTIONAL — provided as a hint for faster lookup. When omitted,
  // the tmCalendar bridge auto-scans every calendar to find the event_id.
  if (typeof a.calendar_id === "string" && a.calendar_id) out.calendar_id = a.calendar_id;
  
  // recurrence_id — the start datetime of a specific occurrence (RECURRENCE-ID).
  // Required when edit_scope is "this_only" or "this_and_following".
  if (typeof a.recurrence_id === "string" && a.recurrence_id) out.recurrence_id = toNaiveIso(a.recurrence_id);

  // edit_scope (v1.5.21+) — "all" | "this_only" | "this_and_following".
  // Normalize to the supported set; default is inferred at exec time (see calendarEdit.js).
  if (typeof a.edit_scope === "string") {
    const s = a.edit_scope.toLowerCase().trim();
    if (s === "all" || s === "this_only" || s === "this_and_following") {
      out.edit_scope = s;
    }
  }
  
  // Keep only the fields the edit gives a usable value for (a location or notes
  // given as a string count, "" included; see below)
  if (typeof a.title === "string" && a.title) out.title = a.title;
  // Normalize ISO strings to naive format (remove timezone offsets); a time
  // given with a timezone keeps its digits, that zone's wall clock.
  const zone = typeof a.timezone === "string" && a.timezone ? a.timezone : undefined;
  if (typeof a.start_iso === "string" && a.start_iso) out.start_iso = toNaiveIso(a.start_iso, zone);
  if (typeof a.end_iso === "string" && a.end_iso) out.end_iso = toNaiveIso(a.end_iso, zone);
  if (typeof a.all_day === "boolean") out.all_day = a.all_day;
  // A location or notes the edit gives as a string is named, "" included: "" clears
  // the field (omitting it keeps it), as the bridge and the schema read it.
  if (typeof a.location === "string") out.location = a.location;
  if (typeof a.description === "string") out.description = a.description;
  if (typeof a.transparency === "string") {
    const t = a.transparency.toLowerCase();
    if (t === "busy" || t === "free") out.transparency = t;
  }
  
  // Attendees are delta-based (calendar_event_edit-v1.5.21+):
  //   add_attendees: [{email, name?}] — appended to existing list
  //   remove_attendees: [{email}]   — dropped from existing list ("*" = clear all)
  // They go to browser.tmCalendar.modifyCalendarEvent as given; the bridge applies
  // them to each item the edit covers. Legacy whole-list `attendees` is intentionally NOT accepted here; the
  // backend version-pins older clients to the v1.5.7 schema instead.
  if (Array.isArray(a.add_attendees)) {
    out.add_attendees = a.add_attendees
      .filter(Boolean)
      .map((p) => ({
        email: typeof p?.email === "string"
          ? p.email
          : (typeof p === "string" ? p : ""),
        name: typeof p?.name === "string" ? p.name : "",
      }))
      .filter((p) => p.email && p.email !== "*");
  }
  if (Array.isArray(a.remove_attendees)) {
    out.remove_attendees = a.remove_attendees
      .filter(Boolean)
      .map((p) => ({
        email: typeof p?.email === "string"
          ? p.email
          : (typeof p === "string" ? p : ""),
      }))
      .filter((p) => p.email);
  }
  
  // The organizer the guests' update comes from
  if (typeof a.organizer_email === "string" && a.organizer_email) {
    out.organizer_email = a.organizer_email;
  }
  
  // Recurrence (pass-through; checked by recurrenceArgError before the card).
  // `null` is the same as omitting it: keep the rule.
  if (a && a.recurrence !== undefined && a.recurrence !== null) {
    out.recurrence = a.recurrence;
  }
  
  // EXDATE additions (exclude specific occurrences)
  if (Array.isArray(a.exdates_add)) {
    out.exdates_add = a.exdates_add.filter(Boolean).map((v) => String(v));
  }

  // Timezone override (IANA identifier)
  if (typeof a.timezone === "string" && a.timezone) out.timezone = a.timezone;

  return out;
}

// The fields an edit names (title, location, description, busy/free) whose
// given value is the one `details` already holds: the event as
// getCalendarEventDetails reads it, for a whole series the series, or, on an
// edit of one occurrence or a split, the occurrence it names (its own values
// when it was changed on its own, #369). The one comparison of a field with
// the stored value: the confirmation card shows no line for these fields, and
// the tool drops them before the check on every scope, so the write changes
// nothing the card does not show, and an edit that gives only what the event
// already has changes nothing. An occurrence changed on its own then keeps its
// own value of a field the edit only restates, as Google Calendar leaves it
// when the field is not changed in its form (whose values, opened from an
// occurrence, are that occurrence's).
export function restatedFields(editArgs, details) {
  const a = editArgs || {};
  const d = details || {};
  const busyOrFree = (t) => (t === "free" ? "free" : "busy");
  const holds = {
    title: Boolean(a.title) && a.title === d.title,
    location: typeof a.location === "string" && a.location === (d.location || ""),
    description: typeof a.description === "string" && a.description === (d.description || ""),
    transparency: typeof a.transparency === "string" && typeof d.transparency === "string"
      && busyOrFree(a.transparency) === busyOrFree(d.transparency),
  };
  return Object.keys(holds).filter((field) => holds[field]);
}
const RESTATABLE_FIELDS = ["title", "location", "description", "transparency"];

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
  // Mark FSM context + init the session BEFORE validation so any early-return
  // failure path can set failReason and drive `exec_fail` — otherwise the
  // converse-side waiter at converse.js:655 sits forever (see
  // CalendarEditStuckBug). Mirrors calendar_event_create's structure.
  try { ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null; } catch (_) {}
  ctx.toolExecutionMode = "calendar_event_edit";
  const pid = ctx.activeToolCallId || 0;
  try {
    if (pid) {
      initFsmSession(pid, "calendar_event_edit");
      log(`[TMDBG Tools] calendar_event_edit: Initialized FSM session with system prompt for pid=${pid}`);
      ctx.activePid = pid;
      ctx.awaitingPid = pid;
    }
  } catch (_) {}

  const failOut = async (reason) => {
    log(`[TMDBG Tools] calendar_event_edit: ${reason}`, "error");
    try {
      if (pid && ctx.fsmSessions[pid]) ctx.fsmSessions[pid].failReason = reason;
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
  };

  // Validation of bridge and arguments
  if (!browser?.tmCalendar?.modifyCalendarEvent) {
    await failOut("Calendar bridge not available");
    return;
  }

  const norm = normalizeArgs(args);

  // A date the tool cannot read (toNaiveIso gives null) is refused, never
  // replaced by a guess.
  const badDate = ["start_iso", "end_iso", "recurrence_id"].find((f) => typeof args?.[f] === "string" && args[f].trim() && !norm[f]);
  if (badDate) {
    await failOut(`${badDate} "${args[badDate]}" is not a date and time the calendar can read. Use YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD for a date, then retry.`);
    return;
  }

  if (!norm.event_id) {
    await failOut("event_id is required. Use calendar_search or calendar_read to look up the event_id of the calendar event you want to edit, then retry.");
    return;
  }

  // A rule written onto one occurrence is never expanded by Thunderbird, so the
  // edit would report success while the series keeps its rule. Refused before
  // the confirmation card, with the scope resolved as the bridge resolves it.
  const editsOneOccurrence = (norm.edit_scope || (norm.recurrence_id ? "this_only" : "all")) === "this_only";
  if (editsOneOccurrence && "recurrence" in norm) {
    await failOut("recurrence cannot be set on one occurrence (edit_scope 'this_only', or a recurrence_id without edit_scope). To change the repeat rule, use edit_scope 'all' for the whole series, or 'this_and_following' with the recurrence_id to change it from that occurrence on.");
    return;
  }

  // A rule the tool cannot write is refused before the confirmation card, so
  // the model can correct it instead of a part being silently dropped.
  if ("recurrence" in norm) {
    const recurrenceError = recurrenceArgError(norm.recurrence, { canClear: true });
    if (recurrenceError) {
      await failOut(recurrenceError);
      return;
    }
  }

  // Restating the rule of a series whose stored rule has parts the tool cannot
  // express would drop those parts, so that edit is refused too, as is a
  // restatement when the stored rule cannot be read.
  if ("recurrence" in norm && !isClearRecurrence(norm.recurrence)) {
    const stored = await safeFetchEventDetails(norm.event_id, norm.calendar_id);
    const refusal = stored?.ok
      ? otherPartsRefusal(norm.recurrence, stored.recurrence)
      : `could not read this event's current repeat rule (${stored?.error || "unknown error"}); try again`;
    if (refusal) {
      await failOut(refusal);
      return;
    }
  }

  // A whole-series time change works as calendar apps do (#287): named from
  // the series' first occurrence it moves the whole series; named from a later
  // one it changes that occurrence and the following ones; with no occurrence
  // named and a date other than the series' own, the user is asked which.
  const routing = await routeSeriesTimeChange(norm);
  if (routing) {
    await failOut(routing);
    return;
  }

  // The event as the confirmation card shows it: the series on an edit of the
  // whole series, else the occurrence the edit names (#369). A field the edit
  // only restates (restatedFields, the card's own comparison) is dropped here,
  // on every scope, before the check, so the card, the check and the write see
  // the same edit: an occurrence changed on its own keeps its own value of that
  // field. When the event cannot be read, the edit is refused after the check,
  // so the check's own refusal (an event that does not exist) comes first.
  const scope = norm.edit_scope || (norm.recurrence_id ? "this_only" : "all");
  const cardDetailsArgs = [norm.event_id, norm.calendar_id, scope !== "all" ? norm.recurrence_id : null];
  let cardDetails = null;
  let unreadable = null;
  if (RESTATABLE_FIELDS.some((field) => field in norm)) {
    cardDetails = await safeFetchEventDetails(...cardDetailsArgs);
    if (cardDetails?.ok) {
      for (const field of restatedFields(norm, cardDetails)) delete norm[field];
    } else {
      unreadable = `could not read this event (${cardDetails?.error || "unknown error"}); try again`;
    }
  }

  // Every edit the bridge would refuse (a scope with no occurrence named, an
  // occurrence or excluded date that names none, invitations with no guests,
  // an all-day event given a time of day without all_day, a move the series'
  // rule cannot follow, an event it cannot find, ...) is refused here, before
  // the confirmation card, so the assistant can react: ask the user, or
  // correct the call. The bridge runs the same edit, on the scope routed above,
  // up to its first write and writes nothing (check_only), so each rule lives
  // in one place. The check also says whether the edit changes anything (a
  // time or field it only restates is no change), the times the card shows,
  // and whether a new start resets changed occurrences; so a check that
  // throws or answers nothing refuses the edit before the card.
  let check = null;
  try {
    check = await browser.tmCalendar.modifyCalendarEvent({ ...norm, check_only: true });
    if (!check) throw new Error("no answer");
  } catch (e) {
    await failOut(`the calendar could not check this edit (${e}); try again`);
    return;
  }
  if (check.ok === false) {
    await failOut(String(check.error || "the calendar refused this edit"));
    return;
  }
  if (unreadable) {
    await failOut(unreadable);
    return;
  }
  // Nothing to write: the assistant is told so, with no card and no write.
  if (check.changes === false) {
    log(`[TMDBG Tools] calendar_event_edit: the edit changes nothing; no card shown`);
    try {
      if (pid && ctx.fsmSessions[pid]) ctx.fsmSessions[pid].editNoChange = true;
    } catch (_) {}
    ctx.state = "exec_success";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }
  try {
    if (pid && ctx.fsmSessions[pid]) {
      ctx.fsmSessions[pid].editTimes = check.times;
      ctx.fsmSessions[pid].editResetsChangedOccurrences = check.resetsChangedOccurrences === true;
    }
  } catch (_) {}

  // calendar_id is OPTIONAL — the bridge (tmCalendar.modifyCalendarEvent) auto-scans
  // every calendar when none is supplied (see tmCalendar.sys.mjs lines 1340-1369).
  // Don't reject here; the schema description tells the LLM the system will resolve
  // it, and matching that contract avoids consecutive-FSM-style retry loops where
  // the LLM has to call calendar_search just to fetch a calendar_id it already
  // implicitly knows from prior context.

  // Auto-extract organizer email from calendar if a calendar_id was provided.
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

  // Enter FSM state and stash edit args
  ctx.state = "calendar_event_edit_list";
  try {
    if (pid && ctx.fsmSessions[pid]) {
      ctx.fsmSessions[pid].editEventArgs = norm;
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

  // Optionally validate existence of event here by fetching details. A split
  // names its occurrence, so the card can state that occurrence's original
  // time when it was moved off it.
  try {
    const details = cardDetails || await safeFetchEventDetails(...cardDetailsArgs);
    if (details && details.ok) {
      try { const pid = ctx.activePid || ctx.activeToolCallId || 0; if (pid) ctx.fsmSessions[pid].editEventDetails = details; } catch (_) {}
      log(`[TMDBG Tools] calendar_event_edit: pre-fetched event details for id=${norm.event_id}`);
    } else {
      log(`[TMDBG Tools] calendar_event_edit: event details not confirmed pre-list: ${(details && details.error) || "unknown"}`, "warn");
    }
  } catch (e) {
    log(`[TMDBG Tools] calendar_event_edit: failed to prefetch details: ${e}`, "warn");
  }

  // Use the agent bubble from tool orchestration
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(`[TMDBG Tools] calendar_event_edit: No agent bubble provided, creating fallback`, "warn");
    agentBubble = await createNewAgentBubble("Preparing edit preview...");
  }

  // Kick off FSM immediately now that waiter should be registered
  const core = await import("../fsm/core.js");
  await core.executeAgentAction();
}

const ASK_WHICH_OCCURRENCES = "ask the user whether they mean just that date, or that date and every later one; then pass recurrence_id (the occurrence's start_iso as calendar_event_read shows it) with edit_scope 'this_only' or 'this_and_following'";

// Routes a time change of a repeating series whose scope resolves to "all":
// rewrites norm.edit_scope to "this_and_following" when recurrence_id names a
// later occurrence, and returns the question for the user when it cannot tell
// which occurrences are meant (or that the event could not be read), or null.
// What the bridge refuses (a recurrence_id that names no occurrence, a new
// rule with a move to another day) is left to its check, which reads the
// series in its own zone.
async function routeSeriesTimeChange(norm) {
  const scope = norm.edit_scope || (norm.recurrence_id ? "this_only" : "all");
  if (scope !== "all" || !(norm.start_iso || norm.end_iso)) return null;
  if ("recurrence" in norm && isClearRecurrence(norm.recurrence)) return null;
  const details = await safeFetchEventDetails(norm.event_id, norm.calendar_id, norm.recurrence_id);
  if (!details?.ok) return `could not read this event (${details?.error || "unknown error"}); try again`;
  if (!details.isRecurring) return null;
  if (norm.recurrence_id) {
    if (details.recurrenceIdIsFirst === false) norm.edit_scope = "this_and_following";
    return null;
  }
  const shown = shownEventTimesIso(details);
  const [given, own] = norm.start_iso ? [norm.start_iso, shown.start_iso] : [norm.end_iso, shown.end_iso];
  return given.slice(0, 10) === own.slice(0, 10) ? null : ASK_WHICH_OCCURRENCES;
}

async function safeFetchEventDetails(eventId, calendarId = null, recurrenceId = null) {
  try {
    if (browser?.tmCalendar?.getCalendars && browser?.tmCalendar?.queryCalendarItems) {
      // Use experimental helper if exposed (later we can add a dedicated getEventDetails)
      // For now, try a broad query of today and match id client-side if available in cache
      // but primary path: use a dedicated bridge call if present
      if (typeof browser.tmCalendar.getCalendarEventDetails === "function") {
        if (recurrenceId) {
          return await browser.tmCalendar.getCalendarEventDetails(String(eventId), String(calendarId || ""), String(recurrenceId));
        }
        return calendarId
          ? await browser.tmCalendar.getCalendarEventDetails(String(eventId), String(calendarId))
          : await browser.tmCalendar.getCalendarEventDetails(String(eventId));
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

  // The check found nothing to write (see _runEditCalendarEvent).
  if (sess?.editNoChange) {
    log(`[TMDBG Tools] calendar_event_edit.completeExecution: nothing changed`);
    return { ok: true, result: "Nothing changed: the event already has every time and value this edit gives, so nothing was written and no confirmation was shown." };
  }
  
  if (prevState === "calendar_event_edit_exec" && sess?.editResult) {
    log(`[TMDBG Tools] calendar_event_edit.completeExecution: edited event successfully scope=${sess.editResult.edit_scope}`);
    // Echo the RESOLVED edit_scope (+ recurrence_id) back to the LLM so it can
    // accurately tell the user what slice of the series changed — especially
    // the inferred case (recurrence_id without edit_scope → "this_only").
    const scope = sess.editResult.edit_scope || "all";
    const rid = sess.editResult.named_recurrence_id;
    let result;
    if (scope === "this_only") {
      result = `Calendar event modified successfully — edit_scope: this_only (only the occurrence on ${rid}; other occurrences untouched).`;
    } else if (scope === "this_and_following") {
      result = `Calendar event modified successfully — edit_scope: this_and_following (this and all later occurrences from ${rid}; earlier ones untouched).`;
    } else {
      result = "Calendar event modified successfully — edit_scope: all (the entire event/series).";
    }
    return {
      ok: true,
      result,
      event_id: sess.editResult.event_id,
      event_title: sess.editResult.event_title,
      calendar_id: sess.editResult.calendar_id,
      edit_scope: scope,
      recurrence_id: sess.editResult.recurrence_id,
      invitations: sess.editResult.invitations,
    };
  }
  
  log(`[TMDBG Tools] calendar_event_edit.completeExecution: completed`);
  return { ok: true, result: "Edit workflow completed." };
}

export const _testExports = { normalizeArgs };
