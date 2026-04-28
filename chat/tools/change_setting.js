// change_setting.js – modify user-facing settings (TB 145, MV3)
// Settings are persisted to browser.storage.local only — NOT synced to KB.
// KB sync was removed because settings are per-device and KB syncs across devices.

import { log } from "../../agent/modules/utils.js";

// Setting definitions: key → { type, min, max, default, storageKey }
const SETTING_DEFS = {
  "privacy.web_search_enabled": {
    type: "boolean",
    default: false,
    storageKey: "webSearchEnabled", // matches WEB_SEARCH_STORAGE_KEY in config/modules/webSearch.js
  },
  "notifications.proactive_enabled": {
    type: "boolean",
    default: false,
  },
  "notifications.new_reminder_window_days": {
    type: "number",
    min: 1,
    max: 30,
    default: 7,
  },
  "notifications.due_reminder_advance_minutes": {
    type: "number",
    min: 5,
    max: 120,
    default: 30,
  },
  "notifications.grace_minutes": {
    type: "number",
    min: 1,
    max: 30,
    default: 5,
  },
  "task.enabled": {
    type: "boolean",
    default: true,
    storageKey: "task.enabled",
  },
  "task.advance_minutes": {
    type: "number",
    min: 1,
    max: 30,
    default: 5,
    storageKey: "task.advance_minutes",
  },
  // Default duration applied client-side when calendar_event_create is invoked
  // without `end_iso`. Mirrors the iOS setting; Options page picker also writes
  // to this same storage key.
  "calendar.default_event_duration_minutes": {
    type: "number",
    min: 5,
    max: 12 * 60,
    default: 45,
    storageKey: "defaultEventDurationMinutes",
  },
};

export async function run(args = {}) {
  try {
    const settingKey = args?.setting;
    let value = args?.value;

    if (!settingKey || !(settingKey in SETTING_DEFS)) {
      log(`[TMDBG Tools] change_setting: unknown setting '${settingKey}'`, "error");
      return { error: `Unknown setting '${settingKey}'. Valid settings: ${Object.keys(SETTING_DEFS).join(", ")}` };
    }

    const def = SETTING_DEFS[settingKey];

    // Validate type
    if (def.type === "boolean") {
      // Accept both native booleans and string "true"/"false" (LLMs sometimes send strings)
      if (typeof value === "string" && (value === "true" || value === "false")) {
        value = value === "true";
      } else if (typeof value !== "boolean") {
        log(`[TMDBG Tools] change_setting: expected boolean for '${settingKey}', got ${typeof value}`, "error");
        return { error: `Setting '${settingKey}' requires a boolean value (true/false).` };
      }
    } else if (def.type === "number") {
      const num = Number(value);
      if (isNaN(num) || !Number.isInteger(num)) {
        log(`[TMDBG Tools] change_setting: expected integer for '${settingKey}', got ${value}`, "error");
        return { error: `Setting '${settingKey}' requires an integer value.` };
      }
      if (num < def.min || num > def.max) {
        log(`[TMDBG Tools] change_setting: value ${num} out of range [${def.min}, ${def.max}] for '${settingKey}'`, "error");
        return { error: `Setting '${settingKey}' must be between ${def.min} and ${def.max}.` };
      }
    }

    // Read previous value (some settings use a different storage key)
    const storeKey = def.storageKey || settingKey;
    const stored = await browser.storage.local.get({ [storeKey]: def.default });
    const previousValue = stored[storeKey];

    // Persist new value
    const effectiveValue = def.type === "number" ? Number(value) : value;
    log(`[TMDBG Tools] change_setting: WRITING storeKey="${storeKey}" effectiveValue=${effectiveValue} (type=${typeof effectiveValue})`);
    await browser.storage.local.set({ [storeKey]: effectiveValue });
    // Verify write
    const verify = await browser.storage.local.get({ [storeKey]: null });
    log(`[TMDBG Tools] change_setting: VERIFY after write: storeKey="${storeKey}" storedValue=${verify[storeKey]} (type=${typeof verify[storeKey]})`);
    log(`[TMDBG Tools] change_setting: set ${settingKey}=${effectiveValue} (was ${previousValue})`);

    // Notify config page so it can refresh if open
    try {
      await browser.runtime.sendMessage({ command: "setting-changed", key: storeKey, value: effectiveValue });
    } catch (_) { /* config page may not be open */ }

    return { ok: true, setting: settingKey, value: effectiveValue, previous_value: previousValue, note: "Setting saved. Tell the user it has been changed. The new value takes effect starting from the next message." };
  } catch (e) {
    log(`[TMDBG Tools] change_setting failed: ${e}`, "error");
    return { error: String(e || "unknown error in change_setting") };
  }
}
