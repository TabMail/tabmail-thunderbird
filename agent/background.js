// Main agent file.
import { initComposeHandlers, isAnyComposeOpen } from "./modules/composeTracker.js";
import { SETTINGS } from "./modules/config.js";
import * as idb from "./modules/idbStorage.js";
import { ensureSignedIn, signOut } from "./modules/supabaseAuth.js";
// Indexing disabled – import removed
import { cleanupContextMenus, initContextMenus } from "./modules/contextMenus.js";
import { isInboxFolder } from "./modules/folderUtils.js";
import { updateIconBasedOnAuthState } from "./modules/icon.js";
import { checkAndShowArchivePrompt, setDefaultSortForLargeInbox } from "./modules/inboxArchivePrompt.js";
// getInboxForAccount no longer needed - messages are processed directly from event listeners
import { purgeExpiredActionEntries } from "./modules/actionGenerator.js";
import { purgeOlderThanByPrefixes } from "./modules/idbStorage.js";
import { kbUpdate } from "./modules/knowledgebase.js";
import { scanAllInboxes } from "./modules/messageProcessor.js";
import { enqueueProcessMessage, initProcessMessageQueue } from "./modules/messageProcessorQueue.js";
import { attachOnMovedListeners, cleanupOnMovedListeners } from "./modules/onMoved.js";
import { purgeExpiredReplyEntries } from "./modules/replyGenerator.js";
import { purgeExpiredSummaryEntries } from "./modules/summaryGenerator.js";
// Reminder generation is now integrated into messageProcessor.js
import { enforceMailSyncPrefs } from "./modules/startupPrefs.js";
import { initSummaryFeatures, refreshCurrentMessageSummary, signalBubbleReady } from "./modules/summary.js";
import { registerTabKeyHandlers } from "./modules/tagActionKey.js";
import {
    attachTagByThreadListener,
    attachThreadTagWatchers,
    cleanupTagByThreadListener,
    cleanupThreadTagWatchers,
} from "./modules/tagHelper.js";
import { attachThreadTooltipHandlers } from "./modules/threadTooltip.js";
import { log } from "./modules/utils.js";

log("TabMail Agent background script loaded.");
// log('[TMDBG Summary] agent.js debug build reloaded – timestamp ' + (new Date()).toISOString());

// ----------------------------------------------------------
// Diagnostic instrumentation
// ----------------------------------------------------------
// 1) Signal that the MV3 background worker has started and report the
//    manifest version so we can confirm reloads in the Browser Console.
try {
    console.log(
        "[TabMail Agent] background worker loaded – version",
        browser.runtime.getManifest().version
    );
} catch (e) {
    console.error("[TabMail Agent] Failed to log manifest version:", e);
}

// --- Event Listeners ---

// Store runtime message listener reference for cleanup
let agentRuntimeMessageListener = null;

/**
 * Remove any existing runtime message listener to prevent accumulation on reload
 */
function cleanupRuntimeListeners() {
  if (agentRuntimeMessageListener) {
    try {
      browser.runtime.onMessage.removeListener(agentRuntimeMessageListener);
      agentRuntimeMessageListener = null;
      log("Agent runtime message listener cleaned up");
    } catch (e) {
      log(`Failed to remove agent runtime message listener: ${e}`, "error");
    }
  }
}

/**
 * Setup runtime message listener with proper cleanup tracking
 */
