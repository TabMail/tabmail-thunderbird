/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// taskExecutionCache.js – Storage cache for task execution results
// Thunderbird 145 MV3
// Keyed by "{taskHash}_{YYYY-MM-DD}". Stores content, sessionId, and timestamp.

import { log } from "./utils.js";

const STORAGE_KEY = "task_execution_cache";

// Maximum entries to keep per taskHash (occurrence-based eviction)
const MAX_ENTRIES_PER_TASK = 10;

// GC threshold for orphaned entries (tasks no longer in KB)
const GC_AGE_DAYS = 90;

/**
 * Load the cache from storage. Each operation reads its own copy: there is no shared in-memory copy, so a
 * slow first read can never put an older copy over a newer one.
 * @returns {Promise<Object>} Cache map
 */
async function loadCache() {
  try {
    const stored = await browser.storage.local.get({ [STORAGE_KEY]: {} });
    return stored[STORAGE_KEY] || {};
  } catch (e) {
    log(`[TaskCache] Error loading cache from storage: ${e}`, "error");
    return {};
  }
}

/**
 * Persist an operation's cache map to storage.
 * @param {Object} cache - The cache map
 */
async function saveCache(cache) {
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: cache });
  } catch (e) {
    log(`[TaskCache] Error saving cache to storage: ${e}`, "error");
  }
}

/**
 * One read-change-save of the cache map in a hold of the prompt semaphore (DS-SEMAPHORE), so two writers
 * never save over each other's entries: `store`, the hold of a received message's apply, or else a hold of
 * its own. `change(cache)` edits the map in place and returns whether it changed it. The map is saved only
 * while the hold lasts (DS-LEASE); a hold that ended first throws a `busy` error and saves nothing.
 * @returns {Promise<boolean>} Whether the map was saved
 */
async function changeCache(change, store) {
  if (store) return changeCacheIn(store, change);
  const { withPromptStore } = await import("./promptStore.js");
  return withPromptStore((hold) => changeCacheIn(hold, change), { label: "task cache" });
}

async function changeCacheIn(store, change) {
  const cache = await loadCache();
  if (!change(cache)) return false;
  if (!store.holds()) {
    const error = new Error("the task cache's hold ended before its save");
    error.busy = true;
    throw error;
  }
  await saveCache(cache);
  return true;
}

/**
 * Build the composite key for a cache entry.
 * @param {string} taskHash - e.g., "t:12345"
 * @param {string} dateStr - e.g., "2026-03-27"
 * @returns {string} Composite key
 */
function cacheKey(taskHash, dateStr) {
  return `${taskHash}_${dateStr}`;
}

/**
 * Get a cached task execution result.
 * @param {string} taskHash - Task hash (e.g., "t:12345")
 * @param {string} dateStr - Date string "YYYY-MM-DD"
 * @returns {Promise<{content: string, sessionId: string, timestamp: string}|null>}
 */
export async function getCachedResult(taskHash, dateStr) {
  const cache = await loadCache();
  const key = cacheKey(taskHash, dateStr);
  const entry = cache[key];
  if (!entry) return null;
  return {
    content: entry.content,
    sessionId: entry.sessionId,
    timestamp: entry.ts,
  };
}

/**
 * Store a task execution result. Evicts oldest entries if a single taskHash
 * exceeds MAX_ENTRIES_PER_TASK occurrences.
 * @param {string} taskHash - Task hash (e.g., "t:12345")
 * @param {string} dateStr - Date string "YYYY-MM-DD"
 * @param {string} content - Execution result content
 * @param {string} sessionId - Chat session ID
 */
export async function setCachedResult(taskHash, dateStr, content, sessionId) {
  const key = cacheKey(taskHash, dateStr);
  try {
    await changeCache((cache) => {
      cache[key] = {
        content,
        sessionId,
        ts: new Date().toISOString(),
      };

      // Evict oldest entries if this taskHash has too many
      evictExcessEntries(cache, taskHash);
      return true;
    });
  } catch (e) {
    if (e?.busy !== true) throw e;
    log(`[TaskCache] Result for ${key} not cached: ${e}`, "warn");
    return;
  }
  log(`[TaskCache] Cached result for ${key}`);
}

