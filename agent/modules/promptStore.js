/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place the knowledge base, the composition rules and the action rules are read and changed.
 *
 * Each field is kept as labelled bullets (`bullet_state:<field>`) and, in the same storage write, as its
 * rendered markdown (`user_prompts:user_<field>.md`) (DS-ATOMIC). The background page is the host: it runs
 * the one engine (bulletSync.js) and the device's one prompt semaphore. Any other page (the prompts page,
 * the history page) reaches it through a "prompt-store" runtime message.
 *
 * `withPromptStore` is the only way to read or change a field (DS-SEMAPHORE): it acquires the semaphore,
 * waiting in line behind every earlier caller for at most `acquireWaitMs` (request order), runs the caller's
 * brief read-change-write and releases it however that ends. A hold
 * past its lease loses the semaphore, and every write asks whether it still holds it immediately before the
 * storage write (DS-LEASE). An edit commits against the labels it read (DS-CAPTURE), so a bullet that
 * arrived meanwhile is never deleted by it. An AI writer reads in one hold, asks the model holding nothing,
 * and writes in a second hold carrying the change counter its read returned (DS-AI): the write is refused
 * when the counter moved.
 */

import { BulletSync } from "./bulletSync.js";
import { displayedSections, isMarkerText, parse, render, SYNC_FIELDS } from "./bullets.js";
import { SETTINGS } from "./config.js";
import { log } from "./utils.js";

const PFX = "[PromptStore] ";

export const PROMPT_KEYS = {
  kb: "user_prompts:user_kb.md",
  composition: "user_prompts:user_composition.md",
  action: "user_prompts:user_action.md",
};

export const BULLET_STATE_KEYS = {
  kb: "bullet_state:kb",
  composition: "bullet_state:composition",
  action: "bullet_state:action",
};

/** The legacy merge's state, discarded at DS-UPGRADE (step 5). Nothing reads these keys any more, so the
 * removal runs after the upgrade's commit and is best-effort: a failure leaves dead copies. */
const PEER_BASE_KEYS = [
  "device_peer_base:kb",
  "device_peer_base:composition",
  "device_peer_base:action",
  "device_peer_base_ts:kb",
  "device_peer_base_ts:composition",
  "device_peer_base_ts:action",
  "device_sync_base:kb",
  "device_sync_base:composition",
  "device_sync_base:action",
];

const BUNDLED_FILES = { composition: "prompts/user_composition.md", action: "prompts/user_action.md" };
const CATALOG_FILE = "agent/modules/device-sync-default-catalog.json";

/** What a chat tool answers when the prompt semaphore stayed held through every try (DS-NO-BUSY-UI). */
export const KB_BUSY_ERROR = "Couldn't save: the knowledge base is busy. Try again in a moment.";

/** What the prompts page says when a line holds a section-header mark or the END marker (R23). */
export const SECTION_MARKER_REFUSAL = "A line can't contain \"DO NOT EDIT/DELETE THIS SECTION HEADER\" or \"====END USER INSTRUCTIONS====\", so nothing changed.";

// ─── Stored form ────────────────────────────────────────────────────────

function toStored(state) {
  return {
    head: [...state.head],
    tail: [...state.tail],
    bullets: state.bullets.map((bullet) => [bullet.section, bullet.text, bullet.name, bullet.n]),
    seen: Object.fromEntries(state.seen),
  };
}

/** A stored bullet state, or null when it is absent or unreadable (DS-UNREADABLE: DS-UPGRADE then runs
 * again from the rendered text). */
function fromStored(value) {
  const tuple = (entry) => Array.isArray(entry) && entry.length === 4;
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.head) ||
    !Array.isArray(value.tail) ||
    !Array.isArray(value.bullets) ||
    !value.bullets.every(tuple) ||
    typeof value.seen !== "object" ||
    value.seen === null
  ) {
    return null;
  }
  return {
    head: [...value.head],
    tail: [...value.tail],
    bullets: value.bullets.map(([section, text, name, n]) => ({ section, text, name, n })),
    seen: new Map(Object.entries(value.seen)),
  };
}

