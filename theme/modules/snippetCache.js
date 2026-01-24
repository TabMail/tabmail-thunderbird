// theme/modules/snippetCache.js
// Persistent IDB-based snippet cache for card snippets.
// IDB-only cache: experiment has in-memory cache for instant fillRow access,
// so MV3 memory cache was removed to avoid double caching.
//
// Key strategy: use the unique message key (accountId:folderPath:headerMessageId)
// so snippets survive message moves within the same account.

import { SETTINGS } from "../../agent/modules/config.js";
import * as idb from "../../agent/modules/idbStorage.js";

// IDB key prefix for snippet cache entries
const SNIPPET_PREFIX = "snippet:";

// MV3 memory cache removed - experiment has in-memory cache for instant fillRow access
// Keeping this empty for potential future use or debugging
// const memoryCache = new Map();

// Diagnostic counters (bounded)
const diagState = {
  // memHits removed - no MV3 memory cache
  idbHits: 0,
  idbMisses: 0,
  idbWrites: 0,
  logCount: 0,
  lastLogMs: 0,
};

const DIAG_CONFIG = {
  maxLogs: 30,
  minLogIntervalMs: 2000,
};

function _plog(...args) {
  try {
    console.log("[TabMail][SnippetCache]", ...args);
  } catch (_) {}
}

/**
 * Get config values for snippet cache.
 * Uses SETTINGS with reasonable defaults.
 * Note: Empty snippets are NEVER cached to avoid persisting race condition failures.
 */
function getConfig() {
  return {
    // Max entries in IDB cache - can be very large since it's on disk
    maxIdbEntries: SETTINGS.snippetCacheMaxIdbEntries ?? 50000,
    // IDB cache TTL (ms) - very long, snippets rarely change
    idbCacheTtlMs: SETTINGS.snippetCacheIdbTtlMs ?? (90 * 24 * 60 * 60 * 1000), // 90 days
  };
}

// MV3 memory cache pruning removed - experiment has in-memory cache

/**
 * Get a snippet from cache (IDB only - experiment has in-memory cache).
 * Returns { snippet, source } or null if not found.
 * Note: Empty snippets are never cached, so this will only return non-empty snippets.
 *
 * @param {string} uniqueKey - The unique message key
 * @returns {Promise<{snippet: string, source: string}|null>}
 */
export async function getSnippet(uniqueKey) {
  if (!uniqueKey) return null;

  const now = Date.now();
  const config = getConfig();

  // IDB cache lookup (MV3 memory cache removed - experiment has in-memory cache)
  try {
    const idbKey = SNIPPET_PREFIX + uniqueKey;
    const result = await idb.get(idbKey);
    const entry = result?.[idbKey];
    // Only use non-empty snippets (skip any legacy empty entries)
    if (entry && entry.snippet) {
      if ((now - (entry.ts || 0)) < config.idbCacheTtlMs) {
        diagState.idbHits++;
        return { snippet: entry.snippet, source: "idb" };
      }
    }
  } catch (e) {
    // IDB error - continue to fetch
    console.warn("[SnippetCache] IDB get failed:", e);
  }

  diagState.idbMisses++;
  return null;
}

/**
 * Store a snippet in cache (IDB only - experiment has in-memory cache).
 * IMPORTANT: Empty snippets are NEVER cached to avoid persisting race condition failures.
 *
 * @param {string} uniqueKey - The unique message key
 * @param {string} snippet - The snippet text (must be non-empty to be cached)
 * @returns {boolean} - True if snippet was cached, false if skipped (empty)
 */
export async function setSnippet(uniqueKey, snippet) {
  if (!uniqueKey) return false;

  // NEVER cache empty snippets - they may be due to race conditions, network issues,
  // or messages not fully loaded. We'd rather retry than persist a false "empty" state.
  const trimmedSnippet = String(snippet || "").trim();
  if (!trimmedSnippet) {
    return false;
  }

  const now = Date.now();
  const entry = { snippet: trimmedSnippet, ts: now };

  // Store in IDB (MV3 memory cache removed - experiment has in-memory cache)
  try {
    const idbKey = SNIPPET_PREFIX + uniqueKey;
    await idb.set({ [idbKey]: entry }, { kind: "snippet" });
    diagState.idbWrites++;
  } catch (e) {
    console.warn("[SnippetCache] IDB set failed:", e);
  }

  // Periodic diagnostic log
  _maybeLogDiag();
  return true;
}

/**
 * Remove a snippet from cache (both memory and IDB).
 * Call this when a message is deleted.
 *
 * @param {string} uniqueKey - The unique message key
 */
