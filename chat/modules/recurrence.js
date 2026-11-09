/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// One recurrence format for the calendar tools. The read tools show a rule in
// the same fields the create and edit tools take, so the model can pass back
// exactly what it read:
//
//   recurrence: {"freq":"WEEKLY","byDay":["MO","WE"],"until":"2099-12-31"}
//
// The calendar bridge (tmCalendar) produces that object from the stored rule;
// this module prints it and checks a `recurrence` argument before the
// confirmation card.

const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const DAY_CODE = /^(MO|TU|WE|TH|FR|SA|SU)$/;
const BY_DAY = /^[+-]?([1-9]|[1-4][0-9]|5[0-3])?(MO|TU|WE|TH|FR|SA|SU)$/;
const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export const OTHER_PARTS_NOTE = "the edit tool cannot express these; omit recurrence to keep the rule";

/** `recurrence: {...}` for calendar_event_read, or "" when the event does not repeat. */
export function formatRecurrenceLine(recurrence) {
  if (!recurrence || typeof recurrence !== "object") return "";
  const line = `recurrence: ${JSON.stringify(recurrence)}`;
  return recurrence.other ? `${line} (${OTHER_PARTS_NOTE})` : line;
}

/** ` (↻ {...})` for the calendar_search / calendar_read listing, or "". */
export function recurrenceMark(recurrence) {
  if (!recurrence || typeof recurrence !== "object") return "";
  return ` (↻ ${JSON.stringify(recurrence)})`;
}

/** True for `{}`, which clears an event's rule. */
export function isClearRecurrence(recurrence) {
  return !!recurrence && typeof recurrence === "object" && Object.keys(recurrence).length === 0;
}

function invalid(field, value, allowed) {
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  return `recurrence.${field} has an invalid value "${shown}": ${allowed}`;
}

function isValidPlainDate(s) {
  const m = PLAIN_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isPositiveInteger(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function listError(field, value, isValid, allowed) {
  if (!Array.isArray(value)) return invalid(field, value, `a list of ${allowed}`);
  for (const el of value) if (!isValid(el)) return invalid(field, el, allowed);
  return null;
}

/**
 * The tool error for a `recurrence` argument the tools cannot write, or null.
 * `{}` is valid (it clears the rule). Checked before the confirmation card, so
 * an invalid rule is refused rather than written with a part silently dropped.
 */
export function recurrenceArgError(recurrence) {
  if (!recurrence || typeof recurrence !== "object" || Array.isArray(recurrence)) {
    return `recurrence has an invalid value "${JSON.stringify(recurrence)}": an object of recurrence fields, or {} to clear the rule`;
  }
  if (isClearRecurrence(recurrence)) return null;
  const r = recurrence;
  if (!FREQS.includes(r.freq)) return invalid("freq", r.freq ?? "", `one of ${FREQS.join(", ")} (use {} to clear the rule)`);
  if ("interval" in r && !isPositiveInteger(r.interval)) return invalid("interval", r.interval, "a positive integer");
  if ("count" in r && !isPositiveInteger(r.count)) return invalid("count", r.count, "a positive integer");
  if ("until" in r) {
    const u = r.until;
    const ok = typeof u === "string" && (isValidPlainDate(u) || (DATE_TIME.test(u) && isValidPlainDate(u.slice(0, 10)) && !isNaN(new Date(u).getTime())));
    if (!ok) return invalid("until", u, "a date YYYY-MM-DD (the last day of the series)");
  }
  if ("count" in r && "until" in r) return invalid("until", r.until, "count and until cannot both be set; give one of them");
  if ("byDay" in r) {
    const e = listError("byDay", r.byDay, (v) => typeof v === "string" && BY_DAY.test(v), "day codes MO..SU, optionally with a position such as 2TU or -1FR");
    if (e) return e;
  }
  if ("byMonthDay" in r) {
    const e = listError("byMonthDay", r.byMonthDay, (v) => Number.isInteger(v) && v !== 0 && v >= -31 && v <= 31, "integers from 1 to 31 or -31 to -1");
    if (e) return e;
  }
  if ("byMonth" in r) {
    const e = listError("byMonth", r.byMonth, (v) => Number.isInteger(v) && v >= 1 && v <= 12, "integers from 1 to 12");
    if (e) return e;
  }
  if ("wkst" in r && !(typeof r.wkst === "string" && DAY_CODE.test(r.wkst))) return invalid("wkst", r.wkst, "one of MO, TU, WE, TH, FR, SA, SU");
  if ("other" in r) return invalid("other", r.other, `${OTHER_PARTS_NOTE}`);
  return null;
}

/**
 * The tool error for an edit that restates the rule of a series whose stored
 * rule has parts the tools cannot express, or null. Restating it would drop
 * those parts. `{}` (stop repeating) is not a restatement.
 */
export function otherPartsRefusal(recurrenceArg, storedRecurrence) {
  if (!recurrenceArg || isClearRecurrence(recurrenceArg)) return null;
  const parts = storedRecurrence && typeof storedRecurrence === "object" ? storedRecurrence.other : "";
  if (!parts) return null;
  return `this series repeats in a way the edit tool cannot express (${parts}); omit recurrence to keep it, or change the repeat in the calendar app`;
}
