const { ExtensionSupport: ExtensionSupportMS } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonMS } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

var ServicesMS = globalThis.Services;

var messageSelection = class extends ExtensionCommonMS.ExtensionAPI {
  getAPI(context) {
    let currentSelection = [];
    let selectionCount = 0;
    let isInitialized = false;

    // Store messageManager for converting native headers to WebExtension IDs
    const messageManager = context.extension.messageManager;

    function tlog(...args) {
      console.log("[MessageSelection]", ...args);
    }

    function findDBView(win) {
      if (win.gDBView) return win.gDBView;
      if (win.gFolderDisplay?.view?.dbView) return win.gFolderDisplay.view.dbView;

      let contentWin = null;
      try {
        const tabmail = win.document.getElementById("tabmail");
        contentWin = tabmail?.currentAbout3Pane ||
                     tabmail?.currentTabInfo?.chromeBrowser?.contentWindow ||
                     tabmail?.currentTabInfo?.browser?.contentWindow || null;
      } catch (_) {}

      if (contentWin) {
        if (contentWin.gDBView) return contentWin.gDBView;
        if (contentWin.gFolderDisplay?.view?.dbView) return contentWin.gFolderDisplay.view.dbView;
      }

      const tree =
        win.document.getElementById("threadTree") ||
        contentWin?.document?.getElementById("threadTree") ||
        win.document.querySelector("mail-message-list")?.shadowRoot?.getElementById("threadTree") ||
        contentWin?.document?.querySelector("mail-message-list")?.shadowRoot?.getElementById("threadTree") ||
        null;
      if (tree?.view?.dbView) return tree.view.dbView;
      return null;
    }

    function hdrForRowGeneric(win, view, row) {
      const doc = win.document;
      const tabmail = doc.getElementById("tabmail");
      const contentWin = (() => { try { return tabmail?.currentAbout3Pane || tabmail?.currentTabInfo?.chromeBrowser?.contentWindow || tabmail?.currentTabInfo?.browser?.contentWindow || null; } catch(_) { return null; } })();
      const innerDoc = contentWin?.document || doc;
      const mailList = innerDoc.querySelector("mail-message-list");
      const threadTree = innerDoc.getElementById("threadTree") || mailList?.shadowRoot?.getElementById("threadTree") || null;

      try { if (typeof view?.hdrForRow === "function") { const h = view.hdrForRow(row); if (h) return h; } } catch(_) {}
      try { if (typeof threadTree?.view?.dbView?.hdrForRow === "function") { const h = threadTree.view.dbView.hdrForRow(row); if (h) return h; } } catch(_) {}
      try { if (typeof threadTree?.view?.getMessageHdrAt === "function") { const h = threadTree.view.getMessageHdrAt(row); if (h) return h; } } catch(_) {}
      try { if (typeof threadTree?.view?.getMsgHdrAt === "function") { const h = threadTree.view.getMsgHdrAt(row); if (h) return h; } } catch(_) {}
      try {
        const trEl = innerDoc.getElementById(`threadTree-row${row}`) || threadTree?.querySelector?.(`#threadTree-row${row}`) || null;
        if (trEl?.message) return trEl.message;
      } catch(_) {}
      return null;
    }

    function getCurrentSelection() {
      try {
        tlog("getCurrentSelection() called");
        currentSelection = [];
        selectionCount = 0;

        if (!ServicesMS?.wm) {
          tlog("ServicesMS.wm not available");
          return;
        }
        
        const enumWin = ServicesMS.wm.getEnumerator("mail:3pane");
        tlog("Got window enumerator");
        
        while (enumWin.hasMoreElements()) {
          const win = enumWin.getNext();
          tlog("Processing window, readyState:", win.document?.readyState);
          if (win.document?.readyState !== "complete") continue;

          try {
            const tabmail = win.document.getElementById("tabmail");
            const modeName = (() => { try { return tabmail?.currentTabInfo?.mode?.name || "?"; } catch (_) { return "?"; } })();
            tlog("Window mode:", modeName);
            if (modeName !== "mail3PaneTab") {
              continue;
            }
          } catch (_) { continue; }

          const view = findDBView(win);
          tlog("Found DBView:", !!view);
          if (!view) continue;

          try {
            const sel = view?.selection;
            tlog("Selection object:", !!sel, "count:", sel?.count);
            if (sel && sel.count > 0) {
              let selectedIndices = [];
              for (let i = 0; i < sel.getRangeCount(); i++) {
                let start = {}, end = {};
                sel.getRangeAt(i, start, end);
                for (let j = start.value; j <= end.value; j++) {
                  selectedIndices.push(j);
                }
              }

              tlog("Selected indices:", selectedIndices);
              for (const index of selectedIndices) {
                tlog("Processing index:", index);
                const hdr = hdrForRowGeneric(win, view, index);
                tlog("Got header for index", index, ":", !!hdr);
                if (hdr) {
                  tlog("Header details - messageId:", hdr.messageId, "subject:", hdr.subject, "folderUri:", hdr.folder?.URI || "");
                  // // Normalize folder URI to path format to match cache keys
                  // let folderPath = hdr.folder?.URI || "";
                  // tlog("Original folderPath:", folderPath);
                  // if (folderPath.includes('://')) {
                  //   const match = folderPath.match(/^[^:]+:\/\/[^\/]+\/(.*)$/);
                  //   if (match && match[1]) {
                  //     folderPath = match[1];
                  //   } else {
                  //     // Fallback: take everything after the last '/'
                  //     const uriParts = folderPath.split('/');
                  //     folderPath = uriParts[uriParts.length - 1] || "";
                  //   }
                  //   // Add back the slash at the front
                  //   folderPath = "/" + folderPath;
                  // }
                  // tlog("Normalized folderPath:",  folderPath);

                  // Try to get WebExtension message ID for direct lookup (avoids folder URI resolution)
                  let weMsgId = null;
                  try {
                    if (messageManager) {
                      const weMsg = messageManager.convert(hdr);
                      weMsgId = weMsg?.id || null;
                    }
                  } catch (_) {
                    // Message may not be convertible
                  }

                  const messageInfo = {
                    messageKey: hdr.messageKey ?? null,
                    messageId: hdr.messageId ?? null,  // Email Message-ID header (stable identifier)
                    weMsgId: weMsgId,                  // WebExtension message ID for direct lookup
                    folderUri: hdr.folder?.URI || "",  // XUL folder URI (fallback)
                    subject: hdr.subject || "",
                    author: hdr.author || "",
                    date: (() => {
                      try {
                        // nsIMsgDBHdr.date is PRTime (µs). Convert to ms.
                        const ms = Number(hdr?.date) / 1000;
                        const d = new Date(ms);
                        return isFinite(d.getTime()) ? d.toISOString() : "";
                      } catch { return ""; }
                    })(),
                    folder: hdr.folder?.prettyName || hdr.folder?.name || "",
                    flags: hdr.flags || 0,
                    size: hdr.messageSize || 0
                  };
                  tlog("Created messageInfo:", messageInfo);
                  currentSelection.push(messageInfo);
                  selectionCount++;
                } else {
                  tlog("No header found for index:", index);
                }
              }
            }
          } catch (e) {
            tlog("Error getting selection from view:", e);
          }
        }
        
        tlog("getCurrentSelection() finished - count:", selectionCount, "selection:", currentSelection);
        return currentSelection;
      } catch (e) {
        tlog("FATAL ERROR in getCurrentSelection():", e);
        tlog("Error stack:", e.stack);
        currentSelection = [];
        selectionCount = 0;
        return currentSelection;
      }
    }


    function setupWindowTracking(win) {
      try {
        const doc = win.document;
        const tabmail = doc.getElementById("tabmail");
        const contentWin = (() => { try { return tabmail?.currentAbout3Pane || tabmail?.currentTabInfo?.chromeBrowser?.contentWindow || tabmail?.currentTabInfo?.browser?.contentWindow || null; } catch(_) { return null; } })();
        const innerDoc = contentWin?.document || doc;
        const mailList = innerDoc.querySelector("mail-message-list");
        const threadTree = innerDoc.getElementById("threadTree") || mailList?.shadowRoot?.getElementById("threadTree") || null;

        if (threadTree) {
          // Only register if not already registered (prevents hot reload leak)
          if (threadTree.__messageSelectionSelectHandler) {
            tlog("Select listener already registered for threadTree, skipping");
            return;
          }
          
          const selectHandler = () => {
            // Use Services.tm timer for privileged context
            try {
              ServicesMS.tm.dispatchToMainThread(() => {
                getCurrentSelection();
                // Notify chat windows of selection change
                notifySelectionChange();
              });
            } catch (e) {
              // Fallback: immediate execution without delay
              getCurrentSelection();
              notifySelectionChange();
            }
          };
          
          // Store handler for cleanup (fixes hot reload leak)
          threadTree.__messageSelectionSelectHandler = selectHandler;
          threadTree.addEventListener("select", selectHandler);
          tlog("Select listener registered for threadTree");
        }
      } catch (e) {
        tlog("Error setting up window tracking:", e);
      }
    }


    function notifySelectionChange() {
      try {
        tlog("notifySelectionChange() called - selectionCount:", selectionCount);
        // Send raw message data - JS side will generate unique IDs using getUniqueMessageKey
        const data = JSON.stringify({
          selectedMessages: currentSelection,  // Send full message objects with messageId and folderUri
          selectionCount: selectionCount,
          timestamp: Date.now()
        });
        tlog("Notifying with data:", data);
        
        ServicesMS.obs.notifyObservers(null, "messageSelection-changed", data);
        tlog("Notification sent successfully");
      } catch (e) {
        tlog("Error notifying selection change:", e);
      }
    }

    const listenerId = `${context.extension.id}-messageSelection-windows`;

    const apiObj = {
      messageSelection: {
        onSelectionChanged: new ExtensionCommonMS.EventManager({
          context,
          name: "messageSelection.onSelectionChanged",
          register: (fire) => {
            const obs = (subject, topic, data) => {
              try {
                const parsed = JSON.parse(data);
                fire.async(parsed);
              } catch (e) {
                tlog("Failed to parse selection data:", e);
              }
            };
            ServicesMS.obs.addObserver(obs, "messageSelection-changed");
            return () => ServicesMS.obs.removeObserver(obs, "messageSelection-changed");
          },
        }).api(),
        init() {
          // Guard against multiple initializations (prevents duplicate window listeners)
          if (isInitialized) {
            tlog("Already initialized, skipping");
            return;
          }
          
          isInitialized = true;
          
          // Register window listener for both existing and new windows
          // ExtensionSupport.registerWindowListener handles existing windows automatically
          try {
            // Clean up any previous registrations before initializing
            try {
              ExtensionSupportMS.unregisterWindowListener(listenerId);
            } catch (e) {
              // Expected to fail if no previous listener was registered
            }
            ExtensionSupportMS.registerWindowListener(listenerId, {
              chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
              onLoadWindow(win) {
                // Try immediate setup
                setupWindowTracking(win);
                getCurrentSelection();
                
                // Add TabSelect listener for DOM retry (co-exists fine with tagSort)
                try {
                  const tabmail = win.document.getElementById("tabmail");
                  const tabContainer = tabmail?.tabContainer || null;
                  if (tabContainer && typeof tabContainer.addEventListener === "function") {
                    // Check if we already added our specific listener to avoid duplicates
                    if (!tabContainer.__messageSelectionTabSelectHandler) {
                      const tabSelectHandler = () => {
                        setupWindowTracking(win);
                        getCurrentSelection();
                      };
                      // Store handler for cleanup (fixes hot reload leak)
                      tabContainer.__messageSelectionTabSelectHandler = tabSelectHandler;
                      tabContainer.addEventListener("TabSelect", tabSelectHandler);
                      tlog("TabSelect listener registered for messageSelection");
                    }
                  }
                } catch (e) {
                  tlog("Failed to add TabSelect listener:", e);
                }
                
                // Also try a delayed setup for DOM readiness
                try {
                  ServicesMS.tm.dispatchToMainThread(() => {
                    setupWindowTracking(win);
                    getCurrentSelection();
                  });
                } catch (e) {
                  tlog("Failed delayed setup:", e);
                }
              },
            });
          } catch (e) {
            tlog("Failed to register window listener:", e);
          }
        },
        async getSelectedMessages() {
          try {
            if (!isInitialized) {
              return "";
            }
            
            getCurrentSelection();
            
            // Return JSON string of selected messages - JS side will generate unique IDs
            const result = JSON.stringify(currentSelection || []);
            
            return result;
          } catch (e) {
            tlog("ERROR in getSelectedMessages():", e, e?.stack);
            // Return empty string instead of throwing
            return "";
          }
        },
        async getSelectionCount() {
          try {
            if (!isInitialized) {
              return 0;
            }
            getCurrentSelection();
            return Number(selectionCount) || 0;
          } catch {
            return 0;
          }
        },
        async openSelectedInConversation() {
          try {
            tlog("openSelectedInConversation() called");
            const enumWin = ServicesMS.wm.getEnumerator("mail:3pane");
            
            // Find the active/focused window first
            let activeWin = ServicesMS.wm.getMostRecentWindow("mail:3pane");
            if (activeWin && !activeWin.closed && activeWin.document.readyState === "complete") {
              tlog("Executing cmd_openConversation on most recent window");
              activeWin.goDoCommand("cmd_openConversation");
              return true;
            }
            
            // Fallback to any 3-pane window
            while (enumWin.hasMoreElements()) {
              const win = enumWin.getNext();
              if (win && !win.closed && win.document.readyState === "complete") {
                tlog("Executing cmd_openConversation on available window");
                win.goDoCommand("cmd_openConversation");
                return true;
              }
            }
            
            tlog("No suitable window found for cmd_openConversation");
            return false;
          } catch (e) {
            tlog("Error in openSelectedInConversation:", e);
            return false;
          }
        },
        async openConversationInWindow(windowId) {
          // Important: conversation open must run in the *same* window that owns
          // the selection. Using getMostRecentWindow is unreliable when chat runs
          // in its own window. We try to resolve the WE windowId to the native
          // messenger.xhtml window and invoke the real command there.
          try {
            tlog("openConversationInWindow() called with windowId:", windowId);

            const result = {
              ok: false,
              windowId: Number(windowId),
              resolved: false,
              used: "",
              error: "",
              hasGoDoCommand: false,
              hasMsgOpenSelected: false,
            };

            if (!Number.isFinite(result.windowId)) {
              result.error = "windowId must be a finite number";
              return result;
            }

            let win = null;
            try {
              // Thunderbird extension internals expose windowManager in experiments.
              // This lets us map WebExtension windowId -> native chrome window.
              const wm = context?.extension?.windowManager;
              const wrapper = wm?.get ? wm.get(result.windowId, context) : null;
              win = wrapper?.window || wrapper || null;
              result.resolved = !!win;
            } catch (eGet) {
              result.error = `windowManager.get failed: ${String(eGet)}`;
              win = null;
            }

            // If that failed, fall back to most recent 3-pane (still log that we failed).
            if (!win) {
              try {
                win = ServicesMS?.wm?.getMostRecentWindow?.("mail:3pane") || null;
                result.resolved = !!win;
                result.used = "fallbackMostRecent3pane";
              } catch (_) {}
            }

            if (!win || win.closed) {
              result.error = result.error || "No suitable mail:3pane window resolved";
              return result;
            }

            try {
              result.hasGoDoCommand = typeof win.goDoCommand === "function";
            } catch (_) {}
            try {
              result.hasMsgOpenSelected = typeof win.MsgOpenSelectedMessagesInConversation === "function";
            } catch (_) {}

            // Prefer the direct helper if present; otherwise use the command.
            try {
              if (result.hasMsgOpenSelected) {
                tlog("Calling MsgOpenSelectedMessagesInConversation()");
                win.MsgOpenSelectedMessagesInConversation();
                result.ok = true;
                result.used = "MsgOpenSelectedMessagesInConversation";
                return result;
              }
            } catch (eDirect) {
              result.error = `MsgOpenSelectedMessagesInConversation threw: ${String(eDirect)}`;
            }

            try {
              if (result.hasGoDoCommand) {
                tlog("Calling goDoCommand('cmd_openConversation')");
                win.goDoCommand("cmd_openConversation");
                result.ok = true;
                result.used = "goDoCommand(cmd_openConversation)";
                return result;
              }
            } catch (eCmd) {
              result.error = `goDoCommand threw: ${String(eCmd)}`;
            }

            result.error = result.error || "No known conversation opener available on window";
            return result;
          } catch (e) {
            return {
              ok: false,
              windowId: Number(windowId),
              resolved: false,
              used: "",
              error: String(e),
              hasGoDoCommand: false,
              hasMsgOpenSelected: false,
            };
          }
        },
        shutdown() {
          try {
            // Unregister window listener (may already be unregistered from init)
            try {
              ExtensionSupportMS.unregisterWindowListener(listenerId);
              console.log("[MessageSelection] Unregistered window listener:", listenerId);
            } catch (e) {
              // Already unregistered, ignore
            }
            isInitialized = false;
            
            // Clean up listeners from all windows (fixes hot reload leak)
            if (ServicesMS && ServicesMS.wm) {
              const enumWin = ServicesMS.wm.getEnumerator("mail:3pane");
              while (enumWin.hasMoreElements()) {
                const win = enumWin.getNext();
                try {
                  // Clean up TabSelect listener
                  const tabmail = win.document.getElementById("tabmail");
                  const tabContainer = tabmail?.tabContainer;
                  if (tabContainer && tabContainer.__messageSelectionTabSelectHandler) {
                    tabContainer.removeEventListener("TabSelect", tabContainer.__messageSelectionTabSelectHandler);
                    delete tabContainer.__messageSelectionTabSelectHandler;
                    tlog("[MessageSelection] Removed TabSelect listener from window");
                  }
                  
                  // Clean up threadTree select listener
                  const contentWin = tabmail?.currentAbout3Pane || 
                                    tabmail?.currentTabInfo?.chromeBrowser?.contentWindow ||
                                    tabmail?.currentTabInfo?.browser?.contentWindow || null;
                  if (contentWin) {
                    const innerDoc = contentWin.document;
                    const mailList = innerDoc.querySelector("mail-message-list");
                    const threadTree = innerDoc.getElementById("threadTree") || 
                                      mailList?.shadowRoot?.getElementById("threadTree") || null;
                    
                    if (threadTree && threadTree.__messageSelectionSelectHandler) {
                      threadTree.removeEventListener("select", threadTree.__messageSelectionSelectHandler);
                      delete threadTree.__messageSelectionSelectHandler;
                      tlog("[MessageSelection] Removed select listener from threadTree");
                    }
                  }
                } catch (cleanupErr) {
                  tlog("[MessageSelection] Error cleaning up window:", cleanupErr);
                }
              }
            }
          } catch (e) {
            console.error("[MessageSelection] Error during shutdown cleanup:", e);
          }
        },
      },
    };
    
    return apiObj;
  }
};
