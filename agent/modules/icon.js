/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { log } from "./utils.js";

// The toolbar action icon is a function of TWO independent inputs:
//   • auth state   — connected (tab.svg) vs signed-out/unknown (tab-greyed.svg)
//   • warning state — any "attention needed" condition adds a red dot
//     (tab-warning.svg / tab-greyed-warning.svg)
// We track both and recompute the effective icon whenever either changes.
let _lastAuthState = null;   // true = logged in; false/null = logged out/unknown
let _warningActive = false;  // true = show the red-dot "attention" icon
let _lastIconPath = null;    // last applied path — avoids redundant setIcon (blinking)

// Badge color (set via the WebExtension API, not CSS, so it can't reference the
// palette vars). TB renders action badges inconsistently in the unified toolbar,
// so the red-dot ICON variant is the primary signal and the badge is a bonus.
const WARNING_BADGE_TEXT = "!";
const WARNING_BADGE_BG_COLOR = "#D13A2B";

function effectiveIconPath() {
    // Falsy auth (null/false) → greyed, matching the original behavior.
    const greyed = !_lastAuthState;
    if (_warningActive) {
        return greyed ? "icons/tab-greyed-warning.svg" : "icons/tab-warning.svg";
    }
    return greyed ? "icons/tab-greyed.svg" : "icons/tab.svg";
}

async function applyActionIcon(forceUpdate = false) {
    if (!browser.action || !browser.action.setIcon) {
        log("[Icon] Browser action API not available", "warn");
        return;
    }

    const iconPath = effectiveIconPath();
    if (!forceUpdate && _lastIconPath === iconPath) {
        log("[Icon] Icon unchanged, skipping update");
        return;
    }

    log(`[Icon] Setting icon to: ${iconPath} (auth=${_lastAuthState}, warning=${_warningActive})`);
    await browser.action.setIcon({ path: iconPath });
    // Cache only after a successful setIcon, so a failed set doesn't poison the
    // dedup and silently skip the correct icon on the next call.
    _lastIconPath = iconPath;
    if (browser.action.setTitle) {
        await browser.action.setTitle({
            title: _warningActive ? "TabMail — action needed" : "TabMail",
        });
    }
}

/**
 * Updates the toolbar icon based on authentication state.
 * @param {boolean} authState - Authentication state (true = logged in, false = logged out)
 * @param {boolean} [forceUpdate] - Force update even if state hasn't changed
 */
export async function updateIconBasedOnAuthState(authState, forceUpdate = false) {
    try {
        log(`[Icon] updateIconBasedOnAuthState called (forceUpdate=${forceUpdate}, lastState=${_lastAuthState}, authState=${authState})`);
        _lastAuthState = authState;
        await applyActionIcon(forceUpdate);
    } catch (e) {
        log(`[Icon] Failed to update toolbar icon: ${e}`, "error");
    }
}

/**
 * Show or clear the toolbar "attention needed" indicator — a red dot baked into
 * the icon (primary), plus a best-effort badge. Use for any condition the user
 * should act on; currently the native search helper being missing.
 * @param {boolean} active - true to show the warning indicator, false to clear it
 */
export async function setActionWarning(active) {
    _warningActive = !!active;

    // Best-effort badge (TB renders these inconsistently — the icon is the
    // reliable signal).
    try {
        if (browser.action && browser.action.setBadgeText) {
            await browser.action.setBadgeText({ text: _warningActive ? WARNING_BADGE_TEXT : "" });
            if (_warningActive && browser.action.setBadgeBackgroundColor) {
                await browser.action.setBadgeBackgroundColor({ color: WARNING_BADGE_BG_COLOR });
            }
        }
    } catch (e) {
        log(`[Icon] Failed to set action badge: ${e}`, "warn");
    }

    try {
        await applyActionIcon();
        log(`[Icon] Action warning ${_warningActive ? "shown" : "cleared"}`);
    } catch (e) {
        log(`[Icon] Failed to apply warning icon: ${e}`, "error");
    }
}


