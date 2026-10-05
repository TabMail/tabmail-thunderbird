/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// buildInboxContext takes each email's attachment flag from the FTS index when its account's rows
// were repaired, and otherwise from Thunderbird's message database (tmHdr.getHasAttachmentBulk by
// WebExtension id); MessageHeader has no attachment field. A flag it cannot read is null
// ("unknown"), never false. The background owns the native helper, so it reads the index directly;
// any other page (the chat window) asks the background over the {type: "fts"} runtime channel.

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
  getUniqueMessageKey: vi.fn(async (m) => `${m.folder.accountId}:/INBOX:${m.headerMessageId}`),
}));

const { ftsSearch, isFtsEngineInitialized } = vi.hoisted(() => ({
  ftsSearch: { getAttachmentFlags: vi.fn() },
  isFtsEngineInitialized: vi.fn(),
}));
vi.mock('../fts/engine.js', () => ({ ftsSearch, isFtsEngineInitialized }));

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
let storage = {};

beforeEach(() => {
  vi.clearAllMocks();
  getActionForWeId.mockImplementation(async () => '');
  getRepliedBulk.mockImplementation(async (items) => items.map(() => false));
  getHasReBulk.mockImplementation(async (items) => items.map(() => false));
  messages = [message(1, 1), message(2, 2), message(3, 3)];
  storage = {};
  ftsSearch.getAttachmentFlags.mockImplementation(async (ids) => ({ ok: true, flags: ids.map(() => null) }));
  isFtsEngineInitialized.mockReturnValue(true);
  globalThis.browser = {
    runtime: { sendMessage: vi.fn() },
    storage: { local: { get: vi.fn(async (k) => (k in storage ? { [k]: storage[k] } : {})) } },
    accounts: { list: vi.fn(async () => [{ id: 'account1', name: 'A', rootFolder: { id: 'account1://' } }]) },
    folders: { getSubFolders: vi.fn(async () => [INBOX]) },
    messages: { list: vi.fn(async () => ({ messages })), continueList: vi.fn() },
    tmHdr: { getHasAttachmentBulk, getRepliedBulk, getHasReBulk },
  };
});

const flags = async () => JSON.parse(await buildInboxContext()).map((e) => [e.internalId, e.hasAttachments]);

