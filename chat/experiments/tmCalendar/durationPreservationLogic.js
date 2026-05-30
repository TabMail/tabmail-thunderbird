/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// durationPreservationLogic.js — test-loadable mirror of the
// applyDurationPreservation function in tmCalendar.sys.mjs.
//
// Why a mirror: TB experiment .sys.mjs files are loaded as classic scripts,
// not ESM modules, so the sys.mjs cannot use `export` (parse error breaks the
// entire tmCalendar API at runtime). This file holds the same function
// definition with `export` so vitest can import and exercise it.
//
// Drift guard: test/calendarDurationPreservation.test.js reads both files,
// extracts the function-body region, and asserts byte-equality. Any change to
// one must be replicated in the other or the test fails.

// ----- function applyDurationPreservation — keep in sync with tmCalendar.sys.mjs -----
export function applyDurationPreservation({
  base,
  clone,
  patch,
  toCalIDateTime,
  editTzOverride,
  log = () => {},
}) {
  // Capture original duration BEFORE we touch clone.startDate/endDate. Once
  // either side is reassigned the subtractDate result no longer reflects the
  // event's original length.
  let origDuration = null;
  try {
    if (base && base.startDate && base.endDate) {
      origDuration = base.endDate.subtractDate(base.startDate);
      // Skip derivation if duration is zero or negative. Mirrors iOS
      // GoogleCalendarProvider.mergeExistingEventWithPatch (`d > 0 ? d : nil`).
      // calIDuration exposes `.inSeconds`; the mock backs it the same way.
      if (origDuration) {
        const seconds = typeof origDuration.inSeconds === "number" ? origDuration.inSeconds : null;
        if (origDuration.isNegative || seconds === 0) origDuration = null;
      }
    }
  } catch (_) {
    origDuration = null;
  }

  const hasStartPatch = typeof patch.start_iso === "string" && !!patch.start_iso;
  const hasEndPatch = typeof patch.end_iso === "string" && !!patch.end_iso;

  if (hasStartPatch) {
    const s = toCalIDateTime(String(patch.start_iso), editTzOverride);
    if (s) {
      if (patch.all_day) s.isDate = true;
      clone.startDate = s;
    }
  }
  if (hasEndPatch) {
    const e = toCalIDateTime(String(patch.end_iso), editTzOverride);
    if (e) {
      if (patch.all_day) e.isDate = true;
      clone.endDate = e;
    }
  }

  if (hasStartPatch && !hasEndPatch && origDuration) {
    try {
      const newEnd = clone.startDate.clone();
      newEnd.addDuration(origDuration);
      clone.endDate = newEnd;
      log("derived endDate from new start + existing duration");
      return { derived: "end" };
    } catch (e) {
      log("failed to derive endDate from duration: " + e);
      return { derived: null, error: e };
    }
  }
  if (hasEndPatch && !hasStartPatch && origDuration) {
    try {
      const negDur = origDuration.clone();
      negDur.isNegative = !negDur.isNegative;
      const newStart = clone.endDate.clone();
      newStart.addDuration(negDur);
      clone.startDate = newStart;
      log("derived startDate from new end + existing duration");
      return { derived: "start" };
    } catch (e) {
      log("failed to derive startDate from duration: " + e);
      return { derived: null, error: e };
    }
  }
  return { derived: null };
}
// ----- end applyDurationPreservation -----
