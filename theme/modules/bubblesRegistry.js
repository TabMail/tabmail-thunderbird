// Unified Bubbles Registration and Injection Module (TB 145 / MV3)
// Handles registration and on-demand injection of all bubble-related content scripts.
//
// Injection order (all at document_end for proper globalThis availability):
//   1. quoteAndSignature.js - quote detection
//   2. threadBubbleConfig.js - thread bubble config
//   3. messageBubbleConfig.js - shared config
//   4. messageBubbleStyles.js - shared CSS
//   5. summaryBubbleConfig.js - summary bubble config
//   6. summaryBubble.js - summary bubble renderer
//   7. threadBubble.js - thread bubble renderer
//   8. messageBubble.js - message wrapper + quote collapsing
//   9. bubblesRenderer.js - unified message listener

import { getPrivacyOptOutAllAiEnabled } from "../../chat/modules/privacySettings.js";

let _bubblesScriptRegistered = false;

// All files in injection order
const BUBBLE_SCRIPT_FILES = [
  "agent/modules/quoteAndSignature.js",
  "theme/modules/threadBubbleConfig.js",
  "theme/modules/messageBubbleConfig.js",
  "theme/modules/messageBubbleStyles.js",
  "theme/modules/summaryBubbleConfig.js",
  "theme/modules/summaryBubble.js",
  "theme/modules/threadBubble.js",
  "theme/modules/messageBubble.js",
  "theme/modules/bubblesRenderer.js",
];

export async function registerBubblesScripts() {
  if (_bubblesScriptRegistered) {
    return;
  }

  // Try to register via messageDisplayScripts if available
  if (browser.messageDisplayScripts && browser.messageDisplayScripts.register) {
    try {
      await browser.messageDisplayScripts.register({
        js: BUBBLE_SCRIPT_FILES.map(file => ({ file })),
        runAt: "document_end",
      });
      _bubblesScriptRegistered = true;
      console.log("[TabMail Bubbles] ✓ Registered all bubble scripts via messageDisplayScripts");
      return;
    } catch (e) {
      console.log("[TabMail Bubbles] messageDisplayScripts registration failed:", e.message);
    }
  }

  // In TB 141+, messageDisplayScripts is not available
  // We'll inject on-demand via injectBubblesIntoTab
  console.log("[TabMail Bubbles] Will inject bubble scripts on-demand (TB 141+)");
}

export async function injectBubblesIntoTab(tabId) {
  try {
    // Check privacy opt-out
    try {
      const optOut = await getPrivacyOptOutAllAiEnabled();
      if (optOut) {
        console.log(`[TabMail Bubbles] Privacy opt-out enabled; skipping injection for tab ${tabId}`);
        return { injected: false, skipped: true, reason: "privacyOptOut" };
      }
    } catch (e) {
      console.log(`[TabMail Bubbles] Privacy opt-out check failed; proceeding (err=${e})`);
    }

    if (browser.scripting && browser.scripting.executeScript) {
      await browser.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: BUBBLE_SCRIPT_FILES,
      });
      console.log(`[TabMail Bubbles] ✓ Injected all bubble scripts into tab ${tabId}`);
      return { injected: true, skipped: false };
    } else if (browser.tabs && browser.tabs.executeScript) {
      // tabs.executeScript only supports a single file per call; preserve order.
      for (const file of BUBBLE_SCRIPT_FILES) {
        await browser.tabs.executeScript(tabId, {
          file,
          allFrames: true,
          runAt: "document_end",
        });
      }
      console.log(`[TabMail Bubbles] ✓ Injected all bubble scripts into tab ${tabId} (fallback)`);
      return { injected: true, skipped: false };
    } else {
      console.error("[TabMail Bubbles] No script injection API available");
      return { injected: false, skipped: false, reason: "noInjectionApi" };
    }
  } catch (e) {
    console.warn(`[TabMail Bubbles] Failed to inject into tab ${tabId}:`, e);
    return { injected: false, skipped: false, reason: "exception", error: String(e) };
  }
}

/**
 * Reset the registration flag for hot-reload scenarios.
 */
export function resetBubblesRegistrationFlag() {
  _bubblesScriptRegistered = false;
  console.log("[TabMail Bubbles] Registration flag reset");
}
