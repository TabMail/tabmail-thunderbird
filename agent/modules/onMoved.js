import { clearActionByUniqueKey } from "./actionCache.js";
import { autoUpdateUserPromptOnMove } from "./autoUpdateUserPrompt.js";
import { SETTINGS } from "./config.js";
import { logMessageEvent, logMoveEvent } from "./eventLogger.js";
import { getAllFoldersForAccount, isInboxFolder } from "./folderUtils.js";
import { removeTmLabelsFromGmailMessage } from "./gmailLabelSync.js";
import * as idb from "./idbStorage.js";
import { getInboxForAccount } from "./inboxContext.js";
import { ACTION_TAG_IDS, recomputeThreadForInboxMessage } from "./tagHelper.js";
import {
    clearAlarm,
    ensureAlarm,
    getArchiveFolderForHeader,
    getTrashFolderForHeader,
    getUniqueMessageKey,
    indexHeader,
    log,
    removeHeaderIndexForDeletedMessage,
    updateHeaderIndexForMovedMessage
} from "./utils.js";

const STALE_TAG_SWEEP_ALARM_NAME = "agent-stale-tag-sweep";

/**
 * Sanitize stale TabMail action tags on a single message.
 * Called from FTS indexer during message scanning (integrated sanitization).
 * 
 * @param {object} msg - Message header object
 * @param {object} folder - Folder object the message is in
 * @param {object} options - Optional config
 * @param {string[]} options.inboxFolderIds - Inbox folder IDs to check against (if not provided, skips inbox check)
 * @param {string[]} options.specialUseAllowList - Special use values to process (default: ["trash", "all", "archives"])
 * @returns {Promise<{stripped: boolean, reason?: string}>}
 */
export async function sanitizeMessageTags(msg, folder, options = {}) {
  try {
    if (!msg?.id || !folder) {
      return { stripped: false, reason: "invalid-input" };
    }

    // Skip inbox folders
    if (isInboxFolder(folder)) {
      return { stripped: false, reason: "is-inbox" };
    }

    // Check if folder is in allowed specialUse list
    const allowListRaw = options.specialUseAllowList || ["trash", "all", "archives"];
    const allowList = allowListRaw.map((s) => String(s || "").toLowerCase().trim()).filter((s) => !!s);
    const folderSpecialUse = Array.isArray(folder.specialUse) ? folder.specialUse.map((x) => String(x).toLowerCase()) : [];
    const isAllowedFolder = allowList.length === 0 || folderSpecialUse.some((x) => allowList.includes(x));
    if (!isAllowedFolder) {
      return { stripped: false, reason: "folder-not-in-allowlist" };
    }

    // Check if message has TabMail action tags
    const actionTagIds = Object.values(ACTION_TAG_IDS);
    const tags = Array.isArray(msg.tags) ? msg.tags : [];
    if (!tags.some((t) => actionTagIds.includes(t))) {
      return { stripped: false, reason: "no-action-tags" };
    }

    // If inbox IDs provided, check if message also exists in inbox (skip if so)
    const inboxFolderIds = options.inboxFolderIds || [];
    if (inboxFolderIds.length > 0) {
      const headerMessageId = msg.headerMessageId ? String(msg.headerMessageId).replace(/[<>]/g, "") : null;
      if (headerMessageId) {
        try {
          const inboxQuery = await browser.messages.query({ folderId: inboxFolderIds, headerMessageId });
          if (inboxQuery?.messages?.length > 0) {
            return { stripped: false, reason: "exists-in-inbox" };
          }
        } catch (_) {
          // If query fails, err on the side of caution: skip stripping
          return { stripped: false, reason: "inbox-check-failed" };
        }
      }
    }

    // Strip TabMail action tags
    const newTags = tags.filter((t) => !actionTagIds.includes(t));
    await browser.messages.update(msg.id, { tags: newTags });
    log(`[TMDBG Sanitize] stripped stale tags id=${msg.id} folder=${folder.path || folder.name}`);
    return { stripped: true };
  } catch (e) {
    log(`[TMDBG Sanitize] error id=${msg?.id}: ${e}`, "info");
    return { stripped: false, reason: "error" };
  }
}

// Keep references to listeners so we can clean them up on suspend/reload
let _onMovedHandler = null;
let _onDeletedHandler = null;
let _onCopiedHandler = null;
let _onAfterSendHandler = null;
let _onMessageUpdatedHandler = null;

function _isMessageNotFoundError(e) {
  try {
    return String(e || "").toLowerCase().includes("message not found");
  } catch (_) {
    return false;
  }
}

function _hasTabMailActionTags(tags) {
  try {
    const actionTagIds = Object.values(ACTION_TAG_IDS);
    const list = Array.isArray(tags) ? tags : [];
    return list.some((t) => actionTagIds.includes(t));
  } catch (_) {
    return false;
  }
}

function _stripTabMailActionTagsFromList(tags) {
  const actionTagIds = Object.values(ACTION_TAG_IDS);
  const list = Array.isArray(tags) ? tags : [];
  return list.filter((t) => !actionTagIds.includes(t));
}

async function _stripActionTagsByIdBestEffort(messageId, reason = "") {
  try {
    const id = Number(messageId || 0);
    if (!id) return { ok: false, removed: [], notFound: false };
    const hdr = await browser.messages.get(id);
    const currentTags = Array.isArray(hdr?.tags) ? hdr.tags : [];
    if (!_hasTabMailActionTags(currentTags)) return { ok: true, removed: [], notFound: false };
    const removed = currentTags.filter((t) => Object.values(ACTION_TAG_IDS).includes(t));
    const newTags = _stripTabMailActionTagsFromList(currentTags);
    await browser.messages.update(id, { tags: newTags });
    try {
      log(`[TMDBG onMoved] tag-strip id=${id} removed=[${removed.join(",")}] reason=${reason || ""}`);
    } catch (_) {}
    return { ok: true, removed, notFound: false };
  } catch (e) {
    const notFound = _isMessageNotFoundError(e);
    try {
      log(
        `[TMDBG onMoved] tag-strip failed id=${messageId} notFound=${notFound} reason=${reason || ""} err=${e}`,
        notFound ? "info" : "warn"
      );
    } catch (_) {}
    return { ok: false, removed: [], notFound };
  }
}

