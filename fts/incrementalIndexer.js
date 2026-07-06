/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fts/incrementalIndexer.js
// Incremental FTS indexer that listens for mail events and updates the index automatically

import { SETTINGS } from "../agent/modules/config.js";
import { logFtsBatchOperation, logFtsOperation, logMessageEventBatch, logMoveEvent } from "../agent/modules/eventLogger.js";
import { headerIDToWeID, log, parseUniqueId, recheckMessageInFolder } from "../agent/modules/utils.js";
import { buildBatchHeader, populateBatchBody } from "./indexer.js";

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
      
      for (const item of updatesArray) {
        // Only add if not already present (newly queued items take precedence)
        if (!_pendingUpdates.has(item.uniqueKey)) {
          _pendingUpdates.set(item.uniqueKey, {
            type: item.type,
            uniqueKey: item.uniqueKey,
            timestamp: item.timestamp,
            // Restore failure tracking
            hasFailed: item.hasFailed || false,
            lastFailedAt: item.lastFailedAt || 0,
            metadata: item.metadata || {}
          });
          restoredCount++;
        } else {
          skippedCount++;
        }
      }
      
      log(`[TMDBG FTS] Restored ${restoredCount} pending updates from storage (${skippedCount} already queued)`);
      
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
    const { getUniqueMessageKey } = await import("../../agent/modules/utils.js");
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
    _pendingUpdates.set(uniqueKey, { 
      type, 
      uniqueKey, 
      timestamp,
      // Preserve failure tracking from existing entry, or initialize
      hasFailed: existing?.hasFailed || false,
      lastFailedAt: existing?.lastFailedAt || 0,
      metadata: {
        subject: messageHeader.subject,
        folderName: messageHeader.folder?.name
      }
    });
    
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
    const { headerIDToWeID, parseUniqueId, getUniqueMessageKey } = await import("../../agent/modules/utils.js");
    
    const processedKeys = new Set();

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
            processedKeys.add(update.uniqueKey);
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
          // Nothing to index after building batch - treat as processed
          for (const entry of resolvedEntries) {
            processedKeys.add(entry.update.uniqueKey);
          }
        }
      } else {
        log(`[TMDBG FTS] No messages resolved from ${toIndexUpdates.length} uniqueKeys (may have been deleted)`);
      }
    }
    
    // Processing successful - remove processed updates from map
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
        
        let droppedStuckCount = 0;
        for (const [key, entry] of _pendingUpdates.entries()) {
          if (entry.hasFailed) {
            log(`[TMDBG FTS] Dropping stuck entry: ${key}`, "warn");
            logFtsOperation("drop", "stuck", {
              uniqueKey: key,
              headerMessageId: entry.metadata?.headerMessageId,
              subject: entry.metadata?.subject,
              reason: "queue_stuck",
              noProgressCycles: _consecutiveNoProgressCycles,
            });
            _pendingUpdates.delete(key);
            droppedStuckCount++;
          }
        }
        
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
  if (!_isEnabled) return;

  const { headerMessageId, folderPath, accountId, subject, eventType } = messageInfo;

  // Build unique key from the info we have
  const uniqueKey = `${accountId}:${folderPath}:${headerMessageId}`;

  if (!uniqueKey || uniqueKey === '::') {
    log(`[TMDBG FTS] Experiment enqueue: invalid key components, skipping`, "warn");
    return;
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
      metadata: {
        subject: subject?.substring(0, 100),
        folderName: folderPath,
        fromExperiment: true,
        fromCursorScan,
        eventType,
      }
    };

    _pendingUpdates.set(uniqueKey, update);
    log(`[TMDBG FTS] Queued new from ${fromCursorScan ? 'cursor scan' : 'experiment'}: ${uniqueKey} (${eventType}) (queue size: ${_pendingUpdates.size})`);
    scheduleBatchProcess();
    schedulePersist();
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

  const { headerMessageId, weFolderId, folderPath, accountId, eventType } = messageInfo;

  log(`[TMDBG FTS] Experiment msgRemoved: type=${eventType}, folder=${folderPath}, headerMessageId=${headerMessageId?.substring(0, 30)}`);
  
  // Build unique key from the info we have
  const uniqueKey = `${accountId}:${folderPath}:${headerMessageId}`;
  
  if (!uniqueKey || uniqueKey === '::') {
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
      metadata: {
        folderName: folderPath,
        fromExperiment: true,
        eventType,
      }
    };
    
    // Always update - deletion takes precedence
    _pendingUpdates.set(uniqueKey, update);
    log(`[TMDBG FTS] Queued deletion from experiment: ${uniqueKey} (queue size: ${_pendingUpdates.size})`);
    scheduleBatchProcess();
    schedulePersist();
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
// listener is registered, so messages arriving during that window are missed
// by the incremental indexer.  After listeners are up, we reconcile by
// enqueuing recent messages into the existing persistent queue — the drain
// loop handles FTS flakiness, retry, body extraction, and dedup via
// filterNewMessages (messages already in FTS are skipped automatically).
//
// Reconcile window is bounded by a persistent WATERMARK, not by the
// newest FTS date. See PLAN_RECONCILE_WATERMARK.md.
// =====================================================================

// Storage key for persisting reconcile-needed state across restarts
const RECONCILE_STORAGE_KEY = "fts_reconcile_pending";

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

