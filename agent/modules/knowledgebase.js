import { formatTimestampForAgent } from "../../chat/modules/helpers.js";
import { addChatToQueue, getUnrememberedSessions, markSessionsAsRemembered } from "./chatHistoryQueue.js";
import { SETTINGS } from "./config.js";
import { sendChatRaw } from "./llm.js";
import { getUserKBPrompt } from "./promptGenerator.js";
import {
    log,
    saveChatLog
} from "./utils.js";


// ----------------------------------------------------------
// Configuration for KB operations
// ----------------------------------------------------------
const KB_CONFIG = {
    llmTimeoutMs: 120000, // 120 seconds timeout (backend does multiple LLM calls)
    // Defaults for KB (can be overridden by user config in prompts page)
    defaultRecentChatsAsContext: 10,
    defaultReminderRetentionDays: 14,
    defaultMaxBullets: 200,
};

/**
 * Load KB config from storage (set in prompts config page)
 */
async function getKbConfig() {
    try {
        const key = "user_prompts:kb_config";
        const obj = await browser.storage.local.get(key);
        const config = obj[key] || {};
        return {
            recent_chats_as_context: config.recent_chats_as_context ?? KB_CONFIG.defaultRecentChatsAsContext,
            reminder_retention_days: config.reminder_retention_days || KB_CONFIG.defaultReminderRetentionDays,
            max_bullets: config.max_bullets || KB_CONFIG.defaultMaxBullets,
        };
    } catch (e) {
        log(`-- KB -- Failed to load KB config, using defaults: ${e}`, "warn");
        return {
            recent_chats_as_context: KB_CONFIG.defaultRecentChatsAsContext,
            reminder_retention_days: KB_CONFIG.defaultReminderRetentionDays,
            max_bullets: KB_CONFIG.defaultMaxBullets,
        };
    }
}

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

/**
 * Main KB update implementation
 * 
 * Sends KB, chat history, and config to backend for refinement.
 * Backend returns the updated KB.
 */
