import { $ } from "./dom.js";
import { run as changeSettingRun } from "../../chat/tools/change_setting.js";

// Storage keys — must match proactiveCheckin.js STORAGE constants
const STORAGE = {
  ENABLED: "notifications.proactive_enabled",
  INTERVAL: "proactiveCheckinIntervalMinutes",  // legacy, kept for UI
  WINDOW_DAYS: "notifications.new_reminder_window_days",
  ADVANCE_MINUTES: "notifications.due_reminder_advance_minutes",
  GRACE_MINUTES: "notifications.grace_minutes",
};

const DEFAULTS = {
  enabled: false,
  interval: 5,
  windowDays: 7,
  advanceMinutes: 30,
  graceMinutes: 5,
};

/**
 * Load notification settings from storage and update UI.
 */
export async function loadNotificationSettings(log) {
  try {
    const stored = await browser.storage.local.get({
      [STORAGE.ENABLED]: DEFAULTS.enabled,
      [STORAGE.INTERVAL]: DEFAULTS.interval,
      [STORAGE.WINDOW_DAYS]: DEFAULTS.windowDays,
      [STORAGE.ADVANCE_MINUTES]: DEFAULTS.advanceMinutes,
      [STORAGE.GRACE_MINUTES]: DEFAULTS.graceMinutes,
    });

    const enabled = stored[STORAGE.ENABLED] === true;
    const interval = Number(stored[STORAGE.INTERVAL]) || DEFAULTS.interval;
    const windowDays = Number(stored[STORAGE.WINDOW_DAYS]) || DEFAULTS.windowDays;
    const advanceMinutes = Number(stored[STORAGE.ADVANCE_MINUTES]) || DEFAULTS.advanceMinutes;
    const graceMinutes = Number(stored[STORAGE.GRACE_MINUTES]) || DEFAULTS.graceMinutes;

    const cb = $("proactive-checkin-enabled");
    if (cb) cb.checked = enabled;

    const intervalInput = $("proactive-checkin-interval");
    if (intervalInput) intervalInput.value = interval;

    const windowInput = $("notif-window-days");
    if (windowInput) windowInput.value = windowDays;

    const advanceInput = $("notif-advance-minutes");
    if (advanceInput) advanceInput.value = advanceMinutes;

    const graceInput = $("notif-grace-minutes");
    if (graceInput) graceInput.value = graceMinutes;

    log(`[Config] Notification settings loaded: enabled=${enabled}, interval=${interval}min, window=${windowDays}d, advance=${advanceMinutes}min, grace=${graceMinutes}min`);
  } catch (e) {
    log(`[Config] loadNotificationSettings failed: ${e}`, "error");
  }
}

/**
 * Handle notification setting changes (checkbox + number inputs).
 * Delegates to change_setting tool for storage persistence + KB sync.
 */
export async function handleNotificationChange(e) {
  // Proactive enabled toggle
  if (e.target.id === "proactive-checkin-enabled") {
    const enabled = e.target.checked === true;
    try {
      const res = await changeSettingRun({ setting: "notifications.proactive_enabled", value: enabled });
      if (res?.ok) {
        console.log(`[Config] Proactive check-in ${enabled ? "enabled" : "disabled"}`);
        $("status").textContent = enabled ? "Proactive chat enabled" : "Proactive chat disabled";
      } else {
        console.error("[Config] change_setting returned error:", res?.error);
        $("status").textContent = res?.error || "Error saving notification setting";
      }
    } catch (err) {
      console.error("[Config] Failed to save notification setting:", err);
      $("status").textContent = "Error saving notification setting";
    }
  }

  // Minimum interval between check-ins (legacy, not KB-synced)
  if (e.target.id === "proactive-checkin-interval") {
    const raw = Number(e.target.value);
    const clamped = Math.max(1, Math.min(60, Math.round(raw) || DEFAULTS.interval));
    if (e.target.value !== String(clamped)) e.target.value = clamped;
    try {
      await browser.storage.local.set({ [STORAGE.INTERVAL]: clamped });
      console.log(`[Config] Proactive check-in interval set to ${clamped} min`);
      $("status").textContent = `Check interval set to ${clamped} min`;
    } catch (err) {
      console.error("[Config] Failed to save check interval:", err);
      $("status").textContent = "Error saving check interval";
    }
  }

  // Advance minutes before due time
  if (e.target.id === "notif-advance-minutes") {
    const raw = Number(e.target.value);
    const clamped = Math.max(5, Math.min(120, Math.round(raw) || DEFAULTS.advanceMinutes));
    if (e.target.value !== String(clamped)) e.target.value = clamped;
    try {
      const res = await changeSettingRun({ setting: "notifications.due_reminder_advance_minutes", value: clamped });
      if (res?.ok) {
        console.log(`[Config] Advance minutes set to ${clamped}`);
        $("status").textContent = `Advance minutes set to ${clamped}`;
      } else {
        $("status").textContent = res?.error || "Error saving advance minutes";
      }
    } catch (err) {
      console.error("[Config] Failed to save advance minutes:", err);
      $("status").textContent = "Error saving advance minutes";
    }
  }

  // New reminder window days
  if (e.target.id === "notif-window-days") {
    const raw = Number(e.target.value);
    const clamped = Math.max(1, Math.min(30, Math.round(raw) || DEFAULTS.windowDays));
    if (e.target.value !== String(clamped)) e.target.value = clamped;
    try {
      const res = await changeSettingRun({ setting: "notifications.new_reminder_window_days", value: clamped });
      if (res?.ok) {
        console.log(`[Config] New reminder window set to ${clamped} days`);
        $("status").textContent = `Reminder window set to ${clamped} days`;
      } else {
        $("status").textContent = res?.error || "Error saving reminder window";
      }
    } catch (err) {
      console.error("[Config] Failed to save reminder window:", err);
      $("status").textContent = "Error saving reminder window";
    }
  }

  // Grace minutes
  if (e.target.id === "notif-grace-minutes") {
    const raw = Number(e.target.value);
    const clamped = Math.max(1, Math.min(30, Math.round(raw) || DEFAULTS.graceMinutes));
    if (e.target.value !== String(clamped)) e.target.value = clamped;
    try {
      const res = await changeSettingRun({ setting: "notifications.grace_minutes", value: clamped });
      if (res?.ok) {
        console.log(`[Config] Grace minutes set to ${clamped}`);
        $("status").textContent = `Grace minutes set to ${clamped}`;
      } else {
        $("status").textContent = res?.error || "Error saving grace minutes";
      }
    } catch (err) {
      console.error("[Config] Failed to save grace minutes:", err);
      $("status").textContent = "Error saving grace minutes";
    }
  }
}
