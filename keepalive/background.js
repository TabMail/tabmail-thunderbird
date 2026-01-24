// keepalive/background.js
// Service Worker keepalive via periodic message pings from hidden relay page

// =============================================================================
// NO LISTENER NEEDED
// =============================================================================
// The relay sends periodic runtime.sendMessage() pings that reset the SW idle timer.
// We don't need to listen for them - unhandled messages are harmlessly ignored.
// The act of receiving the message is enough to keep the SW alive.

// =============================================================================
// INITIALIZATION
// =============================================================================

// Initialize experiment (injects hidden relay page into 3-pane windows)
console.log("[TMDBG KeepAlive] Initializing keepalive experiment...");
try {
  browser.tmKeepAlive.init();
  console.log("[TMDBG KeepAlive] Experiment initialized - hidden relay will be injected into 3-pane");
  console.log("[TMDBG KeepAlive] Service worker will stay alive via periodic message pings (always-on)");
} catch (e) {
  console.error("[TMDBG KeepAlive] Failed to initialize experiment:", e);
}

// =============================================================================
// UPDATE MANAGER
// =============================================================================
// Block auto-reload on addon update. Show notification bar instead.
// Update will apply on Thunderbird restart.
//
// IMPORTANT: Update state is kept IN MEMORY ONLY.
// This way, when Thunderbird restarts and the addon updates, the state
// naturally clears (since it's a fresh process with no pending update).

// In-memory update state - naturally clears on restart
let pendingUpdateVersion = null;

/**
 * Handle addon update available event.
 * By listening to this and NOT calling runtime.reload(), we defer the update
 * until Thunderbird restarts.
 */
browser.runtime.onUpdateAvailable.addListener(async (details) => {
  console.log(`[TMDBG Updates] Update available: v${details.version}, deferring until restart`);
  
  // Set in-memory state (not storage - this should clear on restart)
  pendingUpdateVersion = details.version;
  
  // Show notification bar in all windows
  try {
    if (browser.tmUpdates?.showUpdateBar) {
      await browser.tmUpdates.showUpdateBar({
        message: `TabMail v${details.version} ready — restart Thunderbird to apply`,
        version: details.version,
      });
      console.log("[TMDBG Updates] Update notification bar shown");
    } else {
      console.warn("[TMDBG Updates] tmUpdates experiment not available");
    }
  } catch (e) {
    console.error("[TMDBG Updates] Failed to show update bar:", e);
  }
  
  // DO NOT call browser.runtime.reload() - this is what blocks auto-reload!
});

/**
 * Handle notification bar actions
 */
if (browser.tmUpdates?.onNotificationAction) {
  browser.tmUpdates.onNotificationAction.addListener(async (event) => {
    console.log("[TMDBG Updates] Notification action:", event.action);
    
    if (event.action === "dismiss") {
      // User clicked Later - hide the bar but keep in-memory state for popup
      console.log("[TMDBG Updates] User dismissed update notification");
      await browser.tmUpdates.hideUpdateBar();
    } else if (event.action === "restart") {
      // User clicked Restart Thunderbird
      console.log("[TMDBG Updates] User requested restart");
      try {
        await browser.tmUpdates.restartThunderbird();
      } catch (e) {
        console.error("[TMDBG Updates] Failed to restart:", e);
      }
    }
  });
}

/**
 * Handle runtime messages for update actions from popup
 */
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.command === "getUpdateState") {
    // Return in-memory update state for popup
    // No storage lookup needed - state is memory-only
    sendResponse({
      updateState: pendingUpdateVersion ? "pending" : null,
      pendingVersion: pendingUpdateVersion,
      currentVersion: browser.runtime.getManifest().version,
    });
    return false; // Synchronous response
  }
  
  if (message && message.command === "setPendingUpdate" && message.version) {
    // Set pending update from manual check (before onUpdateAvailable fires)
    console.log("[TMDBG Updates] Setting pending update from manual check:", message.version);
    pendingUpdateVersion = message.version;
    
    // Show notification bar immediately
    if (browser.tmUpdates?.showUpdateBar) {
      browser.tmUpdates.showUpdateBar({
        message: `TabMail v${message.version} ready — restart Thunderbird to apply`,
        version: message.version,
      }).then(() => {
        console.log("[TMDBG Updates] Update notification bar shown from manual check");
      }).catch((e) => {
        console.error("[TMDBG Updates] Failed to show update bar:", e);
      });
    }
    return false;
  }
  
  if (message && message.command === "restartForUpdate") {
    // Popup requested restart
    console.log("[TMDBG Updates] Popup requested restart");
    browser.tmUpdates?.restartThunderbird().catch((e) => {
      console.error("[TMDBG Updates] Failed to restart from popup:", e);
    });
    return false;
  }
  
  // Don't handle other messages
  return false;
});

// Clean up any stale storage keys from previous implementation
browser.storage.local.remove(["tm_updateState", "tm_pendingUpdateVersion"]).catch(() => {});

console.log("[TMDBG Updates] Update manager initialized (in-memory state only)");
