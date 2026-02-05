// change_setting.js – modify user-facing notification/proactive settings (TB 145, MV3)

import { SETTINGS } from "../../agent/modules/config.js";
import { applyKBPatch } from "../../agent/modules/patchApplier.js";
import { getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { log } from "../../agent/modules/utils.js";

// Setting definitions: key → { type, min, max, default, kbTemplate }
// KB entries are prefixed with [Pinned] to protect from automatic cleanup
const SETTING_DEFS = {
  "notifications.proactive_enabled": {
    type: "boolean",
    default: false,
    kbEntryOn: "[Pinned] TabMail proactive notifications are enabled.",
    kbEntryOff: "[Pinned] TabMail proactive notifications are disabled.",
    // Also clean up legacy KB entries from proactive_toggle_checkin (with and without [Pinned])
    legacyKbEntries: [
      "TabMail is set to allow the agent to initiate chat proactively.",
      "TabMail is NOT set to allow the agent to initiate chat proactively.",
      "[Pinned] TabMail is set to allow the agent to initiate chat proactively.",
      "[Pinned] TabMail is NOT set to allow the agent to initiate chat proactively.",
      // Also clean up non-pinned versions of current entries
      "TabMail proactive notifications are enabled.",
      "TabMail proactive notifications are disabled.",
    ],
  },
  "notifications.new_reminder_window_days": {
    type: "number",
    min: 1,
    max: 30,
    default: 7,
    kbTemplate: (v) => `[Pinned] TabMail reaches out for new reminders within ${v} days of their due date.`,
    kbPattern: /^(\[Pinned\] )?TabMail reaches out for new reminders within \d+ days/,
  },
  "notifications.due_reminder_advance_minutes": {
    type: "number",
    min: 5,
    max: 120,
    default: 30,
    kbTemplate: (v) => `[Pinned] TabMail reaches out ${v} minutes before reminder due times.`,
    kbPattern: /^(\[Pinned\] )?TabMail reaches out \d+ minutes before reminder due times/,
  },
  "notifications.grace_minutes": {
    type: "number",
    min: 1,
    max: 30,
    default: 5,
    // No KB entry for grace minutes — too low-level for the LLM to need
  },
};

export async function run(args = {}) {
  try {
    const settingKey = args?.setting;
    const value = args?.value;

    if (!settingKey || !(settingKey in SETTING_DEFS)) {
      log(`[TMDBG Tools] change_setting: unknown setting '${settingKey}'`, "error");
      return { error: `Unknown setting '${settingKey}'. Valid settings: ${Object.keys(SETTING_DEFS).join(", ")}` };
    }

    const def = SETTING_DEFS[settingKey];

    // Validate type
    if (def.type === "boolean") {
      if (typeof value !== "boolean") {
        log(`[TMDBG Tools] change_setting: expected boolean for '${settingKey}', got ${typeof value}`, "error");
        return { error: `Setting '${settingKey}' requires a boolean value (true/false).` };
      }
    } else if (def.type === "number") {
      const num = Number(value);
      if (isNaN(num) || !Number.isInteger(num)) {
        log(`[TMDBG Tools] change_setting: expected integer for '${settingKey}', got ${value}`, "error");
        return { error: `Setting '${settingKey}' requires an integer value.` };
      }
      if (num < def.min || num > def.max) {
        log(`[TMDBG Tools] change_setting: value ${num} out of range [${def.min}, ${def.max}] for '${settingKey}'`, "error");
        return { error: `Setting '${settingKey}' must be between ${def.min} and ${def.max}.` };
      }
    }

    // Read previous value
    const stored = await browser.storage.local.get({ [settingKey]: def.default });
    const previousValue = stored[settingKey];

    // Persist new value
    const effectiveValue = def.type === "number" ? Number(value) : value;
    await browser.storage.local.set({ [settingKey]: effectiveValue });
    log(`[TMDBG Tools] change_setting: set ${settingKey}=${effectiveValue} (was ${previousValue})`);

    // Sync KB
    let kbSynced = false;
    try {
      let kb = (await getUserKBPrompt()) || "";

      // Clean up legacy entries if defined
      if (def.legacyKbEntries) {
        for (const legacy of def.legacyKbEntries) {
          const afterDel = applyKBPatch(kb, `DEL\n${legacy}`);
          if (afterDel != null) kb = afterDel;
        }
      }

      // Boolean settings: swap on/off entries
      if (def.type === "boolean" && def.kbEntryOn && def.kbEntryOff) {
        const delEntry = effectiveValue ? def.kbEntryOff : def.kbEntryOn;
        const addEntry = effectiveValue ? def.kbEntryOn : def.kbEntryOff;

        const afterDel = applyKBPatch(kb, `DEL\n${delEntry}`);
        if (afterDel != null) kb = afterDel;

        const afterAdd = applyKBPatch(kb, `ADD\n${addEntry}`);
        if (afterAdd != null) kb = afterAdd;
      }

      // Number settings: replace old entry with new
      if (def.type === "number" && def.kbTemplate && def.kbPattern) {
        // Remove old entry matching the pattern
        const lines = kb.split("\n");
        const filtered = lines.filter(line => {
          const trimmed = line.replace(/^-\s*/, "").trim();
          return !def.kbPattern.test(trimmed);
        });
        kb = filtered.join("\n");

        // Add new entry
        const newEntry = def.kbTemplate(effectiveValue);
        const afterAdd = applyKBPatch(kb, `ADD\n${newEntry}`);
        if (afterAdd != null) kb = afterAdd;
      }

      // Persist KB
      const key = "user_prompts:user_kb.md";
      await browser.storage.local.set({ [key]: kb });

      // Notify listeners
      const evt = SETTINGS?.events?.userKBPromptUpdated || "user-kb-prompt-updated";
      await browser.runtime.sendMessage({ command: evt, key, source: "change_setting" });

      // Trigger KB reminder update
      try {
        const { generateKBReminders } = await import("../../agent/modules/kbReminderGenerator.js");
        generateKBReminders(false).catch(() => {});
      } catch (_) {}

      kbSynced = true;
    } catch (e) {
      log(`[TMDBG Tools] change_setting: KB sync failed: ${e}`, "warn");
    }

    return { ok: true, setting: settingKey, value: effectiveValue, previous_value: previousValue, kb_synced: kbSynced };
  } catch (e) {
    log(`[TMDBG Tools] change_setting failed: ${e}`, "error");
    return { error: String(e || "unknown error in change_setting") };
  }
}
