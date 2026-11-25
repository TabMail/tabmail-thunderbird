/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { log } from "./utils.js";

// In-memory cache for this MV3 service worker lifetime.
let _cachedUserEmailSet = null; // Set<string>
let _emailCacheGeneration = 0;

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
  // An identity event may invalidate the cache while accounts.list() is pending.
  // Never publish the snapshot from before that event.
  while (!_cachedUserEmailSet) {
    const generation = _emailCacheGeneration;
    const loaded = await _loadUserEmailSet();
    if (generation === _emailCacheGeneration) _cachedUserEmailSet = loaded;
  }
  return _cachedUserEmailSet;
}

/** Drop the cached account/identity email set so the next call reloads it.
 * Wired to account and identity change events in background.js — without
 * this, an account added mid-session is invisible to the recipient-status
 * suppress checks until the MV3 worker restarts. */
export function invalidateUserEmailCache() {
  _emailCacheGeneration++;
  _cachedUserEmailSet = null;
}

/**
 * Every address the add-on reads goes through Thunderbird's own RFC 5322 parser.
 * Thunderbird parses each raw From/To/Cc header itself (quoted strings, quoted
 * pairs, comments, groups; encoded words decoded only once the structure is read)
 * and hands the add-on one re-quoted mailbox per entry: `author` is the first
 * From mailbox, and each `recipients` / `ccList` item is one mailbox. Reading an
 * entry back with the same parser gives its address and its name exactly. A name
 * can hold any text, `<`, `,` and `@` included, and is never read as an address.
 *
 * Returns the entry's mailboxes that have an address, as `{ name, email }` with
 * the address trimmed and lowercased (several only for an entry that is itself a
 * list).
 */
export async function parseMailboxes(entry) {
  const text = String(entry || "");
  if (!text) return [];
  const parsed = await browser.messengerUtilities.parseMailboxString(text);
  const out = [];
  for (const mailbox of parsed || []) {
    const email = String(mailbox?.email || "").trim().toLowerCase();
    if (email) out.push({ name: String(mailbox?.name || ""), email });
  }
  return out;
}

/** The author entry's address, lowercased; "" when it holds none. */
export async function extractEmailFromAuthor(author) {
  try {
    return (await parseMailboxes(author))[0]?.email || "";
  } catch (_) {
    return "";
  }
}

/** Every address in an address field: Thunderbird's string[] of entries, or one string. */
async function _fieldEmails(field) {
  const entries = Array.isArray(field) ? field : typeof field === "string" && field ? [field] : [];
  const lists = await Promise.all(entries.map(parseMailboxes));
  return lists.flat().map((mailbox) => mailbox.email);
}

/** Strip a `+tag` local-part suffix (me+orders@x → me@x). Lowercased input expected. */
function _stripPlusTag(email) {
  const at = email.indexOf("@");
  const plus = email.indexOf("+");
  if (at > 0 && plus > 0 && plus < at) return email.slice(0, plus) + email.slice(at);
  return email;
}

function _normalizeEmailSet(emails) {
  const out = new Set();
  for (const e of emails || []) {
    const n = String(e || "").trim().toLowerCase();
    if (n) out.add(n);
  }
  return out;
}

/**
 * Pure recipient-status classification for the summary request, over parsed
 * addresses (computeRecipientStatus parses the message's entries first).
 * Returns "cc" ONLY on positive evidence: one of `claimEmails` (the RECEIVING
 * account's addresses) is one of the Cc mailboxes' addresses (and not in To,
 * and the user is not the author). Everything uncertain — aliases, Bcc,
 * mailing-list delivery, unknown own addresses — returns "" (never claim cc
 * without being sure).
 *
 * `suppressEmails` may carry EVERY address we know for the user (all accounts
 * + identities); it is unioned with `claimEmails` and used only for the
 * suppress checks — more suppression can only prevent wrong claims.
 *
 * Matching asymmetry, on purpose: the SUPPRESS checks (author, To) match
 * loosely (plus-tags stripped) since a wrong suppress is harmless; the CLAIM
 * check (Cc) needs the exact address, since a wrong claim is the failure mode
 * this feature works hardest to avoid.
 */
export function classifyRecipientStatus(toEmails, ccEmails, fromEmails, claimEmails, suppressEmails = []) {
  try {
    const claimSet = _normalizeEmailSet(claimEmails);
    if (claimSet.size === 0) return "";
    const suppressSet = new Set([..._normalizeEmailSet(suppressEmails), ...claimSet]);
    const suppressLoose = new Set([...suppressSet].map(_stripPlusTag));
    const matchesLoose = (emails) =>
      [..._normalizeEmailSet(emails)].some((e) => suppressLoose.has(_stripPlusTag(e)));

    // Self-authored → never claim (loose: self-sent via a plus-alias counts).
    if (matchesLoose(fromEmails)) return "";
    // Direct recipient → omit (loose: To hitting a plus-alias is still direct).
    if (matchesLoose(toEmails)) return "";
    // Positive evidence: user's exact mailbox address in Cc → claim.
    return [..._normalizeEmailSet(ccEmails)].some((e) => claimSet.has(e)) ? "cc" : "";
  } catch (_) {
    return "";
  }
}

/**
 * Compute the recipient_status value for a message: "cc" only when one of the
 * RECEIVING account's addresses (account email + that account's identities)
 * is positively found in the Cc field. The claim is deliberately scoped to
 * the account the email arrived on, but the suppress checks use every
 * account/identity address we know (cross-account To/From hits should also
 * prevent a claim). Unresolvable account → "" (never claim cc unsure).
 */
export async function computeRecipientStatus(messageHeader) {
  try {
    const accountId = messageHeader?.folder?.accountId;
    if (!accountId) return "";
    const acc = await browser.accounts.get(accountId, false);
    const claim = new Set();
    if (acc?.email) {
      claim.add(String(acc.email).trim().toLowerCase());
    }
    for (const identity of Array.isArray(acc?.identities) ? acc.identities : []) {
      if (identity?.email) {
        claim.add(String(identity.email).trim().toLowerCase());
      }
    }
    if (claim.size === 0) return "";
    let suppress = new Set();
    try {
      suppress = (await getUserEmailSetCached()) || new Set();
    } catch (_) {}
    const [toEmails, ccEmails, fromEmails] = await Promise.all([
      _fieldEmails(messageHeader?.recipients),
      _fieldEmails(messageHeader?.ccList),
      _fieldEmails(messageHeader?.author),
    ]);
    return classifyRecipientStatus(toEmails, ccEmails, fromEmails, claim, suppress);
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
    const authorEmail = await extractEmailFromAuthor(messageHeader?.author);
    if (!authorEmail) return false;
    return userEmails.has(authorEmail);
  } catch (_) {
    return false;
  }
}
