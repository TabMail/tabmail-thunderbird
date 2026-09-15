# Token refresh has a per-attempt deadline; a stalled refresh must never wedge the AI queue

Issue #55 (TB 1.7.8, TB 155): after a temporary connectivity loss the process-message queue sat at
`inFlight=5` for over an hour. The uncovered wait was **pre-SSE**: `llm.js::sendChatCompletions`
awaits `getAccessToken()` *before* arming its 15 s connect timer, and
`supabaseAuth.js::refreshAccessToken` issued its `fetch` with no signal and no deadline. Every
concurrent caller then parked on the shared `_refreshInProgress` promise, with zero timers armed, and
neither the connect timer nor the SSE inactivity watchdog (`readSSEStream`, 10 s silence) could
ever fire. A later fresh-token probe succeeding is **not** evidence the original waiters completed.

## The fix (PR for #55)

- `SETTINGS.authTokenRefreshTimeoutMs` (15 s, next to `authTokenRefreshRetries`) bounds **each**
  refresh HTTP attempt. The `AbortController` is armed before `fetch` and cleared in `finally`, so
  the deadline covers connect, headers **and** `response.json()` on both the error and success
  branches. Do not clear it at headers: a body that never arrives is the same wedge.
- Expiry aborts the fetch itself, which lands in the existing `catch` as `REFRESH_NETWORK_ERROR`
  (transient). Nothing new: the bounded retry loop terminates, an all-transient exhaustion **keeps
  the stored session**, `getAccessToken`'s `finally` clears `_refreshInProgress`, all waiters settle
  `null`, `sendChat` returns `null` and releases its semaphore slot, and the queue item stays
  queued for retry. A timeout is never turned into sign-out, session deletion, or a dropped message.
- The existing 4xx path (retries through backoff, then clears the session) is unchanged.

## Test

`test/supabaseAuthRefreshTimeout.test.js` (fake timers): stall at connect / stall in body with five
concurrent waiters, per-attempt signal actually aborted, session preserved, zero leaked timers,
healthy refresh afterwards; 4xx and 5xx paths preserved; downstream `sendChat` with
`maxAgentWorkers: 1` unwinds and the next call proceeds. Red on pre-fix code (waiters never settle).

## Not changed

Heartbeat/SSE behaviour, the queue, the non-SSE JSON-body branch in `sendChatCompletions` (which
clears its connect timer at headers and can still stall in `response.json()`) — the last is a known
secondary gap recorded on #55, not part of this fix.
