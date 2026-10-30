/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Device Sync Module - Always-On WebSocket Device Sync
 *
 * Maintains persistent WebSocket connection to sync relay worker for
 * auto-syncing prompt settings between TabMail instances (TB ↔ iOS).
 *
 * Protocol:
 * 1. Connect to sync relay worker via WebSocket (wss://sync[-dev].tabmail.ai/ws)
 * 2. Authenticate with Supabase JWT token
 * 3. The knowledge base, composition rules and action rules sync as labelled bullets
 *    (`bullet_state`, promptStore.js): each is sent on connect, after a local change, and after a
 *    merge of a peer's state that differed from this device's.
 * 4. Templates, disabled reminders, the task cache and the action config sync in `prompt_state`:
 *    on connect auto-broadcast with per-field timestamps, on local edit debounced (500ms), on
 *    receive per-field merge (newer wins). Its three text fields go out empty at epoch zero, which
 *    released apps skip; a released app's texts are imported as additions only.
 * 5. Received `bullet_state` and `prompt_state` are applied one after another, in arrival order
 *    (DS-RECEIVE); one that finds the prompt store busy is applied again shortly, holding nothing.
 * 6. On receive ai_cache_probe: respond with local AI cache hits
 * 7. On receive ai_cache_response: resolve pending probe promises
 *
 * No data is persisted on the server — pure sync relay.
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { resolveActionConfig } from "./actionCompactConfig.js";
import { SYNC_FIELDS } from "./bullets.js";
import { log } from "./utils.js";
import { getDeviceSyncUrl, SETTINGS } from "./config.js";

const PFX = "[DeviceSync] ";

// Valid field names for sync
const VALID_FIELDS = ["composition", "action", "kb", "templates", "disabledReminders", "taskCache", "actionConfig"];
// The fields `prompt_state` still carries (the bullet fields, SYNC_FIELDS, go in `bullet_state`)
const LEGACY_FIELDS = VALID_FIELDS.filter((field) => !SYNC_FIELDS.includes(field));

// Field → storage key mapping
const FIELD_KEYS = {
  composition: "user_prompts:user_composition.md",
  action: "user_prompts:user_action.md",
  kb: "user_prompts:user_kb.md",
  templates: "user_templates",
  disabledReminders: "disabled_reminders_v2",
  taskCache: "task_execution_cache",
  actionConfig: "user_prompts:action_config",
};

// Field → per-field timestamp key mapping
const TIMESTAMP_KEYS = {
  composition: "device_sync_ts:composition",
  action: "device_sync_ts:action",
  kb: "device_sync_ts:kb",
  templates: "device_sync_ts:templates",
  disabledReminders: "device_sync_ts:disabledReminders",
  taskCache: "device_sync_ts:taskCache",
  actionConfig: "device_sync_ts:actionConfig",
};

// Epoch 0 for new devices — prevents overwriting existing prompts
const EPOCH_ZERO = "1970-01-01T00:00:00.000Z";

// Auto-enabled storage key (default: true — user can disable in settings)
const AUTO_ENABLED_KEY = "device_sync_auto_enabled";

// Backup storage (legacy — migrated to prompt_history)
const BACKUP_KEY = "device_sync_backups";
const BROADCAST_DEBOUNCE_MS = SETTINGS.deviceSync?.broadcastDebounceMs ?? 500;

// Prompt history
const HISTORY_KEY = "prompt_history";
const HISTORY_MIGRATED_KEY = "prompt_history_migrated";
const MAX_HISTORY_ENTRIES = 100;
const HISTORY_DEBOUNCE_MS = SETTINGS.deviceSync.historyDebounceMs;

// The experiment owns the socket across background generations.
let connected = false;
let connectPromise = null;
let connectionGeneration = 0;
let transportListener = null;
// Fresh wake generations accept the parent's replay; explicit disconnect does not.
let transportDisconnected = false;

export function attachDeviceSyncTransportListener() {
  if (transportListener) return;
  const handleEvent = async event => {
    if (event.type === "close") {
      connected = false;
      notifyStatusListeners();
      await receivesEnded();
      return;
    }
    if (event.type === "reconnect") return connect();
    if (event.type === "open") { connected = true; notifyStatusListeners(); return; }
    if (event.type === "probe") { connected = true; return probeAllFields(); }
    if (event.type === "message") {
      connected = true;
      return handleMessage(event.data);
    }
  };
  const listener = event => {
    if (transportDisconnected) return;
    return handleEvent(event);
  };
  browser.tmDeviceSync.onEvent.addListener(listener);
  transportListener = listener;
}

function sendTransport(data) {
  return browser.tmDeviceSync.send(data);
}

// Suppress broadcast flag — set true when applying incoming sync to avoid echo
let suppressBroadcast = false;

// Debounce timer for auto-broadcast on local edits
let _broadcastDebounceTimer = null;
let _broadcastPendingFields = new Set();

// Storage change listener reference (for cleanup)
let _storageChangeListener = null;

// Status change listeners — pages register callbacks for real-time UI updates
const statusListeners = new Set();

// History debounce for local edits (2s quiet period)
let _historyDebounceTimer = null;
let _historyPendingFields = new Set();

// Pending AI cache probes (probeId → { resolve, timer, keys })
const _pendingProbes = new Map();

// DS-RECEIVE: received messages for the prompt store, applied one after another in arrival order. One refused
// as busy is applied again after SETTINGS.deviceSync.busyReapplyMs, holding nothing while it waits, and every
// message after it waits behind it. `receiveConnection` is renewed whenever the connection ends: every message
// still waiting from before is then dropped (peers send their state on the next connect). The chain and the
// count of waiting messages belong to one connection: a new connection starts its own, so its messages never
// wait for an apply of an older connection that has not returned (its hold ends with its lease, DS-LEASE).
// `heldParts` is how many parts of incomplete snapshots the engine held after the last bullet_state apply:
// they count toward the bound with the waiting messages, so a sender that keeps restarting with a part lost
// never makes the receiver hold more (DS-CHUNK); renewing the connection drops them.
let receiveChain = Promise.resolve();
let receiveConnection = 0;
let waitingReceives = 0;
let heldParts = 0;

// ─── Per-field Timestamps ───────────────────────────────────────────────

/**
 * Read per-field timestamps from storage.
 * Returns { composition: ISO, action: ISO, kb: ISO, templates: ISO }
 */
async function readTimestamps() {
  try {
    const keys = Object.values(TIMESTAMP_KEYS);
    const stored = await browser.storage.local.get(keys);
    const result = {};
    for (const [field, key] of Object.entries(TIMESTAMP_KEYS)) {
      result[field] = stored[key] || EPOCH_ZERO;
    }
    return result;
  } catch (e) {
    log(`${PFX}Error reading timestamps: ${e}`, "warn");
    const result = {};
    for (const field of VALID_FIELDS) result[field] = EPOCH_ZERO;
    return result;
  }
}

/**
 * Initialize timestamps to epoch 0 if none exist (new device).
 */
async function initTimestampsIfNeeded() {
  const stored = await browser.storage.local.get(Object.values(TIMESTAMP_KEYS));
  const anyExists = Object.values(TIMESTAMP_KEYS).some((k) => stored[k]);
  if (!anyExists) {
    const init = {};
    for (const key of Object.values(TIMESTAMP_KEYS)) {
      init[key] = EPOCH_ZERO;
    }
    await browser.storage.local.set(init);
    log(`${PFX}New device detected — initialized timestamps to epoch 0`);
  }
}

// ─── Prompt History ──────────────────────────────────────────────────────
// The history holds copies of the three texts, so it is read and written only in a hold of the prompt
// semaphore (DS-HISTORY), and saved only if the hold still holds it at the write.

/**
 * Record a snapshot of current prompt state in history, by a holder of the prompt semaphore.
 * @param {string} source - "local_edit", "reset", or "sync_receive"
 * @param {string[]} fields - Which fields changed
 * @param {() => boolean} holds - Whether the caller still holds the prompt semaphore (promptStore.js)
 * @param {Array} [templates] - The templates to record, when not the stored ones
 */
export async function recordHistory(source, fields, holds, templates) {
  try {
    await migrateBackupsToHistoryIfNeeded(holds);
    const state = await readLocalState();
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source,
      fields,
      composition: state.composition || "",
      action: state.action || "",
      kb: state.kb || "",
      templatesJSON: JSON.stringify(templates ?? state.templates ?? []),
    };

    const stored = await browser.storage.local.get(HISTORY_KEY);
    const history = stored[HISTORY_KEY] || [];
    history.push(entry);
    while (history.length > MAX_HISTORY_ENTRIES) history.shift();
    if (!holds()) {
      log(`${PFX}History not recorded: the prompt semaphore was lost meanwhile (its lease)`);
      return;
    }
    await browser.storage.local.set({ [HISTORY_KEY]: history });
  } catch (e) {
    log(`${PFX}Failed to record history: ${e}`, "warn");
  }
}

