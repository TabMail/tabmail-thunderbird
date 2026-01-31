import { SETTINGS } from "./config.js";
import { isInboxFolder } from "./folderUtils.js";
import { processMessage } from "./messageProcessor.js";
import { getUniqueMessageKey, headerIDToWeID, log, parseUniqueId } from "./utils.js";

const QUEUE_STORAGE_KEY = "agent_processmessage_pending";

let _pending = new Map(); // Map<uniqueKey, { uniqueKey, timestamp, opts, metadata, attempts, lastErrorAtMs }>
let _persistTimer = null;
let _watchTimer = null;
let _retryTimer = null;
let _kickTimer = null;
let _isProcessing = false;
let _inited = false;

function _cfg() {
  return SETTINGS?.agentQueues?.processMessage || {};
}

function _num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _kickDelayMs() {
  return _num(_cfg().kickDelayMs, 0);
}

function _watchIntervalMs() {
  return _num(_cfg().watchIntervalMs, 0);
}

function _persistDebounceMs() {
  return _num(_cfg().persistDebounceMs, 0);
}

function _batchSize() {
  return Math.max(1, Math.ceil(_num(_cfg().batchSize, 1)));
}

function _retryDelayMs() {
  return _num(_cfg().retryDelayMs, _watchIntervalMs());
}

function _maxResolveAttempts() {
  return Math.max(1, Math.ceil(_num(_cfg().maxResolveAttempts, 5)));
}

function _clearTimer(refName) {
  try {
    if (refName === "persist" && _persistTimer) {
      clearTimeout(_persistTimer);
      _persistTimer = null;
    }
    if (refName === "watch" && _watchTimer) {
      clearInterval(_watchTimer);
      _watchTimer = null;
    }
    if (refName === "retry" && _retryTimer) {
      clearTimeout(_retryTimer);
      _retryTimer = null;
    }
    if (refName === "kick" && _kickTimer) {
      clearTimeout(_kickTimer);
      _kickTimer = null;
    }
  } catch (_) {}
}

async function _persistNow() {
  try {
    const arr = Array.from(_pending.values()).map((it) => ({
      uniqueKey: it.uniqueKey,
      timestamp: it.timestamp,
      opts: it.opts || {},
      metadata: it.metadata || {},
      attempts: it.attempts || 0,
      resolveAttempts: it.resolveAttempts || 0,
      lastErrorAtMs: it.lastErrorAtMs || 0,
    }));
    await browser.storage.local.set({ [QUEUE_STORAGE_KEY]: arr });
    log(`[TMDBG PMQ] Persisted processMessage queue: pending=${arr.length}`);
  } catch (e) {
    log(`[TMDBG PMQ] Failed to persist queue: ${e}`, "error");
  }
}

function _schedulePersist() {
  const ms = _persistDebounceMs();
  if (ms <= 0) {
    // If debounce is disabled, still persist asynchronously but without a timer.
    _persistNow().catch(() => {});
    return;
  }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    _persistNow().catch(() => {});
  }, ms);
}

async function _restoreFromStorage() {
  try {
    const stored = await browser.storage.local.get(QUEUE_STORAGE_KEY);
    const arr = stored?.[QUEUE_STORAGE_KEY] || [];
    if (!Array.isArray(arr) || arr.length === 0) {
      log("[TMDBG PMQ] No persisted processMessage queue items found");
      return;
    }

    let restored = 0;
    let skipped = 0;
    for (const it of arr) {
      const key = it?.uniqueKey ? String(it.uniqueKey) : "";
      if (!key) continue;
      if (_pending.has(key)) {
        skipped++;
        continue;
      }
      _pending.set(key, {
        uniqueKey: key,
        timestamp: Number(it?.timestamp) || Date.now(),
        opts: it?.opts || {},
        metadata: it?.metadata || {},
        attempts: Number(it?.attempts) || 0,
        resolveAttempts: Number(it?.resolveAttempts) || 0,
        lastErrorAtMs: Number(it?.lastErrorAtMs) || 0,
      });
      restored++;
    }
    log(`[TMDBG PMQ] Restored ${restored} queued processMessage items from storage (skipped=${skipped})`);
  } catch (e) {
    log(`[TMDBG PMQ] Failed to restore queue from storage: ${e}`, "error");
  }
}

async function _clearPersisted() {
  try {
    await browser.storage.local.remove(QUEUE_STORAGE_KEY);
    log("[TMDBG PMQ] Cleared persisted processMessage queue");
  } catch (e) {
    log(`[TMDBG PMQ] Failed to clear persisted queue: ${e}`, "warn");
  }
}