// Quiet period before running reconcile — prevents races with TB's startup sync.
// During sync, messages.query can return inconsistent snapshots, causing Phase 2
// to mark valid entries as stale and remove them. We wait for no sync events
// for this duration before running reconcile.
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
async function _runCursorScan() {
  if (!_isEnabled) return { skipped: true, reason: "disabled" };
  if (!browser.tmMsgNotify || !_experimentListenersActive) {
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
    folders = await browser.tmMsgNotify.getCursorFolders();
  } catch (e) {
    log(`[FTS Cursor] getCursorFolders failed: ${e} — scan skipped, retry next boot`, "warn");
    logFtsBatchOperation("cursor_scan", "error", { error: String(e) });
    return { skipped: true, reason: "getCursorFolders_failed" };
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
      listed = await browser.tmMsgNotify.listKeysAboveKey(f.folderURI, sinceKey, CURSOR_FULL_SCAN_MAX_KEYS);
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
          await _enqueueNewFromInfo(info, true);
          folderEnqueued++;
        } catch (e) {
          folderEnqueueFailed++;
          log(`[FTS Cursor] Enqueue failed for ${folderKey}:${info?.headerMessageId}: ${e}`, "warn");
        }
      }
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
// Phase 1c: Evidence-triggered per-folder set reconcile (remove-side) —
// ADR-021, PLAN_FOLDER_SET_RECONCILE.md.
//
// The count invariant: with add-side completeness guaranteed (ADR-020 cursors
// + live events), FTS-per-folder ⊇ msgDB-per-folder. Therefore, per folder:
//   ftsCount > msgCount ⟹ stale (ghost) entries provably exist;
//   msgCount > ftsCount (folder drain-quiet) ⟹ missing adds;
//   counts equal ⟹ sets equal ⟹ zero work.
// No date windows, no periodic jobs — work proportional to drift, works for
// arbitrarily old emails. The fast stale-finder probes FTS keys against the
// msgDB's Message-ID hash index (probeMessageIds) — no msgDB enumeration.
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
// The count invariant needs add-side completeness — before the initial FULL
// scan has completed, every folder has a huge policy deficit and the missing
// direction would mass-enqueue the whole backlog through the incremental
// drain queue (whose persistence serializes the entire map per debounce).
// Gate the whole phase on the initial scan's completion flag (written by
// chat/background.js runInitialFtsScan).
const FOLDER_RECON_INITIAL_SCAN_KEY = "fts_initial_scan_complete";
// Missing-direction backfill (ADR-021 revision, replaces the old hard deficit
// cap): a folder with any deficit is swept SLOWLY via a resumable per-folder
// cursor (`missingBackfillKey` in the recon memo). Two separate per-run
// budgets bound the two very different costs:
//   - SCAN keys/run: cheap (msgDB read + native filter) — climb through the
//     folder to FIND missing entries.
//   - ENQUEUE msgs/run: expensive (each becomes a drain-queue getFull body
//     fetch over IMAP) — actually index them.
// The cursor climbs 0 → highWater ONCE per folder, then that folder is done
// (the add-side cursor scan owns everything after). This removes the reliance
// on the weekly maintenance scan for the add side. The initial-scan-completion
// gate above remains — it is the real "don't fight the first full index" guard.
const FOLDER_RECON_MISSING_SCAN_KEYS_PER_RUN = 10000;
// Yield between individual verify-then-remove rechecks. Each recheck is a
// GLOBAL messages.query (full-profile enumeration on the parent main thread)
// — running them back-to-back on a mature profile's ghost backlog saturates
// the UI. Mirrors RECONCILE_ENTRY_DELAY_MS in reconcile Phase 2.
const FOLDER_RECON_ENTRY_DELAY_MS = 10;
// Per-run work budgets (shared across ALL folders in one _runFolderReconcile
// invocation). A mature profile's FIRST reconcile can carry years of backlog:
// unbounded rechecks (global queries) and unbounded missing-heal enqueues
// (each becomes a drain-queue getFull body fetch) caused sustained main-thread
// lag. Budgeted folders are left WITHOUT a memo, so the backlog converges
// over successive boots instead of storming one.
const FOLDER_RECON_MAX_RECHECKS_PER_RUN = 200;
const FOLDER_RECON_MAX_MISSING_ENQUEUES_PER_RUN = 200;
// Max per-folder detail entries carried in the storage snapshot. Release
// builds suppress info AND warn logging (only errors print), so the snapshot
// is the ONLY way to identify WHICH folders were backfilling / truncated /
// failed / reconciled on a production install.
const FOLDER_RECON_SNAPSHOT_NOTABLE_MAX = 20;

// Feature detection for the native range RPCs (countMsgIdRange /
// listMsgIdRange, helper ≥ 0.10.0). null = not probed yet this session;
// false = old deployed helper → the whole phase no-ops (weekly scan remains
// that user's backstop); true = supported.
let _folderReconNativeSupported = null;
// Folders skipped by the drain-quiet gate this boot ("accountId:folderPath").
// Re-checked ONCE when the drain queue empties (_maybeScheduleFolderReconRerun).
let _folderReconDrainSkipped = new Set();
// Single-shot flag for the drain-empty re-run (per boot)
let _folderReconRerunDone = false;
// Mutual-exclusion guard: the boot pass and the drain-empty re-run both call
// _runFolderReconcile, and the re-run is scheduled from the drain timer, which
// can fire during the boot pass's awaits. Concurrent runs would race on the
// shared fts_folder_recon_memo (lost cursor updates — idempotent but wasteful).
// The re-run defers while this is set; the next drain-empty retries it.
let _folderReconInProgress = false;
// Test-only override for the per-run work budgets (null in production).
let _folderReconBudgetOverride = null;

/**
 * Half-open msgId key range covering exactly one folder's FTS keys.
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
 * One-time-per-session probe for the native range RPCs. An unknown-method /
 * RPC error marks the helper unsupported for the whole session and logs it
 * ONCE — old deployed helpers must degrade to today's behavior.
 */
async function _checkFolderReconNativeSupport(ftsSearch) {
  if (_folderReconNativeSupported !== null) return _folderReconNativeSupported;
  try {
    await ftsSearch.countMsgIdRange("", FOLDER_RECON_KEYSPACE_END);
    _folderReconNativeSupported = true;
  } catch (e) {
    _folderReconNativeSupported = false;
    log(`[FTS FolderRecon] Native helper lacks range RPCs (${e}) — folder reconcile disabled this session (weekly scan remains the backstop)`, "warn");
    logFtsBatchOperation("folder_recon", "unsupported", { error: String(e) });
    _writeReconSnapshot("fts_folder_recon_last", { skipped: true, reason: "native_unsupported", error: String(e) });
  }
  return _folderReconNativeSupported;
}

/**
 * Read the per-folder clean-count memo:
 * { version: 1, folders: { "<acct>:<path>": { lastCleanMsgCount,
 *   lastCleanFtsCount, updatedAtMs } } }.
 * Independent of the watermark AND the cursor store (separate storage key).
 */
async function _getFolderReconMemo() {
  try {
    const stored = await browser.storage.local.get(FOLDER_RECON_STORAGE_KEY);
    const m = stored?.[FOLDER_RECON_STORAGE_KEY];
    if (m && m.folders && typeof m.folders === "object") return m;
  } catch (e) {
    log(`[FTS FolderRecon] Memo read failed: ${e}`, "warn");
  }
  return { version: 1, folders: {} };
}

async function _writeFolderReconMemo(memo) {
  try {
    await browser.storage.local.set({ [FOLDER_RECON_STORAGE_KEY]: memo });
  } catch (e) {
    // Non-fatal: next boot re-derives the counts (wider work, same result).
    log(`[FTS FolderRecon] Memo write failed: ${e}`, "warn");
  }
}

/**
 * Stale direction (ftsCount > msgCount): page the folder's FTS keys
 * (listMsgIdRange), probe each page's headerMessageIds against the msgDB
 * hash index (probeMessageIds) — misses are CANDIDATES ONLY — then confirm
 * every candidate with the ADR-017 verify-then-remove recheck before a
 * single removeBatch + per-key verify. Never removes on uncertainty.
 *
 * @returns {{clean: boolean, budgetPartial: boolean}} clean = zero errors and
 *   not budget-truncated (memo may be written); budgetPartial = the per-run
 *   recheck budget cut the pass short (no memo — remainder next boot).
 */
