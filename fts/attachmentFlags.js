/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fts/attachmentFlags.js
// Whether the index's hasAttachments column can be trusted.
//
// Thunderbird's MessageHeader has no attachment field, so rows indexed before the indexer read
// Thunderbird's database flag all store hasAttachments = 0. A full smart reindex re-adds the
// stale rows (fts/indexer.js indexMessages); the first one that finishes with no repair failure
// sets this marker, and from then on readers use the index's flag. Until then they ask
// Thunderbird.

const REPAIRED_KEY = "fts_attachment_flags_repaired";

export async function areAttachmentFlagsRepaired() {
  const stored = await browser.storage.local.get(REPAIRED_KEY);
  return stored[REPAIRED_KEY] === true;
}

export async function markAttachmentFlagsRepaired() {
  await browser.storage.local.set({ [REPAIRED_KEY]: true });
}