/**
 * A local edit's history: recorded after 2s of quiet, in its own hold (DS-HISTORY).
 * @param {string[]} fields - The fields the edit changed
 */
export function scheduleEditHistory(fields) {
  for (const field of fields) _historyPendingFields.add(field);
  if (_historyDebounceTimer) clearTimeout(_historyDebounceTimer);
  _historyDebounceTimer = setTimeout(async () => {
    _historyDebounceTimer = null;
    const pending = [..._historyPendingFields];
    _historyPendingFields.clear();
    try {
      const { withPromptStore } = await import("./promptStore.js");
      await withPromptStore((store) => store.recordHistory("local_edit", pending), { label: "history record" });
    } catch (e) {
      log(`${PFX}Debounced history record failed: ${e}`, "warn");
    }
  }, HISTORY_DEBOUNCE_MS);
}

/**
 * Load all history entries, through the prompt semaphore.
 * @returns {Promise<Array>} History entries (oldest first)
 */
export async function loadHistory() {
  const { withPromptStore } = await import("./promptStore.js");
  return withPromptStore((store) => store.history(), { label: "history load" });
}

/**
 * The history entries, for a holder of the prompt semaphore (promptStore.js).
 * @param {() => boolean} holds - Whether the caller still holds the prompt semaphore
 * @returns {Promise<Array>} History entries (oldest first)
 */
export async function readHistory(holds) {
  await migrateBackupsToHistoryIfNeeded(holds);
  const stored = await browser.storage.local.get(HISTORY_KEY);
  if (!holds()) throw Object.assign(new Error("the prompt semaphore was lost while the history was read"), { changed: true });
  return stored[HISTORY_KEY] || [];
}

/**
 * Restore all prompt fields from a history entry (DS-RESTORE): in one hold of the prompt semaphore, the
 * pre-restore state is recorded, the three texts put back as a captured edit (promptStore.js, which sends
 * them) and the templates written with a fresh timestamp, so the restore propagates to other devices.
 * @param {Object} entry - History entry to restore
 */
export async function restoreFromHistory(entry) {
  const { withPromptStore } = await import("./promptStore.js");
  await withPromptStore((store) => store.restore(entry), { label: "history restore" });
  log(`${PFX}Restored from history entry ${entry.id?.substring(0, 8)}`);

  // Broadcast the restored templates to peers
  await broadcastState(["templates"]);
}

/** A history restore's templates, written by its holder (promptStore.js) while `holds()`, with a fresh
 * timestamp. Returns whether they were written. */
export function writeRestoredTemplates(templates, holds) {
  return writeLegacyField("templates", templates, new Date().toISOString(), holds);
}

/** A `prompt_state` field's reset to `value` with the epoch-zero timestamp, by its holder (promptStore.js)
 * while `holds()`. Returns whether it was written. */