async function _folderReconStaleDirection(ftsSearch, f, startKey, endKey, stats, budget) {
  const folderPrefix = `${f.accountId}:${f.folderPath}:`;
  const weFolder = { accountId: f.accountId, path: f.folderPath };

  // 1) Collect stale candidates by probing FTS keys against the msgDB.
  const candidates = [];
  let budgetTruncated = false;
  let afterKey = null;
  for (;;) {
    let res;
    try {
      res = await ftsSearch.listMsgIdRange(startKey, endKey, afterKey, FOLDER_RECON_KEYS_CHUNK);
    } catch (e) {
      logFtsOperation("folder_recon", "list_error", { folderPath: f.folderPath, error: String(e) });
      return { clean: false, budgetPartial: false };
    }
    const msgIds = res.msgIds || [];
    if (msgIds.length === 0) break;

    // Every key in [P, P[:-1]+';') starts with the folder prefix exactly, so
    // a plain prefix strip yields the headerMessageId. (parseUniqueId would
    // mis-split folder paths containing ':' — the range already scopes the
    // keys to this folder, making the strip exact.)
    const headerIds = msgIds.map((msgId) => msgId.slice(folderPrefix.length));

    let probe;
    try {
      probe = await browser.tmMsgNotify.probeMessageIds(f.folderURI, headerIds);
    } catch (e) {
      probe = { missing: [], error: String(e) };
    }
    if (probe.error) {
      logFtsOperation("folder_recon", "probe_error", { folderPath: f.folderPath, error: probe.error });
      return { clean: false, budgetPartial: false };
    }
    for (const missId of probe.missing || []) {
      candidates.push({ msgId: folderPrefix + missId, headerID: missId });
    }
    stats.staleCandidates += (probe.missing || []).length;

    // Per-run recheck budget: stop nominating once this run's allowance is
    // reached — each candidate costs a GLOBAL messages.query. The remainder
    // is picked up next boot (no memo is written for a truncated pass).
    if (candidates.length >= budget.rechecks) {
      budgetTruncated = true;
      candidates.length = Math.max(budget.rechecks, 0);
      log(`[FTS FolderRecon] ${f.folderPath}: recheck budget reached (${FOLDER_RECON_MAX_RECHECKS_PER_RUN}/run) — processing ${candidates.length} candidates now, remainder next boot`, "warn");
      logFtsOperation("folder_recon", "recheck_budget_truncated", {
        folderPath: f.folderPath,
        processedNow: candidates.length,
      });
      break;
    }

    afterKey = msgIds[msgIds.length - 1];
    if (res.done) break;
    if (FOLDER_RECON_CHUNK_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, FOLDER_RECON_CHUNK_DELAY_MS));
    }
  }

  // 2) Verify-then-remove (ADR-017): absent → remove list; present/error →
  //    keep. Same pattern as reconcile Phase 2 incl. the stats() keepalive.
  const entriesToRemove = [];
  let recheckedCount = 0;
  let hadRecheckError = false;
  for (const cand of candidates) {
    if (recheckedCount > 0 && recheckedCount % FOLDER_RECON_RECHECK_KEEPALIVE_EVERY === 0) {
      try {
        await ftsSearch.stats();
      } catch (keepaliveErr) {
        log(`[FTS FolderRecon] Recheck keepalive ping failed: ${keepaliveErr.message}`, "warn");
      }
    }
    recheckedCount++;
    budget.rechecks--;

    const verdict = await recheckMessageInFolder(cand.headerID, weFolder);
    if (verdict === "absent") {
      entriesToRemove.push(cand.msgId);
    } else if (verdict === "present") {
      stats.recheckKeptPresent++;
      log(`[FTS FolderRecon] Recheck found ${cand.msgId} still present — keeping (transient probe miss)`);
      logFtsOperation("folder_recon", "recheck_present", { msgId: cand.msgId });
    } else {
      stats.recheckKeptError++;
      hadRecheckError = true;
      log(`[FTS FolderRecon] Recheck errored for ${cand.msgId} — keeping (unconfirmed)`, "warn");
      logFtsOperation("folder_recon", "recheck_error", { msgId: cand.msgId });
    }

    // Each recheck is a global query on the parent main thread — yield so
    // the UI stays responsive through a backlog (mirrors Phase 2's
    // RECONCILE_ENTRY_DELAY_MS).
    if (FOLDER_RECON_ENTRY_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, FOLDER_RECON_ENTRY_DELAY_MS));
    }
  }

  // 3) Single removeBatch + per-key verify (drain-loop delete posture).
  if (entriesToRemove.length > 0) {
    try {
      await ftsSearch.removeBatch(entriesToRemove);
    } catch (e) {
      log(`[FTS FolderRecon] removeBatch failed for ${f.folderPath}: ${e}`, "warn");
      logFtsOperation("folder_recon", "remove_error", { folderPath: f.folderPath, error: String(e) });
      return { clean: false, budgetPartial: false };
    }
    for (const msgId of entriesToRemove) {
      try {
        const entry = await ftsSearch.getMessageByMsgId(msgId);
        if (entry && entry.msgId === msgId) {
          log(`[FTS FolderRecon] REMOVE VERIFY FAILED: ${msgId} still in FTS`, "warn");
          logFtsOperation("folder_recon", "remove_verify_failed", { msgId });
          return { clean: false, budgetPartial: false }; // coverage unproven — no memo
        }
        stats.staleRemoved++;
        logFtsOperation("folder_recon", "stale_removed", { msgId });
      } catch (e) {
        logFtsOperation("folder_recon", "remove_verify_error", { msgId, error: String(e) });
        return { clean: false, budgetPartial: false };
      }
    }
  }

  // An errored recheck (unverified entry left in place) or a budget
  // truncation (unexamined candidates remain) means the pass was not clean —
  // the memo must not mask either (retried/continued next boot).
  return { clean: !hadRecheckError && !budgetTruncated, budgetPartial: budgetTruncated };
}

/**
 * Missing direction (msgCount > ftsCount): walk the folder's msgDB keys with
 * the existing experiment pair (listKeysAboveKey / getMessageInfosForKeys —
 * both work for non-IMAP folders; no UID semantics needed, only headers),
 * filter against FTS (filterNewMessages reads only msgId) and enqueue the
 * reported-new ones through the shared drain path. Heals drop-stuck losses.
 * Evidence-gated, chunk-yielded, loudly logged.
 *
 * RESUMABLE (ADR-021 revision): sweeps msgDB keys ASCENDING starting from the
 * folder's persisted `missingBackfillKey` (0 first time), advancing the cursor
 * PER KEY so a mid-sweep budget stop never skips an un-enqueued key. Bounded by
 * two shared per-run budgets — `budget.scans` (cheap: keys examined) and
 * `budget.enqueues` (expensive: getFull body fetches). The cursor climbs to
 * highWater once, then the folder is done; the add-side cursor scan owns
 * everything after. Replaces the old hard deficit cap so we never rely on the
 * weekly scan for the add side.
 *
 * @param {number} sinceKey - Resume cursor (highest msgKey already swept).
 * @returns {{clean, budgetPartial, cursor, reachedEnd}} clean/reachedEnd = swept
 *   to the top of the folder this run (memo may be written); budgetPartial =
 *   a budget cut the sweep short (persist cursor, resume next boot).
 */
