// task_add.js – create a [Task] entry in user_kb.md with automatic formatting (TB 145, MV3)

import { SETTINGS } from "../../agent/modules/config.js";
import { applyKBPatch } from "../../agent/modules/patchApplier.js";
import { getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { log, normalizeUnicode } from "../../agent/modules/utils.js";

const VALID_DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const VALID_PRESETS = new Set(["daily", "weekdays", "weekends"]);
const MAX_TASKS = 100;

/**
 * Check if a task instruction references specific items by ID.
 * Scheduled tasks run without access to specific emails/events/contacts,
 * so the instruction must describe a general task, not point to particular items.
 * Returns an error message string if rejected, or null if OK.
 */
function _checkForIdReferences(text) {
  // Check for [Email](N) references (LLM's numeric email ID format)
  if (/\[Email\]\(\d+\)/i.test(text)) {
    return "Scheduled task instructions must not reference specific emails. Describe what to look for instead (e.g., 'check for unread emails from Alice' rather than referencing a specific email).";
  }

  // Check for [Event](N) or [Contact](N) references
  if (/\[(Event|Contact)\]\(\d+\)/i.test(text)) {
    return "Scheduled task instructions must not reference specific events or contacts by ID. Describe what to look for instead (e.g., 'check my calendar for meetings' rather than referencing a specific event).";
  }

  // Check for raw unique_id / message_id / event_id patterns that suggest item references
  if (/\b(?:unique_id|message_id|event_id|contact_id)\s*[:=]\s*\S+/i.test(text)) {
    return "Scheduled task instructions must not include item IDs (unique_id, message_id, etc.). Describe the task in general terms so it works every time it runs.";
  }

  return null; // OK
}

/**
 * Build a formatted KB task entry from structured params.
 * Includes the user's IANA timezone so the task remains correct across timezones.
 *
 * For recurring: "[Task] Schedule <schedule_days> <schedule_time> [<timezone>], <text>"
 * For one-off:   "[Task] Once <schedule_date> <schedule_time> [<timezone>], <text>"
 *
 * @param {string} text - Task description
 * @param {Object} options - { scheduleDays, scheduleDate, scheduleTime }
 * @returns {string} Formatted KB entry
 */
function formatTaskEntry(text, { scheduleDays, scheduleDate, scheduleTime }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (scheduleDate) {
    return `[Task] Once ${scheduleDate} ${scheduleTime} [${tz}], ${text}`;
  }
  return `[Task] Schedule ${scheduleDays} ${scheduleTime} [${tz}], ${text}`;
}

export { formatTaskEntry as _testFormatTaskEntry };

/**
 * Validate schedule_days: must be "daily", "weekdays", "weekends",
 * or a comma-separated list of mon/tue/wed/thu/fri/sat/sun.
 */
function validateScheduleDays(raw) {
  const val = raw.toLowerCase().trim();
  if (VALID_PRESETS.has(val)) return val;

  const parts = val.split(",").map(d => d.trim());
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (!VALID_DAYS.has(part)) return null;
  }
  return parts.join(",");
}

/**
 * Validate schedule_date: must be YYYY/MM/DD format.
 */
function validateScheduleDate(raw) {
  const val = raw.trim();
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(val)) return null;

  // Verify it's a valid date
  const [year, month, day] = val.split("/").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return val;
}