async function _clearActionTagsAcrossSpecialUseFoldersByHeaderMessageId(seedHeader, reason = "") {
  try {
    const cfg = SETTINGS?.onMoved?.tagClearOnLeaveInbox?.clearByHeaderMessageId || null;
    if (!cfg || cfg.enabled !== true) return { attempted: false, ids: [] };

    const accountId = seedHeader?.folder?.accountId || null;
    const headerMessageIdRaw = seedHeader?.headerMessageId || null;
    const headerMessageId = headerMessageIdRaw ? String(headerMessageIdRaw).replace(/[<>]/g, "") : null;
    if (!accountId || !headerMessageId) return { attempted: false, ids: [] };

    // Only do this for IMAP accounts (Gmail label semantics lives here).
    let accountType = null;
    try {
      const accounts = await browser.accounts.list();
      const acc = accounts.find((a) => a?.id === accountId) || null;
      accountType = acc?.type || null;
    } catch (_) {
      accountType = null;
    }
    if (accountType && String(accountType).toLowerCase() !== "imap") {
      return { attempted: false, ids: [] };
    }

    const allowListRaw = Array.isArray(cfg.specialUseAllowList) ? cfg.specialUseAllowList : [];
    const allowList = allowListRaw.map((s) => String(s || "").toLowerCase().trim()).filter((s) => !!s);

    const maxFolders = Number(cfg.maxFolders);
    if (!Number.isFinite(maxFolders) || maxFolders < 1) {
      log(`[TMDBG onMoved] clearByHeaderMessageId invalid maxFolders=${cfg.maxFolders}`, "warn");
      return { attempted: false, ids: [] };
    }

    let folders = [];
    try {
      const accounts = await browser.accounts.list();
      const acc = accounts.find((a) => a?.id === accountId) || null;
      if (!acc?.rootFolder?.id) return { attempted: false, ids: [] };
      const subs = await browser.folders.getSubFolders(acc.rootFolder.id, true);
      folders = [acc.rootFolder, ...(Array.isArray(subs) ? subs : [])];
    } catch (eFolders) {
      log(`[TMDBG onMoved] clearByHeaderMessageId folder enumeration failed: ${eFolders}`, "warn");
      return { attempted: false, ids: [] };
    }

    const folderIds = [];
    for (const f of folders) {
      try {
        if (!f?.id) continue;
        const su = Array.isArray(f.specialUse) ? f.specialUse.map((x) => String(x).toLowerCase()) : [];
        const match = allowList.length === 0 ? su.length > 0 : su.some((x) => allowList.includes(x));
        if (!match) continue;
        folderIds.push(f.id);
        if (folderIds.length >= maxFolders) break;
      } catch (_) {}
    }

    if (folderIds.length === 0) {
      log(`[TMDBG onMoved] clearByHeaderMessageId no specialUse folders found accountId=${accountId}`, "info");
      return { attempted: true, ids: [] };
    }

    let queryResult = null;
    try {
      queryResult = await browser.messages.query({ folderId: folderIds, headerMessageId });
    } catch (eQ) {
      log(`[TMDBG onMoved] clearByHeaderMessageId messages.query failed: ${eQ}`, "warn");
      return { attempted: true, ids: [] };
    }

    const found = [];
    if (queryResult?.messages && Array.isArray(queryResult.messages)) found.push(...queryResult.messages);
    try {
      let contId = queryResult?.id || null;
      while (contId) {
        const page = await browser.messages.continueList(contId);
        if (page?.messages && Array.isArray(page.messages)) found.push(...page.messages);
        contId = page?.id || null;
      }
    } catch (eCont) {
      log(`[TMDBG onMoved] clearByHeaderMessageId continueList failed: ${eCont}`, "warn");
    }

    const ids = Array.from(new Set(found.map((m) => Number(m?.id || 0)).filter((n) => !!n)));
    log(
      `[TMDBG onMoved] clearByHeaderMessageId headerMessageId=${headerMessageId} folders=${folderIds.length} matches=${ids.length} reason=${reason || ""}`
    );

    for (const mid of ids) {
      await _stripActionTagsByIdBestEffort(mid, `clearByHeaderMessageId:${reason || ""}`);
    }

    return { attempted: true, ids };
  } catch (e) {
    log(`[TMDBG onMoved] clearByHeaderMessageId unexpected error: ${e}`, "warn");
    return { attempted: false, ids: [] };
  }
}

