/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The index's hasAttachments column: a new row gets the attachment status of the downloaded
// message (Thunderbird's database flag when the download cannot tell), and a full smart reindex
// re-adds rows written before the fix, account by account. An account is recorded as repaired
// only after a full run listed all its folders with no repair failure; folder listing runs
// through the real folderUtils traversal.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/config.js', () => ({ SETTINGS: {} }));
vi.mock('../agent/modules/utils.js', () => ({
  getRealSubject: vi.fn(async (m) => m.subject || ''),
  getUniqueMessageKey: vi.fn(async (m) => `${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}`),
  log: vi.fn(),
  safeGetFull: vi.fn(),
}));
vi.mock('../agent/modules/inboxContext.js', () => ({ getInboxForAccount: vi.fn(async () => null) }));
vi.mock('../agent/modules/onMoved.js', () => ({ sanitizeMessageTags: vi.fn(async () => ({ stripped: false })) }));
vi.mock('../chat/modules/icsParser.js', () => ({ extractIcsFromParts: vi.fn(async () => []), formatIcsAttachmentsAsString: vi.fn(() => '') }));
vi.mock('../fts/bodyExtract.js', () => ({ extractPlainText: vi.fn(async () => 'extracted body') }));
// The real engine ftsSearch wrappers over a fake native layer (the same fake index).
const native = vi.hoisted(() => ({ impl: null }));
vi.mock('../fts/nativeEngine.js', () => ({
  initNativeFts: vi.fn(),
  nativeMemorySearch: {},
  nativeFtsSearch: new Proxy({}, { get: (_t, name) => (...args) => native.impl[name](...args) }),
}));

const { safeGetFull } = await import('../agent/modules/utils.js');
const { buildBatchHeader, indexMessages } = await import('../fts/indexer.js');
const coordinator = await import('../fts/operationCoordinator.js');
const engine = await import('../fts/engine.js');

const REPAIRED_KEY = 'fts_attachment_repaired_accounts';
const now = Date.now();
const ROOT1 = { id: 'account1://', accountId: 'account1', path: '/', name: 'Root' };
const INBOX1 = { id: 'account1://INBOX', accountId: 'account1', path: '/INBOX', name: 'INBOX' };
const ROOT2 = { id: 'account2://', accountId: 'account2', path: '/', name: 'Root' };
const INBOX2 = { id: 'account2://INBOX', accountId: 'account2', path: '/INBOX', name: 'INBOX' };
const ACCOUNT1 = { id: 'account1', name: 'A', type: 'imap', rootFolder: ROOT1 };
const ACCOUNT2 = { id: 'account2', name: 'B', type: 'imap', rootFolder: ROOT2 };
const folderIdOf = (f) => `tm-folder:v1:["${f.accountId}","${f.path}"]`;
// getFull trees: a message that IS the PDF, a multipart/mixed with only text, a vCard only.
const PDF_ONLY = { contentType: 'message/rfc822', parts: [{ contentType: 'application/pdf', name: 'scan.pdf', size: 9 }] };
const MIXED_NO_FILE = { contentType: 'message/rfc822', parts: [{ contentType: 'multipart/mixed', parts: [{ contentType: 'text/plain', body: 'hi' }] }] };
const VCARD_ONLY = { contentType: 'message/rfc822', parts: [{ contentType: 'multipart/mixed', parts: [{ contentType: 'text/plain', body: 'hi' }, { contentType: 'text/vcard', name: 'me.vcf', size: 3 }] }] };

let storage;
let accounts;
let subFolders;
let folderMessages;
let tbAttachment;
let index;
let ftsSearch;

