# ADR-030: The Stored Chat Turns' One Writer Is an In-Memory Chain

**Status:** Accepted (2026-11-08). Issue #263. Supersedes
[ADR-029](../Superseded/adr-029-chat-turns-one-writer-queue.md).

## Context

ADR-029 fixed Clear All coming back with the chat window open (#252) with two things: every change
to `chat_turns` is an operation on the stored list rather than a whole array, and one background
module applies them. Around that it built a persisted queue on the `messageProcessorQueue` pattern:
`chat_turns_pending` saved before a change was accepted and restored at load, a retry timer and the
alarm `tabmail-chat-turns-retry`, an admission cap (`maxQueued`), a read time limit, a bounded caller
wait with a `queued` reply and a `CHANGE_UNCONFIRMED` refusal, and every reader merging the saved
queue (`loadTurns`). That was 260 lines of module and about 2,150 lines of tests and fault harness.

The fix for #252 is the operations and the single writer. The persisted queue only adds that a
change in flight survives a restart, which the FTS pending queue deliberately does not offer either:
its pending updates are not kept across a restart.

## Decision

- **Keep:** the operations (`clear`, `remove`, `keepFrom`, `update`, `append`; pure
  `persistentChatStore.applyTurnsOperation`), pages sending them as `chat-turns-change` messages
  (`changeTurns`), the background's own writers calling `enqueueTurnsChange`, `requireTaken` on
  every reply, and `chat/modules/storedTurnsQueue.js` as the only writer of `chat_turns` (in
  `_apply`), loaded only by the background.
- **Replace the queue with one in-memory promise chain.** Each change waits for the one before it,
  then reads the stored turns, applies the operation, writes, and answers `{ applied: true,
  removed }`; a failed read or write answers `{ applied: false, error }` and the chain goes on to
  the next change. The caller waits for its own change, with no time limit.
- **Delete:** `chat_turns_pending` and its restore, the retry timer and alarm, `maxQueued`, the read
  time limit, the `queued` and `CHANGE_UNCONFIRMED` replies, the change id, the queue merge in
  `loadTurns`, `CHAT_SETTINGS.turnsQueue`, and their tests (the fault suite and the seeded fuzzer).
- **The retired key** `chat_turns_pending` (shipped in 1.11.x, normally `[]`) is removed once by the
  chat store's migration v3 (`chat_turns_migration_v3`), the existing one-time migration pattern.

## Consequences

- A Clear All is never undone by an older copy: no page writes a whole list, and changes apply one
  at a time in the order they reach the background.
- A change in flight when Thunderbird quits or the background unloads mid-write is lost and, if its
  caller is still there, reported to it as failed; the user repeats it. A change still in the 1.11.x
  saved queue at upgrade is dropped the same way.
- Chat History's Delete Old no longer says "queued for removal": it says what it deleted, or that it
  failed.
- A storage read that never settles holds every later change (there is no read limit any more);
  `browser.storage.local` has no known hang, and a background restart clears it.
- The census (`test/chatTurnsSingleWriter.test.js`) now covers `chat_turns` only; the rule that only
  the background loads the writer stays, since a second loader would be a second chain.

## Amendment 2026-11-09: what a removed turn owns goes with it (#256, #257)

Two stores hold things a turn owns: its thinking (IndexedDB, `thinking:<turn id>`) and its message
references in the chat window's id map (`chat_id_map`, counted per turn from `_refs`). The budget
eviction in the open window cleaned both up for the turns it evicted; Chat History's Delete Old
cleaned up neither (#256), and a window open during a Clear All saved its whole id map back
afterwards (#257).

- **Thinking follows the stored turn.** The writer (`_apply`) removes the stored thinking of every
  turn the change removes, including those the budget drops to fit an append
  (`applyTurnsOperation` returns them as `gone`), after the write. A failed thinking removal is
  logged and the change still answers applied. The window's own `removeThinking` calls on eviction
  are deleted: the stored turns are what the model's context reads, so their thinking lasts exactly
  as long as they do.
- **The id map holds the stored turns' references, decided when the window opens.** The id map
  belongs to the open chat window, which keeps the references of every turn it shows, removed or
  not, so a shown reference never comes to name another message. Each window start rebuilds the
  reference counts from the stored turns it loaded (`buildRefCounts`, step 3c of
  `initAndGreetUser`) and frees every id none of them references. References of turns removed
  while no window was open, or saved back by a window that was open during a Delete Old or Clear
  All, are released at the next open.
- **Not done:** the window is not told of a Clear All, so the map and metadata it saves afterwards
  stay in storage until the chat window next opens. Nothing reads them before then; the window's
  start releases the references, and a knowledge-base cursor naming a removed turn already reads
  as "every turn", the state a budget eviction leaves. Thinking can still be left behind: by a Delete
  Old before this change, by an answer whose turn fails to store (its thinking is saved first), and by the background unloading
  between a change's write and its thinking removal. Nothing reads it, as no stored turn names it,
  and Clear All removes it.
