/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fts/incrementalIndexer.js
// Incremental FTS indexer that listens for mail events and updates the index automatically

import { SETTINGS } from "../agent/modules/config.js";
import { logFtsBatchOperation, logFtsOperation, logMessageEventBatch, logMoveEvent } from "../agent/modules/eventLogger.js";
import {
  getForegroundFetchPressure,
  getUniqueMessageKey,
  getUniqueMessageKeyCandidates,
  log,
  parseUniqueId,
  recheckMessageInFolder,
  resolveUniqueMessageKey,
} from "../agent/modules/utils.js";
import { buildBatchHeader, populateBatchBody } from "./indexer.js";
import { makeFolderMembershipId } from "./folderMembershipIdentity.js";
import {
  _resetFtsOperationCoordinatorForTests,
  addFtsExclusiveMembershipChangeListener,
  getFtsMembershipEpoch,
  normalizeInterruptedFtsScanStatus,
  registerFtsMembershipFolders,
  tryAcquireFtsReconcileLease,
  ftsMembershipKeysUnchangedSince,
  ftsMembershipUnchangedSince,
  withFtsMembershipFence,
  runFtsMembershipRead,
} from "./operationCoordinator.js";

// Incremental indexing state
let _isEnabled = false;
let _ftsSearch = null;
let _pendingUpdates = new Map(); // uniqueKey -> { type, uniqueKey, timestamp, metadata, hasFailed }
let _batchTimer = null;
let _isProcessing = false; // Prevents concurrent processing

// Queue stability tracking - counts consecutive processing cycles with no successful dequeues
// Reset to 0 whenever anything is successfully processed (dequeued from _pendingUpdates)
let _consecutiveNoProgressCycles = 0;

// Mutex for atomic enqueue operations - prevents interleaving during async key generation
let _enqueueMutex = Promise.resolve();

// Settings  
let INCREMENTAL_BATCH_DELAY_MS = 1000; // Wait 1s before processing batch
let INCREMENTAL_BATCH_SIZE = 10; // Process up to 10 messages per batch (reduced from 50 to minimize lock time)
let INCREMENTAL_RETRY_DELAY_MS = 10000; // Default retry on error (overridden by config)

async function getIncrementalSettings() {
  const stored = await browser.storage.local.get({
    chat_ftsIncrementalEnabled: true, // ON BY DEFAULT
    chat_ftsIncrementalBatchDelay: 1000,
    chat_ftsIncrementalBatchSize: 10, // Default to 10 for better responsiveness
  });
  return {
    enabled: stored.chat_ftsIncrementalEnabled,
    batchDelay: stored.chat_ftsIncrementalBatchDelay,
    batchSize: stored.chat_ftsIncrementalBatchSize,
  };
}

async function updateIncrementalSettings() {
  const settings = await getIncrementalSettings();
  _isEnabled = settings.enabled;
  INCREMENTAL_BATCH_DELAY_MS = settings.batchDelay;
  INCREMENTAL_BATCH_SIZE = settings.batchSize;
  // Retry delay on errors is controlled via centralized config (avoid busy-loop when offline)
  try {
    const cfgRetry = Number(SETTINGS?.agentQueues?.ftsIncremental?.retryDelayMs);
    if (Number.isFinite(cfgRetry) && cfgRetry >= 0) {
      INCREMENTAL_RETRY_DELAY_MS = cfgRetry;
    }
  } catch (_) {}
  log(`[TMDBG FTS] Incremental indexing settings: enabled=${_isEnabled}, batchDelay=${INCREMENTAL_BATCH_DELAY_MS}ms, batchSize=${INCREMENTAL_BATCH_SIZE}, retryDelay=${INCREMENTAL_RETRY_DELAY_MS}ms`);
}

function scheduleBatchProcess() {
  // Debounce batch processing
  if (_batchTimer) {
    clearTimeout(_batchTimer);
  }
  _batchTimer = setTimeout(processPendingUpdates, INCREMENTAL_BATCH_DELAY_MS);
}

// NOTE: No longer using direct event listeners - integrated with existing agent listeners

/**
 * Acquire the enqueue mutex to ensure atomic operations.
 * Returns a release function that MUST be called when done.
 */
function acquireEnqueueMutex() {
  let release;
  const newMutex = new Promise((resolve) => {
    release = resolve;
  });
  const acquired = _enqueueMutex;
  _enqueueMutex = _enqueueMutex.then(() => newMutex);
  return { acquired, release };
}

// Records a walk obligation: the folder stays owed a walk until an
// enumerating proof certifies it in an attempt that started after this mark.
// The folder's session verification is invalidated once, here; a retained
// obligation is outstanding work and keeps the deferral of a failed attempt.
// Only a folder this generation knows records one: an unknown folder is not
// completed, so the scheduler walks it once an inventory lists it, and the
// obligation map stays bounded by the inventory while pressure holds the
// scheduler off.
function _markFolderReconWalk(folderKey) {
  if (!_folderReconKnownFolderKeys.has(folderKey)
      && !_folderReconSessionDone.has(folderKey)
      && !_folderReconNextWalkDueMs.has(folderKey)) {
    return;
  }
  _folderReconMarkSerial++;
  _folderReconDirty.set(folderKey, _folderReconMarkSerial);
  _folderReconSessionDone.delete(folderKey);
  if (!_folderReconDrainFailureDeferred.has(folderKey)
      && !_folderReconDrainFailureDeferred.has("__all__")) {
    _folderReconSessionDeferred.delete(folderKey);
    _folderReconFailureCounts.delete(folderKey);
  }
}

// Marks every folder this generation knows (the last inventory and every
// completed folder). A folder that appears later is not completed, so the
// scheduler walks it anyway.
function _markAllFolderReconWalks() {
  for (const folderKey of new Set([
    ..._folderReconKnownFolderKeys,
    ..._folderReconSessionDone,
    ..._folderReconNextWalkDueMs.keys(),
  ])) {
    _markFolderReconWalk(folderKey);
  }
  _folderReconSessionDone.clear();
  _folderReconSessionDeferred.clear();
  _folderReconFailureCounts.clear();
  for (const [folderKey, notBeforeMs] of _folderReconDrainFailureDeferred) {
    if (folderKey !== "__all__") _folderReconSessionDeferred.set(folderKey, notBeforeMs);
  }
  _folderReconOrphanDone = false;
  _folderReconOrphanPass = null;
}

async function _markFolderReconDirty(folderKey) {
  _folderReconOrphanDone = false;
  _folderReconOrphanPass = null;
  _markFolderReconWalk(folderKey);
  _folderReconSessionDeferred.delete(folderKey);
  _folderReconFailureCounts.delete(folderKey);
  _wakeFolderRecon("queue_backpressure", FOLDER_RECON_PRESSURE_DELAY_MS);
}

function _folderReconDrainFailureKeys(updates) {
  const folderKeys = new Set();
  for (const captured of updates || []) {
    const current = _pendingUpdates.get(captured?.uniqueKey);
    folderKeys.add(current?.folderKey || captured?.folderKey || "__all__");
  }
  if (folderKeys.has("__all__")) return new Set(["__all__"]);
  return folderKeys;
}

function _applyFolderReconDrainFailureFairness(folderKeys) {
  const normalized = new Set(folderKeys || []);
  if (normalized.size === 0) normalized.add("__all__");
  const nowMs = Date.now();
  let earliestNotBeforeMs = Infinity;

  if (normalized.has("__all__")) {
    const failureCount = (_folderReconDrainFailureCounts.get("__all__") || 0) + 1;
    const delayMs = Math.min(
      FOLDER_RECON_ERROR_DELAY_MS * (2 ** Math.min(failureCount - 1, 30)),
      FOLDER_RECON_GENERIC_FAILURE_BACKOFF_MAX_MS,
    );
    const notBeforeMs = nowMs + delayMs;
    _markAllFolderReconWalks();
    _releaseFolderReconActiveProof(null, "invalidation");
    _folderReconSessionDone.clear();
    _folderReconSessionDeferred.clear();
    _folderReconFailureCounts.clear();
    _folderReconDrainFailureDeferred.clear();
    _folderReconDrainFailureCounts.clear();
    _folderReconDrainFailureDeferred.set("__all__", notBeforeMs);
    _folderReconDrainFailureCounts.set("__all__", failureCount);
    earliestNotBeforeMs = notBeforeMs;
  } else {
    for (const folderKey of normalized) {
      const failureCount = (_folderReconDrainFailureCounts.get(folderKey) || 0) + 1;
      const delayMs = Math.min(
        FOLDER_RECON_ERROR_DELAY_MS * (2 ** Math.min(failureCount - 1, 30)),
        FOLDER_RECON_GENERIC_FAILURE_BACKOFF_MAX_MS,
      );
      const notBeforeMs = nowMs + delayMs;
      _markFolderReconWalk(folderKey);
      _releaseFolderReconActiveProof(folderKey, "invalidation");
      _folderReconSessionDeferred.set(folderKey, notBeforeMs);
      _folderReconFailureCounts.delete(folderKey);
      _folderReconDrainFailureDeferred.set(folderKey, notBeforeMs);
      _folderReconDrainFailureCounts.set(folderKey, failureCount);
      earliestNotBeforeMs = Math.min(earliestNotBeforeMs, notBeforeMs);
    }
  }
  _folderReconOrphanDone = false;
  _folderReconOrphanPass = null;
  return earliestNotBeforeMs;
}

function _folderReconDrainFailureNotBefore(folderKey) {
  return Math.max(
    _folderReconDrainFailureDeferred.get("__all__") || 0,
    _folderReconDrainFailureDeferred.get(folderKey) || 0,
  );
}

async function _deferFolderReconAfterDrainFailure(updates, reason) {
  const folderKeys = updates instanceof Set
    ? updates
    : _folderReconDrainFailureKeys(updates);
  _applyFolderReconDrainFailureFairness(folderKeys);
  // Later healthy folders are eligible immediately; the affected identity is
  // held behind its bounded deadline by scheduler selection below.
  _wakeFolderRecon(reason, FOLDER_RECON_PACE_DELAY_MS);
}

/**
 * Admit a queue entry without ever exceeding the exact live high-water mark.
 * Replacements are always safe because they do not grow the map. A rejected
 * new intention is represented by its folder's walk obligation and will be
 * rediscovered from Thunderbird headers after the drain recedes.
 * Caller must hold _enqueueMutex.
 */
async function _tryAdmitPendingUpdate(uniqueKey, update, folderKey = null) {
  // Admitted or rejected, a newer intention for this key must withhold a
  // removal of it that was classified before.
  _noteFolderReconLocalKey(uniqueKey);
  const existing = _pendingUpdates.has(uniqueKey);
  if (!existing && _pendingUpdates.size >= FOLDER_RECON_PENDING_HIGH_WATER) {
    // A message that names no folder marks nothing; like a folder-less
    // event, it is left to the rolling walk, the state pass and the next
    // startup.
    if (folderKey) await _markFolderReconDirty(folderKey);
    log(`[TMDBG FTS] Queue high-water (${FOLDER_RECON_PENDING_HIGH_WATER}) reached; deferred ${uniqueKey} to exact folder reconcile`, "warn");
    return false;
  }
  _pendingUpdates.set(uniqueKey, {
    ...update,
    folderKey: folderKey || update.folderKey || null,
  });
  _noteFolderReconPendingSize();
  return true;
}

/**
 * Queue a message for incremental processing.
 * Uses mutex to ensure atomic enqueue - prevents race conditions when
 * multiple events arrive simultaneously and trigger async key generation.
 */
async function queueMessageUpdate(type, messageHeader) {
  if (!_isEnabled || !_ftsSearch) return;
  
  // Acquire mutex to prevent interleaving during async operations
  const { acquired, release } = acquireEnqueueMutex();
  
  try {
    // Wait for previous enqueue operations to complete
    await acquired;
    
    const timestamp = Date.now();
    
    // Generate stable unique key immediately (survives restarts)
    const uniqueKey = await getUniqueMessageKey(messageHeader);
    
    if (!uniqueKey) {
      log(`[TMDBG FTS] Failed to generate unique key for message ${messageHeader.id}, skipping`, "warn");
      logFtsOperation("enqueue", "failure", {
        reason: "no_unique_key",
        weId: messageHeader.id,
        headerMessageId: messageHeader.headerMessageId,
        subject: messageHeader.subject,
      });
      return;
    }
    
    // Check if we already have a pending update for this key
    const existing = _pendingUpdates.get(uniqueKey);
    if (existing) {
      // Log the overwrite for debugging batch notification issues
      log(`[TMDBG FTS] Queue update: ${uniqueKey} already queued (type=${existing.type}→${type}, age=${timestamp - existing.timestamp}ms, failed=${existing.hasFailed || false})`);
    }
    
    // Update or add to pending updates (latest event wins)
    // Preserve failure state if re-queuing an existing entry
    const folderKey = messageHeader.folder?.accountId && messageHeader.folder?.path
      ? `${messageHeader.folder.accountId}:${messageHeader.folder.path}`
      : null;
    const admitted = await _tryAdmitPendingUpdate(uniqueKey, {
      type, 
      uniqueKey, 
      timestamp,
      folderKey,
      // Preserve failure tracking from existing entry, or initialize
      hasFailed: existing?.hasFailed || false,
      lastFailedAt: existing?.lastFailedAt || 0,
      metadata: {
        subject: messageHeader.subject,
        folderName: messageHeader.folder?.name
      }
    }, folderKey);
    if (!admitted) return;
    
    log(`[TMDBG FTS] Queued ${type} for message ${uniqueKey}: "${(messageHeader.subject || '').slice(0, 40)}" (queue size: ${_pendingUpdates.size})`);
    
    // Log enqueue to event logger for full traceability
    logFtsOperation("enqueue", "success", {
      type,
      uniqueKey,
      headerMessageId: messageHeader.headerMessageId,
      weId: messageHeader.id,
      folderPath: messageHeader.folder?.path,
      subject: messageHeader.subject,
      queueSize: _pendingUpdates.size,
      wasRequeued: !!existing,
    });
    
    // Restart batch timer
    if (_batchTimer) {
      clearTimeout(_batchTimer);
    }
    
    _batchTimer = setTimeout(processPendingUpdates, INCREMENTAL_BATCH_DELAY_MS);
  } finally {
    // Always release the mutex
    release();
  }
}

// Get retry configuration from SETTINGS
function _getRetryConfig() {
  const cfg = SETTINGS?.agentQueues?.ftsIncremental || {};
  return {
    maxConsecutiveNoProgress: typeof cfg.maxConsecutiveNoProgress === 'number' ? cfg.maxConsecutiveNoProgress : 20,
    retryDelayMs: typeof cfg.retryDelayMs === 'number' ? cfg.retryDelayMs : 10000,
  };
}

/**
 * Check if failed updates should be dropped based on queue stability.
 * Returns true if we've had maxConsecutiveNoProgress cycles with no successful dequeues.
 * Only applies to entries that have failed at least once (hasFailed=true).
 */
function _shouldDropFailedUpdates() {
  const cfg = _getRetryConfig();
  return _consecutiveNoProgressCycles >= cfg.maxConsecutiveNoProgress;
}

// The drain captured `update` before an await; it is still the queued
// intention only while the queue holds that very entry. Every admission
// stores a new entry object, so a newer intention queued meanwhile (even one
// of the same type in the same millisecond) or an abandonment is never
// overwritten or dequeued by the drain's bookkeeping. Retry metadata is
// therefore updated in place, never by replacing the entry.
function _isQueuedIntention(update) {
  return _pendingUpdates.get(update.uniqueKey) === update;
}

/**
 * Mark an update as having failed resolution.
 * Sets hasFailed=true so it can be dropped if queue is stuck.
 */
function _markResolveFailed(update) {
  if (!_isQueuedIntention(update)) return;
  update.hasFailed = true;
  update.lastFailedAt = Date.now();
}

/**
 * Reset the no-progress counter (called when anything is successfully dequeued)
 */
function _resetNoProgressCounter() {
  if (_consecutiveNoProgressCycles > 0) {
    log(`[TMDBG FTS] Queue made progress - resetting no-progress counter (was ${_consecutiveNoProgressCycles})`);
    _consecutiveNoProgressCycles = 0;
  }
}

/**
 * Increment the no-progress counter (called when a cycle completes with no dequeues)
 */
function _incrementNoProgressCounter() {
  _consecutiveNoProgressCycles++;
  const cfg = _getRetryConfig();
  log(`[TMDBG FTS] No progress this cycle - counter now ${_consecutiveNoProgressCycles}/${cfg.maxConsecutiveNoProgress}`);
}

/**
 * Atomically convert destructive queue abandonment into reconcile work: the
 * affected folders are dirtied and reconciliation marked pending before any
 * entry is dropped. Only the captured entry itself may be deleted;
 * replacements and requeues survive.
 */
async function _abandonPendingUpdates(capturedUpdates, reason = "abandoned") {
  const { acquired, release } = acquireEnqueueMutex();
  try {
    await acquired;
    const matching = [];
    const folderKeys = new Set();
    for (const captured of capturedUpdates || []) {
      const current = _pendingUpdates.get(captured?.uniqueKey);
      if (!current || current !== captured) continue;
      matching.push(captured);
      folderKeys.add(current.folderKey || captured.folderKey || "__all__");
    }
    if (matching.length === 0) {
      return { dropped: 0, retained: (capturedUpdates || []).length };
    }
    for (const folderKey of folderKeys) {
      if (folderKey === "__all__") _markAllFolderReconWalks();
      else _markFolderReconWalk(folderKey);
    }
    _folderReconOrphanDone = false;
    _folderReconOrphanPass = null;

    let dropped = 0;
    for (const captured of matching) {
      if (_pendingUpdates.get(captured.uniqueKey) !== captured) continue;
      _pendingUpdates.delete(captured.uniqueKey);
      dropped++;
      logFtsOperation("drop", reason, { uniqueKey: captured.uniqueKey });
    }
    if (dropped > 0) {
      await _deferFolderReconAfterDrainFailure(folderKeys, "queue_abandonment");
    }
    return { dropped, retained: (capturedUpdates || []).length - dropped };
  } finally {
    release();
  }
}

// Process batched updates
async function processPendingUpdates() {
  if (!_isEnabled || !_ftsSearch || _pendingUpdates.size === 0) return;
  
  // Prevent concurrent processing
  if (_isProcessing) {
    log(`[TMDBG FTS] Processing already in progress, skipping concurrent call`);
    return;
  }
  
  _isProcessing = true;
  log(`[TMDBG FTS] Processing ${_pendingUpdates.size} pending incremental updates`);
  
  // Log processing cycle start
  logFtsBatchOperation("process_cycle", "start", {
    queueSize: _pendingUpdates.size,
    batchSize: INCREMENTAL_BATCH_SIZE,
    noProgressCycles: _consecutiveNoProgressCycles,
  });
  
  const updates = Array.from(_pendingUpdates.values())
    .sort((a, b) => a.timestamp - b.timestamp) // Process in chronological order
    .slice(0, INCREMENTAL_BATCH_SIZE); // Limit batch size
  
  // Capture the intentions at start of processing - used to detect re-queued entries during dequeue
  // This prevents accidentally deleting a newer entry that was queued while we were processing
  const snapshotUpdates = new Map();
  for (const update of updates) {
    snapshotUpdates.set(update.uniqueKey, update);
  }
  
  let hadError = false;
  try {
    const processedKeys = new Set();
    const abandonedUpdates = [];

    // Group by operation type
    const toIndexUpdates = updates.filter(u => u.type === 'new' || u.type === 'moved');
    const toDeleteUpdates = updates.filter(u => u.type === 'deleted');
    
    // Process deletions first - use unique keys directly. A delete event whose
    // folder info was stale leaves the real row behind; that folder's next
    // walk removes it (its rolling re-walk in exact mode, otherwise the next
    // session). A scoped negative is not deletion
    // evidence, so the drain never deletes a sibling key.
    if (toDeleteUpdates.length > 0) {
      const toDeleteUniqueKeys = toDeleteUpdates.map(u => u.uniqueKey);
      const removeResult = await _ftsSearch.removeBatch(toDeleteUniqueKeys);
      const removedCount = removeResult.count || 0;
      const missedCount = toDeleteUniqueKeys.length - removedCount;

      // Log removeBatch result
      logFtsBatchOperation("delete", "complete", {
        total: toDeleteUniqueKeys.length,
        removedCount,
        missedCount,
      });

      if (missedCount > 0) {
        log(`[TMDBG FTS] Removed ${removedCount}/${toDeleteUniqueKeys.length} messages - ${missedCount} were not indexed under the event's key`);
      } else {
        log(`[TMDBG FTS] Removed ${removedCount} messages from index`);
      }

      let verifiedDeletes = 0;
      let deleteVerifyFailed = 0;
      for (const key of toDeleteUniqueKeys) {
        try {
          const ftsEntry = await _ftsSearch.getMessageByMsgId(key);
          if (!ftsEntry || ftsEntry.msgId !== key) {
            processedKeys.add(key);
            verifiedDeletes++;
            logFtsOperation("verify_delete", "success", { uniqueKey: key });
          } else {
            // Still exists in FTS - deletion failed, keep in queue
            log(`[TMDBG FTS] DELETE VERIFY FAILED: ${key} still in FTS after removeBatch (will retry)`, "warn");
            logFtsOperation("verify_delete", "failure", {
              uniqueKey: key,
              reason: "still_in_fts",
            });
            deleteVerifyFailed++;
          }
        } catch (verifyErr) {
          // Verification error - be conservative, keep in queue for retry
          // If native FTS disconnected, we can't confirm the delete succeeded
          log(`[TMDBG FTS] DELETE VERIFY ERROR for ${key}: ${verifyErr} (will retry)`, "warn");
          logFtsOperation("verify_delete", "failure", {
            uniqueKey: key,
            reason: "verify_error",
            error: String(verifyErr),
          });
          deleteVerifyFailed++;
        }
      }
      
      // Log delete verification summary
      logFtsBatchOperation("verify_delete", "complete", {
        total: toDeleteUniqueKeys.length,
        successCount: verifiedDeletes,
        failCount: deleteVerifyFailed,
      });

      if (deleteVerifyFailed > 0) {
        log(`[TMDBG FTS] Delete verification: ${deleteVerifyFailed} still present (retained in queue)`);
      }
    }
    
    // Process additions/updates - resolve uniqueKeys to MessageHeaders
    if (toIndexUpdates.length > 0) {
      log(`[TMDBG FTS] Resolving ${toIndexUpdates.length} messages to index from uniqueKeys`);
      
      const resolvedEntries = [];
      let retriedCount = 0;
      let droppedCount = 0;
      
      for (const update of toIndexUpdates) {
        try {
          const firstBoundary = update.uniqueKey.indexOf(":");
          if (firstBoundary <= 0
              || update.uniqueKey.indexOf(":", firstBoundary + 1) < 0
              || update.uniqueKey.endsWith(":")) {
            // Unparseable key is a permanent failure - drop immediately
            log(`[TMDBG FTS] Structurally invalid uniqueKey: ${update.uniqueKey} - dropping`, "warn");
            logFtsOperation("resolve", "failure", {
              uniqueKey: update.uniqueKey,
              reason: "unparseable_key",
              subject: update.metadata?.subject,
            });
            abandonedUpdates.push(update);
            droppedCount++;
            continue;
          }
          
          // Re-resolve headerMessageId -> current weId at processing time
          // This handles weId instability during IMAP sync - if it fails, we retry
          let resolved = null;
          try {
            resolved = await resolveUniqueMessageKey(update.uniqueKey);
          } catch (resolveError) {
            log(`[TMDBG FTS] Error resolving structured key ${update.uniqueKey}: ${resolveError}`, "warn");
          }
          const weID = resolved?.weID || null;
          const headerID = resolved?.headerID || "";
          if (!weID) {
            // Resolution failed - mark for retry (weId may stabilize on next attempt)
            _markResolveFailed(update);
            log(`[TMDBG FTS] Failed to resolve uniqueKey to one live message - marked for retry`);
            logFtsOperation("resolve", "failure", {
              uniqueKey: update.uniqueKey,
              headerMessageId: headerID,
              reason: "headerID_to_weId_failed",
              hasFailed: true,
              subject: update.metadata?.subject,
            });
            retriedCount++;
            continue;
          }
          
          // Fetch current header using resolved weId
          let messageHeader = null;
          try {
            messageHeader = await browser.messages.get(weID);
          } catch (fetchError) {
            log(`[TMDBG FTS] Error fetching header for weID ${weID}: ${fetchError}`, "warn");
          }
          
          if (messageHeader) {
            // Success - clear failed flag since we resolved successfully
            const wasRetried = update.hasFailed;
            if (update.hasFailed && _isQueuedIntention(update)) {
              update.hasFailed = false;
              update.lastFailedAt = 0;
            }
            resolvedEntries.push({ update, messageHeader });
            logFtsOperation("resolve", "success", {
              uniqueKey: update.uniqueKey,
              headerMessageId: headerID,
              weId: weID,
              currentFolder: messageHeader.folder?.path,
              subject: messageHeader.subject,
              wasRetried,
            });
          } else {
            // Fetch failed - weId may have changed again, retry
            _markResolveFailed(update);
            log(`[TMDBG FTS] Failed to fetch header for weID ${weID} (may have changed) - marked for retry`);
            logFtsOperation("resolve", "failure", {
              uniqueKey: update.uniqueKey,
              headerMessageId: headerID,
              weId: weID,
              reason: "fetch_header_failed",
              hasFailed: true,
              subject: update.metadata?.subject,
            });
            retriedCount++;
          }
        } catch (e) {
          // General error - mark as failed, will be dropped when queue is stuck
          log(`[TMDBG FTS] Error resolving update ${update.uniqueKey}: ${e}`, "warn");
          logFtsOperation("resolve", "failure", {
            uniqueKey: update.uniqueKey,
            reason: "exception",
            error: String(e),
            subject: update.metadata?.subject,
          });
          _markResolveFailed(update);
          retriedCount++;
        }
      }
      
      // Log retry summary
      if (retriedCount > 0 || droppedCount > 0) {
        log(`[TMDBG FTS] Resolution summary: ${resolvedEntries.length} resolved, ${retriedCount} marked for retry, ${droppedCount} dropped (unparseable)`);
      }
      
      // Log resolution batch summary
      logFtsBatchOperation("resolve", "complete", {
        total: toIndexUpdates.length,
        successCount: resolvedEntries.length,
        retryCount: retriedCount,
        dropCount: droppedCount,
      });
      
      if (resolvedEntries.length > 0) {
        // Step 1: Build header-only batch (no expensive body extraction)
        const headerBatch = await buildBatchHeader(resolvedEntries.map(entry => entry.messageHeader));
        if (headerBatch.length > 0) {
          // Build mapping: row.msgId (recomputed) -> update.uniqueKey (original queued key)
          // This ensures we delete from _pendingUpdates using the correct key
          const msgIdToQueuedKey = new Map();
          for (const entry of resolvedEntries) {
            const computedMsgId = await getUniqueMessageKey(entry.messageHeader);
            if (computedMsgId) {
              const computedKey = String(computedMsgId);
              msgIdToQueuedKey.set(computedKey, entry.update.uniqueKey);
              // Log key mismatches for debugging
              if (computedKey !== entry.update.uniqueKey) {
                log(`[TMDBG FTS] Key mismatch: msgId='${computedKey}' vs queuedKey='${entry.update.uniqueKey}'`);
              }
            }
          }
          
          // Step 2: Filter to find messages that need indexing. The
          // "already indexed" decision runs under the membership mutex: a
          // reconciliation removal in flight would otherwise let this read see
          // a row that is about to be deleted and dequeue the add for good.
          const batchKeys = headerBatch.map(row => row.msgId);
          let newMsgIds = [];
          let alreadyIndexedKeys = [];
          let verifiedExisting = 0;
          let existingVerifyFailed = 0;
          await runFtsMembershipRead(async () => {
            const filterResult = await _ftsSearch.filterNewMessages(headerBatch);
            newMsgIds = filterResult.newMsgIds || [];

            // Log filterNewMessages results
            logFtsBatchOperation("filter", "complete", {
              total: headerBatch.length,
              newCount: newMsgIds.length,
              existingCount: headerBatch.length - newMsgIds.length,
          });
          
          // Messages reported as already indexed - VERIFY they actually exist in FTS
          // This catches cases where filterNewMessages incorrectly reports messages as indexed
          alreadyIndexedKeys = batchKeys.filter(key => !newMsgIds.includes(key));
          
          for (const key of alreadyIndexedKeys) {
            try {
              const ftsEntry = await _ftsSearch.getMessageByMsgId(key);
              if (ftsEntry && ftsEntry.msgId === key) {
                // Actually exists in FTS - safe to dequeue
                processedKeys.add(msgIdToQueuedKey.get(key) || key);
                verifiedExisting++;
                logFtsOperation("verify_existing", "success", {
                  uniqueKey: msgIdToQueuedKey.get(key) || key,
                  msgId: key,
                });
              } else {
                // filterNewMessages said it exists but it doesn't - need to index
                // Add to newMsgIds for processing
                log(`[TMDBG FTS] EXISTING VERIFY FAILED: ${key} not actually in FTS (filterNewMessages said it was)`, "warn");
                logFtsOperation("verify_existing", "failure", {
                  uniqueKey: msgIdToQueuedKey.get(key) || key,
                  msgId: key,
                  reason: "not_in_fts",
                });
                newMsgIds.push(key);
                existingVerifyFailed++;
              }
            } catch (verifyErr) {
              // Verification error - be conservative, try to index it
              log(`[TMDBG FTS] EXISTING VERIFY ERROR for ${key}: ${verifyErr} (will try to index)`, "warn");
              logFtsOperation("verify_existing", "failure", {
                uniqueKey: msgIdToQueuedKey.get(key) || key,
                msgId: key,
                reason: "verify_error",
                error: String(verifyErr),
              });
              newMsgIds.push(key);
              existingVerifyFailed++;
            }
          }
          });
          
          if (existingVerifyFailed > 0) {
            log(`[TMDBG FTS] Existing verification: ${verifiedExisting}/${alreadyIndexedKeys.length} confirmed in FTS, ${existingVerifyFailed} need indexing`);
          }
          
          if (newMsgIds.length > 0) {
            // Step 3: Create filtered batch with only messages that need indexing
            // Note: newMsgIds may include messages added during verification that weren't initially flagged
            const newFilteredBatch = headerBatch.filter(row => newMsgIds.includes(row.msgId));
            log(`[TMDBG FTS] Preparing to index ${newFilteredBatch.length} messages`);
            
            // Step 4: Extract body text for the filtered messages
            const { successfulRows, failedMsgIds } = await populateBatchBody(newFilteredBatch);
            
            // Step 5: Mark failed body-extraction messages for retry (NOT dequeue)
            // Body extraction can fail transiently (IMAP timeout, network blip, server busy).
            // Dequeuing on failure would silently drop messages from the index permanently.
            // Instead, mark as failed — the queue-stuck detection will drop them after
            // enough no-progress cycles if they're truly unrecoverable.
            if (failedMsgIds.length > 0) {
              log(`[TMDBG FTS] Body extraction failed for ${failedMsgIds.length} messages - marking for retry`);
              for (const key of failedMsgIds) {
                const queuedKey = msgIdToQueuedKey.get(key) || key;
                // The entry this drain captured: a newer intention queued
                // during extraction is left alone.
                const captured = snapshotUpdates.get(queuedKey);
                if (captured) {
                  _markResolveFailed(captured);
                }
                logFtsOperation("body_extract", "failure", {
                  uniqueKey: queuedKey,
                  msgId: key,
                  reason: "body_extraction_failed",
                  hasFailed: true,
                });
              }
            }
            
            // Step 6: Index the successful messages
            if (successfulRows.length > 0) {
              const result = await _ftsSearch.indexBatch(successfulRows);
              log(`[TMDBG FTS] Incrementally indexed ${result.count} new messages, ${headerBatch.length - newMsgIds.length} already up-to-date, ${failedMsgIds.length} failed`);
              
              // Log indexBatch result
              logFtsBatchOperation("index", "complete", {
                indexedCount: result.count,
                attemptedCount: successfulRows.length,
                bodyFailCount: failedMsgIds.length,
              });
              
              // Step 7: VERIFY entries exist in FTS before marking as processed
              // This prevents dequeuing updates that didn't actually commit to FTS
              let verifiedCount = 0;
              let verifyFailedCount = 0;
              for (const row of successfulRows) {
                try {
                  const ftsEntry = await _ftsSearch.getMessageByMsgId(row.msgId);
                  if (ftsEntry && ftsEntry.msgId === row.msgId) {
                    // Verified - safe to dequeue
                    processedKeys.add(msgIdToQueuedKey.get(row.msgId) || row.msgId);
                    verifiedCount++;
                    logFtsOperation("verify_indexed", "success", {
                      uniqueKey: msgIdToQueuedKey.get(row.msgId) || row.msgId,
                      msgId: row.msgId,
                    });
                  } else {
                    // FTS entry not found or mismatched - keep in queue for retry
                    log(`[TMDBG FTS] VERIFY FAILED: message ${row.msgId} not found in FTS after indexBatch (will retry)`, "warn");
                    logFtsOperation("verify_indexed", "failure", {
                      uniqueKey: msgIdToQueuedKey.get(row.msgId) || row.msgId,
                      msgId: row.msgId,
                      reason: "not_in_fts_after_index",
                    });
                    verifyFailedCount++;
                  }
                } catch (verifyErr) {
                  // Verification query failed - assume not indexed, keep in queue
                  log(`[TMDBG FTS] VERIFY ERROR for ${row.msgId}: ${verifyErr} (will retry)`, "warn");
                  logFtsOperation("verify_indexed", "failure", {
                    uniqueKey: msgIdToQueuedKey.get(row.msgId) || row.msgId,
                    msgId: row.msgId,
                    reason: "verify_error",
                    error: String(verifyErr),
                  });
                  verifyFailedCount++;
                }
              }
              
              // Log verification batch summary
              logFtsBatchOperation("verify_indexed", "complete", {
                total: successfulRows.length,
                successCount: verifiedCount,
                failCount: verifyFailedCount,
              });
              
              if (verifyFailedCount > 0) {
                log(`[TMDBG FTS] Verification: ${verifiedCount}/${successfulRows.length} confirmed in FTS, ${verifyFailedCount} failed (retained in queue)`);
              } else {
                log(`[TMDBG FTS] Verification: all ${verifiedCount} messages confirmed in FTS`);
              }
            } else {
              log(`[TMDBG FTS] No successful incremental messages to index (all ${newFilteredBatch.length} failed)`);
              logFtsBatchOperation("index", "skip", {
                reason: "all_body_extraction_failed",
                failCount: newFilteredBatch.length,
              });
            }
          } else {
            log(`[TMDBG FTS] All ${headerBatch.length} incremental messages already indexed`);
          }
        } else {
          // A resolved header that produces no indexable header row is not a
          // verified success. Convert the exact captured intentions to durable
          // reconcile work before dropping them.
          abandonedUpdates.push(...resolvedEntries.map(entry => entry.update));
        }
      } else {
        log(`[TMDBG FTS] No messages resolved from ${toIndexUpdates.length} uniqueKeys (may have been deleted)`);
      }
    }
    
    if (abandonedUpdates.length > 0) {
      await _abandonPendingUpdates(abandonedUpdates, "unindexable");
    }

    // Processing successful - remove verified updates from map
    // IMPORTANT: Only delete if the queued intention (type + timestamp) is the one we processed
    // This prevents deleting entries that were re-queued during processing
    let processedCount = 0;
    let reQueuedCount = 0;
    for (const key of processedKeys) {
      const current = _pendingUpdates.get(key);
      if (!current) {
        // Already deleted (shouldn't happen, but safe to skip)
        continue;
      }
      
      const snapshot = snapshotUpdates.get(key);
      const snapshotTs = snapshot.timestamp;
      if (_isQueuedIntention(snapshot)) {
        // Still the queued intention - safe to delete, this is the entry we processed
        _pendingUpdates.delete(key);
        processedCount++;
        logFtsOperation("dequeue", "success", {
          uniqueKey: key,
          subject: current.metadata?.subject,
        });
      } else {
        // Entry was re-queued during processing - keep the newer entry
        log(`[TMDBG FTS] Keeping re-queued entry: ${key} (processed ts=${snapshotTs}, current ts=${current.timestamp}, delta=${current.timestamp - snapshotTs}ms)`);
        logFtsOperation("dequeue", "skip", {
          uniqueKey: key,
          reason: "requeued_during_processing",
          deltaMs: current.timestamp - snapshotTs,
        });
        reQueuedCount++;
      }
    }
    
    if (reQueuedCount > 0) {
      log(`[TMDBG FTS] Processed ${processedCount} updates, ${reQueuedCount} were re-queued during processing, ${_pendingUpdates.size} remaining`);
    } else {
      log(`[TMDBG FTS] Successfully processed ${processedCount} updates, ${_pendingUpdates.size} remaining`);
    }
    
    // Log processing cycle end
    logFtsBatchOperation("process_cycle", "complete", {
      processedCount,
      reQueuedCount,
      remainingQueueSize: _pendingUpdates.size,
    });
    
    // Update queue stability tracking
    if (processedCount > 0) {
      // Made progress - reset the no-progress counter
      _resetNoProgressCounter();
      logFtsOperation("queue_stability", "progress", {
        resetNoProgressCounter: true,
        processedCount,
      });
    } else if (_pendingUpdates.size > 0) {
      // No progress but queue not empty - increment counter
      _incrementNoProgressCounter();
      
      logFtsOperation("queue_stability", "no_progress", {
        noProgressCycles: _consecutiveNoProgressCycles,
        maxNoProgress: _getRetryConfig().maxConsecutiveNoProgress,
        queueSize: _pendingUpdates.size,
      });
      
      // If queue is stuck, drop entries that have failed
      if (_shouldDropFailedUpdates()) {
        const cfg = _getRetryConfig();
        log(`[TMDBG FTS] Queue stuck for ${_consecutiveNoProgressCycles} cycles - dropping failed entries`, "warn");
        
        const stuckEntries = [..._pendingUpdates.values()].filter(entry => entry.hasFailed);
        for (const entry of stuckEntries) {
          log(`[TMDBG FTS] Dropping stuck entry: ${entry.uniqueKey}`, "warn");
        }
        const { dropped: droppedStuckCount } = await _abandonPendingUpdates(
          stuckEntries,
          "queue_stuck",
        );
        
        if (droppedStuckCount > 0) {
          log(`[TMDBG FTS] Dropped ${droppedStuckCount} stuck entries, ${_pendingUpdates.size} remaining`);
          logFtsBatchOperation("drop_stuck", "complete", {
            droppedCount: droppedStuckCount,
            remainingQueueSize: _pendingUpdates.size,
          });
          // Reset counter after cleanup so we don't immediately drop new entries
          _consecutiveNoProgressCycles = 0;
        }
      }
    }
    
  } catch (e) {
    hadError = true;
    log(`[TMDBG FTS] Incremental indexing failed: ${e}`, "error");
    log(`[TMDBG FTS] Updates retained in queue for retry: ${updates.length}`, "warn");
    logFtsBatchOperation("process_cycle", "error", {
      error: String(e),
      retainedCount: updates.length,
    });
    await _deferFolderReconAfterDrainFailure(updates, "drain_error");
    // Don't delete from map - will retry on next batch
    // Don't count as no-progress since we had an error (not a stable state)
  }
  
  if (_pendingUpdates.size === 0) {
    // Drain is empty: folders the boot folder-reconcile skipped as
    // drain-busy can now be re-checked (single-shot per boot; async —
    // must not block the drain loop's tail). PLAN_FOLDER_SET_RECONCILE.md.
    _maybeScheduleFolderReconRerun();
  }

  if (_pendingUpdates.size <= FOLDER_RECON_PENDING_LOW_WATER) {
    _wakeFolderRecon("drain_low_water", FOLDER_RECON_PACE_DELAY_MS);
  }
  
  // Release processing lock BEFORE scheduling next batch
  _isProcessing = false;
  
  // Schedule next batch if there are more updates
  if (_pendingUpdates.size > 0) {
    // Yield to allow user queries to proceed before processing next batch.
    // On errors (e.g., offline/native disconnect), slow down retries to avoid tight loops.
    const nextDelay = hadError ? INCREMENTAL_RETRY_DELAY_MS : INCREMENTAL_BATCH_DELAY_MS;
    const mode = hadError ? "retry" : "batch";
    log(`[TMDBG FTS] Scheduling next ${mode} run in ${nextDelay}ms (${_pendingUpdates.size} updates remaining)`);
    _batchTimer = setTimeout(processPendingUpdates, nextDelay);
  }
}