const message = (n, folder = INBOX1) => ({
  id: n,
  headerMessageId: `m${n}@example.com`,
  subject: `Subject ${n}`,
  author: 'Sender <sender@example.com>',
  recipients: ['me@example.com'],
  ccList: [],
  date: new Date(now - n * 60000),
  folder,
});
const key = (n, folder = INBOX1) => `${folder.accountId}:${folder.path}:m${n}@example.com`;
const storedRow = (n, hasAttachments, folder = INBOX1) => ({
  msgId: key(n, folder),
  subject: `Subject ${n}`,
  from_: 'Sender <sender@example.com>',
  to_: 'me@example.com',
  cc: '',
  bcc: '',
  body: `stored body ${n}`,
  dateMs: now - n * 60000,
  hasAttachments,
  parsedIcsAttachments: n === 1 ? 'stored ics 1' : '',
  folderId: folderIdOf(folder),
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
  accounts = [ACCOUNT1];
  subFolders = new Map([[ROOT1.id, [INBOX1]], [INBOX1.id, []], [ROOT2.id, [INBOX2]], [INBOX2.id, []]]);
  folderMessages = new Map([[INBOX1.id, [message(1), message(2), message(3)]], [INBOX2.id, [message(4, INBOX2)]]]);
  // Thunderbird's database, by WebExtension id: 1, 3 and 4 have attachments, 2 does not.
  tbAttachment = new Map([[1, true], [2, false], [3, true], [4, true]]);
  // Indexed before the fix: every row says "no attachments", except 3, already correct.
  index = new Map([
    [key(1), storedRow(1, false)], [key(2), storedRow(2, false)], [key(3), storedRow(3, true)],
    [key(4, INBOX2), storedRow(4, false, INBOX2)],
  ]);
  ftsSearch = fakeIndex();
  safeGetFull.mockImplementation(async (_id, m) => ({ __tmSynthetic: true, body: `fetched body of ${m.headerMessageId}` }));
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async (k) => {
          if (typeof k === 'string') return k in storage ? { [k]: storage[k] } : {};
          return Object.fromEntries(Object.entries(k).map(([name, dflt]) => [name, name in storage ? storage[name] : dflt]));
        }),
        set: vi.fn(async (obj) => { Object.assign(storage, structuredClone(obj)); }),
      },
    },
    accounts: { list: vi.fn(async () => accounts) },
    folders: {
      getSubFolders: vi.fn(async (id) => {
        const children = subFolders.get(id);
        if (children instanceof Error) throw children;
        return children || [];
      }),
    },
    messages: { list: vi.fn(async (folderId) => ({ messages: folderMessages.get(folderId) || [] })), continueList: vi.fn() },
    tmHdr: { getHasAttachmentBulk: vi.fn(async (ids) => ids.map((id) => (tbAttachment.has(id) ? tbAttachment.get(id) : null))) },
  };
});

