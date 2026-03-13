// reminderStateStore.test.js — Tests for agent/modules/reminderStateStore.js
//
// Tests for TB-150 through TB-153 (TESTS.md).
// Browser storage API is mocked; only pure hashReminder logic is under test.

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — reminderStateStore.js imports log from utils.js
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
  },
}));

vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));

vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

// ---------------------------------------------------------------------------
// Import pure function under test
// ---------------------------------------------------------------------------

const { hashReminder } = await import('../agent/modules/reminderStateStore.js');

// ---------------------------------------------------------------------------
// TB-150: hashReminder — message reminder with rfc822MessageId → `m:<id>` format
// ---------------------------------------------------------------------------
describe('TB-150: hashReminder message reminder with rfc822MessageId', () => {
  it('returns m:<id> format for message source with rfc822MessageId', () => {
    const reminder = {
      source: 'message',
      rfc822MessageId: 'abc123@example.com',
    };
    expect(hashReminder(reminder)).toBe('m:abc123@example.com');
  });

  it('uses uniqueId fallback when rfc822MessageId is absent', () => {
    const reminder = {
      source: 'message',
      uniqueId: 'account1:/INBOX:12345',
    };
    expect(hashReminder(reminder)).toBe('m:account1:/INBOX:12345');
  });
});

// ---------------------------------------------------------------------------
// TB-151: hashReminder — KB reminder → `k:<hash>` format
// ---------------------------------------------------------------------------
describe('TB-151: hashReminder KB reminder', () => {
  it('returns k:<hash> format for kb source', () => {
    const reminder = {
      source: 'kb',
      content: 'Buy groceries',
    };
    const result = hashReminder(reminder);
    expect(result).toMatch(/^k:-?[a-z0-9]+$/);
  });

  it('produces consistent hash for same content', () => {
    const r1 = { source: 'kb', content: 'Follow up with client' };
    const r2 = { source: 'kb', content: 'Follow up with client' };
    expect(hashReminder(r1)).toBe(hashReminder(r2));
  });

  it('produces different hash for different content', () => {
    const r1 = { source: 'kb', content: 'Task A' };
    const r2 = { source: 'kb', content: 'Task B' };
    expect(hashReminder(r1)).not.toBe(hashReminder(r2));
  });

  it('handles empty content for kb source', () => {
    const reminder = { source: 'kb', content: '' };
    const result = hashReminder(reminder);
    // djb2 of empty string = 0, base36 = "0"
    expect(result).toBe('k:0');
  });
});

// ---------------------------------------------------------------------------
// TB-152: hashReminder — fallback → `o:<first32chars>` format
// ---------------------------------------------------------------------------
describe('TB-152: hashReminder fallback', () => {
  it('returns o:<first32chars> for unknown source', () => {
    const reminder = {
      source: 'unknown',
      content: 'This is a reminder with more than thirty-two characters in it',
    };
    const result = hashReminder(reminder);
    expect(result).toMatch(/^o:/);
    // Should be exactly first 32 chars of content after "o:"
    expect(result).toBe('o:This is a reminder with more tha');
  });

  it('returns o:<content> for short content', () => {
    const reminder = {
      source: 'other',
      content: 'Short',
    };
    expect(hashReminder(reminder)).toBe('o:Short');
  });

  it('handles missing content in fallback', () => {
    const reminder = { source: 'other' };
    expect(hashReminder(reminder)).toBe('o:');
  });

  it('falls back when message source has no rfc822MessageId or uniqueId', () => {
    const reminder = {
      source: 'message',
      content: 'Some reminder text',
    };
    // No rfc822MessageId, no uniqueId → falls through to fallback
    expect(hashReminder(reminder)).toBe('o:Some reminder text');
  });
});

// ---------------------------------------------------------------------------
// TB-153: hashReminder — bracket stripping from Message-ID
// ---------------------------------------------------------------------------
describe('TB-153: hashReminder bracket stripping', () => {
  it('strips angle brackets from rfc822MessageId', () => {
    const reminder = {
      source: 'message',
      rfc822MessageId: '<msg-001@mail.example.com>',
    };
    expect(hashReminder(reminder)).toBe('m:msg-001@mail.example.com');
  });

  it('strips only angle brackets, preserves other special chars', () => {
    const reminder = {
      source: 'message',
      rfc822MessageId: '<user+tag@[192.168.1.1]>',
    };
    // Only < and > are stripped; square brackets remain
    expect(hashReminder(reminder)).toBe('m:user+tag@[192.168.1.1]');
  });

  it('handles id without brackets (no-op)', () => {
    const reminder = {
      source: 'message',
      rfc822MessageId: 'plain-id@example.com',
    };
    expect(hashReminder(reminder)).toBe('m:plain-id@example.com');
  });

  it('handles id with multiple angle brackets', () => {
    const reminder = {
      source: 'message',
      rfc822MessageId: '<<nested>>@example.com',
    };
    expect(hashReminder(reminder)).toBe('m:nested@example.com');
  });
});
