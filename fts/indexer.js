// fts/indexer.js
// Throttled indexer with backpressure, checkpoints, and pause/resume capability

import { getAllFoldersForAccount } from "../agent/modules/folderUtils.js";
import { getInboxForAccount } from "../agent/modules/inboxContext.js";
import { sanitizeMessageTags } from "../agent/modules/onMoved.js";
import { log, safeGetFull } from "../agent/modules/utils.js";
import { extractIcsFromParts, formatIcsAttachmentsAsString } from "../chat/modules/icsParser.js";
import { extractPlainText } from "./bodyExtract.js";

// Load FTS settings from storage
async function getFtsSettings() {
  const stored = await browser.storage.local.get({
    chat_ftsBatchSize: 250,
    chat_ftsMaxInflight: 1,
    chat_ftsSleepBetweenBatchMs: 250,
    chat_ftsLongYieldMs: 1000,
    chat_ftsMaxBatchBytes: 8388608,
  });
  return {
    ftsBatchSize: stored.chat_ftsBatchSize,
    ftsMaxInflight: stored.chat_ftsMaxInflight,
    ftsSleepBetweenBatchMs: stored.chat_ftsSleepBetweenBatchMs,
    ftsLongYieldMs: stored.chat_ftsLongYieldMs,
    ftsMaxBatchBytes: stored.chat_ftsMaxBatchBytes,
  };
}

// Dynamic settings - loaded when needed
let BATCH_SIZE = 250;
let MAX_INFLIGHT = 1;
let SLEEP_BETWEEN_BATCH_MS = 250;
let LONG_YIELD_MS = 1000;
let MAX_BATCH_BYTES = 8388608;

// Update settings from storage
async function updateSettings() {
  const settings = await getFtsSettings();
  BATCH_SIZE = settings.ftsBatchSize;
  MAX_INFLIGHT = settings.ftsMaxInflight;
  SLEEP_BETWEEN_BATCH_MS = settings.ftsSleepBetweenBatchMs;
  LONG_YIELD_MS = settings.ftsLongYieldMs;
  MAX_BATCH_BYTES = settings.ftsMaxBatchBytes;
  log(`[TMDBG FTS] Settings updated: batch=${BATCH_SIZE}, sleep=${SLEEP_BETWEEN_BATCH_MS}ms`);
}

let paused = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function* iterAllFolders() {
  const accounts = await browser.accounts.list();
  log(`[TMDBG FTS] Found ${accounts.length} accounts`);
  
  for (const acct of accounts) {
    log(`[TMDBG FTS] Processing account: ${acct.name} (id: ${acct.id})`);
    
    if (!acct.rootFolder) {
      log(`[TMDBG FTS] Account has no root folder. Skipping.`);
      continue;
    }

    try {
      // Use shared helper for manual folder traversal (recursive=true doesn't work for Gmail [Gmail] children)
      const allFolders = await getAllFoldersForAccount(acct.id);
      
      log(`[TMDBG FTS] Found ${allFolders.length} total folders for account ${acct.name}`);
      
      for (const f of allFolders) {
        log(`[TMDBG FTS] Checking folder: ${f.name} (type: ${f.type}, path: ${f.path})`);
        
        // Yield folders that can contain messages - be permissive since types might be undefined
        // Skip only the root folder, index everything else that has a real path
        if (f.path && f.path !== "/" && f.name && f.name !== "Root") {
          log(`[TMDBG FTS] ✅ Yielding folder: ${f.name} (type: ${f.type || 'undefined'}, path: ${f.path})`);
          yield { accountId: acct.id, folder: f };
        } else {
          log(`[TMDBG FTS] ❌ Skipping folder: ${f.name} (type: ${f.type || 'undefined'}, path: ${f.path || 'no-path'})`);
        }
      }
    } catch (e) {
      log(`[TMDBG FTS] Error traversing folders for account ${acct.name}: ${e}`, "error");
    }
  }
}

