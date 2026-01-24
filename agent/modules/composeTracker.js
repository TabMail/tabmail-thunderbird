import * as idb from "./idbStorage.js";
import { createReply, STORAGE_PREFIX } from "./replyGenerator.js";
import { ACTION_TAG_IDS, applyPriorityTag } from "./tagHelper.js";
import { formatForLog, getSentFoldersForAccount, getUniqueMessageKey, log } from "./utils.js";

// Internal sets for compose state tracking.
const composeWindowIds = new Set();
const _sentTabIds = new Set();
const sendCtxByTabId = new Map(); // in-memory cache of { accountId, ts } per compose tab

// Store listener references for cleanup - declared early to avoid TDZ issues
let _replyTagListenerRegistered = false;
let _afterSendListenerRegistered = false;
let _onRemovedListener = null;
let _onBeforeSendListener = null;
let _onAfterSendListener = null;
let _onCreatedListener = null;

/**
 * Register a compose window so background jobs know one is active.
 * Call this once when the compose tab is created.
 */
export function trackComposeWindow(tabId) {
    composeWindowIds.add(tabId);
    log(`[ComposeTracker] trackComposeWindow(${tabId}): now tracking ${composeWindowIds.size} windows`);
}

/**
 * Returns true if at least one compose window is currently open.
 */
export function isAnyComposeOpen() {
    const isOpen = composeWindowIds.size > 0;
    log(`[ComposeTracker] isAnyComposeOpen(): ${isOpen} (${composeWindowIds.size} windows tracked)`);
    if (isOpen) {
        log(`[ComposeTracker] Tracked compose window IDs: [${Array.from(composeWindowIds).join(', ')}]`);
    }
    return isOpen;
}

/**
 * Track a send initiated for a compose tab.
 */ 
export function trackSendInitiated(tabId) {
    try {
        _sentTabIds.add(tabId);
    } catch (e) {
        console.warn("[ComposeTracker] trackSendInitiated failed:", e);
    }
}

/**
 * Consume and clear the in-memory send flag for a compose tab.
 * Returns true if a send had been recorded and was cleared.
 */
export function consumeSendInitiated(tabId) {
	try {
		const had = _sentTabIds.has(tabId);
		if (had) {
			_sentTabIds.delete(tabId);
			if (log) { log(`[ComposeTracker] consumeSendInitiated: cleared send flag for tab ${tabId}. remaining=${_sentTabIds.size}`); }
		} else {
			if (log) { log(`[ComposeTracker] consumeSendInitiated: no send flag for tab ${tabId}`); }
		}
		return had;
	} catch (e) {
		console.warn("[ComposeTracker] consumeSendInitiated failed:", e);
		return false;
	}
}

// Auto-untrack compose windows when the tab is closed.
if (!_onRemovedListener) {
    _onRemovedListener = async (tabId) => {
        log(`[ComposeTracker] tabs.onRemoved event for tab ${tabId}`);
        if (composeWindowIds.has(tabId)) {
            composeWindowIds.delete(tabId);
            log(`[ComposeTracker] Removed compose window ${tabId}. Remaining compose windows: ${composeWindowIds.size}`);
            
            // Clear any cached reply associated with this compose tab to avoid mis-association
            try {
                const key = "activePrecompose:" + tabId;
                await idb.remove(key);
                log(`[ComposeTracker] Cleared cached reply key ${key} on compose window close.`);
            } catch (e) {
                console.warn(`[ComposeTracker] Failed to clear activeReply for tab ${tabId}:`, e);
            }

            // Clear any cached send context
            try { 
                sendCtxByTabId.delete(tabId); 
                log(`[ComposeTracker] Cleared send context for tab ${tabId}`);
            } catch (_) {}
        } else {
            log(`[ComposeTracker] Tab ${tabId} was not tracked as compose window`);
        }
    };
    browser.tabs.onRemoved.addListener(_onRemovedListener);
}