function _ensureWatchdog() {
  const intervalMs = _watchIntervalMs();
  if (intervalMs <= 0) {
    log("[TMDBG PMQ] Watchdog disabled (watchIntervalMs<=0)");
    return;
  }
  if (_watchTimer) return;
  _watchTimer = setInterval(() => {
    try {
      if (_pending.size > 0) {
        log(`[TMDBG PMQ] Watchdog tick: pending=${_pending.size} processing=${_isProcessing}`);
      }
      drainProcessMessageQueue().catch((e) => {
        log(`[TMDBG PMQ] Watchdog drain error: ${e}`, "warn");
      });
    } catch (_) {}
  }, intervalMs);
  log(`[TMDBG PMQ] Watchdog started: intervalMs=${intervalMs}`);
}

function _scheduleRetrySoon(reason = "unknown") {
  const delayMs = _retryDelayMs();
  if (delayMs <= 0) {
    log(`[TMDBG PMQ] Retry scheduling disabled (retryDelayMs<=0). reason=${reason}`, "warn");
    return;
  }
  if (_retryTimer) return; // keep the earliest scheduled retry
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    drainProcessMessageQueue().catch(() => {});
  }, delayMs);
  log(`[TMDBG PMQ] Scheduled retry in ${delayMs}ms (reason=${reason})`);
}

function _scheduleKick() {
  const delayMs = _kickDelayMs();
  if (delayMs < 0) return;
  // Only schedule if no kick is already pending (debounce)
  if (_kickTimer) return;
  _kickTimer = setTimeout(() => {
    _kickTimer = null;
    drainProcessMessageQueue().catch(() => {});
  }, delayMs);
}

/**
 * Initialize persistent processMessage queue:
 * - restores pending items from storage.local
 * - starts watchdog timer (while worker is awake)
 */
export async function initProcessMessageQueue() {
  if (_inited) return;
  _inited = true;

  log("[TMDBG PMQ] initProcessMessageQueue()");
  await _restoreFromStorage();
  _ensureWatchdog();

  if (_pending.size > 0) {
    log(`[TMDBG PMQ] Pending items on init: ${_pending.size} (kicking drain)`);
    _scheduleKick();
  }
}

/**
 * Enqueue a message for later (retryable) processing.
 * Uses the stable uniqueKey (accountId:folderPath:headerMessageId) so the queue can survive restarts.
 */
export async function enqueueProcessMessage(messageHeader, opts = {}) {
  try {
    if (!messageHeader) return { ok: false, error: "missing messageHeader" };

    const uniqueKey = await getUniqueMessageKey(messageHeader);
    if (!uniqueKey) {
      log(`[TMDBG PMQ] enqueueProcessMessage: failed to derive uniqueKey for weId=${messageHeader?.id}`, "warn");
      return { ok: false, error: "uniqueKey-failed" };
    }

    const now = Date.now();
    const prev = _pending.get(uniqueKey);
    const merged = {
      uniqueKey,
      timestamp: prev?.timestamp || now,
      opts: { ...(prev?.opts || {}), ...(opts || {}) },
      metadata: {
        ...(prev?.metadata || {}),
        subject: messageHeader?.subject,
        folderName: messageHeader?.folder?.name,
        folderPath: messageHeader?.folder?.path,
      },
      attempts: Number(prev?.attempts) || 0,
      lastErrorAtMs: Number(prev?.lastErrorAtMs) || 0,
    };
    _pending.set(uniqueKey, merged);

    log(
      `[TMDBG PMQ] Enqueued processMessage: key=${uniqueKey} weId=${messageHeader?.id} subject="${(messageHeader?.subject || "").slice(0, 80)}" pending=${_pending.size}`
    );

    _schedulePersist();
    _ensureWatchdog();
    _scheduleKick();
    return { ok: true, uniqueKey };
  } catch (e) {
    log(`[TMDBG PMQ] enqueueProcessMessage failed: ${e}`, "error");
    return { ok: false, error: String(e) };
  }
}

/**
 * Process a single queued item. Returns result for aggregation.
 */
