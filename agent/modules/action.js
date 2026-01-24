// Main helper for message-level actions triggered by tags.
import { trackComposeWindow } from "./composeTracker.js";
import { ACTION_TAG_IDS } from "./tagHelper.js";
import {
  getArchiveFolderForHeader,
  getIdentityForMessage,
  getTrashFolderForHeader,
  getUniqueMessageKey,
  log
} from "./utils.js";

/**
 * Perform the appropriate action for a single message based on its action tag.
 * Returns a string describing the outcome (e.g. "deleted", "archived", "no_action", "error").
 *
 * @param {object} msg - A minimal message object (must contain an `id` field).
 * @param {object} [header] - Optional full message header. If omitted, it will be fetched internally.
 */
export async function performTaggedAction(msg, header = null) {
  try {
    // Ensure we have the full header when folder info is required.
    const hdr = header || (await browser.messages.get(msg.id));
    const tags = hdr.tags || [];

    if (tags.includes(ACTION_TAG_IDS.delete)) {
      // Obtain the trash folder for the account of the message.
      try {
        const trashFolder = await getTrashFolderForHeader(hdr);
        if (trashFolder) {
          // Mark as read BEFORE moving to avoid invalidating the numeric id on post-move updates.
          try {
            await browser.messages.update(msg.id, { read: true });
            log(
              `[TMDBG MessageActions] Marked message ${msg.id} as read before delete action.`
            );
          } catch (eReadDelPre) {
            try {
              const key = hdr.headerMessageId
                ? hdr.headerMessageId.replace(/[<>]/g, "")
                : (await getUniqueMessageKey(msg.id)) || "";
              log(
                `[TMDBG MessageActions] Pre-delete read-update failed for id=${msg.id} key=${key}: ${eReadDelPre}`
              );
            } catch (_) {
              log(
                `[TMDBG MessageActions] Failed to mark message ${msg.id} as read before delete action: ${eReadDelPre}`
              );
            }
          }

          // Diagnostic: moving by numeric id; Thunderbird may assign a new id after move.
          try {
            log(
              `[TMDBG MessageActions] Moving message id=${msg.id} (key=${
                hdr.headerMessageId?.replace(/[<>]/g, "") || ""
              }) to Trash '${trashFolder.path}'`
            );
          } catch (_) {}
          await browser.messages.move([msg.id], trashFolder.id, {
            isUserAction: true,
          });

          // We already set read state pre-move; avoid post-move update on potentially stale id.
          try {
            log(
              `[TMDBG MessageActions] Skipped post-delete read-update (already set before move) for id=${msg.id}`
            );
          } catch (_) {}
          return "deleted";
        }
        // log(`[TMDBG MessageActions] Could not find trash folder for message ${msg.id}; falling back to archive.`);
      } catch (eTrash) {
        // log(`[TMDBG MessageActions] Error locating trash folder for message ${msg.id}: ${eTrash}`);
      }
      return "trash_not_found";
    }

    if (tags.includes(ACTION_TAG_IDS.archive)) {
      // log(`[TMDBG MessageActions] Archiving (via move) message ${msg.id} due to tm_archive tag.`);
      try {
        const archiveFolder = await getArchiveFolderForHeader(hdr);
        if (archiveFolder) {
          // Mark as read BEFORE moving to avoid invalidating the numeric id on post-move updates.
          try {
            await browser.messages.update(msg.id, { read: true });
            log(
              `[TMDBG MessageActions] Marked message ${msg.id} as read before archive action.`
            );
          } catch (eReadArchPre) {
            try {
              const key = hdr.headerMessageId
                ? hdr.headerMessageId.replace(/[<>]/g, "")
                : (await getUniqueMessageKey(msg.id)) || "";
              log(
                `[TMDBG MessageActions] Pre-archive read-update failed for id=${msg.id} key=${key}: ${eReadArchPre}`
              );
            } catch (_) {
              log(
                `[TMDBG MessageActions] Failed to mark message ${msg.id} as read before archive action: ${eReadArchPre}`
              );
            }
          }

          try {
            log(
              `[TMDBG MessageActions] Archiving message id=${msg.id} (key=${
                hdr.headerMessageId?.replace(/[<>]/g, "") || ""
              }) to '${archiveFolder.path}'`
            );
          } catch (_) {}
          await browser.messages.move([msg.id], archiveFolder.id, {
            isUserAction: true,
          });

          // We already set read state pre-move; avoid post-move update on potentially stale id.
          try {
            log(
              `[TMDBG MessageActions] Skipped post-archive read-update (already set before move) for id=${msg.id}`
            );
          } catch (_) {}
          return "archived";
        }
        // log(`[TMDBG MessageActions] No archive folder found for account ${hdr.folder.accountId}.`);
        return "archive_folder_missing";
      } catch (eArch) {
        // log(`[TMDBG MessageActions] Move to archive failed for message ${msg.id}: ${eArch}.`);
        return "archive_failed";
      }
    }

    if (tags.includes(ACTION_TAG_IDS.reply)) {
      // Open a reply compose window for the message
      // Tag clearing is handled by composeTracker when the message is actually sent
      try {
        log(`[TMDBG MessageActions] Opening reply compose for message ${msg.id} due to tm_reply tag.`);
        
        const replyType = "replyToAll";

        // Resolve the correct identity for this reply based on the message's account
        const identityInfo = await getIdentityForMessage(msg);
        const replyDetails = identityInfo?.identityId ? { identityId: identityInfo.identityId } : {};
        const replyTab = await browser.compose.beginReply(msg.id, replyType, replyDetails);
        const tabId = typeof replyTab === "object" && replyTab !== null && "id" in replyTab
          ? replyTab.id
          : replyTab;
        
        if (tabId) {
          trackComposeWindow(tabId);
          log(`[TMDBG MessageActions] Reply compose window opened with tab ${tabId} for message ${msg.id}.`);
        }
        
        return "reply_opened";
      } catch (eReply) {
        log(`[TMDBG MessageActions] Failed to open reply compose for message ${msg.id}: ${eReply}`, "error");
        return "reply_failed";
      }
    }

    // log(`[TMDBG MessageActions] Message ${msg.id} has no action tag; ignoring.`);
    return "no_action";
  } catch (e) {
    // log(`[TMDBG MessageActions] Error performing tagged action for message ${msg.id}: ${e}`);
    return "error";
  }
}

/**
 * Convenience wrapper that executes `performTaggedAction` for each provided message.
 * @param {Array<object>} messages - Array of message objects (with `id`).
 * @returns {Promise<Array<string>>} Resolved outcomes for each message.
 */
export async function performTaggedActions(messages) {
  const ops = messages.map((m) => performTaggedAction(m));
  return Promise.all(ops);
}
