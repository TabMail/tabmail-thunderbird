// Simple IndexedDB wrapper for TabMail – MV3 compliant.
// Provides a drop-in subset of browser.storage.local API plus version helpers.
// Database layout:
//   DB: "tabmailCache"  (version 1)
//   ObjectStore: "kv" with primary key `key` (string)
//   Indexes: `version` (string), `kind` (string)
// All objects written via `set` will be stored in the form:
// { key, value, version, kind, ts }
// where `value` is the caller-supplied payload.

/* eslint-disable no-console */

const DB_NAME = "tabmailCache";
const DB_VERSION = 1;
const STORE_NAME = "kv";

// In-memory cache of all keys for efficient iteration during purge operations
let keyCache = null;
let keyCacheInitialized = false;

// Lazily open database – reuse the same connection for the lifetime of the worker.
const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);

  req.onupgradeneeded = (ev) => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
      store.createIndex("version", "version", { unique: false });
      store.createIndex("kind", "kind", { unique: false });
    }
  };

  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function log(...args) {
  // Logging guard – set globalThis.LOG_IDB = true at runtime to enable.
  if (globalThis.LOG_IDB) {
    // console.log("[TMDBG idb]", ...args);
  }
}

function manifestVersion() {
  try {
    return browser?.runtime?.getManifest()?.version ?? "0";
  } catch {
    return "0";
  }
}

async function withStore(mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const res = fn(store, tx);
    tx.oncomplete = () => resolve(res);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Initialize the key cache by reading all keys from IndexedDB
 */
async function initializeKeyCache() {
  if (keyCacheInitialized) return;
  
  keyCache = new Set();
  await withStore("readonly", (store) => {
    const req = store.openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        keyCache.add(cursor.key);
        cursor.continue();
      }
    };
  });
  keyCacheInitialized = true;
  log("Key cache initialized with", keyCache.size, "keys");
}

/**
 * Get all keys efficiently using the in-memory cache
 */
export async function getAllKeys() {
  await initializeKeyCache();
  return Array.from(keyCache);
}

// ---------------------------------------------------------------------------
// API – get / set / remove / clear / getAll
// ---------------------------------------------------------------------------

/**
 * Get value(s) for a key, array of keys, or null (everything).
 * Returns an object mapping keys to stored `value` (mirrors storage.local).
 */
export async function get(keys) {
  if (keys === null) {
    // Initialize key cache on first getAll() call
    await initializeKeyCache();
    return getAll();
  }

  let defaults = null;
  if (typeof keys === "object" && !Array.isArray(keys)) {
    defaults = keys;
    keys = Object.keys(keys);
  }

  const keyArr = Array.isArray(keys) ? keys : [keys];
  const out = {};
  await withStore("readonly", (store) => {
    keyArr.forEach((k) => {
      const req = store.get(k);
      req.onsuccess = () => {
        if (req.result) out[k] = req.result.value;
      };
    });
  });

  // Apply default values for keys not found
  if (defaults) {
    for (const [k, defVal] of Object.entries(defaults)) {
      if (!(k in out)) out[k] = defVal;
    }
  }

  // log("get", keyArr, "->", Object.keys(out).length, "hits");
  return out;
}

/**
 * Set multiple key/value pairs.
 * obj: { key1: value1, key2: value2 }
 * opts.kind – optional semantic tag.
 */
export async function set(obj, opts = {}) {
  const version = manifestVersion();
  const kind = opts.kind ?? "generic";
  const ts = Date.now();
  await withStore("readwrite", (store) => {
    for (const [key, value] of Object.entries(obj)) {
      store.put({ key, value, version, kind, ts });
    }
  });
  
  // Update key cache
  if (keyCacheInitialized) {
    for (const key of Object.keys(obj)) {
      keyCache.add(key);
    }
  }
  
  // log("set", Object.keys(obj));
}

/** Remove one key or an array of keys */
export async function remove(keys) {
  const keyArr = Array.isArray(keys) ? keys : [keys];
  await withStore("readwrite", (store) => {
    keyArr.forEach((k) => store.delete(k));
  });
  
  // Update key cache
  if (keyCacheInitialized) {
    for (const key of keyArr) {
      keyCache.delete(key);
    }
  }
  
  // log("remove", keyArr);
}