async function _processOneItem(it) {
  const key = String(it?.uniqueKey || "");
  if (!key) return { status: "skip" };

  // Resolve uniqueKey -> weID -> MessageHeader
  const parsed = parseUniqueId(key);
  if (!parsed?.headerID) {
    log(`[TMDBG PMQ] Invalid uniqueKey (cannot parse) - dropping: ${key}`, "warn");
    _pending.delete(key);
    return { status: "dropped" };
  }

  // Track resolve attempts (separate from processing attempts)
  const resolveAttemptNo = (Number(it?.resolveAttempts) || 0) + 1;
  const maxResolve = _maxResolveAttempts();

  let weId = null;
  try {
    weId = await headerIDToWeID(parsed.headerID, parsed.weFolder, false, true);
  } catch (eResolve) {
    log(`[TMDBG PMQ] headerIDToWeID threw for key=${key}: ${eResolve}`, "warn");
  }

  if (!weId) {
    // Message not queryable - could be transient IMAP/Gmail sync or truly deleted.
    if (resolveAttemptNo >= maxResolve) {
      log(`[TMDBG PMQ] Could not resolve message for key=${key} after ${resolveAttemptNo} attempts - dropping`, "warn");
      _pending.delete(key);
      return { status: "dropped" };
    } else {
      log(`[TMDBG PMQ] Could not resolve message for key=${key} (attempt ${resolveAttemptNo}/${maxResolve}) - will retry`, "warn");
      _pending.set(key, { ...it, resolveAttempts: resolveAttemptNo, lastErrorAtMs: Date.now() });
      return { status: "retry" };
    }
  }

  let header = null;
  try {
    header = await browser.messages.get(weId);
  } catch (eGet) {
    log(`[TMDBG PMQ] browser.messages.get failed for weId=${weId} key=${key}: ${eGet}`, "warn");
  }

  if (!header) {
    if (resolveAttemptNo >= maxResolve) {
      log(`[TMDBG PMQ] Missing header for weId=${weId} key=${key} after ${resolveAttemptNo} attempts - dropping`, "warn");
      _pending.delete(key);
      return { status: "dropped" };
    } else {
      log(`[TMDBG PMQ] Missing header for weId=${weId} key=${key} (attempt ${resolveAttemptNo}/${maxResolve}) - will retry`, "warn");
      _pending.set(key, { ...it, resolveAttempts: resolveAttemptNo, lastErrorAtMs: Date.now() });
      return { status: "retry" };
    }
  }

  // Reset resolve attempts on successful resolve
  if (it?.resolveAttempts) {
    _pending.set(key, { ...it, resolveAttempts: 0 });
  }

  // Check if message is still in inbox BEFORE processing
  // If message left inbox (moved, archived, deleted), drop it immediately
  const folder = header?.folder;
  if (!folder || !isInboxFolder(folder)) {
    log(
      `[TMDBG PMQ] Message no longer in inbox - dropping before processing: weId=${header.id} key=${key} folder="${folder?.name || "none"}" path="${folder?.path || ""}" type="${folder?.type || ""}"`,
      "warn"
    );
    _pending.delete(key);
    return { status: "dropped" };
  }

  // Attempt processing; only remove from queue when processMessage reports ok=true.
  const attemptNo = (Number(it?.attempts) || 0) + 1;
  _pending.set(key, { ...it, attempts: attemptNo });
  try {
    log(`[TMDBG PMQ] Attempting processMessage: weId=${header.id} key=${key} attempt=${attemptNo}`);
    const res = await processMessage(header, it?.opts || {});
    const ok = !!res?.ok;
    if (ok) {
      _pending.delete(key);
      log(`[TMDBG PMQ] processMessage OK: weId=${header.id} key=${key} removedFromQueue=true`);
      return { status: "processed" };
    } else {
      _pending.set(key, {
        ..._pending.get(key),
        lastErrorAtMs: Date.now(),
      });
      log(
        `[TMDBG PMQ] processMessage incomplete: weId=${header.id} key=${key} attempt=${attemptNo} res=${JSON.stringify(res || {})}`,
        "warn"
      );
      return { status: "retry" };
    }
  } catch (eProc) {
    _pending.set(key, {
      ..._pending.get(key),
      lastErrorAtMs: Date.now(),
    });
    log(`[TMDBG PMQ] processMessage threw: weId=${header.id} key=${key} attempt=${attemptNo} err=${eProc}`, "warn");
    return { status: "retry" };
  }
}

/**
 * Drain queued message processing work.
 * Processes items IN PARALLEL for maximum throughput.
 * Keeps items queued when processing is incomplete (e.g. offline/backend failure).
 */