function setupRuntimeMessageListener() {
  // Clean up any existing listener first
  cleanupRuntimeListeners();
  
  // Create the listener function
  agentRuntimeMessageListener = (message, sender, sendResponse) => {
    // log(`[TMDBG Agent BG] runtime.onMessage received: ${JSON.stringify(message)}`);

    // removed combined clear-action-summary-cache in favour of separate controls

    // Auth popup resize requests - DISABLED (popup uses fixed size now)
    // Keeping the handler to ignore any stale messages from cached website
    if (message?.command === "auth-window-resize") {
      // Intentionally ignore - popup now uses fixed dimensions
      return;
    }

    if (message.command === "tmHdr-log" && typeof message.text === "string") {
        try { console.log(message.text); } catch(_) {}
        return; // no response needed
    }

    // Summary bubble signals it's ready to receive messages (listener registered).
    // This resolves the waitForBubbleReady promise in summary.js.
    if (message.command === "tm-summary-bubble-ready") {
        try {
            const tabId = sender?.tab?.id;
            if (typeof tabId === "number") {
                signalBubbleReady(tabId);
            }
        } catch (_) {}
        return; // no response needed
    }

    if (message.command === "clear-action-cache") {
        log("Received clear-action-cache command – clearing only action:* entries.");
        idb.get(null).then(all => {
            const del = Object.keys(all).filter(k => k.startsWith("action:"));
            if (del.length) idb.remove(del);
            log(`Cleared ${del.length} action cache entries.`);
        });
        return { ok: true };
    }

    if (message.command === "clear-summary-cache") {
        log("Received clear-summary-cache command – clearing only summary:* entries.");
        idb.get(null).then(all => {
            const del = Object.keys(all).filter(k => k.startsWith("summary:"));
            if (del.length) idb.remove(del);
            log(`Cleared ${del.length} summary cache entries.`);
        });
        return { ok: true };
    }

    // (Deprecated) update-style-guide command removed.

    if (message.command === "chatRequest") {
        // Chat endpoint not yet implemented – ignore for now.
        return; // not handled; let other listeners respond
    }

    if (message.command === "clear-reply-cache") {
        log("Received clear-reply-cache command from popup – purging reply entries.");
        idb.get(null).then(all => {
            const del = Object.keys(all).filter(k => k.startsWith("reply:"));
            if (del.length) idb.remove(del);
            log(`Cleared ${del.length} reply entries.`);
        });
        return { ok: true };
    }

    if (message.command === "clear-reminders") {
        log("Received clear-reminders command from config – clearing stored reminders.");
        (async () => {
            try {
                const { clearReminders } = await import("./modules/reminderGenerator.js");
                await clearReminders();
                log("Successfully cleared reminders.");
            } catch (e) {
                log(`Failed to clear reminders: ${e}`, "error");
            }
        })();
        return { ok: true };
    }

    if (message.command === "disable-reminder") {
        const { hash } = message;
        log(`Received disable-reminder command for: ${hash}`);
        // Return a promise for async handling
        return (async () => {
            try {
                const { setEnabled } = await import("./modules/reminderStateStore.js");
                await setEnabled(hash, false);
                log(`Successfully disabled reminder: ${hash}`);
                return { ok: true };
            } catch (e) {
                log(`Error disabling reminder: ${e}`, "error");
                return { ok: false, error: String(e) };
            }
        })();
    }

    if (message.command === "enable-reminder") {
        const { hash } = message;
        log(`Received enable-reminder command for: ${hash}`);
        // Return a promise for async handling
        return (async () => {
            try {
                const { setEnabled } = await import("./modules/reminderStateStore.js");
                await setEnabled(hash, true);
                log(`Successfully enabled reminder: ${hash}`);
                return { ok: true };
            } catch (e) {
                log(`Error enabling reminder: ${e}`, "error");
                return { ok: false, error: String(e) };
            }
        })();
    }

    if (message.command === "get-all-reminders") {
        log("Received get-all-reminders command");
        // Return a promise for async handling - gets all reminders including disabled ones
        return (async () => {
            try {
                const { buildReminderList } = await import("./modules/reminderBuilder.js");
                const result = await buildReminderList({ includeDisabled: true });
                log(`Retrieved ${result.reminders.length} reminders (${result.counts.disabled} disabled)`);
                return { ok: true, reminders: result.reminders, counts: result.counts };
            } catch (e) {
                log(`Error getting reminders: ${e}`, "error");
                return { ok: false, error: String(e), reminders: [], counts: {} };
            }
        })();
    }

    if (message.command === "reset-inbox-archive-prompt") {
        log("Received reset-inbox-archive-prompt command – resetting archive prompt flag.");
        (async () => {
            try {
                const { resetArchivePrompt } = await import("./modules/inboxArchivePrompt.js");
                await resetArchivePrompt();
                log("Successfully reset archive prompt flag.");
            } catch (e) {
                log(`Failed to reset archive prompt flag: ${e}`, "error");
            }
        })();
        return { ok: true };
    }

    if (message.command === "reset-user-prompts") {
        log("Received reset-user-prompts command from popup – copying bundled prompts to storage.local.");
        (async () => {
            try {
                async function _fetchBundled(name) {
                    const url = browser.runtime.getURL(`prompts/${name}`);
                    const resp = await fetch(url);
                    if (!resp.ok) {
                        throw new Error(`Fetch bundled ${name} failed (${resp.status})`);
                    }
                    return resp.text();
                }
                const ua = await _fetchBundled("user_action.md");
                const uc = await _fetchBundled("user_composition.md");
                const kv = {
                    ["user_prompts:user_action.md"]: ua,
                    ["user_prompts:user_composition.md"]: uc,
                };
                await browser.storage.local.set(kv);
                log("Reset user prompts completed successfully (storage.local updated).");
            } catch (e) {
                log(`Reset user prompts failed: ${e}`, "error");
            }
        })();
        return { ok: true };
    }

    if (message.command === "reset-action-prompt") {
        log("Received reset-action-prompt – restoring bundled user_action.md into storage.local.");
        (async () => {
            try {
                const url = browser.runtime.getURL("prompts/user_action.md");
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`Fetch bundled user_action.md failed (${resp.status})`);
                const text = await resp.text();
                await browser.storage.local.set({ ["user_prompts:user_action.md"]: text });
                // Verify write for diagnostics
                try {
                    const kv = await browser.storage.local.get(["user_prompts:user_action.md"]);
                    const len = (kv?.["user_prompts:user_action.md"] || "").length;
                    log(`Action prompt reset complete (storedLen=${len}). Sending response ok.`);
                } catch (vErr) {
                    log(`Action prompt post-set verification failed: ${vErr}`, "warn");
                }
                sendResponse({ ok: true });
            } catch (e) {
                log(`reset-action-prompt failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true; // keep message channel open for async sendResponse
    }

    if (message.command === "reset-composition-prompt") {
        log("Received reset-composition-prompt – restoring bundled user_composition.md into storage.local.");
        (async () => {
            try {
                const url = browser.runtime.getURL("prompts/user_composition.md");
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`Fetch bundled user_composition.md failed (${resp.status})`);
                const text = await resp.text();
                await browser.storage.local.set({ ["user_prompts:user_composition.md"]: text });
                // Verify write for diagnostics
                try {
                    const kv = await browser.storage.local.get(["user_prompts:user_composition.md"]);
                    const len = (kv?.["user_prompts:user_composition.md"] || "").length;
                    log(`Composition prompt reset complete (storedLen=${len}). Sending response ok.`);
                } catch (vErr) {
                    log(`Composition prompt post-set verification failed: ${vErr}`, "warn");
                }
                sendResponse({ ok: true });
            } catch (e) {
                log(`reset-composition-prompt failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true; // keep message channel open for async sendResponse
    }

    if (message.command === "reset-kb-prompt") {
        log("Received reset-kb-prompt – restoring bundled user_kb.md into storage.local.");
        (async () => {
            try {
                const url = browser.runtime.getURL("prompts/user_kb.md");
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`Fetch bundled user_kb.md failed (${resp.status})`);
                const text = await resp.text();
                await browser.storage.local.set({ ["user_prompts:user_kb.md"]: text });
                // Verify write for diagnostics
                try {
                    const kv = await browser.storage.local.get(["user_prompts:user_kb.md"]);
                    const len = (kv?.["user_prompts:user_kb.md"] || "").length;
                    log(`KB prompt reset complete (storedLen=${len}). Sending response ok.`);
                } catch (vErr) {
                    log(`KB prompt post-set verification failed: ${vErr}`, "warn");
                }
                sendResponse({ ok: true });
            } catch (e) {
                log(`reset-kb-prompt failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true; // keep message channel open for async sendResponse
    }

    if (message.command === "kb-update-from-window-close") {
        log("-- KB -- Received window close KB update request in background script");
        if (Array.isArray(message.conversationHistory) && message.conversationHistory.length > 0) {
            // Run KB update asynchronously in background - no timing constraints here!
            kbUpdate(message.conversationHistory).catch(e => {
                log(`-- KB -- Background update failed: ${e}`, "warn");
            });
        }
        return { ok: true }; // Immediate response, KB update continues async
    }

    if (message.command === "update-icon-auth-state") {
        log(`Received update-icon-auth-state command (authState=${message.authState})`);
        // Run icon update asynchronously in background - no timing constraints here!
        // authState is required - caller must provide it
        if (message.authState === undefined) {
            log("[Icon] update-icon-auth-state message missing required authState field", "error");
            return { ok: false, error: "authState required" };
        }
        updateIconBasedOnAuthState(message.authState).catch(e => {
            log(`Failed to update icon based on auth state: ${e}`, "warn");
        });
        // If user just logged in, refresh the summary bubble so it shows actual summary
        // instead of "not logged in" warning
        if (message.authState === true) {
            log("[Auth] User logged in, triggering summary bubble refresh");
            refreshCurrentMessageSummary().catch(e => {
                log(`Failed to refresh summary after signin: ${e}`, "warn");
            });
        } else {
            log(`[Auth] authState=${message.authState}, not refreshing summary`);
        }
        return { ok: true }; // Immediate response, icon update continues async
    }

    if (message.command === "start-signin") {
        log("Received start-signin command - running in background context");
        // Run sign-in asynchronously in background - persists even if popup closes!
        (async () => {
            try {
                const success = await ensureSignedIn();
                log(`[Auth] Sign-in completed in background: ${success}`);
                // Update icon after sign-in completes - success means logged in
                await updateIconBasedOnAuthState(success);
                // Refresh summary bubble if sign-in was successful
                if (success) {
                    log("[Auth] Sign-in successful, refreshing summary bubble");
                    await refreshCurrentMessageSummary();
                }
            } catch (e) {
                log(`[Auth] Sign-in failed in background: ${e}`, "error");
                // On error, assume not logged in
                await updateIconBasedOnAuthState(false).catch(() => {});
            }
        })();
        return { ok: true }; // Immediate response, sign-in continues async
    }

    if (message.command === "start-signout") {
        log("Received start-signout command - running in background context");
        // Run sign-out asynchronously in background - persists even if popup closes!
        (async () => {
            try {
                const success = await signOut();
                log(`[Auth] Sign-out completed in background: ${success}`);
                // Update icon after sign-out completes - success means logged out (authState = false)
                await updateIconBasedOnAuthState(!success);
            } catch (e) {
                log(`[Auth] Sign-out failed in background: ${e}`, "error");
                // On error, assume sign-out failed (still logged in) - safer than assuming logged out
                await updateIconBasedOnAuthState(true).catch(() => {});
            }
        })();
        return { ok: true }; // Immediate response, sign-out continues async
    }

    if (message.command === "read-prompt-file") {
        log(`Received read-prompt-file command for ${message.filename}`);
        (async () => {
            try {
                const storageKey = `user_prompts:${message.filename}`;
                const stored = await browser.storage.local.get([storageKey]);
                
                if (stored[storageKey]) {
                    sendResponse({ ok: true, content: stored[storageKey] });
                } else {
                    // Fall back to bundled version
                    const url = browser.runtime.getURL(`prompts/${message.filename}`);
                    const resp = await fetch(url);
                    if (!resp.ok) {
                        throw new Error(`Failed to fetch bundled ${message.filename} (${resp.status})`);
                    }
                    const content = await resp.text();
                    sendResponse({ ok: true, content });
                }
            } catch (e) {
                log(`read-prompt-file failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true; // keep message channel open for async sendResponse
    }

    if (message.command === "write-prompt-file") {
        log(`Received write-prompt-file command for ${message.filename}`);
        (async () => {
            try {
                const storageKey = `user_prompts:${message.filename}`;
                await browser.storage.local.set({ [storageKey]: message.content });
                log(`Successfully wrote ${message.filename} to storage`);
                sendResponse({ ok: true });
            } catch (e) {
                log(`write-prompt-file failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true; // keep message channel open for async sendResponse
    }

    if (message.command === "reset-prompt-file") {
        log(`Received reset-prompt-file command for ${message.filename}`);
        (async () => {
            try {
                const url = browser.runtime.getURL(`prompts/${message.filename}`);
                const resp = await fetch(url);
                if (!resp.ok) {
                    throw new Error(`Failed to fetch bundled ${message.filename} (${resp.status})`);
                }
                const text = await resp.text();
                const storageKey = `user_prompts:${message.filename}`;
                await browser.storage.local.set({ [storageKey]: text });
                log(`Successfully reset ${message.filename} to default`);
                sendResponse({ ok: true });
            } catch (e) {
                log(`reset-prompt-file failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true; // keep message channel open for async sendResponse
    }

    // --- Template Management Commands ---
    if (message.command === "templates-load") {
        log("Received templates-load command");
        (async () => {
            try {
                const { loadTemplates } = await import("./modules/templateManager.js");
                const templates = await loadTemplates();
                sendResponse({ ok: true, templates });
            } catch (e) {
                log(`templates-load failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    if (message.command === "templates-add") {
        log("Received templates-add command");
        (async () => {
            try {
                const { addTemplate } = await import("./modules/templateManager.js");
                const template = await addTemplate(message.template || {});
                if (template) {
                    sendResponse({ ok: true, template });
                } else {
                    sendResponse({ ok: false, error: "Failed to add template" });
                }
            } catch (e) {
                log(`templates-add failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    if (message.command === "templates-update") {
        log(`Received templates-update command for ${message.id}`);
        (async () => {
            try {
                const { updateTemplate } = await import("./modules/templateManager.js");
                const template = await updateTemplate(message.id, message.updates || {});
                if (template) {
                    sendResponse({ ok: true, template });
                } else {
                    sendResponse({ ok: false, error: "Template not found" });
                }
            } catch (e) {
                log(`templates-update failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    if (message.command === "templates-delete") {
        log(`Received templates-delete command for ${message.id}`);
        (async () => {
            try {
                const { deleteTemplate } = await import("./modules/templateManager.js");
                const success = await deleteTemplate(message.id);
                sendResponse({ ok: success, error: success ? null : "Template not found" });
            } catch (e) {
                log(`templates-delete failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    if (message.command === "templates-import") {
        log("Received templates-import command");
        (async () => {
            try {
                const { importTemplates } = await import("./modules/templateManager.js");
                const result = await importTemplates(message.json, message.overwrite || false);
                sendResponse({ ok: true, imported: result.imported, skipped: result.skipped });
            } catch (e) {
                log(`templates-import failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    if (message.command === "templates-export") {
        log("Received templates-export command");
        (async () => {
            try {
                const { exportTemplates } = await import("./modules/templateManager.js");
                const json = await exportTemplates(message.ids);
                sendResponse({ ok: true, json });
            } catch (e) {
                log(`templates-export failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    if (message.command === "templates-reset") {
        log("Received templates-reset command");
        (async () => {
            try {
                const { resetToDefaultTemplates } = await import("./modules/templateManager.js");
                const count = await resetToDefaultTemplates();
                sendResponse({ ok: true, count });
            } catch (e) {
                log(`templates-reset failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    if (message.command === "templates-reorder") {
        log("Received templates-reorder command");
        (async () => {
            try {
                const { reorderTemplates } = await import("./modules/templateManager.js");
                const success = await reorderTemplates(message.orderedIds || []);
                sendResponse({ ok: success, error: success ? null : "Failed to reorder templates" });
            } catch (e) {
                log(`templates-reorder failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    if (message.command === "templates-save-all") {
        log("Received templates-save-all command");
        (async () => {
            try {
                const { saveTemplates } = await import("./modules/templateManager.js");
                const success = await saveTemplates(message.templates || []);
                sendResponse({ ok: success, error: success ? null : "Failed to save templates" });
            } catch (e) {
                log(`templates-save-all failed: ${e}`, "error");
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }

    // If we reach here, the message was not handled; do not respond so other listeners can handle.
    return;
  };
  
  // Register the listener
  browser.runtime.onMessage.addListener(agentRuntimeMessageListener);
  log("Agent runtime message listener setup complete");
}

// Initialize the runtime message listener
setupRuntimeMessageListener();

// Messages are now processed directly in event listeners instead of scheduling folder scans.
// This is more efficient: new/moved/copied messages are processed immediately as they arrive.
// Initial startup scan (scanAllInboxes) still processes existing inbox messages on load.

// Periodic inbox scan - safety net to catch any missed messages
let _inboxScanTimer = null;
let _inboxScanRunning = false;

function _getInboxScanIntervalMs() {
  const val = SETTINGS?.agentQueues?.inboxScan?.intervalMs;
  // Use nullish coalescing to allow 0 (disabled) - don't use || which treats 0 as falsy
  return typeof val === "number" ? val : 30000;
}

function startPeriodicInboxScan() {
  if (_inboxScanTimer) return; // already running
  const intervalMs = _getInboxScanIntervalMs();
  if (intervalMs <= 0) {
    log("[PeriodicScan] Disabled (intervalMs <= 0)");
    return;
  }
  _inboxScanTimer = setInterval(async () => {
    if (_inboxScanRunning) {
      log("[PeriodicScan] Skipping - previous scan still running");
      return;
    }
    _inboxScanRunning = true;
    try {
      log("[PeriodicScan] Running proactive inbox scan...");
      await scanAllInboxes();
      log("[PeriodicScan] Proactive inbox scan complete");
    } catch (e) {
      log(`[PeriodicScan] Error during proactive scan: ${e}`, "warn");
    } finally {
      _inboxScanRunning = false;
    }
  }, intervalMs);
  log(`[PeriodicScan] Started periodic inbox scan (interval=${intervalMs}ms)`);
}

function stopPeriodicInboxScan() {
  if (_inboxScanTimer) {
    clearInterval(_inboxScanTimer);
    _inboxScanTimer = null;
    log("[PeriodicScan] Stopped periodic inbox scan");
  }
}

// Debounced cache cleanup - runs after message processing to clean up expired entries
let _cacheCleanupTimer = null;

/**
 * Schedule a debounced cache cleanup.
 * This replaces the cleanup that used to run after periodic scans.
 * Multiple calls within the debounce window reset the timer.
 */
function scheduleCacheCleanup() {
  const debounceMs = Number(SETTINGS.cacheCleanupDebounceMs) || 10000;
  
  // Clear existing timer if any
  if (_cacheCleanupTimer) {
    clearTimeout(_cacheCleanupTimer);
  }
  
  // Schedule new cleanup
  _cacheCleanupTimer = setTimeout(async () => {
    _cacheCleanupTimer = null;
    log("[CacheCleanup] Running debounced cache cleanup...");
    
    try {
      await purgeExpiredReplyEntries();
      await purgeExpiredActionEntries();
      await purgeExpiredSummaryEntries();
      
      // Also purge other IDB caches that do not have dedicated `*:ts:*` meta keys
      const ttlSeconds = Math.max(
        Number(SETTINGS.replyTTLSeconds || 0),
        Number(SETTINGS.actionTTLSeconds || 0),
        Number(SETTINGS.summaryTTLSeconds || 0)
      );
      const cutoff = Date.now() - ttlSeconds * 1000;
      const removed = await purgeOlderThanByPrefixes(
        [
          "activePrecompose:",
          "activeHistory:",
          "action:orig:",
          "action:userprompt:",
          "action:justification:",
          "threadTags:",
        ],
        cutoff
      );
      if (removed > 0) {
        log(`[CacheCleanup] Purged ${removed} old non-meta IDB cache entries (prefix-based).`);
      }
      log("[CacheCleanup] Cache cleanup completed");
    } catch (e) {
      log(`[CacheCleanup] Error during cache cleanup: ${e}`, "error");
    }
  }, debounceMs);
  
  log(`[CacheCleanup] Scheduled cache cleanup in ${debounceMs}ms`);
}

/**
 * Cleanup the cache cleanup timer on extension suspend
 */
function cleanupCacheCleanupTimer() {
  if (_cacheCleanupTimer) {
    clearTimeout(_cacheCleanupTimer);
    _cacheCleanupTimer = null;
    log("[CacheCleanup] Cleared pending cache cleanup timer");
  }
}

// Store inbox activity listener references for cleanup
let _onNewMailReceivedListener = null;
let _onMovedInboxListener = null;
let _onCopiedInboxListener = null;

// Note: Deduplication at listener level is NOT needed.
// Per-message semaphores in generators (summary, action, reply) already prevent
// concurrent processing and cache checks make repeated calls fast no-ops.

/**
 * Cleanup inbox activity listeners to prevent accumulation on reload
 */
function cleanupInboxActivityListeners() {
  if (_onNewMailReceivedListener && browser.messages?.onNewMailReceived) {
    browser.messages.onNewMailReceived.removeListener(_onNewMailReceivedListener);
    _onNewMailReceivedListener = null;
    log("[TMDBG Agent] onNewMailReceived listener removed");
  }
  if (_onMovedInboxListener && browser.messages?.onMoved) {
    browser.messages.onMoved.removeListener(_onMovedInboxListener);
    _onMovedInboxListener = null;
    log("[TMDBG Agent] inbox onMoved listener removed");
  }
  if (_onCopiedInboxListener && browser.messages?.onCopied) {
    browser.messages.onCopied.removeListener(_onCopiedInboxListener);
    _onCopiedInboxListener = null;
    log("[TMDBG Agent] inbox onCopied listener removed");
  }
  // Also cleanup tmMsgNotify experiment listeners
  cleanupTmMsgNotifyListeners();
  // Also cleanup untagged coverage listener
  cleanupUntaggedCoverageListener();
}

/**
 * Listener for new mail. When a new message arrives, process it directly.
 * NOTE: The 'message' object is actually a notification object containing
 * an array of the real message headers.
 */
if (!_onNewMailReceivedListener) {
  _onNewMailReceivedListener = async (folder, notification) => {
    console.log("[InboxActivity] ★★★ onNewMailReceived FIRED ★★★");
    console.log("[InboxActivity] onNewMailReceived fired. Full notification object:", notification);
    console.log("[InboxActivity] Folder object:", folder);
    log(`[InboxActivity] ★★★ onNewMailReceived: folder='${folder?.name}' (type=${folder?.type}, path=${folder?.path}), messages=${notification?.messages?.length || 0}`);

    if (!notification.messages || notification.messages.length === 0) {
        log("[InboxActivity] New mail notification received, but it contained no messages. Ignoring.", "warn");
        return;
    }

    // Log each message for debugging
    notification.messages.forEach((msg, idx) => {
      log(`[InboxActivity] Message ${idx + 1}: id=${msg.id}, subject="${msg.subject}", author="${msg.author}", date=${msg.date}`);
    });

    // Check if folder is inbox
    const isInbox = isInboxFolder(folder);
    log(`[FolderDetection] isInboxFolder('${folder.name}'): type='${folder.type}', path='${folder.path}', accountId='${folder.accountId}', id='${folder.id}', result=${isInbox}`);
    
    // If it's not detected as inbox but name looks like inbox, warn about it
    if (!isInbox && folder.name?.toLowerCase()?.includes('inbox')) {
      log(`[FolderDetection] WARNING: Folder name contains 'inbox' but type='${folder.type}' and path='${folder.path}' - not matching inbox criteria! This might be a Gmail IMAP quirk.`, "warn");
    }
    
    log(`[InboxActivity] Folder '${folder?.name}' isInbox=${isInbox} (type=${folder?.type}, path=${folder?.path})`);

    // Integrate FTS incremental indexing (avoid duplicate listeners)
    try {
      const { onNewMailReceived: ftsOnNewMail } = await import("../fts/incrementalIndexer.js");
      await ftsOnNewMail(folder, notification.messages);
      log(`[InboxActivity] FTS incremental indexing completed for ${notification.messages.length} messages`);
    } catch (e) {
      log(`[InboxActivity] FTS incremental indexing failed for new mail: ${e}`, "warn");
    }

    // Only process messages if they arrived in inbox folders
    if (!isInbox) {
      log(`[InboxActivity] Skipping message processing - folder '${folder.name}' is not an inbox`);
      return;
    }

    // Enqueue all messages for processing
    // processMessage handles internal/external distinction internally
    log(`[InboxActivity] Enqueueing ${notification.messages.length} new message(s) for processing`);
    
    let enqueuedCount = 0;
    for (const msg of notification.messages) {
      try {
        await enqueueProcessMessage(msg, { isPriority: false, source: "onNewMailReceived" });
        enqueuedCount++;
      } catch (e) {
        log(`[InboxActivity] Failed to enqueue message ${msg.id}: ${e}`, "error");
      }
    }
    
    log(`[InboxActivity] Enqueued ${enqueuedCount}/${notification.messages.length} new message(s)`);
    
    // Schedule debounced cache cleanup after processing (only if we enqueued something)
    if (enqueuedCount > 0) {
      scheduleCacheCleanup();
    }
  };
  browser.messages.onNewMailReceived.addListener(_onNewMailReceivedListener);
  log("[TMDBG Agent] onNewMailReceived listener attached");
}

/**
 * Listener for messages moved to a folder.
 * Processes messages directly if moved TO an inbox.
 */
if (!_onMovedInboxListener) {
  _onMovedInboxListener = async (originalFolder, movedMessages) => {
    console.log("[InboxActivity] ★★★ onMoved FIRED ★★★");
    console.log("[InboxActivity] originalFolder:", originalFolder, "movedMessages:", movedMessages);
    
    // movedMessages is a MessageList with a messages array
    if (!movedMessages?.messages || movedMessages.messages.length === 0) {
      log("[InboxActivity] onMoved fired but no messages in MessageList");
      return;
    }

    log(`[InboxActivity] onMoved: ${movedMessages.messages.length} messages moved from folder '${originalFolder?.name}'`);

    // Enqueue messages that were moved TO an inbox (skip already-tagged)
    // processMessage handles internal/external distinction internally
    let enqueuedCount = 0;
    let skippedCount = 0;
    for (const msg of movedMessages.messages) {
      if (msg.folder && isInboxFolder(msg.folder)) {
        // Skip if already has TabMail tag (avoid redundant processing)
        if (hasTabMailTag(msg.tags)) {
          skippedCount++;
          continue;
        }
        try {
          log(`[InboxActivity] Enqueueing moved message ${msg.id} (now in inbox "${msg.folder.name}")`);
          await enqueueProcessMessage(msg, { isPriority: false, source: "onMoved" });
          enqueuedCount++;
        } catch (e) {
          log(`[InboxActivity] Failed to enqueue moved message ${msg.id}: ${e}`, "error");
        }
      }
    }
    if (skippedCount > 0) {
      log(`[InboxActivity] Skipped ${skippedCount} already-tagged message(s) in onMoved`);
    }
    // Schedule debounced cache cleanup after processing (only if we enqueued something)
    if (enqueuedCount > 0) {
      scheduleCacheCleanup();
    }
  };
  browser.messages.onMoved.addListener(_onMovedInboxListener);
  log("[TMDBG Agent] inbox onMoved listener attached");
}

/**
 * Listener for messages copied to a folder.
 * This catches Gmail self-sends and other copy operations.
 * Processes messages directly if copied TO an inbox.
 */
if (!_onCopiedInboxListener) {
  _onCopiedInboxListener = async (originalFolder, copiedMessages) => {
    console.log("[InboxActivity] ★★★ onCopied FIRED ★★★");
    console.log("[InboxActivity] originalFolder:", originalFolder, "copiedMessages:", copiedMessages);
    
    // copiedMessages is a MessageList with a messages array
    if (!copiedMessages?.messages || copiedMessages.messages.length === 0) {
      log("[InboxActivity] onCopied fired but no messages in MessageList");
      return;
    }

    log(`[InboxActivity] onCopied: ${copiedMessages.messages.length} messages copied from folder '${originalFolder?.name}'`);

    // Enqueue messages that were copied TO an inbox (skip already-tagged)
    // processMessage handles internal/external distinction internally
    let enqueuedCount = 0;
    let skippedCount = 0;
    for (const msg of copiedMessages.messages) {
      if (msg.folder && isInboxFolder(msg.folder)) {
        // Skip if already has TabMail tag (avoid redundant processing)
        if (hasTabMailTag(msg.tags)) {
          skippedCount++;
          continue;
        }
        try {
          log(`[InboxActivity] Enqueueing copied message ${msg.id} (now in inbox "${msg.folder.name}")`);
          await enqueueProcessMessage(msg, { isPriority: false, source: "onCopied" });
          enqueuedCount++;
        } catch (e) {
          log(`[InboxActivity] Failed to enqueue copied message ${msg.id}: ${e}`, "error");
        }
      }
    }
    if (skippedCount > 0) {
      log(`[InboxActivity] Skipped ${skippedCount} already-tagged message(s) in onCopied`);
    }
    // Schedule debounced cache cleanup after processing (only if we enqueued something)
    if (enqueuedCount > 0) {
      scheduleCacheCleanup();
    }
  };
  browser.messages.onCopied.addListener(_onCopiedInboxListener);
  log("[TMDBG Agent] inbox onCopied listener attached");
}

// Store tmMsgNotify experiment listener references for cleanup
let _tmMsgNotifyAddedListener = null;

/**
 * Attach tmMsgNotify experiment listeners for low-level message notifications.
 * This catches events that WebExtension APIs may miss (IMAP sync, filter moves, etc.)
 */
function attachTmMsgNotifyListeners() {
  if (!browser.tmMsgNotify) {
    log("[tmMsgNotify] Experiment API not available - skipping listener attachment", "warn");
    return;
  }
  
  if (_tmMsgNotifyAddedListener) {
    log("[tmMsgNotify] Listeners already attached - skipping");
    return;
  }
  
  _tmMsgNotifyAddedListener = async (messageInfo) => {
    console.log("[tmMsgNotify] ★★★ onMessageAdded FIRED ★★★", messageInfo.eventType);
    log(`[tmMsgNotify] onMessageAdded: eventType=${messageInfo.eventType}, folder=${messageInfo.folderPath}, subject="${messageInfo.subject?.substring(0, 50)}"`);
    
    // Skip if no WebExtension folder ID or message ID
    if (!messageInfo.weFolderId) {
      log(`[tmMsgNotify] Skipping - no weFolderId for headerMessageId=${messageInfo.headerMessageId}`);
      return;
    }
    
    if (!messageInfo.weMsgId) {
      log(`[tmMsgNotify] Skipping - no weMsgId yet for headerMessageId=${messageInfo.headerMessageId}`);
      return;
    }
    
    // Get the folder object and check if it's an inbox using existing utility
    let folder = null;
    try {
      folder = await browser.folders.get(messageInfo.weFolderId);
    } catch (e) {
      log(`[tmMsgNotify] Failed to get folder ${messageInfo.weFolderId}: ${e}`, "warn");
      return;
    }
    
    if (!isInboxFolder(folder)) {
      log(`[tmMsgNotify] Skipping - folder '${folder?.name}' is not an inbox`);
      return;
    }
    
    // Get the full message header via WebExtension API
    let msgHeader = null;
    try {
      msgHeader = await browser.messages.get(messageInfo.weMsgId);
    } catch (e) {
      log(`[tmMsgNotify] Failed to get message ${messageInfo.weMsgId}: ${e}`, "warn");
      return;
    }
    
    if (!msgHeader) {
      log(`[tmMsgNotify] Message ${messageInfo.weMsgId} not found via messages.get`, "warn");
      return;
    }
    
    // Skip if already has TabMail tag (avoid redundant processing)
    if (hasTabMailTag(msgHeader.tags)) {
      log(`[tmMsgNotify] Skipping message ${msgHeader.id} - already has TabMail tag: [${msgHeader.tags?.join(",")}]`);
      return;
    }
    
    // Enqueue the message for processing
    // processMessage handles internal/external distinction internally
    log(`[tmMsgNotify] Enqueueing message ${msgHeader.id}: "${msgHeader.subject}"`);
    
    try {
      await enqueueProcessMessage(msgHeader, { isPriority: false, source: "tmMsgNotify.onMessageAdded" });
      log(`[tmMsgNotify] Enqueued message ${msgHeader.id}`);
      
      // Schedule debounced cache cleanup
      scheduleCacheCleanup();
    } catch (e) {
      log(`[tmMsgNotify] Failed to enqueue message ${msgHeader.id}: ${e}`, "error");
    }
  };
  
  browser.tmMsgNotify.onMessageAdded.addListener(_tmMsgNotifyAddedListener);
  log("[TMDBG Agent] tmMsgNotify.onMessageAdded listener attached");
}

/**
 * Cleanup tmMsgNotify experiment listeners
 */
function cleanupTmMsgNotifyListeners() {
  if (_tmMsgNotifyAddedListener && browser.tmMsgNotify) {
    try {
      browser.tmMsgNotify.onMessageAdded.removeListener(_tmMsgNotifyAddedListener);
      _tmMsgNotifyAddedListener = null;
      log("[TMDBG Agent] tmMsgNotify.onMessageAdded listener removed");
    } catch (e) {
      log(`[tmMsgNotify] Error removing listener: ${e}`, "error");
    }
  }
}

// Attach tmMsgNotify listeners
attachTmMsgNotifyListeners();

// ═══════════════════════════════════════════════════════════════════════════
// INBOX COVERAGE: Listen for untagged inbox messages from tagSort experiment
// and enqueue them for processing. This provides "complete" coverage without
// needing periodic scans.
// ═══════════════════════════════════════════════════════════════════════════

let _untaggedCoverageListener = null;

// TabMail action tag IDs - used to check if a message already has a TabMail tag
// (avoids importing from tagHelper.js to prevent circular dependencies)
const TABMAIL_ACTION_TAG_IDS = new Set(["tm_delete", "tm_archive", "tm_reply", "tm_none"]);

function hasTabMailTag(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => TABMAIL_ACTION_TAG_IDS.has(t));
}

async function handleUntaggedInboxMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;

  log(`[Coverage] Received ${messages.length} untagged inbox message(s) for processing`);

  for (const msgInfo of messages) {
    try {
      const { weMsgId, messageId } = msgInfo;

      // Prefer direct lookup by weMsgId (provided by experiment via messageManager.convert)
      // Falls back to query by headerMessageId if weMsgId not available
      let msgHeader = null;

      if (weMsgId) {
        try {
          msgHeader = await browser.messages.get(weMsgId);
        } catch (eGet) {
          log(`[Coverage] messages.get(${weMsgId}) failed: ${eGet}`, "warn");
        }
      }

      if (!msgHeader && messageId) {
        // Fallback: query by headerMessageId (slower)
        log(`[Coverage] Falling back to query for messageId=${messageId.substring(0, 40)}`);
        try {
          const page = await browser.messages.query({ headerMessageId: messageId });
          if (page?.messages?.length > 0) {
            msgHeader = page.messages[0];
          }
        } catch (eQuery) {
          log(`[Coverage] query failed: ${eQuery}`, "warn");
        }
      }

      if (!msgHeader) {
        log(`[Coverage] Could not find message: weMsgId=${weMsgId}, messageId=${messageId?.substring(0, 40)}`, "warn");
        continue;
      }

      // IMPORTANT: Check if message already has a TabMail tag via WE API
      // The experiment uses native keywords which may be stale, but WE API should be current
      // Skip enqueueing if already tagged to avoid redundant processing cycles
      if (hasTabMailTag(msgHeader.tags)) {
        log(`[Coverage] Skipping message ${msgHeader.id} - already has TabMail tag: [${msgHeader.tags?.join(",")}]`);
        continue;
      }

      // Enqueue for processing - processMessage handles internal/external distinction
      log(`[Coverage] Enqueueing message ${msgHeader.id} for processing`);
      await enqueueProcessMessage(msgHeader, { isPriority: false, source: "tagSort:coverage" });
    } catch (eMsgProcess) {
      log(`[Coverage] Failed to enqueue message: ${eMsgProcess}`, "error");
    }
  }
}

function attachUntaggedCoverageListener() {
  if (_untaggedCoverageListener) return;

  try {
    if (browser.tagSort?.onUntaggedInboxMessages) {
      _untaggedCoverageListener = handleUntaggedInboxMessages;
      browser.tagSort.onUntaggedInboxMessages.addListener(_untaggedCoverageListener);
      log("[TMDBG Agent] tagSort.onUntaggedInboxMessages listener attached");
    } else {
      log("[Coverage] tagSort.onUntaggedInboxMessages not available - coverage listener not attached", "warn");
    }
  } catch (e) {
    log(`[Coverage] Failed to attach onUntaggedInboxMessages listener: ${e}`, "error");
  }
}

function cleanupUntaggedCoverageListener() {
  if (_untaggedCoverageListener && browser.tagSort?.onUntaggedInboxMessages) {
    try {
      browser.tagSort.onUntaggedInboxMessages.removeListener(_untaggedCoverageListener);
      _untaggedCoverageListener = null;
      log("[TMDBG Agent] tagSort.onUntaggedInboxMessages listener removed");
    } catch (e) {
      log(`[Coverage] Error removing listener: ${e}`, "error");
    }
  }
}

// Attach coverage listener
attachUntaggedCoverageListener();

/**
 * On addon startup, automatically run a smart index.
 */
browser.runtime.onStartup.addListener(async () => {
    log("Addon startup: Indexing is disabled; skipping smart index.");
    console.log("[TMDBG Prefs] onStartup: calling enforceMailSyncPrefs");
    await enforceMailSyncPrefs();
    
    // Check and show welcome wizard on startup if not completed
    await checkAndShowWelcomeWizard();
});

// Guard flag to prevent concurrent welcome wizard launches
let _welcomeWizardCheckInProgress = false;

// Store account created listener reference for cleanup
let _onAccountCreatedListener = null;

/**
 * Check if there's at least one real email account (not "none" type like local folders)
 * @returns {Promise<boolean>} True if at least one email account exists
 */
async function hasEmailAccounts() {
    try {
        const accounts = await browser.accounts.list();
        // Filter out "none" type accounts (local folders, feed accounts)
        const emailAccounts = accounts.filter(account => account.type !== "none");
        log(`[Welcome] Found ${emailAccounts.length} email account(s) (total accounts: ${accounts.length})`);
        return emailAccounts.length > 0;
    } catch (e) {
        log(`[Welcome] Error checking accounts: ${e.message}`, "error");
        // Default to true to not block the wizard if accounts API fails
        return true;
    }
}

/**
 * Cleanup the account created listener
 */
function cleanupAccountCreatedListener() {
    if (_onAccountCreatedListener && browser.accounts?.onCreated) {
        browser.accounts.onCreated.removeListener(_onAccountCreatedListener);
        _onAccountCreatedListener = null;
        log("[Welcome] Account created listener removed");
    }
}

/**
 * Setup listener for account creation to show welcome wizard when first account is added
 */
function setupAccountCreatedListener() {
    if (_onAccountCreatedListener) {
        // Already set up
        return;
    }
    
    if (!browser.accounts?.onCreated) {
        log("[Welcome] accounts.onCreated API not available", "warn");
        return;
    }
    
    _onAccountCreatedListener = async (accountId, account) => {
        log(`[Welcome] Account created: ${accountId}, type: ${account?.type}`);
        // When a new account is created, check if we should show the welcome wizard
        // Only trigger for real email accounts (not "none" type)
        if (account?.type !== "none") {
            log("[Welcome] Email account added - checking if welcome wizard should be shown");
            await checkAndShowWelcomeWizard();
        }
    };
    
    browser.accounts.onCreated.addListener(_onAccountCreatedListener);
    log("[Welcome] Account created listener attached");
}

/**
 * Check if welcome wizard should be shown and open it if needed
 */
async function checkAndShowWelcomeWizard() {
    // Prevent concurrent execution
    if (_welcomeWizardCheckInProgress) {
        log("[Welcome] Welcome wizard check already in progress, skipping duplicate call");
        return;
    }
    
    _welcomeWizardCheckInProgress = true;
    
    try {
        const stored = await browser.storage.local.get({ tabmailWelcomeCompleted: false });
        
        if (!stored.tabmailWelcomeCompleted) {
            // Check if there's at least one email account
            const hasAccounts = await hasEmailAccounts();
            if (!hasAccounts) {
                log("[Welcome] No email accounts found - deferring welcome wizard until account is added");
                // Setup listener to trigger when an account is created
                setupAccountCreatedListener();
                _welcomeWizardCheckInProgress = false;
                return;
            }
            
            // We have email accounts, cleanup the listener if it exists
            cleanupAccountCreatedListener();
            const url = browser.runtime.getURL("welcome/welcome.html");
            const welcomeWindowConfig = SETTINGS.welcomeWindow || { defaultWidth: 780, defaultHeight: 680 };
            
            // Check if a welcome wizard window already exists
            try {
                const allWindows = await browser.windows.getAll();
                const welcomeWindow = allWindows.find(win => {
                    // Check if this window has the welcome URL
                    return win.tabs && win.tabs.some(tab => tab.url === url);
                });
                
                if (welcomeWindow) {
                    // Window already exists - focus it and reset to initial page
                    log("[Welcome] Welcome wizard window already open - focusing and resetting");
                    await browser.windows.update(welcomeWindow.id, { focused: true });
                    
                    // Small delay to ensure page is ready to receive messages
                    setTimeout(async () => {
                        try {
                            // Find the tab with the welcome URL
                            const welcomeTab = welcomeWindow.tabs.find(tab => tab.url === url);
                            if (welcomeTab) {
                                await browser.tabs.sendMessage(welcomeTab.id, {
                                    command: "welcome-reset-to-initial"
                                });
                                log("[Welcome] Reset message sent successfully");
                            }
                        } catch (msgError) {
                            // Message might fail if page still isn't ready - log and continue
                            log(`[Welcome] Could not send reset message: ${msgError.message}`, "warn");
                        }
                    }, 500);
                    // Reset guard flag before returning
                    _welcomeWizardCheckInProgress = false;
                    return;
                }
            } catch (findError) {
                log(`[Welcome] Error checking for existing welcome window: ${findError.message}`, "warn");
            }
            
            // No existing window found - create a new one
            log("[Welcome] First run detected - opening welcome wizard");
            try {
                await browser.windows.create({
                    url,
                    type: "popup",
                    width: welcomeWindowConfig.defaultWidth,
                    height: welcomeWindowConfig.defaultHeight,
                });
                log("[Welcome] Welcome wizard opened successfully");
            } catch (e) {
                log(`[Welcome] Failed to open welcome wizard: ${e.message}`, "error");
            }
        } else {
            log("[Welcome] Welcome wizard already completed, skipping");
        }
    } catch (e) {
        log(`[Welcome] Error checking welcome wizard status: ${e.message}`, "error");
    } finally {
        // Reset guard flag after a short delay to allow window creation to complete
        setTimeout(() => {
            _welcomeWizardCheckInProgress = false;
        }, 2000);
    }
}

/**
 * On first installation, run a full index to build the database.
 */
browser.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === "install" || details.reason === "update") {
        log("Installation or update detected. Configuring backend and starting initial scan.");
        await init();
        await enforceMailSyncPrefs();
        
        // Note: Welcome wizard is already checked in init(), no need to call again here
    }
});

// --- Listener for Style Update on Send ---
// This is now handled in modules/style.js

// --- Summary Sidebar Integration ---
// This is now handled in modules/summary.js

let _initOnce = false;

async function init() {
    if (_initOnce) {
        log("init() called again – already initialised. Skipping duplicate init.");
        return;
    }
    _initOnce = true;
    log("TabMail Agent initializing...");
    
    // Set default sort based on inbox size (before welcome wizard)
    // This needs to happen early so the welcome wizard shows the correct default
    // We do this asynchronously so it doesn't block initialization
    setDefaultSortForLargeInbox().catch(e => {
        log(`[Startup] Error setting default sort early: ${e}`, "warn");
    });
    
    // Check and show welcome wizard on initial load if not completed
    // (This handles reloads, not just fresh installs)
    checkAndShowWelcomeWizard();

    // 0. Activate the keyOverride experiment so key hooks are live early.
    try {
        if (browser.keyOverride && browser.keyOverride.init) {
            browser.keyOverride.init();
            log("[KeyOverride] Experiment initialised – Tab/Shift+Tab key capture active.");
        } else {
            log("[KeyOverride] Experiment NOT available – Tab actions disabled.", "warn");
        }
    } catch (e) {
        log(`[KeyOverride] Failed to initialise: ${e}`, "error");
    }

    // 0b. Activate threadTooltip experiment for hover tooltips in the message list, gated by config.
    try {
        if (SETTINGS.threadTooltipEnabled) {
            log("[ThreadTT] Enabled via config. Note: On MV3 suspend, tooltips may not fetch summary/todo properly.", "warn");
            if (browser.threadTooltip && browser.threadTooltip.init) {
                browser.threadTooltip.init();
                // log("[TMDBG ThreadTT] threadTooltip experiment initialised.");
            } else {
                // log("[TMDBG ThreadTT] threadTooltip experiment NOT available – hover tooltips disabled.");
            }
        } else {
            log("[ThreadTT] Disabled by config – experiment will not be initialised.");
        }
    } catch (e) {
        // log(`[TMDBG ThreadTT] Failed to initialise threadTooltip: ${e}`);
    }

    // 0c. Activate tagSort experiment for Date→Tags sorting in the message list.
    try {
        if (browser.tagSort && browser.tagSort.init) {
            browser.tagSort.init();
            // log("[TMDBG TagSort] tagSort experiment initialised.");
        } else {
            // log("[TMDBG TagSort] tagSort experiment NOT available – sorting enhancements disabled.");
        }
    } catch (e) {
        // log(`[TMDBG TagSort] Failed to initialise tagSort: ${e}`);
    }

    // 0c2. Override the built-in thread pane "display options" button to toggle relaxed vs compact view.
    // TB 145 / MV3: implemented via an experiment because WebExtension cannot touch this chrome UI.
    try {
        if (browser.threadPaneDisplayToggle && browser.threadPaneDisplayToggle.init) {
            browser.threadPaneDisplayToggle.init();
            log("[DisplayToggle] Experiment initialised – header display button now toggles relaxed/compact.");
        } else {
            log("[DisplayToggle] Experiment NOT available – header button unchanged.", "warn");
        }
    } catch (e) {
        // Important: include stack to avoid losing the source of InvalidStateError.
        log(`[DisplayToggle] Failed to initialise: ${e} stack=${e?.stack || "(no stack)"}`, "error");
    }

    // 0e. Attach tag by thread storage listener (effective tag by thread).
    // This is Inbox-only and updates all messages when toggled.
    try {
        attachTagByThreadListener();
    } catch (e) {
        log(`[TMDBG Tag] Failed to attach tag-by-thread listener: ${e}`, "warn");
    }

    // 0f. Attach thread tag watchers (keeps per-thread aggregate fresh and re-applies effective tag).
    try {
        attachThreadTagWatchers();
    } catch (e) {
        log(`[TMDBG Tag] Failed to attach thread tag watchers: ${e}`, "warn");
    }

    // 0d. Force unthreaded view for simpler email management (no thread collapsing).
    try {
        if (SETTINGS.forceUnthreadedView) {
            if (browser.tmPrefs?.setUnthreadedView) {
                const result = await browser.tmPrefs.setUnthreadedView(true);
                log(`[Unthreaded] setUnthreadedView result: ${JSON.stringify(result)}`, "warn");
            } else {
                log("[Unthreaded] tmPrefs.setUnthreadedView not available", "warn");
            }
        }
    } catch (e) {
        log(`[Unthreaded] Failed to set unthreaded view: ${e}`, "error");
    }

    // preMoveTag experiment removed; header reindexing handled elsewhere.

    // Previous backend required a /config POST; new relay server no longer needs runtime configuration.
    // Keeping this block removed avoids unnecessary network requests and CSP warnings.

    // 2. Initialise summary features early so UI pieces are ready while heavy background scanning continues.
    initSummaryFeatures();

    // 2a. Initialise persistent processMessage queue early so event-driven processing is retryable.
    try {
        await initProcessMessageQueue();
        log("[TMDBG PMQ] processMessage persistent queue initialised");
    } catch (e) {
        log(`[TMDBG PMQ] Failed to init processMessage queue: ${e}`, "error");
    }

    // // 2a. Diagnostics – enumerate tmHdr namespace presence and methods
    // try {
    //     const hasTmHdr = !!(browser && browser.tmHdr);
    //     const tmKeys = hasTmHdr ? Object.keys(browser.tmHdr) : [];
    //     console.log(`[ReplyDetect] Init: tmHdr present? ${hasTmHdr} keys=[${tmKeys.join(',')}]`);
    //     const t1 = typeof (hasTmHdr && browser.tmHdr.getReplied);
    //     const t2 = typeof (hasTmHdr && browser.tmHdr.getFlags);
    //     const t3 = typeof (hasTmHdr && browser.tmHdr.getRepliedBulk);
    //     console.log(`[ReplyDetect] Init: typeof getReplied=${t1} getFlags=${t2} getRepliedBulk=${t3}`);
    // } catch (e) {
    //     console.log(`[ReplyDetect] Init: tmHdr introspection error: ${e}`);
    // }

    // 2a. Register right-click context menus for per-message cache operations.
    try {
        initContextMenus();
        // log("[TMDBG ContextMenus] Right-click context menus initialised.");
    } catch (e) {
        // log(`[TMDBG ContextMenus] Failed to initialise context menus: ${e}`);
    }

    // 2b. Listen for Tab key events via experiment API (delegated to modules/tabKey.js)
    registerTabKeyHandlers();

    // 3. Register manual compose handlers and thread tooltip handlers.
    initComposeHandlers();
    
    if (SETTINGS.threadTooltipEnabled) {
        attachThreadTooltipHandlers();
    } else {
        log("[ThreadTT] Disabled by config – handlers not attached.");
    }

    // 4. Manual move/delete listeners (classification + logging only)
    attachOnMovedListeners();


    // 0a. Reset auth state and update toolbar icon based on authentication state
    try {
        const { resetAuthState, isLoggedIn } = await import("./modules/supabaseAuth.js");
        // Clear any stale re-auth flags from previous sessions
        resetAuthState();
        const loggedIn = await isLoggedIn();
        await updateIconBasedOnAuthState(loggedIn);
    } catch (e) {
        log(`[TMDBG Icon] Failed to update toolbar icon based on auth state: ${e}`, "error");
        // On error, assume not logged in for safety
        await updateIconBasedOnAuthState(false).catch(() => {});
    }

    // 5. Periodic scan removed - messages are now processed directly via onNewMailReceived,
    //    onMoved, and onCopied event listeners. Only initial startup scan is needed.

    // 6. Initial scan on startup. Skip if a compose window is already open.
    const initialComposeOpen = isAnyComposeOpen();
    log(`[Startup] Initial scan check - compose windows open: ${initialComposeOpen}`);
    
    if (!initialComposeOpen) {
        log("[Startup] No compose windows detected, starting initial inbox scan");
        await scanAllInboxes();
        log("[Startup] Initial inbox scan completed");
        
        // 6b. Set default sort option based on inbox size (before archive prompt check)
        log("[Startup] Setting default sort option based on inbox size...");
        await setDefaultSortForLargeInbox();
        
        // 6c. Check if we should show the archive prompt for large inboxes (one-time)
        log("[Startup] Checking if inbox archive prompt should be shown...");
        await checkAndShowArchivePrompt();
    } else {
        log("[Startup] Compose window detected at startup – deferring initial inbox scan.", "warn");
    }

    // 7. Clean up old reminder storage (from deprecated reminderGenerator.js)
    try {
        const oldKeys = ["reminder_motd_list"];
        const stored = await browser.storage.local.get(oldKeys);
        const keysToRemove = oldKeys.filter(k => stored[k] !== undefined);
        if (keysToRemove.length > 0) {
            await browser.storage.local.remove(keysToRemove);
            log(`[Startup] Cleaned up ${keysToRemove.length} old reminder storage keys: ${keysToRemove.join(", ")}`);
        }
    } catch (e) {
        log(`[Startup] Failed to clean up old reminder storage: ${e}`, "warn");
    }

    // 7b. Purge expired snippet cache entries on startup (IDB maintenance)
    try {
        const { purgeExpiredSnippets } = await import("../theme/modules/snippetCache.js");
        const purged = await purgeExpiredSnippets();
        if (purged > 0) {
            log(`[Startup] Purged ${purged} expired snippet cache entries`);
        }
    } catch (e) {
        log(`[Startup] Failed to purge expired snippet cache: ${e}`, "warn");
    }

    // 8. Generate KB reminders on startup (lightweight, only KB content)
    log("[Startup] Generating KB reminders...");
    try {
        const { generateKBReminders } = await import("./modules/kbReminderGenerator.js");
        await generateKBReminders(false); // Use hash check
        log("[Startup] KB reminder generation completed");
    } catch (e) {
        log(`[Startup] Failed to generate KB reminders: ${e}`, "warn");
    }

    // 9. Auto-detect default calendar based on user's email accounts (if not already set)
    await autoDetectDefaultCalendar();

    // 10. Start periodic inbox scan (DISABLED - replaced by tagSort row coloring coverage)
    // The tagSort experiment now detects untagged inbox messages during the row coloring pass
    // and fires an event to MV3 which enqueues them for processing. This provides complete
    // coverage without periodic polling overhead.
    startPeriodicInboxScan(); // Will no-op when intervalMs <= 0

}

/**
 * Auto-detect and set default calendar based on user's email accounts.
 * Only runs if no default is already set. Matches calendar organizer_email to account emails.
 */
async function autoDetectDefaultCalendar() {
    try {
        const { defaultCalendarId } = await browser.storage.local.get({ defaultCalendarId: null });
        
        // If already set, nothing to do
        if (defaultCalendarId) {
            log(`[AutoDetect] Default calendar already set: ${defaultCalendarId}`);
            return;
        }
        
        // Check if tmCalendar API is available
        if (!browser?.tmCalendar?.getCalendars) {
            log("[AutoDetect] tmCalendar API not available, skipping calendar auto-detection");
            return;
        }
        
        const result = await browser.tmCalendar.getCalendars();
        if (!result?.ok || !result?.calendars || result.calendars.length === 0) {
            log("[AutoDetect] No calendars found, skipping auto-detection");
            return;
        }
        
        // Get user's email accounts
        const accounts = await browser.accounts.list();
        const accountEmails = new Set();
        for (const account of accounts) {
            if (account.identities) {
                for (const identity of account.identities) {
                    if (identity.email) {
                        accountEmails.add(identity.email.toLowerCase());
                    }
                }
            }
        }
        
        if (accountEmails.size === 0) {
            log("[AutoDetect] No email accounts found, skipping calendar auto-detection");
            return;
        }
        
        log(`[AutoDetect] Found ${accountEmails.size} account email(s): ${[...accountEmails].join(", ")}`);
        
        // Find a writable calendar that matches one of the user's account emails
        const writableCalendars = result.calendars.filter(cal => !cal.readOnly);
        const matchingCal = writableCalendars.find(cal => 
            cal.organizer_email && accountEmails.has(cal.organizer_email.toLowerCase())
        );
        
        if (matchingCal) {
            await browser.storage.local.set({ defaultCalendarId: matchingCal.id });
            log(`[AutoDetect] Auto-selected default calendar based on account: ${matchingCal.name} (${matchingCal.organizer_email})`);
        } else {
            log("[AutoDetect] No calendar matched user accounts - user must configure manually");
        }
    } catch (e) {
        log(`[AutoDetect] Failed to auto-detect default calendar: ${e}`, "warn");
    }
}

// Tab key handlers moved to modules/tabKey.js

// Compose tracking moved to modules/composeTracker.js

// Kick-off initialisation immediately, but let onInstalled fall back to it if this load
// happened before the event fires.
init();

// --- Commands wiring ---
// Note: perform-tag-action command removed; Tab key is now the primary trigger via keyOverride experiment.
// Keeping this block for future command additions if needed.

// --- Cleanup on Extension Shutdown ---
// Handle extension disable/uninstall by cleaning up experiments
if (typeof browser !== 'undefined' && browser.runtime) {
  // This fires when the extension is being disabled, uninstalled, or reloaded
  browser.runtime.onSuspend?.addListener(() => {
    log("Extension suspending - cleaning up experiments and listeners");
    try {
      cleanupContextMenus();
    } catch (e) {
      log(`Error during context menus cleanup: ${e}`, "error");
    }
    try {
      // Disabled per MV3 suspend behavior: keep experiments active so their
      // parent-process listeners continue to generate events that can wake
      // the background worker (e.g., tooltip hover, chat hotkey).
      // if (browser.keyOverride?.shutdown) browser.keyOverride.shutdown();
      // if (browser.threadTooltip?.shutdown) browser.threadTooltip.shutdown();
      // if (browser.tagSort?.shutdown) browser.tagSort.shutdown();
    } catch (e) {
      log(`Error during experiment cleanup: ${e}`, "error");
    }
    
    try {
      cleanupRuntimeListeners();
    } catch (e) {
      log(`Error during runtime listener cleanup: ${e}`, "error");
    }
    
    try {
      // Cleanup module-level runtime listeners (async to handle dynamic imports)
      (async () => {
        try {
          const { cleanupThreadTooltipHandlers } = await import("./modules/threadTooltip.js");
          cleanupThreadTooltipHandlers();
          // Also cleanup move/delete/copied listeners
          try { cleanupOnMovedListeners(); } catch (e) { log(`Error cleaning onMoved/onDeleted/onCopied listeners: ${e}`, "warn"); }
          
          // Cleanup config storage listener
          try {
            const { cleanupConfigListeners } = await import("./modules/config.js");
            cleanupConfigListeners();
          } catch (e) { log(`Error cleaning config listeners: ${e}`, "warn"); }
          
          // Cleanup tag action key listeners
          try {
            const { cleanupTagActionKeyListeners } = await import("./modules/tagActionKey.js");
            cleanupTagActionKeyListeners();
          } catch (e) { log(`Error cleaning tag action key listeners: ${e}`, "warn"); }

          // Cleanup tag by thread listener
          try {
            cleanupTagByThreadListener();
          } catch (e) { log(`Error cleaning tag-by-thread listener: ${e}`, "warn"); }

          // Cleanup thread tag watchers
          try {
            cleanupThreadTagWatchers();
          } catch (e) { log(`Error cleaning thread tag watchers: ${e}`, "warn"); }
          
          // Cleanup compose tracker listeners
          try {
            const { cleanupComposeTrackerListeners } = await import("./modules/composeTracker.js");
            cleanupComposeTrackerListeners();
          } catch (e) { log(`Error cleaning compose tracker listeners: ${e}`, "warn"); }
          
          log("Module listener cleanup completed");
        } catch (e) {
          log(`Error during module listener cleanup: ${e}`, "error");
        }
      })();
    } catch (e) {
      log(`Error during module listener cleanup setup: ${e}`, "error");
    }
    
    try {
      // Cleanup inbox activity listeners (onNewMailReceived, onMoved, onCopied)
      cleanupInboxActivityListeners();
    } catch (e) {
      log(`Error during inbox activity listener cleanup: ${e}`, "error");
    }
    
    try {
      // Cleanup account created listener (for welcome wizard)
      cleanupAccountCreatedListener();
    } catch (e) {
      log(`Error during account created listener cleanup: ${e}`, "error");
    }
    
    try {
      // Cleanup getFull cache timer from utils.js (async to handle dynamic imports)
      (async () => {
        try {
          const { stopGetFullCacheCleanup } = await import("./modules/utils.js");
          stopGetFullCacheCleanup();
          
          log("getFull cache cleanup completed");
        } catch (e) {
          log(`Error during getFull cache cleanup: ${e}`, "error");
        }
      })();
    } catch (e) {
      log(`Error during getFull cache cleanup setup: ${e}`, "error");
    }

    // Clear any pending cache cleanup timer
    try {
      cleanupCacheCleanupTimer();
    } catch (_) {}
    
    // Clear any pending reminder generation timers
    try {
      (async () => {
        try {
          const { cleanupReminderGeneration } = await import("./modules/reminderGenerator.js");
          cleanupReminderGeneration();
          log("Cleared reminder generation timers on suspend");
        } catch (e) {
          log(`Error clearing reminder timers: ${e}`, "warn");
        }
      })();
    } catch (_) {}

    // Stop periodic inbox scan
    try {
      stopPeriodicInboxScan();
    } catch (_) {}

    // Cleanup persistent processMessage queue timers (and persist remaining items)
    try {
      (async () => {
        try {
          const { cleanupProcessMessageQueue } = await import("./modules/messageProcessorQueue.js");
          await cleanupProcessMessageQueue();
          log("[TMDBG PMQ] processMessage queue cleaned up on suspend");
        } catch (e) {
          log(`[TMDBG PMQ] Error cleaning up processMessage queue: ${e}`, "warn");
        }
      })();
    } catch (_) {}
    
    // Reset initialization flag so init() can run again after wake-up
    _initOnce = false;
    log("Extension suspend cleanup complete, _initOnce flag reset");
  });
}

// Tooltip handlers moved to modules/threadTooltip.js