// email_move_to_inbox.js – instant tool to move emails to inbox

import { getInboxForAccount } from "../../agent/modules/inboxContext.js";
import { log } from "../../agent/modules/utils.js";

async function normalizeArgs(args = {}) {
  const a = args || {};
  const out = { internalIds: [] };

  // Required list of unique_ids to move to inbox
  if (Array.isArray(a.unique_ids) && a.unique_ids.length > 0) {
    try {
      const { parseUniqueId, headerIDToWeID } = await import("../../agent/modules/utils.js");
      const resolvedIds = [];
      
      for (const uniqueId of a.unique_ids) {
        if (uniqueId && typeof uniqueId === 'string') {
          log(`[TMDBG Tools] email_move_to_inbox: Processing unique_id: '${uniqueId}'`);
          const parsed = parseUniqueId(uniqueId);
          const { weFolder, headerID } = parsed;
          log(`[TMDBG Tools] email_move_to_inbox: Parsed to weFolder='${weFolder}' headerID='${headerID}'`);
          
          // Resolve headerID to internal weID
          const internalIds = await headerIDToWeID(headerID, weFolder);
          log(`[TMDBG Tools] email_move_to_inbox: headerIDToWeID returned: ${JSON.stringify(internalIds)}`);
          if (internalIds) {
            resolvedIds.push(internalIds);
            log(`[TMDBG Tools] email_move_to_inbox: Resolved unique_id '${uniqueId}' to ${internalIds} internal ID`);
          } else {
            log(`[TMDBG Tools] email_move_to_inbox: Failed to resolve unique_id '${uniqueId}'`, "warn");
          }
        } else {
          log(`[TMDBG Tools] email_move_to_inbox: Invalid unique_id: ${JSON.stringify(uniqueId)}`, "warn");
        }
      }
      
      if (resolvedIds.length > 0) {
        out.internalIds = resolvedIds;
        log(`[TMDBG Tools] email_move_to_inbox: Resolved ${a.unique_ids.length} unique_ids to ${resolvedIds.length} total internal IDs`);
      }
    } catch (e) {
      log(`[TMDBG Tools] email_move_to_inbox: Error resolving unique_ids: ${e}`, "error");
    }
  }

  return out;
}

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] email_move_to_inbox: Tool called with args: ${JSON.stringify(args)}`);

    // Normalize and resolve internal IDs
    const norm = await normalizeArgs(args);
    
    if (!Array.isArray(norm.internalIds) || norm.internalIds.length === 0) {
      log(`[TMDBG Tools] email_move_to_inbox: No valid unique_ids provided`, "error");
      return { error: "No valid unique_ids provided" };
    }

    log(`[TMDBG Tools] email_move_to_inbox: Processing ${norm.internalIds.length} messages`);

    // Move each message to its account's inbox
    let movedCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const internalId of norm.internalIds) {
      try {
        // Get the message header
        const header = await browser.messages.get(internalId);
        if (!header) {
          log(`[TMDBG Tools] email_move_to_inbox: Could not find message with id ${internalId}`, "warn");
          errorCount++;
          errors.push(`Message ${internalId} not found`);
          continue;
        }

        // Check if already in inbox
        const currentFolder = header.folder;
        if (!currentFolder || !currentFolder.accountId) {
          log(`[TMDBG Tools] email_move_to_inbox: Message ${internalId} has no folder or accountId`, "warn");
          errorCount++;
          errors.push(`Message ${internalId} has no folder`);
          continue;
        }

        // Check if already in inbox
        if (currentFolder.type === 'inbox' || currentFolder.path === '/INBOX') {
          log(`[TMDBG Tools] email_move_to_inbox: Message ${internalId} is already in inbox, skipping`);
          movedCount++; // Count as success since it's already where we want it
          continue;
        }

        // Get the inbox folder for this account
        const inboxFolder = await getInboxForAccount(currentFolder.accountId);
        if (!inboxFolder) {
          log(`[TMDBG Tools] email_move_to_inbox: Could not find inbox for account ${currentFolder.accountId}`, "error");
          errorCount++;
          errors.push(`No inbox found for account ${currentFolder.accountId}`);
          continue;
        }

        log(`[TMDBG Tools] email_move_to_inbox: Moving message ${internalId} from '${currentFolder.path}' to inbox '${inboxFolder.path}'`);

        // Move the message to inbox
        await browser.messages.move([internalId], inboxFolder.id, {
          isUserAction: true,
        });

        log(`[TMDBG Tools] email_move_to_inbox: Successfully moved message ${internalId} to inbox`);
        movedCount++;
      } catch (e) {
        log(`[TMDBG Tools] email_move_to_inbox: Error moving message ${internalId}: ${e}`, "error");
        errorCount++;
        errors.push(`Message ${internalId}: ${String(e)}`);
      }
    }

    // Return result summary
    log(`[TMDBG Tools] email_move_to_inbox: Completed - moved ${movedCount}, errors ${errorCount}`);
    
    if (errorCount === 0) {
      if (movedCount === 1) {
        return `Moved 1 email to inbox.`;
      } else {
        return `Moved ${movedCount} emails to inbox.`;
      }
    } else if (movedCount > 0) {
      return `Moved ${movedCount} email(s) to inbox with ${errorCount} error(s): ${errors.join('; ')}`;
    } else {
      return { error: `Failed to move emails: ${errors.join('; ')}` };
    }
  } catch (e) {
    log(`[TMDBG Tools] email_move_to_inbox failed: ${e}`, "error");
    return { error: String(e || "unknown error in email_move_to_inbox") };
  }
}

export function resetPaginationSessions() {}

