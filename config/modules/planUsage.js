import { $ } from "./dom.js";

// Update subscription status display
// NOTE: Cancellation and downgrade are now shown in the reset label (updateQuotaDisplay)
// This function is kept for backwards compatibility but subscription-status element is always hidden
function updateSubscriptionStatusDisplay(data) {
  const statusEl = $("subscription-status");
  if (!statusEl) {
    return;
  }
  
  // Always hide - cancellation/downgrade now shown in reset label
  statusEl.style.display = "none";
  statusEl.textContent = "";
}

// Update plan status display
export function updatePlanStatusDisplay(data) {
  const planStatusLabel = $("plan-status-label");
  const upgradeBtn = $("upgrade-to-pro-btn");

  // Also update subscription status
  updateSubscriptionStatusDisplay(data);

  if (!planStatusLabel) return;

  if (!data || !data.logged_in) {
    planStatusLabel.textContent = "Plan: Not logged in";
    planStatusLabel.className = "";
    if (upgradeBtn) upgradeBtn.style.display = "none";
    return;
  }

  if (!data.has_subscription) {
    planStatusLabel.textContent = "Plan: No subscription";
    planStatusLabel.className = "";
    if (upgradeBtn) upgradeBtn.style.display = "none";
    return;
  }

  const planTier = data.plan_tier || "Unknown";
  const isTrialing = data.trial?.is_trial || data.subscription_status === "trialing";
  const trialSuffix = isTrialing ? " (Trial)" : "";

  planStatusLabel.textContent = `Plan: TabMail ${planTier}${trialSuffix}`;

  // Apply styling based on plan
  if (planTier.toLowerCase() === "pro") {
    planStatusLabel.className = "plan-pro";
  } else if (planTier.toLowerCase() === "basic") {
    planStatusLabel.className = "plan-basic";
  } else {
    planStatusLabel.className = "";
  }

  // Show upgrade button if on Basic plan
  if (upgradeBtn) {
    if (planTier.toLowerCase() === "basic") {
      upgradeBtn.style.display = "inline-block";
    } else {
      upgradeBtn.style.display = "none";
    }
  }

  console.log(`[Config] Plan status updated: ${planTier}${trialSuffix}`);
}

