# "Show AI summaries" is a DISPLAY toggle; its gate release must ride the bounded banner retry

Landed 2026-09-10 in PR #35 (closes issue #34). The Settings → Appearance checkbox
`#show-ai-summaries` is the only writer of `storage.local.showAiSummariesEnabled` (default ON;
only an explicit `false` hides). `agent/modules/summaryDisplaySettings.js` owns the key and the
fail-open read (`getShowAiSummariesEnabled` returns `true` on a storage failure). The sole reader is
`agent/modules/summary.js processVisibleMessages`.

## What the toggle does and does NOT do

- It is a **presentation** gate, mirroring iOS ADR-IOS-078: hidden means the banner is never told
  to render. `getSummary`, `applyActionTags` and `enqueueProcessMessage` still run for the message, so
  action tags, caches and the processing queue are identical either way. Re-enabling shows the
  already-cached summary without regeneration.
- It shares the `!shouldShowBanner` branch with multi-select
  (`shouldShowBanner = messages.length === 1 && showAiSummaries`). Both skip reasons release the theme
  side's message-display gate with `tm-gate-summary-disabled`, so the message body is revealed at once
  instead of waiting for `GATE_TIMEOUT_MS`.

## The lesson (round-1 correctness finding C-1)

The first candidate released the gate with a **bare** `browser.tabs.sendMessage`. In the 3-pane
preview the theme listener injects `messageDisplayGate.js` on the same `onMessagesDisplayed` event
that the agent listener handles, and there is no proactive injection there (the `tabs.onUpdated`
path only covers `messageDisplay`-type tabs). So the agent's send can land **before the gate script
exists**, the send rejects "no receiver", and the user waits the full gate timeout on every message
while summaries are hidden. The fix routes the release through the existing
`sendBannerMessageWithRetry` (bounded by `SETTINGS.summaryBanner.sendRetryDelaysMs`) — the same
helper the banner-content path already used for exactly this race. Rule of thumb: **any message the
agent sends to a content script in response to `onMessagesDisplayed` goes through the retry helper,
never a bare send**, because the two listeners have no documented ordering guarantee.

Multi-select has no receiver at all (multimessageview is a transient chrome doc), so the retried
release rejects every attempt quickly (~360 ms across the configured delays) and generation
proceeds; that cost is bounded and accepted.

## Tests

`test/summaryDisplaySettings.test.js` (storage helper), `test/summaryBannerDisplayPreference.test.js`
(drives the real `onMessagesDisplayed` listener captured from `initSummaryFeatures`; asserts both the
pref-on and pref-off sides, and that the gate release survives a first "no receiver" rejection) and
`test/appearanceShowAiSummaries.test.js` (config load/save wiring). Review round 2 mapped changed
lines: the only uncovered lines are the dead `try/catch` around the retried release
(`sendBannerMessageWithRetry` never throws) and the 3 s status-clear timer.
