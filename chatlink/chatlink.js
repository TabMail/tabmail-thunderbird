/**
 * ChatLink - WhatsApp Messaging Bridge for TabMail Chat (Chat Window Side)
 *
 * This module runs in the chat window context. The background script maintains
 * the Realtime WebSocket connection and forwards messages here for processing.
 *
 * Flow:
 * 1. Background receives message via Supabase Realtime
 * 2. Background forwards to chat window via runtime.sendMessage
 * 3. This module processes the message through converse.js
 * 4. Response is relayed back to WhatsApp via background → worker
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { log } from "../agent/modules/utils.js";
import { ctx } from "../chat/modules/context.js";
import { renderToPlainText } from "../chat/modules/helpers.js";

// Config
const CHATLINK_CONFIG = {
  workerUrl: "https://chatlink-dev.tabmail.ai",
};

// ChatLink state
let chatLinkEnabled = false;
let linkedPlatform = null;

/**
 * Initialize ChatLink module in chat window.
 * Sets up message listener and processes any pending messages.
 */
export async function initChatLink() {
  try {
    // Always set up listener first (before async storage check) to avoid race conditions
    browser.runtime.onMessage.addListener(handleBackgroundMessage);
    log(`[ChatLink] Message listener registered`);

    // Check if ChatLink is enabled
    const stored = await browser.storage.local.get([
      "chatlink_enabled",
      "chatlink_platform",
    ]);
    chatLinkEnabled = stored.chatlink_enabled === true;
    linkedPlatform = stored.chatlink_platform || null;

    if (!chatLinkEnabled || !linkedPlatform) {
      log(`[ChatLink] Not enabled or no platform linked`);
      return;
    }

    log(`[ChatLink] Initializing chat window integration for ${linkedPlatform}`);

    // Check for pending message (set by background when chat window was closed)
    await processPendingMessage();

    log(`[ChatLink] Chat window integration ready`);
  } catch (e) {
    log(`[ChatLink] Init failed: ${e}`, "error");
  }
}

/**
 * Handle message from background script
 */
function handleBackgroundMessage(message, sender, sendResponse) {
  if (message.type === "chatlink_inbound") {
    log(`[ChatLink] Received inbound message from background`);
    // Process the inbound WhatsApp message
    handleInboundMessage(message.message).catch(e => {
      log(`[ChatLink] Failed to handle inbound message: ${e}`, "error");
    });
    return true; // Async response
  }
  return false;
}

/**
 * Process any pending message stored by background
 */
async function processPendingMessage() {
  try {
    const stored = await browser.storage.local.get(["chatlink_pending_message"]);
    const pending = stored.chatlink_pending_message;

    if (pending && pending.text) {
      log(`[ChatLink] Found pending message: ${pending.text.substring(0, 50)}...`);

      // Clear the pending message
      await browser.storage.local.remove(["chatlink_pending_message"]);

      // Process it
      await handleInboundMessage(pending);
    }
  } catch (e) {
    log(`[ChatLink] Failed to process pending message: ${e}`, "warn");
  }
}

/**
 * Handle inbound message from WhatsApp (via background)
 */
async function handleInboundMessage(message) {
  try {
    const { id, text, platform, platformChatId, timestamp, callbackData } = message;

    log(`[ChatLink] Processing message from ${platform}: ${text.substring(0, 50)}...`);

    // Store source info in ctx for response routing
    ctx.chatLinkSource = {
      source: "chatlink",
      replyTo: id,
      platform,
      platformChatId,
      callbackData,
      timestamp,
    };

    // Import UI functions dynamically to avoid circular dependency
    const { createNewUserBubble } = await import("../chat/chat.js");
    const { processUserInput } = await import("../chat/modules/converse.js");

    // Create user bubble in chat UI (matching normal input flow)
    createNewUserBubble(text);

    // Set chat mode to stop (matching normal input flow)
    if (window.setChatMode) {
      window.setChatMode("stop");
    }

    // Process through LLM
    await processUserInput(text, {
      source: "chatlink",
      replyTo: id,
      platform,
      platformChatId,
    });
  } catch (e) {
    log(`[ChatLink] Failed to handle inbound message: ${e}`, "error");
  }
}

/**
 * Relay assistant response to external platform.
 * Called from converse.js after getAgentResponse completes.
 *
 * @param {string} assistantText - The assistant's response text
 * @param {Object} options - Optional parameters
 * @param {Array<{label: string, data: string}>} options.buttons - FSM buttons
 * @param {string} options.fsmPid - FSM process ID
 * @param {boolean} options.isIntermediate - Whether this is an intermediate FSM message
 */
