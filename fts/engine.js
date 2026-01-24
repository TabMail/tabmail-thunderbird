// fts/engine.js
// FTS Engine - NOW USES NATIVE HELPER (not worker.js)
// Single entrypoint for FTS operations using native messaging

import { SETTINGS } from "../agent/modules/config.js";
import { log } from "../agent/modules/utils.js";
import { initNativeFts, nativeFtsSearch } from "./nativeEngine.js";

let _inited = false;
let _runtimeMessageHandler = null;

const FTS_ENGINE_DIAG = {
  missLogMax: SETTINGS.ftsEngineDiag?.missLogMax,
  missLogMinIntervalMs: SETTINGS.ftsEngineDiag?.missLogMinIntervalMs,
};

const FTS_ENGINE_DIAG_STATE = {
  missLogs: 0,
  missLastMs: 0,
  hostInfoEmptyLogs: 0,
  hostInfoEmptyLastMs: 0,
};

// Command interface for runtime messaging
function attachCommandInterface() {
  const onMsg = (msg, _sender, sendResponse) => {
    if (msg && msg.type === "fts") {
      console.log(`[FTS Engine] Processing FTS command: ${msg.cmd}`);
      
      // Handle async commands using sendResponse pattern (NOT async listener!)
      (async () => {
        try {
          switch (msg.cmd) {
            case "search": {
              const { q, from, to, limit, ignoreDate } = msg;
              const result = await ftsSearch.searchMessagesQuery(q, from, to, limit, ignoreDate);
              console.log(`[FTS Engine] Search completed, returning ${Array.isArray(result) ? result.length : 'non-array'} results`);
              sendResponse(result);
              return;
            }
            case "reindexAll": {
              await ftsSearch.clearIndex();
              await ftsSearch.clearCheckpoints();
              
              // Mark version as indexed immediately when clearing DB
              // This clears the "reindex required" warning right away
              await nativeFtsSearch.markVersionAsIndexed();
              log("[TMDBG FTS] Marked current host version as indexed (reindex started)");
              
              // Set scan status to show indexing is in progress
              await browser.storage.local.set({
                "fts_initial_scan_complete": false,
                "fts_scan_status": {
                  isScanning: true,
                  scanType: "reindex",
                  startTime: Date.now()
                }
              });
              
              const { indexMessages } = await import("./indexer.js");
              
              // Progress callback that updates both the UI and scan status
              const progressCallback = msg.progress ? async (p) => {
                await browser.storage.local.set({
                  "fts_scan_status": {
                    isScanning: true,
                    scanType: "reindex",
                    startTime: Date.now(),
                    progress: {
                      folder: p.folder || "",
                      totalIndexed: p.totalIndexed || 0,
                      totalBatches: p.totalBatches || 0
                    }
                  }
                });
                browser.runtime.sendMessage({type:"ftsProgress", ...p});
              } : undefined;
              
              const result = await indexMessages(ftsSearch, progressCallback);
              
              // Mark complete
              await browser.storage.local.set({
                "fts_initial_scan_complete": true,
                "fts_scan_status": {
                  isScanning: false,
                  scanType: "none",
                  lastCompleted: Date.now()
                }
              });
              sendResponse(result);
              return;
            }
            case "smartReindex": {
              // Set scan status to show indexing is in progress
              await browser.storage.local.set({
                "fts_scan_status": {
                  isScanning: true,
                  scanType: "smart",
                  startTime: Date.now()
                }
              });
              
              const { indexMessages } = await import("./indexer.js");
              
              // Progress callback that updates scan status
              const progressCallback = msg.progress ? async (p) => {
                await browser.storage.local.set({
                  "fts_scan_status": {
                    isScanning: true,
                    scanType: "smart",
                    progress: {
                      folder: p.folder || "",
                      totalIndexed: p.totalIndexed || 0,
                      totalBatches: p.totalBatches || 0
                    }
                  }
                });
                browser.runtime.sendMessage({type:"ftsProgress", ...p});
              } : undefined;
              
              const result = await indexMessages(ftsSearch, progressCallback);
              
              // Log the full maintenance run to history
              try {
                const { logSmartReindexRun } = await import("./maintenanceScheduler.js");
                await logSmartReindexRun(result);
              } catch (logErr) {
                log(`[TMDBG FTS] Failed to log smart reindex: ${logErr.message}`, "warn");
              }
              
              // Mark complete
              await browser.storage.local.set({
                "fts_scan_status": {
                  isScanning: false,
                  scanType: "none",
                  lastCompleted: Date.now()
                }
              });
              sendResponse(result);
              return;
            }
            case "pause": {
              const { pauseIndexer } = await import("./indexer.js");
              const result = await pauseIndexer();
              sendResponse(result);
              return;
            }
            case "resume": {
              const { resumeIndexer } = await import("./indexer.js");
              const result = await resumeIndexer();
              sendResponse(result);
              return;
            }
            case "stats": 
              sendResponse(await ftsSearch.stats());
              return;
            case "clear": 
              await ftsSearch.clearIndex();
              await ftsSearch.clearCheckpoints();
              await browser.storage.local.remove(["fts_initial_scan_complete", "fts_scan_status"]);
              // Mark version as indexed when clearing (clears reindex warning)
              await nativeFtsSearch.markVersionAsIndexed();
              log("[TMDBG FTS] Index cleared and initial scan flags reset");
              sendResponse({ ok: true });
              return;
            case "optimize":
              sendResponse(await ftsSearch.optimize(msg));
              return;
            case "clearCheckpoints":
              sendResponse(await ftsSearch.clearCheckpoints());
              return;
            case "debugCheckpoints":
              sendResponse(await ftsSearch.debugCheckpoints());
              return;
            case "removeBatch": 
              sendResponse(await ftsSearch.removeBatch(msg.ids || []));
              return;
            case "indexBatch": 
              sendResponse(await ftsSearch.indexBatch(msg.rows || []));
              return;
            case "debugSample":
              sendResponse(await ftsSearch.debugSample());
              return;
            case "getMessageByMsgId": {
              const { msgId } = msg;
              try {
                const hostInfo = nativeFtsSearch.getHostInfo();
                const now = Date.now();
                const maxLogs = Number(FTS_ENGINE_DIAG?.missLogMax) || 0;
                const minIntervalMs = Number(FTS_ENGINE_DIAG?.missLogMinIntervalMs) || 0;
                if (
                  !hostInfo &&
                  FTS_ENGINE_DIAG_STATE.hostInfoEmptyLogs < maxLogs &&
                  (now - FTS_ENGINE_DIAG_STATE.hostInfoEmptyLastMs) >= minIntervalMs
                ) {
                  FTS_ENGINE_DIAG_STATE.hostInfoEmptyLogs += 1;
                  FTS_ENGINE_DIAG_STATE.hostInfoEmptyLastMs = now;
                  log(`[TMDBG SnippetDiag][BG] [TMDBG FTS] getMessageByMsgId called but hostInfo is empty`, "warn");
                }
              } catch (_) {}
              const res = await ftsSearch.getMessageByMsgId(msgId);
              if (!res) {
                try {
                  const now = Date.now();
                  const maxLogs = Number(FTS_ENGINE_DIAG?.missLogMax) || 0;
                  const minIntervalMs = Number(FTS_ENGINE_DIAG?.missLogMinIntervalMs) || 0;
                  if (
                    FTS_ENGINE_DIAG_STATE.missLogs < maxLogs &&
                    (now - FTS_ENGINE_DIAG_STATE.missLastMs) >= minIntervalMs
                  ) {
                    FTS_ENGINE_DIAG_STATE.missLogs += 1;
                    FTS_ENGINE_DIAG_STATE.missLastMs = now;
                    log(`[TMDBG SnippetDiag][BG] [TMDBG FTS] getMessageByMsgId miss: ${String(msgId).slice(0, 120)}`, "warn");
                  }
                } catch (_) {}
              }
              sendResponse(res);
              return;
            }
            case "resetInitialScan": {
              await browser.storage.local.remove("fts_initial_scan_complete");
              await browser.storage.local.remove("fts_scan_status");
              log("[TMDBG FTS] Initial scan flag reset");
              sendResponse({ ok: true });
              return;
            }
            case "getInitialScanStatus": {
              const stored = await browser.storage.local.get(["fts_initial_scan_complete", "fts_scan_status"]);
              sendResponse({
                initialComplete: stored.fts_initial_scan_complete || false,
                scanStatus: stored.fts_scan_status || { isScanning: false, scanType: "none" }
              });
              return;
            }
            case "flushIncremental": {
              const { flushPendingUpdates } = await import("./incrementalIndexer.js");
              await flushPendingUpdates();
              sendResponse({ ok: true });
              return;
            }
            case "incrementalStatus": {
              const { getIncrementalIndexerStatus } = await import("./incrementalIndexer.js");
              sendResponse(getIncrementalIndexerStatus());
              return;
            }
            case "clearPendingUpdates": {
              const { clearPendingUpdates } = await import("./incrementalIndexer.js");
              sendResponse(await clearPendingUpdates());
              return;
            }
            case "maintenanceStatus": {
              const { getMaintenanceStatus } = await import("./maintenanceScheduler.js");
              sendResponse(await getMaintenanceStatus());
              return;
            }
            case "maintenanceTrigger": {
              const { triggerMaintenanceScan } = await import("./maintenanceScheduler.js");
              const result = await triggerMaintenanceScan(msg.scheduleType || 'hourly', !!msg.force);
              sendResponse(result);
              return;
            }
            case "cleanupTrigger": {
              const { triggerCleanupScan } = await import("./maintenanceScheduler.js");
              const result = await triggerCleanupScan(msg.scheduleType || 'daily');
              sendResponse(result);
              return;
            }
            case "maintenanceUpdate": {
              const { updateMaintenanceSettings } = await import("./maintenanceScheduler.js");
              sendResponse(await updateMaintenanceSettings(msg.settings || {}));
              return;
            }
            case "maintenanceDebug": {
              const { debugMaintenanceAlarms } = await import("./maintenanceScheduler.js");
              sendResponse(await debugMaintenanceAlarms());
              return;
            }
            case "getHostInfo": {
              // Return native host info (version, install path, etc.)
              const hostInfo = nativeFtsSearch.getHostInfo();
              sendResponse({
                ok: true,
                connected: !!hostInfo,
                hostVersion: hostInfo?.hostVersion || null,
                hostInfo: hostInfo || null,
              });
              return;
            }
            case "checkReindexNeeded": {
              // Check if reindex is needed due to minor version bump
              const result = await nativeFtsSearch.checkReindexNeeded();
              sendResponse(result);
              return;
            }
            case "markVersionAsIndexed": {
              // Mark current version as indexed (called after successful reindex)
              await nativeFtsSearch.markVersionAsIndexed();
              sendResponse({ ok: true });
              return;
            }
            case "checkForUpdates": {
              // Manually check for native FTS updates
              const result = await nativeFtsSearch.checkForUpdates();
              sendResponse(result);
              return;
            }
            default: 
              sendResponse({ error: "Unknown FTS command: " + msg.cmd });
              return;
          }
        } catch (e) {
          log(`[TMDBG FTS] Command '${msg.cmd}' failed: ${e}`, "error");
          sendResponse({ error: String(e?.message || e) });
        }
      })();
      
      return true; // Keep channel open for async response
    }
    // Return nothing - let other listeners handle this message
  };
  
  // Avoid duplicate listeners on reload
  try {
    if (_runtimeMessageHandler) {
      browser.runtime.onMessage.removeListener(_runtimeMessageHandler);
    }
  } catch (_) {}

  _runtimeMessageHandler = onMsg;
  browser.runtime.onMessage.addListener(_runtimeMessageHandler);
  console.log(`[FTS Engine] Runtime message handler attached`);
}

