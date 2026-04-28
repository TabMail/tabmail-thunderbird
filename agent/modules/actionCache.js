/**
 * actionCache.js — Canonical source of truth for per-message AI action state.
 *
 * Action state lives in IDB under `action:<uniqueKey>` (with metadata under
 * `action:ts:<uniqueKey>`). Every read/write on the "what action does this
 * message have" question funnels through this module.
 *
 * Phase 2b: on every write, dual-write IDB + local mork hdr property
 * ("tm-action"). Painter + sort read the hdr property synchronously — no
 * in-memory map, no cross-process push, no cold-start delay. IDB stays
 * canonical for cross-device sync (Device Sync reads/writes it); the hdr
 * property is the fast local render cache.
 */

import * as idb from "./idbStorage.js";
import { getUniqueMessageKey } from "./utils.js";

const ACTION_PREFIX = "action:";
const ACTION_TS_PREFIX = "action:ts:";

/**
 * Write the action to the message's native hdr as a local mork string
 * property via the `tmHdr` experiment. The property is LOCAL — IMAP sync
 * only rewrites the "keywords" property, so "tm-action" survives IMAP
 * FETCH/IDLE. Painter + sort read this synchronously on each row render.
 * Fire-and-forget; a failure (hdr gone, API not ready) is harmless because
 * IDB remains the canonical cross-device cache.
 */
async function _writeActionToHdr(weMsgId, action) {
  if (!Number.isInteger(weMsgId) || weMsgId <= 0) return;
  try {
    if (browser?.tmHdr?.setAction) {
      await browser.tmHdr.setAction(weMsgId, action || undefined);
    }
  } catch (_) {}
}

/**
 * Repaint the message-header action chip on every preview pane / standalone
 * message-display window. Fire-and-forget; no-op when the experiment is
 * unavailable. Callers MUST `await _writeActionToHdr(...)` BEFORE invoking
 * this when they're updating the mork prop, otherwise the painter may
 * read the OLD prop value (parent-process IPC race — see
 * tabmail-thunderbird/PLAN_HEADER_CHIP.md §6 "Action-change broadcast race").
 */
async function _refreshHeaderChip() {
  try {
    if (browser?.tmMessageHeaderChip?.refreshAll) {
      await browser.tmMessageHeaderChip.refreshAll();
    }
  } catch (_) {}
}

/**
 * Display enum for the four AI actions. Plain names (no `tm_` prefix) —
 * the transport-layer `tm_*` naming exists only at IMAP/Gmail boundaries.
 */
export const ACTIONS = Object.freeze({
  REPLY: "reply",
  ARCHIVE: "archive",
  DELETE: "delete",
  NONE: "none",
});

const VALID_ACTIONS = new Set(Object.values(ACTIONS));

function _isValidAction(action) {
  return typeof action === "string" && VALID_ACTIONS.has(action);
}

/**
 * Resolve the input (WE message id, header object, or uniqueKey string) to a
 * uniqueKey. Callers may pass any of these; we normalize here.
 */
async function _resolveUniqueKey(input) {
  if (!input && input !== 0) return null;
  if (typeof input === "string") {
    // Treat as already-a-uniqueKey if it has the three-segment shape.
    return input.includes(":") ? input : null;
  }
  try {
    return await getUniqueMessageKey(input);
  } catch (_) {
    return null;
  }
}

/**
 * Extract a WE message id from any of the accepted inputs. Returns null if
 * the input is a uniqueKey string (no weId available without a lookup).
 */
