// chat/background.js – background script to open chat window
// Thunderbird 140 MV3 compatible.

import { log } from "../agent/modules/utils.js";
import { initFtsEngine } from "../fts/engine.js";
import { CHAT_SETTINGS } from "./modules/chatConfig.js";
import { openOrFocusChatWindow } from "./modules/chatWindowUtils.js";
import { handleMessageSelectionRequest, initMessageSelectionListener } from "./modules/messageSelection.js";

// Navigation handlers for special TabMail links
// --- EMAIL: precise MV3 navigation to a message in thread pane ---
async function getExistingMail3PaneTabOrNull() {
  try {
    if (browser.mailTabs?.query) {
      const mailTabs = await browser.mailTabs.query({});
      if (mailTabs && mailTabs.length) {
        // TB 145: MailTab objects use tabId (not id). Handle both shapes.
        const mt = mailTabs[0];
        const tabId = typeof mt?.id === "number" ? mt.id : (typeof mt?.tabId === "number" ? mt.tabId : null);
        if (typeof tabId !== "number") {
          log(`[Chat Background] mailTabs.query returned MailTab without id/tabId: ${JSON.stringify(mt)}`, "warn");
          return null;
        }
        // Convert MailTab -> normal Tab object (for focus/activation)
        return await browser.tabs.get(tabId);
      }
    }
  } catch (_) {}
  return null; // No mail tab available
}

async function focusTab(tab) {
  try {
    if (tab.windowId) await browser.windows.update(tab.windowId, { focused: true });
    await browser.tabs.update(tab.id, { active: true });
  } catch (_) {}
}

