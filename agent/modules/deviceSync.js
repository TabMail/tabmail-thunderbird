/**
 * Device Sync Module - Always-On WebSocket Device Sync
 *
 * Maintains persistent WebSocket connection to sync relay worker for
 * auto-syncing prompt settings between TabMail instances (TB ↔ iOS).
 *
 * Protocol:
 * 1. Connect to sync relay worker via WebSocket (wss://sync[-dev].tabmail.ai/ws)
 * 2. Authenticate with Supabase JWT token
 * 3. On connect: auto-broadcast full state with per-field timestamps
 * 4. On local edit: debounced auto-broadcast changed fields (500ms)
 * 5. On receive prompt_state: per-field timestamp merge (newer wins)
 * 6. On receive ai_cache_probe: respond with local AI cache hits
 * 7. On receive ai_cache_response: resolve pending probe promises
 *
 * No data is persisted on the server — pure sync relay.
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { log } from "./utils.js";
import { getDeviceSyncUrl, SETTINGS } from "./config.js";

const PFX = "[DeviceSync] ";

// Valid field names for sync
const VALID_FIELDS = ["composition", "action", "kb", "templates", "disabledReminders", "taskCache"];

// Field → storage key mapping
const FIELD_KEYS = {
  composition: "user_prompts:user_composition.md",
  action: "user_prompts:user_action.md",
  kb: "user_prompts:user_kb.md",
  templates: "user_templates",
  disabledReminders: "disabled_reminders_v2",
  taskCache: "task_execution_cache",
};

// Field → per-field timestamp key mapping
const TIMESTAMP_KEYS = {
  composition: "device_sync_ts:composition",
  action: "device_sync_ts:action",
  kb: "device_sync_ts:kb",
  templates: "device_sync_ts:templates",
  disabledReminders: "device_sync_ts:disabledReminders",
  taskCache: "device_sync_ts:taskCache",
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

// Peer base state keys — stores the last STATE RECEIVED from any peer.
// This is the correct "common ancestor" for 3-way merge (NOT the merged result).
// CRITICAL: peer_base is ALWAYS set to `incoming`, NEVER to the merged result.
const PEER_BASE_KEYS = {
  composition: "device_peer_base:composition",
  action: "device_peer_base:action",
  kb: "device_peer_base:kb",
};
const PEER_BASE_TS_KEYS = {
  composition: "device_peer_base_ts:composition",
  action: "device_peer_base_ts:action",
  kb: "device_peer_base_ts:kb",
};

// Legacy sync base keys (migrated to peer base)
const LEGACY_BASE_KEYS = [
  "device_sync_base:composition",
  "device_sync_base:action",
  "device_sync_base:kb",
];

// Config
const SYNC_CONFIG = {
  pingIntervalMs: 30000,
  reconnectBaseDelayMs: 5000,
  reconnectMaxDelayMs: 300000, // 5 minutes
  maxReconnectAttempts: 10,
};

const PROBE_INTERVAL_MS = 300000; // 5 minutes

// Connection state
let socket = null;
let userId = null;
let connected = false;
let pingTimer = null;
let probeTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

// Suppress broadcast flag — set true when applying incoming sync to avoid echo
let suppressBroadcast = false;

// When true, onclose should NOT schedule a reconnect
let intentionalDisconnect = false;

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

  // Migrate old sync base → peer base (one-time)
  const legacyStored = await browser.storage.local.get(LEGACY_BASE_KEYS);
  const peerBaseStored = await browser.storage.local.get(Object.values(PEER_BASE_KEYS));
  const migrateUpdates = {};
  for (const field of ["composition", "action", "kb"]) {
    const oldKey = `device_sync_base:${field}`;
    if (legacyStored[oldKey] && !peerBaseStored[PEER_BASE_KEYS[field]]) {
      migrateUpdates[PEER_BASE_KEYS[field]] = legacyStored[oldKey];
    }
  }
  if (Object.keys(migrateUpdates).length > 0) {
    await browser.storage.local.set(migrateUpdates);
    log(`${PFX}Migrated ${Object.keys(migrateUpdates).length} sync base(s) to peer base`);
  }
  await browser.storage.local.remove(LEGACY_BASE_KEYS);
}

// ─── Prompt History ──────────────────────────────────────────────────────

/**
 * Record a snapshot of current prompt state in history.
 * @param {string} source - "local_edit", "reset", or "sync_receive"
 * @param {string[]} fields - Which fields changed
 */