function toTuples(bullets) {
  return bullets.map((bullet) => [bullet.section, bullet.text, bullet.name, bullet.n]);
}

function fromTuples(tuples) {
  return (tuples ?? []).map(([section, text, name, n]) => ({ section, text, name, n }));
}

// ─── The host (background page) ─────────────────────────────────────────

/** The background page's engine; null in every other page. */
let engine = null;
let hostReady = null;

async function fetchBundled(path) {
  const resp = await fetch(browser.runtime.getURL(path));
  if (!resp.ok) throw new Error(`Fetch bundled ${path} failed (${resp.status})`);
  return resp.text();
}

/**
 * The semaphore's holder: { token, label, timer, changed }, or null. `changed` is the fields its hold saved
 * or must send (DS-SEND), sent before its operation returns.
 */
let holder = null;

/** DS-COUNTER: renewed by every commit that saved a change of the three fields (an edit, a refine, a merge
 * or a legacy import that changed a field, a reset) and by every accepted restore. An upgrade's save does
 * not renew it, nor does sign-in state. Memory only: a new background page starts a new one, so an AI write
 * read in an earlier one is refused. */
let change = crypto.randomUUID();

function renewChange() {
  change = crypto.randomUUID();
}

/** Writes the given states and their rendered texts in one storage write (DS-ATOMIC), if the operation
 * still `holds()` at the write: the last moment before anything persists, after every await (DS-LEASE).
 * Records the history the change needs first (DS-HISTORY). Returns true, false (not saved) or "stale". */
async function writeStates(states, kind, holds) {
  const fields = SYNC_FIELDS.filter((field) => states[field] !== undefined);
  const { recordHistory, scheduleEditHistory } = await import("./deviceSync.js");
  // DS-HISTORY: a reset and a merge record the state they replace, in their own hold, before their commit.
  if (kind === "reset") await recordHistory("reset", fields, holds);
  else if (kind === "sync") await recordHistory("sync_receive", fields, holds);
  const values = {};
  for (const field of fields) {
    values[BULLET_STATE_KEYS[field]] = toStored(states[field]);
    values[PROMPT_KEYS[field]] = render(field, states[field]);
  }
  const by = holder;
  if (!holds()) return "stale";
  try {
    await browser.storage.local.set(values);
  } catch (e) {
    log(`${PFX}Save failed (${kind}, ${fields.join(", ")}): ${e}`, "error");
    return false;
  }
  // DS-SEND: a local commit that changed a field sends it. A received message's commit sends as its
  // receiver marks: a merge only when its incoming labels differed (hostReceive), a legacy import when it
  // added texts (hostReceiveLegacy).
  if (kind !== "sync") for (const field of fields) by?.changed.add(field);
  if (kind === "upgrade") {
    try {
      await browser.storage.local.remove(PEER_BASE_KEYS);
    } catch (e) {
      log(`${PFX}Discarding the legacy merge state failed: ${e}`, "warn");
    }
    return true;
  }
  renewChange();
  if (kind === "edit") scheduleEditHistory(fields);
  return true;
}

const store = {
  async read(field) {
    const key = BULLET_STATE_KEYS[field];
    const stored = await browser.storage.local.get(key);
    if (stored[key] === undefined) return null;
    const state = fromStored(stored[key]);
    if (state === null) log(`${PFX}${field}'s stored bullets are unreadable: upgraded again from its text`, "error");
    return state;
  },
  async legacyText(field) {
    const key = PROMPT_KEYS[field];
    const stored = await browser.storage.local.get(key);
    return typeof stored[key] === "string" ? stored[key] : null;
  },
  write: writeStates,
};

function writerName() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Starts this page as the host: loads the default catalog and the built-in skeletons and creates the
 * engine. Called once by the background page at startup. DS-UPGRADE runs in the first hold that reads or
 * writes the fields.
 */