function _resolveWeMsgId(input) {
  if (typeof input === "number") return input;
  if (input && typeof input === "object" && Number.isInteger(input.id)) return input.id;
  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Get the cached action for a message. Returns null if no cache.
 * @param {number|object} headerOrWeId - WE message id or header object.
 * @returns {Promise<string|null>} action name or null
 */
export async function getActionForWeId(headerOrWeId) {
  const key = await _resolveUniqueKey(headerOrWeId);
  return getActionForUniqueKey(key);
}

/**
 * Get the cached action for a uniqueKey directly.
 * @param {string|null} uniqueKey
 * @returns {Promise<string|null>}
 */
export async function getActionForUniqueKey(uniqueKey) {
  if (!uniqueKey) return null;
  try {
    const cacheKey = ACTION_PREFIX + uniqueKey;
    const kv = await idb.get(cacheKey);
    const v = kv?.[cacheKey] || null;
    return v ? String(v) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Bulk read actions for a list of uniqueKeys. Returns a map of key -> action
 * (keys with no cache entry are omitted from the result).
 * @param {string[]} uniqueKeys
 * @returns {Promise<Record<string,string>>}
 */
export async function getActionsForUniqueKeys(uniqueKeys) {
  try {
    const keys = Array.isArray(uniqueKeys) ? uniqueKeys.filter(Boolean) : [];
    if (keys.length === 0) return {};
    const cacheKeys = keys.map((k) => ACTION_PREFIX + k);
    const kv = await idb.get(cacheKeys);
    const out = {};
    for (const k of keys) {
      const v = kv?.[ACTION_PREFIX + k];
      if (v) out[k] = String(v);
    }
    return out;
  } catch (_) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Write an action for a message to the IDB cache.
 * @param {number|object|string} headerOrWeIdOrUniqueKey
 * @param {string} action - one of ACTIONS values
 * @returns {Promise<string|null>} the uniqueKey written, or null on failure
 */
export async function setAction(headerOrWeIdOrUniqueKey, action) {
  if (!_isValidAction(action)) return null;
  const uniqueKey = await _resolveUniqueKey(headerOrWeIdOrUniqueKey);
  if (!uniqueKey) return null;
  try {
    const cacheKey = ACTION_PREFIX + uniqueKey;
    const metaKey = ACTION_TS_PREFIX + uniqueKey;
    await idb.set({ [cacheKey]: action, [metaKey]: { ts: Date.now() } });

    // Push to view experiments so paint+sort stay in sync with IDB.
    const weMsgId = _resolveWeMsgId(headerOrWeIdOrUniqueKey);
    if (weMsgId) {
      // Sequential: prop write must complete before chip refresh reads from it.
      await _writeActionToHdr(weMsgId, action).catch(() => {});
    }
    _refreshHeaderChip().catch(() => {});

    return uniqueKey;
  } catch (_) {
    return null;
  }
}

/**
 * Clear the cached action for a message. No-op if no cache entry.
 * @param {number|object|string} headerOrWeIdOrUniqueKey
 * @returns {Promise<boolean>} true if removal attempted
 */
export async function clearAction(headerOrWeIdOrUniqueKey) {
  const uniqueKey = await _resolveUniqueKey(headerOrWeIdOrUniqueKey);
  if (!uniqueKey) return false;
  const ok = await clearActionByUniqueKey(uniqueKey);
  const weMsgId = _resolveWeMsgId(headerOrWeIdOrUniqueKey);
  if (weMsgId) {
    // Sequential: prop write must complete before chip refresh reads from it.
    await _writeActionToHdr(weMsgId, null).catch(() => {});
  }
  _refreshHeaderChip().catch(() => {});
  return ok;
}

/**
 * Clear the cached action by uniqueKey directly. Useful when the caller has
 * the key but the header is already gone (e.g. post-move).
 * @param {string} uniqueKey
 * @returns {Promise<boolean>}
 */
export async function clearActionByUniqueKey(uniqueKey) {
  if (!uniqueKey) return false;
  try {
    await idb.remove([ACTION_PREFIX + uniqueKey, ACTION_TS_PREFIX + uniqueKey]);
    // Symmetric coverage only — this site has no weMsgId so it cannot
    // clear the mork prop. For onMoved.js's post-move case, the chip
    // actually clears via onMessagesDisplayed firing on the new-folder
    // hdr (which has no mork prop). See PLAN_HEADER_CHIP.md §4.7 site #3.
    _refreshHeaderChip().catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Startup push — populate experiment action maps from IDB
// ---------------------------------------------------------------------------

const _BULK_PUSH_BATCH_SIZE = 100;

/**
 * One-time startup backfill: ensure every IDB `action:*` entry is also
 * present as a mork `tm-action` property on its message header. After
 * this runs once, all new classifications dual-write (IDB + hdr) so the
 * painter always finds the property synchronously on render.
 *
 * Strategy: one `browser.messages.list(folderId)` per affected folder, in
 * parallel across folders. For each listed message, look up the matching
 * action by `headerMessageId` in the pre-built map and write via
 * `browser.tmHdr.setActionsBulk` in batches.
 *
 * Fire-and-forget — callers should not await.
 *
 * NOTE: this function does NOT call `_refreshHeaderChip()`. Startup runs
 * before any message-display, so there's no chip to refresh; the first
 * `messageDisplay.onMessagesDisplayed` event will paint the chip with the
 * just-written mork prop. See PLAN_HEADER_CHIP.md §4.7.
 */
export async function pushAllActionsToExperimentsOnStartup() {
  const t0 = Date.now();
  try {
    const allKeys = await idb.getAllKeys();
    const actionKeys = allKeys.filter(
      (k) => k.startsWith(ACTION_PREFIX) && !k.startsWith(ACTION_TS_PREFIX),
    );
    if (actionKeys.length === 0) return;

    const kv = await idb.get(actionKeys);

    // Group IDB entries by (accountId, folderPath).
    const byFolder = new Map(); // "accountId|folderPath" -> Map<headerMessageId, action>
    for (const cacheKey of actionKeys) {
      const action = kv[cacheKey];
      if (!action) continue;
      const uniqueKey = cacheKey.slice(ACTION_PREFIX.length);
      const colonIdx1 = uniqueKey.indexOf(":");
      if (colonIdx1 <= 0) continue;
      const colonIdx2 = uniqueKey.indexOf(":", colonIdx1 + 1);
      if (colonIdx2 <= 0) continue;
      const accountId = uniqueKey.slice(0, colonIdx1);
      const folderPath = uniqueKey.slice(colonIdx1 + 1, colonIdx2);
      const headerMessageId = uniqueKey.slice(colonIdx2 + 1);
      if (!accountId || !folderPath || !headerMessageId) continue;
      const groupKey = accountId + "|" + folderPath;
      let sub = byFolder.get(groupKey);
      if (!sub) { sub = new Map(); byFolder.set(groupKey, sub); }
      sub.set(headerMessageId, action);
    }
    if (byFolder.size === 0) return;

    // Resolve folderPath → folderId for each affected folder.
    const accounts = await browser.accounts.list();
    const folderIdByKey = new Map();
    for (const acc of accounts) {
      try {
        if (!acc?.rootFolder) continue;
        const subFolders = await browser.folders.getSubFolders(acc.rootFolder.id, true);
        for (const f of [acc.rootFolder, ...subFolders]) {
          if (f?.id && f?.path) folderIdByKey.set(acc.id + "|" + f.path, f.id);
        }
      } catch (_) {}
    }

    // One `messages.list` per folder, in parallel. Match headerMessageIds
    // locally instead of issuing a per-message query.
    const normalizeMid = (v) => String(v || "").replace(/[<>]/g, "").trim();
    const folderFetches = [];
    for (const [groupKey, midMap] of byFolder) {
      const folderId = folderIdByKey.get(groupKey);
      if (!folderId) continue;
      folderFetches.push((async () => {
        const entries = [];
        try {
          let page = await browser.messages.list(folderId);
          while (page && Array.isArray(page.messages) && page.messages.length > 0) {
            for (const m of page.messages) {
              const mid = normalizeMid(m?.headerMessageId);
              if (!mid) continue;
              const action = midMap.get(mid);
              if (action && m?.id) entries.push({ weMsgId: m.id, action });
            }
            if (page.id) page = await browser.messages.continueList(page.id);
            else break;
          }
        } catch (_) {}
        return entries;
      })());
    }
    const allEntries = (await Promise.all(folderFetches)).flat();
    if (allEntries.length === 0) return;

    // Backfill hdr properties in batches.
    if (!browser?.tmHdr?.setActionsBulk) return;
    let written = 0;
    for (let i = 0; i < allEntries.length; i += _BULK_PUSH_BATCH_SIZE) {
      const chunk = allEntries.slice(i, i + _BULK_PUSH_BATCH_SIZE);
      try {
        const n = await browser.tmHdr.setActionsBulk(chunk);
        if (Number.isFinite(n)) written += n;
      } catch (_) {}
    }
    try {
      const dt = Date.now() - t0;
      console.log(`[actionCache] hdr backfill: ${written}/${allEntries.length} entries in ${dt}ms`);
    } catch (_) {}
  } catch (e) {
    try { console.log("[actionCache] pushAllActionsToExperimentsOnStartup failed:", e); } catch (_) {}
  }
}
