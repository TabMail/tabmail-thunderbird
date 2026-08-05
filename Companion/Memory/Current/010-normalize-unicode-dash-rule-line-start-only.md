# normalizeUnicode dash rule is now line-start-only (utils.js)

> Routed out of `PROJECT_MEMORY.md` § Recent Discoveries → 2026-06-28 by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `PROJECT_MEMORY.md`.

<!-- BEGIN PRESERVED BLOCK -->
- **`normalizeUnicode` (`agent/modules/utils.js`) only converts dashes to ASCII `-` at the START of a line** (regex `(^|\n)([ \t]*)[…dashes…]` → `$1$2-`, indentation preserved). An **inline** dash (em-dash used as prose punctuation, ranges like `10–20`) is deliberately **left intact**. Was previously a blanket `[…]→'-'` that collapsed every em-dash to a typo-looking `-`.
- **Why keep ANY dash normalization:** the real reason is **LLM response parsing** — models frequently emit en/em-dash list bullets (`– item`) where the summary/action/KB parsers expect `- item`. Line-start normalization fixes the bullet without mangling prose. (NOT primarily cosmetic — the parser dependency is the load-bearing reason; confirmed with owner.)
- **Call sites unchanged** — `normalizeUnicode` is still applied everywhere it was (the blanket `sendChat` hook at `llm.js:1492`, `markdown.js` render, the KB/reminder/task tools, `patchApplier`). Only the dash sub-rule changed. Quotes/ellipsis/space normalization untouched.
- **iOS parity:** `tabmail-ios/.../AI/AIHelpers.swift normalizeUnicode` mirrors this exact rule. iOS compose/reply is intentionally NOT normalized (HTML email + no inline-autocomplete diff), so proper typography reaches recipients there. (iOS side also had a latent `\u{...}`-in-raw-string ICU bug that made its dash/quote/space regexes silent no-ops — fixed same day; see iOS PROJECT_MEMORY "Swift Gotchas".)
<!-- END PRESERVED BLOCK -->