export function initPromptStoreHost() {
  hostReady ??= (async () => {
    const catalog = JSON.parse(await fetchBundled(CATALOG_FILE));
    const skeletons = { kb: { head: [], tail: [] } };
    for (const field of ["composition", "action"]) {
      const { head, tail } = parse(field, await fetchBundled(BUNDLED_FILES[field]));
      skeletons[field] = { head, tail };
    }
    engine = new BulletSync({
      store,
      fields: SYNC_FIELDS,
      skeleton: (field) => skeletons[field],
      newName: writerName,
      newID: () => crypto.randomUUID(),
      budget: () => SETTINGS.deviceSync.messageMaxBytes,
      error: (message) => log(`${PFX}${message}`, "error"),
      catalog,
    });
    log(`${PFX}Ready`);
    return engine;
  })();
  return hostReady;
}

function isHost() {
  return hostReady !== null;
}

// ─── The semaphore ──────────────────────────────────────────────────────

/** DS-SEMAPHORE request order: the callers waiting for the semaphore, first come first served, each
 * { label, resolve, timer }. The semaphore is handed to the head when it frees, so a later request never takes
 * it while an earlier one still waits. A waiter still in line after `acquireWaitMs` leaves it and is refused
 * as busy; one handed the semaphore whose caller has gone loses it with the lease. */
const waiting = [];

/** The semaphore for `label`: at once when it is free, else after every earlier waiter, or { outcome: "busy" }
 * once `acquireWaitMs` passed in line. It is never free while anyone waits: whatever frees it hands it on. */
function hostAcquire(label) {
  if (holder === null) return { outcome: "acquired", token: grant(label) };
  return new Promise((resolve) => {
    const waiter = { label, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const index = waiting.indexOf(waiter);
      if (index < 0) return;
      waiting.splice(index, 1);
      resolve({ outcome: "busy", label: holder?.label ?? "the prompt store" });
    }, SETTINGS.promptSemaphore.acquireWaitMs);
    waiting.push(waiter);
  });
}

/** Makes `label` the holder, under a lease, and returns its token. */
function grant(label) {
  const token = crypto.randomUUID();
  const leaseMs = SETTINGS.promptSemaphore.leaseMs;
  const timer = setTimeout(() => {
    if (holder?.token !== token) return;
    log(`${PFX}${label} held the prompt semaphore past its lease (${leaseMs}ms): it is released and nothing more of it is saved`, "error");
    holder = null;
    handOn();
  }, leaseMs);
  holder = { token, label, timer, changed: new Set() };
  return token;
}

/** The semaphore freed: it goes to the first waiter in line. */
function handOn() {
  if (holder !== null) return;
  const next = waiting.shift();
  if (next === undefined) return;
  clearTimeout(next.timer);
  next.resolve({ outcome: "acquired", token: grant(next.label) });
}

function hostRelease(token) {
  if (holder?.token === token) {
    clearTimeout(holder.timer);
    holder = null;
    handOn();
  }
  return { outcome: "released" };
}

/** Whether `token` still holds the semaphore, and, when `seen` is given (an AI write), the change counter
 * has not moved since the read that returned it. */
function holding(token, seen) {
  return () => holder?.token === token && (seen === undefined || seen === change);
}

/** Sends what the hold of `token` changed (DS-SEND, DS-UPGRADE step 6), read from the engine as that hold.
 * A hold that ended meanwhile sends nothing: peers catch up at the next connect or change. */
async function sendChanged(token) {
  if (holder?.token !== token || holder.changed.size === 0) return;
  const fields = SYNC_FIELDS.filter((field) => holder.changed.has(field));
  holder.changed.clear();
  const { sendMessages } = await import("./deviceSync.js");
  for (const field of fields) {
    const holds = holding(token);
    if (!holds()) return;
    const outgoing = await engine.outgoing(field, holds);
    if (outgoing.kind === "messages" && holds()) await sendMessages(field, outgoing.messages);
  }
}

