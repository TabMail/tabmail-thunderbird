/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// bulletDevices.js — simulated Thunderbird devices for Device Sync tests. Each device is a storage
// area and the background process running on it: the real deviceSync.js, promptStore.js,
// bulletSync.js and bullets.js in a realm of its own (deviceRealm.js), talking through a relay that
// forwards `bullet_state` between the connected devices and holds each message until the test
// delivers, reorders or drops it.

import { readFileSync } from 'node:fs';
import { parse, render } from '../../agent/modules/bullets.js';
import { createRealm } from './deviceRealm.js';

const ROOT = new URL('../../', import.meta.url);
const FILES = ['agent/modules/bullets.js', 'agent/modules/bulletSync.js', 'agent/modules/promptStore.js', 'agent/modules/deviceSync.js'];
/** A stored sign-in session: Device Sync connects only while signed in; the prompt store never asks
 * (DS-DEVICE). */
export const SIGNED_IN = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: 0 };
const CATALOG_FILE = 'agent/modules/device-sync-default-catalog.json';
export const PROMPT_KEYS = { kb: 'user_prompts:user_kb.md', composition: 'user_prompts:user_composition.md', action: 'user_prompts:user_action.md' };
export const DEFAULT_BUDGET = 126976;

export const defaultCatalog = JSON.parse(readFileSync(new URL(CATALOG_FILE, ROOT), 'utf8'));

/** A device's storage.local: values copied in and out as the real one does; the next save of the bullet
 * fields (a write with a `bullet_state` key), or every one while `failing` is set, can be made to fail,
 * as a full disk's would. */
export class DeviceStore {
  constructor(values = {}) {
    this.values = structuredClone(values);
    this.failNext = false;
    this.failing = false;
    /** The next removal of the bullet fields fails, as a full or damaged disk's can. */
    this.failRemove = false;
    this.listeners = new Set();
  }

  /** A copy of everything stored (the user copying the profile, or a backup). */
  copy() {
    return new DeviceStore(this.values);
  }

  /** Puts back everything `other` holds, as a restored backup does. */
  replaceWith(other) {
    this.values = structuredClone(other.values);
  }

  api() {
    const store = this;
    const pick = (keys) => {
      if (keys === null || keys === undefined) return structuredClone(store.values);
      if (typeof keys === 'string') return Object.hasOwn(store.values, keys) ? { [keys]: structuredClone(store.values[keys]) } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => Object.hasOwn(store.values, key)).map((key) => [key, structuredClone(store.values[key])]));
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, Object.hasOwn(store.values, key) ? structuredClone(store.values[key]) : fallback]));
    };
    const notify = (changes) => {
      if (Object.keys(changes).length === 0) return;
      Promise.resolve().then(() => { for (const listener of [...store.listeners]) listener(changes, 'local'); });
    };
    return {
      local: {
        get: async (keys) => {
          // A test can hold a read where it lands, to make something happen while it is under way.
          if (store.beforeGet) await store.beforeGet(keys);
          const values = pick(keys);
          // Or hold it after it read, so its caller goes on with what it read once something happened.
          if (store.afterIO) await store.afterIO('get', keys);
          return values;
        },
        set: async (values) => {
          if ((store.failNext || store.failing) && Object.keys(values).some((key) => key.startsWith('bullet_state:'))) {
            store.failNext = false;
            throw new Error('synthetic storage failure');
          }
          const changes = {};
          for (const [key, value] of Object.entries(structuredClone(values))) {
            changes[key] = { oldValue: store.values[key], newValue: value };
            store.values[key] = value;
          }
          notify(changes);
          // A write held after it landed: its caller goes on once something happened (never reordered).
          if (store.afterIO) await store.afterIO('set', values);
        },
        remove: async (keys) => {
          if (store.failRemove && (typeof keys === 'string' ? [keys] : keys).some((key) => key.startsWith('bullet_state:'))) {
            store.failRemove = false;
            throw new Error('synthetic storage failure');
          }
          const changes = {};
          for (const key of typeof keys === 'string' ? [keys] : keys) {
            if (!Object.hasOwn(store.values, key)) continue;
            changes[key] = { oldValue: store.values[key] };
            delete store.values[key];
          }
          notify(changes);
        },
      },
      onChanged: { addListener: (fn) => store.listeners.add(fn), removeListener: (fn) => store.listeners.delete(fn) },
    };
  }
}

/** The Device Sync relay between the test's devices: forwards each `bullet_state` part to every other
 * connected device, nothing kept. What is pending is delivered, reordered or lost as the test says.
 * The `prompt_state` and `request_state` messages a device sends are recorded in `legacy`, not
 * forwarded: the shared vectors are about `bullet_state`. */
