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
  headerIDToWeID,
  log,
  parseUniqueId,
  recheckMessageInFolder,
} from "../agent/modules/utils.js";
import { buildBatchHeader, populateBatchBody } from "./indexer.js";
import {
  _resetFtsOperationCoordinatorForTests,
  addFtsExclusiveMembershipChangeListener,
  getFtsMembershipEpoch,
  normalizeInterruptedFtsScanStatus,
  tryAcquireFtsReconcileLease,
  withFtsMembershipFence,
} from "./operationCoordinator.js";

// Incremental indexing state
let _isEnabled = false;
let _ftsSearch = null;
let _pendingUpdates = new Map(); // uniqueKey -> { type, uniqueKey, timestamp, metadata, hasFailed }
let _batchTimer = null;
let _persistTimer = null; // Timer for debounced persistence
let _isProcessing = false; // Prevents concurrent processing

// Queue stability tracking - counts consecutive processing cycles with no successful dequeues
// Reset to 0 whenever anything is successfully processed (dequeued from _pendingUpdates)
let _consecutiveNoProgressCycles = 0;

// Mutex for atomic enqueue operations - prevents interleaving during async key generation
let _enqueueMutex = Promise.resolve();

// Settings  
let INCREMENTAL_BATCH_DELAY_MS = 1000; // Wait 1s before processing batch
let INCREMENTAL_BATCH_SIZE = 10; // Process up to 10 messages per batch (reduced from 50 to minimize lock time)
let PERSIST_DEBOUNCE_MS = 2000; // Wait 2s before persisting pending updates to storage
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

// Persistence functions for pending updates
const STORAGE_KEY = "fts_pending_updates";

async function persistPendingUpdates() {
  try {
    // Convert Map to array for storage (Maps aren't JSON-serializable)
    const updatesArray = Array.from(_pendingUpdates.entries()).map(([uniqueKey, data]) => ({
      uniqueKey,
      type: data.type,
      timestamp: data.timestamp,
      folderKey: data.folderKey || null,
      // Failure tracking - persist so status survives restarts
      hasFailed: data.hasFailed || false,
      lastFailedAt: data.lastFailedAt || 0,
      // Store minimal metadata for logging only (uniqueKey is what matters)
      metadata: {
        subject: data.metadata?.subject,
        folderName: data.metadata?.folderName
      }
    }));
    
    await browser.storage.local.set({ [STORAGE_KEY]: updatesArray });
    log(`[TMDBG FTS] Persisted ${updatesArray.length} pending updates to storage`);
  } catch (e) {
    log(`[TMDBG FTS] Failed to persist pending updates: ${e}`, "error");
  }
}

async function restorePendingUpdates() {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    const updatesArray = stored[STORAGE_KEY] || [];
    
    if (updatesArray.length > 0) {
      // Merge restored updates into existing map (don't replace - avoid race condition)
      let restoredCount = 0;
      let skippedCount = 0;
      let deferredCount = 0;
      
      for (const item of updatesArray) {
        // Only add if not already present (newly queued items take precedence)
        if (!_pendingUpdates.has(item.uniqueKey)) {
          if (_pendingUpdates.size >= FOLDER_RECON_PENDING_HIGH_WATER) {
            deferredCount++;
            continue;
          }
          _pendingUpdates.set(item.uniqueKey, {
            type: item.type,
            uniqueKey: item.uniqueKey,
            timestamp: item.timestamp,
            folderKey: item.folderKey || null,
            // Restore failure tracking
            hasFailed: item.hasFailed || false,
            lastFailedAt: item.lastFailedAt || 0,
            metadata: item.metadata || {}
          });
          _noteFolderReconPendingSize();
          restoredCount++;
        } else {
          skippedCount++;
        }
      }
      
      if (deferredCount > 0) {
        // Old builds could persist an arbitrarily large map. Keep the live
        // queue bounded and use exact reconciliation to rediscover the tail.
        await _markFolderReconDirty("__all__");
      }
      log(`[TMDBG FTS] Restored ${restoredCount} pending updates from storage (${skippedCount} already queued, ${deferredCount} deferred to reconcile)`);
      
      // Schedule processing of restored updates
      if (_isEnabled && _ftsSearch && _pendingUpdates.size > 0) {
        log(`[TMDBG FTS] Scheduling processing of restored pending updates`);
        _batchTimer = setTimeout(processPendingUpdates, INCREMENTAL_BATCH_DELAY_MS);
      }
    } else {
      log(`[TMDBG FTS] No pending updates found in storage`);
    }
  } catch (e) {
    log(`[TMDBG FTS] Failed to restore pending updates: ${e}`, "error");
  }
}

async function clearPersistedUpdates() {
  try {
    await browser.storage.local.remove(STORAGE_KEY);
    log(`[TMDBG FTS] Cleared persisted pending updates from storage`);
  } catch (e) {
    log(`[TMDBG FTS] Failed to clear persisted pending updates: ${e}`, "warn");
  }
}

function schedulePersist() {
  // Debounce persistence to avoid excessive writes
  if (_persistTimer) {
    clearTimeout(_persistTimer);
  }
  _persistTimer = setTimeout(persistPendingUpdates, PERSIST_DEBOUNCE_MS);
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

async function _markFolderReconDirty(folderKey) {
  const normalizedFolderKey = folderKey || "__all__";
  _folderReconDirty.add(normalizedFolderKey);
  _folderReconOrphanDone = false;
  _folderReconOrphanBasis = null;
  if (normalizedFolderKey === "__all__") {
    _folderReconSessionDone.clear();
    _folderReconSessionDeferred.clear();
    _folderReconFailureCounts.clear();
  } else {
    _folderReconSessionDone.delete(normalizedFolderKey);
    _folderReconSessionDeferred.delete(normalizedFolderKey);
    _folderReconFailureCounts.delete(normalizedFolderKey);
  }
  await _ensureFolderReconPendingMarker();
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
    _releaseFolderReconActiveProof(null, "invalidation");
    _folderReconSessionDone.clear();
    _folderReconSessionDeferred.clear();
    _folderReconFailureCounts.clear();
    _folderReconDrainFailureDeferred.clear();
    _folderReconDrainFailureCounts.clear();
    _folderReconDrainFailureDeferred.set("__all__", notBeforeMs);
    _folderReconDrainFailureCounts.set("__all__", failureCount);
    _folderReconDirty.add("__all__");
    earliestNotBeforeMs = notBeforeMs;
  } else {
    for (const folderKey of normalized) {
      const failureCount = (_folderReconDrainFailureCounts.get(folderKey) || 0) + 1;
      const delayMs = Math.min(
        FOLDER_RECON_ERROR_DELAY_MS * (2 ** Math.min(failureCount - 1, 30)),
        FOLDER_RECON_GENERIC_FAILURE_BACKOFF_MAX_MS,
      );
      const notBeforeMs = nowMs + delayMs;
      _releaseFolderReconActiveProof(folderKey, "invalidation");
      _folderReconSessionDone.delete(folderKey);
      _folderReconSessionDeferred.set(folderKey, notBeforeMs);
      _folderReconFailureCounts.delete(folderKey);
      _folderReconDrainFailureDeferred.set(folderKey, notBeforeMs);
      _folderReconDrainFailureCounts.set(folderKey, failureCount);
      _folderReconDirty.add(folderKey);
      earliestNotBeforeMs = Math.min(earliestNotBeforeMs, notBeforeMs);
    }
  }
  _folderReconOrphanDone = false;
  _folderReconOrphanBasis = null;
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
  await _ensureFolderReconPendingMarker();
  // Later healthy folders are eligible immediately; the affected identity is
  // held behind its bounded deadline by scheduler selection below.
  _wakeFolderRecon(reason, FOLDER_RECON_PACE_DELAY_MS);
}

/**
 * Admit a queue entry without ever exceeding the exact live high-water mark.
 * Replacements are always safe because they do not grow the map. A rejected
 * new intention is represented by the durable reconcile marker + dirty folder
 * and will be rediscovered from Thunderbird headers after the drain recedes.
 * Caller must hold _enqueueMutex.
 */