// Gmail virtual folder detection - when a message arrives, it may also appear in
// Gmail special folders (Important, Starred, etc.) that should also be indexed
async function checkGmailVirtualFolders(messageHeader) {
  try {
    const accountId = messageHeader?.folder?.accountId;
    if (!accountId) return;
    
    const headerMessageId = messageHeader?.headerMessageId;
    if (!headerMessageId) return;
    
    // Only check for Gmail accounts (accounts with [Gmail] folder structure)
    const accounts = await browser.accounts.list();
    const account = accounts.find(a => a.id === accountId);
    if (!account?.rootFolder) return;
    
    // Check if this is a Gmail account by looking for [Gmail] folder
    const subFolders = await browser.folders.getSubFolders(account.rootFolder.id, false);
    const gmailFolder = subFolders.find(f => f.name === '[Gmail]');
    if (!gmailFolder) return; // Not a Gmail account
    
    // Get Gmail virtual folders (Important, Starred, etc.)
    const gmailSubFolders = await browser.folders.getSubFolders(gmailFolder.id, false);
    const virtualFolders = gmailSubFolders.filter(f => 
      ['Important', 'Starred'].includes(f.name)
    );
    
    // Check if this message appears in any of these virtual folders
    for (const vFolder of virtualFolders) {
      try {
        const query = await browser.messages.query({
          folderId: [vFolder.id],
          headerMessageId: headerMessageId
        });
        
        if (query?.messages?.length > 0) {
          // Message exists in this virtual folder - queue it for indexing
          const vMsg = query.messages[0];
          log(`[TMDBG FTS] Gmail virtual folder detection: message also in ${vFolder.name}`);
          queueMessageUpdate('new', vMsg).catch(e => {
            log(`[TMDBG FTS] Failed to queue Gmail virtual folder message: ${e}`, "warn");
          });
        }
      } catch (eQuery) {
        // Folder query failed - not critical
      }
    }
  } catch (e) {
    // Gmail detection failed - not critical, maintenance will catch these
    log(`[TMDBG FTS] Gmail virtual folder check failed: ${e}`, "info");
  }
}

// Event handlers - exported so agent listeners can call them
export function onNewMailReceived(folder, messageHeaders) {
  // Log to persistent storage IMMEDIATELY for debugging (before isEnabled check)
  logMessageEventBatch("fts:onNewMailReceived", "ftsIndexer", folder, messageHeaders);
  
  if (!_isEnabled) return;
  
  log(`[TMDBG FTS] New mail received in ${folder.name}: ${messageHeaders.length} messages`);
  
  for (const msg of messageHeaders) {
    queueMessageUpdate('new', msg).catch(e => {
      log(`[TMDBG FTS] Failed to queue new message: ${e}`, "warn");
    });
    
    // For Gmail accounts, also check virtual folders (Important, Starred)
    // This catches messages that get labeled by Gmail filters
    checkGmailVirtualFolders(msg).catch(e => {
      log(`[TMDBG FTS] Gmail virtual folder check failed: ${e}`, "info");
    });
  }
}

export function onMessageMoved(originalMessage, movedMessage) {
  // Log to persistent storage IMMEDIATELY for debugging (before isEnabled check)
  logMoveEvent("fts:onMessageMoved", "ftsIndexer", originalMessage?.folder, [movedMessage], movedMessage?.folder);
  
  if (!_isEnabled) return;
  
  log(`[TMDBG FTS] Message moved: ${originalMessage.id} -> ${movedMessage.id} to folder ${movedMessage.folder?.name}`);
  
  // Remove old location and index new location
  queueMessageUpdate('deleted', originalMessage).catch(e => {
    log(`[TMDBG FTS] Failed to queue deleted message for move: ${e}`, "warn");
  });
  queueMessageUpdate('moved', movedMessage).catch(e => {
    log(`[TMDBG FTS] Failed to queue moved message: ${e}`, "warn");
  });
}

export function onMessageDeleted(folder, messageHeaders) {
  // Log to persistent storage IMMEDIATELY for debugging (before isEnabled check)
  logMoveEvent("fts:onMessageDeleted", "ftsIndexer", folder, messageHeaders);
  
  if (!_isEnabled) return;
  
  // Handle case where folder might be undefined (common in onDeleted events)
  // Try to get folder info from the first message header if available
  const folderName = folder?.name || messageHeaders[0]?.folder?.name || 'unknown folder';
  log(`[TMDBG FTS] Messages deleted from ${folderName}: ${messageHeaders.length} messages`);
  
  for (const msg of messageHeaders) {
    queueMessageUpdate('deleted', msg).catch(e => {
      log(`[TMDBG FTS] Failed to queue deleted message: ${e}`, "warn");
    });
  }
}

export function onMessageCopied(originalMessage, copiedMessage) {
  // Log to persistent storage IMMEDIATELY for debugging (before isEnabled check)
  logMoveEvent("fts:onMessageCopied", "ftsIndexer", originalMessage?.folder, [copiedMessage], copiedMessage?.folder);
  
  if (!_isEnabled) return;
  
  log(`[TMDBG FTS] Message copied: ${originalMessage.id} -> ${copiedMessage.id} to folder ${copiedMessage.folder?.name}`);
  
  // Index the new copy
  queueMessageUpdate('new', copiedMessage).catch(e => {
    log(`[TMDBG FTS] Failed to queue copied message: ${e}`, "warn");
  });
}

/**
 * Handle message property updates - primarily for Gmail label detection.
 * When Gmail adds a label to an existing message, the message may now appear
 * in additional virtual folders (Important, Starred) that need indexing.
 * 
 * @param {Object} message - The updated message header
 * @param {Object} changedProperties - What changed
 */
export function onMessageUpdated(message, changedProperties) {
  if (!_isEnabled) return;
  
  // We're interested in changes that might indicate Gmail label additions
  // Unfortunately, TB doesn't directly expose label changes, but we can 
  // check virtual folders when any property changes on Gmail messages
  
  // Only process if this might be a Gmail account (check for [Gmail] in folder path)
  const folderPath = message?.folder?.path || '';
  if (!folderPath.includes('[Gmail]') && !folderPath.includes('/INBOX')) {
    return; // Not a Gmail-related folder
  }
  
  // Check if this message now appears in Gmail virtual folders
  checkGmailVirtualFolders(message).catch(e => {
    log(`[TMDBG FTS] Gmail virtual folder check on update failed: ${e}`, "info");
  });
}

/**
 * Handle message added event from experiment API (nsIMsgFolderNotificationService).
 * This provides reliable notifications for all message additions including:
 * - New mail arrival (msgAdded)
 * - Filter classification (msgsClassified)
 * - Move/copy completion (msgsMoveCopyCompleted)
 * 
 * Uses mutex to ensure atomic enqueue with other concurrent events.
 * 
 * @param {Object} messageInfo - Serialized message info from experiment
 */
export async function onExperimentMessageAdded(messageInfo) {
  if (!_isEnabled) return;

  // Track sync event for reconcile quiet-period detection
  _lastSyncEventMs = Date.now();
  _invalidateFolderReconProofForMessageEvent(messageInfo);

  // Track the highest msgKey seen per folder this session — the heartbeat
  // merges these into the persistent folder cursors (ADR-020). Only
  // delivered events advance this, so unevented arrivals stay above the
  // cursor and are caught by the next boot's cursor scan.
  _noteSessionMaxKey(messageInfo);

  log(`[TMDBG FTS] Experiment msgAdded: type=${messageInfo.eventType}, folder=${messageInfo.folderPath}, subject="${messageInfo.subject?.substring(0, 50)}"`);

  let queued = false;
  try {
    queued = await _enqueueNewFromInfo(messageInfo);
  } finally {
    // An event whose change was not queued owes its folder a walk. One that
    // names no folder is left to the rolling walk.
    const folderKey = queued ? null : _folderReconEventFolderKey(messageInfo);
    if (folderKey) await _markFolderReconDirty(folderKey);
  }
}

function _folderReconEventFolderKey(messageInfo) {
  return messageInfo?.accountId && messageInfo?.folderPath
    ? `${messageInfo.accountId}:${messageInfo.folderPath}`
    : null;
}

/**
 * Shared enqueue for experiment-shaped messageInfo payloads. Used by the
 * live event path (onExperimentMessageAdded) and the boot cursor scan
 * (_runCursorScan). Deliberately does NOT touch _lastSyncEventMs — the
 * cursor scan is not a sync event and must not starve the maintenance
 * startup tick's quiet signal.
 *
 * @param {Object} messageInfo - Serialized message info from experiment
 * @param {boolean} [fromCursorScan] - Marks cursor-scan-sourced entries
 */
async function _enqueueNewFromInfo(messageInfo, fromCursorScan = false) {
  if (!_isEnabled) return false;

  const { headerMessageId, folderPath, accountId, subject, eventType } = messageInfo;

  // Build unique key from the info we have
  const uniqueKey = `${accountId}:${folderPath}:${headerMessageId}`;

  if (!accountId || !folderPath || !headerMessageId) {
    log(`[TMDBG FTS] Experiment enqueue: invalid key components, skipping`, "warn");
    return false;
  }

  // Acquire mutex for atomic enqueue
  const { acquired, release } = acquireEnqueueMutex();

  try {
    await acquired;

    // Check for existing entry
    const existing = _pendingUpdates.get(uniqueKey);
    if (existing) {
      log(`[TMDBG FTS] Experiment enqueue: ${uniqueKey} already queued (type=${existing.type}→new, age=${Date.now() - existing.timestamp}ms)`);
    }

    // Queue for indexing - FTS adds are idempotent, so always queue
    const update = {
      type: 'new',
      uniqueKey,
      timestamp: Date.now(),
      folderKey: `${accountId}:${folderPath}`,
      metadata: {
        subject: subject?.substring(0, 100),
        folderName: folderPath,
        fromExperiment: true,
        fromCursorScan,
        eventType,
      }
    };

    const admitted = await _tryAdmitPendingUpdate(
      uniqueKey,
      update,
      `${accountId}:${folderPath}`,
    );
    if (!admitted) return false;
    log(`[TMDBG FTS] Queued new from ${fromCursorScan ? 'cursor scan' : 'experiment'}: ${uniqueKey} (${eventType}) (queue size: ${_pendingUpdates.size})`);
    scheduleBatchProcess();
    return true;
  } finally {
    release();
  }
}

/**
 * Handle message removed event from experiment API (nsIMsgFolderNotificationService).
 * This provides reliable notifications for all message removals including:
 * - Deletions (msgsDeleted)
 * - Move source (msgsMoveCopyCompleted with move=true)
 * 
 * Uses mutex to ensure atomic enqueue with other concurrent events.
 * 
 * @param {Object} messageInfo - Serialized message info from experiment
 */
export async function onExperimentMessageRemoved(messageInfo) {
  if (!_isEnabled) return;
  let queued = false;
  try {
    queued = await _enqueueRemovedFromInfo(messageInfo);
  } finally {
    // An event whose change was not queued owes its folder a walk. One that
    // names no folder is left to the rolling walk.
    const folderKey = queued ? null : _folderReconEventFolderKey(messageInfo);
    if (folderKey) await _markFolderReconDirty(folderKey);
  }
}

async function _enqueueRemovedFromInfo(messageInfo) {
  // Track sync event for reconcile quiet-period detection
  _lastSyncEventMs = Date.now();
  _invalidateFolderReconProofForMessageEvent(messageInfo);

  const { headerMessageId, weFolderId, folderPath, accountId, msgKey, eventType } = messageInfo;

  log(`[TMDBG FTS] Experiment msgRemoved: type=${eventType}, folder=${folderPath}, headerMessageId=${headerMessageId?.substring(0, 30)}`);
  
  // Build unique key from the info we have
  const uniqueKey = `${accountId}:${folderPath}:${headerMessageId}`;
  
  if (!accountId || !folderPath || !headerMessageId) {
    log(`[TMDBG FTS] Experiment msgRemoved: invalid key components, skipping`, "warn");
    return false;
  }
  
  // Acquire mutex for atomic enqueue
  const { acquired, release } = acquireEnqueueMutex();
  
  try {
    await acquired;
    
    // Check for existing entry
    const existing = _pendingUpdates.get(uniqueKey);
    if (existing) {
      log(`[TMDBG FTS] Experiment msgRemoved: ${uniqueKey} already queued (type=${existing.type}→deleted, age=${Date.now() - existing.timestamp}ms)`);
    }
    
    // Queue for deletion
    const update = {
      type: 'deleted',
      uniqueKey,
      timestamp: Date.now(),
      folderKey: `${accountId}:${folderPath}`,
      metadata: {
        folderName: folderPath,
        msgKey,
        fromExperiment: true,
        eventType,
      }
    };
    
    // Always update - deletion takes precedence
    const admitted = await _tryAdmitPendingUpdate(
      uniqueKey,
      update,
      `${accountId}:${folderPath}`,
    );
    if (!admitted) return false;
    log(`[TMDBG FTS] Queued deletion from experiment: ${uniqueKey} (queue size: ${_pendingUpdates.size})`);
    scheduleBatchProcess();
    return true;
  } finally {
    release();
  }
}

// Track experiment listener state
let _experimentListenersActive = false;
let _addedListenerRegistered = false;
let _removedListenerRegistered = false;

/**
 * Set up listeners for experiment API events.
 * Call this after the experiment API is available.
 */
export async function setupExperimentListeners() {
  if (_experimentListenersActive) {
    log("[TMDBG FTS] Experiment listeners already active");
    return true;
  }
  
  if (!browser.tmMsgNotify) {
    log("[TMDBG FTS] tmMsgNotify experiment API not available");
    return false;
  }
  
  try {
    if (!_addedListenerRegistered) {
      browser.tmMsgNotify.onMessageAdded.addListener(onExperimentMessageAdded);
      _addedListenerRegistered = true;
    }
    if (!_removedListenerRegistered) {
      browser.tmMsgNotify.onMessageRemoved.addListener(onExperimentMessageRemoved);
      _removedListenerRegistered = true;
    }

    _experimentListenersActive = _addedListenerRegistered && _removedListenerRegistered;
    log("[TMDBG FTS] Experiment listeners registered successfully");
    return true;
  } catch (e) {
    log(`[TMDBG FTS] Failed to register experiment listeners: ${e}`, "error");
    return false;
  }
}

/**
 * Remove experiment listeners.
 */
export async function removeExperimentListeners() {
  if (!_addedListenerRegistered && !_removedListenerRegistered) return;
  
  try {
    if (browser.tmMsgNotify) {
      if (_addedListenerRegistered) {
        browser.tmMsgNotify.onMessageAdded.removeListener(onExperimentMessageAdded);
        _addedListenerRegistered = false;
      }
      if (_removedListenerRegistered) {
        browser.tmMsgNotify.onMessageRemoved.removeListener(onExperimentMessageRemoved);
        _removedListenerRegistered = false;
      }
    }
    log("[TMDBG FTS] Experiment listeners removed");
  } catch (e) {
    log(`[TMDBG FTS] Error removing experiment listeners: ${e}`, "warn");
  } finally {
    _experimentListenersActive = _addedListenerRegistered && _removedListenerRegistered;
  }
}

// Folder/account topology changes alter the inventory every reconciliation
// stage compares against (exact-mode cutover, legacy orphan basis). A tick
// re-reads it, but an idle scheduler has no tick: wake it and owe every
// folder a walk. Correctness never depends on delivery — every event-page
// start runs the startup reconciliation. Registered from the background
// entry point before any await so Gecko can prime the persistent events.
const _folderTopologyListenerOwners = new Map();
// Bumped synchronously by every topology event. A membership-state pass binds
// the value read before its inventory snapshot, so a pass judged against an
// inventory that a rename/move/delete has since overtaken never publishes
// cutover.
let _folderReconTopologySerial = 0;

function _onFolderReconTopologyChanged() {
  _folderReconTopologySerial++;
  if (!_isEnabled || _indexerDisposed) return;
  // A swap or remove/recreate can leave the final inventory unchanged, so no
  // folder's earlier verification survives a topology event. An attempt this
  // event overtakes started before the marks, so it cannot discharge them.
  _markAllFolderReconWalks();
  _wakeFolderRecon("folder_topology");
}

function _folderTopologyEvents() {
  return [
    ["folders.onCreated", browser.folders?.onCreated],
    ["folders.onDeleted", browser.folders?.onDeleted],
    ["folders.onRenamed", browser.folders?.onRenamed],
    ["folders.onMoved", browser.folders?.onMoved],
    ["folders.onCopied", browser.folders?.onCopied],
    ["accounts.onCreated", browser.accounts?.onCreated],
    ["accounts.onDeleted", browser.accounts?.onDeleted],
  ];
}

export function setupFolderTopologyListeners() {
  for (const [name, event] of _folderTopologyEvents()) {
    if (!event || _folderTopologyListenerOwners.has(name)) continue;
    try {
      event.addListener(_onFolderReconTopologyChanged);
      _folderTopologyListenerOwners.set(name, event);
    } catch (e) {
      log(`[FTS FolderRecon] Failed to attach ${name} topology wake: ${e}`, "warn");
    }
  }
}

function _removeFolderTopologyListeners() {
  for (const [name, event] of _folderTopologyListenerOwners) {
    try {
      event.removeListener(_onFolderReconTopologyChanged);
    } catch (e) {
      log(`[FTS FolderRecon] Failed to remove ${name} topology wake: ${e}`, "warn");
    }
    _folderTopologyListenerOwners.delete(name);
  }
}

// =====================================================================
// Post-init reconciliation
// =====================================================================
// Covers the startup timing gap: TB may sync folders before the experiment
// listener is registered, so membership changes during that window can miss
// the incremental indexer. After listeners are up and sync becomes quiet, the
// startup proof compares every folder's local membership with native FTS.
// Unchanged IMAP folders use UID/UIDVALIDITY + FTS digest checkpoints; changed
// folders get an exact two-way repair through the drain queue. The queue is
// not persisted: work pending at shutdown is re-derived by the next startup.
//
// The older date-window, watermark, and cursor helpers remain below for
// compatibility/tests, but the automatic startup path no longer calls them.
// =====================================================================

// Durable reconcile-needed flag written by earlier versions. Every session runs
// the startup reconciliation regardless, so the flag carries no cross-session
// information; it is only removed if an older version left it behind.
const LEGACY_RECONCILE_STORAGE_KEY = "fts_reconcile_pending";
// One strict serialization chain is intentionally permanent for the module
// lifetime. Generation changes cancel stale transactions but never reset or
// bypass ordering between memo operations.
let _reconStorageChain = Promise.resolve();

function _emptyFolderReconMemo() {
  return { version: 3, roundRobinCursor: null, folders: {} };
}

function _rawFolderReconMemo(value) {
  if ((value?.version === 2 || value?.version === 3)
      && value.folders && typeof value.folders === "object") {
    return structuredClone(value);
  }
  return _emptyFolderReconMemo();
}

function _enqueueReconStorageOperation(operation) {
  const result = _reconStorageChain.then(operation);
  _reconStorageChain = result.catch(() => {});
  return result;
}

async function _reconStorageTransaction(generation, patch) {
  return _enqueueReconStorageOperation(async () => {
    if (generation !== _folderReconGeneration) throw new Error("folder_recon_cancelled");
    const stored = await browser.storage.local.get(FOLDER_RECON_STORAGE_KEY);
    if (generation !== _folderReconGeneration) throw new Error("folder_recon_cancelled");
    const memo = _rawFolderReconMemo(stored?.[FOLDER_RECON_STORAGE_KEY]);
    const memoBefore = JSON.stringify(memo);
    const state = { memo };
    const patchResult = patch(state);
    if (patchResult && typeof patchResult.then === "function") {
      throw new Error("reconcile_storage_patch_must_be_synchronous");
    }
    if (generation !== _folderReconGeneration) throw new Error("folder_recon_cancelled");
    const toSet = {};
    if (JSON.stringify(state.memo) !== memoBefore) {
      toSet[FOLDER_RECON_STORAGE_KEY] = state.memo;
    }
    if (Object.keys(toSet).length > 0) {
      await browser.storage.local.set(toSet);
      if (generation !== _folderReconGeneration) throw new Error("folder_recon_cancelled");
    }
    return { ...state, result: patchResult };
  });
}

async function _readReconStorageStrict(generation = _folderReconGeneration) {
  return _reconStorageTransaction(generation, () => {});
}

// The orphan tail's quiet predicate, with no side effect: nothing is owed
// (no walk obligation, no queued update) and no message event landed since
// `eventSerial` (a `_folderReconLocalSerial` reading) in this generation.
// Events are detected by that serial, never by `_lastSyncEventMs`: two
// events can share a millisecond.
function _folderReconQuietSince(generation, eventSerial) {
  return generation === _folderReconGeneration
    && _folderReconLocalSerial === eventSerial
    && _folderReconDirty.size === 0
    && _pendingUpdates.size === 0;
}

// The pending-update queue is no longer persisted (owner 2026-10-04): the
// startup walk of every folder re-derives work pending at shutdown, so a
// stored queue could only replay a stale intention over a newer one.
const LEGACY_PENDING_QUEUE_STORAGE_KEY = "fts_pending_updates";
const LEGACY_STORAGE_KEYS = Object.freeze([
  LEGACY_RECONCILE_STORAGE_KEY,
  LEGACY_PENDING_QUEUE_STORAGE_KEY,
]);

// Removes retired keys once; reads first so an install without them writes
// nothing.
async function _removeLegacyStorageKeys() {
  try {
    const stored = await browser.storage.local.get([...LEGACY_STORAGE_KEYS]);
    const present = LEGACY_STORAGE_KEYS.filter(key => stored?.[key] !== undefined
      && stored?.[key] !== null);
    if (present.length > 0) await browser.storage.local.remove(present);
  } catch (e) {
    log(`[FTS FolderRecon] Legacy storage cleanup failed: ${e}`, "warn");
  }
}

// Persistent watermark: the lower-bound "as-of" timestamp up to which
// FTS is known to be consistent with IMAP. Established by a clean boot
// reconcile, advanced during runtime by the heartbeat. The next boot
// reconcile uses (watermark.completedAtMs - 1 day) as its window start,
// so a TB that ran 7d then was off 2d only reconciles ~3 days.
const WATERMARK_KEY = "fts_reconcile_watermark";
// 1-day overlap to handle timezone / rounding edge cases at window boundary.
const RECONCILE_OVERLAP_MS = 24 * 60 * 60 * 1000;
// First-run / missing-watermark fallback. After the first clean reconcile
// completes, this is unreachable in steady state.
const RECONCILE_FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Quiet period before running reconcile — prevents taking a membership
// fingerprint while TB is still mutating the local msgDB during startup sync.
const RECONCILE_QUIET_PERIOD_MS = 60 * 1000; // 60 seconds
// Check interval for quiet-period polling
const RECONCILE_QUIET_CHECK_INTERVAL_MS = 10 * 1000; // 10 seconds
// Hard cap on how long to wait before running reconcile even if events keep firing.
// Busy inboxes may never reach the quiet period, so we force reconcile after this.
const RECONCILE_MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes

// Runtime heartbeat: while the listener is healthy, advance the watermark's
// completedAtMs forward so the offline gap on next boot is bounded by the
// heartbeat interval, not the entire uptime.
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Per-folder msgKey/UID cursors (add-side reconcile) — ADR-020,
// PLAN_RECONCILE_CURSOR.md. For IMAP folders msgKey = IMAP UID, monotonic in
// arrival-into-folder order — the signal the Date-keyed Phase 1 window cannot
// express ("new to our local msgDB since we last looked"). The boot cursor
// scan (Phase 1b) enqueues everything above each folder's cursor regardless
// of its Date header, closing the add-side Class-1 blind spot (06/29 incident:
// 352 messages synced late into Gmail secondary folders, all missed by the
// date-windowed Phase 1).
// ---------------------------------------------------------------------------
const CURSOR_STORAGE_KEY = "fts_folder_cursors";
// Keys resolved to messageInfos per experiment RPC
const CURSOR_KEYS_CHUNK = 500;
// Cap for full scans (cursorless new folder / UIDVALIDITY reset). Newest keys
// win; a truncated scan is logged loudly. Matches today's new-folder posture
// (history is owned by the initial scan / weekly maintenance).
const CURSOR_FULL_SCAN_MAX_KEYS = 5000;
// Small yield between messageInfo chunks to keep the event loop responsive
const CURSOR_CHUNK_DELAY_MS = 10;

// Highest msgKey seen per folder ("accountId:folderPath" -> key) via
// delivered experiment events this session. Merged into the persistent
// cursors by the heartbeat. Only delivered events advance this — unevented
// arrivals stay above the stored cursor for the next boot scan to catch.
let _sessionMaxKeyByFolder = new Map();

/**
 * Record the msgKey from a delivered experiment add event.
 */
function _noteSessionMaxKey(messageInfo) {
  const { accountId, folderPath, msgKey } = messageInfo || {};
  if (!accountId || !folderPath) return;
  if (typeof msgKey !== "number" || !Number.isFinite(msgKey)) return;
  const folderKey = `${accountId}:${folderPath}`;
  const prev = _sessionMaxKeyByFolder.get(folderKey);
  if (prev === undefined || msgKey > prev) {
    _sessionMaxKeyByFolder.set(folderKey, msgKey);
  }
}

// Tracks the most recent sync-related message event timestamp.
// Reset on every onExperimentMessageAdded/Removed call.
let _lastSyncEventMs = Date.now();
// Handle to the quiet-period check timer (for cleanup)
let _reconcileQuietTimer = null;
// Handle to the runtime watermark-advance timer (for cleanup)
let _watermarkHeartbeatTimer = null;
// Disposal flag — heartbeat re-checks this AFTER its async storage read,
// before the write, so a dispose() that fires between the read and the
// write doesn't let a pending heartbeat write stale data into freshly-
// cleared state. Reset to false in init.
let _indexerDisposed = false;

/**
 * Determine the reconcile lower-bound from the persistent watermark.
 *
 * Reads `fts_reconcile_watermark` from browser.storage.local. Returns
 * `(completedAtMs - 1 day)` when present, otherwise a 7-day fallback.
 * Does NOT query FTS — see PLAN_RECONCILE_WATERMARK.md for why the
 * old FTS-newest-date approach was unsound (the listener could advance
 * FTS during the quiet wait, shrinking the window before Phase 2 ran).
 *
 * Defensive guards (any → 7d fallback):
 *  - watermark missing
 *  - completedAtMs / fromMs wrong type
 *  - completedAtMs ≤ 0 (corrupt)
 *  - completedAtMs > now + 1 day (clock skew)
 */
async function _getReconcileFrom() {
  const now = Date.now();
  let wm = null;
  try {
    const stored = await browser.storage.local.get(WATERMARK_KEY);
    wm = stored?.[WATERMARK_KEY] || null;
  } catch (e) {
    log(`[FTS Reconcile] Watermark read failed: ${e} — using 7d fallback`, "warn");
  }

  if (!wm
      || !Number.isFinite(wm.completedAtMs)        // catches NaN, Infinity, non-number
      || !Number.isFinite(wm.fromMs)
      || wm.completedAtMs <= 0                     // corrupt
      || wm.completedAtMs > now + RECONCILE_OVERLAP_MS) {  // future-dated
    log(`[FTS Reconcile] No usable watermark; using 7-day fallback window`);
    return now - RECONCILE_FALLBACK_WINDOW_MS;
  }

  const from = wm.completedAtMs - RECONCILE_OVERLAP_MS;
  log(`[FTS Reconcile] Window from ${new Date(from).toISOString()} (watermark completedAt: ${new Date(wm.completedAtMs).toISOString()}, fromMs: ${new Date(wm.fromMs).toISOString()})`);
  return from;
}

/**
 * Write the watermark after a clean reconcile completion. Only called
 * when Phase 1 + Phase 2 both finished without an exception, every Phase 1
 * message reached the drain queue (enqueueFailed === 0), Phase 2 skipped
 * no accounts (accountsSkipped === 0), AND nothing in Phase 2 failed
 * mid-flight (removeFailed === false — covers both a removeBatch throw and
 * any internal Phase 2 exception).
 *
 * @param {number} fromMs - The reconcileFrom value Phase 2 just verified.
 */
async function _writeWatermark(fromMs) {
  try {
    await browser.storage.local.set({
      [WATERMARK_KEY]: {
        version: 1,
        fromMs,
        completedAtMs: Date.now(),
      },
    });
    log(`[FTS Reconcile] Watermark advanced: fromMs=${new Date(fromMs).toISOString()}, completedAtMs=${new Date().toISOString()}`);
  } catch (e) {
    // Non-fatal: next boot just reads the older watermark → wider window.
    log(`[FTS Reconcile] Watermark write failed: ${e}`, "warn");
  }
}

/**
 * Drain-stall guard shared by the watermark bump and the cursor advance:
 * if pending updates have been sitting unprocessed for longer than 2× the
 * heartbeat interval, the listener fired but the queue isn't draining.
 * Advancing coverage claims would be false while events sit pending.
 */
function _isDrainStalled() {
  if (_pendingUpdates.size === 0) return false;
  let oldestTs = Infinity;
  for (const u of _pendingUpdates.values()) {
    if (typeof u.timestamp === "number" && u.timestamp < oldestTs) {
      oldestTs = u.timestamp;
    }
  }
  return oldestTs !== Infinity && Date.now() - oldestTs > HEARTBEAT_INTERVAL_MS * 2;
}

/**
 * Runtime watermark-advance heartbeat. Bumps completedAtMs forward
 * while the experiment listener is active and the drain queue isn't
 * stalled. Never advances fromMs — only Phase 2 may do that.
 *
 * Refuses to *create* a watermark. If boot reconcile hasn't completed
 * yet, the heartbeat is a no-op.
 */
async function _heartbeatBumpWatermark() {
  if (!_isEnabled || !_experimentListenersActive || _indexerDisposed) return;

  if (_isDrainStalled()) {
    log(`[FTS Heartbeat] Skipped: drain stalled`);
    return;
  }

  let wm = null;
  try {
    const stored = await browser.storage.local.get(WATERMARK_KEY);
    wm = stored?.[WATERMARK_KEY] || null;
  } catch (e) {
    log(`[FTS Heartbeat] Watermark read failed: ${e}`, "warn");
    return;
  }

  // Refuse to create a watermark — only boot reconcile may do that.
  if (!wm || !Number.isFinite(wm.fromMs)) return;

  // Re-check disposal AFTER the async read but BEFORE the write — a
  // dispose() that ran during the read should not lose to a stale
  // heartbeat write.
  if (_indexerDisposed) return;

  try {
    await browser.storage.local.set({
      [WATERMARK_KEY]: {
        version: 1,
        fromMs: wm.fromMs,         // unchanged — only Phase 2 advances
        completedAtMs: Date.now(), // creeps forward
      },
    });
  } catch (e) {
    log(`[FTS Heartbeat] Watermark write failed: ${e}`, "warn");
  }
}

/**
 * Fire-and-forget prod-observability snapshot: released builds suppress all
 * info logging, so the last cursor-scan / folder-recon outcome is persisted
 * to storage.local where it can be inspected on ANY build
 * (`fts_cursor_scan_last` / `fts_folder_recon_last`).
 */
function _writeReconSnapshot(key, payload) {
  return browser.storage.local.set({ [key]: { at: new Date().toISOString(), ...payload } })
    .then(() => true, () => false);
}

/**
 * Read the persistent per-folder cursors. Returns null when never written
 * (first run — the cursor scan seeds without enumeration in that case).
 */
async function _getCursors() {
  try {
    const stored = await browser.storage.local.get(CURSOR_STORAGE_KEY);
    const c = stored?.[CURSOR_STORAGE_KEY];
    if (c && c.folders && typeof c.folders === "object") return c;
    return null;
  } catch (e) {
    log(`[FTS Cursor] Cursor read failed: ${e}`, "warn");
    return null;
  }
}

async function _writeCursors(cursors) {
  try {
    await browser.storage.local.set({ [CURSOR_STORAGE_KEY]: cursors });
  } catch (e) {
    // Non-fatal: next boot re-scans from the older cursors (wider diff).
    log(`[FTS Cursor] Cursor write failed: ${e}`, "warn");
  }
}

/**
 * Heartbeat cursor advance: merge session-max keys (from delivered events)
 * into the persistent cursors. Only advances EXISTING entries — the boot
 * cursor scan is the sole minter (mirrors the watermark heartbeat's
 * "refuse to create" rule). Guarded by the shared drain-stall check.
 * Legacy helper (no production caller): its original safety argument relied
 * on queue persistence, which was deleted 2026-10-04.
 */
async function _heartbeatAdvanceCursors() {
  if (!_isEnabled || !_experimentListenersActive || _indexerDisposed) return;
  if (_sessionMaxKeyByFolder.size === 0) return;
  if (_isDrainStalled()) {
    log(`[FTS Cursor Heartbeat] Skipped: drain stalled`);
    return;
  }

  const cursors = await _getCursors();
  // Refuse to create — only the boot cursor scan may mint the cursor store.
  if (!cursors) return;

  // Re-check disposal AFTER the async read (same pattern as the watermark
  // heartbeat) so a dispose() during the read doesn't lose to a stale write.
  if (_indexerDisposed) return;

  let advanced = 0;
  for (const [folderKey, sessionMax] of _sessionMaxKeyByFolder.entries()) {
    const entry = cursors.folders[folderKey];
    if (!entry) continue; // folder not minted yet — next boot's scan owns it
    if (typeof entry.highestKeySeen === "number" && sessionMax > entry.highestKeySeen) {
      entry.highestKeySeen = sessionMax;
      entry.updatedAtMs = Date.now();
      advanced++;
    }
  }

  if (advanced > 0) {
    await _writeCursors(cursors);
    log(`[FTS Cursor Heartbeat] Advanced ${advanced} folder cursor(s) from session events`);
  }
}

/**
 * Start the heartbeat timer. Called after a clean boot reconcile.
 * Idempotent — clears any prior timer first.
 */
function _startWatermarkHeartbeat() {
  if (_watermarkHeartbeatTimer) {
    clearInterval(_watermarkHeartbeatTimer);
    _watermarkHeartbeatTimer = null;
  }
  _watermarkHeartbeatTimer = setInterval(() => {
    _heartbeatBumpWatermark().catch(e => {
      log(`[FTS Heartbeat] Unexpected error: ${e}`, "warn");
    });
    _heartbeatAdvanceCursors().catch(e => {
      log(`[FTS Cursor Heartbeat] Unexpected error: ${e}`, "warn");
    });
  }, HEARTBEAT_INTERVAL_MS);
  log(`[FTS Heartbeat] Started — interval ${HEARTBEAT_INTERVAL_MS / 1000}s`);
}

/**
 * Stop the heartbeat timer. Called in disposeIncrementalIndexer.
 */
function _stopWatermarkHeartbeat() {
  if (_watermarkHeartbeatTimer) {
    clearInterval(_watermarkHeartbeatTimer);
    _watermarkHeartbeatTimer = null;
    log(`[FTS Heartbeat] Stopped`);
  }
}

/**
 * Phase 1b: per-folder msgKey/UID cursor scan (ADR-020).
 *
 * For each IMAP folder, compares the msgDB's highWater key against the
 * persisted cursor and enqueues everything above it — catching messages
 * that entered the local msgDB while nothing was listening (addon not yet
 * loaded, addon disabled, event-less bulk sync), REGARDLESS of their Date
 * header. This is the arrival-ordered complement to the Date-keyed Phase 1.
 *
 * Per-folder advance contract: a folder's cursor advances only when every
 * enqueue for it succeeded (once enqueued, the drain queue's retry owns
 * delivery — same contract as the watermark's enqueueFailed rule). Legacy
 * helper (no production caller); the queue is no longer persisted.
 * Failed folders keep their old cursor and retry next boot. Independent of
 * the watermark: neither blocks the other.
 *
 * First run (no cursor store): seeds every folder to its current highWater
 * WITHOUT enumeration — coverage before first deploy is owned by the
 * initial scan / weekly maintenance. UIDVALIDITY change or a new folder
 * triggers a capped full scan from key 0 (FTS-level dedup via the drain
 * queue's filterNewMessages makes re-enqueues cheap no-ops).
 */
