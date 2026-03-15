// tagCleanup.test.js — Tests for agent/modules/tagCleanup.js
//
// Tests the clearTabMailActionTags function which removes action tags from messages.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
    actionTagging: { debugTagRace: { enabled: false } },
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

// Mock tagHelper to provide ACTION_TAG_IDS
vi.mock('../agent/modules/tagHelper.js', () => ({
  ACTION_TAG_IDS: {
    reply: 'tm_reply',
    archive: 'tm_archive',
    delete: 'tm_delete',
    none: 'tm_none',
  },
}));

globalThis.browser = {
  messages: {
    get: vi.fn(),
    update: vi.fn(),
  },
};

const { clearTabMailActionTags } = await import('../agent/modules/tagCleanup.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('clearTabMailActionTags', () => {
  it('returns cleared: false for invalid id', async () => {
    const result = await clearTabMailActionTags(0);
    expect(result).toEqual({ cleared: false, removed: [] });
  });

  it('returns cleared: false for null id', async () => {
    const result = await clearTabMailActionTags(null);
    expect(result).toEqual({ cleared: false, removed: [] });
  });

  it('returns cleared: false when no action tags present', async () => {
    browser.messages.get.mockResolvedValue({ tags: ['unrelated_tag'] });
    const result = await clearTabMailActionTags(123, 'test');
    expect(result).toEqual({ cleared: false, removed: [] });
  });

  it('clears action tags and returns them', async () => {
    browser.messages.get.mockResolvedValue({ tags: ['tm_reply', 'tm_archive', 'custom_tag'] });
    browser.messages.update.mockResolvedValue(undefined);

    const result = await clearTabMailActionTags(123, 'test');
    expect(result.cleared).toBe(true);
    expect(result.removed).toContain('tm_reply');
    expect(result.removed).toContain('tm_archive');
    expect(browser.messages.update).toHaveBeenCalledWith(123, { tags: ['custom_tag'] });
  });

  it('uses headerHint when provided', async () => {
    const header = { tags: ['tm_delete', 'important'] };
    browser.messages.update.mockResolvedValue(undefined);

    const result = await clearTabMailActionTags(456, 'test', header);
    expect(result.cleared).toBe(true);
    expect(result.removed).toEqual(['tm_delete']);
    expect(browser.messages.get).not.toHaveBeenCalled(); // Should use headerHint
    expect(browser.messages.update).toHaveBeenCalledWith(456, { tags: ['important'] });
  });

  it('returns cleared: false when messages.get throws', async () => {
    browser.messages.get.mockRejectedValue(new Error('not found'));
    const result = await clearTabMailActionTags(789, 'test');
    expect(result).toEqual({ cleared: false, removed: [] });
  });

  it('returns cleared: false when message has no tags', async () => {
    browser.messages.get.mockResolvedValue({ tags: [] });
    const result = await clearTabMailActionTags(101, 'test');
    expect(result).toEqual({ cleared: false, removed: [] });
  });

  it('clears all four action tag types', async () => {
    browser.messages.get.mockResolvedValue({ tags: ['tm_reply', 'tm_archive', 'tm_delete', 'tm_none'] });
    browser.messages.update.mockResolvedValue(undefined);

    const result = await clearTabMailActionTags(202, 'test');
    expect(result.cleared).toBe(true);
    expect(result.removed).toHaveLength(4);
    expect(browser.messages.update).toHaveBeenCalledWith(202, { tags: [] });
  });
});
