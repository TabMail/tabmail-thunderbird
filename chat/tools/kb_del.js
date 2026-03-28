// kb_del.js – remove a single knowledge statement from user_kb.md (TB 141+, MV3)

import { SETTINGS } from "../../agent/modules/config.js";
import { applyKBPatch } from "../../agent/modules/patchApplier.js";
import { getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { log, normalizeUnicode } from "../../agent/modules/utils.js";

function buildDelPatch(statement) {
  // Create a KB patch using existing normalization in applyKBPatch path
  // Format: DEL\n<content>
  return `DEL\n${statement}`;
}

export async function run(args = {}, options = {}) {
  try {
    const raw = typeof args?.statement === "string" ? args.statement : "";
    const statement = normalizeUnicode(raw || "").trim();
    if (!statement) {
      log(`[TMDBG Tools] kb_del: missing or empty 'statement'`, "error");
      return { error: "missing statement" };
    }

    log(`[TMDBG Tools] kb_del: starting with statement='${statement.slice(0, 140)}' len=${statement.length}`);

    // Load current KB
    const current = (await getUserKBPrompt()) || "";
    if (!current) {
      log(`[TMDBG Tools] kb_del: current KB is empty or missing`, "warn");
      return { error: "knowledge base is empty" };
    }

    const patchText = buildDelPatch(statement);
    const updated = applyKBPatch(current, patchText);
    if (updated == null) {
      log(`[TMDBG Tools] kb_del: applyKBPatch returned null`, "error");
      return { error: "failed to delete from knowledge base (statement not found)" };
    }

    if (updated === current) {
      log(`[TMDBG Tools] kb_del: no-op (statement not found)`);
      return { error: "statement not found in knowledge base" };
    }

    // Persist
    try {
      const key = "user_prompts:user_kb.md";
      await browser.storage.local.set({ [key]: updated });
      log(`[TMDBG Tools] kb_del: persisted user_kb.md (${updated.length} chars)`);
    } catch (e) {
      log(`[TMDBG Tools] kb_del: failed to persist user_kb.md: ${e}`, "error");
      return { error: "failed to persist knowledge base" };
    }

    // Notify listeners (config UI, etc.)
    try {
      const evt = (SETTINGS && SETTINGS.events && SETTINGS.events.userKBPromptUpdated) || "user-kb-prompt-updated";
      await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_kb.md", source: "kb_del_tool" });
    } catch (e) {
      log(`[TMDBG Tools] kb_del: failed to notify listeners: ${e}`, "warn");
    }

    // Trigger KB reminder update AFTER KB is saved to disk
    // This must happen after storage.save completes to avoid race conditions
    try {
      const { generateKBReminders } = await import("../../agent/modules/kbReminderGenerator.js");
      log(`[TMDBG Tools] kb_del: triggering KB reminder update after KB save`);
      // Use fire-and-forget to avoid blocking, but ensure it runs after save
      generateKBReminders(false).catch(e => {
        log(`[TMDBG Tools] kb_del: failed to trigger KB reminder update: ${e}`, "warn");
      });
    } catch (e) {
      log(`[TMDBG Tools] kb_del: failed to import/trigger KB reminder update: ${e}`, "warn");
    }

    log(`[TMDBG Tools] kb_del: success`);
    return `Removed from knowledge base.`;
  } catch (e) {
    log(`[TMDBG Tools] kb_del failed: ${e}`, "error");
    return { error: String(e || "unknown error in kb_del") };
  }
}


