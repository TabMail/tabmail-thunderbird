/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// summaryDisplaySettings.js – "Show AI Summaries" display preference (TB 145, MV3)
//
// DISPLAY only. When off, the summary bubble above the message is not shown;
// summary generation, caching and action tagging keep running exactly as
// before, so turning it back on shows the retained summaries immediately.
// Surfaced in Settings → Appearance (issue #34; iOS counterpart tabmail-ios #153).

import { log } from "./utils.js";

export const SUMMARY_DISPLAY_STORAGE_KEYS = {
  showAiSummaries: "showAiSummariesEnabled",
};

export const SUMMARY_DISPLAY_DEFAULTS = {
  [SUMMARY_DISPLAY_STORAGE_KEYS.showAiSummaries]: true,
};

/**
 * Default ON: only an explicit stored `false` hides summaries, so a missing or
 * malformed value never silently inverts the default.
 */
export async function getShowAiSummariesEnabled() {
  try {
    const stored = await browser.storage.local.get(SUMMARY_DISPLAY_DEFAULTS);
    return stored?.[SUMMARY_DISPLAY_STORAGE_KEYS.showAiSummaries] !== false;
  } catch (e) {
    log(`[SummaryDisplay] Failed to read display settings from storage: ${e}`, "error");
    // A storage read failure must not hide the user's summaries.
    return true;
  }
}

export async function setShowAiSummariesEnabled(enabled) {
  try {
    const val = enabled !== false;
    await browser.storage.local.set({ [SUMMARY_DISPLAY_STORAGE_KEYS.showAiSummaries]: val });
    log(`[SummaryDisplay] Saved showAiSummariesEnabled=${val}`);
    return true;
  } catch (e) {
    log(`[SummaryDisplay] Failed to save display settings: ${e}`, "error");
    return false;
  }
}
