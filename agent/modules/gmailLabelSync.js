/**
 * gmailLabelSync.js — Gmail folder-based label sync.
 * Gmail IMAP maps folders ↔ labels. Copying a message to a tm_* folder adds
 * that label in Gmail, which iOS reads via the Gmail REST API.
 */

import { getAllFoldersForAccount } from "./folderUtils.js";
import { ACTION_TAG_IDS } from "./tagDefs.js";
import { headerIDToWeID } from "./utils.js";

const _gmailAccountCache = new Map(); // accountId -> boolean
const _gmailTagFolderCache = new Map(); // accountId -> { tm_reply: { id, path }, ... }

async function _isGmailAccount(accountId) {
  if (_gmailAccountCache.has(accountId)) return _gmailAccountCache.get(accountId);
  try {
    const folders = await getAllFoldersForAccount(accountId);
    const isGmail = folders.some(f => (f.path || "").includes("[Gmail]"));
    _gmailAccountCache.set(accountId, isGmail);
    return isGmail;
  } catch (e) {
    console.log(`[GMailTag] _isGmailAccount ERROR: ${e}`);
    return false;
  }
}

async function _ensureGmailTagFolders(accountId) {
  if (_gmailTagFolderCache.has(accountId)) return _gmailTagFolderCache.get(accountId);
  try {
    const account = await browser.accounts.get(accountId);
    if (!account?.rootFolder?.id) return null;

    const folders = await getAllFoldersForAccount(accountId);
    const tagFolderMap = {};

    for (const tagId of Object.values(ACTION_TAG_IDS)) {
      const existing = folders.find(f => f.name === tagId);
      if (existing) {
        tagFolderMap[tagId] = { id: existing.id, path: existing.path };
      } else {
        try {
          const created = await browser.folders.create(account.rootFolder.id, tagId);
          tagFolderMap[tagId] = { id: created.id, path: created.path || `/${tagId}` };
          console.log(`[GMailTag] Created folder: ${tagId} id=${created.id} path=${created.path}`);
        } catch (eCreate) {
          console.log(`[GMailTag] FAILED to create folder ${tagId}: ${eCreate}`);
        }
      }
    }

    _gmailTagFolderCache.set(accountId, tagFolderMap);
    return tagFolderMap;
  } catch (e) {
    console.log(`[GMailTag] _ensureGmailTagFolders ERROR: ${e}`);
    return null;
  }
}

/**
 * Sync a tag change as a Gmail folder copy (fire-and-forget).
 * - Removes message copies from all tm_* folders
 * - If targetTagId is set, copies the message to that tm_* folder
 * On Gmail IMAP, folder = label, so this adds/removes Gmail labels.
 *
 * @param {number} msgId - WebExtension message ID
 * @param {string} accountId - Account ID
 * @param {string|null} targetTagId - e.g. "tm_reply", or null to clear all
 */
export async function syncGmailTagFolder(msgId, accountId, targetTagId) {
  try {
    if (!await _isGmailAccount(accountId)) return;

    const tagFolders = await _ensureGmailTagFolders(accountId);
    if (!tagFolders || Object.keys(tagFolders).length === 0) return;

    const header = await browser.messages.get(msgId);
    const headerMsgId = (header?.headerMessageId || "").replace(/[<>]/g, "");
    if (!headerMsgId) return;

    // Remove from all tm_* folders (clears old Gmail labels)
    for (const [tagId, folder] of Object.entries(tagFolders)) {
      try {
        const weFolder = { accountId, path: folder.path };
        const copyIds = await headerIDToWeID(headerMsgId, weFolder, true, false);
        if (copyIds && copyIds.length > 0) {
          await browser.messages.delete(copyIds, true);
          console.log(`[GMailTag] Removed ${copyIds.length} copy(ies) from folder ${tagId}`);
        }
      } catch (eDel) {
        console.log(`[GMailTag] FAILED to remove from folder ${tagId}: ${eDel}`);
      }
    }

    // Copy to new folder if tagging (not untagging)
    if (targetTagId && tagFolders[targetTagId]) {
      await browser.messages.copy([msgId], tagFolders[targetTagId].id);
      console.log(`[GMailTag] Copied msgId=${msgId} -> ${targetTagId}`);
    } else if (targetTagId) {
      console.log(`[GMailTag] targetTagId=${targetTagId} not found in tagFolders, skipping`);
    }
  } catch (e) {
    console.log(`[GMailTag] syncGmailTagFolder FAILED: ${e}`);
  }
}
