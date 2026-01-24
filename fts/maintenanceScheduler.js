/**
 * FTS Maintenance Scheduler
 * 
 * Implements periodic maintenance scans to keep the FTS index healthy:
 * - Hourly scan of last 1 day messages
 * - Daily scan of last 3 days messages  
 * - Weekly scan of last 3 weeks messages
 * - Monthly scan of last 3 months messages
 * 
 * FTS5 Incremental Optimize Strategy:
 * - Uses FTS5 'merge' command instead of blocking 'optimize' (MV3-friendly)
 * - Breaks work into small 1-2s steps that yield between operations
 * - Runs multiple slices per maintenance cycle (daily: 5, weekly: 8, monthly: 12)
 * - Each slice is resumable - if interrupted, next cycle continues where we left off
 * - Converges to same optimized state as full optimize, but service worker safe
 * - See ENABLE_AUTO_OPTIMIZE flag to disable (FTS5 still self-maintains via automerge)
 * 
 * Per FTS5 docs: https://www.sqlite.org/fts5.html#the_merge_command
 * 
 * Uses browser.alarms for scheduling and browser.storage.local for tracking.
 */

import { SETTINGS } from "../agent/modules/config.js";
import { headerIDToWeID, log, parseUniqueId } from "../agent/modules/utils.js";

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

// Single "tick" alarm: fires on startup + every hour, and chooses at most ONE run.
// Per requirements: order oldest->latest (monthly -> weekly -> daily -> hourly),
// and longer interval coverage marks shorter intervals as "also ran".
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

/**
 * Initialize the maintenance scheduler
 */
export async function initMaintenanceScheduler(ftsSearch) {
  if (_isInitialized) return;
  
  _ftsSearch = ftsSearch;
  _isInitialized = true;
  
  // Reset any stuck maintenance status on startup
  try {
    const { fts_scan_status } = await browser.storage.local.get("fts_scan_status");
    if (fts_scan_status?.isScanning && fts_scan_status?.scanType === "maintenance") {
      await browser.storage.local.set({
        fts_scan_status: {
          isScanning: false,
          scanType: "none",
          lastCompleted: Date.now(),
          lastMaintenanceType: fts_scan_status.maintenanceType || "unknown"
        }
      });
      log("[TMDBG FTS] Cleared stuck maintenance scan status on startup");
    }
  } catch (e) {
    console.error("[TMDBG FTS] Failed to check/clear stuck status:", e);
  }
  
  // Load settings and set up alarms
  const settings = await getMaintenanceSettings();
  
  if (settings.enabled) {
    await setupMaintenanceAlarms();
    log("[TMDBG FTS] Maintenance scheduler initialized");
    // Per requirement: also check/run on Thunderbird launch (not only on the first hourly alarm).
    // This runs at most ONE maintenance item, applying coverage rules.
    try {
      log("[TMDBG FTS] Startup maintenance tick: checking for due maintenance runs");
      await runScheduledMaintenanceTick("startup");
    } catch (e) {
      log(`[TMDBG FTS] Startup maintenance tick failed: ${e?.message || String(e)}`, "warn");
    }
  } else {
    await clearMaintenanceAlarms();
    log("[TMDBG FTS] Maintenance scheduler disabled");
  }
  
  // Listen for alarm events (avoid duplicate listeners)
  if (_alarmListener) {
    browser.alarms.onAlarm.removeListener(_alarmListener);
  }
  _alarmListener = handleMaintenanceAlarm;
  browser.alarms.onAlarm.addListener(_alarmListener);
  log("[TMDBG FTS] Maintenance alarm listener attached");
}

/**
 * Dispose the maintenance scheduler
 */