async function hostRead(token, field) {
  const holds = holding(token);
  const { state, captured } = await engine.capture(field, displayedSections(field), holds);
  if (!holds()) throw changedError("the prompts");
  return { content: render(field, state), captured: captured === null ? null : toTuples(captured), change };
}

/** A DS-CAPTURE commit of `content` as `field`'s new text against `captured`, the labels its read showed.
 * `seen`, for an AI write only, is the change counter its read returned (DS-AI). */
async function hostWrite(token, field, captured, content, seen) {
  if (captured === null) return { outcome: "unsaved" };
  const parsed = parse(field, content);
  const shown = displayedSections(field);
  // R23: a line that would be a bullet holding a section marker refuses the whole edit.
  if (parsed.bullets.some((item) => shown.includes(item.section) && isMarkerText(field, item.text))) return { outcome: "refused" };
  const edit = { field, captured: fromTuples(captured), result: parsed.bullets.filter((item) => shown.includes(item.section)) };
  if (field !== "kb") edit.skeleton = { head: parsed.head, tail: parsed.tail };
  const result = await engine.commitCapture([edit], holding(token, seen));
  return { outcome: result.outcome === "stale" ? "changed" : result.outcome };
}

/** DS-ADD of `items` ({ section, text }) to `field`. */
async function hostAdd(token, field, items) {
  const result = await engine.add(field, items, holding(token));
  return { outcome: result.outcome === "stale" ? "changed" : result.outcome };
}

/** DS-RESET of `fields`. */
async function hostReset(token, fields) {
  const result = await engine.reset(fields, holding(token));
  return { outcome: result.outcome === "stale" ? "changed" : result.outcome };
}

/** DS-RESTORE: a history entry put back as one captured edit of the three fields as they are now, in the
 * sections this app shows: labels whose text the entry lacks are deleted, its texts added, the writer name
 * kept. The entry's templates are written in the same hold. Every accepted restore moves the counter. */
async function hostRestore(token, entry) {
  const holds = holding(token);
  const templates = JSON.parse(entry?.templatesJSON || "[]");
  const { recordHistory, writeRestoredTemplates } = await import("./deviceSync.js");
  await recordHistory("reset", ["composition", "action", "kb", "templates"], holds);
  const edits = [];
  for (const field of SYNC_FIELDS) {
    if (typeof entry?.[field] !== "string") continue;
    const shown = displayedSections(field);
    const { captured } = await engine.capture(field, shown, holds);
    if (captured === null) return { outcome: "unsaved" };
    edits.push({ field, captured, result: parse(field, entry[field]).bullets.filter((item) => shown.includes(item.section)) });
  }
  const result = await engine.commitCapture(edits, holds);
  if (result.outcome !== "saved" && result.outcome !== "unchanged") return { outcome: result.outcome === "stale" ? "changed" : result.outcome };
  renewChange();
  if (!(await writeRestoredTemplates(templates, holds))) return { outcome: "changed" };
  return { outcome: result.outcome };
}

/** A `prompt_state` field's reset to its default: the state it replaces recorded in the history, then the
 * default written, both checked at their write. */
async function hostResetField(token, field, value) {
  const holds = holding(token);
  const { recordHistory, writeFieldDefault } = await import("./deviceSync.js");
  await recordHistory("reset", [field], holds);
  return { outcome: (await writeFieldDefault(field, value, holds)) ? "saved" : "changed" };
}

/** A received `bullet_state` (DS-MERGE-1..5). A merge whose incoming labels differed from this device's
 * sends this device's state back (DS-SEND). A message that saved nothing because the hold ended is refused
 * as busy, so it is applied again (DS-RECEIVE). */
async function hostReceive(token, message) {
  const holds = holding(token);
  const result = await engine.receive(message, holds);
  if (result.kind === "stale") throw busyError("its hold ended before the received message was saved");
  if (result.kind === "merged" && result.send && holder?.token === token) holder.changed.add(result.field);
  return { result };
}

/** DS-LEGACY-IN of a released device's texts. A hold that ended before the save is refused as busy, so the
 * whole message is applied again (DS-RECEIVE). Returns the fields it changed. */
