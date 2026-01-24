import { log } from "./utils.js";

// Cache the last auth state to prevent unnecessary icon updates
let _lastAuthState = null;

/**
 * Updates the toolbar icon based on authentication state
 * @param {boolean} authState - Authentication state (true = logged in, false = logged out)
 * @param {boolean} [forceUpdate] - Force update even if state hasn't changed
 */
export async function updateIconBasedOnAuthState(authState, forceUpdate = false) {
    try {
        if (!browser.action || !browser.action.setIcon) {
            log("[Icon] Browser action API not available", "warn");
            return;
        }

        log(`[Icon] updateIconBasedOnAuthState called (forceUpdate=${forceUpdate}, lastState=${_lastAuthState}, authState=${authState})`);
        
        // Skip update if state hasn't changed (prevents blinking)
        if (!forceUpdate && _lastAuthState === authState) {
            log("[Icon] State unchanged, skipping update");
            return;
        }
        
        _lastAuthState = authState;
        
        const iconPath = authState ? "icons/tab.svg" : "icons/tab-greyed.svg";
        const title = "TabMail";  // Icon color already indicates connection state

        log(`[Icon] Setting icon to: ${iconPath}`);
        await browser.action.setIcon({ path: iconPath });
        if (browser.action.setTitle) {
            await browser.action.setTitle({ title });
        }

        log(`[Icon] Toolbar icon updated successfully: ${authState ? "connected" : "disconnected"} state`);
    } catch (e) {
        log(`[Icon] Failed to update toolbar icon: ${e}`, "error");
    }
}


