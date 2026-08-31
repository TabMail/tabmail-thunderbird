/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

async function recipientAddressKey(recipient) {
  const address = recipient && typeof recipient === "object" ? recipient.email : recipient;
  try {
    const parsed = await messenger.messengerUtilities.parseMailboxString(
      String(address || ""),
      true
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 1 ||
      parsed[0]?.group ||
      typeof parsed[0]?.email !== "string" ||
      !parsed[0].email.trim()
    ) {
      return "";
    }
    return parsed[0].email.trim().toLowerCase();
  } catch (_) {
    return "";
  }
}

/**
 * Preserve To exactly and remove Cc entries for the same mailbox. Unparseable
 * entries remain untouched, and Bcc is intentionally outside this policy.
 */
export async function removeToDuplicatesFromCc(to = [], cc = []) {
  const toAddresses = new Set((
    await Promise.all((Array.isArray(to) ? to : []).map(recipientAddressKey))
  ).filter(Boolean));
  if (toAddresses.size === 0) return Array.isArray(cc) ? cc : [];

  const ccAddresses = await Promise.all(
    (Array.isArray(cc) ? cc : []).map(recipientAddressKey)
  );
  return (Array.isArray(cc) ? cc : []).filter((recipient, index) => {
    const address = ccAddresses[index];
    return !address || !toAddresses.has(address);
  });
}
