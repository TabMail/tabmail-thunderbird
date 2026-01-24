const { ExtensionSupport: ExtensionSupportTT } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonTT } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var ServicesTT = globalThis.Services;

console.log("[TabMail ThreadTT] experiment parent script loaded. Services present?", typeof ServicesTT !== "undefined");

var threadTooltip = class extends ExtensionCommonTT.ExtensionAPI {
  getAPI(context) {
    // Shared hover state object accessible by all inner functions.
    let hoverState = { msgId: null, win: null, x: 0, y: 0, tooltipEl: null, row: -1, anchorLeft: 0 };
    
    // Store listener ID for cleanup
    let windowListenerId = null;

    // Consistent offsets applied to tooltip placement so the cursor never covers
    // the tooltip itself.  Horizontal offset keeps sufficient gap; vertical
    // offset mirrors Thunderbird’s native tooltip behaviour.
    const H_OFFSET = 60; // px to the right of cursor
    const V_OFFSET = 10; // px below cursor
    // ----------------------------------------------------------
    // Diagnostic: dump context properties and messenger presence
    // ----------------------------------------------------------
    try {
      const ctxKeys = Object.keys(context || {}).sort();
      console.log("[TabMail ThreadTT] Diagnostic – context keys:", ctxKeys);
      console.log(
        "[TabMail ThreadTT] Diagnostic – context.extension.id:", context?.extension?.id,
        "context.messenger?", !!context?.messenger,
        "runtime?", !!context?.messenger?.runtime
      );
    } catch (e) {
      console.error("[TabMail ThreadTT] Failed to enumerate context keys:", e);
    }
    //------------------------------------------------------------
    // Helpers
    //------------------------------------------------------------
    // Thunderbird 115+ renamed the outer container from #threadPane to
    // #threadPaneBox.  This helper returns whichever one exists so the
    // rest of the logic can stay version-agnostic.
    function getThreadPane(win) {
      const pane =
        win.document.getElementById("threadPane") ||
        win.document.getElementById("threadPaneBox");
      return pane;
    }

    function ensureStyle(win) {
      if (win.document.getElementById("tm-thread-tooltip-style")) return;
      console.log("[TabMail ThreadTT] ensureStyle: injecting CSS into", win.location.href);
      const link = win.document.createElement("link");
      link.id = "tm-thread-tooltip-style";
      link.rel = "stylesheet";
      link.type = "text/css";
      try {
        link.href = context.extension.baseURI.resolve(
          "agent/experiments/threadTooltip/threadTooltip.css"
        );
      } catch (e) {
        console.error("[TabMail ThreadTT] Failed to resolve CSS URL:", e);
        return;
      }
      win.document.documentElement.appendChild(link);

      // Also add an inline stylesheet once per window that hides XUL <tooltip>
      // popups entirely. Our custom tooltip is a regular <div>, so this does
      // not affect it but removes Gecko titletips globally for the window.
      if (!win.document.getElementById("tm-hide-native-tooltips")) {
        const s = win.document.createElement("style");
        s.id = "tm-hide-native-tooltips";
        s.textContent = `tooltip { display: none !important; }`;
        win.document.documentElement.appendChild(s);
        console.log("[Tabmail ThreadTT] Injected CSS to hide native XUL tooltips");
      }
    }

    function makeTooltip(win) {
      let tt = win.document.getElementById("tm-thread-tooltip");
      if (tt) return tt;
      // Create an HTML div element that floats on top.
      if (win.document.createElementNS) {
        tt = win.document.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "div"
        );
      } else {
        tt = win.document.createElement("div");
      }
      tt.id = "tm-thread-tooltip";
      tt.className = "email-item-tooltip";
      tt.style.display = "none";
      win.document.documentElement.appendChild(tt);
      console.log("[TabMail ThreadTT] makeTooltip: tooltip element created in", win.location.href);
      return tt;
    }

    function isInboxFolder(folder) {
      try {
        const Ci = Components.interfaces;
        if (folder?.isSpecialFolder && folder.isSpecialFolder(Ci.nsMsgFolderFlags.Inbox, true)) {
          return true;
        }
        const name = folder?.prettyName?.toLowerCase();
        return name === "inbox" || name === "all inboxes";
      } catch (_) {
        return false;
      }
    }

    // ----------------------------------------------------------
    // Utility: escape special XML/HTML characters so we can safely
    // inject user-supplied text into innerHTML without breaking
    // Thunderbird's strict XHTML parser.
    // ----------------------------------------------------------
    function escapeHTML(str) {
      if (str == null) return '';
      return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    // ----------------------------------------------------------
    // Per-document shared state bag to avoid stale closures
    // ----------------------------------------------------------
    function ensureShared(win) {
      const doc = win.document;
      if (!doc.__tmTT) {
        doc.__tmTT = {
          hoverState: { msgId: null, win, x: 0, y: 0, tooltipEl: null, row: -1, anchorLeft: 0 },
          handlers: { blockerDoc: null, blockerWin: null },
        };
      }
      return doc.__tmTT;
    }

    //------------------------------------------------------------
    // Main hook installer
    //------------------------------------------------------------
    /**
     * Attempt to locate the <tree-view id="threadTree"> element for the
     * currently-selected 3-pane tab.  In Thunderbird 115+ (and later) the
     * actual message list lives inside the *tabmail* browser’s content
     * document, so we look there first and fall back to the outer
     * messenger.xhtml DOM for older versions.
     */
    function findThreadContainer(win) {
      console.log("[TabMail ThreadTT] findThreadContainer invoked in", win.location.href);
      // ----------------------------------------------------------
      // Diagnostic: log tabmail structure and current tab details
      // ----------------------------------------------------------
      let tabmail = null;
      try {
        tabmail = win.document.getElementById("tabmail");
      } catch (e) {
        console.warn("[TabMail ThreadTT] findThreadContainer: error accessing tabmail", e);
      }

      if (tabmail && !tabmail.__tm_logged) {
        tabmail.__tm_logged = true; // avoid spamming
        const info = tabmail.currentTabInfo;
        console.log("[TabMail ThreadTT] tabmail diagnostic → modes count", tabmail.tabInfo?.length, "currentTabInfo.mode", info?.mode?.name, "about3Pane?", !!tabmail.currentAbout3Pane);
        console.log("[TabMail ThreadTT] tabmail browsers → chromeBrowser", !!info?.chromeBrowser, "browser", !!info?.browser);
      }
      function searchDoc(doc, label) {
        console.log("[TabMail ThreadTT] searchDoc invoked for", label, "doc?", !!doc);
        if (!doc) return null;

        // 1. Direct lookup in the provided document.
        const direct = doc.getElementById("threadTree");
        if (direct) {
          console.log("[TabMail ThreadTT] searchDoc: found direct #threadTree in", label);
          return direct;
        }

        // 2. Inside <mail-message-list>
        const mmList = doc.querySelector("mail-message-list");
        if (mmList) {
          console.log("[TabMail ThreadTT] searchDoc: mail-message-list present (shadowRoot?", !!mmList.shadowRoot, ") in", label);
        }
        if (mmList && mmList.shadowRoot) {
          const within = mmList.shadowRoot.getElementById("threadTree") || mmList.shadowRoot.querySelector("#threadTree, tree-view");
          if (within) return within;
        }

        // 3. Generic tree-view element in the light DOM
        const anyTree = doc.querySelector("tree-view#threadTree, tree-view");
        if (anyTree) {
          console.log("[TabMail ThreadTT] searchDoc: found generic tree-view in", label);
          return anyTree;
        }

        // 4. Deep fallback – iterate through elements that host shadowRoots.
        for (const node of doc.querySelectorAll("*")) {
          if (node.shadowRoot) {
            const found = node.shadowRoot.getElementById("threadTree") || node.shadowRoot.querySelector("#threadTree, tree-view");
            if (found) {
              console.log("[TabMail ThreadTT] searchDoc: found tree inside shadowRoot of", node, "in", label);
              return found;
            }
          }
        }

        return null;
      }

      // Prefer the active tab’s content document (TB 115+ & later)
      let contentDoc = null;
      try {
        const tabmail = win.document.getElementById("tabmail");
        // Preferred – TB 115+: window object of about:3pane.
        contentDoc = tabmail?.currentAbout3Pane?.document ||
                     tabmail?.currentTabInfo?.chromeBrowser?.contentDocument ||
                     tabmail?.currentTabInfo?.browser?.contentDocument || null;
      } catch (_) {
        // ignored – keep contentDoc as null
      }

      if (!contentDoc) {
        console.log("[TabMail ThreadTT] findThreadContainer: no contentDoc available yet (tabmail.currentAbout3Pane / chromeBrowser) in", win.location.href);
      }

      const fromContent = searchDoc(contentDoc, contentDoc?.location?.href || "contentDoc");
      if (fromContent) {
        console.log("[TabMail ThreadTT] findThreadContainer: located tree in contentDoc →", fromContent.tagName, "id=", fromContent.id);
      }

      // Fallback: search the outer messenger.xhtml document
      return searchDoc(win.document, win.location.href);
    }

    // Observe #threadPane and its descendants until the tree-view appears.
    function watchForTree(win) {
      console.log("[TabMail ThreadTT] watchForTree invoked for", win.location.href);
      const pane = getThreadPane(win);
      if (!pane) {
        console.log("[TabMail ThreadTT] threadPane/Box absent – observing body. Wrapper present?",
          !!win.document.getElementById("threadPaneWrapper"),
          "in",
          win.location.href);
        const bodyMO = new win.MutationObserver((muts, obs) => {
          for (const mut of muts) {
            for (const node of mut.addedNodes) {
              const tag = node.tagName || "#text";
              if (tag === "MAIL-MESSAGE-LIST" || tag === "TREE-VIEW" || node.id === "threadPaneWrapper") {
                console.log("[TabMail ThreadTT] body observer saw", tag, "id=", node.id, "shadowRoot?", !!node.shadowRoot, "in", win.location.href);
              }
            }
          }

          const tp = getThreadPane(win);
          if (tp) {
            console.log("[TabMail ThreadTT] thread pane wrapper appeared via observer in", win.location.href);
            obs.disconnect();
            // Re-run watchForTree which will now find pane.
            watchForTree(win);
          }
        });
        bodyMO.observe(win.document.body || win.document.documentElement, {
          childList: true,
          subtree: true,
        });
        return;
      }

      // If tree already present, attach immediately.
      const immediate = findThreadContainer(win);
      if (immediate) {
        console.log("[TabMail ThreadTT] tree-view present immediately – attaching");
        addHoverHooksForTree(win, immediate);
        return;
      }

      console.log("[TabMail ThreadTT] Setting up MutationObserver for tree-view insertion");

      let mootCount = 0; // track how many times we logged non-tree mutations (to avoid spam)
      const mo = new win.MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            // Check the added node and its shadow root for the tree
            const el =
              (n.id === "threadTree" || n.id === "threadPaneBox") ? n :
              (n.shadowRoot && n.shadowRoot.getElementById && n.shadowRoot.getElementById("threadTree"));

            if (el) {
              console.log("[TabMail ThreadTT] tree-view appeared via MutationObserver", el);
              mo.disconnect();
              addHoverHooksForTree(win, el);
              return;
            }

            // Diagnostic: log other potentially relevant nodes but cap to avoid flooding.
            if (mootCount < 25) {
              const tag = n.tagName || "#text";
              if (tag === "MAIL-MESSAGE-LIST" || tag === "TREE-VIEW" || n.id === "threadPaneWrapper") {
                console.log("[TabMail ThreadTT] observer saw node", tag, "id=", n.id, "shadowRoot?", !!n.shadowRoot);
                mootCount++;
              }
            }
          }
        }
      });

      mo.observe(pane, { childList: true, subtree: true });
    }

    // ----------------------------------------------------------
    // Proactively clean window before (re)attaching
    // ----------------------------------------------------------
    function detachPrevious(win) {
      const topDoc = win.document; // chrome://messenger/content/messenger.xhtml
      const shared = topDoc.__tmTT;
      if (!shared) return;

      // Remove document + window blockers if present
      for (const [target, key] of [[topDoc, 'blockerTopDoc'], [win, 'blockerTopWin']]) {
        const fn = shared.handlers?.[key];
        if (fn) {
          for (const ev of ["popupshowing", "popupshown", "panelshowing", "panelshown"]) {
            target.removeEventListener(ev, fn, true);
          }
          shared.handlers[key] = null;
        }
      }
      
      // Also try to clean tree document handlers if tree exists
      const tree = findThreadContainer(win);
      if (tree) {
        const treeDoc = tree.ownerDocument; // about:3pane
        for (const [target, key] of [[treeDoc, 'blockerTreeDoc'], [(treeDoc.defaultView || win), 'blockerTreeWin']]) {
          const fn = shared.handlers?.[key];
          if (fn) {
            for (const ev of ["popupshowing", "popupshown", "panelshowing", "panelshown"]) {
              target.removeEventListener(ev, fn, true);
            }
            shared.handlers[key] = null;
          }
        }
        
        // Remove tooltip node and CSS from tree document
        treeDoc.getElementById("tm-thread-tooltip")?.remove();
        treeDoc.getElementById("tm-thread-tooltip-style")?.remove();
        treeDoc.getElementById("tm-hide-native-tooltips")?.remove();
        
        cleanupTreeHandlers(tree);
      }

      // Remove tooltip node and CSS from top document too
      topDoc.getElementById("tm-thread-tooltip")?.remove();
      topDoc.getElementById("tm-thread-tooltip-style")?.remove();
      topDoc.getElementById("tm-hide-native-tooltips")?.remove();

      // Drop the shared bag (forces a new one with fresh hoverState object)
      delete topDoc.__tmTT;
    }

    function addHoverHooks(win) {
      detachPrevious(win);   // Clean slate before reattaching
      const tree = findThreadContainer(win);
      console.log("[TabMail ThreadTT] addHoverHooks initial tree?", !!tree, "in", win.location.href);
      if (tree) {
        // ----------------------------------------------------------------
        // Disable Gecko’s built-in “title-tip” tooltips which appear over
        // cropped cells in <tree>/<mail-message-list>.  Adding the legacy
        // ‘disabletitletips="true"’ attribute prevents nsXULTooltipListener
        // from ever creating those native popups, so they can’t interfere
        // with our custom AI tooltip.  This attribute is still honoured by
        // Supernova’s modern HTML implementation.
        // ----------------------------------------------------------------
        try {
          if (!tree.hasAttribute("disabletitletips")) {
            tree.setAttribute("disabletitletips", "true");
            console.log("[Tabmail ThreadTT] disabletitletips set on tree – native titletip suppressed");
          }
        } catch (dtErr) {
          console.warn("[Tabmail ThreadTT] Failed to set disabletitletips:", dtErr);
        }

        addHoverHooksForTree(win, tree);
      } else {
        watchForTree(win);
      }
      // Extended polling: check for tree presence periodically in case watchForTree misses it
      let pollCount = 0;
      const pollMax = 10; // seconds
      const pollInterval = win.setInterval(() => {
        pollCount++;
        const tabmailNow = win.document.getElementById("tabmail");
        const cdocNow = tabmailNow?.currentAbout3Pane?.document ||
                       tabmailNow?.currentTabInfo?.chromeBrowser?.contentDocument ||
                       tabmailNow?.currentTabInfo?.browser?.contentDocument;
        const mmListNow = cdocNow?.querySelector("mail-message-list") || win.document.querySelector("mail-message-list");
        const treeDirectNow = (cdocNow?.getElementById && cdocNow.getElementById("threadTree")) || win.document.getElementById("threadTree");
        const treeShadowNow = mmListNow?.shadowRoot?.getElementById("threadTree");

        const candidate = treeShadowNow || treeDirectNow || findThreadContainer(win);

        if (candidate) {
          addHoverHooksForTree(win, candidate);
          win.clearInterval(pollInterval);
        } else if (pollCount >= pollMax) {
          win.clearInterval(pollInterval);
        }
      }, 1000);
    }

    // Extracted body that installs listeners once we have tree element
    function addHoverHooksForTree(win, tree) {
      if (!tree) return;

      const shared = ensureShared(win);
      hoverState = shared.hoverState; // ensure both refs point to the same object

      // ----------------------------------------------------------------
      // Ensure Gecko’s built-in titletip tooltips are disabled for this tree.
      // This runs every time we (re)attach so the attribute is always set
      // even when the tree becomes available later via MutationObserver.
      // ----------------------------------------------------------------
      try {
        // Gecko checks the body element (#threadTree / treechildren) not just the host.
        const body = tree.shadowRoot?.getElementById("threadTree") ||
                     tree.querySelector("treechildren#threadTree") || tree;
        if (!body.hasAttribute("disabletitletips")) {
          body.setAttribute("disabletitletips", "true");
          console.log("[Tabmail ThreadTT] disabletitletips set on", body.tagName, "–", win.location.href);
        }
      } catch (dtErr) {
        console.warn("[Tabmail ThreadTT] Failed to set disabletitletips:", dtErr);
      }
      if (tree.dataset.tooltipHooked === context.extension.id) {
        console.log("[TabMail ThreadTT] addHoverHooksForTree: listeners were present from previous reload – reattaching");
      } else if (tree.dataset.tooltipHooked && tree.dataset.tooltipHooked !== context.extension.id) {
        console.log("[TabMail ThreadTT] addHoverHooksForTree: overriding previous extension instance", tree.dataset.tooltipHooked, "→", context.extension.id);
      }
      // Proceed to (re)attach listeners.
      tree.dataset.tooltipHooked = context.extension.id;

      if (tree.__tmHoverHandlersAttached) {
        console.log("[TabMail ThreadTT] addHoverHooksForTree: listeners already attached – proceeding to reattach for fresh state in", win.location.href);
      }
      console.log("[TabMail ThreadTT] addHoverHooksForTree: installing listeners in", win.location.href);

      // If handlers were previously attached on this tree, remove them to avoid duplicates on reloads.
      if (tree.__tmHoverHandlersAttached) {
        try {
          if (tree.__tmMouseMoveHandler) {
            tree.removeEventListener("mousemove", tree.__tmMouseMoveHandler);
          }
          if (tree.__tmMouseLeaveHandler) {
            tree.removeEventListener("mouseleave", tree.__tmMouseLeaveHandler);
          }
          if (tree.__tmStripTitleHandler) {
            tree.removeEventListener("mouseover", tree.__tmStripTitleHandler, true);
          }
          if (tree.__tmRestoreTitleHandler) {
            tree.removeEventListener("mouseout", tree.__tmRestoreTitleHandler, true);
          }
          console.log("[TabMail ThreadTT] Removed previous hover handlers before reattaching in", win.location.href);
        } catch (detachErr) {
          console.warn("[TabMail ThreadTT] Error removing previous handlers:", detachErr);
        }
      }

      // // Inform readiness (only if messenger runtime is available in this context)
      // if (context?.messenger?.runtime?.sendMessage) {
      //   try {
      //     context.messenger.runtime.sendMessage({ command: "threadTT-ready", location: win.location.href });
      //   } catch (e) {
      //     console.error("[TabMail ThreadTT] Failed to send ready message:", e);
      //   }
      // } else {
      //   console.log("[TabMail ThreadTT] messenger.runtime unavailable in parent context – ready message skipped");
      // }

      ensureStyle(win);
      const tooltip = makeTooltip(win);

      // Point the tree’s tooltip attribute to our custom tooltip to override
      // the default Gecko titletip for this element. This is simpler and more
      // robust than catching popup events.
      try {
        tree.setAttribute("tooltip", tooltip.id);
        console.log("[Tabmail ThreadTT] tree.tooltip attribute set to", tooltip.id);
      } catch (attrErr) {
        console.warn("[Tabmail ThreadTT] Failed to set tooltip attribute on tree", attrErr);
      }

      // ----------------------------------------------------------
      // Shared hover state across helper functions – must live at getAPI
      // scope so both addHoverHooksForTree() and display() can access it.
      // ----------------------------------------------------------
      // Global hover state shared between addHoverHooksForTree and display()
      let lastRow = -1;
      let fetchTimer;

      // Helper: robustly retrieve nsIMsgDBHdr for a row across TB versions.
      function getHeaderForRow(row) {
        // 1) Legacy global gDBView
        try {
          const treeWin = tree.ownerDocument.defaultView;
          const hdrFn = treeWin?.gDBView?.hdrForRow;
          if (typeof hdrFn === "function") {
            const hdr = hdrFn.call(treeWin.gDBView, row);
            if (hdr) return hdr;
          }
        } catch (e) {
          console.warn("[ThreadTT] gDBView.hdrForRow threw", e);
        }

        // 2) tree.view.dbView
        try {
          const hdrFn2 = tree.view?.dbView?.hdrForRow;
          if (typeof hdrFn2 === "function") {
            const hdr = hdrFn2.call(tree.view.dbView, row);
            if (hdr) return hdr;
          }
        } catch (e) {
          console.warn("[ThreadTT] tree.view.dbView.hdrForRow threw", e);
        }

        // 3) <tr>.message
        const trEl = tree.querySelector(`#threadTree-row${row}`);
        if (trEl?.message) return trEl.message;

        // 4) tree.view.getMessageHdrAt
        if (typeof tree.view?.getMessageHdrAt === "function") {
          const hdr4 = tree.view.getMessageHdrAt(row);
          if (hdr4) return hdr4;
        }

        // 5) tree.view.getMsgHdrAt (observed in TB 140)
        if (typeof tree.view?.getMsgHdrAt === "function") {
          const hdr5 = tree.view.getMsgHdrAt(row);
          if (hdr5) return hdr5;
        }

        if (!getHeaderForRow._diagDone) {
          getHeaderForRow._diagDone = true;
          console.warn("[ThreadTT] All header lookups failed for row", row);
        }
        return null;
      }

      function hideTooltip() {
        tooltip.style.display = "none";
      }

      const onMouseMove = (evt) => {
        let row = -1;
        if (typeof tree.getRowAtCoordinates === "function") {
          // API exposed on tree-view custom element in TB 115+
          row = tree.getRowAtCoordinates(evt.clientX, evt.clientY);
        } else if (typeof tree.getRowAt === "function") {
          // Legacy XUL tree
          row = tree.getRowAt(evt.clientX, evt.clientY);
        }
        // Fallback for HTML table implementation (Supernova, TB 115+)
        if (row === -1) {
          const tr = evt.target?.closest && evt.target.closest("tr");
          if (tr && tr.parentElement) {
            row = Array.prototype.indexOf.call(tr.parentElement.children, tr);
          }
        }
        // --------------------------------------------------------------------
        // Additional guard: Some Thunderbird versions may return row 0 even
        // when the pointer is **above** the first message row (for example
        // hovering the column-header area).  To avoid showing a tooltip in
        // that situation we verify that the cursor is actually inside the
        // visual bounding rectangle of the resolved row element.  If the
        // Y-coordinate is outside the row’s bounds we treat it as no row.
        // --------------------------------------------------------------------
        if (row >= 0) {
          try {
            let rowEl = tree.ownerDocument.querySelector(`#threadTree-row${row}`);
            if (!rowEl && tree.shadowRoot) {
              rowEl = tree.shadowRoot.querySelector(`#threadTree-row${row}`);
            }
            if (!rowEl) {
              // Fallback for HTML table implementation
              const tr = evt.target?.closest && evt.target.closest('tr');
              if (tr) rowEl = tr;
            }
            if (rowEl) {
              const rect = rowEl.getBoundingClientRect();
              if (evt.clientY < rect.top || evt.clientY > rect.bottom) {
                row = -1; // pointer outside row – suppress tooltip
              }
            }
          } catch (bboxErr) {
            console.warn('[ThreadTT] Bounding-box check failed:', bboxErr);
          }
        }
        if (row !== lastRow) {
          lastRow = row;
          if (fetchTimer) {
            win.clearTimeout(fetchTimer);
          }
          if (row === -1) {
            hideTooltip();
            return;
          }
          fetchTimer = win.setTimeout(async () => {
            try {
              const hdr = getHeaderForRow(row);
              if (!hdr || !isInboxFolder(hdr.folder)) {
                hideTooltip();
                return;
              }
              const msgId = hdr?.messageId || String(hdr?.messageKey);

              // ------------------------------------------------------
              // Diagnostic: attempt transport via observer service so we
              // can verify the background worker receives something even
              // when messenger.runtime is unavailable.
              // ------------------------------------------------------
              // Record state for later display callback, including the row index so we can
              // reposition the tooltip consistently even if the mouse stops moving.
              Object.assign(hoverState, {
                msgId: String(msgId),
                win,
                x: evt.clientX,
                y: evt.clientY,
                tooltipEl: tooltip,
                row,
              });

              try {
                //  // Normalize folder URI to path format to match cache keys
                //  // Convert "imap://user@host/INBOX/Subfolder" to "INBOX/Subfolder"
                //  let folderPath = hdr.folder?.URI || "";
                //  if (folderPath.includes('://')) {
                //    const match = folderPath.match(/^[^:]+:\/\/[^\/]+\/(.*)$/);
                //    if (match && match[1]) {
                //      folderPath = match[1];
                //    } else {
                //      // Fallback: take everything after the last '/'
                //      const uriParts = folderPath.split('/');
                //      folderPath = uriParts[uriParts.length - 1] || "";
                //    }
                //    // Add back the slash at the front
                //    folderPath = "/" + folderPath;
                //  }
                 
                 ServicesTT.obs.notifyObservers(
                   null,
                   "tm-threadTT-hover",
                   JSON.stringify({ headerId: hdr.messageId || "", folderUri: hdr.folder?.URI || ""})
                 );
                 /* Observer notification sent */
               } catch (obsErr) {
                 console.error("ThreadTT: Failed to send observer notification:", obsErr);
               }

              // if (context?.messenger?.runtime?.sendMessage) {
              //   var data = await context.messenger.runtime.sendMessage({
              //     command: "tooltipFetch",
              //     messageId: msgId,
              //   });
              // } else {
              //   console.log("[TabMail ThreadTT] messenger.runtime unavailable at hover – showing immediate placeholder for", msgId);
              //   console.log("[TMDBG ThreadTT] context", context);
              //   console.log("[TMDBG ThreadTT] context.messenger", context?.messenger);
              //   console.log("[TMDBG ThreadTT] context.messenger.runtime", context?.messenger?.runtime);
              //   console.log("[TMDBG ThreadTT] context.messenger.runtime.sendMessage", context?.messenger?.runtime?.sendMessage);
              //   var data = { blurb: "Analyzing...", todos: "" };
              // }
              var data = { blurb: "Analyzing...", todos: "" };

              if (!data || data.error) {
                hideTooltip();
                return;
              }

              // Build HTML content
              let todosHtml = "";
              if (data.todos && data.todos.trim()) {
                const items = data.todos
                  .split("•")
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((it) => it.replace(/^[-•*\\s]+/, ""));
                if (items.length) {
                  todosHtml =
                    '<strong>Todos:</strong><ul class="tooltip-todos">' +
                    items.map((it) => `<li>${escapeHTML(it)}</li>`).join("") +
                    "</ul>";
                }
              }
              const summaryHtml = data.blurb
                ? `<strong>Summary:</strong><div class="tooltip-summary">${escapeHTML(data.blurb)}</div>`
                : "";

              tooltip.innerHTML = (todosHtml + summaryHtml) || "(No details)";
              // ----------------------------------------------------------
              // Positioning – try to anchor to the Date column cell of the
              // hovered row.  If that fails, fall back to mouse-relative.
              // ----------------------------------------------------------
              let left = evt.clientX + H_OFFSET; // fallback value
              try {
                // Locate the DOM element for this row.
                const selector = `#threadTree-row${row}`;
                let rowEl = tree.ownerDocument.querySelector(selector);
                if (!rowEl && tree.shadowRoot) {
                  rowEl = tree.shadowRoot.querySelector(selector);
                }
                // For Supernova table implementation, evt.target.closest('tr') may work
                if (!rowEl) {
                  rowEl = evt.target?.closest && evt.target.closest('tr');
                }

                let dateCell = rowEl?.querySelector('td.datecol-column, [data-column-name="datecol"], [data-col-id="dateCol"], [column-id="dateCol"], [column="dateCol"], td.dateCol');
                if (!dateCell && rowEl) {
                  dateCell = rowEl.lastElementChild; // fallback: right-most cell
                }
                if (dateCell) {
                  const rect = dateCell.getBoundingClientRect();
                  left = rect.left;
                }
              } catch (posErr) {
                console.warn('[ThreadTT] Date-column positioning failed:', posErr);
              }

              // Remember for reuse in display() so we don't jump later.
              hoverState.anchorLeft = left;

              let top  = evt.clientY + V_OFFSET;
              const docRect = win.document.documentElement.getBoundingClientRect();
              const ttRect = tooltip.getBoundingClientRect();
              if (left + ttRect.width > docRect.width - 4) {
                left = docRect.width - ttRect.width - 4;
              }
              if (top + ttRect.height > docRect.height - 4) {
                top = docRect.height - ttRect.height - 4;
              }
              if (left < 4) left = 4;
              if (top < 4) top = 4;

              tooltip.style.left = left + "px";
              tooltip.style.top = top + "px";
              tooltip.style.display = "block";
            } catch (e) {
              console.error("[TabMail ThreadTT] Error while fetching tooltip:", e);
              hideTooltip();
            }
          }, 0); // Show tooltip immediately – no artificial delay.
        }
      };
      tree.addEventListener("mousemove", onMouseMove);

      const onMouseLeave = () => {
        lastRow = -1;
        hoverState.row = -1; // mark cursor as no longer over thread list
        if (fetchTimer) win.clearTimeout(fetchTimer);
        hideTooltip();
      };
      tree.addEventListener("mouseleave", onMouseLeave);

      //------------------------------------------------------------------
      // Attach fresh native tooltip blockers (with proper cleanup)
      //------------------------------------------------------------------
      function attachBlockers(win, tree) {
        const doc = tree.ownerDocument; // about:3pane
        const topDoc = win.document;     // chrome://messenger/content/messenger.xhtml
        const shared = ensureShared(win);

        // 1) If old blockers exist, remove them first (we stored refs)
        for (const [target, key] of [[topDoc, 'blockerTopDoc'], [win, 'blockerTopWin'], [doc, 'blockerTreeDoc'], [(doc.defaultView || win), 'blockerTreeWin']]) {
          const fn = shared.handlers[key];
          if (fn) {
            for (const ev of ["popupshowing","popupshown","panelshowing","panelshown"]) {
              target.removeEventListener(ev, fn, true);
            }
            shared.handlers[key] = null;
          }
        }

        // 2) Make a fresh blocker that reads *current* shared.hoverState
        const blocker = (evt) => {
          try {
            const tip = evt.target;
            if (tip && (tip.localName === "tooltip" || (tip.localName === "html" && tip.id === "messengerWindow"))) {
              // -----------------------------------------------------------------
              // Determine whether this tooltip should be suppressed.
              //   1. Thunderbird's message-preview tooltips have fixed IDs:
              //        • threadpane-sender-tooltip
              //        • threadpane-summary-tooltip
              //      These must always be blocked so they never cover our AI
              //      summary tooltip.
              //   2. Generic Gecko/XUL titletips triggered from within the
              //      thread list are blocked heuristically (withinTree).
              //   3. On TB 140 the preview tooltip fires popup events on the
              //      root <html id="messengerWindow"> with no triggerNode.
              //      We identify and suppress those when the hoverState says
              //      we are currently over a valid row.
              // -----------------------------------------------------------------

              const isSpecial = tip.id === "threadpane-sender-tooltip" ||
                                tip.id === "threadpane-summary-tooltip";

              const isRootWindow = (tip.localName === "html" && tip.id === "messengerWindow");

              let withinTree = false;
              const n = tip.triggerNode;
              if (n) {
                withinTree =
                  (tree && (tree === n || tree.contains?.(n))) ||
                  n.closest?.("#threadTree, mail-message-list, tree-view");
              }

              const hoveringRow = shared.hoverState?.row >= 0;
              const rootDuringHover = isRootWindow && hoveringRow;

              // Heuristic: if hovering a row, treat generic titletips as within tree
              if (!withinTree && hoveringRow) {
                withinTree = true;
              }

              if (isSpecial || withinTree || rootDuringHover) {
                evt.preventDefault();
                evt.stopImmediatePropagation?.();
              }
            }
          } catch (err) {
            console.error("[TabMail ThreadTT] Error in native tooltip blocker:", err);
          }
        };

        // 3) Attach to TOP-LEVEL document and window (where native tooltips actually fire)
        for (const ev of ["popupshowing","popupshown","panelshowing","panelshown"]) {
          topDoc.addEventListener(ev, blocker, true);
        }
        
        win.addEventListener("popupshowing", blocker, true);
        win.addEventListener("popupshown",  blocker, true);
        win.addEventListener("panelshowing", blocker, true);
        win.addEventListener("panelshown",  blocker, true);

        // Also attach to tree document as backup
        for (const ev of ["popupshowing","popupshown","panelshowing","panelshown"]) {
          doc.addEventListener(ev, blocker, true);
        }
        (doc.defaultView || win).addEventListener("popupshowing", blocker, true);
        (doc.defaultView || win).addEventListener("popupshown",  blocker, true);
        (doc.defaultView || win).addEventListener("panelshowing", blocker, true);
        (doc.defaultView || win).addEventListener("panelshown",  blocker, true);

        shared.handlers.blockerTopDoc = blocker;
        shared.handlers.blockerTopWin = blocker; 
        shared.handlers.blockerTreeDoc = blocker;
        shared.handlers.blockerTreeWin = blocker;
      }

      attachBlockers(win, tree);

      // ----------------------------------------------------------------
      // Remove HTML 'title' attributes on-the-fly within the message list
      // to prevent the platform tooltip that Firefox/Thunderbird shows for
      // title attributes.  We clear the title on mouseenter and restore it on
      // mouseleave so no persistent DOM changes are made.
      // ----------------------------------------------------------------
      const stripTitle = (ev) => {
        const el = ev.target;
        if (el && el.getAttribute && el.hasAttribute("title")) {
          el.__tm_savedTitle = el.getAttribute("title");
          el.removeAttribute("title");
        }
      };
      const restoreTitle = (ev) => {
        const el = ev.target;
        if (el && el.__tm_savedTitle !== undefined) {
          el.setAttribute("title", el.__tm_savedTitle);
          delete el.__tm_savedTitle;
        }
      };
      tree.addEventListener("mouseover", stripTitle, true);
      tree.addEventListener("mouseout", restoreTitle, true);
      console.log("[Tabmail ThreadTT] Dynamic title-stripping listeners attached to tree");
      try {
        tree.__tmMouseMoveHandler = onMouseMove;
        tree.__tmMouseLeaveHandler = onMouseLeave;
        tree.__tmStripTitleHandler = stripTitle;
        tree.__tmRestoreTitleHandler = restoreTitle;
        tree.__tmHoverHandlersAttached = true;
      } catch (_) {}
    }

    //------------------------------------------------------------
    // Public API exposed to WebExtension
    //------------------------------------------------------------

    function init() {
      console.log("[TabMail ThreadTT] init() called.");
      if (!ServicesTT || !ServicesTT.wm) {
        console.error("[TabMail ThreadTT] Services.wm not available!");
        return;
      }
      
      // Clean up any previous registrations before initializing
      try {
        const prevListenerId = context.extension.id + "-threadTooltip";
        ExtensionSupportTT.unregisterWindowListener(prevListenerId);
      } catch (e) {
        // Expected to fail if no previous listener was registered
      }

      // Existing windows
      const enumWin = ServicesTT.wm.getEnumerator("mail:3pane");
      while (enumWin.hasMoreElements()) {
        const win = enumWin.getNext();
        if (win.document.readyState === "complete") {
          addHoverHooks(win);
        } else {
          win.addEventListener("load", () => addHoverHooks(win), { once: true });
        }
      }

      // Future windows
      windowListenerId = context.extension.id + "-threadTooltip";
      ExtensionSupportTT.registerWindowListener(windowListenerId, {
        chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
        onLoadWindow: (win) => addHoverHooks(win),
      });
    }

    function shutdown() {
      console.log("[TabMail ThreadTT] shutdown() called - cleaning up resources.");
      
      try {
        // 1. Unregister window listener
        if (windowListenerId) {
          ExtensionSupportTT.unregisterWindowListener(windowListenerId);
          windowListenerId = null;
        }
        
        // 2. Clean up all windows
        if (ServicesTT && ServicesTT.wm) {
          const enumWin = ServicesTT.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            const win = enumWin.getNext();
            cleanupWindow(win);
          }
        }
      } catch (e) {
        console.error("[TabMail ThreadTT] Error during shutdown cleanup:", e);
      }
    }
    
    function cleanupWindow(win) {
      try {
        detachPrevious(win); // removes blockers + tooltip + tree handlers + shared bag
      } catch (e) {
        console.error("[TabMail ThreadTT] Error cleaning up window:", e);
      }
    }
    
    function cleanupTreeHandlers(tree) {
      try {
        if (!tree) return;
        
        // Remove custom attributes
        if (tree.hasAttribute("tooltip")) {
          tree.removeAttribute("tooltip");
        }
        if (tree.hasAttribute("disabletitletips")) {
          tree.removeAttribute("disabletitletips");
        }
        if (tree.dataset.tooltipHooked) {
          delete tree.dataset.tooltipHooked;
        }
        
        // Remove event handlers if they exist
        if (tree.__tmHoverHandlersAttached) {
          try {
            if (tree.__tmMouseMoveHandler) {
              tree.removeEventListener("mousemove", tree.__tmMouseMoveHandler);
              delete tree.__tmMouseMoveHandler;
            }
            if (tree.__tmMouseLeaveHandler) {
              tree.removeEventListener("mouseleave", tree.__tmMouseLeaveHandler);
              delete tree.__tmMouseLeaveHandler;
            }
            if (tree.__tmStripTitleHandler) {
              tree.removeEventListener("mouseover", tree.__tmStripTitleHandler, true);
              delete tree.__tmStripTitleHandler;
            }
            if (tree.__tmRestoreTitleHandler) {
              tree.removeEventListener("mouseout", tree.__tmRestoreTitleHandler, true);
              delete tree.__tmRestoreTitleHandler;
            }
            delete tree.__tmHoverHandlersAttached;
          } catch (detachErr) {
            console.warn("[TabMail ThreadTT] Error removing tree handlers:", detachErr);
          }
        }
        
        // Also check the shadow root body element
        const body = tree.shadowRoot?.getElementById("threadTree") ||
                     tree.querySelector("treechildren#threadTree") || tree;
        if (body && body !== tree && body.hasAttribute("disabletitletips")) {
          body.removeAttribute("disabletitletips");
        }
        
      } catch (e) {
        console.error("[TabMail ThreadTT] Error cleaning up tree handlers:", e);
      }
    }

    // ------------------------------------------------------------
    // Function exposed to WebExtension side: display tooltip content
    // ------------------------------------------------------------
    function display(msgId, blurb, todos) {
      if (String(msgId) !== String(hoverState.msgId)) {
        try {
          console.log("[TabMail ThreadTT] display: ignoring update – msgId mismatch", msgId, "!=", hoverState.msgId);
        } catch (_) {}
        return;
      }
      if (hoverState.row === -1) {
        try {
          console.log("[TabMail ThreadTT] display: ignoring update – hoverState.row is -1 for", msgId);
        } catch (_) {}
        return;
      }

      const tt = hoverState.tooltipEl || makeTooltip(hoverState.win);

      let todosHtml = '';
      if (todos && todos.trim()) {
        const items = todos.split('•').map(s=>s.trim()).filter(Boolean);
        if (items.length) {
          todosHtml = '<strong>Todos:</strong><ul class="tooltip-todos">' + items.map(it=>`<li>${escapeHTML(it)}</li>`).join('') + '</ul>';
        }
      }
      const summaryHtml = blurb ? `<strong>Summary:</strong><div class="tooltip-summary">${escapeHTML(blurb)}</div>` : '';

      const finalHtml = (todosHtml + summaryHtml) || '(No details)';
      tt.innerHTML = finalHtml;
      // try {
      //   console.log("[TabMail ThreadTT] display: updated tooltip for", msgId, "len=", finalHtml.length, "hasBlurb=", !!blurb, "hasTodos=", !!todos);
      // } catch (_) {}

      // Use stored anchorLeft if it was calculated, else fallback to mouse offset.
      let left = hoverState.anchorLeft || (hoverState.x + H_OFFSET);
      let top  = hoverState.y + V_OFFSET;
      const docRect = hoverState.win.document.documentElement.getBoundingClientRect();
      const ttRect = tt.getBoundingClientRect();
      if (left + ttRect.width > docRect.width - 4) left = docRect.width - ttRect.width - 4;
      if (top + ttRect.height > docRect.height - 4) top = docRect.height - ttRect.height - 4;
      if (left < 4) left = 4;
      if (top < 4) top = 4;

      tt.style.left = left + 'px';
      tt.style.top = top + 'px';
      tt.style.display = 'block';
    }

    return {
      threadTooltip: {
        // Relay hover events (msgId as string) to WebExtension context so the
        // MV3 background worker can act upon them.
        onHover: new ExtensionCommonTT.EventManager({
          context,
          name: "threadTooltip.onHover",
          register: (fire) => {
            const obsHandler = (_subject, _topic, data) => {
              let obj = {};
              try { obj = JSON.parse(data); } catch { obj = { headerId: String(data) }; }
              fire.async(obj);
            };
            ServicesTT.obs.addObserver(obsHandler, "tm-threadTT-hover");
            return () => {
              ServicesTT.obs.removeObserver(obsHandler, "tm-threadTT-hover");
            };
          },
        }).api(),
        display,
        init,
        shutdown,
      },
    };
  }
}; 