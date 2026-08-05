# Flaky "Unhandled Rejection: indexedDB is not defined" in full-suite vitest runs (fixed)

> Routed out of `PROJECT_MEMORY.md` § Recent Discoveries → 2026-06-10 by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `PROJECT_MEMORY.md`.

<!-- BEGIN PRESERVED BLOCK -->
- `agent/modules/idbStorage.js` created `dbPromise` EAGERLY at module load; in vitest node workers (no `indexedDB` global) the executor's ReferenceError rejected a promise with no consumer → intermittent run-level "Unhandled Errors" attributed to whichever test file (usually `chatTools.test.js`) was running. **No caller try/catch can intercept this** — module evaluation succeeds, only the orphan promise rejects. Fix: defer creation to first `withStore()` call (`getDb()` memoized), so an awaiter exists the moment the promise is created. Pattern rule: **never create a module-level promise that can reject before any consumer attaches**. Regression tests: `test/idbStorage.test.js` (mutation-verified: 2/4 fail against the eager version).
<!-- END PRESERVED BLOCK -->
