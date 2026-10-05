/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The incremental drain runs the real header and body steps of fts/indexer.js: a new email's
// row gets its attachment status from the downloaded message, a message whose header is gone is
// not indexed, and a failed attachment flag read keeps the work queued, never written as "no".

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { agentQueues: { ftsIncremental: {} }, eventLogger: { enabled: false } },
}));
vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsBatchOperation: vi.fn(),
  logFtsOperation: vi.fn(),
  logMessageEventBatch: vi.fn(),
  logMoveEvent: vi.fn(),
}));
vi.mock('../agent/modules/utils.js', () => ({
  getForegroundFetchPressure: vi.fn(() => ({ active: 0, waiting: 0, chatTyping: false })),
  getRealSubject: vi.fn(async m => m.subject || ''),
  getUniqueMessageKey: vi.fn(async m => `${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}`),
  getUniqueMessageKeyCandidates: vi.fn(() => []),
  headerIDToWeID: vi.fn(),
  log: vi.fn(),
  parseUniqueId: vi.fn(),
  recheckMessageInFolder: vi.fn(async () => 'absent'),
  releaseMessageList: vi.fn(async () => {}),
  resolveUniqueMessageKey: vi.fn(),
  safeGetFull: vi.fn(),
}));
vi.mock('../agent/modules/folderUtils.js', () => ({ getAllFoldersForAccount: vi.fn(async () => []) }));
vi.mock('../agent/modules/inboxContext.js', () => ({ getInboxForAccount: vi.fn(async () => null) }));
vi.mock('../agent/modules/onMoved.js', () => ({ sanitizeMessageTags: vi.fn(async () => ({ stripped: false })) }));
vi.mock('../chat/modules/icsParser.js', () => ({ extractIcsFromParts: vi.fn(async () => []), formatIcsAttachmentsAsString: vi.fn(() => '') }));
vi.mock('../fts/bodyExtract.js', () => ({ extractPlainText: vi.fn(async () => 'body text') }));

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (k) => {
        if (typeof k === 'string') return { [k]: storageData[k] };
        if (Array.isArray(k)) return Object.fromEntries(k.map(key => [key, storageData[key]]));
        return Object.fromEntries(Object.entries(k || {}).map(([key, d]) => [key, storageData[key] === undefined ? d : storageData[key]]));
      }),
      set: vi.fn(async obj => Object.assign(storageData, obj)),
      remove: vi.fn(async k => { for (const key of [k].flat()) delete storageData[key]; }),
    },
  },
  accounts: { list: vi.fn(async () => []) },
};

const { resolveUniqueMessageKey, safeGetFull } = await import('../agent/modules/utils.js');
const { _testExports, flushPendingUpdates } = await import('../fts/incrementalIndexer.js');

const FOLDER = { id: 'f1', accountId: 'account1', path: '/INBOX' };
const header = (id) => ({ id, headerMessageId: `m${id}@example.com`, subject: `S${id}`, author: 'a@example.com', recipients: [], ccList: [], date: new Date(), folder: FOLDER });
const keyOf = (id) => `account1:/INBOX:m${id}@example.com`;
// getFull trees: a message that IS the PDF, and a multipart/mixed whose parts are only text.
const pdfOnly = { contentType: 'message/rfc822', parts: [{ contentType: 'application/pdf', name: 'scan.pdf', size: 9 }] };
const mixedNoFile = { contentType: 'message/rfc822', parts: [{ contentType: 'multipart/mixed', parts: [{ contentType: 'text/plain', body: 'hi' }] }] };

let index;
let tbFlag;
let fts;

function queue(...ids) {
  for (const id of ids) {
    _testExports._getPendingUpdates().set(keyOf(id), {
      type: 'new', uniqueKey: keyOf(id), timestamp: Date.now() + id, folderKey: 'account1:/INBOX', hasFailed: false, lastFailedAt: 0, metadata: {},
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) delete storageData[key];
  _testExports._resetFolderReconState();
  _testExports._setIsEnabled(true);
  _testExports._setIndexerDisposed(false);
  _testExports._getPendingUpdates().clear();
  index = new Map();
  tbFlag = new Map([[1, false], [2, true]]);
  fts = {
    filterNewMessages: vi.fn(async rows => ({ newMsgIds: rows.map(r => r.msgId).filter(id => !index.has(id)) })),
    getMessageByMsgId: vi.fn(async id => (index.has(id) ? { msgId: id, ...index.get(id) } : null)),
    indexBatch: vi.fn(async rows => { for (const r of rows) index.set(r.msgId, r); return { count: rows.length }; }),
    removeBatch: vi.fn(async ids => ({ count: ids.length })),
  };
  _testExports._setFtsSearch(fts);
  resolveUniqueMessageKey.mockImplementation(async (key) => {
    const id = Number(/m(\d+)@/.exec(key)[1]);
    return { weFolder: FOLDER, headerID: `m${id}@example.com`, weID: id };
  });
  globalThis.browser.messages = { get: vi.fn(async id => header(id)) };
  globalThis.browser.tmHdr = { getHasAttachmentBulk: vi.fn(async ids => ids.map(id => (tbFlag.has(id) ? tbFlag.get(id) : null))) };
  safeGetFull.mockImplementation(async id => (id === 1 ? pdfOnly : mixedNoFile));
});

describe('incremental drain attachment status', () => {
  it('indexes each new email with the attachment status of the downloaded message, not the paperclip', async () => {
    queue(1, 2);
    await flushPendingUpdates();

    // 1 is a PDF-only email Thunderbird has no paperclip for; 2 has a paperclip but no file.
    expect(index.get(keyOf(1)).hasAttachments).toBe(true);
    expect(index.get(keyOf(2)).hasAttachments).toBe(false);
    expect(_testExports._getPendingUpdates().size).toBe(0);
  });

  it('indexes the file names of the downloaded message', async () => {
    queue(1, 2);
    await flushPendingUpdates();

    expect(index.get(keyOf(1)).attachmentNames).toBe('scan.pdf');
    expect(index.get(keyOf(2)).attachmentNames).toBe('');
  });

  it('keeps the paperclip for a headers-only message, whose download has no parts', async () => {
    globalThis.browser.messages.get.mockImplementation(async id => ({ ...header(id), headersOnly: true }));
    safeGetFull.mockImplementation(async () => ({ contentType: 'message/rfc822', parts: [{ contentType: 'multipart/mixed' }] }));
    queue(2);
    await flushPendingUpdates();

    expect(index.get(keyOf(2)).hasAttachments).toBe(true);
    expect(index.get(keyOf(2)).attachmentNames).toBe('');
  });

  it('does not index a message whose header is gone, and hands the work to reconciliation', async () => {
    tbFlag.delete(1);
    queue(1);
    await flushPendingUpdates();

    expect(fts.indexBatch).not.toHaveBeenCalled();
    expect(index.size).toBe(0);
    expect(_testExports._getPendingUpdates().has(keyOf(1))).toBe(false);
  });

  it('keeps the work queued when the attachment flags cannot be read', async () => {
    globalThis.browser.tmHdr.getHasAttachmentBulk.mockRejectedValue(new Error('experiment unavailable'));
    queue(1, 2);
    await flushPendingUpdates();

    expect(fts.indexBatch).not.toHaveBeenCalled();
    expect([..._testExports._getPendingUpdates().keys()].sort()).toEqual([keyOf(1), keyOf(2)]);
  });
});
