/**
 * Chat History tab functionality
 * Shows recent entries from Memory FTS database (for debugging)
 */

import { log } from "../../agent/modules/utils.js";
import { showStatus } from "./utils.js";

const CHAT_HISTORY_STORAGE_KEY = "chat_history_queue";
let chatHistoryData = [];
let memoryFtsData = [];
let memoryFtsStats = null;

/**
 * Load chat history from Memory FTS database
 */
export async function loadChatHistory() {
    try {
        log("[Prompts] Loading chat history from Memory FTS...");
        
        // Load Memory FTS stats
        try {
            memoryFtsStats = await browser.runtime.sendMessage({
                type: "fts",
                cmd: "memoryStats"
            });
            log(`[Prompts] Memory FTS stats: ${JSON.stringify(memoryFtsStats)}`);
        } catch (e) {
            log(`[Prompts] Failed to get Memory FTS stats: ${e}`, "warn");
            memoryFtsStats = null;
        }

        // Load recent entries from Memory FTS (debug sample)
        try {
            const debugSample = await browser.runtime.sendMessage({
                type: "fts",
                cmd: "memoryDebugSample"
            });
            memoryFtsData = Array.isArray(debugSample) ? debugSample : [];
            log(`[Prompts] Loaded ${memoryFtsData.length} entries from Memory FTS`);
        } catch (e) {
            log(`[Prompts] Failed to load Memory FTS entries: ${e}`, "warn");
            memoryFtsData = [];
        }

        // Also load local queue for comparison
        try {
            const result = await browser.storage.local.get(CHAT_HISTORY_STORAGE_KEY);
            chatHistoryData = result[CHAT_HISTORY_STORAGE_KEY] || [];
            log(`[Prompts] Local queue has ${chatHistoryData.length} sessions`);
        } catch (e) {
            chatHistoryData = [];
        }
        
        renderChatHistory();
    } catch (e) {
        log(`[Prompts] Error loading chat history: ${e}`, "error");
        document.getElementById("history-list").innerHTML = 
            '<div class="history-loading">Failed to load chat history</div>';
    }
}

/**
 * Render chat history list - shows Memory FTS entries
 */
function renderChatHistory() {
    const container = document.getElementById("history-list");
    const emptyMessage = document.getElementById("history-empty");
    const statsDiv = document.getElementById("history-stats");
    
    // Show Memory FTS stats
    const ftsDocsCount = memoryFtsStats?.docs || 0;
    const ftsDbBytes = memoryFtsStats?.dbBytes || 0;
    const ftsDbSize = ftsDbBytes > 0 ? `${(ftsDbBytes / 1024).toFixed(1)} KB` : "0 KB";
    const localQueueCount = chatHistoryData.length;
    
    statsDiv.innerHTML = `
        <span class="history-stat">
            <span class="history-stat-label">Memory FTS Entries:</span>
            <span class="history-stat-value">${ftsDocsCount}</span>
        </span>
        <span class="history-stat">
            <span class="history-stat-label">DB Size:</span>
            <span class="history-stat-value">${ftsDbSize}</span>
        </span>
        <span class="history-stat">
            <span class="history-stat-label">Local Queue:</span>
            <span class="history-stat-value">${localQueueCount} sessions</span>
        </span>
    `;
    
    if (!memoryFtsData || memoryFtsData.length === 0) {
        container.innerHTML = "";
        emptyMessage.textContent = "No entries in Memory FTS database yet.";
        emptyMessage.style.display = "block";
        return;
    }
    
    emptyMessage.style.display = "none";
    container.innerHTML = "";
    
    // Add header
    const headerDiv = document.createElement("div");
    headerDiv.className = "history-section-header";
    headerDiv.textContent = `Recent Memory FTS Entries (${memoryFtsData.length})`;
    container.appendChild(headerDiv);
    
    // Render Memory FTS entries (already sorted by date DESC from backend)
    // Display like email snippets - flattened text preview in header
    memoryFtsData.forEach((entry, idx) => {
        const entryDiv = document.createElement("div");
        entryDiv.className = "history-session";
        entryDiv.setAttribute("data-mem-id", entry.memId || "");
        
        // Flatten the content to single line for snippet
        const flatContent = (entry.content || "")
            .replace(/\n+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 150);
        
        // Header with timestamp and snippet (snippet hidden when expanded)
        const header = document.createElement("div");
        header.className = "history-session-header";
        header.onclick = () => {
            entryDiv.classList.toggle("expanded");
        };
        
        // Left side: timestamp
        const timeSpan = document.createElement("span");
        timeSpan.className = "history-session-time";
        timeSpan.textContent = formatSessionTime(entry.dateMs);
        header.appendChild(timeSpan);
        
        // Snippet in header (hidden when expanded via CSS)
        const snippetSpan = document.createElement("span");
        snippetSpan.className = "history-session-snippet";
        snippetSpan.textContent = flatContent || "(empty)";
        header.appendChild(snippetSpan);
        
        entryDiv.appendChild(header);
        
        // Expandable full content (hidden by default, shown when expanded)
        const contentDiv = document.createElement("div");
        contentDiv.className = "history-session-messages";
        
        const msgDiv = document.createElement("div");
        msgDiv.className = "history-message";
        msgDiv.textContent = entry.content || "(empty)";
        
        // Debug info (memId)
        const debugDiv = document.createElement("div");
        debugDiv.className = "history-message-debug";
        debugDiv.textContent = `memId: ${entry.memId || "?"}`;
        
        contentDiv.appendChild(msgDiv);
        contentDiv.appendChild(debugDiv);
        entryDiv.appendChild(contentDiv);
        container.appendChild(entryDiv);
    });
    
    log(`[Prompts] Rendered ${memoryFtsData.length} Memory FTS entries`);
}

