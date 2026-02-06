/**
 * ChatLink - WhatsApp Messaging Bridge for TabMail Chat
 *
 * Connects to Supabase Realtime to receive messages from WhatsApp,
 * feeds them into the chat system, and relays responses back.
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { log } from "../agent/modules/utils.js";
import { ctx } from "./modules/context.js";

// Supabase Realtime state
let supabaseClient = null;
let realtimeChannel = null;
let isConnected = false;

// ChatLink state
let chatLinkEnabled = false;
let linkedPlatform = null;
let userId = null;

// Config (loaded from settings or defaults)
const CHATLINK_CONFIG = {
  supabaseUrl: "https://rnclwzcuplqlasphskuc.supabase.co",
  // chatlink-dev.tabmail.ai for dev, chatlink.tabmail.ai for prod
  workerUrl: "https://chatlink-dev.tabmail.ai",
};

/**
 * Initialize ChatLink module.
 * Call this after user is authenticated and chat is ready.
 */
export async function initChatLink() {
  try {
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

    log(`[ChatLink] Initializing for platform: ${linkedPlatform}`);

    // Connect to Supabase Realtime
    await connectRealtime();
  } catch (e) {
    log(`[ChatLink] Init failed: ${e}`, "error");
  }
}

/**
 * Connect to Supabase Realtime channel for receiving messages.
 */
async function connectRealtime() {
  try {
    // Get session from auth module
    const { getSession } = await import("../agent/modules/supabaseAuth.js");
    const session = await getSession();

    if (!session?.access_token) {
      log(`[ChatLink] No session, cannot connect to Realtime`);
      return;
    }

    // Decode JWT to get user ID
    try {
      const payload = JSON.parse(atob(session.access_token.split(".")[1]));
      userId = payload.sub;
    } catch {
      log(`[ChatLink] Failed to decode JWT`, "error");
      return;
    }

    // Use Supabase client from CDN (loaded in chat.html)
    if (!window.supabase) {
      log(`[ChatLink] Supabase client not loaded`, "error");
      return;
    }

    supabaseClient = window.supabase.createClient(
      CHATLINK_CONFIG.supabaseUrl,
      // Use anon key for Realtime (it will use the JWT for auth)
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJuY2x3emN1cGxxbGFzcGhza3VjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzc4MjM3NzQsImV4cCI6MjA1MzM5OTc3NH0.k-Jj4-VZv2b89Mj9wA8tQ4kGQwF3fYvNxLRRGlbPPpM",
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
        global: {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        },
      }
    );

    // Subscribe to user's ChatLink channel
    const channelName = `chatlink:${userId}`;
    log(`[ChatLink] Subscribing to channel: ${channelName}`);

    realtimeChannel = supabaseClient
      .channel(channelName, {
        config: { presence: { key: userId } },
      })
      .on("broadcast", { event: "message" }, handleInboundMessage)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          isConnected = true;
          log(`[ChatLink] Connected to Realtime channel`);

          // Track presence to signal TB is online
          realtimeChannel.track({ online: true, connected_at: Date.now() });
        } else if (status === "CHANNEL_ERROR") {
          isConnected = false;
          log(`[ChatLink] Realtime connection error`, "error");
        } else if (status === "CLOSED") {
          isConnected = false;
          log(`[ChatLink] Realtime channel closed`);
        }
      });
  } catch (e) {
    log(`[ChatLink] Failed to connect Realtime: ${e}`, "error");
  }
}

/**
 * Handle inbound message from external platform (via Supabase Realtime broadcast).
 */
async function handleInboundMessage(event) {
  try {
    const payload = event.payload;
    const { id, text, platform, platform_chat_id, timestamp, callback_data } =
      payload;

    log(
      `[ChatLink] Received message from ${platform}: ${text.substring(0, 50)}...`
    );

    // Store source info in ctx for response routing
    ctx.chatLinkSource = {
      source: "chatlink",
      replyTo: id,
      platform,
      platformChatId: platform_chat_id,
      callbackData: callback_data,
      timestamp,
    };

    // Import processUserInput dynamically to avoid circular dependency
    const { processUserInput } = await import("./modules/converse.js");

    // Feed into converse.js - this creates DOM bubbles and processes through LLM
    await processUserInput(text, {
      source: "chatlink",
      replyTo: id,
      platform,
      platformChatId: platform_chat_id,
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
        text: assistantText,
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
 * Disconnect from Realtime (cleanup).
 */
export async function disconnectChatLink() {
  try {
    if (realtimeChannel && supabaseClient) {
      await supabaseClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
    isConnected = false;
    ctx.chatLinkSource = null;
    log(`[ChatLink] Disconnected`);
  } catch (e) {
    log(`[ChatLink] Disconnect error: ${e}`, "warn");
  }
}

/**
 * Check if ChatLink is currently connected.
 */
export function isChatLinkConnected() {
  return isConnected && chatLinkEnabled;
}

/**
 * Get ChatLink status for UI.
 */
export function getChatLinkStatus() {
  return {
    enabled: chatLinkEnabled,
    platform: linkedPlatform,
    connected: isConnected,
  };
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

    // Connect to Realtime
    await connectRealtime();

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
}
