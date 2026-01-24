import { $ } from "./dom.js";

// Welcome wizard debug functions
export async function updateWelcomeStatusDisplay(log) {
  const statusIcon = $("welcome-status-icon");
  const statusText = $("welcome-status-text");

  if (!statusIcon || !statusText) return;

  try {
    const stored = await browser.storage.local.get({
      tabmailWelcomeCompleted: false,
      tabmailWelcomeCompletedAt: null,
    });

    if (stored.tabmailWelcomeCompleted) {
      const completedAt = stored.tabmailWelcomeCompletedAt;
      let dateStr = "Unknown date";
      if (completedAt) {
        const d = new Date(completedAt);
        dateStr = d.toLocaleString();
      }
      statusIcon.textContent = "✅";
      statusText.textContent = `Completed on ${dateStr}`;
      statusText.style.color = "var(--tag-tm-reply)";
    } else {
      statusIcon.textContent = "⏸️";
      statusText.textContent =
        "Not completed (will show on next install/reload)";
      statusText.style.color = "var(--tag-tm-archive)";
    }

    log(`[TMDBG Config] Welcome status: completed=${stored.tabmailWelcomeCompleted}`);
  } catch (e) {
    console.warn("[TMDBG Config] updateWelcomeStatusDisplay failed", e);
    statusIcon.textContent = "❌";
    statusText.textContent = "Error checking status";
    statusText.style.color = "var(--tag-tm-delete)";
  }
}

export async function openWelcomeWizard(SETTINGS) {
  try {
    const url = browser.runtime.getURL("welcome/welcome.html");

    // Get welcome window dimensions from config
    const welcomeWindowConfig = SETTINGS.welcomeWindow || {
      defaultWidth: 780,
      defaultHeight: 680,
    };

    // Create popup window for welcome wizard (same pattern as auth window)
    const win = await browser.windows.create({
      url,
      type: "popup",
      width: welcomeWindowConfig.defaultWidth,
      height: welcomeWindowConfig.defaultHeight,
    });

    console.log(`[TMDBG Config] Created welcome wizard window with ID: ${win.id}`);
    $("status").textContent = "Welcome wizard opened";
  } catch (e) {
    console.error("[TMDBG Config] openWelcomeWizard failed", e);
    $("status").textContent = "Failed to open welcome wizard: " + e.message;
  }
}

export async function clearWelcomeStatus(updateWelcomeStatusDisplayFn) {
  try {
    await browser.storage.local.remove([
      "tabmailWelcomeCompleted",
      "tabmailWelcomeCompletedAt",
    ]);

    await updateWelcomeStatusDisplayFn();

    $("status").textContent =
      "Welcome wizard status cleared - will show on next trigger";
    console.log("[TMDBG Config] Welcome wizard status cleared");
  } catch (e) {
    console.error("[TMDBG Config] clearWelcomeStatus failed", e);
    $("status").textContent = "Failed to clear welcome status: " + e.message;
  }
}

