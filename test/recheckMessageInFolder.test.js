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
    abortList: vi.fn(),
  },
  folders: {
    query: vi.fn(async () => []),
  },
};

const { recheckMessageInFolder } = await import('../agent/modules/utils.js');
const { SETTINGS } = await import('../agent/modules/config.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const WE_FOLDER = { accountId: 'account1', path: '/[Gmail]/Bin' };

beforeEach(() => {
  browser.messages.query.mockReset();
  browser.messages.continueList.mockReset();
  browser.messages.abortList = vi.fn();
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

// ---------------------------------------------------------------------------
// MessageList lifecycle. Thunderbird keeps a query's list registered until its
// terminal page (the page without an `id`) is consumed; `abortList` only stops
// further production. Every exit that leaves a page id outstanding must abort
// and then drain, or the list (and the query behind it) stays alive.
// ---------------------------------------------------------------------------

/**
 * Thunderbird-like MessageList fake. `pages` are the pages the list would
 * produce; `abortList` stops production (later pages are dropped) but the list
 * stays registered until a terminal page is handed out.
 */
// `buffered` is how many pages Thunderbird has already produced. abortList
// stops further production only: buffered pages are still delivered, and the
// list stays registered until its terminal page (no `id`) is consumed.
function installListFake(pages, { listId = 'list-1', continueFailures = [], buffered = pages.length } = {}) {
  const state = { outstanding: 0, aborted: false, next: 0 };
  const failures = [...continueFailures];
  const pageAt = index => {
    const end = state.aborted ? Math.min(pages.length, buffered) : pages.length;
    const last = index >= end - 1;
    if (last) state.outstanding = 0;
    return { ...(last ? {} : { id: listId }), messages: index < end ? pages[index] : [] };
  };
  browser.messages.query.mockImplementation(async () => {
    state.outstanding = pages.length > 1 ? 1 : 0;
    state.next = 1;
    return pageAt(0);
  });
  browser.messages.continueList.mockImplementation(async id => {
    if (id !== listId || state.outstanding === 0) throw new Error('unknown list');
    const failure = failures.shift();
    if (failure === 'throw') throw new Error('list busy');
    if (failure === 'nullish') return undefined;
    return pageAt(state.next++);
  });
  browser.messages.abortList = vi.fn(async id => {
    if (id === listId) state.aborted = true;
  });
  return state;
}

const HIT = { id: 7, folder: { accountId: 'account1', path: '/[Gmail]/Bin' } };
const MISS = { id: 3, folder: { accountId: 'account1', path: '/INBOX' } };

describe('recheckMessageInFolder list lifecycle', () => {
  it('releases a buffered list after a first-page match', async () => {
    const state = installListFake([[HIT], [MISS], [MISS]]);

    expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('present');
    expect(browser.messages.abortList).toHaveBeenCalledWith('list-1');
    expect(state.outstanding).toBe(0);
  });

  it('drains every buffered page after aborting a first-page match', async () => {
    const state = installListFake([[HIT], [MISS], [MISS], [MISS]]);

    expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('present');
    expect(browser.messages.abortList).toHaveBeenCalledWith('list-1');
    expect(browser.messages.continueList).toHaveBeenCalledTimes(3);
    expect(state.outstanding).toBe(0);
  });

  it('stops at the terminal page once abort halts production of unbuffered pages', async () => {
    const state = installListFake([[HIT], [MISS], [MISS], [MISS]], { buffered: 2 });

    expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('present');
    expect(browser.messages.continueList).toHaveBeenCalledTimes(1);
    expect(state.outstanding).toBe(0);
  });

  it('releases the list after a continuation-page match', async () => {
    const state = installListFake([[MISS], [HIT], [MISS], [MISS]]);

    expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('present');
    expect(state.outstanding).toBe(0);
  });

  it('needs no finaliser after an exhausted negative', async () => {
    const state = installListFake([[MISS], [MISS]]);

    expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('absent');
    expect(browser.messages.abortList).not.toHaveBeenCalled();
    expect(state.outstanding).toBe(0);
  });

  it('releases the list by draining alone when abortList is unavailable', async () => {
    const state = installListFake([[HIT], [MISS], [MISS]]);
    browser.messages.abortList = undefined;

    expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('present');
    expect(state.outstanding).toBe(0);
  });

  it('releases the list after a pre-verdict continuation failure and still reports "error"', async () => {
    const state = installListFake([[MISS], [MISS], [MISS]], { continueFailures: ['throw'] });

    expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('error');
    expect(state.outstanding).toBe(0);
  });

  it('releases the last known list after a nullish continuation page and reports "error"', async () => {
    const state = installListFake([[MISS], [MISS], [MISS]], { continueFailures: ['nullish'] });

    expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('error');
    expect(state.outstanding).toBe(0);
  });

  it('keeps a "present" verdict when the finaliser itself fails, logging one fixed line', async () => {
    installListFake([[HIT], [MISS]]);
    browser.messages.abortList = vi.fn(async () => { throw new Error('abort failed'); });
    browser.messages.continueList.mockImplementation(async () => { throw new Error('drain failed'); });
    const saved = { verboseLogging: SETTINGS.verboseLogging, debugLogging: SETTINGS.debugLogging };
    SETTINGS.verboseLogging = true;
    SETTINGS.debugLogging = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).resolves.toBe('present');
      const lines = [...logSpy.mock.calls, ...warnSpy.mock.calls].map(call => String(call[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('msg-1@example.com');
      expect(lines[0]).not.toContain('abort failed');
      expect(lines[0]).not.toContain('drain failed');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      Object.assign(SETTINGS, saved);
    }
  });

  it('logs a query failure without the Message-ID or the error text', async () => {
    browser.messages.query.mockRejectedValue(new Error('msgDB busy for msg-1@example.com'));
    const saved = { verboseLogging: SETTINGS.verboseLogging, debugLogging: SETTINGS.debugLogging };
    SETTINGS.verboseLogging = true;
    SETTINGS.debugLogging = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await recheckMessageInFolder('msg-1@example.com', WE_FOLDER)).toBe('error');
      const lines = [...logSpy.mock.calls, ...warnSpy.mock.calls].map(call => String(call[0]));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toContain('msg-1@example.com');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      Object.assign(SETTINGS, saved);
    }
  });
});
