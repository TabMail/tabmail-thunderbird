const { ExtensionCommon: ExtensionCommonTMPrefs } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var ServicesTMPrefs = globalThis.Services;

console.log("[TabMail tmPrefs] experiment parent script loaded. Services present?", typeof ServicesTMPrefs !== "undefined");

// Module-local config (keep numeric values centralized for easier tuning/debug).
const TMPREFS_CONFIG = {
  unthreaded: {
    // How many times to retry applying unthreaded state when about:3pane / gViewWrapper
    // isn't ready yet (common during early startup).
    maxApplyAttempts: 12,
    // Delay between attempts. Keep modest to avoid UI churn, but fast enough to
    // catch initial folder load.
    applyRetryDelayMs: 150,
    // nsMsgViewFlags threaded bit in DBView/viewFlags. Kept here to avoid magic numbers
    // sprinkled through the module.
    viewFlagsThreadedBit: 0x1,
  },
};

// Module-local state for cleanup / hot-reload safety.
const TMPREFS_STATE = {
  unthreadedEnabled: false,
  wmListener: null,
  // WeakMap<Window, Set<number>> timeout ids for cleanup
  timeoutsByWin: new WeakMap(),
};

function prefType(name) { 
  try { 
    return ServicesTMPrefs.prefs.getPrefType(name); 
  } catch { 
    return 0; 
  } 
}

// Type constants
const T = {
  INVALID: 0,
  STRING: 32, // PREF_STRING
  INT:    64, // PREF_INT
  BOOL:  128  // PREF_BOOL
};

// Get preference type safely
function getType(name) {
  try { return ServicesTMPrefs.prefs.getPrefType(name); } catch (_) { return 0; }
}

// Set a "boolean-like" pref: if default is BOOL use bool, if INT use 0/1
function setBooleanLike(name, value) {
  const t = getType(name);
  if (t === T.INT) {
    // if user had wrong type, clear then set int
    try {
      if (ServicesTMPrefs.prefs.prefHasUserValue(name) &&
          ServicesTMPrefs.prefs.getPrefType(name) !== T.INT) {
        ServicesTMPrefs.prefs.clearUserPref(name);
      }
    } catch (_) {}
    ServicesTMPrefs.prefs.setIntPref(name, value ? 1 : 0);
  } else {
    // default to BOOL path; clear wrong user type first
    try {
      if (ServicesTMPrefs.prefs.prefHasUserValue(name) &&
          ServicesTMPrefs.prefs.getPrefType(name) !== T.BOOL) {
        ServicesTMPrefs.prefs.clearUserPref(name);
      }
    } catch (_) {}
    ServicesTMPrefs.prefs.setBoolPref(name, !!value);
  }
}

function getBooleanLike(name, fallback = false) {
  const t = getType(name);
  try {
    if (t === T.INT) return ServicesTMPrefs.prefs.getIntPref(name) !== 0;
    if (t === T.BOOL) return ServicesTMPrefs.prefs.getBoolPref(name);
  } catch (_) {}
  return fallback;
}

// Safe preference helpers
function safeGetInt(name, fallback = 0) {
  try {
    if (ServicesTMPrefs.prefs.getPrefType(name) === ServicesTMPrefs.prefs.PREF_INT) {
      return ServicesTMPrefs.prefs.getIntPref(name);
    }
  } catch (_) {}
  return fallback;
}

function safeSetInt(name, value) {
  try {
    // If the pref exists with wrong type, clear first.
    if (ServicesTMPrefs.prefs.prefHasUserValue(name) &&
        ServicesTMPrefs.prefs.getPrefType(name) !== ServicesTMPrefs.prefs.PREF_INT) {
      ServicesTMPrefs.prefs.clearUserPref(name);
    }
  } catch (_) {}
  ServicesTMPrefs.prefs.setIntPref(name, value);
}

// Window enumeration helper
function forEach3Pane(callback) {
  const enumWin = ServicesTMPrefs.wm.getEnumerator("mail:3pane");
  while (enumWin.hasMoreElements()) {
    const win = enumWin.getNext();
    if (win && !win.closed) {
      try { callback(win); } catch (_) {}
    }
  }
}