/**
 * Leave-inbox cleanup for a single message (passive-decay of legacy `tm_*`).
 * Called by messageProcessorQueue when operationType === "tagCleanupOnLeaveInbox".
 *
 * Post Phase 0:
 *   - Strips native `tm_*` keywords (best effort; for passive decay of legacy data).
 *   - Removes `tm_*` Gmail labels on Gmail accounts.
 *   - Clears the IDB action cache entry so the painter stops rendering an action.
 *   - No reassert guard / watchdog: we never ADD `tm_*` anymore, so any remote
 *     re-assert is a stale signal that will be caught on the next leave-inbox
 *     event or by runStaleTagSweep.
 *
 * @param {Object} liveHeader - Live message header (already resolved by queue)
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function performLeaveInboxTagCleanup(liveHeader) {
  try {
    if (!liveHeader?.id) return { ok: false, reason: "no-header" };
    const messageId = liveHeader.id;

    // 1. Strip native action tags on the live header (IMAP keyword remove).
    await _stripActionTagsByIdBestEffort(messageId, "queue:tagCleanupOnLeaveInbox");

    // 2. Cross-folder cleanup (IMAP) + Gmail label remove (REST).
    try {
      await _clearActionTagsAcrossSpecialUseFoldersByHeaderMessageId(liveHeader, "queue:tagCleanupOnLeaveInbox");
    } catch (eCross) {
      log(`[TMDBG onMoved] tagCleanup cross-folder cleanup failed: ${eCross}`, "warn");
    }
    try {
      const accountId = liveHeader?.folder?.accountId || "";
      const headerMessageId = liveHeader?.headerMessageId || "";
      if (accountId) {
        await removeTmLabelsFromGmailMessage(messageId, accountId, headerMessageId);
      }
    } catch (eGmail) {
      log(`[TMDBG onMoved] tagCleanup Gmail label remove failed: ${eGmail}`, "warn");
    }

    // 3. Clear IDB action cache entry (canonical source of truth).
    try {
      const uniqueKey = await getUniqueMessageKey(liveHeader);
      if (uniqueKey) {
        await clearActionByUniqueKey(uniqueKey);
        log(`[TMDBG onMoved] tagCleanup cleared IDB action for uniqueKey=${uniqueKey}`);
      }
    } catch (eCache) {
      log(`[TMDBG onMoved] tagCleanup IDB cache clear failed: ${eCache}`, "warn");
    }

    return { ok: true };
  } catch (e) {
    log(`[TMDBG onMoved] performLeaveInboxTagCleanup failed: ${e}`, "warn");
    return { ok: false, reason: String(e) };
  }
}

// ------------------------------
// Internal helpers (deduplicated)
// ------------------------------
function _extractListsFromArgs(args) {
  const details = args?.[0] || {};
  const hasHeaders = Array.isArray(details?.messages) && details.messages.length > 0;
  const ids = Array.isArray(details?.messageIds)
    ? details.messageIds
    : Array.isArray(details?.ids)
    ? details.ids
    : [];
  const items = hasHeaders ? details.messages : ids.map((id) => ({ id }));
  const hasTwoLists = args && args.length === 2 && Array.isArray(args[0]?.messages) && Array.isArray(args[1]?.messages);
  const beforeList = hasTwoLists ? (args[0].messages || []) : [];
  const afterList = hasTwoLists ? (args[1].messages || []) : (hasHeaders ? (details.messages || []) : []);
  return { details, hasHeaders, items, hasTwoLists, beforeList, afterList };
}

function _warmIndex(headers, label) {
  try {
    const list = Array.isArray(headers) ? headers : [];
    for (const h of list) { try { indexHeader(h); } catch (_) {} }
    log(`[TMDBG MessageActions] ${label} index warmed count=${list.length}`);
  } catch (_) {}
}

// -----------------------------------
// Cache remap for moved message keys
// -----------------------------------
const CACHE_REMAP_PREFIXES = [
  // Summaries
  "summary:",
  "summary:ts:",
  // Actions
  "action:",
  "action:ts:",
  "action:orig:",
  "action:justification:",
  "action:userprompt:",
  // Replies
  "reply:",
  "reply:ts:",
];

// This is not used anymore, but keeping it here for reference
async function _remapCachesForMovedMessage(beforeHeader, afterHeader) {
  try {
    if (!beforeHeader || !afterHeader) return;
    const beforeKey = await getUniqueMessageKey(beforeHeader);
    const afterKey = await getUniqueMessageKey(afterHeader);
    if (!beforeKey || !afterKey) {
      log(`[TMDBG onMoved] Cache remap skipped (keys missing) before=${beforeKey} after=${afterKey}`, "warn");
      return;
    }

    // Build list of old keys to probe
    const oldKeys = CACHE_REMAP_PREFIXES.map((p) => p + beforeKey);
    const found = await idb.get(oldKeys);

    // For each found old key, write to new key and remove old
    for (const [oldKey, value] of Object.entries(found)) {
      try {
        if (value === undefined) continue;
        const prefix = oldKey.slice(0, oldKey.indexOf(beforeKey));
        const newKey = prefix + afterKey;
        await idb.set({ [newKey]: value }, { kind: "remap" });
        await idb.remove(oldKey);
        log(`[TMDBG onMoved] Remapped cache key '${prefix}' from ${beforeKey} -> ${afterKey}`);
      } catch (eOne) {
        log(`[TMDBG onMoved] Failed remapping cache key ${oldKey}: ${eOne}`, "warn");
      }
    }
  } catch (e) {
    log(`[TMDBG onMoved] Cache remap error: ${e}`, "warn");
  }
}

/**
 * Safety-net sweep: periodic low-frequency scan of non-inbox folders for stray TabMail action tags.
 * Catches anything the bounded reassert guard missed (e.g., very late IMAP reasserts).
 * Exported so it can be triggered manually via debug context menu.
 * @param {object} options - Optional config overrides.
 * @param {boolean} options.unlimited - If true, ignores maxMessagesPerSweep limit (for manual debug runs).
 */
