/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { folderMembershipIdCandidatesForKey } from "./folderMembershipIdentity.js";

// One process-local coordinator for every native email-FTS writer. Durable
// scan status remains observability only; live exclusion is owned here.
const FTS_SCAN_STATUS_KEY = "fts_scan_status";
const _sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let _nextRunId = 1;
let _exclusiveOwner = null;
let _reconcileOwner = null;
let _exclusiveWaiters = [];
let _membershipEpoch = 0;
// Folder-scoped change ledger. Each membership mutation is attributed to the
// folder ids whose rows or key range it can touch ("*" when unknown), and
// recorded at the epoch it advanced to. A proof about folder C is invalidated
// only by changes attributed to C or to the wildcard, so traffic in another
// folder never restarts it. Evicting an entry raises the floor: a stamp older
// than an evicted change is treated as changed, never as valid.
// Only real folders occupy the ledger: explicit owners, and key candidates
// that name a folder reconciliation registered from its inventory. A
// colon-bearing Message-ID splits into candidate paths no folder has, and
// recording those would let one busy folder evict every other entry.
// The cap bounds memory; it is far above any real profile's folder count.
const FTS_MEMBERSHIP_LEDGER_CONFIG = Object.freeze({ changeLedgerCap: 4096 });
let _membershipLedgerCap = FTS_MEMBERSHIP_LEDGER_CONFIG.changeLedgerCap;
let _membershipTouched = new Map();
let _membershipWildcardEpoch = 0;
let _membershipTouchFloor = 0;
// Real folder ids of the latest inventory; null until the first one (then
// every candidate is recorded). Bounded by the live inventory: a folder that
// leaves it has no proof left to protect (runtime pruning releases it).
let _membershipFolderUniverse = null;
// The raw scopes a running fence's callback attributed, or "*".
let _membershipFenceScope = null;
let _membershipTail = Promise.resolve();
const _membershipFenceToken = Object.freeze({});
const _leaseStatusState = new WeakMap();
const _exclusiveMembershipChangeListeners = new Set();

function _newLease(kind, priority) {
  const runId = `${_sessionId}:${_nextRunId++}`;
  const lease = {
    kind,
    priority,
    sessionId: _sessionId,
    runId,
    cancelRequested: false,
    released: false,
    startMembershipEpoch: _membershipEpoch,
    release() {
      if (lease.released) return;
      lease.released = true;
      if (priority === "exclusive") {
        if (_exclusiveOwner === lease) {
          _exclusiveOwner = null;
          if (lease.startMembershipEpoch !== _membershipEpoch) {
            const event = Object.freeze({
              kind: lease.kind,
              sessionId: lease.sessionId,
              runId: lease.runId,
              startEpoch: lease.startMembershipEpoch,
              endEpoch: _membershipEpoch,
            });
            // Ownership is already released. Subscribers synchronously discard
            // ephemeral proof, while any durable follow-up stays asynchronous.
            for (const listener of [..._exclusiveMembershipChangeListeners]) {
              try { listener(event); } catch (_) {}
            }
          }
        }
      } else if (_reconcileOwner === lease) {
        _reconcileOwner = null;
      }
      _drainExclusiveWaiters();
    },
  };
  _leaseStatusState.set(lease, {
    tail: Promise.resolve(),
    closing: false,
    closePromise: null,
  });
  return lease;
}

function _drainExclusiveWaiters() {
  if (_exclusiveOwner || _reconcileOwner || _exclusiveWaiters.length === 0) return;
  const waiter = _exclusiveWaiters.shift();
  const lease = _newLease(waiter.kind, "exclusive");
  _exclusiveOwner = lease;
  waiter.resolve(lease);
}

export function acquireFtsExclusiveOperation(kind = "foreground") {
  if (_reconcileOwner) _reconcileOwner.cancelRequested = true;
  return new Promise((resolve) => {
    _exclusiveWaiters.push({ kind, resolve });
    _drainExclusiveWaiters();
  });
}

export function tryAcquireFtsReconcileLease() {
  if (_exclusiveOwner || _reconcileOwner || _exclusiveWaiters.length > 0) return null;
  const lease = _newLease("reconcile", "reconcile");
  _reconcileOwner = lease;
  return lease;
}

export function getFtsMembershipEpoch() {
  return _membershipEpoch;
}

// Resolved when the change is recorded, against the universe at that time:
// a folder registered while the mutation ran is still attributed.
// A scope is "*", an iterable of folder ids, or { msgIds, folderIds } where
// folderIds are explicit owners (always recorded).
function _resolveMembershipScope(scope) {
  if (scope === "*") return "*";
  const resolved = new Set();
  const addCandidate = folderId => {
    if (folderId && (_membershipFolderUniverse === null || _membershipFolderUniverse.has(folderId))) {
      resolved.add(folderId);
    }
  };
  if (Array.isArray(scope) || scope instanceof Set) {
    for (const folderId of scope) addCandidate(folderId);
    return resolved;
  }
  for (const folderId of scope?.folderIds || []) {
    if (folderId) resolved.add(folderId);
  }
  for (const msgId of scope?.msgIds || []) {
    const candidates = folderMembershipIdCandidatesForKey(msgId);
    if (!candidates) return "*";
    candidates.forEach(addCandidate);
  }
  return resolved;
}

