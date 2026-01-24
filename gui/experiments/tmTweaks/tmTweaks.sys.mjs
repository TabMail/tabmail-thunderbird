const { ExtensionSupport: ExtensionSupportTMTweaks } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonTMTweaks } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

var ServicesTMTweaks = globalThis.Services;

const TMTWEAKS_CONFIG = {
  logPrefix: "[TMDBG Tweaks]",
  spacesToolbar: {
    statePref: "extensions.tabmail.tweaks.spacesToolbarHidden",
    diagnostics: {
      maxMatchingIdsToLog: 20,
    },
  },
  systemFonts: {
    statePref: "extensions.tabmail.tweaks.systemFontsEnabled",
    // We keep this intentionally scoped to the main lang groups to avoid
    // mass-editing preferences we haven't audited yet.
    langGroups: ["x-western", "x-unicode"],
    values: {
      // Reading fonts for messages (similar to Helvetica Neue on macOS).
      // These are optimized for readability in email content, not UI.
      // We intentionally keep this deterministic (no font-list fallbacks on our side).
      readingFontByOS: {
        Darwin: "Helvetica Neue",
        WINNT: "Segoe UI",
        Linux: "Noto Sans",
        default: "sans-serif",
      },
      // For monospace, we prefer the platform's "terminal-like" font rather than a generic default.
      // We intentionally keep this deterministic (no font-list fallbacks on our side).
      fixedByOS: {
        Darwin: "Menlo",
        WINNT: "Consolas",
        Linux: "DejaVu Sans Mono",
        default: "monospace",
      },
      defaultFontKind: "sans-serif",
    },
  },
  behavior: {
    // If no 3-pane windows are open, persisting the pref is still considered success.
    okIfNoWindowsOpen: true,
  },
};

const WINDOW_LISTENER_FLAG_KEY = "__tmTweaksWindowListenerRegistered";

function tmtLog(...args) {
  console.log(TMTWEAKS_CONFIG.logPrefix, ...args);
}

function tmtWarn(...args) {
  console.warn(TMTWEAKS_CONFIG.logPrefix, ...args);
}

function tmtErr(...args) {
  console.error(TMTWEAKS_CONFIG.logPrefix, ...args);
}

function getPlatformOSKey() {
  try {
    // Values typically include: "Darwin", "WINNT", "Linux"
    return String(ServicesTMTweaks?.appinfo?.OS || "");
  } catch (_) {
    return "";
  }
}

function getPreferredReadingFontName() {
  const os = getPlatformOSKey();
  const map = TMTWEAKS_CONFIG.systemFonts.values.readingFontByOS || {};
  if (os && map[os]) return map[os];
  return map.default || "sans-serif";
}

function getPreferredMonospaceFontName() {
  const os = getPlatformOSKey();
  const map = TMTWEAKS_CONFIG.systemFonts.values.fixedByOS || {};
  if (os && map[os]) return map[os];
  return map.default || "monospace";
}

function forEach3Pane(callback) {
  try {
    const enumWin = ServicesTMTweaks?.wm?.getEnumerator?.("mail:3pane");
    if (!enumWin) return;
    while (enumWin.hasMoreElements()) {
      const win = enumWin.getNext();
      try {
        if (!win || win.closed) continue;
        callback(win);
      } catch (e) {
        tmtWarn("forEach3Pane callback error:", e);
      }
    }
  } catch (e) {
    tmtWarn("forEach3Pane failed:", e);
  }
}

function readSpacesToolbarHiddenPref() {
  try {
    return ServicesTMTweaks.prefs.getBoolPref(TMTWEAKS_CONFIG.spacesToolbar.statePref, false);
  } catch (e) {
    tmtWarn("readSpacesToolbarHiddenPref failed:", e);
    return false;
  }
}

function writeSpacesToolbarHiddenPref(hidden) {
  try {
    ServicesTMTweaks.prefs.setBoolPref(
      TMTWEAKS_CONFIG.spacesToolbar.statePref,
      hidden === true
    );
    return true;
  } catch (e) {
    tmtErr("writeSpacesToolbarHiddenPref failed:", e);
    return false;
  }
}

