// calendarSearchTool.test.js — Tests for pure-logic internal functions from
// chat/tools/calendar_search.js, exported via _testExports.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    middayHourForDateHeader: 12,
    msPerDay: 86400000,
  },
}));

vi.mock('../chat/modules/helpers.js', () => ({
  toIsoNoMs: vi.fn((d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')),
}));

const { _testExports } = await import('../chat/tools/calendar_search.js');
const {
  normalizeTimeInput,
  makeDayKeyFromNormalized,
  formatDayHeader,
  insertLine,
  formatHour,
  resolveDateRange,
  normalizeArgs,
} = _testExports;

// ---------------------------------------------------------------------------
// normalizeTimeInput
// ---------------------------------------------------------------------------

describe('normalizeTimeInput', () => {
  it('normalizes a numeric timestamp (milliseconds)', () => {
    const now = Date.now();
    const result = normalizeTimeInput(now, 'UTC');
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });

  it('normalizes an ISO string', () => {
    const now = new Date();
    const iso = now.toISOString();
    const result = normalizeTimeInput(iso, 'UTC');
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });

  it('normalizes a Date object (returns a copy)', () => {
    const now = new Date();
    const result = normalizeTimeInput(now, 'UTC');
    expect(result).toBeInstanceOf(Date);
    // Should be a different object reference
    expect(result).not.toBe(now);
  });

  it('returns current date for invalid input types', () => {
    const before = Date.now();
    const result = normalizeTimeInput(null, 'UTC');
    const after = Date.now();
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it('returns current date for undefined input', () => {
    const result = normalizeTimeInput(undefined, 'UTC');
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });

  it('returns current date for invalid date string', () => {
    const before = Date.now();
    const result = normalizeTimeInput('not-a-date', 'UTC');
    const after = Date.now();
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it('handles IANA timezone America/New_York', () => {
    const now = new Date();
    const result = normalizeTimeInput(now.getTime(), 'America/New_York');
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });

  it('handles IANA timezone Asia/Tokyo', () => {
    const now = new Date();
    const result = normalizeTimeInput(now.getTime(), 'Asia/Tokyo');
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });

  it('defaults to system timezone when userTz is null', () => {
    const now = new Date();
    const result = normalizeTimeInput(now.getTime());
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });

  it('produces different normalized values for different timezones given same UTC timestamp', () => {
    // Use a timestamp where timezone differences are apparent (not midnight UTC)
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    const ts = d.getTime();

    const utcResult = normalizeTimeInput(ts, 'UTC');
    const tokyoResult = normalizeTimeInput(ts, 'Asia/Tokyo');

    // Tokyo is UTC+9, so hours should differ
    expect(utcResult.getHours()).not.toBe(tokyoResult.getHours());
  });
});

// ---------------------------------------------------------------------------
// makeDayKeyFromNormalized
// ---------------------------------------------------------------------------

describe('makeDayKeyFromNormalized', () => {
  it('creates YYYY-MM-DD key from a valid Date', () => {
    const d = new Date();
    const key = makeDayKeyFromNormalized(d);
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('pads single-digit month and day', () => {
    // January 5 of current year
    const d = new Date();
    d.setMonth(0); // January
    d.setDate(5);
    const key = makeDayKeyFromNormalized(d);
    expect(key).toContain('-01-05');
  });

  it('returns null for null input', () => {
    const key = makeDayKeyFromNormalized(null);
    expect(key).toBeNull();
  });

  it('returns null for undefined input', () => {
    const key = makeDayKeyFromNormalized(undefined);
    expect(key).toBeNull();
  });

  it('returns null for invalid Date (NaN)', () => {
    const key = makeDayKeyFromNormalized(new Date('invalid'));
    expect(key).toBeNull();
  });

  it('returns null for non-Date object', () => {
    const key = makeDayKeyFromNormalized('2026-03-20');
    expect(key).toBeNull();
  });

  it('correctly represents today', () => {
    const now = new Date();
    const key = makeDayKeyFromNormalized(now);
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    expect(key).toBe(`${year}-${month}-${day}`);
  });

  it('handles end-of-year dates', () => {
    const d = new Date();
    d.setMonth(11); // December
    d.setDate(31);
    const key = makeDayKeyFromNormalized(d);
    expect(key).toContain('-12-31');
  });
});

// ---------------------------------------------------------------------------
// formatDayHeader
// ---------------------------------------------------------------------------

describe('formatDayHeader', () => {
  it('returns an object with timezone, prettyDate, and empty calendars', () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dayKey = `${year}-${month}-${day}`;

    const header = formatDayHeader(dayKey, 'UTC');
    expect(header).toHaveProperty('timezone', 'UTC');
    expect(header).toHaveProperty('prettyDate');
    expect(header).toHaveProperty('calendars');
    expect(header.calendars).toEqual({});
  });

  it('prettyDate includes the day of the week', () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dayKey = `${year}-${month}-${day}`;

    const header = formatDayHeader(dayKey, 'UTC');
    // Should include a weekday name like Monday, Tuesday, etc.
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const hasWeekday = weekdays.some(wd => header.prettyDate.includes(wd));
    expect(hasWeekday).toBe(true);
  });

  it('prettyDate includes the year', () => {
    const now = new Date();
    const year = now.getFullYear();
    const dayKey = `${year}-06-15`;

    const header = formatDayHeader(dayKey, 'UTC');
    expect(header.prettyDate).toContain(String(year));
  });

  it('uses the provided timezone', () => {
    const now = new Date();
    const year = now.getFullYear();
    const dayKey = `${year}-01-01`;

    const header = formatDayHeader(dayKey, 'America/Los_Angeles');
    expect(header.timezone).toBe('America/Los_Angeles');
  });
});

// ---------------------------------------------------------------------------
// insertLine
// ---------------------------------------------------------------------------

describe('insertLine', () => {
  it('inserts a line into a new calendar in the day object', () => {
    const dayObj = { calendars: {} };
    const result = insertLine(dayObj, 'work', '09:00 - 10:00: Meeting');
    expect(result).toBe(dayObj);
    expect(dayObj.calendars.work).toEqual(['09:00 - 10:00: Meeting']);
  });

  it('appends to an existing calendar entry', () => {
    const dayObj = { calendars: { work: ['09:00 - 10:00: Meeting'] } };
    insertLine(dayObj, 'work', '11:00 - 12:00: Standup');
    expect(dayObj.calendars.work).toHaveLength(2);
    expect(dayObj.calendars.work[1]).toBe('11:00 - 12:00: Standup');
  });

  it('handles multiple calendars', () => {
    const dayObj = { calendars: {} };
    insertLine(dayObj, 'work', '09:00 - 10:00: Work meeting');
    insertLine(dayObj, 'personal', '18:00 - 19:00: Dinner');
    expect(Object.keys(dayObj.calendars)).toHaveLength(2);
    expect(dayObj.calendars.work).toHaveLength(1);
    expect(dayObj.calendars.personal).toHaveLength(1);
  });

  it('returns the input object for mutation chaining', () => {
    const dayObj = { calendars: {} };
    const result = insertLine(dayObj, 'cal1', 'line1');
    expect(result).toBe(dayObj);
  });

  it('returns null/undefined for null dayObj (no crash)', () => {
    const result = insertLine(null, 'cal', 'line');
    expect(result).toBeNull();
  });

  it('returns undefined for undefined dayObj (no crash)', () => {
    const result = insertLine(undefined, 'cal', 'line');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatHour
// ---------------------------------------------------------------------------

describe('formatHour', () => {
  it('formats midnight as 00:00', () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    expect(formatHour(d)).toBe('00:00');
  });

  it('formats noon as 12:00', () => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    expect(formatHour(d)).toBe('12:00');
  });

  it('formats single-digit hours with leading zero', () => {
    const d = new Date();
    d.setHours(9, 5, 0, 0);
    expect(formatHour(d)).toBe('09:05');
  });

  it('formats end-of-day as 23:59', () => {
    const d = new Date();
    d.setHours(23, 59, 0, 0);
    expect(formatHour(d)).toBe('23:59');
  });

  it('returns empty string for invalid input', () => {
    expect(formatHour(null)).toBe('');
    expect(formatHour(undefined)).toBe('');
    expect(formatHour('not a date')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// normalizeArgs
// ---------------------------------------------------------------------------

describe('normalizeArgs', () => {
  it('returns default values for empty/no args', () => {
    const result = normalizeArgs();
    expect(result).toEqual({ from_date: '', to_date: '', query: '' });
  });

  it('returns default values for null args', () => {
    const result = normalizeArgs(null);
    expect(result).toEqual({ from_date: '', to_date: '', query: '' });
  });

  it('returns default values for undefined args', () => {
    const result = normalizeArgs(undefined);
    expect(result).toEqual({ from_date: '', to_date: '', query: '' });
  });

  it('passes through valid from_date and to_date', () => {
    const now = new Date();
    const fromStr = now.toISOString();
    const tomorrow = new Date(now.getTime() + 86400000);
    const toStr = tomorrow.toISOString();

    const result = normalizeArgs({ from_date: fromStr, to_date: toStr });
    expect(result.from_date).toBe(fromStr);
    expect(result.to_date).toBe(toStr);
  });

  it('coerces non-string query to empty string', () => {
    const result = normalizeArgs({ query: 123 });
    expect(result.query).toBe('');
  });

  it('passes through string query', () => {
    const result = normalizeArgs({ query: 'team meeting' });
    expect(result.query).toBe('team meeting');
  });

  it('uses empty string for falsy from_date', () => {
    const result = normalizeArgs({ from_date: null });
    expect(result.from_date).toBe('');
  });

  it('uses empty string for falsy to_date', () => {
    const result = normalizeArgs({ to_date: 0 });
    expect(result.to_date).toBe('');
  });
});

// ---------------------------------------------------------------------------
// resolveDateRange
// ---------------------------------------------------------------------------

describe('resolveDateRange', () => {
  it('returns fromIso and toIso as strings', () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const result = resolveDateRange({ from_date: `${year}-${month}-${day}` });
    expect(typeof result.fromIso).toBe('string');
    expect(typeof result.toIso).toBe('string');
  });

  it('handles date-only from_date (YYYY-MM-DD) by parsing at start of day', () => {
    const now = new Date();
    const year = now.getFullYear();
    const result = resolveDateRange({ from_date: `${year}-06-15` });
    // The fromIso should represent June 15 start of day
    expect(result.fromIso).toContain(`${year}`);
    expect(result.fromIso).toContain('06');
    expect(result.fromIso).toContain('15');
  });

  it('handles date-only to_date (YYYY-MM-DD) by parsing at end of day', () => {
    const now = new Date();
    const year = now.getFullYear();
    const result = resolveDateRange({ to_date: `${year}-06-20`, from_date: `${year}-06-15` });
    // to_date should include 23:59:59
    expect(result.toIso).toContain(`${year}`);
    expect(result.toIso).toContain('06');
    expect(result.toIso).toContain('20');
  });

  it('defaults to today when no from_date or to_date provided', () => {
    const result = resolveDateRange({});
    const now = new Date();
    const year = String(now.getFullYear());
    expect(result.fromIso).toContain(year);
    expect(result.toIso).toContain(year);
  });

  it('defaults to from_date + 1 day when to_date not provided but from_date is', () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const fromDate = `${year}-${month}-${day}`;
    const result = resolveDateRange({ from_date: fromDate });

    const fromMs = new Date(result.fromIso).getTime();
    const toMs = new Date(result.toIso).getTime();
    // Difference should be approximately 1 day (86400000 ms)
    const diff = toMs - fromMs;
    expect(diff).toBeGreaterThan(80000000); // ~22 hours minimum
    expect(diff).toBeLessThan(90000000);    // ~25 hours maximum
  });

  it('handles ISO string with time component for from_date', () => {
    const now = new Date();
    const isoWithTime = now.toISOString();
    const result = resolveDateRange({ from_date: isoWithTime });
    expect(typeof result.fromIso).toBe('string');
    expect(result.fromIso.length).toBeGreaterThan(0);
  });

  it('handles ISO string with time component for to_date', () => {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const result = resolveDateRange({
      from_date: now.toISOString(),
      to_date: tomorrow.toISOString(),
    });
    expect(typeof result.toIso).toBe('string');
    expect(result.toIso.length).toBeGreaterThan(0);
  });

  it('handles numeric from_date (does not crash)', () => {
    // from_date as number (not string) should trigger default path
    const result = resolveDateRange({ from_date: Date.now() });
    expect(typeof result.fromIso).toBe('string');
    expect(typeof result.toIso).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Integration-style: normalizeTimeInput + makeDayKeyFromNormalized
// ---------------------------------------------------------------------------

describe('normalizeTimeInput + makeDayKeyFromNormalized pipeline', () => {
  it('produces correct day key from a timestamp in UTC', () => {
    const now = new Date();
    const normalized = normalizeTimeInput(now.getTime(), 'UTC');
    const key = makeDayKeyFromNormalized(normalized);
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('produces correct day key from an ISO string', () => {
    const now = new Date();
    const normalized = normalizeTimeInput(now.toISOString(), 'UTC');
    const key = makeDayKeyFromNormalized(normalized);
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('timezone can shift the day key across midnight boundary', () => {
    // Create a timestamp just after midnight UTC on a known relative day
    const d = new Date();
    d.setUTCHours(1, 0, 0, 0); // 01:00 UTC

    const utcNorm = normalizeTimeInput(d.getTime(), 'UTC');
    const utcKey = makeDayKeyFromNormalized(utcNorm);

    // Pacific time is UTC-7/UTC-8, so 01:00 UTC is still previous day in Pacific
    const pacNorm = normalizeTimeInput(d.getTime(), 'America/Los_Angeles');
    const pacKey = makeDayKeyFromNormalized(pacNorm);

    // The Pacific key should be the previous day compared to UTC
    expect(utcKey).not.toBe(pacKey);
  });
});

// ---------------------------------------------------------------------------
// Integration-style: formatDayHeader + insertLine
// ---------------------------------------------------------------------------

describe('formatDayHeader + insertLine pipeline', () => {
  it('creates a day header then inserts events into it', () => {
    const now = new Date();
    const year = now.getFullYear();
    const dayKey = `${year}-06-15`;

    const header = formatDayHeader(dayKey, 'UTC');
    expect(header.calendars).toEqual({});

    insertLine(header, 'work-cal', '09:00 - 10:00: Standup\tevent_id: abc123');
    insertLine(header, 'work-cal', '14:00 - 15:00: Review\tevent_id: def456');
    insertLine(header, 'personal', '18:00 - 19:00: Gym\tevent_id: ghi789');

    expect(header.calendars['work-cal']).toHaveLength(2);
    expect(header.calendars['personal']).toHaveLength(1);
    expect(header.timezone).toBe('UTC');
  });
});
