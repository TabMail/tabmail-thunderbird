// helpers.test.js — Tests for chat/modules/helpers.js pure functions
//
// Tests for TB-160 through TB-165 (TESTS.md) plus edge cases.
// Modules with heavy browser/DOM dependencies are mocked; only pure logic is under test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — helpers.js imports from agent/modules/utils.js, chatConfig.js,
// context.js, and markdown.js. All are browser-dependent.
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

vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {},
}));

vi.mock('../chat/modules/context.js', () => ({
  ctx: {},
}));

vi.mock('../chat/modules/markdown.js', () => ({
  attachSpecialLinkListeners: vi.fn(),
  renderMarkdown: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import pure functions under test
// ---------------------------------------------------------------------------

const {
  toIsoNoMs,
  toNaiveIso,
  getGenericTimezoneAbbr,
  fuzzyMatchWithList,
} = await import('../chat/modules/helpers.js');

// ---------------------------------------------------------------------------
// TB-160: toIsoNoMs strips fractional seconds
// ---------------------------------------------------------------------------
describe('TB-160: toIsoNoMs strips fractional seconds', () => {
  it('strips .000Z from ISO string', () => {
    const d = new Date('2026-03-14T10:30:00.000Z');
    expect(toIsoNoMs(d)).toBe('2026-03-14T10:30:00Z');
  });

  it('strips arbitrary milliseconds', () => {
    const d = new Date('2025-12-25T23:59:59.999Z');
    expect(toIsoNoMs(d)).toBe('2025-12-25T23:59:59Z');
  });

  it('strips .123Z milliseconds', () => {
    const d = new Date('2026-01-01T00:00:00.123Z');
    expect(toIsoNoMs(d)).toBe('2026-01-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// toIsoNoMs edge cases
// ---------------------------------------------------------------------------
describe('toIsoNoMs edge cases', () => {
  it('defaults to now when called without argument', () => {
    const before = new Date();
    const result = toIsoNoMs();
    const after = new Date();
    // Result should be a valid ISO-like string ending in Z (no ms)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // The timestamp should be between before and after
    const parsed = new Date(result);
    expect(parsed.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(parsed.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it('handles Date at midnight UTC', () => {
    const d = new Date('2026-06-15T00:00:00.000Z');
    expect(toIsoNoMs(d)).toBe('2026-06-15T00:00:00Z');
  });

  it('handles Date at 23:59:59 UTC', () => {
    const d = new Date('2026-12-31T23:59:59.000Z');
    expect(toIsoNoMs(d)).toBe('2026-12-31T23:59:59Z');
  });
});

// ---------------------------------------------------------------------------
// TB-161: toNaiveIso from timestamp number → correct local datetime string
// ---------------------------------------------------------------------------
describe('TB-161: toNaiveIso from timestamp number', () => {
  it('converts a timestamp number to a naive ISO string', () => {
    // Use a known date and verify the output matches local components
    const d = new Date(2026, 2, 14, 10, 30, 0); // March 14, 2026 10:30:00 local
    const ts = d.getTime();
    const result = toNaiveIso(ts);
    expect(result).toBe('2026-03-14T10:30:00');
  });

  it('formats with zero-padded components', () => {
    const d = new Date(2025, 0, 5, 9, 8, 1); // Jan 5, 2025 09:08:01 local
    const ts = d.getTime();
    const result = toNaiveIso(ts);
    expect(result).toBe('2025-01-05T09:08:01');
  });
});

// ---------------------------------------------------------------------------
// TB-162: toNaiveIso from ISO string → timezone stripped
// ---------------------------------------------------------------------------
describe('TB-162: toNaiveIso from ISO string', () => {
  it('strips Z suffix from UTC ISO string', () => {
    // When parsing "2026-03-14T10:30:00Z", the Z is stripped before creating Date,
    // so the Date is treated as local time 10:30:00
    const result = toNaiveIso('2026-03-14T10:30:00Z');
    // After stripping Z, new Date('2026-03-14T10:30:00') creates local time
    expect(result).toBe('2026-03-14T10:30:00');
  });

  it('strips +HH:MM timezone offset', () => {
    const result = toNaiveIso('2026-03-14T10:30:00+05:30');
    // After stripping +05:30, new Date('2026-03-14T10:30:00') → local 10:30
    expect(result).toBe('2026-03-14T10:30:00');
  });

  it('strips -HH:MM timezone offset', () => {
    const result = toNaiveIso('2026-03-14T10:30:00-08:00');
    expect(result).toBe('2026-03-14T10:30:00');
  });

  it('returns naive format matching YYYY-MM-DDTHH:MM:SS', () => {
    const result = toNaiveIso('2026-06-01T14:00:00z');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// TB-163: fuzzyMatchWithList finds close matches within threshold
// ---------------------------------------------------------------------------
describe('TB-163: fuzzyMatchWithList finds close matches', () => {
  const candidates = ['Inbox', 'Sent', 'Drafts', 'Trash', 'Archive'];

  it('finds exact match (case-insensitive)', () => {
    expect(fuzzyMatchWithList('inbox', candidates)).toBe('Inbox');
    expect(fuzzyMatchWithList('SENT', candidates)).toBe('Sent');
  });

  it('finds match with small typo within maxDistance', () => {
    // "Inbx" is 1 edit away from "Inbox"
    expect(fuzzyMatchWithList('Inbx', candidates, 2)).toBe('Inbox');
  });

  it('finds substring match', () => {
    // "Draft" is a substring of "Drafts"
    expect(fuzzyMatchWithList('Draft', candidates)).toBe('Drafts');
  });

  it('returns closest match when no maxDistance set', () => {
    // "Trsh" → closest is "Trash" (1 edit)
    const result = fuzzyMatchWithList('Trsh', candidates);
    expect(result).toBe('Trash');
  });
});

// ---------------------------------------------------------------------------
// TB-164: fuzzyMatchWithList rejects distant strings
// ---------------------------------------------------------------------------
describe('TB-164: fuzzyMatchWithList rejects distant strings', () => {
  const candidates = ['Inbox', 'Sent', 'Drafts'];

  it('returns null when best match exceeds maxDistance', () => {
    // "zzzzzzz" is far from all candidates
    expect(fuzzyMatchWithList('zzzzzzz', candidates, 1)).toBe(null);
  });

  it('returns null for empty input', () => {
    expect(fuzzyMatchWithList('', candidates)).toBe(null);
    expect(fuzzyMatchWithList(null, candidates)).toBe(null);
  });

  it('returns null for empty candidates', () => {
    expect(fuzzyMatchWithList('Inbox', [])).toBe(null);
    expect(fuzzyMatchWithList('Inbox', null)).toBe(null);
  });

  it('rejects when distance exceeds tight threshold', () => {
    // "Completely Different" vs candidates — edit distance is large
    expect(fuzzyMatchWithList('Completely Different', candidates, 2)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// TB-165: getGenericTimezoneAbbr returns abbreviation
// ---------------------------------------------------------------------------
describe('TB-165: getGenericTimezoneAbbr returns abbreviation', () => {
  it('returns a non-empty string', () => {
    const result = getGenericTimezoneAbbr(new Date());
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns a known abbreviation format (2-4 uppercase letters)', () => {
    const result = getGenericTimezoneAbbr(new Date());
    // Common abbreviations: PT, ET, CT, MT, UTC, GMT, JST, CET, AEST, MST, GMT+9, etc.
    expect(result).toMatch(/^[A-Z]{2,5}(\+\d{1,2})?$/);
  });

  it('defaults to current time when no argument given', () => {
    // Should not throw
    const result = getGenericTimezoneAbbr();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns consistent result for different dates (generic, not DST-aware)', () => {
    // January (winter) and July (summer) should return same generic abbr
    const winter = new Date(2026, 0, 15);
    const summer = new Date(2026, 6, 15);
    expect(getGenericTimezoneAbbr(winter)).toBe(getGenericTimezoneAbbr(summer));
  });
});
