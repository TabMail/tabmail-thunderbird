/**
 * ChatLink Core - WhatsApp Messaging Bridge for TabMail Chat
 *
 * This module runs in the chat window context. The background script maintains
 * the WebSocket connection and forwards messages here for processing.
 *
 * Flow:
 * 1. Background receives message via Durable Object WebSocket
 * 2. Background forwards to chat window via runtime.sendMessage
 * 3. This module processes the message through converse.js
 * 4. Response is relayed back to WhatsApp via background → worker
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { log } from "../../agent/modules/utils.js";
import { getChatLinkUrl } from "./config.js";
import { ctx } from "../../chat/modules/context.js";
import { renderToPlainText } from "../../chat/modules/helpers.js";

// ChatLink state
let chatLinkEnabled = false;
let linkedPlatform = null;

/**
 * Get or create a persistent device ID for this TB installation.
 * Uses crypto.randomUUID() for cryptographically secure generation.
 * Stored in browser.storage.local (extension-scoped, secure).
 *
 * This ID is used for multi-device detection, NOT authentication.
 * JWT provides actual authentication for all API calls.
 *
 * @returns {Promise<string>} The device ID
 */
async function getDeviceId() {
  try {
    const stored = await browser.storage.local.get(["chatlink_device_id"]);

    if (stored.chatlink_device_id) {
      return stored.chatlink_device_id;
    }

    // Generate new cryptographically secure UUID
    const deviceId = crypto.randomUUID();

    // Persist for future sessions
    await browser.storage.local.set({ chatlink_device_id: deviceId });

    log(`[ChatLink] Generated new device ID: ${deviceId.substring(0, 8)}...`, 'debug');
    return deviceId;
  } catch (e) {
    log(`[ChatLink] Failed to get device ID: ${e}`, "warn");
    // Fallback to session-only ID (less ideal but functional)
    return crypto.randomUUID();
  }
}

/**
 * Initialize ChatLink module in chat window.
 * Sets up message listener and processes any pending messages.
 */
export async function initChatLink() {
  try {
    // Always set up listener first (before async storage check) to avoid race conditions
    browser.runtime.onMessage.addListener(handleBackgroundMessage);
    log(`[ChatLink] Message listener registered`, 'debug');

    // Check if ChatLink is enabled
    const stored = await browser.storage.local.get([
      "chatlink_enabled",
      "chatlink_platform",
    ]);
    chatLinkEnabled = stored.chatlink_enabled === true;
    linkedPlatform = stored.chatlink_platform || null;

    if (!chatLinkEnabled || !linkedPlatform) {
      log(`[ChatLink] Not enabled or no platform linked`, 'debug');
      return;
    }

    log(`[ChatLink] Initializing chat window integration for ${linkedPlatform}`, 'debug');

    // Check for pending message (set by background when chat window was closed)
    await processPendingMessage();

    log(`[ChatLink] Chat window integration ready`, 'debug');
  } catch (e) {
    log(`[ChatLink] Init failed: ${e}`, "error");
  }
}

/**
 * Handle message from background script
 */
