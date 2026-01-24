/*
 * TabMail Message List Tag Coloring Experiment
 * 
 * Manages thread list tag coloring:
 * - Tag coloring (card view + table view)
 * - Row observers for zero-blink updates
 * 
 * Split from tmMessageList for maintainability.
 */

const { ExtensionSupport: ExtensionSupportTC } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonTC } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { MailServices: MailServicesTC } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { NetUtil: NetUtilTC } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

var ServicesTC = globalThis.Services;

const LOG_PREFIX_TC = "[TabMail MessageList TagColoring]";

console.log(`${LOG_PREFIX_TC} experiment parent script loaded. Services present?`, typeof ServicesTC !== "undefined");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// Anti-blink persistence duration (ms) for tag colors
const TAG_PERSISTENCE_DURATION_MS = 500;

// TabMail action tags in priority order (highest priority first).
// We intentionally ignore non-TabMail tags for coloring to prevent IMAP keyword reorder flicker.
const TM_ACTION_TAG_KEY_PRIORITY = ["tm_reply", "tm_none", "tm_archive", "tm_delete"];

// Preference keys for listview mode (toggle button)
const LISTVIEW_PREF_TC = "mail.threadpane.listview";
const TAG_SORT_ENABLED_PREF_TC = "extensions.tabmail.tagSortEnabled";

// Debounce delay for recolor after pref changes (ms)
const RECOLOR_DEBOUNCE_MS_TC = 150;

// ═══════════════════════════════════════════════════════════════════════════
// CACHES
// ═══════════════════════════════════════════════════════════════════════════

// Anti-blink persistence cache for tag colors
// Stores the last valid tag color for a message ID to mask transient "untagged" states
// during Thunderbird's DB transactions.
const TagPersistenceCacheTC = new Map(); // messageId -> { color, time }

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════

