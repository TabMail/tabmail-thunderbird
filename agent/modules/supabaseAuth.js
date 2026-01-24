// supabaseAuth.js – Supabase authentication helper for Thunderbird addon
import { getBackendUrl, SETTINGS } from "./config.js";
import { log } from "./utils.js";

// Supabase client will be initialized via CDN script in the OAuth window
// For the addon itself, we manage tokens manually for better control

/**
 * Gets the stored Supabase session (access_token and refresh_token).
 * 
 * @returns {Promise<{access_token: string, refresh_token: string, expires_at: number}|null>}
 */
export async function getSession() {
  try {
    log("[SupabaseAuth] getSession() - fetching from storage...");
    const result = await browser.storage.local.get("supabaseSession");
    log(`[SupabaseAuth] getSession() - storage returned: ${result.supabaseSession ? "session found" : "no session"}`);
    return result.supabaseSession || null;
  } catch (e) {
    log(`[SupabaseAuth] Failed to get session: ${e}`, "error");
    return null;
  }
}

/**
 * Stores the Supabase session.
 * 
 * @param {{access_token: string, refresh_token: string, expires_at: number}} session
 */
async function setSession(session) {
  try {
    await browser.storage.local.set({ supabaseSession: session });
    log("[SupabaseAuth] Session stored successfully");
  } catch (e) {
    log(`[SupabaseAuth] Failed to store session: ${e}`, "error");
  }
}

/**
 * Clears the stored Supabase session.
 */
async function clearSession() {
  try {
    await browser.storage.local.remove("supabaseSession");
    log("[SupabaseAuth] Session cleared");
  } catch (e) {
    log(`[SupabaseAuth] Failed to clear session: ${e}`, "error");
  }
}

/**
 * Gets a valid access token, refreshing if necessary.
 * Uses a mutex to prevent race conditions when multiple calls happen simultaneously.
 * 
 * @returns {Promise<string|null>} The access token, or null if not logged in
 */
export async function getAccessToken() {
  log("[SupabaseAuth] getAccessToken() called");
  const session = await getSession();
  log(`[SupabaseAuth] getSession() returned: ${session ? "session found" : "null"}`);
  if (!session) {
    log("[SupabaseAuth] No session, returning null");
    return null;
  }

  // Check if token is expired or about to expire (within 60 seconds)
  const now = Math.floor(Date.now() / 1000);
  log(`[SupabaseAuth] Token expires_at: ${session.expires_at}, now: ${now}, diff: ${session.expires_at - now}s`);
  if (session.expires_at && session.expires_at - now < 60) {
    log("[SupabaseAuth] Token expired or expiring soon, refreshing...");
    
    // If a refresh is already in progress, wait for it instead of starting a new one
    if (_refreshInProgress) {
      log("[SupabaseAuth] Refresh already in progress, waiting for result...");
      try {
        const result = await _refreshInProgress;
        log(`[SupabaseAuth] Waited for in-progress refresh, result: ${result ? "success" : "failed"}`);
        return result;
      } catch (e) {
        log(`[SupabaseAuth] Error waiting for in-progress refresh: ${e}`, "error");
        return null;
      }
    }
    
    // Start a new refresh and store the promise so other callers can wait
    log("[SupabaseAuth] Starting new refresh (no other refresh in progress)");
    _refreshInProgress = performTokenRefreshWithRetry(session.refresh_token);
    
    try {
      const result = await _refreshInProgress;
      return result;
    } finally {
      // Clear the in-progress flag after completion (success or failure)
      _refreshInProgress = null;
      log("[SupabaseAuth] Refresh completed, cleared in-progress flag");
    }
  }

  log("[SupabaseAuth] Returning existing access token");
  return session.access_token;
}

/**
 * Performs token refresh with retry logic and exponential backoff.
 * This is separated from getAccessToken() to enable the mutex pattern.
 * 
 * @param {string} refreshToken - The refresh token to use
 * @returns {Promise<string|null>} The new access token, or null if all attempts failed
 */
