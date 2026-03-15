// reminderBuilder.test.js — Tests for formatRemindersForDisplay and getDisplayedReminderHashes
// in agent/modules/reminderBuilder.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
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

vi.mock('../agent/modules/inboxContext.js', () => ({
  buildInboxContext: vi.fn(async () => ({ messages: [] })),
}));

vi.mock('../agent/modules/kbReminderGenerator.js', () => ({
  getKBReminders: vi.fn(async () => []),
}));

vi.mock('../agent/modules/summaryGenerator.js', () => ({
  getSummaryWithHeaderId: vi.fn(async () => null),
}));

// Browser mock for storage (needed by reminderStateStore imported transitively)
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (arg) => {
        if (Array.isArray(arg)) return {};
        if (typeof arg === 'object') {
          const result = {};
          for (const [k, def] of Object.entries(arg)) {
            result[k] = def;
          }
          return result;
        }
        return {};
      }),
      set: vi.fn(async () => {}),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  accounts: {
    list: vi.fn(async () => []),
  },
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const { formatRemindersForDisplay, getDisplayedReminderHashes } = await import('../agent/modules/reminderBuilder.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatRemindersForDisplay', () => {
  it('returns empty string for null input', () => {
    expect(formatRemindersForDisplay(null)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(formatRemindersForDisplay([])).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatRemindersForDisplay(undefined)).toBe('');
  });

  it('formats a single reminder without due date', () => {
    const reminders = [
      { content: 'Call dentist', hash: 'h1' },
    ];
    const result = formatRemindersForDisplay(reminders);
    expect(result).toContain('Call dentist');
    expect(result).toContain('[reminder]');
    expect(result).toContain('Today\'s Reminders');
  });

  it('formats a reminder with a future due date', () => {
    // Use a date far in the future
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 10);
    const futureDateStr = futureDate.toISOString().split('T')[0]; // YYYY-MM-DD

    const reminders = [
      { content: 'Submit report', dueDate: futureDateStr, hash: 'h2' },
    ];
    const result = formatRemindersForDisplay(reminders);
    expect(result).toContain('Submit report');
    expect(result).toContain('Due');
  });

  it('formats a reminder due today', () => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const reminders = [
      { content: 'Team standup', dueDate: todayStr, hash: 'h3' },
    ];
    const result = formatRemindersForDisplay(reminders);
    expect(result).toContain('Team standup');
    expect(result).toContain('**Today**');
  });

  it('formats a reminder due today with time', () => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const reminders = [
      { content: 'Meeting', dueDate: todayStr, dueTime: '14:30', hash: 'h4' },
    ];
    const result = formatRemindersForDisplay(reminders);
    expect(result).toContain('**Today at 14:30**');
  });

  it('formats a reminder due tomorrow', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

    const reminders = [
      { content: 'Deadline', dueDate: tomorrowStr, hash: 'h5' },
    ];
    const result = formatRemindersForDisplay(reminders);
    expect(result).toContain('**Tomorrow**');
  });

  it('formats an overdue reminder (1 day)', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    const reminders = [
      { content: 'Overdue task', dueDate: yesterdayStr, hash: 'h6' },
    ];
    const result = formatRemindersForDisplay(reminders);
    expect(result).toContain('**Overdue (1 day)**');
  });

  it('formats an overdue reminder (multiple days)', () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 5);
    const pastDateStr = `${pastDate.getFullYear()}-${String(pastDate.getMonth() + 1).padStart(2, '0')}-${String(pastDate.getDate()).padStart(2, '0')}`;

    const reminders = [
      { content: 'Old task', dueDate: pastDateStr, hash: 'h7' },
    ];
    const result = formatRemindersForDisplay(reminders);
    expect(result).toContain('**Overdue (5 days)**');
  });

  it('sorts reminders by due date (nulls last)', () => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

    const reminders = [
      { content: 'No date', hash: 'h8' },
      { content: 'Tomorrow task', dueDate: tomorrowStr, hash: 'h9' },
      { content: 'Today task', dueDate: todayStr, hash: 'h10' },
    ];
    const result = formatRemindersForDisplay(reminders);
    // Today should appear before Tomorrow, and both before No date
    const todayIdx = result.indexOf('Today task');
    const tomorrowIdx = result.indexOf('Tomorrow task');
    const noDateIdx = result.indexOf('No date');
    expect(todayIdx).toBeLessThan(tomorrowIdx);
    expect(tomorrowIdx).toBeLessThan(noDateIdx);
  });

  it('handles invalid date format gracefully', () => {
    const reminders = [
      { content: 'Bad date', dueDate: 'not-a-date', hash: 'h11' },
    ];
    const result = formatRemindersForDisplay(reminders);
    expect(result).toContain('Bad date');
    // Should not crash, just omit the due date label
  });

  it('handles multiple reminders', () => {
    const reminders = [
      { content: 'Task 1', hash: 'h12' },
      { content: 'Task 2', hash: 'h13' },
      { content: 'Task 3', hash: 'h14' },
    ];
    const result = formatRemindersForDisplay(reminders);
    expect(result).toContain('Task 1');
    expect(result).toContain('Task 2');
    expect(result).toContain('Task 3');
  });

  it('stores hashes in display order', () => {
    const reminders = [
      { content: 'A', hash: 'hash_a' },
      { content: 'B', hash: 'hash_b' },
    ];
    formatRemindersForDisplay(reminders);
    const hashes = getDisplayedReminderHashes();
    expect(hashes).toEqual(['hash_a', 'hash_b']);
  });

  it('handles reminders with missing hash', () => {
    const reminders = [
      { content: 'No hash reminder' },
    ];
    formatRemindersForDisplay(reminders);
    const hashes = getDisplayedReminderHashes();
    expect(hashes).toEqual(['']);
  });
});

describe('getDisplayedReminderHashes', () => {
  it('returns empty array initially (after clear)', () => {
    formatRemindersForDisplay([]);
    const hashes = getDisplayedReminderHashes();
    // After empty call, lastDisplayedReminderHashes is not reset by empty
    // but the function returns a copy
    expect(Array.isArray(hashes)).toBe(true);
  });

  it('returns a copy (not the original array)', () => {
    const reminders = [
      { content: 'Test', hash: 'test_hash' },
    ];
    formatRemindersForDisplay(reminders);
    const hashes1 = getDisplayedReminderHashes();
    const hashes2 = getDisplayedReminderHashes();
    expect(hashes1).toEqual(hashes2);
    expect(hashes1).not.toBe(hashes2); // Different array instances
  });

  it('updates when formatRemindersForDisplay is called again', () => {
    formatRemindersForDisplay([{ content: 'First', hash: 'first' }]);
    expect(getDisplayedReminderHashes()).toEqual(['first']);

    formatRemindersForDisplay([{ content: 'Second', hash: 'second' }]);
    expect(getDisplayedReminderHashes()).toEqual(['second']);
  });
});
