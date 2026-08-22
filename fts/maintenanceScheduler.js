/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * FTS Manual Maintenance
 * 
 * Retains explicit maintenance/repair commands with historical scopes:
 * - Hourly scan of last 1 day messages
 * - Daily scan of last 3 days messages  
 * - Weekly scan of last 3 weeks messages
 * - Monthly scan of last 3 months messages
 * 
 * Native FTS5 optimize:
 * - Daily/weekly/monthly maintenance requests one full native optimize call.
 * - The native protocol accepts no tuning parameters; the current helper
 *   returns { ok: true } and exposes no progress or convergence metrics.
 * - Optimize failure is non-critical to the completed repair scan and is logged
 *   truthfully for a later manual maintenance run.
 * 
 * Automatic alarms are retired; startup membership reconciliation now owns
 * consistency. The scheduling helpers remain private compatibility/test code.
 */

import { SETTINGS } from "../agent/modules/config.js";
import {
  acquireFtsExclusiveOperation,
  clearOwnedFtsScanStatus,
  writeOwnedFtsScanStatus,
} from "./operationCoordinator.js";
import { logFtsOperation } from "../agent/modules/eventLogger.js";
import { headerIDToWeID, log, parseUniqueId, recheckMessageInFolder } from "../agent/modules/utils.js";

/**
 * Format a timestamp with timezone information
 * @param {number|null} timestamp - Unix timestamp in milliseconds
 * @returns {object} Object with formatted dates and timezone info
 */
function formatTimestampWithTimezone(timestamp) {
  if (!timestamp) {
    return {
      localDate: 'Never',
      utcDate: 'Never',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset()
    };
  }
  
  const date = new Date(timestamp);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezoneOffset = date.getTimezoneOffset();
  
  // Format in user's local timezone (without timezone abbreviation)
  const localDatePart = date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  
  // Get generic timezone abbreviation (PT instead of PDT/PST for consistency)
  // Import getGenericTimezoneAbbr from helpers if needed, or implement inline
  let tzAbbr = '';
  try {
    // Get short timezone and normalize to generic abbreviation
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date);
    const part = parts.find((p) => p.type === "timeZoneName");
    const shortTz = (part?.value || "").replace(/\s/g, "");
    
    // Convert DST-aware abbreviations to generic ones
    if (shortTz === 'PDT' || shortTz === 'PST') {
      tzAbbr = 'PT';
    } else if (shortTz === 'MDT' || shortTz === 'MST') {
      tzAbbr = 'MT';
    } else if (shortTz === 'CDT' || shortTz === 'CST') {
      tzAbbr = 'CT';
    } else if (shortTz === 'EDT' || shortTz === 'EST') {
      tzAbbr = 'ET';
    } else {
      tzAbbr = shortTz;
    }
  } catch (_) {
    tzAbbr = 'GMT';
  }
  
  const localDate = `${localDatePart} ${tzAbbr}`;
  
  // Keep UTC for reference
  const utcDate = date.toISOString();
  
  return {
    localDate,
    utcDate, 
    timezone,
    timezoneOffset
  };
}

export { formatTimestampWithTimezone as _testFormatTimestampWithTimezone };

// Startup-tick deferral timing (see the deferral block further down).
// Values intentionally mirror RECONCILE_QUIET_PERIOD_MS / _CHECK_INTERVAL_MS /
// _MAX_WAIT_MS in incrementalIndexer.js (kept separate — independently tunable).
const STARTUP_TICK_QUIET_PERIOD_MS = 60 * 1000;
const STARTUP_TICK_CHECK_INTERVAL_MS = 10 * 1000;
const STARTUP_TICK_MAX_WAIT_MS = 10 * 60 * 1000;

// Test-only exports for pure internal functions
export const _testExports = {
  calculateDateRange,
  isWithinWeeklyScheduleWindow,
  pickDueMaintenanceType,
  cleanupMissingEntries,
  // Startup-tick deferral
  _scheduleStartupTickWhenQuiet,
  _hasStartupTickTimer: () => _startupTickTimer !== null,
  _clearStartupTickTimer: () => _clearStartupTickTimer(),
  // State accessors for test setup/teardown
  _setInitializedForTest: (v) => { _isInitialized = v; },
  _setFtsSearchForTest: (v) => { _ftsSearch = v; },
  STARTUP_TICK_QUIET_PERIOD_MS,
  STARTUP_TICK_CHECK_INTERVAL_MS,
  STARTUP_TICK_MAX_WAIT_MS,
};

// Maintenance schedule configuration
const MAINTENANCE_SCHEDULES = {
  hourly: {
    interval: 60,        // 60 minutes
    scope: 1,           // 1 day
    scopeUnit: 'days',
  },
  daily: {
    interval: 1440,     // 24 hours (1440 minutes)
    scope: 3,           // 3 days
    scopeUnit: 'days', 
  },
  weekly: {
    interval: 10080,    // 7 days (10080 minutes)
    scope: 3,           // 3 weeks
    scopeUnit: 'weeks',
  },
  monthly: {
    interval: 43200,    // 30 days (43200 minutes)
    scope: 3,           // 3 months  
    scopeUnit: 'months',
  }
};

// Retired tick-alarm definitions retained to clear alarms from older versions
// and to preserve deterministic manual/test helpers.
const MAINTENANCE_TICK_ALARM_NAME = "fts-maintenance-tick";
const MAINTENANCE_TYPE_ORDER = Object.freeze(["monthly", "weekly", "daily", "hourly"]);
const MAINTENANCE_COVERAGE = Object.freeze({
  monthly: ["weekly", "daily", "hourly"],
  weekly: ["daily", "hourly"],
  daily: ["hourly"],
  hourly: [],
});

// Legacy per-schedule alarm names (older versions created multiple alarms).
const LEGACY_MAINTENANCE_ALARM_NAMES = Object.freeze([
  "fts-maintenance-hourly",
  "fts-maintenance-daily",
  "fts-maintenance-weekly",
  "fts-maintenance-monthly",
]);

let _ftsSearch = null;
let _isInitialized = false;
let _alarmListener = null;

// ---------------------------------------------------------------------------
// Startup-tick deferral
// ---------------------------------------------------------------------------
// Running a due maintenance scan immediately at TB launch races the startup
// folder sync: messages.query can return inconsistent snapshots while msgDBs
// are loading, and cleanupMissingEntries would mark valid entries as stale.
// Mirror the boot-reconcile quiet wait (fts/incrementalIndexer.js): poll until
// there have been no sync events for STARTUP_TICK_QUIET_PERIOD_MS AND boot
// reconcile is no longer pending, with a hard cap. At the cap: if reconcile is
// DONE (merely never quiet — busy mailbox), the tick runs; if reconcile is
// STILL pending, the tick is skipped entirely (running would race reconcile)
// and the hourly alarm is the due-ness backstop. Trade-offs accepted: a due
// weekly scan whose Wed 9–12 window expires during the deferral slips to the
// next week (ADR-017), and when no listeners update the quiet signal (either
// incremental indexing disabled, or the tmMsgNotify experiment unavailable)
// the deferral degrades to a fixed ~60–70s delay — verify-then-remove remains
// the real protection there.
// Timing constants (STARTUP_TICK_*) are declared above _testExports near the
// top of the file (TDZ: _testExports references them at module evaluation).

