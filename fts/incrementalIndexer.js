// fts/incrementalIndexer.js
// Incremental FTS indexer that listens for mail events and updates the index automatically

import { SETTINGS } from "../agent/modules/config.js";
import { logFtsBatchOperation, logFtsOperation, logMessageEventBatch, logMoveEvent } from "../agent/modules/eventLogger.js";
import { log } from "../agent/modules/utils.js";
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
    // Maintenance scans will clean up any orphaned entries.
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
        // Log missed deletions for debugging - these will be cleaned up by maintenance
        log(`[TMDBG FTS] Removed ${removedCount}/${toDeleteUniqueKeys.length} messages - ${missedCount} may have stale folder keys (maintenance will cleanup)`);
        for (const update of toDeleteUpdates) {
          const parsed = parseUniqueId(update.uniqueKey);
          if (parsed?.headerID) {
            log(`[TMDBG FTS] Deletion may have missed: headerMessageId=${parsed.headerID}, key=${update.uniqueKey}`);
          }
        }
      } else {
        log(`[TMDBG FTS] Removed ${removedCount} messages from index`);
      }
      
      // Verify deletions - confirm messages are no longer in FTS
      let verifiedDeletes = 0;
      let deleteVerifyFailed = 0;
      for (const key of toDeleteUniqueKeys) {
        try {
          const ftsEntry = await _ftsSearch.getMessageByMsgId(key);
          if (!ftsEntry || ftsEntry.msgId !== key) {
            // Confirmed deleted or never existed - safe to dequeue
            processedKeys.add(key);
            verifiedDeletes++;
            logFtsOperation("verify_delete", "success", {
              uniqueKey: key,
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
          // Verification error - assume deleted (most errors mean not found)
          processedKeys.add(key);
          verifiedDeletes++;
          logFtsOperation("verify_delete", "success", {
            uniqueKey: key,
            note: "assumed_deleted_on_error",
          });
        }
      }
      
      // Log delete verification summary
      logFtsBatchOperation("verify_delete", "complete", {
        total: toDeleteUniqueKeys.length,
        successCount: verifiedDeletes,
        failCount: deleteVerifyFailed,
      });
      
      if (deleteVerifyFailed > 0) {
        log(`[TMDBG FTS] Delete verification: ${verifiedDeletes}/${toDeleteUniqueKeys.length} confirmed removed, ${deleteVerifyFailed} still present (retained in queue)`);
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
            
            // Step 5: Clean up any failed messages from the FTS index
            if (failedMsgIds.length > 0) {
              try {
                log(`[TMDBG FTS] Cleaning up ${failedMsgIds.length} failed incremental messages from FTS index`);
                await _ftsSearch.removeBatch(failedMsgIds);
                log(`[TMDBG FTS] Successfully cleaned up failed incremental messages from FTS index`);
              } catch (e) {
                log(`[TMDBG FTS] Failed to cleanup failed incremental messages from FTS index: ${e}`, "warn");
              }
              // Use queued key for deletion from _pendingUpdates
              for (const key of failedMsgIds) {
                processedKeys.add(msgIdToQueuedKey.get(key) || key);
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
  
  const { headerMessageId, weFolderId, folderPath, accountId, subject, eventType } = messageInfo;
  
  log(`[TMDBG FTS] Experiment msgAdded: type=${eventType}, folder=${folderPath}, subject="${subject?.substring(0, 50)}"`);
  
  // Build unique key from the info we have
  const uniqueKey = `${accountId}:${folderPath}:${headerMessageId}`;
  
  if (!uniqueKey || uniqueKey === '::') {
    log(`[TMDBG FTS] Experiment msgAdded: invalid key components, skipping`, "warn");
    return;
  }
  
  // Acquire mutex for atomic enqueue
  const { acquired, release } = acquireEnqueueMutex();
  
  try {
    await acquired;
    
    // Check for existing entry
    const existing = _pendingUpdates.get(uniqueKey);
    if (existing) {
      log(`[TMDBG FTS] Experiment msgAdded: ${uniqueKey} already queued (type=${existing.type}→new, age=${Date.now() - existing.timestamp}ms)`);
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
        eventType,
      }
    };
    
    _pendingUpdates.set(uniqueKey, update);
    log(`[TMDBG FTS] Queued new from experiment: ${uniqueKey} (${eventType}) (queue size: ${_pendingUpdates.size})`);
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

// Public API - DO NOT add duplicate listeners, integrate with existing ones
export async function initIncrementalIndexer(ftsSearch) {
  if (!ftsSearch) {
    throw new Error("FTS search engine required for incremental indexing");
  }
  
  _ftsSearch = ftsSearch;
  
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
}

export async function disposeIncrementalIndexer() {
  log("[TMDBG FTS] Disposing incremental indexer");
  
  _isEnabled = false;
  
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
  
  // Clear timers
  if (_batchTimer) {
    clearTimeout(_batchTimer);
    _batchTimer = null;
  }
  
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
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
  
  // Reset processing flag
  _isProcessing = false;
  
  // Reset mutex
  _enqueueMutex = Promise.resolve();
  
  log("[TMDBG FTS] Pending updates cleared");
  return { ok: true };
}