export class BulletRelay {
  constructor() {
    this.snapshots = new Map();
    this.pending = [];
    this.legacy = [];
    /** Every send a device tried while its socket was closed (the parent refuses it). */
    this.closedSends = [];
    this.connected = new Map();
    this.counts = new Map();
    this.bySnap = new Map();
  }

  /** A send `from` tried while its socket was closed: refused by the parent, recorded here. */
  closedSend(from, text) {
    this.closedSends.push({ from, message: JSON.parse(text) });
  }

  isConnected(device) {
    return this.connected.has(device);
  }

  join(device, deliver) {
    this.connected.set(device, deliver);
  }

  leave(device) {
    this.connected.delete(device);
    this.pending = this.pending.filter((entry) => entry.to !== device);
  }

  /** How many snapshots of `field` `device` has sent. */
  sent(device, field) {
    return this.counts.get(`${device}:${field}`) ?? 0;
  }

  send(from, text) {
    const message = JSON.parse(text);
    if (message.type !== 'bullet_state') {
      this.legacy.push({ from, message });
      return;
    }
    const field = String(message.field);
    const key = `${from}:${field}`;
    const snapKey = `${key}:${message.snap}`;
    let snapshot = this.bySnap.get(snapKey);
    if (snapshot === undefined) {
      const k = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, k);
      snapshot = { id: `${key}#${k}`, from, field, parts: [] };
      this.snapshots.set(snapshot.id, snapshot);
      this.bySnap.set(snapKey, snapshot);
    }
    snapshot.parts[message.part - 1] = text;
    for (const to of this.connected.keys()) if (to !== from) this.pending.push({ snapshot, part: message.part, to });
  }

  /** Delivers `part` of `id` to `to` (again when it already was), and waits for it to be handled. */
  async deliver(id, to, part) {
    const snapshot = this.snapshots.get(id);
    if (snapshot === undefined) throw new Error(`no snapshot ${id}`);
    const index = this.pending.findIndex((entry) => entry.snapshot === snapshot && entry.to === to && entry.part === part);
    if (index >= 0) this.pending.splice(index, 1);
    const deliver = this.connected.get(to);
    if (deliver === undefined) throw new Error(`${to} isn't connected`);
    await deliver(snapshot.parts[part - 1]);
  }

  drop(id, to, parts) {
    this.pending = this.pending.filter((entry) => !(entry.snapshot.id === id && (to === undefined || to.includes(entry.to)) && (parts === undefined || parts.includes(entry.part))));
  }

  /** Delivers the oldest pending part; false when none is. */
  async deliverOldest() {
    const entry = this.pending[0];
    if (entry === undefined) return false;
    await this.deliver(entry.snapshot.id, entry.to, entry.part);
    return true;
  }
}

