/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// billingBanner.test.js — tier-branched popup billing/usage nudge decision.
// Mirrors iOS UsageThrottleStore.banner (ADR-IOS-044): driven by /whoami
// (plan_tier, queue_mode, quota_percentage) + local BYOK key state.

import { describe, it, expect } from "vitest";
import { decideBillingBanner, bannerFromWhoami, isZeroQuotaPlan } from "../agent/modules/billingBanner.js";

// Shape mirrors the real backend /whoami body (tabmail-backend src/apps/whoami.ts):
// snake_case logged_in / has_subscription / plan_tier / queue_mode / quota_percentage.
function whoami(overrides = {}) {
  return {
    logged_in: true,
    has_subscription: true,
    plan_tier: "Basic",
    queue_mode: "fast",
    quota_percentage: 10,
    ...overrides,
  };
}

describe("decideBillingBanner — Basic tier", () => {
  it("no nudge when not throttled (fast queue, under quota)", () => {
    expect(
      decideBillingBanner({ planTier: "Basic", queueMode: "fast", quotaPercentage: 42 })
    ).toBe(null);
  });

  it("upgrade when dropped to the slow queue", () => {
    expect(
      decideBillingBanner({ planTier: "Basic", queueMode: "slow", quotaPercentage: 30 })
    ).toBe("upgrade");
  });

  it("upgrade when hard-blocked queue", () => {
    expect(
      decideBillingBanner({ planTier: "Basic", queueMode: "blocked", quotaPercentage: 30 })
    ).toBe("upgrade");
  });

  it("upgrade when quota exactly at 100%", () => {
    expect(
      decideBillingBanner({ planTier: "Basic", queueMode: "fast", quotaPercentage: 100 })
    ).toBe("upgrade");
  });

  it("upgrade when quota over 100% (overage)", () => {
    expect(
      decideBillingBanner({ planTier: "Basic", queueMode: "fast", quotaPercentage: 137 })
    ).toBe("upgrade");
  });

  it("no nudge at 99% on the fast queue (just under the cap)", () => {
    expect(
      decideBillingBanner({ planTier: "Basic", queueMode: "fast", quotaPercentage: 99 })
    ).toBe(null);
  });

  it("hasOwnApiKeys is irrelevant for Basic", () => {
    expect(
      decideBillingBanner({ planTier: "Basic", queueMode: "slow", hasOwnApiKeys: true })
    ).toBe("upgrade");
  });
});

describe("decideBillingBanner — BYOK tier", () => {
  it("nudge to configure keys when no own key", () => {
    expect(
      decideBillingBanner({ planTier: "BYOK", queueMode: "slow", hasOwnApiKeys: false })
    ).toBe("byok");
  });

  it("no nudge once an own key is configured", () => {
    expect(
      decideBillingBanner({ planTier: "BYOK", queueMode: "slow", hasOwnApiKeys: true })
    ).toBe(null);
  });

  it("BYOK without a key nudges even on the fast/unknown queue (always slow shared queue)", () => {
    expect(
      decideBillingBanner({ planTier: "BYOK", queueMode: "fast", quotaPercentage: 0, hasOwnApiKeys: false })
    ).toBe("byok");
  });
});

describe("decideBillingBanner — Pro / unknown / missing", () => {
  it("Pro never shows a nudge, even when throttled", () => {
    expect(
      decideBillingBanner({ planTier: "Pro", queueMode: "slow", quotaPercentage: 100 })
    ).toBe(null);
  });

  it("unknown plan → null", () => {
    expect(
      decideBillingBanner({ planTier: "Unknown", queueMode: "slow", quotaPercentage: 100 })
    ).toBe(null);
  });

  it("null plan → null", () => {
    expect(
      decideBillingBanner({ planTier: null, queueMode: "slow", quotaPercentage: 100 })
    ).toBe(null);
  });

  it("empty input object → null (no throw)", () => {
    expect(decideBillingBanner({})).toBe(null);
  });

  it("no argument → null (no throw)", () => {
    expect(decideBillingBanner()).toBe(null);
  });

  it("missing quota/queue for Basic → null (treated as not throttled)", () => {
    expect(decideBillingBanner({ planTier: "Basic" })).toBe(null);
  });
});

