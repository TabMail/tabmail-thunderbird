# email_search sorts in the helper, then pages its 100 best matches

Recorded 2026-10-23 (issue #150).

- **Before.** `email_search` asked the helper for page size x `searchPrefetchPagesDefault` (100)
  results, capped at `searchPrefetchMaxResults` (10,000): 2,000 with the page of 20. The helper ranked
  them by relevance, and the tool then sorted that list by date (`date_desc` by default). So a date sort
  showed the newest of the best 2,000 matches, not the newest match, and a hybrid search of 4 x 2,000
  vector neighbours ran into sqlite-vec's maximum `k` of 4,096 (tabmail-native-fts#20).
- **Now.** The helper sorts every match before it takes the limit (tabmail-native-fts#46, ADR-NF-017):
  `sort` is `relevance` (the default), `date_desc` or `date_asc`; relevance ties go newer first, a date
  sort's ties go to the better match; a date sort reads up to 4,096 candidates per leg, and a query of
  only `from:`/`to:`/... fields is answered by keyword over every match. `email_search` passes its
  `sort` through `fts/engine.js` (`search` command) and `nativeEngine.js` (`search` RPC), asks for
  `CHAT_SETTINGS.emailSearchMaxResults` (100), keeps the helper's order, and serves pages of
  `searchPageSizeDefault` (20) from that list. Past 100 the agent refines the query or narrows the
  dates; it does not page deeper.
- **Default and unknown sort.** No `sort`, or one the tool does not know, is `relevance` (it was
  `date_desc`). The backend's `email_search` from client 1.9.3 says so; a client before 1.9.3 keeps the
  old description (`date_desc` default). So the release carrying this must be numbered 1.9.3 or later.
- **Same number everywhere (owner 2026-10-22): 100.** `memorySearchMaxResults` was already 100;
  `nativeEngine.js` `search` and `memorySearch` default to 100 when a caller gives no limit. The dead
  `searchDefaultLimit` (5) and `searchMaxLimit` (50) are deleted, as are the two prefetch settings.
  The helper's 512-result cap is a safety limit, not the target size. The Chat History tab's search
  asked for 200 (memory 044); it now asks for `CHAT_SETTINGS.memorySearchMaxResults`, five pages of
  20, the same number as the chat's `memory_search` (its "delete old" listing is a listing, fetched
  `chatHistoryDeleteFetchRows` at a time, and is unchanged). Pinned by `test/chatHistoryNativeCap.test.js`
  TB-193.
- **Reply size.** 100 email results (headers and a snippet each) stay far under the 1 MiB
  native-messaging cap (memory 044); before, 2,000 did too.
- **Older helper.** A helper from before #46 ignores `sort` and answers in relevance order, so until
  it updates (Thunderbird updates its helper itself on connect) a date sort lists the best 100 in
  relevance order. **Release order:** native-fts with #46 ships before, or with, this change.
- **iOS** does the same in its own search (tabmail-ios#265, ADR-IOS-094).
- Tests: `test/chatTools.test.js` TB-062b (the sort asked, relevance by default; the fetch size from
  the setting; the helper's order kept for every sort; paging ends at the last page),
  `test/nativeOptimizeContract.test.js` "email search command", `test/memorySizeLimit.test.js`
  "native email search wire" and the memory search default, `test/emailSearch.test.js`
  (`normalizeArgs`), `test/chatConfig.test.js` "search fetch size".
