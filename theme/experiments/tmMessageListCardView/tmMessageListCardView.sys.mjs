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
const { ExtensionCommon: ExtensionCommon_MLCV } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

var ServicesCS = globalThis.Services;

const LOG_PREFIX_MLCV = "[TabMail MessageList CardView]";

console.log(`${LOG_PREFIX_MLCV} experiment parent script loaded. Services present?`, typeof ServicesCS !== "undefined");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

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

    function normalizePreviewText(text) {
      if (!text) return "";
      let t = String(text).replace(/\0/g, "");
      t = t.replace(/\s+/g, " ").trim();
      if (t.length > CARD_SNIPPET_CONFIG_MLCV.maxChars) {
        t = t.slice(0, CARD_SNIPPET_CONFIG_MLCV.maxChars).trim();
      }
      return t;
    }

    function _safeText(s) {
      try {
        return String(s || "").replace(/\s+/g, " ").trim();
      } catch (_) {
        return "";
      }
    }

    function getSnippetText(hdr) {
      if (!hdr) return "";
      if (!_snippetsContentEnabled()) return "";
      const props = ["preview", "snippet", "summary"];
      for (const prop of props) {
        try {
          const val = hdr.getStringProperty?.(prop);
          if (val && val.trim()) return normalizePreviewText(val);
        } catch (_) {}
      }
      return "";
    }

    function getSnippetTextWithSource(hdr) {
      if (!hdr) return { text: "", source: "" };
      if (!_snippetsContentEnabled()) return { text: "", source: "" };
      const props = ["preview", "snippet", "summary"];
      for (const prop of props) {
        try {
          const val = hdr.getStringProperty?.(prop);
          if (val && val.trim()) {
            return { text: normalizePreviewText(val), source: prop };
          }
        } catch (_) {}
      }
      return { text: "", source: "" };
    }

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

        // 2. Inject snippet if cached in experiment memory (zero-flicker, instant)
        const ZERO_FLICKER_SNIPPETS_ENABLED = true;
        if (ZERO_FLICKER_SNIPPETS_ENABLED && _snippetsEnabledForDoc(doc)) {
          // First check experiment's in-memory cache (instant, no async hop)
          let snippet = _getSnippetFromMemoryCache(hdrKey);
          // Fallback to TB header property (in case it was set externally)
          if (!snippet) {
            snippet = getSnippetText(hdr);
          }
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
                    host.insertBefore(el, iconInfo);
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
            // Cache miss - add to pending needs queue and fire event to MV3
            _addPendingSnippetNeed(hdrKey);
          }
        }
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

        if (ThreadCard.__tmPatched) {
          return true; // Already patched
        }

        const proto = ThreadCard.prototype;
        
        // Check for fillRow method (this is what TB uses to populate cards)
        if (typeof proto.fillRow !== "function") {
          console.log(`${CARD_SENDER_CONFIG_MLCV.logPrefix} ThreadCard.fillRow not found`);
          return false;
        }

        const origFillRow = proto.fillRow;

        proto.fillRow = function(index, row, dataset, view) {
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
     * Note: We can't easily restore the original fillRow, but removing the patch marker
     * allows future inits to detect unpatched state. The patched fillRow is harmless 
     * when the extension is disabled since it just calls the original.
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
        if (!ThreadCard || !ThreadCard.__tmPatched) return;
        delete ThreadCard.__tmPatched;
        console.log(`${CARD_SENDER_CONFIG_MLCV.logPrefix} ThreadCard prototype unpatch marker removed`);
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
      
      // Snippets are now enabled dynamically based on DOM state (.cards-row-compact class)
      // No need to track pref - we check the actual tree state when needed
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
        let _pendingDiag = { notInMap: 0, alreadySeen: 0, hasContent: 0, rateLimited: 0, hasTbPreview: 0, added: 0 };
        
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
          
          // Skip if TB already has preview (message already loaded)
          const existingInfo = getSnippetTextWithSource(hdr);
          if (existingInfo.text) { _pendingDiag.hasTbPreview++; continue; }
          
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
              const existingInfo = getSnippetTextWithSource(hdr);
              if (existingInfo.text) continue;
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
                    host.insertBefore(el, iconInfo);
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
      },
    };
  }
};
