/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const { ExtensionSupport: ExtensionSupportKO } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonKO } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { EventManager: EventManagerKO } = ExtensionCommonKO;
const { getActualSelectedMessages: getActualSelectedMessagesKO } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionMailTabs.sys.mjs"
);

const ServicesKO = globalThis.Services;
const TAB_EVENT_KO = "keyOverrideTabPressed";
// Thunderbird's old getSelectedMessages consumer handled one 100-message page.
// Refuse larger actions as a whole instead of stalling keydown or acting partially.
const MAX_TAB_ACTION_MESSAGES_KO = 100;

console.log("[TabMail keyOverride] experiment parent script loaded. Services present?", typeof ServicesKO !== "undefined");

var keyOverride = class extends ExtensionCommonKO.ExtensionAPIPersistent {
  constructor(extension) {
    super(extension);
    this._tabSubscriptions = new Set();
    this.PERSISTENT_EVENTS = {
      onTabPressed: ({ fire }) => this._registerTabPressed(fire),
    };
  }

  _registerTabPressed(fire) {
    const subscription = { fire };
    const listener = (_event, info) => {
      try {
        Promise.resolve(subscription.fire.async(info)).catch(error => {
          console.error("[TabMail KeyOverride] Tab subscriber failed:", error);
        });
      } catch (error) {
        console.error("[TabMail KeyOverride] Tab subscriber failed:", error);
      }
    };
    subscription.listener = listener;
    this._tabSubscriptions.add(subscription);
    this.extension.on(TAB_EVENT_KO, listener);
    return {
      unregister: () => {
        this.extension.off(TAB_EVENT_KO, listener);
        this._tabSubscriptions.delete(subscription);
      },
      convert: newFire => { subscription.fire = newFire; },
    };
  }

  onShutdown(isAppShutdown) {
    // This is called by Thunderbird on disable/update/uninstall/app shutdown
    console.log("[TabMail KeyOverride] onShutdown() called by Thunderbird, isAppShutdown:", isAppShutdown);
    for (const subscription of this._tabSubscriptions) {
      try { this.extension.off(TAB_EVENT_KO, subscription.listener); } catch (_) {}
    }
    this._tabSubscriptions.clear();
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
    const extensionApi = this;
    let isInitialized = false; // Prevent multiple initializations

    function selectedMessageIds(win) {
      try {
        const pane = win.document.getElementById("tabmail")?.currentAbout3Pane;
        if (!pane) return [];
        const view = pane.gDBView;
        const tree = pane.threadTree;
        // selectedIndices is a computed array over every selected row.
        // Check the stored count before asking Thunderbird to materialize it.
        if (view?.selection?.count > MAX_TAB_ACTION_MESSAGES_KO) return [];
        const selected = tree?.selectedIndices;
        if (!view || !selected || selected.length > MAX_TAB_ACTION_MESSAGES_KO) return [];
        // Thunderbird expands selected collapsed threads inside
        // getActualSelectedMessages. Count their children before calling it:
        // a single selected row can otherwise synchronously enumerate thousands.
        let count = 0;
        const countIndex = index => {
          count += view.isContainer(index) && !view.isContainerOpen(index)
            ? view.getThreadContainingIndex(index).numChildren : 1;
          return count <= MAX_TAB_ACTION_MESSAGES_KO;
        };
        if (tree._selection?._selectEventsSuppressed) {
          for (const index of tree._selection._invalidIndices) {
            if (!selected.includes(index) && !countIndex(index)) return [];
          }
        } else {
          for (const index of selected) if (!countIndex(index)) return [];
        }
        if (!count) return [];
        const headers = getActualSelectedMessagesKO(pane);
        if (!headers?.length || headers.length > MAX_TAB_ACTION_MESSAGES_KO) return [];
        const ids = headers.map(hdr => context.extension.messageManager?.convert?.(hdr)?.id);
        // Do not consume a key unless every press-time target is addressable.
        return ids.every(id => Number.isInteger(id) && id > 0) ? [...new Set(ids)] : [];
      } catch (error) {
        console.error("[TabMail KeyOverride] Cannot capture Tab target:", error);
        return [];
      }
    }
    
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
        // Only bare Tab is an action. Thunderbird owns navigation chords.
        if (evt.code === "Tab" && !evt.shiftKey && !evt.ctrlKey && !evt.altKey && !evt.metaKey) {
          if (!extensionApi._tabSubscriptions.size) return;
          const messageIds = selectedMessageIds(win);
          if (!messageIds.length) return;
          console.log("[TabMail KeyOverride] Tab detected");
          extensionApi.extension.emit(TAB_EVENT_KO, { messageIds });
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
        ExtensionSupportKO.unregisterWindowListener(listenerId);
        console.log("[TabMail keyOverride] Unregistered window listener:", listenerId);
      } catch (e) {
        // Already unregistered, ignore
      }
      try {
        if (ServicesKO && ServicesKO.wm) {
          const enumr = ServicesKO.wm.getEnumerator(null);
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
        onTabPressed: new EventManagerKO({
          context,
          name: "keyOverride.onTabPressed",
          module: "keyOverride",
          event: "onTabPressed",
          extensionApi: this,
        }).api(),
            onChatHotkey: new EventManagerKO({
              context,
              name: "keyOverride.onChatHotkey",
              register: (fire) => {
                const obs = () => fire.async();
                ServicesKO.obs.addObserver(obs, "keyOverride-chatHotkey");
                return () => ServicesKO.obs.removeObserver(obs, "keyOverride-chatHotkey");
              },
            }).api(),
        init() {
          // Guard against multiple initializations (prevents duplicate window listeners)
          if (isInitialized) {
            console.log("[TabMail KeyOverride] Already initialized, skipping");
            return;
          }
          
          console.log("[TabMail keyOverride] init() called. Services is", ServicesKO);

          if (!ServicesKO || !ServicesKO.wm) {
            console.error("[TabMail keyOverride] Services or window mediator not available!");
            return;
          }
          
          isInitialized = true;

          // Clean up any previous registrations before initializing
          try {
            ExtensionSupportKO.unregisterWindowListener(listenerId);
          } catch (e) {
            // Expected to fail if no previous listener was registered
          }

          // ExtensionSupport.registerWindowListener handles both existing AND new windows
          // Future windows
          ExtensionSupportKO.registerWindowListener(listenerId, {
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
