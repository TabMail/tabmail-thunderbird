# MimeJSComponents (test only)

Thunderbird's `MailServices.headerParser` (`MimeAddressParser`), used by the tests as the reference for
how Thunderbird reads and writes compose window recipients (`test/helpers/tbComposeRecipients.js`):
`parseEncodedHeaderW`, `makeMimeAddress` and `makeFromDisplayAddress`, the display-form reader that turns
recipient text into address pills. It is a development dependency: `test/` is in the web-ext ignore
list, so nothing here ships in the XPI. The helper runs each file as it is, with Thunderbird's JSMime
(`test/vendor/jsmime`) for its imports.

- **Source:** `mailnews/mime/src/MimeJSComponents.sys.mjs`
- **`MimeJSComponents-145.sys.mjs`:** https://hg.mozilla.org/releases/comm-release/ changeset
  `6c235b16893a96e54c51014a7a94992cfefed627` (Thunderbird 145). The file as of Thunderbird 140.0esr
  (tag `THUNDERBIRD_140_0esr_RELEASE` in https://hg.mozilla.org/releases/comm-esr140/, changeset
  `959edee1e81280ddfadeae63de076102502927b7`) is byte-identical.
  SHA-256 of `MimeJSComponents-145.sys.mjs`:
  `7a7a90a686fd1b0f05ef87eae0eb2c4b1b11d7ac21cdae5d27b95c4f01c23b13`
- **`MimeJSComponents-161.sys.mjs`:** tag `THUNDERBIRD_161_0_RELEASE` in
  https://hg.mozilla.org/releases/comm-release/, changeset `f53f287971bad7e05aaa26bbefdda84c4aa6a16e`
  (the JSMime revision in `test/vendor/jsmime`). Its `makeFromDisplayAddress` is the same as in
  Thunderbird 160.0.
  SHA-256 of `MimeJSComponents-161.sys.mjs`:
  `519334812d56ec6e09e78dd6c345c2403372916e00738835b6b8925196a0d57e`
- **License:** MPL 2.0 (the file header).
- **Modified:** no (both hashes checked by `test/vendoredJsmime.test.js`).

The add-on supports Thunderbird 140.0 to 160.* (`manifest.json`). `makeFromDisplayAddress` changed
after 145: from Thunderbird 160 it reads text with a colon and a later semicolon as a group list when
every entry has an `@`, and it finds the address of a quoted name holding angle brackets differently.
Tests that depend on it run with both files.

To update: replace a file with the same path at the new revision, update its revision and hash above,
and re-check the expected values in the tests that use the helper.
