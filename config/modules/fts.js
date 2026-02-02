import { $ } from "./dom.js";

export async function loadFtsSettings() {
  try {
    // Load FTS settings directly from storage (like other settings)
    // Note: FTS is always enabled (chat_useFtsSearch always true for native FTS)
    const stored = await browser.storage.local.get({
      chat_useFtsSearch: true,
      chat_ftsBatchSize: 250,
      chat_ftsSleepBetweenBatchMs: 250,
      chat_ftsIncrementalEnabled: true,
      chat_ftsIncrementalBatchDelay: 1000,
      chat_ftsIncrementalBatchSize: 50,
      chat_ftsMaintenanceEnabled: true,
      chat_ftsMaintenanceHourlyEnabled: false, // Disabled by default - incremental catches most
      chat_ftsMaintenanceDailyEnabled: false,  // Disabled by default - weekly is sufficient
      chat_ftsMaintenanceWeeklyEnabled: true,  // Weekly enabled as primary backstop
      chat_ftsMaintenanceMonthlyEnabled: false,
      chat_ftsMaintenanceWeeklyDay: 3, // Wednesday
      chat_ftsMaintenanceWeeklyHourStart: 9,
      chat_ftsMaintenanceWeeklyHourEnd: 12,
    });

    // FTS is always enabled with native helper, no toggle needed
    $("fts-batch-size").value = stored.chat_ftsBatchSize;
    $("fts-sleep-delay").value = stored.chat_ftsSleepBetweenBatchMs;
    $("fts-incremental-enabled").checked = stored.chat_ftsIncrementalEnabled;
    $("fts-incremental-batch-delay").value = stored.chat_ftsIncrementalBatchDelay;
    $("fts-incremental-batch-size").value = stored.chat_ftsIncrementalBatchSize;
    $("fts-maintenance-enabled").checked = stored.chat_ftsMaintenanceEnabled;
    $("fts-maintenance-hourly").checked = stored.chat_ftsMaintenanceHourlyEnabled;
    $("fts-maintenance-daily").checked = stored.chat_ftsMaintenanceDailyEnabled;
    $("fts-maintenance-weekly").checked = stored.chat_ftsMaintenanceWeeklyEnabled;
    $("fts-maintenance-monthly").checked = stored.chat_ftsMaintenanceMonthlyEnabled;
    
    // Weekly schedule settings
    $("fts-maintenance-weekly-day").value = stored.chat_ftsMaintenanceWeeklyDay;
    $("fts-maintenance-weekly-hour-start").value = stored.chat_ftsMaintenanceWeeklyHourStart;
    $("fts-maintenance-weekly-hour-end").value = stored.chat_ftsMaintenanceWeeklyHourEnd;
    
    // Show/hide weekly schedule based on weekly checkbox
    updateWeeklyScheduleVisibility();

    console.log("[TMDBG Config] FTS settings loaded:", stored);

    await updateFtsStatus();
    await loadMaintenanceLog();
  } catch (e) {
    console.warn("[TMDBG Config] loadFtsSettings failed", e);
    $("fts-stats").textContent = "Error loading FTS settings";
  }
}

// Helper to show/hide weekly schedule time options
function updateWeeklyScheduleVisibility() {
  const weeklyEnabled = $("fts-maintenance-weekly")?.checked;
  const container = $("weekly-schedule-container");
  if (container) {
    // Find the schedule row (the div with day/time inputs) and toggle its visibility
    const scheduleRow = container.querySelector(".row");
    if (scheduleRow) {
      scheduleRow.style.display = weeklyEnabled ? "flex" : "none";
    }
  }
}