async function _listWeFolderIdentities({ imapOnly = false } = {}) {
  const started = Date.now();
  const accounts = await browser.accounts.list(true);
  const folders = [];
  const walk = (accountId, folder) => {
    if (!folder) return;
    if (folder.path && folder.path !== "/" && !folder.isRoot) {
      folders.push({
        accountId,
        folderPath: folder.path,
        folderId: makeFolderMembershipId(accountId, folder.path),
        weFolderId: typeof folder.id === "string" ? folder.id : "",
      });
    }
    for (const sub of folder.subFolders || []) walk(accountId, sub);
  };
  for (const account of accounts || []) {
    // Older TB test doubles may omit type; the privileged per-folder call is
    // still authoritative and will reject a non-IMAP cursor request.
    if (imapOnly && account.type && account.type !== "imap") continue;
    walk(account.id, account.rootFolder);
  }
  log(`[TMDBG FTS FolderProbe] WebExtension inventory: ${folders.length} folder(s) from ${accounts?.length || 0} account(s) in ${Date.now() - started}ms`);
  return folders;
}

function _logFolderProbeTiming(kind, state) {
  const elapsedMs = Number(state?.elapsedMs) || 0;
  const details = {
    kind,
    accountId: state?.accountId || "",
    folderPath: state?.folderPath || "",
    elapsedMs,
    lookupMs: Number(state?.lookupMs) || 0,
    dbOpenMs: Number(state?.dbOpenMs) || 0,
    error: state?.error || "",
  };
  const line = `${details.accountId}:${details.folderPath} total=${elapsedMs}ms lookup=${details.lookupMs}ms db=${details.dbOpenMs}ms`;
  if (state?.error) {
    log(`[FTS FolderProbe] ${kind} failed for ${line}: ${state.error}`, "warn");
  } else if (elapsedMs >= 250) {
    log(`[FTS FolderProbe] Slow ${kind}: ${line}`, "warn");
  } else {
    log(`[TMDBG FTS FolderProbe] ${kind}: ${line}`);
  }
  logFtsOperation("folder_probe", state?.error ? "error" : "timing", details);
}

async function _readPerFolderExperimentState(
  methodName,
  { imapOnly = false, onlyFolderKeys = null, currentIdentities = null, callOptions = null } = {},
) {
  let identities = currentIdentities
    ? currentIdentities.map(identity => ({ ...identity }))
    : await _listWeFolderIdentities({ imapOnly });
  if (onlyFolderKeys) {
    identities = identities.filter(identity => onlyFolderKeys.has(`${identity.accountId}:${identity.folderPath}`));
  }
  const out = [];
  for (let i = 0; i < identities.length; i++) {
    const identity = identities[i];
    let state;
    try {
      state = await browser.tmMsgNotify[methodName](
        identity.accountId,
        identity.folderPath,
        ...(callOptions ? [callOptions] : []),
      );
    } catch (e) {
      state = { ...identity, folderURI: "", error: String(e) };
    }
    // The privileged folder-state API predates opaque WebExtension folder
    // ids. Preserve the id from the fresh account inventory beside its state.
    out.push({ ...identity, ...state });
    if (methodName !== "getFolderState") _logFolderProbeTiming(methodName, state);
    // Each Experiment call may synchronously open one summary DB. Yield a
    // full task between folders so an account-wide startup proof stays
    // responsive even when many folders need inspection.
    if (i + 1 < identities.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return out;
}

async function _listCursorKeysAboveKeyCooperatively(folderURI, sinceKey, maxKeys) {
  if (typeof browser.tmMsgNotify?.beginFolderMessageScan !== "function"
      || typeof browser.tmMsgNotify?.readFolderMessageScanPage !== "function"
      || typeof browser.tmMsgNotify?.cancelFolderMessageScan !== "function") {
    return { keys: [], truncated: false, totalAbove: 0, error: "scan_api_unavailable" };
  }
  const cap = Math.max(1, Number.isFinite(maxKeys) ? Math.floor(maxKeys) : 1);
  const normalizedSince = _normalizeMsgKeyCursor(sinceKey) ?? 0;
  const heap = [];
  let totalAbove = 0;
  let token = null;

  const retainHighest = (key) => {
    if (heap.length < cap) {
      heap.push(key);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (heap[parent] <= heap[child]) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
      return;
    }
    if (key <= heap[0]) return;
    heap[0] = key;
    let parent = 0;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let smallest = parent;
      if (left < heap.length && heap[left] < heap[smallest]) smallest = left;
      if (right < heap.length && heap[right] < heap[smallest]) smallest = right;
      if (smallest === parent) break;
      [heap[parent], heap[smallest]] = [heap[smallest], heap[parent]];
      parent = smallest;
    }
  };

  try {
    const started = await browser.tmMsgNotify.beginFolderMessageScan(folderURI, false);
    if (started?.error || !started?.token) {
      return {
        keys: [],
        truncated: false,
        totalAbove: 0,
        error: started?.error || "scan_start_failed",
      };
    }
    token = started.token;
    while (true) {
      const page = await browser.tmMsgNotify.readFolderMessageScanPage(token, 250);
      if (page?.error) {
        return { keys: [], truncated: false, totalAbove: 0, error: page.error };
      }
      for (const row of page?.rows || []) {
        const key = _normalizeMsgKeyCursor(row?.msgKey);
        if (key === null || key <= normalizedSince) continue;
        totalAbove++;
        retainHighest(key);
      }
      if (page?.done === true) break;
    }
    heap.sort((a, b) => a - b);
    return { keys: heap, truncated: totalAbove > cap, totalAbove };
  } catch (e) {
    return { keys: [], truncated: false, totalAbove: 0, error: String(e) };
  } finally {
    if (token) {
      try { await browser.tmMsgNotify.cancelFolderMessageScan(token); } catch (_) {}
    }
  }
}

async function _runCursorScan() {
  if (!_isEnabled) return { skipped: true, reason: "disabled" };
  if (!browser.tmMsgNotify
      || typeof browser.tmMsgNotify.getCursorFolder !== "function"
      || !_experimentListenersActive) {
    log(`[FTS Cursor] Scan skipped — experiment API unavailable`);
    return { skipped: true, reason: "no_experiment" };
  }

  const scanStart = Date.now();
  const stats = {
    foldersTotal: 0,
    foldersUnchanged: 0,
    foldersSeeded: 0,
    foldersScanned: 0,
    foldersAdvanced: 0,
    foldersSkipped: 0,
    keysEnqueued: 0,
    enqueueFailed: 0,
    truncatedScans: 0,
  };

  let folders;
  try {
    folders = await _readPerFolderExperimentState("getCursorFolder", { imapOnly: true });
  } catch (e) {
    log(`[FTS Cursor] Folder inventory failed: ${e} — scan skipped, retry next boot`, "warn");
    logFtsBatchOperation("cursor_scan", "error", { error: String(e) });
    return { skipped: true, reason: "folder_inventory_failed" };
  }

  const stored = await _getCursors();
  const firstRun = !stored;
  const cursors = stored || { version: 1, seededAtMs: Date.now(), folders: {} };

  logFtsBatchOperation("cursor_scan", "start", {
    firstRun,
    foldersReported: folders?.length || 0,
  });

  for (const f of folders || []) {
    stats.foldersTotal++;

    if (f.error || !f.folderURI) {
      // msgDB unreadable — never seed or advance on error; retry next boot.
      stats.foldersSkipped++;
      logFtsOperation("cursor_scan", "folder_error", {
        folderPath: f.folderPath,
        error: f.error || "no_folderURI",
      });
      continue;
    }

    const folderKey = `${f.accountId}:${f.folderPath}`;
    const cur = cursors.folders[folderKey];
    const highWater = typeof f.highWater === "number" ? f.highWater : 0;
    const uidValidity = typeof f.uidValidity === "number" ? f.uidValidity : 0;

    let sinceKey = null;
    let scanReason = null;

    if (!cur) {
      if (firstRun) {
        // Seed without enumeration — claim nothing before deploy.
        cursors.folders[folderKey] = {
          uidValidity,
          highestKeySeen: highWater,
          updatedAtMs: Date.now(),
        };
        stats.foldersSeeded++;
        continue;
      }
      sinceKey = 0;
      scanReason = "new_folder";
    } else if (!Number.isFinite(cur.highestKeySeen)) {
      // Corrupt entry — without this it would compare as "unchanged"
      // forever and never heal. Re-mint via a capped full scan.
      sinceKey = 0;
      scanReason = "corrupt_cursor";
    } else if (cur.uidValidity !== uidValidity) {
      // UIDs remapped — FTS keys (headerMessageId-based) stay valid, so a
      // full re-enqueue dedups against the index; the cursor is re-minted.
      sinceKey = 0;
      scanReason = "uidvalidity_reset";
    } else if (highWater > cur.highestKeySeen) {
      sinceKey = cur.highestKeySeen;
      scanReason = "diff";
    } else {
      stats.foldersUnchanged++;
      continue;
    }

    // Enumerate keys above the cursor
    let listed;
    try {
      listed = await _listCursorKeysAboveKeyCooperatively(
        f.folderURI,
        sinceKey,
        CURSOR_FULL_SCAN_MAX_KEYS,
      );
    } catch (e) {
      listed = { keys: [], error: String(e) };
    }
    if (listed.error) {
      stats.foldersSkipped++;
      logFtsOperation("cursor_scan", "list_error", {
        folderPath: f.folderPath,
        reason: scanReason,
        error: listed.error,
      });
      continue;
    }

    if (listed.truncated) {
      stats.truncatedScans++;
      log(`[FTS Cursor] TRUNCATED scan for ${folderKey} (${scanReason}): enqueuing newest ${listed.keys.length} of ${listed.totalAbove} keys — older history is NOT recovered by this scan`, "warn");
      logFtsOperation("cursor_scan", "truncated", {
        folderPath: f.folderPath,
        reason: scanReason,
        enqueued: listed.keys.length,
        totalAbove: listed.totalAbove,
      });
    }

    stats.foldersScanned++;

    // Resolve keys to messageInfos in chunks and enqueue into the drain queue
    let folderEnqueueFailed = 0;
    let folderEnqueued = 0;
    let lastEnumeratedKey = sinceKey;
    for (let i = 0; i < listed.keys.length; i += CURSOR_KEYS_CHUNK) {
      const chunk = listed.keys.slice(i, i + CURSOR_KEYS_CHUNK);
      let res;
      try {
        res = await browser.tmMsgNotify.getMessageInfosForKeys(f.folderURI, chunk);
      } catch (e) {
        res = { infos: [], error: String(e) };
      }
      if (res.error) {
        // RPC-level failure — coverage for this folder is unproven.
        folderEnqueueFailed++;
        logFtsOperation("cursor_scan", "infos_error", {
          folderPath: f.folderPath,
          error: res.error,
        });
        break;
      }
      // Keys omitted from infos = header gone between list and fetch
      // (message deleted meanwhile) — nothing to index, remove-side owns it.
      for (const info of res.infos || []) {
        try {
          if (await _enqueueNewFromInfo(info, true)) {
            folderEnqueued++;
          } else {
            folderEnqueueFailed++;
            break;
          }
        } catch (e) {
          folderEnqueueFailed++;
          log(`[FTS Cursor] Enqueue failed for ${folderKey}:${info?.headerMessageId}: ${e}`, "warn");
        }
      }
      if (folderEnqueueFailed > 0) break;
      lastEnumeratedKey = chunk[chunk.length - 1];
      if (CURSOR_CHUNK_DELAY_MS > 0 && i + CURSOR_KEYS_CHUNK < listed.keys.length) {
        await new Promise(r => setTimeout(r, CURSOR_CHUNK_DELAY_MS));
      }
    }

    stats.keysEnqueued += folderEnqueued;
    stats.enqueueFailed += folderEnqueueFailed;

    if (folderEnqueueFailed === 0) {
      // Advance: everything above the old cursor reached the persistent
      // drain queue. Keys arriving after the getCursorFolders snapshot are
      // the live listener's responsibility (it's registered by now).
      cursors.folders[folderKey] = {
        uidValidity,
        highestKeySeen: Math.max(highWater, lastEnumeratedKey || 0),
        updatedAtMs: Date.now(),
      };
      stats.foldersAdvanced++;
      if (folderEnqueued > 0) {
        log(`[FTS Cursor] ${folderKey}: enqueued ${folderEnqueued} (${scanReason}), cursor → ${cursors.folders[folderKey].highestKeySeen}`);
      }
    } else {
      stats.foldersSkipped++;
      log(`[FTS Cursor] ${folderKey}: ${folderEnqueueFailed} enqueue failure(s) — cursor NOT advanced, retry next boot`, "warn");
    }
  }

  // Single write: seeded + advanced folders persist; failed folders keep
  // their old entries (or none) and are retried next boot.
  await _writeCursors(cursors);

  const elapsed = Date.now() - scanStart;
  log(`[FTS Cursor] Scan complete: ${stats.foldersTotal} folders (${stats.foldersUnchanged} unchanged, ${stats.foldersSeeded} seeded, ${stats.foldersScanned} scanned, ${stats.foldersAdvanced} advanced, ${stats.foldersSkipped} skipped), ${stats.keysEnqueued} enqueued, ${stats.enqueueFailed} enqueue failures, ${elapsed}ms`);
  logFtsBatchOperation("cursor_scan", "complete", { ...stats, firstRun, elapsedMs: elapsed });
  _writeReconSnapshot("fts_cursor_scan_last", { ...stats, firstRun, elapsedMs: elapsed });

  return stats;
}

// ---------------------------------------------------------------------------
// Phase 1c: Startup per-folder membership proof and exact set reconcile.
//
// Each folder's headers are pulled through a bounded lazy enumerator and the
// extension cooperatively hashes both its UID/key view and exact
// account:path:Message-ID set (headers only, never bodies). This avoids
// Thunderbird's one-shot parent-thread listAllKeys() while retaining the exact
// equality proof. A mismatch runs BOTH stale and missing directions, so
// equal-cardinality swaps are repaired too.
//
// This replaces cached folder-count inference and periodic maintenance scans.
// ---------------------------------------------------------------------------
const FOLDER_RECON_STORAGE_KEY = "fts_folder_recon_memo";
// FTS keys / msgDB keys per RPC page in both directions
const FOLDER_RECON_KEYS_CHUNK = 500;
// Small yield between chunks / folders to keep the event loop responsive
const FOLDER_RECON_CHUNK_DELAY_MS = 10;
// Native-FTS keepalive cadence during the verify-then-remove recheck loop
const FOLDER_RECON_RECHECK_KEEPALIVE_EVERY = 50;
// Full-keyspace upper bound for the orphan sweep: U+FFFF sorts above every
// character that can appear in a msgId key.
const FOLDER_RECON_KEYSPACE_END = "￿";
// The exact membership proof needs initial add-side completeness. Before the
// initial FULL scan has completed, every folder has a huge policy deficit and the missing
// direction would mass-enqueue the whole backlog through the incremental
// drain queue.
// Gate the whole phase on the initial scan's completion flag (written by
// chat/background.js runInitialFtsScan).
const FOLDER_RECON_INITIAL_SCAN_KEY = "fts_initial_scan_complete";
const FOLDER_RECON_CONFIG = {
  folderScanPageSize: 250,
  membershipAssignBatchSize: 1000,
  membershipListPageSize: 500,
  membershipStatePageSize: 500,
  digestWorkChunkEntries: 1000,
  missingPageKeys: 500,
  stalePageKeys: 100,
  stalePagesPerSlice: 1,
  rechecksPerSlice: 5,
  orphanBasisFoldersPerSlice: 50,
  enqueuesPerSlice: 20,
  pendingHighWater: 100,
  pendingLowWater: 25,
  paceDelayMs: 250,
  pressureDelayMs: 2000,
  errorDelayMs: 10000,
  // Longest single wait for a folder's backoff to end; the tick re-arms.
  backoffWaitCapMs: 60 * 1000,
  syncQuietMs: 5000,
  reverifyIntervalMs: 20 * 60 * 1000,
  walkPeriodMs: 24 * 60 * 60 * 1000,
  membershipUnresolvedRetryMs: 10 * 60 * 1000,
  changeLedgerCap: 4096,
  changeLedgerKeyCap: 4096,
  ...(SETTINGS?.agentQueues?.ftsFolderRecon || {}),
};
// Thunderbird 145 exposes UIDVALIDITY through a signed int32 even though the
// IMAP value is an unsigned non-zero 32-bit integer. Zero is Thunderbird's
// unknown/not-selected sentinel; negative values can be valid high-bit epochs.
const UIDVALIDITY_SIGNED_MIN = -0x80000000;
const UIDVALIDITY_UNSIGNED_MAX = 0xffffffff;
// nsMsgKey is an XPIDL `unsigned long`, but high-bit values have also crossed
// some Thunderbird JS surfaces as signed int32 values. Accept either spelling
// and canonicalize to uint32. 0xffffffff (including signed -1) is
// nsMsgKey_None, not a resumable message key. Zero is a valid processed key;
// the separate missingBackfillStarted bit represents before-first.
const MSG_KEY_SIGNED_MIN = -0x80000000;
const MSG_KEY_NONE = 0xffffffff;

// Exact-mode identity evidence for one stable-UID IMAP folder: the opening
// msgDB incarnation token and UIDVALIDITY. With both, a certifying proof is
// confirmed by a closing read and earns the token; the next startup's
// UID-only tier is open only on the msgDB that earned it.
function _folderReconHasIdentityEvidence(folder) {
  return folder?.serverType === "imap"
    && folder.stableUidKeys === true
    && typeof folder.incarnationToken === "string"
    && folder.incarnationToken.length > 0
    && _normalizeUidValidity(folder.uidValidity) !== null;
}

async function _readFolderReconClosingState(folder) {
  try {
    return await browser.tmMsgNotify.getFolderState(folder.accountId, folder.folderPath);
  } catch (e) {
    return { error: String(e) };
  }
}

// The incarnation token a certifying proof earns once a closing read
// confirmed the opening msgDB: only for a stable-UID proof taken under the
// opening UIDVALIDITY.
function _folderReconEarnedToken(opening, proof) {
  if (proof?.stableUidKeys !== true
      || _normalizeUidValidity(proof.uidValidity) !== _normalizeUidValidity(opening.uidValidity)) {
    return null;
  }
  return { incarnationToken: opening.incarnationToken };
}

// The msgDB that answered the opening read still backs the folder.
function _folderReconIdentityUnchanged(opening, closing) {
  return !closing?.error
    && closing?.incarnationToken === opening.incarnationToken
    && _normalizeUidValidity(closing?.uidValidity) === _normalizeUidValidity(opening.uidValidity);
}

function _normalizeUidValidity(value) {
  if (!Number.isInteger(value)
      || value === 0
      || value < UIDVALIDITY_SIGNED_MIN
      || value > UIDVALIDITY_UNSIGNED_MAX) {
    return null;
  }
  return value >>> 0;
}

function _normalizeMsgKeyCursor(value) {
  if (!Number.isInteger(value)
      || value < MSG_KEY_SIGNED_MIN
      || value > MSG_KEY_NONE) {
    return null;
  }
  const normalized = value >>> 0;
  return normalized === MSG_KEY_NONE ? null : normalized;
}

// Missing-direction backfill uses a durable per-folder msgKey cursor over the
// sorted key view produced by the exact current snapshot. Page and enqueue
// limits bound one scheduler slice, not total work; durable round-robin
// scheduling repeats slices until equality is proven. Each admitted add still
// becomes a body fetch only through the existing incremental drain.
// Yield between individual verify-then-remove rechecks. Each recheck is a
// GLOBAL messages.query (full-profile enumeration on the parent main thread)
// — running them back-to-back on a mature profile's ghost backlog saturates
// the UI.
const FOLDER_RECON_ENTRY_DELAY_MS = 10;
// Per-slice limits prevent a mature profile's backlog from issuing an
// unbroken run of parent-thread global rechecks or drain-queue body fetches.
// The scheduler's total progress remains unbounded.
const FOLDER_MEMBERSHIP_ASSIGN_BATCH_MAX = 1000;
const FOLDER_MEMBERSHIP_LIST_PAGE_MAX = 2000;
const FOLDER_RECON_SCAN_PAGE_SIZE = Math.max(1, Math.floor(FOLDER_RECON_CONFIG.folderScanPageSize));
const FOLDER_MEMBERSHIP_ASSIGN_BATCH_SIZE = Math.max(1, Math.min(
  FOLDER_MEMBERSHIP_ASSIGN_BATCH_MAX,
  Math.floor(FOLDER_RECON_CONFIG.membershipAssignBatchSize),
));
const FOLDER_MEMBERSHIP_LIST_PAGE_SIZE = Math.max(1, Math.min(
  FOLDER_MEMBERSHIP_LIST_PAGE_MAX,
  Math.floor(FOLDER_RECON_CONFIG.membershipListPageSize),
));
const FOLDER_MEMBERSHIP_STATE_PAGE_SIZE = Math.max(1, Math.min(
  FOLDER_MEMBERSHIP_LIST_PAGE_MAX,
  Math.floor(FOLDER_RECON_CONFIG.membershipStatePageSize),
));
const FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES = FOLDER_RECON_CONFIG.digestWorkChunkEntries;
const FOLDER_RECON_MISSING_PAGE_KEYS = FOLDER_RECON_CONFIG.missingPageKeys;
const FOLDER_RECON_STALE_PAGE_KEYS = FOLDER_RECON_CONFIG.stalePageKeys;
const FOLDER_RECON_STALE_PAGES_PER_SLICE = FOLDER_RECON_CONFIG.stalePagesPerSlice;
const FOLDER_RECON_RECHECKS_PER_SLICE = FOLDER_RECON_CONFIG.rechecksPerSlice;
const FOLDER_RECON_ORPHAN_BASIS_FOLDERS_PER_SLICE = FOLDER_RECON_CONFIG.orphanBasisFoldersPerSlice;
const FOLDER_RECON_ENQUEUES_PER_SLICE = FOLDER_RECON_CONFIG.enqueuesPerSlice;
const FOLDER_RECON_PENDING_HIGH_WATER = FOLDER_RECON_CONFIG.pendingHighWater;
const FOLDER_RECON_PENDING_LOW_WATER = FOLDER_RECON_CONFIG.pendingLowWater;
const FOLDER_RECON_PACE_DELAY_MS = FOLDER_RECON_CONFIG.paceDelayMs;
const FOLDER_RECON_PRESSURE_DELAY_MS = FOLDER_RECON_CONFIG.pressureDelayMs;
const FOLDER_RECON_ERROR_DELAY_MS = FOLDER_RECON_CONFIG.errorDelayMs;
const FOLDER_RECON_BACKOFF_WAIT_CAP_MS = FOLDER_RECON_CONFIG.backoffWaitCapMs;
const FOLDER_RECON_SYNC_QUIET_MS = FOLDER_RECON_CONFIG.syncQuietMs;
const FOLDER_RECON_REVERIFY_INTERVAL_MS = FOLDER_RECON_CONFIG.reverifyIntervalMs;
const FOLDER_RECON_WALK_PERIOD_MS = FOLDER_RECON_CONFIG.walkPeriodMs;
const FOLDER_RECON_MEMBERSHIP_UNRESOLVED_RETRY_MS = FOLDER_RECON_CONFIG.membershipUnresolvedRetryMs;
const FOLDER_RECON_CHANGE_LEDGER_CAP = FOLDER_RECON_CONFIG.changeLedgerCap;
const FOLDER_RECON_CHANGE_LEDGER_KEY_CAP = FOLDER_RECON_CONFIG.changeLedgerKeyCap;
// A completed add-side sweep that still fails exact equality is replayed once
// immediately (transient native filter failures recover without delay). If the
// same exact set/key-map proof fails again after that replay, subsequent full
// replays use durable exponential wall-clock backoff. The cap preserves
// eventual healing without letting permanently unindexable rows repeatedly
// consume the shared enqueue budget on every startup.
const FOLDER_RECON_POST_VERIFY_BACKOFF_INITIAL_MS = 6 * 60 * 60 * 1000;
const FOLDER_RECON_POST_VERIFY_BACKOFF_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const FOLDER_RECON_GENERIC_FAILURE_BACKOFF_MAX_MS = 5 * 60 * 1000;
// Cap of the doubling inventory re-read while rows of an unloaded account
// keep the pass from completing.
const FOLDER_RECON_INVENTORY_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

function _sanitizeFolderReconRetryNotBeforeMs(value, nowMs) {
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return Math.min(value, nowMs + FOLDER_RECON_POST_VERIFY_BACKOFF_MAX_MS);
}

// Feature detection for the native fingerprint/range RPCs (helper ≥ 0.11.0).
// null = not probed on the current native connection; otherwise
// {connectionGeneration, supported}. A "method unknown" verdict describes one
// helper process only: a reconnect (helper upgrade) re-probes, and the
// connection listener wakes the otherwise idle scheduler to do so.
let _folderReconNativeSupport = null;
// Transient probe failures on the current connection; drives retry backoff.
let _folderReconNativeProbeFailures = { connectionGeneration: null, count: 0 };
let _folderReconConnectionUnsubscribe = null;
// The additive relation is never trusted merely because a durable marker
// exists. Every add-on session earns global cleanup from a stable bounded
// membership-state pass with no unresolved row; the pass classifies and
// assigns every ownerless row and removes every stale owner itself. Exact
// folder work does not wait for it (an ownerless or stale-owner row is in no
// owner listing, so it can only show a deficit); only orphan and session
// completion do.
let _folderMembershipCleanupProven = false;
// While cleanup is incomplete, scheduler slices alternate between one
// state-pass page ("pass") and folder work ("folders"), so neither starves
// the other. Volatile, like the pass.
let _folderReconMembershipTurn = "pass";
// Session-local global membership-state pass, bound to the reconciliation
// generation, the live-folder inventory digest and the native connection
// generation. It is never persisted: a restart or any binding change starts a
// new pass from before-first, and only its in-process completion can grant
// cutover. Persisting it rewrote the whole folder memo per state page.
let _folderMembershipStatePass = null;
let _folderMembershipCapabilityState = null;
let _folderMembershipPageBudget = 0;
let _folderMembershipDigestSessions = new Map();
let _folderMembershipDigestResults = new Map();
// Folder id -> walk-mark serial captured when a reconcile attempt that
// yielded (page budget or foreground pressure) started; it resumes on a later
// slice with its digest proofs and that serial. Any other attempt
// end retires the digests: a native write can commit physically after its
// RPC settles without moving the membership epoch, so a digest cached by an
// earlier attempt is never reused to certify a later one.
let _folderMembershipYieldedAttempts = new Map();
// Compatibility/debug view of folders waiting for the shared incremental
// drain. Unlike the old single-shot rerun, the scheduler revisits these after
// every low-water transition until equality is proven.
let _folderReconDrainSkipped = new Set();
let _folderReconInProgressOwner = null;
// Folder identities whose equality has not yet been proven in this live
// session. Unlike per-slice stats, this survives drain-triggered revisits.
let _folderReconUnverified = new Set();
// Test-only override for per-slice work budgets (null in production).
let _folderReconBudgetOverride = null;
// Cooperative session scheduler state. A generation bump invalidates every
// in-flight scan/write after dispose or re-init. Session completion is only a
// work-saving hint; durable cursors and proof state live in the v3 memo.
let _folderReconTimer = null;
let _folderReconTimerToken = 0;
let _folderReconTimerDueMs = 0;
let _folderReconRequestedDueMs = Infinity;
let _folderReconHardNotBeforeMs = 0;
// Exact mode's rolling re-walk tick (0 = not armed). Set by the first
// exact-mode tick of a generation; only a tick holding the reconcile lease
// consumes and renews it, so skipped ticks can never postpone it.
let _folderReconRollingDueMs = 0;
// Folder key -> when its next rolling walk is due (exact mode, volatile).
let _folderReconNextWalkDueMs = new Map();
// Folder keys of the latest inventory; marking every folder covers them.
let _folderReconKnownFolderKeys = new Set();
let _folderReconSchedulerOwner = null;
let _folderReconGeneration = 0;
let _folderReconSessionDone = new Set();
let _folderReconSessionDeferred = new Map();
let _folderReconFailureCounts = new Map();
// Incremental-drain failures use their own generation-local fairness state.
// This keeps a broken active folder from pinning the one working proof while
// preserving every queued intention for the ordinary retry pipeline.
let _folderReconDrainFailureDeferred = new Map();
let _folderReconDrainFailureCounts = new Map();
// Folder key -> serial of its newest walk mark: the outstanding-walk
// obligations. The orphan tail's quiet predicate refuses while any remains.
let _folderReconDirty = new Map();
let _folderReconMarkSerial = 0;
let _folderReconOrphanDone = false;
let _folderReconOrphanPass = null;
// Round-robin fairness anchor for this session, seeded from the memo. It is
// persisted only alongside a memo write that happens anyway, never on its own.
let _folderReconRoundRobinCursor = null;
// Capped re-inventory backoff while only rows of unloaded accounts remain.
let _folderReconInventoryRetry = null;
// Folder-scoped local change ledger (message events and exclusive index
// rewrites). A proof about folder C is invalidated only by a change to C or
// by the wildcard (an event without a folder, an exclusive rewrite). The
// serial is never reset; evicting an entry raises the floor so an older
// stamp is treated as changed, never as valid.
let _folderReconLocalSerial = 0;
const _folderReconLocalTouched = new Map();
let _folderReconLocalWildcard = 0;
let _folderReconLocalFloor = 0;
// Key-scoped local ledger beside it, for verdicts about one raw key: each
// event's raw key (and each queue admission's), with its own cap and floor.
// A folder event that names no raw key voids every key that folder's range
// holds. Evicting either raises the key floor, never the folder floor.
const _folderReconLocalTouchedKeys = new Map();
const _folderReconLocalKeylessFolders = new Map();
let _folderReconLocalKeyFloor = 0;
// One phase-tagged active-folder proof is retained for this generation. It is
// the scalar exact projection plus the one sorted Uint32Array inherently
// needed by missing repair — never a multi-folder cache, Thunderbird object,
// scan token, Message-ID array, or durable value.
let _folderReconActiveProof = null;
let _folderReconWorkingProofStats = {
  scans: 0,
  reuses: 0,
  invalidations: 0,
  releases: 0,
};
let _folderReconRuntimeTelemetry = null;
let _folderReconOutcomeAggregate = null;
const FOLDER_RECON_OUTCOME_PERSIST_INTERVAL_MS = 30 * 1000;
const FOLDER_RECON_OUTCOME_FIELDS = [
  "foldersTotal", "foldersErrored", "foldersDrainBusy", "foldersMemoHit",
  "foldersClean", "foldersReconciled", "foldersFailed", "foldersBudgetPartial",
  "foldersLocalDrift", "foldersBackoff", "staleCandidates", "staleRemoved",
  "recheckKeptPresent", "recheckKeptError", "missingEnqueued", "orphanRemoved",
  "orphanKeysKept",
];
// Outcome fields a read-only verified slice moves; any other field moving
// means the slice changed something worth a snapshot.
const FOLDER_RECON_READ_ONLY_OUTCOME_FIELDS = new Set(["foldersTotal", "foldersMemoHit"]);

function _folderReconOutcomeChanged(counts) {
  return FOLDER_RECON_OUTCOME_FIELDS.some(field =>
    !FOLDER_RECON_READ_ONLY_OUTCOME_FIELDS.has(field) && Number(counts?.[field]) > 0);
}

const _folderReconEncoder = new TextEncoder();

function _noteFolderReconLocalChange(folderKey, rawKeys = null) {
  _folderReconLocalSerial = Math.min(Number.MAX_SAFE_INTEGER, _folderReconLocalSerial + 1);
  if (!folderKey) {
    _folderReconLocalWildcard = _folderReconLocalSerial;
    return;
  }
  _folderReconLocalTouched.delete(folderKey);
  _folderReconLocalTouched.set(folderKey, _folderReconLocalSerial);
  while (_folderReconLocalTouched.size > FOLDER_RECON_CHANGE_LEDGER_CAP) {
    const [oldest, oldestSerial] = _folderReconLocalTouched.entries().next().value;
    _folderReconLocalTouched.delete(oldest);
    _folderReconLocalFloor = Math.max(_folderReconLocalFloor, oldestSerial);
  }
  if (rawKeys?.length > 0) _recordFolderReconLocalKeys(_folderReconLocalTouchedKeys, rawKeys);
  else _recordFolderReconLocalKeys(_folderReconLocalKeylessFolders, [folderKey]);
}

function _recordFolderReconLocalKeys(ledger, keys) {
  for (const key of keys) {
    ledger.delete(key);
    ledger.set(key, _folderReconLocalSerial);
  }
  while (ledger.size > FOLDER_RECON_CHANGE_LEDGER_KEY_CAP) {
    const [oldest, oldestSerial] = ledger.entries().next().value;
    ledger.delete(oldest);
    _folderReconLocalKeyFloor = Math.max(_folderReconLocalKeyFloor, oldestSerial);
  }
}

// A queue admission (or a high-water rejection) touches only its raw key; it
// is recorded synchronously at the admission's entry.
function _noteFolderReconLocalKey(rawKey) {
  _folderReconLocalSerial = Math.min(Number.MAX_SAFE_INTEGER, _folderReconLocalSerial + 1);
  _recordFolderReconLocalKeys(_folderReconLocalTouchedKeys, [rawKey]);
}

// True when no local change to `folderKey` (or wildcard change) happened
// after `since` was read from _folderReconLocalSerial.
function _folderReconLocalUnchangedSince(folderKey, since) {
  return _folderReconLocalFoldersUnchangedSince([folderKey], since);
}

function _folderReconLocalFoldersUnchangedSince(folderKeys, since) {
  return Number.isFinite(since)
    && since >= _folderReconLocalFloor
    && since >= _folderReconLocalWildcard
    && folderKeys.every(folderKey => (_folderReconLocalTouched.get(folderKey) ?? 0) <= since);
}

// Page-wide local evidence for a verdict read since `since`: no event that
// named no folder.
function _folderReconLocalWildcardUnchangedSince(since) {
  return Number.isFinite(since) && since >= _folderReconLocalWildcard;
}

// Row-scoped: no event since `since` touched the raw key itself, and no
// keyless event touched a folder whose range holds it (whether or not the
// inventory lists that folder), and the key floor has not passed `since`.
function _folderReconLocalExactKeyUnchangedSince(rawKey, since) {
  if (!_folderReconLocalWildcardUnchangedSince(since) || since < _folderReconLocalKeyFloor) return false;
  if ((_folderReconLocalTouchedKeys.get(rawKey) ?? 0) > since) return false;
  for (const [folderKey, serial] of _folderReconLocalKeylessFolders) {
    if (serial > since && rawKey.startsWith(`${folderKey}:`)) return false;
  }
  return true;
}

function _folderReconLocalScope(folderKey) {
  return { folderKey, since: _folderReconLocalSerial };
}

// The native ledger scope of a folder's proofs; a folder without a durable
// membership id falls back to the global check.
function _folderReconNativeScope(f) {
  return f?.folderId ? [f.folderId] : "*";
}

function _handleExclusiveFtsMembershipChange() {
  if (!_isEnabled || _indexerDisposed) return;
  _noteFolderReconLocalChange(null);
  // Marks every folder known so far, before the completed set is cleared.
  _markAllFolderReconWalks();
  _folderReconSessionDone.clear();
  _folderReconSessionDeferred.clear();
  _folderReconFailureCounts.clear();
  _folderReconDrainFailureDeferred.clear();
  _folderReconDrainFailureCounts.clear();
  _folderReconOrphanDone = false;
  _folderReconOrphanPass = null;
  _revokeFolderMembershipCleanup();
  _resetFolderMembershipVolatileProof();
  _releaseFolderReconActiveProof(null, "invalidation");
  // The coordinator invokes this only after releasing exclusive ownership,
  // and every proof class above is already invalidated.
  _wakeFolderRecon("exclusive_membership_change", FOLDER_RECON_PACE_DELAY_MS);
}

addFtsExclusiveMembershipChangeListener(_handleExclusiveFtsMembershipChange);

function _newFolderReconRuntimeTelemetry() {
  return {
    scanPages: 0,
    scanHeaders: 0,
    schedulerTicks: 0,
    schedulerSlices: 0,
    schedulerPressureSkips: 0,
    schedulerBusySkips: 0,
    lastSliceElapsedMs: 0,
    maxSliceElapsedMs: 0,
    lastScheduledDelayMs: 0,
    maxScheduledDelayMs: 0,
    maxPendingObserved: 0,
    ambiguousGroups: 0,
    ambiguousFolders: 0,
    unloadedAccountRowsKept: 0,
    membershipStatePages: 0,
    membershipStatePageRetries: 0,
    membershipStateRowsRefused: 0,
    membershipStateRestartMutatedReplay: 0,
    membershipStateRestartUnresolvedReplay: 0,
    membershipStateRestartRevoked: 0,
    membershipStateRestartBindingChanged: 0,
    membershipStateRestartPageInvalid: 0,
    membershipCutovers: 0,
    membershipLastPassSlices: 0,
  };
}

function _resetFolderReconRuntimeTelemetry() {
  _folderReconRuntimeTelemetry = _newFolderReconRuntimeTelemetry();
  _folderReconOutcomeAggregate = {
    generation: _folderReconGeneration,
    startedAtMs: Date.now(),
    slices: 0,
    totals: Object.fromEntries(FOLDER_RECON_OUTCOME_FIELDS.map(field => [field, 0])),
    latest: Object.fromEntries(FOLDER_RECON_OUTCOME_FIELDS.map(field => [field, 0])),
    unverifiedFolders: 0,
    lastElapsedMs: 0,
    lastPersistedAtMs: 0,
    complete: false,
    // A meaningful slice outcome not yet in storage; cleared only by a
    // successful write that covers it, so a failed write is retried.
    dirty: false,
    changeSerial: 0,
    // Completion state of the last successful write (null = none written).
    persistedComplete: null,
  };
}

function _folderReconOutcomeStatus() {
  if (!_folderReconOutcomeAggregate) _resetFolderReconRuntimeTelemetry();
  const aggregate = _folderReconOutcomeAggregate;
  return {
    slices: aggregate.slices,
    totals: { ...aggregate.totals },
    latest: { ...aggregate.latest },
    unverifiedFolders: aggregate.unverifiedFolders,
    lastElapsedMs: aggregate.lastElapsedMs,
    complete: aggregate.complete,
  };
}

function _persistFolderReconOutcome(force = false) {
  const aggregate = _folderReconOutcomeAggregate;
  if (!aggregate || aggregate.slices === 0) return;
  // Write only a meaningful change, or the completion of a session whose
  // change was written as incomplete. Read-only and unchanged passes
  // (including every later re-verification) write nothing.
  const completionUnwritten = aggregate.complete && aggregate.persistedComplete === false;
  if (!aggregate.dirty && !completionUnwritten) return;
  const nowMs = Date.now();
  if (!force
      && aggregate.lastPersistedAtMs > 0
      && nowMs - aggregate.lastPersistedAtMs < FOLDER_RECON_OUTCOME_PERSIST_INTERVAL_MS) {
    return;
  }
  aggregate.lastPersistedAtMs = nowMs;
  const changeSerial = aggregate.changeSerial;
  const complete = aggregate.complete;
  _writeReconSnapshot("fts_folder_recon_last", {
    generation: aggregate.generation,
    startedAtMs: aggregate.startedAtMs,
    slices: aggregate.slices,
    totals: { ...aggregate.totals },
    latest: { ...aggregate.latest },
    unverifiedFolders: aggregate.unverifiedFolders,
    lastElapsedMs: aggregate.lastElapsedMs,
    complete,
    activeWorkingProof: _folderReconWorkingProofTelemetry(),
  }).then((written) => {
    if (!written) return;
    if (aggregate.changeSerial === changeSerial) aggregate.dirty = false;
    aggregate.persistedComplete = complete;
  });
}

function _completeFolderReconOutcome() {
  if (_folderReconOutcomeAggregate) _folderReconOutcomeAggregate.complete = true;
  _persistFolderReconOutcome(true);
}

function _recordFolderReconOutcome(stats, elapsedMs) {
  if (!_folderReconOutcomeAggregate
      || _folderReconOutcomeAggregate.generation !== _folderReconGeneration) {
    _resetFolderReconRuntimeTelemetry();
  }
  const aggregate = _folderReconOutcomeAggregate;
  aggregate.slices++;
  for (const field of FOLDER_RECON_OUTCOME_FIELDS) {
    const value = Math.max(0, Number(stats?.[field]) || 0);
    aggregate.latest[field] = value;
    aggregate.totals[field] = Math.min(Number.MAX_SAFE_INTEGER, aggregate.totals[field] + value);
  }
  aggregate.unverifiedFolders = Math.max(0, Number(stats?.unverifiedFolders) || 0);
  aggregate.lastElapsedMs = Math.max(0, Number(elapsedMs) || 0);
  if (_folderReconOutcomeChanged(stats)) {
    // A pass that found or repaired a deficit (a periodic one included)
    // reopens the session: it is complete again only when a later pass
    // completes clean (_completeFolderReconOutcome).
    aggregate.complete = false;
    aggregate.dirty = true;
    aggregate.changeSerial++;
    _persistFolderReconOutcome(false);
  }
}

function _bumpFolderReconTelemetry(field, amount = 1) {
  if (!_folderReconRuntimeTelemetry) _resetFolderReconRuntimeTelemetry();
  _folderReconRuntimeTelemetry[field] = Math.min(
    Number.MAX_SAFE_INTEGER,
    _folderReconRuntimeTelemetry[field] + Math.max(0, amount),
  );
}

function _noteFolderReconPendingSize() {
  if (!_folderReconRuntimeTelemetry) _resetFolderReconRuntimeTelemetry();
  _folderReconRuntimeTelemetry.maxPendingObserved = Math.max(
    _folderReconRuntimeTelemetry.maxPendingObserved,
    _pendingUpdates.size,
  );
}

function _folderReconYield(delayMs = FOLDER_RECON_CHUNK_DELAY_MS) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, delayMs)));
}

