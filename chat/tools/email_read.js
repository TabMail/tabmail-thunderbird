// email_read.js – returns a full email content with summaries

import { extractBodyFromParts, getUniqueMessageKey, headerIDToWeID, log, parseUniqueId, safeGetFull } from "../../agent/modules/utils.js";
import { extractIcsFromParts, formatIcsAttachmentsAsString } from "../modules/icsParser.js";



export async function run(args = {}, options = {}) {
  try {
    const uniqueId = args?.unique_id;
    
    log(`[TMDBG Tools] email_read: Starting with unique_id='${uniqueId}' (type: ${typeof uniqueId})`);
    
    if (!uniqueId || typeof uniqueId !== 'string') {
      log(`[TMDBG Tools] email_read: invalid or missing unique_id: ${uniqueId}`, "error");
      return { error: "invalid or missing unique_id" };
    }

    // Parse unique_id to extract folderUri and headerID
    const parsed = parseUniqueId(uniqueId);
    if (!parsed) {
      log(`[TMDBG Tools] email_read: failed to parse unique_id: ${uniqueId}`, "error");
      log(`[TMDBG Tools] email_read: unique_id should be in format 'accountId:folderPath:headerID', got: '${uniqueId}'`, "error");
      // Note the error message below is sent to the LLM, so we should not
      // reveal the format here (it relies on a translator)
      return { error: "Invalid unique_id" };
    }
    
    const { weFolder, headerID } = parsed;
    log(`[TMDBG Tools] email_read: uniqueId='${uniqueId}' -> weFolder='${weFolder}' headerID='${headerID}'`);

    // Direct fetch using headerIDToWeID + safeGetFull (faster than FTS database query)
    // FTS was designed for full-text search, not for single message lookups by ID
    let internalId = null;
    let header = null;
    let body = "";
    let icsAttachments = [];

    log(`[TMDBG Tools] email_read: Using direct fetch (headerIDToWeID + safeGetFull) for faster response`);
    log(`[TMDBG Tools] email_read: Calling headerIDToWeID with headerID='${headerID}' weFolder='${weFolder}'`);
    
    internalId = await headerIDToWeID(headerID, weFolder);
    if (!internalId) {
      log(`[TMDBG Tools] email_read: headerIDToWeID failed to resolve headerID='${headerID}' in weFolder='${weFolder}'`, "error");
      log(`[TMDBG Tools] email_read: This could mean the email was moved/deleted, or the headerID format is incorrect`, "error");
      return { error: `message not found for headerID '${headerID}' in folder '${weFolder.path}'` };
    }
    
    // Get header for complete information
    header = await browser.messages.get(internalId);
    if (!header) {
      log(`[TMDBG Tools] email_read: messages.get(${internalId}) returned null after resolution`, "error");
      return { error: "message not found after resolution" };
    }
    log(`[TMDBG Tools] email_read: Successfully resolved via headerIDToWeID: headerID='${headerID}' -> weID=${internalId}`);
    
    // Get body using safeGetFull
    try {
      const full = await safeGetFull(internalId);
      body = await extractBodyFromParts(full, internalId) || "";
      log(`[TMDBG Tools] email_read: Body extracted from safeGetFull (length: ${body.length})`);
      
      // Extract ICS attachments while we have the full message
      try {
        icsAttachments = await extractIcsFromParts(full, internalId);
        log(`[TMDBG Tools] email_read: ICS scan complete from full message. found=${icsAttachments.length}`);
      } catch (e) {
        log(`[TMDBG Tools] email_read: ICS scan failed: ${e}`, "warn");
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

    // Get attachment info from header
    const hasAttachmentsFlag = Boolean(header.hasAttachments);
    log(`[TMDBG Tools] email_read: Using attachment info from header: hasAttachments=${hasAttachmentsFlag}`);

    // Check replied status using tmHdr experiment
    let repliedStatus = false;
    try {
      const folderURI = header.folder?.id || "";
      const pathStr = header.folder?.path || "";
      let nativeMsgKey = -1;
      try {
        const weId = internalId;
        const mk = await browser.tmHdr.getMsgKey(folderURI, weId, pathStr);
        if (typeof mk === "number" && mk >= 0) nativeMsgKey = mk;
      } catch (e) {
        log(`[TMDBG Tools] email_read: getMsgKey failed for ${internalId}: ${e}`, "warn");
      }
      repliedStatus = await browser.tmHdr.getReplied(folderURI, nativeMsgKey, pathStr, header.headerMessageId || "");
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
    lines.push(`subject: ${header.subject || "(No subject)"}`);
    lines.push(`has_attachments: ${hasAttachmentsFlag ? "yes" : "no"}`);
    lines.push(`replied: ${repliedStatus ? "yes" : "no"}`);
    lines.push("body:");
    lines.push(body);

    // Append ICS attachment summaries
    if (icsAttachments && icsAttachments.length > 0) {
      const parsedIcsData = formatIcsAttachmentsAsString(icsAttachments);
      if (parsedIcsData) {
        lines.push(parsedIcsData);
        log(`[TMDBG Tools] email_read: Parsed ICS attachments (${icsAttachments.length} attachments)`);
      }
    }

    log(`[TMDBG Tools] email_read: returning content for id=${internalId}`);
    return lines.join("\n");
  } catch (e) {
    log(`[TMDBG Tools] email_read failed: ${e}`, "error");
    return { error: String(e || "unknown error in email_read") };
  }
}




