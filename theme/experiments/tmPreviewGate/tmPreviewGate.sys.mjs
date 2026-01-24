/*
 * TabMail Preview Gate Experiment
 *
 * Purpose: prevent message preview content flash by gating the preview browser
 * element during navigation / before WebExtension scripts reveal content.
 *
 * IMPORTANT: experiment parent scripts share a global. All top-level bindings
 * here must be unique (do not reuse names from tmTheme.sys.mjs).
 */

const { ExtensionSupport: ExtensionSupportTMPreviewGate } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonTMPreviewGate } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { NetUtil: NetUtilTMPreviewGate } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

var ServicesTMPreviewGate = globalThis.Services;

console.log(
  "[TabMail PreviewGate] experiment parent script loaded. Services present?",
  typeof ServicesTMPreviewGate !== "undefined"
);

var tmPreviewGate = class extends ExtensionCommonTMPreviewGate.ExtensionAPI {
  onShutdown(isAppShutdown) {
    console.log(
      "[TabMail PreviewGate] onShutdown() called by Thunderbird, isAppShutdown:",
      isAppShutdown
    );
    try {
      if (this._tmCleanup) {
        this._tmCleanup();
        console.log("[TabMail PreviewGate] ✓ Cleanup completed via onShutdown");
      }
    } catch (e) {
      console.error("[TabMail PreviewGate] onShutdown cleanup failed:", e);
    }
  }

  getAPI(context) {
    const listenerId = context.extension.id + "-tmPreviewGate";
    let windowListenerId = null;
    let isInitialized = false;

    // Experiment-side toggle: preemptively gate the message preview on navigation.
    let previewAutoGateEnabled = false;

    // Module config (avoid scattering magic values)
    const PREVIEW_GATE_CONFIG = {
      mouseButtons: {
        primary: 0,
        auxiliary: 1,
        secondary: 2,
      },
    };
    
    // Serialize AGENT_SHEET operations so multiple init() calls from hot reload
    // don't interleave and leave us in a confused state.
    function withAgentSheetLock(ctx, fn, label) {
      try {
        ctx.__tmPreviewGate = ctx.__tmPreviewGate || {};
        const prev = ctx.__tmPreviewGate._agentSheetLock || Promise.resolve();
        const next = prev
          .catch(() => {})
          .then(() => fn())
          .catch((e) => {
            console.error(`[TabMail PreviewGate] AGENT_SHEET op failed (${label || "unknown"}):`, e);
          });
        ctx.__tmPreviewGate._agentSheetLock = next;
        return next;
      } catch (e) {
        console.error("[TabMail PreviewGate] withAgentSheetLock failed:", e);
        return Promise.resolve();
      }
    }

    // Read text from URL using privileged NetUtil.asyncFetch
    async function readTextPrivileged(url) {
      const uri = ServicesTMPreviewGate.io.newURI(url);
      return await new Promise((resolve, reject) => {
        NetUtilTMPreviewGate.asyncFetch(
          {
            uri,
            loadUsingSystemPrincipal: true,
            contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
          },
          (inputStream, status) => {
            try {
              if (!Components.isSuccessCode(status)) {
                reject(new Error("asyncFetch failed: " + status));
                return;
              }
              const data = NetUtilTMPreviewGate.readInputStreamToString(
                inputStream,
                inputStream.available()
              );
              inputStream.close();
              resolve(data);
            } catch (e) {
              reject(e);
            }
          }
        );
      });
    }

    async function loadPreviewGateCSS(context) {
      const url = context.extension.getURL(
        "theme/experiments/tmPreviewGate/previewGate.css"
      );
      return await readTextPrivileged(url);
    }

    async function registerAgentSheet(context) {
      const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(
        Ci.nsIStyleSheetService
      );
      const io = ServicesTMPreviewGate.io;

      // IMPORTANT: don't unregister-first. Keep current working gate sheet until the
      // replacement is registered successfully (atomic swap).
      const oldUri = context?.__tmPreviewGate?.agentSheetURI || null;

      const css = await loadPreviewGateCSS(context);
      const cacheBuster = Date.now();
      const completeCSS = `/* TabMail PreviewGate - Generated: ${cacheBuster} */\n${css}`;
      const dataURL =
        "data:text/css;charset=utf-8," + encodeURIComponent(completeCSS);
      const uri = io.newURI(dataURL);

      context.__tmPreviewGate = context.__tmPreviewGate || {};
      try {
        sss.loadAndRegisterSheet(uri, sss.AGENT_SHEET);
      } catch (e) {
        console.error("[TabMail PreviewGate] loadAndRegisterSheet failed:", e);
        throw e;
      }
      console.log(
        `[TabMail PreviewGate] ✓ Registered AGENT_SHEET (cache-buster: ${cacheBuster})`
      );
      try {
        const ok = sss.sheetRegistered(uri, sss.AGENT_SHEET);
        console.log(
          `[TabMail PreviewGate] AGENT_SHEET post-check registeredNow=${ok} (cache-buster: ${cacheBuster})`
        );
      } catch (_) {}

      // Swap stored URI only after successful registration, then unregister old.
      context.__tmPreviewGate.agentSheetURI = uri;
      if (oldUri && oldUri !== uri) {
        try {
          if (sss.sheetRegistered(oldUri, sss.AGENT_SHEET)) {
            sss.unregisterSheet(oldUri, sss.AGENT_SHEET);
            console.log("[TabMail PreviewGate] ✓ Unregistered old AGENT_SHEET after successful swap");
          }
        } catch (e) {
          console.log("[TabMail PreviewGate] Could not unregister old AGENT_SHEET after swap:", e);
        }
      }
    }

    async function ensureAgentSheetRegistered(ctx, why) {
      const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(
        Ci.nsIStyleSheetService
      );
      const uri = ctx?.__tmPreviewGate?.agentSheetURI || null;
      let stillRegistered = false;
      try {
        if (uri) stillRegistered = sss.sheetRegistered(uri, sss.AGENT_SHEET);
      } catch (_) {}

      console.log(
        `[TabMail PreviewGate] AGENT_SHEET ensure (why=${String(why || "")}) storedURI=${!!uri} stillRegistered=${stillRegistered}`
      );
      if (uri && stillRegistered) return;
      await registerAgentSheet(ctx);
    }

    function unregisterAgentSheet(context) {
      const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(
        Ci.nsIStyleSheetService
      );
      const uri = context?.__tmPreviewGate?.agentSheetURI;
      if (uri && sss.sheetRegistered(uri, sss.AGENT_SHEET)) {
        sss.unregisterSheet(uri, sss.AGENT_SHEET);
        console.log("[TabMail PreviewGate] ✓ Unregistered AGENT_SHEET");
        delete context.__tmPreviewGate.agentSheetURI;
      }
    }

    function enumerateContentDocs(win) {
      const docs = [];
      try {
        const tabmail = win.document.getElementById("tabmail");
        if (!tabmail) return docs;

        const pushIf = (d) => {
          if (d && d.documentElement && !docs.includes(d)) docs.push(d);
        };

        try {
          const doc = tabmail.currentAbout3Pane?.document;
          if (doc) pushIf(doc);
        } catch (_) {}

        try {
          const infos = Array.isArray(tabmail.tabInfo) ? tabmail.tabInfo : [];
          for (const info of infos) {
            pushIf(info?.chromeBrowser?.contentDocument);
            pushIf(info?.browser?.contentDocument);
            try {
              const messageBrowser =
                info?.chromeBrowser?.contentDocument?.getElementById(
                  "messageBrowser"
                );
              if (messageBrowser?.contentDocument)
                pushIf(messageBrowser.contentDocument);
            } catch (_) {}
          }
        } catch (_) {}

        try {
          const about3paneDoc = tabmail.currentAbout3Pane?.document;
          if (about3paneDoc) {
            const messageBrowser =
              about3paneDoc.getElementById("messageBrowser") ||
              about3paneDoc.getElementById("multiMessageBrowser");
            if (messageBrowser?.contentDocument) pushIf(messageBrowser.contentDocument);
          }
        } catch (_) {}
      } catch (e) {
        console.error("[TabMail PreviewGate] enumerateContentDocs failed:", e);
      }
      return docs;
    }

    function _setDocPreviewGated(doc, gated, why) {
      try {
        const el = doc?.documentElement;
        if (!el || !el.classList) return;
        if (gated) el.classList.add("tm-message-preview-gated");
        else el.classList.remove("tm-message-preview-gated");
        try {
          const href = String(doc.location?.href || "");
          if (href.includes("about:3pane") && gated) {
            console.log(
              `[TabMail PreviewGate] AutoGate applied gated=${gated} why=${why || ""} href="${href}"`
            );
          }
        } catch (_) {}
      } catch (_) {}
    }

    function installPreviewAutoGateWatcherOnDoc(doc) {
      try {
        if (!doc || !doc.defaultView) return;
        const shared =
          doc.__tmPreviewGateAuto || (doc.__tmPreviewGateAuto = {});
        if (shared.installed) return;
        shared.installed = true;

        let docHref = "";
        try {
          docHref = String(doc.location?.href || "");
        } catch (_) {}

        const findPane = () => {
          try {
            // TB 145: message browser element appears as <browser id="messagepane" ...>
            return (
              doc.getElementById("messagepane") ||
              doc.querySelector("browser#messagepane")
            );
          } catch (_) {
            return null;
          }
        };

        const maybeGateNow = (why) => {
          if (!previewAutoGateEnabled) return;
          try {
            _setDocPreviewGated(doc, true, `auto:${why}`);
          } catch (_) {}
        };

        const pane = findPane();
        if (pane) {
          try {
            const mo = new doc.defaultView.MutationObserver((muts) => {
              try {
                if (!previewAutoGateEnabled) return;
                for (const m of muts || []) {
                  if (m.type === "attributes") {
                    try {
                      const an = String(m.attributeName || "");
                      console.log(
                        `[TabMail PreviewGate] AutoGate: messagepane attr changed "${an}"`
                      );
                    } catch (_) {}
                    maybeGateNow(`attr:${m.attributeName || "?"}`);
                    break;
                  }
                }
              } catch (_) {}
            });
            mo.observe(pane, {
              attributes: true,
              attributeFilter: [
                "src",
                "currenturi",
                "currentURI",
                "uri",
                "remote",
                "disablehistory",
              ],
            });
            shared.paneMO = mo;
          } catch (e) {
            console.log(
              `[TabMail PreviewGate] AutoGate: Failed to observe messagepane attributes: ${e}`
            );
          }

          try {
            shared.onLoadStart = () => maybeGateNow("loadstart");
            pane.addEventListener("loadstart", shared.onLoadStart, true);
          } catch (_) {}
          try {
            shared.onBeforeUnload = () => maybeGateNow("beforeunload");
            doc.defaultView.addEventListener(
              "beforeunload",
              shared.onBeforeUnload,
              true
            );
          } catch (_) {}

          console.log(
            `[TabMail PreviewGate] AutoGate watcher installed (doc="${docHref || "?"}")`
          );
        } else {
          console.log(
            `[TabMail PreviewGate] AutoGate: messagepane not found (doc="${docHref || "?"}") (will rely on later ensure pass)`
          );

          // TB 145: messagepane can be inserted lazily (often after the first selection).
          // Watch for it so the FIRST click is gated properly.
          try {
            const finderMO = new doc.defaultView.MutationObserver((muts) => {
              try {
                const p = findPane();
                if (!p) return;
                try {
                  finderMO.disconnect();
                } catch (_) {}
                try {
                  shared.paneFinderMO = null;
                } catch (_) {}
                console.log(
                  `[TabMail PreviewGate] AutoGate: messagepane appeared; attaching watcher now (doc="${docHref || "?"}")`
                );
                // If auto-gate is enabled, gate immediately when the pane appears.
                try {
                  if (previewAutoGateEnabled) {
                    _setDocPreviewGated(doc, true, "auto:messagepane-appeared");
                  }
                } catch (_) {}
                // Re-run installation (will attach attribute observer now that pane exists).
                try {
                  shared.installed = false;
                } catch (_) {}
                installPreviewAutoGateWatcherOnDoc(doc);
              } catch (_) {}
            });
            shared.paneFinderMO = finderMO;
            finderMO.observe(doc.documentElement || doc, { childList: true, subtree: true });
            console.log(
              `[TabMail PreviewGate] AutoGate: watching for messagepane insertion (doc="${docHref || "?"}")`
            );
          } catch (eMO) {
            console.log(`[TabMail PreviewGate] AutoGate: failed to watch for messagepane insertion: ${eMO}`);
          }
        }
      } catch (e) {
        console.log(`[TabMail PreviewGate] AutoGate install failed: ${e}`);
      }
    }

    function ensurePreviewGateWatchers(win) {
      try {
        // IMPORTANT: In TB 145, #messagepane may live either in the about:3pane content doc
        // or in the chrome://messenger document depending on layout/state.
        // Install the watcher on BOTH so the very first selection can be gated.
        try {
          installPreviewAutoGateWatcherOnDoc(win?.document);
        } catch (_) {}

        function setPreviewGatedForWindow(gated, why) {
          try {
            _setDocPreviewGated(win?.document, gated, why);
          } catch (_) {}
          try {
            const docs = enumerateContentDocs(win);
            for (const d of docs) {
              try {
                _setDocPreviewGated(d, gated, why);
              } catch (_) {}
            }
          } catch (_) {}
        }

        // Gate as early as possible: on user selection actions in the thread pane.
        // This prevents the "first click blink" where TB swaps content before our attribute observers run.
        function installPreGateOnDoc(doc) {
          try {
            if (!doc || !doc.defaultView) return;
            const shared = doc.__tmPreviewGateInteraction || (doc.__tmPreviewGateInteraction = {});
            if (shared.installed) return;
            shared.installed = true;

            const getDocHref = () => {
              try { return String(doc.location?.href || ""); } catch (_) { return ""; }
            };

                const tree = doc.getElementById && doc.getElementById("threadTree");
            if (!tree) {
              console.log(
                `[TabMail PreviewGate] PreGate: threadTree not found; cannot attach selection listener (doc="${getDocHref() || "?"}")`
              );
                    return;
                  }

            // IMPORTANT:
            // Pre-gating on generic clicks (mousedown) can leave the preview masked indefinitely if the
            // click doesn't actually change selection / displayed message. Instead, gate on real selection
            // changes from the thread tree.
            shared.onSelect = (ev) => {
              try {
                if (!previewAutoGateEnabled) return;
                setPreviewGatedForWindow(true, `user:threadTree-select doc="${getDocHref()}"`);
              } catch (_) {}
            };

            // Capture phase so we run before default handlers that trigger the message swap.
            tree.addEventListener("select", shared.onSelect, true);

            try {
              console.log(
                `[TabMail PreviewGate] PreGate installed (doc="${getDocHref() || "?"}")`
              );
            } catch (_) {}
          } catch (_) {}
        }

        const contentDocs = enumerateContentDocs(win);
        for (const cdoc of contentDocs) {
          try {
            const href = String(cdoc.location?.href || "");
            if (href.startsWith("about:3pane")) {
              installPreviewAutoGateWatcherOnDoc(cdoc);
              installPreGateOnDoc(cdoc);
            }
          } catch (_) {}
        }
      } catch (e) {
        console.error("[TabMail PreviewGate] ensurePreviewGateWatchers failed:", e);
      }
    }

    async function init(_opts = {}) {
      console.log("[TabMail PreviewGate] ═══ init() called ═══");

      if (!ServicesTMPreviewGate || !ServicesTMPreviewGate.wm) {
        console.error("[TabMail PreviewGate] Services.wm not available!");
        return;
      }

      // Clean up any previous registrations before initializing (hot reload safety).
      try {
        ExtensionSupportTMPreviewGate.unregisterWindowListener(listenerId);
      } catch (_) {}

      if (isInitialized) {
        console.log("[TabMail PreviewGate] Already initialized; ensuring AGENT_SHEET + watchers exist");
        try {
          await withAgentSheetLock(context, () => ensureAgentSheetRegistered(context, "init:alreadyInitialized"), "init:alreadyInitialized");
        } catch (_) {}
        try {
          const enumWin = ServicesTMPreviewGate.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            const win = enumWin.getNext();
            ensurePreviewGateWatchers(win);
          }
        } catch (e) {
          console.error("[TabMail PreviewGate] watcher ensure pass failed:", e);
        }
        return;
      }
      isInitialized = true;

      try {
        await withAgentSheetLock(context, () => ensureAgentSheetRegistered(context, "init:first"), "init:first");
      } catch (e) {
        console.error("[TabMail PreviewGate] Failed to register AGENT_SHEET:", e);
      }

      try {
        const enumWin = ServicesTMPreviewGate.wm.getEnumerator("mail:3pane");
        while (enumWin.hasMoreElements()) {
          const win = enumWin.getNext();
          if (win.document.readyState === "complete") {
            ensurePreviewGateWatchers(win);
          } else {
            win.addEventListener("load", () => ensurePreviewGateWatchers(win), {
              once: true,
            });
          }
        }
      } catch (e) {
        console.error("[TabMail PreviewGate] init existing windows failed:", e);
      }

      try {
        windowListenerId = listenerId;
        ExtensionSupportTMPreviewGate.registerWindowListener(windowListenerId, {
          chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
          onLoadWindow: (win) => ensurePreviewGateWatchers(win),
        });
      } catch (e) {
        console.error("[TabMail PreviewGate] Failed to register window listener:", e);
      }
    }

    async function setMessagePreviewGated(opts = {}) {
      try {
        const gated = !!opts?.gated;
        const reason = String(opts?.reason || "");
        const cycleId = opts?.cycleId;

        if (!ServicesTMPreviewGate || !ServicesTMPreviewGate.wm) {
          console.log(
            "[TabMail PreviewGate] setMessagePreviewGated: Services.wm not available"
          );
          return;
        }

        const enumWin = ServicesTMPreviewGate.wm.getEnumerator("mail:3pane");
        let winCount = 0;
        let docCount = 0;
        while (enumWin.hasMoreElements()) {
          const win = enumWin.getNext();
          try {
            const docEl = win?.document?.documentElement;
            if (!docEl || !docEl.classList) continue;
            if (gated) docEl.classList.add("tm-message-preview-gated");
            else docEl.classList.remove("tm-message-preview-gated");
            winCount++;
          } catch (_) {}

          try {
            const docs = enumerateContentDocs(win);
            for (const d of docs) {
              try {
                const dEl = d?.documentElement;
                if (!dEl || !dEl.classList) continue;
                if (gated) dEl.classList.add("tm-message-preview-gated");
                else dEl.classList.remove("tm-message-preview-gated");
                docCount++;

                try {
                  const href = String(d.location?.href || "");
                  const hasMsgBrowser =
                    !!d.getElementById("messageBrowser") ||
                    !!d.getElementById("multiMessageBrowser") ||
                    !!d.getElementById("messagepane");
                  if (hasMsgBrowser) {
                    console.log(
                      `[TabMail PreviewGate] setMessagePreviewGated: targetDoc has message browser href="${href}" gated=${gated}`
                    );
                  }
                } catch (_) {}
              } catch (_) {}
            }
          } catch (_) {}
        }

        console.log(
          `[TabMail PreviewGate] setMessagePreviewGated gated=${gated} reason="${reason}" cycle=${cycleId} windowsUpdated=${winCount} docsUpdated=${docCount}`
        );
      } catch (e) {
        console.error("[TabMail PreviewGate] setMessagePreviewGated failed:", e);
      }
    }

    async function setPreviewAutoGateEnabled(opts = {}) {
      try {
        const enabled = !!opts?.enabled;
        const reason = String(opts?.reason || "");
        previewAutoGateEnabled = enabled;
        console.log(
          `[TabMail PreviewGate] setPreviewAutoGateEnabled enabled=${enabled} reason="${reason}"`
        );

        if (enabled && ServicesTMPreviewGate && ServicesTMPreviewGate.wm) {
          try {
            const enumWin = ServicesTMPreviewGate.wm.getEnumerator("mail:3pane");
            while (enumWin.hasMoreElements()) {
              const win = enumWin.getNext();
              ensurePreviewGateWatchers(win);
            }
          } catch (e2) {
            console.log(
              `[TabMail PreviewGate] setPreviewAutoGateEnabled install pass failed: ${e2}`
            );
          }
        }
      } catch (e) {
        console.error("[TabMail PreviewGate] setPreviewAutoGateEnabled failed:", e);
      }
    }

    function cleanup() {
      console.log(
        "[TabMail PreviewGate] cleanup() called - cleaning up all resources."
      );

      try {
        unregisterAgentSheet(context);
      } catch (e) {
        console.error("[TabMail PreviewGate] Failed to unregister AGENT_SHEET:", e);
      }

      try {
        if (windowListenerId) {
          try {
            ExtensionSupportTMPreviewGate.unregisterWindowListener(windowListenerId);
            windowListenerId = null;
          } catch (_) {}
        }
      } catch (e) {
        console.error("[TabMail PreviewGate] Error unregistering window listener:", e);
      }

      try {
        if (ServicesTMPreviewGate && ServicesTMPreviewGate.wm) {
          const enumWin = ServicesTMPreviewGate.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            const win = enumWin.getNext();
            // Also clean up watchers on the chrome document itself.
            try {
              const cdoc = win?.document;
              const pg = cdoc?.__tmPreviewGateAuto;
              if (pg?.paneMO) {
                try { pg.paneMO.disconnect(); } catch (_) {}
              }
              if (pg?.paneFinderMO) {
                try { pg.paneFinderMO.disconnect(); } catch (_) {}
              }
              if (pg?.onLoadStart) {
                try {
                  const pane =
                    cdoc.getElementById("messagepane") ||
                    cdoc.querySelector("browser#messagepane");
                  if (pane) pane.removeEventListener("loadstart", pg.onLoadStart, true);
                } catch (_) {}
              }
              if (pg?.onBeforeUnload) {
                try { cdoc.defaultView.removeEventListener("beforeunload", pg.onBeforeUnload, true); } catch (_) {}
              }
              try { delete cdoc.__tmPreviewGateAuto; } catch (_) {}
            } catch (_) {}

            // Cleanup early gating listeners on the chrome document as well.
            try {
              const cdoc = win?.document;
              const ig = cdoc?.__tmPreviewGateInteraction;
              if (ig?.onSelect) {
                try {
                  const tree = cdoc.getElementById && cdoc.getElementById("threadTree");
                  if (tree) tree.removeEventListener("select", ig.onSelect, true);
                } catch (_) {}
              }
              try { delete cdoc.__tmPreviewGateInteraction; } catch (_) {}
            } catch (_) {}

            try {
              win?.document?.documentElement?.classList?.remove(
                "tm-message-preview-gated"
              );
            } catch (_) {}

            try {
              const docs = enumerateContentDocs(win);
              for (const cdoc of docs) {
                try {
                  cdoc?.documentElement?.classList?.remove(
                    "tm-message-preview-gated"
                  );
                } catch (_) {}

                try {
                  const pg = cdoc.__tmPreviewGateAuto;
                  if (pg?.paneMO) {
                    try {
                      pg.paneMO.disconnect();
                    } catch (_) {}
                  }
                  if (pg?.paneFinderMO) {
                    try {
                      pg.paneFinderMO.disconnect();
                    } catch (_) {}
                  }
                  if (pg?.onLoadStart) {
                    try {
                      const pane =
                        cdoc.getElementById("messagepane") ||
                        cdoc.querySelector("browser#messagepane");
                      if (pane)
                        pane.removeEventListener("loadstart", pg.onLoadStart, true);
                    } catch (_) {}
                  }
                  if (pg?.onBeforeUnload) {
                    try {
                      cdoc.defaultView.removeEventListener(
                        "beforeunload",
                        pg.onBeforeUnload,
                        true
                      );
                    } catch (_) {}
                  }
                  try {
                    delete cdoc.__tmPreviewGateAuto;
                  } catch (_) {}
                } catch (_) {}

                // Cleanup early gating listeners (thread pane interaction pre-gate)
                try {
                  const ig = cdoc.__tmPreviewGateInteraction;
                  if (ig?.onSelect) {
                    try {
                      const tree = cdoc.getElementById && cdoc.getElementById("threadTree");
                      if (tree) tree.removeEventListener("select", ig.onSelect, true);
                    } catch (_) {}
                  }
                  try { delete cdoc.__tmPreviewGateInteraction; } catch (_) {}
                } catch (_) {}
              }
            } catch (_) {}
          }
        }
      } catch (e) {
        console.error("[TabMail PreviewGate] Error during cleanup:", e);
      }

      isInitialized = false;
      console.log("[TabMail PreviewGate] cleanup() complete");
    }

    this._tmCleanup = cleanup;

    async function shutdown() {
      console.log("[TabMail PreviewGate] shutdown() called from WebExtension API");
      cleanup();
    }

    return {
      tmPreviewGate: {
        init,
        setMessagePreviewGated,
        setPreviewAutoGateEnabled,
        shutdown,
      },
    };
  }
};


