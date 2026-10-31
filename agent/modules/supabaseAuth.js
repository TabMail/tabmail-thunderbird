/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
    await storeSession(session);
    log("[SupabaseAuth] Session stored successfully");
  } catch (e) {
    log(`[SupabaseAuth] Failed to store session: ${e}`, "error");
  }
}

/**
 * Clears the stored Supabase session.
 *
 * @param {string} [from] - a refused token refresh's clear: the refresh token it started from
 */
async function clearSession(from) {
  try {
    await storeSession(null, from);
    log(from === undefined ? "[SupabaseAuth] Session cleared" : "[SupabaseAuth] Refused session cleared, unless a newer one replaced it");
  } catch (e) {
    log(`[SupabaseAuth] Failed to clear session: ${e}`, "error");
  }
}

// ─── The one session writer ─────────────────────────────────────────────

// The background page stores the session; a page (the popup, a settings page, a chat window) asks it to.
let _sessionHost = false;
// The background's session writes, one after another, so each compares against the one stored before it.
let _sessionWrites = Promise.resolve();

/** Makes this realm the one that stores the session: called by the background page at startup. */
export function initSessionHost() {
  _sessionHost = true;
}

/** The background's "store-session" runtime message handler: returns the write's promise. */
export function handleStoreSessionMessage(message) {
  return storeSession(message?.session ?? null, message?.from).then(
    () => ({ ok: true }),
    (e) => ({ ok: false, error: String(e) }),
  );
}

/** The account a session's access token was issued to (its subject), or null when it cannot be read. */
function accountOf(session) {
  try {
    const part = session.access_token.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (part.length % 4)) % 4));
    const sub = JSON.parse(json).sub;
    return typeof sub === "string" && sub !== "" ? sub : null;
  } catch (_) {
    return null;
  }
}

/** Whether two sessions are the same account. Signed out (null, or a session that could not be read) is
 * never the same as anything, so a sign-out always closes Device Sync, and so does a session whose
 * account cannot be read. */
function sameAccount(a, b) {
  if (!a || !b) return false;
  const account = accountOf(a);
  return account !== null && account === accountOf(b);
}

/**
 * Every write of the session, from every sign-in, token refresh and sign-out, in every page: the sign-in
 * is which devices this one syncs with (DS-DEVICE). When the account changes, by any path, Device Sync
 * leaves the old account's devices before the new session is stored, so nothing is sent to them or taken
 * from them after it, then connects as the new account. Nothing on the device is removed.
 *
 * The stored session is the only truth. A token refresh's write (`from`) is a compare against it: it is
 * written only while the stored session is still the one the refresh started from, so a refresh that
 * finishes after a newer sign-in or a sign-out never replaces it (#201), and one whose stored session
 * cannot be read is not written.
 * @param {{access_token: string, refresh_token: string, expires_at: number}|null} session - null signs out
 * @param {string} [from] - a token refresh's write: the refresh token it started from
 */
function storeSession(session, from) {
  if (!_sessionHost) {
    return browser.runtime.sendMessage({ command: "store-session", session, from }).then((response) => {
      if (!response?.ok) throw new Error(response?.error || "the background did not store the session");
    });
  }
  const write = _sessionWrites.then(() => switchSession(session, from));
  _sessionWrites = write.catch(() => {});
  return write;
}

async function switchSession(session, from) {
  // A read that fails is no session: a sign-in or sign-out goes ahead (signed out is never the same
  // account, so Device Sync follows); a refresh's write is not stored.
  const stored = await getSession();
  if (from !== undefined && stored?.refresh_token !== from) {
    log("[SupabaseAuth] Refresh not stored: a newer sign-in or a sign-out replaced the session it refreshed");
    return;
  }
  const write = () => (session
    ? browser.storage.local.set({ supabaseSession: session })
    : browser.storage.local.remove("supabaseSession"));
  if (sameAccount(stored, session)) return write();
  // Leaving never waits: messages still waiting from the old devices are dropped, nothing more is sent.
  const { changeAccount } = await import("./deviceSync.js");
  return changeAccount(write, !!session);
}

