/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// deviceSync.fuzz.test.js — Device Sync between three to six Thunderbird devices, driven by a seeded
// generator: adds, deletions, rewords, moves between sections, prompts-page edits committed from an
// older read, resets, sign-outs, restarts, failed saves, a copied profile, a restored backup, a
// released device's texts, connections coming and going, and the relay delivering, reordering,
// repeating and losing parts. A model of every label checks these invariants:
//
// - I1 (no loss): when a delivery makes a bullet's text gone from every device, each label it had was
//   deleted by a user (its deletion travelled), or was put aside by DS-DEDUP for a label that was,
//   checked at every step; at the end every label still held somewhere is held everywhere.
// - I2 (convergence): connected and settled, every device holds the same labels.
// - I3 (bounded messages): each snapshot's `seen` names exactly the bullets it carries and the ones in
//   the last snapshot the sender merged for that field (DS-SEEN-OUT), and settling ends.
// - R11: a signed-out device sends no bullet_state until it signs in again.
//
// A failure names its seed and step; DEVICE_SYNC_FUZZ_SEEDS runs more seeds.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { displayedSections, render, SYNC_FIELDS } from '../agent/modules/bullets.js';
import { BulletDevice, BulletRelay, builtInSkeleton, DeviceStore, PROMPT_KEYS, storeStates } from './support/bulletDevices.js';

const seeds = Number(process.env.DEVICE_SYNC_FUZZ_SEEDS ?? 100);
const steps = 120;
const maxDevices = 6;
/** More deliveries than settling ever needs: messages that never stop (I3). */
const maxDeliveries = 50000;
const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu'];
const future = '2099-01-01T00:00:00.000Z';

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(value) {
  return value.toString(16).padStart(8, '0');
}

/** A label, with its field: one key across the fields. */
function key(field, bullet) {
  return `${field}|${bullet.name}|${bullet.n}`;
}

function itemKey(field, bullet) {
  return `${field}|${bullet.section}|${bullet.text}`;
}

class Fuzz {
  constructor(next, budget) {
    this.next = next;
    this.budget = budget;
    this.relay = new BulletRelay();
    this.devices = [];
    /** Labels a user deleted, by any device: a delete, a reword or move, an edit committed from a read. */
    this.deleted = new Set();
    /** For a label a device dropped while its text stayed live there under another (DS-DEDUP), those
     * others: the dropped label goes with a user's deletion of one of them. */
    this.aliases = new Map();
    /** For each device and field, the names on bullets in the last snapshot it merged since its process
     * started or it signed out: what its `seen` may name besides its own bullets (DS-SEEN-OUT). */
    this.merged = new Map();
    /** Parts each device has of a sender's snapshot: by device, the message's sender and field. */
    this.buffers = new Map();
    /** Parts of each snapshot sent, by its snap, until all are in. */
    this.sending = new Map();
    /** Devices signed out and not yet back (R11). */
    this.signedOut = new Set();
    this.reads = new Map();
    this.backups = new Map();
    this.cleared = false;
    this.unique = 0;
    this.violations = [];
    this.log = [];
    this.hookRelay();
  }

  hookRelay() {
    const relay = this.relay;
    const send = relay.send.bind(relay);
    relay.send = (from, text) => {
      this.sent(from, text);
      send(from, text);
    };
    // A send tried on a closed socket never reaches the relay (the parent refuses it): R11 checks it too.
    const closedSend = relay.closedSend.bind(relay);
    relay.closedSend = (from, text) => {
      const message = JSON.parse(text);
      if (message.type === 'bullet_state' && this.signedOut.has(from)) this.violations.push(`R11: ${from} tried to send ${message.field} while signed out`);
      closedSend(from, text);
    };
    const deliver = relay.deliver.bind(relay);
    relay.deliver = async (id, to, part) => {
      const device = this.devices.find((other) => other.id === to);
      const before = device === undefined ? undefined : await this.labelsOf(device);
      const whole = this.arrived(id, to, part);
      if (whole === undefined || device === undefined) {
        await deliver(id, to, part);
      } else {
        // During the delivery the device's answer may name the snapshot's names or the last merged
        // one's; after it, only those of the snapshot it merged last.
        const merged = `${to}|${whole.field}`;
        const last = this.merged.get(merged) ?? new Set();
        this.merged.set(merged, new Set([...last, ...whole.names]));
        const engine = device.prompts.engine;
        const receive = engine.receive;
        let outcome;
        engine.receive = async (message, holds) => (outcome = await receive.call(engine, message, holds));
        try {
          await deliver(id, to, part);
        } finally {
          engine.receive = receive;
        }
        this.merged.set(merged, outcome?.kind === 'merged' ? whole.names : last);
      }
      if (device === undefined) return;
      await this.dropped(device, before);
      if (whole !== undefined) await this.mergedAside(device, whole);
    };
    const leave = relay.leave.bind(relay);
    relay.leave = (device) => {
      leave(device);
      // DS-CHUNK: incomplete snapshots are dropped on disconnect.
      for (const buffer of [...this.buffers.keys()]) if (buffer.startsWith(`${device}|`)) this.buffers.delete(buffer);
    };
  }

