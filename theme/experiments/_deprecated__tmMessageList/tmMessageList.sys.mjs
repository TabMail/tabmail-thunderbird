/*
 * TabMail Message List Experiment
 * 
 * Manages thread list UI enhancements:
 * - Tag coloring (card view + table view)
 * - Card snippets (preview text under subject)
 * - Row observers for zero-blink updates
 * 
 * Separated from tmTheme for maintainability.
 * tmTheme handles CSS/AGENT_SHEET only; this handles DOM/row logic.
 */

const { ExtensionSupport: ExtensionSupportML } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonML } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { MailServices: MailServicesML } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { NetUtil: NetUtilML } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

var ServicesML = globalThis.Services;

const LOG_PREFIX = "[TabMail MessageList]";

console.log(`${LOG_PREFIX} experiment parent script loaded. Services present?`, typeof ServicesML !== "undefined");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// Anti-blink persistence duration (ms) for tag colors
const TAG_PERSISTENCE_DURATION_MS = 500;

// TabMail action tags in priority order (highest priority first).
// We intentionally ignore non-TabMail tags for coloring to prevent IMAP keyword reorder flicker.
const TM_ACTION_TAG_KEY_PRIORITY = ["tm_reply", "tm_none", "tm_archive", "tm_delete"];

// Card snippet configuration
const CARD_SNIPPET_CONFIG = {
  logPrefix: `${LOG_PREFIX}[CardSnippet]`,
  className: "tm-card-snippet",
  // NOTE: reserved snippet space is now CSS-only and always enabled (theme.css).
  // Keep in sync with MV3 snippet provider cap.
  maxChars: 320,
  maxLines: 2,
  maxDiagnostics: 40,
  enabled: true,
  // TEMP (debug): fully disable snippet content fetching/injection.
  forceDisableInjection: false,
  // Subject element selectors (where to append snippet)
  // NOTE: TB card view uses .thread-card-subject-container > .subject (see DOM structure)
  subjectSelectors: [".thread-card-subject-container", ".subject", ".card-subject", ".subject-line", "[data-column-name='subjectcol']"],
  // Preview fetch config (legacy; kept for logs/config stability, but not used)
  previewFetch: {
    // How long to cache the result of a preview request (in-memory only; TB also caches in DB)
    cacheMs: 5 * 60 * 1000,
    // Max entries in our in-memory cache
    maxCacheEntries: 600,
    // Prune interval
    pruneIntervalMs: 15 * 1000,
    pruneMaxRemovalsPerRun: 120,
    // Max concurrent fetchMsgPreviewText requests (TB handles disk I/O efficiently)
    maxInflightFetches: 4,
    // Max fetches per applySnippetsToDoc pass
    maxFetchesPerPass: 8,
    // Timeout for waiting on fetchMsgPreviewText (ms)
    timeoutMs: 3000,
    // Batch multiple message keys into a single folder.fetchMsgPreviewText([...keys], listener) call.
    batchDelayMs: 60,
    maxKeysPerBatch: 40,
    // Diagnostics (bounded; keep high-signal)
    diag: {
      maxBatchLogs: 25,
      maxResolveLogs: 40,
      maxEmptyPreviewLogs: 40,
      maxTimeoutLogs: 40,
      maxMissingAfterFetchLogs: 40,
    },
  },
  // Re-apply behavior (avoid visible flicker when TB rebuilds card DOM)
  reapply: {
    // Upper bound on rows we will process per mutation callback
    maxRowsPerMutation: 30,
    // Upper bound on async fetches we will kick off per mutation callback
    maxAsyncFetchesPerMutation: 4,
    // Only fetch for rows in/near the viewport (prevents runaway work on huge folders).
    // We use a **row index buffer** instead of pixels so behavior is stable across font sizes/densities.
    viewportBufferRows: 26,
    // Post-init kick passes (helps the folder open during reload render correctly without user interaction)
    initKickDelaysMs: [0, 220, 700],
    // Avoid spamming applySnippetsToDoc; this can cause unnecessary work and scroll churn.
    minApplyIntervalMs: 160,
    // Debounce scroll events (ms) before triggering snippet load.
    scrollDebounceMs: 150,
    // Avoid spamming getCardSnippetNeeds (MV3 polling); skip if called too frequently.
    minNeedsIntervalMs: 600,
    // Pending request bookkeeping (prevents repeated needs for the same hdrKey while MV3 is processing).
    pendingTtlMs: 12000,
    pendingMaxEntries: 1200,
  },
};

const CARD_SENDER_CONFIG = {
  logPrefix: `${LOG_PREFIX}[CardSender]`,
  className: "tm-card-sender",
  maxLogs: 10,
};

// Message list diagnostics (kept separate from snippet/tag configs).
// Goal: detect TB row virtualization/recycling + layout changes that could cause scroll "bounce".
const MESSAGE_LIST_DIAG_CONFIG = {
  logPrefix: `${LOG_PREFIX}[Diag]`,
  // Disabled by default (too noisy). Re-enable temporarily when diagnosing scroll/layout issues.
  enabled: false,
  // Total number of diagnostic logs per document (bounded).
  maxLogsPerDoc: 80,
  // For row add/remove logs: include up to N row ids.
  maxRowIdsInLog: 8,
  // For row measurements: measure up to N rows per mutation.
  maxRowMeasuresPerMutation: 4,
  // Remeasure after this delay to detect post-insert layout changes (ms).
  remeasureDelayMs: 120,
  // Only log height changes larger than this epsilon (px).
  heightDeltaEpsilonPx: 0.75,
  // Also log live resizes (captures the exact moment the row changes size, even if there is no DOM mutation).
  enableResizeObserver: false,
  // Upper bound for resize logs per document (prevents spam in huge folders).
  maxResizeLogsPerDoc: 40,
};

// ═══════════════════════════════════════════════════════════════════════════
// CACHES
// ═══════════════════════════════════════════════════════════════════════════

// Anti-blink persistence cache for tag colors
// Stores the last valid tag color for a message ID to mask transient "untagged" states
// during Thunderbird's DB transactions.
const TagPersistenceCache = new Map(); // messageId -> { color, time }

// NOTE: We intentionally do NOT keep a snippet cache in the experiment anymore.
// Snippet caching + resource bounds are handled centrally by MV3-side safeGetFull().
// The experiment is responsible for applying placeholder + rendering provided snippets.

function _describeFolderForPreview(folder) {
  try {
    const f = folder;
    if (!f) return null;

    let flags = 0;
    try { flags = Number(f.flags) || 0; } catch (_) {}

    const flagPairs = [];
    try {
      const FF = Ci?.nsMsgFolderFlags;
      const add = (name, v) => {
        if (Number.isFinite(v)) flagPairs.push([name, v]);
      };
      add("Inbox", FF?.Inbox);
      add("SentMail", FF?.SentMail);
      add("Drafts", FF?.Drafts);
      add("Trash", FF?.Trash);
      add("Queue", FF?.Queue);
      add("Templates", FF?.Templates);
      add("Junk", FF?.Junk);
      add("Archive", FF?.Archive);
      add("Virtual", FF?.Virtual);
      add("ImapNoselect", FF?.ImapNoselect);
      add("Offline", FF?.Offline);
      add("Newsgroup", FF?.Newsgroup);
    } catch (_) {}

    const flagNames = [];
    for (const [name, v] of flagPairs) {
      try {
        if (v && (flags & v)) flagNames.push(name);
      } catch (_) {}
    }

    let serverType = null;
    try { serverType = f.server?.type || null; } catch (_) {}
    let isImap = null;
    try { isImap = serverType ? String(serverType).toLowerCase() === "imap" : null; } catch (_) {}

    return {
      uri: _getFolderUri(f),
      flags,
      flagNames,
      serverType,
      isImap,
    };
  } catch (_) {
    return null;
  }
}

function _describeHdrOffline(hdr) {
  try {
    const h = hdr;
    if (!h) return null;
    let msgFlags = null;
    try { msgFlags = Number(h.flags); } catch (_) {}

    let offlineFlag = null;
    try {
      const MF = Ci?.nsMsgMessageFlags;
      offlineFlag = Number(MF?.Offline);
    } catch (_) {}

    let isOffline = null;
    try {
      if (Number.isFinite(msgFlags) && Number.isFinite(offlineFlag)) {
        isOffline = (msgFlags & offlineFlag) !== 0;
      }
    } catch (_) {}

    return {
      messageKey: h.messageKey,
      msgFlags,
      isOffline,
    };
  } catch (_) {
    return null;
  }
}

// (no snippet cache)

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════

