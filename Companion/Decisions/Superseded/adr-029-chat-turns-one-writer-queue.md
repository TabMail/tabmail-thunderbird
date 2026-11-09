# ADR-029: The Stored Chat Turns Have One Writer, a Persisted Queue in the Background

**Status:** Superseded (2026-11-08) by [ADR-030](../Active/adr-030-chat-turns-in-memory-write-chain.md): the persisted
queue, its retry, cap, read limit and bounded wait are gone; the operations and the one background
writer stay. Accepted 2026-11-07, issue #252.

## Context

The chat window keeps its conversation (`chat_turns` in `browser.storage.local`) in memory
(`ctx.persistedTurns`) and wrote that whole array back: after each message (500 ms debounce), when
a task result arrived, at the first greeting, and when the window closed (`beforeunload`). Chat
History's Clear All removed `chat_turns` and Delete Old wrote the newer turns back, each from the
settings page, and the scheduled-task delivery in the background read the turns, appended its
result and wrote the array. Every one of these writers replaced the list with its own copy, so:

- Clear All or Delete Old with the chat window open came back at the next message or when the
  window closed (#252);
- a scheduled task that read the turns before a Clear All wrote the cleared turns back with its
  result;
- a task result or turn stored by another page while the window opened was dropped when the window
  saved its copy;
- the char budget counted `chat_meta.totalChars`, a copy of the turns' size that the window also
  wrote back, so a stale count evicted new turns.

A lock shared by every page (Web Locks) was tried first. It serialised the writers but a change
still waiting for the lock when its page unloaded, or refused as busy, was lost. The message queue
(`agent/modules/messageProcessorQueue.js`) already solves "persist at once, apply in order, retry,
survive a restart" for email processing; its module is email-specific (per-message keys, inbox and
resolve rules, processing and action-cache steps), so the chat turns follow its pattern in their
own small module rather than a generalised one.

## Decision

- **One writer, in the background.** `chat/modules/storedTurnsQueue.js` is the only code that
  writes `chat_turns` (in `_apply`) and its own queue key `chat_turns_pending` (in `_save`).
  Every change is an operation on the stored list, never a whole array: `clear`, `remove` (ids),
  `keepFrom` (time: Delete Old), `update` (replace by id: the one-time refs migration), `append`
  (skips stored ids, then the budget), defined once in `persistentChatStore.applyTurnsOperation`
  (pure). An apply reads the stored turns, applies the operation and writes the result; a failed
  read rejects and writes nothing.
- **Pages send, the background queues.** Extension pages call `changeTurns(op)`
  (`persistentChatStore.js`), which sends `{ command: "chat-turns-change", id, op }`; the
  background's runtime listener routes it to `handleStoredTurnsMessage`, next to the other store
  commands. The background's own writers (the scheduled-task delivery) call `enqueueTurnsChange`.
  Every caller checks the reply with `requireTaken` (`changeTurns` for pages, the task delivery
  directly), so a refused change is an error to it, never taken or logged as stored.
- **Accepted means saved; applied in order; nothing accepted dropped.** `enqueueTurnsChange` adds
  the change to the queue and saves the queue (`_save`; saves run one at a time, each writing the
  queue as it is then, less the changes already applied). The change is accepted once a save
  holding it succeeds; one whose save fails is taken off the queue and refused (`{ applied: false,
  error }`), never answered as queued, and never applied. One drain at a time applies only
  accepted changes, the head first: after applying it, it saves the queue without it, and only
  once that save succeeds does it move to the next change. A failed save keeps the applied head
  (its result kept, so it is not applied again) and stops the drain, so a restart can never apply
  an older change after a newer one. The module restores the queue and starts applying it as soon
  as the background loads it; a change sent meanwhile waits for the restore, so it is queued after
  the restored ones. Only the background loads the module (a page that did would be a second
  drainer).
