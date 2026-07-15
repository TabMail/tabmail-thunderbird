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
  // Reset DOM element stubs for both sliders
  _domElements['action-compact-threshold'] = makeDomElement(100);
  _domElements['action-compact-threshold-val'] = makeDomElement(100);
  _domElements['action-compact-threshold-chars'] = makeDomElement(16000);
  _domElements['action-compact-threshold-chars-val'] = makeDomElement(16000);
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

  // (e) compact_threshold_chars — load default
  it('(e) sets compact_threshold_chars slider to default 16000 when storage is empty', async () => {
    globalThis.browser.storage.local.get.mockResolvedValueOnce({});

    await loadActionConfig();

    const slider = _domElements['action-compact-threshold-chars'];
    const display = _domElements['action-compact-threshold-chars-val'];
    expect(Number(slider.value)).toBe(16000);
    expect(display.textContent).toBe('16000');
  });

  // (e) compact_threshold_chars — load custom stored value
  it('(e) sets compact_threshold_chars slider to stored custom value', async () => {
    globalThis.browser.storage.local.get.mockResolvedValueOnce({
      'user_prompts:action_config': { compact_threshold: 150, compact_threshold_chars: 12000 },
    });

    await loadActionConfig();

    const slider = _domElements['action-compact-threshold-chars'];
    const display = _domElements['action-compact-threshold-chars-val'];
    expect(Number(slider.value)).toBe(12000);
    expect(display.textContent).toBe('12000');
  });
});

describe('saveActionConfig — defaults', () => {
  it('writes default 100 and 16000 when sliders are at defaults', async () => {
    _domElements['action-compact-threshold'] = makeDomElement(100);
    _domElements['action-compact-threshold-chars'] = makeDomElement(16000);

    await saveActionConfig();

    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:action_config': { compact_threshold: 100, compact_threshold_chars: 16000 },
    });
  });

  it('writes custom value from compact_threshold slider', async () => {
    _domElements['action-compact-threshold'] = makeDomElement(250);
    _domElements['action-compact-threshold-chars'] = makeDomElement(16000);

    await saveActionConfig();

    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:action_config': { compact_threshold: 250, compact_threshold_chars: 16000 },
    });
  });

  it('falls back to default compact_threshold when slider element is absent', async () => {
    _domElements['action-compact-threshold'] = null;
    _domElements['action-compact-threshold-chars'] = makeDomElement(16000);

    await saveActionConfig();

    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:action_config': { compact_threshold: 100, compact_threshold_chars: 16000 },
    });
  });

  // (e) compact_threshold_chars — save roundtrip with custom value
  it('(e) writes custom compact_threshold_chars from slider', async () => {
    _domElements['action-compact-threshold'] = makeDomElement(100);
    _domElements['action-compact-threshold-chars'] = makeDomElement(20000);

    await saveActionConfig();

    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:action_config': { compact_threshold: 100, compact_threshold_chars: 20000 },
    });
  });

  // (e) compact_threshold_chars — falls back to default when chars slider absent
  it('(e) falls back to default compact_threshold_chars when chars slider element is absent', async () => {
    _domElements['action-compact-threshold'] = makeDomElement(100);
    _domElements['action-compact-threshold-chars'] = null;

    await saveActionConfig();

    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:action_config': { compact_threshold: 100, compact_threshold_chars: 16000 },
    });
  });
});
