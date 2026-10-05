# ADR-025: The Native FTS Helper Is Told This Profile's Data Directory, Never Left to Guess

> Authored directly in the routed tree on 2026-10-05; the index carries only the keyword-bearing summary.

## Context

The native FTS helper is a separate process started by `runtime.connectNative("tabmail_fts")`. Nothing in the native-messaging launch tells it which Thunderbird profile started it. Its `init` RPC accepts an optional `profilePath`. Without one, `handle_init` (helper `src/main.rs`) calls `find_thunderbird_profile_dir()`, which picks the directory under the platform's `Thunderbird/Profiles` folder with the **newest modification time**. It then opens `<that profile>/browser-extension-data/<addonId>/tabmail_fts/fts.db` and `memory.db`.

The add-on never sent `profilePath`; it sent only `addonId`. With two profiles in use (two Thunderbird instances, or switching profiles), a helper could open the **other** profile's databases:

- The membership reconciliation (ADR-022/ADR-024) compares the open index against **this** profile's folders and accounts. Rows owned by the other profile's folders look orphaned or ghost, so they could be removed from that profile's index.
- Two helpers, one per running instance, could open and write the same SQLite files at once.
- Search, chat memory and `safeGetFull`'s index lookup could answer from the other profile's mail.

## Decision

- The `tmMsgNotify.getFtsDataDir()` experiment returns `PathUtils.join(PathUtils.profileDir, "browser-extension-data", extension.id)`. This is the directory the helper's auto-detect would have built for the right profile.
- `initNativeFts` sends `init` with `{ profilePath }` set to that directory. The helper uses it directly as the data parent, so the database paths are unchanged for a profile in the standard Profiles directory.
- **Fail closed.** If the directory is unavailable (the experiment throws, or returns an empty value), no `init` is sent. `initNativeFts` rejects and the existing init-failure path runs: the port is disconnected and the helper status becomes `missing` (retried by the recheck alarm). There is no fallback to auto-detect, because auto-detect is the defect.
- Every supported helper honours `profilePath`. The override exists in every helper tag from v0.7.0, and the add-on accepts only helpers ≥ `NATIVE_FTS_BRIDGE_VERSION` (0.11.1, ADR-023). So the fix needs no helper release.
- The dead `nativeFtsSearch.init()` method was deleted. It had no callers and would have sent `init` without a profile.

## Consequences

- With `profilePath`, the helper skips its legacy `<profile>/tabmail_fts` → `browser-extension-data` migration. That location predates the first public release (2026-01-23), so nothing released uses it.
- A user whose helper opened a different directory than this profile's now gets this profile's own database. This covers multi-profile users whose index was opened from the wrong profile. It also covers some single-profile users whose profile is outside the standard Profiles directory: a custom or portable profile path, Linux without `~/.thunderbird` (for example snap or flatpak, where auto-detect fell back to `~/.tabmail`), or Linux where a non-profile directory under `~/.thunderbird` had the newest modification time. The startup walk (ADR-022) indexes this profile's mail into it; the owner accepts the re-index (2026-10-05). Chat memory sessions that were indexed into the other profile's `memory.db` are not re-indexed, because the one-shot memory migration flag is already set in this profile's storage.
- The old database is not left on disk. Where the guess put it in a directory no profile reads (`~/.tabmail`, a non-profile directory beside the profiles, or a profile without the add-on installed), the helper moves the most recently written one into this profile on its first `init` with `profilePath` when this profile has no index yet, so the index and chat memory carry over and the startup reconciliation repairs it; it removes the others (helper ADR-NF-007; owner chose "move and fix", 2026-10-05). An orphan on another volume is removed and rebuilt instead. This needs the helper release that carries ADR-NF-007; until a user's helper updates, this profile starts a new index and the old file stays.
- Rows that one profile's helper already wrote into another profile's index stay there. When their accounts are absent from that profile, ADR-024 keeps them as unloaded-account rows. This ADR stops the contamination growing; it does not clean it up, and there is no way to (owner accepts, 2026-10-05).
- Tests: `test/nativeFtsProfileBinding.test.js` (init carries this profile's directory; no `init` when the directory lookup throws, is empty or is missing; the experiment's path; the schema entry).
- Possible follow-up in the helper repository: refuse `init` without `profilePath` instead of guessing. It is not needed for correctness while every add-on version that ships this ADR sends the path, but releases before it still rely on auto-detect.
