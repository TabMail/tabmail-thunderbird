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
// A key is `${accountId}:${folderPath}:${headerMessageId}`. Account ids carry
// no ":" (the account is the text before the first one), but the path and
// the Message-ID may, so every later ":" is a candidate path end; the true
// owner and every ancestor whose key range contains the key are always among
// them. Returns null when no split exists (unknown scope).
export function folderMembershipIdCandidatesForKey(msgId) {
  if (typeof msgId !== "string") return null;
  const accountEnd = msgId.indexOf(":");
  if (accountEnd <= 0) return null;
  const accountId = msgId.slice(0, accountEnd);
  const candidates = [];
  for (let pathEnd = msgId.indexOf(":", accountEnd + 1); pathEnd !== -1; pathEnd = msgId.indexOf(":", pathEnd + 1)) {
    if (pathEnd === accountEnd + 1 || pathEnd === msgId.length - 1) continue;
    candidates.push(makeFolderMembershipId(accountId, msgId.slice(accountEnd + 1, pathEnd)));
  }
  return candidates.length > 0 ? candidates : null;
}

// Every folder whose rows or key range the keys (plus explicit owners) can
// touch, or "*" when any key is unattributable: the read scope of a fence
// that guards those keys.
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
