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
    // Duck-typed userEmails with size but no iterator → spread throws → catch → ""
    expect(classifyRecipientStatus(['a@b.com'], ['me@example.com'], FROM, { size: 1 })).toBe('');
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