function applySpacesToolbarHiddenToWindow(win, hidden, reason) {
  const tag = reason || "unknown";
  try {
    // In TB 145, we must use the built-in gSpacesToolbar.toggleToolbar()
    // to keep Thunderbird's internal state consistent (including the "reveal" button).
    const gst = win?.gSpacesToolbar || null;
    const toggleFn = gst?.toggleToolbar;

    if (typeof toggleFn !== "function") {
      tmtWarn(
        `(${tag}) gSpacesToolbar.toggleToolbar is not available (type=${typeof toggleFn}). Cannot apply.`,
      );

      // Diagnostics only (no fallback behavior).
      try {
        const doc = win?.document || null;
        if (doc) {
          const ids = [];
          const nodes = doc.querySelectorAll("[id]");
          for (const node of nodes) {
            const id = node?.id || "";
            if (!id) continue;
            if (!/space/i.test(id)) continue;
            ids.push(id);
            if (ids.length >= TMTWEAKS_CONFIG.spacesToolbar.diagnostics.maxMatchingIdsToLog) break;
          }
          tmtLog(`(${tag}) ids containing "space" (first ${ids.length}):`, ids);
        }
      } catch (e) {
        tmtWarn(`(${tag}) diagnostics id scan failed:`, e);
      }

      return { ok: false, reason: "gSpacesToolbar_unavailable" };
    }

    // Empirically: the reveal button uses onclick="gSpacesToolbar.toggleToolbar(false);"
    // (data-l10n-id="spaces-toolbar-button-show"). So:
    // - hidden=true  => toggleToolbar(true)
    // - hidden=false => toggleToolbar(false)
    tmtLog(`(${tag}) calling gSpacesToolbar.toggleToolbar(${hidden === true})`);
    toggleFn.call(gst, hidden === true);

    // Best-effort visibility snapshot for logs.
    let revealBtnHidden = null;
    try {
      const btn = win?.document?.getElementById?.("spacesToolbarReveal") || null;
      revealBtnHidden = btn ? (btn.hidden === true || btn.collapsed === true) : null;
    } catch (_) {}

    tmtLog(
      `(${tag}) applied spaces toolbar hidden=${hidden === true} (revealBtnHidden=${revealBtnHidden}) window=${win.location?.href || "unknown"}`
    );
    return { ok: true, reason: "toggleToolbar_called" };
  } catch (e) {
    tmtErr(`(${tag}) applySpacesToolbarHiddenToWindow threw:`, e);
    return { ok: false, reason: "exception" };
  }
}

function readSystemFontsEnabledPref() {
  try {
    return ServicesTMTweaks.prefs.getBoolPref(TMTWEAKS_CONFIG.systemFonts.statePref, false);
  } catch (e) {
    tmtWarn("readSystemFontsEnabledPref failed:", e);
    return false;
  }
}

function writeSystemFontsEnabledPref(enabled) {
  try {
    ServicesTMTweaks.prefs.setBoolPref(
      TMTWEAKS_CONFIG.systemFonts.statePref,
      enabled === true,
    );
    return true;
  } catch (e) {
    tmtErr("writeSystemFontsEnabledPref failed:", e);
    return false;
  }
}

function setStringPrefSafe(name, value) {
  try {
    // Clear mismatched type first (rare, but keeps debugging sane).
    if (
      ServicesTMTweaks.prefs.prefHasUserValue(name) &&
      ServicesTMTweaks.prefs.getPrefType(name) !== ServicesTMTweaks.prefs.PREF_STRING
    ) {
      ServicesTMTweaks.prefs.clearUserPref(name);
    }
  } catch (_) {}
  try {
    ServicesTMTweaks.prefs.setStringPref(name, String(value));
    return true;
  } catch (e) {
    tmtWarn("setStringPrefSafe failed:", { name, value, e });
    return false;
  }
}

function clearUserPrefSafe(name) {
  try {
    if (ServicesTMTweaks.prefs.prefHasUserValue(name)) {
      ServicesTMTweaks.prefs.clearUserPref(name);
      return true;
    }
    return true;
  } catch (e) {
    tmtWarn("clearUserPrefSafe failed:", { name, e });
    return false;
  }
}

function getSystemFontsPrefNamesForLangGroup(langGroup) {
  // Keep the mapping explicit and centralized.
  return {
    defaultFontKind: `font.default.${langGroup}`,
    variable: {
      name: `font.name.sans-serif.${langGroup}`,
      list: `font.name-list.sans-serif.${langGroup}`,
    },
    serif: {
      name: `font.name.serif.${langGroup}`,
      list: `font.name-list.serif.${langGroup}`,
    },
    fixed: {
      name: `font.name.monospace.${langGroup}`,
      list: `font.name-list.monospace.${langGroup}`,
    },
  };
}

function applySystemFontsEnabled(enabled, reason) {
  const tag = reason || "unknown";
  const updated = [];
  const failed = [];

  try {
    for (const langGroup of TMTWEAKS_CONFIG.systemFonts.langGroups) {
      const names = getSystemFontsPrefNamesForLangGroup(langGroup);

      if (enabled === true) {
        const preferredReading = getPreferredReadingFontName();
        const preferredMono = getPreferredMonospaceFontName();
        tmtLog(`(${tag}) using preferred fonts`, {
          os: getPlatformOSKey(),
          readingFont: preferredReading,
          monospaceFont: preferredMono,
        });

        const okDefault = setStringPrefSafe(
          names.defaultFontKind,
          TMTWEAKS_CONFIG.systemFonts.values.defaultFontKind,
        );
        (okDefault ? updated : failed).push(names.defaultFontKind);

        const pairs = [
          [names.variable.name, preferredReading],
          [names.variable.list, preferredReading],
          [names.serif.name, preferredReading],
          [names.serif.list, preferredReading],
          [names.fixed.name, preferredMono],
          [names.fixed.list, preferredMono],
        ];

        for (const [pref, value] of pairs) {
          const ok = setStringPrefSafe(pref, value);
          (ok ? updated : failed).push(pref);
        }
      } else {
        // Disable = revert to Thunderbird defaults by clearing user prefs.
        const prefsToClear = [
          names.defaultFontKind,
          names.variable.name,
          names.variable.list,
          names.serif.name,
          names.serif.list,
          names.fixed.name,
          names.fixed.list,
        ];

        for (const pref of prefsToClear) {
          const ok = clearUserPrefSafe(pref);
          (ok ? updated : failed).push(pref);
        }
      }
    }

    tmtLog(`(${tag}) applySystemFontsEnabled enabled=${enabled === true}`, {
      updatedCount: updated.length,
      failedCount: failed.length,
    });
  } catch (e) {
    tmtErr(`(${tag}) applySystemFontsEnabled threw:`, e);
    return { ok: false, reason: "exception", updated, failed };
  }

  return { ok: failed.length === 0, updated, failed };
}

