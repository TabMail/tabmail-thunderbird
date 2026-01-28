// fts/nativeEngine.js
// Native messaging adapter for FTS operations

import { log } from "../agent/modules/utils.js";

// Minimum required host version (update this when you need new host features)
// 0.6.10: Added memory database for chat history search (memory_search tool)
const MIN_HOST_VERSION = "0.6.10";

// Storage key for tracking last indexed host version (for auto-reindex on minor version bump)
const STORAGE_KEY_LAST_INDEXED_VERSION = "ftsLastIndexedHostVersion";

// Update server URL - points to the same CDN as addon updates.
// Native-FTS updates are platform-first so each OS/arch can be deployed independently:
//   ${UPDATE_BASE_URL}/${platformKey}/update-manifest.json
const UPDATE_BASE_URL = "https://cdn.tabmail.ai/releases";

let nativePort = null;
let messageId = 0;
let pendingRPCs = new Map();
let hostInfo = null; // Stores host version and capabilities
let isUpdatingHost = false; // Flag to track if we are in the middle of an update

/**
 * Determine the platform key used by native-fts update artifacts.
 * TB API: browser.runtime.getPlatformInfo() (TB 145 / MV3).
 *
 * Output examples:
 * - macos-universal
 * - windows-x86_64
 * - linux-x86_64
 */
async function getNativeFtsPlatformKey() {
  const info = await browser.runtime.getPlatformInfo();
  const osRaw = info?.os || "unknown";
  const archRaw = info?.arch || "unknown";
  
  let key;
  if (osRaw === "mac") {
    // macOS uses universal binary (arm64 + x86_64 combined)
    key = "macos-universal";
  } else if (osRaw === "win") {
    key = "windows-x86_64";
  } else {
    // Linux and others use arch-specific
    let arch = (archRaw === "x86-64") ? "x86_64" : archRaw;
    key = `${osRaw}-${arch}`;
  }
  
  log(`[TMDBG FTS] Native-FTS platform key: ${key} (os=${osRaw}, arch=${archRaw})`);
  return key;
}

/**
 * Compare semantic versions (e.g., "0.5.0" vs "0.4.1")
 */
function versionLessThan(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return true;
    if (va > vb) return false;
  }
  return false;
}

/**
 * Extract major.minor from version string (ignoring patch)
 * e.g., "0.6.1" -> "0.6"
 */
function getMinorVersion(version) {
  const parts = version.split('.');
  return `${parts[0] || 0}.${parts[1] || 0}`;
}

/**
 * Check if minor version has changed (requires reindex due to schema/tokenizer changes)
 * Returns true if reindex is needed
 */
async function checkMinorVersionChange(currentVersion) {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY_LAST_INDEXED_VERSION);
    const lastVersion = stored[STORAGE_KEY_LAST_INDEXED_VERSION];
    
    if (!lastVersion) {
      // First time - no previous version, no need to reindex
      log(`[TMDBG FTS] No previous host version stored, skipping reindex check`);
      return { needsReindex: false, isFirstRun: true };
    }
    
    const currentMinor = getMinorVersion(currentVersion);
    const lastMinor = getMinorVersion(lastVersion);
    
    if (currentMinor !== lastMinor) {
      log(`[TMDBG FTS] ⚠️ Minor version changed: ${lastMinor} → ${currentMinor}, reindex required!`);
      return { needsReindex: true, lastVersion, currentVersion };
    }
    
    log(`[TMDBG FTS] Minor version unchanged (${currentMinor}), no reindex needed`);
    return { needsReindex: false };
  } catch (e) {
    log(`[TMDBG FTS] Error checking version change: ${e}`, "error");
    return { needsReindex: false, error: e.message };
  }
}

/**
 * Mark the current version as indexed (call after successful reindex)
 */
async function markVersionAsIndexed(version) {
  try {
    await browser.storage.local.set({ [STORAGE_KEY_LAST_INDEXED_VERSION]: version });
    log(`[TMDBG FTS] Marked version ${version} as indexed`);
  } catch (e) {
    log(`[TMDBG FTS] Error marking version as indexed: ${e}`, "error");
  }
}

/**
 * Trigger automatic reindex after upgrade
 * Sends message to FTS engine to perform full reindex
 */
async function triggerAutoReindex() {
  log(`[TMDBG FTS] Starting automatic reindex after upgrade`);
  
  try {
    // Send reindexAll command via runtime message (goes through engine.js)
    const result = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "reindexAll",
      progress: false // No UI progress needed for auto-reindex
    });
    
    if (result?.ok) {
      log(`[TMDBG FTS] ✅ Auto-reindex completed: ${result.indexed} messages in ${result.batches} batches`);
    } else {
      log(`[TMDBG FTS] ❌ Auto-reindex failed: ${result?.error || "unknown error"}`, "error");
    }
  } catch (e) {
    log(`[TMDBG FTS] ❌ Auto-reindex error: ${e.message}`, "error");
    throw e;
  }
}

