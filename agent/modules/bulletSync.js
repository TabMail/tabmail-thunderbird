/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One device's Device Sync of its labelled bullets: the local operations, each one read-change-save
 * commit, the messages it sends and the merge of those it receives. It has no lock of its own: every
 * call runs inside a hold of the device's prompt semaphore (DS-LOCK, promptStore.js), which is the only
 * serialization, and every write asks `holds()` again at the write (DS-LEASE). Free of the transport and
 * of storage: the caller sends what `outgoing` gives, passes `receive` what arrives, and supplies the
 * store.
 *
 * store: {
 *   read(field) → Promise<state | null>,        the field as stored, null when there is none yet
 *   legacyText(field) → Promise<string | null>, the text kept before labelled bullets (DS-UPGRADE)
 *   write(states, kind, holds) → Promise<boolean | "stale">, every state given in one atomic write
 *                                               (DS-ATOMIC); false when it couldn't be saved, "stale" when
 *                                               `holds()` failed at the write, nothing changed then
 * }
 * kind is "edit", "reset", "sync" or "upgrade". `holds()` is whether the caller still holds the prompt
 * semaphore (and, for an AI write, whether the change counter has not moved): given to every operation that
 * may write, and asked again by the store at its write, the last moment before it persists.
 */

import {
  add,
  commitCapture,
  defaultState,
  EPOCH_ZERO,
  hasLineBreak,
  importLegacy,
  isMarkerText,
  isName,
  merge,
  sameState,
  SYNC_FIELDS,
  trim,
  upgrade,
} from "./bullets.js";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value, least) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= least;
}

function isField(value) {
  return typeof value === "string" && SYNC_FIELDS.includes(value);
}

/** The bullets of a part of `field`, or the DS-VALIDATE reason they are dropped. */
function validBullets(field, value) {
  if (!Array.isArray(value)) return "bullets";
  const bullets = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 4) return "bullet";
    const [section, text, name, n] = entry;
    if (typeof section !== "string") return "section";
    if (typeof text !== "string" || text === "" || trim(text) !== text || hasLineBreak(text)) return "text";
    if (isMarkerText(field, text)) return "marker";
    if (!isName(name)) return "name";
    if (!isCount(n, 1)) return "counter";
    bullets.push({ section, text, name, n });
  }
  return bullets;
}

/** The seen map of a part, or null when a key isn't a name (R18) or a value isn't an integer >= 0. */
function validSeen(value) {
  if (!isRecord(value)) return null;
  const seen = new Map();
  for (const [name, n] of Object.entries(value)) {
    if (!isName(name) || !isCount(n, 0)) return null;
    seen.set(name, n);
  }
  return seen;
}

