/**
 * TabMail Welcome Wizard (Entrypoint)
 * Split into modules under welcome/modules/ to keep this file small.
 */

import { applyTheme, getCurrentTheme } from "../config/modules/appearance.js";
import { loadAddressBooks, loadCalendars } from "../config/modules/integrations.js";
import { applyAllUiTweaks } from "../gui/tweaks.js";
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";
import {
  WELCOME_CONFIG,
  getCategories,
  getCategoryForStep,
  getFlattenedSteps,
  getPageUrl,
  getTotalSteps,
} from "./welcomeConfig.js";

import { createAppearanceHandlers } from "./modules/appearanceHandlers.js";
import { createCompletion } from "./modules/completion.js";
import { createDynamicImages } from "./modules/dynamicImages.js";
import { setupImageErrorHandlers } from "./modules/imageErrors.js";
import { updateInlineEditorShortcut } from "./modules/inlineEditor.js";
import { setupLogo } from "./modules/logo.js";
import { createNavigation } from "./modules/navigation.js";
import { createPageInitializer } from "./modules/pageInit.js";
import { createPageLoader } from "./modules/pageLoader.js";
import { checkPlaintextStatus, setupPlaintextButton } from "./modules/plaintext.js";
import { generateProgressBubbles } from "./modules/progressBubbles.js";
import { setupMessageListener } from "./modules/runtimeMessages.js";
import { createSettings } from "./modules/settings.js";
import { setupInboxOptimizationHandlers } from "./modules/inboxOptimizationHandlers.js";

// ============================================================================
// STATE
// ============================================================================

let currentStep = 0;
const totalSteps = getTotalSteps();
const flattenedSteps = getFlattenedSteps();
const categories = getCategories();

const getCurrentStep = () => currentStep;
const setCurrentStep = (n) => { currentStep = n; };

// ============================================================================
// WIRING
// ============================================================================

const dynamicImages = createDynamicImages({ getCurrentTheme });
const settings = createSettings({
  flattenedSteps,
});
const completion = createCompletion({ saveStepSettings: settings.saveStepSettings, getCurrentStep });

// Navigation needs loadPage which needs initializePageContent; create after pageInitializer+pageLoader
const appearanceHandlers = createAppearanceHandlers({
  applyTheme,
  getCurrentTheme,
  getFlattenedSteps,
  getCurrentStep,
  updateThemePageImages: dynamicImages.updateThemePageImages,
  updateViewModePageImages: dynamicImages.updateViewModePageImages,
  updateSortOrderPageImages: dynamicImages.updateSortOrderPageImages,
  applyAllUiTweaks,
});

const pageInitializer = createPageInitializer({
  flattenedSteps,
  updateDynamicImages: dynamicImages.updateDynamicImages,
  setupImageErrorHandlers,
  setupLogo,
  loadCalendars,
  loadAddressBooks,
  appearanceHandlers,
  checkPlaintextStatus,
  setupPlaintextButton,
  updateInlineEditorShortcut,
  updateThemePageImages: dynamicImages.updateThemePageImages,
  updateViewModePageImages: dynamicImages.updateViewModePageImages,
  updateSortOrderPageImages: dynamicImages.updateSortOrderPageImages,
  setupInboxOptimizationHandlers,
});

const pageLoader = createPageLoader({
  getPageUrl,
  initializePageContent: pageInitializer.initializePageContent,
});

const navigation = createNavigation({
  totalSteps,
  getCategoryForStep,
  loadPage: pageLoader.loadPage,
  saveStepSettings: settings.saveStepSettings,
  finishWizard: completion.finishWizard,
  getCurrentStep,
  setCurrentStep,
});

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  console.log("[Welcome] Initializing welcome wizard");
  console.log("[Welcome] Total steps:", totalSteps);
  console.log("[Welcome] Categories:", categories.length);

  // Mark welcome as completed immediately on open (so it only shows once)
  // Users can rerun from settings if needed
  try {
    await browser.storage.local.set({
      [WELCOME_CONFIG.storageKey]: true,
      tabmailWelcomeCompletedAt: Date.now(),
    });
    console.log("[Welcome] Marked welcome wizard as completed (shows only once)");
  } catch (e) {
    console.warn("[Welcome] Failed to mark welcome as completed:", e);
  }

  // Inject palette CSS for theming
  try {
    await injectPaletteIntoDocument(document);
    console.log("[Welcome] Palette CSS injected");
  } catch (e) {
    console.warn("[Welcome] Failed to inject palette CSS:", e);
  }

  // Generate progress bubbles dynamically
  generateProgressBubbles({ flattenedSteps, categories });

  // Setup navigation
  navigation.setupNavigation();

  // Setup progress bubbles
  navigation.setupProgressBubbles();

  // Setup message listener for reset command
  setupMessageListener({ goToStep: navigation.goToStep });

  // Load initial page
  await pageLoader.loadPage(0);

  // Update UI for initial step
  navigation.updateUI();

  console.log("[Welcome] Welcome wizard initialized");
}

// ============================================================================
// STARTUP
// ============================================================================

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
