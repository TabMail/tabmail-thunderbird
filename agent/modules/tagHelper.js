import { SETTINGS } from "./config.js";
import { getAllFoldersForAccount, isInboxFolder } from "./folderUtils.js";
import * as idb from "./idbStorage.js";
import { isInternalSender } from "./senderFilter.js";
import { getUniqueMessageKey, indexHeader } from "./utils.js";

// Simple trigger for tagSort.refresh() - the delayed sort mechanism in tagSort
// handles debouncing, coalescing, and checking if sorting is actually needed.
// Also triggers tag coloring refresh.
function triggerSortRefresh() {
  try {
    if (browser.tagSort && browser.tagSort.refresh) {
      console.log("[TMDBG Tag] Triggering tagSort.refresh() (delayed sort will handle timing)");
      browser.tagSort.refresh();
    } else {
      console.log("[TMDBG Tag] tagSort API not available.");
    }
  } catch (e) {
    console.error("[TMDBG Tag] Error triggering tagSort.refresh():", e);
  }
  // Tag coloring experiment deprecated - native TB colors used instead
  // TM tag sorting still works correctly via tagSort.refresh()
}

function _isDebugTagRaceEnabled() {
  return SETTINGS?.actionTagging?.debugTagRace?.enabled === true;
}

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

// ---------------------------------------------------------------------------
// Thread tag aggregation + effective tag logic (Inbox only)
// ---------------------------------------------------------------------------

const THREAD_TAGS_PREFIX = "threadTags:"; // idb key prefix for per-thread tag aggregate

// Cache inbox folder resolution per account to avoid repeated folder walks.
let _inboxFolderByAccountId = new Map(); // accountId -> MailFolder

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

let _tagByThreadEnabledCache = null;
let _tagByThreadListener = null;

let _threadTagWatchListener = null;
let _selfTagUpdateIgnoreUntilByMsgId = new Map(); // msgId -> ts

// Per-threadKey semaphores to serialize updates to the same thread
// Each write may update different message actions, so we queue rather than skip
const _threadTagSemaphores = new Map(); // Map<threadKey, { active: boolean, queue: Function[] }>

async function _acquireThreadTagSemaphore(threadKey) {
  if (!_threadTagSemaphores.has(threadKey)) {
    _threadTagSemaphores.set(threadKey, { active: false, queue: [] });
  }
  const semaphore = _threadTagSemaphores.get(threadKey);
  if (semaphore.active) {
    // Already active, queue this request
    await new Promise((resolve) => semaphore.queue.push(resolve));
    return;
  }
  semaphore.active = true;
}

function _releaseThreadTagSemaphore(threadKey) {
  const semaphore = _threadTagSemaphores.get(threadKey);
  if (!semaphore) return;
  if (semaphore.queue.length > 0) {
    const next = semaphore.queue.shift();
    next();
  } else {
    semaphore.active = false;
    // Clean up empty semaphores to prevent memory leaks
    _threadTagSemaphores.delete(threadKey);
  }
}

function _getActionPriorityMap() {
  return SETTINGS?.actionTagging?.actionPriority || {};
}

function _priorityForAction(action) {
  try {
    const p = _getActionPriorityMap()[action];
    return Number.isFinite(p) ? p : -1;
  } catch (_) {
    return -1;
  }
}

function _maxPriorityAction(actions) {
  try {
    const list = Array.isArray(actions) ? actions.filter(Boolean).map(String) : [];
    let best = null;
    let bestP = -1;
    for (const a of list) {
      const p = _priorityForAction(a);
      if (p > bestP) {
        bestP = p;
        best = a;
      }
    }
    return best;
  } catch (_) {
    return null;
  }
}

function _actionFromLiveTagIds(tags) {
  try {
    const list = Array.isArray(tags) ? tags : [];
    // Reverse lookup: tm_* tag id -> action name
    const candidates = [];
    for (const [action, tagId] of Object.entries(ACTION_TAG_IDS || {})) {
      if (list.includes(tagId)) candidates.push(action);
    }
    if (candidates.length === 0) return null;
    return _maxPriorityAction(candidates);
  } catch (_) {
    return null;
  }
}

async function _getTagByThreadEnabled() {
  if (_tagByThreadEnabledCache !== null) return _tagByThreadEnabledCache === true;
  try {
    const defVal = SETTINGS?.actionTagging?.tagByThreadDefault === true;
    const stored = await browser.storage.local.get([
      "tagByThreadEnabled",
      "messageGroupingEnabled", // legacy key (migration)
    ]);

    // Prefer new key
    if (Object.prototype.hasOwnProperty.call(stored, "tagByThreadEnabled") && stored.tagByThreadEnabled !== undefined) {
      _tagByThreadEnabledCache = stored.tagByThreadEnabled === true;
      return _tagByThreadEnabledCache;
    }

    // One-time migration from legacy key
    if (Object.prototype.hasOwnProperty.call(stored, "messageGroupingEnabled") && stored.messageGroupingEnabled !== undefined) {
      const v = stored.messageGroupingEnabled === true;
      try {
        await browser.storage.local.set({ tagByThreadEnabled: v });
        await browser.storage.local.remove(["messageGroupingEnabled"]);
        console.log(`[TMDBG Tag] Migrated messageGroupingEnabled -> tagByThreadEnabled (${v})`);
      } catch (_) {}
      _tagByThreadEnabledCache = v;
      return _tagByThreadEnabledCache;
    }

    _tagByThreadEnabledCache = defVal;
    return _tagByThreadEnabledCache;
  } catch (e) {
    console.log(`[TMDBG Tag] Failed to read tagByThreadEnabled from storage: ${e}`);
    _tagByThreadEnabledCache = SETTINGS?.actionTagging?.tagByThreadDefault === true;
    return _tagByThreadEnabledCache;
  }
}

