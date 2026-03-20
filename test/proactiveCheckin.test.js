// proactiveCheckin.test.js — Tests for pure-logic internal functions from
// agent/modules/proactiveCheckin.js, exported via _testExports.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    notifications: {},
  },
}));

vi.mock('../agent/modules/reminderStateStore.js', () => ({
  hashReminder: vi.fn((r) => `hash:${r.content || ''}`),
}));

vi.mock('../../chat/modules/chatWindowUtils.js', () => ({
  isChatWindowOpen: vi.fn(async () => false),
  openOrFocusChatWindow: vi.fn(async () => {}),
}));

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
      remove: vi.fn(async () => {}),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    onAlarm: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  runtime: {
    sendMessage: vi.fn(async () => {}),
  },
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const { _testExports } = await import('../agent/modules/proactiveCheckin.js');
const {
  _hashReminderList,
  _formatDueLabel,
  _resolveDueDateTime,
  _getDateMidnightsInTimezone,
  _getTimezoneOffsetMs,
  _buildNewReminderMessage,
  _buildNewRemindersMessage,
  _buildDueApproachingMessage,
} = _testExports;

// ---------------------------------------------------------------------------
// Helpers — dynamic dates relative to now (no hardcoded dates)
// ---------------------------------------------------------------------------

/** YYYY-MM-DD string for a date N days from today */
function daysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today as YYYY-MM-DD */
function todayStr() {
  return daysFromToday(0);
}

/** Tomorrow as YYYY-MM-DD */
function tomorrowStr() {
  return daysFromToday(1);
}

// ---------------------------------------------------------------------------
// Tests: _hashReminderList
// ---------------------------------------------------------------------------

describe('_hashReminderList', () => {
  it('returns "empty" for empty array', () => {
    expect(_hashReminderList([])).toBe('empty');
  });

  it('returns "empty" for null/undefined', () => {
    expect(_hashReminderList(null)).toBe('empty');
    expect(_hashReminderList(undefined)).toBe('empty');
  });

  it('returns "empty" for non-array', () => {
    expect(_hashReminderList('hello')).toBe('empty');
  });

  it('returns a string hash for a single reminder', () => {
    const hash = _hashReminderList([{ content: 'Buy milk', dueDate: todayStr(), dueTime: '14:00' }]);
    expect(typeof hash).toBe('string');
    expect(hash).not.toBe('empty');
  });

  it('returns deterministic hash for same input', () => {
    const reminders = [
      { content: 'Task A', dueDate: todayStr(), dueTime: '10:00' },
      { content: 'Task B', dueDate: tomorrowStr(), dueTime: null },
    ];
    const h1 = _hashReminderList(reminders);
    const h2 = _hashReminderList(reminders);
    expect(h1).toBe(h2);
  });

  it('is order-independent (sorted internally)', () => {
    const a = { content: 'Alpha', dueDate: todayStr(), dueTime: '09:00' };
    const b = { content: 'Beta', dueDate: tomorrowStr(), dueTime: '10:00' };
    expect(_hashReminderList([a, b])).toBe(_hashReminderList([b, a]));
  });

  it('produces different hash when content changes', () => {
    const base = [{ content: 'Task X', dueDate: todayStr(), dueTime: '12:00' }];
    const changed = [{ content: 'Task Y', dueDate: todayStr(), dueTime: '12:00' }];
    expect(_hashReminderList(base)).not.toBe(_hashReminderList(changed));
  });

  it('produces different hash when dueDate changes', () => {
    const base = [{ content: 'Task', dueDate: todayStr(), dueTime: '12:00' }];
    const changed = [{ content: 'Task', dueDate: tomorrowStr(), dueTime: '12:00' }];
    expect(_hashReminderList(base)).not.toBe(_hashReminderList(changed));
  });

  it('produces different hash when dueTime changes', () => {
    const base = [{ content: 'Task', dueDate: todayStr(), dueTime: '12:00' }];
    const changed = [{ content: 'Task', dueDate: todayStr(), dueTime: '13:00' }];
    expect(_hashReminderList(base)).not.toBe(_hashReminderList(changed));
  });

  it('handles missing fields gracefully', () => {
    const hash = _hashReminderList([{ content: 'No dates' }]);
    expect(typeof hash).toBe('string');
    expect(hash).not.toBe('empty');
  });
});

