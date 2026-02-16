// Main context menu integration for TabMail Agent.
// Provides per-message cache clearing operations via right-click on message list.

import { autoUpdateUserPromptOnTag } from "./autoUpdateUserPrompt.js";
import * as idb from "./idbStorage.js";
import { debugDumpSelectedMessages } from "./messageDebugDump.js";
import { isInternalSender } from "./senderFilter.js";
import { clearTabMailActionTags } from "./tagCleanup.js";
import { applyPriorityTag } from "./tagHelper.js";
import { notifyCannotTagSelf } from "./userNotice.js";
import { getUniqueMessageKey, log } from "./utils.js";

// Keep references to listeners so we can clean them up on suspend/hot-reload
let _onClickedListener = null;
let _onShownListener = null;

/**
 * Initialise right-click context menus under a dedicated "TabMail Agent" submenu.
 * This should be called once during addon startup.
 */
export async function initContextMenus() {
    // Avoid duplicate registration when the background script is reloaded.
    if (initContextMenus._registered) {
        try { log("[TMDBG ContextMenus] initContextMenus called but already registered; skipping."); } catch(_) {}
        return;
    }
    initContextMenus._registered = true;

    try {
        log("[TMDBG ContextMenus] Removing all existing menus before re-registering.");
        await browser.menus.removeAll();
    } catch (e) {
        log(`[TMDBG ContextMenus] removeAll failed: ${e}`, "warn");
    }

    // Only show debug-only menu items when debugMode is enabled.
    // NOTE: Do not rely on SETTINGS.debugMode here because init timing can race module init.
    let debugMode = false;
    try {
        const stored = await browser.storage.local.get({ debugMode: false });
        debugMode = stored.debugMode === true;
    } catch (e) {
        debugMode = false;
    }

    // Manual tagging actions
    browser.menus.create({
        id: "tabmail-agent-tag-reply",
        title: "Tag as Reply",
        contexts: ["message_list"],
    });

    browser.menus.create({
        id: "tabmail-agent-remove-tag",
        title: "Tag as None",
        contexts: ["message_list"],
    });   
    
    browser.menus.create({
        id: "tabmail-agent-tag-archive",
        title: "Tag as Archive",
        contexts: ["message_list"],
    });

    browser.menus.create({
        id: "tabmail-agent-tag-delete",
        title: "Tag as Delete",
        contexts: ["message_list"],
    });

    // Debug dump for selected message(s) (debug builds only).
    if (debugMode) {
        // Recompute summary for selected message(s).
        browser.menus.create({
            id: "tabmail-agent-recompute-summary",
            title: "Recompute Summary",
            contexts: ["message_list"],
        });

        // Recompute action for selected message(s).
        browser.menus.create({
            id: "tabmail-agent-recompute-action",
            title: "Recompute Action",
            contexts: ["message_list"],
        });

        // Recompute reply for selected message(s).
        browser.menus.create({
            id: "tabmail-agent-recompute-reply",
            title: "Recompute Reply",
            contexts: ["message_list"],
        });

        browser.menus.create({
            id: "tabmail-agent-debug-dump",
            title: "Debug Dump (console)",
            contexts: ["message_list"],
        });
        browser.menus.create({
            id: "tabmail-agent-run-stale-sweep",
            title: "Run Stale Tag Sweep (debug)",
            contexts: ["message_list"],
        });
    }

    // Click handler for menu items.
    _onClickedListener = async (info, tab) => {
        try {
            log(`[TMDBG ContextMenus] onClicked id=${info.menuItemId} tabId=${tab?.id ?? "<none>"}`);
        } catch(_) {}
        if (!info.menuItemId.startsWith("tabmail-agent-")) {
            return; // Not one of ours.
        }

        // Attempt to obtain the MessageHeader objects of the current selection.
        let messageHeaders = [];
        if (info.selectedMessages && info.selectedMessages.messages) {
            messageHeaders = info.selectedMessages.messages;
            try { log(`[TMDBG ContextMenus] selectedMessages(messages) path count=${messageHeaders.length}`); } catch(_) {}
        } else if (tab && tab.id !== undefined) {
            try {
                const list = await browser.mailTabs.getSelectedMessages(tab.id);
                if (list && Array.isArray(list.messages)) {
                    messageHeaders = list.messages;
                }
                try { log(`[TMDBG ContextMenus] getSelectedMessages(tab.id) path count=${messageHeaders.length}`); } catch(_) {}
            } catch (e) {
                try { log(`[TMDBG ContextMenus] getSelectedMessages failed: ${e}`, "warn"); } catch(_) {}
            }
        }

        // Some debug actions don't require message selection.
        if (info.menuItemId === "tabmail-agent-run-stale-sweep") {
            try {
                log(`[TMDBG ContextMenus] Running stale tag sweep (manual trigger, unlimited)`);
                const { runStaleTagSweep } = await import("./onMoved.js");
                // Manual debug runs use unlimited mode to clear all stale tags.
                await runStaleTagSweep({ unlimited: true });
                log(`[TMDBG ContextMenus] Stale tag sweep completed`);
            } catch (e) {
                log(`[TMDBG ContextMenus] Stale tag sweep failed: ${e}`, "warn");
            }
            return;
        }

        if (messageHeaders.length === 0) {
            // log("[TMDBG ContextMenus] No messages found for context-menu operation.");
            try { log(`[TMDBG ContextMenus] No messageHeaders resolved; aborting click for ${info.menuItemId}`); } catch(_) {}
            return;
        }

        if (info.menuItemId === "tabmail-agent-recompute-summary") {
            await recomputeSummary(messageHeaders);
        } else if (info.menuItemId === "tabmail-agent-recompute-action") {
            await recomputeAction(messageHeaders);
        } else if (info.menuItemId === "tabmail-agent-recompute-reply") {
            await recomputeReply(messageHeaders);
        } else if (info.menuItemId === "tabmail-agent-tag-archive") {
            try { log(`[TMDBG ContextMenus] Applying manual tag action=archive to ${messageHeaders.length} messages`); } catch(_) {}
            await applyManualTags(messageHeaders, "archive");
            // try { await performTaggedActions(messageHeaders); } catch (e) {}
        } else if (info.menuItemId === "tabmail-agent-tag-delete") {
            try { log(`[TMDBG ContextMenus] Applying manual tag action=delete to ${messageHeaders.length} messages`); } catch(_) {}
            await applyManualTags(messageHeaders, "delete");
            // try { await performTaggedActions(messageHeaders); } catch (e) {}
        } else if (info.menuItemId === "tabmail-agent-tag-reply") {
            try { log(`[TMDBG ContextMenus] Applying manual tag action=reply to ${messageHeaders.length} messages`); } catch(_) {}
            await applyManualTags(messageHeaders, "reply");
        } else if (info.menuItemId === "tabmail-agent-remove-tag") {
            try { log(`[TMDBG ContextMenus] Removing action tags from ${messageHeaders.length} messages`); } catch(_) {}
            await removeActionTags(messageHeaders);
        } else if (info.menuItemId === "tabmail-agent-debug-dump") {
            try { log(`[TMDBG ContextMenus] Debug dump requested count=${messageHeaders.length}`); } catch(_) {}
            await debugDumpSelectedMessages(messageHeaders, { source: "context-menu" });
        }
    };
    browser.menus.onClicked.addListener(_onClickedListener);

    // Shown handler for diagnostics – helps detect visibility/context issues
    _onShownListener = (info, tab) => {
        try {
            const ctxs = Array.isArray(info.contexts) ? info.contexts.join(",") : String(info.contexts);
            const count = info?.selectedMessages?.messages ? info.selectedMessages.messages.length : 0;
            const numMenuIds = Array.isArray(info.menuIds) ? info.menuIds.length : (info.menuIds ? 1 : 0);
            const hasMessageList = info.contexts?.includes?.("message_list") ?? false;
            const tabInfo = tab ? `tabId=${tab.id} type=${tab.type ?? "?"} mailTab=${tab.mailTab ?? "?"}` : "tab=<none>";
            
            // Log which of our menu items are in the menuIds array
            const ourMenuIds = Array.isArray(info.menuIds) 
                ? info.menuIds.filter(id => String(id).startsWith("tabmail-agent-"))
                : [];
            
            log(`[TMDBG ContextMenus] onShown contexts=[${ctxs}] hasMessageList=${hasMessageList} ${tabInfo} selCount=${count} totalItems=${numMenuIds} ourItems=${ourMenuIds.length} ids=${ourMenuIds.join(",")}`);
            
            // Log warning if message_list context is present but our items aren't showing
            if (hasMessageList && ourMenuIds.length === 0) {
                log(`[TMDBG ContextMenus] WARNING: message_list context present but NONE of our menu items are showing! Full menuIds: ${JSON.stringify(info.menuIds)}`, "warn");
            }
        } catch(e) {
            log(`[TMDBG ContextMenus] onShown handler error: ${e}`, "error");
        }
    };
    try { browser.menus.onShown?.addListener?.(_onShownListener); } catch(_) {}

    try {
        if (browser.menus.refresh) {
            await browser.menus.refresh();
        }
    } catch (e) {
        log(`[TMDBG ContextMenus] menus.refresh failed: ${e}`, "warn");
    }
    log("[TMDBG ContextMenus] Menus registered.");
}

