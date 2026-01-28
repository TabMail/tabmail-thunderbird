import { $ } from "./dom.js";

/**
 * Web Search Settings Module
 * 
 * Manages the web search toggle setting.
 * Web search is disabled by default.
 */

export const WEB_SEARCH_STORAGE_KEY = "webSearchEnabled";
export const WEB_SEARCH_DEFAULT = false;

/**
 * Load web search settings from storage and update UI
 */
export async function loadWebSearchSettings(log) {
  try {
    const stored = await browser.storage.local.get({ [WEB_SEARCH_STORAGE_KEY]: WEB_SEARCH_DEFAULT });
    const enabled = stored[WEB_SEARCH_STORAGE_KEY] === true;
    
    const cb = $("web-search-enabled");
    if (cb) {
      cb.checked = enabled;
    }
    
    log(`[Config] Web search settings loaded: enabled=${enabled}`);
  } catch (e) {
    log(`[Config] loadWebSearchSettings failed: ${e}`, "error");
  }
}

/**
 * Handle web search toggle change
 */
export async function handleWebSearchChange(e) {
  if (e.target.id === "web-search-enabled") {
    const enabled = e.target.checked === true;
    
    try {
      await browser.storage.local.set({ [WEB_SEARCH_STORAGE_KEY]: enabled });
      console.log(`[Config] Web search ${enabled ? "enabled" : "disabled"}`);
      $("status").textContent = enabled
        ? "Web search enabled"
        : "Web search disabled";
    } catch (err) {
      console.error("[Config] Failed to save web search setting:", err);
      $("status").textContent = "Error saving web search setting";
    }
  }
}

/**
 * Get the current web search enabled state.
 * Returns false if not set (disabled by default).
 * 
 * @returns {Promise<boolean>}
 */
export async function getWebSearchEnabled() {
  try {
    const stored = await browser.storage.local.get({ [WEB_SEARCH_STORAGE_KEY]: WEB_SEARCH_DEFAULT });
    return stored[WEB_SEARCH_STORAGE_KEY] === true;
  } catch (e) {
    console.error("[WebSearch] Failed to get web search setting:", e);
    return WEB_SEARCH_DEFAULT;
  }
}
