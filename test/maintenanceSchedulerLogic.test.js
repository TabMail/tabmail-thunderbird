// maintenanceSchedulerLogic.test.js — Tests for pure logic functions in fts/maintenanceScheduler.js
// Tests calculateDateRange, isWithinWeeklyScheduleWindow, pickDueMaintenanceType

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis mocks (same pattern as maintenanceTimestamp.test.js)
// ---------------------------------------------------------------------------
globalThis.browser = {
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    getAll: vi.fn(async () => []),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {},
}));
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  headerIDToWeID: vi.fn(),
  parseUniqueId: vi.fn(),
}));

const { _testExports } = await import('../fts/maintenanceScheduler.js');
const { calculateDateRange, isWithinWeeklyScheduleWindow, pickDueMaintenanceType } = _testExports;

// ---------------------------------------------------------------------------
// calculateDateRange
// ---------------------------------------------------------------------------
describe('calculateDateRange', () => {
  it('returns start and end dates for days unit', () => {
    const before = new Date();
    const result = calculateDateRange(3, 'days');
    const after = new Date();

    expect(result).toHaveProperty('start');
    expect(result).toHaveProperty('end');
    expect(result.start).toBeInstanceOf(Date);
    expect(result.end).toBeInstanceOf(Date);

    // start should be approximately 3 days before end
    const diffMs = result.end.getTime() - result.start.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(2.9);
    expect(diffDays).toBeLessThanOrEqual(3.1);
  });

  it('returns start and end dates for weeks unit', () => {
    const result = calculateDateRange(2, 'weeks');
    const diffMs = result.end.getTime() - result.start.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(13.9);
    expect(diffDays).toBeLessThanOrEqual(14.1);
  });

  it('returns start and end dates for months unit', () => {
    const result = calculateDateRange(1, 'months');
    const diffMs = result.end.getTime() - result.start.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    // 1 month is 28-31 days
    expect(diffDays).toBeGreaterThanOrEqual(27);
    expect(diffDays).toBeLessThanOrEqual(32);
  });

  it('handles scope of 0 for days (start equals end)', () => {
    const result = calculateDateRange(0, 'days');
    const diffMs = Math.abs(result.end.getTime() - result.start.getTime());
    // Should be approximately the same time (within a few ms of execution)
    expect(diffMs).toBeLessThan(100);
  });

  it('throws for unknown unit', () => {
    expect(() => calculateDateRange(1, 'centuries')).toThrow('Unknown date unit: centuries');
  });

  it('end is approximately now', () => {
    const before = Date.now();
    const result = calculateDateRange(1, 'days');
    const after = Date.now();
    expect(result.end.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.end.getTime()).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// isWithinWeeklyScheduleWindow
// ---------------------------------------------------------------------------
describe('isWithinWeeklyScheduleWindow', () => {
  it('returns true when no schedule is configured (null)', () => {
    expect(isWithinWeeklyScheduleWindow(null)).toBe(true);
  });

  it('returns true when no schedule is configured (undefined)', () => {
    expect(isWithinWeeklyScheduleWindow(undefined)).toBe(true);
  });

  it('returns true when current day and hour match the window', () => {
    const now = new Date();
    const schedule = {
      dayOfWeek: now.getDay(),
      hourStart: now.getHours(),
      hourEnd: now.getHours() + 1,
    };
    expect(isWithinWeeklyScheduleWindow(schedule)).toBe(true);
  });

  it('returns false when day does not match', () => {
    const now = new Date();
    const wrongDay = (now.getDay() + 1) % 7;
    const schedule = {
      dayOfWeek: wrongDay,
      hourStart: 0,
      hourEnd: 24,
    };
    expect(isWithinWeeklyScheduleWindow(schedule)).toBe(false);
  });

  it('returns false when current hour is before the start hour', () => {
    const now = new Date();
    const schedule = {
      dayOfWeek: now.getDay(),
      hourStart: now.getHours() + 1,
      hourEnd: now.getHours() + 2,
    };
    // Only valid if current hour < 23
    if (now.getHours() < 23) {
      expect(isWithinWeeklyScheduleWindow(schedule)).toBe(false);
    }
  });

  it('returns false when current hour is at or past the end hour', () => {
    const now = new Date();
    // Set end hour to current hour (exclusive end)
    if (now.getHours() > 0) {
      const schedule = {
        dayOfWeek: now.getDay(),
        hourStart: 0,
        hourEnd: now.getHours(),
      };
      // Current hour >= hourEnd, so should be false
      // Unless getHours() returns the same as the window, which would make
      // currentHour >= hourEnd true
      // Actually need to check: if hourEnd == currentHour, then currentHour >= hourEnd is true → false
      expect(isWithinWeeklyScheduleWindow(schedule)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// pickDueMaintenanceType
// ---------------------------------------------------------------------------
describe('pickDueMaintenanceType', () => {
  it('returns null when no schedules are enabled', () => {
    const result = pickDueMaintenanceType({
      nowMs: Date.now(),
      settings: { monthly: false, weekly: false, daily: false, hourly: false },
      lastRunsByType: {},
    });
    expect(result).toBeNull();
  });

  it('returns null when settings is null', () => {
    const result = pickDueMaintenanceType({
      nowMs: Date.now(),
      settings: null,
      lastRunsByType: {},
    });
    expect(result).toBeNull();
  });

  it('returns the type that has never run (null lastRun)', () => {
    const result = pickDueMaintenanceType({
      nowMs: Date.now(),
      settings: { monthly: false, weekly: false, daily: false, hourly: true },
      lastRunsByType: { hourly: null },
    });
    expect(result).toBe('hourly');
  });

  it('returns a due type when interval has elapsed', () => {
    const now = Date.now();
    // hourly interval is 60 minutes = 3,600,000 ms
    const result = pickDueMaintenanceType({
      nowMs: now,
      settings: { monthly: false, weekly: false, daily: false, hourly: true },
      lastRunsByType: { hourly: now - 4_000_000 }, // > 60 min ago
    });
    expect(result).toBe('hourly');
  });

  it('returns null when no type is due yet', () => {
    const now = Date.now();
    const result = pickDueMaintenanceType({
      nowMs: now,
      settings: { monthly: false, weekly: false, daily: false, hourly: true },
      lastRunsByType: { hourly: now - 1000 }, // Just ran 1 second ago
    });
    expect(result).toBeNull();
  });

  it('picks monthly over weekly when both are due (priority order)', () => {
    const now = Date.now();
    const longAgo = now - 100 * 24 * 60 * 60 * 1000; // 100 days ago
    const result = pickDueMaintenanceType({
      nowMs: now,
      settings: {
        monthly: true,
        weekly: true,
        daily: false,
        hourly: false,
      },
      lastRunsByType: { monthly: longAgo, weekly: longAgo },
    });
    expect(result).toBe('monthly');
  });

  it('picks weekly over daily when both are due (priority order)', () => {
    const now = Date.now();
    const longAgo = now - 100 * 24 * 60 * 60 * 1000;
    const result = pickDueMaintenanceType({
      nowMs: now,
      settings: {
        monthly: false,
        weekly: true,
        daily: true,
        hourly: false,
      },
      lastRunsByType: { weekly: longAgo, daily: longAgo },
    });
    expect(result).toBe('weekly');
  });

  it('skips weekly when not within schedule window', () => {
    const now = new Date();
    const wrongDay = (now.getDay() + 1) % 7;
    const longAgo = Date.now() - 100 * 24 * 60 * 60 * 1000;

    const result = pickDueMaintenanceType({
      nowMs: Date.now(),
      settings: {
        monthly: false,
        weekly: true,
        daily: true,
        hourly: false,
        weeklySchedule: {
          dayOfWeek: wrongDay,
          hourStart: 0,
          hourEnd: 24,
        },
      },
      lastRunsByType: { weekly: longAgo, daily: longAgo },
    });
    // Weekly is skipped due to wrong day, should fall through to daily
    expect(result).toBe('daily');
  });

  it('returns daily when never run and enabled', () => {
    const result = pickDueMaintenanceType({
      nowMs: Date.now(),
      settings: { monthly: false, weekly: false, daily: true, hourly: false },
      lastRunsByType: {},
    });
    expect(result).toBe('daily');
  });
});
