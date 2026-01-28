/**
 * Chat History tab functionality
 * Shows entries from Memory FTS database with search and pagination
 */

import { log } from "../../agent/modules/utils.js";
import { showStatus } from "./utils.js";

const CHAT_HISTORY_STORAGE_KEY = "chat_history_queue";
const PAGE_SIZE = 10;

let chatHistoryData = [];
let memoryFtsData = [];
let memoryFtsStats = null;
let currentPage = 1;
let totalPages = 1;
let currentSearchQuery = "";
let isSearchMode = false;

/**
 * Load chat history from Memory FTS database
 * Uses memorySearch with empty query to list all by date
 */
export async function loadChatHistory() {
    try {
        log("[Prompts] Loading chat history from Memory FTS...");
        
        // Reset search mode
        currentSearchQuery = "";
        isSearchMode = false;
        currentPage = 1;
        
        // Clear search input
        const searchInput = document.getElementById("history-search-input");
        if (searchInput) searchInput.value = "";
        
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

        // Load all entries using memorySearch with empty query (returns all sorted by date)
        try {
            const results = await browser.runtime.sendMessage({
                type: "fts",
                cmd: "memorySearch",
                q: "", // Empty query = list all by date
                limit: 200, // Get enough for pagination
                ignoreDate: true
            });
            memoryFtsData = Array.isArray(results) ? results : [];
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
 * Search chat history using Memory FTS
 */
export async function searchChatHistory(query) {
    if (!query || query.trim().length === 0) {
        // Empty query - reload all
        await loadChatHistory();
        return;
    }

    try {
        log(`[Prompts] Searching chat history for: "${query}"`);
        currentSearchQuery = query.trim();
        isSearchMode = true;
        currentPage = 1;

        const results = await browser.runtime.sendMessage({
            type: "fts",
            cmd: "memorySearch",
            q: currentSearchQuery,
            limit: 200, // Get more for local pagination
            ignoreDate: true
        });

        memoryFtsData = Array.isArray(results) ? results : [];
        log(`[Prompts] Search returned ${memoryFtsData.length} results`);

        renderChatHistory();
    } catch (e) {
        log(`[Prompts] Search failed: ${e}`, "error");
        showStatus("Search failed: " + e, true);
    }
}

/**
 * Render chat history list with pagination
 */
function renderChatHistory() {
    const container = document.getElementById("history-list");
    const emptyMessage = document.getElementById("history-empty");
    const statsDiv = document.getElementById("history-stats");
    const paginationDiv = document.getElementById("history-pagination");
    
    // Show Memory FTS stats
    const ftsDocsCount = memoryFtsStats?.docs || 0;
    const ftsDbBytes = memoryFtsStats?.dbBytes || 0;
    const ftsDbSize = ftsDbBytes > 0 ? `${(ftsDbBytes / 1024).toFixed(1)} KB` : "0 KB";
    const localQueueCount = chatHistoryData.length;
    
    let statsHtml = `
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
    
    if (isSearchMode) {
        statsHtml += `
            <span class="history-stat">
                <span class="history-stat-label">Search:</span>
                <span class="history-stat-value">"${escapeHtml(currentSearchQuery)}" (${memoryFtsData.length} results)</span>
            </span>
        `;
    }
    
    statsDiv.innerHTML = statsHtml;
    
    if (!memoryFtsData || memoryFtsData.length === 0) {
        container.innerHTML = "";
        paginationDiv.style.display = "none";
        emptyMessage.textContent = isSearchMode 
            ? `No results found for "${currentSearchQuery}".`
            : "No entries in Memory FTS database yet.";
        emptyMessage.style.display = "block";
        return;
    }
    
    emptyMessage.style.display = "none";
    container.innerHTML = "";
    
    // Calculate pagination
    totalPages = Math.ceil(memoryFtsData.length / PAGE_SIZE);
    currentPage = Math.max(1, Math.min(currentPage, totalPages));
    
    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const endIdx = Math.min(startIdx + PAGE_SIZE, memoryFtsData.length);
    const pageData = memoryFtsData.slice(startIdx, endIdx);
    
    // Add header
    const headerDiv = document.createElement("div");
    headerDiv.className = "history-section-header";
    headerDiv.textContent = isSearchMode 
        ? `Search Results (${memoryFtsData.length} total)`
        : `Memory FTS Entries (${memoryFtsData.length} total)`;
    container.appendChild(headerDiv);
    
    // Render entries for current page
    pageData.forEach((entry, idx) => {
        const entryDiv = document.createElement("div");
        entryDiv.className = "history-session";
        entryDiv.setAttribute("data-mem-id", entry.memId || "");
        
        // Flatten the content to single line for snippet
        const flatContent = (entry.content || "")
            .replace(/\n+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 150);
        
        // Header with timestamp and snippet
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
        
        // Snippet in header
        const snippetSpan = document.createElement("span");
        snippetSpan.className = "history-session-snippet";
        // Use search snippet if available, otherwise use flattened content
        // FTS returns [matched] format, convert to highlight spans
        snippetSpan.innerHTML = entry.snippet 
            ? escapeHtml(entry.snippet)
                .replace(/\[/g, '<span class="search-highlight">')
                .replace(/\]/g, '</span>')
            : escapeHtml(flatContent) || "(empty)";
        header.appendChild(snippetSpan);
        
        entryDiv.appendChild(header);
        
        // Expandable full content
        const contentDiv = document.createElement("div");
        contentDiv.className = "history-session-messages";
        
        const msgDiv = document.createElement("div");
        msgDiv.className = "history-message";
        
        // Highlight search terms in expanded content if in search mode
        if (isSearchMode && currentSearchQuery) {
            msgDiv.innerHTML = highlightSearchTerms(entry.content || "(empty)", currentSearchQuery);
        } else {
            msgDiv.textContent = entry.content || "(empty)";
        }
        
        // Debug info
        const debugDiv = document.createElement("div");
        debugDiv.className = "history-message-debug";
        debugDiv.textContent = `memId: ${entry.memId || "?"}`;
        
        contentDiv.appendChild(msgDiv);
        contentDiv.appendChild(debugDiv);
        entryDiv.appendChild(contentDiv);
        container.appendChild(entryDiv);
    });
    
    // Update pagination controls
    updatePaginationControls();
    
    log(`[Prompts] Rendered page ${currentPage}/${totalPages} (${pageData.length} entries)`);
}

/**
 * Update pagination controls
 */
function updatePaginationControls() {
    const paginationDiv = document.getElementById("history-pagination");
    const prevBtn = document.getElementById("history-prev-page");
    const nextBtn = document.getElementById("history-next-page");
    const pageInfo = document.getElementById("history-page-info");
    
    if (totalPages <= 1) {
        paginationDiv.style.display = "none";
        return;
    }
    
    paginationDiv.style.display = "flex";
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
}

/**
 * Go to previous page
 */
export function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        renderChatHistory();
    }
}

/**
 * Go to next page
 */
export function nextPage() {
    if (currentPage < totalPages) {
        currentPage++;
        renderChatHistory();
    }
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
 * Escape HTML special characters
 */
function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Highlight search terms in text
 */
function highlightSearchTerms(text, query) {
    if (!text || !query) return escapeHtml(text);
    
    // Split query into words, filter short ones
    const terms = query.split(/\s+/).filter(t => t.length >= 2);
    if (terms.length === 0) return escapeHtml(text);
    
    // Escape text first
    let result = escapeHtml(text);
    
    // Highlight each term (case insensitive)
    for (const term of terms) {
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedTerm})`, 'gi');
        result = result.replace(regex, '<span class="search-highlight">$1</span>');
    }
    
    return result;
}

/**
 * Show confirmation modal
 */
function showModal(title, contentHtml, onConfirm) {
    const overlay = document.getElementById("history-modal-overlay");
    const titleEl = document.getElementById("modal-title");
    const contentEl = document.getElementById("modal-content");
    const confirmBtn = document.getElementById("modal-confirm");
    const cancelBtn = document.getElementById("modal-cancel");
    
    titleEl.textContent = title;
    contentEl.innerHTML = contentHtml;
    overlay.style.display = "flex";
    
    // Remove old listeners
    const newConfirmBtn = confirmBtn.cloneNode(true);
    const newCancelBtn = cancelBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    
    // Add new listeners
    newConfirmBtn.addEventListener("click", () => {
        overlay.style.display = "none";
        onConfirm();
    });
    
    newCancelBtn.addEventListener("click", () => {
        overlay.style.display = "none";
    });
    
    // Close on overlay click
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            overlay.style.display = "none";
        }
    };
}

