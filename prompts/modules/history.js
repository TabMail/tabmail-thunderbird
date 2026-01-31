/**
 * Chat History tab functionality
 * Default: shows recent turns from persistent chat store (chat_turns)
 * Search: queries Memory FTS, formats like memory_read output
 */

import { log } from "../../agent/modules/utils.js";
import { showStatus } from "./utils.js";

const CHAT_TURNS_KEY = "chat_turns";
const CHAT_META_KEY = "chat_meta";
const CHAT_ID_MAP_KEY = "chat_id_map";
const PAGE_SIZE = 20;

let displayData = []; // unified display list (turns or FTS results)
let memoryFtsStats = null;
let turnsCount = 0;
let currentPage = 1;
let totalPages = 1;
let currentSearchQuery = "";
let isSearchMode = false;

/**
 * Load chat history — default view from persistent chat_turns
 */
export async function loadChatHistory() {
    try {
        log("[Prompts] Loading chat history from persistent turns...");

        // Reset search mode
        currentSearchQuery = "";
        isSearchMode = false;
        currentPage = 1;

        // Clear search input
        const searchInput = document.getElementById("history-search-input");
        if (searchInput) searchInput.value = "";

        // Load Memory FTS stats (for display)
        try {
            memoryFtsStats = await browser.runtime.sendMessage({
                type: "fts",
                cmd: "memoryStats"
            });
        } catch (e) {
            log(`[Prompts] Failed to get Memory FTS stats: ${e}`, "warn");
            memoryFtsStats = null;
        }

        // Load turns from persistent store (newest first for display)
        try {
            const result = await browser.storage.local.get(CHAT_TURNS_KEY);
            const turns = result[CHAT_TURNS_KEY] || [];
            turnsCount = turns.length;
            // Reverse to show newest first
            displayData = turns.slice().reverse();
            log(`[Prompts] Loaded ${turnsCount} turns from chat_turns`);
        } catch (e) {
            log(`[Prompts] Failed to load chat turns: ${e}`, "warn");
            displayData = [];
            turnsCount = 0;
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
            limit: 200,
            ignoreDate: true
        });

        displayData = Array.isArray(results) ? results : [];
        log(`[Prompts] Search returned ${displayData.length} results`);

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

    // Stats bar
    const ftsDocsCount = memoryFtsStats?.docs || 0;
    const ftsDbBytes = memoryFtsStats?.dbBytes || 0;
    const ftsDbSize = ftsDbBytes > 0 ? `${(ftsDbBytes / 1024).toFixed(1)} KB` : "0 KB";

    let statsHtml = `
        <span class="history-stat">
            <span class="history-stat-label">Active turns:</span>
            <span class="history-stat-value">${turnsCount}</span>
        </span>
        <span class="history-stat">
            <span class="history-stat-label">Searchable entries:</span>
            <span class="history-stat-value">${ftsDocsCount}</span>
        </span>
        <span class="history-stat">
            <span class="history-stat-label">DB Size:</span>
            <span class="history-stat-value">${ftsDbSize}</span>
        </span>
    `;

    if (isSearchMode) {
        statsHtml += `
            <span class="history-stat">
                <span class="history-stat-label">Search:</span>
                <span class="history-stat-value">"${escapeHtml(currentSearchQuery)}" (${displayData.length} results)</span>
            </span>
        `;
    }

    statsDiv.innerHTML = statsHtml;

    if (!displayData || displayData.length === 0) {
        container.innerHTML = "";
        paginationDiv.style.display = "none";
        emptyMessage.textContent = isSearchMode
            ? `No results found for "${currentSearchQuery}".`
            : "No chat history yet. Chat turns are saved as you use the chat.";
        emptyMessage.style.display = "block";
        return;
    }

    emptyMessage.style.display = "none";
    container.innerHTML = "";

    // Calculate pagination
    totalPages = Math.ceil(displayData.length / PAGE_SIZE);
    currentPage = Math.max(1, Math.min(currentPage, totalPages));

    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const endIdx = Math.min(startIdx + PAGE_SIZE, displayData.length);
    const pageData = displayData.slice(startIdx, endIdx);

    if (isSearchMode) {
        renderSearchResults(container, pageData);
    } else {
        renderTurns(container, pageData);
    }

    updatePaginationControls();
    log(`[Prompts] Rendered page ${currentPage}/${totalPages} (${pageData.length} entries)`);
}

