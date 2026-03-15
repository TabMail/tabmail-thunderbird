// reminderStateStore.test.js — Tests for agent/modules/reminderStateStore.js

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const { hashReminder } = await import('../agent/modules/reminderStateStore.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hashReminder', () => {
  it('hashes message reminder with rfc822MessageId', () => {
    const result = hashReminder({
      source: 'message',
      rfc822MessageId: '<test@example.com>',
    });
    expect(result).toBe('m:test@example.com');
  });

  it('strips angle brackets from message ID', () => {
    const result = hashReminder({
      source: 'message',
      rfc822MessageId: '<msg123@mail.com>',
    });
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).toContain('msg123@mail.com');
  });

  it('falls back to uniqueId for message reminders without rfc822MessageId', () => {
    const result = hashReminder({
      source: 'message',
      uniqueId: 'uid-123',
    });
    expect(result).toBe('m:uid-123');
  });

  it('hashes kb reminder with djb2 hash', () => {
    const result = hashReminder({
      source: 'kb',
      content: 'Test content',
    });
    expect(result).toMatch(/^k:/);
  });

  it('produces consistent hashes for same content', () => {
    const r1 = hashReminder({ source: 'kb', content: 'Hello world' });
    const r2 = hashReminder({ source: 'kb', content: 'Hello world' });
    expect(r1).toBe(r2);
  });

  it('produces different hashes for different content', () => {
    const r1 = hashReminder({ source: 'kb', content: 'Hello' });
    const r2 = hashReminder({ source: 'kb', content: 'World' });
    expect(r1).not.toBe(r2);
  });

  it('falls back to content prefix for unknown source', () => {
    const result = hashReminder({
      source: 'unknown',
      content: 'Some reminder content here',
    });
    expect(result).toMatch(/^o:/);
    expect(result).toContain('Some reminder content here');
  });

  it('handles empty content in fallback', () => {
    const result = hashReminder({ source: 'unknown' });
    expect(result).toBe('o:');
  });
});
