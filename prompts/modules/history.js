/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Chat History tab functionality, as Voice's Settings > Memory shows memory:
 * the memory's size, then its newest entries, or the best matches of a search,
 * each a preview of what was asked and what the agent did, each removable.
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

let displayData = []; // the entries shown (a listing's or a search's)
let memoryFtsStats = null;
let memorySizeLimitBytes = null;
let turnsCount = 0;
let currentPage = 1;
let totalPages = 1;
let currentSearchQuery = "";
let isSearchMode = false;
// What the list shows is set by `showAnswer` alone, from the listing or search
// that finished last. Said in the list's place when a listing failed.
let listError = null;
// Whether the answer shown had no entries: only then does the list say none is
// kept or found. Removing every entry shown does not make it so; the list then
// says what was done.
let answeredNone = false;
// The query of the latest listing or search asked for ("" for a listing).
let requestedQuery = "";
// Entries whose removal is waiting or running, by memId: their button says so.
const removing = new Set();

// Listings, searches and removals run one at a time, in the order they were
// asked: each starts once the one before it has finished, however it finished,
// so a later one always reads memory after an earlier one's change, and the
// list ends on the last one asked. None puts another in line. Each one before
// it ends within the search helper's own request deadline once the helper is
// running; the wait for a helper that is still starting is #244.
let line = Promise.resolve();
function inLine(what, job) {
    line = line.then(job).catch(e => {
        log(`[Prompts] Chat History ${what} failed: ${e}`, "error");
        showStatus(`Chat History ${what} failed: ${e?.message || e}`, true);
    });
    return line;
}

/**
 * Memory's newest entries (no query), or the best matches of `q`: as many as
 * the chat's memory_search fetches (100 everywhere, #150), each the start the
 * page shows. The helper answers the start of each entry (previewChars):
 * Thunderbird refuses a native message over 1 MiB, and entries are stored
 * whole. Answers `{ entries }`, or `{ error }` for any reply that is not a
 * list; a rejected request rejects.
 */
async function fetchMemoryEntries(q) {
    const reply = await browser.runtime.sendMessage({
        type: "fts",
        cmd: "memorySearch",
        q,
        limit: CHAT_SETTINGS.memorySearchMaxResults,
        ignoreDate: true,
        // One more than shown, so an entry that goes on is told from one that ends there.
        previewChars: SETTINGS.memoryManagement.chatHistorySearchPreviewChars + 1
    });
    // Anything but a list failed, as an error does: no reply comes while the
    // background starts or reloads. It never shows as none kept or no matches.
    return Array.isArray(reply) ? { entries: reply } : { error: reply?.error || "no reply from the search helper" };
}

/**
 * Load chat history: the stats, then memory's newest entries.
 */
export function loadChatHistory() {
    log("[Prompts] Loading chat history...");
    requestedQuery = "";
    // Emptied when the listing is asked for, not when it answers, so words
    // typed while it waits in line stay.
    const searchInput = document.getElementById("history-search-input");
    if (searchInput) searchInput.value = "";
    return inLine("listing", listMemory);
}

// The listing's reads, all in its own turn. A failed stats read shows memory's
// size as unavailable and a failed turns read shows 0 (#241); a failed read of
// the size limit or of the entries is the listing's answer, said in the list.
async function listMemory() {
    try {
        memoryFtsStats = await browser.runtime.sendMessage({ type: "fts", cmd: "memoryStats" });
    } catch (e) {
        log(`[Prompts] Failed to get Memory FTS stats: ${e}`, "warn");
        memoryFtsStats = null;
    }
    try {
        const result = await browser.storage.local.get(CHAT_TURNS_KEY);
        turnsCount = (result[CHAT_TURNS_KEY] || []).length;
    } catch (e) {
        turnsCount = 0;
    }
    let answer;
    try {
        memorySizeLimitBytes = await getMemorySizeLimitBytes();
        answer = await fetchMemoryEntries("");
    } catch (e) {
        answer = { error: String(e?.message || e) };
    }
    showAnswer({ query: "", ...answer });
}

