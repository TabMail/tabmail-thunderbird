/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hide timers of an extension page's status lines: the prompts, templates
 * and marketplace pages' status line, the Settings page's appearance,
 * autocomplete and search-progress lines, and the popup's update-check label.
 *
 * A status line keeps ONE pending hide: showing a status cancels the hide an
 * earlier status on the same line scheduled, so every status stays up for the
 * full delay from when it appeared. With a timer per status, an earlier
 * status's timer hid a later one early, and a failure said only in the status
 * line could go unseen. Lines are independent: a status on one line never
 * cancels another line's hide. Each page loads its own instance of this
 * module, and its pending hides end with the page.
 */

export const STATUS_LINE_CONFIG = Object.freeze({
    hideAfterMs: 3000,
    // The popup's "Check for updates" link shows a check's result this long.
    updateCheckResultMs: 2000,
});

const pendingHides = new Map();

/** Run `hide` once the status now shown on `line` has been up for `afterMs`. */
export function scheduleStatusHide(line, hide, afterMs = STATUS_LINE_CONFIG.hideAfterMs) {
    cancelStatusHide(line);
    pendingHides.set(line, setTimeout(() => {
        pendingHides.delete(line);
        hide();
    }, afterMs));
}

/** Drop `line`'s pending hide, for a status that stays until the next one replaces it. */
export function cancelStatusHide(line) {
    clearTimeout(pendingHides.get(line));
    pendingHides.delete(line);
}