let _startupTickTimer = null;

function _clearStartupTickTimer() {
  if (_startupTickTimer) {
    clearInterval(_startupTickTimer);
    _startupTickTimer = null;
  }
}

/**
 * Schedule the startup maintenance tick to run once TB's startup sync has
 * quieted down and the boot reconcile has completed (bounded by a hard cap).
 *
 * @param {Function} [runner] - Optional runner (defaults to
 *                              runScheduledMaintenanceTick). Injectable for testing.
 */
function _scheduleStartupTickWhenQuiet(runner = runScheduledMaintenanceTick) {
  const scheduledAt = Date.now();
  // One-shot guard: the interval callback awaits async state reads, so two
  // slow callbacks could overlap and both reach the run branch. Checked and
  // set synchronously at the decision point (no await between), so only one
  // can ever fire the runner per schedule.
  let fired = false;

  _clearStartupTickTimer();

  log(`[TMDBG FTS] Startup maintenance tick deferred — waiting for ${STARTUP_TICK_QUIET_PERIOD_MS / 1000}s sync quiet period + reconcile completion (max wait ${STARTUP_TICK_MAX_WAIT_MS / 1000}s)`);

  _startupTickTimer = setInterval(async () => {
    try {
      if (!_isInitialized || !_ftsSearch) {
        // Disposed while waiting — stop without running.
        _clearStartupTickTimer();
        return;
      }

      const now = Date.now();
      const waitedFor = now - scheduledAt;

      let quietFor = Infinity;
      let reconcilePending = false;
      try {
        const indexer = await import("./incrementalIndexer.js");
        quietFor = now - indexer.getLastSyncEventMs();
        reconcilePending = await indexer.isReconcilePending();
      } catch (e) {
        // Storage/read uncertainty cannot prove that reconciliation is idle.
        // Defer fairly until the next poll; the hard cap remains the backstop.
        quietFor = 0;
        reconcilePending = true;
        log(`[TMDBG FTS] Startup tick: indexer state unavailable (${e?.message || String(e)}) — deferring`, "warn");
      }

      const ready = quietFor >= STARTUP_TICK_QUIET_PERIOD_MS && !reconcilePending;
      if (!ready && waitedFor < STARTUP_TICK_MAX_WAIT_MS) {
        log(`[TMDBG FTS] Startup tick waiting — quietFor=${Math.round(quietFor / 1000)}s/${STARTUP_TICK_QUIET_PERIOD_MS / 1000}s, reconcilePending=${reconcilePending} (waited=${Math.round(waitedFor / 1000)}s)`);
        return;
      }

      if (!ready && reconcilePending) {
        // Hard cap reached while boot reconcile is still pending. Forcing the
        // scan now would run it concurrently with reconcile during the busy
        // startup this deferral exists to avoid (reconcile never sets
        // fts_scan_status, so runScheduledMaintenanceTick can't see it).
        // Skip the startup tick entirely — the hourly alarm is the backstop.
        log(`[TMDBG FTS] Startup maintenance tick skipped — max wait exceeded but reconcile still pending; next tick alarm retries when due (a weekly scan whose schedule window has passed slips to its next window)`, "warn");
        _clearStartupTickTimer();
        return;
      }

      if (fired) return; // a parallel slow callback already ran the tick
      fired = true;

      const reason = ready ? "quiet period reached + reconcile done" : "max wait exceeded";
      log(`[TMDBG FTS] Startup maintenance tick running — ${reason}`);

      _clearStartupTickTimer();
      await runner("startup");
    } catch (e) {
      log(`[TMDBG FTS] Startup maintenance tick failed: ${e?.message || String(e)}`, "warn");
      _clearStartupTickTimer();
    }
  }, STARTUP_TICK_CHECK_INTERVAL_MS);
}

/**
 * Initialize the maintenance scheduler
 */
export async function initMaintenanceScheduler(ftsSearch) {
  if (_isInitialized) return;
  
  _ftsSearch = ftsSearch;
  _isInitialized = true;
  
  // Periodic scans were replaced by the startup UID/FTS membership proof.
  // Migrate every previously-enabled installation and clear both current and
  // legacy alarms. Manual maintenance entry points remain available.
  await browser.storage.local.set({
    chat_ftsMaintenanceEnabled: false,
    chat_ftsMaintenanceHourlyEnabled: false,
    chat_ftsMaintenanceDailyEnabled: false,
    chat_ftsMaintenanceWeeklyEnabled: false,
    chat_ftsMaintenanceMonthlyEnabled: false,
    fts_periodic_scans_retired_v1: true,
  });
  await clearMaintenanceAlarms();
  _clearStartupTickTimer();

  // Do not attach an alarm listener: no automatic maintenance job exists.
  if (_alarmListener) {
    browser.alarms.onAlarm.removeListener(_alarmListener);
    _alarmListener = null;
  }
  log("[TMDBG FTS] Periodic maintenance retired; startup membership reconciliation active (manual repair remains available)");
}

/**
 * Dispose the maintenance scheduler
 */
export async function disposeMaintenanceScheduler(options = {}) {
  if (!_isInitialized) return;
  
  // Compatibility option for callers that want another legacy-alarm cleanup.
  const clearAlarms = options?.clearAlarms === true;
  if (clearAlarms) {
    await clearMaintenanceAlarms();
  }
  if (_alarmListener) {
    browser.alarms.onAlarm.removeListener(_alarmListener);
    _alarmListener = null;
  }
  _clearStartupTickTimer();
  _isInitialized = false;
  _ftsSearch = null;
  
  log("[TMDBG FTS] Maintenance scheduler disposed");
}

/**
 * Get maintenance settings from storage
 */
async function getMaintenanceSettings() {
  const stored = await browser.storage.local.get({
    chat_ftsMaintenanceEnabled: false,
    chat_ftsMaintenanceHourlyEnabled: false,
    chat_ftsMaintenanceDailyEnabled: false,
    chat_ftsMaintenanceWeeklyEnabled: false,
    chat_ftsMaintenanceMonthlyEnabled: false,
    chat_ftsMaintenanceWeeklyDay: 3, // 0=Sunday, 3=Wednesday (default)
    chat_ftsMaintenanceWeeklyHourStart: 9, // 9 AM
    chat_ftsMaintenanceWeeklyHourEnd: 12, // 12 PM (noon)
  });
  
  return {
    enabled: false,
    hourly: false,
    daily: false,
    weekly: false,
    monthly: false,
    weeklySchedule: {
      dayOfWeek: stored.chat_ftsMaintenanceWeeklyDay,
      hourStart: stored.chat_ftsMaintenanceWeeklyHourStart,
      hourEnd: stored.chat_ftsMaintenanceWeeklyHourEnd,
    },
  };
}