- **Retry, at a bounded rate.** An apply that fails, or whose read of the stored turns runs past
  `turnsQueue.applyTimeoutMs`, stays at the head and is retried after `turnsQueue.retryDelayMs`
  and by the named alarm `tabmail-chat-turns-retry`, which wakes a suspended background (60 s
  minimum period). The alarm is set before a drain applies anything, and when the saved queue
  cannot be restored (its contents unknown), so a background stopped mid-apply or mid-restore is
  woken to finish; it is cleared only once a drain has emptied the restored queue. The alarm only
  wakes: a change is applied even when it cannot be set (that is logged). Only the read is limited: a read
  changes nothing, so giving up on it is safe; a write once issued is waited for, so no later
  write can overtake it. New changes are accepted during the retry delay but do not cut it short
  (only the alarm does). At most `turnsQueue.maxQueued` changes wait, counting those still
  waiting for the restore before they can be queued; beyond that a change is refused at once, so
  a restore that does not finish holds no more than that. Each operation gives the same stored turns applied twice, so a change applied just
  before a restart is safely applied again.
- **Bounded wait, no busy UI.** A caller waits for its change at most `turnsQueue.applyWaitMs`
  in all, counted from the moment it sends (the restore and its save included), then is answered
  `{ applied: false, queued: true }` if the change is accepted (applied later, in order), or
  refused: `not accepted in time` when the change was never queued, or `CHANGE_UNCONFIRMED` when
  its save is still under way (the change is then applied if that save succeeds). What a waiting
  caller needs lives on its queued change, so `maxQueued` bounds it too. Nothing is greyed out: a turn stays shown in the window, and Delete Old says the
  old turns are queued for removal when its change is not applied yet. A Clear All or Delete Old
  whose change is refused or unconfirmed shows that it failed, never what it would have removed.
- **The window's copy is for display only.** `appendTurn(turn, turns)` adds the turn to the
  window's copy (kept within the budget, its evictions returned for the refs and thinking cleanup)
  and sends that one turn as an append. The window never saves its copy: the `beforeunload` save
  writes `chat_meta` and the id map only, a task result delivered to the open window is added to
  its copy only (the background already queued it), and the window's load-time cleanup removes the
  turns it dropped by id.
- **The model's context is the stored turns, with the queue applied.** `loadTurns()` reads
  `chat_turns` and `chat_turns_pending` together and applies the queued changes to its copy, and
  `filterAndConvertTurns()` reads through it, so turns Chat History removed leave the model's
  context at once, even while the removal is still queued; the open window still shows them until
  it is opened again. Chat History's turn count reads through it too, so it agrees with a Clear
  All or Delete Old still queued.
- **The budget counts the turns.** `enforceBudget(turns)` sums `_chars` over the list it trims;
  `chat_meta.totalChars` is no longer read or written.

## Consequences

- Clear All, Delete Old, the chat window, a scheduled task and Retry are applied in the order sent;
  a message sent during Delete Old is kept after the removal, and a window closed with a change
  still queued loses nothing.
- A census test (`test/chatTurnsSingleWriter.test.js`) fails on any `storage.local` set, remove or
  clear that may name `chat_turns` outside `_apply`, or `chat_turns_pending` outside `_save`
  (following the key through constants, tables of keys, objects and lists built up first, spread,
  `Object.assign`, and aliases of `storage`, `storage.local` and its methods, declared, destructured
  (from `browser` too) or assigned later, read through dots, brackets or optional chaining, and `call`/`apply`), for either key,
  and on any file outside the
  background loading the queue (through imports, re-exports and page script tags, at any depth).
  `proactiveCheckin.js` loads the queue for the task delivery and is loaded by pages too; it counts
  as background only because only `background.js` starts that delivery, which the census also
  checks (no other file names `primeProactiveAlarmListener` or `initProactiveCheckin`).
  Fixtures check that it finds each of those forms.
- A seeded fuzzer (`test/storedTurnsQueue.fuzz.test.js`) sends random changes while every storage
  call fails or is slowed at random and the background restarts, and checks that the stored turns
  end as every accepted change applied once in order, the saved queue ends empty, writes never
  overlap, and no reply claims more than happened.
- The window still removes from the stored turns, by id, the turns it drops over the budget when
  it starts, although the next append would trim them: their message references are released at
  that moment, and a later start must not drop and release them again.
- The background registers its runtime listener when `background.js` is first evaluated, so a
  change sent to a suspended background wakes it and is queued. Only while the add-on itself is
  reloading or updating, when its pages close too, can a send get no answer; the sender then
  treats it as failed (a turn stays shown and is logged, a Chat History action says it failed).
- The id map and thinking of turns Delete Old removes are not cleaned up (as before), and the
  window still writes back `chat_meta` and the id map on close; neither changes which turns are
  stored.
