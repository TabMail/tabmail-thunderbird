/**
 * Welcome wizard progress bubbles (category + bubbles UI)
 */

/**
 * Generate progress bubbles grouped by category
 */
export function generateProgressBubbles({ flattenedSteps, categories }) {
  const container = document.getElementById("category-indicators");
  if (!container) return;

  container.innerHTML = "";

  // Group steps by category
  const stepsByCategory = {};
  flattenedSteps.forEach((step, index) => {
    if (!stepsByCategory[step.categoryIndex]) {
      stepsByCategory[step.categoryIndex] = [];
    }
    stepsByCategory[step.categoryIndex].push({ ...step, stepIndex: index });
  });

  // Create a category group for each category
  categories.forEach((category, categoryIndex) => {
    const categoryGroup = document.createElement("div");
    categoryGroup.className = "category-group";
    categoryGroup.dataset.category = categoryIndex;

    // Category label
    const label = document.createElement("div");
    label.className = "category-label";
    if (categoryIndex === 0) {
      label.classList.add("active");
    }
    label.textContent = category.label;
    categoryGroup.appendChild(label);

    // Bubbles for this category
    const bubblesContainer = document.createElement("div");
    bubblesContainer.className = "category-bubbles";

    const categorySteps = stepsByCategory[categoryIndex] || [];
    categorySteps.forEach((step) => {
      const bubble = document.createElement("div");
      bubble.className = "progress-bubble";
      bubble.dataset.step = step.stepIndex;
      if (step.stepIndex === 0) {
        bubble.classList.add("active");
      }
      bubblesContainer.appendChild(bubble);
    });

    categoryGroup.appendChild(bubblesContainer);
    container.appendChild(categoryGroup);
  });

  console.log("[Welcome] Generated category groups with bubbles");
}

