// icon.test.js — Tests for agent/modules/icon.js
//
// Tests updateIconBasedOnAuthState which updates toolbar icon based on auth state.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

globalThis.browser = {
  action: {
    setIcon: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
  },
};

// We need a fresh import each time because the module has internal state (_lastAuthState)
let updateIconBasedOnAuthState;

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset module to clear _lastAuthState cache
  vi.resetModules();
  // Re-mock dependencies after resetModules
  vi.doMock('../agent/modules/config.js', () => ({
    SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
  }));
  vi.doMock('../agent/modules/thinkBuffer.js', () => ({
    getAndClearThink: vi.fn(() => null),
  }));
  vi.doMock('../agent/modules/quoteAndSignature.js', () => ({}));

  globalThis.browser = {
    action: {
      setIcon: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
    },
  };

  const mod = await import('../agent/modules/icon.js');
  updateIconBasedOnAuthState = mod.updateIconBasedOnAuthState;
});

describe('updateIconBasedOnAuthState', () => {
  it('sets connected icon when authState is true', async () => {
    await updateIconBasedOnAuthState(true);
    expect(browser.action.setIcon).toHaveBeenCalledWith({ path: 'icons/tab.svg' });
    expect(browser.action.setTitle).toHaveBeenCalledWith({ title: 'TabMail' });
  });

  it('sets disconnected icon when authState is false', async () => {
    await updateIconBasedOnAuthState(false);
    expect(browser.action.setIcon).toHaveBeenCalledWith({ path: 'icons/tab-greyed.svg' });
  });

  it('skips update when state has not changed', async () => {
    await updateIconBasedOnAuthState(true);
    vi.clearAllMocks();
    await updateIconBasedOnAuthState(true);
    expect(browser.action.setIcon).not.toHaveBeenCalled();
  });

  it('updates when forceUpdate is true even if state unchanged', async () => {
    await updateIconBasedOnAuthState(true);
    vi.clearAllMocks();
    await updateIconBasedOnAuthState(true, true);
    expect(browser.action.setIcon).toHaveBeenCalled();
  });

  it('handles missing browser.action gracefully', async () => {
    globalThis.browser = {};
    await updateIconBasedOnAuthState(true);
    // Should not throw
  });

  it('handles missing setIcon gracefully', async () => {
    globalThis.browser = { action: {} };
    await updateIconBasedOnAuthState(true);
    // Should not throw
  });
});
