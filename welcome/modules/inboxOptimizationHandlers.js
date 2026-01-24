/**
 * Inbox Optimization Handlers for Welcome Wizard
 * Allows archiving old emails during onboarding
 */

import { isInboxFolder } from "../../agent/modules/folderUtils.js";
import { getArchiveFolderForHeader } from "../../agent/modules/utils.js";

let allMessages = []; // Array of {id, date} for all inbox messages
let oldMessages = []; // Array of message IDs older than threshold
let totalCount = 0;
let isCollecting = false;

/**
 * Get current threshold in days from the selector
 */
function getThresholdDays() {
  const weeksSelect = document.getElementById("inbox-weeks-select");
  const weeks = parseInt(weeksSelect?.value || "2", 10);
  return weeks * 7;
}

/**
 * Recalculate old messages based on current threshold
 */
function recalculateOldMessages() {
  const thresholdDays = getThresholdDays();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - thresholdDays);

  oldMessages = allMessages
    .filter((msg) => msg.date && new Date(msg.date) < cutoffDate)
    .map((msg) => msg.id);

  // Update UI
  const oldCountEl = document.getElementById("inbox-old-count");
  const btnArchive = document.getElementById("inbox-archive-btn");

  if (oldCountEl) {
    oldCountEl.textContent = oldMessages.length.toLocaleString();
  }

  if (btnArchive) {
    if (oldMessages.length > 0) {
      btnArchive.textContent = "Archive Old Emails";
      btnArchive.disabled = false;
    } else {
      btnArchive.textContent = "No Old Emails";
      btnArchive.disabled = true;
    }
  }
}

/**
 * Collect stats on inbox (fetches all messages once)
 */
async function collectStats() {
  if (isCollecting) return;
  isCollecting = true;

  const totalCountEl = document.getElementById("inbox-total-count");
  const oldCountEl = document.getElementById("inbox-old-count");

  // Reset state
  allMessages = [];
  oldMessages = [];
  totalCount = 0;

  try {
    const accounts = await browser.accounts.list();

    for (const acc of accounts) {
      if (!acc.rootFolder) continue;

      // Find inbox folder
      const subFolders = await browser.folders.getSubFolders(acc.rootFolder.id, true);
      const allFolders = [acc.rootFolder, ...subFolders];
      const inbox = allFolders.find((f) => isInboxFolder(f));

      if (!inbox) continue;

      // Paginate through all messages
      let page = await browser.messages.list(inbox.id);
      while (page && page.messages && page.messages.length > 0) {
        for (const msg of page.messages) {
          totalCount++;
          // Store id and date for later filtering
          allMessages.push({ id: msg.id, date: msg.date });
        }

        if (page.id) {
          page = await browser.messages.continueList(page.id);
        } else {
          break;
        }
      }
    }

    // Update total count
    if (totalCountEl) {
      totalCountEl.textContent = totalCount.toLocaleString();
    }

    // Calculate old messages based on current threshold
    recalculateOldMessages();
  } catch (e) {
    console.error("[InboxOptimization] Error collecting stats:", e);
    if (totalCountEl) totalCountEl.textContent = "Error";
    if (oldCountEl) oldCountEl.textContent = "Error";
  } finally {
    isCollecting = false;
  }
}

/**
 * Archive old emails
 */
async function archiveOldEmails() {
  const btnArchive = document.getElementById("inbox-archive-btn");
  const btnSkip = document.getElementById("inbox-skip-btn");
  const progressContainer = document.getElementById("inbox-progress-container");
  const progressBar = document.getElementById("inbox-progress-bar");
  const progressText = document.getElementById("inbox-progress-text");
  const statusBox = document.getElementById("inbox-optimization-status");

  // Hide buttons, show progress
  if (btnArchive) btnArchive.style.display = "none";
  if (btnSkip) btnSkip.style.display = "none";
  if (progressContainer) progressContainer.style.display = "block";

  const archiveCache = new Map(); // accountId -> archiveFolder
  let archived = 0;
  let failed = 0;

  for (let i = 0; i < oldMessages.length; i++) {
    const msgId = oldMessages[i];

    try {
      // Get the full message header
      const header = await browser.messages.get(msgId);
      if (!header) {
        console.warn("[InboxOptimization] No header for msgId:", msgId);
        failed++;
        continue;
      }

      const acctId = header.folder?.accountId;

      // Use cached archive folder or find it
      let archiveFolder = archiveCache.get(acctId);
      if (archiveFolder === undefined) {
        archiveFolder = await getArchiveFolderForHeader(header);
        archiveCache.set(acctId, archiveFolder || null);
      }

      if (archiveFolder) {
        // Move to archive
        await browser.messages.move([msgId], archiveFolder.id, {
          isUserAction: true,
        });
        archived++;
      } else {
        failed++;
        console.warn("[InboxOptimization] No archive folder for account:", acctId);
      }
    } catch (e) {
      failed++;
      console.error("[InboxOptimization] Error archiving message:", msgId, e);
    }

    // Update progress
    const progress = Math.round(((i + 1) / oldMessages.length) * 100);
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (progressText) progressText.textContent = `Archived ${archived} of ${oldMessages.length} emails...`;
  }

  // Complete
  if (progressText) {
    progressText.textContent = `Done! Archived ${archived} emails.` + (failed > 0 ? ` (${failed} failed)` : "");
  }

  // Show success status
  if (statusBox) {
    statusBox.style.display = "flex";
    statusBox.className = "status-box success";
    statusBox.innerHTML = `<span>✓</span><span>Archived ${archived} emails successfully.</span>`;
  }
}

/**
 * Setup inbox optimization handlers
 */
export function setupInboxOptimizationHandlers() {
  const weeksSelect = document.getElementById("inbox-weeks-select");
  const btnArchive = document.getElementById("inbox-archive-btn");
  const btnSkip = document.getElementById("inbox-skip-btn");

  // Handle weeks selector change
  if (weeksSelect) {
    weeksSelect.addEventListener("change", () => {
      recalculateOldMessages();
    });
  }

  // Handle archive button
  if (btnArchive) {
    btnArchive.addEventListener("click", async (e) => {
      e.stopPropagation();
      await archiveOldEmails();
    });
  }

  // Handle skip button (just hide the buttons, user can proceed with Next)
  if (btnSkip) {
    btnSkip.addEventListener("click", (e) => {
      e.stopPropagation();
      const statusBox = document.getElementById("inbox-optimization-status");
      if (statusBox) {
        statusBox.style.display = "flex";
        statusBox.className = "status-box";
        statusBox.innerHTML = "<span>ℹ️</span><span>Skipped. You can always archive later from Settings → Reminders.</span>";
      }
      // Hide buttons
      if (btnArchive) btnArchive.style.display = "none";
      if (btnSkip) btnSkip.style.display = "none";
    });
  }

  // Start collecting stats
  collectStats();
}

export default {
  setupInboxOptimizationHandlers,
};