export async function disposeMaintenanceScheduler(options = {}) {
  if (!_isInitialized) return;
  
  // IMPORTANT (MV3/TB 145): on a normal suspend we should NOT clear alarms,
  // otherwise alarms can't wake the service worker again.
  // If you explicitly want alarms removed (e.g. user disabled maintenance),
  // call with { clearAlarms: true }.
  const clearAlarms = options?.clearAlarms === true;
  if (clearAlarms) {
    await clearMaintenanceAlarms();
  }
  if (_alarmListener) {
    browser.alarms.onAlarm.removeListener(_alarmListener);
    _alarmListener = null;
  }
  _isInitialized = false;
  _ftsSearch = null;
  
  log("[TMDBG FTS] Maintenance scheduler disposed");
}

/**
 * Get maintenance settings from storage
 */
async function getMaintenanceSettings() {
  const stored = await browser.storage.local.get({
    chat_ftsMaintenanceEnabled: true,
    chat_ftsMaintenanceHourlyEnabled: false, // Disabled by default - incremental should catch most changes
    chat_ftsMaintenanceDailyEnabled: false,  // Disabled by default - weekly is sufficient backstop
    chat_ftsMaintenanceWeeklyEnabled: true,  // Weekly enabled as primary maintenance backstop
    chat_ftsMaintenanceMonthlyEnabled: false, // Monthly disabled by default (heavy)
    chat_ftsMaintenanceWeeklyDay: 3, // 0=Sunday, 3=Wednesday (default)
    chat_ftsMaintenanceWeeklyHourStart: 9, // 9 AM
    chat_ftsMaintenanceWeeklyHourEnd: 12, // 12 PM (noon)
  });
  
  return {
    enabled: stored.chat_ftsMaintenanceEnabled,
    hourly: stored.chat_ftsMaintenanceHourlyEnabled,
    daily: stored.chat_ftsMaintenanceDailyEnabled,
    weekly: stored.chat_ftsMaintenanceWeeklyEnabled,
    monthly: stored.chat_ftsMaintenanceMonthlyEnabled,
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
  const settings = await getMaintenanceSettings();
  
  // Clear existing alarms first
  await clearMaintenanceAlarms();

  if (!settings.enabled) {
    log("[TMDBG FTS] Maintenance disabled - not scheduling maintenance tick alarm");
    return;
  }

  const tickIntervalMinutes = MAINTENANCE_SCHEDULES.hourly.interval;
  await browser.alarms.create(MAINTENANCE_TICK_ALARM_NAME, {
    // Do not rely on tiny delay values (may be clamped). We explicitly run a startup tick above.
    delayInMinutes: tickIntervalMinutes,
    periodInMinutes: tickIntervalMinutes,
  });

  // Log enabled schedule flags for debugging.
  log(`[TMDBG FTS] Scheduled maintenance tick alarm every ${tickIntervalMinutes} minutes (alarm: ${MAINTENANCE_TICK_ALARM_NAME})`);
  log(`[TMDBG FTS] Maintenance schedule flags: hourly=${!!settings.hourly}, daily=${!!settings.daily}, weekly=${!!settings.weekly}, monthly=${!!settings.monthly}`);

  // Verify alarms were created
  const alarms = await browser.alarms.getAll();
  const maintenanceAlarms = alarms.filter(a => a.name === MAINTENANCE_TICK_ALARM_NAME || LEGACY_MAINTENANCE_ALARM_NAMES.includes(a.name));
  log(`[TMDBG FTS] Maintenance alarms present (${maintenanceAlarms.length}):`, maintenanceAlarms.map(a => a.name));
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
  log(`[TMDBG FTS] Alarm triggered: ${alarm.name} at ${new Date().toISOString()}`);

  // Only handle the single maintenance tick alarm.
  if (alarm.name !== MAINTENANCE_TICK_ALARM_NAME) {
    // Legacy alarms should not run; they're cleared on init but log if they still fire.
    if (LEGACY_MAINTENANCE_ALARM_NAMES.includes(alarm.name)) {
      log(`[TMDBG FTS] Legacy maintenance alarm fired (${alarm.name}) - ignoring (should be cleared)`, "warn");
    } else {
      log(`[TMDBG FTS] Alarm ${alarm.name} is not a maintenance alarm, ignoring`);
    }
    return;
  }

  try {
    await runScheduledMaintenanceTick("alarm");
  } catch (e) {
    log(`[TMDBG FTS] Maintenance tick failed: ${e?.message || String(e)}`, "warn");
  }
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
  if (dueType === "daily" && _ftsSearch?.checkForUpdates) {
    try {
      log(`[TMDBG FTS] Maintenance tick: checking for native FTS updates (before daily maintenance)`);
      const updateResult = await _ftsSearch.checkForUpdates();
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
  const batchDelayMs = cleanupConfig.batchDelayMs || 100;
  const entryDelayMs = cleanupConfig.entryDelayMs || 50;
  
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
      
      // Move cursor backwards: use oldest entry's dateMs - 1ms as new end
      // Results are DESC, so last entry in chunk is the oldest
      const oldestInChunk = chunk[chunk.length - 1];
      const oldestDateMs = oldestInChunk?.dateMs;
      
      if (typeof oldestDateMs !== 'number' || oldestDateMs <= startMs) {
        log(`[TMDBG FTS] Query cursor reached start boundary`);
        break;
      }
      
      // Move cursor to 1ms before the oldest entry to avoid re-fetching it
      cursorEndMs = oldestDateMs - 1;
      
      // Safety: prevent infinite loop if cursor doesn't move
      if (cursorEndMs >= cursorEndDate.getTime()) {
        log(`[TMDBG FTS] Query cursor stuck, breaking`);
        break;
      }
      
      // Small yield between query chunks
      await new Promise(resolve => setTimeout(resolve, batchDelayMs));
    }
    
    if (allEntries.length === 0) {
      log(`[TMDBG FTS] No entries found in date range for cleanup`);
      return { processed: 0, removed: 0 };
    }
    
    log(`[TMDBG FTS] Phase 1 complete: ${allEntries.length} entries to validate (${queryChunkCount} chunks)`);
    
    // =========================================================================
    // PHASE 2: Chunked Validation - process in batches with keepalive pings
    // =========================================================================
    const entriesToRemove = [];
    const removedDetails = [];
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
          
          // Use headerIDToWeID with folder constraint to check if message still exists
          // Disable global fallback to ensure we only find messages in their original folders
          const weID = await headerIDToWeID(headerID, weFolder, false, false);
          
          if (!weID) {
            // Message no longer exists, mark for removal
            entriesToRemove.push(entry.msgId);
            removedDetails.push({
              action: "removedMissing",
              msgId: entry.msgId,
              folderPath: String(weFolder || ""),
              headerID: String(headerID || ""),
              subject: String(entry?.subject || ""),
              dateMs: Number(entry?.dateMs || 0),
            });
          }
          
          processed++;
          
          // Small per-entry delay to avoid overwhelming TB APIs
          if (entryDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, entryDelayMs));
          }
          
        } catch (error) {
          log(`[TMDBG FTS] Error checking entry ${entry.msgId}: ${error.message}`, "warn");
          // On error, assume the entry should be removed (safer approach)
          entriesToRemove.push(entry.msgId);
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
      log(`[TMDBG FTS] Validation batch ${batchNum}/${totalBatches}: ${processed}/${allEntries.length} processed, ${entriesToRemove.length} marked for removal`);
      
      // Yield between batches
      if (batchDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, batchDelayMs));
      }
    }
    
    log(`[TMDBG FTS] Phase 2 complete: ${processed} validated, ${entriesToRemove.length} to remove`);
    
    // =========================================================================
    // PHASE 3: Chunked Removal - remove in batches to keep native RPC active
    // =========================================================================
    let removedCount = 0;
    
    if (entriesToRemove.length > 0) {
      log(`[TMDBG FTS] Phase 3: Removing ${entriesToRemove.length} entries in batches of ${removeBatchSize}`);
      
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
        }
        
        // Small delay between remove batches
        if (removeStart + removeBatchSize < entriesToRemove.length) {
          await new Promise(resolve => setTimeout(resolve, batchDelayMs));
        }
      }
    }
    
    log(`[TMDBG FTS] Phase 3 complete: ${removedCount} removed`);
    log(`[TMDBG FTS] Cleanup completed: ${processed} processed, ${removedCount} removed`);
    
    return { processed, removed: removedCount, removedDetails };
    
  } catch (error) {
    log(`[TMDBG FTS] Cleanup failed: ${error.message}`, "error");
    throw error;
  }
}