export async function relayResponse(assistantText, options = {}) {
  if (!ctx.chatLinkSource) {
    return; // Not a ChatLink message
  }

  const { replyTo, platform, platformChatId } = ctx.chatLinkSource;
  const { buttons, fsmPid, isIntermediate } = options;

  try {
    // Render markdown and resolve entity references (reuses FTS chat history rendering)
    const resolvedText = await renderToPlainText(assistantText);

    // Get access token
    const { getAccessToken } = await import("../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();

    if (!accessToken) {
      log(`[ChatLink] No access token, cannot relay response`);
      return;
    }

    const response = await fetch(`${CHATLINK_CONFIG.workerUrl}/chatlink/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        reply_to: replyTo,
        text: resolvedText,
        platform,
        platform_chat_id: platformChatId,
        buttons: buttons || null,
        fsm_pid: fsmPid || null,
        is_intermediate: isIntermediate || false,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorBody}`);
    }

    log(`[ChatLink] Response relayed to ${platform}`);

    // Clear source after final response (not intermediate)
    if (!isIntermediate) {
      ctx.chatLinkSource = null;
    }
  } catch (e) {
    log(`[ChatLink] Failed to relay response: ${e}`, "error");
  }
}

/**
 * Relay FSM intermediate prompt with buttons.
 *
 * @param {string} text - The prompt text
 * @param {Array<{label: string, data: string}>} buttons - Button options (max 3)
 * @param {string} fsmPid - FSM process ID
 */
export async function relayFsmPrompt(text, buttons, fsmPid) {
  return relayResponse(text, { buttons, fsmPid, isIntermediate: true });
}

/**
 * Cleanup on chat window close
 */
export async function disconnectChatLink() {
  try {
    browser.runtime.onMessage.removeListener(handleBackgroundMessage);
    ctx.chatLinkSource = null;
    log(`[ChatLink] Chat window integration disconnected`);
  } catch (e) {
    log(`[ChatLink] Disconnect error: ${e}`, "warn");
  }
}

/**
 * Check if ChatLink is enabled
 */
export function isChatLinkConnected() {
  return chatLinkEnabled;
}

/**
 * Get ChatLink status for UI
 */
export async function getChatLinkStatus() {
  const stored = await browser.storage.local.get([
    "chatlink_enabled",
    "chatlink_platform",
    "chatlink_connection_status",
    "chatlink_connection_error",
  ]);

  return {
    enabled: stored.chatlink_enabled === true,
    platform: stored.chatlink_platform || null,
    connectionStatus: stored.chatlink_connection_status || "disconnected",
    connectionError: stored.chatlink_connection_error || null,
  };
}

// Privacy warning required at linking time (from CHAT_LINK.md Section 10)
const CHATLINK_PRIVACY_WARNING = `ChatLink relays your messages between WhatsApp and Thunderbird. Your messages and TabMail's responses — which may include email content — pass through Meta's servers. Meta may store this data per their privacy policy. TabMail never stores your email content nor chat contents on our servers.`;

/**
 * Generate a linking code to connect WhatsApp.
 * Returns the code, instructions, and REQUIRED privacy warning.
 *
 * IMPORTANT: The privacy_warning MUST be shown to the user before they proceed
 * with linking. This is a requirement from the design doc (CHAT_LINK.md Section 10).
 *
 * @returns {Promise<{ok: boolean, code?: string, wa_link?: string, instructions?: string, privacy_warning?: string, expires_in?: number, error?: string}>}
 */
export async function generateLinkingCode() {
  try {
    const { getAccessToken } = await import("../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();

    if (!accessToken) {
      return { ok: false, error: "Not logged in" };
    }

    const response = await fetch(`${CHATLINK_CONFIG.workerUrl}/chatlink/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      log(`[ChatLink] Failed to generate code: ${data.error || response.status}`, "error");
      return { ok: false, error: data.error || data.message || "Failed to generate code" };
    }

    log(`[ChatLink] Generated linking code: ${data.code}`);
    return {
      ok: true,
      code: data.code,
      wa_link: data.wa_link,
      instructions: data.instructions,
      privacy_warning: CHATLINK_PRIVACY_WARNING,
      expires_in: data.expires_in,
    };
  } catch (e) {
    log(`[ChatLink] Generate code error: ${e}`, "error");
    return { ok: false, error: e.message };
  }
}

/**
 * Enable ChatLink after linking.
 * Call this after user successfully links a platform.
 *
 * @param {string} platform - The platform that was linked (e.g., 'whatsapp')
 */
export async function enableChatLink(platform) {
  try {
    await browser.storage.local.set({
      chatlink_enabled: true,
      chatlink_platform: platform,
    });

    chatLinkEnabled = true;
    linkedPlatform = platform;

    // Background script will automatically connect when it sees storage change
    log(`[ChatLink] Enabled for ${platform}`);
  } catch (e) {
    log(`[ChatLink] Failed to enable: ${e}`, "error");
  }
}

/**
 * Disable ChatLink after unlinking.
 */
export async function disableChatLink() {
  try {
    await disconnectChatLink();

    await browser.storage.local.set({
      chatlink_enabled: false,
      chatlink_platform: null,
    });

    chatLinkEnabled = false;
    linkedPlatform = null;

    // Background script will automatically disconnect when it sees storage change
    log(`[ChatLink] Disabled`);
  } catch (e) {
    log(`[ChatLink] Failed to disable: ${e}`, "error");
  }
}

// Cleanup on page unload
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    disconnectChatLink();
  });

  // Expose for dev testing (remove before production)
  // Usage: await window._chatlink.generateCode()
  window._chatlink = {
    generateCode: generateLinkingCode,
    enable: enableChatLink,
    disable: disableChatLink,
    status: getChatLinkStatus,
  };
}
