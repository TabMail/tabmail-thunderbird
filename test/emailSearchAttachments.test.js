/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// email_search prints each result's has_attachments line from the index once the index's
// attachment flags are repaired (fts/attachmentFlags.js). Until then it asks Thunderbird's
// message database by WebExtension id, and anything it cannot tell prints "unknown", never "no".
// formatMailList is the real one, so these tests check the line the model reads.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn(), resolveUniqueMessageKey: vi.fn() }));
vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: { searchPageSizeDefault: 2, searchPageSizeMax: 500 },
}));
vi.mock('../chat/modules/context.js', () => ({ ctx: {} }));
vi.mock('../chat/modules/markdown.js', () => ({ renderMarkdown: vi.fn((t) => t), attachSpecialLinkListeners: vi.fn() }));

const { log, resolveUniqueMessageKey } = await import('../agent/modules/utils.js');
const { run } = await import('../chat/tools/email_search.js');

const REPAIRED_KEY = 'fts_attachment_flags_repaired';
const now = Date.now();
const hit = (uniqueId, n, hasAttachments = 0) => ({
  uniqueId,
  dateMs: now - n * 60000,
  author: 'Sender <sender@example.com>',
  subject: `Subject ${n}`,
  hasAttachments,
});
const id = (n) => `account1:/INBOX:m${n}@example.com`;

const getHasAttachmentBulk = vi.fn();
let storage;
let hits;
let weIds;
let query = 0;

beforeEach(() => {
  vi.clearAllMocks();
  storage = {};
  // Hit n resolves to WebExtension id 100 + n, unless removed from weIds.
  weIds = new Map([[id(1), 101], [id(2), 102], [id(3), 103]]);
  resolveUniqueMessageKey.mockImplementation(async (uniqueId) => (weIds.has(uniqueId) ? { weID: weIds.get(uniqueId) } : null));
  hits = [hit(id(1), 1), hit(id(2), 2, 1), hit(id(3), 3)];
  globalThis.browser = {
    storage: { local: { get: vi.fn(async (k) => (k in storage ? { [k]: storage[k] } : {})), set: vi.fn() } },
    runtime: { sendMessage: vi.fn(async () => hits), getURL: vi.fn(() => '') },
    tmHdr: { getHasAttachmentBulk },
  };
  query += 1;
});

const printed = async (args = {}) => {
  const result = await run({ query: `q${query}`, sort: 'date_desc', ...args });
  return result.results
    .split(/\n(?=unique_id: )/)
    .filter((block) => block.startsWith('unique_id: '))
    .map((block) => [block.match(/unique_id: (\S*)/)[1], block.match(/has_attachments: (\w+)/)[1]]);
};

describe('email_search attachment line, index repaired', () => {
  beforeEach(() => { storage[REPAIRED_KEY] = true; });

  it('prints the index\'s flag and does not ask Thunderbird', async () => {
    expect(await printed()).toEqual([[id(1), 'no'], [id(2), 'yes']]);
    expect(await printed({ page_index: 2 })).toEqual([[id(3), 'no']]);
    expect(getHasAttachmentBulk).not.toHaveBeenCalled();
    expect(resolveUniqueMessageKey).not.toHaveBeenCalled();
  });
});

describe('email_search attachment line, index not yet repaired', () => {
  it('asks Thunderbird for the current page by WebExtension id, ignoring the index\'s flag', async () => {
    getHasAttachmentBulk.mockResolvedValue([true, false]);
    expect(await printed()).toEqual([[id(1), 'yes'], [id(2), 'no']]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([101, 102]);
    // One folder inventory is shared across the page's resolutions.
    const inventories = resolveUniqueMessageKey.mock.calls.map(([, opts]) => opts.folderInventory);
    expect(inventories[0]).toBeInstanceOf(Map);
    expect(inventories[1]).toBe(inventories[0]);
  });

  it('reads the flags of the requested page only', async () => {
    getHasAttachmentBulk.mockResolvedValue([true]);
    expect(await printed({ page_index: 2 })).toEqual([[id(3), 'yes']]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([103]);
  });

  it('prints unknown for a hit that does not resolve to exactly one live message', async () => {
    weIds.delete(id(1));
    getHasAttachmentBulk.mockResolvedValue([true]);
    expect(await printed()).toEqual([[id(1), 'unknown'], [id(2), 'yes']]);
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([102]);
  });

  it('prints unknown for a hit without a unique id, without asking Thunderbird', async () => {
    hits = [hit(undefined, 1)];
    resolveUniqueMessageKey.mockResolvedValue(null);
    expect(await printed()).toEqual([['', 'unknown']]);
    expect(getHasAttachmentBulk).not.toHaveBeenCalled();
  });

  it('prints unknown for a message whose header is gone', async () => {
    getHasAttachmentBulk.mockResolvedValue([null, false]);
    expect(await printed()).toEqual([[id(1), 'unknown'], [id(2), 'no']]);
  });

  it('prints unknown and logs an error when the flags cannot be read', async () => {
    getHasAttachmentBulk.mockRejectedValue(new Error('boom'));
    expect(await printed()).toEqual([[id(1), 'unknown'], [id(2), 'unknown']]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reading attachment flags failed'), 'error');
  });
});
