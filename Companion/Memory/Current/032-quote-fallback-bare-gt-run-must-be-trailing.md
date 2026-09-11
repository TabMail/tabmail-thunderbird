# The bare ">" quote fallback must be a TRAILING run — an embedded ">" excerpt in a digest is never a collapse boundary

Landed 2026-09-10 on `agent/tb-quote-trailing-run` (commit `7ed4acc`). Sibling of
[004-quote-collapse-inline-font-boundary.md](004-quote-collapse-inline-font-boundary.md), inverted:
there the boundary was right and the anchor wrong; here the anchor mechanics were right and the
boundary was wrong.

- **Symptom**: a Reddit daily digest (Mailchimp-style nested tables) rendered with only the header
  and the first post visible; posts 2–5, the "View More Posts" button and the footer all sat inside
  `.tm-quote-content` behind "Show quoted text". Reproduced identically on iOS
  (`tabmail-ios/logmain.log` `[QuoteDetect] Result: boundaryLine=324`, `visibleText=253chars` of a
  75 KB body).
- **Root cause** (`agent/modules/quoteAndSignature.js`, `replyBoundaryPatterns` entry
  `type: "quoted"`): no structured reply boundary matched, so detection fell through to the bare
  `^>` fallback. Its only guard was `quotedFallbackMinConsecutiveLines` (2), added for the lone
  `›› Read the full story` newsletter link. The second post's preview quoted a TELUS notice with
  three literal `&gt;` lines — a legitimate `>` block that is not a reply quote — and the fallback
  never looked at what FOLLOWED the run. `detectInlineAnswersInPlainText` did not rescue it because
  it demands a full cycle (quoted → non-quoted → quoted); the digest is quoted → a 40-plus-line
  non-quoted tail → nothing. `topLevelBQs` was 0, so the blockquote inline-reply check was inert.
- **Fix**: the `quoted` entry's `multiLineCheck` now also requires the run to be trailing: after
  the `>` run ends, at most `config.quotedFallbackMaxTrailingLines` (10, owner-chosen 2026-09-10)
  non-blank non-`>` lines may follow before end of text or a non-quoted `-- ` signature delimiter
  (`findQuoteRegion` already ends the collapsed region there). Scope is the `quoted` fallback only;
  attribution and structured boundaries are untouched. Both the plain-text and DOM paths share
  `findBoundaryInPlainText`, so one change covers both.
- **Why a line count, and why 10**: a sign-off plus an undelimited HTML signature is well under
  ten lines; a digest tail or a bottom-posted answer is far over it. The failure directions are
  asymmetric — declining to collapse leaves content visible, collapsing wrongly hides the message —
  so the threshold errs toward bailing. A bottom-posted reply (quote first, answer below) now also
  stays uncollapsed, which is the correct outcome.
- **Rejected**: collapsing only the `>` lines themselves (sub-text-node wrapping across `<a>`
  inside table cells — the anchor-mapping fragility of 004); per-sender bulk-mail signals
  (`.mcnPreviewText`, `List-Unsubscribe`) — the next forum digest lacks them; deleting the
  fallback outright — plain-text replies from clients that emit no attribution line still need it
  (owner may still rule on this).
- **Tests**: `test/quoteAndSignature.test.js` › `quoted fallback requires a TRAILING ">" run` —
  digest shape, bottom-posted reply, sign-off + undelimited-signature negative control,
  `-- `-delimited long tail control, config pin. Three were red on the pre-fix module.
- **Parity**: the iOS `collapseQuotesJS` fallback in `AutoSizingHTMLView.swift` carries the same
  2-consecutive-lines rule and needs the same trailing-run rule and constant (ADR-IOS-008
  parity). Pending at the time of writing.