export async function run(args = {}, options = {}) {
  try {
    const rawText = typeof args?.text === "string" ? args.text : "";
    const text = normalizeUnicode(rawText || "").trim();
    if (!text) {
      log(`[TMDBG Tools] task_add: missing or empty 'text'`, "error");
      return { error: "missing text" };
    }

    // Reject instructions that reference specific emails, events, or contacts by ID.
    // Scheduled tasks run in the background without access to any specific items —
    // the instruction must be self-contained and describe WHAT to do, not WHICH item.
    const idRefError = _checkForIdReferences(text);
    if (idRefError) {
      log(`[TMDBG Tools] task_add: rejected — instruction references specific items: ${idRefError}`, "error");
      return { error: idRefError };
    }

    // Determine if recurring or one-off
    const rawDays = typeof args?.schedule_days === "string" ? args.schedule_days : "";
    const rawDate = typeof args?.schedule_date === "string" ? args.schedule_date : "";

    // Mutually exclusive validation
    if (rawDays.trim() && rawDate.trim()) {
      log(`[TMDBG Tools] task_add: both schedule_days and schedule_date provided`, "error");
      return { error: "schedule_days and schedule_date are mutually exclusive. Provide one or the other." };
    }

    if (!rawDays.trim() && !rawDate.trim()) {
      log(`[TMDBG Tools] task_add: neither schedule_days nor schedule_date provided`, "error");
      return { error: "missing schedule_days or schedule_date. Provide schedule_days for recurring tasks, or schedule_date for one-off tasks." };
    }

    let scheduleDays = null;
    let scheduleDate = null;

    if (rawDays.trim()) {
      scheduleDays = validateScheduleDays(rawDays);
      if (!scheduleDays) {
        log(`[TMDBG Tools] task_add: invalid schedule_days '${rawDays}'`, "error");
        return { error: "invalid schedule_days, expected daily, weekdays, weekends, or comma-separated mon/tue/wed/thu/fri/sat/sun" };
      }
    }

    if (rawDate.trim()) {
      scheduleDate = validateScheduleDate(rawDate);
      if (!scheduleDate) {
        log(`[TMDBG Tools] task_add: invalid schedule_date '${rawDate}'`, "error");
        return { error: "invalid schedule_date, expected YYYY/MM/DD format with a valid date" };
      }
    }

    // Validate schedule_time (HH:MM)
    const rawTime = typeof args?.schedule_time === "string" ? args.schedule_time : "";
    if (!rawTime.trim()) {
      log(`[TMDBG Tools] task_add: missing 'schedule_time'`, "error");
      return { error: "missing schedule_time" };
    }
    if (!/^\d{2}:\d{2}$/.test(rawTime.trim())) {
      log(`[TMDBG Tools] task_add: invalid schedule_time format '${rawTime}'`, "error");
      return { error: "invalid schedule_time format, expected HH:MM" };
    }
    const scheduleTime = rawTime.trim();

    // Build the formatted KB entry
    const entry = formatTaskEntry(text, { scheduleDays, scheduleDate, scheduleTime });
    log(`[TMDBG Tools] task_add: formatted entry='${entry.slice(0, 140)}' len=${entry.length}`);

    // Load current KB and check max tasks
    const current = (await getUserKBPrompt()) || "";

    const taskCount = current.split("\n").filter(line => {
      const trimmed = line.trim().replace(/^-\s*/, "");
      return /^\[Task\]/i.test(trimmed);
    }).length;

    if (taskCount >= MAX_TASKS) {
      log(`[TMDBG Tools] task_add: max tasks reached (${taskCount}/${MAX_TASKS})`, "error");
      return { error: `Maximum number of scheduled tasks reached (${MAX_TASKS}). Please delete some before adding new ones.` };
    }

    const patchText = `ADD\n${entry}`;
    const updated = applyKBPatch(current, patchText);
    if (updated == null) {
      log(`[TMDBG Tools] task_add: applyKBPatch returned null`, "error");
      return { error: "failed to update knowledge base" };
    }

    if (updated === current) {
      log(`[TMDBG Tools] task_add: no-op (duplicate)`);
      return `No change (duplicate task entry).`;
    }

    // Persist
    try {
      const key = "user_prompts:user_kb.md";
      await browser.storage.local.set({ [key]: updated });
      log(`[TMDBG Tools] task_add: persisted user_kb.md (${updated.length} chars)`);
    } catch (e) {
      log(`[TMDBG Tools] task_add: failed to persist user_kb.md: ${e}`, "error");
      return { error: "failed to persist knowledge base" };
    }

    // Notify listeners
    try {
      const evt = SETTINGS?.events?.userKBPromptUpdated || "user-kb-prompt-updated";
      await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_kb.md", source: "task_add_tool" });
    } catch (e) {
      log(`[TMDBG Tools] task_add: failed to notify listeners: ${e}`, "warn");
    }

    // Trigger KB re-parse. generateKBReminders() handles both [Reminder] and [Task]
    // entries — tasks are a subclass of reminders in the ScheduledItem architecture.
    try {
      const { generateKBReminders } = await import("../../agent/modules/kbReminderGenerator.js");
      generateKBReminders(false).catch(e => {
        log(`[TMDBG Tools] task_add: failed to trigger KB re-parse: ${e}`, "warn");
      });
    } catch (e) {
      log(`[TMDBG Tools] task_add: failed to import/trigger KB re-parse: ${e}`, "warn");
    }

    // Clear any stale execution state for this hash — a recreated task with the
    // same instruction should fire fresh, not be blocked by "already fired today"
    try {
      const { getTaskHash } = await import("../../agent/modules/kbTaskParser.js");
      const { clearExecutionState } = await import("../../agent/modules/taskScheduler.js");
      const hash = getTaskHash({ instruction: text, rawLine: entry });
      await clearExecutionState(hash);
    } catch (e) {
      log(`[TMDBG Tools] task_add: failed to clear execution state: ${e}`, "warn");
    }

    log(`[TMDBG Tools] task_add: success`);
    return { ok: true, task: entry };
  } catch (e) {
    log(`[TMDBG Tools] task_add failed: ${e}`, "error");
    return { error: String(e || "unknown error in task_add") };
  }
}
