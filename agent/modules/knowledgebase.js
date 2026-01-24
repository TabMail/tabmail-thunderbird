import { formatTimestampForAgent } from "../../chat/modules/helpers.js";
import { SETTINGS } from "./config.js";
import { processJSONResponse, sendChat } from "./llm.js";
import { applyKBPatch } from "./patchApplier.js";
import { getUserKBPrompt } from "./promptGenerator.js";
import {
    log,
    saveChatLog
} from "./utils.js";


// ----------------------------------------------------------
// Simple serialized queue (semaphore of 1) for kb updates
// ----------------------------------------------------------
let _kbUpdateChain = Promise.resolve();

async function _runExclusively(taskName, fn) {
    const queuedAt = Date.now();
    const runner = async () => {
        const startedAt = Date.now();
        const waitMs = startedAt - queuedAt;
        log(`-- KB -- Lock acquired for ${taskName} after ${waitMs}ms wait.`);
        try {
            return await fn();
        } finally {
            const dur = Date.now() - startedAt;
            log(`-- KB -- Lock released for ${taskName}; duration=${dur}ms.`);
        }
    };
    // Chain the runner to guarantee single concurrency, regardless of prior errors
    const p = _kbUpdateChain.then(runner, runner);
    _kbUpdateChain = p.catch(() => {});
    return p;
}

async function _kbUpdateImpl(conversationHistory = []) {
    try {
        // Skip if no meaningful conversation history
        if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
            return;
        }

        // Filter for meaningful messages (user input and assistant responses only - exclude tool responses)
        // Tool responses are too long and contain structured data rather than user knowledge
        const meaningfulMessages = conversationHistory.filter(msg => 
            msg.role === "user" || msg.role === "assistant"
        );
        if (meaningfulMessages.length === 0) {
            return;
        }

        // Current user_kb.md from storage.local (initialize if absent)
        const currentUserKBMd = (await getUserKBPrompt()) || "";
        if (!currentUserKBMd) {
            return;
        }

        log(`-- KB -- Starting knowledge base update (${meaningfulMessages.length} messages)`);

        // Build conversation context for the LLM (user and assistant messages only)
        const chatHistory = meaningfulMessages.map(msg => {
            if (msg.role === "user") {
                return `[USER]: ${msg.content}`;
            } else if (msg.role === "assistant") {
                return `[ASSISTANT]: ${msg.content}`;
            }
            return msg.content;
        }).join("\n\n");

        // Build single consolidated message that backend will process
        const currentTime = formatTimestampForAgent();
        const systemMsg = {
            role: "system",
            content: "system_prompt_kb_refine",
            chat_history: chatHistory,
            current_user_kb_md: currentUserKBMd,
            current_time: currentTime,
        };

        const requestStartTime = Date.now();
        
        let assistantResp;
        try {
            // Add timeout wrapper around sendChat
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('KB LLM request timeout after 60s')), 60000)
            );
            
            const sendChatPromise = sendChat([systemMsg], { ignoreSemaphore: true });
            
            assistantResp = await Promise.race([
                sendChatPromise, // Bypass semaphore for KB updates
                timeoutPromise
            ]);
            
        } catch (error) {
            const requestDuration = Date.now() - requestStartTime;
            log(`-- KB -- LLM request failed after ${requestDuration}ms: ${error}`, "error");
            saveChatLog("tabmail_kb_update_failed", Date.now(), [systemMsg], `ERROR: ${error}`);
            return;
        }
        
        // Log the chat exchange for debugging
        saveChatLog("tabmail_kb_update", Date.now(), [systemMsg], assistantResp);
        
        if (!assistantResp) {
            log(`-- KB -- LLM returned empty response for KB update`, "warn");
            return;
        }

        // Parse strict JSON: { patch: "..." }
        const parsed = processJSONResponse(assistantResp) || {};
        
        const patchText = typeof parsed.patch === "string" ? parsed.patch.trim() : "";
        if (!patchText) {
            log(`-- KB -- No patch provided for KB update. Parsed object keys: ${Object.keys(parsed).join(', ')}. Patch type: ${typeof parsed.patch}`, "warn");
            return;
        }

        // Apply KB patch
        const updated = applyKBPatch(currentUserKBMd, patchText);
        if (updated == null) {
            log(`-- KB -- Failed to apply KB patch for KB update; leaving unchanged`, "warn");
            return;
        }
        if (updated === currentUserKBMd) {
            return; // No change
        }

        // Persist updated KB back to storage.local
        try {
            const key = "user_prompts:user_kb.md";
            await browser.storage.local.set({ [key]: updated });
            log(`-- KB -- KB saved to disk successfully`);
        } catch (e) {
            log(`-- KB -- Failed to persist updated user_kb.md: ${e}`, "error");
            return;
        }

        // Notify listeners (e.g., config page) that KB prompt was updated
        try {
            const evt = (SETTINGS && SETTINGS.events && SETTINGS.events.userKBPromptUpdated) || "user-kb-prompt-updated";
            await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_kb.md", source: "conversation_memo" });
        } catch (e) {
            log(`-- KB -- Failed to send update notification: ${e}`, "warn");
        }

        // Trigger KB reminder update AFTER KB is saved to disk
        // This must happen after storage.save completes to avoid race conditions
        try {
            const { generateKBReminders } = await import("./kbReminderGenerator.js");
            log(`-- KB -- Triggering KB reminder update after KB save`);
            // Use fire-and-forget to avoid blocking, but ensure it runs after save
            generateKBReminders(false).catch(e => {
                log(`-- KB -- Failed to trigger KB reminder update: ${e}`, "warn");
            });
        } catch (e) {
            log(`-- KB -- Failed to import/trigger KB reminder update: ${e}`, "warn");
        }

        log(`-- KB -- Knowledge base updated successfully`);
    } catch (e) {
        log(`-- KB -- Error in kbUpdate: ${e}`, "error");
    }
}

export async function kbUpdate(conversationHistory = []) {
    return _runExclusively("kbUpdate", () => _kbUpdateImpl(conversationHistory));
}
