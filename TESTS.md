# Thunderbird Extension — Test Reference

> The client-side extension is highly testable despite being a browser extension. ~50% of the codebase is pure logic.

---

## Test Files

| File | Tests | Coverage Area |
|------|-------|---------------|
| `test/bulletMerge.test.js` | 12 | 3-way merge algorithm, sectioned/flat merge, dedup |
| `test/kbReminderGenerator.test.js` | 10 | Reminder parsing from KB content |
| `test/patchApplier.test.js` | 13 | Markdown patch application (add/remove lines) |
| `test/utils.test.js` | 59 | normalizeUnicode, date formatting, isInboxFolder, email extraction, escapeHtml |
| `test/chatTools.test.js` | 46 | Chat tool interface, validation, specific tool behavior |
| `test/deviceSync.test.js` | 31 | State merge, CRDT, echo prevention, virgin device detection |
| `test/ftsFolderReconScheduler.test.js` | 432 | Bounded folder membership reconciliation, epoch-fenced verification, stale/missing repair, interruption and retry, volatile drift-tolerant membership-state pass (no per-page memo writes, convergence under live mail), recovery wakes after native reconnect and folder/account topology changes, total ownerless-row classifier (ghost removal, budget, interrupted terminal page), unloaded-account rows and capped `inventory_retry`, orphan completion across ticks in both modes (the orphan tail's quiet predicate alone refuses completion across a message event after the orphan slice, then a quiet tick completes), legacy orphan reset triggers, zero storage writes on a no-change startup, removal vs racing re-add ordering (real message event, same-page retry; re-add drained in the millisecond of an earlier event keeps its row, with control; owned stale-row removal withheld when the re-add is delivered first or while the removal fence is acquiring, with control), interrupted legacy basis count, startup walk (every startup enumerates every exact-mode folder with zero storage writes; tokenless checkpoints take one full projection, then the UID tier; native removals while closed repaired for every memo shape; equal-count swaps under a frozen HIGHESTMODSEQ repaired after a restart and after a real queue-stuck abandonment), UID-tier membership safety (msgDB replaced during a scan or before the closing read, identical-UID and empty-token swaps, UIDVALIDITY reset at the closing read, yielded attempts across a generation, a walk mark made while a UID-tier attempt is yielded, a yielded attempt whose folder disappears, a late native commit for a removed folder repaired by the state pass expiry, one test per identity/epoch condition, budget-truncated attempts, failed closing read), native digest before one UID enumeration per attempt (stamp invalidated after the terminal page, during the UID scan or the closing read never certifies; another folder's native write at the terminal page, during the UID scan or at the closing read keeps the cold proof with no rescan), walk obligations (failing folder keeps its deferral while another completes, all-folder marks discharged folder by folder, marks during an attempt kept for a later one, unqueued message events, reconnect and capability regain re-walk every folder, overflow marks recorded only for known folders under pressure, pruning), rolling re-walk (late unsignalled removal repaired at the folder's walk and not before, tick not consumed early or under pressure, one idle wake, spaced slices still complete, a multi-page rolling walk spanning a tick walks once, a failing earlier-due folder never starves a healthy one, cadence for N=1/2/71/72/73/500 within period + tick + pass with a burst bound, clustered-offset and topology-driven cohorts within the deadline, cold-start account discovered without an account event), outcome-write retry of a complete session and a change recorded during an in-flight write, a later changed slice resets a complete session and persists it incomplete, capability-keyed quiet veto under 4 s traffic, ownerless-row classification cost (one msgDB Message-ID probe per candidate, no message query, folder URI resolved once per page; a probe interrupted by an event in its folder is retried; a probe that throws, errors or reports an uncertain lookup, or an errored folder state, lets the global query decide; after an uncertain probe a global `absent` removes the row as a ghost and an `error` leaves it unresolved with no cutover); folder-scoped change evidence (cold multi-page missing + stale repair under another folder's mail every 4 s for the whole interval through the real drain and engine wrapper, cold first-page reads equal to a quiet run, inside every native read and local scan page, the same with the other folder prefix-named (`/Cold:Hot`, keys inside the cold folder's raw range), also for the stale direction, colon-bearing Message-ID churn past the ledger cap, unconverted events = every folder, removal-only native change, a native write at the memo reload withholds only its own folder's completion (other folder keeps it), stale direction and stale-owner fences, a same-folder or unattributed re-add between the stale recheck and its removal fence refuses the removal while another folder's write does not, terminal reuse across another folder's write, local ledger eviction floor, a same-folder event after the operation's last own check — checkpoint write, memo reload, UID-tier native-page stamp — withholds completion while another folder's does not, converted and unconverted re-add events for the stale direction; a newer queued intention during a drain retry, or an opposite one in the same millisecond, ends with the index agreeing with the latest event; an older add whose body extraction fails leaves a removal queued during the extraction unmarked; a failed add is dequeued once its retry indexes it; an older add's drain never dequeues a same-type add queued in its millisecond; a delete from `/F` and an add to `/F:Child` sharing one raw key, queued after `/F`'s last own check in the same or a later millisecond, refuse `/F`'s completion until the walk repairs the owner, while an unrelated folder's add leaves it; a stale pass keeps its cursor and removes a ghost beyond the first page while every probe overlaps another folder's native write); the drain-quiet gate defers only the folder a queued update names (a pending add in `/Cold:Hot` never holds `/Cold`'s owed walk; control `/Hot`; an entry with no folder still defers by raw prefix); an unreadable newly inventoried folder (healthy folder's obligation repaired while the new folder fails four ways and the pass re-earns cutover without reading its msgDB; per-row assignment of a new folder's ownerless row, readable or with a failing scan; an unreadable ownerless row never earns cutover); migration never starves a healthy folder's repair (more failing folders than the backoff cap covers, at the production timer cadence; a busy folder written between every slice); a stale pre-upgrade migration record is ignored and dropped on the next memo write; ownerless-row verdicts read only their candidate folders (mail drained into another folder inside every msgDB probe or, after a failed probe, every global recheck still assigns and earns cutover, the row's own folder's mail withholds it, a row classified while foreground pressure rises inside its msgDB probe commits before the tick yields; pressure after a committed assignment or removal keeps the page's cursor and still forces a full replay before cutover; an unresolved verdict read across an event in its own folder is retried, not counted; every row assigned, ghosts removed and cutover earned under recurring foreground pressure that interrupts pages mid-classification; a ghost removal after the page's assignments proceeds on the first slice under other-folder mail — the page's own `/F` assignment never voids its `/F` ghost's removal fence, with the fake's mutators attributed to the native ledger as `ftsSearch` attributes them — and a re-add of the ghost's own key refuses only the ghost row (replayed after the unresolved-retry delay) while a folder rename or an event naming no folder withholds the page; a foreign membership write on the ghost's own key refuses only that row, one on another key in its folder does not, and a write with unknown keys refuses the fence before any assignment commits and the whole page is re-read); membership-state verdicts never outlive their evidence (a row re-added in a folder loaded after the inventory snapshot is kept, owned or ownerless, delivered during the inventory read or the state page; an assignment is not committed when its own key changed while a later row was classified, after its last probe answered, or in its second candidate (refused, then assigned by the delayed replay); a change during the assignment call marks both candidate folders' walks, which repair the owner; every assignment batch is re-checked (two rows per batch in this suite, so a page both shares and crosses batches); within a multi-row batch a row whose own key changed during classification is refused while the batch's other rows and the page's later rows commit (control: unrelated-folder mail commits the whole batch), and a change during the call marks a later row's candidate folders' walks, which repair its owner; a row refused at commit is counted once as unresolved debt while every other row's effect commits, and the delayed replay assigns it); exact folder work before global cleanup completes (alternating pass/folder turns, a no-target turn runs the pass or waits for the unresolved retry with its wake armed, turn reset on reconnect and generation retirement, rolling re-walk before cleanup), affected-folder handoff (retry authorization revoked before a removal, no write without authorization, revocation read/write failure, removal and assignment replies lost, rejected-removal backoff, stale-direction colon overlap), mass-NULL migration cost bound; key-scoped state-pass evidence (MFN ingress records add/delete/move/batch and `<>`-stripped keys before the listener's first await, a high-water-rejected admission records its key, a local key-ledger overflow refuses the page's rows and the replay resolves them, a native key-ledger overflow refuses the removal fence, sustained traffic on one row's own key holds neither a later ghost nor the replay after it stops, steady mail in a ghost's folder and an independent 4-second cadence hold neither the pass, the cleanup nor folder repair) |
| `test/tmMsgNotifyFolderState.test.js` | 7 | `getFolderState` msgDB identity: `incarnationToken` created once under `ensureIncarnationToken`, never created or overwritten without it, generator/setter failures leave it empty; folder scans open with the stored HIGHESTMODSEQ; no msgDB evidence for non-IMAP folders; `probeMessageIds` reports absent and `IMAPDeleted` ids as missing and a failed lookup as `uncertain`, never missing |
| `test/ftsOperationCoordinator.test.js` | 36 | Writer-preferred FTS coordinator, scan status ownership, folder-scoped membership change ledger (per-folder stamps, wildcard, partial-commit and fenced attribution, eviction floor, reset), registered real-folder universe (colon-heavy churn, attribution to every registered folder whose key range holds a key, none before the first inventory, key read scopes unfiltered, explicit owners, unsplittable keys, registration, record-time resolution, universe = latest inventory with re-recording on return); exact key ledger beside it (attempted keys recorded on success, failure, partial commit and inside a fence; clear = wildcard; a keyless mutation passes the key floor; key and folder eviction floors independent; a `{keys}` fence passes writes on other keys) |
| `test/ftsMembershipScopeAttribution.test.js` | 26 | Engine wrappers attribute native mutations to folders: indexBatch/assign owners (an index sent with folderIds and an assignment touch their owner and not a parent whose key range holds the key; a legacy-shape or unsent index is attributed by key, also through a fence), the wrappers apply the native write and return its result against a stateful helper, and each propagates a native failure while still recording the change, removeBatch to registered folders whose key range holds the key incl. parent ranges, clear/unsplittable = wildcard, registered universe, no key attribution before the first inventory, a batch of long colon-heavy keys in time bounded by the registered paths, fenced calls; every wrapper records the exact keys it attempts (capable, failed and legacy index, assignment, removal, fenced removal) |
| `test/folderMembershipIdentity.test.js` | 7 | Opaque `tm-folder:v1:` identity, parsing back only identities it made, first-colon account end of a raw key, no split, folder key-range prefix incl. child folders |
| `test/llmClient.test.js` | 29 | JSON/SSE response parsing, tool call parsing, conversation state |
| `test/pdfText.test.js` | 28 | Bundled pdf.js text extraction from generated PDFs: page ranges and caps, output-limit stop/cut (surrogate-safe), CJK via packed CMaps, encrypted/owner-only/malformed, per-call worker terminated at the deadline even when it never acknowledges |
| `test/attachmentReadPdf.test.js` | 40 | `attachment_read_pdf` tool: argument validation, attachment choice and refusals, size limits (inclusive boundary), output format and notes, unreadable pages, production pdf.js + CMap wiring (registration and activity label are in `test/core.test.js`) |