export function writeFieldDefault(field, value, holds) {
  return writeLegacyField(field, value, EPOCH_ZERO, holds);
}

/** Writes a `prompt_state` field (never a bullet field: those are the prompt store's) and its timestamp, if
 * `holds()` still does at the write, without broadcasting it. Returns whether it was written. */
async function writeLegacyField(field, value, timestamp, holds) {
  if (!LEGACY_FIELDS.includes(field)) throw new Error(`not a prompt_state field: ${field}`);
  if (!holds()) return false;
  suppressBroadcast = true;
  try {
    await browser.storage.local.set({ [FIELD_KEYS[field]]: value, [TIMESTAMP_KEYS[field]]: timestamp });
  } finally {
    suppressBroadcast = false;
  }
  return true;
}

/**
 * One-time migration of existing device_sync_backups into prompt_history, by a holder of the prompt
 * semaphore: marked migrated with the entries it adds, in one write, so a migration whose hold ends
 * before saves nothing and runs again next time.
 * @param {() => boolean} holds - Whether the caller still holds the prompt semaphore
 */
async function migrateBackupsToHistoryIfNeeded(holds) {
  const migrated = await browser.storage.local.get(HISTORY_MIGRATED_KEY);
  if (migrated[HISTORY_MIGRATED_KEY]) return;

  const stored = await browser.storage.local.get(BACKUP_KEY);
  const backups = stored[BACKUP_KEY];
  if (!Array.isArray(backups) || backups.length === 0) {
    if (holds()) await browser.storage.local.set({ [HISTORY_MIGRATED_KEY]: true });
    return;
  }

  const entries = backups.map((backup) => ({
    id: crypto.randomUUID(),
    timestamp: backup.backedUpAt || backup.state?.updatedAt || EPOCH_ZERO,
    source: backup.source || "sync_receive",
    fields: ["composition", "action", "kb", "templates"],
    composition: backup.state?.composition || "",
    action: backup.state?.action || "",
    kb: backup.state?.kb || "",
    templatesJSON: JSON.stringify(backup.state?.templates || []),
  }));

  const existing = await browser.storage.local.get(HISTORY_KEY);
  const history = existing[HISTORY_KEY] || [];
  history.unshift(...entries); // prepend migrated entries (they're older)
  while (history.length > MAX_HISTORY_ENTRIES) history.shift();
  if (!holds()) return;
  await browser.storage.local.set({ [HISTORY_KEY]: history, [HISTORY_MIGRATED_KEY]: true });
  log(`${PFX}Migrated ${entries.length} backup(s) to prompt history`);
}

// ─── Status Listeners ───────────────────────────────────────────────────

function notifyStatusListeners() {
  for (const cb of statusListeners) {
    try {
      cb(connected);
    } catch (e) {
      log(`${PFX}Status listener error: ${e}`, "warn");
    }
  }
}

export function addStatusListener(callback) {
  statusListeners.add(callback);
  // New consumers read the parent transport; this mirror resets on background wake.
}

export function removeStatusListener(callback) {
  statusListeners.delete(callback);
}

// ─── Read / Broadcast State ─────────────────────────────────────────────

/**
 * Read current prompt state from browser.storage.local.
 * Includes per-field timestamps for merge decisions on the receiving end.
 * disabledReminders sends the full CRDT map (per-hash timestamps handle conflicts).
 * The three texts are read only by a holder of the prompt semaphore (the history); `texts: false` leaves
 * them empty, at epoch zero, unread (DS-LEGACY-OUT).
 * @param {string[]|null} fields - If specified, only include these fields
 * @param {{ texts?: boolean }} [options]
 */
async function readLocalState(fields = null, { texts = true } = {}) {
  try {
    const unread = texts ? [] : SYNC_FIELDS;
    const storageKeys = [
      ...Object.entries(FIELD_KEYS).filter(([field]) => !unread.includes(field)).map(([, key]) => key),
      ...Object.values(TIMESTAMP_KEYS),
    ];
    const stored = await browser.storage.local.get(storageKeys);
    const state = { updatedAt: new Date().toISOString() };

    for (const field of VALID_FIELDS) {
      if (fields && !fields.includes(field)) continue;

      if (unread.includes(field)) {
        state[field] = "";
        state[`${field}_updated_at`] = EPOCH_ZERO;
        continue;
      }
      if (field === "taskCache") {
        // Send full cache map (per-key CRDT merge on receive)
        const { getAllCachedResults } = await import("./taskExecutionCache.js");
        state[field] = await getAllCachedResults();
      } else if (field === "disabledReminders") {
        // Send CRDT map (per-hash timestamps handle conflicts)
        state[field] = stored[FIELD_KEYS[field]] || {};
      } else if (field === "templates") {
        state[field] = stored[FIELD_KEYS[field]] || [];
      } else if (field === "actionConfig") {
        state[field] = resolveActionConfig(stored[FIELD_KEYS[field]], stored[TIMESTAMP_KEYS[field]]);
      } else {
        state[field] = stored[FIELD_KEYS[field]] || "";
      }
      state[`${field}_updated_at`] = stored[TIMESTAMP_KEYS[field]] || EPOCH_ZERO;
    }

    return state;
  } catch (e) {
    log(`${PFX}Error reading local state: ${e}`, "error");
    return { updatedAt: new Date().toISOString() };
  }
}

/**
 * Broadcast prompt state to other connected clients.
 * @param {string[]|null} fields - If specified, only send these fields. null = all.
 */
export async function broadcastState(fields = null) {
  if (suppressBroadcast) {
    return;
  }

  if (!connected) {
    return;
  }

  try {
    // DS-LEGACY-OUT: released apps skip a text field at epoch zero, and never receive this app's texts
    // here: a released receiver could remove its own bullets when this text lacked them.
    const state = await readLocalState(fields, { texts: false });
    await sendTransport(JSON.stringify({ type: "prompt_state", data: state }));
    log(`${PFX}Broadcast prompt_state (fields=${fields || "all"})`);
  } catch (e) {
    log(`${PFX}Error broadcasting state: ${e}`, "error");
  }
}

