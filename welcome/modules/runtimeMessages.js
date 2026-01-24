/**
 * Welcome wizard runtime messaging
 * NOTE: Do NOT use async handler for runtime.onMessage (TB MV3 listener compatibility).
 */

export function setupMessageListener({ goToStep }) {
  if (typeof browser === "undefined" || !browser.runtime || !browser.runtime.onMessage) {
    console.warn("[Welcome] runtime.onMessage not available");
    return;
  }

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command === "welcome-reset-to-initial") {
      console.log("[Welcome] Received reset command - navigating to initial page");
      goToStep(0).then(() => {
        console.log("[Welcome] Reset to initial page completed");
        sendResponse({ success: true });
      }).catch((e) => {
        console.error("[Welcome] Failed to reset to initial page:", e);
        sendResponse({ success: false, error: e.message });
      });
      return true; // Indicates we will send a response asynchronously
    }
  });
}

