// calendarEventReadHelpers.test.js — Tests for pure functions in chat/tools/calendar_event_read.js

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    calendarEntryMatchToleranceMs: 60000,
  },
}));

vi.mock('../chat/modules/helpers.js', () => ({
  toNaiveIso: vi.fn((ms) => new Date(ms).toISOString()),
}));

globalThis.browser = {
  tmCalendar: {
    listCalendars: vi.fn(async () => []),
    queryCalendarItems: vi.fn(async () => []),
    getCalendarEventDetails: vi.fn(async () => ({ ok: false })),
  },
};

const { _testExports } = await import('../chat/tools/calendar_event_read.js');
const { safeGetCalendarName, isWithinTolerance, buildAttendeeLines, formatFromDetails, normalizeDate } = _testExports;

// ---------------------------------------------------------------------------
// safeGetCalendarName
// ---------------------------------------------------------------------------

describe('safeGetCalendarName', () => {
  it('finds calendar by id and returns its name', () => {
    const cals = [
      { id: 'cal-1', name: 'Work Calendar' },
      { id: 'cal-2', name: 'Personal' },
    ];
    expect(safeGetCalendarName(cals, 'cal-1')).toBe('Work Calendar');
  });

  it('returns title when name is not present', () => {
    const cals = [{ id: 'cal-3', title: 'My Events' }];
    expect(safeGetCalendarName(cals, 'cal-3')).toBe('My Events');
  });

  it('returns id as string when calendar has only id', () => {
    const cals = [{ id: 'cal-4' }];
    expect(safeGetCalendarName(cals, 'cal-4')).toBe('cal-4');
  });

  it('returns id as string when no matching calendar found', () => {
    const cals = [{ id: 'cal-1', name: 'Work' }];
    expect(safeGetCalendarName(cals, 'nonexistent')).toBe('nonexistent');
  });

  it('returns id as string when cals is null', () => {
    expect(safeGetCalendarName(null, 'cal-1')).toBe('cal-1');
  });

  it('returns id as string when cals is undefined', () => {
    expect(safeGetCalendarName(undefined, 'some-id')).toBe('some-id');
  });

  it('returns empty string when id is null', () => {
    expect(safeGetCalendarName([], null)).toBe('');
  });

  it('returns empty string when id is undefined', () => {
    expect(safeGetCalendarName([], undefined)).toBe('');
  });

  it('returns id as string for numeric id', () => {
    const cals = [{ id: 42, name: 'Numbered' }];
    // id is compared with === so numeric 42 matches
    expect(safeGetCalendarName(cals, 42)).toBe('Numbered');
  });

  it('returns empty string when both cals and id are null', () => {
    expect(safeGetCalendarName(null, null)).toBe('');
  });

  it('returns id as string when cals is an empty array', () => {
    expect(safeGetCalendarName([], 'my-cal')).toBe('my-cal');
  });

  it('prefers name over title when both are present', () => {
    const cals = [{ id: 'cal-5', name: 'Name Value', title: 'Title Value' }];
    expect(safeGetCalendarName(cals, 'cal-5')).toBe('Name Value');
  });
});

// ---------------------------------------------------------------------------
// isWithinTolerance
// ---------------------------------------------------------------------------

