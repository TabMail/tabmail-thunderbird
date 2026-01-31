// proactive_toggle_checkin.js – Toggle proactive check-in setting + KB sync (TB 145, MV3)

import { SETTINGS } from "../../agent/modules/config.js";
import { applyKBPatch } from "../../agent/modules/patchApplier.js";
import { getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { log } from "../../agent/modules/utils.js";

const KB_ENTRY_ENABLED = "TabMail is set to allow the agent to initiate chat proactively.";
const KB_ENTRY_DISABLED = "TabMail is NOT set to allow the agent to initiate chat proactively.";
const STORAGE_KEY = "proactiveCheckinEnabled";

export async function run(args = {}) {
  try {
    const enabled = args?.enabled === true;

    // 1. Save setting to storage
    await browser.storage.local.set({ [STORAGE_KEY]: enabled });
    log(`[TMDBG Tools] proactive_toggle_checkin: set ${STORAGE_KEY}=${enabled}`);

    // 2. Sync KB entry
    let kbSynced = false;
    try {
      let kb = (await getUserKBPrompt()) || "";

      // Remove whichever entry currently exists (ignore if not found)
      const delEntry = enabled ? KB_ENTRY_DISABLED : KB_ENTRY_ENABLED;
      const addEntry = enabled ? KB_ENTRY_ENABLED : KB_ENTRY_DISABLED;

      const afterDel = applyKBPatch(kb, `DEL\n${delEntry}`);
      if (afterDel != null) kb = afterDel;

      const afterAdd = applyKBPatch(kb, `ADD\n${addEntry}`);
      if (afterAdd != null) kb = afterAdd;

      // Persist KB
      const key = "user_prompts:user_kb.md";
      await browser.storage.local.set({ [key]: kb });
      log(`[TMDBG Tools] proactive_toggle_checkin: KB updated (${kb.length} chars)`);

      // Notify listeners
      const evt = SETTINGS?.events?.userKBPromptUpdated || "user-kb-prompt-updated";
      await browser.runtime.sendMessage({ command: evt, key, source: "proactive_toggle_checkin" });

      // Trigger KB reminder update
      try {
        const { generateKBReminders } = await import("../../agent/modules/kbReminderGenerator.js");
        generateKBReminders(false).catch(() => {});
      } catch (_) {}

      kbSynced = true;
    } catch (e) {
      log(`[TMDBG Tools] proactive_toggle_checkin: KB sync failed: ${e}`, "warn");
    }

    return { ok: true, enabled, kb_synced: kbSynced };
  } catch (e) {
    log(`[TMDBG Tools] proactive_toggle_checkin failed: ${e}`, "error");
    return { error: String(e || "unknown error in proactive_toggle_checkin") };
  }
}
