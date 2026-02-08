import { handleAppearanceChange, loadAppearanceSettings } from "./appearance.js";
import { handleComposeSettingsChange, loadComposeSettings } from "./composeSettings.js";
import { handleDebugChange, loadDebugSettings } from "./debugSettings.js";
import { $ } from "./dom.js";
import { fsApply, fsLoad } from "./folderSync.js";
import {
    clearEventLogs,
    downloadEventLogs,
    ftsManualCheckAndUpdateHost,
    ftsCleanupTrigger,
    ftsClear,
    ftsDebugCheckpoints,
    ftsDebugSample,
    ftsDiagnostics,
    ftsFlushIncremental,
    ftsMaintenanceDebug,
    ftsMaintenanceStatus,
    ftsMaintenanceTrigger,
    ftsPause,
    ftsReindexAll,
    ftsResume,
    ftsSmartReindex,
    handleFtsMaintenanceChange,
    loadFtsSettings,
    loadMaintenanceLog,
    updateFtsStatus,
} from "./fts.js";
import {
    loadAddressBooks,
    loadCalendars,
    saveAddressBookConfig,
    saveCalendarConfig,
} from "./integrations.js";
import { forcePlaintextAll, updatePlaintextStatusUI } from "./plaintext.js";
import { updateQuotaDisplay } from "./planUsage.js";
import { handlePrivacyChange, loadPrivacySettings } from "./privacy.js";
import { handleReminderChange, loadReminderSettings, saveReminderSettings } from "./reminders.js";
import {
    createPromptEditorsInputHandler,
    createPromptsUpdatedRuntimeListener,
} from "./runtimeListeners.js";
import {
    handleUiTweaksClick,
} from "./uiTweaks.js";
import {
    clearUpdateState,
    hideUpdateBar,
    restartThunderbird,
    showUpdateBar,
    simulateUpdateAvailable,
    updateDebugStatusDisplay,
} from "./updateDebug.js";
import { handleNotificationChange, loadNotificationSettings } from "./notifications.js";
import { handleWebSearchChange, loadWebSearchSettings } from "./webSearch.js";
import {
    clearWelcomeStatus,
    openWelcomeWizard,
    updateWelcomeStatusDisplay,
} from "./welcomeWizard.js";
import {
    generateWhatsAppLinkCode,
    handleWhatsAppButtonClick,
    hideWhatsAppDialog,
    loadChatLinkStatus,
} from "./chatlink.js";