async function _folderReconMissingDirection(ftsSearch, f, stats, budget, sinceKey) {
  let cursor = Number.isFinite(sinceKey) ? sinceKey : 0;

  // All msgDB keys ABOVE the resume cursor, ascending. Transfer is an int
  // array bounded by keys-above-cursor (shrinks as the cursor climbs). A
  // dedicated low-paged experiment call is a future optimization if very large
  // folders with very large deficits ever appear (they can't pre-initial-scan
  // — that whole state is gated above).
  let listed;
  try {
    listed = await browser.tmMsgNotify.listKeysAboveKey(f.folderURI, cursor, 0);
  } catch (e) {
    listed = { keys: [], error: String(e) };
  }
  if (listed.error) {
    logFtsOperation("folder_recon", "list_keys_error", { folderPath: f.folderPath, error: listed.error });
    return { clean: false, budgetPartial: false, cursor, reachedEnd: false };
  }
  const allKeys = listed.keys || [];
  if (allKeys.length === 0) {
    return { clean: true, budgetPartial: false, cursor, reachedEnd: true };
  }

  let idx = 0;
  let stoppedForBudget = false;

  while (idx < allKeys.length) {
    if (budget.scans <= 0) { stoppedForBudget = true; break; }
    const chunk = allKeys.slice(idx, idx + FOLDER_RECON_KEYS_CHUNK);

    let res;
    try {
      res = await browser.tmMsgNotify.getMessageInfosForKeys(f.folderURI, chunk);
    } catch (e) {
      res = { infos: [], error: String(e) };
    }
    if (res.error) {
      logFtsOperation("folder_recon", "infos_error", { folderPath: f.folderPath, error: res.error });
      return { clean: false, budgetPartial: false, cursor, reachedEnd: false };
    }

    // Map msgKey → info (verified: getMessageInfosForKeys carries msgKey) and
    // build rows for filterNewMessages (native reads only msgId).
    const infoByKey = new Map();
    const rows = [];
    for (const info of res.infos || []) {
      if (!info?.headerMessageId || !info.accountId || !info.folderPath) continue;
      if (typeof info.msgKey === "number") infoByKey.set(info.msgKey, info);
      rows.push({ msgId: `${info.accountId}:${info.folderPath}:${info.headerMessageId}` });
    }

    let newIds = new Set();
    if (rows.length > 0) {
      let filterResult;
      try {
        filterResult = await ftsSearch.filterNewMessages(rows);
      } catch (e) {
        logFtsOperation("folder_recon", "filter_error", { folderPath: f.folderPath, error: String(e) });
        return { clean: false, budgetPartial: false, cursor, reachedEnd: false };
      }
      newIds = new Set(filterResult.newMsgIds || []);
    }

    // Advance the cursor PER KEY (ascending). A key that can't derive a key or
    // is already indexed is examined-and-skipped; a new one is enqueued (or, if
    // the enqueue budget is spent, we STOP before it so it stays above cursor).
    let chunkDone = 0;
    for (const key of chunk) {
      const info = infoByKey.get(key);
      if (info) {
        const msgId = `${info.accountId}:${info.folderPath}:${info.headerMessageId}`;
        if (newIds.has(msgId)) {
          if (budget.enqueues <= 0) { stoppedForBudget = true; break; }
          try {
            await _enqueueNewFromInfo(info, true);
          } catch (e) {
            logFtsOperation("folder_recon", "enqueue_error", { msgId, error: String(e) });
            return { clean: false, budgetPartial: false, cursor, reachedEnd: false };
          }
          budget.enqueues--;
          stats.missingEnqueued++;
          logFtsOperation("folder_recon", "missing_enqueued", { msgId, folderPath: f.folderPath });
        }
      }
      cursor = key;          // fully processed → cursor may pass it
      budget.scans--;
      chunkDone++;
      if (budget.scans <= 0) { stoppedForBudget = true; break; }
    }
    idx += chunkDone;
    if (stoppedForBudget) break;

    if (FOLDER_RECON_CHUNK_DELAY_MS > 0 && idx < allKeys.length) {
      await new Promise(r => setTimeout(r, FOLDER_RECON_CHUNK_DELAY_MS));
    }
  }

  const reachedEnd = idx >= allKeys.length && !stoppedForBudget;
  if (stoppedForBudget) {
    log(`[FTS FolderRecon] ${f.folderPath}: backfill budget reached — cursor at ${cursor}, resumes next boot`, "warn");
    logFtsOperation("folder_recon", "missing_budget_truncated", { folderPath: f.folderPath, cursor });
  }
  return { clean: reachedEnd, budgetPartial: !reachedEnd, cursor, reachedEnd };
}

/**
 * Independent existing-folder key set ("accountId:path") from the
 * WebExtension API — the orphan sweep's second confirmation source for
 * "this folder is truly absent from TB".
 */