/**
 * Sends a bullet field's messages (DS-WIRE), by the holder of the prompt semaphore that read them
 * (promptStore.js). A closed or switched-off transport sends nothing: peers catch up at the next connect.
 * @param {string} field - A bullet field (SYNC_FIELDS)
 * @param {Object[]} messages - Its `bullet_state` parts
 */
export async function sendMessages(field, messages) {
  // A background page woken while the parent kept the socket open commits before startup re-attaches to
  // it: ask the parent, without connecting. The answer is not kept: a sync-off or sign-out while it is
  // awaited stays in force (checked after it).
  if (!connected && (await browser.tmDeviceSync.getState()) !== "open") return;
  if (transportDisconnected) return;
  try {
    for (const message of messages) await sendTransport(JSON.stringify(message));
    log(`${PFX}Sent bullet_state ${field} (${messages.length} part(s))`);
  } catch (e) {
    log(`${PFX}bullet_state ${field} could not be sent: ${e}`, "warn");
  }
}

// ─── Received messages for the prompt store (DS-RECEIVE) ───────────────

/**
 * Queues `apply` behind every received message before it. It runs only while its connection lasts: refused
 * as busy, it is tried again after SETTINGS.deviceSync.busyReapplyMs holding nothing, until it applies or
 * the connection ends. Past SETTINGS.deviceSync.maxWaitingReceives waiting, the connection is renewed.
 * @param {string} what - For the logs
 * @param {() => Promise<void>} apply - The message's apply, in its own hold of the prompt semaphore
 */
function enqueueReceive(what, apply) {
  if (waitingReceives + heldParts >= SETTINGS.deviceSync.maxWaitingReceives) {
    log(`${PFX}${waitingReceives} received messages are waiting and ${heldParts} parts of incomplete snapshots are held: the connection is renewed`, "warn");
    renewConnection().catch((e) => log(`${PFX}Renewing the connection failed: ${e}`, "warn"));
    return;
  }
  const connection = receiveConnection;
  waitingReceives += 1;
  receiveChain = receiveChain.then(async () => {
    try {
      await applyWhileConnected(what, apply, connection);
    } catch (e) {
      log(`${PFX}A received message (${what}) could not be applied: ${e}`, "error");
    } finally {
      if (connection === receiveConnection) waitingReceives -= 1;
    }
  });
  return receiveChain;
}

async function applyWhileConnected(what, apply, connection) {
  while (connection === receiveConnection) {
    try {
      await apply();
      return;
    } catch (e) {
      if (e?.busy !== true) throw e;
    }
    log(`${PFX}The prompt store stayed busy: a received message (${what}) is applied again shortly`, "warn");
    await new Promise((resolve) => setTimeout(resolve, SETTINGS.deviceSync.busyReapplyMs));
  }
  log(`${PFX}A received message (${what}) was dropped: its connection ended`);
}

/** The connection ended: every received message still waiting, and every incomplete snapshot, is dropped
 * (peers send their state on the next connect). */
async function receivesEnded() {
  receiveConnection += 1;
  receiveChain = Promise.resolve();
  waitingReceives = 0;
  heldParts = 0;
  const { bulletSyncDisconnected } = await import("./promptStore.js");
  bulletSyncDisconnected();
}

/** Too many received messages are waiting: the connection is ended and opened again (DS-RECEIVE). */
async function renewConnection() {
  await disconnect();
  await connect();
}

/** A received `bullet_state` part, merged in a hold of the prompt semaphore (DS-MERGE). DS-VALIDATE: a part
 * whose sender, field or snap is not a string is dropped before anything else is done with it. */
function receiveBulletState(parsed) {
  if (![parsed.sender, parsed.field, parsed.snap].every((value) => typeof value === "string")) {
    log(`${PFX}A bullet_state part dropped (its sender, field or snap is not a string)`, "error");
    return;
  }
  return enqueueReceive(`bullet_state ${parsed.field}`, async () => {
    const { withPromptStore, heldSnapshotParts } = await import("./promptStore.js");
    await withPromptStore((store) => store.receive(parsed), { label: "sync apply" });
    heldParts = heldSnapshotParts();
  });
}

// ─── Probe & Sync Now ───────────────────────────────────────────────────

/**
 * Request every `prompt_state` field from peers (routine probe), never the bullet fields: those arrive as
 * `bullet_state` when a peer connects or changes them (DS-NO-REQUEST).
 * Peers respond with their current state and timestamps; the existing
 * per-field merge logic handles conflict resolution automatically.
 */
async function probeAllFields() {
  if (!connected) return;
  try {
    await sendTransport(JSON.stringify({ type: "request_state", fields: LEGACY_FIELDS }));
    log(`${PFX}Probe: requested all fields from peers`);
  } catch (e) {
    log(`${PFX}Peer probe could not be sent: ${e}`, "warn");
  }
}

/**
 * Public "Sync Now" — broadcasts local state AND requests state from peers.
 * Used by manual sync buttons.
 */
export async function syncNow() {
  if (!connected) {
    log(`${PFX}syncNow: not connected, attempting connect first`);
    await disconnect(); // Explicit user retry may bypass the parent's backoff.
    await connect();
    return; // connect will broadcastAllFields on success
  }
  await broadcastState();
  await probeAllFields();
}

// ─── Reset Field to Default (Epoch-Zero Timestamp) ──────────────────────

/**
 * Reset a `prompt_state` field to its default value with epoch-zero timestamp (the bullet fields reset
 * through promptStore.js).
 * This prevents the default from overwriting customized rules on other devices.
 * After writing, requests the field from peers so they send back their (newer) data.
 * @param {string} field - One of LEGACY_FIELDS, e.g. "templates"
 * @param {string|Array} defaultValue - The bundled default value
 */
