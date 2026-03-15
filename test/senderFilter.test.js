// senderFilter.test.js — Tests for agent/modules/senderFilter.js
//
// Tests for extractEmailFromAuthor (pure), getUserEmailSetCached (mocked browser),
// and isInternalSender (mocked browser).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));

vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));

vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

// Set up browser mock before importing the module
globalThis.browser = {
  accounts: {
    list: vi.fn(async () => []),
  },
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const { extractEmailFromAuthor, getUserEmailSetCached, isInternalSender } = await import('../agent/modules/senderFilter.js');

// ---------------------------------------------------------------------------
// extractEmailFromAuthor (pure function)
// ---------------------------------------------------------------------------

describe('extractEmailFromAuthor', () => {
  it('extracts email from angle brackets', () => {
    expect(extractEmailFromAuthor('John Doe <john@example.com>')).toBe('john@example.com');
  });

  it('extracts email with display name containing special chars', () => {
    expect(extractEmailFromAuthor('"Doe, John" <john@example.com>')).toBe('john@example.com');
  });

  it('extracts bare email address', () => {
    expect(extractEmailFromAuthor('john@example.com')).toBe('john@example.com');
  });

  it('lowercases the result', () => {
    expect(extractEmailFromAuthor('John@EXAMPLE.COM')).toBe('john@example.com');
    expect(extractEmailFromAuthor('User <John@EXAMPLE.COM>')).toBe('john@example.com');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(extractEmailFromAuthor(null)).toBe('');
    expect(extractEmailFromAuthor(undefined)).toBe('');
    expect(extractEmailFromAuthor('')).toBe('');
  });

  it('returns empty string for malformed input with no email', () => {
    expect(extractEmailFromAuthor('just a name')).toBe('');
  });

  it('handles plus-addressed emails', () => {
    expect(extractEmailFromAuthor('User <user+tag@example.com>')).toBe('user+tag@example.com');
  });

  it('handles dotted local parts', () => {
    expect(extractEmailFromAuthor('first.last@example.com')).toBe('first.last@example.com');
  });

  it('handles multiple angle bracket pairs (takes first)', () => {
    expect(extractEmailFromAuthor('a <a@x.com> b <b@y.com>')).toBe('a@x.com');
  });

  it('handles email with subdomains', () => {
    expect(extractEmailFromAuthor('user@mail.sub.example.com')).toBe('user@mail.sub.example.com');
  });

  it('handles non-string input types', () => {
    expect(extractEmailFromAuthor(42)).toBe('');
    expect(extractEmailFromAuthor({})).toBe('');
    expect(extractEmailFromAuthor(true)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getUserEmailSetCached (browser mock)
// ---------------------------------------------------------------------------

describe('getUserEmailSetCached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a Set', async () => {
    browser.accounts.list.mockResolvedValue([]);
    const result = await getUserEmailSetCached();
    expect(result).toBeInstanceOf(Set);
  });
});

// ---------------------------------------------------------------------------
// isInternalSender (browser mock)
// ---------------------------------------------------------------------------

describe('isInternalSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when no accounts', async () => {
    browser.accounts.list.mockResolvedValue([]);
    const result = await isInternalSender({ author: 'someone@example.com' });
    expect(result).toBe(false);
  });

  it('returns false for null message header', async () => {
    const result = await isInternalSender(null);
    expect(result).toBe(false);
  });

  it('returns false when author has no email', async () => {
    const result = await isInternalSender({ author: 'just a name' });
    expect(result).toBe(false);
  });
});
