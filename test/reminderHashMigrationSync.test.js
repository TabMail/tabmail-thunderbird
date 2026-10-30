/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// reminderHashMigrationSync.test.js — when the reminder list (buildReminderList) finds a disabled entry
// stored under a message's old hash, it moves it to the hash peers share (migrateEntries). That move is a
// local edit of the disabled-reminders map: stamped in its write, sent to peers, and taken by a peer. Run
// from the background and from the chat window, on simulated devices with the real reminder store,
// prompt store and Device Sync.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';

const REMINDERS = 'agent/modules/reminderStateStore.js';
const OLD_HASH = 'm:synthetic-local-id';
const NEW_HASH = 'm:synthetic-message@example.com';
const MAP_KEY = 'disabled_reminders_v2';
const MAP_TS = 'device_sync_ts:disabledReminders';
const DAY = 86400 * 1000;

const devices = [];

afterEach(async () => {
  for (const d of devices.splice(0)) await d.sync.cleanupDeviceSync();
});

/** reminderBuilder.js's buildReminderList over `reminders` (the reminder store as one context runs it), with
 * one message reminder whose old hash is its local id and whose shared hash is its Message-ID. */
function buildReminderList(reminders) {
  const source = readFileSync(new URL('../agent/modules/reminderBuilder.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const node = ast.body.map((n) => n.declaration ?? n).find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'buildReminderList');
  const context = vm.createContext({
    ...reminders, log() {}, normalizeUnicode: (text) => text,
    collectMessageReminders: async () => [{ source: 'message', uniqueId: 'synthetic-local-id', rfc822MessageId: 'synthetic-message@example.com', content: 'Synthetic reminder' }],
    getKBReminders: async () => [], readView: async () => ({ content: '', captured: [] }),
    parseTasksFromKB: () => [], labelClaimer: () => () => [],
  });
  vm.runInContext(source.slice(node.start, node.end), context);
  return context.buildReminderList;
}

describe('the reminder list moving a disabled entry to its shared hash', () => {
  it.each(['background', 'chat window'])('from the %s, stamps the move in its write, sends it once, and a peer takes it', async (where) => {
    const old = new Date(Date.now() - DAY).toISOString();
    const relay = new BulletRelay();
    const store = new DeviceStore({ prompt_history_migrated: true, [MAP_TS]: old, [MAP_KEY]: { [OLD_HASH]: { enabled: false, ts: old } } });
    const a = await new BulletDevice('A', store, relay, { files: [REMINDERS] }).start();
    const peer = new DeviceStore({ prompt_history_migrated: true, [MAP_KEY]: {} });
    const b = await new BulletDevice('B', peer, relay, { files: [REMINDERS] }).start();
    devices.push(a, b);
    await a.connect();
    await b.connect();
    const sent = () => relay.legacy.filter(({ from, message }) => from === 'A' && message.type === 'prompt_state');
    const before = sent().length;

    const reminders = where === 'background' ? a.realm.require(REMINDERS) : a.page([REMINDERS]).require(REMINDERS);
    const listed = await buildReminderList(reminders)({ includeDisabled: true });
    expect(listed.reminders).toContainEqual(expect.objectContaining({ hash: NEW_HASH, enabled: false }));
    await vi.waitFor(() => expect(store.values[MAP_KEY][NEW_HASH]).toMatchObject({ enabled: false }));
    expect(store.values[MAP_TS] > old).toBe(true);
    // Past the broadcast debounce.
    await new Promise((resolve) => setTimeout(resolve, 650));
    const outgoing = sent().slice(before);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].message.data.disabledReminders[NEW_HASH]).toEqual(store.values[MAP_KEY][NEW_HASH]);
    expect(outgoing[0].message.data.disabledReminders_updated_at).toBe(store.values[MAP_TS]);
    await b.receive(outgoing[0].message);
    expect(peer.values[MAP_KEY][NEW_HASH]).toEqual(store.values[MAP_KEY][NEW_HASH]);
  });
});
