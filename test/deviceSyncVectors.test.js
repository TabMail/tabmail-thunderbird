/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// deviceSyncVectors.test.js — the shared Device Sync conformance vectors, run on simulated Thunderbird
// devices: each device's real deviceSync.js, promptStore.js, bulletSync.js and bullets.js, connected
// through a relay the scenario delivers, reorders and drops messages on.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EPOCH_ZERO, parse, render, trim } from '../agent/modules/bullets.js';
import { BulletDevice, BulletRelay, defaultCatalog, DeviceStore, PROMPT_KEYS, storeStates } from './support/bulletDevices.js';

// The shared conformance vectors and default catalog, byte-identical in TabMail for Thunderbird, iOS and
// Voice: a change to either is made in all three, and these hashes with it.
const VECTORS_SHA256 = 'f656a5bfffbec4597a5fb0c97b63d9b4946f13bd67eeebe8f9cf1ddcc304a4a8';
const CATALOG_SHA256 = '1ca6383ba9af86b42e13736b453cc3932297da32141aaf21a08c2055d9339f5f';

const vectorsBytes = readFileSync(new URL('./device-sync-vectors.json', import.meta.url));
const catalogBytes = readFileSync(new URL('../agent/modules/device-sync-default-catalog.json', import.meta.url));
const vectors = JSON.parse(vectorsBytes.toString('utf8'));

/** What Thunderbird syncs, and can do. */
const TB_FIELDS = ['kb', 'composition', 'action'];
const TB_CAPABILITIES = ['legacy_out'];
/** More deliveries than any scenario needs: messages that never stop. */
const MAX_DELIVERIES = 100000;

function hex(value) {
  return value.toString(16).padStart(8, '0');
}

function sortedJSON(values) {
  return values.map((value) => JSON.stringify(value)).sort();
}

class ScenarioRun {
  constructor(scenario) {
    this.scenario = scenario;
    this.relay = new BulletRelay();
    this.devices = new Map();
    this.backups = new Map();
    this.captures = new Map();
    this.specs = new Map(scenario.devices.map((spec, index) => [spec.id, { index: index + 1, spec }]));
  }

  async start() {
    for (const spec of this.scenario.devices) {
      if (spec.init === 'later') continue;
      const store = spec.init === 'shared' ? this.device(spec.store).store : this.initialStore(spec.init);
      await this.create(spec.id, store);
    }
  }

  initialStore(init) {
    const store = new DeviceStore();
    if (init === 'new') return store;
    if (init === 'empty') {
      storeStates(store, {});
      return store;
    }
    if (typeof init === 'object' && 'legacy' in init) {
      for (const [field, text] of Object.entries(init.legacy)) store.values[PROMPT_KEYS[field]] = text;
      return store;
    }
    if (typeof init === 'object' && 'state' in init) {
      storeStates(store, init.state);
      return store;
    }
    throw new Error(`unknown init ${JSON.stringify(init)}`);
  }

  async create(id, store) {
    const { index, spec } = this.specs.get(id);
    const catalog = spec.catalogExtra === undefined ? undefined : { ...defaultCatalog, defaults: [...defaultCatalog.defaults, ...spec.catalogExtra] };
    const device = new BulletDevice(id, store, this.relay, { name: (k) => `${hex(index)}${hex(k)}`, budget: this.scenario.budget, catalog });
    this.devices.set(id, device);
    await device.start();
    return device;
  }

  device(id) {
    const device = this.devices.get(String(id));
    if (device === undefined) throw new Error(`no device ${String(id)}`);
    return device;
  }

  /** Every pending part delivered to the devices that have yet to get it, oldest first. */
  async quiesce() {
    let deliveries = 0;
    while (await this.relay.deliverOldest()) {
      deliveries += 1;
      if (deliveries > MAX_DELIVERIES) throw new Error('the devices never stop sending');
    }
  }

