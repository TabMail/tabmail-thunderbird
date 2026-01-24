const { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { EventManager } = ExtensionCommon;

const Services = globalThis.Services;

console.log("[TabMail keyOverride] experiment parent script loaded. Services present?", typeof Services !== "undefined");

var keyOverride = class extends ExtensionCommon.ExtensionAPI {
  onShutdown(isAppShutdown) {
    // This is called by Thunderbird on disable/update/uninstall/app shutdown
    console.log("[TabMail KeyOverride] onShutdown() called by Thunderbird, isAppShutdown:", isAppShutdown);
    try {
      if (this._cleanup) {
        this._cleanup();
        console.log("[TabMail KeyOverride] ✓ Cleanup completed via onShutdown");
      }
    } catch (e) {
      console.error("[TabMail KeyOverride] onShutdown cleanup failed:", e);
    }
  }

  getAPI(context) {
    let isInitialized = false; // Prevent multiple initializations
    
    function addWindowKeyHook(win) {
      // Only register if not already registered (prevents hot reload leak)
      if (win.__keyOverrideHandler) {
        console.log("[TabMail KeyOverride] Key listener already registered for window, skipping");
        return;
      }
      
      console.log("[TabMail KeyOverride] Installing WINDOW-level key listener in", win.location.href);
      
      // Store handler for cleanup (fixes hot reload leak)
      win.__keyOverrideHandler = evt => {
        console.log("[TabMail KeyOverride] Window-level keydown:", evt.key, "code:", evt.code, "ctrl?", evt.ctrlKey, "alt?", evt.altKey, "meta?", evt.metaKey, "shift?", evt.shiftKey, "target", evt.target);
        // Chat hotkey migration: handled by MV3 commands now. Keep log for diagnostics and do NOT intercept.
        if (evt.code === "KeyL" && evt.altKey && (evt.metaKey || evt.ctrlKey)) {
          console.log("[TabMail KeyOverride] Chat hotkey detected (MV3 commands will handle); not intercepting");
          // Intentionally not preventing default so MV3 commands receives this.
        }
        if (evt.code === "Tab" && evt.shiftKey) {
          console.log("[TabMail KeyOverride] Shift+Tab detected");
          Services.obs.notifyObservers(null, "keyOverride-shiftTabPressed");
          evt.preventDefault();
          evt.stopPropagation();
          evt.stopImmediatePropagation();
          return false;
        }
        if (evt.code === "Tab") {
          console.log("[TabMail KeyOverride] Tab detected");
          Services.obs.notifyObservers(null, "keyOverride-tabPressed");
          evt.preventDefault();
          evt.stopPropagation();
          evt.stopImmediatePropagation();
          return false;
        }
      };
      
      win.addEventListener("keydown", win.__keyOverrideHandler, true);
    }

    const listenerId = context.extension.id + "-keyOverride-windows";

    // Cleanup function called by both onShutdown and keyOverride.shutdown()
    const cleanup = () => {
      console.log("[TabMail KeyOverride] cleanup() called - cleaning up all resources.");
      
      // Unregister window listener (may already be unregistered from init)
      try {
        ExtensionSupport.unregisterWindowListener(listenerId);
        console.log("[TabMail keyOverride] Unregistered window listener:", listenerId);
      } catch (e) {
        // Already unregistered, ignore
      }
      try {
        if (Services && Services.wm) {
          const enumr = Services.wm.getEnumerator(null);
          while (enumr && enumr.hasMoreElements()) {
            const win = enumr.getNext();
            try {
              if (win && win.__keyOverrideHandler) {
                // Remove the actual event listener (fixes hot reload leak)
                win.removeEventListener("keydown", win.__keyOverrideHandler, true);
                delete win.__keyOverrideHandler;
                console.log("[TabMail KeyOverride] Removed key listener from window", win.location?.href);
              }
            } catch (_) {}
          }
        }
      } catch (e) {
        console.warn("[TabMail KeyOverride] Failed to clean up key listeners during shutdown:", e);
      }
      
      // Reset initialization flag so init() can run again on reload
      isInitialized = false;
      console.log("[TabMail KeyOverride] cleanup() complete");
    };

    // Make cleanup available to onShutdown
    this._cleanup = cleanup;

    return {
      keyOverride: {
        onTabPressed: new EventManager({
          context,
          name: "keyOverride.onTabPressed",
          register: (fire) => {
            const obs = () => fire.async();
            Services.obs.addObserver(obs, "keyOverride-tabPressed");
            return () => Services.obs.removeObserver(obs, "keyOverride-tabPressed");
          },
        }).api(),
            onShiftTabPressed: new EventManager({
              context,
              name: "keyOverride.onShiftTabPressed",
              register: (fire) => {
                const obs = () => fire.async();
                Services.obs.addObserver(obs, "keyOverride-shiftTabPressed");
                return () => Services.obs.removeObserver(obs, "keyOverride-shiftTabPressed");
              },
            }).api(),
            onChatHotkey: new EventManager({
              context,
              name: "keyOverride.onChatHotkey",
              register: (fire) => {
                const obs = () => fire.async();
                Services.obs.addObserver(obs, "keyOverride-chatHotkey");
                return () => Services.obs.removeObserver(obs, "keyOverride-chatHotkey");
              },
            }).api(),
        init() {
          // Guard against multiple initializations (prevents duplicate window listeners)
          if (isInitialized) {
            console.log("[TabMail KeyOverride] Already initialized, skipping");
            return;
          }
          
          console.log("[TabMail keyOverride] init() called. Services is", Services);

          if (!Services || !Services.wm) {
            console.error("[TabMail keyOverride] Services or window mediator not available!");
            return;
          }
          
          isInitialized = true;

          // Clean up any previous registrations before initializing
          try {
            ExtensionSupport.unregisterWindowListener(listenerId);
          } catch (e) {
            // Expected to fail if no previous listener was registered
          }

          // ExtensionSupport.registerWindowListener handles both existing AND new windows
          // Future windows
          ExtensionSupport.registerWindowListener(listenerId, {
            chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
            onLoadWindow: (win) => {
              console.log("[TabMail keyOverride] onLoadWindow fired for", win.location.href);
              addWindowKeyHook(win);
            },
          });

          console.log("[TabMail keyOverride] Window listener registered.");
        },
        shutdown() {
          console.log("[TabMail KeyOverride] shutdown() called from WebExtension API");
          cleanup();
        },
      },
    };
  }
}; 