export async function resetFieldToDefault(field, defaultValue) {
  if (!LEGACY_FIELDS.includes(field)) {
    log(`${PFX}resetFieldToDefault: invalid field '${field}'`, "warn");
    return;
  }

  // In one hold of the prompt semaphore (the history holds the texts): the pre-reset state is recorded,
  // then the default written, checked at its write, without an auto-broadcast.
  const { withPromptStore } = await import("./promptStore.js");
  await withPromptStore((store) => store.resetField(field, defaultValue), { label: "field reset" });
  log(`${PFX}Reset field '${field}' to default (timestamp → epoch zero)`);

  // Request state from peers — if they have newer (customized) data, it syncs back
  if (connected) {
    try {
      await sendTransport(JSON.stringify({ type: "request_state", fields: [field] }));
      log(`${PFX}Requested state from peers for field '${field}'`);
    } catch (e) {
      log(`${PFX}Reset completed locally; peer request could not be sent: ${e}`, "warn");
    }
  }
}

// ─── Storage Change Listener (Auto-Broadcast on Local Edit) ─────────────

/**
 * Set up storage.onChanged listener for auto-broadcasting local edits.
 * Register synchronously during background startup; repeated initialization is harmless.
 * Uses debounce to avoid flooding during rapid typing.
 */
export function setupStorageListener() {
  if (_storageChangeListener) return; // Already set up

  const listener = (changes, area) => {
    // Local edit timestamps must advance even while transport is paused.
    if (area !== "local" || suppressBroadcast) return;

    // Check if any prompt-related key changed. The bullet fields are written only by promptStore.js,
    // which sends them and records their history itself.
    const changedFields = [];
    for (const [field, storageKey] of Object.entries(FIELD_KEYS)) {
      if (SYNC_FIELDS.includes(field)) continue;
      // Sync-owned writes carry their timestamp in the same change event.
      if (changes[storageKey] && !changes[TIMESTAMP_KEYS[field]]) {
        changedFields.push(field);
      }
    }
    if (changedFields.length === 0) return;

    // Update per-field timestamps for changed fields (these are local edits)
    const now = new Date().toISOString();
    const tsUpdates = {};
    for (const field of changedFields) {
      tsUpdates[TIMESTAMP_KEYS[field]] = now;
      _broadcastPendingFields.add(field);
    }
    // Fire-and-forget timestamp write
    browser.storage.local.set(tsUpdates).catch((e) => {
      log(`${PFX}Failed to write edit timestamps: ${e}`, "warn");
    });

    // Record history for local edits (debounced 2s). History snapshots hold
    // prompt text only, so an actionConfig entry would carry no diff.
    const historyFields = changedFields.filter((field) => field !== "actionConfig");
    if (historyFields.length > 0) scheduleEditHistory(historyFields);

    // Debounce broadcast: reset timer, broadcast after quiet period
    if (_broadcastDebounceTimer) clearTimeout(_broadcastDebounceTimer);
    _broadcastDebounceTimer = setTimeout(async () => {
      _broadcastDebounceTimer = null;
      const fields = [..._broadcastPendingFields];
      _broadcastPendingFields.clear();
      if (transportDisconnected) return;
      try {
        // A first wake may reach this debounce before late startup reconnects
        // the module to the already-open parent transport.
        if (!connected) await connect();
        await broadcastState(fields);
      } catch (e) {
        log(`${PFX}Debounced broadcast failed: ${e}`, "warn");
      }
    }, BROADCAST_DEBOUNCE_MS);
  };

  try {
    browser.storage.onChanged.addListener(listener);
    _storageChangeListener = listener;
    log(`${PFX}Storage change listener registered (auto-broadcast on edit)`);
  } catch (e) {
    log(`${PFX}Storage listener registration failed: ${e}`, "warn");
  }
}

// ─── Handle Incoming Prompt State (Per-Field Merge) ─────────────────────

/**
 * Resolve the timestamp for a field from incoming data.
 * Fallback chain: per-field ts → global updatedAt → epoch 0
 */
function resolveIncomingTimestamp(data, field) {
  return data[`${field}_updated_at`] || data.updatedAt || EPOCH_ZERO;
}

function isValidActionConfig(config) {
  return typeof config === "object" && config !== null
    && Number.isInteger(config.compact_threshold) && config.compact_threshold > 0
    && Number.isInteger(config.compact_threshold_chars) && config.compact_threshold_chars > 0;
}

/**
 * Convert a legacy [String] array of disabled hashes to CRDT map format.
 * Used for backward compat when receiving from an older client.
 * @param {string[]} arr - Array of hash strings
 * @param {string} ts - Timestamp to use for all entries
 * @returns {Object} CRDT map {hash: {enabled, ts}}
 */
function legacyArrayToCRDTMap(arr, ts) {
  const map = {};
  for (const hash of arr) {
    if (typeof hash === "string") {
      map[hash] = { enabled: false, ts };
    }
  }
  return map;
}

/**
 * Handle incoming prompt_state from another client, in one hold of the prompt semaphore (`store`), so a
 * busy refusal applies the whole message again (DS-RECEIVE).
 *
 * Text fields (composition, action, kb) — a released app's text is imported as additions only
 * (DS-LEGACY-IN, promptStore.js: never a deletion, never ordered by its timestamp; skipped at epoch zero),
 * and a changed field is sent to peers as `bullet_state`.
 *
 * Templates: per-template CRDT merge by id (updatedAt comparison)
 * DisabledReminders: per-hash CRDT merge (ts comparison)
 * TaskCache: per-key CRDT merge (ts comparison)
 * ActionConfig: last-write-wins
 *
 * Records the state it replaces in the history before applying.
 */
