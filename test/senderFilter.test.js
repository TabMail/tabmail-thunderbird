/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// senderFilter.test.js — Tests for agent/modules/senderFilter.js
//
// Tests for readAddressFields / readSenderEmail (Thunderbird's own parse of the raw headers),
// getUserEmailSetCached (mocked browser), classifyRecipientStatus (pure), computeRecipientStatus
// and isInternalSender. Messages are synthetic raw From/To/Cc headers (tbMessages): the
// experiment's getAddressFields answers with Thunderbird's parse of them (vendored JSMime), and
// each MessageHeader also carries the author/recipients/ccList strings Thunderbird would give,
// which the add-on must never parse.

import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { tbMessages, withTbAddressFields } from './helpers/tbAddressParser.js';

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
const messages = tbMessages();
globalThis.browser = withTbAddressFields({
  accounts: {
    list: vi.fn(async () => []),
  },
}, messages);

/** A message with this raw From header (and To/Cc when given). */
function fromHeader(from, extra = {}) {
  return messages.add({ from }, extra);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const { readAddressFields, readSenderEmail, getUserEmailSetCached, invalidateUserEmailCache, isInternalSender, classifyRecipientStatus, computeRecipientStatus } = await import('../agent/modules/senderFilter.js');

// ---------------------------------------------------------------------------
// readSenderEmail / readAddressFields (Thunderbird's parse of the raw headers)
// ---------------------------------------------------------------------------

describe('readSenderEmail', () => {
  it('reads the address after a name', async () => {
    expect(await readSenderEmail(fromHeader('John Doe <john@example.com>'))).toBe('john@example.com');
  });

  it('reads the address after a quoted name with a comma', async () => {
    expect(await readSenderEmail(fromHeader('"Doe, John" <john@example.com>'))).toBe('john@example.com');
  });

  it('reads a bare address', async () => {
    expect(await readSenderEmail(fromHeader('john@example.com'))).toBe('john@example.com');
  });

  it('lowercases the result', async () => {
    expect(await readSenderEmail(fromHeader('John@EXAMPLE.COM'))).toBe('john@example.com');
    expect(await readSenderEmail(fromHeader('User <John@EXAMPLE.COM>'))).toBe('john@example.com');
  });

  it('returns empty string for an empty From', async () => {
    expect(await readSenderEmail(fromHeader(''))).toBe('');
  });

  it('returns empty string for a From with no address', async () => {
    expect(await readSenderEmail(fromHeader('just a name'))).toBe('');
  });

  it('handles plus-addressed emails', async () => {
    expect(await readSenderEmail(fromHeader('User <user+tag@example.com>'))).toBe('user+tag@example.com');
  });

  it('handles dotted local parts', async () => {
    expect(await readSenderEmail(fromHeader('first.last@example.com'))).toBe('first.last@example.com');
  });

  it('reads the whole local part (every atext character)', async () => {
    expect(await readSenderEmail(fromHeader("o'brien@example.com"))).toBe("o'brien@example.com");
  });

  it('handles email with subdomains', async () => {
    expect(await readSenderEmail(fromHeader('user@mail.sub.example.com'))).toBe('user@mail.sub.example.com');
  });

  it('returns empty string with no message, an id that is not a message id, or a gone message', async () => {
    expect(await readSenderEmail(null)).toBe('');
    expect(await readSenderEmail(undefined)).toBe('');
    expect(await readSenderEmail({})).toBe('');
    expect(await readSenderEmail({ id: '1', author: 'john@example.com' })).toBe('');
    expect(await readSenderEmail({ id: 999999, author: 'john@example.com' })).toBe('');
  });

  it('returns empty string when the header read fails', async () => {
    const read = browser.tmHdr.getAddressFields;
    browser.tmHdr.getAddressFields = vi.fn(async () => { throw new Error('synthetic read failure'); });
    try {
      expect(await readSenderEmail(fromHeader('john@example.com'))).toBe('');
    } finally {
      browser.tmHdr.getAddressFields = read;
    }
  });
});

// The sender is the first mailbox of Thunderbird's own parse of the raw From header; its address
// is the one Thunderbird's parser reads, never text in a display name, a comment or an encoded word.
const AUTHOR_FORMS = [
  ['quoted name holding an angle-addr', '"Me <me@example.com>" <other@example.net>', 'other@example.net'],
  ['escaped quotes in the name', '"Ann \\"x\\" <a@example.com>" <b@example.net>', 'b@example.net'],
  ['one escaped quote in the name', '"Ann \\" <a@example.com>" <b@example.net>', 'b@example.net'],
  ['an open parenthesis inside quotes', '"( <a@example.com>" <b@example.net>', 'b@example.net'],
  ['a comment holding an angle-addr before the name', '(<a@example.com>) Real <b@example.net>', 'b@example.net'],
  ['a comment holding an angle-addr after the address', 'Real <b@example.net> (<a@example.com>)', 'b@example.net'],
  ['a bare address with such a comment', 'b@example.net (<a@example.com>)', 'b@example.net'],
  ['nested comments', 'b@example.net ((x) <a@example.com>)', 'b@example.net'],
  ['two angle-addrs (Thunderbird keeps the last)', 'Real <a@example.com> <b@example.net>', 'b@example.net'],
  ['an encoded name that decodes to an angle-addr and a comma', '=?UTF-8?Q?X_<a@example.com>,?= <b@example.net>', 'b@example.net'],
  ['a non-ASCII quoted name holding an angle-addr', '"\u00e9 <a@example.com>" <b@example.net>', 'b@example.net'],
  ['a quoted local part holding ">"', '"x>y"@example.com', '"x>y"@example.com'],
  ['an unterminated quote', '"unterminated <a@example.com>', ''],
  ['an address only inside quotes', '"<a@example.com>"', ''],
  ['group syntax (the first member)', 'Team: a@example.com, b@example.net;', 'a@example.com'],
  ['several authors (the first)', 'Ann <a@example.com>, Bob <b@example.net>', 'a@example.com'],
  ['an unquoted comma in the name (Thunderbird reads a list; the first mailbox is "Doe")', 'Doe, John <john@example.com>', ''],
  ['a quoted comma in the name', '"Doe, John" <john@example.com>', 'john@example.com'],
  ['a bare address', 'b@example.net', 'b@example.net'],
  ['a name with no address', 'MAILER-DAEMON', ''],
  ['a name that begins and ends with a quote mark, holding an angle-addr', '"\\"x\\" <me@example.com> \\"" <bob@example.net>', 'bob@example.net'],
  ['an encoded name that decodes to such a name', '=?UTF-8?Q?=22x=22_=3Cme=40example=2Ecom=3E_=22?= <bob@example.net>', 'bob@example.net'],
  ['an encoded name that decodes to two quoted names around an angle-addr and a comma', '=?UTF-8?Q?=22x=22_<me@example.com>,_=22y=22?= <bob@example.net>', 'bob@example.net'],
];

describe('readSenderEmail reads the address Thunderbird parses, outside quotes, comments and encoded words', () => {
  it.each(AUTHOR_FORMS)('%s', async (_label, rawFrom, expected) => {
    expect(await readSenderEmail(fromHeader(rawFrom))).toBe(expected);
  });
});

describe('readAddressFields', () => {
  it("returns each field's mailboxes with their names and addresses as Thunderbird reads them, every From mailbox in order", async () => {
    const header = messages.add({
      from: '"Me <me@example.com>" <Other@Example.NET>, Bob <bob@example.net>',
      to: 'Ann <a@example.com>, "Doe, John" <john@example.com>',
      cc: 'team: c@example.net, d@example.net;, just a name',
    });
    expect(await readAddressFields([header.id])).toEqual([{
      author: [
        { name: 'Me <me@example.com>', email: 'Other@Example.NET' },
        { name: 'Bob', email: 'bob@example.net' },
      ],
      recipients: [
        { name: 'Ann', email: 'a@example.com' },
        { name: 'Doe, John', email: 'john@example.com' },
      ],
      ccList: [
        { name: '', email: 'c@example.net' },
        { name: '', email: 'd@example.net' },
        { name: 'just a name', email: '' },
      ],
    }]);
  });

  it('returns null for a gone message and for an id that is not a message id, in order', async () => {
    const header = fromHeader('a@example.com');
    const result = await readAddressFields([999999, header.id, 'x', null]);
    expect(result.map((fields) => fields?.author[0]?.email ?? null)).toEqual([null, 'a@example.com', null, null]);
  });

  it('asks Thunderbird once for several messages, each id once, and not at all without a message id', async () => {
    const a = fromHeader('a@example.com');
    const b = fromHeader('b@example.net');
    const spy = vi.spyOn(browser.tmHdr, 'getAddressFields');
    try {
      const result = await readAddressFields([a.id, b.id, a.id]);
      expect(result.map((fields) => fields.author[0].email)).toEqual(['a@example.com', 'b@example.net', 'a@example.com']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith([a.id, b.id]);
      spy.mockClear();
      expect(await readAddressFields([])).toEqual([]);
      expect(await readAddressFields(['x', undefined])).toEqual([null, null]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// getUserEmailSetCached (browser mock)
// ---------------------------------------------------------------------------

describe('getUserEmailSetCached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateUserEmailCache();
  });

  it('returns a Set', async () => {
    browser.accounts.list.mockResolvedValue([]);
    const result = await getUserEmailSetCached();
    expect(result).toBeInstanceOf(Set);
  });

  it('does not install a stale account snapshot when an identity changes during loading', async () => {
    let releaseOld;
    browser.accounts.list.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }))
      .mockResolvedValue([{ type: 'imap', identities: [{ email: 'new@example.test' }] }]);
    const pending = getUserEmailSetCached();
    invalidateUserEmailCache();
    releaseOld([{ type: 'imap', identities: [{ email: 'old@example.test' }] }]);
    const result = await pending;
    expect(result.has('new@example.test')).toBe(true);
    expect(result.has('old@example.test')).toBe(false);
    expect((await getUserEmailSetCached()).has('new@example.test')).toBe(true);
  });

  it.each(['resolve', 'reject'])('keeps the newer identity when an older load later %ss', async completion => {
    let resolveOld, rejectOld;
    const oldLoad = new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    browser.accounts.list.mockImplementationOnce(() => oldLoad)
      .mockResolvedValue([{ type: 'imap', identities: [{ email: 'new@example.test' }] }]);
    const oldReader = getUserEmailSetCached();
    invalidateUserEmailCache();
    const newReader = await getUserEmailSetCached();
    expect(newReader.has('new@example.test')).toBe(true);
    if (completion === 'resolve') {
      resolveOld([{ type: 'imap', identities: [{ email: 'old@example.test' }] }]);
    } else {
      rejectOld(new Error('synthetic old load failure'));
    }
    expect((await oldReader).has('new@example.test')).toBe(true);
    expect((await getUserEmailSetCached()).has('old@example.test')).toBe(false);
    expect(await isInternalSender(fromHeader('new@example.test'))).toBe(true);
    expect(await isInternalSender(fromHeader('old@example.test'))).toBe(false);
    expect(browser.accounts.list).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// classifyRecipientStatus (pure function over parsed addresses)
// ---------------------------------------------------------------------------

describe('classifyRecipientStatus', () => {
  const userEmails = new Set(['me@example.com', 'me2@example.net']);
  const FROM = ['boss@example.com']; // external author unless a test says otherwise

  // "cc" needs POSITIVE evidence (user's exact address in Cc). Absence of the
  // user from To is NOT evidence — aliases/Bcc/list mail must yield "".

  it('returns "cc" when a user address is in Cc and not in To', () => {
    expect(classifyRecipientStatus(['other@example.com'], ['me@example.com'], FROM, userEmails)).toBe('cc');
    // Any of the account's addresses counts, case-insensitively.
    expect(classifyRecipientStatus(['other@example.com'], ['ME2@Example.NET'], FROM, userEmails)).toBe('cc');
  });

  it('returns "" when a user address is in To (direct recipient)', () => {
    expect(classifyRecipientStatus(['other@example.com', 'me@example.com'], [], FROM, userEmails)).toBe('');
    // In To wins even if ALSO in Cc.
    expect(classifyRecipientStatus(['ME@Example.COM'], ['me@example.com'], FROM, userEmails)).toBe('');
  });

  it('returns "" when the user is in neither To nor Cc (alias/Bcc/list — unsure)', () => {
    expect(classifyRecipientStatus(['boss@example.com'], ['peer@example.net'], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus([], [], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(null, null, FROM, userEmails)).toBe('');
  });

  it('returns "" when the user is the author (self-sent/list post), even if cc\'d', () => {
    expect(classifyRecipientStatus(['list@example.net'], [], ['me@example.com'], userEmails)).toBe('');
    expect(classifyRecipientStatus(['list@example.net'], ['me@example.com'], ['me@example.com'], userEmails)).toBe('');
    // Self-sent via a plus-alias also counts as authored (loose suppress).
    expect(classifyRecipientStatus(['list@example.net'], ['me@example.com'], ['me+news@example.com'], userEmails)).toBe('');
  });

  it('treats a plus-alias in To as direct (loose suppress — no cc claim)', () => {
    expect(classifyRecipientStatus(['me+orders@example.com'], ['me@example.com'], FROM, userEmails)).toBe('');
  });

  it('requires EXACT address match in Cc (strict claim — no plus/lookalike matching)', () => {
    // Plus-alias in Cc is not exact → unsure → "".
    expect(classifyRecipientStatus(['other@example.com'], ['me+x@example.com'], FROM, userEmails)).toBe('');
    // Lookalike/superstring addresses in Cc must not claim.
    expect(classifyRecipientStatus(['other@example.com'], ['notme@example.com'], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(['other@example.com'], ['me@example.com.example.net'], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(['other@example.com'], ['\u00f6me@example.com'], FROM, userEmails)).toBe('');
    expect(classifyRecipientStatus(['other@example.com'], ['me@example.co\u0301m'], FROM, userEmails)).toBe('');
  });

  it('returns "" when user emails cannot be determined (never claim cc unsure)', () => {
    expect(classifyRecipientStatus(['other@example.com'], ['me@example.com'], FROM, new Set())).toBe('');
    expect(classifyRecipientStatus(['other@example.com'], ['me@example.com'], FROM, null)).toBe('');
  });

  it('returns "" when classification throws (defensive catch)', () => {
    // Duck-typed claimEmails without an iterator → for..of throws → catch → ""
    expect(classifyRecipientStatus(['a@example.com'], ['me@example.com'], FROM, { size: 1 })).toBe('');
  });

  it('suppressEmails only suppress — they never create a claim', () => {
    const claim = new Set(['me@example.com']);
    const suppress = new Set(['otheracct@example.com']);
    // Another own account in To → suppressed even though claim address is in Cc.
    expect(classifyRecipientStatus(['otheracct@example.com'], ['me@example.com'], FROM, claim, suppress)).toBe('');
    // Another own account as the AUTHOR → suppressed.
    expect(classifyRecipientStatus(['list@example.net'], ['me@example.com'], ['otheracct@example.com'], claim, suppress)).toBe('');
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

  // A message on the receiving account with these raw To, Cc and From headers.
  function makeHeader(rawTo, rawCc = '', rawFrom = 'Boss <boss@example.com>') {
    return messages.add({ from: rawFrom, to: rawTo, cc: rawCc }, { folder: { accountId: 'account1' } });
  }

  beforeEach(() => {
    browser.accounts.get = vi.fn(async () => receivingAccount);
  });

  it('returns "cc" when an identity email is in ccList (identities-only account shape)', async () => {
    expect(await computeRecipientStatus(makeHeader('other@example.com', 'Me <me@example.com>'))).toBe('cc');
    expect(await computeRecipientStatus(makeHeader('other@example.com', 'alias@example.com'))).toBe('cc');
  });

  it('returns "" when the identity email is in To (direct recipient)', async () => {
    expect(await computeRecipientStatus(makeHeader('Someone <me@example.com>'))).toBe('');
    expect(await computeRecipientStatus(makeHeader('alias@example.com', 'me@example.com'))).toBe('');
  });

  it('returns "" when the user authored the message (reads the From header)', async () => {
    expect(await computeRecipientStatus(
      makeHeader('list@example.net', 'me@example.com', 'Me <me@example.com>')
    )).toBe('');
  });

  it('returns "" when the user is any of several authors', async () => {
    expect(await computeRecipientStatus(
      makeHeader('list@example.net', 'me@example.com', 'Boss <boss@example.com>, Me <me@example.com>')
    )).toBe('');
  });

  it('returns "" when the user is in neither To nor Cc (unsure)', async () => {
    expect(await computeRecipientStatus(makeHeader('Boss <boss@example.com>'))).toBe('');
    expect(await computeRecipientStatus(makeHeader('', ''))).toBe('');
  });

  it('also honors a top-level account.email when present (defensive)', async () => {
    browser.accounts.get = vi.fn(async () => ({ type: 'imap', email: 'Top@Example.com', identities: [] }));
    expect(await computeRecipientStatus(makeHeader('other@example.com', 'top@example.com'))).toBe('cc');
    expect(await computeRecipientStatus(makeHeader('Someone <top@example.com>'))).toBe('');
  });

  it('passes the message accountId to accounts.get (not some other account)', async () => {
    await computeRecipientStatus(makeHeader('x@example.net'));
    expect(browser.accounts.get).toHaveBeenCalledWith('account1', false);
  });

  it("does NOT claim cc for ANOTHER account's address in Cc (receiving-account scope)", async () => {
    // otheracct@example.com may be a different registered account, but the
    // check is deliberately scoped to the account the email arrived on.
    expect(await computeRecipientStatus(makeHeader('x@example.net', 'otheracct@example.com'))).toBe('');
  });

  it('returns "" when the account has no resolvable addresses', async () => {
    browser.accounts.get = vi.fn(async () => ({ type: 'imap', identities: [] }));
    expect(await computeRecipientStatus(makeHeader('other@example.com', 'me@example.com'))).toBe('');
  });

  it('returns "" for a null header or header without a folder/accountId', async () => {
    expect(await computeRecipientStatus(null)).toBe('');
    expect(await computeRecipientStatus(messages.add({ to: 'other@example.com', cc: 'me@example.com' }))).toBe('');
  });

  it('returns "" when the message is gone or its id is not a message id (no claim)', async () => {
    const folder = { accountId: 'account1' };
    expect(await computeRecipientStatus({ id: 999999, folder, recipients: ['other@example.com'], ccList: ['me@example.com'] })).toBe('');
    expect(await computeRecipientStatus({ folder, recipients: ['other@example.com'], ccList: ['me@example.com'] })).toBe('');
  });

  it('returns "" when the header read fails', async () => {
    const read = browser.tmHdr.getAddressFields;
    browser.tmHdr.getAddressFields = vi.fn(async () => { throw new Error('synthetic read failure'); });
    try {
      expect(await computeRecipientStatus(makeHeader('other@example.com', 'me@example.com'))).toBe('');
    } finally {
      browser.tmHdr.getAddressFields = read;
    }
  });

  it('returns "" when accounts.get rejects (defensive catch)', async () => {
    browser.accounts.get = vi.fn(async () => { throw new Error('gone'); });
    expect(await computeRecipientStatus(makeHeader('other@example.com', 'me@example.com'))).toBe('');
  });

  it('returns "" when header property access throws (defensive catch)', async () => {
    const evil = new Proxy({}, { get() { throw new Error('boom'); } });
    expect(await computeRecipientStatus(evil)).toBe('');
  });

  // The Cc claim reads only the Cc mailboxes' own addresses: never text in a display name,
  // a comment or an encoded word, and never across a quoted comma.
  it.each([
    ['a quoted name holding the address', '"me@example.com" <bob@example.net>', ''],
    ['an encoded name holding the address', '=?utf-8?Q?me@example.com?= <bob@example.net>', ''],
    ['a comment holding the address', '(me@example.com) <bob@example.net>', ''],
    ['an unquoted name holding the address', 'me@example.com <bob@example.net>', ''],
    ['an unclosed angle bracket', '<bob@example.net me@example.com', ''],
    ['nested comments holding an angle-addr', 'Real <real@example.net> ((x) <me@example.com>)', ''],
    ['a quote inside a comment', 'Real <real@example.net>, (") "<me@example.com>"', ''],
    ['encoded-word markers across quotes and comments', '"x=?y" <real@example.net> (z?=" <me@example.com> "")', ''],
    ['encoded-word markers around an angle-addr', '=?a <real@example.net> ?= me@example.com', ''],
    ['encoded-word markers inside an angle-addr', 'Real <=?a?Q?x?=me@example.com>', ''],
    ['encoded-word markers before a bare address', '=?x?Q?<real@example.net>?= me@example.com', ''],
    ['escaped quotes around an angle-addr', '"a\\" <me@example.com> \\"b" <real@example.net>', ''],
    ['escaped parentheses around an angle-addr', '(a\\) <me@example.com> \\(b) <real@example.net>', ''],
    ['the address in each quoted name of a list', '"<me@example.com>" <a@example.net>, "<me@example.com>" <b@example.net>', ''],
    ['an encoded name that decodes to a quote, the address and a comma', '=?UTF-8?Q?x"_<me@example.com>,_"y?= <bob@example.net>', ''],
    ['a name that begins and ends with a quote mark, holding the address', '"\\"x\\" <me@example.com> \\"" <bob@example.net>', ''],
    ['an encoded name that decodes to such a name', '=?UTF-8?Q?=22x=22_=3Cme=40example=2Ecom=3E_=22?= <bob@example.net>', ''],
    ['an encoded name that decodes to two quoted names around the address and a comma', '=?UTF-8?Q?=22x=22_<me@example.com>,_=22y=22?= <bob@example.net>', ''],
    ['a combining mark after the domain', '<me@example.cóm>', ''],
    ['a non-ASCII local part', '<öme@example.com>', ''],
    ['the address with any name', '"Anything at all" <me@example.com>', 'cc'],
    ['two named mailboxes', '"Me" <me@example.com>, "Bob" <bob@example.net>', 'cc'],
    ['two named mailboxes with a space before the comma', '"x" <me@example.com> , "y" <bob@example.net>', 'cc'],
    ['a group', 'team: boss@example.com, me@example.com;', 'cc'],
    ['a bare address before a named mailbox', 'me@example.com, Name <c@example.net>', 'cc'],
    ['an unbalanced quote that leaves the address a mailbox of its own', '"a", me@example.com, b" <other2@example.net>', 'cc'],
  ])('Cc with %s → "%s"', async (_label, rawCc, expected) => {
    expect(await computeRecipientStatus(makeHeader('other@example.com', rawCc))).toBe(expected);
  });

  // To and From suppress only on their mailboxes' own addresses (plus-tags stripped).
  it.each([
    ['To names the address only in a quoted name', '"Me <me@example.com>" <list@example.net>', 'Boss <boss@example.com>', 'cc'],
    ['From names the address only in a quoted name', 'other@example.com', '"Me <me@example.com>" <boss@example.net>', 'cc'],
    ['From names the address only in a name that begins and ends with a quote mark', 'other@example.com', '"\\"x\\" <me@example.com> \\"" <boss@example.net>', 'cc'],
    ['To holds the address after a quoted name with brackets', '"Support <noreply@example.net>" <me@example.com>', 'Boss <boss@example.com>', ''],
    ['To holds the address second in a list', 'Boss <boss@example.com>, Me <me@example.com>', 'Boss <boss@example.com>', ''],
    ['From is the user under a plus-alias', 'list@example.net', 'Me <me+news@example.com>', ''],
  ])('%s → "%s"', async (_label, rawTo, rawFrom, expected) => {
    expect(await computeRecipientStatus(makeHeader(rawTo, 'Me <me@example.com>', rawFrom))).toBe(expected);
  });

  it('reads each address whole (an apostrophe in the local part)', async () => {
    browser.accounts.get = vi.fn(async () => ({ type: 'imap', identities: [{ email: 'brien@example.com' }] }));
    expect(await computeRecipientStatus(makeHeader('other@example.com', "o'brien@example.com"))).toBe('');
    expect(await computeRecipientStatus(makeHeader("o'brien@example.com", 'brien@example.com'))).toBe('cc');
    browser.accounts.get = vi.fn(async () => ({ type: 'imap', identities: [{ email: "o'brien@example.com" }] }));
    expect(await computeRecipientStatus(makeHeader('other@example.com', "O'Brien <o'brien@example.com>"))).toBe('cc');
  });

  it('asks Thunderbird once per message, and not at all without an account address', async () => {
    const spy = vi.spyOn(browser.tmHdr, 'getAddressFields');
    try {
      const header = makeHeader('a@example.net, b@example.net', 'c@example.net, d@example.net, Me <me@example.com>');
      expect(await computeRecipientStatus(header)).toBe('cc');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith([header.id]);
      spy.mockClear();
      browser.accounts.get = vi.fn(async () => ({ type: 'imap', identities: [] }));
      expect(await computeRecipientStatus(makeHeader('a@example.net', 'me@example.com'))).toBe('');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('reads a long Cc list whole', async () => {
    const rawCc = Array.from({ length: 2000 }, (_, i) => `U${i} <u${i}@example.net>`).join(', ') + ', Me <me@example.com>';
    expect(await computeRecipientStatus(makeHeader('other@example.com', rawCc))).toBe('cc');
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
    const result = await isInternalSender(fromHeader('someone@example.com'));
    expect(result).toBe(false);
  });

  it('returns false for null message header', async () => {
    const result = await isInternalSender(null);
    expect(result).toBe(false);
  });

  it('returns false when author has no email', async () => {
    browser.accounts.list.mockResolvedValue([{ type: 'imap', identities: [{ email: 'me@example.com' }] }]);
    invalidateUserEmailCache();
    expect(await isInternalSender(fromHeader('just a name'))).toBe(false);
  });

  it('returns false for a gone message', async () => {
    browser.accounts.list.mockResolvedValue([{ type: 'imap', identities: [{ email: 'me@example.com' }] }]);
    invalidateUserEmailCache();
    expect(await isInternalSender({ id: 999999, author: 'me@example.com' })).toBe(false);
  });

  // The sender is the first mailbox of Thunderbird's parse of the raw From header; only its own
  // address counts, never an address in its display name or a comment.
  it.each([
    ['"Me <me@example.com>" <other@example.net>', false],
    ['=?UTF-8?Q?me@example.com?= <other@example.net>', false],
    ['other@example.net (me@example.com)', false],
    ['"\\"x\\" <me@example.com> \\"" <other@example.net>', false],
    ['=?UTF-8?Q?=22x=22_<me@example.com>,_=22y=22?= <other@example.net>', false],
    ['"Other <other@example.net>" <me@example.com>', true],
    ['Me <ME@Example.com>', true],
  ])('From: %s → %s', async (rawFrom, expected) => {
    browser.accounts.list.mockResolvedValue([{ type: 'imap', identities: [{ email: 'me@example.com' }] }]);
    invalidateUserEmailCache();
    expect(await isInternalSender(fromHeader(rawFrom))).toBe(expected);
  });

  afterAll(async () => {
    browser.accounts.list.mockResolvedValue([]);
    invalidateUserEmailCache();
  });
});
