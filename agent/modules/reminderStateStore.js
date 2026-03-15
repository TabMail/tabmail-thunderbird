// reminderStateStore.js – Minimal state store for disabled reminders
// Thunderbird 145 MV3
//
// v2 CRDT format: Stores {hash: {enabled: Bool, ts: ISO8601}} map instead of [String] array.
// Per-hash timestamps enable convergent merge (newer ts wins per hash).
// `enabled: false` = disabled, `enabled: true` = re-enabled (tombstone), absent = enabled (default).

import { log } from "./utils.js";

// Storage keys
const DISABLED_REMINDERS_KEY_V1 = "disabled_reminders";
const DISABLED_REMINDERS_KEY_V2 = "disabled_reminders_v2";

// GC age threshold — entries not in fresh set and older than this are removed.
const GC_AGE_DAYS = 90;

/**
 * Generate a stable hash for a reminder.
 * - Message reminders: `m:{rfc2822MessageId}` (cross-platform, bracket-stripped)
 *   Fallback: `m:{uniqueId}` (platform-specific, won't dedup cross-platform)
 * - KB reminders: `k:{djb2hash}` (content-based, already cross-platform)
 * - Fallback: `o:{first32chars}`
 * @param {Object} reminder - Reminder object
 * @returns {string} Stable hash key
 */
export function hashReminder(reminder) {
  if (reminder.source === "message") {
    // Prefer shared cross-platform hash using RFC 2822 Message-ID
    if (reminder.rfc822MessageId) {
      return `m:${reminder.rfc822MessageId.replace(/[<>]/g, "")}`;
    }
    // Fallback: platform-specific (won't dedup cross-platform)
    if (reminder.uniqueId) {
      return `m:${reminder.uniqueId}`;
    }
  } else if (reminder.source === "kb") {
    // Simple hash of content for KB reminders
    const content = reminder.content || "";
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `k:${hash.toString(36)}`;
  }
  // Fallback
  return `o:${(reminder.content || "").slice(0, 32)}`;
}

// ─── v1 → v2 Migration ──────────────────────────────────────────────────

let _migrated = false;

/**
 * Migrate v1 array to v2 CRDT map on first access.
 */
async function migrateIfNeeded() {
  if (_migrated) return;
  _migrated = true;

  try {
    const stored = await browser.storage.local.get([DISABLED_REMINDERS_KEY_V1, DISABLED_REMINDERS_KEY_V2]);

    // Already migrated if v2 exists
    if (stored[DISABLED_REMINDERS_KEY_V2]) return;

    const oldHashes = stored[DISABLED_REMINDERS_KEY_V1];
    if (Array.isArray(oldHashes) && oldHashes.length > 0) {
      const now = new Date().toISOString();
      const map = {};
      for (const hash of oldHashes) {
        map[hash] = { enabled: false, ts: now };
      }
      await browser.storage.local.set({ [DISABLED_REMINDERS_KEY_V2]: map });
      log(`[ReminderState] Migrated ${oldHashes.length} entries from v1 to v2 CRDT format`);
    }
  } catch (e) {
    log(`[ReminderState] Migration error: ${e}`, "warn");
  }
}

// ─── CRDT Map Read/Write ─────────────────────────────────────────────────

/**
 * Get the full CRDT map.
 * @returns {Promise<Object>} Map of {hash: {enabled, ts}}
 */
export async function getDisabledMap() {
  await migrateIfNeeded();
  try {
    const stored = await browser.storage.local.get({ [DISABLED_REMINDERS_KEY_V2]: {} });
    return stored[DISABLED_REMINDERS_KEY_V2] || {};
  } catch (e) {
    log(`[ReminderState] Error loading disabled map: ${e}`, "error");
    return {};
  }
}

/**
 * Save the CRDT map.
 * @param {Object} map - Map of {hash: {enabled, ts}}
 */
async function saveDisabledMap(map) {
  try {
    await browser.storage.local.set({ [DISABLED_REMINDERS_KEY_V2]: map });
  } catch (e) {
    log(`[ReminderState] Error saving disabled map: ${e}`, "error");
  }
}

/**
 * Get set of disabled hashes from storage (entries where enabled == false).
 * @returns {Promise<Set<string>>}
 */
export async function getDisabledHashes() {
  const map = await getDisabledMap();
  const disabled = new Set();
  for (const [hash, entry] of Object.entries(map)) {
    if (!entry.enabled) {
      disabled.add(hash);
    }
  }
  return disabled;
}

/**
 * Set enabled status for a reminder hash (idempotent).
 * Writes a CRDT entry with current timestamp.
 * Broadcasts change to P2P peers (local user action).
 * @param {string} hash - Reminder hash
 * @param {boolean} enabled - Whether enabled (true = re-enabled tombstone, false = disabled)
 */
export async function setEnabled(hash, enabled) {
  const map = await getDisabledMap();
  map[hash] = { enabled, ts: new Date().toISOString() };
  await saveDisabledMap(map);

  const disabledCount = Object.values(map).filter((e) => !e.enabled).length;
  log(`[ReminderState] Set ${hash} enabled=${enabled} (disabled count: ${disabledCount})`);

  // Broadcast to P2P peers
  try {
    const { broadcastState } = await import("./p2pSync.js");
    await broadcastState(["disabledReminders"]);
  } catch (e) {
    log(`[ReminderState] Failed to broadcast after setEnabled: ${e}`, "warn");
  }
}

/**
 * CRDT merge: per-hash, newer timestamp wins.
 * Does NOT trigger a broadcast (used for incoming P2P sync).
 * @param {Object} incomingMap - Map of {hash: {enabled, ts}}
 */
export async function mergeIncoming(incomingMap) {
  const localMap = await getDisabledMap();
  let merged = 0;

  for (const [hash, inEntry] of Object.entries(incomingMap)) {
    // Validate entry structure
    if (!inEntry || typeof inEntry.ts !== "string" || typeof inEntry.enabled !== "boolean") continue;

    const localEntry = localMap[hash];
    if (!localEntry || inEntry.ts > localEntry.ts) {
      localMap[hash] = inEntry;
      merged++;
    }
  }

  if (merged > 0) {
    await saveDisabledMap(localMap);
  }
  log(`[ReminderState] CRDT merge: ${merged} entries adopted from ${Object.keys(incomingMap).length} incoming (local total: ${Object.keys(localMap).length})`);
}

/**
 * Time-based GC: remove entries NOT in fresh set AND older than GC_AGE_DAYS.
 * Replaces the old aggressive syncState() which immediately removed orphans.
 * @param {Set<string>} freshHashes - Set of hashes from current reminders
 */
export async function gcStaleEntries(freshHashes) {
  const map = await getDisabledMap();
  if (Object.keys(map).length === 0) return;

  const now = Date.now();
  const maxAge = GC_AGE_DAYS * 86400 * 1000;
  let removed = 0;

  for (const [hash, entry] of Object.entries(map)) {
    if (!freshHashes.has(hash)) {
      const entryTime = new Date(entry.ts).getTime();
      if (now - entryTime > maxAge) {
        delete map[hash];
        removed++;
      }
    }
  }

  if (removed > 0) {
    await saveDisabledMap(map);
    log(`[ReminderState] GC removed ${removed} entries older than ${GC_AGE_DAYS} days`);
  }
}
