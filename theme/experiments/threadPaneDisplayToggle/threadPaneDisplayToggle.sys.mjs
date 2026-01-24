const { ExtensionSupport: ExtensionSupportTPDT } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonTPDT } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

var ServicesTPDT = globalThis.Services;

const TPDT_CONFIG = {
  logPrefix: "[TMDBG DisplayToggle]",
  // about:3pane DOM
  displayButtonId: "threadPaneDisplayButton",
  sortDirectionButtonId: "tmThreadPaneSortDirectionButton",
  // Pref: 0 = card (relaxed), 1 = table (compact)
  listViewPref: "mail.threadpane.listview",
  listViewCard: 0,
  listViewTable: 1,
  // Pref: Card View row count (TB 145)
  // - When listView is "card/relaxed", force this to our configured value.
  cardViewRowCountPref: "mail.threadpane.cardsview.rowcount",
  cardViewRowCountThree: 3,
  // Sorting mode link:
  // - compact/table => sort by tags (enable tagSort)
  // - relaxed/card  => sort by date (disable tagSort)
  tagSortEnabledPref: "extensions.tabmail.tagSortEnabled",
  tagSortEnabled: 1,
  tagSortDisabled: 0,
  // Pref: 2 = new message on top, 1 = new message bottom
  sortOrderPref: "mailnews.default_sort_order",
  sortOrderDescending: 2,
  sortOrderAscending: 1,
  // Notification topic to trigger TagSort after button click
  tagSortOrderNotifyTopic: "tabmail-sort-order-changed",
  // Icon injection (SVG should use context-fill)
  icons: {
    card: "icons/view-relaxed.svg",
    table: "icons/view-compact.svg",
    sortNewestTop: "icons/sort-newest-top.svg",
    sortNewestBottom: "icons/sort-newest-bottom.svg",
  },
  // Styling knobs (keep in config to avoid hardcoded numerics in logic)
  iconSizePx: 16,
};

try {
  console.log(
    "[TabMail threadPaneDisplayToggle] experiment parent script loaded. Services present?",
    typeof ServicesTPDT !== "undefined"
  );
} catch (_) {}

function tpdtLog(...args) {
  console.log(TPDT_CONFIG.logPrefix, ...args);
}

function tpdtWarn(...args) {
  console.warn(TPDT_CONFIG.logPrefix, ...args);
}

function tpdtErr(...args) {
  console.error(TPDT_CONFIG.logPrefix, ...args);
}

function forEach3Pane(callback) {
  try {
    const enumWin = ServicesTPDT?.wm?.getEnumerator?.("mail:3pane");
    if (!enumWin) return;
    while (enumWin.hasMoreElements()) {
      const win = enumWin.getNext();
      try {
        callback(win);
      } catch (e) {
        tpdtWarn("forEach3Pane callback error:", e);
      }
    }
  } catch (e) {
    tpdtWarn("forEach3Pane failed:", e);
  }
}

function getAbout3PaneContentWindow(win) {
  try {
    const tabmail = win?.document?.getElementById?.("tabmail") || null;
    const contentWin =
      tabmail?.currentAbout3Pane ||
      tabmail?.currentTabInfo?.chromeBrowser?.contentWindow ||
      tabmail?.currentTabInfo?.browser?.contentWindow ||
      null;
    return contentWin || null;
  } catch (e) {
    tpdtWarn("getAbout3PaneContentWindow failed:", e);
    return null;
  }
}

