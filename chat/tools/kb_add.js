// kb_add.js – append a single knowledge statement to user_kb.md (TB 141+, MV3)

import { SETTINGS } from "../../agent/modules/config.js";
import { applyKBPatch } from "../../agent/modules/patchApplier.js";
import { getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { log, normalizeUnicode } from "../../agent/modules/utils.js";

function buildAddPatch(statement) {
  // Create a KB patch using existing normalization in applyKBPatch path
  // Format: ADD\n<content>
  return `ADD\n${statement}`;
}

export async function run(args = {}, options = {}) {
  try {
    const raw = typeof args?.statement === "string" ? args.statement : "";
    const statement = normalizeUnicode(raw || "").trim();
    if (!statement) {
      log(`[TMDBG Tools] kb_add: missing or empty 'statement'`, "error");
      return { error: "missing statement" };
    }

    log(`[TMDBG Tools] kb_add: starting with statement='${statement.slice(0, 140)}' len=${statement.length}`);

    // Load current KB
    const current = (await getUserKBPrompt()) || "";
    if (!current) {
      log(`[TMDBG Tools] kb_add: current KB is empty or missing`, "warn");
    }

    const patchText = buildAddPatch(statement);
    const updated = applyKBPatch(current, patchText);
    if (updated == null) {
      log(`[TMDBG Tools] kb_add: applyKBPatch returned null`, "error");
      return { error: "failed to update knowledge base" };
    }

    if (updated === current) {
      log(`[TMDBG Tools] kb_add: no-op (duplicate or unchanged)`);
      return `No change (duplicate or unchanged).`;
    }

    // Persist
    try {
      const key = "user_prompts:user_kb.md";
      await browser.storage.local.set({ [key]: updated });
      log(`[TMDBG Tools] kb_add: persisted user_kb.md (${updated.length} chars)`);
    } catch (e) {
      log(`[TMDBG Tools] kb_add: failed to persist user_kb.md: ${e}`, "error");
      return { error: "failed to persist knowledge base" };
    }

    // Notify listeners (config UI, etc.)
    try {
      const evt = (SETTINGS && SETTINGS.events && SETTINGS.events.userKBPromptUpdated) || "user-kb-prompt-updated";
      await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_kb.md", source: "kb_add_tool" });
    } catch (e) {
      log(`[TMDBG Tools] kb_add: failed to notify listeners: ${e}`, "warn");
    }

    // Trigger KB reminder update AFTER KB is saved to disk
    // This must happen after storage.save completes to avoid race conditions
    try {
      const { generateKBReminders } = await import("../../agent/modules/kbReminderGenerator.js");
      log(`[TMDBG Tools] kb_add: triggering KB reminder update after KB save`);
      // Use fire-and-forget to avoid blocking, but ensure it runs after save
      generateKBReminders(false).catch(e => {
        log(`[TMDBG Tools] kb_add: failed to trigger KB reminder update: ${e}`, "warn");
      });
    } catch (e) {
      log(`[TMDBG Tools] kb_add: failed to import/trigger KB reminder update: ${e}`, "warn");
    }

    log(`[TMDBG Tools] kb_add: success`);
    return `Added to knowledge base.`;
  } catch (e) {
    log(`[TMDBG Tools] kb_add failed: ${e}`, "error");
    return { error: String(e || "unknown error in kb_add") };
  }
}