function handleBackgroundMessage(message, sender, sendResponse) {
  if (message.type === "chatlink_inbound") {
    log(`[ChatLink] Received inbound message from background`, 'debug');
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
      log(`[ChatLink] Found pending message: ${pending.text.substring(0, 50)}...`, 'debug');

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
    log(`[ChatLink] handleInboundMessage received: ${JSON.stringify(message)}`, 'debug');

    // Handle both camelCase (from runtime.sendMessage) and snake_case (from pending storage)
    const id = message.id;
    const text = message.text;
    const platform = message.platform;
    const platformChatId = message.platformChatId || message.platform_chat_id;
    const timestamp = message.timestamp;
    const callbackData = message.callbackData || message.callback_data;

    log(`[ChatLink] Processing message from ${platform}: ${text?.substring(0, 50)}...`, 'debug');
    log(`[ChatLink] Extracted: id=${id}, platform=${platform}, platformChatId=${platformChatId}`, 'debug');

    // Check if agent is currently processing (in "stop" mode)
    // If so, interrupt and process this new message instead
    if (window.getChatMode && window.getChatMode() === "stop") {
      log(`[ChatLink] Interrupt detected - agent is processing, stopping current execution`, 'debug');
      if (window.stopExecution) {
        await window.stopExecution();
      }
    }

    // Store source info in ctx for response routing
    ctx.chatLinkSource = {
      source: "chatlink",
      replyTo: id,
      platform,
      platformChatId,
      callbackData,
      timestamp,
    };

    log(`[ChatLink] Set chatLinkSource: ${JSON.stringify(ctx.chatLinkSource)}`, 'debug');

    // Clear any pending suggestion (from FSM confirmation prompts)
    try {
      ctx.pendingSuggestion = null;
      if (window.tmHideSuggestion) {
        window.tmHideSuggestion();
      }
    } catch (_) {}

    // Import UI functions dynamically to avoid circular dependency
    const { createNewUserBubble } = await import("../../chat/chat.js");
    const { processUserInput } = await import("../../chat/modules/converse.js");

    // Create user bubble in chat UI (matching normal input flow)
    createNewUserBubble(text);

    // Set chat mode to stop (matching normal input flow)
    if (window.setChatMode) {
      window.setChatMode("stop");
    }

    // Clear the input box (in case there was text from suggestion)
    try {
      const input = document.getElementById("user-input");
      if (input) {
        input.value = "";
        input.textContent = "";
      }
    } catch (_) {}

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
 * @returns {Promise<boolean>} True if relay succeeded, false otherwise
 */
export async function relayResponse(assistantText, options = {}) {
  log(`[ChatLink] relayResponse called, chatLinkSource=${JSON.stringify(ctx.chatLinkSource)}`, 'debug');

  if (!ctx.chatLinkSource) {
    log(`[ChatLink] No chatLinkSource, skipping relay`, 'debug');
    return true; // Not a ChatLink message - considered success (nothing to relay)
  }

  const { replyTo, platform, platformChatId } = ctx.chatLinkSource;
  const { buttons, fsmPid, isIntermediate } = options;

  log(`[ChatLink] Relay params: replyTo=${replyTo}, platform=${platform}, platformChatId=${platformChatId}`, 'debug');

  try {
    // Render markdown and resolve entity references (reuses FTS chat history rendering)
    const resolvedText = await renderToPlainText(assistantText);

    log(`[ChatLink] Resolved text length: ${resolvedText?.length || 0}, first 100 chars: ${(resolvedText || "").substring(0, 100)}`, 'debug');

    // Validate required fields before sending
    if (!resolvedText) {
      log(`[ChatLink] ERROR: resolvedText is empty/null`, "error");
      return false;
    }
    if (!platform) {
      log(`[ChatLink] ERROR: platform is empty/null`, "error");
      return false;
    }
    if (!platformChatId) {
      log(`[ChatLink] ERROR: platformChatId is empty/null`, "error");
      return false;
    }

    // Get access token
    const { getAccessToken } = await import("../../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();

    if (!accessToken) {
      log(`[ChatLink] No access token, cannot relay response`, 'debug');
      return false;
    }

    const requestBody = {
      reply_to: replyTo,
      text: resolvedText,
      platform,
      platform_chat_id: platformChatId,
      buttons: buttons || null,
      fsm_pid: fsmPid || null,
      is_intermediate: isIntermediate || false,
    };

    log(`[ChatLink] Sending to worker: ${JSON.stringify(requestBody).substring(0, 500)}`, 'debug');

    const workerUrl = await getChatLinkUrl();
    const response = await fetch(`${workerUrl}/chatlink/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorBody}`);
    }

    log(`[ChatLink] Response relayed to ${platform}`, 'debug');

    // Clear source after final response (not intermediate)
    if (!isIntermediate) {
      ctx.chatLinkSource = null;
    }

    return true;
  } catch (e) {
    log(`[ChatLink] Failed to relay response: ${e}`, "error");
    return false;
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
 * Relay a status message (thinking, tool activity) to WhatsApp.
 * These are informational messages that don't expect a response.
 * Uses italic formatting for subtle appearance.
 *
 * @param {string} statusText - The status message (e.g., "Thinking...", "Searching emails...")
 * @returns {Promise<void>}
 */
export async function relayStatusMessage(statusText) {
  if (!isChatLinkMessage()) {
    return; // Not a ChatLink message
  }

  try {
    // Format as italic for subtle appearance
    const formattedText = `_${statusText}_`;

    // Use isIntermediate: true so it doesn't clear the source
    await relayResponse(formattedText, { isIntermediate: true });

    log(`[ChatLink] Status relayed: ${statusText}`, 'debug');
  } catch (e) {
    // Non-fatal - don't block UI for status relay failures
    log(`[ChatLink] Status relay failed (non-fatal): ${e}`, "warn");
  }
}

/**
 * Relay a proactive message (nudge) to WhatsApp.
 * Used for reminders and other TB-initiated messages.
 * Does NOT require an active chatLinkSource - the worker looks up the platform_chat_id.
 *
 * @param {string} text - The message text to send
 * @returns {Promise<boolean>} True if sent successfully
 */
export async function relayProactiveMessage(text) {
  try {
    // Check storage directly (module state may not be initialized in all contexts)
    const stored = await browser.storage.local.get([
      "chatlink_enabled",
      "chatlink_platform",
      "chatlink_relay_proactive",
    ]);
    const isEnabled = stored.chatlink_enabled === true && stored.chatlink_platform === "whatsapp";

    if (!isEnabled) {
      log(`[ChatLink] Proactive relay skipped - not enabled (storage check)`, 'debug');
      return false;
    }

    // Check if relay for proactive messages is enabled (default: true)
    if (stored.chatlink_relay_proactive === false) {
      log(`[ChatLink] Proactive relay skipped - relay setting disabled`, 'debug');
      return false;
    }

    const { getAccessToken } = await import("../../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();

    if (!accessToken) {
      log(`[ChatLink] Proactive relay skipped - no access token`, 'debug');
      return false;
    }

    // Render markdown to plain text for WhatsApp
    const { renderToPlainText } = await import("../../chat/modules/helpers.js");
    const resolvedText = await renderToPlainText(text);

    if (!resolvedText) {
      log(`[ChatLink] Proactive relay skipped - empty text after render`, 'debug');
      return false;
    }

    // Send to worker - platform_chat_id will be looked up from user's link
    const workerUrl = await getChatLinkUrl();
    const response = await fetch(`${workerUrl}/chatlink/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        text: resolvedText,
        platform: "whatsapp",
        // platform_chat_id intentionally omitted - worker looks it up
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      log(`[ChatLink] Proactive relay failed: HTTP ${response.status}: ${errorBody}`, "warn");
      return false;
    }

    log(`[ChatLink] Proactive message relayed to WhatsApp`, "debug");
    return true;
  } catch (e) {
    log(`[ChatLink] Proactive relay error: ${e}`, "warn");
    return false;
  }
}

/**
 * Cleanup on chat window close
 */
export async function disconnectChatLink() {
  try {
    browser.runtime.onMessage.removeListener(handleBackgroundMessage);
    ctx.chatLinkSource = null;
    log(`[ChatLink] Chat window integration disconnected`, "debug");
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
 * Check if current message is from ChatLink
 */
export function isChatLinkMessage() {
  return !!ctx.chatLinkSource;
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
    const { getAccessToken } = await import("../../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();

    if (!accessToken) {
      return { ok: false, error: "Not logged in" };
    }

    // Get persistent device ID for multi-device detection
    const deviceId = await getDeviceId();

    const workerUrl = await getChatLinkUrl();
    const response = await fetch(`${workerUrl}/chatlink/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ device_id: deviceId }),
    });

    const data = await response.json();

    if (!response.ok) {
      log(`[ChatLink] Failed to generate code: ${data.error || response.status}`, "error");
      return { ok: false, error: data.error || data.message || "Failed to generate code" };
    }

    log(`[ChatLink] Generated linking code: ${data.code}`, "debug");
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
    log(`[ChatLink] Enabled for ${platform}`, "debug");
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
    log(`[ChatLink] Disabled`, "debug");
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