function ensureContentWinHooks(win, context, reason) {
  try {
    if (!win) return;
    const tabmail = win?.document?.getElementById?.("tabmail") || null;
    const contentWin = getAbout3PaneContentWindow(win);
    if (!contentWin || typeof contentWin.addEventListener !== "function") {
      tpdtLog(`(${reason}) ensureContentWinHooks: no contentWin yet`);
      return;
    }

    // Track content windows for cleanup (hot reload safety).
    if (!win.__tmDisplayToggleContentWindows) {
      win.__tmDisplayToggleContentWindows = new Set();
    }
    win.__tmDisplayToggleContentWindows.add(contentWin);

    // Attach event listeners that fire when the message list/header is (re)built.
    // This avoids reliance on which window is focused or which tab was active at startup.
    if (!contentWin.__tmDisplayToggleFolderURIHandler) {
      contentWin.__tmDisplayToggleFolderURIHandler = () => {
        attachOverrideToContentWindow(win, context, "folderURIChanged");
      };
      try {
        contentWin.addEventListener(
          "folderURIChanged",
          contentWin.__tmDisplayToggleFolderURIHandler
        );
        tpdtLog(`(${reason}) contentWin listener attached: folderURIChanged`);
      } catch (e) {
        tpdtWarn(`(${reason}) failed attaching folderURIChanged:`, e);
      }
    }

    if (!contentWin.__tmDisplayToggleThreadPaneLoadedHandler) {
      contentWin.__tmDisplayToggleThreadPaneLoadedHandler = () => {
        attachOverrideToContentWindow(win, context, "threadpane-loaded");
      };
      try {
        contentWin.addEventListener(
          "threadpane-loaded",
          contentWin.__tmDisplayToggleThreadPaneLoadedHandler
        );
        tpdtLog(`(${reason}) contentWin listener attached: threadpane-loaded`);
      } catch (e) {
        tpdtWarn(`(${reason}) failed attaching threadpane-loaded:`, e);
      }
    }

    // Attempt injection immediately as well.
    attachOverrideToContentWindow(win, context, `${reason}-ensureContentWinHooks`);
  } catch (e) {
    tpdtWarn(`ensureContentWinHooks failed (${reason}):`, e);
  }
}

function readListViewPref() {
  try {
    const v = ServicesTPDT?.prefs?.getIntPref?.(
      TPDT_CONFIG.listViewPref,
      TPDT_CONFIG.listViewCard
    );
    return typeof v === "number" ? v : TPDT_CONFIG.listViewCard;
  } catch (e) {
    tpdtWarn("readListViewPref failed:", e);
    return TPDT_CONFIG.listViewCard;
  }
}

function readCardViewRowCountPref() {
  try {
    const v = ServicesTPDT?.prefs?.getIntPref?.(
      TPDT_CONFIG.cardViewRowCountPref,
      TPDT_CONFIG.cardViewRowCountThree
    );
    return typeof v === "number" ? v : TPDT_CONFIG.cardViewRowCountThree;
  } catch (e) {
    tpdtWarn("readCardViewRowCountPref failed:", e);
    return TPDT_CONFIG.cardViewRowCountThree;
  }
}

function readSortOrderPref() {
  try {
    const v = ServicesTPDT?.prefs?.getIntPref?.(
      TPDT_CONFIG.sortOrderPref,
      TPDT_CONFIG.sortOrderDescending
    );
    // Ensure we return valid values (2 or 1)
    if (typeof v === "number" && (v === 2 || v === 1)) {
      return v;
    }
    return TPDT_CONFIG.sortOrderDescending;
  } catch (e) {
    tpdtWarn("readSortOrderPref failed:", e);
    return TPDT_CONFIG.sortOrderDescending;
  }
}

function readTagSortEnabledPref() {
  try {
    const v = ServicesTPDT?.prefs?.getIntPref?.(
      TPDT_CONFIG.tagSortEnabledPref,
      TPDT_CONFIG.tagSortEnabled
    );
    return typeof v === "number" ? v : TPDT_CONFIG.tagSortEnabled;
  } catch (e) {
    tpdtWarn("readTagSortEnabledPref failed:", e);
    return TPDT_CONFIG.tagSortEnabled;
  }
}

function setTagSortEnabledPref(newValue) {
  try {
    ServicesTPDT?.prefs?.setIntPref?.(TPDT_CONFIG.tagSortEnabledPref, newValue);
    return true;
  } catch (e) {
    tpdtErr(
      `setTagSortEnabledPref failed (${TPDT_CONFIG.tagSortEnabledPref}=${newValue}):`,
      e
    );
    return false;
  }
}