export async function saveFtsSettings() {
  try {
    // FTS is always enabled with native helper
    const enabled = true;
    const batchSize = parseInt($("fts-batch-size").value, 10) || 250;
    const sleepDelay = parseInt($("fts-sleep-delay").value, 10) || 250;
    const incrementalEnabled = $("fts-incremental-enabled").checked;
    const incrementalBatchDelay =
      parseInt($("fts-incremental-batch-delay").value, 10) || 1000;
    const incrementalBatchSize =
      parseInt($("fts-incremental-batch-size").value, 10) || 50;
    const maintenanceEnabled = $("fts-maintenance-enabled").checked;
    const maintenanceHourly = $("fts-maintenance-hourly").checked;
    const maintenanceDaily = $("fts-maintenance-daily").checked;
    const maintenanceWeekly = $("fts-maintenance-weekly").checked;
    const maintenanceMonthly = $("fts-maintenance-monthly").checked;
    
    // Weekly schedule settings
    const weeklyDay = parseInt($("fts-maintenance-weekly-day").value, 10) || 3;
    const weeklyHourStart = parseInt($("fts-maintenance-weekly-hour-start").value, 10) || 9;
    const weeklyHourEnd = parseInt($("fts-maintenance-weekly-hour-end").value, 10) || 12;

    // Save directly to storage (matching loadFtsSettings approach)
    await browser.storage.local.set({
      chat_useFtsSearch: enabled,
      chat_ftsBatchSize: batchSize,
      chat_ftsSleepBetweenBatchMs: sleepDelay,
      chat_ftsIncrementalEnabled: incrementalEnabled,
      chat_ftsIncrementalBatchDelay: incrementalBatchDelay,
      chat_ftsIncrementalBatchSize: incrementalBatchSize,
      chat_ftsMaintenanceEnabled: maintenanceEnabled,
      chat_ftsMaintenanceHourlyEnabled: maintenanceHourly,
      chat_ftsMaintenanceDailyEnabled: maintenanceDaily,
      chat_ftsMaintenanceWeeklyEnabled: maintenanceWeekly,
      chat_ftsMaintenanceMonthlyEnabled: maintenanceMonthly,
      chat_ftsMaintenanceWeeklyDay: weeklyDay,
      chat_ftsMaintenanceWeeklyHourStart: weeklyHourStart,
      chat_ftsMaintenanceWeeklyHourEnd: weeklyHourEnd,
    });

    // Update maintenance scheduler with new settings
    try {
      await browser.runtime.sendMessage({
        type: "fts",
        cmd: "maintenanceUpdate",
        settings: {
          chat_ftsMaintenanceEnabled: maintenanceEnabled,
          chat_ftsMaintenanceHourlyEnabled: maintenanceHourly,
          chat_ftsMaintenanceDailyEnabled: maintenanceDaily,
          chat_ftsMaintenanceWeeklyEnabled: maintenanceWeekly,
          chat_ftsMaintenanceMonthlyEnabled: maintenanceMonthly,
          chat_ftsMaintenanceWeeklyDay: weeklyDay,
          chat_ftsMaintenanceWeeklyHourStart: weeklyHourStart,
          chat_ftsMaintenanceWeeklyHourEnd: weeklyHourEnd,
        },
      });
    } catch (e) {
      console.warn("[TMDBG Config] Failed to update maintenance scheduler:", e);
    }

    $("status").textContent = `FTS settings saved. ${
      enabled ? "FTS enabled" : "FTS disabled"
    } - restart extension to apply.`;
  } catch (e) {
    console.warn("[TMDBG Config] saveFtsSettings failed", e);
    $("status").textContent = "Error saving FTS settings: " + e.message;
  }
}

export async function updateFtsStatus() {
  try {
    // Check if FTS is enabled in storage (matches loadFtsSettings approach)
    await browser.storage.local.get({ chat_useFtsSearch: true });

    // FTS is always enabled with native helper, no need to check chat_useFtsSearch

    // Get FTS system status
    const response = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "stats",
    });

    if (response?.ok) {
      const { docs, dbBytes } = response;
      const mbSize = (dbBytes / (1024 * 1024)).toFixed(1);
      $("fts-stats").textContent = `Indexed: ${docs.toLocaleString()} messages, DB Size: ${mbSize} MB`;

      // Add storage warning if FTS database is very large
      const existingWarning = $("fts-stats").querySelector(".storage-warning");
      if (existingWarning) existingWarning.remove();

      // if (dbBytes > 1024 * 1024 * 1024) { // > 1GB
      //   const warning = document.createElement("div");
      //   warning.className = "storage-warning";
      //   warning.style.color = "orange";
      //   warning.style.fontSize = "small";
      //   warning.style.marginTop = "4px";
      //   warning.textContent = "⚠️ Large FTS database - consider running Smart Reindex to optimize";
      //   $("fts-stats").appendChild(warning);
      // }
    } else if (response?.error) {
      $("fts-stats").textContent = `FTS Error: ${response.error}`;
    } else {
      $("fts-stats").textContent = "FTS not responding (restart extension?)";
    }

    // Also update FTS host version display
    await updateFtsHostVersion();

    // Check for active embedding rebuild and show progress bar
    try {
      const scanData = await browser.storage.local.get("fts_scan_status");
      const scanStatus = scanData.fts_scan_status;
      if (scanStatus?.isScanning && scanStatus?.scanType === "embeddingRebuild") {
        const progress = scanStatus.progress || {};
        const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
        $("fts-progress").style.display = "block";
        $("fts-progress-bar").value = pct;
        $("fts-progress-text").textContent = `Rebuilding embeddings (${progress.phase || 'email'}): ${(progress.processed || 0).toLocaleString()}/${(progress.total || 0).toLocaleString()} processed, ${(progress.embedded || 0).toLocaleString()} embedded`;

        // Listen for real-time progress updates
        const embeddingProgressListener = (msg) => {
          if (msg?.type === "ftsProgress" && msg?.scanType === "embeddingRebuild") {
            const pctNow = msg.total > 0 ? Math.round((msg.processed / msg.total) * 100) : 0;
            $("fts-progress-bar").value = pctNow;
            $("fts-progress-text").textContent = `Rebuilding embeddings (${msg.phase || 'email'}): ${(msg.processed || 0).toLocaleString()}/${(msg.total || 0).toLocaleString()} processed, ${(msg.embedded || 0).toLocaleString()} embedded`;
          }
        };
        browser.runtime.onMessage.addListener(embeddingProgressListener);

        // Poll for completion (check every 5 seconds)
        const pollInterval = setInterval(async () => {
          try {
            const data = await browser.storage.local.get("fts_scan_status");
            const status = data.fts_scan_status;
            if (!status?.isScanning || status?.scanType !== "embeddingRebuild") {
              clearInterval(pollInterval);
              browser.runtime.onMessage.removeListener(embeddingProgressListener);
              $("fts-progress-bar").value = 100;
              $("fts-progress-text").textContent = "Embedding rebuild complete";
              setTimeout(() => {
                $("fts-progress").style.display = "none";
                updateFtsStatus();
              }, 3000);
            }
          } catch (_) {}
        }, 5000);
      }
    } catch (e) {
      console.warn("[TMDBG Config] Error checking scan status:", e);
    }
  } catch (e) {
    console.warn("[TMDBG Config] updateFtsStatus failed", e);
    $("fts-stats").textContent = "FTS status unavailable";
  }
}