  async run(step) {
    const field = step.field;
    switch (step.op) {
      case 'connect':
        return this.device(step.device).connect();
      case 'disconnect':
        return this.device(step.device).disconnect();
      case 'restart':
        return this.device(step.device).restart();
      case 'add':
        return this.device(step.device).add(field, step.section, step.text);
      case 'delete':
        return this.device(step.device).delete(field, step.section, step.text);
      case 'edit': {
        const [fromSection, fromText] = step.from;
        const [toSection, toText] = step.to;
        const device = this.device(step.device);
        if (fromSection === toSection) return device.editSection(field, fromSection, (texts) => texts.map((text) => (text === fromText ? toText : text)));
        await device.delete(field, fromSection, fromText);
        return device.add(field, toSection, toText);
      }
      case 'capture': {
        const device = this.device(step.device);
        this.captures.set(step.as, { device, field, section: step.section, read: await device.startEdit(field) });
        return undefined;
      }
      case 'commit': {
        const capture = this.captures.get(step.capture);
        if (capture === undefined) throw new Error(`no capture ${String(step.capture)}`);
        return capture.device.commitRead(capture.field, capture.section, capture.read, () => step.result);
      }
      case 'reset':
        return this.device(step.device).reset(field);
      case 'fail_next_save':
        this.device(step.device).store.failNext = true;
        return undefined;
      case 'copy':
        return this.create(step.to, this.device(step.from).store.copy());
      case 'backup':
        this.backups.set(step.as, this.device(step.device).store.copy());
        return undefined;
      case 'restore': {
        const device = this.device(step.device);
        await device.disconnect();
        device.store.replaceWith(this.backups.get(step.from));
        return device.restart();
      }
      case 'deliver': {
        const snapshot = this.relay.snapshots.get(step.msg);
        if (snapshot === undefined) throw new Error(`no message ${step.msg}`);
        const to = step.to ?? [...new Set(this.relay.pending.filter((entry) => entry.snapshot === snapshot).map((entry) => entry.to))];
        const parts = step.parts ?? snapshot.parts.map((_, index) => index + 1);
        for (const device of to) for (const part of parts) await this.relay.deliver(step.msg, device, part);
        return undefined;
      }
      case 'drop':
        this.relay.drop(step.msg, step.to, step.parts);
        return undefined;
      case 'quiesce':
        return this.quiesce();
      case 'raw':
        return this.device(step.to).receive(step.message);
      case 'legacy':
        return this.device(step.to).receive({ type: 'prompt_state', data: step.data });
      case 'expect':
        return this.expectState(step);
      case 'expect_sent':
        expect(this.relay.sent(step.device, step.field), `${step.device} ${step.field} snapshots sent`).toBe(step.count);
        return undefined;
      case 'expect_quiet':
        expect(this.relay.pending.map((entry) => `${entry.snapshot.id}/${entry.part} to ${entry.to}`)).toEqual([]);
        return undefined;
      case 'expect_oversize': {
        // Whether the field is held back now: what the device would send for it.
        const outgoing = await this.device(step.device).prompts.outgoingBulletState(step.field);
        expect(outgoing.kind === 'oversize', `${step.device} ${step.field} oversize`).toBe(step.value);
        return undefined;
      }
      case 'expect_legacy_out':
        return this.expectLegacyOut(this.device(step.device));
      default:
        throw new Error(`unknown op ${step.op}`);
    }
  }

  async expectState(step) {
    const device = this.device(step.device);
    const state = await device.state(step.field);
    const what = `${device.id} ${step.field}`;
    const items = state.bullets.map((bullet) => [bullet.section, bullet.text]);
    if (step.live !== undefined) expect(sortedJSON(state.bullets.map((b) => [b.section, b.text, b.name, b.n])), `${what} live`).toEqual(sortedJSON(step.live));
    if (step.texts !== undefined) expect(sortedJSON(items), `${what} texts`).toEqual(sortedJSON(step.texts));
    for (const item of step.has ?? []) expect(sortedJSON(items), `${what} has`).toContain(JSON.stringify(item));
    for (const item of step.lacks ?? []) expect(sortedJSON(items), `${what} lacks`).not.toContain(JSON.stringify(item));
    if (step.seen !== undefined) expect(Object.fromEntries(Object.entries(state.seen).sort(([a], [b]) => (a < b ? -1 : 1))), `${what} seen`).toEqual(step.seen);
    // Once stored, the rendered text every reader reads is the stored state's (DS-ATOMIC).
    const stored = device.store.values[`bullet_state:${step.field}`];
    if (stored !== undefined) {
      expect(device.store.values[PROMPT_KEYS[step.field]], `${what} rendered`).toBe(
        render(step.field, { head: stored.head, tail: stored.tail, bullets: stored.bullets.map(([section, text, name, n]) => ({ section, text, name, n })) }),
      );
    }
  }