// Replaces the universe with reconciliation's current inventory. A folder
// new to it (including one returning after it left) is recorded as changed
// now: changes to it while unregistered were not attributed, and no stamp
// older than this may trust them.
export function registerFtsMembershipFolders(folderIds) {
  const previous = _membershipFolderUniverse || new Set();
  const universe = new Set();
  const added = [];
  for (const folderId of folderIds) {
    if (!folderId || universe.has(folderId)) continue;
    universe.add(folderId);
    if (!previous.has(folderId)) added.push(folderId);
  }
  _membershipFolderUniverse = universe;
  if (added.length > 0) _recordMembershipScope(added, _membershipEpoch);
}

function _recordMembershipScope(scope, epoch) {
  if (scope === "*") {
    _membershipWildcardEpoch = epoch;
    return;
  }
  for (const folderId of scope) {
    _membershipTouched.delete(folderId);
    _membershipTouched.set(folderId, epoch);
  }
  while (_membershipTouched.size > _membershipLedgerCap) {
    const [oldest, oldestEpoch] = _membershipTouched.entries().next().value;
    _membershipTouched.delete(oldest);
    _membershipTouchFloor = Math.max(_membershipTouchFloor, oldestEpoch);
  }
}

function _mergeMembershipScope(target, scope) {
  if (target === "*" || scope === "*") return "*";
  for (const folderId of scope) target.add(folderId);
  return target;
}

function _resolveFenceScopes(scopes) {
  if (scopes === "*") return "*";
  let resolved = new Set();
  for (const scope of scopes) resolved = _mergeMembershipScope(resolved, _resolveMembershipScope(scope));
  return resolved;
}

// True when no membership change attributed to any folder id in `scope`
// (or to the wildcard) completed after `sinceEpoch` was read. A "*" scope is
// the global check.
export function ftsMembershipUnchangedSince(scope, sinceEpoch) {
  if (scope === "*") return sinceEpoch === _membershipEpoch;
  if (!Number.isFinite(sinceEpoch)
      || sinceEpoch < _membershipTouchFloor
      || sinceEpoch < _membershipWildcardEpoch) {
    return false;
  }
  for (const folderId of scope) {
    if ((_membershipTouched.get(folderId) ?? 0) > sinceEpoch) return false;
  }
  return true;
}

export function addFtsExclusiveMembershipChangeListener(listener) {
  if (typeof listener !== "function") throw new TypeError("listener must be a function");
  _exclusiveMembershipChangeListeners.add(listener);
  return () => { _exclusiveMembershipChangeListeners.delete(listener); };
}

