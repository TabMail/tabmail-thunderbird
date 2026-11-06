# What the XPI contains: web-ext-config.mjs, and how release builds read it

The add-on package is built with `web-ext build` from a `git archive` export of the release ref, so
the XPI is every tracked file minus what web-ext leaves out. Two sources decide what is left out:

- web-ext's own defaults: dotfiles and dot-folders, `node_modules`, `*.xpi`, `*.zip`.
- `ignoreFiles` in `web-ext-config.mjs`: repository documents (README, CLAUDE, AGENTS, DECISIONS,
  PROJECT_*, TESTS, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT), `Companion/`, `design/`, `test/`,
  `scripts/`, `package*.json`, `vitest.config.js`, the config itself, developer notes inside runtime
  folders (`**/ARCHITECTURE.md`, `**/README*.md`, `**/README.txt`), and local build output.

**web-ext reads a config file only from its working directory (or the home directory), or when given
`--config`.** It never looks in `--source-dir`. A release build runs from elsewhere with
`--source-dir <export>`, so it must pass `--config <export>/web-ext-config.mjs`. A `.web-extignore` file
is not a web-ext feature at all: the one this repo had until 2026-11-06 was never read, and every
release up to 1.11.0 shipped `test/`, `Companion/` and the internal docs (1056 entries, 5.9 MB, against
623 entries, 4.5 MB with the config).

web-ext matches every path, folders included, with multimatch after resolving the pattern against the
source directory. A matched folder is skipped with everything in it, so a plain top-level name such as
`test` leaves out the whole folder, while `chat/test` would not be matched by it. The config file may
export only option names web-ext knows: it merges named exports into the config and rejects unknown ones.

**Checks:**
- `test/xpiContents.test.js` applies the same rules to `git ls-files` and pins the shipped top-level
  entries to an explicit list (runtime folders, `manifest.json`, `LICENSE`, `THIRD_PARTY_LICENSES.md`,
  `TRADEMARKS.md`). A new top-level entry fails it until it is added to that list or to `ignoreFiles`.
  It also checks that every file the manifest names ships, and that `prompts/*.md` (runtime) does.
- `scripts/check-xpi-contents.mjs <xpi>` lists a built XPI (`unzip -Z1`) and fails on any file the rules
  leave out, or on a missing manifest or license notice. Release builds run it after `web-ext build`.