/**
 * Render turns from persistent store (default view).
 * Simple flat list — each turn shows role, timestamp, content.
 */
function renderTurns(container, turns) {
    for (const turn of turns) {
        if (turn._type === "separator") {
            const sep = document.createElement("div");
            sep.className = "history-turn-separator";
            sep.textContent = turn.content?.replace("--- ", "").replace(" ---", "") || "New topic";
            container.appendChild(sep);
            continue;
        }

        const turnDiv = document.createElement("div");
        const roleClass = turn.role === "user" ? "user" : "assistant";
        turnDiv.className = `history-turn history-turn-${roleClass}`;

        // Role + timestamp header
        const headerDiv = document.createElement("div");
        headerDiv.className = "history-turn-header";

        const roleSpan = document.createElement("span");
        roleSpan.className = "history-turn-role";
        roleSpan.textContent = turn.role === "user" ? "You" : "TabMail";
        headerDiv.appendChild(roleSpan);

        if (turn._ts) {
            const timeSpan = document.createElement("span");
            timeSpan.className = "history-turn-time";
            timeSpan.textContent = formatSessionTime(turn._ts);
            headerDiv.appendChild(timeSpan);
        }

        if (turn._type && turn._type !== "normal") {
            const typeSpan = document.createElement("span");
            typeSpan.className = "history-turn-type";
            typeSpan.textContent = turn._type.replace(/_/g, " ");
            headerDiv.appendChild(typeSpan);
        }

        turnDiv.appendChild(headerDiv);

        // Content — for user turns show user_message (actual text), not template token
        const contentDiv = document.createElement("div");
        contentDiv.className = "history-turn-content";
        const text = turn.role === "user"
            ? (turn.user_message || turn.content || "")
            : (turn.content || "");
        contentDiv.textContent = text;
        turnDiv.appendChild(contentDiv);

        container.appendChild(turnDiv);
    }
}

/**
 * Render search results from FTS (search view).
 * Formatted like memory_read output: "--- Conversation from <date> ---" + content.
 */
