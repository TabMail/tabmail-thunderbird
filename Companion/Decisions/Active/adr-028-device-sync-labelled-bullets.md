# ADR-028: The Knowledge Base and the Rules Sync as Labelled Bullets

**Status:** Accepted (2026-10-29; the store's concurrency rules rebuilt 2026-10-30). The same protocol ships in TabMail for iOS and TabMail Voice;
the three apps run one set of conformance vectors and one default catalog, byte-identical and
SHA-256 pinned in each repository.

## Context

Device Sync sent the knowledge base and the composition and action rules as whole texts and merged
them three ways against a stored peer base (`bulletMerge.js`, `device_peer_base*`). A text says
what a device has, not what its user removed, so a device that was offline, restored from a
backup, copied from another profile or newly installed could remove or bring back bullets nobody
had touched. Timestamps on the whole field could not tell the cases apart.

## Decision

- **Labelled bullets.** Each field is stored as `bullet_state:<field>`: its bullets, each with a
  label (a writer name and a counter), and a `seen` map (the highest counter seen per name). The
  rendered markdown (`user_prompts:user_<field>.md`) is written in the same storage write, so every
  reader keeps reading the text.
- **Observed-remove merge.** A device removes a bullet only when the sender has seen its label and
  no longer holds it: a user deleted it. A bullet the sender never saw is kept. Duplicates of one
  text keep the smallest label. Merging is deterministic, so devices converge.
- **One way in: the prompt semaphore.** `promptStore.js`, in the background page, is the only code
  that reads or writes the three fields, and every access runs in one hold of one semaphore
  (`withPromptStore`). Pages and the chat window reach it through a `prompt-store` runtime message.
  Callers wait in line in the order they asked (first come, first served), each for at most
  `acquireWaitMs`, and one still waiting then is reported as busy; nothing is retried, so an older
  request never lands after a newer one. The semaphore never greys out a control: a page may still
  show progress on a request the user started (a spinner on Compress or Compact). A hold has a lease: a holder past it is released and nothing more of it is saved.
  Template read-change-saves run through the same semaphore, with no template-specific hook.
- **Screens act on what they showed.** A screen reads the text and its labels together
  (`readView`) and saves against the labels it showed (`editShown`, `addLine`, `resetSection`,
  `removeShownItem`); it never reads the text again, so a bullet that arrived meanwhile is never
  deleted or replaced by it. A user's edit is never refused because something else saved meanwhile.
- **AI writers check a change counter.** A refine, Compress or Compact reads in one hold, asks the
  model holding nothing, and writes in a second hold carrying the counter it read. The counter is
  renewed by every commit that saved a change (an edit, a refine, a merge, a legacy import, a reset,
  a restore); if it moved, the AI result is dropped. The one-at-a-time refine chains order the model
  calls and hold nothing of the store; a refine queued before a reset still runs after it.
- **Received messages** are applied one after another in arrival order through one chain. A message
  refused as busy is applied again shortly, holding nothing while it waits; when the connection ends,
  every message still waiting is dropped and peers send their state on the next connect. Past a
  bound of waiting messages the connection is renewed.
- **History.** A reset and a merge record the state they replace in their own hold, before their
  commit; a local edit's history is recorded after a quiet period, in its own hold.
- **Writer names are memory only.** One random name per background process, shared by the three
  fields; a reset or a failed save abandons it, and the next edit takes a fresh one. A
  restored backup or a copied profile can therefore never reuse a name another copy used.
- **Defaults are catalogued.** The default bullets carry fixed labels (`default:<id>`) from the
  bundled catalog, so a new install's defaults are the same bullets as everyone else's, and a reset
  stores the defaults with a seen map of the defaults only: it never advertises the deletion of a
  bullet another device holds.
- **Wire.** `bullet_state` messages carry a field's whole state, split into parts under the relay's
  size budget; a snapshot is merged only when all its parts arrived, and a field with one bullet
  over the budget is not sent. A device answers a merge that changed anything with its own state.
  The relay may limit the message rate, and every part counts: a field of dozens of parts (megabytes,
  far beyond a real knowledge base) could be cut off on each connect.
  Left as it is (2026-10-29).
- **Released apps.** `prompt_state` still carries templates, disabled reminders, the task cache and
  the action config. This app sends request_state only for those four, and answers any
  request_state and sends every `prompt_state` with the three texts empty at epoch zero, which
  released apps skip. A released app's text is imported as additions only.
- **History restore** puts back an entry's three texts as one captured edit of the sections this
  app shows; sections it does not show are left alone.
- **Sign-out** closes the transport and never reaches the prompt store: the texts, their labels,
  the seen map and the writer name stay, and are read and edited as when signed in; only AI calls
  and Device Sync stop. It never waits for a holder and cancels nothing: work begun before it is saved
  like any other, and a refine that reaches its model call signed out fails as any signed-out AI
  call does. Sign-in and sign-out do not renew the change counter. An account change keeps
  everything too; identical texts from the two accounts' groups collapse (DS-DEDUP).

## Consequences

- No bullet a user did not delete is lost by syncing, in any order of delivery, loss, restart,
  restore or copy; this is fuzzed with seeded runs and checked against the shared vectors.
- The legacy peer-base keys are discarded at the upgrade.
- A user who edits on a released app sees those edits arrive as additions only; deletions made
  there do not reach updated devices until they update too.
- `bulletMerge.js` and its tests are removed; the chat KB tools, the KB refines, the action-rule
  updates, the Tasks and Reminders tabs and the prompts page all go through `promptStore.js`.
- Generations, per-field epochs and a second lock in the engine are not used: the semaphore, its
  lease and the change counter are the whole concurrency model.