function setSortOrderPref(newValue) {
  try {
    ServicesTPDT?.prefs?.setIntPref?.(TPDT_CONFIG.sortOrderPref, newValue);
    return true;
  } catch (e) {
    tpdtErr(
      `setSortOrderPref failed (${TPDT_CONFIG.sortOrderPref}=${newValue}):`,
      e
    );
    return false;
  }
}

function setListViewPref(newValue) {
  try {
    ServicesTPDT?.prefs?.setIntPref?.(TPDT_CONFIG.listViewPref, newValue);
    return true;
  } catch (e) {
    tpdtErr(`setListViewPref failed (${TPDT_CONFIG.listViewPref}=${newValue}):`, e);
    return false;
  }
}

function setCardViewRowCountPref(newValue) {
  try {
    ServicesTPDT?.prefs?.setIntPref?.(TPDT_CONFIG.cardViewRowCountPref, newValue);
    return true;
  } catch (e) {
    tpdtErr(
      `setCardViewRowCountPref failed (${TPDT_CONFIG.cardViewRowCountPref}=${newValue}):`,
      e
    );
    return false;
  }
}

function applyButtonIcon(button, context, listViewValue) {
  try {
    const iconPath =
      listViewValue === TPDT_CONFIG.listViewTable
        ? TPDT_CONFIG.icons.table
        : TPDT_CONFIG.icons.card;

    const iconUrl = context.extension.getURL(iconPath);

    // Use mask-image approach for reliable theming across debug/XPI installs.
    // The SVG acts as a mask; background-color provides the actual icon color.
    button.style.setProperty("background-image", "none");
    button.style.setProperty("background-color", "currentColor");
    button.style.setProperty("mask-image", `url("${iconUrl}")`);
    button.style.setProperty("mask-repeat", "no-repeat");
    button.style.setProperty("mask-position", "center");
    button.style.setProperty(
      "mask-size",
      `${TPDT_CONFIG.iconSizePx}px ${TPDT_CONFIG.iconSizePx}px`
    );

    // Keep original l10n id; just adjust tooltip to reflect our behavior.
    const title =
      listViewValue === TPDT_CONFIG.listViewTable
        ? "Toggle message list to relaxed (Cards) view"
        : "Toggle message list to compact (Table) view";
    button.setAttribute("title", title);
  } catch (e) {
    tpdtWarn("applyButtonIcon failed:", e);
  }
}

function applySortDirectionButtonIcon(button, context, sortOrderValue) {
  try {
    // Per user request: up arrow = newest on top, down arrow = newest on bottom.
    const isNewestTop = sortOrderValue === TPDT_CONFIG.sortOrderDescending;
    const iconPath = isNewestTop
      ? TPDT_CONFIG.icons.sortNewestTop
      : TPDT_CONFIG.icons.sortNewestBottom;

    const iconUrl = context.extension.getURL(iconPath);

    // Use mask-image approach for reliable theming across debug/XPI installs.
    // The SVG acts as a mask; background-color provides the actual icon color.
    button.style.setProperty("background-image", "none");
    button.style.setProperty("background-color", "currentColor");
    button.style.setProperty("mask-image", `url("${iconUrl}")`);
    button.style.setProperty("mask-repeat", "no-repeat");
    button.style.setProperty("mask-position", "center");
    button.style.setProperty(
      "mask-size",
      `${TPDT_CONFIG.iconSizePx}px ${TPDT_CONFIG.iconSizePx}px`
    );

    const title = isNewestTop
      ? "Sort direction: newest on top (click to toggle)"
      : "Sort direction: newest on bottom (click to toggle)";
    button.setAttribute("title", title);
  } catch (e) {
    tpdtWarn("applySortDirectionButtonIcon failed:", e);
  }
}

