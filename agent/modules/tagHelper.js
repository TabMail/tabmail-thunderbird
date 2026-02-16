/**
 * tagHelper.js — Main entry point for action tagging.
 *
 * This module provides:
 *   - Message query/sync infrastructure (inbox lookups, cross-folder sync)
 *   - Main tagging entry points (applyActionTags, applyPriorityTag)
 *   - Action cache helpers (importActionFromImapTag, setActionCacheByUniqueKey)
 *
 * Re-exports everything from tagDefs, gmailLabelSync, and threadTagGroup
 * so existing importers don't need to change.
 */

import { SETTINGS } from "./config.js";
import { getAllFoldersForAccount, isInboxFolder } from "./folderUtils.js";
import * as idb from "./idbStorage.js";
import { getUniqueMessageKey, indexHeader } from "./utils.js";
import {
  ACTION_TAG_IDS,
  ensureActionTags,
  actionFromLiveTagIds,
  triggerSortRefresh,
  reorderTagsToPreferTabMail,
  hasNonTabMailTags,
  isDebugTagRaceEnabled,
} from "./tagDefs.js";
import { syncGmailTagFolder } from "./gmailLabelSync.js";
import {
  getTagByThreadEnabled,
  computeAndStoreThreadTagList,
  updateThreadEffectiveTagsIfNeeded,
  selfTagUpdateIgnoreUntilByMsgId,
  scheduleSelfTagIgnorePrune,
} from "./threadTagGroup.js";

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility (no external importers need to change)
// ---------------------------------------------------------------------------

export { ACTION_TAG_IDS, ensureActionTags, actionFromLiveTagIds } from "./tagDefs.js";
export {
  attachTagByThreadListener,
  cleanupTagByThreadListener,
  attachThreadTagWatchers,
  cleanupThreadTagWatchers,
  retagAllInboxesForTagByThreadToggle,
  recomputeThreadForInboxMessage,
} from "./threadTagGroup.js";

// ---------------------------------------------------------------------------
// Action cache basics
// ---------------------------------------------------------------------------

/**
 * Get the effective action for a message from cache.
 *
 * @param {string} key - The message's unique key (from getUniqueMessageKey)
 * @param {string|null} suggestedAction - Optional suggested action (from AI) to use if no cache
 * @returns {Promise<{action: string|null, source: string}>} The effective action and its source
 */
async function getEffectiveAction(key, suggestedAction = null) {
  try {
    // Get message's own cached action
    const actionCacheKey = `action:${key}`;
    const ownCached = await idb.get(actionCacheKey);
    const ownAction = ownCached[actionCacheKey] || suggestedAction || null;

    return { action: ownAction, source: ownAction ? "own" : "none" };
  } catch (e) {
    console.error("[TMDBG Tag] getEffectiveAction error:", e);
    return { action: suggestedAction, source: "fallback" };
  }
}

/**
 * Import an action from an existing IMAP tag into IDB cache.
 * Used for cross-instance sync: if another TM instance (e.g. iOS) already tagged
 * the message, adopt the tag without LLM computation.
 * Idempotent — only writes if IDB cache is empty for this message.
 *
 * @param {browser.messages.MessageHeader|number} msgOrId - Message header or WE message ID
 * @returns {Promise<string|null>} The imported action, or null if none found / already cached
 */
