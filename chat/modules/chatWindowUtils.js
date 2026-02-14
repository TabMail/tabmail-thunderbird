/**
 * Chat Window Utilities
 *
 * Shared utilities for opening/focusing the chat window.
 * Used by chat/background.js, chatlink/background.js, and proactiveCheckin.js.
 */

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "./chatConfig.js";

/**
 * Check if the chat window is currently open.
 * @returns {Promise<boolean>} True if chat window is open
 */
export async function isChatWindowOpen() {
  try {
    const wins = await browser.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w && Array.isArray(w.tabs)) {
        const hasChat = w.tabs.some(
          (t) => t && typeof t.url === "string" && t.url.endsWith("/chat/chat.html")
        );
        if (hasChat) return true;
      }
    }
  } catch {
    // Ignore errors
  }
  return false;
}

/**
 * Focus the existing chat window if one exists.
 * @returns {Promise<boolean>} True if an existing window was focused, false if none found
 */
export async function focusChatWindow() {
  try {
    const wins = await browser.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w && Array.isArray(w.tabs)) {
        const hasChat = w.tabs.some(
          (t) => t && typeof t.url === "string" && t.url.endsWith("/chat/chat.html")
        );
        if (hasChat) {
          await browser.windows.update(w.id, { focused: true });
          log(`[ChatWindow] Focused existing chat window id=${w.id}`, 'debug');
          return true;
        }
      }
    }
  } catch (e) {
    log(`[ChatWindow] Failed to search existing chat windows: ${e}`, "warn");
  }
  return false;
}

/**
 * Open the chat window, focusing existing one if present.
 * This is the main entry point for opening chat windows.
 * @returns {Promise<void>}
 */
export async function openOrFocusChatWindow() {
  try {
    // Try to focus existing window first
    if (await focusChatWindow()) {
      return;
    }

    // No existing window, create new one
    const url = browser.runtime.getURL("chat/chat.html");
    const { defaultWidth, defaultHeight } = CHAT_SETTINGS.chatWindow;
    await browser.windows.create({
      url,
      type: "popup",
      width: defaultWidth,
      height: defaultHeight,
    });
    log("[ChatWindow] Chat window opened.", 'debug');
  } catch (e) {
    log(`[ChatWindow] Failed to open chat window: ${e}`, "error");
  }
}
