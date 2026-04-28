/*
 * TabMail Message List Table View Experiment
 *
 * Owns table-view DOM painting:
 *   - Sender/correspondent email stripping (shows only display name).
 *   - Row `--tag-color` painting based on `tm_*` keywords (Phase 1: reads
 *     native keywords; Phase 2 will repoint to an IDB-backed action map
 *     pushed by MV3).
 *   - `onUntaggedInboxMessages` event — fires during the recolor pass when
 *     inbox rows have no `tm_*` keyword, so MV3 can enqueue them for
 *     classification (coverage detection).
 *
 * Uses unique variable names with _MLTV suffix to avoid collisions with
 * other experiments.
 */

const { ExtensionSupport: ExtensionSupport_MLTV } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommon_MLTV } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { MailServices: MailServices_MLTV } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

var Services_MLTV = globalThis.Services;

const LOG_PREFIX_MLTV = "[TabMail MessageList TableView]";

console.log(`${LOG_PREFIX_MLTV} experiment parent script loaded.`);

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG_MLTV = {
  logPrefix: LOG_PREFIX_MLTV,
  className: "tm-table-sender-processed",
  maxLogs: 10,
  stripEmail: true,
  // Columns to process
  columnSelectors: [
    '[data-column-name="correspondentcol"]',
    '[data-column-name="sendercol"]',
    '[data-column-name="recipientcol"]',
  ],
};

// TabMail action tag keys (order = paint priority — earliest wins on conflict).
// Mirrors tagSort's sort priority. Phase 2 will replace keyword lookup with an
// IDB-backed action map.
const TM_ACTION_TAG_KEY_PRIORITY_MLTV = ["tm_reply", "tm_none", "tm_archive", "tm_delete"];

