/**
 * Welcome Wizard Configuration
 * Defines the steps and settings for the onboarding experience
 */

export const WELCOME_CONFIG = {
  // Window dimensions (should match SETTINGS.welcomeWindow in config.js)
  window: {
    defaultWidth: 780,
    defaultHeight: 750,
  },
  
  // Animation timing (ms)
  transitionDuration: 400,
  
  // Page files directory (relative to welcome/)
  pagesDir: "pages",
  
  // Category definitions with their sub-steps
  // Each step has a `page` property pointing to the HTML file in pages/
  categories: [
    {
      id: "welcome",
      label: "Welcome",
      steps: [
        { id: "welcome", title: "Welcome to TabMail", page: "welcome.html" },
      ],
    },
    {
      id: "appearance",
      label: "Appearance",
      steps: [
        { id: "theme", title: "Theme", page: "theme.html" },
        { id: "view-mode", title: "Message View", page: "view-mode.html" },
        { id: "sort-order", title: "Sort Order", page: "sort-order.html" },
        { id: "appearance-defaults", title: "TabMail Defaults", page: "appearance-defaults.html" },
      ],
    },
    {
      id: "calendar-contacts",
      label: "Setup",
      steps: [
        { id: "calendar-contacts", title: "Calendar & Contacts", page: "calendar-contacts.html" },
        { id: "plaintext", title: "Email Format", page: "plaintext.html" },
        { id: "inbox-optimization", title: "Inbox Optimization", page: "inbox-optimization.html" },
      ],
    },
    {
      id: "interface",
      label: "Getting Started",
      steps: [
        { id: "popup-intro", title: "Quick Access", page: "popup-intro.html" },
        { id: "autocomplete", title: "Autocomplete", page: "autocomplete.html" },
        { id: "inline-editor", title: "Inline Editor", page: "inline-editor.html" },
        { id: "chat-intro", title: "Chat Interface", page: "chat-intro.html" },
        { id: "templates-intro", title: "Email Templates", page: "templates-intro.html" },
        { id: "template-marketplace", title: "Template Marketplace", page: "template-marketplace.html" },
        { id: "tab-key-actions", title: "Email Triage", page: "tab-key-actions.html" },
        { id: "teachable-tags", title: "Teachable Tags", page: "teachable-tags.html" },
      ],
    },
  ],
  
  // Storage key for tracking if welcome was completed
  storageKey: "tabmailWelcomeCompleted",
};

/**
 * Get flattened list of all steps with category info
 * @returns {Array} Array of {stepId, categoryId, categoryLabel, title, page, stepIndex, categoryIndex}
 */
export function getFlattenedSteps() {
  const steps = [];
  let stepIndex = 0;
  
  WELCOME_CONFIG.categories.forEach((category, categoryIndex) => {
    category.steps.forEach(step => {
      steps.push({
        stepId: step.id,
        title: step.title,
        page: step.page,
        categoryId: category.id,
        categoryLabel: category.label,
        stepIndex,
        categoryIndex,
      });
      stepIndex++;
    });
  });
  
  return steps;
}

/**
 * Get total number of steps
 * @returns {number}
 */
export function getTotalSteps() {
  return WELCOME_CONFIG.categories.reduce((sum, cat) => sum + cat.steps.length, 0);
}

/**
 * Get category index for a given step index
 * @param {number} stepIndex
 * @returns {number}
 */
export function getCategoryForStep(stepIndex) {
  const steps = getFlattenedSteps();
  if (stepIndex >= 0 && stepIndex < steps.length) {
    return steps[stepIndex].categoryIndex;
  }
  return -1;
}

/**
 * Get all categories
 * @returns {Array}
 */
export function getCategories() {
  return WELCOME_CONFIG.categories;
}

/**
 * Get page URL for a step
 * @param {number} stepIndex
 * @returns {string|null}
 */
export function getPageUrl(stepIndex) {
  const steps = getFlattenedSteps();
  if (stepIndex >= 0 && stepIndex < steps.length) {
    return `${WELCOME_CONFIG.pagesDir}/${steps[stepIndex].page}`;
  }
  return null;
}
