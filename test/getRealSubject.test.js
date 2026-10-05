/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// getRealSubject.test.js — Tests for getRealSubject utility and chat typing gate

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    logTruncateLength: 100,
    getFullDiag: {},
    getFullTTLSeconds: 3600,
    getFullMaxCacheEntries: 100,
    getFullCleanupIntervalMinutes: 10,
  },
}));

const mockGetHasReBulk = vi.fn();

globalThis.browser = {
  tmHdr: {
    getHasReBulk: (...args) => mockGetHasReBulk(...args),
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
  },
};

// ---------------------------------------------------------------------------
// Import tested functions
// ---------------------------------------------------------------------------

const { getRealSubject, signalChatTyping } = await import('../agent/modules/utils.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getRealSubject', () => {
  beforeEach(() => {
    mockGetHasReBulk.mockReset();
  });

  const header = (id, subject) => ({
    id,
    subject,
    folder: { id: 'folder1', path: '/INBOX' },
    headerMessageId: `m${id}@example.com`,
  });

  it('returns original subject when HasRe flag is not set', async () => {
    mockGetHasReBulk.mockResolvedValue([false]);
    expect(await getRealSubject(header(1, 'Meeting notes'))).toBe('Meeting notes');
  });

  it('prepends Re: when the HasRe flag is set', async () => {
    mockGetHasReBulk.mockResolvedValue([true]);
    expect(await getRealSubject(header(2, 'Meeting notes'))).toBe('Re: Meeting notes');
  });

  it('does not double-prepend Re: if subject already starts with it', async () => {
    mockGetHasReBulk.mockResolvedValue([true]);
    expect(await getRealSubject(header(3, 'Re: Meeting notes'))).toBe('Re: Meeting notes');
  });

  it('returns empty string for null header', async () => {
    expect(await getRealSubject(null)).toBe('');
  });

  it('returns empty string for undefined header', async () => {
    expect(await getRealSubject(undefined)).toBe('');
  });

  it('returns subject when header has no subject field', async () => {
    mockGetHasReBulk.mockResolvedValue([true]);
    // empty subject, HasRe set, but "Re: " + "" = "Re: "
    expect(await getRealSubject({ id: 4, folder: { id: 'folder1', path: '/INBOX' } })).toBe('Re: ');
  });

  it('gracefully handles a flag read error', async () => {
    mockGetHasReBulk.mockRejectedValue(new Error('API unavailable'));
    expect(await getRealSubject(header(5, 'Important'))).toBe('Important');
  });

  it('returns the subject unchanged when the read returns no result', async () => {
    mockGetHasReBulk.mockResolvedValue([]);
    expect(await getRealSubject(header(6, 'Test'))).toBe('Test');
  });

  it('reads the flag by the message\'s WebExtension id alone', async () => {
    mockGetHasReBulk.mockResolvedValue([false]);
    await getRealSubject(header(42, 'Test'));
    expect(mockGetHasReBulk).toHaveBeenCalledWith([42]);
  });

  it('needs no folder', async () => {
    mockGetHasReBulk.mockResolvedValue([true]);
    expect(await getRealSubject({ id: 8, subject: 'No folder' })).toBe('Re: No folder');
    expect(mockGetHasReBulk).toHaveBeenCalledWith([8]);
  });
});

describe('signalChatTyping', () => {
  it('is exported and callable', () => {
    expect(typeof signalChatTyping).toBe('function');
    // Should not throw
    signalChatTyping();
  });
});