function ensureWindowListenerRegistered(context) {
  const listenerId = context.extension.id + "-tmTweaks-windows";

  try {
    if (ServicesTMTweaks?.[WINDOW_LISTENER_FLAG_KEY] === true) return;
  } catch (_) {}

  try {
    ExtensionSupportTMTweaks.registerWindowListener(listenerId, {
      chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
      onLoadWindow(win) {
        try {
          const hidden = readSpacesToolbarHiddenPref();
          applySpacesToolbarHiddenToWindow(win, hidden, "onLoadWindow");
        } catch (e) {
          tmtErr("onLoadWindow failed:", e);
        }
      },
    });

    if (ServicesTMTweaks) ServicesTMTweaks[WINDOW_LISTENER_FLAG_KEY] = true;
    tmtLog("registered window listener:", listenerId);
  } catch (e) {
    tmtErr("registerWindowListener failed:", e);
  }
}

function unregisterWindowListener(context) {
  const listenerId = context.extension.id + "-tmTweaks-windows";
  try {
    ExtensionSupportTMTweaks.unregisterWindowListener(listenerId);
  } catch (_) {}
  try {
    if (ServicesTMTweaks) ServicesTMTweaks[WINDOW_LISTENER_FLAG_KEY] = false;
  } catch (_) {}
}

try {
  console.log(
    "[TabMail tmTweaks] experiment parent script loaded. Services present?",
    typeof ServicesTMTweaks !== "undefined"
  );
} catch (_) {}

var tmTweaks = class extends ExtensionCommonTMTweaks.ExtensionAPI {
  onShutdown(isAppShutdown) {
    console.log("[TabMail tmTweaks] onShutdown() called by Thunderbird, isAppShutdown:", isAppShutdown);
    try {
      if (this._cleanup) {
        this._cleanup();
        console.log("[TabMail tmTweaks] ✓ Cleanup completed via onShutdown");
      }
    } catch (e) {
      console.error("[TabMail tmTweaks] onShutdown cleanup failed:", e);
    }
  }

  getAPI(context) {
    const cleanup = () => {
      tmtLog("cleanup() called");
      try {
        unregisterWindowListener(context);
        tmtLog("unregistered window listener");
      } catch (e) {
        tmtWarn("cleanup unregisterWindowListener failed:", e);
      }
    };

    this._cleanup = cleanup;

    return {
      tmTweaks: {
        async setSpacesToolbarHidden(hidden) {
          tmtLog("═══ setSpacesToolbarHidden() START ═══", { hidden });

          try {
            ensureWindowListenerRegistered(context);
          } catch (e) {
            tmtWarn("ensureWindowListenerRegistered failed:", e);
          }

          const persisted = writeSpacesToolbarHiddenPref(hidden === true);
          const results = [];
          let windowsTotal = 0;
          let windowsUpdated = 0;

          forEach3Pane((win) => {
            windowsTotal += 1;
            const r = applySpacesToolbarHiddenToWindow(win, hidden === true, "setSpacesToolbarHidden");
            results.push(r);
            if (r && r.ok) windowsUpdated += 1;
          });

          const ok =
            persisted &&
            (windowsUpdated > 0 ||
              (windowsTotal === 0 && TMTWEAKS_CONFIG.behavior.okIfNoWindowsOpen === true));

          const out = {
            ok,
            hidden: hidden === true,
            persisted,
            windowsTotal,
            windowsUpdated,
            // Include per-window results for diagnostics (small objects only).
            results,
          };

          tmtLog("═══ setSpacesToolbarHidden() DONE ═══", out);
          return out;
        },

        async setSystemFontsEnabled(enabled) {
          tmtLog("═══ setSystemFontsEnabled() START ═══", { enabled });

          const persisted = writeSystemFontsEnabledPref(enabled === true);
          const applyResult = applySystemFontsEnabled(enabled === true, "setSystemFontsEnabled");

          const out = {
            ok: persisted && applyResult && applyResult.ok === true,
            enabled: enabled === true,
            persisted,
            updated: applyResult?.updated || [],
            failed: applyResult?.failed || [],
          };

          tmtLog("═══ setSystemFontsEnabled() DONE ═══", out);
          return out;
        },
      },
    };
  }
};

