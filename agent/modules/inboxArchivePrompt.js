// inboxArchivePrompt.js – One-time prompt to archive old inbox emails
// Shows on first run when inbox has too many emails

import { SETTINGS } from "./config.js";
import { getTotalInboxCount } from "./inboxContext.js";
import { log } from "./utils.js";

const STORAGE_KEY = "inboxArchivePromptDone";

/**
 * Check if the archive prompt should be shown
 * @returns {Promise<boolean>} True if prompt should be shown
 */
export async function shouldShowArchivePrompt() {
  try {
    // Check if already shown
    const stored = await browser.storage.local.get({ [STORAGE_KEY]: false });
    if (stored[STORAGE_KEY]) {
      log("[ArchivePrompt] Already shown before, skipping");
      return false;
    }

    // Get total inbox count
    const totalCount = await getTotalInboxCount();
    const maxEmails = SETTINGS.inboxManagement?.maxRecentEmails || 100;

    if (totalCount <= maxEmails) {
      log(`[ArchivePrompt] Inbox has ${totalCount} emails (≤${maxEmails}), no prompt needed`);
      // Mark as done since inbox is already optimal
      await browser.storage.local.set({ [STORAGE_KEY]: true });
      return false;
    }

    log(`[ArchivePrompt] Inbox has ${totalCount} emails (>${maxEmails}), should show prompt`);
    return true;
  } catch (e) {
    log(`[ArchivePrompt] Error checking if prompt should show: ${e}`, "error");
    return false;
  }
}

/**
 * Show the archive prompt popup window
 * @returns {Promise<void>}
 */
export async function showArchivePrompt() {
  try {
    const archiveAgeDays = SETTINGS.inboxManagement?.archiveAgeDays || 14;
    const url = browser.runtime.getURL(
      `agent/inbox-archive-prompt.html?days=${archiveAgeDays}`
    );

    await browser.windows.create({
      url,
      type: "popup",
      width: 580,
      height: 580
    });

    log("[ArchivePrompt] Popup window opened");
  } catch (e) {
    log(`[ArchivePrompt] Failed to show popup: ${e}`, "error");
  }
}

/**
 * Check and show archive prompt if needed
 * Called during startup after inbox scan completes
 * @returns {Promise<void>}
 */
export async function checkAndShowArchivePrompt() {
  try {
    const shouldShow = await shouldShowArchivePrompt();
    if (shouldShow) {
      await showArchivePrompt();
    }
  } catch (e) {
    log(`[ArchivePrompt] Error in checkAndShowArchivePrompt: ${e}`, "error");
  }
}

/**
 * Reset the archive prompt flag (for testing)
 * @returns {Promise<void>}
 */
export async function resetArchivePrompt() {
  try {
    await browser.storage.local.remove(STORAGE_KEY);
    log("[ArchivePrompt] Prompt flag reset");
  } catch (e) {
    log(`[ArchivePrompt] Failed to reset prompt flag: ${e}`, "error");
  }
}

/**
 * Set default sort option based on inbox size
 * If inbox is large (> maxRecentEmails), set default to date sort (0) instead of tag sort (1)
 * Only sets if user hasn't explicitly set the preference
 * @returns {Promise<void>}
 */
export async function setDefaultSortForLargeInbox() {
  try {
    if (!browser.tmPrefs) {
      log("[DefaultSort] tmPrefs not available, skipping default sort check");
      return;
    }

    const prefName = SETTINGS.appearance?.prefs?.tagSortEnabled || "extensions.tabmail.tagSortEnabled";
    
    // Check if user has explicitly set this preference
    const hasUserValue = await browser.tmPrefs.hasUserValue(prefName);
    if (hasUserValue) {
      log(`[DefaultSort] User has already set tagSortEnabled preference, skipping default adjustment`);
      return;
    }

    // Get total inbox count
    const totalCount = await getTotalInboxCount();
    const maxEmails = SETTINGS.inboxManagement?.maxRecentEmails || 100;

    if (totalCount > maxEmails) {
      // Large inbox: set default to date sort (0)
      await browser.tmPrefs.setInt(prefName, 0);
      log(`[DefaultSort] Large inbox detected (${totalCount} emails > ${maxEmails}), set default sort to date (0)`);
    } else {
      // Small inbox: use default tag sort (1) - no need to set explicitly as it's already the default
      log(`[DefaultSort] Small inbox (${totalCount} emails ≤ ${maxEmails}), keeping default sort to tags (1)`);
    }
  } catch (e) {
    log(`[DefaultSort] Error setting default sort based on inbox size: ${e}`, "error");
  }
}
