/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// emailSearchFetchSize.test.js — email_search with the shipped settings (#150): the 100 best
// matches in pages of 20, whatever the page size is set to.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn(), resolveUniqueMessageKey: vi.fn() }));
vi.mock('../chat/modules/helpers.js', () => ({
  formatMailList: (items) => items.map((item) => item.uniqueId).join(','),
  toIsoNoMs: (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z'),
}));

const { CHAT_SETTINGS } = await import('../chat/modules/chatConfig.js');
const emailSearch = await import('../chat/tools/email_search.js');

const pageSize = CHAT_SETTINGS.searchPageSizeDefault;
const shown = (result) => result.results.split(',');
const searchLimits = () => browser.runtime.sendMessage.mock.calls.filter(([m]) => m.cmd === 'search').map(([m]) => m.limit);

beforeEach(() => {
  emailSearch.resetPaginationSessions();
  const hits = Array.from({ length: 150 }, (_, i) => ({ uniqueId: `account1:INBOX:message${i}`, dateMs: Date.now() - i * 60_000 }));
  globalThis.browser = {
    // The tool runs as a page: fts/nativeEngine.js (through ftsRequest) loads config.js, which listens for storage changes.
    storage: { onChanged: { addListener() {} }, local: { get: vi.fn(async () => ({ fts_attachment_repaired_accounts: ['account1'] })) } },
    // The search answers at most the limit it is asked for, as the helper does; "few" has 3 matches.
    runtime: {
      sendMessage: vi.fn(async (msg) => (msg.cmd === 'search' ? hits.slice(0, Math.min(msg.q === 'few' ? 3 : hits.length, msg.limit)) : null)),
    },
  };
});

afterEach(() => {
  CHAT_SETTINGS.searchPageSizeDefault = pageSize;
  delete globalThis.browser;
});

describe('email_search fetch size with the shipped settings', () => {
  it('serves the 100 best matches in five pages of 20, or the 3 there are', async () => {
    const first = await emailSearch.run({ query: 'invoice' });
    expect(first).toMatchObject({ totalItems: 100, page: 1, totalPages: 5 });
    expect(shown(first)).toHaveLength(20);
    expect(shown(first)[0]).toBe('account1:INBOX:message0');
    const last = await emailSearch.run({ query: 'invoice', page_index: 9 });
    expect(last).toMatchObject({ totalItems: 100, page: 5, totalPages: 5 });
    expect(shown(last)).toHaveLength(20);
    expect(shown(last).at(-1)).toBe('account1:INBOX:message99');
    const few = await emailSearch.run({ query: 'few' });
    expect(few).toMatchObject({ totalItems: 3, page: 1, totalPages: 1 });
    expect(shown(few)).toHaveLength(3);
    expect(searchLimits()).toEqual([100, 100]);
  });

  it('still fetches 100 when the page size is raised to its maximum', async () => {
    CHAT_SETTINGS.searchPageSizeDefault = CHAT_SETTINGS.searchPageSizeMax;
    const result = await emailSearch.run({ query: 'invoice' });
    expect(result.totalItems).toBe(100);
    expect(shown(result)).toHaveLength(Math.min(100, CHAT_SETTINGS.searchPageSizeMax));
    expect(searchLimits()).toEqual([100]);
  });
});