export async function updateFtsHostVersion() {
  try {
    // Get host info from the FTS engine
    const response = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "getHostInfo",
    });

    const versionEl = $("fts-host-version");

    const hostVersion = response?.hostVersion || null;
    if (hostVersion) {
      versionEl.textContent = hostVersion;
      versionEl.style.color = "";
    } else {
      versionEl.textContent = "Not connected";
      versionEl.style.color = "gray";
    }
  } catch (e) {
    console.warn("[TMDBG Config] updateFtsHostVersion failed", e);
    const versionEl = $("fts-host-version");
    if (versionEl) {
      versionEl.textContent = "Error loading";
      versionEl.style.color = "red";
    }
  }
}

export async function ftsManualCheckAndUpdateHost() {
  try {
    const btn = $("fts-check-update");
    const versionEl = $("fts-host-version");

    if (btn) btn.disabled = true;
    if (versionEl) versionEl.textContent = "Checking...";

    const result = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "manualCheckAndUpdateHost",
    });

    if (btn) btn.disabled = false;

    if (result?.ok) {
      if (result.updated) {
        // Update was applied
        $("status").textContent = result.message;
        $("status").style.color = "green";
        if (versionEl) {
          versionEl.textContent = `${result.newVersion}`;
          versionEl.style.color = "green";
        }
      } else if (result.updateAvailable && !result.canUpdate) {
        // Update available but can't self-update
        $("status").textContent = result.message;
        $("status").style.color = "orange";
        if (versionEl) {
          versionEl.textContent = `${result.currentVersion} (update available: ${result.latestVersion})`;
          versionEl.style.color = "orange";
        }
      } else {
        // Already up to date
        $("status").textContent = result.message;
        $("status").style.color = "green";
        await updateFtsHostVersion();
      }
    } else {
      $("status").textContent = `Update check failed: ${result?.error || "Unknown error"}`;
      $("status").style.color = "red";
      await updateFtsHostVersion();
    }

    // Clear status after 5 seconds
    setTimeout(() => {
      $("status").textContent = "";
      $("status").style.color = "";
    }, 5000);
  } catch (e) {
    console.warn("[TMDBG Config] ftsManualCheckAndUpdateHost failed", e);
    $("status").textContent = "Update check failed: " + e.message;
    $("status").style.color = "red";
    const btn = $("fts-check-update");
    if (btn) btn.disabled = false;
  }
}

export async function ftsReindexAll() {
  try {
    // Show warning confirmation before proceeding
    if (
      !confirm(
        "⚠️ WARNING: Full Reindex will completely remove your current search index and rebuild it from scratch.\n\nThis operation may take a long time depending on your mailbox size.\n\nAre you sure you want to continue?",
      )
    ) {
      return;
    }

    $("fts-progress").style.display = "block";
    $("fts-progress-bar").value = 0;
    $("fts-progress-text").textContent = "Starting full reindex...";

    // Listen for progress updates
    const progressListener = (msg) => {
      if (msg?.type === "ftsProgress") {
        const { folder, folderIndexed, totalIndexed, totalBatches } = msg;

        // Show both current folder progress and total progress
        $("fts-progress-text").textContent = `Indexing ${folder}: ${folderIndexed} messages this folder | Total: ${totalIndexed} messages (${totalBatches} batches)`;

        // Simple pulse for progress bar (still indeterminate, but less confusing)
        const current = $("fts-progress-bar").value;
        $("fts-progress-bar").value = (current + 5) % 100;
      }
    };

    browser.runtime.onMessage.addListener(progressListener);

    const response = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "reindexAll",
      progress: true,
    });

    browser.runtime.onMessage.removeListener(progressListener);

    if (response?.ok) {
      $("fts-progress-text").textContent = `Completed: ${response.indexed} messages in ${response.batches} batches`;

      setTimeout(() => {
        $("fts-progress").style.display = "none";
        updateFtsStatus(); // This will also refresh version info
      }, 3000);
    } else {
      throw new Error(response?.error || "Reindex failed");
    }
  } catch (e) {
    $("fts-progress").style.display = "none";
    $("status").textContent = "Reindex failed: " + e.message;
  }
}