var tmMessageListTagColoring = class extends ExtensionCommonTC.ExtensionAPI {
  onShutdown(isAppShutdown) {
    console.log(`${LOG_PREFIX_TC} onShutdown() called by Thunderbird, isAppShutdown:`, isAppShutdown);
    try {
      if (this._tmCleanup) {
        this._tmCleanup();
        console.log(`${LOG_PREFIX_TC} ✓ Cleanup completed via onShutdown`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX_TC} onShutdown cleanup failed:`, e);
    }
  }

  getAPI(context) {
    let windowListenerId = null;
    let paletteData = null;
    let isInitialized = false;
    let _listviewPrefObserver = null;
    let _tagSortEnabledPrefObserver = null;
    let _recolorDebounceTimer = null;

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
          color = MailServicesTC?.tags?.getColorForKey
            ? (MailServicesTC.tags.getColorForKey(k) || null)
            : null;
          if (color) break;
        } catch (_) { color = null; }
      }

      const now = Date.now();
      const messageId = hdr.messageId;

      // 3. If we found a valid color, update cache and return it
      if (color) {
        if (messageId) {
          TagPersistenceCacheTC.set(messageId, { color, time: now });
        }
        return color;
      }

      // 4. If NO color found, check persistence cache to mask blink
      if (messageId && TagPersistenceCacheTC.has(messageId)) {
        const entry = TagPersistenceCacheTC.get(messageId);
        if (now - entry.time < TAG_PERSISTENCE_DURATION_MS) {
          return entry.color;
        } else {
          TagPersistenceCacheTC.delete(messageId);
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

    // Configuration for retry mechanism
    const ATTACH_RETRY_DELAY_MS = 500;
    const ATTACH_MAX_RETRIES = 5;

    function attachMessageListEventHooks(win, reason = "init", retryCount = 0) {
      try {
        if (!win) return;
        const tabmail = win.document.getElementById("tabmail");
        const contentWin = getCurrentContentWin(win);
        console.log(`${LOG_PREFIX_TC} attachMessageListEventHooks(${reason}, retry=${retryCount}): contentWin=${!!contentWin}, tabmail=${!!tabmail}`);

        // If contentWin is not available yet, schedule a retry
        if (!contentWin && retryCount < ATTACH_MAX_RETRIES) {
          console.log(`${LOG_PREFIX_TC} contentWin not available, scheduling retry ${retryCount + 1}/${ATTACH_MAX_RETRIES}`);
          win.__tmTagColoringRetryTimer = win.setTimeout(() => {
            delete win.__tmTagColoringRetryTimer;
            attachMessageListEventHooks(win, reason + "-retry", retryCount + 1);
          }, ATTACH_RETRY_DELAY_MS);
          return;
        }

        if (contentWin) {
          // Track contentWin references for cleanup (like tagSort does)
          if (!win.__tmTagColoringContentWindows) {
            win.__tmTagColoringContentWindows = new Set();
          }
          win.__tmTagColoringContentWindows.add(contentWin);

          if (!contentWin.__tmTagColoringFolderURIHandler) {
            contentWin.__tmTagColoringFolderURIHandler = () => {
              console.log(`${LOG_PREFIX_TC} ▶ folderURIChanged event fired!`);
              ensureTagColoringEnhancements(win);
            };
            contentWin.addEventListener("folderURIChanged", contentWin.__tmTagColoringFolderURIHandler);
            console.log(`${LOG_PREFIX_TC} ✓ Attached folderURIChanged listener to contentWin`);
          } else {
            console.log(`${LOG_PREFIX_TC} folderURIChanged listener already attached`);
          }

          if (!contentWin.__tmTagColoringThreadPaneHandler) {
            contentWin.__tmTagColoringThreadPaneHandler = () => {
              console.log(`${LOG_PREFIX_TC} ▶ threadpane-loaded event fired!`);
              ensureTagColoringEnhancements(win);
            };
            contentWin.addEventListener("threadpane-loaded", contentWin.__tmTagColoringThreadPaneHandler);
            console.log(`${LOG_PREFIX_TC} ✓ Attached threadpane-loaded listener to contentWin`);
          } else {
            console.log(`${LOG_PREFIX_TC} threadpane-loaded listener already attached`);
          }
        } else {
          console.warn(`${LOG_PREFIX_TC} contentWin not available after ${ATTACH_MAX_RETRIES} retries`);
        }

        if (tabmail?.tabContainer && !win.__tmTagColoringTabSelectHandler) {
          win.__tmTagColoringTabSelectHandler = () => {
            console.log(`${LOG_PREFIX_TC} ▶ TabSelect event fired!`);
            attachMessageListEventHooks(win, "TabSelect");
            ensureTagColoringEnhancements(win);
          };
          tabmail.tabContainer.addEventListener("TabSelect", win.__tmTagColoringTabSelectHandler);
          console.log(`${LOG_PREFIX_TC} ✓ Attached TabSelect listener`);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} attachMessageListEventHooks failed:`, e);
      }
    }

    function detachMessageListEventHooks(win) {
      try {
        if (!win) return;
        console.log(`${LOG_PREFIX_TC} detachMessageListEventHooks called`);

        // Cancel any pending retry timer
        if (win.__tmTagColoringRetryTimer) {
          try {
            win.clearTimeout(win.__tmTagColoringRetryTimer);
          } catch (_) {}
          delete win.__tmTagColoringRetryTimer;
          console.log(`${LOG_PREFIX_TC} Cancelled pending retry timer`);
        }

        // Remove TabSelect listener
        const tabmail = win.document.getElementById("tabmail");
        if (tabmail?.tabContainer && win.__tmTagColoringTabSelectHandler) {
          try {
            tabmail.tabContainer.removeEventListener("TabSelect", win.__tmTagColoringTabSelectHandler);
          } catch (_) {}
          delete win.__tmTagColoringTabSelectHandler;
          console.log(`${LOG_PREFIX_TC} Removed TabSelect listener`);
        }

        // Clean up tracked contentWin references (like tagSort does)
        if (win.__tmTagColoringContentWindows) {
          try {
            for (const contentWin of win.__tmTagColoringContentWindows) {
              if (contentWin.__tmTagColoringFolderURIHandler) {
                try { contentWin.removeEventListener("folderURIChanged", contentWin.__tmTagColoringFolderURIHandler); } catch (_) {}
                delete contentWin.__tmTagColoringFolderURIHandler;
              }
              if (contentWin.__tmTagColoringThreadPaneHandler) {
                try { contentWin.removeEventListener("threadpane-loaded", contentWin.__tmTagColoringThreadPaneHandler); } catch (_) {}
                delete contentWin.__tmTagColoringThreadPaneHandler;
              }
            }
            win.__tmTagColoringContentWindows.clear();
            delete win.__tmTagColoringContentWindows;
            console.log(`${LOG_PREFIX_TC} Removed contentWin listeners from tracked windows`);
          } catch (e) {
            console.error(`${LOG_PREFIX_TC} Error cleaning up contentWin listeners:`, e);
          }
        }

        // Also clean up via enumerateContentDocs (fallback for any missed contentWins)
        try {
          const contentDocs = enumerateContentDocs(win);
          for (const cdoc of contentDocs) {
            const cw = cdoc?.defaultView;
            if (!cw) continue;
            if (cw.__tmTagColoringFolderURIHandler) {
              try { cw.removeEventListener("folderURIChanged", cw.__tmTagColoringFolderURIHandler); } catch (_) {}
              delete cw.__tmTagColoringFolderURIHandler;
            }
            if (cw.__tmTagColoringThreadPaneHandler) {
              try { cw.removeEventListener("threadpane-loaded", cw.__tmTagColoringThreadPaneHandler); } catch (_) {}
              delete cw.__tmTagColoringThreadPaneHandler;
            }
          }
        } catch (_) {}
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} detachMessageListEventHooks failed:`, e);
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
          console.log(`${LOG_PREFIX_TC} applyTagColorsToDoc applied to ${applied} rows in`, doc.location?.href);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} applyTagColorsToDoc error:`, e);
      }
    }

    // Light DOM row coloring (both Card View and Table View)
    function attachLightDOMRowColoring(doc) {
      if (isBusy(doc)) return;
      const tree = doc.getElementById("threadTree");
      if (!tree || tree.__tmRowColorMO_TC) return;

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
              } catch (_) {}
            }
          }
        }
      });

      mo.observe(tree, { childList: true, subtree: true });
      tree.__tmRowColorMO_TC = mo;
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
      if (!sr || sr.__tmRowColorObserver_TC) return;

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
      sr.__tmRowColorObserver_TC = { rowsMO: mo };
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
      if (cdoc.__tmMailListMO_TC) return;
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
      cdoc.__tmMailListMO_TC = mo;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FOLDER NOTIFICATION LISTENER (immediate recolor on tag changes)
    // ═══════════════════════════════════════════════════════════════════════

    function registerFolderListener(ctx) {
      if (ctx.__tmFolderListener_TC) return;

      try {
        const MFN = MailServicesTC.mfn;
        const Flags = Ci.nsIMsgFolderNotificationService;
        // NOTE: There is NO msgKeywordsChanged or msgTagsChanged flag in TB API!
        // Keyword/tag changes are notified via msgPropertyChanged with property="keywords"
        // Callback name is msgPropertyChanged (no "on" prefix per IDL definition)
        const mask = Flags.msgsClassified | Flags.msgPropertyChanged | Flags.msgsMoveCopyCompleted;
        console.log(`${LOG_PREFIX_TC} Registering folder listener with mask:`, mask, 
          `(msgsClassified=${Flags.msgsClassified}, msgPropertyChanged=${Flags.msgPropertyChanged}, msgsMoveCopyCompleted=${Flags.msgsMoveCopyCompleted})`);

        ctx.__tmFolderListener_TC = {
          // IDL callback: msgPropertyChanged (some TB layers may add "on" prefix)
          msgPropertyChanged(hdr, prop, oldVal, newVal) {
            console.log(`${LOG_PREFIX_TC} msgPropertyChanged: prop=${prop}, messageId=${hdr?.messageId?.slice(0,30) || "?"}`);
            if (prop === "keywords") this.handleKeywordsChange(hdr);
          },
          // Also provide with "on" prefix in case TB uses that convention
          onMsgPropertyChanged(hdr, prop, oldVal, newVal) {
            console.log(`${LOG_PREFIX_TC} onMsgPropertyChanged: prop=${prop}, messageId=${hdr?.messageId?.slice(0,30) || "?"}`);
            if (prop === "keywords") this.handleKeywordsChange(hdr);
          },
          msgsClassified(messages, junkProcessed, traitProcessed) {
            console.log(`${LOG_PREFIX_TC} msgsClassified: ${messages?.length || 0} messages`);
            for (const hdr of messages) this.handleKeywordsChange(hdr);
          },
          onMsgsClassified(messages, junkProcessed, traitProcessed) {
            console.log(`${LOG_PREFIX_TC} onMsgsClassified: ${messages?.length || 0} messages`);
            for (const hdr of messages) this.handleKeywordsChange(hdr);
          },
          msgsMoveCopyCompleted(move, srcMsgs, destFldr, destMsgs) {
            console.log(`${LOG_PREFIX_TC} msgsMoveCopyCompleted: ${move ? 'move' : 'copy'}, ${destMsgs?.length || 0} msgs`);
            for (const hdr of destMsgs) this.handleKeywordsChange(hdr);
          },
          onMsgsMoveCopyCompleted(move, srcMsgs, destFldr, destMsgs) {
            console.log(`${LOG_PREFIX_TC} onMsgsMoveCopyCompleted: ${move ? 'move' : 'copy'}, ${destMsgs?.length || 0} msgs`);
            for (const hdr of destMsgs) this.handleKeywordsChange(hdr);
          },
          handleKeywordsChange(hdr) {
            try {
              const color = resolveTagColor(hdr);
              const win = ServicesTC.wm.getMostRecentWindow("mail:3pane");
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
              console.error(`${LOG_PREFIX_TC} handleKeywordsChange failed:`, e);
            }
          }
        };

        MFN.addListener(ctx.__tmFolderListener_TC, mask);
        console.log(`${LOG_PREFIX_TC} ✓ Folder notification listener registered`);
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} Failed to register folder listener:`, e);
      }
    }

    function unregisterFolderListener(ctx) {
      if (!ctx.__tmFolderListener_TC) return;
      try {
        MailServicesTC.mfn.removeListener(ctx.__tmFolderListener_TC);
        delete ctx.__tmFolderListener_TC;
        console.log(`${LOG_PREFIX_TC} ✓ Folder notification listener removed`);
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} Failed to remove folder listener:`, e);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // WINDOW SETUP
    // ═══════════════════════════════════════════════════════════════════════

    function ensureTagColoringEnhancements(win) {
      try {
        const contentDocs = enumerateContentDocs(win);
        console.log(`${LOG_PREFIX_TC} ensureTagColoringEnhancements: processing ${contentDocs.length} docs`);

        for (const cdoc of contentDocs) {
          const isCard = isCardView(cdoc);
          console.log(`${LOG_PREFIX_TC} Processing doc: isCardView=${isCard}, url=${cdoc.location?.href?.slice(0,50) || "?"}`);
          
          // Shadow DOM tag colors (only if mail-message-list exists)
          applyShadowTagColors(cdoc);
          watchForNewMailMessageLists(cdoc);

          // Light DOM tag colors (both Card View with [is="thread-card"] AND Table View)
          // TB 145 Card View uses light DOM rows, not shadow DOM!
          applyTagColorsToDoc(cdoc);
          attachLightDOMRowColoring(cdoc);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} ensureTagColoringEnhancements error:`, e);
      }
    }

    function removeTagColoringEnhancements(win) {
      try {
        // Remove event hooks (folderURIChanged, threadpane-loaded, TabSelect)
        detachMessageListEventHooks(win);
        const contentDocs = enumerateContentDocs(win);
        for (const cdoc of contentDocs) {
          // Disconnect light DOM observer
          try {
            const tree = cdoc.getElementById("threadTree");
            if (tree?.__tmRowColorMO_TC) {
              tree.__tmRowColorMO_TC.disconnect();
              delete tree.__tmRowColorMO_TC;
            }
          } catch (_) {}

          // Disconnect mail-message-list observer
          try {
            if (cdoc.__tmMailListMO_TC) {
              cdoc.__tmMailListMO_TC.disconnect();
              delete cdoc.__tmMailListMO_TC;
            }
          } catch (_) {}

          // Disconnect shadow observers
          try {
            const mailLists = cdoc.querySelectorAll("mail-message-list");
            for (const mm of mailLists) {
              const sr = mm?.shadowRoot;
              if (sr?.__tmRowColorObserver_TC) {
                sr.__tmRowColorObserver_TC.rowsMO?.disconnect();
                delete sr.__tmRowColorObserver_TC;
              }
            }
          } catch (_) {}
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} removeTagColoringEnhancements error:`, e);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PALETTE LOADING
    // ═══════════════════════════════════════════════════════════════════════

    // Privileged file reading (for experiment parent context)
    function readTextPrivileged(url) {
      return new Promise((resolve, reject) => {
        NetUtilTC.asyncFetch(
          {
            uri: url,
            loadingPrincipal: ServicesTC.scriptSecurityManager.getSystemPrincipal(),
            securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
            contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
          },
          (inputStream, status) => {
            try {
              if (!Components.isSuccessCode(status)) {
                reject(new Error("asyncFetch failed: " + status));
                return;
              }
              const data = NetUtilTC.readInputStreamToString(inputStream, inputStream.available());
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
        console.error(`${LOG_PREFIX_TC} Failed to load palette.data.json:`, e);
        return null;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RECOLOR NOW
    // ═══════════════════════════════════════════════════════════════════════

    function recolorNow(reason = "recolorNow") {
      try {
        console.log(`${LOG_PREFIX_TC} recolorNow() called reason=${reason}`);
        const enumWin = ServicesTC.wm.getEnumerator("mail:3pane");
        while (enumWin.hasMoreElements()) {
          const win = enumWin.getNext();
          try {
            const contentDocs = enumerateContentDocs(win);
            for (const cdoc of contentDocs) {
              // Shadow DOM (if mail-message-list exists)
              applyShadowTagColors(cdoc);
              // Light DOM (both Card View and Table View)
              applyTagColorsToDoc(cdoc);
            }
          } catch (e) {
            console.error(`${LOG_PREFIX_TC} recolorNow failed for window:`, e);
          }
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} recolorNow failed:`, e);
      }
    }

    // Debounced recolor for preference changes
    function scheduleRecolor(reason) {
      try {
        if (_recolorDebounceTimer) {
          try { _recolorDebounceTimer.cancel(); } catch (_) {}
        }
        _recolorDebounceTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        _recolorDebounceTimer.initWithCallback(
          { notify() { recolorNow(reason); } },
          RECOLOR_DEBOUNCE_MS_TC,
          Ci.nsITimer.TYPE_ONE_SHOT
        );
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} scheduleRecolor failed:`, e);
        // Fallback: immediate recolor
        recolorNow(reason);
      }
    }

    // Register preference observers for listview toggle and tag sort enabled
    function registerPrefObservers() {
      try {
        // Observe listview pref changes (toggle button)
        if (ServicesTC?.prefs?.addObserver && !_listviewPrefObserver) {
          _listviewPrefObserver = {
            observe(subject, topic, data) {
              try {
                if (topic !== "nsPref:changed") return;
                if (data !== LISTVIEW_PREF_TC) return;
                console.log(`${LOG_PREFIX_TC} Pref changed: ${LISTVIEW_PREF_TC} -> scheduling recolor`);
                scheduleRecolor("listview-pref-changed");
              } catch (e) {
                console.error(`${LOG_PREFIX_TC} listview pref observer error:`, e);
              }
            },
          };
          ServicesTC.prefs.addObserver(LISTVIEW_PREF_TC, _listviewPrefObserver);
          console.log(`${LOG_PREFIX_TC} ✓ Added prefs observer for ${LISTVIEW_PREF_TC}`);
        }

        // Observe tag sort enabled pref changes
        if (ServicesTC?.prefs?.addObserver && !_tagSortEnabledPrefObserver) {
          _tagSortEnabledPrefObserver = {
            observe(subject, topic, data) {
              try {
                if (topic !== "nsPref:changed") return;
                if (data !== TAG_SORT_ENABLED_PREF_TC) return;
                console.log(`${LOG_PREFIX_TC} Pref changed: ${TAG_SORT_ENABLED_PREF_TC} -> scheduling recolor`);
                scheduleRecolor("tagsort-pref-changed");
              } catch (e) {
                console.error(`${LOG_PREFIX_TC} tagSortEnabled pref observer error:`, e);
              }
            },
          };
          ServicesTC.prefs.addObserver(TAG_SORT_ENABLED_PREF_TC, _tagSortEnabledPrefObserver);
          console.log(`${LOG_PREFIX_TC} ✓ Added prefs observer for ${TAG_SORT_ENABLED_PREF_TC}`);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} Failed to register pref observers:`, e);
      }
    }

    function unregisterPrefObservers() {
      try {
        if (_listviewPrefObserver && ServicesTC?.prefs?.removeObserver) {
          ServicesTC.prefs.removeObserver(LISTVIEW_PREF_TC, _listviewPrefObserver);
          console.log(`${LOG_PREFIX_TC} ✓ Removed prefs observer for ${LISTVIEW_PREF_TC}`);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} Failed to remove listview pref observer:`, e);
      }
      _listviewPrefObserver = null;

      try {
        if (_tagSortEnabledPrefObserver && ServicesTC?.prefs?.removeObserver) {
          ServicesTC.prefs.removeObserver(TAG_SORT_ENABLED_PREF_TC, _tagSortEnabledPrefObserver);
          console.log(`${LOG_PREFIX_TC} ✓ Removed prefs observer for ${TAG_SORT_ENABLED_PREF_TC}`);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} Failed to remove tagSortEnabled pref observer:`, e);
      }
      _tagSortEnabledPrefObserver = null;

      // Cancel any pending recolor timer
      try {
        if (_recolorDebounceTimer) {
          _recolorDebounceTimer.cancel();
          _recolorDebounceTimer = null;
        }
      } catch (_) {}
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INIT / SHUTDOWN
    // ═══════════════════════════════════════════════════════════════════════

    async function init(_opts = {}) {
      console.log(`${LOG_PREFIX_TC} ═══ init() called ═══`);
      console.log(`${LOG_PREFIX_TC} windowListenerId:`, windowListenerId);
      console.log(`${LOG_PREFIX_TC} isInitialized:`, isInitialized);

      if (!ServicesTC || !ServicesTC.wm) {
        console.error(`${LOG_PREFIX_TC} Services.wm not available!`);
        return;
      }

      if (isInitialized) {
        console.log(`${LOG_PREFIX_TC} Already initialized, skipping`);
        return;
      }

      isInitialized = true;

      // Load palette data for tm_untagged color
      try {
        paletteData = await loadPaletteJSON(context);
        console.log(`${LOG_PREFIX_TC} ✓ Palette data loaded for untagged color:`, paletteData?.TAG_COLORS?.tm_untagged);
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} Failed to load palette data:`, e);
      }

      // Register folder listener for immediate tag color updates
      registerFolderListener(context);

      // Register preference observers for listview toggle and tag sort
      registerPrefObservers();

      // Existing windows
      const enumWin = ServicesTC.wm.getEnumerator("mail:3pane");
      while (enumWin.hasMoreElements()) {
        const win = enumWin.getNext();
        if (win.document.readyState === "complete") {
          ensureTagColoringEnhancements(win);
          attachMessageListEventHooks(win, "init-existing");
        } else {
          win.addEventListener("load", () => {
            ensureTagColoringEnhancements(win);
            attachMessageListEventHooks(win, "init-load");
          }, { once: true });
        }
      }

      // Future windows
      windowListenerId = context.extension.id + "-tmMessageListTagColoring";
      ExtensionSupportTC.registerWindowListener(windowListenerId, {
        chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
        onLoadWindow: (win) => {
          ensureTagColoringEnhancements(win);
          attachMessageListEventHooks(win, "onLoadWindow");
        },
      });
      context.__tmTagColoringWindowListenerRegistered = true;

      console.log(`${LOG_PREFIX_TC} ✓ Initialization complete`);
    }

    function cleanup() {
      console.log(`${LOG_PREFIX_TC} cleanup() called`);

      // Remove preference observers
      unregisterPrefObservers();

      // Remove folder listener
      unregisterFolderListener(context);

      // Unregister window listener
      try {
        if (windowListenerId && context.__tmTagColoringWindowListenerRegistered) {
          ExtensionSupportTC.unregisterWindowListener(windowListenerId);
          windowListenerId = null;
          context.__tmTagColoringWindowListenerRegistered = false;
        }
      } catch (_) {}

      // Clean up all windows
      try {
        if (ServicesTC?.wm) {
          const enumWin = ServicesTC.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            removeTagColoringEnhancements(enumWin.getNext());
          }
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_TC} Error during cleanup:`, e);
      }

      // Clear caches
      TagPersistenceCacheTC.clear();

      isInitialized = false;
      console.log(`${LOG_PREFIX_TC} cleanup() complete`);
    }

    this._tmCleanup = cleanup;

    async function shutdown() {
      console.log(`${LOG_PREFIX_TC} shutdown() called from WebExtension API`);
      cleanup();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // API RETURN
    // ═══════════════════════════════════════════════════════════════════════

    // Refresh method for external callers (e.g., tagHelper.js after tag changes)
    function refresh() {
      console.log(`${LOG_PREFIX_TC} refresh() called`);
      scheduleRecolor("refresh-api-call");
    }

    return {
      tmMessageListTagColoring: {
        init,
        shutdown,
        recolorNow,
        refresh,
      },
    };
  }
};
