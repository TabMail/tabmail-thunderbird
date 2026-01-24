// inbox-archive-prompt.js – One-time prompt to archive old inbox emails
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";
import { isInboxFolder } from "./modules/folderUtils.js";
import { getArchiveFolderForHeader } from "./modules/utils.js";

// Inject palette CSS for proper theming
injectPaletteIntoDocument().catch(e => {
  console.error('[ArchivePrompt] Failed to inject palette:', e);
});

document.addEventListener('DOMContentLoaded', async () => {
  const totalCountEl = document.getElementById('total-count');
  const oldCountEl = document.getElementById('old-count');
  const btnArchive = document.getElementById('btn-archive');
  const btnSkip = document.getElementById('btn-skip');
  const buttonsEl = document.getElementById('buttons');
  const progressContainer = document.getElementById('progress-container');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  const weeksSelect = document.getElementById('weeks-select');

  // Get URL parameters for archive age threshold (in days)
  const urlParams = new URLSearchParams(window.location.search);
  const initialDays = parseInt(urlParams.get('days') || '14', 10);
  
  // Set initial weeks selection based on URL param
  const initialWeeks = Math.round(initialDays / 7);
  if (weeksSelect) {
    const matchingOption = weeksSelect.querySelector(`option[value="${initialWeeks}"]`);
    if (matchingOption) {
      weeksSelect.value = String(initialWeeks);
    }
  }
  
  let allMessages = []; // Array of {id, date} for all inbox messages
  let oldMessages = []; // Array of message IDs older than threshold
  let totalCount = 0;
  
  // Get current threshold in days from the selector
  function getThresholdDays() {
    const weeks = parseInt(weeksSelect?.value || '2', 10);
    return weeks * 7;
  }

  // Recalculate old messages based on current threshold
  function recalculateOldMessages() {
    const thresholdDays = getThresholdDays();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - thresholdDays);
    
    oldMessages = allMessages
      .filter(msg => msg.date && new Date(msg.date) < cutoffDate)
      .map(msg => msg.id);
    
    // Update UI
    oldCountEl.textContent = oldMessages.length.toLocaleString();
    
    if (oldMessages.length > 0) {
      btnArchive.textContent = 'Archive Old Emails';
      btnArchive.disabled = false;
    } else {
      btnArchive.textContent = 'No Old Emails';
      btnArchive.disabled = true;
    }
  }

  // Collect stats on inbox (fetches all messages once)
  async function collectStats() {
    try {
      const accounts = await browser.accounts.list();
      
      for (const acc of accounts) {
        if (!acc.rootFolder) continue;
        
        // Find inbox folder using the same helper as the rest of the codebase
        const subFolders = await browser.folders.getSubFolders(acc.rootFolder.id, true);
        const allFolders = [acc.rootFolder, ...subFolders];
        const inbox = allFolders.find(f => isInboxFolder(f));
        
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
      totalCountEl.textContent = totalCount.toLocaleString();
      
      // Calculate old messages based on current threshold
      recalculateOldMessages();
    } catch (e) {
      console.error('[ArchivePrompt] Error collecting stats:', e);
      totalCountEl.textContent = 'Error';
      oldCountEl.textContent = 'Error';
    }
  }
  
  // Handle weeks selector change
  if (weeksSelect) {
    weeksSelect.addEventListener('change', () => {
      recalculateOldMessages();
    });
  }

  // Archive old messages - mimics exactly what tab actions do
  async function archiveOldEmails() {
    buttonsEl.style.display = 'none';
    progressContainer.classList.add('visible');
    
    const archiveCache = new Map(); // accountId -> archiveFolder
    let archived = 0;
    let failed = 0;
    
    for (let i = 0; i < oldMessages.length; i++) {
      const msgId = oldMessages[i];
      
      try {
        // Get the full message header (same as emailArchive.js does)
        const header = await browser.messages.get(msgId);
        if (!header) {
          console.warn('[ArchivePrompt] No header for msgId:', msgId);
          failed++;
          continue;
        }
        
        const acctId = header.folder?.accountId;
        
        // Use cached archive folder or find it using the same utility as tab actions
        let archiveFolder = archiveCache.get(acctId);
        if (archiveFolder === undefined) {
          archiveFolder = await getArchiveFolderForHeader(header);
          archiveCache.set(acctId, archiveFolder || null);
        }
        
        if (archiveFolder) {
          // Move to archive - same as emailArchive.js
          await browser.messages.move([msgId], archiveFolder.id, {
            isUserAction: true
          });
          archived++;
        } else {
          failed++;
          console.warn('[ArchivePrompt] No archive folder for account:', acctId);
        }
      } catch (e) {
        failed++;
        console.error('[ArchivePrompt] Error archiving message:', msgId, e);
      }
      
      // Update progress
      const progress = Math.round(((i + 1) / oldMessages.length) * 100);
      progressBar.style.width = `${progress}%`;
      progressText.textContent = `Archived ${archived} of ${oldMessages.length} emails...`;
    }
    
    // Complete
    progressText.textContent = `Done! Archived ${archived} emails.` + 
      (failed > 0 ? ` (${failed} failed)` : '');
    
    // Mark as completed and close after delay
    await browser.storage.local.set({ inboxArchivePromptDone: true });
    
    setTimeout(() => {
      window.close();
    }, 2000);
  }

  // Event handlers
  btnArchive.addEventListener('click', async (e) => {
    e.stopPropagation();
    await archiveOldEmails();
  });

  btnSkip.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Mark as done even if skipped
    await browser.storage.local.set({ inboxArchivePromptDone: true });
    window.close();
  });

  // Start collecting stats
  await collectStats();
});
