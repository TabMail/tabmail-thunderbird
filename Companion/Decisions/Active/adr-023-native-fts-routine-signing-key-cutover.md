# ADR-023: Native FTS Signing-Key Cutover Uses One Bridge Release, Then Revokes the Previous Key

> Authored directly in the routed tree on 2026-08-13 rather than extracted from `DECISIONS.md`; the manifest's `sha256_preserved_block` is `-` and the index carries only the keyword-bearing summary.

**Context:** Native FTS update manifests carry one Ed25519 signature. A routine rotation therefore cannot switch signers in the same release that first introduces the new public key: an old helper trusts only the previous key and must be able to verify and install a bridge helper that trusts both. Keeping the previous verification key trusted forever avoids stranding clients but permanently expands the update acceptance set. A client that remains offline throughout the overlap may miss the bridge and cannot verify a later new-key-signed manifest.

**Decision:** Use v0.11.1 as the dual-key bridge. After the bridge update path and Thunderbird reinstall fallback were verified on August 13, 2026, promote the pending signer and make Thunderbird 1.7.2 enforce the bridge boundary immediately:

- The v0.11.1 bridge manifests remained signed by the previous active private key through the verification phase, so an old-key-only v0.10.1 helper could self-update into the temporary two-public-key bridge.
- Promotion of the pending private key is a separate reviewed operation. It was explicitly authorized after the bridge update and Thunderbird Beta reinstall UI were verified; it was not an automatic timer mutation.
- The bridge is the only release that trusts both public keys. After signer promotion, the next helper release removes the previous public key. For this rotation, v0.11.2 is the first new-key-only release; v0.11.1 is the last release that trusts the previous key.
- Thunderbird 1.7.2 classifies a helper older than v0.11.1 as `unsupported`, disconnects it before FTS initialization/indexing, raises the normal toolbar action warning, and turns the popup/settings helper CTA into a clear re-download/reinstall prompt.
- Reinstall replaces the helper/host registration, not its existing SQLite search database. Native hosts are resolved at `connectNative()` time, so the one-minute re-probe detects the replacement without restarting Thunderbird and indexing resumes from the preserved database.
- `available: false` remains the compatibility signal for existing UI logic, while structured status distinguishes `missing` from `unsupported` and includes the installed version, minimum supported version, and cutoff.

**Rationale:** The verified bridge gives already-online clients a cheap in-place update. The explicit reinstall path makes the accepted offline residual visible and recoverable instead of leaving an opaque signature-update failure. Removing the previous verification key in the successor release bounds the trust set; rollback to a release signed only by a retired key is deliberately not supported.

**Consequences:**

- The Thunderbird release carrying this policy and prompt must ship before hosted manifests switch to the promoted signer.
- A helper older than v0.11.1 intentionally stops local FTS under Thunderbird 1.7.2+ until reinstalled, even if its existing binary/database could still answer some RPCs.
- A v0.11.1 helper can verify the promoted signer and self-update to v0.11.2; v0.11.2 no longer accepts manifests signed by the previous key.
- The user's search index is preserved; no full reindex is caused solely by reinstalling the helper.
- Signer promotion remains an operator-reviewed server-side action recorded independently from the local compatibility boundary.
- Compromise response may still revoke/remove a key immediately, without waiting for a bridge, and accepts the resulting reinstall requirement.
