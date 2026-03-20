// emailSearch.test.js — Tests for chat/tools/email_search.js pure-logic functions
//
// Tests for normalizeArgs, sessionKey, resolvePageSize.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: vi.fn((t) => t),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { debugMode: false },
}));

// chatConfig mock — mutable so individual tests can override searchPageSizeDefault/Max
const mockChatSettings = {
  searchPageSizeDefault: 20,
  searchPageSizeMax: 500,
};

vi.mock('../chat/modules/chatConfig.js', () => ({
  get CHAT_SETTINGS() {
    return mockChatSettings;
  },
}));

vi.mock('../chat/modules/helpers.js', () => ({
  formatMailList: vi.fn(() => ''),
  toIsoNoMs: vi.fn((d) => (d || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')),
}));

// Provide browser global (email_search uses browser.runtime.sendMessage for FTS)
globalThis.browser = {
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => []), getURL: vi.fn(() => '') },
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
const { normalizeArgs, sessionKey, resolvePageSize } = await import(
  '../chat/tools/email_search.js'
);

// ---------------------------------------------------------------------------
// normalizeArgs
// ---------------------------------------------------------------------------
describe('normalizeArgs', () => {
  it('trims whitespace from query', () => {
    const result = normalizeArgs({ query: '  hello world  ' });
    expect(result.query).toBe('hello world');
  });

  it('returns empty string for missing query', () => {
    expect(normalizeArgs({}).query).toBe('');
    expect(normalizeArgs().query).toBe('');
    expect(normalizeArgs(null).query).toBe('');
  });

  it('preserves from_date and to_date as-is', () => {
    const result = normalizeArgs({ from_date: '2025-01-01', to_date: '2025-12-31' });
    expect(result.from_date).toBe('2025-01-01');
    expect(result.to_date).toBe('2025-12-31');
  });

  it('defaults from_date and to_date to empty strings', () => {
    const result = normalizeArgs({});
    expect(result.from_date).toBe('');
    expect(result.to_date).toBe('');
  });

  it('defaults sort to date_desc when not provided', () => {
    expect(normalizeArgs({}).sort).toBe('date_desc');
  });

  it('accepts valid sort values', () => {
    expect(normalizeArgs({ sort: 'date_asc' }).sort).toBe('date_asc');
    expect(normalizeArgs({ sort: 'date_desc' }).sort).toBe('date_desc');
    expect(normalizeArgs({ sort: 'relevance' }).sort).toBe('relevance');
  });

  it('defaults invalid sort values to date_desc', () => {
    expect(normalizeArgs({ sort: 'invalid' }).sort).toBe('date_desc');
    expect(normalizeArgs({ sort: '' }).sort).toBe('date_desc');
    expect(normalizeArgs({ sort: 123 }).sort).toBe('date_desc');
  });

  it('returns only the expected keys', () => {
    const result = normalizeArgs({ query: 'test', extra: 'ignored', sort: 'relevance' });
    expect(Object.keys(result).sort()).toEqual(['from_date', 'query', 'sort', 'to_date']);
  });
});

// ---------------------------------------------------------------------------
// sessionKey
// ---------------------------------------------------------------------------
describe('sessionKey', () => {
  it('produces identical keys for identical normalized args', () => {
    const key1 = sessionKey({ query: 'hello', sort: 'date_desc' });
    const key2 = sessionKey({ query: 'hello', sort: 'date_desc' });
    expect(key1).toBe(key2);
  });

  it('produces different keys for different queries', () => {
    const key1 = sessionKey({ query: 'alpha' });
    const key2 = sessionKey({ query: 'beta' });
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different sort orders', () => {
    const key1 = sessionKey({ query: 'test', sort: 'date_asc' });
    const key2 = sessionKey({ query: 'test', sort: 'date_desc' });
    expect(key1).not.toBe(key2);
  });

  it('produces different keys when date range differs', () => {
    const key1 = sessionKey({ query: 'test', from_date: '2025-01-01' });
    const key2 = sessionKey({ query: 'test', from_date: '2025-06-01' });
    expect(key1).not.toBe(key2);
  });

  it('normalizes args before generating key (trims query)', () => {
    const key1 = sessionKey({ query: '  hello  ' });
    const key2 = sessionKey({ query: 'hello' });
    expect(key1).toBe(key2);
  });

  it('normalizes invalid sort to date_desc in the key', () => {
    const key1 = sessionKey({ query: 'test', sort: 'bogus' });
    const key2 = sessionKey({ query: 'test', sort: 'date_desc' });
    expect(key1).toBe(key2);
  });

  it('returns a valid JSON string', () => {
    const key = sessionKey({ query: 'test' });
    expect(() => JSON.parse(key)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolvePageSize
// ---------------------------------------------------------------------------
describe('resolvePageSize', () => {
  beforeEach(() => {
    // Reset to defaults
    mockChatSettings.searchPageSizeDefault = 20;
    mockChatSettings.searchPageSizeMax = 500;
  });

  it('returns the default page size from CHAT_SETTINGS', () => {
    mockChatSettings.searchPageSizeDefault = 15;
    expect(resolvePageSize()).toBe(15);
  });

  it('falls back to 5 when searchPageSizeDefault is missing', () => {
    mockChatSettings.searchPageSizeDefault = undefined;
    expect(resolvePageSize()).toBe(5);
  });

  it('falls back to 5 when searchPageSizeDefault is zero', () => {
    mockChatSettings.searchPageSizeDefault = 0;
    expect(resolvePageSize()).toBe(5);
  });

  it('falls back to 5 when searchPageSizeDefault is negative', () => {
    mockChatSettings.searchPageSizeDefault = -10;
    expect(resolvePageSize()).toBe(5);
  });

  it('falls back to 5 when searchPageSizeDefault is NaN', () => {
    mockChatSettings.searchPageSizeDefault = 'not-a-number';
    expect(resolvePageSize()).toBe(5);
  });

  it('clamps to searchPageSizeMax when default exceeds max', () => {
    mockChatSettings.searchPageSizeDefault = 1000;
    mockChatSettings.searchPageSizeMax = 50;
    expect(resolvePageSize()).toBe(50);
  });

  it('does not clamp when default is within max', () => {
    mockChatSettings.searchPageSizeDefault = 10;
    mockChatSettings.searchPageSizeMax = 50;
    expect(resolvePageSize()).toBe(10);
  });

  it('uses fallback max of 50 when searchPageSizeMax is missing', () => {
    mockChatSettings.searchPageSizeDefault = 100;
    mockChatSettings.searchPageSizeMax = undefined;
    // Max falls back to 50 (Number(undefined) || 50), so 100 is clamped to 50
    expect(resolvePageSize()).toBe(50);
  });
});
