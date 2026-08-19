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

// The usage area renders "N/A of monthly quota" for a zero-priority-budget plan
// instead of a misleading "0% of monthly quota (Slow)". Detection is keyed on the
// WIRE QUOTA SIGNAL (`limit_cost_cents === 0`), not on a hardcoded tier list, so
// EVERY plan the backend puts on its zero-priority-budget branch (BYOK, Trial, …)
// gets the N/A treatment without a client change. The invariant under test is
// "no priority budget ⇒ no percentage", never "the tier is spelled BYOK".

// Byte-real /whoami bodies. The zero-priority-budget branch reports
// queue_mode "slow" + quota_percentage 0 + limit_cost_cents 0; a plan with a real
// budget reports its actual cap and a live percentage.
const zeroBudgetWhoami = (planTier) => ({
  logged_in: true,
  has_subscription: true,
  plan_tier: planTier,
  queue_mode: "slow",
  quota_percentage: 0,
  limit_cost_cents: 0,
  max_monthly_cost_cents: 0,
});

const paidWhoami = (planTier, limitCents, extra = {}) => ({
  logged_in: true,
  has_subscription: true,
  plan_tier: planTier,
  queue_mode: "fast",
  quota_percentage: 12.5,
  limit_cost_cents: limitCents,
  max_monthly_cost_cents: limitCents,
  ...extra,
});

describe("isZeroQuotaPlan — zero-priority-budget detection", () => {
  it("true for BYOK (behavior preserved)", () => {
    expect(isZeroQuotaPlan(zeroBudgetWhoami("BYOK"))).toBe(true);
  });

  it("true for Trial — same zero-budget shape BYOK gets", () => {
    // A Trial plan reports the SAME zero-budget quota shape as BYOK, so it must
    // get the same "N/A" treatment. Keying on the tier name rendered a
    // misleading "0% of monthly quota (Slow)" here.
    expect(isZeroQuotaPlan(zeroBudgetWhoami("Trial"))).toBe(true);
  });

  it("false for Basic / Pro — a real positive budget keeps its percentage", () => {
    expect(isZeroQuotaPlan(paidWhoami("Basic", 500))).toBe(false);
    expect(isZeroQuotaPlan(paidWhoami("Pro", 1000))).toBe(false);
  });

  it("false for a legacy card-based trial (real quota, must keep the percentage)", () => {
    // subscription_status "trialing" on a paid tier is a card trial: it has a
    // genuine monthly budget, so the percentage is meaningful and must show.
    expect(
      isZeroQuotaPlan(paidWhoami("Basic", 500, { subscription_status: "trialing" }))
    ).toBe(false);
  });

  it("false when the quota signal is absent (undefined !== 0 — no false N/A)", () => {
    // Logged out / no subscription / quota block missing entirely: never claim a
    // zero budget we were not told about.
    expect(isZeroQuotaPlan({ logged_in: false })).toBe(false);
    expect(isZeroQuotaPlan({ logged_in: true, has_subscription: false })).toBe(false);
    expect(isZeroQuotaPlan({ logged_in: true, has_subscription: true, plan_tier: "Basic" })).toBe(false);
    expect(isZeroQuotaPlan({ plan_tier: "BYOK" })).toBe(false);
    expect(isZeroQuotaPlan({})).toBe(false);
    expect(isZeroQuotaPlan(null)).toBe(false);
    expect(isZeroQuotaPlan(undefined)).toBe(false);
  });

  it("strict equality — a string \"0\" is NOT a zero budget (never coerce)", () => {
    // `==` would accept "0", "", false, [] and null-ish values off a malformed
    // wire body and silently blank out a real quota.
    expect(isZeroQuotaPlan({ ...zeroBudgetWhoami("Trial"), limit_cost_cents: "0" })).toBe(false);
    expect(isZeroQuotaPlan({ ...zeroBudgetWhoami("Trial"), limit_cost_cents: null })).toBe(false);
    expect(isZeroQuotaPlan({ ...zeroBudgetWhoami("Trial"), limit_cost_cents: false })).toBe(false);
  });

  it("keys on the quota signal, not the tier spelling", () => {
    // Tier casing/naming is irrelevant now: the budget decides. This is the
    // property that makes a NEW zero-budget plan work with no client change.
    expect(isZeroQuotaPlan(zeroBudgetWhoami("byok"))).toBe(true);
    expect(isZeroQuotaPlan(zeroBudgetWhoami("SomeFuturePlan"))).toBe(true);
    expect(isZeroQuotaPlan(paidWhoami("BYOK", 500))).toBe(false);
  });
});
