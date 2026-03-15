// privacySettings.test.js — Tests for chat/modules/privacySettings.js

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
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrDefault) => {
        if (typeof keyOrDefault === 'string') {
          return { [keyOrDefault]: storageData[keyOrDefault] };
        }
        const result = {};
        for (const [k, def] of Object.entries(keyOrDefault)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        Object.assign(storageData, obj);
      }),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const {
  PRIVACY_STORAGE_KEYS,
  PRIVACY_DEFAULTS,
  PRIVACY_OPT_OUT_ERROR_MESSAGE,
  getPrivacyOptOutAllAiEnabled,
  setPrivacyOptOutAllAiEnabled,
  assertAiBackendAllowed,
} = await import('../chat/modules/privacySettings.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
});

describe('PRIVACY_STORAGE_KEYS', () => {
  it('has optOutAllAi key', () => {
    expect(PRIVACY_STORAGE_KEYS.optOutAllAi).toBe('privacy_opt_out_all_ai');
  });
});

describe('PRIVACY_DEFAULTS', () => {
  it('defaults to not opted out', () => {
    expect(PRIVACY_DEFAULTS[PRIVACY_STORAGE_KEYS.optOutAllAi]).toBe(false);
  });
});

describe('getPrivacyOptOutAllAiEnabled', () => {
  it('returns false by default', async () => {
    expect(await getPrivacyOptOutAllAiEnabled()).toBe(false);
  });

  it('returns true when opted out', async () => {
    storageData[PRIVACY_STORAGE_KEYS.optOutAllAi] = true;
    expect(await getPrivacyOptOutAllAiEnabled()).toBe(true);
  });

  it('returns false on storage error', async () => {
    browser.storage.local.get.mockRejectedValueOnce(new Error('fail'));
    expect(await getPrivacyOptOutAllAiEnabled()).toBe(false);
  });
});

describe('setPrivacyOptOutAllAiEnabled', () => {
  it('saves true value', async () => {
    const result = await setPrivacyOptOutAllAiEnabled(true);
    expect(result).toBe(true);
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      [PRIVACY_STORAGE_KEYS.optOutAllAi]: true,
    });
  });

  it('saves false value', async () => {
    const result = await setPrivacyOptOutAllAiEnabled(false);
    expect(result).toBe(true);
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      [PRIVACY_STORAGE_KEYS.optOutAllAi]: false,
    });
  });

  it('returns false on storage error', async () => {
    browser.storage.local.set.mockRejectedValueOnce(new Error('fail'));
    const result = await setPrivacyOptOutAllAiEnabled(true);
    expect(result).toBe(false);
  });
});

describe('assertAiBackendAllowed', () => {
  it('does not throw when not opted out', async () => {
    await expect(assertAiBackendAllowed()).resolves.toBeUndefined();
  });

  it('throws when opted out', async () => {
    storageData[PRIVACY_STORAGE_KEYS.optOutAllAi] = true;
    await expect(assertAiBackendAllowed()).rejects.toThrow(PRIVACY_OPT_OUT_ERROR_MESSAGE);
  });

  it('throws PrivacyOptOutError', async () => {
    storageData[PRIVACY_STORAGE_KEYS.optOutAllAi] = true;
    try {
      await assertAiBackendAllowed('test');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e.name).toBe('PrivacyOptOutError');
    }
  });
});