async function clearSummaryCache(messages) {
    const keys = [];
    for (const msg of messages) {
        if (!msg || msg.id === undefined) continue;
        try {
            const uKey = await getUniqueMessageKey(msg.id);
            if (uKey) keys.push(`summary:${uKey}`);
        } catch (e) {}
    }
    if (!keys.length) return;
    const pre = await idb.get(keys);
    await idb.remove(keys);
    const post = await idb.get(keys);
}

async function clearActionCache(messages) {
    try { log(`[TMDBG ContextMenus] clearActionCache start count=${messages?.length ?? 0}`); } catch(_) {}
    const keys = [];
    for (const msg of messages) {
        if (!msg || msg.id === undefined) continue;
        try {
            // Use numeric message id path so key generation matches actionGenerator usage exactly.
            const uKey = await getUniqueMessageKey(msg.id);
            if (!uKey) {
                try {
                    log(
                        `[TMDBG ContextMenus] clearActionCache: failed to compute uniqueKey id=${msg?.id} headerMessageId=${msg?.headerMessageId || ""} folderPath=${msg?.folder?.path || ""}`,
                        "warn"
                    );
                } catch (_) {}
                continue;
            }

            // Remove both payload and meta entries for this unique key.
            keys.push(`action:${uKey}`);
            keys.push(`action:ts:${uKey}`);
            keys.push(`action:orig:${uKey}`);
            keys.push(`action:userprompt:${uKey}`);
            keys.push(`action:justification:${uKey}`);
        } catch (e) {
            try { log(`[TMDBG ContextMenus] clearActionCache: exception id=${msg?.id}: ${e}`, "warn"); } catch (_) {}
        }
    }
    if (!keys.length) return;
    try { log(`[TMDBG ContextMenus] clearActionCache resolvedKeys=${keys.length}`); } catch(_) {}
    const pre = await idb.get(keys);
    const preHits = Object.keys(pre || {}).length;
    try { log(`[TMDBG ContextMenus] clearActionCache preHits=${preHits}`); } catch(_) {}
    await idb.remove(keys);
    const post = await idb.get(keys);
    const postHits = Object.keys(post || {}).length;
    try { log(`[TMDBG ContextMenus] clearActionCache done removed=${preHits} remaining=${postHits}`); } catch(_) {}
}

