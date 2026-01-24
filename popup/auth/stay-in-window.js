// stay-in-window.js
// Runs at document_start to prevent window.open and target="_blank" from opening external browser
// This ensures OAuth flows stay inside Thunderbird
// Also relays resize requests from signin page to the addon background

(() => {
  console.log("[TabMail Auth] Injecting stay-in-window script at document_start");

  // Listen for resize requests from the signin page and relay to background
  window.addEventListener("message", (event) => {
    // Only accept messages from the same origin
    if (event.source !== window) return;
    
    const data = event.data;
    if (data && data.type === "TABMAIL_RESIZE_REQUEST") {
      console.log("[TabMail Auth] Received resize request:", data);
      
      // Relay to background script
      try {
        browser.runtime.sendMessage({
          command: "auth-window-resize",
          width: data.width,
          height: data.height,
          timestamp: data.timestamp
        }).then(() => {
          console.log("[TabMail Auth] Resize request sent to background");
        }).catch((err) => {
          console.log("[TabMail Auth] Failed to send resize request:", err);
        });
      } catch (err) {
        console.error("[TabMail Auth] Error sending resize message:", err);
      }
    }
  }, false);

  // 1) Override window.open FIRST (before anything else)
  const realOpen = window.open;
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value: function (url, target, features) {
      console.log("[TabMail Auth] ⚠️ window.open intercepted!", { url, target, features });
      console.log("[TabMail Auth] Navigating in-place instead of opening new window");
      try {
        if (typeof url === "string" && url) {
          // Navigate in-place instead of opening new window
          window.location.href = url;
          return null;
        }
      } catch (err) {
        console.error("[TabMail Auth] Error in window.open override:", err);
      }
      // Return null instead of calling real open
      console.log("[TabMail Auth] Blocked window.open completely");
      return null;
    }
  });

  console.log("[TabMail Auth] window.open override installed");

  // 2) Intercept ALL clicks at capture phase and prevent default
  addEventListener("click", (e) => {
    console.log("[TabMail Auth] Click detected:", e.target);
    
    // Check for links
    const a = e.target && e.target.closest && e.target.closest("a[href]");
    if (a && a.href) {
      console.log("[TabMail Auth] Link clicked:", a.href, "target:", a.target);
      
      // Allow links marked with data-external="true" to open in browser
      if (a.dataset.external === "true") {
        console.log("[TabMail Auth] External link - allowing default browser behavior");
        // Don't prevent default - let it open in the system browser
        return;
      }
      
      // CRITICAL: Prevent the default link behavior (which TB intercepts for external URLs)
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      
      console.log("[TabMail Auth] Prevented default link behavior");
      console.log("[TabMail Auth] Navigating programmatically to:", a.href);
      
      // Navigate programmatically instead (this stays in the window)
      window.location.href = a.href;
      
      console.log("[TabMail Auth] Navigation initiated");
      return false;
    }
    
    // Check for buttons that might trigger window.open
    const button = e.target && e.target.closest && e.target.closest("button");
    if (button) {
      console.log("[TabMail Auth] Button clicked:", button);
    }
  }, true);

  // 3) Intercept form submits with target="_blank"
  addEventListener("submit", (e) => {
    const form = e.target;
    if (form && form.target === "_blank") {
      console.log("[TabMail Auth] Form with target=_blank, changing to _self");
      form.target = "_self";
    }
  }, true);

  console.log("[TabMail Auth] All event interceptors installed");
})();

