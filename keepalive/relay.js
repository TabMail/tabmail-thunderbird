// keepalive/relay.js
// Hidden extension page that sends periodic message pings to keep MV3 service worker alive

(() => {
  console.log("[TMDBG KeepAlive Relay] ========== RELAY PAGE LOADED ==========");
  console.log("[TMDBG KeepAlive Relay] URL:", window.location.href);
  console.log("[TMDBG KeepAlive Relay] Timestamp:", new Date().toISOString());
  
  // Thunderbird-safe alias: prefer `browser`, fallback to `messenger`
  const EXT = (typeof globalThis.browser !== "undefined")
    ? globalThis.browser
    : (typeof globalThis.messenger !== "undefined" ? globalThis.messenger : null);
  
  if (!EXT) {
    console.error("[TMDBG KeepAlive Relay] No WebExtension API found (browser/messenger)!");
    return;
  }
  
  if (window.__tm_keepalive_timer) {
    console.log("[TMDBG KeepAlive Relay] Timer already running, skipping");
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
  console.log("[TMDBG KeepAlive Relay] Initial ping sent");
  
  // Start periodic pings
  const timer = setInterval(() => {
    sendPing();
    console.log("[TMDBG KeepAlive Relay] Periodic ping sent");
  }, PING_INTERVAL);
  
  window.__tm_keepalive_timer = timer;
  
  // Cleanup on page unload
  window.addEventListener("unload", () => {
    if (window.__tm_keepalive_timer) {
      clearInterval(window.__tm_keepalive_timer);
      window.__tm_keepalive_timer = null;
    }
  });
  
  // Expose diagnostic function
  window.__tm_keepalive_diagnostic = () => {
    console.log("=== KEEPALIVE RELAY DIAGNOSTIC ===");
    console.log("URL:", window.location.href);
    console.log("Timer active:", window.__tm_keepalive_timer !== null);
    console.log("Timer ID:", window.__tm_keepalive_timer);
    console.log("Ping interval:", PING_INTERVAL, "ms");
    console.log("browser available:", typeof globalThis.browser !== "undefined");
    console.log("messenger available:", typeof globalThis.messenger !== "undefined");
    console.log("==================================");
    return "Check console output above";
  };
  
  console.log(`[TMDBG KeepAlive Relay] Setup complete - pinging every ${PING_INTERVAL}ms`);
})();

