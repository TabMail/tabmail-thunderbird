/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// One process-local coordinator for every native email-FTS writer. Durable
// scan status remains observability only; live exclusion is owned here.
const FTS_SCAN_STATUS_KEY = "fts_scan_status";
const _sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let _nextRunId = 1;
let _exclusiveOwner = null;
let _reconcileOwner = null;
let _exclusiveWaiters = [];
let _membershipEpoch = 0;
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

export async function runFtsMembershipMutation(fn, fenceToken = null) {
  // A recon-owned mutator is already executing under the membership mutex.
  // Only the opaque token passed by withFtsMembershipFence can select this
  // path; the enclosing fence performs the single conservative epoch advance.
  if (fenceToken === _membershipFenceToken) return fn();
  return _withMembershipMutex(async () => {
    try {
      return await fn();
    } finally {
      // A throwing native mutator may have partially committed. Advancing on
      // every attempted call is conservative and prevents stale proof reuse.
      _membershipEpoch = Math.min(Number.MAX_SAFE_INTEGER, _membershipEpoch + 1);
    }
  });
}

export async function withFtsMembershipFence(expectedEpoch, fn, { mutation = false } = {}) {
  return _withMembershipMutex(async () => {
    if (expectedEpoch !== _membershipEpoch) throw new Error("membership_epoch_changed");
    try {
      return await fn(_membershipFenceToken);
    } finally {
      if (mutation) {
        _membershipEpoch = Math.min(Number.MAX_SAFE_INTEGER, _membershipEpoch + 1);
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

export function _resetFtsOperationCoordinatorForTests() {
  _exclusiveOwner = null;
  _reconcileOwner = null;
  _exclusiveWaiters = [];
  _membershipEpoch = 0;
  _membershipTail = Promise.resolve();
  _nextRunId = 1;
}
