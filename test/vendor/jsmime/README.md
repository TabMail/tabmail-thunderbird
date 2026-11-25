# JSMime (test only)

Thunderbird's own MIME and address-header parser, used by the tests as the reference for how
Thunderbird parses From, To and Cc headers (`test/helpers/tbAddressParser.js`). It is a
development dependency: `test/` is in the web-ext ignore list, so nothing here ships in the XPI.

- **Source:** `mailnews/mime/jsmime/jsmime.mjs` and `mailnews/mime/jsmime/LICENSE` in
  https://hg.mozilla.org/releases/comm-release/
- **Revision:** tag `THUNDERBIRD_161_0_RELEASE`, changeset
  `f53f287971bad7e05aaa26bbefdda84c4aa6a16e`
- **License:** MIT (`LICENSE`, copied unmodified)
- **Modified:** no. SHA-256 of `jsmime.mjs`:
  `200f67442b0b9fc4ab3f59fd2f55c75f5897a96125500af97d7d8d520cc0e3b9`

The add-on supports Thunderbird 145 and later. The parser changed after 145 (encoded words are
matched only where a token starts, and folded line breaks in addresses are unfolded). Every
address header the tests use parses the same with this revision and with the file as of
Thunderbird 145 (changeset `6c235b16893a96e54c51014a7a94992cfefed627`).

To update: replace both files with the same revision's copies, update the revision and hash
above, and re-check the expected values in the tests that use the helper.