export async function ftsSmartReindex() {
  try {
    $("fts-progress").style.display = "block";
    $("fts-progress-bar").value = 0;
    $("fts-progress-text").textContent =
      "Starting smart reindex (checking for changes)...";

    // Listen for progress updates
    const progressListener = (msg) => {
      if (msg?.type === "ftsProgress") {
        const { folder, folderIndexed, totalIndexed, totalBatches } = msg;

        // Show both current folder progress and total progress
        $("fts-progress-text").textContent = `Smart indexing ${folder}: ${folderIndexed} messages this folder | Total: ${totalIndexed} messages (${totalBatches} batches)`;

        // Simple pulse for progress bar (still indeterminate, but less confusing)
        const current = $("fts-progress-bar").value;
        $("fts-progress-bar").value = (current + 5) % 100;
      }
    };

    browser.runtime.onMessage.addListener(progressListener);

    const response = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "smartReindex",
      progress: true,
    });

    browser.runtime.onMessage.removeListener(progressListener);

    if (response?.ok) {
      const skipMsg = response.skipped
        ? `, ${response.skipped} already up-to-date`
        : "";
      $("fts-progress-text").textContent = `Smart reindex completed: ${response.indexed} checked${skipMsg}`;
      setTimeout(async () => {
        $("fts-progress").style.display = "none";
        updateFtsStatus();
        // Refresh maintenance log after completion
        await loadMaintenanceLog();
      }, 3000);
    } else {
      throw new Error(response?.error || "Smart reindex failed");
    }
  } catch (e) {
    $("fts-progress").style.display = "none";
    $("status").textContent = "Smart reindex failed: " + e.message;
  }
}

export async function ftsPause() {
  try {
    const response = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "pause",
    });

    if (response?.ok) {
      $("status").textContent = "FTS indexing paused";
    } else {
      throw new Error(response?.error || "Pause failed");
    }
  } catch (e) {
    $("status").textContent = "Pause failed: " + e.message;
  }
}

export async function ftsResume() {
  try {
    const response = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "resume",
    });

    if (response?.ok) {
      $("status").textContent = "FTS indexing resumed";
    } else {
      throw new Error(response?.error || "Resume failed");
    }
  } catch (e) {
    $("status").textContent = "Resume failed: " + e.message;
  }
}

export async function ftsClear() {
  try {
    if (
      !confirm(
        "Are you sure you want to clear the entire FTS index and checkpoint data? Next indexing will start from scratch. This cannot be undone.",
      )
    ) {
      return;
    }

    const response = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "clear",
    });

    if (response?.ok) {
      $("status").textContent =
        "FTS index and checkpoints cleared - next indexing will start from scratch";
      await updateFtsStatus();
    } else {
      throw new Error(response?.error || "Clear failed");
    }
  } catch (e) {
    $("status").textContent = "Clear failed: " + e.message;
  }
}

export async function ftsDiagnostics() {
  try {
    $("status").textContent = "Running FTS diagnostics...";

    // Import and run diagnostics
    const diagnosticsModule = await import("../../fts/diagnostics.js");
    const results = await diagnosticsModule.runFtsDiagnostics();

    // Show results in console and status
    console.log("=== FTS DIAGNOSTICS RESULTS ===", results);

    let summary = "Diagnostics complete - check browser console for details. ";
    if (results.config?.useFtsSearch) {
      summary += "FTS enabled. ";
    } else {
      summary += "FTS disabled. ";
    }

    if (results.messageHandlers?.fts?.ok) {
      summary += "FTS responding ✅";
    } else if (results.messageHandlers?.fts?.error) {
      summary += `FTS error: ${results.messageHandlers.fts.error}`;
    } else {
      summary += "FTS not responding ❌";
    }

    $("status").textContent = summary;

    // Also update FTS status after diagnostics
    setTimeout(() => updateFtsStatus(), 1000);
  } catch (e) {
    console.error("Diagnostics failed:", e);
    $("status").textContent = "Diagnostics failed: " + e.message;
  }
}

// Temporary debug function to investigate database contents
export async function ftsDebugSample() {
  try {
    $("status").textContent = "Getting FTS database sample...";

    const result = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "debugSample",
    });

    console.log("=== FTS DEBUG SAMPLE ===", result);

    if (result?.samples?.length > 0) {
      $("status").textContent = `Found ${result.count} sample records - check console for details`;
      // Log first sample for quick inspection
      const first = result.samples[0];
      console.log("First sample record:", {
        weMsgId: first.weMsgId,
        type: typeof first.weMsgId,
        headerMessageId: first.headerMessageId,
        subject: first.subject,
      });
    } else {
      $("status").textContent = "No records found in database";
    }
  } catch (e) {
    console.error("Debug sample failed:", e);
    $("status").textContent = "Debug sample failed: " + e.message;
  }
}

