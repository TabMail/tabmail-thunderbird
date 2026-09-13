/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical action mutations: commit, project, refresh chips, then delay sorting. */
import * as idb from "./idbStorage.js";
import { getUniqueMessageKey, resolveUniqueMessageKey, log } from "./utils.js";
import { isInboxFolder } from "./folderUtils.js";
import { maxPriorityAction, triggerSortRefresh } from "./tagDefs.js";

const ACTION_PREFIX = "action:";
const ACTION_TS_PREFIX = "action:ts:";
export const payloadKey = key => ACTION_PREFIX + key;
export const tsKey = key => ACTION_TS_PREFIX + key;
export const origKey = key => "action:orig:" + key;
export const userPromptKey = key => "action:userprompt:" + key;
export const justificationKey = key => "action:justification:" + key;
export const METADATA_PREFIXES = [origKey(""), userPromptKey(""), justificationKey("")];
export const allKeysFor = key => [payloadKey(key), tsKey(key), origKey(key), userPromptKey(key), justificationKey(key)];
export const isActionPayloadKey = key => typeof key === "string" && key.startsWith(ACTION_PREFIX)
  && ![ACTION_TS_PREFIX, ...METADATA_PREFIXES].some(prefix => key.startsWith(prefix));
export const ACTIONS = Object.freeze({ REPLY: "reply", ARCHIVE: "archive", DELETE: "delete", NONE: "none" });
const VALID_ACTIONS = new Set(Object.values(ACTIONS));
let _queue = Promise.resolve();
let _epoch = 0;
const _workTokens = new Map();
const _backfilledAccounts = new Set();
let _listeners = null;

function _enqueue(fn) {
  const result = _queue.then(fn);
  _queue = result.catch(() => log("[actionCache] mutation step failed", "debug"));
  return result;
}
export function beginAutomaticWork(key) {
  const token = { key, epoch: _epoch, valid: true };
  if (!_workTokens.has(key)) _workTokens.set(key, new Set());
  _workTokens.get(key).add(token);
  return token;
}
export function finishAutomaticWork(token) {
  if (!token) return;
  token.valid = false;
  const tokens = _workTokens.get(token.key);
  tokens?.delete(token);
  if (tokens?.size === 0) _workTokens.delete(token.key);
}
function _current(key, token) { return !token || token.valid && token.key === key && token.epoch === _epoch; }
function _bump(key) {
  for (const token of _workTokens.get(key) || []) token.valid = false;
  _workTokens.delete(key);
}
async function _resolveUniqueKey(input) {
  if (typeof input === "string") return input.includes(":") ? input : null;
  if (!input) return null;
  try { return await getUniqueMessageKey(input); } catch (_) { return null; }
}
async function _targets(key, header, folderInventory) {
  if (!header) return resolveUniqueMessageKey(key, { all: true, folderInventory });
  const folder = header.folder;
  if (!folder?.id || !header.headerMessageId) return { status: "unknown", weIds: [], folder };
  try {
    let page = await browser.messages.query({ folderId: folder.id, headerMessageId: header.headerMessageId });
    const ids = new Set();
    for (;;) {
      if (!Array.isArray(page?.messages)) throw new Error("invalid page");
      for (const m of page.messages) if (Number.isInteger(m?.id)) ids.add(m.id);
      if (!page.id) break;
      page = await browser.messages.continueList(page.id);
    }
    return { status: ids.size ? "resolved" : "absent", weIds: [...ids], folder };
  } catch (_) { return { status: "unknown", weIds: [], folder }; }
}
async function _project(targets, action) {
  for (const id of targets.weIds) {
    try {
      if (!await browser.tmHdr?.setAction(id, action)) log("[actionCache] native projection incomplete", "debug");
    } catch (_) { log("[actionCache] native projection failed", "debug"); }
  }
}
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