async function _listAllWeFolderKeys() {
  const out = new Set();
  const accounts = await browser.accounts.list(true);
  const walk = (accountId, folder) => {
    if (!folder) return;
    if (folder.path) out.add(`${accountId}:${folder.path}`);
    for (const sub of folder.subFolders || []) {
      walk(accountId, sub);
    }
  };
  for (const acct of accounts || []) {
    walk(acct.id, acct.rootFolder);
  }
  return out;
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
async function _folderReconOrphanSweep(ftsSearch, knownFolderKeys, totalKnownFtsCount, stats, budget) {
  // The sweep's per-key rechecks share the run's global-query budget.
  if (budget.rechecks <= 0) {
    log(`[FTS FolderRecon] Orphan sweep deferred — recheck budget exhausted this run`, "warn");
    return;
  }
  const totalAll = (await ftsSearch.countMsgIdRange("", FOLDER_RECON_KEYSPACE_END)).count;
  // Backfill enqueues may have been INDEXED by the drain mid-loop (during the
  // per-folder yields), inflating totalAll above the per-folder ftsCounts that
  // were summed earlier this run — by at most stats.missingEnqueued. Tolerate
  // that slack so a backfill boot doesn't false-trigger a wasteful full-keyspace
  // walk that removes nothing. A genuine orphan exceeds the slack AND persists
  // to a quieter boot (missingEnqueued≈0), where it is caught.
  const slack = stats.missingEnqueued || 0;
  if (!(totalAll > totalKnownFtsCount + slack)) return;

  log(`[FTS FolderRecon] Orphan sweep: totalAll=${totalAll} > totalKnown=${totalKnownFtsCount}+${slack} — walking keyspace`, "warn");

  let weFolderKeys;
  try {
    weFolderKeys = await _listAllWeFolderKeys();
  } catch (e) {
    log(`[FTS FolderRecon] Orphan sweep: accounts walk failed (${e}) — sweep skipped this boot`, "warn");
    return;
  }

  const knownPrefixes = [...knownFolderKeys].map(k => `${k}:`);
  const wePrefixes = [...weFolderKeys].map(k => `${k}:`);

  // Walk the full keyspace and collect keys no existing folder owns.
  const orphanKeys = [];
  let afterKey = null;
  for (;;) {
    const res = await ftsSearch.listMsgIdRange("", FOLDER_RECON_KEYSPACE_END, afterKey, FOLDER_RECON_KEYS_CHUNK);
    const msgIds = res.msgIds || [];
    if (msgIds.length === 0) break;

    for (const msgId of msgIds) {
      // Fast path: the derived "accountId:folderPath" of well-formed keys.
      const parsed = parseUniqueId(msgId);
      const derivedKey = parsed ? `${parsed.weFolder.accountId}:${parsed.weFolder.path}` : null;
      if (derivedKey && knownFolderKeys.has(derivedKey)) continue;
      // Slow path: folder paths containing ':' make the derived split wrong —
      // a key is owned iff SOME existing folder's "acct:path:" prefixes it.
      if (knownPrefixes.some(p => msgId.startsWith(p)) || wePrefixes.some(p => msgId.startsWith(p))) {
        stats.orphanKeysKept++;
        log(`[FTS FolderRecon] Orphan candidate's folder exists (parse edge) — keeping: ${msgId}`);
        logFtsOperation("folder_recon", "orphan_kept_folder_exists", { msgId });
        continue;
      }
      orphanKeys.push(msgId);
    }

    afterKey = msgIds[msgIds.length - 1];
    if (res.done) break;
    if (FOLDER_RECON_CHUNK_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, FOLDER_RECON_CHUNK_DELAY_MS));
    }
  }
  if (orphanKeys.length === 0) return;

  // Verify-then-remove: even for an orphaned prefix, only a SUCCESSFUL
  // global query confirming the message is not at the key's folder may
  // remove it (ADR-017 — never remove on uncertainty).
  const entriesToRemove = [];
  let recheckedCount = 0;
  for (const msgId of orphanKeys) {
    if (recheckedCount > 0 && recheckedCount % FOLDER_RECON_RECHECK_KEEPALIVE_EVERY === 0) {
      try {
        await ftsSearch.stats();
      } catch (keepaliveErr) {
        log(`[FTS FolderRecon] Orphan recheck keepalive ping failed: ${keepaliveErr.message}`, "warn");
      }
    }
    recheckedCount++;

    // Shared per-run budget: stop rechecking (keep remaining keys) once
    // spent — count evidence re-fires the sweep next boot.
    if (budget.rechecks <= 0) {
      stats.orphanKeysKept += orphanKeys.length - recheckedCount + 1;
      log(`[FTS FolderRecon] Orphan sweep budget-truncated — ${orphanKeys.length - recheckedCount + 1} keys deferred to next boot`, "warn");
      logFtsOperation("folder_recon", "orphan_budget_truncated", { deferred: orphanKeys.length - recheckedCount + 1 });
      break;
    }
    budget.rechecks--;

    const parsed = parseUniqueId(msgId);
    if (!parsed) {
      stats.orphanKeysKept++;
      logFtsOperation("folder_recon", "orphan_kept_unparseable", { msgId });
      continue;
    }
    const verdict = await recheckMessageInFolder(parsed.headerID, parsed.weFolder);
    if (verdict === "absent") {
      entriesToRemove.push(msgId);
    } else {
      stats.orphanKeysKept++;
      logFtsOperation("folder_recon", "orphan_kept_recheck", { msgId, verdict });
    }
    if (FOLDER_RECON_ENTRY_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, FOLDER_RECON_ENTRY_DELAY_MS));
    }
  }
  if (entriesToRemove.length === 0) return;

  await ftsSearch.removeBatch(entriesToRemove); // throw → caller's catch logs
  for (const msgId of entriesToRemove) {
    stats.orphanRemoved++;
    log(`[FTS FolderRecon] Orphaned-prefix key removed: ${msgId}`, "warn");
    logFtsOperation("folder_recon", "orphan_removed", { msgId });
  }
}

/**
 * Phase 1c: evidence-triggered per-folder set reconcile (ADR-021,
 * PLAN_FOLDER_SET_RECONCILE.md). Runs after the cursor scan inside
 * runPostInitReconcile, in its own try/catch — independent of the watermark
 * AND the cursor store. Skips cleanly when the experiment API or the native
 * range RPCs are unavailable.
 *
 * @param {Object} ftsSearch - FTS search interface
 * @param {Set<string>|null} [onlyFolderKeys] - Restrict to these
 *   "accountId:folderPath" keys (the drain-empty re-run). The orphan sweep
 *   only runs on the unrestricted boot pass.
 */