// -----------------------------------------------------------------------------
// Tag maintenance – clear the "reply" action tag once a response is sent
// -----------------------------------------------------------------------------

export function cleanupComposeTrackerListeners() {
  if (_onRemovedListener) {
    try {
      browser.tabs.onRemoved.removeListener(_onRemovedListener);
      _onRemovedListener = null;
      console.log("[ComposeTracker] tabs.onRemoved listener cleaned up");
    } catch (e) {
      console.warn("[ComposeTracker] Failed to remove tabs.onRemoved listener:", e);
    }
  }
  if (_onBeforeSendListener && browser.compose?.onBeforeSend) {
    try {
      browser.compose.onBeforeSend.removeListener(_onBeforeSendListener);
      _onBeforeSendListener = null;
      _replyTagListenerRegistered = false;
      console.log("[ComposeTracker] compose.onBeforeSend listener cleaned up");
    } catch (e) {
      console.warn("[ComposeTracker] Failed to remove compose.onBeforeSend listener:", e);
    }
  }
  if (_onAfterSendListener && browser.compose?.onAfterSend) {
    try {
      browser.compose.onAfterSend.removeListener(_onAfterSendListener);
      _onAfterSendListener = null;
      _afterSendListenerRegistered = false;
      console.log("[ComposeTracker] compose.onAfterSend listener cleaned up");
    } catch (e) {
      console.warn("[ComposeTracker] Failed to remove compose.onAfterSend listener:", e);
    }
  }
  if (_onCreatedListener) {
    try {
      browser.tabs.onCreated.removeListener(_onCreatedListener);
      _onCreatedListener = null;
      console.log("[ComposeTracker] tabs.onCreated listener cleaned up");
    } catch (e) {
      console.warn("[ComposeTracker] Failed to remove tabs.onCreated listener:", e);
    }
  }
}

try {
    if (browser.compose && browser.compose.onBeforeSend && typeof browser.compose.onBeforeSend.addListener === "function") {
        if (!_replyTagListenerRegistered) {
            _replyTagListenerRegistered = true;
            _onBeforeSendListener = async (tab) => {
                try {
                    // Track the send initiated for the compose tab to be consumed by emailCompose.js
                    try { trackSendInitiated(tab.id); } catch (_) {}

                    // Retrieve compose details to identify the original message.
                    const details = await browser.compose.getComposeDetails(tab.id);
                    // Cache accountId in-memory for use in onAfterSend (tab may close before after-send fires)
                    try {
                        if (details && details.identityId) {
                            const ident = await browser.identities.get(details.identityId);
                            const accountId = ident?.accountId || null;
                            if (accountId) {
                                sendCtxByTabId.set(tab.id, { accountId, ts: Date.now() });
                                if (log) { log(`[ComposeTracker] Cached sendCtx (mem) for tab ${tab.id} account=${accountId}`); }
                            }
                        }
                    } catch (e) {
                        console.warn("[ComposeTracker] Failed to cache accountId in-memory for onAfterSend:", e);
                    }
                    if (details && details.type === "reply" && details.relatedMessageId) {
                        // Check if the related message is tagged as "reply" and only clear the tag if it is.
                        try {
                            const header = await browser.messages.get(details.relatedMessageId);
                            const currentTags = Array.isArray(header?.tags) ? header.tags : [];
                            if (log) { log(`[TMDBG ComposeTracker] onBeforeSend pre-check relatedMessageId=${details.relatedMessageId} tags=[${currentTags.join(",")}]`); }
                            const hasReplyTag = currentTags.includes(ACTION_TAG_IDS.reply);
                            if (hasReplyTag) {
                                // Only for replies (not forwards): clear the reply tag by switching to "none" when the reply is sent.
                                await applyPriorityTag(details.relatedMessageId, "none");
                                if (log) { log(`[TMDBG ComposeTracker] Cleared reply tag for message ${details.relatedMessageId} on reply send.`); }
                            } else {
                                if (log) { log(`[TMDBG ComposeTracker] Skipped clearing tag for message ${details.relatedMessageId} (no reply tag present).`); }
                            }
                        } catch (eTag) {
                            console.warn("[ComposeTracker] Failed to read related message tags:", eTag);
                        }
                    }
                } catch (e) {
                    console.warn("[ComposeTracker] Failed to clear reply tag during onBeforeSend:", e);
                }
            };
            browser.compose.onBeforeSend.addListener(_onBeforeSendListener);
        }
    }
} catch (e) {
    // Gracefully ignore missing compose APIs (e.g. in non-compose contexts)
}

