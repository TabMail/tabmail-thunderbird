/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export const FTS_HELPER_DOWNLOAD_URL = "https://tabmail.ai/download#fts-helper";

/**
 * Shared popup/settings copy for a helper that needs user action.
 * Returns null while availability is unknown or the helper is usable.
 */
export function getFtsHelperPrompt(availability) {
  if (availability?.available !== false) return null;

  if (availability.status === "unsupported") {
    return {
      title: "🔍 Search helper update required",
      message: "Your version of Native FTS is no longer supported. Re-download and reinstall the latest helper to continue using local search. Your existing search index will be preserved.",
      buttonLabel: "Re-download Search Helper →",
      statsLabel: "Native search helper update required.",
      versionLabel: availability.hostVersion
        ? `Unsupported (v${availability.hostVersion})`
        : "Unsupported",
    };
  }

  return {
    title: "🔍 Search helper not installed",
    message: "Install the native search helper to enable fast local search across your mail. It runs entirely on your device, and Thunderbird will detect it automatically.",
    buttonLabel: "Install Search Helper →",
    statsLabel: "Native search helper not installed.",
    versionLabel: "Not installed",
  };
}
