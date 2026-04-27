/**
 * threadTagGroup.js — Thread-level action aggregation + effective-action
 * application, watchers, and tag-by-thread toggle.
 *
 * Post Phase 0:
 *   - Effective action (per-thread max-priority action when tagByThread is
 *     enabled) is written to IDB via `actionCache.setAction` for every
 *     message in the thread. No native tag write, no Gmail sync.
 *   - `computeAndStoreThreadTagList` stores `threadTags:<threadKey>`
 *     aggregates — unchanged.
 *   - `attachThreadTagWatchers` retained but its body trims to thread
 *     aggregate recompute only; the cache-sync-from-server-tags branch is
 *     removed (we don't rely on server tags as a sync source anymore).
 */

import { setAction } from "./actionCache.js";
import { SETTINGS } from "./config.js";
import { isInboxFolder } from "./folderUtils.js";
import * as idb from "./idbStorage.js";
import {
  ACTION_TAG_IDS,
  maxPriorityAction,
  isDebugTagRaceEnabled,
} from "./tagDefs.js";
import {
  findInboxFolderForAccount,
  getConversationForWeMsgId,
  getInboxWeIdsForConversation,
  readCachedActionForWeId,
} from "./tagHelper.js";

// ---------------------------------------------------------------------------
// Per-thread semaphores (serialize updates for the same thread)
// ---------------------------------------------------------------------------

const _threadTagSemaphores = new Map(); // Map<threadKey, { active, queue }>

async function _acquireThreadTagSemaphore(threadKey) {
  if (!_threadTagSemaphores.has(threadKey)) {
    _threadTagSemaphores.set(threadKey, { active: false, queue: [] });
  }
  const semaphore = _threadTagSemaphores.get(threadKey);
  if (semaphore.active) {
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
    _threadTagSemaphores.delete(threadKey);
  }
}

// ---------------------------------------------------------------------------
// Tag-by-thread toggle
// ---------------------------------------------------------------------------

const THREAD_TAGS_PREFIX = "threadTags:";

let _tagByThreadEnabledCache = null;
let _tagByThreadListener = null;
let _threadTagWatchListener = null;

