/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// buildInboxContext takes each email's attachment flag from Thunderbird's message database
// (tmHdr.getHasAttachmentBulk by Message-ID); MessageHeader has no attachment field.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../chat/modules/helpers.js', () => ({ formatTimestampForAgent: vi.fn(() => 'ts') }));
vi.mock('../agent/modules/actionCache.js', () => ({
  ACTIONS: { DELETE: 'delete', ARCHIVE: 'archive', REPLY: 'reply' },
  getActionForWeId: vi.fn(async () => ''),
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { inboxManagement: { maxRecentEmails: 100 } } }));
vi.mock('../agent/modules/folderUtils.js', () => ({ isInboxFolder: (f) => f.path === '/INBOX' }));
vi.mock('../agent/modules/summaryGenerator.js', () => ({ getSummary: vi.fn(async () => null) }));
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getUniqueMessageKey: vi.fn(async (m) => `account1:/INBOX:${m.headerMessageId}`),
}));

const { getActionForWeId } = await import('../agent/modules/actionCache.js');
const { log } = await import('../agent/modules/utils.js');
const { buildInboxContext } = await import('../agent/modules/inboxContext.js');

const INBOX = { id: 'account1://INBOX', accountId: 'account1', path: '/INBOX' };
const now = Date.now();
// The shape Thunderbird 157's messages.list returns: there is no hasAttachments property.
const message = (id, minutesAgo) => ({
  id,
  date: new Date(now - minutesAgo * 60000),
  author: 'Sender <sender@example.com>',
  subject: `Subject ${id}`,
  headerMessageId: `m${id}@example.com`,
  folder: INBOX,
});

const getHasAttachmentBulk = vi.fn();
const getRepliedBulk = vi.fn();
const getHasReBulk = vi.fn();
let messages = [];

beforeEach(() => {
  vi.clearAllMocks();
  getActionForWeId.mockImplementation(async () => '');
  getRepliedBulk.mockImplementation(async (items) => items.map(() => false));
  getHasReBulk.mockImplementation(async (items) => items.map(() => false));
  messages = [message(1, 1), message(2, 2), message(3, 3)];
  globalThis.browser = {
    accounts: { list: vi.fn(async () => [{ id: 'account1', name: 'A', rootFolder: { id: 'account1://' } }]) },
    folders: { getSubFolders: vi.fn(async () => [INBOX]) },
    messages: { list: vi.fn(async () => ({ messages })), continueList: vi.fn() },
    tmHdr: { getHasAttachmentBulk, getRepliedBulk, getHasReBulk },
  };
});

const flags = async () => JSON.parse(await buildInboxContext()).map((e) => [e.internalId, e.hasAttachments]);

describe('buildInboxContext attachment flags', () => {
  it('reads each email\'s flag by Message-ID in its folder', async () => {
    getHasAttachmentBulk.mockResolvedValue([false, true, false]);
    expect(await flags()).toEqual([[1, false], [2, true], [3, false]]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([
      { folderURI: 'account1://INBOX', pathStr: '/INBOX', messageId: 'm1@example.com' },
      { folderURI: 'account1://INBOX', pathStr: '/INBOX', messageId: 'm2@example.com' },
      { folderURI: 'account1://INBOX', pathStr: '/INBOX', messageId: 'm3@example.com' },
    ]);
  });

  it('keeps each flag on its own email when an earlier email\'s entry fails', async () => {
    getActionForWeId.mockImplementation(async (m) => {
      if (m.id === 1) throw new Error('cache read failed');
      return '';
    });
    getHasAttachmentBulk.mockResolvedValue([true, false, true]);
    getRepliedBulk.mockResolvedValue([false, true, false]);
    const ctx = JSON.parse(await buildInboxContext());
    expect(ctx.map((e) => [e.internalId, e.hasAttachments, e.replied])).toEqual([
      [2, false, true],
      [3, true, false],
    ]);
  });

  it('restores the "Re:" prefix on the email whose HasRe flag is set when an earlier entry fails', async () => {
    getActionForWeId.mockImplementation(async (m) => {
      if (m.id === 1) throw new Error('cache read failed');
      return '';
    });
    getHasAttachmentBulk.mockResolvedValue([false, false, false]);
    getHasReBulk.mockResolvedValue([false, false, true]);
    const ctx = JSON.parse(await buildInboxContext());
    expect(ctx.map((e) => [e.internalId, e.subject])).toEqual([
      [2, 'Subject 2'],
      [3, 'Re: Subject 3'],
    ]);
  });

  it('reports no attachments and logs an error when the flags cannot be read', async () => {
    getHasAttachmentBulk.mockRejectedValue(new Error('boom'));
    expect(await flags()).toEqual([[1, false], [2, false], [3, false]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('getHasAttachmentBulk failed'), 'error');
  });
});