export function bundledFetch(catalog) {
  return async (url) => {
    const path = String(url).replace(/^moz-extension:\/\/[^/]+\//, '');
    const text = path === CATALOG_FILE ? JSON.stringify(catalog) : readFileSync(new URL(path, ROOT), 'utf8');
    return { ok: true, status: 200, text: async () => text };
  };
}

/**
 * A Thunderbird device: its store, and the background process running on it, which restarts.
 * options: { name(k) → its k-th fresh writer name (16 hex), budget (read at each send), catalog,
 * files (more of the add-on's modules to load, such as the writers), stubs (more stubs, or
 * replacements, by path) }
 */
export class BulletDevice {
  constructor(id, store, relay, options = {}) {
    this.id = id;
    this.store = store;
    this.relay = relay;
    this.options = options;
    this.names = 0;
    this.logs = [];
    this.store.values.device_sync_auto_enabled ??= true;
    this.store.values.supabaseSession ??= structuredClone(SIGNED_IN);
  }

  /** Starts the process: the background page's prompt store host (DS-UPGRADE) and the transport
   * listener, as background.js does at startup. */
  async start() {
    const device = this;
    let listener = null;
    const tmDeviceSync = {
      getState: async () => (device.relay.isConnected(device.id) ? 'open' : 'closed'),
      connect: async () => {
        device.relay.join(device.id, (text) => listener?.({ type: 'message', data: text }));
        return 'open';
      },
      disconnect: async () => device.relay.leave(device.id),
      // The parent's send throws on a socket that isn't open; the relay records the attempt.
      send: async (text) => {
        if (!device.relay.isConnected(device.id)) {
          device.relay.closedSend(device.id, text);
          throw new Error('synthetic socket not open');
        }
        device.relay.send(device.id, text);
      },
      onEvent: { addListener: (fn) => { listener = fn; }, removeListener: () => { listener = null; } },
    };
    const crypto = {
      randomUUID: () => globalThis.crypto.randomUUID(),
      getRandomValues: (array) => {
        if (!device.options.name) return globalThis.crypto.getRandomValues(array);
        if (array.length !== 8) throw new Error('a writer name is 8 bytes');
        const name = device.options.name(++device.names);
        for (let i = 0; i < 8; i++) array[i] = parseInt(name.slice(i * 2, i * 2 + 2), 16);
        return array;
      },
    };
    // A module the device is given as a file runs for real, in place of its default stub.
    const defaults = this.stubs();
    for (const file of device.options.files ?? []) delete defaults[file];
    const realm = createRealm({
      files: [...FILES, ...(device.options.files ?? [])],
      stubs: { ...defaults, ...device.options.stubs },
      expose: { 'agent/modules/promptStore.js': ['engine', 'change', 'holder', 'waiting'] },
      globals: {
        browser: { storage: this.store.api(), tmDeviceSync, runtime: { getURL: (path) => `moz-extension://synthetic/${path}` } },
        crypto,
        fetch: bundledFetch(device.options.catalog ?? defaultCatalog),
        TextEncoder,
        setTimeout, clearTimeout, setInterval, clearInterval,
        console: { log() {}, warn() {}, error() {} },
      },
    });
    this.realm = realm;
    this.sync = realm.require('agent/modules/deviceSync.js');
    this.prompts = realm.require('agent/modules/promptStore.js');
    this.bullets = realm.require('agent/modules/bullets.js');
    await this.prompts.initPromptStoreHost();
    this.sync.attachDeviceSyncTransportListener();
    this.listener = () => listener;
    return this;
  }

  /** The modules every realm on this device gets in place of the add-on's own. */
  stubs() {
    const device = this;
    return {
      'agent/modules/utils.js': { log: (message, level = 'info') => device.logs.push({ level, message: String(message) }) },
      'agent/modules/config.js': {
        SETTINGS: {
          deviceSync: { broadcastDebounceMs: 500, busyReapplyMs: device.options.busyReapplyMs ?? 20, maxWaitingReceives: device.options.maxWaitingReceives ?? 256, historyDebounceMs: 2000, get messageMaxBytes() { return device.options.budget ?? DEFAULT_BUDGET; } },
          promptSemaphore: { leaseMs: device.options.leaseMs ?? 15000, acquireWaitMs: device.options.acquireWaitMs ?? 1000 },
        },
        getDeviceSyncUrl: async () => 'https://sync.example.com',
      },
      'agent/modules/actionCompactConfig.js': { resolveActionConfig: (value) => value, readActionConfig: async () => ({}), ACTION_CONFIG_KEY: 'action_compact_config' },
      'agent/modules/supabaseAuth.js': { getAccessToken: async () => 'synthetic-token' },
      'agent/modules/taskExecutionCache.js': { getAllCachedResults: async () => ({}), mergeIncomingCache: async () => {} },
      'agent/modules/templateManager.js': { mergeTemplates: async () => {}, gcDeletedTemplates: async () => {} },
      'agent/modules/reminderStateStore.js': { mergeIncoming: async () => {} },
    };
  }

  /** A page of the add-on on this device (the prompts page, a chat window): `files` in a realm of its
   * own, which reaches the prompt store as every page does, by `runtime.sendMessage` to the background,
   * routed there as background.js routes it (`command: "prompt-store"`), each message copied both ways.
   * Returns the realm. */
  page(files) {
    const device = this;
    const sendMessage = async (message) => {
      const copy = structuredClone(message);
      if (copy?.command !== 'prompt-store') return undefined;
      return structuredClone(await device.prompts.handlePromptStoreMessage(copy));
    };
    return createRealm({
      files: [...FILES, ...files],
      stubs: this.stubs(),
      globals: {
        browser: { storage: this.store.api(), runtime: { getURL: (path) => `moz-extension://synthetic/${path}`, sendMessage } },
        crypto: globalThis.crypto,
        fetch: bundledFetch(device.options.catalog ?? defaultCatalog),
        TextEncoder,
        setTimeout, clearTimeout,
        console: { log() {}, warn() {}, error() {} },
      },
    });
  }

  async connect() {
    if (this.relay.isConnected(this.id)) return;
    await this.sync.connect();
    await this.listener()({ type: 'message', data: JSON.stringify({ type: 'connected', userId: 'synthetic-user' }) });
  }

  async disconnect() {
    await this.sync.disconnect();
  }

  /** The process ends and another opens the same store. */
  async restart() {
    await this.disconnect();
    await this.start();
  }

  /** A message delivered to this device straight from the network: on its open connection, through the
   * receive chain; on none, applied in one hold of the prompt semaphore as the chain applies it. */
  async receive(message) {
    if (this.relay.isConnected(this.id)) return this.listener()({ type: 'message', data: JSON.stringify(message) });
    const copy = structuredClone(message);
    if (copy?.type === 'prompt_state') return this.prompts.withPromptStore((store) => store.receiveLegacy(copy.data), { label: 'test receive' });
    return this.prompts.withPromptStore((store) => store.receive(copy), { label: 'test receive' });
  }

  /** `field`'s state as the engine reads it (the catalog defaults when nothing is stored yet):
   * { bullets: [{section, text, name, n}], seen: { name: n } }. */
  async state(field) {
    const { state } = await this.prompts.engine.read(field, () => true);
    return {
      bullets: state.bullets.map(({ section, text, name, n }) => ({ section, text, name, n })),
      seen: Object.fromEntries(state.seen),
    };
  }

  /** The user's edit of one section on the prompts page, from what it shows now to `texts(shown)`:
   * the whole field read, that section's lines replaced, saved (DS-CAPTURE). */
  async editSection(field, section, texts) {
    const read = await this.startEdit(field);
    return this.commitRead(field, section, read, texts);
  }

  /** `field` read now, through the prompt semaphore: { content, captured, finish }, to pass to
   * `commitRead`, which saves through `finish(content)` against the labels read: a user's edit
   * (DS-CAPTURE), which deletes only the labels read whose text it removed, whatever arrived since, and is
   * never refused for the change counter (that is for AI writes, DS-AI). */
  async startEdit(field) {
    const read = await this.prompts.withPromptStore((store) => store.view(field), { label: 'test edit' });
    const finish = (content) => this.prompts.withPromptStore((store) => store.write(field, read.captured, content), { label: 'test edit' });
    return { ...read, finish };
  }

  async commitRead(field, section, read, texts) {
    const parsed = this.bullets.parse(field, read.content);
    const shown = parsed.bullets.filter((item) => item.section === section).map((item) => item.text);
    const edited = texts(shown);
    const bullets = [...parsed.bullets.filter((item) => item.section !== section), ...edited.map((text) => ({ section, text }))]
      .map((item) => ({ ...item, name: 'default:x', n: 1 }));
    try {
      return await read.finish(this.bullets.render(field, { ...parsed, bullets }));
    } catch (e) {
      // The prompts page shows a failed save; the user's edit is not stored.
      if (String(e).includes('could not be saved')) return { outcome: 'unsaved' };
      throw e;
    }
  }

  add(field, section, text) {
    return this.editSection(field, section, (texts) => [...texts, text]);
  }

  delete(field, section, text) {
    return this.editSection(field, section, (texts) => texts.filter((other) => other !== text));
  }

  /** R10's restore of a history entry's bullet fields, in one hold of the prompt semaphore (without the
   * history record and templates deviceSync.js adds around it). */
  restore(entry) {
    return this.prompts.withPromptStore((store) => store.restore(entry));
  }

  /** The user's Reset of `field` on the prompts page. */
  reset(field) {
    return this.prompts.withPromptStore((store) => store.reset([field]));
  }
}

/** Each field's skeleton as the bundled texts have it (the knowledge base has none). */
export function builtInSkeleton(field) {
  if (field === 'kb') return { head: [], tail: [] };
  const { head, tail } = parse(field, readFileSync(new URL(`prompts/user_${field}.md`, ROOT), 'utf8'));
  return { head, tail };
}

/** Writes `states` (field → { bullets: tuples, seen: object }) into `store` as promptStore.js keeps
 * them, with each field's rendered text; fields not given stored empty. The built-in skeletons. */
export function storeStates(store, states) {
  for (const field of ['kb', 'composition', 'action']) {
    const given = states[field];
    const value = { ...builtInSkeleton(field), bullets: given?.bullets ?? [], seen: given?.seen ?? {} };
    store.values[`bullet_state:${field}`] = structuredClone(value);
    store.values[PROMPT_KEYS[field]] = render(field, {
      ...value, bullets: value.bullets.map(([section, text, name, n]) => ({ section, text, name, n })), seen: new Map(Object.entries(value.seen)),
    });
  }
}
