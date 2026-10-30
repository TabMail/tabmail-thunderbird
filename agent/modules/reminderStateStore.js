/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// reminderStateStore.js – Minimal state store for disabled reminders
// Thunderbird 145 MV3
//
// v2 CRDT format: Stores {hash: {enabled: Bool, ts: ISO8601}} map instead of [String] array.
// Per-hash timestamps enable convergent merge (newer ts wins per hash).
// `enabled: false` = disabled, `enabled: true` = re-enabled (tombstone), absent = enabled (default).

import { log } from "./utils.js";

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

// ─── CRDT Map Read/Write ─────────────────────────────────────────────────
// The map is changed only in a hold of the device's prompt semaphore (promptStore.js), as every store a
// received `prompt_state` writes: a local change and a received merge never interleave, so neither drops
// the other's entries. A device with only the v1 list reads it as the map; the next change stores it as v2
// (deviceSync.js readStoredField).

/** What a reminder change reports when the prompt store stayed busy through every try (DS-NO-BUSY-UI). */
export const REMINDERS_BUSY_ERROR = "Couldn't save: the reminders are busy. Try again in a moment.";

/**
 * Get the full CRDT map.
 * @returns {Promise<Object>} Map of {hash: {enabled, ts}}
 */
export async function getDisabledMap() {
  try {
    const { readStoredField } = await import("./deviceSync.js");
    return (await readStoredField("disabledReminders")).value || {};
  } catch (e) {
    log(`[ReminderState] Error loading disabled map: ${e}`, "error");
    return {};
  }
}

/**
 * A local change of the map, in one hold of the prompt semaphore: the stored map is read, `change(map)` run
 * on a copy, and the map saved as a local edit (stamped, sent to peers) when it returns true. Throws, with
 * nothing saved, when the hold ended before the save, or REMINDERS_BUSY_ERROR when the store stayed busy.
 * @param {string} label - What changes it, for the logs
 * @param {(map: Object) => boolean} change
 * @returns {Promise<Object>} The map as saved, or as read when unchanged
 */
async function editDisabledMap(label, change) {
  const { withPromptStore } = await import("./promptStore.js");
  try {
    return await withPromptStore(async (store) => {
      const map = { ...((await store.field("disabledReminders")).value || {}) };
      if (change(map)) await store.saveField("disabledReminders", map);
      return map;
    }, { label });
  } catch (e) {
    throw e?.busy === true ? Object.assign(new Error(REMINDERS_BUSY_ERROR), { busy: true }) : e;
  }
}

/** Puts each of `incoming`'s valid entries into `map` where newer than its own. Returns how many. */
function mergeEntries(map, incoming) {
  let merged = 0;
  for (const [hash, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry.ts !== "string" || typeof entry.enabled !== "boolean") continue;
    if (!map[hash] || entry.ts > map[hash].ts) {
      map[hash] = entry;
      merged++;
    }
  }
  return merged;
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
 * Set enabled status for a reminder hash (idempotent): a CRDT entry with the current timestamp, saved as a
 * local edit, which sends it to Device Sync peers.
 * @param {string} hash - Reminder hash
 * @param {boolean} enabled - Whether enabled (true = re-enabled tombstone, false = disabled)
 */
export async function setEnabled(hash, enabled) {
  const map = await editDisabledMap("reminder enable", (map) => {
    map[hash] = { enabled, ts: new Date().toISOString() };
    return true;
  });
  const disabledCount = Object.values(map).filter((e) => !e.enabled).length;
  log(`[ReminderState] Set ${hash} enabled=${enabled} (disabled count: ${disabledCount})`);
}

/**
 * Entries this device moves to new hashes (the reminder list's hash migration), merged per hash, newer
 * wins, as a local edit.
 * @param {Object} entries - Map of {hash: {enabled, ts}}
 */
export async function migrateEntries(entries) {
  let merged = 0;
  await editDisabledMap("reminder hash migration", (map) => (merged = mergeEntries(map, entries)) > 0);
  log(`[ReminderState] Hash migration: ${merged} entries`);
}

/**
 * CRDT merge of a received map: per-hash, newer timestamp wins. Run by Device Sync inside its hold of the
 * prompt semaphore, `store`; saved as received (not sent back). Throws a `changed` error, with nothing
 * saved, when that hold ended first.
 * @param {Object} incomingMap - Map of {hash: {enabled, ts}}
 * @param {PromptStoreHold} store - The hold it runs in
 * @returns {Promise<number>} How many entries it adopted
 */
export async function mergeIncoming(incomingMap, store) {
  const localMap = { ...((await store.field("disabledReminders")).value || {}) };
  const merged = mergeEntries(localMap, incomingMap);
  if (merged > 0) await store.saveField("disabledReminders", localMap, { received: true });
  log(`[ReminderState] CRDT merge: ${merged} entries adopted from ${Object.keys(incomingMap).length} incoming (local total: ${Object.keys(localMap).length})`);
  return merged;
}

/**
 * Time-based GC: remove entries NOT in fresh set AND older than GC_AGE_DAYS.
 * Replaces the old aggressive syncState() which immediately removed orphans.
 * @param {Set<string>} freshHashes - Set of hashes from current reminders
 */
export async function gcStaleEntries(freshHashes) {
  const now = Date.now();
  const maxAge = GC_AGE_DAYS * 86400 * 1000;
  let removed = 0;
  await editDisabledMap("reminder clean-up", (map) => {
    for (const [hash, entry] of Object.entries(map)) {
      if (!freshHashes.has(hash) && now - new Date(entry.ts).getTime() > maxAge) {
        delete map[hash];
        removed++;
      }
    }
    return removed > 0;
  });
  if (removed > 0) log(`[ReminderState] GC removed ${removed} entries older than ${GC_AGE_DAYS} days`);
}