export async function runStaleTagSweep(options = {}) {
  try {
    const cfg = SETTINGS?.onMoved?.staleTagSweep || null;
    if (!cfg || cfg.enabled !== true) return;

    const allowListRaw = Array.isArray(cfg.specialUseAllowList) ? cfg.specialUseAllowList : [];
    const allowList = allowListRaw.map((s) => String(s || "").toLowerCase().trim()).filter((s) => !!s);
    const maxFolders = Number(cfg.maxFolders);
    // For manual debug runs, allow unlimited processing.
    const maxMessages = options.unlimited ? Infinity : Number(cfg.maxMessagesPerSweep);
    const isUnlimited = options.unlimited === true;
    log(`[TMDBG onMoved] staleTagSweep starting unlimited=${isUnlimited} maxFolders=${maxFolders} maxMessages=${isUnlimited ? "∞" : maxMessages}`);

    // Validate maxFolders; maxMessages can be Infinity for unlimited mode.
    const maxMessagesValid = isUnlimited || (Number.isFinite(maxMessages) && maxMessages >= 1);
    if (!Number.isFinite(maxFolders) || maxFolders < 1 || !maxMessagesValid) {
      log(`[TMDBG onMoved] staleTagSweep config invalid maxFolders=${cfg.maxFolders} maxMessages=${cfg.maxMessagesPerSweep}`, "warn");
      return;
    }

    const actionTagIds = Object.values(ACTION_TAG_IDS);
    let strippedTotal = 0;

    // Calculate date cutoff (messages older than this are skipped)
    const maxAgeDays = Number(cfg.maxAgeDays) || 0;
    let cutoffDate = null;
    if (maxAgeDays > 0) {
      cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
      log(`[TMDBG onMoved] staleTagSweep maxAgeDays=${maxAgeDays} cutoffDate=${cutoffDate.toISOString()}`);
    }

    // Iterate over all accounts
    const accounts = await browser.accounts.list();
    for (const acc of accounts) {
      if (strippedTotal >= maxMessages) break;
      try {
        if (!acc?.rootFolder?.id) continue;
        // Use manual traversal to get ALL folders (recursive=true doesn't work for Gmail [Gmail] children)
        const folders = await getAllFoldersForAccount(acc.id);

        const targetFolders = [];
        // Debug: log all folders and their specialUse values
        const folderDebug = folders.map((f) => {
          const su = Array.isArray(f.specialUse) ? f.specialUse : [];
          return `${f.path || f.name}:specialUse=[${su.join(",")}]`;
        });
        log(`[TMDBG onMoved] staleTagSweep account=${acc.id} allFolders=[${folderDebug.join(" | ")}]`);

        for (const f of folders) {
          if (!f?.id) continue;
          // Skip inbox folders
          if (isInboxFolder(f)) continue;
          const su = Array.isArray(f.specialUse) ? f.specialUse.map((x) => String(x).toLowerCase()) : [];
          const match = allowList.length === 0 ? su.length > 0 : su.some((x) => allowList.includes(x));
          if (!match) continue;
          targetFolders.push(f);
          if (targetFolders.length >= maxFolders) break;
        }

        // Find Inbox folder for this account to check if a message also exists there.
        // Use centralized helper from inboxContext.js to avoid duplication.
        let inboxFolderIds = [];
        try {
          const inbox = await getInboxForAccount(acc.id);
          if (inbox?.id) {
            inboxFolderIds = [inbox.id];
          }
        } catch (_) {}

        log(`[TMDBG onMoved] staleTagSweep account=${acc.id} targetFolders=[${targetFolders.map(f => f.path || f.name).join(", ")}]`);

        for (const folder of targetFolders) {
          if (strippedTotal >= maxMessages) break;
          try {
            // Query messages in this folder that have any of our action tags
            // TB doesn't support tag filtering in query, so we paginate and check locally.
            let page = await browser.messages.list(folder.id);
            let folderMsgCount = 0;
            let folderTaggedCount = 0;
            while (page && page.messages && page.messages.length > 0 && strippedTotal < maxMessages) {
              for (const msg of page.messages) {
                folderMsgCount++;
                if (strippedTotal >= maxMessages) break;

                // Skip messages older than cutoff (if date limit is set)
                if (cutoffDate && msg.date) {
                  const msgDate = new Date(msg.date);
                  if (msgDate < cutoffDate) continue;
                }

                const tags = Array.isArray(msg.tags) ? msg.tags : [];
                if (!tags.some((t) => actionTagIds.includes(t))) continue;
                folderTaggedCount++;

                // Before stripping, check if this message also exists in Inbox (e.g., All Mail view of Inbox message).
                // If it does, skip — the tag is legitimate.
                const headerMessageId = msg.headerMessageId ? String(msg.headerMessageId).replace(/[<>]/g, "") : null;
                if (headerMessageId && inboxFolderIds.length > 0) {
                  try {
                    const inboxQuery = await browser.messages.query({ folderId: inboxFolderIds, headerMessageId });
                    if (inboxQuery?.messages?.length > 0) {
                      // Message exists in Inbox — skip stripping, tag is valid.
                      log(`[TMDBG onMoved] staleTagSweep skipped (exists in Inbox) id=${msg.id} headerMessageId=${headerMessageId}`);
                      continue;
                    }
                  } catch (eInboxCheck) {
                    // If query fails, err on the side of caution: skip stripping.
                    log(`[TMDBG onMoved] staleTagSweep inbox check failed id=${msg.id}: ${eInboxCheck}`, "info");
                    continue;
                  }
                }

                // This message has a stale TabMail action tag and is NOT in Inbox — strip it.
                try {
                  const newTags = tags.filter((t) => !actionTagIds.includes(t));
                  await browser.messages.update(msg.id, { tags: newTags });
                  strippedTotal++;
                  log(`[TMDBG onMoved] staleTagSweep stripped id=${msg.id} folder=${folder.path || folder.name}`);
                } catch (eStrip) {
                  log(`[TMDBG onMoved] staleTagSweep strip failed id=${msg.id}: ${eStrip}`, "info");
                }
              }
              if (page.id && strippedTotal < maxMessages) {
                page = await browser.messages.continueList(page.id);
              } else {
                break;
              }
            }
            log(`[TMDBG onMoved] staleTagSweep folder=${folder.path || folder.name} msgs=${folderMsgCount} withActionTag=${folderTaggedCount}`);
          } catch (eFolder) {
            log(`[TMDBG onMoved] staleTagSweep folder error folder=${folder?.path || folder?.id}: ${eFolder}`, "info");
          }
        }
      } catch (eAcc) {
        log(`[TMDBG onMoved] staleTagSweep account error acc=${acc?.id}: ${eAcc}`, "info");
      }
    }

    const limitReached = strippedTotal >= maxMessages;
    log(`[TMDBG onMoved] staleTagSweep complete: stripped=${strippedTotal} limitReached=${limitReached}`);
  } catch (e) {
    log(`[TMDBG onMoved] staleTagSweep error: ${e}`, "warn");
  }
}

