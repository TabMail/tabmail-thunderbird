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
// finished at the next FTS start. The rows are removed at once; the record
// is dropped only when a later background-page start finds the range empty.
// Thunderbird never reuses an account id
// (its account key counter only grows).
//
// Every native key starts with `${accountId}:` and account ids carry no ":",
// so the account's rows are exactly the half-open key range
// [`${accountId}:`, `${accountId};`) (";" is ":" + 1).

import { SETTINGS } from "../agent/modules/config.js";
import { log } from "../agent/modules/utils.js";
import { acquireFtsExclusiveOperation } from "./operationCoordinator.js";

const PENDING_KEY = "fts_removed_account_purges";
const PURGE_PAGE_KEYS = SETTINGS.ftsRemovedAccountPurge.pageKeys;

let _ftsSearch = null;
let _recordChain = Promise.resolve();
let _purgeChain = Promise.resolve();
// Accounts removed while this background page lives: their records are kept
// until a later page start (see _runPurges).
const _removedThisPage = new Set();
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

// Every read-modify-write of the record runs on this short chain, never
// behind a purge, so a removal is stored at once even while a purge waits
// for the exclusive lease.
function _enqueueRecord(task) {
  const next = _recordChain.catch(() => {}).then(task);
  _recordChain = next.catch(() => {});
  return next;
}

// Purges run one at a time on their own chain.
function _enqueuePurge(task) {
  const next = _purgeChain.catch(() => {}).then(task);
  _purgeChain = next.catch(() => {});
  return next;
}

async function _purgeAccount(ftsSearch, accountId) {
  const { startKey, endKey } = removedAccountKeyRange(accountId);
  let afterKey = null;
  for (;;) {
    const page = await ftsSearch.listMsgIdRange(startKey, endKey, afterKey, PURGE_PAGE_KEYS);
    const msgIds = page?.msgIds || [];
    if (msgIds.length === 0) break;
    await ftsSearch.removeBatch(msgIds);
    if (page.done === true) break;
    afterKey = msgIds[msgIds.length - 1];
  }
  // A row the cursor passed is caught here: the record stays and the next
  // run retries.
  const remaining = await ftsSearch.countMsgIdRange(startKey, endKey);
  if (remaining?.count !== 0) throw new Error("removed_account_purge_verify_failed");
}

// Purges every recorded account. A verified record is dropped only for an
// account removed before this background page started: while the page that
// saw the removal lives, the incremental indexer can still write a batch of
// the account it read before the removal, and the lease does not stop it. A
// later page start has no such writer, since the indexer queue is not
// persisted and the account no longer exists. A failed purge keeps its
// record. Without a ready index the records wait.
async function _runPurges() {
  const ftsSearch = _ftsSearch;
  if (!ftsSearch) return;
  if ((await _readPending()).length === 0) return;
  const lease = await acquireFtsExclusiveOperation("removed_account_purge");
  try {
    // Re-read after the lease wait: removals stored meanwhile are included.
    for (const accountId of await _readPending()) {
      try {
        await _purgeAccount(ftsSearch, accountId);
        if (!_removedThisPage.has(accountId)) {
          await _enqueueRecord(async () => {
            await _writePending((await _readPending()).filter(id => id !== accountId));
          });
        }
        log("[TMDBG FTS] Removed account purge: rows of a removed account removed");
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
  _removedThisPage.add(accountId);
  _enqueueRecord(async () => {
    const pending = await _readPending();
    if (!pending.includes(accountId)) await _writePending([...pending, accountId]);
  }).then(() => _enqueuePurge(_runPurges)).catch((e) => {
    log(`[TMDBG FTS] Failed to record or purge a removed account: ${e}`, "warn");
  });
}

// Registered from the background entry point before any await, so Gecko
// primes the persistent events and an event-page wake still records it.
export function setupRemovedAccountPurgeListeners() {
  const event = browser.accounts?.onDeleted;
  if (!event || _listenerOwners.has(event)) return;
  try {
    event.addListener(_onAccountDeleted);
    _listenerOwners.set(event, _onAccountDeleted);
  } catch (e) {
    log(`[TMDBG FTS] Failed to attach the removed-account purge listener: ${e}`, "warn");
  }
}

// Called once the native index is ready; finishes every recorded purge.
export function initRemovedAccountPurge(ftsSearch) {
  _ftsSearch = ftsSearch;
  return _enqueuePurge(_runPurges);
}

export function _resetRemovedAccountPurgeForTests() {
  for (const [event, listener] of _listenerOwners) {
    try { event.removeListener(listener); } catch (_) {}
  }
  _listenerOwners.clear();
  _ftsSearch = null;
  _recordChain = Promise.resolve();
  _purgeChain = Promise.resolve();
  _removedThisPage.clear();
}

export async function _removedAccountPurgeIdleForTests() {
  await _recordChain;
  await _purgeChain;
  await _recordChain;
}
