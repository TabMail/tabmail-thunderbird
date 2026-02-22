import { getAction, purgeExpiredActionEntries } from "./actionGenerator.js";
import { SETTINGS } from "./config.js";
import { isInboxFolder } from "./folderUtils.js";
import { purgeOlderThanByPrefixes } from "./idbStorage.js";
import { analyzeEmailForReplyFilter } from "./messagePrefilter.js";
import { purgeExpiredReplyEntries } from "./replyGenerator.js";
import { isInternalSender } from "./senderFilter.js";
import { getSummary, purgeExpiredSummaryEntries } from "./summaryGenerator.js";
import { ACTION_TAG_IDS, applyActionTags, applyPriorityTag, importActionFromImapTag } from "./tagHelper.js";
import { log } from "./utils.js";

/**
 * Unified pipeline for a single message:
 *   - Internal/self-sent: summary + tm_none tag (no action generation, no reply)
 *   - External: summary ⇒ action ⇒ reply
 *
 * This module is intentionally separate to avoid circular static imports.
 * It dynamically imports replyGenerator.js when it needs to trigger reply.
 *
 * @param {browser.messages.MessageHeader} messageHeader
 * @param {object} opts
 *   @property {boolean} [isPriority=false] – set true for user-driven flows (e.g. compose-reply) to bypass semaphore limits
 *   @property {boolean} [forceRecompute=false] – set true to bypass "first compute wins" IMAP tag check (e.g. debug recompute)
 */
