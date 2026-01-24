const { ExtensionSupport: ExtensionSupportKA } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonKA } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

console.log("[TMDBG KeepAlive Experiment] Parent script loaded");

var tmKeepAlive = class extends ExtensionCommonKA.ExtensionAPI {
  onShutdown(isAppShutdown) {
    // This is called by Thunderbird on disable/update/uninstall/app shutdown
    console.log("[TMDBG KeepAlive Experiment] onShutdown() called by Thunderbird, isAppShutdown:", isAppShutdown);
    try {
      if (this._cleanup) {
        this._cleanup();
        console.log("[TMDBG KeepAlive Experiment] ✓ Cleanup completed via onShutdown");
      }
    } catch (e) {
      console.error("[TMDBG KeepAlive Experiment] onShutdown cleanup failed:", e);
    }
  }

  getAPI(context) {
    const listenerId = context.extension.id + "-tmKeepAlive-windows";
    let isInitialized = false; // Prevent multiple initializations
    
    function injectRelayIntoWindow(win) {
      // Only inject if not already injected (prevents hot reload leak)
      if (win.__tmKeepAliveBrowser) {
        console.log("[TMDBG KeepAlive Experiment] Relay already injected in this window, skipping");
        return;
      }
      
      console.log("[TMDBG KeepAlive Experiment] Injecting hidden relay into window", win.location.href);
      
      try {
        // Create a hidden browser element that loads our extension page
        const browser = win.document.createXULElement("browser");
        browser.setAttribute("type", "content");
        browser.setAttribute("disableglobalhistory", "true");
        browser.setAttribute("messagemanagergroup", "webext-browsers");
        browser.setAttribute("webextension-view-type", "popup");
        browser.setAttribute("collapsed", "true");
        browser.setAttribute("remote", "true");
        browser.setAttribute("maychangeremoteness", "true");
        browser.setAttribute("remotetype", "extension");  // Critical for extension context
        
        browser.style.width = "0";
        browser.style.height = "0";
        browser.style.visibility = "collapse";
        
        // Attach to document first
        const container = win.document.documentElement;
        container.appendChild(browser);
        console.log("[TMDBG KeepAlive Experiment] Browser element appended to document");
        
        // Store browser element and handlers for cleanup (fixes hot reload leak)
        win.__tmKeepAliveBrowser = browser;
        
        // Store diagnostic listeners for cleanup
        win.__tmKeepAliveLoadHandler = () => {
          console.log("[TMDBG KeepAlive Experiment] Browser load event fired");
        };
        win.__tmKeepAliveErrorHandler = (e) => {
          console.error("[TMDBG KeepAlive Experiment] Browser load error:", e);
        };
        
        browser.addEventListener("load", win.__tmKeepAliveLoadHandler, true);
        browser.addEventListener("error", win.__tmKeepAliveErrorHandler, true);
        
        // Set src to load the relay page
        const relayURL = context.extension.baseURI.resolve("keepalive/relay.html");
        console.log("[TMDBG KeepAlive Experiment] Loading relay page:", relayURL);
        browser.setAttribute("src", relayURL);
        
        console.log("[TMDBG KeepAlive Experiment] Hidden relay injection complete");
      } catch (e) {
        console.error("[TMDBG KeepAlive Experiment] Failed to inject relay:", e);
      }
    }
    
    // Cleanup function called by both onShutdown and tmKeepAlive.shutdown()
    const cleanup = () => {
      console.log("[TMDBG KeepAlive Experiment] cleanup() called - cleaning up all resources.");
      
      try {
        // Unregister window listener (may already be unregistered from init)
        try {
          ExtensionSupportKA.unregisterWindowListener(listenerId);
          console.log("[TMDBG KeepAlive Experiment] Unregistered window listener:", listenerId);
        } catch (e) {
          // Already unregistered, ignore
        }
        
        // Clean up browser elements and listeners from all windows (fixes hot reload leak)
        const Services = globalThis.Services;
        if (Services && Services.wm) {
          const enumWin = Services.wm.getEnumerator("mail:3pane");
          while (enumWin.hasMoreElements()) {
            const win = enumWin.getNext();
            try {
              if (win.__tmKeepAliveBrowser) {
                // Remove event listeners
                if (win.__tmKeepAliveLoadHandler) {
                  win.__tmKeepAliveBrowser.removeEventListener("load", win.__tmKeepAliveLoadHandler, true);
                  delete win.__tmKeepAliveLoadHandler;
                }
                if (win.__tmKeepAliveErrorHandler) {
                  win.__tmKeepAliveBrowser.removeEventListener("error", win.__tmKeepAliveErrorHandler, true);
                  delete win.__tmKeepAliveErrorHandler;
                }
                
                // Remove browser element from DOM
                win.__tmKeepAliveBrowser.remove();
                delete win.__tmKeepAliveBrowser;
                
                console.log("[TMDBG KeepAlive Experiment] Cleaned up relay from window", win.location?.href);
              }
            } catch (cleanupErr) {
              console.error("[TMDBG KeepAlive Experiment] Error cleaning up window:", cleanupErr);
            }
          }
        }
      } catch (e) {
        console.error("[TMDBG KeepAlive Experiment] Error during cleanup:", e);
      }
      
      // Reset initialization flag so init() can run again on reload
      isInitialized = false;
      console.log("[TMDBG KeepAlive Experiment] cleanup() complete");
    };

    // Make cleanup available to onShutdown
    this._cleanup = cleanup;
    
    return {
      tmKeepAlive: {
        init() {
          // Guard against multiple initializations (prevents duplicate window listeners)
          if (isInitialized) {
            console.log("[TMDBG KeepAlive Experiment] Already initialized, skipping");
            return;
          }
          
          console.log("[TMDBG KeepAlive Experiment] init() called");
          
          isInitialized = true;

          // Clean up any previous registrations
          try {
            ExtensionSupportKA.unregisterWindowListener(listenerId);
          } catch (e) {
            // Expected to fail if no previous listener
          }

          // Register for both existing and future 3-pane windows
          ExtensionSupportKA.registerWindowListener(listenerId, {
            chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
            onLoadWindow: (win) => {
              console.log("[TMDBG KeepAlive Experiment] onLoadWindow fired for", win.location.href);
              injectRelayIntoWindow(win);
            },
          });

          console.log("[TMDBG KeepAlive Experiment] Window listener registered for always-on keepalive");
        },
        shutdown() {
          console.log("[TMDBG KeepAlive Experiment] shutdown() called from WebExtension API");
          cleanup();
        },
      },
    };
  }
};
