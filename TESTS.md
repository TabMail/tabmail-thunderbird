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
| `test/p2pSync.test.js` | 31 | State merge, CRDT, echo prevention, virgin device detection |
| `test/llmClient.test.js` | 29 | JSON/SSE response parsing, tool call parsing, conversation state |

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

### 3.3 P2P Sync (agent/modules/p2pSync.js) ✅

| # | Test | Expected | Category |
|---|------|----------|----------|
| TB-090 | State merge with per-field timestamps | Newer wins per field | Merge |
| TB-091 | Echo prevention (suppressBroadcast flag) | No infinite loop | Echo |
| TB-092 | Virgin device detection (all epoch-zero) | Skip broadcast, probe | Detection |
| TB-093 | Peer-base merge (3-way with bulletMerge) | Correct merge result | Algorithm |
| TB-094 | Template CRDT merge (by ID, newer updatedAt wins) | Correct per-template | CRDT |
| TB-095 | DisabledReminders merge (per-hash, newer ts wins) | Correct per-hash | CRDT |

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
  p2pSync.test.js              # P2P sync CRDT, state merge, echo prevention
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