async function handleOpenEmailInThread(message) {
  try {
    const { weID } = message;
    if (typeof weID !== "number") {
      return { ok: false, error: "weID (numeric WebExtension message id) required" };
    }

    log(`[Chat Background] Opening email in conversation: weID: ${weID}`);

    const header = await browser.messages.get(weID);
    if (!header || !header.folder) {
      return { ok: false, error: "Message or folder not found" };
    }

    // Try to use an existing 3-pane
    let mailTab = await getExistingMail3PaneTabOrNull();
    
    // If no mail tab exists, create one.
    // NOTE (TB 145): mailTabs.create() does not accept { active: false }.
    if (!mailTab) {
      try {
        log(`[Chat Background] No existing mail tab found; creating mail tab for conversation open`);
        if (browser.mailTabs?.create) {
          const newMailTab = await browser.mailTabs.create();
          // Log what we got back to help debugging
          try {
            log(`[Chat Background] mailTabs.create returned: ${JSON.stringify(newMailTab)}`);
          } catch (_) {
            log(`[Chat Background] mailTabs.create returned: ${newMailTab}`);
          }

          // TB 145: prefer using returned tabId so we don't race mailTabs.query.
          const createdTabId =
            typeof newMailTab?.id === "number" ? newMailTab.id :
            (typeof newMailTab?.tabId === "number" ? newMailTab.tabId : null);
          if (typeof createdTabId === "number") {
            try {
              mailTab = await browser.tabs.get(createdTabId);
              log(`[Chat Background] Using created mail tab: tabId=${createdTabId} windowId=${mailTab?.windowId}`);
            } catch (eGet) {
              log(`[Chat Background] Failed to browser.tabs.get(createdTabId=${createdTabId}): ${eGet}`, "warn");
            }
          } else {
            log(`[Chat Background] mailTabs.create result missing id/tabId; will retry mailTabs.query`, "warn");
            await new Promise(r => setTimeout(r, 200));
            mailTab = await getExistingMail3PaneTabOrNull();
            if (mailTab) {
              log(`[Chat Background] Found mail tab after create via query: tabId=${mailTab.id} windowId=${mailTab.windowId}`);
            } else {
              log(`[Chat Background] Created mail tab but couldn't find it via query`, "error");
            }
          }
        } else {
          log(`[Chat Background] mailTabs.create not available`, "warn");
        }
      } catch (eCreate) {
        log(`[Chat Background] Failed to create mail tab: ${eCreate}`, "error");
        // Fall through to try fallback approach
      }
    }

    if (mailTab) {
      // Do NOT focus the window. We only activate the tab in its own window so the
      // command controller resolves selection correctly.
      try {
        await browser.tabs.update(mailTab.id, { active: true });
      } catch (eFocus) {
        log(`[Chat Background] Failed to activate mail tab: ${eFocus}`, "warn");
      }

      // Select the message (conversation open works off selection).
      // NOTE (TB 145): mailTabs.update does not accept displayedFolder in this build,
      // so we rely on setSelectedMessages (which is sufficient in practice).

      try {
        await browser.mailTabs.setSelectedMessages(mailTab.id, [header.id]);
        log(`[Chat Background] Set selected message to: ${header.id}`);
        
        // Wait a bit for selection to settle before triggering the conversation command.
        await new Promise(r => setTimeout(r, 200));
        
        // Open "message in conversation" via experiment, targeting THIS windowId.
        if (browser.messageSelection?.openConversationInWindow && typeof mailTab.windowId === "number") {
          log(`[Chat Background] Attempting conversation open in windowId=${mailTab.windowId} tabId=${mailTab.id}...`);
          const convoRes = await browser.messageSelection.openConversationInWindow(mailTab.windowId);
          log(`[Chat Background] Conversation open result: ${JSON.stringify(convoRes)}`);
          if (convoRes && convoRes.ok) {
            return { ok: true };
          }
          return { ok: false, error: convoRes?.error || "Conversation open failed" };
        }

        log(`[Chat Background] openConversationInWindow API not available or mailTab.windowId missing`, "error");
        return { ok: false, error: "openConversationInWindow unavailable" };
      } catch (eSelect) {
        log(`[Chat Background] Failed to set selected messages: ${eSelect}`, "error");
        return { ok: false, error: eSelect?.message || String(eSelect) };
      }
    }

    // No fallbacks here: user specifically wants "open in conversation".
    log(`[Chat Background] No mail tab available (and create failed) - cannot open conversation`, "error");
    return { ok: false, error: "No mail tab available for conversation open" };
  } catch (e) {
    log(`[Chat Background] Error opening email in conversation: ${e}`, "error");
    return { ok: false, error: e?.message || String(e) };
  }
}

// Contact and Calendar events are now tooltip-only (no click navigation)
// These handlers are kept for compatibility but return a message indicating tooltip-only mode
async function handleOpenContactInAddressBook(message) {
  try {
    const { contactId } = message;
    log(`[Chat Background] Contact click received for ${contactId} - tooltip-only mode`);
    return { ok: true, message: "Contact information available in tooltip only" };
  } catch (e) {
    log(`[Chat Background] Error handling contact click: ${e}`, "error");
    return { ok: false, error: e.message };
  }
}

async function handleOpenCalendarEvent(message) {
  try {
    const { calendarId, eventId } = message;
    log(`[Chat Background] Calendar event click received for ${calendarId}:${eventId} - tooltip-only mode`);
    return { ok: true, message: "Calendar event information available in tooltip only" };
  } catch (e) {
    log(`[Chat Background] Error handling calendar event click: ${e}`, "error");
    return { ok: false, error: e.message };
  }
}

// openChatWindow is now imported from chatWindowUtils.js as openOrFocusChatWindow

// FTS Initial Scan Management
// Storage key for tracking initial scan completion
const FTS_INITIAL_SCAN_KEY = "fts_initial_scan_complete";
const FTS_SCAN_STATUS_KEY = "fts_scan_status";

