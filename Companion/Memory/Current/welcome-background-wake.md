# Reuse the Welcome window on background wake

The background checks the onboarding completion flag on each startup. The wizard normally sets that flag on opening. An existing wizard can coexist with an unset flag after a failed completion write, failed page initialization, or a debug reset. Its window lookup must call `browser.windows.getAll({ populate: true })`: without population, returned windows omit `tabs`, so searching those tabs cannot find an already-open wizard. This can open another wizard after background suspension.

The lookup now requests populated windows and makes the previously unreachable focus/reset branch effective. It does not add a listener, timer, persistence key, or experiment. Completed onboarding remains a no-op.

`test/welcomeWake.test.js` executes the current startup-check function with the API's optional-tabs contract and a retained window registry across fresh contexts. It covers reuse, creation when absent followed by reuse, and completed onboarding. Baseline fails the two reuse cases; the fix passes all three.

A controlled Thunderbird Beta smoke disabled relay/native-message retention and used an incomplete-onboarding test key plus a stock alarm. After actual background closure, the baseline found one existing wizard but attempted another creation. The fix found and reused one wizard across two subsequent background generations. This validates window reuse, not every onboarding interaction or preservation of page progress; the now-reachable branch focuses the wizard and resets its current step.