export function cleanupTagByThreadListener() {
  if (_tagByThreadListener) {
    try {
      browser.storage.onChanged.removeListener(_tagByThreadListener);
      _tagByThreadListener = null;
      console.log("[TMDBG Tag] Tag by thread storage listener cleaned up");
    } catch (e) {
      console.log(`[TMDBG Tag] Failed to remove tag-by-thread listener: ${e}`);
    }
  }
}

// Forward-declare to allow listener to call it.
export async function retagAllInboxesForTagByThreadToggle(enabled) {
  try {
    console.log(`[TMDBG Tag] Retagging all inboxes due to tagByThreadEnabled toggle -> ${enabled}`);

    const accounts = await browser.accounts.list();
    const maxMessagesPerInbox = SETTINGS?.actionTagging?.retagOnToggle?.maxMessagesPerInbox;
    const maxThreadsPerInbox = SETTINGS?.actionTagging?.retagOnToggle?.maxThreadsPerInbox;
    const updateConcurrency = SETTINGS?.actionTagging?.retagOnToggle?.updateConcurrency;

    for (const acc of accounts) {
      const inbox = await _findInboxFolderForAccount(acc.id);
      if (!inbox) continue;

      console.log(
        `[TMDBG Tag] Retag pass: account=${acc.id} inbox='${inbox.name}' path='${inbox.path}' maxMessages=${maxMessagesPerInbox} maxThreads=${maxThreadsPerInbox}`
      );

      // Gather messages up to cap.
      const headers = [];
      let page = await browser.messages.list(inbox.id);
      while (page && Array.isArray(page.messages) && page.messages.length > 0) {
        for (const m of page.messages) {
          headers.push(m);
          if (Number.isFinite(maxMessagesPerInbox) && headers.length >= maxMessagesPerInbox) break;
        }
        if (Number.isFinite(maxMessagesPerInbox) && headers.length >= maxMessagesPerInbox) break;
        if (page.id) page = await browser.messages.continueList(page.id);
        else break;
      }

      console.log(`[TMDBG Tag] Retag pass: collected inbox headers=${headers.length}`);

      // Process threads by picking seed messages and deduping by stored threadKey (gloda conversation).
      const seenThreadKeys = new Set();
      let threadsScheduled = 0;
      const tasks = [];

      for (const h of headers) {
        const id = h?.id;
        if (!Number.isFinite(id)) continue;
        if (Number.isFinite(maxThreadsPerInbox) && threadsScheduled >= maxThreadsPerInbox) break;

        threadsScheduled++;
        tasks.push(async () => {
          if (enabled) {
            // Compute thread aggregate and apply max-priority effective tag.
            const { ok, threadKey, weIds, actions, allActionsReady } = await _computeAndStoreThreadTagList(id);
            if (!ok || !weIds || weIds.length === 0) return;
            if (threadKey) {
              if (seenThreadKeys.has(threadKey)) return;
              seenThreadKeys.add(threadKey);
            }
            // Only apply effective action if all messages have cached actions
            if (!allActionsReady) {
              console.log(`[TMDBG Tag] Retag pass: skipping thread (not all actions ready) threadKey=${threadKey} weIds=${weIds.length} actions=${actions.length}`);
              return;
            }
            const effectiveAction = _maxPriorityAction(actions);
            await _applyEffectiveActionToWeIds(weIds, effectiveAction);
          } else {
            // Restore per-message tags from cache for this thread.
            await _retagThreadForGroupingDisabled(id);
          }
        });
      }

      console.log(
        `[TMDBG Tag] Retag pass: scheduling threads=${tasks.length} (updateConcurrency=${updateConcurrency})`
      );
      await _runWithConcurrency(tasks, updateConcurrency);
      console.log(`[TMDBG Tag] Retag pass complete for account=${acc.id} inbox='${inbox.name}'`);
    }
  } catch (e) {
    console.log(`[TMDBG Tag] retagAllInboxesForTagByThreadToggle failed: ${e}`);
  }
}

