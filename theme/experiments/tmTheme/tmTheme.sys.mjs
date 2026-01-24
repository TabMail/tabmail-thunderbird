/*
 * TabMail Theme Experiment (Slimmed)
 * 
 * Manages global CSS injection via AGENT_SHEET for email list tinting.
 * 
 * ARCHITECTURE: AGENT_SHEET Re-registration on UI Events
 * --------------------------------------------------------
 * This experiment solves the "stale @media query" problem where display
 * configuration changes don't trigger re-evaluation of CSS @media queries.
 * 
 * PROBLEM:
 * - Monitor connections/disconnections
 * - Display resolution/DPI changes  
 * - OS look-and-feel changes
 * 
 * ...cause @media (prefers-color-scheme) queries in AGENT_SHEET to become
 * stale, breaking light mode tinting (dark mode happened to work because
 * it overrides light mode defaults).
 * 
 * SOLUTION:
 * 1. Listen for OS UI events (look-and-feel-changed, widget:ui-resolution-changed)
 * 2. Re-register AGENT_SHEET when these events fire (forces browser re-evaluation)
 * 3. Also re-register when user switches themes (via Thunderbird settings)
 * 4. Use standard CSS with @media queries (no special theme-specific generation)
 * 
 * NOTE: Tag coloring, card snippets, and row observers have been moved to
 * the separate tmMessageList experiment for maintainability.
 */

const { ExtensionSupport: ExtensionSupportTM } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonTM } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

var ServicesTM = globalThis.Services;

console.log("[TabMail Theme] experiment parent script loaded. Services present?", typeof ServicesTM !== "undefined");

