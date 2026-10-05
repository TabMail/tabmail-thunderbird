/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SETTINGS } from "./config.js";

export const ACTION_CONFIG_KEY = "user_prompts:action_config";
export const ACTION_CONFIG_TS_KEY = "device_sync_ts:actionConfig";

// Device Sync's "never edited" timestamp (EPOCH_ZERO in deviceSync.js). Every local
// save and every accepted sync write stamps a real timestamp.
const NEVER_EDITED_TS = "1970-01-01T00:00:00.000Z";

function resolveThreshold(value, { fallback, legacyDefault, min, max }, neverEdited) {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  if (neverEdited && value === legacyDefault) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Effective compaction thresholds for a stored `user_prompts:action_config`.
 * A value still at the legacy default that was never edited moves to the current
 * default; every value is clamped to the slider range.
 * @param {object|undefined} config - Stored `{compact_threshold, compact_threshold_chars}`
 * @param {string|undefined} updatedAt - Stored `device_sync_ts:actionConfig`
 */
export function resolveActionConfig(config, updatedAt) {
  const c = SETTINGS.actionCompaction;
  const neverEdited = !updatedAt || updatedAt === NEVER_EDITED_TS;
  return {
    compact_threshold: resolveThreshold(config?.compact_threshold, {
      fallback: c.defaultRules, legacyDefault: c.legacyDefaultRules, min: c.minRules, max: c.maxRules,
    }, neverEdited),
    compact_threshold_chars: resolveThreshold(config?.compact_threshold_chars, {
      fallback: c.defaultChars, legacyDefault: c.legacyDefaultChars, min: c.minChars, max: c.maxChars,
    }, neverEdited),
  };
}

/** Read and resolve this device's compaction thresholds. */
export async function readActionConfig() {
  const stored = await browser.storage.local.get([ACTION_CONFIG_KEY, ACTION_CONFIG_TS_KEY]);
  return resolveActionConfig(stored[ACTION_CONFIG_KEY], stored[ACTION_CONFIG_TS_KEY]);
}