export async function drainProcessMessageQueue() {
  if (_isProcessing) return;
  if (_pending.size === 0) return;

  _isProcessing = true;
  try {
    const batchSize = _batchSize();
    const items = Array.from(_pending.values())
      .sort((a, b) => (Number(a?.timestamp) || 0) - (Number(b?.timestamp) || 0))
      .slice(0, batchSize);

    log(`[TMDBG PMQ] Draining processMessage queue IN PARALLEL: pending=${_pending.size} batchSize=${items.length}`);

    // Process all items in parallel
    const results = await Promise.all(items.map((it) => _processOneItem(it)));

    // Aggregate results
    let processed = 0;
    let dropped = 0;
    let needsRetry = false;
    for (const r of results) {
      if (r.status === "processed") processed++;
      else if (r.status === "dropped") dropped++;
      else if (r.status === "retry") needsRetry = true;
    }

    if (_pending.size === 0) {
      await _clearPersisted();
    } else {
      await _persistNow();
    }

    log(`[TMDBG PMQ] Drain cycle complete: processed=${processed} dropped=${dropped} remaining=${_pending.size}`);

    // Trigger tagSort refresh if any messages were processed (tags were computed)
    // IMPORTANT DESIGN CHOICE: Use debounced refresh() NOT refreshImmediate()!
    // - refreshImmediate() would cause emails to visually jump around while user is watching
    // - refresh() uses a 30-second delayed sort from the last change, so sorting only
    //   happens when the user isn't actively looking (reduces jarring UI experience)
    // - The 30s timer resets on each call, ensuring we wait for activity to settle
    // - When user switches views/tabs, immediate sort is triggered by TabSelect/folderURIChanged
    if (processed > 0) {
      try {
        if (browser.tagSort?.refresh) {
          browser.tagSort.refresh();
          log(`[TMDBG PMQ] Triggered tagSort.refresh() after processing ${processed} message(s)`);
        }
      } catch (eRefresh) {
        log(`[TMDBG PMQ] Failed to trigger tagSort.refresh(): ${eRefresh}`, "warn");
      }

      // Check for reminder changes → may trigger proactive check-in
      try {
        const { onInboxUpdated } = await import("./proactiveCheckin.js");
        onInboxUpdated();
      } catch (e) {
        log(`[TMDBG PMQ] Failed to notify proactive checkin: ${e}`, "warn");
      }
    }

    if (_pending.size > 0) {
      if (needsRetry) {
        // Some items failed - wait before retrying to avoid tight loops.
        _scheduleRetrySoon("processing-incomplete");
      } else {
        // All processed items succeeded but more remain - continue immediately.
        // Use setImmediate-style scheduling to yield but not delay.
        setTimeout(() => drainProcessMessageQueue().catch(() => {}), 0);
      }
    }
  } finally {
    _isProcessing = false;
  }
}

/**
 * Cleanup timers and persist remaining queue state.
 * Call this on runtime.onSuspend to avoid leaks during hot reload.
 */
export async function cleanupProcessMessageQueue() {
  log("[TMDBG PMQ] cleanupProcessMessageQueue()");

  // Wait for any ongoing processing to complete (max 5 seconds)
  if (_isProcessing) {
    log("[TMDBG PMQ] Waiting for ongoing processing to complete before cleanup");
    let waitCount = 0;
    while (_isProcessing && waitCount < 50) {
      await new Promise((r) => setTimeout(r, 100));
      waitCount++;
    }
    if (_isProcessing) {
      log("[TMDBG PMQ] Cleanup timeout - forcing cleanup despite ongoing processing", "warn");
    }
  }

  // Clear all timers
  _clearTimer("watch");
  _clearTimer("retry");
  _clearTimer("persist");
  _clearTimer("kick");

  try {
    if (_pending.size > 0) {
      log(`[TMDBG PMQ] Persisting pending items on cleanup: ${_pending.size}`);
      await _persistNow();
    }
  } catch (_) {}

  _isProcessing = false;
  _inited = false;
}

export function getProcessMessageQueueStatus() {
  return {
    inited: _inited,
    pending: _pending.size,
    isProcessing: _isProcessing,
    hasWatchTimer: !!_watchTimer,
    hasRetryTimer: !!_retryTimer,
    hasPersistTimer: !!_persistTimer,
    hasKickTimer: !!_kickTimer,
    cfg: {
      watchIntervalMs: _watchIntervalMs(),
      kickDelayMs: _kickDelayMs(),
      persistDebounceMs: _persistDebounceMs(),
      retryDelayMs: _retryDelayMs(),
      batchSize: _batchSize(),
      maxResolveAttempts: _maxResolveAttempts(),
    },
  };
}