describe('buildInboxContext attachment flags', () => {
  it('reads each email\'s flag by its WebExtension id', async () => {
    getHasAttachmentBulk.mockResolvedValue([false, true, null]);
    expect(await flags()).toEqual([[1, false], [2, true], [3, null]]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('reads the replied and "Re:" flags by WebExtension id too', async () => {
    getHasAttachmentBulk.mockResolvedValue([false, false, false]);
    await buildInboxContext();
    expect(getRepliedBulk).toHaveBeenCalledWith([1, 2, 3]);
    expect(getHasReBulk).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('keeps each flag on its own email when an earlier email\'s entry fails', async () => {
    getActionForWeId.mockImplementation(async (m) => {
      if (m.id === 1) throw new Error('cache read failed');
      return '';
    });
    const hasAttachment = { 1: true, 2: false, 3: true };
    getHasAttachmentBulk.mockImplementation(async (ids) => ids.map((id) => hasAttachment[id]));
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

  it('reports unknown, not no, and logs an error when the flags cannot be read', async () => {
    getHasAttachmentBulk.mockRejectedValue(new Error('boom'));
    expect(await flags()).toEqual([[1, null], [2, null], [3, null]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('getHasAttachmentBulk failed'), 'error');
  });
});

describe('buildInboxContext attachment flags from the index', () => {
  const key = (n) => `account1:/INBOX:m${n}@example.com`;
  beforeEach(() => { storage.fts_attachment_repaired_accounts = ['account1']; });

  it('uses the index\'s flag for a repaired account, and Thunderbird\'s only for an email not indexed', async () => {
    ftsSearch.getAttachmentFlags.mockResolvedValue({ ok: true, flags: [true, false, null] });
    getHasAttachmentBulk.mockResolvedValue([true]);
    expect(await flags()).toEqual([[1, true], [2, false], [3, true]]);
    expect(ftsSearch.getAttachmentFlags).toHaveBeenCalledWith([key(1), key(2), key(3)]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([3]);
  });

  it('trusts the index over Thunderbird\'s paperclip guess, and asks Thunderbird nothing when every email is indexed', async () => {
    ftsSearch.getAttachmentFlags.mockResolvedValue({ ok: true, flags: [true, false, true] });
    getHasAttachmentBulk.mockResolvedValue([false, true, false]);
    expect(await flags()).toEqual([[1, true], [2, false], [3, true]]);
    expect(getHasAttachmentBulk).not.toHaveBeenCalled();
  });

  it('does not read the index for an account whose rows were not repaired', async () => {
    storage.fts_attachment_repaired_accounts = ['account2'];
    getHasAttachmentBulk.mockResolvedValue([false, true, null]);
    expect(await flags()).toEqual([[1, false], [2, true], [3, null]]);
    expect(ftsSearch.getAttachmentFlags).not.toHaveBeenCalled();
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('asks Thunderbird for every email when the index read fails, as with a helper too old to answer', async () => {
    ftsSearch.getAttachmentFlags.mockRejectedValue(new Error('Unknown method: getAttachmentFlags'));
    getHasAttachmentBulk.mockResolvedValue([true, false, true]);
    expect(await flags()).toEqual([[1, true], [2, false], [3, true]]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([1, 2, 3]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('index attachment flags failed'), 'warn');
  });

  it('asks Thunderbird for every email when the repaired accounts cannot be read', async () => {
    browser.storage.local.get.mockRejectedValue(new Error('storage down'));
    getHasAttachmentBulk.mockResolvedValue([true, false, false]);
    expect(await flags()).toEqual([[1, true], [2, false], [3, false]]);
    expect(ftsSearch.getAttachmentFlags).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reading the repaired accounts failed'), 'error');
  });

  it('keeps each index flag on its own email when an earlier email\'s entry fails', async () => {
    getActionForWeId.mockImplementation(async (m) => {
      if (m.id === 1) throw new Error('cache read failed');
      return '';
    });
    ftsSearch.getAttachmentFlags.mockResolvedValue({ ok: true, flags: [false, true] });
    expect(await flags()).toEqual([[2, false], [3, true]]);
    expect(ftsSearch.getAttachmentFlags).toHaveBeenCalledWith([key(2), key(3)]);
  });

  it('reads the index only for the recorded account\'s emails and puts each flag on its own email', async () => {
    messages[1] = { ...messages[1], folder: { ...INBOX, accountId: 'account2' } };
    ftsSearch.getAttachmentFlags.mockResolvedValue({ ok: true, flags: [true, false] });
    getHasAttachmentBulk.mockResolvedValue([true]);
    expect(await flags()).toEqual([[1, true], [2, true], [3, false]]);
    expect(ftsSearch.getAttachmentFlags).toHaveBeenCalledWith([key(1), key(3)]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([2]);
  });

  it('keeps the index\'s flags when Thunderbird\'s read fails, and reports only the unanswered email unknown', async () => {
    ftsSearch.getAttachmentFlags.mockResolvedValue({ ok: true, flags: [true, null, false] });
    getHasAttachmentBulk.mockRejectedValue(new Error('boom'));
    expect(await flags()).toEqual([[1, true], [2, null], [3, false]]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([2]);
  });

  it('reports unknown, not no, for an email neither the index nor Thunderbird can answer', async () => {
    ftsSearch.getAttachmentFlags.mockResolvedValue({ ok: true, flags: [true, null, null] });
    getHasAttachmentBulk.mockResolvedValue([null, false]);
    expect(await flags()).toEqual([[1, true], [2, null], [3, false]]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([2, 3]);
  });
});

describe('buildInboxContext attachment flags from the index, outside the background', () => {
  const key = (n) => `account1:/INBOX:m${n}@example.com`;
  beforeEach(() => {
    storage.fts_attachment_repaired_accounts = ['account1'];
    isFtsEngineInitialized.mockReturnValue(false);
  });

  it('asks the background for the flags and never calls the helper itself', async () => {
    browser.runtime.sendMessage.mockResolvedValue({ ok: true, flags: [true, false, null] });
    getHasAttachmentBulk.mockResolvedValue([true]);
    expect(await flags()).toEqual([[1, true], [2, false], [3, true]]);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'fts', cmd: 'getAttachmentFlags', msgIds: [key(1), key(2), key(3)],
    });
    expect(ftsSearch.getAttachmentFlags).not.toHaveBeenCalled();
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([3]);
  });

  it.each([
    ['answers an error', { error: 'Unknown method: getAttachmentFlags' }],
    ['does not answer', undefined],
  ])('asks Thunderbird for every email when the background %s', async (_label, answer) => {
    browser.runtime.sendMessage.mockResolvedValue(answer);
    getHasAttachmentBulk.mockResolvedValue([true, false, true]);
    expect(await flags()).toEqual([[1, true], [2, false], [3, true]]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([1, 2, 3]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('index attachment flags failed'), 'warn');
  });

  it('asks Thunderbird for every email when the background cannot be reached', async () => {
    browser.runtime.sendMessage.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
    getHasAttachmentBulk.mockResolvedValue([false, true, false]);
    expect(await flags()).toEqual([[1, false], [2, true], [3, false]]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([1, 2, 3]);
  });
});
