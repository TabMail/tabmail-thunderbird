/*
 * TabMail Stale Row Filter Experiment
 * 
 * Workaround for Thunderbird unified inbox bug that causes "stale" rows to appear.
 * These rows have empty subject/correspondent and date showing Unix epoch.
 * 
 * CSS hides these rows visually. This experiment:
 * 1. Scans for stale rows and marks them read + attempts delete
 * 2. On selection change, if on stale row → moves to previous message
 * 
 * Uses unique variable names with _SRF suffix to avoid collisions.
 */

const { ExtensionSupport: ExtensionSupport_SRF } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommon_SRF } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

var Services_SRF = globalThis.Services;

const LOG_PREFIX_SRF = "[StaleRowFilter]";

function srfLog(...args) {
  try {
    console.log(LOG_PREFIX_SRF, ...args);
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG_SRF = {
  scanDebounceMs: 100,
  maxLogs: 30,
};

let _logCount_SRF = 0;

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════

var staleRowFilter = class extends ExtensionCommon_SRF.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this._cleanup_SRF = null;
  }

  onShutdown(isAppShutdown) {
    srfLog("onShutdown() called, isAppShutdown:", isAppShutdown);
    try {
      if (this._cleanup_SRF) {
        this._cleanup_SRF();
        srfLog("✓ Cleanup completed via onShutdown");
      }
    } catch (e) {
      console.error(`${LOG_PREFIX_SRF} onShutdown cleanup failed:`, e);
    }
  }

  getAPI(context) {
    const self = this;
    let isInitialized_SRF = false;
    let _didCleanup_SRF = false;
    let _windowListenerRegistered_SRF = false;

    const listenerId_SRF = `${context.extension.id}-staleRowFilter-windows`;

    // ═══════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    function findDBView_SRF(win) {
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

      return null;
    }

    function getCurrentContentWin_SRF(win) {
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

    function getContentDoc_SRF(win) {
      const contentWin = getCurrentContentWin_SRF(win);
      return contentWin?.document || win.document;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STALE ROW DETECTION
    // ═══════════════════════════════════════════════════════════════════════

    function isStaleRow_SRF(row) {
      if (!row) return false;
      try {
        const subjectCell = row.querySelector('[data-column-name="subjectcol"]');
        const subjectTitle = subjectCell?.getAttribute("title") || "";
        
        const correspondentCell = row.querySelector('[data-column-name="correspondentcol"]');
        const correspondentTitle = correspondentCell?.getAttribute("title") || "";
        
        const senderCell = row.querySelector('[data-column-name="sendercol"]');
        const senderTitle = senderCell?.getAttribute("title") || "";
        
        return subjectTitle === "" && correspondentTitle === "" && senderTitle === "";
      } catch (_) {
        return false;
      }
    }

    function getRowIndex_SRF(row) {
      if (!row?.id) return -1;
      const match = /threadTree-row(\d+)/.exec(row.id);
      return match ? parseInt(match[1], 10) : -1;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ACTIONS: MARK READ + DELETE
    // ═══════════════════════════════════════════════════════════════════════

    function markStaleMessageReadAndDelete_SRF(win, view, rowIndex) {
      try {
        let hdr = null;
        try { hdr = view?.getMsgHdrAt?.(rowIndex); } catch (_) {}
        if (!hdr) try { hdr = view?.getMessageHdrAt?.(rowIndex); } catch (_) {}
        if (!hdr) return;

        const messageId = hdr.messageId || "";
        
        // Mark as read if unread
        try {
          if (!hdr.isRead) {
            hdr.markRead(true);
            if (_logCount_SRF < CONFIG_SRF.maxLogs) {
              _logCount_SRF++;
              srfLog(`Marked stale message as read: row=${rowIndex} mid=${messageId.substring(0, 30)}`);
            }
          }
        } catch (eRead) {
          srfLog(`Failed to mark read: ${eRead}`);
        }

        // Attempt delete
        try {
          const folder = hdr.folder;
          if (folder) {
            const msgArray = Cc["@mozilla.org/array;1"]?.createInstance?.(Ci.nsIMutableArray);
            if (msgArray) {
              msgArray.appendElement(hdr);
              folder.deleteMessages(msgArray, null, false, false, null, false);
              if (_logCount_SRF < CONFIG_SRF.maxLogs) {
                _logCount_SRF++;
                srfLog(`Deleted stale message: row=${rowIndex} mid=${messageId.substring(0, 30)}`);
              }
            }
          }
        } catch (eDelete) {
          srfLog(`Failed to delete stale message: ${eDelete}`);
        }
      } catch (e) {
        srfLog(`markStaleMessageReadAndDelete error: ${e}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SCAN ROWS
    // ═══════════════════════════════════════════════════════════════════════

    function scanAndProcessStaleRows_SRF(win) {
      try {
        const doc = getContentDoc_SRF(win);
        const tree = doc?.getElementById("threadTree");
        if (!tree) return;

        const view = findDBView_SRF(win);
        if (!view) return;

        const rows = tree.querySelectorAll('[id^="threadTree-row"]');
        
        for (const row of rows) {
          if (isStaleRow_SRF(row)) {
            const idx = getRowIndex_SRF(row);
            if (idx >= 0) {
              markStaleMessageReadAndDelete_SRF(win, view, idx);
            }
          }
        }
      } catch (e) {
        srfLog(`scanAndProcessStaleRows error: ${e}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SELECTION CHANGE HANDLER
    // ═══════════════════════════════════════════════════════════════════════

    function handleSelectionChange_SRF(win) {
      try {
        const doc = getContentDoc_SRF(win);
        const tree = doc?.getElementById("threadTree");
        if (!tree) return;

        // Find currently selected row
        const selectedRow = tree.querySelector('[id^="threadTree-row"].selected, [id^="threadTree-row"][aria-selected="true"]');
        if (!selectedRow) return;

        if (isStaleRow_SRF(selectedRow)) {
          const currentIdx = getRowIndex_SRF(selectedRow);
          if (_logCount_SRF < CONFIG_SRF.maxLogs) {
            _logCount_SRF++;
            srfLog(`Selection landed on stale row ${currentIdx}, moving to previous`);
          }

          // Move to previous row
          const view = findDBView_SRF(win);
          if (view?.selection && currentIdx > 0) {
            // Find previous non-stale row
            for (let i = currentIdx - 1; i >= 0; i--) {
              const prevRow = doc.getElementById(`threadTree-row${i}`);
              if (prevRow && !isStaleRow_SRF(prevRow)) {
                view.selection.select(i);
                return;
              }
            }
            // If all previous are stale, select row 0
            view.selection.select(0);
          } else if (tree.selectedIndex !== undefined && currentIdx > 0) {
            tree.selectedIndex = currentIdx - 1;
          }
        }
      } catch (e) {
        srfLog(`handleSelectionChange error: ${e}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // WINDOW SETUP
    // ═══════════════════════════════════════════════════════════════════════

    function setupWindow_SRF(win) {
      try {
        if (!win) return;
        
        const doc = getContentDoc_SRF(win);
        const tree = doc?.getElementById("threadTree");
        if (!tree) return;

        // Initial scan
        scanAndProcessStaleRows_SRF(win);

        // MutationObserver for DOM changes
        // Uses leading + trailing pattern: scan immediately, then also after debounce settles
        if (!doc.__tmSRF_MO) {
          doc.__tmSRF_trailingTimer = null;
          doc.__tmSRF_lastScanTime = 0;
          
          const mo = new doc.defaultView.MutationObserver(() => {
            const now = Date.now();
            
            // Leading: scan immediately if enough time has passed since last scan
            if (now - (doc.__tmSRF_lastScanTime || 0) > CONFIG_SRF.scanDebounceMs) {
              doc.__tmSRF_lastScanTime = now;
              scanAndProcessStaleRows_SRF(win);
            }
            
            // Trailing: always (re)schedule a scan after debounce period
            if (doc.__tmSRF_trailingTimer) doc.defaultView.clearTimeout(doc.__tmSRF_trailingTimer);
            doc.__tmSRF_trailingTimer = doc.defaultView.setTimeout(() => {
              doc.__tmSRF_lastScanTime = Date.now();
              scanAndProcessStaleRows_SRF(win);
              doc.__tmSRF_trailingTimer = null;
            }, CONFIG_SRF.scanDebounceMs);
          });
          
          mo.observe(tree, { childList: true, subtree: true });
          doc.__tmSRF_MO = mo;
        }

        // Selection change listener
        if (!tree.__tmSRF_selectHandler) {
          tree.__tmSRF_selectHandler = () => {
            // Small delay to let TB finish updating selection state
            doc.defaultView.setTimeout(() => handleSelectionChange_SRF(win), 10);
          };
          tree.addEventListener("select", tree.__tmSRF_selectHandler);
        }

        // Also listen for folder changes to re-setup
        const contentWin = getCurrentContentWin_SRF(win);
        if (contentWin && !contentWin.__tmSRF_folderHandler) {
          contentWin.__tmSRF_folderHandler = () => {
            doc.defaultView.setTimeout(() => setupWindow_SRF(win), 50);
          };
          contentWin.addEventListener("folderURIChanged", contentWin.__tmSRF_folderHandler);
        }

        srfLog("Window setup complete");
      } catch (e) {
        srfLog(`setupWindow error: ${e}`);
      }
    }

    function teardownWindow_SRF(win) {
      try {
        if (!win) return;
        
        const doc = getContentDoc_SRF(win);
        
        if (doc?.__tmSRF_MO) {
          doc.__tmSRF_MO.disconnect();
          delete doc.__tmSRF_MO;
        }
        if (doc?.__tmSRF_trailingTimer) {
          try { doc.defaultView.clearTimeout(doc.__tmSRF_trailingTimer); } catch (_) {}
          delete doc.__tmSRF_trailingTimer;
        }
        if (doc?.__tmSRF_lastScanTime !== undefined) {
          delete doc.__tmSRF_lastScanTime;
        }
        
        const tree = doc?.getElementById("threadTree");
        if (tree?.__tmSRF_selectHandler) {
          tree.removeEventListener("select", tree.__tmSRF_selectHandler);
          delete tree.__tmSRF_selectHandler;
        }

        const contentWin = getCurrentContentWin_SRF(win);
        if (contentWin?.__tmSRF_folderHandler) {
          contentWin.removeEventListener("folderURIChanged", contentWin.__tmSRF_folderHandler);
          delete contentWin.__tmSRF_folderHandler;
        }
      } catch (e) {
        srfLog(`teardownWindow error: ${e}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INIT / SHUTDOWN
    // ═══════════════════════════════════════════════════════════════════════

    const cleanup_SRF = () => {
      if (_didCleanup_SRF) return;
      _didCleanup_SRF = true;

      srfLog("cleanup() called");
      
      try {
        if (Services_SRF?.wm) {
          const enumWin = Services_SRF.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            teardownWindow_SRF(enumWin.getNext());
          }
        }
      } catch (e) {
        srfLog(`cleanup error: ${e}`);
      }

      try {
        if (_windowListenerRegistered_SRF) {
          ExtensionSupport_SRF.unregisterWindowListener(listenerId_SRF);
          _windowListenerRegistered_SRF = false;
        }
      } catch (_) {}

      isInitialized_SRF = false;
      srfLog("cleanup() complete");
    };

    self._cleanup_SRF = cleanup_SRF;

    return {
      staleRowFilter: {
        init() {
          srfLog("═══ init() called ═══");
          
          if (!Services_SRF?.wm) {
            srfLog("Services.wm not available!");
            return;
          }
          
          if (isInitialized_SRF) {
            srfLog("Already initialized, skipping");
            return;
          }
          
          isInitialized_SRF = true;
          _didCleanup_SRF = false;
          
          // Setup existing windows
          const enumWin = Services_SRF.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            const win = enumWin.getNext();
            if (win.document.readyState === "complete") {
              setupWindow_SRF(win);
            } else {
              win.addEventListener("load", () => setupWindow_SRF(win), { once: true });
            }
          }
          
          // Register for new windows
          try {
            if (_windowListenerRegistered_SRF) {
              try { ExtensionSupport_SRF.unregisterWindowListener(listenerId_SRF); } catch (_) {}
            }
            
            ExtensionSupport_SRF.registerWindowListener(listenerId_SRF, {
              chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
              onLoadWindow(win) {
                setupWindow_SRF(win);
              },
            });
            _windowListenerRegistered_SRF = true;
          } catch (e) {
            srfLog(`Failed to register window listener: ${e}`);
          }
          
          srfLog("✓ Initialization complete");
        },

        shutdown() {
          srfLog("shutdown() called");
          cleanup_SRF();
        },
      },
    };
  }
};
