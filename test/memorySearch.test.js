// memorySearch.test.js — Tests for normalizeArgs, sessionKey, resolvePageSize in chat/tools/memory_search.js

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis mocks
// ---------------------------------------------------------------------------
globalThis.browser = {
  runtime: { sendMessage: vi.fn(async () => []) },
};

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));
vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    searchPageSizeDefault: 20,
    searchPageSizeMax: 500,
    searchPrefetchPagesDefault: 4,
    searchPrefetchMaxResults: 200,
  },
}));
vi.mock('../chat/modules/helpers.js', () => ({
  toIsoNoMs: vi.fn((d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')),
}));

const {
  _testNormalizeArgs: normalizeArgs,
  _testSessionKey: sessionKey,
  _testResolvePageSize: resolvePageSize,
} = await import('../chat/tools/memory_search.js');

// ---------------------------------------------------------------------------
// normalizeArgs
// ---------------------------------------------------------------------------

describe('normalizeArgs', () => {
  it('should return empty strings for missing fields', () => {
    const result = normalizeArgs();
    expect(result).toEqual({ query: '', from_date: '', to_date: '' });
  });

  it('should return empty strings for empty object', () => {
    const result = normalizeArgs({});
    expect(result).toEqual({ query: '', from_date: '', to_date: '' });
  });

  it('should trim query whitespace', () => {
    const result = normalizeArgs({ query: '  hello world  ' });
    expect(result.query).toBe('hello world');
  });

  it('should pass through from_date and to_date', () => {
    const result = normalizeArgs({ from_date: '2026-01-01', to_date: '2026-03-20' });
    expect(result.from_date).toBe('2026-01-01');
    expect(result.to_date).toBe('2026-03-20');
  });

  it('should handle null query', () => {
    const result = normalizeArgs({ query: null });
    expect(result.query).toBe('');
  });

  it('should handle undefined fields gracefully', () => {
    const result = normalizeArgs({ query: undefined, from_date: undefined, to_date: undefined });
    expect(result).toEqual({ query: '', from_date: '', to_date: '' });
  });

  it('should handle numeric query by converting to empty string (falsy 0)', () => {
    // (0 || "").trim() === ""
    const result = normalizeArgs({ query: 0 });
    expect(result.query).toBe('');
  });

  it('should handle non-empty query string', () => {
    const result = normalizeArgs({ query: 'meeting notes' });
    expect(result.query).toBe('meeting notes');
  });
});

// ---------------------------------------------------------------------------
// sessionKey
// ---------------------------------------------------------------------------

describe('sessionKey', () => {
  it('should produce deterministic JSON key for same args', () => {
    const key1 = sessionKey({ query: 'test', from_date: '2026-01-01', to_date: '2026-03-01' });
    const key2 = sessionKey({ query: 'test', from_date: '2026-01-01', to_date: '2026-03-01' });
    expect(key1).toBe(key2);
  });

  it('should produce different keys for different queries', () => {
    const key1 = sessionKey({ query: 'alpha' });
    const key2 = sessionKey({ query: 'beta' });
    expect(key1).not.toBe(key2);
  });

  it('should normalize args before generating key', () => {
    const key1 = sessionKey({ query: '  test  ' });
    const key2 = sessionKey({ query: 'test' });
    expect(key1).toBe(key2);
  });

  it('should include date fields in key', () => {
    const keyNoDate = sessionKey({ query: 'test' });
    const keyWithDate = sessionKey({ query: 'test', from_date: '2026-01-01' });
    expect(keyNoDate).not.toBe(keyWithDate);
  });

  it('should return valid JSON string', () => {
    const key = sessionKey({ query: 'hello' });
    expect(() => JSON.parse(key)).not.toThrow();
  });

  it('should handle empty args', () => {
    const key = sessionKey({});
    expect(typeof key).toBe('string');
    const parsed = JSON.parse(key);
    expect(parsed).toEqual({ query: '', from_date: '', to_date: '' });
  });
});

// ---------------------------------------------------------------------------
// resolvePageSize
// ---------------------------------------------------------------------------

describe('resolvePageSize', () => {
  it('should return default page size from CHAT_SETTINGS', () => {
    const size = resolvePageSize();
    expect(size).toBe(20);
  });

  it('should return a positive finite number', () => {
    const size = resolvePageSize();
    expect(size).toBeGreaterThan(0);
    expect(Number.isFinite(size)).toBe(true);
  });

  it('should not exceed max page size', () => {
    const size = resolvePageSize();
    expect(size).toBeLessThanOrEqual(500);
  });
});
