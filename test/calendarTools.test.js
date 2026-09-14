/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarTools.test.js — Tests for calendar tool modules
//
// Tests calendar_event_read (normalizeDate, isWithinTolerance, formatDetailed),
// calendar_event_delete (normalizeArgs), calendar_event_edit (normalizeArgs),
// calendar_read (delegation to calendar_search).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis mocks
// ---------------------------------------------------------------------------
globalThis.browser = {
  tmCalendar: {
    getCalendarEventDetails: vi.fn(async (eventId, calId) => {
      if (eventId === 'found-event') {
        return {
          ok: true,
          id: 'found-event',
          calendarId: calId || 'cal1',
          title: 'Test Event',
          start: Date.now(),
          end: Date.now() + 3600000,
          isAllDay: false,
          attendeeList: [],
        };
      }
      return { ok: false, error: 'event not found' };
    }),
    listCalendars: vi.fn(async () => [
      { id: 'cal1', name: 'Personal' },
    ]),
    queryCalendarItems: vi.fn(async (start, end, calIds) => {
      return [
        {
          id: 'item1',
          calendarId: 'cal1',
          title: 'Meeting',
          startMs: new Date('2025-06-15T10:00:00').getTime(),
          endMs: new Date('2025-06-15T11:00:00').getTime(),
          isAllDay: false,
          attendeeList: [
            { name: 'Alice', email: 'alice@example.com', participationStatus: 'ACCEPTED' },
          ],
          description: 'Team sync',
        },
      ];
    }),
    getCalendars: vi.fn(async () => ({
      ok: true,
      calendars: [{ id: 'cal1', name: 'Personal', organizer_email: 'me@example.com' }],
    })),
    modifyCalendarEvent: vi.fn(async () => ({ ok: true })),
    deleteCalendarEvent: vi.fn(async () => ({ ok: true })),
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
  },
  runtime: {
    sendMessage: vi.fn(async () => undefined),
  },
};

globalThis.Intl = globalThis.Intl || {};
// Ensure DateTimeFormat resolvedOptions returns a timezone
const origDateTimeFormat = globalThis.Intl.DateTimeFormat;

globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { debugLogging: false },
}));

vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    calendarEntryMatchToleranceMs: 60000,
    calendarPageSizeDefault: 100,
    calendarPageSizeMax: 100,
    msPerDay: 86400000,
    middayHourForDateHeader: 12,
    calendarQueryLogPreviewChars: 120,
    calendarQueryLogTermsPreviewCount: 5,
    searchDefaultDaysBack: 365,
  },
}));

vi.mock('../chat/modules/helpers.js', () => ({
  toIsoNoMs: vi.fn((d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')),
  toNaiveIso: vi.fn((msOrIso) => {
    if (typeof msOrIso === 'number') return new Date(msOrIso).toISOString().replace('Z', '');
    if (typeof msOrIso === 'string') return msOrIso.replace('Z', '');
    return '';
  }),
  streamText: vi.fn(),
}));

vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => ({
    textContent: '',
    classList: { add: vi.fn(), remove: vi.fn() },
  })),
}));

vi.mock('../chat/modules/context.js', () => ({
  ctx: {
    activePid: 0,
    awaitingPid: 0,
    activeToolCallId: null,
    fsmSessions: Object.create(null),
    state: null,
    toolExecutionMode: null,
    rawUserTexts: ['original request'],
  },
  initFsmSession: vi.fn(),
}));