async function clearReplyEntries(messages) {
    const keys = [];
    for (const msg of messages) {
        if (!msg || msg.id === undefined) continue;
        try {
            const k = await getUniqueMessageKey(msg.id);
            if (k) {
                keys.push(`reply:${k}`);
            }
        } catch (e) {
            // log(`[TMDBG ContextMenus] Error computing reply key for message ${msg.id}: ${e}`);
        }
    }
    if (keys.length) {
        await idb.remove(keys);
    }
    // log(`[TMDBG ContextMenus] Cleared ${keys.length} reply key(s) for ${messages.length} message(s).`);
}

async function recomputeSummary(messages) {
    try { log(`[TMDBG ContextMenus] recomputeSummary start count=${messages?.length ?? 0}`); } catch(_) {}
    // Clear cache first
    await clearSummaryCache(messages);
    // Then recompute
    const { getSummary } = await import("./summaryGenerator.js");
    for (const msg of messages) {
        if (!msg || msg.id === undefined) continue;
        try {
            try { log(`[TMDBG ContextMenus] recomputeSummary: recomputing for message ${msg.id}`); } catch(_) {}
            await getSummary(msg, true); // highPriority = true for user-driven recomputation
        } catch (e) {
            try { log(`[TMDBG ContextMenus] recomputeSummary: exception id=${msg?.id}: ${e}`, "warn"); } catch (_) {}
        }
    }
    try { log(`[TMDBG ContextMenus] recomputeSummary done count=${messages?.length ?? 0}`); } catch(_) {}
}

