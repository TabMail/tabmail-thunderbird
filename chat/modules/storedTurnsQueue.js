/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// storedTurnsQueue.js – the one writer of the stored chat turns (chat_turns).
//
// Runs in the background, and only there: loading the module starts it. Every
// change to the stored turns is an operation (clear, remove by id, keep from a
// time, update by id, append) put on one queue: the chat window and Chat
// History send theirs as runtime messages (persistentChatStore.changeTurns),
// the background's own code calls enqueueTurnsChange.
//
// A change is accepted once a saved queue (chat_turns_pending) holds it; one
// that cannot be saved is refused, never answered as queued. Accepted changes
// are applied one at a time in the order sent, each as read, change and write
// of the stored turns, and leave the saved queue only once applied; so no
// writer ever replaces the turns with an older copy, and nothing accepted is
// lost to a window close, a failed write or a restart. Readers see queued
// changes already (persistentChatStore.loadTurns applies them).
//
// An apply that fails, or whose read runs past its time limit, stays at the
// head and is retried after a delay (a timer, and a named alarm that wakes a
// suspended background); new changes are still accepted meanwhile, up to a
// limit, but do not cut the delay short.

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "./chatConfig.js";
import { applyTurnsOperation, isTurnsOperation } from "./persistentChatStore.js";

const TURNS_KEY = "chat_turns";
const QUEUE_KEY = "chat_turns_pending";
const RETRY_ALARM = "tabmail-chat-turns-retry";
const MIN_RETRY_ALARM_MS = 60_000; // the shortest alarm period Thunderbird keeps
/** The error when a change's wait ran out while the queue holding it was being saved. */
export const CHANGE_UNCONFIRMED = "not confirmed in time; it is applied later if its save succeeds";

// [{ id, op, saved, result, resolve }] in arrival order. `saved`: a saved queue
// held it (accepted); `result`: applied, waiting to leave the saved queue;
// `resolve`: answers its caller, if still waiting (none for a restored change).
let _pending = [];
let _restorePromise = null;
let _draining = null;
let _retryTimer = null;
let _saving = Promise.resolve();
// Changes waiting for the restore before they can be queued; counted against
// maxQueued with the queue, so a restore that does not finish holds no more.
let _admitting = 0;

// Save the queue, less the changes already applied. Saves run one at a time,
// each writing the queue as it is when it runs; the changes it held are then
// accepted.
function _save() {
  const run = _saving.then(async () => {
    const held = _pending.filter(item => !item.result);
    await browser.storage.local.set({ [QUEUE_KEY]: held.map(({ id, op }) => ({ id, op })) });
    for (const item of held) item.saved = true;
  });
  _saving = run.catch(() => {});
  return run;
}

async function _restore() {
  const stored = (await browser.storage.local.get(QUEUE_KEY))[QUEUE_KEY];
  // Nothing is enqueued before the restore has finished (_accept waits for it).
  _pending = Array.isArray(stored)
    ? stored.filter(item => item?.id && isTurnsOperation(item.op)).map(({ id, op }) => ({ id, op, saved: true, result: null, resolve: null }))
    : [];
  if (_pending.length > 0) log(`[StoredTurnsQueue] Restored ${_pending.length} queued change(s)`);
}

function _ensureRestored() {
  if (!_restorePromise) {
    _restorePromise = _restore().catch(e => {
      _restorePromise = null;
      throw e;
    });
  }
  return _restorePromise;
}

// Read the stored turns, giving up after applyTimeoutMs. Only the read is
// limited: a read changes nothing, so giving up on it is safe; a write once
// issued is waited for, so no later write can overtake it.
async function _readTurns() {
  const { applyTimeoutMs } = CHAT_SETTINGS.turnsQueue;
  const reading = browser.storage.local.get(TURNS_KEY);
  reading.catch(() => {}); // a read given up on may still fail later
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`read ran past ${applyTimeoutMs} ms`)), applyTimeoutMs);
  });
  try {
    return (await Promise.race([reading, limit]))[TURNS_KEY];
  } finally {
    clearTimeout(timer);
  }
}

/** Apply one operation to the stored turns: read, change, write. A failed read writes nothing. */
async function _apply(op) {
  const stored = await _readTurns();
  const { turns, removed } = applyTurnsOperation(Array.isArray(stored) ? stored : [], op);
  if (turns.length > 0) await browser.storage.local.set({ [TURNS_KEY]: turns });
  else await browser.storage.local.remove(TURNS_KEY);
  log(`[StoredTurnsQueue] Applied change: ${turns.length} stored, ${removed} removed`, "debug");
  return { removed };
}

function _scheduleRetry() {
  if (_retryTimer) return;
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    _kick();
  }, CHAT_SETTINGS.turnsQueue.retryDelayMs);
}

// The alarm only wakes the background to retry; a change is applied whether
// or not it could be set.
async function _armRetryAlarm() {
  try {
    if (await browser.alarms.get(RETRY_ALARM)) return;
    const periodInMinutes = Math.max(CHAT_SETTINGS.turnsQueue.retryDelayMs, MIN_RETRY_ALARM_MS) / 60_000;
    await browser.alarms.create(RETRY_ALARM, { periodInMinutes });
  } catch (e) {
    log(`[StoredTurnsQueue] Retry alarm not set: ${e}`, "warn");
  }
}