async function performTokenRefreshWithRetry(refreshToken) {
  const maxRetries = SETTINGS.authTokenRefreshRetries;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`[SupabaseAuth] Refresh attempt ${attempt}/${maxRetries}`);
    const refreshed = await refreshAccessToken(refreshToken);
    
    if (refreshed) {
      log("[SupabaseAuth] Token refreshed successfully");
      return refreshed.access_token;
    }
    
    // If this was the last attempt, give up
    if (attempt === maxRetries) {
      log("[SupabaseAuth] All refresh attempts exhausted, clearing session", "error");
      await clearSession();
      return null;
    }
    
    // Wait before retrying (exponential backoff: 1s, 2s, 4s)
    const backoffMs = 1000 * Math.pow(2, attempt - 1);
    log(`[SupabaseAuth] Refresh failed, retrying in ${backoffMs}ms...`, "warn");
    await sleep(backoffMs);
  }
  
  // Shouldn't reach here, but return null for safety
  return null;
}

/**
 * Refreshes the access token using the refresh token.
 * 
 * @param {string} refreshToken
 * @returns {Promise<{access_token: string, refresh_token: string, expires_at: number}|null>}
 */
async function refreshAccessToken(refreshToken) {
  try {
    log("[SupabaseAuth] Refreshing access token...");
    const response = await fetch(`${SETTINGS.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SETTINGS.supabaseAnonKey,
      },
      body: JSON.stringify({
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      // Log detailed error information
      let errorDetails = `status=${response.status}`;
      try {
        const errorData = await response.json();
        errorDetails += `, error=${errorData.error || "unknown"}`;
        if (errorData.error_description) {
          errorDetails += `, desc="${errorData.error_description}"`;
        }
        log(`[SupabaseAuth] Token refresh failed: ${errorDetails}`, "error");
      } catch (_) {
        log(`[SupabaseAuth] Token refresh failed: ${errorDetails}`, "error");
      }
      return null;
    }

    const data = await response.json();
    const newSession = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    };

    await setSession(newSession);
    log("[SupabaseAuth] Token refreshed successfully");
    return newSession;
  } catch (e) {
    log(`[SupabaseAuth] Token refresh network error: ${e.message || e}`, "error");
    return null;
  }
}

/**
 * Checks if the user is currently logged in to Supabase.
 * 
 * @returns {Promise<boolean>} true if logged in, false otherwise
 */
export async function isLoggedIn() {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      log("[SupabaseAuth] No valid access token, not logged in");
      return false;
    }

    // Verify token with the Unified Backend's /whoami endpoint
    const whoamiBase = await getBackendUrl("whoami");
    const whoamiUrl = `${whoamiBase}/whoami?t=${Date.now()}`;
    const resp = await fetch(whoamiUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache"
      },
    });

    log(`[SupabaseAuth] isLoggedIn check: status=${resp.status}, ok=${resp.ok}`);

    if (!resp.ok) {
      log("[SupabaseAuth] isLoggedIn: response not ok, not authenticated");
      return false;
    }

    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await resp.text();
      log(`[SupabaseAuth] isLoggedIn: Got non-JSON response (${contentType}), first 200 chars: ${text.substring(0, 200)}`);
      return false;
    }

    const data = await resp.json();
    const loggedIn = data && data.logged_in === true;
    log(`[SupabaseAuth] isLoggedIn: logged_in=${data?.logged_in}, has_subscription=${data?.has_subscription}, consent_required=${data?.consent_required}`);
    if (data?.consent) {
      log(
        `[SupabaseAuth] Consent flags: confirmed_age_18=${data?.consent?.confirmed_age_18}, agreed_to_terms=${data?.consent?.agreed_to_terms}, agreed_to_privacy=${data?.consent?.agreed_to_privacy}`
      );
    }

    return loggedIn;
  } catch (e) {
    log(`[SupabaseAuth] isLoggedIn check failed: ${e}`);
    return false;
  }
}

/**
 * Ensure the user has completed the post-signin consent gate (18+ + Terms/Privacy).
 *
 * This is primarily used by Thunderbird: the website can redirect via header.js,
 * but the add-on needs to actively check and open the consent page if required.
 *
 * @returns {Promise<boolean>} true if consent is satisfied (or not required), false if user didn't complete it in time
 */
export async function ensureConsentSatisfied() {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      log("[SupabaseAuth] ensureConsentSatisfied: No access token (not logged in)");
      return false;
    }

    const whoamiBase = await getBackendUrl("whoami");
    const whoamiUrl = `${whoamiBase}/whoami?t=${Date.now()}`;

    log(`[SupabaseAuth] ensureConsentSatisfied: Checking whoami at ${whoamiUrl}`);
    const resp = await fetch(whoamiUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache"
      }
    });

    if (!resp.ok) {
      log(`[SupabaseAuth] ensureConsentSatisfied: whoami not ok: status=${resp.status}`, "warn");
      return false;
    }

    const data = await resp.json();
    const consentRequired = data?.consent_required === true;
    log(`[SupabaseAuth] ensureConsentSatisfied: consent_required=${consentRequired}`);

    if (!consentRequired) {
      return true;
    }

    // Open consent page in a popup window. When opened with client=thunderbird,
    // the page will show a "you can close this window" message and attempt window.close().
    // We also close the popup ourselves once whoami reports consent is satisfied.
    const consentPath = data?.consent_path || "/consent.html";
    if (consentPath !== "/consent.html") {
      log(`[SupabaseAuth] Consent path differs from expected (/consent.html): ${consentPath}`, "warn");
    }
    const consentUrl = `${SETTINGS.consentPageUrl}?client=thunderbird`;
    log(`[SupabaseAuth] Opening consent popup: ${consentUrl}`);

    const consentWin = await browser.windows.create({
      url: consentUrl,
      type: "popup",
      width: SETTINGS.authWindow.defaultWidth,
      height: SETTINGS.authWindow.defaultHeight
    });
    const consentWinId = consentWin?.id;
    log(`[SupabaseAuth] Consent popup opened: windowId=${consentWinId}`);

    // Popup uses fixed dimensions now - no resize handling needed

    const timeoutMs = SETTINGS.authConsentTimeoutMs;
    const pollIntervalMs = SETTINGS.authConsentPollIntervalMs;
    const t0 = Date.now();
    let pollCount = 0;
    let result = false;

    while (Date.now() - t0 < timeoutMs) {
      await sleep(pollIntervalMs);
      pollCount++;

      // If user closed the consent window, stop waiting.
      if (consentWinId != null) {
        try {
          await browser.windows.get(consentWinId);
        } catch (e) {
          log(`[SupabaseAuth] Consent popup was closed by user (windowId=${consentWinId})`, "warn");
          result = false;
          break;
        }
      }

      const at = await getAccessToken();
      if (!at) {
        log("[SupabaseAuth] Consent poll: lost access token", "warn");
        result = false;
        break;
      }

      const checkResp = await fetch(`${whoamiBase}/whoami?t=${Date.now()}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${at}`,
          "Accept": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache"
        }
      });

      if (!checkResp.ok) {
        log(`[SupabaseAuth] Consent poll: whoami not ok: status=${checkResp.status}`, "warn");
        continue;
      }

      const checkData = await checkResp.json();
      const stillRequired = checkData?.consent_required === true;
      if (pollCount % 3 === 0) {
        log(`[SupabaseAuth] Consent poll: consent_required=${stillRequired} (poll #${pollCount})`);
      }

      if (!stillRequired) {
        log("[SupabaseAuth] Consent completed!");
        // Close consent popup (best-effort)
        if (consentWinId != null) {
          try {
            await browser.windows.remove(consentWinId);
            log("[SupabaseAuth] Closed consent popup");
          } catch (e) {
            log(`[SupabaseAuth] Failed to close consent popup (non-fatal): ${e}`, "warn");
          }
        }
        result = true;
        break;
      }
    }

    if (!result) {
      log("[SupabaseAuth] Consent not completed (timeout or interrupted)", "warn");
    }


    return result;
  } catch (e) {
    log(`[SupabaseAuth] ensureConsentSatisfied failed: ${e}`, "error");
    return false;
  }
}

