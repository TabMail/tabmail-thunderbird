const { ExtensionSupport: ExtensionSupportTS } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonTS } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { MailServices: MailServicesTagSort } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { ThreadPaneColumns: ThreadPaneColumnsTS } = ChromeUtils.importESModule(
  "chrome://messenger/content/ThreadPaneColumns.mjs"
);

var ServicesTS = globalThis.Services;

const TAGSORT_LOG_PREFIX = "[TagSort]";

function tlog(...args) {
  try {
    console.log(TAGSORT_LOG_PREFIX, ...args);
  } catch (_) {}
}

// Preference keys and defaults
const SORT_ORDER_PREF = "mailnews.default_sort_order";
const SORT_TYPE_PREF = "mailnews.default_sort_type";
const NEWS_SORT_ORDER_PREF = "mailnews.default_news_sort_order";
const NEWS_SORT_TYPE_PREF = "mailnews.default_news_sort_type";
const SORT_ORDER_DESCENDING = 2;
const SORT_ORDER_ASCENDING = 1;
const TAG_SORT_ENABLED_PREF = "extensions.tabmail.tagSortEnabled";
const TAG_SORT_ENABLED_DEFAULT = 1;

// Notification topic for sort order changes from TabMail button
const TAGSORT_ORDER_NOTIFY_TOPIC = "tabmail-sort-order-changed";


// In-memory desired sort order (set by TabMail button, NOT by Date header)
// This is the source of truth - Date header changes are ignored
let _tabMailDesiredSortOrder = null; // null = not yet initialized

