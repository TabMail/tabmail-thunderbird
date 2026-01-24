// Immediately log that we're starting execution
// console.log(`🚀 TabMail content script starting execution in: ${window.location.href}`);

// Add error handler for the entire script
window.addEventListener("error", (event) => {
  console.error("❌ Content script error:", event.error);
});

// Add unhandled rejection handler
window.addEventListener("unhandledrejection", (event) => {
  console.error("❌ Unhandled promise rejection:", event.reason);
});

// Initialize palette early (async - don't block script load)
// Use dynamic import since this is loaded as a classic script, not ES module
(async () => {
  try {
    const { injectPaletteIntoDocument } = await import(browser.runtime.getURL('theme/palette/palette.js'));
    await injectPaletteIntoDocument(document);
    console.log('[TabMail] Palette CSS injected successfully');
  } catch (err) {
    console.error('[TabMail] Failed to inject palette:', err);
  }
})();

var TabMail = TabMail || {};

(function (TM) {
  let activeEditorNode = null;

  /**
   * Loads configuration from local storage, with default values.
   */
  async function initializeConfig() {
    try {
      const settings = await browser.storage.local.get({
        TRIGGER_THROTTLE_MS: null,
        DIFF_RESTORE_DELAY_MS: null,
        composeHintsBannerEnabled: true,
      });

      const throttleVal = parseInt(settings.TRIGGER_THROTTLE_MS, 10);
      const diffVal = parseInt(settings.DIFF_RESTORE_DELAY_MS, 10);

      if (!isNaN(throttleVal)) {
        TM.config.TRIGGER_THROTTLE_MS = throttleVal;
      }
      if (!isNaN(diffVal)) {
        TM.config.DIFF_RESTORE_DELAY_MS = diffVal;
      }
      
      // Load compose hints banner setting
      TM.state.composeHintsBannerDisabled = settings.composeHintsBannerEnabled === false;

      console.log(
        `[TabMail CS] Config: Trigger throttle ${TM.config.TRIGGER_THROTTLE_MS}ms, Diff restore ${TM.config.DIFF_RESTORE_DELAY_MS}ms, Hints banner ${!TM.state.composeHintsBannerDisabled ? 'enabled' : 'disabled'}`
      );
    } catch (error) {
      console.error("[TabMail CS] Error loading configuration from storage:", error);
      // Leave defaults untouched
    }
  }

  /**
   * The main initialization function. It polls the document until it finds
   * the compose editor and then attaches the correction logic.
   */
  async function initialize() {
    await initializeConfig(); // Ensure config is loaded first

    let poller = null;
    const findAndAttachEditor = () => {
      let editorNode =
        document.querySelector('[contenteditable="true"]') ||
        (document.designMode === "on" && document.body) ||
        (document.body && document.body.isContentEditable && document.body);

      if (editorNode) {
        clearInterval(poller);
        activeEditorNode = editorNode;
        console.log("[TabMail CS] Found editor node, calling attachAutocomplete");
        TM.attachAutocomplete(editorNode);
        
        // Show the compose hints banner (if enabled in settings)
        if (TM.showComposeHintsBanner) {
          TM.showComposeHintsBanner();
        }
      }
    };

    poller = setInterval(
      findAndAttachEditor,
      TM.config.COMPOSE_EDITOR_POLL_INTERVAL_MS
    );
    setTimeout(() => {
      clearInterval(poller);
    }, TM.config.COMPOSE_EDITOR_POLL_TIMEOUT_MS);
  }

  // Live-update compose config when settings change in storage.local
  let composeStorageChangeListener = null;
  
  function cleanupComposeStorageListener() {
    if (composeStorageChangeListener) {
      try {
        browser.storage.onChanged.removeListener(composeStorageChangeListener);
        composeStorageChangeListener = null;
        console.log("[TabMail CS] Storage change listener cleaned up");
      } catch (e) {
        console.error(`[TabMail CS] Failed to remove storage change listener: ${e}`);
      }
    }
  }
  
  try {
    if (!composeStorageChangeListener) {
      composeStorageChangeListener = (changes, areaName) => {
        if (areaName !== "local") return;
        try {
          if (Object.prototype.hasOwnProperty.call(changes, "TRIGGER_THROTTLE_MS")) {
            const v = parseInt(changes.TRIGGER_THROTTLE_MS.newValue, 10);
            if (!isNaN(v)) {
              TM.config.TRIGGER_THROTTLE_MS = v;
              console.log(`[TabMail CS] Live config: TRIGGER_THROTTLE_MS -> ${v}ms`);
            }
          }
          if (Object.prototype.hasOwnProperty.call(changes, "DIFF_RESTORE_DELAY_MS")) {
            const v = parseInt(changes.DIFF_RESTORE_DELAY_MS.newValue, 10);
            if (!isNaN(v)) {
              TM.config.DIFF_RESTORE_DELAY_MS = v;
              console.log(`[TabMail CS] Live config: DIFF_RESTORE_DELAY_MS -> ${v}ms`);
            }
          }
          if (Object.prototype.hasOwnProperty.call(changes, "composeHintsBannerEnabled")) {
            const enabled = changes.composeHintsBannerEnabled.newValue !== false;
            TM.state.composeHintsBannerDisabled = !enabled;
            console.log(`[TabMail CS] Live config: composeHintsBannerEnabled -> ${enabled}`);
            // Hide banner immediately if disabled
            if (!enabled && TM.hideComposeHintsBanner) {
              TM.hideComposeHintsBanner();
            }
          }
        } catch (e) {
          console.warn("[TabMail CS] Failed to apply live config change", e);
        }
      };
      browser.storage.onChanged.addListener(composeStorageChangeListener);
    }
  } catch (e) {
    console.warn("[TabMail CS] storage.onChanged not available", e);
  }

  // Store listener reference for cleanup
  let composeRuntimeMessageListener = null;
  
  function cleanupComposeRuntimeListener() {
    if (composeRuntimeMessageListener) {
      try {
        browser.runtime.onMessage.removeListener(composeRuntimeMessageListener);
        composeRuntimeMessageListener = null;
        console.log("[TabMail CS] Runtime message listener cleaned up");
      } catch (e) {
        console.error(`[TabMail CS] Failed to remove runtime message listener: ${e}`);
      }
    }
  }
  
  // Clean up any existing listener and set up page cleanup
  cleanupComposeRuntimeListener();
  window.addEventListener("beforeunload", () => {
    cleanupComposeRuntimeListener();
    cleanupComposeStorageListener();
  });

  composeRuntimeMessageListener = (message, sender, sendResponse) => {
    if (message.command === "triggerInitialCorrection") {
      if (activeEditorNode) {
        console.log(
          "[TabMail CS] Received command. Triggering initial correction."
        );
        // first reset the original text to null so that we will not think we
        // made this request already
        TabMail.state.originalText = null;
        // then trigger the correction with a small delay
        setTimeout(
          () => TM.triggerCorrection(activeEditorNode),
          TM.config.INITIAL_CORRECTION_DELAY_MS
        );
      } else {
        console.log(
          "[TabMail CS] Received command, but no active editor node."
        );
      }
      return Promise.resolve();
    } else if (message.command === "cleanupBeforeSend") {
      console.log(
        "[TabMail CS] Received cleanupBeforeSend command. Rendering original text without suggestions nor newlines."
      );
      try {
        // Suppress any diff re-renders while Thunderbird snapshots the compose DOM.
        // Without this, a pending diff-restore timer can re-render diffs (including
        // trailing delete spans) during the send window.
        TM.state.beforeSendCleanupActive = true;

        // Clear any existing reset timer (rare but possible with repeated send attempts).
        if (TM.state.beforeSendCleanupResetTimer) {
          clearTimeout(TM.state.beforeSendCleanupResetTimer);
          TM.state.beforeSendCleanupResetTimer = null;
        }

        // Cancel any pending timers that might re-render diffs or trigger new suggestions.
        if (TM.state.diffRestoreTimer) {
          clearTimeout(TM.state.diffRestoreTimer);
          TM.state.diffRestoreTimer = null;
        }
        if (TM.state.autocompleteIdleTimer) {
          clearTimeout(TM.state.autocompleteIdleTimer);
          TM.state.autocompleteIdleTimer = null;
        }
        if (TM.state.typingTimer) {
          clearTimeout(TM.state.typingTimer);
          TM.state.typingTimer = null;
        }
        if (TM.state.backendTimer) {
          clearTimeout(TM.state.backendTimer);
          TM.state.backendTimer = null;
        }

        // Keep diffs hidden during send snapshot window.
        TM.state.autoHideDiff = true;

        console.log("[TabMail CS] cleanupBeforeSend: suppression enabled", {
          autoHideDiff: TM.state.autoHideDiff,
          showDiff: TM.state.showDiff,
          isDiffActive: TM.state.isDiffActive,
          hasCorrectedText: !!TM.state.correctedText,
          diffRestoreTimer: !!TM.state.diffRestoreTimer,
          autocompleteIdleTimer: !!TM.state.autocompleteIdleTimer,
        });

        // Auto-clear suppression in case send fails/cancels and compose stays open.
        const ms = TM.config.BEFORE_SEND_CLEANUP_SUPPRESS_MS;
        TM.state.beforeSendCleanupResetTimer = setTimeout(() => {
          TM.state.beforeSendCleanupResetTimer = null;
          TM.state.beforeSendCleanupActive = false;
          console.log("[TabMail CS] cleanupBeforeSend: suppression cleared (timeout)", { ms });
        }, ms);
      } catch (e) {
        console.warn("[TabMail CS] cleanupBeforeSend: failed to enable suppression", e);
      }
      try {
        // Make sure any TabMail UI elements are not present in the editable DOM
        // when Thunderbird snapshots the message for sending.
        if (TM.hideComposeHintsBanner) {
          TM.hideComposeHintsBanner();
        } else {
          const existing = document.getElementById("tm-compose-hints-banner");
          if (existing) existing.remove();
        }
        if (TM.removeJumpOverlay) {
          TM.removeJumpOverlay();
        } else {
          const overlay = document.getElementById("tm-jump-overlay");
          if (overlay) overlay.remove();
        }
      } catch (e) {
        console.warn("[TabMail CS] cleanupBeforeSend: failed to remove UI hints", e);
      }
      // A clean render of the original text without suggestions nor fake newline characters.
      TM.renderText((show_diffs = false), (show_newlines = false), (force = true));
      return Promise.resolve();
    }
  };
  
  browser.runtime.onMessage.addListener(composeRuntimeMessageListener);

  initialize();
})(TabMail);
