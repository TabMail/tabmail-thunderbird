/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fts/nativeEngine.js
// Native messaging adapter for FTS operations

import { log } from "../agent/modules/utils.js";
import { SETTINGS } from "../agent/modules/config.js";
import {
  getNativeFtsCompatibility,
  versionLessThan,
} from "./nativeCompatibility.js";

// Minimum required host version (update this when you need new host features)
// 0.6.10: Added memory database for chat history search (memory_search tool)
// 0.6.12: Stability improvements, empty query support for memory search
// 0.7.0:  Semantic search (sqlite-vec embeddings + hybrid FTS5/vector scoring)
// 0.11.0: Ordered msgId membership fingerprints required by startup reconcile
const MIN_HOST_VERSION = "0.11.0";

// Time-box for the update-manifest CDN fetch. It runs inside the awaited
// init chain on EVERY boot; an un-time-boxed fetch on a stalled connection
// (network blackhole) silently held the entire FTS engine — search,
// indexing, reconcile — hostage for a whole session (observed 2026-07-03).
// On timeout/failure the update check is skipped and init proceeds locally.
const UPDATE_MANIFEST_FETCH_TIMEOUT_MS = 15_000;

// Storage key for tracking last indexed schema version (for auto-reindex on schema change)
const STORAGE_KEY_LAST_INDEXED_SCHEMA_VERSION = "ftsLastIndexedSchemaVersion";

// Legacy storage key (migrated to schema version on first run with new host)
const STORAGE_KEY_LAST_INDEXED_VERSION = "ftsLastIndexedHostVersion";

// Storage key for tracking interrupted embedding rebuild (resume on next startup)
const STORAGE_KEY_EMBEDDING_REBUILD_STATUS = "fts_embedding_rebuild_status";

// Update server URL - points to the same CDN as addon updates.
// Native-FTS updates are platform-first so each OS/arch can be deployed independently:
//   ${UPDATE_BASE_URL}/${platformKey}/update-manifest.json
const UPDATE_BASE_URL = "https://cdn.tabmail.ai/releases";

let nativePort = null;
let messageId = 0;
let pendingRPCs = new Map();
let hostInfo = null; // Stores host version and capabilities
let nativeConnectionGeneration = 0;
let nativeReadyState = null;
let nativeInitializationPromise = null;
let nativeInitializationState = null;
let isUpdatingHost = false; // Flag to track if we are in the middle of an update
// Reliable "is the native helper installed?" signal for UI surfaces (badge /
// popup / settings). null = not yet determined, true = handshake succeeded,
// false = connect/handshake failed (helper not installed). connectNative()
// itself does NOT throw synchronously when the host manifest is missing, so we
// can only know availability from the init handshake outcome, tracked here.
let ftsHostStatus = { status: "unknown" };

function _createNativeReadyState(port) {
  let resolveHello;
  let rejectHello;
  let resolveOperational;
  let rejectOperational;
  const helloPromise = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const operationalPromise = new Promise((resolve, reject) => {
    resolveOperational = resolve;
    rejectOperational = reject;
  });
  // A disconnect or failed bootstrap may reject either phase before an
  // external waiter attaches. Keep both state promises safely awaitable.
  helloPromise.catch(() => {});
  operationalPromise.catch(() => {});
  return {
    generation: ++nativeConnectionGeneration,
    port,
    hostInfo: null,
    helloPromise,
    resolveHello,
    rejectHello,
    helloSettled: false,
    helloSucceeded: false,
    operationalPromise,
    resolveOperational,
    rejectOperational,
    operationalSettled: false,
    operationalSucceeded: false,
  };
}

function _isNativeStateCurrent(state) {
  return !!state && state === nativeReadyState && state.port === nativePort;
}

function _assertNativeStateCurrent(state, phase) {
  if (!_isNativeStateCurrent(state)) {
    const error = new Error(`Native FTS ${phase} generation changed`);
    error.code = "NATIVE_FTS_STALE_GENERATION";
    throw error;
  }
}

function _resolveNativeHello(state, info) {
  if (!_isNativeStateCurrent(state) || state.helloSettled) {
    return false;
  }
  state.hostInfo = info;
  state.helloSettled = true;
  state.helloSucceeded = true;
  hostInfo = info;
  state.resolveHello(info);
  return true;
}

function _rejectNativeOperational(state, error) {
  if (!state || state.operationalSettled) return;
  state.operationalSettled = true;
  state.rejectOperational(error);
}

function _rejectNativeReady(state, error) {
  if (!state) return;
  if (!state.helloSettled) {
    state.helloSettled = true;
    state.rejectHello(error);
  }
  _rejectNativeOperational(state, error);
}

function _resolveNativeOperational(state, initResult) {
  if (!_isNativeStateCurrent(state)
      || !state.helloSucceeded || state.operationalSettled) {
    return false;
  }
  state.operationalSettled = true;
  state.operationalSucceeded = true;
  state.resolveOperational(initResult);
  return true;
}