/**
 * Search chat history using Memory FTS: the best matches, each a preview.
 */
export function searchChatHistory(query) {
    if (!query || query.trim().length === 0) return loadChatHistory();
    const q = query.trim();
    requestedQuery = q;
    return inLine("search", async () => {
        log(`[Prompts] Searching chat history for: "${q}"`);
        let answer;
        try {
            answer = await fetchMemoryEntries(q);
        } catch (e) {
            answer = { error: String(e) };
        }
        showAnswer({ query: q, ...answer });
    });
}

/**
 * Set the list from what a listing (query "") or a search finished with. The
 * only place the list's contents and what it says are set; a removal only
 * takes its entry out.
 */
function showAnswer({ query, entries, error }) {
    if (query && error) {
        // A failed search leaves what is shown. The tab opens on a listing,
        // and a search waits in line behind it, so something is always shown.
        log(`[Prompts] Search failed: ${error}`, "error");
        showStatus("Search failed: " + error, true);
        return;
    }
    if (error) log(`[Prompts] Listing chat history failed: ${error}`, "warn");
    currentSearchQuery = query;
    isSearchMode = query !== "";
    currentPage = 1;
    displayData = error ? [] : entries;
    listError = error ? `Couldn't list past conversations: ${error}` : null;
    answeredNone = !error && entries.length === 0;
    if (isSearchMode) log(`[Prompts] Search returned ${displayData.length} results`);
    renderChatHistory();
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
        if (listError) {
            emptyMessage.textContent = listError;
        } else if (answeredNone) {
            emptyMessage.textContent = isSearchMode
                ? `No results found for "${currentSearchQuery}".`
                : "No conversations kept yet.";
        } else {
            emptyMessage.textContent = "Removed every conversation shown.";
        }
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
// Why a memory write (a removal, Clear All, a trim) was not done, or null
// when the helper confirmed it with ok: true. Anything else failed, as an
// error does: no reply comes while the background starts or reloads.
function memoryWriteFailure(reply) {
    return reply?.ok === true ? null : (reply?.error || "the search helper did not confirm it");
}

async function changeMemorySizeLimit(bytes) {
    let saved = false;
    try {
        await setMemorySizeLimitBytes(bytes);
        saved = true;
        log(`[Prompts] Memory size limit set to ${bytes} bytes`);
        const result = await browser.runtime.sendMessage({ type: "fts", cmd: "memoryTrim" });
        const failed = memoryWriteFailure(result);
        if (result?.unsupported) {
            showStatus(`Size limit set to ${formatBytes(bytes)}. It applies once the search helper updates.`);
        } else if (failed) {
            log(`[Prompts] Applying the memory size limit failed: ${failed}`, "warn");
            showStatus("Size limit saved, but applying it failed: " + failed, true);
        } else {
            const removed = result.trimmed || 0;
            let status = `Size limit set to ${formatBytes(bytes)}.`;
            if (removed > 0) status += removed === 1 ? " Removed the oldest entry." : ` Removed the ${removed} oldest entries.`;
            if (result.withinLimit === false) status += " More are removed as new conversations are kept.";
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
 * Render entries: each one's preview as what was asked, then what the agent
 * did, with a button that removes it.
 */
function renderFtsEntries(container, entries) {
    const headerDiv = document.createElement("div");
    headerDiv.className = "history-section-header";
    headerDiv.textContent = isSearchMode ? `Search Results (${displayData.length} total)` : "Newest Conversations";
    container.appendChild(headerDiv);

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
        const dateLabel = document.createElement("span");
        dateLabel.textContent = `Conversation from ${dateStr}`;
        dateHeader.appendChild(dateLabel);
        // Removes this entry from memory, as Voice's Remove does, saying so
        // while the removal is pending.
        const removeBtn = document.createElement("button");
        removeBtn.className = "history-remove-btn";
        const pending = removing.has(entry.memId);
        removeBtn.textContent = pending ? "Removing…" : "Remove";
        removeBtn.disabled = pending;
        removeBtn.setAttribute("aria-label", `Remove the conversation from ${dateStr}`);
        removeBtn.addEventListener("click", () => removeEntry(entry.memId));
        dateHeader.appendChild(removeBtn);
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
 * Remove one entry from memory (#154), in line after whatever was asked before
 * it. The helper confirms a removal with { ok: true }; anything else is a
 * failure, said in the status line, and the entry stays. A confirmed removal
 * leaves the entries shown at once, whatever page they are on; the stats are
 * then read again.
 */
function removeEntry(memId) {
    if (removing.has(memId)) return;
    removing.add(memId);
    // In line before the render that shows it pending, so its turn always
    // comes and ends it, whatever that render does.
    const turn = inLine("removal", async () => {
        try {
            await removeAndReadStats(memId);
        } finally {
            // Pending until its turn ends, so a press before then sends nothing.
            removing.delete(memId);
        }
        renderChatHistory();
    });
    renderChatHistory();
    return turn;
}

async function removeAndReadStats(memId) {
    let failure = null;
    try {
        const result = await browser.runtime.sendMessage({ type: "fts", cmd: "memoryRemoveBatch", ids: [memId] });
        const failed = memoryWriteFailure(result);
        if (failed) throw new Error(failed);
        displayData = displayData.filter(entry => entry.memId !== memId);
        log(`[Prompts] Removed chat history entry ${memId}`);
    } catch (e) {
        log(`[Prompts] Removing a chat history entry failed: ${e}`, "error");
        failure = "Couldn't remove the conversation: " + (e?.message || e);
        showStatus(failure, true);
    }
    renderChatHistory();

    try {
        memoryFtsStats = await browser.runtime.sendMessage({ type: "fts", cmd: "memoryStats" });
        if (!memoryFtsStats || memoryFtsStats.error) throw new Error(memoryFtsStats?.error || "no reply from the search helper");
    } catch (e) {
        log(`[Prompts] Failed to get Memory FTS stats: ${e}`, "warn");
        // Shown as unavailable, as when the tab loads.
        memoryFtsStats = null;
        showStatus([failure, "Couldn't read memory's size: " + (e?.message || e)].filter(Boolean).join(" "), true);
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
 * `text` as HTML, each search word of `query` marked: the words of at least
 * two UTF-16 units (one emoji is a word), wherever they occur and whatever their case, the longer
 * word where two start at one place (as Voice's Settings > Memory marks them).
 * The words are found in the text itself in one pass, and each part is escaped
 * on its own, so a word never matches inside a mark or an escaped character.
 */
function highlightSearchTerms(text, query) {
    if (!text || !query) return escapeHtml(text);

    const terms = query.split(/\s+/).filter(t => t.length >= 2).sort((a, b) => b.length - a.length);
    if (terms.length === 0) return escapeHtml(text);

    const pattern = new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join("|"), "gi");
    let result = "";
    let at = 0;
    for (const found of text.matchAll(pattern)) {
        result += escapeHtml(text.slice(at, found.index));
        result += `<span class="search-highlight">${escapeHtml(found[0])}</span>`;
        at = found.index + found[0].length;
    }
    return result + escapeHtml(text.slice(at));
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
                    const failed = memoryWriteFailure(result);
                    if (failed) throw new Error(failed);
                    ftsDeleted += result.count ?? ids.length;
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
        // with { error } rather than rejecting, so the reply is checked; any
        // failure ends in the failure status below, never the success one,
        // and leaves the migration flags, so the next startup's migration
        // does not clear what is written after this.
        const clearReply = await browser.runtime.sendMessage({
            type: "fts",
            cmd: "memoryClear"
        });
        const failed = memoryWriteFailure(clearReply);
        if (failed) throw new Error(`Memory FTS clear failed: ${failed}`);
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
        // Clearing the box goes back to the newest entries, without Enter.
        searchInput.addEventListener("input", () => {
            if (searchInput.value.trim() === "" && requestedQuery !== "") {
                loadChatHistory();
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