/**
 * Evict oldest entries for a given taskHash if count exceeds MAX_ENTRIES_PER_TASK.
 * Keeps the most recent entries by timestamp.
 * @param {Object} cache - The cache map (mutated in place)
 * @param {string} taskHash - The task hash prefix to check
 */
function evictExcessEntries(cache, taskHash) {
  const prefix = `${taskHash}_`;
  const matchingKeys = Object.keys(cache).filter((k) => k.startsWith(prefix));

  if (matchingKeys.length <= MAX_ENTRIES_PER_TASK) return;

  // Sort by timestamp ascending (oldest first)
  matchingKeys.sort((a, b) => {
    const tsA = cache[a].ts || "";
    const tsB = cache[b].ts || "";
    return tsA.localeCompare(tsB);
  });

  const toRemove = matchingKeys.length - MAX_ENTRIES_PER_TASK;
  for (let i = 0; i < toRemove; i++) {
    delete cache[matchingKeys[i]];
  }

  log(`[TaskCache] Evicted ${toRemove} old entries for ${taskHash}`);
}

/**
 * Get the full cache map (for Device Sync broadcast).
 * @returns {Promise<Object>} Full cache map
 */
export async function getAllCachedResults() {
  return await loadCache();
}

/**
 * CRDT merge: per-key, newer timestamp wins.
 * Does NOT trigger a broadcast (used by Device Sync receiver).
 * @param {Object} incomingMap - Map of {compositeKey: {content, sessionId, ts}}
 * @param {Object} store - The hold of the received message's apply, which the merge saves in (never a
 *   nested acquire); a hold that ended before the save throws a `busy` error, so the message is applied again
 */
export async function mergeIncomingCache(incomingMap, store) {
  let merged = 0;
  let total = 0;
  await changeCache((cache) => {
    for (const [key, inEntry] of Object.entries(incomingMap)) {
      if (!inEntry || typeof inEntry.ts !== "string") continue;

      const localEntry = cache[key];
      if (!localEntry || inEntry.ts > localEntry.ts) {
        cache[key] = inEntry;
        merged++;
      }
    }
    total = Object.keys(cache).length;
    return merged > 0;
  }, store);

  log(`[TaskCache] CRDT merge: ${merged} entries adopted from ${Object.keys(incomingMap).length} incoming (local total: ${total})`);
}

/**
 * Remove cache entries for tasks that are no longer in the KB.
 * Only removes entries older than GC_AGE_DAYS to avoid premature cleanup
 * during temporary KB edits.
 * @param {Set<string>} activeTaskHashes - Set of task hashes currently in KB
 */
export async function gcOrphanedEntries(activeTaskHashes) {
  const now = Date.now();
  const maxAge = GC_AGE_DAYS * 86400 * 1000;
  let removed = 0;

  try {
    await changeCache((cache) => {
      for (const [key, entry] of Object.entries(cache)) {
        // Extract taskHash from composite key "taskHash_YYYY-MM-DD"
        const lastUnderscore = key.lastIndexOf("_");
        if (lastUnderscore === -1) {
          // Malformed key, remove it
          delete cache[key];
          removed++;
          continue;
        }

        const taskHash = key.substring(0, lastUnderscore);
        if (activeTaskHashes.has(taskHash)) continue;

        const entryTime = new Date(entry.ts).getTime();
        if (now - entryTime > maxAge) {
          delete cache[key];
          removed++;
        }
      }
      return removed > 0;
    });
  } catch (e) {
    if (e?.busy !== true) throw e;
    log(`[TaskCache] GC not saved (the next check-in runs it again): ${e}`, "warn");
    return;
  }

  if (removed > 0) {
    log(`[TaskCache] GC removed ${removed} orphaned entries older than ${GC_AGE_DAYS} days`);
  }
}