async function recordHistory(source, fields) {
  try {
    await migrateBackupsToHistoryIfNeeded();
    const state = await readLocalState();
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source,
      fields,
      composition: state.composition || "",
      action: state.action || "",
      kb: state.kb || "",
      templatesJSON: JSON.stringify(state.templates || []),
    };

    const stored = await browser.storage.local.get(HISTORY_KEY);
    const history = stored[HISTORY_KEY] || [];
    history.push(entry);
    while (history.length > MAX_HISTORY_ENTRIES) history.shift();
    await browser.storage.local.set({ [HISTORY_KEY]: history });
  } catch (e) {
    log(`${PFX}Failed to record history: ${e}`, "warn");
  }
}

/**
 * Debounced history recording for local edits — waits 2s of quiet.
 * @param {string} field - The field that changed
 */
function debouncedRecordHistory(field) {
  _historyPendingFields.add(field);
  if (_historyDebounceTimer) clearTimeout(_historyDebounceTimer);
  _historyDebounceTimer = setTimeout(() => {
    _historyDebounceTimer = null;
    const fields = [..._historyPendingFields];
    _historyPendingFields.clear();
    recordHistory("local_edit", fields).catch((e) => {
      log(`${PFX}Debounced history record failed: ${e}`, "warn");
    });
  }, 2000);
}

/**
 * Load all history entries.
 * @returns {Promise<Array>} History entries (oldest first)
 */
export async function loadHistory() {
  await migrateBackupsToHistoryIfNeeded();
  const stored = await browser.storage.local.get(HISTORY_KEY);
  return stored[HISTORY_KEY] || [];
}

/**
 * Restore all prompt fields from a history entry.
 * Records pre-restore state, applies snapshot, then writes fresh timestamps
 * so the restore propagates to other devices.
 * @param {Object} entry - History entry to restore
 */
export async function restoreFromHistory(entry) {
  // Record current state before restoring
  await recordHistory("reset", ["composition", "action", "kb", "templates"]);

  // Apply snapshot (suppress broadcast)
  suppressBroadcast = true;
  try {
    const templates = JSON.parse(entry.templatesJSON || "[]");
    const now = new Date().toISOString();
    await browser.storage.local.set({
      [FIELD_KEYS.composition]: entry.composition,
      [FIELD_KEYS.action]: entry.action,
      [FIELD_KEYS.kb]: entry.kb,
      [FIELD_KEYS.templates]: templates,
      [TIMESTAMP_KEYS.composition]: now,
      [TIMESTAMP_KEYS.action]: now,
      [TIMESTAMP_KEYS.kb]: now,
      [TIMESTAMP_KEYS.templates]: now,
    });
    log(`${PFX}Restored from history entry ${entry.id?.substring(0, 8)}`);
  } finally {
    suppressBroadcast = false;
  }

  // Broadcast restored state to peers
  await broadcastState();
}

/**
 * One-time migration of existing device_sync_backups into prompt_history.
 */
async function migrateBackupsToHistoryIfNeeded() {
  const migrated = await browser.storage.local.get(HISTORY_MIGRATED_KEY);
  if (migrated[HISTORY_MIGRATED_KEY]) return;

  await browser.storage.local.set({ [HISTORY_MIGRATED_KEY]: true });

  const stored = await browser.storage.local.get(BACKUP_KEY);
  const backups = stored[BACKUP_KEY];
  if (!Array.isArray(backups) || backups.length === 0) return;

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
  await browser.storage.local.set({ [HISTORY_KEY]: history });
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
  try { callback(connected); } catch (_) {}
}

