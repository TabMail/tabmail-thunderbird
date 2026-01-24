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

