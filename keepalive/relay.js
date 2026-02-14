// keepalive/relay.js
// Hidden extension page that sends periodic message pings to keep MV3 service worker alive

(() => {
  // Debug logging flag — read once from config module's static default.
  // relay.js is a non-module script, so we read debugLogging from storage.local
  // (mirrors SETTINGS.debugLogging which defaults to false).
  let _debugLogging = false;

  // Async init: read debugLogging from storage once at startup
  (async () => {
    try {
      const EXT_INIT = (typeof globalThis.browser !== "undefined") ? globalThis.browser
        : (typeof globalThis.messenger !== "undefined" ? globalThis.messenger : null);
      if (EXT_INIT) {
        const stored = await EXT_INIT.storage.local.get({ debugLogging: false });
        _debugLogging = stored.debugLogging === true;
      }
    } catch (_) { /* ignore — stays false */ }
  })();

  if (_debugLogging) console.log("[TMDBG KeepAlive Relay] ========== RELAY PAGE LOADED ==========");
  if (_debugLogging) console.log("[TMDBG KeepAlive Relay] URL:", window.location.href);
  if (_debugLogging) console.log("[TMDBG KeepAlive Relay] Timestamp:", new Date().toISOString());

  // Thunderbird-safe alias: prefer `browser`, fallback to `messenger`
  const EXT = (typeof globalThis.browser !== "undefined")
    ? globalThis.browser
    : (typeof globalThis.messenger !== "undefined" ? globalThis.messenger : null);

  if (!EXT) {
    console.error("[TMDBG KeepAlive Relay] No WebExtension API found (browser/messenger)!");
    return;
  }

  if (window.__tm_keepalive_timer) {
    if (_debugLogging) console.log("[TMDBG KeepAlive Relay] Timer already running, skipping");
    return;
  }

  // Send periodic message pings to keep SW alive
  // No listener needed - the act of sending the message resets SW idle timer
  const PING_INTERVAL = 10000; // 10 seconds
  
  function sendPing() {
    try {
      // Send message - will be ignored by background but keeps SW alive
      EXT.runtime.sendMessage({ 
        type: "keepalive-ping", 
        t: Date.now() 
      }).catch(() => {
        // Ignore errors (e.g., during reload)
      });
    } catch (e) {
      // Ignore
    }
  }
  
  // Send immediate ping on load
  sendPing();
  if (_debugLogging) console.log("[TMDBG KeepAlive Relay] Initial ping sent");

  // Start periodic pings
  const timer = setInterval(() => {
    sendPing();
    if (_debugLogging) console.log("[TMDBG KeepAlive Relay] Periodic ping sent");
  }, PING_INTERVAL);
  
  window.__tm_keepalive_timer = timer;
  
  // Cleanup on page unload
  window.addEventListener("unload", () => {
    if (window.__tm_keepalive_timer) {
      clearInterval(window.__tm_keepalive_timer);
      window.__tm_keepalive_timer = null;
    }
  });
  
  // Expose diagnostic function (always logs when explicitly called by developer)
  window.__tm_keepalive_diagnostic = () => {
    console.log("=== KEEPALIVE RELAY DIAGNOSTIC ===");
    console.log("URL:", window.location.href);
    console.log("Timer active:", window.__tm_keepalive_timer !== null);
    console.log("Timer ID:", window.__tm_keepalive_timer);
    console.log("Ping interval:", PING_INTERVAL, "ms");
    console.log("browser available:", typeof globalThis.browser !== "undefined");
    console.log("messenger available:", typeof globalThis.messenger !== "undefined");
    console.log("debugLogging:", _debugLogging);
    console.log("==================================");
    return "Check console output above";
  };

  if (_debugLogging) console.log(`[TMDBG KeepAlive Relay] Setup complete - pinging every ${PING_INTERVAL}ms`);
})();

