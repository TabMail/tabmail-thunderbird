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

function _mailboxes(list) {
  return (Array.isArray(list) ? list : []).map((mailbox) => ({
    name: String(mailbox?.name || ""),
    email: String(mailbox?.email || "").trim(),
  }));
}

/**
 * Every address the add-on reads is Thunderbird's own parse of the raw From, To
 * and Cc headers (tmHdr.getAddressFields: headerParser.parseEncodedHeaderW, which
 * reads quoted strings, quoted pairs, comments and groups first and decodes encoded
 * words only inside them). A display name can hold any text, `<`, `,` and `@`
 * included, and is never read as an address. The `author`, `recipients` and `ccList`
 * strings of a MessageHeader are that parse written back out, and are never parsed
 * again: a name that begins and ends with a quote mark is written out without
 * quoting, so reading such a string again can give a different mailbox.
 *
 * Returns one result per message id, in order: `{ author, recipients, ccList }`,
 * each a list of `{ name, email }` as Thunderbird reads them, the address trimmed
 * ("" for a mailbox with none); `author` lists every From mailbox, the sender first. null
 * when the message is gone or its header could not be read, so a caller has no
 * address for it.
 */
export async function readAddressFields(messageIds) {
  const ids = Array.isArray(messageIds) ? messageIds : [];
  const known = [...new Set(ids.filter(Number.isInteger))];
  const fields = known.length > 0 ? await browser.tmHdr.getAddressFields(known) : [];
  const byId = new Map(known.map((id, i) => [id, fields?.[i] || null]));
  return ids.map((id) => {
    const field = byId.get(id);
    if (!field) return null;
    return {
      author: _mailboxes(field.author),
      recipients: _mailboxes(field.recipients),
      ccList: _mailboxes(field.ccList),
    };
  });
}

/** The sender's address (the first From mailbox), lowercased; "" when it has none or the header is gone. */
export async function readSenderEmail(messageHeader) {
  try {
    const [fields] = await readAddressFields([messageHeader?.id]);
    return (fields?.author[0]?.email || "").toLowerCase();
  } catch (_) {
    return "";
  }
}

function _emails(mailboxes) {
  return mailboxes.map((mailbox) => mailbox.email).filter(Boolean);
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
 * addresses (computeRecipientStatus reads them with readAddressFields first).
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
 * prevent a claim); every From mailbox counts as an author for that check.
 * Unresolvable account or a gone header → "" (never claim cc unsure).
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
    const [fields] = await readAddressFields([messageHeader?.id]);
    if (!fields) return "";
    return classifyRecipientStatus(
      _emails(fields.recipients),
      _emails(fields.ccList),
      _emails(fields.author),
      claim,
      suppress
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
    const authorEmail = await readSenderEmail(messageHeader);
    if (!authorEmail) return false;
    return userEmails.has(authorEmail);
  } catch (_) {
    return false;
  }
}
