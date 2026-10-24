/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Chat History tab functionality
 * Default: shows the memory's size and an empty list
 * Search: queries Memory FTS and shows a preview of each entry, as Voice does
 */

import { log } from "../../agent/modules/utils.js";
import { showStatus } from "./utils.js";
import { clearAllThinking } from "../../chat/modules/persistentChatStore.js";
import { SETTINGS } from "../../agent/modules/config.js";
import { CHAT_SETTINGS } from "../../chat/modules/chatConfig.js";
import { formatBytes, getMemorySizeLimitBytes, setMemorySizeLimitBytes } from "../../fts/memorySizeLimit.js";

const CHAT_TURNS_KEY = "chat_turns";
const CHAT_META_KEY = "chat_meta";
const CHAT_ID_MAP_KEY = "chat_id_map";
const PAGE_SIZE = 20;
// Said in place of a reply when a long request fills the preview.
const PREVIEW_NO_REPLY_NOTE = "The rest is not shown: the request is too long to preview.";

let displayData = []; // unified display list (turns or FTS results)
let memoryFtsStats = null;
let memorySizeLimitBytes = null;
let turnsCount = 0;
let currentPage = 1;
let totalPages = 1;
let currentSearchQuery = "";
let isSearchMode = false;
// A search that answers after a later search or a reload doesn't render over
// it. A page change while a search is pending pages the results shown.
let searchToken = 0;

/**
 * Load chat history — shows stats + search bar only (no entries until search).
 */
