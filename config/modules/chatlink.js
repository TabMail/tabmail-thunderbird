/**
 * ChatLink Configuration Module
 * Handles WhatsApp linking UI in the settings page
 */

import { $ } from "./dom.js";
import { getChatLinkUrl } from "../../chatlink/modules/config.js";

let expiryInterval = null;
let expiryEndTime = null;
let linkPollInterval = null;

/**
 * Load ChatLink status and update UI.
 * Fetches from backend to ensure accuracy, syncs to local storage.
 */
export async function loadChatLinkStatus() {
  try {
    // First check local storage for fast initial render
    const stored = await browser.storage.local.get([
      "chatlink_enabled",
      "chatlink_platform",
    ]);

    // Update UI from local storage first
    updateChatLinkUI(stored.chatlink_enabled && stored.chatlink_platform === "whatsapp");

    // Then fetch from backend to ensure accuracy
    const { getAccessToken } = await import("../../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();

    if (!accessToken) {
      // Not logged in - can't check backend
      return;
    }

    const workerUrl = await getChatLinkUrl();
    const response = await fetch(`${workerUrl}/chatlink/link`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.ok) {
      const data = await response.json();

      // Sync local storage with backend
      if (data.linked) {
        await browser.storage.local.set({
          chatlink_enabled: true,
          chatlink_platform: data.platform || "whatsapp",
        });
        updateChatLinkUI(true, data.phone_hint);
      } else {
        await browser.storage.local.set({
          chatlink_enabled: false,
          chatlink_platform: null,
        });
        updateChatLinkUI(false);
      }
    }
  } catch (e) {
    console.error("[ChatLink Config] Failed to load status:", e);
  }
}

/**
 * Update ChatLink UI elements.
 */
function updateChatLinkUI(connected, phoneHint = null) {
  const statusEl = $("whatsapp-status");
  const btnEl = $("whatsapp-link-btn");

  if (connected) {
    statusEl.textContent = phoneHint ? `Connected (${phoneHint})` : "Connected";
    statusEl.classList.add("connected");
    btnEl.textContent = "Disconnect";
    btnEl.classList.add("disconnect");
  } else {
    statusEl.textContent = "Not connected";
    statusEl.classList.remove("connected");
    btnEl.textContent = "Connect";
    btnEl.classList.remove("disconnect");
  }
}

/**
 * Show the WhatsApp linking dialog
 */
export function showWhatsAppDialog() {
  const dialog = $("whatsapp-link-dialog");
  const codeDisplay = $("whatsapp-link-code-display");
  const instructions = $("whatsapp-link-instructions");
  const generateBtn = $("whatsapp-generate-code-btn");
  const messageEl = $("whatsapp-link-message");
  const copyBtn = $("whatsapp-copy-btn");

  // Reset state
  codeDisplay.style.display = "none";
  instructions.style.display = "block";
  generateBtn.style.display = "inline-block";
  generateBtn.disabled = false;
  generateBtn.textContent = "Generate Code";
  messageEl.style.color = "";

  // Reset copy button
  copyBtn.classList.remove("copied");
  copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

  dialog.style.display = "block";
}

/**
 * Hide the WhatsApp linking dialog
 */
export function hideWhatsAppDialog() {
  const dialog = $("whatsapp-link-dialog");
  dialog.style.display = "none";

  // Clear expiry timer
  if (expiryInterval) {
    clearInterval(expiryInterval);
    expiryInterval = null;
  }

  // Clear link poll timer
  if (linkPollInterval) {
    clearInterval(linkPollInterval);
    linkPollInterval = null;
  }
}

/**
 * Generate a linking code via the ChatLink worker
 */
export async function generateWhatsAppLinkCode() {
  const generateBtn = $("whatsapp-generate-code-btn");
  const codeDisplay = $("whatsapp-link-code-display");
  const instructions = $("whatsapp-link-instructions");
  const codeEl = $("whatsapp-link-code");
  const expiresEl = $("whatsapp-link-expires");
  const messageEl = $("whatsapp-link-message");
  const waLinkEl = $("whatsapp-link-wa-link");
  const phoneEl = $("whatsapp-phone-number");
  const phoneDisplayEl = $("whatsapp-phone-display");
  const copyBtn = $("whatsapp-copy-btn");

  generateBtn.disabled = true;
  generateBtn.textContent = "Generating...";

  try {
    // Get access token from supabaseAuth
    const { getAccessToken } = await import("../../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();

    if (!accessToken) {
      throw new Error("Not logged in. Please sign in first.");
    }

    const workerUrl = await getChatLinkUrl();
    const response = await fetch(`${workerUrl}/chatlink/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.message || "Failed to generate code");
    }

    // Store full message for copy functionality
    const fullMessage = `START ${data.code}`;

    // Show the full START CODE message
    codeEl.textContent = fullMessage;
    instructions.style.display = "none";
    codeDisplay.style.display = "block";
    generateBtn.style.display = "none";

    // Show phone number prominently
    if (data.wa_phone_display) {
      phoneEl.textContent = data.wa_phone_display;
      phoneDisplayEl.style.display = "flex";
      messageEl.textContent = "Or tap the button below to open WhatsApp directly";
    } else {
      phoneDisplayEl.style.display = "none";
      messageEl.textContent = data.instructions;
    }

    // Set up copy button
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(fullMessage);
        copyBtn.classList.add("copied");
        // Show checkmark briefly
        copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
        }, 1500);
      } catch (err) {
        console.error("[ChatLink Config] Copy failed:", err);
      }
    };

    // Show wa.me link if available
    if (data.wa_link) {
      waLinkEl.href = data.wa_link;
      waLinkEl.style.display = "inline-block";
    } else {
      waLinkEl.style.display = "none";
    }

    // Start expiry countdown
    expiryEndTime = Date.now() + (data.expires_in * 1000);
    updateExpiryDisplay(expiresEl);
    expiryInterval = setInterval(() => updateExpiryDisplay(expiresEl), 1000);

    // Start polling for link completion (every 3 seconds)
    startLinkPolling(accessToken);

  } catch (e) {
    console.error("[ChatLink Config] Failed to generate code:", e);

    // Handle "already_linked" - user is connected but local storage wasn't synced
    if (e.message === "already_linked") {
      // Sync local storage
      await browser.storage.local.set({
        chatlink_enabled: true,
        chatlink_platform: "whatsapp",
      });

      // Update UI and close dialog
      await loadChatLinkStatus();
      hideWhatsAppDialog();

      // Show success message (could use a toast, but alert works)
      console.log("[ChatLink Config] Already connected - synced local state");
      return;
    }

    generateBtn.disabled = false;
    generateBtn.textContent = "Generate Code";
    messageEl.textContent = `Error: ${e.message}`;
    messageEl.style.color = "var(--tag-tm-delete)";
    codeDisplay.style.display = "block";
    instructions.style.display = "none";
  }
}

/**
 * Update the expiry countdown display
 */
function updateExpiryDisplay(expiresEl) {
  const remaining = Math.max(0, expiryEndTime - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  expiresEl.textContent = `${minutes}:${seconds.toString().padStart(2, "0")}`;

  if (remaining <= 0) {
    clearInterval(expiryInterval);
    expiryInterval = null;
    expiresEl.textContent = "Expired";
    expiresEl.style.color = "var(--tag-tm-delete)";

    // Stop polling when code expires
    if (linkPollInterval) {
      clearInterval(linkPollInterval);
      linkPollInterval = null;
    }
  }
}

/**
 * Start polling for link completion.
 * Checks every 3 seconds if the user has linked their WhatsApp.
 */
async function startLinkPolling(accessToken) {
  // Clear any existing poll
  if (linkPollInterval) {
    clearInterval(linkPollInterval);
  }

  const pollForLink = async () => {
    try {
      const workerUrl = await getChatLinkUrl();
      const response = await fetch(`${workerUrl}/chatlink/link`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.ok) {
        const data = await response.json();

        if (data.linked) {
          // Link successful! Update state and close dialog
          console.log("[ChatLink Config] Link detected via polling");

          await browser.storage.local.set({
            chatlink_enabled: true,
            chatlink_platform: data.platform || "whatsapp",
          });

          // Stop polling
          clearInterval(linkPollInterval);
          linkPollInterval = null;

          // Update UI and close dialog
          updateChatLinkUI(true, data.phone_hint);
          hideWhatsAppDialog();
        }
      }
    } catch (e) {
      console.warn("[ChatLink Config] Poll error (non-fatal):", e);
    }
  };

  // Poll every 3 seconds
  linkPollInterval = setInterval(pollForLink, 3000);
}

/**
 * Disconnect WhatsApp
 */
export async function disconnectWhatsApp() {
  try {
    // Get access token
    const { getAccessToken } = await import("../../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();

    if (accessToken) {
      // Call the unlink endpoint
      const workerUrl = await getChatLinkUrl();
      await fetch(`${workerUrl}/chatlink/link`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ platform: "whatsapp" }),
      });
    }

    // Clear local state regardless
    await browser.storage.local.set({
      chatlink_enabled: false,
      chatlink_platform: null,
    });

    // Update UI
    await loadChatLinkStatus();

    console.log("[ChatLink Config] WhatsApp disconnected");
  } catch (e) {
    console.error("[ChatLink Config] Failed to disconnect:", e);
  }
}

/**
 * Handle WhatsApp connect/disconnect button click.
 * Uses UI state (which is synced with backend) to determine action.
 */
export async function handleWhatsAppButtonClick() {
  const btnEl = $("whatsapp-link-btn");

  // Check if button shows "Disconnect" (means connected state)
  if (btnEl.classList.contains("disconnect")) {
    // Already connected - disconnect
    if (confirm("Disconnect WhatsApp from TabMail?")) {
      await disconnectWhatsApp();
    }
  } else {
    // Not connected - show linking dialog
    showWhatsAppDialog();
  }
}