/**
 * Set up browser alarms for maintenance schedules
 */
async function setupMaintenanceAlarms() {
  // Kept as a private compatibility hook for settings messages from an older
  // options page. Periodic scheduling is retired unconditionally.
  await clearMaintenanceAlarms();
  log("[TMDBG FTS] Periodic maintenance scheduling request ignored — feature retired");
}

/**
 * Clear all maintenance alarms
 */
async function clearMaintenanceAlarms() {
  try {
    await browser.alarms.clear(MAINTENANCE_TICK_ALARM_NAME);
  } catch (_) {}
  // Also clear any legacy alarms from older versions.
  for (const alarmName of LEGACY_MAINTENANCE_ALARM_NAMES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await browser.alarms.clear(alarmName);
    } catch (_) {}
  }
  log("[TMDBG FTS] Cleared maintenance alarms (tick + legacy)");
}

/**
 * Handle alarm events for maintenance
 */
async function handleMaintenanceAlarm(alarm) {
  log(`[TMDBG FTS] Retired maintenance alarm ignored: ${alarm?.name || "unknown"}`, "warn");
}

/**
 * Check if current time is within the configured weekly schedule window.
 * @param {Object} weeklySchedule - { dayOfWeek: 0-6, hourStart: 0-23, hourEnd: 0-23 }
 * @returns {boolean} true if now is within the window
 */
function isWithinWeeklyScheduleWindow(weeklySchedule) {
  if (!weeklySchedule) return true; // No schedule configured = always allowed
  
  const now = new Date();
  const currentDay = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const currentHour = now.getHours();
  
  const { dayOfWeek, hourStart, hourEnd } = weeklySchedule;
  
  // Check if it's the right day
  if (currentDay !== dayOfWeek) {
    return false;
  }
  
  // Check if it's within the hour window
  if (currentHour < hourStart || currentHour >= hourEnd) {
    return false;
  }
  
  return true;
}

/**
 * Decide which maintenance type (if any) is due, using deterministic ordering:
 * monthly -> weekly -> daily -> hourly.
 *
 * Returns a type string or null.
 */
function pickDueMaintenanceType({ nowMs, settings, lastRunsByType }) {
  for (const type of MAINTENANCE_TYPE_ORDER) {
    if (!settings?.[type]) {
      continue;
    }

    const lastMs = lastRunsByType?.[type] || null;
    const intervalMs = MAINTENANCE_SCHEDULES[type].interval * 60 * 1000;

    // For weekly maintenance, also check if we're within the configured schedule window
    if (type === 'weekly' && settings.weeklySchedule) {
      const inWindow = isWithinWeeklyScheduleWindow(settings.weeklySchedule);
      if (!inWindow) {
        const { dayOfWeek, hourStart, hourEnd } = settings.weeklySchedule;
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        log(`[TMDBG FTS] Weekly maintenance not in schedule window (${dayNames[dayOfWeek]} ${hourStart}:00-${hourEnd}:00)`);
        continue;
      }
    }

    if (!lastMs) {
      log(`[TMDBG FTS] Maintenance due (never ran): type=${type}, intervalMin=${MAINTENANCE_SCHEDULES[type].interval}`);
      return type;
    }

    const ageMs = nowMs - lastMs;
    const due = ageMs >= intervalMs;
    log(`[TMDBG FTS] Maintenance due check: type=${type}, lastMs=${lastMs}, ageMs=${ageMs}, intervalMs=${intervalMs}, due=${due}`);

    if (due) {
      return type;
    }
  }
  return null;
}

async function getLastMaintenanceRunsByType() {
  const keys = MAINTENANCE_TYPE_ORDER.map((t) => `fts_maintenance_last_${t}`);
  const stored = await browser.storage.local.get(keys);
  const out = {};
  for (const type of MAINTENANCE_TYPE_ORDER) {
    const k = `fts_maintenance_last_${type}`;
    out[type] = stored?.[k] || null;
  }
  return out;
}

async function markMaintenanceCoverageCompleted({ primaryType, completedAtMs }) {
  const covered = MAINTENANCE_COVERAGE[primaryType] || [];
  const toSet = {};

  // Always update the primary type (for determinism in "last maintenance" keys).
  toSet[`fts_maintenance_last_${primaryType}`] = completedAtMs;

  for (const t of covered) {
    toSet[`fts_maintenance_last_${t}`] = completedAtMs;
  }

  await browser.storage.local.set(toSet);

  if (covered.length > 0) {
    log(`[TMDBG FTS] Maintenance coverage applied: primary=${primaryType}, covered=[${covered.join(", ")}], completedAt=${new Date(completedAtMs).toISOString()}`);
  } else {
    log(`[TMDBG FTS] Maintenance coverage applied: primary=${primaryType}, covered=[], completedAt=${new Date(completedAtMs).toISOString()}`);
  }
}

/**
 * One maintenance tick: checks due-ness for each schedule and runs at most ONE scan.
 * triggerSource is only used for logging.
 */
async function runScheduledMaintenanceTick(triggerSource) {
  if (!_ftsSearch) {
    throw new Error("FTS search not initialized");
  }

  const settings = await getMaintenanceSettings();
  if (!settings.enabled) {
    log(`[TMDBG FTS] Maintenance tick skipped (disabled) trigger=${triggerSource}`);
    return { ok: true, ran: false, reason: "disabled" };
  }

  // If any scan is already running, don't start maintenance (avoid overlap / long lock time).
  try {
    const { fts_scan_status } = await browser.storage.local.get("fts_scan_status");
    if (fts_scan_status?.isScanning) {
      log(`[TMDBG FTS] Maintenance tick skipped (scan in progress) trigger=${triggerSource} scanType=${fts_scan_status?.scanType || "unknown"} maintenanceType=${fts_scan_status?.maintenanceType || "n/a"}`, "warn");
      return { ok: true, ran: false, reason: "scan_in_progress" };
    }
  } catch (e) {
    log(`[TMDBG FTS] Maintenance tick: failed to read fts_scan_status: ${e?.message || String(e)}`, "warn");
  }

  const nowMs = Date.now();
  const lastRunsByType = await getLastMaintenanceRunsByType();

  // Log summary of last-runs for debugging ordering/coverage.
  try {
    log(`[TMDBG FTS] Maintenance tick snapshot trigger=${triggerSource}: lastRuns=${JSON.stringify(lastRunsByType)}`);
  } catch (_) {}

  const dueType = pickDueMaintenanceType({ nowMs, settings, lastRunsByType });
  if (!dueType) {
    log(`[TMDBG FTS] Maintenance tick: no maintenance due trigger=${triggerSource}`);
    return { ok: true, ran: false, reason: "not_due" };
  }

  // Optional: on DAILY maintenance run, check native FTS updates before the scan.
  if (dueType === "daily" && _ftsSearch?.manualCheckAndUpdateHost) {
    try {
      log(`[TMDBG FTS] Maintenance tick: checking for native FTS updates (before daily maintenance)`);
      const updateResult = await _ftsSearch.manualCheckAndUpdateHost();
      if (updateResult?.updated) {
        log(`[TMDBG FTS] ✅ Native FTS updated: ${updateResult.oldVersion} → ${updateResult.newVersion}`);
      } else if (updateResult?.updateAvailable && !updateResult?.canUpdate) {
        log(`[TMDBG FTS] ⚠️ Update available but cannot self-update: ${updateResult.message}`, "warn");
      } else {
        log(`[TMDBG FTS] Native FTS up to date: ${updateResult?.currentVersion || "unknown"}`);
      }
    } catch (e) {
      log(`[TMDBG FTS] Failed to check for native FTS updates: ${e?.message || String(e)}`, "warn");
    }
  }

  const config = MAINTENANCE_SCHEDULES[dueType];
  log(`[TMDBG FTS] Maintenance tick: running type=${dueType} (scope: ${config.scope} ${config.scopeUnit}) trigger=${triggerSource}`);

  const runResult = await runMaintenanceScan(dueType, config, false);
  const completedAtMs = Date.now();

  // Apply coverage: longer interval counts as shorter interval(s).
  await markMaintenanceCoverageCompleted({ primaryType: dueType, completedAtMs });

  return { ok: true, ran: true, type: dueType, completedAtMs, runResult };
}