export function setAction(header, action, { token, meta } = {}) {
  if (!header || typeof header !== "object" || !VALID_ACTIONS.has(action)) return Promise.resolve(null);
  return _enqueue(async () => {
    if (!isInboxFolder(header.folder)) return null;
    const key = await _resolveUniqueKey(header);
    if (!key || !_current(key, token)) return null;
    const previous = await idb.get(allKeysFor(key));
    const targets = await _targets(key, header);
    const values = { [payloadKey(key)]: action, [tsKey(key)]: { ts: Date.now() } };
    for (const [name, builder] of [["orig", origKey], ["userprompt", userPromptKey]]) {
      if (meta?.[name] !== undefined && previous[builder(key)] === undefined) values[builder(key)] = meta[name];
    }
    await idb.set(values);
    _bump(key);
    await _project(targets, action);
    await _refreshChips();
    if (previous[payloadKey(key)] !== action) triggerSortRefresh();
    return key;
  });
}
export function touchAction(key) {
  return _enqueue(async () => {
    const previous = await idb.get(payloadKey(key));
    if (previous[payloadKey(key)] !== undefined) await idb.set({ [tsKey(key)]: { ts: Date.now() } });
  });
}
async function _clear(items, { metadata = "ts", token } = {}, { extraKeys = [] } = {}) {
  const records = new Map(), inventory = new Map();
  for (const item of items) {
    const key = item.uniqueKey || await _resolveUniqueKey(item.header);
    if (key && _current(key, token) && !records.has(key)) {
      records.set(key, await _targets(key, item.header, inventory));
    }
  }
  const previous = await idb.get([...records.keys()].map(payloadKey));
  const keys = [...extraKeys];
  for (const key of records.keys()) keys.push(...(metadata === "all" ? allKeysFor(key) : [payloadKey(key), tsKey(key)]));
  if (keys.length) await idb.remove([...new Set(keys)]);
  for (const [key, targets] of records) { _bump(key); await _project(targets, ""); }
  if (records.size) {
    await _refreshChips();
    if (Object.keys(previous).length) triggerSortRefresh();
  }
  return records.size > 0;
}
export function clearActions(items, options) { return _enqueue(() => _clear(items, options)); }
export function clearAction(header) { return clearActions([{ header }]); }
export function clearActionByUniqueKey(uniqueKey) { return clearActions([{ uniqueKey }]); }
export function clearAllActions() {
  return _enqueue(async () => {
    const keys = (await idb.getAllKeys()).filter(k => k.startsWith(ACTION_PREFIX));
    const cleared = await _clear(keys.filter(isActionPayloadKey).map(k => ({ uniqueKey: k.slice(ACTION_PREFIX.length) })),
      { metadata: "all" }, { extraKeys: keys });
    _epoch++;
    _workTokens.clear();
    return cleared;
  });
}
export function wipeAll() {
  return _enqueue(async () => {
    // Privacy cleanup must not depend on message inventory or repaint reads.
    await idb.clear();
    _epoch++;
    _workTokens.clear();
  });
}
export function purgeMetadataOlderThan(cutoffTs) {
  return _enqueue(() => idb.purgeOlderThanByPrefixes(METADATA_PREFIXES, cutoffTs));
}
export function purgeExpired({ cutoffTs }) {
  return _enqueue(async () => {
    const keys = await idb.getAllKeys();
    const candidates = new Set(keys.filter(isActionPayloadKey).map(k => k.slice(ACTION_PREFIX.length)));
    for (const key of keys.filter(k => k.startsWith(ACTION_TS_PREFIX))) candidates.add(key.slice(ACTION_TS_PREFIX.length));
    const timestamps = await idb.get([...candidates].map(tsKey));
    const inventory = new Map(), removals = [];
    for (const key of candidates) {
      const targets = await _targets(key, null, inventory);
      if (targets.status === "unknown") continue;
      const ts = timestamps[tsKey(key)]?.ts;
      if (targets.status === "absent" || !isInboxFolder(targets.folder) || !Number.isFinite(ts) || ts < cutoffTs) removals.push({ uniqueKey: key });
    }
    return _clear(removals);
  });
}
export function applyThreadEffective(weIds) {
  return _enqueue(async () => {
    const members = new Map();
    for (const id of new Set(weIds)) {
      let header;
      try { header = await browser.messages.get(id); } catch (_) { return false; }
      if (!isInboxFolder(header?.folder)) continue;
      const key = await _resolveUniqueKey(header);
      if (!key) return false;
      members.set(key, header);
    }
    if (!members.size) return false;
    const previous = await idb.get([...members.keys()].map(payloadKey));
    const actions = [...members.keys()].map(key => previous[payloadKey(key)]);
    if (actions.some(action => !VALID_ACTIONS.has(action))) return false;
    const action = maxPriorityAction(actions), values = {}, targets = new Map();
    for (const [key, header] of members) {
      if (previous[payloadKey(key)] === action) continue;
      targets.set(key, await _targets(key, header));
      values[payloadKey(key)] = action;
      values[tsKey(key)] = { ts: Date.now() };
    }
    if (!targets.size) return false;
    await idb.set(values);
    for (const [key, target] of targets) { _bump(key); await _project(target, action); }
    await _refreshChips();
    triggerSortRefresh();
    return true;
  });
}

