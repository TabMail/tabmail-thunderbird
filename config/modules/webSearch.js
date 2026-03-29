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
    // Accept both boolean true and string "true" (agent tool may have stored string)
    const raw = stored[WEB_SEARCH_STORAGE_KEY];
    const enabled = raw === true || raw === "true";

    log(`[Config] loadWebSearchSettings: key="${WEB_SEARCH_STORAGE_KEY}" raw=${JSON.stringify(raw)} (type=${typeof raw}) → enabled=${enabled}`);

    // Also dump all storage keys containing "webSearch" or "web_search" for diagnosis
    try {
      const allStorage = await browser.storage.local.get(null);
      const relevantKeys = Object.keys(allStorage).filter(k => k.toLowerCase().includes("websearch") || k.toLowerCase().includes("web_search"));
      log(`[Config] loadWebSearchSettings: relevant storage keys: ${JSON.stringify(relevantKeys.map(k => `${k}=${JSON.stringify(allStorage[k])} (${typeof allStorage[k]})`))}`)
    } catch (_) {}

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
    const raw = stored[WEB_SEARCH_STORAGE_KEY];
    console.log(`[WebSearch] getWebSearchEnabled: key="${WEB_SEARCH_STORAGE_KEY}" raw=${JSON.stringify(raw)} (type=${typeof raw}) → ${raw === true || raw === "true"}`);
    return raw === true || raw === "true";
  } catch (e) {
    console.error("[WebSearch] Failed to get web search setting:", e);
    return WEB_SEARCH_DEFAULT;
  }
}