async function _runFolderReconcile(ftsSearch, onlyFolderKeys = null) {
  if (!_isEnabled || !ftsSearch) return { skipped: true, reason: "disabled" };
  if (!browser.tmMsgNotify
      || typeof browser.tmMsgNotify.getFolderCounts !== "function"
      || typeof browser.tmMsgNotify.probeMessageIds !== "function") {
    log(`[FTS FolderRecon] Skipped — experiment API unavailable`);
    return { skipped: true, reason: "no_experiment" };
  }
  if (!(await _checkFolderReconNativeSupport(ftsSearch))) {
    return { skipped: true, reason: "native_unsupported" };
  }

  // Add-side completeness gate: before the initial FULL scan finishes, every
  // folder carries a huge policy deficit — the invariant does not hold yet
  // and the missing direction would mass-enqueue the initial scan's backlog
  // through the wrong pipeline. Skip the phase; the initial scan owns
  // coverage until its completion flag is set.
  try {
    const scanFlag = await browser.storage.local.get(FOLDER_RECON_INITIAL_SCAN_KEY);
    if (!scanFlag?.[FOLDER_RECON_INITIAL_SCAN_KEY]) {
      log(`[FTS FolderRecon] Skipped — initial FTS scan not yet complete (invariant needs add-side completeness)`);
      logFtsBatchOperation("folder_recon", "skipped_initial_scan_incomplete", {});
      _writeReconSnapshot("fts_folder_recon_last", { skipped: true, reason: "initial_scan_incomplete" });
      return { skipped: true, reason: "initial_scan_incomplete" };
    }
  } catch (e) {
    log(`[FTS FolderRecon] Initial-scan flag read failed: ${e} — skipped this boot`, "warn");
    return { skipped: true, reason: "initial_scan_flag_read_failed" };
  }

  _folderReconInProgress = true;
  try {
  const reconStart = Date.now();
  const stats = {
    foldersTotal: 0,
    foldersErrored: 0,
    foldersDrainBusy: 0,
    foldersMemoHit: 0,
    foldersClean: 0,       // counts equal on arrival — zero work
    foldersReconciled: 0,  // a direction pass ran and completed cleanly
    foldersFailed: 0,      // a direction pass errored — no memo, retry next boot
    foldersBudgetPartial: 0, // per-run work budget cut the folder's pass short — continued next boot
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
    folders = await browser.tmMsgNotify.getFolderCounts();
  } catch (e) {
    log(`[FTS FolderRecon] getFolderCounts failed: ${e} — skipped, retry next boot`, "warn");
    logFtsBatchOperation("folder_recon", "error", { error: String(e) });
    return { skipped: true, reason: "getFolderCounts_failed" };
  }

  logFtsBatchOperation("folder_recon", "start", {
    foldersReported: folders?.length || 0,
    rerun: !!onlyFolderKeys,
  });

  const memo = await _getFolderReconMemo();
  let memoChanged = false;
  // Per-run work budgets shared across all folders (and the orphan sweep):
  // bound the boot's total global-recheck queries and drain-queue heals so a
  // mature profile's first-run backlog converges over boots instead of
  // storming the main thread (rechecks) and IMAP (getFull body fetches).
  // Per-folder detail for the storage snapshot (bounded) — identifies WHICH
  // folders did something interesting, since release builds log errors only.
  const notable = [];
  const budget = {
    rechecks: FOLDER_RECON_MAX_RECHECKS_PER_RUN,
    enqueues: FOLDER_RECON_MAX_MISSING_ENQUEUES_PER_RUN,
    scans: FOLDER_RECON_MISSING_SCAN_KEYS_PER_RUN,
    ...(_folderReconBudgetOverride || {}),
  };
  // Every folder TB reported — even errored/gated ones — EXISTS; its keys
  // are never orphans. (The orphan sweep's known set must be complete.)
  const knownFolderKeys = new Set();
  let totalKnownFtsCount = 0;
  // The orphan sweep's count evidence is only sound when every folder's
  // ftsCount actually entered the sum.
  let allFoldersCounted = true;

  for (const f of folders || []) {
    stats.foldersTotal++;
    const folderKey = `${f.accountId}:${f.folderPath}`;
    if (f.accountId || f.folderPath) knownFolderKeys.add(folderKey);

    // Re-run scope: only the drain-skipped folders.
    if (onlyFolderKeys && !onlyFolderKeys.has(folderKey)) {
      allFoldersCounted = false;
      continue;
    }

    // 1) Folder errored → skip (retry next boot).
    if (f.error || !f.folderURI || !Number.isFinite(f.totalMessages)) {
      stats.foldersErrored++;
      allFoldersCounted = false;
      logFtsOperation("folder_recon", "folder_error", {
        folderPath: f.folderPath,
        error: f.error || "bad_folder_entry",
      });
      continue;
    }

    // 2) Drain-quiet gate: pending updates for this folder mean its counts
    //    are in flux — skip this boot, re-check on drain-empty.
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
      allFoldersCounted = false;
      _folderReconDrainSkipped.add(folderKey);
      continue;
    }

    // 3) The count comparison — the entire evidence check.
    const { startKey, endKey } = _folderKeyRange(f.accountId, f.folderPath);
    let ftsCount;
    try {
      ftsCount = (await ftsSearch.countMsgIdRange(startKey, endKey)).count;
    } catch (e) {
      stats.foldersFailed++;
      allFoldersCounted = false;
      logFtsOperation("folder_recon", "count_error", { folderPath: f.folderPath, error: String(e) });
      continue;
    }
    totalKnownFtsCount += ftsCount;
    const msgCount = f.totalMessages;

    // 4) Memo hit → zero work. Also absorbs permanent per-folder bias
    //    (unindexable no-key messages) without rescanning every boot.
    const m = memo.folders[folderKey];
    if (m && m.lastCleanMsgCount === msgCount && m.lastCleanFtsCount === ftsCount) {
      stats.foldersMemoHit++;
      continue;
    }

    // Counts equal ⟹ sets equal (superset invariant) ⟹ zero work; memoize.
    if (ftsCount === msgCount) {
      memo.folders[folderKey] = {
        lastCleanMsgCount: msgCount,
        lastCleanFtsCount: ftsCount,
        updatedAtMs: Date.now(),
      };
      memoChanged = true;
      stats.foldersClean++;
      continue;
    }

    // Budget pre-check: nothing left for this direction this run — leave the
    // folder un-memoized (counts are cheap to re-check next boot). Missing
    // needs BOTH the scan budget (climb) and enqueue budget (heal).
    const needsStale = ftsCount > msgCount;
    if ((needsStale && budget.rechecks <= 0)
        || (!needsStale && (budget.enqueues <= 0 || budget.scans <= 0))) {
      stats.foldersBudgetPartial++;
      notable.push({ folder: folderKey, kind: "budget_skipped", msgCount, ftsCount });
      logFtsOperation("folder_recon", "budget_exhausted_skip", { folderPath: f.folderPath });
      continue;
    }

    // 5/6) Count mismatch — folder-scoped set diff in the indicated direction.
    log(`[FTS FolderRecon] ${folderKey}: ftsCount=${ftsCount} msgCount=${msgCount} — running ${needsStale ? "stale" : "missing (backfill)"} direction`, "warn");
    let pass;
    if (needsStale) {
      pass = await _folderReconStaleDirection(ftsSearch, f, startKey, endKey, stats, budget);
    } else {
      const resumeKey = memo.folders[folderKey]?.missingBackfillKey;
      pass = await _folderReconMissingDirection(ftsSearch, f, stats, budget, resumeKey);
      // Persist backfill progress whenever the cursor ADVANCED (partial or
      // complete), so it survives to next boot. An immediate error with no
      // progress (cursor unchanged) writes nothing. Keep count-pair fields.
      if (Number.isFinite(pass.cursor) && pass.cursor > (resumeKey || 0)) {
        memo.folders[folderKey] = {
          ...(memo.folders[folderKey] || {}),
          missingBackfillKey: pass.cursor,
          updatedAtMs: Date.now(),
        };
        memoChanged = true;
      }
    }

    if (pass.budgetPartial) {
      stats.foldersBudgetPartial++;
      const note = { folder: folderKey, kind: needsStale ? "budget_truncated" : "backfilling", msgCount, ftsCount };
      if (!needsStale) note.cursor = pass.cursor; // stale has no cursor
      notable.push(note);
      log(`[FTS FolderRecon] ${folderKey}: pass budget-truncated — count-memo NOT written, continues next boot`, "warn");
    } else if (!pass.clean) {
      stats.foldersFailed++;
      notable.push({ folder: folderKey, kind: "failed", msgCount, ftsCount });
      log(`[FTS FolderRecon] ${folderKey}: pass had errors — memo NOT written, retry next boot`, "warn");
    } else {
      // 7) Clean pass (stale confirmed / backfill reached the top): recount and
      // memoize the (msgCount, ftsCount-now) pair. For backfill, ftsNow is
      // still pre-drain (enqueued not yet indexed) — next boot's count movement
      // re-checks; if drops leave a residual it stabilizes as a memo-hit.
      try {
        const ftsNow = (await ftsSearch.countMsgIdRange(startKey, endKey)).count;
        memo.folders[folderKey] = {
          ...(memo.folders[folderKey] || {}),
          lastCleanMsgCount: msgCount,
          lastCleanFtsCount: ftsNow,
          updatedAtMs: Date.now(),
        };
        memoChanged = true;
        stats.foldersReconciled++;
        notable.push({ folder: folderKey, kind: "reconciled", msgCount, ftsCount, ftsCountAfter: ftsNow });
      } catch (e) {
        stats.foldersFailed++;
        logFtsOperation("folder_recon", "recount_error", { folderPath: f.folderPath, error: String(e) });
      }
    }

    // 8) Yield between folders.
    if (FOLDER_RECON_CHUNK_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, FOLDER_RECON_CHUNK_DELAY_MS));
    }
  }

  // Orphaned-prefix sweep — boot pass only, and only when every reported
  // folder's ftsCount entered the sum (otherwise totalAll > totalKnown is
  // vacuously true and the full-keyspace walk would fire without evidence).
  if (!onlyFolderKeys && allFoldersCounted) {
    try {
      await _folderReconOrphanSweep(ftsSearch, knownFolderKeys, totalKnownFtsCount, stats, budget);
    } catch (e) {
      log(`[FTS FolderRecon] Orphan sweep failed: ${e} — retried next boot`, "warn");
      logFtsOperation("folder_recon", "orphan_sweep_error", { error: String(e) });
    }
  }

  if (memoChanged) {
    await _writeFolderReconMemo(memo);
  }

  const elapsed = Date.now() - reconStart;
  log(`[FTS FolderRecon] Complete: ${stats.foldersTotal} folders (${stats.foldersMemoHit} memo-hit, ${stats.foldersClean} clean, ${stats.foldersReconciled} reconciled, ${stats.foldersDrainBusy} drain-busy, ${stats.foldersErrored} errored, ${stats.foldersFailed} failed, ${stats.foldersBudgetPartial} budget-partial), ${stats.staleRemoved} stale removed (${stats.staleCandidates} candidates, ${stats.recheckKeptPresent} present, ${stats.recheckKeptError} recheck-errors), ${stats.missingEnqueued} missing enqueued, ${stats.orphanRemoved} orphans removed, ${elapsed}ms`);
  logFtsBatchOperation("folder_recon", "complete", { ...stats, rerun: !!onlyFolderKeys, elapsedMs: elapsed });
  // Boot pass and drain-empty re-run get SEPARATE snapshot keys so the
  // re-run doesn't overwrite the boot pass's outcome.
  _writeReconSnapshot(onlyFolderKeys ? "fts_folder_recon_last_rerun" : "fts_folder_recon_last", {
    ...stats,
    rerun: !!onlyFolderKeys,
    elapsedMs: elapsed,
    notable: notable.slice(0, FOLDER_RECON_SNAPSHOT_NOTABLE_MAX),
  });

  return stats;
  } finally {
    _folderReconInProgress = false;
  }
}

