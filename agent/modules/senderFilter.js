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

/** Drop the cached account/identity email set so the next call reloads it.
 * Wired to accounts.onCreated/onDeleted/onUpdated in background.js — without
 * this, an account added mid-session is invisible to the recipient-status
 * suppress checks until the MV3 worker restarts. */
export function invalidateUserEmailCache() {
  _cachedUserEmailSet = null;
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

// Matcher-input bounds — ReDoS guards, NOT stored-content truncation (rule 11:
// full headers stay stored/displayed elsewhere; only the ephemeral input to
// the address matcher is bounded). The atext regex backtracks quadratically on
// long unbroken character runs, so tokens are bounded near the RFC 5321 path
// maximum (254 chars; 320 leaves headroom) and whole fields are sanity-capped.
const MAX_RECIPIENT_FIELD_CHARS = 65536;
const MAX_ADDR_TOKEN_CHARS = 320;

// Full RFC 5322 atext local-part class. A narrower class (e.g. missing ' ! ~)
// restarts matching MID-TOKEN and extracts a truncated tail — `o'brien@x.com`
// would yield `brien@x.com`, colliding with a different user's real address.
const _EMAIL_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const _EMAIL_EXACT_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function _fieldParts(field) {
  return Array.isArray(field) ? field : typeof field === "string" && field ? [field] : [];
}

function _fieldLength(field) {
  return _fieldParts(field).reduce((n, p) => n + String(p || "").length, 0);
}

/**
 * Liberal extraction — SUPPRESS path only. Pulls every address-shaped token
 * out of the field (including display-name text), from both TB's string[]
 * shape and raw comma-joined strings. Over-extraction here is safe: it can
 * only suppress a claim, never create one.
 *
 * Input is pre-split on structural delimiters (whitespace, commas, brackets,
 * quotes, parens — never legal inside an addr-spec) with over-long tokens
 * dropped: this keeps the regex scan linear in the field length instead of
 * quadratic on unbroken runs.
 */
function _extractAllEmails(field) {
  const out = [];
  for (const part of _fieldParts(field)) {
    for (const token of String(part || "").split(/[\s,;<>()"]+/)) {
      if (!token || token.length > MAX_ADDR_TOKEN_CHARS) continue;
      out.push(...(token.match(_EMAIL_RE) || []));
    }
  }
  return out.map((e) => e.trim().toLowerCase());
}

/** Whole-token address check for the claim path. Returns the normalized
 * address iff the trimmed candidate is EXACTLY one addr-spec — anchored, so a
 * truncated head/tail (non-ASCII prefix, trailing junk, combining mark) can
 * never be misread as the user's mailbox. */
function _exactAddr(candidate) {
  const c = String(candidate || "").trim();
  if (!c || c.length > MAX_ADDR_TOKEN_CHARS) return "";
  return _EMAIL_EXACT_RE.test(c) ? c.toLowerCase() : "";
}

/** Index of the next occurrence of `close` at/after `from` that is NOT
 * backslash-escaped (odd number of preceding backslashes). -1 if none. */
function _indexOfUnescaped(s, close, from) {
  let i = from;
  while (true) {
    const at = s.indexOf(close, i);
    if (at === -1) return -1;
    let backslashes = 0;
    for (let j = at - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) return at;
    i = at + 1;
  }
}

/** Linear, escape-aware removal of `open`…`close` regions (each replaced by a
 * single space). Unterminated opens keep the rest of the string untouched.
 * Manual index scan on purpose: a backtracking regex like `"[^"]*"` is O(n²)
 * on unbalanced openers, and regex sanitizers are escape-blind (`\"`/`\)`
 * mis-pair the boundaries, exposing planted bracket spans). */
function _stripDelimited(s, open, close, escapeAware) {
  const parts = [];
  let i = 0;
  while (i < s.length) {
    const a = s.indexOf(open, i);
    if (a === -1) {
      parts.push(s.slice(i));
      break;
    }
    const searchFrom = a + open.length;
    const b = escapeAware
      ? _indexOfUnescaped(s, close, searchFrom)
      : s.indexOf(close, searchFrom);
    if (b === -1) {
      parts.push(s.slice(i));
      break;
    }
    parts.push(s.slice(i, a), " ");
    i = b + close.length;
  }
  return parts.join("");
}

/** Linear scan for the contents of each `<...>` span (leftmost, non-nested —
 * same shape the previous `<[^>]*>` regex matched, without its O(n²) blowup
 * on unbalanced `<` runs). */
function _bracketContents(s) {
  const out = [];
  let i = 0;
  while (true) {
    const open = s.indexOf("<", i);
    if (open === -1) break;
    const close = s.indexOf(">", open + 1);
    if (close === -1) break;
    out.push(s.slice(open + 1, close));
    i = close + 1;
  }
  return out;
}

/**
 * Claim-grade extraction — CC path only. Best-effort at returning only ACTUAL
 * mailbox addresses so an address-shaped token planted in a display name can't
 * fabricate positive Cc evidence:
 *   1. RFC 2047 encoded words, quoted strings, and comments are display-name
 *      material by definition — removed before extraction (linear,
 *      escape-aware scans).
 *   2. If a part uses angle-bracket form ANYWHERE, only bracketed spans count —
 *      a bare segment coexisting with brackets is display-name debris (e.g.
 *      unescaped quotes in a formatted name), not a mailbox. Within a
 *      comma/semicolon segment only the LAST <...> span is the real addr-spec:
 *      a mailbox is `[display-name] <addr>`, so any earlier bracket span is
 *      display-name material. Unclosed brackets yield nothing.
 *   3. Every candidate must be EXACTLY an addr-spec (_exactAddr) — no
 *      substring scanning on the claim path.
 * Under-extraction here is safe: a missed Cc address just omits the field.
 * Every scan is linear in the field length (ReDoS-safe; the 64KB field cap is
 * belt-and-suspenders).
 *
 * KNOWN LIMITATION (accepted 2026-07-05, low impact — see PROJECT_MEMORY.md
 * "Summary recipient_status"): this resists display-name injection for escaped
 * quoted names and unescaped-no-comma names, but NOT the case where an upstream
 * producer emits the decoded display name in UNESCAPED quotes AND the name
 * contains a comma/semicolon (SwiftMail's IMAP `formatAddress` can do this).
 * Such a crafted single Cc address is byte-identical to a legitimate
 * multi-recipient Cc that MUST claim, so no string parser can distinguish them.
 * The residual is a spurious "you're only cc'd" summary hint — adversarial-only,
 * no data/security/crash impact. Fixing it requires producer-side escaping or
 * carrying the structured per-address array to the classifier; deliberately not
 * done for a low-stakes helper. See test "documents the accepted residual".
 */
function _extractAddressEmails(field) {
  const out = [];
  for (const raw of _fieldParts(field)) {
    let s = String(raw || "");
    s = _stripDelimited(s, "=?", "?=", false);
    s = _stripDelimited(s, '"', '"', true);
    s = _stripDelimited(s, "(", ")", true);
    if (s.includes("<")) {
      for (const seg of s.split(/[,;]/)) {
        const spans = _bracketContents(seg);
        if (spans.length === 0) continue; // bracketless segment = display debris
        const e = _exactAddr(spans[spans.length - 1]); // last span = the addr-spec
        if (e) out.push(e);
      }
    } else {
      for (const seg of s.split(/[,;]/)) {
        // RFC 5322 group syntax prefixes the first member with `name :`.
        const colon = seg.indexOf(":");
        const e = _exactAddr(colon === -1 ? seg : seg.slice(colon + 1));
        if (e) out.push(e);
      }
    }
  }
  return out;
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
 * Pure recipient-status classification for the summary request.
 * Returns "cc" ONLY on positive evidence: one of `claimEmails` (the RECEIVING
 * account's addresses) is literally present in the Cc field as an actual
 * mailbox address (and not in To, and the user is not the author). Everything
 * uncertain — aliases, Bcc, mailing-list delivery, unknown own addresses —
 * returns "" (never claim cc without being sure).
 *
 * `suppressEmails` may carry EVERY address we know for the user (all accounts
 * + identities); it is unioned with `claimEmails` and used only for the
 * suppress checks — more suppression can only prevent wrong claims.
 *
 * Matching asymmetry, on purpose: the SUPPRESS checks (author, To) use
 * liberal extraction + loose matching (plus-tags stripped) since a wrong
 * suppress is harmless; the CLAIM check (Cc) uses claim-grade extraction +
 * strict exact-address matching since a wrong claim is the failure mode this
 * feature works hardest to avoid (see `_extractAddressEmails` for the one
 * accepted, low-impact residual it cannot fully close).
 */
export function classifyRecipientStatus(toField, ccField, fromField, claimEmails, suppressEmails = []) {
  try {
    // Degenerate/adversarial header sizes → skip classification entirely
    // (omit, the safe answer) rather than feed the matchers unbounded input.
    if (
      _fieldLength(toField) > MAX_RECIPIENT_FIELD_CHARS ||
      _fieldLength(ccField) > MAX_RECIPIENT_FIELD_CHARS ||
      _fieldLength(fromField) > MAX_RECIPIENT_FIELD_CHARS
    ) {
      return "";
    }
    const claimSet = _normalizeEmailSet(claimEmails);
    if (claimSet.size === 0) return "";
    const suppressSet = new Set([..._normalizeEmailSet(suppressEmails), ...claimSet]);
    const suppressLoose = new Set([...suppressSet].map(_stripPlusTag));

    // Self-authored → never claim (loose: self-sent via a plus-alias counts).
    if (_extractAllEmails(fromField).some((e) => suppressLoose.has(_stripPlusTag(e)))) return "";
    // Direct recipient → omit (loose: To hitting a plus-alias is still direct).
    if (_extractAllEmails(toField).some((e) => suppressLoose.has(_stripPlusTag(e)))) return "";
    // Positive evidence: user's exact mailbox address in Cc → claim.
    return _extractAddressEmails(ccField).some((e) => claimSet.has(e)) ? "cc" : "";
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
    let suppress = new Set();
    try {
      suppress = (await getUserEmailSetCached()) || new Set();
    } catch (_) {}
    return classifyRecipientStatus(
      messageHeader?.recipients,
      messageHeader?.ccList,
      messageHeader?.author,
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
    const authorEmail = extractEmailFromAuthor(messageHeader?.author);
    if (!authorEmail) return false;
    return userEmails.has(authorEmail);
  } catch (_) {
    return false;
  }
}