  async init() {
    const count = 3 + this.int(4);
    for (let index = 0; index < count; index += 1) await this.create(this.initialStore());
    return this;
  }

  int(below) {
    return Math.floor(this.next() * below);
  }

  pick(values) {
    return values[this.int(values.length)];
  }

  initialStore() {
    const store = new DeviceStore();
    const kind = this.int(3);
    if (kind === 1) storeStates(store, {});
    if (kind === 2) store.values[PROMPT_KEYS.kb] = [this.text(), this.text(), 'plain line'].map((text) => `- ${text}`).join('\n');
    return store;
  }

  async create(store) {
    const index = this.devices.length + 1;
    const device = new BulletDevice(String.fromCharCode(64 + index), store, this.relay, { name: (k) => `${hex(index)}${hex(k)}`, budget: this.budget });
    this.devices.push(device);
    await device.start();
    return device;
  }

  text() {
    if (this.next() < 0.2) return `unique ${++this.unique}`;
    return this.pick(words);
  }

  section(field) {
    return field === 'kb' ? '' : this.pick(displayedSections(field));
  }

  /** DS-SEEN-OUT, I3, R11: checked once every part of a snapshot is sent. */
  sent(from, text) {
    const message = JSON.parse(text);
    if (message.type !== 'bullet_state') return;
    if (this.signedOut.has(from)) this.violations.push(`R11: ${from} sent ${message.field} while signed out`);
    const parts = this.sending.get(message.snap) ?? [];
    parts[message.part - 1] = message;
    this.sending.set(message.snap, parts);
    if (parts.filter(Boolean).length < message.parts) return;
    this.sending.delete(message.snap);
    const own = new Set(parts.flatMap((part) => part.bullets.map(([, , name]) => name)));
    const merged = this.merged.get(`${from}|${message.field}`) ?? new Set();
    const extra = Object.keys(message.seen).filter((name) => !own.has(name) && !merged.has(name));
    if (extra.length > 0) this.violations.push(`I3: ${from}'s ${message.field} snapshot names ${extra.join(', ')} in seen, on no bullet it sends or merged last`);
    const missing = [...own].filter((name) => !Object.hasOwn(message.seen, name));
    if (missing.length > 0) this.violations.push(`DS-SEEN-OUT: ${from}'s ${message.field} snapshot's seen lacks ${missing.join(', ')}, on bullets it sends`);
  }

  /** A part arriving at `to`, buffered as the device buffers it: once its snapshot is whole, its field,
   * bullets and the names on them are returned. */
  arrived(id, to, part) {
    const snapshot = this.relay.snapshots.get(id);
    if (snapshot === undefined) return undefined;
    const message = JSON.parse(snapshot.parts[part - 1]);
    const buffer = `${to}|${message.sender}|${snapshot.field}`;
    let parts = this.buffers.get(buffer);
    if (parts === undefined || parts.snap !== message.snap) {
      parts = { snap: message.snap, parts: new Set() };
      this.buffers.set(buffer, parts);
    }
    parts.parts.add(part);
    if (parts.parts.size < message.parts) return undefined;
    this.buffers.delete(buffer);
    const field = snapshot.field;
    const bullets = snapshot.parts.flatMap((text) => JSON.parse(text).bullets);
    return { field, bullets, names: new Set(bullets.map(([, , name]) => name)) };
  }

