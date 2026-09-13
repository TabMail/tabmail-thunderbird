# Action mutations have one owner

Status: implemented, 2026-09-12.

`agent/modules/actionCache.js` owns action payload and metadata writes, removals, and full-cache wipes. Every payload mutation runs on its serial queue: resolve exact-folder message identities, commit IDB, project the new action (empty string for removal) to all matching native headers, await chip refresh, then schedule sorting if the payload value changed. Metadata touches do not repaint or restart sorting. The existing trailing-edge 30-second sort policy remains separate from painting.

Automatic work carries an in-memory epoch/sequence token from its first queue attempt, reused across retries and merges. Manual mutations supersede older work; a completed wipe invalidates all earlier tokens. Thread-effective writes derive from current member actions inside the same mutation queue, so callers never replay captured classifications.

Action payloads and painters are inbox-scoped. Clears can remove stale projections outside inboxes. Unknown folder inventory is not deletion evidence. Failed projections schedule a debounced symmetric inbox backfill, including empty canonical values; startup and account/folder creation also backfill. Only startup requests immediate sorting. Suspend removes the repair timer and creation listeners.

Legacy IMAP action keywords no longer supply painter state. Native tag definitions remain available for action colors. Table self-healing covers the entire rendered pool; card teardown respects the installed wrapper's owner.

Validation is recorded in `TESTS.md`. The native projection is a render cache; IDB remains canonical.