function _hasFolderReconForegroundPressure() {
  let pressure = {};
  try { pressure = getForegroundFetchPressure() || {}; } catch (_) {}
  return _isProcessing
    || _pendingUpdates.size > FOLDER_RECON_PENDING_LOW_WATER
    || pressure.active > 0
    || pressure.waiting > 0
    || pressure.chatTyping === true;
}

function _assertNoFolderReconForegroundPressure() {
  if (_hasFolderReconForegroundPressure()) throw new Error("folder_recon_pressure");
}

function _bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

// WebCrypto has no streaming digest API. Native membership readers are
// deliberately page-bounded, so retaining every returned msgId and one giant
// framed buffer would defeat that bound on mature profiles. This small SHA-256
// accumulator consumes the exact existing framing incrementally; scheduler
// page boundaries remain the cooperative yield/pressure boundaries.
const FOLDER_RECON_SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function _folderReconRotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

class _FolderReconSha256 {
  constructor() {
    this._state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this._buffer = new Uint8Array(64);
    this._bufferLength = 0;
    this._bytesHashed = 0n;
    this._finished = false;
  }

  update(bytes) {
    if (this._finished) throw new Error("folder_membership_digest_finished");
    this._bytesHashed += BigInt(bytes.length);
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(64 - this._bufferLength, bytes.length - offset);
      this._buffer.set(bytes.subarray(offset, offset + take), this._bufferLength);
      this._bufferLength += take;
      offset += take;
      if (this._bufferLength === 64) {
        this._compress(this._buffer);
        this._bufferLength = 0;
      }
    }
  }

  _compress(block) {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = _folderReconRotateRight(x, 7)
        ^ _folderReconRotateRight(x, 18)
        ^ (x >>> 3);
      const s1 = _folderReconRotateRight(y, 17)
        ^ _folderReconRotateRight(y, 19)
        ^ (y >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this._state;
    for (let i = 0; i < 64; i++) {
      const sum1 = _folderReconRotateRight(e, 6)
        ^ _folderReconRotateRight(e, 11)
        ^ _folderReconRotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choice + FOLDER_RECON_SHA256_K[i] + words[i]) >>> 0;
      const sum0 = _folderReconRotateRight(a, 2)
        ^ _folderReconRotateRight(a, 13)
        ^ _folderReconRotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this._state[0] = (this._state[0] + a) >>> 0;
    this._state[1] = (this._state[1] + b) >>> 0;
    this._state[2] = (this._state[2] + c) >>> 0;
    this._state[3] = (this._state[3] + d) >>> 0;
    this._state[4] = (this._state[4] + e) >>> 0;
    this._state[5] = (this._state[5] + f) >>> 0;
    this._state[6] = (this._state[6] + g) >>> 0;
    this._state[7] = (this._state[7] + h) >>> 0;
  }

  digest() {
    if (this._finished) throw new Error("folder_membership_digest_finished");
    this._finished = true;
    const bitLength = this._bytesHashed * 8n;
    const finalLength = this._bufferLength < 56 ? 64 : 128;
    const final = new Uint8Array(finalLength);
    final.set(this._buffer.subarray(0, this._bufferLength));
    final[this._bufferLength] = 0x80;
    const view = new DataView(final.buffer);
    view.setUint32(finalLength - 8, Number((bitLength >> 32n) & 0xffffffffn), false);
    view.setUint32(finalLength - 4, Number(bitLength & 0xffffffffn), false);
    for (let offset = 0; offset < finalLength; offset += 64) {
      this._compress(final.subarray(offset, offset + 64));
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < this._state.length; i++) {
      outView.setUint32(i * 4, this._state[i], false);
    }
    return out;
  }
}

function _updateFolderReconFramedDigest(hasher, value) {
  const bytes = _folderReconEncoder.encode(value);
  const frame = new Uint8Array(8);
  const view = new DataView(frame.buffer);
  view.setUint32(0, Math.floor(bytes.length / 0x100000000), false);
  view.setUint32(4, bytes.length >>> 0, false);
  hasher.update(frame);
  hasher.update(bytes);
}

function _compareFolderReconEncoded(a, b) {
  const shared = Math.min(a.bytes.length, b.bytes.length);
  for (let i = 0; i < shared; i++) {
    if (a.bytes[i] !== b.bytes[i]) return a.bytes[i] - b.bytes[i];
  }
  return a.bytes.length - b.bytes.length;
}

function _folderReconEncodedEqual(a, b) {
  return _compareFolderReconEncoded(a, b) === 0;
}

async function _cooperativeEncodeAndSortStrings(values, assertActive = () => {}) {
  assertActive();
  if (values.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < values.length; i += FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES) {
    const chunk = [];
    const end = Math.min(values.length, i + FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES);
    for (let j = i; j < end; j++) {
      chunk.push({ value: values[j], bytes: _folderReconEncoder.encode(values[j]) });
    }
    assertActive();
    chunk.sort(_compareFolderReconEncoded);
    assertActive();
    chunks.push(chunk);
    if (i + FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES < values.length) {
      assertActive();
      await _folderReconYield(0);
      assertActive();
    }
  }
  while (chunks.length > 1) {
    const merged = [];
    for (let i = 0; i < chunks.length; i += 2) {
      if (i + 1 >= chunks.length) {
        merged.push(chunks[i]);
        continue;
      }
      const left = chunks[i];
      const right = chunks[i + 1];
      const out = new Array(left.length + right.length);
      let a = 0;
      let b = 0;
      let o = 0;
      while (a < left.length || b < right.length) {
        out[o++] = b >= right.length
          || (a < left.length && _compareFolderReconEncoded(left[a], right[b]) <= 0)
          ? left[a++]
          : right[b++];
        if (o % FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES === 0) {
          assertActive();
          await _folderReconYield(0);
          assertActive();
        }
      }
      merged.push(out);
    }
    chunks.splice(0, chunks.length, ...merged);
  }
  return chunks[0];
}

async function _fingerprintStringsCooperatively(values, dedupe = false, assertActive = () => {}) {
  assertActive();
  let sorted = await _cooperativeEncodeAndSortStrings(values, assertActive);
  assertActive();
  if (dedupe && sorted.length > 1) {
    const unique = [];
    for (let i = 0; i < sorted.length; i++) {
      if (i === 0 || !_folderReconEncodedEqual(sorted[i], sorted[i - 1])) unique.push(sorted[i]);
      if ((i + 1) % FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES === 0) {
        assertActive();
        await _folderReconYield(0);
        assertActive();
      }
    }
    sorted = unique;
  }
  let totalBytes = 0;
  for (let i = 0; i < sorted.length; i++) {
    totalBytes += 8 + sorted[i].bytes.length;
    if ((i + 1) % FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES === 0) {
      assertActive();
      await _folderReconYield(0);
      assertActive();
    }
  }
  const framed = new Uint8Array(totalBytes);
  const view = new DataView(framed.buffer);
  let offset = 0;
  for (let i = 0; i < sorted.length; i++) {
    const bytes = sorted[i].bytes;
    view.setUint32(offset, Math.floor(bytes.length / 0x100000000), false);
    view.setUint32(offset + 4, bytes.length >>> 0, false);
    framed.set(bytes, offset + 8);
    offset += 8 + bytes.length;
    if ((i + 1) % FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES === 0) {
      assertActive();
      await _folderReconYield(0);
      assertActive();
    }
  }
  assertActive();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", framed));
  assertActive();
  return {
    count: sorted.length,
    sha256: _bytesToHex(digest),
  };
}

async function _fingerprintMsgKeysCooperatively(keys, assertActive = () => {}) {
  assertActive();
  // Fixed-width hex preserves unsigned numeric order under string sorting.
  const hexKeys = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    hexKeys[i] = (keys[i] >>> 0).toString(16).padStart(8, "0");
    if ((i + 1) % FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES === 0) {
      assertActive();
      await _folderReconYield(0);
      assertActive();
    }
  }
  const orderedHex = await _cooperativeEncodeAndSortStrings(hexKeys, assertActive);
  assertActive();
  const bytes = new Uint8Array(orderedHex.length * 4);
  const sorted = new Uint32Array(orderedHex.length);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < orderedHex.length; i++) {
    const key = Number.parseInt(orderedHex[i].value, 16);
    sorted[i] = key;
    view.setUint32(i * 4, key, false);
    if ((i + 1) % FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES === 0) {
      assertActive();
      await _folderReconYield(0);
      assertActive();
    }
  }
  assertActive();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  assertActive();
  return { count: orderedHex.length, sha256: _bytesToHex(digest), sorted };
}

// `localScope` ({ folderKey, since }) additionally requires that folder to be
// locally unchanged; changes to other folders never fail it.
function _assertFolderReconGeneration(generation, localScope = null) {
  if (!_isEnabled || generation !== _folderReconGeneration) {
    throw new Error("folder_recon_cancelled");
  }
  if (localScope && !_folderReconLocalUnchangedSince(localScope.folderKey, localScope.since)) {
    throw new Error("folder_changed_during_scan");
  }
}

function _assertFolderReconLease(lease, generation, localScope = null) {
  if (!lease || lease.released || lease.cancelRequested) throw new Error("folder_recon_cancelled");
  _assertFolderReconGeneration(generation, localScope);
}

function _throwIfFolderReconInterrupted(error) {
  const message = String(error?.message || error);
  if (message.includes("folder_recon_cancelled")
      || message.includes("folder_recon_pressure")
      || message.includes("folder_membership_page_pending")) {
    throw error;
  }
}

async function _assertFolderReconMembershipEpoch(expectedEpoch, reconcileLease, generation, scope = null) {
  await withFtsMembershipFence(expectedEpoch, () => {
    if (reconcileLease) _assertFolderReconLease(reconcileLease, generation);
  }, { scope });
}

async function _readFolderReconScanGateStrict() {
  const stored = await browser.storage.local.get([
    FOLDER_RECON_INITIAL_SCAN_KEY,
    "fts_scan_status",
  ]);
  if (!stored?.[FOLDER_RECON_INITIAL_SCAN_KEY]) {
    return { allowed: false, reason: "initial_scan_incomplete" };
  }
  if (stored?.fts_scan_status?.isScanning) {
    // Callers hold a live reconcile lease before entering this gate. A truly
    // live exclusive owner therefore cannot coexist with this read; an active
    // durable record is ownerless residue (for example, a failed final status
    // write) unless the coordinator proves otherwise. Normalize it without a
    // TTL, then strictly re-read so storage uncertainty still fails closed.
    await normalizeInterruptedFtsScanStatus();
    const refreshed = await browser.storage.local.get("fts_scan_status");
    if (refreshed?.fts_scan_status?.isScanning) {
      return { allowed: false, reason: "scan_in_progress" };
    }
  }
  return { allowed: true };
}

/**
 * Pull an exact folder snapshot through an opaque live nsIMsgEnumerator.
 * Each Experiment call visits at most folderScanPageSize headers. The token is
 * intentionally not persisted; restart begins a fresh proof and can repeat
 * work but can never skip rows or mint equality from a mixed snapshot.
 */
async function _scanFolderMessagesCooperatively(
  f,
  generation = _folderReconGeneration,
  includeMessageIds = true,
) {
  const localScope = _folderReconLocalScope(`${f.accountId}:${f.folderPath}`);
  const reconcileLease = _folderReconInProgressOwner?.generation === generation
    ? _folderReconInProgressOwner.reconcileLease
    : (_folderReconSchedulerOwner?.generation === generation
      ? _folderReconSchedulerOwner.reconcileLease
      : null);
  const assertCurrent = () => reconcileLease
    ? _assertFolderReconLease(reconcileLease, generation, localScope)
    : _assertFolderReconGeneration(generation, localScope);
  const assertWorkCurrent = () => {
    // Mutation/generation cancellation is the more specific reason and must
    // win when both it and foreground pressure become visible together.
    assertCurrent();
    if (_hasFolderReconForegroundPressure()) throw new Error("folder_recon_pressure");
  };
  let token = null;
  let completed = false;
  try {
    const started = await browser.tmMsgNotify.beginFolderMessageScan(
      f.folderURI,
      includeMessageIds === true,
    );
    assertCurrent();
    if (started?.error || !started?.token) throw new Error(started?.error || "scan_start_failed");
    token = started.token;
    if ((started.accountId && started.accountId !== f.accountId)
        || (started.folderPath && started.folderPath !== f.folderPath)) {
      throw new Error("folder_identity_changed");
    }
    const keys = [];
    const uniqueKeys = [];
    const keyMappings = [];
    let unkeyedCount = 0;
    for (;;) {
      assertCurrent();
      const page = await browser.tmMsgNotify.readFolderMessageScanPage(
        token,
        FOLDER_RECON_SCAN_PAGE_SIZE,
      );
      assertCurrent();
      if (page?.error) throw new Error(page.error);
      const rows = page?.rows || [];
      for (const row of rows) {
        const normalizedKey = _normalizeMsgKeyCursor(row?.msgKey);
        if (normalizedKey !== null) keys.push(normalizedKey);
        if (includeMessageIds !== true) continue;
        const headerMessageId = String(row?.headerMessageId || "").replace(/[<>]/g, "");
        if (!headerMessageId) {
          unkeyedCount += 1;
          continue;
        }
        const uniqueKey = `${f.accountId}:${f.folderPath}:${headerMessageId}`;
        uniqueKeys.push(uniqueKey);
        if (normalizedKey !== null) keyMappings.push(`${normalizedKey}:${uniqueKey}`);
      }
      assertCurrent();
      _bumpFolderReconTelemetry("scanPages");
      _bumpFolderReconTelemetry("scanHeaders", rows.length);
      // The terminal page can be the largest page in a folder. Foreground
      // pressure arising during that parent call must preempt before any
      // data-sized encode/sort/digest phase, just like a non-terminal page.
      assertWorkCurrent();
      if (page?.done) {
        completed = true;
        break;
      }
      // Foreground body work can begin after the scheduler's initial gate.
      // Abandoning this non-durable token at a page boundary is safe: the next
      // quiet slice restarts the exact snapshot and cannot skip a row.
      await _folderReconYield();
      assertWorkCurrent();
    }
    const uid = await _fingerprintMsgKeysCooperatively(keys, assertWorkCurrent);
    assertWorkCurrent();
    const common = {
      accountId: f.accountId,
      folderPath: f.folderPath,
      uidCount: uid.count,
      uidSha256: uid.sha256,
      localScope,
      serverType: started.serverType || f.serverType || "",
      stableUidKeys: started.stableUidKeys === true,
      uidValidity: started.uidValidity,
      highestModSeq: started.highestModSeq || "",
    };
    if (includeMessageIds !== true) {
      return { ...common, proofKind: "uid_only" };
    }
    const expected = await _fingerprintStringsCooperatively(uniqueKeys, true, assertWorkCurrent);
    assertWorkCurrent();
    const keyMap = await _fingerprintStringsCooperatively(keyMappings, false, assertWorkCurrent);
    assertWorkCurrent();
    return {
      ...common,
      proofKind: "full",
      count: expected.count,
      sha256: expected.sha256,
      keyMapCount: keyMap.count,
      keyMapSha256: keyMap.sha256,
      sortedKeys: uid.sorted,
      unkeyedCount,
    };
  } finally {
    if (token && !completed) {
      try { await browser.tmMsgNotify.cancelFolderMessageScan(token); } catch (_) {}
    }
  }
}

function _releaseFolderReconActiveProof(folderKey = null, reason = "release") {
  const entry = _folderReconActiveProof;
  if (!entry || (folderKey && entry.folderKey !== folderKey)) return false;
  _folderReconActiveProof = null;
  if (reason === "invalidation") _folderReconWorkingProofStats.invalidations++;
  else _folderReconWorkingProofStats.releases++;
  return true;
}

function _clearFolderReconActiveProof({ resetStats = false } = {}) {
  _folderReconActiveProof = null;
  if (resetStats) {
    _folderReconWorkingProofStats = {
      scans: 0,
      reuses: 0,
      invalidations: 0,
      releases: 0,
    };
  }
}

function _folderReconWorkingProofTelemetry() {
  return {
    ..._folderReconWorkingProofStats,
    active: _folderReconActiveProof ? 1 : 0,
    phase: _folderReconActiveProof?.phase || "none",
    keyCount: _folderReconActiveProof?.sortedKeys?.length || 0,
    keyBytes: _folderReconActiveProof?.sortedKeys?.byteLength || 0,
  };
}

function _folderReconActiveProofValid(entry, f, generation) {
  if (!entry || !_isEnabled || _indexerDisposed) return false;
  if (entry.generation !== generation || generation !== _folderReconGeneration) return false;
  if (entry.accountId !== f.accountId
      || entry.folderPath !== f.folderPath
      || entry.folderURI !== f.folderURI
      || entry.serverType !== (f.serverType || "")
      || entry.stableUidKeys !== (f.stableUidKeys === true)) {
    return false;
  }
  if (entry.stableUidKeys) {
    const cachedEpoch = _normalizeUidValidity(entry.uidValidity);
    const currentEpoch = _normalizeUidValidity(f.uidValidity);
    if (cachedEpoch === null || currentEpoch === null || cachedEpoch !== currentEpoch) return false;
  }
  return true;
}

function _folderReconProofFromRecord(entry) {
  return {
    accountId: entry.accountId,
    folderPath: entry.folderPath,
    count: entry.count,
    sha256: entry.sha256,
    keyMapCount: entry.keyMapCount,
    keyMapSha256: entry.keyMapSha256,
    uidCount: entry.uidCount,
    uidSha256: entry.uidSha256,
    sortedKeys: entry.sortedKeys,
    unkeyedCount: entry.unkeyedCount,
    localScope: entry.localScope,
    serverType: entry.serverType,
    stableUidKeys: entry.stableUidKeys,
    uidValidity: entry.uidValidity,
    highestModSeq: entry.highestModSeq,
    proofKind: "full",
    fromWorkingProof: true,
    proofGuard: { folderKey: entry.folderKey, entry },
  };
}

function _admitFolderReconActiveProof(
  folderKey,
  f,
  snapshot,
  generation = _folderReconGeneration,
  phase = "repair",
) {
  if (snapshot?.proofKind !== "full") return null;
  if (!(snapshot?.sortedKeys instanceof Uint32Array)) return null;
  if (_folderReconActiveProof && _folderReconActiveProof.folderKey !== folderKey) {
    _releaseFolderReconActiveProof(null, "advance");
  }
  // Explicit projection is intentional: never retain the discarded sorted
  // Message-ID/key-map arrays if the scanner grows new return fields later.
  const entry = {
    folderKey,
    phase,
    generation,
    accountId: f.accountId,
    folderPath: f.folderPath,
    folderURI: f.folderURI,
    serverType: snapshot.serverType || f.serverType || "",
    stableUidKeys: snapshot.stableUidKeys === true,
    uidValidity: snapshot.uidValidity,
    count: snapshot.count,
    sha256: snapshot.sha256,
    keyMapCount: snapshot.keyMapCount,
    keyMapSha256: snapshot.keyMapSha256,
    uidCount: snapshot.uidCount,
    uidSha256: snapshot.uidSha256,
    highestModSeq: snapshot.highestModSeq || "",
    unkeyedCount: snapshot.unkeyedCount || 0,
    localScope: snapshot.localScope,
    sortedKeys: snapshot.sortedKeys,
  };
  _folderReconActiveProof = entry;
  _folderReconWorkingProofStats.scans++;
  return entry;
}

function _folderReconGuardForFreshProof(folderKey, entry, snapshot) {
  return entry
    ? { folderKey, entry }
    : { generation: _folderReconGeneration, localScope: snapshot.localScope };
}

async function _getFolderReconWorkingProof(f, generation, folderKey) {
  const active = _folderReconActiveProof;
  if (_folderReconActiveProofValid(active, f, generation)
      && active.folderKey === folderKey) {
    _folderReconWorkingProofStats.reuses++;
    return _folderReconProofFromRecord(active);
  }
  if (active) _releaseFolderReconActiveProof(null, "invalidation");
  const snapshot = await _scanFolderMessagesCooperatively(f, generation, true);
  const entry = _admitFolderReconActiveProof(folderKey, f, snapshot, generation, "repair");
  return {
    ...snapshot,
    fromWorkingProof: false,
    proofGuard: _folderReconGuardForFreshProof(folderKey, entry, snapshot),
  };
}

// The experiment falls back to the server key and folder URI when it cannot
// convert the folder; only a converted folder (weFolderId) names the
// inventory folder, so anything else invalidates every folder.
function _invalidateFolderReconProofForMessageEvent(messageInfo) {
  if (!messageInfo?.weFolderId) {
    _invalidateFolderReconProofForEvent(null, null);
    return;
  }
  // The queue's raw-key shape, formed inline (getUniqueMessageKey is async).
  const headerMessageId = String(messageInfo.headerMessageId || "").replace(/[<>]/g, "");
  _invalidateFolderReconProofForEvent(
    messageInfo.accountId,
    messageInfo.folderPath,
    headerMessageId ? [`${messageInfo.accountId}:${messageInfo.folderPath}:${headerMessageId}`] : null,
  );
}

function _invalidateFolderReconProofForEvent(accountId, folderPath, rawKeys = null) {
  if (!accountId || !folderPath) {
    _noteFolderReconLocalChange(null);
    _releaseFolderReconActiveProof(null, "invalidation");
    return;
  }
  const folderKey = `${accountId}:${folderPath}`;
  _noteFolderReconLocalChange(folderKey, rawKeys);
  _releaseFolderReconActiveProof(folderKey, "invalidation");
}

function _folderReconProofGuardCurrent(guard) {
  if (!guard || guard.generation !== undefined) {
    return !!guard
      && guard.generation === _folderReconGeneration
      && _folderReconLocalUnchangedSince(guard.localScope?.folderKey, guard.localScope?.since);
  }
  return _folderReconActiveProof === guard.entry
    && guard.entry.generation === _folderReconGeneration;
}

function _folderReconLocalProofChanged(before, after) {
  return before.count !== after.count
    || before.sha256 !== after.sha256
    || before.keyMapCount !== after.keyMapCount
    || before.keyMapSha256 !== after.keyMapSha256
    || before.uidCount !== after.uidCount
    || before.uidSha256 !== after.uidSha256
    || before.unkeyedCount !== after.unkeyedCount
    || before.stableUidKeys !== after.stableUidKeys
    || _normalizeUidValidity(before.uidValidity) !== _normalizeUidValidity(after.uidValidity);
}

function _pruneFolderReconRuntimeToFolderKeys(folderKeys, folderIds = null) {
  let removedState = false;
  if (folderIds) {
    for (const folderId of [..._folderMembershipYieldedAttempts.keys()]) {
      if (!folderIds.has(folderId)) {
        _folderMembershipYieldedAttempts.delete(folderId);
        removedState = true;
      }
    }
  }
  for (const map of [_folderReconDirty, _folderReconNextWalkDueMs]) {
    for (const folderKey of [...map.keys()]) {
      if (!folderKeys.has(folderKey)) {
        map.delete(folderKey);
        removedState = true;
      }
    }
  }
  for (const set of [
    _folderReconDrainSkipped,
    _folderReconUnverified,
    _folderReconSessionDone,
  ]) {
    for (const folderKey of [...set]) {
      if (!folderKeys.has(folderKey)) {
        set.delete(folderKey);
        removedState = true;
      }
    }
  }
  for (const map of [
    _folderReconSessionDeferred,
    _folderReconFailureCounts,
    _folderReconDrainFailureDeferred,
    _folderReconDrainFailureCounts,
  ]) {
    for (const folderKey of [...map.keys()]) {
      if (folderKey !== "__all__" && !folderKeys.has(folderKey)) {
        map.delete(folderKey);
        removedState = true;
      }
    }
  }
  if (_folderReconActiveProof && !folderKeys.has(_folderReconActiveProof.folderKey)) {
    _releaseFolderReconActiveProof(null, "invalidation");
    removedState = true;
  }
  if (removedState) {
    // A disappeared/renamed prefix may leave native rows behind. Runtime
    // pruning prevents the old identity from pinning the scheduler, while the
    // orphan phase supplies the durable exact cleanup proof.
    _folderReconOrphanDone = false;
    _folderReconOrphanPass = null;
  }
  return removedState;
}

function _folderReconAmbiguousKeyspaces(identities) {
  // Build one exact path index per account. An overlap exists only at a ':'
  // boundary inside a path, so inspecting those boundaries avoids comparing
  // every folder with every other folder on each scheduler turn.
  const valid = [];
  const pathsByAccount = new Map();
  for (const identity of identities || []) {
    const accountId = String(identity?.accountId || "");
    const folderPath = String(identity?.folderPath || "");
    if (!accountId || !folderPath) continue;
    let accountPaths = pathsByAccount.get(accountId);
    if (!accountPaths) {
      accountPaths = new Map();
      pathsByAccount.set(accountId, accountPaths);
    }
    // Duplicate inventory entries name the same legacy key range and do not
    // create an ambiguity by themselves.
    if (accountPaths.has(folderPath)) continue;
    accountPaths.set(folderPath, valid.length);
    valid.push({ accountId, folderPath });
  }
  const parent = valid.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const ambiguousIndexes = new Set();
  for (let index = 0; index < valid.length; index++) {
    const { accountId, folderPath: path } = valid[index];
    const accountPaths = pathsByAccount.get(accountId);
    for (let boundary = path.indexOf(":"); boundary >= 0;
      boundary = path.indexOf(":", boundary + 1)) {
      const prefixIndex = accountPaths.get(path.slice(0, boundary));
      if (prefixIndex === undefined) continue;
      ambiguousIndexes.add(prefixIndex);
      ambiguousIndexes.add(index);
      union(prefixIndex, index);
    }
  }
  const folderKeys = new Set([...ambiguousIndexes].map(index =>
    `${valid[index].accountId}:${valid[index].folderPath}`));
  const groups = new Set([...ambiguousIndexes].map(find)).size;
  return { folderKeys, groups };
}

/**
 * Half-open msgId key range covering exactly one folder's FTS keys, provided
 * the fresh inventory has no same-account `path` / `path:` overlap. The
 * pre-existing key schema is non-injective for those paths. Capable helpers
 * use ADR-024's opaque relation instead; this range remains the fail-closed
 * compatibility path for older helpers.
 * startKey = "<accountId>:<folderPath>:", endKey replaces the trailing ':'
 * with ';' (':'+1). Subfolder keys (".../INBOX/sub:...") sort BEFORE
 * ".../INBOX:" ('/' < ':') so they are correctly excluded. The native side
 * does NO msgId parsing — bounds are computed here.
 */
function _folderKeyRange(accountId, folderPath) {
  const prefix = `${accountId}:${folderPath}:`;
  return { startKey: prefix, endKey: prefix.slice(0, -1) + ";" };
}

/**
 * One-time-per-session probe for the native fingerprint RPC. An unknown-method /
 * RPC error marks the helper unsupported for the whole session and logs it
 * ONCE — old deployed helpers must degrade to today's behavior.
 */
// Native dispatch answers for an RPC the helper does not implement, across
// every helper version (tabmail-native-fts main.rs). Anything else is transient.
const FOLDER_RECON_NATIVE_UNKNOWN_METHOD = /\bUnknown (?:reader )?method\b/;

/** @returns {Promise<"supported"|"unsupported"|"probe_failed">} */
async function _checkFolderReconNativeSupport(ftsSearch) {
  const connectionGeneration = _folderMembershipConnectionGeneration(ftsSearch);
  if (_folderReconNativeSupport?.connectionGeneration !== connectionGeneration) {
    _folderReconNativeSupport = null;
  }
  if (_folderReconNativeProbeFailures.connectionGeneration !== connectionGeneration) {
    _folderReconNativeProbeFailures = { connectionGeneration, count: 0 };
  }
  if (_folderReconNativeSupport) {
    return _folderReconNativeSupport.supported ? "supported" : "unsupported";
  }
  if (ftsSearch?.supportsFolderMembership?.() === true) {
    _folderReconNativeSupport = { connectionGeneration, supported: true };
    return "supported";
  }
  try {
    // Equal bounds exercise method dispatch/validation without scanning the
    // user's index; real per-folder fingerprints follow immediately.
    await ftsSearch.fingerprintMsgIdRange("", "");
    _folderReconNativeSupport = { connectionGeneration, supported: true };
    _folderReconNativeProbeFailures.count = 0;
    return "supported";
  } catch (e) {
    if (!FOLDER_RECON_NATIVE_UNKNOWN_METHOD.test(String(e?.message || e))) {
      _folderReconNativeProbeFailures.count++;
      log(`[FTS FolderRecon] Native fingerprint probe failed (${e}) — retrying`, "warn");
      return "probe_failed";
    }
    _folderReconNativeSupport = { connectionGeneration, supported: false };
    log(`[FTS FolderRecon] Native helper lacks fingerprint RPCs (${e}) — startup consistency proof disabled until helper upgrade; manual repair remains available`, "warn");
    logFtsBatchOperation("folder_recon", "unsupported", { error: String(e) });
    _writeReconSnapshot("fts_folder_recon_last", { skipped: true, reason: "native_unsupported", error: String(e) });
    return "unsupported";
  }
}

// A capable helper always reconciles folders through exact owner listings;
// global cleanup gates only orphan and session completion.
function _useExactFolderMembership(ftsSearch) {
  return _isFolderMembershipCapable(ftsSearch);
}

// Global cleanup holds while this generation's completed pass is still bound
// to the tick's inventory and connection and has not expired.
function _folderMembershipCleanupComplete(binding) {
  const pass = _folderMembershipStatePass;
  return _folderMembershipCleanupProven
    && pass?.completed === true
    && _folderMembershipStatePassBound(pass, binding)
    && Date.now() - pass.completedAtMs < FOLDER_RECON_WALK_PERIOD_MS;
}

// Exact or legacy membership is chosen ONCE per operation and never re-decided
// after an await. The operation's overlap refusal is computed for the mode it
// starts in, so a mid-operation switch to legacy key ranges (a reconnect or
// revocation ending exact mode) would read colon-overlapping folders without
// it. A captured mode stays sound for the whole operation: exact reads use the
// durable owner relation whatever connection serves them, and legacy ranges
// keep the refusal computed at the start.
function _captureFolderMembershipMode(ftsSearch) {
  return { exact: _useExactFolderMembership(ftsSearch) };
}

// The only way to withdraw global cleanup. The session-local pass that
// earned it goes with it, so cleanup can be re-earned only by a new pass that
// starts before the first native row, and that pass takes the next turn.
function _revokeFolderMembershipCleanup() {
  if (_folderMembershipCleanupProven || _folderMembershipStatePass) {
    _bumpFolderReconTelemetry("membershipStateRestartRevoked");
  }
  _folderMembershipCleanupProven = false;
  _folderMembershipStatePass = null;
  _folderReconMembershipTurn = "pass";
}

function _folderMembershipConnectionGeneration(ftsSearch) {
  const generation = ftsSearch?.getConnectionGeneration?.();
  return Number.isSafeInteger(generation) ? generation : null;
}

function _resetFolderMembershipVolatileProof() {
  _folderMembershipPageBudget = 0;
  _folderMembershipDigestSessions.clear();
  _folderMembershipDigestResults.clear();
  _folderMembershipYieldedAttempts.clear();
}

// Start one folder's reconcile attempt, or resume the attempt that yielded
// with its digest proofs. Returns the walk-mark serial the attempt started
// at: only marks up to it can be discharged by the attempt's certification.
function _beginFolderMembershipAttempt(folderId) {
  if (!folderId) return _folderReconMarkSerial;
  if (_folderMembershipYieldedAttempts.has(folderId)) {
    const markSerial = _folderMembershipYieldedAttempts.get(folderId);
    _folderMembershipYieldedAttempts.delete(folderId);
    return markSerial;
  }
  const prefix = `folder\u0000${folderId}\u0000`;
  for (const digests of [_folderMembershipDigestSessions, _folderMembershipDigestResults]) {
    for (const key of digests.keys()) {
      if (key.startsWith(prefix)) digests.delete(key);
    }
  }
  return _folderReconMarkSerial;
}

function _isFolderReconAttemptYield(error) {
  const message = String(error?.message || error);
  return message.includes("folder_membership_page_pending")
    || message.includes("folder_recon_pressure");
}

// A capable helper without a readable connection generation cannot bind
// proof: legacy. A pure read; only the observer below acts on a change.
function _isFolderMembershipCapable(ftsSearch) {
  return ftsSearch?.supportsFolderMembership?.() === true
    && _folderMembershipConnectionGeneration(ftsSearch) !== null;
}

function _observeFolderMembershipCapability(ftsSearch) {
  const connectionGeneration = _folderMembershipConnectionGeneration(ftsSearch);
  // A reconnect can let an unobserved legacy helper write ownerless rows even
  // when the capability reads true on both sides, so a new native connection
  // generation invalidates session proof exactly like a capability flip.
  const capable = _isFolderMembershipCapable(ftsSearch);
  if (_folderMembershipCapabilityState?.capable !== capable
      || _folderMembershipCapabilityState?.connectionGeneration !== connectionGeneration) {
    _folderMembershipCapabilityState = { capable, connectionGeneration };
    _revokeFolderMembershipCleanup();
    _resetFolderMembershipVolatileProof();
    // A new native connection may follow a helper that lost or wrote rows
    // no event announced: every folder is walked again once cutover is
    // re-earned.
    if (capable) _markAllFolderReconWalks();
  }
  if (!capable) {
    _folderMembershipStatePass = null;
    _resetFolderMembershipVolatileProof();
  }
  return capable;
}

function _consumeFolderMembershipPageBudget() {
  if (_folderMembershipPageBudget <= 0) {
    throw new Error("folder_membership_page_pending");
  }
  _folderMembershipPageBudget--;
}

// A digest proof about one folder stays current until that folder (or the
// wildcard) changes, locally or natively; other folders' traffic never
// restarts it.
function _folderMembershipProofStamp(folder) {
  return {
    generation: _folderReconGeneration,
    folderId: folder.folderId,
    localScope: _folderReconLocalScope(`${folder.accountId}:${folder.folderPath}`),
    membershipEpoch: getFtsMembershipEpoch(),
  };
}

function _folderMembershipProofStampCurrent(stamp) {
  return stamp?.generation === _folderReconGeneration
    && _folderReconLocalUnchangedSince(stamp.localScope?.folderKey, stamp.localScope?.since)
    && ftsMembershipUnchangedSince([stamp.folderId], stamp.membershipEpoch);
}