// Initialize FTS engine
export async function initFtsEngine() {
  if (_inited) {
    log("[TMDBG FTS] Already initialized");
    return ftsSearch;
  }

  log("[TMDBG FTS] Starting FTS engine initialization");
  log("[TMDBG FTS] Using NATIVE FTS HELPER (not worker.js)");
  log("[TMDBG FTS] Initializing worker and database");

  try {
    await initNativeFts();
    attachCommandInterface(); // Attach command handlers
    
    // Initialize incremental indexer for automatic updates
    try {
      const { initIncrementalIndexer } = await import("./incrementalIndexer.js");
      await initIncrementalIndexer(ftsSearch);
      log("[TMDBG FTS] Incremental indexer initialized");
    } catch (e) {
      log(`[TMDBG FTS] Failed to initialize incremental indexer: ${e}`, "error");
    }

    // Initialize maintenance scheduler for periodic scans
    try {
      const { initMaintenanceScheduler } = await import("./maintenanceScheduler.js");
      await initMaintenanceScheduler(ftsSearch);
      log("[TMDBG FTS] Maintenance scheduler initialized");
    } catch (e) {
      log(`[TMDBG FTS] Failed to initialize maintenance scheduler: ${e}`, "error");
    }
    
    _inited = true;
    log("[TMDBG FTS] FTS engine initialized successfully (native helper)");
    return ftsSearch;
  } catch (error) {
    log(`[TMDBG FTS] Failed to initialize native FTS: ${error.message}`, "error");
    throw error;
  }
}

