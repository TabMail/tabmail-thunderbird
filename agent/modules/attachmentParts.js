/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// agent/modules/attachmentParts.js
// Attachments of a message, read from the MIME tree messages.getFull() already returned.
//
// Thunderbird sets MessagePart.name exactly on the parts it treats as attachments, and sets it to
// "" when the file has no name (ext-messages.js convertMessagePart). The walk does not descend
// into a named part, so an attached email counts as one file, as in Thunderbird's attachment list.

// Thunderbird's message reader does not count these toward the paperclip (msgHdrView.js); the
// FTS flag, inbox_read and email_read follow the same rule so their answers agree.
const NOT_PAPERCLIP_TYPES = new Set(["text/vcard", "text/x-vcard", "application/pgp-keys"]);

export function collectAttachmentParts(parts, out = []) {
  for (const part of Array.isArray(parts) ? parts : []) {
    if (typeof part?.name === "string") {
      out.push({ name: part.name, contentType: part.contentType || "", size: part.size ?? 0 });
    } else {
      collectAttachmentParts(part?.parts, out);
    }
  }
  return out;
}

// The attachments of a getFull() result, or null when its tree cannot tell: no tree, a body
// served from the FTS index (synthetic, no parts), a headers-only message (getFull drops its
// parts), or a message Thunderbird could not decrypt (getFull drops its parts).
export function listAttachmentsFromFull(full, header) {
  if (!full || full.__tmSynthetic) return null;
  if (header?.headersOnly === true) return null;
  if (full.decryptionStatus === "fail") return null;
  return collectAttachmentParts([full]);
}

export function hasPaperclipAttachment(attachments) {
  return attachments.some(att => !NOT_PAPERCLIP_TYPES.has(String(att.contentType).toLowerCase()));
}

// The text the FTS index stores for a message's attachment names, one file per line. The index
// splits words only at spaces and punctuation, so a name written as one run (TaxReceipt2024.pdf)
// is followed by the same name split where the case or digits change ("Tax Receipt 2024.pdf").
export function attachmentNamesText(attachments) {
  return attachments.filter(att => att.name).map(att => {
    const words = splitNameWords(att.name);
    return words === att.name ? att.name : `${att.name} ${words}`;
  }).join("\n");
}

function splitNameWords(name) {
  return name
    .replace(/(\p{Ll})(?=\p{Lu})/gu, "$1 ")
    .replace(/(\p{Lu})(?=\p{Lu}\p{Ll})/gu, "$1 ")
    .replace(/(\p{L})(?=\p{N})|(\p{N})(?=\p{L})/gu, "$1$2 ");
}