function ensureSortDirectionButton(doc, displayBtn, context) {
  try {
    let btn = doc.getElementById(TPDT_CONFIG.sortDirectionButtonId);
    if (!btn) {
      btn = doc.createElement("button");
      btn.id = TPDT_CONFIG.sortDirectionButtonId;
      btn.className = "button button-flat icon-button icon-only";
      btn.setAttribute("type", "button");
      btn.setAttribute("aria-label", "Sort direction");

      // Insert to the right of the display button (as requested).
      try {
        displayBtn.insertAdjacentElement("afterend", btn);
      } catch (e) {
        // As a fallback, append to same parent (keeps it near the display button).
        try {
          displayBtn.parentNode?.appendChild?.(btn);
        } catch (_) {}
        tpdtWarn("Failed insertAdjacentElement for sort direction button:", e);
      }

      tpdtLog("Sort direction button created and inserted");
    }

    if (!btn.__tmSortDirectionClickHandler) {
      const handler = (ev) => {
        try {
          ev?.preventDefault?.();
          ev?.stopPropagation?.();
          ev?.stopImmediatePropagation?.();

          const current = readSortOrderPref();
          const next =
            current === TPDT_CONFIG.sortOrderDescending
              ? TPDT_CONFIG.sortOrderAscending
              : TPDT_CONFIG.sortOrderDescending;

          tpdtLog(
            `sort direction click: ${TPDT_CONFIG.sortOrderPref} ${current} -> ${next}`
          );

          const ok = setSortOrderPref(next);
          if (!ok) return;

          // Notify TagSort to re-apply sorting with the new order
          try {
            ServicesTPDT.obs.notifyObservers(null, TPDT_CONFIG.tagSortOrderNotifyTopic, String(next));
          } catch (e) {
            tpdtWarn("Failed to notify TagSort of sort order change:", e);
          }

          applySortDirectionButtonIcon(btn, context, next);
        } catch (e) {
          tpdtErr("sort direction click handler failed:", e);
        }
      };

      btn.addEventListener("click", handler, true);
      btn.__tmSortDirectionClickHandler = handler;
    }

    const current = readSortOrderPref();
    applySortDirectionButtonIcon(btn, context, current);
    return btn;
  } catch (e) {
    tpdtWarn("ensureSortDirectionButton failed:", e);
    return null;
  }
}

function enforceSortModeForListView(listViewValue, reason) {
  try {
    const want =
      listViewValue === TPDT_CONFIG.listViewTable
        ? TPDT_CONFIG.tagSortEnabled
        : TPDT_CONFIG.tagSortDisabled;
    const cur = readTagSortEnabledPref();
    if (cur === want) {
      tpdtLog(
        `(${reason}) sort-mode already consistent: listView=${listViewValue} -> ${TPDT_CONFIG.tagSortEnabledPref}=${cur}`
      );
      return;
    }
    tpdtLog(
      `(${reason}) enforcing sort-mode: listView=${listViewValue} -> ${TPDT_CONFIG.tagSortEnabledPref} ${cur} -> ${want}`
    );
    setTagSortEnabledPref(want);
  } catch (e) {
    tpdtWarn("enforceSortModeForListView failed:", e);
  }
}

function enforceCardViewRowCountForListView(listViewValue, reason) {
  try {
    if (listViewValue !== TPDT_CONFIG.listViewCard) return;
    const want = TPDT_CONFIG.cardViewRowCountThree;
    const cur = readCardViewRowCountPref();
    if (cur === want) {
      tpdtLog(
        `(${reason}) card rowcount already consistent: listView=${listViewValue} -> ${TPDT_CONFIG.cardViewRowCountPref}=${cur}`
      );
      return;
    }
    tpdtLog(
      `(${reason}) enforcing card rowcount: listView=${listViewValue} -> ${TPDT_CONFIG.cardViewRowCountPref} ${cur} -> ${want}`
    );
    setCardViewRowCountPref(want);
  } catch (e) {
    tpdtWarn("enforceCardViewRowCountForListView failed:", e);
  }
}