export async function disposeFtsEngine() {
  try {
    log("[TMDBG FTS] Disposing FTS engine");
  } catch (_) {}

  // Remove runtime message handler
  try {
    if (_runtimeMessageHandler) {
      browser.runtime.onMessage.removeListener(_runtimeMessageHandler);
      _runtimeMessageHandler = null;
      log("[TMDBG FTS] Runtime message handler removed");
    }
  } catch (e) {
    log(`[TMDBG FTS] Failed to remove runtime message handler: ${e}`, "warn");
  }

  // Dispose incremental indexer
  try {
    const { disposeIncrementalIndexer } = await import("./incrementalIndexer.js");
    await disposeIncrementalIndexer();
  } catch (e) {
    log(`[TMDBG FTS] Failed to dispose incremental indexer: ${e}`, "warn");
  }

  // Dispose maintenance scheduler (clears alarms + removes alarm listener)
  try {
    const { disposeMaintenanceScheduler } = await import("./maintenanceScheduler.js");
    await disposeMaintenanceScheduler();
  } catch (e) {
    log(`[TMDBG FTS] Failed to dispose maintenance scheduler: ${e}`, "warn");
  }

  _inited = false;
  log("[TMDBG FTS] FTS engine disposed");
  return { ok: true };
}

// Main FTS API exposed to the rest of the extension
export const ftsSearch = {
  async indexBatch(rows) {
    log(`[TMDBG FTS] indexBatch called with ${rows.length} rows`);
    return await nativeFtsSearch.indexBatch(rows);
  },

  async filterNewMessages(rows) {
    log(`[TMDBG FTS] filterNewMessages called with ${rows.length} rows`);
    return await nativeFtsSearch.filterNewMessages(rows);
  },

  async search(query, options = {}) {
    log(`[TMDBG FTS] search called: "${query}"`);
    return await nativeFtsSearch.search(query, options);
  },

  // Alias for search (used by old code)
  async searchMessagesQuery(q, from, to, limit, ignoreDate) {
    return await this.search(q, { from, to, limit, ignoreDate });
  },

  async stats() {
    return await nativeFtsSearch.stats();
  },

  async clear() {
    log("[TMDBG FTS] Clearing FTS index");
    return await nativeFtsSearch.clear();
  },

  // Alias for clear (used by old code)
  async clearIndex() {
    return await this.clear();
  },

  async optimize(params = {}) {
    log("[TMDBG FTS] Running FTS optimize");
    return await nativeFtsSearch.optimize(params);
  },

  async removeBatch(ids) {
    log(`[TMDBG FTS] removeBatch called with ${ids.length} IDs`);
    return await nativeFtsSearch.removeBatch(ids);
  },

  async getMessageByMsgId(msgId) {
    return await nativeFtsSearch.getMessageByMsgId(msgId);
  },

  async queryByDateRange(from, to, limit = 1000) {
    return await nativeFtsSearch.queryByDateRange(from, to, limit);
  },

  async debugSample() {
    return await nativeFtsSearch.debugSample();
  },

  async ping() {
    // Simple connectivity test - stats is a lightweight operation
    try {
      await nativeFtsSearch.stats();
      return { ok: true };
    } catch (e) {
      throw new Error(`Native FTS ping failed: ${e.message}`);
    }
  },

  // Checkpoint methods (stored in browser.storage.local, not in DB)
  async clearCheckpoints() {
    log("[TMDBG FTS] Clearing checkpoints");
    const all = await browser.storage.local.get();
    const checkpointKeys = Object.keys(all).filter(k => k.startsWith("fts_ckp:"));
    if (checkpointKeys.length === 0) {
      log(`[TMDBG FTS] No checkpoint keys found to clear`);
      return { ok: true, clearedKeys: 0 };
    }
    await browser.storage.local.remove(checkpointKeys);
    log(`[TMDBG FTS] Cleared ${checkpointKeys.length} checkpoint keys: ${checkpointKeys.join(', ')}`);
    return { ok: true, clearedKeys: checkpointKeys.length };
  },

  async debugCheckpoints() {
    const all = await browser.storage.local.get();
    const checkpointKeys = Object.keys(all).filter(k => k.startsWith("fts_ckp:"));
    const checkpointData = {};
    for (const key of checkpointKeys) {
      checkpointData[key] = all[key];
    }
    return { checkpointKeys: checkpointKeys.length, data: checkpointData };
  }
};

// Command queue for background processing
const _commandQueue = [];
let _isProcessing = false;

async function processNextCommand() {
  if (_isProcessing || _commandQueue.length === 0) return;
  
  _isProcessing = true;
  const cmd = _commandQueue.shift();
  
  log(`[FTS Engine] Processing FTS command: ${cmd.method}`);
  
  try {
    const result = await cmd.handler();
    log(`[FTS Engine] Command ${cmd.method} completed`);
    if (cmd.resolve) cmd.resolve(result);
  } catch (error) {
    log(`[FTS Engine] Command ${cmd.method} failed: ${error.message}`, "error");
    if (cmd.reject) cmd.reject(error);
  } finally {
    _isProcessing = false;
    // Process next command if any
    if (_commandQueue.length > 0) {
      processNextCommand();
    }
  }
}

export function queueFtsCommand(method, handler) {
  return new Promise((resolve, reject) => {
    _commandQueue.push({ method, handler, resolve, reject });
    processNextCommand();
  });
}
