/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// senderFilter.test.js — Tests for agent/modules/senderFilter.js
//
// Tests for extractEmailFromAuthor (pure), getUserEmailSetCached (mocked browser),
// and isInternalSender (mocked browser).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));

vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));

vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

// Set up browser mock before importing the module
globalThis.browser = {
  accounts: {
    list: vi.fn(async () => []),
  },
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const { extractEmailFromAuthor, getUserEmailSetCached, isInternalSender, classifyRecipientStatus, computeRecipientStatus } = await import('../agent/modules/senderFilter.js');

// ---------------------------------------------------------------------------
// extractEmailFromAuthor (pure function)
// ---------------------------------------------------------------------------

describe('extractEmailFromAuthor', () => {
  it('extracts email from angle brackets', () => {
    expect(extractEmailFromAuthor('John Doe <john@example.com>')).toBe('john@example.com');
  });

  it('extracts email with display name containing special chars', () => {
    expect(extractEmailFromAuthor('"Doe, John" <john@example.com>')).toBe('john@example.com');
  });

  it('extracts bare email address', () => {
    expect(extractEmailFromAuthor('john@example.com')).toBe('john@example.com');
  });

  it('lowercases the result', () => {
    expect(extractEmailFromAuthor('John@EXAMPLE.COM')).toBe('john@example.com');
    expect(extractEmailFromAuthor('User <John@EXAMPLE.COM>')).toBe('john@example.com');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(extractEmailFromAuthor(null)).toBe('');
    expect(extractEmailFromAuthor(undefined)).toBe('');
    expect(extractEmailFromAuthor('')).toBe('');
  });

  it('returns empty string for malformed input with no email', () => {
    expect(extractEmailFromAuthor('just a name')).toBe('');
  });

  it('handles plus-addressed emails', () => {
    expect(extractEmailFromAuthor('User <user+tag@example.com>')).toBe('user+tag@example.com');
  });

  it('handles dotted local parts', () => {
    expect(extractEmailFromAuthor('first.last@example.com')).toBe('first.last@example.com');
  });

  it('handles multiple angle bracket pairs (takes first)', () => {
    expect(extractEmailFromAuthor('a <a@x.com> b <b@y.com>')).toBe('a@x.com');
  });

  it('handles email with subdomains', () => {
    expect(extractEmailFromAuthor('user@mail.sub.example.com')).toBe('user@mail.sub.example.com');
  });

  it('handles non-string input types', () => {
    expect(extractEmailFromAuthor(42)).toBe('');
    expect(extractEmailFromAuthor({})).toBe('');
    expect(extractEmailFromAuthor(true)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getUserEmailSetCached (browser mock)
// ---------------------------------------------------------------------------

describe('getUserEmailSetCached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a Set', async () => {
    browser.accounts.list.mockResolvedValue([]);
    const result = await getUserEmailSetCached();
    expect(result).toBeInstanceOf(Set);
  });
});

// ---------------------------------------------------------------------------
// classifyRecipientStatus (pure function)
// ---------------------------------------------------------------------------

describe('classifyRecipientStatus', () => {
  const userEmails = new Set(['me@example.com', 'me2@company.com']);
  const FROM = 'Boss <boss@example.com>'; // external author unless a test says otherwise

  // "cc" needs POSITIVE evidence (user's exact address in Cc). Absence of the
  // user from To is NOT evidence — aliases/Bcc/list mail must yield "".

  it('returns "cc" when a user address is in Cc and not in To', () => {
    expect(classifyRecipientStatus(['Other <other@example.com>'], ['Me <me@example.com>'], FROM, userEmails)).toBe('cc');
    // Any of the account's addresses counts, case-insensitively.
    expect(classifyRecipientStatus(['other@example.com'], ['ME2@Company.COM'], FROM, userEmails)).toBe('cc');
  });

  it('returns "" when a user address is in To (direct recipient)', () => {
    expect(classifyRecipientStatus(['Someone <other@example.com>', 'Me <me@example.com>'], [], FROM, userEmails)).toBe('');
    // In To wins even if ALSO in Cc.
    expect(classifyRecipientStatus(['Me <ME@Example.COM>'], ['me@example.com'], FROM, userEmails)).toBe('');
  });

  it('returns "" when the user is in neither To nor Cc (alias/Bcc/list — unsure)', () => {
    expect(classifyRecipientStatus(['Boss <boss@example.com>'], ['peer@company.com'], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus([], [], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(null, null, FROM, userEmails)).toBe('');
  });

  it('returns "" when the user is the author (self-sent/list post), even if cc\'d', () => {
    expect(classifyRecipientStatus(['list@company.com'], [], 'Me <me@example.com>', userEmails)).toBe('');
    expect(classifyRecipientStatus(['list@company.com'], ['me@example.com'], 'me@example.com', userEmails)).toBe('');
    // Self-sent via a plus-alias also counts as authored (loose suppress).
    expect(classifyRecipientStatus(['list@company.com'], ['me@example.com'], 'me+news@example.com', userEmails)).toBe('');
  });

  it('treats a plus-alias in To as direct (loose suppress — no cc claim)', () => {
    expect(classifyRecipientStatus(['me+orders@example.com'], ['me@example.com'], FROM, userEmails)).toBe('');
  });

  it('requires EXACT address match in Cc (strict claim — no plus/lookalike matching)', () => {
    // Plus-alias in Cc is not exact → unsure → "".
    expect(classifyRecipientStatus(['other@example.com'], ['me+x@example.com'], FROM, userEmails)).toBe('');
    // Lookalike/superstring addresses in Cc must not claim.
    expect(classifyRecipientStatus(['other@example.com'], ['notme@example.com'], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(['other@example.com'], ['me@example.com.evil.org'], FROM, userEmails)).toBe('');
  });

  it('returns "" when user emails cannot be determined (never claim cc unsure)', () => {
    expect(classifyRecipientStatus(['other@example.com'], ['me@example.com'], FROM, new Set())).toBe('');
    expect(classifyRecipientStatus(['other@example.com'], ['me@example.com'], FROM, null)).toBe('');
  });

  it('extracts ALL addresses per entry (display names with brackets, multi-mailbox entries)', () => {
    // Display name containing angle brackets must not hide the real address.
    expect(classifyRecipientStatus(['"Support <noreply>" <me@example.com>'], [], FROM, userEmails)).toBe('');
    // Multi-mailbox string entry in Cc — user second — still positive evidence.
    expect(classifyRecipientStatus(['other@example.com'], ['team: boss@example.com, me@example.com;'], FROM, userEmails)).toBe('cc');
  });

  it('tolerates raw comma-joined string fields (extracts ALL addresses)', () => {
    expect(classifyRecipientStatus('Boss <boss@example.com>, Me <me@example.com>', '', FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus('boss@example.com', 'peer@company.com, me@example.com', FROM, userEmails)).toBe('cc');
    // Non-array, non-string shapes → no addresses → unsure → ""
    expect(classifyRecipientStatus(42, 42, FROM, userEmails)).toBe('');
  });

  it('ignores unparseable entries', () => {
    expect(classifyRecipientStatus(['just a name', 'Me <me@example.com>'], [], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(['just a name'], ['also just a name'], FROM, userEmails)).toBe('');
  });

  it('returns "" when classification throws (defensive catch)', () => {
    // Duck-typed claimEmails without an iterator → for..of throws → catch → ""
    expect(classifyRecipientStatus(['a@b.com'], ['me@example.com'], FROM, { size: 1 })).toBe('');
  });

  it('claim path ignores address-shaped tokens in display names / comments / encoded words', () => {
    // Decoded quoted display name carrying the user's address → NOT evidence.
    expect(classifyRecipientStatus(['other@example.com'], ['"me@example.com" <bob@corp.com>'], FROM, userEmails)).toBe('');
    // RFC 2047 encoded word (raw Gmail header shape) → NOT evidence.
    expect(classifyRecipientStatus(['other@example.com'], ['=?utf-8?Q?me@example.com?= <bob@corp.com>'], FROM, userEmails)).toBe('');
    // Comment carrying the address → NOT evidence.
    expect(classifyRecipientStatus(['other@example.com'], ['(me@example.com) <bob@corp.com>'], FROM, userEmails)).toBe('');
    // Unquoted display-name address before a bracketed mailbox → NOT evidence.
    expect(classifyRecipientStatus(['other@example.com'], ['me@example.com <bob@corp.com>'], FROM, userEmails)).toBe('');
    // Unclosed bracket → yields nothing rather than falling back to display text.
    expect(classifyRecipientStatus(['other@example.com'], ['<bob@corp.com me@example.com'], FROM, userEmails)).toBe('');
    // The user actually bracketed in Cc still claims.
    expect(classifyRecipientStatus(['other@example.com'], ['"Anything at all" <me@example.com>'], FROM, userEmails)).toBe('cc');
  });

  it('full atext extraction: no truncated-tail collisions with neighboring addresses', () => {
    // o'brien@example.com must extract WHOLE — a narrow class would yield
    // brien@example.com and falsely claim for user brien@example.com.
    const brien = new Set(['brien@example.com']);
    expect(classifyRecipientStatus(['other@example.com'], ["o'brien@example.com"], FROM, brien)).toBe('');
    // And o'brien in To must not suppress user brien (different mailbox)…
    expect(classifyRecipientStatus(["o'brien@example.com"], ['brien@example.com'], FROM, brien)).toBe('cc');
    // …while the real o'brien user still matches exactly.
    const obrien = new Set(["o'brien@example.com"]);
    expect(classifyRecipientStatus(['other@example.com'], ["O'Brien <o'brien@example.com>"], FROM, obrien)).toBe('cc');
  });

  it('claim path is whole-token anchored — truncated heads/tails never claim', () => {
    // Combining mark after the address (Swift graphemes vs JS code units — the
    // anchored exact match rejects on BOTH platforms, restoring parity).
    expect(classifyRecipientStatus(['other@example.com'], ['<me@example.coḿ>'], FROM, userEmails)).toBe('');
    // Non-ASCII prefix restarts a substring match mid-token; exact match rejects.
    expect(classifyRecipientStatus(['other@example.com'], ['<öme@example.com>'], FROM, userEmails)).toBe('');
    // Trailing junk after a matching domain must not claim the prefix.
    expect(classifyRecipientStatus(['other@example.com'], ['<me@example.com_x>'], FROM, userEmails)).toBe('');
    // Bracket span with extra tokens is not a single addr-spec.
    expect(classifyRecipientStatus(['other@example.com'], ['<junk me@example.com>'], FROM, userEmails)).toBe('');
  });

  it('a part with brackets counts ONLY bracketed spans (quote-imbalance defense)', () => {
    // Unescaped quotes in a formatted display name can strand a planted
    // address in a bare comma segment — the bracket-in-part rule ignores it.
    expect(classifyRecipientStatus(
      ['other@example.com'], ['"a", me@example.com, b" <other2@example.com>'], FROM, userEmails
    )).toBe('');
    // Deliberate trade-off: a bare address mixed into a bracketed part is
    // also ignored (missed claim = safe omit).
    expect(classifyRecipientStatus(
      ['other@example.com'], ['me@example.com, Name <c@company.com>'], FROM, userEmails
    )).toBe('');
  });

  it('group syntax: leading "name:" prefix is stripped for the first member', () => {
    expect(classifyRecipientStatus(['other@example.com'], ['team: me@example.com, boss@example.com;'], FROM, userEmails)).toBe('cc');
  });

  it('bounded matcher input: degenerate runs and oversized fields safely omit', () => {
    // 100KB unbroken atext run — must complete fast (token bound) and omit.
    const run = 'a'.repeat(100000);
    const t0 = Date.now();
    expect(classifyRecipientStatus(['other@example.com'], [run], FROM, userEmails)).toBe('');
    // Same run glued to the user's address: one giant token, dropped → omit.
    expect(classifyRecipientStatus(['other@example.com'], [run + 'me@example.com'], FROM, userEmails)).toBe('');
    // Oversized field (> 64KB) → classification skipped entirely.
    expect(classifyRecipientStatus([run], ['me@example.com'], FROM, userEmails)).toBe('');
    expect(Date.now() - t0).toBeLessThan(2000);
    // Normal-size comma-packed list still extracts on the claim path.
    const packed = Array.from({ length: 200 }, (_, i) => `u${i}@example.com`).join(',') + ',me@example.com';
    expect(classifyRecipientStatus(['other@example.com'], [packed], FROM, userEmails)).toBe('cc');
  });

  it('claim path is linear on unbalanced-opener floods (round-2 ReDoS shapes)', () => {
    // '<' and '(' floods at the 64KB field cap previously hit quadratic regex
    // scans (~6s in JS, minutes in Swift). Linear scans must stay fast.
    const t0 = Date.now();
    expect(classifyRecipientStatus(['other@example.com'], ['<'.repeat(65536)], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(['other@example.com'], ['('.repeat(65536)], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(['other@example.com'], ['"'.repeat(65536)], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(['other@example.com'], ['=?'.repeat(32768)], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(['other@example.com'], ['<a'.repeat(32768)], FROM, userEmails)).toBe('');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('many REAL addresses stay fast (per-candidate validator cost is bounded)', () => {
    // Flood shapes produce zero exactAddr calls; this shape produces 2000
    // (sized under the 64KB field cap) — pins the per-candidate cost (the
    // round-3 Swift finding class).
    const bracketed = Array.from({ length: 2000 }, (_, i) => `U${i} <u${i}@example.com>`).join(', ');
    const bare = Array.from({ length: 2000 }, (_, i) => `u${i}@example.com`).join(',');
    const t0 = Date.now();
    expect(classifyRecipientStatus(['other@example.com'], [bracketed + ', Me <me@example.com>'], FROM, userEmails)).toBe('cc');
    expect(classifyRecipientStatus(['other@example.com'], [bare + ',me@example.com'], FROM, userEmails)).toBe('cc');
    // Large To (user absent) exercises the suppress path at volume; user in Cc still claims.
    expect(classifyRecipientStatus([bare], ['me@example.com'], FROM, userEmails)).toBe('cc');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('bracket-exposed display-name injection cannot fabricate a claim (last-span rule)', () => {
    // SwiftMail MIME-decodes a display name and re-wraps it in UNESCAPED quotes,
    // so a Cc entry `bob@corp.com` with decoded name `x" <me@example.com> "y`
    // reaches the classifier as: "x" <me@example.com> "y" <bob@corp.com>.
    // The escaped-quote defense doesn't apply (quotes are unescaped), so the
    // planted <me@example.com> survives quote-stripping. Only the LAST bracket
    // span per segment is the real address, so the injection is rejected.
    expect(classifyRecipientStatus(
      ['other@example.com'], ['"x" <me@example.com> "y" <bob@corp.com>'], FROM, userEmails
    )).toBe('');
    // Bare-address form in a display position (before the real bracket) too.
    expect(classifyRecipientStatus(
      ['other@example.com'], ['me@example.com <bob@corp.com>'], FROM, userEmails
    )).toBe('');
    // The real user address as the LAST span still claims.
    expect(classifyRecipientStatus(
      ['other@example.com'], ['"decoy <bob@corp.com>" <me@example.com>'], FROM, userEmails
    )).toBe('cc');
    // Multi-address list where an injected span precedes each real address.
    expect(classifyRecipientStatus(
      ['other@example.com'], ['"<me@example.com>" <a@corp.com>, "<me@example.com>" <b@corp.com>'], FROM, userEmails
    )).toBe('');
  });

  it('documents the accepted residual: unescaped-quote + comma injection (KNOWN LIMITATION)', () => {
    // ACCEPTED LOW-IMPACT LIMITATION (2026-07-05) — see _extractAddressEmails
    // doc + PROJECT_MEMORY.md. When a producer (SwiftMail IMAP formatAddress)
    // emits the decoded display name in UNESCAPED quotes AND the name contains
    // a comma/semicolon, the injected <me@example.com> becomes the last span of
    // its own segment. The resulting string is BYTE-IDENTICAL to a legitimate
    // two-recipient Cc that MUST claim, so no string parser can distinguish
    // them. This test PINS the current (spuriously "cc") behavior so the
    // tradeoff is visible; it is NOT an endorsement. Flipping it to "" requires
    // producer-side escaping or structured per-address plumbing (out of scope).
    expect(classifyRecipientStatus(
      ['other@example.com'], ['"x" <me@example.com> , "y" <bob@corp.com>'], FROM, userEmails
    )).toBe('cc');
    // The legitimate twin it is byte-ambiguous with — MUST claim (a real
    // multi-recipient Cc where the user is genuinely a named recipient).
    expect(classifyRecipientStatus(
      ['other@example.com'], ['"Me" <me@example.com>, "Bob" <bob@corp.com>'], FROM, userEmails
    )).toBe('cc');
  });

  it('sanitizers are escape-aware — escaped delimiters cannot expose planted spans', () => {
    // Backslash-escaped quotes inside a quoted display name mis-paired the
    // old regex sanitizer, exposing <victim> as a countable span.
    expect(classifyRecipientStatus(
      ['other@example.com'], ['"a\\" <me@example.com> \\"b" <real@company.com>'], FROM, userEmails
    )).toBe('');
    // Same for escaped parens inside a comment.
    expect(classifyRecipientStatus(
      ['other@example.com'], ['(a\\) <me@example.com> \\(b) <real@company.com>'], FROM, userEmails
    )).toBe('');
    // Escaped-escape (\\\\) before a quote is NOT an escaped quote — still pairs.
    expect(classifyRecipientStatus(
      ['other@example.com'], ['"a\\\\" <me@example.com>'], FROM, userEmails
    )).toBe('cc');
  });

  it('suppressEmails only suppress — they never create a claim', () => {
    const claim = new Set(['me@example.com']);
    const suppress = new Set(['otheracct@example.com']);
    // Another own account in To → suppressed even though claim address is in Cc.
    expect(classifyRecipientStatus(['otheracct@example.com'], ['me@example.com'], FROM, claim, suppress)).toBe('');
    // Another own account as the AUTHOR → suppressed.
    expect(classifyRecipientStatus(['list@company.com'], ['me@example.com'], 'otheracct@example.com', claim, suppress)).toBe('');
    // A suppress-only address in Cc does NOT claim.
    expect(classifyRecipientStatus(['other@example.com'], ['otheracct@example.com'], FROM, claim, suppress)).toBe('');
    // Suppress list absent → claim set alone still works.
    expect(classifyRecipientStatus(['other@example.com'], ['me@example.com'], FROM, claim)).toBe('cc');
  });
});

// ---------------------------------------------------------------------------
// computeRecipientStatus (browser mock)
// ---------------------------------------------------------------------------

describe('computeRecipientStatus', () => {
  // Realistic TB 145 MailAccount shape: NO top-level `email` property —
  // addresses live ONLY on identities (this is how background.js and the
  // WebExtension API expose them). Mixed case on purpose: the account-side
  // normalization is part of the comparison contract.
  const receivingAccount = {
    id: 'account1',
    type: 'imap',
    identities: [{ email: 'Me@Example.com' }, { email: 'alias@example.com' }],
  };

  function makeHeader(recipients, ccList = [], author = 'Boss <boss@example.com>') {
    return { folder: { accountId: 'account1' }, recipients, ccList, author };
  }

  beforeEach(() => {
    browser.accounts.get = vi.fn(async () => receivingAccount);
  });

  it('returns "cc" when an identity email is in ccList (identities-only account shape)', async () => {
    expect(await computeRecipientStatus(makeHeader(['other@example.com'], ['Me <me@example.com>']))).toBe('cc');
    expect(await computeRecipientStatus(makeHeader(['other@example.com'], ['alias@example.com']))).toBe('cc');
  });

  it('returns "" when the identity email is in To (direct recipient)', async () => {
    expect(await computeRecipientStatus(makeHeader(['Someone <me@example.com>']))).toBe('');
    expect(await computeRecipientStatus(makeHeader(['alias@example.com'], ['me@example.com']))).toBe('');
  });

  it('returns "" when the user authored the message (reads messageHeader.author)', async () => {
    expect(await computeRecipientStatus(
      makeHeader(['list@company.com'], ['me@example.com'], 'Me <me@example.com>')
    )).toBe('');
  });

  it('returns "" when the user is in neither To nor Cc (unsure)', async () => {
    expect(await computeRecipientStatus(makeHeader(['Boss <boss@example.com>']))).toBe('');
    expect(await computeRecipientStatus(makeHeader([], []))).toBe('');
  });

  it('also honors a top-level account.email when present (defensive)', async () => {
    browser.accounts.get = vi.fn(async () => ({ type: 'imap', email: 'Top@Example.com', identities: [] }));
    expect(await computeRecipientStatus(makeHeader(['other@example.com'], ['top@example.com']))).toBe('cc');
    expect(await computeRecipientStatus(makeHeader(['Someone <top@example.com>']))).toBe('');
  });

  it('passes the message accountId to accounts.get (not some other account)', async () => {
    await computeRecipientStatus(makeHeader(['x@y.com']));
    expect(browser.accounts.get).toHaveBeenCalledWith('account1', false);
  });

  it("does NOT claim cc for ANOTHER account's address in Cc (receiving-account scope)", async () => {
    // otheracct@example.com may be a different registered account, but the
    // check is deliberately scoped to the account the email arrived on.
    expect(await computeRecipientStatus(makeHeader(['x@y.com'], ['otheracct@example.com']))).toBe('');
  });

  it('returns "" when the account has no resolvable addresses', async () => {
    browser.accounts.get = vi.fn(async () => ({ type: 'imap', identities: [] }));
    expect(await computeRecipientStatus(makeHeader(['other@example.com'], ['me@example.com']))).toBe('');
  });

  it('returns "" for a null header or header without a folder/accountId', async () => {
    expect(await computeRecipientStatus(null)).toBe('');
    expect(await computeRecipientStatus({ recipients: ['other@example.com'], ccList: ['me@example.com'] })).toBe('');
  });

  it('returns "" when accounts.get rejects (defensive catch)', async () => {
    browser.accounts.get = vi.fn(async () => { throw new Error('gone'); });
    expect(await computeRecipientStatus(makeHeader(['other@example.com'], ['me@example.com']))).toBe('');
  });

  it('returns "" when header property access throws (defensive catch)', async () => {
    const evil = new Proxy({}, { get() { throw new Error('boom'); } });
    expect(await computeRecipientStatus(evil)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// invalidateUserEmailCache
// ---------------------------------------------------------------------------

describe('invalidateUserEmailCache', () => {
  it('forces the next getUserEmailSetCached call to reload from accounts', async () => {
    const { invalidateUserEmailCache } = await import('../agent/modules/senderFilter.js');
    browser.accounts.list.mockResolvedValue([
      { type: 'imap', identities: [{ email: 'fresh@example.com' }] },
    ]);
    // Cached set (empty from earlier tests) is returned until invalidated.
    expect((await getUserEmailSetCached()).has('fresh@example.com')).toBe(false);
    invalidateUserEmailCache();
    expect((await getUserEmailSetCached()).has('fresh@example.com')).toBe(true);
    // Leave the module cache empty for any later tests (restore old state).
    browser.accounts.list.mockResolvedValue([]);
    invalidateUserEmailCache();
    await getUserEmailSetCached();
  });
});

// ---------------------------------------------------------------------------
// isInternalSender (browser mock)
// ---------------------------------------------------------------------------

describe('isInternalSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when no accounts', async () => {
    browser.accounts.list.mockResolvedValue([]);
    const result = await isInternalSender({ author: 'someone@example.com' });
    expect(result).toBe(false);
  });

  it('returns false for null message header', async () => {
    const result = await isInternalSender(null);
    expect(result).toBe(false);
  });

  it('returns false when author has no email', async () => {
    const result = await isInternalSender({ author: 'just a name' });
    expect(result).toBe(false);
  });
});