// -------------------------------------------------------------
// After-send indexing – resolve saved Sent copy via headerMessageId
// -------------------------------------------------------------

try {
    if (browser.compose && browser.compose.onAfterSend && typeof browser.compose.onAfterSend.addListener === "function") {
        if (!_afterSendListenerRegistered) {
            _afterSendListenerRegistered = true;
            _onAfterSendListener = async (tab, details) => {
                try {
                    const headerMessageId = details?.headerMessageId;
                    if (!headerMessageId) return;

                    // Retrieve cached accountId from onBeforeSend
                    let accountId = null;
                    try {
                        const ctx = sendCtxByTabId.get(tab.id);
                        accountId = ctx?.accountId || null;
                    } catch (_) {}

                    if (!accountId) {
                        if (log) { log(`[ComposeTracker] onAfterSend: no cached accountId for tab ${tab.id}`); }
                        return;
                    }

                    // Get Sent folders for this account and query by headerMessageId
                    let sentFolderIds = [];
                    try {
                        const sent = await getSentFoldersForAccount(accountId);
                        sentFolderIds = (sent || []).map(f => f.id);
                    } catch (_) {}

                    if (!Array.isArray(sentFolderIds) || sentFolderIds.length === 0) {
                        if (log) { log(`[ComposeTracker] onAfterSend: no Sent folders for account ${accountId}`); }
                        return;
                    }

                    let found = null;
                    try {
                        const res = await browser.messages.query({ folderId: sentFolderIds, headerMessageId });
                        if (Array.isArray(res?.messages) && res.messages.length) {
                            found = res.messages[0];
                        }
                    } catch (qErr) {
                        if (log) { log(`[ComposeTracker] onAfterSend: messages.query failed: ${qErr}`); }
                    }

                    if (!found) {
                        if (log) { log(`[ComposeTracker] onAfterSend: no Sent copy found for headerMessageId in scoped folders`); }
                        return;
                    }

                    try {
                        const { onNewMailReceived } = await import("../../fts/incrementalIndexer.js");
                        const folder = found.folder || found.folderId || { name: found?.folder?.name || "Sent" };
                        await onNewMailReceived(folder, [found]);
                        if (log) { log(`[ComposeTracker] onAfterSend: indexed sent message id=${found.id} folder=${found.folder?.name || "<unknown>"}`); }
                    } catch (e) {
                        if (log) { log(`[ComposeTracker] onAfterSend: FTS handoff failed: ${e}`); }
                    } finally {
                        try { sendCtxByTabId.delete(tab.id); } catch (_) {}
                    }
                } catch (e) {
                    console.warn("[ComposeTracker] onAfterSend handler error:", e);
                }
            };
            browser.compose.onAfterSend.addListener(_onAfterSendListener);
        }
    }
} catch (e) {
    // Ignore if compose APIs are unavailable
}


// -------------------------------------------------------------
// Compose initialise – detect reply compose and precompute reply
// -------------------------------------------------------------