/**
 * Show Clear All confirmation
 */
export function showClearAllConfirmation() {
    showModal(
        "Clear All Chat History",
        `<p>This will permanently delete <strong>all</strong> chat history from both the local queue and the Memory FTS database.</p>
         <p style="color: var(--in-content-danger-button-background);">⚠️ This action cannot be undone.</p>`,
        async () => {
            await clearChatHistory();
        }
    );
}

/**
 * Show Delete Old History dialog
 */
export function showDeleteOldHistoryDialog() {
    showModal(
        "Delete Old History",
        `<p>Delete chat history older than a specified number of days.</p>
         <div class="modal-input-row">
             <label for="delete-days-input">Delete entries older than:</label>
             <input type="number" id="delete-days-input" value="30" min="1" max="365" />
             <span>days</span>
         </div>
         <p style="opacity: 0.7; font-size: 13px;">This will remove both local queue entries and Memory FTS entries older than the specified date.</p>`,
        async () => {
            const daysInput = document.getElementById("delete-days-input");
            const days = parseInt(daysInput?.value || "30", 10);
            if (days > 0) {
                await deleteOldHistory(days);
            }
        }
    );
}

/**
 * Delete history older than X days
 */
async function deleteOldHistory(days) {
    try {
        log(`[Prompts] Deleting history older than ${days} days...`);
        showStatus(`Deleting history older than ${days} days...`);
        
        const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);
        const cutoffDate = new Date(cutoffMs);
        
        // Find entries to delete from Memory FTS
        let deletedCount = 0;
        const idsToDelete = [];
        
        for (const entry of memoryFtsData) {
            if (entry.dateMs && entry.dateMs < cutoffMs && entry.memId) {
                idsToDelete.push(entry.memId);
            }
        }
        
        // Delete from Memory FTS
        if (idsToDelete.length > 0) {
            try {
                const result = await browser.runtime.sendMessage({
                    type: "fts",
                    cmd: "memoryRemoveBatch",
                    ids: idsToDelete
                });
                deletedCount = result?.count || idsToDelete.length;
                log(`[Prompts] Deleted ${deletedCount} entries from Memory FTS`);
            } catch (e) {
                log(`[Prompts] Failed to delete from Memory FTS: ${e}`, "warn");
            }
        }
        
        // Also clean up local queue
        const oldLocalCount = chatHistoryData.length;
        chatHistoryData = chatHistoryData.filter(session => {
            const sessionTime = session.timestamp || session.createdAt || 0;
            return sessionTime >= cutoffMs;
        });
        const localDeleted = oldLocalCount - chatHistoryData.length;
        
        if (localDeleted > 0) {
            await browser.storage.local.set({ [CHAT_HISTORY_STORAGE_KEY]: chatHistoryData });
            log(`[Prompts] Deleted ${localDeleted} sessions from local queue`);
        }
        
        showStatus(`Deleted ${deletedCount} entries older than ${cutoffDate.toLocaleDateString()}`);
        
        // Reload
        await loadChatHistory();
    } catch (e) {
        log(`[Prompts] Error deleting old history: ${e}`, "error");
        showStatus("Failed to delete old history: " + e, true);
    }
}

