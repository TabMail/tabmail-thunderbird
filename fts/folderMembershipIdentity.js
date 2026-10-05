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

// The folder a membership id names, so native keys can be matched against
// its key range (never to address a Thunderbird folder), or null for any
// value makeFolderMembershipId did not produce.
export function parseFolderMembershipId(folderId) {
  if (typeof folderId !== "string" || !folderId.startsWith(FOLDER_MEMBERSHIP_ID_PREFIX)) return null;
  try {
    const parts = JSON.parse(folderId.slice(FOLDER_MEMBERSHIP_ID_PREFIX.length));
    if (Array.isArray(parts) && parts.length === 2
        && typeof parts[0] === "string" && parts[0].length > 0
        && typeof parts[1] === "string" && parts[1].length > 0) {
      return { accountId: parts[0], folderPath: parts[1] };
    }
  } catch (_) {}
  return null;
}

// A native key is `${accountId}:${folderPath}:${headerMessageId}`. Account
// ids carry no ":", so the account ends at the first one; the path and the
// Message-ID may hold ":", so any later ":" with a non-empty path before it
// and a non-empty remainder after it can end the path. Returns the account's
// end index, or -1 when the key has no such split (unknown scope).
export function folderMembershipKeyAccountEnd(msgId) {
  if (typeof msgId !== "string") return -1;
  const accountEnd = msgId.indexOf(":");
  if (accountEnd <= 0) return -1;
  const pathEnd = msgId.indexOf(":", accountEnd + 2);
  return pathEnd !== -1 && pathEnd <= msgId.length - 2 ? accountEnd : -1;
}

// The prefix every native key in a folder's rows or raw key range starts
// with (child folders' keys included); a key is in the range when it is
// longer than the prefix and starts with it.
export function folderMembershipKeyPrefix(accountId, folderPath) {
  return `${accountId}:${folderPath}:`;
}