var tmTheme = class extends ExtensionCommonTM.ExtensionAPI {
  onShutdown(isAppShutdown) {
    console.log("[TabMail Theme] onShutdown() called by Thunderbird, isAppShutdown:", isAppShutdown);
    try {
      if (this._tmCleanup) {
        this._tmCleanup();
        console.log("[TabMail Theme] ✓ Cleanup completed via onShutdown");
      }
    } catch (e) {
      console.error("[TabMail Theme] onShutdown cleanup failed:", e);
    }
  }

  getAPI(context) {
    let windowListenerId = null;
    let tmFlags = {};
    let isInitialized = false;

    // ═══════════════════════════════════════════════════════════════════════
    // AGENT_SHEET LOCK (prevents race conditions on re-registration)
    // ═══════════════════════════════════════════════════════════════════════

    function withAgentSheetLock(ctx, fn, label) {
      try {
        ctx.__tmTheme = ctx.__tmTheme || {};
        const prev = ctx.__tmTheme._agentSheetLock || Promise.resolve();
        const next = prev
          .catch(() => {})
          .then(() => fn())
          .catch((e) => {
            console.error(`[TabMail Theme] AGENT_SHEET op failed (${label || "unknown"}):`, e);
          });
        ctx.__tmTheme._agentSheetLock = next;
        return next;
      } catch (e) {
        console.error("[TabMail Theme] withAgentSheetLock failed:", e);
        return Promise.resolve();
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════════════
    // PRIVILEGED FILE READING (for CSS loading in experiment context)
    // ═══════════════════════════════════════════════════════════════════════

    function readTextPrivileged(url) {
      return new Promise((resolve, reject) => {
        NetUtil.asyncFetch(
          {
            uri: url,
            loadingPrincipal: ServicesTM.scriptSecurityManager.getSystemPrincipal(),
            securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
            contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
          },
          (inputStream, status) => {
            try {
              if (!Components.isSuccessCode(status)) {
                reject(new Error("asyncFetch failed: " + status));
                return;
              }
              const data = NetUtil.readInputStreamToString(inputStream, inputStream.available());
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
      const url = ctx.extension.getURL("theme/palette/palette.data.json");
      const text = await readTextPrivileged(url);
      return JSON.parse(text);
    }

    async function loadBuilderModule(ctx) {
      const url = ctx.extension.getURL("theme/palette/palette.build.js");
      let src = await readTextPrivileged(url);
      
      // Strip ES6 export keywords for sandbox eval
      src = src.replace(/export\s+function\s+/g, "function ");
      src = src.replace(/export\s+const\s+/g, "const ");
      src = src.replace(/export\s+let\s+/g, "let ");
      src = src.replace(/export\s+var\s+/g, "var ");
      src = src.replace(/export\s+\{[^}]*\}/g, "");
      src = src.replace(/export\s+default\s+/g, "");
      
      const sb = Cu.Sandbox(ServicesTM.scriptSecurityManager.getSystemPrincipal(), { wantGlobalProperties: [] });
      sb.exports = {};
      Cu.evalInSandbox(src, sb, "latest", url, 1);
      return sb.exports;
    }

    async function buildPaletteCSS(ctx) {
      const [P, mod] = await Promise.all([loadPaletteJSON(ctx), loadBuilderModule(ctx)]);
      return mod.buildPaletteCSS(P);
    }
    
    async function loadStaticThemeCSS(ctx) {
      const url = ctx.extension.getURL("theme/experiments/tmTheme/theme.css");
      return await readTextPrivileged(url);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // AGENT_SHEET REGISTRATION (atomic swap to prevent blank-state race)
    // ═══════════════════════════════════════════════════════════════════════

    async function registerAgentSheet(ctx) {
      const sss = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
      const io = ServicesTM.io;
      
      const oldUri = ctx?.__tmTheme?.agentSheetURI || null;
      
      const [paletteCSS, themeCSS] = await Promise.all([
        buildPaletteCSS(ctx),
        loadStaticThemeCSS(ctx)
      ]);
      
      const cacheBuster = Date.now();
      const completeCSS = `/* TabMail Theme - Generated: ${cacheBuster} */\n${paletteCSS}\n\n${themeCSS}`;
      const dataURL = "data:text/css;charset=utf-8," + encodeURIComponent(completeCSS);
      const uri = io.newURI(dataURL);
      
      ctx.__tmTheme = ctx.__tmTheme || {};
      
      try {
        console.log(`[TabMail Theme] About to loadAndRegisterSheet() AGENT_SHEET (cache-buster: ${cacheBuster}) uri.spec.length=${uri.spec.length}`);
      } catch (_) {}
      
      try {
        sss.loadAndRegisterSheet(uri, sss.AGENT_SHEET);
      } catch (e) {
        console.error("[TabMail Theme] loadAndRegisterSheet failed:", e);
        throw e;
      }
      
      try {
        const ok = sss.sheetRegistered(uri, sss.AGENT_SHEET);
        console.log(`[TabMail Theme] ✓ Registered AGENT_SHEET (cache-buster: ${cacheBuster}) registeredNow=${ok}`);
      } catch (_) {}

      // Atomic swap
      ctx.__tmTheme.agentSheetURI = uri;
      if (oldUri && oldUri !== uri) {
        try {
          if (sss.sheetRegistered(oldUri, sss.AGENT_SHEET)) {
            sss.unregisterSheet(oldUri, sss.AGENT_SHEET);
            console.log("[TabMail Theme] ✓ Unregistered old AGENT_SHEET after successful swap");
          }
        } catch (e) {
          console.log("[TabMail Theme] Could not unregister old AGENT_SHEET after swap:", e);
        }
      }
    }
    
    function unregisterAgentSheet(ctx) {
      const sss = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
      const uri = ctx?.__tmTheme?.agentSheetURI;
      if (!uri) return;
      
      let isReg = false;
      try { isReg = sss.sheetRegistered(uri, sss.AGENT_SHEET); } catch (_) {}
      
      try {
        console.log(`[TabMail Theme] unregisterAgentSheet() AGENT_SHEET registered=${isReg} uri.spec.length=${uri.spec.length}`);
      } catch (_) {}
      
      if (isReg) {
        try {
          sss.unregisterSheet(uri, sss.AGENT_SHEET);
          console.log("[TabMail Theme] ✓ Unregistered AGENT_SHEET");
        } catch (e) {
          console.error("[TabMail Theme] unregisterSheet failed:", e);
        }
      }
      
      try { delete ctx.__tmTheme.agentSheetURI; } catch (_) {}
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // STYLE RECALC (force @media query re-evaluation)
    // ═══════════════════════════════════════════════════════════════════════

    function forceStyleRecalc(win, reason) {
      console.log(`[TabMail Theme] Forcing style recalc (reason: ${reason})...`);
      
      try {
        const isDarkMode = win.matchMedia("(prefers-color-scheme: dark)").matches;
        console.log(`[TabMail Theme] Current color scheme: ${isDarkMode ? "DARK" : "LIGHT"}`);
      } catch (_) {}
      
      const contentDocs = enumerateContentDocs(win);
      for (const cdoc of contentDocs) {
        try {
          const docElem = cdoc.documentElement;
          if (docElem) {
            docElem.classList.add("tm-theme-recalc");
            const computedColor = cdoc.defaultView?.getComputedStyle?.(docElem).getPropertyValue("--tm-message-unread-color");
            docElem.classList.remove("tm-theme-recalc");
            console.log(`[TabMail Theme] ✓ Forced style recalc (${reason}):`, cdoc.documentURI, "| --tm-message-unread-color:", computedColor?.trim() || "(not set)");
          }
                  } catch (e) {
          console.warn("[TabMail Theme] Could not force style recalc:", e);
        }
      }
        }
        
    // ═══════════════════════════════════════════════════════════════════════
    // THEME CHANGE LISTENER
    // ═══════════════════════════════════════════════════════════════════════

    async function handleThemeChange(win, ctx) {
      console.log("[TabMail Theme] ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓");
      console.log("[TabMail Theme] Theme change detected - RE-REGISTERING AGENT_SHEET");
      console.log("[TabMail Theme] ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓");
      
      try {
        await withAgentSheetLock(ctx, () => registerAgentSheet(ctx), "handleThemeChange");
        forceStyleRecalc(win, "theme change");
        console.log("[TabMail Theme] ✓ Theme change complete");
      } catch (e) {
        console.error("[TabMail Theme] handleThemeChange error:", e);
      }
    }
    
    function createThemeChangeHandler(win, ctx) {
      return (e) => {
        console.log("[TabMail Theme] ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓");
        console.log("[TabMail Theme] Theme switched to:", e.matches ? "dark" : "light");
        console.log("[TabMail Theme] ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓");
        handleThemeChange(win, ctx);
      };
    }
    
    function setupWindowEventListeners(win, ctx) {
      const shared = win.document.__tmTheme || (win.document.__tmTheme = {});
      
      if (!shared.themeChangeListener) {
        try {
          const mq = win.matchMedia("(prefers-color-scheme: dark)");
          const handler = createThemeChangeHandler(win, ctx);
          if (mq.addEventListener) {
            mq.addEventListener("change", handler);
          } else {
            mq.addListener(handler);
          }
          shared.themeChangeListener = handler;
          console.log("[TabMail Theme] ✓ Theme change listener registered");
        } catch (e) {
          console.error("[TabMail Theme] Failed to add theme change listener:", e);
        }
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // UI EVENT OBSERVERS (look-and-feel, DPI changes)
    // ═══════════════════════════════════════════════════════════════════════

    function registerUIEventObservers(ctx) {
      if (ctx.__tmTheme?.uiObserver) return;
      
      const topics = ["look-and-feel-changed", "widget:ui-resolution-changed"];
      const observer = {
        observe(subject, topic) {
          console.log(`[TabMail Theme] UI event: ${topic} - re-registering AGENT_SHEET...`);
          (async () => {
            try {
              const win = ServicesTM.wm.getMostRecentWindow("mail:3pane");
              await withAgentSheetLock(ctx, () => registerAgentSheet(ctx), `uiEvent:${topic}`);
              if (win) forceStyleRecalc(win, topic);
              console.log(`[TabMail Theme] ✓ AGENT_SHEET re-registered after ${topic}`);
          } catch (e) {
              console.error(`[TabMail Theme] Failed to re-register AGENT_SHEET after ${topic}:`, e);
      }
          })();
        }
      };
      
      for (const t of topics) {
        ServicesTM.obs.addObserver(observer, t);
      }
      
      ctx.__tmTheme = ctx.__tmTheme || {};
      ctx.__tmTheme.uiObserver = { observer, topics };
      console.log("[TabMail Theme] ✓ UI event observers registered:", topics.join(", "));
    }

    function unregisterUIEventObservers(ctx) {
      const reg = ctx?.__tmTheme?.uiObserver;
      if (!reg) return;
      
      for (const t of reg.topics) {
        try { ServicesTM.obs.removeObserver(reg.observer, t); } catch (_) {}
      }
      
      delete ctx.__tmTheme.uiObserver;
      console.log("[TabMail Theme] ✓ UI event observers unregistered");
                }

    // ═══════════════════════════════════════════════════════════════════════
    // WINDOW SETUP
    // ═══════════════════════════════════════════════════════════════════════

    function ensureThemeStyle(win) {
      try {
          setupWindowEventListeners(win, context);
      } catch (e) {
        console.error("[TabMail Theme] ensureThemeStyle error:", e);
      }
    }

    function removeThemeStyle(win) {
      try {
        const shared = win.document.__tmTheme;
        if (shared?.themeChangeListener && win.matchMedia) {
          try {
            const mq = win.matchMedia("(prefers-color-scheme: dark)");
            if (mq.removeEventListener) {
              mq.removeEventListener("change", shared.themeChangeListener);
            } else {
              mq.removeListener(shared.themeChangeListener);
            }
            delete win.document.__tmTheme.themeChangeListener;
            console.log("[TabMail Theme] ✓ Theme change listener removed");
          } catch (e) {
            console.error("[TabMail Theme] Failed to remove theme change listener:", e);
          }
        }
      } catch (e) {
        console.error("[TabMail Theme] removeThemeStyle error:", e);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INIT / SHUTDOWN
    // ═══════════════════════════════════════════════════════════════════════

    async function init(_opts = {}) {
      console.log("[TabMail Theme] ═══ init() called ═══");
      console.log("[TabMail Theme] windowListenerId:", windowListenerId);
      console.log("[TabMail Theme] isInitialized:", isInitialized);
      
      if (!ServicesTM || !ServicesTM.wm) {
        console.error("[TabMail Theme] Services.wm not available!");
        return;
      }
      
      // Check if AGENT_SHEET is still registered
      let agentSheetStillRegistered = false;
      try {
        const uri = context?.__tmTheme?.agentSheetURI;
        if (uri) {
          const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
          agentSheetStillRegistered = sss.sheetRegistered(uri, sss.AGENT_SHEET);
          console.log("[TabMail Theme] AGENT_SHEET registration check: URI exists?", !!uri, "still registered?", agentSheetStillRegistered);
        } else {
          console.log("[TabMail Theme] AGENT_SHEET registration check: no URI stored");
        }
      } catch (e) {
        console.log("[TabMail Theme] AGENT_SHEET registration check failed:", e);
      }
      
      // Guard against multiple initializations
      if (isInitialized && agentSheetStillRegistered) {
        console.log("[TabMail Theme] Already initialized and AGENT_SHEET still registered");
        console.log("[TabMail Theme] Checking if window event listeners need setup...");
        try {
          const enumWin = ServicesTM.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            setupWindowEventListeners(enumWin.getNext(), context);
          }
        } catch (e) {
          console.error("[TabMail Theme] Error setting up window listeners:", e);
        }
        console.log("[TabMail Theme] Listener check complete, skipping full initialization");
        return;
      }
      
      if (isInitialized && !agentSheetStillRegistered) {
        console.log("[TabMail Theme] ⚠️ Already initialized but AGENT_SHEET is NOT registered - re-registering");
        try {
          await registerAgentSheet(context);
          console.log("[TabMail Theme] ✓ AGENT_SHEET re-registered after suspend/resume");
          const enumWin = ServicesTM.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            forceStyleRecalc(enumWin.getNext(), "suspend/resume");
          }
        } catch (e) {
          console.error("[TabMail Theme] Failed to re-register AGENT_SHEET:", e);
        }
        return;
      }

      try {
        tmFlags = (_opts && _opts.flags) || {};
        console.log("[TabMail Theme] Flags set from init()", tmFlags);
      } catch (_) {
        tmFlags = {};
      }
      
      isInitialized = true;
      
      // Register AGENT_SHEET
      try {
        await registerAgentSheet(context);
        console.log("[TabMail Theme] ✓ AGENT_SHEET registered");
        const enumWin = ServicesTM.wm.getEnumerator("mail:3pane");
        while (enumWin.hasMoreElements()) {
          forceStyleRecalc(enumWin.getNext(), "initial registration");
        }
      } catch (e) {
        console.error("[TabMail Theme] Failed to register AGENT_SHEET:", e);
      }

      console.log("[TabMail Theme] First time initialization - setting up theme...");

      registerUIEventObservers(context);

      // Clean up previous window listener
      try {
        const prevId = context.extension.id + "-tmTheme";
        ExtensionSupportTM.unregisterWindowListener(prevId);
      } catch (_) {}

      // Existing windows
      const enumWin = ServicesTM.wm.getEnumerator("mail:3pane");
      while (enumWin.hasMoreElements()) {
        const win = enumWin.getNext();
        if (win.document.readyState === "complete") {
          ensureThemeStyle(win);
        } else {
          win.addEventListener("load", () => ensureThemeStyle(win), { once: true });
        }
      }

      // Future windows
      windowListenerId = context.extension.id + "-tmTheme";
      ExtensionSupportTM.registerWindowListener(windowListenerId, {
        chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
        onLoadWindow: (win) => ensureThemeStyle(win),
      });
    }

    function cleanup() {
      console.log("[TabMail Theme] cleanup() called - cleaning up all resources.");
      
      try { unregisterAgentSheet(context); } catch (e) {
        console.error("[TabMail Theme] Failed to unregister AGENT_SHEET:", e);
      }

      try { unregisterUIEventObservers(context); } catch (e) {
        console.error("[TabMail Theme] Failed to unregister UI event observers:", e);
      }
      
      try {
        if (windowListenerId) {
            ExtensionSupportTM.unregisterWindowListener(windowListenerId);
            windowListenerId = null;
          }
        if (ServicesTM?.wm) {
          const enumWin = ServicesTM.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            removeThemeStyle(enumWin.getNext());
          }
        }
      } catch (e) {
        console.error("[TabMail Theme] Error during cleanup:", e);
      }
      
      isInitialized = false;
      console.log("[TabMail Theme] cleanup() complete");
    }

    this._tmCleanup = cleanup;

    async function shutdown() {
      console.log("[TabMail Theme] shutdown() called from WebExtension API");
      cleanup();
    }

    function setFlag(flagName, value) {
      console.log(`[TabMail Theme] setFlag: ${flagName} = ${value}`);
      tmFlags[flagName] = value;
    }

    function recolorNow(reason = "recolorNow") {
      // Deprecated: tag coloring moved to tmMessageList
      console.log(`[TabMail Theme] recolorNow() called (deprecated - use tmMessageList.recolorNow)`);
    }

    return {
      tmTheme: {
        init,
        shutdown,
        setFlag,
        recolorNow,
      },
    };
  }
};
