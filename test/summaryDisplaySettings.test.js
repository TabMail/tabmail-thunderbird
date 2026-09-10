/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// summaryDisplaySettings.test.js — Tests for agent/modules/summaryDisplaySettings.js
// ("Show AI Summaries" display preference, issue #34)

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
let failReads = false;
let failWrites = false;
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrDefault) => {
        if (failReads) throw new Error('storage read failed');
        const result = {};
        for (const [k, def] of Object.entries(keyOrDefault)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        if (failWrites) throw new Error('storage write failed');
        Object.assign(storageData, obj);
      }),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const {
  SUMMARY_DISPLAY_STORAGE_KEYS,
  SUMMARY_DISPLAY_DEFAULTS,
  getShowAiSummariesEnabled,
  setShowAiSummariesEnabled,
} = await import('../agent/modules/summaryDisplaySettings.js');

beforeEach(() => {
  vi.clearAllMocks();
  failReads = false;
  failWrites = false;
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
});

describe('SUMMARY_DISPLAY_STORAGE_KEYS / DEFAULTS', () => {
  it('uses the showAiSummariesEnabled key and defaults to shown', () => {
    expect(SUMMARY_DISPLAY_STORAGE_KEYS.showAiSummaries).toBe('showAiSummariesEnabled');
    expect(SUMMARY_DISPLAY_DEFAULTS.showAiSummariesEnabled).toBe(true);
  });
});

describe('getShowAiSummariesEnabled', () => {
  it('returns true when nothing is stored (default ON)', async () => {
    expect(await getShowAiSummariesEnabled()).toBe(true);
  });

  it('returns false only for an explicit stored false', async () => {
    storageData.showAiSummariesEnabled = false;
    expect(await getShowAiSummariesEnabled()).toBe(false);
  });

  it('returns true for an explicit stored true', async () => {
    storageData.showAiSummariesEnabled = true;
    expect(await getShowAiSummariesEnabled()).toBe(true);
  });

  it('treats a malformed stored value as shown rather than hidden', async () => {
    storageData.showAiSummariesEnabled = 'no';
    expect(await getShowAiSummariesEnabled()).toBe(true);
  });

  it('fails open (shown) when storage reads throw', async () => {
    failReads = true;
    expect(await getShowAiSummariesEnabled()).toBe(true);
  });
});

describe('setShowAiSummariesEnabled', () => {
  it('persists false and reads back hidden', async () => {
    expect(await setShowAiSummariesEnabled(false)).toBe(true);
    expect(storageData.showAiSummariesEnabled).toBe(false);
    expect(await getShowAiSummariesEnabled()).toBe(false);
  });

  it('persists true and reads back shown', async () => {
    storageData.showAiSummariesEnabled = false;
    expect(await setShowAiSummariesEnabled(true)).toBe(true);
    expect(storageData.showAiSummariesEnabled).toBe(true);
    expect(await getShowAiSummariesEnabled()).toBe(true);
  });

  it('coerces non-boolean input to true (only an explicit false hides)', async () => {
    await setShowAiSummariesEnabled(undefined);
    expect(storageData.showAiSummariesEnabled).toBe(true);
  });

  it('returns false and leaves storage untouched when the write throws', async () => {
    failWrites = true;
    expect(await setShowAiSummariesEnabled(false)).toBe(false);
    expect(storageData.showAiSummariesEnabled).toBeUndefined();
  });
});
