import { formatTimestampForAgent, renderToPlainText } from "../../chat/modules/helpers.js";
import { addChatToQueue, getUnrememberedSessions, markSessionsAsRemembered } from "./chatHistoryQueue.js";
import { SETTINGS } from "./config.js";
import { sendChat } from "./llm.js";
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
        // Render through markdown pipeline so [Email](id) becomes stable subject text
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

                const rendered = await renderToPlainText(msg.content);
                if (msg.role === "user") {
                    chatHistoryParts.push(`[USER]: ${rendered}`);
                } else if (msg.role === "assistant") {
                    chatHistoryParts.push(`[AGENT]: ${rendered}`);
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

            const sendChatPromise = sendChat([systemMsg], { ignoreSemaphore: true });

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

        // Index sessions to memory database (for memory_search tool)
        if (unrememberedSessions && unrememberedSessions.length > 0) {
            try {
                const { indexChatSession } = await import("../../fts/memoryIndexer.js");
                for (const session of unrememberedSessions) {
                    await indexChatSession(session.id, session.messages, session.timestamp);
                }
                log(`-- KB -- Indexed ${unrememberedSessions.length} sessions to memory DB`);
            } catch (e) {
                log(`-- KB -- Failed to index sessions to memory DB: ${e}`, "warn");
                // Continue anyway - memory indexing failure shouldn't block KB update
            }
        }

        // Mark ALL processed sessions as remembered
        if (sessionIds && sessionIds.length > 0) {
            try {
                await markSessionsAsRemembered(sessionIds);
                log(`-- KB -- Marked ${sessionIds.length} sessions as remembered`);
                // Record timestamp so init.js can filter out KB-summarized turns
                // from agentConverseMessages (avoids sending redundant history to backend)
                await browser.storage.local.set({ kb_last_summarized_ts: Date.now() });
                log(`-- KB -- Set kb_last_summarized_ts for chat history filtering`);
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

/**
 * Compress/refine the KB without chat history.
 * Triggered manually from the prompts config page.
 * Returns { ok, refined_kb, error }.
 */
export async function kbCompress() {
    return _runExclusively("kbCompress", async () => {
        try {
            const currentUserKBMd = (await getUserKBPrompt()) || "";
            if (!currentUserKBMd.trim()) {
                return { ok: true, refined_kb: "" };
            }

            const kbConfig = await getKbConfig();
            const currentTime = formatTimestampForAgent();

            const systemMsg = {
                role: "system",
                content: "system_prompt_kb_refine",
                current_user_kb_md: currentUserKBMd,
                chat_history: "",
                current_time: currentTime,
                reminder_retention_days: kbConfig.reminder_retention_days,
                max_bullets: kbConfig.max_bullets,
            };

            log(`-- KB -- Starting manual KB compress (${currentUserKBMd.split('\n').filter(l => l.trim()).length} entries)`);

            const response = await Promise.race([
                sendChat([systemMsg], { ignoreSemaphore: true }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("KB compress timeout")), KB_CONFIG.llmTimeoutMs)),
            ]);

            saveChatLog("tabmail_kb_compress", Date.now(), [systemMsg], response);

            if (!response || response.err) {
                const errMsg = response?.err || "empty response";
                log(`-- KB -- KB compress error: ${errMsg}`, "warn");
                return { ok: false, error: errMsg };
            }

            if (typeof response.refined_kb !== "string") {
                log(`-- KB -- No refined_kb in compress response`);
                return { ok: false, error: "No refined KB returned" };
            }

            const updatedKb = response.refined_kb;
            const kbChanged = updatedKb !== currentUserKBMd;

            if (kbChanged) {
                await browser.storage.local.set({ "user_prompts:user_kb.md": updatedKb });
                log(`-- KB -- Compressed KB saved (${updatedKb.split('\n').filter(l => l.trim()).length} entries)`);

                // Trigger reminder extraction after KB save
                try {
                    const { generateKBReminders } = await import("./kbReminderGenerator.js");
                    generateKBReminders(false).catch(e => {
                        log(`-- KB -- Failed to trigger KB reminder extraction after compress: ${e}`, "warn");
                    });
                } catch (e) {
                    log(`-- KB -- Failed to import KB reminder extraction: ${e}`, "warn");
                }
            } else {
                log(`-- KB -- No changes after compress`);
            }

            const result = { ok: true, refined_kb: updatedKb };
            if (response.debug_steps) {
                result.debug_steps = response.debug_steps;
            }
            return result;
        } catch (e) {
            log(`-- KB -- Error in kbCompress: ${e}`, "error");
            saveChatLog("tabmail_kb_compress_failed", Date.now(), [], `ERROR: ${e}`);
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    });
}

// ----------------------------------------------------------
// Periodic KB update for infinite chat (cursor-based, chunked)
// ----------------------------------------------------------
const KB_PERIODIC = {
    minPendingExchanges: 3,       // minimum exchanges before running
    cooldownMs: 5 * 60 * 1000,    // 5 minutes between updates
    chunkSize: 10,                 // exchanges per LLM call
    chunkOverlap: 2,               // overlapping exchanges between chunks
};

/**
 * Periodic KB refinement from accumulated persistent turns.
 * Processes unprocessed turns (after cursor) in overlapping chunks.
 * FTS indexing is NOT done here — it's immediate per-turn in converse.js.
 *
 * @param {{ skipTimeGuard?: boolean }} options
 */
export async function periodicKbUpdate(options = {}) {
    return _runExclusively("periodicKbUpdate", () => _periodicKbUpdateImpl(options));
}

async function _periodicKbUpdateImpl(options = {}) {
    const { skipTimeGuard = false } = options;

    try {
        const { loadTurns, loadMeta, getTurnsAfterCursor, advanceCursor, saveMeta, indexTurnToFTS } =
            await import("../../chat/modules/persistentChatStore.js");

        const [turns, meta] = await Promise.all([loadTurns(), loadMeta()]);

        if (!turns.length) {
            log(`-- KB Periodic -- No turns, skipping`);
            return;
        }

        // Get unprocessed turns
        const pending = getTurnsAfterCursor(turns, meta);

        // Count exchanges (user+assistant pairs)
        const pendingExchanges = Math.floor(
            pending.filter(t => t.role === "user" || t.role === "assistant").length / 2
        );

        if (pendingExchanges < KB_PERIODIC.minPendingExchanges) {
            log(`-- KB Periodic -- Only ${pendingExchanges} pending exchanges (min ${KB_PERIODIC.minPendingExchanges}), skipping`);
            return;
        }

        // Time guard (skip if recently updated, unless triggered by tool)
        if (!skipTimeGuard && meta.lastKbUpdateTs) {
            const sinceLastUpdate = Date.now() - meta.lastKbUpdateTs;
            if (sinceLastUpdate < KB_PERIODIC.cooldownMs) {
                log(`-- KB Periodic -- Last update ${Math.round(sinceLastUpdate / 60000)}min ago (cooldown ${KB_PERIODIC.cooldownMs / 60000}min), skipping`);
                return;
            }
        }

        log(`-- KB Periodic -- Starting: ${pendingExchanges} exchanges to process`);

        // Build message pairs from pending turns
        const messagePairs = [];
        for (let i = 0; i < pending.length; i++) {
            const t = pending[i];
            if (t.role === "user") {
                const next = pending[i + 1];
                if (next && next.role === "assistant") {
                    messagePairs.push({ user: t, assistant: next });
                    i++; // skip paired assistant
                }
            }
        }

        if (messagePairs.length === 0) {
            log(`-- KB Periodic -- No complete exchange pairs found, skipping`);
            return;
        }

        // --- Deferred FTS indexing: index pending turns now (before KB refinement) ---
        // FTS stores plain text (rendered via markdown pipeline) — no idMap needed.
        // FTS upserts by memId, so re-indexing on retry is safe.
        try {
            let ftsIndexed = 0;
            for (const pair of messagePairs) {
                try {
                    await indexTurnToFTS(pair.user, pair.assistant);
                    ftsIndexed++;
                } catch (e) {
                    log(`-- KB Periodic -- FTS index failed for turn ${pair.assistant._id}: ${e}`, "warn");
                }
            }
            // Also index standalone assistant turns (welcome_back, proactive, greeting)
            // that aren't part of user+assistant pairs
            const pairedTurnIds = new Set();
            for (const pair of messagePairs) {
                pairedTurnIds.add(pair.user._id);
                pairedTurnIds.add(pair.assistant._id);
            }
            for (const t of pending) {
                if (t.role === "assistant" && !pairedTurnIds.has(t._id) && t._type !== "separator") {
                    try {
                        await indexTurnToFTS(null, t);
                        ftsIndexed++;
                    } catch (e) {
                        log(`-- KB Periodic -- FTS index failed for standalone turn ${t._id}: ${e}`, "warn");
                    }
                }
            }
            if (ftsIndexed > 0) {
                log(`-- KB Periodic -- Indexed ${ftsIndexed} entries to FTS`);
            }
        } catch (e) {
            log(`-- KB Periodic -- FTS batch indexing failed (non-fatal): ${e}`, "warn");
        }

        // Process in overlapping chunks
        const { chunkSize, chunkOverlap } = KB_PERIODIC;
        const advance = chunkSize - chunkOverlap;

        let chunkStart = 0;
        let chunkIndex = 0;

        while (chunkStart < messagePairs.length) {
            const chunkEnd = Math.min(chunkStart + chunkSize, messagePairs.length);
            const chunk = messagePairs.slice(chunkStart, chunkEnd);
            chunkIndex++;

            log(`-- KB Periodic -- Chunk ${chunkIndex}: exchanges ${chunkStart + 1}-${chunkEnd} of ${messagePairs.length}`);

            // Build chat history text from chunk
            // Render through markdown pipeline so [Email](id) becomes stable subject text
            const chatHistoryParts = [];
            for (const pair of chunk) {
                const userText = pair.user.user_message || pair.user.content || "";
                const assistantText = pair.assistant.content || "";
                if (userText) chatHistoryParts.push(`[USER]: ${await renderToPlainText(userText)}`);
                if (assistantText) chatHistoryParts.push(`[AGENT]: ${await renderToPlainText(assistantText)}`);
            }
            const chatHistory = chatHistoryParts.join("\n\n");

            // Send to backend for KB refinement
            try {
                const currentUserKBMd = (await getUserKBPrompt()) || "";
                const kbConfig = await getKbConfig();
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
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("KB periodic chunk timeout")), KB_CONFIG.llmTimeoutMs)
                );
                const sendChatPromise = sendChat([systemMsg], { ignoreSemaphore: true });
                const response = await Promise.race([sendChatPromise, timeoutPromise]);

                const requestDuration = Date.now() - requestStartTime;
                log(`-- KB Periodic -- Chunk ${chunkIndex} completed in ${requestDuration}ms`);

                if (response && typeof response.refined_kb === "string") {
                    const updatedKb = response.refined_kb;
                    if (updatedKb !== currentUserKBMd) {
                        const key = "user_prompts:user_kb.md";
                        await browser.storage.local.set({ [key]: updatedKb });
                        log(`-- KB Periodic -- Chunk ${chunkIndex}: KB updated (${updatedKb.length} chars)`);

                        // Notify listeners
                        try {
                            const evt = (SETTINGS?.events?.userKBPromptUpdated) || "user-kb-prompt-updated";
                            await browser.runtime.sendMessage({ command: evt, key, source: "periodic_kb_update" });
                        } catch (_) {}

                        // Trigger KB reminder extraction
                        try {
                            const { generateKBReminders } = await import("./kbReminderGenerator.js");
                            generateKBReminders(false).catch(() => {});
                        } catch (_) {}
                    } else {
                        log(`-- KB Periodic -- Chunk ${chunkIndex}: no KB changes`);
                    }
                } else {
                    log(`-- KB Periodic -- Chunk ${chunkIndex}: no refined_kb in response`, "warn");
                }

                saveChatLog("tabmail_kb_periodic", Date.now(), [systemMsg], response);
            } catch (e) {
                log(`-- KB Periodic -- Chunk ${chunkIndex} failed: ${e}`, "error");
                // Continue to next chunk — partial progress is saved via cursor
            }

            // Advance cursor to last pair in this chunk
            const lastPairInChunk = chunk[chunk.length - 1];
            advanceCursor(meta, lastPairInChunk.assistant._id);

            // Move to next chunk (advance by chunkSize - overlap)
            chunkStart += advance;
        }

        // Update lastKbUpdateTs
        meta.lastKbUpdateTs = Date.now();
        saveMeta(meta);

        // Record timestamp so init.js can filter out KB-summarized turns
        // from agentConverseMessages (avoids sending redundant history to backend)
        try {
            await browser.storage.local.set({ kb_last_summarized_ts: Date.now() });
            log(`-- KB Periodic -- Set kb_last_summarized_ts for chat history filtering`);
        } catch (e) {
            log(`-- KB Periodic -- Failed to set kb_last_summarized_ts: ${e}`, "warn");
        }

        log(`-- KB Periodic -- Complete: processed ${chunkIndex} chunk(s), ${messagePairs.length} exchanges`);
    } catch (e) {
        log(`-- KB Periodic -- Error: ${e}`, "error");
    }
}

// ----------------------------------------------------------
// Debounced KB update (triggered by kb_add / kb_del tools)
// ----------------------------------------------------------
let _kbUpdateDebounceTimer = null;
const KB_TOOL_DEBOUNCE_MS = 30000; // 30 seconds after last kb_add/kb_del call

export function debouncedKbUpdate() {
    if (_kbUpdateDebounceTimer) clearTimeout(_kbUpdateDebounceTimer);
    _kbUpdateDebounceTimer = setTimeout(() => {
        _kbUpdateDebounceTimer = null;
        periodicKbUpdate({ skipTimeGuard: true }).catch(e => {
            log(`-- KB -- Debounced KB update failed: ${e}`, "warn");
        });
    }, KB_TOOL_DEBOUNCE_MS);
}
