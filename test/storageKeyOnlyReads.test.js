/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The prompt texts are read only through the prompt store (R32). The diagnostics and settings that read
// storage name the keys they need, never the whole of it: the index checkpoint tools and the web-search
// setting, each doing its job without reading a prompt text.

import { expect, it } from 'vitest';
import { createRealm } from './support/deviceRealm.js';

const PROMPT_KEY = 'user_prompts:user_kb.md';

it('the checkpoint tools list the keys, then read and remove only the checkpoints', async () => {
  const reads = [];
  const removed = [];
  const values = { 'fts_ckp:folder-one': { cursor: 21 }, [PROMPT_KEY]: '- Private note' };
  const realm = createRealm({
    files: ['fts/engine.js'],
    stubs: {
      'agent/modules/config.js': { SETTINGS: {} },
      'agent/modules/utils.js': { log() {} },
      'fts/nativeEngine.js': {},
      'fts/operationCoordinator.js': {},
    },
    globals: { browser: { storage: { local: {
      getKeys: async () => Object.keys(values),
      get: async (keys) => {
        reads.push(keys);
        return keys == null ? structuredClone(values) : Object.fromEntries(keys.map((key) => [key, values[key]]));
      },
      remove: async (keys) => { removed.push(...keys); },
    } } } },
  });
  const { ftsSearch } = realm.require('fts/engine.js');
  expect(await ftsSearch.debugCheckpoints()).toEqual({ checkpointKeys: 1, data: { 'fts_ckp:folder-one': { cursor: 21 } } });
  expect(await ftsSearch.clearCheckpoints()).toEqual({ ok: true, clearedKeys: 1 });
  expect(reads).toEqual([['fts_ckp:folder-one']]);
  expect(removed).toEqual(['fts_ckp:folder-one']);
});

it('the web-search setting is loaded from its own key, without reading a prompt text', async () => {
  const reads = [];
  const checkbox = {};
  const realm = createRealm({
    files: ['config/modules/webSearch.js'],
    stubs: { 'config/modules/dom.js': { $: () => checkbox } },
    globals: { browser: { storage: { local: {
      getKeys: async () => ['webSearchEnabled', PROMPT_KEY],
      get: async (keys) => {
        reads.push(keys);
        return keys == null ? { webSearchEnabled: true, [PROMPT_KEY]: '- Private note' } : { webSearchEnabled: true };
      },
    } } } },
  });
  await realm.require('config/modules/webSearch.js').loadWebSearchSettings(() => {});
  expect(checkbox.checked).toBe(true);
  // Its own key, then, for the diagnostic log, only the stored keys that name the setting.
  expect(reads).toEqual([{ webSearchEnabled: false }, ['webSearchEnabled']]);
});