// Inventory is gathered outside the queue; each chunk re-reads canonical state
// inside it so manual mutations can interleave without a stale snapshot replay.
export async function backfillAccount(accountId) {
  let foundInbox = false;
  try {
    const folders = await browser.folders.query({ accountId });
    for (const folder of folders.filter(isInboxFolder)) {
      let page = await browser.messages.list(folder.id);
      for (;;) {
        if (!Array.isArray(page?.messages)) throw new Error("invalid inbox page");
        foundInbox = true;
        for (let i = 0; i < page.messages.length; i += 100) {
          const chunk = page.messages.slice(i, i + 100);
          await _enqueue(async () => {
            const entries = [];
            for (const message of chunk) {
              const key = await _resolveUniqueKey({ ...message, folder });
              if (!key) continue;
              const value = (await idb.get(payloadKey(key)))[payloadKey(key)];
              entries.push({ weMsgId: message.id, action: VALID_ACTIONS.has(value) ? value : "" });
            }
            if (entries.length) {
              try {
                const count = await browser.tmHdr?.setActionsBulk(entries);
                if (count !== entries.length) log("[actionCache] bulk projection incomplete", "debug");
              } catch (_) { log("[actionCache] backfill incomplete", "debug"); }
            }
          });
        }
        if (!page.id) break;
        page = await browser.messages.continueList(page.id);
      }
    }
    if (foundInbox) _backfilledAccounts.add(accountId);
  } catch (_) { log("[actionCache] backfill incomplete", "debug"); }
  return foundInbox;
}
export async function backfillLoadedAccounts({ reason = "startup" } = {}) {
  const accounts = (await browser.accounts.list()).map(a => a.id).filter(id => !_backfilledAccounts.has(id));
  let loaded = false;
  for (const id of accounts) loaded = await backfillAccount(id) || loaded;
  if (loaded) {
    await _enqueue(async () => {
      await _refreshChips();
      if (reason === "startup") await browser.tagSort?.refreshImmediate();
      else triggerSortRefresh();
    });
  }
}
export function pushAllActionsToExperimentsOnStartup() {
  if (!_listeners) {
    const late = () => backfillLoadedAccounts({ reason: "late" }).catch(() => log("[actionCache] late account backfill failed", "debug"));
    browser.accounts.onCreated?.addListener(late);
    browser.folders.onCreated?.addListener(late);
    _listeners = late;
  }
  return backfillLoadedAccounts({ reason: "startup" });
}
export function cleanupActionCache() {
  _epoch++;
  _workTokens.clear();
  if (_listeners) {
    browser.accounts?.onCreated?.removeListener(_listeners);
    browser.folders?.onCreated?.removeListener(_listeners);
    _listeners = null;
  }
}
