/**
 * Chat History Queue Manager
 * 
 * Maintains a persistent queue of recent chat histories (user/agent messages only)
 * that can be included in the KB section of system prompts.
 * 
 * Each session has a "remembered" flag:
 * - false: Not yet processed into KB, included in getRecentChatHistoryForPrompt
 * - true: Already summarized into KB, excluded from prompt
 * 
 * This provides "mid-term memory" before chats are summarized into the KB.
 */

import { log } from "./utils.js";

const STORAGE_KEY = "chat_history_queue";

/**
 * Sanitize text to ensure valid UTF-8 for JSON serialization.
 * Removes null bytes, control characters, and other problematic chars.
 * @param {string} text - Input text
 * @returns {string} - Sanitized text
 */
function sanitizeForJson(text) {
    if (!text || typeof text !== 'string') return '';
    // Remove null bytes and control characters (except newline, tab, carriage return)
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
const CONFIG_KEY = "chat_history_queue_config";

// Default configuration
const DEFAULT_CONFIG = {
    maxQueueSize: 100, // Keep up to N chat sessions
    maxAgeDays: 30, // Prune sessions older than N days
};

/**
 * Load configuration from storage
 */
async function getConfig() {
    try {
        const result = await browser.storage.local.get(CONFIG_KEY);
        const config = result[CONFIG_KEY];
        if (config && typeof config === "object") {
            return { ...DEFAULT_CONFIG, ...config };
        }
    } catch (e) {
        log(`[ChatHistoryQueue] Failed to load config: ${e}`, "warn");
    }
    return DEFAULT_CONFIG;
}

/**
 * Load the chat history queue from storage
 * Also sanitizes message content to fix any previously corrupted data
 */
export async function loadChatHistoryQueue() {
    try {
        const result = await browser.storage.local.get(STORAGE_KEY);
        const queue = result[STORAGE_KEY];
        if (Array.isArray(queue)) {
            // Sanitize all message content on load to fix any corrupted data
            for (const session of queue) {
                if (Array.isArray(session.messages)) {
                    for (const msg of session.messages) {
                        if (msg.content && typeof msg.content === 'string') {
                            msg.content = sanitizeForJson(msg.content);
                        }
                    }
                }
            }
            log(`[ChatHistoryQueue] Loaded ${queue.length} sessions from storage`);
            return queue;
        }
    } catch (e) {
        log(`[ChatHistoryQueue] Failed to load queue: ${e}`, "warn");
    }
    return [];
}

/**
 * Save the chat history queue to storage
 */
async function saveChatHistoryQueue(queue) {
    try {
        await browser.storage.local.set({ [STORAGE_KEY]: queue });
        log(`[ChatHistoryQueue] Saved ${queue.length} sessions to storage`);
    } catch (e) {
        log(`[ChatHistoryQueue] Failed to save queue: ${e}`, "error");
    }
}

/**
 * Add a chat session to the queue
 * @param {Array} conversationHistory - Full conversation history
 * @returns {string|null} - Session ID if added, null otherwise
 */
export async function addChatToQueue(conversationHistory) {
    if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
        log(`[ChatHistoryQueue] No conversation to queue`);
        return null;
    }

    const config = await getConfig();

    // Filter to only user and assistant messages (no system, no tool responses)
    // Process messages to extract actual content
    const processed = [];
    let isFirstAssistant = true;

    for (const msg of conversationHistory) {
        if (msg.role !== "user" && msg.role !== "assistant") {
            continue;
        }

        // Skip the first assistant message (automated greeting - not useful to store)
        if (msg.role === "assistant" && isFirstAssistant) {
            isFirstAssistant = false;
            // Add a marker instead of the full greeting to save space
            processed.push({
                role: "assistant",
                content: "[automated greeting]",
            });
            continue;
        }
        if (msg.role === "assistant") {
            isFirstAssistant = false;
        }

        // Messages are already rendered to plain text by chat.js before sending to background
        // Just extract the content directly
        let content = "";
        if (msg.role === "user") {
            // chat.js already resolved user_message and put result in content
            content = msg.content || msg.user_message || "";
        } else {
            content = typeof msg.content === "string" ? msg.content : "";
        }
        
        // Skip empty messages
        if (!content || !content.trim()) {
            continue;
        }

        processed.push({
            role: msg.role,
            content: content,
        });
    }

    if (processed.length === 0) {
        log(`[ChatHistoryQueue] No meaningful messages to queue`);
        return null;
    }

    // Create session entry with unique ID
    const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const session = {
        id: sessionId,
        timestamp: Date.now(),
        remembered: false, // Not yet processed into KB
        messages: processed,
    };

    // Load existing queue
    const queue = await loadChatHistoryQueue();

    // Add new session
    queue.push(session);

    // Trim to max size (remove oldest first, but prefer removing remembered ones)
    while (queue.length > config.maxQueueSize) {
        // Find first remembered session to remove, or oldest if none
        const rememberedIdx = queue.findIndex(s => s.remembered);
        if (rememberedIdx !== -1) {
            queue.splice(rememberedIdx, 1);
        } else {
            queue.shift();
        }
    }

    // Save
    await saveChatHistoryQueue(queue);
    log(`[ChatHistoryQueue] Added session ${sessionId} with ${processed.length} messages`);
    return sessionId;
}

