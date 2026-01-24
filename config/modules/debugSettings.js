import { $ } from "./dom.js";

/**
 * Updates the UI based on debug mode state.
 * Shows/hides debug-only sections and the debug warning.
 */
export function updateDebugModeUI(isDebugMode) {
  // Get all debug-only elements (sections and other elements with class)
  const debugOnlyElements = document.querySelectorAll(".debug-only");

  debugOnlyElements.forEach((el) => {
    el.style.display = isDebugMode ? "" : "none";
  });

  // Show/hide the debug warning box
  const debugWarning = $("debug-warning");
  if (debugWarning) {
    debugWarning.style.display = isDebugMode ? "block" : "none";
  }

  console.log(
    `[Config] Debug mode UI updated: ${isDebugMode ? "debug" : "simple"} mode`,
  );
}

export async function loadDebugSettings() {
  try {
    const stored = await browser.storage.local.get({
      debugMode: false,
    });
    const isDebugMode = stored.debugMode;
    $("debug-mode").checked = isDebugMode;

    // Update UI based on debug mode
    updateDebugModeUI(isDebugMode);
  } catch (e) {
    console.warn("[TMDBG Config] loadDebugSettings failed", e);
  }
}

export async function handleDebugChange(e, getBackendUrl) {
  // Auto-save debug settings checkbox
  if (e.target.id === "debug-mode") {
    const enabled = e.target.checked;
    await browser.storage.local.set({ debugMode: enabled });

    // Update UI to show/hide debug-only sections
    updateDebugModeUI(enabled);

    // Only show status message when enabling debug mode
    if (enabled) {
      const backendUrl = await getBackendUrl();
      console.log(
        `[TMDBG Config] Debug mode enabled, backend: ${backendUrl}, chat logs: enabled`,
      );
      $("status").textContent = `Debug mode enabled. Backend: ${backendUrl}, Chat logs: enabled`;
    } else {
      console.log(`[TMDBG Config] Debug mode disabled`);
      $("status").textContent = "";
    }
  }
}

