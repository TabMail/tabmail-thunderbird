/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { log } from "./utils.js";

// The toolbar action icon is a function of TWO independent inputs:
//   • connection state — connected (tab.svg) vs signed-out/unknown (tab-greyed.svg)
//   • warning state    — any "attention needed" condition adds a red dot
//     (tab-warning.svg / tab-greyed-warning.svg)
//
// Disconnected is itself treated as a warning (greyed icon + red dot + a
// "disconnected" title). Other warnings are tracked BY KEY so independent
// sources don't clobber each other — e.g. "fts" (helper missing), "consent"
// (consent required), "setup" (plaintext/calendar/address book not configured),
// "server" (backend unhealthy). The dot shows whenever the popup would show an
// issue; the title summarizes why.
let _connected = null;        // true = logged in; false = signed out; null = unknown
const _warnings = new Set();  // active warning keys (only meaningful while connected)
let _lastIconPath = null;     // last applied path — avoids redundant setIcon (blinking)

// Badge color (set via the WebExtension API, not CSS, so it can't reference the
// palette vars). TB renders action badges inconsistently in the unified toolbar,
// so the red-dot ICON variant is the primary signal and the badge is a bonus.
const WARNING_BADGE_TEXT = "!";
const WARNING_BADGE_BG_COLOR = "#D13A2B";
// Trailing non-breaking spaces so the title isn't flush against TB's own
// dropdown caret (regular trailing spaces get collapsed by the toolbar label).
const CARET_PAD = String.fromCharCode(160, 160);

// Disconnected is a warning in itself; otherwise any tracked issue.
function hasWarning() {
    return _connected === false || _warnings.size > 0;
}

function effectiveIconPath() {
    const greyed = !_connected; // null/false → greyed (matches original behavior)
    if (hasWarning()) {
        return greyed ? "icons/tab-greyed-warning.svg" : "icons/tab-warning.svg";
    }
    return greyed ? "icons/tab-greyed.svg" : "icons/tab.svg";
}

function effectiveTitle() {
    if (_connected === false) return "TabMail — disconnected" + CARET_PAD;
    if (_warnings.size > 0) return "TabMail — action needed" + CARET_PAD;
    return "TabMail";
}

async function applyAction(forceUpdate = false) {
    if (!browser.action || !browser.action.setIcon) {
        log("[Icon] Browser action API not available", "warn");
        return;
    }

    const iconPath = effectiveIconPath();
    if (!forceUpdate && _lastIconPath === iconPath) {
        // Icon path unchanged (title can't differ when the path is the same), so
        // skip the redundant setIcon to avoid blinking.
        log("[Icon] Icon unchanged, skipping update");
        return;
    }

    log(`[Icon] Setting icon to: ${iconPath} (connected=${_connected}, warnings=${[..._warnings].join(",") || "none"})`);
    await browser.action.setIcon({ path: iconPath });
    // Cache only after a successful setIcon, so a failed set doesn't poison the
    // dedup and silently skip the correct icon on the next call.
    _lastIconPath = iconPath;

    if (browser.action.setTitle) {
        await browser.action.setTitle({ title: effectiveTitle() });
    }

    // Best-effort badge (TB renders these inconsistently — the icon is the
    // reliable signal).
    try {
        if (browser.action.setBadgeText) {
            await browser.action.setBadgeText({ text: hasWarning() ? WARNING_BADGE_TEXT : "" });
            if (hasWarning() && browser.action.setBadgeBackgroundColor) {
                await browser.action.setBadgeBackgroundColor({ color: WARNING_BADGE_BG_COLOR });
            }
        }
    } catch (e) {
        log(`[Icon] Failed to set action badge: ${e}`, "warn");
    }
}

/**
 * Updates the toolbar icon based on authentication state. Signed-out renders the
 * greyed icon with the warning dot and a "disconnected" title.
 * @param {boolean} authState - Authentication state (true = logged in, false = logged out)
 * @param {boolean} [forceUpdate] - Force update even if state hasn't changed
 */
export async function updateIconBasedOnAuthState(authState, forceUpdate = false) {
    try {
        log(`[Icon] updateIconBasedOnAuthState called (forceUpdate=${forceUpdate}, lastState=${_connected}, authState=${authState})`);
        _connected = authState;
        await applyAction(forceUpdate);
    } catch (e) {
        log(`[Icon] Failed to update toolbar icon: ${e}`, "error");
    }
}

/**
 * Add or clear a keyed toolbar warning (red dot + "action needed" title while
 * connected). Use one key per independent condition so they don't clobber each
 * other — e.g. "fts", "consent", "setup", "server".
 * @param {string} key - Warning identifier
 * @param {boolean} active - true to raise the warning, false to clear it
 */
export async function setWarning(key, active) {
    if (active) {
        _warnings.add(key);
    } else {
        _warnings.delete(key);
    }

    try {
        await applyAction();
        log(`[Icon] Warning "${key}" ${active ? "raised" : "cleared"} (active: ${[..._warnings].join(",") || "none"})`);
    } catch (e) {
        log(`[Icon] Failed to apply warning "${key}": ${e}`, "error");
    }
}