function _pruneFolderMembershipDigestProofs() {
  for (const [key, value] of _folderMembershipDigestSessions) {
    if (!_folderMembershipProofStampCurrent(value)) {
      _folderMembershipDigestSessions.delete(key);
    }
  }
  for (const [key, value] of _folderMembershipDigestResults) {
    if (!_folderMembershipProofStampCurrent(value)) {
      _folderMembershipDigestResults.delete(key);
    }
  }
  while (_folderMembershipDigestSessions.size > 8) {
    _folderMembershipDigestSessions.delete(_folderMembershipDigestSessions.keys().next().value);
  }
  while (_folderMembershipDigestResults.size > 8) {
    _folderMembershipDigestResults.delete(_folderMembershipDigestResults.keys().next().value);
  }
}

function _assertStrictMembershipCursor(previous, current) {
  if (typeof current !== "string" || current.length === 0) {
    throw new Error("folder_membership_msg_id_invalid");
  }
  if (previous === null) return;
  const left = { bytes: _folderReconEncoder.encode(previous) };
  const right = { bytes: _folderReconEncoder.encode(current) };
  if (_compareFolderReconEncoded(left, right) >= 0) {
    throw new Error("folder_membership_order_invalid");
  }
}

async function _fingerprintFolderMembershipPages(
  ftsSearch,
  folder,
  assertActive = _assertNoFolderReconForegroundPressure,
  proofSlot = null,
) {
  const folderId = folder?.folderId;
  if (!folderId) throw new Error("folder_membership_id_missing");
  _pruneFolderMembershipDigestProofs();
  const key = `folder\u0000${folderId}\u0000${proofSlot || "ephemeral"}`;
  const completed = proofSlot ? _folderMembershipDigestResults.get(key) : null;
  if (completed && _folderMembershipProofStampCurrent(completed)) {
    return { count: completed.count, sha256: completed.sha256 };
  }
  let session = _folderMembershipDigestSessions.get(key);
  if (!session || !_folderMembershipProofStampCurrent(session)) {
    session = {
      ..._folderMembershipProofStamp(folder),
      hasher: new _FolderReconSha256(),
      count: 0,
      afterMsgId: null,
    };
    _folderMembershipDigestSessions.set(key, session);
  }
  _consumeFolderMembershipPageBudget();
  assertActive();
  const page = await ftsSearch.listFolderMembership(
    folderId,
    session.afterMsgId,
    FOLDER_MEMBERSHIP_LIST_PAGE_SIZE,
  );
  assertActive();
  if (!_folderMembershipProofStampCurrent(session)) {
    _folderMembershipDigestSessions.delete(key);
    throw new Error("membership_epoch_changed");
  }
  const pageIds = page?.msgIds || [];
  if (pageIds.length > FOLDER_MEMBERSHIP_LIST_PAGE_SIZE
      || (page.done !== true && pageIds.length === 0)) {
    _folderMembershipDigestSessions.delete(key);
    throw new Error("folder_membership_page_invalid");
  }
  for (const msgId of pageIds) {
    _assertStrictMembershipCursor(session.afterMsgId, msgId);
    session.afterMsgId = msgId;
    _updateFolderReconFramedDigest(session.hasher, msgId);
    session.count++;
  }
  if (page.done !== true) throw new Error("folder_membership_page_pending");
  const result = { count: session.count, sha256: _bytesToHex(session.hasher.digest()) };
  _folderMembershipDigestSessions.delete(key);
  if (proofSlot) _folderMembershipDigestResults.set(key, { ...session, ...result, hasher: null });
  return result;
}

async function _fingerprintFolderNative(ftsSearch, folder, startKey, endKey, proofSlot, membershipMode) {
  if (membershipMode.exact) {
    return _fingerprintFolderMembershipPages(
      ftsSearch,
      folder,
      _assertNoFolderReconForegroundPressure,
      proofSlot,
    );
  }
  return ftsSearch.fingerprintMsgIdRange(startKey, endKey);
}

async function _listFolderNative(ftsSearch, folder, startKey, endKey, afterKey, limit, membershipMode) {
  if (membershipMode.exact) {
    if (!folder?.folderId) throw new Error("folder_membership_id_missing");
    _consumeFolderMembershipPageBudget();
    return ftsSearch.listFolderMembership(folder.folderId, afterKey, limit);
  }
  return ftsSearch.listMsgIdRange(startKey, endKey, afterKey, limit);
}

/**
 * Read the per-folder verified membership checkpoint (schema v3).
 * A v1 count memo is intentionally discarded: equal counts never proved set
 * equality and must not seed the stronger checkpoint.
 * Independent of the watermark AND the cursor store (separate storage key).
 */
async function _getFolderReconMemo() {
    const state = await _readReconStorageStrict(_folderReconGeneration);
    const m = state.memo;
    if ((m?.version === 2 || m?.version === 3)
        && m.folders && typeof m.folders === "object") {
      let needsMigrationWrite = m.version === 2;
      const folders = {};
      for (const [folderKey, checkpoint] of Object.entries(m.folders)) {
        if (!checkpoint || typeof checkpoint !== "object") {
          folders[folderKey] = checkpoint;
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(checkpoint, "missingBackfillKey")) {
          folders[folderKey] = checkpoint;
          continue;
        }
        const normalized = _normalizeMsgKeyCursor(checkpoint.missingBackfillKey);
        // v2 and the pre-release v3 used numeric zero as "before first", so
        // an ambiguous stored zero must replay valid key 0. An explicit true
        // bit is the only representation of "key 0 was processed".
        const started = normalized !== null
          && (checkpoint.missingBackfillStarted === true || normalized !== 0);
        const canonicalKey = normalized ?? 0;
        if (checkpoint.missingBackfillKey !== canonicalKey
            || checkpoint.missingBackfillStarted !== started) {
          needsMigrationWrite = true;
        }
        folders[folderKey] = {
          ...checkpoint,
          missingBackfillKey: canonicalKey,
          missingBackfillStarted: started,
        };
      }
      return {
        ...m,
        version: 3,
        roundRobinCursor: m.version === 2 ? null : (m.roundRobinCursor ?? null),
        folders,
        ...(needsMigrationWrite ? { _needsMigrationWrite: true } : {}),
      };
    }
  return { version: 3, roundRobinCursor: null, folders: {} };
}

/**
 * True when two folder checkpoints carry the same proof: every field except
 * the `updatedAtMs` timestamp is equal.
 */
function _sameFolderReconCheckpoint(stored, next) {
  if (!stored || typeof stored !== "object") return false;
  const fields = record => Object.keys(record).filter(key => key !== "updatedAtMs");
  const storedFields = fields(stored);
  const nextFields = fields(next);
  return storedFields.length === nextFields.length
    && nextFields.every(key => Object.prototype.hasOwnProperty.call(stored, key)
      && stored[key] === next[key]);
}

async function _writeFolderReconMemo(
  memo,
  {
    generation = _folderReconGeneration,
    folderKeys = null,
  } = {},
) {
  const keysToPatch = folderKeys || Object.keys(memo?.folders || {});
  return _reconStorageTransaction(generation, (state) => {
    state.memo.version = 3;
    state.memo.folders ||= {};
    for (const folderKey of keysToPatch) {
      if (Object.prototype.hasOwnProperty.call(memo?.folders || {}, folderKey)) {
        state.memo.folders[folderKey] = structuredClone(memo.folders[folderKey]);
      }
    }
    if (_folderReconRoundRobinCursor !== null) {
      state.memo.roundRobinCursor = _folderReconRoundRobinCursor;
    }
    // Orphan cursors are volatile and the per-folder metadata-scan record is
    // gone; drop what an older build stored.
    delete state.memo.orphanSweep;
    delete state.memo.folderMembershipMigration;
  });
}

/**
 * Stale direction (ftsCount > msgCount): page the folder's FTS keys
 * (listMsgIdRange), probe each page's headerMessageIds against the msgDB
 * hash index (probeMessageIds) — misses are CANDIDATES ONLY — then confirm
 * every candidate with the ADR-017 verify-then-remove recheck before a
 * single removeBatch + per-key verify. Never removes on uncertainty.
 *
 * @returns {{clean: boolean, budgetPartial: boolean}} clean = zero errors and
 *   not slice-truncated (folder may be verified); budgetPartial = the bounded
 *   recheck allowance cut this stale slice short. The independent missing pass
 *   may still persist its cursor, but the folder remains unverified.
 */
async function _folderReconStaleDirection(
  ftsSearch,
  f,
  startKey,
  endKey,
  stats,
  budget,
  resumeAfterKey,
  expectedMembershipEpoch,
  membershipMode,
  removalHandoff,
) {
  const generation = _folderReconGeneration;
  const reconcileLease = _folderReconInProgressOwner?.reconcileLease
    || _folderReconSchedulerOwner?.reconcileLease;
  // An absence verdict is stale once a message event arrives: a delivered
  // re-add queues the message but writes nothing native yet, so only the
  // event serial (checked again inside the removal fence) withholds the
  // removal of a row that is live again.
  const localScope = _folderReconLocalScope(`${f.accountId}:${f.folderPath}`);
  const assertCurrent = () => {
    if (reconcileLease) _assertFolderReconLease(reconcileLease, generation, localScope);
    _assertNoFolderReconForegroundPressure();
  };
  const folderPrefix = `${f.accountId}:${f.folderPath}:`;
  const weFolder = { accountId: f.accountId, path: f.folderPath };
  let afterKey = resumeAfterKey;
  let pages = 0;

  while (pages < FOLDER_RECON_STALE_PAGES_PER_SLICE) {
    assertCurrent();
    if (!ftsMembershipUnchangedSince(_folderReconNativeScope(f), expectedMembershipEpoch)) {
      return { clean: false, budgetPartial: false, cursor: afterKey, reachedEnd: false, localDrift: true };
    }
    let res;
    try {
      assertCurrent();
      res = await _listFolderNative(
        ftsSearch,
        f,
        startKey,
        endKey,
        afterKey,
        FOLDER_RECON_STALE_PAGE_KEYS,
        membershipMode,
      );
      assertCurrent();
    } catch (e) {
      _throwIfFolderReconInterrupted(e);
      logFtsOperation("folder_recon", "list_error", { folderPath: f.folderPath, error: String(e) });
      return { clean: false, budgetPartial: false, cursor: afterKey, reachedEnd: false };
    }
    const msgIds = res.msgIds || [];
    if (msgIds.length === 0) {
      return { clean: true, budgetPartial: false, cursor: null, reachedEnd: true };
    }

    if (msgIds.some(msgId => typeof msgId !== "string" || !msgId.startsWith(folderPrefix))) {
      logFtsOperation("folder_recon", "folder_membership_identity_mismatch", {
        folderPath: f.folderPath,
      });
      return { clean: false, budgetPartial: false, cursor: afterKey, reachedEnd: false };
    }
    const headerIds = msgIds.map((msgId) => msgId.slice(folderPrefix.length));
    let probe;
    try {
      assertCurrent();
      probe = await browser.tmMsgNotify.probeMessageIds(f.folderURI, headerIds);
      assertCurrent();
    } catch (e) {
      _throwIfFolderReconInterrupted(e);
      probe = { missing: [], error: String(e) };
    }
    if (probe.error) {
      logFtsOperation("folder_recon", "probe_error", { folderPath: f.folderPath, error: probe.error });
      return { clean: false, budgetPartial: false, cursor: afterKey, reachedEnd: false };
    }
    const missing = new Set(probe.missing || []);
    stats.staleCandidates += (probe.missing || []).length;
    const entriesToRemove = [];
    let processed = 0;
    let failed = false;
    for (let i = 0; i < msgIds.length; i++) {
      const msgId = msgIds[i];
      const headerID = headerIds[i];
      if (missing.has(headerID)) {
        if (budget.rechecks <= 0) break;
        if (stats.staleCandidates > 0
            && stats.staleCandidates % FOLDER_RECON_RECHECK_KEEPALIVE_EVERY === 0) {
          assertCurrent();
          try { await ftsSearch.stats(); } catch (_) {}
          assertCurrent();
        }
        budget.rechecks--;
        assertCurrent();
        const verdict = await recheckMessageInFolder(headerID, weFolder);
        assertCurrent();
        if (verdict === "absent") {
          entriesToRemove.push(msgId);
        } else if (verdict === "present") {
          stats.recheckKeptPresent++;
        } else {
          stats.recheckKeptError++;
          failed = true;
          break;
        }
        assertCurrent();
        await _folderReconYield(FOLDER_RECON_ENTRY_DELAY_MS);
        assertCurrent();
      }
      processed = i + 1;
    }

    if (entriesToRemove.length > 0) {
      try {
        // Another folder whose key range also holds a removed key (a
        // colon-overlapping folder) gets the same handoff as a state-pass
        // removal: its retry authorization is revoked first, its walk marked.
        assertCurrent();
        const markOtherFolders = await _prepareFolderReconRemovalHandoff(
          generation,
          removalHandoff.memo,
          [...removalHandoff.folderKeys].filter(folderKey =>
            folderKey !== `${f.accountId}:${f.folderPath}`),
          entriesToRemove,
        );
        await withFtsMembershipFence(expectedMembershipEpoch, async (membershipFenceToken) => {
          assertCurrent();
          markOtherFolders();
          await ftsSearch.removeBatch(entriesToRemove, membershipFenceToken);
          assertCurrent();
          for (const msgId of entriesToRemove) {
            assertCurrent();
            const entry = await ftsSearch.getMessageByMsgId(msgId);
            assertCurrent();
            if (entry && entry.msgId === msgId) throw new Error(`remove_verify_failed:${msgId}`);
            stats.staleRemoved++;
            logFtsOperation("folder_recon", "stale_removed", { msgId });
          }
        }, { mutation: true, scope: _folderReconNativeScope(f) });
        expectedMembershipEpoch = getFtsMembershipEpoch();
      } catch (e) {
        _throwIfFolderReconInterrupted(e);
        logFtsOperation("folder_recon", "remove_error", { folderPath: f.folderPath, error: String(e) });
        return {
          clean: false,
          budgetPartial: false,
          cursor: afterKey,
          reachedEnd: false,
          localDrift: String(e?.message || e).includes("membership_epoch_changed"),
        };
      }
    }

    if (failed) {
      return { clean: false, budgetPartial: false, cursor: afterKey, reachedEnd: false };
    }
    if (processed < msgIds.length) {
      const cursor = processed > 0 ? msgIds[processed - 1] : afterKey;
      return {
        clean: false,
        budgetPartial: true,
        cursor,
        reachedEnd: false,
        membershipEpoch: expectedMembershipEpoch,
      };
    }
    afterKey = msgIds[msgIds.length - 1];
    pages++;
    if (res.done) return { clean: true, budgetPartial: false, cursor: null, reachedEnd: true, membershipEpoch: expectedMembershipEpoch };
    if (pages < FOLDER_RECON_STALE_PAGES_PER_SLICE) {
      assertCurrent();
      await _folderReconYield();
    }
    assertCurrent();
  }
  return { clean: false, budgetPartial: true, cursor: afterKey, reachedEnd: false, membershipEpoch: expectedMembershipEpoch };
}

/**
 * Missing direction (local msgDB → FTS): page through the sorted msgKey view
 * from the exact current header snapshot, resolve at most one bounded key page
 * with getMessageInfosForKeys, filter against native FTS, and enqueue reported
 * misses through the shared drain path. No second parent-thread key walk.
 *
 * RESUMABLE (ADR-021 revision): sweeps msgDB keys ASCENDING starting from the
 * folder's persisted cursor. `missingBackfillStarted=false` is before-first;
 * numeric key 0 remains a valid already-processed cursor when started=true.
 * The sweep advances past a
 * numeric-key row only after that row is accounted for. A missing row without
 * a numeric key makes the whole filtered chunk the replay unit, so a mid-sweep
 * slice stop never skips it. `budget.scans` and `budget.enqueues` bound one
 * cooperative slice; repeated fair slices continue until the cursor reaches
 * the top and a fresh equality proof succeeds.
 *
 * @param {number} sinceKey - Resume cursor value (highest msgKey swept).
 * @param {boolean} sinceStarted - Whether sinceKey denotes a processed row.
 * @returns {{clean, budgetPartial, cursor, reachedEnd}} clean/reachedEnd = swept
 *   to the top of the current snapshot; budgetPartial = this slice stopped
 *   early (persist cursor, resume on a later quiet scheduler turn).
 */
function _upperBoundMsgKey(sortedKeys, cursor) {
  let low = 0;
  let high = sortedKeys.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (sortedKeys[mid] <= cursor) low = mid + 1;
    else high = mid;
  }
  return low;
}

async function _folderReconMissingDirection(
  ftsSearch,
  f,
  stats,
  budget,
  sinceKey,
  sortedKeys,
  proofGuard = null,
  sinceStarted = true,
) {
  const generation = _folderReconGeneration;
  const reconcileLease = _folderReconInProgressOwner?.reconcileLease
    || _folderReconSchedulerOwner?.reconcileLease;
  const assertCurrent = () => {
    if (reconcileLease) _assertFolderReconLease(reconcileLease, generation);
    _assertNoFolderReconForegroundPressure();
  };
  const normalizedCursor = _normalizeMsgKeyCursor(sinceKey);
  assertCurrent();
  let cursor = normalizedCursor ?? 0;
  let cursorStarted = sinceStarted === true && normalizedCursor !== null;
  const snapshotInvalidated = () => proofGuard && !_folderReconProofGuardCurrent(proofGuard);
  const pageLimit = Math.max(1, Math.min(
    FOLDER_RECON_MISSING_PAGE_KEYS,
    Number.isFinite(budget.scans) ? Math.max(1, budget.scans) : FOLDER_RECON_MISSING_PAGE_KEYS,
  ));
  if (!(sortedKeys instanceof Uint32Array)) {
    logFtsOperation("folder_recon", "snapshot_keys_missing", { folderPath: f.folderPath });
    return { clean: false, budgetPartial: false, cursor, cursorStarted, reachedEnd: false };
  }
  if (snapshotInvalidated()) {
    return { clean: false, budgetPartial: true, cursor, cursorStarted, reachedEnd: false, localDrift: true };
  }
  const pageStart = cursorStarted ? _upperBoundMsgKey(sortedKeys, cursor) : 0;
  const pageEnd = Math.min(sortedKeys.length, pageStart + pageLimit);
  const pageKeys = Array.from(sortedKeys.subarray(pageStart, pageEnd));
  const hasMore = pageEnd < sortedKeys.length;
  if (pageKeys.length === 0) {
    return { clean: true, budgetPartial: false, cursor, cursorStarted, reachedEnd: true };
  }

  let idx = 0;
  let stoppedForBudget = false;
  let stoppedForLocalDrift = false;

  while (idx < pageKeys.length) {
    const chunk = pageKeys.slice(idx, idx + FOLDER_RECON_KEYS_CHUNK);

    let res;
    try {
      assertCurrent();
      res = await browser.tmMsgNotify.getMessageInfosForKeys(f.folderURI, chunk);
      assertCurrent();
    } catch (e) {
      _throwIfFolderReconInterrupted(e);
      res = { infos: [], error: String(e) };
    }
    if (res.error) {
      logFtsOperation("folder_recon", "infos_error", { folderPath: f.folderPath, error: res.error });
      return { clean: false, budgetPartial: false, cursor, cursorStarted, reachedEnd: false };
    }
    if (snapshotInvalidated()) {
      return { clean: false, budgetPartial: true, cursor, cursorStarted, reachedEnd: false, localDrift: true };
    }

    // Build filter rows and retain their source info by the same stable FTS
    // key. `extractMessageInfo` can legitimately serialize msgKey as null;
    // enqueueing is key-addressed by account/folder/Message-ID and does not
    // require the numeric msgDB key.
    const infoByMsgId = new Map();
    const infoByKey = new Map();
    const rows = [];
    for (const info of res.infos || []) {
      if (!info?.headerMessageId || !info.accountId || !info.folderPath) continue;
      const msgId = `${info.accountId}:${info.folderPath}:${info.headerMessageId}`;
      const normalizedInfoKey = _normalizeMsgKeyCursor(info.msgKey);
      // Prefer a numeric-key-bearing duplicate because it lets the cursor
      // advance precisely up to (but not past) an un-enqueued row.
      if (!infoByMsgId.has(msgId) || normalizedInfoKey !== null) {
        infoByMsgId.set(msgId, info);
      }
      if (normalizedInfoKey !== null) infoByKey.set(normalizedInfoKey, info);
      rows.push({ msgId });
    }

    let newIds = new Set();
    if (rows.length > 0) {
      let filterResult;
      try {
        assertCurrent();
        filterResult = await ftsSearch.filterNewMessages(rows);
        assertCurrent();
      } catch (e) {
        _throwIfFolderReconInterrupted(e);
        logFtsOperation("folder_recon", "filter_error", { folderPath: f.folderPath, error: String(e) });
        return { clean: false, budgetPartial: false, cursor, cursorStarted, reachedEnd: false };
      }
      newIds = new Set(filterResult.newMsgIds || []);
    }
    if (snapshotInvalidated()) {
      return { clean: false, budgetPartial: true, cursor, cursorStarted, reachedEnd: false, localDrift: true };
    }

    // Validate that every native result maps back to the input row that
    // produced it. An unexpected result must not let the cursor skip work.
    for (const msgId of newIds) {
      if (!infoByMsgId.has(msgId)) {
        logFtsOperation("folder_recon", "filter_result_unmapped", { msgId, folderPath: f.folderPath });
        return { clean: false, budgetPartial: false, cursor, cursorStarted, reachedEnd: false };
      }
    }

    // A filter-reported missing row without a numeric msgKey cannot be placed
    // at a precise position inside the requested key chunk. Enqueue it first;
    // if the expensive-work budget ends, leave the whole chunk replayable.
    let chunkReplayRequired = false;
    for (const msgId of newIds) {
      const info = infoByMsgId.get(msgId);
      if (_normalizeMsgKeyCursor(info.msgKey) !== null) continue;
      if (budget.enqueues <= 0) {
        stoppedForBudget = true;
        chunkReplayRequired = true;
        break;
      }
      try {
        assertCurrent();
        const admitted = await _enqueueNewFromInfo(info, true);
        assertCurrent();
        if (!admitted) {
          stoppedForBudget = true;
          chunkReplayRequired = true;
          break;
        }
      } catch (e) {
        _throwIfFolderReconInterrupted(e);
        logFtsOperation("folder_recon", "enqueue_error", { msgId, error: String(e) });
        return { clean: false, budgetPartial: false, cursor, cursorStarted, reachedEnd: false };
      }
      if (snapshotInvalidated()) {
        stoppedForBudget = true;
        stoppedForLocalDrift = true;
        chunkReplayRequired = true;
        break;
      }
      budget.enqueues--;
      stats.missingEnqueued++;
      logFtsOperation("folder_recon", "missing_enqueued", { msgId, folderPath: f.folderPath });
    }
    if (chunkReplayRequired) break;

    // Numeric-key rows retain the finer per-key cursor behavior: stop before
    // the first missing row that cannot be enqueued, while already-accounted
    // indexed/vanished rows advance normally.
    let chunkDone = 0;
    for (const key of chunk) {
      if (snapshotInvalidated()) {
        stoppedForBudget = true;
        stoppedForLocalDrift = true;
        break;
      }
      const info = infoByKey.get(key);
      if (info) {
        const msgId = `${info.accountId}:${info.folderPath}:${info.headerMessageId}`;
        if (newIds.has(msgId)) {
          if (budget.enqueues <= 0) {
            stoppedForBudget = true;
            break;
          }
          try {
            assertCurrent();
            const admitted = await _enqueueNewFromInfo(info, true);
            assertCurrent();
            if (!admitted) {
              stoppedForBudget = true;
              break;
            }
          } catch (e) {
            _throwIfFolderReconInterrupted(e);
            logFtsOperation("folder_recon", "enqueue_error", { msgId, error: String(e) });
            return { clean: false, budgetPartial: false, cursor, cursorStarted, reachedEnd: false };
          }
          if (snapshotInvalidated()) {
            stoppedForBudget = true;
            stoppedForLocalDrift = true;
            break;
          }
          budget.enqueues--;
          stats.missingEnqueued++;
          logFtsOperation("folder_recon", "missing_enqueued", { msgId, folderPath: f.folderPath });
        }
      }
      cursor = key;
      cursorStarted = true;
      if (Number.isFinite(budget.scans)) budget.scans--;
      chunkDone++;
    }
    idx += chunkDone;
    if (stoppedForBudget) break;

    if (idx < pageKeys.length) {
      assertCurrent();
      await _folderReconYield();
      assertCurrent();
    }
  }

  const pageComplete = idx >= pageKeys.length && !stoppedForBudget;
  const reachedEnd = pageComplete && !hasMore;
  if (stoppedForBudget) {
    log(`[FTS FolderRecon] ${f.folderPath}: backfill slice paused — cursor at ${cursor}`, "warn");
    logFtsOperation("folder_recon", "missing_budget_truncated", { folderPath: f.folderPath, cursor });
  }
  return {
    clean: reachedEnd,
    budgetPartial: !reachedEnd,
    cursor,
    cursorStarted,
    reachedEnd,
    localDrift: stoppedForLocalDrift,
  };
}

/**
 * Orphaned-prefix sweep (folders deleted/renamed while off): when the
 * full-keyspace count exceeds the sum of per-folder counts, keys must exist
 * under prefixes no reported folder owns. Walk the keyspace, keep every key
 * some existing folder's prefix covers (incl. folder paths containing ':' —
 * the parse edge), confirm the rest against an independent accounts walk,
 * and remove only keys that ALSO pass the ADR-017 recheck. This walk runs
 * ONLY on count evidence.
 */
function _folderReconMsgIdHasKnownFolderPrefix(msgId, knownFolderKeys) {
  if (typeof msgId !== "string") return false;
  for (let boundary = msgId.indexOf(":"); boundary >= 0;
    boundary = msgId.indexOf(":", boundary + 1)) {
    if (knownFolderKeys.has(msgId.slice(0, boundary))) return true;
  }
  return false;
}

async function _folderReconOrphanSweep(
  ftsSearch,
  knownFolderKeys,
  identities,
  stats,
  budget,
  pass,
  inventoryMembershipEpoch,
) {
  const generation = _folderReconGeneration;
  const reconcileLease = _folderReconSchedulerOwner?.reconcileLease
    || _folderReconInProgressOwner?.reconcileLease;
  const assertCurrent = () => {
    if (reconcileLease) _assertFolderReconLease(reconcileLease, generation);
    _assertNoFolderReconForegroundPressure();
  };
  // Terminal safeguard: the global fingerprint at walk start is compared with
  // a fresh one at the terminal page. A write whose identity predates the pass
  // (a timed-out index_batch committing late, with no second epoch advance)
  // can land behind the cursor; the drift replays the walk from before-first.
  if (!pass.walkBaseline) {
    assertCurrent();
    pass.walkBaseline = await ftsSearch.fingerprintMsgIdRange("", FOLDER_RECON_KEYSPACE_END);
    assertCurrent();
  }
  const afterKey = pass.cursor;
  assertCurrent();
  const res = await ftsSearch.listMsgIdRange(
    "",
    FOLDER_RECON_KEYSPACE_END,
    afterKey,
    FOLDER_RECON_STALE_PAGE_KEYS,
  );
  assertCurrent();
  const msgIds = res.msgIds || [];

  const entriesToRemove = [];
  let processed = 0;
  let unloadedAccountRowsKept = 0;
  // An unloaded account is invisible to the global recheck (a query cannot
  // see folders Thunderbird has not loaded), so "absent" is not deletion
  // evidence for it.
  const trustedAccountIds = _folderReconTrustedAccountIds(identities);
  for (let i = 0; i < msgIds.length; i++) {
    const msgId = msgIds[i];
    if (_folderReconMsgIdHasKnownFolderPrefix(msgId, knownFolderKeys)) {
      processed = i + 1;
      continue;
    }
    if (!trustedAccountIds.has(_folderReconAccountIdOfMsgId(msgId))) {
      stats.orphanKeysKept++;
      unloadedAccountRowsKept++;
      processed = i + 1;
      continue;
    }
    const parsed = parseUniqueId(msgId);
    if (!parsed) {
      stats.orphanKeysKept++;
      processed = i + 1;
      continue;
    }
    // A key outside every captured prefix may belong to a folder renamed back
    // after the inventory read (a topology change, not a membership write), so
    // only a live global "absent" may remove it.
    if (budget.rechecks <= 0) break;
    budget.rechecks--;
    assertCurrent();
    const verdict = await recheckMessageInFolder(parsed.headerID, parsed.weFolder);
    assertCurrent();
    if (verdict === "absent") {
      entriesToRemove.push(msgId);
    } else if (verdict === "present") {
      stats.orphanKeysKept++;
    } else {
      return { complete: false, failed: true };
    }
    processed = i + 1;
    assertCurrent();
    await _folderReconYield(FOLDER_RECON_ENTRY_DELAY_MS);
    assertCurrent();
  }
  if (entriesToRemove.length > 0) {
    try {
      // Fenced on the epoch read before this tick's inventory: a row indexed
      // into a folder created after the snapshot rejects the removal.
      await withFtsMembershipFence(inventoryMembershipEpoch, async (membershipFenceToken) => {
        // Sticky before the mutator: the terminal fingerprint must differ.
        pass.walkMutated = true;
        assertCurrent();
        await ftsSearch.removeBatch(entriesToRemove, membershipFenceToken);
        assertCurrent();
        for (const msgId of entriesToRemove) {
          assertCurrent();
          const entry = await ftsSearch.getMessageByMsgId(msgId);
          assertCurrent();
          if (entry && entry.msgId === msgId) throw new Error("orphan_remove_verify_failed");
          stats.orphanRemoved++;
          logFtsOperation("folder_recon", "orphan_removed", { msgId });
        }
      }, { mutation: true });
    } catch (e) {
      _throwIfFolderReconInterrupted(e);
      if (String(e?.message || e).includes("membership_epoch_changed")) {
        // Nothing was removed; the same page is retried on a later slice.
        return { complete: false, retry: true };
      }
      return { complete: false, failed: true, error: String(e) };
    }
  }
  if (unloadedAccountRowsKept > 0) {
    _bumpFolderReconTelemetry("unloadedAccountRowsKept", unloadedAccountRowsKept);
    pass.unloaded += unloadedAccountRowsKept;
  }
  if (processed > 0) pass.cursor = msgIds[processed - 1];
  const terminalPage = msgIds.length === 0
    || (processed >= msgIds.length && res.done === true);
  if (!terminalPage) return { complete: false };

  const fingerprintEpoch = getFtsMembershipEpoch();
  // This data-sized read is intentionally outside the membership mutex.
  assertCurrent();
  const finalNative = await ftsSearch.fingerprintMsgIdRange("", FOLDER_RECON_KEYSPACE_END);
  assertCurrent();
  if (pass.walkMutated
      || fingerprintEpoch !== getFtsMembershipEpoch()
      || finalNative?.count !== pass.walkBaseline.count
      || finalNative?.sha256 !== pass.walkBaseline.sha256) {
    _restartFolderReconOrphanWalk(pass);
    return { complete: false, restart: true, terminalRefresh: true };
  }
  pass.complete = true;
  return { complete: true };
}

function _restartFolderReconOrphanWalk(pass) {
  pass.cursor = null;
  pass.walkBaseline = null;
  pass.walkMutated = false;
  pass.unloaded = 0;
}

/**
 * Startup fingerprint proof + exact per-folder set reconcile. This is the
 * automatic post-init reconciliation path and is independent of the legacy
 * watermark and cursor stores. Skips cleanly when the experiment API or native
 * fingerprint/range RPCs are unavailable.
 *
 * @param {Object} ftsSearch - FTS search interface
 * @param {Set<string>|null} [onlyFolderKeys] - Restrict to these
 *   "accountId:folderPath" keys. Orphan work is staged separately by the
 *   cooperative scheduler after every current folder is verified.
 */