async function _awaitNativeHello(state = nativeReadyState) {
  if (!state) {
    throw new Error("Native FTS hello readiness unavailable");
  }
  const info = await state.helloPromise;
  _assertNativeStateCurrent(state, "hello");
  return { state, info };
}

async function _awaitCurrentNativeOperational() {
  const state = nativeReadyState;
  if (!_isNativeStateCurrent(state)) {
    throw new Error("Native FTS operational readiness unavailable");
  }
  await state.operationalPromise;
  if (!_isNativeStateCurrent(state) || !state.operationalSucceeded) {
    throw new Error("Native FTS operational generation changed");
  }
  return { state, info: state.hostInfo };
}

function setFtsHostStatus(status, details = {}) {
  const nextStatus = { status, ...details };
  const changed = JSON.stringify(nextStatus) !== JSON.stringify(ftsHostStatus);
  ftsHostStatus = nextStatus;
  if (changed) {
    log(`[TMDBG FTS] Helper status → ${status}${details.hostVersion ? ` (v${details.hostVersion})` : ""}`);
  }
}

function getFtsHostAvailability() {
  if (ftsHostStatus.status === "available") return true;
  if (ftsHostStatus.status === "unknown") return null;
  return false;
}

function supportsFolderMembership() {
  return hostInfo?.capabilities?.folderMembershipV1 === true;
}
// Circuit breaker: when the helper is confirmed unavailable, don't re-attempt
// connectNative on every RPC (it spams "disconnected"/"update check failed").
// Re-attempt at most once per cooldown so a helper installed before the next
// restart can still be picked up.
const RECONNECT_COOLDOWN_MS = 60_000;
let lastConnectAttemptMs = 0;

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
/**
 * Show the native update restart banner (shared by auto and manual update paths).
 * Tries the experiment update bar first, falls back to a popup window.
 */
async function showNativeUpdateBanner(version) {
  try {
    if (browser.tmUpdates?.showUpdateBar) {
      await browser.tmUpdates.showUpdateBar({
        version: `FTS ${version}`,
        message: "Native search updated. Restart Thunderbird for full compatibility."
      });
      log(`[TMDBG FTS] Restart prompt shown via update bar`);
    } else {
      await browser.windows.create({
        url: browser.runtime.getURL('fts/migration-notice.html?type=update'),
        type: 'popup',
        width: 520,
        height: 280,
        allowScriptsToClose: true
      });
      log(`[TMDBG FTS] Restart prompt shown via popup`);
    }
  } catch (e) {
    log(`[TMDBG FTS] Could not show restart prompt: ${e.message}`, "warn");
  }
}

/**
 * Fetch the update manifest, compare versions, and apply the update if possible.
 * Shared core between initCheckAndUpdateHost() and manualCheckAndUpdateHost().
 *
 * Returns { updateAvailable, canUpdate, updated, latestVersion, oldVersion, newVersion, error }
 */
async function fetchAndApplyUpdate(currentVersion, canSelfUpdate, bootstrapState = null) {
  const platformKey = await getNativeFtsPlatformKey();
  if (bootstrapState) _assertNativeStateCurrent(bootstrapState, "update platform");
  const updateManifestUrl = `${UPDATE_BASE_URL}/${platformKey}/update-manifest.json`;
  log(`[TMDBG FTS] Fetching native-fts update manifest for ${platformKey} from ${updateManifestUrl}`);

  const response = await fetch(updateManifestUrl, {
    cache: 'no-cache',
    signal: AbortSignal.timeout(UPDATE_MANIFEST_FETCH_TIMEOUT_MS),
  });
  if (bootstrapState) _assertNativeStateCurrent(bootstrapState, "update manifest");
  if (!response.ok) {
    throw new Error(`Failed to fetch update manifest: ${response.status}`);
  }

  const updateManifest = await response.json();
  if (bootstrapState) _assertNativeStateCurrent(bootstrapState, "update metadata");
  const latestRelease = updateManifest.latest;
  log(`[TMDBG FTS] Latest host version available for ${platformKey}: ${latestRelease.version}`);

  const manifestNeedsUpdate = versionLessThan(currentVersion, latestRelease.version);
  if (!manifestNeedsUpdate) {
    log(`[TMDBG FTS] Host version ${currentVersion} is up to date`);
  } else {
    log(`[TMDBG FTS] 🔄 Update available: ${currentVersion} → ${latestRelease.version}`);
  }

  if (!canSelfUpdate) {
    return manifestNeedsUpdate
      ? { updateAvailable: true, canUpdate: false, latestVersion: latestRelease.version }
      : { updateAvailable: false, latestVersion: latestRelease.version };
  }

  const updateRpcOptions = bootstrapState
    ? { bootstrapPhase: "preinit", expectedState: bootstrapState }
    : undefined;
  const updateCheck = await nativeRPC('updateCheck', {
    targetVersion: latestRelease.version,
  }, updateRpcOptions);
  if (bootstrapState) _assertNativeStateCurrent(bootstrapState, "update eligibility");
  if (typeof updateCheck?.needsUpdate !== "boolean"
      || typeof updateCheck?.canUpdate !== "boolean") {
    throw new Error("Native FTS update check returned an invalid response");
  }
  if (!updateCheck.needsUpdate) {
    return { updateAvailable: false, latestVersion: latestRelease.version };
  }
  if (!updateCheck.canUpdate) {
    return { updateAvailable: true, canUpdate: false, latestVersion: latestRelease.version };
  }

  isUpdatingHost = true;

  const updateResult = await nativeRPC('updateRequest', {
    targetVersion: latestRelease.version,
    updateUrl: latestRelease.downloadUrl,
    sha256: latestRelease.sha256,
    platform: platformKey,
    signature: latestRelease.signature,
  }, updateRpcOptions);

  if (updateResult?.success === true) {
    // Native 175f6fe writes this success response and then intentionally exits.
    // The response is the commit point: from here onward the captured port may
    // disappear before, during, or after UI work and must not be revalidated.
    log(`[TMDBG FTS] ✅ Host update successful! Prompting for Thunderbird restart.`);
    await showNativeUpdateBanner(latestRelease.version);
    return { updateAvailable: true, canUpdate: true, updated: true, oldVersion: currentVersion, newVersion: latestRelease.version };
  } else {
    if (bootstrapState) _assertNativeStateCurrent(bootstrapState, "update failure");
    isUpdatingHost = false;
    const updateFailure = updateResult?.message || updateResult?.error || "Update failed";
    log(`[TMDBG FTS] ❌ Host update failed: ${updateFailure}`, "error");
    return { updateAvailable: true, canUpdate: true, updated: false, error: updateFailure };
  }
}