export async function processMessage(
  messageHeader,
  { isPriority = false, forceRecompute = false } = {}
) {
  if (!messageHeader) {
    log("processMessage called without a valid messageHeader — skipping.");
    return {
      ok: false,
      summaryOk: false,
      actionOk: false,
      replyOk: false,
      replySkipped: false,
      reason: "no-messageHeader",
    };
  }

  try {
    log(`[ProcessMessage] Starting processing for message ${messageHeader.id}: "${messageHeader.subject}"`);

    // 0. Check if this is an internal/self-sent message
    // Internal messages get summary + tm_none tag only (no action generation, no reply)
    const isInternal = await isInternalSender(messageHeader);
    if (isInternal) {
      log(`[ProcessMessage] Internal/self-sent message ${messageHeader.id}: applying tm_none (skip action/reply)`);
      
      // Get summary for internal messages (useful for search/context)
      const summaryObj = await getSummary(messageHeader, isPriority);
      const summaryOk = !!summaryObj;
      
      // Apply tm_none tag to mark as processed
      await applyPriorityTag(messageHeader.id, "none");
      
      log(`[ProcessMessage] Completed internal message ${messageHeader.id} - Summary: ${summaryOk}, Tag: tm_none`);
      return {
        ok: true,
        summaryOk,
        actionOk: true, // Considered "ok" since we intentionally skip action for internal
        replyOk: true,  // Considered "ok" since we intentionally skip reply for internal
        replySkipped: true,
        action: "none",
        isInternal: true,
      };
    }
    
    // 1. Pre-filter: Check if this email should skip cached reply generation
    // We do a quick check first without fetching full message (only checking author)
    // Full check will happen later if we need to generate summary/action
    const quickFilter = await analyzeEmailForReplyFilter(messageHeader);
    log(`[ProcessMessage] Quick filter for ${messageHeader.id}: isNoReply=${quickFilter.isNoReply}, skipCachedReply=${quickFilter.skipCachedReply}`);
    
    // 2. Summary (cached inside summary.js)
    // NOTE: We continue even if summary fails to ensure all cache timestamps get touched
    const summaryObj = await getSummary(messageHeader, isPriority);
    log(`[ProcessMessage] Summary result for ${messageHeader.id}: ${summaryObj ? 'SUCCESS' : 'FAILED/NULL'}`);
    
    // 2. Action suggestion + tag application
    // NOTE: We process actions even if summary failed to ensure cache timestamps are touched
    let action = null;
    let actionOk = false;
    try {
      log(`[ProcessMessage] >>> Calling getAction for message ${messageHeader.id}`);
      action = await getAction(messageHeader, { forceRecompute });
      log(`[ProcessMessage] <<< Action result for ${messageHeader.id}: ${action || 'FAILED/NULL'}`);
      actionOk = !!action;
      
      // Only apply tags if we have both a valid summary and action
      if (summaryObj && action) {
        // If action is `reply` but already replied, we set it to `none`
        // Use tmHdr experiment to read native nsIMsgDBHdr Replied flag (TB 142 MV3)
        try {
          const nativeArgs = { folderURI: messageHeader.folder?.id, key: messageHeader.id };
          try {
            const pathStr = messageHeader.folder?.path;
            let nativeMsgKey = -1;
            try {
              const weId = nativeArgs.key;
              const mk = await browser.tmHdr.getMsgKey(nativeArgs.folderURI, weId, pathStr);
              if (typeof mk === "number" && mk >= 0) nativeMsgKey = mk;
            } catch (e) {
              console.log(`[ReplyDetect] getMsgKey failed for ${messageHeader.id}: ${e}`);
            }
            const alreadyReplied = await browser.tmHdr.getReplied(nativeArgs.folderURI, nativeMsgKey, pathStr, messageHeader.headerMessageId || "");
            if (action === "reply" && alreadyReplied) {
              action = "none";
              await applyPriorityTag(messageHeader.id, "none");
              console.log(
                `[ReplyDetect] native replied=${alreadyReplied}, action set to "none" for message ${messageHeader.id} ('${messageHeader.subject}') because it was already replied (native)`
              );
            }
          } catch (rdErr) {
            console.log(`[ReplyDetect] Error checking native replied flag for ${messageHeader.id}: ${rdErr}`);
          }
        } catch (rdErr) {
          console.log(`[ReplyDetect] Error checking native replied flag for ${messageHeader.id}: ${rdErr}`);
        }
        // Now apply the action tag
        log(`[ProcessMessage] Calling applyActionTags for ${messageHeader.id} with action=${action} summaryId=${summaryObj.id}`);
        await applyActionTags([messageHeader], { [summaryObj.id]: action });
        log(`[ProcessMessage] applyActionTags completed for ${messageHeader.id}`);
      } else {
        log(`processMessage: skipping tag application for message ${messageHeader.id} - summaryObj=${!!summaryObj}, action=${action}`);
      }
    } catch (actErr) {
      log(
        `processMessage: action generation/tag application failed for message ${messageHeader.id}: ${actErr}`
      );
      actionOk = false;
    }

    // 3. Pre-cache reply (dynamic import to avoid static cycle)
    // NOTE: We skip reply caching for no-reply addresses
    let replySuccess = false;
    if (quickFilter.skipCachedReply) {
      log(`[ProcessMessage] Skipping cached reply for ${messageHeader.id} - isNoReply=${quickFilter.isNoReply}`);
      replySuccess = false; // Mark as not generated (intentionally skipped)
    } else {
      try {
        const { createReply } = await import("./replyGenerator.js");
        await createReply(messageHeader.id, isPriority);
        replySuccess = true;
        log(`[ProcessMessage] Reply result for ${messageHeader.id}: SUCCESS`);
      } catch (repErr) {
        log(
          `[ProcessMessage] Reply result for ${messageHeader.id}: FAILED - ${repErr}`
        );
        replySuccess = false;
      }
    }
    
    // Final summary log
    log(`[ProcessMessage] Completed processing for ${messageHeader.id} - Summary: ${!!summaryObj}, Action: ${action || 'null'}, Reply: ${replySuccess}, Filtered: ${quickFilter.skipCachedReply}`);

    const summaryOk = !!summaryObj;
    const replySkipped = !!quickFilter?.skipCachedReply;
    const replyOk = replySkipped ? true : !!replySuccess;
    const ok = summaryOk && actionOk && replyOk;

    if (!ok) {
      log(
        `[ProcessMessage] Processing incomplete for ${messageHeader.id} - will need retry. summaryOk=${summaryOk} actionOk=${actionOk} replyOk=${replyOk} replySkipped=${replySkipped}`,
        "warn"
      );
    }

    return {
      ok,
      summaryOk,
      actionOk,
      replyOk,
      replySkipped,
      action: action || null,
    };
  } catch (err) {
    log(
      `[ProcessMessage] Unexpected error for message ${messageHeader.id}: ${err}`,
      "error"
    );
    return {
      ok: false,
      summaryOk: false,
      actionOk: false,
      replyOk: false,
      replySkipped: false,
      reason: "unexpected-error",
      error: String(err),
    };
  }
}

/**
 * This scans a specific folder (likely an inbox) for recent messages that
 * are good candidates for caching a reply.
 * @param {browser.folders.MailFolder} folder - The folder to scan.
 */