function enforceUnthreadedIn3PaneWindow(win, enabled, errors, windowTag) {
  const tag = windowTag || "3pane";
  try {
    function rememberTimeout(win, id) {
      try {
        let set = TMPREFS_STATE.timeoutsByWin.get(win);
        if (!set) {
          set = new Set();
          TMPREFS_STATE.timeoutsByWin.set(win, set);
        }
        set.add(id);
      } catch (_) {}
    }

    function clearRememberedTimeout(win, id) {
      try {
        const set = TMPREFS_STATE.timeoutsByWin.get(win);
        if (set) set.delete(id);
      } catch (_) {}
    }

    function getContentWinFor3Pane() {
      try {
        const tabmail = win.document?.getElementById("tabmail");
        return (
          tabmail?.currentAbout3Pane ||
          tabmail?.currentTabInfo?.chromeBrowser?.contentWindow ||
          tabmail?.currentTabInfo?.browser?.contentWindow ||
          null
        );
      } catch (_) {
        return null;
      }
    }

    function applyUnthreadedNow() {
      // Always recompute contentWin: folder selection can switch tabs.
      const contentWin = getContentWinFor3Pane();
      if (!contentWin) return false;

      const gViewWrapper = contentWin.gViewWrapper;
      if (gViewWrapper && typeof gViewWrapper.showThreaded !== "undefined") {
        gViewWrapper.showThreaded = !enabled;
        console.log(`[TMDBG Prefs] (apply:${tag}) Set gViewWrapper.showThreaded = ${!enabled}`);
        return true;
      }

      if (gViewWrapper && typeof gViewWrapper.setViewFlags === "function") {
        const flags = enabled ? 0 : 1;
        gViewWrapper.setViewFlags(flags);
        console.log(`[TMDBG Prefs] (apply:${tag}) Called gViewWrapper.setViewFlags(${flags})`);
        return true;
      }

      return false;
    }

    function describeDisplayedFolder(contentWin) {
      try {
        const folder = contentWin?.gFolderDisplay?.displayedFolder || null;
        if (!folder) return { ok: false, why: "no-displayedFolder" };
        const flags = folder.flags ?? 0;
        const Ci = globalThis.Ci;
        const virtualBit = Ci?.nsMsgFolderFlags?.Virtual;
        const isVirtual = virtualBit ? !!(flags & virtualBit) : undefined;
        return {
          ok: true,
          uri: folder.URI || folder.folderURL || null,
          name: folder.prettyName || folder.name || null,
          flags,
          isVirtual,
        };
      } catch (e) {
        return { ok: false, why: String(e) };
      }
    }

    function applyUnthreadedWithRetries(reason) {
      const attemptOnce = (attempt) => {
        let ok = false;
        try {
          ok = applyUnthreadedNow();
        } catch (eApply) {
          console.warn(`[TMDBG Prefs] (apply:${tag}) attempt=${attempt} threw:`, eApply);
        }

        if (ok) {
          console.log(`[TMDBG Prefs] (apply:${tag}) success after attempt=${attempt} reason=${reason || "unknown"}`);
          return;
        }

        if (attempt >= TMPREFS_CONFIG.unthreaded.maxApplyAttempts) {
          console.warn(
            `[TMDBG Prefs] (apply:${tag}) giving up after ${attempt} attempts reason=${reason || "unknown"}`
          );
          return;
        }

        const tid = win.setTimeout(() => {
          clearRememberedTimeout(win, tid);
          attemptOnce(attempt + 1);
        }, TMPREFS_CONFIG.unthreaded.applyRetryDelayMs);
        rememberTimeout(win, tid);
      };

      attemptOnce(1);
    }

    // Get the about3Pane content window
    const contentWin = getContentWinFor3Pane();

    if (!contentWin) {
      errors?.push?.(`(${tag}) No content window found`);
      if (enabled) applyUnthreadedWithRetries("no-contentWin");
    } else {
      // Attach view-ready signals for Unified/Virtual folders, which can update the DBView
      // after the folder tree selection event.
      try {
        if (!contentWin.__tmPrefsFolderURIHandler) {
          contentWin.__tmPrefsFolderURIHandler = () => {
            try {
              const d = describeDisplayedFolder(contentWin);
              console.log(`[TMDBG Prefs] (event:${tag}) folderURIChanged displayedFolder=${JSON.stringify(d)}`);
            } catch (_) {}
            applyUnthreadedWithRetries("folderURIChanged");
          };
          contentWin.addEventListener("folderURIChanged", contentWin.__tmPrefsFolderURIHandler);
          console.log(`[TMDBG Prefs] (apply:${tag}) folderURIChanged listener attached`);
        }

        if (!contentWin.__tmPrefsThreadPaneLoadedHandler) {
          contentWin.__tmPrefsThreadPaneLoadedHandler = () => {
            try {
              const d = describeDisplayedFolder(contentWin);
              console.log(`[TMDBG Prefs] (event:${tag}) threadpane-loaded displayedFolder=${JSON.stringify(d)}`);
            } catch (_) {}
            applyUnthreadedWithRetries("threadpane-loaded");
          };
          contentWin.addEventListener("threadpane-loaded", contentWin.__tmPrefsThreadPaneLoadedHandler);
          console.log(`[TMDBG Prefs] (apply:${tag}) threadpane-loaded listener attached`);
        }
      } catch (eEvt) {
        errors?.push?.(`(${tag}) contentWin event hook failed: ${String(eEvt)}`);
      }

      // Apply immediately (with retries for early startup races)
      if (enabled) applyUnthreadedWithRetries("initial");
      else applyUnthreadedNow();

      // threadPane viewFlags path (still keep folderTree enforcement below)
      const threadPane =
        contentWin.document?.getElementById("threadPane") || contentWin.document?.getElementById("threadPaneBox");
      if (threadPane?.tree?.view) {
        const view = threadPane.tree.view;
        if (typeof view.viewFlags !== "undefined") {
          const bit = TMPREFS_CONFIG.unthreaded.viewFlagsThreadedBit;
          if (enabled) view.viewFlags = view.viewFlags & ~bit;
          else view.viewFlags = view.viewFlags | bit;
          console.log(`[TMDBG Prefs] (apply:${tag}) Set view.viewFlags = ${view.viewFlags}`);
        }
      }
    }

    // Per-folder enforcement (attach regardless of which API path worked above)
    try {
      const outerDoc = win.document;
      const innerDoc = contentWin?.document || outerDoc;
      const folderTree =
        outerDoc.getElementById("folderTree") ||
        innerDoc.getElementById("folderTree") ||
        outerDoc.querySelector("folder-tree") ||
        innerDoc.querySelector("folder-tree") ||
        null;

      if (!folderTree) {
        errors?.push?.(`(${tag}) folderTree not found for unthreaded enforcement`);
        return;
      }

      // Remove any existing handler (hot reload / reapply / disable)
      if (folderTree.__tmPrefsFolderSelectHandler) {
        try {
          folderTree.removeEventListener("select", folderTree.__tmPrefsFolderSelectHandler);
        } catch (_) {}
        folderTree.__tmPrefsFolderSelectHandler = null;
      }

      if (enabled) {
        const handler = () => {
          try {
            applyUnthreadedWithRetries("folderTree.select");
          } catch (e2) {
            console.warn(`[TMDBG Prefs] (apply:${tag}) folderTree.select reapply failed:`, e2);
          }
        };
        folderTree.__tmPrefsFolderSelectHandler = handler;
        folderTree.addEventListener("select", handler);
        console.log(`[TMDBG Prefs] (apply:${tag}) folderTree.select listener attached (force unthreaded across folders)`);
      }
    } catch (eFolder) {
      errors?.push?.(`(${tag}) folderTree hook failed: ${String(eFolder)}`);
    }
  } catch (e) {
    errors?.push?.(`(${tag}) ${String(e)}`);
  }
}