async function handlePromptState(data, store) {
  const textFields = await store.receiveLegacy(data);
  if (textFields.length > 0) log(`${PFX}Imported a released device's texts as additions (${textFields.join(", ")})`);

  const localTimestamps = await readTimestamps();

  const willMergeTemplates = data.templates !== undefined && Array.isArray(data.templates)
    && resolveIncomingTimestamp(data, "templates") !== EPOCH_ZERO
    && data.templates.some((t) => t && typeof t.id === "string" && typeof t.name === "string");
  const willMergeReminders = data.disabledReminders !== undefined
    && resolveIncomingTimestamp(data, "disabledReminders") !== EPOCH_ZERO
    && (Array.isArray(data.disabledReminders) || (typeof data.disabledReminders === "object" && data.disabledReminders !== null));
  const willMergeTaskCache = data.taskCache !== undefined
    && resolveIncomingTimestamp(data, "taskCache") !== EPOCH_ZERO
    && typeof data.taskCache === "object" && data.taskCache !== null;

  // The templates before the merge, for the history entry of what it replaces (DS-HISTORY).
  const preMergeTemplates = (willMergeTemplates || willMergeReminders || willMergeTaskCache)
    ? (await readLocalState(["templates"])).templates : null;

  // ─── Templates: per-template CRDT merge — skip if epoch-zero ─────
  let templatesMerged = false;
  if (willMergeTemplates) {
    const validTemplates = data.templates.filter(
      (t) => t && typeof t.id === "string" && typeof t.name === "string"
    );
    const skipped = data.templates.length - validTemplates.length;
    if (skipped > 0) {
      log(`${PFX}Skipped ${skipped} invalid templates (missing id/name)`, "warn");
    }
    if (validTemplates.length > 0) {
      try {
        const { mergeTemplates, gcDeletedTemplates } = await import("./templateManager.js");
        const beforeTemplates = JSON.stringify((await browser.storage.local.get(FIELD_KEYS.templates))[FIELD_KEYS.templates] || []);
        suppressBroadcast = true;
        await mergeTemplates(validTemplates);
        await gcDeletedTemplates();
        const afterTemplates = JSON.stringify((await browser.storage.local.get(FIELD_KEYS.templates))[FIELD_KEYS.templates] || []);
        templatesMerged = beforeTemplates !== afterTemplates;
      } catch (e) {
        log(`${PFX}Template CRDT merge failed: ${e}`, "warn");
      } finally {
        suppressBroadcast = false;
      }
    }
  }

  // ─── DisabledReminders: per-hash CRDT merge — skip if epoch-zero ─
  let remindersMerged = false;
  if (willMergeReminders) {
    try {
      let incomingMap;

      if (Array.isArray(data.disabledReminders)) {
        const ts = resolveIncomingTimestamp(data, "disabledReminders");
        incomingMap = legacyArrayToCRDTMap(data.disabledReminders, ts);
        log(`${PFX}Converted legacy disabledReminders array (${data.disabledReminders.length} items) to CRDT map`);
      } else if (typeof data.disabledReminders === "object" && data.disabledReminders !== null) {
        incomingMap = data.disabledReminders;
      }

      if (incomingMap && Object.keys(incomingMap).length > 0) {
        const { mergeIncoming } = await import("./reminderStateStore.js");
        const beforeReminders = JSON.stringify((await browser.storage.local.get(FIELD_KEYS.disabledReminders))[FIELD_KEYS.disabledReminders] || {});
        suppressBroadcast = true;
        await mergeIncoming(incomingMap);
        const afterReminders = JSON.stringify((await browser.storage.local.get(FIELD_KEYS.disabledReminders))[FIELD_KEYS.disabledReminders] || {});
        remindersMerged = beforeReminders !== afterReminders;
        suppressBroadcast = false;
      }
    } catch (e) {
      log(`${PFX}DisabledReminders CRDT merge failed: ${e}`, "warn");
      suppressBroadcast = false;
    }
  }

  // ─── TaskCache: per-key CRDT merge — skip if epoch-zero ────────
  let taskCacheMerged = false;
  if (willMergeTaskCache && Object.keys(data.taskCache).length > 0) {
    suppressBroadcast = true;
    try {
      const { mergeIncomingCache } = await import("./taskExecutionCache.js");
      // In this message's hold, never a nested acquire (DS-SEMAPHORE).
      await mergeIncomingCache(data.taskCache, store);
      taskCacheMerged = true;
    } catch (e) {
      // DS-RECEIVE: a hold that ended before the save applies the whole message again.
      if (e?.busy === true) throw e;
      log(`${PFX}TaskCache CRDT merge failed: ${e}`, "warn");
    } finally {
      suppressBroadcast = false;
    }
  }

  // ─── ActionConfig: last-write-wins — an epoch-zero (never edited) ─
  // incoming timestamp is never newer than local, so it is skipped too.
  let actionConfigApplied = false;
  if (data.actionConfig !== undefined) {
    const incomingTs = data.actionConfig_updated_at || EPOCH_ZERO;
    const localTs = localTimestamps.actionConfig;
    if (incomingTs <= localTs) {
      log(`${PFX}Skipping actionConfig — not newer (incoming ${incomingTs} <= local ${localTs})`);
    } else if (!isValidActionConfig(data.actionConfig)) {
      log(`${PFX}Skipping actionConfig — invalid payload`, "warn");
    } else {
      const incomingConfig = {
        compact_threshold: data.actionConfig.compact_threshold,
        compact_threshold_chars: data.actionConfig.compact_threshold_chars,
      };
      // Value and timestamp in one change set: the storage listener treats it as sync-owned.
      suppressBroadcast = true;
      try {
        await browser.storage.local.set({
          [FIELD_KEYS.actionConfig]: incomingConfig,
          [TIMESTAMP_KEYS.actionConfig]: incomingTs,
        });
      } finally {
        suppressBroadcast = false;
      }
      actionConfigApplied = true;
      log(`${PFX}actionConfig: LWW accept compact_threshold=${incomingConfig.compact_threshold}, compact_threshold_chars=${incomingConfig.compact_threshold_chars}`);
    }
  }

  const actuallyChanged = [
    ...(templatesMerged ? ["templates"] : []),
    ...(remindersMerged ? ["disabledReminders"] : []),
    ...(taskCacheMerged ? ["taskCache"] : []),
  ];
  if (actuallyChanged.length > 0) {
    await recordHistory("sync_receive", actuallyChanged, () => store.holds(), preMergeTemplates);
  }
  if (actuallyChanged.length > 0 || actionConfigApplied) {
    log(`${PFX}Applied incoming prompt_state (${[...actuallyChanged, ...(actionConfigApplied ? ["actionConfig"] : [])].join(", ")})`);
  } else if (textFields.length === 0) {
    log(`${PFX}No fields to apply`);
  }
}