export async function processCandidatesInFolder(folder) {
  try {
    log(`[FolderScan] Scanning folder '${folder.name}' (id=${folder.id}, type=${folder.type}, path=${folder.path}) for candidates...`);
    let page = await browser.messages.list(folder.id);
    let allMessageHeaders = [];
    const maxEmails = SETTINGS.inboxManagement?.maxRecentEmails || 100;

    // 1. Gather all message headers
    log(`[FolderScan] Initial page contains ${page.messages.length} messages`);
    while (page.messages.length > 0) {
      allMessageHeaders.push(...page.messages);
      log(`[FolderScan] Added ${page.messages.length} messages, total so far: ${allMessageHeaders.length}`);
      if (page.id) {
        page = await browser.messages.continueList(page.id);
        log(`[FolderScan] Continuing with next page, got ${page.messages.length} more messages`);
      } else {
        log(`[FolderScan] No more pages available`);
        break;
      }
    }

    log(`[FolderScan] Collected ${allMessageHeaders.length} total message headers from folder '${folder.name}'`);

    // 2. Limit to most recent maxEmails (sort by date descending, then slice)
    let candidates = allMessageHeaders;
    if (allMessageHeaders.length > maxEmails) {
      log(`[FolderScan] ${allMessageHeaders.length} candidates exceed limit (>${maxEmails}). Limiting to most recent ${maxEmails} emails.`);
      candidates = [...allMessageHeaders].sort((a, b) => {
        const dateA = a?.date ? new Date(a.date).getTime() : 0;
        const dateB = b?.date ? new Date(b.date).getTime() : 0;
        return dateB - dateA; // Most recent first
      }).slice(0, maxEmails);
      log(`[FolderScan] After limiting: ${candidates.length} candidates to consider`);
    }

    if (candidates.length === 0) {
      log(`[FolderScan] No candidates to process in folder '${folder.name}' - skipping processing`);
      return;
    }

    // 3. Filter out messages that already have TabMail tags (already processed)
    // This avoids redundant processing cycles
    const tabMailTagIds = new Set(Object.values(ACTION_TAG_IDS));
    const untaggedCandidates = candidates.filter((msg) => {
      const tags = Array.isArray(msg.tags) ? msg.tags : [];
      const hasTabMailTag = tags.some((t) => tabMailTagIds.has(t));
      return !hasTabMailTag;
    });
    
    const skippedCount = candidates.length - untaggedCandidates.length;
    if (skippedCount > 0) {
      log(`[FolderScan] Skipped ${skippedCount} already-tagged message(s) in folder '${folder.name}'`);
    }

    // 3b. Import IMAP tags into IDB cache for already-tagged messages.
    // Ensures thread aggregation works for messages tagged by other TM instances (e.g. iOS).
    if (skippedCount > 0) {
      const taggedCandidates = candidates.filter((msg) => {
        const tags = Array.isArray(msg.tags) ? msg.tags : [];
        return tags.some((t) => tabMailTagIds.has(t));
      });
      let importedCount = 0;
      for (const msg of taggedCandidates) {
        try {
          const imported = await importActionFromImapTag(msg);
          if (imported) importedCount++;
        } catch (e) {
          log(`[FolderScan] Failed to import IMAP tag for message ${msg.id}: ${e}`, "warn");
        }
      }
      if (importedCount > 0) {
        log(`[FolderScan] Imported ${importedCount} IMAP tag(s) into IDB cache for thread aggregation`);
      }
    }

    if (untaggedCandidates.length === 0) {
      log(`[FolderScan] All ${candidates.length} candidates already have TabMail tags - nothing to enqueue`);
      return;
    }

    // 4. Enqueue untagged candidates for processing
    // processMessage handles internal/external distinction internally
    log(`[FolderScan] Enqueueing ${untaggedCandidates.length} candidate(s) for processing...`);
    const { enqueueProcessMessage } = await import("./messageProcessorQueue.js");
    let enqueuedCount = 0;
    for (const message of untaggedCandidates) {
      try {
        await enqueueProcessMessage(message, { isPriority: false, source: "startupScan" });
        enqueuedCount++;
      } catch (e) {
        log(`[FolderScan] Failed to enqueue message ${message.id}: ${e}`, "error");
      }
    }
    log(`[FolderScan] Enqueued ${enqueuedCount}/${untaggedCandidates.length} candidate(s)`)

    log(`[FolderScan] Completed processing all candidates in folder '${folder.name}'`);
  } catch (e) {
    log(
      `[FolderScan] CRITICAL: Error processing candidates in folder ${folder.name}: ${e}`, "error"
    );
  }
}

