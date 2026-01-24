/**
 * Welcome wizard navigation + UI state updates
 */

export function createNavigation({
  totalSteps,
  getCategoryForStep,
  loadPage,
  saveStepSettings,
  finishWizard,
  getCurrentStep,
  setCurrentStep,
}) {
  /**
   * Setup navigation button handlers
   */
  function setupNavigation() {
    const btnBack = document.getElementById("btn-back");
    const btnNext = document.getElementById("btn-next");

    btnBack.addEventListener("click", async () => {
      if (getCurrentStep() > 0) {
        await goToStep(getCurrentStep() - 1);
      }
    });

    btnNext.addEventListener("click", async () => {
      if (getCurrentStep() < totalSteps - 1) {
        // Save current step settings before advancing
        await saveStepSettings(getCurrentStep());
        await goToStep(getCurrentStep() + 1);
      } else {
        // Last step - finish wizard
        await finishWizard();
      }
    });
  }

  /**
   * Setup progress bubble click handlers
   */
  function setupProgressBubbles() {
    const bubbles = document.querySelectorAll(".progress-bubble");

    bubbles.forEach((bubble, index) => {
      bubble.addEventListener("click", async () => {
        // Allow clicking on completed steps or the next step
        if (index <= getCurrentStep()) {
          // Save current step settings before navigating
          if (index !== getCurrentStep()) {
            await saveStepSettings(getCurrentStep());
          }
          await goToStep(index);
        }
      });
    });
  }

  /**
   * Navigate to a specific step
   * @param {number} stepIndex - Target step index
   */
  async function goToStep(stepIndex) {
    if (stepIndex < 0 || stepIndex >= totalSteps) {
      console.warn(`[Welcome] Invalid step index: ${stepIndex}`);
      return;
    }

    const oldStep = getCurrentStep();
    setCurrentStep(stepIndex);

    console.log(`[Welcome] Navigating from step ${oldStep} to step ${stepIndex}`);

    // Load the new page
    await loadPage(stepIndex);

    // Update UI
    updateUI();
  }

  /**
   * Update UI elements based on current step
   */
  function updateUI() {
    updateCategoryLabels();
    updateProgressBubblesState();
    updateNavigationButtons();
  }

  /**
   * Update category label states
   */
  function updateCategoryLabels() {
    const currentCategoryIndex = getCategoryForStep(getCurrentStep());
    const categoryGroups = document.querySelectorAll(".category-group");

    categoryGroups.forEach((group, index) => {
      const label = group.querySelector(".category-label");
      if (label) {
        label.classList.remove("active");
        if (index === currentCategoryIndex) {
          label.classList.add("active");
        }
      }
    });
  }

  /**
   * Update progress bubble states
   */
  function updateProgressBubblesState() {
    const bubbles = document.querySelectorAll(".progress-bubble");

    bubbles.forEach((bubble, index) => {
      bubble.classList.remove("active", "completed");

      if (index === getCurrentStep()) {
        bubble.classList.add("active");
      } else if (index < getCurrentStep()) {
        bubble.classList.add("completed");
      }
    });
  }

  /**
   * Update navigation button states
   */
  function updateNavigationButtons() {
    const btnBack = document.getElementById("btn-back");
    const btnNext = document.getElementById("btn-next");

    // Back button
    btnBack.disabled = getCurrentStep() === 0;

    // Next button - change text on last step
    if (getCurrentStep() === totalSteps - 1) {
      btnNext.textContent = "Finish";
    } else {
      btnNext.textContent = "Next";
    }
  }

  return {
    setupNavigation,
    setupProgressBubbles,
    goToStep,
    updateUI,
  };
}

