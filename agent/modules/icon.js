/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

// Toolbar badge shown when the native FTS search helper is not installed.
// This is a WebExtension browserAction badge color (set via API, not CSS), so
// it cannot reference the palette CSS variables — keep it a single named literal.
const FTS_BADGE_TEXT = "!";
const FTS_BADGE_BG_COLOR = "#C13A2B"; // attention red

/**
 * Show or clear a badge on the toolbar action indicating the native full-text
 * search helper is missing and should be installed.
 * @param {boolean} missing - true to show the "needs install" badge, false to clear it
 */
export async function setFtsHelperBadge(missing) {
    try {
        if (!browser.action || !browser.action.setBadgeText) {
            log("[Icon] Badge API not available", "warn");
            return;
        }

        await browser.action.setBadgeText({ text: missing ? FTS_BADGE_TEXT : "" });
        if (missing && browser.action.setBadgeBackgroundColor) {
            await browser.action.setBadgeBackgroundColor({ color: FTS_BADGE_BG_COLOR });
        }

        log(`[Icon] FTS helper badge ${missing ? "shown" : "cleared"}`);
    } catch (e) {
        log(`[Icon] Failed to set FTS helper badge: ${e}`, "error");
    }
}