var tmMessageList = class extends ExtensionCommonML.ExtensionAPI {
  onShutdown(isAppShutdown) {
    console.log(`${LOG_PREFIX} onShutdown() called by Thunderbird, isAppShutdown:`, isAppShutdown);
    try {
      if (this._tmCleanup) {
        this._tmCleanup();
        console.log(`${LOG_PREFIX} ✓ Cleanup completed via onShutdown`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} onShutdown cleanup failed:`, e);
    }
  }

  getAPI(context) {
    let windowListenerId = null;
    let paletteData = null;
    let isInitialized = false;

    // Runtime flags (set by background via tmMessageList.init({ flags: ... }))
    // cardSnippetsEnabled is now derived from TB pref (mail.threadpane.cardsview.rowcount == 3)
    let msgListFlags = {
      cardSnippetsEnabled: false,
    };

    // Card view row count pref (snippets are enabled when rowcount == 3)
    const CARD_VIEW_ROW_COUNT_PREF = "mail.threadpane.cardsview.rowcount";
    const CARD_VIEW_ROW_COUNT_FOR_SNIPPETS = 3;

    function _getCardViewRowCount() {
      try {
        return ServicesML.prefs.getIntPref(CARD_VIEW_ROW_COUNT_PREF);
      } catch (_) {
        return 2; // Default TB value
      }
    }

    let _snippetForceDisableLogged = false;
    function _snippetsContentEnabled() {
      if (CARD_SNIPPET_CONFIG.forceDisableInjection === true) {
        if (!_snippetForceDisableLogged) {
          _snippetForceDisableLogged = true;
          console.log(
            `${CARD_SNIPPET_CONFIG.logPrefix} FORCE DISABLED: snippet fetch/injection is disabled for debugging`
          );
        }
        return false;
      }
      // Snippets are enabled when card view row count == 3
      return _getCardViewRowCount() === CARD_VIEW_ROW_COUNT_FOR_SNIPPETS;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TAG COLORING
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Resolves the effective tag color for a header, using persistence cache to prevent blinks.
     * @param {nsIMsgDBHdr} hdr 
     * @returns {string|null} CSS color string or null (if transparent/none)
     */
    function resolveTagColor(hdr) {
      if (!hdr) return null;

      // 1. Get current keywords from header
      let keywords = null;
      try { keywords = hdr.getStringProperty && hdr.getStringProperty("keywords") || null; } catch (_) {}
      const kw = keywords ? keywords.split(/\s+/).filter(Boolean) : [];

      // 2. Resolve current color from keywords
      let color = null;
      for (const k of TM_ACTION_TAG_KEY_PRIORITY) {
        try {
          if (!kw.includes(k)) continue;
          color = MailServicesML?.tags?.getColorForKey
            ? (MailServicesML.tags.getColorForKey(k) || null)
            : null;
          if (color) break;
        } catch (_) { color = null; }
      }

      const now = Date.now();
      const messageId = hdr.messageId;

      // 3. If we found a valid color, update cache and return it
      if (color) {
        if (messageId) {
          TagPersistenceCache.set(messageId, { color, time: now });
        }
        return color;
      }

      // 4. If NO color found, check persistence cache to mask blink
      if (messageId && TagPersistenceCache.has(messageId)) {
        const entry = TagPersistenceCache.get(messageId);
        if (now - entry.time < TAG_PERSISTENCE_DURATION_MS) {
          return entry.color;
        } else {
          TagPersistenceCache.delete(messageId);
        }
      }

      // 5. Fallback: use tm_untagged color
      return paletteData?.TAG_COLORS?.tm_untagged || null;
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
      // Card View: either mail-message-list exists OR [is="thread-card"] rows exist
      return !!(cdoc.querySelector("mail-message-list") || cdoc.querySelector('[is="thread-card"]'));
    }

    function enumerateContentDocs(win) {
      const docs = [];
      try {
        const tabmail = win.document.getElementById("tabmail");
        const about3Pane = tabmail?.currentAbout3Pane || tabmail?.currentTabInfo?.chromeBrowser?.contentWindow || null;
        if (about3Pane?.document) docs.push(about3Pane.document);
        
        // Check other tabs
        const numTabs = tabmail?.tabInfo?.length || 0;
        for (let i = 0; i < numTabs; i++) {
          try {
            const info = tabmail.tabInfo[i];
            const cw = info?.chromeBrowser?.contentWindow || info?.browser?.contentWindow || null;
            if (cw?.document && !docs.includes(cw.document)) docs.push(cw.document);
          } catch (_) {}
        }
      } catch (_) {}
      // Diagnostic: log which docs we enumerated (bounded)
      try {
        const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
        let countLogged = false;
        try {
          const c = Number(win.__tmMsgList?.__tmEnumerateDocsCountLogs || 0);
          if (c < max) {
            win.__tmMsgList = win.__tmMsgList || {};
            win.__tmMsgList.__tmEnumerateDocsCountLogs = c + 1;
            console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] enumerateContentDocs count`, {
              count: docs.length,
            });
            countLogged = true;
          }
        } catch (_) {}
        let logged = 0;
        for (const d of docs) {
          if (!d) continue;
          d.__tmMsgList = d.__tmMsgList || {};
          const c = Number(d.__tmMsgList.__tmEnumerateDocsLogs || 0);
          if (c >= max) continue;
          d.__tmMsgList.__tmEnumerateDocsLogs = c + 1;
          const href = "";
          let hasTree = false;
          let cardView = false;
          try { hasTree = !!d.getElementById("threadTree"); } catch (_) {}
          try { cardView = isCardView(d); } catch (_) {}
          try { console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] enumerateContentDocs`, {
            href: d?.location?.href || href,
            readyState: d?.readyState || "",
            hasThreadTree: hasTree,
            isCardView: cardView,
          }); } catch (_) {}
          logged += 1;
          if (logged >= max) break;
        }
      } catch (_) {}
      return docs;
    }

    function getCurrentContentWin(win) {
      try {
        const tabmail = win?.document?.getElementById?.("tabmail");
        return tabmail?.currentAbout3Pane ||
          tabmail?.currentTabInfo?.chromeBrowser?.contentWindow ||
          tabmail?.currentTabInfo?.browser?.contentWindow ||
          null;
      } catch (_) {
        return null;
      }
    }

    function getFolderFromDoc(doc, tree = null) {
      try {
        const win = doc?.defaultView || null;
        const view = tree?.view || win?.gDBView || win?.gFolderDisplay?.view?.dbView || null;
        const folder =
          view?.viewFolder ||
          view?.displayedFolder ||
          win?.gFolderDisplay?.displayedFolder ||
          tree?.view?.dbView?.folder ||
          tree?.view?.folder ||
          null;
        return folder || null;
      } catch (_) {
        return null;
      }
    }

    function _diagSampleHdrFromTree(doc, tree) {
      try {
        if (!doc || !tree) return null;
        const idx = Number(doc.__tmMsgList?.__tmCardSnippetIndexRange?.minIdx);
        if (!Number.isFinite(idx)) return null;
        const hdr = _getHdrForRowIndex(tree, idx);
        if (!hdr) return null;
        const hdrKey = getHdrKey(hdr);
        const hasFolder = !!hdr?.folder;
        return {
          idx,
          hdrKey,
          hasFolder,
          subject: _safeText(hdr?.subject || "").slice(0, Number(CARD_SNIPPET_CONFIG?.maxChars) || 0),
        };
      } catch (_) {
        return null;
      }
    }

    function attachMessageListEventHooks(win, reason = "init") {
      try {
        if (!win) return;
        const tabmail = win.document.getElementById("tabmail");
        const contentWin = getCurrentContentWin(win);

        if (contentWin && !contentWin.__tmMessageListFolderURIHandler) {
          contentWin.__tmMessageListFolderURIHandler = () => {
            try {
              const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
              const c = Number(contentWin.__tmMsgList?.__tmFolderURIEventLogs || 0);
              if (c < max) {
                contentWin.__tmMsgList = contentWin.__tmMsgList || {};
                contentWin.__tmMsgList.__tmFolderURIEventLogs = c + 1;
                console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] folderURIChanged`, {
                  reason,
                  href: contentWin?.location?.href || "",
                  readyState: contentWin?.document?.readyState || "",
                });
              }
            } catch (_) {}
            try {
              const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
              const c = Number(contentWin.__tmMsgList?.__tmFolderURIEventSummaryLogs || 0);
              if (c < max) {
                contentWin.__tmMsgList = contentWin.__tmMsgList || {};
                contentWin.__tmMsgList.__tmFolderURIEventSummaryLogs = c + 1;
                const tree = contentWin.document?.getElementById?.("threadTree") || contentWin.document?.querySelector?.("tree-view#threadTree, tree-view") || null;
                const folder = getFolderFromDoc(contentWin.document, tree);
                console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] folderURIChanged summary`, {
                  href: contentWin?.location?.href || "",
                  hasTree: !!tree,
                  rowCount: tree ? contentWin.document?.querySelectorAll?.('[is="thread-card"]')?.length || 0 : 0,
                  sample: _diagSampleHdrFromTree(contentWin.document, tree),
                });
              }
            } catch (_) {}
            ensureMessageListEnhancements(win);
            try {
              const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
              const c = Number(contentWin.__tmMsgList?.__tmFolderURIApplyLogs || 0);
              if (c < max) {
                contentWin.__tmMsgList = contentWin.__tmMsgList || {};
                contentWin.__tmMsgList.__tmFolderURIApplyLogs = c + 1;
                console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] folderURIChanged applySnippetsToDoc`, {
                  enabled: CARD_SNIPPET_CONFIG.enabled,
                  contentEnabled: _snippetsContentEnabled(),
                  hasDoc: !!contentWin?.document,
                });
              }
            } catch (_) {}
            try { applySnippetsToDoc(contentWin.document); } catch (_) {}
            try { attachCardSnippetObserver(contentWin.document); } catch (_) {}
          };
          contentWin.addEventListener("folderURIChanged", contentWin.__tmMessageListFolderURIHandler);
        }

        if (contentWin && !contentWin.__tmMessageListThreadPaneHandler) {
          contentWin.__tmMessageListThreadPaneHandler = () => {
            try {
              const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
              const c = Number(contentWin.__tmMsgList?.__tmThreadPaneEventLogs || 0);
              if (c < max) {
                contentWin.__tmMsgList = contentWin.__tmMsgList || {};
                contentWin.__tmMsgList.__tmThreadPaneEventLogs = c + 1;
                console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] threadpane-loaded`, { reason });
              }
            } catch (_) {}
            ensureMessageListEnhancements(win);
          };
          contentWin.addEventListener("threadpane-loaded", contentWin.__tmMessageListThreadPaneHandler);
        }

        if (tabmail?.tabContainer && !win.__tmMessageListTabSelectHandler) {
          win.__tmMessageListTabSelectHandler = () => {
            try {
              const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
              const c = Number(win.__tmMsgList?.__tmTabSelectEventLogs || 0);
              if (c < max) {
                win.__tmMsgList = win.__tmMsgList || {};
                win.__tmMsgList.__tmTabSelectEventLogs = c + 1;
                console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] TabSelect`, { reason });
              }
            } catch (_) {}
            attachMessageListEventHooks(win, "TabSelect");
            ensureMessageListEnhancements(win);
          };
          tabmail.tabContainer.addEventListener("TabSelect", win.__tmMessageListTabSelectHandler);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} attachMessageListEventHooks failed:`, e);
      }
    }

    function detachMessageListEventHooks(win) {
      try {
        if (!win) return;
        const tabmail = win.document.getElementById("tabmail");
        if (tabmail?.tabContainer && win.__tmMessageListTabSelectHandler) {
          try {
            tabmail.tabContainer.removeEventListener("TabSelect", win.__tmMessageListTabSelectHandler);
          } catch (_) {}
          delete win.__tmMessageListTabSelectHandler;
        }

        try {
          const contentDocs = enumerateContentDocs(win);
          for (const cdoc of contentDocs) {
            const cw = cdoc?.defaultView;
            if (!cw) continue;
            if (cw.__tmMessageListFolderURIHandler) {
              try { cw.removeEventListener("folderURIChanged", cw.__tmMessageListFolderURIHandler); } catch (_) {}
              delete cw.__tmMessageListFolderURIHandler;
            }
            if (cw.__tmMessageListThreadPaneHandler) {
              try { cw.removeEventListener("threadpane-loaded", cw.__tmMessageListThreadPaneHandler); } catch (_) {}
              delete cw.__tmMessageListThreadPaneHandler;
            }
          }
        } catch (_) {}
      } catch (e) {
        console.error(`${LOG_PREFIX} detachMessageListEventHooks failed:`, e);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CARD SNIPPETS
    // ═══════════════════════════════════════════════════════════════════════

    // Diagnostic counter for snippet logging
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

    /**
     * Normalize preview text for display (minimal cleanup since TB already does the heavy lifting).
     */
    function normalizePreviewText(text) {
      if (!text) return "";
      let t = String(text).replace(/\0/g, "");
      t = t.replace(/\s+/g, " ").trim();
      if (t.length > CARD_SNIPPET_CONFIG.maxChars) {
        t = t.slice(0, CARD_SNIPPET_CONFIG.maxChars).trim();
      }
      return t;
    }

    function _getFolderUri(folder) {
      try {
        return String(folder?.URI || folder?.uri || "");
      } catch (_) {
        return "";
      }
    }

    async function getOrFetchSnippet(hdr) {
      if (!hdr) return "";
      if (!_snippetsContentEnabled()) return "";

      const key = getHdrKey(hdr);
      const now = Date.now();
      const cfg = CARD_SNIPPET_CONFIG?.previewFetch || {};

      // Try hdr properties (fast path - TB may have already computed the preview)
      const props = ["preview", "snippet", "summary"];
      for (const prop of props) {
        try {
          const val = hdr.getStringProperty?.(prop);
          if (val && val.trim()) {
            return normalizePreviewText(val);
          }
        } catch (_) {}
      }

      // IMPORTANT: We intentionally do NOT call fetchMsgPreviewText here anymore.
      // Gmail-style IMAP folders (e.g. [Gmail]/All Mail) often return preview="" even after fetch,
      // causing persistent "holes". We rely on MV3-side snippet provider (getFull cache + native FTS)
      // to provide snippets directly (no experiment-side cache).
      return "";
    }

    function getSnippetText(hdr) {
      // Synchronous version - just checks hdr properties (for MutationObserver callbacks)
      if (!hdr) return "";
      if (!_snippetsContentEnabled()) return "";
      
      // Check hdr properties first (TB may have already computed the preview)
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

    function _safeText(s) {
      try {
        return String(s || "").replace(/\s+/g, " ").trim();
      } catch (_) {
        return "";
      }
    }

    function _extractAuthorNeedles(hdr) {
      try {
        const authorRaw = _safeText(hdr?.mime2DecodedAuthor || hdr?.author || "");
        const emailMatch = authorRaw.match(/<([^>]+)>/);
        const email = _safeText(emailMatch?.[1] || "");
        const name = _safeText(authorRaw.replace(/<[^>]+>/g, "").replace(/^\"|\"$/g, ""));
        const needles = [];
        if (email) needles.push(email.toLowerCase());
        if (name) needles.push(name.toLowerCase());
        if (authorRaw) needles.push(authorRaw.toLowerCase());
        return needles.filter(Boolean);
      } catch (_) {
        return [];
      }
    }

    function _applySenderScaleToRow(row, hdr) {
      try {
        if (!row || !hdr) return;
        if (row.getAttribute?.("is") !== "thread-card") return;

        const hdrKey = getHdrKey(hdr);
        const needles = _extractAuthorNeedles(hdr);
        if (!needles.length) return;

        // If we previously marked a sender for another message, remove it.
        try {
          const old = row.querySelectorAll?.(`.${CARD_SENDER_CONFIG.className}`);
          for (const el of old || []) {
            try {
              const oldKey = el.getAttribute?.("data-tm-hdr-key") || "";
              if (oldKey && hdrKey && oldKey !== hdrKey) {
                el.classList.remove(CARD_SENDER_CONFIG.className);
                el.removeAttribute?.("data-tm-hdr-key");
              }
            } catch (_) {}
          }
        } catch (_) {}

        const container = row.querySelector?.(".card-container") || row;
        const avoidTags = new Set(["TR", "TD", "TBODY", "THEAD", "TFOOT", "TABLE"]);

        let best = null;
        let bestScore = -Infinity;

        const els = Array.from(container.querySelectorAll?.("*") || []).slice(0, 220);
        for (const el of els) {
          try {
            const tag = String(el.tagName || "");
            if (avoidTags.has(tag)) continue;
            if (el.classList?.contains?.(CARD_SNIPPET_CONFIG.className)) continue;

            const cls = String(el.className || "");
            // Don't accidentally target the subject block
            if (/subject/i.test(cls)) continue;

            const t = _safeText(el.textContent).toLowerCase();
            if (!t) continue;
            if (t.length > 160) continue;

            let contains = 0;
            for (const needle of needles) {
              if (needle && t.includes(needle)) {
                contains = 1;
                break;
              }
            }
            if (!contains) continue;

            const depth = _elementDepthWithin(container, el);
            const depthBonus = Math.min(20, depth) / 4;
            const leafish = (el.children?.length || 0) === 0 ? 1 : 0;
            const leafBonus = leafish ? 1.2 : 0;
            const lenPenalty = Math.min(160, t.length) / 60;
            const clsBonus = /(from|sender|author|correspondent)/i.test(cls) ? 1.5 : 0;

            const score = 6 + depthBonus + leafBonus + clsBonus - lenPenalty;
            if (score > bestScore) {
              bestScore = score;
              best = el;
            }
          } catch (_) {}
        }

        if (!best) return;

        best.classList.add(CARD_SENDER_CONFIG.className);
        try { best.setAttribute("data-tm-hdr-key", hdrKey || ""); } catch (_) {}

        try {
          const doc = row.ownerDocument;
          doc.__tmMsgList = doc.__tmMsgList || {};
          const c = doc.__tmMsgList.__tmCardSenderLogs || 0;
          if (c < CARD_SENDER_CONFIG.maxLogs) {
            doc.__tmMsgList.__tmCardSenderLogs = c + 1;
            console.log(`${CARD_SENDER_CONFIG.logPrefix} marked`, {
              rowId: row.id,
              senderTag: best.tagName,
              senderClass: best.className,
              senderTextSample: _safeText(best.textContent).slice(0, 60),
            });
          }
        } catch (_) {}
      } catch (_) {}
    }

    function _elementDepthWithin(root, el) {
      try {
        let d = 0;
        let cur = el;
        while (cur && cur !== root) {
          cur = cur.parentElement;
          d += 1;
          if (d > 2000) break;
        }
        return d;
      } catch (_) {
        return 0;
      }
    }

    function _probeCardRowOnce(row, hdr) {
      try {
        const doc = row?.ownerDocument;
        if (!doc) return;
        doc.__tmMsgList = doc.__tmMsgList || {};
        const c = doc.__tmMsgList.__tmCardSnippetProbeCount || 0;
        if (c >= 3) return;
        doc.__tmMsgList.__tmCardSnippetProbeCount = c + 1;

        const container = row.querySelector(".card-container");
        const hasShadow = !!container?.shadowRoot;
        const subj = _safeText(hdr?.subject || "");

        const candidates = [];
        const els = Array.from(row.querySelectorAll("*")).slice(0, 160);
        for (const el of els) {
          const cls = String(el.className || "");
          const dcn = el.getAttribute?.("data-column-name") || "";
          if (/subject/i.test(cls) || dcn === "subjectcol") {
            candidates.push({
              tag: el.tagName,
              className: cls,
              dataColumnName: dcn,
              textSample: _safeText(el.textContent).slice(0, 60),
            });
            if (candidates.length >= 8) break;
          }
        }

        console.log(`${CARD_SNIPPET_CONFIG.logPrefix} probeCardRow`, {
          rowId: row.id,
          hasCardContainer: !!container,
          cardContainerTag: container?.tagName,
          cardContainerClass: container?.className,
          cardContainerHasShadow: hasShadow,
          subject: subj.slice(0, 80),
          candidateCount: candidates.length,
          candidates,
        });
      } catch (_) {}
    }

    function findSubjectElement(row, hdr) {
      // First check light DOM
      for (const sel of CARD_SNIPPET_CONFIG.subjectSelectors) {
        try {
          const el = row.querySelector(sel);
          if (el) return el;
        } catch (_) {}
      }

      // Check inside card-container (light DOM)
      const container = row.querySelector(".card-container");
      if (container) {
        for (const sel of CARD_SNIPPET_CONFIG.subjectSelectors) {
          try {
            const el = container.querySelector(sel);
            if (el) return el;
          } catch (_) {}
        }
        // Check card-container shadowRoot (TB can render internals there)
        try {
          const sr = container.shadowRoot;
          if (sr) {
            for (const sel of CARD_SNIPPET_CONFIG.subjectSelectors) {
              try {
                const el = sr.querySelector(sel);
                if (el) return el;
              } catch (_) {}
            }
          }
        } catch (_) {}
      }

      // Heuristic: match by subject text
      try {
        const subj = _safeText(hdr?.subject || "");
        if (subj) {
          // Prefer explicit "subject-ish" nodes over generic containers like td/div.
          const avoidTags = new Set(["TR", "TD", "TBODY", "THEAD", "TFOOT", "TABLE"]);

          const subjectish = [];
          const els = Array.from(row.querySelectorAll("*")).slice(0, 400);
          for (const el of els) {
            try {
              const cls = String(el.className || "");
              const dcn = el.getAttribute?.("data-column-name") || "";
              if (/subject/i.test(cls) || dcn === "subjectcol") {
                subjectish.push(el);
              }
            } catch (_) {}
          }

          // If we found subject-ish candidates, pick the best leaf-ish one.
          if (subjectish.length) {
            let best = null;
            let bestScore = -Infinity;
            for (const el of subjectish) {
              const tag = String(el.tagName || "");
              if (avoidTags.has(tag)) continue;
              const t = _safeText(el.textContent);
              if (!t) continue;
              // Prefer nodes that contain the subject and aren't too long (avoid the whole card).
              const contains = t.includes(subj) ? 1 : 0;
              const lenPenalty = Math.min(300, t.length) / 60;
              const depth = _elementDepthWithin(row, el);
              const depthBonus = Math.min(20, depth) / 4;
              const classBonus = /card-subject/i.test(String(el.className || "")) ? 2 : 0;
              const score = contains * 6 + depthBonus + classBonus - lenPenalty;
              if (score > bestScore) {
                bestScore = score;
                best = el;
              }
            }
            if (best) return best;
          }

          // Fallback: any element whose text includes the subject, but avoid container tags.
          for (const el of els) {
            const tag = String(el.tagName || "");
            if (avoidTags.has(tag)) continue;
            const t = _safeText(el.textContent);
            if (t && t.length <= 200 && t.includes(subj)) return el;
          }
        }
      } catch (_) {}

      _probeCardRowOnce(row, hdr);
      return null;
    }

    function _insertSnippetNearSubject({ row, subjectEl, snippetEl }) {
      // Insert snippet *near* the subject without breaking TB card layout.
      // Prefer: after the subject element within the card container; otherwise append to card container.
      try {
        const container = row.querySelector(".card-container");
        if (!container) {
          subjectEl.appendChild(snippetEl);
          return true;
        }

        // If subjectEl is a leaf-ish node, insert after it in the same parent.
        const leafish = (subjectEl.children?.length || 0) === 0;
        const parent = subjectEl.parentNode;
        const parentIsContainer = parent && (parent === container || (parent.nodeType === 1 && container.contains(parent)));

        if (leafish && parentIsContainer && parent?.insertBefore) {
          // Insert directly after subjectEl within its parent
          const next = subjectEl.nextSibling;
          if (next) parent.insertBefore(snippetEl, next);
          else parent.appendChild(snippetEl);
          return true;
        }

        // Otherwise, append inside the subject element (safe for container-ish subject blocks).
        try {
          subjectEl.appendChild(snippetEl);
          return true;
        } catch (_) {}

        // Final fallback: append to card container.
        container.appendChild(snippetEl);
        return true;
      } catch (_) {
        return false;
      }
    }

    function findSnippetHost(row, hdr) {
      try {
        // Prefer the built-in "thread card button" row area.
        // In 3-row card view, this becomes a stable slot we can repurpose for our single-line snippet.
        const btn = row.querySelector?.(".thread-card-button") || null;
        if (btn) return btn;
      } catch (_) {}
      // Fallback to card container
      try {
        const container = row.querySelector?.(".card-container") || null;
        if (container) return container;
      } catch (_) {}
      return null;
    }

    function applySnippetToRow(row, hdr, doc) {
      // Synchronous version - uses cached snippets only
      if (!CARD_SNIPPET_CONFIG.enabled) return;
      if (!_snippetsContentEnabled()) return;
      if (!row || !hdr) return;
      if (!row.hasAttribute("is") || row.getAttribute("is") !== "thread-card") return;

      const host = findSnippetHost(row, hdr);
      if (!host) {
        _probeCardRowOnce(row, hdr);
        return;
      }

      // Diagnostic: if our host is hidden, log once so we know snippets are being applied but not visible.
      try {
        if (host?.classList?.contains("thread-card-button")) {
          doc.__tmMsgList = doc.__tmMsgList || {};
          const c = Number(doc.__tmMsgList.__tmCardSnippetHostHiddenLogs || 0);
          const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
          if (c < max) {
            const cs = doc.defaultView?.getComputedStyle?.(host);
            if (cs && (cs.display === "none" || cs.visibility === "hidden")) {
              doc.__tmMsgList.__tmCardSnippetHostHiddenLogs = c + 1;
              console.log(`${CARD_SNIPPET_CONFIG.logPrefix} host hidden`, {
                rowId: row.id,
                display: cs.display,
                visibility: cs.visibility,
              });
            }
          }
        }
      } catch (_) {}

      const existingSnippet = host.querySelector?.(`.${CARD_SNIPPET_CONFIG.className}`) || null;
      const snippet = getSnippetText(hdr);
      const hdrKey = getHdrKey(hdr);

      // If no snippet yet, still create an empty snippet node when using the thread-card-button host.
      // This "claims" the 3-row slot without affecting row height calculation (TB owns the row count).
      if (!snippet && !existingSnippet) {
        try {
          if (host?.classList?.contains("thread-card-button")) {
            const snippetEl = doc.createElement("div");
            snippetEl.className = CARD_SNIPPET_CONFIG.className;
            try { snippetEl.setAttribute("data-tm-hdr-key", hdrKey || ""); } catch (_) {}
            snippetEl.textContent = "";
            try { host.appendChild(snippetEl); } catch (_) {}
          }
        } catch (_) {}
        _applySenderScaleToRow(row, hdr);
        return;
      }
      // If row was recycled to a different message, drop the old snippet.
      if (existingSnippet) {
        const oldKey = existingSnippet.getAttribute("data-tm-hdr-key") || "";
        if (oldKey && hdrKey && oldKey !== hdrKey) {
          try {
            doc.__tmMsgList = doc.__tmMsgList || {};
            const c = Number(doc.__tmMsgList.__tmCardSnippetRowRecycleLogs || 0);
            const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
            if (c < max) {
              doc.__tmMsgList.__tmCardSnippetRowRecycleLogs = c + 1;
              console.log(`${CARD_SNIPPET_CONFIG.logPrefix} Row recycled: dropping old snippet`, {
                rowId: row.id,
                oldKey,
                newKey: hdrKey,
                subject: _safeText(hdr?.subject || "").slice(0, 60),
              });
            }
          } catch (_) {}
          try { existingSnippet.remove(); } catch (_) {}
        }
      }
      // Reuse the existing snippet element when possible to reduce DOM churn (prevents scroll jank).
      if (existingSnippet && existingSnippet.textContent === snippet) return;
      if (!snippet) return;

      const text = snippet.length > CARD_SNIPPET_CONFIG.maxChars
        ? snippet.slice(0, CARD_SNIPPET_CONFIG.maxChars).trim()
        : snippet;

      if (existingSnippet && existingSnippet.isConnected) {
        try { existingSnippet.setAttribute("data-tm-hdr-key", hdrKey || ""); } catch (_) {}
        try { existingSnippet.textContent = text; } catch (_) {}
      } else {
        const snippetEl = doc.createElement("div");
        snippetEl.className = CARD_SNIPPET_CONFIG.className;
        try { snippetEl.setAttribute("data-tm-hdr-key", hdrKey || ""); } catch (_) {}
        snippetEl.textContent = text;
        try { host.appendChild(snippetEl); } catch (_) {}
      }
      _applySenderScaleToRow(row, hdr);
    }

    async function applySnippetToRowAsync(row, hdr, doc) {
      // Async version - fetches body if needed
      if (!CARD_SNIPPET_CONFIG.enabled) return false;
      if (!_snippetsContentEnabled()) return false;
      if (!row || !hdr) return false;
      if (!row.hasAttribute("is") || row.getAttribute("is") !== "thread-card") return false;

      const snippet = await getOrFetchSnippet(hdr);
      if (!snippet) return false;
      const hdrKey = getHdrKey(hdr);

      // Check if row still exists in DOM
      if (!row.isConnected) return false;

      // IMPORTANT: re-validate that this DOM row still represents the same message.
      // TB virtualizes/recycles rows; async preview completion can race with row reuse.
      try {
        const tree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
        const idx = _rowIndexFromRowId(row.id);
        if (tree && idx >= 0) {
          const currentHdr = _getHdrForRowIndex(tree, idx);
          const currentKey = currentHdr ? getHdrKey(currentHdr) : "";
          if (currentKey && hdrKey && currentKey !== hdrKey) {
            try {
              const diagBudget = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
              doc.__tmMsgList = doc.__tmMsgList || {};
              const c = doc.__tmMsgList.__tmCardSnippetRowMismatchLogs || 0;
              if (c < diagBudget) {
                doc.__tmMsgList.__tmCardSnippetRowMismatchLogs = c + 1;
                console.log(`${CARD_SNIPPET_CONFIG.logPrefix} Row recycled before async apply; skipping`, {
                  rowId: row.id,
                  expectedSubject: _safeText(hdr?.subject || "").slice(0, 40),
                  currentSubject: _safeText(currentHdr?.subject || "").slice(0, 40),
                });
              }
            } catch (_) {}
            return false;
          }
        }
      } catch (_) {}

      const host = findSnippetHost(row, hdr);
      if (!host) {
        _probeCardRowOnce(row, hdr);
        return false;
      }

      const existingSnippet = host.querySelector?.(`.${CARD_SNIPPET_CONFIG.className}`) || null;
      if (existingSnippet) {
        const oldKey = existingSnippet.getAttribute("data-tm-hdr-key") || "";
        if (oldKey && hdrKey && oldKey !== hdrKey) {
          try {
            const diagBudget = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
            doc.__tmMsgList = doc.__tmMsgList || {};
            const c = doc.__tmMsgList.__tmCardSnippetRowRecycleAsyncLogs || 0;
            if (c < diagBudget) {
              doc.__tmMsgList.__tmCardSnippetRowRecycleAsyncLogs = c + 1;
              console.log(`[TMDBG SnippetDiag][EXP] ${CARD_SNIPPET_CONFIG.logPrefix} Row recycled (async): dropping old snippet`, {
                rowId: row.id,
                oldKey,
                newKey: hdrKey,
                subject: _safeText(hdr?.subject || "").slice(0, 60),
              });
            }
          } catch (_) {}
          try { existingSnippet.remove(); } catch (_) {}
        }
      }
      if (existingSnippet && existingSnippet.textContent === snippet) return false;

      const text = snippet.length > CARD_SNIPPET_CONFIG.maxChars
        ? snippet.slice(0, CARD_SNIPPET_CONFIG.maxChars).trim()
        : snippet;

      if (existingSnippet && existingSnippet.isConnected) {
        try { existingSnippet.setAttribute("data-tm-hdr-key", hdrKey || ""); } catch (_) {}
        try { existingSnippet.textContent = text; } catch (_) {}
      } else {
        const snippetEl = doc.createElement("div");
        snippetEl.className = CARD_SNIPPET_CONFIG.className;
        try { snippetEl.setAttribute("data-tm-hdr-key", hdrKey || ""); } catch (_) {}
        snippetEl.textContent = text;
        try { host.appendChild(snippetEl); } catch (_) {}
      }
      _applySenderScaleToRow(row, hdr);

      try {
        if (snippetDiagCount < SNIPPET_DIAG_MAX) {
          snippetDiagCount++;
          console.log(`${CARD_SNIPPET_CONFIG.logPrefix} Inserted snippet`, {
            rowId: row.id,
            hostTag: host?.tagName,
            hostClass: host?.className,
            snippetSample: snippet.slice(0, 60),
          });
        }
      } catch (_) {}
      return true;
    }

    async function applySnippetsToDoc(doc) {
      // Unbounded diagnostic: always log entry
      console.log(`[TMDBG SnippetDiag][EXP] ${CARD_SNIPPET_CONFIG.logPrefix} applySnippetsToDoc ENTRY`, {
        enabled: CARD_SNIPPET_CONFIG.enabled,
        contentEnabled: _snippetsContentEnabled(),
        hasDoc: !!doc,
        isBusy: isBusy(doc),
        isApplying: !!doc?.__tmCardSnippetApplying,
      });

      if (!CARD_SNIPPET_CONFIG.enabled) return;
      if (!_snippetsContentEnabled()) return;
      if (!doc) return;
      if (isBusy(doc)) return;

      // Guard: avoid re-entrancy and self-triggered MutationObserver loops.
      try {
        if (doc.__tmCardSnippetApplying) return;
        doc.__tmCardSnippetApplying = true;
      } catch (_) {}

      const tree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
      if (!tree) {
        try { doc.__tmCardSnippetApplying = false; } catch (_) {}
        return;
      }

      const rows = Array.from(doc.querySelectorAll('[is="thread-card"]'));
      if (!rows.length) {
        try { doc.__tmCardSnippetApplying = false; } catch (_) {}
        return;
      }

      // Folder-specific diagnostics removed: snippet application is row-driven only.

      // Throttle apply passes to avoid spam and scroll churn.
      try {
        const minInterval = Number(CARD_SNIPPET_CONFIG?.reapply?.minApplyIntervalMs) || 0;
        const now = Date.now();
        const last = Number(doc.__tmCardSnippetLastApplyMs || 0);
        if (minInterval > 0 && (now - last) < minInterval) {
          try { doc.__tmCardSnippetApplying = false; } catch (_) {}
          return;
        }
        doc.__tmCardSnippetLastApplyMs = now;
      } catch (_) {}

      // IMPORTANT: Do not write threadTree.scrollTop at all.
      // TB handles selection scrolling; our CSS-reserved space keeps row height stable.

      // Only consider rows in/near the current viewport (by row index buffer).
      const bufferRows = Number(CARD_SNIPPET_CONFIG?.reapply?.viewportBufferRows) || 0;
      let treeRect = null;
      try { treeRect = tree.getBoundingClientRect?.() || null; } catch (_) {}
      const visibleRows = [];
      let visibleMinIdx = Infinity;
      let visibleMaxIdx = -Infinity;
      if (treeRect) {
        // First pass: find min/max visible indices in viewport.
        for (const row of rows) {
          try {
            const r = row.getBoundingClientRect?.();
            if (!r) continue;
            const inViewport = r.bottom >= treeRect.top && r.top <= treeRect.bottom;
            if (!inViewport) continue;
            const idx = _rowIndexFromRowId(row.id);
            if (idx >= 0) {
              if (idx < visibleMinIdx) visibleMinIdx = idx;
              if (idx > visibleMaxIdx) visibleMaxIdx = idx;
            }
          } catch (_) {}
        }
        if (Number.isFinite(visibleMinIdx) && Number.isFinite(visibleMaxIdx)) {
          const minIdx = Math.max(0, visibleMinIdx - bufferRows);
          const maxIdx = visibleMaxIdx + bufferRows;
          // Second pass: include buffer rows by index (no rect checks; stable across styles).
          const inViewport = [];
          const aboveViewport = [];
          const belowViewport = [];
          for (const row of rows) {
            const idx = _rowIndexFromRowId(row.id);
            if (idx < 0) continue;
            if (idx >= minIdx && idx <= maxIdx) {
              if (idx >= visibleMinIdx && idx <= visibleMaxIdx) {
                inViewport.push({ row, idx });
              } else if (idx < visibleMinIdx) {
                aboveViewport.push({ row, idx });
              } else {
                belowViewport.push({ row, idx });
              }
            }
          }
          // Sort: viewport rows top-to-bottom, then buffer rows by distance from viewport
          inViewport.sort((a, b) => a.idx - b.idx);
          aboveViewport.sort((a, b) => b.idx - a.idx); // closest to viewport first (higher idx first)
          belowViewport.sort((a, b) => a.idx - b.idx); // closest to viewport first (lower idx first)
          visibleRows.push(...inViewport.map(r => r.row));
          visibleRows.push(...aboveViewport.map(r => r.row));
          visibleRows.push(...belowViewport.map(r => r.row));
          // Store range for MutationObserver filtering.
          doc.__tmMsgList = doc.__tmMsgList || {};
          doc.__tmMsgList.__tmCardSnippetIndexRange = { minIdx, maxIdx, bufferRows };
        }
      } else {
        // If we can't compute bounds, fall back to current rows list (still capped by fetch limits).
        visibleRows.push(...rows);
      }

      // Unbounded log: confirm we've passed all guards and are about to process rows
      console.log(`[TMDBG SnippetDiag][EXP] ${CARD_SNIPPET_CONFIG.logPrefix} applySnippetsToDoc entering loop`, {
        rowsTotal: rows.length,
        visibleRows: visibleRows.length,
      });

      try {
        const diagBudget = Number(CARD_SNIPPET_CONFIG.maxDiagnostics) || 0;
        doc.__tmMsgList = doc.__tmMsgList || {};
        const c = doc.__tmMsgList.__tmCardSnippetViewportLogs || 0;
        if (c < diagBudget) {
          doc.__tmMsgList.__tmCardSnippetViewportLogs = c + 1;
          console.log(`${CARD_SNIPPET_CONFIG.logPrefix} viewport filter`, {
            totalCardRows: rows.length,
            nearViewportRows: visibleRows.length,
            bufferRows,
            visibleMinIdx: Number.isFinite(visibleMinIdx) ? visibleMinIdx : null,
            visibleMaxIdx: Number.isFinite(visibleMaxIdx) ? visibleMaxIdx : null,
          });
        }
      } catch (_) {}

      // Collect rows that need async fetching
      const rowsToFetch = [];
      let syncApplied = 0;
      let syncCached = 0;
      let syncHostMissing = 0;
      let syncMissingAfterApply = 0;
      let syncHostHidden = 0;
      const syncSamples = [];
      let diagHdrMissingFolder = 0;
      let diagHdrMissingKey = 0;
      const diagHdrSamples = [];
      const syncDiagMax = Math.max(0, Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0);

      for (const row of visibleRows) {
        try {
          const match = row.id?.match?.(/threadTree-row(\d+)/);
          if (!match) continue;
          const rowIndex = parseInt(match[1], 10);
          if (isNaN(rowIndex)) continue;

          let hdr = null;
          try { if (typeof tree?.view?.getMsgHdrAt === "function") hdr = tree.view.getMsgHdrAt(rowIndex); } catch(_) {}
          if (!hdr) { try { if (typeof tree?.view?.getMessageHdrAt === "function") hdr = tree.view.getMessageHdrAt(rowIndex); } catch(_) {} }
          if (!hdr) { try { if (typeof tree?.view?.dbView?.hdrForRow === "function") hdr = tree.view.dbView.hdrForRow(rowIndex); } catch(_) {} }
          if (!hdr) continue;

          // Try sync first (from cache or hdr props)
          const { text: cachedSnippet, source: cachedSource } = getSnippetTextWithSource(hdr);

          try {
            if (!hdr?.folder) {
              diagHdrMissingFolder += 1;
              if (diagHdrSamples.length < syncDiagMax) {
                diagHdrSamples.push({
                  rowId: row.id,
                  idx: rowIndex,
                  reason: "hdr-missing-folder",
                  subject: _safeText(hdr?.subject || "").slice(0, Number(CARD_SNIPPET_CONFIG?.maxChars) || 0),
                });
              }
            }
            const hdrKey = getHdrKey(hdr);
            if (!hdrKey) {
              diagHdrMissingKey += 1;
              if (diagHdrSamples.length < syncDiagMax) {
                diagHdrSamples.push({
                  rowId: row.id,
                  idx: rowIndex,
                  reason: "hdr-missing-key",
                  subject: _safeText(hdr?.subject || "").slice(0, Number(CARD_SNIPPET_CONFIG?.maxChars) || 0),
                });
              }
            }
          } catch (_) {}

          // Sample diagnostic: log what getSnippetText returns for first few rows
          try {
            if (syncSamples.length < 4 && !cachedSnippet) {
              syncSamples.push({
                rowId: row.id,
                idx: rowIndex,
                hdrKey: getHdrKey(hdr),
                reason: "no-cached-snippet",
                subject: _safeText(hdr?.subject || "").slice(0, 40),
              });
            }
          } catch (_) {}

          if (cachedSnippet) {
            syncCached += 1;
            applySnippetToRow(row, hdr, doc);
            syncApplied++;

            // Diagnose why a cached snippet might still not render.
            try {
              const host = findSnippetHost(row, hdr);
              if (!host) {
                syncHostMissing += 1;
                if (syncSamples.length < syncDiagMax) {
                  syncSamples.push({
                    rowId: row.id,
                    hdrKey: getHdrKey(hdr),
                    reason: "host-missing",
                  });
                }
              } else {
                try {
                  const cs = doc.defaultView?.getComputedStyle?.(host);
                  if (cs && (cs.display === "none" || cs.visibility === "hidden")) {
                    syncHostHidden += 1;
                  }
                } catch (_) {}
                const el = host.querySelector?.(`.${CARD_SNIPPET_CONFIG.className}`) || null;
                const t = _safeText(el?.textContent || "");
                if (!t) {
                  syncMissingAfterApply += 1;
                  if (syncSamples.length < syncDiagMax) {
                    syncSamples.push({
                      rowId: row.id,
                      hdrKey: getHdrKey(hdr),
                      reason: "snippet-not-present-after-apply",
                      snippetSample: cachedSnippet.slice(0, 60),
                    });
                  }
                }
              }
            } catch (_) {}
          } else {
            // Queue for async fetch
            rowsToFetch.push({ row, hdr });
          }
        } catch (_) {}
      }

      // Always log the apply pass result (bounded)
      try {
        doc.__tmMsgList = doc.__tmMsgList || {};
        const c = Number(doc.__tmMsgList.__tmCardSnippetApplyPassLogs || 0);
        if (c < syncDiagMax) {
          doc.__tmMsgList.__tmCardSnippetApplyPassLogs = c + 1;
          console.log(`[TMDBG SnippetDiag][EXP] ${CARD_SNIPPET_CONFIG.logPrefix} applySnippetsToDoc pass`, {
            visibleRows: visibleRows.length,
            syncCached,
            syncApplied,
            syncHostMissing,
            syncHostHidden,
            syncMissingAfterApply,
            rowsToFetch: rowsToFetch.length,
            sample: syncSamples,
            diagHdrMissingFolder,
            diagHdrMissingKey,
            diagHdrSamples,
          });
        }
      } catch (_) {}

      if (syncApplied > 0) {
        console.log(`${CARD_SNIPPET_CONFIG.logPrefix} Applied ${syncApplied} cached snippets`);
      }

      // Async fetch for rows without cached snippets (limited)
      const maxFetches = Number(CARD_SNIPPET_CONFIG?.previewFetch?.maxFetchesPerPass) || 8;
      const toFetch = rowsToFetch.slice(0, maxFetches);
      
      if (toFetch.length > 0) {
        console.log(`${CARD_SNIPPET_CONFIG.logPrefix} Fetching ${toFetch.length} preview snippets...`);
        
        // Kick async fetches without awaiting sequentially (avoids N× latency).
        for (const { row, hdr } of toFetch) {
          try {
            applySnippetToRowAsync(row, hdr, doc).catch(() => {});
          } catch (_) {}
        }
      }

      // No scroll restoration here by design.
      try { doc.__tmCardSnippetApplying = false; } catch (_) {}
    }

    function attachCardSnippetObserver(doc) {
      try {
        // Bounded diagnostic: log observer attachment attempts
        try {
          doc.__tmMsgList = doc.__tmMsgList || {};
          const c = Number(doc.__tmMsgList.__tmCardSnippetMOAttachLogs || 0);
          const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
          if (c < max) {
            doc.__tmMsgList.__tmCardSnippetMOAttachLogs = c + 1;
            const tree = doc.getElementById("threadTree");
            console.log(`[TMDBG SnippetDiag][EXP] ${CARD_SNIPPET_CONFIG.logPrefix} attachCardSnippetObserver`, {
              enabled: CARD_SNIPPET_CONFIG.enabled,
              contentEnabled: _snippetsContentEnabled(),
              alreadyAttached: !!doc.__tmCardSnippetMO,
              hasTree: !!tree,
            });
          }
        } catch (_) {}

        if (!CARD_SNIPPET_CONFIG.enabled) return;
        if (!_snippetsContentEnabled()) return;
        if (!doc) return;
        if (doc.__tmCardSnippetMO) return;

        const tree = doc.getElementById("threadTree");
        if (!tree) return;

        // Re-apply immediately for rows impacted by DOM mutations to avoid visible flicker.
        // MutationObserver callbacks run before paint; doing small, targeted work here keeps snippets stable.
        const pending = new Set(); // row elements

        const mo = new doc.defaultView.MutationObserver((muts) => {
          try {
            // Bounded diagnostic: log MO fires
            try {
              doc.__tmMsgList = doc.__tmMsgList || {};
              const c = Number(doc.__tmMsgList.__tmCardSnippetMOFireLogs || 0);
              const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
              if (c < max) {
                doc.__tmMsgList.__tmCardSnippetMOFireLogs = c + 1;
                const viewTree = doc.getElementById("threadTree");
                console.log(`[TMDBG SnippetDiag][EXP] ${CARD_SNIPPET_CONFIG.logPrefix} MO fired`, {
                  mutCount: muts.length,
                  isApplying: !!doc.__tmCardSnippetApplying,
                });
              }
            } catch (_) {}

            // Skip mutations caused by our own snippet writes.
            if (doc.__tmCardSnippetApplying) {
              try {
                doc.__tmMsgList = doc.__tmMsgList || {};
                const c = Number(doc.__tmMsgList.__tmCardSnippetSkipApplyLogs || 0);
                const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
                if (c < max) {
                  doc.__tmMsgList.__tmCardSnippetSkipApplyLogs = c + 1;
                  console.log(`${CARD_SNIPPET_CONFIG.logPrefix} MutationObserver skipped (apply in progress)`);
                }
              } catch (_) {}
              return;
            }

            // Collect affected rows from addedNodes + mutation targets.
            for (const m of muts) {
              if (m.type !== "childList") continue;
              const targets = [];
              try { if (m.target) targets.push(m.target); } catch (_) {}
              try {
                for (const n of m.addedNodes || []) targets.push(n);
              } catch (_) {}

              for (const n of targets) {
                if (!n || n.nodeType !== 1) continue;
                const el = /** @type {Element} */ (n);
                // Ignore our own snippet insertions.
                try {
                  if (el.classList?.contains(CARD_SNIPPET_CONFIG.className)) continue;
                  if (el.closest?.(`.${CARD_SNIPPET_CONFIG.className}`)) continue;
                  if (el.closest?.(".thread-card-button")) continue;
                } catch (_) {}
                const row =
                  el.matches?.('[id^="threadTree-row"]') ? el :
                  el.closest?.('[id^="threadTree-row"]');
                if (row) pending.add(row);
              }
            }

            if (!pending.size) return;

            const rows = Array.from(pending).slice(0, CARD_SNIPPET_CONFIG.reapply.maxRowsPerMutation);
            pending.clear();

            const viewTree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
            if (!viewTree) return;

            const toFetch = [];
            for (const row of rows) {
              const idx = _rowIndexFromRowId(row.id);
              if (idx < 0) continue;
              const hdr = _getHdrForRowIndex(viewTree, idx);
              if (!hdr) continue;

              // Only fetch for rows near the viewport (keeps work bounded on huge folders).
              try {
                const range = doc.__tmMsgList?.__tmCardSnippetIndexRange || null;
                if (range && Number.isFinite(range.minIdx) && Number.isFinite(range.maxIdx)) {
                  if (idx < range.minIdx || idx > range.maxIdx) continue;
                }
              } catch (_) {}

              // Fast re-apply from cache (no async).
              applySnippetToRow(row, hdr, doc);
              _applySenderScaleToRow(row, hdr);

              // If still no cached snippet, consider kicking an async fetch.
              if (!getSnippetText(hdr)) {
                toFetch.push({ row, hdr });
              }
            }

            // Small, bounded async fetches per mutation (keeps UI responsive).
            if (toFetch.length) {
              const slice = toFetch.slice(0, CARD_SNIPPET_CONFIG.reapply.maxAsyncFetchesPerMutation);
              const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
              timer.initWithCallback(
                {
                  notify() {
                    (async () => {
                      for (const { row, hdr } of slice) {
                        try { await applySnippetToRowAsync(row, hdr, doc); } catch (_) {}
                      }
                    })();
                  },
                },
                0,
                Ci.nsITimer.TYPE_ONE_SHOT
              );
              doc.__tmCardSnippetMOTimer = timer;
            }
          } catch (e) {
            console.error(`${CARD_SNIPPET_CONFIG.logPrefix} MutationObserver callback failed:`, e);
          }
        });

        mo.observe(tree, { childList: true, subtree: true });
        doc.__tmCardSnippetMO = mo;

        // Scroll listener: TB recycles rows on scroll without DOM mutations, so we need to trigger snippet loading.
        if (!doc.__tmCardSnippetScrollHandler) {
          let scrollTimer = null;
          const scrollDebounceMs = Number(CARD_SNIPPET_CONFIG?.reapply?.scrollDebounceMs) || 150;
          doc.__tmCardSnippetScrollHandler = () => {
            if (scrollTimer) {
              try { scrollTimer.cancel(); } catch (_) {}
            }
            scrollTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
            scrollTimer.initWithCallback(
              {
                notify() {
                  try { applySnippetsToDoc(doc); } catch (_) {}
                },
              },
              scrollDebounceMs,
              Ci.nsITimer.TYPE_ONE_SHOT
            );
            doc.__tmCardSnippetScrollTimer = scrollTimer;
          };
          tree.addEventListener("scroll", doc.__tmCardSnippetScrollHandler, { passive: true });
        }

        // Post-init kicks: helps the folder open during reload, where TB may render without emitting mutations.
        try {
          const delays = Array.isArray(CARD_SNIPPET_CONFIG.reapply.initKickDelaysMs)
            ? CARD_SNIPPET_CONFIG.reapply.initKickDelaysMs
            : [];
          doc.__tmCardSnippetInitKickTimers = doc.__tmCardSnippetInitKickTimers || [];
          for (const d of delays) {
            const ms = Number(d);
            if (!Number.isFinite(ms) || ms < 0) continue;
            const t = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
            t.initWithCallback(
              {
                notify() {
                  try { applySnippetsToDoc(doc); } catch (e) {
                    console.error(`${CARD_SNIPPET_CONFIG.logPrefix} applySnippetsToDoc (initKick) failed:`, e);
                  }
                },
              },
              ms,
              Ci.nsITimer.TYPE_ONE_SHOT
            );
            doc.__tmCardSnippetInitKickTimers.push(t);
          }
        } catch (_) {}
      } catch (e) {
        console.error(`${CARD_SNIPPET_CONFIG.logPrefix} attachCardSnippetObserver failed:`, e);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE VIEW TAG COLORING
    // ═══════════════════════════════════════════════════════════════════════

    function applyTagColorsToDoc(doc) {
      try {
        if (!doc) return;
        if (isBusy(doc)) return;
        
        const tree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
        if (!tree) return;
        
        const rows = Array.from(doc.querySelectorAll('[id^="threadTree-row"]'));
        if (!rows.length) return;

        let applied = 0;
        for (const row of rows) {
          try {
            const match = row.id?.match?.(/threadTree-row(\d+)/);
            if (!match) continue;
            const rowIndex = parseInt(match[1], 10);
            if (isNaN(rowIndex)) continue;

            let hdr = null;
            try { if (typeof tree?.view?.getMsgHdrAt === "function") hdr = tree.view.getMsgHdrAt(rowIndex); } catch(_) {}
            if (!hdr) { try { if (typeof tree?.view?.getMessageHdrAt === "function") hdr = tree.view.getMessageHdrAt(rowIndex); } catch(_) {} }
            if (!hdr) { try { if (typeof tree?.view?.dbView?.hdrForRow === "function") hdr = tree.view.dbView.hdrForRow(rowIndex); } catch(_) {} }
            if (!hdr) continue;

            const color = resolveTagColor(hdr);
            const targetColor = color || "transparent";
            const currentColor = row.style.getPropertyValue("--tag-color");
            if (currentColor !== targetColor) {
              row.style.setProperty("--tag-color", targetColor);
              applied++;
            }
          } catch(_) {}
        }
        
        if (applied) {
          console.log(`${LOG_PREFIX} applyTagColorsToDoc applied to ${applied} rows in`, doc.location?.href);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} applyTagColorsToDoc error:`, e);
      }
    }

    // Light DOM row coloring + snippet observer (both Card View and Table View)
    function attachLightDOMRowColoring(doc) {
      if (isBusy(doc)) return;
      const tree = doc.getElementById("threadTree");
      if (!tree || tree.__tmRowColorMO) return;

      const mo = new doc.defaultView.MutationObserver(muts => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && /^threadTree-row/.test(n.id || "")) {
              try {
                const idx = +n.id.replace("threadTree-row", "");
                const hdr = tree.view?.dbView?.hdrForRow?.(idx) || tree.view?.getMsgHdrAt?.(idx) || null;
                if (!hdr) continue;
                
                // Apply tag color
                const color = resolveTagColor(hdr);
                n.style.setProperty("--tag-color", color || "transparent");
                
                // Apply snippet for Card View rows
                if (n.getAttribute("is") === "thread-card") {
                  applySnippetToRow(n, hdr, doc);
                }
              } catch (_) {}
            }
          }
        }
      });

      mo.observe(tree, { childList: true, subtree: true });
      tree.__tmRowColorMO = mo;
    }

    function attachThreadTreeDiagnostics(doc) {
      try {
        if (!MESSAGE_LIST_DIAG_CONFIG.enabled) return;
        if (!doc) return;
        if (isBusy(doc)) return;
        if (doc.__tmThreadTreeDiagMO) return;

        const tree = doc.getElementById("threadTree");
        if (!tree) return;

        // One-time signature log to compare "2-row" vs "3-row" card view modes.
        // Hypothesis: TB selection/scroll behavior assumes a specific row height unless 3-row mode is active.
        try {
          if (!doc.__tmThreadTreeDiagSigLogged) {
            doc.__tmThreadTreeDiagSigLogged = true;
            const mml = tree.closest?.("mail-message-list") || null;
            const csTree = doc.defaultView?.getComputedStyle?.(tree) || null;
            const csMml = mml ? doc.defaultView?.getComputedStyle?.(mml) : null;
            const row0 = tree.querySelector?.('[id^="threadTree-row"]') || null;
            const csRow0 = row0 ? doc.defaultView?.getComputedStyle?.(row0) : null;
            _log("threadTree signature", {
              docHref: String(doc.location?.href || ""),
              treeId: String(tree.id || ""),
              treeClass: String(tree.className || ""),
              treeAttrs: (() => {
                try {
                  const out = {};
                  for (const k of tree.getAttributeNames?.() || []) out[k] = tree.getAttribute(k);
                  return out;
                } catch (_) {
                  return {};
                }
              })(),
              mmlExists: Boolean(mml),
              mmlTag: mml ? String(mml.tagName || "") : null,
              mmlClass: mml ? String(mml.className || "") : null,
              mmlAttrs: (() => {
                try {
                  const out = {};
                  for (const k of mml?.getAttributeNames?.() || []) out[k] = mml.getAttribute(k);
                  return out;
                } catch (_) {
                  return {};
                }
              })(),
              csTreeOverflowY: csTree ? csTree.overflowY : null,
              csTreeFontSize: csTree ? csTree.fontSize : null,
              csTreeLineHeight: csTree ? csTree.lineHeight : null,
              csTreeRowHeightVar: csTree ? String(csTree.getPropertyValue("--row-height") || "").trim() : null,
              csMmlRowHeightVar: csMml ? String(csMml.getPropertyValue("--row-height") || "").trim() : null,
              csRow0Height: csRow0 ? csRow0.height : null,
              csRow0MinHeight: csRow0 ? csRow0.minHeight : null,
            });
          }
        } catch (_) {}

        doc.__tmThreadTreeDiagTimers = doc.__tmThreadTreeDiagTimers || [];
        doc.__tmThreadTreeDiagLogCount = Number(doc.__tmThreadTreeDiagLogCount || 0);
        doc.__tmThreadTreeDiagResizeLogCount = Number(doc.__tmThreadTreeDiagResizeLogCount || 0);
        doc.__tmThreadTreeDiagLastHeights = doc.__tmThreadTreeDiagLastHeights || new Map(); // Element -> { h, w }
        doc.__tmThreadTreeDiagObservedRows = doc.__tmThreadTreeDiagObservedRows || new WeakSet();
        doc.__tmThreadTreeDiagLastSnapshot = doc.__tmThreadTreeDiagLastSnapshot || new WeakMap(); // Element -> snapshot

        function _canLog() {
          return Number(doc.__tmThreadTreeDiagLogCount || 0) < Number(MESSAGE_LIST_DIAG_CONFIG.maxLogsPerDoc || 0);
        }
        function _log(msg, data) {
          if (!_canLog()) return;
          doc.__tmThreadTreeDiagLogCount = Number(doc.__tmThreadTreeDiagLogCount || 0) + 1;
          try {
            console.log(`${MESSAGE_LIST_DIAG_CONFIG.logPrefix} ${msg}`, data || {});
          } catch (_) {}
        }

        function _canLogResize() {
          return (
            Number(MESSAGE_LIST_DIAG_CONFIG.enableResizeObserver) === 1 ||
            MESSAGE_LIST_DIAG_CONFIG.enableResizeObserver === true
          ) && Number(doc.__tmThreadTreeDiagResizeLogCount || 0) < Number(MESSAGE_LIST_DIAG_CONFIG.maxResizeLogsPerDoc || 0);
        }

        function _snapshotRow(rowEl) {
          try {
            const row = /** @type {Element} */ (rowEl);
            const card = row.querySelector?.(".card-container") || null;
            const subject = card?.querySelector?.(".card-subject, .subject-line, .thread-card-subject-container") || null;
            const snippet = card?.querySelector?.(".tm-card-snippet") || null;
            const sender = card?.querySelector?.(".sender, .tm-card-sender") || null;
            const win = doc.defaultView;

            let rowCS = null;
            let cardCS = null;
            let senderCS = null;
            try { rowCS = win.getComputedStyle(row); } catch (_) {}
            try { if (card) cardCS = win.getComputedStyle(card); } catch (_) {}
            try { if (sender) senderCS = win.getComputedStyle(sender); } catch (_) {}

            const px = (v) => {
              const n = parseFloat(String(v || ""));
              return Number.isFinite(n) ? n : null;
            };

            const rootFontSize = (() => {
              try {
                return win.getComputedStyle(doc.documentElement).fontSize;
              } catch (_) {
                return null;
              }
            })();

            const cardPaddingBlockStartPx = cardCS ? px(cardCS.paddingBlockStart) : null;
            const cardPaddingBlockEndPx = cardCS ? px(cardCS.paddingBlockEnd) : null;

            let rowRect = null;
            let cardRect = null;
            let subjectRect = null;
            let senderRect = null;
            try { rowRect = row.getBoundingClientRect?.() || null; } catch (_) {}
            try { cardRect = card?.getBoundingClientRect?.() || null; } catch (_) {}
            try { subjectRect = subject?.getBoundingClientRect?.() || null; } catch (_) {}
            try { senderRect = sender?.getBoundingClientRect?.() || null; } catch (_) {}

            return {
              rowId: String(row.id || ""),
              rowIs: String(row.getAttribute?.("is") || ""),
              rowClass: String(row.className || ""),
              rowDataProps: String(row.getAttribute?.("data-properties") || ""),
              rowDisplay: rowCS ? rowCS.display : null,
              rowFontSize: rowCS ? rowCS.fontSize : null,
              rowLineHeight: rowCS ? rowCS.lineHeight : null,
              rootFontSize,
              rowRectH: rowRect ? rowRect.height : null,
              rowRectW: rowRect ? rowRect.width : null,
              cardRectH: cardRect ? cardRect.height : null,
              cardRectW: cardRect ? cardRect.width : null,
              subjectRectH: subjectRect ? subjectRect.height : null,
              subjectRectW: subjectRect ? subjectRect.width : null,
              senderRectH: senderRect ? senderRect.height : null,
              senderRectW: senderRect ? senderRect.width : null,
              cardExists: Boolean(card),
              subjectExists: Boolean(subject),
              snippetExists: Boolean(snippet),
              senderExists: Boolean(sender),
              senderHasClass: sender ? sender.classList.contains(CARD_SENDER_CONFIG.className) : null,
              cardFontSize: cardCS ? cardCS.fontSize : null,
              senderFontSize: senderCS ? senderCS.fontSize : null,
              senderLineHeight: senderCS ? senderCS.lineHeight : null,
              cardPaddingTop: cardCS ? cardCS.paddingTop : null,
              cardPaddingBottom: cardCS ? cardCS.paddingBottom : null,
              cardPaddingTopPx: cardCS ? px(cardCS.paddingTop) : null,
              cardPaddingBottomPx: cardCS ? px(cardCS.paddingBottom) : null,
              cardPaddingBlockStart: cardCS ? cardCS.paddingBlockStart : null,
              cardPaddingBlockEnd: cardCS ? cardCS.paddingBlockEnd : null,
              cardPaddingBlockStartPx,
              cardPaddingBlockEndPx,
              // Derived numeric for debugging: the snippet space contribution in px.
              snippetSpacePx:
                Number.isFinite(cardPaddingBlockStartPx) && Number.isFinite(cardPaddingBlockEndPx)
                  ? cardPaddingBlockEndPx - cardPaddingBlockStartPx
                  : null,
              resolvedSnippetSpace: cardCS ? String(cardCS.getPropertyValue("--tm-card-snippet-space") || "").trim() : null,
            };
          } catch (_) {
            return null;
          }
        }

        function _diffSnapshots(prev, next) {
          try {
            if (!prev || !next) return [];
            const keys = [
              "rowIs",
              "rowClass",
              "rowDataProps",
              "rowFontSize",
              "rowLineHeight",
              "rowRectW",
              "cardRectW",
              "subjectRectW",
              "cardRectH",
              "subjectRectH",
              "cardExists",
              "subjectExists",
              "snippetExists",
              "senderExists",
              "senderHasClass",
              "cardFontSize",
              "senderFontSize",
              "senderLineHeight",
              "cardPaddingTopPx",
              "cardPaddingBottomPx",
              "cardPaddingBlockStartPx",
              "cardPaddingBlockEndPx",
              "resolvedSnippetSpace",
            ];
            const changes = [];
            for (const k of keys) {
              const a = prev[k];
              const b = next[k];
              // Strict compare, but normalize null/undefined.
              const an = a === undefined ? null : a;
              const bn = b === undefined ? null : b;
              if (an !== bn) changes.push({ key: k, before: an, after: bn });
            }
            return changes;
          } catch (_) {
            return [];
          }
        }

        // ResizeObserver: captures row size changes even when there are no DOM mutations.
        let ro = null;
        try {
          if (_canLogResize() && typeof doc.defaultView.ResizeObserver === "function") {
            ro = new doc.defaultView.ResizeObserver((entries) => {
              try {
                for (const entry of entries || []) {
                  if (!_canLogResize()) break;
                  const row = entry?.target;
                  if (!row || row.nodeType !== 1) continue;
                  const rect = row.getBoundingClientRect?.();
                  if (!rect) continue;

                  const prev = doc.__tmThreadTreeDiagLastHeights.get(row) || null;
                  doc.__tmThreadTreeDiagLastHeights.set(row, { h: rect.height, w: rect.width });
                  if (!prev) continue;

                  const dh = rect.height - prev.h;
                  const eps = Number(MESSAGE_LIST_DIAG_CONFIG.heightDeltaEpsilonPx || 0);
                  if (!Number.isFinite(dh) || Math.abs(dh) < eps) continue;

                  const snapNow = _snapshotRow(row);
                  const snapPrev = doc.__tmThreadTreeDiagLastSnapshot.get(row) || null;
                  try { if (snapNow) doc.__tmThreadTreeDiagLastSnapshot.set(row, snapNow); } catch (_) {}
                  const changes = _diffSnapshots(snapPrev, snapNow);

                  doc.__tmThreadTreeDiagResizeLogCount = Number(doc.__tmThreadTreeDiagResizeLogCount || 0) + 1;
                  
                  // Explicit summary line so we can see key changes even when object is collapsed
                  const summary = [];
                  if (snapPrev?.senderFontSize !== snapNow?.senderFontSize) {
                    summary.push(`senderFontSize: ${snapPrev?.senderFontSize ?? "null"} → ${snapNow?.senderFontSize ?? "null"}`);
                  }
                  if (snapPrev?.senderHasClass !== snapNow?.senderHasClass) {
                    summary.push(`senderHasClass: ${snapPrev?.senderHasClass ?? "null"} → ${snapNow?.senderHasClass ?? "null"}`);
                  }
                  if (snapPrev?.cardRectH !== snapNow?.cardRectH) {
                    summary.push(`cardRectH: ${snapPrev?.cardRectH?.toFixed(2) ?? "null"} → ${snapNow?.cardRectH?.toFixed(2) ?? "null"}`);
                  }
                  if (snapPrev?.subjectRectH !== snapNow?.subjectRectH) {
                    summary.push(`subjectRectH: ${snapPrev?.subjectRectH?.toFixed(2) ?? "null"} → ${snapNow?.subjectRectH?.toFixed(2) ?? "null"}`);
                  }
                  if (snapPrev?.senderRectH !== snapNow?.senderRectH) {
                    summary.push(`senderRectH: ${snapPrev?.senderRectH?.toFixed(2) ?? "null"} → ${snapNow?.senderRectH?.toFixed(2) ?? "null"}`);
                  }
                  if (snapPrev?.rowRectW !== snapNow?.rowRectW) {
                    summary.push(`rowRectW: ${snapPrev?.rowRectW?.toFixed(2) ?? "null"} → ${snapNow?.rowRectW?.toFixed(2) ?? "null"}`);
                  }
                  if (snapPrev?.cardRectW !== snapNow?.cardRectW) {
                    summary.push(`cardRectW: ${snapPrev?.cardRectW?.toFixed(2) ?? "null"} → ${snapNow?.cardRectW?.toFixed(2) ?? "null"}`);
                  }
                  if (summary.length) {
                    console.log(`${MESSAGE_LIST_DIAG_CONFIG.logPrefix} row resize observed [${snapNow?.rowId || ""}] ${summary.join(" | ")}`);
                  }
                  
                  console.log(`${MESSAGE_LIST_DIAG_CONFIG.logPrefix} row resize observed`, {
                    beforeH: prev.h,
                    afterH: rect.height,
                    deltaH: dh,
                    // Duplicate a few fields at top-level so devtools doesn't hide them behind {...}.
                    rowId: snapNow?.rowId || "",
                    rowIs: snapNow?.rowIs || "",
                    cardExists: snapNow?.cardExists ?? null,
                    prevCardExists: snapPrev?.cardExists ?? null,
                    subjectExists: snapNow?.subjectExists ?? null,
                    prevSubjectExists: snapPrev?.subjectExists ?? null,
                    snippetExists: snapNow?.snippetExists ?? null,
                    prevSnippetExists: snapPrev?.snippetExists ?? null,
                    rootFontSize: snapNow?.rootFontSize ?? null,
                    prevRootFontSize: snapPrev?.rootFontSize ?? null,
                    rowRectW: snapNow?.rowRectW ?? null,
                    prevRowRectW: snapPrev?.rowRectW ?? null,
                    cardRectW: snapNow?.cardRectW ?? null,
                    prevCardRectW: snapPrev?.cardRectW ?? null,
                    cardRectH: snapNow?.cardRectH ?? null,
                    prevCardRectH: snapPrev?.cardRectH ?? null,
                    subjectRectH: snapNow?.subjectRectH ?? null,
                    prevSubjectRectH: snapPrev?.subjectRectH ?? null,
                    senderRectH: snapNow?.senderRectH ?? null,
                    prevSenderRectH: snapPrev?.senderRectH ?? null,
                    cardPaddingBlockEndPx: snapNow?.cardPaddingBlockEndPx ?? null,
                    prevCardPaddingBlockEndPx: snapPrev?.cardPaddingBlockEndPx ?? null,
                    cardPaddingBlockStartPx: snapNow?.cardPaddingBlockStartPx ?? null,
                    prevCardPaddingBlockStartPx: snapPrev?.cardPaddingBlockStartPx ?? null,
                    cardPaddingBottomPx: snapNow?.cardPaddingBottomPx ?? null,
                    prevCardPaddingBottomPx: snapPrev?.cardPaddingBottomPx ?? null,
                    cardPaddingTopPx: snapNow?.cardPaddingTopPx ?? null,
                    prevCardPaddingTopPx: snapPrev?.cardPaddingTopPx ?? null,
                    snippetSpacePx: snapNow?.snippetSpacePx ?? null,
                    prevSnippetSpacePx: snapPrev?.snippetSpacePx ?? null,
                    cardFontSize: snapNow?.cardFontSize ?? null,
                    prevCardFontSize: snapPrev?.cardFontSize ?? null,
                    rowFontSize: snapNow?.rowFontSize ?? null,
                    prevRowFontSize: snapPrev?.rowFontSize ?? null,
                    senderFontSize: snapNow?.senderFontSize ?? null,
                    prevSenderFontSize: snapPrev?.senderFontSize ?? null,
                    senderHasClass: snapNow?.senderHasClass ?? null,
                    prevSenderHasClass: snapPrev?.senderHasClass ?? null,
                    resolvedSnippetSpace: snapNow?.resolvedSnippetSpace ?? null,
                    prevResolvedSnippetSpace: snapPrev?.resolvedSnippetSpace ?? null,
                    changes,
                    snapshot: snapNow,
                  });
                }
              } catch (_) {}
            });
            doc.__tmThreadTreeDiagRO = ro;
          }
        } catch (_) {}

        function _collectRowEls(node) {
          const out = [];
          try {
            if (!node || node.nodeType !== 1) return out;
            const el = /** @type {Element} */ (node);
            if (/^threadTree-row/.test(String(el.id || ""))) out.push(el);
            try {
              const inner = el.querySelectorAll?.('[id^="threadTree-row"]') || [];
              for (const r of inner) out.push(r);
            } catch (_) {}
          } catch (_) {}
          return out;
        }

        function _isSelectedRowEl(el) {
          try {
            const cls = String(el.className || "");
            if (cls.includes("selected")) return true;
            const props = String(el.getAttribute?.("data-properties") || "");
            return props.includes("selected");
          } catch (_) {
            return false;
          }
        }

        const mo = new doc.defaultView.MutationObserver((muts) => {
          try {
            if (!_canLog()) return;

            const added = [];
            const removed = [];
            const selectionChanges = [];

            for (const m of muts) {
              try {
                if (m.type === "childList") {
                  for (const n of m.addedNodes || []) {
                    for (const r of _collectRowEls(n)) added.push(r);
                  }
                  for (const n of m.removedNodes || []) {
                    for (const r of _collectRowEls(n)) removed.push(r);
                  }
                } else if (m.type === "attributes") {
                  const t = /** @type {Element} */ (m.target);
                  if (t && /^threadTree-row/.test(String(t.id || ""))) {
                    if (m.attributeName === "is") {
                      try {
                        const diagBudget = Number(MESSAGE_LIST_DIAG_CONFIG.maxRowIdsInLog || 0);
                        _log("row is= changed", {
                          rowId: String(t.id || ""),
                          is: String(t.getAttribute("is") || ""),
                        });
                      } catch (_) {}
                    } else if (m.attributeName === "class" || m.attributeName === "data-properties") {
                      selectionChanges.push({
                        rowId: String(t.id || ""),
                        attr: m.attributeName,
                        isSelected: _isSelectedRowEl(t),
                      });
                    }
                  }
                }
              } catch (_) {}
            }

            const addedIds = added.map(r => String(r.id || "")).filter(Boolean);
            const removedIds = removed.map(r => String(r.id || "")).filter(Boolean);

                // Summary log (high-signal)
                if (addedIds.length || removedIds.length || selectionChanges.length) {
                  let treeMetrics = null;
                  try {
                    const last = Number(doc.__tmThreadTreeDiagLastScrollTop);
                    const lastScrollHeight = Number(doc.__tmThreadTreeDiagLastScrollHeight);
                    treeMetrics = {
                      scrollTop: Number(tree.scrollTop),
                      scrollHeight: Number(tree.scrollHeight),
                      clientHeight: Number(tree.clientHeight),
                    };
                    if (Number.isFinite(last)) {
                      treeMetrics.scrollTopDelta = treeMetrics.scrollTop - last;
                    }
                    if (Number.isFinite(lastScrollHeight)) {
                      treeMetrics.scrollHeightDelta = treeMetrics.scrollHeight - lastScrollHeight;
                    }
                    doc.__tmThreadTreeDiagLastScrollTop = treeMetrics.scrollTop;
                    doc.__tmThreadTreeDiagLastScrollHeight = treeMetrics.scrollHeight;
                  } catch (_) {}

              _log("threadTree mutation", {
                added: addedIds.length,
                removed: removedIds.length,
                addedSample: addedIds.slice(0, Number(MESSAGE_LIST_DIAG_CONFIG.maxRowIdsInLog || 0)),
                removedSample: removedIds.slice(0, Number(MESSAGE_LIST_DIAG_CONFIG.maxRowIdsInLog || 0)),
                selectionChanges: selectionChanges.slice(0, Number(MESSAGE_LIST_DIAG_CONFIG.maxRowIdsInLog || 0)),
                // Duplicate at top-level so logs are readable even when the devtools collapses nested objects.
                scrollTopDelta: treeMetrics?.scrollTopDelta ?? null,
                scrollHeightDelta: treeMetrics?.scrollHeightDelta ?? null,
                tree: treeMetrics,
              });
            }

            // Measure newly added rows now and after a small delay to detect reflow.
            const maxMeasures = Number(MESSAGE_LIST_DIAG_CONFIG.maxRowMeasuresPerMutation || 0);
            const toMeasure = added.filter(r => r && r.getBoundingClientRect).slice(0, maxMeasures);
            if (!toMeasure.length) return;

            const before = new Map();
            for (const r of toMeasure) {
              try {
                const rect = r.getBoundingClientRect();
                before.set(r, { h: rect.height, top: rect.top });
                // Prime ResizeObserver baseline ASAP.
                try {
                  doc.__tmThreadTreeDiagLastHeights.set(r, { h: rect.height, w: rect.width });
                } catch (_) {}
                // Prime snapshot baseline ASAP so ResizeObserver can diff on first change.
                try {
                  const s = _snapshotRow(r);
                  if (s) doc.__tmThreadTreeDiagLastSnapshot.set(r, s);
                } catch (_) {}
                // Start observing the row so we can capture resizes without relying on timers/mutations.
                try {
                  if (doc.__tmThreadTreeDiagRO && !doc.__tmThreadTreeDiagObservedRows.has(r)) {
                    doc.__tmThreadTreeDiagObservedRows.add(r);
                    doc.__tmThreadTreeDiagRO.observe(r);
                  }
                } catch (_) {}
              } catch (_) {}
            }

            const delayMs = Number(MESSAGE_LIST_DIAG_CONFIG.remeasureDelayMs || 0);
            const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
            timer.initWithCallback(
              {
                notify() {
                  try {
                    for (const r of toMeasure) {
                      try {
                        if (!r.isConnected) continue;
                        const b = before.get(r);
                        if (!b) continue;
                        const rect = r.getBoundingClientRect();
                        const dh = rect.height - b.h;
                        const dt = rect.top - b.top;
                        const eps = Number(MESSAGE_LIST_DIAG_CONFIG.heightDeltaEpsilonPx || 0);
                        if (Number.isFinite(dh) && Math.abs(dh) >= eps) {
                          let pad = null;
                          let fontSize = null;
                          let snippetSpace = null;
                          try {
                            const container = r.querySelector?.(".card-container") || null;
                            if (container) {
                              const cs = doc.defaultView.getComputedStyle(container);
                              pad = {
                                paddingBlockStart: cs.paddingBlockStart,
                                paddingBlockEnd: cs.paddingBlockEnd,
                                paddingTop: cs.paddingTop,
                                paddingBottom: cs.paddingBottom,
                              };
                              fontSize = cs.fontSize;
                              snippetSpace = cs.getPropertyValue("--tm-card-snippet-space") || "";
                            }
                          } catch (_) {}
                          _log("row height changed after insert", {
                            rowId: String(r.id || ""),
                            beforeH: b.h,
                            afterH: rect.height,
                            deltaH: dh,
                            deltaTop: dt,
                            isThreadCard: r.getAttribute?.("is") === "thread-card",
                            cardContainerPadding: pad,
                            cardContainerFontSize: fontSize,
                            resolvedSnippetSpace: (snippetSpace || "").trim(),
                          });
                        }
                      } catch (_) {}
                    }
                  } catch (_) {}
                },
              },
              delayMs,
              Ci.nsITimer.TYPE_ONE_SHOT
            );
            doc.__tmThreadTreeDiagTimers.push(timer);
          } catch (e) {
            try {
              console.error(`${MESSAGE_LIST_DIAG_CONFIG.logPrefix} MutationObserver failed:`, e);
            } catch (_) {}
          }
        });

        mo.observe(tree, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "data-properties", "is"],
        });
        doc.__tmThreadTreeDiagMO = mo;

        _log("threadTree diagnostics attached", {
          href: doc.location?.href,
          remeasureDelayMs: MESSAGE_LIST_DIAG_CONFIG.remeasureDelayMs,
        });
      } catch (e) {
        console.error(`${MESSAGE_LIST_DIAG_CONFIG.logPrefix} attachThreadTreeDiagnostics failed:`, e);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CARD VIEW (SHADOW DOM) TAG COLORING
    // ═══════════════════════════════════════════════════════════════════════

    function primeAllVisibleRowsNow(sr, getColorForRowId) {
      const rows = sr.querySelectorAll('[id^="threadTree-row"]');
      for (const row of rows) {
        const color = getColorForRowId(row.id);
        if (color && row.style.getPropertyValue("--tag-color") !== color) {
          row.style.setProperty("--tag-color", color);
        }
      }
    }

    function getColorForRowId(cdoc, rowId) {
      if (!rowId || typeof rowId !== "string") return null;
      const match = rowId.match(/threadTree-row(\d+)/);
      if (!match) return null;
      const idx = parseInt(match[1], 10);
      if (isNaN(idx)) return null;
      try {
        const tree = cdoc.getElementById("threadTree") || cdoc.querySelector("tree-view#threadTree, tree-view");
        if (!tree) return null;
        let hdr = null;
        try { if (typeof tree?.view?.getMsgHdrAt === "function") hdr = tree.view.getMsgHdrAt(idx); } catch(_) {}
        if (!hdr) { try { if (typeof tree?.view?.getMessageHdrAt === "function") hdr = tree.view.getMessageHdrAt(idx); } catch(_) {} }
        if (!hdr) { try { if (typeof tree?.view?.dbView?.hdrForRow === "function") hdr = tree.view.dbView.hdrForRow(idx); } catch(_) {} }
        return resolveTagColor(hdr);
      } catch (_) {
        return null;
      }
    }

    function attachShadowRowColoring(cdoc, mm) {
      if (isBusy(cdoc)) return;
      const sr = mm && mm.shadowRoot;
      if (!sr || sr.__tmRowColorObserver) return;

      const tree = cdoc.getElementById("threadTree") || cdoc.querySelector("tree-view#threadTree, tree-view");
      if (!tree) return;

      // Prime existing rows immediately
      primeAllVisibleRowsNow(sr, (id) => getColorForRowId(cdoc, id));

      // Observe new rows
      const mo = new cdoc.defaultView.MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && /^threadTree-row/.test(n.id || "")) {
              try {
                const idx = +n.id.replace("threadTree-row", "");
                const hdr = tree.view?.dbView?.hdrForRow?.(idx) || tree.view?.getMsgHdrAt?.(idx) || null;
                if (!hdr) continue;
                const color = resolveTagColor(hdr);
                n.style.setProperty("--tag-color", color || "transparent");
              } catch (_) {}
            }
          }
        }
      });

      mo.observe(sr, { childList: true, subtree: true });
      sr.__tmRowColorObserver = { rowsMO: mo };
    }

    function applyShadowTagColors(cdoc) {
      try {
        const mailLists = cdoc.querySelectorAll("mail-message-list");
        for (const mm of mailLists) {
          if (mm.shadowRoot) {
            attachShadowRowColoring(cdoc, mm);
          }
        }
      } catch (_) {}
    }

    function watchForNewMailMessageLists(cdoc) {
      if (cdoc.__tmMailListMO) return;
      const mo = new cdoc.defaultView.MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.localName === "mail-message-list") {
              if (n.shadowRoot) attachShadowRowColoring(cdoc, n);
              else Promise.resolve().then(() => attachShadowRowColoring(cdoc, n));
            }
            const lists = n.querySelectorAll?.("mail-message-list");
            lists?.forEach(mm => {
              if (mm.shadowRoot) attachShadowRowColoring(cdoc, mm);
              else Promise.resolve().then(() => attachShadowRowColoring(cdoc, mm));
            });
          }
        }
      });
      mo.observe(cdoc, { childList: true, subtree: true });
      cdoc.__tmMailListMO = mo;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FOLDER NOTIFICATION LISTENER (immediate recolor on tag changes)
    // ═══════════════════════════════════════════════════════════════════════

    function registerFolderListener(ctx) {
      if (ctx.__tmFolderListener) return;

      try {
        const MFN = MailServicesML.mfn;
        const Flags = Ci.nsIMsgFolderNotificationService;
        const mask = Flags.msgsClassified | Flags.msgKeywordsChanged | Flags.msgsMoveCopyCompleted;

        ctx.__tmFolderListener = {
          onMsgPropertyChanged(hdr, prop) {
            if (prop === "keywords") this.handleKeywordsChange(hdr);
          },
          onMsgsClassified(messages) {
            for (const hdr of messages) this.handleKeywordsChange(hdr);
          },
          onMsgsMoveCopyCompleted(move, srcMsgs, destFldr, destMsgs) {
            for (const hdr of destMsgs) this.handleKeywordsChange(hdr);
          },
          handleKeywordsChange(hdr) {
            try {
              const color = resolveTagColor(hdr);
              const win = ServicesML.wm.getMostRecentWindow("mail:3pane");
              if (!win) return;

              const tabmail = win.document.getElementById("tabmail");
              const contentWin = tabmail?.currentAbout3Pane || tabmail?.currentTabInfo?.chromeBrowser?.contentWindow || null;
              if (!contentWin) return;

              const innerDoc = contentWin.document;
              const tree = innerDoc.getElementById("threadTree");
              const view = tree?.view;
              if (!view) return;

              let row = -1;
              try { row = view.findIndexOfMsgHdr?.(hdr, true) ?? -1; } catch {}
              if (row < 0) {
                try {
                  const sel = view.selection?.currentIndex ?? 0;
                  const start = Math.max(0, sel - 200), end = Math.min(view.rowCount - 1, sel + 200);
                  for (let i = start; i <= end; i++) {
                    if (view.getMsgHdrAt?.(i) === hdr || view.dbView?.hdrForRow?.(i) === hdr) {
                      row = i;
                      break;
                    }
                  }
                } catch {}
              }
              if (row < 0) return;

              // Shadow DOM (Card View)
              try {
                const mm = innerDoc.querySelector("mail-message-list");
                const sr = mm?.shadowRoot;
                const el = sr?.getElementById(`threadTree-row${row}`);
                if (el) el.style.setProperty("--tag-color", color || "transparent");
              } catch {}

              // Light DOM (Table View)
              try {
                const tr = innerDoc.getElementById(`threadTree-row${row}`);
                if (tr) tr.style.setProperty("--tag-color", color || "transparent");
              } catch {}
            } catch (e) {
              console.error(`${LOG_PREFIX} handleKeywordsChange failed:`, e);
            }
          }
        };

        MFN.addListener(ctx.__tmFolderListener, mask);
        console.log(`${LOG_PREFIX} ✓ Folder notification listener registered`);
      } catch (e) {
        console.error(`${LOG_PREFIX} Failed to register folder listener:`, e);
      }
    }

    function unregisterFolderListener(ctx) {
      if (!ctx.__tmFolderListener) return;
      try {
        MailServicesML.mfn.removeListener(ctx.__tmFolderListener);
        delete ctx.__tmFolderListener;
        console.log(`${LOG_PREFIX} ✓ Folder notification listener removed`);
      } catch (e) {
        console.error(`${LOG_PREFIX} Failed to remove folder listener:`, e);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // WINDOW SETUP
    // ═══════════════════════════════════════════════════════════════════════

    function ensureMessageListEnhancements(win) {
      try {
        // Diagnostic: entry log (bounded)
        try {
          win.__tmMsgList = win.__tmMsgList || {};
          const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
          const c = Number(win.__tmMsgList.__tmEnsureMsgListEntryLogs || 0);
          if (c < max) {
            win.__tmMsgList.__tmEnsureMsgListEntryLogs = c + 1;
            console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] ensureMessageListEnhancements entry`, {
              winReadyState: win?.document?.readyState || "",
            });
          }
        } catch (_) {}

        const contentDocs = enumerateContentDocs(win);
        // Diagnostic: summarize docs for this pass (bounded)
        try {
          win.__tmMsgList = win.__tmMsgList || {};
          const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
          const c = Number(win.__tmMsgList.__tmEnsureMsgListDocSummaryLogs || 0);
          if (c < max) {
            win.__tmMsgList.__tmEnsureMsgListDocSummaryLogs = c + 1;
            const summaries = [];
            for (const cdoc of contentDocs) {
              if (!cdoc) continue;
              let rowCount = 0;
              let hasTree = false;
              let isCard = false;
              try {
                const tree = cdoc.getElementById("threadTree") || cdoc.querySelector("tree-view#threadTree, tree-view");
                hasTree = !!tree;
                rowCount = tree ? cdoc.querySelectorAll('[is="thread-card"]').length : 0;
              } catch (_) {}
              try { isCard = isCardView(cdoc); } catch (_) {}
              summaries.push({
                href: cdoc?.location?.href || "",
                readyState: cdoc?.readyState || "",
                hasTree,
                isCardView: isCard,
                rowCount,
                sample: hasTree ? _diagSampleHdrFromTree(cdoc, cdoc.getElementById("threadTree") || cdoc.querySelector("tree-view#threadTree, tree-view")) : null,
              });
              if (summaries.length >= max) break;
            }
            console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] ensureMessageListEnhancements docs`, {
              count: contentDocs.length,
              summaries,
            });
            try {
              console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] ensureMessageListEnhancements docs json ${JSON.stringify({ count: contentDocs.length, summaries })}`);
            } catch (_) {}
          }
        } catch (_) {}

        for (const cdoc of contentDocs) {
          // Diagnostic: log per-doc enhancement pass (bounded)
          try {
            cdoc.__tmMsgList = cdoc.__tmMsgList || {};
            const max = Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0;
            const c = Number(cdoc.__tmMsgList.__tmEnsureMsgListLogs || 0);
            if (c < max) {
              cdoc.__tmMsgList.__tmEnsureMsgListLogs = c + 1;
              const tree = cdoc.getElementById("threadTree") || cdoc.querySelector("tree-view#threadTree, tree-view");
              const rows = tree ? cdoc.querySelectorAll('[is="thread-card"]').length : 0;
              console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] ensureMessageListEnhancements`, {
                href: cdoc?.location?.href || "",
                readyState: cdoc?.readyState || "",
                hasTree: !!tree,
                rowCount: rows,
              });
            }
          } catch (_) {}

          // Shadow DOM tag colors (only if mail-message-list exists)
          applyShadowTagColors(cdoc);
          watchForNewMailMessageLists(cdoc);

          // Light DOM tag colors (both Card View with [is="thread-card"] AND Table View)
          // TB 145 Card View uses light DOM rows, not shadow DOM!
          applyTagColorsToDoc(cdoc);
          attachLightDOMRowColoring(cdoc);
          attachThreadTreeDiagnostics(cdoc);

          // Card View snippets
          // Reserved space is always enabled via CSS; only inject/fetch content when toggled on.
          applySnippetsToDoc(cdoc);
          attachCardSnippetObserver(cdoc);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} ensureMessageListEnhancements error:`, e);
      }
    }

    function removeMessageListEnhancements(win) {
      try {
        // Remove event hooks (folderURIChanged, threadpane-loaded, TabSelect)
        detachMessageListEventHooks(win);
        const contentDocs = enumerateContentDocs(win);
        for (const cdoc of contentDocs) {
          // Disconnect light DOM observer
          try {
            const tree = cdoc.getElementById("threadTree");
            if (tree?.__tmRowColorMO) {
              tree.__tmRowColorMO.disconnect();
              delete tree.__tmRowColorMO;
            }
          } catch (_) {}

          // Disconnect mail-message-list observer
          try {
            if (cdoc.__tmMailListMO) {
              cdoc.__tmMailListMO.disconnect();
              delete cdoc.__tmMailListMO;
            }
          } catch (_) {}

          // Disconnect card snippet observer + timer + scroll listener
          try {
            if (cdoc.__tmCardSnippetMO) {
              cdoc.__tmCardSnippetMO.disconnect();
              delete cdoc.__tmCardSnippetMO;
            }
            if (cdoc.__tmCardSnippetMOTimer) {
              try { cdoc.__tmCardSnippetMOTimer.cancel(); } catch (_) {}
              delete cdoc.__tmCardSnippetMOTimer;
            }
            if (cdoc.__tmCardSnippetScrollTimer) {
              try { cdoc.__tmCardSnippetScrollTimer.cancel(); } catch (_) {}
              delete cdoc.__tmCardSnippetScrollTimer;
            }
            if (cdoc.__tmCardSnippetScrollHandler) {
              try {
                const tree = cdoc.getElementById("threadTree");
                if (tree) tree.removeEventListener("scroll", cdoc.__tmCardSnippetScrollHandler);
              } catch (_) {}
              delete cdoc.__tmCardSnippetScrollHandler;
            }
          } catch (_) {}

          // Disconnect threadTree diagnostics observer + timers
          try {
            if (cdoc.__tmThreadTreeDiagMO) {
              cdoc.__tmThreadTreeDiagMO.disconnect();
              delete cdoc.__tmThreadTreeDiagMO;
            }
            if (cdoc.__tmThreadTreeDiagRO) {
              try { cdoc.__tmThreadTreeDiagRO.disconnect(); } catch (_) {}
              delete cdoc.__tmThreadTreeDiagRO;
            }
            if (cdoc.__tmThreadTreeDiagTimers) {
              for (const t of cdoc.__tmThreadTreeDiagTimers) {
                try { t.cancel(); } catch (_) {}
              }
              delete cdoc.__tmThreadTreeDiagTimers;
            }
            try { delete cdoc.__tmThreadTreeDiagLogCount; } catch (_) {}
            try { delete cdoc.__tmThreadTreeDiagResizeLogCount; } catch (_) {}
            try { delete cdoc.__tmThreadTreeDiagLastHeights; } catch (_) {}
            try { delete cdoc.__tmThreadTreeDiagObservedRows; } catch (_) {}
            try { delete cdoc.__tmThreadTreeDiagLastSnapshot; } catch (_) {}
          } catch (_) {}

          // Disconnect snippet init kick timers
          try {
            if (cdoc.__tmCardSnippetInitKickTimers) {
              for (const t of cdoc.__tmCardSnippetInitKickTimers) {
                try { t.cancel(); } catch (_) {}
              }
              delete cdoc.__tmCardSnippetInitKickTimers;
            }
          } catch (_) {}

          // Disconnect shadow observers
          try {
            const mailLists = cdoc.querySelectorAll("mail-message-list");
            for (const mm of mailLists) {
              const sr = mm?.shadowRoot;
              if (sr?.__tmRowColorObserver) {
                sr.__tmRowColorObserver.rowsMO?.disconnect();
                delete sr.__tmRowColorObserver;
              }
            }
          } catch (_) {}
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} removeMessageListEnhancements error:`, e);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PALETTE LOADING
    // ═══════════════════════════════════════════════════════════════════════

    // Privileged file reading (for experiment parent context)
    function readTextPrivileged(url) {
      return new Promise((resolve, reject) => {
        NetUtilML.asyncFetch(
          {
            uri: url,
            loadingPrincipal: ServicesML.scriptSecurityManager.getSystemPrincipal(),
            securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
            contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
          },
          (inputStream, status) => {
            try {
              if (!Components.isSuccessCode(status)) {
                reject(new Error("asyncFetch failed: " + status));
                return;
              }
              const data = NetUtilML.readInputStreamToString(inputStream, inputStream.available());
              inputStream.close();
              resolve(data);
            } catch (e) {
              reject(e);
            }
          }
        );
      });
    }

    async function loadPaletteJSON(ctx) {
      try {
        const url = ctx.extension.getURL("theme/palette/palette.data.json");
        const text = await readTextPrivileged(url);
        return JSON.parse(text);
      } catch (e) {
        console.error(`${LOG_PREFIX} Failed to load palette.data.json:`, e);
        return null;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RECOLOR NOW
    // ═══════════════════════════════════════════════════════════════════════

    function recolorNow(reason = "recolorNow") {
      try {
        console.log(`${LOG_PREFIX} recolorNow() called reason=${reason}`);
        const enumWin = ServicesML.wm.getEnumerator("mail:3pane");
        while (enumWin.hasMoreElements()) {
          const win = enumWin.getNext();
          try {
            const contentDocs = enumerateContentDocs(win);
            for (const cdoc of contentDocs) {
              // Shadow DOM (if mail-message-list exists)
              applyShadowTagColors(cdoc);
              // Light DOM (both Card View and Table View)
              applyTagColorsToDoc(cdoc);
              // Card View snippets
              applySnippetsToDoc(cdoc);
            }
          } catch (e) {
            console.error(`${LOG_PREFIX} recolorNow failed for window:`, e);
          }
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} recolorNow failed:`, e);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INIT / SHUTDOWN
    // ═══════════════════════════════════════════════════════════════════════

    async function init(_opts = {}) {
      console.log(`${LOG_PREFIX} ═══ init() called ═══`);
      console.log(`${LOG_PREFIX} windowListenerId:`, windowListenerId);
      console.log(`${LOG_PREFIX} isInitialized:`, isInitialized);

      if (!ServicesML || !ServicesML.wm) {
        console.error(`${LOG_PREFIX} Services.wm not available!`);
        return;
      }

      if (isInitialized) {
        console.log(`${LOG_PREFIX} Already initialized, skipping`);
        return;
      }

      isInitialized = true;

      // Derive cardSnippetsEnabled from TB pref (mail.threadpane.cardsview.rowcount == 3)
      try {
        const rowCount = _getCardViewRowCount();
        msgListFlags.cardSnippetsEnabled = rowCount === CARD_VIEW_ROW_COUNT_FOR_SNIPPETS;
      } catch (_) {
        msgListFlags.cardSnippetsEnabled = false;
      }
      try {
        // Keep CARD_SNIPPET_CONFIG.enabled in sync (used as an early coarse gate)
        CARD_SNIPPET_CONFIG.enabled = msgListFlags.cardSnippetsEnabled === true;
      } catch (_) {}
      console.log(
        `${LOG_PREFIX} Flags set: cardSnippetsEnabled=${msgListFlags.cardSnippetsEnabled} (rowCount=${_getCardViewRowCount()})`,
      );

      // Load palette data for tm_untagged color
      try {
        paletteData = await loadPaletteJSON(context);
        console.log(`${LOG_PREFIX} ✓ Palette data loaded for untagged color:`, paletteData?.TAG_COLORS?.tm_untagged);
      } catch (e) {
        console.error(`${LOG_PREFIX} Failed to load palette data:`, e);
      }

      // Register folder listener for immediate tag color updates
      registerFolderListener(context);

      // Avoid unregistering a non-existent listener here to prevent noisy ExtensionSupport warnings.

      // Existing windows
      const enumWin = ServicesML.wm.getEnumerator("mail:3pane");
      while (enumWin.hasMoreElements()) {
        const win = enumWin.getNext();
        if (win.document.readyState === "complete") {
          ensureMessageListEnhancements(win);
          attachMessageListEventHooks(win, "init-existing");
        } else {
          win.addEventListener("load", () => {
            ensureMessageListEnhancements(win);
            attachMessageListEventHooks(win, "init-load");
          }, { once: true });
        }
      }

      // Future windows
      windowListenerId = context.extension.id + "-tmMessageList";
      ExtensionSupportML.registerWindowListener(windowListenerId, {
        chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
        onLoadWindow: (win) => {
          ensureMessageListEnhancements(win);
          attachMessageListEventHooks(win, "onLoadWindow");
        },
      });
      context.__tmMessageListWindowListenerRegistered = true;

      console.log(`${LOG_PREFIX} ✓ Initialization complete`);
    }

    function cleanup() {
      console.log(`${LOG_PREFIX} cleanup() called`);

      // Remove folder listener
      unregisterFolderListener(context);

      // Unregister window listener
      try {
        if (windowListenerId && context.__tmMessageListWindowListenerRegistered) {
          ExtensionSupportML.unregisterWindowListener(windowListenerId);
          windowListenerId = null;
          context.__tmMessageListWindowListenerRegistered = false;
        }
      } catch (_) {}

      // Clean up all windows
      try {
        if (ServicesML?.wm) {
          const enumWin = ServicesML.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            removeMessageListEnhancements(enumWin.getNext());
          }
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} Error during cleanup:`, e);
      }

      // Clear caches
      TagPersistenceCache.clear();

      isInitialized = false;
      console.log(`${LOG_PREFIX} cleanup() complete`);
    }

    this._tmCleanup = cleanup;

    async function shutdown() {
      console.log(`${LOG_PREFIX} shutdown() called from WebExtension API`);
      cleanup();
    }

    function clearSnippetCache() {
      console.log(`${LOG_PREFIX} Card snippet cache clear requested (no-op; cache lives in safeGetFull)`);
    }

    async function getCardSnippetNeeds(opts = {}) {
      try {
        const now = Date.now();
        const _diagMax = Math.max(0, Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0);
        if (!_snippetsContentEnabled()) {
          try {
            const c = Number(context.__tmCardSnippetNeedsDisabledLogs || 0);
            if (c < _diagMax) {
              context.__tmCardSnippetNeedsDisabledLogs = c + 1;
              console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] getCardSnippetNeeds skipped (snippets disabled)`);
            }
          } catch (_) {}
          return [];
        }

        const max = Number(opts?.max) || 12;
        const out = [];
        const seen = new Set();
        const stats = {
          totalRows: 0,
          eligibleRows: 0,
          skippedMinInterval: 0,
          skippedOutOfRange: 0,
          skippedNoHdr: 0,
          skippedNoHdrKey: 0,
          skippedSeen: 0,
          skippedDomSnippet: 0,
          skippedPending: 0,
          skippedHdrSnippet: 0,
          collected: 0,
        };
        const skipSamples = {
          domSnippet: [],
          hdrSnippet: [],
          pending: [],
        };
        const sample = [];
        let _diagLogged = 0;
        const _logIntervalMs = Number(CARD_SNIPPET_CONFIG?.reapply?.minApplyIntervalMs) || 0;
        const _minNeedsIntervalMs = Number(CARD_SNIPPET_CONFIG?.reapply?.minNeedsIntervalMs) || 0;
        const _pendingTtlMs = Number(CARD_SNIPPET_CONFIG?.reapply?.pendingTtlMs) || 0;
        const _pendingMaxEntries = Number(CARD_SNIPPET_CONFIG?.reapply?.pendingMaxEntries) || 0;
        let _shouldLogBatch = true;
        try {
          doc.__tmMsgList = doc.__tmMsgList || {};
          const last = Number(doc.__tmMsgList.__tmCardSnippetNeedsLogMs || 0);
          if (_logIntervalMs > 0 && (now - last) < _logIntervalMs) {
            _shouldLogBatch = false;
          } else {
            doc.__tmMsgList.__tmCardSnippetNeedsLogMs = now;
          }
        } catch (_) {}

        // Global throttle across all docs (prevents hot-loop when MV3 polls too frequently).
        try {
          const lastGlobal = Number(context.__tmCardSnippetNeedsGlobalMs || 0);
          if (_minNeedsIntervalMs > 0 && (now - lastGlobal) < _minNeedsIntervalMs) {
            return [];
          }
          context.__tmCardSnippetNeedsGlobalMs = now;
        } catch (_) {}

        // Enumerate all 3-pane windows and their about:3pane docs.
        const enumWin = ServicesML.wm.getEnumerator("mail:3pane");
        while (enumWin.hasMoreElements()) {
          const win = enumWin.getNext();
          const docs = enumerateContentDocs(win);
          for (const doc of docs) {
            if (!doc) continue;
            if (isBusy(doc)) continue;

            const tree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
            if (!tree) continue;

            const rows = Array.from(doc.querySelectorAll('[is="thread-card"]'));
            if (!rows.length) continue;

            // Bounded diagnostic: log which doc is being processed
            try {
              doc.__tmMsgList = doc.__tmMsgList || {};
              const c = Number(doc.__tmMsgList.__tmCardSnippetNeedsDocLogs || 0);
              if (c < _diagMax) {
                doc.__tmMsgList.__tmCardSnippetNeedsDocLogs = c + 1;
                console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] getCardSnippetNeeds processing doc`, {
                  href: doc?.location?.href || "",
                  rowCount: rows.length,
                });
              }
            } catch (_) {}

            // Determine index-range buffer from the last computed range (preferred).
            let range = null;
            try { range = doc.__tmMsgList?.__tmCardSnippetIndexRange || null; } catch (_) {}

            // If no range was computed yet, derive one quickly from current viewport.
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
                const bufferRows = Number(CARD_SNIPPET_CONFIG?.reapply?.viewportBufferRows) || 0;
                const minIdx = Math.max(0, visibleMinIdx - bufferRows);
                const maxIdx = visibleMaxIdx + bufferRows;
                range = { minIdx, maxIdx, bufferRows };
              }
            }

            // Skip needs if called too frequently (reduces event-loop churn when MV3 polling is hot).
            try {
              const lastNeeds = Number(doc.__tmMsgList.__tmCardSnippetNeedsLastMs || 0);
              if (_minNeedsIntervalMs > 0 && (now - lastNeeds) < _minNeedsIntervalMs) {
                stats.skippedMinInterval += 1;
                if (_diagLogged < _diagMax) {
                  _diagLogged += 1;
                  console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] getCardSnippetNeeds skipped (minNeedsIntervalMs)`, {
                    elapsedMs: now - lastNeeds,
                    minNeedsIntervalMs: _minNeedsIntervalMs,
                  });
                }
                continue;
              }
              doc.__tmMsgList.__tmCardSnippetNeedsLastMs = now;
            } catch (_) {}

            // Sort rows: viewport first (top-to-bottom), then buffer rows by distance from viewport.
            let sortedRows = rows;
            if (range && Number.isFinite(range.minIdx) && Number.isFinite(range.maxIdx)) {
              const inViewport = [];
              const aboveViewport = [];
              const belowViewport = [];
              const outOfRange = [];
              for (const row of rows) {
                const idx = _rowIndexFromRowId(row.id);
                if (idx < 0) {
                  outOfRange.push({ row, idx });
                  continue;
                }
                if (idx < range.minIdx || idx > range.maxIdx) {
                  outOfRange.push({ row, idx });
                  continue;
                }
                // Determine if in actual viewport or buffer zone
                const visMinIdx = range.minIdx + (range.bufferRows || 0);
                const visMaxIdx = range.maxIdx - (range.bufferRows || 0);
                if (idx >= visMinIdx && idx <= visMaxIdx) {
                  inViewport.push({ row, idx });
                } else if (idx < visMinIdx) {
                  aboveViewport.push({ row, idx });
                } else {
                  belowViewport.push({ row, idx });
                }
              }
              inViewport.sort((a, b) => a.idx - b.idx);
              aboveViewport.sort((a, b) => b.idx - a.idx);
              belowViewport.sort((a, b) => a.idx - b.idx);
              sortedRows = [
                ...inViewport.map(r => r.row),
                ...aboveViewport.map(r => r.row),
                ...belowViewport.map(r => r.row),
                ...outOfRange.map(r => r.row),
              ];
            }

            // Build needs list from near-viewport rows (now sorted).
            for (const row of sortedRows) {
              stats.totalRows += 1;
              if (out.length >= max) break;
              const idx = _rowIndexFromRowId(row.id);
              if (idx < 0) continue;
              if (range && (idx < range.minIdx || idx > range.maxIdx)) {
                stats.skippedOutOfRange += 1;
                continue;
              }

              const hdr = _getHdrForRowIndex(tree, idx);
              if (!hdr) {
                stats.skippedNoHdr += 1;
                continue;
              }

              const hdrKey = getHdrKey(hdr);
              if (!hdrKey) {
                stats.skippedNoHdrKey += 1;
                continue;
              }
              if (seen.has(hdrKey)) {
                stats.skippedSeen += 1;
                continue;
              }
              stats.eligibleRows += 1;

              // Already have a real snippet node in the DOM? skip.
              // IMPORTANT: in 3-row mode we create an EMPTY placeholder snippet node to "claim" the slot.
              // Treat empty/whitespace textContent as still needing MV3-provided snippet text.
              try {
                const el = row.querySelector?.(`.${CARD_SNIPPET_CONFIG.className}`) || null;
                if (el && el.isConnected) {
                  const t = _safeText(el.textContent || "");
                  if (t) {
                    stats.skippedDomSnippet += 1;
                    if (skipSamples.domSnippet.length < _diagMax) {
                      skipSamples.domSnippet.push({
                        hdrKey,
                        idx,
                        rowId: String(row.id || ""),
                        snippetSample: t.slice(0, 60),
                      });
                    }
                    continue;
                  }
                  // Placeholder exists; still request snippet.
                  try {
                    doc.__tmMsgList = doc.__tmMsgList || {};
                    const c1 = Number(doc.__tmMsgList.__tmCardSnippetNeedsPlaceholderLogs || 0);
                    if (c1 < _diagMax) {
                      doc.__tmMsgList.__tmCardSnippetNeedsPlaceholderLogs = c1 + 1;
                      console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] getCardSnippetNeeds: placeholder snippet present; still requesting`, {
                        rowId: String(row.id || ""),
                        hdrKey,
                        idx,
                      });
                    }
                  } catch (_) {}
                }
              } catch (_) {}

              // Skip if we already requested this hdrKey recently (pending TTL).
              try {
                doc.__tmMsgList = doc.__tmMsgList || {};
                const pending = doc.__tmMsgList.__tmCardSnippetPending || new Map();
                doc.__tmMsgList.__tmCardSnippetPending = pending;
                const pendTs = Number(pending.get(hdrKey) || 0);
                if (_pendingTtlMs > 0 && pendTs && (now - pendTs) < _pendingTtlMs) {
                  stats.skippedPending += 1;
                  if (skipSamples.pending.length < _diagMax) {
                    skipSamples.pending.push({
                      hdrKey,
                      idx,
                      rowId: String(row.id || ""),
                      ageMs: now - pendTs,
                    });
                  }
                  continue;
                }
                // Prune pending map if it grows too large.
                if (_pendingMaxEntries > 0 && pending.size > _pendingMaxEntries) {
                  for (const [k, ts] of pending) {
                    if ((now - Number(ts || 0)) > _pendingTtlMs) {
                      pending.delete(k);
                    }
                    if (pending.size <= _pendingMaxEntries) break;
                  }
                }
              } catch (_) {}

              // Already have a snippet via hdr props? skip.
              const existingInfo = getSnippetTextWithSource(hdr);
              const existing = existingInfo.text;
              if (existing) {
                stats.skippedHdrSnippet += 1;
                if (skipSamples.hdrSnippet.length < _diagMax) {
                  skipSamples.hdrSnippet.push({
                    hdrKey,
                    idx,
                    rowId: String(row.id || ""),
                    hdrSnippetSample: String(existing || "").slice(0, 60),
                    hdrSnippetSource: existingInfo.source,
                  });
                }
                continue;
              }

              // Convert to WebExtension message (for messages.getFull cache on MV3 side).
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
              out.push({
                hdrKey,
                msgId,
                weId,
                subject: subject.slice(0, 120),
              });
              stats.collected += 1;
              if (sample.length < _diagMax) {
                sample.push({ hdrKey, idx, rowId: String(row.id || ""), subject: subject.slice(0, 60) });
              }
            }
          }
        }

        if (out.length) {
          if (_shouldLogBatch) {
            console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] getCardSnippetNeeds returning ${out.length} items`, {
              stats,
              skipSamples,
              sample,
            });
            try {
              console.log(
                `[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] getCardSnippetNeeds details ${JSON.stringify({
                  stats,
                  skipSamples,
                  sample,
                })}`
              );
            } catch (_) {}
          }
        } else {
          // Helpful breadcrumb: if this fires repeatedly, MV3-side polling may not be calling us, or
          // our skip logic is filtering everything. Throttle per-doc to avoid spam.
          try {
            doc.__tmMsgList = doc.__tmMsgList || {};
            const c0 = Number(doc.__tmMsgList.__tmCardSnippetNeedsZeroLogs || 0);
            if (c0 < _diagMax) {
              doc.__tmMsgList.__tmCardSnippetNeedsZeroLogs = c0 + 1;
              console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] getCardSnippetNeeds returning 0 items`, {
                max,
                reason: "no-missing-snippets-near-viewport",
                stats,
                skipSamples,
              });
              try {
                console.log(
                  `[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] getCardSnippetNeeds details ${JSON.stringify({
                    max,
                    reason: "no-missing-snippets-near-viewport",
                    stats,
                    skipSamples,
                  })}`
                );
              } catch (_) {}
            }
          } catch (_) {}
        }
        return out;
      } catch (e) {
        console.error(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] getCardSnippetNeeds failed:`, e);
        return [];
      }
    }

    async function provideCardSnippets(payload) {
      try {
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const source = String(payload?.source || "unknown");
        let applied = 0;
        let diag = 0;
        let emptySnippetCount = 0;
        let subjectMissingCount = 0;
        let hostMissingCount = 0;
        let noRowMatchCount = 0;
        let outOfRangeCount = 0;
        const appliedKeys = new Set();
        const rowKeysInRange = new Set();
        const diagMax = Math.max(0, Number(CARD_SNIPPET_CONFIG?.maxDiagnostics) || 0);

        // Apply directly to any currently-rendered rows that match hdrKey.
        const enumWin = ServicesML.wm.getEnumerator("mail:3pane");
        const itemsByKey = new Map();
        for (const it of items) {
          const k = String(it?.hdrKey || "");
          if (!k) continue;
          const snippet = String(it?.snippet || "");
          if (!snippet) {
            emptySnippetCount += 1;
            continue;
          }
          if (!itemsByKey.has(k)) {
            itemsByKey.set(k, { snippet });
          }
        }
        while (enumWin.hasMoreElements()) {
          const win = enumWin.getNext();
          const docs = enumerateContentDocs(win);
          for (const doc of docs) {
            if (!doc) continue;
            const tree = doc.getElementById("threadTree") || doc.querySelector("tree-view#threadTree, tree-view");
            if (!tree) continue;
            const rows = Array.from(doc.querySelectorAll('[is="thread-card"]'));
            if (!rows.length) continue;

            // Apply only within the most recent index range if available (keeps it bounded).
            const range = doc.__tmMsgList?.__tmCardSnippetIndexRange || null;

            for (const row of rows) {
              const idx = _rowIndexFromRowId(row.id);
              if (idx < 0) continue;
              if (range && (idx < range.minIdx || idx > range.maxIdx)) {
                outOfRangeCount += 1;
                continue;
              }
              const hdr = _getHdrForRowIndex(tree, idx);
              if (!hdr) continue;
              const rowHdrKey = getHdrKey(hdr);
              if (!rowHdrKey) continue;
              rowKeysInRange.add(rowHdrKey);

              const it = itemsByKey.get(rowHdrKey);
              if (!it) continue;
              const snippet = it.snippet;

              const subjectEl = findSubjectElement(row, hdr);
              if (!subjectEl) {
                subjectMissingCount += 1;
                continue;
              }

              const text = snippet.length > CARD_SNIPPET_CONFIG.maxChars
                ? snippet.slice(0, CARD_SNIPPET_CONFIG.maxChars).trim()
                : snippet;

              const host = findSnippetHost(row, hdr);
              if (!host) {
                if (diag < diagMax) {
                  diag += 1;
                  console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] provideCardSnippets: host not found for row`, {
                    rowId: String(row.id || ""),
                    hdrKey: rowHdrKey,
                    source,
                  });
                }
                hostMissingCount += 1;
                continue;
              }

              let el = host.querySelector?.(`.${CARD_SNIPPET_CONFIG.className}`) || null;
              if (!el || !el.isConnected) {
                el = doc.createElement("div");
                el.className = CARD_SNIPPET_CONFIG.className;
                try { el.setAttribute("data-tm-hdr-key", rowHdrKey || ""); } catch (_) {}
                el.textContent = text;
                try { host.appendChild(el); } catch (_) {}
              } else {
                try { el.setAttribute("data-tm-hdr-key", rowHdrKey || ""); } catch (_) {}
                try { el.textContent = text; } catch (_) {}
              }
              applied += 1;
              appliedKeys.add(rowHdrKey);

              // Clear pending marker for this hdrKey (MV3 provided it).
              try {
                doc.__tmMsgList = doc.__tmMsgList || {};
                const pending = doc.__tmMsgList.__tmCardSnippetPending || null;
                if (pending && pending.delete) pending.delete(rowHdrKey);
              } catch (_) {}
            }
          }
        }

        if (diag < diagMax) {
          diag += 1;
          console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] provideCardSnippets result`, {
            source,
            items: items.length,
            applied,
            emptySnippetCount,
            subjectMissingCount,
            hostMissingCount,
            outOfRangeCount,
          });
        }

        if (applied < itemsByKey.size && diag < diagMax) {
          const notApplied = [];
          for (const [k] of itemsByKey) {
            if (appliedKeys.has(k)) continue;
            notApplied.push(k);
          }
          noRowMatchCount = notApplied.length - subjectMissingCount - hostMissingCount;
          diag += 1;
          console.log(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] provideCardSnippets not applied`, {
            source,
            items: items.length,
            itemsWithSnippet: itemsByKey.size,
            applied,
            emptySnippetCount,
            subjectMissingCount,
            hostMissingCount,
            noRowMatchCount,
            rowKeysInRange: rowKeysInRange.size,
            sample: notApplied.slice(0, 6),
          });
        }
        return { ok: true, applied };
      } catch (e) {
        console.error(`[TMDBG SnippetDiag][EXP] ${LOG_PREFIX}[CardSnippet] provideCardSnippets failed:`, e);
        return { ok: false, error: String(e) };
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // API RETURN
    // ═══════════════════════════════════════════════════════════════════════

    return {
      tmMessageList: {
        init,
        shutdown,
        recolorNow,
        clearSnippetCache,
        getCardSnippetNeeds,
        provideCardSnippets,
      },
    };
  }
};