async function recomputeAction(messages) {
    try { log(`[TMDBG ContextMenus] recomputeAction start count=${messages?.length ?? 0}`); } catch(_) {}
    // Clear IDB cache first
    await clearActionCache(messages);
    // Then recompute - forceRecompute bypasses the "first compute wins" IMAP tag check
    // in getAction() so we get a fresh LLM computation even if the tag still exists.
    const { enqueueProcessMessage } = await import("./messageProcessorQueue.js");
    for (const msg of messages) {
        if (!msg || msg.id === undefined) continue;
        try {
            try { log(`[TMDBG ContextMenus] recomputeAction: recomputing for message ${msg.id}`); } catch(_) {}
            // Use persistent queue so offline/disruptions are retried.
            await enqueueProcessMessage(msg, { isPriority: true, forceRecompute: true, source: "contextMenu:recomputeAction" });
        } catch (e) {
            try { log(`[TMDBG ContextMenus] recomputeAction: exception id=${msg?.id}: ${e}`, "warn"); } catch (_) {}
        }
    }
    try { log(`[TMDBG ContextMenus] recomputeAction done count=${messages?.length ?? 0}`); } catch(_) {}
}

async function recomputeReply(messages) {
    try { log(`[TMDBG ContextMenus] recomputeReply start count=${messages?.length ?? 0}`); } catch(_) {}
    // Clear cache first
    await clearReplyEntries(messages);
    // Then recompute
    const { createReply } = await import("./replyGenerator.js");
    for (const msg of messages) {
        if (!msg || msg.id === undefined) continue;
        try {
            try { log(`[TMDBG ContextMenus] recomputeReply: recomputing for message ${msg.id}`); } catch(_) {}
            await createReply(msg.id, true); // highPriority = true for user-driven recomputation
        } catch (e) {
            try { log(`[TMDBG ContextMenus] recomputeReply: exception id=${msg?.id}: ${e}`, "warn"); } catch (_) {}
        }
    }
    try { log(`[TMDBG ContextMenus] recomputeReply done count=${messages?.length ?? 0}`); } catch(_) {}
}

/**
 * Apply manual action tags to selected messages
 * @param {Array} messageHeaders - Array of message headers
 * @param {string} action - The action to apply ("archive", "delete", "reply")
 */