// A token is refreshed when it expires within this many seconds.
const REFRESH_BEFORE_EXPIRY_S = 60;

/** Whether a session's access token is expired or expires soon, so it is refreshed before use. */
function needsRefresh(session) {
  const now = Math.floor(Date.now() / 1000);
  log(`[SupabaseAuth] Token expires_at: ${session.expires_at}, now: ${now}, diff: ${session.expires_at - now}s`);
  return !!session.expires_at && session.expires_at - now < REFRESH_BEFORE_EXPIRY_S;
}

/**
 * Gets a valid access token of the session stored now, refreshing it if necessary.
 *
 * The stored session is the only answer. A refresh stores its session through a compare against the one
 * it started from and answers nothing, so after it the stored session is read again: a caller never gets
 * a token that was not stored, or one of a session a newer sign-in or a sign-out replaced (#203). Callers
 * of the same session join one refresh; each runs at most one.
 *
 * @returns {Promise<string|null>} The access token, or null if signed out or no valid session is stored
 */
export async function getAccessToken() {
  log("[SupabaseAuth] getAccessToken() called");
  const session = await getSession();
  log(`[SupabaseAuth] getSession() returned: ${session ? "session found" : "null"}`);
  if (!session) {
    log("[SupabaseAuth] No session, returning null");
    return null;
  }
  if (!needsRefresh(session)) {
    log("[SupabaseAuth] Returning existing access token");
    return session.access_token;
  }

  log("[SupabaseAuth] Token expired or expiring soon, refreshing...");
  await refreshOnce(session.refresh_token);
  const stored = await getSession();
  if (!stored || needsRefresh(stored)) {
    log("[SupabaseAuth] No valid session stored after the refresh, returning null", "warn");
    return null;
  }
  log("[SupabaseAuth] Returning the stored access token after the refresh");
  return stored.access_token;
}

/** Joins the refresh of `refreshToken`'s session under way in this realm, or starts it. Settles when it
 * is done, with nothing: its outcome is the stored session. */
function refreshOnce(refreshToken) {
  const running = _refreshes.get(refreshToken);
  if (running) {
    log("[SupabaseAuth] Refresh of this session already in progress, waiting for it...");
    return running;
  }
  log("[SupabaseAuth] Starting new refresh (no other refresh of this session in progress)");
  const refresh = performTokenRefreshWithRetry(refreshToken).finally(() => {
    if (_refreshes.get(refreshToken) === refresh) _refreshes.delete(refreshToken);
    log("[SupabaseAuth] Refresh completed, cleared in-progress entry");
  });
  _refreshes.set(refreshToken, refresh);
  return refresh;
}

/**
 * Performs token refresh with retry logic and exponential backoff. Answers nothing: a refreshed session
 * is stored through the compare, and a refused one is cleared through it.
 *
 * @param {string} refreshToken - The refresh token to use
 */
async function performTokenRefreshWithRetry(refreshToken) {
  const maxRetries = SETTINGS.authTokenRefreshRetries;
  let allTransient = true; // track whether every failure was transient (network/5xx)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`[SupabaseAuth] Refresh attempt ${attempt}/${maxRetries}`);
    const refreshed = await refreshAccessToken(refreshToken);

    if (refreshed === REFRESH_ANSWERED) return;

    if (refreshed !== REFRESH_NETWORK_ERROR) {
      // Definitive auth failure (4xx) — token is revoked/invalid
      allTransient = false;
    }

    // If this was the last attempt, give up
    if (attempt === maxRetries) {
      if (allTransient) {
        // All failures were network/5xx — token is likely still valid,
        // just can't reach the server right now. Keep the session so the
        // next getAccessToken() call can retry later.
        log("[SupabaseAuth] All refresh attempts failed due to network errors — keeping session for later retry", "warn");
      } else {
        // At least one attempt got a definitive 4xx — token is revoked.
        // Through the compare: a newer sign-in or a sign-out that replaced it while it waited stays.
        log("[SupabaseAuth] Token refresh rejected by server (4xx), clearing session", "error");
        await clearSession(refreshToken);
      }
      return;
    }

    // Wait before retrying (exponential backoff: 1s, 2s, 4s)
    const backoffMs = 1000 * Math.pow(2, attempt - 1);
    log(`[SupabaseAuth] Refresh failed, retrying in ${backoffMs}ms...`, "warn");
    await sleep(backoffMs);
  }
}

