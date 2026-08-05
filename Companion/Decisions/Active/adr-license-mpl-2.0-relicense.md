# ADR-LICENSE: Relicensed to MPL 2.0 (PolyForm Noncommercial → MPL 2.0)

> Routed out of `DECISIONS.md` § ADR-LICENSE by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
**Context:** The TabMail Thunderbird add-on was source-available under PolyForm Noncommercial 1.0.0, which bars commercial use and is not OSI-approved open source. To make the desktop client genuinely open — auditable and forkable — and to match the iOS client's positioning, the add-on is relicensed.

**Decision:** Relicense the add-on to the **Mozilla Public License 2.0**, in place (no history rewrite). Per-file MPL headers added; root `LICENSE` carries the full MPL 2.0 text. Shipped as **v1.6.0** (the `1.6.0` tag is the relicense). Its partner crate `tabmail-native-fts` (the native-messaging FTS host) is relicensed in lockstep (bumped to `0.9.0`); the iOS client moved to MPL 2.0 at the same time.

**Rationale:** MPL 2.0 is OSI-approved weak copyleft at file granularity — modifications to MPL files stay open, while integrators may ship proprietary surrounding code; GPL-compatible via the secondary-license clause; well understood by enterprise legal. Lets anyone read, build, contribute to, or fork the add-on while protecting our changes.

**Consequences:**
- The add-on (XPI source + `marketplace/` listing) is genuinely open source.
- The hosted TabMail backend (AI orchestration, prompt content, infra) and signing identities stay proprietary — out of scope.
- The "TabMail" name and logo remain trademarks (see `TRADEMARKS.md`); forks must rebrand.
- Contributions require a DCO sign-off (`git commit -s`).
<!-- END PRESERVED BLOCK -->
