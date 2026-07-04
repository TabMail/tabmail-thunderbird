/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { log } from "./utils.js";

// In-memory cache for this MV3 service worker lifetime.
let _cachedUserEmailSet = null; // Set<string>

async function _loadUserEmailSet() {
  try {
    const accounts = await browser.accounts.list();
    const emails = new Set();

    for (const acc of accounts || []) {
      try {
        // Skip Local Folders and other non-email accounts (no identities).
        if (acc?.type === "none" || acc?.incomingServer?.type === "none") {
          continue;
        }

        if (acc?.email) {
          emails.add(String(acc.email).trim().toLowerCase());
        }

        const ids = Array.isArray(acc?.identities) ? acc.identities : [];
        for (const identity of ids) {
          if (identity?.email) {
            emails.add(String(identity.email).trim().toLowerCase());
          }
        }
      } catch (_) {}
    }

    try {
      log(`[SenderFilter] Loaded ${emails.size} user email(s) from accounts/identities`);
    } catch (_) {}

    return emails;
  } catch (e) {
    try {
      log(`[SenderFilter] Failed to load user emails: ${e}`, "warn");
    } catch (_) {}
    return new Set();
  }
}

export async function getUserEmailSetCached() {
  if (_cachedUserEmailSet) return _cachedUserEmailSet;
  _cachedUserEmailSet = await _loadUserEmailSet();
  return _cachedUserEmailSet;
}

export function extractEmailFromAuthor(author) {
  try {
    const a = String(author || "");
    const angle = a.match(/<(.+?)>/)?.[1];
    if (angle) return String(angle).trim().toLowerCase();
    const plain = a.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/)?.[0];
    return plain ? String(plain).trim().toLowerCase() : "";
  } catch (_) {
    return "";
  }
}

/**
 * Extract ALL email addresses from a recipient field, tolerating both TB's
 * string[] shape (each entry may contain display-name angle brackets or even
 * multiple mailboxes) and a raw comma-joined string. Global extraction — a
 * per-entry first-match-only parse can drop the user's real address when the
 * display name itself contains brackets (e.g. `"Support <noreply>" <me@x>`).
 */
function _extractAllEmails(field) {
  const RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const parts = Array.isArray(field) ? field : typeof field === "string" && field ? [field] : [];
  return parts.flatMap((r) => String(r || "").match(RE) || []).map((e) => e.trim().toLowerCase());
}

/** Strip a `+tag` local-part suffix (me+orders@x → me@x). Lowercased input expected. */
function _stripPlusTag(email) {
  const at = email.indexOf("@");
  const plus = email.indexOf("+");
  if (at > 0 && plus > 0 && plus < at) return email.slice(0, plus) + email.slice(at);
  return email;
}

/**
 * Pure recipient-status classification for the summary request.
 * Returns "cc" ONLY on positive evidence: one of the user's addresses is
 * literally present in the Cc field (and not in To, and the user is not the
 * author). Everything uncertain — aliases, Bcc, mailing-list delivery,
 * unknown own addresses — returns "" (never claim cc without being sure).
 *
 * Matching asymmetry, on purpose: the SUPPRESS checks (author, To) use loose
 * matching (plus-tags stripped) since a wrong suppress is harmless; the CLAIM
 * check (Cc) uses strict exact-address matching since a wrong claim is the
 * bug class this feature must not have.
 */
export function classifyRecipientStatus(toField, ccField, fromField, userEmails) {
  try {
    if (!userEmails || userEmails.size === 0) return "";
    const userStrict = new Set(
      [...userEmails].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean)
    );
    if (userStrict.size === 0) return "";
    const userLoose = new Set([...userStrict].map(_stripPlusTag));

    // Self-authored → never claim (loose: self-sent via a plus-alias counts).
    if (_extractAllEmails(fromField).some((e) => userLoose.has(_stripPlusTag(e)))) return "";
    // Direct recipient → omit (loose: To hitting a plus-alias is still direct).
    if (_extractAllEmails(toField).some((e) => userLoose.has(_stripPlusTag(e)))) return "";
    // Positive evidence: user's exact address in Cc → claim.
    return _extractAllEmails(ccField).some((e) => userStrict.has(e)) ? "cc" : "";
  } catch (_) {
    return "";
  }
}

/**
 * Compute the recipient_status value for a message: "cc" only when one of the
 * RECEIVING account's addresses (account email + that account's identities)
 * is positively found in the Cc field. Deliberately scoped to the account the
 * email arrived on — NOT all registered accounts — for simplicity/robustness.
 * Unresolvable account → "" (never claim cc without being sure).
 */
export async function computeRecipientStatus(messageHeader) {
  try {
    const accountId = messageHeader?.folder?.accountId;
    if (!accountId) return "";
    const acc = await browser.accounts.get(accountId, false);
    const emails = new Set();
    if (acc?.email) {
      emails.add(String(acc.email).trim().toLowerCase());
    }
    for (const identity of Array.isArray(acc?.identities) ? acc.identities : []) {
      if (identity?.email) {
        emails.add(String(identity.email).trim().toLowerCase());
      }
    }
    return classifyRecipientStatus(
      messageHeader?.recipients,
      messageHeader?.ccList,
      messageHeader?.author,
      emails
    );
  } catch (_) {
    return "";
  }
}

/**
 * Returns true if this message appears to be from one of the user's own accounts/identities.
 * If we cannot determine user emails, returns false (do not filter) to avoid false negatives.
 */
export async function isInternalSender(messageHeader) {
  try {
    const userEmails = await getUserEmailSetCached();
    if (!userEmails || userEmails.size === 0) {
      // Same policy as FolderScan: if we can't detect identities, don't filter.
      return false;
    }
    const authorEmail = extractEmailFromAuthor(messageHeader?.author);
    if (!authorEmail) return false;
    return userEmails.has(authorEmail);
  } catch (_) {
    return false;
  }
}