async function _runFolderReconcile(
  ftsSearch,
  onlyFolderKeys = null,
  schedulerLease = null,
  currentIdentities = null,
) {
  const generation = _folderReconGeneration;
  if (!_isEnabled || !ftsSearch) return { skipped: true, reason: "disabled" };
  if (!browser.tmMsgNotify
      || typeof browser.tmMsgNotify.getFolderState !== "function"
      || typeof browser.tmMsgNotify.beginFolderMessageScan !== "function"
      || typeof browser.tmMsgNotify.readFolderMessageScanPage !== "function"
      || typeof browser.tmMsgNotify.cancelFolderMessageScan !== "function"
      || typeof browser.tmMsgNotify.probeMessageIds !== "function") {
    log(`[FTS FolderRecon] Skipped — experiment API unavailable`);
    return { skipped: true, reason: "no_experiment" };
  }
  if (_folderReconInProgressOwner) return { skipped: true, reason: "busy" };
  const reconcileLease = schedulerLease || tryAcquireFtsReconcileLease();
  if (!reconcileLease) return { skipped: true, reason: "operation_busy" };
  const ownsLease = !schedulerLease;
  const owner = { generation, reconcileLease };
  _folderReconInProgressOwner = owner;
  // The folder attempt in progress; a yield out of this slice resumes it.
  let openAttemptFolderId = null;
  let openAttemptMarkSerial = 0;
  try {
    // Add-side completeness gate: before the initial FULL scan finishes,
    // every folder carries a huge policy deficit — set equality cannot hold
    // yet and the missing direction would mass-enqueue the initial scan's
    // backlog through the wrong pipeline.
    let scanGate;
    try {
      scanGate = await _readFolderReconScanGateStrict();
      _assertFolderReconLease(reconcileLease, generation);
      if (!scanGate.allowed) {
        log(`[FTS FolderRecon] Skipped — initial FTS scan not yet complete (proof needs add-side completeness)`);
        logFtsBatchOperation("folder_recon", `skipped_${scanGate.reason}`, {});
        _writeReconSnapshot("fts_folder_recon_last", { skipped: true, reason: scanGate.reason });
        return { skipped: true, reason: scanGate.reason };
      }
    } catch (e) {
      if (String(e?.message || e).includes("folder_recon_cancelled")) throw e;
      log(`[FTS FolderRecon] Scan gate read failed: ${e} — deferred`, "warn");
      return { skipped: true, reason: "scan_gate_read_failed" };
    }
    const nativeSupport = await _checkFolderReconNativeSupport(ftsSearch);
    if (nativeSupport === "probe_failed") {
      return {
        skipped: true,
        reason: "native_probe_failed",
        retryDelayMs: Math.min(
          FOLDER_RECON_ERROR_DELAY_MS * (2 ** Math.min(_folderReconNativeProbeFailures.count - 1, 30)),
          FOLDER_RECON_GENERIC_FAILURE_BACKOFF_MAX_MS,
        ),
      };
    }
    if (nativeSupport !== "supported") {
      return { skipped: true, reason: "native_unsupported" };
    }
    _assertFolderReconLease(reconcileLease, generation);
  if (!onlyFolderKeys) _folderReconUnverified = new Set();
  const reconStart = Date.now();
  const stats = {
    foldersTotal: 0,
    foldersErrored: 0,
    foldersDrainBusy: 0,
    foldersMemoHit: 0,
    foldersClean: 0,       // exact expected/native fingerprints equal
    foldersReconciled: 0,  // both-direction pass completed and equality verified
    foldersFailed: 0,      // a direction pass errored — no proof, retry later
    foldersBudgetPartial: 0, // this slice ended before its direction cursor
    foldersLocalDrift: 0,  // local membership changed; restart without backoff
    foldersBackoff: 0,     // unchanged terminal failures delayed before a full replay
    staleCandidates: 0,
    staleRemoved: 0,
    recheckKeptPresent: 0,
    recheckKeptError: 0,
    missingEnqueued: 0,
    orphanRemoved: 0,
    orphanKeysKept: 0,
  };

  const membershipMode = _captureFolderMembershipMode(ftsSearch);
  let folders;
  try {
    folders = await _readPerFolderExperimentState("getFolderState", {
      onlyFolderKeys,
      currentIdentities,
      // Earned exact mode creates the msgDB incarnation token before any
      // proof, so a checkpoint can bind the database it was earned on.
      callOptions: membershipMode.exact ? { ensureIncarnationToken: true } : null,
    });
    _assertFolderReconLease(reconcileLease, generation);
  } catch (e) {
    if (String(e?.message || e).includes("folder_recon_cancelled")) throw e;
    log(`[FTS FolderRecon] Folder inventory failed: ${e} — deferred`, "warn");
    logFtsBatchOperation("folder_recon", "error", { error: String(e) });
    return { skipped: true, reason: "folder_inventory_failed" };
  }

  const directAmbiguity = membershipMode.exact
    ? { folderKeys: new Set(), groups: 0 }
    : _folderReconAmbiguousKeyspaces(currentIdentities || folders);
  if (directAmbiguity.groups > 0) {
    for (const folderKey of directAmbiguity.folderKeys) {
      _folderReconUnverified.add(folderKey);
      _folderReconSessionDone.delete(folderKey);
      _releaseFolderReconActiveProof(folderKey, "invalidation");
    }
    folders = (folders || []).filter(folder =>
      !directAmbiguity.folderKeys.has(`${folder.accountId}:${folder.folderPath}`));
    const requestedSafeFolder = folders.some(folder =>
      !onlyFolderKeys || onlyFolderKeys.has(`${folder.accountId}:${folder.folderPath}`));
    if (!requestedSafeFolder) {
      return {
        ...stats,
        skipped: true,
        reason: "ambiguous_folder_keyspace",
        ambiguousGroups: directAmbiguity.groups,
        ambiguousFolders: directAmbiguity.folderKeys.size,
      };
    }
  }

  logFtsBatchOperation("folder_recon", "start", {
    foldersReported: folders?.length || 0,
    rerun: !!onlyFolderKeys,
  });

  const memo = await _getFolderReconMemo();
  _assertFolderReconLease(reconcileLease, generation);
  // Every folder a stale removal can hand off to: the inventory this run was
  // given or read, and the scheduler's last one.
  const removalHandoffFolderKeys = new Set([
    ..._folderReconKnownFolderKeys,
    ...(currentIdentities || folders || []).map(folder => `${folder.accountId}:${folder.folderPath}`),
  ]);
  let memoChanged = memo._needsMigrationWrite === true;
  delete memo._needsMigrationWrite;
  // Expensive work budgets bound this one scheduler slice. Durable folder and
  // direction cursors plus fair repeated ticks make total convergence
  // unbounded without storming global rechecks or the incremental body drain.
  const verifiedThisRun = new Set();
  const verifiedEpochByFolder = new Map();
  const attemptMarkSerialByFolder = new Map();
  const memoEpochByFolder = new Map();
  const budget = {
    rechecks: FOLDER_RECON_RECHECKS_PER_SLICE,
    enqueues: FOLDER_RECON_ENQUEUES_PER_SLICE,
    ...(_folderReconBudgetOverride || {}),
  };
  const missingScansPerFolder = _folderReconBudgetOverride?.scans
    ?? FOLDER_RECON_MISSING_PAGE_KEYS;
  if (!folders || folders.length === 0) {
    _folderReconUnverified.add("__no_folders_reported__");
  }

  for (const f of folders || []) {
    openAttemptFolderId = null;
    stats.foldersTotal++;
    const folderKey = `${f.accountId}:${f.folderPath}`;
    // Re-run scope: only the drain-skipped folders.
    if (onlyFolderKeys && !onlyFolderKeys.has(folderKey)) {
      continue;
    }
    _folderReconUnverified.add(folderKey);

    // 1) Folder errored / lacks a stable identity → defer without proof.
    if (f.error || !f.folderURI || !f.accountId || !f.folderPath) {
      _releaseFolderReconActiveProof(folderKey, "invalidation");
      stats.foldersErrored++;
      logFtsOperation("folder_recon", "folder_error", {
        folderPath: f.folderPath,
        error: f.error || "bad_folder_entry",
      });
      continue;
    }

    // 2) Drain-quiet gate: pending updates for this folder mean its membership
    //    is in flux — defer until the shared drain reaches low water. An
    //    entry that names its folder affects only that folder; the raw key
    //    prefix decides only for an entry with no folder. (Legacy mode
    //    refuses prefix-overlapping folders as ambiguous before this point.)
    const pendingPrefix = `${folderKey}:`;
    let drainBusy = false;
    for (const [pendingKey, pending] of _pendingUpdates) {
      if (pending?.folderKey
        ? pending.folderKey === folderKey
        : pendingKey.startsWith(pendingPrefix)) {
        drainBusy = true;
        break;
      }
    }
    if (drainBusy) {
      stats.foldersDrainBusy++;
      _folderReconDrainSkipped.add(folderKey);
      continue;
    }
    _folderReconDrainSkipped.delete(folderKey);
    const attemptMarkSerial = _beginFolderMembershipAttempt(f.folderId);
    attemptMarkSerialByFolder.set(folderKey, attemptMarkSerial);
    openAttemptFolderId = f.folderId;
    openAttemptMarkSerial = attemptMarkSerial;

    // 3) A prior verified stable-IMAP checkpoint gets the cheap path first:
    // hash only the UID set (the parent never touches Message-ID), then take a
    // fresh native fingerprint. IMAP UID immutability lets that exact pair
    // reuse the prior Message-ID projection. Every other case takes a full
    // local projection and a second, post-scan native fingerprint.
    const { startKey, endKey } = _folderKeyRange(f.accountId, f.folderPath);
    const m = memo.folders[folderKey];
    let expected;
    let folderMembershipEpoch;
    let nativeFingerprint;
    const priorExactProjection = m?.verified === true
      && Number.isSafeInteger(m.expectedCount)
      && m.expectedCount >= 0
      && typeof m.expectedSha256 === "string"
      && Number.isSafeInteger(m.keyMapCount)
      && m.keyMapCount >= 0
      && typeof m.keyMapSha256 === "string";
    const memoUidValidity = _normalizeUidValidity(m?.uidValidity);
    const currentUidValidity = _normalizeUidValidity(f.uidValidity);

    const identityEvidence = membershipMode.exact && _folderReconHasIdentityEvidence(f);

    // The UID-only tier reuses a stored Message-ID projection. In exact mode
    // that is sound only on the msgDB that earned it: a missing or different
    // incarnation token forces the full projection.
    const sameIncarnation = !membershipMode.exact
      || (typeof m?.incarnationToken === "string"
        && m.incarnationToken.length > 0
        && m.incarnationToken === f.incarnationToken);
    const mayTryUidOnly = priorExactProjection
      && f.serverType === "imap"
      && f.stableUidKeys === true
      && currentUidValidity !== null
      && memoUidValidity === currentUidValidity
      && sameIncarnation;
    if (!_folderReconActiveProof && mayTryUidOnly) {
      try {
        // The bounded native digest runs first: it resumes across page and
        // pressure yields, so the UID set is enumerated once per attempt,
        // after the digest completed. A digest is returned only while the
        // stamp its first page captured is current, so that stamp is this
        // slice's serial and the epoch checked after it; both checks are
        // repeated after the UID scan and the closing read.
        const digestLocalScope = _folderReconLocalScope(folderKey);
        folderMembershipEpoch = getFtsMembershipEpoch();
        _assertNoFolderReconForegroundPressure();
        const uidNative = await _fingerprintFolderNative(
          ftsSearch, f, startKey, endKey, "uid_checkpoint", membershipMode,
        );
        _assertFolderReconLease(reconcileLease, generation);
        _assertNoFolderReconForegroundPressure();
        if (!ftsMembershipUnchangedSince(_folderReconNativeScope(f), folderMembershipEpoch)) {
          throw new Error("membership_epoch_changed");
        }
        const ftsCheckpointHit = m.ftsCount === uidNative.count
          && m.ftsSha256 === uidNative.sha256;
        const uidOnly = ftsCheckpointHit
          ? await _scanFolderMessagesCooperatively(f, generation, false)
          : null;
        if (uidOnly && uidOnly.proofKind !== "uid_only") throw new Error("uid_only_proof_expected");
        const uidCheckpointHit = uidOnly?.stableUidKeys === true
          && _normalizeUidValidity(uidOnly.uidValidity) === memoUidValidity
          && m.uidCount === uidOnly.uidCount
          && m.uidSha256 === uidOnly.uidSha256;
        if (uidCheckpointHit && ftsCheckpointHit) {
          _assertFolderReconGeneration(generation, uidOnly.localScope);
          _assertNoFolderReconForegroundPressure();
          // The incarnation token matched at the opening read; only the
          // closing read proves the UIDs just hashed came from that msgDB.
          if (identityEvidence) {
            const closing = await _readFolderReconClosingState(f);
            _assertFolderReconLease(reconcileLease, generation);
            if (!_folderReconIdentityUnchanged(f, closing)) throw new Error("folder_identity_changed");
          }
          if (!ftsMembershipUnchangedSince(_folderReconNativeScope(f), folderMembershipEpoch)) {
            throw new Error("membership_epoch_changed");
          }
          _assertFolderReconGeneration(generation, digestLocalScope);
          stats.foldersMemoHit++;
          verifiedThisRun.add(folderKey);
          verifiedEpochByFolder.set(folderKey, folderMembershipEpoch);
          _folderReconUnverified.delete(folderKey);
          continue;
        }
      } catch (e) {
        _throwIfFolderReconInterrupted(e);
        if (String(e?.message || e).includes("membership_epoch_changed")) {
          memo.folders[folderKey] = { verified: false, updatedAtMs: Date.now() };
          memoChanged = true;
          memoEpochByFolder.set(folderKey, getFtsMembershipEpoch());
        }
        stats.foldersErrored++;
        logFtsOperation("folder_recon", "uid_fingerprint_error", {
          folderPath: f.folderPath,
          error: String(e),
        });
        continue;
      }
    }
    try {
      expected = await _getFolderReconWorkingProof(f, generation, folderKey);
    } catch (e) {
      _throwIfFolderReconInterrupted(e);
      stats.foldersErrored++;
      logFtsOperation("folder_recon", "expected_fingerprint_error", {
        folderPath: f.folderPath,
        error: String(e),
      });
      continue;
    }
    try {
      folderMembershipEpoch = getFtsMembershipEpoch();
      _assertNoFolderReconForegroundPressure();
      nativeFingerprint = await _fingerprintFolderNative(
        ftsSearch, f, startKey, endKey, "initial", membershipMode,
      );
      _assertFolderReconLease(reconcileLease, generation);
      _assertNoFolderReconForegroundPressure();
      if (!ftsMembershipUnchangedSince(_folderReconNativeScope(f), folderMembershipEpoch)) {
        throw new Error("membership_epoch_changed");
      }
      // A reused proof is repair input only. If native already equals it, take
      // a direct fresh local/native pair before allowing the verified path.
      if (expected.fromWorkingProof === true
          && expected.count === nativeFingerprint.count
          && expected.sha256 === nativeFingerprint.sha256) {
        const freshExpected = await _scanFolderMessagesCooperatively(f, generation, true);
        const freshEntry = _admitFolderReconActiveProof(
          folderKey, f, freshExpected, generation, "verify",
        );
        expected = {
          ...freshExpected,
          fromWorkingProof: false,
          proofGuard: _folderReconGuardForFreshProof(folderKey, freshEntry, freshExpected),
        };
        folderMembershipEpoch = getFtsMembershipEpoch();
        _assertNoFolderReconForegroundPressure();
        nativeFingerprint = await _fingerprintFolderNative(
          ftsSearch, f, startKey, endKey, "fresh_after_working", membershipMode,
        );
        _assertFolderReconLease(reconcileLease, generation);
        _assertNoFolderReconForegroundPressure();
        if (!ftsMembershipUnchangedSince(_folderReconNativeScope(f), folderMembershipEpoch)) {
          throw new Error("membership_epoch_changed");
        }
      }
    } catch (e) {
      _throwIfFolderReconInterrupted(e);
      stats.foldersFailed++;
      if (String(e?.message || e).includes("membership_epoch_changed")) {
        memo.folders[folderKey] = { verified: false, updatedAtMs: Date.now() };
        memoChanged = true;
        memoEpochByFolder.set(folderKey, getFtsMembershipEpoch());
      }
      logFtsOperation("folder_recon", "fingerprint_error", { folderPath: f.folderPath, error: String(e) });
      continue;
    }
    let ftsCount = nativeFingerprint.count;

    // Full-proof paths retain the exact UID/key-map evidence needed for safe
    // cursors and backoff. A UID-only object can never reach this point.
    if (expected.proofKind !== "full") throw new Error("full_folder_proof_expected");
    const stableUidValidity = expected.stableUidKeys === true
      ? _normalizeUidValidity(expected.uidValidity)
      : null;
    const hasStableUidEpoch = stableUidValidity !== null;

    const msgCount = expected.count;

    const hasKeyMapFingerprint = Number.isInteger(expected.keyMapCount)
      && expected.keyMapCount >= 0
      && typeof expected.keyMapSha256 === "string"
      && expected.keyMapSha256.length > 0;
    // A usable UIDVALIDITY epoch proves IMAP keys remain monotonic even if the
    // Message-ID set grows. Without that epoch (Thunderbird's zero sentinel,
    // malformed/missing evidence, or non-IMAP keys), resume only while the
    // exact key-to-Message-ID mapping is unchanged. Set equality alone is not
    // enough: an epoch turnover can preserve the set while remapping a missing
    // ID below the old cursor.
    const stableUidEpochUnchanged = hasStableUidEpoch
      && m?.partialStableUidKeys === true
      && _normalizeUidValidity(m.partialUidValidity) === stableUidValidity;
    const exactKeyMapUnchanged = hasKeyMapFingerprint
      && m?.partialKeyMapCount === expected.keyMapCount
      && m.partialKeyMapSha256 === expected.keyMapSha256;
    const resumeProofUnchanged = hasStableUidEpoch
      ? stableUidEpochUnchanged
      : exactKeyMapUnchanged;
    const exactExpectedUnchanged = m?.partialExpectedCount === msgCount
      && m?.partialExpectedSha256 === expected.sha256;
    // Backoff is stricter than monotonic-cursor resume: delay expensive
    // replays only under an unchanged exact set + key-map proof (and unchanged
    // epoch when one exists). Any evidence change immediately retries.
    const retryProofUnchanged = exactExpectedUnchanged
      && exactKeyMapUnchanged
      && (!hasStableUidEpoch || stableUidEpochUnchanged);
    const terminalNativeProofUnchanged = Number.isSafeInteger(m?.partialPostVerifyFtsCount)
      && m.partialPostVerifyFtsCount >= 0
      && typeof m?.partialPostVerifyFtsSha256 === "string"
      && m.partialPostVerifyFtsSha256.length > 0
      && m.partialPostVerifyFtsCount === nativeFingerprint.count
      && m.partialPostVerifyFtsSha256 === nativeFingerprint.sha256;
    const retryReadNowMs = Date.now();
    let preservedRetryState = null;
    if (retryProofUnchanged
        && terminalNativeProofUnchanged
        && Number.isInteger(m?.partialPostVerifyFailureCount)
        && m.partialPostVerifyFailureCount > 0) {
      const retryNotBeforeMs = _sanitizeFolderReconRetryNotBeforeMs(
        m.partialRetryNotBeforeMs,
        retryReadNowMs,
      );
      preservedRetryState = {
        failureCount: m.partialPostVerifyFailureCount,
        retryNotBeforeMs,
        ftsCount: m.partialPostVerifyFtsCount,
        ftsSha256: m.partialPostVerifyFtsSha256,
      };
      // A far-future value can result from corrupt storage or a wall-clock
      // rollback. Clamp it once against the current clock and persist that
      // absolute deadline. Subsequent reads retain the earlier deadline
      // instead of sliding it forward by another seven days.
      if (m.partialRetryNotBeforeMs !== undefined
          && m.partialRetryNotBeforeMs !== retryNotBeforeMs) {
        if (retryNotBeforeMs > 0) {
          m.partialRetryNotBeforeMs = retryNotBeforeMs;
        } else {
          delete m.partialRetryNotBeforeMs;
        }
        m.updatedAtMs = retryReadNowMs;
        memoChanged = true;
      }
    }

    const persistedStaleState = retryProofUnchanged
      && typeof m?.staleAfterKey === "string"
      && Number.isSafeInteger(m?.partialStaleFtsCount)
      && m.partialStaleFtsCount >= 0
      && typeof m?.partialStaleFtsSha256 === "string"
      && m.partialStaleFtsSha256.length > 0
      ? {
        afterKey: m.staleAfterKey,
        count: m.partialStaleFtsCount,
        sha256: m.partialStaleFtsSha256,
      }
      : null;
    const writeVerifiedCheckpoint = (ftsFingerprint, proof = expected, identityFields = null) => {
      if (proof.fromWorkingProof === true) throw new Error("retained_folder_proof_cannot_verify");
      _assertFolderReconGeneration(generation, proof.localScope);
      if (!ftsMembershipUnchangedSince(_folderReconNativeScope(f), folderMembershipEpoch)) {
        throw new Error("membership_epoch_changed");
      }
      const proofUidValidity = proof.stableUidKeys === true
        ? _normalizeUidValidity(proof.uidValidity)
        : null;
      const record = {
        verified: true,
        expectedCount: proof.count,
        expectedSha256: proof.sha256,
        ftsCount: ftsFingerprint.count,
        ftsSha256: ftsFingerprint.sha256,
        keyMapCount: proof.keyMapCount,
        keyMapSha256: proof.keyMapSha256,
        ...(proofUidValidity !== null ? {
          uidValidity: proofUidValidity,
          uidCount: proof.uidCount,
          uidSha256: proof.uidSha256,
        } : {}),
        ...(identityFields || {}),
        updatedAtMs: Date.now(),
      };
      const proofEpoch = getFtsMembershipEpoch();
      // An unchanged proof earns this session's verification without a
      // storage write; only a changed proof replaces the stored checkpoint.
      const changed = !_sameFolderReconCheckpoint(memo.folders[folderKey], record);
      if (changed) {
        memo.folders[folderKey] = record;
        memoChanged = true;
        memoEpochByFolder.set(folderKey, proofEpoch);
      }
      verifiedThisRun.add(folderKey);
      verifiedEpochByFolder.set(folderKey, proofEpoch);
      _releaseFolderReconActiveProof(folderKey, "verified");
      return changed;
    };
    const writePartialCheckpoint = (
      cursor,
      cursorStarted,
      retryState = preservedRetryState,
      staleState = null,
    ) => {
      memo.folders[folderKey] = {
        verified: false,
        // Kept for downgrade compatibility with builds that used the exact-set
        // digest as their partial-resume proof; current builds also read it as
        // one component of the stricter terminal-retry proof.
        partialExpectedCount: msgCount,
        partialExpectedSha256: expected.sha256,
        missingBackfillKey: cursor,
        missingBackfillStarted: cursorStarted === true,
        ...(staleState ? {
          staleAfterKey: staleState.afterKey,
          partialStaleFtsCount: staleState.count,
          partialStaleFtsSha256: staleState.sha256,
        } : {}),
        ...(hasKeyMapFingerprint ? {
          partialKeyMapCount: expected.keyMapCount,
          partialKeyMapSha256: expected.keyMapSha256,
        } : {}),
        ...(hasStableUidEpoch ? {
          partialStableUidKeys: true,
          partialUidValidity: stableUidValidity,
        } : {}),
        ...(retryState?.failureCount > 0 ? {
          partialPostVerifyFailureCount: retryState.failureCount,
          partialPostVerifyFtsCount: retryState.ftsCount,
          partialPostVerifyFtsSha256: retryState.ftsSha256,
          ...(retryState.retryNotBeforeMs > 0 ? {
            partialRetryNotBeforeMs: retryState.retryNotBeforeMs,
          } : {}),
        } : {}),
        updatedAtMs: Date.now(),
      };
      memoChanged = true;
      // Bind the targeted commit to the epoch that earned its native proof.
      // A later foreground mutation must reject the cursor, never rebind it
      // to whatever epoch happens to be current after subsequent awaits.
      memoEpochByFolder.set(
        folderKey,
        staleState?.membershipEpoch ?? folderMembershipEpoch,
      );
    };

    // Direct cryptographic equality — this is the only path that creates a
    // verified checkpoint.
    if (msgCount === ftsCount && expected.sha256 === nativeFingerprint.sha256) {
      let identityFields = null;
      if (identityEvidence) {
        const closing = await _readFolderReconClosingState(f);
        _assertFolderReconLease(reconcileLease, generation);
        if (!_folderReconIdentityUnchanged(f, closing)) {
          stats.foldersLocalDrift++;
          logFtsOperation("folder_recon", "identity_changed", { folderPath: f.folderPath });
          continue;
        }
        identityFields = _folderReconEarnedToken(f, expected);
      }
      if (writeVerifiedCheckpoint(nativeFingerprint, expected, identityFields)) stats.foldersClean++;
      else stats.foldersMemoHit++;
      _folderReconUnverified.delete(folderKey);
      continue;
    }

    // Backoff covers the whole expensive replay. Running stale global
    // rechecks before this gate defeated its purpose and could still saturate
    // the parent thread on every scheduler tick.
    if (preservedRetryState?.retryNotBeforeMs > Date.now()) {
      const resumeKey = _normalizeMsgKeyCursor(m?.missingBackfillKey) ?? 0;
      const resumeStarted = m?.missingBackfillStarted === true;
      writePartialCheckpoint(
        resumeKey,
        resumeStarted,
        preservedRetryState,
        persistedStaleState,
      );
      stats.foldersBackoff++;
      continue;
    }

    // 6) A digest mismatch is an exact set-difference trigger. Always run both
    //    directions: counts can be equal while one stale key and one missing
    //    key cancel out. Sliced work remains explicitly unverified and resumes
    //    on a later scheduler turn, never memoized as clean.
    log(`[FTS FolderRecon] ${folderKey}: membership digest mismatch (fts=${ftsCount}, expected=${msgCount}) — running exact two-way reconcile`, "warn");
    const staleResumeKey = persistedStaleState?.count === nativeFingerprint.count
      && persistedStaleState?.sha256 === nativeFingerprint.sha256
      ? persistedStaleState.afterKey
      : null;
    const nativeFingerprintEpoch = folderMembershipEpoch;
    const stalePass = await _folderReconStaleDirection(
      ftsSearch,
      f,
      startKey,
      endKey,
      stats,
      budget,
      staleResumeKey,
      folderMembershipEpoch,
      membershipMode,
      { memo, folderKeys: removalHandoffFolderKeys },
    );
    if (stalePass.membershipEpoch !== undefined) folderMembershipEpoch = stalePass.membershipEpoch;
    const staleBudgetPartial = stalePass.budgetPartial;
    if (stalePass.localDrift) {
      stats.foldersLocalDrift++;
      continue;
    }
    if (!stalePass.clean && !staleBudgetPartial) {
      stats.foldersFailed++;
      continue;
    }
    let nextStaleState = null;
    if (stalePass.cursor) {
      const staleCursorEpoch = stalePass.membershipEpoch ?? folderMembershipEpoch;
      try {
        // The range fingerprint may be data-sized. Capture it without holding
        // the membership mutex, then bind the cursor only if its earning epoch
        // is still current. A later storage commit fences the same epoch.
        _assertNoFolderReconForegroundPressure();
        // Exact membership has only one native page allowance per scheduler
        // slice. The stale list just spent it; a second fingerprint here would
        // fail on every retry before the cursor could ever be saved. Reuse the
        // initial fingerprint only while its membership epoch is unchanged.
        // A local stale removal changes the epoch. Leave the stale cursor
        // unbound so the next slice starts from a fresh native proof, while
        // this slice can still admit missing local rows below.
        if (!membershipMode.exact
            || ftsMembershipUnchangedSince(_folderReconNativeScope(f), nativeFingerprintEpoch)) {
          const staleFingerprint = membershipMode.exact
            ? nativeFingerprint
            : await _fingerprintFolderNative(
              ftsSearch, f, startKey, endKey, "stale_checkpoint", membershipMode,
            );
          _assertFolderReconLease(reconcileLease, generation);
          _assertNoFolderReconForegroundPressure();
          if (!ftsMembershipUnchangedSince(_folderReconNativeScope(f), staleCursorEpoch)) {
            throw new Error("membership_epoch_changed");
          }
          folderMembershipEpoch = staleCursorEpoch;
          nextStaleState = {
            afterKey: stalePass.cursor,
            count: staleFingerprint.count,
            sha256: staleFingerprint.sha256,
            membershipEpoch: staleCursorEpoch,
          };
        }
      } catch (e) {
        _throwIfFolderReconInterrupted(e);
        stats.foldersFailed++;
        logFtsOperation("folder_recon", "stale_checkpoint_fingerprint_error", {
          folderPath: f.folderPath,
          error: String(e),
        });
        continue;
      }
    }

    const normalizedResumeKey = _normalizeMsgKeyCursor(m?.missingBackfillKey);
    const storedResumeStarted = m?.missingBackfillStarted === true;
    const resumeStarted = normalizedResumeKey !== null
      && storedResumeStarted
      && resumeProofUnchanged;
    const resumeKey = resumeStarted
      ? normalizedResumeKey
      : 0;

    // Missing adds are independent of unresolved stale candidates: the native
    // filter can safely nominate local headers while stale rechecks remain.
    // The folder stays explicitly unverified and never reaches the equality
    // checkpoint until both directions complete.
    budget.scans = missingScansPerFolder;
    const enqueuedBefore = stats.missingEnqueued;
    const missingPass = await _folderReconMissingDirection(
      ftsSearch,
      f,
      stats,
      budget,
      resumeKey,
      expected.sortedKeys,
      expected.proofGuard,
      resumeStarted,
    );
    if (missingPass.localDrift) {
      // A local removal can make an already-passed native row newly stale, so
      // neither direction's cursor is reusable across local proof drift.
      writePartialCheckpoint(0, false, null, null);
    } else if (missingPass.cursorStarted
        && (!resumeStarted || missingPass.cursor > resumeKey)) {
      writePartialCheckpoint(
        missingPass.cursor,
        true,
        preservedRetryState,
        nextStaleState,
      );
    } else if (missingPass.budgetPartial || staleBudgetPartial) {
      writePartialCheckpoint(
        resumeKey,
        resumeStarted,
        preservedRetryState,
        nextStaleState,
      );
    }

    if (missingPass.localDrift) {
      stats.foldersLocalDrift++;
      log(`[FTS FolderRecon] ${folderKey}: local membership changed during repair — restarting without backoff`, "warn");
      continue;
    } else if (missingPass.budgetPartial) {
      stats.foldersBudgetPartial++;
      if (f.folderId) _folderMembershipYieldedAttempts.set(f.folderId, attemptMarkSerial);
      log(`[FTS FolderRecon] ${folderKey}: exact pass budget-truncated — checkpoint remains unverified`, "warn");
    } else if (!missingPass.clean) {
      stats.foldersFailed++;
      log(`[FTS FolderRecon] ${folderKey}: exact pass had errors — checkpoint remains unverified`, "warn");
    } else {
      const enqueuedHere = stats.missingEnqueued - enqueuedBefore;
      if (enqueuedHere > 0) {
        // The exact expected set is known but native FTS cannot match until the
        // shared drain indexes the queued bodies. Re-run this folder once the
        // queue is empty; do not write a verified checkpoint early.
        _folderReconDrainSkipped.add(folderKey);
        if (staleBudgetPartial) stats.foldersBudgetPartial++;
        continue;
      }

      if (staleBudgetPartial) {
        stats.foldersBudgetPartial++;
        if (f.folderId) _folderMembershipYieldedAttempts.set(f.folderId, attemptMarkSerial);
        continue;
      }

      // 7) No queued writes remain: take a fresh bounded local snapshot and
      // compare it to a fresh native fingerprint. Only this post-work pair can
      // mint a verified checkpoint.
      try {
        const priorGuardCurrent = _folderReconProofGuardCurrent(expected.proofGuard);
        const freshExpected = await _scanFolderMessagesCooperatively(f, generation, true);
        const localDrift = !priorGuardCurrent
          || _folderReconLocalProofChanged(expected, freshExpected);
        const freshEntry = _admitFolderReconActiveProof(
          folderKey, f, freshExpected, generation, "verify",
        );
        const freshGuard = _folderReconGuardForFreshProof(folderKey, freshEntry, freshExpected);
        folderMembershipEpoch = getFtsMembershipEpoch();
        _assertNoFolderReconForegroundPressure();
        // Exact membership already spent its native page allowance during
        // the stale pass. Its initial digest is still a terminal proof if no
        // membership mutation crossed the epoch fence during the local scan.
        if (membershipMode.exact
            && !ftsMembershipUnchangedSince(_folderReconNativeScope(f), nativeFingerprintEpoch)) {
          writePartialCheckpoint(0, false, null, null);
          stats.foldersLocalDrift++;
          continue;
        }
        const ftsNow = membershipMode.exact
          ? nativeFingerprint
          : await _fingerprintFolderNative(
            ftsSearch, f, startKey, endKey, "terminal", membershipMode,
          );
        _assertFolderReconLease(reconcileLease, generation);
        _assertNoFolderReconForegroundPressure();
        if (!ftsMembershipUnchangedSince(_folderReconNativeScope(f), folderMembershipEpoch)) {
          writePartialCheckpoint(0, false, null, null);
          stats.foldersLocalDrift++;
        } else if (!_folderReconProofGuardCurrent(freshGuard)) {
          writePartialCheckpoint(0, false, null, null);
          stats.foldersLocalDrift++;
        } else if (ftsNow.count === freshExpected.count && ftsNow.sha256 === freshExpected.sha256) {
          const closing = identityEvidence ? await _readFolderReconClosingState(f) : null;
          if (identityEvidence) _assertFolderReconLease(reconcileLease, generation);
          if (identityEvidence && !_folderReconIdentityUnchanged(f, closing)) {
            writePartialCheckpoint(0, false, null, null);
            stats.foldersLocalDrift++;
          } else {
            writeVerifiedCheckpoint(
              ftsNow,
              freshExpected,
              identityEvidence ? _folderReconEarnedToken(f, freshExpected) : null,
            );
            stats.foldersReconciled++;
            _folderReconUnverified.delete(folderKey);
          }
        } else if (localDrift) {
          // The completed cursor belonged to the earlier proof. A changed
          // local set restarts from zero immediately; it is not a failed
          // repair and must not accumulate terminal-mismatch backoff.
          writePartialCheckpoint(0, false, null, null);
          stats.foldersLocalDrift++;
        } else {
          stats.foldersFailed++;
          // A complete sweep that still fails equality disproves the cursor's
          // claim that everything below it was accounted for (for example, a
          // transient filter false-negative). Replay once immediately; only
          // repeated failures under the same exact proof get exponential
          // wall-clock backoff. The cap preserves eventual future healing.
          const failureCount = (preservedRetryState?.failureCount || 0) + 1;
          const backoffMs = failureCount < 2
            ? 0
            : Math.min(
              FOLDER_RECON_POST_VERIFY_BACKOFF_INITIAL_MS * (2 ** Math.min(failureCount - 2, 30)),
              FOLDER_RECON_POST_VERIFY_BACKOFF_MAX_MS,
            );
          const retryState = {
            failureCount,
            retryNotBeforeMs: backoffMs > 0 ? Date.now() + backoffMs : 0,
            ftsCount: ftsNow.count,
            ftsSha256: ftsNow.sha256,
          };
          writePartialCheckpoint(0, false, retryState, null);
          log(`[FTS FolderRecon] ${folderKey}: post-repair digest still differs — checkpoint remains unverified`, "warn");
        }
      } catch (e) {
        _throwIfFolderReconInterrupted(e);
        stats.foldersFailed++;
        logFtsOperation("folder_recon", "post_fingerprint_error", { folderPath: f.folderPath, error: String(e) });
      }
    }

    // 8) Yield between folders.
    if (FOLDER_RECON_CHUNK_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, FOLDER_RECON_CHUNK_DELAY_MS));
    }
  }
  openAttemptFolderId = null;

  if (memoChanged) {
    _assertFolderReconGeneration(generation);
    const folderByKey = new Map((folders || []).map(folder =>
      [`${folder.accountId}:${folder.folderPath}`, folder]));
    const fencedKeys = [...memoEpochByFolder.keys()];
    for (const folderKey of fencedKeys) {
      const commitEpoch = memoEpochByFolder.get(folderKey);
      const commitScope = _folderReconNativeScope(folderByKey.get(folderKey));
      // Strict storage serialization owns memo generation/merge correctness;
      // the membership mutex is reserved for the tiny post-write epoch check.
      await _assertFolderReconMembershipEpoch(commitEpoch, reconcileLease, generation, commitScope);
      await _writeFolderReconMemo(memo, { generation, folderKeys: [folderKey] });
      await _assertFolderReconMembershipEpoch(commitEpoch, reconcileLease, generation, commitScope);
    }
    // Migration-only fields carry no reusable proof and can be written through
    // the same strict chain without a membership fence.
    if (fencedKeys.length === 0 && memoChanged) {
      _assertFolderReconLease(reconcileLease, generation);
      await _writeFolderReconMemo(memo, { generation });
    }
  }

  stats.unverifiedFolders = _folderReconUnverified.size;
  Object.defineProperty(stats, "_verifiedThisRun", { value: verifiedThisRun });
  Object.defineProperty(stats, "_verifiedEpochByFolder", { value: verifiedEpochByFolder });
  Object.defineProperty(stats, "_attemptMarkSerialByFolder", { value: attemptMarkSerialByFolder });
  const elapsed = Date.now() - reconStart;
  log(`[FTS FolderRecon] Complete: ${stats.foldersTotal} folders (${stats.foldersMemoHit} memo-hit, ${stats.foldersClean} clean, ${stats.foldersReconciled} reconciled, ${stats.foldersDrainBusy} drain-busy, ${stats.foldersErrored} errored, ${stats.foldersFailed} failed, ${stats.foldersBudgetPartial} budget-partial, ${stats.foldersLocalDrift} local-drift, ${stats.foldersBackoff} backed-off), ${stats.staleRemoved} stale removed (${stats.staleCandidates} candidates, ${stats.recheckKeptPresent} present, ${stats.recheckKeptError} recheck-errors), ${stats.missingEnqueued} missing enqueued, ${stats.orphanRemoved} orphans removed, ${elapsed}ms`);
  logFtsBatchOperation("folder_recon", "complete", { ...stats, rerun: !!onlyFolderKeys, elapsedMs: elapsed });
  if (onlyFolderKeys && !schedulerLease) {
    _writeReconSnapshot("fts_folder_recon_last_rerun", {
      ...stats,
      rerun: true,
      elapsedMs: elapsed,
      activeWorkingProof: _folderReconWorkingProofTelemetry(),
    });
  } else {
    _recordFolderReconOutcome(stats, elapsed);
  }

  return stats;
  } catch (e) {
    if (openAttemptFolderId && _isFolderReconAttemptYield(e)) {
      _folderMembershipYieldedAttempts.set(openAttemptFolderId, openAttemptMarkSerial);
    }
    throw e;
  } finally {
    if (_folderReconInProgressOwner === owner) {
      _folderReconInProgressOwner = null;
    }
    if (ownsLease) reconcileLease.release();
    // If this pass itself enqueued the last outstanding repair, its drain may
    // have reached zero while the mutual-exclusion guard was still set. Wake
    // the cooperative scheduler now that the guard is clear.
    if (_folderReconInProgressOwner === null
        && _pendingUpdates.size === 0
        && _folderReconDrainSkipped.size > 0) {
      _wakeFolderRecon("drain_after_slice", FOLDER_RECON_PACE_DELAY_MS);
    }
  }
}

function _armFolderReconTimer(reason) {
  if (!_isEnabled || !_ftsSearch || _indexerDisposed) return;
  const nowMs = Date.now();
  const dueMs = Math.max(_folderReconHardNotBeforeMs, _folderReconRequestedDueMs);
  if (!Number.isFinite(dueMs)) return;
  // A later request never postpones earlier eligible work. A true raised
  // eligibility floor does re-arm later, and an earlier request re-arms sooner.
  if (_folderReconTimer) {
    const mustMoveLater = _folderReconHardNotBeforeMs > _folderReconTimerDueMs;
    const mayMoveEarlier = dueMs < _folderReconTimerDueMs;
    if (!mustMoveLater && !mayMoveEarlier) return;
    clearTimeout(_folderReconTimer);
    _folderReconTimer = null;
  }
  const generation = _folderReconGeneration;
  const token = ++_folderReconTimerToken;
  const scheduledDelayMs = Math.max(0, Math.floor(dueMs - nowMs));
  _folderReconTimerDueMs = nowMs + scheduledDelayMs;
  if (!_folderReconRuntimeTelemetry) _resetFolderReconRuntimeTelemetry();
  _folderReconRuntimeTelemetry.lastScheduledDelayMs = scheduledDelayMs;
  _folderReconRuntimeTelemetry.maxScheduledDelayMs = Math.max(
    _folderReconRuntimeTelemetry.maxScheduledDelayMs,
    scheduledDelayMs,
  );
  _folderReconTimer = setTimeout(() => {
    if (token !== _folderReconTimerToken || generation !== _folderReconGeneration) return;
    _folderReconTimer = null;
    _folderReconTimerDueMs = 0;
    if (Date.now() < _folderReconHardNotBeforeMs) {
      _folderReconRequestedDueMs = Math.min(_folderReconRequestedDueMs, Date.now());
      _armFolderReconTimer("floor_recheck");
      return;
    }
    _folderReconRequestedDueMs = Infinity;
    _runFolderReconSchedulerTick().catch(e => {
      log(`[FTS FolderRecon] Scheduler tick failed (${reason}): ${e}`, "warn");
      _wakeFolderRecon("error_retry", FOLDER_RECON_ERROR_DELAY_MS);
    });
  }, scheduledDelayMs);
}

function _wakeFolderRecon(reason = "work", delayMs = FOLDER_RECON_PACE_DELAY_MS) {
  if (!_isEnabled || !_ftsSearch || _indexerDisposed) return;
  const normalizedDelayMs = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : 0;
  _folderReconRequestedDueMs = Math.min(_folderReconRequestedDueMs, Date.now() + normalizedDelayMs);
  _armFolderReconTimer(reason);
}

function _setFolderReconHardNotBeforeMs(notBeforeMs) {
  const normalized = Number.isFinite(notBeforeMs) ? Math.max(0, Math.floor(notBeforeMs)) : 0;
  if (normalized <= _folderReconHardNotBeforeMs) return;
  _folderReconHardNotBeforeMs = normalized;
  if (_folderReconTimer) _armFolderReconTimer("raised_floor");
}

/**
 * Legacy-helper orphan stage: prove that no native key lies outside every
 * inventory folder's prefix, removing confirmed orphans on the way. The pass
 * is volatile and bound to the tick's binding (generation, inventory digest,
 * native connection, topology serial); only a binding change restarts it.
 * Exact helpers need none of this: their completed, bound membership state
 * pass already removed every row whose owner left the inventory.
 */
