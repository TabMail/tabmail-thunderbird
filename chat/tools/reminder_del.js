// reminder_del.js – delete a reminder from user_kb.md by text match (TB 145, MV3)

import { SETTINGS } from "../../agent/modules/config.js";
import { applyKBPatch } from "../../agent/modules/patchApplier.js";
import { getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { log, normalizeUnicode } from "../../agent/modules/utils.js";

export async function run(args = {}, options = {}) {
  try {
    const rawText = typeof args?.text === "string" ? args.text : "";
    const text = normalizeUnicode(rawText || "").trim();
    if (!text) {
      log(`[TMDBG Tools] reminder_del: missing or empty 'text'`, "error");
      return { error: "missing text" };
    }

    log(`[TMDBG Tools] reminder_del: searching for reminder matching '${text.slice(0, 140)}'`);

    // Load current KB
    const current = (await getUserKBPrompt()) || "";
    if (!current) {
      log(`[TMDBG Tools] reminder_del: knowledge base is empty`, "warn");
      return { error: "no reminders found (knowledge base is empty)" };
    }

    // Find lines matching reminders that contain the search text
    // Supports both old format "- Reminder:" and new format "- [Reminder]"
    const lines = current.split("\n");
    const textLower = text.toLowerCase();
    const matches = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Match lines that start with "- Reminder:" or "- [Reminder]" (KB list format)
      if (/^-\s*(?:Reminder:|\[Reminder\])/i.test(trimmed)) {
        // Check if the reminder content contains the search text (case-insensitive)
        if (trimmed.toLowerCase().includes(textLower)) {
          // Extract the raw statement (without leading "- ")
          const statement = trimmed.replace(/^-\s*/, "");
          matches.push(statement);
        }
      }
    }

    if (matches.length === 0) {
      log(`[TMDBG Tools] reminder_del: no matching reminder found for '${text}'`, "warn");
      return { error: `No reminder found matching '${text}'.` };
    }

    if (matches.length > 1) {
      log(`[TMDBG Tools] reminder_del: ${matches.length} matching reminders found, returning list for clarification`);
      return {
        error: `Multiple reminders match '${text}'. Please be more specific.`,
        matches: matches.map(m => m.replace(/^(?:Reminder:\s*|\[Reminder\]\s*)/, "")),
      };
    }

    // Exactly one match — delete it
    const statement = matches[0];
    log(`[TMDBG Tools] reminder_del: found match, deleting: '${statement.slice(0, 140)}'`);

    const patchText = `DEL\n${statement}`;
    const updated = applyKBPatch(current, patchText);
    if (updated == null || updated === current) {
      log(`[TMDBG Tools] reminder_del: applyKBPatch failed or no change`, "error");
      return { error: "failed to delete reminder from knowledge base" };
    }

    // Persist
    try {
      const key = "user_prompts:user_kb.md";
      await browser.storage.local.set({ [key]: updated });
      log(`[TMDBG Tools] reminder_del: persisted user_kb.md (${updated.length} chars)`);
    } catch (e) {
      log(`[TMDBG Tools] reminder_del: failed to persist user_kb.md: ${e}`, "error");
      return { error: "failed to persist knowledge base" };
    }

    // Notify listeners
    try {
      const evt = SETTINGS?.events?.userKBPromptUpdated || "user-kb-prompt-updated";
      await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_kb.md", source: "reminder_del_tool" });
    } catch (e) {
      log(`[TMDBG Tools] reminder_del: failed to notify listeners: ${e}`, "warn");
    }

    // Trigger KB reminder update
    try {
      const { generateKBReminders } = await import("../../agent/modules/kbReminderGenerator.js");
      generateKBReminders(false).catch(e => {
        log(`[TMDBG Tools] reminder_del: failed to trigger KB reminder update: ${e}`, "warn");
      });
    } catch (e) {
      log(`[TMDBG Tools] reminder_del: failed to import/trigger KB reminder update: ${e}`, "warn");
    }

    // Clear reached_out flag for this reminder (if tracked)
    try {
      const stored = await browser.storage.local.get({ "notifications.reached_out_ids": {} });
      const reachedOutIds = stored["notifications.reached_out_ids"] || {};
      // Check all keys for a content match (KB reminders use k: prefix with content hash)
      let cleared = false;
      for (const key of Object.keys(reachedOutIds)) {
        if (key.startsWith("k:")) {
          delete reachedOutIds[key];
          cleared = true;
        }
      }
      if (cleared) {
        await browser.storage.local.set({ "notifications.reached_out_ids": reachedOutIds });
        log(`[TMDBG Tools] reminder_del: cleared reached_out flags for KB reminders`);
      }
    } catch (e) {
      log(`[TMDBG Tools] reminder_del: failed to clear reached_out flags: ${e}`, "warn");
    }

    // Trigger debounced periodic KB update
    try {
      const { debouncedKbUpdate } = await import("../../agent/modules/knowledgebase.js");
      debouncedKbUpdate();
    } catch (e2) {
      log(`[TMDBG Tools] reminder_del: failed to trigger debounced KB update: ${e2}`, "warn");
    }

    log(`[TMDBG Tools] reminder_del: success`);
    return { ok: true, removed: statement };
  } catch (e) {
    log(`[TMDBG Tools] reminder_del failed: ${e}`, "error");
    return { error: String(e || "unknown error in reminder_del") };
  }
}