async function hostReceiveLegacy(token, data) {
  const result = await engine.receiveLegacy(data, holding(token));
  if (result.outcome === "stale") throw busyError("its hold ended before the received message was saved");
  // DS-SEND: an import that added texts changed the field like a local commit, so it is sent.
  if (holder?.token === token) for (const field of result.fields) holder.changed.add(field);
  return { fields: result.fields };
}

/** What to send for `field` now (DS-WIRE, DS-CHUNK, DS-OVERSIZE). */
async function hostOutgoing(token, field) {
  return { outgoing: await engine.outgoing(field, holding(token)) };
}

/** Marks `fields` to be sent before this hold's operation returns (DS-SEND on connect). */
function hostSend(token, fields) {
  if (holder?.token === token) for (const field of fields) holder.changed.add(field);
  return { outcome: "saved" };
}

/** The prompt history (copies of the texts), read in a hold. */
async function hostHistory(token) {
  const { readHistory } = await import("./deviceSync.js");
  return { entries: await readHistory(holding(token)) };
}

/** A history snapshot of the texts, recorded in a hold. */
async function hostRecordHistory(token, source, fields, templates) {
  const { recordHistory } = await import("./deviceSync.js");
  await recordHistory(source, fields, holding(token), templates);
  return { outcome: "saved" };
}

const OPERATIONS = {
  acquire: (message) => hostAcquire(message.label),
  release: (message) => hostRelease(message.token),
};

/** What a holder of the semaphore may do; each checks it still holds it at its start and at its write, and
 * sends what it changed before it returns. */
const HELD = {
  read: (message) => hostRead(message.token, message.field),
  write: (message) => hostWrite(message.token, message.field, message.captured, message.content, message.change),
  add: (message) => hostAdd(message.token, message.field, message.items),
  reset: (message) => hostReset(message.token, message.fields),
  restore: (message) => hostRestore(message.token, message.entry),
  resetField: (message) => hostResetField(message.token, message.field, message.value),
  receive: (message) => hostReceive(message.token, message.message),
  receiveLegacy: (message) => hostReceiveLegacy(message.token, message.data),
  outgoing: (message) => hostOutgoing(message.token, message.field),
  send: (message) => hostSend(message.token, message.fields),
  history: (message) => hostHistory(message.token),
  recordHistory: (message) => hostRecordHistory(message.token, message.source, message.fields, message.templates),
};

function operation(op) {
  if (OPERATIONS[op]) return async (message) => OPERATIONS[op](message);
  if (HELD[op]) {
    return async (message) => {
      if (holder === null || holder.token !== message.token) throw changedError("the prompts");
      await initPromptStoreHost();
      const result = await HELD[op](message);
      await sendChanged(message.token);
      return result;
    };
  }
  return null;
}

/** The background's "prompt-store" runtime message handler: returns the operation's promise. */
export function handlePromptStoreMessage(message) {
  const run = operation(message?.op);
  if (!run) return Promise.resolve({ ok: false, error: `unknown operation ${message?.op}` });
  return run(message).then(
    (result) => ({ ok: true, ...result }),
    (e) => {
      // A refusal keeps its kind across the message.
      log(`${PFX}${message.op} ${e?.changed || e?.busy ? "refused" : "failed"}: ${e}`, e?.changed || e?.busy ? "warn" : "error");
      return { ok: false, error: String(e), changed: e?.changed === true, busy: e?.busy === true };
    },
  );
}

async function call(op, message) {
  if (isHost()) return { ok: true, ...(await operation(op)(message)) };
  const response = await browser.runtime.sendMessage({ command: "prompt-store", op, ...message });
  if (!response?.ok) {
    const error = new Error(response?.error || `prompt store ${op} failed`);
    if (response?.changed === true) error.changed = true;
    if (response?.busy === true) error.busy = true;
    throw error;
  }
  return response;
}

// ─── API for every page ─────────────────────────────────────────────────

/** Whether a line the user typed on the prompts page (`typed`) holds the section-header mark or the END
 * marker (R23): written into the field, it would be read back as a header or the skeleton. */