export async function scanAllInboxes() {
  log("[PeriodicScan] ====== Starting periodic inbox scan ======");

  try {
    const accounts = await browser.accounts.list();
    log(`[PeriodicScan] Found ${accounts.length} accounts. Iterating...`);

    for (const account of accounts) {
      log(`[PeriodicScan] Checking account: ${account.name} (Type: ${account.type}, ID: ${account.id})`);

      if (!account.rootFolder) {
        log(`[PeriodicScan] Account ${account.name} has no root folder. Skipping.`, "warn");
        continue;
      }

      try {
        // Recursively get all sub-folders.
        const subFolders = await browser.folders.getSubFolders(
          account.rootFolder.id,
          true
        );
        log(`[PeriodicScan] Account ${account.name}: found ${subFolders.length} subfolders`);

        // The inbox could be the root folder itself or a subfolder.
        const allFolders = [account.rootFolder, ...subFolders];
        log(`[PeriodicScan] Account ${account.name}: total folders to check: ${allFolders.length}`);

        // For IMAP accounts, the primary inbox is reliably identified by its path.
        // For Local Folders, the 'inbox' type is correctly assigned.
        const inbox = allFolders.find(f => isInboxFolder(f));

        if (inbox) {
          log(`[PeriodicScan] Found inbox: '${inbox.name}' (id=${inbox.id}, type=${inbox.type}, path=${inbox.path}). Processing...`);
          await processCandidatesInFolder(inbox);
          log(`[PeriodicScan] Completed processing inbox '${inbox.name}' for account ${account.name}`);
        } else {
          // This case is unlikely for IMAP accounts but is kept for robustness.
          // We've decided to ignore Local Folders for now.
          log(
            `[PeriodicScan] No folder with type 'inbox' or path '/INBOX' found in account ${account.name}.`, "warn"
          );
          // Log all folder types for debugging
          allFolders.forEach(f => {
            log(`[PeriodicScan] Folder in ${account.name}: '${f.name}' (type=${f.type}, path=${f.path})`);
          });
        }
      } catch (e) {
        log(`[PeriodicScan] Error traversing folders for account ${account.name}: ${e}`, "error");
      }
    }
    
    // After processing, run purge to clean up any entries that
    // might have expired.
    log(`[PeriodicScan] Running cache cleanup...`);
    try {
      await purgeExpiredReplyEntries();
      await purgeExpiredActionEntries();
      await purgeExpiredSummaryEntries();

      // Also purge other IDB caches that do not have dedicated `*:ts:*` meta keys.
      // This is still "the old strategy": only run during periodic inbox scans.
      const ttlSeconds = Math.max(
        Number(SETTINGS.replyTTLSeconds || 0),
        Number(SETTINGS.actionTTLSeconds || 0),
        Number(SETTINGS.summaryTTLSeconds || 0)
      );
      const cutoff = Date.now() - ttlSeconds * 1000;
      const removed = await purgeOlderThanByPrefixes(
        [
          "activePrecompose:",
          "activeHistory:",
          "action:orig:",
          "action:userprompt:",
          "action:justification:",
          // Per-thread tag aggregates (Inbox-only). Stored as "threadTags:<threadKey>".
          "threadTags:",
        ],
        cutoff
      );
      if (removed > 0) {
        log(`[PeriodicScan] Purged ${removed} old non-meta IDB cache entries (prefix-based).`);
      }
      log(`[PeriodicScan] Cache cleanup completed`);
    } catch (e) {
      log(`[PeriodicScan] Error during post-scan purge: ${e}`, "error");
    }

    // Note: Message reminders are now cached per-message in summary
    // No need to regenerate reminders after inbox scan
    // Reminders are built on-demand when chat opens by combining:
    // - Message reminders from summary cache (updated when messages are processed)
    // - KB reminders (updated when KB changes)
    log(`[PeriodicScan] Reminder generation moved to on-demand (chat init)`);

    log("[PeriodicScan] ====== Finished periodic inbox scan ======");
  } catch (error) {
    log(`[PeriodicScan] Error during inbox scan: ${error}`, "error");
  }
}
