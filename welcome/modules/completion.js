/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Welcome wizard completion
 */

export function createCompletion({ saveStepSettings, getCurrentStep }) {
  /**
   * Complete the wizard and close
   */
  async function finishWizard() {
    console.log("[Welcome] Finishing wizard");

    try {
      // Save final step settings
      await saveStepSettings(getCurrentStep());

      // Note: Welcome is already marked as completed on init() so it only shows once
      // No need to set it again here

      console.log("[Welcome] Welcome wizard finished");

      window.close();
    } catch (e) {
      console.error("[Welcome] Failed to finish wizard:", e);
    }
  }

  return { finishWizard };
}