// The alarm is armed while the saved queue may hold a change (also when it
// could not be restored, so is unknown), and cleared only once a drain has
// emptied the restored queue.
async function _drain() {
  try {
    await _ensureRestored();
  } catch (e) {
    await _armRetryAlarm();
    throw e;
  }
  if (_pending.length > 0) await _armRetryAlarm();
  while (_pending.length > 0) {
    const item = _pending[0];
    if (!item.saved) break; // not accepted yet; its save starts the drain again
    try {
      if (!item.result) item.result = await _apply(item.op);
      // Applied, it leaves the saved queue. Until that is saved nothing after
      // it is applied, so a restart cannot apply an older change after a newer one.
      await _save();
    } catch (e) {
      log(`[StoredTurnsQueue] Change ${item.id} not done, kept to retry: ${e}`, "warn");
      _scheduleRetry();
      break;
    }
    _pending.shift();
    item.resolve?.({ applied: true, ...item.result });
  }
  if (_pending.length === 0) await browser.alarms.clear(RETRY_ALARM);
}

// Start a drain, unless one is running or a failed change is waiting out its
// retry delay; the retry alarm (at most once a minute) does not wait for it.
function _kick({ alarm = false } = {}) {
  if (_draining || (_retryTimer && !alarm)) return _draining;
  _draining = _drain()
    .catch(e => {
      log(`[StoredTurnsQueue] Drain failed: ${e}`, "warn");
      _scheduleRetry();
    })
    .finally(() => {
      _draining = null;
      // A change accepted as the drain was ending.
      if (_pending[0]?.saved) _kick();
    });
  return _draining;
}

// Accept a change: queue it and save the queue. Throws, leaving it out, when it
// cannot be saved or the queue is full, or (`gaveUp()`) its caller stopped
// waiting before it was queued.
async function _accept(item, gaveUp) {
  const { maxQueued } = CHAT_SETTINGS.turnsQueue;
  if (_pending.length + _admitting >= maxQueued) {
    throw new Error(`queue full (${_pending.length + _admitting} changes not yet applied)`);
  }
  _admitting++;
  try {
    await _ensureRestored();
  } finally {
    _admitting--;
  }
  if (gaveUp()) throw new Error("not accepted in time");
  if (_pending.length >= maxQueued) {
    throw new Error(`queue full (${_pending.length} changes not yet applied)`);
  }
  _pending.push(item);
  try {
    await _save();
  } catch (e) {
    // Another save may have held it already. Otherwise it was never applied
    // (only saved changes are), so leaving it out undoes nothing.
    if (!item.saved) {
      _pending.splice(_pending.indexOf(item), 1);
      throw e;
    }
  }
  _kick();
}

/**
 * Queue a change to the stored turns and wait, at most
 * CHAT_SETTINGS.turnsQueue.applyWaitMs in all, for it to be applied.
 *
 * @param {{ clear?: boolean, remove?: string[], keepFrom?: number, update?: object[], append?: object[] }} op
 *   see persistentChatStore.applyTurnsOperation
 * @param {string} id - the change's id, unique to it
 * @returns {Promise<{ applied: true, removed: number } | { applied: false, queued: true } | { applied: false, error: string }>}
 *   applied; or accepted (held by the saved queue) and applied later, in
 *   order; or refused, and never applied. One exception: when the wait runs
 *   out while the queue holding the change is being saved, the error is
 *   CHANGE_UNCONFIRMED, and the change is applied, in order, if that save
 *   succeeds.
 */
export async function enqueueTurnsChange(op, id) {
  const item = { id, op, saved: false, result: null, resolve: null };
  const applied = new Promise(resolve => { item.resolve = resolve; });
  let timedOut = false;
  let timer;
  const wait = new Promise(resolve => {
    timer = setTimeout(() => { timedOut = true; resolve(null); }, CHAT_SETTINGS.turnsQueue.applyWaitMs);
  });
  const accepting = _accept(item, () => timedOut).then(() => applied);
  accepting.catch(() => {}); // a refusal after the wait ran out is answered by the wait
  try {
    const reply = await Promise.race([accepting, wait]);
    if (reply) return reply;
    if (item.saved) return { applied: false, queued: true };
    return { applied: false, error: _pending.includes(item) ? CHANGE_UNCONFIRMED : "not accepted in time" };
  } catch (e) {
    log(`[StoredTurnsQueue] Change ${id} refused: ${e}`, "warn");
    return { applied: false, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The background's handler for a change an extension page sends
 * ({ command: "chat-turns-change", id, op }). Resolves to the reply.
 */
export function handleStoredTurnsMessage(message) {
  return enqueueTurnsChange(message.op, message.id);
}

// Loaded by agent/background.js when it starts: restore the queue and apply
// what it holds. A named alarm wakes a suspended background to retry; an
// in-memory timer cannot.
_kick();
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name !== RETRY_ALARM) return;
  return _kick({ alarm: true });
});
