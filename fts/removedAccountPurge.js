/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fts/removedAccountPurge.js
// Removes a removed account's rows from the native email index.
//
// Reconciliation never treats an account missing from accounts.list() as
// removed: on a cold start Thunderbird can leave loaded accounts out of that
// list for a long time, so absence is not deletion evidence (ADR-024
// amendment, memory 033). accounts.onDeleted is the one positive signal that
// an account is gone. Its id is recorded durably first, so a removal that
// cannot finish now (helper not connected yet, Thunderbird closing) is
// finished at the next FTS start. An account created again under the same id
// before the purge finished drops the record: its rows are then the live
// account's, and normal reconciliation owns them.
//
// Every native key starts with `${accountId}:` and account ids carry no ":",
// so the account's rows are exactly the half-open key range
// [`${accountId}:`, `${accountId};`) (";" is ":" + 1).

import { SETTINGS } from "../agent/modules/config.js";
import { log } from "../agent/modules/utils.js";
import { acquireFtsExclusiveOperation } from "./operationCoordinator.js";

const PENDING_KEY = "fts_removed_account_purges";
const PURGE_PAGE_KEYS = SETTINGS.ftsRemovedAccountPurge?.pageKeys;

let _ftsSearch = null;
let _chain = Promise.resolve();
const _listenerOwners = new Map();

export function removedAccountKeyRange(accountId) {
  return { startKey: `${accountId}:`, endKey: `${accountId};` };
}

function _validAccountId(accountId) {
  return typeof accountId === "string" && accountId.length > 0 && !accountId.includes(":");
}

async function _readPending() {
  const stored = await browser.storage.local.get(PENDING_KEY);
  const ids = stored?.[PENDING_KEY];
  return Array.isArray(ids) ? ids.filter(_validAccountId) : [];
}

async function _writePending(ids) {
  await browser.storage.local.set({ [PENDING_KEY]: ids });
}

// Serialized: every read-modify-write of the record and every purge run in
// one chain, so a deletion, a re-creation and a purge never interleave.
function _enqueue(task) {
  const next = _chain.catch(() => {}).then(task);
  _chain = next.catch(() => {});
  return next;
}

async function _purgeAccount(ftsSearch, accountId) {
  const { startKey, endKey } = removedAccountKeyRange(accountId);
  let removed = 0;
  let afterKey = null;
  for (;;) {
    const page = await ftsSearch.listMsgIdRange(startKey, endKey, afterKey, PURGE_PAGE_KEYS);
    const msgIds = page?.msgIds || [];
    if (msgIds.length === 0) break;
    await ftsSearch.removeBatch(msgIds);
    removed += msgIds.length;
    if (page.done === true) break;
    afterKey = msgIds[msgIds.length - 1];
  }
  // A row the cursor passed is caught here: the record stays and the next
  // run retries.
  const remaining = await ftsSearch.countMsgIdRange(startKey, endKey);
  if (remaining?.count !== 0) throw new Error("removed_account_purge_verify_failed");
  return removed;
}

// Runs every recorded purge; only called inside the chain. A failed purge
// keeps its record for the next run. Without a ready index the records wait.
async function _runPendingInChain() {
  const ftsSearch = _ftsSearch;
  if (!ftsSearch) return;
  const pending = await _readPending();
  if (pending.length === 0) return;
  const lease = await acquireFtsExclusiveOperation("removed_account_purge");
  try {
    for (const accountId of pending) {
      try {
        const removed = await _purgeAccount(ftsSearch, accountId);
        const now = await _readPending();
        await _writePending(now.filter(id => id !== accountId));
        log(`[TMDBG FTS] Removed account purge: ${removed} row(s) removed for a removed account`);
      } catch (e) {
        log(`[TMDBG FTS] Removed account purge failed, kept for the next FTS start: ${e}`, "warn");
      }
    }
  } finally {
    lease.release();
  }
}

function _onAccountDeleted(accountId) {
  if (!_validAccountId(accountId)) return;
  _enqueue(async () => {
    const pending = await _readPending();
    if (!pending.includes(accountId)) await _writePending([...pending, accountId]);
    await _runPendingInChain();
  }).catch((e) => {
    log(`[TMDBG FTS] Failed to record or purge a removed account: ${e}`, "warn");
  });
}

function _onAccountCreated(accountId) {
  if (!_validAccountId(accountId)) return;
  _enqueue(async () => {
    const pending = await _readPending();
    if (pending.includes(accountId)) await _writePending(pending.filter(id => id !== accountId));
  }).catch((e) => {
    log(`[TMDBG FTS] Failed to update removed account purges: ${e}`, "warn");
  });
}

// Registered from the background entry point before any await, so Gecko
// primes the persistent events and an event-page wake still records it.
export function setupRemovedAccountPurgeListeners() {
  const events = [
    ["accounts.onDeleted", browser.accounts?.onDeleted, _onAccountDeleted],
    ["accounts.onCreated", browser.accounts?.onCreated, _onAccountCreated],
  ];
  for (const [name, event, listener] of events) {
    if (!event || _listenerOwners.has(name)) continue;
    try {
      event.addListener(listener);
      _listenerOwners.set(name, { event, listener });
    } catch (e) {
      log(`[TMDBG FTS] Failed to attach ${name} removed-account purge listener: ${e}`, "warn");
    }
  }
}

// Called once the native index is ready; finishes every recorded purge.
export function initRemovedAccountPurge(ftsSearch) {
  _ftsSearch = ftsSearch;
  return _enqueue(_runPendingInChain);
}

export function _resetRemovedAccountPurgeForTests() {
  for (const { event, listener } of _listenerOwners.values()) {
    try { event.removeListener(listener); } catch (_) {}
  }
  _listenerOwners.clear();
  _ftsSearch = null;
  _chain = Promise.resolve();
}

export function _removedAccountPurgeIdleForTests() {
  return _chain;
}
