import { $ } from "./dom.js";

export async function loadReminderSettings(log) {
  try {
    // Load both basic and debug inputs
    const inputBasic = $("max-reminders-to-show-basic");
    const inputDebug = $("max-reminders-to-show");

    // Load from storage or use default (from config.js: maxRemindersToShow: 3)
    const stored = await browser.storage.local.get({ maxRemindersToShow: 3 });
    const value = stored.maxRemindersToShow || 3;

    if (inputBasic) {
      inputBasic.value = value;
    }
    if (inputDebug) {
      inputDebug.value = value;
    }

    log(
      `[TMDBG Config] Loaded reminder settings: maxRemindersToShow=${value}`,
    );
  } catch (e) {
    console.warn("[TMDBG Config] loadReminderSettings failed", e);
  }
}

export async function saveReminderSettings(log) {
  try {
    // Try basic input first, fallback to debug input
    const input = $("max-reminders-to-show-basic") || $("max-reminders-to-show");
    if (!input) return;

    const value = parseInt(input?.value, 10) || 3;

    // Clamp to valid range (1-5)
    const clampedValue = Math.max(1, Math.min(5, value));

    await browser.storage.local.set({ maxRemindersToShow: clampedValue });

    // Update both inputs if they exist
    const inputBasic = $("max-reminders-to-show-basic");
    const inputDebug = $("max-reminders-to-show");
    if (inputBasic) inputBasic.value = clampedValue;
    if (inputDebug) inputDebug.value = clampedValue;

    $("status").textContent = `Saved: Reminders to show = ${clampedValue}`;

    log(`[TMDBG Config] Saved reminder settings: maxRemindersToShow=${clampedValue}`);

    // Clear status after 3 seconds
    setTimeout(() => {
      $("status").textContent = "";
    }, 3000);
  } catch (e) {
    console.warn("[TMDBG Config] saveReminderSettings failed", e);
    $("status").textContent = "Error saving reminder settings";
  }
}

export async function handleReminderChange(e, log) {
  // Handle change events for auto-save
  if (e.target.id === "max-reminders-to-show-basic" || e.target.id === "max-reminders-to-show") {
    await saveReminderSettings(log);
  }
}

