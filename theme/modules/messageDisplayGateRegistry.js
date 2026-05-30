/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Message Display Gate Registration and Injection Module
// Injects messageDisplayGate.js to hide message content until bubbles are ready.

export async function injectMessageDisplayGateIntoTab(tabId) {
  try {
    // NOTE: We intentionally do NOT inject any per-tab gate CSS.
    // Master gating is handled by tmTheme experiment CSS (about:3pane) to avoid races and flashes.
    if (browser.scripting && browser.scripting.executeScript) {
      await browser.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["theme/modules/messageDisplayGate.js"],
      });
      console.log(`[TabMail Theme] ✓ Injected messageDisplayGate.js into tab ${tabId}`);
      return true;
    }

    if (browser.tabs && browser.tabs.executeScript) {
      await browser.tabs.executeScript(tabId, {
        file: "theme/modules/messageDisplayGate.js",
        allFrames: true,
        runAt: "document_start",
      });
      console.log(
        `[TabMail Theme] ✓ Injected messageDisplayGate.js into tab ${tabId} (tabs.executeScript)`
      );
      return true;
    }

    console.error("[TabMail Theme] No script injection API available for display gate");
    return false;
  } catch (e) {
    console.warn(
      `[TabMail Theme] Failed to inject messageDisplayGate.js into tab ${tabId}:`,
      e
    );
    return false;
  }
}