// Check and run initial FTS scan if needed
async function checkAndRunInitialFtsScan() {
  try {
    // Check if initial scan is enabled in config
    if (!CHAT_SETTINGS.ftsInitialScanEnabled) {
      log("[TMDBG FTS] Initial scan disabled by config");
      return;
    }
    
    const stored = await browser.storage.local.get(FTS_INITIAL_SCAN_KEY);
    if (stored[FTS_INITIAL_SCAN_KEY]) {
      log("[TMDBG FTS] Initial scan already completed");
      return;
    }
    
    log("[TMDBG FTS] Initial scan not yet complete, starting smart reindex");
    await runInitialFtsScan();
  } catch (e) {
    log(`[TMDBG FTS] Error checking initial scan status: ${e}`, "error");
  }
}

// Run the initial FTS scan
async function runInitialFtsScan() {
  try {
    // Set status to indicate scan is in progress
    await browser.storage.local.set({
      [FTS_SCAN_STATUS_KEY]: {
        isScanning: true,
        scanType: "initial",
        startTime: Date.now(),
        progress: {
          folder: "",
          totalIndexed: 0,
          totalBatches: 0
        }
      }
    });
    
    log("[TMDBG FTS] Starting initial smart reindex");
    
    // Progress callback to update status
    const progressCallback = async (progress) => {
      await browser.storage.local.set({
        [FTS_SCAN_STATUS_KEY]: {
          isScanning: true,
          scanType: "initial",
          startTime: Date.now(),
          progress: {
            folder: progress.folder || "",
            totalIndexed: progress.totalIndexed || 0,
            totalBatches: progress.totalBatches || 0
          }
        }
      });
    };
    
    // Import and run the indexer directly
    const { ftsSearch } = await import("../fts/engine.js");
    const { indexMessages } = await import("../fts/indexer.js");
    
    // Run smart reindex with progress callback
    const result = await indexMessages(ftsSearch, progressCallback);
    
    log(`[TMDBG FTS] Initial scan completed: ${result.indexed} messages in ${result.batches} batches`);
    
    // Mark initial scan as complete
    await browser.storage.local.set({
      [FTS_INITIAL_SCAN_KEY]: true,
      [FTS_SCAN_STATUS_KEY]: {
        isScanning: false,
        scanType: "none",
        lastCompleted: Date.now()
      }
    });
    
    log("[TMDBG FTS] Initial scan marked as complete");
  } catch (e) {
    log(`[TMDBG FTS] Initial scan failed: ${e}`, "error");
    
    // Clear scanning status on error, but don't mark as complete so it will retry
    await browser.storage.local.set({
      [FTS_SCAN_STATUS_KEY]: {
        isScanning: false,
        scanType: "error",
        error: e.message,
        lastError: Date.now()
      }
    });
    
    // Retry after a delay (configurable, default 5 minutes)
    const retryDelay = CHAT_SETTINGS.ftsInitialScanRetryDelayMs || 300000;
    setTimeout(async () => {
      const stored = await browser.storage.local.get(FTS_INITIAL_SCAN_KEY);
      if (!stored[FTS_INITIAL_SCAN_KEY]) {
        log(`[TMDBG FTS] Retrying initial scan after error delay (${retryDelay}ms)`);
        await runInitialFtsScan();
      }
    }, retryDelay);
  }
}

// Get current FTS scan status (for popup and other UI)
async function getFtsScanStatus() {
  try {
    const stored = await browser.storage.local.get([FTS_SCAN_STATUS_KEY, FTS_INITIAL_SCAN_KEY]);
    const initialComplete = stored[FTS_INITIAL_SCAN_KEY] || false;
    const status = stored[FTS_SCAN_STATUS_KEY] || { isScanning: false, scanType: "none" };
    
    return {
      initialComplete,
      ...status
    };
  } catch (e) {
    log(`[TMDBG FTS] Error getting scan status: ${e}`, "error");
    return { initialComplete: false, isScanning: false, scanType: "none" };
  }
}

