/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// App-owned durable identity for the native folder-membership relation.
// JSON's canonical string escaping makes the ordered two-string tuple
// injective without delimiter ownership, while preserving every JavaScript
// code unit (including percent signs, colons, NFC/NFD distinctions, and
// non-BMP characters). Consumers compare this opaque value only; they never
// decode it to address a Thunderbird folder.
const FOLDER_MEMBERSHIP_ID_PREFIX = "tm-folder:v1:";

export function makeFolderMembershipId(accountId, folderPath) {
  if (typeof accountId !== "string" || accountId.length === 0
      || typeof folderPath !== "string" || folderPath.length === 0) {
    throw new Error("folder_membership_identity_input_invalid");
  }
  return `${FOLDER_MEMBERSHIP_ID_PREFIX}${JSON.stringify([accountId, folderPath])}`;
}

// Every folder id whose rows or raw key range a native key could belong to.
// A key is `${accountId}:${folderPath}:${headerMessageId}` and any of the
// three parts may contain ":", so every account/path split is a candidate;
// the true owner and every ancestor whose key range contains the key are
// always among them. Returns null when no split exists (unknown scope).
export function folderMembershipIdCandidatesForKey(msgId) {
  if (typeof msgId !== "string") return null;
  const colons = [];
  for (let i = msgId.indexOf(":"); i !== -1; i = msgId.indexOf(":", i + 1)) colons.push(i);
  const candidates = [];
  for (let a = 0; a < colons.length; a++) {
    const accountEnd = colons[a];
    if (accountEnd === 0) continue;
    for (let p = a + 1; p < colons.length; p++) {
      const pathEnd = colons[p];
      if (pathEnd === accountEnd + 1 || pathEnd === msgId.length - 1) continue;
      candidates.push(makeFolderMembershipId(
        msgId.slice(0, accountEnd),
        msgId.slice(accountEnd + 1, pathEnd),
      ));
    }
  }
  return candidates.length > 0 ? candidates : null;
}

// The folder-scope of one membership mutation: every candidate of every key
// plus the explicit owners it writes, or "*" when any key is unattributable.
export function folderMembershipScope(msgIds, explicitFolderIds = []) {
  const scope = new Set();
  for (const msgId of msgIds) {
    const candidates = folderMembershipIdCandidatesForKey(msgId);
    if (!candidates) return "*";
    for (const folderId of candidates) scope.add(folderId);
  }
  for (const folderId of explicitFolderIds) {
    if (folderId) scope.add(folderId);
  }
  return scope;
}
