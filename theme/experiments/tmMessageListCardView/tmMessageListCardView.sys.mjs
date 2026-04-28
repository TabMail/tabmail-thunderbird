/*
 * TabMail Message List Card View Experiment
 * 
 * Handles card view enhancements:
 * - Snippet injection (preview text under subject) with zero-flicker rendering
 * - Sender email stripping (shows name only)
 * - Event-driven architecture with fillRow prototype patching
 */

const { ExtensionSupport: ExtensionSupport_MLCV } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { MailServices: MailServices_MLCV } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { ExtensionCommon: ExtensionCommon_MLCV } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

var ServicesCS = globalThis.Services;

const LOG_PREFIX_MLCV = "[TabMail MessageList CardView]";

console.log(`${LOG_PREFIX_MLCV} experiment parent script loaded. Services present?`, typeof ServicesCS !== "undefined");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// Card row height override (TB default is 46px, not enough for snippet line).
// The card container fills this height and vertically centers its content,
// so padding is derived naturally — no mismatch with scroll math.
const CARD_ROW_HEIGHT_MLCV = 108;

// Card snippet configuration
const CARD_SNIPPET_CONFIG_MLCV = {
  logPrefix: `${LOG_PREFIX_MLCV}[CardSnippet]`,
  className: "tm-card-snippet",
  maxChars: 320,
  maxLines: 2,
  maxDiagnostics: 40,
  enabled: true,
  forceDisableInjection: false,
  subjectSelectors: [".thread-card-subject-container", ".subject", ".card-subject", ".subject-line", "[data-column-name='subjectcol']"],
  // In-memory cache in experiment for instant fillRow access (no async hop to MV3)
  memoryCache: {
    maxEntries: 1000,        // Max snippets to keep in memory
    ttlMs: 10 * 60 * 1000,   // Time-to-live: 10 minutes
    pruneThreshold: 1200,    // Prune when cache exceeds this
    pruneTarget: 800,        // Prune down to this many entries
  },
  previewFetch: {
    cacheMs: 5 * 60 * 1000,
    maxCacheEntries: 600,
    pruneIntervalMs: 15 * 1000,
    pruneMaxRemovalsPerRun: 120,
    maxInflightFetches: 4,
    maxFetchesPerPass: 8,
    timeoutMs: 3000,
    batchDelayMs: 60,
    maxKeysPerBatch: 40,
    diag: {
      maxBatchLogs: 25,
      maxResolveLogs: 40,
      maxEmptyPreviewLogs: 40,
      maxTimeoutLogs: 40,
      maxMissingAfterFetchLogs: 40,
    },
  },
  reapply: {
    // Legacy polling config removed - now using event-driven architecture with fillRow patch
    // Kept for reference: maxRowsPerMutation, viewportBufferRows used by Priority 2 fallback
    maxRowsPerMutation: 30,
    viewportBufferRows: 26,
    // pendingTtlMs: prevents hammering failed snippet requests
    pendingTtlMs: 2000,
    pendingMaxEntries: 1200,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// IN-MEMORY SNIPPET CACHE (for instant fillRow access)
// ═══════════════════════════════════════════════════════════════════════════

// Global in-memory cache: hdrKey -> { snippet, timestamp }
const _snippetMemoryCache = new Map();

function _getSnippetFromMemoryCache(hdrKey) {
  if (!hdrKey) return null;
  const entry = _snippetMemoryCache.get(hdrKey);
  if (!entry) return null;
  const ttl = CARD_SNIPPET_CONFIG_MLCV.memoryCache.ttlMs;
  if (ttl > 0 && (Date.now() - entry.timestamp) > ttl) {
    _snippetMemoryCache.delete(hdrKey);
    return null;
  }
  return entry.snippet;
}

function _setSnippetInMemoryCache(hdrKey, snippet) {
  if (!hdrKey || !snippet) return;
  _snippetMemoryCache.set(hdrKey, { snippet, timestamp: Date.now() });
  // Prune if needed
  const threshold = CARD_SNIPPET_CONFIG_MLCV.memoryCache.pruneThreshold;
  if (_snippetMemoryCache.size > threshold) {
    _pruneSnippetMemoryCache();
  }
}

function _pruneSnippetMemoryCache() {
  const target = CARD_SNIPPET_CONFIG_MLCV.memoryCache.pruneTarget;
  const ttl = CARD_SNIPPET_CONFIG_MLCV.memoryCache.ttlMs;
  const now = Date.now();
  // First pass: remove expired entries
  for (const [key, entry] of _snippetMemoryCache) {
    if (ttl > 0 && (now - entry.timestamp) > ttl) {
      _snippetMemoryCache.delete(key);
    }
  }
  // Second pass: if still too many, remove oldest entries
  if (_snippetMemoryCache.size > target) {
    const entries = Array.from(_snippetMemoryCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.slice(0, _snippetMemoryCache.size - target);
    for (const [key] of toRemove) {
      _snippetMemoryCache.delete(key);
    }
  }
}

function _clearSnippetMemoryCache() {
  _snippetMemoryCache.clear();
}

function _getSnippetMemoryCacheStats() {
  return {
    size: _snippetMemoryCache.size,
    maxEntries: CARD_SNIPPET_CONFIG_MLCV.memoryCache.maxEntries,
    ttlMs: CARD_SNIPPET_CONFIG_MLCV.memoryCache.ttlMs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PENDING NEEDS QUEUE (for event-driven snippet fetching)
// ═══════════════════════════════════════════════════════════════════════════

// Queue of hdrKeys that need snippets (cache misses from fillRow)
// IMPORTANT: Not cleared on event fire - drained by getNeeds() to avoid race conditions
const _pendingSnippetNeeds = new Set();
let _pendingNeedsDebounceTimer = null;
let _snippetsNeededEventFire = null; // Set by getAPI to fire the event

// Action-chip click event (fires when user clicks the chip on a card row).
// Set by getAPI; mirrors the snippets-needed event wiring.
let _actionChipClickEventFire = null;
function _fireActionChipClick(info) {
  try {
    if (typeof _actionChipClickEventFire === "function") {
      _actionChipClickEventFire(info);
    }
  } catch (_) {}
}
let _snippetsNeededEventLogCount = 0;
const _snippetsNeededEventLogMax = 20;
const _pendingSnippetNeedsMax = 500; // Cap to avoid memory bloat

// Diagnostics for pending needs
let _pendingNeedsDiagLogCount = 0;
const _pendingNeedsDiagLogMax = 30;

function _addPendingSnippetNeed(hdrKey) {
  if (!hdrKey) return;
  
  const wasNew = !_pendingSnippetNeeds.has(hdrKey);
  
  // Cap the pending set size to avoid memory bloat on very long scroll sessions
  if (_pendingSnippetNeeds.size >= _pendingSnippetNeedsMax) {
    // Remove oldest entry (first in Set)
    const first = _pendingSnippetNeeds.values().next().value;
    if (first) _pendingSnippetNeeds.delete(first);
  }
  
  _pendingSnippetNeeds.add(hdrKey);
  
  // Log when adding new needs
  if (wasNew && _pendingNeedsDiagLogCount < _pendingNeedsDiagLogMax) {
    _pendingNeedsDiagLogCount++;
    console.log(`${LOG_PREFIX_MLCV}[PendingDiag] _addPendingSnippetNeed:`, {
      hdrKey: hdrKey?.slice(0, 50),
      pendingSetSize: _pendingSnippetNeeds.size,
      timerActive: !!_pendingNeedsDebounceTimer,
    });
  }
  
  // Debounce firing the event to batch requests
  // Use XPCOM timer for privileged code (setTimeout may not work reliably)
  if (_snippetsNeededEventFire && !_pendingNeedsDebounceTimer) {
    try {
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.initWithCallback({
        notify() {
          _pendingNeedsDebounceTimer = null;
          // Don't clear here - let getNeeds() drain the set
          // This avoids race conditions where user scrolls away before getNeeds() runs
          if (_pendingSnippetNeeds.size > 0) {
            const count = _pendingSnippetNeeds.size;
            try {
              if (_snippetsNeededEventLogCount < _snippetsNeededEventLogMax) {
                _snippetsNeededEventLogCount++;
                console.log(`${LOG_PREFIX_MLCV} Firing onSnippetsNeeded event, count:`, count);
              }
              _snippetsNeededEventFire({ count });
            } catch (e) {
              console.error(`${LOG_PREFIX_MLCV} Failed to fire onSnippetsNeeded event:`, e);
            }
          }
        }
      }, 10, Ci.nsITimer.TYPE_ONE_SHOT); // 10ms debounce
      _pendingNeedsDebounceTimer = timer;
    } catch (e) {
      console.error(`${LOG_PREFIX_MLCV} Failed to create debounce timer:`, e);
    }
  }
}

// Drain pending needs set and return the hdrKeys
let _drainDiagLogCount = 0;
const _drainDiagLogMax = 20;

function _drainPendingSnippetNeeds(max = 50) {
  const sizeBefore = _pendingSnippetNeeds.size;
  const result = [];
  for (const hdrKey of _pendingSnippetNeeds) {
    if (result.length >= max) break;
    result.push(hdrKey);
  }
  // Remove the ones we're returning
  for (const k of result) {
    _pendingSnippetNeeds.delete(k);
  }
  
  // Log drain operation
  if (_drainDiagLogCount < _drainDiagLogMax) {
    _drainDiagLogCount++;
    console.log(`${LOG_PREFIX_MLCV}[SnippetDiag] drainPending:`, {
      sizeBefore,
      drained: result.length,
      sizeAfter: _pendingSnippetNeeds.size,
      sample: result.slice(0, 3).map(k => k?.slice(0, 40)),
    });
  }
  
  return result;
}

function _clearPendingSnippetNeeds() {
  _pendingSnippetNeeds.clear();
}

const CARD_SENDER_CONFIG_MLCV = {
  logPrefix: `${LOG_PREFIX_MLCV}[CardSender]`,
  className: "tm-card-sender",
  maxLogs: 10,
  stripEmail: true, // Strip email from sender display (show name only)
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════

var tmMessageListCardView = class extends ExtensionCommon_MLCV.ExtensionAPI {
  onShutdown(isAppShutdown) {
    console.log(`${LOG_PREFIX_MLCV} onShutdown() called by Thunderbird, isAppShutdown:`, isAppShutdown);
    try {
      if (this._tmCleanup) {
        this._tmCleanup();
        console.log(`${LOG_PREFIX_MLCV} ✓ Cleanup completed via onShutdown`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX_MLCV} onShutdown cleanup failed:`, e);
    }
  }

  getAPI(context) {
    let windowListenerId = null;
    let isInitialized = false;

    // Set up event firing for onSnippetsNeeded
    // This allows MV3 to subscribe and be notified when snippets are needed
    _snippetsNeededEventFire = (info) => {
      try {
        context.extension.emit("onSnippetsNeeded", info);
      } catch (_) {}
    };

    // Set up event firing for onActionChipClick
    // Triggered when the user clicks the iOS-style action chip on a card row.
    _actionChipClickEventFire = (info) => {
      try {
        context.extension.emit("onActionChipClick", info);
      } catch (_) {}
    };

    const CARD_VIEW_ROW_COUNT_PREF = "mail.threadpane.cardsview.rowcount";
    const CARD_VIEW_ROW_COUNT_FOR_SNIPPETS = 3;
    // Class added to threadTree when in compact (2-row) mode
    const COMPACT_MODE_CLASS = "cards-row-compact";

    function _getCardViewRowCount() {
      try {
        return ServicesCS.prefs.getIntPref(CARD_VIEW_ROW_COUNT_PREF);
      } catch (_) {
        return 2;
      }
    }

    /**
     * Check if any visible thread tree is in 3-row mode (not compact).
     * This is more reliable than checking prefs because it reflects actual DOM state.
     */
    function _isAnyTreeIn3RowMode() {
      try {
        const enumWin = ServicesCS.wm.getEnumerator("mail:3pane");
        while (enumWin.hasMoreElements()) {
          const win = enumWin.getNext();
          const docs = enumerateContentDocs(win);
          for (const doc of docs) {
            if (!doc) continue;
            const tree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
            if (!tree) continue;
            // If tree does NOT have .cards-row-compact, it's in 3-row mode
            if (!tree.classList?.contains(COMPACT_MODE_CLASS)) {
              return true;
            }
          }
        }
      } catch (_) {}
      return false;
    }

    /**
     * Check if a specific document's thread tree is in 3-row mode.
     */
    function _isDocIn3RowMode(doc) {
      try {
        if (!doc) return false;
        const tree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
        if (!tree) return false;
        // If tree does NOT have .cards-row-compact, it's in 3-row mode
        return !tree.classList?.contains(COMPACT_MODE_CLASS);
      } catch (_) {
        return false;
      }
    }

    let _snippetForceDisableLogged = false;
    function _snippetsContentEnabled() {
      if (CARD_SNIPPET_CONFIG_MLCV.forceDisableInjection === true) {
        if (!_snippetForceDisableLogged) {
          _snippetForceDisableLogged = true;
          console.log(`${CARD_SNIPPET_CONFIG_MLCV.logPrefix} FORCE DISABLED: snippet fetch/injection is disabled for debugging`);
        }
        return false;
      }
      // Check actual DOM state rather than pref - more reliable
      return _isAnyTreeIn3RowMode();
    }
    
    /**
     * Check if snippets are enabled for a specific document.
     */
    function _snippetsEnabledForDoc(doc) {
      if (CARD_SNIPPET_CONFIG_MLCV.forceDisableInjection === true) return false;
      return _isDocIn3RowMode(doc);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    function isBusy(doc) {
      try {
        return doc?.documentElement?.hasAttribute("data-tm-sort-busy");
      } catch {
        return false;
      }
    }

    function isCardView(cdoc) {
      return !!(cdoc.querySelector("mail-message-list") || cdoc.querySelector('[is="thread-card"]'));
    }

    function enumerateContentDocs(win) {
      const docs = [];
      try {
        const tabmail = win.document.getElementById("tabmail");
        const about3Pane = tabmail?.currentAbout3Pane || tabmail?.currentTabInfo?.chromeBrowser?.contentWindow || null;
        if (about3Pane?.document) docs.push(about3Pane.document);
        const numTabs = tabmail?.tabInfo?.length || 0;
        for (let i = 0; i < numTabs; i++) {
          try {
            const info = tabmail.tabInfo[i];
            const cw = info?.chromeBrowser?.contentWindow || info?.browser?.contentWindow || null;
            if (cw?.document && !docs.includes(cw.document)) docs.push(cw.document);
          } catch (_) {}
        }
      } catch (_) {}
      return docs;
    }

    function getCurrentContentWin(win) {
      try {
        const tabmail = win?.document?.getElementById?.("tabmail");
        return tabmail?.currentAbout3Pane || tabmail?.currentTabInfo?.chromeBrowser?.contentWindow || tabmail?.currentTabInfo?.browser?.contentWindow || null;
      } catch (_) {
        return null;
      }
    }

    let snippetDiagCount = 0;
    const SNIPPET_DIAG_MAX = 8;

    function getHdrKey(hdr) {
      try {
        const folderUri = String(hdr?.folder?.URI || hdr?.folder?.uri || "");
        const msgKey = Number.isFinite(hdr?.messageKey) ? String(hdr.messageKey) : "";
        const mid = String(hdr?.messageId || "");
        const idPart = msgKey || mid;
        if (!folderUri || !idPart) return "";
        return `${folderUri}::${idPart}`;
      } catch (_) {
        return "";
      }
    }

    function _rowIndexFromRowId(rowId) {
      try {
        const m = String(rowId || "").match(/threadTree-row(\d+)/);
        if (!m) return -1;
        const n = parseInt(m[1], 10);
        return Number.isFinite(n) ? n : -1;
      } catch (_) {
        return -1;
      }
    }

    function _getHdrForRowIndex(tree, rowIndex) {
      try {
        let hdr = null;
        try { if (typeof tree?.view?.getMsgHdrAt === "function") hdr = tree.view.getMsgHdrAt(rowIndex); } catch(_) {}
        if (!hdr) { try { if (typeof tree?.view?.getMessageHdrAt === "function") hdr = tree.view.getMessageHdrAt(rowIndex); } catch(_) {} }
        if (!hdr) { try { if (typeof tree?.view?.dbView?.hdrForRow === "function") hdr = tree.view.dbView.hdrForRow(rowIndex); } catch(_) {} }
        return hdr || null;
      } catch (_) {
        return null;
      }
    }

    function _safeText(s) {
      try {
        return String(s || "").replace(/\s+/g, " ").trim();
      } catch (_) {
        return "";
      }
    }

    // Snippets are always sourced from our own provider (cardSnippetProvider).
    // TB's native preview/snippet/summary mork properties are never trusted —
    // TB's preview generator can leave Content-Transfer-Encoding: base64 parts
    // undecoded, causing the card row to display raw base64 instead of text.

    // _extractAuthorNeedles and _elementDepthWithin removed - only used by removed _applySenderScaleToRow

    function findSnippetHost(row, hdr) {
      // Return .thread-card-dynamic-row - insert before .thread-card-icon-info
      try {
        const dynamicRow = row.querySelector?.(".thread-card-dynamic-row") || null;
        if (dynamicRow) return dynamicRow;
      } catch (_) {}
      try {
        const container = row.querySelector?.(".card-container") || null;
        if (container) return container;
      } catch (_) {}
      return null;
    }

    function findSubjectElement(row, hdr) {
      for (const sel of CARD_SNIPPET_CONFIG_MLCV.subjectSelectors) {
        try {
          const el = row.querySelector(sel);
          if (el) return el;
        } catch (_) {}
      }
      const container = row.querySelector(".card-container");
      if (container) {
        for (const sel of CARD_SNIPPET_CONFIG_MLCV.subjectSelectors) {
          try {
            const el = container.querySelector(sel);
            if (el) return el;
          } catch (_) {}
        }
      }
      return null;
    }

    // _applySenderScaleToRow removed - replaced by _applyZeroFlickerEnhancements in fillRow patch

    // ═══════════════════════════════════════════════════════════════════════
    // TabMail action paint (Phase 3)
    //
    // Reads `tm-action` mork string property from the hdr (written by
    // actionCache → tmHdr.setAction). Applies a tm-action-<name> class on
    // the card row, sets `--tag-color` inline var, and injects/updates
    // a chip element. Legacy tm_* keyword fallback for pre-backfill data.
    // ═══════════════════════════════════════════════════════════════════════

    const TM_ACTION_PROP_NAME_MLCV = "tm-action";
    const TM_ACTION_CLASSES_MLCV = [
      "tm-action-reply",
      "tm-action-archive",
      "tm-action-delete",
      "tm-action-none",
    ];
    const _ACTION_TO_KEYWORD_MLCV = {
      reply: "tm_reply",
      archive: "tm_archive",
      delete: "tm_delete",
      none: "tm_none",
    };
    const _KEYWORD_TO_ACTION_MLCV = {
      tm_reply: "reply",
      tm_archive: "archive",
      tm_delete: "delete",
      tm_none: "none",
    };
    const _ACTION_LABELS_MLCV = {
      reply: "Reply",
      archive: "Archive",
      delete: "Delete",
      none: "None",
    };
    // Keep priority order consistent with tagSort / tmMessageListTableView.
    const TM_ACTION_PRIORITY_MLCV = ["reply", "none", "archive", "delete"];

    // @deprecated The IMAP-keyword (`tm_*`) representation of action state
    // is no longer written by TabMail (Phase 0; see
    // agent/modules/tagHelper.js header). New surfaces (tmMultiMessageChip)
    // skip this fallback. It survives here for legacy messages tagged
    // before Phase 0; remove once those have decayed out of users' inboxes.
    function _actionFromKeywords_MLCV(hdr) {
      try {
        const kw = hdr?.getStringProperty?.("keywords") || "";
        if (!kw) return null;
        const keys = kw.split(/\s+/).filter(Boolean);
        for (const a of TM_ACTION_PRIORITY_MLCV) {
          const k = _ACTION_TO_KEYWORD_MLCV[a];
          if (k && keys.includes(k)) return a;
        }
        return null;
      } catch (_) {
        return null;
      }
    }

    function _lookupActionForCard_MLCV(hdr) {
      try {
        const prop = hdr?.getStringProperty?.(TM_ACTION_PROP_NAME_MLCV) || "";
        if (prop) return String(prop);
      } catch (_) {}
      return _actionFromKeywords_MLCV(hdr);
    }

    /**
     * For a card row, return the action + source hdr to paint on it.
     *
     * - Non-container rows or expanded thread parents: parent's own action +
     *   parent hdr (children paint themselves when expanded).
     * - Collapsed thread parents: walk all children of the parent's
     *   nsIMsgThread, pick the one whose action has the highest priority
     *   per `TM_ACTION_PRIORITY_MLCV`. The source hdr is the message that
     *   actually owns the action — passed to the chip painter so a click on
     *   the parent's aggregated chip applies the action to that specific
     *   child message, not to the thread root.
     *
     * If no child has an action, fall back to the parent's own action.
     */
    function _aggregateActionForThread_MLCV(tree, rowIndex, parentHdr) {
      const fallback = {
        action: _lookupActionForCard_MLCV(parentHdr),
        sourceHdr: parentHdr,
      };
      try {
        const dbView = tree?.view?.dbView;
        if (!dbView) return fallback;
        const isContainer = typeof dbView.isContainer === "function"
          ? dbView.isContainer(rowIndex)
          : false;
        if (!isContainer) return fallback;
        const isOpen = typeof dbView.isContainerOpen === "function"
          ? dbView.isContainerOpen(rowIndex)
          : false;
        if (isOpen) return fallback; // children paint themselves
        if (typeof dbView.getThreadContainingIndex !== "function") return fallback;
        const thread = dbView.getThreadContainingIndex(rowIndex);
        const numChildren = thread?.numChildren | 0;
        if (numChildren <= 1) return fallback;

        let best = null;
        let bestRank = TM_ACTION_PRIORITY_MLCV.length;
        let bestHdr = null;
        for (let i = 0; i < numChildren; i++) {
          let childHdr = null;
          try { childHdr = thread.getChildHdrAt(i); } catch (_) {}
          if (!childHdr) continue;
          const a = _lookupActionForCard_MLCV(childHdr);
          if (!a) continue;
          const rank = TM_ACTION_PRIORITY_MLCV.indexOf(a);
          if (rank < 0) continue;
          // `<=` so when multiple children share the top priority, the LATER
          // one wins (children are stored oldest-first in nsIMsgThread, so
          // this picks the most recent message — the right reply target).
          if (rank <= bestRank) {
            best = a;
            bestRank = rank;
            bestHdr = childHdr;
          }
        }
        if (best && bestHdr) {
          return { action: best, sourceHdr: bestHdr };
        }
        return fallback;
      } catch (_) {
        return fallback;
      }
    }

    /**
     * Return the total number of messages in the thread containing `rowIndex`
     * (1 for non-thread rows, `numChildren` for thread parents — includes the
     * head message itself, matching iOS's `threadInfo.memberCount`).
     *
     * DOM-first: the row's `.children` class is the authoritative
     * "is-a-thread-parent" signal (TB's tree-view.mjs sets it from
     * `view.isContainer(index)`). Once we know it's a thread, we try
     * multiple APIs to read the count, falling back to parsing TB's
     * `.thread-replies` l10n text — and finally to `2` so at minimum we
     * always show a badge on confirmed-thread rows.
     */
    function _getThreadTotalCount_MLCV(tree, rowIndex, row) {
      try {
        const isThreadParent = row?.classList?.contains?.("children");
        if (!isThreadParent) return 1;

        // 1) nsIMsgDBView path (preferred — exact thread count).
        const dbView = tree?.view?.dbView;
        if (dbView && typeof dbView.getThreadContainingIndex === "function") {
          try {
            const thread = dbView.getThreadContainingIndex(rowIndex);
            const n = thread?.numChildren | 0;
            if (n > 1) return n;
          } catch (_) {}
        }

        // 2) Wrapper view fallback (some TB views proxy these methods at
        //    the JS wrapper level).
        const view = tree?.view;
        if (view && typeof view.getThreadContainingIndex === "function") {
          try {
            const thread = view.getThreadContainingIndex(rowIndex);
            const n = thread?.numChildren | 0;
            if (n > 1) return n;
          } catch (_) {}
        }

        // 3) Read TB's own .thread-replies element. TB l10n's it with
        //    `data-l10n-args='{"count":N}'` where N is replies (total - 1).
        try {
          const repliesEl = row.querySelector?.(".thread-replies");
          const args = repliesEl?.getAttribute?.("data-l10n-args") || "";
          const m = args.match(/"count"\s*:\s*(\d+)/);
          if (m) return parseInt(m[1], 10) + 1;
          const text = (repliesEl?.textContent || "").trim();
          const m2 = text.match(/(\d+)/);
          if (m2) return parseInt(m2[1], 10) + 1;
        } catch (_) {}

        // Confirmed-thread fallback — at least 2 messages.
        return 2;
      } catch (_) {
        return 1;
      }
    }

    function _colorForAction_MLCV(action) {
      // MailServices.tags.getColorForKey reads the registered tag def color
      // (set by ensureActionTags with palette values). Single source of truth
      // for visible action color across table + card views.
      const key = _ACTION_TO_KEYWORD_MLCV[action];
      if (!key) return null;
      try { return MailServices_MLCV?.tags?.getColorForKey?.(key) || null; }
      catch (_) { return null; }
    }

    const CHIP_CLASS_MLCV = "tm-action-chip";

    /**
     * Inject or update the iOS-style action chip inside the card.
     * Placed just after `.button-star` so it sits in the bottom-right
     * of the card, mirroring the iOS app's layout.
     *
     * Idempotent: if the chip already exists with the correct class/text,
     * leave it alone. Re-inserting on every fillRow caused a layout blink
     * on selection (fillRow fires on state changes → chip briefly absent
     * → content height shifts → chip re-appears → shifts back).
     *
     * Click behavior: the click handler explicitly selects the chip's row
     * via `tree.view.selection.select(rowIndex)` (TB's mousedown selection
     * doesn't fire reliably for spans inside a card), then emits
     * `onActionChipClick`. MV3 then runs the *exact* Tab-key pathway:
     * `mailTabs.getSelectedMessages` → `performTaggedAction` for each.
     */
    function _paintChipOnCard_MLCV(cardRow, action, doc, hdr) {
      try {
        if (!cardRow || !doc) return;
        const existing = cardRow.querySelector?.(`.${CHIP_CLASS_MLCV}`);

        if (!action) {
          if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
          return;
        }

        const label = _ACTION_LABELS_MLCV[action];
        if (!label) {
          if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
          return;
        }
        const expectedCls = `${CHIP_CLASS_MLCV} tm-action-${action}`;

        if (existing) {
          if (existing.className !== expectedCls) existing.className = expectedCls;
          if (existing.textContent !== label) existing.textContent = label;
          return;
        }

        const chip = doc.createElement("span");
        chip.className = expectedCls;
        chip.textContent = label;
        try { chip.setAttribute("role", "button"); } catch (_) {}
        try { chip.setAttribute("tabindex", "0"); } catch (_) {}
        try { chip.setAttribute("title", `${label} — click to apply`); } catch (_) {}
        // No per-chip click listeners — clicks are dispatched by the
        // document-level delegated handler installed via
        // `attachChipDelegation_MLCV` (see init/cleanup wiring). Per-chip
        // listeners would otherwise become stale on hot-reload because
        // they close over the OLD module's `_actionChipClickEventFire`,
        // which can no longer reach MV3 once the OLD context is shut down.

        const star = cardRow.querySelector?.(".button-star");
        if (star && star.parentNode) {
          if (star.nextSibling) star.parentNode.insertBefore(chip, star.nextSibling);
          else star.parentNode.appendChild(chip);
          return;
        }
        const host = cardRow.querySelector?.(".thread-card-icon-info")
          || cardRow.querySelector?.(".thread-card-subject-container")
          || cardRow.querySelector?.(".thread-card-dynamic-row")
          || cardRow.querySelector?.(".card-container")
          || cardRow;
        if (host) host.appendChild(chip);
      } catch (_) {}
    }

    function _paintCardForAction_MLCV(cardRow, action, doc, hdr) {
      if (!cardRow) return;
      try {
        // Idempotent class update: only touch classList if the action changed.
        const expectedCls = action ? `tm-action-${action}` : "";
        let currentCls = "";
        for (const cls of TM_ACTION_CLASSES_MLCV) {
          if (cardRow.classList?.contains(cls)) { currentCls = cls; break; }
        }
        if (currentCls !== expectedCls) {
          if (currentCls) cardRow.classList.remove(currentCls);
          if (expectedCls && TM_ACTION_CLASSES_MLCV.includes(expectedCls)) {
            cardRow.classList.add(expectedCls);
          }
        }

        // Idempotent --tag-color update.
        const color = action ? _colorForAction_MLCV(action) : null;
        const currentColor = cardRow.style?.getPropertyValue?.("--tag-color") || "";
        if (color) {
          if (currentColor !== color) cardRow.style.setProperty("--tag-color", color);
        } else if (currentColor) {
          cardRow.style.removeProperty("--tag-color");
        }

        _paintChipOnCard_MLCV(cardRow, action, doc, hdr);
      } catch (_) {}
    }

    // ───── Chip click delegation ─────
    // One handler at the document level (capture phase, with stopPropagation)
    // catches every chip click regardless of when the chip was painted. This
    // survives hot-reload: an OLD module's stale per-chip listener cannot
    // reach the NEW context, but the NEW capture-phase delegated handler
    // fires first and short-circuits the event before any stale listener
    // gets a turn.
    //
    // Stored on the doc itself (not in a module-scoped Map) so the NEW
    // module can find and detach the OLD module's listener after a hot
    // reload — the OLD module's WeakMap is gone but the doc property is
    // a primitive function reference that survives.
    const CHIP_DELEGATION_PROP_CLICK = "__tmActionChipDelegationClick";
    const CHIP_DELEGATION_PROP_KEYDOWN = "__tmActionChipDelegationKeydown";
    const CHIP_DELEGATION_PROP_MOUSEDOWN = "__tmActionChipDelegationMousedown";

    function _activateChipFromEvent_MLCV(e, source) {
      try {
        const chip = e.target?.closest?.(`.${CHIP_CLASS_MLCV}`);
        if (!chip) return false;
        try { e.stopPropagation(); } catch (_) {}
        try { e.preventDefault(); } catch (_) {}
        // Resolve the chip's row, programmatically select it (TB's row
        // mousedown selection isn't reliably triggered by clicks on a
        // child span), then fire the event MV3 listens to.
        try {
          const ownerDoc = chip.ownerDocument;
          const rowEl = chip.closest?.('[is="thread-card"]');
          const rowIndex = _rowIndexFromRowId(rowEl?.id || "");
          if (rowIndex >= 0) {
            const tree = ownerDoc?.getElementById?.("threadTree")
              || ownerDoc?.querySelector?.("tree-view#threadTree, tree-view");
            const sel = tree?.view?.selection;
            if (sel?.select) {
              try { sel.select(rowIndex); } catch (_) {}
            }
          }
        } catch (_) {}
        _fireActionChipClick({ source });
        return true;
      } catch (_) {
        return false;
      }
    }

    function attachChipDelegation_MLCV(doc) {
      try {
        if (!doc) return;
        // Detach any existing delegation (e.g. from a previous module
        // instance after hot reload) so we don't double-fire.
        detachChipDelegation_MLCV(doc);

        const onMousedown = (e) => {
          // Stop mousedown from reaching TB's row handler so it doesn't
          // race with our explicit selection in the click activate path.
          try {
            const chip = e.target?.closest?.(`.${CHIP_CLASS_MLCV}`);
            if (chip) e.stopPropagation();
          } catch (_) {}
        };
        const onClick = (e) => { _activateChipFromEvent_MLCV(e, "click"); };
        const onKeydown = (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          _activateChipFromEvent_MLCV(e, "keydown");
        };

        doc.addEventListener("mousedown", onMousedown, true);
        doc.addEventListener("click", onClick, true);
        doc.addEventListener("keydown", onKeydown, true);
        doc[CHIP_DELEGATION_PROP_MOUSEDOWN] = onMousedown;
        doc[CHIP_DELEGATION_PROP_CLICK] = onClick;
        doc[CHIP_DELEGATION_PROP_KEYDOWN] = onKeydown;
      } catch (e) {
        console.error(`${LOG_PREFIX_MLCV} attachChipDelegation failed:`, e);
      }
    }

    function detachChipDelegation_MLCV(doc) {
      try {
        if (!doc) return;
        const prevMousedown = doc[CHIP_DELEGATION_PROP_MOUSEDOWN];
        const prevClick = doc[CHIP_DELEGATION_PROP_CLICK];
        const prevKeydown = doc[CHIP_DELEGATION_PROP_KEYDOWN];
        if (prevMousedown) {
          try { doc.removeEventListener("mousedown", prevMousedown, true); } catch (_) {}
        }
        if (prevClick) {
          try { doc.removeEventListener("click", prevClick, true); } catch (_) {}
        }
        if (prevKeydown) {
          try { doc.removeEventListener("keydown", prevKeydown, true); } catch (_) {}
        }
        try { delete doc[CHIP_DELEGATION_PROP_MOUSEDOWN]; } catch (_) {}
        try { delete doc[CHIP_DELEGATION_PROP_CLICK]; } catch (_) {}
        try { delete doc[CHIP_DELEGATION_PROP_KEYDOWN]; } catch (_) {}
      } catch (e) {
        console.error(`${LOG_PREFIX_MLCV} detachChipDelegation failed:`, e);
      }
    }

    /**
     * Strip email address from sender text, leaving only the name.
     * "Siddharth Haldar <email@example.com>" -> "Siddharth Haldar"
     */
    function _stripEmailFromSender(text) {
      if (!text) return text;
      // Match "Name <email>" pattern and extract just the name
      const match = text.match(/^([^<]+)\s*<[^>]+>\s*$/);
      if (match && match[1]) {
        return match[1].trim();
      }
      return text;
    }

    /**
     * Apply sender name stripping and snippet injection to a row.
     * Called from prototype patch for zero-flicker rendering.
     */
    let _zeroFlickerLogCount = 0;
    const _zeroFlickerLogMax = 10;

    function _applyZeroFlickerEnhancements(row, tree, doc) {
      try {
        if (!row || !tree || !doc) return;
        if (row.getAttribute?.("is") !== "thread-card") return;

        // Get row index and message header
        const rowIndex = (() => {
          const m = String(row.id || "").match(/threadTree-row(\d+)/);
          if (!m) return -1;
          return parseInt(m[1], 10);
        })();
        if (rowIndex < 0) return;

        const hdr = _getHdrForRowIndex(tree, rowIndex);
        if (!hdr) return;
        const hdrKey = getHdrKey(hdr);

        // Debug logging (limited)
        if (_zeroFlickerLogCount < _zeroFlickerLogMax) {
          _zeroFlickerLogCount++;
          const sender = row.querySelector?.(".sender");
          console.log(`${CARD_SENDER_CONFIG_MLCV.logPrefix} _applyZeroFlickerEnhancements called:`, {
            rowId: row.id,
            rowIndex,
            hdrKey: hdrKey?.slice(0, 40),
            senderFound: !!sender,
            senderText: sender?.textContent?.slice(0, 40),
            stripEmailEnabled: CARD_SENDER_CONFIG_MLCV.stripEmail,
          });
        }

        // 0. Paint from TabMail action: class + `--tag-color` + iOS chip.
        //    Reads `tm-action` hdr string property (written by actionCache
        //    via tmHdr.setAction). For collapsed thread parents the action
        //    is aggregated across the thread's children (highest priority
        //    wins) so the head row inherits the strongest hint — mirrors
        //    iOS `threadInfo.threadTag`. The chip's click target is the
        //    SOURCE child hdr so applying e.g. "Reply" replies to the
        //    actual message that earned the tag, not the thread root.
        try {
          const { action, sourceHdr } = _aggregateActionForThread_MLCV(tree, rowIndex, hdr);
          _paintCardForAction_MLCV(row, action, doc, sourceHdr);
        } catch (_) {}

        // 1. Strip email from sender (zero-flicker)
        const ZERO_FLICKER_SENDER_ENABLED = true;
        if (ZERO_FLICKER_SENDER_ENABLED && CARD_SENDER_CONFIG_MLCV.stripEmail) {
          const sender = row.querySelector?.(".sender");
          if (sender) {
            const rawText = sender.textContent || "";
            const nameOnly = _stripEmailFromSender(rawText);
            if (nameOnly && nameOnly !== rawText) {
              sender.textContent = nameOnly;
            }
            // Also strip from title attribute
            const rawTitle = sender.getAttribute?.("title") || "";
            const titleNameOnly = _stripEmailFromSender(rawTitle);
            if (titleNameOnly && titleNameOnly !== rawTitle) {
              try { sender.setAttribute("title", titleNameOnly); } catch (_) {}
            }
            // Add styling class (idempotent)
            sender.classList.add(CARD_SENDER_CONFIG_MLCV.className);
            try { sender.setAttribute("data-tm-hdr-key", hdrKey || ""); } catch (_) {}
          }
        }

        // 1b. Inject the thread-member count badge as the LAST child of
        //     `.sender`, so it flows inline with the sender's text — sits
        //     right against the name with a small gap, instead of being
        //     pushed to the right edge of `.sender`'s flex:1 box (where it
        //     would land near the date/kebab and visually disconnect from
        //     the name). Shown ONLY when the row is a thread parent that
        //     is currently COLLAPSED — when expanded, the children are
        //     visible as their own rows and the badge would be redundant.
        //     Counts the head message itself, matching iOS
        //     `threadInfo.memberCount`. Idempotent: TB's fillRow assigns
        //     `.sender.textContent`, which wipes children — we re-append
        //     here on every render.
        try {
          const senderForCount = row.querySelector?.(".sender");
          if (senderForCount) {
            const isThreadParent = row.classList?.contains?.("children");
            const isCollapsed = row.classList?.contains?.("collapsed");
            const showBadge = isThreadParent && isCollapsed;
            let countEl = senderForCount.querySelector?.(".tm-thread-count");
            if (showBadge) {
              const total = _getThreadTotalCount_MLCV(tree, rowIndex, row);
              if (total > 1) {
                const text = String(total);
                if (!countEl || !countEl.isConnected) {
                  countEl = doc.createElement("span");
                  countEl.className = "tm-thread-count";
                  countEl.textContent = text;
                  senderForCount.appendChild(countEl);
                } else if (countEl.textContent !== text) {
                  countEl.textContent = text;
                }
              } else if (countEl && countEl.parentNode) {
                countEl.parentNode.removeChild(countEl);
              }
            } else if (countEl && countEl.parentNode) {
              countEl.parentNode.removeChild(countEl);
            }
          }
        } catch (_) {}

        // 2. Inject snippet if cached in experiment memory (zero-flicker, instant)
        const ZERO_FLICKER_SNIPPETS_ENABLED = true;
        if (ZERO_FLICKER_SNIPPETS_ENABLED && _snippetsEnabledForDoc(doc)) {
          const snippet = _getSnippetFromMemoryCache(hdrKey);
          if (snippet) {
            const host = findSnippetHost(row, hdr);
            if (host) {
              let el = host.querySelector?.(`.${CARD_SNIPPET_CONFIG_MLCV.className}`) || null;
              if (!el || !el.isConnected) {
                el = doc.createElement("div");
                el.className = CARD_SNIPPET_CONFIG_MLCV.className;
                try { el.setAttribute("data-tm-hdr-key", hdrKey || ""); } catch (_) {}
                const text = snippet.length > CARD_SNIPPET_CONFIG_MLCV.maxChars
                  ? snippet.slice(0, CARD_SNIPPET_CONFIG_MLCV.maxChars).trim()
                  : snippet;
                el.textContent = text;
                try {
                  const iconInfo = host.querySelector?.(".thread-card-icon-info") || null;
                  if (iconInfo) {
                    // Wrap snippet + icon-info in a flex container so the snippet
                    // fills remaining space and icons stay at the bottom-right
                    let wrapper = host.querySelector?.(".tm-card-snippet-wrapper") || null;
                    if (!wrapper) {
                      wrapper = doc.createElement("div");
                      wrapper.className = "tm-card-snippet-wrapper";
                      host.insertBefore(wrapper, iconInfo);
                      wrapper.appendChild(iconInfo); // Float target must precede text
                      wrapper.appendChild(el);
                    } else {
                      wrapper.appendChild(el); // Append after floated icon-info
                    }
                  } else {
                    host.appendChild(el);
                  }
                } catch (_) {}
              } else {
                // Update existing element if hdrKey changed (recycled row)
                const oldKey = el.getAttribute?.("data-tm-hdr-key") || "";
                if (oldKey !== hdrKey) {
                  try { el.setAttribute("data-tm-hdr-key", hdrKey || ""); } catch (_) {}
                  const text = snippet.length > CARD_SNIPPET_CONFIG_MLCV.maxChars
                    ? snippet.slice(0, CARD_SNIPPET_CONFIG_MLCV.maxChars).trim()
                    : snippet;
                  try { el.textContent = text; } catch (_) {}
                }
              }
            }
          } else {
            // Cache miss - if the row was recycled from a different message,
            // clear the stale snippet text so the previous message's preview
            // doesn't bleed onto this card while we wait for the async fetch.
            try {
              const host = findSnippetHost(row, hdr);
              const el = host?.querySelector?.(`.${CARD_SNIPPET_CONFIG_MLCV.className}`) || null;
              if (el && el.isConnected) {
                const oldKey = el.getAttribute?.("data-tm-hdr-key") || "";
                if (oldKey !== hdrKey) {
                  try { el.setAttribute("data-tm-hdr-key", hdrKey || ""); } catch (_) {}
                  try { el.textContent = ""; } catch (_) {}
                }
              }
            } catch (_) {}
            _addPendingSnippetNeed(hdrKey);
          }
        }

        // 3. Relocate the thread-expand twisty (.thread-card-button) from the
        //    second-row .thread-card-dynamic-row (where TB places it next to
        //    .sort-header-details and the subject/icon-info — the same grid row
        //    our snippet wrapper occupies, causing visual overlap of "1 reply ⌄"
        //    on top of the snippet text) into the first-row .thread-card-row,
        //    immediately after the kebab `.tree-button-more`. Click delegation
        //    in tree-view.mjs uses `event.target.closest(".twisty")` and the
        //    nearest ancestor `<tr>`, so the button stays functional after the
        //    move. Idempotent: skips if already in the top row.
        try {
          const button = row.querySelector?.(".thread-card-button");
          const topRow = row.querySelector?.(".thread-card-row");
          if (button && topRow && button.parentElement !== topRow) {
            const moreButton = topRow.querySelector?.(".tree-button-more");
            if (moreButton && moreButton.nextSibling) {
              topRow.insertBefore(button, moreButton.nextSibling);
            } else if (moreButton) {
              topRow.appendChild(button);
            } else {
              topRow.appendChild(button);
            }
          }
        } catch (_) {}
      } catch (e) {
        // Silent fail to avoid breaking TB rendering
      }
    }

    /**
     * Patch the ThreadCard custom element prototype to enable zero-flicker enhancements.
     * This patches the `fillRow` method which is called when TB populates a card.
     */
    // MASTER SWITCH: Set to false to completely disable prototype patching
    const PROTOTYPE_PATCH_ENABLED = true;

    function patchThreadCardPrototype(doc) {
      try {
        // If patching is disabled, skip entirely
        if (!PROTOTYPE_PATCH_ENABLED) {
          return false;
        }
        if (!doc?.defaultView) {
          return false;
        }
        const win = doc.defaultView;
        
        const customElementsRegistry = win.customElements;
        if (!customElementsRegistry) {
          return false;
        }

        // Try to get the ThreadCard class
        let ThreadCard = customElementsRegistry.get?.("thread-card");

        if (!ThreadCard) {
          // Try to find an existing thread-card element and get its constructor
          const existingCard = doc.querySelector?.('[is="thread-card"]');
          if (existingCard) {
            ThreadCard = existingCard.constructor;
          }
        }

        if (!ThreadCard) {
          return false;
        }

        // Ensure ROW_HEIGHT is patched every time (TB may reset it on view switches)
        if (CARD_ROW_HEIGHT_MLCV && ThreadCard.ROW_HEIGHT !== CARD_ROW_HEIGHT_MLCV) {
          if (!ThreadCard.__tmOrigRowHeight) ThreadCard.__tmOrigRowHeight = ThreadCard.ROW_HEIGHT;
          ThreadCard.ROW_HEIGHT = CARD_ROW_HEIGHT_MLCV;
          try {
            const threadTree = doc.getElementById("threadTree") ||
                              doc.querySelector("tree-view#threadTree, tree-view");
            if (threadTree?.reset) threadTree.reset();
          } catch (_) {}
        }

        const proto = ThreadCard.prototype;

        // Check for fillRow method (this is what TB uses to populate cards)
        if (typeof proto.fillRow !== "function") {
          console.log(`${CARD_SENDER_CONFIG_MLCV.logPrefix} ThreadCard.fillRow not found`);
          return false;
        }

        // Stash the PRISTINE TB fillRow exactly once. On hot-reload the OLD
        // module's wrapper is still installed at proto.fillRow; if we captured
        // from there we'd build a stack of wrappers, each closed over a dead
        // module's caches. Snapshot the pristine on first patch so all
        // subsequent patches re-wrap the same baseline.
        if (typeof ThreadCard.__tmOrigFillRow !== "function") {
          ThreadCard.__tmOrigFillRow = proto.fillRow;
        }
        const origFillRow = ThreadCard.__tmOrigFillRow;

        // Identity check: is the wrapper currently on the prototype OUR
        // wrapper from THIS module run? We tag each wrapper with a closure-
        // unique reference (`_applyZeroFlickerEnhancements` is defined inside
        // getAPI(), so each module instance has a distinct value). If the
        // current wrapper is from a previous module (e.g., onShutdown didn't
        // restore the prototype before reload), we must replace it — that
        // wrapper closes over a dead module's caches and emits events into a
        // dead extension context, so children of newly-expanded threads
        // never reach the live cardSnippetProvider.
        if (proto.fillRow?.__tmCardOwner === _applyZeroFlickerEnhancements) {
          return true; // already our exact wrapper
        }

        const newFillRow = function(index, row, dataset, view) {
          // Call original fillRow first (populates the card)
          origFillRow.call(this, index, row, dataset, view);

          // Apply zero-flicker enhancements
          try {
            const cardRow = this;
            const ownerDoc = cardRow.ownerDocument;
            const tree = ownerDoc?.getElementById?.("threadTree") ||
                        ownerDoc?.querySelector?.("tree-view#threadTree, tree-view");
            if (tree) {
              _applyZeroFlickerEnhancements(cardRow, tree, ownerDoc);
            }
          } catch (patchErr) {
            // Silent fail to avoid breaking TB rendering
          }
        };
        newFillRow.__tmCardOwner = _applyZeroFlickerEnhancements;
        proto.fillRow = newFillRow;

        ThreadCard.__tmPatched = true;
        console.log(`${CARD_SENDER_CONFIG_MLCV.logPrefix} ✓ ThreadCard.fillRow patched for zero-flicker`);
        return true;
      } catch (e) {
        console.error(`${CARD_SENDER_CONFIG_MLCV.logPrefix} patchThreadCardPrototype failed:`, e);
        return false;
      }
    }

    /**
     * Unpatch the ThreadCard prototype (for hot-reload cleanup).
     * Restores the pristine TB fillRow so the next patch (e.g., from a
     * fresh module after reload) re-wraps the same baseline rather than
     * stacking on top of our previous wrapper. `__tmOrigFillRow` is kept
     * on the constructor so a future patch can find it again — the
     * stash is class-static and outlives the module.
     */
    function unpatchThreadCardPrototype(doc) {
      try {
        if (!doc?.defaultView) return;
        const win = doc.defaultView;
        let ThreadCard = win.customElements?.get?.("thread-card");
        if (!ThreadCard) {
          const existingCard = doc.querySelector?.('[is="thread-card"]');
          if (existingCard) ThreadCard = existingCard.constructor;
        }
        if (!ThreadCard) return;
        // Restore original ROW_HEIGHT
        if (ThreadCard.__tmOrigRowHeight != null) {
          ThreadCard.ROW_HEIGHT = ThreadCard.__tmOrigRowHeight;
          delete ThreadCard.__tmOrigRowHeight;
          console.log(`${LOG_PREFIX_MLCV} Restored ThreadCard.ROW_HEIGHT to ${ThreadCard.ROW_HEIGHT}`);
          try {
            const threadTree = doc.getElementById("threadTree") ||
                              doc.querySelector("tree-view#threadTree, tree-view");
            if (threadTree?.reset) threadTree.reset();
          } catch (_) {}
        }
        // Restore pristine fillRow. Without this, the wrapper stays on the
        // prototype, holds a closure over this module's caches, and the
        // next patch from a fresh module wraps it again — building a stack.
        if (typeof ThreadCard.__tmOrigFillRow === "function") {
          try {
            ThreadCard.prototype.fillRow = ThreadCard.__tmOrigFillRow;
          } catch (_) {}
        }
        delete ThreadCard.__tmPatched;
        console.log(`${CARD_SENDER_CONFIG_MLCV.logPrefix} ThreadCard prototype unpatched (fillRow restored)`);
      } catch (e) {
        console.error(`${CARD_SENDER_CONFIG_MLCV.logPrefix} unpatchThreadCardPrototype failed:`, e);
      }
    }

    // applySnippetToRow and applySnippetsToDoc removed - replaced by:
    // 1. fillRow patch (_applyZeroFlickerEnhancements) for zero-flicker rendering
    // 2. provideCardSnippets for injecting snippets from MV3

    function attachCardSnippetObserver(doc) {
      // Legacy observer code removed - fillRow patch handles all rendering
      // This function is kept as a no-op for compatibility with callers
      // The fillRow patch (_applyZeroFlickerEnhancements) handles:
      // - Sender name stripping (zero-flicker)
      // - Snippet injection from memory cache (zero-flicker)
      // - Triggering fetch via pending needs for cache misses
    }

    function attachMessageListEventHooks(win, reason = "init") {
      try {
        if (!win) return;
        const tabmail = win.document.getElementById("tabmail");
        const contentWin = getCurrentContentWin(win);

        // Watch for "rows" attribute changes on threadTree (triage/card view button).
        // TB sets rows="thread-card" which triggers attributeChangedCallback → reset()
        // BEFORE any of our other event handlers fire. We must re-apply ROW_HEIGHT here.
        if (contentWin && !contentWin.__tmCardSnippetsRowsMO) {
          const innerDoc = contentWin.document;
          const threadTree = innerDoc?.getElementById?.("threadTree") ||
                            innerDoc?.querySelector?.("tree-view#threadTree, tree-view");
          if (threadTree) {
            const mo = new contentWin.MutationObserver((mutations) => {
              for (const m of mutations) {
                if (m.attributeName === "rows") {
                  ensureCardSnippetEnhancements(win);
                }
              }
            });
            mo.observe(threadTree, { attributes: true, attributeFilter: ["rows"] });
            contentWin.__tmCardSnippetsRowsMO = mo;
          }
        }

        if (contentWin && !contentWin.__tmCardSnippetsFolderURIHandler) {
          contentWin.__tmCardSnippetsFolderURIHandler = () => {
            ensureCardSnippetEnhancements(win);
            // applySnippetsToDoc removed - fillRow patch handles rendering
          };
          contentWin.addEventListener("folderURIChanged", contentWin.__tmCardSnippetsFolderURIHandler);
        }
        if (contentWin && !contentWin.__tmCardSnippetsThreadPaneHandler) {
          contentWin.__tmCardSnippetsThreadPaneHandler = () => {
            ensureCardSnippetEnhancements(win);
          };
          contentWin.addEventListener("threadpane-loaded", contentWin.__tmCardSnippetsThreadPaneHandler);
        }
        if (tabmail?.tabContainer && !win.__tmCardSnippetsTabSelectHandler) {
          win.__tmCardSnippetsTabSelectHandler = () => {
            attachMessageListEventHooks(win, "TabSelect");
            ensureCardSnippetEnhancements(win);
          };
          tabmail.tabContainer.addEventListener("TabSelect", win.__tmCardSnippetsTabSelectHandler);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MLCV} attachMessageListEventHooks failed:`, e);
      }
    }

    function detachMessageListEventHooks(win) {
      try {
        if (!win) return;
        const tabmail = win.document.getElementById("tabmail");
        if (tabmail?.tabContainer && win.__tmCardSnippetsTabSelectHandler) {
          try { tabmail.tabContainer.removeEventListener("TabSelect", win.__tmCardSnippetsTabSelectHandler); } catch (_) {}
          delete win.__tmCardSnippetsTabSelectHandler;
        }
        try {
          const contentDocs = enumerateContentDocs(win);
          for (const cdoc of contentDocs) {
            const cw = cdoc?.defaultView;
            if (!cw) continue;
            if (cw.__tmCardSnippetsRowsMO) {
              try { cw.__tmCardSnippetsRowsMO.disconnect(); } catch (_) {}
              delete cw.__tmCardSnippetsRowsMO;
            }
            if (cw.__tmCardSnippetsFolderURIHandler) {
              try { cw.removeEventListener("folderURIChanged", cw.__tmCardSnippetsFolderURIHandler); } catch (_) {}
              delete cw.__tmCardSnippetsFolderURIHandler;
            }
            if (cw.__tmCardSnippetsThreadPaneHandler) {
              try { cw.removeEventListener("threadpane-loaded", cw.__tmCardSnippetsThreadPaneHandler); } catch (_) {}
              delete cw.__tmCardSnippetsThreadPaneHandler;
            }
          }
        } catch (_) {}
      } catch (e) {
        console.error(`${LOG_PREFIX_MLCV} detachMessageListEventHooks failed:`, e);
      }
    }

    function ensureCardSnippetEnhancements(win) {
      try {
        const contentDocs = enumerateContentDocs(win);
        for (const cdoc of contentDocs) {
          // Patch ThreadCard prototype for zero-flicker sender/snippet rendering
          patchThreadCardPrototype(cdoc);
          // Document-level chip click delegation (survives hot-reload)
          attachChipDelegation_MLCV(cdoc);
          // applySnippetsToDoc and attachCardSnippetObserver removed - fillRow patch handles all
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MLCV} ensureCardSnippetEnhancements error:`, e);
      }
    }

    function removeCardSnippetEnhancements(win) {
      try {
        detachMessageListEventHooks(win);
        const contentDocs = enumerateContentDocs(win);
        for (const cdoc of contentDocs) {
          // Unpatch ThreadCard prototype marker (for hot-reload)
          try { unpatchThreadCardPrototype(cdoc); } catch (_) {}
          // Detach chip click delegation
          try { detachChipDelegation_MLCV(cdoc); } catch (_) {}
          // Legacy observer/timer cleanup removed - no longer created
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MLCV} removeCardSnippetEnhancements error:`, e);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // API FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    async function init(_opts = {}) {
      console.log(`${LOG_PREFIX_MLCV} ═══ init() called ═══`);
      if (!ServicesCS || !ServicesCS.wm) {
        console.error(`${LOG_PREFIX_MLCV} Services.wm not available!`);
        return;
      }
      if (isInitialized) {
        console.log(`${LOG_PREFIX_MLCV} Already initialized, skipping`);
        return;
      }
      isInitialized = true;

      // Patch ROW_HEIGHT on all existing windows immediately.
      // Must happen before any view switch, since TB reads ROW_HEIGHT in
      // attributeChangedCallback when the "rows" attribute changes.
      {
        const earlyEnum = ServicesCS.wm.getEnumerator("mail:3pane");
        while (earlyEnum.hasMoreElements()) {
          const w = earlyEnum.getNext();
          try {
            const cw = w.document?.getElementById?.("tabmail")?.currentAbout3Pane ||
                       w.document?.getElementById?.("tabmail")?.currentTabInfo?.chromeBrowser?.contentWindow;
            const reg = (cw || w)?.customElements;
            const TC = reg?.get?.("thread-card");
            if (TC && TC.ROW_HEIGHT !== CARD_ROW_HEIGHT_MLCV) {
              if (!TC.__tmOrigRowHeight) TC.__tmOrigRowHeight = TC.ROW_HEIGHT;
              TC.ROW_HEIGHT = CARD_ROW_HEIGHT_MLCV;
            }
          } catch (_) {}
        }
      }

      console.log(`${LOG_PREFIX_MLCV} Snippets use DOM-based detection (3-row mode = no .cards-row-compact)`);

      const enumWin = ServicesCS.wm.getEnumerator("mail:3pane");
      while (enumWin.hasMoreElements()) {
        const win = enumWin.getNext();
        if (win.document.readyState === "complete") {
          ensureCardSnippetEnhancements(win);
          attachMessageListEventHooks(win, "init-existing");
        } else {
          win.addEventListener("load", () => {
            ensureCardSnippetEnhancements(win);
            attachMessageListEventHooks(win, "init-load");
          }, { once: true });
        }
      }
      windowListenerId = context.extension.id + "-tmMessageListCardView";
      ExtensionSupport_MLCV.registerWindowListener(windowListenerId, {
        chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
        onLoadWindow: (win) => {
          ensureCardSnippetEnhancements(win);
          attachMessageListEventHooks(win, "onLoadWindow");
        },
      });
      context.__tmCardSnippetsWindowListenerRegistered = true;
      console.log(`${LOG_PREFIX_MLCV} ✓ Initialization complete`);
    }

    function cleanup() {
      console.log(`${LOG_PREFIX_MLCV} cleanup() called`);
      try {
        if (windowListenerId && context.__tmCardSnippetsWindowListenerRegistered) {
          ExtensionSupport_MLCV.unregisterWindowListener(windowListenerId);
          windowListenerId = null;
          context.__tmCardSnippetsWindowListenerRegistered = false;
        }
      } catch (_) {}
      // Cancel any pending debounce timer; on hot-reload the next module
      // cannot rely on a fresh timer slot otherwise.
      try {
        if (_pendingNeedsDebounceTimer) {
          try { _pendingNeedsDebounceTimer.cancel?.(); } catch (_) {}
          _pendingNeedsDebounceTimer = null;
        }
      } catch (_) {}
      // Reset module-level snippet caches so a hot-reload starts from a
      // clean slate. If the module unloads cleanly these are already gone;
      // if it doesn't (closures pin it alive), the stale entries would
      // otherwise mask cache-miss recovery for rows that recycle in after
      // an archive/move.
      try { _clearSnippetMemoryCache(); } catch (_) {}
      try { _clearPendingSnippetNeeds(); } catch (_) {}
      // Clear per-document pending Maps. These live on the doc object
      // (which survives extension reload) and would otherwise rate-limit
      // fresh post-reload requests by their stale timestamps.
      try {
        if (ServicesCS?.wm) {
          const enumPendingWin = ServicesCS.wm.getEnumerator("mail:3pane");
          while (enumPendingWin.hasMoreElements()) {
            try {
              const w = enumPendingWin.getNext();
              const docs = enumerateContentDocs(w);
              for (const d of docs) {
                if (d?.__tmMsgList?.__tmCardSnippetPending?.clear) {
                  d.__tmMsgList.__tmCardSnippetPending.clear();
                }
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
      try {
        if (ServicesCS?.wm) {
          const enumWin = ServicesCS.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            removeCardSnippetEnhancements(enumWin.getNext());
          }
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MLCV} Error during cleanup:`, e);
      }
      isInitialized = false;
      console.log(`${LOG_PREFIX_MLCV} cleanup() complete`);
    }

    this._tmCleanup = cleanup;

    async function shutdown() {
      console.log(`${LOG_PREFIX_MLCV} shutdown() called from WebExtension API`);
      cleanup();
    }

    function clearSnippetCache() {
      console.log(`${LOG_PREFIX_MLCV} Card snippet cache clear requested (no-op; cache lives in safeGetFull)`);
    }

    async function getCardSnippetNeeds(opts = {}) {
      try {
        const now = Date.now();
        const _diagMax = Math.max(0, Number(CARD_SNIPPET_CONFIG_MLCV?.maxDiagnostics) || 0);
        if (!_snippetsContentEnabled()) return [];
        const max = Number(opts?.max) || 12;
        const out = [];
        const seen = new Set();
        const _pendingTtlMs = Number(CARD_SNIPPET_CONFIG_MLCV?.reapply?.pendingTtlMs) || 0;
        const _pendingMaxEntries = Number(CARD_SNIPPET_CONFIG_MLCV?.reapply?.pendingMaxEntries) || 0;
        
        // PRIORITY 1: Drain pending needs from fillRow cache misses
        // This is the primary source - these are specific hdrKeys that need snippets
        const pendingHdrKeys = _drainPendingSnippetNeeds(max);
        
        // Build a map of hdrKey -> message info for the pending keys
        // We need to look up headers by hdrKey, which requires scanning windows
        const hdrInfoByKey = new Map();
        
        const enumWin = ServicesCS.wm.getEnumerator("mail:3pane");
        while (enumWin.hasMoreElements()) {
          const win = enumWin.getNext();
          const docs = enumerateContentDocs(win);
          for (const doc of docs) {
            if (!doc) continue;
            const tree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
            if (!tree) continue;
            const rows = Array.from(doc.querySelectorAll('[is="thread-card"]'));
            if (!rows.length) continue;
            
            // Build index: hdrKey -> { row, tree, doc, hdr }
            for (const row of rows) {
              const idx = _rowIndexFromRowId(row.id);
              if (idx < 0) continue;
              const hdr = _getHdrForRowIndex(tree, idx);
              if (!hdr) continue;
              const hdrKey = getHdrKey(hdr);
              if (!hdrKey) continue;
              if (!hdrInfoByKey.has(hdrKey)) {
                hdrInfoByKey.set(hdrKey, { row, tree, doc, hdr, idx });
              }
            }
          }
        }
        
        // Diagnostics for pending processing
        let _pendingDiag = { notInMap: 0, alreadySeen: 0, hasContent: 0, rateLimited: 0, added: 0 };
        
        // Process pending hdrKeys
        for (const hdrKey of pendingHdrKeys) {
          if (out.length >= max) break;
          if (seen.has(hdrKey)) { _pendingDiag.alreadySeen++; continue; }
          
          const info = hdrInfoByKey.get(hdrKey);
          if (!info) { _pendingDiag.notInMap++; continue; } // Row no longer visible - skip (will retry on next render)
          
          const { row, tree, doc, hdr, idx } = info;
          
          // Skip if snippet element already has content
          try {
            const el = row.querySelector?.(`.${CARD_SNIPPET_CONFIG_MLCV.className}`) || null;
            if (el && el.isConnected) {
              const t = _safeText(el.textContent || "");
              if (t) { _pendingDiag.hasContent++; continue; }
            }
          } catch (_) {}
          
          // Skip if already in pending (rate-limited)
          let wasRateLimited = false;
          try {
            doc.__tmMsgList = doc.__tmMsgList || {};
            const pending = doc.__tmMsgList.__tmCardSnippetPending || new Map();
            doc.__tmMsgList.__tmCardSnippetPending = pending;
            const pendTs = Number(pending.get(hdrKey) || 0);
            if (_pendingTtlMs > 0 && pendTs && (now - pendTs) < _pendingTtlMs) {
              wasRateLimited = true;
              _pendingDiag.rateLimited++;
              continue;
            }
            // Prune pending map if needed
            if (_pendingMaxEntries > 0 && pending.size > _pendingMaxEntries) {
              for (const [k, ts] of pending) {
                if ((now - Number(ts || 0)) > _pendingTtlMs) pending.delete(k);
                if (pending.size <= _pendingMaxEntries) break;
              }
            }
          } catch (_) {}

          // Mark as pending
          try {
            if (_pendingTtlMs > 0) {
              doc.__tmMsgList = doc.__tmMsgList || {};
              const pending = doc.__tmMsgList.__tmCardSnippetPending || new Map();
              pending.set(hdrKey, now);
              doc.__tmMsgList.__tmCardSnippetPending = pending;
            }
          } catch (_) {}
          
          // Get WebExtension message ID
          let weId = null;
          try {
            const msgMgr = context.extension.messageManager;
            const weMsg = msgMgr?.convert ? msgMgr.convert(hdr) : null;
            weId = weMsg?.id ?? null;
          } catch (_) {}
          
          const msgId = String(hdr?.messageId || "");
          const subject = _safeText(hdr?.subject || "");
          seen.add(hdrKey);
          _pendingDiag.added++;
          out.push({ hdrKey, msgId, weId, subject: subject.slice(0, 120) });
        }
        
        // Log pending processing diagnostics
        if (pendingHdrKeys.length > 0) {
          console.log(`${LOG_PREFIX_MLCV}[SnippetDiag] pendingProcessing:`, {
            pendingKeysCount: pendingHdrKeys.length,
            hdrInfoMapSize: hdrInfoByKey.size,
            ..._pendingDiag,
            outCount: out.length,
          });
        }
        
        // PRIORITY 2 (FALLBACK): If we didn't get enough from pending, scan visible rows
        // This handles cases where fillRow didn't fire (e.g., initial load)
        if (out.length < max) {
          const enumWin2 = ServicesCS.wm.getEnumerator("mail:3pane");
          while (enumWin2.hasMoreElements() && out.length < max) {
            const win = enumWin2.getNext();
            const docs = enumerateContentDocs(win);
            for (const doc of docs) {
              if (out.length >= max) break;
              if (!doc) continue;
              if (isBusy(doc)) continue;
              const tree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
              if (!tree) continue;
              const rows = Array.from(doc.querySelectorAll('[is="thread-card"]'));
              if (!rows.length) continue;
              let range = null;
              try { range = doc.__tmMsgList?.__tmCardSnippetIndexRange || null; } catch (_) {}
              if (!range) {
                let treeRect = null;
                try { treeRect = tree.getBoundingClientRect?.() || null; } catch (_) {}
                let visibleMinIdx = Infinity;
                let visibleMaxIdx = -Infinity;
                if (treeRect) {
                  for (const row of rows) {
                  const r = row.getBoundingClientRect?.();
                  if (!r) continue;
                  const inViewport = r.bottom >= treeRect.top && r.top <= treeRect.bottom;
                  if (!inViewport) continue;
                  const idx = _rowIndexFromRowId(row.id);
                  if (idx >= 0) {
                    if (idx < visibleMinIdx) visibleMinIdx = idx;
                    if (idx > visibleMaxIdx) visibleMaxIdx = idx;
                  }
                }
              }
              if (Number.isFinite(visibleMinIdx) && Number.isFinite(visibleMaxIdx)) {
                const bufferRows = Number(CARD_SNIPPET_CONFIG_MLCV?.reapply?.viewportBufferRows) || 0;
                const minIdx = Math.max(0, visibleMinIdx - bufferRows);
                const maxIdx = visibleMaxIdx + bufferRows;
                range = { minIdx, maxIdx, bufferRows };
              }
            }
            for (const row of rows) {
              if (out.length >= max) break;
              const idx = _rowIndexFromRowId(row.id);
              if (idx < 0) continue;
              if (range && (idx < range.minIdx || idx > range.maxIdx)) continue;
              const hdr = _getHdrForRowIndex(tree, idx);
              if (!hdr) continue;
              const hdrKey = getHdrKey(hdr);
              if (!hdrKey) continue;
              if (seen.has(hdrKey)) continue;
              try {
                const el = row.querySelector?.(`.${CARD_SNIPPET_CONFIG_MLCV.className}`) || null;
                if (el && el.isConnected) {
                  const t = _safeText(el.textContent || "");
                  if (t) continue;
                }
              } catch (_) {}
              try {
                doc.__tmMsgList = doc.__tmMsgList || {};
                const pending = doc.__tmMsgList.__tmCardSnippetPending || new Map();
                doc.__tmMsgList.__tmCardSnippetPending = pending;
                const pendTs = Number(pending.get(hdrKey) || 0);
                if (_pendingTtlMs > 0 && pendTs && (now - pendTs) < _pendingTtlMs) continue;
                if (_pendingMaxEntries > 0 && pending.size > _pendingMaxEntries) {
                  for (const [k, ts] of pending) {
                    if ((now - Number(ts || 0)) > _pendingTtlMs) pending.delete(k);
                    if (pending.size <= _pendingMaxEntries) break;
                  }
                }
              } catch (_) {}
              let weId = null;
              try {
                const msgMgr = context.extension.messageManager;
                const weMsg = msgMgr?.convert ? msgMgr.convert(hdr) : null;
                weId = weMsg?.id ?? null;
              } catch (_) {}
              const msgId = String(hdr?.messageId || "");
              const subject = _safeText(hdr?.subject || "");
              seen.add(hdrKey);
              try {
                if (_pendingTtlMs > 0) {
                  doc.__tmMsgList = doc.__tmMsgList || {};
                  const pending = doc.__tmMsgList.__tmCardSnippetPending || new Map();
                  pending.set(hdrKey, now);
                  doc.__tmMsgList.__tmCardSnippetPending = pending;
                }
              } catch (_) {}
              out.push({ hdrKey, msgId, weId, subject: subject.slice(0, 120) });
            }
          }
        }
        } // closes if (out.length < max) - Priority 2 fallback
        // Log when returning needs (helps debug why some messages aren't getting snippets)
        if (out.length > 0) {
          console.log(`${LOG_PREFIX_MLCV}[SnippetDiag] getCardSnippetNeeds returning`, {
            count: out.length,
            anyTreeIn3RowMode: _isAnyTreeIn3RowMode(),
            sample: out.slice(0, 3).map(n => ({ hdrKey: n.hdrKey?.slice(0, 20), subject: n.subject?.slice(0, 30) })),
          });
        }
        return out;
      } catch (e) {
        console.error(`${LOG_PREFIX_MLCV} getCardSnippetNeeds failed:`, e);
        return [];
      }
    }

    async function provideCardSnippets(payload) {
      try {
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const clearPending = Array.isArray(payload?.clearPending) ? payload.clearPending : [];
        const source = String(payload?.source || "unknown");
        let applied = 0;
        let cleared = 0;
        const itemsByKey = new Map();
        for (const it of items) {
          const k = String(it?.hdrKey || "");
          if (!k) continue;
          const snippet = String(it?.snippet || "");
          if (!snippet) continue;
          if (!itemsByKey.has(k)) itemsByKey.set(k, { snippet });
          // Store in experiment's in-memory cache for instant fillRow access
          _setSnippetInMemoryCache(k, snippet);
        }
        // Build set of hdrKeys to clear from pending (for failed fetches that returned empty)
        const clearPendingSet = new Set();
        for (const k of clearPending) {
          const key = String(k || "");
          if (key) clearPendingSet.add(key);
        }
        // Diagnostic counters
        let diagNoTree = 0;
        let diagNoRows = 0;
        let diagNoHost = 0;
        // diagOutOfRange removed - range check no longer used
        let diagNoHdr = 0;
        let diagNoHdrKey = 0;
        let diagNoMatch = 0;
        
        const enumWin = ServicesCS.wm.getEnumerator("mail:3pane");
        while (enumWin.hasMoreElements()) {
          const win = enumWin.getNext();
          const docs = enumerateContentDocs(win);
          for (const doc of docs) {
            if (!doc) continue;
            
            // Clear pending entries for failed fetches (allows immediate retry)
            if (clearPendingSet.size > 0) {
              try {
                doc.__tmMsgList = doc.__tmMsgList || {};
                const pending = doc.__tmMsgList.__tmCardSnippetPending || null;
                if (pending && pending.delete) {
                  for (const k of clearPendingSet) {
                    if (pending.delete(k)) cleared++;
                  }
                }
              } catch (_) {}
            }
            
            const tree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
            if (!tree) { diagNoTree++; continue; }
            const rows = Array.from(doc.querySelectorAll('[is="thread-card"]'));
            if (!rows.length) { diagNoRows++; continue; }
            // Range check removed - with event-driven architecture, we inject for specific hdrKeys
            // regardless of visible range. The hdrKey matching handles relevance.
            for (const row of rows) {
              const idx = _rowIndexFromRowId(row.id);
              if (idx < 0) continue;
              const hdr = _getHdrForRowIndex(tree, idx);
              if (!hdr) { diagNoHdr++; continue; }
              const rowHdrKey = getHdrKey(hdr);
              if (!rowHdrKey) { diagNoHdrKey++; continue; }
              // For rows whose key was just cleared (empty fetch), wipe any
              // stale snippet text left over from a recycled previous message
              // so the wrong preview doesn't linger until a retry succeeds.
              if (clearPendingSet.has(rowHdrKey)) {
                try {
                  const host = findSnippetHost(row, hdr);
                  const stale = host?.querySelector?.(`.${CARD_SNIPPET_CONFIG_MLCV.className}`) || null;
                  if (stale && stale.isConnected) {
                    const oldKey = stale.getAttribute?.("data-tm-hdr-key") || "";
                    if (oldKey && oldKey !== rowHdrKey) {
                      try { stale.setAttribute("data-tm-hdr-key", rowHdrKey); } catch (_) {}
                      try { stale.textContent = ""; } catch (_) {}
                    }
                  }
                } catch (_) {}
              }
              const it = itemsByKey.get(rowHdrKey);
              if (!it) { diagNoMatch++; continue; }
              const snippet = it.snippet;
              const host = findSnippetHost(row, hdr);
              if (!host) { diagNoHost++; continue; }
              const text = snippet.length > CARD_SNIPPET_CONFIG_MLCV.maxChars
                ? snippet.slice(0, CARD_SNIPPET_CONFIG_MLCV.maxChars).trim()
                : snippet;
              let el = host.querySelector?.(`.${CARD_SNIPPET_CONFIG_MLCV.className}`) || null;
              if (!el || !el.isConnected) {
                el = doc.createElement("div");
                el.className = CARD_SNIPPET_CONFIG_MLCV.className;
                try { el.setAttribute("data-tm-hdr-key", rowHdrKey || ""); } catch (_) {}
                el.textContent = text;
                try {
                  const iconInfo = host.querySelector?.(".thread-card-icon-info") || null;
                  if (iconInfo) {
                    let wrapper = host.querySelector?.(".tm-card-snippet-wrapper") || null;
                    if (!wrapper) {
                      wrapper = doc.createElement("div");
                      wrapper.className = "tm-card-snippet-wrapper";
                      host.insertBefore(wrapper, iconInfo);
                      wrapper.appendChild(iconInfo); // Float target must precede text
                      wrapper.appendChild(el);
                    } else {
                      wrapper.appendChild(el); // Append after floated icon-info
                    }
                  } else {
                    host.appendChild(el);
                  }
                } catch (_) {}
              } else {
                try { el.setAttribute("data-tm-hdr-key", rowHdrKey || ""); } catch (_) {}
                try { el.textContent = text; } catch (_) {}
              }
              applied += 1;
              try {
                doc.__tmMsgList = doc.__tmMsgList || {};
                const pending = doc.__tmMsgList.__tmCardSnippetPending || null;
                if (pending && pending.delete) pending.delete(rowHdrKey);
              } catch (_) {}
            }
          }
        }
        
        // Log diagnostics if there are items but few applied
        if (itemsByKey.size > 0 && applied < itemsByKey.size) {
          console.log(`${LOG_PREFIX_MLCV}[SnippetDiag] provideCardSnippets mismatch`, {
            source,
            itemsProvided: itemsByKey.size,
            applied,
            diagNoTree,
            diagNoRows,
            diagNoHost,
            diagNoHdr,
            diagNoHdrKey,
            diagNoMatch,
          });
        }
        
        return { ok: true, applied, cleared };
      } catch (e) {
        console.error(`${LOG_PREFIX_MLCV} provideCardSnippets failed:`, e);
        return { ok: false, error: String(e) };
      }
    }

    // Get in-memory cache statistics
    function getMemoryCacheStats() {
      return _getSnippetMemoryCacheStats();
    }

    return {
      tmMessageListCardView: {
        init,
        shutdown,
        clearSnippetCache,
        getCardSnippetNeeds,
        provideCardSnippets,
        getMemoryCacheStats,
        // Event: onSnippetsNeeded - MV3 can listen with browser.tmMessageListCardView.onSnippetsNeeded.addListener()
        onSnippetsNeeded: new ExtensionCommon_MLCV.EventManager({
          context,
          name: "tmMessageListCardView.onSnippetsNeeded",
          register: (fire) => {
            const listener = (info) => {
              fire.async(info);
            };
            context.extension.on("onSnippetsNeeded", listener);
            return () => {
              context.extension.off("onSnippetsNeeded", listener);
            };
          },
        }).api(),
        // Event: onActionChipClick - fired when the user clicks an action chip on a card row.
        // MV3 should resolve the message via headerMessageId and run the same pathway
        // as the Tab key (performTaggedAction).
        onActionChipClick: new ExtensionCommon_MLCV.EventManager({
          context,
          name: "tmMessageListCardView.onActionChipClick",
          register: (fire) => {
            const listener = (info) => {
              fire.async(info);
            };
            context.extension.on("onActionChipClick", listener);
            return () => {
              context.extension.off("onActionChipClick", listener);
            };
          },
        }).api(),
      },
    };
  }
};
