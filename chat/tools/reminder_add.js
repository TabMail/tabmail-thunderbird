// reminder_add.js – create a reminder in user_kb.md with automatic formatting (TB 145, MV3)

import { SETTINGS } from "../../agent/modules/config.js";
import { applyKBPatch } from "../../agent/modules/patchApplier.js";
import { getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { log, normalizeUnicode } from "../../agent/modules/utils.js";

/**
 * Build a formatted KB reminder entry from structured params.
 * Includes the user's IANA timezone when a due date is present, so the
 * reminder remains correct if the user travels across timezones.
 *
 * New format (v1.2.0+): "[Reminder] Due YYYY/MM/DD HH:MM [TZ], text"
 * Old format (legacy): "Reminder: Due YYYY/MM/DD HH:MM [TZ], text"
 * Both formats are recognized by detection code for backward compatibility.
 *
 * @param {string} text - Reminder text
 * @param {string|null} dueDate - Due date in YYYY/MM/DD format
 * @param {string|null} dueTime - Due time in HH:MM format
 * @returns {string} Formatted KB entry (e.g., "[Reminder] Due 2026/02/07 14:00 [America/New_York], Reply to Prof.")
 */
function formatReminderEntry(text, dueDate, dueTime) {
  const tz = dueDate ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
  const tzSuffix = tz ? ` [${tz}]` : "";
  if (dueDate && dueTime) {
    return `[Reminder] Due ${dueDate} ${dueTime}${tzSuffix}, ${text}`;
  }
  if (dueDate) {
    return `[Reminder] Due ${dueDate}${tzSuffix}, ${text}`;
  }
  return `[Reminder] ${text}`;
}

export async function run(args = {}, options = {}) {
  try {
    const rawText = typeof args?.text === "string" ? args.text : "";
    const text = normalizeUnicode(rawText || "").trim();
    if (!text) {
      log(`[TMDBG Tools] reminder_add: missing or empty 'text'`, "error");
      return { error: "missing text" };
    }

    // Validate due_date format if provided (YYYY/MM/DD)
    const dueDate = typeof args?.due_date === "string" ? args.due_date.trim() : null;
    if (dueDate) {
      if (!/^\d{4}\/\d{2}\/\d{2}$/.test(dueDate)) {
        log(`[TMDBG Tools] reminder_add: invalid due_date format '${dueDate}'`, "error");
        return { error: "invalid due_date format, expected YYYY/MM/DD" };
      }
    }

    // Validate due_time format if provided (HH:MM)
    const dueTime = typeof args?.due_time === "string" ? args.due_time.trim() : null;
    if (dueTime) {
      if (!/^\d{2}:\d{2}$/.test(dueTime)) {
        log(`[TMDBG Tools] reminder_add: invalid due_time format '${dueTime}'`, "error");
        return { error: "invalid due_time format, expected HH:MM" };
      }
    }

    // Build the formatted KB entry
    const entry = formatReminderEntry(text, dueDate, dueTime);
    log(`[TMDBG Tools] reminder_add: formatted entry='${entry.slice(0, 140)}' len=${entry.length}`);

    // Load current KB
    const current = (await getUserKBPrompt()) || "";

    const patchText = `ADD\n${entry}`;
    const updated = applyKBPatch(current, patchText);
    if (updated == null) {
      log(`[TMDBG Tools] reminder_add: applyKBPatch returned null`, "error");
      return { error: "failed to update knowledge base" };
    }

    if (updated === current) {
      log(`[TMDBG Tools] reminder_add: no-op (duplicate)`);
      return `No change (duplicate reminder).`;
    }

    // Persist
    try {
      const key = "user_prompts:user_kb.md";
      await browser.storage.local.set({ [key]: updated });
      log(`[TMDBG Tools] reminder_add: persisted user_kb.md (${updated.length} chars)`);
    } catch (e) {
      log(`[TMDBG Tools] reminder_add: failed to persist user_kb.md: ${e}`, "error");
      return { error: "failed to persist knowledge base" };
    }

    // Notify listeners
    try {
      const evt = SETTINGS?.events?.userKBPromptUpdated || "user-kb-prompt-updated";
      await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_kb.md", source: "reminder_add_tool" });
    } catch (e) {
      log(`[TMDBG Tools] reminder_add: failed to notify listeners: ${e}`, "warn");
    }

    // Trigger KB reminder update
    try {
      const { generateKBReminders } = await import("../../agent/modules/kbReminderGenerator.js");
      generateKBReminders(false).catch(e => {
        log(`[TMDBG Tools] reminder_add: failed to trigger KB reminder update: ${e}`, "warn");
      });
    } catch (e) {
      log(`[TMDBG Tools] reminder_add: failed to import/trigger KB reminder update: ${e}`, "warn");
    }

    // Trigger debounced periodic KB update
    try {
      const { debouncedKbUpdate } = await import("../../agent/modules/knowledgebase.js");
      debouncedKbUpdate();
    } catch (e2) {
      log(`[TMDBG Tools] reminder_add: failed to trigger debounced KB update: ${e2}`, "warn");
    }

    log(`[TMDBG Tools] reminder_add: success`);
    return { ok: true, reminder: entry };
  } catch (e) {
    log(`[TMDBG Tools] reminder_add failed: ${e}`, "error");
    return { error: String(e || "unknown error in reminder_add") };
  }
}