export function removeStatusListener(callback) {
  statusListeners.delete(callback);
}

// ─── Ping ───────────────────────────────────────────────────────────────

function sendPing() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "ping" }));
  }
}

// ─── Read / Broadcast State ─────────────────────────────────────────────

/**
 * Read current prompt state from browser.storage.local.
 * Includes per-field timestamps for merge decisions on the receiving end.
 * disabledReminders sends the full CRDT map (per-hash timestamps handle conflicts).
 * @param {string[]|null} fields - If specified, only include these fields
 */
async function readLocalState(fields = null) {
  try {
    const storageKeys = [
      ...Object.values(FIELD_KEYS),
      ...Object.values(TIMESTAMP_KEYS),
    ];
    const stored = await browser.storage.local.get(storageKeys);
    const state = { updatedAt: new Date().toISOString() };

    for (const field of VALID_FIELDS) {
      if (fields && !fields.includes(field)) continue;

      if (field === "taskCache") {
        // Send full cache map (per-key CRDT merge on receive)
        const { getAllCachedResults } = await import("./taskExecutionCache.js");
        state[field] = await getAllCachedResults();
      } else if (field === "disabledReminders") {
        // Send CRDT map (per-hash timestamps handle conflicts)
        state[field] = stored[FIELD_KEYS[field]] || {};
      } else if (field === "templates") {
        state[field] = stored[FIELD_KEYS[field]] || [];
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

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    const state = await readLocalState(fields);
    socket.send(JSON.stringify({ type: "prompt_state", data: state }));
    log(`${PFX}Broadcast prompt_state (fields=${fields || "all"})`);
  } catch (e) {
    log(`${PFX}Error broadcasting state: ${e}`, "error");
  }
}

// ─── Probe & Sync Now ───────────────────────────────────────────────────

/**
 * Request all prompt fields from peers (routine probe).
 * Peers respond with their current state and timestamps; the existing
 * per-field merge logic handles conflict resolution automatically.
 */
function probeAllFields() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "request_state", fields: VALID_FIELDS }));
  log(`${PFX}Probe: requested all fields from peers`);
}

/**
 * Public "Sync Now" — broadcasts local state AND requests state from peers.
 * Used by manual sync buttons.
 */
export async function syncNow() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log(`${PFX}syncNow: not connected, attempting connect first`);
    await connect();
    return; // connect will broadcastAllFields on success
  }
  await broadcastState();
  probeAllFields();
}

// ─── Reset Field to Default (Epoch-Zero Timestamp) ──────────────────────

/**
 * Reset a prompt field to its default value with epoch-zero timestamp.
 * This prevents the default from overwriting customized rules on other devices.
 * After writing, requests the field from peers so they send back their (newer) data.
 * @param {string} field - One of "composition", "action", "kb", "templates"
 * @param {string|Array} defaultValue - The bundled default value
 */
export async function resetFieldToDefault(field, defaultValue) {
  if (!VALID_FIELDS.includes(field)) {
    log(`${PFX}resetFieldToDefault: invalid field '${field}'`, "warn");
    return;
  }

  // Record pre-reset state in history
  await recordHistory("reset", [field]);

  // Suppress storage listener so reset doesn't trigger auto-broadcast
  suppressBroadcast = true;
  try {
    await browser.storage.local.set({
      [FIELD_KEYS[field]]: defaultValue,
      [TIMESTAMP_KEYS[field]]: EPOCH_ZERO,
    });
    log(`${PFX}Reset field '${field}' to default (timestamp → epoch zero)`);
  } finally {
    suppressBroadcast = false;
  }

  // Request state from peers — if they have newer (customized) data, it syncs back
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "request_state", fields: [field] }));
    log(`${PFX}Requested state from peers for field '${field}'`);
  }
}

// ─── Storage Change Listener (Auto-Broadcast on Local Edit) ─────────────

