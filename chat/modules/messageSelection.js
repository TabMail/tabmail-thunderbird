// chat/modules/messageSelection.js - Message selection tracking and decoding
// Handles messageSelection experiment integration and generates unique IDs using centralized getUniqueMessageKey

import { resolveWeFolderFromXulUri } from "../../agent/modules/folderResolver.js";
import { log } from "../../agent/modules/utils.js";

// Store listener references for cleanup
let _onSelectionChangedListener = null;

/**
 * Generate unique ID for a message, preferring weMsgId when available
 * @param {Object} msg - Message info from experiment
 * @returns {Promise<string|null>} - Unique ID or null
 */
async function generateUniqueId(msg) {
  const { getUniqueMessageKey } = await import("../../agent/modules/utils.js");

  // Prefer weMsgId (WebExtension message ID) - direct lookup, no folder resolution needed
  if (msg.weMsgId) {
    try {
      const uniqueId = await getUniqueMessageKey(msg.weMsgId);
      if (uniqueId) return uniqueId;
    } catch (e) {
      log(`[MessageSelection] weMsgId lookup failed, falling back: ${e}`, "warn");
    }
  }

  // Fallback: use messageId + folderUri (requires folder resolution)
  if (msg.messageId && msg.folderUri !== undefined) {
    try {
      const weFolder = await resolveWeFolderFromXulUri(msg.folderUri);
      const uniqueId = await getUniqueMessageKey(msg.messageId, weFolder);
      if (uniqueId) return uniqueId;
    } catch (e) {
      log(`[MessageSelection] Fallback unique ID generation failed: ${e}`, "warn");
    }
  }

  return null;
}

/**
 * Handle selection change events from the experiment
 * @param {Object} selectionData - Raw selection data from experiment
 */
async function handleSelectionChange(selectionData) {
  console.log(`[MessageSelection-DEBUG] handleSelectionChange called with:`, selectionData);
  
  const selectedMessages = selectionData.selectedMessages || [];
  console.log(`[MessageSelection-DEBUG] selectedMessages count: ${selectedMessages.length}`);
  
  const uniqueIds = [];
  
  for (const msg of selectedMessages) {
    try {
      const uniqueId = await generateUniqueId(msg);
      if (uniqueId) {
        uniqueIds.push(uniqueId);
      }
    } catch (e) {
      log(`[MessageSelection] Failed to generate unique ID: ${e}`, "warn");
    }
  }
  
  // Forward unique IDs to all chat windows via runtime messaging
  console.log(`[MessageSelection] Forwarding ${selectedMessages.length} -> ${uniqueIds.length} unique IDs`);
  browser.runtime.sendMessage({
    command: "selection-changed",
    selectedMessageIds: uniqueIds,
    selectionCount: uniqueIds.length
  }).catch((e) => {
    // Ignore errors - chat window might not be open
    console.log(`[MessageSelection] Failed to forward to chat windows: ${e}`);
  });
}

/**
 * Handle current selection requests from chat windows
 * @returns {Promise<Object>} - Response object with success status
 */
async function handleCurrentSelectionRequest() {
  try {
    console.log(`[MessageSelection-DEBUG] handleCurrentSelectionRequest called`);
    // API readiness guard
    if (!browser.messageSelection?.getSelectedMessages) {
      console.log(`[MessageSelection-DEBUG] Experiment not ready`);
      return { ok: false, error: 'experiment not ready' };
    }
    
    const selectedMessagesJsonString = await browser.messageSelection.getSelectedMessages();
    
    // Parse the JSON string into an array of message objects
    let selectedMessages = [];
    try {
      selectedMessages = typeof selectedMessagesJsonString === "string" && selectedMessagesJsonString.length
        ? JSON.parse(selectedMessagesJsonString)
        : [];
    } catch (parseError) {
      log(`[MessageSelection] Failed to parse selection JSON: ${parseError}`, "error");
      return { ok: false, error: 'failed to parse selection data' };
    }
    
    const uniqueIds = [];
    
    for (const msg of selectedMessages) {
      try {
        const uniqueId = await generateUniqueId(msg);
        if (uniqueId) {
          uniqueIds.push(uniqueId);
        }
      } catch (e) {
        log(`[MessageSelection] Failed to generate unique ID: ${e}`, "warn");
      }
    }
    
    console.log(`[MessageSelection] Current selection: ${selectedMessages.length} -> ${uniqueIds.length} unique IDs`);
    
    // Send current selection to all chat windows
    browser.runtime.sendMessage({
      command: "current-selection",
      selectedMessageIds: uniqueIds,
      selectionCount: uniqueIds.length
    }).catch(() => {
      // Ignore errors - chat window might not be open
    });
    
    return { ok: true };
  } catch (e) {
    log(`[MessageSelection] Failed to get current selection: ${e}`, "error");
    return { ok: false, error: e.message };
  }
}

/**
 * Cleanup message selection listeners to prevent accumulation
 */
export function cleanupMessageSelectionListener() {
  if (_onSelectionChangedListener && browser.messageSelection?.onSelectionChanged) {
    try {
      browser.messageSelection.onSelectionChanged.removeListener(_onSelectionChangedListener);
      _onSelectionChangedListener = null;
      log("[MessageSelection] onSelectionChanged listener cleaned up");
    } catch (e) {
      log(`[MessageSelection] Failed to remove onSelectionChanged listener: ${e}`, "error");
    }
  }
}

/**
 * Initialize message selection experiment and listeners
 */
export async function initMessageSelectionListener() {
  // Clean up existing listener first
  cleanupMessageSelectionListener();
  
  try {
    // Initialize the experiment
    try {
      browser.messageSelection.init();
    } catch (e) {
      log(`[MessageSelection] messageSelection.init() failed:`, e, "error");
    }
    
    // Store listener reference
    _onSelectionChangedListener = handleSelectionChange;
    browser.messageSelection.onSelectionChanged.addListener(_onSelectionChangedListener);
  } catch (e) {
    log(`[MessageSelection] Failed to initialize message selection listener: ${e}`, "error");
  }
}

/**
 * Handle get-current-selection messages from chat windows
 * @param {Object} message - The message from runtime.onMessage
 * @returns {Promise<Object>|undefined} - Response object or undefined for non-selection messages
 */
export function handleMessageSelectionRequest(message) {
  if (message && message.command === "get-current-selection") {
    // Return async IIFE for this specific command only
    return handleCurrentSelectionRequest();
  }
  // Return undefined for non-selection messages so other listeners can handle them
  return undefined;
}
