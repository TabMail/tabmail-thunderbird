# 055 — The "turn off all AI" setting is checked right before every send

2026-11-23. Turning off all AI (`privacy_opt_out_all_ai`) applies to a chat request already under way, not only to
the next one: it is the one setting read live rather than from the operation's start (the monorepo's
"snapshot settings at operation start" rule, whose exception is AI consent; the iOS app and TabMail Voice check
the same way before every AI send).

## The rule (`sendChatCompletions` in `agent/modules/llm.js`)

- `assertAiBackendAllowed` runs at the start of the request (the earliest refusal, no work done) and again right
  before each of its three sends: the first send, each resend after a rate limit (429), and the resend after
  signing in again (401/403).
- Each send's check runs after every wait before it (its `getAccessToken()` lookup, the rate-limit wait, signing in
  again), and nothing is awaited between the check and the `fetch`.
- The first send's check sits outside the request's `try`, so its refusal never reaches the catch that records "no
  response = server unreachable" and arms no connect timer. The resends' refusals pass through the rate-limit
  loop's catch unchanged.
- A refusal ends the request with the `PrivacyOptOutError` the check throws. `retryWithBackoff` does not retry it.
- The rate-limit wait signals its end (`'end'`) only to the callback it signalled the start to (`throttleCallback`,
  captured at `'start'`), once, on every exit, and clears the waiting message on every exit.

A new send added to `sendChatCompletions` needs the same check after its last wait.

## Tests

`test/llmAiSettingEveryRequest.test.js` (TB-215) wraps the real `assertAiBackendAllowed` to record which sends
were checked and each refusal, and turns AI off at each wait before a send.
