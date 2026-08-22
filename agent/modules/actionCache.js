/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
import { getUniqueMessageKey, getUniqueMessageKeyCandidates } from "./utils.js";

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
 * Repaint the action chip on every painter surface (preview-pane header,
 * multi-message-view rows). Fire-and-forget; per-experiment no-op when
 * unavailable. Callers MUST `await _writeActionToHdr(...)` BEFORE invoking
 * this when they're updating the mork prop, otherwise the painter may
 * read the OLD prop value (parent-process IPC race — see
 * tabmail-thunderbird/PLAN_HEADER_CHIP.md §6 "Action-change broadcast race").
 *
 * Both surface refreshes run in parallel (Promise.all) since neither
 * depends on the other.
 */
async function _refreshChips() {
  await Promise.all([
    (async () => {
      try {
        if (browser?.tmMessageHeaderChip?.refreshAll) {
          await browser.tmMessageHeaderChip.refreshAll();
        }
      } catch (_) {}
    })(),
    (async () => {
      try {
        if (browser?.tmMultiMessageChip?.refreshAll) {
          await browser.tmMultiMessageChip.refreshAll();
        }
      } catch (_) {}
    })(),
  ]);
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
    _refreshChips().catch(() => {});

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
  _refreshChips().catch(() => {});
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
    _refreshChips().catch(() => {});
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
 * NOTE: this function does NOT call `_refreshChips()`. Startup runs
 * before any message-display, so there's no chip to refresh on either
 * surface (header chip or multi-message-view chips); the first
 * `messageDisplay.onMessagesDisplayed` event will paint chips with the
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

    // Resolve against the current structured folder inventory. A raw key has
    // no context-free "second colon": both folder paths and valid Message-IDs
    // may contain colons. Ambiguous live prefixes fail closed.
    const accounts = await browser.accounts.list();
    const liveFolders = [];
    for (const acc of accounts) {
      try {
        if (!acc?.rootFolder) continue;
        const subFolders = await browser.folders.getSubFolders(acc.rootFolder.id, true);
        for (const folder of [acc.rootFolder, ...subFolders]) {
          if (folder?.id && folder?.path) {
            liveFolders.push({ ...folder, accountId: folder.accountId || acc.id });
          }
        }
      } catch (_) {}
    }

    const normalizeMid = (v) => String(v || "").replace(/[<>]/g, "").trim();
    const records = [];
    const refsByFolder = new Map(); // MailFolder.id -> Map<normalized Message-ID, refs[]>
    for (const cacheKey of actionKeys) {
      const action = kv[cacheKey];
      if (!action) continue;
      const uniqueKey = cacheKey.slice(ACTION_PREFIX.length);
      const candidates = getUniqueMessageKeyCandidates(uniqueKey, liveFolders);
      if (candidates.length === 0) continue;
      const record = { action, matches: new Map(), uncertain: false };
      records.push(record);
      for (const candidate of candidates) {
        const mid = normalizeMid(candidate.headerID);
        if (!mid) continue;
        let byMid = refsByFolder.get(candidate.weFolder.id);
        if (!byMid) { byMid = new Map(); refsByFolder.set(candidate.weFolder.id, byMid); }
        let refs = byMid.get(mid);
        if (!refs) { refs = []; byMid.set(mid, refs); }
        refs.push({ record, folderId: candidate.weFolder.id });
      }
    }
    if (refsByFolder.size === 0) return;

    // Validate all structural candidates against actual live messages while
    // scanning each affected folder only once. Structural prefix overlap is
    // not ambiguity; two matched candidate folders are. Multiple matching
    // rows inside one folder retain the base backfill behavior.
    const folderFetches = [];
    for (const [folderId, refsByMid] of refsByFolder) {
      folderFetches.push((async () => {
        try {
          let page = await browser.messages.list(folderId);
          const continuationIds = new Set();
          while (page) {
            if (!Array.isArray(page.messages)) throw new Error("action_cache_folder_page_invalid");
            for (const m of page.messages) {
              const mid = normalizeMid(m?.headerMessageId);
              if (!mid) continue;
              const refs = refsByMid.get(mid);
              if (!refs || !m?.id) continue;
              for (const ref of refs) {
                let messageIds = ref.record.matches.get(ref.folderId);
                if (!messageIds) {
                  messageIds = new Set();
                  ref.record.matches.set(ref.folderId, messageIds);
                }
                messageIds.add(m.id);
              }
            }
            if (!page.id) break;
            if (continuationIds.has(page.id)
                || typeof browser.messages.continueList !== "function") {
              throw new Error("action_cache_folder_continuation_invalid");
            }
            continuationIds.add(page.id);
            page = await browser.messages.continueList(page.id);
          }
        } catch (_) {
          for (const refs of refsByMid.values()) {
            for (const ref of refs) ref.record.uncertain = true;
          }
        }
      })());
    }
    await Promise.all(folderFetches);
    const allEntries = [];
    for (const record of records) {
      if (record.uncertain || record.matches.size !== 1) continue;
      for (const weMsgId of record.matches.values().next().value) {
        allEntries.push({ weMsgId, action: record.action });
      }
    }
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