export function holdsSectionMarker(field, typed) {
  return typed.some((line) => isMarkerText(field, line));
}

/** The error of a write refused because the hold ended or the counter moved; `changed` tells it apart. */
function changedError(field) {
  const error = new Error(`${field} changed while this was worked on, so nothing was saved`);
  error.changed = true;
  return error;
}

/** The error of an acquire refused because another holds the semaphore; `busy` tells it apart. */
function busyError(label) {
  const error = new Error(`the prompt store is busy (${label})`);
  error.busy = true;
  return error;
}

/** One hold of the prompt semaphore: what `withPromptStore` gives its body. */
class PromptStoreHold {
  #token;
  #ended = false;

  constructor(token) {
    this.#token = token;
  }

  /** `field`'s text as the app shows it, the labels it shows (to write against) and the change counter it
   * was read at. Throws while an upgrade is unsaved (DS-UNSAVED-UPGRADE). */
  async read(field) {
    const response = await this.#call("read", { field });
    if (response.captured === null) throw new Error(`${field} could not be saved`);
    return { content: response.content, captured: response.captured, change: response.change };
  }

  /** What a screen shows of `field` (DS-DISPLAYED): { content, captured }, the text and the labels it shows,
   * read together; `captured` is null while an upgrade is unsaved (show only, DS-UNSAVED-UPGRADE). */
  async view(field) {
    const response = await this.#call("read", { field });
    return { content: response.content, captured: response.captured };
  }

  /** `field`'s text as the app shows it: what is stored, or the catalog defaults when nothing is. */
  async text(field) {
    return (await this.#call("read", { field })).content;
  }

  /** DS-CAPTURE: saves `content` as `field`'s new text against `captured`, the labels its read showed.
   * Throws when the hold ended, when it couldn't be saved, and when a line holds a marker (R23). Returns
   * { outcome: "saved" | "unchanged" }. */
  async write(field, captured, content) {
    return this.#written(field, await this.#call("write", { field, captured, content }));
  }

  /** DS-DISPLAYED for one shown knowledge-base item: deletes exactly `labels`, the labels a screen showed for
   * it, those still live, and nothing else (a capture of them committed with no text kept). Returns
   * { outcome: "saved" }, or "unchanged" when none of them is live any more (already removed). */
  async removeShown(field, labels) {
    if (field !== "kb") throw new Error(`removeShown is for the knowledge base, not ${field}`);
    return this.#written(field, await this.#call("write", { field, captured: labels, content: "" }));
  }

  /** DS-AI: saves an AI result `content` as `field`'s new text against `read` (from a `read` in an earlier
   * hold). Throws a `changed` error, with nothing saved, when the change counter moved since that read. */
  async writeAI(field, read, content) {
    if (typeof read?.change !== "string") throw new Error("an AI write needs the change counter its read returned");
    return this.#written(field, await this.#call("write", { field, captured: read.captured, content, change: read.change }));
  }

  #written(field, response) {
    if (response.outcome === "changed") throw changedError(field);
    if (response.outcome === "unsaved") throw new Error(`${field} could not be saved`);
    if (response.outcome === "refused") throw new Error(SECTION_MARKER_REFUSAL);
    return { outcome: response.outcome };
  }

  /** DS-ADD of `items` ({ section, text }) to `field`. Returns { outcome: "saved" | "unchanged" }. */
  async add(field, items) {
    return this.#written(field, await this.#call("add", { field, items }));
  }

  /** DS-RESET of `fields`. Throws when it couldn't be saved. */
  async reset(fields) {
    const response = await this.#call("reset", { fields });
    if (response.outcome === "changed") throw changedError(fields.join(", "));
    if (response.outcome !== "saved") throw new Error(`${fields.join(", ")} could not be reset`);
  }

