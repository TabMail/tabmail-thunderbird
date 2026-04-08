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

const mockGetFlags = vi.fn();

globalThis.browser = {
  tmHdr: {
    getFlags: (...args) => mockGetFlags(...args),
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
    mockGetFlags.mockReset();
  });

  it('returns original subject when HasRe flag is not set', async () => {
    mockGetFlags.mockResolvedValue({ exists: true, raw: 0x0000 });
    const header = {
      id: 1,
      subject: 'Meeting notes',
      folder: { id: 'folder1', path: '/INBOX' },
      headerMessageId: 'abc@example.com',
    };
    const result = await getRealSubject(header);
    expect(result).toBe('Meeting notes');
  });

  it('prepends Re: when HasRe flag (0x0010) is set', async () => {
    mockGetFlags.mockResolvedValue({ exists: true, raw: 0x0010 });
    const header = {
      id: 2,
      subject: 'Meeting notes',
      folder: { id: 'folder1', path: '/INBOX' },
      headerMessageId: 'def@example.com',
    };
    const result = await getRealSubject(header);
    expect(result).toBe('Re: Meeting notes');
  });

  it('does not double-prepend Re: if subject already starts with it', async () => {
    mockGetFlags.mockResolvedValue({ exists: true, raw: 0x0010 });
    const header = {
      id: 3,
      subject: 'Re: Meeting notes',
      folder: { id: 'folder1', path: '/INBOX' },
      headerMessageId: 'ghi@example.com',
    };
    const result = await getRealSubject(header);
    expect(result).toBe('Re: Meeting notes');
  });

  it('returns empty string for null header', async () => {
    const result = await getRealSubject(null);
    expect(result).toBe('');
  });

  it('returns empty string for undefined header', async () => {
    const result = await getRealSubject(undefined);
    expect(result).toBe('');
  });

  it('returns subject when header has no subject field', async () => {
    mockGetFlags.mockResolvedValue({ exists: true, raw: 0x0010 });
    const header = {
      id: 4,
      folder: { id: 'folder1', path: '/INBOX' },
      headerMessageId: 'jkl@example.com',
    };
    const result = await getRealSubject(header);
    // empty subject, HasRe set, but "Re: " + "" = "Re: "
    expect(result).toBe('Re: ');
  });

  it('gracefully handles getFlags error', async () => {
    mockGetFlags.mockRejectedValue(new Error('API unavailable'));
    const header = {
      id: 5,
      subject: 'Important',
      folder: { id: 'folder1', path: '/INBOX' },
      headerMessageId: 'mno@example.com',
    };
    const result = await getRealSubject(header);
    expect(result).toBe('Important');
  });

  it('gracefully handles getFlags returning non-existent', async () => {
    mockGetFlags.mockResolvedValue({ exists: false });
    const header = {
      id: 6,
      subject: 'Test',
      folder: { id: 'folder1', path: '/INBOX' },
      headerMessageId: 'pqr@example.com',
    };
    const result = await getRealSubject(header);
    expect(result).toBe('Test');
  });

  it('handles HasRe combined with other flags', async () => {
    // HasRe (0x0010) + Replied (0x0002) + Read (0x0001) = 0x0013
    mockGetFlags.mockResolvedValue({ exists: true, raw: 0x0013 });
    const header = {
      id: 7,
      subject: 'Budget update',
      folder: { id: 'folder1', path: '/INBOX' },
      headerMessageId: 'stu@example.com',
    };
    const result = await getRealSubject(header);
    expect(result).toBe('Re: Budget update');
  });

  it('passes correct args to getFlags', async () => {
    mockGetFlags.mockResolvedValue({ exists: true, raw: 0 });
    const header = {
      id: 42,
      subject: 'Test',
      folder: { id: 'imap://user@host/INBOX', path: '/INBOX' },
      headerMessageId: 'xyz@example.com',
    };
    await getRealSubject(header);
    expect(mockGetFlags).toHaveBeenCalledWith(
      'imap://user@host/INBOX',
      42,
      '/INBOX',
      'xyz@example.com'
    );
  });

  it('handles missing folder gracefully', async () => {
    mockGetFlags.mockResolvedValue({ exists: true, raw: 0x0010 });
    const header = {
      id: 8,
      subject: 'No folder',
      headerMessageId: 'abc@example.com',
    };
    const result = await getRealSubject(header);
    expect(result).toBe('Re: No folder');
    expect(mockGetFlags).toHaveBeenCalledWith('', 8, '', 'abc@example.com');
  });
});

describe('signalChatTyping', () => {
  it('is exported and callable', () => {
    expect(typeof signalChatTyping).toBe('function');
    // Should not throw
    signalChatTyping();
  });
});