/** Clear the whole objectStore */
export async function clear() {
  await withStore("readwrite", (store) => store.clear());
  
  // Reset key cache
  if (keyCacheInitialized) {
    keyCache.clear();
  }
  
  // log("clear all");
}

/** Return all key/value pairs */
export async function getAll() {
  const out = {};
  await withStore("readonly", (store) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out[cursor.key] = cursor.value.value;
        cursor.continue();
      }
    };
  });
  // log("getAll ->", Object.keys(out).length, "items");
  return out;
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** Remove entries whose stored version is < minVersion (semver compare – naive) */
export async function invalidateOlderThan(minVersion) {
  const toDelete = [];
  await withStore("readonly", (store) => {
    const idx = store.index("version");
    const req = idx.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      const ver = cur.value.version || "0";
      if (ver < minVersion) toDelete.push(cur.key);
      cur.continue();
    };
  });
  if (toDelete.length) await remove(toDelete);
  // log("invalidateOlderThan", minVersion, "removed", toDelete.length);
}

// ---------------------------------------------------------------------------
// Storage estimate helper (for popup)
// ---------------------------------------------------------------------------

export async function estimateUsage() {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch (e) {
    // console.error("[TMDBG idb] estimateUsage failed", e);
    return { usage: 0, quota: 0 };
  }
}

// ---------------------------------------------------------------------------
// Debug helper to dump n keys (dev only)
// ---------------------------------------------------------------------------
export async function dumpKeys(limit = 20) {
  const keys = [];
  await withStore("readonly", (store) => {
    const req = store.openKeyCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      keys.push(c.key);
      if (keys.length < limit) c.continue();
    };
  });
  // console.log("[TMDBG idb] first", keys.length, "keys", keys);
  return keys;
}

// ---------------------------------------------------------------------------
// Maintenance helpers
// ---------------------------------------------------------------------------

/**
 * Touch one key or an array of keys by updating the stored record `ts` field,
 * without modifying the `value`. No-op for missing keys.
 *
 * This is used to keep long-lived caches from being purged when they are still
 * actively used but don't update separate meta keys.
 *
 * @param {string|string[]} keys
 * @returns {Promise<number>} number of keys successfully touched
 */
export async function touch(keys) {
  try {
    const keyArr = Array.isArray(keys) ? keys : [keys];
    const now = Date.now();
    let touched = 0;
    await withStore("readwrite", (store) => {
      keyArr.forEach((k) => {
        try {
          const req = store.get(k);
          req.onsuccess = () => {
            try {
              const rec = req.result;
              if (!rec) return;
              // Preserve all existing fields; only bump ts.
              store.put({ ...rec, ts: now });
              touched++;
            } catch (_) {}
          };
        } catch (_) {}
      });
    });
    return touched;
  } catch (_) {
    return 0;
  }
}

/**
 * Purge entries whose key starts with any of the given prefixes AND whose stored record ts
 * is older than cutoffTs.
 *
 * Note: record ts is set on write via `set()` and updated via `touch()` above.
 *
 * @param {string[]} prefixes
 * @param {number} cutoffTs - milliseconds since epoch
 * @returns {Promise<number>} number of entries removed
 */
export async function purgeOlderThanByPrefixes(prefixes, cutoffTs) {
  try {
    const list = Array.isArray(prefixes) ? prefixes.filter(Boolean).map(String) : [];
    if (list.length === 0) return 0;
    const cutoff = Number(cutoffTs || 0);
    if (!Number.isFinite(cutoff) || cutoff <= 0) return 0;

    const toDelete = [];
    await withStore("readonly", (store) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const k = String(cursor.key || "");
        for (const p of list) {
          if (k.startsWith(p)) {
            const ts = Number(cursor.value?.ts || 0);
            if (!Number.isFinite(ts) || ts < cutoff) {
              toDelete.push(k);
            }
            break;
          }
        }
        cursor.continue();
      };
    });

    if (toDelete.length > 0) {
      await remove(toDelete);
    }
    return toDelete.length;
  } catch (_) {
    return 0;
  }
}