/**
 * Format session timestamp for display
 */
function formatSessionTime(timestamp) {
    if (!timestamp) return "Unknown";
    
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    if (diffDays === 0) {
        return `Today at ${timeStr}`;
    } else if (diffDays === 1) {
        return `Yesterday at ${timeStr}`;
    } else if (diffDays < 7) {
        const dayName = date.toLocaleDateString([], { weekday: 'long' });
        return `${dayName} at ${timeStr}`;
    } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${timeStr}`;
    }
}

/**
 * Delete a single chat session
 */
async function deleteSession(sessionId) {
    try {
        // Filter out the session to delete
        chatHistoryData = chatHistoryData.filter(s => s.id !== sessionId);
        
        // Save to storage
        await browser.storage.local.set({ [CHAT_HISTORY_STORAGE_KEY]: chatHistoryData });
        
        // Re-render
        renderChatHistory();
        log(`[Prompts] Deleted chat session: ${sessionId}`);
    } catch (e) {
        log(`[Prompts] Error deleting session: ${e}`, "error");
        showStatus("Failed to delete session", true);
    }
}

/**
 * Re-migrate chat history: clears memory FTS and re-indexes from local queue
 */
export async function remigrateChatHistory() {
    try {
        log("[Prompts] Starting re-migration of chat history...");
        showStatus("Re-migrating chat history...");

        // Step 1: Clear memory FTS database
        try {
            await browser.runtime.sendMessage({
                type: "fts",
                cmd: "memoryClear"
            });
            log("[Prompts] Memory FTS cleared");
        } catch (e) {
            log(`[Prompts] Failed to clear Memory FTS: ${e}`, "warn");
        }

        // Step 2: Clear migration flags
        await browser.storage.local.remove([
            "memory_fts_migration_v1_done",
            "memory_fts_migrated_sessions"
        ]);
        log("[Prompts] Migration flags cleared");

        // Step 3: Trigger migration directly
        try {
            const { migrateExistingChatHistory } = await import("../../fts/memoryIndexer.js");
            const result = await migrateExistingChatHistory();
            log(`[Prompts] Migration result: ${JSON.stringify(result)}`);
            
            if (result.ok) {
                showStatus(`Re-migrated ${result.sessions} sessions (${result.indexed} entries)`);
            } else {
                showStatus("Re-migration completed with errors", true);
            }
        } catch (e) {
            log(`[Prompts] Migration failed: ${e}`, "error");
            showStatus("Re-migration failed: " + e, true);
        }

        // Step 4: Reload the page
        await loadChatHistory();
    } catch (e) {
        log(`[Prompts] Error in re-migration: ${e}`, "error");
        showStatus("Re-migration failed: " + e, true);
    }
}

/**
 * Clear all chat history (both local queue and Memory FTS)
 */
export async function clearChatHistory() {
    try {
        // Clear local queue
        await browser.storage.local.remove(CHAT_HISTORY_STORAGE_KEY);
        chatHistoryData = [];

        // Clear Memory FTS database
        try {
            await browser.runtime.sendMessage({
                type: "fts",
                cmd: "memoryClear"
            });
            log("[Prompts] Memory FTS cleared");
        } catch (e) {
            log(`[Prompts] Failed to clear Memory FTS: ${e}`, "warn");
        }

        // Clear migration flags so it can re-migrate if needed
        await browser.storage.local.remove([
            "memory_fts_migration_v1_done",
            "memory_fts_migrated_sessions"
        ]);

        memoryFtsData = [];
        memoryFtsStats = null;
        renderChatHistory();
        showStatus("Chat history and Memory FTS cleared");
        log("[Prompts] Chat history cleared");
    } catch (e) {
        log(`[Prompts] Error clearing chat history: ${e}`, "error");
        showStatus("Failed to clear chat history", true);
    }
}