// Initialize FTS engine FIRST (before other listeners) if enabled
browser.storage.local.get({ chat_useFtsSearch: true }).then(async (stored) => {
  if (stored.chat_useFtsSearch) {
    try {
      await initFtsEngine();
      log("[TMDBG Chat] FTS engine initialization started (priority listener)");
      try {
        const stats = await browser.runtime.sendMessage({
          type: "fts",
          cmd: "stats",
        });
        log(`[TMDBG SnippetDiag][BG] [TMDBG Chat] FTS stats on init ${JSON.stringify(stats || {})}`);
      } catch (eStats) {
        log(`[TMDBG SnippetDiag][BG] [TMDBG Chat] FTS stats on init failed: ${eStats}`, "warn");
      }
      try {
        const hostInfo = await browser.runtime.sendMessage({
          type: "fts",
          cmd: "getHostInfo",
        });
        log(`[TMDBG SnippetDiag][BG] [TMDBG Chat] FTS host info on init ${JSON.stringify(hostInfo || {})}`);
      } catch (eHost) {
        log(`[TMDBG SnippetDiag][BG] [TMDBG Chat] FTS host info on init failed: ${eHost}`, "warn");
      }
      try {
        const scanStatus = await browser.runtime.sendMessage({
          type: "fts",
          cmd: "getInitialScanStatus",
        });
        log(`[TMDBG SnippetDiag][BG] [TMDBG Chat] FTS scan status on init ${JSON.stringify(scanStatus || {})}`);
      } catch (eScan) {
        log(`[TMDBG SnippetDiag][BG] [TMDBG Chat] FTS scan status on init failed: ${eScan}`, "warn");
      }
      
      // Check if we need to run initial scan
      await checkAndRunInitialFtsScan();
    } catch (e) {
      log(`[TMDBG Chat] FTS engine initialization failed: ${e}`, "error");
    }
  } else {
    log("[TMDBG Chat] FTS disabled by config");
  }
}).catch(e => {
  log(`[TMDBG Chat] Failed to load FTS setting: ${e}`, "error");
});

// Initialize selection listener on startup
initMessageSelectionListener();

// Store runtime message listener reference for cleanup
let chatRuntimeMessageListener = null;
let chatHotkeyListener = null;
let chatCommandsListener = null;

/**
 * Remove any existing runtime message listener to prevent accumulation on reload
 */
function cleanupRuntimeListeners() {
  if (chatRuntimeMessageListener) {
    try {
      browser.runtime.onMessage.removeListener(chatRuntimeMessageListener);
      chatRuntimeMessageListener = null;
      log("Chat runtime message listener cleaned up");
    } catch (e) {
      log(`Failed to remove chat runtime message listener: ${e}`, "error");
    }
  }
}

/**
 * Setup runtime message listener with proper cleanup tracking
 */
