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

vi.mock('../agent/modules/kbTaskParser.js', () => ({
  parseTasksFromKB: vi.fn(() => []),
  getTaskHash: vi.fn((task) => `t:${task.instruction || ''}`),
}));

vi.mock('../agent/modules/kbReminderGenerator.js', () => ({
  getKBReminders: vi.fn(async () => []),
}));

vi.mock('../agent/modules/promptGenerator.js', () => ({
  getUserKBPrompt: vi.fn(async () => ''),
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

const { formatRemindersForDisplay, getDisplayedReminderHashes, buildReminderList, getFilteredReminders, getRandomReminders } = await import('../agent/modules/reminderBuilder.js');

// Get mocked modules for controlling behavior in async tests
const { buildInboxContext } = await import('../agent/modules/inboxContext.js');
const { getKBReminders } = await import('../agent/modules/kbReminderGenerator.js');
const { getSummaryWithHeaderId } = await import('../agent/modules/summaryGenerator.js');

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

// ---------------------------------------------------------------------------
// buildReminderList — combines message and KB reminders
// ---------------------------------------------------------------------------
describe('buildReminderList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty inbox, no KB reminders
    buildInboxContext.mockResolvedValue(null);
    getKBReminders.mockResolvedValue([]);
  });

  it('returns empty reminders when both sources are empty', async () => {
    buildInboxContext.mockResolvedValue('[]');
    const result = await buildReminderList();
    expect(result.reminders).toEqual([]);
    expect(result.counts.total).toBe(0);
    expect(result.counts.message).toBe(0);
    expect(result.counts.kb).toBe(0);
  });

  it('includes KB reminders with source tag', async () => {
    buildInboxContext.mockResolvedValue('[]');
    getKBReminders.mockResolvedValue([
      { content: 'Follow up on project', dueDate: null },
    ]);
    const result = await buildReminderList();
    expect(result.reminders.length).toBe(1);
    expect(result.reminders[0].source).toBe('kb');
    expect(result.reminders[0].content).toBe('Follow up on project');
    expect(result.counts.kb).toBe(1);
  });

  it('includes message reminders when summaries have reminders', async () => {
    buildInboxContext.mockResolvedValue(JSON.stringify([
      { uniqueId: 'u1', internalId: 'm1', subject: 'Test', from: 'alice@test.com', headerMessageId: '<abc@test>' },
    ]));
    getSummaryWithHeaderId.mockResolvedValue({
      reminder: { content: 'Reply to Alice', dueDate: null },
    });

    const result = await buildReminderList();
    expect(result.reminders.length).toBe(1);
    expect(result.reminders[0].source).toBe('message');
    expect(result.reminders[0].content).toBe('Reply to Alice');
    expect(result.counts.message).toBe(1);
  });

  it('skips messages that have been replied to', async () => {
    buildInboxContext.mockResolvedValue(JSON.stringify([
      { uniqueId: 'u1', internalId: 'm1', subject: 'Test', replied: true },
    ]));

    const result = await buildReminderList();
    expect(result.reminders.length).toBe(0);
  });

  it('skips messages with no summary data', async () => {
    buildInboxContext.mockResolvedValue(JSON.stringify([
      { uniqueId: 'u1', internalId: 'm1', subject: 'Test' },
    ]));
    getSummaryWithHeaderId.mockResolvedValue(null);

    const result = await buildReminderList();
    expect(result.reminders.length).toBe(0);
  });

  it('skips messages with empty reminder content', async () => {
    buildInboxContext.mockResolvedValue(JSON.stringify([
      { uniqueId: 'u1', internalId: 'm1', subject: 'Test' },
    ]));
    getSummaryWithHeaderId.mockResolvedValue({
      reminder: { content: '   ' },
    });

    const result = await buildReminderList();
    expect(result.reminders.length).toBe(0);
  });

  it('sorts reminders by due date (dates before nulls)', async () => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const future = new Date();
    future.setDate(future.getDate() + 5);
    const futureStr = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;

    buildInboxContext.mockResolvedValue('[]');
    getKBReminders.mockResolvedValue([
      { content: 'No date', dueDate: null },
      { content: 'Future', dueDate: futureStr },
      { content: 'Today', dueDate: todayStr },
    ]);

    const result = await buildReminderList();
    expect(result.reminders.length).toBe(3);
    expect(result.reminders[0].content).toBe('Today');
    expect(result.reminders[1].content).toBe('Future');
    expect(result.reminders[2].content).toBe('No date');
  });

  it('has generatedAt timestamp', async () => {
    buildInboxContext.mockResolvedValue('[]');
    const before = Date.now();
    const result = await buildReminderList();
    const after = Date.now();
    expect(result.generatedAt).toBeGreaterThanOrEqual(before);
    expect(result.generatedAt).toBeLessThanOrEqual(after);
  });

  it('returns error shape on unexpected failure', async () => {
    buildInboxContext.mockRejectedValue(new Error('network error'));
    getKBReminders.mockRejectedValue(new Error('network error'));

    const result = await buildReminderList();
    expect(result.reminders).toEqual([]);
    expect(result.counts.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getFilteredReminders — filters from buildReminderList results
// ---------------------------------------------------------------------------
describe('getFilteredReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildInboxContext.mockResolvedValue('[]');
  });

  it('returns all reminders when no filters specified', async () => {
    getKBReminders.mockResolvedValue([
      { content: 'A', dueDate: null },
      { content: 'B', dueDate: null },
    ]);

    const result = await getFilteredReminders();
    expect(result.length).toBe(2);
  });

  it('filters by source', async () => {
    buildInboxContext.mockResolvedValue(JSON.stringify([
      { uniqueId: 'u1', internalId: 'm1', subject: 'Test', headerMessageId: '<x@y>' },
    ]));
    getSummaryWithHeaderId.mockResolvedValue({
      reminder: { content: 'Message reminder' },
    });
    getKBReminders.mockResolvedValue([
      { content: 'KB reminder' },
    ]);

    const kbOnly = await getFilteredReminders({ source: 'kb' });
    expect(kbOnly.every(r => r.source === 'kb')).toBe(true);

    const msgOnly = await getFilteredReminders({ source: 'message' });
    expect(msgOnly.every(r => r.source === 'message')).toBe(true);
  });

  it('filters by urgentOnly (only reminders with due dates)', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

    getKBReminders.mockResolvedValue([
      { content: 'Has date', dueDate: tomorrowStr },
      { content: 'No date', dueDate: null },
    ]);

    const result = await getFilteredReminders({ urgentOnly: true });
    expect(result.length).toBe(1);
    expect(result[0].content).toBe('Has date');
  });

  it('limits results by maxCount', async () => {
    getKBReminders.mockResolvedValue([
      { content: 'A' },
      { content: 'B' },
      { content: 'C' },
    ]);

    const result = await getFilteredReminders({ maxCount: 2 });
    expect(result.length).toBe(2);
  });

  it('returns empty array on error', async () => {
    buildInboxContext.mockRejectedValue(new Error('fail'));
    getKBReminders.mockRejectedValue(new Error('fail'));

    const result = await getFilteredReminders();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getRandomReminders — prioritizes urgent, fills with random
// ---------------------------------------------------------------------------
describe('getRandomReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildInboxContext.mockResolvedValue('[]');
  });

  it('returns empty result when no reminders exist', async () => {
    getKBReminders.mockResolvedValue([]);

    const result = await getRandomReminders(2);
    expect(result.reminders).toEqual([]);
    expect(result.urgentCount).toBe(0);
    expect(result.totalCount).toBe(0);
  });

  it('includes all urgent reminders (overdue/today/tomorrow)', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

    getKBReminders.mockResolvedValue([
      { content: 'Overdue', dueDate: yesterdayStr },
      { content: 'Today', dueDate: todayStr },
      { content: 'Tomorrow', dueDate: tomorrowStr },
    ]);

    const result = await getRandomReminders(5);
    expect(result.urgentCount).toBe(3);
    expect(result.reminders.length).toBe(3);
  });

  it('fills remaining slots with non-urgent reminders', async () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const futureStr = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;

    getKBReminders.mockResolvedValue([
      { content: 'Far future A', dueDate: futureStr },
      { content: 'Far future B', dueDate: futureStr },
      { content: 'No date', dueDate: null },
    ]);

    const result = await getRandomReminders(2);
    expect(result.reminders.length).toBe(2);
    expect(result.urgentCount).toBe(0);
    expect(result.totalCount).toBe(3);
  });

  it('returns urgent reminders even when count is smaller', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    getKBReminders.mockResolvedValue([
      { content: 'Urgent 1', dueDate: yesterdayStr },
      { content: 'Urgent 2', dueDate: todayStr },
    ]);

    // Requesting 1, but there are 2 urgent — all urgent should still be included
    const result = await getRandomReminders(1);
    expect(result.urgentCount).toBe(2);
    expect(result.reminders.length).toBe(2);
  });

  it('handles invalid date formats gracefully', async () => {
    getKBReminders.mockResolvedValue([
      { content: 'Bad date', dueDate: 'not-valid' },
      { content: 'Good', dueDate: null },
    ]);

    const result = await getRandomReminders(5);
    // Should not crash, both should be in the result
    expect(result.reminders.length).toBe(2);
    expect(result.totalCount).toBe(2);
  });

  it('returns error shape on failure', async () => {
    buildInboxContext.mockRejectedValue(new Error('fail'));
    getKBReminders.mockRejectedValue(new Error('fail'));

    const result = await getRandomReminders(2);
    expect(result.reminders).toEqual([]);
    expect(result.urgentCount).toBe(0);
    expect(result.totalCount).toBe(0);
  });
});