/**
 * Attach listeners for post-move/delete events.
 * This module classifies manual moves and deletes, logs via autoUpdateUserPromptOnMove,
 * and never changes tags.
 */
export function attachOnMovedListeners() {
  try {
    if (browser.messages && browser.messages.onMoved && !_onMovedHandler) {
      _onMovedHandler = async (...args) => {
        try {
          const { details, items, hasTwoLists, beforeList, afterList } = _extractListsFromArgs(args);

          // IMMEDIATELY log to persistent storage for debugging race conditions
          if (hasTwoLists && afterList.length > 0) {
            // TB 141+ style with before/after lists
            const srcFolder = beforeList[0]?.folder || details.source;
            const dstFolder = afterList[0]?.folder || details.destination;
            logMoveEvent("onMoved:detail", "onMovedModule", srcFolder, afterList, dstFolder);
          } else if (items.length > 0) {
            logMoveEvent("onMoved:simple", "onMovedModule", details.source, items, details.destination);
          } else {
            logMessageEvent("onMoved:empty", "onMovedModule", {
              source: details.source?.path,
              destination: details.destination?.path,
              itemCount: 0,
              note: "no items in event",
            });
          }

          // Integrate FTS incremental indexing (avoid duplicate listeners)
          try {
            const { onMessageMoved: ftsOnMoved } = await import("../../fts/incrementalIndexer.js");
            if (hasTwoLists && beforeList.length > 0 && afterList.length > 0) {
              // Handle moves with before/after lists
              for (let i = 0; i < Math.min(beforeList.length, afterList.length); i++) {
                await ftsOnMoved(beforeList[i], afterList[i]);
              }
            } else if (items.length > 0) {
              // Handle simple moves (assume current state is after move)
              for (const item of items) {
                // For simple moves, we treat as delete + new since we don't have before state
                // The FTS will re-index the current state
                const { onMessageDeleted: ftsOnDeleted, onNewMailReceived: ftsOnNew } = await import("../../fts/incrementalIndexer.js");
                await ftsOnDeleted(item.folder || details.destination, [item]);
                await ftsOnNew(details.destination || item.folder, [item]);
              }
            }
          } catch (e) {
            log(`[TMDBG onMoved] FTS incremental indexing failed for moved messages: ${e}`, "warn");
          }

          // Update headerIndex mappings for moved messages
          try {
            if (hasTwoLists && beforeList.length > 0 && afterList.length > 0) {
              // Handle moves with before/after lists - update headerIndex mappings
              for (let i = 0; i < Math.min(beforeList.length, afterList.length); i++) {
                await updateHeaderIndexForMovedMessage(beforeList[i], afterList[i]);
                
                // Update snippet cache keys for moved messages
                try {
                  const { moveSnippet } = await import("../../theme/modules/snippetCache.js");
                  const oldKey = await getUniqueMessageKey(beforeList[i]);
                  const newKey = await getUniqueMessageKey(afterList[i]);
                  if (oldKey && newKey && oldKey !== newKey) {
                    await moveSnippet(oldKey, newKey);
                  }
                } catch (eSnippet) {
                  log(`[TMDBG onMoved] snippet cache update failed: ${eSnippet}`, "warn");
                }
                
                // Clear TabMail tags when message leaves inbox
                // Tags are inbox-scoped for triage purposes only
                let wasInInbox = false;
                let nowInInbox = false;
                try {
                  const beforeFolder = beforeList[i]?.folder;
                  const afterFolder = afterList[i]?.folder;
                  wasInInbox = isInboxFolder(beforeFolder);
                  nowInInbox = isInboxFolder(afterFolder);
                  
                  if (wasInInbox && !nowInInbox) {
                    log(`[TMDBG onMoved] Message left inbox, enqueuing tag cleanup: id=${afterList[i]?.id}`);

                    // Eagerly clear inbox-scoped IDB action cache (the before-key uses
                    // the inbox folder path which won't be derivable at queue drain time).
                    try {
                      const beforeKey = await getUniqueMessageKey(beforeList[i]);
                      if (beforeKey) {
                        await idb.remove([`action:${beforeKey}`, `action:ts:${beforeKey}`]);
                        log(`[TMDBG onMoved] Eagerly cleared inbox action cache: action:${beforeKey}`);
                      }
                    } catch (eCacheEager) {
                      log(`[TMDBG onMoved] Eager cache clear failed (non-critical): ${eCacheEager}`, "info");
                    }

                    // Enqueue for persistent, retryable tag cleanup via the queue.
                    // Replaces the heavy synchronous _clearTabMailTagsOnLeaveInbox call.
                    try {
                      const { enqueueProcessMessage } = await import("./messageProcessorQueue.js");
                      await enqueueProcessMessage(afterList[i], {
                        operationType: "tagCleanupOnLeaveInbox",
                        source: "onMoved:leaveInbox",
                      });
                    } catch (eEnqueue) {
                      log(`[TMDBG onMoved] Failed to enqueue tag cleanup: ${eEnqueue}`, "warn");
                    }

                    // Thread tags: after leaving Inbox, recompute aggregate/effective tag for the remaining thread in Inbox.
                    // Seed with the destination id; Gloda conversation enumeration is not folder-view dependent.
                    try {
                      const seedId = afterList[i]?.id || beforeList[i]?.id;
                      if (seedId) {
                        // Fire-and-forget; do not block onMoved handler.
                        recomputeThreadForInboxMessage(seedId, "onMoved-leave-inbox").catch((e) => {
                          log(`[TMDBG onMoved] recomputeThreadForInboxMessage failed seedId=${seedId}: ${e}`, "warn");
                        });
                      }
                    } catch (_) {}
                  } else if (!wasInInbox && nowInInbox) {
                    // Important: inbox scans may not process this message (e.g., sender filter or maxEmails cap).
                    // When a message ENTERS inbox, proactively run the unified pipeline on just this message
                    // so action tags are applied without requiring a user click.
                    try {
                      const weId = afterList[i]?.id;
                      log(`[TMDBG onMoved] Message entered inbox, triggering processing: id=${weId}`);
                      const live = weId ? await browser.messages.get(weId) : null;
                      if (live && live.id) {
                        const { enqueueProcessMessage } = await import("./messageProcessorQueue.js");
                        const { isInternalSender } = await import("./senderFilter.js");
                        try {
                          const internal = await isInternalSender(live);
                          if (internal) {
                            // Internal/self-sent: do not run action pipeline and do not perform cleanup.
                            return;
                          }
                        } catch (_) {}
                        // Queue for persistent processing; fast and retryable when offline.
                        await enqueueProcessMessage(live, { isPriority: false, source: "onMoved:enterInbox" });
                      } else {
                        log(`[TMDBG onMoved] Could not fetch live header for inbox-enter id=${weId}`, "warn");
                      }
                    } catch (eProc) {
                      log(`[TMDBG onMoved] Failed triggering processMessage on inbox-enter: ${eProc}`, "warn");
                    }
                  }
                } catch (eTagClear) {
                  log(`[TMDBG onMoved] Tag clear on leave inbox failed: ${eTagClear}`, "warn");
                }

              }
            } else if (items.length > 0) {
              // For simple moves, we can't update headerIndex since we don't have before state
              // The headerIndex will be updated when the message is re-indexed
              log(`[TMDBG onMoved] Simple move detected - headerIndex will be updated on re-index`);
              try { log(`[TMDBG onMoved] Simple move – cache remap skipped (no before state available)`); } catch (_) {}
            }
          } catch (e) {
            log(`[TMDBG onMoved] headerIndex update failed for moved messages: ${e}`, "warn");
          }

          // Warm index using after-list (TB 141) or details.messages
          const toIndex = hasTwoLists ? afterList : (Array.isArray(details?.messages) ? details.messages : []);
          _warmIndex(toIndex, "onMoved");

          // Processing for autoUpdateUserPromptOnMove
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            try {
              const afterHeader = hasTwoLists ? afterList[i] || null : null;
              const header =
                afterHeader ||
                (item && (item.headerMessageId || item.folder)
                  ? item
                  : item?.id
                  ? await browser.messages.get(item.id)
                  : null);
              if (!header || !header.id) continue;
              try {
                const bTags = Array.isArray(beforeList?.[i]?.tags) ? beforeList[i].tags : [];
                const staleATags = Array.isArray(afterHeader?.tags)
                  ? afterHeader.tags
                  : (Array.isArray(header?.tags) ? header.tags : []);
                let liveATags = [];
                try {
                  const liveId = afterHeader?.id || header?.id || null;
                  const liveAfter = liveId ? await browser.messages.get(liveId) : null;
                  liveATags = Array.isArray(liveAfter?.tags) ? liveAfter.tags : [];
                } catch (eLiveTags) {
                  log(`[TMDBG MessageActions] onMoved live tags get failed id=${afterHeader?.id || header?.id}: ${eLiveTags}`, "warn");
                }
                log(
                  `[TMDBG MessageActions] onMoved tags staleBefore=[${bTags.join(",")}] staleAfter=[${staleATags.join(
                    ","
                  )}] liveAfter=[${liveATags.join(",")}] id=${header.id}`
                );
              } catch (_) {}
              let action = null;
              const destSpecialArr = Array.isArray(afterHeader?.folder?.specialUse)
                ? afterHeader.folder.specialUse.map((s) => String(s).toLowerCase())
                : [];
              const msgSpecialArr = Array.isArray(header?.folder?.specialUse)
                ? header.folder.specialUse.map((s) => String(s).toLowerCase())
                : [];
              let actionReason = "";
              if (destSpecialArr.includes("trash")) { action = "delete"; actionReason = "dest.specialUse=trash"; }
              if (destSpecialArr.includes("archives") || destSpecialArr.includes("all")) { action = "archive"; actionReason = actionReason || "dest.specialUse=archives|all"; }
              if (!action) {
                if (msgSpecialArr.includes("trash")) { action = "delete"; actionReason = "header.specialUse=trash"; }
                if (msgSpecialArr.includes("archives") || msgSpecialArr.includes("all")) { action = "archive"; actionReason = actionReason || "header.specialUse=archives|all"; }
              }
              if (!action) {
                const [trash, arch] = await Promise.all([
                  getTrashFolderForHeader(header),
                  getArchiveFolderForHeader(header),
                ]);
                if (trash && header.folder && header.folder.id === trash.id) action = "delete";
                if (arch && header.folder && header.folder.id === arch.id) action = "archive";
              }
              if (action) {
                try { log(`[TMDBG MessageActions] onMoved classified action=${action} (${actionReason || 'heuristic'}) for id=${header.id}`); } catch(_) {}
                try {
                  const targetId = header?.id || item?.id || 0;
                  await autoUpdateUserPromptOnMove(targetId, {
                    source: "manual-move",
                    action,
                    beforeId: item?.id || null,
                    afterId: header?.id || null,
                  });
                } catch (_) {}
              } else {
                try {
                  const keySourceId = header?.id || item?.id;
                  const uniqueKey = header.headerMessageId
                    ? String(header.headerMessageId).replace(/[<>]/g, "")
                    : keySourceId
                    ? await getUniqueMessageKey(keySourceId)
                    : null;
                  log(`[TMDBG MessageActions] onMoved unclassified: id=${header.id} folder=${header.folder?.id || ""}`);
                } catch (_) {}
              }
            } catch (eMoveOne) {
              log(`[TMDBG MessageActions] Error processing moved message: ${eMoveOne}`);
            }
          }
        } catch (eMove) {
          log(`[TMDBG MessageActions] messages.onMoved handler error: ${eMove}`);
        }
      };
      browser.messages.onMoved.addListener(_onMovedHandler);
      log("[TMDBG MessageActions] messages.onMoved listener attached");
    }
  } catch (e) {
    log(`[TMDBG MessageActions] Failed to attach messages.onMoved: ${e}`);
  }

  // FTS incremental indexing on message updates (Gmail label detection etc.).
  try {
    if (browser.messages?.onUpdated && !_onMessageUpdatedHandler) {
      _onMessageUpdatedHandler = (...args) => {
        (async () => {
          try {
            const a0 = args?.[0] ?? null;
            const a1 = args?.[1] ?? null;
            const changedProps = a1 && typeof a1 === "object" ? a1 : null;

            const { onMessageUpdated: ftsOnUpdated } = await import("../../fts/incrementalIndexer.js");
            const msgId = typeof a0 === "number" ? a0 : Number(a0?.id || 0);
            if (msgId) {
              const msg = await browser.messages.get(msgId);
              if (msg) await ftsOnUpdated(msg, changedProps);
            }
          } catch (eFts) {
            log(`[TMDBG onMoved] FTS onUpdated integration failed: ${eFts}`, "info");
          }
        })();
      };
      browser.messages.onUpdated.addListener(_onMessageUpdatedHandler);
    }
  } catch (e) {
    log(`[TMDBG onMoved] Failed attaching messages.onUpdated listener: ${e}`, "warn");
  }

  try {
    if (browser.messages && browser.messages.onDeleted && !_onDeletedHandler) {
      _onDeletedHandler = async (details) => {
        try {
          // IMMEDIATELY log to persistent storage for debugging race conditions
          if (details.messages && details.messages.length > 0) {
            logMoveEvent("onDeleted", "onMovedModule", details.folder, details.messages);
          } else {
            logMessageEvent("onDeleted:empty", "onMovedModule", {
              folderPath: details.folder?.path,
              messageCount: 0,
              note: "no messages in event",
            });
          }

          // Integrate FTS incremental indexing (avoid duplicate listeners)
          try {
            const { onMessageDeleted: ftsOnDeleted } = await import("../../fts/incrementalIndexer.js");
            if (details.messages && details.messages.length > 0) {
              // Note: details.folder might be undefined in onDeleted events, that's OK
              await ftsOnDeleted(details.folder, details.messages);
            }
          } catch (e) {
            log(`[TMDBG onDeleted] FTS incremental indexing failed for deleted messages: ${e}`, "warn");
          }

          // Clean up headerIndex mappings for deleted messages
          try {
            if (details.messages && details.messages.length > 0) {
              for (const message of details.messages) {
                await removeHeaderIndexForDeletedMessage(message);
              }
            }
          } catch (e) {
            log(`[TMDBG onDeleted] headerIndex cleanup failed for deleted messages: ${e}`, "warn");
          }

          // Clean up snippet cache for deleted messages
          try {
            if (details.messages && details.messages.length > 0) {
              const { removeSnippet } = await import("../../theme/modules/snippetCache.js");
              for (const message of details.messages) {
                const uniqueKey = await getUniqueMessageKey(message);
                if (uniqueKey) {
                  await removeSnippet(uniqueKey);
                }
              }
            }
          } catch (e) {
            log(`[TMDBG onDeleted] snippet cache cleanup failed for deleted messages: ${e}`, "warn");
          }

          // Processing for autoUpdateUserPromptOnMove
          console.log("[TabMail Agent] messages.onDeleted details:", details);
          const { items } = _extractListsFromArgs([details]);
          for (const item of items) {
            let action = null;
            const special = Array.isArray(item?.folder?.specialUse)
              ? item.folder.specialUse.map((s) => String(s).toLowerCase())
              : [];
            if (special.includes("archives")) action = "archive";
            if (special.includes("trash")) action = action || "delete";

            let uniqueKey = null;
            if (item && item.headerMessageId) {
              uniqueKey = String(item.headerMessageId).replace(/[<>]/g, "");
            } else if (item && item.id) {
              try {
                uniqueKey = await getUniqueMessageKey(item.id);
              } catch (_) {
                uniqueKey = null;
              }
            }

            if (!action || !uniqueKey) {
              try {
                console.log(
                  "[TabMail Agent] onDeleted unclassified – specialUse:",
                  special,
                  "folder:",
                  item?.folder?.name || item?.folder?.path
                );
              } catch (_) {}
            }
            try {
              await autoUpdateUserPromptOnMove(item.id || 0, {
                source: "manual-delete",
                action: action || "unknown",
                details,
              });
            } catch (_) {}
          }
        } catch (eDel) {
          log(`[TMDBG MessageActions] messages.onDeleted handler error: ${eDel}`);
        }
      };
      browser.messages.onDeleted.addListener(_onDeletedHandler);
      log("[TMDBG MessageActions] messages.onDeleted listener attached");
    }
  } catch (e) {
    log(`[TMDBG MessageActions] Failed to attach messages.onDeleted: ${e}`);
  }

  // Attach onCopied to catch Sent copies immediately
  try {
    if (browser.messages && browser.messages.onCopied && !_onCopiedHandler) {
      _onCopiedHandler = async (...args) => {
        try {
          const { details, hasTwoLists, beforeList, afterList } = _extractListsFromArgs(args);

          // IMMEDIATELY log to persistent storage for debugging race conditions
          if (hasTwoLists && afterList.length > 0) {
            const srcFolder = beforeList[0]?.folder || details.source;
            const dstFolder = afterList[0]?.folder || details.destination;
            logMoveEvent("onCopied:detail", "onMovedModule", srcFolder, afterList, dstFolder);
          } else if (afterList.length > 0) {
            logMoveEvent("onCopied:simple", "onMovedModule", details.source, afterList, details.destination);
          } else {
            logMessageEvent("onCopied:empty", "onMovedModule", {
              source: details.source?.path,
              destination: details.destination?.path,
              itemCount: 0,
              note: "no items in event",
            });
          }

          // Integrate FTS incremental indexing for copies (e.g., Sent)
          try {
            log(`[TMDBG onCopied] FTS incremental indexing for copied messages: ${hasTwoLists} ${beforeList.length} ${afterList.length}`);
            const { onMessageCopied: ftsOnCopied, onNewMailReceived: ftsOnNew } = await import("../../fts/incrementalIndexer.js");
            if (hasTwoLists && beforeList.length > 0 && afterList.length > 0) {
              for (let i = 0; i < Math.min(beforeList.length, afterList.length); i++) {
                await ftsOnCopied(beforeList[i], afterList[i]);
              }
            } else if (afterList.length > 0) {
              // Treat as new arrivals in the destination folder when only the copies are provided
              const destFolder = details?.destination || afterList[0]?.folder || null;
              if (destFolder) {
                await ftsOnNew(destFolder, afterList);
              }
            }
          } catch (e) {
            log(`[TMDBG onCopied] FTS incremental indexing failed for copied messages: ${e}`, "warn");
          }

          // Warm header index for the new copies
          _warmIndex(afterList, "onCopied");

          // Diagnostic logging for Sent folder copies
          try {
            const destName = (afterList[0]?.folder?.name) || (details?.destination?.name) || "<unknown>";
            log(`[TMDBG MessageActions] messages.onCopied -> destination=${destName} count=${afterList.length}`);
          } catch (_) {}
        } catch (eCopy) {
          log(`[TMDBG MessageActions] messages.onCopied handler error: ${eCopy}`);
        }
      };
      browser.messages.onCopied.addListener(_onCopiedHandler);
      log("[TMDBG MessageActions] messages.onCopied listener attached");
    }
  } catch (e) {
    log(`[TMDBG MessageActions] Failed to attach messages.onCopied: ${e}`);
  }

  // Set up the stale-tag sweep alarm (safety net for late IMAP reasserts).
  try {
    const cfg = SETTINGS?.onMoved?.staleTagSweep || null;
    if (cfg?.enabled === true) {
      const intervalMinutes = Number(cfg.intervalMinutes);
      if (Number.isFinite(intervalMinutes) && intervalMinutes >= 1) {
        ensureAlarm({
          name: STALE_TAG_SWEEP_ALARM_NAME,
          periodMinutes: intervalMinutes,
          delayMinutes: intervalMinutes,
          onAlarm: () => {
            runStaleTagSweep().catch((e) => {
              log(`[TMDBG onMoved] staleTagSweep alarm handler error: ${e}`, "warn");
            });
          },
        }).then(() => {
          log(`[TMDBG onMoved] staleTagSweep alarm scheduled every ${intervalMinutes} minute(s)`);
        }).catch((e) => {
          log(`[TMDBG onMoved] staleTagSweep alarm setup failed: ${e}`, "warn");
        });
      } else {
        log(`[TMDBG onMoved] staleTagSweep config invalid intervalMinutes=${cfg.intervalMinutes}`, "warn");
      }
    }
  } catch (e) {
    log(`[TMDBG onMoved] staleTagSweep alarm attach failed: ${e}`, "warn");
  }

}