export async function getTagByThreadEnabled() {
  if (_tagByThreadEnabledCache !== null) return _tagByThreadEnabledCache === true;
  try {
    const defVal = SETTINGS?.actionTagging?.tagByThreadDefault === true;
    const stored = await browser.storage.local.get([
      "tagByThreadEnabled",
      "messageGroupingEnabled", // legacy key
    ]);

    if (Object.prototype.hasOwnProperty.call(stored, "tagByThreadEnabled") && stored.tagByThreadEnabled !== undefined) {
      _tagByThreadEnabledCache = stored.tagByThreadEnabled === true;
      return _tagByThreadEnabledCache;
    }

    if (Object.prototype.hasOwnProperty.call(stored, "messageGroupingEnabled") && stored.messageGroupingEnabled !== undefined) {
      const v = stored.messageGroupingEnabled === true;
      try {
        await browser.storage.local.set({ tagByThreadEnabled: v });
        await browser.storage.local.remove(["messageGroupingEnabled"]);
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
    } catch (_) {}
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
        _tagByThreadEnabledCache = newVal;
        retagAllInboxesForTagByThreadToggle(newVal).catch((e) => {
          console.log(`[TMDBG Tag] Retag on toggle failed: ${e}`);
        });
      } catch (e) {
        console.log(`[TMDBG Tag] tagByThreadEnabled onChanged handler failed: ${e}`);
      }
    };
    browser.storage.onChanged.addListener(_tagByThreadListener);
  } catch (e) {
    console.log(`[TMDBG Tag] Failed to attach tag-by-thread listener: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Retag all inboxes on toggle
// ---------------------------------------------------------------------------

export async function retagAllInboxesForTagByThreadToggle(enabled) {
  try {
    const accounts = await browser.accounts.list();
    const maxMessagesPerInbox = SETTINGS?.actionTagging?.retagOnToggle?.maxMessagesPerInbox;
    const maxThreadsPerInbox = SETTINGS?.actionTagging?.retagOnToggle?.maxThreadsPerInbox;
    const updateConcurrency = SETTINGS?.actionTagging?.retagOnToggle?.updateConcurrency;

    for (const acc of accounts) {
      const inbox = await findInboxFolderForAccount(acc.id);
      if (!inbox) continue;

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
            const { ok, threadKey, weIds, actions, allActionsReady } = await computeAndStoreThreadTagList(id);
            if (!ok || !weIds || weIds.length === 0) return;
            if (threadKey) {
              if (seenThreadKeys.has(threadKey)) return;
              seenThreadKeys.add(threadKey);
            }
            if (!allActionsReady) return;
            const effectiveAction = maxPriorityAction(actions);
            await _applyEffectiveActionToWeIds(weIds, effectiveAction);
          } else {
            await _retagThreadForGroupingDisabled(id);
          }
        });
      }

      await _runWithConcurrency(tasks, updateConcurrency);
    }
  } catch (e) {
    console.log(`[TMDBG Tag] retagAllInboxesForTagByThreadToggle failed: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Thread tag aggregation core
// ---------------------------------------------------------------------------

export async function computeAndStoreThreadTagList(weMsgId) {
  let threadKey = null;
  try {
    const seedHeader = await browser.messages.get(weMsgId);
    const accountId = seedHeader?.folder?.accountId || "";
    if (!accountId) {
      return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
    }

    const conv = await getConversationForWeMsgId(weMsgId);
    if (!conv.ok) {
      return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
    }

    const conversationId = String(conv.conversationId || "");
    if (!conversationId) {
      return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
    }

    const inbox = await findInboxFolderForAccount(accountId);
    const inboxPath = inbox?.path || "";
    if (!inbox || !inbox.id || !inboxPath) {
      return { ok: false, threadKey: null, conversationId, weIds: [], actions: [], allActionsReady: false };
    }

    threadKey = `${accountId}:${inboxPath}:glodaConv:${conversationId}`;

    await _acquireThreadTagSemaphore(threadKey);

    try {
      const weIds = await getInboxWeIdsForConversation(accountId, conv.headerMessageIds);

      if (!weIds || weIds.length === 0) {
        try {
          await idb.remove(THREAD_TAGS_PREFIX + threadKey);
        } catch (_) {}
        return { ok: true, threadKey, conversationId, weIds: [], actions: [], allActionsReady: true };
      }

      const actionsByWeId = new Map();
      let missingActionCount = 0;
      for (const id of weIds) {
        const a = await readCachedActionForWeId(id);
        actionsByWeId.set(id, a || null);
        if (!a) missingActionCount++;
      }

      const actions = [];
      for (const id of weIds) {
        const a = actionsByWeId.get(id);
        if (a) actions.push(a);
      }

      const allActionsReady = missingActionCount === 0;

      const tagIds = [];
      for (const a of actions) {
        const tid = ACTION_TAG_IDS?.[a];
        if (tid) tagIds.push(tid);
      }

      const storeKey = THREAD_TAGS_PREFIX + threadKey;

      const existing = await idb.get(storeKey);
      const existingData = existing?.[storeKey];

      if (!allActionsReady && existingData) {
        const existingActionsCount = (existingData.actions || []).length;
        if (actions.length <= existingActionsCount) {
          return {
            ok: true,
            threadKey,
            conversationId,
            weIds: existingData.weIds || weIds,
            actions: existingData.actions || actions,
            allActionsReady: existingData.allActionsReady || false,
          };
        }
      }

      if (existingData && existingData.messageActions && allActionsReady) {
        const existingMessageActions = existingData.messageActions;
        let isIdempotent = true;
        for (const [id, a] of actionsByWeId) {
          if (existingMessageActions[id] !== a) {
            isIdempotent = false;
            break;
          }
        }
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
          return { ok: true, threadKey, conversationId, weIds, actions, allActionsReady };
        }
      }

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
            messageActions,
            allActionsReady,
          },
        },
        { kind: "threadTags" }
      );
      return { ok: true, threadKey, conversationId, weIds, actions, allActionsReady };
    } finally {
      _releaseThreadTagSemaphore(threadKey);
    }
  } catch (e) {
    console.log(`[TMDBG Tag] computeAndStoreThreadTagList failed for weMsgId=${weMsgId}: ${e}`);
    if (threadKey) _releaseThreadTagSemaphore(threadKey);
    return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
  }
}

// ---------------------------------------------------------------------------
// Thread tag watchers (messages.onUpdated) — thread-aggregate recompute only
// ---------------------------------------------------------------------------

export function cleanupThreadTagWatchers() {
  try {
    if (_threadTagWatchListener && browser.messages?.onUpdated) {
      browser.messages.onUpdated.removeListener(_threadTagWatchListener);
      _threadTagWatchListener = null;
    }
  } catch (e) {
    console.log(`[TMDBG Tag] Failed to cleanup thread tag watcher: ${e}`);
  }
  try { _threadTagSemaphores.clear(); } catch (_) {}
}