function renderSearchResults(container, results) {
    const headerDiv = document.createElement("div");
    headerDiv.className = "history-section-header";
    headerDiv.textContent = `Search Results (${displayData.length} total)`;
    container.appendChild(headerDiv);

    for (const entry of results) {
        const entryDiv = document.createElement("div");
        entryDiv.className = "history-search-result";

        // Date header (like memory_read format)
        const dateStr = entry.dateMs
            ? new Date(entry.dateMs).toLocaleDateString("en-US", {
                  month: "short", day: "numeric", year: "numeric",
                  hour: "2-digit", minute: "2-digit",
              })
            : "Unknown date";

        const dateHeader = document.createElement("div");
        dateHeader.className = "history-search-result-date";
        dateHeader.textContent = `Conversation from ${dateStr}`;
        entryDiv.appendChild(dateHeader);

        // Content with search highlight
        const contentDiv = document.createElement("div");
        contentDiv.className = "history-search-result-content";
        if (currentSearchQuery) {
            contentDiv.innerHTML = highlightSearchTerms(entry.content || "(empty)", currentSearchQuery);
        } else {
            contentDiv.textContent = entry.content || "(empty)";
        }
        entryDiv.appendChild(contentDiv);

        container.appendChild(entryDiv);
    }
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
 * Format timestamp for display
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

    const terms = query.split(/\s+/).filter(t => t.length >= 2);
    if (terms.length === 0) return escapeHtml(text);

    let result = escapeHtml(text);

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

    newConfirmBtn.addEventListener("click", () => {
        overlay.style.display = "none";
        onConfirm();
    });

    newCancelBtn.addEventListener("click", () => {
        overlay.style.display = "none";
    });

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
        `<p>This will permanently delete <strong>all</strong> chat turns, search index, and persistent chat state.</p>
         <p style="color: var(--in-content-danger-button-background);">This action cannot be undone.</p>`,
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
         <p style="opacity: 0.7; font-size: 13px;">This removes old turns from active chat and old entries from the search index.</p>`,
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

        // 1. Trim old turns from chat_turns
        let turnsDeleted = 0;
        try {
            const result = await browser.storage.local.get(CHAT_TURNS_KEY);
            const turns = result[CHAT_TURNS_KEY] || [];
            const oldCount = turns.length;
            const kept = turns.filter(t => (t._ts || 0) >= cutoffMs);
            turnsDeleted = oldCount - kept.length;
            if (turnsDeleted > 0) {
                await browser.storage.local.set({ [CHAT_TURNS_KEY]: kept });
                log(`[Prompts] Deleted ${turnsDeleted} old turns from chat_turns`);
            }
        } catch (e) {
            log(`[Prompts] Failed to trim old turns: ${e}`, "warn");
        }

        // 2. Delete old entries from Memory FTS
        let ftsDeleted = 0;
        try {
            // Load FTS entries to find old ones
            const ftsResults = await browser.runtime.sendMessage({
                type: "fts",
                cmd: "memorySearch",
                q: "",
                limit: 500,
                ignoreDate: true
            });
            const idsToDelete = [];
            for (const entry of (ftsResults || [])) {
                if (entry.dateMs && entry.dateMs < cutoffMs && entry.memId) {
                    idsToDelete.push(entry.memId);
                }
            }
            if (idsToDelete.length > 0) {
                const result = await browser.runtime.sendMessage({
                    type: "fts",
                    cmd: "memoryRemoveBatch",
                    ids: idsToDelete
                });
                ftsDeleted = result?.count || idsToDelete.length;
                log(`[Prompts] Deleted ${ftsDeleted} old entries from Memory FTS`);
            }
        } catch (e) {
            log(`[Prompts] Failed to delete old FTS entries: ${e}`, "warn");
        }

        showStatus(`Deleted ${turnsDeleted} turns + ${ftsDeleted} search entries older than ${cutoffDate.toLocaleDateString()}`);

        await loadChatHistory();
    } catch (e) {
        log(`[Prompts] Error deleting old history: ${e}`, "error");
        showStatus("Failed to delete old history: " + e, true);
    }
}

/**
 * Clear all chat history (turns, FTS, persistent state)
 */
export async function clearChatHistory() {
    try {
        log("[Prompts] Clearing all chat history...");
        showStatus("Clearing chat history...");

        // Clear persistent chat turns, metadata, idMap
        await browser.storage.local.remove([CHAT_TURNS_KEY, CHAT_META_KEY, CHAT_ID_MAP_KEY]);
        log("[Prompts] Cleared chat_turns, chat_meta, chat_id_map");

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

        // Clear migration flags
        await browser.storage.local.remove([
            "memory_fts_migration_v1_done",
            "memory_fts_migrated_sessions",
            "chat_turns_migration_v1",
            "chat_turns_migration_v2",
            "chat_refs_migration_v1"
        ]);

        displayData = [];
        turnsCount = 0;
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

    const prevBtn = document.getElementById("history-prev-page");
    const nextBtn = document.getElementById("history-next-page");

    if (prevBtn) {
        prevBtn.addEventListener("click", prevPage);
    }

    if (nextBtn) {
        nextBtn.addEventListener("click", nextPage);
    }

    const deleteOldBtn = document.getElementById("delete-old-history");
    if (deleteOldBtn) {
        deleteOldBtn.addEventListener("click", showDeleteOldHistoryDialog);
    }
}