export async function importActionFromImapTag(msgOrId) {
  try {
    const header = typeof msgOrId === "number"
      ? await browser.messages.get(msgOrId)
      : msgOrId;
    if (!header) return null;
    const action = actionFromLiveTagIds(header.tags);
    if (!action) return null;
    const uniqueKey = await getUniqueMessageKey(header.id);
    if (!uniqueKey) return null;
    const cacheKey = `action:${uniqueKey}`;
    const metaKey = `action:ts:${uniqueKey}`;
    const existing = await idb.get(cacheKey);
    if (existing[cacheKey]) return existing[cacheKey]; // already cached
    await idb.set({ [cacheKey]: action, [metaKey]: { ts: Date.now() } });
    console.log(`[TMDBG Tag] importActionFromImapTag: imported action="${action}" for weId=${header.id} uniqueKey=${uniqueKey}`);
    return action;
  } catch (e) {
    console.log(`[TMDBG Tag] importActionFromImapTag failed: ${e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Folder / message query infrastructure
// (exported for threadTagGroup.js to import)
// ---------------------------------------------------------------------------

// Cache inbox folder resolution per account to avoid repeated folder walks.
let _inboxFolderByAccountId = new Map(); // accountId -> MailFolder

export async function findInboxFolderForAccount(accountId) {
  try {
    try {
      const cached = _inboxFolderByAccountId.get(accountId);
      if (cached && cached.id) return cached;
    } catch (_) {}

    const accounts = await browser.accounts.list();
    const account = accounts.find(acc => acc.id === accountId);
    if (!account?.rootFolder) return null;
    const subFolders = await browser.folders.getSubFolders(account.rootFolder.id, true);
    const allFolders = [account.rootFolder, ...subFolders];
    const inbox = allFolders.find(f => isInboxFolder(f)) || null;
    if (inbox && inbox.id) {
      try { _inboxFolderByAccountId.set(accountId, inbox); } catch (_) {}
    }
    return inbox;
  } catch (e) {
    console.log(`[TMDBG Tag] Failed to find inbox for account ${accountId}: ${e}`);
    return null;
  }
}

function _normalizeHeaderMessageId(v) {
  try { return String(v || "").replace(/[<>]/g, "").trim(); } catch (_) { return ""; }
}

export async function getConversationForWeMsgId(weMsgId) {
  const maxMessages = SETTINGS?.actionTagging?.threadEnumeration?.maxThreadMessages;
  if (!browser.glodaSearch || !browser.glodaSearch.getConversationMessages) {
    console.log("[TMDBG Tag] glodaSearch.getConversationMessages not available (cannot aggregate thread tags).");
    return { ok: false, error: "gloda-unavailable", conversationId: "", headerMessageIds: [] };
  }
  try {
    const res = await browser.glodaSearch.getConversationMessages(weMsgId, { maxMessages });
    const ok = !!res?.success;
    const conversationId = String(res?.conversationId || "");
    const headerMessageIds = (res?.messages || [])
      .map((m) => _normalizeHeaderMessageId(m?.headerMessageId || ""))
      .filter(Boolean);
    return { ok, error: res?.error || "", conversationId, headerMessageIds };
  } catch (e) {
    return { ok: false, error: String(e), conversationId: "", headerMessageIds: [] };
  }
}

export async function getInboxWeIdsForConversation(accountId, headerMessageIds) {
  try {
    const inbox = await findInboxFolderForAccount(accountId);
    if (!inbox?.id) return [];
    const mids = Array.isArray(headerMessageIds) ? headerMessageIds.filter(Boolean) : [];
    const out = [];
    for (const mid of mids) {
      try {
        let page = await browser.messages.query({ folderId: [inbox.id], headerMessageId: mid });
        if (page?.messages && Array.isArray(page.messages)) out.push(...page.messages);
        let contId = page?.id || null;
        while (contId) {
          const next = await browser.messages.continueList(contId);
          if (next?.messages && Array.isArray(next.messages)) out.push(...next.messages);
          contId = next?.id || null;
        }
      } catch (eQ) {
        console.log(`[TMDBG Tag] inbox query failed accountId=${accountId} headerMessageId=${mid}: ${eQ}`);
      }
    }
    return Array.from(new Set(out.map((m) => Number(m?.id || 0)).filter((n) => !!n)));
  } catch (e) {
    console.log(`[TMDBG Tag] getInboxWeIdsForConversation failed accountId=${accountId}: ${e}`);
    return [];
  }
}

async function _getInboxWeIdsForHeaderMessageId(accountId, headerMessageId) {
  try {
    const inbox = await findInboxFolderForAccount(accountId);
    if (!inbox?.id) return [];
    const mid = _normalizeHeaderMessageId(headerMessageId);
    if (!mid) return [];

    const out = [];
    let page = await browser.messages.query({ folderId: [inbox.id], headerMessageId: mid });
    if (page?.messages && Array.isArray(page.messages)) out.push(...page.messages);
    let contId = page?.id || null;
    while (contId) {
      const next = await browser.messages.continueList(contId);
      if (next?.messages && Array.isArray(next.messages)) out.push(...next.messages);
      contId = next?.id || null;
    }
    return Array.from(new Set(out.map((m) => Number(m?.id || 0)).filter((n) => !!n)));
  } catch (e) {
    console.log(`[TMDBG Tag] _getInboxWeIdsForHeaderMessageId failed: ${e}`);
    return [];
  }
}

async function _getCrossFolderCopyWeIdsForHeaderMessageId(accountId, headerMessageId) {
  try {
    const cfg = SETTINGS?.actionTagging?.crossFolderTagSync || null;
    if (!cfg || cfg.enabled !== true) return [];

    const mid = _normalizeHeaderMessageId(headerMessageId);
    if (!accountId || !mid) return [];

    const allowListRaw = Array.isArray(cfg.specialUseAllowList) ? cfg.specialUseAllowList : [];
    const allowList = allowListRaw.map((s) => String(s || "").toLowerCase().trim()).filter(Boolean);
    const maxFolders = Number(cfg.maxFolders);
    const maxMatchesToUpdate = Number(cfg.maxMatchesToUpdate);
    if (!Number.isFinite(maxFolders) || maxFolders < 1) return [];

    const folders = await getAllFoldersForAccount(accountId);
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
    if (folderIds.length === 0) return [];

    const out = [];
    let page = await browser.messages.query({ folderId: folderIds, headerMessageId: mid });
    if (page?.messages && Array.isArray(page.messages)) out.push(...page.messages);
    let contId = page?.id || null;
    while (contId) {
      const next = await browser.messages.continueList(contId);
      if (next?.messages && Array.isArray(next.messages)) out.push(...next.messages);
      contId = next?.id || null;
    }

    const ids = [];
    for (const m of out) {
      try {
        if (Number.isFinite(maxMatchesToUpdate) && maxMatchesToUpdate > 0 && ids.length >= maxMatchesToUpdate) break;
        const id = Number(m?.id || 0);
        if (!id) continue;
        ids.push(id);
      } catch (_) {}
    }
    return Array.from(new Set(ids));
  } catch (e) {
    console.log(`[TMDBG Tag] _getCrossFolderCopyWeIdsForHeaderMessageId failed: ${e}`);
    return [];
  }
}

async function _debugProbeCopiesForHeaderMessageId(accountId, headerMessageId, label = "") {
  try {
    const cfg = SETTINGS?.actionTagging?.debugCrossFolderProbe || null;
    if (!cfg || cfg.enabled !== true) return;

    const mid = _normalizeHeaderMessageId(headerMessageId);
    if (!accountId || !mid) return;

    const allowListRaw = Array.isArray(cfg.specialUseAllowList) ? cfg.specialUseAllowList : [];
    const allowList = allowListRaw.map((s) => String(s || "").toLowerCase().trim()).filter(Boolean);
    const maxFolders = Number(cfg.maxFolders);
    const maxMatchesToLog = Number(cfg.maxMatchesToLog);

    if (!Number.isFinite(maxFolders) || maxFolders < 1) return;

    // Enumerate folders using manual traversal.
    // IMPORTANT: recursive folder enumeration is not reliable for Gmail [Gmail] children.
    const folders = await getAllFoldersForAccount(accountId);

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
    if (folderIds.length === 0) return;

    let page = null;
    try {
      page = await browser.messages.query({ folderId: folderIds, headerMessageId: mid });
    } catch (eQ) {
      console.log(`[TMDBG TagProbe] query failed headerMessageId=${mid} label=${label || ""}: ${eQ}`);
      return;
    }

    const found = [];
    if (page?.messages && Array.isArray(page.messages)) found.push(...page.messages);
    try {
      let contId = page?.id || null;
      while (contId) {
        const next = await browser.messages.continueList(contId);
        if (next?.messages && Array.isArray(next.messages)) found.push(...next.messages);
        contId = next?.id || null;
      }
    } catch (_) {}

    const sample = [];
    for (const m of found) {
      try {
        if (Number.isFinite(maxMatchesToLog) && maxMatchesToLog > 0 && sample.length >= maxMatchesToLog) break;
        const weId = Number(m?.id || 0);
        const folderPath = m?.folder?.path || "";
        const folderName = m?.folder?.name || "";
        const specialUse = Array.isArray(m?.folder?.specialUse) ? m.folder.specialUse : [];
        const tags = Array.isArray(m?.tags) ? m.tags : [];
        sample.push({ weId, folderPath, folderName, specialUse, tags });
      } catch (_) {}
    }

    console.log(
      `[TMDBG TagProbe] headerMessageId=${mid} label=${label || ""} matches=${found.length} sample=${JSON.stringify(sample)}`
    );
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Cross-folder sync & action cache sync from IMAP
// (exported for threadTagGroup.js to import)
// ---------------------------------------------------------------------------

export async function applyActionTagToCrossFolderCopies(accountId, headerMessageId, effectiveAction) {
  try {
    // Only sync if the message still exists in Inbox.
    const inboxIds = await _getInboxWeIdsForHeaderMessageId(accountId, headerMessageId);
    if (!inboxIds || inboxIds.length === 0) return;

    const crossIds = await _getCrossFolderCopyWeIdsForHeaderMessageId(accountId, headerMessageId);
    if (!crossIds || crossIds.length === 0) return;

    const ignoreMs = Number(SETTINGS?.actionTagging?.selfTagUpdateIgnoreMs);
    const ignoreDelta = Number.isFinite(ignoreMs) && ignoreMs > 0 ? ignoreMs : 0;

    await ensureActionTags();
    const actionTagIds = Object.values(ACTION_TAG_IDS);
    const targetTag = effectiveAction ? ACTION_TAG_IDS[effectiveAction] : null;

    for (const weId of crossIds) {
      try {
        const hdr = await browser.messages.get(weId);
        if (!hdr) continue;
        const originalTags = Array.isArray(hdr.tags) ? [...hdr.tags] : [];
        let newTags = originalTags.filter((t) => !actionTagIds.includes(t));
        if (targetTag) newTags.push(targetTag);
        const hadNonTabMail = hasNonTabMailTags(originalTags);
        newTags = reorderTagsToPreferTabMail(newTags);
        const equal =
          originalTags.length === newTags.length && originalTags.every((t) => newTags.includes(t));
        if (equal) continue;

        if (ignoreDelta > 0) {
          selfTagUpdateIgnoreUntilByMsgId.set(weId, Date.now() + ignoreDelta);
          scheduleSelfTagIgnorePrune();
        }
        await browser.messages.update(weId, { tags: newTags });
        if (hadNonTabMail) {
          console.log(
            `[TMDBG Tag] Reordered tags to prefer TabMail action tag first (crossFolder) weId=${weId} before=[${originalTags.join(",")}] after=[${newTags.join(",")}]`
          );
        }
        console.log(`[TMDBG Tag] crossFolderTagSync updated weId=${weId} headerMessageId=${_normalizeHeaderMessageId(headerMessageId)} action=${effectiveAction || ""}`);
      } catch (eOne) {
        console.log(`[TMDBG Tag] crossFolderTagSync failed weId=${weId}: ${eOne}`);
      }
    }
  } catch (e) {
    console.log(`[TMDBG Tag] applyActionTagToCrossFolderCopies failed: ${e}`);
  }
}

export async function syncActionCacheFromMessageTagsToInboxCopies(liveHeader) {
  try {
    const accountId = liveHeader?.folder?.accountId || "";
    const headerMessageId = liveHeader?.headerMessageId || "";
    if (!accountId || !headerMessageId) return;

    const action = actionFromLiveTagIds(liveHeader?.tags);
    const inboxWeIds = await _getInboxWeIdsForHeaderMessageId(accountId, headerMessageId);
    if (!inboxWeIds || inboxWeIds.length === 0) return;

    const tsNow = Date.now();
    for (const weId of inboxWeIds) {
      try {
        const uniqueKey = await getUniqueMessageKey(weId);
        if (!uniqueKey) continue;
        const cacheKey = `action:${uniqueKey}`;
        const metaKey = `action:ts:${uniqueKey}`;

        // Check if there's already a cached action.
        // - If cached action matches the IMAP tag: skip (idempotent, preserves original action
        //   when effective thread tags are applied by this instance).
        // - If cached action differs from the IMAP tag: an external source (e.g., another TM
        //   instance or user manual override on iOS) changed it — update cache to stay in sync.
        // - If no cached action: import from IMAP tag (first sync / cross-instance adoption).
        const existingCache = await idb.get(cacheKey);
        if (existingCache && existingCache[cacheKey]) {
          if (existingCache[cacheKey] === action) {
            if (isDebugTagRaceEnabled()) {
              console.log(`[TMDBG TagRace] syncActionCacheFromMessageTagsToInboxCopies skip (already cached, matches): weId=${weId} existing=${existingCache[cacheKey]}`);
            }
            continue;
          }
          // IMAP tag differs from cached action — external change, update cache
          if (action) {
            console.log(`[TMDBG Tag] External tag change detected: updating cache "${existingCache[cacheKey]}" -> "${action}" for weId=${weId} uniqueKey=${uniqueKey}`);
          }
        }

        if (action) {
          await idb.set({ [cacheKey]: action, [metaKey]: { ts: tsNow } }, { kind: "action-sync" });
          console.log(`[TMDBG Tag] Synced action cache from tags: inboxWeId=${weId} action=${action} uniqueKey=${uniqueKey}`);
        } else {
          await idb.remove([cacheKey, metaKey]);
          console.log(`[TMDBG Tag] Cleared action cache from tags: inboxWeId=${weId} (no tm_* tag) uniqueKey=${uniqueKey}`);
        }
      } catch (eOne) {
        console.log(`[TMDBG Tag] Failed syncing action cache for inboxWeId=${weId}: ${eOne}`);
      }
    }

    // Optional debug probe: log other folder copies to see where the lag is.
    await _debugProbeCopiesForHeaderMessageId(accountId, headerMessageId, "onUpdated-syncActionCache");
  } catch (e) {
    console.log(`[TMDBG Tag] syncActionCacheFromMessageTagsToInboxCopies failed: ${e}`);
  }
}

export async function readCachedActionForWeId(weMsgId) {
  try {
    const uniqueKey = await getUniqueMessageKey(weMsgId);
    if (!uniqueKey) return null;
    const cacheKey = `action:${uniqueKey}`;
    const kv = await idb.get(cacheKey);
    const action = kv?.[cacheKey] || null;
    return action ? String(action) : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main tagging entry points
// ---------------------------------------------------------------------------

/**
 * Apply action tags to messages based on the action map.
 * @param {Array} messages - Array of message header objects
 * @param {Object} actionMap - Map of message keys to actions
 */
export async function applyActionTags(messages, actionMap) {
  // NOTE: In message-grouping mode, we want the *thread effective tag* to be the single UI truth.
  // Writing per-message tags (based on each message's cached action) will "fight" the effective tag
  // whenever a thread contains mixed actions (e.g., one msg=archive, another msg=reply).
  //
  // So: when grouping is enabled, we skip per-message tag writes and only do thread aggregation
  // + effective tag enforcement in the post-step below.
  const tagByThreadEnabled = await getTagByThreadEnabled();

  await ensureActionTags();
  const actionTagIds = Object.values(ACTION_TAG_IDS);

  const updates = messages.map(async (msg) => {
    try {
      if (tagByThreadEnabled) {
        if (isDebugTagRaceEnabled()) {
          try {
            const id = msg?.id;
            const key = id ? await getUniqueMessageKey(id) : "";
            console.log(
              `[TMDBG TagRace] applyActionTags skip per-message tag write (tagByThreadEnabled) id=${id} uniqueKey=${key} existingTags=[${(Array.isArray(msg?.tags) ? msg.tags : []).join(",")}]`
            );
          } catch (_) {}
        }
        return;
      }

      // Inbox-only guard: TabMail action tags are inbox-scoped (triage UI).
      // If something calls applyActionTags on a non-inbox message, log loudly and skip.
      try {
        const folder = msg?.folder || null;
        const ok = folder && isInboxFolder(folder);
        if (!ok) {
          console.log(
            `[TMDBG Tag] applyActionTags skip (not inbox): id=${msg?.id} folderName=${folder?.name || ""} folderType=${folder?.type || ""} folderPath=${folder?.path || ""}`
          );
          return;
        }
      } catch (eGate) {
        console.log(`[TMDBG Tag] applyActionTags inbox gate check failed id=${msg?.id}: ${eGate}`);
        return;
      }

      // Keep WE id cache warm to avoid future expensive lookups.
      try { indexHeader(msg); } catch(_) {}
      const key = await getUniqueMessageKey(msg.id);
      const action = actionMap[key];
      // Original tags (clone to avoid mutation side-effects)
      const originalTags = msg.tags ? [...msg.tags] : [];
      let newTags = originalTags.filter(t => !actionTagIds.includes(t));

      // Get effective action from cache (uses cached action or suggested action as fallback).
      const { action: effectiveAction, source: effectiveSource } = await getEffectiveAction(key, action);
      const targetAction = effectiveAction;

      const targetTag = targetAction ? ACTION_TAG_IDS[targetAction] : null;
      if (targetTag) {
        newTags.push(targetTag);
      }
      const hadNonTabMail = hasNonTabMailTags(originalTags);
      newTags = reorderTagsToPreferTabMail(newTags);

      // If tag list unchanged, skip update.
      // Always apply tags even if unchanged — idempotent and ensures Gmail folder sync fires.

      if (isDebugTagRaceEnabled()) {
        console.log(
          `[TMDBG TagRace] applyActionTags messages.update id=${msg.id} uniqueKey=${key} suggestedAction=${action || ""} effectiveAction=${targetAction || ""} effectiveSource=${effectiveSource || ""} before=[${originalTags.join(",")}] after=[${newTags.join(",")}]`
        );
      }

      // Apply tag with verification and retry
      const maxRetries = SETTINGS?.actionTagging?.tagUpdateRetries ?? 2;
      const retryDelayMs = SETTINGS?.actionTagging?.tagUpdateRetryDelayMs ?? 200;
      let tagApplied = false;

      for (let attempt = 0; attempt <= maxRetries && !tagApplied; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
            console.log(`[TMDBG Tag] Retry attempt ${attempt}/${maxRetries} for message ${msg.id}`);
          }

          await browser.messages.update(msg.id, { tags: newTags });

          // Verify the tag was actually applied
          const verifiedHdr = await browser.messages.get(msg.id);
          const verifiedTags = Array.isArray(verifiedHdr?.tags) ? verifiedHdr.tags : [];
          const targetTagApplied = targetTag ? verifiedTags.includes(targetTag) : true;

          if (targetTagApplied) {
            tagApplied = true;
            if (attempt > 0) {
              console.log(`[TMDBG Tag] Tag verified on retry ${attempt} for message ${msg.id}`);
            }
          } else {
            console.log(
              `[TMDBG Tag] Tag verification failed (attempt ${attempt}/${maxRetries}) for message ${msg.id}: expected=${targetTag || "(none)"} actual=[${verifiedTags.join(",")}]`
            );
          }
        } catch (updateErr) {
          console.log(`[TMDBG Tag] messages.update failed (attempt ${attempt}/${maxRetries}) for message ${msg.id}: ${updateErr}`);
        }
      }

      if (!tagApplied) {
        console.log(`[TMDBG Tag] FAILED to apply tag after ${maxRetries + 1} attempts for message ${msg.id}: targetTag=${targetTag || "(none)"}`);
      }

      // Gmail folder-based label sync (fire-and-forget)
      if (tagApplied && msg.folder?.accountId) {
        syncGmailTagFolder(msg.id, msg.folder.accountId, targetTag).catch((e) => {
          console.log(`[GMailTag] fire-and-forget failed (applyActionTags): ${e}`);
        });
      }

      if (hadNonTabMail) {
        console.log(
          `[TMDBG Tag] Reordered tags to prefer TabMail action tag first (applyActionTags) weId=${msg.id} before=[${originalTags.join(",")}] after=[${newTags.join(",")}]`
        );
      }
    } catch (e) {
      console.log(`[TMDBG Tag] Failed to update tags for message ${msg.id}: ${e}`);
    }
  });

  await Promise.all(updates);

  // Always trigger sort refresh - tagSort's delayed mechanism will handle:
  // 1. Debouncing/coalescing multiple triggers
  // 2. Checking if sorting is actually needed when the delay expires
  triggerSortRefresh();

  // Thread aggregation + (optional) effective tag application.
  // - Always store per-thread tag aggregates in IDB (Inbox-only guard inside helper).
  // - If message grouping is enabled, also apply the max-priority action tag to ALL messages in the thread.
  try {
    if (isDebugTagRaceEnabled()) {
      console.log(
        `[TMDBG TagRace] applyActionTags post-step threadAggregation tagByThreadEnabled=${tagByThreadEnabled} seedIds=[${(messages || []).map(m => m?.id).filter(Boolean).join(",")}]`
      );
    }
    for (const m of messages || []) {
      const weId = m?.id;
      if (!Number.isFinite(weId)) continue;

      // Always compute/store the thread aggregate for inbox threads.
      const threadResult = await computeAndStoreThreadTagList(weId);

      // If enabled, enforce "effective tag" across the thread.
      // Pass pre-computed result to avoid redundant computation.
      if (tagByThreadEnabled && threadResult.ok) {
        await updateThreadEffectiveTagsIfNeeded(weId, threadResult, "applyActionTags-post");
      }
    }
  } catch (e) {
    console.log(`[TMDBG Tag] Thread tag aggregation post-applyActionTags failed: ${e}`);
  }
}

/**
 * Priority tagging for user actions (read status changes, manual actions)
 * @param {number} weId - The message WebExtension ID to tag
 * @param {string} action - The action to apply ("archive", "delete", "reply", "none")
 */
export async function applyPriorityTag(weId, action) {
  try {
    const header = await browser.messages.get(weId);
    if (!header) {
      // log(`[TMDBG Tag] Could not find header for message ${weId}`);
      return;
    }
    // Inbox-only: do not apply TabMail action tags outside inbox.
    try {
      const folder = header?.folder || null;
      const ok = folder && isInboxFolder(folder);
      if (!ok) {
        console.log(
          `[TMDBG Tag] applyPriorityTag skip (not inbox): id=${weId} action=${action} folderName=${folder?.name || ""} folderType=${folder?.type || ""} folderPath=${folder?.path || ""}`
        );
        return;
      }
    } catch (eGate) {
      console.log(`[TMDBG Tag] applyPriorityTag inbox gate check failed id=${weId}: ${eGate}`);
      return;
    }
    try {
      const beforeTags = Array.isArray(header.tags) ? header.tags : [];
      // log(`[TMDBG Tag] priority pre-check id=${weId} tags=[${beforeTags.join(',')}] target=${action}`);
    } catch (_) {}

    // Update the action cache first to prevent overwriting on subsequent scans
    const messageKey = await getUniqueMessageKey(weId);
    if (messageKey) {
      const cacheKey = `action:${messageKey}`;
      await idb.set({ [cacheKey]: action });
    }

    // Apply the tag to the message (handles "none" by applying the tm_none tag)
    await applyActionTags([header], { [messageKey]: action });
    // log(`[TMDBG Tag] Applied priority tag ${action} to message ${weId}`);

    // Maintain per-thread aggregate (and effective tag if grouping enabled).
    try {
      const threadResult = await computeAndStoreThreadTagList(weId);
      const tagByThreadEnabled = await getTagByThreadEnabled();
      if (tagByThreadEnabled && threadResult.ok) {
        await updateThreadEffectiveTagsIfNeeded(weId, threadResult, "applyPriorityTag");
      }
    } catch (e) {
      console.log(`[TMDBG Tag] Thread tag update after applyPriorityTag failed: ${e}`);
    }

    // TODO: Future enhancement - Use AI to automatically update user_action.md with new rules
    // based on manual tagging patterns. This would help improve the AI's action classification
    // by learning from user corrections and preferences.
  } catch (e) {
    // log(`[TMDBG Tag] Failed to apply priority tag to message ${weId}: ${e}`);
  }
}

/**
 * Directly set the cached action for a message using its unique key (header Message-Id).
 * This avoids needing the numeric Thunderbird message id, which can change on moves.
 * @param {string} uniqueKey - The unique message key (header Message-Id stripped of < >, or compound key).
 * @param {string} action - The action to cache ("archive", "delete", "reply", "none").
 */
export async function setActionCacheByUniqueKey(uniqueKey, action) {
  try {
    if (!uniqueKey) return;
    const cacheKey = `action:${uniqueKey}`;
    await idb.set({ [cacheKey]: action });
    // log(`[TMDBG Tag] Cached action '${action}' by unique key ${uniqueKey}`);
  } catch (e) {
    // log(`[TMDBG Tag] Failed to cache action by unique key ${uniqueKey}: ${e}`);
  }
}

/**
 * Checks if a message (identified by uniqueKey) is still in inbox.
 * Uses existing inbox folder lookup and query logic.
 * uniqueKey format: "accountId:folderPath:headerMessageId"
 * @param {string} uniqueKey - The unique message key
 * @returns {Promise<boolean>} True if message exists in inbox, false otherwise
 */
export async function isMessageInInboxByUniqueKey(uniqueKey) {
  try {
    if (!uniqueKey || typeof uniqueKey !== "string") return false;

    // Parse uniqueKey: "accountId:folderPath:headerMessageId"
    const parts = uniqueKey.split(":");
    if (parts.length < 3) return false;

    const accountId = parts[0];
    const headerMessageId = parts.slice(2).join(":"); // Handle headerMessageId that might contain colons

    if (!accountId || !headerMessageId) return false;

    // Use existing helper to query inbox for this headerMessageId
    const weIds = await _getInboxWeIdsForHeaderMessageId(accountId, headerMessageId);
    return weIds.length > 0;
  } catch (e) {
    console.log(`[TMDBG Tag] isMessageInInboxByUniqueKey failed for uniqueKey=${uniqueKey}: ${e}`);
    return false;
  }
}