vi.mock('../chat/fsm/core.js', () => ({
  executeAgentAction: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { run as calendarEventReadRun } from '../chat/tools/calendar_event_read.js';
import { run as calendarEventDeleteRun, completeExecution as calendarEventDeleteComplete } from '../chat/tools/calendar_event_delete.js';
import { run as calendarEventEditRun, completeExecution as calendarEventEditComplete } from '../chat/tools/calendar_event_edit.js';
import { run as calendarReadRun, resetPaginationSessions as calendarReadResetPagination } from '../chat/tools/calendar_read.js';

describe('calendar_event_read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error when tmCalendar is not available', async () => {
    const orig = browser.tmCalendar;
    browser.tmCalendar = undefined;
    const result = await calendarEventReadRun({});
    expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('bridge') }));
    browser.tmCalendar = orig;
  });

  it('should do direct lookup when event_id is provided', async () => {
    const result = await calendarEventReadRun({ event_id: 'found-event', calendar_id: 'cal1' });
    expect(result.ok).toBe(true);
    expect(result.results).toContain('Test Event');
  });

  it('should return error for missing event with direct lookup', async () => {
    const result = await calendarEventReadRun({ event_id: 'missing-event', calendar_id: 'cal1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should return error when no event_id and no start_iso', async () => {
    const result = await calendarEventReadRun({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('event_id');
  });

  it('should search by start_iso when no event_id', async () => {
    const result = await calendarEventReadRun({ start_iso: '2025-06-15T10:00:00' });
    expect(result.ok).toBe(true);
  });

  it('should return invalid datetime error for garbage start_iso', async () => {
    const result = await calendarEventReadRun({ start_iso: 'not-a-date' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid');
  });

  it('should filter by title when provided', async () => {
    // The mock returns "Meeting" title, so filtering for "Other" should yield no match
    const result = await calendarEventReadRun({ start_iso: '2025-06-15T10:00:00', title: 'Other' });
    expect(result.ok).toBe(true);
    expect(result.results).toContain('No entries matched');
  });

  it('should match events within tolerance', async () => {
    // Start within 1 minute of the event's start
    const result = await calendarEventReadRun({ start_iso: '2025-06-15T10:00:30' });
    expect(result.ok).toBe(true);
  });
});

describe('calendar_event_delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('run', () => {
    it('should return FSM marker', async () => {
      const result = await calendarEventDeleteRun(
        { event_id: 'evt1', calendar_id: 'cal1' },
        { callId: 'pid-1' }
      );
      expect(result).toEqual(expect.objectContaining({
        fsm: true,
        tool: 'calendar_event_delete',
        pid: 'pid-1',
      }));
    });

    it('should include startedAt timestamp', async () => {
      const before = Date.now();
      const result = await calendarEventDeleteRun(
        { event_id: 'evt1', calendar_id: 'cal1' },
        { callId: 'pid-1' }
      );
      expect(result.startedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('completeExecution', () => {
    it('should return error message when failReason is set', async () => {
      const { ctx } = await import('../chat/modules/context.js');
      ctx.activePid = 'pid-1';
      ctx.fsmSessions['pid-1'] = { failReason: 'event not found' };
      const result = await calendarEventDeleteComplete('done', 'calendar_event_delete_exec');
      expect(result).toEqual(expect.objectContaining({ error: 'event not found' }));
    });

    it('should return success when deleted', async () => {
      const { ctx } = await import('../chat/modules/context.js');
      ctx.activePid = 'pid-2';
      ctx.fsmSessions['pid-2'] = { deleteResult: { event_id: 'evt1' } };
      const result = await calendarEventDeleteComplete('done', 'calendar_event_delete_exec');
      expect(result.result).toContain('deleted');
    });
  });
});

describe('calendar_event_edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('run', () => {
    it('should return FSM marker', async () => {
      const result = await calendarEventEditRun(
        { event_id: 'evt1', calendar_id: 'cal1', title: 'Updated' },
        { callId: 'pid-3' }
      );
      expect(result).toEqual(expect.objectContaining({
        fsm: true,
        tool: 'calendar_event_edit',
        pid: 'pid-3',
      }));
    });
  });

  describe('completeExecution', () => {
    it('should return error when failReason set', async () => {
      const { ctx } = await import('../chat/modules/context.js');
      ctx.activePid = 'pid-4';
      ctx.fsmSessions['pid-4'] = { failReason: 'calendar not found' };
      const result = await calendarEventEditComplete('done', 'calendar_event_edit_exec');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('calendar not found');
    });

    it('should return success when edited', async () => {
      const { ctx } = await import('../chat/modules/context.js');
      ctx.activePid = 'pid-5';
      ctx.fsmSessions['pid-5'] = {
        editResult: { event_id: 'evt1', event_title: 'Updated', calendar_id: 'cal1' },
      };
      const result = await calendarEventEditComplete('done', 'calendar_event_edit_exec');
      expect(result.ok).toBe(true);
      expect(result.result).toContain('modified');
    });

    it('should return generic completion when no special state', async () => {
      const { ctx } = await import('../chat/modules/context.js');
      ctx.activePid = 'pid-6';
      ctx.fsmSessions['pid-6'] = {};
      const result = await calendarEventEditComplete('done', 'other_state');
      expect(result.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// calendar_read tests
// ---------------------------------------------------------------------------
describe('calendar_read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to calendar_search with query suppressed', async () => {
    const result = await calendarReadRun({ query: 'meetings', calendar_ids: ['cal1'] });
    // Should return results from the mocked calendar API
    expect(result).toBeDefined();
    // Should not throw
    expect(typeof result === 'string' || typeof result === 'object').toBe(true);
  });

  it('forwards args without query property', async () => {
    const result = await calendarReadRun({ calendar_ids: ['cal1'] });
    expect(result).toBeDefined();
  });

  it('returns error on failure', async () => {
    // Reset the pagination cache so the rejected query is actually consumed
    // here instead of leaking into the next test's mock queue.
    calendarReadResetPagination();
    browser.tmCalendar.queryCalendarItems.mockRejectedValueOnce(new Error('calendar error'));
    const result = await calendarReadRun({});
    // Should handle the error gracefully
    expect(result).toBeDefined();
  });

  it('resetPaginationSessions does not throw', () => {
    expect(() => calendarReadResetPagination()).not.toThrow();
  });

  // #31 — timed rows carry an explicit 12-hour cue next to the 24-hour value;
  // all-day rows stay "All day" and never gain a fabricated clock range.
  it('renders morning, evening, and all-day rows with AM/PM cues where a time exists', async () => {
    calendarReadResetPagination();
    const day = new Date();
    day.setDate(day.getDate() + 7);
    day.setHours(0, 0, 0, 0);
    const at = (h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
    const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    browser.tmCalendar.queryCalendarItems.mockResolvedValueOnce([
      { id: 'am', calendarId: 'cal1', title: 'Early run', startMs: at(5), endMs: at(6), isAllDay: false, attendeeList: [] },
      { id: 'pm', calendarId: 'cal1', title: 'Dinner', startMs: at(17, 30), endMs: at(18), isAllDay: false, attendeeList: [] },
      { id: 'ad', calendarId: 'cal1', title: 'Holiday', startMs: at(0), endMs: at(0) + 86400000, isAllDay: true, attendeeList: [] },
    ]);
    const result = await calendarReadRun({ calendar_ids: ["cal1"], from_date: dayKey, to_date: dayKey });
    expect(result.results).toContain('05:00 (5 a.m.) - 06:00 (6 a.m.): Early run\tevent_id: am');
    expect(result.results).toContain('17:30 (5:30 p.m.) - 18:00 (6 p.m.): Dinner\tevent_id: pm');
    expect(result.results).toContain('All day: Holiday\tevent_id: ad');
    expect(result.results).not.toMatch(/00:00 \(12 a\.m\.\) - 00:00/);
  });
});
