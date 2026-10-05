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
    onChanged: { addListener: vi.fn() },
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
  _domElements['action-compact-threshold'] = makeDomElement(200);
  _domElements['action-compact-threshold-val'] = makeDomElement(200);
  _domElements['action-compact-threshold-chars'] = makeDomElement(32000);
  _domElements['action-compact-threshold-chars-val'] = makeDomElement(32000);
});

describe('loadActionConfig — defaults', () => {
  it('sets slider to default 200 when storage is empty', async () => {
    globalThis.browser.storage.local.get.mockResolvedValueOnce({});

    await loadActionConfig();

    const slider = _domElements['action-compact-threshold'];
    const display = _domElements['action-compact-threshold-val'];
    // slider.value is set to the numeric value (not coerced to string in the stub)
    expect(Number(slider.value)).toBe(200);
    expect(display.textContent).toBe('200');
  });

  it('sets slider to stored value when present', async () => {
    globalThis.browser.storage.local.get.mockResolvedValueOnce({
      'user_prompts:action_config': { compact_threshold: 250 },
    });

    await loadActionConfig();

    const slider = _domElements['action-compact-threshold'];
    const display = _domElements['action-compact-threshold-val'];
    expect(Number(slider.value)).toBe(250);
    expect(display.textContent).toBe('250');
  });

  it('applies the configured slider ranges', async () => {
    globalThis.browser.storage.local.get.mockResolvedValueOnce({});

    await loadActionConfig();

    expect(_domElements['action-compact-threshold']).toMatchObject({ min: 100, max: 500, step: 10 });
    expect(_domElements['action-compact-threshold-chars']).toMatchObject({ min: 16000, max: 80000, step: 1000 });
  });

  it('shows never-edited legacy defaults as the current defaults and clamps out-of-range values', async () => {
    globalThis.browser.storage.local.get.mockResolvedValueOnce({
      'user_prompts:action_config': { compact_threshold: 100, compact_threshold_chars: 16000 },
    });
    await loadActionConfig();
    expect(Number(_domElements['action-compact-threshold'].value)).toBe(200);
    expect(Number(_domElements['action-compact-threshold-chars'].value)).toBe(32000);

    globalThis.browser.storage.local.get.mockResolvedValueOnce({
      'user_prompts:action_config': { compact_threshold: 40, compact_threshold_chars: 6000 },
    });
    await loadActionConfig();
    expect(_domElements['action-compact-threshold-val'].textContent).toBe('100');
    expect(_domElements['action-compact-threshold-chars-val'].textContent).toBe('16000');
  });

  // (e) compact_threshold_chars — load default
  it('(e) sets compact_threshold_chars slider to default 32000 when storage is empty', async () => {
    globalThis.browser.storage.local.get.mockResolvedValueOnce({});

    await loadActionConfig();

    const slider = _domElements['action-compact-threshold-chars'];
    const display = _domElements['action-compact-threshold-chars-val'];
    expect(Number(slider.value)).toBe(32000);
    expect(display.textContent).toBe('32000');
  });

  // (e) compact_threshold_chars — load custom stored value
  it('(e) sets compact_threshold_chars slider to stored custom value', async () => {
    globalThis.browser.storage.local.get.mockResolvedValueOnce({
      'user_prompts:action_config': { compact_threshold: 150, compact_threshold_chars: 24000 },
    });

    await loadActionConfig();

    const slider = _domElements['action-compact-threshold-chars'];
    const display = _domElements['action-compact-threshold-chars-val'];
    expect(Number(slider.value)).toBe(24000);
    expect(display.textContent).toBe('24000');
  });
});

describe('saveActionConfig — defaults', () => {
  it('writes default 200 and 32000 when sliders are at defaults', async () => {
    _domElements['action-compact-threshold'] = makeDomElement(200);
    _domElements['action-compact-threshold-chars'] = makeDomElement(32000);

    await saveActionConfig();

    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:action_config': { compact_threshold: 200, compact_threshold_chars: 32000 },
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
      'user_prompts:action_config': { compact_threshold: 200, compact_threshold_chars: 16000 },
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
      'user_prompts:action_config': { compact_threshold: 100, compact_threshold_chars: 32000 },
    });
  });
});