export function attachThreadTagWatchers() {
  cleanupThreadTagWatchers();
  try {
    if (!browser.messages?.onUpdated) return;

    // Post Phase 0: we no longer sync IDB from server-side tag changes.
    // Listener exists only to keep the thread aggregate fresh when native
    // tag state changes (e.g. user manually adds/removes a legacy tm_* via
    // TB UI). Aggregate uses the IDB actions we wrote, not the server tags —
    // so the listener is mostly a no-op; retained in case other code paths
    // still surface action-level changes via onUpdated.
    _threadTagWatchListener = (...args) => {
      (async () => {
        try {
          const a0 = args?.[0] ?? null;
          const a1 = args?.[1] ?? null;
          const changedProps = a1 && typeof a1 === "object" ? a1 : null;
          if (!changedProps || !("tags" in changedProps)) return;

          const id = typeof a0 === "number" ? a0 : Number(a0?.id || 0);
          if (!id) return;

          const threadResult = await computeAndStoreThreadTagList(id);
          const tagByThreadEnabled = await getTagByThreadEnabled();
          if (tagByThreadEnabled && threadResult.ok) {
            await updateThreadEffectiveTagsIfNeeded(id, threadResult, "onUpdated-tags");
          }
        } catch (e) {
          console.log(`[TMDBG Tag] thread tag watcher handler error: ${e}`);
        }
      })();
    };

    browser.messages.onUpdated.addListener(_threadTagWatchListener);
  } catch (e) {
    console.log(`[TMDBG Tag] Failed to attach thread tag watcher: ${e}`);
  }
}

export async function recomputeThreadForInboxMessage(weMsgId, reason = "") {
  try {
    const id = Number(weMsgId || 0);
    if (!id) return;
    const threadResult = await computeAndStoreThreadTagList(id);
    const tagByThreadEnabled = await getTagByThreadEnabled();
    if (tagByThreadEnabled && threadResult.ok) {
      await updateThreadEffectiveTagsIfNeeded(id, threadResult, reason);
    }
  } catch (e) {
    console.log(`[TMDBG Tag] recomputeThreadForInboxMessage failed id=${weMsgId}: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Apply effective action to thread messages (IDB-only post Phase 0)
// ---------------------------------------------------------------------------

async function _applyEffectiveActionToWeIds(weIds, effectiveAction) {
  if (!effectiveAction) return;

  const writes = (weIds || []).map(async (id) => {
    try {
      const hdr = await browser.messages.get(id);
      if (!hdr || !hdr.id) return;
      if (!hdr.folder || !isInboxFolder(hdr.folder)) return;
      await setAction(hdr, effectiveAction);
    } catch (_) {}
  });

  await Promise.all(writes);
}

/**
 * Apply the effective (max-priority) action to all messages in a thread.
 * Only applies if ALL messages have cached actions (allActionsReady).
 */
export async function updateThreadEffectiveTagsIfNeeded(weMsgId, precomputed = null, reason = "") {
  try {
    let ok, weIds, actions, allActionsReady;
    if (precomputed && precomputed.ok !== undefined) {
      ok = precomputed.ok;
      weIds = precomputed.weIds;
      actions = precomputed.actions;
      allActionsReady = precomputed.allActionsReady;
    } else {
      const computed = await computeAndStoreThreadTagList(weMsgId);
      ok = computed.ok;
      weIds = computed.weIds;
      actions = computed.actions;
      allActionsReady = computed.allActionsReady;
    }

    if (!ok || !weIds || weIds.length === 0) return;

    const tagByThreadEnabled = await getTagByThreadEnabled();
    if (!tagByThreadEnabled) return;

    if (!allActionsReady) {
      if (isDebugTagRaceEnabled()) {
        console.log(
          `[TMDBG TagRace] updateThreadEffectiveTagsIfNeeded skip (not all actions ready): seed=${weMsgId} reason=${reason || ""}`
        );
      }
      return;
    }

    const effectiveAction = maxPriorityAction(actions);
    await _applyEffectiveActionToWeIds(weIds, effectiveAction);
  } catch (e) {
    console.log(`[TMDBG Tag] updateThreadEffectiveTagsIfNeeded failed for weMsgId=${weMsgId}: ${e}`);
  }
}

async function _retagThreadForGroupingDisabled(weMsgId) {
  try {
    const { ok, weIds } = await computeAndStoreThreadTagList(weMsgId);
    if (!ok || !weIds || weIds.length === 0) return;

    // When grouping is disabled, per-message action cache entries already
    // hold the correct per-message actions; there's nothing to overwrite.
    // The thread aggregate has been refreshed above. Nothing more to do.
  } catch (e) {
    console.log(`[TMDBG Tag] _retagThreadForGroupingDisabled failed for seed weMsgId=${weMsgId}: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Utility: concurrency-limited task runner
// ---------------------------------------------------------------------------

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
