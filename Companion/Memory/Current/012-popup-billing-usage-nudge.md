# Popup billing/usage nudge (Upgrade to Pro / Set up your API keys) — ADR-019

> Routed out of `PROJECT_MEMORY.md` § Recent Discoveries → 2026-06-24 by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `PROJECT_MEMORY.md`.

<!-- BEGIN PRESERVED BLOCK -->
- **New toolbar warning key `"billing"`** joins `fts`/`consent`/`setup`/`server` in the keyed `icon.js setWarning` system (the system is key-agnostic — no registration needed). Driven by `agent/modules/billingBanner.js decideBillingBanner(...)` (pure; port of iOS `UsageThrottleStore.banner`, ADR-IOS-044). Tier-branch from cached `/whoami` (`plan_tier`/`queue_mode`/`quota_percentage`) + local BYOK key state (`buildByokPayload().length>0`): **Basic+throttled→"upgrade"**, **BYOK+no-key→"byok"**, **Pro/unknown→null**. `isThrottled = slow||blocked queue || quota≥100`.
- **Two popup banners** (`popup.html` `#upgrade-pro-warning`/`#byok-setup-warning`), computed in `popup.js updateBillingBanner(data)` off the SAME `/whoami` the popup already fetches (no new request). Upgrade → `openDefaultBrowser("https://tabmail.ai/pricing")` (canonical clean URL — `/pricing`, NOT `/pricing.html`; matches config's Upgrade button). Setup keys → `openConfigTab({scrollToByok:true})` (new shared helper, also used by the existing Settings link).
- **BYOK deep-link** = one-shot `storage.local.tabmailPendingScrollByok` flag → `config/modules/init.js` scrolls `#byok-settings` (`<h3>Use your own AI keys</h3>`) into view + `.tm-deeplink-highlight` pulse, consumed on load AND via `configStorageListener` (already-open tab). Mirrors iOS `pendingScroll`.
- **Proactive dot** = popup persists `storage.local.tabmailBillingBanner` (`"upgrade"|"byok"|null`); `chat/background.js` mirrors it via startup read + `storage.onChanged` (same relay pattern as `consent`/`server`). Tests: `test/billingBanner.test.js` (28, decision + `/whoami` mapping) + `test/billingBannerContract.test.js` (9, cross-file string contracts — storage keys / `"billing"` key / element ids / `/pricing` URL; mutation-verified to bite).
- **NOT A BUG: a Pro account over quota shows NO banner — intentional** (confirmed w/ owner 2026-06-24, keeping iOS parity). `decideBillingBanner` only fires for **Basic** (throttled) + **BYOK** (no key); `case "Pro"` returns null (placeholder for a future Max/PAYG upsell, per ADR-IOS-044). Debug mode (dev backend, tiny `COST_QUOTA_MULTIPLIER`) makes testers go over quota fast, but if the account is Pro the nudge stays hidden. `popup.js updateBillingBanner` logs the decision inputs (`plan_tier`/`queue_mode`/`quota_percentage`) to the popup console for diagnosis. (Also: a mis-cased/unknown `plan_name` → backend never flips `queue_mode`/percentage → also no banner; that'd be a backend data issue, not the popup.)
- **Debug toggle to preview the nudges** (Settings → "Billing Banner (Debug)", `class="debug-only"`, mirrors "Update Notification (Debug)"): `config/modules/billingBannerDebug.js` writes `storage.local.tabmailBillingBannerDebug` = `"upgrade"|"byok"` (override) + `tabmailBillingBanner` (lights the toolbar dot immediately). `popup.js updateBillingBanner` checks the **override FIRST** (before real `/whoami` logic) so the banner shows regardless of real plan/quota — this is how to see the Pro-excluded "upgrade" banner. "Clear Override" removes the key + nulls the dot → real behavior returns on next popup open. Contract-tested in `billingBannerContract.test.js`.
- **Usage display shows "N/A of monthly quota" for BYOK / zero-quota** (NOT "0% of monthly quota (Slow)" — that was misleading; and NOT "∞" — the quota is zero, not infinite). `agent/modules/billingBanner.js isZeroQuotaPlan(whoami)` = `plan_tier === "BYOK"` (mirrors iOS `AccountDashboardView.isZeroPlan:142` which renders "N/A" — "site dashboard precedent"; **parity, not divergence**). Both usage surfaces — popup `updateQuotaDisplay` (now **async**, reads the override) and `config/modules/planUsage.js updateQuotaDisplay` — render label `"N/A of monthly quota"` (neutral color), **hide** the progress bar, skip the red/orange color warning, and drop the plain "Resets" line (keep cancel/downgrade). The `"byok"` debug override ALSO forces zeroQuota so the N/A display is previewable without a real BYOK account. Tests: `isZeroQuotaPlan` unit cases + the exact `"N/A of monthly quota"` label is contract-tested (a bare-`N/A` check was rejected — too loose: "N/A" also appears in the not-logged-in/no-sub placeholders). (History: briefly rendered "∞" 2026-06-24 before settling on "N/A" for correctness + iOS parity.)
<!-- END PRESERVED BLOCK -->

## Addendum 2026-08-18 — `isZeroQuotaPlan` re-keyed onto the wire quota signal

**Superseded above:** the line "`isZeroQuotaPlan(whoami)` = `plan_tier === "BYOK"`" describes the
ORIGINAL predicate. It is now `whoamiData?.limit_cost_cents === 0` — the exact signal the backend's
zero-priority-budget branch reports (`queue_mode:"slow"` + `quota_percentage:0` +
`limit_cost_cents:0`). Everything else in the preserved block (the "N/A of monthly quota" label, the
hidden progress bar, the dropped "Resets" line, the `"byok"` debug override forcing zeroQuota, both
call sites) is unchanged.

**Why:** the tier list was a *growing* list. A second zero-budget plan (`plan_tier:"Trial"`) ships the
identical quota shape, and the tier-keyed predicate rendered it as a misleading
"0% of monthly quota (Slow)" — the very bug the N/A treatment exists to prevent. Keying on the signal
means any future zero-budget plan is correct on the day it ships, with no client release.

**Wire-contract facts that make this safe** (verified 2026-08-18):
- A zero-priority-budget response always carries the quota fields, so `limit_cost_cents: 0` is
  reliably present for exactly the cohort that needs the N/A treatment.
- The quota fields are **co-gated**: `quota_percentage` / `queue_mode` / `limit_cost_cents` appear or
  disappear together. When they are absent the field is `undefined`, `undefined !== 0` → `false`, which
  is the correct answer for a budgeted plan — so a missing signal never produces a false "N/A", it just
  falls through to the same degraded render every other plan already gets.
- Strict `===` is load-bearing: `==` would accept `"0"`/`""`/`false` off a malformed body and blank out
  a real quota.
- **Edge accepted, not worked around:** a response reporting a zero budget alongside a *fast* queue
  renders "N/A" rather than "0% (Fast queue)". Not a reachable state for a normal account, and "N/A" is
  not the worse of the two renders.

**iOS parity note:** iOS `AccountDashboardView.isZeroPlan` still keys on the TIER. The two predicates
are now written differently and must stay **behaviorally** aligned — a plan treated as zero-budget on
TB must be treated as zero-budget on iOS. If a new zero-budget plan ships, TB needs no change but iOS
does.

**Tests:** `test/billingBanner.test.js` → `describe("isZeroQuotaPlan — zero-priority-budget detection")`,
7 cases on byte-real `/whoami` fixtures (TESTS.md TB-170…TB-176), incl. the red-first Trial case.
`decideBillingBanner` was deliberately NOT touched: "Trial" falls to its `default` → `null` nudge,
which is correct (no trial nudge was in scope).
