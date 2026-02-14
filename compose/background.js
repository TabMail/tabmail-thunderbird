// A unique log to confirm the script is being reloaded.
console.log(
  `[${new Date().toISOString()}] BACKGROUND.JS TOP LEVEL - RELOAD CHECK`
);
console.log("[TabMail BG] background.js LOADED (unified addon)");

import * as idb from "../agent/modules/idbStorage.js";
import { getUniqueMessageKey } from "../agent/modules/utils.js";
import { generateCorrection } from "./modules/autocompleteGenerator.js";
import { runComposeEdit } from "./modules/edit.js";

/**
 * Listens for messages from the content script, fetches a suggestion from the
 * backend, and sends the result back.
 *
 * @param {object} message - The message from the content script. Expected to have a `text` property.
 * @param {object} sender - The sender object.
 * @returns {Promise<object>} A promise that resolves with the backend's JSON response.
 */
async function handleRuntimeMessage(message, sender) {
  // console.log("[TabMail BG] handleRuntimeMessage received:", message);
  if (message.type === "getSuggestion" && message.context) {
    try {
      // Get compose details to add more context, like the subject.
      const composeDetails = await messenger.compose.getComposeDetails(
        sender.tab.id
      );

      // Add compose details to message context
      message.context.subject = composeDetails.subject;
      message.context.from = composeDetails.from;
      message.context.to = composeDetails.to;
      message.context.cc = composeDetails.cc;

      // Get current user draft
      const userDraft = (message.context.userMessage || "").trim();

      // ==== SUMMARY & BLURB HANDLING ====
      let summaryBlurb = "Not Available (Composing new email)";
      let summaryDetailed = "Not Available (Composing new email)";
      let cachedPrecompose = null;
      let cachedPrecomposeData = null;
      
      // Declare precomposeKey outside the conditional so it's available later
      const precomposeKey = "activePrecompose:" + sender.tab.id;

      // If the user draft is empty, try loading precomposed message from cache
      if (userDraft === "") {

        if (composeDetails.relatedMessageId) {
          try {
            const uKey = await getUniqueMessageKey(
              composeDetails.relatedMessageId
            );
            if (uKey) {
              const summaryKey = "summary:" + uKey;
              const obj = await idb.get(summaryKey);
              const entry = obj[summaryKey];
              if (entry) {
                if (typeof entry.blurb === "string" && entry.blurb.trim()) {
                  summaryBlurb = entry.blurb.trim();
                }
                if (typeof entry.detailed === "string" && entry.detailed.trim()) {
                  summaryDetailed = entry.detailed.trim();
                }
              }
            }
          } catch (e) {
            console.warn(
              `[TabMail BG] Failed to fetch summary for related message ${composeDetails.relatedMessageId}:`,
              e
            );
          }
        }

        // // Log the received context for debugging.
        // console.log(`[TabMail BG] Received context for "getSuggestion". Fetching from backend...`, message.context);

        // Fetch any preloaded chat history for this tab (reply compose).
        const MAX_WAIT_MS = 8000; // may take 5-8s for heavy threads
        const INTERVAL_MS = 200;
        let waited = 0;

        // Initial attempt
        try {
          const first = await idb.get(precomposeKey);
          cachedPrecomposeData = first[precomposeKey] || null;
          if (cachedPrecomposeData && typeof cachedPrecomposeData === 'object') {
            cachedPrecompose = cachedPrecomposeData.content || cachedPrecomposeData.reply;
          }
        } catch { }

        // If it's a reply and history isn't ready yet, poll briefly.
        if (!cachedPrecompose) {
          while (waited < MAX_WAIT_MS && !cachedPrecompose) {
            await new Promise((r) => setTimeout(r, INTERVAL_MS));
            waited += INTERVAL_MS;
            try {
              const obj = await idb.get(precomposeKey);
              cachedPrecomposeData = obj[precomposeKey] || null;
              if (cachedPrecomposeData && typeof cachedPrecomposeData === 'object') {
                cachedPrecompose = cachedPrecomposeData.content || cachedPrecomposeData.reply;
              }
            } catch { }
          }
          console.log(
            `[getSuggestion] Waited ${waited}ms for cached precompose (found=${!!cachedPrecompose}) for tab ${sender.tab.id
            }`
          );
          console.log(
            "[TMDBG Compose] BG getSuggestion checking key",
            precomposeKey,
            "value len=",
            cachedPrecompose ? cachedPrecompose.length : 0
          );
        }
      }

      // Generate suggestion
      let suggestion;
      const shouldDirectReplace = cachedPrecomposeData && cachedPrecomposeData.directReplace;
      
      if (!userDraft && cachedPrecompose) {
        // Don't trim for direct replacement mode - preserve trailing newlines
        // For normal suggestion mode, trimStart to remove leading whitespace only
        suggestion = shouldDirectReplace ? cachedPrecompose : cachedPrecompose.trimStart();
        
        // Clear the directReplace flag after first use, but keep content in cache
        // This way: first use = force replace, subsequent empty text = normal suggestion with diffs
        if (shouldDirectReplace) {
          try {
            const updatedPrecomposeData = {
              content: cachedPrecompose,
              directReplace: false
            };
            await idb.set({ [precomposeKey]: updatedPrecomposeData });
          } catch (e) {
            console.warn(`[getSuggestion] Failed to update precompose directReplace flag: ${e}`);
          }
        }
      } else {
        suggestion = await generateCorrection({
          userMessage: message.context.userMessage,
          quoteAndSignature: message.context.quoteAndSignature,
          cursorPosition: message.context.cursorPosition,
          isLocal: message.context.isLocal,
          subject: composeDetails.subject,
          from: composeDetails.from,
          to: composeDetails.to,
          cc: composeDetails.cc,
          summaryBlurb,
          summaryDetailed,
          sessionId: sender.tab.id,
        });
      }

      if (!suggestion) {
        return { error: "LLM returned empty" };
      }

      return {
        suggestion,
        usertext: message.context.userMessage,
        sessionId: sender.tab.id,
        directReplace: shouldDirectReplace || false,
      };
    } catch (error) {
      console.error(
        "[TabMail BG] CRITICAL: Could not connect to backend.",
        error
      );
      return { error: "Could not connect to backend." };
    }
  } else if (message.type === "rejectSuggestion") {
    console.log(
      `[TabMail BG] Received rejection for session ${message.sessionId}.`
    );
    try {
      // For now just log; no backend
      console.log("[TabMail BG] Rejection info:", message);
    } catch (error) {
      console.warn(
        `[TabMail BG] Could not handle rejection for session ${message.sessionId}:`,
        error
      );
    }
    return; // No response needed.

  } else if (message.type === "runInlineComposeEdit") {
    const inlineEditStartTime = performance.now();
    // Store callback reference for cleanup even on error
    let callbackInstalled = false;
    try {
      const senderTabId = sender?.tab?.id;
      
      // Set up throttle callback to relay messages to this tab
      window._tabmailThrottleCallback = (action) => {
        const messageType = action === 'start' ? 'tabmail-throttle-start' : 'tabmail-throttle-end';
        messenger.tabs.sendMessage(senderTabId, { type: messageType })
          .then(() => {
            console.log(`[TabMail BG] Sent ${messageType} to tab ${senderTabId}`);
          })
          .catch((e) => {
            console.error(`[TabMail BG] Failed to send ${messageType}: ${e}`);
          });
      };
      // Set up status callback to relay AI activity status to this tab
      window._tabmailStatusCallback = (text) => {
        messenger.tabs.sendMessage(senderTabId, { type: 'tabmail-status-update', text })
          .catch((e) => {
            console.error(`[TabMail BG] Failed to send status update: ${e}`);
          });
      };
      callbackInstalled = true;
      
      const details = await messenger.compose.getComposeDetails(senderTabId);
      const recipients = (details.to || []).map((e) => ({ name: "", email: e }));
      const subject = details.subject || "";
      const body = message.body || "";
      const request = (message.request || "").trim();
      const selectedText = (message.selectedText || "").trim();
      
      // Detect reply or forward context
      let mode = "new";
      let relatedEmailId = "";
      
      if (details.relatedMessageId) {
        relatedEmailId = String(details.relatedMessageId);
        
        // Determine mode based on compose type
        if (details.type === "reply") {
          mode = "reply";
        } else if (details.type === "forward") {
          mode = "forward";
        } else {
          // If we have a relatedMessageId but type is not explicitly reply/forward,
          // we can infer the mode from the subject prefix
          if (subject.startsWith("Re:")) {
            mode = "reply";
          } else if (subject.startsWith("Fwd:")) {
            mode = "forward";
          }
        }
      }
      
      console.log(
        `[TabMail BG] ═══════════════════════════════════════════════════════════════════`
      );
      console.log(
        `[TabMail BG] INLINE EDIT REQUEST STARTED (tab ${senderTabId})`
      );
      console.log(
        `[TabMail BG]   Mode: ${mode} | Recipients: ${recipients.length} | Subject: ${subject.length} chars`
      );
      console.log(
        `[TabMail BG]   Body: ${body.length} chars | Request: ${request.length} chars | Selection: ${selectedText.length} chars`
      );
      if (relatedEmailId) {
        console.log(
          `[TabMail BG]   Related Email: ${relatedEmailId} (compose type: ${details.type})`
        );
      }
      console.log(
        `[TabMail BG] ───────────────────────────────────────────────────────────────────`
      );
      
      const result = await runComposeEdit({
        recipients,
        subject,
        body,
        request,
        selectedText,
        relatedEmailId,
        mode,
        ignoreSemaphore: true,
      });
      
      const inlineEditDuration = performance.now() - inlineEditStartTime;
      console.log(
        `[TabMail BG] ───────────────────────────────────────────────────────────────────`
      );
      console.log(
        `[TabMail BG] INLINE EDIT REQUEST COMPLETED in ${inlineEditDuration.toFixed(1)}ms`
      );
      console.log(
        `[TabMail BG]   Result Body: ${(result?.body || "").length} chars | Subject: ${(result?.subject || "").length} chars`
      );
      console.log(
        `[TabMail BG] ═══════════════════════════════════════════════════════════════════`
      );
      
      return result || { subject: undefined, body: "", raw: "", messages: [] };
    } catch (error) {
      const inlineEditDuration = performance.now() - inlineEditStartTime;
      console.error(
        `[TabMail BG] ═══════════════════════════════════════════════════════════════════`
      );
      console.error(
        `[TabMail BG] INLINE EDIT REQUEST FAILED after ${inlineEditDuration.toFixed(1)}ms:`, error
      );
      console.error(
        `[TabMail BG] ═══════════════════════════════════════════════════════════════════`
      );
      return { error: String(error?.message || error) };
    } finally {
      // Always clear callbacks, even on error (prevents global pollution leak)
      if (callbackInstalled) {
        delete window._tabmailThrottleCallback;
        delete window._tabmailStatusCallback;
      }
    }
  } else if (message.type === "initialTriggerCheck") {
    console.log(
      `[TabMail BG] Received initialTriggerCheck for tab ${sender.tab.id}.`
    );
    try {
      const composeDetails = await messenger.compose.getComposeDetails(
        sender.tab.id
      );
      if (composeDetails.subject && composeDetails.subject.trim() !== "") {
        console.log(
          `[TabMail BG] Subject is "${composeDetails.subject}". Sending command to trigger correction.`
        );
        await messenger.tabs.sendMessage(sender.tab.id, {
          command: "triggerInitialCorrection",
        });
      } else {
        console.log(
          `[TabMail BG] Subject is empty. Not triggering initial correction.`
        );
      }
    } catch (error) {
      console.error(
        `[TabMail BG] Error during initialTriggerCheck for tab ${sender.tab.id}:`,
        error
      );
    }
    return; // No response payload needed
  }
}