/**
 * Check if schema version has changed (requires reindex due to schema/tokenizer/model changes).
 * Compares the integer schemaVersion from the native host hello response against the stored value.
 * Handles migration from the old hostVersion-based tracking.
 */
async function checkSchemaVersionChange(currentSchemaVersion) {
  try {
    const stored = await browser.storage.local.get([
      STORAGE_KEY_LAST_INDEXED_SCHEMA_VERSION,
      STORAGE_KEY_LAST_INDEXED_VERSION, // old key for migration
    ]);
    const lastSchemaVersion = stored[STORAGE_KEY_LAST_INDEXED_SCHEMA_VERSION];

    if (lastSchemaVersion === undefined || lastSchemaVersion === null) {
      // Migration: if old key exists, user has indexed before — no spurious reindex
      const oldVersion = stored[STORAGE_KEY_LAST_INDEXED_VERSION];
      if (oldVersion) {
        log(`[TMDBG FTS] Migrating from hostVersion tracking to schemaVersion tracking (old=${oldVersion}, new schema=${currentSchemaVersion})`);
        await browser.storage.local.remove(STORAGE_KEY_LAST_INDEXED_VERSION);
        await browser.storage.local.set({ [STORAGE_KEY_LAST_INDEXED_SCHEMA_VERSION]: currentSchemaVersion });
        return { needsReindex: false, migrated: true };
      }
      // True first run — no previous data
      log(`[TMDBG FTS] No previous schema version stored, skipping reindex check`);
      return { needsReindex: false, isFirstRun: true };
    }

    if (currentSchemaVersion !== lastSchemaVersion) {
      log(`[TMDBG FTS] ⚠️ Schema version changed: ${lastSchemaVersion} → ${currentSchemaVersion}, reindex required!`);
      return { needsReindex: true, lastSchemaVersion, currentSchemaVersion };
    }

    log(`[TMDBG FTS] Schema version unchanged (${currentSchemaVersion}), no reindex needed`);
    return { needsReindex: false };
  } catch (e) {
    log(`[TMDBG FTS] Error checking schema version change: ${e}`, "error");
    return { needsReindex: false, error: e.message };
  }
}

/**
 * Mark the current schema version as indexed (call after successful reindex)
 */
async function markSchemaVersionAsIndexed(schemaVersion) {
  try {
    await browser.storage.local.set({ [STORAGE_KEY_LAST_INDEXED_SCHEMA_VERSION]: schemaVersion });
    log(`[TMDBG FTS] Marked schema version ${schemaVersion} as indexed`);
  } catch (e) {
    log(`[TMDBG FTS] Error marking schema version as indexed: ${e}`, "error");
  }
}

/**
 * Init-time: hello handshake, migration popup, and auto-update check.
 * Returns true if an update was applied (caller should wait for reconnect).
 */
