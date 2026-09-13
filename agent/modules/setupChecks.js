/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// setupChecks.js — shared "is TabMail configured?" checks.
//
// These checks (default calendar and default address book) are read by BOTH the popup (to render the in-popup
// setup warning) AND the background (to keep the toolbar "setup" red dot in
// sync proactively, even before the popup is opened). Keeping them in one
// module is what guarantees both contexts compute the warning identically — if
// they diverged, the dot would flip every time the popup opened/closed.
//
// Both inputs are 100% local (TB prefs + storage.local) — these checks
// make ZERO network requests.

import { log } from "./utils.js";

/**
 * Check whether a default calendar is set. Auto-detection happens on addon
 * startup in background.js; here we just check whether a default exists.
 * @returns {Promise<{configured: boolean, reason?: string}>}
 */
export async function checkDefaultCalendar() {
  try {
    const { defaultCalendarId } = await browser.storage.local.get({ defaultCalendarId: null });

    return {
      configured: defaultCalendarId !== null && defaultCalendarId !== "",
    };
  } catch (e) {
    log(`[Setup] Failed to check default calendar: ${e}`, "warn");
    return { configured: false, reason: e.message || String(e) };
  }
}

/**
 * Check whether a default address book is set. We don't auto-select address
 * books (we can't reliably match them to accounts) — the user configures this
 * manually in settings.
 * @returns {Promise<{configured: boolean, reason?: string}>}
 */
export async function checkDefaultAddressBook() {
  try {
    const { defaultAddressBookId } = await browser.storage.local.get({ defaultAddressBookId: null });

    return {
      configured: defaultAddressBookId !== null && defaultAddressBookId !== "",
    };
  } catch (e) {
    log(`[Setup] Failed to check default address book: ${e}`, "warn");
    return { configured: false, reason: e.message || String(e) };
  }
}

/**
 * Aggregate the two setup checks into a single result.
 * @returns {Promise<{allConfigured: boolean, issues: string[], details: object}>}
 */
export async function checkSetupConfiguration() {
  const [calendarCheck, addressBookCheck] = await Promise.all([
    checkDefaultCalendar(),
    checkDefaultAddressBook(),
  ]);

  const issues = [];

  if (!calendarCheck.configured) {
    issues.push("Default calendar not set");
  }

  if (!addressBookCheck.configured) {
    issues.push("Default address book not set");
  }

  return {
    allConfigured: issues.length === 0,
    issues,
    details: {
      calendar: calendarCheck,
      addressBook: addressBookCheck,
    },
  };
}
