// taskExecutionCache.js – In-memory + storage cache for task execution results
// Thunderbird 145 MV3
// Keyed by "{taskHash}_{YYYY-MM-DD}". Stores content, sessionId, and timestamp.

import { log } from "./utils.js";

const STORAGE_KEY = "task_execution_cache";

// Maximum entries to keep per taskHash (occurrence-based eviction)
const MAX_ENTRIES_PER_TASK = 10;

// GC threshold for orphaned entries (tasks no longer in KB)
const GC_AGE_DAYS = 90;

// In-memory mirror of storage cache
let _memoryCache = null;

/**
 * Load cache from storage into memory (lazy init).
 * @returns {Promise<Object>} Cache map
 */
async function loadCache() {
  if (_memoryCache !== null) {
    return _memoryCache;
  }
  try {
    const stored = await browser.storage.local.get({ [STORAGE_KEY]: {} });
    _memoryCache = stored[STORAGE_KEY] || {};
  } catch (e) {
    log(`[TaskCache] Error loading cache from storage: ${e}`, "error");
    _memoryCache = {};
  }
  return _memoryCache;
}

/**
 * Persist the in-memory cache to storage.
 */
async function saveCache() {
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: _memoryCache });
  } catch (e) {
    log(`[TaskCache] Error saving cache to storage: ${e}`, "error");
  }
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
  const cache = await loadCache();
  const key = cacheKey(taskHash, dateStr);

  cache[key] = {
    content,
    sessionId,
    ts: new Date().toISOString(),
  };

  // Evict oldest entries if this taskHash has too many
  evictExcessEntries(cache, taskHash);

  await saveCache();
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
 */
export async function mergeIncomingCache(incomingMap) {
  const cache = await loadCache();
  let merged = 0;

  for (const [key, inEntry] of Object.entries(incomingMap)) {
    if (!inEntry || typeof inEntry.ts !== "string") continue;

    const localEntry = cache[key];
    if (!localEntry || inEntry.ts > localEntry.ts) {
      cache[key] = inEntry;
      merged++;
    }
  }

  if (merged > 0) {
    await saveCache();
  }

  log(`[TaskCache] CRDT merge: ${merged} entries adopted from ${Object.keys(incomingMap).length} incoming (local total: ${Object.keys(cache).length})`);
}

/**
 * Remove cache entries for tasks that are no longer in the KB.
 * Only removes entries older than GC_AGE_DAYS to avoid premature cleanup
 * during temporary KB edits.
 * @param {Set<string>} activeTaskHashes - Set of task hashes currently in KB
 */
export async function gcOrphanedEntries(activeTaskHashes) {
  const cache = await loadCache();
  if (Object.keys(cache).length === 0) return;

  const now = Date.now();
  const maxAge = GC_AGE_DAYS * 86400 * 1000;
  let removed = 0;

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

  if (removed > 0) {
    await saveCache();
    log(`[TaskCache] GC removed ${removed} orphaned entries older than ${GC_AGE_DAYS} days`);
  }
}