async function initCheckAndUpdateHost(bootstrapState) {
  try {
    // Say hello to get host version
    const manifest = browser.runtime.getManifest();
    const addonVersion = manifest.version;

    log(`[TMDBG FTS] Addon version: ${addonVersion}, Min host version: ${MIN_HOST_VERSION}`);

    const connectionHostInfo = await nativeRPC(
      'hello',
      { addonVersion },
      { bootstrapPhase: "hello", expectedState: bootstrapState },
    );
    log(`[TMDBG FTS] Native host version: ${connectionHostInfo.hostVersion}, installed at: ${connectionHostInfo.installPath}`);
    log(`[TMDBG FTS] Native host impl: ${connectionHostInfo.hostImpl || "unknown"}`);
    log(`[TMDBG FTS] Can self-update: ${connectionHostInfo.canSelfUpdate}, User install: ${connectionHostInfo.isUserInstall}`);

    const compatibility = getNativeFtsCompatibility(connectionHostInfo.hostVersion);
    if (!compatibility.supported) {
      setFtsHostStatus("unsupported", {
        hostVersion: connectionHostInfo.hostVersion,
        minimumSupportedVersion: compatibility.minimumSupportedVersion,
        retirementAt: compatibility.retirementAt,
      });
      log(
        `[TMDBG FTS] Host v${connectionHostInfo.hostVersion} is outside the signing-key overlap window; ` +
        `v${compatibility.minimumSupportedVersion}+ must be reinstalled`,
        "warn"
      );
      const portToClose = nativePort;
      nativePort = null;
      try { portToClose?.disconnect(); } catch (_) {}
      const error = new Error(
        `Native FTS helper v${connectionHostInfo.hostVersion} is no longer supported; ` +
        `reinstall v${compatibility.minimumSupportedVersion} or newer`
      );
      error.code = "NATIVE_FTS_UNSUPPORTED";
      throw error;
    }

    // Inform user about auto-migration with popup window
    if (connectionHostInfo.userLocalReady && connectionHostInfo.isSystemInstall) {
      log(`[TMDBG FTS] ✅ Auto-migrated to user-local install! Restart Thunderbird to enable auto-updates.`, "info");

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
      }
    }

    // Check if update is needed
    let needsMandatoryUpdate = false;
    if (versionLessThan(connectionHostInfo.hostVersion, MIN_HOST_VERSION)) {
      log(`[TMDBG FTS] ⚠️ Host needs update: ${connectionHostInfo.hostVersion} < ${MIN_HOST_VERSION}`, "warn");
      needsMandatoryUpdate = true;
    } else {
      log(`[TMDBG FTS] ✅ Host version ${connectionHostInfo.hostVersion} meets minimum requirement ${MIN_HOST_VERSION}`);
    }

    // Always check for updates if self-update is possible
    if (connectionHostInfo.canSelfUpdate) {
      const result = await fetchAndApplyUpdate(
        connectionHostInfo.hostVersion,
        true,
        bootstrapState,
      );
      if (result.updated) return true;
    } else if (needsMandatoryUpdate) {
       log(`[TMDBG FTS] ⚠️ Host cannot self-update (needs admin permissions). Please reinstall TabMail.`, "warn");
    }

    return false; // No update performed
  } catch (error) {
    // A replaced bootstrap must not clear a newer generation's update state.
    if (!bootstrapState || _isNativeStateCurrent(bootstrapState)) {
      isUpdatingHost = false;
    }
    if (error?.code === "NATIVE_FTS_STALE_GENERATION") throw error;
    if (error?.code === "NATIVE_FTS_UNSUPPORTED") throw error;
    // Expected when the helper isn't installed; rate-limited by the reconnect
    // cooldown so it won't spam. warn (not error) to avoid drowning real errors.
    log(`[TMDBG FTS] Update check failed: ${error.message}`, "warn");
    // Don't throw - allow FTS to work even if update check fails
    return false;
  }
}

/**
 * Connect to native FTS helper
 */
export function initNativeFts() {
  if (nativeInitializationPromise) return nativeInitializationPromise;
  const initialization = _initNativeFtsOnce();
  nativeInitializationPromise = initialization;
  // Publish the exact promise before observing rejection. Even when
  // connectNative throws before the async initializer reaches its first
  // await, this handler runs in a later microtask and clears only this cached
  // generation. A newer reconnect promise is never cleared by a stale tail.
  initialization.catch(() => {
    if (nativeInitializationPromise === initialization) {
      nativeInitializationPromise = null;
      nativeInitializationState = null;
    }
  });
  return initialization;
}

