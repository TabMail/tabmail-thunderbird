# ADR-018: Body Extraction for FTS/Snippets Is HTML-First with an HTML-Document Guard on the text/plain Fallback

> Routed out of `DECISIONS.md` § ADR-018 by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
**Context:** Card snippets and FTS bodies are derived by `fts/bodyExtract.js extractPlainText()`. It originally preferred the `text/plain` MIME part verbatim and only stripped `text/html` when no plain part existed. A real-world sender (survey platform, 2026-06) shipped `multipart/alternative` whose text/plain part contained the **full HTML document** — the card snippet rendered raw `<!DOCTYPE html>...` source, and the raw HTML was indexed into native FTS (then re-served by `safeGetFull`'s FTS-synthetic path, which labels stored bodies `text/plain`). iOS was immune because its `EmailFilter.extractPlainText` prefers `htmlBody` and converts it.

**Decision:** Flip `extractPlainText()` to HTML-first, matching iOS:
1. Prefer `text/html` parts → `stripHtml()`; use the result if non-blank.
2. Fall back to `text/plain`, **guarded**: if the assembled text starts with an HTML document marker (`<!DOCTYPE` / `<html` + whitespace/`>`, case-insensitive, leading whitespace allowed), run it through `stripHtml()` instead of trusting it.
3. `snippetCache` prefix bumped `snippet_v3:` → `snippet_v4:` (the designed invalidation mechanism for extraction-logic changes; the 90-day IDB TTL would otherwise keep stale raw-HTML snippets for months).

**Rationale:** The HTML part is what the user actually sees rendered — deriving search/snippet text from it makes garbage plain-text alternatives (raw HTML, whitespace-only, 1-char stubs) irrelevant. The guard covers the two cases preference order can't: mislabeled single-part HTML mail, and FTS-synthetic bodies indexed before this fix (strips at read time; already-polluted index rows are deliberately left in place — they heal on any future reindex). The guard is document-start-only by design: a generic "looks like HTML" tag heuristic corrupts legitimate plain text containing angle brackets (quoted addresses, code, `a < b`) — same reasoning as iOS `BodyRenderer`'s display-path comment. iOS mirrors the guard in `EmailFilter.looksLikeHTMLDocument` (Shared/Parse/EmailFilter.swift).

**Consequences:**
- Snippets/FTS now reflect rendered content; immune to malformed text/plain alternatives.
- `stripHtml` (DOMParser) now runs for every multipart message at index time, not just HTML-only mail — acceptable: indexing is batched background work, and iOS pays the same cost by design.
- FTS-indexed text for multipart mail changes from the sender's plain part to stripped HTML going forward; old rows are not migrated (search-equivalent in practice).
- AI features unaffected: `extractBodyFromParts` (utils.js) is a separate extractor whose callers always `stripHtml()` afterward.
<!-- END PRESERVED BLOCK -->
