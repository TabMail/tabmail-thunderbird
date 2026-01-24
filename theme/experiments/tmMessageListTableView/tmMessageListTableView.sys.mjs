/*
 * TabMail Message List Table View Experiment
 * 
 * Strips email addresses from sender/correspondent columns in table view.
 * Shows only the display name (e.g., "John Doe" instead of "John Doe <john@example.com>").
 * 
 * Uses unique variable names with _MLTV suffix to avoid collisions with other experiments.
 */

const { ExtensionSupport: ExtensionSupport_MLTV } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommon_MLTV } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
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

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════

var tmMessageListTableView = class extends ExtensionCommon_MLTV.ExtensionAPI {
  onShutdown(isAppShutdown) {
    console.log(`${LOG_PREFIX_MLTV} onShutdown() called, isAppShutdown:`, isAppShutdown);
    try {
      if (this._tmCleanup_MLTV) {
        this._tmCleanup_MLTV();
        console.log(`${LOG_PREFIX_MLTV} ✓ Cleanup completed via onShutdown`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX_MLTV} onShutdown cleanup failed:`, e);
    }
  }

  getAPI(context) {
    let windowListenerId_MLTV = null;
    let isInitialized_MLTV = false;

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

        if (ThreadRow.__tmTableSenderPatched) {
          return true; // Already patched
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

        const origFillRow = proto.fillRow;

        proto.fillRow = function(index, row, dataset, view) {
          // Call original fillRow first
          origFillRow.call(this, index, row, dataset, view);
          
          // Strip email from sender/correspondent columns
          if (CONFIG_MLTV.stripEmail) {
            try {
              processTableRow_MLTV(this);
            } catch (_) {}
          }
        };

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
        if (!ThreadRow || !ThreadRow.__tmTableSenderPatched) return;
        delete ThreadRow.__tmTableSenderPatched;
        console.log(`${LOG_PREFIX_MLTV} ThreadRow prototype unpatch marker removed`);
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
      },
    };
  }
};
