import { SETTINGS } from "./config.js";
import * as idb from "./idbStorage.js";
import { processJSONResponse, sendChat } from "./llm.js";
import { applyActionPatch } from "./patchApplier.js";
import { getUserActionPrompt } from "./promptGenerator.js";
import {
    getUniqueMessageKey,
    log,
    saveChatLog
} from "./utils.js";

// Note: The original agent-assigned action, justification, and user prompt are stored once under keys:
//   "action:orig:<uniqueKey>", "action:justification:<uniqueKey>", and "action:userprompt:<uniqueKey>"
// where <uniqueKey> matches the action cache identifier (e.g., summaryId or header Message-Id).
// These are write-once and should never be updated. Implementation lives in modules/actionGenerator.js 
// (recordOriginalActionOnce, recordOriginalUserPromptOnce).


export async function autoUpdateUserPromptOnMove(messageId, payload = {}) {
    try {
        const { source = "", action = "", beforeId = null, afterId = null, fromFolder = null, toFolder = null, details = null } = payload || {};
        const meta = JSON.stringify({ source, action, beforeId, afterId, fromFolder, toFolder, details });
        log(`[TMDBG AutoPrompt] onMove invoked for message ${messageId}`);
    } catch (e) {
        log(`[TMDBG AutoPrompt] Error in autoUpdateUserPromptOnMove for message ${messageId}: ${e}`, "error");
    }
}

// ----------------------------------------------------------
// Simple serialized queue (semaphore of 1) for onTag updates
// ----------------------------------------------------------
let _autoPromptUpdateChain = Promise.resolve();

async function _runExclusively(taskName, fn) {
    const queuedAt = Date.now();
    const runner = async () => {
        const startedAt = Date.now();
        const waitMs = startedAt - queuedAt;
        log(`[TMDBG AutoPrompt] Lock acquired for ${taskName} after ${waitMs}ms wait.`);
        try {
            return await fn();
        } finally {
            const dur = Date.now() - startedAt;
            log(`[TMDBG AutoPrompt] Lock released for ${taskName}; duration=${dur}ms.`);
        }
    };
    // Chain the runner to guarantee single concurrency, regardless of prior errors
    const p = _autoPromptUpdateChain.then(runner, runner);
    _autoPromptUpdateChain = p.catch(() => {});
    return p;
}

async function _autoUpdateUserPromptOnTagImpl(messageId, action, extra = {}) {
    try {
        const { source = "manual-tag" } = extra || {};
        const meta = JSON.stringify({ source, action, ...extra });
        log(`[TMDBG AutoPrompt] onTag invoked for message ${messageId} with ${meta}`);

        // Resolve unique header-key and load message header for metadata
        const uniqueKey = await getUniqueMessageKey(messageId);
        let header = null;
        try { header = await browser.messages.get(messageId); } catch (_) {}

        // Attempt to load cached summary data; do NOT compute fallbacks here
        const summaryKey = "summary:" + uniqueKey;
        const summaryObj = await idb.get(summaryKey);
        const summary = summaryObj?.[summaryKey] || null;
        if (!summary) {
            log(`[TMDBG AutoPrompt] No summary cached for ${uniqueKey}; skipping guideline update.`);
            return;
        }

        // Original agent action (write-once record)
        const origKey = "action:orig:" + uniqueKey;
        const origObj = await idb.get(origKey);
        const originalAgentAction = (origObj && origObj[origKey]) || "";
        if (!originalAgentAction) {
            log(`[TMDBG AutoPrompt] Original agent action missing for ${uniqueKey}; continuing with empty.`);
        }

        // Original user action prompt (write-once record)
        const userPromptKey = "action:userprompt:" + uniqueKey;
        const userPromptObj = await idb.get(userPromptKey);
        const originalUserActionPrompt = (userPromptObj && userPromptObj[userPromptKey]) || "";
        if (!originalUserActionPrompt) {
            log(`[TMDBG AutoPrompt] Original user action prompt missing for ${uniqueKey}; continuing with empty.`);
        }

        // Skip update if the original action is the same as the current action.
        if (originalAgentAction === action) {
            log(`[TMDBG AutoPrompt] Original agent action is the same as the current action for ${uniqueKey}; skipping.`);
            return;
        }

        // Current user_action.md from storage.local (initialize if absent)
        const currentUserActionMd = (await getUserActionPrompt()) || "";
        if (!currentUserActionMd) {
            log(`[TMDBG AutoPrompt] user_action.md empty or missing; skipping.`);
            return;
        }

        // Build single consolidated message that backend will process
        const systemMsg = {
            role: "system",
            content: "system_prompt_action_refine",
            subject: header?.subject || summary?.subject || "Not Available",
            from_sender: header?.author || summary?.fromSender || "Unknown",
            summary_blurb: summary?.blurb || "",
            summary_detailed: summary?.detailed || "",
            todos: summary?.todos || "",
            original_agent_action: originalAgentAction,
            original_user_action_prompt: originalUserActionPrompt,
            user_manual_tag: action || "",
            current_user_action_md: currentUserActionMd,
        };

        const messages = [systemMsg];
        const assistantResp = await sendChat(messages);
        if (!assistantResp) {
            log(`[TMDBG AutoPrompt] LLM returned empty patch for ${uniqueKey}`, "warn");
            return;
        }

        // Parse strict JSON: { patch: "..." }
        const parsed = processJSONResponse(assistantResp) || {};
        const patchText = typeof parsed.patch === "string" ? parsed.patch.trim() : "";
        if (!patchText) {
            log(`[TMDBG AutoPrompt] No patch provided for ${uniqueKey}; skipping.`);
            // Still persist chat for debugging
            saveChatLog("tabmail_action_update", uniqueKey, messages, assistantResp);
            return;
        }

        // Apply action patch
        const updated = applyActionPatch(currentUserActionMd, patchText);
        if (updated == null) {
            log(`[TMDBG AutoPrompt] Failed to apply action patch for ${uniqueKey}; leaving guideline unchanged.`, "warn");
            saveChatLog("tabmail_action_update", uniqueKey, messages, assistantResp);
            return;
        }
        if (updated === currentUserActionMd) {
            log(`[TMDBG AutoPrompt] Action patch applied produced no change for ${uniqueKey}.`);
            saveChatLog("tabmail_action_update", uniqueKey, messages, assistantResp);
            return;
        }

        // Persist updated guideline back to storage.local
        try {
            const key = "user_prompts:user_action.md";
            await browser.storage.local.set({ [key]: updated });
            log(`[TMDBG AutoPrompt] user_action.md updated (len ${updated.length}) for ${uniqueKey}.`);
        } catch (e) {
            log(`[TMDBG AutoPrompt] Failed to persist updated user_action.md: ${e}`, "error");
        }

        // Notify listeners (e.g., config page) that action prompt was updated
        try {
            const evt = (SETTINGS && SETTINGS.events && SETTINGS.events.userActionPromptUpdated) || "user-action-prompt-updated";
            await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_action.md", uniqueKey, source });
        } catch (e) {
            log(`[TMDBG AutoPrompt] Failed to send update notification: ${e}`, "warn");
        }

        // Save full chat log for auditing
        saveChatLog("tabmail_action_update", uniqueKey, messages, assistantResp);
    } catch (e) {
        log(`[TMDBG AutoPrompt] Error in autoUpdateUserPromptOnTag for message ${messageId}: ${e}`, "error");
    }
}

export async function autoUpdateUserPromptOnTag(messageId, action, extra = {}) {
    return _runExclusively("autoUpdateUserPromptOnTag", () => _autoUpdateUserPromptOnTagImpl(messageId, action, extra));
}