function setupRuntimeMessageListener() {
  // Clean up any existing listener first
  cleanupRuntimeListeners();
  
  // Chat listener handles ONLY chat-specific commands and MUST NOT interfere with agent commands
  // Forward only chat messages to avoid returning a Promise for unrelated messages.
  // For non-chat messages, do nothing so other listeners can respond.
  chatRuntimeMessageListener = (message) => {
    // Only handle messages that are specifically for chat functionality
    if (message && message.command === "open-chat-window") {
      try {
        openOrFocusChatWindow(); // Don't await - fire and forget
        return { ok: true };
      } catch (e) {
        log(`[Chat Background] Failed to open chat window: ${e}`, "error");
        return { ok: false, error: e.message };
      }
    }
    
    // Handle message selection requests using the dedicated module
    const selectionResponse = handleMessageSelectionRequest(message);
    if (selectionResponse !== undefined) {
      return selectionResponse;
    }
    
    // FTS commands are now handled by engine.js attachCommandInterface()
    // Don't handle FTS messages here - let engine.js handle them
    
    // Handle FTS scan status requests
    if (message && message.command === "getFtsScanStatus") {
      try {
        return getFtsScanStatus();
      } catch (e) {
        log(`[Chat Background] Failed to get FTS scan status: ${e}`, "error");
        return { ok: false, error: e.message };
      }
    }
    
    // Handle special TabMail navigation commands
    if (message && message.command === "openEmailInThread") {
      try {
        return handleOpenEmailInThread(message);
      } catch (e) {
        log(`[Chat Background] Failed to open email in thread: ${e}`, "error");
        return { ok: false, error: e.message };
      }
    }
    
    if (message && message.command === "openContactInAddressBook") {
      try {
        return handleOpenContactInAddressBook(message);
      } catch (e) {
        log(`[Chat Background] Failed to open contact in address book: ${e}`, "error");
        return { ok: false, error: e.message };
      }
    }
    
    if (message && message.command === "openCalendarEvent") {
      try {
        return handleOpenCalendarEvent(message);
      } catch (e) {
        log(`[Chat Background] Failed to open calendar event: ${e}`, "error");
        return { ok: false, error: e.message };
      }
    }
    
    // Handle Thunderbird restart request (for FTS migration)
    if (message && message.type === "restart-thunderbird") {
      try {
        log("[Chat Background] Restart requested - Thunderbird doesn't support programmatic restart");
        // Thunderbird doesn't have a restart API, so we just acknowledge
        // The user will need to restart manually
        return { ok: true, message: "Please restart Thunderbird manually" };
      } catch (e) {
        log(`[Chat Background] Failed to handle restart request: ${e}`, "error");
        return { ok: false, error: e.message };
      }
    }

    // FTS config is now handled directly by config.js using browser.storage.local
    // No runtime message handlers needed!
    
    // No return here for non-chat messages - let other listeners handle them
  };
  
  // Register the listener
  browser.runtime.onMessage.addListener(chatRuntimeMessageListener);
  log("Chat runtime message listener setup complete");
}

// Initialize the runtime message listener AFTER FTS engine
// Small delay to ensure FTS listener is attached first
// THIS MUST NEVER BE CHANGED!
setTimeout(() => {
  setupRuntimeMessageListener();
}, 100);

// --- Hotkey integration via keyOverride experiment ---
function setupChatHotkeyListener() {
  try {
    if (!CHAT_SETTINGS?.openChatHotkeyEnabled) {
      log("[TMDBG Chat] Chat hotkey disabled by config");
      return;
    }
    if (!browser.keyOverride || !browser.keyOverride.onChatHotkey) {
      log("[TMDBG Chat] keyOverride.onChatHotkey not available");
      return;
    }
    if (chatHotkeyListener) {
      try { browser.keyOverride.onChatHotkey.removeListener(chatHotkeyListener); } catch (_) {}
      chatHotkeyListener = null;
    }
    chatHotkeyListener = async () => {
      try {
        log("[TMDBG Chat] onChatHotkey event received – opening chat window");
        await openOrFocusChatWindow();
      } catch (e) {
        log(`[TMDBG Chat] Failed to handle chat hotkey: ${e}`, "error");
      }
    };
    browser.keyOverride.onChatHotkey.addListener(chatHotkeyListener);
    log("[TMDBG Chat] Chat hotkey listener registered");
  } catch (e) {
    log(`[TMDBG Chat] Failed to setup chat hotkey listener: ${e}`, "error");
  }
}

setupChatHotkeyListener();

// --- MV3 Commands integration (preferred over experiment) ---
function setupChatCommandsListener() {
  try {
    if (!browser.commands || !browser.commands.onCommand) {
      log("[TMDBG Chat] commands API not available", "warn");
      return;
    }
    if (chatCommandsListener) {
      try { browser.commands.onCommand.removeListener(chatCommandsListener); } catch (_) {}
      chatCommandsListener = null;
    }
    chatCommandsListener = async (command) => {
      try {
        if (command === "open-chat-window") {
          log("[TMDBG Chat] commands.onCommand=open-chat-window – opening chat window");
          await openOrFocusChatWindow();
        }
      } catch (e) {
        log(`[TMDBG Chat] Failed handling commands.onCommand: ${e}`, "error");
      }
    };
    browser.commands.onCommand.addListener(chatCommandsListener);
    log("[TMDBG Chat] commands.onCommand listener registered for open-chat-window");
  } catch (e) {
    log(`[TMDBG Chat] Failed to setup commands listener: ${e}`, "error");
  }
}

