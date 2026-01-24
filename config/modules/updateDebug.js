import { $ } from "./dom.js";

// Storage keys - must match keepalive/background.js
const UPDATE_STATE_KEY = "tm_updateState";
const PENDING_VERSION_KEY = "tm_pendingUpdateVersion";

// Simulated version for testing
const SIMULATED_VERSION = "99.0.0";

/**
 * Update the debug status display
 */
export async function updateDebugStatusDisplay() {
  const stateEl = $("update-debug-state");
  if (!stateEl) return;

  try {
    const state = await browser.runtime.sendMessage({ command: "getUpdateState" });
    
    if (state.updateState === "pending" && state.pendingVersion) {
      stateEl.textContent = `⏳ Update pending: v${state.pendingVersion} (current: v${state.currentVersion})`;
      stateEl.style.color = "var(--tag-tm-archive, #ff9500)";
    } else {
      stateEl.textContent = `✓ Up to date: v${state.currentVersion}`;
      stateEl.style.color = "var(--tag-tm-reply, #5cb85c)";
    }
  } catch (e) {
    console.error("[TMDBG UpdateDebug] Failed to get update state:", e);
    stateEl.textContent = `Error: ${e.message}`;
    stateEl.style.color = "var(--tag-tm-delete, #ee1111)";
  }
}

/**
 * Simulate an update available (sets storage state)
 */
export async function simulateUpdateAvailable() {
  try {
    console.log(`[TMDBG UpdateDebug] Simulating update to v${SIMULATED_VERSION}`);
    
    // Set storage state
    await browser.storage.local.set({
      [UPDATE_STATE_KEY]: "pending",
      [PENDING_VERSION_KEY]: SIMULATED_VERSION,
    });
    
    // Show notification bar via experiment
    if (browser.tmUpdates?.showUpdateBar) {
      await browser.tmUpdates.showUpdateBar({
        message: `TabMail v${SIMULATED_VERSION} ready — restart Thunderbird to apply`,
        version: SIMULATED_VERSION,
      });
      console.log("[TMDBG UpdateDebug] Update bar shown");
    } else {
      console.warn("[TMDBG UpdateDebug] tmUpdates experiment not available");
    }
    
    $("status").textContent = `Simulated update to v${SIMULATED_VERSION}`;
    await updateDebugStatusDisplay();
  } catch (e) {
    console.error("[TMDBG UpdateDebug] simulateUpdateAvailable failed:", e);
    $("status").textContent = `Error: ${e.message}`;
  }
}

/**
 * Clear update state from storage
 */
export async function clearUpdateState() {
  try {
    console.log("[TMDBG UpdateDebug] Clearing update state");
    
    await browser.storage.local.remove([UPDATE_STATE_KEY, PENDING_VERSION_KEY]);
    
    // Hide notification bar
    if (browser.tmUpdates?.hideUpdateBar) {
      await browser.tmUpdates.hideUpdateBar();
    }
    
    $("status").textContent = "Update state cleared";
    await updateDebugStatusDisplay();
  } catch (e) {
    console.error("[TMDBG UpdateDebug] clearUpdateState failed:", e);
    $("status").textContent = `Error: ${e.message}`;
  }
}

/**
 * Show the update notification bar
 */
export async function showUpdateBar() {
  try {
    const stored = await browser.storage.local.get([UPDATE_STATE_KEY, PENDING_VERSION_KEY]);
    const version = stored[PENDING_VERSION_KEY] || SIMULATED_VERSION;
    
    if (browser.tmUpdates?.showUpdateBar) {
      await browser.tmUpdates.showUpdateBar({
        message: `TabMail v${version} ready — restart Thunderbird to apply`,
        version,
      });
      $("status").textContent = "Update bar shown";
    } else {
      $("status").textContent = "tmUpdates experiment not available";
    }
  } catch (e) {
    console.error("[TMDBG UpdateDebug] showUpdateBar failed:", e);
    $("status").textContent = `Error: ${e.message}`;
  }
}

/**
 * Hide the update notification bar
 */
export async function hideUpdateBar() {
  try {
    if (browser.tmUpdates?.hideUpdateBar) {
      await browser.tmUpdates.hideUpdateBar();
      $("status").textContent = "Update bar hidden";
    } else {
      $("status").textContent = "tmUpdates experiment not available";
    }
  } catch (e) {
    console.error("[TMDBG UpdateDebug] hideUpdateBar failed:", e);
    $("status").textContent = `Error: ${e.message}`;
  }
}

/**
 * Actually restart Thunderbird
 */
export async function restartThunderbird() {
  try {
    if (browser.tmUpdates?.restartThunderbird) {
      $("status").textContent = "Restarting Thunderbird...";
      await browser.tmUpdates.restartThunderbird();
    } else {
      $("status").textContent = "tmUpdates experiment not available";
    }
  } catch (e) {
    console.error("[TMDBG UpdateDebug] restartThunderbird failed:", e);
    $("status").textContent = `Error: ${e.message}`;
  }
}
