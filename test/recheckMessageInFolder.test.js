/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// recheckMessageInFolder.test.js — Tests for the verify-then-remove confirmation
// helper in agent/modules/utils.js. A folder-constrained messages.query can
// transiently return empty (msgDB mid-sync); this helper is the second,
// GLOBAL query whose SUCCESSFUL result is required before an FTS stale-entry
// removal is allowed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (same pattern as ftsReconcile.test.js — real utils.js, mocked deps)
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
    eventLogger: { enabled: false },
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  messages: {
    get: vi.fn(),
    query: vi.fn(),
    continueList: vi.fn(),
  },
  folders: {
    query: vi.fn(async () => []),
  },
};

const { recheckMessageInFolder } = await import('../agent/modules/utils.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const WE_FOLDER = { accountId: 'account1', path: '/[Gmail]/Bin' };

beforeEach(() => {
  browser.messages.query.mockReset();
  browser.messages.continueList.mockReset();
});

describe('recheckMessageInFolder', () => {
  it('returns "present" when the message is found in the expected account+folder', async () => {
    browser.messages.query.mockResolvedValue({
      messages: [
        { id: 7, folder: { accountId: 'account1', path: '/[Gmail]/Bin' } },
      ],
    });

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);

    expect(verdict).toBe('present');
    // Must be a GLOBAL query — headerMessageId only, no folderId constraint
    expect(browser.messages.query).toHaveBeenCalledWith({ headerMessageId: 'msg-1@example.com' });
  });

  it('returns "present" when found among copies in multiple folders', async () => {
    browser.messages.query.mockResolvedValue({
      messages: [
        { id: 3, folder: { accountId: 'account1', path: '/INBOX' } },
        { id: 7, folder: { accountId: 'account1', path: '/[Gmail]/Bin' } },
      ],
    });

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);
    expect(verdict).toBe('present');
  });

  it('returns "absent" when the message exists only in a different folder (moved)', async () => {
    browser.messages.query.mockResolvedValue({
      messages: [
        { id: 3, folder: { accountId: 'account1', path: '/Archive' } },
      ],
    });

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);
    expect(verdict).toBe('absent');
  });

  it('returns "absent" when the message exists only in a different account', async () => {
    browser.messages.query.mockResolvedValue({
      messages: [
        { id: 3, folder: { accountId: 'account9', path: '/[Gmail]/Bin' } },
      ],
    });

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);
    expect(verdict).toBe('absent');
  });

  it('returns "absent" when the query succeeds with no results', async () => {
    browser.messages.query.mockResolvedValue({ messages: [] });

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);
    expect(verdict).toBe('absent');
  });

  it('returns "error" when the query throws (must NOT be treated as confirmed absence)', async () => {
    browser.messages.query.mockRejectedValue(new Error('msgDB busy'));

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);
    expect(verdict).toBe('error');
  });

  it('returns "error" for invalid arguments without querying', async () => {
    expect(await recheckMessageInFolder('', WE_FOLDER)).toBe('error');
    expect(await recheckMessageInFolder(null, WE_FOLDER)).toBe('error');
    expect(await recheckMessageInFolder('msg-1@example.com', null)).toBe('error');
    expect(await recheckMessageInFolder('msg-1@example.com', { path: '/INBOX' })).toBe('error');
    expect(browser.messages.query).not.toHaveBeenCalled();
  });

  it('legacy folder-less key (empty path): matches by account only', async () => {
    browser.messages.query.mockResolvedValue({
      messages: [
        { id: 3, folder: { accountId: 'account1', path: '/Archive' } },
      ],
    });

    // Present anywhere in the key's account counts
    expect(await recheckMessageInFolder('msg-1@example.com', { accountId: 'account1' })).toBe('present');
    // Found only in a different account → absent
    expect(await recheckMessageInFolder('msg-1@example.com', { accountId: 'account9' })).toBe('absent');
  });

  // -------------------------------------------------------------------------
  // Pagination: messages.query is a paged MessageList; TB's auto-pagination
  // timeout can return a PARTIAL first page with a continuation id. A partial
  // page must never be treated as proof of absence.
  // -------------------------------------------------------------------------

  it('returns "present" when the match is on a continuation page', async () => {
    browser.messages.query.mockResolvedValue({
      id: 'list-1',
      messages: [
        { id: 3, folder: { accountId: 'account1', path: '/INBOX' } },
      ],
    });
    browser.messages.continueList.mockResolvedValue({
      messages: [
        { id: 7, folder: { accountId: 'account1', path: '/[Gmail]/Bin' } },
      ],
    });

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);

    expect(verdict).toBe('present');
    expect(browser.messages.continueList).toHaveBeenCalledWith('list-1');
  });

  it('returns "absent" only after draining ALL continuation pages', async () => {
    browser.messages.query.mockResolvedValue({
      id: 'list-1',
      messages: [
        { id: 3, folder: { accountId: 'account1', path: '/INBOX' } },
      ],
    });
    browser.messages.continueList
      .mockResolvedValueOnce({
        id: 'list-1',
        messages: [{ id: 4, folder: { accountId: 'account1', path: '/Archive' } }],
      })
      .mockResolvedValueOnce({
        messages: [{ id: 5, folder: { accountId: 'account9', path: '/[Gmail]/Bin' } }],
      });

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);

    expect(verdict).toBe('absent');
    expect(browser.messages.continueList).toHaveBeenCalledTimes(2);
  });

  it('returns "error" when continueList throws mid-drain (partial page is not proof)', async () => {
    browser.messages.query.mockResolvedValue({
      id: 'list-1',
      messages: [
        { id: 3, folder: { accountId: 'account1', path: '/INBOX' } },
      ],
    });
    browser.messages.continueList.mockRejectedValue(new Error('list expired'));

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);
    expect(verdict).toBe('error');
  });

  it('returns "error" when the query resolves to a nullish result (fail closed)', async () => {
    browser.messages.query.mockResolvedValue(undefined);
    expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('error');
  });

  it('returns "error" when continueList resolves nullish mid-drain (fail closed)', async () => {
    browser.messages.query.mockResolvedValue({
      id: 'list-1',
      messages: [
        { id: 3, folder: { accountId: 'account1', path: '/INBOX' } },
      ],
    });
    browser.messages.continueList.mockResolvedValue(undefined);

    expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('error');
  });

  it('short-circuits without draining when the match is on the first page', async () => {
    browser.messages.query.mockResolvedValue({
      id: 'list-1',
      messages: [
        { id: 7, folder: { accountId: 'account1', path: '/[Gmail]/Bin' } },
      ],
    });

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);

    expect(verdict).toBe('present');
    expect(browser.messages.continueList).not.toHaveBeenCalled();
  });

  it('tolerates messages with missing folder info in the result set', async () => {
    browser.messages.query.mockResolvedValue({
      messages: [
        { id: 3 }, // no folder
        { id: 7, folder: { accountId: 'account1', path: '/[Gmail]/Bin' } },
      ],
    });

    const verdict = await recheckMessageInFolder('msg-1@example.com', WE_FOLDER);
    expect(verdict).toBe('present');
  });
});
