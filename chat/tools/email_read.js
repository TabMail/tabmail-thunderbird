/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// email_read.js – returns a full email content with summaries

import { hasPaperclipAttachment, listAttachmentsFromFull } from "../../agent/modules/attachmentParts.js";
import { extractBodyFromParts, getRealSubject, getUniqueMessageKey, log, resolveUniqueMessageKey, safeGetFull } from "../../agent/modules/utils.js";
import { makeFolderMembershipId } from "../../fts/folderMembershipIdentity.js";
import { ftsRequest } from "../../fts/ftsRequest.js";
import { encodeStoredIcs, extractIcsFromParts, formatIcsAttachmentsAsString, storedIcsParts } from "../modules/icsParser.js";



// The invite text for a body the index served. A stored invite is formatted as it is read. An
// old formatted value (earlier versions stored the parser's output, which named an all-day day
// a day early west of UTC) is never shown: the invites are read again from the message itself and
// the raw parts written back to the index. When the message cannot be read (offline, not kept on
// this computer), the invite is left out.
async function indexedIcsText(stored, header, internalId) {
  const parts = storedIcsParts(stored);
  if (parts !== null) return formatIcsAttachmentsAsString(parts);
  let icsAttachments;
  try {
    const full = await safeGetFull(internalId, header, { skipIndex: true });
    icsAttachments = await extractIcsFromParts(full, internalId);
  } catch (e) {
    log(`[TMDBG Tools] email_read: old stored invite not re-derived (message unreadable): ${e}`, "warn");
    return "";
  }
  try {
    const msgId = await getUniqueMessageKey(header);
    const folderId = makeFolderMembershipId(String(header.folder?.accountId || ""), String(header.folder?.path || ""));
    const parsedIcsAttachments = encodeStoredIcs(icsAttachments);
    await ftsRequest("rewriteStoredIcs", { msgId, folderId, parsedIcsAttachments }, async ({ ftsSearch }) => {
      const { rewriteStoredIcs } = await import("../../fts/indexer.js");
      return rewriteStoredIcs(ftsSearch, { msgId, folderId, parsedIcsAttachments });
    });
  } catch (e) {
    log(`[TMDBG Tools] email_read: stored invite write-back failed: ${e}`, "warn");
  }
  return formatIcsAttachmentsAsString(icsAttachments);
}

