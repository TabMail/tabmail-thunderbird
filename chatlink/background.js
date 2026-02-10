/**
 * ChatLink Background Script - WebSocket Connection
 *
 * Maintains WebSocket connection to ChatLink worker for receiving
 * WhatsApp messages. Uses simple JSON protocol over WebSocket.
 *
 * Background context avoids CSP restrictions that affect extension pages.
 *
 * Flow:
 * 1. Connect to ChatLink worker via WebSocket (dev: wss://chatlink-dev.tabmail.ai/ws, prod: wss://chatlink.tabmail.ai/ws)
 * 2. Authenticate with Supabase JWT token
 * 3. Receive broadcast messages from ChatLink worker
 * 4. Forward to chat window (if open) or open chat window
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { log } from "../agent/modules/utils.js";
import { getChatLinkUrl } from "./modules/config.js";
import { isChatWindowOpen, openOrFocusChatWindow } from "../chat/modules/chatWindowUtils.js";

// Config
const CHATLINK_CONFIG = {
  pingIntervalMs: 30000, // Send ping every 30 seconds
  reconnectDelayMs: 5000, // Reconnect after 5 seconds on disconnect
};

// Connection state
let socket = null;
let userId = null;
let connected = false;
let pingTimer = null;
let reconnectTimer = null;

/**
 * Update connection status in storage (for settings UI)
 * Status: "connected" | "connecting" | "disconnected" | "error"
 */
async function updateConnectionStatus(status, errorMessage = null) {
  try {
    await browser.storage.local.set({
      chatlink_connection_status: status,
      chatlink_connection_error: errorMessage,
      chatlink_connection_updated: Date.now(),
    });
    log(`[ChatLink BG] Connection status: ${status}${errorMessage ? ` (${errorMessage})` : ""}`);
  } catch (e) {
    log(`[ChatLink BG] Failed to update connection status: ${e}`, "warn");
  }
}

/**
 * Send ping to keep connection alive
 */
function sendPing() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "ping" }));
  }
}

/**
 * Handle incoming WebSocket message
 */
async function handleMessage(data) {
  try {
    const parsed = JSON.parse(data);

    switch (parsed.type) {
      case "connected":
        // Connection confirmed by server
        log(`[ChatLink BG] ✅ Connected as user ${parsed.userId?.substring(0, 8)}...`);
        updateConnectionStatus("connected");
        // Fetch any pending messages that arrived while disconnected
        fetchAndProcessPendingMessages();
        break;

      case "message":
        // Check for disconnect event (sent when user sends STOP from WhatsApp)
        if (parsed.message?.disconnect) {
          log(`[ChatLink BG] Received disconnect event: ${parsed.message.disconnect_reason}`);
          await handleRemoteDisconnect(parsed.message.disconnect_reason);
          break;
        }

        // Inbound message from WhatsApp
        if (parsed.message && parsed.message.text) {
          log(`[ChatLink BG] Received message: ${parsed.message.text.substring(0, 50)}...`);
          await handleInboundMessage(parsed.message);
        }
        break;

      case "pong":
        // Ping response - connection is healthy
        break;

      default:
        log(`[ChatLink BG] Unknown message type: ${parsed.type}`);
    }
  } catch (e) {
    log(`[ChatLink BG] Failed to parse message: ${e}`);
  }
}

// isChatWindowOpen and openOrFocusChatWindow are imported from chatWindowUtils.js

/**
 * Handle inbound message from WhatsApp
 * Either forwards to chat window or opens chat window
 */
async function handleInboundMessage(message) {
  const { id, text, platform, platform_chat_id, timestamp, callback_data } = message;

  log(`[ChatLink BG] Processing message from ${platform}: ${text.substring(0, 50)}...`);

  // Check if chat window is open
  const chatOpen = await isChatWindowOpen();

  if (chatOpen) {
    // Forward to chat window for display and processing
    log("[ChatLink BG] Chat window open, forwarding message");
    try {
      await browser.runtime.sendMessage({
        type: "chatlink_inbound",
        message: {
          id,
          text,
          platform,
          platformChatId: platform_chat_id,
          timestamp,
          callbackData: callback_data,
        },
      });
    } catch (e) {
      log(`[ChatLink BG] Failed to forward to chat window: ${e}`, "warn");
      // Fall through to open chat window
      await openChatWindowWithMessage(message);
    }
  } else {
    // Open chat window with pending message
    await openChatWindowWithMessage(message);
  }
}

/**
 * Open chat window and pass message via storage
 */
async function openChatWindowWithMessage(message) {
  log(`[ChatLink BG] Opening chat window to process message`);

  // Store the pending message for the chat window to pick up
  await browser.storage.local.set({
    chatlink_pending_message: message,
  });

  // Open the chat window - it will pick up the pending message on init
  await openOrFocusChatWindow();
}

/**
 * Handle remote disconnect (user sent STOP from WhatsApp).
 * Clears local state and closes WebSocket.
 */
