// privacySettings.js – Central privacy/opt-out settings for TabMail (TB 145, MV3)

import { log } from "../../agent/modules/utils.js";

export const PRIVACY_STORAGE_KEYS = {
  optOutAllAi: "privacy_opt_out_all_ai",
};

export const PRIVACY_DEFAULTS = {
  [PRIVACY_STORAGE_KEYS.optOutAllAi]: false,
};

export const PRIVACY_OPT_OUT_ERROR_MESSAGE =
  "Privacy opt-out is enabled (Settings → Privacy). This disables ALL AI features. Turn it off to use TabMail AI.";

export async function getPrivacyOptOutAllAiEnabled() {
  try {
    const stored = await browser.storage.local.get(PRIVACY_DEFAULTS);
    const enabled = stored?.[PRIVACY_STORAGE_KEYS.optOutAllAi] === true;
    return enabled;
  } catch (e) {
    log(`[PRIVACY] Failed to read privacy settings from storage: ${e}`, "error");
    // If storage read fails, default to not opted out (do not add fallback behavior).
    return false;
  }
}

export async function setPrivacyOptOutAllAiEnabled(enabled) {
  try {
    const val = enabled === true;
    await browser.storage.local.set({ [PRIVACY_STORAGE_KEYS.optOutAllAi]: val });
    log(`[PRIVACY] Saved optOutAllAi=${val}`);
    return true;
  } catch (e) {
    log(`[PRIVACY] Failed to save privacy settings: ${e}`, "error");
    return false;
  }
}

export async function assertAiBackendAllowed(contextLabel = "") {
  const enabled = await getPrivacyOptOutAllAiEnabled();
  if (!enabled) return;

  const ctx = contextLabel ? ` (${contextLabel})` : "";
  log(`[PRIVACY] Opt-out enabled; blocking AI/backend request${ctx}`, "warn");
  const err = new Error(PRIVACY_OPT_OUT_ERROR_MESSAGE);
  err.name = "PrivacyOptOutError";
  throw err;
}


