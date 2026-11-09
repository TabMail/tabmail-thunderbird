/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hide timer of an extension page's status line (the settings, templates
 * and marketplace pages each show one status at a time).
 *
 * A page keeps ONE timer: showing a status cancels the hide an earlier status
 * scheduled, so every status stays up for the full delay from when it
 * appeared. With a timer per status, an earlier status's timer hid a later
 * one early, and a failure said only in the status line could go unseen.
 * Each page loads its own instance of this module, so pages never share it.
 */

const STATUS_LINE_CONFIG = Object.freeze({
    hideAfterMs: 3000,
});

let hideTimer = null;

/** Run `hide` once the status shown now has been up for the configured delay. */
export function scheduleStatusHide(hide) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        hideTimer = null;
        hide();
    }, STATUS_LINE_CONFIG.hideAfterMs);
}

export const _testExports = { STATUS_LINE_CONFIG };