async function handleRemoteDisconnect(reason) {
  log(`[ChatLink BG] Remote disconnect: ${reason}`);

  // Clear local ChatLink state
  await browser.storage.local.set({
    chatlink_enabled: false,
    chatlink_platform: null,
    chatlink_connection_status: "disconnected",
  });

  // Disconnect WebSocket (will not auto-reconnect since chatlink_enabled is now false)
  disconnect();

  log(`[ChatLink BG] ChatLink disabled due to remote disconnect`);
}

/**
 * Fetch and process any pending messages (from when disconnected)
 */
async function fetchAndProcessPendingMessages() {
  try {
    const { getAccessToken } = await import("../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();

    if (!accessToken) return;

    const workerUrl = await getChatLinkUrl();
    const response = await fetch(`${workerUrl}/chatlink/pending`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) return;

    const data = await response.json();

    if (!data.ok || !data.messages || data.messages.length === 0) {
      return;
    }

    log(`[ChatLink BG] Processing ${data.messages.length} pending message(s)`);

    for (const msg of data.messages) {
      await handleInboundMessage(msg);
    }

    // Clear pending after processing
    await fetch(`${workerUrl}/chatlink/pending`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    log(`[ChatLink BG] Pending fetch failed: ${e}`, "warn");
  }
}

/**
 * Check if ChatLink is enabled (user has linked WhatsApp)
 */
async function isChatLinkEnabled() {
  try {
    const stored = await browser.storage.local.get(["chatlink_enabled", "chatlink_platform"]);
    return stored.chatlink_enabled === true && stored.chatlink_platform === "whatsapp";
  } catch {
    return false;
  }
}

/**
 * Connect to ChatLink worker via WebSocket
 */
async function connect() {
  // Don't connect if already connected
  if (socket && socket.readyState === WebSocket.OPEN) {
    return;
  }

  // Check if ChatLink is enabled
  if (!(await isChatLinkEnabled())) {
    log("[ChatLink BG] Not enabled, skipping WebSocket connect");
    return;
  }

  // Get access token for authentication
  let accessToken;
  try {
    const { getAccessToken, getSession } = await import("../agent/modules/supabaseAuth.js");
    accessToken = await getAccessToken();

    if (!accessToken) {
      log("[ChatLink BG] No access token, cannot connect");
      return;
    }

    // Decode JWT to get user ID (for logging)
    const session = await getSession();
    if (session?.access_token) {
      const payload = JSON.parse(atob(session.access_token.split(".")[1]));
      userId = payload.sub;
    }
  } catch (e) {
    log(`[ChatLink BG] Failed to get access token: ${e}`);
    return;
  }

  log(`[ChatLink BG] Connecting to WebSocket for user ${userId?.substring(0, 8)}...`);
  updateConnectionStatus("connecting");

  // Build WebSocket URL with token for auth (convert https:// to wss://)
  const workerUrl = await getChatLinkUrl();
  const wsUrl = `${workerUrl.replace("https://", "wss://")}/ws?token=${encodeURIComponent(accessToken)}`;

  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      log("[ChatLink BG] ✅ WebSocket connected");
      connected = true;

      // Start ping interval
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(sendPing, CHATLINK_CONFIG.pingIntervalMs);
    };

    socket.onmessage = (event) => {
      handleMessage(event.data);
    };

    socket.onerror = (e) => {
      log(`[ChatLink BG] WebSocket error: ${e.type}`);
      updateConnectionStatus("error", "WebSocket connection error");
    };

    socket.onclose = (e) => {
      log(`[ChatLink BG] WebSocket closed: code=${e.code}, reason=${e.reason}`);
      connected = false;
      updateConnectionStatus("disconnected", e.reason || `Code: ${e.code}`);

      // Clear ping timer
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }

      // Schedule reconnect
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, CHATLINK_CONFIG.reconnectDelayMs);
      }
    };
  } catch (e) {
    log(`[ChatLink BG] WebSocket creation failed: ${e}`, "error");
    updateConnectionStatus("error", `Failed to create WebSocket: ${e.message}`);
  }
}

/**
 * Disconnect from WebSocket
 */
function disconnect() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
  connected = false;
  updateConnectionStatus("disconnected");
  log("[ChatLink BG] Disconnected from WebSocket");
}

// --- Initialization ---

// Start ChatLink WebSocket on extension load (after delay for auth init)
setTimeout(() => {
  connect();
}, 5000);

// Listen for storage changes to connect/disconnect when ChatLink is enabled/disabled
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.chatlink_enabled) {
    if (changes.chatlink_enabled.newValue) {
      log("[ChatLink BG] ChatLink enabled, connecting to WebSocket");
      connect();
    } else {
      log("[ChatLink BG] ChatLink disabled, disconnecting from WebSocket");
      disconnect();
    }
  }
});

// Export for potential use by other modules
export { connect, disconnect, isChatLinkEnabled };
