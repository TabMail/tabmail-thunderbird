/**
 * Welcome wizard page loader (fetch + cache)
 */

export function createPageLoader({ getPageUrl, initializePageContent }) {
  // Cache for loaded page content
  const pageCache = new Map();

  /**
   * Load a page from the pages directory
   * @param {number} stepIndex - Step index to load
   */
  async function loadPage(stepIndex) {
    const container = document.getElementById("step-container");
    if (!container) {
      console.error("[Welcome] Step container not found");
      return;
    }

    const pageUrl = getPageUrl(stepIndex);
    if (!pageUrl) {
      console.error("[Welcome] No page URL for step:", stepIndex);
      return;
    }

    console.log(`[Welcome] Loading page for step ${stepIndex}: ${pageUrl}`);

    // Check cache first
    if (pageCache.has(stepIndex)) {
      console.log("[Welcome] Using cached page content");
      container.innerHTML = pageCache.get(stepIndex);
      await initializePageContent(stepIndex);
      return;
    }

    // Show loading state
    container.innerHTML = '<div class="loading-placeholder">Loading...</div>';

    try {
      const response = await fetch(pageUrl);
      if (!response.ok) {
        throw new Error(`Failed to load page: ${response.status}`);
      }

      const html = await response.text();

      // Cache the content
      pageCache.set(stepIndex, html);

      // Inject into container
      container.innerHTML = html;

      // Initialize page-specific content and handlers
      await initializePageContent(stepIndex);

      console.log("[Welcome] Page loaded successfully:", pageUrl);
    } catch (e) {
      console.error("[Welcome] Failed to load page:", e);
      container.innerHTML = `<div class="error-placeholder">Failed to load page: ${e.message}</div>`;
    }
  }

  return { loadPage };
}

