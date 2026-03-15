// chatlinkConfig.test.js — Tests for chatlink/modules/config.js

import { describe, it, expect, vi } from 'vitest';

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
    backendDomain: 'tabmail.ai',
  },
}));

// Need browser mock for storage listener in config.js
globalThis.browser = {
  storage: {
    local: { get: vi.fn(async () => ({})) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const { getChatLinkUrl } = await import('../chatlink/modules/config.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getChatLinkUrl', () => {
  it('returns production chatlink URL', async () => {
    const url = await getChatLinkUrl();
    expect(url).toBe('https://chatlink.tabmail.ai');
  });

  it('always returns the production URL (no dev mode)', async () => {
    // Even if called multiple times, always production
    const url1 = await getChatLinkUrl();
    const url2 = await getChatLinkUrl();
    expect(url1).toBe(url2);
    expect(url1).toContain('chatlink');
  });
});