async function waitForComposeDetails(tabId, maxWait = 400, step = 50) {
    const start = performance.now();
    while (true) {
        try {
            const det = await browser.compose.getComposeDetails(tabId);
            if (det.type === "reply" && det.relatedMessageId) {
                return det;
            }
        } catch (_) { /* ignore transient errors */ }
        if (performance.now() - start >= maxWait) {
            try {
                return await browser.compose.getComposeDetails(tabId);
            } catch {
                return {};
            }
        }
        await new Promise(r => setTimeout(r, step));
    }
}

export function initComposeHandlers() {
    if (!_onCreatedListener) {
        _onCreatedListener = async (tab) => {
        let immediateDetails = {};
        try {
            immediateDetails = await browser.compose.getComposeDetails(tab.id);
        } catch {}

        // If this is not a compose window, bail early
        if (!immediateDetails || !immediateDetails.type) {
            // Not a compose window (might be a normal tab)
            return;
        }

        let composeDetails;
        if (immediateDetails.type === "reply" && immediateDetails.relatedMessageId) {
            composeDetails = immediateDetails;
        } else {
            composeDetails = await waitForComposeDetails(tab.id);
        }

        if (composeDetails.type === "reply" && composeDetails.relatedMessageId) {
            const relatedMessageId = composeDetails.relatedMessageId;
            const uniqueMessageKey = await getUniqueMessageKey(relatedMessageId);

            if (!uniqueMessageKey) {
                log(`Could not generate uniqueMessageKey for related message ${relatedMessageId}. Cannot activate session.`);
                return;
            }

            trackComposeWindow(tab.id);

            log(`Detected reply-compose window for message ${relatedMessageId}. Sending activation request for session ${tab.id} with key ${formatForLog(uniqueMessageKey)}.`);

            try {
                const replyKey = STORAGE_PREFIX + uniqueMessageKey;
                const replyEntry = await idb.get(replyKey);
                if (replyEntry && replyEntry[replyKey]) {
                    log(`Info: Reply for key ${uniqueMessageKey} found. Activating cached reply.`);
                    const replyData = replyEntry[replyKey];
                    const reply = replyData.reply;
                    const directReplace = replyData.directReplace || false;
                    if (typeof reply === "string" && reply.trim()) {
                        // Store in the new format that includes directReplace flag
                        const precomposeData = {
                            content: reply,
                            directReplace: directReplace
                        };
                        await idb.set({ ["activePrecompose:" + tab.id]: precomposeData });
                        log(`Stored cached reply for tab ${tab.id} (key ${formatForLog(uniqueMessageKey)}, directReplace=${directReplace})`);
                    } else {
                        log(`Info: Unexpected type for reply data for key ${uniqueMessageKey}.`);
                        console.log(replyData);
                    }
                } else {
                    log(`Info: Reply for key ${uniqueMessageKey} not found. Triggering reactive, high-priority reply and waiting for completion.`);
                    await createReply(relatedMessageId, true);
                    try {
                        const postGenEntry = await idb.get(replyKey);
                        const replyData = postGenEntry[replyKey];
                        const rep = replyData?.reply;
                        const directReplace = replyData?.directReplace || false;
                        if (typeof rep === "string" && rep.trim()) {
                            // Store in the new format that includes directReplace flag
                            const precomposeData = {
                                content: rep,
                                directReplace: directReplace
                            };
                            await idb.set({ ["activePrecompose:" + tab.id]: precomposeData });
                            log(`Stored cached reply (post-gen) for tab ${tab.id} (key ${formatForLog(uniqueMessageKey)}, directReplace=${directReplace})`);
                        } else {
                            log(`WARN: Reply generation finished but no reply found for key ${uniqueMessageKey}.`);
                        }
                    } catch (postErr) {
                        log(`ERROR while persisting post-generation history for key ${uniqueMessageKey}: ${postErr}`, "error");
                    }
                }
            } catch (actErr) {
                log(`ERROR during local reply activation: ${actErr}`, "error");
            }
        }
        };
        browser.tabs.onCreated.addListener(_onCreatedListener);
    }
}
 