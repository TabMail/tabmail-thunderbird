// startupPrefs.test.js — Tests for agent/modules/startupPrefs.js

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
    mailSync: {
      defaultCheckIntervalMinutes: 5,
      verticalLayoutOnInstall: false,
    },
  },
}));

globalThis.browser = {
  tmPrefs: {
    setBool: vi.fn(async () => {}),
    setPeriodicForAllServers: vi.fn(async () => {}),
    dumpBranch: vi.fn(async () => ({})),
  },
};

const { enforceMailSyncPrefs } = await import('../agent/modules/startupPrefs.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enforceMailSyncPrefs', () => {
  it('enables checking all IMAP folders', async () => {
    await enforceMailSyncPrefs();
    expect(browser.tmPrefs.setBool).toHaveBeenCalledWith(
      'mail.check_all_imap_folders_for_new',
      true,
    );
  });

  it('sets periodic sync for all servers with default interval', async () => {
    await enforceMailSyncPrefs();
    expect(browser.tmPrefs.setPeriodicForAllServers).toHaveBeenCalledWith(5, true);
  });

  it('uses custom interval when provided', async () => {
    await enforceMailSyncPrefs({ minutes: 10 });
    expect(browser.tmPrefs.setPeriodicForAllServers).toHaveBeenCalledWith(10, true);
  });

  it('handles missing tmPrefs gracefully', async () => {
    const original = globalThis.browser.tmPrefs;
    globalThis.browser.tmPrefs = undefined;
    await enforceMailSyncPrefs();
    // Should not throw
    globalThis.browser.tmPrefs = original;
  });

  it('handles dumpBranch not being a function', async () => {
    browser.tmPrefs.dumpBranch = undefined;
    await enforceMailSyncPrefs();
    // Should not throw, setBool and setPeriodicForAllServers should still be called
    expect(browser.tmPrefs.setBool).toHaveBeenCalled();
    expect(browser.tmPrefs.setPeriodicForAllServers).toHaveBeenCalled();
  });
});