// Debug function to check current checkpoint data
export async function ftsDebugCheckpoints() {
  try {
    $("status").textContent = "Checking checkpoint data...";

    const result = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "debugCheckpoints",
    });

    if (result) {
      console.log("FTS Debug Checkpoints:", result);
      $("status").textContent = `Found ${result.checkpointKeys} checkpoint keys (see console for details)`;

      if (result.checkpointKeys > 0) {
        console.warn(
          "⚠️ Checkpoint data still exists! You need to run 'Clear Index' to remove it.",
        );
        console.log("Checkpoint data:", result.data);
      } else {
        console.log("✅ No checkpoint data found - indexing will start from scratch");
      }
    } else {
      $("status").textContent = "Debug checkpoints failed";
    }
  } catch (e) {
    console.error("Debug checkpoints failed:", e);
    $("status").textContent = "Debug checkpoints failed: " + e.message;
  }
}

// Flush pending incremental updates
export async function ftsFlushIncremental() {
  try {
    $("status").textContent = "Flushing pending incremental updates...";

    const result = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "flushIncremental",
    });

    if (result?.ok) {
      $("status").textContent = `Flushed ${result.processed || 0} pending updates`;
    } else {
      $("status").textContent = "No pending updates to flush";
    }
  } catch (e) {
    console.error("Flush incremental failed:", e);
    $("status").textContent = "Flush incremental failed: " + e.message;
  }
}

export async function ftsMaintenanceStatus() {
  try {
    $("status").textContent = "Checking maintenance status...";

    const result = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "maintenanceStatus",
    });

    if (result?.enabled !== undefined) {
      console.log("FTS Maintenance Status:", result);

      let statusText = `Maintenance: ${result.enabled ? "ENABLED" : "DISABLED"}\n\n`;

      // Add timezone information at the top
      const scheduleEntries = Object.entries(result.schedules);
      if (scheduleEntries.length > 0) {
        const firstSchedule = scheduleEntries[0][1];
        statusText += `Timezone: ${firstSchedule.timezone || "Unknown"}\n\n`;
      }

      for (const [type, info] of Object.entries(result.schedules)) {
        statusText += `${type.toUpperCase()}: ${info.enabled ? "ON" : "OFF"} (${info.scope}, every ${info.interval}min)\n`;
        statusText += `  Last scan: ${info.lastScanDate}\n`;
        // Optionally show UTC time for reference if different from 'Never'
        if (
          info.lastScanDateUTC &&
          info.lastScanDateUTC !== "Never" &&
          info.lastScanDate !== "Never"
        ) {
          statusText += `  (UTC: ${info.lastScanDateUTC})\n`;
        }
        statusText += `\n`;
      }

      alert(statusText);
      $("status").textContent =
        "Maintenance status retrieved (see console for details)";
    } else {
      $("status").textContent = "Failed to get maintenance status";
    }
  } catch (e) {
    console.error("Maintenance status failed:", e);
    $("status").textContent = "Failed to get maintenance status: " + e.message;
  }
}

export async function ftsMaintenanceTrigger(type, force = true) {
  try {
    $("fts-progress").style.display = "block";
    $("fts-progress-bar").value = 0;
    $("fts-progress-text").textContent = `Running ${type} maintenance scan...`;

    // Listen for progress updates from the background
    const progressListener = (msg) => {
      if (msg?.type === "ftsProgress" && msg?.scanType === "maintenance") {
        const { folder, folderIndexed, totalIndexed, totalBatches } = msg;
        $("fts-progress-text").textContent = `Maintenance: ${folder}: ${folderIndexed || 0} this folder | Total: ${totalIndexed || 0} messages (${totalBatches || 0} batches)`;
        const current = $("fts-progress-bar").value;
        $("fts-progress-bar").value = (current + 5) % 100;
      }
    };
    browser.runtime.onMessage.addListener(progressListener);

    const result = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "maintenanceTrigger",
      scheduleType: type,
      force,
      progress: true,
    });

    browser.runtime.onMessage.removeListener(progressListener);

    if (result?.ok) {
      $("fts-progress-text").textContent = `${type} maintenance scan completed: ${
        result.indexed || 0
      } messages processed${result.skipped ? `, ${result.skipped} skipped` : ""}`;
      setTimeout(async () => {
        $("fts-progress").style.display = "none";
        await loadMaintenanceLog();
      }, 3000);
    } else {
      $("fts-progress").style.display = "none";
      $("status").textContent = `Failed to run ${type} maintenance scan`;
    }
  } catch (e) {
    $("fts-progress").style.display = "none";
    console.error(`${type} maintenance scan failed:`, e);
    $("status").textContent = `Failed to run ${type} maintenance scan: ` + e.message;
  }
}