// ─── AI Cache Probe (Device Sync LLM Result Sharing) ─────────────────────

/**
 * Low-level probe: send probe request and wait for response.
 * Prefer probeAICache() for caller-facing usage.
 * @param {string[]} keys - Probe keys (headerMessageId without angle brackets)
 * @param {number} timeoutMs - Max wait time (default 2000)
 * @param {string[]} [fields] - Optional fields to request ("summary", "action")
 * @returns {Promise<Object|null>} - { "<key>": { summary?: {...}, action?: "..." } } or null
 */
export function probeAndWait(keys, timeoutMs = 2000, fields = undefined) {
  return new Promise((resolve) => {
    if (!connected) {
      resolve(null);
      return;
    }

    const probeId = crypto.randomUUID();
    const timer = setTimeout(() => {
      _pendingProbes.delete(probeId);
      resolve(null);
    }, timeoutMs);

    _pendingProbes.set(probeId, { resolve, timer, keys });

    try {
      const msg = { type: "ai_cache_probe", keys, probeId };
      if (fields) msg.fields = fields;
      sendTransport(JSON.stringify(msg)).catch(() => {
        clearTimeout(timer);
        _pendingProbes.delete(probeId);
        resolve(null);
      });
      log(`${PFX}Sent ai_cache_probe for [${keys.join(", ")}] fields=${fields || "all"} (probeId=${probeId.substring(0, 8)})`);
    } catch (e) {
      clearTimeout(timer);
      _pendingProbes.delete(probeId);
      resolve(null);
    }
  });
}

/**
 * Probe connected peers for a specific AI cache field.
 * Generates probe key from headerMessageId, sends targeted probe, returns just the field value.
 * @param {string} headerMessageId - Raw headerMessageId (angle brackets will be stripped)
 * @param {"summary"|"action"} field - Which field to probe for
 * @returns {Promise<Object|string|null>} Summary object, action string, or null
 */
export async function probeAICache(headerMessageId, field) {
  const probeKey = headerMessageId.replace(/[<>]/g, "");
  const results = await probeAndWait([probeKey], undefined, [field]);
  return results?.[probeKey]?.[field] || null;
}

/**
 * Handle incoming ai_cache_probe — look up local IDB cache and respond.
 * This is called when another client asks if we have cached AI results.
 * Subclasses/callers must register a handler via setAICacheProbeHandler().
 */
let _aiCacheProbeHandler = null;

/**
 * Register a handler for AI cache probes. The handler receives an array
 * of message keys and should return { "<key>": { summary?: {...}, action?: "..." } }.
 * @param {function(string[]): Promise<Object>} handler
 */
export function setAICacheProbeHandler(handler) {
  _aiCacheProbeHandler = handler;
}

async function handleAICacheProbe(parsed) {
  if (!_aiCacheProbeHandler) return;
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) return;

  try {
    const results = await _aiCacheProbeHandler(parsed.keys, parsed.fields);
    // Always respond (even with empty results) so the peer knows we're connected
    if (connected) {
      await sendTransport(JSON.stringify({
        type: "ai_cache_response",
        results: results || {},
        probeId: parsed.probeId,
      }));
      const hitKeys = Object.keys(results || {});
      log(`${PFX}Responded to ai_cache_probe for [${parsed.keys.join(", ")}] fields=${parsed.fields || "all"}: ${hitKeys.length} hit(s)${hitKeys.length ? " [" + hitKeys.join(", ") + "]" : ""} (probeId=${parsed.probeId?.substring(0, 8) || "??"})`);
    }
  } catch (e) {
    log(`${PFX}Error handling ai_cache_probe: ${e}`, "warn");
  }
}

function handleAICacheResponse(parsed) {
  const results = parsed.results;
  if (!results) return;

  // Resolve by probeId if present
  if (parsed.probeId && _pendingProbes.has(parsed.probeId)) {
    const probe = _pendingProbes.get(parsed.probeId);
    clearTimeout(probe.timer);
    _pendingProbes.delete(parsed.probeId);
    probe.resolve(results);
    const resolvedKeys = Object.keys(results);
    log(`${PFX}Resolved ai_cache_probe for [${probe.keys.join(", ")}]: ${resolvedKeys.length} hit(s)${resolvedKeys.length ? " [" + resolvedKeys.join(", ") + "]" : ""} (probeId=${parsed.probeId.substring(0, 8)})`);
    return;
  }

  // Fallback: resolve any pending probe whose keys overlap
  for (const [probeId, probe] of _pendingProbes) {
    const matchedKeys = probe.keys.filter((k) => results[k]);
    if (matchedKeys.length > 0) {
      clearTimeout(probe.timer);
      _pendingProbes.delete(probeId);
      probe.resolve(results);
      log(`${PFX}Resolved ai_cache_probe (fallback) for [${probe.keys.join(", ")}]: ${matchedKeys.length} hit(s) [${matchedKeys.join(", ")}] (probeId=${probeId.substring(0, 8)})`);
      return;
    }
  }
}