/**
 * Check for and perform host updates if needed
 */
async function checkAndUpdateHost() {
  try {
    // Say hello to get host version
    const manifest = browser.runtime.getManifest();
    const addonVersion = manifest.version;
    
    log(`[TMDBG FTS] Addon version: ${addonVersion}, Min host version: ${MIN_HOST_VERSION}`);
    
    hostInfo = await nativeRPC('hello', { addonVersion });
    log(`[TMDBG FTS] Native host version: ${hostInfo.hostVersion}, installed at: ${hostInfo.installPath}`);
    log(`[TMDBG FTS] Native host impl: ${hostInfo.hostImpl || "unknown"}`);
    log(`[TMDBG FTS] Can self-update: ${hostInfo.canSelfUpdate}, User install: ${hostInfo.isUserInstall}`);
    
    // Inform user about auto-migration with popup window
    if (hostInfo.userLocalReady && hostInfo.isSystemInstall) {
      log(`[TMDBG FTS] ✅ Auto-migrated to user-local install! Restart Thunderbird to enable auto-updates.`, "info");
      
      // Show popup window with restart message (always show when migration is detected)
      try {
        log(`[TMDBG FTS] Opening migration notification popup...`);
        
        await browser.windows.create({
          url: browser.runtime.getURL('fts/migration-notice.html?type=migration'),
          type: 'popup',
          width: 520,
          height: 280,
          allowScriptsToClose: true
        });
        
        log(`[TMDBG FTS] Migration notification popup shown to user`);
      } catch (e) {
        log(`[TMDBG FTS] Could not show migration notification: ${e.message}`, "warn");
        log(`[TMDBG FTS] Notification error stack: ${e.stack}`, "warn");
        // Non-fatal - just log it
      }
    }
    
    // Check if update is needed
    let needsMandatoryUpdate = false;
    if (versionLessThan(hostInfo.hostVersion, MIN_HOST_VERSION)) {
      log(`[TMDBG FTS] ⚠️ Host needs update: ${hostInfo.hostVersion} < ${MIN_HOST_VERSION}`, "warn");
      needsMandatoryUpdate = true;
    } else {
      log(`[TMDBG FTS] ✅ Host version ${hostInfo.hostVersion} meets minimum requirement ${MIN_HOST_VERSION}`);
    }

    // Always check for updates if self-update is possible
    if (hostInfo.canSelfUpdate) {
      const platformKey = await getNativeFtsPlatformKey();

      // Fetch platform update manifest from releases repo (platform-specific versioning)
      const updateManifestUrl = `${UPDATE_BASE_URL}/${platformKey}/update-manifest.json`;
      log(`[TMDBG FTS] Fetching native-fts update manifest for ${platformKey} from ${updateManifestUrl}`);
      
      const response = await fetch(updateManifestUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch update manifest: ${response.status}`);
      }
      
      const updateManifest = await response.json();
      const latestRelease = updateManifest.latest;
      
      log(`[TMDBG FTS] Latest host version available for ${platformKey}: ${latestRelease.version}`);
      
      if (versionLessThan(hostInfo.hostVersion, latestRelease.version)) {
        log(`[TMDBG FTS] 🔄 Starting host update: ${hostInfo.hostVersion} → ${latestRelease.version}`);
        
        isUpdatingHost = true; // Set flag to expect disconnect

        const updateResult = await nativeRPC('updateRequest', {
          targetVersion: latestRelease.version,
          updateUrl: latestRelease.downloadUrl,
          sha256: latestRelease.sha256,
          platform: platformKey,
          signature: latestRelease.signature
        });
        
        if (updateResult.success) {
          log(`[TMDBG FTS] ✅ Host update successful! Process will restart.`);
          return true; // Updated
        } else {
          isUpdatingHost = false; // Failed, so no disconnect expected (or not due to update)
          log(`[TMDBG FTS] ❌ Host update failed: ${updateResult.error}`, "error");
        }
      } else {
        log(`[TMDBG FTS] Host version ${hostInfo.hostVersion} is up to date`);
      }
    } else if (needsMandatoryUpdate) {
       log(`[TMDBG FTS] ⚠️ Host cannot self-update (needs admin permissions). Please reinstall TabMail.`, "warn");
    }
    
    return false; // No update performed
  } catch (error) {
    isUpdatingHost = false; // Reset on error
    log(`[TMDBG FTS] Update check failed: ${error.message}`, "error");
    // Don't throw - allow FTS to work even if update check fails
    return false;
  }
}

/**
 * Connect to native FTS helper
 */
export async function initNativeFts() {
  log("[TMDBG FTS] Connecting to native FTS helper");
  
  try {
    nativePort = browser.runtime.connectNative("tabmail_fts");
    
    // Handle responses
    nativePort.onMessage.addListener((msg) => {
      const { id, result, error } = msg;
      
      const pending = pendingRPCs.get(id);
      if (pending) {
        pendingRPCs.delete(id);
        if (error) {
          pending.reject(new Error(error));
        } else {
          pending.resolve(result);
        }
      }
    });
    
    // Handle disconnect
    nativePort.onDisconnect.addListener(() => {
      log("[TMDBG FTS] Native helper disconnected");
      nativePort = null;
      
      // Reject all pending RPCs
      for (const [id, pending] of pendingRPCs) {
        pending.reject(new Error("Native helper disconnected"));
      }
      pendingRPCs.clear();
      
      // Handle auto-reconnect after update
      if (isUpdatingHost) {
        log("[TMDBG FTS] Update detected. Reconnecting to new host version...", "info");
        isUpdatingHost = false;
        
        // Wait briefly for file lock release / process cleanup
        setTimeout(async () => {
          try {
            await initNativeFts();
            log("[TMDBG FTS] ✅ Reconnected to updated host successfully");
          } catch (e) {
            log(`[TMDBG FTS] Failed to reconnect after update: ${e}`, "error");
          }
        }, 1000);
      }
    });
    
    // Check for updates FIRST (before init)
    // If update is triggered, the process will exit and we'll reconnect via onDisconnect
    const updated = await checkAndUpdateHost();
    if (updated) {
      log("[TMDBG FTS] Host update initiated. Waiting for restart...");
      return true; // Treat as success, reconnection will happen automatically
    }
    
    // Initialize the native helper
    // The helper auto-detects TB profile and handles migration from old location
    const manifest = browser.runtime.getManifest();
    const addonId = manifest.browser_specific_settings?.gecko?.id || "thunderbird@tabmail.ai";
    const initResult = await nativeRPC('init', { addonId });
    log(`[TMDBG FTS] DB initialized at: ${initResult.dbPath}`);
    
    log("[TMDBG FTS] Native FTS helper connected successfully");
    
    // Check if minor version changed (requires reindex for schema/tokenizer changes)
    const versionCheck = await checkMinorVersionChange(hostInfo.hostVersion);
    if (versionCheck.needsReindex) {
      log(`[TMDBG FTS] 🔄 Minor version upgrade detected: ${versionCheck.lastVersion} → ${versionCheck.currentVersion}`);
      log(`[TMDBG FTS] Auto-triggering full reindex due to tokenizer/schema changes`);
      
      // Trigger automatic reindex - don't await, let it run in background
      triggerAutoReindex().catch(e => {
        log(`[TMDBG FTS] Auto-reindex failed: ${e.message}`, "error");
      });
    } else if (versionCheck.isFirstRun) {
      // First run - mark the current version as indexed
      await markVersionAsIndexed(hostInfo.hostVersion);
    }
    
    return true;
  } catch (error) {
    log(`[TMDBG FTS] Failed to connect to native helper: ${error.message}`);
    throw error;
  }
}

/**
 * Reconnect to native helper if disconnected
 */
async function ensureConnected() {
  if (nativePort) return true;
  
  log("[TMDBG FTS] Attempting to reconnect to native helper...");
  try {
    await initNativeFts();
    return true;
  } catch (e) {
    log(`[TMDBG FTS] Reconnection failed: ${e}`, "error");
    return false;
  }
}

/**
 * Send RPC to native helper (auto-reconnects if needed)
 */
async function nativeRPC(method, params) {
  // Auto-reconnect if not connected
  if (!nativePort) {
    const reconnected = await ensureConnected();
    if (!reconnected || !nativePort) {
      throw new Error("Native FTS helper not connected");
    }
  }
  
  const id = `rpc-${++messageId}`;
  
  return new Promise((resolve, reject) => {
    pendingRPCs.set(id, { resolve, reject });
    
    try {
      nativePort.postMessage({ id, method, params });
    } catch (error) {
      pendingRPCs.delete(id);
      reject(error);
    }
  });
}

/**
 * FTS API - same interface as before but using native helper
 */
export const nativeFtsSearch = {
  async init() {
    return nativeRPC('init', {});
  },
  
  async indexBatch(rows) {
    return nativeRPC('indexBatch', { rows });
  },
  
  async search(query, options = {}) {
    const { from, to, limit = 50, ignoreDate = false } = options;
    return nativeRPC('search', { q: query, from, to, limit, ignoreDate });
  },
  
  async stats() {
    return nativeRPC('stats', {});
  },
  
  async clear() {
    return nativeRPC('clear', {});
  },
  
  async optimize(params = {}) {
    return nativeRPC('optimize', params);
  },
  
  async filterNewMessages(rows) {
    return nativeRPC('filterNewMessages', { rows });
  },
  
  async removeBatch(ids) {
    return nativeRPC('removeBatch', { ids });
  },
  
  async getMessageByMsgId(msgId) {
    return nativeRPC('getMessageByMsgId', { msgId });
  },
  
  async queryByDateRange(from, to, limit = 1000) {
    return nativeRPC('queryByDateRange', { from, to, limit });
  },
  
  async debugSample() {
    return nativeRPC('debugSample', {});
  },
  
  // Get host info (version, install path, etc.)
  getHostInfo() {
    return hostInfo;
  },
  
  // Mark current version as indexed (call after successful reindex)
  async markVersionAsIndexed() {
    if (hostInfo?.hostVersion) {
      await markVersionAsIndexed(hostInfo.hostVersion);
    }
  },
  
  // Check if reindex is needed due to version change
  async checkReindexNeeded() {
    if (!hostInfo?.hostVersion) {
      return { needsReindex: false, error: "Host not connected" };
    }
    return checkMinorVersionChange(hostInfo.hostVersion);
  },
  
  // Manually check for updates (called from settings)
  async checkForUpdates() {
    try {
      if (!hostInfo) {
        return { ok: false, error: "Host not connected" };
      }
      
      const currentVersion = hostInfo.hostVersion;
      log(`[TMDBG FTS] Manual update check - current version: ${currentVersion}`);
      
      // Fetch update manifest
      const platformKey = await getNativeFtsPlatformKey();
      const updateManifestUrl = `${UPDATE_BASE_URL}/${platformKey}/update-manifest.json`;
      const response = await fetch(updateManifestUrl);
      
      if (!response.ok) {
        return { ok: false, error: `Failed to fetch update manifest: ${response.status}` };
      }
      
      const updateManifest = await response.json();
      const latestRelease = updateManifest.latest;
      
      log(`[TMDBG FTS] Latest available version for ${platformKey}: ${latestRelease.version}`);
      
      if (versionLessThan(currentVersion, latestRelease.version)) {
        // Update available
        log(`[TMDBG FTS] 🔄 Update available: ${currentVersion} → ${latestRelease.version}`);
        
        if (!hostInfo.canSelfUpdate) {
          return {
            ok: true,
            updateAvailable: true,
            currentVersion,
            latestVersion: latestRelease.version,
            canUpdate: false,
            message: `Update available (${currentVersion} → ${latestRelease.version}) but cannot self-update. Please reinstall TabMail.`
          };
        }
        
        // Perform the update
        isUpdatingHost = true;

        const updateResult = await nativeRPC('updateRequest', {
          targetVersion: latestRelease.version,
          updateUrl: latestRelease.downloadUrl,
          sha256: latestRelease.sha256,
          platform: platformKey,
          signature: latestRelease.signature
        });
        
        if (updateResult.success) {
          return {
            ok: true,
            updated: true,
            oldVersion: currentVersion,
            newVersion: latestRelease.version,
            message: `Updated ${currentVersion} → ${latestRelease.version}. Reconnecting automatically...`
          };
        } else {
          isUpdatingHost = false;
          return {
            ok: false,
            error: updateResult.error || "Update failed"
          };
        }
      } else {
        // Already up to date
        return {
          ok: true,
          updateAvailable: false,
          currentVersion,
          latestVersion: latestRelease.version,
          message: `Already up to date (v${currentVersion})`
        };
      }
    } catch (e) {
      log(`[TMDBG FTS] Manual update check failed: ${e}`, "error");
      return { ok: false, error: e.message || String(e) };
    }
  }
};

/**
 * Memory API - separate database for chat history and learned facts
 * This database is NOT cleared when email FTS is reindexed.
 */
export const nativeMemorySearch = {
  async indexBatch(rows) {
    return nativeRPC('memoryIndexBatch', { rows });
  },
  
  async search(query, options = {}) {
    const { from, to, limit = 50, ignoreDate = false } = options;
    return nativeRPC('memorySearch', { q: query, from, to, limit, ignoreDate });
  },
  
  async stats() {
    return nativeRPC('memoryStats', {});
  },
  
  async clear() {
    return nativeRPC('memoryClear', {});
  },
  
  async removeBatch(ids) {
    return nativeRPC('memoryRemoveBatch', { ids });
  },
  
  async debugSample() {
    return nativeRPC('memoryDebugSample', {});
  },

  async read(timestampMs, toleranceMs = 600000) {
    return nativeRPC('memoryRead', { timestampMs, toleranceMs });
  },
};

/**
 * Check if native FTS is available
 */
export async function isNativeFtsAvailable() {
  try {
    // Try to connect
    const port = browser.runtime.connectNative("tabmail_fts");
    
    // If we get here, it's available
    port.disconnect();
    return true;
  } catch (error) {
    log(`[TMDBG FTS] Native FTS not available: ${error.message}`);
    return false;
  }
}