/**
 * Clean up missing entries from the FTS database
 * This is an expensive operation that checks if entries still exist in Thunderbird
 * 
 * CHUNKING STRATEGY (prevents native FTS disconnection):
 * 1. Query in chunks (queryChunkSize) to avoid massive single RPC
 * 2. Validate in batches (validationBatchSize) with keepalive ping between batches
 * 3. Remove in chunks (removeBatchSize) to keep native messaging active
 * 
 * @param {Object} ftsSearch - FTS search interface
 * @param {Date} startDate - Start date for the cleanup range
 * @param {Date} endDate - End date for the cleanup range
 * @param {Object} options - Cleanup options
 * @returns {Promise<Object>} Cleanup results
 */
async function cleanupMissingEntries(ftsSearch, startDate, endDate, options = {}) {
  // Get chunking settings from config
  const cleanupConfig = SETTINGS?.ftsCleanup || {};
  const queryChunkSize = cleanupConfig.queryChunkSize || 500;
  const validationBatchSize = cleanupConfig.validationBatchSize || 50;
  const removeBatchSize = cleanupConfig.removeBatchSize || 100;
  // Delays use ?? (not ||): an explicit 0 means "no delay" and must be honored.
  const batchDelayMs = cleanupConfig.batchDelayMs ?? 100;
  const entryDelayMs = cleanupConfig.entryDelayMs ?? 50;
  
  // No hard cap - chunked pagination handles large datasets safely
  // Legacy option still accepted for backward compat but defaults to unlimited (0 = no limit)
  const maxEntries = options.maxEntries || 0; // 0 means no limit
  
  const hasLimit = maxEntries > 0;
  log(`[TMDBG FTS] Starting chunked cleanup from ${startDate.toISOString()} to ${endDate.toISOString()}`);
  log(`[TMDBG FTS] Chunk config: query=${queryChunkSize}, validation=${validationBatchSize}, remove=${removeBatchSize}, maxEntries=${hasLimit ? maxEntries : 'unlimited'}`);
  
  try {
    // =========================================================================
    // PHASE 1: Chunked Query - cursor-based pagination to keep native RPC responsive
    // =========================================================================
    // queryByDateRange returns results ordered by dateMs DESC (newest first).
    // We paginate by moving the "to" cursor backwards after each chunk.
    const allEntries = [];
    let queryChunkCount = 0;
    let cursorEndMs = endDate.getTime();
    const startMs = startDate.getTime();
    const seenMsgIds = new Set(); // Dedupe across chunks (edge case: same dateMs)
    
    log(`[TMDBG FTS] Phase 1: Querying entries in chunks of ${queryChunkSize} (cursor-based)`);
    
    // Loop until we've exhausted the date range (or hit optional limit)
    while (cursorEndMs > startMs && (!hasLimit || allEntries.length < maxEntries)) {
      const remainingLimit = hasLimit ? Math.min(queryChunkSize, maxEntries - allEntries.length) : queryChunkSize;
      
      // Query with current cursor window
      const cursorEndDate = new Date(cursorEndMs);
      const chunk = await ftsSearch.queryByDateRange(startDate, cursorEndDate, remainingLimit);
      queryChunkCount++;
      
      if (!chunk || chunk.length === 0) {
        log(`[TMDBG FTS] Query chunk ${queryChunkCount}: 0 entries (done)`);
        break;
      }
      
      // Dedupe and collect entries
      let newInChunk = 0;
      for (const entry of chunk) {
        if (!seenMsgIds.has(entry.msgId)) {
          seenMsgIds.add(entry.msgId);
          allEntries.push(entry);
          newInChunk++;
        }
      }
      
      log(`[TMDBG FTS] Query chunk ${queryChunkCount}: ${chunk.length} fetched, ${newInChunk} new (total: ${allEntries.length})`);
      
      // If we got fewer than requested, we've exhausted the range
      if (chunk.length < remainingLimit) {
        break;
      }
      
      // Move cursor backwards. Results are DESC, so last entry in chunk is
      // the oldest. The step is INCLUSIVE of the oldest dateMs when the chunk
      // made progress — an exclusive `- 1` step would permanently skip
      // entries sharing that millisecond beyond a full-chunk boundary (Date
      // headers have second granularity, so ties are routine in bursts);
      // seenMsgIds dedups the re-fetched boundary ties. If the ENTIRE chunk
      // was already seen (a full chunk sharing one ms), step past it.
      const oldestInChunk = chunk[chunk.length - 1];
      const oldestDateMs = oldestInChunk?.dateMs;

      if (typeof oldestDateMs !== 'number' || oldestDateMs <= startMs) {
        log(`[TMDBG FTS] Query cursor reached start boundary`);
        break;
      }

      const nextCursorMs = newInChunk > 0 ? oldestDateMs : oldestDateMs - 1;

      // Safety: the cursor must never move forward
      if (nextCursorMs > cursorEndMs) {
        log(`[TMDBG FTS] Query cursor stuck, breaking`);
        break;
      }
      cursorEndMs = nextCursorMs;
      
      // Small yield between query chunks
      await new Promise(resolve => setTimeout(resolve, batchDelayMs));
    }
    
    if (allEntries.length === 0) {
      log(`[TMDBG FTS] No entries found in date range for cleanup`);
      return { processed: 0, removed: 0 };
    }
    
    log(`[TMDBG FTS] Phase 1 complete: ${allEntries.length} entries to validate (${queryChunkCount} chunks)`);

    // =========================================================================
    // PHASE 1.5: Account liveness check — abort cleanup if any account is not queryable.
    // After MV3 resume, TB may not have loaded all accounts' message databases yet.
    // If messages.query returns empty for a valid account, headerIDToWeID returns null,
    // causing mass false-stale removals. We verify each account has at least one
    // queryable message before trusting null results.
    // =========================================================================
    const accountIds = new Set();
    for (const entry of allEntries) {
      const parsed = parseUniqueId(entry.msgId);
      if (parsed?.weFolder?.accountId) {
        accountIds.add(parsed.weFolder.accountId);
      }
    }

    const unavailableAccounts = new Set();
    for (const accountId of accountIds) {
      try {
        const acct = await browser.accounts.get(accountId);
        if (!acct) {
          log(`[TMDBG FTS] Cleanup: account ${accountId} not found — skipping its entries`, "warn");
          unavailableAccounts.add(accountId);
          continue;
        }
        // Verify we can actually query messages in this account
        const folders = await browser.folders.query({ accountId, limit: 1 });
        if (!folders || folders.length === 0) {
          log(`[TMDBG FTS] Cleanup: account ${accountId} has no queryable folders — skipping its entries`, "warn");
          unavailableAccounts.add(accountId);
        }
      } catch (e) {
        log(`[TMDBG FTS] Cleanup: account ${accountId} check failed (${e.message}) — skipping its entries`, "warn");
        unavailableAccounts.add(accountId);
      }
    }

    if (unavailableAccounts.size > 0) {
      log(`[TMDBG FTS] Cleanup: ${unavailableAccounts.size}/${accountIds.size} accounts unavailable — filtering entries`);
      logFtsOperation("maintenance_stale", "accounts_unavailable", {
        unavailable: Array.from(unavailableAccounts),
        total: accountIds.size,
      });
    }

    // =========================================================================
    // PHASE 2: Chunked Validation - process in batches with keepalive pings
    // =========================================================================
    const staleCandidates = [];
    let processed = 0;
    
    log(`[TMDBG FTS] Phase 2: Validating entries in batches of ${validationBatchSize}`);
    
    for (let batchStart = 0; batchStart < allEntries.length; batchStart += validationBatchSize) {
      const batch = allEntries.slice(batchStart, batchStart + validationBatchSize);
      const batchNum = Math.floor(batchStart / validationBatchSize) + 1;
      const totalBatches = Math.ceil(allEntries.length / validationBatchSize);
      
      // Process each entry in the batch
      for (const entry of batch) {
        try {
          // Parse the uniqueId to extract headerID and folder info
          const parsed = parseUniqueId(entry.msgId);
          if (!parsed) {
            log(`[TMDBG FTS] Skipping invalid msgId format: ${entry.msgId}`, "warn");
            processed++;
            continue;
          }
          
          const { weFolder, headerID } = parsed;

          // Skip entries for accounts that aren't queryable (prevents mass false-stale removals)
          if (unavailableAccounts.has(weFolder?.accountId)) {
            processed++;
            continue;
          }

          // Use headerIDToWeID with folder constraint to check if message still exists
          // Disable global fallback to ensure we only find messages in their original folders
          const weID = await headerIDToWeID(headerID, weFolder, false, false);
          
          if (!weID) {
            // Message not found at its indexed folder — stale CANDIDATE.
            // Confirmed (or refuted) by the verify-then-remove pass (Phase 2.5).
            staleCandidates.push({
              msgId: entry.msgId,
              headerID,
              weFolder,
              subject: String(entry?.subject || ""),
              dateMs: Number(entry?.dateMs || 0),
            });
            logFtsOperation("maintenance_stale", "found", {
              msgId: entry.msgId,
              folderPath: weFolder?.path || "",
              headerID,
              subject: entry.subject || "",
            });
          }
          
          processed++;
          
          // Small per-entry delay to avoid overwhelming TB APIs
          if (entryDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, entryDelayMs));
          }
          
        } catch (error) {
          log(`[TMDBG FTS] Error checking entry ${entry.msgId}: ${error.message}`, "warn");
          // On error, skip — do NOT remove on uncertainty. Only confirmed-stale entries
          // should be removed. Transient errors (folder not synced, TB API timeout after
          // MV3 restart) would otherwise cause permanent data loss.
          logFtsOperation("maintenance_stale", "error_skipped", {
            msgId: entry.msgId,
            error: String(error.message || error),
          });
          processed++;
        }
      }
      
      // KEEPALIVE: Send a lightweight native RPC after each batch to keep connection alive
      try {
        await ftsSearch.stats();
      } catch (keepaliveErr) {
        log(`[TMDBG FTS] Keepalive ping failed after batch ${batchNum}: ${keepaliveErr.message}`, "warn");
      }
      
      // Report progress
      log(`[TMDBG FTS] Validation batch ${batchNum}/${totalBatches}: ${processed}/${allEntries.length} processed, ${staleCandidates.length} stale candidates`);

      // Yield between batches
      if (batchDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, batchDelayMs));
      }
    }

    log(`[TMDBG FTS] Phase 2 complete: ${processed} validated, ${staleCandidates.length} stale candidates`);

    // =========================================================================
    // PHASE 2.5: Verify-then-remove - re-check every candidate before removal
    // =========================================================================
    // A folder-constrained miss can be a transient msgDB state (mid-sync at
    // startup, compaction, IMAP resync) — observed 2026-06-03: a live message
    // in [Gmail]/Bin was removed as "missing" and only recovered by the next
    // weekly scan a week later. Re-check each candidate with a fresh GLOBAL
    // headerMessageId query and only remove keys whose absence from their
    // indexed folder is confirmed by a SUCCESSFUL query. Thrown queries keep
    // the entry (skip on uncertainty); the next scan retries.
    const entriesToRemove = [];
    // Keyed by msgId so a failed Phase 3 remove chunk can prune its entries —
    // details must only report removals that actually happened.
    const removedDetailsByMsgId = new Map();
    let recheckKeptPresent = 0;
    let recheckKeptError = 0;
    let recheckedCount = 0;

    for (const cand of staleCandidates) {
      // KEEPALIVE: same cadence as Phase 2 — a mass-deletion scenario can
      // produce thousands of candidates, and the per-entry delay would
      // otherwise leave the native FTS connection without RPC for minutes.
      if (recheckedCount > 0 && recheckedCount % validationBatchSize === 0) {
        try {
          await ftsSearch.stats();
        } catch (keepaliveErr) {
          log(`[TMDBG FTS] Phase 2.5 keepalive ping failed: ${keepaliveErr.message}`, "warn");
        }
      }
      recheckedCount++;

      const verdict = await recheckMessageInFolder(cand.headerID, cand.weFolder);
      if (verdict === "absent") {
        // Only an explicit, successful confirmation of absence may remove —
        // any other verdict (present, error, unexpected) keeps the entry.
        entriesToRemove.push(cand.msgId);
        removedDetailsByMsgId.set(cand.msgId, {
          action: "removedMissing",
          msgId: cand.msgId,
          folderPath: String(cand.weFolder?.path || ""),
          headerID: String(cand.headerID || ""),
          subject: cand.subject,
          dateMs: cand.dateMs,
        });
      } else if (verdict === "present") {
        recheckKeptPresent++;
        log(`[TMDBG FTS] Phase 2.5: recheck found ${cand.msgId} still present — keeping (transient miss)`);
        logFtsOperation("maintenance_stale", "recheck_present", { msgId: cand.msgId });
      } else {
        recheckKeptError++;
        log(`[TMDBG FTS] Phase 2.5: recheck errored for ${cand.msgId} — keeping (unconfirmed)`, "warn");
        logFtsOperation("maintenance_stale", "recheck_error", { msgId: cand.msgId });
      }

      // Small per-entry delay to avoid overwhelming TB APIs
      if (entryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, entryDelayMs));
      }
    }

    log(`[TMDBG FTS] Phase 2.5 complete: ${entriesToRemove.length} confirmed for removal, ${recheckKeptPresent} kept (present on recheck), ${recheckKeptError} kept (recheck error)`);

    // =========================================================================
    // PHASE 3: Chunked Removal - remove in batches to keep native RPC active
    // =========================================================================
    let removedCount = 0;
    
    if (entriesToRemove.length > 0) {
      log(`[TMDBG FTS] Phase 3: Removing ${entriesToRemove.length} entries in batches of ${removeBatchSize}`);
      // Log each entry being removed for debugging
      for (const msgId of entriesToRemove) {
        logFtsOperation("maintenance_remove", "removing", { msgId });
      }

      for (let removeStart = 0; removeStart < entriesToRemove.length; removeStart += removeBatchSize) {
        const removeChunk = entriesToRemove.slice(removeStart, removeStart + removeBatchSize);
        const removeChunkNum = Math.floor(removeStart / removeBatchSize) + 1;
        const totalRemoveChunks = Math.ceil(entriesToRemove.length / removeBatchSize);
        
        try {
          const removeResult = await ftsSearch.removeBatch(removeChunk);
          removedCount += removeResult.count || 0;
          log(`[TMDBG FTS] Remove batch ${removeChunkNum}/${totalRemoveChunks}: ${removeResult.count || 0} removed (total: ${removedCount})`);
        } catch (removeErr) {
          log(`[TMDBG FTS] Remove batch ${removeChunkNum} failed: ${removeErr.message}`, "warn");
          // These entries are still in FTS — they must not appear in the
          // maintenance history as removed. Next scan re-nominates them.
          for (const msgId of removeChunk) {
            removedDetailsByMsgId.delete(msgId);
          }
        }

        // Small delay between remove batches
        if (removeStart + removeBatchSize < entriesToRemove.length) {
          await new Promise(resolve => setTimeout(resolve, batchDelayMs));
        }
      }
    }

    log(`[TMDBG FTS] Phase 3 complete: ${removedCount} removed`);
    log(`[TMDBG FTS] Cleanup completed: ${processed} processed, ${removedCount} removed`);

    return { processed, removed: removedCount, removedDetails: Array.from(removedDetailsByMsgId.values()) };
    
  } catch (error) {
    log(`[TMDBG FTS] Cleanup failed: ${error.message}`, "error");
    throw error;
  }
}

