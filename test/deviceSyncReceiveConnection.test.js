/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A sign-out never waits (DS-DEVICE), a section reset commits against the labels it showed (DS-DISPLAYED),
// and a refine whose model answers after a sign-out is saved like any device data (DS-DEVICE). These run the
// real Device Sync, prompt store and engine modules on simulated devices, pausing an apply at a read inside
// its hold, or a reset at its defaults fetch, while something else happens.

import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, PROMPT_KEYS } from './support/bulletDevices.js';
import { createRealm } from './support/deviceRealm.js';

/** Bounds every relay flush: a test that would loop fails instead. */
const MAX_DELIVERIES = 100;

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

async function flush(relay) {
  for (let i = 0; i < MAX_DELIVERIES; ++i) if (!(await relay.deliverOldest())) return;
  throw new Error('relay flush exceeded its bound');
}

async function connected(options = {}) {
  const relay = new BulletRelay();
  const a = await new BulletDevice('A', new DeviceStore(), relay, options).start();
  const b = await new BulletDevice('B', new DeviceStore(), relay, options).start();
  await a.connect();
  await b.connect();
  await flush(relay);
  return { a, b, relay };
}

/** The real supabaseAuth on device `d`. */
function authOn(d) {
  return createRealm({
    files: ['agent/modules/supabaseAuth.js'],
    stubs: {
      'agent/modules/config.js': { SETTINGS: {}, getBackendUrl: async () => 'https://backend.example.com' },
      'agent/modules/utils.js': { log() {} },
      'agent/modules/deviceSync.js': d.sync,
      'agent/modules/promptStore.js': d.prompts,
    },
    globals: { browser: { storage: d.store.api() }, atob: globalThis.atob, setTimeout, clearTimeout },
  }).require('agent/modules/supabaseAuth.js');
}

/** Pauses `d`'s first read of the prompt history: a merge reads it in its hold, just before it commits. */
function pauseAtHistoryRead(d) {
  const stop = gate();
  const state = { paused: false, open: stop.open };
  d.store.beforeGet = async (keys) => {
    if (keys === 'prompt_history' && !state.paused) {
      state.paused = true;
      await stop.promise;
    }
  };
  return state;
}

describe('a received message and a sign-out (DS-RECEIVE, DS-DEVICE)', () => {
  it('a snapshot whose merge pauses inside its hold is saved', async () => {
    const { a, b, relay } = await connected();
    await b.add('kb', '', 'Peer note on a live connection');
    const part = relay.pending.find((e) => e.to === 'A' && e.snapshot.field === 'kb');
    const pause = pauseAtHistoryRead(a);
    const delivery = relay.deliver(part.snapshot.id, 'A', part.part);
    await vi.waitFor(() => expect(pause.paused).toBe(true));
    pause.open();
    await delivery;
    expect(a.store.values[PROMPT_KEYS.kb]).toContain('Peer note on a live connection');
  });

  it('a sign-out never waits for a merge paused in its hold, and keeps the stored texts (DS-DEVICE)', async () => {
    const { a, b, relay } = await connected();
    await a.add('kb', '', 'Own note');
    await flush(relay);
    await b.add('kb', '', 'Peer note');
    const part = relay.pending.find((e) => e.to === 'A' && e.snapshot.field === 'kb');
    expect(part).toBeDefined();
    const pause = pauseAtHistoryRead(a);
    const delivery = relay.deliver(part.snapshot.id, 'A', part.part);
    let signedOut;
    try {
      await vi.waitFor(() => expect(pause.paused).toBe(true));
      // Awaited before the merge may go on: a sign-out that waited for it would never return.
      signedOut = await authOn(a).signOut();
    } finally {
      pause.open();
    }
    await delivery;
    expect(signedOut).toBe(true);
    expect(a.store.values.supabaseSession).toBeUndefined();
    expect(a.store.values[PROMPT_KEYS.kb]).toContain('Own note');
  });
});

