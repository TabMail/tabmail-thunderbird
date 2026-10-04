/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// email_search takes each result's attachment flag from Thunderbird's message database
// (tmHdr.getHasAttachmentBulk by Message-ID), not from the index's never-set column.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// utils.js loads these at import; getUniqueMessageKeyCandidates itself is the real function.
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({ getAndClearThink: vi.fn(() => null) }));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

vi.mock('../agent/modules/utils.js', async () => {
  const actual = await vi.importActual('../agent/modules/utils.js');
  return { log: vi.fn(), getUniqueMessageKeyCandidates: actual.getUniqueMessageKeyCandidates };
});

vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: { searchPageSizeDefault: 2, searchPageSizeMax: 500 },
}));

vi.mock('../chat/modules/helpers.js', () => ({
  formatMailList: vi.fn(() => 'formatted'),
  toIsoNoMs: vi.fn((d) => d.toISOString()),
}));

const { log } = await import('../agent/modules/utils.js');
const { formatMailList } = await import('../chat/modules/helpers.js');
const { run } = await import('../chat/tools/email_search.js');

const now = Date.now();
const hit = (uniqueId, n, extra = {}) => ({
  uniqueId,
  dateMs: now - n * 60000,
  author: 'Sender <sender@example.com>',
  subject: `Subject ${n}`,
  ...extra,
});

const INBOX = { id: 'account1://INBOX', accountId: 'account1', path: '/INBOX' };
const WORK = { id: 'account1://Work:2026', accountId: 'account1', path: '/Work:2026' };

const getHasAttachmentBulk = vi.fn();
const foldersQuery = vi.fn();
let hits = [];
let query = 0;

beforeEach(() => {
  vi.clearAllMocks();
  foldersQuery.mockImplementation(async ({ accountId }) => (accountId === 'account1' ? [INBOX, WORK] : []));
  hits = [
    hit('account1:/INBOX:m1@example.com', 1),
    // The index's attachment column is never set; a value here must not leak through.
    hit('account1:/INBOX:m2@example.com', 2, { hasAttachments: 1 }),
    hit('account1:/INBOX:m3@example.com', 3),
  ];
  globalThis.browser = {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    runtime: { sendMessage: vi.fn(async () => hits) },
    folders: { query: foldersQuery },
    tmHdr: { getHasAttachmentBulk },
  };
  query += 1;
});

const listed = () => formatMailList.mock.calls.at(-1)[0].map((it) => [it.uniqueId, it.hasAttachments]);

describe('email_search attachment flags', () => {
  it('reads the flags for the current page by Message-ID in each hit\'s folder', async () => {
    getHasAttachmentBulk.mockResolvedValue([true, false]);
    await run({ query: `q${query}`, sort: 'date_desc' });
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([
      { folderURI: 'account1://INBOX', pathStr: '/INBOX', messageId: 'm1@example.com' },
      { folderURI: 'account1://INBOX', pathStr: '/INBOX', messageId: 'm2@example.com' },
    ]);
    expect(listed()).toEqual([
      ['account1:/INBOX:m1@example.com', true],
      ['account1:/INBOX:m2@example.com', false],
    ]);
    expect(foldersQuery).toHaveBeenCalledTimes(1);
  });

  it('reads the flags of the requested page only', async () => {
    getHasAttachmentBulk.mockResolvedValue([true]);
    await run({ query: `q${query}`, sort: 'date_desc', page_index: 2 });
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([
      { folderURI: 'account1://INBOX', pathStr: '/INBOX', messageId: 'm3@example.com' },
    ]);
    expect(listed()).toEqual([['account1:/INBOX:m3@example.com', true]]);
  });

  it('finds the folder and Message-ID when either contains a colon', async () => {
    hits = [
      hit('account1:/Work:2026:m4@example.com', 1),
      hit('account1:/INBOX:part:m5@example.com', 2),
    ];
    getHasAttachmentBulk.mockResolvedValue([false, true]);
    await run({ query: `q${query}`, sort: 'date_desc' });
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([
      { folderURI: 'account1://Work:2026', pathStr: '/Work:2026', messageId: 'm4@example.com' },
      { folderURI: 'account1://INBOX', pathStr: '/INBOX', messageId: 'part:m5@example.com' },
    ]);
    expect(listed()).toEqual([
      ['account1:/Work:2026:m4@example.com', false],
      ['account1:/INBOX:part:m5@example.com', true],
    ]);
  });

  it('reports no attachment for a hit whose folder no longer exists', async () => {
    hits = [hit('account1:/Gone:m6@example.com', 1), hit('account1:/INBOX:m7@example.com', 2)];
    getHasAttachmentBulk.mockResolvedValue([true]);
    await run({ query: `q${query}`, sort: 'date_desc' });
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([
      { folderURI: 'account1://INBOX', pathStr: '/INBOX', messageId: 'm7@example.com' },
    ]);
    expect(listed()).toEqual([
      ['account1:/Gone:m6@example.com', false],
      ['account1:/INBOX:m7@example.com', true],
    ]);
  });

  it('reports no attachment for a hit without a unique id', async () => {
    hits = [hit(undefined, 1), hit('account1:/INBOX:m8@example.com', 2)];
    getHasAttachmentBulk.mockResolvedValue([true]);
    await run({ query: `q${query}`, sort: 'date_desc' });
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([
      { folderURI: 'account1://INBOX', pathStr: '/INBOX', messageId: 'm8@example.com' },
    ]);
    expect(listed()).toEqual([
      ['', false],
      ['account1:/INBOX:m8@example.com', true],
    ]);
  });

  it('logs an error and still returns the results when the flags cannot be read', async () => {
    getHasAttachmentBulk.mockRejectedValue(new Error('boom'));
    const result = await run({ query: `q${query}`, sort: 'date_desc' });
    expect(result.results).toBe('formatted');
    expect(listed().map(([, flag]) => flag)).toEqual([false, false]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reading attachment flags failed'), 'error');
  });
});