// These exercise the raw /whoami → banner contract (the snake_case field names
// and the logged-in/subscription gate). A regression like renaming queue_mode,
// mis-casing "BYOK", or dropping the gate would be caught HERE — the abstract
// decideBillingBanner tests above would not see it.
describe("bannerFromWhoami — gating", () => {
  it("null / undefined whoami → null", () => {
    expect(bannerFromWhoami(null)).toBe(null);
    expect(bannerFromWhoami(undefined)).toBe(null);
  });

  it("not logged in → null even if fields look throttled", () => {
    expect(bannerFromWhoami(whoami({ logged_in: false, queue_mode: "slow" }))).toBe(null);
  });

  it("logged in but no subscription → null", () => {
    expect(bannerFromWhoami(whoami({ has_subscription: false, queue_mode: "slow" }))).toBe(null);
  });
});

describe("bannerFromWhoami — real payload shapes", () => {
  it("Basic, healthy → null", () => {
    expect(bannerFromWhoami(whoami({ plan_tier: "Basic", queue_mode: "fast", quota_percentage: 55 }))).toBe(null);
  });

  it("Basic, slow queue → upgrade", () => {
    expect(bannerFromWhoami(whoami({ plan_tier: "Basic", queue_mode: "slow" }))).toBe("upgrade");
  });

  it("Basic, quota at 100% (fractional values possible) → upgrade", () => {
    expect(bannerFromWhoami(whoami({ plan_tier: "Basic", queue_mode: "fast", quota_percentage: 100 }))).toBe("upgrade");
  });

  it("Basic, quota 99.7% → null (just under)", () => {
    expect(bannerFromWhoami(whoami({ plan_tier: "Basic", queue_mode: "fast", quota_percentage: 99.7 }))).toBe(null);
  });

  it("BYOK (backend reports queue_mode 'slow'), no own key → byok", () => {
    expect(bannerFromWhoami(whoami({ plan_tier: "BYOK", queue_mode: "slow", quota_percentage: 0 }), false)).toBe("byok");
  });

  it("BYOK with own key configured → null", () => {
    expect(bannerFromWhoami(whoami({ plan_tier: "BYOK", queue_mode: "slow", quota_percentage: 0 }), true)).toBe(null);
  });

  it("Pro, throttled → null", () => {
    expect(bannerFromWhoami(whoami({ plan_tier: "Pro", queue_mode: "slow", quota_percentage: 100 }))).toBe(null);
  });

  it("quotaInfo absent (whoami quota lookup failed → no queue_mode/quota_percentage): Basic → null", () => {
    expect(bannerFromWhoami({ logged_in: true, has_subscription: true, plan_tier: "Basic" })).toBe(null);
  });

  it("quotaInfo absent: BYOK without key still nudges (independent of quota)", () => {
    expect(bannerFromWhoami({ logged_in: true, has_subscription: true, plan_tier: "BYOK" }, false)).toBe("byok");
  });
});

// The usage area renders "N/A of monthly quota" for the zero-priority-budget
// plan instead of a misleading "0% of monthly quota". Detection mirrors iOS
// isZeroPlan (planTier == "BYOK").
describe("isZeroQuotaPlan", () => {
  it("true for BYOK", () => {
    expect(isZeroQuotaPlan({ plan_tier: "BYOK" })).toBe(true);
    expect(isZeroQuotaPlan(whoami({ plan_tier: "BYOK" }))).toBe(true);
  });

  it("false for Basic / Pro", () => {
    expect(isZeroQuotaPlan({ plan_tier: "Basic" })).toBe(false);
    expect(isZeroQuotaPlan({ plan_tier: "Pro" })).toBe(false);
  });

  it("false for unknown / null / missing (no false N/A)", () => {
    expect(isZeroQuotaPlan({ plan_tier: "Unknown" })).toBe(false);
    expect(isZeroQuotaPlan({ plan_tier: null })).toBe(false);
    expect(isZeroQuotaPlan({})).toBe(false);
    expect(isZeroQuotaPlan(null)).toBe(false);
    expect(isZeroQuotaPlan(undefined)).toBe(false);
  });

  it("case-sensitive — lowercase 'byok' is NOT treated as zero-quota", () => {
    expect(isZeroQuotaPlan({ plan_tier: "byok" })).toBe(false);
  });
});