describe('a section reset and a newer action (DS-DISPLAYED)', () => {
  /** The prompts page's storage module on a fresh device holding a line in the general writing style, the
   * page's view read, and the section's Reset started on it with its defaults fetch paused until `open()`. */
  async function pausedSectionReset() {
    const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay()).start();
    await a.add('composition', 'general', 'Line the reset replaces');
    const page = a.page(['prompts/modules/storage.js', 'prompts/modules/markdown.js']);
    const storage = page.require('prompts/modules/storage.js');
    const view = await page.require('agent/modules/promptStore.js').readView('composition');
    expect(view.content).toContain('Line the reset replaces');
    const fetchDefaults = page.context.fetch;
    const stop = gate();
    const state = { paused: false };
    page.context.fetch = async (url) => {
      const response = await fetchDefaults(url);
      state.paused = true;
      await stop.promise;
      return response;
    };
    const resetting = storage.resetSection('composition', view, { key: 'general', copy: 0 })
      .then((value) => ({ value }), (error) => ({ error: String(error) }));
    await vi.waitFor(() => expect(state.paused).toBe(true));
    return { a, resetting, open: stop.open };
  }

  it('a section reset whose defaults arrive after a whole-field reset and a newer line keeps the newer line', async () => {
    const { a, resetting, open } = await pausedSectionReset();
    try {
      await a.reset('composition');
      await a.add('composition', 'general', 'Newer user action');
    } finally {
      open();
    }
    // It deletes only the labels it showed, which the whole-field reset already removed, and the defaults it
    // adds are already there: nothing is left for it to change. It never re-reads the text, so the newer line
    // of the section is not taken for one it replaces.
    expect(await resetting).toEqual({ value: 'unchanged' });
    expect(a.store.values[PROMPT_KEYS.composition]).toContain('Newer user action');
    expect(a.store.values[PROMPT_KEYS.composition]).not.toContain('Line the reset replaces');
  });

  it('a section reset with nothing else happening while it fetches is saved', async () => {
    const { a, resetting, open } = await pausedSectionReset();
    open();
    expect(await resetting).toEqual({ value: 'saved' });
    expect(a.store.values[PROMPT_KEYS.composition]).not.toContain('Line the reset replaces');
  });
});

describe('a refine whose model answers after a sign-out (DS-DEVICE)', () => {
  /** knowledgebase.js on device `a`, reaching the prompt store as a page does (each message copied), with
   * `whileAsking()` run while its model call is in flight. Counts the sessions indexed and remembered. */
  function refineOn(a, whileAsking) {
    const counts = { indexed: 0, remembered: 0 };
    const realm = createRealm({
      files: ['agent/modules/knowledgebase.js', 'agent/modules/promptStore.js', 'agent/modules/bulletSync.js', 'agent/modules/bullets.js', 'agent/modules/retryWithBackoff.js'],
      stubs: {
        'agent/modules/utils.js': { log() {}, saveChatLog() {}, normalizeUnicode: (t) => t },
        'agent/modules/config.js': { SETTINGS: { promptSemaphore: { retries: 1, retryBaseDelayMs: 1, retryJitterMs: 0 }, events: {} } },
        'agent/modules/llm.js': { sendChat: async () => { await whileAsking(); return { refined_kb: '- Refined note' }; } },
        'agent/modules/chatHistoryQueue.js': {
          addChatToQueue: async () => 'session-one',
          getUnrememberedSessions: async () => [{ id: 'session-one', timestamp: Date.now(), messages: [{ role: 'user', content: 'Synthetic question' }] }],
          markSessionsAsRemembered: async () => { counts.remembered++; },
        },
        'chat/modules/helpers.js': { formatTimestampForAgent: () => 'now', renderToPlainText: async (text) => text },
        'fts/memoryIndexer.js': { indexChatSession: async () => { counts.indexed++; } },
      },
      globals: {
        browser: { storage: a.store.api(), runtime: { sendMessage: async (message) => {
          return structuredClone(await a.prompts.handlePromptStoreMessage(structuredClone(message)));
        } } },
        crypto: globalThis.crypto, TextEncoder, setTimeout, clearTimeout,
      },
    });
    return { counts, kbUpdate: realm.require('agent/modules/knowledgebase.js').kbUpdate };
  }

  it('a refine whose model answers after a sign-out is saved, indexed and marked: the sign-out drops nothing pending', async () => {
    const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay()).start();
    await a.add('kb', '', 'Stored note');
    const { counts, kbUpdate } = refineOn(a, async () => {
      expect(await authOn(a).signOut()).toBe(true);
    });
    await kbUpdate([{ role: 'user', content: 'Synthetic question' }]);
    expect(a.store.values.supabaseSession).toBeUndefined();
    expect(a.store.values[PROMPT_KEYS.kb]).toContain('Refined note');
    expect(counts).toMatchObject({ indexed: 1, remembered: 1 });
  });

  it('the same refine with nothing in between is saved, indexed and marked', async () => {
    const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay()).start();
    await a.add('kb', '', 'Stored note');
    const { counts, kbUpdate } = refineOn(a, async () => {});
    await kbUpdate([{ role: 'user', content: 'Synthetic question' }]);
    expect(a.store.values[PROMPT_KEYS.kb]).toContain('Refined note');
    expect(counts).toMatchObject({ indexed: 1, remembered: 1 });
  });
});
