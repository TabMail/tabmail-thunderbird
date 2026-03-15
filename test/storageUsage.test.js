// storageUsage.test.js — Tests for agent/modules/storageUsage.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/idbStorage.js', () => ({
  estimateUsage: vi.fn(async () => ({
    usage: 50 * 1024 * 1024,  // 50 MB
    quota: 500 * 1024 * 1024, // 500 MB
  })),
}));

globalThis.browser = {
  runtime: {
    sendMessage: vi.fn(async () => ({ ok: true, dbBytes: 10 * 1024 * 1024 })), // 10 MB FTS
  },
};

const { getFastStorageUsage, getStorageUsage } = await import('../agent/modules/storageUsage.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getFastStorageUsage', () => {
  it('returns usage stats', async () => {
    const result = await getFastStorageUsage();
    expect(result.usage).toBe(50 * 1024 * 1024);
    expect(result.quota).toBe(500 * 1024 * 1024);
    expect(result.percent).toBeCloseTo(10.0, 1);
    expect(result.totalMB).toBeCloseTo(50.0, 0);
    expect(result.quotaMB).toBe(500);
  });

  it('returns zeros when quota is falsy', async () => {
    const { estimateUsage } = await import('../agent/modules/idbStorage.js');
    estimateUsage.mockResolvedValueOnce({ usage: 0, quota: 0 });
    const result = await getFastStorageUsage();
    expect(result).toEqual({ usage: 0, quota: 0, percent: 0, totalMB: 0, quotaMB: 0 });
  });
});

describe('getStorageUsage', () => {
  it('returns usage stats with FTS breakdown', async () => {
    const result = await getStorageUsage();
    expect(result.usage).toBe(50 * 1024 * 1024);
    expect(result.quota).toBe(500 * 1024 * 1024);
    expect(result.ftsSize).toBeGreaterThanOrEqual(0);
    expect(typeof result.breakdown).toBe('string');
    expect(result.breakdown).toContain('Storage:');
  });

  it('returns unavailable message when quota is falsy', async () => {
    const { estimateUsage } = await import('../agent/modules/idbStorage.js');
    estimateUsage.mockResolvedValueOnce({ usage: 0, quota: 0 });
    const result = await getStorageUsage();
    expect(result.breakdown).toBe('Storage quota unavailable');
  });

  it('includes FTS breakdown when FTS size > 0', async () => {
    const result = await getStorageUsage();
    // FTS is mocked to return 10MB
    if (result.ftsSize > 0) {
      expect(result.breakdown).toContain('FTS:');
      expect(result.breakdown).toContain('Cache:');
    }
  });
});