/**
 * Run a maintenance scan for the given schedule
 */
async function runMaintenanceScan(scheduleType, config, force = false, progressCallback = null) {
  if (!_ftsSearch) {
    throw new Error("FTS search not initialized");
  }
  
  // Note: Keepalive is always-on, no need to start/stop
  
  const lastScanKey = `fts_maintenance_last_${scheduleType}`;
  const now = Date.now();

  if (force) {
    log(`[TMDBG FTS] Force-running ${scheduleType} maintenance scan (ignoring scheduler due-ness)`);
  }
  
  // Initialize result variables
  let result = { indexed: 0, skipped: 0 };
  let cleanupResult = { processed: 0, removed: 0 };
  let combinedCorrectionDetails = [];
  let combinedCorrectionDetailsTruncated = false;
  const operationLease = await acquireFtsExclusiveOperation(`maintenance:${scheduleType}`);

  try {
    // Set scan status to indicate maintenance scan is in progress
    await writeOwnedFtsScanStatus(operationLease, {
      scanType: "maintenance",
      maintenanceType: scheduleType,
      startTime: now,
      progress: {
        folder: "",
        totalIndexed: 0,
        totalBatches: 0,
      },
    });
    
    // Calculate date range for this scan
    const dateRange = calculateDateRange(config.scope, config.scopeUnit);
    log(`[TMDBG FTS] ${scheduleType} scan: checking messages from ${dateRange.start.toISOString()} to ${dateRange.end.toISOString()}`);
    
    // Run the maintenance scan
    const { indexMessages } = await import("./indexer.js");
    const maxDetailEntries = Number(SETTINGS?.ftsMaintenanceLog?.maxCorrectionEntriesPerRun) || 0;
    result = await indexMessages(_ftsSearch, progressCallback || (() => {}), dateRange.start, dateRange.end, {
      collectDetails: true,
      maxDetailEntries,
    });
    
    // Run cleanup of missing entries for comprehensive maintenance scans (daily, weekly, monthly)
    if (scheduleType === 'daily' || scheduleType === 'weekly' || scheduleType === 'monthly') {
      try {
        log(`[TMDBG FTS] Running cleanup of missing entries after ${scheduleType} maintenance`);
        
        // No entry limits - chunked pagination handles large datasets safely
        // Cleanup will process all entries in the date range
        cleanupResult = await cleanupMissingEntries(_ftsSearch, dateRange.start, dateRange.end, {
          // maxEntries: 0 means unlimited (default)
        });
        log(`[TMDBG FTS] Cleanup completed: ${cleanupResult.processed} processed, ${cleanupResult.removed} removed`);
      } catch (e) {
        log(`[TMDBG FTS] Cleanup failed: ${e.message}`, "warn");
      }
    }

    // Combine correction details for UI/debug (bounded per SETTINGS.ftsMaintenanceLog.maxCorrectionEntriesPerRun).
    try {
      const maxDetailEntries = Number(SETTINGS?.ftsMaintenanceLog?.maxCorrectionEntriesPerRun) || 0;
      const limit = Number.isFinite(maxDetailEntries) && maxDetailEntries > 0 ? maxDetailEntries : 0;
      const a = Array.isArray(result?.correctionDetails) ? result.correctionDetails : [];
      const b = Array.isArray(cleanupResult?.removedDetails) ? cleanupResult.removedDetails : [];
      const combined = a.concat(b);
      if (limit > 0) {
        combinedCorrectionDetails = combined.slice(0, limit);
        combinedCorrectionDetailsTruncated = combined.length > limit;
      } else {
        combinedCorrectionDetails = [];
        combinedCorrectionDetailsTruncated = combined.length > 0;
      }
      log(`[TMDBG FTS] Maintenance corrections detail: total=${combined.length}, stored=${combinedCorrectionDetails.length}, truncated=${combinedCorrectionDetailsTruncated}`);
    } catch (e) {
      log(`[TMDBG FTS] Failed to build maintenance correction details: ${e?.message || String(e)}`, "warn");
    }
    
    if (scheduleType === 'daily' || scheduleType === 'weekly' || scheduleType === 'monthly') {
      log(`[TMDBG FTS] Running full native FTS5 optimize after ${scheduleType} maintenance`);
      try {
        const optimizeResult = await _ftsSearch.optimize();
        if (optimizeResult?.ok !== true) {
          throw new Error("invalid response");
        }
        log(`[TMDBG FTS] Native FTS5 optimize completed after ${scheduleType} maintenance`);
      } catch (e) {
        log(`[TMDBG FTS] Native FTS5 optimize failed: ${e?.message || String(e)}`, "warn");
      }
    }
    
    // Update last scan timestamp (success only)
    await browser.storage.local.set({
      [lastScanKey]: Date.now()
    });
    
    // Log the maintenance run to history
    await logMaintenanceRun(scheduleType, result, cleanupResult, {
      correctionDetails: combinedCorrectionDetails,
      correctionDetailsTruncated: combinedCorrectionDetailsTruncated,
    });
      
    const scannedMessages = result?.scanned ?? result?.indexed ?? 0;
    const correctedIndexed = result?.newlyIndexed ?? 0;
    const correctedRemoved = cleanupResult?.removed || 0;
    log(`[TMDBG FTS] ${scheduleType} maintenance completed: ${scannedMessages} messages scanned, ${correctedIndexed + correctedRemoved} corrected (${correctedIndexed} indexed, ${correctedRemoved} removed), ${result.skipped} skipped`);

    return {
      ok: true,
      scheduleType,
      // Back-compat: config UI expects "indexed" for "messages processed/scanned"
      indexed: scannedMessages,
      scanned: scannedMessages,
      corrected: correctedIndexed + correctedRemoved,
      correctedIndexed,
      correctedRemoved,
      skipped: result?.skipped || 0,
      cleanupProcessed: cleanupResult?.processed || 0,
      cleanupRemoved: cleanupResult?.removed || 0,
    };
  } finally {
    try {
      await clearOwnedFtsScanStatus(operationLease, { lastMaintenanceType: scheduleType });
    } finally {
      operationLease.release();
    }
  }
}

