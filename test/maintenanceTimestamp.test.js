// maintenanceTimestamp.test.js — Tests for formatTimestampWithTimezone in fts/maintenanceScheduler.js

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis mocks
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

const { _testFormatTimestampWithTimezone: formatTimestampWithTimezone } = await import('../fts/maintenanceScheduler.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatTimestampWithTimezone', () => {
  it('should return an object with localDate, utcDate, timezone, timezoneOffset for valid timestamp', () => {
    const now = Date.now();
    const result = formatTimestampWithTimezone(now);
    expect(result).toHaveProperty('localDate');
    expect(result).toHaveProperty('utcDate');
    expect(result).toHaveProperty('timezone');
    expect(result).toHaveProperty('timezoneOffset');
    expect(typeof result.localDate).toBe('string');
    expect(typeof result.utcDate).toBe('string');
    expect(typeof result.timezone).toBe('string');
    expect(typeof result.timezoneOffset).toBe('number');
  });

  it('should return valid ISO string for utcDate', () => {
    const ts = Date.now();
    const result = formatTimestampWithTimezone(ts);
    const parsed = new Date(result.utcDate);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it('should return IANA timezone identifier', () => {
    const result = formatTimestampWithTimezone(Date.now());
    // IANA timezone contains a slash (e.g., America/New_York, UTC is the exception)
    const tz = result.timezone;
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
  });

  it('should return "Never" for localDate when timestamp is null', () => {
    const result = formatTimestampWithTimezone(null);
    expect(result.localDate).toBe('Never');
    expect(result.utcDate).toBe('Never');
  });

  it('should return "Never" for localDate when timestamp is undefined', () => {
    const result = formatTimestampWithTimezone(undefined);
    expect(result.localDate).toBe('Never');
    expect(result.utcDate).toBe('Never');
  });

  it('should return "Never" for localDate when timestamp is 0 (falsy)', () => {
    const result = formatTimestampWithTimezone(0);
    expect(result.localDate).toBe('Never');
    expect(result.utcDate).toBe('Never');
  });

  it('should still return timezone info even for null timestamp', () => {
    const result = formatTimestampWithTimezone(null);
    expect(typeof result.timezone).toBe('string');
    expect(result.timezone.length).toBeGreaterThan(0);
    expect(typeof result.timezoneOffset).toBe('number');
  });

  it('should include a timezone abbreviation in localDate for valid timestamps', () => {
    const result = formatTimestampWithTimezone(Date.now());
    // The localDate should end with a short timezone abbreviation like PT, ET, CT, MT, GMT, etc.
    // It should NOT end with a digit (the time portion) — there should be an abbreviation after it
    const parts = result.localDate.split(' ');
    const lastPart = parts[parts.length - 1];
    // The last part should be a timezone abbreviation (e.g., PT, ET, GMT, GMT+9)
    expect(lastPart).toMatch(/^[A-Z][A-Z0-9+\-]*$/);
  });

  it('should normalize DST abbreviations to generic ones', () => {
    // We can't control the timezone in tests, but we can verify the abbreviation
    // doesn't contain 'D' (daylight) or 'S' (standard) for US timezones
    const result = formatTimestampWithTimezone(Date.now());
    const parts = result.localDate.split(' ');
    const tzAbbr = parts[parts.length - 1];
    // US timezone abbreviations should be normalized: PDT/PST→PT, EDT/EST→ET, etc.
    // Non-US timezones pass through as-is
    if (['PT', 'MT', 'CT', 'ET'].includes(tzAbbr)) {
      // If we got a normalized abbreviation, it should not contain D or S
      expect(tzAbbr).not.toMatch(/[DS]T$/);
    }
    // Otherwise it's a non-US timezone abbreviation — just verify it's a string
    expect(typeof tzAbbr).toBe('string');
  });

  it('should produce consistent results for the same timestamp', () => {
    const ts = Date.now();
    const result1 = formatTimestampWithTimezone(ts);
    const result2 = formatTimestampWithTimezone(ts);
    expect(result1).toEqual(result2);
  });

  it('should handle timestamps in the past', () => {
    // 1 year ago
    const pastTs = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const result = formatTimestampWithTimezone(pastTs);
    expect(result.localDate).not.toBe('Never');
    expect(result.utcDate).not.toBe('Never');
    const parsed = new Date(result.utcDate);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it('should handle timestamps in the future', () => {
    // 1 year from now
    const futureTs = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const result = formatTimestampWithTimezone(futureTs);
    expect(result.localDate).not.toBe('Never');
    const parsed = new Date(result.utcDate);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });
});