/**
 * Set up storage.onChanged listener for auto-broadcasting local edits.
 * Must be called once during init. Uses debounce to avoid flooding during rapid typing.
 */
export function setupStorageListener() {
  if (_storageChangeListener) return; // Already set up

  _storageChangeListener = (changes, area) => {
    if (area !== "local" || suppressBroadcast) return;

    // Check if any prompt-related key changed
    const changedFields = [];
    for (const [field, storageKey] of Object.entries(FIELD_KEYS)) {
      if (changes[storageKey]) {
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

    // Record history for local edits (debounced 2s)
    for (const field of changedFields) {
      debouncedRecordHistory(field);
    }

    // Debounce broadcast: reset timer, broadcast after quiet period
    if (_broadcastDebounceTimer) clearTimeout(_broadcastDebounceTimer);
    _broadcastDebounceTimer = setTimeout(() => {
      _broadcastDebounceTimer = null;
      const fields = [..._broadcastPendingFields];
      _broadcastPendingFields.clear();
      broadcastState(fields).catch((e) => {
        log(`${PFX}Debounced broadcast failed: ${e}`, "warn");
      });
    }, BROADCAST_DEBOUNCE_MS);
  };

  browser.storage.onChanged.addListener(_storageChangeListener);
  log(`${PFX}Storage change listener registered (auto-broadcast on edit)`);
}

// ─── Handle Incoming Prompt State (Per-Field Merge) ─────────────────────

/**
 * Resolve the timestamp for a field from incoming data.
 * Fallback chain: per-field ts → global updatedAt → epoch 0
 */
function resolveIncomingTimestamp(data, field) {
  return data[`${field}_updated_at`] || data.updatedAt || EPOCH_ZERO;
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
 * Handle incoming prompt_state from another client.
 *
 * Text fields (composition, action, kb) — state-based delta merge (git-style):
 *   1. Epoch-zero → skip (virgin/reset device)
 *   2. Stale (incoming_ts <= peer_base_ts) → skip
 *   3. No peer_base yet (first sync) → LWW (newer timestamp wins)
 *   4. No local changes since last sync (local == peer_base) → fast-forward
 *   5. Both sides changed → 3-way merge using peer_base as common ancestor
 *   6. CRITICAL: always save peer_base = incoming (NOT merged result)
 *
 * Templates: per-template CRDT merge by id (updatedAt comparison)
 * DisabledReminders: per-hash CRDT merge (ts comparison)
 *
 * Backs up current state before applying.
 */
/** Log git-style diff between old and new content for a field. */
function logSyncDiff(field, oldText, newText, mergeType) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const removed = oldLines.filter((l) => !newSet.has(l));
  const added = newLines.filter((l) => !oldSet.has(l));
  if (removed.length === 0 && added.length === 0) {
    log(`${PFX}${field} (${mergeType}): no visible diff (reordering only)`);
    return;
  }
  const lines = [`${PFX}${field} (${mergeType}) diff:`];
  for (const r of removed) lines.push(`  - ${r}`);
  for (const a of added) lines.push(`  + ${a}`);
  log(lines.join("\n"));
}

async function handlePromptState(data) {
  try {
    const localTimestamps = await readTimestamps();
    const localStored = await browser.storage.local.get([
      FIELD_KEYS.composition, FIELD_KEYS.action, FIELD_KEYS.kb,
    ]);
    const peerBaseStored = await browser.storage.local.get([
      ...Object.values(PEER_BASE_KEYS),
      ...Object.values(PEER_BASE_TS_KEYS),
    ]);

    // ─── Text fields: state-based delta merge ────────────────────────
    const textFieldsToApply = {};
    const timestampsToUpdate = {};
    const peerBaseUpdates = {}; // ALWAYS update peer_base = incoming

    for (const field of ["composition", "action", "kb"]) {
      if (data[field] === undefined || typeof data[field] !== "string") continue;

      const remote = data[field];
      const incomingTs = resolveIncomingTimestamp(data, field);

      // 1. Epoch-zero → skip
      if (incomingTs === EPOCH_ZERO) {
        log(`${PFX}Skipping ${field} — epoch-zero timestamp (virgin/reset)`);
        continue;
      }

      const peerBase = peerBaseStored[PEER_BASE_KEYS[field]] ?? null;
      const peerBaseTs = peerBaseStored[PEER_BASE_TS_KEYS[field]] || EPOCH_ZERO;
      const local = localStored[FIELD_KEYS[field]] || "";
      const localTs = localTimestamps[field] || EPOCH_ZERO;

      // 2. Stale — already processed this or newer
      if (incomingTs <= peerBaseTs) {
        log(`${PFX}Skipping ${field} — stale (incoming ${incomingTs} <= peer_base ${peerBaseTs})`);
        continue;
      }

      let result = null;

      if (peerBase === null) {
        // 3. First sync — no common ancestor, use LWW
        if (incomingTs > localTs) {
          result = remote;
          log(`${PFX}${field}: first sync, LWW accept (incoming ${incomingTs} > local ${localTs})`);
        } else {
          log(`${PFX}${field}: first sync, LWW keep local (local ${localTs} >= incoming ${incomingTs})`);
        }
      } else if (local === peerBase) {
        // 4. Fast-forward — no local changes since last sync
        result = remote;
        log(`${PFX}${field}: fast-forward (no local changes since last sync)`);
      } else {
        // 5. Both sides changed — 3-way merge using peer_base as common ancestor
        let merged;
        if (field === "kb") {
          const { mergeFlatField } = await import("./bulletMerge.js");
          merged = mergeFlatField(peerBase, local, remote);
        } else {
          const { mergeSectionedField, COMPOSITION_SECTIONS, ACTION_SECTIONS } = await import("./bulletMerge.js");
          const headers = field === "composition" ? COMPOSITION_SECTIONS : ACTION_SECTIONS;
          merged = mergeSectionedField(peerBase, local, remote, headers);
        }
        if (merged !== local) {
          result = merged;
          log(`${PFX}${field}: 3-way merge (both sides changed)`);
        } else {
          log(`${PFX}${field}: 3-way merge produced no change`);
        }
      }

      // 6. ALWAYS save peer_base = incoming (NOT merged result)
      peerBaseUpdates[PEER_BASE_KEYS[field]] = remote;
      peerBaseUpdates[PEER_BASE_TS_KEYS[field]] = incomingTs;

      if (result !== null && result !== local) {
        const mergeType = peerBase === null ? "LWW" : local === peerBase ? "fast-forward" : "3-way merge";
        logSyncDiff(field, local, result, mergeType);
        textFieldsToApply[field] = result;
        timestampsToUpdate[field] = incomingTs > localTs ? incomingTs : localTs;
      }
    }

    const textFieldNames = Object.keys(textFieldsToApply);

    const willMergeTemplates = data.templates !== undefined && Array.isArray(data.templates)
      && resolveIncomingTimestamp(data, "templates") !== EPOCH_ZERO
      && data.templates.some((t) => t && typeof t.id === "string" && typeof t.name === "string");
    const willMergeReminders = data.disabledReminders !== undefined
      && resolveIncomingTimestamp(data, "disabledReminders") !== EPOCH_ZERO
      && (Array.isArray(data.disabledReminders) || (typeof data.disabledReminders === "object" && data.disabledReminders !== null));
    const willMergeTaskCache = data.taskCache !== undefined
      && resolveIncomingTimestamp(data, "taskCache") !== EPOCH_ZERO
      && typeof data.taskCache === "object" && data.taskCache !== null;

    // Capture pre-merge snapshot for history (before templates/reminders are applied)
    const preMergeSnapshot = (textFieldNames.length > 0 || willMergeTemplates || willMergeReminders || willMergeTaskCache)
      ? await readLocalState() : null;

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
    if (willMergeTaskCache) {
      try {
        if (Object.keys(data.taskCache).length > 0) {
          const { mergeIncomingCache } = await import("./taskExecutionCache.js");
          suppressBroadcast = true;
          await mergeIncomingCache(data.taskCache);
          taskCacheMerged = true;
          suppressBroadcast = false;
        }
      } catch (e) {
        log(`${PFX}TaskCache CRDT merge failed: ${e}`, "warn");
        suppressBroadcast = false;
      }
    }

    // ─── Apply text field updates + peer base ─────────────────────────
    // Always save peer base updates (even if no text fields were applied)
    if (Object.keys(peerBaseUpdates).length > 0) {
      await browser.storage.local.set(peerBaseUpdates);
    }

    if (textFieldNames.length === 0 && !templatesMerged && !remindersMerged && !taskCacheMerged) {
      log(`${PFX}No fields to apply`);
      return;
    }

    // Record history only when something actually changed, using pre-merge snapshot
    const actuallyChanged = [
      ...textFieldNames,
      ...(templatesMerged ? ["templates"] : []),
      ...(remindersMerged ? ["disabledReminders"] : []),
      ...(taskCacheMerged ? ["taskCache"] : []),
    ];
    if (actuallyChanged.length > 0 && preMergeSnapshot) {
      try {
        const entry = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          source: "sync_receive",
          fields: actuallyChanged,
          composition: preMergeSnapshot.composition || "",
          action: preMergeSnapshot.action || "",
          kb: preMergeSnapshot.kb || "",
          templatesJSON: JSON.stringify(preMergeSnapshot.templates || []),
        };
        const stored = await browser.storage.local.get(HISTORY_KEY);
        const history = stored[HISTORY_KEY] || [];
        history.push(entry);
        while (history.length > MAX_HISTORY_ENTRIES) history.shift();
        await browser.storage.local.set({ [HISTORY_KEY]: history });
      } catch (e) {
        log(`${PFX}Failed to record history: ${e}`, "warn");
      }
    }

    if (textFieldNames.length > 0) {
      const updates = {};
      for (const field of textFieldNames) {
        updates[FIELD_KEYS[field]] = textFieldsToApply[field];
        updates[TIMESTAMP_KEYS[field]] = timestampsToUpdate[field];
      }

      const snapshot = await browser.storage.local.get(Object.keys(updates));

      suppressBroadcast = true;
      try {
        await browser.storage.local.set(updates);
        log(`${PFX}Applied incoming text fields via delta merge (${textFieldNames.join(", ")})`);
      } catch (applyError) {
        log(`${PFX}Failed to apply state, rolling back: ${applyError}`, "error");
        try {
          await browser.storage.local.set(snapshot);
          log(`${PFX}Rollback succeeded`);
        } catch (rollbackError) {
          log(`${PFX}Rollback also failed: ${rollbackError}`, "error");
        }
      } finally {
        suppressBroadcast = false;
      }
    }

    log(`${PFX}Applied incoming prompt_state (${actuallyChanged.join(", ")})`);
  } catch (e) {
    log(`${PFX}Error handling prompt_state: ${e}`, "error");
    suppressBroadcast = false;
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
    if (!socket || socket.readyState !== WebSocket.OPEN) {
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
      socket.send(JSON.stringify(msg));
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
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
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
        // Virgin device (all timestamps epoch-zero): skip broadcast, probe peers instead.
        // Prevents default prompts from triggering LWW overwrites on established devices.
        {
          const timestamps = await readTimestamps();
          const allEpochZero = Object.values(timestamps).every((ts) => ts === EPOCH_ZERO);
          if (allEpochZero) {
            log(`${PFX}Virgin device — skipping broadcast, probing peers instead`);
            probeAllFields();
          } else {
            broadcastState().catch((e) => {
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
          await handlePromptState(parsed.data);
        }
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
export async function connect() {
  // Reset intentional disconnect flag — this connect() call is intentional,
  // so any prior disconnect()'s flag should not block us.
  intentionalDisconnect = false;

  // Don't connect if auto-sync is disabled
  const autoEnabled = await isAutoEnabled();
  if (!autoEnabled) {
    log(`${PFX}Auto-sync disabled, skipping connect`);
    return;
  }

  // Don't connect if already connected
  if (socket && socket.readyState === WebSocket.OPEN) {
    return;
  }

  // Get access token for authentication
  let accessToken;
  try {
    const { getAccessToken, getSession } = await import("./supabaseAuth.js");
    accessToken = await getAccessToken();

    if (!accessToken) {
      log(`${PFX}No access token, cannot connect`);
      return;
    }

    // Decode JWT to get user ID (for logging)
    const session = await getSession();
    if (session?.access_token) {
      const b64url = session.access_token.split(".")[1];
      const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (b64url.length % 4)) % 4);
      const payload = JSON.parse(atob(b64));
      userId = payload.sub;
    }
  } catch (e) {
    log(`${PFX}Failed to get access token: ${e}`);
    return;
  }

  // Initialize per-field timestamps for new devices (epoch 0)
  await initTimestampsIfNeeded();

  // Re-check auto-enabled after async operations — user may have disabled while
  // we were awaiting the access token (race between connect/disconnect).
  const stillEnabled = await isAutoEnabled();
  if (!stillEnabled || intentionalDisconnect) {
    log(`${PFX}Aborting connect — sync was disabled during auth`);
    return;
  }

  log(`${PFX}Connecting to WebSocket for user ${userId?.substring(0, 8)}...`);

  // Build WebSocket URL with token for auth
  const workerUrl = await getDeviceSyncUrl();
  const wsUrl = `${workerUrl.replace("https://", "wss://")}/ws?token=${encodeURIComponent(accessToken)}`;

  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      log(`${PFX}WebSocket connected`);
      connected = true;
      reconnectAttempts = 0;
      notifyStatusListeners();

      // Start ping interval
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(sendPing, SYNC_CONFIG.pingIntervalMs);

      // Start probe interval — periodically request state from peers (every 5 min)
      if (probeTimer) clearInterval(probeTimer);
      probeTimer = setInterval(probeAllFields, PROBE_INTERVAL_MS);
    };

    socket.onmessage = (event) => {
      handleMessage(event.data);
    };

    socket.onerror = (e) => {
      log(`${PFX}WebSocket error: ${e.type}`, "warn");
    };

    socket.onclose = (e) => {
      log(`${PFX}WebSocket closed: code=${e.code}, reason=${e.reason}`);
      connected = false;
      notifyStatusListeners();

      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
      }

      // Always reconnect unless intentionally disconnected
      if (!reconnectTimer && !intentionalDisconnect) {
        if (reconnectAttempts >= SYNC_CONFIG.maxReconnectAttempts) {
          log(`${PFX}Max reconnect attempts (${SYNC_CONFIG.maxReconnectAttempts}) reached — giving up`);
          return;
        }
        const delay = Math.min(
          SYNC_CONFIG.reconnectBaseDelayMs * Math.pow(2, reconnectAttempts),
          SYNC_CONFIG.reconnectMaxDelayMs
        );
        reconnectAttempts++;
        log(`${PFX}Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${SYNC_CONFIG.maxReconnectAttempts})`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      }
    };
  } catch (e) {
    log(`${PFX}WebSocket creation failed: ${e}`, "error");
  }
}

/**
 * Disconnect from WebSocket
 */
export function disconnect() {
  intentionalDisconnect = true;
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
  connected = false;
  reconnectAttempts = 0;
  notifyStatusListeners();
  log(`${PFX}Disconnected from WebSocket`);
}

/**
 * Full cleanup — removes storage listener, clears timers, disconnects.
 * Called on extension suspend.
 */
export function cleanupDeviceSync() {
  if (_storageChangeListener) {
    browser.storage.onChanged.removeListener(_storageChangeListener);
    _storageChangeListener = null;
  }
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

  disconnect();
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
    disconnect();
  }
}