/**
 * Drain-empty re-run: called by processPendingUpdates when the queue hits
 * zero. Re-runs the folder reconcile ONCE per boot for exactly the folders
 * the boot pass skipped as drain-busy. Fire-and-forget (never blocks the
 * drain loop); returns the promise for tests.
 */
function _maybeScheduleFolderReconRerun() {
  if (_folderReconRerunDone) return undefined;
  if (_folderReconDrainSkipped.size === 0) return undefined;
  if (!_isEnabled || !_ftsSearch) return undefined;
  // Defer while a reconcile pass is running (usually the boot pass, whose
  // backfill enqueues are what emptied the queue). Do NOT consume the
  // single-shot flag — the next drain-empty re-attempts once the pass ends.
  if (_folderReconInProgress) return undefined;

  _folderReconRerunDone = true; // single-shot per boot
  const only = new Set(_folderReconDrainSkipped);
  _folderReconDrainSkipped.clear();
  const ftsSearch = _ftsSearch;

  log(`[FTS FolderRecon] Drain empty — re-running folder reconcile for ${only.size} skipped folder(s)`);
  return Promise.resolve()
    .then(() => _runFolderReconcile(ftsSearch, only))
    .catch(e => {
      log(`[FTS FolderRecon] Drain-empty re-run failed: ${e}`, "warn");
      logFtsBatchOperation("folder_recon", "error", { error: String(e), rerun: true });
    });
}

/**
 * Run post-init reconciliation: discover recent messages across all folders
 * and enqueue any that might be missing into the existing persistent queue.
 *
 * Phase 1: Enqueue current TB messages as 'new' — the drain loop handles
 *          FTS dedup via filterNewMessages (already-indexed messages are skipped).
 *
 * Phase 1b: Per-folder msgKey/UID cursor scan (ADR-020) — enqueue everything
 *          above each folder's persisted cursor, regardless of Date header.
 *          Catches boot-gap arrivals whose Dates predate the Phase 1 window.
 *
 * Phase 1c: Evidence-triggered per-folder set reconcile (ADR-021) — the
 *          count invariant (ftsCount vs msgCount) detects drift per folder;
 *          only mismatched folders get a folder-scoped set diff.
 *
 * Phase 2: Query FTS entries in the same window and remove any whose messages
 *          no longer exist in TB at their indexed folder. This cleans up stale
 *          entries left by moves/deletes that happened during the boot gap.
 */
