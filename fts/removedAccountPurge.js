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
// finished at the next FTS start; the record is dropped once the range is
// verified empty.
// Thunderbird does not reuse an account id while its account key counter
// pref exists (it only grows).
//
// Removals the add-on never saw (Thunderbird closed, the add-on not running,
// an account Thunderbird drops itself while loading) send no onDeleted. They
// are found from Thunderbird's own preferences, never from accounts.list():
// removing an account drops its key from mail.accountmanager.accounts and
// clears every preference under mail.account.<id>., and preferences are read
// from disk before any add-on starts, so unlike the loaded-account list they
// cannot be partial. Any doubt refuses the whole check (see
// _findUnwitnessedRemovals).
//
// Every native key starts with `${accountId}:` and account ids carry no ":",
// so the account's rows are exactly the half-open key range
// [`${accountId}:`, `${accountId};`) (";" is ":" + 1).

import { SETTINGS } from "../agent/modules/config.js";
import { log } from "../agent/modules/utils.js";
import { acquireFtsExclusiveOperation } from "./operationCoordinator.js";

const PENDING_KEY = "fts_removed_account_purges";
// Above every key the index can hold for an account (account ids are ASCII).
const KEYSPACE_END = "\uFFFF";
// The ids Thunderbird gives accounts; anything else is never treated as gone.
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

let _ftsSearch = null;
let _recordChain = Promise.resolve();
let _purgeChain = Promise.resolve();
// Accounts removed while this background page lives. The engine's indexBatch
// refuses their rows inside the membership mutex (isRemovedAccountKey), so a
// batch the incremental indexer read before the removal cannot land after
// the purge. A page restart ends every such writer.
const _removedAccounts = new Set();
// Removed accounts whose record write failed: still purged, and recording is
// retried by every later run.
const _unrecorded = new Set();
const _listenerOwners = new Map();

export function removedAccountKeyRange(accountId) {
  return { startKey: `${accountId}:`, endKey: `${accountId};` };
}

export function isRemovedAccountKey(msgId) {
  if (_removedAccounts.size === 0 || typeof msgId !== "string") return false;
  const accountEnd = msgId.indexOf(":");
  return accountEnd > 0 && _removedAccounts.has(msgId.slice(0, accountEnd));
}

function _validAccountId(accountId) {
  return typeof accountId === "string" && accountId.length > 0 && !accountId.includes(":");
}

async function _readPending() {
  const stored = await browser.storage.local.get(PENDING_KEY);
  const ids = stored?.[PENDING_KEY];
  return Array.isArray(ids) ? ids.filter(_validAccountId) : [];
}