// Sentinel returned by refreshAccessToken when the failure is a network/transient
// error (as opposed to a definitive auth rejection like 400/401/403).
const REFRESH_NETWORK_ERROR = Symbol("REFRESH_NETWORK_ERROR");
// Sentinel returned by refreshAccessToken when the server answered with a new session: it was offered
// to the stored session through the compare, and is not sent again.
const REFRESH_ANSWERED = Symbol("REFRESH_ANSWERED");

/**
 * Refreshes the access token using the refresh token, and stores the new session through the compare
 * against the one it started from.
 *
 * @param {string} refreshToken
 * @returns {Promise<null|Symbol>}
 *   - REFRESH_ANSWERED when the server answered with a new session (stored, or not: the stored session says)
 *   - null on definitive auth failure (4xx — token revoked/invalid)
 *   - REFRESH_NETWORK_ERROR on transient failure (network error, 5xx)
 */
async function refreshAccessToken(refreshToken) {
  // Deadline for the whole HTTP attempt — connect, headers AND body read. It is
  // deliberately NOT cleared at response headers: a body that never arrives is
  // the same wedge as a connection that never opens (issue #55). Expiry aborts
  // the fetch itself, which lands in the catch below as a transient failure.
  const abortController = new AbortController();
  const deadline = setTimeout(() => {
    log(`[SupabaseAuth] Token refresh timed out after ${SETTINGS.authTokenRefreshTimeoutMs}ms — aborting`, "warn");
    abortController.abort();
  }, SETTINGS.authTokenRefreshTimeoutMs);
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
      signal: abortController.signal,
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
      // 4xx = definitive auth failure (token revoked/invalid) → null
      // 5xx = server-side transient error → REFRESH_NETWORK_ERROR
      if (response.status >= 500) {
        return REFRESH_NETWORK_ERROR;
      }
      return null;
    }

    const data = await response.json();
    const newSession = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    };

    try {
      await storeSession(newSession, refreshToken);
      log("[SupabaseAuth] Token refresh answered; stored unless a newer session replaced the refreshed one");
    } catch (e) {
      // Not sent again: the server has already rotated the refresh token it was sent.
      log(`[SupabaseAuth] Refreshed session not stored: ${e}`, "error");
    }
    return REFRESH_ANSWERED;
  } catch (e) {
    log(`[SupabaseAuth] Token refresh network error: ${e.message || e}`, "error");
    return REFRESH_NETWORK_ERROR;
  } finally {
    clearTimeout(deadline);
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
    // Clearing it closes Device Sync first (storeSession), as every account change does.
    await clearSession();

    // Sign-out deletes nothing (DS-DEVICE): the prompts, templates, history, settings and caches are this
    // device's, kept for whoever signs in next. Only the AI calls and Device Sync need an account.

    // The consent flag is the signed-out account's status (every sign-in sets it again), not data.
    try {
      await browser.storage.local.remove("tabmailConsentRequired");
    } catch (e) {
      log(`[SupabaseAuth] Consent flag cleanup failed (non-fatal): ${e}`, "error");
    }

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

// The refresh under way in this realm for each refresh token: callers of the same session join it.
const _refreshes = new Map();

/**
 * Reset auth state (called on extension startup).
 */
export function resetAuthState() {
  log("[SupabaseAuth] Resetting auth state");
  _reAuthInProgress = false;
  _reAuthWindowId = null;
  _refreshes.clear();
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

