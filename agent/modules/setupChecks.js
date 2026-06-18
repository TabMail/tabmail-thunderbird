/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// setupChecks.js — shared "is TabMail configured?" checks.
//
// These three checks (plaintext composition per identity, default calendar,
// default address book) are read by BOTH the popup (to render the in-popup
// setup warning) AND the background (to keep the toolbar "setup" red dot in
// sync proactively, even before the popup is opened). Keeping them in one
// module is what guarantees both contexts compute the warning identically — if
// they diverged, the dot would flip every time the popup opened/closed.
//
// All three inputs are 100% local (TB prefs + storage.local) — these checks
// make ZERO network requests.

import { log } from "./utils.js";

/**
 * Check whether every identity composes in plaintext (HTML compose breaks the
 * agent's reply formatting). Defaults to HTML (Thunderbird's default) when the
 * pref is unreadable, which is the "problematic" case we flag.
 * @returns {Promise<{configured: boolean, problematicIdentities?: string[], reason?: string}>}
 */
export async function checkPlaintextComposition() {
  try {
    if (!browser.tmPrefs) {
      return { configured: false, reason: "tmPrefs API not available" };
    }

    const accounts = await browser.accounts.list();
    const problematicIdentities = [];

    for (const account of accounts) {
      if (!account.identities || account.identities.length === 0) continue;

      for (const identity of account.identities) {
        const identityId = identity.id;
        const prefName = `mail.identity.${identityId}.compose_html`;

        try {
          // Default to true (HTML) if pref doesn't exist, as that's Thunderbird's default
          const composeHtml = await browser.tmPrefs.getBoolSafe(prefName, true);
          const identityName = identity.name || identity.email || `Identity ${identityId}`;

          log(`[TMDBG Setup] Identity ${identityId} (${identityName}): compose_html = ${composeHtml}`);

          if (composeHtml === true) {
            problematicIdentities.push(identityName);
          }
        } catch (e) {
          // If we can't read, assume HTML (Thunderbird's default) - flag as problematic
          const identityName = identity.name || identity.email || `Identity ${identityId}`;
          log(`[Setup] Failed to read compose_html for identity ${identityId}: ${e}`, "warn");
          problematicIdentities.push(identityName);
        }
      }
    }

    return {
      configured: problematicIdentities.length === 0,
      problematicIdentities,
    };
  } catch (e) {
    log(`[Setup] Failed to check plaintext composition: ${e}`, "warn");
    return { configured: false, reason: e.message || String(e) };
  }
}

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
 * Aggregate the three setup checks into a single result.
 * @returns {Promise<{allConfigured: boolean, issues: string[], details: object}>}
 */
export async function checkSetupConfiguration() {
  const [plaintextCheck, calendarCheck, addressBookCheck] = await Promise.all([
    checkPlaintextComposition(),
    checkDefaultCalendar(),
    checkDefaultAddressBook(),
  ]);

  const issues = [];

  if (!plaintextCheck.configured) {
    if (plaintextCheck.problematicIdentities && plaintextCheck.problematicIdentities.length > 0) {
      issues.push(`Plaintext composition not set for: ${plaintextCheck.problematicIdentities.join(", ")}`);
    } else {
      issues.push("Plaintext composition not configured for all email identities");
    }
  }

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
      plaintext: plaintextCheck,
      calendar: calendarCheck,
      addressBook: addressBookCheck,
    },
  };
}