async function applyManualTags(messageHeaders, action) {
    try {
        try { log(`[TMDBG ContextMenus] applyManualTags start action=${action} count=${messageHeaders.length}`); } catch(_) {}

        let blockedCount = 0;
        for (const header of messageHeaders) {
            try {
                const internal = await isInternalSender(header);
                if (internal) {
                    blockedCount++;
                    try { log(`[TMDBG ContextMenus] Blocking manual tag on self-sent message id=${header.id} action=${action}`); } catch (_) {}
                    // Cleanup any legacy TabMail tags that might still exist from older code.
                    await clearTabMailActionTags(header.id, "manual-tag-blocked-self", header);
                    continue;
                }
            } catch (_) {}

            // Manual context menu is the only place where we change tags by policy
            await applyPriorityTag(header.id, action);
            // Fire-and-forget the prompt update; do not await
            try { autoUpdateUserPromptOnTag(header.id, action, { source: "context-menu" }); } catch (_) {}
        }

        if (blockedCount > 0) {
            try {
                log(`[TMDBG ContextMenus] Showing cannot-tag-self notice blockedCount=${blockedCount} action=${action}`);
                await notifyCannotTagSelf({ count: blockedCount });
            } catch (eNotice) {
                try { log(`[TMDBG ContextMenus] notifyCannotTagSelf failed: ${eNotice}`, "warn"); } catch (_) {}
            }
        }
        
        try { log(`[TMDBG ContextMenus] applyManualTags done action=${action} count=${messageHeaders.length}`); } catch(_) {}
    } catch (e) {
        // log(`[TMDBG ContextMenus] Error applying manual tags: ${e}`);
    }
}

/**
 * Remove action tags from selected messages
 * @param {Array} messageHeaders - Array of message headers
 */
async function removeActionTags(messageHeaders) {
    try {
        try { log(`[TMDBG ContextMenus] removeActionTags start count=${messageHeaders.length}`); } catch(_) {}

        let blockedCount = 0;
        for (const header of messageHeaders) {
            try {
                try {
                    const internal = await isInternalSender(header);
                    if (internal) {
                        blockedCount++;
                        try { log(`[TMDBG ContextMenus] Blocking manual untag on self-sent message id=${header.id}`); } catch (_) {}
                        // For self-sent messages, do NOT apply tm_none; instead clear any TabMail tags.
                        await clearTabMailActionTags(header.id, "manual-untag-blocked-self", header);
                        continue;
                    }
                } catch (_) {}

                // Manual context menu is the only place where we change tags by policy
                await applyPriorityTag(header.id, "none");
                // Fire-and-forget the prompt update; do not await
                try { autoUpdateUserPromptOnTag(header.id, "none", { source: "context-menu" }); } catch (_) {}
                // log(`[TMDBG ContextMenus] Removed action tags from message ${header.id}`);
            } catch (e) {
                // log(`[TMDBG ContextMenus] Error removing tags from message ${header.id}: ${e}`);
            }
        }

        if (blockedCount > 0) {
            try {
                log(`[TMDBG ContextMenus] Showing cannot-tag-self notice blockedCount=${blockedCount} action=none`);
                await notifyCannotTagSelf({ count: blockedCount });
            } catch (eNotice) {
                try { log(`[TMDBG ContextMenus] notifyCannotTagSelf failed: ${eNotice}`, "warn"); } catch (_) {}
            }
        }
        
        try { log(`[TMDBG ContextMenus] removeActionTags done count=${messageHeaders.length}`); } catch(_) {}
    } catch (e) {
        // log(`[TMDBG ContextMenus] Error removing action tags: ${e}`);
    }
} 

/**
 * Cleanup context menu listeners for hot-reload/suspend scenarios.
 */
export function cleanupContextMenus() {
    try {
        if (_onClickedListener) {
            browser.menus.onClicked.removeListener(_onClickedListener);
            _onClickedListener = null;
        }
    } catch (e) {
        try { log(`[TMDBG ContextMenus] Failed to remove onClicked listener: ${e}`, "warn"); } catch(_) {}
    }
    try {
        if (_onShownListener && browser.menus.onShown?.removeListener) {
            browser.menus.onShown.removeListener(_onShownListener);
            _onShownListener = null;
        }
    } catch (e) {
        try { log(`[TMDBG ContextMenus] Failed to remove onShown listener: ${e}`, "warn"); } catch(_) {}
    }
    
    // Reset the registration flag so menus can be recreated on next init
    initContextMenus._registered = false;
    try { log("[TMDBG ContextMenus] Cleanup complete, registration flag reset."); } catch(_) {}
}