setupChatCommandsListener();

// NOTE: ChatLink Realtime connection is now handled in chatlink/background.js

// --- Extension Install/Update Handler ---
// Handle extension install/update to trigger initial FTS scan
if (typeof browser !== 'undefined' && browser.runtime) {
  browser.runtime.onInstalled?.addListener(async (details) => {
    log(`[TMDBG Chat] Extension installed/updated: ${details.reason}`);
    
    // Trigger initial FTS scan on fresh install
    if (details.reason === 'install') {
      log("[TMDBG Chat] Fresh install detected, will run initial FTS scan");
      // The scan will be triggered by checkAndRunInitialFtsScan() during engine init
    }
    
    // On update, check if initial scan was completed
    if (details.reason === 'update') {
      log("[TMDBG Chat] Extension updated, checking initial FTS scan status");
      const stored = await browser.storage.local.get(FTS_INITIAL_SCAN_KEY);
      if (!stored[FTS_INITIAL_SCAN_KEY]) {
        log("[TMDBG Chat] Initial FTS scan not complete after update, will continue");
        // The scan will be triggered by checkAndRunInitialFtsScan() during engine init
      }
    }
  });
}

// --- Cleanup on Extension Shutdown ---
// Handle extension disable/uninstall by cleaning up experiments
if (typeof browser !== 'undefined' && browser.runtime) {
  // This fires when the extension is being disabled, uninstalled, or reloaded
  browser.runtime.onSuspend?.addListener(async () => {
    log("Chat extension suspending - cleaning up experiments and listeners");
    try {
      if (browser.messageSelection?.shutdown) browser.messageSelection.shutdown();
    } catch (e) {
      log(`Error during chat experiment cleanup: ${e}`, "error");
    }
    
    try {
      // Cleanup message selection listener
      const { cleanupMessageSelectionListener } = await import("./modules/messageSelection.js");
      cleanupMessageSelectionListener();
    } catch (e) {
      log(`Error during message selection listener cleanup: ${e}`, "error");
    }
    
    try {
      if (CHAT_SETTINGS.useFtsSearch) {
        const { disposeFtsEngine } = await import("../fts/engine.js");
        await disposeFtsEngine();
      }
    } catch (e) {
      log(`Error during FTS cleanup: ${e}`, "error");
    }
    
    try {
      cleanupRuntimeListeners();
    } catch (e) {
      log(`Error during runtime listener cleanup: ${e}`, "error");
    }
    try {
      if (browser.keyOverride?.onChatHotkey && chatHotkeyListener) {
        browser.keyOverride.onChatHotkey.removeListener(chatHotkeyListener);
        chatHotkeyListener = null;
        log("[TMDBG Chat] Chat hotkey listener removed");
      }
      // No location hotkey to clean up
    } catch (e) {
      log(`Error during chat hotkey listener cleanup: ${e}`, "error");
    }
    try {
      if (browser.commands?.onCommand && chatCommandsListener) {
        browser.commands.onCommand.removeListener(chatCommandsListener);
        chatCommandsListener = null;
        log("[TMDBG Chat] commands.onCommand listener removed");
      }
    } catch (e) {
      log(`Error during commands listener cleanup: ${e}`, "error");
    }

    try {
      stopChatLinkPolling();
      log("[TMDBG Chat] ChatLink background polling stopped");
    } catch (e) {
      log(`Error during ChatLink polling cleanup: ${e}`, "error");
    }

    // Note: ID translation cache cleanup is handled per-chat-window in chat.js beforeunload
    // This ensures each window cleans up its own cache when closed
    log("[TMDBG Chat] Extension suspend cleanup completed");
  });
}
