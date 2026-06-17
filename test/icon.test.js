/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// icon.test.js — Tests for agent/modules/icon.js
//
// Tests updateIconBasedOnAuthState (auth → icon) and setWarning (keyed
// "attention needed" red-dot indicator).

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

// We need a fresh import each time because the module has internal state
// (_connected / _warnings / _lastIconPath).
let updateIconBasedOnAuthState;
let setWarning;

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset module to clear internal state cache
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
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
  };

  const mod = await import('../agent/modules/icon.js');
  updateIconBasedOnAuthState = mod.updateIconBasedOnAuthState;
  setWarning = mod.setWarning;
});

describe('updateIconBasedOnAuthState', () => {
  it('sets connected icon + plain title when authState is true', async () => {
    await updateIconBasedOnAuthState(true);
    expect(browser.action.setIcon).toHaveBeenCalledWith({ path: 'icons/tab.svg' });
    expect(browser.action.setTitle).toHaveBeenCalledWith({ title: 'TabMail' });
  });

  it('treats disconnected as a warning: greyed-warning icon + "disconnected" title', async () => {
    await updateIconBasedOnAuthState(false);
    expect(browser.action.setIcon).toHaveBeenCalledWith({ path: 'icons/tab-greyed-warning.svg' });
    expect(browser.action.setTitle).toHaveBeenCalledWith({ title: expect.stringContaining('disconnected') });
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
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

describe('setWarning', () => {
  it('raises the red-dot warning icon (and "!" badge) when connected', async () => {
    await updateIconBasedOnAuthState(true);
    vi.clearAllMocks();
    await setWarning('fts', true);
    expect(browser.action.setIcon).toHaveBeenCalledWith({ path: 'icons/tab-warning.svg' });
    expect(browser.action.setTitle).toHaveBeenCalledWith({ title: expect.stringContaining('action needed') });
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledTimes(1);
  });

  it('reverts to the normal icon and clears the badge when the warning is cleared', async () => {
    await updateIconBasedOnAuthState(true);
    await setWarning('fts', true);
    vi.clearAllMocks();
    await setWarning('fts', false);
    expect(browser.action.setIcon).toHaveBeenCalledWith({ path: 'icons/tab.svg' });
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
    expect(browser.action.setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it('stays in warning until ALL keys are cleared (keys are independent)', async () => {
    await updateIconBasedOnAuthState(true);
    await setWarning('fts', true);
    await setWarning('consent', true);
    vi.clearAllMocks();
    await setWarning('fts', false); // consent still active → still warning, icon unchanged
    expect(browser.action.setIcon).not.toHaveBeenCalled();
    await setWarning('consent', false); // last one cleared → back to normal
    expect(browser.action.setIcon).toHaveBeenCalledWith({ path: 'icons/tab.svg' });
  });

  it('no-ops safely when the action API is unavailable', async () => {
    globalThis.browser = { action: {} };
    await expect(setWarning('fts', true)).resolves.toBeUndefined();
  });
});