/**
 * Listens for tab removal events to clean up the session on the backend.
 */
// No backend cleanup needed

/**
 * Listens for the onBeforeSend event to clean up any visible suggestions
 * before the email is sent.
 */
function stripComposeHintsBannerFromText(text) {
  if (!text || typeof text !== "string") return { text, changed: false };

  const before = text;

  // 1) Remove TabMail UI elements if they were serialized as HTML.
  // Note: keep this conservative; we only target known ids.
  text = text.replace(
    /<div[^>]*\bid=["']tm-compose-hints-banner["'][^>]*>[\s\S]*?<\/div>/gi,
    ""
  );
  text = text.replace(
    /<div[^>]*\bid=["']tm-jump-overlay["'][^>]*>[\s\S]*?<\/div>/gi,
    ""
  );

  // 2) Remove the banner string if it somehow got copied/pasted into the body.
  const bannerMac = "Tab to accept · Shift-Tab to accept all · ⌘K to edit";
  const bannerNonMac = "Tab to accept · Shift-Tab to accept all · Ctrl+K to edit";
  text = text.replaceAll(bannerMac, "");
  text = text.replaceAll(bannerNonMac, "");

  // Also handle any trailing whitespace / stray blank line left behind.
  // (Do not over-normalize; keep minimal.)
  text = text.replaceAll("\n\n\n", "\n\n");

  return { text, changed: text !== before };
}

messenger.compose.onBeforeSend.addListener(async (tab) => {
  console.log(
    `[TabMail BG] onBeforeSend triggered for tab ${tab.id}. Cleaning up suggestions.`
  );
  try {
    await messenger.tabs.sendMessage(tab.id, { command: "cleanupBeforeSend" });
  } catch (error) {
    console.error(
      `[TabMail BG] Error during onBeforeSend cleanup for tab ${tab.id}:`,
      error
    );
  }

  // Safety: ensure the compose hints banner is never present in outgoing content,
  // even if it was copied/pasted or serialized into the body.
  try {
    const details = await messenger.compose.getComposeDetails(tab.id);

    let changed = false;
    const toSet = {};

    if (typeof details.body === "string") {
      const r = stripComposeHintsBannerFromText(details.body);
      if (r.changed) {
        toSet.body = r.text;
        changed = true;
      }
    }

    if (typeof details.plainTextBody === "string") {
      const r = stripComposeHintsBannerFromText(details.plainTextBody);
      if (r.changed) {
        toSet.plainTextBody = r.text;
        changed = true;
      }
    }

    if (changed) {
      console.log(
        `[TabMail BG] onBeforeSend: stripping compose hints banner from outgoing content for tab ${tab.id}.`
      );
      await messenger.compose.setComposeDetails(tab.id, toSet);
    }
  } catch (e) {
    console.error(
      `[TabMail BG] onBeforeSend: failed to strip compose hints banner for tab ${tab.id}:`,
      e
    );
  }
});

/**
 * Unregisters and then re-registers the content scripts. This is the most
 * robust way to handle addon reloads and prevent race conditions.
 */
async function initializeScripts() {
  try {
    // Unregister any old scripts first to ensure a clean state.
    await messenger.scripting.compose.unregisterScripts();
    console.log("✅ TabMail: Successfully unregistered compose scripts.");
  } catch (e) {
    // This can happen on first install, which is not an error.
    console.log("ℹ️ TabMail: Could not unregister scripts, may be first run.");
  }

  try {
    // Register the core state/config scripts first so they're guaranteed to be
    // available for any later modules that reference TabMail.state.

    // === DIAGNOSTICS ===
    const coreScriptsArr = [
      "compose/libs/undo-manager.js", // load first so state can instantiate
      "compose/modules/config.js",
      "compose/modules/logger.js",   // load after config but before other modules
      "compose/modules/state.js",
    ];
    const composeScriptsArr = [
      "compose/libs/diff-match-patch.js",
      "compose/libs/patience-diff.js",
      "compose/libs/jsdiff.min.js",
      // undo-manager already loaded in core scripts
      "compose/modules/core.js",
      "compose/modules/inlineEditor.js",
      "compose/modules/dom.js",
      "compose/modules/api.js",
      "compose/modules/autohideDiff.js",
      "compose/modules/events.js",
      "compose/modules/caret.js",
      "compose/modules/sentences.js",
      "compose/modules/tokens.js",
      "compose/modules/undo.js",
      "compose/modules/diff.js",
      "compose/compose-autocomplete.js",
    ];

    console.log(
      "[TabMail BG] About to register compose-core scripts:",
      coreScriptsArr.map((p) => browser.runtime.getURL(p))
    );
    console.log(
      "[TabMail BG] About to register compose scripts:",
      composeScriptsArr.map((p) => browser.runtime.getURL(p))
    );

    await messenger.scripting.compose.registerScripts([
      {
        id: "tabmail-compose-core",
        js: coreScriptsArr,
        runAt: "document_start",
      },
      {
        id: "tabmail-compose-scripts",
        js: composeScriptsArr,
        runAt: "document_idle",
      },
    ]);
    console.log("✅ TabMail: Compose scripts registered successfully.");
  } catch (e) {
    console.error("❌ TabMail: Error registering compose scripts:", e);
  }
}

// --- LISTENERS & STARTUP ---

// Store runtime message listener reference for cleanup
let composeRuntimeMessageListener = null;

/**
 * Remove any existing runtime message listener to prevent accumulation on reload
 */
function cleanupRuntimeListeners() {
  if (composeRuntimeMessageListener) {
    try {
      browser.runtime.onMessage.removeListener(composeRuntimeMessageListener);
      composeRuntimeMessageListener = null;
      console.log("[TabMail Compose] Runtime message listener cleaned up");
    } catch (e) {
      console.error(`[TabMail Compose] Failed to remove runtime message listener: ${e}`);
    }
  }
}

/**
 * Setup runtime message listener with proper cleanup tracking
 */
function setupRuntimeMessageListener() {
  // Clean up any existing listener first
  cleanupRuntimeListeners();
  
  // Listen for messages from content scripts. This is the main entry point
  // for handling requests for autocomplete suggestions.
  // Forward only compose messages to the compose handler to avoid returning a
  // Promise for unrelated messages. For non-compose messages, do nothing so
  // other listeners can respond.
  composeRuntimeMessageListener = (message, sender) => {
    try {
      // Guard: only handle *compose* types and return a Promise for those.
      const t = message?.type;
      switch (t) {
        case "getSuggestion":
        case "rejectSuggestion":
        case "runInlineComposeEdit":
        case "initialTriggerCheck":
          // IMPORTANT: Only these return a Promise.
          return handleRuntimeMessage(message, sender);
        default:
          // IMPORTANT: Return nothing for all other messages (including "fts")
          // so other listeners (your FTS engine) can respond.
          return;
      }
    } catch (_) {
      // swallow; return undefined (no response)
      return;
    }
  };
  
  // Register the listener
  browser.runtime.onMessage.addListener(composeRuntimeMessageListener);
  console.log("[TabMail Compose] Runtime message listener setup complete");
}

// Initialize the runtime message listener
setupRuntimeMessageListener();

// --- Cleanup on Extension Shutdown ---
// Handle extension disable/uninstall by cleaning up listeners
if (typeof browser !== 'undefined' && browser.runtime) {
  // This fires when the extension is being disabled, uninstalled, or reloaded
  browser.runtime.onSuspend?.addListener(() => {
    console.log("[TabMail Compose] Extension suspending - cleaning up listeners");
    try {
      cleanupRuntimeListeners();
    } catch (e) {
      console.error(`[TabMail Compose] Error during runtime listener cleanup: ${e}`);
    }
  });
}

// On reload, there's a race condition within Thunderbird's scripting API.
// Waiting a moment before unregistering and re-registering our scripts
// has proven to be the most stable solution.
setTimeout(initializeScripts, 500);

console.log(
  "🚀 TabMail background script loaded. Script initialization will start shortly."
);