async function _tryAdmitPendingUpdate(uniqueKey, update, folderKey = null) {
  const existing = _pendingUpdates.has(uniqueKey);
  if (!existing && _pendingUpdates.size >= FOLDER_RECON_PENDING_HIGH_WATER) {
    await _markFolderReconDirty(folderKey);
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
    
    // Schedule persistence (debounced)
    schedulePersist();
    
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
 * Try to delete FTS entries when the original key doesn't match.
 * Uses native search by headerMessageId to find entries regardless of folder path.
 * This handles cases where onDeleted event has stale/wrong folder info (common with Gmail/IMAP).
 *
 * IMPORTANT: Before deleting a found entry, we verify the message is actually gone from that folder.
 * This prevents incorrect deletion when a message exists in multiple Gmail virtual folders
 * (e.g., "deleting" from INBOX just archives to All Mail, so we shouldn't delete the All Mail entry).
 *
 * @param {string} originalKey - The original uniqueKey that was tried (accountId:folderPath:headerMessageId)
 * @param {Object} ftsSearch - The FTS search instance
 * @returns {Promise<{found: boolean, deletedKeys: string[]}>}
 */
async function _tryFallbackDeletion(originalKey, ftsSearch) {
  const { parseUniqueId, headerIDToWeID } = await import("../agent/modules/utils.js");
  const parsed = parseUniqueId(originalKey);
  if (!parsed?.headerID || !parsed?.weFolder?.accountId) {
    return { found: false, deletedKeys: [] };
  }

  const { weFolder, headerID } = parsed;
  const accountId = weFolder.accountId;
  const originalFolder = weFolder.path;

  try {
    // Use native search to find all FTS entries with this headerMessageId in this account
    const matchingKeys = await ftsSearch.findByHeaderMessageId(accountId, headerID);

    if (!matchingKeys || matchingKeys.length === 0) {
      log(`[TMDBG FTS] No FTS entries found for headerMessageId ${headerID} in account ${accountId}`);
      return { found: false, deletedKeys: [] };
    }

    log(`[TMDBG FTS] Found ${matchingKeys.length} FTS entries for headerMessageId ${headerID}: ${matchingKeys.join(', ')}`);

    // Check each found entry - only delete if message is actually gone from that folder
    const deletedKeys = [];
    const skippedKeys = [];
    for (const key of matchingKeys) {
      // Skip the original key - it was already tried in the main deletion
      if (key === originalKey) continue;

      // Parse the found key to get its folder path
      const foundParsed = parseUniqueId(key);
      if (!foundParsed?.weFolder) {
        log(`[TMDBG FTS] Skipping unparseable found key: ${key}`, "warn");
        continue;
      }

      const foundFolder = foundParsed.weFolder;

      // CRITICAL: Check if the message still exists in the found folder
      // If it does, we should NOT delete it from FTS (e.g., Gmail virtual folders)
      try {
        const weId = await headerIDToWeID(headerID, foundFolder, false);
        if (weId) {
          // Message still exists in this folder - do NOT delete from FTS
          log(`[TMDBG FTS] Message still exists in ${foundFolder.path} (weId=${weId}), skipping FTS deletion`);
          logFtsOperation("fallback_delete", "skipped", {
            originalKey,
            foundKey: key,
            originalFolder,
            foundFolder: foundFolder.path,
            reason: "message_still_exists",
          });
          skippedKeys.push(key);
          continue;
        }
      } catch (e) {
        // If we can't verify, assume message is gone (conservative approach for actual deletions)
        log(`[TMDBG FTS] Could not verify message existence in ${foundFolder.path}: ${e}`, "info");
      }

      // Message is gone from this folder - safe to delete from FTS
      try {
        await ftsSearch.removeBatch([key]);

        // Verify deletion succeeded
        const verifyEntry = await ftsSearch.getMessageByMsgId(key);
        if (!verifyEntry || verifyEntry.msgId !== key) {
          log(`[TMDBG FTS] Native search deletion: removed ${key} (original was ${originalFolder})`);
          logFtsOperation("fallback_delete", "success", {
            originalKey,
            foundKey: key,
            originalFolder,
            method: "native_search",
          });
          deletedKeys.push(key);
        } else {
          log(`[TMDBG FTS] Native search deletion failed to remove: ${key}`, "warn");
        }
      } catch (e) {
        log(`[TMDBG FTS] Error deleting found key ${key}: ${e}`, "warn");
      }
    }

    if (skippedKeys.length > 0) {
      log(`[TMDBG FTS] Skipped ${skippedKeys.length} entries where message still exists in folder`);
    }

    return { found: deletedKeys.length > 0, deletedKeys };
  } catch (e) {
    log(`[TMDBG FTS] Native search fallback error: ${e}`, "warn");
    return { found: false, deletedKeys: [] };
  }
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

/**
 * Mark an update as having failed resolution.
 * Sets hasFailed=true so it can be dropped if queue is stuck.
 */
function _markResolveFailed(update) {
  const now = Date.now();
  const updated = {
    ...update,
    hasFailed: true,
    lastFailedAt: now,
  };
  _pendingUpdates.set(update.uniqueKey, updated);
  return updated;
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
 * Atomically convert destructive queue abandonment into durable reconcile
 * work. Only the exact captured type+timestamp may be deleted; replacements
 * and requeues survive. Marker failure propagates and retains every entry.
 */
async function _abandonPendingUpdates(capturedUpdates, reason = "abandoned") {
  const { acquired, release } = acquireEnqueueMutex();
  try {
    await acquired;
    const matching = [];
    const folderKeys = new Set();
    for (const captured of capturedUpdates || []) {
      const current = _pendingUpdates.get(captured?.uniqueKey);
      if (!current
          || current.timestamp !== captured.timestamp
          || current.type !== captured.type) {
        continue;
      }
      matching.push(captured);
      folderKeys.add(current.folderKey || captured.folderKey || "__all__");
    }
    if (matching.length === 0) {
      return { dropped: 0, retained: (capturedUpdates || []).length };
    }
    for (const folderKey of folderKeys) {
      _folderReconDirty.add(folderKey);
      if (folderKey === "__all__") {
        _folderReconSessionDone.clear();
      } else {
        _folderReconSessionDone.delete(folderKey);
      }
    }
    _folderReconOrphanDone = false;
    _folderReconOrphanBasis = null;
    await _ensureFolderReconPendingMarker();

    let dropped = 0;
    for (const captured of matching) {
      const current = _pendingUpdates.get(captured.uniqueKey);
      if (current?.timestamp !== captured.timestamp || current?.type !== captured.type) continue;
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
  
  // Capture timestamps at start of processing - used to detect re-queued entries during dequeue
  // This prevents accidentally deleting a newer entry that was queued while we were processing
  const snapshotTimestamps = new Map();
  for (const update of updates) {
    snapshotTimestamps.set(update.uniqueKey, update.timestamp);
  }
  
  let hadError = false;
  try {
    const processedKeys = new Set();
    const abandonedUpdates = [];

    // Group by operation type
    const toIndexUpdates = updates.filter(u => u.type === 'new' || u.type === 'moved');
    const toDeleteUpdates = updates.filter(u => u.type === 'deleted');
    
    // Process deletions first - use unique keys directly
    // NOTE: If folder info was stale in onDeleted event, the key might not match FTS.
    // We now try fallback folder paths to catch these cases.
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
        log(`[TMDBG FTS] Removed ${removedCount}/${toDeleteUniqueKeys.length} messages - ${missedCount} may have stale folder keys, trying fallbacks`);
      } else {
        log(`[TMDBG FTS] Removed ${removedCount} messages from index`);
      }

      // Verify deletions and use native search by headerMessageId for missed entries
      // This handles cases where onDeleted event has wrong folder info (common with Gmail/IMAP)
      let verifiedDeletes = 0;
      let fallbackDeletes = 0;
      let deleteVerifyFailed = 0;
      for (const key of toDeleteUniqueKeys) {
        try {
          const ftsEntry = await _ftsSearch.getMessageByMsgId(key);
          if (!ftsEntry || ftsEntry.msgId !== key) {
            // Original key not in FTS - use native search to find entries with same headerMessageId
            // This is the key fix: the delete event may have had wrong folder info
            const fallbackResult = await _tryFallbackDeletion(key, _ftsSearch);
            if (fallbackResult.found) {
              log(`[TMDBG FTS] Native search deletion succeeded: ${fallbackResult.deletedKeys.join(', ')}`);
              fallbackDeletes += fallbackResult.deletedKeys.length;
            }
            // Whether fallback found something or not, mark as processed (original is gone)
            processedKeys.add(key);
            verifiedDeletes++;
            logFtsOperation("verify_delete", "success", {
              uniqueKey: key,
              usedFallback: fallbackResult.found,
              fallbackKeys: fallbackResult.deletedKeys,
            });
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
        fallbackCount: fallbackDeletes,
        failCount: deleteVerifyFailed,
      });

      if (fallbackDeletes > 0) {
        log(`[TMDBG FTS] Delete verification: ${verifiedDeletes}/${toDeleteUniqueKeys.length} confirmed removed (${fallbackDeletes} via native headerMessageId search)`);
      }
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
          // Parse uniqueKey: accountId:folderPath:headerMessageId
          // NOTE: Queue is based on headerMessageId (stable), NOT weId (unstable)
          // At processing time, we re-resolve to get the CURRENT weId
          const parsed = parseUniqueId(update.uniqueKey);
          if (!parsed) {
            // Unparseable key is a permanent failure - drop immediately
            log(`[TMDBG FTS] Failed to parse uniqueKey: ${update.uniqueKey} - dropping (unparseable)`, "warn");
            logFtsOperation("resolve", "failure", {
              uniqueKey: update.uniqueKey,
              reason: "unparseable_key",
              subject: update.metadata?.subject,
            });
            abandonedUpdates.push(update);
            droppedCount++;
            continue;
          }
          
          const { weFolder, headerID } = parsed;
          
          // Re-resolve headerMessageId -> current weId at processing time
          // This handles weId instability during IMAP sync - if it fails, we retry
          let weID = null;
          try {
            weID = await headerIDToWeID(headerID, weFolder, false);
          } catch (resolveError) {
            log(`[TMDBG FTS] Error resolving headerID ${headerID}: ${resolveError}`, "warn");
          }
          
          if (!weID) {
            // Resolution failed - mark for retry (weId may stabilize on next attempt)
            _markResolveFailed(update);
            log(`[TMDBG FTS] Failed to resolve headerID to weId: ${headerID} - marked for retry`);
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
            if (update.hasFailed) {
              const resetUpdate = { ...update, hasFailed: false, lastFailedAt: 0 };
              _pendingUpdates.set(update.uniqueKey, resetUpdate);
            }
            resolvedEntries.push({ update, messageHeader });
            logFtsOperation("resolve", "success", {
              uniqueKey: update.uniqueKey,
              headerMessageId: headerID,
              weId: weID,
              currentFolder: messageHeader.folder?.path,
              subject: messageHeader.subject,
              wasRetried: update.hasFailed,
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
          
          // Step 2: Filter to find messages that need indexing
          const filterResult = await _ftsSearch.filterNewMessages(headerBatch);
          const newMsgIds = filterResult.newMsgIds || [];
          const batchKeys = headerBatch.map(row => row.msgId);
          
          // Log filterNewMessages results
          logFtsBatchOperation("filter", "complete", {
            total: headerBatch.length,
            newCount: newMsgIds.length,
            existingCount: headerBatch.length - newMsgIds.length,
          });
          
          // Messages reported as already indexed - VERIFY they actually exist in FTS
          // This catches cases where filterNewMessages incorrectly reports messages as indexed
          const alreadyIndexedKeys = batchKeys.filter(key => !newMsgIds.includes(key));
          let verifiedExisting = 0;
          let existingVerifyFailed = 0;
          
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
                const existing = _pendingUpdates.get(queuedKey);
                if (existing) {
                  _markResolveFailed(existing);
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
    // IMPORTANT: Only delete if the timestamp matches what we processed
    // This prevents deleting entries that were re-queued during processing
    let processedCount = 0;
    let reQueuedCount = 0;
    for (const key of processedKeys) {
      const current = _pendingUpdates.get(key);
      if (!current) {
        // Already deleted (shouldn't happen, but safe to skip)
        continue;
      }
      
      const snapshotTs = snapshotTimestamps.get(key);
      if (current.timestamp === snapshotTs) {
        // Timestamp matches - safe to delete, this is the entry we processed
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
    try {
      await _deferFolderReconAfterDrainFailure(updates, "drain_error");
    } catch (markerError) {
      // Every queue intention remains live and is persisted below. A marker
      // write failure must neither drop it nor undo the synchronous fairness
      // boundary; the next retry/dirty event will attempt persistence again.
      log(`[TMDBG FTS] Failed to persist drain-error reconcile marker: ${markerError}`, "error");
    }
    // Don't delete from map - will retry on next batch
    // Don't count as no-progress since we had an error (not a stable state)
  }
  
  // Clear persist timer to avoid redundant persistence
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  
  // Update persistence after processing
  if (_pendingUpdates.size === 0) {
    // All updates processed - clear storage
    await clearPersistedUpdates();
    // Drain is empty: folders the boot folder-reconcile skipped as
    // drain-busy can now be re-checked (single-shot per boot; async —
    // must not block the drain loop's tail). PLAN_FOLDER_SET_RECONCILE.md.
    _maybeScheduleFolderReconRerun();
  } else {
    // More updates remain - persist current state
    await persistPendingUpdates();
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
  _invalidateFolderReconProofForEvent(messageInfo?.accountId, messageInfo?.folderPath);

  // Track the highest msgKey seen per folder this session — the heartbeat
  // merges these into the persistent folder cursors (ADR-020). Only
  // delivered events advance this, so unevented arrivals stay above the
  // cursor and are caught by the next boot's cursor scan.
  _noteSessionMaxKey(messageInfo);

  log(`[TMDBG FTS] Experiment msgAdded: type=${messageInfo.eventType}, folder=${messageInfo.folderPath}, subject="${messageInfo.subject?.substring(0, 50)}"`);

  await _enqueueNewFromInfo(messageInfo);
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
    schedulePersist();
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

  // Track sync event for reconcile quiet-period detection
  _lastSyncEventMs = Date.now();
  _invalidateFolderReconProofForEvent(messageInfo?.accountId, messageInfo?.folderPath);

  const { headerMessageId, weFolderId, folderPath, accountId, msgKey, eventType } = messageInfo;

  log(`[TMDBG FTS] Experiment msgRemoved: type=${eventType}, folder=${folderPath}, headerMessageId=${headerMessageId?.substring(0, 30)}`);
  
  // Build unique key from the info we have
  const uniqueKey = `${accountId}:${folderPath}:${headerMessageId}`;
  
  if (!accountId || !folderPath || !headerMessageId) {
    log(`[TMDBG FTS] Experiment msgRemoved: invalid key components, skipping`, "warn");
    return;
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
    schedulePersist();
    return true;
  } finally {
    release();
  }
}

// Track experiment listener state
let _experimentListenersActive = false;

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
    // Register for message added events
    browser.tmMsgNotify.onMessageAdded.addListener(onExperimentMessageAdded);
    
    // Register for message removed events
    browser.tmMsgNotify.onMessageRemoved.addListener(onExperimentMessageRemoved);
    
    _experimentListenersActive = true;
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
  if (!_experimentListenersActive) return;
  
  try {
    if (browser.tmMsgNotify) {
      browser.tmMsgNotify.onMessageAdded.removeListener(onExperimentMessageAdded);
      browser.tmMsgNotify.onMessageRemoved.removeListener(onExperimentMessageRemoved);
    }
    _experimentListenersActive = false;
    log("[TMDBG FTS] Experiment listeners removed");
  } catch (e) {
    log(`[TMDBG FTS] Error removing experiment listeners: ${e}`, "warn");
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
// folders get an exact two-way repair through the persistent drain queue.
//
// The older date-window, watermark, and cursor helpers remain below for
// compatibility/tests, but the automatic startup path no longer calls them.
// =====================================================================

// Storage key for persisting reconcile-needed state across restarts
const RECONCILE_STORAGE_KEY = "fts_reconcile_pending";
// One strict serialization chain is intentionally permanent for the module
// lifetime. Generation changes cancel stale transactions but never reset or
// bypass ordering between memo and pending-marker operations.
let _reconStorageChain = Promise.resolve();
let _reconMarkerPersisted = false;
let _reconMarkerInFlight = null;
let _reconMarkerClearInFlight = false;

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
    const stored = await browser.storage.local.get([
      FOLDER_RECON_STORAGE_KEY,
      RECONCILE_STORAGE_KEY,
    ]);
    if (generation !== _folderReconGeneration) throw new Error("folder_recon_cancelled");
    const memo = _rawFolderReconMemo(stored?.[FOLDER_RECON_STORAGE_KEY]);
    const memoBefore = JSON.stringify(memo);
    const state = {
      memo,
      pending: stored?.[RECONCILE_STORAGE_KEY],
      setPending: undefined,
      removePending: false,
    };
    const patchResult = patch(state);
    if (patchResult && typeof patchResult.then === "function") {
      throw new Error("reconcile_storage_patch_must_be_synchronous");
    }
    if (generation !== _folderReconGeneration) throw new Error("folder_recon_cancelled");
    const toSet = {};
    if (JSON.stringify(state.memo) !== memoBefore) {
      toSet[FOLDER_RECON_STORAGE_KEY] = state.memo;
    }
    if (state.setPending !== undefined) {
      toSet[RECONCILE_STORAGE_KEY] = state.setPending;
    }
    if (Object.keys(toSet).length > 0) {
      await browser.storage.local.set(toSet);
      if (generation !== _folderReconGeneration) throw new Error("folder_recon_cancelled");
    }
    if (state.removePending) {
      await browser.storage.local.remove(RECONCILE_STORAGE_KEY);
      if (generation !== _folderReconGeneration) throw new Error("folder_recon_cancelled");
    }
    return { ...state, result: patchResult };
  });
}

async function _readReconStorageStrict(generation = _folderReconGeneration) {
  return _reconStorageTransaction(generation, () => {});
}

async function _ensureFolderReconPendingMarker() {
  // A clear may already be serialized ahead of this request. Treat the
  // durable marker as absent while that remove is in flight so a concurrent
  // dirty event queues a restoring set behind it instead of disappearing.
  if (_reconMarkerPersisted && !_reconMarkerClearInFlight) return;
  const generation = _folderReconGeneration;
  if (_reconMarkerInFlight?.generation === generation) {
    return _reconMarkerInFlight.promise;
  }
  const owner = { generation, promise: null };
  owner.promise = _reconStorageTransaction(generation, (state) => {
    if (!state.pending) state.setPending = Date.now();
  }).then(() => {
    if (generation === _folderReconGeneration) _reconMarkerPersisted = true;
  }).finally(() => {
    if (_reconMarkerInFlight === owner) _reconMarkerInFlight = null;
  });
  _reconMarkerInFlight = owner;
  return owner.promise;
}

async function _clearFolderReconPendingMarkerIfCurrent(generation, syncStartedAt) {
  _reconMarkerClearInFlight = true;
  // Publish the possible absence before enqueueing the transaction. Calls to
  // ensure() that race the awaited remove will therefore serialize a set
  // after the remove on the permanent strict storage chain.
  _reconMarkerPersisted = false;
  try {
    const transaction = await _reconStorageTransaction(generation, (state) => {
      if (_lastSyncEventMs > syncStartedAt
          || _folderReconDirty.size > 0
          || _pendingUpdates.size > 0) {
        return false;
      }
      state.removePending = true;
      return true;
    });
    if (transaction.result !== true) _reconMarkerPersisted = true;
    return transaction.result === true;
  } finally {
    _reconMarkerClearInFlight = false;
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
  browser.storage.local.set({ [key]: { at: new Date().toISOString(), ...payload } })
    .catch(() => {});
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
 * "refuse to create" rule). Guarded by the shared drain-stall check: an
 * event that was delivered and enqueued is covered by queue persistence,
 * so advancing past it is safe once the drain is healthy.
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
 * enqueue for it succeeded (once enqueued, the drain queue's persistence +
 * retry own delivery — same contract as the watermark's enqueueFailed rule).
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
      folders.push({ accountId, folderPath: folder.path });
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
  { imapOnly = false, onlyFolderKeys = null, currentIdentities = null } = {},
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
      state = await browser.tmMsgNotify[methodName](identity.accountId, identity.folderPath);
    } catch (e) {
      state = { ...identity, folderURI: "", error: String(e) };
    }
    out.push(state);
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
// (mirrors RECONCILE_RECHECK_KEEPALIVE_EVERY)
const FOLDER_RECON_RECHECK_KEEPALIVE_EVERY = 50;
// Full-keyspace upper bound for the orphan sweep: U+FFFF sorts above every
// character that can appear in a msgId key.
const FOLDER_RECON_KEYSPACE_END = "￿";
// The exact membership proof needs initial add-side completeness. Before the
// initial FULL scan has completed, every folder has a huge policy deficit and the missing
// direction would mass-enqueue the whole backlog through the incremental
// drain queue (whose persistence serializes the entire map per debounce).
// Gate the whole phase on the initial scan's completion flag (written by
// chat/background.js runInitialFtsScan).
const FOLDER_RECON_INITIAL_SCAN_KEY = "fts_initial_scan_complete";
const FOLDER_RECON_CONFIG = {
  folderScanPageSize: 250,
  digestWorkChunkEntries: 1000,
  missingPageKeys: 500,
  stalePageKeys: 100,
  stalePagesPerSlice: 1,
  rechecksPerSlice: 5,
  enqueuesPerSlice: 20,
  pendingHighWater: 100,
  pendingLowWater: 25,
  paceDelayMs: 250,
  pressureDelayMs: 2000,
  errorDelayMs: 10000,
  syncQuietMs: 5000,
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
// the UI. Mirrors RECONCILE_ENTRY_DELAY_MS in reconcile Phase 2.
const FOLDER_RECON_ENTRY_DELAY_MS = 10;
// Per-slice limits prevent a mature profile's backlog from issuing an
// unbroken run of parent-thread global rechecks or drain-queue body fetches.
// The scheduler's total progress remains unbounded.
const FOLDER_RECON_SCAN_PAGE_SIZE = FOLDER_RECON_CONFIG.folderScanPageSize;
const FOLDER_RECON_DIGEST_WORK_CHUNK_ENTRIES = FOLDER_RECON_CONFIG.digestWorkChunkEntries;
const FOLDER_RECON_MISSING_PAGE_KEYS = FOLDER_RECON_CONFIG.missingPageKeys;
const FOLDER_RECON_STALE_PAGE_KEYS = FOLDER_RECON_CONFIG.stalePageKeys;
const FOLDER_RECON_STALE_PAGES_PER_SLICE = FOLDER_RECON_CONFIG.stalePagesPerSlice;
const FOLDER_RECON_RECHECKS_PER_SLICE = FOLDER_RECON_CONFIG.rechecksPerSlice;
const FOLDER_RECON_ENQUEUES_PER_SLICE = FOLDER_RECON_CONFIG.enqueuesPerSlice;
const FOLDER_RECON_PENDING_HIGH_WATER = FOLDER_RECON_CONFIG.pendingHighWater;
const FOLDER_RECON_PENDING_LOW_WATER = FOLDER_RECON_CONFIG.pendingLowWater;
const FOLDER_RECON_PACE_DELAY_MS = FOLDER_RECON_CONFIG.paceDelayMs;
const FOLDER_RECON_PRESSURE_DELAY_MS = FOLDER_RECON_CONFIG.pressureDelayMs;
const FOLDER_RECON_ERROR_DELAY_MS = FOLDER_RECON_CONFIG.errorDelayMs;
const FOLDER_RECON_SYNC_QUIET_MS = FOLDER_RECON_CONFIG.syncQuietMs;
// A completed add-side sweep that still fails exact equality is replayed once
// immediately (transient native filter failures recover without delay). If the
// same exact set/key-map proof fails again after that replay, subsequent full
// replays use durable exponential wall-clock backoff. The cap preserves
// eventual healing without letting permanently unindexable rows repeatedly
// consume the shared enqueue budget on every startup.
const FOLDER_RECON_POST_VERIFY_BACKOFF_INITIAL_MS = 6 * 60 * 60 * 1000;
const FOLDER_RECON_POST_VERIFY_BACKOFF_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const FOLDER_RECON_GENERIC_FAILURE_BACKOFF_MAX_MS = 5 * 60 * 1000;

function _sanitizeFolderReconRetryNotBeforeMs(value, nowMs) {
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return Math.min(value, nowMs + FOLDER_RECON_POST_VERIFY_BACKOFF_MAX_MS);
}

// Feature detection for the native fingerprint/range RPCs (helper ≥ 0.11.0).
// null = not probed yet this session; false = old deployed helper → the whole
// phase no-ops and the user must upgrade or use an explicit manual repair.
let _folderReconNativeSupported = null;
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
let _folderReconDirty = new Set();
let _folderReconOrphanDone = false;
let _folderReconOrphanBasis = null;
let _folderReconMutationSerial = 0;
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
let _exclusiveMarkerRetryOwner = null;
const FOLDER_RECON_OUTCOME_PERSIST_INTERVAL_MS = 30 * 1000;
const FOLDER_RECON_OUTCOME_FIELDS = [
  "foldersTotal", "foldersErrored", "foldersDrainBusy", "foldersMemoHit",
  "foldersClean", "foldersReconciled", "foldersFailed", "foldersBudgetPartial",
  "foldersLocalDrift", "foldersBackoff", "staleCandidates", "staleRemoved",
  "recheckKeptPresent", "recheckKeptError", "missingEnqueued", "orphanRemoved",
  "orphanKeysKept",
];

const _folderReconEncoder = new TextEncoder();

function _isExclusiveMarkerRetryOwnerCurrent(owner) {
  return owner === _exclusiveMarkerRetryOwner
    && owner.cancelled !== true
    && owner.generation === _folderReconGeneration
    && _isEnabled
    && !_indexerDisposed;
}

function _cancelExclusiveMarkerRetry() {
  const owner = _exclusiveMarkerRetryOwner;
  if (!owner) return;
  if (owner.timer) clearTimeout(owner.timer);
  owner.timer = null;
  owner.cancelled = true;
  if (_exclusiveMarkerRetryOwner === owner) _exclusiveMarkerRetryOwner = null;
}

async function _attemptExclusiveMarkerRetry(owner) {
  if (!_isExclusiveMarkerRetryOwnerCurrent(owner) || owner.attempting) return;
  owner.attempting = true;
  try {
    if (!_isExclusiveMarkerRetryOwnerCurrent(owner)) return;
    await _ensureFolderReconPendingMarker();
    if (!_isExclusiveMarkerRetryOwnerCurrent(owner)) return;
    // Clear only the owner whose durable write succeeded. A replacement
    // generation may have installed a different retry while this await ran.
    _exclusiveMarkerRetryOwner = null;
    _wakeFolderRecon("exclusive_membership_change", FOLDER_RECON_PACE_DELAY_MS);
  } catch (error) {
    if (!_isExclusiveMarkerRetryOwnerCurrent(owner)) return;
    log(`[FTS FolderRecon] Failed to persist exclusive-mutation retry marker: ${error}`, "error");
    owner.timer = setTimeout(() => {
      owner.timer = null;
      if (!_isExclusiveMarkerRetryOwnerCurrent(owner)) return;
      void _attemptExclusiveMarkerRetry(owner);
    }, FOLDER_RECON_ERROR_DELAY_MS);
  } finally {
    owner.attempting = false;
  }
}

function _ensureExclusiveMarkerRetry(generation) {
  if (generation !== _folderReconGeneration || !_isEnabled || _indexerDisposed) return;
  let owner = _exclusiveMarkerRetryOwner;
  if (!owner || owner.generation !== generation) {
    _cancelExclusiveMarkerRetry();
    owner = {
      generation,
      attempting: false,
      timer: null,
      cancelled: false,
    };
    _exclusiveMarkerRetryOwner = owner;
  }
  if (!owner.attempting && !owner.timer) void _attemptExclusiveMarkerRetry(owner);
}

function _handleExclusiveFtsMembershipChange() {
  if (!_isEnabled || _indexerDisposed) return;
  const generation = _folderReconGeneration;
  _folderReconMutationSerial = Math.min(
    Number.MAX_SAFE_INTEGER,
    _folderReconMutationSerial + 1,
  );
  _folderReconSessionDone.clear();
  _folderReconSessionDeferred.clear();
  _folderReconFailureCounts.clear();
  _folderReconDrainFailureDeferred.clear();
  _folderReconDrainFailureCounts.clear();
  _folderReconOrphanDone = false;
  _folderReconOrphanBasis = null;
  _releaseFolderReconActiveProof(null, "invalidation");
  _folderReconDirty.add("__all__");

  // The coordinator invokes this only after releasing exclusive ownership.
  // In-memory proof invalidation above is synchronous; durable storage stays
  // on the permanent strict chain, and only its success may arm the wake.
  _ensureExclusiveMarkerRetry(generation);
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
  const nowMs = Date.now();
  if (!force
      && aggregate.lastPersistedAtMs > 0
      && nowMs - aggregate.lastPersistedAtMs < FOLDER_RECON_OUTCOME_PERSIST_INTERVAL_MS) {
    return;
  }
  aggregate.lastPersistedAtMs = nowMs;
  _writeReconSnapshot("fts_folder_recon_last", {
    generation: aggregate.generation,
    startedAtMs: aggregate.startedAtMs,
    slices: aggregate.slices,
    totals: { ...aggregate.totals },
    latest: { ...aggregate.latest },
    unverifiedFolders: aggregate.unverifiedFolders,
    lastElapsedMs: aggregate.lastElapsedMs,
    complete: aggregate.complete,
    activeWorkingProof: _folderReconWorkingProofTelemetry(),
  });
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
  _persistFolderReconOutcome(false);
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

function _assertFolderReconGeneration(generation, syncStartedAt, mutationSerial = null) {
  if (!_isEnabled || generation !== _folderReconGeneration) {
    throw new Error("folder_recon_cancelled");
  }
  if (_lastSyncEventMs > syncStartedAt) {
    throw new Error("folder_changed_during_scan");
  }
  if (mutationSerial !== null && mutationSerial !== _folderReconMutationSerial) {
    throw new Error("folder_changed_during_scan");
  }
}

function _assertFolderReconLease(lease, generation, syncStartedAt = _lastSyncEventMs, mutationSerial = null) {
  if (!lease || lease.released || lease.cancelRequested) throw new Error("folder_recon_cancelled");
  _assertFolderReconGeneration(generation, syncStartedAt, mutationSerial);
}

function _throwIfFolderReconInterrupted(error) {
  const message = String(error?.message || error);
  if (message.includes("folder_recon_cancelled")
      || message.includes("folder_recon_pressure")) {
    throw error;
  }
}

async function _assertFolderReconMembershipEpoch(expectedEpoch, reconcileLease, generation) {
  await withFtsMembershipFence(expectedEpoch, () => {
    if (reconcileLease) _assertFolderReconLease(reconcileLease, generation);
  });
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
  const syncStartedAt = _lastSyncEventMs;
  const mutationSerial = _folderReconMutationSerial;
  const reconcileLease = _folderReconInProgressOwner?.generation === generation
    ? _folderReconInProgressOwner.reconcileLease
    : (_folderReconSchedulerOwner?.generation === generation
      ? _folderReconSchedulerOwner.reconcileLease
      : null);
  const assertCurrent = () => reconcileLease
    ? _assertFolderReconLease(reconcileLease, generation, syncStartedAt, mutationSerial)
    : _assertFolderReconGeneration(generation, syncStartedAt, mutationSerial);
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
      syncStartedAt,
      mutationSerial,
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
    syncStartedAt: entry.syncStartedAt,
    mutationSerial: entry.mutationSerial,
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
    syncStartedAt: snapshot.syncStartedAt,
    mutationSerial: snapshot.mutationSerial,
    sortedKeys: snapshot.sortedKeys,
  };
  _folderReconActiveProof = entry;
  _folderReconWorkingProofStats.scans++;
  return entry;
}

function _folderReconGuardForFreshProof(folderKey, entry, snapshot) {
  return entry
    ? { folderKey, entry }
    : { generation: _folderReconGeneration, mutationSerial: snapshot.mutationSerial };
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

function _invalidateFolderReconProofForEvent(accountId, folderPath) {
  _folderReconMutationSerial = Math.min(
    Number.MAX_SAFE_INTEGER,
    _folderReconMutationSerial + 1,
  );
  if (!accountId || !folderPath) {
    _releaseFolderReconActiveProof(null, "invalidation");
    return;
  }
  _releaseFolderReconActiveProof(`${accountId}:${folderPath}`, "invalidation");
}

function _folderReconProofGuardCurrent(guard) {
  if (!guard || guard.generation !== undefined) {
    return !!guard
      && guard.generation === _folderReconGeneration
      && guard.mutationSerial === _folderReconMutationSerial;
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

function _pruneFolderReconRuntimeToFolderKeys(folderKeys) {
  let removedState = false;
  for (const folderKey of [..._folderReconDirty]) {
    if (folderKey !== "__all__" && !folderKeys.has(folderKey)) {
      _folderReconDirty.delete(folderKey);
      removedState = true;
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
    _folderReconOrphanBasis = null;
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
 * pre-existing key schema is non-injective for those paths; issue #20 owns the
 * future schema migration. Reconciliation detects that condition and fails
 * closed before any range proof or orphan work.
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
async function _checkFolderReconNativeSupport(ftsSearch) {
  if (_folderReconNativeSupported !== null) return _folderReconNativeSupported;
  try {
    // Equal bounds exercise method dispatch/validation without scanning the
    // user's index; real per-folder fingerprints follow immediately.
    await ftsSearch.fingerprintMsgIdRange("", "");
    _folderReconNativeSupported = true;
  } catch (e) {
    _folderReconNativeSupported = false;
    log(`[FTS FolderRecon] Native helper lacks fingerprint RPCs (${e}) — startup consistency proof disabled until helper upgrade; manual repair remains available`, "warn");
    logFtsBatchOperation("folder_recon", "unsupported", { error: String(e) });
    _writeReconSnapshot("fts_folder_recon_last", { skipped: true, reason: "native_unsupported", error: String(e) });
  }
  return _folderReconNativeSupported;
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

async function _writeFolderReconMemo(
  memo,
  {
    generation = _folderReconGeneration,
    folderKeys = null,
    roundRobin = false,
    orphanSweep = false,
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
    if (roundRobin) state.memo.roundRobinCursor = memo.roundRobinCursor ?? null;
    if (orphanSweep) {
      if (memo.orphanSweep) state.memo.orphanSweep = structuredClone(memo.orphanSweep);
      else delete state.memo.orphanSweep;
    }
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
  resumeAfterKey = null,
  expectedMembershipEpoch = getFtsMembershipEpoch(),
) {
  const generation = _folderReconGeneration;
  const reconcileLease = _folderReconInProgressOwner?.reconcileLease
    || _folderReconSchedulerOwner?.reconcileLease;
  const assertCurrent = () => {
    if (reconcileLease) _assertFolderReconLease(reconcileLease, generation);
    _assertNoFolderReconForegroundPressure();
  };
  const folderPrefix = `${f.accountId}:${f.folderPath}:`;
  const weFolder = { accountId: f.accountId, path: f.folderPath };
  let afterKey = resumeAfterKey;
  let pages = 0;

  while (pages < FOLDER_RECON_STALE_PAGES_PER_SLICE) {
    assertCurrent();
    if (expectedMembershipEpoch !== getFtsMembershipEpoch()) {
      return { clean: false, budgetPartial: false, cursor: afterKey, reachedEnd: false, localDrift: true };
    }
    let res;
    try {
      assertCurrent();
      res = await ftsSearch.listMsgIdRange(
        startKey,
        endKey,
        afterKey,
        FOLDER_RECON_STALE_PAGE_KEYS,
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
        await withFtsMembershipFence(expectedMembershipEpoch, async (membershipFenceToken) => {
          assertCurrent();
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
        }, { mutation: true });
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
  totalKnownFtsCount,
  stats,
  budget,
  resume = null,
  basisProof = null,
) {
  const generation = _folderReconGeneration;
  const reconcileLease = _folderReconSchedulerOwner?.reconcileLease
    || _folderReconInProgressOwner?.reconcileLease;
  const assertCurrent = () => {
    if (reconcileLease) _assertFolderReconLease(reconcileLease, generation);
    _assertNoFolderReconForegroundPressure();
  };
  const basisEpoch = basisProof?.membershipEpoch ?? getFtsMembershipEpoch();
  assertCurrent();
  const nativeAll = basisProof?.nativeAll
    || await ftsSearch.fingerprintMsgIdRange("", FOLDER_RECON_KEYSPACE_END);
  assertCurrent();
  if (!(nativeAll.count > totalKnownFtsCount)) {
    return { complete: true, cursor: null, nativeAll, terminalEpoch: basisEpoch };
  }
  const afterKey = resume?.inventoryCount === basisProof?.inventoryCount
    && resume?.inventorySha256 === basisProof?.inventorySha256
    && resume?.knownFtsCount === totalKnownFtsCount
    && typeof resume?.afterKey === "string"
    ? resume.afterKey
    : null;
  if (afterKey && (resume?.nativeCount !== nativeAll.count
      || resume?.nativeSha256 !== nativeAll.sha256
      || resume?.membershipEpoch !== basisEpoch)) {
    if (basisProof) basisProof.nativeDrifted = true;
  }
  const pageEpoch = getFtsMembershipEpoch();
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
  for (let i = 0; i < msgIds.length; i++) {
    const msgId = msgIds[i];
    if (_folderReconMsgIdHasKnownFolderPrefix(msgId, knownFolderKeys)) {
      processed = i + 1;
      continue;
    }
    const parsed = parseUniqueId(msgId);
    if (!parsed) {
      stats.orphanKeysKept++;
      processed = i + 1;
      continue;
    }
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
      return { complete: false, failed: true, cursor: afterKey, nativeAll };
    }
    processed = i + 1;
    assertCurrent();
    await _folderReconYield(FOLDER_RECON_ENTRY_DELAY_MS);
    assertCurrent();
  }
  const terminalPage = msgIds.length === 0
    || (processed >= msgIds.length && res.done === true);
  let finalNative = null;
  let terminalEpoch = null;
  try {
    if (entriesToRemove.length > 0) {
      await withFtsMembershipFence(pageEpoch, async (membershipFenceToken) => {
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
    } else if (pageEpoch !== getFtsMembershipEpoch()) {
      throw new Error("membership_epoch_changed");
    }
    if (terminalPage) {
      const fingerprintEpoch = getFtsMembershipEpoch();
      // This data-sized read is intentionally outside the membership mutex.
      // A foreground writer proceeds immediately; its epoch advance simply
      // makes this terminal proof stale and starts another safe pass.
      assertCurrent();
      finalNative = await ftsSearch.fingerprintMsgIdRange("", FOLDER_RECON_KEYSPACE_END);
      assertCurrent();
      if (fingerprintEpoch !== getFtsMembershipEpoch()) {
        return {
          complete: false,
          restart: true,
          terminalRefresh: true,
          cursor: null,
          nativeAll: finalNative,
        };
      }
      terminalEpoch = fingerprintEpoch;
    }
  } catch (e) {
    _throwIfFolderReconInterrupted(e);
    const membershipDrift = String(e?.message || e).includes("membership_epoch_changed");
    return {
      complete: false,
      ...(membershipDrift ? { restart: true } : { failed: true }),
      cursor: membershipDrift ? null : afterKey,
      nativeAll,
      error: String(e),
    };
  }
  if (pageEpoch !== basisEpoch || entriesToRemove.length > 0) {
    if (basisProof) basisProof.nativeDrifted = true;
  }
  if (processed < msgIds.length) {
    return {
      complete: false,
      cursor: processed > 0 ? msgIds[processed - 1] : afterKey,
      cursorEpoch: getFtsMembershipEpoch(),
      nativeAll,
    };
  }
  if (terminalPage) {
    const terminalDrift = basisProof?.nativeDrifted === true
      || finalNative?.count !== nativeAll.count
      || finalNative?.sha256 !== nativeAll.sha256;
    if (terminalDrift) {
      return {
        complete: false,
        restart: true,
        terminalRefresh: true,
        cursor: null,
        nativeAll: finalNative || nativeAll,
      };
    }
  }
  return {
    complete: res.done === true,
    cursor: res.done ? null : msgIds[msgIds.length - 1],
    ...(res.done !== true ? { cursorEpoch: getFtsMembershipEpoch() } : {}),
    nativeAll,
    ...(res.done === true ? { terminalEpoch } : {}),
  };
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
    if (!(await _checkFolderReconNativeSupport(ftsSearch))) {
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

  let folders;
  try {
    folders = await _readPerFolderExperimentState("getFolderState", {
      onlyFolderKeys,
      currentIdentities,
    });
    _assertFolderReconLease(reconcileLease, generation);
  } catch (e) {
    if (String(e?.message || e).includes("folder_recon_cancelled")) throw e;
    log(`[FTS FolderRecon] Folder inventory failed: ${e} — deferred`, "warn");
    logFtsBatchOperation("folder_recon", "error", { error: String(e) });
    return { skipped: true, reason: "folder_inventory_failed" };
  }

  const directAmbiguity = _folderReconAmbiguousKeyspaces(currentIdentities || folders);
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
  let memoChanged = memo._needsMigrationWrite === true;
  delete memo._needsMigrationWrite;
  // Expensive work budgets bound this one scheduler slice. Durable folder and
  // direction cursors plus fair repeated ticks make total convergence
  // unbounded without storming global rechecks or the incremental body drain.
  const verifiedThisRun = new Set();
  const verifiedEpochByFolder = new Map();
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
    //    is in flux — defer until the shared drain reaches low water.
    const pendingPrefix = `${folderKey}:`;
    let drainBusy = false;
    for (const pendingKey of _pendingUpdates.keys()) {
      if (pendingKey.startsWith(pendingPrefix)) {
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
    const mayTryUidOnly = priorExactProjection
      && f.serverType === "imap"
      && f.stableUidKeys === true
      && currentUidValidity !== null
      && memoUidValidity === currentUidValidity;
    if (!_folderReconActiveProof && mayTryUidOnly) {
      try {
        const uidOnly = await _scanFolderMessagesCooperatively(f, generation, false);
        if (uidOnly.proofKind !== "uid_only") throw new Error("uid_only_proof_expected");
        folderMembershipEpoch = getFtsMembershipEpoch();
        _assertNoFolderReconForegroundPressure();
        const uidNative = await ftsSearch.fingerprintMsgIdRange(startKey, endKey);
        _assertFolderReconLease(reconcileLease, generation);
        _assertNoFolderReconForegroundPressure();
        if (folderMembershipEpoch !== getFtsMembershipEpoch()) {
          throw new Error("membership_epoch_changed");
        }
        const uidCheckpointHit = uidOnly.stableUidKeys === true
          && _normalizeUidValidity(uidOnly.uidValidity) === memoUidValidity
          && m.uidCount === uidOnly.uidCount
          && m.uidSha256 === uidOnly.uidSha256;
        const ftsCheckpointHit = m.ftsCount === uidNative.count
          && m.ftsSha256 === uidNative.sha256;
        if (uidCheckpointHit && ftsCheckpointHit) {
          _assertFolderReconGeneration(
            generation,
            uidOnly.syncStartedAt,
            uidOnly.mutationSerial,
          );
          _assertNoFolderReconForegroundPressure();
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
      nativeFingerprint = await ftsSearch.fingerprintMsgIdRange(startKey, endKey);
      _assertFolderReconLease(reconcileLease, generation);
      _assertNoFolderReconForegroundPressure();
      if (folderMembershipEpoch !== getFtsMembershipEpoch()) {
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
        nativeFingerprint = await ftsSearch.fingerprintMsgIdRange(startKey, endKey);
        _assertFolderReconLease(reconcileLease, generation);
        _assertNoFolderReconForegroundPressure();
        if (folderMembershipEpoch !== getFtsMembershipEpoch()) {
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
    const writeVerifiedCheckpoint = (ftsFingerprint, proof = expected) => {
      if (proof.fromWorkingProof === true) throw new Error("retained_folder_proof_cannot_verify");
      _assertFolderReconGeneration(generation, proof.syncStartedAt, proof.mutationSerial);
      if (folderMembershipEpoch !== getFtsMembershipEpoch()) {
        throw new Error("membership_epoch_changed");
      }
      const proofUidValidity = proof.stableUidKeys === true
        ? _normalizeUidValidity(proof.uidValidity)
        : null;
      memo.folders[folderKey] = {
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
          highestModSeq: proof.highestModSeq || "",
        } : {}),
        updatedAtMs: Date.now(),
      };
      memoChanged = true;
      verifiedThisRun.add(folderKey);
      const proofEpoch = getFtsMembershipEpoch();
      verifiedEpochByFolder.set(folderKey, proofEpoch);
      memoEpochByFolder.set(folderKey, proofEpoch);
      _releaseFolderReconActiveProof(folderKey, "verified");
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
      writeVerifiedCheckpoint(nativeFingerprint);
      stats.foldersClean++;
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
    const stalePass = await _folderReconStaleDirection(
      ftsSearch,
      f,
      startKey,
      endKey,
      stats,
      budget,
      staleResumeKey,
      folderMembershipEpoch,
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
        const staleFingerprint = await ftsSearch.fingerprintMsgIdRange(startKey, endKey);
        _assertFolderReconLease(reconcileLease, generation);
        _assertNoFolderReconForegroundPressure();
        if (staleCursorEpoch !== getFtsMembershipEpoch()) {
          throw new Error("membership_epoch_changed");
        }
        folderMembershipEpoch = staleCursorEpoch;
        nextStaleState = {
          afterKey: stalePass.cursor,
          count: staleFingerprint.count,
          sha256: staleFingerprint.sha256,
          membershipEpoch: staleCursorEpoch,
        };
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
        const ftsNow = await ftsSearch.fingerprintMsgIdRange(startKey, endKey);
        _assertFolderReconLease(reconcileLease, generation);
        _assertNoFolderReconForegroundPressure();
        if (folderMembershipEpoch !== getFtsMembershipEpoch()) {
          writePartialCheckpoint(0, false, null, null);
          stats.foldersLocalDrift++;
        } else if (!_folderReconProofGuardCurrent(freshGuard)) {
          writePartialCheckpoint(0, false, null, null);
          stats.foldersLocalDrift++;
        } else if (ftsNow.count === freshExpected.count && ftsNow.sha256 === freshExpected.sha256) {
          writeVerifiedCheckpoint(ftsNow, freshExpected);
          stats.foldersReconciled++;
          _folderReconUnverified.delete(folderKey);
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

  if (memoChanged) {
    _assertFolderReconGeneration(generation, _lastSyncEventMs);
    const fencedKeys = [...memoEpochByFolder.keys()];
    for (const folderKey of fencedKeys) {
      const commitEpoch = memoEpochByFolder.get(folderKey);
      // Strict storage serialization owns memo generation/merge correctness;
      // the membership mutex is reserved for the tiny post-write epoch check.
      await _assertFolderReconMembershipEpoch(commitEpoch, reconcileLease, generation);
      await _writeFolderReconMemo(memo, { generation, folderKeys: [folderKey] });
      await _assertFolderReconMembershipEpoch(commitEpoch, reconcileLease, generation);
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

async function _runFolderReconOrphanSlice(ftsSearch, identities, memo) {
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
  const currentMembershipEpoch = getFtsMembershipEpoch();
  const collectingBasis = _folderReconOrphanBasis
    && _folderReconOrphanBasis.nextFolderIndex < identities.length;
  if (!_folderReconOrphanBasis
      || _folderReconOrphanBasis.generation !== generation
      || _folderReconOrphanBasis.inventoryCount !== inventory.count
      || _folderReconOrphanBasis.inventorySha256 !== inventory.sha256
      || (collectingBasis
        && _folderReconOrphanBasis.membershipEpoch !== currentMembershipEpoch)) {
    _folderReconOrphanBasis = {
      generation,
      inventoryCount: inventory.count,
      inventorySha256: inventory.sha256,
      membershipEpoch: currentMembershipEpoch,
      nextFolderIndex: 0,
      knownFtsCount: 0,
      nativeAll: null,
      nativeDrifted: false,
    };
  }
  const basis = _folderReconOrphanBasis;
  if (basis.nextFolderIndex < identities.length) {
    const identity = identities[basis.nextFolderIndex];
    const { startKey, endKey } = _folderKeyRange(identity.accountId, identity.folderPath);
    assertCurrent();
    const range = await ftsSearch.countMsgIdRange(startKey, endKey);
    assertCurrent();
    if (generation !== _folderReconGeneration
        || basis.membershipEpoch !== getFtsMembershipEpoch()) {
      _folderReconOrphanBasis = null;
      return { complete: false, deferred: true, restart: true };
    }
    basis.knownFtsCount += Math.max(0, Number(range?.count) || 0);
    basis.nextFolderIndex++;
    if (basis.nextFolderIndex < identities.length) {
      return { complete: false, deferred: true, basisProgress: true };
    }
  }
  if (!basis.nativeAll) {
    try {
      const fingerprintEpoch = basis.membershipEpoch;
      // A full-index fingerprint is data-sized and must not monopolize the
      // membership mutex. Epoch validation after the read rejects stale proof.
      basis.nativeAll = await ftsSearch.fingerprintMsgIdRange("", FOLDER_RECON_KEYSPACE_END);
      assertCurrent();
      if (fingerprintEpoch !== getFtsMembershipEpoch()) {
        throw new Error("membership_epoch_changed");
      }
    } catch (e) {
      _throwIfFolderReconInterrupted(e);
      _folderReconOrphanBasis = null;
      return { complete: false, deferred: true, restart: true };
    }
  } else if (basis.membershipEpoch !== currentMembershipEpoch) {
    // Folder inventory is still exact for this turn, so a membership-only
    // change cannot invalidate which prefixes are known. Preserve forward
    // cursor progress and force one fresh evidence pass at terminal instead
    // of restarting a potentially huge walk on every incoming message.
    basis.nativeDrifted = true;
  }
  const stats = { orphanRemoved: 0, orphanKeysKept: 0 };
  const result = await _folderReconOrphanSweep(
    ftsSearch,
    knownFolderKeys,
    basis.knownFtsCount,
    stats,
    { rechecks: FOLDER_RECON_RECHECKS_PER_SLICE },
    memo.orphanSweep || null,
    basis,
  );
  if (result.complete || result.restart) {
    delete memo.orphanSweep;
    _folderReconOrphanBasis = null;
  } else if (!result.failed) {
    memo.orphanSweep = {
      afterKey: result.cursor,
      inventoryCount: basis.inventoryCount,
      inventorySha256: basis.inventorySha256,
      knownFtsCount: basis.knownFtsCount,
      nativeCount: result.nativeAll.count,
      nativeSha256: result.nativeAll.sha256,
      membershipEpoch: basis.membershipEpoch,
      updatedAtMs: Date.now(),
    };
  }
  // A completed sweep is only as current as the exact native evidence read at
  // its terminal page.  Never launder that proof by stamping a newer epoch
  // after the fingerprint await; a foreground mutation queued in this window
  // must reject completion.  Partial cursor progress is inventory-bound and
  // may safely commit at the current epoch, with terminal drift forcing a
  // subsequent pass for newly inserted keys below the cursor.
  const commitEpoch = result.complete
    ? result.terminalEpoch
    : (result.cursorEpoch ?? getFtsMembershipEpoch());
  if (!Number.isSafeInteger(commitEpoch) || commitEpoch < 0) {
    throw new Error("orphan_terminal_epoch_missing");
  }
  // Browser storage can stall independently of native writers; never hold the
  // membership mutex across it. The short post-write fence decides whether
  // this run may rely on the committed cursor/checkpoint.
  await _assertFolderReconMembershipEpoch(commitEpoch, reconcileLease, generation);
  await _writeFolderReconMemo(memo, {
    generation,
    folderKeys: [],
    orphanSweep: true,
  });
  await _assertFolderReconMembershipEpoch(commitEpoch, reconcileLease, generation);
  return { ...result, ...stats };
}

async function _getFolderReconInventory(reconcileLease, generation, syncStartedAt) {
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
  _assertFolderReconLease(reconcileLease, generation, syncStartedAt);
  return identities;
}

/** Run one fair, bounded-cost folder/orphan slice and arrange the next tick. */
async function _runFolderReconSchedulerTick(ftsSearch = _ftsSearch) {
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
  const syncStartedAt = _lastSyncEventMs;
  if (_hasFolderReconForegroundPressure()
      || Date.now() - _lastSyncEventMs < FOLDER_RECON_SYNC_QUIET_MS
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
  const owner = { generation, reconcileLease, syncStartedAt };
  _folderReconSchedulerOwner = owner;
  _bumpFolderReconTelemetry("schedulerSlices");
  try {
    let scanGate;
    try {
      scanGate = await _readFolderReconScanGateStrict();
      _assertFolderReconLease(reconcileLease, generation, syncStartedAt);
    } catch (e) {
      if (String(e?.message || e).includes("folder_recon_cancelled")) throw e;
      _wakeFolderRecon("scan_gate_read_failed", FOLDER_RECON_ERROR_DELAY_MS);
      return { skipped: true, reason: "scan_gate_read_failed" };
    }
    if (!scanGate.allowed) {
      _wakeFolderRecon(scanGate.reason, FOLDER_RECON_ERROR_DELAY_MS);
      return { skipped: true, reason: scanGate.reason };
    }
    const identities = await _getFolderReconInventory(reconcileLease, generation, syncStartedAt);
    const keys = identities.map(i => `${i.accountId}:${i.folderPath}`);
    const currentFolderKeys = new Set(keys);
    _pruneFolderReconRuntimeToFolderKeys(currentFolderKeys);
    const ambiguous = _folderReconAmbiguousKeyspaces(identities);
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
      // No folder/account/message identifiers are emitted. Issue #20 owns the
      // schema migration; until then every overlapping range fails closed.
      logFtsBatchOperation("folder_recon", "ambiguous_keyspace", {
        ambiguousGroups: ambiguous.groups,
        ambiguousFolders: ambiguous.folderKeys.size,
      });
    }

    if (_folderReconDirty.delete("__all__")) {
      _folderReconSessionDone.clear();
      _folderReconSessionDeferred.clear();
      _folderReconFailureCounts.clear();
      for (const [folderKey, notBeforeMs] of _folderReconDrainFailureDeferred) {
        if (folderKey !== "__all__") {
          _folderReconSessionDeferred.set(folderKey, notBeforeMs);
        }
      }
      _folderReconOrphanDone = false;
      _folderReconOrphanBasis = null;
    }
    for (const dirty of [..._folderReconDirty]) {
      _folderReconSessionDone.delete(dirty);
      if (!_folderReconDrainFailureDeferred.has(dirty)
          && !_folderReconDrainFailureDeferred.has("__all__")) {
        _folderReconSessionDeferred.delete(dirty);
        _folderReconFailureCounts.delete(dirty);
      }
    }

    const memo = await _getFolderReconMemo();
    _assertFolderReconLease(reconcileLease, generation, syncStartedAt);
    const anchor = memo.roundRobinCursor;
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
      if (ambiguous.groups > 0) {
        // Per-folder ranges and the sum-of-ranges orphan basis are both
        // inexact while an overlap exists, so neither proof may run.
        _folderReconOrphanDone = false;
        _folderReconOrphanBasis = null;
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
        _wakeFolderRecon(
          "backoff_wait",
          Math.min(60_000, Math.max(FOLDER_RECON_PACE_DELAY_MS, earliestDeferred - Date.now())),
        );
        return { skipped: true, reason: "backoff" };
      }
      let orphan;
      try {
        orphan = await _runFolderReconOrphanSlice(ftsSearch, identities, memo);
      } catch (e) {
        if (!String(e?.message || e).includes("folder_recon_pressure")) throw e;
        _bumpFolderReconTelemetry("schedulerPressureSkips");
        _wakeFolderRecon("orphan_pressure", cooperativeDelay(FOLDER_RECON_PRESSURE_DELAY_MS));
        return { skipped: true, reason: "pressure" };
      }
      _assertFolderReconLease(reconcileLease, generation, syncStartedAt);
      _folderReconOrphanDone = orphan.complete === true
        && orphan.terminalEpoch === getFtsMembershipEpoch();
      if (_folderReconOrphanDone && _pendingUpdates.size === 0 && _folderReconDirty.size === 0) {
        const cleared = await _clearFolderReconPendingMarkerIfCurrent(generation, syncStartedAt);
        _assertFolderReconLease(reconcileLease, generation, syncStartedAt);
        if (cleared) {
          if (_folderReconOutcomeAggregate) _folderReconOutcomeAggregate.complete = true;
          _persistFolderReconOutcome(true);
          return { complete: true, orphan };
        }
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
    _folderReconDirty.delete(target);
    let stats;
    try {
      stats = await _runFolderReconcile(
        ftsSearch,
        new Set([target]),
        reconcileLease,
        identities,
      );
    } catch (e) {
      if (!String(e?.message || e).includes("folder_recon_pressure")) throw e;
      _bumpFolderReconTelemetry("schedulerPressureSkips");
      _wakeFolderRecon("folder_pressure", cooperativeDelay(FOLDER_RECON_PRESSURE_DELAY_MS));
      return { skipped: true, reason: "pressure" };
    }
    _assertFolderReconLease(reconcileLease, generation, syncStartedAt);
    if (stats?.skipped) {
      if (stats.reason !== "native_unsupported") {
        _wakeFolderRecon("skipped_retry", FOLDER_RECON_ERROR_DELAY_MS);
      }
      return stats;
    }
    const updatedMemo = await _getFolderReconMemo();
    _assertFolderReconLease(reconcileLease, generation, syncStartedAt);
    updatedMemo.roundRobinCursor = target;
    await _writeFolderReconMemo(updatedMemo, { folderKeys: [], roundRobin: true });
    _assertFolderReconLease(reconcileLease, generation, syncStartedAt);

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
        && stats?._verifiedEpochByFolder?.get(target) === getFtsMembershipEpoch()
        && (stats.foldersErrored || 0) === 0
        && (stats.foldersFailed || 0) === 0
        && (stats.foldersDrainBusy || 0) === 0
        && (stats.missingEnqueued || 0) === 0) {
      _folderReconSessionDone.add(target);
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
    // Leave RECONCILE_STORAGE_KEY set so an interrupted service worker/app
    // restart retries. Also arm the normal serialized scheduler retry so a
    // one-shot inventory/storage failure heals in this live session.
    _wakeFolderRecon("initial_error_retry", FOLDER_RECON_ERROR_DELAY_MS);
  }
}

// FTS query chunk size for reconcile cleanup (smaller than maintenance to be lighter)
const RECONCILE_QUERY_CHUNK_SIZE = 200;
// Delay between validation entries to avoid overwhelming TB APIs
const RECONCILE_ENTRY_DELAY_MS = 10;
// Native-FTS keepalive cadence during the verify-then-remove recheck loop
// (mirrors maintenance Phase 2.5 — a mass-deletion boot can produce thousands
// of candidates, each recheck a global messages.query that can take seconds;
// without pings the native connection would see no RPC until removeBatch).
const RECONCILE_RECHECK_KEEPALIVE_EVERY = 50;

/**
 * Phase 2 of reconciliation: query FTS entries in the reconcile window and
 * remove any that no longer exist in TB at their indexed folder path.
 *
 * Uses the same parseUniqueId + headerIDToWeID approach as maintenanceScheduler's
 * cleanupMissingEntries, but with lighter chunking since the reconcile window
 * is typically small.
 */
async function _reconcileCleanupStaleEntries(ftsSearch, reconcileFromMs) {
  const startDate = new Date(reconcileFromMs);
  const endDate = new Date();
  let checked = 0;
  let removed = 0;
  let accountsSkipped = 0;
  let removeFailed = false;
  const staleCandidates = [];
  // Account liveness — verified lazily per account as entries are
  // encountered (NOT sampled from the first chunk only: an account whose
  // entries appear only in older chunks would otherwise never be checked,
  // and its unloaded msgDBs would read as mass-stale; the recheck cannot
  // compensate because a global query can't see unloaded folders either).
  // After MV3 resume, TB may not have loaded all accounts' message
  // databases yet, causing headerIDToWeID to return null for valid messages.
  const checkedAccounts = new Set();
  const unavailableAccounts = new Set();

  logFtsBatchOperation("reconcile_phase2", "start", {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  });

  try {
    async function ensureAccountChecked(accountId) {
      if (!accountId || checkedAccounts.has(accountId)) return;
      checkedAccounts.add(accountId);
      try {
        const acct = await browser.accounts.get(accountId);
        if (!acct) {
          unavailableAccounts.add(accountId);
        } else {
          const folders = await browser.folders.query({ accountId, limit: 1 });
          if (!folders || folders.length === 0) {
            unavailableAccounts.add(accountId);
          }
        }
      } catch (e) {
        unavailableAccounts.add(accountId);
      }
      if (unavailableAccounts.has(accountId)) {
        log(`[FTS Reconcile] Phase 2: account ${accountId} unavailable — skipping its entries`, "warn");
        logFtsOperation("reconcile_stale", "accounts_unavailable", {
          unavailable: [accountId],
        });
      }
    }

    // Cursor-based pagination through FTS entries in the reconcile window.
    // The cursor steps INCLUSIVELY to the oldest entry's dateMs (dedup via
    // seenMsgIds) — an exclusive `oldestMs - 1` step would permanently skip
    // entries sharing that millisecond beyond a full-chunk boundary (Date
    // headers have second granularity, so ties are routine in bursts).
    let cursorEndMs = endDate.getTime();
    const startMs = startDate.getTime();
    const seenMsgIds = new Set();

    while (cursorEndMs > startMs) {
      const chunk = await ftsSearch.queryByDateRange(startDate, new Date(cursorEndMs), RECONCILE_QUERY_CHUNK_SIZE);

      if (!chunk || chunk.length === 0) break;

      let newInChunk = 0;
      for (const entry of chunk) {
        if (seenMsgIds.has(entry.msgId)) continue; // re-fetched tie at the boundary
        seenMsgIds.add(entry.msgId);
        newInChunk++;

        const parsed = parseUniqueId(entry.msgId);
        if (!parsed) {
          checked++;
          continue;
        }

        const { weFolder, headerID } = parsed;

        // Skip entries for accounts that aren't queryable
        await ensureAccountChecked(weFolder?.accountId);
        if (unavailableAccounts.has(weFolder?.accountId)) {
          checked++;
          continue;
        }

        try {
          // Check if message still exists at its indexed folder (no global fallback)
          const weID = await headerIDToWeID(headerID, weFolder, false, false);

          if (!weID) {
            // Message not found at its indexed folder — stale CANDIDATE.
            // Confirmed (or refuted) by the verify-then-remove pass below.
            staleCandidates.push({
              msgId: entry.msgId,
              headerID,
              weFolder,
            });
            logFtsOperation("reconcile_stale", "found", {
              msgId: entry.msgId,
              folderPath: weFolder?.path || "",
              headerID,
              subject: entry.subject || "",
            });
          }
        } catch (e) {
          // On error checking existence, skip (don't remove on uncertainty)
          log(`[TMDBG FTS] Reconcile cleanup: error checking ${entry.msgId}: ${e}`, "info");
          logFtsOperation("reconcile_stale", "error_skipped", {
            msgId: entry.msgId,
            folderPath: weFolder?.path || "",
            headerID,
            error: String(e),
          });
        }

        checked++;

        // Small yield between entries
        if (RECONCILE_ENTRY_DELAY_MS > 0) {
          await new Promise(r => setTimeout(r, RECONCILE_ENTRY_DELAY_MS));
        }
      }

      // Move cursor backwards (entries are dateMs DESC)
      if (chunk.length < RECONCILE_QUERY_CHUNK_SIZE) break;
      const oldestMs = chunk[chunk.length - 1]?.dateMs;
      if (typeof oldestMs !== 'number' || oldestMs <= startMs) break;
      // Inclusive step when the chunk made progress (ties at the boundary are
      // re-fetched and deduped next round); if the ENTIRE chunk was already
      // seen (a full chunk sharing one ms), step past it to escape.
      const nextCursor = newInChunk > 0 ? oldestMs : oldestMs - 1;
      if (nextCursor > cursorEndMs) break; // safety: cursor moved forward
      cursorEndMs = nextCursor;
    }

    // Verify-then-remove: re-check every candidate with a fresh GLOBAL query
    // before removal. A folder-constrained miss can be a transient msgDB state
    // (mid-sync, compaction) — observed 2026-06-03: a live [Gmail]/Bin message
    // was removed as "missing" and only recovered by the next weekly scan.
    // Only remove keys whose absence from their indexed folder is confirmed by
    // a SUCCESSFUL query; thrown queries keep the entry (skip on uncertainty).
    const entriesToRemove = [];
    let recheckKeptPresent = 0;
    let recheckKeptError = 0;
    let recheckedCount = 0;
    for (const cand of staleCandidates) {
      // KEEPALIVE: same cadence as maintenance Phase 2.5 — keep the native
      // FTS connection alive through a potentially long recheck pass.
      if (recheckedCount > 0 && recheckedCount % RECONCILE_RECHECK_KEEPALIVE_EVERY === 0) {
        try {
          await ftsSearch.stats();
        } catch (keepaliveErr) {
          log(`[FTS Reconcile] Phase 2 recheck keepalive ping failed: ${keepaliveErr.message}`, "warn");
        }
      }
      recheckedCount++;

      const verdict = await recheckMessageInFolder(cand.headerID, cand.weFolder);
      if (verdict === "absent") {
        // Only an explicit, successful confirmation of absence may remove —
        // any other verdict (present, error, unexpected) keeps the entry.
        entriesToRemove.push(cand.msgId);
      } else if (verdict === "present") {
        recheckKeptPresent++;
        log(`[FTS Reconcile] Phase 2: recheck found ${cand.msgId} still present — keeping (transient miss)`);
        logFtsOperation("reconcile_stale", "recheck_present", { msgId: cand.msgId });
      } else {
        recheckKeptError++;
        log(`[FTS Reconcile] Phase 2: recheck errored for ${cand.msgId} — keeping (unconfirmed)`, "warn");
        logFtsOperation("reconcile_stale", "recheck_error", { msgId: cand.msgId });
      }
      if (RECONCILE_ENTRY_DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, RECONCILE_ENTRY_DELAY_MS));
      }
    }
    if (recheckKeptPresent > 0 || recheckKeptError > 0) {
      log(`[FTS Reconcile] Phase 2: recheck kept ${recheckKeptPresent} present + ${recheckKeptError} errored of ${staleCandidates.length} candidates`);
    }

    // Remove stale entries in a single batch
    if (entriesToRemove.length > 0) {
      log(`[FTS Reconcile] Phase 2: removing ${entriesToRemove.length} stale entries`);
      // Log each entry being removed for debugging
      for (const msgId of entriesToRemove) {
        logFtsOperation("reconcile_remove", "removing", {
          msgId,
        });
      }
      try {
        const removeResult = await ftsSearch.removeBatch(entriesToRemove);
        removed = removeResult.count || 0;
        log(`[FTS Reconcile] Phase 2: removed ${removed} stale entries`);
      } catch (removeErr) {
        // Confirmed-stale entries are still in FTS — flag it so the caller
        // does NOT advance the watermark (the entries would otherwise fall
        // out of every future reconcile window and linger as ghosts).
        removeFailed = true;
        log(`[TMDBG FTS] Reconcile cleanup: removeBatch failed: ${removeErr}`, "warn");
      }
    }

    logFtsBatchOperation("reconcile_phase2", "complete", {
      checked,
      staleFound: staleCandidates.length,
      confirmedStale: entriesToRemove.length,
      recheckKeptPresent,
      recheckKeptError,
      removed,
    });

    log(`[FTS Reconcile] Phase 2 complete: ${checked} checked, ${staleCandidates.length} stale candidates, ${entriesToRemove.length} confirmed, ${removed} removed`);
  } catch (e) {
    // Any Phase 2 failure (FTS scan, recheck pass, anything) means the
    // window was NOT fully verified — the caller must not advance the
    // watermark, or every unverified entry falls out of all future
    // reconcile windows. Same contract as a removeBatch failure.
    removeFailed = true;
    log(`[TMDBG FTS] Reconcile phase 2 failed: ${e}`, "error");
    logFtsBatchOperation("reconcile_phase2", "error", {
      error: String(e),
      checked,
      removed,
    });
  }

  accountsSkipped = unavailableAccounts.size;
  return { checked, removed, accountsSkipped, removeFailed };
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
  _cancelExclusiveMarkerRetry();
  if (_folderReconTimer) clearTimeout(_folderReconTimer);
  _folderReconTimer = null;
  _folderReconTimerToken++;
  _folderReconTimerDueMs = 0;
  _folderReconRequestedDueMs = Infinity;
  _folderReconHardNotBeforeMs = 0;
  _folderReconNativeSupported = null;
  _folderReconDrainSkipped = new Set();
  _folderReconInProgressOwner = null;
  _folderReconUnverified = new Set();
  _folderReconSchedulerOwner = null;
  _folderReconSessionDone = new Set();
  _folderReconSessionDeferred = new Map();
  _folderReconFailureCounts = new Map();
  _folderReconDrainFailureDeferred = new Map();
  _folderReconDrainFailureCounts = new Map();
  _folderReconDirty = new Set();
  _folderReconOrphanDone = false;
  _folderReconOrphanBasis = null;
  _reconMarkerPersisted = false;
  _clearFolderReconActiveProof({ resetStats: true });
  _resetFolderReconRuntimeTelemetry();

  // Load settings
  await updateIncrementalSettings();

  if (!_isEnabled) {
    log("[TMDBG FTS] Incremental indexing is disabled");
    return;
  }

  // Restore any pending updates from previous session
  await restorePendingUpdates();

  log("[TMDBG FTS] Incremental indexer initialized");

  // Try to set up experiment listeners for reliable message notifications
  const experimentAvailable = await setupExperimentListeners();
  if (experimentAvailable) {
    log("[TMDBG FTS] Using experiment API (nsIMsgFolderNotificationService) for message events");
  } else {
    log("[TMDBG FTS] Experiment API not available - using WebExtension events only");
    log("[TMDBG FTS] NOTE: Integrate with existing agent listeners for WebExtension events");
  }

  // Persist that reconcile is needed — cleared on successful completion.
  // If the extension restarts before reconcile finishes, restorePendingUpdates
  // picks up any messages that were already enqueued, and the next init
  // will re-run reconcile for the rest.
  await _ensureFolderReconPendingMarker();

  // Schedule the membership proof after TB's startup sync settles. A quiet
  // local msgDB snapshot keeps the two fingerprints comparable. Listeners are
  // already active, so events during the wait still enter the durable queue.
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

/**
 * Timestamp of the most recent sync-related message event (experiment
 * msgAdded/msgRemoved). Exposed for the maintenance scheduler's startup-tick
 * quiet wait — the same signal the boot-reconcile quiet period polls.
 */
export function getLastSyncEventMs() {
  return _lastSyncEventMs;
}

/**
 * Whether boot reconcile is still pending (flag set in initIncrementalIndexer,
 * cleared when reconcile Phases 1+2 complete without an exception reaching
 * runPostInitReconcile's catch — including runs that withhold the watermark
 * via accountsSkipped/removeFailed: the reconcile is over for this session
 * either way, so the maintenance tick may proceed; the next BOOT retries from
 * the older watermark. A Phase 1 throw leaves the flag SET, which makes the
 * startup tick cap-skip — the hourly alarm is the backstop). Exposed for the
 * maintenance scheduler's startup-tick wait so a due maintenance scan doesn't
 * run concurrently with (or before) the boot reconcile.
 *
 * Returns false when incremental indexing is disabled: no reconcile will ever
 * run, so a stale `fts_reconcile_pending` flag left by an interrupted earlier
 * session must not stall the startup tick to its max-wait cap on every boot.
 */
export async function isReconcilePending() {
  if (!_isEnabled) return false;
  const stored = await _readReconStorageStrict();
  return !!stored.pending;
}

export async function disposeIncrementalIndexer() {
  log("[TMDBG FTS] Disposing incremental indexer");

  _isEnabled = false;
  _folderReconGeneration++;
  _cancelExclusiveMarkerRetry();
  _folderReconInProgressOwner = null;
  _folderReconSchedulerOwner = null;
  _resetFolderReconRuntimeTelemetry();
  if (_folderReconTimer) {
    clearTimeout(_folderReconTimer);
    _folderReconTimer = null;
  }
  _folderReconTimerToken++;
  _folderReconTimerDueMs = 0;
  _folderReconRequestedDueMs = Infinity;
  _folderReconHardNotBeforeMs = 0;
  // Set BEFORE awaiting anything — any in-flight heartbeat that hasn't
  // yet reached its post-read disposal check should now see this true
  // and skip its write.
  _indexerDisposed = true;
  _stopWatermarkHeartbeat();

  // Remove experiment listeners first
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
  
  // Persist any remaining pending updates before disposal
  if (_pendingUpdates.size > 0) {
    log(`[TMDBG FTS] Persisting ${_pendingUpdates.size} pending updates before disposal`);
    await persistPendingUpdates();
  }
  
  // Clear pending updates from memory
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
  _folderReconOrphanBasis = null;
  _reconMarkerPersisted = false;
  _reconMarkerClearInFlight = false;
  _clearFolderReconActiveProof();

  // Clear timers
  if (_batchTimer) {
    clearTimeout(_batchTimer);
    _batchTimer = null;
  }

  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
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

export async function updateIncrementalIndexerSettings() {
  const wasEnabled = _isEnabled;
  await updateIncrementalSettings();

  if (wasEnabled && !_isEnabled) {
    // Runtime disable does not advance the reconciliation generation, so
    // explicitly retire any private marker retry (including an in-flight
    // owner's authority to wake after its storage await settles).
    _cancelExclusiveMarkerRetry();
  } else if (!wasEnabled && _isEnabled && _folderReconDirty.has("__all__")) {
    // Exclusive membership invalidation is retained in-memory while disabled.
    // Re-arm its durable marker in the same generation before normal work can
    // wake. If an old in-flight write succeeded this is an idempotent check;
    // if it failed, the new owner retries the write.
    _ensureExclusiveMarkerRetry(_folderReconGeneration);
  }
  
  if (_isEnabled && !_ftsSearch) {
    log("[TMDBG FTS] Incremental indexing enabled but no FTS engine available", "warn");
  }
}

// Force process pending updates (for testing/manual trigger)
export async function flushPendingUpdates() {
  if (_batchTimer) {
    clearTimeout(_batchTimer);
    _batchTimer = null;
  }
  
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
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
    hasPersistTimer: !!_persistTimer,
    isProcessing: _isProcessing,
    settings: {
      batchDelay: INCREMENTAL_BATCH_DELAY_MS,
      batchSize: INCREMENTAL_BATCH_SIZE,
      persistDebounce: PERSIST_DEBOUNCE_MS,
    },
    folderRecon: {
      ..._folderReconRuntimeTelemetry,
      activeWorkingProof: _folderReconWorkingProofTelemetry(),
      outcomes: _folderReconOutcomeStatus(),
      scanTokens,
    },
  };
}

// Manually clear persisted pending updates (for debugging/maintenance)
export async function clearPendingUpdates() {
  log("[TMDBG FTS] Manually clearing pending updates");
  
  // Wait for any ongoing processing to complete
  if (_isProcessing) {
    log("[TMDBG FTS] Waiting for ongoing processing to complete before clearing");
    let waitCount = 0;
    while (_isProcessing && waitCount < 50) { // Max 5 seconds wait
      await new Promise(r => setTimeout(r, 100));
      waitCount++;
    }
    if (_isProcessing) {
      log("[TMDBG FTS] Clear timeout - forcing clear despite ongoing processing", "warn");
    }
  }
  
  // Manual destructive abandonment must become durable exact-reconcile work
  // before the live/persisted queue is erased. A marker failure rejects and
  // deliberately leaves the entries intact.
  if (_pendingUpdates.size > 0) {
    await _abandonPendingUpdates([..._pendingUpdates.values()], "manual_clear");
  }
  
  // Clear persisted storage
  await clearPersistedUpdates();
  
  // Clear timers
  if (_batchTimer) {
    clearTimeout(_batchTimer);
    _batchTimer = null;
  }

  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }

  if (_reconcileQuietTimer) {
    clearInterval(_reconcileQuietTimer);
    _reconcileQuietTimer = null;
  }

  // Reset processing flag
  _isProcessing = false;
  
  // Reset mutex
  _enqueueMutex = Promise.resolve();
  
  log("[TMDBG FTS] Pending updates cleared");
  return { ok: true };
}

// Exported for testing
export { _reconcileCleanupStaleEntries };

export const _testExports = {
  _getRetryConfig,
  _shouldDropFailedUpdates,
  _markResolveFailed,
  _resetNoProgressCounter,
  _incrementNoProgressCounter,
  // State accessors for test setup/teardown
  _getConsecutiveNoProgressCycles: () => _consecutiveNoProgressCycles,
  _setConsecutiveNoProgressCycles: (v) => { _consecutiveNoProgressCycles = v; },
  _getPendingUpdates: () => _pendingUpdates,
  _abandonPendingUpdates,
  _getFolderReconDirty: () => new Set(_folderReconDirty),
  // Quiet-period reconcile scheduler
  _scheduleReconcileWhenQuiet,
  runPostInitReconcile,
  _getLastSyncEventMs: () => _lastSyncEventMs,
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
  _getFolderReconNativeSupported: () => _folderReconNativeSupported,
  _resetFolderReconState: () => {
    _resetFtsOperationCoordinatorForTests();
    _folderReconNativeSupported = null;
    _folderReconDrainSkipped = new Set();
    _folderReconInProgressOwner = null;
    _folderReconUnverified = new Set();
    _folderReconBudgetOverride = null;
    _folderReconGeneration++;
    _cancelExclusiveMarkerRetry();
    if (_folderReconTimer) clearTimeout(_folderReconTimer);
    _folderReconTimer = null;
    _folderReconTimerToken++;
    _folderReconTimerDueMs = 0;
    _folderReconRequestedDueMs = Infinity;
    _folderReconHardNotBeforeMs = 0;
    _folderReconSchedulerOwner = null;
    _folderReconSessionDone = new Set();
    _folderReconSessionDeferred = new Map();
    _folderReconFailureCounts = new Map();
    _folderReconDrainFailureDeferred = new Map();
    _folderReconDrainFailureCounts = new Map();
    _folderReconDirty = new Set();
    _folderReconOrphanDone = false;
    _folderReconOrphanBasis = null;
    _reconMarkerPersisted = false;
    _reconMarkerClearInFlight = false;
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
  FOLDER_RECON_MISSING_PAGE_KEYS,
  FOLDER_RECON_RECHECKS_PER_SLICE,
  FOLDER_RECON_ENQUEUES_PER_SLICE,
  FOLDER_RECON_PENDING_HIGH_WATER,
  _getFolderReconWorkingProof,
  _admitFolderReconActiveProof,
  _invalidateFolderReconProofForEvent,
  _getFolderReconWorkingProofTelemetry: _folderReconWorkingProofTelemetry,
  _getFolderReconActiveProofKey: () => _folderReconActiveProof?.folderKey || null,
  _getFolderReconSessionDone: () => new Set(_folderReconSessionDone),
  _getFolderReconEphemeralEvidence: () => ({
    deferred: _folderReconSessionDeferred.size + _folderReconDrainFailureDeferred.size,
    failures: _folderReconFailureCounts.size + _folderReconDrainFailureCounts.size,
    orphanDone: _folderReconOrphanDone,
    hasOrphanBasis: _folderReconOrphanBasis !== null,
    dirty: [..._folderReconDirty].sort(),
  }),
  _setFolderReconEphemeralEvidenceForTests: ({
    folderKey,
    deferredAt,
    failureCount,
    orphanDone,
    orphanBasis,
  }) => {
    if (folderKey) {
      _folderReconSessionDeferred.set(folderKey, deferredAt);
      _folderReconFailureCounts.set(folderKey, failureCount);
    }
    _folderReconOrphanDone = orphanDone === true;
    _folderReconOrphanBasis = orphanBasis || null;
  },
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
