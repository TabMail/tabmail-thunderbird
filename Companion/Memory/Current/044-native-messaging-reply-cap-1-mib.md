# A helper reply over 1 MiB disconnects the native FTS helper

Recorded 2026-10-19. Found in the tier-1 review of the no-query `memory_search` listing.

- **The cap.** Gecko caps each message from a native app to the extension at 1 MiB
  (`MAX_READ = 1024 * 1024`, the default of the pref
  `webextensions.native-messaging.max-input-message-bytes`, in `NativeMessaging.sys.mjs`; MDN Native
  messaging: "The maximum size of a single message from the application is 1 MB"). Thunderbird 140
  to 158 do not change the pref, and the add-on does not either.
- **What an over-cap reply does.** `NativeApp._startRead` throws, and `_cleanup` disconnects the port,
  closes the helper's stdin and kills it after 3 s. In the add-on, `onDisconnect` marks the helper
  missing (the recheck alarm, the install prompt), rejects every pending RPC with "Native helper
  disconnected" (searches, index writes, reconciliation pages), and the next RPC reconnects (the update
  check, `init`, the embedding-model load) unless the 60 s reconnect cooldown refuses it first.
- **Who is exposed.** The helper sends a whole result as one message (`native_messaging::write_json`,
  no chunking). Memory rows carry their full `content` (stored at full length by design), so a memory
  reply grows with the rows asked for. native-fts ADR-NF-006 already designs its folder membership
  summary under this cap.
- **The rule.** Size every helper request that returns full rows so its reply stays well under 1 MiB.
  The no-query `memory_search` listing fetches at most `CHAT_SETTINGS.memoryListMaxResults` (100, five
  pages) instead of the search prefetch (2000), pinned by `test/memoryListingTransport.test.js` (TB-069),
  which runs the production settings against a fake helper that refuses an over-cap reply.
- **Still open (not in this change).** A row-count bound is not a byte bound: 100 very large rows (the
  older whole-session rows) can still pass the cap. The query path's prefetch (up to 2000 full rows,
  relevance-filtered) and Chat History's "delete old" listing (`q: ""`, 500 rows) carry the same
  exposure. A byte-safe reply would need the shared helper to return previews or byte-bounded pages.
- **Not on other clients.** Voice reads the helper's replies over its own pipe with no such cap, and
  iOS reads its own database.