/**
 * Run a maintenance scan for the given schedule
 */
async function runMaintenanceScan(scheduleType, config, force = false) {
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

  try {
    // Set scan status to indicate maintenance scan is in progress
    await browser.storage.local.set({
      fts_scan_status: {
        isScanning: true,
        scanType: "maintenance",
        maintenanceType: scheduleType,
        startTime: now,
        progress: {
          folder: "",
          totalIndexed: 0,
          totalBatches: 0
        }
      }
    });
    
    // Calculate date range for this scan
    const dateRange = calculateDateRange(config.scope, config.scopeUnit);
    log(`[TMDBG FTS] ${scheduleType} scan: checking messages from ${dateRange.start.toISOString()} to ${dateRange.end.toISOString()}`);
    
    // Run the maintenance scan
    const { indexMessages } = await import("./indexer.js");
    const maxDetailEntries = Number(SETTINGS?.ftsMaintenanceLog?.maxCorrectionEntriesPerRun) || 0;
    result = await indexMessages(_ftsSearch, () => {}, dateRange.start, dateRange.end, {
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
    
    // =============================================================================
    // FTS5 INCREMENTAL OPTIMIZE - MV3-Friendly Chunked Merge
    // =============================================================================
    // 
    // APPROACH:
    // - Uses FTS5's 'merge' command instead of blocking 'optimize'
    // - Breaks work into small slices (1-2s each) that yield between steps
    // - Runs multiple slices per maintenance cycle
    // - Each slice is resumable - if interrupted, next cycle continues
    // - Converges to same optimized state as full optimize, but MV3-safe
    //
    // CONFIGURATION:
    // - pageBudget: pages merged per step (higher = more work per step)
    // - stepTimeMs: time budget per merge step (lower = more frequent yields)
    // - slices: number of slice invocations per maintenance run
    //
    // WHY THIS WORKS:
    // 1. ✓ Each merge step completes in ~100-2000ms (well under 30s limit)
    // 2. ✓ Yields between steps keep event loop responsive
    // 3. ✓ Service worker stays alive (no idle timeout)
    // 4. ✓ If slice fails, next maintenance continues (resumable)
    // 5. ✓ No special keep-alive hacks needed
    //
    // Per FTS5 docs: https://www.sqlite.org/fts5.html#the_merge_command
    // =============================================================================
    const ENABLE_AUTO_OPTIMIZE = true;
    
    if (ENABLE_AUTO_OPTIMIZE && (scheduleType === 'daily' || scheduleType === 'weekly' || scheduleType === 'monthly')) {
      // Configure slices by schedule type: daily = more frequent, monthly = larger chunks
      const pageBudgetBySchedule = { daily: 800, weekly: 1200, monthly: 1600 };
      const stepMsBySchedule     = { daily: 1200, weekly: 1500, monthly: 1800 };
      const slicesPerRun         = { daily: 5, weekly: 8, monthly: 12 };
      
      const pageBudget = pageBudgetBySchedule[scheduleType];
      const stepTimeMs = stepMsBySchedule[scheduleType];
      const nSlices    = slicesPerRun[scheduleType];
      
      log(`[TMDBG FTS] Running incremental FTS5 optimization after ${scheduleType} maintenance`);
      log(`[TMDBG FTS] Config: ${nSlices} slices, pageBudget=${pageBudget}, stepTimeMs=${stepTimeMs}ms`);
      
      let totalSteps = 0;
      let totalChanges = 0;
      let converged = false;
      
      try {
        for (let i = 0; i < nSlices; i++) {
          try {
            const sliceResult = await _ftsSearch.optimize({ 
              pageBudget, 
              stepTimeMs, 
              maxSteps: 10 
            });
            
            totalSteps += sliceResult.steps || 0;
            totalChanges += sliceResult.totalChanges || 0;
            
            log(`[TMDBG FTS] Slice ${i + 1}/${nSlices}: ${sliceResult.steps} steps, Δ=${sliceResult.totalChanges}, size=${sliceResult.dbSizeMB}MB`);
            
            // If slice converged (< 2 changes), index is fully optimized - stop early
            if (sliceResult.converged || (sliceResult.totalChanges ?? 0) < 2) {
              log(`[TMDBG FTS] ✓ FTS5 optimization converged at slice ${i + 1}/${nSlices}`);
              converged = true;
              break;
            }
            
            // Yield between slices
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, 0));
          } catch (e) {
            log(`[TMDBG FTS] Optimize slice ${i + 1} failed: ${e.message}`, "warn");
            // Continue to next slice or stop - non-critical failure
            break;
          }
        }
        
        if (converged) {
          log(`[TMDBG FTS] ✓ FTS5 incremental optimization complete: ${totalSteps} total steps, ${totalChanges} total changes`);
        } else {
          log(`[TMDBG FTS] FTS5 incremental optimization progress: ${totalSteps} steps, ${totalChanges} changes (will continue next ${scheduleType} cycle)`);
        }
      } catch (e) {
        log(`[TMDBG FTS] FTS5 optimization error: ${e.message}`, "warn");
        log(`[TMDBG FTS] Non-critical - will retry on next ${scheduleType} maintenance`, "warn");
      }
    } else if (!ENABLE_AUTO_OPTIMIZE && (scheduleType === 'daily' || scheduleType === 'weekly' || scheduleType === 'monthly')) {
      log(`[TMDBG FTS] Optimize disabled (ENABLE_AUTO_OPTIMIZE = false) - skipping after ${scheduleType} maintenance`);
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
    // ALWAYS clear scan status, even if there was an error
    await browser.storage.local.set({
      fts_scan_status: {
        isScanning: false,
        scanType: "none",
        lastCompleted: Date.now(),
        lastMaintenanceType: scheduleType
      }
    });
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
  
  log(`[TMDBG FTS] Manually triggering ${scheduleType} cleanup scan`);
  
  // Calculate date range for this scan
  const dateRange = calculateDateRange(config.scope, config.scopeUnit);
  
  // No entry limits - chunked pagination handles large datasets safely
  const cleanup = await cleanupMissingEntries(_ftsSearch, dateRange.start, dateRange.end, {
    // maxEntries: 0 means unlimited (default)
  });
  
  // Log the cleanup run to maintenance history
  await logCleanupRun(scheduleType, cleanup);
  
  return { ok: true, scheduleType, ...cleanup };
}

/**
 * Manually trigger a maintenance scan (for testing/debugging)
 */
export async function triggerMaintenanceScan(scheduleType = 'hourly', force = false) {
  const config = MAINTENANCE_SCHEDULES[scheduleType];
  if (!config) {
    throw new Error(`Unknown schedule type: ${scheduleType}`);
  }
  
  log(`[TMDBG FTS] Manually triggering ${scheduleType} maintenance scan`);
  return await runMaintenanceScan(scheduleType, config, force);
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
  await browser.storage.local.set(newSettings);
  
  // Reinitialize with new settings
  if (_isInitialized && _ftsSearch) {
    await setupMaintenanceAlarms();
  }
  
  log("[TMDBG FTS] Maintenance settings updated");
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
