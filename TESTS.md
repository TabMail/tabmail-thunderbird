# Thunderbird Extension — Test Reference

> The client-side extension is highly testable despite being a browser extension. ~50% of the codebase is pure logic.

---

## Test Files

| File | Tests | Coverage Area |
|------|-------|---------------|
| `test/acknowledgments.test.js` | 22 | Third-party credits and the settings page's Acknowledgments dialog: every vendored file under `compose/libs/` and `chat/libs/` is in `THIRD_PARTY_LICENSES.md`, every file it names exists, each third-party component ships its upstream license text byte for byte (pinned SHA-256), each recorded version and copyright line is the one the shipped files carry, nothing more of pdfjs-dist ships than the parts credited, and the dialog lists exactly those components with the same name, upstream, license and copyright; through the real `initConfigPage` on the real `config.html` the footer link opens the dialog below every section with the iOS intro line, its heading as its accessible name and every component (once, also when reopened) without touching storage, network or other handlers, each upstream link opens in the default browser and its navigation is cancelled during the click (a failure is logged), Done and a backdrop click close it, a click inside it does not, and other controls (Refresh) still reach their own handlers; its padding sits on its content wrapper (so a click on the dialog itself is a backdrop click), and its colors are palette variables, with no fallback, defined for both themes |
| `test/xpiContents.test.js` | 48 | What the XPI contains: the tracked files web-ext packs (web-ext-config.mjs plus web-ext's defaults) are exactly the runtime folders, the manifest and the license notices; no test, repository document or developer note ships, every file in a runtime folder except developer notes does (pdf.js's worker and CMap license among them), so do the prompt documents and every file the manifest names; the config module exports only `default` with only `ignoreFiles` and .web-extignore is gone; `isIgnored` agrees with web-ext 9.1.0's own verdicts on 31 cases (case, dot names, top-level globstar, matched folders, a name that only starts with the pattern) and `globToRegExp` refuses syntax it does not read; `xpiProblems` reports every excluded file and each missing notice from an explicit list; `scripts/check-xpi-contents.mjs` passes a clean built XPI and fails one with an excluded file or without a license notice, naming the file, also when run through a symlinked path; exit 2 without a path and 1 on a file that is not an XPI |
| `test/historyFormatting.test.js` | 52 | The Chat History tab's pure helpers: `formatSessionTime`, `escapeHtml`, and `highlightSearchTerms` (#158): the highlighted HTML shows the entry's text exactly, every mark is a top-level `search-highlight` span whose only attribute is that class, holding one search word (two UTF-16 units or more, so one emoji is a word; any case as JavaScript matches it, so `ΣΣ` marks `σσ`), no word is left unmarked between the marks, the longer word wins where two start at one place, a word never matches inside a mark or an escaped character, a query is literal text (brackets, dots, `+`, `?`, `*`, `|`, braces, parentheses, `$`, `^`, backslash), and entity names typed as text stay text, in the marks too (the issue's natural queries, markup-like words, regex characters, astral and Greek letters, and 3000 seeded texts and searches) |
| `test/deviceSyncVectors.test.js` | 102 | Shared Device Sync v2 vectors (byte-identical with iOS): labelled-bullet merge, capture, add, dedup, reset, render, wire |
| `test/promptSemaphore.test.js` | 22 | DS-SEMAPHORE/DS-LEASE: one holder; a caller whose lease ran out releases nothing when it finishes (the holder after it keeps the semaphore and the next in line waits for that holder); request order (callers wait in line at the background, first come first served across the background, the prompts page and a chat window; a caller asking as the holder lets go still waits behind the line; a waiter whose `acquireWaitMs` ran out leaves the line refused as busy and is never handed the semaphore; a head whose caller has gone loses it with its lease and the next in line gets it; a sign-out completes at once with callers in line); a nested call waits its wait and is refused; lease expiry is no counter change, sign-out never reaches a holder |
| `test/gestureOrderInversion.test.js` | 4 | Request order end to end: a page delete then a tool add, and a tool add then a tool delete, of one knowledge-base line, the older gesture waiting while the store is held; the line ends as the later gesture left it (red on the client-backoff semaphore: `saved, unchanged` and `saved, not found`), with in-order controls |
| `test/promptStoreWriters.test.js` | 34 | Every writer through `withPromptStore`; refines read and write in separate holds (DS-AI); page edits against the labels shown (DS-DISPLAYED); chat tool `editText` busy answer |
| `test/promptStoreWritersSync.test.js` | 44 | Writers next to a peer's bullets: text written as read (DS-TEXT), skeleton kept (DS-SKELETON) |
| `test/promptStoreInterruptions.test.js` | 47 | DS-COUNTER moves only on a saved change, and on every accepted restore; DS-RECEIVE drop at connection end, arrival order, waiting bound (parts of incomplete snapshots counted), a stuck apply never holding up the next connection; a field read past its lease refused; the prompt getters never reading storage themselves; DS-HISTORY reset/merge records, including a first-use reset of each field recording the defaults the store showed (restoring it shows them again) and a knowledge base saved empty recorded empty, read first or reset before any read (controls); a reset, restore or merge whose history save fails leaves the knowledge base as it was, with a working-history merge control; a received bullet_state or prompt_state whose upgrade outlives its lease is applied again and lands with the text from before; DS-LEASE history holds |
| `test/promptsPageLive.test.js` | 89 | The real prompts page on simulated devices: every edit saved at once against the labels shown, Reset, a section Reset on a device with no peer changing only its own section (the user's rules in other sections kept; a text with a section of its own this version doesn't have: Reset offered only on known sections, its lines kept), marker refusals, sign-out keeps every line; Compress and Compact now show their own model request on their button (disabled, caption, spinner) and give it back when it ends |
| `test/promptsPageSync.test.js` | 15 | Prompts page edits converging across two devices |
| `test/shownItemRemoval.test.js` | 4 | Tasks/Reminders delete removes exactly the shown labels; already removed; busy |
| `test/shownItemIdentity.test.js` | 3 | Two knowledge-base bullets that read the same once normalized (curly and straight quotes in a task; the old and new reminder prefixes) are two Tasks/Reminders items built by the real builder and parsers, and deleting one removes only its own bullet on this device and a connected peer; one bullet alone carries its own label (control) |
| `test/shownItemStaleReminder.test.js` | 1 | A cached knowledge-base reminder whose bullet was deleted is still listed but deletes nothing from the Reminders tab: an unrelated note is kept and the answer is already removed (real generator, cache, builder and prompt store) |
| `test/reminderBuilder.test.js` | 39 | Each KB reminder carries the labels of its own bullet only (same text, other date) |
| `test/reminderHashMigrationSync.test.js` | 2 | The reminder list moving a disabled entry to its shared hash, from the background and the chat window: stamped in its write, sent once, taken by a peer |
| `test/refineQueueAcrossReset.test.js` | 4 | DS-REFINE-QUEUE: a refine queued before a reset runs after it; one read before it is refused |
| `test/deviceSyncRulings.test.js` | 40 | Upgrade, unsaved upgrade, marker refusals, the writer name never stored (DS-NAME), routing of the prompt-store message; a history restore of the writing style and the action rules brings back the entry's rules and keeps this device's own leading and closing text (DS-SKELETON) |
| `test/deviceSyncFollowsAccount.test.js` | 53 | Every path that changes the signed-in account (popup sign-in, automatic re-sign-in in the background or a chat window, a token refresh for another account in the background or a page, a refused refresh, sign-out): at the session write the device has left the old account's devices and their late message is not applied; afterwards nothing it sends reaches them, and it syncs with the new account's; same-account controls keep the connection; the change is one step: a connect asked for while a sign-in or a sign-out writes the session (and at seeded points of a write) never connects as the old account, a sign-out whose session read fails still closes Device Sync, a failure leaving the old devices still stores the new session, a sign-out asked for during a sign-in's write lands after it, a failed write releases the connects waiting for it and does not stop the next, a sign-in whose session needs a refresh to connect finishes, and a sign-in whose session read fails still leaves first. The stored session is the only truth (#201, #203): a refresh (background or page, answered or refused) that finishes after a newer sign-in to any account or a sign-out stores nothing, is sent once, and its callers get the session stored now or none, with Device Sync staying on the newer account; a refresh whose compare cannot read the stored session stores nothing; callers of a refresh that finishes after a sign-in with an expiring session get that session refreshed or none, never the expired token; a refresh whose write fails answers no token to any caller, is not sent again, and the next call refreshes the session still stored; a page's refresh whose reply arrives after a sign-in to another account answers that account's token; a refused refresh whose clear fails answers none; a call runs at most one refresh (when its refresh finishes after a newer session that itself needs refreshing it answers none, and the next call refreshes that one); a call that arrives after an older refresh finishes joins the newer session's refresh already under way; control: a refresh with nothing newer stores and answers its session |
| `test/backgroundSessionHost.test.js` | 2 | The background makes itself the one session writer when it loads, and its message listener stores a page's session write, moving Device Sync to the new account's devices |
| `test/deviceSyncReceiveConnection.test.js` | 9 | Sign-out never waits; a section Reset reads its defaults inside its hold, so a whole-field reset and a newer line, or a history restore emptying the section (writing style and action rules), asked for meanwhile land after it; Sync Now on a connected pair sends the three bullet fields, so a note whose send was lost reaches the peer; a refine answering after sign-out is saved |
| `test/busyReplayLease.test.js` | 5 | A busy message applies once a stuck holder's lease ends; a malformed identity dropped before it waits (DS-VALIDATE) |
| `test/taskCacheSemaphore.test.js` | 6 | The task-result cache changed only in a hold of the prompt semaphore: a local result or clean-up during a peer merge keeps both; a merge past its lease saves nothing and is applied again |
| `test/interruptionSweep.test.js` | 8 | Interruptions at every await of the store's operations (lease expiry); a whole-field reset of the knowledge base, the writing style and the action rules held past its lease at each storage read and write never erases an edit saved after it, and resetting again clears it (a reset ignoring its lease is detected in all three) |
| `test/signedOutLocalEdits.test.js` | 8 | Signed-out edits saved with their history |
| `test/signedOutScreens.test.js` | 6 | Signed out, every screen shows and edits what is on this device |
| `test/noWipeFence.test.js` | 5 | Nothing removes the prompt fields or their history |
| `test/promptStoreFence.test.js` | 3 | The three fields are reached only through the prompt store |
| `test/storageKeyOnlyReads.test.js` | 2 | Diagnostics read storage by key, never the whole of it |
| `test/kbReminderGenerator.test.js` | 10 | Reminder parsing from KB content |
| `test/patchApplier.test.js` | 13 | Markdown patch application (add/remove lines) |
| `test/utils.test.js` | 159 | normalizeUnicode, date formatting, isInboxFolder, email extraction, escapeHtml |
| `test/chatTools.test.js` | 46 | Chat tool interface, validation, specific tool behavior |
| `test/deviceSync.test.js` | 31 | State merge, CRDT, echo prevention, virgin device detection |
| `test/ftsFolderReconScheduler.test.js` | 467 | Bounded folder membership reconciliation, epoch-fenced verification, stale/missing repair, interruption and retry, volatile drift-tolerant membership-state pass (no per-page memo writes, convergence under live mail), recovery wakes after native reconnect and folder/account topology changes, total ownerless-row classifier (ghost removal, budget, interrupted terminal page), unloaded-account rows and capped `inventory_retry`, orphan completion across ticks in both modes (the orphan tail's quiet predicate alone refuses completion across a message event after the orphan slice, then a quiet tick completes), legacy orphan reset triggers, zero storage writes on a no-change startup, removal vs racing re-add ordering (real message event, same-page retry; re-add drained in the millisecond of an earlier event keeps its row, with control; owned stale-row removal withheld when the re-add is delivered first or while the removal fence is acquiring, with control), interrupted legacy basis count, startup walk (every startup enumerates every exact-mode folder with zero storage writes; tokenless checkpoints take one full projection, then the UID tier; native removals while closed repaired for every memo shape; equal-count swaps under a frozen HIGHESTMODSEQ repaired after a restart and after a real queue-stuck abandonment), UID-tier membership safety (msgDB replaced during a scan or before the closing read, identical-UID and empty-token swaps, UIDVALIDITY reset at the closing read, yielded attempts across a generation, a walk mark made while a UID-tier attempt is yielded, a yielded attempt whose folder disappears, a late native commit for a removed folder repaired by the state pass expiry, one test per identity/epoch condition, budget-truncated attempts, failed closing read), native digest before one UID enumeration per attempt (stamp invalidated after the terminal page, during the UID scan or the closing read never certifies; another folder's native write at the terminal page, during the UID scan or at the closing read keeps the cold proof with no rescan), walk obligations (failing folder keeps its deferral while another completes, all-folder marks discharged folder by folder, marks during an attempt kept for a later one, unqueued message events, reconnect and capability regain re-walk every folder, overflow marks recorded only for known folders under pressure, pruning), rolling re-walk (late unsignalled removal repaired at the folder's walk and not before, tick not consumed early or under pressure, one idle wake, spaced slices still complete, a multi-page rolling walk spanning a tick walks once, a failing earlier-due folder never starves a healthy one, cadence for N=1/2/71/72/73/500 within period + tick + pass with a burst bound, clustered-offset and topology-driven cohorts within the deadline, cold-start account discovered without an account event), outcome-write retry of a complete session and a change recorded during an in-flight write, a later changed slice resets a complete session and persists it incomplete, capability-keyed quiet veto under 4 s traffic, ownerless-row classification cost (one msgDB Message-ID probe per candidate, no message query, folder URI resolved once per page; a probe interrupted by an event in its folder is retried; a probe that throws, errors or reports an uncertain lookup, or an errored folder state, lets the global query decide; after an uncertain probe a global `absent` removes the row as a ghost and an `error` leaves it unresolved with no cutover); folder-scoped change evidence (cold multi-page missing + stale repair under another folder's mail every 4 s for the whole interval through the real drain and engine wrapper, cold first-page reads equal to a quiet run, inside every native read and local scan page, the same with the other folder prefix-named (`/Cold:Hot`, keys inside the cold folder's raw range), also for the stale direction, colon-bearing Message-ID churn past the ledger cap, unconverted events = every folder, removal-only native change, a native write at the memo reload withholds only its own folder's completion (other folder keeps it), stale direction and stale-owner fences, a same-folder or unattributed re-add between the stale recheck and its removal fence refuses the removal while another folder's write does not, terminal reuse across another folder's write, local ledger eviction floor, a same-folder event after the operation's last own check — checkpoint write, memo reload, UID-tier native-page stamp — withholds completion while another folder's does not, converted and unconverted re-add events for the stale direction; a newer queued intention during a drain retry, or an opposite one in the same millisecond, ends with the index agreeing with the latest event; an older add whose body extraction fails leaves a removal queued during the extraction unmarked; a failed add is dequeued once its retry indexes it; an older add's drain never dequeues a same-type add queued in its millisecond; a delete from `/F` and an add to `/F:Child` sharing one raw key, queued after `/F`'s last own check in the same or a later millisecond, refuse `/F`'s completion until the walk repairs the owner, while an unrelated folder's add leaves it; a stale pass keeps its cursor and removes a ghost beyond the first page while every probe overlaps another folder's native write); the drain-quiet gate defers only the folder a queued update names (a pending add in `/Cold:Hot` never holds `/Cold`'s owed walk; control `/Hot`; an entry with no folder still defers by raw prefix); an unreadable newly inventoried folder (healthy folder's obligation repaired while the new folder fails four ways and the pass re-earns cutover without reading its msgDB; per-row assignment of a new folder's ownerless row, readable or with a failing scan; an unreadable ownerless row never earns cutover); migration never starves a healthy folder's repair (more failing folders than the backoff cap covers, at the production timer cadence; a busy folder written between every slice); a stale pre-upgrade migration record is ignored and dropped on the next memo write; ownerless-row verdicts read only their candidate folders (mail drained into another folder inside every msgDB probe or, after a failed probe, every global recheck still assigns and earns cutover, the row's own folder's mail withholds it, a row classified while foreground pressure rises inside its msgDB probe commits before the tick yields; pressure after a committed assignment or removal keeps the page's cursor and still forces a full replay before cutover; an unresolved verdict read across an event in its own folder is retried, not counted; every row assigned, ghosts removed and cutover earned under recurring foreground pressure that interrupts pages mid-classification; a ghost removal after the page's assignments proceeds on the first slice under other-folder mail — the page's own `/F` assignment never voids its `/F` ghost's removal fence, with the fake's mutators attributed to the native ledger as `ftsSearch` attributes them — and a re-add of the ghost's own key refuses only the ghost row (replayed after the unresolved-retry delay) while a folder rename or an event naming no folder withholds the page; a foreign membership write on the ghost's own key refuses only that row, one on another key in its folder does not, and a write with unknown keys refuses the fence before any assignment commits and the whole page is re-read); membership-state verdicts never outlive their evidence (a row re-added in a folder loaded after the inventory snapshot is kept, owned or ownerless, delivered during the inventory read or the state page; an assignment is not committed when its own key changed while a later row was classified, after its last probe answered, or in its second candidate (refused, then assigned by the delayed replay); a change during the assignment call marks both candidate folders' walks, which repair the owner; every assignment batch is re-checked (two rows per batch in this suite, so a page both shares and crosses batches); within a multi-row batch a row whose own key changed during classification is refused while the batch's other rows and the page's later rows commit (control: unrelated-folder mail commits the whole batch), and a change during the call marks a later row's candidate folders' walks, which repair its owner; a row refused at commit is counted once as unresolved debt while every other row's effect commits, and the delayed replay assigns it); exact folder work before global cleanup completes (a capability gained or lost inside one tick never credits orphan or session completion, alternating pass/folder turns, a no-target turn runs the pass or waits for the unresolved retry with its wake armed, turn reset on reconnect and generation retirement, rolling re-walk before cleanup), affected-folder handoff (retry authorization revoked before a removal, no write without authorization, revocation read/write failure, removal and assignment replies lost, rejected-removal backoff, stale-direction colon overlap), mass-NULL migration cost bound; key-scoped state-pass evidence (MFN ingress records add/delete/move/batch and `<>`-stripped keys before the listener's first await, a high-water-rejected admission records its key, a local key-ledger overflow refuses the page's rows and the replay resolves them, a native key-ledger overflow refuses the removal fence, sustained traffic on one row's own key holds neither a later ghost nor the replay after it stops, steady mail in a ghost's folder and an independent 4-second cadence hold neither the pass, the cleanup nor folder repair); hard floor (a host sleep inside a slice leaves the next wake within `hardFloorMaxElapsedMs`, a legitimately long slice below the clip keeps its full reservation, a backward clock jump stall ends within the bound and a repeat wake does not re-arm the timer); every stale-direction presence recheck carries its folder's WebExtension id, and the classifier's recheck carries the candidate folder's id; one fresh msgDB scan per verification (a three-page folder, tokenless or with a msgDB incarnation token, certifies with the working proof plus one fresh scan; a folder event or a native write in the folder while the fresh digest pages forces a new scan; a completed verification snapshot pinned across a drain is rescanned, so an unsignalled msgDB change is never certified from it; a msgDB replaced with no event while the fresh digest pages is rescanned, and its message is indexed across later startups); membership summary (a clean index earns cleanup from one summary with no walk, once per pass and once more after the walk period; ownerless or loaded-account stray rows, an error or timeout, or no capability fall to the walk, and the repaired index's replay pass earns cleanup from its summary; an unloaded account's rows publish cleanup with the unloaded count and hold session completion; a topology event or reconnect during the call publishes nothing; a lease or generation loss keeps the pass's one attempt; pressure during the call still publishes; the call spends the slice's native page; its wall time and aggregate counts are logged with no identifiers, also on failure); a backward wall-clock jump is recovered by the already-armed timer alone, with no further wake request, within `hardFloorMaxElapsedMs` |
| `test/nativeFtsProfileBinding.test.js` | 6 | Native FTS helper bound to this profile (ADR-025): `init` carries this profile's data directory as `profilePath`; no `init` when the directory lookup throws, is empty or is missing (status `missing`); `tmMsgNotify.getFtsDataDir` path and schema entry |
| `test/tmMsgNotifyFolderState.test.js` | 7 | `getFolderState` msgDB identity: `incarnationToken` created once under `ensureIncarnationToken`, never created or overwritten without it, generator/setter failures leave it empty; folder scans open with the stored HIGHESTMODSEQ; no msgDB evidence for non-IMAP folders; `probeMessageIds` reports absent and `IMAPDeleted` ids as missing and a failed lookup as `uncertain`, never missing |
| `test/ftsOperationCoordinator.test.js` | 36 | Writer-preferred FTS coordinator, scan status ownership, folder-scoped membership change ledger (per-folder stamps, wildcard, partial-commit and fenced attribution, eviction floor, reset), registered real-folder universe (colon-heavy churn, attribution to every registered folder whose key range holds a key, none before the first inventory, key read scopes unfiltered, explicit owners, unsplittable keys, registration, record-time resolution, universe = latest inventory with re-recording on return); exact key ledger beside it (attempted keys recorded on success, failure, partial commit and inside a fence; clear = wildcard; a keyless mutation passes the key floor; key and folder eviction floors independent; a `{keys}` fence passes writes on other keys) |
| `test/ftsMembershipScopeAttribution.test.js` | 40 | Engine wrappers attribute native mutations to folders: indexBatch/assign owners (an index sent with folderIds and an assignment touch their owner and not a parent whose key range holds the key; a legacy-shape or unsent index is attributed by key, also through a fence), the wrappers apply the native write and return its result against a stateful helper, and each propagates a native failure while still recording the change, removeBatch to registered folders whose key range holds the key incl. parent ranges, clear/unsplittable = wildcard, registered universe, no key attribution before the first inventory, a batch of long colon-heavy keys in time bounded by the registered paths, fenced calls; every wrapper records the exact keys it attempts (capable, failed and legacy index, assignment, removal, fenced removal); removals attributed to helper-reported owners (`/Cold:Hot` removal leaves `/Cold` untouched, mixed owned/absent/duplicate batch, empty removal records keys only, fenced removal attributed at fence completion) with key-range attribution kept for legacy, malformed, ownerless-bearing, failed and timed-out replies |
| `test/folderMembershipIdentity.test.js` | 7 | Opaque `tm-folder:v1:` identity, parsing back only identities it made, first-colon account end of a raw key, no split, folder key-range prefix incl. child folders |
| `test/llmClient.test.js` | 29 | JSON/SSE response parsing, tool call parsing, conversation state |
| `test/llmRequestHeaders.test.js` | 1 | Every completions request (the first send, the retry after a rate limit, the retry after a new sign-in) carries `X-Client-Protocol` (the protocol version the backend picks prompts and chat tools at) beside `X-Client-Version` (TB-085) |
| `test/pdfText.test.js` | 28 | Bundled pdf.js text extraction from generated PDFs: page ranges and caps, output-limit stop/cut (surrogate-safe), CJK via packed CMaps, encrypted/owner-only/malformed, per-call worker terminated at the deadline even when it never acknowledges |
| `test/attachmentReadPdf.test.js` | 40 | `attachment_read_pdf` tool: argument validation, attachment choice and refusals, size limits (inclusive boundary), output format and notes, unreadable pages, production pdf.js + CMap wiring (registration and activity label are in `test/core.test.js`) |
| `test/markdownLinks.test.js` | 25 | HTML links as `[label](address)` (iOS #100 rules) in `stripHtml`, user-written content and FTS extraction; `unwrapMarkdownLinks` display grammar |
| `test/markdownTableCells.test.js` | 16 | A chat reply's Markdown table cell renders its text as a paragraph of the reply does (TB-201) |
| `test/markdownLinkAddress.test.js` | 40 | A chat link is one anchor whose address is exactly the one written, in a paragraph, a table cell and every block a link can sit in (TB-203) |
| `test/extensionPageCsp.test.js` | 76 | The add-on's page policy allows images from the add-on only and no frames, and nothing the pages, their scripts or their stylesheets use is blocked by it (TB-202) |
| `test/icsNotesText.test.js` | 31 | A calendar attachment's notes become their text, read in a document of their own, never as markup parsed into the page (TB-207) |
| `test/threadConversationLinks.test.js` | 4 | Thread bubble bodies show links as labels (HTML and FTS-cache bodies), literal Markdown in HTML and text/plain as written |
| `test/convertedBodyConsumers.test.js` | 4 | Compose edit reads `extractBodyFromParts` text as is (whole link address, text/plain as written, quote split on a link-bearing attribution); a text/plain HTML document is converted |
| `test/emailSelectionTooltip.test.js` | 10 | The chat email selection list's hover tooltip shows an email's todos and summary as written text (TB-205) |
| `test/emailSelectionTooltipCallers.test.js` | 4 | The email selection list the archive and delete flows show: each row's tooltip shows its own todos and summary as text, and selection keeps working (TB-205) |
| `test/summaryBubbleText.test.js` | 15 | The summary bubble above a message shows its todos, summary or notice as written text, sent through the message display's renderer and before the message body exists (TB-206) |

---

## Testability Tiers

- **VERY HIGH:** Chat tools (31 pure `run()` functions), utility functions, merge algorithms
- **HIGH:** Agent modules (config-driven logic), FSM state machine, KB reminder parsing
- **MEDIUM:** FTS modules, compose helpers (mock-dependent)
- **LOW:** Background scripts, experiment API wrappers (heavy browser dependency)

**Framework:** Vitest (ESM-native, Jest-compatible, minimal config)

---

## 1. Tier 1 — Pure Logic (No Mocks)

### 1.1 Labelled bullets (agent/modules/bullets.js, agent/modules/bulletSync.js) ✅

The three-way text merge (`bulletMerge.js`) was replaced by labelled bullets: each bullet carries its writer's label, a merge unions labels with a seen map, and an edit deletes only the labels it showed. The cases are the shared vectors in `test/device-sync-vectors.json`, run by `test/deviceSyncVectors.test.js` (byte-identical with iOS).

### 1.2 KB Reminder Generator (agent/modules/kbReminderGenerator.js) ✅

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-020 | Parse `- [reminder] 2026-03-15 10:00 Review PR` | Structured reminder object | Happy path |
| TB-021 | Parse legacy reminder format | Backward compatible | Legacy |
| TB-022 | Parse reminder without time | Date-only reminder | Optional time |
| TB-023 | Parse reminder with timezone | Timezone extracted | Timezone |
| TB-024 | Invalid date format → skipped | No crash | Robustness |
| TB-025 | Empty KB content | Empty array | Edge case |
| TB-026 | Multiple reminders in KB | All parsed | Batch |
| TB-027 | Reminder in middle of other KB content | Only reminders extracted | Filtering |

### 1.3 Utility Functions (utils.js) ✅

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-030 | normalizeUnicode → NFC normalization | Correct normalization | Happy path |
| TB-031 | Date formatting functions | Correct output formats | Happy path |
| TB-032 | isInboxFolder detection | True for INBOX variations | Detection |
| TB-033 | Email address extraction from header | Correct parsing | Parsing |
| TB-034 | String truncation with ellipsis | Correct length | Formatting |
| TB-035 | HTML entity escaping | Safe output | Security |
| TB-193 | `stripHtml` writes `<a href>` as `[label](address)` with the iOS #100 escapes (label whitespace by grapheme, Markdown punctuation, `&amp;`; address Cc/Cf/White_Space percent-encoded, `\ ( ) < > ;` escaped); empty href keeps the label; image link keeps the address; hidden link dropped; reaches `extractUserWrittenContent` and FTS `extractPlainText` (`test/markdownLinks.test.js`, red-first: 10 of 12 stripHtml cases fail on base; 10 mutants killed) | Agent and search read link addresses (#162) | **Red-first** executed |
| TB-194 | `unwrapMarkdownLinks` shows a link as its label (iOS port: one-line grammar, escapes reversed, leftmost scan, linear on unclosed-opener runs); card snippets past an image-heavy newsletter's leading tracking links and thread bubbles (HTML and FTS-cache bodies) show labels, a text/plain bubble as written (`test/markdownLinks.test.js`, `test/cardSnippetWakeProvider.test.js`, `test/threadConversationLinks.test.js`) | Displayed text unchanged by #162 | **Red-first** executed |
| TB-196 | `memory_search` and `memory_read` (#155) answer in every context that runs them: the chat page (asks the background) and the background, which owns the helper and whose own runtime messages never reach it, both with no other page open (send rejects) and with a page open that does not answer (send resolves undefined); the real FTS command handler over a stand-in helper. A query search, a listing and a whole read give the helper's answer; a helper that is down, and a whole read that fails after the listing succeeded, read as `memory search failed` / `memory read failed` with the helper's message, the same in every context; the helper is asked exactly the same (query, dates, limit, previews, read tolerance) from the background as from a page. Red on the pre-fix tools (8 of 12 at the time, every background case); 11 mutants killed: raw `sendMessage` for the search, the listing or the read, no `{error}` from a thrown background search, background search without previews, dates, limit or query, background read with the default tolerance, background listing without previews, dates or limit, a failed background read taken as none found (`test/memoryToolsContext.test.js`) | Same answer in every context | Correctness |
| TB-197 | Headless runs (#171) never answered from another run's search sessions: through the real `executeToolsHeadless` and the real `memory_search` (query and listing), `email_search`, `inbox_read`, `calendar_search` and `calendar_read`, over stand-ins for the index, inbox and calendar that change between runs, a later run (its own isolated context) sees what was added after an earlier run; a run that starts while another is paging, and a new chat turn, leave that run's pages exactly its first inbox read; a headless run neither reads nor clears the chat window's turn; a batch without a run context shares sessions with nothing; a finished run's sessions are released (`WeakRef` + `gc()`); through the real check-in task runner (`_executeTask`) and reply generator (`cacheReply`), each run pages its own first inbox read while the inbox changes mid-run and the next run reads afresh. Red on the pre-fix code (all 10 of the first round); 14 mutants killed: no run passed, a fresh store per batch, sessions ignoring the run, a turn reset clearing runs, each of the four tools on the turn's sessions, `calendar_read` dropping its options, a strong `Map` for the run stores, a check-in context shared across tasks or wrapped per batch, a reply context shared across replies or wrapped per batch (`test/headlessToolSessions.test.js`) | Each run its own results | Correctness |
| TB-195 | Consumers of `extractBodyFromParts` (summary, action, reply, prefilter, compose edit) pass its plain text on without a second HTML parse: `&copy=` in an address, a label's `\<g\>` and a text/plain `<bob@example.com>` survive; a text/plain HTML document is converted; a bubble's literal `[x](u)` in HTML stays; a snippet reads past 400 image links (`test/convertedBodyConsumers.test.js`, `test/summaryGenerator.test.js`, `test/threadConversationLinks.test.js`, `test/cardSnippetWakeProvider.test.js`, red-first: 6 fail on d61cabe0) | Agent reads links unaltered; display keeps sender text (#162 review) | **Red-first** executed |

### 1.4 Patch Applier (agent/modules/patchApplier.js) ✅

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-040 | Apply markdown patch (add lines) | Lines added | Happy path |
| TB-041 | Apply markdown patch (remove lines) | Lines removed | Happy path |
| TB-042 | Apply patch to empty document | Patch is entire document | Edge case |
| TB-043 | Conflicting patch (context doesn't match) | Error or best-effort | Conflict |

---

## 2. Tier 2 — Chat Tools (Uniform Interface, Mock Browser APIs) ✅

All tools export `run(args, options) → Promise<result>`. Mock `browser.*` APIs for testing.

### 2.1 Tool Interface Tests ✅

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-050 | Each of 31 tools exports `run` function | Function exists | Contract |
| TB-051 | `run()` returns JSON-serializable result | Valid JSON | Contract |
| TB-052 | Missing required args → error in result | Descriptive error | Validation |
| TB-053 | Invalid arg types → error | Type checking | Validation |

### 2.2 Specific Tool Tests ✅

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-060 | reminder_add → validates date format (YYYY/MM/DD) | Correct validation | Business rule |
| TB-061 | reminder_add → deduplication check | No duplicate reminders | Business rule |
| TB-062 | email_search → query construction | Correct filter params | Query |
| TB-062b | email_search → sort in the helper (#150): the sort asked (relevance by default, unknown = relevance), fetch size `emailSearchMaxResults` whatever the page size (the shipped 100 in five pages of 20, `emailSearchFetchSize.test.js`), the helper's order kept for every sort, paging ends at the last page; the `search` command answers each sort within the date range asked, and the native wire carries every sort with both date bounds and answers the helper's matches, default limit 100 | Sort before the limit | Query |
| TB-062c | email_search / memory_search → a search sends only its own FTS request (`search` / `memorySearch`), with and without not-ready retries, for a query and a memory listing; from the background (`emailSearchContext` / `memoryToolsContext`) a search sends no runtime message (#174) | No message no handler acts on | Query, listing, background |
| TB-198 | `email_search` (#170) answers in every context that runs it: the chat page (asks the background) and the background, which owns the helper and whose own runtime messages never reach it, both with no other page open (send rejects) and with a page open that does not answer (send resolves undefined); the real FTS command handler over a stand-in helper. A search finds the mail and keeps the order asked for; a helper that is down reads as `fts search failed: <the helper's message>` in every context; the helper is asked exactly the same (query, dates, limit, sort) from the background as from a page, for each sort, over a range days long so `from` precedes `to` at any hour of the day. Red on the pre-fix tool (9 of 12, every background case); 11 mutants killed: raw `sendMessage`, no `{error}` from a thrown background search, background search without sort, dates or limit, or ignoring the query, the whole error in place of its message, sort forced to relevance in the background, `from`/`to` swapped in the background call or in the request (`test/emailSearchContext.test.js`) | Same answer in every context | Correctness |
| TB-199 | The background answers a page's FTS request while the helper is missing, connecting, or installed after startup (#175): the real FTS engine and command handler over a stand-in helper. Missing at startup: `email_search` and `memory_search` from a page fail at once with the helper's error, as from the background, on the first request (no not-ready retries); a page's `memoryClear` is answered `{ error }`, never left unanswered (which "Clear chat history" read as success). Connecting: a page request waits and gets the helper's answer on its first request. Installed after startup: once the engine starts, a page gets results through one handler. Red on the pre-fix engine (4 of 7, every page case while missing or connecting) (`test/ftsHelperDownAnswers.test.js`) | No unanswered FTS request | Correctness |
| TB-200 | The same over the real native adapter (`nativeEngine.js`) and a stand-in helper port (#175). A page's `memoryTrim` while the helper is missing is refused with the helper's error and memory is unchanged; a page's `memoryClear` while the helper connects stays unanswered and sends nothing until the helper is ready, then clears. The other data commands a page sends (`stats`, `getMessageByMsgId`, `getAttachmentFlags`, `indexBatch`, `removeBatch`, `clear`, `reindexAll`, `memoryStats`, `memoryRead`, `memoryIndexBatch`, `memoryRemoveBatch`): the helper's error while it is missing, nothing sent and nothing changed; the helper's result and its effect once the helper is back, through one handler. One storage failure while the engine starts (reading, or writing, a scan status left by an interrupted session), then storage recovers: the background's real recheck code (alarm and UI probe, run from `chat/background.js`) brings search back through one handler and one helper connection. An interrupted embedding rebuild with incremental indexing off is not shown as running in Settings once the engine starts, and Settings starts no completion poll. Mutants killed: trim left unanswered while missing, clear acknowledged while connecting, only four commands answered before init (11 red), the scan-status normalization before the helper is claimed (both storage-failure cases red), and the normalization deleted (the Settings case red) (`test/ftsHelperDownNative.test.js`) | Startup failure stays recoverable; no request unanswered | Robustness |
| TB-201 | A chat reply's Markdown table cell renders its text as the rest of the reply does: most cases render the same text in a header cell, a body cell and a paragraph and compare the three. Tags written in the text (an image, a frame, an anchor with attributes, formatting tags, closing table tags) show as the text written with no element made; code spans keep their asterisks; a link keeps its address; a contact link, bold, italic and code come out as in a paragraph; a link whose text is code comes out as in a paragraph; a `<br>` and character references still render in a cell; 400 seeded texts of tag, quote, emphasis, code and link pieces (exact integer arithmetic, drawn from the high bits; the test checks every piece is drawn, more than 40 texts hold tag-shaped text, and strong, em, code and an anchor each appear) render the same in both, with only those as elements; each link in headers, rows and two tables keeps its own address or contact; numeric character references (decimal, hex in either case, leading zeros) show as their characters; marker-shaped text naming no fragment the renderer made adds no markup. Red on the code before: 10 of 16. Mutants detected: tags kept as markup, no escape, link and code markup put back before the escape or before emphasis, a contact link, link or code not put back, no italic, character references or `<br>` escaped; headers not processed, a link's or a contact link's index taken as the first, numeric references not kept, code put back before links in a cell; quotes left unescaped is equivalent in element text (`test/markdownTableCells.test.js`) | Cell text renders as the reply's other text | Robustness |
| TB-202 | The manifest's `extension_pages` policy has `img-src 'self'` and `frame-src 'none'` and keeps its other directives; a repeated directive is refused (the browser uses the first). Every shipped HTML page has no iframe, frame, embed or object, and every image, srcset candidate, picture source, SVG image or use, icon, stylesheet and inline or style-element `url()` it names resolves inside the add-on against the page's base address, inside templates too. The page code is what the pages load: each page's scripts and stylesheets (the seven page stylesheets named), the background scripts and every module they import (the vendored PDF library left out). Each script is read as JavaScript: no string or template part holds a data or blob address, an image file from outside, frame markup, an outside image in markup or a style `url()`. Every place a script sets an image or frame source (src, srcset or poster by dot or by name, setAttribute or setAttributeNS of those or of href, Object.assign, new Image) or makes an image or frame element (or one named at run time) is listed with the code it sets, and the list must equal the reviewed one: today ten image sources naming the add-on's own images and one list element. Their stylesheets name only the add-on's images. Each check catches the forms it is for: an outside or leading-space image, a data image, a second srcset candidate, a picture source, an SVG image or use, an outside base, icon or style image, a frame and an embed in markup, and a frame or outside image inside a template; a data image kept in a variable, a remote image set over several lines, frame or image markup, a style image, and a remote image after a quote-bearing regular expression, after a quote in a comment or in a template part, in a script; each source-setting form above and a blob address shown, listed; and the add-on's own images, a stream's `data:` lines, a download and code setting no source pass. Red on the policy before. Mutants detected: the policy before, images from any https address, frames from the add-on, a widening img-src or frame-src before the expected one, a remote or protocol-relative image in a page, a frame in a page, a data image in a variable, a multi-line remote image, a frame set by name and SVG image markup in page scripts, a remote stylesheet background, scanning no scripts, the last of a repeated directive read, a srcset read whole, the base address ignored, a remote icon or frame markup placed after a quote-bearing regular expression, a remote image without a file extension, a data image from a template, a blob address shown next to a download, a remote image in a template element, and the stylesheets cut to one (`test/extensionPageCsp.test.js`) | Pages load only the add-on's own images | Robustness |
| TB-203 | An ordinary https link renders the same markup as before and a click opens its address in the default browser, in a paragraph and a table cell (both pass on the code before too); a click on one whose address holds an ampersand and a quote opens exactly that address. A Markdown link in a chat reply renders as one anchor with only `href`, `target` and `rel`, its address exactly the one written and its label as text, in a paragraph and in a table cell: addresses holding a double quote, a quote then attribute-like text, a single quote, an ampersand and an entity-like `&amp;`, angle brackets, a plain path, a mail address with a quoted subject, and 300 seeded addresses of quote, bracket, ampersand and equals pieces (every piece is drawn, and over 250 addresses differ). The same holds in headings of every level, unordered, ordered and nested lists, a blockquote, a reminder card and a table header, for quoted, ampersand, entity-like, bracketed and already percent-encoded addresses, and a normal https link in each of them opens its address in the default browser. An already percent-encoded https address and an http address render as written and open exactly that address; a mail link opens nothing in the browser, as before. Red on the code before: 7 of the first 11. Mutants detected: the address unescaped, only quotes escaped, everything but the ampersand escaped, quotes decoded in a heading, list item, blockquote, reminder card or table header, a percent-encoded address encoded again (`test/markdownLinkAddress.test.js`) | Link addresses render as written | Robustness |
| TB-205 | The chat's email selection list (`renderEmailSelectionList`) on hover shows an email's todos and summary as text, as the message list's tooltip does: a plain summary and todos render the same markup as before; a summary and todo holding a span with attributes, an image, an anchor, bold and line break tags, or angle brackets, quotes and ampersands show as exactly that text with no element made; only a summary or only todos show only that section (bullet markers stripped from todos; only the bullet separates todos, so an asterisk inside a todo stays in it); neither, or todos of separators only, says "(No details)" with no section; hovering again shows the tooltip once. Red on the code before: 5 of 10 (the plain, single-section, asterisk, no-details and re-hover cases pass on it too). In the lists the archive and delete flows show (from the inbox or a given list), and in a list to select from or only shown, hovering one row, another, then the first again shows each row's own summary and todos as text in the one shared tooltip, placed by its row from the size of the text it then holds and hidden on leaving, and selection keeps working. Mutants detected: the summary or a todo set as markup, "(No details)" dropped, an empty todo list shown, an asterisk taken as a separator, bullet markers kept, classes dropped, an earlier hover's content kept, text set only in a list only shown, the tooltip filled only on the first hover, the tooltip measured before it is filled (`test/emailSelectionTooltip.test.js`, `test/emailSelectionTooltipCallers.test.js`) | Summaries show as written | Robustness |
| TB-206 | The summary bubble above a message (`displaySummary` in `theme/modules/summaryBubble.js`) shows the email's todos and summary, or a notice, as text: a plain summary and todos, a summary alone, no summary ("Analyzing email…"), a todo holding an asterisk (only the bullet separates todos), todos of separators only (inline between the headings, a space each side) and a notice show the same structure as before; a summary, todo and notice holding a span with attributes, an image, an anchor, bold and line break tags, or angle brackets, quotes and ampersands show as exactly that text with no element made; a later summary replaces the earlier one. A summary with its todos, or a notice, sent through the message display's renderer shows and makes the bubble ready; sent before the message body exists, the latest one shows once the body arrives, and only then is the bubble ready. Red on the code before: 6 of 15 of the cases above (the plain, structure, readiness and pending cases pass on it too). Mutants detected: the summary, a todo or the notice set as markup, an asterisk taken as a separator, the separators-only todos dropped or run together with the headings, the bubble left not ready after a summary or notice, content sent before the body never shown or the first instead of the latest kept, a notice kept before the body shown as a summary, the renderer dropping the todos or the notice, "Analyzing email…" dropped, an earlier summary kept, classes dropped (`test/summaryBubbleText.test.js`) | Summaries show as written | Robustness |
| TB-207 | A calendar attachment's notes (`stripHtmlAndNormalize` in `chat/modules/icsParser.js`, for `parseIcsToEvents`' `notes_brief`) are read in a document of their own: a DESCRIPTION or an HTML X-ALT-DESC (which wins over the DESCRIPTION) holding plain text, bold and a line break, an anchor, an image, character references, a styled span, a title before the notes, a whole document with a head, a style part in a head, white space at both edges, or an element of a name no standard knows gives that text (title, head and style text kept, as before; trimmed at both edges), and reading a note never reaches the page: every read of the page's window or document while the notes are read is recorded and there are none (a reach through the page's document, its window, or a document made from the page, each shown to be seen, and a DOMParser document's markup shown not to be), so no note is parsed, copied, adopted or moved into the page by any route; runs of white space become one space; no notes, empty notes and notes of white space or empty markup give an empty brief with no warning; an empty X-ALT-DESC leaves the DESCRIPTION as the notes; notes of one under, at and one over the brief limit, plain or in markup, stay whole, stay whole, and are cut to the limit with the truncation warning. Red on the code before: 27 of 31 (all but the page record's four controls). Mutants detected: notes read in the page's document (as an element or a range's fragment, or copied into it), notes adopted into the page or moved into a page element, notes read in a document made from the page, only the start trimmed, style text dropped, only the body of a whole document kept, markup kept, white space kept, the DESCRIPTION winning over X-ALT-DESC, an empty X-ALT-DESC winning, a cap inside the conversion hiding the warning, a label for empty notes, cutting at the limit (`test/icsNotesText.test.js`) | Notes stay text | Robustness |
| TB-208 | The search helper is used only once it is known to be supported (the Windows self-update cutoff, ADR-023): with the cutoff configured, a helper whose platform lookup rejects or throws is disconnected and never initialized, as is one whose hello fails, and both end as "missing"; a supported Windows helper still checks for updates before it is used, and a failed update-only platform lookup leaves it in use (`test/ftsNativeUnsupportedIntegration.test.js`, against the shipped cutoff). Red before the fix: the platform lookup's failure was taken as the update check's and the helper was initialized. Every native test stub answers `getPlatformInfo`. | Fails closed | Robustness |
| TB-063 | calendar_event_create → required fields | Validation | Validation |
| TB-064 | kb_add → append to existing KB | Content added | Mutation |
| TB-065 | kb_del → remove specific entry | Content removed | Mutation |
| TB-066 | memory_read → format memory entries | Correct output | Formatting |
| TB-067 | attachment_read_pdf → page range, limits and refusals on generated PDFs | Text or a clear error | Business rule |
| TB-068 | attachment_read_pdf → parse deadline bounds the call | Timeout at the deadline, worker terminated | Robustness |
| TB-069 | memory_search → no query (left out, `""` or blank) lists the most recent conversations: empty `q` to a helper-shaped fake (newest first, no snippet, dates and limit honoured), the conversation text shown, newest first, separate pages from one listing; both-sided, from-only and to-only dates sent exactly and kept to, each range its own listing (8 mutants killed: literal `""` refused, no content fallback, reversed, always page one, dates swapped, one-sided dates ignored, dates left out of the listing key, limit 0); the listing fetched a few turns per request (`memoryListFetchRows`), each request starting at the last turn listed, turns sharing a millisecond listed once, a failed request retried on the next call, concurrent calls of one listing taking turns, a query search asking once for its 100 best matches (`memorySearchMaxResults`), every request asking for 400-character previews (`previewChars`) and the background command and native wire passing them on (4 more mutants killed: no previews asked, a query fetching 2000, engine and native wire dropping previews); a date alone is the local day through its last millisecond and a full timestamp reaches the helper to the millisecond (10 more mutants killed: no cursor, no dedupe, limit ignoring ties, one big fetch, stop after the first fetch, day end at its start, day as UTC, bound cut to the second, calls not serialized, empty query refused); a 23-hour and a 25-hour day and one whose midnight daylight saving skips (America/Vancouver, America/Santiago) each exactly that day, and an empty memory ending its listing on page one with no "more pages" (killed: a day as a fixed 24 hours, "more pages" on an empty listing); a listing and a query search in one turn kept apart; each listed conversation's first 400 characters shown; with the production settings, a listing of a large store (3000 exchanges of 1 KB, 1000 of 4 KB, 300 whole sessions of 100 KB, 200 of 200 KB, to its last page) and a search of 3000 matching exchanges of 1 KB or 200 matching sessions of 200 KB each fit Thunderbird's 1 MiB native-messaging cap, against a fake helper that cuts each result to the previews asked and refuses an over-cap reply, and against an older helper that returns whole rows (a listing of 3000 exchanges of 1 KB or 300 sessions of 100 KB, a search of 3000 matching exchanges of 1 KB); a listing ends at `memorySearchMaxResults` turns, a page past its end answering with its last page and the totals, a far `page_index` (1e9) fetching at most a search's worth, and a listing's ties at one millisecond listed once whatever order the helper gives them (4 more mutants killed: no listing end, the end only in the stop check, ties skipped by position, a listing ending at 2000) (`test/memoryListingTransport.test.js`; 4 more mutants killed: no listing bound, listing key ignoring the query, full content shown, 40 characters shown) | Results, no "missing query" | Business rule |
| TB-193 | Chat History tab (#147) on the real page with the shipped settings, against a fake helper that cuts each result to the `previewChars` asked, keeps both date bounds inclusive and refuses a reply over 1 MiB (any other command fails the test). Search (Voice-style previews): 200 matching sessions of 200 KB show the first 400 characters of each entry with an ellipsis, highlighted, paging forward and back, one search request, every reply under a quarter of the cap and memory unchanged; a short entry shows whole, and a helper that ignores `previewChars` still gets the 400-character start; an entry of exactly 400 characters shows whole and one of 401 cut with an ellipsis, emoji counted as one character each; each entry shown as Voice shows it, request then reply with the labels removed and search words highlighted in both (rows built by `indexChatTurn` and `indexChatSession` themselves: a turn, a greeting with no request all reply, a multi-turn session as Voice shows it; rows written before v1.2.9 with an `[ASSISTANT]` reply, alone or after a request, split the same way; a preview cut before the reply all request with a note saying why (also when the cut ends just past the reply label, a 381-character request or 377 before v1.2.9; one reply character shown when one fits), the note never highlighted, every shown entry request then reply with no note under a reply, a request never answered shown whole with no note; no part opens with a role label); a search of several words marks each one in the request and the reply, both shown exactly (#158); a new search opens on its first page; of two searches the later shows last; a page change while a search is pending pages the results shown and the search then shows under its own query; a reload asked while a search is pending waits for it and then shows the newest entries; a failed search keeps the entries shown, and one answered with no reply, an empty reply or anything but a list (#225) says it failed, as an error does, and keeps the search shown before, also once a removal shows the page again; a search asked while the listing on open is pending and answered with no reply or a reply that is not a list is said once that listing answers (`test/chatHistoryListState.test.js`) (red on the code before: 5 of 6; mutants detected: only error replies failing, the helper's reason dropped). "Delete old" removes all 1300 entries older than the cutoff past the newest 500 (the entry at the cutoff's millisecond kept), entries sharing one millisecond across a page boundary each asked for removal once, and ends even when the helper removes nothing, the status counting what the helper says it removed; a failed listing or removal (a removal answered with an error, no reply, or a reply that does not confirm it, #248) stops it with the count removed before it, the failed one not counted. Previews: red on the #152 page (all but one search test), and the layout test red on the split that knew only `[AGENT]`; mutants killed: the no-reply note shown without a cut or under a shown reply, the note highlighted, the ellipsis put on the reply before the split, the request and reply shown in the other order, HTML in an entry double-escaped or unescaped after highlighting (the escaping test), `[ASSISTANT]` not taken as a reply label after a request or alone, no search preview, no cut on the page, no ellipsis, the ellipsis threshold off by one either way, the helper asked for exactly what is shown, a UTF-16 cut, no page reset on a new search, Voice's split requiring a reply, a request or an agent-only row split only within its first line, the request's 2-line or the reply's 3-line clamp removed, the clamped parts not drawn as a line-clamped box (the page's stylesheet read through JSDOM's computed style; JSDOM does no layout), an empty part kept, the parts swapped, no highlight in the parts, no stale-search check, a reload not superseding a search (those checks are replaced by the one-at-a-time line, TB-193c). Newest entries and Remove (#153, #154): the tab opens on the newest 100 of 250 entries of 200 KB (one no-query request with the same previews, every reply under the cap, no highlight), says when none is kept, and says why a listing failed (an error, a throw, no reply, an empty reply, a reply that is not a list: one rule in the request both a listing and a search use) with the stats still shown; clearing the box, spaces included, goes back to the list without Enter, also while its search is pending, and clearing a box with no search sends nothing; a search asked while a listing is pending is sent only once the listing ends, then shows with the stats the listing read; Remove sends the one id with no confirmation, the button disabled and reading "Removing…" while pending (two at once, across a page change, a second click sending nothing), then the entry gone on the same page, the stats read again; removing the last entry of the last page shows the page before, the only entry says it was removed, and in search results the search is kept; a failed removal (an error, a throw, no reply, a reply that does not confirm it) says why and leaves the entry and its button working; a confirmed removal shows before the stats are read again; a stats read failing after a removal (an error, a throw, no reply) is said and the usage shows unavailable, and with a failed removal both are said; a removal asked while a search or listing is pending waits behind it ("Removing…" meanwhile) and a search asked while a removal is pending waits behind that; neither shows the removed entry once the removal is confirmed, one asked after shows it when memory holds it again, and the page's own Sets and Maps stay bounded across 30 removals; one removal failing while another is pending leaves the other disabled, "Removing…" and sent once, then removed; a search whose request is rejected says why, keeps the query, entries and memory shown before, and a later search works; Remove changes no chat turn, metadata, id map or thinking; Delete Old, Clear All, a lower size limit and a reload each list what memory then holds, and a blank Search or Enter (spaces, no input event) lists again. Red on the page before: 17 tests. The order cases were rewritten for the one-at-a-time line when the tab was rebuilt; the mutants detected on it are listed under TB-193c. #152's mutants on the whole-entry reads retired with them; its "delete old" ones and the tolerance-0 wire tests stand (`test/chatHistoryNativeCap.test.js`) | Every reply under the cap; the page shows the start of each entry | Robustness |
| TB-193b | Chat History from the settings page's own controls (#153): the real `prompts.js` and history module in one realm against a fake memory helper; opening the History tab lists the newest entries under "Newest Conversations", and Refresh lists an entry kept since. Mutants detected: the tab or Refresh not listing (`test/chatHistoryPageCallers.test.js`) | The page's callers reach the listing | Robustness |
| TB-193c | What the Chat History list says, and the order requests run in (#153, #154): the real page against a fake memory helper whose answers can be held. Listings, searches and removals run one at a time in the order asked: a listing, a search and a removal asked together are each sent only once the one before has answered; a listing that fails unexpectedly (a malformed answer) says so in the status line and the search asked after it still runs; a search asked while a removal reads the stats again is sent only once that read ends; a search that fails (an error, a rejection, no reply, a reply that is not a list) while page 2 of the listing is shown leaves that page, the listing and no search in the stats once a removal shows the page again (mutants detected: the failed search setting search mode or resetting the page); a failed removal stays "Removing…" and disabled until its stats read ends, so a press meanwhile sends nothing; a removal whose render throws still ends pending; a search asked while the listing on open is pending is not sent until it ends (the list keeps its loading text), then shows its results, or, when it answers an error or is rejected, says why in the status line with the listing still shown; an older helper refusing both says why the listing failed in the list and why the search failed in the status line, never that none is kept; two listings asked on open run one after the other and never say none is kept; of two searches the later waits for the earlier, an earlier failure is said, and an earlier one answering late never shows over the later; a listing asked while a search is pending shows as a listing (header and stats) after it, also once it renders again; a search asked while a listing is pending shows once the listing ends and keeps the page it is turned to; a removal pending while a search or a listing waits behind it still reads "Removing…", a second press sends nothing, and neither that search nor the listing asked after it shows the removed entry; a search or listing emptied by a removal asked while it was pending says "Removed every conversation shown.", never that none is found or kept; of two listings with a removal asked between them neither brings back the removed entry. Removing every entry the newest list shows (101 kept, 100 listed) sends one removal at a time, every button reading "Removing…" while it waits, says "Removed every conversation shown." and lists nothing again, while memory still holds one, which listing again shows; removing the only entry says it was removed, and a listing then says none is kept, from its answer; removing every result of a search keeps the search and says what was done, also for a search that reached the 100-result cap while memory holds more (searching again shows it); a search with no match says none is found, from its answer; after a failed search, removing every entry shown says what was done, not the failure, and lists nothing; words typed before a removal, while it is pending, or while the stats read after it is pending stay when removals empty the list; a removal that empties the listing while a later search is pending lists nothing over that search; a failed removal does not list again. A listing that cannot read the size limit says "Couldn't list past conversations: …" in the list and shows nothing it replaced: after a search (also on a page change, the box empty, no search named in the stats), across a removal settling after it or asked before it, and after Clear All (a page change shows none of the cleared entries). Listing again resets the box's last request (clearing a box typed into then sends nothing) and opens on page 1; a search with no match after a failed listing says no results; a listing answering after a failed one says what memory holds; a listing failing after entries were shown says why in the list; a listing whose turns count cannot be read still shows what memory now holds; a listing shows the turns count and memory size it read, and resets them to 0 and unavailable when a later read fails; a Remove press whose first render throws still ends pending once its turn ends; an undated entry's Remove button names it "Unknown date"; a listing shows markup in a request and reply as that text, adding no element; a listing answering after words were typed, or typed and searched, keeps them (and the search's answer). Red on the code before: the 6 order and size-limit cases. Mutants detected: the line not chained (requests overlapping), the line's catch dropped (a throw stopping every later request) or silent, the box emptied when the listing answers rather than when it is asked, the listing not resetting the box's last request or a search not setting it, the size-limit read outside the listing's own failure handling, the stats read outside the listing's turn, a listing's non-array answer taken as none kept, a search or a removal not put in line, a rejected search taken as no matches, a failed search clearing or replacing the list, an answer keeping the page, a failed listing keeping the entries it replaced, none kept or found said without an answer saying so, an unconfirmed removal reply taken as success, the removed entry left shown, the pending state kept after the removal ends or not shown until it runs, a second press sending again, the stats not read again after a removal, the removal's own render dropped (24 of 24); in review: the removal's stats read detached from its turn, the pending state cleared before that read or outside a `finally`, and the Remove button's colours given as a literal or a fallback (6 of 6, with the colour cases below), a failed turns read ending the listing, the turns count always 0, a failed turns or stats read keeping the old count or usage, the pending render drawn before the removal is in line (`test/chatHistoryListState.test.js`) | The list ends on the last request asked and never says none is kept without an answer saying so | Robustness |
| TB-193e | The Chat History tab's memory writes are confirmed only by the helper's `{ ok: true }` (#248), the rule a removal already used, now one function for Remove, Delete Old, Clear All and the size limit: no reply (no listener answers while the background starts or reloads) or a reply that does not confirm it fails as an error does. Clear All answered so, or with an error or a rejection, says it failed and why (the helper's reason, or that it did not confirm it). Clear All never removes the one-time migrations' flags, confirmed or not (all five kept for each of five answers), and memory written after a Clear All, confirmed or failed, survives the chat store's migration at the next chat-window open; nothing is said cleared until memoryClear answers (the status reads "Clearing chat history..." while it is held); before, a confirmed Clear All removed them and the chat store's migration then cleared what was written after it (`test/chatHistoryClearError.test.js`, and the Clear All test in `test/memorySizeLimit.test.js`, which had expected the flags removed); a size-limit change answered so says the limit was saved but applying it failed, with the limit kept, and a helper without the trim still says it applies once the helper updates (`test/memorySizeLimitPage.test.js`, `test/memorySizeLimit.test.js`); Delete Old under TB-193. Red on the code before: 20 of the 224 tests in the four suites. A size-limit trim that fails also shows the saved limit, so a lower one chosen next is asked about before anything is removed (`test/memorySizeLimitPage.test.js`). Mutants detected: "Chat history cleared" said before memoryClear answers, a failed trim not listing again, Clear All's failure status dropping its reason, saying the error object, or wrapping the reason, a confirmed Clear All removing `chat_turns_migration_v2` or the other four flags, only an error reply failing, and Clear All, Delete Old, the trim or Remove reading its reply without the rule, the trim's failure read before an `unsupported` answer, Clear All removing the migration flags when it failed (14 of 14; `ok` taken as truthy rather than `true` is equivalent, as the helper sends a boolean) | A memory write is said done only when the helper confirms it | Correctness |
| TB-193f | The stored chat turns have one writer, the background's in-memory chain (#252, #263): the real settings page, chat store, background message route, writer, window-close save (chat.js's own code), Retry, window start and scheduled task delivery against storage that keeps copies. Clear All with the window closed, left open, closed with no message, and while a message is being saved; Delete Old with a message after it and with a message sent while it removes; a task result read before a Clear All and one delivered after it; Retry after a Clear All and Retry removing its message; changes applied one at a time in the order sent, never overlapping; a failed change answered as failed and the changes after it applied; a window closed while its change is with the background; the window start's load cleanup, budget, session break, greeting and refs migration while another page stores a turn, after a change sent before it failed, and when the background refuses its load-time removal; each operation, a failed read writing nothing, the message route; Clear All and Delete Old saying they failed when their write fails (turns, metadata and memory kept); a scheduled task result whose write fails logged as not stored; a task result after a stored session break adding no second break; migration v3 removing the retired `chat_turns_pending` once; a census failing on any write that may name `chat_turns` outside the writer's apply (through constants, tables of keys, objects and lists built up first, spread, `Object.assign`, aliases of `storage`, `storage.local` and its methods declared, destructured (from `browser` too, nested or renamed) or assigned later, brackets, optional chaining, `call`/`apply`), or on any file outside the background loading the writer (through imports, re-exports and page script tags), or any file but the background starting the task delivery that loads it, with fixtures for each form. Mutants: changes run without the chain (5 tests red) and a failed change left on the chain (3 red) (`test/chatClearAllOpenWindow.test.js`, `test/chatInitStoredTurns.test.js`, `test/storedTurnsQueue.test.js`, `test/chatTurnsSingleWriter.test.js`, `test/persistentChatStore.test.js`) | A Clear All or Delete Old stays done; changes to the stored turns apply in order and a failed one is reported | Correctness |
| TB-193d | The Chat History Remove button's colours (#154): in its normal, hover and disabled states every colour, background and border is a Thunderbird theme variable (`--in-content-*`, `--panel-*`), which follow the light and dark themes, with no literal colour and no fallback (`prompts/prompts.css` read by `test/chatHistoryListState.test.js`) | Theme colours only | Robustness |
| TB-194 | Chat `memory_read` (#151) with the shipped settings against a fake helper that cuts listings to the `previewChars` asked, keeps both date bounds inclusive, reads oldest first up to 50 and refuses a reply over 1 MiB (any other command fails the test): 21 sessions of 200 KB within ten minutes return the 20 centered on the timestamp, each whole, each read at its own millisecond, every reply under the cap and memory unchanged; a window of 200 entries centers on the timestamp (the old read answered its oldest 50), `max_turns` 5 too; at most 50 returned; a day of earlier entries in a wide window needs one listing request; 30 entries sharing one millisecond across a page boundary are listed once each and read whole in one request; an entry removed between listing and read is left out, and all removed says none found; a helper without previews lists 20 a request (21 with the one at the cursor); a tolerance that is not a positive number uses ten minutes, a one-minute tolerance keeps both bounds and nothing outside them; a failed listing or read (error reply, rejected call, or no answer at all) reports `memory read failed`, a failed listing reading nothing; entries tied at one millisecond listed once each whatever order the helper gives them in (ties shuffled per request); the newest `max_turns` when the timestamp is at the newest end of the window (`max_turns` 30 with one after it, 21 with none); a `max_turns` that is not a number gets 20 (20 reads). Red on the pre-fix tool (7 of 9 at the time); 20 mutants killed: no listing preview, no dedupe at the cursor, no early stop, early stop counting the wrong side, no cursor advance, no reset at a new cursor, a read with the default tolerance, the first row at a millisecond taken, no 50 cap, no tolerance check, no check for all removed, the listing not put oldest first, the early stop at half or one short of `max_turns`, the trim's end clamp not moving its start, ties skipped by position, a non-numeric `max_turns` not defaulted, a one-minute tolerance widened to the default, an unanswered listing or read taken as an empty memory (`test/memoryReadNativeCap.test.js`; TB-066 in `test/chatTools.test.js` serves the window coherently) | Every reply under the cap; each entry shown whole | Robustness |

---

## 3. Tier 3 — Agent Modules (Mock-Dependent)

### 3.1 Message Processor (agent/modules/messageProcessor.js) ⛔ NOT IMPLEMENTED

> Skipped: No isolated testable logic. `processMessage` depends on 8+ modules (actionGenerator, summaryGenerator, replyGenerator, senderFilter, tagHelper, messagePrefilter, folderUtils, messageProcessorQueue), each with heavy browser API dependencies. Would require full integration test harness.

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-070 | Classify message as actionable | Correct classification | Business rule |
| TB-071 | Classify message as non-actionable | Correct classification | Business rule |
| TB-072 | Generate action from classified message | Correct action | Business rule |
| TB-073 | Process batch of candidates | All processed | Batch |

### 3.2 LLM Client (llm.js) ✅

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-080 | SSE stream parsing | Events extracted correctly | Parsing |
| TB-081 | Tool call request in streaming response | Tool call object parsed | Parsing |
| TB-082 | Retry on 429 with backoff | Correct retry behavior | Retry |
| TB-083 | Timeout handling | Error after timeout | Timeout |
| TB-084 | Conversation state management | Round-trip preserves state | State |
| TB-085 | Every completions request (first send, rate-limit retry, re-sign-in retry) sends `X-Client-Protocol` = `SETTINGS.protocolVersion` beside `X-Client-Version` = the add-on's version (`test/llmRequestHeaders.test.js`). Red before the header existed; red when either retry builds its own headers without it | Header on all three sends | Protocol |

### 3.3 Device Sync (agent/modules/deviceSync.js) ✅

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-090 | State merge with per-field timestamps | Newer wins per field | Merge |
| TB-091 | Echo prevention (a received or reset write is not sent back) | No infinite loop | Echo |
| TB-092 | Virgin device detection (all epoch-zero) | Skip broadcast, probe | Detection |
| TB-093 | Labelled-bullet merge of a received snapshot (DS-MERGE) | Labels unioned, deletions by seen map | Algorithm |
| TB-094 | Template CRDT merge (by ID, newer updatedAt wins) | Correct per-template | CRDT |
| TB-095 | DisabledReminders merge (per-hash, newer ts wins) | Correct per-hash | CRDT  |

---

## 4. Additional Testable Modules (Not Yet Implemented)

### 4.1 ICS Parser (chat/modules/icsParser.js) — HIGH PRIORITY

Pure RFC 5545 parsing with zero browser dependencies.

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-100 | Parse simple VEVENT with DTSTART/DTEND | Structured event object | Happy path |
| TB-101 | Parse all-day event (DATE format) | All-day flag set | Format |
| TB-102 | Parse recurring event (RRULE) | Recurrence info extracted | Recurrence |
| TB-103 | Parse event with TZID | Timezone mapped correctly | Timezone |
| TB-104 | Parse event with attendees | Attendee list extracted | Attendees |
| TB-105 | Detect Zoom/Teams/Meet join URLs | URL extracted from LOCATION/DESCRIPTION | Detection |
| TB-106 | Duration parsing (P1DT2H30M) | Correct minutes | Parsing |
| TB-107 | Line unfolding (RFC 5545 continuation) | Lines merged correctly | RFC compliance |
| TB-108 | Multiple VEVENTs in one ICS | All events parsed | Batch |
| TB-109 | Malformed ICS → graceful warnings | No crash, warnings collected | Robustness |
| TB-110 | formatEventsForDisplay output | Human-readable text | Formatting |

### 4.2 ID Translator (chat/modules/idTranslator.js) — HIGH PRIORITY

Pure state transformation for numeric ID mapping.

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-120 | toNumericId allocates sequential IDs | 1, 2, 3... | Happy path |
| TB-121 | Same realId always maps to same numericId | Deterministic | Dedup |
| TB-122 | toRealId reverse lookup | Correct real ID | Reverse |
| TB-123 | Isolated contexts don't interfere | Independent state | Isolation |
| TB-124 | processToolCallLLMtoTB translates args | Numeric → real IDs | Translation |
| TB-125 | processToolResultTBtoLLM translates results | Real → numeric IDs | Translation |
| TB-126 | restoreIdMap from persisted format | State restored | Persistence |
| TB-127 | Already-numeric IDs passed through | No double-mapping | Edge case |

### 4.3 Tag Definitions (agent/modules/tagDefs.js) — HIGH PRIORITY

Pure priority logic and tag filtering.

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-130 | maxPriorityAction selects highest priority | Correct action | Priority |
| TB-131 | actionFromLiveTagIds reverse lookup | Tag IDs → action names | Mapping |
| TB-132 | reorderTagsToPreferTabMail | TabMail tags first | Ordering |
| TB-133 | hasNonTabMailTags detection | True when non-TM tags present | Detection |
| TB-134 | Empty/null input handling | No crash | Robustness |

### 4.4 Message Prefilter (agent/modules/messagePrefilter.js) — MEDIUM PRIORITY

Pure pattern matching for no-reply detection.

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-140 | isNoReplyAddress: noreply@domain.com | true | Detection |
| TB-141 | isNoReplyAddress: no-reply@domain.com | true | Detection |
| TB-142 | isNoReplyAddress: donotreply@domain.com | true | Detection |
| TB-143 | isNoReplyAddress: support@domain.com | false | Negative |
| TB-144 | isNoReplyAddress: "Name <noreply@x.com>" format | true | Extraction |
| TB-145 | hasUnsubscribeLink: List-Unsubscribe header | true | Header |
| TB-146 | hasUnsubscribeLink: "unsubscribe" in body | true | Body |

### 4.5 Reminder State Store (agent/modules/reminderStateStore.js) — MEDIUM PRIORITY

CRDT hashing and merge logic.

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-150 | hashReminder: message reminder with rfc822MessageId | `m:<id>` format | Hashing |
| TB-151 | hashReminder: KB reminder | `k:<hash>` format | Hashing |
| TB-152 | hashReminder: fallback | `o:<first32chars>` format | Fallback |
| TB-153 | hashReminder: bracket stripping from Message-ID | Brackets removed | Normalization |

### 4.6 Helpers — Additional Coverage (chat/modules/helpers.js) — MEDIUM PRIORITY

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-160 | toIsoNoMs strips fractional seconds | `...00Z` not `...00.000Z` | Formatting |
| TB-161 | toNaiveIso from timestamp number | Correct local datetime | Conversion |
| TB-162 | toNaiveIso from ISO string | Timezone stripped | Conversion |
| TB-163 | fuzzyMatchWithList finds close matches | Best match returned | Matching |
| TB-164 | fuzzyMatchWithList rejects distant strings | No match | Threshold |
| TB-165 | getGenericTimezoneAbbr returns abbreviation | PT/ET/CT etc. | Timezone |

### 4.7 Zero-Priority-Budget Usage Display (agent/modules/billingBanner.js `isZeroQuotaPlan`)

The usage surfaces (`popup/popup.js`, `config/modules/planUsage.js`) render "N/A of
monthly quota" for a plan with no priority budget, instead of a misleading
"0% of monthly quota (Slow)". Detection is keyed on the **wire quota signal**
(`limit_cost_cents === 0`), not on a hardcoded tier list, so every plan the backend
puts on its zero-priority-budget branch is covered with no client change. Fixtures are
byte-real `/whoami` bodies.

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-170 | BYOK zero-budget payload | `true` — N/A treatment preserved | Regression guard |
| TB-171 | Trial zero-budget payload (`queue_mode:"slow"`, `quota_percentage:0`, `limit_cost_cents:0`) | `true` — same treatment as BYOK | **Red-first** |
| TB-172 | Basic / Pro with a real positive budget | `false` — percentage still shown | Happy path |
| TB-173 | Legacy card-based trial (`subscription_status:"trialing"`, positive budget) | `false` — real quota keeps its percentage | Near-miss |
| TB-174 | Quota signal absent (logged out / no subscription / no quota block) | `false` — `undefined !== 0`, no false N/A | Edge case |
| TB-175 | `limit_cost_cents: "0"` / `null` / `false` | `false` — strict `===`, never coerce | Type safety |
| TB-176 | Zero budget on any tier spelling; positive budget on a "BYOK" tier | Signal decides, not the tier name | Invariant |

**Red-first evidence (2026-08-18):** TB-171 and TB-176 were written against the previous
tier-keyed predicate (`plan_tier === "BYOK"`) and observed FAILING before the fix —
TB-171 `expected false to be true` (the Trial misrender), TB-176 `expected false to be
true`. TB-174 also failed in the opposite direction (`expected true to be false`): the old
predicate claimed a zero quota for a `plan_tier:"BYOK"` body carrying no quota block at
all. All three pass after re-keying onto `limit_cost_cents === 0`; TB-170/172/173/175
passed both before and after (behavior-preservation cases).

**Coverage:** `agent/modules/billingBanner.js` — 100% statements / 100% lines /
95.83% branches. The single uncovered branch is the pre-existing `plan_tier ?? null`
fallback in `bannerFromWhoami`, unrelated to this predicate.

### 4.8 Plan Status Label (config/modules/planUsage.js) — MEDIUM PRIORITY

`updatePlanStatusDisplay` renders the settings-page plan label. Two independent
`/whoami` signals can mark a trial: the tier string itself (`plan_tier: "Trial"`,
server-granted signup trial) and a trialing subscription (`trial.is_trial` or
`subscription_status: "trialing"`, card trial sitting on a Basic/Pro tier).

**Invariant:** the label names the trial state **at most once**. When the tier
string already says "Trial", the `" (Trial)"` suffix is redundant and suppressed;
on every other tier the suffix is the only thing that says "trial" and is kept.

**Red-first evidence (pre-fix, `npx vitest run test/planUsage.test.js`):**
`7 failed | 29 passed (36)` — the label rendered `"Plan: TabMail Trial (Trial)"`
for every signup-trial case (TB-177 rows and the tier-`Trial` rows of TB-180).
Post-fix: `36 passed (36)`. Test file: `test/planUsage.test.js`.

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-177 | plan_tier `Trial` + `trial.is_trial` | `Plan: TabMail Trial` | Signup trial |
| TB-177 | plan_tier `Trial` + `subscription_status: trialing` | `Plan: TabMail Trial` | Signup trial |
| TB-177 | plan_tier `Trial` + both trial signals | `Plan: TabMail Trial` | Signup trial |
| TB-177 | plan_tier `Trial` + no trial signal | `Plan: TabMail Trial` | Signup trial |
| TB-178 | plan_tier `Basic` + `subscription_status: trialing` | `Plan: TabMail Basic (Trial)` | Card trial |
| TB-178 | plan_tier `Basic` + `trial.is_trial` | `Plan: TabMail Basic (Trial)` | Card trial |
| TB-178 | plan_tier `Pro` + `subscription_status: trialing` | `Plan: TabMail Pro (Trial)` | Card trial |
| TB-178 | plan_tier `BYOK` + `trial.is_trial` | `Plan: TabMail BYOK (Trial)` | Card trial |
| TB-179 | plan_tier `Pro`, no trial | `Plan: TabMail Pro` | Paid |
| TB-179 | plan_tier `Basic`, no trial | `Plan: TabMail Basic` | Paid |
| TB-179 | plan_tier absent | `Plan: TabMail Unknown` | Fallback |
| TB-179 | `has_subscription: false` | `Plan: No subscription` | No subscription |
| TB-179 | `logged_in: false` | `Plan: Not logged in` | Logged out |
| TB-179 | `data` is null | `Plan: Not logged in` | Logged out |
| TB-180 | 5 tiers × 4 trial-signal combinations | "Trial" occurs ≤ 1× in label | Invariant matrix |
| TB-180 | Non-vacuity: trialing paid tier | "Trial" occurs exactly 1× | Invariant matrix |
| TB-180 | Non-vacuity: signup-trial tier | "Trial" occurs exactly 1× | Invariant matrix |

### 4.9 Calendar Service Acquisition (chat/experiments/tmCalendar/tmCalendar.sys.mjs)

Thunderbird de-XPCOM'd its calendar back end. By Thunderbird 154 all three calendar
*service* contracts `tmCalendar` used were dead: `@mozilla.org/calendar/manager;1` and
`@mozilla.org/calendar/timezone-service;1` still register, but their registered
constructors are now module-level singleton **instances**, so XPCOM's `new` throws
`TypeError: (...) is not a constructor` and `getService()` fails with
`NS_ERROR_XPC_GS_RETURNED_FAILURE`; `@mozilla.org/calendar/ics-service;1` was removed
outright. Every calendar feature failed with them.

**Invariant:** no reachable code path resolves a calendar *service* through an XPCOM
contract; each consumer receives the service it actually needs from `cal.manager` /
`cal.timezoneService` / `cal.icsService`, returning `null` rather than throwing when the
namespace is unavailable; and the still-registered *construction* contracts are left alone.

**Two instruments, deliberately overlapping.** `node:vm` executes the real file **as a
classic script** — the one property of Thunderbird's loader that matters here, since
top-level function declarations become global-object properties exactly as
`SchemaAPIManager` reads them back. It is *not* a reproduction of Gecko: it is Node/V8 with
a synthetic global, no XPCOM and no privileged sandbox. What it buys is that the accessors'
return values, null contract, logging and cache-free behaviour are asserted by *running*
them. `acorn` parses the file so the negative census is answered structurally. Both
replaced a text-scanning first draft that review defeated four ways, each reproduced: a
live XPCOM lookup parked between two string literals containing `/*` and `*/` was erased by
comment stripping; a `getService(` split across lines slipped past a line-oriented regex;
`getService(globalThis.Ci.calIFoo)` slipped past a regex requiring `Ci.` after the paren;
and a function's own declaration satisfied its "has ≥ 1 caller" count. Comments are not AST
nodes and declarations are not `CallExpression`s, so all four dissolve structurally rather
than needing another regex.

**Red-first evidence (`npx vitest run test/calendarServiceAcquisition.test.js` against
`origin/main`'s `tmCalendar.sys.mjs`, SHA-256 `55fb327daafb4ce410a9e56120657195a97692505f4fb07814d491cbc7f9144f`
— byte-identical to the shipped 1.7.4 XPI that produced the reported failure):
`16 failed | 6 passed (22)`. Post-fix: `22 passed (22)`. The six that pass on base are the
three instrument controls (independent of the file under test), the iMIP-unreachability
guard, the construction-contract guard, and the classic-script load — all correctly
base-agnostic.

**Coverage note.** `npx vitest run --coverage` reports **0%** for `tmCalendar.sys.mjs`.
That is an artefact, not a gap: the file is executed through `node:vm`, which v8/vitest
cannot attribute back to the source. A `NODE_V8_COVERAGE` harness that replays the executed
assertions shows the code this fix introduces — `getCalNamespace`, `calService` and the
three accessors — at **zero uncovered blocks**. Mutation, not the coverage percentage, is
the meaningful oracle for this file.

**Mutation evidence — 19 mutants, 17 killed, 3 surviving by decision.** Applied one at a
time in a disposable rig outside the worktree. Killed: pre-fix base source; the new
missing-service log removed; the whole `!service` guard removed; swapped timezone/ICS
accessor bodies; `calService`'s `try/catch` deleted; `undefined` returned instead of `null`;
accessors forced to always return `null`; a module-level namespace cache added;
`getService(globalThis.Ci.calI…)`; a dead-manager lookup hidden between `/*` and `*/`
string literals; `sendCalendarInvitations` reached through an alias; the series-split ICS
site swapped to the timezone service; a `getAPI` manager site swapped to the ICS service;
**all seven `getAPI` manager sites forced to `null`**; `listCalendarsInternal` calling
the accessor but discarding its result; **a sibling fallback in `calService`
(`getCalNamespace()[name] ?? getCalNamespace().manager`)**, which returned the calendar
manager for every timezone and ICS consumer with no log at all; and **`getCalendars`
discarding the manager it acquired** (`getCalendarManager(); const mgr = null;`), which
kept the exhaustive AST table byte-identical while the live API refused every valid
profile. The last two were found independently by two models in the same round, survived
18/18 green before this correction, and are the reason the executed half grew.

**The two survivors are recorded, not hidden**, and the reason is in the source beside the
census: a contract assembled by `Array.join` reached through a computed
`"get" + "Service"`, iMIP invoked as `globalThis["sendCalendar" + "Invitations"]()`, and a
zero-argument `Cc[…].getService()`. A static census sees syntax and cannot win an arms race
against deliberately computed forms; the answer is to execute a consumer, not to add
another pattern. Execution covers the four accessors, per-service resolution against a
partial namespace, `toEpochMsUTC`, `listCalendarsInternal` and the `getCalendars` getAPI
surface; `toCalIDateTime`, `applyRecurrenceToItem`, `queryCalendarItemsInternal` and the
remaining eight `getAPI` call sites are covered statically only.

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-181 | AST census on a literal sample carrying all four known defeats | Code-side contract seen; comment-only mentions not; multi-line qualified `getService` caught; `createInstance` not | Instrument control |
| TB-181 | `accessorCallSites` on declaration-only and declaration-plus-call samples | Zero, then the region-qualified calls — a declaration is not a call | Instrument control |
| TB-181 | Dead contracts still named in the source's comments; > 100 code strings parsed | Two-sided; documentation preserved | Non-vacuity control |
| TB-182 | `@mozilla.org/calendar/manager;1` absent from code strings | Not resolved via XPCOM | **Red-first** |
| TB-182 | `@mozilla.org/calendar/timezone-service;1` absent from code strings | Not resolved via XPCOM | **Red-first** |
| TB-182 | `@mozilla.org/calendar/ics-service;1` absent from code strings | Not resolved via XPCOM | **Red-first** |
| TB-183 | No `*.getService(*.calI…)` outside the unreachable iMIP function, at any line breaking or `Ci` qualification | Catches a service reintroduced with an explicit `calI…` interface argument. A zero-argument `getService()` is NOT matched by this census — the three dead contracts are covered by TB-182's string census whatever the form, but a service added later would need its own row | **Red-first** invariant |
| TB-184 | Zero references to `sendCalendarInvitations` other than its own declaration name | The TB-183 exemption stays sound; an alias counts, so reviving iMIP trips this first | Exemption guard |
| TB-185 | `calUtils` imported by exactly one `CallExpression`, lexically inside `getCalNamespace` | Single chokepoint | **Red-first** |
| TB-186 | All 15 accessor call sites equal the pinned `<region chain> :: <accessor>` table | Exhaustive, not a subset or a threshold: adding, removing, relocating or swapping any accessor call anywhere fails here | **Red-first** direction map |
| TB-187 | event / attendee / datetime / recurrence-\* / ics-serializer contracts still present | The fix did not sweep away contracts Thunderbird still registers | Opposite direction |
| TB-188 | Each accessor returns its own sentinel service | Swapped bodies caught | **Red-first** executed |
| TB-188 | Each accessor returns `null` (not `undefined`) **and logs** when the namespace lacks the service | Documented null contract, and never quieter than the `getService()` throw it replaced | **Red-first** executed |
| TB-190 | `listCalendarsInternal` maps the acquired manager's calendars, and returns `[]` with no manager | A pinned call site proves the call, not that its result is used | **Red-first** executed |
| TB-188 | Each accessor returns `null` and logs its own service name when the import throws | `try/catch` is load-bearing | **Red-first** executed |
| TB-189 | Three accessor calls import `calUtils` three times | No module-level cache, deliberately | **Red-first** executed |
| TB-190 | Loading the file performs no `Cc[…]` lookup and imports only `ExtensionCommon` | `Cc` proxy throws on any access | Executed |
| TB-190 | `toEpochMsUTC` receives UTC from the timezone service and returns the right epoch | Behavioural counterpart to the direction map | **Red-first** executed |
| TB-191 | With one service absent and the other two present, that accessor returns `null` and logs its own name while the others still return **their own** sentinel | A sibling fallback returns the manager for every timezone/ICS consumer on a healthy profile, silently; an all-absent fixture cannot see it, and a global log count is defeated by any fallback that does not double-log | **Red-first** executed |
| TB-192 | `getAPI().tmCalendar.getCalendars()` returns the mapped calendars with a live manager, and the explicit `calendar manager unavailable` refusal without one | Discarding the acquired manager keeps the exhaustive AST table byte-identical while the live API refuses every valid profile | **Red-first** executed |

**Coverage:** `node:vm` executes the real file, so the accessors and `toEpochMsUTC` are
genuinely exercised rather than only read. The remaining behavioural coverage for this
experiment lives in the exported mirror `chat/experiments/tmCalendar/durationPreservationLogic.js`
(via `test/calendarDurationPreservation.test.js`, which also byte-pins the mirror against
the parent script); `test/calendarEditScope.test.js`, `test/calendarAttendeeDelta.test.js`
and `test/calendarEventReadHelpers.test.js` cover the sibling `chat/fsm/` logic, not this
file.

---

## Testing Setup

### Configuration

```javascript
// vitest.config.js
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
});
```

### Browser API Mock Template

```javascript
const browserMock = {
  storage: {
    local: {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
    }
  },
  messages: {
    get: vi.fn(id => Promise.resolve({ id, subject: 'Test' })),
    getFull: vi.fn(id => Promise.resolve({ parts: [] })),
  },
  runtime: {
    sendMessage: vi.fn(() => Promise.resolve()),
    sendNativeMessage: vi.fn(() => Promise.resolve({})),
  },
};
global.browser = browserMock;
```

### Test File Organization

```
test/
  deviceSyncVectors.test.js   # Shared Device Sync v2 vectors (labelled bullets)
  kbReminderGenerator.test.js # Reminder parsing formats
  patchApplier.test.js        # Markdown patch application
  utils.test.js               # Utility functions, normalization, folder detection
  chatTools.test.js            # Chat tool interface + specific tool tests
  deviceSync.test.js            # Device sync CRDT, state merge, echo prevention
  llmClient.test.js            # LLM response parsing, tool calls, conversation state
  llmRequestHeaders.test.js    # Protocol and version headers on every completions request
```

---

## Coverage Targets

| Tier | Target | Estimated Test Cases |
|------|--------|---------------------|
| Tier 1 (Pure logic) | ≥ 95% | ~200 tests |
| Tier 2 (Chat tools) | ≥ 85% | ~300 tests |
| Tier 3 (Agent modules) | ≥ 70% | ~200 tests |
| Overall (testable code) | ≥ 80% | ~700 tests |

### Challenges & Mitigations

| Challenge | Mitigation |
|-----------|-----------|
| No build step | Vitest with native ESM |
| Thunderbird APIs | Mock `browser.*` at test entry |
| Native FTS messaging | Mock `sendNativeMessage` |
| IndexedDB | `fake-indexeddb` npm package |
| Large modules (1000+ LOC) | Extract pure functions first |

### Remaining Uncovered (Not Worth Testing — 2026-03-14)

The following modules remain at 0% or very low coverage due to heavy browser/XPCOM dependencies. Testing them would require building a full Thunderbird API mock harness with diminishing returns:

| Module | Reason |
|--------|--------|
| `background.js` | Extension lifecycle, event listeners, experiment API init |
| `onMoved.js` | Deep `browser.messages` + folder API dependency |
| `supabaseAuth.js` | Full Supabase auth flow with browser storage |
| `messageProcessorQueue.js` | Depends on 8+ modules with browser APIs |
| `tagHelper.js` | Heavy `browser.messages.tags` API usage |
| `threadTagGroup.js` | DOM + browser API combined |
| `knowledgebase.js` | Supabase + storage + runtime messaging |
| Experiment `.sys.mjs` files | Require XPCOM/Thunderbird runtime context |

Pure logic modules (utils, parsers, config, CRDT) are well-tested at 15.24% overall. The testable ~50% of the codebase has significantly higher effective coverage.


## Action mutation repaint regression (2026-09-12)

- `actionMutationOwner.test.js`: transaction ordering, exact-folder twins, key-only clearing, same-value sort suppression, stale automatic results, wipe epochs, unknown inventory, bounded projection failure, metadata, and thread-effective writes.
- `actionCacheStartupResolution.test.js`: symmetric inbox hydration, native orphan clearing, late inbox creation, bounded partial-bulk failure, and suspend cleanup.
- `actionPainterContracts.test.js`: production-source reader tests for all five surfaces, inbox scope, absence of legacy-keyword fallback, card wrapper ownership, and delayed sort restart.
- `tableViewActionRepaint.test.js`: real experiment VM integration, background tabs, collapsed children, native bulk clearing, hot reload, and a rendered pool of 250 rows.
- `actionMutationRoutes.test.js` and `tagSortRuntime.test.js`: actual entry callbacks, clear-command completion/failure, recompute/move routing, native sort execution after the delay, and cancellation at shutdown.
- `actionRecomputePipeline.test.js` and `automaticWorkLifetime.test.js`: real queue/processor/generator/owner recompute after a partial failure, plus active-token invalidation and retirement without permanent history. Queue tests cover newer requests surviving older in-flight success/failure.
- `actionMutationFence.test.js`: AST census of action key construction and full-cache wipe ownership. Caller tests cover generator, queue, manual tagging, grouping, summary and sign-out routing.

The full candidate suite passed 4,047 tests across 162 files. Run `npm test -- --run`. Tests that inspect backend prompt files require the sibling `tabmail-backend` checkout. Install the locked development dependencies with `npm ci --ignore-scripts`.

Live smoke used Thunderbird Beta 156.0 on macOS, a temporary worktree add-on, and a synthetic email in the unified inbox. Before the fix, a key-only clear removed the cached action but left native `reply` and a green row. After reload, symmetric backfill removed that orphan. A stationary check then exposed a second gap: the optional `NoteChange` call silently skipped repaint because the DB view has no such JavaScript method. Replacing it with the owning thread tree invalidation API cleared the tint with the inbox left open and untouched, before the delayed sort could run. The owner clear returned null cached action and empty native action in 40 ms; this measures command completion, not DOM frame latency. Five real-API-shape regression cases failed before this native fix and all nine table integration tests passed afterward. This is Beta smoke evidence; Thunderbird 145/ESR 140 and a full real-account mutation matrix were not run. Sorting timing and multi-window/collapsed-thread boundaries are covered programmatically.

Additional startup/sign-out/identity regressions cover optional tag-list rejection, privacy clearing despite inventory-read failure, terminal discard of obsolete cross-path work, and successful fresh work. Lifecycle tests begin without a cached row; queue replacement is also exercised during identity lookup, and peer-cache reply normalization is checked against native state. Extracted-function probes use distinct script names and provide behavioral/mutation evidence only, not original-source coverage attribution.

`actionPipelineBoundaries.test.js` and `actionThreadBoundaries.test.js` exercise real queue/generator/processor/owner handoffs: rowless clear-all, stale peer and internal results, thread-effective invalidation, query pagination and continuation failure, toggle-on aggregation, and partial thread data after session IDs change. Repeated cached-read tests verify completed work can no longer write while fresh work succeeds.

Internal-message tests exercise grouping both enabled and disabled through the real processor/tag helper/owner. Unsupported model actions retain queue work until a valid response commits. Collapsed-card rendering checks remove the recycled chip, class and color outside the Inbox while preserving the child action.

Restart coverage persists a partially completed recompute, applies a newer manual action, resets modules, and verifies the newer canonical/native action survives while fresh recompute succeeds. Lifecycle edge tests cover metadata reset and both retention callers, fresh confirmed-absent eviction, semaphore reply normalization, moved-header cleanup, collapsed table inbox scope, direct-processor token retirement, and thread-action retention. Each of these nine retained behaviors has a demonstrated failing mutation.

Retention tests use the actual action writer and identity resolver to expire aged removed-account rows while preserving fresh unknown-inventory rows. The real registered recompute command is exercised through durable queue creation and retirement. Queue tests cover outside-inbox and vanished-message retirement with fresh-work recovery, and thread tests refuse partial writes after member lookup failure. Five corresponding branch/caller mutations fail these boundary tests.

Both cleanup callers now exercise the real action-expiry wrapper alongside metadata retention. Actual-menu tests cover retained failure and an older in-flight completion. Repeated terminal queue work is verified unable to mutate actions after retirement, followed by successful fresh processing. These outcome tests kill the four remaining caller/lifecycle mutations without adding a production debug accessor.

The scan retention test imports the real scan module. The background cleanup probe binds action dependencies through the source's actual named import declarations. Removing either action-expiry import, or either metadata-retention import, fails the durable-effect test instead of being hidden by injected globals.