/**
 * Mark sessions as remembered (processed into KB)
 * @param {string[]} sessionIds - Array of session IDs to mark
 */
export async function markSessionsAsRemembered(sessionIds) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return;
    }

    const queue = await loadChatHistoryQueue();
    const idSet = new Set(sessionIds);
    let marked = 0;

    for (const session of queue) {
        if (idSet.has(session.id) && !session.remembered) {
            session.remembered = true;
            marked++;
        }
    }

    if (marked > 0) {
        await saveChatHistoryQueue(queue);
        log(`[ChatHistoryQueue] Marked ${marked} sessions as remembered`);
    }
}

/**
 * Mark all unremembered sessions as remembered
 */
export async function markAllAsRemembered() {
    const queue = await loadChatHistoryQueue();
    let marked = 0;

    for (const session of queue) {
        if (!session.remembered) {
            session.remembered = true;
            marked++;
        }
    }

    if (marked > 0) {
        await saveChatHistoryQueue(queue);
        log(`[ChatHistoryQueue] Marked ${marked} sessions as remembered`);
    }
}

/**
 * Get formatted recent chat history for inclusion in system prompt
 * Only returns the most recent N sessions that are NOT marked as remembered
 * @param {number} maxSessions - Maximum number of sessions to include (default from config)
 */
export async function getRecentChatHistoryForPrompt(maxSessions = null) {
    const queue = await loadChatHistoryQueue();
    
    // Get limit from config if not provided
    if (maxSessions === null) {
        try {
            const key = "user_prompts:kb_config";
            const obj = await browser.storage.local.get(key);
            const config = obj[key] || {};
            maxSessions = config.recent_chats_as_context ?? 10;
        } catch (e) {
            maxSessions = 10; // Default fallback
        }
    }
    
    // If limit is 0, don't include any recent chats
    if (maxSessions <= 0) {
        log(`[ChatHistoryQueue] Recent chats disabled (maxSessions=0)`);
        return "";
    }
    
    // Include ALL recent sessions (both remembered and unremembered) within limit
    // Sort by timestamp (most recent first), take limit
    const recentSessions = queue
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, maxSessions);
    
    if (recentSessions.length === 0) {
        return "";
    }

    log(`[ChatHistoryQueue] Including ${recentSessions.length} recent sessions as context (max=${maxSessions})`);

    const parts = [];
    
    // Reverse to show oldest first in the context
    for (const session of recentSessions.reverse()) {
        const sessionDate = new Date(session.timestamp);
        const dateStr = sessionDate.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
        
        const msgLines = session.messages.map(msg => {
            const prefix = msg.role === "user" ? "[USER]" : "[AGENT]";
            // Skip automated greeting markers
            if (msg.content === "[automated greeting]") {
                return `${prefix}: (automated greeting)`;
            }
            // Sanitize content - remove null bytes and control characters
            let content = sanitizeForJson(msg.content || "");
            // Truncate long messages
            if (content.length > 200) {
                content = content.substring(0, 200) + "...";
            }
            return `${prefix}: ${content}`;
        });
        
        if (msgLines.length > 0) {
            parts.push(`--- Session ${dateStr} ---\n${msgLines.join("\n")}`);
        }
    }

    // Sanitize the entire output to ensure valid UTF-8 for JSON serialization
    return sanitizeForJson(parts.join("\n\n"));
}

/**
 * Get IDs of all unremembered sessions
 */
export async function getUnrememberedSessionIds() {
    const queue = await loadChatHistoryQueue();
    return queue.filter(s => !s.remembered).map(s => s.id);
}

/**
 * Get all unremembered sessions with their messages
 * Used for KB updates to process all pending sessions
 * @returns {Promise<Array>} Array of session objects with id, timestamp, messages
 */
export async function getUnrememberedSessions() {
    const queue = await loadChatHistoryQueue();
    return queue
        .filter(s => !s.remembered)
        .sort((a, b) => a.timestamp - b.timestamp); // Sort oldest first for chronological processing
}

/**
 * Clear old sessions from the queue (sessions older than N days)
 * @param {number} maxAgeDays - Maximum age in days (optional, uses config default)
 */
export async function pruneOldSessions(maxAgeDays) {
    const config = await getConfig();
    const ageDays = maxAgeDays ?? config.maxAgeDays;
    
    const queue = await loadChatHistoryQueue();
    const cutoff = Date.now() - (ageDays * 24 * 60 * 60 * 1000);
    
    const pruned = queue.filter(session => session.timestamp > cutoff);
    
    if (pruned.length < queue.length) {
        await saveChatHistoryQueue(pruned);
        log(`[ChatHistoryQueue] Pruned ${queue.length - pruned.length} old sessions`);
    }
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
    const queue = await loadChatHistoryQueue();
    const remembered = queue.filter(s => s.remembered).length;
    const unremembered = queue.filter(s => !s.remembered).length;
    return {
        total: queue.length,
        remembered,
        unremembered,
    };
}
