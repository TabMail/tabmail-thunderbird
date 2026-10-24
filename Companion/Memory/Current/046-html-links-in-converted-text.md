# HTML links keep their address in converted text; display surfaces show the label

Recorded 2026-10-24 (issue #162).

- **Before.** `stripHtml` / `recursiveHtmlToText` (`agent/modules/utils.js`) turned
  `<a href="https://example.com/x">label</a>` into `label`. Every caller lost the address: the agent
  (summary, action, reply, compose edit, chatlink compose), FTS indexing (`fts/bodyExtract.js`
  `extractPlainText`) and the thread bubbles. A question about a link, or a search for a URL that
  appears only as a link, found nothing.
- **Now.** A link with a non-empty href (after trimming Unicode White_Space) is written as Markdown
  `[label](address)` by `markdownLink` in `agent/modules/markdownLinks.js`, with the iOS rules
  (tabmail-ios #100, `EmailFilter.htmlToPlainText` `finishLink`): the label's whitespace collapses to
  single spaces, split by grapheme cluster as Swift's `Character.isWhitespace` does (a space carrying a
  combining or format mark drops with it; `Intl.Segmenter`); ``\ [ ] ` * _ < > ~`` in the label get a
  backslash and `&` becomes `&amp;`; in the address, Cc, Cf and White_Space code points are
  percent-encoded as UTF-8 and `\ ( ) < > ;` get a backslash. A missing, empty or whitespace-only href
  leaves the label alone; an image-only link keeps its address as `[](address)`; a hidden
  (`display:none`) link is dropped with its address, because the hidden check runs first.
- **Display surfaces unwrap.** `unwrapMarkdownLinks` (same module) is a port of iOS
  `EmailFilter.unwrapMarkdownLinks`: linear, two right-to-left passes, the same one-line grammar. Card
  snippets (`cardSnippetProvider` `_normalizeSnippet`, over the first `linkScanChars` = 32,000 UTF-16
  units, so an image-heavy newsletter's run of empty-label tracking links unwraps to nothing and the
  first sentence shows) and thread bubbles (`threadConversation`: the HTML fallback and the FTS-cache
  body, unwrapped before `bodyMaxLength` truncation) show the label, so what the user sees did not
  change. A text/plain bubble body is shown as written. The snippet cache key (`snippet_v4:`) was NOT
  bumped: unwrapped snippets equal the old label-only ones.
- **Parity evidence.** Differential fuzz against the Swift originals (scratch scripts, not committed):
  `unwrapMarkdownLinks` identical on 200,000 link-heavy random strings; `markdownLink` identical to
  `finishLink`'s escaping on 100,000 random labels and addresses drawn from control, format,
  whitespace and Markdown punctuation code points. The first writer split labels by code point and
  differed on 1,370 of them, all a whitespace grapheme carrying a mark.
- **Not changed.** Whitespace around a link stays TB's (`see<a>x</a>.` gives `see[x](u).`); iOS adds a
  space around a link in its collapsed mode. Exact text parity is tabmail-ios #251's job (a DOM walk
  modelled on TB). Forward-only, as iOS: FTS rows indexed before this change keep the label-only text
  until the message is indexed again. Quote detection reads an attribution with a link
  (`Bob <[bob@example.com](mailto:bob@example.com)> wrote:`) unchanged: no quote pattern depends on an
  angle-bracketed address.
- **Tests.** `test/markdownLinks.test.js` (writer, unwrapper, `stripHtml` on a real jsdom DOM,
  `extractUserWrittenContent`, `extractPlainText`), `test/threadConversationLinks.test.js`, and the
  newsletter case in `test/cardSnippetWakeProvider.test.js`.