async function _runFolderReconOrphanSlice(
  ftsSearch,
  identities,
  inventoryMembershipEpoch,
  inventoryTopologySerial = _folderReconTopologySerial,
) {
  const generation = _folderReconGeneration;
  const reconcileLease = _folderReconSchedulerOwner?.reconcileLease
    || _folderReconInProgressOwner?.reconcileLease;
  const knownFolderKeys = new Set(identities.map(i => `${i.accountId}:${i.folderPath}`));
  const assertCurrent = () => {
    if (reconcileLease) _assertFolderReconLease(reconcileLease, generation);
    if (_hasFolderReconForegroundPressure()) throw new Error("folder_recon_pressure");
  };
  const inventory = await _fingerprintStringsCooperatively(
    [...knownFolderKeys],
    true,
    assertCurrent,
  );
  if (reconcileLease) _assertFolderReconLease(reconcileLease, generation);
  const binding = _folderMembershipStatePassBinding(inventory, ftsSearch, inventoryTopologySerial);
  if (!_folderMembershipStatePassBound(_folderReconOrphanPass, binding)) {
    _folderReconOrphanPass = {
      ...binding,
      basisTried: false,
      basis: null,
      cursor: null,
      walkBaseline: null,
      walkMutated: false,
      unloaded: 0,
      complete: false,
    };
  }
  const pass = _folderReconOrphanPass;
  const stats = { orphanRemoved: 0, orphanKeysKept: 0 };
  if (pass.complete) return { complete: true, unloaded: pass.unloaded, ...stats };

  // One-shot count basis: the known folders' disjoint ranges sum to the
  // global count iff no row lies outside every range. Collected across
  // slices without restarting; a mismatch, a lost epoch or a read failure
  // sends this binding to the walk, never to a second basis.
  if (!pass.basisTried) {
    try {
      if (!pass.basis) {
        pass.basis = { epoch: getFtsMembershipEpoch(), nextFolderIndex: 0, knownCount: 0 };
      }
      const basis = pass.basis;
      const sliceEnd = Math.min(
        identities.length,
        basis.nextFolderIndex + FOLDER_RECON_ORPHAN_BASIS_FOLDERS_PER_SLICE,
      );
      while (basis.nextFolderIndex < sliceEnd) {
        const identity = identities[basis.nextFolderIndex];
        const { startKey, endKey } = _folderKeyRange(identity.accountId, identity.folderPath);
        assertCurrent();
        const range = await ftsSearch.countMsgIdRange(startKey, endKey);
        assertCurrent();
        basis.knownCount += Math.max(0, Number(range?.count) || 0);
        basis.nextFolderIndex++;
      }
      if (basis.nextFolderIndex < identities.length) {
        return { complete: false, deferred: true, basisProgress: true, ...stats };
      }
      assertCurrent();
      const global = await ftsSearch.countMsgIdRange("", FOLDER_RECON_KEYSPACE_END);
      assertCurrent();
      // Spent only once the global count is in hand: an interruption before
      // this point retries the count on the next slice instead of walking.
      pass.basisTried = true;
      if (Number(global?.count) === basis.knownCount) {
        // Through the mutex: waits out an in-flight drain mutation whose
        // native commit a count may already have seen.
        await _assertFolderReconMembershipEpoch(basis.epoch, reconcileLease, generation);
        if (_folderReconOrphanPass === pass
            && _folderMembershipStatePassBound(pass, _folderMembershipStatePassBinding(
              inventory,
              ftsSearch,
              _folderReconTopologySerial,
            ))) {
          pass.complete = true;
          return { complete: true, unloaded: pass.unloaded, ...stats };
        }
      }
    } catch (e) {
      _throwIfFolderReconInterrupted(e);
      pass.basisTried = true;
    }
    return { complete: false, deferred: true, basisProgress: true, ...stats };
  }

  const result = await _folderReconOrphanSweep(
    ftsSearch,
    knownFolderKeys,
    identities,
    stats,
    { rechecks: FOLDER_RECON_RECHECKS_PER_SLICE },
    pass,
    inventoryMembershipEpoch,
  );
  return { ...result, unloaded: pass.unloaded, ...stats };
}

async function _getFolderReconInventory(reconcileLease, generation) {
  const byFolderKey = new Map();
  for (const identity of await _listWeFolderIdentities()) {
    const accountId = String(identity?.accountId || "");
    const folderPath = String(identity?.folderPath || "");
    if (!accountId || !folderPath) continue;
    const folderKey = `${accountId}:${folderPath}`;
    if (!byFolderKey.has(folderKey)) {
      byFolderKey.set(folderKey, { ...identity, accountId, folderPath });
    }
  }
  const identities = [...byFolderKey.values()].sort((a, b) =>
    `${a.accountId}:${a.folderPath}`.localeCompare(`${b.accountId}:${b.folderPath}`));
  _assertFolderReconLease(reconcileLease, generation);
  // Before any proof about these folders is stamped.
  registerFtsMembershipFolders(identities.map(identity => identity.folderId));
  return identities;
}

/**
 * Cold-start guard for every "owner absent from the inventory" removal.
 *
 * `browser.accounts.list(true)` is a snapshot of what Thunderbird has LOADED,
 * not of what exists. At startup and after an MV3 resume an account whose
 * folder tree is not populated yet contributes zero folders, so every
 * membership row it owns reads as "opaque owner absent from the fresh
 * inventory". Treating that absence as deleted-folder evidence removed
 * ~58k rows across four not-yet-loaded accounts on 2026-09-10 while the one
 * loaded account was untouched. The legacy date-window stale-entry cleanup
 * (since deleted) always skipped an account it could not see for this exact
 * reason; the ADR-024 exact-membership paths had dropped that guard.
 *
 * Rule: a row may be judged stale by inventory absence ONLY when its account
 * is itself present in this very inventory (>= 1 enumerated folder). An
 * account with no enumerated folder is unknown, never deleted — keep its rows.
 * A genuinely removed account therefore keeps its ghosts until an explicit
 * repair scan; that is the accepted fail-closed cost.
 */
function _folderReconTrustedAccountIds(identities) {
  const accountIds = new Set();
  for (const identity of identities || []) {
    const accountId = String(identity?.accountId || "");
    if (accountId) accountIds.add(accountId);
  }
  return accountIds;
}

// The raw key is `accountId:folderPath:Message-ID`; Thunderbird account keys
// never contain ':' so the first separator is unambiguous. The opaque owner id
// is deliberately NOT decoded here (ADR-024: compare only, never decode).
function _folderReconAccountIdOfMsgId(msgId) {
  const text = String(msgId || "");
  const separator = text.indexOf(":");
  return separator > 0 ? text.slice(0, separator) : "";
}

const FOLDER_MEMBERSHIP_STATE_RESTART_TELEMETRY = Object.freeze({
  mutated_replay: "membershipStateRestartMutatedReplay",
  unresolved_replay: "membershipStateRestartUnresolvedReplay",
  binding_changed: "membershipStateRestartBindingChanged",
  page_invalid: "membershipStateRestartPageInvalid",
});

function _folderMembershipStatePassBinding(inventory, ftsSearch, topologySerial = _folderReconTopologySerial) {
  return {
    generation: _folderReconGeneration,
    inventoryCount: inventory.count,
    inventorySha256: inventory.sha256,
    connectionGeneration: _folderMembershipConnectionGeneration(ftsSearch),
    topologySerial,
  };
}

function _folderMembershipStatePassBound(pass, binding) {
  return !!pass
    && pass.generation === binding.generation
    && pass.inventoryCount === binding.inventoryCount
    && pass.inventorySha256 === binding.inventorySha256
    && pass.connectionGeneration === binding.connectionGeneration
    && pass.topologySerial === binding.topologySerial;
}

function _startFolderMembershipStatePass(binding, restartReason = null) {
  if (restartReason) {
    _bumpFolderReconTelemetry(FOLDER_MEMBERSHIP_STATE_RESTART_TELEMETRY[restartReason]);
  }
  _folderMembershipStatePass = {
    generation: binding.generation,
    inventoryCount: binding.inventoryCount,
    inventorySha256: binding.inventorySha256,
    connectionGeneration: binding.connectionGeneration,
    topologySerial: binding.topologySerial,
    startedBeforeFirst: true,
    afterMsgId: null,
    passMutated: false,
    passUnresolved: 0,
    unloaded: 0,
    slices: 0,
    completed: false,
    // No state page is read before this time: the in-session unresolved
    // replay's delay, or the backoff after rejected page mutations.
    notBeforeMs: 0,
    mutationFailures: 0,
  };
  return _folderMembershipStatePass;
}

function _currentFolderMembershipStatePass(binding) {
  const pass = _folderMembershipStatePass;
  if (_folderMembershipStatePassBound(pass, binding)) return pass;
  return _startFolderMembershipStatePass(binding, pass ? "binding_changed" : null);
}

// Restart from before-first. A continuation whose pass was already replaced
// (revocation, binding change) leaves the newer pass alone.
function _restartFolderMembershipStatePass(pass, reason) {
  if (_folderMembershipStatePass !== pass) return;
  _startFolderMembershipStatePass(pass, reason);
}

// A state-pass row's local evidence: a wildcard event since its baseline
// voids the page ("folder_changed_during_scan"); an event on the row's own
// raw key, or the key ledger's floor passing the baseline, refuses only the
// row ("membership_row_changed").
// "page": a wildcard local event voids every verdict on the page; "row": an
// event on the row's own key (or a keyless event in its folder, or the key
// floor) voids only this row.
function _folderReconRowState(localScope) {
  if (!_folderReconLocalWildcardUnchangedSince(localScope.since)) return "page";
  return _folderReconLocalExactKeyUnchangedSince(localScope.key, localScope.since) ? "current" : "row";
}

function _assertFolderReconRowCurrent(localScope) {
  const state = _folderReconRowState(localScope);
  if (state === "page") throw new Error("folder_changed_during_scan");
  if (state === "row") throw new Error("membership_row_changed");
}

/**
 * Total classifier for one NULL-owner native row (row-atomic):
 * - `unloaded`: the row's account is absent from this inventory — kept, no query;
 * - `ghost`: no live interpretation — no candidate folder, or every candidate
 *   globally absent;
 * - `assign`: exactly one present owner;
 * - `unresolved`: two present owners, a query error, or no account separator;
 * - `deferred`: the slice's global-query budget ran out before this row's
 *   first global query — nothing was decided, the row is retried next slice.
 * A scoped positive is conclusive ownership (ADR-017); only a scoped negative
 * or a scoped failure is confirmed by one global query per candidate. The
 * scoped check is the candidate folder's msgDB Message-ID index
 * (`probeMessageIds`, a hashed lookup): a folder-scoped `messages.query`
 * walks every message in the folder, which made a migration of an M-message
 * folder cost ~M² header visits. `folderURIs` caches each folder's URI for
 * the slice.
 */
async function _resolveFolderMembershipAssignment(
  msgId,
  identities,
  trustedAccountIds,
  assertCurrent,
  budget,
  folderURIs,
) {
  const accountId = _folderReconAccountIdOfMsgId(msgId);
  if (!accountId) return { kind: "unresolved" };
  if (!trustedAccountIds.has(accountId)) return { kind: "unloaded" };
  const folders = identities.map(identity => ({
    id: identity.weFolderId,
    accountId: identity.accountId,
    path: identity.folderPath,
  }));
  const candidates = getUniqueMessageKeyCandidates(msgId, folders);
  // The verdict reads only this raw key's messages, so only an event on the
  // key itself (or a keyless one in a folder whose range holds it) voids it,
  // refusing just this row; mail on other keys does not. An event naming no
  // folder voids the whole page.
  const localScope = {
    folderKeys: candidates.map(candidate => `${candidate.weFolder.accountId}:${candidate.weFolder.path}`),
    key: msgId,
    since: _folderReconLocalSerial,
  };
  const assertRowCurrent = () => {
    assertCurrent();
    _assertFolderReconRowCurrent(localScope);
  };
  const present = [];
  let globalQueried = false;
  for (const candidate of candidates) {
    assertRowCurrent();
    let scopedPositive = false;
    try {
      const folderKey = `${candidate.weFolder.accountId}:${candidate.weFolder.path}`;
      let folderURI = folderURIs.get(folderKey);
      if (folderURI === undefined) {
        const state = await browser.tmMsgNotify.getFolderState(
          candidate.weFolder.accountId, candidate.weFolder.path);
        folderURI = state?.error ? "" : String(state?.folderURI || "");
        folderURIs.set(folderKey, folderURI);
      }
      if (folderURI) {
        const probe = await browser.tmMsgNotify.probeMessageIds(folderURI, [candidate.headerID]);
        // Present only on a clean answer: a probe error or an uncertain
        // lookup is not evidence either way. A positive read across an event
        // in a candidate folder is voided by the commit-time row check.
        scopedPositive = !probe?.error
          && Array.isArray(probe?.missing)
          && !probe.missing.includes(candidate.headerID)
          && !(probe.uncertain || []).includes(candidate.headerID);
      }
    } catch {
      // A failed scoped check is not evidence either way; the global query decides.
    }
    if (!scopedPositive) {
      if (!globalQueried && budget.rechecks <= 0) return { kind: "deferred" };
      globalQueried = true;
      budget.rechecks--;
      assertRowCurrent();
      const verdict = await recheckMessageInFolder(candidate.headerID, candidate.weFolder);
      assertRowCurrent();
      if (verdict === "error") return { kind: "unresolved" };
      if (verdict !== "present") continue;
    }
    present.push(candidate);
  }
  if (present.length === 0) return { kind: "ghost" };
  if (present.length > 1) return { kind: "unresolved" };
  const owner = identities.find(identity =>
    identity.weFolderId === present[0].weFolder.id
    && identity.accountId === present[0].weFolder.accountId
    && identity.folderPath === present[0].weFolder.path);
  if (!owner) return { kind: "unresolved" };
  return { kind: "assign", assignment: { msgId, folderId: owner.folderId }, localScope };
}

// Fields of a folder checkpoint that let an unchanged terminal mismatch delay
// its next full replay (see writePartialCheckpoint in _runFolderReconcile).
const FOLDER_RECON_RETRY_AUTHORIZATION_FIELDS = Object.freeze([
  "partialPostVerifyFailureCount",
  "partialPostVerifyFtsCount",
  "partialPostVerifyFtsSha256",
  "partialRetryNotBeforeMs",
]);

/**
 * Hand a removal's raw keys to every inventory folder whose key range holds
 * one (colon-overlapping folders included). Removing such a row changes that
 * folder's raw-key availability without changing its owner listing or msgDB
 * digest, so a durable terminal-mismatch backoff would survive it and the
 * now-missing message would wait out that backoff. The authorization is
 * revoked first, in one storage transaction and only when the memo snapshot
 * shows it (no write otherwise); a storage failure throws and the caller
 * must remove nothing. Runs outside the membership mutex and fence.
 * Returns the walk marks, which the caller issues right before it dispatches
 * the removal: a removal that commits natively but whose reply is lost still
 * leaves each folder owed a walk.
 */
async function _prepareFolderReconRemovalHandoff(generation, memo, folderKeys, msgIds) {
  const affected = [...folderKeys].filter(folderKey =>
    msgIds.some(msgId => msgId.startsWith(`${folderKey}:`)));
  const authorized = affected.filter(folderKey =>
    FOLDER_RECON_RETRY_AUTHORIZATION_FIELDS.some(field =>
      memo.folders?.[folderKey]?.[field] !== undefined));
  if (authorized.length > 0) {
    await _reconStorageTransaction(generation, (state) => {
      for (const folderKey of authorized) {
        const checkpoint = state.memo.folders?.[folderKey];
        if (!checkpoint || typeof checkpoint !== "object") continue;
        for (const field of FOLDER_RECON_RETRY_AUTHORIZATION_FIELDS) delete checkpoint[field];
      }
    });
    // The snapshot must not write the revoked fields back later.
    for (const folderKey of authorized) {
      for (const field of FOLDER_RECON_RETRY_AUTHORIZATION_FIELDS) {
        delete memo.folders[folderKey][field];
      }
    }
  }
  return () => affected.forEach(_markFolderReconWalk);
}

function _folderReconBackoffWaitDelay(notBeforeMs) {
  return Math.min(
    FOLDER_RECON_BACKOFF_WAIT_CAP_MS,
    Math.max(FOLDER_RECON_PACE_DELAY_MS, notBeforeMs - Date.now()),
  );
}

// Rejected page mutations delay the next state page exponentially; folder
// turns continue meanwhile. A new pass resets it.
function _deferFolderMembershipStatePassAfterFailure(pass) {
  pass.mutationFailures++;
  pass.notBeforeMs = Date.now() + Math.min(
    FOLDER_RECON_ERROR_DELAY_MS * (2 ** Math.min(pass.mutationFailures - 1, 30)),
    FOLDER_RECON_GENERIC_FAILURE_BACKOFF_MAX_MS,
  );
}

/**
 * Upgrade only the additive folder relation. Each scheduler slice reads at
 * most one native membership-state page. Assignments are idempotent and
 * durable, so interruption restarts only the current proof, never a body
 * fetch or full-text reindex.
 *
 * Every tick calls it: it rechecks global cleanup against the tick's
 * inventory first. Without `readPage` (a folder turn), or before the pass's
 * not-before time, it then returns `{complete: false, pending: true}` without
 * spending the page budget.
 */
async function _runFolderMembershipMigrationSlice(
  ftsSearch,
  identities,
  reconcileLease,
  generation,
  inventoryMembershipEpoch,
  inventoryTopologySerial = _folderReconTopologySerial,
  inventoryLocalSerial = _folderReconLocalSerial,
  { readPage = true, memo } = {},
) {
  if (ftsSearch?.supportsFolderMembership?.() !== true) {
    // Reached only when capability left during the tick's awaits: nothing
    // was proven, so the tick must not credit orphan or session completion.
    // The next tick observes no capability and runs the legacy path.
    _revokeFolderMembershipCleanup();
    return { complete: false, legacy: true };
  }
  // The inventory and the state pages read no message state; each ownerless
  // row's verdict carries its own candidate folders' local scope.
  const assertCurrent = () => {
    _assertFolderReconLease(reconcileLease, generation);
    _assertNoFolderReconForegroundPressure();
  };
  const validIdentities = identities.filter(identity =>
    identity.accountId && identity.folderPath && identity.folderId && identity.weFolderId);
  const distinctFolderIds = new Set(validIdentities.map(identity => identity.folderId));
  if (validIdentities.length !== identities.length
      || distinctFolderIds.size !== validIdentities.length) {
    _revokeFolderMembershipCleanup();
    return { complete: false, failed: true, reason: "folder_id_inventory_invalid" };
  }
  const inventory = await _fingerprintStringsCooperatively(
    validIdentities.map(identity =>
      `${identity.folderId}\u0000${identity.accountId}\u0000${identity.folderPath}`),
    true,
    assertCurrent,
  );
  assertCurrent();
  const binding = _folderMembershipStatePassBinding(inventory, ftsSearch, inventoryTopologySerial);
  if (_folderMembershipCleanupProven) {
    // Checked before the page budget is spent: a completed migration leaves
    // this slice's native page to per-folder work. A completed pass expires
    // after one walk period, so an owned row a late native commit left for a
    // folder no walk visits is removed by the next pass.
    if (_folderMembershipCleanupComplete(binding)) {
      return { complete: true, cutover: true };
    }
    _revokeFolderMembershipCleanup();
  }

  // The pass lives only in this process, so a new session always starts it
  // before the first row. It assigns each ownerless row it meets (scoped
  // query first, global recheck only on a negative) and alone earns cutover;
  // an inventory change rebinds it.
  //
  // The pass certifies property P: every native row has a non-null owner that
  // structurally prefixes its raw msgId, and that owner is in the inventory
  // or its account is not loaded. Concurrent capable writes preserve P (one
  // derivation site for msgId and owner, the adapter refuses ownerless rows,
  // native never reassigns an owner), so the pass tolerates membership-epoch
  // drift between pages instead of restarting on every indexed message. What
  // can break P restarts it through the binding or revocation instead: a
  // legacy write needs a new native connection, a folder deletion changes
  // the inventory.
  const pass = _currentFolderMembershipStatePass(binding);
  assertCurrent();
  if (!readPage || Date.now() < pass.notBeforeMs) {
    return { complete: false, pending: true, notBeforeMs: pass.notBeforeMs };
  }
  let page;
  try {
    _consumeFolderMembershipPageBudget();
    page = await ftsSearch.listFolderMembershipState(
      pass.afterMsgId,
      FOLDER_MEMBERSHIP_STATE_PAGE_SIZE,
    );
  } catch (error) {
    return { complete: false, failed: true, reason: "membership_state_list_failed", error: String(error) };
  }
  assertCurrent();
  pass.slices++;
  _bumpFolderReconTelemetry("membershipStatePages");

  const entries = page.entries || [];
  const identityByFolderId = new Map(
    validIdentities.map(identity => [identity.folderId, identity]),
  );
  const trustedAccountIds = _folderReconTrustedAccountIds(validIdentities);
  if (entries.length > FOLDER_MEMBERSHIP_STATE_PAGE_SIZE
      || (page.done !== true && entries.length === 0)) {
    _restartFolderMembershipStatePass(pass, "page_invalid");
    return { complete: false, failed: true, reason: "membership_state_page_invalid" };
  }
  let previousMsgId = pass.afterMsgId;
  for (const entry of entries) {
    const msgId = entry?.msgId;
    try {
      _assertStrictMembershipCursor(previousMsgId, msgId);
    } catch (error) {
      _restartFolderMembershipStatePass(pass, "page_invalid");
      return {
        complete: false,
        failed: true,
        reason: "membership_state_order_invalid",
        error: String(error),
      };
    }
    previousMsgId = msgId;
    if (entry.folderId !== null
        && (typeof entry.folderId !== "string" || entry.folderId.length === 0)) {
      _restartFolderMembershipStatePass(pass, "page_invalid");
      return { complete: false, failed: true, reason: "membership_state_folder_id_invalid" };
    }
  }

  // Classify rows in order. The cursor only ever passes a fully classified
  // row, so a budget-deferred or event-voided row (and everything after it)
  // is re-read by the next slice, and a done:true page is terminal only once
  // its last row is in.
  // Each verdict records its row so a page cut at an invalidated assignment
  // drops everything after it.
  const staleOrphans = [];
  const assignments = [];
  const unresolvedRows = [];
  const unloadedRows = [];
  const budget = { rechecks: FOLDER_RECON_RECHECKS_PER_SLICE };
  const folderURIs = new Map();
  let processed = 0;
  // Foreground pressure while a row is classified cuts the page there like
  // a voided row. The commit (a write bounded by the page) checks only the
  // reconcile lease, and pressure is honoured once the cursor has advanced,
  // so recurring pressure cannot discard a page's progress forever.
  const assertCommitCurrent = () => _assertFolderReconLease(reconcileLease, generation);
  for (const entry of entries) {
    const msgId = entry.msgId;
    if (entry.folderId !== null) {
      const owner = identityByFolderId.get(entry.folderId);
      if (!owner) {
        if (!trustedAccountIds.has(_folderReconAccountIdOfMsgId(msgId))) {
          // The owner's whole account is absent from this inventory, so
          // Thunderbird has not loaded it yet; absence is not deletion
          // evidence (see _folderReconTrustedAccountIds). Keep the row and
          // let a later inventory that includes the account decide.
          unloadedRows.push(processed);
        } else {
          // The relation is authoritative even though the raw legacy key is
          // ambiguous. A non-null opaque id absent from this fresh, fenced
          // inventory whose account IS present belongs to a deleted/renamed
          // folder and is stale.
          staleOrphans.push({ msgId, row: processed });
        }
      } else if (!msgId.startsWith(`${owner.accountId}:${owner.folderPath}:`)) {
        // A current folder id attached to a structurally different raw key is
        // a conflict, not deletion evidence.
        unresolvedRows.push(processed);
      }
      processed++;
      continue;
    }
    let verdict;
    try {
      verdict = await _resolveFolderMembershipAssignment(
        msgId,
        validIdentities,
        trustedAccountIds,
        assertCurrent,
        budget,
        folderURIs,
      );
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("folder_recon_pressure")) break;
      if (message.includes("membership_row_changed")) {
        // An event on this row's own key voided its verdict: the row is
        // unresolved debt for the delayed replay and the page continues.
        _bumpFolderReconTelemetry("membershipStateRowsRefused");
        unresolvedRows.push(processed);
        processed++;
        continue;
      }
      if (!message.includes("folder_changed_during_scan")) throw error;
      // An event naming no folder voided every verdict; the rows before
      // this one still count.
      _bumpFolderReconTelemetry("membershipStatePageRetries");
      break;
    }
    if (verdict.kind === "deferred") break;
    if (verdict.kind === "assign") {
      const owner = identityByFolderId.get(verdict.assignment.folderId);
      assignments.push({
        ...verdict.assignment,
        ownerFolderKey: `${owner.accountId}:${owner.folderPath}`,
        row: processed,
        localScope: verdict.localScope,
      });
    } else if (verdict.kind === "ghost") staleOrphans.push({ msgId, row: processed });
    else if (verdict.kind === "unloaded") unloadedRows.push(processed);
    else unresolvedRows.push(processed);
    processed++;
  }
  // Native only fills a NULL owner, accepts an equal one and rolls back a
  // conflict (thrown: same-page retry), and a vanished row is a no-op.
  // An assignment commits only while its row's evidence is current (checked
  // synchronously before each batch call): a row whose own key changed since
  // its verdict is refused and counted unresolved, and the page continues;
  // a wildcard event ends the page at the first such row, and it and every
  // later row are re-read. A change during the batch call itself cannot be
  // undone, so the row owes its candidate folders a walk, whose stale and
  // missing directions repair a wrong owner. Each owner is owed a walk before
  // its batch is dispatched (a committed batch whose reply is lost still
  // leaves it owed), so its exact proof is earned on the grown listing.
  const rowState = entry => _folderReconRowState(entry.localScope);
  let staleOrphanMsgIds = [];
  let unresolved = 0;
  let unloadedAccountRowsKept = 0;
  // Stale owners and ghosts are judged against this tick's inventory, so the
  // removal is fenced on the epoch read before that inventory snapshot. Any
  // membership write since then (a row indexed into a folder created after the
  // snapshot looks exactly like a deleted folder's row) rejects the fence
  // before the mutator runs, and the same page is retried on a later slice.
  // A folder event (creation, rename, move) or an event naming no folder
  // since the snapshot refuses the page's removals. A message event since the
  // snapshot on a removed key itself (or a keyless one in a folder whose
  // range holds it, listed in the inventory or not), or a native write that
  // attempted that key, refuses only that key's removal: it is counted
  // unresolved and retried by the delayed replay. Mail on other keys does not.
  const assertRemovalCurrent = () => {
    assertCommitCurrent();
    if (_folderReconTopologySerial !== inventoryTopologySerial
        || !_folderReconLocalWildcardUnchangedSince(inventoryLocalSerial)) {
      throw new Error("folder_changed_during_scan");
    }
  };
  const removalKeyCurrent = msgId =>
    _folderReconLocalExactKeyUnchangedSince(msgId, inventoryLocalSerial)
    && ftsMembershipKeysUnchangedSince([msgId], inventoryMembershipEpoch);
  // A page with removals commits its assignments inside the removal's fence,
  // passing its token: the page's own owner writes are then recorded with the
  // fence's advance instead of voiding its removal. The assignments still
  // commit before the removals, so an event-withheld removal never costs
  // them; only a foreign membership write since the inventory refuses the
  // fence on entry, and then the whole page is re-read.
  const commitPage = async (membershipFenceToken) => {
    for (let offset = 0; offset < assignments.length;
      offset += FOLDER_MEMBERSHIP_ASSIGN_BATCH_SIZE) {
      let batch = assignments.slice(offset, offset + FOLDER_MEMBERSHIP_ASSIGN_BATCH_SIZE);
      assertCommitCurrent();
      const states = new Map(batch.map(entry => [entry, rowState(entry)]));
      const voided = batch.find(entry => states.get(entry) === "page");
      if (voided) {
        _bumpFolderReconTelemetry("membershipStatePageRetries");
        processed = voided.row;
        batch = batch.filter(entry => entry.row < voided.row);
      }
      const refused = batch.filter(entry => states.get(entry) === "row");
      if (refused.length > 0) {
        _bumpFolderReconTelemetry("membershipStateRowsRefused", refused.length);
        for (const entry of refused) unresolvedRows.push(entry.row);
        batch = batch.filter(entry => states.get(entry) === "current");
      }
      if (batch.length > 0) {
        pass.passMutated = true;
        for (const entry of batch) _markFolderReconWalk(entry.ownerFolderKey);
        try {
          await ftsSearch.assignFolderMembershipBatch(
            batch.map(({ msgId, folderId }) => ({ msgId, folderId })),
            membershipFenceToken);
        } catch (error) {
          _throwIfFolderReconInterrupted(error);
          return { complete: false, failed: true, reason: "legacy_assignment_failed", error: String(error) };
        } finally {
          for (const entry of batch) {
            if (rowState(entry) !== "current") entry.localScope.folderKeys.forEach(_markFolderReconWalk);
          }
        }
        assertCommitCurrent();
      }
      if (voided) break;
    }
    staleOrphanMsgIds = staleOrphans
      .filter(entry => entry.row < processed).map(entry => entry.msgId);
    unresolved = unresolvedRows.filter(row => row < processed).length;
    unloadedAccountRowsKept = unloadedRows.filter(row => row < processed).length;
    if (unloadedAccountRowsKept > 0) {
      _bumpFolderReconTelemetry("unloadedAccountRowsKept", unloadedAccountRowsKept);
      // Aggregate-only: no account, folder, or Message-ID values.
      log(`[FTS FolderRecon] Membership pass kept ${unloadedAccountRowsKept} row(s) whose account is absent from the current inventory — not loaded yet, not deletion evidence`, "warn");
    }
    if (staleOrphanMsgIds.length === 0) return null;
    assertRemovalCurrent();
    const currentRemovals = staleOrphanMsgIds.filter(removalKeyCurrent);
    const refusedRemovals = staleOrphanMsgIds.length - currentRemovals.length;
    if (refusedRemovals > 0) {
      _bumpFolderReconTelemetry("membershipStateRowsRefused", refusedRemovals);
      unresolved += refusedRemovals;
      staleOrphanMsgIds = currentRemovals;
    }
    if (staleOrphanMsgIds.length === 0) return null;
    // Sticky before the mutator: an interrupted or uncertain removal
    // still forces a full replay before cutover.
    pass.passMutated = true;
    markRemovalFolders();
    await ftsSearch.removeBatch(staleOrphanMsgIds, membershipFenceToken);
    assertRemovalCurrent();
    for (const msgId of staleOrphanMsgIds) {
      const remaining = await ftsSearch.getMessageByMsgId(msgId);
      assertRemovalCurrent();
      if (remaining?.msgId === msgId) throw new Error("stale_folder_remove_verify_failed");
    }
    return null;
  };
  let commitFailure;
  let markRemovalFolders;
  if (staleOrphans.length === 0) {
    commitFailure = await commitPage(null);
  } else {
    // Revoked before anything of the page is dispatched; a failed revocation
    // commits nothing and the page is retried after a backoff. The removal's
    // evidence stays the pre-inventory baseline, re-checked inside the fence.
    const removalCandidates = staleOrphans
      .filter(entry => entry.row < processed).map(entry => entry.msgId);
    try {
      assertCommitCurrent();
      markRemovalFolders = await _prepareFolderReconRemovalHandoff(
        generation,
        memo,
        validIdentities.map(identity => `${identity.accountId}:${identity.folderPath}`),
        removalCandidates,
      );
    } catch (error) {
      _throwIfFolderReconInterrupted(error);
      _deferFolderMembershipStatePassAfterFailure(pass);
      return { complete: false, failed: true, reason: "membership_retry_revoke_failed", error: String(error) };
    }
    try {
      commitFailure = await withFtsMembershipFence(inventoryMembershipEpoch, commitPage, {
        mutation: true,
        // Entry refuses only on a wildcard write or a passed key floor; a
        // write that attempted one of the ghost keys refuses that key alone
        // (removalKeyCurrent), so traffic on other keys, in the ghost's own
        // folder too, does not void the page.
        scope: { keys: [] },
      });
    } catch (error) {
      _throwIfFolderReconInterrupted(error);
      if (String(error?.message || error).includes("membership_epoch_changed")) {
        _bumpFolderReconTelemetry("membershipStatePageRetries");
        return { complete: false, retry: true, reason: "stale_folder_remove_fence_lost" };
      }
      if (String(error?.message || error).includes("folder_changed_during_scan")) {
        _bumpFolderReconTelemetry("membershipStatePageRetries");
        return { complete: false, retry: true, reason: "stale_folder_remove_event" };
      }
      _deferFolderMembershipStatePassAfterFailure(pass);
      return { complete: false, failed: true, reason: "stale_folder_remove_failed", error: String(error) };
    }
  }
  if (commitFailure) {
    if (commitFailure.reason === "legacy_assignment_failed") {
      _deferFolderMembershipStatePassAfterFailure(pass);
    }
    return commitFailure;
  }
  pass.passUnresolved += unresolved;
  pass.unloaded += unloadedAccountRowsKept;
  pass.afterMsgId = processed > 0 ? entries[processed - 1].msgId : pass.afterMsgId;
  assertCurrent();
  if (processed < entries.length) {
    return { complete: false, membershipStateProgress: true };
  }
  if (page.done === true) {
    if (pass.passMutated || pass.passUnresolved > 0) {
      const passUnresolved = pass.passUnresolved;
      _restartFolderMembershipStatePass(
        pass,
        passUnresolved > 0 ? "unresolved_replay" : "mutated_replay",
      );
      // Unresolved rows are retried in-session after a delay, so an idle
      // profile does not replay the whole relation continuously; folder
      // turns run meanwhile. A mutated replay is immediate.
      if (passUnresolved > 0 && _folderMembershipStatePass !== pass) {
        _folderMembershipStatePass.notBeforeMs =
          Date.now() + FOLDER_RECON_MEMBERSHIP_UNRESOLVED_RETRY_MS;
      }
      return {
        complete: false,
        restart: true,
        ...(passUnresolved > 0 ? { failed: true, reason: "unresolved_legacy_rows" } : {}),
      };
    }
    // Cutover is earned only by this process's own unbroken pass: one that
    // started before the first row under the binding that is still current.
    if (_folderMembershipStatePass !== pass
        || pass.startedBeforeFirst !== true
        || ftsSearch?.supportsFolderMembership?.() !== true
        || !_folderMembershipStatePassBound(
          pass,
          _folderMembershipStatePassBinding(inventory, ftsSearch),
        )) {
      return { complete: false, restart: true, reason: "membership_state_binding_changed" };
    }
    pass.completed = true;
    pass.completedAtMs = Date.now();
    _folderMembershipCleanupProven = true;
    _bumpFolderReconTelemetry("membershipCutovers");
    _folderReconRuntimeTelemetry.membershipLastPassSlices = pass.slices;
    return { complete: true, cutover: true };
  }
  return { complete: false, membershipStateProgress: true };
}

/** Run one fair, bounded-cost folder/orphan slice and arrange the next tick. */
async function _runFolderReconSchedulerTick(ftsSearch = _ftsSearch) {
  try {
    return await _runFolderReconSchedulerSlice(ftsSearch);
  } finally {
    // Every exit keeps exact mode's rolling tick armed, so a completed
    // session still re-walks due folders and discovers a late-loading
    // account. The wake only ever moves the timer earlier, so it never
    // postpones other eligible work.
    const remainingMs = _folderReconRollingDueMs - Date.now();
    if (_folderReconRollingDueMs > 0 && remainingMs > 0) {
      _wakeFolderRecon("rolling_walk", remainingMs);
    }
  }
}

// Stable position of a folder within the walk period, so a startup cohort is
// spread across the period once: FNV-1a over the key's UTF-16 code units,
// then the murmur3 finalizer, without which keys differing only in a suffix
// (Archive/2023, Archive/2024) cluster in the high bits.
function _folderReconWalkOffsetMs(folderKey) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < folderKey.length; index++) {
    hash ^= folderKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return Math.floor(((hash >>> 0) / 0x100000000) * FOLDER_RECON_WALK_PERIOD_MS);
}

// A certification sets the folder's next rolling walk: one walk period after
// it, except the first of a generation, which lands at the folder's stable
// offset into the period.
function _scheduleFolderReconNextWalk(folderKey, certifiedAtMs) {
  _folderReconNextWalkDueMs.set(folderKey, _folderReconNextWalkDueMs.has(folderKey)
    ? certifiedAtMs + FOLDER_RECON_WALK_PERIOD_MS
    : certifiedAtMs + _folderReconWalkOffsetMs(folderKey));
}

// Exact mode's rolling tick, consumed only under the reconcile lease. The
// first call of a generation arms it; a due tick marks every completed folder
// whose next walk is due, so each folder is walked again within one walk
// period plus one tick interval. Only a completed folder is admitted: a
// folder with outstanding work has no session completion (a mark removes
// it), and re-marking one mid-attempt would keep that attempt from ever
// discharging. Writes no storage.
function _consumeFolderReconRollingTick() {
  const nowMs = Date.now();
  const due = _folderReconRollingDueMs !== 0 && nowMs >= _folderReconRollingDueMs;
  if (_folderReconRollingDueMs !== 0 && !due) return;
  _folderReconRollingDueMs = nowMs + FOLDER_RECON_REVERIFY_INTERVAL_MS;
  if (!due) return;
  for (const [folderKey, dueMs] of [..._folderReconNextWalkDueMs]) {
    if (dueMs > nowMs || !_folderReconSessionDone.has(folderKey)) continue;
    _markFolderReconWalk(folderKey);
  }
}