export async function ftsCleanupTrigger(type) {
  try {
    $("status").textContent = `Triggering ${type} cleanup scan...`;

    const result = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "cleanupTrigger",
      scheduleType: type,
    });

    if (result?.ok) {
      $("status").textContent = `${type} cleanup scan completed: ${
        result.processed || 0
      } entries processed, ${result.removed || 0} removed`;
      // Refresh maintenance log after completion
      await loadMaintenanceLog();
    } else {
      $("status").textContent = `Failed to run ${type} cleanup scan`;
    }
  } catch (e) {
    console.error(`${type} cleanup scan failed:`, e);
    $("status").textContent = `Failed to run ${type} cleanup scan: ` + e.message;
  }
}

export async function ftsMaintenanceDebug() {
  try {
    $("status").textContent = "Checking alarm status...";

    const result = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "maintenanceDebug",
    });

    if (result) {
      console.log("FTS Maintenance Debug:", result);

      if (result.maintenance === 0) {
        $("status").textContent = `No maintenance alarms found! Scheduler initialized: ${result.isInitialized}`;
      } else {
        let statusText = `Found ${result.maintenance} maintenance alarms:`;
        result.alarms.forEach((alarm) => {
          statusText += `\n${alarm.name}: next in ${alarm.timeUntilNext} minutes`;
        });
        $("status").textContent = statusText;
      }
    } else {
      $("status").textContent = "Failed to get alarm debug info";
    }
  } catch (e) {
    console.error("Maintenance debug failed:", e);
    $("status").textContent = "Failed to debug alarms: " + e.message;
  }
}

/**
 * Load and display maintenance log history
 */
