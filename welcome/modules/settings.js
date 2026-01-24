/**
 * Welcome wizard settings persistence (mostly logs; prefs applied on change)
 */

export function createSettings({
  flattenedSteps,
}) {
  /**
   * Save settings for a specific step
   * @param {number} stepIndex - Step index
   */
  async function saveStepSettings(stepIndex) {
    const stepInfo = flattenedSteps[stepIndex];
    if (!stepInfo) return;

    console.log(`[Welcome] Saving settings for step ${stepIndex} (${stepInfo.stepId})`);

    switch (stepInfo.stepId) {
      case "theme":
        await saveThemeSetting();
        break;
      case "view-mode":
        await saveViewModeSetting();
        break;
      case "sort-order":
        await saveSortOrderSetting();
        break;
      case "calendar-contacts":
        await saveCalendarContactSettings();
        break;
    }
  }

  /**
   * Save theme setting (preference is applied immediately on radio change)
   */
  async function saveThemeSetting() {
    try {
      // If no radio is checked, default to "system"
      const themeValue = document.querySelector('input[name="theme"]:checked')?.value || "system";
      // Preference is already applied via handlers to TB prefs
      // No need to save to storage - we read from live TB prefs
      console.log(`[Welcome] Theme preference saved to TB prefs: ${themeValue}`);
    } catch (e) {
      console.error("[Welcome] Failed to save theme setting:", e);
    }
  }

  /**
   * Save view mode setting (preference is applied immediately on radio change)
   */
  async function saveViewModeSetting() {
    try {
      const viewMode = document.querySelector('input[name="view-mode"]:checked')?.value || "relaxed";
      // Preference is already applied via handlers to TB prefs
      // No need to save to storage - we read from live TB prefs
      console.log(`[Welcome] View mode saved to TB prefs: ${viewMode}`);
    } catch (e) {
      console.error("[Welcome] Failed to save view mode setting:", e);
    }
  }

  /**
   * Save sort order setting (preference is applied immediately on radio change)
   */
  async function saveSortOrderSetting() {
    try {
      const sortOrder = document.querySelector('input[name="sort-order"]:checked')?.value || "descending";
      // Preference is already applied via handlers to TB prefs
      // No need to save to storage - we read from live TB prefs
      console.log(`[Welcome] Sort order saved to TB prefs: ${sortOrder}`);
    } catch (e) {
      console.error("[Welcome] Failed to save sort order setting:", e);
    }
  }

  /**
   * Legacy: Save tag-based sorting setting (kept for debugging / historical reference)
   */
  async function saveTagBasedSortingSetting() {
    try {
      const value = document.querySelector('input[name="tag-sort"]:checked')?.value || "enabled";
      console.log(`[Welcome] Tag-based sorting saved to TB prefs: ${value}`);
    } catch (e) {
      console.error("[Welcome] Failed to save tag-based sorting setting:", e);
    }
  }

  /**
   * Save calendar and contact settings
   */
  async function saveCalendarContactSettings() {
    try {
      const calendarSelect = document.getElementById("default-calendar");
      const addressBookSelect = document.getElementById("default-addressbook");

      if (calendarSelect && calendarSelect.value) {
        await browser.storage.local.set({ defaultCalendarId: calendarSelect.value });
        console.log(`[Welcome] Default calendar saved: ${calendarSelect.value}`);
      }

      if (addressBookSelect && addressBookSelect.value) {
        await browser.storage.local.set({ defaultAddressBookId: addressBookSelect.value });
        console.log(`[Welcome] Default address book saved: ${addressBookSelect.value}`);
      }
    } catch (e) {
      console.error("[Welcome] Failed to save calendar/contact settings:", e);
    }
  }

  return {
    saveStepSettings,
    // Expose legacy for completeness (not used in flow)
    saveTagBasedSortingSetting,
  };
}