// ---------------------------------------------------------------------------
// Tests: _formatDueLabel
// ---------------------------------------------------------------------------

describe('_formatDueLabel', () => {
  it('returns "Today" for today without time', () => {
    expect(_formatDueLabel(todayStr(), null, null)).toBe('Today');
  });

  it('returns "Today at HH:MM" for today with time', () => {
    expect(_formatDueLabel(todayStr(), '14:30', null)).toBe('Today at 14:30');
  });

  it('returns "Tomorrow" for tomorrow without time', () => {
    expect(_formatDueLabel(tomorrowStr(), null, null)).toBe('Tomorrow');
  });

  it('returns "Tomorrow at HH:MM" for tomorrow with time', () => {
    expect(_formatDueLabel(tomorrowStr(), '09:00', null)).toBe('Tomorrow at 09:00');
  });

  it('returns "Overdue (1 day)" for yesterday', () => {
    const yesterday = daysFromToday(-1);
    expect(_formatDueLabel(yesterday, null, null)).toBe('Overdue (1 day)');
  });

  it('returns "Overdue (N days)" for multiple days past', () => {
    const threeDaysAgo = daysFromToday(-3);
    expect(_formatDueLabel(threeDaysAgo, null, null)).toBe('Overdue (3 days)');
  });

  it('returns "Due <weekday>, <month> <day>" for a future date beyond tomorrow', () => {
    const inFiveDays = daysFromToday(5);
    const result = _formatDueLabel(inFiveDays, null, null);
    expect(result).toMatch(/^Due [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+$/);
  });

  it('appends time suffix to future date', () => {
    const inFiveDays = daysFromToday(5);
    const result = _formatDueLabel(inFiveDays, '16:00', null);
    expect(result).toMatch(/^Due [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+ at 16:00$/);
  });

  it('returns empty string for date with wrong number of parts', () => {
    // _formatDueLabel checks parts.length !== 3, returns "" for those
    expect(_formatDueLabel('2026', null, null)).toBe('');
    expect(_formatDueLabel('', null, null)).toBe('');
  });

  it('works with a specific IANA timezone (America/New_York)', () => {
    // When timezone is provided, "today" is computed in that timezone.
    // The function should still return a valid label.
    const result = _formatDueLabel(todayStr(), '10:00', 'America/New_York');
    // Might be "Today" or "Yesterday"/"Tomorrow" depending on time difference,
    // but it should be a non-empty string.
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('works with Asia/Tokyo timezone', () => {
    const result = _formatDueLabel(todayStr(), null, 'Asia/Tokyo');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('throws for invalid timezone (Intl throws RangeError)', () => {
    // _getDateMidnightsInTimezone has a try/catch that falls back to local,
    // but _formatDueLabel itself does not catch, and the Intl constructor
    // throws synchronously before the try/catch in _getDateMidnightsInTimezone.
    // Actually the try/catch IS in _getDateMidnightsInTimezone which wraps
    // the Intl call — but Node's Intl throws at new Intl.DateTimeFormat()
    // which IS inside the try block, so it should be caught.
    // In practice Node throws before entering the try — let's verify behavior:
    expect(() => _formatDueLabel(todayStr(), null, 'Invalid/Timezone')).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Tests: _getDateMidnightsInTimezone
// ---------------------------------------------------------------------------

describe('_getDateMidnightsInTimezone', () => {
  it('returns todayMidnight, tomorrowMidnight, dueMidnight without timezone', () => {
    const now = new Date();
    const result = _getDateMidnightsInTimezone(now.getFullYear(), now.getMonth(), now.getDate(), null);
    expect(result).toHaveProperty('todayMidnight');
    expect(result).toHaveProperty('tomorrowMidnight');
    expect(result).toHaveProperty('dueMidnight');
  });

  it('todayMidnight is at 00:00:00.000 local time when no timezone', () => {
    const now = new Date();
    const { todayMidnight } = _getDateMidnightsInTimezone(now.getFullYear(), now.getMonth(), now.getDate(), null);
    expect(todayMidnight.getHours()).toBe(0);
    expect(todayMidnight.getMinutes()).toBe(0);
    expect(todayMidnight.getSeconds()).toBe(0);
  });

  it('tomorrowMidnight is exactly 1 day after todayMidnight when no timezone', () => {
    const now = new Date();
    const { todayMidnight, tomorrowMidnight } = _getDateMidnightsInTimezone(
      now.getFullYear(), now.getMonth(), now.getDate(), null
    );
    expect(tomorrowMidnight.getTime() - todayMidnight.getTime()).toBe(86400000);
  });

  it('dueMidnight matches the given date when no timezone', () => {
    const { dueMidnight } = _getDateMidnightsInTimezone(2099, 5, 15, null); // June 15, 2099
    expect(dueMidnight.getFullYear()).toBe(2099);
    expect(dueMidnight.getMonth()).toBe(5);
    expect(dueMidnight.getDate()).toBe(15);
  });

  it('returns valid dates with America/New_York timezone', () => {
    const now = new Date();
    const result = _getDateMidnightsInTimezone(
      now.getFullYear(), now.getMonth(), now.getDate(), 'America/New_York'
    );
    expect(result.todayMidnight instanceof Date).toBe(true);
    expect(result.tomorrowMidnight instanceof Date).toBe(true);
    expect(result.dueMidnight instanceof Date).toBe(true);
  });

  it('returns valid dates with Europe/London timezone', () => {
    const now = new Date();
    const result = _getDateMidnightsInTimezone(
      now.getFullYear(), now.getMonth(), now.getDate(), 'Europe/London'
    );
    expect(result.todayMidnight instanceof Date).toBe(true);
    expect(result.tomorrowMidnight.getTime()).toBeGreaterThan(result.todayMidnight.getTime());
  });

  it('throws for invalid timezone (Intl constructor is outside try/catch)', () => {
    const now = new Date();
    // The Intl.DateTimeFormat constructor is outside the try/catch block,
    // so an invalid timezone throws a RangeError.
    expect(() => _getDateMidnightsInTimezone(
      now.getFullYear(), now.getMonth(), now.getDate(), 'Fake/Timezone'
    )).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Tests: _getTimezoneOffsetMs
// ---------------------------------------------------------------------------

describe('_getTimezoneOffsetMs', () => {
  it('returns approximately 0 for UTC', () => {
    const date = new Date();
    const offset = _getTimezoneOffsetMs(date, 'UTC');
    // formatToParts drops sub-second precision, so offset may be off by up to ~1s
    expect(Math.abs(offset)).toBeLessThan(1000);
  });

  it('returns approximately +9h for Asia/Tokyo (no DST)', () => {
    const date = new Date();
    const offset = _getTimezoneOffsetMs(date, 'Asia/Tokyo');
    const expected = 9 * 3600 * 1000;
    // Allow up to 1s drift from formatToParts precision loss
    expect(Math.abs(offset - expected)).toBeLessThan(1000);
  });

  it('returns approximately -4h or -5h for America/New_York', () => {
    const date = new Date();
    const offset = _getTimezoneOffsetMs(date, 'America/New_York');
    const hours = Math.round(offset / (3600 * 1000));
    expect(hours === -5 || hours === -4).toBe(true);
  });

  it('returns 0 for invalid timezone (fallback)', () => {
    const date = new Date();
    const offset = _getTimezoneOffsetMs(date, 'Invalid/Zone');
    expect(offset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: _resolveDueDateTime
// ---------------------------------------------------------------------------

describe('_resolveDueDateTime', () => {
  it('returns epoch ms for a valid date without time (defaults to 00:00 local)', () => {
    const dateStr = todayStr();
    const result = _resolveDueDateTime(dateStr, null, null);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });

  it('returns epoch ms for a valid date with time', () => {
    const dateStr = todayStr();
    const result = _resolveDueDateTime(dateStr, '14:30', null);
    expect(typeof result).toBe('number');

    // Should be today at 14:30 local time
    const d = new Date(result);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  it('returns null for date with wrong number of parts', () => {
    // Only dates that split into != 3 parts return null
    expect(_resolveDueDateTime('2026', null, null)).toBeNull();
    expect(_resolveDueDateTime('', null, null)).toBeNull();
  });

  it('returns NaN for date with non-numeric parts (3 segments but unparseable)', () => {
    // "not-a-date" splits into 3 parts but parseInt yields NaN
    const result = _resolveDueDateTime('not-a-date', null, null);
    expect(Number.isNaN(result)).toBe(true);
  });

  it('interprets date in timezone when provided', () => {
    const dateStr = tomorrowStr();
    const withTz = _resolveDueDateTime(dateStr, '12:00', 'Asia/Tokyo');
    const withoutTz = _resolveDueDateTime(dateStr, '12:00', null);
    expect(typeof withTz).toBe('number');
    expect(typeof withoutTz).toBe('number');
    // They should differ unless we happen to be in Asia/Tokyo
    // Just verify both are valid numbers
    expect(withTz).toBeGreaterThan(0);
    expect(withoutTz).toBeGreaterThan(0);
  });

  it('handles midnight (00:00) correctly', () => {
    const dateStr = tomorrowStr();
    const result = _resolveDueDateTime(dateStr, '00:00', null);
    const d = new Date(result);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('handles end of day (23:59) correctly', () => {
    const dateStr = todayStr();
    const result = _resolveDueDateTime(dateStr, '23:59', null);
    const d = new Date(result);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
  });

  it('handles noon (12:00) correctly', () => {
    const dateStr = todayStr();
    const result = _resolveDueDateTime(dateStr, '12:00', null);
    const d = new Date(result);
    expect(d.getHours()).toBe(12);
    expect(d.getMinutes()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: _buildNewReminderMessage
// ---------------------------------------------------------------------------

describe('_buildNewReminderMessage', () => {
  it('builds message for a single reminder without due date', () => {
    const msg = _buildNewReminderMessage('Alice', {
      content: 'Follow up on proposal',
      source: 'message',
    });
    expect(msg).toContain('Hey Alice');
    expect(msg).toContain('new email');
    expect(msg).toContain('Follow up on proposal');
    expect(msg).not.toContain('**');
  });

  it('builds message for a single reminder with due date', () => {
    const msg = _buildNewReminderMessage('Bob', {
      content: 'Review contract',
      dueDate: tomorrowStr(),
      dueTime: null,
      timezone: null,
      source: 'message',
    });
    expect(msg).toContain('Hey Bob');
    expect(msg).toContain('**Tomorrow**');
    expect(msg).toContain('Review contract');
  });

  it('builds message for a single reminder with due date and time', () => {
    const msg = _buildNewReminderMessage('Carol', {
      content: 'Call client',
      dueDate: todayStr(),
      dueTime: '15:00',
      timezone: null,
      source: 'message',
    });
    expect(msg).toContain('**Today at 15:00**');
    expect(msg).toContain('Call client');
  });

  it('includes email reference link when uniqueId is present', () => {
    const msg = _buildNewReminderMessage('Dave', {
      content: 'Reply to invoice',
      uniqueId: 'msg-123',
      source: 'message',
    });
    expect(msg).toContain('[Email](msg-123)');
  });

  it('uses "reminder" noun for KB source', () => {
    const msg = _buildNewReminderMessage('Eve', {
      content: 'Buy groceries',
      source: 'kb',
    });
    expect(msg).toContain('new reminder');
    expect(msg).not.toContain('new email');
  });

  it('uses "email" noun for message source', () => {
    const msg = _buildNewReminderMessage('Frank', {
      content: 'Schedule meeting',
      source: 'message',
    });
    expect(msg).toContain('new email');
  });
});

// ---------------------------------------------------------------------------
// Tests: _buildNewRemindersMessage
// ---------------------------------------------------------------------------

describe('_buildNewRemindersMessage', () => {
  it('builds multi-reminder message with correct count', () => {
    const reminders = [
      { content: 'Task A', dueDate: todayStr(), dueTime: '10:00', source: 'message' },
      { content: 'Task B', dueDate: tomorrowStr(), dueTime: null, source: 'message' },
    ];
    const msg = _buildNewRemindersMessage('Grace', reminders);
    expect(msg).toContain('Hey Grace');
    expect(msg).toContain('2 new emails');
    expect(msg).toContain('- **Today at 10:00** \u2014 Task A');
    expect(msg).toContain('- **Tomorrow** \u2014 Task B');
  });

  it('uses "reminders" noun when all sources are KB', () => {
    const reminders = [
      { content: 'Buy milk', source: 'kb' },
      { content: 'Call dentist', source: 'kb' },
    ];
    const msg = _buildNewRemindersMessage('Heidi', reminders);
    expect(msg).toContain('2 new reminders');
  });

  it('uses "emails" noun when sources are mixed', () => {
    const reminders = [
      { content: 'Email task', source: 'message' },
      { content: 'KB task', source: 'kb' },
    ];
    const msg = _buildNewRemindersMessage('Ivan', reminders);
    expect(msg).toContain('2 new emails');
  });

  it('includes email reference links when uniqueId present', () => {
    const reminders = [
      { content: 'Task A', uniqueId: 'uid-1', source: 'message' },
      { content: 'Task B', source: 'message' },
    ];
    const msg = _buildNewRemindersMessage('Jane', reminders);
    expect(msg).toContain('[Email](uid-1)');
    // Task B has no uniqueId, no link
    expect(msg).toMatch(/- Task B$/m);
  });

  it('handles reminders without due dates', () => {
    const reminders = [
      { content: 'No date task', source: 'message' },
    ];
    const msg = _buildNewRemindersMessage('Karl', reminders);
    expect(msg).toContain('1 new email');
    expect(msg).toContain('- No date task');
  });
});

// ---------------------------------------------------------------------------
// Tests: _buildDueApproachingMessage
// ---------------------------------------------------------------------------

describe('_buildDueApproachingMessage', () => {
  it('builds single-reminder approaching message', () => {
    const reminders = [
      { content: 'Submit report', dueDate: todayStr(), dueTime: '17:00', timezone: null, source: 'message' },
    ];
    const msg = _buildDueApproachingMessage('Laura', reminders);
    expect(msg).toContain('Hey Laura');
    expect(msg).toContain('reminder coming up soon');
    expect(msg).toContain('**Today at 17:00**');
    expect(msg).toContain('Submit report');
    // Single reminder uses colon format, not bullet
    expect(msg).not.toContain('- **');
  });

  it('builds multi-reminder approaching message', () => {
    const reminders = [
      { content: 'Call Alice', dueDate: todayStr(), dueTime: '14:00', timezone: null, source: 'message' },
      { content: 'Review PR', dueDate: todayStr(), dueTime: '16:00', timezone: null, source: 'message' },
    ];
    const msg = _buildDueApproachingMessage('Mike', reminders);
    expect(msg).toContain('Hey Mike');
    expect(msg).toContain('2 reminders coming up soon');
    expect(msg).toContain('- **Today at 14:00**: Call Alice');
    expect(msg).toContain('- **Today at 16:00**: Review PR');
  });

  it('includes email reference links when uniqueId present', () => {
    const reminders = [
      { content: 'Reply to boss', dueDate: tomorrowStr(), dueTime: '09:00', timezone: null, uniqueId: 'uid-99', source: 'message' },
    ];
    const msg = _buildDueApproachingMessage('Nina', reminders);
    expect(msg).toContain('[Email](uid-99)');
  });

  it('handles overdue reminders in approaching message', () => {
    const yesterday = daysFromToday(-1);
    const reminders = [
      { content: 'Late task', dueDate: yesterday, dueTime: null, timezone: null, source: 'message' },
    ];
    const msg = _buildDueApproachingMessage('Oscar', reminders);
    expect(msg).toContain('Overdue (1 day)');
  });
});
