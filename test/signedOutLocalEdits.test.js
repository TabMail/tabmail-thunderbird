/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// DS-DEVICE: signing out only stops AI calls and Device Sync. An edit made while signed out still gets its
// timestamp (so it wins over older peers' values at the next exchange) and its history record; a history
// record still waiting when a sign-out comes is recorded, and a template reset running when it comes is
// saved. Each case has its signed-in control, whose outcome it must equal.

import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, SIGNED_IN } from './support/bulletDevices.js';
import { createRealm } from './support/deviceRealm.js';

const EPOCH = '1970-01-01T00:00:00.000Z';
const gate = () => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
};
const MANAGER = 'agent/modules/templateManager.js';
function authOn(d) {
  return createRealm({
    files: ['agent/modules/supabaseAuth.js'],
    stubs: {
      'agent/modules/config.js': { SETTINGS: {}, getBackendUrl: async () => 'https://backend.example.com' },
      'agent/modules/utils.js': { log() {} },
      'agent/modules/deviceSync.js': d.sync,
      'agent/modules/promptStore.js': d.prompts,
    },
    globals: { browser: { storage: d.store.api() }, setTimeout, clearTimeout },
  }).require('agent/modules/supabaseAuth.js');
}

describe('local edits while signed out (R34)', () => {
  it.each([false, true])('a template edit\'s history record is kept after the quiet period (DS-HISTORY; signed out before it is recorded: %s)', async (signOut) => {
    vi.useFakeTimers();
    try {
      const store = new DeviceStore();
      // The templates page's commands run in the background, the prompt store's host.
      const a = await new BulletDevice('A', store, new BulletRelay(), { files: [MANAGER] }).start();
      const manager = a.realm.require(MANAGER);
      expect(await manager.addTemplate({ id: 'history-template', name: 'Template edit before session end' })).toMatchObject({ id: 'history-template' });
      if (signOut) expect(await authOn(a).signOut()).toBe(true);
      await vi.advanceTimersByTimeAsync(2100);
      const records = (store.values.prompt_history ?? []).filter((e) => e.source === 'local_edit' && e.fields.includes('templates'));
      await a.sync.cleanupDeviceSync();
      expect(records.length).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])('a template added reaches a peer at the next exchange (added while signed out: %s)', async (signOut) => {
    const relay = new BulletRelay();
    const aStore = new DeviceStore();
    const bStore = new DeviceStore();
    const a = await new BulletDevice('A', aStore, relay, { files: [MANAGER] }).start();
    const b = await new BulletDevice('B', bStore, relay, { files: [MANAGER] }).start();
    const aTemplates = a.realm.require(MANAGER);
    await a.connect();
    await b.connect();
    if (signOut) expect(await authOn(a).signOut()).toBe(true);
    expect(await aTemplates.addTemplate({ id: 'local-template', name: 'Locally added template' })).toMatchObject({ id: 'local-template' });
    await Promise.resolve();
    if (signOut) {
      aStore.values.supabaseSession = structuredClone(SIGNED_IN);
      await a.connect();
    }
    // A peer asks for the templates: the real legacy send and receive paths, and what the peer saves.
    await a.listener()({ type: 'message', data: JSON.stringify({ type: 'request_state', fields: ['templates'] }) });
    const offered = relay.legacy.filter(({ from, message }) => from === 'A' && message.type === 'prompt_state').at(-1);
    expect(offered).toBeDefined();
    expect(offered.message.data.templates.some((t) => t.id === 'local-template')).toBe(true);
    await b.receive(offered.message);
    const savedAtPeer = bStore.values.user_templates?.some((t) => t.id === 'local-template') ?? false;
    const ts = offered.message.data.templates_updated_at;
    await a.sync.cleanupDeviceSync();
    await b.sync.cleanupDeviceSync();
    expect(savedAtPeer).toBe(true);
    expect(ts).not.toBe(EPOCH);
  });

  it.each([false, true])('an action configuration edited locally wins over a peer\'s older one (edited while signed out: %s)', async (signOut) => {
    const relay = new BulletRelay();
    const original = { compact_threshold: 200, compact_threshold_chars: 32000 };
    const peerValue = { compact_threshold: 300, compact_threshold_chars: 48000 };
    const old = new Date(Date.now() - 20000).toISOString();
    const peerTime = new Date(Date.now() - 10000).toISOString();
    const a = await new BulletDevice('A', new DeviceStore({ 'user_prompts:action_config': original, 'device_sync_ts:actionConfig': old }), relay).start();
    const b = await new BulletDevice('B', new DeviceStore({ 'user_prompts:action_config': peerValue, 'device_sync_ts:actionConfig': peerTime }), relay).start();
    await a.connect();
    await b.connect();
    if (signOut) expect(await authOn(a).signOut()).toBe(true);
    // The prompts page's save, through the background's prompt store.
    const page = a.page(['agent/modules/actionCompactConfig.js', 'prompts/modules/storage.js', 'prompts/modules/markdown.js'], {}, {
      document: { getElementById: (id) => ({ value: id.endsWith('-chars') ? '40000' : '250' }) },
    });
    await page.require('prompts/modules/storage.js').saveActionConfig();
    if (signOut) {
      a.store.values.supabaseSession = structuredClone(SIGNED_IN);
      await a.connect();
    }
    // The prompts page's real save, both broadcasts, and what each device saves.
    await a.sync.broadcastState(['actionConfig']);
    const fromA = relay.legacy.filter(({ from, message }) => from === 'A' && message.type === 'prompt_state').at(-1).message;
    await b.receive(fromA);
    await b.sync.broadcastState(['actionConfig']);
    const fromB = relay.legacy.filter(({ from, message }) => from === 'B' && message.type === 'prompt_state').at(-1).message;
    await a.receive(fromB);
    const state = { local: a.store.values['user_prompts:action_config'], peer: b.store.values['user_prompts:action_config'] };
    await a.sync.cleanupDeviceSync();
    await b.sync.cleanupDeviceSync();
    expect(state).toEqual({ local: { compact_threshold: 250, compact_threshold_chars: 40000 }, peer: { compact_threshold: 250, compact_threshold_chars: 40000 } });
  });
  it.each([false, true])('a template reset is saved whether or not a sign-out comes during it (signed out during it: %s)', async (signOut) => {
    const store = new DeviceStore({ user_templates: [{ id: 'own', name: 'Own template' }], templates_migrated: true, prompt_history_migrated: true });
    const a = await new BulletDevice('A', store, new BulletRelay()).start();
    const manager = createRealm({
      files: ['agent/modules/templateManager.js'],
      stubs: { 'agent/modules/utils.js': { log() {} }, 'agent/modules/deviceSync.js': a.sync },
      globals: { browser: { storage: store.api(), runtime: { getURL: (path) => `moz-extension://synthetic/${path}` } }, fetch: async () => ({ ok: true, json: async () => [{ id: 'default', name: 'Default template' }] }) },
    }).require('agent/modules/templateManager.js');
    const stop = gate();
    let paused = false;
    store.beforeGet = async (keys) => {
      if (signOut && !paused && keys === 'prompt_history') { paused = true; await stop.promise; }
    };
    const reset = manager.resetToDefaultTemplates().then(() => 'reset', (e) => `refused: ${e}`);
    if (signOut) {
      await vi.waitFor(() => expect(paused).toBe(true));
      expect(await authOn(a).signOut()).toBe(true);
      stop.open();
    }
    const outcome = await reset;
    await manager.ensureMigration();
    await a.sync.cleanupDeviceSync();
    expect({ outcome: outcome.split(':')[0], ids: (store.values.user_templates ?? []).map((t) => t.id) })
      .toEqual({ outcome: 'reset', ids: ['default'] });
  });
});
