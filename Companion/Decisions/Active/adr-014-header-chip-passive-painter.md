# ADR-014: Header Chip Is a Passive Painter; Click Targets the Chip's Own Message

> Routed out of `DECISIONS.md` § ADR-014 by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
**Context:** The iOS-style action chip needed to also appear in the message preview-pane header (`#expandedButtonsBox`). The card-view chip already exists (`tmMessageListCardView`). For the header chip, two design choices needed pinning down: (1) whether to share state with `tmMessageListCardView` or build a sibling experiment, and (2) what the click should act on — the current 3-pane selection (like the Tab key) or the chip's own message.

**Decision:**
1. Build a sibling experiment `theme/experiments/tmMessageHeaderChip/`. Never write action state — read `tm-action` mork prop, with `_actionFromKeywords_MHC` legacy fallback. The chip is purely a *display* of `action:<uniqueKey>` IDB state surfaced via the prop.
2. The chip carries its own `data-tm-we-msg-id`. Click → `onActionChipClick` event → MV3 calls `performTaggedAction({id: weMsgId})` directly, bypassing the selection-based `triggerTagActionKey`.
3. CSS refactor: relax the four per-action chip rules in `tmTheme/theme.css` from `tr[is="thread-card"].tm-action-X .tm-action-chip` to `.tm-action-chip.tm-action-X` so the same paint rules cover both surfaces. Card-row tinting (separate ruleset) is unaffected.

**Rationale:**
- Sibling experiment instead of extending the card view: the header lives in the chrome `about:message` document and must also work in standalone `messageWindow.xhtml`; the card view is `mail:3pane`-scoped and patches `ThreadCard.prototype.fillRow`. Different lifecycles → mixing would muddy both. Per `PLAN_TB_LABEL_V2.md` §5a, experiments don't reliably share module state, so a sibling with copied action constants is the right shape.
- Click acts on chip's message, not selection: selection can drift between paint and click (snippet-fetch repaints can shift selection); standalone message windows have no `mailTabs` selection at all (`mailTabs.getSelectedMessages` is empty); embedding `weMsgId` on the chip itself eliminates both failure modes.
- CSS scope relaxation: the four per-action rules' bodies never referenced row-scoped CSS variables — the `tr[is="thread-card"]` ancestor scoping was vestigial. Relaxing it lets one ruleset paint both surfaces with no row-side change. The header chip additionally carries a `tm-header-action-chip` marker class so click delegation can scope to header chips and never accidentally fire on a card chip.

**Consequences:**
- Refresh triggers: `messageDisplay.onMessagesDisplayed` (MV3) + `actionCache.setAction`/`clearAction`/`clearActionByUniqueKey` (MV3) + internal MutationObserver on `#headerSubjectSecurityContainer` (50 ms debounce). At the prop-writing sites, `_writeActionToHdr` MUST be `await`ed before `_refreshHeaderChip` fires — parallel dispatch would let the painter read the OLD mork prop because both calls are parent-process IPC roundtrips. See PLAN_HEADER_CHIP.md §6.
- `clearActionByUniqueKey` calls `_refreshHeaderChip` only as symmetric coverage — today's caller (`onMoved.js:288`) is actually covered by `onMessagesDisplayed` firing on the post-move new-folder hdr. The trigger exists for hypothetical future call sites where the mork prop has been cleared independently.
- Known limitation: `contextMenus.js:230` `clearActionCache` bypasses `actionCache.js` AND doesn't clear the mork prop, so "Remove TabMail tags" via right-click leaves the chip stale. Pre-existing inconsistency, not addressed here.
<!-- END PRESERVED BLOCK -->