// ─── WebSocket Message Handler ──────────────────────────────────────────

async function handleMessage(rawData) {
  try {
    const parsed = JSON.parse(rawData);

    switch (parsed.type) {
      case "connected":
        log(`${PFX}Connected as user ${parsed.userId?.substring(0, 8)}...`);
        // DS-NO-REQUEST: the three bullet fields are always sent on connect, through the received-message
        // chain so a busy prompt store sends them shortly after.
        await enqueueReceive("connect send", async () => {
          const { sendBulletState } = await import("./promptStore.js");
          await sendBulletState(SYNC_FIELDS);
        });
        // Virgin device (all timestamps epoch-zero): skip the prompt_state broadcast, probe peers instead.
        // Prevents default values from triggering LWW overwrites on established devices.
        {
          const timestamps = await readTimestamps();
          const allEpochZero = Object.values(timestamps).every((ts) => ts === EPOCH_ZERO);
          if (allEpochZero) {
            log(`${PFX}Virgin device — skipping broadcast, probing peers instead`);
            await probeAllFields();
          } else {
            await broadcastState().catch((e) => {
              log(`${PFX}Auto-broadcast on connect failed: ${e}`, "warn");
            });
          }
        }
        break;

      case "request_state": {

        const fields =
          Array.isArray(parsed.fields) && parsed.fields.length > 0
            ? parsed.fields.filter((f) => VALID_FIELDS.includes(f))
            : null;
        log(`${PFX}Received request_state — responding (fields=${fields || "all"})`);
        await broadcastState(fields);
        break;
      }

      case "prompt_state":
        if (parsed.data) {
          await enqueueReceive("prompt_state", async () => {
            const { withPromptStore } = await import("./promptStore.js");
            await withPromptStore((store) => handlePromptState(parsed.data, store), { label: "legacy sync apply" });
          });
        }
        break;

      case "bullet_state":
        await receiveBulletState(parsed);
        break;

      case "ai_cache_probe":

        await handleAICacheProbe(parsed);
        break;

      case "ai_cache_response":
        handleAICacheResponse(parsed);
        break;

      case "pong":
        break;

      default:
        log(`${PFX}Unknown message type: ${parsed.type}`);
    }
  } catch (e) {
    log(`${PFX}Failed to parse message: ${e}`);
  }
}

// ─── Connect / Disconnect ───────────────────────────────────────────────

/**
 * Connect to device sync worker via WebSocket.
 * Called automatically on startup (always-on sync).
 */
export function connect() {
  transportDisconnected = false;
  if (connectPromise) return connectPromise;
  const generation = connectionGeneration;
  const pending = connectOnce(generation).finally(() => {
    if (connectPromise === pending) connectPromise = null;
  });
  connectPromise = pending;
  return pending;
}

async function connectOnce(generation) {
  if (!await isAutoEnabled() || generation !== connectionGeneration) return;
  const state = await browser.tmDeviceSync.getState();
  if (generation !== connectionGeneration) return;
  if (state === "open" || state === "connecting" || state === "retrying") {
    connected = state === "open";
    notifyStatusListeners();
    return;
  }
  const { getAccessToken } = await import("./supabaseAuth.js");
  const accessToken = await getAccessToken();
  if (!accessToken || generation !== connectionGeneration) return;
  await initTimestampsIfNeeded();
  const enabled = await isAutoEnabled();
  const workerUrl = await getDeviceSyncUrl();
  if (!enabled || generation !== connectionGeneration) return;
  const result = await browser.tmDeviceSync.connect(`${workerUrl.replace("https://", "wss://")}/ws?token=${encodeURIComponent(accessToken)}`);
  if (generation !== connectionGeneration) return;
  connected = result === "open";
  notifyStatusListeners();
}

/** Explicit sync-off/signout disconnect. Idle suspension leaves the parent socket intact. */
export async function disconnect() {
  transportDisconnected = true;
  ++connectionGeneration;
  connectPromise = null;
  connected = false;
  notifyStatusListeners();
  // Every received message still waiting is dropped; one being applied finishes (DS-RECEIVE).
  await receivesEnded();
  await browser.tmDeviceSync.disconnect();
}

/**
 * Sign-out's cleanup — clears timers, disconnects. The storage listener stays: an edit made while signed out
 * still gets its timestamp and its history record, so it wins over older peers' values at the next connect
 * (DS-DEVICE). Idle suspension must retain the parent transport.
 */
export async function cleanupDeviceSync() {
  if (_broadcastDebounceTimer) {
    clearTimeout(_broadcastDebounceTimer);
    _broadcastDebounceTimer = null;
  }
  _broadcastPendingFields.clear();

  // Clear any pending AI cache probes
  for (const [, probe] of _pendingProbes) {
    clearTimeout(probe.timer);
    probe.resolve(null);
  }
  _pendingProbes.clear();

  await disconnect();
  log(`${PFX}Device sync cleaned up`);
}

/**
 * Check if device sync is currently connected
 */
export function isConnected() {
  return connected;
}

// ─── Auto-Enabled Toggle ─────────────────────────────────────────────

/**
 * Check if auto-sync is enabled (default: true).
 */
export async function isAutoEnabled() {
  try {
    const stored = await browser.storage.local.get({ [AUTO_ENABLED_KEY]: true });
    return !!stored[AUTO_ENABLED_KEY];
  } catch (e) {
    return true; // default enabled
  }
}

/**
 * Enable or disable auto-sync. When disabled, disconnects immediately.
 * When enabled, connects immediately.
 */
export async function setAutoEnabled(enabled) {
  await browser.storage.local.set({ [AUTO_ENABLED_KEY]: !!enabled });
  log(`${PFX}Auto-sync ${enabled ? "enabled" : "disabled"}`);
  if (enabled) {
    await connect();
  } else {
    await disconnect();
  }
}
