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

// TabMail action tag keys (used to ignore non-TabMail tags during BY_TAGS sorting)
const TABMAIL_ACTION_TAG_KEYS = new Set(["tm_reply", "tm_archive", "tm_delete", "tm_none"]);

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
    this._onUntaggedFire = null; // Fire reference for onUntaggedInboxMessages event
    this._messageManager = null; // For converting native headers to WebExtension message IDs
  }

  onShutdown(isAppShutdown) {
    console.log("[TagSort] onShutdown() called, isAppShutdown:", isAppShutdown);
    try {
      if (this._cleanup) {
        this._cleanup();
      }
      this._onUntaggedFire = null;
    } catch (e) {
      console.error("[TagSort] onShutdown cleanup failed:", e);
    }
  }

  getAPI(context) {
    const self = this;
    let isInitialized = false;
    let _didCleanup = false;
    let _windowListenerRegistered = false;
    let _sortOrderNotifyObserver = null;
    let _tagSortEnabledPrefObserver = null;

    // Store messageManager for converting native headers to WebExtension IDs
    self._messageManager = context.extension.messageManager;

    // Per-window state constants
    const SORT_DEBOUNCE_MS = 100;
    const SELECTION_GRACE_MS = 500;
    const RESORT_COALESCE_MS = 250;
    const DELAYED_SORT_MS = 30000;
    const VISIBILITY_RESTORE_FALLBACK_MS = 2000;

    // Coverage/untagged message detection settings
    // maxRowsToCheck matches SETTINGS.inboxManagement.maxRecentEmails (100)
    // No debounce needed - the MV3 queue already handles deduplication and batching
    const UNTAGGED_COVERAGE_CONFIG = {
      enabled: true,
      maxRowsToCheck: 100,        // Only check first N rows (matches maxRecentEmails)
      maxMessagesPerEvent: 50,    // Max messages to report per event
      logMax: 20,                 // Max log entries for debugging
    };
    let _untaggedCoverageLogCount = 0;

    // Per-window state helpers
    function getWinSortTimestamp(win) { return win?.__tmTagSortLastSortTs || 0; }
    function setWinSortTimestamp(win, ts) { if (win) win.__tmTagSortLastSortTs = ts; }
    function getWinSelectionTimestamp(win) { return win?.__tmTagSortLastSelectionTs || 0; }
    function setWinSelectionTimestamp(win, ts) { if (win) win.__tmTagSortLastSelectionTs = ts; }
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

    // Custom column sort (TB 145): stable TabMail action priority sort
    const TM_CUSTOM_SORT_COLUMN_ID = "tmActionSort";
    const TM_ACTION_TAG_KEY_PRIORITY = ["tm_reply", "tm_none", "tm_archive", "tm_delete"];
    let _customColumnRegistered = false;

    function _scoreForKeywordsString(keywordsStr) {
      try {
        const kw = String(keywordsStr || "");
        if (!kw) return 0;
        const keys = kw.split(/\s+/).filter(Boolean);
        if (!keys.length) return 0;
        for (let i = 0; i < TM_ACTION_TAG_KEY_PRIORITY.length; i++) {
          if (keys.includes(TM_ACTION_TAG_KEY_PRIORITY[i])) {
            return TM_ACTION_TAG_KEY_PRIORITY.length - i;
          }
        }
        return 0;
      } catch (_) { return 0; }
    }

    function _labelForScore(score) {
      if (!score || score <= 0) return "";
      const max = TM_ACTION_TAG_KEY_PRIORITY.length;
      if (score === max) return "Reply";
      if (score === max - 1) return "None";
      if (score === max - 2) return "Archive";
      if (score === max - 3) return "Delete";
      return "";
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
            textCallback(hdr) {
              const kw = hdr?.getStringProperty?.("keywords") || hdr?.keywords || "";
              return _labelForScore(_scoreForKeywordsString(kw));
            },
            sortCallback(hdr) {
              const kw = hdr?.getStringProperty?.("keywords") || hdr?.keywords || "";
              return _scoreForKeywordsString(kw);
            },
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
          getCellText(hdr) {
            const kw = hdr?.getStringProperty?.("keywords") || hdr?.keywords || "";
            return _labelForScore(_scoreForKeywordsString(kw));
          },
          getSortStringForRow(hdr) { return this.getCellText(hdr); },
          getSortLongForRow(hdr) {
            const kw = hdr?.getStringProperty?.("keywords") || hdr?.keywords || "";
            return _scoreForKeywordsString(kw);
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

    // ========================================================================
    // Untagged message coverage: detect untagged inbox messages and report
    // them to MV3 for processing. This provides "complete" inbox coverage
    // without needing periodic scans.
    // ========================================================================

    function _fireUntaggedMessage(hdr, rowIndex, folderUri) {
      try {
        if (!UNTAGGED_COVERAGE_CONFIG.enabled) return;
        if (!self._onUntaggedFire) return; // No listener registered

        const messageId = hdr?.messageId || "";
        if (!messageId) return;

        // Try to get WebExtension message ID using messageManager.convert()
        // This avoids needing browser.messages.query on the MV3 side
        let weMsgId = null;
        try {
          if (self._messageManager) {
            const weMsg = self._messageManager.convert(hdr);
            weMsgId = weMsg?.id || null;
          }
        } catch (_) {
          // Message may not be convertible - MV3 will fall back to query
        }

        const info = {
          messageKey: hdr?.messageKey ?? -1,
          messageId: messageId,
          weMsgId: weMsgId,
          folderUri: folderUri || "",
          rowIndex: rowIndex,
        };

        if (_untaggedCoverageLogCount < UNTAGGED_COVERAGE_CONFIG.logMax) {
          _untaggedCoverageLogCount++;
          tlog("Firing onUntaggedInboxMessages event for:", messageId.substring(0, 50), "weMsgId:", weMsgId);
        }

        // Fire immediately - the MV3 queue handles deduplication and batching
        try {
          self._onUntaggedFire.async([info]);
        } catch (eFire) {
          tlog("Failed to fire onUntaggedInboxMessages event:", eFire);
        }
      } catch (e) {
        tlog("_fireUntaggedMessage error:", e);
      }
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

    function scheduleDelayedSort(win, immediate = false, preserveSelection = true) {
      if (!win) return;
      if (immediate) {
        applySort(win, preserveSelection);
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

    function recolorTableRows(innerDoc, view, isCardView) {
      if (isCardView) return 0;
      const rowCountNow = view?.rowCount || 0;
      const rows = innerDoc.querySelectorAll('[id^="threadTree-row"]');
      let applied = 0;

      // Check if current folder is inbox for coverage detection
      let isInbox = false;
      let folderUri = "";
      try {
        const folder = view?.msgFolder || view?.displayedFolder;
        isInbox = folder ? _isInboxOrUnifiedInboxFolder(folder) : false;
        folderUri = folder?.URI || "";
      } catch (_) {}

      // Large inbox constraint: only check first N rows
      const maxRowsForCoverage = UNTAGGED_COVERAGE_CONFIG.maxRowsToCheck;
      const isLargeInbox = rowCountNow > maxRowsForCoverage;

      for (const row of rows) {
        try {
          const m = /threadTree-row(\d+)/.exec(row.id || "");
          const rowIndex = m ? parseInt(m[1], 10) : null;
          if (rowIndex == null || rowIndex >= rowCountNow) continue;

          let hdr = null;
          try { hdr = view?.getMsgHdrAt?.(rowIndex); } catch (_) {}
          if (!hdr) try { hdr = view?.getMessageHdrAt?.(rowIndex); } catch (_) {}
          if (!hdr) try { hdr = view?.dbView?.hdrForRow?.(rowIndex); } catch (_) {}
          if (!hdr) continue;

          const keywords = hdr.getStringProperty?.("keywords") || "";
          const keys = keywords ? keywords.split(/\s+/).filter(Boolean) : [];
          let color = null;
          let hasTabMailTag = false;

          for (const k of TM_ACTION_TAG_KEY_PRIORITY) {
            if (keys.includes(k)) {
              hasTabMailTag = true;
              color = MailServicesTagSort?.tags?.getColorForKey?.(k) || null;
              if (color) break;
            }
          }

          if (color) {
            if (row.style.getPropertyValue("--tag-color") !== color) {
              row.style.setProperty("--tag-color", color);
              applied++;
            }
          } else if (row.style.getPropertyValue("--tag-color")) {
            row.style.removeProperty("--tag-color");
            applied++;
          }

          // Coverage: detect untagged inbox messages
          // Skip if: not inbox, message already has TabMail tag, or large inbox and row is beyond limit
          if (isInbox && !hasTabMailTag && UNTAGGED_COVERAGE_CONFIG.enabled) {
            // Large inbox constraint: only process recent messages (first N rows based on sort)
            if (!isLargeInbox || rowIndex < maxRowsForCoverage) {
              _fireUntaggedMessage(hdr, rowIndex, folderUri);
            }
          }
        } catch (_) {}
      }
      return applied;
    }

    function immediateRecolorForWindow(win) {
      try {
        if (!win) return;
        const tabmail = win.document.getElementById("tabmail");
        const contentWin = tabmail?.currentAbout3Pane ||
                          tabmail?.currentTabInfo?.chromeBrowser?.contentWindow ||
                          tabmail?.currentTabInfo?.browser?.contentWindow;
        const innerDoc = contentWin?.document || win.document;
        const mailList = innerDoc.querySelector("mail-message-list");
        if (mailList?.shadowRoot) return; // Skip Card View

        const view = findDBView(win);
        if (view) recolorTableRows(innerDoc, view, false);
      } catch (_) {}
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

    function applySort(win, preserveSelection = true) {
      if (!win) return;

      if (!isTagSortEnabled()) {
        applyDateOnlySort(win);
        return;
      }

      const now = Date.now();
      if (now - getWinSortTimestamp(win) < SORT_DEBOUNCE_MS) return;
      if (now - getWinSelectionTimestamp(win) < SELECTION_GRACE_MS) return;

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

        function hdrForRowGeneric(row) {
          try { return view?.hdrForRow?.(row); } catch (_) {}
          try { return view?.getMsgHdrAt?.(row); } catch (_) {}
          try { return view?.getMessageHdrAt?.(row); } catch (_) {}
          return null;
        }

        // Capture selection
        let captured = { hadSelection: false, origHdrs: [], focusedHdr: null };
        if (preserveSelection) {
          try {
            const sel = view?.selection;
            if (sel?.count > 0) {
              captured.hadSelection = true;
              const focusedIndex = sel.currentIndex;
              let selectedIndices = [];
              for (let i = 0; i < sel.getRangeCount(); i++) {
                let start = {}, end = {};
                sel.getRangeAt(i, start, end);
                for (let j = start.value; j <= end.value; j++) selectedIndices.push(j);
              }
              for (const index of selectedIndices) {
                const hdr = hdrForRowGeneric(index);
                if (hdr) {
                  const info = { hdrKey: hdr.messageKey, hdrMessageId: hdr.messageId, folderUri: hdr.folder?.URI };
                  captured.origHdrs.push(info);
                  if (index === focusedIndex) captured.focusedHdr = info;
                }
              }
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
          win.setTimeout(() => applySort(win, preserveSelection), 32);
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

        const sel = threadTree?.view?.selection || view?.selection;
        const hadSuppressed = !!sel?.selectEventsSuppressed;
        const tbo = threadTree?.treeBoxObject;

        try {
          tbo?.beginUpdateBatch?.();
          if (sel) sel.selectEventsSuppressed = true;
          sel?.clearSelection?.();

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
          if (sel) sel.selectEventsSuppressed = hadSuppressed;
          tbo?.endUpdateBatch?.();
        }

        // Restore selection
        if (preserveSelection && captured.hadSelection && captured.origHdrs.length > 0) {
          try {
            const rowCountNow = view.rowCount || 0;
            const uniqueHdrs = new Map();
            for (const info of captured.origHdrs) {
              if (info.hdrKey != null && info.folderUri) uniqueHdrs.set(`key:${info.hdrKey}:${info.folderUri}`, true);
              if (info.hdrMessageId && info.folderUri) uniqueHdrs.set(`id:${info.hdrMessageId}:${info.folderUri}`, true);
            }

            let foundIndices = [];
            let newFocusedIndex = -1;

            for (let i = 0; i < rowCountNow; i++) {
              const hdr = hdrForRowGeneric(i);
              if (!hdr) continue;
              const uri = hdr.folder?.URI;
              if ((hdr.messageKey != null && uri && uniqueHdrs.has(`key:${hdr.messageKey}:${uri}`)) ||
                  (hdr.messageId && uri && uniqueHdrs.has(`id:${hdr.messageId}:${uri}`))) {
                foundIndices.push(i);
              }
              if (captured.focusedHdr && newFocusedIndex === -1) {
                const f = captured.focusedHdr;
                if ((f.hdrKey != null && f.folderUri && hdr.messageKey === f.hdrKey && uri === f.folderUri) ||
                    (f.hdrMessageId && f.folderUri && hdr.messageId === f.hdrMessageId && uri === f.folderUri)) {
                  newFocusedIndex = i;
                }
              }
            }

            if (foundIndices.length > 0) {
              const targetSel = threadTree?.view?.selection || view?.selection;
              if (targetSel?.rangedSelect) {
                targetSel.clearSelection();
                let isFirst = true;
                let start = foundIndices[0], end = foundIndices[0];
                for (let i = 1; i <= foundIndices.length; i++) {
                  if (i < foundIndices.length && foundIndices[i] === end + 1) {
                    end = foundIndices[i];
                  } else {
                    targetSel.rangedSelect(start, end, !isFirst);
                    isFirst = false;
                    if (i < foundIndices.length) {
                      start = end = foundIndices[i];
                    }
                  }
                }
                if (newFocusedIndex !== -1) targetSel.currentIndex = newFocusedIndex;
              }
            }
          } catch (_) {}
        }

        // Recolor and reveal
        if (!isCardView) recolorTableRows(innerDoc, view, false);

        win.requestAnimationFrame(() => {
          if (!isCardView) recolorTableRows(innerDoc, view, false);
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
          if (win.__tmTagSortSelectionObserver) {
            try { ServicesTS.obs.removeObserver(win.__tmTagSortSelectionObserver, "messageSelection-changed"); } catch (_) {}
            delete win.__tmTagSortSelectionObserver;
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
          delete win.__tmTagSortLastSelectionTs;
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

                      win.__tmTagSortFolderListener = {
                        msgPropertyChanged(hdr, prop) {
                          if (prop === "keywords") { immediateRecolorForWindow(win); scheduleResort(win); }
                        },
                        onMsgPropertyChanged(hdr, prop) {
                          if (prop === "keywords") { immediateRecolorForWindow(win); scheduleResort(win); }
                        },
                        msgsClassified() { immediateRecolorForWindow(win); scheduleResort(win); },
                        onMsgsClassified() { immediateRecolorForWindow(win); scheduleResort(win); },
                        msgsMoveCopyCompleted() { scheduleResort(win); },
                        onMsgsMoveCopyCompleted() { scheduleResort(win); },
                        msgsDeleted() { scheduleResort(win); },
                        onMsgsDeleted() { scheduleResort(win); }
                      };
                      MFN.addListener(win.__tmTagSortFolderListener, mask);
                    } catch (_) {}
                  }

                  // Selection observer
                  if (!win.__tmTagSortSelectionObserver) {
                    try {
                      win.__tmTagSortSelectionObserver = {
                        observe(subject, topic) {
                          if (topic === "messageSelection-changed") setWinSelectionTimestamp(win, Date.now());
                        }
                      };
                      ServicesTS.obs.addObserver(win.__tmTagSortSelectionObserver, "messageSelection-changed");
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
                          // Only clear selection if folder actually changed
                          const currentUri = getCurrentFolderUri(win);
                          const lastUri = getWinLastFolderUri(win);
                          const folderChanged = currentUri && lastUri && currentUri !== lastUri;
                          if (currentUri) setWinLastFolderUri(win, currentUri);
                          scheduleDelayedSort(win, true, !folderChanged);
                        };
                        contentWin.addEventListener("folderURIChanged", contentWin.__tmTagSortFolderURIHandler);
                      }

                      if (!contentWin.__tmTagSortThreadPaneHandler) {
                        contentWin.__tmTagSortThreadPaneHandler = () => {
                          // Only clear selection if folder actually changed
                          const currentUri = getCurrentFolderUri(win);
                          const lastUri = getWinLastFolderUri(win);
                          const folderChanged = currentUri && lastUri && currentUri !== lastUri;
                          if (currentUri) setWinLastFolderUri(win, currentUri);
                          scheduleDelayedSort(win, true, !folderChanged);
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
                        // Only clear selection if folder actually changed
                        const currentUri = getCurrentFolderUri(win);
                        const lastUri = getWinLastFolderUri(win);
                        const folderChanged = currentUri && lastUri && currentUri !== lastUri;
                        if (currentUri) {
                          setWinLastFolderUri(win, currentUri);
                          scheduleDelayedSort(win, true, !folderChanged);
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
            if (win.document?.readyState === "complete") scheduleDelayedSort(win, false, true);
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

        // Event: Fired when the row coloring pass detects untagged inbox messages
        onUntaggedInboxMessages: new ExtensionCommonTS.EventManager({
          context,
          name: "tagSort.onUntaggedInboxMessages",
          register: (fire) => {
            tlog("onUntaggedInboxMessages listener registered");
            self._onUntaggedFire = fire;
            
            return () => {
              tlog("onUntaggedInboxMessages listener unregistered");
              self._onUntaggedFire = null;
            };
          },
        }).api(),
      },
    };
  }
};
