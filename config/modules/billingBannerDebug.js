/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { $ } from "./dom.js";

// Storage keys — keep in sync with popup.js (reads OVERRIDE_KEY) and
// chat/background.js (mirrors RESULT_KEY onto the toolbar dot). Guarded by
// test/billingBannerContract.test.js.
const OVERRIDE_KEY = "tabmailBillingBannerDebug"; // "upgrade" | "byok" | (unset = no override)
const RESULT_KEY = "tabmailBillingBanner";        // drives the proactive toolbar red dot

const LABELS = {
  upgrade: 'Upgrade to Pro',
  byok: 'Set up your API keys',
};

/**
 * Show the current override state in the debug section.
 */
export async function updateBillingBannerDebugStatus() {
  const stateEl = $("billing-banner-debug-state");
  if (!stateEl) return;

  try {
    const stored = await browser.storage.local.get({ [OVERRIDE_KEY]: null });
    const override = stored[OVERRIDE_KEY];

    if (override === "upgrade" || override === "byok") {
      stateEl.textContent = `⏳ Override active: ${override} ("${LABELS[override]}")`;
      stateEl.style.color = "var(--tag-tm-archive, #ff9500)";
    } else {
      stateEl.textContent = "✓ No override — using real /whoami plan + quota";
      stateEl.style.color = "var(--tag-tm-reply, #5cb85c)";
    }
  } catch (e) {
    console.error("[TMDBG BillingDebug] Failed to read override state:", e);
    stateEl.textContent = `Error: ${e.message}`;
    stateEl.style.color = "var(--tag-tm-delete, #ee1111)";
  }
}

/**
 * Force a specific billing nudge so it can be previewed without a real
 * over-quota / BYOK account. Writes the override (the popup honors it on open)
 * AND the result key (the background lights the toolbar dot immediately).
 * @param {"upgrade"|"byok"} kind
 */
export async function forceBillingBanner(kind) {
  if (kind !== "upgrade" && kind !== "byok") return;
  try {
    console.log(`[TMDBG BillingDebug] Forcing billing banner: ${kind}`);
    await browser.storage.local.set({ [OVERRIDE_KEY]: kind, [RESULT_KEY]: kind });
    $("status").textContent = `Forced billing banner: "${LABELS[kind]}". Open the toolbar popup to see it.`;
    await updateBillingBannerDebugStatus();
  } catch (e) {
    console.error("[TMDBG BillingDebug] forceBillingBanner failed:", e);
    $("status").textContent = `Error: ${e.message}`;
  }
}

/**
 * Clear the override and the toolbar dot. The real /whoami-driven state returns
 * on the next popup open / foreground.
 */
export async function clearBillingBannerOverride() {
  try {
    console.log("[TMDBG BillingDebug] Clearing billing banner override");
    await browser.storage.local.remove(OVERRIDE_KEY);
    await browser.storage.local.set({ [RESULT_KEY]: null });
    $("status").textContent = "Billing banner override cleared (real plan + quota restored).";
    await updateBillingBannerDebugStatus();
  } catch (e) {
    console.error("[TMDBG BillingDebug] clearBillingBannerOverride failed:", e);
    $("status").textContent = `Error: ${e.message}`;
  }
}
