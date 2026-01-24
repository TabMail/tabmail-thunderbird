/**
 * Welcome wizard dynamic image updates (based on theme/view)
 */

/**
 * Get current view mode from TB prefs
 * @returns {Promise<string>} "relaxed" or "compact"
 */
export async function getCurrentViewMode() {
  try {
    if (!browser.tmPrefs) return "relaxed";

    const listView = await browser.tmPrefs.getIntSafe("mail.threadpane.listview", 0);
    return listView === 0 ? "relaxed" : "compact";
  } catch (e) {
    return "relaxed";
  }
}

export function createDynamicImages({ getCurrentTheme }) {
  /**
   * Update dynamic images based on current theme/view mode for a specific step
   * @param {string} stepId - Step ID
   */
  async function updateDynamicImages(stepId) {
    if (stepId === "theme") {
      await updateThemePageImages();
    } else if (stepId === "view-mode") {
      await updateViewModePageImages();
    } else if (stepId === "sort-order") {
      await updateSortOrderPageImages();
    }
  }

  /**
   * Update images on theme page
   */
  async function updateThemePageImages() {
    // Update light theme image
    const lightImg = document.querySelector('.theme-preview-light .asset-image');
    if (lightImg) {
      lightImg.src = "assets/light-card-view.webp";
      console.log("[Welcome] Updated light theme image to: light-card-view.webp");
    }

    // Update dark theme image
    const darkImg = document.querySelector('.theme-preview-dark .asset-image');
    if (darkImg) {
      darkImg.src = "assets/dark-card-view.webp";
      console.log("[Welcome] Updated dark theme image to: dark-card-view.webp");
    }
  }

  /**
   * Update images on view mode page based on current theme
   */
  async function updateViewModePageImages() {
    const currentTheme = await getCurrentTheme();
    // For view mode, we need to determine which theme to show
    // If system, check OS preference
    let themeToUse = currentTheme;
    if (currentTheme === "system") {
      const isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      themeToUse = isDark ? "dark" : "light";
    }

    // Update card view image (relaxed)
    const relaxedImg = document.querySelector('input[name="view-mode"][value="relaxed"]')?.closest('.option-card-large')?.querySelector('.asset-image');
    if (relaxedImg) {
      relaxedImg.src = `assets/${themeToUse}-card-view.webp`;
      console.log(`[Welcome] Updated card view image to: ${themeToUse}-card-view.webp`);
    }

    // Update table view image (compact)
    const compactImg = document.querySelector('input[name="view-mode"][value="compact"]')?.closest('.option-card-large')?.querySelector('.asset-image');
    if (compactImg) {
      compactImg.src = `assets/${themeToUse}-table-view.webp`;
      console.log(`[Welcome] Updated table view image to: ${themeToUse}-table-view.webp`);
    }

    // Update toggle-menu callout image
    const toggleMenuImg = document.getElementById("toggle-menu-callout-image");
    if (toggleMenuImg) {
      toggleMenuImg.src = `assets/${themeToUse}-toggle-menu.webp`;
      console.log(`[Welcome] Updated toggle menu callout image to: ${themeToUse}-toggle-menu.webp`);
    }
  }

  /**
   * Update images on sort-order page based on current theme
   * Uses the same toggle-menu image as view-mode page (highlights arrow button)
   */
  async function updateSortOrderPageImages() {
    const currentTheme = await getCurrentTheme();

    // If system, check OS preference
    let themeToUse = currentTheme;
    if (currentTheme === "system") {
      const isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      themeToUse = isDark ? "dark" : "light";
    }

    const sortOrderImg = document.getElementById("sort-order-callout-image");
    if (sortOrderImg) {
      sortOrderImg.src = `assets/${themeToUse}-toggle-menu.webp`;
      console.log(`[Welcome] Updated sort-order callout image to: ${themeToUse}-toggle-menu.webp`);
    }
  }

  /**
   * Legacy: Tag-based sorting page images (kept for debugging / historical reference)
   */
  async function updateTagBasedSortingPageImages() {
    const currentTheme = await getCurrentTheme();
    // If system, check OS preference
    let themeToUse = currentTheme;
    if (currentTheme === "system") {
      const isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      themeToUse = isDark ? "dark" : "light";
    }

    // Determine suffix for dark mode
    const themeSuffix = themeToUse === "dark" ? "-dark" : "";
    console.log(`[Welcome] Updating tag-based-sorting images for theme: ${themeToUse}`);

    // Update "Sort by Tags" image (wizard uses tag-sort/enabled, config uses inbox-sort/tags)
    let tagsImg = document.querySelector('input[name="tag-sort"][value="enabled"]')?.closest('.option-card-large')?.querySelector('.asset-image');
    if (!tagsImg) {
      tagsImg = document.querySelector('input[name="inbox-sort"][value="tags"]')?.closest('.option-card-large')?.querySelector('.asset-image');
    }
    if (tagsImg) {
      tagsImg.src = `assets/example-tagsort-enabled${themeSuffix}.webp`;
      console.log(`[Welcome] Updated tags sort image to: example-tagsort-enabled${themeSuffix}.webp`);
    }

    // Update "Sort by Date" image (wizard uses tag-sort/disabled, config uses inbox-sort/date)
    let dateImg = document.querySelector('input[name="tag-sort"][value="disabled"]')?.closest('.option-card-large')?.querySelector('.asset-image');
    if (!dateImg) {
      dateImg = document.querySelector('input[name="inbox-sort"][value="date"]')?.closest('.option-card-large')?.querySelector('.asset-image');
    }
    if (dateImg) {
      dateImg.src = `assets/example-tagsort-disabled${themeSuffix}.webp`;
      console.log(`[Welcome] Updated date sort image to: example-tagsort-disabled${themeSuffix}.webp`);
    }
  }

  return {
    updateDynamicImages,
    updateThemePageImages,
    updateViewModePageImages,
    updateSortOrderPageImages,
    updateTagBasedSortingPageImages,
  };
}