export async function removeSnippet(uniqueKey) {
  if (!uniqueKey) return;

  // Remove from IDB (MV3 memory cache removed - experiment has in-memory cache)
  try {
    const idbKey = SNIPPET_PREFIX + uniqueKey;
    await idb.remove(idbKey);
  } catch (e) {
    console.warn("[SnippetCache] IDB remove failed:", e);
  }
}

/**
 * Update the unique key for a snippet when a message moves.
 * This is more efficient than remove + re-fetch since snippet content doesn't change.
 *
 * @param {string} oldKey - The old unique message key
 * @param {string} newKey - The new unique message key
 */
export async function moveSnippet(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;

  // Move in IDB (MV3 memory cache removed - experiment has in-memory cache)
  try {
    const oldIdbKey = SNIPPET_PREFIX + oldKey;
    const newIdbKey = SNIPPET_PREFIX + newKey;
    const result = await idb.get(oldIdbKey);
    const entry = result?.[oldIdbKey];
    if (entry) {
      await idb.set({ [newIdbKey]: { ...entry, ts: Date.now() } }, { kind: "snippet" });
      await idb.remove(oldIdbKey);
    }
  } catch (e) {
    console.warn("[SnippetCache] IDB move failed:", e);
  }
}

/**
 * Batch get snippets from cache (IDB only - experiment has in-memory cache).
 * Returns a Map of uniqueKey → snippet (only for found non-empty entries).
 * Note: Empty snippets are never cached, so this will only return non-empty snippets.
 *
 * @param {string[]} uniqueKeys - Array of unique message keys
 * @returns {Promise<Map<string, string>>}
 */
export async function getSnippetsBatch(uniqueKeys) {
  const result = new Map();
  if (!uniqueKeys || uniqueKeys.length === 0) return result;

  const now = Date.now();
  const config = getConfig();

  // Batch get from IDB (MV3 memory cache removed - experiment has in-memory cache)
  try {
    const idbKeys = uniqueKeys.map(k => SNIPPET_PREFIX + k);
    const idbResult = await idb.get(idbKeys);
    for (const key of uniqueKeys) {
      const idbKey = SNIPPET_PREFIX + key;
      const entry = idbResult?.[idbKey];
      // Only use non-empty snippets (skip any legacy empty entries)
      if (entry && entry.snippet) {
        if ((now - (entry.ts || 0)) < config.idbCacheTtlMs) {
          diagState.idbHits++;
          result.set(key, entry.snippet);
        }
      } else {
        diagState.idbMisses++;
      }
    }
  } catch (e) {
    console.warn("[SnippetCache] IDB batch get failed:", e);
  }

  return result;
}

/**
 * Purge old entries from IDB cache.
 * Should be called periodically (e.g., on startup or maintenance cycle).
 *
 * @returns {Promise<number>} Number of entries purged
 */
export async function purgeExpiredSnippets() {
  try {
    const config = getConfig();
    const cutoffTs = Date.now() - config.idbCacheTtlMs;
    const removed = await idb.purgeOlderThanByPrefixes([SNIPPET_PREFIX], cutoffTs);
    if (removed > 0) {
      _plog(`Purged ${removed} expired snippet cache entries`);
    }
    return removed;
  } catch (e) {
    console.warn("[SnippetCache] Purge failed:", e);
    return 0;
  }
}

/**
 * Clear all snippet caches (IDB only - experiment manages in-memory cache).
 */
export async function clearAllSnippets() {
  try {
    const allKeys = await idb.getAllKeys();
    const snippetKeys = allKeys.filter(k => k.startsWith(SNIPPET_PREFIX));
    if (snippetKeys.length > 0) {
      await idb.remove(snippetKeys);
      _plog(`Cleared ${snippetKeys.length} snippet cache entries`);
    }
  } catch (e) {
    console.warn("[SnippetCache] Clear failed:", e);
  }
}

/**
 * Get cache statistics for diagnostics.
 * Note: MV3 memory cache removed - experiment has its own in-memory cache.
 */
export function getStats() {
  return {
    // memorySize removed - MV3 memory cache removed
    idbHits: diagState.idbHits,
    idbMisses: diagState.idbMisses,
    idbWrites: diagState.idbWrites,
  };
}

function _maybeLogDiag() {
  const now = Date.now();
  if (
    diagState.logCount < DIAG_CONFIG.maxLogs &&
    (now - diagState.lastLogMs) >= DIAG_CONFIG.minLogIntervalMs
  ) {
    diagState.logCount++;
    diagState.lastLogMs = now;
    _plog("stats", getStats());
  }
}