  /** DS-RESTORE of a prompt history entry. Throws when it couldn't be saved or the hold ended. */
  async restore(entry) {
    const response = await this.#call("restore", { entry });
    if (response.outcome === "changed") throw changedError("the prompts");
    if (response.outcome !== "saved" && response.outcome !== "unchanged") throw new Error("the history entry could not be restored");
  }

  /** Resets a `prompt_state` field (not a bullet field) to `value`, its timestamp epoch zero, recording the
   * state it replaces in the history first. Throws when the hold ended meanwhile (`changed`). */
  async resetField(field, value) {
    const response = await this.#call("resetField", { field, value });
    if (response.outcome === "changed") throw changedError(field);
  }

  /** A received `bullet_state` message (DS-MERGE-1..5). Throws a `busy` error when its hold ended first. */
  async receive(message) {
    return (await this.#call("receive", { message })).result;
  }

  /** DS-LEGACY-IN of a released device's `prompt_state` texts. Returns the fields it changed. */
  async receiveLegacy(data) {
    return (await this.#call("receiveLegacy", { data })).fields;
  }

  /** What to send for `field` now (DS-WIRE, DS-CHUNK, DS-OVERSIZE). */
  async outgoing(field) {
    return (await this.#call("outgoing", { field })).outgoing;
  }

  /** Sends `fields`' state to peers (DS-SEND) before this call returns. */
  async send(fields) {
    await this.#call("send", { fields });
  }

  /** The prompt history, oldest first. */
  async history() {
    return (await this.#call("history", {})).entries;
  }

  /** Records a history snapshot of the texts (`source`: "local_edit", "reset" or "sync_receive"), with
   * `templates` when not the stored ones. */
  async recordHistory(source, fields, templates) {
    await this.#call("recordHistory", { source, fields, templates });
  }

  /** Whether this hold still holds the semaphore (background only). */
  holds() {
    return !this.#ended && holder?.token === this.#token;
  }

  end() {
    this.#ended = true;
  }

  #call(op, message) {
    if (this.#ended) throw new Error(`the prompt store was used after its hold ended (${op})`);
    return call(op, { token: this.#token, ...message });
  }
}

async function acquire(label) {
  const response = await call("acquire", { label });
  if (response.outcome === "busy") throw busyError(response.label);
  return response.token;
}

/**
 * The one way to read or change the knowledge base, the writing style and the action rules
 * (DS-SEMAPHORE): acquires the device's prompt semaphore, runs `body(store)` and releases it, however
 * `body` ends. While another holds it the caller waits in line behind every earlier caller (request order)
 * and, after `SETTINGS.promptSemaphore.acquireWaitMs` in line, rejects with a `busy` error. Sign-in state
 * never refuses it (DS-DEVICE). `body` is a brief read-change-write: it never awaits an AI call (DS-AI) and
 * never calls this again (DS-NESTED: a nested call waits its full wait and is refused as busy). Returns what
 * `body` returns.
 *
 * @param {(store: PromptStoreHold) => Promise<any>} body
 * @param {{ label?: string }} [options] - what holds it, for the logs
 */
export async function withPromptStore(body, { label = "prompt store" } = {}) {
  const token = await acquire(label);
  const hold = new PromptStoreHold(token);
  try {
    return await body(hold);
  } finally {
    hold.end();
    try {
      await call("release", { token });
    } catch (e) {
      log(`${PFX}${label}: releasing the prompt semaphore failed (its lease ends it): ${e}`, "warn");
    }
  }
}

/** DS-AI, first half: `field` read in its own hold, released before the model is asked. Returns { content,
 * captured, change } for `writeAfterRead`. */
export function readBeforeAI(field, label) {
  return withPromptStore((store) => store.read(field), { label });
}

/** DS-AI, second half: `content` saved as `field`'s text against `read` (from `readBeforeAI`), in a new hold.
 * Throws a `changed` error, with nothing saved, when the change counter moved since that read (the result is
 * dropped), and a `busy` one when the semaphore stayed held. Returns { outcome: "saved" | "unchanged" }. */
export function writeAfterRead(field, read, content, label) {
  return withPromptStore((store) => store.writeAI(field, read, content), { label });
}

/** `field`'s text as the app shows it: what is stored, or the catalog defaults when nothing is. */
export function readText(field) {
  return withPromptStore((store) => store.text(field), { label: `read of ${field}` });
}

/** What a screen shows of `field`, read in one hold: { content, captured } (see `PromptStoreHold.view`). */
export function readView(field) {
  return withPromptStore((store) => store.view(field), { label: `view of ${field}` });
}

/** What a removal of a shown item answers when none of its labels is live any more (DS-DISPLAYED). */
export const ALREADY_REMOVED = "That item was already removed.";

/** A chat tool's edit of `field`, in one hold: its text read and `edit(text)` run on it. `edit` returns
 * { save: newText } to save, or the tool's result to stop with nothing saved. Returns null when saved,
 * `edit`'s result, or an error result (KB_BUSY_ERROR while the store stays busy). */
export async function editText(field, label, edit) {
  try {
    return await withPromptStore(async (store) => {
      const { content, captured } = await store.read(field);
      const outcome = edit(content.trim());
      if (typeof outcome?.save !== "string") return outcome;
      const updated = outcome.save;
      await store.write(field, captured, updated);
      log(`${PFX}${label}: saved ${field} (${updated.length} chars)`);
      return null;
    }, { label });
  } catch (e) {
    return notSaved(field, label, e);
  }
}

/** One shown knowledge-base item removed by the labels the screen showed for it (DS-DISPLAYED), in one
 * hold. Returns null when removed, { error: ALREADY_REMOVED } when none of them was live any more, or an
 * error result (KB_BUSY_ERROR while the store stays busy). */
export async function removeShownItem(field, label, labels) {
  try {
    const { outcome } = await withPromptStore((store) => store.removeShown(field, labels), { label });
    log(`${PFX}${label}: ${outcome === "saved" ? "removed" : "already removed"} in ${field}`);
    return outcome === "saved" ? null : { error: ALREADY_REMOVED };
  } catch (e) {
    return notSaved(field, label, e);
  }
}

function notSaved(field, label, e) {
  log(`${PFX}${label}: ${field} not saved: ${e}`, e?.busy ? "warn" : "error");
  return { error: e?.busy ? KB_BUSY_ERROR : `failed to persist knowledge base: ${e?.message ?? e}` };
}

/** DS-HISTORY: the texts the store shows for the three fields, read in a hold (background only): each
 * field's saved text, an empty one included, or, for a field never saved, the text of its defaults. */
export async function shownTexts() {
  const saved = await browser.storage.local.get(SYNC_FIELDS.map((field) => PROMPT_KEYS[field]));
  const texts = {};
  for (const field of SYNC_FIELDS) {
    const text = saved[PROMPT_KEYS[field]];
    texts[field] = typeof text === "string" ? text : render(field, await (await initPromptStoreHost()).stored(field));
  }
  return texts;
}

/** The texts DS-DEFAULT puts in `field`'s section `section`, in order: what a reset of that section shows. */
export async function defaultTexts(field, section) {
  const catalog = JSON.parse(await fetchBundled(CATALOG_FILE));
  return catalog.defaults.filter((entry) => entry.field === field && entry.section === section).map((entry) => entry.text);
}

// ─── Background-only: Device Sync ───────────────────────────────────────

/** Sends `fields`' state now (DS-SEND), through the prompt semaphore. */
export function sendBulletState(fields) {
  return withPromptStore((store) => store.send(fields), { label: "sync send" });
}

/** What to send for `field` now, read through the prompt semaphore. */
export function outgoingBulletState(field) {
  return withPromptStore((store) => store.outgoing(field), { label: "sync read" });
}

/** The connection ended: incomplete snapshots are dropped (DS-CHUNK). */
export function bulletSyncDisconnected() {
  engine?.disconnected();
}

/** How many parts of incomplete snapshots the engine holds (DS-RECEIVE bound). Background only. */
export function heldSnapshotParts() {
  return engine?.heldParts() ?? 0;
}