describe('buildBatchHeader attachment flag', () => {
  it('takes each row\'s flag from Thunderbird\'s database by WebExtension id', async () => {
    const rows = await buildBatchHeader(folderMessages.get(INBOX1.id));
    expect(rows.map((r) => [r.msgId, r.hasAttachments])).toEqual([[key(1), true], [key(2), false], [key(3), true]]);
    expect(browser.tmHdr.getHasAttachmentBulk).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('does not index a message whose header is gone', async () => {
    tbAttachment.delete(2);
    const rows = await buildBatchHeader(folderMessages.get(INBOX1.id));
    expect(rows.map((r) => [r.msgId, r.hasAttachments])).toEqual([[key(1), true], [key(3), true]]);
  });

  it('fails the batch rather than guess when the flags cannot be read', async () => {
    const msgs = folderMessages.get(INBOX1.id);
    browser.tmHdr.getHasAttachmentBulk.mockResolvedValueOnce([]);
    await expect(buildBatchHeader(msgs)).rejects.toThrow('attachment flags unavailable');
    browser.tmHdr.getHasAttachmentBulk.mockRejectedValueOnce(new Error('boom'));
    await expect(buildBatchHeader(msgs)).rejects.toThrow('boom');
  });
});

describe('new rows take the attachment status of the downloaded message', () => {
  beforeEach(() => { index.clear(); });

  it('uses the MIME tree over Thunderbird\'s flag, and counts no vCard as an attachment', async () => {
    tbAttachment.set(1, false); // a PDF-only email has no paperclip until opened
    const trees = new Map([[1, PDF_ONLY], [2, VCARD_ONLY], [3, MIXED_NO_FILE]]);
    safeGetFull.mockImplementation(async (id) => trees.get(id));
    await indexMessages(ftsSearch);
    expect(index.get(key(1)).hasAttachments).toBe(true);
    expect(index.get(key(2)).hasAttachments).toBe(false);
    expect(index.get(key(3)).hasAttachments).toBe(false);
  });

  it('keeps the calendar invites the index stored when the body came from the index', async () => {
    safeGetFull.mockImplementation(async (id) => ({
      __tmSynthetic: true, body: 'b', parts: [], ...(id === 1 ? { parsedIcsAttachments: 'ics from the index' } : {}),
    }));
    await indexMessages(ftsSearch);
    expect(index.get(key(1)).parsedIcsAttachments).toBe('ics from the index');
    expect(index.get(key(2)).parsedIcsAttachments).toBe('');
  });

  it.each([
    ['the body came from the index', () => ({ __tmSynthetic: true, body: 'b', parts: [] }), {}],
    ['the message is headers-only', () => ({ contentType: 'message/rfc822', parts: [{ contentType: 'multipart/mixed' }] }), { headersOnly: true }],
    ['Thunderbird could not decrypt it', () => ({ contentType: 'message/rfc822', decryptionStatus: 'fail', parts: [] }), {}],
  ])('keeps Thunderbird\'s flag when %s', async (_name, tree, headerExtra) => {
    folderMessages.set(INBOX1.id, [{ ...message(1), ...headerExtra }, { ...message(2), ...headerExtra }]);
    safeGetFull.mockImplementation(async () => tree());
    await indexMessages(ftsSearch);
    expect(index.get(key(1)).hasAttachments).toBe(true);
    expect(index.get(key(2)).hasAttachments).toBe(false);
  });
});

describe('full smart reindex attachment flag repair', () => {
  it('re-adds each stale row from its stored copy with the flag set, and records the account', async () => {
    const result = await indexMessages(ftsSearch);
    expect(index.get(key(1))).toEqual({ ...storedRow(1, true), hasAttachments: true });
    expect(index.get(key(2))).toEqual(storedRow(2, false));
    expect(index.get(key(3))).toEqual(storedRow(3, true));
    // Only the stale row is rewritten; nothing is downloaded again.
    expect(ftsSearch.removeBatch).toHaveBeenCalledTimes(1);
    expect(ftsSearch.removeBatch).toHaveBeenCalledWith([key(1)], expect.anything());
    expect(safeGetFull).not.toHaveBeenCalled();
    expect(ftsSearch.getMessageByMsgId.mock.calls.map(([id]) => id).sort()).toEqual([key(1), key(3)]);
    expect(result.attachmentRepair).toEqual({ repaired: 1, failedBatches: 0, accountsRepaired: ['account1'] });
    expect(storage[REPAIRED_KEY]).toEqual(['account1']);
  });

  it('still re-adds the rows when the remove call times out but the helper runs it later', async () => {
    // The helper's writer was busy (converting a shard): the call times out, the remove runs anyway.
    ftsSearch.removeBatch.mockImplementationOnce(async (ids) => {
      for (const id of ids) index.delete(id);
      throw new Error("Native RPC 'removeBatch' timed out after 60000ms");
    });
    const result = await indexMessages(ftsSearch);
    expect(index.get(key(1))).toEqual({ ...storedRow(1, true), hasAttachments: true });
    expect(result.attachmentRepair.failedBatches).toBe(1);
    expect(storage[REPAIRED_KEY]).toBeUndefined();
  });

  it('leaves the row as it was when the remove fails and never runs', async () => {
    ftsSearch.removeBatch.mockImplementationOnce(async () => { throw new Error('Native FTS helper not connected'); });
    const result = await indexMessages(ftsSearch);
    expect(index.get(key(1))).toEqual(storedRow(1, false));
    expect(result.attachmentRepair.failedBatches).toBe(1);
  });

  it('keeps the stored file names of a re-added row', async () => {
    index.set(key(1), { ...storedRow(1, false), attachmentNames: 'scan-1.pdf' });
    await indexMessages(ftsSearch);
    expect(index.get(key(1))).toEqual({ ...storedRow(1, true), attachmentNames: 'scan-1.pdf' });
  });

  it('does not look at existing rows of a recorded account, and still repairs the others', async () => {
    accounts = [ACCOUNT1, ACCOUNT2];
    storage[REPAIRED_KEY] = ['account1'];
    const result = await indexMessages(ftsSearch);
    expect(ftsSearch.getMessageByMsgId.mock.calls.map(([id]) => id)).toEqual([key(4, INBOX2)]);
    expect(index.get(key(1)).hasAttachments).toBe(false);
    expect(index.get(key(4, INBOX2)).hasAttachments).toBe(true);
    expect(result.attachmentRepair.accountsRepaired).toEqual(['account2']);
    expect(storage[REPAIRED_KEY]).toEqual(['account1', 'account2']);
  });

  it('records an account Thunderbird had not loaded only on a later run that lists it', async () => {
    // Cold start: account2 is missing from accounts.list() (memory 033).
    await indexMessages(ftsSearch);
    expect(storage[REPAIRED_KEY]).toEqual(['account1']);
    expect(index.get(key(4, INBOX2)).hasAttachments).toBe(false);

    accounts = [ACCOUNT1, ACCOUNT2];
    await indexMessages(ftsSearch);
    expect(index.get(key(4, INBOX2)).hasAttachments).toBe(true);
    expect(storage[REPAIRED_KEY]).toEqual(['account1', 'account2']);
  });

  it('repairs what it reached but does not record an account with a folder it could not list', async () => {
    accounts = [ACCOUNT1, ACCOUNT2];
    subFolders.set(INBOX1.id, new Error('subfolders unavailable'));
    const result = await indexMessages(ftsSearch);
    expect(index.get(key(1)).hasAttachments).toBe(true);
    expect(result.attachmentRepair.accountsRepaired).toEqual(['account2']);
    expect(storage[REPAIRED_KEY]).toEqual(['account2']);
  });

  it('does not record an account whose root folder cannot be listed', async () => {
    subFolders.set(ROOT1.id, new Error('root unavailable'));
    const result = await indexMessages(ftsSearch);
    expect(result.attachmentRepair.accountsRepaired).toEqual([]);
    expect(storage[REPAIRED_KEY]).toBeUndefined();
  });

  it.each([
    ['is gone by the time its folders are listed', () => []],
    ['cannot be looked up when its folders are listed', () => { throw new Error('accounts unavailable'); }],
  ])('does not record an account that %s', async (_name, third) => {
    // Calls: the pre-scan, the folder walk, then getAllFoldersForAccount's own lookup.
    browser.accounts.list.mockResolvedValueOnce([ACCOUNT1]).mockResolvedValueOnce([ACCOUNT1]).mockImplementation(async () => third());
    const result = await indexMessages(ftsSearch);
    expect(result.attachmentRepair.accountsRepaired).toEqual([]);
    expect(storage[REPAIRED_KEY]).toBeUndefined();
  });

  it('neither repairs nor records on a date-range run', async () => {
    const result = await indexMessages(ftsSearch, () => {}, new Date(now - 86400000), new Date(now + 60000));
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
    expect(index.get(key(1)).hasAttachments).toBe(false);
    expect(result.attachmentRepair).toBeUndefined();
    expect(storage[REPAIRED_KEY]).toBeUndefined();
  });

  it('does not record the account when a rewrite fails, and the next run repairs it', async () => {
    ftsSearch.indexBatch.mockImplementationOnce(async () => ({ count: 0 }));
    const first = await indexMessages(ftsSearch);
    expect(first.attachmentRepair).toEqual({ repaired: 0, failedBatches: 1, accountsRepaired: [] });
    expect(storage[REPAIRED_KEY]).toBeUndefined();

    // The failed rewrite removed the row; the next run indexes it again as new, flag set.
    await indexMessages(ftsSearch);
    expect(index.get(key(1)).hasAttachments).toBe(true);
    expect(storage[REPAIRED_KEY]).toEqual(['account1']);
  });

  it('does not rewrite when another membership change completes between the reads and the rewrite', async () => {
    const read = ftsSearch.getMessageByMsgId.getMockImplementation();
    ftsSearch.getMessageByMsgId.mockImplementation(async (id) => {
      const row = await read(id);
      await coordinator.runFtsMembershipMutation(async () => {});
      return row;
    });
    const result = await indexMessages(ftsSearch);
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
    expect(index.get(key(1))).toEqual(storedRow(1, false));
    expect(result.attachmentRepair).toEqual({ repaired: 0, failedBatches: 1, accountsRepaired: [] });
    expect(storage[REPAIRED_KEY]).toBeUndefined();
  });

  it('counts its rewrite as a membership change, so a proof taken before it is rejected', async () => {
    const before = coordinator.getFtsMembershipEpoch();
    await indexMessages(ftsSearch);
    await expect(coordinator.withFtsMembershipFence(before, async () => {})).rejects.toThrow('membership_epoch_changed');
  });

  it('changes no membership when there is nothing to rewrite', async () => {
    index.set(key(1), storedRow(1, true));
    const before = coordinator.getFtsMembershipEpoch();
    await indexMessages(ftsSearch);
    await expect(coordinator.withFtsMembershipFence(before, async () => 'ok')).resolves.toBe('ok');
  });

  it('aborts without writing or recording when the attachment flags cannot be read', async () => {
    browser.tmHdr.getHasAttachmentBulk.mockRejectedValue(new Error('boom'));
    await expect(indexMessages(ftsSearch)).rejects.toThrow('boom');
    expect(ftsSearch.removeBatch).not.toHaveBeenCalled();
    expect(ftsSearch.indexBatch).not.toHaveBeenCalled();
    expect(storage[REPAIRED_KEY]).toBeUndefined();
  });

  it('rewrites through the engine\'s membership wrappers inside the fence without deadlocking', async () => {
    native.impl = fakeIndex();
    const deadlock = new Promise((_, reject) => setTimeout(() => reject(new Error('repair deadlocked')), 1000));
    await Promise.race([indexMessages(engine.ftsSearch), deadlock]);
    expect(index.get(key(1))).toEqual({ ...storedRow(1, true), hasAttachments: true });
    expect(native.impl.removeBatch).toHaveBeenCalledWith([key(1)]);
    // The second argument is the wire-shape report the engine reads to attribute the write.
    expect(native.impl.indexBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ msgId: key(1), hasAttachments: true, folderId: folderIdOf(INBOX1) })],
      { withFolderIds: false });
    expect(native.impl.removeBatch.mock.invocationCallOrder[0]).toBeLessThan(native.impl.indexBatch.mock.invocationCallOrder[0]);
    expect(storage[REPAIRED_KEY]).toEqual(['account1']);
  });
});