  /** DS-DEDUP on merge: an incoming label `device` didn't keep, its text held there under another. */
  async mergedAside(device, { field, bullets }) {
    const held = new Map((await device.state(field)).bullets.map((bullet) => [itemKey(field, bullet), key(field, bullet)]));
    for (const [section, text, name, n] of bullets) {
      const label = key(field, { name, n });
      const other = held.get(itemKey(field, { section, text }));
      if (other !== undefined && other !== label) this.alias(label, other);
    }
  }

  alias(label, other) {
    this.aliases.set(label, (this.aliases.get(label) ?? new Set()).add(other));
  }

  /** `device`'s process started afresh, or it signed out: nothing merged since. */
  forgetMerged(device) {
    for (const field of SYNC_FIELDS) this.merged.delete(`${device.id}|${field}`);
  }

  /** `device`'s labels, with their texts. */
  async labelsOf(device) {
    const labels = new Map();
    for (const field of SYNC_FIELDS) for (const bullet of (await device.state(field)).bullets) labels.set(key(field, bullet), itemKey(field, bullet));
    return labels;
  }

  /** DS-DEDUP: a label `device` held `before` and dropped while its text stayed live there under another. */
  async dropped(device, before) {
    const now = await this.labelsOf(device);
    const byItem = new Map();
    for (const [label, item] of now) byItem.set(item, label);
    for (const [label, item] of before) {
      const other = byItem.get(item);
      if (now.has(label) || other === undefined) continue;
      this.alias(label, other);
    }
  }

  /** Every label held, with the devices holding it, and every text live on some device. */
  async held() {
    const labels = new Map();
    const items = new Set();
    for (const device of this.devices) {
      for (const field of SYNC_FIELDS) {
        for (const bullet of (await device.state(field)).bullets) {
          const label = key(field, bullet);
          labels.set(label, (labels.get(label) ?? new Set()).add(device.id));
          items.add(itemKey(field, bullet));
        }
      }
    }
    return { labels, items };
  }

  /** The bullets each label held names. */
  async bulletsHeld() {
    const all = new Map();
    for (const device of this.devices) for (const field of SYNC_FIELDS) for (const bullet of (await device.state(field)).bullets) all.set(key(field, bullet), { field, bullet });
    return all;
  }

  /** One step; true when it delivered parts (merges), whose disappearances I1 checks. A delivery's
   * dedup is seen by the relay's hook; any other step changes only the device it picked. */
  async step() {
    const device = this.pick(this.devices);
    const field = this.pick(SYNC_FIELDS);
    const roll = this.next();
    const before = roll < 0.36 ? undefined : await this.labelsOf(device);
    this.cleared = false;
    const delivered = await this.act(device, field, roll);
    if (before !== undefined && !this.cleared) await this.dropped(device, before);
    return delivered;
  }

