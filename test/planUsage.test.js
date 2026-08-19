/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// planUsage.test.js — plan status label rendered by
// config/modules/planUsage.js updatePlanStatusDisplay.
//
// INVARIANT under test: the label names the trial state AT MOST ONCE. Two
// independent /whoami signals can mark a trial — the tier string itself
// (`plan_tier: "Trial"`, server-granted signup trial) and the trialing
// subscription (`trial.is_trial` / `subscription_status: "trialing"`, card
// trial on a Basic/Pro tier). When the tier string already says "Trial", the
// " (Trial)" suffix is redundant and must be suppressed; on any other tier the
// suffix is the ONLY thing that says "trial" and must be preserved.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal DOM globals — dom.js `$` is document.getElementById
// ---------------------------------------------------------------------------

function makeEl() {
  return { textContent: "", className: "", style: { display: "" } };
}

let els;

globalThis.document = globalThis.document || {
  getElementById: (id) => (els ? els[id] || null : null),
};

const { updatePlanStatusDisplay } = await import(
  "../config/modules/planUsage.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Shape mirrors the real backend /whoami body: snake_case logged_in /
// has_subscription / plan_tier / subscription_status / trial.
function whoami(overrides = {}) {
  return {
    logged_in: true,
    has_subscription: true,
    plan_tier: "Basic",
    ...overrides,
  };
}

// Renders `data` and returns the resulting plan label text.
function renderLabel(data) {
  els = {
    "plan-status-label": makeEl(),
    "upgrade-to-pro-btn": makeEl(),
    "subscription-status": makeEl(),
  };
  updatePlanStatusDisplay(data);
  return els["plan-status-label"].textContent;
}

let logSpy;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  els = undefined;
});

// ---------------------------------------------------------------------------
// TB-177 — server-granted signup trial (plan_tier IS the trial)
// ---------------------------------------------------------------------------
describe("updatePlanStatusDisplay — server-granted signup trial", () => {
  it("renders the tier once when plan_tier is Trial and trial.is_trial is set", () => {
    expect(renderLabel(whoami({ plan_tier: "Trial", trial: { is_trial: true } }))).toBe(
      "Plan: TabMail Trial"
    );
  });

  it("renders the tier once when plan_tier is Trial and subscription_status is trialing", () => {
    expect(
      renderLabel(whoami({ plan_tier: "Trial", subscription_status: "trialing" }))
    ).toBe("Plan: TabMail Trial");
  });

  it("renders the tier once when plan_tier is Trial and BOTH trial signals are set", () => {
    expect(
      renderLabel(
        whoami({
          plan_tier: "Trial",
          subscription_status: "trialing",
          trial: { is_trial: true },
        })
      )
    ).toBe("Plan: TabMail Trial");
  });

  it("renders the tier once when plan_tier is Trial and no trial signal is set", () => {
    expect(renderLabel(whoami({ plan_tier: "Trial" }))).toBe("Plan: TabMail Trial");
  });
});

// ---------------------------------------------------------------------------
// TB-178 — legacy card trial on a paid tier keeps the suffix
// ---------------------------------------------------------------------------
describe("updatePlanStatusDisplay — card trial on a paid tier", () => {
  it("keeps the (Trial) suffix for Basic + subscription_status trialing", () => {
    expect(
      renderLabel(whoami({ plan_tier: "Basic", subscription_status: "trialing" }))
    ).toBe("Plan: TabMail Basic (Trial)");
  });

  it("keeps the (Trial) suffix for Basic + trial.is_trial", () => {
    expect(renderLabel(whoami({ plan_tier: "Basic", trial: { is_trial: true } }))).toBe(
      "Plan: TabMail Basic (Trial)"
    );
  });

  it("keeps the (Trial) suffix for Pro + subscription_status trialing", () => {
    expect(
      renderLabel(whoami({ plan_tier: "Pro", subscription_status: "trialing" }))
    ).toBe("Plan: TabMail Pro (Trial)");
  });

  it("keeps the (Trial) suffix for BYOK + trial.is_trial", () => {
    expect(renderLabel(whoami({ plan_tier: "BYOK", trial: { is_trial: true } }))).toBe(
      "Plan: TabMail BYOK (Trial)"
    );
  });
});

// ---------------------------------------------------------------------------
// TB-179 — non-trial states are untouched
// ---------------------------------------------------------------------------
describe("updatePlanStatusDisplay — non-trial states", () => {
  it("renders a plain paid Pro plan with no suffix", () => {
    expect(renderLabel(whoami({ plan_tier: "Pro" }))).toBe("Plan: TabMail Pro");
  });

  it("renders a plain paid Basic plan with no suffix", () => {
    expect(renderLabel(whoami({ plan_tier: "Basic" }))).toBe("Plan: TabMail Basic");
  });

  it("falls back to Unknown when plan_tier is absent", () => {
    expect(renderLabel(whoami({ plan_tier: undefined }))).toBe("Plan: TabMail Unknown");
  });

  it("renders 'Plan: No subscription' when has_subscription is false", () => {
    expect(renderLabel(whoami({ has_subscription: false, plan_tier: "Trial" }))).toBe(
      "Plan: No subscription"
    );
  });

  it("renders 'Plan: Not logged in' when logged_in is false", () => {
    expect(renderLabel(whoami({ logged_in: false }))).toBe("Plan: Not logged in");
  });

  it("renders 'Plan: Not logged in' when data is null", () => {
    expect(renderLabel(null)).toBe("Plan: Not logged in");
  });
});

// ---------------------------------------------------------------------------
// TB-180 — the invariant, stated over the whole trial-signal matrix
// ---------------------------------------------------------------------------
describe("updatePlanStatusDisplay — trial is named at most once", () => {
  const tiers = ["Trial", "Basic", "Pro", "BYOK", "Unknown"];
  const trialSignals = [
    { name: "none", patch: {} },
    { name: "trial.is_trial", patch: { trial: { is_trial: true } } },
    { name: "subscription_status", patch: { subscription_status: "trialing" } },
    {
      name: "both",
      patch: { subscription_status: "trialing", trial: { is_trial: true } },
    },
  ];

  for (const tier of tiers) {
    for (const signal of trialSignals) {
      it(`says "Trial" at most once for tier ${tier} with ${signal.name}`, () => {
        const label = renderLabel(whoami({ plan_tier: tier, ...signal.patch }));
        const occurrences = label.split("Trial").length - 1;
        expect(occurrences).toBeLessThanOrEqual(1);
      });
    }
  }

  // Two-sided non-vacuity: the matrix above must not pass by never naming a
  // trial at all. A trialing paid tier MUST still say "Trial" exactly once.
  it("still names the trial exactly once for a trialing paid tier", () => {
    const label = renderLabel(
      whoami({ plan_tier: "Basic", subscription_status: "trialing" })
    );
    expect(label.split("Trial").length - 1).toBe(1);
  });

  it("still names the trial exactly once for the signup-trial tier", () => {
    const label = renderLabel(
      whoami({ plan_tier: "Trial", trial: { is_trial: true } })
    );
    expect(label.split("Trial").length - 1).toBe(1);
  });
});