export async function initConfigPage({
  SETTINGS,
  getBackendUrl,
  log,
  getPrivacyOptOutAllAiEnabled,
  setPrivacyOptOutAllAiEnabled,
}) {
  // Store listener references for cleanup
  let configRuntimeMessageListener = null;
  let configStorageListener = null;
  let configDOMListeners = {
    documentChangeHandler: null,
    documentClickHandler: null,
    documentKeydownHandler: null,
    documentInputHandler: null,
  };

  function cleanupConfigRuntimeListener() {
    if (configRuntimeMessageListener) {
      try {
        browser.runtime.onMessage.removeListener(configRuntimeMessageListener);
        configRuntimeMessageListener = null;
        log("[Config] Runtime message listener cleaned up");
      } catch (e) {
        log(`[Config] Failed to remove runtime message listener: ${e}`, "error");
      }
    }
  }

  function cleanupConfigDOMListeners() {
    try {
      if (configDOMListeners.documentChangeHandler) {
        document.removeEventListener("change", configDOMListeners.documentChangeHandler);
        configDOMListeners.documentChangeHandler = null;
      }

      if (configDOMListeners.documentClickHandler) {
        document.removeEventListener("click", configDOMListeners.documentClickHandler);
        configDOMListeners.documentClickHandler = null;
      }

      if (configDOMListeners.documentKeydownHandler) {
        document.removeEventListener(
          "keydown",
          configDOMListeners.documentKeydownHandler,
        );
        configDOMListeners.documentKeydownHandler = null;
      }

      if (configDOMListeners.documentInputHandler) {
        document.removeEventListener("input", configDOMListeners.documentInputHandler);
        configDOMListeners.documentInputHandler = null;
      }

      log("[Config] DOM event listeners cleaned up");
    } catch (e) {
      log(`[Config] Failed to clean up DOM listeners: ${e}`, "error");
    }
  }

  function cleanupConfigStorageListener() {
    if (configStorageListener) {
      try {
        browser.storage.onChanged.removeListener(configStorageListener);
        configStorageListener = null;
        log("[Config] Storage listener cleaned up");
      } catch (e) {
        log(`[Config] Failed to remove storage listener: ${e}`, "error");
      }
    }
  }

  function cleanupAllConfigListeners() {
    cleanupConfigRuntimeListener();
    cleanupConfigStorageListener();
    cleanupConfigDOMListeners();
  }

  // Clean up any existing listeners and set up page cleanup
  cleanupAllConfigListeners();
  window.addEventListener("beforeunload", cleanupAllConfigListeners);

  // Listen for runtime message indicating prompts were updated elsewhere
  try {
    configRuntimeMessageListener = createPromptsUpdatedRuntimeListener(SETTINGS, log);
    browser.runtime.onMessage.addListener(configRuntimeMessageListener);
  } catch (e) {
    console.warn("[TMDBG Config] Failed to attach onMessage listener", e);
  }

  // Listen for storage changes to refresh maintenance log
  try {
    configStorageListener = (changes, areaName) => {
      if (areaName === "local" && changes.fts_maintenance_log) {
        loadMaintenanceLog().catch((e) => {
          console.warn("[TMDBG Config] Failed to refresh maintenance log:", e);
        });
      }
    };
    browser.storage.onChanged.addListener(configStorageListener);
  } catch (e) {
    console.warn("[TMDBG Config] Failed to attach storage listener", e);
  }

  // Prompt editor auto-resize (legacy / removed UI, kept for behavior parity)
  configDOMListeners.documentInputHandler = createPromptEditorsInputHandler();
  document.addEventListener("input", configDOMListeners.documentInputHandler);

  // Setup document change handler
  configDOMListeners.documentChangeHandler = async (e) => {
    console.log(`[TMDBG Config] CHANGE EVENT: target.tagName=${e.target.tagName}, target.name="${e.target.name}", target.id="${e.target.id}", target.value="${e.target.value}"`);
    try {
      console.log(`[TMDBG Config] Calling handleAppearanceChange...`);
      await handleAppearanceChange(e, SETTINGS);
      console.log(`[TMDBG Config] handleAppearanceChange completed`);
    } catch (err) {
      console.error(`[TMDBG Config] handleAppearanceChange THREW ERROR:`, err);
    }
    await handleComposeSettingsChange(e);

    // FTS is always enabled with native helper, no toggle needed
    // (removed enable-fts checkbox handler)
    await handleFtsMaintenanceChange(e);

    await handleDebugChange(e, getBackendUrl);
    await handlePrivacyChange(e, setPrivacyOptOutAllAiEnabled);
    await handleReminderChange(e, log);
    await handleWebSearchChange(e);
    await handleNotificationChange(e);

    // Auto-save calendar selection
    if (e.target.id === "default-calendar") {
      await saveCalendarConfig();
    }

    // Auto-save address book selection
    if (e.target.id === "default-addressbook") {
      await saveAddressBookConfig();
    }

    // Keepalive is always-on, no manual configuration
  };
  document.addEventListener("change", configDOMListeners.documentChangeHandler);

  // Setup document click handler
  configDOMListeners.documentClickHandler = async (e) => {
    await handleUiTweaksClick(e);

    if (e.target.id === "refresh-usage") {
      await updateQuotaDisplay(getBackendUrl);
    }

    if (e.target.id === "upgrade-to-pro-btn") {
      // Open pricing page in browser
      try {
        const pricingUrl = "https://tabmail.ai/pricing";
        await browser.tabs.create({ url: pricingUrl });
      } catch (err) {
        console.error("[Config] Failed to open pricing page:", err);
      }
    }

    // Rerun welcome wizard button (in header)
    if (e.target.id === "rerun-welcome-wizard") {
      await openWelcomeWizard(SETTINGS);
    }

    // TB auth page previews (debug mode only)
    if (
      e.target.id === "tb-preview-signin" ||
      e.target.id === "tb-preview-signup" ||
      e.target.id === "tb-preview-consent" ||
      e.target.id === "tb-preview-signup-confirm"
    ) {
      try {
        const base = "http://localhost:8000";
        const map = {
          "tb-preview-signin": `${base}/signin.html?client=thunderbird&preview=1`,
          "tb-preview-signup": `${base}/signup.html?client=thunderbird&preview=1`,
          "tb-preview-consent": `${base}/consent.html?client=thunderbird&preview=1`,
          "tb-preview-signup-confirm": `${base}/signup-confirm.html?client=thunderbird&preview=1`,
        };
        const url = map[e.target.id];
        console.log(`[Config] Opening TB preview page: ${url}`);
        await browser.windows.create({
          url,
          type: "popup",
          width: SETTINGS.authWindow.defaultWidth,
          height: SETTINGS.authWindow.defaultHeight,
        });
      } catch (err) {
        console.error("[Config] Failed to open TB preview page:", err);
        $("status").textContent =
          "Failed to open localhost preview. Is http://localhost:8000 running?";
      }
    }

    if (e.target.id === "save-reminder-settings") {
      await saveReminderSettings(log);
    }

    if (e.target.id === "reload-reminder-settings") {
      await loadReminderSettings(log);
    }

    // Folder Sync controls
    if (e.target.id === "fs-reload") {
      await fsLoad();
    }
    if (e.target.id === "fs-apply") {
      await fsApply();
    }

    // FTS controls
    if (e.target.id === "refresh-fts-status") {
      await updateFtsStatus();
    }

    // Plaintext composition controls
    if (e.target.id === "refresh-plaintext-status") {
      await updatePlaintextStatusUI(log);
    }
    if (e.target.id === "force-plaintext-all") {
      await forcePlaintextAll(log);
    }
    if (e.target.id === "fts-reindex-all") {
      await ftsReindexAll();
    }
    if (e.target.id === "fts-check-update") {
      await ftsManualCheckAndUpdateHost();
    }
    if (e.target.id === "fts-smart-reindex") {
      await ftsSmartReindex();
    }
    if (e.target.id === "fts-refresh-status") {
      await updateFtsStatus();
    }
    if (e.target.id === "fts-pause") {
      await ftsPause();
    }
    if (e.target.id === "fts-resume") {
      await ftsResume();
    }
    if (e.target.id === "fts-clear") {
      await ftsClear();
    }
    if (e.target.id === "fts-diagnostics") {
      await ftsDiagnostics();
    }
    if (e.target.id === "fts-debug-sample") {
      await ftsDebugSample();
    }
    if (e.target.id === "fts-debug-checkpoints") {
      await ftsDebugCheckpoints();
    }
    if (e.target.id === "fts-flush-incremental") {
      await ftsFlushIncremental();
    }
    if (e.target.id === "fts-download-event-log") {
      await downloadEventLogs();
    }
    if (e.target.id === "fts-clear-event-log") {
      await clearEventLogs();
    }
    if (e.target.id === "fts-maintenance-status") {
      await ftsMaintenanceStatus();
    }
    if (e.target.id === "fts-maintenance-trigger-hourly") {
      await ftsMaintenanceTrigger("hourly", true);
    }
    if (e.target.id === "fts-maintenance-trigger-daily") {
      await ftsMaintenanceTrigger("daily", true);
    }
    if (e.target.id === "fts-maintenance-debug") {
      await ftsMaintenanceDebug();
    }
    if (e.target.id === "fts-maintenance-refresh-log") {
      await loadMaintenanceLog();
    }
    if (e.target.id === "fts-maintenance-daily-run-now") {
      await ftsMaintenanceTrigger("daily", true);
    }
    if (e.target.id === "fts-maintenance-weekly-run-now") {
      await ftsMaintenanceTrigger("weekly", true);
    }

    // Cleanup trigger buttons
    if (e.target.id === "fts-cleanup-trigger-daily") {
      await ftsCleanupTrigger("daily");
    }
    if (e.target.id === "fts-cleanup-trigger-weekly") {
      await ftsCleanupTrigger("weekly");
    }
    if (e.target.id === "fts-cleanup-trigger-monthly") {
      await ftsCleanupTrigger("monthly");
    }

    if (e.target.id === "clear-action-cache") {
      await browser.runtime.sendMessage({ command: "clear-action-cache" });
      await updateQuotaDisplay(getBackendUrl);
    }
    if (e.target.id === "clear-summary-cache") {
      await browser.runtime.sendMessage({ command: "clear-summary-cache" });
      await updateQuotaDisplay(getBackendUrl);
    }
    if (e.target.id === "clear-reply-cache") {
      await browser.runtime.sendMessage({ command: "clear-reply-cache" });
      await updateQuotaDisplay(getBackendUrl);
    }
    if (e.target.id === "clear-reminders") {
      await browser.runtime.sendMessage({ command: "clear-reminders" });
      await updateQuotaDisplay(getBackendUrl);
    }

    // Open archive prompt from Reminders section (does NOT reset flag)
    if (e.target.id === "open-archive-prompt") {
      const url = browser.runtime.getURL("agent/inbox-archive-prompt.html?days=14");
      await browser.windows.create({ url, type: "popup", width: 580, height: 580 });
    }

    if (e.target.id === "test-inbox-archive-prompt") {
      // Reset the flag and show the prompt
      await browser.runtime.sendMessage({ command: "reset-inbox-archive-prompt" });
      // Open the prompt window directly
      const url = browser.runtime.getURL("agent/inbox-archive-prompt.html?days=14");
      await browser.windows.create({ url, type: "popup", width: 580, height: 580 });
    }

    // Welcome wizard debug controls
    if (e.target.id === "welcome-open-wizard") {
      await openWelcomeWizard(SETTINGS);
    }
    if (e.target.id === "welcome-clear-status") {
      await clearWelcomeStatus(() => updateWelcomeStatusDisplay(log));
    }
    if (e.target.id === "welcome-refresh-status") {
      await updateWelcomeStatusDisplay(log);
    }

    // Update notification debug controls
    if (e.target.id === "update-debug-simulate") {
      await simulateUpdateAvailable();
    }
    if (e.target.id === "update-debug-clear") {
      await clearUpdateState();
    }
    if (e.target.id === "update-debug-refresh") {
      await updateDebugStatusDisplay();
    }
    if (e.target.id === "update-debug-show-bar") {
      await showUpdateBar();
    }
    if (e.target.id === "update-debug-hide-bar") {
      await hideUpdateBar();
    }
    if (e.target.id === "update-debug-restart") {
      await restartThunderbird();
    }

    // Prompt editors moved to dedicated prompts page (prompts/prompts.html)
    // Handlers for prompt save/reload/reset removed

    // ChatLink / External Accounts
    if (e.target.id === "whatsapp-link-btn") {
      await handleWhatsAppButtonClick();
    }
    if (e.target.id === "whatsapp-generate-code-btn") {
      await generateWhatsAppLinkCode();
    }
    if (e.target.id === "whatsapp-cancel-btn") {
      hideWhatsAppDialog();
    }
  };
  document.addEventListener("click", configDOMListeners.documentClickHandler);

  // Keyboard shortcuts for prompt editors removed (prompts moved to dedicated page)
  configDOMListeners.documentKeydownHandler = null;

  await Promise.all([
    updateQuotaDisplay(getBackendUrl),
    loadAppearanceSettings(SETTINGS),
    loadComposeSettings(),
    loadDebugSettings(),
    loadPrivacySettings(getPrivacyOptOutAllAiEnabled, log),
    loadCalendars(),
    loadAddressBooks(),
    loadReminderSettings(log),
    loadFtsSettings(),
    fsLoad(),
    updatePlaintextStatusUI(log),
    updateWelcomeStatusDisplay(log),
    updateDebugStatusDisplay(),
    loadWebSearchSettings(log),
    loadNotificationSettings(log),
    loadChatLinkStatus(),
  ]);
}