// Coverage detection rate limits.
const UNTAGGED_COVERAGE_CONFIG_MLTV = {
  enabled: true,
  logMax: 20,
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════

var tmMessageListTableView = class extends ExtensionCommon_MLTV.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this._tmCleanup_MLTV = null;
    this._onUntaggedFire_MLTV = null; // EventManager fire for onUntaggedInboxMessages
    this._messageManager_MLTV = null; // Convert native hdr → WE message ID
  }

  onShutdown(isAppShutdown) {
    console.log(`${LOG_PREFIX_MLTV} onShutdown() called, isAppShutdown:`, isAppShutdown);
    try {
      if (this._tmCleanup_MLTV) {
        this._tmCleanup_MLTV();
        console.log(`${LOG_PREFIX_MLTV} ✓ Cleanup completed via onShutdown`);
      }
      this._onUntaggedFire_MLTV = null;
    } catch (e) {
      console.error(`${LOG_PREFIX_MLTV} onShutdown cleanup failed:`, e);
    }
  }

  getAPI(context) {
    const self = this;
    let windowListenerId_MLTV = null;
    let isInitialized_MLTV = false;
    let _untaggedCoverageLogCount_MLTV = 0;

    self._messageManager_MLTV = context.extension.messageManager;

    /**
     * Strip email address from sender text, leaving only the name.
     * "John Doe <john@example.com>" -> "John Doe"
     * "john@example.com" -> "john@example.com" (no name, keep email)
     */
    function stripEmailFromText_MLTV(text) {
      if (!text) return text;
      const trimmed = text.trim();
      // Match "Name <email>" pattern
      const match = trimmed.match(/^([^<]+)\s*<[^>]+>\s*$/);
      if (match && match[1]) {
        return match[1].trim();
      }
      return trimmed;
    }

    function enumerateContentDocs_MLTV(win) {
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

    function getCurrentContentWin_MLTV(win) {
      try {
        const tabmail = win?.document?.getElementById?.("tabmail");
        return tabmail?.currentAbout3Pane || tabmail?.currentTabInfo?.chromeBrowser?.contentWindow || tabmail?.currentTabInfo?.browser?.contentWindow || null;
      } catch (_) {
        return null;
      }
    }

    function isTableView_MLTV(doc) {
      // Table view doesn't have thread-card elements
      const hasCards = doc.querySelector('[is="thread-card"]');
      const hasTree = doc.getElementById("threadTree");
      return hasTree && !hasCards;
    }

    /**
     * Process a single table cell - strip email from text content
     */
    function processTableCell_MLTV(cell) {
      if (!cell) return;
      const rawText = cell.textContent || "";
      if (!rawText.includes("<") || !rawText.includes(">")) return; // No email pattern
      
      const nameOnly = stripEmailFromText_MLTV(rawText);
      if (nameOnly && nameOnly !== rawText) {
        cell.textContent = nameOnly;
      }
      // Also update title attribute if present
      const rawTitle = cell.getAttribute?.("title") || "";
      if (rawTitle && rawTitle.includes("<") && rawTitle.includes(">")) {
        const titleNameOnly = stripEmailFromText_MLTV(rawTitle);
        if (titleNameOnly && titleNameOnly !== rawTitle) {
          try { cell.setAttribute("title", titleNameOnly); } catch (_) {}
        }
      }
    }

    /**
     * Process all sender/correspondent cells in a row
     */
    function processTableRow_MLTV(row) {
      if (!row) return;
      for (const selector of CONFIG_MLTV.columnSelectors) {
        try {
          const cell = row.querySelector(selector);
          if (cell) processTableCell_MLTV(cell);
        } catch (_) {}
      }
    }

    /**
     * Process all visible rows in the table
     */
    function processAllTableRows_MLTV(doc) {
      if (!doc) return;
      if (!isTableView_MLTV(doc)) return;
      
      const tree = doc.getElementById("threadTree");
      if (!tree) return;
      
      const rows = tree.querySelectorAll('tr[is="thread-row"], [id^="threadTree-row"]');
      for (const row of rows) {
        processTableRow_MLTV(row);
      }
    }

    let logCount_MLTV = 0;

    /**
     * Patch the ThreadRow custom element to strip emails on render
     */
    function patchThreadRowPrototype_MLTV(doc) {
      try {
        if (!doc?.defaultView) return false;
        const win = doc.defaultView;
        
        const customElementsRegistry = win.customElements;
        if (!customElementsRegistry) return false;

        // Try to get the ThreadRow class
        let ThreadRow = customElementsRegistry.get?.("thread-row");

        if (!ThreadRow) {
          // Try to find an existing thread-row element and get its constructor
          const existingRow = doc.querySelector?.('[is="thread-row"]');
          if (existingRow) {
            ThreadRow = existingRow.constructor;
          }
        }

        if (!ThreadRow) {
          return false;
        }

        const proto = ThreadRow.prototype;

        // Check for fillRow method
        if (typeof proto.fillRow !== "function") {
          if (logCount_MLTV < CONFIG_MLTV.maxLogs) {
            logCount_MLTV++;
            console.log(`${LOG_PREFIX_MLTV} ThreadRow.fillRow not found, listing properties:`,
              Object.getOwnPropertyNames(proto).slice(0, 15));
          }
          return false;
        }

        // Stash the PRISTINE TB fillRow exactly once. On hot-reload the OLD
        // module's wrapper is still installed at proto.fillRow; capturing
        // from there builds a stack of wrappers, each closed over a dead
        // module's state. Snapshot the pristine on first patch so all
        // subsequent patches re-wrap the same baseline.
        if (typeof ThreadRow.__tmTableSenderOrigFillRow !== "function") {
          ThreadRow.__tmTableSenderOrigFillRow = proto.fillRow;
        }
        const origFillRow = ThreadRow.__tmTableSenderOrigFillRow;

        // Identity check: is the wrapper currently on the prototype OUR
        // wrapper from THIS module run? Tag with a closure-unique reference
        // (`processTableRow_MLTV` is defined inside getAPI(), so each module
        // instance has a distinct value). If the current wrapper is from a
        // previous module (e.g., onShutdown didn't restore the prototype
        // before reload), replace it — that wrapper would close over a dead
        // module's state and emit events into a dead extension context.
        if (proto.fillRow?.__tmTableOwner === processTableRow_MLTV) {
          return true; // already our exact wrapper
        }

        const newFillRow = function(...origArgs) {
          origFillRow.apply(this, origArgs);

          if (CONFIG_MLTV.stripEmail) {
            try {
              processTableRow_MLTV(this);
            } catch (_) {}
          }

          // Paint from cache. Uses own-properties `this.view` and `this._index`
          // which TB 145's ThreadRow sets before/during fillRow.
          try {
            const view = this.view || null;
            const rowIndex = Number.isInteger(this._index) ? this._index : -1;
            let hdr = null;
            if (view && rowIndex >= 0) {
              try { hdr = view.getMsgHdrAt?.(rowIndex); } catch (_) {}
              if (!hdr) try { hdr = view.getMessageHdrAt?.(rowIndex); } catch (_) {}
            }
            if (hdr) {
              const action = _lookupActionForRow_MLTV(hdr);
              _paintRowForAction_MLTV(this, action);

              // Coverage detection: if this is an inbox row with no action,
              // fire the event so MV3 can enqueue it for classification.
              if (!action && UNTAGGED_COVERAGE_CONFIG_MLTV.enabled && self._onUntaggedFire_MLTV) {
                try {
                  const folder = hdr.folder;
                  if (folder && _isInboxOrUnifiedInboxFolder_MLTV(folder)) {
                    _fireUntaggedMessage_MLTV(hdr, rowIndex, folder.URI || "");
                  }
                } catch (_) {}
              }
            }
          } catch (_) {}
        };
        newFillRow.__tmTableOwner = processTableRow_MLTV;
        proto.fillRow = newFillRow;

        ThreadRow.__tmTableSenderPatched = true;
        console.log(`${LOG_PREFIX_MLTV} ✓ ThreadRow.fillRow patched for sender stripping`);
        return true;
      } catch (e) {
        console.error(`${LOG_PREFIX_MLTV} patchThreadRowPrototype failed:`, e);
        return false;
      }
    }

    function unpatchThreadRowPrototype_MLTV(doc) {
      try {
        if (!doc?.defaultView) return;
        const win = doc.defaultView;
        let ThreadRow = win.customElements?.get?.("thread-row");
        if (!ThreadRow) {
          const existingRow = doc.querySelector?.('[is="thread-row"]');
          if (existingRow) ThreadRow = existingRow.constructor;
        }
        if (!ThreadRow) return;
        // Restore pristine fillRow so a future patch re-wraps the same
        // baseline rather than stacking on this module's wrapper. The
        // origFillRow stash stays on the constructor (class-static) so the
        // next module instance can still find it.
        if (typeof ThreadRow.__tmTableSenderOrigFillRow === "function") {
          try {
            ThreadRow.prototype.fillRow = ThreadRow.__tmTableSenderOrigFillRow;
          } catch (_) {}
        }
        delete ThreadRow.__tmTableSenderPatched;
        console.log(`${LOG_PREFIX_MLTV} ThreadRow prototype unpatched (fillRow restored)`);
      } catch (e) {
        console.error(`${LOG_PREFIX_MLTV} unpatchThreadRowPrototype failed:`, e);
      }
    }

    /**
     * Attach MutationObserver to catch table row updates
     */
    function attachTableObserver_MLTV(doc) {
      try {
        if (!doc) return;
        if (doc.__tmTableSenderMO_MLTV) return; // Already attached
        
        const tree = doc.getElementById("threadTree");
        if (!tree) return;
        
        const mo = new doc.defaultView.MutationObserver((muts) => {
          try {
            for (const m of muts) {
              // Process added/modified rows
              const targets = [];
              if (m.target) targets.push(m.target);
              for (const n of m.addedNodes || []) {
                if (n.nodeType === 1) targets.push(n);
              }
              
              for (const node of targets) {
                // Find the row element
                const row = node.matches?.('[is="thread-row"], [id^="threadTree-row"]') 
                  ? node 
                  : node.closest?.('[is="thread-row"], [id^="threadTree-row"]');
                if (row) {
                  processTableRow_MLTV(row);
                }
              }
            }
          } catch (_) {}
        });
        
        mo.observe(tree, { childList: true, subtree: true, characterData: true });
        doc.__tmTableSenderMO_MLTV = mo;
        console.log(`${LOG_PREFIX_MLTV} ✓ MutationObserver attached`);
      } catch (e) {
        console.error(`${LOG_PREFIX_MLTV} attachTableObserver failed:`, e);
      }
    }

    function detachTableObserver_MLTV(doc) {
      try {
        if (!doc) return;
        if (doc.__tmTableSenderMO_MLTV) {
          doc.__tmTableSenderMO_MLTV.disconnect();
          delete doc.__tmTableSenderMO_MLTV;
        }
      } catch (_) {}
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ACTION LOOKUP — reads the `tm-action` string property stored on the
    // native msg hdr (written by MV3's actionCache → tmHdr.setAction path).
    // Local mork property, not touched by IMAP sync, synchronously readable.
    // Legacy `tm_*` keyword lookup is kept as a fallback for pre-backfill
    // rows and gets removed with the rest of the legacy machinery in Phase 4.
    // ═══════════════════════════════════════════════════════════════════════

    const TM_ACTION_PROP_NAME_MLTV = "tm-action";

    const _KEYWORD_TO_ACTION_MLTV = {
      tm_reply: "reply",
      tm_none: "none",
      tm_archive: "archive",
      tm_delete: "delete",
    };

    // @deprecated The IMAP-keyword (`tm_*`) representation of action state
    // is no longer written by TabMail (Phase 0; see
    // agent/modules/tagHelper.js header). New surfaces (tmMultiMessageChip)
    // skip this fallback. It survives here for legacy messages tagged
    // before Phase 0; remove once those have decayed out of users' inboxes.
    function _actionFromKeywords_MLTV(hdr) {
      try {
        const kw = hdr?.getStringProperty?.("keywords") || "";
        if (!kw) return null;
        const keys = kw.split(/\s+/).filter(Boolean);
        for (const k of TM_ACTION_TAG_KEY_PRIORITY_MLTV) {
          if (keys.includes(k)) return _KEYWORD_TO_ACTION_MLTV[k] || null;
        }
        return null;
      } catch (_) { return null; }
    }

    /**
     * Primary: `tm-action` hdr property. Falls back to the deprecated
     * `_actionFromKeywords_MLTV` legacy reader for messages tagged before
     * Phase 0 (see that function's @deprecated note).
     */
    function _lookupActionForRow_MLTV(hdr) {
      try {
        const prop = hdr?.getStringProperty?.(TM_ACTION_PROP_NAME_MLTV) || "";
        if (prop) return String(prop);
      } catch (_) {}
      return _actionFromKeywords_MLTV(hdr);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ROW PAINTING
    // ═══════════════════════════════════════════════════════════════════════

    function _isInboxOrUnifiedInboxFolder_MLTV(folder) {
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

    function _findDBView_MLTV(win) {
      if (win.gDBView) return win.gDBView;
      if (win.gFolderDisplay?.view?.dbView) return win.gFolderDisplay.view.dbView;

      let contentWin = null;
      try {
        const tabmail = win.document.getElementById("tabmail");
        contentWin = tabmail?.currentAbout3Pane
          || tabmail?.currentTabInfo?.chromeBrowser?.contentWindow
          || tabmail?.currentTabInfo?.browser?.contentWindow;
      } catch (_) {}

      if (contentWin) {
        if (contentWin.gDBView) return contentWin.gDBView;
        if (contentWin.gFolderDisplay?.view?.dbView) return contentWin.gFolderDisplay.view.dbView;
      }

      const tree = win.document.getElementById("threadTree")
        || contentWin?.document?.getElementById("threadTree")
        || win.document.querySelector("mail-message-list")?.shadowRoot?.getElementById("threadTree")
        || contentWin?.document?.querySelector("mail-message-list")?.shadowRoot?.getElementById("threadTree");
      return tree?.view?.dbView || null;
    }

    function _fireUntaggedMessage_MLTV(hdr, rowIndex, folderUri) {
      try {
        if (!UNTAGGED_COVERAGE_CONFIG_MLTV.enabled) return;
        if (!self._onUntaggedFire_MLTV) return;

        const messageId = hdr?.messageId || "";
        if (!messageId) return;

        // Try to get WebExtension message ID using messageManager.convert()
        let weMsgId = null;
        try {
          if (self._messageManager_MLTV) {
            const weMsg = self._messageManager_MLTV.convert(hdr);
            weMsgId = weMsg?.id || null;
          }
        } catch (_) {}

        const info = {
          messageKey: hdr?.messageKey ?? -1,
          messageId,
          weMsgId,
          folderUri: folderUri || "",
          rowIndex,
        };

        if (_untaggedCoverageLogCount_MLTV < UNTAGGED_COVERAGE_CONFIG_MLTV.logMax) {
          _untaggedCoverageLogCount_MLTV++;
          console.log(`${LOG_PREFIX_MLTV} Firing onUntaggedInboxMessages for:`, messageId.substring(0, 50), "weMsgId:", weMsgId);
        }

        try {
          self._onUntaggedFire_MLTV.async([info]);
        } catch (eFire) {
          console.log(`${LOG_PREFIX_MLTV} Failed to fire onUntaggedInboxMessages event:`, eFire);
        }
      } catch (e) {
        console.log(`${LOG_PREFIX_MLTV} _fireUntaggedMessage error:`, e);
      }
    }

    // Reverse of _KEYWORD_TO_ACTION_MLTV. Used to ask MailServices for the
    // color registered on the native `tm_*` tag def — still used for the
    // `--tag-color` inline var (card view's selected-state CSS reads it).
    const _ACTION_TO_KEYWORD_MLTV = {
      reply: "tm_reply",
      none: "tm_none",
      archive: "tm_archive",
      delete: "tm_delete",
    };

    function _colorForAction_MLTV(action) {
      const key = _ACTION_TO_KEYWORD_MLTV[action];
      if (!key) return null;
      return MailServices_MLTV?.tags?.getColorForKey?.(key) || null;
    }

    const _ACTION_CLASSES_MLTV = [
      "tm-action-reply",
      "tm-action-archive",
      "tm-action-delete",
      "tm-action-none",
    ];

    /**
     * Apply the paint signals to a row element:
     *   (1) Authoritative: inline `background-color` set to a tinted color-mix
     *       of the action's palette color — inline style beats any stylesheet.
     *   (2) Add `tm-action-<name>` class so the accent-stripe CSS rule (left
     *       border on first `<td>`) picks it up, and so card-view CSS can
     *       pattern-match in Phase 3.
     *   (3) Set `--tag-color` inline var — kept for card-view selected-state
     *       CSS that already reads it.
     */
    function _paintRowForAction_MLTV(row, action) {
      if (!row) return;
      try {
        for (const cls of _ACTION_CLASSES_MLTV) {
          if (row.classList?.contains(cls)) row.classList.remove(cls);
        }
        const color = action ? _colorForAction_MLTV(action) : null;
        if (action) {
          const cls = `tm-action-${action}`;
          if (_ACTION_CLASSES_MLTV.includes(cls)) row.classList.add(cls);
        }
        if (color) {
          row.style.setProperty("background-color", `color-mix(in srgb, ${color} 30%, transparent)`, "important");
          row.style.setProperty("--tag-color", color);
        } else {
          row.style.removeProperty("background-color");
          row.style.removeProperty("--tag-color");
        }
      } catch (_) {}
    }

    // No manual recolor pass is needed in Phase 2b — the fillRow patch reads
    // `hdr.getStringProperty("tm-action")` on every row render, and
    // `browser.tmHdr.setAction` fires `view.NoteChange(rowIndex, 1, CHANGED)`
    // after writing the property, which re-invokes our fillRow for the row.

    function ensureTableEnhancements_MLTV(win) {
      try {
        const contentDocs = enumerateContentDocs_MLTV(win);
        for (const cdoc of contentDocs) {
          patchThreadRowPrototype_MLTV(cdoc);
          processAllTableRows_MLTV(cdoc);
          attachTableObserver_MLTV(cdoc);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MLTV} ensureTableEnhancements error:`, e);
      }
    }

    function removeTableEnhancements_MLTV(win) {
      try {
        const contentDocs = enumerateContentDocs_MLTV(win);
        for (const cdoc of contentDocs) {
          unpatchThreadRowPrototype_MLTV(cdoc);
          detachTableObserver_MLTV(cdoc);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MLTV} removeTableEnhancements error:`, e);
      }
    }

    function attachEventHooks_MLTV(win) {
      try {
        if (!win) return;
        const tabmail = win.document.getElementById("tabmail");
        const contentWin = getCurrentContentWin_MLTV(win);
        
        if (contentWin && !contentWin.__tmTableSenderFolderHandler_MLTV) {
          contentWin.__tmTableSenderFolderHandler_MLTV = () => {
            ensureTableEnhancements_MLTV(win);
          };
          contentWin.addEventListener("folderURIChanged", contentWin.__tmTableSenderFolderHandler_MLTV);
        }
        
        if (tabmail?.tabContainer && !win.__tmTableSenderTabHandler_MLTV) {
          win.__tmTableSenderTabHandler_MLTV = () => {
            ensureTableEnhancements_MLTV(win);
          };
          tabmail.tabContainer.addEventListener("TabSelect", win.__tmTableSenderTabHandler_MLTV);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MLTV} attachEventHooks failed:`, e);
      }
    }

    function detachEventHooks_MLTV(win) {
      try {
        if (!win) return;
        const tabmail = win.document.getElementById("tabmail");
        
        if (tabmail?.tabContainer && win.__tmTableSenderTabHandler_MLTV) {
          tabmail.tabContainer.removeEventListener("TabSelect", win.__tmTableSenderTabHandler_MLTV);
          delete win.__tmTableSenderTabHandler_MLTV;
        }
        
        const contentDocs = enumerateContentDocs_MLTV(win);
        for (const cdoc of contentDocs) {
          const cw = cdoc?.defaultView;
          if (cw?.__tmTableSenderFolderHandler_MLTV) {
            cw.removeEventListener("folderURIChanged", cw.__tmTableSenderFolderHandler_MLTV);
            delete cw.__tmTableSenderFolderHandler_MLTV;
          }
        }
      } catch (_) {}
    }

    // ═══════════════════════════════════════════════════════════════════════
    // API FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    async function init_MLTV() {
      console.log(`${LOG_PREFIX_MLTV} ═══ init() called ═══`);
      if (!Services_MLTV?.wm) {
        console.error(`${LOG_PREFIX_MLTV} Services.wm not available!`);
        return;
      }
      if (isInitialized_MLTV) {
        console.log(`${LOG_PREFIX_MLTV} Already initialized, skipping`);
        return;
      }
      isInitialized_MLTV = true;

      const enumWin = Services_MLTV.wm.getEnumerator("mail:3pane");
      while (enumWin.hasMoreElements()) {
        const win = enumWin.getNext();
        if (win.document.readyState === "complete") {
          ensureTableEnhancements_MLTV(win);
          attachEventHooks_MLTV(win);
        } else {
          win.addEventListener("load", () => {
            ensureTableEnhancements_MLTV(win);
            attachEventHooks_MLTV(win);
          }, { once: true });
        }
      }

      windowListenerId_MLTV = context.extension.id + "-tmMessageListTableView";
      ExtensionSupport_MLTV.registerWindowListener(windowListenerId_MLTV, {
        chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
        onLoadWindow: (win) => {
          ensureTableEnhancements_MLTV(win);
          attachEventHooks_MLTV(win);
        },
      });

      console.log(`${LOG_PREFIX_MLTV} ✓ Initialization complete`);
    }

    function cleanup_MLTV() {
      console.log(`${LOG_PREFIX_MLTV} cleanup() called`);
      try {
        if (windowListenerId_MLTV) {
          ExtensionSupport_MLTV.unregisterWindowListener(windowListenerId_MLTV);
          windowListenerId_MLTV = null;
        }
      } catch (_) {}
      try {
        if (Services_MLTV?.wm) {
          const enumWin = Services_MLTV.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            const win = enumWin.getNext();
            detachEventHooks_MLTV(win);
            removeTableEnhancements_MLTV(win);
          }
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MLTV} cleanup error:`, e);
      }
      isInitialized_MLTV = false;
      console.log(`${LOG_PREFIX_MLTV} cleanup() complete`);
    }

    this._tmCleanup_MLTV = cleanup_MLTV;

    async function shutdown_MLTV() {
      console.log(`${LOG_PREFIX_MLTV} shutdown() called from WebExtension API`);
      cleanup_MLTV();
    }

    return {
      tmMessageListTableView: {
        init: init_MLTV,
        shutdown: shutdown_MLTV,

        // Fires when the recolor pass detects inbox rows with no cached
        // action — signals MV3 to enqueue for classification.
        onUntaggedInboxMessages: new ExtensionCommon_MLTV.EventManager({
          context,
          name: "tmMessageListTableView.onUntaggedInboxMessages",
          register: (fire) => {
            console.log(`${LOG_PREFIX_MLTV} onUntaggedInboxMessages listener registered`);
            self._onUntaggedFire_MLTV = fire;
            return () => {
              console.log(`${LOG_PREFIX_MLTV} onUntaggedInboxMessages listener unregistered`);
              self._onUntaggedFire_MLTV = null;
            };
          },
        }).api(),
      },
    };
  }
};
