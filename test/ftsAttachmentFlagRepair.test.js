/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The index's hasAttachments column holds Thunderbird's attachment flag: new rows get it from
// the message database, and a full smart reindex re-adds rows written before the indexer read
// it. Only after a full run with no repair failure is the column marked trustworthy.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/config.js', () => ({ SETTINGS: {} }));
vi.mock('../agent/modules/utils.js', () => ({
  getRealSubject: vi.fn(async (m) => m.subject || ''),
  getUniqueMessageKey: vi.fn(async (m) => `${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}`),
  log: vi.fn(),
  safeGetFull: vi.fn(async (_id, m) => ({ __tmSynthetic: true, body: `fetched body of ${m.headerMessageId}` })),
}));
vi.mock('../agent/modules/folderUtils.js', () => ({ getAllFoldersForAccount: vi.fn() }));
vi.mock('../agent/modules/inboxContext.js', () => ({ getInboxForAccount: vi.fn(async () => null) }));
vi.mock('../agent/modules/onMoved.js', () => ({ sanitizeMessageTags: vi.fn(async () => ({ stripped: false })) }));
vi.mock('../chat/modules/icsParser.js', () => ({ extractIcsFromParts: vi.fn(async () => []), formatIcsAttachmentsAsString: vi.fn(() => '') }));
vi.mock('../fts/bodyExtract.js', () => ({ extractPlainText: vi.fn(async () => '') }));

const { getAllFoldersForAccount } = await import('../agent/modules/folderUtils.js');
const { buildBatchHeader, indexMessages } = await import('../fts/indexer.js');
const coordinator = await import('../fts/operationCoordinator.js');

const INBOX = { id: 'account1://INBOX', accountId: 'account1', path: '/INBOX', name: 'INBOX' };
const FOLDER_ID = 'tm-folder:v1:["account1","/INBOX"]';
const REPAIRED_KEY = 'fts_attachment_flags_repaired';
const now = Date.now();

let storage;
let messages;
let tbAttachment;
let index;
let ftsSearch;

const message = (n) => ({
  id: n,
  headerMessageId: `m${n}@example.com`,
  subject: `Subject ${n}`,
  author: 'Sender <sender@example.com>',
  recipients: ['me@example.com'],
  ccList: [],
  date: new Date(now - n * 60000),
  folder: INBOX,
});
const key = (n) => `account1:/INBOX:m${n}@example.com`;
const storedRow = (n, hasAttachments) => ({
  msgId: key(n),
  subject: `Subject ${n}`,
  from_: 'Sender <sender@example.com>',
  to_: 'me@example.com',
  cc: '',
  bcc: '',
  body: `stored body ${n}`,
  dateMs: now - n * 60000,
  hasAttachments,
  parsedIcsAttachments: n === 1 ? 'stored ics 1' : '',
  folderId: FOLDER_ID,
});

// The native helper's contract: indexBatch skips a msgId that already exists.
function fakeIndex() {
  return {
    filterNewMessages: vi.fn(async (rows) => ({ newMsgIds: rows.map((r) => r.msgId).filter((id) => !index.has(id)) })),
    getMessageByMsgId: vi.fn(async (id) => {
      const row = index.get(id);
      return row ? { ...row, hasAttachments: row.hasAttachments ? 1 : 0 } : null;
    }),
    removeBatch: vi.fn(async (ids) => { for (const id of ids) index.delete(id); return { count: ids.length }; }),
    indexBatch: vi.fn(async (rows) => {
      let count = 0;
      for (const row of rows) {
        if (index.has(row.msgId)) continue;
        index.set(row.msgId, { ...row });
        count += 1;
      }
      return { count };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  coordinator._resetFtsOperationCoordinatorForTests();
  storage = { chat_ftsSleepBetweenBatchMs: 0, chat_ftsLongYieldMs: 0 };
  messages = [message(1), message(2), message(3)];
  // Thunderbird's database, by WebExtension id: 1 and 3 have attachments, 2 does not.
  tbAttachment = new Map([[1, true], [2, false], [3, true]]);
  // Indexed before the fix: every row says "no attachments", except 3, already correct.
  index = new Map([[key(1), storedRow(1, false)], [key(2), storedRow(2, false)], [key(3), storedRow(3, true)]]);
  ftsSearch = fakeIndex();
  getAllFoldersForAccount.mockImplementation(async () => [INBOX]);
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async (k) => {
          if (typeof k === 'string') return k in storage ? { [k]: storage[k] } : {};
          return Object.fromEntries(Object.entries(k).map(([name, dflt]) => [name, name in storage ? storage[name] : dflt]));
        }),
        set: vi.fn(async (obj) => { Object.assign(storage, obj); }),
      },
    },
    accounts: { list: vi.fn(async () => [{ id: 'account1', name: 'A', type: 'imap', rootFolder: { id: 'account1://' } }]) },
    folders: { getSubFolders: vi.fn(async () => []) },
    messages: { list: vi.fn(async () => ({ messages })), continueList: vi.fn() },
    tmHdr: { getHasAttachmentBulk: vi.fn(async (ids) => ids.map((id) => (tbAttachment.has(id) ? tbAttachment.get(id) : null))) },
  };
});