  async act(device, field, roll) {
    if (roll < 0.3) {
      const count = 1 + this.int(4);
      for (let index = 0; index < count && this.relay.pending.length > 0; index += 1) {
        const entry = this.next() < 0.7 ? this.relay.pending[0] : this.pick(this.relay.pending);
        if (entry === undefined) break;
        this.log.push(`deliver ${entry.snapshot.id}/${entry.part} to ${entry.to}`);
        await this.relay.deliver(entry.snapshot.id, entry.to, entry.part);
      }
      return true;
    }
    if (roll < 0.33) {
      // A part delivered again.
      const snapshot = this.pick([...this.relay.snapshots.values()]);
      const to = this.pick(this.devices);
      if (snapshot === undefined || snapshot.from === to.id || !this.relay.isConnected(to.id)) return false;
      const part = 1 + this.int(snapshot.parts.length);
      this.log.push(`repeat ${snapshot.id}/${part} to ${to.id}`);
      await this.relay.deliver(snapshot.id, to.id, part);
      return true;
    }
    if (roll < 0.36) {
      const entry = this.pick(this.relay.pending);
      if (entry === undefined) return false;
      this.log.push(`lose ${entry.snapshot.id}/${entry.part} to ${entry.to}`);
      this.relay.drop(entry.snapshot.id, [entry.to], [entry.part]);
      return false;
    }
    if (roll < 0.48) {
      this.log.push(`${device.id} connect`);
      // Signing in again, after a sign-out.
      this.signedOut.delete(device.id);
      await device.connect();
      return false;
    }
    if (roll < 0.53) {
      this.log.push(`${device.id} disconnect`);
      await device.disconnect();
      return false;
    }
    if (roll < 0.65) {
      const section = this.section(field);
      const text = this.text();
      this.log.push(`${device.id} add ${field}/${section} ${text}`);
      await device.add(field, section, text);
      return false;
    }
    if (roll < 0.73) {
      const victim = this.pick((await device.state(field)).bullets.filter((bullet) => displayedSections(field).includes(bullet.section)));
      if (victim === undefined) return false;
      this.log.push(`${device.id} delete ${field}/${victim.section} ${victim.text}`);
      await this.markDeleted(device, field, victim.section, victim.text);
      await device.delete(field, victim.section, victim.text);
      return false;
    }
    if (roll < 0.78) {
      const victim = this.pick((await device.state(field)).bullets.filter((bullet) => displayedSections(field).includes(bullet.section)));
      if (victim === undefined) return false;
      const to = this.text();
      const section = field !== 'kb' && this.next() < 0.3 ? this.section(field) : victim.section;
      this.log.push(`${device.id} edit ${field}/${victim.section} ${victim.text} -> ${section} ${to}`);
      await this.markDeleted(device, field, victim.section, victim.text);
      if (section === victim.section) await device.editSection(field, section, (texts) => texts.map((text) => (text === victim.text ? to : text)));
      else {
        await device.delete(field, victim.section, victim.text);
        await device.add(field, section, to);
      }
      return false;
    }
    if (roll < 0.82) {
      const read = this.reads.get(device);
      if (read === undefined) {
        const section = this.section(field);
        this.log.push(`${device.id} read ${field}/${section}`);
        this.reads.set(device, { field, section, read: await device.startEdit(field) });
        return false;
      }
      this.reads.delete(device);
      const shown = read.read.captured.filter(([section]) => section === read.section);
      const result = shown.filter(() => this.next() < 0.6).map(([, text]) => text);
      if (this.next() < 0.5) result.push(this.text());
      this.log.push(`${device.id} commit ${read.field}/${read.section} [${result.join(', ')}]`);
      for (const [section, text, name, n] of shown) if (!result.includes(text)) this.deleted.add(key(read.field, { section, text, name, n }));
      await device.commitRead(read.field, read.section, read.read, () => result);
      return false;
    }
    if (roll < 0.85) {
      this.log.push(`${device.id} reset ${field}`);
      this.cleared = true;
      try {
        await device.reset(field);
      } catch (e) {
        // A failed save: the prompts page shows it, and nothing changed.
        if (!String(e).includes('could not be reset')) throw e;
      }
      return false;
    }
    if (roll < 0.88) {
      this.log.push(`${device.id} restart`);
      this.reads.delete(device);
      this.forgetMerged(device);
      await device.restart();
      return false;
    }
    if (roll < 0.9) {
      this.log.push(`${device.id} next save fails`);
      device.store.failNext = true;
      return false;
    }
    if (roll < 0.92) {
      if (this.devices.length >= maxDevices) return false;
      const copy = await this.create(device.store.copy());
      this.log.push(`${device.id} copied to ${copy.id}`);
      return false;
    }
    if (roll < 0.95) {
      const backup = this.backups.get(device);
      if (backup === undefined || this.next() < 0.5) {
        this.log.push(`${device.id} backup`);
        this.backups.set(device, device.store.copy());
        return false;
      }
      this.log.push(`${device.id} restore`);
      this.cleared = true;
      this.reads.delete(device);
      this.forgetMerged(device);
      await device.disconnect();
      device.store.replaceWith(backup);
      await device.restart();
      return false;
    }
    if (roll < 0.97) {
      // Signing out, as supabaseAuth.signOut does: the connection closed, the prompt store not reached
      // (DS-DEVICE). Nothing is removed: every bullet must stay.
      // A prompts-page read before it still commits: a user's edit is never refused (DS-CAPTURE).
      this.log.push(`${device.id} sign-out`);
      this.signedOut.add(device.id);
      await device.disconnect();
      return false;
    }
    const texts = [this.text(), this.text()];
    this.log.push(`${device.id} legacy ${field} [${texts.join(', ')}]`);
    const section = this.section(field);
    const text = render(field, { ...builtInSkeleton(field), bullets: texts.map((line) => ({ section, text: line, name: 'default:x', n: 1 })) });
    await device.receive({ type: 'prompt_state', data: { [field]: text, [`${field}_updated_at`]: future } });
    return false;
  }