function attachOverrideToContentWindow(win, context, reason) {
  try {
    const contentWin = getAbout3PaneContentWindow(win);
    if (!contentWin?.document) {
      tpdtLog(`(${reason}) no about:3pane content window yet`);
      return;
    }

    const doc = contentWin.document;
    const btn = doc.getElementById(TPDT_CONFIG.displayButtonId);
    if (!btn) {
      tpdtLog(`(${reason}) button not found id=${TPDT_CONFIG.displayButtonId}`);
      return;
    }

    // Add the sort direction indicator button next to the display button.
    ensureSortDirectionButton(doc, btn, context);

    if (btn.__tmDisplayToggleClickHandler) {
      // Already attached
      // Still enforce linked sort mode in case something changed while we were attached.
      try {
        const lv = readListViewPref();
        enforceSortModeForListView(lv, `${reason}-already-attached`);
      } catch (_) {}
      return;
    }

    // Snapshot original info for best-effort restore
    btn.__tmDisplayToggleOrig = {
      title: btn.getAttribute("title"),
      style: btn.getAttribute("style"),
    };

    const handler = (ev) => {
      try {
        // Override the default TB action for this button.
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        ev?.stopImmediatePropagation?.();

        const current = readListViewPref();
        const next =
          current === TPDT_CONFIG.listViewCard
            ? TPDT_CONFIG.listViewTable
            : TPDT_CONFIG.listViewCard;

        tpdtLog(
          `click override: ${TPDT_CONFIG.listViewPref} ${current} -> ${next}`
        );

        const ok = setListViewPref(next);
        if (!ok) return;

        // Link sorting mode to view mode:
        // compact/table => tags; relaxed/card => date.
        enforceSortModeForListView(next, "view-toggle-click");
        // NOTE: We intentionally do NOT call enforceCardViewRowCountForListView here.
        // Row count (and snippet enablement) is now a separate UI tweak, not tied to the toggle.

        applyButtonIcon(btn, context, next);
      } catch (e) {
        tpdtErr("click handler failed:", e);
      }
    };

    // Capture phase so we intercept before TB's own handlers.
    btn.addEventListener("click", handler, true);
    btn.__tmDisplayToggleClickHandler = handler;

    // Apply initial icon based on current pref.
    const current = readListViewPref();
    applyButtonIcon(btn, context, current);
    enforceSortModeForListView(current, `${reason}-initial`);
    tpdtLog(`(${reason}) attached override to ${TPDT_CONFIG.displayButtonId} (listView=${current})`);
  } catch (e) {
    tpdtErr(`attachOverrideToContentWindow failed (${reason}):`, e);
  }
}

function detachOverrideFromContentWindow(win, reason) {
  try {
    const contentWin = getAbout3PaneContentWindow(win);
    const doc = contentWin?.document || null;
    const btn = doc?.getElementById?.(TPDT_CONFIG.displayButtonId) || null;
    if (!btn) return;

    // Clean up sort direction button if present
    try {
      const sbtn = doc.getElementById(TPDT_CONFIG.sortDirectionButtonId);
      if (sbtn) {
        if (sbtn.__tmSortDirectionClickHandler) {
          try {
            sbtn.removeEventListener("click", sbtn.__tmSortDirectionClickHandler, true);
          } catch (_) {}
          sbtn.__tmSortDirectionClickHandler = null;
        }
        try {
          sbtn.remove();
        } catch (_) {}
      }
    } catch (e) {
      tpdtWarn(`(${reason}) sort direction button cleanup failed:`, e);
    }

    const handler = btn.__tmDisplayToggleClickHandler;
    if (handler) {
      try {
        btn.removeEventListener("click", handler, true);
      } catch (e) {
        tpdtWarn(`(${reason}) removeEventListener failed:`, e);
      }
      btn.__tmDisplayToggleClickHandler = null;
    }

    const orig = btn.__tmDisplayToggleOrig;
    if (orig) {
      try {
        if (typeof orig.title === "string") btn.setAttribute("title", orig.title);
        else btn.removeAttribute("title");
      } catch (_) {}
      try {
        if (typeof orig.style === "string") btn.setAttribute("style", orig.style);
        else btn.removeAttribute("style");
      } catch (_) {}
      btn.__tmDisplayToggleOrig = null;
    }
  } catch (e) {
    tpdtWarn(`detachOverrideFromContentWindow failed (${reason}):`, e);
  }
}

