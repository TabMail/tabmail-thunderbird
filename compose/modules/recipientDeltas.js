/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export function parseComposeRecipient(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const match = raw.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  if (!match) return { name: "", email: raw };

  let name = (match[1] || "").trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    name = name.slice(1, -1);
  }
  return { name, email: (match[2] || "").trim() };
}

function formatForCompose(recipient) {
  if (!recipient?.email) return null;
  const name = String(recipient.name || "").trim();
  const email = String(recipient.email).trim();
  return name ? `${name} <${email}>` : email;
}

async function parseComposeMailbox(raw, parseMailboxString) {
  try {
    const parsed = await parseMailboxString(String(raw || ""), true);
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

async function applyDelta(currentList, delta, parseMailboxString) {
  const current = await Promise.all(
    (currentList || []).map(async (raw) => ({
      raw,
      address: await parseComposeMailbox(raw, parseMailboxString),
    }))
  );
  const clearAll = (delta.removes || []).some((email) => email === "*");
  const removeSet = new Set(
    (delta.removes || [])
      .filter((email) => email !== "*")
      .map((email) => String(email).toLowerCase())
  );
  const result = clearAll
    ? []
    : current.filter(({ address }) => !address || !removeSet.has(address));
  const seen = new Set(result.map(({ address }) => address).filter(Boolean));

  for (const add of delta.adds || []) {
    const email = String(add?.email || "").trim();
    if (!email || email === "*") continue;
    const key = email.toLowerCase();
    if (!seen.has(key)) {
      const recipient = { name: String(add?.name || "").trim(), email };
      result.push({ raw: formatForCompose(recipient), address: key });
      seen.add(key);
    }
  }

  return result;
}

/** Build the Thunderbird compose patch for an AI inline recipient edit. */
export async function buildInlineRecipientPatch(current, deltas, parseMailboxString) {
  const patch = {};
  const effective = {};
  for (const field of ["to", "cc", "bcc"]) {
    effective[field] = await applyDelta(
      current[field],
      deltas[field] ?? { adds: [], removes: [] },
      parseMailboxString
    );
    if (deltas[field] !== undefined) {
      patch[field] = effective[field].map(({ raw }) => raw).filter(Boolean);
    }
  }

  if (deltas.to !== undefined || deltas.cc !== undefined) {
    const toAddresses = new Set(
      effective.to.map(({ address }) => address).filter(Boolean)
    );
    const filteredCc = effective.cc.filter(
      ({ address }) => !address || !toAddresses.has(address)
    );
    if (filteredCc.length !== effective.cc.length) {
      patch.cc = filteredCc.map(({ raw }) => raw).filter(Boolean);
    }
  }

  return patch;
}