// Checkpoint keys
function ck(accountId, folder) {
  return `fts_ckp:${accountId}:${folder.path || folder.name || folder.id}`;
}

async function getCheckpoint(key) {
  const obj = await browser.storage.local.get(key);
  return obj[key] || null;
}
async function setCheckpoint(key, val) {
  await browser.storage.local.set({ [key]: val });
}

export async function pauseIndexer() { 
  paused = true; 
  log("[TMDBG FTS] Indexer paused");
  return { ok: true, paused }; 
}
export async function resumeIndexer() { 
  paused = false; 
  log("[TMDBG FTS] Indexer resumed");
  return { ok: true, paused }; 
}

// Build batch with only headers (no expensive body extraction)
export async function buildBatchHeader(messages) {
  const { getUniqueMessageKey } = await import("../../agent/modules/utils.js");

  const BATCH_LIMIT = BATCH_SIZE;        // assumes you've set these elsewhere
  const BYTES_LIMIT = MAX_BATCH_BYTES;

  const seen = new Set();                // msgId -> seen
  const rows = [];
  let bytes = 0;

  for (const m of messages) {
    // 1) Stable id
    const msgIdRaw = await getUniqueMessageKey(m);
    const msgId = msgIdRaw ? String(msgIdRaw) : "";
    if (!msgId || seen.has(msgId)) continue;      // skip missing or duplicate

    // 2) Build lightweight header row
    const row = {
      msgId,                              // accountId:folderPath:headerID
      subject: m.subject || "",
      from_: (m.author || ""),
      to_: (m.recipients || []).join(", "),
      cc: (m.ccList || []).join(", "),
      bcc: "",                            // TB API doesn't expose easily
      body: "",                           // filled later
      dateMs: m.date ? +new Date(m.date) : 0,
      hasAttachments: !!m.hasAttachments,
      parsedIcsAttachments: "",           // filled later
      _originalMessage: m,                // keep for body extraction (not sent to worker)
    };

    // 3) Account bytes *before* accepting
    const approx = row.subject.length + row.from_.length + row.to_.length + row.cc.length;
    if ((rows.length + 1) > BATCH_LIMIT || (bytes + approx) > BYTES_LIMIT) break;

    rows.push(row);
    seen.add(msgId);
    bytes += approx;
  }

  return rows;
}

// Populate body text for messages that need indexing (all messages in the batch)
export async function populateBatchBody(rows) {
  const successfulRows = [];
  const failedMsgIds = [];
  const failedDetails = [];
  
  for (const row of rows) {
    try {
      // Extract body text for all messages in the batch (they all need indexing)
      // Use safeGetFull to benefit from in-memory cache + FTS lookup before expensive IMAP fetch
      const full = await safeGetFull(row._originalMessage.id);
      if (full?.__tmSynthetic) {
        // FTS already has this body as plain text — use directly, skip MIME extraction
        row.body = full.body || "";
        row.parsedIcsAttachments = "";
      } else {
        const body = await extractPlainText(full, row._originalMessage.id);
        row.body = body || "";

        // Extract and parse ICS attachments for needed messages
        const icsAttachments = await extractIcsFromParts(full, row._originalMessage.id);
        const parsedIcsAttachments = formatIcsAttachmentsAsString(icsAttachments);
        row.parsedIcsAttachments = parsedIcsAttachments || "";
      }

      // Clean up reference to original message
      delete row._originalMessage;
      
      // Add to successful rows
      successfulRows.push(row);
    } catch (e) {
      // Handle corrupted or inaccessible messages
      const msgId = row._originalMessage.id;
      const folderName = row._originalMessage.folder?.name || 'unknown folder';
      const subject = (row._originalMessage.subject || 'no subject').slice(0, 50);
      
      log(`[TMDBG FTS] Failed to read message ${msgId} in folder '${folderName}': ${e.message}`, "error");
      log(`[TMDBG FTS] Message details: subject='${subject}', folder='${folderName}'`, "error");
      log(`[TMDBG FTS] Suggestion: Right-click folder '${folderName}' → Properties → Repair Folder to fix corrupted messages`, "error");
      
      // Add to failed list for cleanup
      failedMsgIds.push(row.msgId);
      failedDetails.push({
        msgId: row.msgId,
        subject: row.subject || "",
        dateMs: row.dateMs || 0,
        folderName,
      });
    }
  }

  log(`[TMDBG FTS] Extracted body text for ${successfulRows.length} messages, ${failedMsgIds.length} failed`);
  return { successfulRows, failedMsgIds, failedDetails };
}