/**
 * Opens Supabase OAuth in a popup window. Uses content script (stay-in-window.js)
 * to prevent external browser opens.
 * 
 * Auth flow (no host permissions needed!):
 * 1. Open signin popup → User authenticates via OAuth
 * 2. Supabase redirects to /auth/tb-callback → Page extracts session, syncs Stripe
 * 3. Callback redirects to /auth/tb-done#s=<base64-session>
 * 4. Addon reads session from tab.url (no script injection!)
 * 5. Store session and close popup
 * 
 * After timeout, shows a "timeout" page instead of closing window (better UX).
 * Popup uses fixed dimensions (no dynamic resizing).
 * 
 * @returns {Promise<boolean>} true if signed in successfully, false if user cancelled or timed out
 */
export async function ensureSignedIn() {
  const timeoutMs = SETTINGS.authSignInTimeoutMs;
  const authWindowConfig = SETTINGS.authWindow;
  let navTargetListener = null;

  try {
    log("[SupabaseAuth] Starting OAuth sign-in flow");

    // Open the signin page which shows all available providers
    // The signin page will handle provider selection and redirect to OAuth
    const signinUrl = "https://tabmail.ai/signin.html?client=thunderbird";
    log(`[SupabaseAuth] Opening signin page: ${signinUrl}`);

    // 1) Open a popup window for the signin page with initial dimensions from config
    const win = await browser.windows.create({
      url: signinUrl,
      type: "popup",
      width: authWindowConfig.defaultWidth,
      height: authWindowConfig.defaultHeight,
    });

    log(`[SupabaseAuth] Created popup window with ID: ${win.id}`);

    // Store window ID for concurrent re-auth detection
    _reAuthWindowId = win.id;

    // Get the tab from the window
    const tabs = await browser.tabs.query({ windowId: win.id, active: true });
    if (!tabs || tabs.length === 0) {
      throw new Error("Failed to get tab from popup window");
    }
    const popupTab = tabs[0];

    log(`[SupabaseAuth] Popup tab ID: ${popupTab.id}`);

    // Set up navigation target interceptor
    navTargetListener = async (details) => {
      if (details.sourceTabId === popupTab.id) {
        log(`[SupabaseAuth] ⚠️ INTERCEPTING new navigation target from popup!`);
        try {
          await browser.tabs.update(popupTab.id, { url: details.url });
          await browser.tabs.remove(details.tabId);
          log("[SupabaseAuth] Folded navigation back into popup");
        } catch (e) {
          log(`[SupabaseAuth] Failed to fold navigation back: ${e}`, "warn");
        }
      }
    };
    browser.webNavigation.onCreatedNavigationTarget.addListener(navTargetListener);

    // 3) Monitor the tab URL and extract tokens when callback page is reached
    const t0 = Date.now();
    let pollCount = 0;

    log(`[SupabaseAuth] Starting OAuth polling loop (${Math.floor(timeoutMs/1000)}s timeout)...`);

    while (true) {
      await sleep(1000);
      pollCount++;

      // Check for timeout
      if (Date.now() - t0 >= timeoutMs) {
        log("[SupabaseAuth] Sign-in timed out, showing timeout page", "warn");
        if (navTargetListener) {
          browser.webNavigation.onCreatedNavigationTarget.removeListener(navTargetListener);
        }
        try {
          const timeoutPageUrl = browser.runtime.getURL(`agent/pages/auth-timeout.html?returnUrl=${encodeURIComponent(oauthUrl)}`);
          await browser.tabs.update(popupTab.id, { url: timeoutPageUrl });
          log("[SupabaseAuth] Navigated to timeout page");
        } catch (e) {
          log(`[SupabaseAuth] Failed to navigate to timeout page: ${e}`, "warn");
          try { await browser.windows.remove(win.id); } catch(_) {}
        }
        return false;
      }

      // Check if window was closed by user
      try {
        await browser.windows.get(win.id);

        // Check if we're on the timeout page
        try {
          const tab = await browser.tabs.get(popupTab.id);
          if (tab.url && tab.url.includes('auth-timeout.html')) {
            log("[SupabaseAuth] User is on timeout page, treating as cancellation");
            if (navTargetListener) {
              browser.webNavigation.onCreatedNavigationTarget.removeListener(navTargetListener);
            }
            return false;
          }

          // Check if we've reached the TB done page (session in URL hash)
          // URL format: /auth/tb-done#s=<base64-encoded-session>
          // This approach requires NO host permissions or script injection!
          if (tab.url && tab.url.includes('tabmail.ai/auth/tb-done#s=')) {
            log(`[SupabaseAuth] Detected TB done page with session in URL`);
            
            try {
              // Parse the session from the URL hash
              const hashPart = tab.url.split('#s=')[1];
              if (!hashPart) {
                log(`[SupabaseAuth] No session data in URL hash`, "warn");
                continue;
              }

              // Decode the base64-encoded session
              const sessionJson = atob(hashPart);
              const session = JSON.parse(sessionJson);
              
              log(`[SupabaseAuth] ✓ Extracted session for user: ${session.user?.email}`);
              
              // Store the session
              await setSession({
                access_token: session.access_token,
                refresh_token: session.refresh_token,
                expires_at: session.expires_at
              });

              log(`[SupabaseAuth] ✓ Session stored successfully`);

              if (navTargetListener) {
                browser.webNavigation.onCreatedNavigationTarget.removeListener(navTargetListener);
              }

              await sleep(300);
              try { await browser.windows.remove(win.id); } catch(_) {}
              log("[SupabaseAuth] Sign-in complete, popup closed");

              // NOTE: Icon update and summary refresh are handled by background.js
              // after ensureSignedIn() returns. Do NOT sendMessage here - we're already
              // in the background context and runtime.sendMessage to self doesn't work.

              // Post-signin consent gating (opens consent page if required)
              try {
                const consentOk = await ensureConsentSatisfied();
                await browser.storage.local.set({ tabmailConsentRequired: !consentOk });
                log(`[SupabaseAuth] Consent gate result: consentOk=${consentOk}, stored tabmailConsentRequired=${!consentOk}`);
              } catch (e) {
                log(`[SupabaseAuth] Consent gating failed (non-fatal): ${e}`, "warn");
              }

              return true;
            } catch (parseError) {
              log(`[SupabaseAuth] Failed to parse session from URL: ${parseError}`, "warn");
              // Keep polling, might be a temporary issue
            }
          }
        } catch (_) {}
      } catch (_) {
        log("[SupabaseAuth] Signin window closed by user", "warn");
        if (navTargetListener) {
          browser.webNavigation.onCreatedNavigationTarget.removeListener(navTargetListener);
        }
        // Check if they authenticated before closing
        const loggedIn = await isLoggedIn();
        log(`[SupabaseAuth] After window closed, checking auth state: ${loggedIn}`);

        // NOTE: Icon update is handled by background.js after ensureSignedIn() returns.
        // Do NOT sendMessage here - we're already in the background context.

        return loggedIn;
      }

      if (pollCount % 5 === 0) {
        log(`[SupabaseAuth] Still waiting for authentication... (poll #${pollCount})`);
      }
    }
  } catch (e) {
    if (navTargetListener) {
      try {
        browser.webNavigation.onCreatedNavigationTarget.removeListener(navTargetListener);
      } catch (_) {}
    }
    log(`[SupabaseAuth] ensureSignedIn failed: ${e}`, "error");
    return false;
  }
}