export async function loadChatHistory() {
    try {
        log("[Prompts] Loading chat history stats...");
        searchToken++;

        // Reset search mode
        currentSearchQuery = "";
        isSearchMode = false;
        currentPage = 1;
        displayData = [];

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

        memorySizeLimitBytes = await getMemorySizeLimitBytes();

        // Load active turns count for stats display
        try {
            const result = await browser.storage.local.get(CHAT_TURNS_KEY);
            turnsCount = (result[CHAT_TURNS_KEY] || []).length;
        } catch (e) {
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
 * Search chat history using Memory FTS. The helper answers the start of each
 * result (previewChars), which is what the page shows: Thunderbird refuses a
 * native message over 1 MiB, and memory entries are stored whole.
 */
export async function searchChatHistory(query) {
    if (!query || query.trim().length === 0) {
        await loadChatHistory();
        return;
    }

    const search = ++searchToken;
    try {
        log(`[Prompts] Searching chat history for: "${query}"`);
        const q = query.trim();

        const results = await browser.runtime.sendMessage({
            type: "fts",
            cmd: "memorySearch",
            q,
            // The best matches, as many as the chat's memory_search fetches (100 everywhere, #150).
            limit: CHAT_SETTINGS.memorySearchMaxResults,
            ignoreDate: true,
            // One more than shown, so an entry that goes on is told from one that ends there.
            previewChars: SETTINGS.memoryManagement.chatHistorySearchPreviewChars + 1
        });
        if (search !== searchToken) return;
        if (results?.error) {
            log(`[Prompts] Search failed: ${results.error}`, "error");
            showStatus("Search failed: " + results.error, true);
            return;
        }

        currentSearchQuery = q;
        isSearchMode = true;
        currentPage = 1;
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

    renderMemoryUsage();

    // Stats bar
    const ftsDocsCount = memoryFtsStats?.docs || 0;

    let statsHtml = `
        <span class="history-stat">
            <span class="history-stat-label">Active turns:</span>
            <span class="history-stat-value">${turnsCount}</span>
        </span>
        <span class="history-stat">
            <span class="history-stat-label">Searchable entries:</span>
            <span class="history-stat-value">${ftsDocsCount}</span>
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
        if (isSearchMode) {
            emptyMessage.textContent = `No results found for "${currentSearchQuery}".`;
            emptyMessage.style.display = "block";
        } else {
            // Default view: no entries shown, just stats + search bar
            emptyMessage.textContent = "Use the search bar to find past conversations.";
            emptyMessage.style.display = "block";
        }
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

    // Both default and search views use FTS data — render as conversation entries
    renderFtsEntries(container, pageData);

    updatePaginationControls();
    log(`[Prompts] Rendered page ${currentPage}/${totalPages} (${pageData.length} entries)`);
}

/**
 * Usage bar: memory used against the size limit, and the limit choice.
 * `usedBytes` (pages in use) is what the helper's limit counts; a helper
 * without the size limit reports only the file size and keeps no limit.
 */
function renderMemoryUsage() {
    const label = document.getElementById("history-usage-label");
    const bar = document.getElementById("history-usage-bar");
    const select = document.getElementById("history-size-limit");
    const note = document.getElementById("history-usage-note");
    if (!label || !bar || !select || !note) return;

    const limit = memorySizeLimitBytes ?? SETTINGS.memoryManagement.memorySizeLimitDefaultBytes;
    const choices = SETTINGS.memoryManagement.memorySizeLimitChoicesBytes;
    if (select.options.length !== choices.length) {
        select.replaceChildren(...choices.map(bytes => new Option(formatBytes(bytes), String(bytes))));
    }
    select.value = String(limit);

    const hasLimit = typeof memoryFtsStats?.usedBytes === "number";
    const used = hasLimit ? memoryFtsStats.usedBytes : memoryFtsStats?.dbBytes;
    bar.max = limit;
    note.style.display = "block";
    // No stats (helper not running, or an error reply): say so rather than show 0.
    if (typeof used !== "number") {
        label.textContent = `Memory used: unavailable (limit ${formatBytes(limit)})`;
        bar.value = 0;
        note.textContent = "Memory usage shows once the search helper is running.";
        return;
    }
    label.textContent = `Memory used: ${formatBytes(used)} of ${formatBytes(limit)}`;
    bar.value = Math.min(used, limit);

    note.textContent = hasLimit
        ? "When memory reaches the limit, the oldest conversations are removed first."
        : "The size limit applies once the search helper updates.";
}

/**
 * Store a new size limit and apply it now: the helper removes the oldest
 * entries until memory fits, or as many as its time allows (`withinLimit`
 * false), and the rest go with the next entries kept.
 */
async function changeMemorySizeLimit(bytes) {
    let saved = false;
    try {
        await setMemorySizeLimitBytes(bytes);
        saved = true;
        log(`[Prompts] Memory size limit set to ${bytes} bytes`);
        const result = await browser.runtime.sendMessage({ type: "fts", cmd: "memoryTrim" });
        if (result?.unsupported) {
            showStatus(`Size limit set to ${formatBytes(bytes)}. It applies once the search helper updates.`);
        } else if (result?.error) {
            log(`[Prompts] Applying the memory size limit failed: ${result.error}`, "warn");
            showStatus("Size limit saved, but applying it failed: " + result.error, true);
        } else {
            const removed = result?.trimmed || 0;
            let status = `Size limit set to ${formatBytes(bytes)}.`;
            if (removed > 0) status += removed === 1 ? " Removed the oldest entry." : ` Removed the ${removed} oldest entries.`;
            if (result?.withinLimit === false) status += " More are removed as new conversations are kept.";
            showStatus(status);
        }
        await loadChatHistory();
    } catch (e) {
        log(`[Prompts] Error changing memory size limit: ${e}`, "error");
        if (!saved) {
            showStatus("Failed to change the size limit: " + e, true);
            return;
        }
        // Saved: the next memory write applies it.
        showStatus("Size limit saved, but applying it failed: " + e, true);
        await loadChatHistory();
    }
}

/**
 * Render search results: each entry's preview as what was asked, then what
 * the agent did.
 */
function renderFtsEntries(container, entries) {
    if (isSearchMode) {
        const headerDiv = document.createElement("div");
        headerDiv.className = "history-section-header";
        headerDiv.textContent = `Search Results (${displayData.length} total)`;
        container.appendChild(headerDiv);
    }

    for (const entry of entries) {
        const entryDiv = document.createElement("div");
        entryDiv.className = "history-search-result";

        // Date header
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

        // What was asked, then what the agent did, as Voice shows them;
        // search words highlighted.
        const contentDiv = document.createElement("div");
        contentDiv.className = "history-search-result-content";
        const { text: preview, cut } = previewText(entry.content);
        let { request, agent } = exchangeOf(preview);
        // The ellipsis goes on the last part shown, after the split: a cut
        // just past the reply label leaves no reply (and the note), not "…".
        if (cut) {
            if (agent) agent += "…";
            else request += "…";
        }
        for (const [text, className] of [[request, "history-search-result-request"], [agent, "history-search-result-reply"]]) {
            if (!text) continue;
            const part = document.createElement("div");
            part.className = className;
            if (isSearchMode && currentSearchQuery) {
                part.innerHTML = highlightSearchTerms(text, currentSearchQuery);
            } else {
                part.textContent = text;
            }
            contentDiv.appendChild(part);
        }
        // A long request fills the preview before the reply starts: say so,
        // rather than leave the reply looking empty (owner 2026-10-21).
        if (cut && !agent) {
            const note = document.createElement("div");
            note.className = "history-search-result-reply history-search-result-note";
            note.textContent = PREVIEW_NO_REPLY_NOTE;
            contentDiv.appendChild(note);
        }
        entryDiv.appendChild(contentDiv);

        container.appendChild(entryDiv);
    }
}

/**
 * The start of an entry, as the search asked for it (an older helper answers
 * whole entries); `cut` says it goes on.
 */
function previewText(content) {
    if (!content) return { text: "(empty)", cut: false };
    const chars = [...content];
    const max = SETTINGS.memoryManagement.chatHistorySearchPreviewChars;
    return chars.length > max ? { text: chars.slice(0, max).join(""), cut: true } : { text: content, cut: false };
}

/**
 * An entry split into what the user asked and what the agent did, as Voice
 * splits it (`[USER]: …` then `[AGENT]: …`; `[ASSISTANT]` in entries written
 * before v1.2.9). An entry with no request (a greeting, a nudge) is all reply;
 * a preview cut before the reply is all request.
 */
function exchangeOf(text) {
    const turn = /^\[USER\]: ([\s\S]*?)(?:\n\n\[(?:AGENT|ASSISTANT)\]: ([\s\S]*))?$/.exec(text);
    if (turn) return { request: turn[1], agent: turn[2] ?? "" };
    const reply = /^\[(?:AGENT|ASSISTANT)\]: ([\s\S]*)$/.exec(text);
    return { request: "", agent: reply ? reply[1] : text };
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
 * Confirm a lower size limit: the oldest entries above it are removed now.
 */
function showLowerSizeLimitConfirmation(bytes) {
    showModal(
        "Lower the Size Limit",
        `<p>Lowering the limit to <strong>${formatBytes(bytes)}</strong> removes the oldest conversations above it.</p>
         <p style="color: var(--in-content-danger-button-background);">This action cannot be undone.</p>`,
        async () => {
            await changeMemorySizeLimit(bytes);
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

        // 2. Delete old entries from Memory FTS: those older than the cutoff,
        // listed by date a page at a time with the shortest preview (a reply
        // of whole entries can pass Thunderbird's 1 MiB native message cap),
        // each page removed as it comes. Each request starts at the last date
        // listed and skips the entries already listed at it.
        let ftsDeleted = 0;
        let ftsError = null;
        try {
            const { chatHistoryDeleteFetchRows, chatHistoryDeletePreviewChars } = SETTINGS.memoryManagement;
            let to = cutoffMs - 1;
            let listedAtCursor = new Set();
            while (true) {
                const limit = chatHistoryDeleteFetchRows + listedAtCursor.size;
                const page = await browser.runtime.sendMessage({
                    type: "fts",
                    cmd: "memorySearch",
                    q: "",
                    to,
                    limit,
                    ignoreDate: false,
                    previewChars: chatHistoryDeletePreviewChars
                });
                if (!Array.isArray(page)) {
                    throw new Error(page?.error || "invalid memory search reply");
                }
                const ids = page.filter(entry => !listedAtCursor.has(entry.memId)).map(entry => entry.memId);
                if (ids.length > 0) {
                    const result = await browser.runtime.sendMessage({
                        type: "fts",
                        cmd: "memoryRemoveBatch",
                        ids
                    });
                    if (result?.error) throw new Error(result.error);
                    ftsDeleted += result?.count ?? ids.length;
                }
                // Fewer than asked: none older are left.
                if (page.length < limit) break;
                const cursor = page[page.length - 1].dateMs;
                if (cursor !== to) listedAtCursor = new Set();
                for (const entry of page) {
                    if (entry.dateMs === cursor) listedAtCursor.add(entry.memId);
                }
                to = cursor;
            }
            log(`[Prompts] Deleted ${ftsDeleted} old entries from Memory FTS`);
        } catch (e) {
            log(`[Prompts] Failed to delete old FTS entries: ${e}`, "warn");
            ftsError = e;
        }

        // A stop says what was removed and why the rest was not (an older
        // helper refuses the listing until it is updated, ADR-NF-018).
        const deleted = `Deleted ${turnsDeleted} turns + ${ftsDeleted} search entries older than ${cutoffDate.toLocaleDateString()}`;
        showStatus(ftsError ? `${deleted}, then stopped: ${ftsError.message}` : deleted, ftsError !== null);

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

        // Clear thinking tokens from IDB
        try {
            await clearAllThinking();
        } catch (e) {
            log(`[Prompts] Failed to clear thinking from IDB: ${e}`, "warn");
        }

        // Clear Memory FTS database. The FTS engine answers a failed clear
        // with { error } rather than rejecting, so the reply is checked; either
        // failure ends in the failure status below, never the success one.
        const clearReply = await browser.runtime.sendMessage({
            type: "fts",
            cmd: "memoryClear"
        });
        if (clearReply?.error) throw new Error(`Memory FTS clear failed: ${clearReply.error}`);
        log("[Prompts] Memory FTS cleared");

        // Clear migration flags
        await browser.storage.local.remove([
            "memory_fts_migration_v1_done",
            "memory_fts_migrated_sessions",
            "chat_turns_migration_v1",
            "chat_turns_migration_v2",
            "chat_refs_migration_v1"
        ]);

        // Re-read everything, so the usage row shows what the helper now holds.
        await loadChatHistory();
        showStatus("Chat history cleared");
        log("[Prompts] Chat history cleared");
    } catch (e) {
        log(`[Prompts] Error clearing chat history: ${e}`, "error");
        showStatus("Failed to clear chat history", true);
    }
}

// Test-only exports for pure functions
export const _testExports = { formatSessionTime, escapeHtml, highlightSearchTerms, changeMemorySizeLimit };

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

    const sizeLimitSelect = document.getElementById("history-size-limit");
    if (sizeLimitSelect) {
        sizeLimitSelect.addEventListener("change", () => {
            const bytes = Number(sizeLimitSelect.value);
            const stored = memorySizeLimitBytes ?? SETTINGS.memoryManagement.memorySizeLimitDefaultBytes;
            // A lower limit can remove entries for good: always ask first, as
            // Clear All does, whatever the usage shown (it can be unknown, from
            // an older helper, or out of date). A misclick or arrow keys
            // stepping through the list then remove nothing.
            if (bytes < stored) {
                sizeLimitSelect.value = String(stored);
                showLowerSizeLimitConfirmation(bytes);
                return;
            }
            changeMemorySizeLimit(bytes);
        });
    }

    const deleteOldBtn = document.getElementById("delete-old-history");
    if (deleteOldBtn) {
        deleteOldBtn.addEventListener("click", showDeleteOldHistoryDialog);
    }
}