/**
 * Cleanup listeners to avoid leaks on MV3 suspend/uninstall or hot-reload
 */
export function cleanupOnMovedListeners() {
  try {
    clearAlarm(STALE_TAG_SWEEP_ALARM_NAME).catch(() => {});
  } catch (_) {}
  try {
    if (_onMessageUpdatedHandler && browser.messages?.onUpdated) {
      browser.messages.onUpdated.removeListener(_onMessageUpdatedHandler);
      _onMessageUpdatedHandler = null;
      log("[TMDBG onMoved] messages.onUpdated listener removed");
    }
  } catch (e) {
    log(`[TMDBG onMoved] Failed to remove messages.onUpdated listener: ${e}`, "warn");
  }
  try {
    if (_onMovedHandler && browser.messages?.onMoved) {
      browser.messages.onMoved.removeListener(_onMovedHandler);
      _onMovedHandler = null;
      log("[TMDBG MessageActions] messages.onMoved listener removed");
    }
  } catch (e) {
    log(`[TMDBG MessageActions] Failed to remove messages.onMoved listener: ${e}`, "warn");
  }
  try {
    if (_onDeletedHandler && browser.messages?.onDeleted) {
      browser.messages.onDeleted.removeListener(_onDeletedHandler);
      _onDeletedHandler = null;
      log("[TMDBG MessageActions] messages.onDeleted listener removed");
    }
  } catch (e) {
    log(`[TMDBG MessageActions] Failed to remove messages.onDeleted listener: ${e}`, "warn");
  }
  try {
    if (_onCopiedHandler && browser.messages?.onCopied) {
      browser.messages.onCopied.removeListener(_onCopiedHandler);
      _onCopiedHandler = null;
      log("[TMDBG MessageActions] messages.onCopied listener removed");
    }
  } catch (e) {
    log(`[TMDBG MessageActions] Failed to remove messages.onCopied listener: ${e}`, "warn");
  }
  try {
    if (_onAfterSendHandler && browser.compose?.onAfterSend) {
      browser.compose.onAfterSend.removeListener(_onAfterSendHandler);
      _onAfterSendHandler = null;
      log("[AfterSend] onAfterSend listener removed (onMoved.js)");
    }
  } catch (e) {
    log(`[AfterSend] Failed to remove onAfterSend listener: ${e}`, "warn");
  }
}

export const _testHelpers = { _isMessageNotFoundError, _hasTabMailActionTags, _stripTabMailActionTagsFromList, _extractListsFromArgs };
