// kbTaskParser.js – Parse [Task] entries from KB text
// Thunderbird 145 MV3
// Format: [Task] Schedule <days> <HH:MM> [<timezone>], <instruction>
//         [Task] Once <YYYY/MM/DD> <HH:MM> [<timezone>], <instruction>
// Analogous to kbReminderGenerator.js but for scheduled task entries.

import { log } from "./utils.js";

/**
 * Regex to match recurring task entries with optional bullet prefix and optional timezone.
 * Groups:
 *   1: days (e.g., "daily", "weekdays", "weekends", "mon,wed,fri")
 *   2: HH
 *   3: MM
 *   4: timezone (optional, inside brackets)
 *   5: instruction text
 */
const TASK_SCHEDULE_REGEX = /^(?:-\s*)?\[Task\]\s*Schedule\s+([\w,]+)\s+(\d{2}):(\d{2})(?:\s+\[([^\]]+)\])?,\s*(.+)$/i;

/**
 * Regex to match one-off task entries with optional bullet prefix and optional timezone.
 * Groups:
 *   1: date (YYYY/MM/DD)
 *   2: HH
 *   3: MM
 *   4: timezone (optional, inside brackets)
 *   5: instruction text
 */
const TASK_ONCE_REGEX = /^(?:-\s*)?\[Task\]\s*Once\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}):(\d{2})(?:\s+\[([^\]]+)\])?,\s*(.+)$/i;

/**
 * Parse [Task] entries from KB text.
 * Handles both bullet ("- [Task] ...") and non-bullet ("[Task] ...") prefixes.
 * Handles both recurring ("Schedule") and one-off ("Once") entries.
 * Gracefully skips malformed lines with a warning log.
 *
 * @param {string} kbText - Raw KB text content
 * @returns {Array<{instruction: string, scheduleDays: string|null, scheduleDate: string|null, scheduleTime: string, timezone: string|null, rawLine: string, kind: "recurring"|"once"}>}
 */
export function parseTasksFromKB(kbText) {
  if (!kbText || !kbText.trim()) {
    return [];
  }

  const results = [];
  const lines = kbText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Quick check: skip lines that don't mention [Task]
    if (!trimmed.includes("[Task]") && !trimmed.includes("[task]")) {
      continue;
    }

    // Try recurring pattern first
    const scheduleMatch = trimmed.match(TASK_SCHEDULE_REGEX);
    if (scheduleMatch) {
      const [, daysStr, hour, minute, timezone, instruction] = scheduleMatch;
      const expandedDays = expandDays(daysStr.toLowerCase());

      if (expandedDays.length === 0) {
        log(`[TaskParser] Skipping task with unrecognized days "${daysStr}": "${trimmed}"`, "warn");
        continue;
      }

      // Store the raw days string (e.g., "weekdays", "mon,wed,fri"), not the expanded array.
      // The scheduler's resolveScheduleDays() does its own expansion.
      results.push({
        instruction: instruction.trim(),
        scheduleDays: daysStr.toLowerCase().trim(),
        scheduleDate: null,
        scheduleTime: `${hour}:${minute}`,
        timezone: timezone || null,
        rawLine: trimmed,
        kind: "recurring",
      });
      continue;
    }

    // Try one-off pattern
    const onceMatch = trimmed.match(TASK_ONCE_REGEX);
    if (onceMatch) {
      const [, dateStr, hour, minute, timezone, instruction] = onceMatch;

      results.push({
        instruction: instruction.trim(),
        scheduleDays: null,
        scheduleDate: dateStr,
        scheduleTime: `${hour}:${minute}`,
        timezone: timezone || null,
        rawLine: trimmed,
        kind: "once",
      });
      continue;
    }

    log(`[TaskParser] Skipping malformed task line: "${trimmed}"`, "warn");
  }

  log(`[TaskParser] Parsed ${results.length} task entries from KB`);
  return results;
}

/**
 * Expand day specifiers into arrays of lowercase day abbreviations.
 * @param {string} daysStr - e.g., "daily", "weekdays", "weekends", "mon,wed,fri"
 * @returns {string[]} Array of day abbreviations (e.g., ["mon", "tue", ...])
 */
function expandDays(daysStr) {
  const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
  const WEEKENDS = ["sat", "sun"];

  if (daysStr === "daily") return ALL_DAYS;
  if (daysStr === "weekdays") return WEEKDAYS;
  if (daysStr === "weekends") return WEEKENDS;

  // Comma-separated day abbreviations
  const parts = daysStr.split(",").map((d) => d.trim());
  const valid = parts.filter((d) => ALL_DAYS.includes(d));
  return valid;
}

/**
 * Generate a stable hash for a task entry's instruction text.
 * Uses the same DJB2 algorithm as reminderStateStore.js (charCodeAt for UTF-16 parity with iOS).
 * Returns `t:{hash.toString(36)}` to distinguish from KB reminder hashes (`k:` prefix).
 *
 * @param {Object} taskEntry - Task entry object with `instruction` field
 * @returns {string} Hash string in format "t:{base36hash}"
 */
export function getTaskHash(taskEntry) {
  // Hash the full entry (instruction + schedule) so tasks with the same
  // instruction but different times get unique hashes.
  const str = taskEntry.rawLine || taskEntry.instruction || "";
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `t:${hash.toString(36)}`;
}