// Update quota usage display
export async function updateQuotaDisplay(getBackendUrl) {
  try {
    const progressBar = $("usage-bar");
    const label = $("usage-label");
    const resetLabel = $("usage-reset");

    if (!progressBar || !label) return;

    // Get access token
    const { getAccessToken } = await import("../../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();

    if (!accessToken) {
      progressBar.value = 0;
      label.textContent = "Monthly usage: N/A (Not logged in)";
      label.style.color = "";
      updatePlanStatusDisplay(null);
      return;
    }

    // Call /whoami to get quota info
    const whoamiBase = await getBackendUrl("whoami");
    const resp = await fetch(`${whoamiBase}/whoami?t=${Date.now()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    });

    if (!resp.ok) {
      progressBar.value = 0;
      label.textContent = "Monthly usage: N/A";
      label.style.color = "";
      updatePlanStatusDisplay(null);
      return;
    }

    const data = await resp.json();

    // Update plan status display
    updatePlanStatusDisplay(data);

    if (!data.logged_in || !data.has_subscription) {
      progressBar.value = 0;
      label.textContent = "Monthly usage: N/A (No subscription)";
      label.style.color = "";
      return;
    }

    const quotaPercentage = data.quota_percentage ?? null;
    const queueMode = data.queue_mode ?? null;
    const billingPeriodEnd = data.billing_period_end ?? null;

    console.log(
      `[TMDBG Config] Received from whoami - percentage: ${quotaPercentage}, mode: ${queueMode}, billing_period_end: ${billingPeriodEnd}`,
    );
    console.log(`[TMDBG Config] Full whoami data:`, data);

    if (quotaPercentage === null) {
      progressBar.value = 0;
      label.textContent = "Monthly usage: Loading...";
      label.style.color = "";
      return;
    }

    // Update progress bar
    progressBar.value = quotaPercentage;

    // Update label with queue mode indicator
    let queueIndicator = "";
    if (queueMode === "fast") {
      queueIndicator = " (Fast queue)";
    } else if (queueMode === "slow") {
      queueIndicator = " (Slow queue)";
    } else if (queueMode === "blocked") {
      queueIndicator = " (Blocked)";
    }

    // IMPORTANT: "Monthly usage" quota is an internal cost cap (max_monthly_cost_cents) determined by the backend.
    // It is NOT the Stripe plan price.
    label.textContent = `${quotaPercentage}% of monthly quota${queueIndicator}`;

    // Update reset/downgrade/cancel label (right side of bar)
    // Priority: cancellation > downgrade > reset date
    const pendingDowngrade = data.pending_downgrade;
    const pendingCancellation = data.pending_cancellation;
    if (resetLabel) {
      if (pendingCancellation && pendingCancellation.cancel_at) {
        // Show cancellation info instead of reset date
        const cancelDate = new Date(pendingCancellation.cancel_at * 1000);
        const year = cancelDate.getFullYear();
        const month = String(cancelDate.getMonth() + 1).padStart(2, "0");
        const day = String(cancelDate.getDate()).padStart(2, "0");
        resetLabel.textContent = `Cancels ${year}/${month}/${day}`;
        resetLabel.style.color = "var(--tag-tm-delete)";
        resetLabel.style.fontWeight = "500";
        console.log(`[TMDBG Config] Showing cancellation info in reset label: ${resetLabel.textContent}`);
      } else if (pendingDowngrade && pendingDowngrade.effective_at) {
        // Show downgrade info instead of reset date
        const downgradeDate = new Date(pendingDowngrade.effective_at * 1000);
        const year = downgradeDate.getFullYear();
        const month = String(downgradeDate.getMonth() + 1).padStart(2, "0");
        const day = String(downgradeDate.getDate()).padStart(2, "0");
        const toPlan = pendingDowngrade.to_plan || "Basic";
        resetLabel.textContent = `Downgrades to ${toPlan} ${year}/${month}/${day}`;
        resetLabel.style.color = "var(--tag-tm-delete)";
        resetLabel.style.fontWeight = "500";
        console.log(`[TMDBG Config] Showing downgrade info in reset label: ${resetLabel.textContent}`);
      } else if (billingPeriodEnd) {
        // Show reset date
        const resetDate = new Date(billingPeriodEnd * 1000);
        const year = resetDate.getFullYear();
        const month = String(resetDate.getMonth() + 1).padStart(2, "0");
        const day = String(resetDate.getDate()).padStart(2, "0");
        resetLabel.textContent = `Resets ${year}/${month}/${day}`;
        resetLabel.style.color = "";
        resetLabel.style.fontWeight = "";
        console.log(`[TMDBG Config] Reset date: ${resetLabel.textContent}, from timestamp: ${billingPeriodEnd}`);
      } else {
        resetLabel.textContent = "";
        resetLabel.style.color = "";
        resetLabel.style.fontWeight = "";
        console.log(`[TMDBG Config] No billing_period_end available, reset date not shown`);
      }
    }

    // Color warnings based on quota usage
    if (quotaPercentage >= 100) {
      label.style.color = "red";
    } else if (quotaPercentage >= 80) {
      label.style.color = "orange";
    } else {
      label.style.color = "";
    }

    console.log(
      `[Config] Quota updated: ${quotaPercentage}% (${queueMode})`,
    );
  } catch (e) {
    console.warn("[TMDBG Config] Failed to update quota display", e);
    const label = $("usage-label");
    if (label) {
      label.textContent = "Monthly usage: Error loading";
    }
    updatePlanStatusDisplay(null);
  }
}