// The durable records, or [] when storage cannot be read now: an id this page
// saw removed (_unrecorded) is purged regardless, and the records are read
// again by the next run.
async function _readPendingForPurge() {
  try {
    return await _readPending();
  } catch (e) {
    log(`[TMDBG FTS] Reading removed account purge records failed: ${e}`, "warn");
    return [];
  }
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
  // Read here, not at module load: a bad config fails this purge (kept for
  // the next start), never the background page that imports the module.
  const pageKeys = SETTINGS.agentQueues.ftsRemovedAccountPurge.pageKeys;
  let afterKey = null;
  for (;;) {
    const page = await ftsSearch.listMsgIdRange(startKey, endKey, afterKey, pageKeys);
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

function _record(accountId) {
  return _enqueueRecord(async () => {
    const pending = await _readPending();
    if (!pending.includes(accountId)) await _writePending([...pending, accountId]);
    _unrecorded.delete(accountId);
  });
}

// Purges every recorded or unrecorded removed account and drops each record
// once its range is verified empty. A failed purge keeps its record. Without
// a ready index the work waits for initRemovedAccountPurge.
async function _runPurges() {
  const ftsSearch = _ftsSearch;
  if (!ftsSearch) return;
  for (const accountId of [..._unrecorded]) {
    try {
      await _record(accountId);
    } catch (e) {
      log(`[TMDBG FTS] Recording a removed account failed again, purging it anyway: ${e}`, "warn");
    }
  }
  if ((await _readPendingForPurge()).length === 0 && _unrecorded.size === 0) return;
  const lease = await acquireFtsExclusiveOperation("removed_account_purge");
  try {
    // An empty removal is acknowledged only after every write already in
    // the helper's writer queue, including one whose RPC timed out here, so
    // the range is listed after them; later writes see the removal and are
    // refused. If it fails, nothing is verified and every record stays.
    await ftsSearch.removeBatch([]);
    // Re-read after the lease wait: removals stored meanwhile are included.
    const accountIds = new Set([...(await _readPendingForPurge()), ..._unrecorded]);
    for (const accountId of accountIds) {
      try {
        await _purgeAccount(ftsSearch, accountId);
        await _enqueueRecord(async () => {
          await _writePending((await _readPending()).filter(id => id !== accountId));
        });
        _unrecorded.delete(accountId);
        log("[TMDBG FTS] Removed account purge: rows of a removed account removed");
      } catch (e) {
        log(`[TMDBG FTS] Removed account purge failed, kept for the next run: ${e}`, "warn");
      }
    }
  } finally {
    lease.release();
  }
}

// The distinct account ids that own rows in the index: one key per account,
// then a jump past that account's whole range.
async function _indexedAccountIds(ftsSearch) {
  const ids = [];
  let startKey = "";
  let afterKey = null;
  for (;;) {
    const page = await ftsSearch.listMsgIdRange(startKey, KEYSPACE_END, afterKey, 1);
    const key = page?.msgIds?.[0];
    if (typeof key !== "string") return ids;
    const accountEnd = key.indexOf(":");
    if (accountEnd <= 0) {
      afterKey = key;
      continue;
    }
    const accountId = key.slice(0, accountEnd);
    ids.push(accountId);
    startKey = removedAccountKeyRange(accountId).endKey;
    afterKey = null;
  }
}

// Accounts with rows in the index that Thunderbird's preferences show as
// removed. Throws (removing nothing) when the evidence cannot be trusted.
async function _findUnwitnessedRemovals(ftsSearch) {
  const indexed = (await _indexedAccountIds(ftsSearch)).filter(id => ACCOUNT_ID_PATTERN.test(id));
  if (indexed.length === 0) return [];
  // Used only to refuse: every account Thunderbird has loaded must show in
  // the preferences, or this check is not reading what Thunderbird uses.
  const loadedIds = (await browser.accounts.list(false)).map(account => account?.id);
  if (!loadedIds.every(id => typeof id === "string" && ACCOUNT_ID_PATTERN.test(id))) {
    throw new Error("unwitnessed_removal_refused: loaded account id unreadable");
  }
  const askIds = [...new Set([...indexed, ...loadedIds])];
  const state = await browser.tmPrefs.getAccountPrefPresence(askIds);
  const listed = new Set(
    (typeof state?.accountList === "string" ? state.accountList : "")
      .split(",").map(id => id.trim()).filter(Boolean),
  );
  if (listed.size === 0) throw new Error("unwitnessed_removal_refused: account list empty");
  for (const id of loadedIds) {
    if (!listed.has(id) || state.accounts?.[id] !== "present") {
      throw new Error("unwitnessed_removal_refused: loaded account missing from preferences");
    }
  }
  // Every loaded account is in the list (checked above), so a listed-out
  // account is never one Thunderbird has loaded.
  return indexed.filter(id => !listed.has(id) && state.accounts?.[id] === "absent");
}

// Records every account found removed without an event, then runs the purge.
// A refusal or failure here removes nothing and leaves every record as it was.
async function _sweepAndPurge() {
  const ftsSearch = _ftsSearch;
  if (ftsSearch) {
    try {
      const removed = await _findUnwitnessedRemovals(ftsSearch);
      for (const accountId of removed) {
        _removedAccounts.add(accountId);
        _unrecorded.add(accountId);
        try {
          await _record(accountId);
        } catch (e) {
          log(`[TMDBG FTS] Failed to record a removed account, purging it anyway: ${e}`, "warn");
        }
      }
      if (removed.length > 0) {
        log(`[TMDBG FTS] Removed account purge: ${removed.length} account(s) removed while the add-on was not watching`);
      }
    } catch (e) {
      log(`[TMDBG FTS] Check for accounts removed without an event skipped: ${e}`, "warn");
    }
  }
  await _runPurges();
}

function _onAccountDeleted(accountId) {
  if (!_validAccountId(accountId)) return;
  _removedAccounts.add(accountId);
  _unrecorded.add(accountId);
  _record(accountId).catch((e) => {
    log(`[TMDBG FTS] Failed to record a removed account, purging it anyway: ${e}`, "warn");
  }).then(() => _enqueuePurge(_runPurges)).catch((e) => {
    log(`[TMDBG FTS] Removed account purge failed: ${e}`, "warn");
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

// Called once the native index is ready; finds accounts removed without an
// event and finishes every recorded purge.
export function initRemovedAccountPurge(ftsSearch) {
  _ftsSearch = ftsSearch;
  return _enqueuePurge(_sweepAndPurge);
}

export function _resetRemovedAccountPurgeForTests() {
  for (const [event, listener] of _listenerOwners) {
    try { event.removeListener(listener); } catch (_) {}
  }
  _listenerOwners.clear();
  _ftsSearch = null;
  _recordChain = Promise.resolve();
  _purgeChain = Promise.resolve();
  _removedAccounts.clear();
  _unrecorded.clear();
}

export async function _removedAccountPurgeIdleForTests() {
  for (;;) {
    const record = _recordChain;
    const purge = _purgeChain;
    await record;
    await purge;
    await new Promise(resolve => setTimeout(resolve, 0));
    if (record === _recordChain && purge === _purgeChain) return;
  }
}