export function attachTagByThreadListener() {
  cleanupTagByThreadListener();
  try {
    _tagByThreadListener = (changes, area) => {
      try {
        if (area !== "local") return;
        if (!changes || !changes.tagByThreadEnabled) return;
        const newVal = changes.tagByThreadEnabled.newValue === true;
        const oldVal = changes.tagByThreadEnabled.oldValue === true;
        _tagByThreadEnabledCache = newVal;
        console.log(`[TMDBG Tag] tagByThreadEnabled changed: ${oldVal} -> ${newVal}`);

        // Fire-and-forget retag pass (storage.onChanged does not require a response).
        retagAllInboxesForTagByThreadToggle(newVal).catch((e) => {
          console.log(`[TMDBG Tag] Retag on toggle failed: ${e}`);
        });
      } catch (e) {
        console.log(`[TMDBG Tag] tagByThreadEnabled onChanged handler failed: ${e}`);
      }
    };
    browser.storage.onChanged.addListener(_tagByThreadListener);
    console.log("[TMDBG Tag] Tag by thread storage listener attached");
  } catch (e) {
    console.log(`[TMDBG Tag] Failed to attach tag-by-thread listener: ${e}`);
  }
}

async function _findInboxFolderForAccount(accountId) {
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

async function _getConversationForWeMsgId(weMsgId) {
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

async function _getInboxWeIdsForConversation(accountId, headerMessageIds) {
  try {
    const inbox = await _findInboxFolderForAccount(accountId);
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
    console.log(`[TMDBG Tag] _getInboxWeIdsForConversation failed accountId=${accountId}: ${e}`);
    return [];
  }
}

async function _getInboxWeIdsForHeaderMessageId(accountId, headerMessageId) {
  try {
    const inbox = await _findInboxFolderForAccount(accountId);
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

async function _applyActionTagToCrossFolderCopies(accountId, headerMessageId, effectiveAction) {
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
          _selfTagUpdateIgnoreUntilByMsgId.set(weId, Date.now() + ignoreDelta);
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
    console.log(`[TMDBG Tag] _applyActionTagToCrossFolderCopies failed: ${e}`);
  }
}

async function _syncActionCacheFromMessageTagsToInboxCopies(liveHeader) {
  try {
    const accountId = liveHeader?.folder?.accountId || "";
    const headerMessageId = liveHeader?.headerMessageId || "";
    if (!accountId || !headerMessageId) return;

    const action = _actionFromLiveTagIds(liveHeader?.tags);
    const inboxWeIds = await _getInboxWeIdsForHeaderMessageId(accountId, headerMessageId);
    if (!inboxWeIds || inboxWeIds.length === 0) return;

    const tsNow = Date.now();
    for (const weId of inboxWeIds) {
      try {
        const uniqueKey = await getUniqueMessageKey(weId);
        if (!uniqueKey) continue;
        const cacheKey = `action:${uniqueKey}`;
        const metaKey = `action:ts:${uniqueKey}`;

        // Check if there's already a cached action - don't overwrite if so.
        // This preserves the original agent-assigned action when effective tags are applied.
        // Only sync from TB tags for messages that DON'T have a cached action yet (e.g., IMAP sync).
        const existingCache = await idb.get(cacheKey);
        if (existingCache && existingCache[cacheKey]) {
          if (_isDebugTagRaceEnabled()) {
            console.log(`[TMDBG TagRace] _syncActionCacheFromMessageTagsToInboxCopies skip (already cached): weId=${weId} existing=${existingCache[cacheKey]} tbTag=${action || "(none)"}`);
          }
          continue;
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
    console.log(`[TMDBG Tag] _syncActionCacheFromMessageTagsToInboxCopies failed: ${e}`);
  }
}

async function _readCachedActionForWeId(weMsgId) {
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

async function _computeAndStoreThreadTagList(weMsgId) {
  let threadKey = null;
  try {
    const seedHeader = await browser.messages.get(weMsgId);
    const accountId = seedHeader?.folder?.accountId || "";
    if (!accountId) {
      return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
    }

    const conv = await _getConversationForWeMsgId(weMsgId);
    if (!conv.ok) {
      console.log(`[TMDBG Tag] Gloda conversation failed for weMsgId=${weMsgId}: ${conv.error}`);
      return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
    }

    const conversationId = String(conv.conversationId || "");
    if (!conversationId) {
      console.log(`[TMDBG Tag] Missing conversationId for weMsgId=${weMsgId}; cannot compute stable thread key`);
      return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
    }

    const inbox = await _findInboxFolderForAccount(accountId);
    const inboxPath = inbox?.path || "";
    if (!inbox || !inbox.id || !inboxPath) {
      return { ok: false, threadKey: null, conversationId, weIds: [], actions: [], allActionsReady: false };
    }

    threadKey = `${accountId}:${inboxPath}:glodaConv:${conversationId}`;

    // Acquire per-thread semaphore to serialize updates to the same thread
    await _acquireThreadTagSemaphore(threadKey);

    try {
      const weIds = await _getInboxWeIdsForConversation(accountId, conv.headerMessageIds);

      // If this conversation has no Inbox messages, remove any stale threadTags entry and stop.
      if (!weIds || weIds.length === 0) {
        try {
          const storeKey = THREAD_TAGS_PREFIX + threadKey;
          await idb.remove(storeKey);
          console.log(`[TMDBG Tag] Removed thread tag aggregate (no inbox messages): threadKey=${threadKey}`);
        } catch (_) {}
        return { ok: true, threadKey, conversationId, weIds: [], actions: [], allActionsReady: true };
      }

      // Read per-message cached actions and aggregate.
      // Store as Map<weId, action> for idempotency comparison
      const actionsByWeId = new Map();
      let missingActionCount = 0;
      for (const id of weIds) {
        const a = await _readCachedActionForWeId(id);
        actionsByWeId.set(id, a || null);
        if (!a) missingActionCount++;
      }

      // Convert to arrays for storage (include nulls for incomplete state tracking)
      const actions = [];
      for (const id of weIds) {
        const a = actionsByWeId.get(id);
        if (a) actions.push(a);
      }

      // Track if all messages have cached actions (for safe effective action application)
      const allActionsReady = missingActionCount === 0;

      // Store thread aggregate as a list of action tag IDs (tm_*) for quick inspection/debug.
      const tagIds = [];
      for (const a of actions) {
        const tid = ACTION_TAG_IDS?.[a];
        if (tid) tagIds.push(tid);
      }

      const storeKey = THREAD_TAGS_PREFIX + threadKey;

      // If not all actions are ready, check if we have MORE actions than previously stored.
      // If not, skip storing incomplete data - let a later compute with more actions store.
      const existing = await idb.get(storeKey);
      const existingData = existing?.[storeKey];
      
      if (!allActionsReady && existingData) {
        const existingActionsCount = (existingData.actions || []).length;
        if (actions.length <= existingActionsCount) {
          // We don't have more actions than before - skip storing, let later compute handle it
          if (_isDebugTagRaceEnabled()) {
            console.log(`[TMDBG TagRace] _computeAndStoreThreadTagList skip store (incomplete, no progress): threadKey=${threadKey} current=${actions.length} existing=${existingActionsCount}`);
          }
          // Return existing data so caller can use it
          return { 
            ok: true, 
            threadKey, 
            conversationId, 
            weIds: existingData.weIds || weIds, 
            actions: existingData.actions || actions, 
            allActionsReady: existingData.allActionsReady || false 
          };
        }
      }

      // Idempotency check: compare with existing stored value before writing
      // Compare per-message actions (messageActions) for true idempotency
      if (existingData && existingData.messageActions && allActionsReady) {
        const existingMessageActions = existingData.messageActions;
        let isIdempotent = true;
        // Check all current weIds have same action as stored
        for (const [id, a] of actionsByWeId) {
          if (existingMessageActions[id] !== a) {
            isIdempotent = false;
            break;
          }
        }
        // Also check no extra keys in existing that aren't in current
        if (isIdempotent) {
          const currentWeIdSet = new Set(weIds);
          for (const existingId of Object.keys(existingMessageActions)) {
            if (!currentWeIdSet.has(Number(existingId))) {
              isIdempotent = false;
              break;
            }
          }
        }
        if (isIdempotent) {
          if (_isDebugTagRaceEnabled()) {
            console.log(`[TMDBG TagRace] _computeAndStoreThreadTagList skip store (idempotent): threadKey=${threadKey}`);
          }
          return { ok: true, threadKey, conversationId, weIds, actions, allActionsReady };
        }
      }

      // Build per-message action map for storage (allows future per-message restoration)
      const messageActions = {};
      for (const [id, a] of actionsByWeId) {
        messageActions[id] = a;
      }

      await idb.set(
        {
          [storeKey]: {
            threadKey,
            conversationId,
            tagIds,
            actions,
            weIds,
            messageActions, // per-message action map for idempotent writes
            allActionsReady,
          },
        },
        { kind: "threadTags" }
      );
      console.log(
        `[TMDBG Tag] Stored thread tag aggregate: threadKey=${threadKey} conversationId=${conversationId} weIds=${weIds.length} actions=[${actions.join(",")}] allActionsReady=${allActionsReady} missing=${missingActionCount}`
      );
      return { ok: true, threadKey, conversationId, weIds, actions, allActionsReady };
    } finally {
      _releaseThreadTagSemaphore(threadKey);
    }
  } catch (e) {
    console.log(`[TMDBG Tag] _computeAndStoreThreadTagList failed for weMsgId=${weMsgId}: ${e}`);
    if (threadKey) _releaseThreadTagSemaphore(threadKey);
    return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
  }
}

export function cleanupThreadTagWatchers() {
  try {
    if (_threadTagWatchListener && browser.messages?.onUpdated) {
      browser.messages.onUpdated.removeListener(_threadTagWatchListener);
      _threadTagWatchListener = null;
      console.log("[TMDBG Tag] Thread tag watcher (messages.onUpdated) cleaned up");
    }
  } catch (e) {
    console.log(`[TMDBG Tag] Failed to cleanup thread tag watcher: ${e}`);
  }
  try { _selfTagUpdateIgnoreUntilByMsgId = new Map(); } catch (_) {}
  try { _threadTagSemaphores.clear(); } catch (_) {}
}

export function attachThreadTagWatchers() {
  cleanupThreadTagWatchers();
  try {
    if (!browser.messages?.onUpdated) {
      console.log("[TMDBG Tag] messages.onUpdated not available; thread tag watcher not attached");
      return;
    }

    _threadTagWatchListener = (...args) => {
      // IMPORTANT: do not use async handler directly.
      (async () => {
        try {
          // Expected patterns (TB): (message, changedProps, oldProps) or (id, changedProps, oldProps).
          const a0 = args?.[0] ?? null;
          const a1 = args?.[1] ?? null;
          const changedProps = a1 && typeof a1 === "object" ? a1 : null;
          if (!changedProps || !("tags" in changedProps)) {
            return;
          }

          const id = typeof a0 === "number" ? a0 : Number(a0?.id || 0);
          if (!id) return;

          const now = Date.now();
          const ignoreUntil = Number(_selfTagUpdateIgnoreUntilByMsgId.get(id) || 0);
          if (ignoreUntil && now < ignoreUntil) {
            if (_isDebugTagRaceEnabled()) {
              console.log(
                `[TMDBG TagRace] threadWatcher skip (selfIgnore active) id=${id} now=${now} ignoreUntil=${ignoreUntil}`
              );
            }
            return;
          }

          if (_isDebugTagRaceEnabled()) {
            try {
              const oldProps = args?.[2] && typeof args?.[2] === "object" ? args[2] : null;
              const oldTags = Array.isArray(oldProps?.tags) ? oldProps.tags : [];
              const newTags = Array.isArray(changedProps?.tags) ? changedProps.tags : [];
              console.log(
                `[TMDBG TagRace] threadWatcher tagsChanged id=${id} changedProps.tags=[${newTags.join(",")}] oldProps.tags=[${oldTags.join(",")}]`
              );
            } catch (_) {}
          }

          let live = null;
          try {
            live = await browser.messages.get(id);
          } catch (eGet) {
            console.log(`[TMDBG Tag] thread watcher messages.get failed id=${id}: ${eGet}`);
            return;
          }

          // Internal/self-sent messages should never populate the action cache from tags.
          // (Otherwise simply viewing/refreshing could reintroduce action:<uniqueKey> entries.)
          try {
            const internal = await isInternalSender(live);
            if (internal) {
              if (_isDebugTagRaceEnabled()) {
                try {
                  console.log(
                    `[TMDBG TagRace] threadWatcher skip tag->cache sync (internal) id=${id} author="${live?.author || ""}" subject="${live?.subject || ""}"`
                  );
                } catch (_) {}
              }
              // Still continue to keep thread aggregates fresh, but do not sync cache from tags.
            } else {
              // Sync IDB action cache from live Thunderbird tags (IMAP/server reasserts show up here).
              // We treat TB tags as the “sync signal” and keep IDB consistent for grouping logic.
              await _syncActionCacheFromMessageTagsToInboxCopies(live);
            }
          } catch (_) {
            // If internal check fails, fall back to existing behavior (sync) to avoid silent divergence.
            await _syncActionCacheFromMessageTagsToInboxCopies(live);
          }

          // Always keep the thread aggregate fresh when tags change anywhere.
          // Aggregation is Inbox-scoped internally (by querying Inbox copies via headerMessageId).
          const threadResult = await _computeAndStoreThreadTagList(id);

          // If grouping enabled, enforce effective tag across the (Inbox) thread.
          // Pass pre-computed result to avoid redundant computation.
          const tagByThreadEnabled = await _getTagByThreadEnabled();
          if (tagByThreadEnabled && threadResult.ok) {
            await _updateThreadEffectiveTagsIfNeeded(id, threadResult, "onUpdated-tags");
          }
        } catch (e) {
          console.log(`[TMDBG Tag] thread tag watcher handler error: ${e}`);
        }
      })();
    };

    browser.messages.onUpdated.addListener(_threadTagWatchListener);
    console.log("[TMDBG Tag] Thread tag watcher (messages.onUpdated) attached");
  } catch (e) {
    console.log(`[TMDBG Tag] Failed to attach thread tag watcher: ${e}`);
  }
}

export async function recomputeThreadForInboxMessage(weMsgId, reason = "") {
  try {
    const id = Number(weMsgId || 0);
    if (!id) return;
    console.log(`[TMDBG Tag] recomputeThreadForInboxMessage seed=${id} reason=${reason || ""}`);
    const threadResult = await _computeAndStoreThreadTagList(id);
    const tagByThreadEnabled = await _getTagByThreadEnabled();
    if (tagByThreadEnabled && threadResult.ok) {
      await _updateThreadEffectiveTagsIfNeeded(id, threadResult, reason);
    }
  } catch (e) {
    console.log(`[TMDBG Tag] recomputeThreadForInboxMessage failed id=${weMsgId}: ${e}`);
  }
}

async function _applyEffectiveActionToWeIds(weIds, effectiveAction) {
  await ensureActionTags();
  const actionTagIds = Object.values(ACTION_TAG_IDS);
  const ignoreMs = Number(SETTINGS?.actionTagging?.selfTagUpdateIgnoreMs);
  const ignoreDelta = Number.isFinite(ignoreMs) && ignoreMs > 0 ? ignoreMs : 0;

  // Build headers only when needed; we need folder for Inbox gate and tags for safe replace.
  const headers = await Promise.all(
    weIds.map(async (id) => {
      try {
        return await browser.messages.get(id);
      } catch (_) {
        return null;
      }
    })
  );

  const updates = headers.map(async (hdr) => {
    if (!hdr || !hdr.id) return;
    // Inbox-only enforcement
    try {
      const folder = hdr?.folder || null;
      const ok = folder && isInboxFolder(folder);
      if (!ok) return;
    } catch (_) {
      return;
    }

    const originalTags = Array.isArray(hdr.tags) ? [...hdr.tags] : [];
    let newTags = originalTags.filter((t) => !actionTagIds.includes(t));
    const targetTag = effectiveAction ? ACTION_TAG_IDS[effectiveAction] : null;
    if (targetTag) newTags.push(targetTag);
    const hadNonTabMail = hasNonTabMailTags(originalTags);
    newTags = reorderTagsToPreferTabMail(newTags);

    const equal =
      originalTags.length === newTags.length && originalTags.every((t) => newTags.includes(t));
    if (equal) return;

    // Apply tag with verification and retry
    const maxRetries = SETTINGS?.actionTagging?.tagUpdateRetries ?? 2;
    const retryDelayMs = SETTINGS?.actionTagging?.tagUpdateRetryDelayMs ?? 200;
    let tagApplied = false;

    for (let attempt = 0; attempt <= maxRetries && !tagApplied; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          console.log(`[TMDBG Tag] Retry attempt ${attempt}/${maxRetries} for effective tag on message ${hdr.id}`);
        }

        try {
          if (ignoreDelta > 0) {
            _selfTagUpdateIgnoreUntilByMsgId.set(hdr.id, Date.now() + ignoreDelta);
          }
        } catch (_) {}

        await browser.messages.update(hdr.id, { tags: newTags });

        // Verify the tag was actually applied
        const verifiedHdr = await browser.messages.get(hdr.id);
        const verifiedTags = Array.isArray(verifiedHdr?.tags) ? verifiedHdr.tags : [];
        const targetTagApplied = targetTag ? verifiedTags.includes(targetTag) : true;

        if (targetTagApplied) {
          tagApplied = true;
          if (attempt > 0) {
            console.log(`[TMDBG Tag] Effective tag verified on retry ${attempt} for message ${hdr.id}`);
          }
        } else {
          console.log(
            `[TMDBG Tag] Effective tag verification failed (attempt ${attempt}/${maxRetries}) for message ${hdr.id}: expected=${targetTag || "(none)"} actual=[${verifiedTags.join(",")}]`
          );
        }
      } catch (updateErr) {
        console.log(`[TMDBG Tag] Failed to apply effective tag (attempt ${attempt}/${maxRetries}) to message ${hdr.id}: ${updateErr}`);
      }
    }

    if (!tagApplied) {
      console.log(`[TMDBG Tag] FAILED to apply effective tag after ${maxRetries + 1} attempts for message ${hdr.id}: targetTag=${targetTag || "(none)"}`);
    }

    if (hadNonTabMail) {
      console.log(
        `[TMDBG Tag] Reordered tags to prefer TabMail action tag first (applyEffective) weId=${hdr.id} before=[${originalTags.join(",")}] after=[${newTags.join(",")}]`
      );
    }

    // Sync to cross-folder specialUse copies (e.g., All Mail) for inbox messages.
    try {
      const accountId = hdr?.folder?.accountId || "";
      const headerMessageId = hdr?.headerMessageId || "";
      if (accountId && headerMessageId) {
        await _applyActionTagToCrossFolderCopies(accountId, headerMessageId, effectiveAction);
      }
    } catch (_) {}
  });

  await Promise.all(updates);
  triggerSortRefresh();
}

/**
 * Apply the effective (max-priority) action tag to all messages in a thread.
 * Only applies if ALL messages in the thread have cached actions (allActionsReady).
 * @param {number} weMsgId - Seed message ID (only used for logging if precomputed is not provided)
 * @param {Object} [precomputed] - Pre-computed thread data from _computeAndStoreThreadTagList
 * @param {string} [reason] - Reason for the update (for logging)
 */
async function _updateThreadEffectiveTagsIfNeeded(weMsgId, precomputed = null, reason = "") {
  try {
    // Use pre-computed result if provided, otherwise compute (legacy callers)
    let ok, weIds, actions, allActionsReady;
    if (precomputed && precomputed.ok !== undefined) {
      ok = precomputed.ok;
      weIds = precomputed.weIds;
      actions = precomputed.actions;
      allActionsReady = precomputed.allActionsReady;
    } else {
      // Legacy path - compute if not provided (should be avoided)
      if (_isDebugTagRaceEnabled()) {
        console.log(`[TMDBG TagRace] _updateThreadEffectiveTagsIfNeeded computing (no precomputed): seed=${weMsgId}`);
      }
      const computed = await _computeAndStoreThreadTagList(weMsgId);
      ok = computed.ok;
      weIds = computed.weIds;
      actions = computed.actions;
      allActionsReady = computed.allActionsReady;
    }

    if (!ok || !weIds || weIds.length === 0) return;

    const tagByThreadEnabled = await _getTagByThreadEnabled();
    if (!tagByThreadEnabled) return;

    // IMPORTANT: Only apply effective action when ALL messages have cached actions.
    // This prevents overwriting correct per-message tags when some messages haven't been processed yet.
    if (!allActionsReady) {
      if (_isDebugTagRaceEnabled()) {
        console.log(
          `[TMDBG TagRace] _updateThreadEffectiveTagsIfNeeded skip (not all actions ready): seed=${weMsgId} weIds=${weIds.length} actions=[${actions.join(",")}] reason=${reason || ""}`
        );
      }
      console.log(
        `[TMDBG Tag] Thread grouping: deferring effective action (${weIds.length - actions.length}/${weIds.length} messages missing actions) seed=${weMsgId}`
      );
      return;
    }

    const effectiveAction = _maxPriorityAction(actions);
    if (_isDebugTagRaceEnabled()) {
      console.log(
        `[TMDBG TagRace] effectiveThreadTag applying effectiveAction=${effectiveAction || "(none)"} seed=${weMsgId} reason=${reason || ""} threadWeIds=${weIds.length} actions=[${actions.join(",")}]`
      );
    }
    console.log(
      `[TMDBG Tag] Thread grouping enabled: applying effectiveAction=${effectiveAction || "(none)"} to thread messages count=${weIds.length} (seed=${weMsgId})`
    );
    await _applyEffectiveActionToWeIds(weIds, effectiveAction);
  } catch (e) {
    console.log(`[TMDBG Tag] _updateThreadEffectiveTagsIfNeeded failed for weMsgId=${weMsgId}: ${e}`);
  }
}

async function _retagThreadForGroupingDisabled(weMsgId) {
  try {
    const { ok, weIds } = await _computeAndStoreThreadTagList(weMsgId);
    if (!ok || !weIds || weIds.length === 0) return;

    await ensureActionTags();
    const actionTagIds = Object.values(ACTION_TAG_IDS);

    const updates = weIds.map(async (id) => {
      try {
        const hdr = await browser.messages.get(id);
        if (!hdr) return;
        const okInbox = hdr?.folder && isInboxFolder(hdr.folder);
        if (!okInbox) return;
        const action = await _readCachedActionForWeId(id);
        const accountId = hdr?.folder?.accountId || "";
        const headerMessageId = hdr?.headerMessageId || "";
        const originalTags = Array.isArray(hdr.tags) ? [...hdr.tags] : [];
        let newTags = originalTags.filter((t) => !actionTagIds.includes(t));
        const targetTag = action ? ACTION_TAG_IDS[action] : null;
        if (targetTag) newTags.push(targetTag);
        const hadNonTabMail = hasNonTabMailTags(originalTags);
        newTags = reorderTagsToPreferTabMail(newTags);
        const equal =
          originalTags.length === newTags.length && originalTags.every((t) => newTags.includes(t));
        if (equal) return;
        try {
          const ignoreMs = Number(SETTINGS?.actionTagging?.selfTagUpdateIgnoreMs);
          if (Number.isFinite(ignoreMs) && ignoreMs > 0) {
            _selfTagUpdateIgnoreUntilByMsgId.set(hdr.id, Date.now() + ignoreMs);
          }
        } catch (_) {}
        await browser.messages.update(hdr.id, { tags: newTags });
        if (hadNonTabMail) {
          console.log(
            `[TMDBG Tag] Reordered tags to prefer TabMail action tag first (retagThread) weId=${hdr.id} before=[${originalTags.join(",")}] after=[${newTags.join(",")}]`
          );
        }

        // Also sync this per-message action tag to specialUse copies (e.g., All Mail),
        // as long as the message still exists in Inbox.
        try {
          if (accountId && headerMessageId) {
            await _applyActionTagToCrossFolderCopies(accountId, headerMessageId, action);
          }
        } catch (_) {}
      } catch (_) {}
    });

    await Promise.all(updates);
    triggerSortRefresh();
  } catch (e) {
    console.log(`[TMDBG Tag] _retagThreadForGroupingDisabled failed for seed weMsgId=${weMsgId}: ${e}`);
  }
}

async function _runWithConcurrency(tasks, concurrency) {
  const limit = Math.max(1, Number(concurrency || 1));
  const queue = Array.isArray(tasks) ? tasks.slice() : [];
  const workers = [];
  for (let i = 0; i < limit; i++) {
    workers.push(
      (async () => {
        while (queue.length) {
          const fn = queue.shift();
          try {
            await fn();
          } catch (_) {}
        }
      })()
    );
  }
  await Promise.all(workers);
}


export const ACTION_TAG_IDS = {
  delete: "tm_delete",
  archive: "tm_archive",
  reply: "tm_reply",
  none: "tm_none",
};

const ACTION_TAG_KEYS = new Set(Object.values(ACTION_TAG_IDS));

function reorderTagsToPreferTabMail(tags) {
  const list = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (list.length <= 1) return list;

  // Keep relative order of non-TabMail tags, but move TabMail action tags to the front.
  const tm = [];
  const other = [];
  for (const t of list) {
    if (ACTION_TAG_KEYS.has(t)) tm.push(t);
    else other.push(t);
  }
  // If no TabMail tag present, keep original ordering.
  if (!tm.length) return list;
  return tm.concat(other);
}

function hasNonTabMailTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  for (const t of list) {
    if (!t) continue;
    if (!ACTION_TAG_KEYS.has(t)) return true;
  }
  return false;
}

// Import tag colors from theme palette (single source of truth)
import { getTAG_COLORS } from "../../theme/palette/palette.js";

let TAG_DEFS = null;

// Lazy initialize TAG_DEFS from async palette data
async function getTagDefs() {
  if (TAG_DEFS) return TAG_DEFS;
  const TAG_COLORS = await getTAG_COLORS();
  TAG_DEFS = {
    // Tag naming:
    // - Sorting is now done via TagSort's custom DBView sort key (byCustom), so we no longer
    //   need name hacks like "zz " or numeric prefixes for ordering.
    tm_reply:   { tag: "TabMail Reply",   color: TAG_COLORS.tm_reply },
    tm_none:    { tag: "TabMail None",    color: TAG_COLORS.tm_none },
    tm_archive: { tag: "TabMail Archive", color: TAG_COLORS.tm_archive },
    tm_delete:  { tag: "TabMail Delete",  color: TAG_COLORS.tm_delete },
  };
  return TAG_DEFS;
}

let _tagsEnsured = false;

export async function ensureActionTags() {
  const TAG_DEFS = await getTagDefs();
  if (_tagsEnsured) return;
  if (!browser.messages || !browser.messages.tags || !browser.messages.tags.list) {
    // log('[TMDBG Tag] messages.tags API not available – cannot ensure action tags.');
    return;
  }
  const existing = await browser.messages.tags.list();
  for (const [id, def] of Object.entries(TAG_DEFS)) {
    const current = existing.find(t => t.key === id);

    // Create new tag if it does not exist.
    if (!current) {
      try {
        await browser.messages.tags.create(id, def.tag, def.color);
        // log(`[TMDBG Tag] Created tag ${def.tag}`);
      } catch (e) {
        // log(`[TMDBG Tag] Failed to create tag ${id}: ${e}`, 'error');
      }
      continue;
    }

    // Update tag if name or color changed.
    const currentColor = current.color || "";
    const defColor = def.color || "";
    const needsUpdate = current.tag !== def.tag || currentColor.toUpperCase() !== defColor.toUpperCase();
    if (needsUpdate) {
      try {
        await browser.messages.tags.update(id, { tag: def.tag, color: def.color });
        // log(`[TMDBG Tag] Updated tag ${id} -> '${def.tag}' ${def.color ? `(${def.color})` : '(no color)' }`);
      } catch (e) {
        // log(`[TMDBG Tag] Failed to update tag ${id}: ${e}`, 'error');
      }
    }
  }
  _tagsEnsured = true;
}

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
  const tagByThreadEnabled = await _getTagByThreadEnabled();

  await ensureActionTags();
  const actionTagIds = Object.values(ACTION_TAG_IDS);

  const updates = messages.map(async (msg) => {
    try {
      if (tagByThreadEnabled) {
        if (_isDebugTagRaceEnabled()) {
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
      const equal = originalTags.length === newTags.length &&
        originalTags.every(t => newTags.includes(t));
      if (equal) {
        return; // no-op
      }

      if (_isDebugTagRaceEnabled()) {
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
    if (_isDebugTagRaceEnabled()) {
      console.log(
        `[TMDBG TagRace] applyActionTags post-step threadAggregation tagByThreadEnabled=${tagByThreadEnabled} seedIds=[${(messages || []).map(m => m?.id).filter(Boolean).join(",")}]`
      );
    }
    for (const m of messages || []) {
      const weId = m?.id;
      if (!Number.isFinite(weId)) continue;

      // Always compute/store the thread aggregate for inbox threads.
      const threadResult = await _computeAndStoreThreadTagList(weId);

      // If enabled, enforce "effective tag" across the thread.
      // Pass pre-computed result to avoid redundant computation.
      if (tagByThreadEnabled && threadResult.ok) {
        await _updateThreadEffectiveTagsIfNeeded(weId, threadResult, "applyActionTags-post");
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
      const threadResult = await _computeAndStoreThreadTagList(weId);
      const tagByThreadEnabled = await _getTagByThreadEnabled();
      if (tagByThreadEnabled && threadResult.ok) {
        await _updateThreadEffectiveTagsIfNeeded(weId, threadResult, "applyPriorityTag");
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