  /** The labels `device` shows for a text a user deletes there. */
  async markDeleted(device, field, section, text) {
    for (const bullet of (await device.state(field)).bullets) if (bullet.section === section && bullet.text === text) this.deleted.add(key(field, bullet));
  }

  /** A label no device holds any more went with a user's deletion: its own, or that of a label DS-DEDUP
   * kept in its place. */
  justified(field, bullet) {
    const seen = new Set();
    const pending = [key(field, bullet)];
    for (let label = pending.pop(); label !== undefined; label = pending.pop()) {
      if (this.deleted.has(label)) return true;
      if (seen.has(label)) continue;
      seen.add(label);
      pending.push(...(this.aliases.get(label) ?? []));
    }
    return false;
  }

  /** Every device signed in and connected afresh, and everything delivered (I3). */
  async settle() {
    for (const device of this.devices) device.store.failNext = false;
    for (const device of this.devices) await device.disconnect();
    this.signedOut.clear();
    for (const device of this.devices) await device.connect();
    let deliveries = 0;
    while (await this.relay.deliverOldest()) {
      deliveries += 1;
      if (deliveries > maxDeliveries) throw new Error('I3: the devices never stop sending');
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test(`Device Sync keeps every bullet no user deleted, converges, and goes quiet (${seeds} seeds)`, { timeout: 1200000 }, async () => {
  for (let seed = 1; seed <= seeds; seed += 1) {
    // Let the test runner's own messages through between seeds.
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));
    vi.useFakeTimers();
    const next = random(seed);
    const fuzz = await new Fuzz(next, next() < 0.3 ? 1500 + Math.floor(next() * 1500) : undefined).init();
    const fail = (message) => {
      throw new Error(`seed ${seed}: ${message}\n${fuzz.log.slice(-40).join('\n')}`);
    };
    try {
      for (let index = 0; index < steps; index += 1) {
        const bullets = await fuzz.bulletsHeld();
        const delivered = await fuzz.step();
        if (fuzz.violations.length > 0) fail(`step ${index + 1}: ${fuzz.violations.join('; ')}`);
        if (!delivered) continue;
        // I1 at every merge: a text gone from every device lost only labels a user deleted.
        const after = await fuzz.held();
        for (const [label, { field, bullet }] of bullets) {
          if (after.labels.has(label) || after.items.has(itemKey(field, bullet))) continue;
          if (!fuzz.justified(field, bullet)) fail(`step ${index + 1}: I1: "${bullet.text}" (${label}) gone from every device, and no user deleted it`);
        }
      }
      const bullets = await fuzz.bulletsHeld();
      await fuzz.settle();
      if (fuzz.violations.length > 0) fail(`settling: ${fuzz.violations.join('; ')}`);
      const after = await fuzz.held();
      for (const [label, { field, bullet }] of bullets) {
        if (after.labels.has(label) || after.items.has(itemKey(field, bullet)) || fuzz.justified(field, bullet)) continue;
        fail(`I1: "${bullet.text}" (${label}) gone after settling, and no user deleted it`);
      }
      // I2: every device holds the same labels.
      for (const field of SYNC_FIELDS) {
        const first = JSON.stringify((await fuzz.devices[0].state(field)).bullets.map((bullet) => key(field, bullet)).sort());
        for (const device of fuzz.devices) {
          const labels = JSON.stringify((await device.state(field)).bullets.map((bullet) => key(field, bullet)).sort());
          if (labels !== first) fail(`I2: ${device.id}'s ${field} ${labels} differs from A's ${first}`);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`seed ${seed}:`)) throw error;
      fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
  }
  expect(seeds).toBeGreaterThan(0);
});
