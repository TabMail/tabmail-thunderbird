// task_del.js – delete a [Task] entry from user_kb.md by text match (TB 145, MV3)

import { SETTINGS } from "../../agent/modules/config.js";
import { applyKBPatch } from "../../agent/modules/patchApplier.js";
import { getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { log, normalizeUnicode } from "../../agent/modules/utils.js";

export async function run(args = {}, options = {}) {
  try {
    const rawText = typeof args?.text === "string" ? args.text : "";
    const text = normalizeUnicode(rawText || "").trim();
    if (!text) {
      log(`[TMDBG Tools] task_del: missing or empty 'text'`, "error");
      return { error: "missing text" };
    }

    log(`[TMDBG Tools] task_del: searching for task matching '${text.slice(0, 140)}'`);

    // Load current KB
    const current = (await getUserKBPrompt()) || "";
    if (!current) {
      log(`[TMDBG Tools] task_del: knowledge base is empty`, "debug");
      return { error: `No scheduled task found matching '${text}'.` };
    }

    // Optional schedule_time for disambiguation
    const scheduleTime = typeof args?.schedule_time === "string" ? args.schedule_time.trim() : "";

    // Find matching [Task] lines.
    // If text starts with "[Task]", it's an exact rawLine match (from settings UI delete).
    // Otherwise, do substring search optionally filtered by schedule_time.
    const lines = current.split("\n");
    const isExactMatch = text.startsWith("[Task]");
    const textLower = text.toLowerCase();
    const matches = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(?:-\s*)?\[Task\]/i.test(trimmed)) {
        const statement = trimmed.replace(/^-\s*/, "");
        if (isExactMatch) {
          if (statement.toLowerCase() === textLower) {
            matches.push(statement);
          }
        } else {
          if (trimmed.toLowerCase().includes(textLower)) {
            // If schedule_time provided, further filter by time
            if (scheduleTime && !trimmed.includes(scheduleTime)) continue;
            matches.push(statement);
          }
        }
      }
    }

    if (matches.length === 0) {
      log(`[TMDBG Tools] task_del: no matching task found for '${text}'`, "warn");
      return { error: `No scheduled task found matching '${text}'.` };
    }

    if (matches.length > 1 && !isExactMatch) {
      log(`[TMDBG Tools] task_del: ${matches.length} matching tasks found, returning list for clarification`);
      return {
        error: `Multiple scheduled tasks match '${text}'. Include the schedule time to disambiguate.`,
        matches: matches.map(m => m.replace(/^\[Task\]\s*(?:Schedule|Once)\s*/, "")),
      };
    }

    // Exactly one match — delete it
    const statement = matches[0];
    log(`[TMDBG Tools] task_del: found match, deleting: '${statement.slice(0, 140)}'`);

    const patchText = `DEL\n${statement}`;
    const updated = applyKBPatch(current, patchText);
    if (updated == null || updated === current) {
      log(`[TMDBG Tools] task_del: applyKBPatch failed or no change`, "error");
      return { error: "failed to delete scheduled task from knowledge base" };
    }

    // Persist
    try {
      const key = "user_prompts:user_kb.md";
      await browser.storage.local.set({ [key]: updated });
      log(`[TMDBG Tools] task_del: persisted user_kb.md (${updated.length} chars)`);
    } catch (e) {
      log(`[TMDBG Tools] task_del: failed to persist user_kb.md: ${e}`, "error");
      return { error: "failed to persist knowledge base" };
    }

    // Notify listeners
    try {
      const evt = SETTINGS?.events?.userKBPromptUpdated || "user-kb-prompt-updated";
      await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_kb.md", source: "task_del_tool" });
    } catch (e) {
      log(`[TMDBG Tools] task_del: failed to notify listeners: ${e}`, "warn");
    }

    // Trigger KB re-parse. generateKBReminders() handles both [Reminder] and [Task]
    // entries — tasks are a subclass of reminders in the ScheduledItem architecture.
    try {
      const { generateKBReminders } = await import("../../agent/modules/kbReminderGenerator.js");
      generateKBReminders(false).catch(e => {
        log(`[TMDBG Tools] task_del: failed to trigger KB re-parse: ${e}`, "warn");
      });
    } catch (e) {
      log(`[TMDBG Tools] task_del: failed to import/trigger KB re-parse: ${e}`, "warn");
    }

    // Clear execution state for the deleted task so it can fire fresh if recreated
    try {
      const { getTaskHash } = await import("../../agent/modules/kbTaskParser.js");
      const { clearExecutionState } = await import("../../agent/modules/taskScheduler.js");
      // Extract instruction from the deleted statement to compute hash
      const instrMatch = statement.match(/,\s*(.+)$/);
      if (instrMatch) {
        const hash = getTaskHash({ instruction: instrMatch[1].trim(), rawLine: statement });
        await clearExecutionState(hash);
      }
    } catch (e) {
      log(`[TMDBG Tools] task_del: failed to clear execution state: ${e}`, "warn");
    }

    log(`[TMDBG Tools] task_del: success`);
    return { ok: true, removed: statement };
  } catch (e) {
    log(`[TMDBG Tools] task_del failed: ${e}`, "error");
    return { error: String(e || "unknown error in task_del") };
  }
}
