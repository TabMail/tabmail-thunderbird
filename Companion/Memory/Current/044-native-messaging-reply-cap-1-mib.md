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
  The no-query `memory_search` listing is fetched a few turns at a time
  (`CHAT_SETTINGS.memoryListFetchRows`, 5, independent of the 20-turn page): each request asks for
  the newest turns no newer than the last one listed (`to` = its `dateMs`, inclusive, in ms), skips
  those already listed at that millisecond by `memId`, and takes one extra turn to know whether more
  follow. Pinned by `test/memoryListingTransport.test.js` (TB-069), which runs the production
  settings against a fake helper that refuses an over-cap reply, including 300 whole sessions of
  100 KB listed six pages deep. *(Superseded 2026-10-20: the first fix fetched at most
  `memoryListMaxResults` (100) rows in one reply; a row-count bound is not a byte bound, so it was
  replaced by the paged fetch on the owner's "shouldn't we be doing pagination?")*
- **Still open (not in this change).** A reply of 6 turns still passes the cap if those turns average
  ~170 KB (very long whole-session rows). The query path's prefetch (up to 2000 full rows,
  relevance-filtered) and Chat History's "delete old" listing (`q: ""`, 500 rows) carry the larger
  exposure; ranked results cannot use the date cursor, so paging them needs an `offset` (or previews)
  in the shared helper, an owner call.
- **Not on other clients.** Voice reads the helper's replies over its own pipe with no such cap, and
  iOS reads its own database.
