import { getBackendUrl, SETTINGS } from "../agent/modules/config.js";
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";

// Popup typography: prefer native Thunderbird/system UI font stack + sizing.
// We still inject TabMail palette colors, but avoid async font-size CSS vars here to prevent flicker.
injectPaletteIntoDocument(document)
  .then(() => {
    console.log("[Popup] Palette CSS injected");
    try {
      const bodyCs = getComputedStyle(document.body);
      const btn = document.getElementById("auth-action-btn");
      const btnCs = btn ? getComputedStyle(btn) : null;
      console.log("[TMDBG PopupFont] computed", {
        body: { fontFamily: bodyCs.fontFamily, fontSize: bodyCs.fontSize },
        authActionBtn: btn
          ? { fontFamily: btnCs?.fontFamily, fontSize: btnCs?.fontSize }
          : { missing: true },
      });
    } catch (e) {
      console.warn("[TMDBG PopupFont] Failed to read computed fonts:", e);
    }
  })
  .catch((e) => {
    console.warn("[Popup] Failed to inject palette CSS:", e);
  });

// Update keyboard shortcut display based on OS using Unicode symbols
async function updateChatHotkeyDisplay() {
  try {
    const hotkeySpan = document.getElementById("chat-hotkey");
    if (!hotkeySpan) {
      console.warn("[Popup] chat-hotkey span not found");
      return;
    }

    const platformInfo = await browser.runtime.getPlatformInfo();
    const os = platformInfo?.os || "unknown";
    
    let hotkeyText;
    if (os === "mac") {
      // Mac: ⌘ (Command) + ⌥ (Option/Alt) + L
      hotkeyText = "⌘⌥L";
    } else {
      // Windows/Linux: ⌃ (Control) + ⌥ (Alt, using Option symbol for compactness) + L
      hotkeyText = "⌃⌥L";
    }
    
    hotkeySpan.textContent = hotkeyText;
    console.log(`[Popup] Chat hotkey display updated: ${hotkeyText} (OS: ${os})`);
  } catch (e) {
    console.warn(`[Popup] Failed to update chat hotkey display: ${e}`);
    // Fallback: show ⌃⌥L if detection fails
    const hotkeySpan = document.getElementById("chat-hotkey");
    if (hotkeySpan) {
      hotkeySpan.textContent = "⌃⌥L";
    }
  }
}

// Update hotkey display on popup open
updateChatHotkeyDisplay();

// Server health check state
let serverHealthy = true;

const CONSENT_URL = `${SETTINGS.consentPageUrl}?client=thunderbird`;

function showConsentWarning(show) {
  const warningDiv = document.getElementById("consent-warning");
  const btn = document.getElementById("open-consent-from-warning");
  if (!warningDiv) return;

  if (show) {
    warningDiv.style.display = "block";
    if (btn) {
      btn.onclick = async (e) => {
        e.preventDefault();
        try {
          console.log(`[Popup] Opening consent page in default browser: ${CONSENT_URL}`);
          await browser.windows.openDefaultBrowser(CONSENT_URL);
        } catch (err) {
          console.warn(`[Popup] Failed to open consent page in default browser: ${err}`);
        }
      };
    }
  } else {
    warningDiv.style.display = "none";
  }
}

/**
 * Check if the TabMail backend server is healthy
 * @returns {Promise<boolean>} - true if server is healthy, false otherwise
 */