async function _kbUpdateImpl(conversationHistory = []) {
    try {
        // Skip if no meaningful conversation history
        if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
            return;
        }

        // Filter for meaningful messages (user input and assistant responses only - exclude tool responses)
        const meaningfulMessages = conversationHistory.filter(msg =>
            msg.role === "user" || msg.role === "assistant"
        );
        if (meaningfulMessages.length === 0) {
            return;
        }

        log(`-- KB -- Starting knowledge base update (${meaningfulMessages.length} messages in current session)`);

        // Step 1: Add current chat to the history queue first
        try {
            const sessionId = await addChatToQueue(meaningfulMessages);
            log(`-- KB -- Added current session to queue: ${sessionId}`);
        } catch (e) {
            log(`-- KB -- Failed to add chat to queue: ${e}`, "warn");
        }

        // Step 2: Get ALL unremembered sessions (including the one we just added)
        const unrememberedSessions = await getUnrememberedSessions();
        if (unrememberedSessions.length === 0) {
            log(`-- KB -- No unremembered sessions to process`);
            return;
        }
        
        const sessionIds = unrememberedSessions.map(s => s.id);
        log(`-- KB -- Processing ${unrememberedSessions.length} unremembered sessions`);

        // Step 3: Build chat history from ALL unremembered sessions
        const chatHistoryParts = [];
        for (const session of unrememberedSessions) {
            // Add session header
            const sessionDate = new Date(session.timestamp).toLocaleString();
            chatHistoryParts.push(`--- Session from ${sessionDate} ---`);
            
            for (const msg of session.messages || []) {
                // Skip automated greeting marker
                if (msg.content === "[automated greeting]") {
                    continue;
                }
                
                if (msg.role === "user") {
                    chatHistoryParts.push(`[USER]: ${msg.content}`);
                } else if (msg.role === "assistant") {
                    chatHistoryParts.push(`[ASSISTANT]: ${msg.content}`);
                }
            }
        }
        const chatHistory = chatHistoryParts.join("\n\n");

        // Current user_kb.md from storage.local
        const currentUserKBMd = (await getUserKBPrompt()) || "";

        // Load KB config (user-configurable thresholds)
        const kbConfig = await getKbConfig();
        log(`-- KB -- Using config: recentChats=${kbConfig.recent_chats_as_context}, retention=${kbConfig.reminder_retention_days}d`);

        // Single backend call - backend handles all orchestration
        const currentTime = formatTimestampForAgent();
        const systemMsg = {
            role: "system",
            content: "system_prompt_kb_refine",
            current_user_kb_md: currentUserKBMd,
            chat_history: chatHistory,
            current_time: currentTime,
            reminder_retention_days: kbConfig.reminder_retention_days,
            max_bullets: kbConfig.max_bullets,
        };

        const requestStartTime = Date.now();

        let response;
        try {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('KB update LLM request timeout')), KB_CONFIG.llmTimeoutMs)
            );

            const sendChatPromise = sendChatRaw([systemMsg], { ignoreSemaphore: true });

            response = await Promise.race([sendChatPromise, timeoutPromise]);
        } catch (error) {
            const requestDuration = Date.now() - requestStartTime;
            log(`-- KB -- KB update LLM request failed after ${requestDuration}ms: ${error}`, "error");
            saveChatLog("tabmail_kb_update_failed", Date.now(), [systemMsg], `ERROR: ${error}`);
            return;
        }

        const requestDuration = Date.now() - requestStartTime;
        log(`-- KB -- KB update completed in ${requestDuration}ms`);

        saveChatLog("tabmail_kb_update", Date.now(), [systemMsg], response);

        if (!response || response.err) {
            log(`-- KB -- KB update LLM returned error: ${response?.err || 'empty response'}`, "warn");
            return;
        }

        // Get the refined KB directly from the response (backend returns full object)
        if (typeof response.refined_kb !== "string") {
            log(`-- KB -- No refined_kb in response (keys: ${Object.keys(response).join(', ')})`);
            return;
        }
        const updatedKb = response.refined_kb;
        log(`-- KB -- Received refined KB from backend (${updatedKb.length} chars)`);

        // Track if KB actually changed
        const kbChanged = updatedKb !== currentUserKBMd;

        // Skip save if no change, but still mark session as remembered
        if (!kbChanged) {
            log(`-- KB -- No changes to KB after update`);
        } else {
            // Persist updated KB back to storage.local
            try {
                const key = "user_prompts:user_kb.md";
                await browser.storage.local.set({ [key]: updatedKb });
                log(`-- KB -- KB saved to disk successfully`);
            } catch (e) {
                log(`-- KB -- Failed to persist updated user_kb.md: ${e}`, "error");
                // Still mark session as remembered even if save fails
                // to prevent infinite reprocessing
            }
        }

        // Mark ALL processed sessions as remembered
        if (sessionIds && sessionIds.length > 0) {
            try {
                await markSessionsAsRemembered(sessionIds);
                log(`-- KB -- Marked ${sessionIds.length} sessions as remembered`);
            } catch (e) {
                log(`-- KB -- Failed to mark sessions as remembered: ${e}`, "warn");
            }
        }

        // Only notify and trigger reminder extraction if KB actually changed
        if (kbChanged) {
            // Notify listeners (e.g., config page) that KB prompt was updated
            try {
                const evt = (SETTINGS && SETTINGS.events && SETTINGS.events.userKBPromptUpdated) || "user-kb-prompt-updated";
                await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_kb.md", source: "conversation_memo" });
            } catch (e) {
                log(`-- KB -- Failed to send update notification: ${e}`, "warn");
            }

            // Trigger KB reminder extraction AFTER KB is saved to disk
            try {
                const { generateKBReminders } = await import("./kbReminderGenerator.js");
                log(`-- KB -- Triggering KB reminder extraction after KB save`);
                generateKBReminders(false).catch(e => {
                    log(`-- KB -- Failed to trigger KB reminder extraction: ${e}`, "warn");
                });
            } catch (e) {
                log(`-- KB -- Failed to import/trigger KB reminder extraction: ${e}`, "warn");
            }
        }

        log(`-- KB -- Knowledge base update complete (changed=${kbChanged})`);
    } catch (e) {
        log(`-- KB -- Error in kbUpdate: ${e}`, "error");
    }
}

export async function kbUpdate(conversationHistory = []) {
    return _runExclusively("kbUpdate", () => _kbUpdateImpl(conversationHistory));
}
