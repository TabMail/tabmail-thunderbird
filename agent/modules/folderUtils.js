/**
 * Folder utilities shared across modules.
 *
 * NOTE: This is split out of inboxContext.js to avoid circular dependencies.
 * (e.g., tagHelper -> folderUtils and inboxContext -> tagHelper).
 */

/**
 * Helper to check if a folder is an inbox (regular or unified).
 * Checks multiple properties to handle various IMAP/folder configurations.
 *
 * TB 145 / MV3: folder objects may vary across account types and unified folders.
 *
 * @param {Object} folder - WebExtension folder object
 * @returns {boolean}
 */
export function isInboxFolder(folder) {
  if (!folder) {
    return false;
  }

  // Check folder.type (primary WebExtension property)
  if (folder.type === "inbox") {
    return true;
  }

  // Check folder.path for IMAP standard
  if (folder.path === "/INBOX") {
    return true;
  }

  // Check specialUse array (some folder configurations use this)
  if (Array.isArray(folder.specialUse)) {
    const specialUse = folder.specialUse.map((s) => String(s).toLowerCase());
    if (specialUse.includes("inbox")) {
      return true;
    }
  }

  // Check folder name/path for unified inbox
  const name = (folder.name || folder.path || "").toLowerCase();
  if (name === "inbox" || (name.includes("unified") && name.includes("inbox"))) {
    return true;
  }

  return false;
}

/**
 * Get ALL folders for an account using manual traversal.
 * 
 * NOTE: browser.folders.getSubFolders(id, true) (recursive=true) doesn't always
 * work for IMAP folders that haven't been fully synced (e.g., Gmail's [Gmail] children).
 * This function manually traverses the folder tree to ensure ALL subfolders are found.
 * 
 * Pattern copied from fts/indexer.js.
 * 
 * @param {string} accountId - The account ID to get folders for.
 * @returns {Promise<browser.folders.MailFolder[]>} - All folders in the account.
 */
export async function getAllFoldersForAccount(accountId) {
  const allFolders = [];
  const visited = new Set();

  async function traverseFolder(folder) {
    if (!folder || !folder.id) return;
    if (visited.has(folder.id)) return;
    visited.add(folder.id);

    allFolders.push(folder);

    try {
      // Get immediate children of this folder (recursive=false to manually traverse)
      const children = await browser.folders.getSubFolders(folder.id, false);
      if (children && children.length > 0) {
        for (const child of children) {
          await traverseFolder(child);
        }
      }
    } catch (_) {
      // Ignore errors for individual folder traversal
    }
  }

  try {
    const accounts = await browser.accounts.list();
    const account = accounts.find((a) => a?.id === accountId);
    if (!account?.rootFolder) {
      return [];
    }
    await traverseFolder(account.rootFolder);
  } catch (_) {
    // Ignore top-level errors
  }

  return allFolders;
}
