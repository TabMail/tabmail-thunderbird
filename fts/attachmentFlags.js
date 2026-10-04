/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fts/attachmentFlags.js
// Which accounts' rows the index's hasAttachments column can be trusted for.
//
// Thunderbird's MessageHeader has no attachment field, so rows indexed before the fix all store
// hasAttachments = 0. The indexer now reads attachments from the message it downloads; a full
// smart reindex re-adds each account's stale old rows with Thunderbird's database flag
// (fts/indexer.js indexMessages) and records the account here once every one of its folders was
// listed and no repair batch failed. Readers trust the index for a recorded account and ask
// Thunderbird for any other. Per account because on a cold start Thunderbird can leave whole
// accounts out of accounts.list() for a long time (memory 033).

const REPAIRED_ACCOUNTS_KEY = "fts_attachment_repaired_accounts";

// The account id is the msgId prefix before the first ":" (accountId:folderPath:headerID).
export function accountIdOfMsgId(msgId) {
  const text = String(msgId || "");
  const separator = text.indexOf(":");
  return separator > 0 ? text.slice(0, separator) : "";
}

export async function getAttachmentRepairedAccounts() {
  const stored = await browser.storage.local.get(REPAIRED_ACCOUNTS_KEY);
  const ids = stored[REPAIRED_ACCOUNTS_KEY];
  return new Set(Array.isArray(ids) ? ids.map(String) : []);
}

// Only full scans write this, and they hold the exclusive FTS scan lease.
export async function markAttachmentAccountsRepaired(accountIds) {
  if (accountIds.length === 0) return;
  const repaired = await getAttachmentRepairedAccounts();
  for (const id of accountIds) repaired.add(String(id));
  await browser.storage.local.set({ [REPAIRED_ACCOUNTS_KEY]: [...repaired] });
}