async function* pagedMessages(folder, afterId) {
  // Fetch messages in chunks; sort by date ascending; resume after checkpoint (if any)
  // Note: Thunderbird webext API doesn't support server-side pagination strongly;
  // we use messages.list with queries per folder.
  
  // Skip only root folders - be permissive since types are often undefined
  if (!folder || !folder.path || folder.path === "/" || folder.name === "Root") {
    log(`[TMDBG FTS] Skipping non-mail folder: ${folder?.name || 'unknown'} (type: ${folder?.type}, path: ${folder?.path})`);
    return;
  }
  
  // Paginate through ALL messages (like scanAllInboxes does)
  let page = await browser.messages.list(folder.id);
  let allMessages = [];
  
  // Gather all message headers from all pages
  while (page && page.messages && page.messages.length > 0) {
    allMessages.push(...page.messages);
    if (page.id) {
      page = await browser.messages.continueList(page.id);
    } else {
      break;
    }
  }
  
  log(`[TMDBG FTS] Folder ${folder.name} has ${allMessages.length} messages (after pagination)`);
  allMessages.sort((a, b) => (new Date(a.date)) - (new Date(b.date)));
  
  let startIdx = 0;
  if (afterId) {
    startIdx = Math.max(0, allMessages.findIndex(x => x.id === afterId) + 1);
  }
  
  for (let i = startIdx; i < allMessages.length; i += BATCH_SIZE) {
    yield allMessages.slice(i, Math.min(i + BATCH_SIZE * 2, allMessages.length)); // give builder some room
  }
}

/**
 * Index messages with optional date range filtering
 * @param {Object} ftsSearch - FTS search interface
 * @param {Function} progressCb - Progress callback function
 * @param {Date} startDate - Optional start date for filtering (null = no date filtering)
 * @param {Date} endDate - Optional end date for filtering (null = no date filtering)
 */