async function _runFolderReconSchedulerSlice(ftsSearch) {
  _bumpFolderReconTelemetry("schedulerTicks");
  if (!_isEnabled || !ftsSearch || _indexerDisposed) return { skipped: true, reason: "disabled" };
  if (Date.now() < _folderReconHardNotBeforeMs) {
    _wakeFolderRecon("hard_floor", _folderReconHardNotBeforeMs - Date.now());
    return { skipped: true, reason: "hard_floor" };
  }
  if (_folderReconSchedulerOwner || _folderReconInProgressOwner) {
    _bumpFolderReconTelemetry("schedulerBusySkips");
    _wakeFolderRecon("already_running", FOLDER_RECON_PACE_DELAY_MS);
    return { skipped: true, reason: "busy" };
  }
  const generation = _folderReconGeneration;
  const eventSerial = _folderReconLocalSerial;
  // The quiet veto protects only the legacy key-range proof, which ordinary
  // sync traffic invalidates. Exact membership proofs are fenced on their
  // folder's own change evidence instead, so a capable helper keeps
  // reconciling (and can earn cutover) under sustained traffic.
  if (_hasFolderReconForegroundPressure()
      || (!_isFolderMembershipCapable(ftsSearch)
        && Date.now() - _lastSyncEventMs < FOLDER_RECON_SYNC_QUIET_MS)
  ) {
    _bumpFolderReconTelemetry("schedulerPressureSkips");
    _wakeFolderRecon("foreground_pressure", FOLDER_RECON_PRESSURE_DELAY_MS);
    return { skipped: true, reason: "pressure" };
  }

  const reconcileLease = tryAcquireFtsReconcileLease();
  if (!reconcileLease) {
    _bumpFolderReconTelemetry("schedulerBusySkips");
    _wakeFolderRecon("operation_busy", FOLDER_RECON_PRESSURE_DELAY_MS);
    return { skipped: true, reason: "operation_busy" };
  }
  const sliceStartedAt = Date.now();
  const cooperativeDelay = (minimumMs = FOLDER_RECON_PACE_DELAY_MS) =>
    Math.max(minimumMs, Date.now() - sliceStartedAt);
  const owner = { generation, reconcileLease };
  _folderReconSchedulerOwner = owner;
  const folderMembershipCapable = _observeFolderMembershipCapability(ftsSearch);
  _folderMembershipPageBudget = 1;
  _bumpFolderReconTelemetry("schedulerSlices");
  try {
    let scanGate;
    try {
      scanGate = await _readFolderReconScanGateStrict();
      _assertFolderReconLease(reconcileLease, generation);
    } catch (e) {
      if (String(e?.message || e).includes("folder_recon_cancelled")) throw e;
      _wakeFolderRecon("scan_gate_read_failed", FOLDER_RECON_ERROR_DELAY_MS);
      return { skipped: true, reason: "scan_gate_read_failed" };
    }
    if (!scanGate.allowed) {
      _wakeFolderRecon(scanGate.reason, FOLDER_RECON_ERROR_DELAY_MS);
      return { skipped: true, reason: scanGate.reason };
    }
    // Read BEFORE the inventory snapshot: a stale-owner removal judged against
    // this inventory is fenced on it, so a row indexed into a folder created
    // after the snapshot can never be mistaken for a deleted folder's row.
    const inventoryMembershipEpoch = getFtsMembershipEpoch();
    const inventoryTopologySerial = _folderReconTopologySerial;
    const inventoryLocalSerial = _folderReconLocalSerial;
    const identities = await _getFolderReconInventory(reconcileLease, generation);
    const keys = identities.map(i => `${i.accountId}:${i.folderPath}`);
    const currentFolderKeys = new Set(keys);
    _folderReconKnownFolderKeys = currentFolderKeys;
    _pruneFolderReconRuntimeToFolderKeys(
      currentFolderKeys,
      new Set(identities.map(identity => identity.folderId)),
    );
    const memo = await _getFolderReconMemo();
    _assertFolderReconLease(reconcileLease, generation);
    // A state-pass page is read only on a pass turn; every tick rechecks
    // global cleanup. Returns null after foreground pressure.
    const runMembershipPass = async (readPage) => {
      try {
        const migration = await _runFolderMembershipMigrationSlice(
          ftsSearch,
          identities,
          reconcileLease,
          generation,
          inventoryMembershipEpoch,
          inventoryTopologySerial,
          inventoryLocalSerial,
          { readPage, memo },
        );
        _assertFolderReconLease(reconcileLease, generation);
        return migration;
      } catch (error) {
        const message = String(error?.message || error);
        if (!message.includes("folder_recon_pressure")) throw error;
        if (readPage) _folderReconMembershipTurn = "folders";
        _bumpFolderReconTelemetry("schedulerPressureSkips");
        _wakeFolderRecon("membership_pressure", cooperativeDelay(FOLDER_RECON_PRESSURE_DELAY_MS));
        return null;
      }
    };
    const finishMembershipPassTurn = (migration) => {
      _folderReconMembershipTurn = "folders";
      _wakeFolderRecon("membership_continue", migration.failed
        ? cooperativeDelay(FOLDER_RECON_ERROR_DELAY_MS)
        : cooperativeDelay());
      return { complete: false, migration };
    };
    // The pending pass on a folder turn while cleanup is incomplete.
    let pendingMembershipPass = null;
    if (folderMembershipCapable) {
      const migration = await runMembershipPass(_folderReconMembershipTurn === "pass");
      if (!migration) return { skipped: true, reason: "pressure" };
      if (migration.pending) {
        // A folder turn: the next slice belongs to the pass.
        _folderReconMembershipTurn = "pass";
        pendingMembershipPass = migration;
      } else if (!migration.complete) {
        return finishMembershipPassTurn(migration);
      }
    }
    // Decided once, before the tick's first await: a capability that arrives
    // during the awaits must not credit the orphan pass below without the
    // cleanup pass this tick never ran.
    const exactMembership = folderMembershipCapable;
    if (exactMembership) _consumeFolderReconRollingTick();
    else _folderReconRollingDueMs = 0;
    const ambiguous = exactMembership
      ? { folderKeys: new Set(), groups: 0 }
      : _folderReconAmbiguousKeyspaces(identities);
    if (!_folderReconRuntimeTelemetry) _resetFolderReconRuntimeTelemetry();
    _folderReconRuntimeTelemetry.ambiguousGroups = ambiguous.groups;
    _folderReconRuntimeTelemetry.ambiguousFolders = ambiguous.folderKeys.size;
    for (const folderKey of ambiguous.folderKeys) {
      _folderReconUnverified.add(folderKey);
      _folderReconSessionDone.delete(folderKey);
      _releaseFolderReconActiveProof(folderKey, "invalidation");
    }
    if (ambiguous.groups > 0) {
      // Aggregate-only observability for the non-injective legacy key schema.
      // No folder/account/message identifiers are emitted. ADR-024 bypasses
      // this path only after capable helpers earn exact-relation cutover.
      logFtsBatchOperation("folder_recon", "ambiguous_keyspace", {
        ambiguousGroups: ambiguous.groups,
        ambiguousFolders: ambiguous.folderKeys.size,
      });
    }

    const anchor = _folderReconRoundRobinCursor ?? memo.roundRobinCursor;
    const start = anchor && keys.includes(anchor) ? (keys.indexOf(anchor) + 1) % keys.length : 0;
    let target = null;
    let earliestDeferred = Infinity;
    const activeOwner = _folderReconActiveProof?.folderKey;
    if (activeOwner
        && currentFolderKeys.has(activeOwner)
        && !ambiguous.folderKeys.has(activeOwner)
        && !_folderReconSessionDone.has(activeOwner)) {
      const notBefore = Math.max(
        _folderReconSessionDeferred.get(activeOwner) || 0,
        _folderReconDrainFailureNotBefore(activeOwner),
      );
      if (notBefore <= Date.now()) target = activeOwner;
      else {
        // A real failure/backoff is the fairness boundary: release the active
        // proof so another folder can own the single working set.
        earliestDeferred = notBefore;
        _releaseFolderReconActiveProof(activeOwner, "backoff");
      }
    }
    for (let offset = 0; offset < keys.length; offset++) {
      if (target) break;
      const candidate = keys[(start + offset) % keys.length];
      if (ambiguous.folderKeys.has(candidate)) continue;
      if (_folderReconSessionDone.has(candidate)) continue;
      const notBefore = Math.max(
        _folderReconSessionDeferred.get(candidate) || 0,
        _folderReconDrainFailureNotBefore(candidate),
      );
      if (notBefore > Date.now()) {
        earliestDeferred = Math.min(earliestDeferred, notBefore);
        continue;
      }
      target = candidate;
      break;
    }

    if (!target) {
      if (pendingMembershipPass) {
        // No folder work is owed, so the turn goes to the state pass, unless
        // its delay holds: then the scheduler waits for the earlier of the
        // pass's not-before time and the earliest folder deferral (the
        // rolling wake is armed by the tick). Never a completion: orphan and
        // session completion need global cleanup.
        const notBeforeMs = pendingMembershipPass.notBeforeMs;
        if (notBeforeMs > Date.now()) {
          const deferralDelay = earliestDeferred < Infinity
            ? _folderReconBackoffWaitDelay(earliestDeferred)
            : Infinity;
          _wakeFolderRecon("unresolved_retry_wait", Math.min(
            deferralDelay,
            Math.max(FOLDER_RECON_PACE_DELAY_MS, notBeforeMs - Date.now()),
          ));
          return { complete: false, reason: "unresolved_retry_wait" };
        }
        const migration = await runMembershipPass(true);
        if (!migration) return { skipped: true, reason: "pressure" };
        if (!migration.complete) return finishMembershipPassTurn(migration);
        // The page completed the pass: fall through to orphan completion.
      }
      if (ambiguous.groups > 0) {
        // Per-folder ranges and the sum-of-ranges orphan basis are both
        // inexact while an overlap exists, so neither proof may run; the
        // session stays incomplete. Ambiguity is a function of the inventory, so it
        // cannot appear or vanish without a binding change (fresh pass).
        const ambiguityDelay = earliestDeferred < Infinity
          ? Math.min(
            FOLDER_RECON_ERROR_DELAY_MS,
            Math.max(FOLDER_RECON_PACE_DELAY_MS, earliestDeferred - Date.now()),
          )
          : FOLDER_RECON_ERROR_DELAY_MS;
        _wakeFolderRecon("ambiguous_folder_keyspace", cooperativeDelay(ambiguityDelay));
        return {
          skipped: true,
          reason: "ambiguous_folder_keyspace",
          ambiguousGroups: ambiguous.groups,
          ambiguousFolders: ambiguous.folderKeys.size,
        };
      }
      if (earliestDeferred < Infinity) {
        _wakeFolderRecon("backoff_wait", _folderReconBackoffWaitDelay(earliestDeferred));
        return { skipped: true, reason: "backoff" };
      }
      let orphan;
      if (exactMembership) {
        // The completed, bound membership state pass (checked by this tick's
        // migration slice) already removed every row whose owner left the
        // inventory and classified every ownerless row.
        orphan = { complete: true, unloaded: _folderMembershipStatePass?.unloaded || 0 };
      } else {
        try {
          orphan = await _runFolderReconOrphanSlice(
            ftsSearch,
            identities,
            inventoryMembershipEpoch,
            inventoryTopologySerial,
          );
        } catch (e) {
          const message = String(e?.message || e);
          if (!message.includes("folder_recon_pressure")) throw e;
          _bumpFolderReconTelemetry("schedulerPressureSkips");
          _wakeFolderRecon("orphan_pressure", cooperativeDelay(FOLDER_RECON_PRESSURE_DELAY_MS));
          return { skipped: true, reason: "pressure" };
        }
      }
      _assertFolderReconLease(reconcileLease, generation);
      // A completed, bound pass stays complete: later writes are built under
      // the same binding and cannot create an outside-prefix key.
      _folderReconOrphanDone = orphan.complete === true;
      if (_folderReconOrphanDone && orphan.unloaded > 0) {
        // Rows of an account Thunderbird has not loaded are kept and hold
        // completion. Nothing announces a late-loading account, so re-read the
        // inventory on a capped backoff; a changed inventory resets it.
        const inventorySha256 = exactMembership
          ? _folderMembershipStatePass?.inventorySha256
          : _folderReconOrphanPass?.inventorySha256;
        if (_folderReconInventoryRetry?.inventorySha256 !== inventorySha256) {
          _folderReconInventoryRetry = { inventorySha256, attempts: 0 };
        }
        const retryDelayMs = Math.min(
          FOLDER_RECON_ERROR_DELAY_MS * (2 ** Math.min(_folderReconInventoryRetry.attempts, 30)),
          FOLDER_RECON_INVENTORY_RETRY_MAX_MS,
        );
        _folderReconInventoryRetry.attempts++;
        _wakeFolderRecon("inventory_retry", retryDelayMs);
        return { complete: false, orphan, reason: "unloaded_accounts" };
      }
      // A message event since the tick began (even one after the orphan
      // slice's last await) refuses completion here; the tick continues.
      if (_folderReconOrphanDone && _folderReconQuietSince(generation, eventSerial)) {
        _completeFolderReconOutcome();
        return { complete: true, orphan };
      }
      _wakeFolderRecon("orphan_continue", orphan.failed
        ? cooperativeDelay(FOLDER_RECON_ERROR_DELAY_MS)
        : cooperativeDelay());
      return { complete: false, orphan };
    }

    const globalDrainDeadline = _folderReconDrainFailureDeferred.get("__all__") || 0;
    if (globalDrainDeadline > 0 && globalDrainDeadline <= Date.now()) {
      _folderReconDrainFailureDeferred.delete("__all__");
    }
    const targetDrainDeadline = _folderReconDrainFailureDeferred.get(target) || 0;
    if (targetDrainDeadline > 0 && targetDrainDeadline <= Date.now()) {
      _folderReconDrainFailureDeferred.delete(target);
      _folderReconSessionDeferred.delete(target);
    }
    // A queued event can drain without a native write or a walk mark (its
    // raw key is already indexed under the old owner), so only the target's
    // own local proof records it at the grant below.
    const targetLocalSerial = _folderReconLocalSerial;
    let stats;
    try {
      stats = await _runFolderReconcile(
        ftsSearch,
        new Set([target]),
        reconcileLease,
        identities,
      );
    } catch (e) {
      const message = String(e?.message || e);
      if (message.includes("folder_membership_page_pending")) {
        _wakeFolderRecon("folder_membership_page", cooperativeDelay());
        return { complete: false, deferred: true, reason: "membership_page" };
      }
      if (!message.includes("folder_recon_pressure")) throw e;
      _bumpFolderReconTelemetry("schedulerPressureSkips");
      _wakeFolderRecon("folder_pressure", cooperativeDelay(FOLDER_RECON_PRESSURE_DELAY_MS));
      return { skipped: true, reason: "pressure" };
    }
    _assertFolderReconLease(reconcileLease, generation);
    if (stats?.skipped) {
      // A helper without the RPCs is retried only after a reconnect, which
      // the native connection listener turns into a wake.
      if (stats.reason !== "native_unsupported") {
        _wakeFolderRecon("skipped_retry", stats.retryDelayMs ?? FOLDER_RECON_ERROR_DELAY_MS);
      }
      return stats;
    }
    _folderReconRoundRobinCursor = target;
    const updatedMemo = await _getFolderReconMemo();
    _assertFolderReconLease(reconcileLease, generation);

    const checkpoint = updatedMemo.folders[target];
    if ((stats.foldersErrored || 0) > 0 || (stats.foldersFailed || 0) > 0) {
      _releaseFolderReconActiveProof(target, "error");
      const failureCount = (_folderReconFailureCounts.get(target) || 0) + 1;
      _folderReconFailureCounts.set(target, failureCount);
      const failureDelayMs = Math.min(
        FOLDER_RECON_ERROR_DELAY_MS * (2 ** Math.min(failureCount - 1, 30)),
        FOLDER_RECON_GENERIC_FAILURE_BACKOFF_MAX_MS,
      );
      _folderReconSessionDeferred.set(target, Date.now() + failureDelayMs);
    } else {
      _folderReconFailureCounts.delete(target);
      _folderReconDrainFailureCounts.delete(target);
      if (!_folderReconDrainFailureDeferred.has("__all__")) {
        _folderReconDrainFailureCounts.delete("__all__");
      }
    }
    if (stats?._verifiedThisRun?.has(target)
        && _folderReconLocalUnchangedSince(target, targetLocalSerial)
        && ftsMembershipUnchangedSince(
          _folderReconNativeScope(identities.find(identity =>
            `${identity.accountId}:${identity.folderPath}` === target)),
          stats?._verifiedEpochByFolder?.get(target),
        )
        && (stats.foldersErrored || 0) === 0
        && (stats.foldersFailed || 0) === 0
        && (stats.foldersDrainBusy || 0) === 0
        && (stats.missingEnqueued || 0) === 0) {
      // A walk mark made after the attempt started survives and forces a
      // later attempt.
      const attemptMarkSerial = stats._attemptMarkSerialByFolder?.get(target) ?? -1;
      if ((_folderReconDirty.get(target) ?? -1) <= attemptMarkSerial) {
        _folderReconDirty.delete(target);
        _folderReconSessionDone.add(target);
        if (exactMembership) _scheduleFolderReconNextWalk(target, Date.now());
      }
      _folderReconSessionDeferred.delete(target);
      _folderReconFailureCounts.delete(target);
    } else if (checkpoint?.partialRetryNotBeforeMs > Date.now()) {
      _releaseFolderReconActiveProof(target, "backoff");
      _folderReconSessionDeferred.set(target, checkpoint.partialRetryNotBeforeMs);
    }
    if ((stats.foldersLocalDrift || 0) > 0) {
      _releaseFolderReconActiveProof(target, "invalidation");
    }
    if ((stats.foldersDrainBusy || 0) > 0
        || ((stats.missingEnqueued || 0) > 0
          && _folderReconDrainSkipped.has(target))) {
      // The active proof stays pinned while the foreground queue drains. This
      // tick releases its reconcile lease in finally; drain-low-water owns the
      // next wake, so no scheduler timer spins beside body work.
      return stats;
    }
    // Never schedule more reconciliation work sooner than the slice that just
    // ran. Across consecutive slices this reserves at least half of wall time
    // for Thunderbird and the foreground/incremental pipelines.
    _wakeFolderRecon("next_folder", cooperativeDelay());
    return stats;
  } finally {
    _folderMembershipPageBudget = 0;
    if (_folderReconSchedulerOwner === owner) {
      const elapsedMs = Math.max(0, Date.now() - sliceStartedAt);
      if (!_folderReconRuntimeTelemetry) _resetFolderReconRuntimeTelemetry();
      _folderReconRuntimeTelemetry.lastSliceElapsedMs = elapsedMs;
      _folderReconRuntimeTelemetry.maxSliceElapsedMs = Math.max(
        _folderReconRuntimeTelemetry.maxSliceElapsedMs,
        elapsedMs,
      );
      _folderReconSchedulerOwner = null;
      _setFolderReconHardNotBeforeMs(Date.now() + elapsedMs);
    }
    reconcileLease.release();
  }
}

function _maybeScheduleFolderReconRerun() {
  if (_folderReconDrainSkipped.size === 0 || !_isEnabled || !_ftsSearch) return undefined;
  for (const folderKey of _folderReconDrainSkipped) _folderReconSessionDone.delete(folderKey);
  _wakeFolderRecon("drain_low_water", FOLDER_RECON_PACE_DELAY_MS);
  return undefined;
}

/**
 * Seed the post-init cooperative consistency proof after startup sync settles.
 *
 * The former date-window message walk, cursor scan, and date-window stale scan
 * are intentionally absent here. The UID/UIDVALIDITY checkpoint detects any
 * IMAP membership change regardless of message Date, and the exact folder-key
 * fingerprint repairs both missing and stale keys when change is observed.
 * This is both stronger and substantially cheaper on unchanged folders.
 */
async function runPostInitReconcile(ftsSearch) {
  if (!_isEnabled) return;

  const reconcileStart = Date.now();
  logFtsBatchOperation("reconcile", "start", { mode: "folder_fingerprint" });

  try {
    const stats = await _runFolderReconSchedulerTick(ftsSearch);
    const elapsed = Date.now() - reconcileStart;
    log(`[FTS Reconcile] Cooperative membership scheduler seeded in ${elapsed}ms`);
    logFtsBatchOperation("reconcile", "scheduled", {
      mode: "folder_fingerprint",
      ...(stats || {}),
      elapsedMs: elapsed,
    });
  } catch (e) {
    log(`[TMDBG FTS] Reconcile failed: ${e}`, "error");
    logFtsBatchOperation("reconcile", "error", { error: String(e), mode: "folder_fingerprint" });
    // Reconciliation stays pending; arm the normal serialized scheduler retry
    // so a one-shot inventory/storage failure heals in this live session.
    _wakeFolderRecon("initial_error_retry", FOLDER_RECON_ERROR_DELAY_MS);
  }
}

// Public API - DO NOT add duplicate listeners, integrate with existing ones
export async function initIncrementalIndexer(ftsSearch) {
  if (!ftsSearch) {
    throw new Error("FTS search engine required for incremental indexing");
  }

  _ftsSearch = ftsSearch;
  // Reset disposal flag — a previous dispose() may have set it; a fresh
  // init should let the heartbeat run again.
  _indexerDisposed = false;
  // Fresh session — session-max keys from a previous session were either
  // merged by the heartbeat or are superseded by the boot cursor scan.
  _sessionMaxKeyByFolder = new Map();
  // Fresh cooperative reconciliation session. The generation bump makes any
  // delayed completion from an earlier init/dispose unable to persist proof.
  _folderReconGeneration++;
  if (_folderReconTimer) clearTimeout(_folderReconTimer);
  _folderReconTimer = null;
  _folderReconTimerToken++;
  _folderReconTimerDueMs = 0;
  _folderReconRequestedDueMs = Infinity;
  _folderReconHardNotBeforeMs = 0;
  _folderReconRollingDueMs = 0;
  _folderReconNextWalkDueMs = new Map();
  _folderReconKnownFolderKeys = new Set();
  _folderReconNativeSupport = null;
  _folderReconNativeProbeFailures = { connectionGeneration: null, count: 0 };
  _folderReconConnectionUnsubscribe?.();
  _folderReconConnectionUnsubscribe = ftsSearch.addConnectionListener?.(
    () => _wakeFolderRecon("native_reconnect"),
  ) || null;
  _revokeFolderMembershipCleanup();
  _folderMembershipCapabilityState = null;
  _resetFolderMembershipVolatileProof();
  _folderReconDrainSkipped = new Set();
  _folderReconInProgressOwner = null;
  _folderReconUnverified = new Set();
  _folderReconSchedulerOwner = null;
  _folderReconSessionDone = new Set();
  _folderReconSessionDeferred = new Map();
  _folderReconFailureCounts = new Map();
  _folderReconDrainFailureDeferred = new Map();
  _folderReconDrainFailureCounts = new Map();
  _folderReconDirty = new Map();
  _folderReconOrphanDone = false;
  _folderReconOrphanPass = null;
  _folderReconRoundRobinCursor = null;
  _folderReconInventoryRetry = null;
  _clearFolderReconActiveProof({ resetStats: true });
  _resetFolderReconRuntimeTelemetry();

  // Load settings
  await updateIncrementalSettings();
  await _removeLegacyStorageKeys();

  if (!_isEnabled) {
    log("[TMDBG FTS] Incremental indexing is disabled");
    return;
  }

  log("[TMDBG FTS] Incremental indexer initialized");

  setupFolderTopologyListeners();

  // Try to set up experiment listeners for reliable message notifications
  const experimentAvailable = await setupExperimentListeners();
  if (experimentAvailable) {
    log("[TMDBG FTS] Using experiment API (nsIMsgFolderNotificationService) for message events");
  } else {
    log("[TMDBG FTS] Experiment API not available - using WebExtension events only");
    log("[TMDBG FTS] NOTE: Integrate with existing agent listeners for WebExtension events");
  }

  // Schedule the membership proof after TB's startup sync settles. A quiet
  // local msgDB snapshot keeps the two fingerprints comparable. Listeners are
  // already active, so events during the wait still enter the queue.
  _scheduleReconcileWhenQuiet(ftsSearch);
}

/**
 * Schedule runPostInitReconcile to run after sync events have quieted down.
 * Polls _lastSyncEventMs on an interval; runs reconcile once the quiet period
 * has elapsed. Has a hard cap (RECONCILE_MAX_WAIT_MS) to ensure reconcile
 * eventually runs even if events keep firing.
 *
 * @param {Object} ftsSearch - FTS search interface
 * @param {Function} [runner] - Optional runner (defaults to runPostInitReconcile).
 *                              Injectable for testing.
 */
function _scheduleReconcileWhenQuiet(ftsSearch, runner = runPostInitReconcile) {
  const scheduledAt = Date.now();
  // Initialize to "now" so we require a fresh quiet period after scheduling
  _lastSyncEventMs = scheduledAt;

  log(`[TMDBG FTS] Reconcile scheduled — waiting for ${RECONCILE_QUIET_PERIOD_MS / 1000}s quiet period (max wait ${RECONCILE_MAX_WAIT_MS / 1000}s)`);

  if (_reconcileQuietTimer) {
    clearInterval(_reconcileQuietTimer);
    _reconcileQuietTimer = null;
  }

  _reconcileQuietTimer = setInterval(() => {
    const now = Date.now();
    const quietFor = now - _lastSyncEventMs;
    const waitedFor = now - scheduledAt;

    if (quietFor >= RECONCILE_QUIET_PERIOD_MS || waitedFor >= RECONCILE_MAX_WAIT_MS) {
      const reason = quietFor >= RECONCILE_QUIET_PERIOD_MS ? "quiet period reached" : "max wait exceeded";
      log(`[TMDBG FTS] Reconcile starting — ${reason} (quietFor=${Math.round(quietFor / 1000)}s, waitedFor=${Math.round(waitedFor / 1000)}s)`);

      if (_reconcileQuietTimer) {
        clearInterval(_reconcileQuietTimer);
        _reconcileQuietTimer = null;
      }

      Promise.resolve(runner(ftsSearch)).catch(e => {
        log(`[TMDBG FTS] Post-init reconcile error: ${e}`, "error");
      });
    } else {
      log(`[TMDBG FTS] Reconcile waiting — quietFor=${Math.round(quietFor / 1000)}s/${RECONCILE_QUIET_PERIOD_MS / 1000}s (waited=${Math.round(waitedFor / 1000)}s)`);
    }
  }, RECONCILE_QUIET_CHECK_INTERVAL_MS);
}

export async function disposeIncrementalIndexer() {
  log("[TMDBG FTS] Disposing incremental indexer");

  _isEnabled = false;
  _folderReconGeneration++;
  _folderReconConnectionUnsubscribe?.();
  _folderReconConnectionUnsubscribe = null;
  _folderReconInProgressOwner = null;
  _folderReconSchedulerOwner = null;
  _revokeFolderMembershipCleanup();
  _folderMembershipCapabilityState = null;
  _resetFolderMembershipVolatileProof();
  _resetFolderReconRuntimeTelemetry();
  if (_folderReconTimer) {
    clearTimeout(_folderReconTimer);
    _folderReconTimer = null;
  }
  _folderReconTimerToken++;
  _folderReconTimerDueMs = 0;
  _folderReconRequestedDueMs = Infinity;
  _folderReconHardNotBeforeMs = 0;
  _folderReconRollingDueMs = 0;
  _folderReconNextWalkDueMs = new Map();
  _folderReconKnownFolderKeys = new Set();
  // Set BEFORE awaiting anything — any in-flight heartbeat that hasn't
  // yet reached its post-read disposal check should now see this true
  // and skip its write.
  _indexerDisposed = true;
  _stopWatermarkHeartbeat();

  // Remove experiment listeners first
  _removeFolderTopologyListeners();
  await removeExperimentListeners();
  
  // Wait for any ongoing processing to complete
  if (_isProcessing) {
    log("[TMDBG FTS] Waiting for ongoing processing to complete before disposal");
    let waitCount = 0;
    while (_isProcessing && waitCount < 50) { // Max 5 seconds wait
      await new Promise(r => setTimeout(r, 100));
      waitCount++;
    }
    if (_isProcessing) {
      log("[TMDBG FTS] Disposal timeout - forcing disposal despite ongoing processing", "warn");
    }
  }
  
  // Pending updates are not persisted: the next startup walk re-derives them.
  _pendingUpdates.clear();

  // Clear session cursor tracking
  _sessionMaxKeyByFolder.clear();

  // Clear folder-reconcile session state
  _folderReconDrainSkipped.clear();
  _folderReconSessionDone.clear();
  _folderReconSessionDeferred.clear();
  _folderReconFailureCounts.clear();
  _folderReconDrainFailureDeferred.clear();
  _folderReconDrainFailureCounts.clear();
  _folderReconDirty.clear();
  _folderReconOrphanDone = false;
  _folderReconOrphanPass = null;
  _clearFolderReconActiveProof();

  // Clear timers
  if (_batchTimer) {
    clearTimeout(_batchTimer);
    _batchTimer = null;
  }

  if (_reconcileQuietTimer) {
    clearInterval(_reconcileQuietTimer);
    _reconcileQuietTimer = null;
  }

  // Reset processing flag
  _isProcessing = false;

  // Reset mutex
  _enqueueMutex = Promise.resolve();

  _ftsSearch = null;

  log("[TMDBG FTS] Incremental indexer disposed");
}

// Force process pending updates (for testing/manual trigger)
export async function flushPendingUpdates() {
  if (_batchTimer) {
    clearTimeout(_batchTimer);
    _batchTimer = null;
  }
  
  await processPendingUpdates();
}

// Get current status. Reconciliation telemetry is aggregate-only: it exposes
// workload and scheduler behavior without folder/account/message identifiers.
export async function getIncrementalIndexerStatus() {
  if (!_folderReconRuntimeTelemetry) _resetFolderReconRuntimeTelemetry();
  let scanTokens = null;
  if (typeof browser?.tmMsgNotify?.getFolderMessageScanStats === "function") {
    try {
      const raw = await browser.tmMsgNotify.getFolderMessageScanStats();
      if (Number.isSafeInteger(raw?.live) && raw.live >= 0
          && Number.isSafeInteger(raw?.maxLive) && raw.maxLive >= 0
          && Number.isSafeInteger(raw?.idleTtlMs) && raw.idleTtlMs >= 0) {
        scanTokens = {
          live: Math.min(raw.live, raw.maxLive),
          maxLive: raw.maxLive,
          idleTtlMs: raw.idleTtlMs,
        };
      }
    } catch (_) {}
  }
  return {
    enabled: _isEnabled,
    hasEngine: !!_ftsSearch,
    integratedMode: true, // No separate listeners - integrated with agent
    pendingUpdates: _pendingUpdates.size,
    isProcessing: _isProcessing,
    settings: {
      batchDelay: INCREMENTAL_BATCH_DELAY_MS,
      batchSize: INCREMENTAL_BATCH_SIZE,
    },
    folderRecon: {
      ..._folderReconRuntimeTelemetry,
      activeWorkingProof: _folderReconWorkingProofTelemetry(),
      outcomes: _folderReconOutcomeStatus(),
      scanTokens,
    },
  };
}

export const _testExports = {
  _noteFolderReconLocalChange,
  _folderReconLocalScope,
  _folderReconLocalUnchangedSince,
  FOLDER_RECON_CHANGE_LEDGER_CAP,
  _getRetryConfig,
  _shouldDropFailedUpdates,
  _markResolveFailed,
  _resetNoProgressCounter,
  _incrementNoProgressCounter,
  // State accessors for test setup/teardown
  _getConsecutiveNoProgressCycles: () => _consecutiveNoProgressCycles,
  _setConsecutiveNoProgressCycles: (v) => { _consecutiveNoProgressCycles = v; },
  _getPendingUpdates: () => _pendingUpdates,
  _getFolderReconRoundRobinCursor: () => _folderReconRoundRobinCursor,
  _abandonPendingUpdates,
  _getFolderReconDirty: () => new Set(_folderReconDirty.keys()),
  // Quiet-period reconcile scheduler
  _scheduleReconcileWhenQuiet,
  runPostInitReconcile,
  _getLastSyncEventMs: () => _lastSyncEventMs,
  _getFolderReconEventSerial: () => _folderReconLocalSerial,
  _setLastSyncEventMs: (v) => { _lastSyncEventMs = v; },
  _hasReconcileQuietTimer: () => _reconcileQuietTimer !== null,
  _clearReconcileQuietTimer: () => {
    if (_reconcileQuietTimer) {
      clearInterval(_reconcileQuietTimer);
      _reconcileQuietTimer = null;
    }
  },
  RECONCILE_QUIET_PERIOD_MS,
  RECONCILE_QUIET_CHECK_INTERVAL_MS,
  RECONCILE_MAX_WAIT_MS,
  // Watermark + heartbeat (PLAN_RECONCILE_WATERMARK.md)
  _getReconcileFrom,
  _writeWatermark,
  _heartbeatBumpWatermark,
  _startWatermarkHeartbeat,
  _stopWatermarkHeartbeat,
  // Per-folder cursors (PLAN_RECONCILE_CURSOR.md / ADR-020)
  _runCursorScan,
  _heartbeatAdvanceCursors,
  _noteSessionMaxKey,
  _getSessionMaxKeyByFolder: () => _sessionMaxKeyByFolder,
  _clearSessionMaxKeyByFolder: () => { _sessionMaxKeyByFolder.clear(); },
  CURSOR_STORAGE_KEY,
  CURSOR_KEYS_CHUNK,
  CURSOR_FULL_SCAN_MAX_KEYS,
  // Per-folder set reconcile (PLAN_FOLDER_SET_RECONCILE.md / ADR-021)
  _runFolderReconcile,
  _runFolderReconSchedulerTick,
  _runFolderReconOrphanSlice,
  _wakeFolderRecon,
  _scanFolderMessagesCooperatively,
  _folderReconMissingDirection,
  _getFolderReconMemo,
  _maybeScheduleFolderReconRerun,
  _getFolderReconDrainSkipped: () => _folderReconDrainSkipped,
  _getFolderMembershipCleanupProven: () => _folderMembershipCleanupProven,
  _getFolderReconMembershipTurn: () => _folderReconMembershipTurn,
  _getFolderMembershipStatePass: () => _folderMembershipStatePass,
  _getFolderMembershipYieldedAttempts: () => new Map(_folderMembershipYieldedAttempts),
  _getFolderReconOrphanPass: () => _folderReconOrphanPass,
  _runFolderMembershipMigrationSlice,
  _resetFolderReconState: () => {
    _resetFtsOperationCoordinatorForTests();
    _folderReconLocalTouchedKeys.clear();
    _folderReconLocalKeylessFolders.clear();
    _folderReconLocalKeyFloor = 0;
    _folderReconNativeSupport = null;
    _folderReconNativeProbeFailures = { connectionGeneration: null, count: 0 };
    _revokeFolderMembershipCleanup();
    _folderMembershipCapabilityState = null;
    _resetFolderMembershipVolatileProof();
    _folderReconDrainSkipped = new Set();
    _folderReconInProgressOwner = null;
    _folderReconUnverified = new Set();
    _folderReconBudgetOverride = null;
    _folderReconGeneration++;
    if (_folderReconTimer) clearTimeout(_folderReconTimer);
    _folderReconTimer = null;
    _folderReconTimerToken++;
    _folderReconTimerDueMs = 0;
    _folderReconRequestedDueMs = Infinity;
    _folderReconHardNotBeforeMs = 0;
    _folderReconRollingDueMs = 0;
    _folderReconNextWalkDueMs = new Map();
    _folderReconKnownFolderKeys = new Set();
    _folderReconSchedulerOwner = null;
    _folderReconSessionDone = new Set();
    _folderReconSessionDeferred = new Map();
    _folderReconFailureCounts = new Map();
    _folderReconDrainFailureDeferred = new Map();
    _folderReconDrainFailureCounts = new Map();
    _folderReconDirty = new Map();
    _folderReconOrphanDone = false;
    _folderReconOrphanPass = null;
    _folderReconRoundRobinCursor = null;
    _folderReconInventoryRetry = null;
    _clearFolderReconActiveProof({ resetStats: true });
    _resetFolderReconRuntimeTelemetry();
  },
  _setFolderReconBudgetOverride: (v) => { _folderReconBudgetOverride = v; },
  _setFolderReconInProgress: (v) => {
    _folderReconInProgressOwner = v ? { generation: _folderReconGeneration } : null;
  },
  FOLDER_RECON_STORAGE_KEY,
  FOLDER_RECON_KEYS_CHUNK,
  FOLDER_RECON_CHUNK_DELAY_MS,
  FOLDER_RECON_RECHECK_KEEPALIVE_EVERY,
  FOLDER_RECON_KEYSPACE_END,
  FOLDER_RECON_INITIAL_SCAN_KEY,
  FOLDER_RECON_ENTRY_DELAY_MS,
  FOLDER_RECON_GENERIC_FAILURE_BACKOFF_MAX_MS,
  FOLDER_RECON_MISSING_PAGE_KEYS,
  FOLDER_RECON_RECHECKS_PER_SLICE,
  FOLDER_RECON_ENQUEUES_PER_SLICE,
  FOLDER_RECON_PENDING_HIGH_WATER,
  _getFolderReconWorkingProof,
  _admitFolderReconActiveProof,
  _invalidateFolderReconProofForEvent,
  _invalidateFolderReconProofForMessageEvent,
  _onFolderReconTopologyChanged,
  _folderReconLocalExactKeyUnchangedSince,
  FOLDER_RECON_CHANGE_LEDGER_KEY_CAP,
  _getFolderReconWorkingProofTelemetry: _folderReconWorkingProofTelemetry,
  _getFolderReconRuntimeTelemetry: () => _folderReconRuntimeTelemetry,
  _getFolderReconActiveProofKey: () => _folderReconActiveProof?.folderKey || null,
  _isFolderReconSchedulerActive: () => _folderReconSchedulerOwner !== null,
  _recordFolderReconOutcome,
  _completeFolderReconOutcome,
  _folderReconQuietSince,
  _getFolderReconSessionDone: () => new Set(_folderReconSessionDone),
  _getFolderReconEphemeralEvidence: () => ({
    deferred: _folderReconSessionDeferred.size + _folderReconDrainFailureDeferred.size,
    failures: _folderReconFailureCounts.size + _folderReconDrainFailureCounts.size,
    orphanDone: _folderReconOrphanDone,
    hasOrphanPass: _folderReconOrphanPass !== null,
    dirty: [..._folderReconDirty.keys()].sort(),
  }),
  _setFolderReconEphemeralEvidenceForTests: ({
    folderKey,
    deferredAt,
    failureCount,
    orphanDone,
    orphanPass,
    sessionDone = [],
  }) => {
    for (const doneKey of sessionDone) _folderReconSessionDone.add(doneKey);
    if (folderKey) {
      _folderReconSessionDeferred.set(folderKey, deferredAt);
      _folderReconFailureCounts.set(folderKey, failureCount);
    }
    _folderReconOrphanDone = orphanDone === true;
    _folderReconOrphanPass = orphanPass || null;
  },
  _getFolderReconRollingDueMs: () => _folderReconRollingDueMs,
  _getFolderReconTimerDueMs: () => _folderReconTimerDueMs,
  _getFolderReconNextWalkDueMs: () => new Map(_folderReconNextWalkDueMs),
  _folderReconWalkOffsetMs,
  _pruneFolderReconRuntimeToFolderKeys,
  _getFolderReconGeneration: () => _folderReconGeneration,
  _setFolderReconHardNotBeforeMs,
  _reconStorageTransaction,
  _hasWatermarkHeartbeatTimer: () => _watermarkHeartbeatTimer !== null,
  _setIndexerDisposed: (v) => { _indexerDisposed = v; },
  _getIndexerDisposed: () => _indexerDisposed,
  // Allow tests to set _experimentListenersActive / _isEnabled / _ftsSearch directly
  _setExperimentListenersActive: (v) => { _experimentListenersActive = v; },
  _setIsEnabled: (v) => { _isEnabled = v; },
  _setFtsSearch: (v) => { _ftsSearch = v; },
  onExperimentMessageRemoved,
  onExperimentMessageAdded,
  WATERMARK_KEY,
  HEARTBEAT_INTERVAL_MS,
  RECONCILE_OVERLAP_MS,
  RECONCILE_FALLBACK_WINDOW_MS,
};