async function _initNativeFtsOnce() {
  log("[TMDBG FTS] Connecting to native FTS helper");
  lastConnectAttemptMs = Date.now();
  let connectedPort = null;
  let connectedReadyState = null;

  try {
    nativePort = browser.runtime.connectNative("tabmail_fts");
    connectedPort = nativePort;
    connectedReadyState = _createNativeReadyState(connectedPort);
    nativeReadyState = connectedReadyState;
    nativeInitializationState = connectedReadyState;
    hostInfo = null;
    
    // Handle responses
    connectedPort.onMessage.addListener((msg) => {
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
    connectedPort.onDisconnect.addListener(() => {
      log("[TMDBG FTS] Native helper disconnected");
      if (nativePort !== connectedPort) return;
      _rejectNativeReady(connectedReadyState, new Error("Native helper disconnected before hello"));
      nativePort = null;
      hostInfo = null;
      nativeReadyState = null;
      if (nativeInitializationState === connectedReadyState) {
        nativeInitializationPromise = null;
        nativeInitializationState = null;
      }
      // A disconnect during an intentional self-update is expected (we reconnect
      // below); otherwise the helper is gone/unavailable.
      if (!isUpdatingHost && ftsHostStatus.status !== "unsupported") {
        setFtsHostStatus("missing");
      }
      
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
    const updated = await initCheckAndUpdateHost(connectedReadyState);
    if (updated) {
      log("[TMDBG FTS] Host update initiated. Waiting for restart...");
      // updateRequest success is committed even if the old process has already
      // exited. Its onDisconnect owns the reconnect; only the new generation's
      // successful init may publish operational/available state.
      return true;
    }
    
    // Initialize the native helper
    // The helper auto-detects TB profile and handles migration from old location
    const manifest = browser.runtime.getManifest();
    const addonId = manifest.browser_specific_settings?.gecko?.id || "thunderbird@tabmail.ai";
    const initResult = await nativeRPC(
      'init',
      { addonId },
      { bootstrapPhase: "init", expectedState: connectedReadyState },
    );
    log(`[TMDBG FTS] DB initialized at: ${initResult.dbPath}`);
    setFtsHostStatus("available", {
      hostVersion: connectedReadyState.hostInfo?.hostVersion,
    });

    log("[TMDBG FTS] Native FTS helper connected successfully");

    // NOTE: Version check + auto-reindex is handled by initFtsEngine() in engine.js
    // AFTER attachCommandInterface() is called. Do NOT trigger reindex here — the
    // runtime message handler isn't registered yet and the message would be lost.

    return true;
  } catch (error) {
    const ownsPublicState = connectedReadyState
      ? _isNativeStateCurrent(connectedReadyState)
      : nativeReadyState === null && nativePort === null;
    _rejectNativeReady(connectedReadyState, error);
    if (connectedReadyState && nativeReadyState === connectedReadyState) {
      if (nativePort === connectedPort) nativePort = null;
      hostInfo = null;
      nativeReadyState = null;
    }
    // A failed owned bootstrap must not leave a live native process/port
    // detached from the adapter. Clear ownership first so the synchronous
    // onDisconnect tail cannot repeat cleanup; stale A can never close B.
    if (ownsPublicState && connectedPort) {
      try { connectedPort.disconnect(); } catch (_) {}
    }
    if (ownsPublicState && error?.code !== "NATIVE_FTS_UNSUPPORTED") {
      setFtsHostStatus("missing");
    }
    log(`[TMDBG FTS] Failed to connect to native helper: ${error.message}`);
    throw error;
  }
}

/**
 * Reconnect to native helper if disconnected
 */
async function ensureConnected() {
  if (nativePort) {
    try {
      await _awaitCurrentNativeOperational();
      return true;
    } catch (_) {
      if (nativePort) return false;
    }
  }

  // Circuit breaker: if the helper is unavailable, only re-attempt once per
  // cooldown instead of on every RPC (otherwise initNativeFts spams
  // "Native helper disconnected" / "Update check failed" continuously).
  if (getFtsHostAvailability() === false && (Date.now() - lastConnectAttemptMs) < RECONNECT_COOLDOWN_MS) {
    return false;
  }

  log("[TMDBG FTS] Attempting to reconnect to native helper...");
  try {
    await initNativeFts();
    await _awaitCurrentNativeOperational();
    return true;
  } catch (e) {
    log(`[TMDBG FTS] Reconnection failed: ${e.message || e}`, "warn");
    return false;
  }
}

/**
 * Send RPC to native helper (auto-reconnects if needed)
 */
async function nativeRPC(
  method,
  paramsOrFactory,
  { bootstrapPhase = null, expectedState = null } = {},
) {
  let ready = null;
  // Bootstrap has two ordered readiness phases on the same port generation:
  // hello publishes capabilities, then init earns operational readiness.
  // General external RPCs cannot bypass the latter.
  if (bootstrapPhase === "hello") {
    if (method !== "hello" || !expectedState) {
      throw new Error("Native FTS hello bootstrap state invalid");
    }
    _assertNativeStateCurrent(expectedState, "hello bootstrap");
    ready = { state: expectedState, info: null };
  } else if (bootstrapPhase === "preinit" || bootstrapPhase === "init") {
    if (!expectedState) throw new Error("Native FTS bootstrap generation missing");
    ready = await _awaitNativeHello(expectedState);
  } else {
    const reconnected = await ensureConnected();
    if (!reconnected || !nativePort) {
      throw new Error("Native FTS helper not connected");
    }
    ready = await _awaitCurrentNativeOperational();
  }
  const rpcReadyState = ready?.state;
  _assertNativeStateCurrent(rpcReadyState, `${method} dispatch`);
  const rpcPort = rpcReadyState.port;
  // Capability-dependent request shaping must happen after the hello for the
  // port that will receive this RPC. In particular, a reconnect may replace a
  // capable helper with a legacy one (or vice versa) between API invocation
  // and this point.
  const params = typeof paramsOrFactory === "function"
    ? paramsOrFactory(ready?.info || null)
    : paramsOrFactory;
  
  const id = `rpc-${++messageId}`;
  const RPC_TIMEOUT_MS = SETTINGS?.memoryManagement?.nativeRpcTimeoutMs || 60_000;

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingRPCs.has(id)) {
          pendingRPCs.delete(id);
          reject(new Error(`Native RPC '${method}' timed out after ${RPC_TIMEOUT_MS}ms`));
        }
      }, RPC_TIMEOUT_MS);

      pendingRPCs.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      try {
        rpcPort.postMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pendingRPCs.delete(id);
        reject(error);
      }
    });
  } catch (error) {
    if (bootstrapPhase === "hello") _rejectNativeReady(rpcReadyState, error);
    if (bootstrapPhase === "init") _rejectNativeOperational(rpcReadyState, error);
    throw error;
  }
  if (bootstrapPhase === "hello") {
    if (rpcReadyState !== nativeReadyState
        || rpcPort !== nativePort
        || !_resolveNativeHello(rpcReadyState, result)) {
      throw new Error("Native FTS hello completed for a stale connection generation");
    }
  } else if (bootstrapPhase === "init") {
    if (rpcReadyState !== nativeReadyState
        || rpcPort !== nativePort
        || !_resolveNativeOperational(rpcReadyState, result)) {
      throw new Error("Native FTS init completed for a stale connection generation");
    }
  }
  return result;
}