  /** DS-LEGACY-OUT: every prompt_state the device sends, its own or in answer to a released device's
   * request_state, carries the three bullet fields empty at epoch zero. */
  async expectLegacyOut(device) {
    await device.receive({ type: 'request_state', fields: ['kb', 'composition', 'action', 'templates'] });
    await device.receive({ type: 'request_state' });
    const sent = this.relay.legacy.filter((entry) => entry.from === device.id && entry.message.type === 'prompt_state');
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const { message } of sent) {
      for (const field of TB_FIELDS) {
        expect(message.data[field]).toBe('');
        expect(message.data[`${field}_updated_at`]).toBe(EPOCH_ZERO);
      }
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the shared conformance vectors', () => {
  it('are the shared files, byte for byte', () => {
    expect(createHash('sha256').update(catalogBytes).digest('hex')).toBe(CATALOG_SHA256);
    expect(createHash('sha256').update(vectorsBytes).digest('hex')).toBe(VECTORS_SHA256);
    expect(vectors.catalogSha256).toBe(CATALOG_SHA256);
  });

  // R2: the same characters are trimmed on every platform, or a text one stores is one another refuses.
  it.each(vectors.conventions.trim)('trims U+%s at both ends and keeps it inside', (hex) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    expect(trim(`${character}${character}a${character}b${character}`)).toBe(`a${character}b`);
  });

  it('trims nothing outside the R2 list', () => {
    expect(vectors.conventions.trim).toHaveLength(25);
    expect(trim('\u200Ba\u0085\u180E')).toBe('\u200Ba\u0085\u180E');
  });

  it.each(vectors.parse)('parse $id', (vector) => {
    const parsed = parse(vector.field, vector.text);
    expect({ head: parsed.head, tail: parsed.tail, bullets: parsed.bullets.map((bullet) => [bullet.section, bullet.text]) }).toEqual({
      head: vector.head,
      tail: vector.tail,
      bullets: vector.bullets,
    });
    const rendered = render(vector.field, { ...parsed, bullets: parsed.bullets.map((bullet) => ({ ...bullet, name: 'default:x', n: 1 })) });
    if (vector.render !== undefined) expect(rendered).toBe(vector.render);
    // Stable after one round: the rendered text parses to the same bullets, each section's in order
    // (render puts a repeated section's bullets together), and renders the same.
    const again = parse(vector.field, rendered);
    const bySection = (list) => Object.groupBy(list, (bullet) => bullet.section);
    expect(bySection(again.bullets)).toEqual(bySection(parsed.bullets));
    expect(render(vector.field, { ...again, bullets: again.bullets.map((bullet) => ({ ...bullet, name: 'default:x', n: 1 })) })).toBe(rendered);
  });

  const runnable = vectors.scenarios.filter((scenario) => scenario.fields.every((field) => TB_FIELDS.includes(field)) && (scenario.requires ?? []).every((need) => TB_CAPABILITIES.includes(need)));

  it('Thunderbird runs every scenario', () => {
    expect(vectors.scenarios.filter((scenario) => !runnable.includes(scenario)).map((scenario) => scenario.id)).toEqual([]);
  });

  it.each(runnable.map((scenario) => [scenario.id, scenario]))('%s', async (_id, scenario) => {
    const run = new ScenarioRun(scenario);
    await run.start();
    for (const [index, step] of scenario.steps.entries()) {
      try {
        await run.run(step);
      } catch (error) {
        throw new Error(`step ${index + 1} (${JSON.stringify(step).slice(0, 200)}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
  });
});
