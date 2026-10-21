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
- **Previews (owner, 2026-10-20: "Helper previews").** A reply of 6 whole turns still passed the cap
  when they averaged ~170 KB, and a query search asked for 2000 whole rows. native-fts `memorySearch`
  now takes `previewChars` (ADR-NF-012): each result's `content` and `snippet` come back cut to that
  many characters; stored rows stay whole and `memory_read` still returns the whole exchange.
  `memory_search` asks for the 400 characters it shows (`CHAT_SETTINGS.memoryPreviewChars`), on the
  listing and on a search, through `fts/engine.js` and `nativeEngine.js`.
- **Query cap (owner, 2026-10-20: "Top 100 matches").** A search fetches its 100 best matches
  (`CHAT_SETTINGS.memorySearchMaxResults`) in one request, 5 pages of 20, in place of the email
  search's prefetch (2000). Ranked results cannot use the date cursor, so a search is not paged
  through the helper. 100 previews of 400 characters (content and snippet) stay far under 1 MiB.
- **A listing ends there too (2026-10-21, review).** The listing stops at
  `memorySearchMaxResults` turns, as a search does, so `page_index` far past the end lists at most
  100 turns (20 requests) and answers with the last page, not the whole memory one request at a
  time. Once it has ended it gives `totalPages` and `totalItems`.
- **Older helper.** A helper without `previewChars` ignores it and returns whole rows, as before;
  Thunderbird updates its helper itself on connect (no `MIN_HOST_VERSION` change). Until that update,
  a reply of very long rows can still pass the cap.
  With a helper from before the dated-search and listing fixes (native-fts ADR-NF-012 amendment,
  2026-10-21) two more effects hold until it updates: a dated query of 100 can lose in-range
  matches (that helper keeps its best 100 before dropping those outside the dates; at 2000 its
  vector search failed and it fell back to keyword-only, which kept them), and every listing request
  reads the whole memory's content (1.5 to 4 s per request at 1 GB). **Release order:** native-fts
  with that amendment ships before, or with, this Thunderbird change.
- **Pinned** by `test/memoryListingTransport.test.js` (production settings; the fake cuts to
  `previewChars` and refuses an over-cap reply; listings up to 200 sessions of 200 KB, searches of
  3000 matching 1 KB exchanges and 200 matching 200 KB sessions; against an older helper that
  returns whole rows, listings of 3000 exchanges of 1 KB and 300 sessions of 100 KB and a search of
  3000 matching 1 KB exchanges), `test/chatTools.test.js` (the request shape, the listing ending at
  `memorySearchMaxResults`), `test/nativeOptimizeContract.test.js` (the background command) and
  `test/memorySizeLimit.test.js` (the native wire).
- **Still open (not in this change).** Chat History's search (`limit: 200`, shows each row's whole
  content) and its "delete old" listing (`q: ""`, `limit: 500`, uses only `memId` and `dateMs`) still
  ask for whole rows; issue #147.
- **Not on other clients.** Voice reads the helper's replies over its own pipe with no such cap, and
  iOS reads its own database.
