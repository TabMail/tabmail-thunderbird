/**
 * Welcome wizard appearance handlers (theme, view-mode, sort-order)
 */

export function createAppearanceHandlers({
  applyTheme,
  getCurrentTheme,
  getFlattenedSteps,
  getCurrentStep,
  updateThemePageImages,
  updateViewModePageImages,
  updateSortOrderPageImages,
  applyAllUiTweaks,
}) {
  const flattenedSteps = getFlattenedSteps();

  /**
   * Setup theme selection handlers
   */
  function setupThemeHandlers() {
    document.querySelectorAll('input[name="theme"]').forEach(radio => {
      radio.addEventListener("change", async (e) => {
        const theme = e.target.value;
        console.log(`[Welcome] Theme preference changed to: ${theme}`);
        await applyThemePreference(theme);
        // Update view mode page images if we're on that page
        const stepInfo = flattenedSteps[getCurrentStep()];
        if (stepInfo && stepInfo.stepId === "view-mode") {
          await updateViewModePageImages();
        }
      });
    });
  }

  /**
   * Apply theme preference to Thunderbird
   * Delegates to shared applyTheme from config/modules/appearance.js
   * @param {string} theme - "light", "dark", or "system"
   */
  async function applyThemePreference(theme) {
    console.log(`[Welcome] Applying theme preference: ${theme}`);
    await applyTheme(theme);
  }

  /**
   * Restore theme setting from Thunderbird prefs (live setting)
   * Uses shared getCurrentTheme from config/modules/appearance.js
   */
  async function restoreThemeSetting() {
    try {
      const themeValue = await getCurrentTheme();

      const radio = document.querySelector(`input[name="theme"][value="${themeValue}"]`);
      if (radio) {
        radio.checked = true;
        console.log("[Welcome] Restored theme preference from TB prefs:", themeValue);
      }
    } catch (e) {
      console.warn("[Welcome] Failed to restore theme setting:", e);
    }
  }

  /**
   * Setup view mode handlers
   */
  function setupViewModeHandlers({ applyViewModeImmediately }) {
    document.querySelectorAll('input[name="view-mode"]').forEach(radio => {
      radio.addEventListener("change", async (e) => {
        const viewMode = e.target.value;
        console.log(`[Welcome] View mode changed to: ${viewMode}`);
        await applyViewModeImmediately(viewMode);
        // Update theme page images if we're on that page
        const stepInfo = flattenedSteps[getCurrentStep()];
        if (stepInfo && stepInfo.stepId === "theme") {
          await updateThemePageImages();
        }
      });
    });
  }

  /**
   * Restore view mode setting from Thunderbird prefs (live setting)
   */
  async function restoreViewModeSetting() {
    try {
      if (!browser.tmPrefs) {
        console.warn("[Welcome] tmPrefs not available for view mode restore");
        return;
      }

      // Read mail.threadpane.listview: 0 = card (relaxed), 1 = table (compact)
      const listView = await browser.tmPrefs.getIntSafe("mail.threadpane.listview", 0);
      const uiValue = listView === 0 ? "relaxed" : "compact";

      const radio = document.querySelector(`input[name="view-mode"][value="${uiValue}"]`);
      if (radio) {
        radio.checked = true;
        console.log("[Welcome] Restored view mode from TB prefs:", uiValue);
      }
    } catch (e) {
      console.warn("[Welcome] Failed to restore view mode setting:", e);
    }
  }

  /**
   * Setup sort order handlers
   */
  function setupSortOrderHandlers({ applySortOrderImmediately }) {
    document.querySelectorAll('input[name="sort-order"]').forEach(radio => {
      radio.addEventListener("change", async (e) => {
        const sortOrder = e.target.value;
        console.log(`[Welcome] Sort order changed to: ${sortOrder}`);
        await applySortOrderImmediately(sortOrder);
      });
    });
  }

  /**
   * Setup handlers for the "Apply TabMail defaults" step.
   */
  function setupAppearanceDefaultsHandlers() {
    const button = document.getElementById("welcome-apply-appearance-defaults-btn");
    const statusBox = document.getElementById("welcome-appearance-defaults-status");

    if (!button) {
      console.warn("[Welcome] Appearance defaults UI elements not found");
      return;
    }

    button.addEventListener("click", async () => {
      console.log("[Welcome] Apply TabMail defaults button clicked");

      if (statusBox) {
        statusBox.style.display = "flex";
        statusBox.classList.remove("success", "warning");
        statusBox.textContent = "Applying…";
      }

      try {
        const result = await applyAllUiTweaks({ source: "welcome" });
        console.log("[Welcome] applyAllUiTweaks result:", result);
        if (statusBox) {
          statusBox.style.display = "flex";
          if (result && result.ok) {
            statusBox.classList.add("success");
            statusBox.textContent = "✓ Done";
          } else {
            statusBox.classList.add("warning");
            statusBox.textContent = `Could not apply (${result?.reason || "unknown"})`;
          }
        }
      } catch (e) {
        console.error("[Welcome] Failed to apply TabMail defaults", e);
        if (statusBox) {
          statusBox.style.display = "flex";
          statusBox.classList.add("warning");
          statusBox.textContent = "Could not apply (exception)";
        }
      }
    });
  }

  /**
   * Restore sort order setting from Thunderbird prefs (live setting)
   */
  async function restoreSortOrderSetting() {
    try {
      if (!browser.tmPrefs) {
        console.warn("[Welcome] tmPrefs not available for sort order restore");
        return;
      }

      // Read from TB prefs (2 = new message on top, 1 = new message bottom)
      const sortOrderInt = await browser.tmPrefs.getIntSafe("mailnews.default_sort_order", 2);
      const sortOrder = sortOrderInt === 1 ? "ascending" : "descending";
      const radio = document.querySelector(`input[name="sort-order"][value="${sortOrder}"]`);
      if (radio) {
        radio.checked = true;
        console.log("[Welcome] Restored sort order from TB prefs:", sortOrder);
      }
    } catch (e) {
      console.warn("[Welcome] Failed to restore sort order setting:", e);
    }
  }

  /**
   * Apply sort order change immediately to Thunderbird
   * @param {string} sortOrder - "ascending" or "descending"
   */
  async function applySortOrderImmediately(sortOrder) {
    try {
      if (!browser.tmPrefs) {
        console.warn("[Welcome] tmPrefs API not available for sort order settings.");
        return;
      }

      // Set the TB pref (2 = new message on top, 1 = new message bottom)
      const sortOrderInt = sortOrder === "ascending" ? 1 : 2;
      await browser.tmPrefs.setInt("mailnews.default_sort_order", sortOrderInt);
      console.log(`[Welcome] Set sort order pref to ${sortOrderInt} (${sortOrder})`);

      // Trigger immediate sort refresh
      if (browser.tagSort && browser.tagSort.refreshImmediate) {
        browser.tagSort.refreshImmediate();
        console.log("[Welcome] Triggered immediate tagSort refresh");
      }
    } catch (e) {
      console.error("[Welcome] Failed to apply sort order immediately:", e);
    }
  }

  /**
   * Legacy: Setup tag-based sorting handlers (kept for debugging / historical reference)
   */
  function setupTagBasedSortingHandlers({ applyTagSortImmediately }) {
    document.querySelectorAll('input[name="tag-sort"]').forEach(radio => {
      radio.addEventListener("change", async (e) => {
        const enabled = e.target.value === "enabled";
        console.log(`[Welcome] Tag-based sorting changed to: ${enabled}`);
        await applyTagSortImmediately(enabled);
      });
    });
  }

  /**
   * Legacy: Restore tag-based sorting setting from Thunderbird prefs (live setting)
   */
  async function restoreTagSortSetting() {
    try {
      if (!browser.tmPrefs) {
        console.warn("[Welcome] tmPrefs not available for tag sort restore");
        return;
      }

      // Read from TB prefs (1 = enabled, 0 = disabled, default = 1)
      const tagSortEnabled = await browser.tmPrefs.getIntSafe("extensions.tabmail.tagSortEnabled", 1);
      const value = tagSortEnabled === 1 ? "enabled" : "disabled";
      const radio = document.querySelector(`input[name="tag-sort"][value="${value}"]`);
      if (radio) {
        radio.checked = true;
        console.log("[Welcome] Restored tag-based sorting from TB prefs:", value);
      }
    } catch (e) {
      console.warn("[Welcome] Failed to restore tag-based sorting setting:", e);
    }
  }

  /**
   * Apply tag-based sorting change immediately to Thunderbird
   * @param {boolean} enabled - Whether tag-based sorting is enabled
   */
  async function applyTagSortImmediately(enabled) {
    try {
      if (!browser.tmPrefs) {
        console.warn("[Welcome] tmPrefs API not available for tag sort settings.");
        return;
      }

      // Set the TB pref (1 = enabled, 0 = disabled)
      const tagSortInt = enabled ? 1 : 0;
      await browser.tmPrefs.setInt("extensions.tabmail.tagSortEnabled", tagSortInt);
      console.log(`[Welcome] Set tag sort enabled pref to ${tagSortInt} (${enabled ? "enabled" : "disabled"})`);

      // Trigger immediate sort refresh
      if (browser.tagSort && browser.tagSort.refreshImmediate) {
        browser.tagSort.refreshImmediate();
        console.log("[Welcome] Triggered immediate tagSort refresh");
      }
    } catch (e) {
      console.error("[Welcome] Failed to apply tag-based sorting immediately:", e);
    }
  }

  /**
   * Apply view mode change immediately to Thunderbird
   * @param {string} viewMode - "relaxed" or "compact"
   */
  async function applyViewModeImmediately(viewMode) {
    try {
      if (typeof browser === "undefined" || !browser.tmPrefs) {
        console.warn("[Welcome] tmPrefs API not available for immediate view mode change");
        return;
      }

      const VIEW_MODE_CONFIG = {
        prefs: {
          listView: "mail.threadpane.listview",
          cardViewRowCount: "mail.threadpane.cardsview.rowcount",
          density: "mail.uidensity",
        },
        // Keep numeric knobs in module config (not hardcoded in logic)
        defaults: {
          cardViewRowCount: 3,
          density: 0,
        },
      };

      // listView: 0 = card (relaxed), 1 = table (compact)
      const listViewValue = viewMode === "relaxed" ? 0 : 1;

      await browser.tmPrefs.setInt(VIEW_MODE_CONFIG.prefs.listView, listViewValue);
      console.log(
        `[Welcome] Set listView pref: ${VIEW_MODE_CONFIG.prefs.listView}=${listViewValue}`,
      );

      if (viewMode === "relaxed") {
        await browser.tmPrefs.setInt(
          VIEW_MODE_CONFIG.prefs.cardViewRowCount,
          VIEW_MODE_CONFIG.defaults.cardViewRowCount
        );
        console.log(
          `[Welcome] Set cardViewRowCount pref: ${VIEW_MODE_CONFIG.prefs.cardViewRowCount}=${VIEW_MODE_CONFIG.defaults.cardViewRowCount}`,
        );
      }

      await browser.tmPrefs.setInt(
        VIEW_MODE_CONFIG.prefs.density,
        VIEW_MODE_CONFIG.defaults.density
      );
      console.log(
        `[Welcome] Set density pref: ${VIEW_MODE_CONFIG.prefs.density}=${VIEW_MODE_CONFIG.defaults.density}`,
      );

      // View mode is now tied to inbox sorting:
      // - Card (relaxed) => date-based sorting (tag sort disabled)
      // - Table (compact) => TabMail tag-based sorting enabled
      const tagSortEnabled = viewMode === "compact";
      console.log(
        `[Welcome] Applying tied inbox sorting: viewMode=${viewMode} => tagSortEnabled=${tagSortEnabled}`,
      );
      await applyTagSortImmediately(tagSortEnabled);

      console.log(`[Welcome] Applied view mode immediately: ${viewMode} (listView=${listViewValue})`);
    } catch (e) {
      console.warn("[Welcome] Failed to apply view mode immediately:", e);
    }
  }

  return {
    setupThemeHandlers,
    restoreThemeSetting,
    setupViewModeHandlers,
    restoreViewModeSetting,
    setupSortOrderHandlers,
    restoreSortOrderSetting,
    setupAppearanceDefaultsHandlers,
    applySortOrderImmediately,
    applyTagSortImmediately,
    applyViewModeImmediately,
    // legacy
    setupTagBasedSortingHandlers,
    restoreTagSortSetting,
  };
}

