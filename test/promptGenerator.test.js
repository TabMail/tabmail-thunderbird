/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptGenerator.test.js — Tests for agent/modules/promptGenerator.js

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promptStoreHost } from './support/promptStoreHost.js';

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
    promptSemaphore: { leaseMs: 15000, retries: 2, retryBaseDelayMs: 1, retryJitterMs: 0 },
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
vi.mock('../agent/modules/templateManager.js', () => ({
  ensureMigration: vi.fn(async () => {}),
  getTemplatesAsPrimedPrompt: vi.fn(async () => ''),
}));

// The texts are read through the real client side of the prompt store, against a stand-in for the
// background (R32): `texts` is what each field reads; the getters never touch storage themselves.
const host = promptStoreHost();
const texts = {};
const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({ ...storageData })),
      set: vi.fn(async (obj) => {
        Object.assign(storageData, obj);
      }),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: {
    getURL: vi.fn((p) => `moz-extension://fake/${p}`),
    sendMessage: vi.fn(async (message) => host.answer(message)),
  },
};

const {
  getUserCompositionPrompt,
  getUserActionPrompt,
  getUserKBPrompt,
} = await import('../agent/modules/promptGenerator.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  host.clear();
  for (const key of Object.keys(texts)) delete texts[key];
  for (const key of Object.keys(storageData)) delete storageData[key];
  host.text = async (field) => texts[field] ?? '';
});

const GETTERS = [
  ['composition', getUserCompositionPrompt, 'My custom prompt\n====END USER INSTRUCTIONS===='],
  ['action', getUserActionPrompt, 'Action prompt content'],
  ['kb', getUserKBPrompt, 'KB prompt content'],
];

describe.each(GETTERS)('the %s getter', (field, getter, text) => {
  it('returns the text the prompt store reads, in one hold it releases', async () => {
    texts[field] = text;
    expect(await getter()).toContain(text.split('\n')[0]);
    expect(host.read).toHaveBeenCalledWith(expect.objectContaining({ field }));
    expect(host.release).toHaveBeenCalledTimes(1);
    expect(host.holder).toBe(null);
  });

  it('writes nothing: neither the store nor storage', async () => {
    texts[field] = text;
    await getter();
    expect(host.write).not.toHaveBeenCalled();
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(storageData).toEqual({});
  });
});
