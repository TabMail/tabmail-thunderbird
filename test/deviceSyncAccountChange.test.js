/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// deviceSyncAccountChange.test.js — an account change on simulated devices (bulletDevices.js), R34: the
// account only picks the Device Sync group. A device moving between two accounts keeps everything it
// holds, so each group receives the other's texts, and nothing is lost on the device or on either group's
// peers. The same cases as the iOS app's DeviceSyncAccountChangeTests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_FIELDS } from '../agent/modules/bullets.js';
import { BulletDevice, BulletRelay, DeviceStore, SIGNED_IN } from './support/bulletDevices.js';

const WRITTEN = ['Fact from A', 'Fact from B', 'Fact from D', 'Same fact'];
/** Deliveries `quiesce` allows before it fails, so a delivery loop is a failure and not a hang. */
const MAX_DELIVERIES = 10000;

function hex(value) {
  return value.toString(16).padStart(8, '0');
}

function device(id, index, group) {
  return new BulletDevice(id, new DeviceStore(), group, { name: (k) => `${hex(index)}${hex(k)}` });
}

/** Every pending part on both groups delivered, oldest first. */
async function quiesce(groups) {
  for (let n = 0; n < MAX_DELIVERIES; n++) {
    let delivered = false;
    for (const group of groups) delivered = (await group.deliverOldest()) || delivered;
    if (!delivered) return;
  }
  throw new Error('the groups never went quiet');
}

/** `field`'s texts on `d`, in stored order. */
async function texts(d, field) {
  return (await d.state(field)).bullets.map((bullet) => bullet.text);
}

/** Every field's bullets as section and text, the order ignored. */
async function content(d) {
  const out = {};
  for (const field of SYNC_FIELDS) out[field] = (await d.state(field)).bullets.map(({ section, text }) => `${section}\u0000${text}`).sort();
  return out;
}

/** `d` signs out, as supabaseAuth.signOut does, then signs in to the account whose group is `group`, as
 * supabaseAuth.ensureSignedIn does, and Device Sync connects. */
async function signIn(d, group) {
  delete d.store.values.supabaseSession;
  await d.sync.cleanupDeviceSync();
  d.relay = group;
  d.store.values.supabaseSession = structuredClone(SIGNED_IN);
  await d.connect();
}

/** A peer on each account, and a device D signed in to A, each with its own knowledge-base fact; both
 * peers wrote "Same fact" independently. */
async function start() {
  const groupA = new BulletRelay();
  const groupB = new BulletRelay();
  const peerA = await device('PA', 1, groupA).start();
  const peerB = await device('PB', 2, groupB).start();
  const d = await device('D', 3, groupA).start();
  await peerA.connect();
  await peerB.connect();
  for (const [writer, text] of [[peerA, 'Fact from A'], [peerB, 'Fact from B'], [d, 'Fact from D'], [peerA, 'Same fact'], [peerB, 'Same fact']]) {
    expect((await writer.add('kb', '', text)).outcome).toBe('saved');
  }
  await d.connect();
  await quiesce([groupA, groupB]);
  return { groupA, groupB, d, peerA, peerB };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Device Sync account change (R34)', () => {
  it('five A to B to A alternations keep every text on the device and on both accounts\' peers, with stable line counts', async () => {
    const { groupA, groupB, d, peerA, peerB } = await start();

    const counts = [];
    for (let i = 0; i < 5; i++) {
      await signIn(d, groupB);
      await quiesce([groupA, groupB]);
      await signIn(d, groupA);
      await quiesce([groupA, groupB]);
      const count = {};
      for (const field of SYNC_FIELDS) count[field] = (await d.state(field)).bullets.length;
      counts.push(count);
    }

    const expected = await content(d);
    for (const each of [d, peerA, peerB]) {
      const kb = await texts(each, 'kb');
      expect(kb, each.id).toEqual(expect.arrayContaining(WRITTEN));
      // DS-DEDUP: one line for each text, "Same fact" included.
      expect(kb.length, `${each.id}: ${kb}`).toBe(new Set(kb).size);
      expect(await content(each), each.id).toEqual(expected);
    }
    for (const count of counts) expect(count).toEqual(counts[0]);
  });

  it('a deletion made by a device both groups have seen reaches both groups', async () => {
    const { groupA, groupB, d, peerA, peerB } = await start();
    await signIn(d, groupB);
    await quiesce([groupA, groupB]);
    await signIn(d, groupA);
    await quiesce([groupA, groupB]);
    for (const each of [d, peerA, peerB]) expect(await texts(each, 'kb'), each.id).toEqual(expect.arrayContaining(WRITTEN));

    // A's peer deletes its fact while D is on A; D carries the deletion to B.
    expect((await peerA.delete('kb', '', 'Fact from A')).outcome).toBe('saved');
    await quiesce([groupA, groupB]);
    expect(await texts(d, 'kb')).not.toContain('Fact from A');
    await signIn(d, groupB);
    await quiesce([groupA, groupB]);
    expect(await texts(peerB, 'kb')).not.toContain('Fact from A');

    // D deletes B's fact while on B; the deletion reaches A when D signs back in there.
    expect((await d.delete('kb', '', 'Fact from B')).outcome).toBe('saved');
    await quiesce([groupA, groupB]);
    expect(await texts(peerB, 'kb')).not.toContain('Fact from B');
    await signIn(d, groupA);
    await quiesce([groupA, groupB]);
    expect(await texts(peerA, 'kb')).not.toContain('Fact from B');

    for (const each of [d, peerA, peerB]) {
      const kb = await texts(each, 'kb');
      expect(kb, each.id).toEqual(expect.arrayContaining(['Fact from D', 'Same fact']));
      expect(kb, each.id).not.toContain('Fact from A');
      expect(kb, each.id).not.toContain('Fact from B');
    }
  });
});

vi.setConfig({ testTimeout: 60000 });
