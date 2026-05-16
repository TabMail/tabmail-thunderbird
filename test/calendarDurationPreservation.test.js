// calendarDurationPreservation.test.js — Tests for the
// applyDurationPreservation helper.
//
// The helper runs inside modifyCalendarEvent in tmCalendar.sys.mjs and decides
// whether to derive the missing side of start/end from the event's existing
// duration when only one side was patched.
//
// We can't `import` from tmCalendar.sys.mjs directly because TB experiment
// .sys.mjs files are loaded as classic scripts (not ESM), so adding `export`
// there breaks the live extension. Instead, the helper has a mirror in
// chat/experiments/tmCalendar/durationPreservationLogic.js that vitest CAN
// import. The "function body parity" test below pins the two implementations
// byte-for-byte so they cannot drift.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { applyDurationPreservation } from "../chat/experiments/tmCalendar/durationPreservationLogic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Duck-typed calIDateTime / calIDuration mocks ----------
// The helper only uses these shapes:
//   calIDuration: { isNegative (mutable), clone() }
//   calIDateTime: { clone(), subtractDate(other), addDuration(dur) }
// We back both by an internal `_ms` field so the math is observable.
function makeDur(ms) {
  return {
    _ms: ms,
    get isNegative() { return this._ms < 0; },
    set isNegative(v) {
      const wantNegative = !!v;
      const currentlyNegative = this._ms < 0;
      if (wantNegative !== currentlyNegative) this._ms = -this._ms;
    },
    get inSeconds() { return Math.floor(this._ms / 1000); },
    clone() { return makeDur(this._ms); },
  };
}
function makeDt(ms) {
  return {
    _ms: ms,
    clone() { return makeDt(this._ms); },
    subtractDate(other) { return makeDur(this._ms - other._ms); },
    addDuration(dur) { this._ms += dur._ms; },
  };
}

// 30-min meeting at "10:00" (= 0 ms) → "10:30" (= 1_800_000 ms)
const MIN_30 = 30 * 60 * 1000;
const MIN_45 = 45 * 60 * 1000;

function mkBase() {
  return { startDate: makeDt(0), endDate: makeDt(MIN_30) };
}
function mkClone() { return { startDate: null, endDate: null }; }

// toCalIDateTime stub returns a tagged value keyed by the iso string so we can
// assert which side got patched independently.
const PATCHED_START_MS = 60 * 60 * 1000; // 1h later
const PATCHED_END_MS   = 90 * 60 * 1000; // 1.5h later
const toCalIDateTime = (iso) => {
  if (iso === "2026-01-01T11:00:00") return makeDt(PATCHED_START_MS);
  if (iso === "2026-01-01T11:30:00") return makeDt(PATCHED_END_MS);
  return null;
};

// ---------- Tests ----------