/**
 * Log a maintenance run to the history
 * @param {string} scheduleType - Type of maintenance (hourly, daily, weekly, monthly)
 * @param {Object} result - Result from indexMessages
 * @param {Object} cleanupResult - Result from cleanupMissingEntries
 */
async function logMaintenanceRun(scheduleType, result, cleanupResult, extra = {}) {
  try {
    const scannedMessages = result?.scanned ?? result?.indexed ?? 0;
    const correctedIndexed = result?.newlyIndexed ?? 0;
    const correctedRemoved = cleanupResult?.removed || 0;
    const correctedTotal = correctedIndexed + correctedRemoved;

    const logEntry = {
      type: scheduleType,
      timestamp: Date.now(),
      // Back-compat: keep "indexed" but it actually means "scanned/processed"
      indexed: scannedMessages,
      scanned: scannedMessages,
      corrected: correctedTotal,
      correctedIndexed,
      correctedRemoved,
      skipped: result?.skipped || 0,
      cleanupProcessed: cleanupResult?.processed || 0,
      cleanupRemoved: cleanupResult?.removed || 0,
    };

    // Optional per-message correction details (for diagnosing incremental indexer gaps).
    if (Array.isArray(extra?.correctionDetails) && extra.correctionDetails.length > 0) {
      logEntry.corrections = extra.correctionDetails;
      logEntry.correctionsTruncated = !!extra?.correctionDetailsTruncated;
    } else if (extra?.correctionDetailsTruncated) {
      // Indicate truncation even if we couldn't store details (e.g. limit=0).
      logEntry.corrections = [];
      logEntry.correctionsTruncated = true;
    }

    // Get existing log
    const stored = await browser.storage.local.get({ fts_maintenance_log: [] });
    const logHistory = stored.fts_maintenance_log || [];

    // Add new entry at the beginning (most recent first)
    logHistory.unshift(logEntry);

    // Keep only last 100 entries to prevent unbounded growth
    const MAX_LOG_ENTRIES = 100;
    if (logHistory.length > MAX_LOG_ENTRIES) {
      logHistory.splice(MAX_LOG_ENTRIES);
    }

    // Save updated log
    await browser.storage.local.set({ fts_maintenance_log: logHistory });

    log(`[TMDBG FTS] Logged maintenance run: ${scheduleType} - scanned: ${logEntry.scanned}, corrected: ${logEntry.corrected} (indexed: ${logEntry.correctedIndexed}, removed: ${logEntry.correctedRemoved}), skipped: ${logEntry.skipped}`);
  } catch (e) {
    log(`[TMDBG FTS] Failed to log maintenance run: ${e.message}`, "warn");
  }
}