async function checkServerHealth() {
  try {
    const backendUrl = await getBackendUrl();
    const healthEndpoint = `${backendUrl}${SETTINGS.healthCheck.endpoints.api}`;
    
    console.log(`[Health] Checking server health at: ${healthEndpoint}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SETTINGS.healthCheck.timeoutMs);
    
    const response = await fetch(healthEndpoint, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
      },
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      console.log("[Health] Server is healthy");
      return true;
    } else {
      console.warn(`[Health] Server returned status: ${response.status}`);
      return false;
    }
  } catch (e) {
    if (e.name === "AbortError") {
      console.warn(`[Health] Server health check timed out after ${SETTINGS.healthCheck.timeoutMs}ms`);
    } else {
      console.warn(`[Health] Server health check failed: ${e.message || e}`);
    }
    return false;
  }
}

/**
 * Show or hide the server status warning banner
 * @param {boolean} show - Whether to show the warning
 */
function showServerStatusWarning(show) {
  const warningDiv = document.getElementById("server-status-warning");
  const statusLink = document.getElementById("server-status-link");
  
  if (!warningDiv) return;
  
  if (show) {
    warningDiv.style.display = "block";
    
    // Set the status page link
    if (statusLink) {
      statusLink.href = SETTINGS.statusPageUrl;
      statusLink.onclick = (e) => {
        e.preventDefault();
        browser.tabs.create({ url: SETTINGS.statusPageUrl });
      };
    }
    
    console.log("[Health] Server status warning shown");
  } else {
    warningDiv.style.display = "none";
    console.log("[Health] Server status warning hidden");
  }
  
  serverHealthy = !show;
}

// Initial health check on popup open
(async () => {
  const healthy = await checkServerHealth();
  showServerStatusWarning(!healthy);
})();

// Quota usage display will be updated after whoami check

// Update subscription status display
// NOTE: Cancellation and downgrade are now shown in the reset label (updateQuotaDisplay)
// This function is kept for backwards compatibility but statusEl is always hidden
function updateSubscriptionStatus(statusEl, whoamiData) {
  if (!statusEl) {
    return;
  }
  
  // Always hide - cancellation/downgrade now shown in reset label
  statusEl.style.display = "none";
  statusEl.textContent = "";
}

// Check if debug mode is enabled and show indicator
// Uses actual backend URL as sanity check rather than checking the flag
async function updateDebugModeIndicator() {
  try {
    const debugIndicator = document.getElementById("debug-mode-indicator");
    // Get base domain for display (no endpoint type)
    const currentBackendUrl = await getBackendUrl();
    
    console.log(`[Popup] Checking debug mode - currentBackendUrl: ${currentBackendUrl}, devBase: ${SETTINGS.backendBaseDev}, prodBase: ${SETTINGS.backendBaseProd}`);
    
    if (debugIndicator) {
      // Show indicator if we're using the dev backend
      // Path-based routing: dev.tabmail.ai instead of -dev subdomain
      const isDebugMode = currentBackendUrl.includes(`${SETTINGS.backendBaseDev}.${SETTINGS.backendDomain}`);
      console.log(`[Popup] Debug mode indicator should be: ${isDebugMode ? 'visible' : 'hidden'}`);
      debugIndicator.style.display = isDebugMode ? "block" : "none";
    }
  } catch (e) {
    console.warn("[Popup] Failed to check debug mode status:", e);
  }
}

// Update debug mode indicator on popup open
updateDebugModeIndicator();

// Setup configuration checks
async function checkPlaintextComposition() {
  try {
    if (!browser.tmPrefs) {
      return { configured: false, reason: "tmPrefs API not available" };
    }

    const accounts = await browser.accounts.list();
    const problematicIdentities = [];

    for (const account of accounts) {
      if (!account.identities || account.identities.length === 0) continue;

      for (const identity of account.identities) {
        const identityId = identity.id;
        const prefName = `mail.identity.${identityId}.compose_html`;
        
        try {
          // Default to true (HTML) if pref doesn't exist, as that's Thunderbird's default
          const composeHtml = await browser.tmPrefs.getBoolSafe(prefName, true);
          const identityName = identity.name || identity.email || `Identity ${identityId}`;
          
          console.log(`[Popup] Identity ${identityId} (${identityName}): compose_html = ${composeHtml}`);
          
          if (composeHtml === true) {
            problematicIdentities.push(identityName);
          }
        } catch (e) {
          // If we can't read, assume HTML (Thunderbird's default) - flag as problematic
          const identityName = identity.name || identity.email || `Identity ${identityId}`;
          console.warn(`[Popup] Failed to read compose_html for identity ${identityId}:`, e);
          problematicIdentities.push(identityName);
        }
      }
    }

    return {
      configured: problematicIdentities.length === 0,
      problematicIdentities,
    };
  } catch (e) {
    console.warn("[Popup] Failed to check plaintext composition:", e);
    return { configured: false, reason: e.message || String(e) };
  }
}

async function checkDefaultCalendar() {
  try {
    const { defaultCalendarId } = await browser.storage.local.get({ defaultCalendarId: null });
    
    // Auto-detection is done on addon startup in background.js
    // Here we just check if a default is set
    return {
      configured: defaultCalendarId !== null && defaultCalendarId !== "",
    };
  } catch (e) {
    console.warn("[Popup] Failed to check default calendar:", e);
    return { configured: false, reason: e.message || String(e) };
  }
}

async function checkDefaultAddressBook() {
  try {
    const { defaultAddressBookId } = await browser.storage.local.get({ defaultAddressBookId: null });
    
    // Don't auto-select address books - we can't reliably match them to accounts
    // Let the user configure this manually in settings
    
    return {
      configured: defaultAddressBookId !== null && defaultAddressBookId !== "",
    };
  } catch (e) {
    console.warn("[Popup] Failed to check default address book:", e);
    return { configured: false, reason: e.message || String(e) };
  }
}

async function checkSetupConfiguration() {
  const [plaintextCheck, calendarCheck, addressBookCheck] = await Promise.all([
    checkPlaintextComposition(),
    checkDefaultCalendar(),
    checkDefaultAddressBook(),
  ]);

  const issues = [];
  
  if (!plaintextCheck.configured) {
    if (plaintextCheck.problematicIdentities && plaintextCheck.problematicIdentities.length > 0) {
      issues.push(`Plaintext composition not set for: ${plaintextCheck.problematicIdentities.join(", ")}`);
    } else {
      issues.push("Plaintext composition not configured for all email identities");
    }
  }

  if (!calendarCheck.configured) {
    issues.push("Default calendar not set");
  }

  if (!addressBookCheck.configured) {
    issues.push("Default address book not set");
  }

  return {
    allConfigured: issues.length === 0,
    issues,
    details: {
      plaintext: plaintextCheck,
      calendar: calendarCheck,
      addressBook: addressBookCheck,
    },
  };
}

/**
 * Forces all identities to use plaintext composition.
 * @returns {Promise<{success: number, failed: number, total: number}>}
 */
async function forceAllIdentitiesPlaintext() {
  let success = 0;
  let failed = 0;
  let total = 0;
  
  try {
    if (!browser.tmPrefs) {
      console.warn("[Popup] forceAllIdentitiesPlaintext: tmPrefs API not available");
      return { success: 0, failed: 0, total: 0 };
    }
    
    const accounts = await browser.accounts.list();
    
    for (const account of accounts) {
      if (!account.identities || account.identities.length === 0) continue;
      
      for (const identity of account.identities) {
        total++;
        const identityId = identity.id;
        
        try {
          const prefName = `mail.identity.${identityId}.compose_html`;
          // Set to false to force plaintext (false = plaintext, true = HTML)
          await browser.tmPrefs.setBool(prefName, false);
          success++;
          console.log(`[Popup] Set identity ${identityId} to plaintext mode`);
        } catch (e) {
          failed++;
          console.warn(`[Popup] Failed to set plaintext for identity ${identityId}:`, e);
        }
      }
    }
    
    console.log(`[Popup] Plaintext enforcement complete: ${success}/${total} identities`);
    return { success, failed, total };
  } catch (e) {
    console.error(`[Popup] forceAllIdentitiesPlaintext failed:`, e);
    return { success, failed, total };
  }
}

async function updateSetupWarning() {
  const warningDiv = document.getElementById("setup-warning");
  const warningItems = document.getElementById("setup-warning-items");
  const chatButton = document.getElementById("open-chat-window");

  if (!warningDiv || !warningItems) return;

  try {
    const setupStatus = await checkSetupConfiguration();

    if (!setupStatus.allConfigured) {
      // Show warning
      warningDiv.style.display = "block";
      
      // Build issue list with inline fix buttons where applicable
      let issueHtml = `<div style="margin-bottom: 8px;">Please configure the following before using TabMail:</div>`;
      
      for (const issue of setupStatus.issues) {
        if (issue.includes("Plaintext")) {
          // Add a "Fix" link for plaintext issues
          issueHtml += `<div style="margin: 4px 0;">• ${issue} <a href="#" id="fix-plaintext-link" style="color: var(--in-content-accent-color); text-decoration: underline; cursor: pointer; margin-left: 4px;">[Click to fix]</a></div>`;
        } else {
          issueHtml += `<div style="margin: 4px 0;">• ${issue}</div>`;
        }
      }
      
      warningItems.innerHTML = issueHtml;
      
      // Disable chat button
      if (chatButton) {
        chatButton.disabled = true;
        chatButton.style.opacity = "0.5";
        chatButton.style.cursor = "not-allowed";
        chatButton.title = "Please complete initial setup first";
      }
    } else {
      // Hide warning
      warningDiv.style.display = "none";
      
      // Enable chat button
      if (chatButton) {
        chatButton.disabled = false;
        chatButton.style.opacity = "1";
        chatButton.style.cursor = "pointer";
        chatButton.title = "";
      }
    }
  } catch (e) {
    console.error("[Popup] Failed to update setup warning:", e);
    // On error, don't block the user
    warningDiv.style.display = "none";
    if (chatButton) {
      chatButton.disabled = false;
      chatButton.style.opacity = "1";
      chatButton.style.cursor = "pointer";
    }
  }
}

// Update setup warning on popup open
updateSetupWarning();

// Update quota usage display based on whoami data
function updateQuotaDisplay(whoamiData) {
  const progressBar = document.getElementById("usage-bar");
  const usageLabel = document.getElementById("usage-label");
  const resetLabel = document.getElementById("usage-reset");
  const subscriptionStatus = document.getElementById("subscription-status");
  
  if (!progressBar || !usageLabel || !resetLabel) return;
  
  // Update subscription status (cancel/downgrade schedule)
  if (subscriptionStatus) {
    updateSubscriptionStatus(subscriptionStatus, whoamiData);
  }
  
  if (!whoamiData || !whoamiData.logged_in || !whoamiData.has_subscription) {
    // Not logged in or no subscription - show placeholder (always two lines)
    progressBar.value = 0;
    usageLabel.textContent = "Monthly usage: N/A";
    usageLabel.style.color = "";
    resetLabel.textContent = "Resets N/A";
    return;
  }
  
  const quotaPercentage = whoamiData.quota_percentage ?? 0;
  const queueMode = whoamiData.queue_mode ?? null;
  const billingPeriodEnd = whoamiData.billing_period_end ?? null;
  
  console.log(`[Quota] Received from whoami - percentage: ${quotaPercentage}, mode: ${queueMode}, billing_period_end: ${billingPeriodEnd}`);
  
  // Update progress bar
  progressBar.value = quotaPercentage;
  
  // Format reset/cancel/downgrade date text
  // Priority: cancellation > downgrade > reset date
  const pendingCancellation = whoamiData.pending_cancellation;
  const pendingDowngrade = whoamiData.pending_downgrade;
  
  let resetText = "Resets N/A";
  let resetColor = "";
  
  if (pendingCancellation && pendingCancellation.cancel_at) {
    // Show cancellation instead of reset
    const cancelDate = new Date(pendingCancellation.cancel_at * 1000);
    const year = cancelDate.getFullYear();
    const month = String(cancelDate.getMonth() + 1).padStart(2, '0');
    const day = String(cancelDate.getDate()).padStart(2, '0');
    resetText = `Cancels ${year}/${month}/${day}`;
    resetColor = "var(--tag-tm-delete)";
    console.log(`[Quota] Showing cancellation in reset label: ${resetText}`);
  } else if (pendingDowngrade && pendingDowngrade.effective_at) {
    // Show downgrade instead of reset
    const downgradeDate = new Date(pendingDowngrade.effective_at * 1000);
    const year = downgradeDate.getFullYear();
    const month = String(downgradeDate.getMonth() + 1).padStart(2, '0');
    const day = String(downgradeDate.getDate()).padStart(2, '0');
    const toPlan = pendingDowngrade.to_plan || "Basic";
    resetText = `→ ${toPlan} ${year}/${month}/${day}`;
    resetColor = "var(--tag-tm-delete)";
    console.log(`[Quota] Showing downgrade in reset label: ${resetText}`);
  } else if (billingPeriodEnd) {
    const resetDate = new Date(billingPeriodEnd * 1000);
    const year = resetDate.getFullYear();
    const month = String(resetDate.getMonth() + 1).padStart(2, '0');
    const day = String(resetDate.getDate()).padStart(2, '0');
    resetText = `Resets ${year}/${month}/${day}`;
    console.log(`[Quota] Reset date formatted: ${resetText}, from timestamp: ${billingPeriodEnd}`);
  } else {
    console.log(`[Quota] No billing_period_end available, showing Resets N/A`);
  }
  
  // Update usage label with queue mode indicator
  let queueIndicator = "";
  if (queueMode === "fast") {
    queueIndicator = " (Fast)";
  } else if (queueMode === "slow") {
    queueIndicator = " (Slow)";
  } else if (queueMode === "blocked") {
    queueIndicator = " (Blocked)";
  }
  
  // IMPORTANT: "Monthly usage" quota is an internal cost cap (max_monthly_cost_cents) determined by the backend.
  // It is NOT the Stripe plan price.
  usageLabel.textContent = `${quotaPercentage}% of monthly quota${queueIndicator}`;
  resetLabel.textContent = resetText;
  resetLabel.style.color = resetColor;
  resetLabel.style.fontWeight = resetColor ? "500" : "";
  
  // Color warnings based on quota usage
  if (quotaPercentage >= 100) {
    usageLabel.style.color = "red";
  } else if (quotaPercentage >= 80) {
    usageLabel.style.color = "orange";
  } else {
    usageLabel.style.color = "";
  }
  
  console.log(`[Quota] Updated display: ${quotaPercentage}% (${queueMode}), resets: ${resetText}`);
}

// Check authentication status and update UI
async function updateAuthStatus() {
  const statusText = document.getElementById("auth-status-text");
  const actionBtn = document.getElementById("auth-action-btn");
  
  // Show button but disable it while checking
  if (actionBtn) {
    actionBtn.style.display = "block";
    actionBtn.disabled = true;
    actionBtn.textContent = "Sign out";
  }
  
  try {
    // Get Supabase access token
    console.log("[Auth] Importing supabaseAuth module...");
    const { getAccessToken } = await import("../agent/modules/supabaseAuth.js");
    console.log("[Auth] Module imported, calling getAccessToken()...");
    const accessToken = await getAccessToken();
    console.log("[Auth] getAccessToken() returned:", accessToken ? "token found" : "null");
    
    if (!accessToken) {
      // Not authenticated - but first check if it's because of maintenance mode
      console.log("[Auth] No access token, checking maintenance mode...");
      
      // Check maintenance mode
      let inMaintenance = false;
      try {
        const { isMaintenanceMode } = await import("../agent/modules/accessAuth.js");
        inMaintenance = await isMaintenanceMode();
      } catch (e) {
        console.log(`[Auth] Maintenance check failed: ${e}`);
      }
      
      if (inMaintenance) {
        console.log("[Auth] API in maintenance mode");
        statusText.textContent = "Under Maintenance";
        statusText.className = "maintenance";
        actionBtn.style.display = "block";
        actionBtn.textContent = "Check Status";
        actionBtn.dataset.action = "check-status";
        actionBtn.disabled = false;
        
        // Clear quota display
        updateQuotaDisplay(null);
        showConsentWarning(false);
        return;
      }
      
      // Normal "not logged in" state
      statusText.textContent = "Not logged in";
      statusText.className = "logged-out";
      actionBtn.style.display = "block";
      actionBtn.textContent = "Sign in";
      actionBtn.dataset.action = "signin";
      actionBtn.disabled = false;
      console.log("[Auth] No access token, not logged in");
      
      // Clear quota display
      updateQuotaDisplay(null);

      // No auth → no consent warning
      showConsentWarning(false);
      
      // Notify background script to update icon
      try {
        await browser.runtime.sendMessage({ 
          command: "update-icon-auth-state",
          authState: false 
        });
      } catch (e) {
        console.log(`[Auth] Failed to notify background script to update icon: ${e}`);
      }
      return;
    }

    // Call /whoami with Bearer token
    const whoamiBase = await getBackendUrl("whoami");
    const resp = await fetch(`${whoamiBase}/whoami?t=${Date.now()}`, {
      method: "GET",
      headers: { 
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache"
      },
    });
    
    console.log(`[Auth] /whoami response status: ${resp.status}`);
    
    // Check for maintenance mode (503)
    if (resp.status === 503) {
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        try {
          const errorData = await resp.json();
          if (errorData.error === "maintenance") {
            console.log("[Auth] API in maintenance mode");
            statusText.textContent = "Under Maintenance";
            statusText.className = "maintenance";
            actionBtn.style.display = "block";
            actionBtn.textContent = "Check Status";
            actionBtn.dataset.action = "check-status";
            actionBtn.disabled = false;
            
            // Clear quota display
            updateQuotaDisplay(null);
            return;
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
    
    // Check if response is JSON
    const contentType = resp.headers.get("content-type") || "";
    if (!resp.ok || !contentType.includes("application/json")) {
      // Not authenticated or invalid response
      statusText.textContent = "Not logged in";
      statusText.className = "logged-out";
      actionBtn.style.display = "block";
      actionBtn.textContent = "Sign in";
      actionBtn.dataset.action = "signin";
      actionBtn.disabled = false;
      console.log("[Auth] Not logged in");
      
      // Clear quota display
      updateQuotaDisplay(null);
      
      // Notify background script to update icon
      try {
        await browser.runtime.sendMessage({ 
          command: "update-icon-auth-state",
          authState: false 
        });
      } catch (e) {
        console.log(`[Auth] Failed to notify background script to update icon: ${e}`);
      }
      return;
    }
    
    const data = await resp.json();
    console.log(`[Auth] /whoami response data:`, data);
    console.log(`[Auth] /whoami pending_cancellation:`, data.pending_cancellation);
    console.log(`[Auth] /whoami pending_downgrade:`, data.pending_downgrade);
    
    // Check if authenticated (new Supabase format: logged_in, has_subscription, etc.)
    const loggedIn = data.logged_in === true;
    const email = data.email || data.user || "";
    console.log(`[Auth] updateAuthStatus: loggedIn=${loggedIn}, email=${email || "null"}`);
    
    if (loggedIn) {
      let emailTrimmed = email.trim();
      
      let name = data.name || "";
      name = name.trim();
      
      let displayText = "";
      if (name && emailTrimmed) {
        // Show name with email
        displayText = `${name} (${emailTrimmed})`;
      } else if (name) {
        // Show just name
        displayText = name;
      } else if (emailTrimmed) {
        // Show just email
        displayText = emailTrimmed;
      } else {
        // Fallback
        displayText = "authenticated user";
      }
      
      statusText.textContent = displayText;
      statusText.className = "logged-in";
      actionBtn.style.display = "block";
      actionBtn.textContent = "Sign out";
      actionBtn.dataset.action = "signout";
      actionBtn.disabled = false;
      console.log(`[Auth] Logged in as ${displayText}`);
      
      // Update quota usage display
      updateQuotaDisplay(data);

      // Consent gating banner (if required)
      const consentRequired = data?.consent_required === true;
      console.log(`[Auth] Consent required: ${consentRequired}`);
      showConsentWarning(consentRequired);
      try {
        await browser.storage.local.set({ tabmailConsentRequired: consentRequired });
      } catch (e) {
        console.warn(`[Auth] Failed to persist tabmailConsentRequired (non-fatal): ${e}`);
      }
      
      // Update SSE timeout configuration from server
      if (data.sse_max_timeout_sec !== undefined) {
        console.log(`[Auth] Server SSE max timeout: ${data.sse_max_timeout_sec}s`);
        SETTINGS.sseMaxTimeoutSec = data.sse_max_timeout_sec;
      }
      if (data.sse_tool_listen_timeout_sec !== undefined) {
        console.log(`[Auth] Server SSE tool listen timeout: ${data.sse_tool_listen_timeout_sec}s`);
        SETTINGS.sseToolListenTimeoutSec = data.sse_tool_listen_timeout_sec;
      }
    } else {
      statusText.textContent = "Not logged in";
      statusText.className = "logged-out";
      actionBtn.style.display = "block";
      actionBtn.textContent = "Sign in";
      actionBtn.dataset.action = "signin";
      actionBtn.disabled = false;
      console.log("[Auth] Not logged in");
      
      // Clear quota display for non-logged-in users
      updateQuotaDisplay(null);

      showConsentWarning(false);
    }
    
    // Notify background script to update icon with auth state to avoid redundant /whoami call
    try {
      await browser.runtime.sendMessage({ 
        command: "update-icon-auth-state",
        authState: loggedIn 
      });
    } catch (e) {
      console.log(`[Auth] Failed to notify background script to update icon: ${e}`);
    }
  } catch (e) {
    statusText.textContent = "Signin check failed";
    statusText.className = "logged-out";
    actionBtn.style.display = "block";
    actionBtn.textContent = "Sign in";
    actionBtn.dataset.action = "signin";
    actionBtn.disabled = false;
    console.error(`[Auth] Failed to check signin status: ${e}`);
    
    // Clear quota display
    updateQuotaDisplay(null);
    
    // If there was a network/connection error, check server health
    // This helps distinguish between auth issues and server outages
    const errorMsg = e.message || String(e);
    const isNetworkError = errorMsg.includes("fetch") || 
                           errorMsg.includes("network") || 
                           errorMsg.includes("Failed to fetch") ||
                           errorMsg.includes("NetworkError") ||
                           errorMsg.includes("CORS") ||
                           errorMsg.includes("timeout");
    
    if (isNetworkError) {
      console.log("[Auth] Network error detected, checking server health...");
      const healthy = await checkServerHealth();
      showServerStatusWarning(!healthy);
    }
    
    // Notify background script to update icon (assume not logged in on error)
    try {
      await browser.runtime.sendMessage({ 
        command: "update-icon-auth-state",
        authState: false 
      });
    } catch (e) {
      console.log(`[Auth] Failed to notify background script to update icon: ${e}`);
    }
  }
}

// Handle auth button click
async function handleAuthAction() {
  const statusText = document.getElementById("auth-status-text");
  const actionBtn = document.getElementById("auth-action-btn");
  const action = actionBtn.dataset.action;
  
  actionBtn.disabled = true;
  
  if (action === "signout") {
    // Handle sign-out - delegate to background script
    statusText.textContent = "Signing out...";
    statusText.className = "";
    
    try {
      console.log("[Auth] Requesting sign-out from background script");
      // Send message to background script to handle sign-out
      // The storage listener will automatically refresh the UI when sign-out completes
      await browser.runtime.sendMessage({ command: "start-signout" });
      console.log("[Auth] Sign-out request sent to background");
    } catch (e) {
      statusText.textContent = "Sign-out failed";
      statusText.className = "logged-in";
      actionBtn.disabled = false;
      console.error(`[Auth] Failed to send sign-out request: ${e}`);
    }
  } else if (action === "check-status") {
    // Handle check status - open status page in default browser
    try {
      console.log("[Auth] Opening status page in default browser");
      await browser.windows.openDefaultBrowser("https://tabmail.ai/status.html");
      actionBtn.disabled = false;
    } catch (e) {
      console.error(`[Auth] Failed to open status page: ${e}`);
      actionBtn.disabled = false;
    }
  } else {
    // Handle sign-in - delegate to background script
    statusText.textContent = "Opening signin window...";
    statusText.className = "";
    
    try {
      console.log("[Auth] Requesting sign-in from background script");
      // Send message to background script to handle sign-in
      // The storage listener will automatically refresh the UI when sign-in completes
      await browser.runtime.sendMessage({ command: "start-signin" });
      console.log("[Auth] Sign-in request sent to background");
    } catch (e) {
      statusText.textContent = "Sign-in failed";
      statusText.className = "logged-out";
      actionBtn.disabled = false;
      console.error(`[Auth] Failed to send sign-in request: ${e}`);
    }
  }
}

// Initialize auth status on popup open
updateAuthStatus();

// Listen for auth state changes (e.g., sign-out from background)
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.supabaseSession) {
    console.log("[Popup] Supabase session changed, refreshing auth status");
    updateAuthStatus();
  }
});

// Initialize auto-reauth checkbox
async function updateAutoReauthCheckbox() {
  const checkbox = document.getElementById("auto-reauth-checkbox");
  if (!checkbox) return;
  
  try {
    const { authAutoReauthEnabled } = await browser.storage.local.get({ 
      authAutoReauthEnabled: true // default
    });
    checkbox.checked = authAutoReauthEnabled;
    console.log(`[Auth] Auto-reauth checkbox initialized: ${authAutoReauthEnabled}`);
  } catch (e) {
    console.error(`[Auth] Failed to load auto-reauth preference: ${e}`);
  }
}

updateAutoReauthCheckbox();

// FTS Status Banner Management
async function updateFtsScanStatus() {
  const banner = document.getElementById("fts-status-banner");
  const statusText = document.getElementById("fts-status-text");
  const progressText = document.getElementById("fts-status-progress");
  
  try {
    const status = await browser.runtime.sendMessage({ command: "getFtsScanStatus" });
    
    if (status.isScanning) {
      // Show scanning status
      statusText.className = "scanning";
      
      if (status.scanType === "initial") {
        statusText.textContent = "📊 Initial indexing";
        if (status.progress) {
          progressText.textContent = `${status.progress.totalIndexed || 0} messages`;
        } else {
          progressText.textContent = "Starting...";
        }
      } else if (status.scanType === "reindex") {
        statusText.textContent = "📊 Full reindex";
        if (status.progress) {
          progressText.textContent = `${status.progress.totalIndexed || 0} messages`;
        } else {
          progressText.textContent = "Starting...";
        }
      } else if (status.scanType === "smart") {
        statusText.textContent = "📊 Smart reindex";
        if (status.progress) {
          progressText.textContent = `${status.progress.totalIndexed || 0} messages`;
        } else {
          progressText.textContent = "Starting...";
        }
      } else if (status.scanType === "maintenance") {
        statusText.textContent = `📊 Maintenance (${status.maintenanceType || "sync"})`;
        if (status.progress) {
          progressText.textContent = `${status.progress.totalIndexed || 0} checked`;
        } else {
          progressText.textContent = "Scanning...";
        }
      } else {
        statusText.textContent = "📊 Indexing";
        progressText.textContent = "";
      }
    } else if (!status.initialComplete) {
      // Initial scan not complete but not currently running
      statusText.className = "scanning";
      statusText.textContent = "⏳ Initial indexing pending";
      progressText.textContent = "Will start automatically";
    } else {
      // All scans complete - show up to date status
      statusText.className = "uptodate";
      statusText.textContent = "✓ Email indexing up to date";
      progressText.textContent = "";
    }
  } catch (e) {
    console.error(`[Popup] Failed to get FTS scan status: ${e}`);
    // Show error state instead of hiding
    statusText.className = "uptodate";
    statusText.textContent = "Index status unavailable";
    progressText.textContent = "";
  }
}

// Update FTS status on popup open
updateFtsScanStatus();

// Poll for FTS status updates every 2 seconds while popup is open
const ftsStatusInterval = setInterval(updateFtsScanStatus, 2000);

// Clean up interval when popup closes
window.addEventListener("beforeunload", () => {
  if (ftsStatusInterval) {
    clearInterval(ftsStatusInterval);
  }
});

// =============================================================================
// VERSION STATUS BANNER
// =============================================================================
// Shows current version or "Restart Thunderbird to update to vX.Y.Z" if update pending

async function updateVersionStatus() {
  const versionBanner = document.getElementById("version-status-banner");
  const versionText = document.getElementById("version-text");
  const checkUpdatesLink = document.getElementById("check-updates-link");
  
  if (!versionBanner || !versionText) {
    console.warn("[Popup] Version status elements not found");
    return;
  }
  
  try {
    // Get update state from background
    const state = await browser.runtime.sendMessage({ command: "getUpdateState" });
    console.log("[Popup] Update state:", state);
    
    if (state.updateState === "pending" && state.pendingVersion) {
      // Update is pending - show clickable restart message
      versionText.textContent = `Restart Thunderbird to update to v${state.pendingVersion}`;
      versionText.className = "update-available";
      versionText.onclick = async () => {
        console.log("[Popup] User clicked restart from version banner");
        versionText.textContent = "Restarting Thunderbird...";
        versionText.onclick = null;
        try {
          await browser.runtime.sendMessage({ command: "restartForUpdate" });
        } catch (e) {
          console.error("[Popup] Failed to send restart request:", e);
          versionText.textContent = "Restart failed - please restart Thunderbird manually";
        }
      };
      // Hide check for updates when update is already pending
      if (checkUpdatesLink) {
        checkUpdatesLink.classList.add("hidden");
      }
    } else {
      // No pending update - show current version
      versionText.textContent = `v${state.currentVersion}`;
      versionText.className = "";
      versionText.onclick = null;
      // Show check for updates link
      if (checkUpdatesLink) {
        checkUpdatesLink.classList.remove("hidden");
      }
    }
  } catch (e) {
    console.error("[Popup] Failed to get update state:", e);
    // Fallback: show current version from manifest
    try {
      const manifest = browser.runtime.getManifest();
      versionText.textContent = `v${manifest.version}`;
      versionText.className = "";
    } catch (e2) {
      versionText.textContent = "";
    }
  }
}

/**
 * Handle manual check for updates
 */
async function handleCheckForUpdates() {
  const checkUpdatesLink = document.getElementById("check-updates-link");
  const versionText = document.getElementById("version-text");
  
  if (!checkUpdatesLink) return;
  
  // Prevent double-clicking
  if (checkUpdatesLink.classList.contains("checking")) {
    return;
  }
  
  const originalText = checkUpdatesLink.textContent;
  checkUpdatesLink.textContent = "Checking...";
  checkUpdatesLink.classList.add("checking");
  
  console.log("[Popup] Manually checking for addon updates...");
  
  try {
    // Check if the tmUpdates experiment is available
    if (!browser.tmUpdates?.checkForUpdates) {
      console.error("[Popup] tmUpdates.checkForUpdates not available");
      checkUpdatesLink.textContent = "Not available";
      checkUpdatesLink.classList.remove("checking");
      setTimeout(() => {
        if (checkUpdatesLink) {
          checkUpdatesLink.textContent = originalText;
        }
      }, 2000);
      return;
    }
    
    // Use the tmUpdates experiment API to check for updates
    const result = await browser.tmUpdates.checkForUpdates();
    console.log("[Popup] Update check result:", result);
    
    if (result.status === "update_available") {
      console.log("[Popup] Update available:", result.version);
      // Hide the check link and show the restart message on version text
      checkUpdatesLink.classList.add("hidden");
      checkUpdatesLink.classList.remove("checking");
      
      // Notify background about the pending update (for state consistency)
      // This also shows the notification bar immediately
      try {
        await browser.runtime.sendMessage({ 
          command: "setPendingUpdate", 
          version: result.version 
        });
        console.log("[Popup] Notified background about pending update");
      } catch (e) {
        console.warn("[Popup] Failed to notify background about update:", e);
      }
      
      // Update version text to show clickable restart message
      if (versionText) {
        versionText.textContent = `Restart Thunderbird to update to v${result.version}`;
        versionText.className = "update-available";
        versionText.onclick = async () => {
          console.log("[Popup] User clicked restart from version banner (after check)");
          versionText.textContent = "Restarting Thunderbird...";
          versionText.onclick = null;
          try {
            await browser.runtime.sendMessage({ command: "restartForUpdate" });
          } catch (e) {
            console.error("[Popup] Failed to send restart request:", e);
            versionText.textContent = "Restart failed - please restart Thunderbird manually";
          }
        };
      }
    } else if (result.status === "no_update") {
      checkUpdatesLink.textContent = "Up to date!";
      checkUpdatesLink.classList.remove("checking");
      console.log("[Popup] No update available, current version:", result.currentVersion);
      // Reset text after a delay
      setTimeout(() => {
        if (checkUpdatesLink) {
          checkUpdatesLink.textContent = originalText;
        }
      }, 2000);
    } else if (result.status === "error") {
      console.error("[Popup] Update check error:", result.error);
      checkUpdatesLink.textContent = "Check failed";
      checkUpdatesLink.classList.remove("checking");
      setTimeout(() => {
        if (checkUpdatesLink) {
          checkUpdatesLink.textContent = originalText;
        }
      }, 2000);
    } else {
      // Unknown status
      checkUpdatesLink.textContent = originalText;
      checkUpdatesLink.classList.remove("checking");
      console.log("[Popup] Unknown update check status:", result.status);
    }
  } catch (e) {
    console.error("[Popup] Failed to check for updates:", e);
    checkUpdatesLink.textContent = "Check failed";
    checkUpdatesLink.classList.remove("checking");
    setTimeout(() => {
      if (checkUpdatesLink) {
        checkUpdatesLink.textContent = originalText;
      }
    }, 2000);
  }
}

// Update version status on popup open
updateVersionStatus();

// Store listener reference for cleanup - using global to persist outside import scope
if (!window.__popupClickListener) {
  window.__popupClickListener = async (e) => {
    if (e.target.id === "auth-action-btn") {
      await handleAuthAction();
    }

    if (e.target.id === "open-chat-window") {
      e.preventDefault();
      // Check setup before allowing chat
      const setupStatus = await checkSetupConfiguration();
      if (!setupStatus.allConfigured) {
        document.getElementById("status").textContent = "Please complete initial setup first (see warning above)";
        return;
      }

      try {
        await browser.runtime.sendMessage({ command: "open-chat-window" });
        window.close();
      } catch (error) {
        document.getElementById("status").textContent = `Error: ${error.message}`;
        console.error(error);
      }
    }

    if (e.target.id === "auto-reauth-checkbox") {
      // Handle auto-reauth checkbox toggle
      const checkbox = e.target;
      try {
        await browser.storage.local.set({ authAutoReauthEnabled: checkbox.checked });
        console.log(`[Auth] Auto-reauth preference saved: ${checkbox.checked}`);
      } catch (error) {
        console.error(`[Auth] Failed to save auto-reauth preference: ${error}`);
        // Revert checkbox on error
        checkbox.checked = !checkbox.checked;
      }
      return;
    }

    if (e.target.id === "fix-plaintext-link") {
      e.preventDefault();
      const link = e.target;
      
      try {
        link.textContent = "[Fixing...]";
        link.style.pointerEvents = "none";
        
        const result = await forceAllIdentitiesPlaintext();
        
        if (result.success > 0) {
          link.textContent = `[Fixed ${result.success} identities!]`;
          link.style.color = "green";
          
          // Refresh the setup warning after a short delay
          setTimeout(async () => {
            await updateSetupWarning();
          }, 500);
        } else if (result.total === 0) {
          link.textContent = "[No identities found]";
        } else {
          link.textContent = "[Fix failed]";
          link.style.color = "red";
        }
      } catch (error) {
        console.error("[Popup] Fix plaintext failed:", error);
        link.textContent = "[Fix failed]";
        link.style.color = "red";
      }
      return;
    }

    if (e.target.id === "open-configs" || e.target.id === "open-configs-from-warning") {
      e.preventDefault();
      try {
        const url = browser.runtime.getURL("config/config.html");
        
        // Check if config tab is already open
        const existingTabs = await browser.tabs.query({ url });
        
        if (existingTabs.length > 0) {
          // Focus existing config tab
          const configTab = existingTabs[0];
          await browser.tabs.update(configTab.id, { active: true });
          await browser.windows.update(configTab.windowId, { focused: true });
          console.log("Focused existing config tab");
        } else {
          // Create new config tab
          await browser.tabs.create({ url });
          console.log("Created new config tab");
        }
        
        window.close();
      } catch (error) {
        document.getElementById("status").textContent = `Error: ${error.message}`;
        console.error(error);
      }
    }

    if (e.target.id === "open-prompts") {
      e.preventDefault();
      try {
        const url = browser.runtime.getURL("prompts/prompts.html");
        
        // Check if prompts tab is already open
        const existingTabs = await browser.tabs.query({ url });
        
        if (existingTabs.length > 0) {
          // Focus existing prompts tab
          const promptsTab = existingTabs[0];
          await browser.tabs.update(promptsTab.id, { active: true });
          await browser.windows.update(promptsTab.windowId, { focused: true });
          console.log("Focused existing prompts tab");
        } else {
          // Create new prompts tab
          await browser.tabs.create({ url });
          console.log("Created new prompts tab");
        }
        
        window.close();
      } catch (error) {
        document.getElementById("status").textContent = `Error: ${error.message}`;
        console.error(error);
      }
    }

    if (e.target.id === "open-templates") {
      e.preventDefault();
      try {
        const url = browser.runtime.getURL("templates/templates.html");
        
        // Check if templates tab is already open
        const existingTabs = await browser.tabs.query({ url });
        
        if (existingTabs.length > 0) {
          // Focus existing templates tab
          const templatesTab = existingTabs[0];
          await browser.tabs.update(templatesTab.id, { active: true });
          await browser.windows.update(templatesTab.windowId, { focused: true });
          console.log("Focused existing templates tab");
        } else {
          // Create new templates tab
          await browser.tabs.create({ url });
          console.log("Created new templates tab");
        }
        
        window.close();
      } catch (error) {
        document.getElementById("status").textContent = `Error: ${error.message}`;
        console.error(error);
      }
    }
    
    if (e.target.id === "check-updates-link") {
      e.preventDefault();
      await handleCheckForUpdates();
    }
  };
  
  document.addEventListener("click", window.__popupClickListener);
  
  // Add cleanup on page unload
  window.addEventListener("beforeunload", () => {
    if (window.__popupClickListener) {
      try {
        document.removeEventListener("click", window.__popupClickListener);
        window.__popupClickListener = null;
        console.log("Popup click listener cleaned up");
      } catch (e) {
        console.error(`Failed to remove popup click listener: ${e}`);
      }
    }
  });
}