describe('isWithinTolerance', () => {
  it('returns true when dates are equal', () => {
    const now = new Date();
    expect(isWithinTolerance(now, new Date(now.getTime()), 1000)).toBe(true);
  });

  it('returns true when difference is exactly at tolerance', () => {
    const a = new Date();
    const b = new Date(a.getTime() + 5000);
    expect(isWithinTolerance(a, b, 5000)).toBe(true);
  });

  it('returns false when difference exceeds tolerance', () => {
    const a = new Date();
    const b = new Date(a.getTime() + 5001);
    expect(isWithinTolerance(a, b, 5000)).toBe(false);
  });

  it('works regardless of order (a before b)', () => {
    const a = new Date();
    const b = new Date(a.getTime() - 3000);
    expect(isWithinTolerance(a, b, 3000)).toBe(true);
  });

  it('returns true for zero tolerance with identical dates', () => {
    const d = new Date();
    expect(isWithinTolerance(d, new Date(d.getTime()), 0)).toBe(true);
  });

  it('returns false for zero tolerance with different dates', () => {
    const a = new Date();
    const b = new Date(a.getTime() + 1);
    expect(isWithinTolerance(a, b, 0)).toBe(false);
  });

  it('returns false for invalid date inputs', () => {
    expect(isWithinTolerance('not-a-date', new Date(), 1000)).toBe(false);
    expect(isWithinTolerance(null, new Date(), 1000)).toBe(false);
  });

  it('handles large tolerance values', () => {
    const a = new Date();
    const b = new Date(a.getTime() + 86400000); // 1 day apart
    expect(isWithinTolerance(a, b, 86400000)).toBe(true);
    expect(isWithinTolerance(a, b, 86399999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildAttendeeLines — attendee formatting
// ---------------------------------------------------------------------------
describe('buildAttendeeLines', () => {
  it('returns empty array when no attendeeList or attendees', () => {
    expect(buildAttendeeLines({})).toEqual([]);
  });

  it('formats attendeeList with name and email', () => {
    const lines = buildAttendeeLines({
      attendeeList: [{ name: 'Alice', email: 'alice@example.com' }],
    });
    expect(lines).toEqual(['Alice <alice@example.com>']);
  });

  it('strips mailto: prefix from attendeeList email', () => {
    const lines = buildAttendeeLines({
      attendeeList: [{ name: 'Bob', email: 'mailto:bob@example.com' }],
    });
    expect(lines).toEqual(['Bob <bob@example.com>']);
  });

  it('falls back to id field for email in attendeeList', () => {
    const lines = buildAttendeeLines({
      attendeeList: [{ name: 'Carol', id: 'mailto:carol@example.com' }],
    });
    expect(lines).toEqual(['Carol <carol@example.com>']);
  });

  it('falls back to mail field for email in attendeeList', () => {
    const lines = buildAttendeeLines({
      attendeeList: [{ mail: 'dave@example.com' }],
    });
    expect(lines).toEqual(['<dave@example.com>']);
  });

  it('falls back to address field for email in attendeeList', () => {
    const lines = buildAttendeeLines({
      attendeeList: [{ address: 'mailto:eve@example.com' }],
    });
    expect(lines).toEqual(['<eve@example.com>']);
  });

  it('includes role and participationStatus in attendeeList', () => {
    const lines = buildAttendeeLines({
      attendeeList: [{ name: 'Frank', email: 'frank@example.com', role: 'REQ-PARTICIPANT', participationStatus: 'ACCEPTED' }],
    });
    expect(lines).toEqual(['Frank <frank@example.com> (REQ-PARTICIPANT, ACCEPTED)']);
  });

  it('uses participationRole and status as fallbacks', () => {
    const lines = buildAttendeeLines({
      attendeeList: [{ email: 'g@example.com', participationRole: 'CHAIR', status: 'TENTATIVE' }],
    });
    expect(lines).toEqual(['<g@example.com> (CHAIR, TENTATIVE)']);
  });

  it('handles attendeeList entry with no name and no email', () => {
    const lines = buildAttendeeLines({
      attendeeList: [{}],
    });
    // No name, no email, no role → empty base, no extra
    expect(lines).toEqual(['']);
  });

  it('formats attendees as string array', () => {
    const lines = buildAttendeeLines({
      attendees: ['mailto:a@example.com', 'b@example.com'],
    });
    expect(lines).toEqual(['a@example.com', 'b@example.com']);
  });

  it('formats attendees as object array with name and email', () => {
    const lines = buildAttendeeLines({
      attendees: [{ name: 'Zach', email: 'zach@example.com' }],
    });
    expect(lines).toEqual(['Zach <zach@example.com>']);
  });

  it('formats attendees object with id field', () => {
    const lines = buildAttendeeLines({
      attendees: [{ id: 'mailto:x@example.com' }],
    });
    expect(lines).toEqual(['<x@example.com>']);
  });

  it('formats attendees object with mail field', () => {
    const lines = buildAttendeeLines({
      attendees: [{ mail: 'y@example.com' }],
    });
    expect(lines).toEqual(['<y@example.com>']);
  });

  it('formats attendees object with address field', () => {
    const lines = buildAttendeeLines({
      attendees: [{ address: 'z@example.com' }],
    });
    expect(lines).toEqual(['<z@example.com>']);
  });

  it('formats attendees object with displayName', () => {
    const lines = buildAttendeeLines({
      attendees: [{ displayName: 'Display' }],
    });
    expect(lines).toEqual(['Display']);
  });

  it('JSON.stringifies attendees object with no known fields', () => {
    const lines = buildAttendeeLines({
      attendees: [{ unknownProp: 'val' }],
    });
    expect(lines[0]).toContain('unknownProp');
  });

  it('returns empty array on thrown error', () => {
    // Force an error by passing something that will throw during iteration
    const bad = { get attendeeList() { throw new Error('boom'); } };
    expect(buildAttendeeLines(bad)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatFromDetails — event detail formatting
// ---------------------------------------------------------------------------
describe('formatFromDetails', () => {
  it('formats minimal event details', () => {
    const result = formatFromDetails({ calendarId: 'cal1', id: 'evt1' });
    expect(result).toContain('calendar_id: cal1');
    expect(result).toContain('event_id: evt1');
    expect(result).toContain('title: (No title)');
    expect(result).toContain('all_day: no');
  });

  it('formats event with title', () => {
    const result = formatFromDetails({ calendarId: 'c', id: 'e', title: 'Meeting' });
    expect(result).toContain('title: Meeting');
  });

  it('formats start and end times', () => {
    const now = Date.now();
    const result = formatFromDetails({ calendarId: 'c', id: 'e', start: now, end: now + 3600000 });
    expect(result).toContain('start_iso:');
    expect(result).toContain('end_iso:');
  });

  it('formats all-day event', () => {
    const result = formatFromDetails({ calendarId: 'c', id: 'e', isAllDay: true });
    expect(result).toContain('all_day: yes');
  });

  it('formats recurring event with RRULE', () => {
    const result = formatFromDetails({ calendarId: 'c', id: 'e', isRecurring: true, recurrenceRRule: 'FREQ=WEEKLY' });
    expect(result).toContain('recurring: yes');
    expect(result).toContain('RRULE: FREQ=WEEKLY');
  });

  it('formats location', () => {
    const result = formatFromDetails({ calendarId: 'c', id: 'e', location: 'Room 42' });
    expect(result).toContain('Location: Room 42');
  });

  it('formats organizer and strips mailto: prefix', () => {
    const result = formatFromDetails({ calendarId: 'c', id: 'e', organizer: 'mailto:boss@example.com' });
    expect(result).toContain('Organizer: boss@example.com');
  });

  it('formats transparency', () => {
    const result = formatFromDetails({ calendarId: 'c', id: 'e', transparency: 'opaque' });
    expect(result).toContain('transparency: opaque');
  });

  it('formats attendeeList in details', () => {
    const result = formatFromDetails({
      calendarId: 'c', id: 'e',
      attendeeList: [{ name: 'Ann', email: 'ann@example.com', status: 'ACCEPTED' }],
    });
    expect(result).toContain('attendees:');
    expect(result).toContain('Ann <ann@example.com> (ACCEPTED)');
  });

  it('formats numeric attendees count when no attendeeList', () => {
    const result = formatFromDetails({ calendarId: 'c', id: 'e', attendees: 5 });
    expect(result).toContain('attendees: 5');
  });

  it('does not show attendees line for zero count', () => {
    const result = formatFromDetails({ calendarId: 'c', id: 'e', attendees: 0 });
    expect(result).not.toContain('attendees:');
  });

  it('does not include recurring line when not recurring', () => {
    const result = formatFromDetails({ calendarId: 'c', id: 'e', isRecurring: false });
    expect(result).not.toContain('recurring:');
  });

  it('handles attendeeList entry with email only (no name)', () => {
    const result = formatFromDetails({
      calendarId: 'c', id: 'e',
      attendeeList: [{ email: 'solo@example.com' }],
    });
    expect(result).toContain('<solo@example.com>');
  });
});

// ---------------------------------------------------------------------------
// normalizeDate
// ---------------------------------------------------------------------------
describe('normalizeDate', () => {
  it('converts numeric timestamp to Date', () => {
    const ts = Date.now();
    const result = normalizeDate(ts);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(ts);
  });

  it('converts ISO string to Date', () => {
    const iso = new Date().toISOString();
    const result = normalizeDate(iso);
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe(iso);
  });

  it('converts Date-like object with toISOString to Date', () => {
    const now = new Date();
    const dateLike = { toISOString: () => now.toISOString() };
    const result = normalizeDate(dateLike);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(now.getTime());
  });

  it('returns epoch Date for null', () => {
    const result = normalizeDate(null);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(0);
  });

  it('returns epoch Date for undefined', () => {
    const result = normalizeDate(undefined);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(0);
  });

  it('returns epoch Date for boolean', () => {
    const result = normalizeDate(true);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(0);
  });

  it('returns epoch Date for plain object without toISOString', () => {
    const result = normalizeDate({});
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(0);
  });
});
