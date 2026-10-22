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
- **Chat History tab (2026-10-21, issue #147).** Its search and its "delete old" listing asked for
  whole rows too (`limit: 200` and `q: ""` `limit: 500`); "delete old" also saw only the newest 500
  entries, so nothing past them was ever deleted. Both now ask for the shortest preview
  (`SETTINGS.memoryManagement.chatHistoryPreviewChars`, 1). The search still shows each entry
  whole: the page reads each entry it shows on its own (`memoryRead` at the entry's millisecond,
  `toleranceMs: 0`, picked by `memId`), once, so a reply holds one entry or the few written at that
  millisecond. A search that finishes after a later search or a reload does not render
  (`searchToken`), and a page after a later page, search or reload (`pageToken`); a page
  change while the search request is pending pages the results shown, and the search then
  shows (one while the search reads its first page lands on that search's page). A reload's
  own render is not checked, so one answering after a search started can briefly show that
  search's page as previews until its reads finish. "Delete old" lists only the entries older than the cutoff (`to` = cutoff - 1 ms),
  `chatHistoryDeleteFetchRows` (500) a request, and removes each page as it comes; each request
  starts at the last date listed and skips the ids already listed there, so it ends even if a
  removal removes nothing. Pinned by `test/chatHistoryNativeCap.test.js` (TB-193).
  Residual: one entry over 1 MiB on its own still passes the cap when read whole. An older helper ignores `previewChars` and answers whole rows (500 a
  request for "delete old", as before) until it updates.
- **The chat's `memory_read` (2026-10-21, issue #151).** It asked the helper's `memoryRead` for
  every entry within ±`tolerance_minutes` (10 by default), and the helper answered up to 50 of them
  whole, oldest first, so a few long sessions near the timestamp passed the cap with none over 1 MiB.
  It now lists the window newest first with the shortest preview
  (`CHAT_SETTINGS.memoryReadListRows` 20 a request, `memoryReadListPreviewChars` 1; the date-cursor
  and `memId` dedupe of the other listings), stops once `max_turns` entries at or before the
  timestamp are listed (every later one is listed by then, and no centered slice reaches further
  back), takes the `max_turns` centered on the nearest entry (at most `memoryReadMaxTurns`, 50, the
  old read's own cap), and reads each whole by `memoryRead` at its millisecond (`toleranceMs` 0,
  one request per millisecond, picked by `memId`; one removed since the listing is left out). A
  dense window now centers on the timestamp too: the old read answered only the window's oldest 50.
  A `max_turns` that is not a number gets 20 (it used to lift every bound). Each read at one
  millisecond needs the helper to choose rows from `memory_meta` first: the shipped
  `memory_read_by_timestamp` joined from `memory_fts` and so scanned the whole memory per read
  (about 0.13 s at 1 GB, 20 reads 2.6 s), fixed in native-fts with the listing's `CROSS JOIN`;
  that release goes before, or with, this change. Pinned by `test/memoryReadNativeCap.test.js`
  (TB-194). Residuals: one entry over 1 MiB, or many
  long ones written at one millisecond, still pass the cap when read whole (the helper reads by
  date, not id); an older helper ignores `previewChars` and lists whole entries, 20 a request (it
  read up to 50 before).
- **Not on other clients.** Voice reads the helper's replies over its own pipe with no such cap, and
  iOS reads its own database.