/**
 * FTS API - same interface as before but using native helper
 */
export const nativeFtsSearch = {
  async init() {
    return nativeRPC('init', {});
  },
  
  async indexBatch(rows) {
    // `folderId` is an additive wire field.  Older helpers did not advertise
    // the contract and must keep receiving the byte-for-byte legacy row shape.
    // New helpers accept only a non-empty opaque app-owned membership id.
    return nativeRPC('indexBatch', connectionHostInfo => {
      const includeFolderId = connectionHostInfo?.capabilities?.folderMembershipV1 === true;
      const wireRows = (rows || []).map(row => {
        const { folderId, ...legacyRow } = row || {};
        if (includeFolderId) {
          if (typeof folderId !== "string" || folderId.length === 0) {
            throw new Error("Native FTS capable index row is missing opaque folderId");
          }
          return { ...legacyRow, folderId };
        }
        return legacyRow;
      });
      return { rows: wireRows };
    });
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
  
  async optimize() {
    const result = await nativeRPC('optimize', {});
    if (result?.ok !== true) {
      throw new Error("Native FTS optimize returned an invalid response");
    }
    return result;
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

  async findByHeaderMessageId(accountId, headerMessageId) {
    return nativeRPC('findByHeaderMessageId', { accountId, headerMessageId });
  },

  async queryByDateRange(from, to, limit = 1000) {
    return nativeRPC('queryByDateRange', { from, to, limit });
  },

  // Generic msgId key-range RPCs (PLAN_FOLDER_SET_RECONCILE.md). Half-open
  // range [startKey, endKey) over the unsharded message_ids PK. Requires
  // native helper ≥ 0.10.0 — older helpers reject with "Unknown reader
  // method" (the folder reconcile feature-detects and no-ops).
  async countMsgIdRange(startKey, endKey) {
    return nativeRPC('countMsgIdRange', { startKey, endKey });
  },

  // Collision-resistant digest of the ordered msgId set. Requires helper
  // ≥ 0.11.0 and is used by startup folder reconciliation.
  async fingerprintMsgIdRange(startKey, endKey) {
    return nativeRPC('fingerprintMsgIdRange', { startKey, endKey });
  },

  async listMsgIdRange(startKey, endKey, afterKey, limit) {
    return nativeRPC('listMsgIdRange', { startKey, endKey, afterKey, limit });
  },

  supportsFolderMembership,

  async listFolderMembership(folderId, afterMsgId, limit) {
    const result = await nativeRPC('listFolderMembership', {
      folderId,
      afterMsgId,
      limit,
    });
    if (result?.ok !== true
        || !Array.isArray(result.msgIds)
        || typeof result.done !== "boolean"
        || result.msgIds.some(msgId => typeof msgId !== "string" || msgId.length === 0)) {
      throw new Error("Native FTS folder membership list returned an invalid response");
    }
    return result;
  },

  async listFolderMembershipState(afterMsgId, limit) {
    const result = await nativeRPC('listFolderMembershipState', {
      afterMsgId,
      limit,
    });
    if (result?.ok !== true
        || !Array.isArray(result.entries)
        || typeof result.done !== "boolean"
        || result.entries.some(entry => !entry
          || typeof entry.msgId !== "string"
          || entry.msgId.length === 0
          || (entry.folderId !== null
            && (typeof entry.folderId !== "string" || entry.folderId.length === 0)))) {
      throw new Error("Native FTS folder membership state list returned an invalid response");
    }
    return result;
  },

  async assignFolderMembershipBatch(assignments) {
    const result = await nativeRPC('assignFolderMembershipBatch', { assignments });
    const accounted = Number(result?.assigned)
      + Number(result?.alreadyAssigned)
      + Number(result?.missing);
    if (result?.ok !== true
        || !Number.isSafeInteger(result.assigned)
        || result.assigned < 0
        || !Number.isSafeInteger(result.alreadyAssigned)
        || result.alreadyAssigned < 0
        || !Number.isSafeInteger(result.missing)
        || result.missing < 0
        || accounted !== assignments.length) {
      throw new Error("Native FTS folder membership assignment returned an invalid response");
    }
    return result;
  },

  async debugSample() {
    return nativeRPC('debugSample', {});
  },

  // Non-destructive: rebuild vector embeddings from existing FTS data.
  // Does NOT clear the FTS5 keyword index or re-read emails from Thunderbird.
  // Uses batch-based RPC so FTS search remains accessible between batches.
  // Supports resumability: saves checkpoints to storage, resumes after interruption.
  async rebuildEmbeddings(progressCallback) {
    // Check for interrupted rebuild to resume from
    let resuming = false;
    let emailTotal = 0;
    let memoryTotal = 0;
    let lastRowid = 0;
    let totalProcessed = 0;
    let totalEmbedded = 0;
    let memLastRowid = 0;
    let memProcessed = 0;
    let memEmbedded = 0;
    let phase = 'email';

    try {
      const stored = await browser.storage.local.get(STORAGE_KEY_EMBEDDING_REBUILD_STATUS);
      const saved = stored[STORAGE_KEY_EMBEDDING_REBUILD_STATUS];
      if (saved?.interrupted) {
        resuming = true;
        emailTotal = saved.emailTotal || 0;
        memoryTotal = saved.memoryTotal || 0;
        phase = saved.phase || 'email';
        if (phase === 'email') {
          lastRowid = saved.emailLastRowid || 0;
          totalProcessed = saved.emailProcessed || 0;
          totalEmbedded = saved.emailEmbedded || 0;
        } else {
          totalProcessed = saved.emailProcessed || 0;
          totalEmbedded = saved.emailEmbedded || 0;
          memLastRowid = saved.memoryLastRowid || 0;
          memProcessed = saved.memoryProcessed || 0;
          memEmbedded = saved.memoryEmbedded || 0;
        }
        log(`[TMDBG FTS] Resuming interrupted embedding rebuild: phase=${phase}, emailProcessed=${totalProcessed}/${emailTotal}, memoryProcessed=${memProcessed}/${memoryTotal}`);
      }
    } catch (e) {
      log(`[TMDBG FTS] Failed to check for interrupted rebuild: ${e.message}`, "warn");
    }

    if (!resuming) {
      const start = await nativeRPC('rebuildEmbeddingsStart', {});
      emailTotal = start.emailTotal;
      memoryTotal = start.memoryTotal;
      log(`[TMDBG FTS] Embedding rebuild started: ${emailTotal} emails, ${memoryTotal} memory entries`);
    }

    let batchCount = 0;

    // Rebuild email embeddings in batches
    if (phase === 'email') {
      if (progressCallback) progressCallback({ phase: 'email', processed: totalProcessed, embedded: totalEmbedded, total: emailTotal });

      while (true) {
        const batch = await nativeRPC('rebuildEmbeddingsBatch', { target: 'email', lastRowid, batchSize: 500 });
        lastRowid = batch.lastRowid;
        totalProcessed += batch.processed;
        totalEmbedded += batch.embedded;
        batchCount++;

        if (progressCallback) progressCallback({ phase: 'email', processed: totalProcessed, embedded: totalEmbedded, total: emailTotal });

        // Save checkpoint every 10 batches (5000 rows)
        if (batchCount % 10 === 0) {
          try {
            await browser.storage.local.set({
              [STORAGE_KEY_EMBEDDING_REBUILD_STATUS]: {
                interrupted: true, emailTotal, memoryTotal,
                emailLastRowid: lastRowid, emailProcessed: totalProcessed, emailEmbedded: totalEmbedded,
                memoryLastRowid: 0, memoryProcessed: 0, memoryEmbedded: 0,
                phase: 'email', updatedAt: Date.now(),
              }
            });
          } catch (_) {}
        }

        if (batch.done) break;
      }
      log(`[TMDBG FTS] Email embeddings done: ${totalEmbedded}/${totalProcessed}`);
      phase = 'memory';
    }

    // Rebuild memory embeddings in batches
    if (progressCallback) progressCallback({ phase: 'memory', processed: memProcessed, embedded: memEmbedded, total: memoryTotal });

    while (true) {
      const batch = await nativeRPC('rebuildEmbeddingsBatch', { target: 'memory', lastRowid: memLastRowid, batchSize: 500 });
      memLastRowid = batch.lastRowid;
      memProcessed += batch.processed;
      memEmbedded += batch.embedded;
      batchCount++;

      if (progressCallback) progressCallback({ phase: 'memory', processed: memProcessed, embedded: memEmbedded, total: memoryTotal });

      if (batchCount % 10 === 0) {
        try {
          await browser.storage.local.set({
            [STORAGE_KEY_EMBEDDING_REBUILD_STATUS]: {
              interrupted: true, emailTotal, memoryTotal,
              emailLastRowid: lastRowid, emailProcessed: totalProcessed, emailEmbedded: totalEmbedded,
              memoryLastRowid: memLastRowid, memoryProcessed: memProcessed, memoryEmbedded: memEmbedded,
              phase: 'memory', updatedAt: Date.now(),
            }
          });
        } catch (_) {}
      }

      if (batch.done) break;
    }
    log(`[TMDBG FTS] Memory embeddings done: ${memEmbedded}/${memProcessed}`);

    // Clear checkpoint on successful completion
    try {
      await browser.storage.local.remove(STORAGE_KEY_EMBEDDING_REBUILD_STATUS);
    } catch (_) {}

    return {
      ok: true,
      emailTotal: totalProcessed,
      emailEmbedded: totalEmbedded,
      memoryTotal: memProcessed,
      memoryEmbedded: memEmbedded,
    };
  },

  // Get host info (version, install path, etc.)
  getHostInfo() {
    return hostInfo;
  },

  // Whether the native helper is installed + handshaked.
  // null = unknown/not yet attempted, true = available, false = missing.
  getHostAvailability() {
    return getFtsHostAvailability();
  },

  // Structured state for UI surfaces. `available` remains a separate legacy
  // boolean so existing callers continue to work; this distinguishes a missing
  // helper from an installed helper that is outside the signing-key window.
  getHostStatus() {
    return { ...ftsHostStatus };
  },

  // Force a fresh availability probe, bypassing the reconnect cooldown. Lets a
  // helper that was just installed (e.g. via the one-click installer) be picked
  // up WITHOUT restarting Thunderbird — native-messaging hosts are resolved at
  // connectNative() time, so no TB restart is required. Called by UI surfaces
  // (popup / settings) and the periodic recheck. Returns true once connected.
  async recheckAvailability() {
    if (nativePort) return true;
    // Already known-present and connecting/connected elsewhere — don't disturb.
    // Reset the cooldown so initNativeFts() actually re-attempts right now.
    lastConnectAttemptMs = 0;
    try {
      await initNativeFts();
    } catch (_) {
      // initNativeFts() records missing vs unsupported on failure.
    }
    return getFtsHostAvailability() === true;
  },
  
  // Mark current schema version as indexed (call after successful reindex)
  async markVersionAsIndexed() {
    if (hostInfo?.schemaVersion !== undefined) {
      await markSchemaVersionAsIndexed(hostInfo.schemaVersion);
    }
  },

  // Check if reindex is needed due to schema version change
  async checkReindexNeeded() {
    if (hostInfo?.schemaVersion === undefined) {
      // Pre-schemaVersion host (< 0.7.4): fall back to no reindex
      log(`[TMDBG FTS] Host does not report schemaVersion, skipping reindex check`);
      return { needsReindex: false, error: "Host does not support schemaVersion" };
    }
    return checkSchemaVersionChange(hostInfo.schemaVersion);
  },
  
  // Manually check for and apply updates (called from settings / maintenance)
  async manualCheckAndUpdateHost() {
    try {
      if (!hostInfo) {
        return { ok: false, error: "Host not connected" };
      }

      const currentVersion = hostInfo.hostVersion;
      log(`[TMDBG FTS] Manual update check - current version: ${currentVersion}`);

      const result = await fetchAndApplyUpdate(currentVersion, hostInfo.canSelfUpdate);

      if (!result.updateAvailable) {
        return { ok: true, updateAvailable: false, currentVersion, latestVersion: result.latestVersion, message: `Already up to date (v${currentVersion})` };
      }
      if (!result.canUpdate) {
        return { ok: true, updateAvailable: true, currentVersion, latestVersion: result.latestVersion, canUpdate: false, message: `Update available (${currentVersion} → ${result.latestVersion}) but cannot self-update. Please reinstall TabMail.` };
      }
      if (result.updated) {
        return { ok: true, updated: true, oldVersion: currentVersion, newVersion: result.newVersion, message: `Updated ${currentVersion} → ${result.newVersion}. Reconnecting automatically...` };
      }
      return { ok: false, error: result.error || "Update failed" };
    } catch (e) {
      isUpdatingHost = false;
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
 * Check if the native FTS helper is installed + handshaked.
 *
 * NOTE: connectNative() does NOT throw synchronously when the host manifest is
 * missing (the failure arrives asynchronously via the port's onDisconnect), so
 * a connect/disconnect probe can't tell us availability. The authoritative
 * signal is the structured init handshake outcome tracked in `ftsHostStatus`.
 * Returns true only when availability has been confirmed.
 */
export async function isNativeFtsAvailable() {
  return getFtsHostAvailability() === true;
}