var tagSort = class extends ExtensionCommonTS.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this._cleanup = null;
  }

  onShutdown(isAppShutdown) {
    console.log("[TagSort] onShutdown() called, isAppShutdown:", isAppShutdown);
    try {
      if (this._cleanup) {
        this._cleanup();
      }
    } catch (e) {
      console.error("[TagSort] onShutdown cleanup failed:", e);
    }
  }

  getAPI(context) {
    let isInitialized = false;
    let _didCleanup = false;
    let _windowListenerRegistered = false;
    let _sortOrderNotifyObserver = null;
    let _tagSortEnabledPrefObserver = null;

    // Per-window state constants
    const SORT_DEBOUNCE_MS = 100;
    const RESORT_COALESCE_MS = 250;
    const DELAYED_SORT_MS = 30000;
    const VISIBILITY_RESTORE_FALLBACK_MS = 2000;

    // Per-window state helpers
    function getWinSortTimestamp(win) { return win?.__tmTagSortLastSortTs || 0; }
    function setWinSortTimestamp(win, ts) { if (win) win.__tmTagSortLastSortTs = ts; }
    function getWinResortTimer(win) { return win?.__tmTagSortResortTimer || null; }
    function setWinResortTimer(win, timer) { if (win) win.__tmTagSortResortTimer = timer; }
    function getWinDelayedSortTimer(win) { return win?.__tmTagSortDelayedTimer || null; }
    function setWinDelayedSortTimer(win, timer) { if (win) win.__tmTagSortDelayedTimer = timer; }
    function getWinLastFolderUri(win) { return win?.__tmTagSortLastFolderUri || ""; }
    function setWinLastFolderUri(win, uri) { if (win) win.__tmTagSortLastFolderUri = uri || ""; }

    // Get current folder URI from window's view
    function getCurrentFolderUri(win) {
      try {
        const view = findDBView(win);
        const folder = view?.msgFolder || view?.viewFolder || win.gFolderDisplay?.displayedFolder;
        return folder?.URI || "";
      } catch (_) { return ""; }
    }

    // Custom column sort (TB 145): stable TabMail action priority sort.
    const TM_CUSTOM_SORT_COLUMN_ID = "tmActionSort";
    // Priority ordered highest → lowest. Mirrors TM_ACTION_TAG_KEY_PRIORITY_MLTV.
    const TM_ACTION_PRIORITY = ["reply", "none", "archive", "delete"];
    const _ACTION_TO_KEYWORD = {
      reply: "tm_reply",
      none: "tm_none",
      archive: "tm_archive",
      delete: "tm_delete",
    };
    const _KEYWORD_TO_ACTION = {
      tm_reply: "reply",
      tm_none: "none",
      tm_archive: "archive",
      tm_delete: "delete",
    };
    let _customColumnRegistered = false;

    // Primary: `tm-action` hdr string property (synchronously readable, local
    // mork, not touched by IMAP sync). Fallback: legacy `tm_*` keywords for
    // pre-backfill rows. No in-memory map needed — hdr is the shared state.

    const TM_ACTION_PROP_NAME = "tm-action";

    function _actionFromKeywords(hdr) {
      try {
        const kw = hdr?.getStringProperty?.("keywords") || "";
        if (!kw) return null;
        const keys = kw.split(/\s+/).filter(Boolean);
        for (const a of TM_ACTION_PRIORITY) {
          const k = _ACTION_TO_KEYWORD[a];
          if (k && keys.includes(k)) return a;
        }
        return null;
      } catch (_) {
        return null;
      }
    }

    function _lookupAction(hdr) {
      try {
        const prop = hdr?.getStringProperty?.(TM_ACTION_PROP_NAME) || "";
        if (prop) return String(prop);
      } catch (_) {}
      return _actionFromKeywords(hdr);
    }

    function _scoreForAction(action) {
      if (!action) return 0;
      const idx = TM_ACTION_PRIORITY.indexOf(action);
      if (idx < 0) return 0;
      return TM_ACTION_PRIORITY.length - idx;
    }

    function _labelForAction(action) {
      if (!action) return "";
      return action.charAt(0).toUpperCase() + action.slice(1);
    }

    function ensureCustomColumnRegistered() {
      try {
        if (_customColumnRegistered) return true;
        if (!ThreadPaneColumnsTS?.addCustomColumn) return false;

        try {
          ThreadPaneColumnsTS.addCustomColumn(TM_CUSTOM_SORT_COLUMN_ID, {
            name: "TabMail Action",
            hidden: true,
            resizable: false,
            sortable: true,
            textCallback(hdr) { return _labelForAction(_lookupAction(hdr)); },
            sortCallback(hdr) { return _scoreForAction(_lookupAction(hdr)); },
          });
        } catch (eAdd) {
          if (!String(eAdd).includes("already used")) throw eAdd;
        }
        _customColumnRegistered = true;
        return true;
      } catch (e) {
        console.error("[TagSort] Failed to register custom column:", e);
        return false;
      }
    }

    function ensureCustomColumnHandlerAttached(view) {
      try {
        if (!view?.addColumnHandler) return false;
        if (!ensureCustomColumnRegistered()) return false;
        try {
          if (view.getColumnHandler?.(TM_CUSTOM_SORT_COLUMN_ID)) return true;
        } catch (_) {}

        const handler = {
          QueryInterface: ChromeUtils.generateQI(["nsIMsgCustomColumnHandler"]),
          getRowProperties() { return ""; },
          getCellText(hdr) { return _labelForAction(_lookupAction(hdr)); },
          getSortStringForRow(hdr) { return this.getCellText(hdr); },
          getSortLongForRow(hdr) {
            return _scoreForAction(_lookupAction(hdr));
          },
          isString() { return false; },
        };
        view.addColumnHandler(TM_CUSTOM_SORT_COLUMN_ID, handler);
        return true;
      } catch (e) {
        console.error("[TagSort] Failed attaching custom column handler:", e);
        return false;
      }
    }

    function getSortOrderPref() {
      // Use in-memory value if set (from TabMail button), otherwise read from pref
      if (_tabMailDesiredSortOrder !== null) {
        return _tabMailDesiredSortOrder;
      }
      // First call: initialize from pref
      try {
        const value = ServicesTS?.prefs?.getIntPref?.(SORT_ORDER_PREF, SORT_ORDER_DESCENDING);
        _tabMailDesiredSortOrder = (value === SORT_ORDER_ASCENDING || value === SORT_ORDER_DESCENDING)
          ? value
          : SORT_ORDER_DESCENDING;
        return _tabMailDesiredSortOrder;
      } catch (_) {
        _tabMailDesiredSortOrder = SORT_ORDER_DESCENDING;
        return SORT_ORDER_DESCENDING;
      }
    }

    function isTagSortEnabled() {
      try {
        return ServicesTS?.prefs?.getIntPref?.(TAG_SORT_ENABLED_PREF, TAG_SORT_ENABLED_DEFAULT) === 1;
      } catch (_) { return true; }
    }

    function _isInboxOrUnifiedInboxFolder(folder) {
      try {
        const Ci = globalThis.Ci;
        if (!Ci?.nsMsgFolderFlags) return false;
        const flags = folder?.flags ?? 0;
        const isInbox = folder?.isSpecialFolder
          ? folder.isSpecialFolder(Ci.nsMsgFolderFlags.Inbox, true)
          : (flags & Ci.nsMsgFolderFlags.Inbox);
        const isVirtual = !!(flags & Ci.nsMsgFolderFlags.Virtual);
        const isUnifiedInbox = isVirtual && /inbox/i.test(folder?.prettyName || folder?.name || "");
        return !!(isInbox || isUnifiedInbox);
      } catch (_) { return false; }
    }

    function applyDateOnlySort(win) {
      if (!win) return;
      try {
        const tabmail = win.document.getElementById("tabmail");
        if (tabmail?.currentTabInfo?.mode?.name !== "mail3PaneTab") return;
      } catch (_) {}

      const view = findDBView(win);
      if (!view) return;

      try {
        const Ci = globalThis.Ci;
        const folder = view.msgFolder || win.gFolderDisplay?.displayedFolder;
        if (!folder || !_isInboxOrUnifiedInboxFolder(folder)) return;

        const BY_DATE = Ci?.nsMsgViewSortType?.byDate ?? 18;
        const ASC = Ci?.nsMsgViewSortOrder?.ascending ?? 1;
        const DESC = Ci?.nsMsgViewSortOrder?.descending ?? 2;
        const targetOrder = getSortOrderPref() === SORT_ORDER_ASCENDING ? ASC : DESC;

        if (view.curSortType === BY_DATE && view.curSortOrder === targetOrder) return;
        view.sort?.(BY_DATE, targetOrder);
      } catch (e) {
        console.error("[TagSort] applyDateOnlySort failed:", e);
      }
    }

    // Called when keywords/tags change
    // IMPORTANT DESIGN CHOICE: Uses delayed sort (not immediate) to avoid jarring UI
    // - Coalesces rapid tag changes (250ms) then schedules a 30s delayed sort
    // - This prevents emails from visually jumping around while user is watching
    // - Sorting happens when activity settles and user isn't actively looking
    function scheduleResort(win) {
      if (!win) return;
      const existingTimer = getWinResortTimer(win);
      if (existingTimer) win.clearTimeout(existingTimer);
      const timer = win.setTimeout(() => {
        setWinResortTimer(win, null);
        scheduleDelayedSort(win, false, true);
      }, RESORT_COALESCE_MS);
      setWinResortTimer(win, timer);
    }

    function scheduleDelayedSort(win, immediate = false) {
      if (!win) return;
      if (immediate) {
        applySort(win);
        return;
      }
      const existingTimer = getWinDelayedSortTimer(win);
      if (existingTimer) win.clearTimeout(existingTimer);
      const timer = win.setTimeout(() => {
        setWinDelayedSortTimer(win, null);
        applySort(win, true);
      }, DELAYED_SORT_MS);
      setWinDelayedSortTimer(win, timer);
    }

    function findDBView(win) {
      if (win.gDBView) return win.gDBView;
      if (win.gFolderDisplay?.view?.dbView) return win.gFolderDisplay.view.dbView;

      let contentWin = null;
      try {
        const tabmail = win.document.getElementById("tabmail");
        contentWin = tabmail?.currentAbout3Pane ||
                     tabmail?.currentTabInfo?.chromeBrowser?.contentWindow ||
                     tabmail?.currentTabInfo?.browser?.contentWindow;
      } catch (_) {}

      if (contentWin) {
        if (contentWin.gDBView) return contentWin.gDBView;
        if (contentWin.gFolderDisplay?.view?.dbView) return contentWin.gFolderDisplay.view.dbView;
      }

      const tree = win.document.getElementById("threadTree") ||
                   contentWin?.document?.getElementById("threadTree") ||
                   win.document.querySelector("mail-message-list")?.shadowRoot?.getElementById("threadTree") ||
                   contentWin?.document?.querySelector("mail-message-list")?.shadowRoot?.getElementById("threadTree");
      return tree?.view?.dbView || null;
    }

    function applySort(win) {
      if (!win) return;

      if (!isTagSortEnabled()) {
        applyDateOnlySort(win);
        return;
      }

      const now = Date.now();
      if (now - getWinSortTimestamp(win) < SORT_DEBOUNCE_MS) return;

      const tabmail = win.document.getElementById("tabmail");
      try {
        if (tabmail?.currentTabInfo?.mode?.name !== "mail3PaneTab") return;
      } catch (_) {}

      const view = findDBView(win);
      if (!view) return;

      // Hoist visibility-related variables so catch block can access them
      let threadTree = null;
      let originalVisibility = '';
      let visibilityWasHidden = false;
      let visibilityRestoreTimeoutId = null;

      try {
        const Ci = globalThis.Ci;
        const folder = view.msgFolder || win.gFolderDisplay?.displayedFolder;
        if (!folder) return;
        if (!_isInboxOrUnifiedInboxFolder(folder)) return;

        setWinSortTimestamp(win, now);

        const BY_CUSTOM = Ci?.nsMsgViewSortType?.byCustom;
        const BY_DATE = Ci?.nsMsgViewSortType?.byDate ?? 18;
        const ASC = Ci?.nsMsgViewSortOrder?.ascending ?? 1;
        const DESC = Ci?.nsMsgViewSortOrder?.descending ?? 2;
        const targetOrder = getSortOrderPref() === SORT_ORDER_ASCENDING ? ASC : DESC;
        const desiredPrefOrder = targetOrder === ASC ? SORT_ORDER_ASCENDING : SORT_ORDER_DESCENDING;

        function syncSortPrefs() {
          try {
            if (!ServicesTS?.prefs) return;
            // Keep base/default prefs in sync with our intended custom sort direction.
            ServicesTS.prefs.setIntPref(SORT_ORDER_PREF, desiredPrefOrder);
            ServicesTS.prefs.setIntPref(NEWS_SORT_ORDER_PREF, desiredPrefOrder);

            if (typeof BY_CUSTOM === "number") {
              ServicesTS.prefs.setIntPref(SORT_TYPE_PREF, BY_CUSTOM);
              ServicesTS.prefs.setIntPref(NEWS_SORT_TYPE_PREF, BY_CUSTOM);
            }
          } catch (_) {}
        }

        if (!view.sort) return;

        // Always sort when applySort is called - debouncing handles rate limiting
        // The previous "needsSort" check was removed because:
        // 1. It could have false negatives (adjacent messages with same score)
        // 2. With debouncing (30s delay or immediate) and masking, extra sorts are cheap
        // 3. Simplifies the code and ensures sorting always happens when requested
        const rowCount = view.rowCount || 0;
        if (rowCount <= 1) return;

        const doc = win.document;
        const contentWin = tabmail?.currentAbout3Pane ||
                          tabmail?.currentTabInfo?.chromeBrowser?.contentWindow ||
                          tabmail?.currentTabInfo?.browser?.contentWindow;
        const innerDoc = contentWin?.document || doc;
        const mailList = innerDoc.querySelector("mail-message-list");
        threadTree = innerDoc.getElementById("threadTree") || mailList?.shadowRoot?.getElementById("threadTree");
        const isCardView = mailList && mailList.shadowRoot;

        if (!view.rowCount || view.rowCount < 2) {
          win.setTimeout(() => applySort(win), 32);
          return;
        }

        // Hide tree for batch rendering (Table View only)
        if (threadTree && !isCardView) {
          originalVisibility = threadTree.style.visibility || '';
          if (originalVisibility !== 'hidden') {
            threadTree.style.visibility = 'hidden';
            visibilityWasHidden = true;
            tlog("applySort: hiding threadTree visibility");
            // Safety timeout: restore visibility even if requestAnimationFrame fails
            // This handles cases where user is away and rAF is throttled/paused
            visibilityRestoreTimeoutId = win.setTimeout(() => {
              if (visibilityWasHidden && threadTree) {
                tlog("applySort: restoring visibility via timeout fallback");
                threadTree.style.visibility = originalVisibility;
                visibilityWasHidden = false;
              }
            }, VISIBILITY_RESTORE_FALLBACK_MS);
          }
        }

        try {
          doc.documentElement.setAttribute("data-tm-sort-busy", "1");
        } catch (_) {}

        const tbo = threadTree?.treeBoxObject;

        try {
          tbo?.beginUpdateBatch?.();

          if (!BY_CUSTOM || !ensureCustomColumnHandlerAttached(view)) {
            throw new Error("custom-sort-unavailable");
          }

          // Ensure prefs align with our desired custom sort direction and type.
          syncSortPrefs();

          // CRITICAL: DOUBLE SORT WORKAROUND
          // ================================
          // Thunderbird's DBView ignores direct assignment to secondarySortOrder.
          // When view.sort(BY_CUSTOM, order) is called, TB resets secondarySortOrder
          // to whatever internal state it had, ignoring our explicit setting.
          //
          // The fix: Sort by DATE first with our desired order. This establishes
          // the order in TB's internal sort state. Then when we sort by CUSTOM,
          // TB uses the date sort order we just set as the secondary sort.
          //
          // Without this double-sort, clicking the native Date header would cause
          // the secondary date sort to use the wrong direction even after our
          // TabMail sort button explicitly sets the order.
          view.sort(BY_DATE, targetOrder);

          // Now perform the custom sort - TB will inherit date order as secondary
          try {
            view.secondarySortType = BY_DATE;
            view.secondarySortOrder = targetOrder;
            view.curCustomColumn = TM_CUSTOM_SORT_COLUMN_ID;
          } catch (_) {}

          view.sort(BY_CUSTOM, targetOrder);
        } finally {
          tbo?.endUpdateBatch?.();
        }

        // Request tmMessageListTableView to repaint rows after the sort re-render.
        // Table-view row paint happens via the fillRow patch in
        // tmMessageListTableView — runs automatically as TB re-renders rows
        // after view.sort(...). No explicit notify needed.

        win.requestAnimationFrame(() => {
          // Table-view row paint happens via the fillRow patch in
        // tmMessageListTableView — runs automatically as TB re-renders rows
        // after view.sort(...). No explicit notify needed.
          win.requestAnimationFrame(() => {
            if (threadTree && !isCardView && visibilityWasHidden) {
              tlog("applySort: restoring visibility via requestAnimationFrame");
              threadTree.style.visibility = originalVisibility;
              visibilityWasHidden = false;
              if (visibilityRestoreTimeoutId) {
                win.clearTimeout(visibilityRestoreTimeoutId);
                visibilityRestoreTimeoutId = null;
              }
            }
            win.requestAnimationFrame(() => {
              try { doc.documentElement.removeAttribute("data-tm-sort-busy"); } catch (_) {}
            });
          });
        });

      } catch (e) {
        console.error("[TagSort] applySort failed:", e);
        try { win.document.documentElement.removeAttribute("data-tm-sort-busy"); } catch (_) {}
        // Restore visibility if it was hidden and not yet restored
        if (visibilityWasHidden && threadTree) {
          tlog("applySort: restoring visibility in catch block due to error");
          try {
            threadTree.style.visibility = originalVisibility;
            visibilityWasHidden = false;
          } catch (_) {}
        }
        // Clear the safety timeout if set
        if (visibilityRestoreTimeoutId) {
          try { win.clearTimeout(visibilityRestoreTimeoutId); } catch (_) {}
          visibilityRestoreTimeoutId = null;
        }
      }
    }

    function applySortToAllWindows() {
      if (!ServicesTS?.wm) return;
      const enumWin = ServicesTS.wm.getEnumerator("mail:3pane");
      while (enumWin.hasMoreElements()) {
        const win = enumWin.getNext();
        if (win.document?.readyState === "complete") {
          applySort(win);
        } else {
          win.addEventListener("load", () => applySort(win), { once: true });
        }
      }
    }

    const listenerId = `${context.extension.id}-tagSort-windows`;

    const cleanup = () => {
      if (_didCleanup) return;
      _didCleanup = true;

      try {
        if (_sortOrderNotifyObserver) {
          try { ServicesTS?.obs?.removeObserver(_sortOrderNotifyObserver, TAGSORT_ORDER_NOTIFY_TOPIC); } catch (_) {}
          _sortOrderNotifyObserver = null;
        }
        if (_tagSortEnabledPrefObserver) {
          try { ServicesTS?.prefs?.removeObserver(TAG_SORT_ENABLED_PREF, _tagSortEnabledPrefObserver); } catch (_) {}
          _tagSortEnabledPrefObserver = null;
        }

        const enumWin = ServicesTS?.wm?.getEnumerator?.("mail:3pane");
        while (enumWin?.hasMoreElements()) {
          const win = enumWin.getNext();
          if (win.__tmTagSortFolderListener) {
            try { MailServicesTagSort.mfn.removeListener(win.__tmTagSortFolderListener); } catch (_) {}
            delete win.__tmTagSortFolderListener;
          }
          if (win.__tmTagSortTabSelectHandler) {
            try {
              const tabmail = win.document.getElementById("tabmail");
              tabmail?.tabContainer?.removeEventListener("TabSelect", win.__tmTagSortTabSelectHandler);
            } catch (_) {}
            delete win.__tmTagSortTabSelectHandler;
          }
          if (win.__tmTagSortContentWindows) {
            try {
              for (const cw of win.__tmTagSortContentWindows) {
                if (cw.__tmTagSortFolderURIHandler) {
                  cw.removeEventListener("folderURIChanged", cw.__tmTagSortFolderURIHandler);
                  delete cw.__tmTagSortFolderURIHandler;
                }
                if (cw.__tmTagSortThreadPaneHandler) {
                  cw.removeEventListener("threadpane-loaded", cw.__tmTagSortThreadPaneHandler);
                  delete cw.__tmTagSortThreadPaneHandler;
                }
              }
              win.__tmTagSortContentWindows.clear();
            } catch (_) {}
            delete win.__tmTagSortContentWindows;
            delete win.__tmTagSortEnsureListeners;
          }
          const resortTimer = getWinResortTimer(win);
          if (resortTimer) { win.clearTimeout(resortTimer); setWinResortTimer(win, null); }
          const delayedTimer = getWinDelayedSortTimer(win);
          if (delayedTimer) { win.clearTimeout(delayedTimer); setWinDelayedSortTimer(win, null); }
          delete win.__tmTagSortLastSortTs;
          delete win.__tmTagSortLastFolderUri;
        }

        if (_windowListenerRegistered) {
          try { ExtensionSupportTS.unregisterWindowListener(listenerId); } catch (_) {}
          _windowListenerRegistered = false;
        }
        isInitialized = false;
      } catch (e) {
        console.error("[TagSort] cleanup error:", e);
      }
    };

    this._cleanup = cleanup;

    return {
      tagSort: {
        init(_opts) {
          if (isInitialized) return;
          isInitialized = true;
          _didCleanup = false;
          tlog("init: starting");

          // Listen for sort order changes from TabMail button (via notification)
          // This is the ONLY way sort order changes trigger TagSort (not via pref observer)
          // so Date header clicks don't interfere
          try {
            if (!_sortOrderNotifyObserver) {
              _sortOrderNotifyObserver = {
                observe(subject, topic, data) {
                  if (topic !== TAGSORT_ORDER_NOTIFY_TOPIC) return;
                  const order = parseInt(data, 10);
                  if (order === SORT_ORDER_ASCENDING || order === SORT_ORDER_DESCENDING) {
                    tlog("notification: TabMail button set sort order to", order);
                    _tabMailDesiredSortOrder = order;
                    // Re-sort all windows with the new order
                    const enumWin = ServicesTS.wm.getEnumerator("mail:3pane");
                    while (enumWin.hasMoreElements()) {
                      const win = enumWin.getNext();
                      if (win.document?.readyState === "complete") scheduleDelayedSort(win, true, true);
                    }
                  }
                },
              };
              ServicesTS.obs.addObserver(_sortOrderNotifyObserver, TAGSORT_ORDER_NOTIFY_TOPIC);
            }
          } catch (e) {
            tlog("init: failed adding sort order notification observer", e);
          }

          // Observe tag sort enabled pref
          try {
            if (ServicesTS?.prefs?.addObserver && !_tagSortEnabledPrefObserver) {
              _tagSortEnabledPrefObserver = {
                observe(subject, topic, data) {
                  if (topic !== "nsPref:changed" || data !== TAG_SORT_ENABLED_PREF) return;
                  const enumWin = ServicesTS.wm.getEnumerator("mail:3pane");
                  while (enumWin.hasMoreElements()) {
                    const win = enumWin.getNext();
                    if (win.document?.readyState === "complete") scheduleDelayedSort(win, true, true);
                  }
                },
              };
              ServicesTS.prefs.addObserver(TAG_SORT_ENABLED_PREF, _tagSortEnabledPrefObserver);
            }
          } catch (_) {}

          applySortToAllWindows();

          try {
            if (_windowListenerRegistered) {
              try { ExtensionSupportTS.unregisterWindowListener(listenerId); } catch (_) {}
              _windowListenerRegistered = false;
            }

            ExtensionSupportTS.registerWindowListener(listenerId, {
              chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
              onLoadWindow(win) {
                try {
                  // Folder notification listener
                  if (!win.__tmTagSortFolderListener) {
                    try {
                      const MFN = MailServicesTagSort.mfn;
                      const Flags = Ci.nsIMsgFolderNotificationService;
                      const mask = Flags.msgPropertyChanged | Flags.msgsDeleted | Flags.msgsMoveCopyCompleted | Flags.msgsClassified;

                      // Sort-only listener post Phase 1. Row paint side
                      // lives in tmMessageListTableView's own MFN listener.
                      win.__tmTagSortFolderListener = {
                        msgPropertyChanged(hdr, prop) { if (prop === "keywords") scheduleResort(win); },
                        onMsgPropertyChanged(hdr, prop) { if (prop === "keywords") scheduleResort(win); },
                        msgsClassified() { scheduleResort(win); },
                        onMsgsClassified() { scheduleResort(win); },
                        msgsMoveCopyCompleted() { scheduleResort(win); },
                        onMsgsMoveCopyCompleted() { scheduleResort(win); },
                        msgsDeleted() { scheduleResort(win); },
                        onMsgsDeleted() { scheduleResort(win); },
                      };
                      MFN.addListener(win.__tmTagSortFolderListener, mask);
                    } catch (_) {}
                  }

                  const tabmail = win.document.getElementById("tabmail");

                  const ensureContentWinListeners = (reason) => {
                    try {
                      const contentWin = tabmail?.currentAbout3Pane ||
                                        tabmail?.currentTabInfo?.chromeBrowser?.contentWindow ||
                                        tabmail?.currentTabInfo?.browser?.contentWindow;
                      if (!contentWin) return;

                      if (!contentWin.__tmTagSortFolderURIHandler) {
                        contentWin.__tmTagSortFolderURIHandler = () => {
                          ensureContentWinListeners('folderURIChanged');
                          const currentUri = getCurrentFolderUri(win);
                          if (currentUri) setWinLastFolderUri(win, currentUri);
                          scheduleDelayedSort(win, true);
                        };
                        contentWin.addEventListener("folderURIChanged", contentWin.__tmTagSortFolderURIHandler);
                      }

                      if (!contentWin.__tmTagSortThreadPaneHandler) {
                        contentWin.__tmTagSortThreadPaneHandler = () => {
                          const currentUri = getCurrentFolderUri(win);
                          if (currentUri) setWinLastFolderUri(win, currentUri);
                          scheduleDelayedSort(win, true);
                        };
                        contentWin.addEventListener("threadpane-loaded", contentWin.__tmTagSortThreadPaneHandler);
                      }

                      if (!win.__tmTagSortContentWindows) win.__tmTagSortContentWindows = new Set();
                      win.__tmTagSortContentWindows.add(contentWin);
                    } catch (_) {}
                  };

                  win.__tmTagSortEnsureListeners = ensureContentWinListeners;

                  const tabContainer = tabmail?.tabContainer;
                  if (tabContainer && !win.__tmTagSortTabSelectHandler) {
                    win.__tmTagSortTabSelectHandler = () => {
                      try {
                        ensureContentWinListeners('TabSelect');
                        const currentUri = getCurrentFolderUri(win);
                        if (currentUri) {
                          setWinLastFolderUri(win, currentUri);
                          scheduleDelayedSort(win, true);
                        }
                      } catch (_) {}
                    };
                    tabContainer.addEventListener("TabSelect", win.__tmTagSortTabSelectHandler);
                  }

                  ensureContentWinListeners('onLoadWindow');
                  // Initialize folder tracking
                  const initialUri = getCurrentFolderUri(win);
                  if (initialUri) setWinLastFolderUri(win, initialUri);
                } catch (_) {}
                applySort(win);
              },
            });
            _windowListenerRegistered = true;
          } catch (e) {
            console.error("[TagSort] Failed to register window listener:", e);
          }
        },

        refresh() {
          if (!ServicesTS?.wm) return;
          const enumWin = ServicesTS.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            const win = enumWin.getNext();
            if (win.document?.readyState === "complete") scheduleDelayedSort(win, false);
          }
        },

        refreshImmediate() {
          if (!ServicesTS?.wm) return;
          const enumWin = ServicesTS.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            const win = enumWin.getNext();
            if (win.document?.readyState === "complete") scheduleDelayedSort(win, true, true);
          }
        },

        shutdown() {
          cleanup();
        },
      },
    };
  }
};