var tmPrefs = class extends ExtensionCommonTMPrefs.ExtensionAPI {
  onShutdown(isAppShutdown) {
    // Best-effort cleanup: remove window listener and per-window DOM listeners/timeouts.
    // This matters for hot-reload / dev cycles to avoid stacking handlers.
    try {
      if (TMPREFS_STATE.wmListener) {
        try { ServicesTMPrefs.wm.removeListener(TMPREFS_STATE.wmListener); } catch (_) {}
        TMPREFS_STATE.wmListener = null;
      }
    } catch (e) {
      console.warn("[TMDBG Prefs] onShutdown: failed removing wmListener:", e);
    }

    try {
      forEach3Pane((win) => {
        try {
          // Clear any pending retries we scheduled on the outer window.
          const tids = TMPREFS_STATE.timeoutsByWin.get(win);
          if (tids && tids.size) {
            for (const id of tids) {
              try { win.clearTimeout(id); } catch (_) {}
            }
            tids.clear();
          }

          // Remove folder tree select hook if present.
          const outerDoc = win.document;
          const folderTree =
            outerDoc?.getElementById("folderTree") ||
            outerDoc?.querySelector("folder-tree") ||
            null;
          if (folderTree?.__tmPrefsFolderSelectHandler) {
            try { folderTree.removeEventListener("select", folderTree.__tmPrefsFolderSelectHandler); } catch (_) {}
            folderTree.__tmPrefsFolderSelectHandler = null;
          }

          // Remove contentWin event listeners we attach for view-ready signals.
          try {
            const tabmail = outerDoc?.getElementById?.("tabmail") || null;
            const contentWin =
              tabmail?.currentAbout3Pane ||
              tabmail?.currentTabInfo?.chromeBrowser?.contentWindow ||
              tabmail?.currentTabInfo?.browser?.contentWindow ||
              null;
            if (contentWin?.__tmPrefsFolderURIHandler) {
              try { contentWin.removeEventListener("folderURIChanged", contentWin.__tmPrefsFolderURIHandler); } catch (_) {}
              contentWin.__tmPrefsFolderURIHandler = null;
            }
            if (contentWin?.__tmPrefsThreadPaneLoadedHandler) {
              try { contentWin.removeEventListener("threadpane-loaded", contentWin.__tmPrefsThreadPaneLoadedHandler); } catch (_) {}
              contentWin.__tmPrefsThreadPaneLoadedHandler = null;
            }
          } catch (_) {}
        } catch (_) {}
      });
    } catch (e) {
      console.warn("[TMDBG Prefs] onShutdown: window cleanup failed:", e);
    }

    TMPREFS_STATE.unthreadedEnabled = false;
  }

  getAPI(context) {
    console.log("[TMDBG Prefs] tmPrefs.getAPI called, creating API object");
    return {
      tmPrefs: {
        setBool(name, value) {
          try {
            const prefs = ServicesTMPrefs.prefs;
            const t = prefs.getPrefType(name);

            if (t === prefs.PREF_INT) {
              // If there's a user value with the wrong type, clear it first.
              if (prefs.prefHasUserValue(name) && prefs.getPrefType(name) !== prefs.PREF_INT) {
                prefs.clearUserPref(name);
              }
              prefs.setIntPref(name, value ? 1 : 0);
              return;
            }

            // Default to BOOL path; clear wrong user type if any.
            if (prefs.prefHasUserValue(name) && prefs.getPrefType(name) !== prefs.PREF_BOOL) {
              prefs.clearUserPref(name);
            }
            prefs.setBoolPref(name, !!value);
          } catch (e) {
            console.error(`[TMDBG Prefs] setBool failed: ${name} = ${value}`, e);
            // Important: don't rethrow; avoid DOMException in the caller
          }
        },
        setInt(name, value) { 
          safeSetInt(name, value);
        },
        getBool(name) {
          return new Promise((resolve) => {
            try {
              const result = ServicesTMPrefs.prefs.getBoolPref(name);
              resolve(result);
            } catch (e) {
              console.error(`[TMDBG Prefs] getBool failed: ${name}`, e);
              resolve(false);
            }
          });
        },
        getInt(name) {
          return new Promise((resolve) => {
            try {
              const result = ServicesTMPrefs.prefs.getIntPref(name);
              resolve(result);
            } catch (e) {
              console.error(`[TMDBG Prefs] getInt failed: ${name}`, e);
              resolve(0);
            }
          });
        },
        getBoolSafe(name, fallback = false) {
          return new Promise((resolve) => {
            try {
              if (ServicesTMPrefs.prefs.getPrefType(name) === ServicesTMPrefs.prefs.PREF_BOOL) {
                const result = ServicesTMPrefs.prefs.getBoolPref(name);
                resolve(result);
              } else {
                resolve(fallback);
              }
            } catch (e) {
              console.warn(`[TMDBG Prefs] getBoolSafe error for ${name}:`, e);
              resolve(fallback);
            }
          });
        },
        getIntSafe(name, fallback = 0) {
          return new Promise((resolve) => {
            const result = safeGetInt(name, fallback);
            resolve(result);
          });
        },
        getStringSafe(name, fallback = "") {
          return new Promise((resolve) => {
            try {
              if (ServicesTMPrefs.prefs.getPrefType(name) === ServicesTMPrefs.prefs.PREF_STRING) {
                const result = ServicesTMPrefs.prefs.getCharPref(name);
                resolve(result);
              } else {
                resolve(fallback);
              }
            } catch (e) {
              console.warn(`[TMDBG Prefs] getStringSafe error for ${name}:`, e);
              resolve(fallback);
            }
          });
        },
        hasUserValue(name) {
          return new Promise((resolve) => {
            try {
              resolve(ServicesTMPrefs.prefs.prefHasUserValue(name));
            } catch (e) {
              console.warn(`[TMDBG Prefs] hasUserValue error for ${name}:`, e);
              resolve(false);
            }
          });
        },
        clearUserPref(name) { 
          if (ServicesTMPrefs.prefs.prefHasUserValue(name)) 
            ServicesTMPrefs.prefs.clearUserPref(name); 
        },

        // Enable periodic checks across existing accounts (serverN) and set interval
        setPeriodicForAllServers(minutes, enabled) {
          console.log(`[TMDBG Prefs] setPeriodicForAllServers called: minutes=${minutes}, enabled=${enabled}`);
          const list = ServicesTMPrefs.prefs.getChildList("mail.server.server");
          console.log(`[TMDBG Prefs] Found ${list.length} server prefs`);
          
          for (const k of list) {
            // Only touch IMAP servers (best-effort detection)
            if (k.endsWith(".type")) {
              let typeVal;
              try { 
                typeVal = ServicesTMPrefs.prefs.getCharPref(k); 
                console.log(`[TMDBG Prefs] Server type: ${k} = ${typeVal}`);
              } catch (e) { 
                console.log(`[TMDBG Prefs] Failed to get server type for ${k}:`, e);
                continue; 
              }
              if (typeVal !== "imap") {
                console.log(`[TMDBG Prefs] Skipping non-IMAP server: ${k}`);
                continue;
              }
              const base = k.replace(/\.type$/, "");
              console.log(`[TMDBG Prefs] Configuring IMAP server: ${base}`);
              try { 
                ServicesTMPrefs.prefs.setIntPref(base + ".check_new_mail", enabled ? 1 : 0);
                console.log(`[TMDBG Prefs] Set ${base}.check_new_mail = ${enabled ? 1 : 0}`);
              } catch (e) {
                console.warn(`[TMDBG Prefs] Failed to set ${base}.check_new_mail:`, e);
              }
              try { 
                ServicesTMPrefs.prefs.setIntPref(base + ".check_time", Math.max(1, minutes|0));
                console.log(`[TMDBG Prefs] Set ${base}.check_time = ${Math.max(1, minutes|0)}`);
              } catch (e) {
                console.warn(`[TMDBG Prefs] Failed to set ${base}.check_time:`, e);
              }
            }
          }
          // Also set defaults so future accounts inherit it
          try { 
            ServicesTMPrefs.prefs.setIntPref("mail.server.default.check_new_mail", enabled ? 1 : 0);
            console.log(`[TMDBG Prefs] Set mail.server.default.check_new_mail = ${enabled ? 1 : 0}`);
          } catch (e) {
            console.warn(`[TMDBG Prefs] Failed to set mail.server.default.check_new_mail:`, e);
          }
          try { 
            ServicesTMPrefs.prefs.setIntPref("mail.server.default.check_time", Math.max(1, minutes|0));
            console.log(`[TMDBG Prefs] Set mail.server.default.check_time = ${Math.max(1, minutes|0)}`);
          } catch (e) {
            console.warn(`[TMDBG Prefs] Failed to set mail.server.default.check_time:`, e);
          }
          console.log(`[TMDBG Prefs] setPeriodicForAllServers completed`);
        },

        // Simple test method to verify bridge works
        test() {
          return new Promise((resolve) => {
            console.log(`[TMDBG Prefs] test method called - experiment is working!`);
            resolve("tmPrefs experiment is working");
          });
        },

        // Optional: set pane layout live for all open 3-pane windows
        setPaneLayoutLive(layout /* 0 classic, 1 wide, 2 vertical */) {
          let windowsProcessed = 0;
          forEach3Pane(win => {
            windowsProcessed++;
            // Newer TB has MailUtils.setPaneLayout; if not, fall back to pref only.
            if (win.MailUtils?.setPaneLayout) {
              try { 
                win.MailUtils.setPaneLayout(layout);
                return; 
              } catch (e) {
                console.warn(`[TMDBG Prefs] MailUtils.setPaneLayout failed:`, e);
              }
            }
            try { 
              ServicesTMPrefs.prefs.setIntPref("mail.pane_config.dynamic", layout);
            } catch (e) {
              console.warn(`[TMDBG Prefs] Failed to set pane layout:`, e);
            }
          });
        },

        // Dump a preferences branch for diagnostics (key -> {type, value})
        dumpBranch(prefix) {
          return new Promise((resolve) => {
            try {
              const keys = ServicesTMPrefs.prefs.getChildList(prefix || "");
              const out = {};
              for (const k of keys) {
                try {
                  const t = ServicesTMPrefs.prefs.getPrefType(k);
                  if (t === ServicesTMPrefs.prefs.PREF_BOOL) {
                    out[k] = { type: "bool", value: ServicesTMPrefs.prefs.getBoolPref(k) };
                  } else if (t === ServicesTMPrefs.prefs.PREF_INT) {
                    out[k] = { type: "int", value: ServicesTMPrefs.prefs.getIntPref(k) };
                  } else if (t === ServicesTMPrefs.prefs.PREF_STRING) {
                    out[k] = { type: "string", value: ServicesTMPrefs.prefs.getCharPref(k) };
                  } else {
                    out[k] = { type: "unknown" };
                  }
                } catch (e) {
                  out[k] = { type: "error", error: String(e) };
                }
              }
              resolve(out);
            } catch (e) {
              console.warn(`[TMDBG Prefs] dumpBranch failed for prefix='${prefix}':`, e);
              resolve({ error: String(e) });
            }
          });
        },

        // Force unthreaded view for all open 3-pane windows
        // In TB 115+, the view is controlled by gViewWrapper or the threadPane settings.
        // We use the showThreaded setting from the view wrapper.
        setUnthreadedView(enabled) {
          return new Promise((resolve) => {
            console.log(`[TMDBG Prefs] setUnthreadedView called: enabled=${enabled}`);
            TMPREFS_STATE.unthreadedEnabled = !!enabled;
            let windowsProcessed = 0;
            let successCount = 0;
            let errors = [];

            forEach3Pane(win => {
              windowsProcessed++;
              enforceUnthreadedIn3PaneWindow(win, enabled, errors, `win${windowsProcessed}`);
              // Best-effort success accounting: if we processed a window, consider it "attempted".
              // (Enable path uses retries; threadPane/viewWrapper success may occur slightly later.)
              successCount++;
            });

            // If enabling, keep enforcing for new 3-pane windows opened after startup.
            try {
              if (enabled) {
                if (!TMPREFS_STATE.wmListener) {
                  // Avoid importing Ci; use docShell.domWindow pattern which is available in TB parent.
                  TMPREFS_STATE.wmListener = {
                    onOpenWindow(xulWin) {
                      try {
                        const win = xulWin?.docShell?.domWindow || null;
                        if (!win) return;
                        win.addEventListener(
                          "load",
                          () => {
                            try {
                              const wt = win.document?.documentElement?.getAttribute("windowtype") || "";
                              if (wt !== "mail:3pane") return;
                              console.log("[TMDBG Prefs] wm.onOpenWindow: mail:3pane loaded; enforcing unthreaded");
                              const tmpErrors = [];
                              enforceUnthreadedIn3PaneWindow(win, TMPREFS_STATE.unthreadedEnabled, tmpErrors, "wm");
                              if (tmpErrors.length) {
                                console.warn("[TMDBG Prefs] wm.onOpenWindow enforcement errors:", tmpErrors);
                              }
                            } catch (eLoad) {
                              console.warn("[TMDBG Prefs] wm.onOpenWindow load handler failed:", eLoad);
                            }
                          },
                          { once: true }
                        );
                      } catch (eOpen) {
                        console.warn("[TMDBG Prefs] wm.onOpenWindow failed:", eOpen);
                      }
                    },
                    onCloseWindow() {},
                  };
                  try { ServicesTMPrefs.wm.addListener(TMPREFS_STATE.wmListener); } catch (eAdd) {
                    console.warn("[TMDBG Prefs] Failed to add wmListener:", eAdd);
                    TMPREFS_STATE.wmListener = null;
                  }
                }
              } else {
                if (TMPREFS_STATE.wmListener) {
                  try { ServicesTMPrefs.wm.removeListener(TMPREFS_STATE.wmListener); } catch (_) {}
                  TMPREFS_STATE.wmListener = null;
                }
              }
            } catch (eWm) {
              console.warn("[TMDBG Prefs] wm listener setup failed:", eWm);
            }

            console.log(`[TMDBG Prefs] setUnthreadedView complete: ${successCount}/${windowsProcessed} windows, errors: ${errors.length}`);
            resolve({
              success: windowsProcessed > 0,
              windowsProcessed,
              successCount,
              errors: errors.length > 0 ? errors : undefined,
            });
          });
        },
      }
    };
  }
};