---

## Testability Tiers

- **VERY HIGH:** Chat tools (31 pure `run()` functions), utility functions, merge algorithms
- **HIGH:** Agent modules (config-driven logic), FSM state machine, KB reminder parsing
- **MEDIUM:** FTS modules, compose helpers (mock-dependent)
- **LOW:** Background scripts, experiment API wrappers (heavy browser dependency)

**Framework:** Vitest (ESM-native, Jest-compatible, minimal config)

---

## 1. Tier 1 — Pure Logic (No Mocks)

### 1.1 Bullet Merge (agent/modules/bulletMerge.js) ✅

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-001 | 3-way merge: base + local addition + remote addition | Both additions present | Happy path |
| TB-002 | 3-way merge: base + local removal + remote addition | Addition kept, removal applied | Merge |
| TB-003 | 3-way merge: both sides remove same bullet | Bullet removed once | Conflict |
| TB-004 | 3-way merge: both sides add same bullet | No duplicate | Dedup |
| TB-005 | 3-way merge: empty base | All additions from both sides | Edge case |
| TB-006 | 3-way merge: empty local and remote | Base returned | Edge case |
| TB-007 | Sectioned merge with headers | Per-section merge | Sectioned |
| TB-008 | Flat merge (no headers) | Global merge | Flat |
| TB-009 | Merge with whitespace variations | Normalized comparison | Normalization |
| TB-010 | Large input (1000+ bullets) | Doesn't hang | Performance |

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
| TB-063 | calendar_event_create → required fields | Validation | Validation |
| TB-064 | kb_add → append to existing KB | Content added | Mutation |
| TB-065 | kb_del → remove specific entry | Content removed | Mutation |
| TB-066 | memory_read → format memory entries | Correct output | Formatting |
| TB-067 | attachment_read_pdf → page range, limits and refusals on generated PDFs | Text or a clear error | Business rule |
| TB-068 | attachment_read_pdf → parse deadline bounds the call | Timeout at the deadline, worker terminated | Robustness |

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

### 3.3 Device Sync (agent/modules/deviceSync.js) ✅

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-090 | State merge with per-field timestamps | Newer wins per field | Merge |
| TB-091 | Echo prevention (suppressBroadcast flag) | No infinite loop | Echo |
| TB-092 | Virgin device detection (all epoch-zero) | Skip broadcast, probe | Detection |
| TB-093 | Peer-base merge (3-way with bulletMerge) | Correct merge result | Algorithm |
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
  bulletMerge.test.js         # 3-way merge edge cases
  kbReminderGenerator.test.js # Reminder parsing formats
  patchApplier.test.js        # Markdown patch application
  utils.test.js               # Utility functions, normalization, folder detection
  chatTools.test.js            # Chat tool interface + specific tool tests
  deviceSync.test.js            # Device sync CRDT, state merge, echo prevention
  llmClient.test.js            # LLM response parsing, tool calls, conversation state
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