async function runPostInitReconcile(ftsSearch) {
  if (!_isEnabled) return;

  const reconcileStart = Date.now();

  // Determine the lower bound from the persistent watermark (or 7d fallback).
  // Captured once, used by both phases — no FTS query, no retry loop.
  const reconcileFrom = await _getReconcileFrom();

  let totalScanned = 0;
  let totalEnqueued = 0;
  // Thrown enqueue failures (transient: storage/mutex/key-derivation errors).
  // Any such message was NOT handed to the persistent drain queue, so the
  // watermark must not advance past it — next boot's reconcile retries.
  // (queueMessageUpdate's silent no-unique-key return is deliberately NOT
  // counted: a message that cannot derive a key can never be stored in the
  // key-addressed FTS, so blocking the watermark on it would pin the window
  // forever for an unindexable message.)
  let enqueueFailed = 0;

  logFtsBatchOperation("reconcile", "start", {
    reconcileFrom: new Date(reconcileFrom).toISOString(),
  });

  try {
    // =========================================================================
    // PHASE 1: Enqueue current TB messages as 'new'
    // =========================================================================
    // Single cross-account query by date — much faster than folder-by-folder walking.
    // messages.query with fromDate only uses the local header DB (no IMAP, no body fetch).
    let page = await browser.messages.query({ fromDate: new Date(reconcileFrom) });

    // Drain every continuation page (same pattern as recheckMessageInFolder):
    // a page's emptiness says nothing about completeness — only a null
    // continuation id ends the walk. Stopping on an empty page would silently
    // drop the rest of the boot-gap messages while the watermark advances.
    while (page) {
      for (const msg of (page.messages || [])) {
        totalScanned++;
        try {
          await queueMessageUpdate('new', msg);
          totalEnqueued++;
        } catch (queueErr) {
          enqueueFailed++;
          log(`[TMDBG FTS] Reconcile: failed to enqueue msg ${msg.headerMessageId}: ${queueErr}`, "warn");
        }
      }
      if (!page.id) break;
      page = await browser.messages.continueList(page.id);
    }
    if (!page) {
      // Nullish page (initial query or mid-drain) is an API contract
      // violation — the walk did NOT complete, so coverage must not be
      // claimed. Throw into the outer catch: watermark withheld, pending
      // flag stays set (fail closed, same as recheckMessageInFolder).
      throw new Error("Reconcile Phase 1: message walk returned a nullish page");
    }

    logFtsBatchOperation("reconcile_phase1", "complete", {
      totalScanned,
      totalEnqueued,
      enqueueFailed,
    });

    log(`[FTS Reconcile] Phase 1 complete: ${totalScanned} scanned, ${totalEnqueued} enqueued, ${enqueueFailed} enqueue failures`);

    // =========================================================================
    // PHASE 1b: Per-folder msgKey/UID cursor scan (ADR-020)
    // =========================================================================
    // Arrival-ordered complement to the Date-keyed Phase 1: catches messages
    // that entered the local msgDB while nothing was listening, regardless of
    // their Date header. Independent of the watermark — a cursor-scan failure
    // must not block the watermark advance (per-folder cursors self-retry on
    // the next boot), and vice versa.
    try {
      await _runCursorScan();
    } catch (cursorErr) {
      log(`[FTS Cursor] Scan failed: ${cursorErr} — folder cursors not advanced, retry next boot`, "warn");
      logFtsBatchOperation("cursor_scan", "error", { error: String(cursorErr) });
    }

    // =========================================================================
    // PHASE 1c: Evidence-triggered per-folder set reconcile (ADR-021)
    // =========================================================================
    // Count-invariant drift detection (PLAN_FOLDER_SET_RECONCILE.md): per
    // folder, ftsCount vs msgCount; mismatches get a folder-scoped set diff
    // (verify-then-remove stale side / filterNewMessages+enqueue missing
    // side). Independent of the watermark AND the cursor store — its own
    // storage key, per-folder retry; failures must not block the watermark.
    try {
      await _runFolderReconcile(ftsSearch);
    } catch (folderReconErr) {
      log(`[FTS FolderRecon] Failed: ${folderReconErr} — retried next boot`, "warn");
      logFtsBatchOperation("folder_recon", "error", { error: String(folderReconErr) });
    }

    // =========================================================================
    // PHASE 2: Remove stale FTS entries for moved/deleted messages
    // =========================================================================
    // Query FTS entries in the same date window and validate each against TB.
    // If the message no longer exists at its indexed folder, remove from FTS.
    const cleanupResult = await _reconcileCleanupStaleEntries(ftsSearch, reconcileFrom);

    // Clear the persisted reconcile-needed flag on success
    await browser.storage.local.remove(RECONCILE_STORAGE_KEY);

    // Watermark advance — only on clean completion. accountsSkipped > 0
    // means some FTS entries weren't actually re-verified (their accounts
    // were unavailable at scan time); removeFailed means confirmed-stale
    // entries are still sitting in FTS; enqueueFailed > 0 means boot-gap
    // messages never reached the persistent drain queue. In every case we
    // must not claim coverage — next boot recomputes from the older
    // watermark → retry. (Once a message IS enqueued, the drain queue's own
    // persistence + retry guarantees take over; nothing is dropped there.)
    const accountsSkipped = cleanupResult.accountsSkipped || 0;
    const removeFailed = !!cleanupResult.removeFailed;
    const watermarkAdvanced = accountsSkipped === 0 && !removeFailed && enqueueFailed === 0;
    if (watermarkAdvanced) {
      await _writeWatermark(reconcileFrom);
      _startWatermarkHeartbeat();
    } else {
      log(`[FTS Reconcile] Watermark NOT advanced — ${accountsSkipped} account(s) unavailable, removeFailed=${removeFailed}, enqueueFailed=${enqueueFailed}`, "warn");
    }

    const elapsed = Date.now() - reconcileStart;
    log(`[FTS Reconcile] Complete: ${totalScanned} scanned, ${totalEnqueued} enqueued, ${cleanupResult.removed} stale removed (${cleanupResult.checked} checked, ${accountsSkipped} accounts skipped), ${elapsed}ms`);

    logFtsBatchOperation("reconcile", "complete", {
      totalScanned,
      totalEnqueued,
      enqueueFailed,
      staleChecked: cleanupResult.checked,
      staleRemoved: cleanupResult.removed,
      accountsSkipped,
      removeFailed,
      watermarkAdvanced,
      elapsedMs: elapsed,
    });
  } catch (e) {
    log(`[TMDBG FTS] Reconcile failed: ${e}`, "error");
    logFtsBatchOperation("reconcile", "error", {
      error: String(e),
      totalScanned,
      totalEnqueued,
    });
    // Exception path: do NOT write watermark, do NOT start heartbeat.
    // Next boot will recompute from the older watermark.
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
  // Fresh session for the folder reconcile too: re-probe native support
  // (the helper may have been updated), forget drain-skip state, and allow
  // one drain-empty re-run this boot.
  _folderReconNativeSupported = null;
  _folderReconDrainSkipped = new Set();
  _folderReconRerunDone = false;
  _folderReconInProgress = false;

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
  await browser.storage.local.set({ [RECONCILE_STORAGE_KEY]: Date.now() });

  // Schedule post-init reconciliation to run after TB's startup sync settles.
  // During active sync, messages.query can return inconsistent snapshots,
  // causing Phase 2 to mark valid entries as stale and remove them. We wait
  // for a quiet period (no msgAdded/msgRemoved events for RECONCILE_QUIET_PERIOD_MS)
  // before running reconcile. Listeners are already active, so any new events
  // during the wait are caught by the incremental indexer normally.
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
  try {
    const stored = await browser.storage.local.get(RECONCILE_STORAGE_KEY);
    return !!stored?.[RECONCILE_STORAGE_KEY];
  } catch (_) {
    return false;
  }
}

export async function disposeIncrementalIndexer() {
  log("[TMDBG FTS] Disposing incremental indexer");

  _isEnabled = false;
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
  await updateIncrementalSettings();
  
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

// Get current status
export function getIncrementalIndexerStatus() {
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
    }
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
  
  // Clear in-memory map
  _pendingUpdates.clear();
  
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
  _maybeScheduleFolderReconRerun,
  _getFolderReconDrainSkipped: () => _folderReconDrainSkipped,
  _getFolderReconNativeSupported: () => _folderReconNativeSupported,
  _resetFolderReconState: () => {
    _folderReconNativeSupported = null;
    _folderReconDrainSkipped = new Set();
    _folderReconRerunDone = false;
    _folderReconInProgress = false;
    _folderReconBudgetOverride = null;
  },
  _setFolderReconBudgetOverride: (v) => { _folderReconBudgetOverride = v; },
  _setFolderReconInProgress: (v) => { _folderReconInProgress = v; },
  FOLDER_RECON_STORAGE_KEY,
  FOLDER_RECON_KEYS_CHUNK,
  FOLDER_RECON_CHUNK_DELAY_MS,
  FOLDER_RECON_RECHECK_KEEPALIVE_EVERY,
  FOLDER_RECON_KEYSPACE_END,
  FOLDER_RECON_INITIAL_SCAN_KEY,
  FOLDER_RECON_MISSING_SCAN_KEYS_PER_RUN,
  FOLDER_RECON_ENTRY_DELAY_MS,
  FOLDER_RECON_MAX_RECHECKS_PER_RUN,
  FOLDER_RECON_MAX_MISSING_ENQUEUES_PER_RUN,
  _hasWatermarkHeartbeatTimer: () => _watermarkHeartbeatTimer !== null,
  _setIndexerDisposed: (v) => { _indexerDisposed = v; },
  _getIndexerDisposed: () => _indexerDisposed,
  // Allow tests to set _experimentListenersActive / _isEnabled / _ftsSearch directly
  _setExperimentListenersActive: (v) => { _experimentListenersActive = v; },
  _setIsEnabled: (v) => { _isEnabled = v; },
  _setFtsSearch: (v) => { _ftsSearch = v; },
  WATERMARK_KEY,
  HEARTBEAT_INTERVAL_MS,
  RECONCILE_OVERLAP_MS,
  RECONCILE_FALLBACK_WINDOW_MS,
};
