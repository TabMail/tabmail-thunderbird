const { ExtensionSupport: ExtensionSupportTMUpdates } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonTMUpdates } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { AddonManager: AddonManagerTMUpdates } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
const { setTimeout: tmSetTimeout, clearTimeout: tmClearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

var ServicesTMUpdates = globalThis.Services;

// Configuration - DO NOT use hardcoded values inline
const TMUPDATES_CONFIG = {
  logPrefix: "[TMDBG Updates]",
  updateBar: {
    id: "tabmail-update-notification-bar",
    height: 40,
    zIndex: 99999,
  },
  updateCheck: {
    timeoutMs: 30000, // 30 second timeout for update checks
  },
};

function tmLog(...args) {
  console.log(TMUPDATES_CONFIG.logPrefix, ...args);
}

function tmWarn(...args) {
  console.warn(TMUPDATES_CONFIG.logPrefix, ...args);
}

function tmErr(...args) {
  console.error(TMUPDATES_CONFIG.logPrefix, ...args);
}

// Track current pending update version
let pendingVersion = null;
let eventEmitter = null;

/**
 * Create the update notification bar element for a window
 */
function createUpdateBar(win, context, version) {
  const doc = win.document;
  
  // Check if bar already exists
  if (doc.getElementById(TMUPDATES_CONFIG.updateBar.id)) {
    tmLog("Update bar already exists in window, updating version");
    updateExistingBar(win, version);
    return;
  }
  
  tmLog("Creating update bar in window", win.location?.href);
  
  // Create container - use vbox for vertical layout (message on top, buttons on bottom)
  const bar = doc.createXULElement("vbox");
  bar.id = TMUPDATES_CONFIG.updateBar.id;
  bar.setAttribute("align", "start");
  bar.setAttribute("pack", "start");
  
  // Inline styles for the bar (positioned at bottom-left)
  bar.style.cssText = `
    position: fixed;
    bottom: 8px;
    left: 8px;
    z-index: ${TMUPDATES_CONFIG.updateBar.zIndex};
    background: var(--in-content-box-background, #1c1c1e);
    border: 1px solid var(--panel-separator-color, #3a3a3c);
    border-radius: 8px;
    padding: 12px 16px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    color: var(--in-content-page-color, #f5f5f7);
    gap: 12px;
    max-width: 480px;
  `;
  
  // Top section: Icon + Message (horizontal, can expand)
  const topSection = doc.createXULElement("hbox");
  topSection.setAttribute("align", "start");
  topSection.style.cssText = "gap: 14px; width: 100%;";
  
  // Icon - simple down arrow indicating download complete
  const icon = doc.createXULElement("label");
  icon.textContent = "↓";
  icon.style.cssText = `
    font-size: 18px;
    flex-shrink: 0;
    opacity: 0.7;
    font-weight: 300;
  `;
  topSection.appendChild(icon);
  
  // Message container (two lines)
  const messageContainer = doc.createXULElement("vbox");
  messageContainer.style.cssText = "flex: 1; gap: 2px; min-width: 0;";
  
  // Line 1: Main message
  const line1 = doc.createXULElement("label");
  line1.className = "tm-update-message-line1";
  line1.textContent = "A new version of TabMail has been downloaded.";
  line1.style.cssText = "font-weight: 500;";
  messageContainer.appendChild(line1);
  
  // Line 2: Action hint with version
  const line2 = doc.createXULElement("label");
  line2.className = "tm-update-message-line2";
  line2.textContent = version 
    ? `Restart Thunderbird to update to v${version}.`
    : "Restart Thunderbird to update to the latest version.";
  line2.style.cssText = "opacity: 0.7; font-size: 12px;";
  messageContainer.appendChild(line2);
  
  topSection.appendChild(messageContainer);
  bar.appendChild(topSection);
  
  // Bottom section: Buttons aligned to the right
  const btnContainer = doc.createXULElement("hbox");
  btnContainer.setAttribute("align", "end");
  btnContainer.setAttribute("pack", "end");
  btnContainer.style.cssText = "gap: 8px; width: 100%; justify-content: flex-end;";
  
  // Later button (dismiss)
  const dismissBtn = doc.createXULElement("button");
  dismissBtn.textContent = "Later";
  dismissBtn.style.cssText = `
    padding: 6px 14px;
    border: 1px solid var(--panel-separator-color, #3a3a3c);
    border-radius: 6px;
    background: transparent;
    color: var(--in-content-page-color, #f5f5f7);
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
  `;
  dismissBtn.addEventListener("click", () => {
    tmLog("User clicked Later");
    hideUpdateBarFromWindow(win);
    if (eventEmitter) {
      eventEmitter.emit("onNotificationAction", { action: "dismiss" });
    }
  });
  btnContainer.appendChild(dismissBtn);
  
  // Restart Thunderbird button
  const restartBtn = doc.createXULElement("button");
  restartBtn.textContent = "Restart Thunderbird";
  restartBtn.style.cssText = `
    padding: 6px 14px;
    border: none;
    border-radius: 6px;
    background: var(--in-content-accent-color, #0a84ff);
    color: white;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  `;
  restartBtn.addEventListener("click", () => {
    tmLog("User clicked Restart Thunderbird");
    if (eventEmitter) {
      eventEmitter.emit("onNotificationAction", { action: "restart" });
    }
    // Restart will be triggered by the WebExtension handler
  });
  btnContainer.appendChild(restartBtn);
  
  bar.appendChild(btnContainer);
  
  // Append to document
  const container = doc.documentElement;
  container.appendChild(bar);
  
  // Store reference for cleanup
  win.__tmUpdateBar = bar;
  
  tmLog("Update bar created successfully");
}

/**
 * Update existing bar with new version
 */
function updateExistingBar(win, version) {
  const doc = win.document;
  const bar = doc.getElementById(TMUPDATES_CONFIG.updateBar.id);
  if (!bar) return;
  
  // Update line 2 with the version
  const line2 = bar.querySelector(".tm-update-message-line2");
  if (line2) {
    line2.textContent = version 
      ? `Restart Thunderbird to update to v${version}.`
      : "Restart Thunderbird to update to the latest version.";
  }
}

/**
 * Hide update bar from a specific window
 */
function hideUpdateBarFromWindow(win) {
  try {
    const doc = win.document;
    const bar = doc.getElementById(TMUPDATES_CONFIG.updateBar.id);
    if (bar) {
      bar.remove();
      delete win.__tmUpdateBar;
      tmLog("Update bar removed from window");
    }
  } catch (e) {
    tmWarn("Failed to hide update bar from window:", e);
  }
}

/**
 * Iterate over all 3-pane windows
 */
function forEach3Pane(callback) {
  try {
    const enumWin = ServicesTMUpdates?.wm?.getEnumerator?.("mail:3pane");
    if (!enumWin) return;
    while (enumWin.hasMoreElements()) {
      const win = enumWin.getNext();
      try {
        if (!win || win.closed) continue;
        callback(win);
      } catch (e) {
        tmWarn("forEach3Pane callback error:", e);
      }
    }
  } catch (e) {
    tmWarn("forEach3Pane failed:", e);
  }
}

/**
 * Show update bar in all windows
 */
function showUpdateBarInAllWindows(context, version) {
  pendingVersion = version;
  forEach3Pane((win) => {
    createUpdateBar(win, context, version);
  });
}

/**
 * Hide update bar from all windows
 */
function hideUpdateBarFromAllWindows() {
  forEach3Pane((win) => {
    hideUpdateBarFromWindow(win);
  });
}

/**
 * Restart Thunderbird
 */
function doRestartThunderbird() {
  tmLog("Initiating Thunderbird restart...");
  try {
    // nsIAppStartup flags (from IDL):
    // eAttemptQuit = 0x01 - attempt to quit  
    // eForceQuit = 0x02 - force quit (skip confirmations)
    // eRestart = 0x10 - restart after quitting
    // Using eForceQuit to bypass any dialogs that might block
    const RESTART_FLAGS = 0x02 | 0x10; // eForceQuit | eRestart
    
    // Check if startup service is available and has quit method
    if (!ServicesTMUpdates?.startup?.quit) {
      tmErr("Services.startup.quit not available!");
      tmLog("ServicesTMUpdates:", ServicesTMUpdates);
      tmLog("ServicesTMUpdates.startup:", ServicesTMUpdates?.startup);
      return { ok: false, error: "Services.startup.quit not available" };
    }
    
    tmLog("Services.startup available, startup type:", typeof ServicesTMUpdates.startup);
    tmLog("quit method type:", typeof ServicesTMUpdates.startup.quit);
    
    // Use ChromeUtils.idleDispatch to defer the quit call
    // This allows the async response to complete before quitting
    if (typeof ChromeUtils !== "undefined" && ChromeUtils.idleDispatch) {
      ChromeUtils.idleDispatch(() => {
        tmLog("IdleDispatch: calling quit with flags:", RESTART_FLAGS);
        try {
          ServicesTMUpdates.startup.quit(RESTART_FLAGS);
        } catch (e) {
          tmErr("IdleDispatch: quit failed:", e);
        }
      });
      tmLog("Restart scheduled via ChromeUtils.idleDispatch");
    } else {
      // Direct call (might not work if response is pending)
      tmLog("Calling quit directly with flags:", RESTART_FLAGS);
      ServicesTMUpdates.startup.quit(RESTART_FLAGS);
    }
    
    return { ok: true };
  } catch (e) {
    tmErr("Failed to restart Thunderbird:", e);
    return { ok: false, error: String(e) };
  }
}

try {
  console.log(
    "[TabMail tmUpdates] experiment parent script loaded. Services present?",
    typeof ServicesTMUpdates !== "undefined"
  );
} catch (_) {}

var tmUpdates = class extends ExtensionCommonTMUpdates.ExtensionAPI {
  onShutdown(isAppShutdown) {
    console.log("[TabMail tmUpdates] onShutdown() called by Thunderbird, isAppShutdown:", isAppShutdown);
    try {
      if (this._cleanup) {
        this._cleanup();
        console.log("[TabMail tmUpdates] ✓ Cleanup completed via onShutdown");
      }
    } catch (e) {
      console.error("[TabMail tmUpdates] onShutdown cleanup failed:", e);
    }
  }

  getAPI(context) {
    const listenerId = context.extension.id + "-tmUpdates-windows";
    
    const cleanup = () => {
      tmLog("cleanup() called");
      try {
        // Unregister window listener
        try {
          ExtensionSupportTMUpdates.unregisterWindowListener(listenerId);
        } catch (_) {}
        
        // Remove update bars from all windows
        hideUpdateBarFromAllWindows();
        
        // Clear state
        pendingVersion = null;
        eventEmitter = null;
        
        tmLog("Cleanup complete");
      } catch (e) {
        tmWarn("cleanup failed:", e);
      }
    };

    this._cleanup = cleanup;

    return {
      tmUpdates: {
        async showUpdateBar(options) {
          tmLog("═══ showUpdateBar() START ═══", options);
          
          const version = options?.version || null;
          pendingVersion = version;
          
          // Register window listener for new windows
          try {
            ExtensionSupportTMUpdates.unregisterWindowListener(listenerId);
          } catch (_) {}
          
          ExtensionSupportTMUpdates.registerWindowListener(listenerId, {
            chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
            onLoadWindow(win) {
              if (pendingVersion) {
                createUpdateBar(win, context, pendingVersion);
              }
            },
          });
          
          // Show in all existing windows
          showUpdateBarInAllWindows(context, version);
          
          tmLog("═══ showUpdateBar() DONE ═══");
          return { ok: true };
        },

        async hideUpdateBar() {
          tmLog("═══ hideUpdateBar() START ═══");
          
          pendingVersion = null;
          hideUpdateBarFromAllWindows();
          
          // Unregister window listener
          try {
            ExtensionSupportTMUpdates.unregisterWindowListener(listenerId);
          } catch (_) {}
          
          tmLog("═══ hideUpdateBar() DONE ═══");
          return { ok: true };
        },

        async restartThunderbird() {
          tmLog("═══ restartThunderbird() START ═══");
          const result = doRestartThunderbird();
          tmLog("═══ restartThunderbird() DONE ═══", result);
          return result;
        },

        async isUpdateBarVisible() {
          return pendingVersion !== null;
        },

        async checkForUpdates() {
          tmLog("═══ checkForUpdates() START ═══");
          try {
            // Get the addon by ID
            const addon = await AddonManagerTMUpdates.getAddonByID(context.extension.id);
            if (!addon) {
              tmErr("Could not find addon by ID:", context.extension.id);
              return { status: "error", error: "Addon not found" };
            }
            
            tmLog("Found addon:", addon.id, "version:", addon.version);
            
            // Create an update check listener with timeout
            const updatePromise = new Promise((resolve) => {
              let resolved = false;
              
              // Timeout to prevent hanging forever on network issues
              const timeoutId = tmSetTimeout(() => {
                if (!resolved) {
                  resolved = true;
                  tmWarn("Update check timed out after", TMUPDATES_CONFIG.updateCheck.timeoutMs, "ms");
                  resolve({
                    status: "error",
                    error: "Update check timed out",
                    currentVersion: addon.version,
                  });
                }
              }, TMUPDATES_CONFIG.updateCheck.timeoutMs);
              
              const listener = {
                onUpdateAvailable(addon, install) {
                  if (resolved) return;
                  resolved = true;
                  tmClearTimeout(timeoutId);
                  
                  tmLog("Update available:", install.version, "- starting download...");
                  
                  // Start the download/install process in the background
                  // This will trigger browser.runtime.onUpdateAvailable when complete
                  // DO NOT wait for install.install() - it may not resolve until restart
                  install.install().then(() => {
                    tmLog("Update download completed for version:", install.version);
                  }).catch((installErr) => {
                    tmWarn("Update download issue (may still work):", installErr);
                  });
                  
                  // Resolve immediately - the install is async and the popup should update now
                  resolve({
                    status: "update_available",
                    version: install.version,
                    currentVersion: addon.version,
                  });
                },
                onNoUpdateAvailable(addon) {
                  if (resolved) return;
                  resolved = true;
                  tmClearTimeout(timeoutId);
                  
                  tmLog("No update available");
                  resolve({
                    status: "no_update",
                    currentVersion: addon.version,
                  });
                },
                onUpdateFinished(addon, error) {
                  // This is called after onUpdateAvailable or onNoUpdateAvailable
                  // Handle case where no other callback was triggered (e.g., network error)
                  if (resolved) return;
                  
                  tmClearTimeout(timeoutId);
                  resolved = true;
                  
                  if (error) {
                    tmErr("Update check finished with error:", error);
                    resolve({
                      status: "error",
                      error: String(error),
                      currentVersion: addon.version,
                    });
                  } else {
                    // No error but also no previous callback - treat as no update
                    tmLog("Update check finished with no error and no previous callback");
                    resolve({
                      status: "no_update",
                      currentVersion: addon.version,
                    });
                  }
                },
              };
              
              // Trigger the update check
              addon.findUpdates(
                listener,
                AddonManagerTMUpdates.UPDATE_WHEN_USER_REQUESTED
              );
            });
            
            const result = await updatePromise;
            tmLog("═══ checkForUpdates() DONE ═══", result);
            return result;
          } catch (e) {
            tmErr("checkForUpdates failed:", e);
            return { status: "error", error: String(e) };
          }
        },

        onNotificationAction: new ExtensionCommonTMUpdates.EventManager({
          context,
          name: "tmUpdates.onNotificationAction",
          register: (fire) => {
            eventEmitter = {
              emit: (eventName, data) => {
                if (eventName === "onNotificationAction") {
                  fire.async(data);
                }
              },
            };
            return () => {
              eventEmitter = null;
            };
          },
        }).api(),
      },
    };
  }
};
