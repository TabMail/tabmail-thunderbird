# ADR-019: Popup Billing/Usage Nudge — Tier-Branched, Driven by Cached /whoami (TB port of ADR-IOS-044)

> Routed out of `DECISIONS.md` § ADR-019 by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
**Context:** When a TB user is throttled (a Basic user exhausts their monthly priority budget → slow queue; a BYOK user with no own key runs permanently on the slow shared queue per global ADR-025), nothing surfaced it — AI processing just silently slowed. iOS already solved this with an inbox banner (ADR-IOS-044). On TB the most obvious analog is the toolbar **popup** (the "agent window" entry point), which already renders `/whoami` usage and already has a keyed toolbar red-dot mechanism.

**Decision:**
1. **Pure decision in a leaf module.** `agent/modules/billingBanner.js` exports `decideBillingBanner({planTier, queueMode, quotaPercentage, hasOwnApiKeys}) → "upgrade" | "byok" | null` — a direct port of iOS `UsageThrottleStore.banner`. `isThrottled = queue_mode === "slow" || queue_mode === "blocked" || quota_percentage >= 100` (`QUOTA_THROTTLE_PERCENT`; "blocked" is TB's hard-cap state, strictly worse than slow). Branch: **Basic + throttled → "upgrade"**, **BYOK + no own key → "byok"**, **Pro / unknown / no-subscription → null**.
2. **No new network call.** The popup already fetches `/whoami` in `updateAuthStatus`; `updateBillingBanner(data)` reuses that same response. `hasOwnApiKeys` = `Object.keys(buildByokPayload()).length > 0` (parity with iOS `byokBundle != nil` — a tier with provider ≠ tabmail + key + model).
3. **Two popup banners** (`popup.html` `#upgrade-pro-warning` / `#byok-setup-warning`), styled like the existing `consent`/`setup`/`fts` warnings. "Upgrade to Pro" → `browser.windows.openDefaultBrowser("https://tabmail.ai/pricing")` (the site's canonical clean URL; same target as the config page's own Upgrade button). "Set up your API keys" → opens/focuses the Settings tab and **deep-links to the BYOK section**.
4. **BYOK deep-link** = one-shot `storage.local.tabmailPendingScrollByok` flag (mirrors iOS's `pendingScroll` UserDefaults). The popup sets it before opening Settings; `config/modules/init.js` consumes it after its load batch (fresh tab) AND via the existing `configStorageListener` (already-open tab), scrolling `#byok-settings` into view with a brief palette-based `.tm-deeplink-highlight` pulse, then clearing the flag.
5. **Proactive toolbar dot via a new `"billing"` warning key.** The popup `reportWarning("billing", …)` (immediate) AND persists `storage.local.tabmailBillingBanner` (`"upgrade"|"byok"|null`); `chat/background.js` reads it on startup + `storage.onChanged` → `setWarning("billing", …)` — same storage-relay pattern as `consent`/`server` (ZERO extra network). Cleared on sign-out / logged-out / Pro / healthy.

**Rationale:** Reusing the existing `/whoami` fetch + the keyed-warning infra means a minimal, parity-faithful addition with no new polling and no ADR-004 concerns. Branching on tier keeps each cohort's message + destination correct without a backend change. iOS is the de-facto reference for this specific feature.

**Consequences:**
- Banner/dot accuracy tracks `/whoami` cadence (recomputed on each popup open). A just-added BYOK key clears the nudge on the next popup open rather than instantly (iOS's `refreshKeyState()` immediacy was intentionally not ported — self-heals, acceptable for a non-urgent nudge).
- A new top-level warning condition is now a one-line `case` in `decideBillingBanner` + (if persisted) a storage key the background mirrors.
- Pure logic is unit-tested (`test/billingBanner.test.js`); the popup/config wiring is browser-API glue (not unit-tested, consistent with the rest of `popup.js`).
<!-- END PRESERVED BLOCK -->