/**
 * Log a cleanup-only run to the history
 * @param {string} scheduleType - Type of cleanup (daily, weekly, monthly)
 * @param {Object} cleanupResult - Result from cleanupMissingEntries
 */
async function logCleanupRun(scheduleType, cleanupResult) {
  try {
    const logEntry = {
      type: `${scheduleType}-cleanup`,
      timestamp: Date.now(),
      scanned: 0,
      indexed: 0,
      corrected: cleanupResult?.removed || 0,
      correctedIndexed: 0,
      correctedRemoved: cleanupResult?.removed || 0,
      skipped: 0,
      cleanupProcessed: cleanupResult?.processed || 0,
      cleanupRemoved: cleanupResult?.removed || 0,
    };

    // Include removed details if available
    if (Array.isArray(cleanupResult?.removedDetails) && cleanupResult.removedDetails.length > 0) {
      const maxDetailEntries = Number(SETTINGS?.ftsMaintenanceLog?.maxCorrectionEntriesPerRun) || 0;
      if (maxDetailEntries > 0) {
        logEntry.corrections = cleanupResult.removedDetails.slice(0, maxDetailEntries);
        logEntry.correctionsTruncated = cleanupResult.removedDetails.length > maxDetailEntries;
      }
    }

    // Get existing log
    const stored = await browser.storage.local.get({ fts_maintenance_log: [] });
    const logHistory = stored.fts_maintenance_log || [];

    // Add new entry at the beginning (most recent first)
    logHistory.unshift(logEntry);

    // Keep only last 100 entries to prevent unbounded growth
    const MAX_LOG_ENTRIES = 100;
    if (logHistory.length > MAX_LOG_ENTRIES) {
      logHistory.splice(MAX_LOG_ENTRIES);
    }

    // Save updated log
    await browser.storage.local.set({ fts_maintenance_log: logHistory });

    log(`[TMDBG FTS] Logged cleanup run: ${scheduleType} - processed: ${logEntry.cleanupProcessed}, removed: ${logEntry.cleanupRemoved}`);
  } catch (e) {
    log(`[TMDBG FTS] Failed to log cleanup run: ${e.message}`, "warn");
  }
}

/**
 * Log a full/smart reindex run to the history
 * Exported for use by engine.js smartReindex command
 * @param {Object} result - Result from indexMessages
 */
