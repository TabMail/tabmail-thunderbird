# Cold-start inventory absence is NOT deletion evidence — trust the account before removing on absence

Hotfix 1.7.7, 2026-09-11. Root cause of the 2026-09-10 mass FTS wipe (~58k native rows across four
accounts, whole archive trees; one account with ~134k rows survived because it happened to be loaded).

## What happened

`_listWeFolderIdentities()` builds the folder-reconciliation inventory from `browser.accounts.list(true)`.
That call returns the accounts Thunderbird has LOADED at that moment, not the accounts that exist. On a
cold start whole accounts can be missing for 30+ minutes. ADR-024's membership state pass
(`_runFolderMembershipStateSlice`) and post-cutover orphan sweep (`_folderReconOrphanSweep`) treated
"owner `folderId` not in this fresh inventory" as proof the folder was deleted and removed the rows in
`removeBatch` pages of 50. Helper logs showed ~91k verify reads = 1828 × 50 removals right after
`listFolderMembershipState`; the persisted memo later held a full 92-folder inventory with byte-identical
folderIds, proving the encoding was fine and only the inventory was partial.

The legacy `_reconcileCleanupStaleEntries` path always had this guard (`ensureAccountChecked`:
`accounts.get` + `folders.query`, skip unseen accounts). The ADR-024 port (f06fb02, 2026-08-22) did not
carry it over, and the recon test suite's `'empty inventory'` case BLESSED the wipe by asserting removal.

## The rule

- A row may be removed on inventory absence only if its `accountId` (the `msgId` prefix before the first
  `:`) is in `_folderReconTrustedAccountIds(inventory)`. Otherwise keep it and count
  `unloadedAccountRowsKept`.
- An empty inventory removes nothing. "Empty inventories still clean orphans" (ADR-022) is revoked.
- Accepted fail-closed cost: a genuinely removed account keeps ghost rows until an explicit repair scan.
- Recovery for an affected profile: Full Maintenance Scan / full reindex (FTS is derived; mail is untouched).
  A Thunderbird restart on 1.7.6 or earlier can repeat the wipe.

Pinned by `test/ftsFolderReconScheduler.test.js` ("never removes a row on inventory absence when
Thunderbird has loaded no folders at all", "keeps rows of an account absent from a cold inventory while
still removing stale rows of a loaded account"); both fail on 1.7.6 code.

## 1.7.8 follow-up (2026-09-11) — the LEGACY sweep had the same hole

The post-merge review of 1.7.7 found the guard was only on the exact-membership branch of
`_folderReconOrphanSweep`. Helpers without `folderMembershipV1` take the legacy branch: keys with no
known folder prefix go to `recheckMessageInFolder`, whose global query cannot see an unloaded account
and therefore answers "absent" → removed, five per slice. 1.7.8 builds `trustedAccountIds`
unconditionally and applies the same keep-rule before `parseUniqueId`. Five tests in
`test/ftsFolderRecon.test.js` and one in the scheduler suite had ghost rows under accounts absent from
the inventory (`gone:`, `ghostAcct:`) and asserted removal — blessing tests; they now use a loaded
account with a vanished folder (`account1:/Deleted`), which is the only legitimate orphan shape.
