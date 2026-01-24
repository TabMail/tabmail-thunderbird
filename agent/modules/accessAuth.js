// tbAccessAuth.js – Cloudflare Access authentication helper for Thunderbird addon
import { getBackendUrl, SETTINGS } from "./config.js";
import { log } from "./utils.js";

// Cache for maintenance mode check (avoid repeated requests)
let _maintenanceMode = null;
let _maintenanceModeCheckedAt = 0;
const MAINTENANCE_CACHE_MS = 30000; // Cache for 30 seconds

/**
 * Check if the API is in maintenance mode
 * 
 * @returns {Promise<boolean>} true if maintenance mode is active
 */
export async function isMaintenanceMode() {
  // Use cached value if recent
  if (_maintenanceMode !== null && Date.now() - _maintenanceModeCheckedAt < MAINTENANCE_CACHE_MS) {
    return _maintenanceMode;
  }

  try {
    const baseUrl = await getBackendUrl("whoami");
    const configUrl = `${baseUrl}/config/public`;
    
    const resp = await fetch(configUrl, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    
    if (!resp.ok) {
      log(`[Auth] Maintenance check failed: status=${resp.status}`);
      _maintenanceMode = false;
      _maintenanceModeCheckedAt = Date.now();
      return false;
    }
    
    const data = await resp.json();
    _maintenanceMode = data.block_all_api === true;
    _maintenanceModeCheckedAt = Date.now();
    
    log(`[Auth] Maintenance mode check: ${_maintenanceMode}`);
    return _maintenanceMode;
  } catch (e) {
    log(`[Auth] Maintenance mode check failed: ${e}`);
    _maintenanceMode = false;
    _maintenanceModeCheckedAt = Date.now();
    return false;
  }
}

/**
 * Checks if the user is currently logged in to Cloudflare Access.
 * 
 * @returns {Promise<boolean>} true if logged in, false otherwise
 */
export async function isLoggedIn() {
  try {
    // Use whoami endpoint for authentication checks
    const whoamiBase = await getBackendUrl("whoami");
    const whoamiUrl = `${whoamiBase}/whoami?t=${Date.now()}`;
    const resp = await fetch(whoamiUrl, {
      method: "GET",
      credentials: "include",
      headers: { 
        "Accept": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache"
      },
    });
    
    log(`[Auth] isLoggedIn check: status=${resp.status}, ok=${resp.ok}, contentType=${resp.headers.get("content-type")}`);
    
    // Check for maintenance mode (503)
    if (resp.status === 503) {
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        try {
          const data = await resp.json();
          if (data.error === "maintenance") {
            log("[Auth] isLoggedIn: API in maintenance mode");
            _maintenanceMode = true;
            _maintenanceModeCheckedAt = Date.now();
            return false;
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
      log("[Auth] isLoggedIn: Service unavailable (503)");
      return false;
    }
    
    if (!resp.ok) {
      log("[Auth] isLoggedIn: response not ok, not authenticated");
      return false;
    }
    
    // Check if response is JSON
    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await resp.text();
      log(`[Auth] isLoggedIn: Got non-JSON response (${contentType}), first 200 chars: ${text.substring(0, 200)}`);
      return false;
    }
    
    // Check if the response contains an email (authenticated) or null (not authenticated)
    const data = await resp.json();
    const hasEmail = data && data.email && data.email.trim().length > 0;
    log(`[Auth] isLoggedIn: email=${data?.email || "null"}, hasEmail=${hasEmail}`);
    
    return hasEmail;
  } catch (e) {
    log(`[Auth] isLoggedIn check failed: ${e}`);
    return false;
  }
}

/**
 * Opens relay(or dev).tabmail.ai in a popup window so the user completes 
 * Cloudflare Access (Google/GitHub SSO). Uses content script (stay-in-window.js) 
 * to prevent external browser opens. Polls /whoami until success.
 * 
 * After timeout, shows a "timeout" page instead of closing window (better UX).
 * 
 * @returns {Promise<boolean>} true if signed in successfully, false if user cancelled or timed out
 */
export async function ensureSignedIn() {
  const timeoutMs = SETTINGS.authSignInTimeoutMs;
  let navTargetListener = null;
  try {
    // Check maintenance mode first
    const inMaintenance = await isMaintenanceMode();
    if (inMaintenance) {
      log("[Auth] API in maintenance mode, sign-in blocked");
      // Don't open any popup - the popup.js will show maintenance status
      return false;
    }

    // Use whoami endpoint for authentication
    const whoamiBase = await getBackendUrl("whoami"); // https://whoami.dev.tabmail.ai or https://whoami.api.tabmail.ai
    const signinUrl = `${whoamiBase}/whoami`;   // use /whoami to trigger Cloudflare Access

    log("[Auth] Opening popup window for sign-in (content script will prevent external browser)");
    log(`[Auth] Signin URL: ${signinUrl}`);

    // 1) Open a popup window for the Access-protected page
    const authWindowConfig = SETTINGS.authWindow;
    const win = await browser.windows.create({
      url: signinUrl,
      type: "popup",
      width: authWindowConfig.defaultWidth,
      height: authWindowConfig.defaultHeight,
    });

    log(`[Auth] Created popup window with ID: ${win.id}`);
    
    // Store window ID for concurrent re-auth detection
    _reAuthWindowId = win.id;

    // Get the tab from the window
    const tabs = await browser.tabs.query({ windowId: win.id, active: true });
    if (!tabs || tabs.length === 0) {
      throw new Error("Failed to get tab from popup window");
    }
    const popupTab = tabs[0];

    log(`[Auth] Popup tab ID: ${popupTab.id}, initial URL: ${popupTab.url}`);
    log("[Auth] ⚠️ IMPORTANT: Open the popup's console (right-click → Inspect) and look for:");
    log("[Auth]    '[TabMail Auth] Injecting stay-in-window script at document_start'");
    log("[Auth]    If you DON'T see this message, the content script isn't loading!");

    // 2) Set up navigation target interceptor (Fix B - belt-and-suspenders)
    // If somehow a new tab/window is spawned, fold it back into our popup
    navTargetListener = async (details) => {
      if (details.sourceTabId === popupTab.id) {
        log(`[Auth] ⚠️ INTERCEPTING new navigation target from popup!`);
        log(`[Auth]    Source tab: ${details.sourceTabId}, New tab: ${details.tabId}`);
        log(`[Auth]    URL: ${details.url}`);
        log(`[Auth]    This means content script didn't prevent window.open!`);
        try {
          // Navigate our popup to the new URL instead
          await browser.tabs.update(popupTab.id, { url: details.url });
          // Close the newly created tab
          await browser.tabs.remove(details.tabId);
          log("[Auth] Folded navigation back into popup (backup mechanism worked)");
        } catch (e) {
          log(`[Auth] Failed to fold navigation back: ${e}`, "warn");
        }
      }
    };
    browser.webNavigation.onCreatedNavigationTarget.addListener(navTargetListener);
    log("[Auth] Navigation target interceptor installed");

    const t0 = Date.now();
    let pollCount = 0;

    // 3) Poll /whoami until authenticated (with timeout - shows friendly timeout page)
    log(`[Auth] Starting authentication polling loop (${Math.floor(timeoutMs/1000)}s timeout)...`);
    while (true) {
      await sleep(1200);
      pollCount++;
      
      // Check for timeout
      if (Date.now() - t0 >= timeoutMs) {
        log("[Auth] Sign-in timed out, showing timeout page", "warn");
        if (navTargetListener) {
          browser.webNavigation.onCreatedNavigationTarget.removeListener(navTargetListener);
        }
        // Navigate to timeout page (keeps window open for user awareness)
        try {
          const timeoutPageUrl = browser.runtime.getURL(`agent/pages/auth-timeout.html?returnUrl=${encodeURIComponent(signinUrl)}`);
          await browser.tabs.update(popupTab.id, { url: timeoutPageUrl });
          log("[Auth] Navigated to timeout page, window stays open");
        } catch (e) {
          log(`[Auth] Failed to navigate to timeout page: ${e}`, "warn");
          try { await browser.windows.remove(win.id); } catch(_) {}
        }
        return false;
      }
      
      // Check if window was closed by user or if showing timeout page
      try {
        await browser.windows.get(win.id);
        
        // Check if we're on the timeout page
        try {
          const tab = await browser.tabs.get(popupTab.id);
          if (tab.url && tab.url.includes('auth-timeout.html')) {
            log("[Auth] User is on timeout page, treating as cancellation");
            if (navTargetListener) {
              browser.webNavigation.onCreatedNavigationTarget.removeListener(navTargetListener);
            }
            // Don't close window - let user close it
            return false;
          }
        } catch (_) {}
      } catch (_) {
        log("[Auth] Signin window closed by user", "warn");
        if (navTargetListener) {
          browser.webNavigation.onCreatedNavigationTarget.removeListener(navTargetListener);
        }
        // Check if they actually authenticated before closing
        const loggedIn = await isLoggedIn();
        log(`[Auth] After window closed, checking auth state: ${loggedIn}`);
        
        // NOTE: Icon update is handled by background.js after ensureSignedIn() returns.
        // Do NOT sendMessage here - we're already in the background context.
        
        return loggedIn;
      }
      
      // Check authentication status
      const loggedIn = await isLoggedIn();
      if (loggedIn) {
        log(`[Auth] ✓ Authentication detected after ${pollCount} polls!`);
        if (navTargetListener) {
          browser.webNavigation.onCreatedNavigationTarget.removeListener(navTargetListener);
        }
        // Small delay to ensure auth state is fully propagated
        await sleep(300);
        try { await browser.windows.remove(win.id); } catch(_) {}
        log(`[Auth] Sign-in complete, popup closed`);
        
        // NOTE: Icon update and summary refresh are handled by background.js
        // after ensureSignedIn() returns. Do NOT sendMessage here - we're already
        // in the background context and runtime.sendMessage to self doesn't work.
        
        return true;
      }
      
      if (pollCount % 5 === 0) {
        log(`[Auth] Still waiting for authentication... (poll #${pollCount})`);
      }
    }
  } catch (e) {
    if (navTargetListener) {
      try {
        browser.webNavigation.onCreatedNavigationTarget.removeListener(navTargetListener);
      } catch (_) {}
    }
    log(`[Auth] ensureSignedIn failed: ${e}`, "error");
    return false;
  }
}

/**
 * Signs out the user from Cloudflare Access by opening the logout URL in a popup window.
 * Injects script to prevent external browser opens during logout flow.
 * 
 * After timeout, shows a "timeout" page instead of closing window.
 * 
 * @returns {Promise<boolean>} true if signed out successfully, false if cancelled or timed out
 */
export async function signOut() {
  const timeoutMs = SETTINGS.authSignOutTimeoutMs;
  try {
    // Use whoami endpoint for sign-out (Cloudflare logout is domain-wide)
    const whoamiBase = await getBackendUrl("whoami");
    const base = new URL(whoamiBase);
    const logoutUrl = `${base.origin}/cdn-cgi/access/logout`;

    log("[Auth] Starting sign-out process");
    log(`[Auth] Logout URL: ${logoutUrl}`);

    // 1) Open the logout URL in a popup window (content script handles staying in window)
    const authWindowConfig = SETTINGS.authWindow;
    const win = await browser.windows.create({
      url: logoutUrl,
      type: "popup",
      width: authWindowConfig.defaultWidth,
      height: authWindowConfig.defaultHeight,
    });

    log(`[Auth] Created logout popup window with ID: ${win.id}`);

    const t0 = Date.now();
    let pollCount = 0;

    // 2) Poll /whoami until email becomes null (with timeout - shows friendly timeout page)
    log(`[Auth] Starting logout polling loop (${Math.floor(timeoutMs/1000)}s timeout)...`);
    while (true) {
      await sleep(800);
      pollCount++;
      
      // Check for timeout
      if (Date.now() - t0 >= timeoutMs) {
        log("[Auth] Sign-out timed out, showing timeout page", "warn");
        // Navigate to timeout page
        try {
          const timeoutPageUrl = browser.runtime.getURL(`agent/pages/auth-timeout.html?returnUrl=${encodeURIComponent(logoutUrl)}`);
          const tabs = await browser.tabs.query({ windowId: win.id, active: true });
          if (tabs && tabs.length > 0) {
            await browser.tabs.update(tabs[0].id, { url: timeoutPageUrl });
            log("[Auth] Navigated to timeout page, window stays open");
          }
        } catch (e) {
          log(`[Auth] Failed to navigate to timeout page: ${e}`, "warn");
          try { await browser.windows.remove(win.id); } catch(_) {}
        }
        return false;
      }
      
      // Check if window was closed by user (this is how they cancel)
      try {
        await browser.windows.get(win.id);
      } catch (_) {
        log("[Auth] Logout window closed by user", "warn");
        // Still check if logout succeeded
        const loggedIn = await isLoggedIn();
        log(`[Auth] After window closed, loggedIn=${loggedIn}`);
        return !loggedIn;
      }
      
      // Check if logged out
      const loggedIn = await isLoggedIn();
      if (!loggedIn) {
        log(`[Auth] ✓ Logout confirmed after ${pollCount} polls!`);
        try { await browser.windows.remove(win.id); } catch(_) {}
        log("[Auth] Sign-out complete, popup closed");
        await sleep(500);
        return true;
      }
      
      if (pollCount % 3 === 0) {
        log(`[Auth] Still logged in, waiting... (poll #${pollCount})`);
      }
    }
  } catch (e) {
    log(`[Auth] signOut failed: ${e}`, "error");
    return false;
  }
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Track if we're currently in a re-auth flow to avoid multiple concurrent signin windows
let _reAuthInProgress = false;
let _reAuthWindowId = null; // Track the auth window ID so other requests can check if it's still open

/**
 * Reset auth state (called on extension startup to clear stale state).
 * This prevents issues with invalid window IDs from previous sessions.
 */
export function resetAuthState() {
  log("[Auth] Resetting auth state (clearing any stale re-auth flags)");
  _reAuthInProgress = false;
  _reAuthWindowId = null;
}

/**
 * Checks if an error response indicates an authentication failure.
 * 
 * @param {Response} response - Fetch response object
 * @returns {boolean} true if this looks like an auth error
 */
export function isAuthError(response) {
  // Check HTTP status codes that indicate auth issues
  if (response.status === 401 || response.status === 403) {
    return true;
  }
  // Could also check for specific Cloudflare Access error patterns
  return false;
}

/**
 * Handles authentication errors by checking auth state and optionally triggering re-auth.
 * 
 * This provides a seamless re-authentication experience:
 * 1. Detects auth error (401/403)
 * 2. Verifies with /whoami that we're actually logged out
 * 3. Opens signin window automatically
 * 4. Returns auth state after completion
 * 
 * @param {Response} response - The failed fetch response
 * @param {Object} options - Options
 * @param {boolean} [options.autoSignin=true] - Whether to automatically trigger signin
 * @param {boolean} [options.silent=false] - Whether to skip logging
 * @returns {Promise<boolean|null>} true if user is now authenticated, false if signin failed, null if feature is disabled (logged in but endpoint requires different tier)
 */
export async function handleAuthError(response, { autoSignin = null, silent = false } = {}) {
  // Check user preference if not explicitly provided
  if (autoSignin === null) {
    try {
      const { authAutoReauthEnabled } = await browser.storage.local.get({ 
        authAutoReauthEnabled: SETTINGS.authAutoReauthEnabled 
      });
      autoSignin = authAutoReauthEnabled;
    } catch (e) {
      log(`[Auth] Failed to read authAutoReauthEnabled preference: ${e}`, "warn");
      autoSignin = SETTINGS.authAutoReauthEnabled; // Fall back to default
    }
  }
  try {
    // First, verify this is actually an auth error by checking /whoami
    if (!silent) {
      log(`[Auth] Handling potential auth error (status=${response.status})`);
    }
    
    const loggedIn = await isLoggedIn();
    
    if (loggedIn) {
      // User is logged in but endpoint still returned auth error
      // This means the feature is disabled (requires different tier of auth)
      // Silently ignore - do not attempt signin, do not retry
      if (!silent) {
        log(`[Auth] User is logged in but endpoint requires different tier - feature disabled, silently ignoring`);
      }
      return null; // Special return value: feature disabled
    }
    
    // Confirmed: user is not logged in
    if (!silent) {
      log(`[Auth] Confirmed user is not logged in`);
    }
    
    if (!autoSignin) {
      if (!silent) {
        log(`[Auth] Auto-signin disabled, returning false`);
      }
      return false;
    }
    
    // Check if we're already doing a re-auth to avoid multiple signin windows
    if (_reAuthInProgress) {
      if (!silent) {
        log(`[Auth] Re-auth already in progress, waiting for it to complete...`);
      }
      
      // Wait for existing re-auth to complete - no timeout needed
      // If the window is still open, user is working on it
      // If window closes, the other re-auth will clear the flag
      while (_reAuthInProgress) {
        await sleep(1000);
        
        // Safety check: if we have a window ID and it's closed, clear the stuck flag
        if (_reAuthWindowId !== null) {
          try {
            await browser.windows.get(_reAuthWindowId);
            // Window still exists, keep waiting
          } catch (_) {
            // Window closed but flag not cleared - something went wrong
            if (_reAuthInProgress) {
              log(`[Auth] Re-auth window closed but flag still set - clearing stuck flag`, "warn");
              _reAuthInProgress = false;
              _reAuthWindowId = null;
              // Fall through to try re-auth ourselves
              break;
            }
          }
        }
      }
      
      // If we're still waiting (flag was cleared normally), check final auth state
      if (!_reAuthInProgress) {
        return await isLoggedIn();
      }
      // Otherwise fall through to try re-auth ourselves (after cleanup)
    }
    
    // Trigger re-authentication (atomic set to prevent race)
    _reAuthInProgress = true;
    _reAuthWindowId = null; // Will be set by ensureSignedIn
    try {
      if (!silent) {
        log(`[Auth] Triggering automatic re-authentication`);
      }
      
      const success = await ensureSignedIn();
      
      if (success) {
        if (!silent) {
          log(`[Auth] Re-authentication successful`);
        }
      } else {
        if (!silent) {
          log(`[Auth] Re-authentication failed or cancelled`);
        }
      }
      
      return success;
    } finally {
      _reAuthInProgress = false;
      _reAuthWindowId = null;
    }
  } catch (e) {
    if (!silent) {
      log(`[Auth] handleAuthError failed: ${e}`, "error");
    }
    _reAuthInProgress = false;
    _reAuthWindowId = null;
    return false;
  }
}

