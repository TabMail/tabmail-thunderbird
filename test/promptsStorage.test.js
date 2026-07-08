/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptsStorage.test.js — Tests for prompts/modules/storage.js action config functions

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

// Minimal DOM stubs (storage.js calls document.getElementById for slider sync)
const makeDomElement = (value) => ({
  value: String(value),
  textContent: '',
});

const _domElements = {};
globalThis.document = {
  getElementById: vi.fn((id) => _domElements[id] || null),
};

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
  },
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { loadActionConfig, saveActionConfig } = await import('../prompts/modules/storage.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset DOM element stubs
  _domElements['action-compact-threshold'] = makeDomElement(100);
  _domElements['action-compact-threshold-val'] = makeDomElement(100);
});

describe('loadActionConfig — defaults', () => {
  it('sets slider to default 100 when storage is empty', async () => {
    globalThis.browser.storage.local.get.mockResolvedValueOnce({});

    await loadActionConfig();

    const slider = _domElements['action-compact-threshold'];
    const display = _domElements['action-compact-threshold-val'];
    // slider.value is set to the numeric value (not coerced to string in the stub)
    expect(Number(slider.value)).toBe(100);
    expect(display.textContent).toBe('100');
  });

  it('sets slider to stored value when present', async () => {
    globalThis.browser.storage.local.get.mockResolvedValueOnce({
      'user_prompts:action_config': { compact_threshold: 200 },
    });

    await loadActionConfig();

    const slider = _domElements['action-compact-threshold'];
    const display = _domElements['action-compact-threshold-val'];
    expect(Number(slider.value)).toBe(200);
    expect(display.textContent).toBe('200');
  });
});

describe('saveActionConfig — defaults', () => {
  it('writes default 100 when slider value is 100', async () => {
    _domElements['action-compact-threshold'] = makeDomElement(100);

    await saveActionConfig();

    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:action_config': { compact_threshold: 100 },
    });
  });

  it('writes custom value from slider', async () => {
    _domElements['action-compact-threshold'] = makeDomElement(250);

    await saveActionConfig();

    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:action_config': { compact_threshold: 250 },
    });
  });

  it('falls back to default when slider element is absent', async () => {
    _domElements['action-compact-threshold'] = null;

    await saveActionConfig();

    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:action_config': { compact_threshold: 100 },
    });
  });
});
