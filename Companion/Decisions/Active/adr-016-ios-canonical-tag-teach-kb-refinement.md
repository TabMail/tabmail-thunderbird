# ADR-016: iOS Is Canonical for Tag-Teach and KB-Refinement Flows

> Routed out of `DECISIONS.md` § ADR-016 (first of two ADR-016 ids in this file) by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
**Context:** Two long-running LLM refinement flows exist in both TB and iOS:
(1) tag-teach — refine `user_action.md` when the user overrides an agent-assigned tag; (2) KB refinement — refine `user_kb.md` from chat session turns. The default project stance (ADR-IOS-008) is "TB is the reference implementation." For these two flows specifically, an audit concluded iOS has the correct design for trigger timing, concurrency guards, and merge strategy. TB had three gaps: (a) no post-response re-read guard in tag-teach (concurrent device-sync or config-page edits during the LLM flight could clobber updates); (b) KB refinement fired per assistant turn rather than at session idle-end (LLM spam, mid-session clobbering); (c) `_kbUpdateImpl` used direct-replace instead of the 3-way merge already implemented correctly in `_periodicKbUpdateImpl`.

**Decision:** For these two flows, iOS is the canonical reference. TB is aligned by three changes:
1. `autoUpdateUserPrompt.js` — insert a re-read guard after `sendChat` returns; skip patch apply if `user_action.md` drifted during the backend call.
2. Move `periodicKbUpdate()` trigger from `converse.js` (per-assistant-turn) to `init.js` `_insertSessionBreak()` (session-boundary). Fires on both page-load and idle-driven breaks; internal gates (min exchanges, cooldown) unchanged.
3. `_kbUpdateImpl()` — replace direct-replace with `mergeFlatField(base, local, remote)`, mirroring the existing pattern in `_periodicKbUpdateImpl()`. Future-proofs the conversation-memo path even though it is currently unreachable (chat.js omits `conversationHistory`; background.js guard filters empty calls).

**Rationale:**
- Re-read guard defends against cross-flow writers that bypass the per-flow semaphore (device sync, config-page edits).
- Session-boundary trigger matches the user's mental model of "I finished chatting" and avoids per-turn LLM spend.
- 3-way merge is strictly safer than direct-replace with no behavioral cost when nothing has drifted.

**Consequences:**
- TB KB refinement now runs at most once per session boundary instead of once per assistant turn.
- `kbUpdate()` retains future value once the chat-close path is rewired to pass session turns; the merge logic is correct regardless.
- Deviates from "TB is reference" for these flows only. All other AI processing parity rules (ADR-IOS-008) continue to treat TB as canonical.
<!-- END PRESERVED BLOCK -->
