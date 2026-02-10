import { $ } from "./dom.js";

/**
 * ChatLink debug functions for config page.
 */

/**
 * Update the ChatLink debug status display.
 */
export async function updateChatlinkStatusDisplay(log) {
  const statusIcon = $("chatlink-debug-icon");
  const statusText = $("chatlink-debug-text");

  if (!statusIcon || !statusText) return;

  try {
    const stored = await browser.storage.local.get({
      chatlink_enabled: false,
      chatlink_platform: null,
      chatlink_connection_status: "disconnected",
    });

    if (!stored.chatlink_enabled) {
      statusIcon.textContent = "⏸️";
      statusText.textContent = "Not enabled";
      statusText.style.color = "var(--text-color-secondary)";
    } else if (stored.chatlink_connection_status === "connected") {
      statusIcon.textContent = "✅";
      statusText.textContent = `Connected (${stored.chatlink_platform || "unknown"})`;
      statusText.style.color = "var(--tag-tm-reply)";
    } else if (stored.chatlink_connection_status === "connecting") {
      statusIcon.textContent = "⏳";
      statusText.textContent = "Connecting...";
      statusText.style.color = "var(--tag-tm-archive)";
    } else {
      statusIcon.textContent = "❌";
      statusText.textContent = `Disconnected (${stored.chatlink_connection_status})`;
      statusText.style.color = "var(--tag-tm-delete)";
    }

    log(`[TMDBG Config] ChatLink status: enabled=${stored.chatlink_enabled}, status=${stored.chatlink_connection_status}`);
  } catch (e) {
    console.warn("[TMDBG Config] updateChatlinkStatusDisplay failed", e);
    statusIcon.textContent = "❌";
    statusText.textContent = "Error checking status";
    statusText.style.color = "var(--tag-tm-delete)";
  }
}

/**
 * Send a test proactive nudge using the EXACT same flow as real reminder nudges.
 * This opens the chat window, displays the message there, and relays to WhatsApp if connected.
 */
export async function sendTestNudge(log) {
  const statusEl = $("status");

  try {
    statusEl.textContent = "Sending test nudge...";

    // Use the exact same flow as real proactive nudges
    const { sendTestProactiveNudge } = await import("../../agent/modules/proactiveCheckin.js");
    const success = await sendTestProactiveNudge();

    if (success) {
      statusEl.textContent = "Test nudge sent! Check chat window (and WhatsApp if connected).";
      log("[TMDBG Config] Test nudge sent successfully");
    } else {
      statusEl.textContent = "Failed to send test nudge. Check console for details.";
      log("[TMDBG Config] Test nudge failed");
    }
  } catch (e) {
    console.error("[TMDBG Config] sendTestNudge failed", e);
    statusEl.textContent = "Failed to send test nudge: " + e.message;
  }
}
