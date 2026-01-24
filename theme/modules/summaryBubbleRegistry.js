// Summary Bubble Registration and Injection Module
// Handles registration and on-demand injection of summaryBubble.js content script

let _bubbleScriptRegistered = false;

import { getPrivacyOptOutAllAiEnabled } from "../../chat/modules/privacySettings.js";

export async function registerBubbleContentScript() {
  if (_bubbleScriptRegistered) {
    return;
  }
  if (
    !browser.messageDisplayScripts ||
    !browser.messageDisplayScripts.register
  ) {
    console.log(
      "[TabMail Bubble] messageDisplayScripts API not available – will rely on per-tab injection."
    );
    return;
  }
  try {
    await browser.messageDisplayScripts.register({
      // Inject config first so summaryBubble.js never needs to hardcode numeric values.
      js: [
        { file: "theme/modules/summaryBubbleConfig.js" },
        { file: "theme/modules/summaryBubble.js" },
      ],
      // Earlier than document_idle to reduce perceived delay vs vanilla TB.
      runAt: "document_start",
    });
    _bubbleScriptRegistered = true;
    console.log(
      "[TabMail Bubble] ✓ Successfully registered summaryBubble.js via messageDisplayScripts."
    );
  } catch (e) {
    console.log(
      `[TabMail Bubble] Failed to register bubble content script: ${e}`,
      "error"
    );
  }
}

export async function ensureBubbleScriptInjected(tabId) {
  try {
    try {
      const optOut = await getPrivacyOptOutAllAiEnabled();
      if (optOut) {
        console.log(
          `[TabMail Bubble] Privacy opt-out enabled; skipping summaryBubble.js injection for tab ${tabId}`
        );
        return { injected: false, skipped: true, reason: "privacyOptOut" };
      }
    } catch (e) {
      console.log(
        `[TabMail Bubble] Privacy opt-out check failed; proceeding with injection (err=${e})`,
        "warn"
      );
    }

    // The script is small and self-contained, so re-injecting isn't a huge cost
    // and is safer than trying to track injection state across reloads/etc.
    if (browser.scripting && browser.scripting.executeScript) {
      await browser.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: [
          "theme/modules/summaryBubbleConfig.js",
          "theme/modules/summaryBubble.js",
        ],
      });
    } else if (browser.tabs && browser.tabs.executeScript) {
      // Fallback for older Thunderbird versions or different contexts
      await browser.tabs.executeScript(tabId, {
        file: "theme/modules/summaryBubbleConfig.js",
        allFrames: true,
        runAt: "document_end",
      });
      await browser.tabs.executeScript(tabId, {
        file: "theme/modules/summaryBubble.js",
        allFrames: true,
        runAt: "document_end",
      });
    } else {
      console.log("[TabMail Bubble] No script injection API available", "error");
      return { injected: false, skipped: false, reason: "noInjectionApi" };
    }
    return { injected: true, skipped: false };
  } catch (e) {
    console.log(`[TabMail Bubble] INJECTION FAILED in tab ${tabId}: ${e}`, "error");
    return { injected: false, skipped: false, reason: "exception", error: String(e) };
  }
}

/**
 * Reset the registration flag for hot-reload scenarios.
 * Called during extension suspend so scripts can be re-registered on next init.
 */
export function resetBubbleRegistrationFlag() {
  _bubbleScriptRegistered = false;
  console.log("[TabMail Bubble] Registration flag reset");
}