/**
 * Signs out the user from Supabase by clearing the session.
 * 
 * @returns {Promise<boolean>} true if signed out successfully
 */
export async function signOut() {
  try {
    log("[SupabaseAuth] Starting sign-out process");

    // Only clear local session - don't call Supabase logout endpoint
    // This allows other sessions (e.g., web dashboard) to remain logged in
    // The token will naturally expire, or user can sign out globally from web
    await clearSession();
    log("[SupabaseAuth] Sign-out complete");

    // NOTE: Icon update is handled by background.js after signOut() returns.
    // Do NOT sendMessage here - we're already in the background context.

    return true;
  } catch (e) {
    log(`[SupabaseAuth] signOut failed: ${e}`, "error");
    return false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Track re-auth state
let _reAuthInProgress = false;
let _reAuthWindowId = null;

// Track ongoing refresh to prevent race conditions
let _refreshInProgress = null; // Will hold a Promise when refresh is in progress

/**
 * Reset auth state (called on extension startup).
 */
export function resetAuthState() {
  log("[SupabaseAuth] Resetting auth state");
  _reAuthInProgress = false;
  _reAuthWindowId = null;
  _refreshInProgress = null;
}

/**
 * Checks if an error response indicates an authentication failure.
 * 
 * @param {Response} response - Fetch response object
 * @returns {boolean} true if this looks like an auth error
 */
export function isAuthError(response) {
  return response.status === 401 || response.status === 403;
}

/**
 * Best-effort parse of backend error payload to detect structured error codes.
 * IMPORTANT: Uses response.clone() so callers can still read response body later.
 *
 * @param {Response} response
 * @returns {Promise<string|null>} e.g. "consent_required", "not_authenticated", ...
 */
async function getBackendErrorCode(response) {
  try {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return null;
    }
    const json = await response.clone().json();
    const code = json?.error;
    return typeof code === "string" ? code : null;
  } catch (e) {
    log(`[SupabaseAuth] Failed to parse backend error JSON: ${e}`, "warn");
    return null;
  }
}

/**
 * Handles authentication errors by checking auth state and optionally triggering re-auth.
 * 
 * @param {Response} response - The failed fetch response
 * @param {Object} options - Options
 * @param {boolean} [options.autoSignin=true] - Whether to automatically trigger signin
 * @param {boolean} [options.silent=false] - Whether to skip logging
 * @returns {Promise<boolean|null|"consent_required">} true if recovered, false if signin failed, null if feature is disabled, "consent_required" if user must complete consent
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
      log(`[SupabaseAuth] Failed to read authAutoReauthEnabled preference: ${e}`, "warn");
      autoSignin = SETTINGS.authAutoReauthEnabled;
    }
  }

  try {
    if (!silent) {
      log(`[SupabaseAuth] Handling potential auth error (status=${response.status})`);
    }

    // If backend explicitly says consent is required, handle it as a first-class state.
    const backendErrorCode = await getBackendErrorCode(response);
    if (backendErrorCode === "consent_required") {
      if (!silent) {
        log(`[SupabaseAuth] Backend returned consent_required`);
      }

      if (!autoSignin) {
        if (!silent) {
          log(`[SupabaseAuth] Auto-signin disabled; not opening consent page`);
        }
        return "consent_required";
      }

      const consentOk = await ensureConsentSatisfied();
      try {
        await browser.storage.local.set({ tabmailConsentRequired: !consentOk });
      } catch (e) {
        log(`[SupabaseAuth] Failed to persist tabmailConsentRequired (non-fatal): ${e}`, "warn");
      }

      if (consentOk) {
        if (!silent) {
          log(`[SupabaseAuth] Consent satisfied after consent_required error`);
        }
        return true;
      }

      if (!silent) {
        log(`[SupabaseAuth] Consent not completed; returning consent_required`);
      }
      return "consent_required";
    }

    const loggedIn = await isLoggedIn();

    if (loggedIn) {
      // User is logged in but endpoint still returned auth error
      // This means the feature requires a different subscription tier
      if (!silent) {
        log(`[SupabaseAuth] User is logged in but endpoint requires different tier - feature disabled`);
      }
      return null;
    }

    if (!silent) {
      log(`[SupabaseAuth] Confirmed user is not logged in`);
    }

    if (!autoSignin) {
      if (!silent) {
        log(`[SupabaseAuth] Auto-signin disabled, returning false`);
      }
      return false;
    }

    // Check if we're already doing a re-auth
    if (_reAuthInProgress) {
      if (!silent) {
        log(`[SupabaseAuth] Re-auth already in progress, waiting...`);
      }

      while (_reAuthInProgress) {
        await sleep(1000);

        // Safety check
        if (_reAuthWindowId !== null) {
          try {
            await browser.windows.get(_reAuthWindowId);
          } catch (_) {
            if (_reAuthInProgress) {
              log(`[SupabaseAuth] Re-auth window closed but flag still set - clearing stuck flag`, "warn");
              _reAuthInProgress = false;
              _reAuthWindowId = null;
              break;
            }
          }
        }
      }

      if (!_reAuthInProgress) {
        return await isLoggedIn();
      }
    }

    // Trigger re-authentication
    _reAuthInProgress = true;
    _reAuthWindowId = null;
    try {
      if (!silent) {
        log(`[SupabaseAuth] Triggering automatic re-authentication`);
      }

      const success = await ensureSignedIn();

      if (success) {
        if (!silent) {
          log(`[SupabaseAuth] Re-authentication successful`);
        }
      } else {
        if (!silent) {
          log(`[SupabaseAuth] Re-authentication failed or cancelled`);
        }
      }

      return success;
    } finally {
      _reAuthInProgress = false;
      _reAuthWindowId = null;
    }
  } catch (e) {
    if (!silent) {
      log(`[SupabaseAuth] handleAuthError failed: ${e}`, "error");
    }
    _reAuthInProgress = false;
    _reAuthWindowId = null;
    return false;
  }
}

