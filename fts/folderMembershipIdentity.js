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
