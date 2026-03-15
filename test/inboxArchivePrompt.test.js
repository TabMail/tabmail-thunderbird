// inboxArchivePrompt.test.js — Tests for agent/modules/inboxArchivePrompt.js
//
// Tests the archive prompt logic (shouldShowArchivePrompt, etc.)

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
    inboxManagement: { maxRecentEmails: 100, archiveAgeDays: 14 },
    appearance: { prefs: { tagSortEnabled: 'extensions.tabmail.tagSortEnabled' } },
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

const mockGetTotalInboxCount = vi.fn();
vi.mock('../agent/modules/inboxContext.js', () => ({
  getTotalInboxCount: (...args) => mockGetTotalInboxCount(...args),
}));

let storageData = {};

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrObj) => {
        if (typeof keyOrObj === 'string') {
          return { [keyOrObj]: storageData[keyOrObj] ?? undefined };
        }
        const result = {};
        for (const [k, def] of Object.entries(keyOrObj)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          storageData[k] = v;
        }
      }),
      remove: vi.fn(async (key) => {
        delete storageData[key];
      }),
    },
  },
  runtime: {
    getURL: vi.fn((path) => `moz-extension://fake/${path}`),
  },
  windows: {
    create: vi.fn(async () => ({ id: 1 })),
  },
  tmPrefs: {
    hasUserValue: vi.fn(async () => false),
    setInt: vi.fn(async () => {}),
  },
};

const {
  shouldShowArchivePrompt,
  showArchivePrompt,
  checkAndShowArchivePrompt,
  resetArchivePrompt,
  setDefaultSortForLargeInbox,
} = await import('../agent/modules/inboxArchivePrompt.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  storageData = {};
  vi.clearAllMocks();
});

describe('shouldShowArchivePrompt', () => {
  it('returns false when already shown', async () => {
    storageData.inboxArchivePromptDone = true;
    const result = await shouldShowArchivePrompt();
    expect(result).toBe(false);
  });

  it('returns false when inbox count is below threshold', async () => {
    mockGetTotalInboxCount.mockResolvedValue(50);
    const result = await shouldShowArchivePrompt();
    expect(result).toBe(false);
    // Should also mark as done
    expect(storageData.inboxArchivePromptDone).toBe(true);
  });

  it('returns true when inbox count exceeds threshold', async () => {
    mockGetTotalInboxCount.mockResolvedValue(200);
    const result = await shouldShowArchivePrompt();
    expect(result).toBe(true);
  });

  it('returns false when inbox count equals threshold', async () => {
    mockGetTotalInboxCount.mockResolvedValue(100);
    const result = await shouldShowArchivePrompt();
    expect(result).toBe(false);
  });
});

describe('showArchivePrompt', () => {
  it('creates a popup window', async () => {
    await showArchivePrompt();
    expect(browser.windows.create).toHaveBeenCalled();
    const call = browser.windows.create.mock.calls[0][0];
    expect(call.type).toBe('popup');
    expect(call.url).toContain('days=14');
  });
});

describe('checkAndShowArchivePrompt', () => {
  it('shows prompt when inbox is large', async () => {
    mockGetTotalInboxCount.mockResolvedValue(200);
    await checkAndShowArchivePrompt();
    expect(browser.windows.create).toHaveBeenCalled();
  });

  it('does not show prompt when inbox is small', async () => {
    mockGetTotalInboxCount.mockResolvedValue(50);
    await checkAndShowArchivePrompt();
    expect(browser.windows.create).not.toHaveBeenCalled();
  });
});

describe('resetArchivePrompt', () => {
  it('removes the flag from storage', async () => {
    storageData.inboxArchivePromptDone = true;
    await resetArchivePrompt();
    expect(browser.storage.local.remove).toHaveBeenCalledWith('inboxArchivePromptDone');
  });
});

describe('setDefaultSortForLargeInbox', () => {
  it('sets tag sort to 0 for large inbox', async () => {
    mockGetTotalInboxCount.mockResolvedValue(200);
    browser.tmPrefs.hasUserValue.mockResolvedValue(false);
    await setDefaultSortForLargeInbox();
    expect(browser.tmPrefs.setInt).toHaveBeenCalledWith(
      'extensions.tabmail.tagSortEnabled',
      0,
    );
  });

  it('does not set sort when user has set preference', async () => {
    browser.tmPrefs.hasUserValue.mockResolvedValue(true);
    await setDefaultSortForLargeInbox();
    expect(browser.tmPrefs.setInt).not.toHaveBeenCalled();
  });

  it('does not set sort when inbox is small', async () => {
    mockGetTotalInboxCount.mockResolvedValue(50);
    browser.tmPrefs.hasUserValue.mockResolvedValue(false);
    await setDefaultSortForLargeInbox();
    expect(browser.tmPrefs.setInt).not.toHaveBeenCalled();
  });

  it('handles missing tmPrefs gracefully', async () => {
    const original = globalThis.browser.tmPrefs;
    globalThis.browser.tmPrefs = undefined;
    await setDefaultSortForLargeInbox();
    // Should not throw
    globalThis.browser.tmPrefs = original;
  });
});