export async function indexMessages(ftsSearch, progressCb = () => {}, startDate = null, endDate = null, options = null) {
  const collectDetails = !!options?.collectDetails;
  const maxDetailEntries = Number(options?.maxDetailEntries);
  const detailLimit = Number.isFinite(maxDetailEntries) && maxDetailEntries > 0 ? maxDetailEntries : 0;

  const isDateRange = startDate && endDate;
  const logPrefix = isDateRange ? 'Date range' : 'Full';
  
  if (isDateRange) {
    log(`[TMDBG FTS] Starting optimized ${logPrefix.toLowerCase()} reindex: ${startDate.toISOString()} to ${endDate.toISOString()}`);
  } else {
    log(`[TMDBG FTS] Starting optimized ${logPrefix.toLowerCase()} reindex (always checks existence)`);
  }
  
  const startTime = Date.now();
  const startMs = isDateRange ? startDate.getTime() : null;
  const endMs = isDateRange ? endDate.getTime() : null;
  
  // Load current settings from storage
  await updateSettings();
  
  // Pre-scan: Log all accounts and folders that will be indexed
  log(`[TMDBG FTS] ========== PRE-SCAN: Enumerating all folders ==========`);
  const accounts = await browser.accounts.list();
  log(`[TMDBG FTS] Found ${accounts.length} accounts total`);
  for (const acct of accounts) {
    log(`[TMDBG FTS] Account: "${acct.name}" (id: ${acct.id}, type: ${acct.type})`);
    if (acct.rootFolder) {
      try {
        // Use recursive=true first to see what TB returns
        const subFoldersRecursive = await browser.folders.getSubFolders(acct.rootFolder.id, true);
        log(`[TMDBG FTS]   → getSubFolders(recursive=true) returned ${subFoldersRecursive.length} folders: ${subFoldersRecursive.map(f => f.path).join(', ')}`);
        
        // Also check immediate children to compare
        const subFoldersImmediate = await browser.folders.getSubFolders(acct.rootFolder.id, false);
        log(`[TMDBG FTS]   → getSubFolders(recursive=false) returned ${subFoldersImmediate.length} folders: ${subFoldersImmediate.map(f => f.path).join(', ')}`);
        
        // Check if any of those folders have children
        for (const folder of subFoldersImmediate) {
          try {
            const children = await browser.folders.getSubFolders(folder.id, false);
            if (children && children.length > 0) {
              log(`[TMDBG FTS]     → ${folder.path} has ${children.length} children: ${children.map(f => f.name).join(', ')}`);
            }
          } catch (e) {
            log(`[TMDBG FTS]     → ${folder.path} error checking children: ${e.message}`, "warn");
          }
        }
      } catch (e) {
        log(`[TMDBG FTS]   → ERROR getting subfolders: ${e.message}`, "error");
      }
    } else {
      log(`[TMDBG FTS]   → No rootFolder!`, "warn");
    }
  }
  log(`[TMDBG FTS] ========== END PRE-SCAN ==========`);
  
  // NOTE:
  // - "scanned" counts messages examined (including already-indexed messages).
  // - "newlyIndexed" counts messages that were actually inserted/updated in the FTS index.
  let totalScanned = 0;
  let newlyIndexed = 0;
  let skipped = 0;
  let totalBatches = 0;

  // Optional per-message correction details (bounded).
  // Used by maintenance runs to show exactly what got "fixed" (indexed/removed).
  const correctionDetails = [];
  function pushCorrectionDetail(item) {
    if (!collectDetails || detailLimit <= 0) return;
    if (correctionDetails.length >= detailLimit) return;
    correctionDetails.push(item);
  }
  
  // Cache inbox folder IDs per account for sanitization
  const inboxCache = new Map();
  async function getInboxIds(accountId) {
    if (inboxCache.has(accountId)) return inboxCache.get(accountId);
    try {
      const inbox = await getInboxForAccount(accountId);
      const ids = inbox?.id ? [inbox.id] : [];
      inboxCache.set(accountId, ids);
      return ids;
    } catch (_) {
      inboxCache.set(accountId, []);
      return [];
    }
  }
  
  let sanitizedTotal = 0;
  
  for await (const { accountId, folder } of iterAllFolders()) {
    if (paused) await waitUntilResumed();
    
    log(`[TMDBG FTS] ${logPrefix} scan of folder: ${folder.name} (account: ${accountId})`);
    
    // Use checkpoints for full reindex, but not for date range scans
    let lastProcessedId = null;
    if (!isDateRange) {
      const key = ck(accountId, folder);
      let ckpt = await getCheckpoint(key); // { lastId }
      lastProcessedId = ckpt?.lastId || null;
      log(`[TMDBG FTS] Processing folder: ${folder.name} (account: ${accountId}) checkpoint: ${lastProcessedId} (type: ${typeof lastProcessedId})`);
    }

    let folderIndexed = 0;
    let folderBatches = 0;

    for await (const page of pagedMessages(folder, lastProcessedId)) {
      if (paused) await waitUntilResumed();

      // Step 1: Build header-only batch (no expensive body extraction)
      const headerBatch = await buildBatchHeader(page);
      if (headerBatch.length === 0) continue;

      // Step 1.5: Sanitize stale TabMail action tags (integrated cleanup during FTS scan)
      // This uses the original page messages (raw headers), not the headerBatch (processed for FTS)
      try {
        const inboxIds = await getInboxIds(accountId);
        for (const msg of page) {
          const result = await sanitizeMessageTags(msg, folder, { inboxFolderIds: inboxIds });
          if (result.stripped) sanitizedTotal++;
        }
      } catch (eSanitize) {
        log(`[TMDBG FTS] Sanitization error in ${folder.name}: ${eSanitize}`, "info");
      }

      // Step 2: Apply date filtering if specified
      let filteredBatch = headerBatch;
      if (isDateRange) {
        filteredBatch = headerBatch.filter(m => {
          const msgDate = m.dateMs || 0;
          return msgDate >= startMs && msgDate <= endMs;
        });
        
        if (filteredBatch.length === 0) {
          log(`[TMDBG FTS] Skipping batch - no messages in date range ${startDate.toDateString()} to ${endDate.toDateString()}`);
          continue;
        }
        
        log(`[TMDBG FTS] Processing ${logPrefix.toLowerCase()} batch: ${filteredBatch.length} messages (${headerBatch.length - filteredBatch.length} filtered out)`);
      }

      // Step 3: Filter to find messages that need indexing
      const filterResult = await ftsSearch.filterNewMessages(filteredBatch);
      const newMsgIds = filterResult.newMsgIds || [];
      
      log(`[TMDBG FTS] Filtered ${newMsgIds.length} new messages out of ${filteredBatch.length} total in ${folder.name}`);
      
      if (newMsgIds.length === 0) {
        // All messages already indexed, just update progress
        folderIndexed += filteredBatch.length;
        folderBatches += 1;
        totalScanned += filteredBatch.length;
        totalBatches += 1;
        skipped += filteredBatch.length;
        
        if (!isDateRange) {
          lastProcessedId = filteredBatch[filteredBatch.length - 1].msgId;
          
          // Save checkpoint
          const key = ck(accountId, folder);
          log(`[TMDBG FTS] Setting checkpoint: lastProcessedId=${lastProcessedId} (type: ${typeof lastProcessedId})`);
          await setCheckpoint(key, { lastId: lastProcessedId });
        }
        
        // Report progress
        progressCb({ 
          folder: folder.name, 
          folderIndexed,
          folderBatches,
          totalIndexed: totalScanned,
          totalBatches,
          ...(isDateRange && { dateRange: { start: startDate, end: endDate } })
        });
        
        await sleep(SLEEP_BETWEEN_BATCH_MS);
        continue;
      }

      // Step 4: Create filtered batch with only messages that need indexing
      const newFilteredBatch = filteredBatch.filter(row => newMsgIds.includes(row.msgId));
      
      // Step 5: Extract body text for the filtered messages
      log(`[TMDBG FTS] ${logPrefix} extracting body text for ${newFilteredBatch.length} messages in ${folder.name}`);
      const { successfulRows, failedMsgIds, failedDetails } = await populateBatchBody(newFilteredBatch);
      
      // Step 6: Clean up any failed messages from the FTS index (they may have been partially indexed)
      if (failedMsgIds.length > 0) {
        try {
          log(`[TMDBG FTS] Cleaning up ${failedMsgIds.length} failed messages from FTS index`);
          await ftsSearch.removeBatch(failedMsgIds);
          log(`[TMDBG FTS] Successfully cleaned up failed messages from FTS index`);
        } catch (e) {
          log(`[TMDBG FTS] Failed to cleanup failed messages from FTS index: ${e}`, "warn");
        }
        // Record per-message removals for debugging (these are corrections).
        if (Array.isArray(failedDetails) && failedDetails.length > 0) {
          for (const fd of failedDetails) {
            pushCorrectionDetail({
              action: "removedFailedRead",
              msgId: fd.msgId,
              subject: fd.subject || "",
              dateMs: fd.dateMs || 0,
              folderName: fd.folderName || folder.name || "",
              folderPath: folder.path || "",
            });
          }
        } else {
          for (const msgId of failedMsgIds) {
            pushCorrectionDetail({
              action: "removedFailedRead",
              msgId,
              subject: "",
              dateMs: 0,
              folderName: folder.name || "",
              folderPath: folder.path || "",
            });
          }
        }
      }
      
      // Step 7: Index the successful messages
      if (successfulRows.length > 0) {
        try {
          log(`[TMDBG FTS] ${logPrefix} indexing batch in ${folder.name}: ${successfulRows.length} messages`);
          const result = await ftsSearch.indexBatch(successfulRows);
          const dupeInfo = result.skippedDuplicates > 0 ? `, ${result.skippedDuplicates} duplicates skipped` : '';
          log(`[TMDBG FTS] ${logPrefix} indexed batch in ${folder.name}: ${result.count} new messages${dupeInfo}`);
          newlyIndexed += result?.count || 0;
          // Record which messages we actually indexed (bounded).
          for (const row of successfulRows) {
            pushCorrectionDetail({
              action: "indexed",
              msgId: row.msgId,
              subject: row.subject || "",
              dateMs: row.dateMs || 0,
              folderName: folder.name || "",
              folderPath: folder.path || "",
            });
          }
        } catch (e) {
          log(`[TMDBG FTS] Failed to index ${logPrefix.toLowerCase()} batch in ${folder.name}: ${e}`, "error");
          throw e;
        }
      } else {
        log(`[TMDBG FTS] No successful messages to index in ${folder.name} (all ${newFilteredBatch.length} failed)`);
      }
      
      // Update skipped count to include failed messages
      skipped += (filteredBatch.length - newMsgIds.length) + failedMsgIds.length;

      folderIndexed += filteredBatch.length;
      folderBatches += 1;
      totalScanned += filteredBatch.length;
      totalBatches += 1;
      
      if (!isDateRange) {
        lastProcessedId = filteredBatch[filteredBatch.length - 1].msgId;
        
        // Save checkpoint
        const key = ck(accountId, folder);
        log(`[TMDBG FTS] Setting checkpoint: lastProcessedId=${lastProcessedId} (type: ${typeof lastProcessedId})`);
        await setCheckpoint(key, { lastId: lastProcessedId });
      }

      // Report progress
      progressCb({ 
        folder: folder.name, 
        folderIndexed,
        folderBatches,
        totalIndexed: totalScanned,
        totalBatches,
        ...(isDateRange && { dateRange: { start: startDate, end: endDate } })
      });

      await sleep(SLEEP_BETWEEN_BATCH_MS);
    }

    // Longer yield between folders
    await sleep(LONG_YIELD_MS);
  }
  
  const duration = Date.now() - startTime;
  log(`[TMDBG FTS] Optimized ${logPrefix.toLowerCase()} reindex completed in ${isDateRange ? duration + 'ms: ' : ''}${totalScanned} messages scanned in ${totalBatches} batches, ${newlyIndexed} newly indexed, ${skipped} skipped, ${sanitizedTotal} stale tags sanitized`);
  
  return { 
    ok: true, 
    // Back-compat: historically "indexed" was used to mean "processed".
    // Keep it as "scanned" to avoid breaking existing call-sites.
    indexed: totalScanned,
    scanned: totalScanned,
    newlyIndexed,
    batches: totalBatches,
    sanitized: sanitizedTotal, 
    skipped,
    ...(collectDetails && { correctionDetails }),
    ...(isDateRange && { duration })
  };
}


async function waitUntilResumed() {
  while (paused) {
    log("[TMDBG FTS] Indexer is paused, waiting...");
    await sleep(300);
  }
}