export async function loadMaintenanceLog() {
  try {
    const logContainer = $("fts-maintenance-log");
    if (!logContainer) {
      return;
    }

    const stored = await browser.storage.local.get({ fts_maintenance_log: [] });
    const log = stored.fts_maintenance_log || [];

    if (log.length === 0) {
      logContainer.innerHTML = `
        <div style="text-align: center; opacity: 0.7; padding: 8px;">
          No maintenance history yet. History will appear here after maintenance runs.
        </div>
      `;
      return;
    }

    function escapeHtml(s) {
      // Handle null/undefined but preserve 0 and other falsy values
      const str = (s === null || s === undefined) ? "" : String(s);
      return str
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    // Format each log entry
    const logHtml = log.map((entry) => {
      const date = new Date(entry.timestamp);
      const dateStr = date.toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      // Format type label for display
      const isCleanupOnly = entry.type.endsWith('-cleanup');
      let typeLabel = entry.type;
      if (entry.type === 'full-maintenance') {
        typeLabel = 'Full Maintenance';
      } else if (isCleanupOnly) {
        // e.g., "weekly-cleanup" -> "Weekly Cleanup"
        const base = entry.type.replace('-cleanup', '');
        typeLabel = `${base.charAt(0).toUpperCase() + base.slice(1)} Cleanup`;
      } else {
        // Standard type like "weekly", "daily", "hourly"
        typeLabel = entry.type.charAt(0).toUpperCase() + entry.type.slice(1);
      }
      
      // For cleanup-only runs, use cleanupProcessed instead of scanned
      const scanned = isCleanupOnly 
        ? (entry.cleanupProcessed ?? 0)
        : (entry.scanned ?? entry.indexed ?? 0);
      const scannedLabel = isCleanupOnly ? "processed" : "scanned";
      const corrected = entry.corrected ?? 0;
      const correctedIndexed = entry.correctedIndexed ?? 0;
      const correctedRemoved = entry.correctedRemoved ?? entry.cleanupRemoved ?? 0;
      const skipped = entry.skipped || 0;

      // Build summary: scanned vs corrected
      const correctedText =
        corrected > 0
          ? `${corrected} corrected`
          : (correctedIndexed > 0 || correctedRemoved > 0)
            ? `${correctedIndexed + correctedRemoved} corrected`
            : "0 corrected";

      const detailParts = [];
      if ((correctedIndexed || 0) > 0) detailParts.push(`${correctedIndexed} indexed`);
      if ((correctedRemoved || 0) > 0) detailParts.push(`${correctedRemoved} removed`);
      if ((skipped || 0) > 0) detailParts.push(`${skipped} skipped`);
      const detailText = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";

      const corrections = Array.isArray(entry.corrections) ? entry.corrections : [];
      const hasCorrections = corrections.length > 0 || !!entry.correctionsTruncated;

      const summaryHtml = `
        <div class="tm-maint-summary" style="
          padding: 4px 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          list-style: none;
        ">
          <span style="flex: 1;">
            <span class="tm-maint-expand-indicator" style="display: inline-block; width: 1em; opacity: 0.6;">▸</span>
            <strong>${escapeHtml(typeLabel)}</strong> - ${escapeHtml(dateStr)}
          </span>
          <span style="margin-left: 12px; opacity: 0.7;">
            ${escapeHtml(scanned)} ${escapeHtml(scannedLabel)}, ${escapeHtml(correctedText)}${escapeHtml(detailText)}
          </span>
        </div>
      `;

      // Build expanded content
      let expandedContent;
      if (hasCorrections) {
        const correctionsLines = corrections.map((c) => {
          const action = c?.action || "unknown";
          const msgId = c?.msgId || "";
          const folderPath = c?.folderPath || "";
          const folderName = c?.folderName || "";
          const subject = c?.subject || "";
          return `<div style="padding: 2px 0; opacity: 0.9;">
            <span style="opacity: 0.8;">${escapeHtml(action)}</span>
            <span> | </span>
            <span>${escapeHtml(msgId)}</span>
            ${subject ? `<span> | </span><span>${escapeHtml(subject)}</span>` : ""}
            ${(folderPath || folderName) ? `<span> | </span><span style="opacity:0.8;">${escapeHtml(folderName || folderPath)}</span>` : ""}
          </div>`;
        }).join("");

        const truncatedNote = entry.correctionsTruncated
          ? `<div style="padding-top: 6px; opacity: 0.7;">(corrections list truncated)</div>`
          : "";

        expandedContent = `
          <div style="padding: 6px 0 10px 18px;">
            <div style="opacity: 0.8; padding-bottom: 6px;">Corrected messages:</div>
            ${correctionsLines || `<div style="opacity:0.7;">(no correction details stored)</div>`}
            ${truncatedNote}
          </div>
        `;
      } else {
        expandedContent = `
          <div style="padding: 6px 0 10px 18px; opacity: 0.7;">
            No changes made — index was already up to date.
          </div>
        `;
      }

      return `
        <details class="tm-maint-entry">
          <summary style="cursor: pointer; border-bottom: 1px solid var(--panel-separator-color);">${summaryHtml}</summary>
          ${expandedContent}
        </details>
      `;
    }).join("");

    logContainer.innerHTML = logHtml;
    applyMaintenanceLogSizing(logContainer);
  } catch (e) {
    console.warn("[TMDBG Config] loadMaintenanceLog failed", e);
    const logContainer = $("fts-maintenance-log");
    if (logContainer) {
      logContainer.innerHTML = `
        <div style="text-align: center; color: var(--tag-tm-delete); padding: 8px;">
          Error loading maintenance history: ${e.message}
        </div>
      `;
    }
  }
}

// Keep the maintenance history viewer compact and scrollable after a fixed number of entries.
const MAINTENANCE_LOG_UI = Object.freeze({
  maxVisibleEntries: 10,
});

function applyMaintenanceLogSizing(logContainer) {
  try {
    const firstSummary = logContainer.querySelector(".tm-maint-summary");
    if (!firstSummary) {
      return;
    }

    const entryHeight = firstSummary.getBoundingClientRect().height;
    if (!entryHeight || !Number.isFinite(entryHeight)) {
      return;
    }

    const maxHeightPx = Math.ceil(entryHeight * MAINTENANCE_LOG_UI.maxVisibleEntries);
    logContainer.style.maxHeight = `${maxHeightPx}px`;
  } catch (e) {
    console.warn("[TMDBG Config] applyMaintenanceLogSizing failed", e);
  }
}

/**
 * Download all message event logs to the logs folder
 */
export async function downloadEventLogs() {
  const statusEl = document.getElementById("fts-event-log-status");
  try {
    if (statusEl) statusEl.textContent = "Fetching event logs...";

    // Get the full event log from the background script
    const result = await browser.runtime.sendMessage({
      command: "get-event-log",
      options: { export: true },
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Failed to get event log");
    }

    const eventCount = result.events?.length || 0;
    if (eventCount === 0) {
      if (statusEl) statusEl.textContent = "No events to download";
      return;
    }

    // Create a blob with the event log data
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `logs/tabmail_event_log_${timestamp}.json`;

    await browser.downloads.download({ url, filename, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    if (statusEl) statusEl.textContent = `Downloaded ${eventCount} events`;
    console.log(`[TMDBG Config] Downloaded ${eventCount} event log entries`);
  } catch (e) {
    console.error("[TMDBG Config] downloadEventLogs failed:", e);
    if (statusEl) statusEl.textContent = `Error: ${e.message}`;
  }
}

/**
 * Clear all stored event logs
 */
export async function clearEventLogs() {
  const statusEl = document.getElementById("fts-event-log-status");
  try {
    if (!confirm("Are you sure you want to clear all message event logs?")) {
      return;
    }

    if (statusEl) statusEl.textContent = "Clearing...";

    const result = await browser.runtime.sendMessage({
      command: "clear-event-log",
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Failed to clear event log");
    }

    if (statusEl) statusEl.textContent = "Event logs cleared";
    console.log("[TMDBG Config] Event logs cleared");
  } catch (e) {
    console.error("[TMDBG Config] clearEventLogs failed:", e);
    if (statusEl) statusEl.textContent = `Error: ${e.message}`;
  }
}

export async function handleFtsMaintenanceChange(e) {
  // Auto-save FTS maintenance checkboxes
  if (e.target.id === "fts-maintenance-enabled") {
    const enabled = e.target.checked;
    await browser.storage.local.set({ chat_ftsMaintenanceEnabled: enabled });
    try {
      await browser.runtime.sendMessage({
        type: "fts",
        cmd: "maintenanceUpdate",
        settings: { chat_ftsMaintenanceEnabled: enabled },
      });
    } catch (err) {
      console.warn("[TMDBG Config] Failed to update maintenance scheduler:", err);
    }
    console.log(
      `[TMDBG Config] FTS maintenance ${enabled ? "enabled" : "disabled"}`,
    );
  }
  if (e.target.id === "fts-maintenance-hourly") {
    const enabled = e.target.checked;
    await browser.storage.local.set({ chat_ftsMaintenanceHourlyEnabled: enabled });
    try {
      await browser.runtime.sendMessage({
        type: "fts",
        cmd: "maintenanceUpdate",
        settings: { chat_ftsMaintenanceHourlyEnabled: enabled },
      });
    } catch (err) {
      console.warn("[TMDBG Config] Failed to update maintenance scheduler:", err);
    }
    console.log(
      `[TMDBG Config] Hourly maintenance ${enabled ? "enabled" : "disabled"}`,
    );
  }
  if (e.target.id === "fts-maintenance-daily") {
    const enabled = e.target.checked;
    await browser.storage.local.set({ chat_ftsMaintenanceDailyEnabled: enabled });
    try {
      await browser.runtime.sendMessage({
        type: "fts",
        cmd: "maintenanceUpdate",
        settings: { chat_ftsMaintenanceDailyEnabled: enabled },
      });
    } catch (err) {
      console.warn("[TMDBG Config] Failed to update maintenance scheduler:", err);
    }
    console.log(
      `[TMDBG Config] Daily maintenance ${enabled ? "enabled" : "disabled"}`,
    );
  }
  if (e.target.id === "fts-maintenance-weekly") {
    const enabled = e.target.checked;
    await browser.storage.local.set({ chat_ftsMaintenanceWeeklyEnabled: enabled });
    try {
      await browser.runtime.sendMessage({
        type: "fts",
        cmd: "maintenanceUpdate",
        settings: { chat_ftsMaintenanceWeeklyEnabled: enabled },
      });
    } catch (err) {
      console.warn("[TMDBG Config] Failed to update maintenance scheduler:", err);
    }
    // Update visibility of schedule settings
    updateWeeklyScheduleVisibility();
    console.log(
      `[TMDBG Config] Weekly maintenance ${enabled ? "enabled" : "disabled"}`,
    );
  }
  if (e.target.id === "fts-maintenance-monthly") {
    const enabled = e.target.checked;
    await browser.storage.local.set({ chat_ftsMaintenanceMonthlyEnabled: enabled });
    try {
      await browser.runtime.sendMessage({
        type: "fts",
        cmd: "maintenanceUpdate",
        settings: { chat_ftsMaintenanceMonthlyEnabled: enabled },
      });
    } catch (err) {
      console.warn("[TMDBG Config] Failed to update maintenance scheduler:", err);
    }
    console.log(
      `[TMDBG Config] Monthly maintenance ${enabled ? "enabled" : "disabled"}`,
    );
  }
  
  // Weekly schedule settings
  if (e.target.id === "fts-maintenance-weekly-day") {
    const dayOfWeek = parseInt(e.target.value, 10) || 3;
    await browser.storage.local.set({ chat_ftsMaintenanceWeeklyDay: dayOfWeek });
    try {
      await browser.runtime.sendMessage({
        type: "fts",
        cmd: "maintenanceUpdate",
        settings: { chat_ftsMaintenanceWeeklyDay: dayOfWeek },
      });
    } catch (err) {
      console.warn("[TMDBG Config] Failed to update maintenance scheduler:", err);
    }
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    console.log(`[TMDBG Config] Weekly maintenance day set to ${dayNames[dayOfWeek]}`);
  }
  if (e.target.id === "fts-maintenance-weekly-hour-start") {
    const hourStart = parseInt(e.target.value, 10) || 9;
    await browser.storage.local.set({ chat_ftsMaintenanceWeeklyHourStart: hourStart });
    try {
      await browser.runtime.sendMessage({
        type: "fts",
        cmd: "maintenanceUpdate",
        settings: { chat_ftsMaintenanceWeeklyHourStart: hourStart },
      });
    } catch (err) {
      console.warn("[TMDBG Config] Failed to update maintenance scheduler:", err);
    }
    console.log(`[TMDBG Config] Weekly maintenance start hour set to ${hourStart}`);
  }
  if (e.target.id === "fts-maintenance-weekly-hour-end") {
    const hourEnd = parseInt(e.target.value, 10) || 12;
    await browser.storage.local.set({ chat_ftsMaintenanceWeeklyHourEnd: hourEnd });
    try {
      await browser.runtime.sendMessage({
        type: "fts",
        cmd: "maintenanceUpdate",
        settings: { chat_ftsMaintenanceWeeklyHourEnd: hourEnd },
      });
    } catch (err) {
      console.warn("[TMDBG Config] Failed to update maintenance scheduler:", err);
    }
    console.log(`[TMDBG Config] Weekly maintenance end hour set to ${hourEnd}`);
  }
}

