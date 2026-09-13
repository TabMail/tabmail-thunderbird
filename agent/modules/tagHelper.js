/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * tagHelper.js — Action entry points + conversation helpers.
 *
 * Post Phase 0:
 *   - ADD-path tag writes (browser.messages.update({tags: [tm_*,...]}),
 *     Gmail label create/add, cross-folder tag copy sync, IMAP tag import)
 *     all removed. Action state lives in IDB only; see ./actionCache.js.
 *   - Thread aggregate computation + per-thread "effective action" decisions
 *     remain. When a thread has grouping enabled, the effective action is
 *     stored in IDB; per-message native tag writes are gone.
 *   - Inbox/conversation enumeration helpers stay — used by thread aggregation
 *     and by message-lookup code in other modules.
 */

import { setAction } from "./actionCache.js";
import { SETTINGS } from "./config.js";
import { getAllFoldersForAccount, isInboxFolder } from "./folderUtils.js";
import { getUniqueMessageKey } from "./utils.js";
import {
  ACTION_TAG_IDS,
  isDebugTagRaceEnabled,
} from "./tagDefs.js";
import {
  getTagByThreadEnabled,
  computeAndStoreThreadTagList,
  updateThreadEffectiveTagsIfNeeded,
} from "./threadTagGroup.js";

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility
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

export async function readCachedActionForWeId(weMsgId) {
  try {
    const { getActionForWeId } = await import("./actionCache.js");
    return await getActionForWeId(weMsgId);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/** Recompute thread bookkeeping; effective writes re-read canonical actions in the owner. */
export async function runThreadAggregation(messages) {
  // Thread aggregation + (optional) effective tag application.
  try {
    const tagByThreadEnabled = await getTagByThreadEnabled();
    for (const m of messages || []) {
      const weId = m?.id;
      if (!Number.isFinite(weId)) continue;

      const threadResult = await computeAndStoreThreadTagList(weId);
      if (tagByThreadEnabled && threadResult.ok) {
        await updateThreadEffectiveTagsIfNeeded(weId, threadResult, "aggregation-post");
      }
    }
  } catch (e) {
    console.log(`[TMDBG Tag] Thread tag aggregation failed: ${e}`);
  }
}

/**
 * Priority action for user actions (manual tagging, read-state changes).
 * Post Phase 0: IDB write + thread aggregate recompute. No native tag write.
 *
 * @param {number} weId
 * @param {string} action - "archive" | "delete" | "reply" | "none"
 */
export async function applyPriorityTag(weId, action) {
  try {
    const header = await browser.messages.get(weId);
    if (!header) return;

    // Inbox-only: do not classify outside inbox.
    try {
      const folder = header?.folder || null;
      const ok = folder && isInboxFolder(folder);
      if (!ok) {
        console.log(
          `[TMDBG Tag] applyPriorityTag skip (not inbox): id=${weId} action=${action} folderName=${folder?.name || ""}`
        );
        return;
      }
    } catch (eGate) {
      console.log(`[TMDBG Tag] applyPriorityTag inbox gate check failed id=${weId}: ${eGate}`);
      return;
    }

    const uniqueKey = await getUniqueMessageKey(header);
    if (!uniqueKey) return;

    // Pass the header so actionCache can write both IDB + hdr property.
    await setAction(header, action);

    // Thread aggregate + effective tag (same as the generated-action post-step).
    try {
      const threadResult = await computeAndStoreThreadTagList(weId);
      const tagByThreadEnabled = await getTagByThreadEnabled();
      if (tagByThreadEnabled && threadResult.ok) {
        await updateThreadEffectiveTagsIfNeeded(weId, threadResult, "applyPriorityTag");
      }
    } catch (e) {
      console.log(`[TMDBG Tag] Thread tag update after applyPriorityTag failed: ${e}`);
    }
  } catch (e) {
    console.log(`[TMDBG Tag] applyPriorityTag failed id=${weId}: ${e}`);
  }
}


/**
 * Check whether a message (identified by uniqueKey) is still in inbox.
 * Uniquekey format: "accountId:folderPath:headerMessageId".
 */
export async function isMessageInInboxByUniqueKey(uniqueKey) {
  try {
    if (!uniqueKey || typeof uniqueKey !== "string") return false;
    const accountBoundary = uniqueKey.indexOf(":");
    if (accountBoundary <= 0) return false;
    const accountId = uniqueKey.slice(0, accountBoundary);
    const inbox = await findInboxFolderForAccount(accountId);
    if (!inbox?.id || !inbox.path) return false;
    const inboxPrefix = `${accountId}:${inbox.path}:`;
    if (!uniqueKey.startsWith(inboxPrefix)) return false;
    const headerMessageId = uniqueKey.slice(inboxPrefix.length);
    if (!headerMessageId) return false;

    let page = await browser.messages.query({
      folderId: [inbox.id],
      headerMessageId: _normalizeHeaderMessageId(headerMessageId),
    });
    const continuationIds = new Set();
    while (page) {
      if ((page?.messages || []).length > 0) return true;
      if (!page.id) return false;
      if (continuationIds.has(page.id)
          || typeof browser.messages.continueList !== "function") return false;
      continuationIds.add(page.id);
      page = await browser.messages.continueList(page.id);
    }
    return false;
  } catch (e) {
    console.log(`[TMDBG Tag] isMessageInInboxByUniqueKey failed uniqueKey=${uniqueKey}: ${e}`);
    return false;
  }
}