describe("applyDurationPreservation", () => {
  it("derives endDate from new start + existing duration when only start_iso is patched", () => {
    const base = mkBase();
    const clone = mkClone();
    const result = applyDurationPreservation({
      base, clone,
      patch: { start_iso: "2026-01-01T11:00:00" },
      toCalIDateTime,
      editTzOverride: null,
    });
    expect(result.derived).toBe("end");
    expect(clone.startDate._ms).toBe(PATCHED_START_MS);
    expect(clone.endDate._ms).toBe(PATCHED_START_MS + MIN_30); // 30-min duration preserved
  });

  it("derives startDate from new end - existing duration when only end_iso is patched", () => {
    const base = mkBase();
    const clone = mkClone();
    const result = applyDurationPreservation({
      base, clone,
      patch: { end_iso: "2026-01-01T11:30:00" },
      toCalIDateTime,
      editTzOverride: null,
    });
    expect(result.derived).toBe("start");
    expect(clone.endDate._ms).toBe(PATCHED_END_MS);
    expect(clone.startDate._ms).toBe(PATCHED_END_MS - MIN_30); // 30-min duration preserved
  });

  it("does NOT derive when both start_iso and end_iso are patched (LLM explicitly setting length)", () => {
    const base = mkBase();
    const clone = mkClone();
    const result = applyDurationPreservation({
      base, clone,
      patch: { start_iso: "2026-01-01T11:00:00", end_iso: "2026-01-01T11:30:00" },
      toCalIDateTime,
      editTzOverride: null,
    });
    expect(result.derived).toBeNull();
    expect(clone.startDate._ms).toBe(PATCHED_START_MS);
    expect(clone.endDate._ms).toBe(PATCHED_END_MS);
  });

  it("does NOT mutate clone when neither start_iso nor end_iso is patched", () => {
    const base = mkBase();
    const clone = mkClone();
    const result = applyDurationPreservation({
      base, clone,
      patch: { title: "renamed" },
      toCalIDateTime,
      editTzOverride: null,
    });
    expect(result.derived).toBeNull();
    expect(clone.startDate).toBeNull();
    expect(clone.endDate).toBeNull();
  });

  it("does NOT derive when the source event has zero or negative duration", () => {
    // Bad data: end == start. Don't pretend the event has a meaningful length.
    const base = { startDate: makeDt(0), endDate: makeDt(0) };
    const clone = mkClone();
    const result = applyDurationPreservation({
      base, clone,
      patch: { start_iso: "2026-01-01T11:00:00" },
      toCalIDateTime,
      editTzOverride: null,
    });
    expect(result.derived).toBeNull();
    expect(clone.startDate._ms).toBe(PATCHED_START_MS);
    expect(clone.endDate).toBeNull();
  });

  it("preserves a 45-min duration symmetrically when end moves", () => {
    const base = { startDate: makeDt(0), endDate: makeDt(MIN_45) };
    const clone = mkClone();
    const result = applyDurationPreservation({
      base, clone,
      patch: { end_iso: "2026-01-01T11:30:00" },
      toCalIDateTime,
      editTzOverride: null,
    });
    expect(result.derived).toBe("start");
    expect(clone.startDate._ms).toBe(PATCHED_END_MS - MIN_45);
    expect(clone.endDate._ms).toBe(PATCHED_END_MS);
  });

  it("flips all_day flag onto patched start when patch.all_day is true", () => {
    const base = mkBase();
    const clone = mkClone();
    applyDurationPreservation({
      base, clone,
      patch: { start_iso: "2026-01-01T11:00:00", all_day: true },
      toCalIDateTime,
      editTzOverride: null,
    });
    expect(clone.startDate.isDate).toBe(true);
  });

  it("captures origDuration before mutating clone — bridge order does not matter", () => {
    // Regression: if origDuration were read AFTER clone.startDate was reassigned,
    // base.endDate.subtractDate(base.startDate) would still work (we read from
    // base, not clone), but a future refactor could break this. Verify behavior
    // is unchanged when base and clone start with different shapes.
    const base = { startDate: makeDt(0), endDate: makeDt(MIN_30) };
    const clone = { startDate: makeDt(99999), endDate: makeDt(99999) };
    const result = applyDurationPreservation({
      base, clone,
      patch: { start_iso: "2026-01-01T11:00:00" },
      toCalIDateTime,
      editTzOverride: null,
    });
    expect(result.derived).toBe("end");
    expect(clone.startDate._ms).toBe(PATCHED_START_MS);
    expect(clone.endDate._ms).toBe(PATCHED_START_MS + MIN_30);
  });

  it("invokes log callback with descriptive message on derivation", () => {
    const base = mkBase();
    const clone = mkClone();
    const log = vi.fn();
    applyDurationPreservation({
      base, clone,
      patch: { start_iso: "2026-01-01T11:00:00" },
      toCalIDateTime,
      editTzOverride: null,
      log,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("derived endDate from new start + existing duration")
    );
  });
});

// ---------- Drift guard ----------
// The same applyDurationPreservation function exists in two places (see file
// header for why). This test pins the function-body region byte-for-byte so a
// change to one without the other fails the build.

function extractApplyDurationBody(source) {
  // Capture from the leading "function applyDurationPreservation(" through the
  // first standalone closing brace at column 1. Excludes leading comments so
  // we're only comparing executable code.
  const start = source.indexOf("function applyDurationPreservation(");
  if (start < 0) throw new Error("applyDurationPreservation not found in source");
  // Walk forward through balanced braces from the first '{' after `start`.
  let i = source.indexOf("{", start);
  if (i < 0) throw new Error("opening brace not found");
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error("unbalanced braces in applyDurationPreservation");
}

describe("applyDurationPreservation drift guard", () => {
  it("function body in durationPreservationLogic.js matches tmCalendar.sys.mjs", () => {
    const sysSrc = readFileSync(
      resolve(__dirname, "../chat/experiments/tmCalendar/tmCalendar.sys.mjs"),
      "utf-8"
    );
    const mirrorSrc = readFileSync(
      resolve(__dirname, "../chat/experiments/tmCalendar/durationPreservationLogic.js"),
      "utf-8"
    );
    // The mirror file has `export function applyDurationPreservation(` — strip
    // the `export ` prefix before comparing.
    const mirrorBody = extractApplyDurationBody(mirrorSrc.replace(/\bexport function applyDurationPreservation\(/, "function applyDurationPreservation("));
    const sysBody = extractApplyDurationBody(sysSrc);
    expect(mirrorBody).toBe(sysBody);
  });
});