/** A seen map compared between parts: its entries in order of name. */
function seenKey(seen) {
  return JSON.stringify([...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const encoder = new TextEncoder();
const byteLength = (text) => encoder.encode(text).length;

export class BulletSync {
  /**
   * @param {Object} options
   * @param {Object} options.store - see the module comment
   * @param {string[]} options.fields - the fields this app syncs
   * @param {(field: string) => {head: string[], tail: string[]}} options.skeleton - the built-in skeleton (DS-SKELETON)
   * @param {() => string} options.newName - a fresh writer name: 16 lowercase hex from a cryptographic source
   * @param {() => string} options.newID - a random id for the sender and each snapshot
   * @param {() => number} options.budget - the relay's budget for one message (bytes, DS-CHUNK)
   * @param {(message: string) => void} options.error - logs an error: field and reason, label or sizes, never a text
   * @param {Object} options.catalog - the default catalog (DS-DEFAULT)
   */
  constructor(options) {
    this.options = options;
    /** This process's sender id (DS-WIRE), never persisted. */
    this.sender = options.newID();
    /** The current writer name and its last counter: memory only (DS-NAME). */
    this.writer = null;
    /** The names on the bullets of the last complete snapshot merged for each field (DS-SEEN-OUT). */
    this.lastMerged = new Map();
    /** Parts of snapshots not merged yet, per sender and field (DS-CHUNK): incomplete ones, and a complete
     * one whose merge lost its hold, so the message applied again (DS-RECEIVE) merges all of it. */
    this.buffers = new Map();
  }

  /** `field` as it is now, after DS-UPGRADE when it hasn't run; a new install's defaults when nothing
   * is stored (DS-DEFAULT). Returns { state, unsaved }: `unsaved` while an upgrade could not be saved
   * (DS-UNSAVED-UPGRADE), the state then for showing only. */
  async read(field, holds) {
    const pending = await this.upgraded(holds);
    const unsaved = Object.keys(pending).length > 0;
    return { state: pending[field] ?? (await this.stored(field)), unsaved };
  }

  /** DS-CAPTURE: `read`, with the live labels of `sections` to commit against later; `captured` is null
   * while an upgrade is unsaved (DS-UNSAVED-UPGRADE): its labels are under a name the upgrade's save will
   * not use, so the capture is refused and the state is for showing only. */
  async capture(field, sections, holds) {
    const { state, unsaved } = await this.read(field, holds);
    if (unsaved) return { state, captured: null };
    return { state, captured: state.bullets.filter((bullet) => sections.includes(bullet.section)) };
  }

  /** DS-ADD of `items` ({ section, text }). */
  add(field, items, holds) {
    return this.commit([[field, (state) => add(state, items.filter((item) => !isMarkerText(field, item.text)), this.labels())]], "edit", holds);
  }

  /** DS-CAPTURE's commit, of one or more fields in one write: each change { field, captured, result,
   * skeleton? } with `result` the operation's bullets for what it captured and `skeleton` the field's new
   * skeleton lines when the operation edited them. */
  commitCapture(changes, holds) {
    return this.commit(
      changes.map((change) => [
        change.field,
        (state) => {
          // R23: no writer makes a marker text a bullet.
          const result = change.result.filter((item) => !isMarkerText(change.field, item.text));
          const next = commitCapture(state, change.captured, result, this.labels());
          return change.skeleton === undefined ? next : { ...next, head: [...change.skeleton.head], tail: [...change.skeleton.tail] };
        },
      ]),
      "edit",
      holds,
    );
  }

  /** DS-RESET of `fields`, in one commit: bullets and seen map cleared together, the defaults added,
   * the writer name abandoned. */
  async reset(fields, holds) {
    this.abandonName();
    const states = {};
    for (const field of fields) states[field] = defaultState(field, this.options.skeleton(field), this.options.catalog);
    return this.outcome(await this.write(states, "reset", holds), fields);
  }

  /** The connection ended: snapshots not merged yet are dropped (DS-CHUNK). */
  disconnected() {
    this.buffers.clear();
  }

  /** How many parts of snapshots not merged yet are held: DS-RECEIVE counts them toward its bound. */
  heldParts() {
    let parts = 0;
    for (const buffer of this.buffers.values()) parts += buffer.received.size;
    return parts;
  }

  /** DS-LEGACY-IN: a released device's `prompt_state` data, additions only, every field in one commit.
   * Returns the commit's outcome. */
  receiveLegacy(data, holds) {
    const changes = [];
    for (const field of this.options.fields) {
      const text = isRecord(data) ? data[field] : undefined;
      if (typeof text !== "string") continue;
      // Released Thunderbird's and iOS's own reading of the time.
      const time = data[`${field}_updated_at`] || data.updatedAt || EPOCH_ZERO;
      if (time === EPOCH_ZERO) continue;
      changes.push([field, (state) => importLegacy(field, state, text, this.labels(), this.options.catalog)]);
    }
    return this.commit(changes, "sync", holds);
  }

  /** A `bullet_state` message: validated (DS-VALIDATE), buffered until complete (DS-CHUNK-APPLY), then
   * merged (DS-MERGE-1..5). Returns { kind: "ignored" | "invalid" | "partial" | "conflict" | "unsaved" |
   * "stale" | "merged", field?, reason?, changed?, send? }; "stale" when the hold ended before its save. */
  async receive(message, holds) {
    if (!isRecord(message) || message.type !== "bullet_state") return { kind: "ignored" };
    const field = message.field;
    if (!isField(field)) return this.invalid(typeof field === "string" ? "unknown" : typeof field, "field");
    if (!this.options.fields.includes(field)) return { kind: "ignored" };
    const { sender, snap, part, parts } = message;
    // R27: a sender or snap that is not a string fails DS-VALIDATE, and nothing buffered is dropped.
    if (typeof sender !== "string") return this.invalid(field, "sender");
    if (typeof snap !== "string") return this.invalid(field, "snap");
    const key = `${sender}\u0000${field}`;
    // R19: a refused part drops the incomplete snapshot buffered for its sender and field, whatever its snap.
    const refuse = (reason) => {
      this.buffers.delete(key);
      return this.invalid(field, reason);
    };
    if (message.v !== 1) return refuse("version");
    if (!isCount(parts, 1) || !isCount(part, 1) || part > parts) return refuse("part");
    const bullets = validBullets(field, message.bullets);
    if (typeof bullets === "string") return refuse(bullets);
    const seen = validSeen(message.seen);
    if (seen === null) return refuse("seen");

    let buffer = this.buffers.get(key);
    // A part of another snapshot from the same sender for the field replaces what was buffered.
    if (buffer === undefined || buffer.snap !== snap) {
      buffer = { snap, parts, seen: seenKey(seen), received: new Map(), bullets: new Map() };
      this.buffers.set(key, buffer);
    }
    const content = JSON.stringify(message.bullets);
    // R5: parts that disagree drop the snapshot; an identical duplicate part is ignored.
    if (buffer.parts !== parts || buffer.seen !== seenKey(seen) || (buffer.received.has(part) && buffer.received.get(part) !== content)) {
      this.buffers.delete(key);
      return this.invalid(field, "part");
    }
    buffer.received.set(part, content);
    buffer.bullets.set(part, bullets);
    if (buffer.received.size < parts) return { kind: "partial" };
    const all = [];
    for (let index = 1; index <= parts; index += 1) all.push(...(buffer.bullets.get(index) ?? []));
    const result = await this.mergeSnapshot(field, all, seen, holds);
    // A merge whose hold ended ("stale") keeps the whole snapshot, so its last part applied again (DS-RECEIVE)
    // merges all of it; any other outcome ends it. A newer snapshot or the connection's end drops it too.
    if (result.kind !== "stale" && this.buffers.get(key) === buffer) this.buffers.delete(key);
    return result;
  }

  /** What to send for `field` now (DS-WIRE, DS-SEEN-OUT, DS-CHUNK): { kind: "messages", messages }, or
   * { kind: "oversize", bytes, budget } when one bullet alone is over the budget (DS-OVERSIZE). An upgrade
   * not saved yet is shown, never sent (DS-UPGRADE step 6: commit, then send). */
  async outgoing(field, holds) {
    if (Object.keys(await this.upgraded(holds)).length > 0) return { kind: "messages", messages: [] };
    const state = await this.stored(field);
    const names = new Set(state.bullets.map((bullet) => bullet.name));
    for (const name of this.lastMerged.get(field) ?? []) names.add(name);
    const seen = Object.fromEntries([...names].flatMap((name) => (state.seen.has(name) ? [[name, state.seen.get(name)]] : [])));
    const tuples = state.bullets.map((bullet) => [bullet.section, bullet.text, bullet.name, bullet.n]);
    const snap = this.options.newID();
    const budget = this.options.budget();
    const message = (part, parts, bullets) => ({ type: "bullet_state", v: 1, field, sender: this.sender, snap, part, parts, bullets, seen });
    const whole = message(1, 1, tuples);
    if (byteLength(JSON.stringify(whole)) <= budget) return { kind: "messages", messages: [whole] };
    // Measured with the largest part number there can be, so a part's number never takes it over.
    const most = Math.max(1, tuples.length);
    const envelope = byteLength(JSON.stringify(message(most, most, [])));
    const groups = [];
    let group = [];
    let size = envelope;
    for (const tuple of tuples) {
      const bytes = byteLength(JSON.stringify(tuple));
      if (envelope + bytes > budget) {
        this.options.error(`DeviceSync: ${field} not sent: one bullet makes a ${envelope + bytes}-byte message, over the relay's ${budget}`);
        return { kind: "oversize", bytes: envelope + bytes, budget };
      }
      const added = group.length === 0 ? bytes : bytes + 1;
      if (size + added > budget) {
        groups.push(group);
        group = [];
        size = envelope;
      }
      size += group.length === 0 ? bytes : bytes + 1;
      group.push(tuple);
    }
    groups.push(group);
    return { kind: "messages", messages: groups.map((bullets, index) => message(index + 1, groups.length, bullets)) };
  }

  async mergeSnapshot(field, bullets, seen, holds) {
    // Nothing is merged into an upgrade not saved yet: the upgrade commits all its fields at once. One not
    // saved because the hold ended is stale, so the message is applied again (DS-RECEIVE).
    if (Object.keys(await this.upgraded(holds)).length > 0) return { kind: holds() ? "unsaved" : "stale", field };
    const local = await this.stored(field);
    const result = merge(local, { bullets, seen });
    if (result.kind === "conflict") {
      this.options.error(`DeviceSync: ${field} refused: label ${result.label.name}/${result.label.n} holds another text or section`);
      return { kind: "conflict", field };
    }
    const changed = !sameState(local, result.state);
    if (changed) {
      const written = await this.write({ [field]: result.state }, "sync", holds);
      if (written === "stale") return { kind: "stale", field };
      if (!written) return { kind: "unsaved", field };
    } else if (!holds()) {
      return { kind: "stale", field };
    }
    this.lastMerged.set(field, new Set(bullets.map((bullet) => bullet.name)));
    return { kind: "merged", field, changed, send: result.differed };
  }

  invalid(field, reason) {
    this.options.error(`DeviceSync: a ${field} snapshot dropped (${reason})`);
    return { kind: "invalid", field, reason };
  }

  async stored(field) {
    return (await this.options.store.read(field)) ?? defaultState(field, this.options.skeleton(field), this.options.catalog);
  }

  /** DS-UPGRADE: each field with no labelled state yet but a text from before is parsed and labelled,
   * all in one commit. Returns the states when that couldn't be saved, for reading until it can. */
  async upgraded(holds) {
    const states = {};
    for (const field of this.options.fields) {
      if ((await this.options.store.read(field)) !== null) continue;
      const text = await this.options.store.legacyText(field);
      if (text !== null) states[field] = upgrade(field, text, this.labels(), this.options.catalog);
    }
    if (Object.keys(states).length === 0) return {};
    if ((await this.write(states, "upgrade", holds)) === true) return {};
    return states;
  }

  /** One read-change-save commit of each field given, in one write, after DS-UPGRADE. Returns
   * { outcome: "saved" | "unchanged" | "unsaved" | "stale", fields } with the fields it changed. */
  async commit(changes, kind, holds) {
    const pending = await this.upgraded(holds);
    if (Object.keys(pending).length > 0) return { outcome: holds() ? "unsaved" : "stale", fields: [] };
    const states = {};
    for (const [field, change] of changes) {
      const before = states[field] ?? (await this.stored(field));
      const after = change(before);
      if (!sameState(before, after)) states[field] = after;
    }
    const fields = SYNC_FIELDS.filter((field) => states[field] !== undefined);
    if (fields.length === 0) return { outcome: holds() ? "unchanged" : "stale", fields: [] };
    return this.outcome(await this.write(states, kind, holds), fields);
  }

  /** A commit's outcome from its write's. */
  outcome(written, fields) {
    if (written === "stale") return { outcome: "stale", fields: [] };
    return written ? { outcome: "saved", fields: [...fields] } : { outcome: "unsaved", fields: [] };
  }

  /** Writes `states`, if `holds()` still does at the write; when it doesn't, or the write fails, the writer
   * name is abandoned (DS-NAME-ABANDON). Returns true, false or "stale". */
  async write(states, kind, holds) {
    let saved = false;
    try {
      saved = await this.options.store.write(states, kind, holds);
    } catch (e) {
      this.options.error(`DeviceSync: save failed (${kind}): ${e}`);
    }
    if (saved !== true) this.abandonName();
    return saved;
  }

  abandonName() {
    this.writer = null;
  }

  /** Labels under the current writer name, a fresh one when there is none (DS-NAME, DS-ORDER). */
  labels() {
    return {
      next: () => {
        this.writer ??= { name: this.options.newName(), n: 0 };
        this.writer.n += 1;
        return { name: this.writer.name, n: this.writer.n };
      },
    };
  }
}
