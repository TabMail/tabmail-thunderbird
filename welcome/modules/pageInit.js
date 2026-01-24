/**
 * Welcome wizard per-page initialization
 */

export function createPageInitializer({
  flattenedSteps,
  updateDynamicImages,
  setupImageErrorHandlers,
  setupLogo,
  loadCalendars,
  loadAddressBooks,
  appearanceHandlers,
  checkPlaintextStatus,
  setupPlaintextButton,
  updateInlineEditorShortcut,
  updateThemePageImages,
  updateViewModePageImages,
  updateSortOrderPageImages,
  setupInboxOptimizationHandlers,
}) {
  /**
   * Initialize page-specific content after loading
   * @param {number} stepIndex - Current step index
   */
  async function initializePageContent(stepIndex) {
    const stepInfo = flattenedSteps[stepIndex];
    if (!stepInfo) return;

    console.log(`[Welcome] Initializing page content for: ${stepInfo.stepId}`);

    // Setup image error handlers for this page
    setupImageErrorHandlers();

    // Update dynamic images based on current theme/view mode
    await updateDynamicImages(stepInfo.stepId);

    // Step-specific initialization
    switch (stepInfo.stepId) {
      case "welcome":
        setupLogo();
        break;
      case "theme":
        appearanceHandlers.setupThemeHandlers();
        await appearanceHandlers.restoreThemeSetting();
        // Update images when theme changes
        await updateThemePageImages();
        break;
      case "view-mode":
        appearanceHandlers.setupViewModeHandlers({ applyViewModeImmediately: appearanceHandlers.applyViewModeImmediately });
        await appearanceHandlers.restoreViewModeSetting();
        // Update images when view mode changes
        await updateViewModePageImages();
        break;
      case "sort-order":
        appearanceHandlers.setupSortOrderHandlers({ applySortOrderImmediately: appearanceHandlers.applySortOrderImmediately });
        await appearanceHandlers.restoreSortOrderSetting();
        await updateSortOrderPageImages();
        break;
      case "appearance-defaults":
        appearanceHandlers.setupAppearanceDefaultsHandlers();
        break;
      case "calendar-contacts":
        await loadCalendars();
        await loadAddressBooks();
        break;
      case "plaintext":
        await checkPlaintextStatus();
        setupPlaintextButton({ checkPlaintextStatusFn: checkPlaintextStatus });
        break;
      case "inbox-optimization":
        setupInboxOptimizationHandlers();
        break;
      case "inline-editor":
        await updateInlineEditorShortcut();
        break;
    }
  }

  return { initializePageContent };
}