export async function run(args = {}, options = {}) {
  try {
    const uniqueId = args?.unique_id;
    
    log(`[TMDBG Tools] email_read: Starting with unique_id='${uniqueId}' (type: ${typeof uniqueId})`);
    
    if (!uniqueId || typeof uniqueId !== 'string') {
      log(`[TMDBG Tools] email_read: invalid or missing unique_id: ${uniqueId}`, "error");
      return { error: "invalid or missing unique_id" };
    }

    const resolved = await resolveUniqueMessageKey(uniqueId);
    if (!resolved) {
      log(`[TMDBG Tools] email_read: unique_id did not have one live structured match: ${uniqueId}`, "error");
      // Note the error message below is sent to the LLM, so we should not
      // reveal the format here (it relies on a translator)
      return { error: "Invalid unique_id" };
    }
    
    const { weFolder, headerID, weID: internalId } = resolved;
    log(`[TMDBG Tools] email_read: uniqueId='${uniqueId}' -> weFolder='${weFolder}' headerID='${headerID}'`);

    // Direct fetch using headerIDToWeID + safeGetFull (faster than FTS database query)
    // FTS was designed for full-text search, not for single message lookups by ID
    let header = null;
    let body = "";
    let parsedIcs = "";
    let full = null;

    log(`[TMDBG Tools] email_read: Using direct fetch (headerIDToWeID + safeGetFull) for faster response`);
    log(`[TMDBG Tools] email_read: Calling headerIDToWeID with headerID='${headerID}' weFolder='${weFolder}'`);
    
    // Get header for complete information
    header = await browser.messages.get(internalId);
    if (!header) {
      log(`[TMDBG Tools] email_read: messages.get(${internalId}) returned null after resolution`, "error");
      return { error: "message not found after resolution" };
    }
    log(`[TMDBG Tools] email_read: Successfully resolved by live folder evidence: headerID='${headerID}' -> weID=${internalId}`);
    
    // Get body using safeGetFull
    try {
      full = await safeGetFull(internalId);
      body = await extractBodyFromParts(full, internalId) || "";
      log(`[TMDBG Tools] email_read: Body extracted from safeGetFull (length: ${body.length})`);
      
      if (full?.__tmSynthetic) {
        // A body served from the FTS index has no MIME parts to scan; the index keeps the raw
        // invites the indexer took from the downloaded message, formatted here.
        parsedIcs = await indexedIcsText(full.parsedIcsAttachments, header, internalId);
        log(`[TMDBG Tools] email_read: ICS text from the FTS index (length: ${parsedIcs.length})`);
      } else {
        // Extract ICS attachments while we have the full message
        try {
          const icsAttachments = await extractIcsFromParts(full, internalId);
          log(`[TMDBG Tools] email_read: ICS scan complete from full message. found=${icsAttachments.length}`);
          parsedIcs = formatIcsAttachmentsAsString(icsAttachments);
        } catch (e) {
          log(`[TMDBG Tools] email_read: ICS scan failed: ${e}`, "warn");
        }
      }
    } catch (e) {
      log(`[TMDBG Tools] email_read: safeGetFull failed for ${internalId}: ${e}`, "error");
      return { error: "could not load full message" };
    }

    // Resolve unique header key for traceability
    let headerKey = "";
    if (internalId) {
      try { 
        headerKey = (await getUniqueMessageKey(internalId)) || "";
        log(`[TMDBG Tools] email_read: Generated headerKey='${headerKey}' from weID=${internalId}`);
      } catch (e) {
        log(`[TMDBG Tools] email_read: Failed to generate headerKey: ${e}`, "warn");
      }
    } else {
      // Use the original uniqueId when WebExtension resolution failed
      headerKey = uniqueId;
      log(`[TMDBG Tools] email_read: Using original uniqueId as headerKey: '${headerKey}' (WebExtension resolution failed)`);
    }
    try {
      const subject = header?.subject || ftsResult?.subject || "";
      const author = header?.author || ftsResult?.from_ || "";
      log(`[TMDBG Tools] email_read: resolved - weID=${internalId} headerKey='${headerKey}' subject='${subject}' from='${author}'`);
    } catch (_) {}

    // No longer getting summary fields as our model has now enough context.
    // // Get summary fields (cached if available)
    // let blurb = "";
    // let detailed = "";
    // let todos = "";
    // try {
    //   const s = await getSummary(header, true);
    //   blurb = s?.blurb || "";
    //   detailed = s?.detailed || "";
    //   todos = s?.todos || "";
    // } catch (e) {
    //   log(`[TMDBG Tools] email_read: getSummary failed for ${internalId}: ${e}`);
    // }

    // Thunderbird's MessageHeader has no attachment field. The MIME tree fetched for the body
    // lists the files exactly, at no extra cost. When there is no usable tree (a body served from
    // the FTS index, a headers-only or undecryptable message), the answer is Thunderbird's
    // database flag (the paperclip heuristic) and no list.
    // null = could not tell, printed as "unknown", never "no".
    const attachments = listAttachmentsFromFull(full, header);
    let hasAttachments = null;
    if (attachments) {
      hasAttachments = hasPaperclipAttachment(attachments);
    } else {
      try {
        const [flag] = await browser.tmHdr.getHasAttachmentBulk([internalId]);
        if (typeof flag === "boolean") hasAttachments = flag;
      } catch (e) {
        log(`[TMDBG Tools] email_read: attachment flag read failed for ${internalId}: ${e}`, "error");
      }
    }
    log(`[TMDBG Tools] email_read: has_attachments=${hasAttachments} listed=${attachments ? attachments.length : "n/a"} for ${internalId}`);

    // Check replied status using tmHdr experiment
    let repliedStatus = false;
    try {
      [repliedStatus] = await browser.tmHdr.getRepliedBulk([internalId]);
      log(`[TMDBG Tools] email_read: Replied status=${repliedStatus} for message ${internalId}`);
    } catch (e) {
      log(`[TMDBG Tools] email_read: Error checking replied status for ${internalId}: ${e}`, "warn");
      // Default to false on error
      repliedStatus = false;
    }

    // Format a clear, single string result for the LLM
    const lines = [];
    lines.push(`unique_id: ${uniqueId}`);
    lines.push(`date: ${header.date || ""}`);
    lines.push(`from: ${header.author || ""}`);
    lines.push(`to: ${header.recipients ? header.recipients.join(", ") : ""}`);
    lines.push(`cc: ${header.ccList ? header.ccList.join(", ") : ""}`);
    lines.push(`subject: ${(await getRealSubject(header)) || "(No subject)"}`);
    lines.push(`has_attachments: ${hasAttachments === null ? "unknown" : hasAttachments ? "yes" : "no"}`);
    lines.push(`replied: ${repliedStatus ? "yes" : "no"}`);
    lines.push("body:");
    lines.push(body);

    if (attachments && attachments.length > 0) {
      lines.push("");
      lines.push("attachments:");
      for (const att of attachments) {
        lines.push(`  - ${att.name || "(unnamed)"} (${att.contentType}, ${att.size} bytes)`);
      }
    }

    // Append ICS attachment summaries
    if (parsedIcs) {
      lines.push(parsedIcs);
      log(`[TMDBG Tools] email_read: Appended parsed ICS attachments (length: ${parsedIcs.length})`);
    }

    log(`[TMDBG Tools] email_read: returning content for id=${internalId}`);
    return lines.join("\n");
  } catch (e) {
    log(`[TMDBG Tools] email_read failed: ${e}`, "error");
    return { error: String(e || "unknown error in email_read") };
  }
}



