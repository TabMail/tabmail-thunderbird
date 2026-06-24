/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// billingBannerContract.test.js — guards the CROSS-FILE string identifiers the
// popup billing nudge depends on (ADR-019). The decision logic is unit-tested in
// billingBanner.test.js, but the wiring is browser-API/DOM glue spread across
// popup.html, popup.js, chat/background.js, config.html, config/modules/init.js.
// A typo in ONE of a shared pair (storage key, warning key, element id, URL)
// silently disables the feature with no runtime error — these source scans fail
// CI instead of prod. Same rationale as byokImportContract.test.js.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const popupJs = read("../popup/popup.js");
const popupHtml = read("../popup/popup.html");
const backgroundJs = read("../chat/background.js");
const configHtml = read("../config/config.html");
const configInitJs = read("../config/modules/init.js");
const billingDebugJs = read("../config/modules/billingBannerDebug.js");
const configPlanUsageJs = read("../config/modules/planUsage.js");

// Whole-token match: the token must NOT be flanked by an identifier char, so a
// suffix/prefix drift (`tabmailBillingBanner` → `tabmailBillingBanner2`) FAILS
// rather than passing a loose substring check. Token may contain `-` (element
// ids), which is a non-identifier char and only ever appears mid-token here.
function hasToken(src, token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${esc}(?![\\w$])`).test(src);
}

describe("billing nudge — toolbar dot contract (popup ⇄ background)", () => {
  it("popup PERSISTS and background READS the same storage key", () => {
    expect(hasToken(popupJs, "tabmailBillingBanner")).toBe(true);
    expect(hasToken(backgroundJs, "tabmailBillingBanner")).toBe(true);
  });

  it('popup reports and background sets the SAME "billing" warning key', () => {
    expect(popupJs).toContain('reportWarning("billing"');
    expect(backgroundJs).toContain('setWarning("billing"');
  });
});

describe("billing nudge — BYOK deep-link contract (popup ⇄ config)", () => {
  it("popup SETS and config init READS the same pending-scroll flag", () => {
    expect(hasToken(popupJs, "tabmailPendingScrollByok")).toBe(true);
    expect(hasToken(configInitJs, "tabmailPendingScrollByok")).toBe(true);
  });

  it("config init scrolls to the byok-settings section, which exists in config.html", () => {
    expect(hasToken(configInitJs, "byok-settings")).toBe(true);
    expect(configHtml).toContain('id="byok-settings"');
  });
});

describe("billing nudge — popup DOM id contract (popup.js ⇄ popup.html)", () => {
  // Every getElementById / e.target.id the popup uses for the nudge MUST exist
  // in the markup, or the banner never shows / the button never fires.
  const ids = [
    "upgrade-pro-warning",
    "byok-setup-warning",
    "upgrade-to-pro-from-warning",
    "setup-byok-from-warning",
  ];
  for (const id of ids) {
    it(`popup.html defines #${id} that popup.js references (quoted, exact)`, () => {
      expect(popupJs).toContain(`"${id}"`);
      expect(popupHtml).toContain(`id="${id}"`);
    });
  }
});

describe("billing nudge — plan page URL", () => {
  it("upgrade CTA opens the canonical clean pricing URL (not /pricing.html)", () => {
    expect(popupJs).toContain('"https://tabmail.ai/pricing"');
  });
});

describe("billing nudge — debug override contract (config ⇄ popup ⇄ background)", () => {
  it("popup READS the same override key the debug module WRITES", () => {
    expect(hasToken(popupJs, "tabmailBillingBannerDebug")).toBe(true);
    expect(hasToken(billingDebugJs, "tabmailBillingBannerDebug")).toBe(true);
  });

  it("debug module also writes the toolbar-dot result key the background reads", () => {
    expect(hasToken(billingDebugJs, "tabmailBillingBanner")).toBe(true);
    expect(hasToken(backgroundJs, "tabmailBillingBanner")).toBe(true);
  });

  it("override values match the popup's accepted set (upgrade / byok)", () => {
    for (const v of ["upgrade", "byok"]) {
      expect(popupJs).toContain(`"${v}"`);
      expect(billingDebugJs).toContain(`"${v}"`);
    }
  });

  it("config.html defines the debug button ids that init.js handles", () => {
    const ids = [
      "billing-banner-debug-upgrade",
      "billing-banner-debug-byok",
      "billing-banner-debug-clear",
    ];
    for (const id of ids) {
      expect(configInitJs).toContain(`"${id}"`);
      expect(configHtml).toContain(`id="${id}"`);
    }
  });
});

describe("usage display — 'N/A of monthly quota' for the zero-quota (BYOK) plan", () => {
  it("both usage surfaces CALL the shared isZeroQuotaPlan helper (not just import it)", () => {
    // The "(" requires an actual call — a bare-name check would pass on the import
    // line alone even if the helper were never used in the render logic.
    expect(popupJs).toContain("isZeroQuotaPlan(");
    expect(configPlanUsageJs).toContain("isZeroQuotaPlan(");
  });

  it("both usage surfaces ASSIGN the exact 'N/A of monthly quota' label", () => {
    // Match the assignment form (`.textContent = "N/A of monthly quota"`), NOT a
    // bare substring — the string also appears in an explanatory comment, so a
    // plain toContain would pass even if the actual label assignment regressed.
    // (And a bare "N/A" check would be too loose: it also appears in the
    // not-logged-in / no-subscription placeholders and "Resets N/A".)
    const assign = /textContent\s*=\s*"N\/A of monthly quota"/;
    expect(popupJs).toMatch(assign);
    expect(configPlanUsageJs).toMatch(assign);
  });

  it("both usage surfaces honor the byok debug override for preview", () => {
    expect(hasToken(popupJs, "tabmailBillingBannerDebug")).toBe(true);
    expect(hasToken(configPlanUsageJs, "tabmailBillingBannerDebug")).toBe(true);
  });
});
