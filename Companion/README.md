# Companion — routed detail for `tabmail-thunderbird`

The files in this tree hold the **detail** that used to sit inline in this subproject's
mandatory-load companion documents. They are paid **only when a task actually needs them**.

`../PROJECT_MEMORY.md`, `../DECISIONS.md`, `../PROJECT_STRUCTURE.md` and `../CLAUDE.md` are read on
**every task, by every agent, forever** — so a paragraph there is paid thousands of times, while the
same paragraph here is paid on demand. That asymmetry is the entire reason this tree exists. See the
monorepo root `CLAUDE.md` § *Hierarchy discipline* and the `companion-compact` skill.

## How to use it

1. Read the compact index (`../PROJECT_MEMORY.md`, `../DECISIONS.md`) in full — it is the search
   surface, one keyword-bearing line per routed topic.
2. `rg -ni '<your terms>' ../PROJECT_MEMORY.md ../DECISIONS.md Companion/` from the subproject root.
3. Read **every matched detail file in full** before planning, editing, reviewing, or answering.

## Layout

```
Companion/
├── Memory/
│   ├── Current/     live implementation knowledge, quirks, gotchas
│   ├── History/     resolved investigations, superseded narratives (never deleted)
│   └── manifest.tsv
├── Decisions/
│   ├── Active/      ADRs in force
│   ├── Superseded/  ADRs replaced by a later decision (never deleted)
│   ├── Deferred/    decisions reserved but not started
│   └── manifest.tsv
├── Process/{Current,History}/ + manifest.tsv
└── Rules/Active/ + manifest.tsv
```

`manifest.tsv` columns: `tree`, `status`, `source` (the index file the block came from),
`sha256_preserved_block` (hash of the byte-for-byte moved text), `sha256_file`, `path`, `title`.

## Invariants

- **Routing is a MOVE, never an edit.** Each detail file carries the original block verbatim between
  `<!-- BEGIN PRESERVED BLOCK -->` / `<!-- END PRESERVED BLOCK -->`. No paraphrasing, no merging of
  entries, no truncation, no rewording — those are content loss wearing compaction's clothes.
- **Nothing is ever deleted.** Superseded material moves to `History/` or `Superseded/` and stays
  routed and searchable.
- **Safety rules and absolute prohibitions stay INLINE** in the index at full length. On-demand
  loading of a safety rule means it is loaded only when someone already suspected they needed it.
- **When you learn something durable:** write the detail here, then add/update exactly ONE
  keyword-bearing line in the index. Never inline the detail into the index "just this once" — that
  is how every index in this repo re-bloated past the size it was compacted from.

Run `.claude/skills/companion-compact/measure.sh tabmail-thunderbird` (from the monorepo root) after any
companion edit. Over budget ⇒ run the `companion-compact` skill.