var threadPaneDisplayToggle = class extends ExtensionCommonTPDT.ExtensionAPI {
  onShutdown(isAppShutdown) {
    tpdtLog("onShutdown called, isAppShutdown=", isAppShutdown);
    try {
      if (this._shutdown) this._shutdown("onShutdown");
    } catch (e) {
      tpdtWarn("onShutdown cleanup failed:", e);
    }
  }

  getAPI(context) {
    let isInitialized = false;
    // Make shutdown idempotent and avoid calling ExtensionSupport.unregisterWindowListener
    // unless we know we previously registered (prevents ExtensionSupport warning spam on reload).
    let _didShutdown = false;
    const listenerId = `${context.extension.id}-threadPaneDisplayToggle-windows`;
    const sortOrderObserverId = `${context.extension.id}-threadPaneDisplayToggle-sortOrderObserver`;
    const WINDOW_LISTENER_FLAG_KEY = "__tmDisplayToggleWindowListenerRegistered";

    const shutdown = (reason) => {
      if (_didShutdown) {
        tpdtLog(`shutdown already ran; skipping (${reason})`);
        return;
      }
      _didShutdown = true;
      try {
        // Remove prefs observer (avoid leaks on hot reload)
        try {
          if (ServicesTPDT?.prefs && ServicesTPDT.prefs.removeObserver && ServicesTPDT.__tmDisplayToggleSortOrderObserver) {
            try {
              ServicesTPDT.prefs.removeObserver(
                TPDT_CONFIG.sortOrderPref,
                ServicesTPDT.__tmDisplayToggleSortOrderObserver
              );
              tpdtLog(`Removed prefs observer for ${TPDT_CONFIG.sortOrderPref}`);
            } catch (e) {
              tpdtWarn("Failed removing prefs observer:", e);
            }
            ServicesTPDT.__tmDisplayToggleSortOrderObserver = null;
          }
        } catch (_) {}

        forEach3Pane((win) => {
          try {
            // Remove TabSelect listener if present
            const tabmail = win?.document?.getElementById?.("tabmail") || null;
            const tabTarget = tabmail?.tabContainer || tabmail || null;
            if (tabTarget && win.__tmDisplayToggleTabSelectHandler) {
              try {
                tabTarget.removeEventListener(
                  "TabSelect",
                  win.__tmDisplayToggleTabSelectHandler
                );
              } catch (_) {}
              win.__tmDisplayToggleTabSelectHandler = null;
            }

            // Remove contentWin listeners
            if (win.__tmDisplayToggleContentWindows) {
              try {
                for (const contentWin of win.__tmDisplayToggleContentWindows) {
                  if (contentWin.__tmDisplayToggleFolderURIHandler) {
                    try {
                      contentWin.removeEventListener(
                        "folderURIChanged",
                        contentWin.__tmDisplayToggleFolderURIHandler
                      );
                    } catch (_) {}
                    contentWin.__tmDisplayToggleFolderURIHandler = null;
                  }
                  if (contentWin.__tmDisplayToggleThreadPaneLoadedHandler) {
                    try {
                      contentWin.removeEventListener(
                        "threadpane-loaded",
                        contentWin.__tmDisplayToggleThreadPaneLoadedHandler
                      );
                    } catch (_) {}
                    contentWin.__tmDisplayToggleThreadPaneLoadedHandler = null;
                  }
                }
                win.__tmDisplayToggleContentWindows.clear();
                delete win.__tmDisplayToggleContentWindows;
                tpdtLog(`(${reason}) removed contentWin listeners`);
              } catch (e) {
                tpdtWarn(`(${reason}) failed cleaning contentWin listeners:`, e);
              }
            }

            detachOverrideFromContentWindow(win, reason);
          } catch (_) {}
        });

        try {
          if (ServicesTPDT?.[WINDOW_LISTENER_FLAG_KEY] === true) {
            ExtensionSupportTPDT.unregisterWindowListener(listenerId);
            ServicesTPDT[WINDOW_LISTENER_FLAG_KEY] = false;
          }
        } catch (_) {}

        isInitialized = false;
        tpdtLog(`shutdown complete (${reason})`);
      } catch (e) {
        tpdtErr(`shutdown failed (${reason}):`, e);
      }
    };

    this._shutdown = shutdown;

    return {
      threadPaneDisplayToggle: {
        init() {
          if (isInitialized) {
            tpdtLog("init called but already initialized; skipping");
            return;
          }
          isInitialized = true;
          _didShutdown = false;

          // Observe sort order pref changes so the header icon stays in sync even if changed elsewhere.
          try {
            if (ServicesTPDT?.prefs?.addObserver && !ServicesTPDT.__tmDisplayToggleSortOrderObserver) {
              ServicesTPDT.__tmDisplayToggleSortOrderObserver = {
                observe(subject, topic, data) {
                  try {
                    if (topic !== "nsPref:changed") return;
                    if (data !== TPDT_CONFIG.sortOrderPref) return;
                    const v = readSortOrderPref();
                    tpdtLog(`pref changed: ${TPDT_CONFIG.sortOrderPref}=${v} (${sortOrderObserverId})`);
                    forEach3Pane((win) => {
                      try {
                        const contentWin = getAbout3PaneContentWindow(win);
                        const doc = contentWin?.document || null;
                        const sbtn = doc?.getElementById?.(TPDT_CONFIG.sortDirectionButtonId) || null;
                        if (sbtn) applySortDirectionButtonIcon(sbtn, context, v);
                      } catch (_) {}
                    });
                  } catch (e) {
                    tpdtWarn("prefs observer observe() failed:", e);
                  }
                },
              };
              ServicesTPDT.prefs.addObserver(
                TPDT_CONFIG.sortOrderPref,
                ServicesTPDT.__tmDisplayToggleSortOrderObserver
              );
              tpdtLog(`Added prefs observer for ${TPDT_CONFIG.sortOrderPref}`);
            }
          } catch (e) {
            tpdtWarn("Failed to add prefs observer for sortOrderPref:", e);
          }

          // Apply to already-open windows
          forEach3Pane((win) => {
            // Attach lifecycle hooks so we inject even if this window/tab isn't focused.
            ensureContentWinHooks(win, context, "init-existing");
          });

          // Attach to future windows and keep in sync with tab switches.
          try {
            try {
              if (ServicesTPDT?.[WINDOW_LISTENER_FLAG_KEY] === true) {
                ExtensionSupportTPDT.unregisterWindowListener(listenerId);
                ServicesTPDT[WINDOW_LISTENER_FLAG_KEY] = false;
              }
            } catch (_) {}

            ExtensionSupportTPDT.registerWindowListener(listenerId, {
              chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
              onLoadWindow(win) {
                try {
                  ensureContentWinHooks(win, context, "onLoadWindow");

                  // Re-apply when switching tabs (about:3pane can change)
                  const tabmail = win?.document?.getElementById?.("tabmail") || null;
                  if (tabmail && !win.__tmDisplayToggleTabSelectHandler) {
                    win.__tmDisplayToggleTabSelectHandler = () => {
                      ensureContentWinHooks(win, context, "TabSelect");
                    };
                    try {
                      const tabTarget = tabmail?.tabContainer || tabmail;
                      tabTarget.addEventListener(
                        "TabSelect",
                        win.__tmDisplayToggleTabSelectHandler
                      );
                    } catch (e) {
                      tpdtWarn("Failed to attach TabSelect listener:", e);
                    }
                  }
                } catch (e) {
                  tpdtErr("onLoadWindow handler failed:", e);
                }
              },
            });

            if (ServicesTPDT) ServicesTPDT[WINDOW_LISTENER_FLAG_KEY] = true;
            tpdtLog("registered window listener:", listenerId);
          } catch (e) {
            tpdtErr("registerWindowListener failed:", e);
          }
        },

        shutdown() {
          shutdown("api.shutdown()");
        },
      },
    };
  }
};

