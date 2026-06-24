/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure decision logic for the popup's billing / usage-throttle nudge.
 *
 * Mirrors the iOS `UsageThrottleStore.banner` (ADR-IOS-044): driven entirely by
 * the `/whoami` response fields the popup already fetches (`plan_tier`,
 * `queue_mode`, `quota_percentage`) plus the locally-known BYOK key state. No
 * extra network call.
 *
 * Tier-branched outcome:
 *   • Basic + throttled (slow/blocked queue OR monthly budget spent) → "upgrade"
 *       → open the plan page so they can move to Pro.
 *   • BYOK  + no own key (permanently on the slow shared queue per global
 *       ADR-025) → "byok" → settings "Use your own AI keys" section.
 *   • Pro / unknown / no subscription → null (no nudge — the sign-in / trial
 *       surfaces own those users; Pro is a placeholder for a future upsell).
 */

// A user is "throttled" once the backend has dropped them to the slow shared
// queue (or hard-blocked them), or they've spent their entire monthly priority
// budget. Matches iOS (`queue_mode === "slow"` OR `quota_percentage >= 100`);
// "blocked" is TB's hard-cap queue state and is strictly worse than "slow", so
// it counts too.
const QUOTA_THROTTLE_PERCENT = 100;

/**
 * Decide which billing nudge (if any) to surface.
 * @param {Object} p
 * @param {string|null} [p.planTier]        - whoami `plan_tier` ("Basic"/"Pro"/"BYOK"/…)
 * @param {string|null} [p.queueMode]       - whoami `queue_mode` ("fast"/"slow"/"blocked"/null)
 * @param {number|null} [p.quotaPercentage] - whoami `quota_percentage` (0..100+)
 * @param {boolean}     [p.hasOwnApiKeys]   - true when the user has configured a
 *                                            BYOK provider key + model (own key)
 * @returns {"upgrade"|"byok"|null}
 */
export function decideBillingBanner({ planTier, queueMode, quotaPercentage, hasOwnApiKeys } = {}) {
  const tier = typeof planTier === "string" ? planTier : "";
  const isThrottled =
    queueMode === "slow" ||
    queueMode === "blocked" ||
    (Number(quotaPercentage) || 0) >= QUOTA_THROTTLE_PERCENT;

  switch (tier) {
    case "Basic":
      // Only nudge once they've actually been throttled (budget exhausted /
      // dropped to the slow queue) — not the whole month.
      return isThrottled ? "upgrade" : null;
    case "BYOK":
      // BYOK without an own key runs permanently on the slow shared queue. With
      // a key, requests route through the user's own provider (fast).
      return hasOwnApiKeys ? null : "byok";
    case "Pro":
      // No throttle nudge for Pro yet (placeholder for a future Max / PAYG upsell).
      return null;
    default:
      // Unknown / no subscription — handled by the sign-in & free-trial surfaces.
      return null;
  }
}

/**
 * True for the zero-priority-budget (BYOK) plan, whose "% of monthly quota" is
 * meaningless — the backend reports `quota_percentage: 0` + `queue_mode: "slow"`
 * + `limit_cost_cents: 0` (see whoami.ts `isZeroPriorityBudgetPlan` branch), so a
 * naive render shows a misleading "0% of monthly quota (Slow)". The usage UI
 * shows "N/A of monthly quota" instead — there's no priority budget, so a
 * percentage is meaningless (the quota is zero, not infinite). Mirrors iOS
 * `AccountDashboardView.isZeroPlan` (= `planTier == "BYOK"`), which also renders
 * "N/A" ("site dashboard precedent").
 * @param {Object|null|undefined} whoamiData
 * @returns {boolean}
 */
export function isZeroQuotaPlan(whoamiData) {
  return whoamiData?.plan_tier === "BYOK";
}

/**
 * Map a raw `/whoami` response object straight to a banner kind. Owns the
 * "must be logged in WITH a subscription" gate and the snake_case field
 * extraction (`plan_tier` / `queue_mode` / `quota_percentage`) so that contract
 * — not just the abstract decision — is unit-tested and can't silently drift.
 * @param {Object|null|undefined} whoamiData - the parsed /whoami body
 * @param {boolean} [hasOwnApiKeys] - whether the user configured an own BYOK key
 * @returns {"upgrade"|"byok"|null}
 */
export function bannerFromWhoami(whoamiData, hasOwnApiKeys = false) {
  if (!whoamiData || !whoamiData.logged_in || !whoamiData.has_subscription) {
    return null;
  }
  return decideBillingBanner({
    planTier: whoamiData.plan_tier ?? null,
    queueMode: whoamiData.queue_mode ?? null,
    quotaPercentage: whoamiData.quota_percentage ?? 0,
    hasOwnApiKeys,
  });
}
