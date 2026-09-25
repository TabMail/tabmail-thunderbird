/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// =============================================================================
// UPDATE MANAGER
// =============================================================================
// Block auto-reload on addon update. Show notification bar instead.
// Update will apply on Thunderbird restart.
//
// The experiment retains the pending version for this Thunderbird process.
// Background module state is discarded when Thunderbird suspends it.

// Keep operations from the update event, popup, and debug controls in arrival
// order. The queue is transient: completed state lives in the parent process.
let updateOperation = Promise.resolve();
function enqueueUpdateOperation(operation) {
  const result = updateOperation.then(operation);
  updateOperation = result.catch(() => {});
  return result;
}

/**
 * Handle addon update available event.
 * By listening to this and NOT calling runtime.reload(), we defer the update
 * until Thunderbird restarts.
 */
browser.runtime.onUpdateAvailable.addListener((details) => enqueueUpdateOperation(async () => {
  console.log(`[TMDBG Updates] Update available: v${details.version}, deferring until restart`);

  // Show notification bar in all windows
  try {
    if (browser.tmUpdates?.showUpdateBar) {
      await browser.tmUpdates.setPendingUpdateVersion(details.version);
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
}));

/**
 * Handle notification bar actions
 */
if (browser.tmUpdates?.onNotificationAction) {
  browser.tmUpdates.onNotificationAction.addListener((event) => enqueueUpdateOperation(async () => {
    console.log("[TMDBG Updates] Notification action:", event.action);

    if (event.action === "dismiss") {
      // User clicked Later - hide the bar but keep process-lifetime state for popup
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
  }));
}

/**
 * Handle runtime messages for update actions from popup
 */
browser.runtime.onMessage.addListener((message) => {
  if (message && message.command === "getUpdateState") {
    return enqueueUpdateOperation(async () => {
      const pendingVersion = await browser.tmUpdates?.getPendingUpdateVersion?.() ?? null;
      return {
        updateState: pendingVersion ? "pending" : null,
        pendingVersion,
        currentVersion: browser.runtime.getManifest().version,
      };
    });
  }

  if (message && message.command === "setPendingUpdate" && message.version) {
    // Set pending update from manual check (before onUpdateAvailable fires)
    console.log("[TMDBG Updates] Setting pending update from manual check:", message.version);
    // Show notification bar immediately
    if (browser.tmUpdates?.showUpdateBar && browser.tmUpdates?.setPendingUpdateVersion) {
      return enqueueUpdateOperation(async () => {
        try {
          await browser.tmUpdates.setPendingUpdateVersion(message.version);
          await browser.tmUpdates.showUpdateBar({
            message: `TabMail v${message.version} ready — restart Thunderbird to apply`,
            version: message.version,
          });
          console.log("[TMDBG Updates] Update notification bar shown from manual check");
        } catch (e) {
          console.error("[TMDBG Updates] Failed to show update bar:", e);
          throw e;
        }
      });
    }
    return false;
  }

  if (message && message.command === "clearPendingUpdate") {
    if (!browser.tmUpdates?.hideUpdateBar || !browser.tmUpdates?.clearPendingUpdateVersion) return false;
    return enqueueUpdateOperation(async () => {
      await browser.tmUpdates.hideUpdateBar();
      await browser.tmUpdates.clearPendingUpdateVersion();
    });
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

console.log("[TMDBG Updates] Update manager initialized (process-lifetime state)");
