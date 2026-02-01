import { $ } from "./dom.js";

export const PROACTIVE_CHECKIN_STORAGE_KEY = "proactiveCheckinEnabled";
export const PROACTIVE_CHECKIN_DEFAULT = true;
export const PROACTIVE_CHECKIN_INTERVAL_KEY = "proactiveCheckinIntervalMinutes";
export const PROACTIVE_CHECKIN_INTERVAL_DEFAULT = 5;

/**
 * Load notification settings from storage and update UI.
 */
export async function loadNotificationSettings(log) {
  try {
    const stored = await browser.storage.local.get({
      [PROACTIVE_CHECKIN_STORAGE_KEY]: PROACTIVE_CHECKIN_DEFAULT,
      [PROACTIVE_CHECKIN_INTERVAL_KEY]: PROACTIVE_CHECKIN_INTERVAL_DEFAULT,
    });
    const enabled = stored[PROACTIVE_CHECKIN_STORAGE_KEY] === true;
    const interval = Number(stored[PROACTIVE_CHECKIN_INTERVAL_KEY]) || PROACTIVE_CHECKIN_INTERVAL_DEFAULT;

    const cb = $("proactive-checkin-enabled");
    if (cb) cb.checked = enabled;

    const intervalInput = $("proactive-checkin-interval");
    if (intervalInput) intervalInput.value = interval;

    log(`[Config] Notification settings loaded: proactiveCheckin=${enabled}, interval=${interval}min`);
  } catch (e) {
    log(`[Config] loadNotificationSettings failed: ${e}`, "error");
  }
}

/**
 * Handle notification setting changes (checkbox + interval input).
 */
export async function handleNotificationChange(e) {
  if (e.target.id === "proactive-checkin-enabled") {
    const enabled = e.target.checked === true;
    try {
      await browser.storage.local.set({ [PROACTIVE_CHECKIN_STORAGE_KEY]: enabled });
      console.log(`[Config] Proactive check-in ${enabled ? "enabled" : "disabled"}`);
      $("status").textContent = enabled
        ? "Proactive chat enabled"
        : "Proactive chat disabled";
    } catch (err) {
      console.error("[Config] Failed to save notification setting:", err);
      $("status").textContent = "Error saving notification setting";
    }
  }

  if (e.target.id === "proactive-checkin-interval") {
    const raw = Number(e.target.value);
    const clamped = Math.max(1, Math.min(60, Math.round(raw) || PROACTIVE_CHECKIN_INTERVAL_DEFAULT));
    if (e.target.value !== String(clamped)) e.target.value = clamped;
    try {
      await browser.storage.local.set({ [PROACTIVE_CHECKIN_INTERVAL_KEY]: clamped });
      console.log(`[Config] Proactive check-in interval set to ${clamped} min`);
      $("status").textContent = `Check interval set to ${clamped} min`;
    } catch (err) {
      console.error("[Config] Failed to save check interval:", err);
      $("status").textContent = "Error saving check interval";
    }
  }
}