async function _withMembershipMutex(fn) {
  let release;
  const baton = new Promise(resolve => { release = resolve; });
  const previous = _membershipTail;
  _membershipTail = previous.catch(() => {}).then(() => baton);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

// A read whose answer decides a membership write (the drain's "already
// indexed?" check) runs between membership mutations, never across one, so
// it cannot act on a row an in-flight removal is about to delete.
export async function runFtsMembershipRead(fn) {
  return _withMembershipMutex(fn);
}

// `scope` names the folder ids the mutation can touch; omitting it is the
// conservative wildcard.
export async function runFtsMembershipMutation(fn, fenceToken = null, scope = "*") {
  // A recon-owned mutator is already executing under the membership mutex.
  // Only the opaque token passed by withFtsMembershipFence can select this
  // path; the enclosing fence performs the single conservative epoch advance
  // and records this scope with it. The scope joins the fence before the
  // native call, so a partial commit is still attributed.
  if (fenceToken === _membershipFenceToken) {
    if (_membershipFenceScope !== "*") {
      _membershipFenceScope = scope === "*" ? "*" : [..._membershipFenceScope, scope];
    }
    return fn();
  }
  return _withMembershipMutex(async () => {
    try {
      return await fn();
    } finally {
      // A throwing native mutator may have partially committed. Advancing on
      // every attempted call is conservative and prevents stale proof reuse.
      _membershipEpoch = Math.min(Number.MAX_SAFE_INTEGER, _membershipEpoch + 1);
      _recordMembershipScope(_resolveMembershipScope(scope), _membershipEpoch);
    }
  });
}

// Without `scope` the fence holds only while no membership mutation at all
// has completed since `expectedEpoch`; with a scope, only changes attributed
// to those folder ids (or the wildcard) break it.
export async function withFtsMembershipFence(
  expectedEpoch,
  fn,
  { mutation = false, scope = null } = {},
) {
  return _withMembershipMutex(async () => {
    const current = scope === null
      ? expectedEpoch === _membershipEpoch
      : ftsMembershipUnchangedSince(scope, expectedEpoch);
    if (!current) throw new Error("membership_epoch_changed");
    _membershipFenceScope = [];
    try {
      return await fn(_membershipFenceToken);
    } finally {
      const attributed = _membershipFenceScope;
      _membershipFenceScope = null;
      if (mutation) {
        // The fenced folders are always recorded; an unscoped fence whose
        // callback attributed nothing is conservatively the wildcard.
        let fencedScope = _resolveFenceScopes(attributed);
        if (scope !== null) fencedScope = _mergeMembershipScope(fencedScope, _resolveMembershipScope(scope));
        else if (attributed.length === 0) fencedScope = "*";
        _membershipEpoch = Math.min(Number.MAX_SAFE_INTEGER, _membershipEpoch + 1);
        _recordMembershipScope(fencedScope, _membershipEpoch);
      }
    }
  });
}

function _ownsExclusiveLease(lease) {
  return !!lease
    && !lease.released
    && lease.priority === "exclusive"
    && _exclusiveOwner === lease;
}

export function writeOwnedFtsScanStatus(lease, status) {
  const state = _leaseStatusState.get(lease);
  if (!_ownsExclusiveLease(lease) || !state || state.closing) {
    return Promise.reject(new Error("fts_operation_owner_lost"));
  }
  const next = {
    ...status,
    isScanning: true,
    sessionId: lease.sessionId,
    runId: lease.runId,
  };
  const task = state.tail.catch(() => {}).then(async () => {
    if (!_ownsExclusiveLease(lease) || state.closing) {
      throw new Error("fts_operation_owner_lost");
    }
    await browser.storage.local.set({ [FTS_SCAN_STATUS_KEY]: next });
    if (!_ownsExclusiveLease(lease)) throw new Error("fts_operation_owner_lost");
    return next;
  });
  state.tail = task.catch(() => {});
  return task;
}

export function clearOwnedFtsScanStatus(lease, extra = {}) {
  if (!lease?.sessionId || !lease?.runId) return Promise.resolve(false);
  const state = _leaseStatusState.get(lease);
  if (state?.closePromise) return state.closePromise;
  if (state) state.closing = true;
  const task = (state?.tail || Promise.resolve()).catch(() => {}).then(async () => {
    const stored = await browser.storage.local.get(FTS_SCAN_STATUS_KEY);
    const current = stored?.[FTS_SCAN_STATUS_KEY];
    if (current?.sessionId !== lease.sessionId || current?.runId !== lease.runId) return false;
    await browser.storage.local.set({
      [FTS_SCAN_STATUS_KEY]: {
        ...extra,
        isScanning: false,
        scanType: "none",
        sessionId: lease.sessionId,
        runId: lease.runId,
        lastCompleted: Date.now(),
      },
    });
    return true;
  });
  if (state) {
    state.closePromise = task;
    state.tail = task.catch(() => {});
  }
  return task;
}

export async function normalizeInterruptedFtsScanStatus() {
  const stored = await browser.storage.local.get(FTS_SCAN_STATUS_KEY);
  const current = stored?.[FTS_SCAN_STATUS_KEY];
  if (!current?.isScanning) return false;
  if (_exclusiveOwner
      && current.sessionId === _exclusiveOwner.sessionId
      && current.runId === _exclusiveOwner.runId) {
    return false;
  }
  await browser.storage.local.set({
    [FTS_SCAN_STATUS_KEY]: {
      isScanning: false,
      scanType: "none",
      interrupted: true,
      interruptedScanType: current.scanType || "unknown",
      lastCompleted: Date.now(),
    },
  });
  return true;
}

export function getFtsOperationState() {
  return {
    exclusive: !!_exclusiveOwner,
    exclusiveKind: _exclusiveOwner?.kind || null,
    reconcile: !!_reconcileOwner,
    foregroundWaiting: _exclusiveWaiters.length,
    membershipEpoch: _membershipEpoch,
  };
}

export function _resetFtsOperationCoordinatorForTests({
  changeLedgerCap = FTS_MEMBERSHIP_LEDGER_CONFIG.changeLedgerCap,
} = {}) {
  _exclusiveOwner = null;
  _reconcileOwner = null;
  _exclusiveWaiters = [];
  _membershipEpoch = 0;
  _membershipTouched = new Map();
  _membershipWildcardEpoch = 0;
  _membershipTouchFloor = 0;
  _membershipFenceScope = null;
  _membershipFolderUniverse = null;
  _membershipLedgerCap = changeLedgerCap;
  _membershipTail = Promise.resolve();
  _nextRunId = 1;
}