export async function logSmartReindexRun(result) {
  try {
    const scannedMessages = result?.scanned ?? result?.indexed ?? 0;
    const correctedIndexed = result?.newlyIndexed ?? 0;

    const logEntry = {
      type: 'full-maintenance',
      timestamp: Date.now(),
      scanned: scannedMessages,
      indexed: scannedMessages,
      corrected: correctedIndexed,
      correctedIndexed,
      correctedRemoved: 0,
      skipped: result?.skipped || 0,
      cleanupProcessed: 0,
      cleanupRemoved: 0,
    };

    // Include correction details if available
    if (Array.isArray(result?.correctionDetails) && result.correctionDetails.length > 0) {
      const maxDetailEntries = Number(SETTINGS?.ftsMaintenanceLog?.maxCorrectionEntriesPerRun) || 0;
      if (maxDetailEntries > 0) {
        logEntry.corrections = result.correctionDetails.slice(0, maxDetailEntries);
        logEntry.correctionsTruncated = result.correctionDetails.length > maxDetailEntries;
      }
    }

    // Get existing log
    const stored = await browser.storage.local.get({ fts_maintenance_log: [] });
    const logHistory = stored.fts_maintenance_log || [];

    // Add new entry at the beginning (most recent first)
    logHistory.unshift(logEntry);

    // Keep only last 100 entries to prevent unbounded growth
    const MAX_LOG_ENTRIES = 100;
    if (logHistory.length > MAX_LOG_ENTRIES) {
      logHistory.splice(MAX_LOG_ENTRIES);
    }

    // Save updated log
    await browser.storage.local.set({ fts_maintenance_log: logHistory });

    log(`[TMDBG FTS] Logged full maintenance run: scanned: ${logEntry.scanned}, corrected: ${logEntry.corrected}, skipped: ${logEntry.skipped}`);
  } catch (e) {
    log(`[TMDBG FTS] Failed to log full maintenance run: ${e.message}`, "warn");
  }
}

/**
 * Calculate date range for a given scope
 */
function calculateDateRange(scope, unit) {
  const now = new Date();
  const start = new Date(now);
  
  switch (unit) {
    case 'days':
      start.setDate(now.getDate() - scope);
      break;
    case 'weeks':
      start.setDate(now.getDate() - (scope * 7));
      break;
    case 'months':
      start.setMonth(now.getMonth() - scope);
      break;
    default:
      throw new Error(`Unknown date unit: ${unit}`);
  }
  
  return { start, end: now };
}

/**
 * Manually trigger a cleanup scan (for testing/debugging)
 */
export async function triggerCleanupScan(scheduleType = 'daily') {
  const config = MAINTENANCE_SCHEDULES[scheduleType];
  if (!config) {
    throw new Error(`Unknown schedule type: ${scheduleType}`);
  }
  
  if (!_ftsSearch) {
    throw new Error("FTS search not initialized");
  }

  const operation = await acquireFtsExclusiveOperation(`cleanup:${scheduleType}`);
  try {
    await writeOwnedFtsScanStatus(operation, {
      scanType: "cleanup",
      maintenanceType: scheduleType,
      startedAt: Date.now(),
    });
    log(`[TMDBG FTS] Manually triggering ${scheduleType} cleanup scan`);

    // Calculate date range for this scan
    const dateRange = calculateDateRange(config.scope, config.scopeUnit);

    // No entry limits - chunked pagination handles large datasets safely
    const cleanup = await cleanupMissingEntries(_ftsSearch, dateRange.start, dateRange.end, {
      // maxEntries: 0 means unlimited (default)
    });

    // Keep ownership through the durable history write: another native writer
    // cannot begin while this cleanup is still recording its outcome.
    await logCleanupRun(scheduleType, cleanup);

    return { ok: true, scheduleType, ...cleanup };
  } finally {
    try {
      await clearOwnedFtsScanStatus(operation, { lastMaintenanceType: scheduleType });
    } finally {
      operation.release();
    }
  }
}

/**
 * Manually trigger a maintenance scan (for testing/debugging)
 */
export async function triggerMaintenanceScan(scheduleType = 'hourly', force = false, progressCallback = null) {
  const config = MAINTENANCE_SCHEDULES[scheduleType];
  if (!config) {
    throw new Error(`Unknown schedule type: ${scheduleType}`);
  }

  log(`[TMDBG FTS] Manually triggering ${scheduleType} maintenance scan`);
  return await runMaintenanceScan(scheduleType, config, force, progressCallback);
}

/**
 * Get maintenance status and last scan times
 */
export async function getMaintenanceStatus() {
  const settings = await getMaintenanceSettings();
  const status = { enabled: settings.enabled, schedules: {} };
  
  for (const [type, config] of Object.entries(MAINTENANCE_SCHEDULES)) {
    const lastScanKey = `fts_maintenance_last_${type}`;
    const lastScan = await browser.storage.local.get(lastScanKey);
    
    const timeInfo = formatTimestampWithTimezone(lastScan[lastScanKey] || null);
    
    status.schedules[type] = {
      enabled: settings[type],
      interval: config.interval,
      scope: `${config.scope} ${config.scopeUnit}`,
      lastScan: lastScan[lastScanKey] || null,
      lastScanDate: timeInfo.localDate, // Now shows local time with timezone
      lastScanDateUTC: timeInfo.utcDate, // Keep UTC for reference
      timezone: timeInfo.timezone,
      timezoneOffset: timeInfo.timezoneOffset
    };
  }
  
  return status;
}

/**
 * Update maintenance settings and reschedule alarms
 */
export async function updateMaintenanceSettings(newSettings) {
  await browser.storage.local.set({
    ...newSettings,
    chat_ftsMaintenanceEnabled: false,
    chat_ftsMaintenanceHourlyEnabled: false,
    chat_ftsMaintenanceDailyEnabled: false,
    chat_ftsMaintenanceWeeklyEnabled: false,
    chat_ftsMaintenanceMonthlyEnabled: false,
  });
  
  // Reinitialize with new settings
  if (_isInitialized && _ftsSearch) {
    await setupMaintenanceAlarms();
  }
  
  log("[TMDBG FTS] Periodic maintenance settings forced off (feature retired)");
}

/**
 * Debug function to check current alarm status
 */
export async function debugMaintenanceAlarms() {
  const allAlarms = await browser.alarms.getAll();
  const maintenanceAlarms = allAlarms.filter(a => a.name === MAINTENANCE_TICK_ALARM_NAME || LEGACY_MAINTENANCE_ALARM_NAMES.includes(a.name));
  
  const now = Date.now();
  const alarmInfo = maintenanceAlarms.map(alarm => ({
    name: alarm.name,
    scheduledTime: new Date(alarm.scheduledTime).toISOString(),
    timeUntilNext: Math.round((alarm.scheduledTime - now) / 1000 / 60), // minutes
    periodInMinutes: alarm.periodInMinutes
  }));
  
  log(`[TMDBG FTS] Current maintenance alarms (${maintenanceAlarms.length}):`, alarmInfo);
  return { 
    total: allAlarms.length, 
    maintenance: maintenanceAlarms.length, 
    alarms: alarmInfo,
    isInitialized: _isInitialized
  };
}
