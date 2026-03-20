// reminderAdd.test.js — Tests for formatReminderEntry in chat/tools/reminder_add.js

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis mocks
// ---------------------------------------------------------------------------
globalThis.browser = {
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => {}) },
};

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { events: { userKBPromptUpdated: 'user-kb-prompt-updated' } },
}));
vi.mock('../agent/modules/patchApplier.js', () => ({
  applyKBPatch: vi.fn(() => 'updated'),
}));
vi.mock('../agent/modules/promptGenerator.js', () => ({
  getUserKBPrompt: vi.fn(async () => ''),
}));
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: vi.fn((s) => s),
}));

const { _testFormatReminderEntry: formatReminderEntry } = await import('../chat/tools/reminder_add.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatReminderEntry', () => {
  it('should format text only (no date, no time)', () => {
    const result = formatReminderEntry('Reply to Prof.', null, null);
    expect(result).toBe('[Reminder] Reply to Prof.');
  });

  it('should format text with empty string date and time', () => {
    const result = formatReminderEntry('Buy groceries', '', '');
    // empty strings are falsy, same as null
    expect(result).toBe('[Reminder] Buy groceries');
  });

  it('should format text with date only', () => {
    const result = formatReminderEntry('Submit report', '2026/03/25', null);
    // Should include date and timezone suffix
    expect(result).toMatch(/^\[Reminder\] Due 2026\/03\/25 \[.+\], Submit report$/);
  });

  it('should format text with date and time', () => {
    const result = formatReminderEntry('Meeting prep', '2026/04/01', '14:00');
    expect(result).toMatch(/^\[Reminder\] Due 2026\/04\/01 14:00 \[.+\], Meeting prep$/);
  });

  it('should include IANA timezone when date is present', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const result = formatReminderEntry('Call dentist', '2026/05/10', null);
    expect(result).toContain(`[${tz}]`);
  });

  it('should NOT include timezone when no date is provided', () => {
    const result = formatReminderEntry('Remember to breathe', null, null);
    expect(result).toBe('[Reminder] Remember to breathe');
    // No IANA timezone pattern like [America/New_York]
    expect(result).not.toMatch(/\[.+\/.+\]/);
  });

  it('should handle time without date (only text used)', () => {
    // dueDate is falsy so dueTime is irrelevant per the function logic
    const result = formatReminderEntry('Quick note', null, '09:30');
    expect(result).toBe('[Reminder] Quick note');
  });

  it('should preserve special characters in text', () => {
    const result = formatReminderEntry('Reply to "John" & Jane <3', '2026/06/15', null);
    expect(result).toContain('Reply to "John" & Jane <3');
  });

  it('should handle very long text', () => {
    const longText = 'A'.repeat(500);
    const result = formatReminderEntry(longText, null, null);
    expect(result).toBe(`[Reminder] ${longText}`);
  });
});
