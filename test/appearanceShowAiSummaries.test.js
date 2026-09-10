/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// appearanceShowAiSummaries.test.js — config-page wiring for the
// "Show AI Summaries" checkbox (Settings → Appearance, issue #34):
// load reflects the stored preference, change persists through the helper.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getShowAiSummariesEnabled = vi.fn(async () => true);
const setShowAiSummariesEnabled = vi.fn(async () => true);
vi.mock('../agent/modules/summaryDisplaySettings.js', () => ({
  getShowAiSummariesEnabled,
  setShowAiSummariesEnabled,
}));

// Minimal DOM globals — dom.js `$` is document.getElementById
let els;
globalThis.document = {
  getElementById: (id) => (els ? els[id] || null : null),
  querySelectorAll: () => [],
};
globalThis.window = { matchMedia: undefined };

globalThis.browser = {
  tmPrefs: {
    hasUserValue: vi.fn(async () => false),
    getInt: vi.fn(async () => 0),
  },
  storage: {
    local: {
      get: vi.fn(async (keys) => {
        if (Array.isArray(keys)) return {};
        return { ...keys };
      }),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  },
  runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
};

const { loadAppearanceSettings, handleAppearanceChange } = await import(
  '../config/modules/appearance.js'
);

const SETTINGS = { appearance: { prefs: {} }, actionTagging: {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  els = {
    'show-ai-summaries': { checked: true },
    'appearance-status-text': { textContent: '', style: {} },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadAppearanceSettings — Show AI Summaries checkbox', () => {
  it('unchecks the box when the stored preference is off', async () => {
    getShowAiSummariesEnabled.mockResolvedValueOnce(false);
    await loadAppearanceSettings(SETTINGS);
    expect(els['show-ai-summaries'].checked).toBe(false);
  });

  it('checks the box when the stored preference is on (default)', async () => {
    els['show-ai-summaries'].checked = false;
    getShowAiSummariesEnabled.mockResolvedValueOnce(true);
    await loadAppearanceSettings(SETTINGS);
    expect(els['show-ai-summaries'].checked).toBe(true);
  });
});

describe('handleAppearanceChange — Show AI Summaries checkbox', () => {
  it('persists false when the user unchecks it and reports the change', async () => {
    await handleAppearanceChange(
      { target: { id: 'show-ai-summaries', name: '', value: 'on', checked: false } },
      SETTINGS,
    );
    expect(setShowAiSummariesEnabled).toHaveBeenCalledTimes(1);
    expect(setShowAiSummariesEnabled).toHaveBeenCalledWith(false);
    expect(els['appearance-status-text'].textContent).toContain('hidden');
  });

  it('persists true when the user re-checks it', async () => {
    await handleAppearanceChange(
      { target: { id: 'show-ai-summaries', name: '', value: 'on', checked: true } },
      SETTINGS,
    );
    expect(setShowAiSummariesEnabled).toHaveBeenCalledWith(true);
    expect(els['appearance-status-text'].textContent).toContain('shown');
  });

  it('ignores change events from other controls', async () => {
    await handleAppearanceChange(
      { target: { id: 'compose-hints-banner', name: '', value: 'on', checked: false } },
      SETTINGS,
    );
    expect(setShowAiSummariesEnabled).not.toHaveBeenCalled();
  });
});