/**
 * Clear all chat history (both local queue and Memory FTS)
 */
export async function clearChatHistory() {
    try {
        log("[Prompts] Clearing all chat history...");
        showStatus("Clearing chat history...");

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
        currentPage = 1;
        renderChatHistory();
        showStatus("Chat history cleared");
        log("[Prompts] Chat history cleared");
    } catch (e) {
        log(`[Prompts] Error clearing chat history: ${e}`, "error");
        showStatus("Failed to clear chat history", true);
    }
}

/**
 * Initialize history tab event handlers
 */
export function initHistoryHandlers() {
    // Search handlers
    const searchInput = document.getElementById("history-search-input");
    const searchBtn = document.getElementById("history-search-btn");
    
    if (searchBtn) {
        searchBtn.addEventListener("click", () => {
            searchChatHistory(searchInput?.value || "");
        });
    }
    
    if (searchInput) {
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                searchChatHistory(searchInput.value);
            }
        });
    }
    
    // Pagination handlers
    const prevBtn = document.getElementById("history-prev-page");
    const nextBtn = document.getElementById("history-next-page");
    
    if (prevBtn) {
        prevBtn.addEventListener("click", prevPage);
    }
    
    if (nextBtn) {
        nextBtn.addEventListener("click", nextPage);
    }
    
    // Delete old history button
    const deleteOldBtn = document.getElementById("delete-old-history");
    if (deleteOldBtn) {
        deleteOldBtn.addEventListener("click", showDeleteOldHistoryDialog);
    }
}