describe('buildBatchHeader attachment flag', () => {
  it('takes each row\'s flag from Thunderbird\'s database by WebExtension id', async () => {
    const rows = await buildBatchHeader(messages);
    expect(rows.map((r) => [r.msgId, r.hasAttachments])).toEqual([[key(1), true], [key(2), false], [key(3), true]]);
    expect(browser.tmHdr.getHasAttachmentBulk).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('does not index a message whose header is gone', async () => {
    tbAttachment.delete(2);
    const rows = await buildBatchHeader(messages);
    expect(rows.map((r) => [r.msgId, r.hasAttachments])).toEqual([[key(1), true], [key(3), true]]);
  });

  it('fails the batch rather than guess when the flags cannot be read', async () => {
    browser.tmHdr.getHasAttachmentBulk.mockResolvedValueOnce([]);
    await expect(buildBatchHeader(messages)).rejects.toThrow('attachment flags unavailable');
    browser.tmHdr.getHasAttachmentBulk.mockRejectedValueOnce(new Error('boom'));
    await expect(buildBatchHeader(messages)).rejects.toThrow('boom');
  });
});

describe('full smart reindex attachment flag repair', () => {
  it('re-adds each stale row from its stored copy with the flag set, and marks the index repaired', async () => {
    const result = await indexMessages(ftsSearch);
    expect(index.get(key(1))).toEqual({ ...storedRow(1, true), hasAttachments: true });
    expect(index.get(key(2))).toEqual(storedRow(2, false));
    expect(index.get(key(3))).toEqual(storedRow(3, true));
    // Only the stale row is rewritten; nothing is downloaded again.
    expect(ftsSearch.removeBatch).toHaveBeenCalledTimes(1);
    expect(ftsSearch.removeBatch).toHaveBeenCalledWith([key(1)], expect.anything());
    expect(ftsSearch.getMessageByMsgId.mock.calls.map(([id]) => id).sort()).toEqual([key(1), key(3)]);
    expect(result.attachmentRepair).toEqual({ repaired: 1, failedBatches: 0 });
    expect(storage[REPAIRED_KEY]).toBe(true);
  });

  it('indexes a new email with its attachment flag', async () => {
    index.clear();
    await indexMessages(ftsSearch);
    expect([...index.values()].map((r) => [r.msgId, r.hasAttachments])).toEqual([
      [key(3), true], [key(2), false], [key(1), true],
    ]);
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
    expect(storage[REPAIRED_KEY]).toBe(true);
  });

  it('does not look at existing rows once the index is marked repaired', async () => {
    storage[REPAIRED_KEY] = true;
    const result = await indexMessages(ftsSearch);
    expect(ftsSearch.getMessageByMsgId).not.toHaveBeenCalled();
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
    expect(index.get(key(1)).hasAttachments).toBe(false);
    expect(result.attachmentRepair).toBeUndefined();
  });

  it('neither repairs nor marks on a date-range run', async () => {
    const result = await indexMessages(ftsSearch, () => {}, new Date(now - 86400000), new Date(now + 60000));
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
    expect(index.get(key(1)).hasAttachments).toBe(false);
    expect(result.attachmentRepair).toBeUndefined();
    expect(storage[REPAIRED_KEY]).toBeUndefined();
  });

  it('leaves the index unmarked when a rewrite fails, and the next run repairs it', async () => {
    ftsSearch.indexBatch.mockImplementationOnce(async () => ({ count: 0 }));
    const first = await indexMessages(ftsSearch);
    expect(first.attachmentRepair).toEqual({ repaired: 0, failedBatches: 1 });
    expect(storage[REPAIRED_KEY]).toBeUndefined();

    // The failed rewrite removed the row; the next run indexes it again as new, flag set.
    await indexMessages(ftsSearch);
    expect(index.get(key(1)).hasAttachments).toBe(true);
    expect(storage[REPAIRED_KEY]).toBe(true);
  });

  it('does not rewrite when another membership change lands between the read and the rewrite', async () => {
    const read = ftsSearch.getMessageByMsgId.getMockImplementation();
    ftsSearch.getMessageByMsgId.mockImplementation(async (id) => {
      const row = await read(id);
      // A concurrent writer queues a mutation that runs as soon as the read releases the mutex.
      coordinator.runFtsMembershipMutation(async () => {});
      return row;
    });
    const result = await indexMessages(ftsSearch);
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
    expect(index.get(key(1))).toEqual(storedRow(1, false));
    expect(result.attachmentRepair).toEqual({ repaired: 0, failedBatches: 1 });
    expect(storage[REPAIRED_KEY]).toBeUndefined();
  });

  it('leaves the index unmarked when an account\'s folders cannot be listed', async () => {
    getAllFoldersForAccount.mockRejectedValueOnce(new Error('no folders'));
    const result = await indexMessages(ftsSearch);
    expect(result.attachmentRepair).toEqual({ repaired: 0, failedBatches: 1 });
    expect(storage[REPAIRED_KEY]).toBeUndefined();
  });

  it('aborts without writing or marking when the attachment flags cannot be read', async () => {
    browser.tmHdr.getHasAttachmentBulk.mockRejectedValue(new Error('boom'));
    await expect(indexMessages(ftsSearch)).rejects.toThrow('boom');
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
    expect(ftsSearch.indexBatch).not.toHaveBeenCalled();
    expect(storage[REPAIRED_KEY]).toBeUndefined();
  });
});
