/**
 * threadTagGroup.js — Thread-level tag aggregation, effective tag application,
 * watchers, toggle management, and self-tag ignore state.
 */

import { SETTINGS } from "./config.js";
import { isInboxFolder } from "./folderUtils.js";
import * as idb from "./idbStorage.js";
import { isInternalSender } from "./senderFilter.js";
import {
  ACTION_TAG_IDS,
  ensureActionTags,
  triggerSortRefresh,
  reorderTagsToPreferTabMail,
  hasNonTabMailTags,
  maxPriorityAction,
  isDebugTagRaceEnabled,
  actionFromLiveTagIds,
} from "./tagDefs.js";
import { syncGmailTagFolder } from "./gmailLabelSync.js";
import {
  findInboxFolderForAccount,
  getConversationForWeMsgId,
  getInboxWeIdsForConversation,
  readCachedActionForWeId,
  applyActionTagToCrossFolderCopies,
  syncActionCacheFromMessageTagsToInboxCopies,
} from "./tagHelper.js";

// ---------------------------------------------------------------------------
// Self-tag ignore state (exported for cross-folder sync in tagHelper)
// ---------------------------------------------------------------------------

export let selfTagUpdateIgnoreUntilByMsgId = new Map(); // msgId -> ts
let _selfTagIgnorePruneTimer = null;

/**
 * Prune expired entries from selfTagUpdateIgnoreUntilByMsgId.
 * Entries are timestamps in the future; once expired they serve no purpose.
 * Called lazily — schedules itself on first .set(), runs once, cleans up.
 */
export function scheduleSelfTagIgnorePrune() {
  if (_selfTagIgnorePruneTimer) return; // already scheduled
  _selfTagIgnorePruneTimer = setTimeout(() => {
    _selfTagIgnorePruneTimer = null;
    try {
      const now = Date.now();
      for (const [msgId, ts] of selfTagUpdateIgnoreUntilByMsgId) {
        if (ts <= now) selfTagUpdateIgnoreUntilByMsgId.delete(msgId);
      }
    } catch (_) {}
    // Re-schedule if entries remain
    if (selfTagUpdateIgnoreUntilByMsgId.size > 0) scheduleSelfTagIgnorePrune();
  }, SETTINGS?.memoryManagement?.selfTagIgnorePruneIntervalMs || 60_000);
}

// ---------------------------------------------------------------------------
// Per-thread semaphores to serialize updates to the same thread
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tag-by-thread toggle + listeners
// ---------------------------------------------------------------------------

const THREAD_TAGS_PREFIX = "threadTags:"; // idb key prefix for per-thread tag aggregate

let _tagByThreadEnabledCache = null;
let _tagByThreadListener = null;
let _threadTagWatchListener = null;

export async function getTagByThreadEnabled() {
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

// ---------------------------------------------------------------------------
// Retag all inboxes on toggle
// ---------------------------------------------------------------------------

export async function retagAllInboxesForTagByThreadToggle(enabled) {
  try {
    console.log(`[TMDBG Tag] Retagging all inboxes due to tagByThreadEnabled toggle -> ${enabled}`);

    const accounts = await browser.accounts.list();
    const maxMessagesPerInbox = SETTINGS?.actionTagging?.retagOnToggle?.maxMessagesPerInbox;
    const maxThreadsPerInbox = SETTINGS?.actionTagging?.retagOnToggle?.maxThreadsPerInbox;
    const updateConcurrency = SETTINGS?.actionTagging?.retagOnToggle?.updateConcurrency;

    for (const acc of accounts) {
      const inbox = await findInboxFolderForAccount(acc.id);
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
            const { ok, threadKey, weIds, actions, allActionsReady } = await computeAndStoreThreadTagList(id);
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
            const effectiveAction = maxPriorityAction(actions);
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
      console.log(`[TMDBG Tag] Gloda conversation failed for weMsgId=${weMsgId}: ${conv.error}`);
      return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
    }

    const conversationId = String(conv.conversationId || "");
    if (!conversationId) {
      console.log(`[TMDBG Tag] Missing conversationId for weMsgId=${weMsgId}; cannot compute stable thread key`);
      return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
    }

    const inbox = await findInboxFolderForAccount(accountId);
    const inboxPath = inbox?.path || "";
    if (!inbox || !inbox.id || !inboxPath) {
      return { ok: false, threadKey: null, conversationId, weIds: [], actions: [], allActionsReady: false };
    }

    threadKey = `${accountId}:${inboxPath}:glodaConv:${conversationId}`;

    // Acquire per-thread semaphore to serialize updates to the same thread
    await _acquireThreadTagSemaphore(threadKey);

    try {
      const weIds = await getInboxWeIdsForConversation(accountId, conv.headerMessageIds);

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
        const a = await readCachedActionForWeId(id);
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
          if (isDebugTagRaceEnabled()) {
            console.log(`[TMDBG TagRace] computeAndStoreThreadTagList skip store (incomplete, no progress): threadKey=${threadKey} current=${actions.length} existing=${existingActionsCount}`);
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
          if (isDebugTagRaceEnabled()) {
            console.log(`[TMDBG TagRace] computeAndStoreThreadTagList skip store (idempotent): threadKey=${threadKey}`);
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
    console.log(`[TMDBG Tag] computeAndStoreThreadTagList failed for weMsgId=${weMsgId}: ${e}`);
    if (threadKey) _releaseThreadTagSemaphore(threadKey);
    return { ok: false, threadKey: null, conversationId: "", weIds: [], actions: [], allActionsReady: false };
  }
}

// ---------------------------------------------------------------------------
// Thread tag watchers (messages.onUpdated)
// ---------------------------------------------------------------------------

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
  try { selfTagUpdateIgnoreUntilByMsgId = new Map(); } catch (_) {}
  try {
    if (_selfTagIgnorePruneTimer) { clearTimeout(_selfTagIgnorePruneTimer); _selfTagIgnorePruneTimer = null; }
  } catch (_) {}
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
          const ignoreUntil = Number(selfTagUpdateIgnoreUntilByMsgId.get(id) || 0);
          if (ignoreUntil && now < ignoreUntil) {
            if (isDebugTagRaceEnabled()) {
              console.log(
                `[TMDBG TagRace] threadWatcher skip (selfIgnore active) id=${id} now=${now} ignoreUntil=${ignoreUntil}`
              );
            }
            return;
          }

          if (isDebugTagRaceEnabled()) {
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
              if (isDebugTagRaceEnabled()) {
                try {
                  console.log(
                    `[TMDBG TagRace] threadWatcher skip tag->cache sync (internal) id=${id} author="${live?.author || ""}" subject="${live?.subject || ""}"`
                  );
                } catch (_) {}
              }
              // Still continue to keep thread aggregates fresh, but do not sync cache from tags.
            } else {
              // Sync IDB action cache from live Thunderbird tags (IMAP/server reasserts show up here).
              // We treat TB tags as the "sync signal" and keep IDB consistent for grouping logic.
              await syncActionCacheFromMessageTagsToInboxCopies(live);
            }
          } catch (_) {
            // If internal check fails, fall back to existing behavior (sync) to avoid silent divergence.
            await syncActionCacheFromMessageTagsToInboxCopies(live);
          }

          // Always keep the thread aggregate fresh when tags change anywhere.
          // Aggregation is Inbox-scoped internally (by querying Inbox copies via headerMessageId).
          const threadResult = await computeAndStoreThreadTagList(id);

          // If grouping enabled, enforce effective tag across the (Inbox) thread.
          // Pass pre-computed result to avoid redundant computation.
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
// Apply effective action tags to thread messages
// ---------------------------------------------------------------------------

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

    // Always apply tags even if unchanged — idempotent and ensures Gmail folder sync fires.

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
            selfTagUpdateIgnoreUntilByMsgId.set(hdr.id, Date.now() + ignoreDelta);
            scheduleSelfTagIgnorePrune();
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
        await applyActionTagToCrossFolderCopies(accountId, headerMessageId, effectiveAction);
      }
    } catch (_) {}

    // Gmail folder-based label sync (fire-and-forget)
    if (tagApplied && hdr?.folder?.accountId) {
      syncGmailTagFolder(hdr.id, hdr.folder.accountId, targetTag).catch((e) => {
        console.log(`[GMailTag] fire-and-forget failed (applyEffective): ${e}`);
      });
    }
  });

  await Promise.all(updates);
  triggerSortRefresh();
}

/**
 * Apply the effective (max-priority) action tag to all messages in a thread.
 * Only applies if ALL messages in the thread have cached actions (allActionsReady).
 * @param {number} weMsgId - Seed message ID (only used for logging if precomputed is not provided)
 * @param {Object} [precomputed] - Pre-computed thread data from computeAndStoreThreadTagList
 * @param {string} [reason] - Reason for the update (for logging)
 */
export async function updateThreadEffectiveTagsIfNeeded(weMsgId, precomputed = null, reason = "") {
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
      if (isDebugTagRaceEnabled()) {
        console.log(`[TMDBG TagRace] updateThreadEffectiveTagsIfNeeded computing (no precomputed): seed=${weMsgId}`);
      }
      const computed = await computeAndStoreThreadTagList(weMsgId);
      ok = computed.ok;
      weIds = computed.weIds;
      actions = computed.actions;
      allActionsReady = computed.allActionsReady;
    }

    if (!ok || !weIds || weIds.length === 0) return;

    const tagByThreadEnabled = await getTagByThreadEnabled();
    if (!tagByThreadEnabled) return;

    // IMPORTANT: Only apply effective action when ALL messages have cached actions.
    // This prevents overwriting correct per-message tags when some messages haven't been processed yet.
    if (!allActionsReady) {
      if (isDebugTagRaceEnabled()) {
        console.log(
          `[TMDBG TagRace] updateThreadEffectiveTagsIfNeeded skip (not all actions ready): seed=${weMsgId} weIds=${weIds.length} actions=[${actions.join(",")}] reason=${reason || ""}`
        );
      }
      console.log(
        `[TMDBG Tag] Thread grouping: deferring effective action (${weIds.length - actions.length}/${weIds.length} messages missing actions) seed=${weMsgId}`
      );
      return;
    }

    const effectiveAction = maxPriorityAction(actions);
    if (isDebugTagRaceEnabled()) {
      console.log(
        `[TMDBG TagRace] effectiveThreadTag applying effectiveAction=${effectiveAction || "(none)"} seed=${weMsgId} reason=${reason || ""} threadWeIds=${weIds.length} actions=[${actions.join(",")}]`
      );
    }
    console.log(
      `[TMDBG Tag] Thread grouping enabled: applying effectiveAction=${effectiveAction || "(none)"} to thread messages count=${weIds.length} (seed=${weMsgId})`
    );
    await _applyEffectiveActionToWeIds(weIds, effectiveAction);
  } catch (e) {
    console.log(`[TMDBG Tag] updateThreadEffectiveTagsIfNeeded failed for weMsgId=${weMsgId}: ${e}`);
  }
}

async function _retagThreadForGroupingDisabled(weMsgId) {
  try {
    const { ok, weIds } = await computeAndStoreThreadTagList(weMsgId);
    if (!ok || !weIds || weIds.length === 0) return;

    await ensureActionTags();
    const actionTagIds = Object.values(ACTION_TAG_IDS);

    const updates = weIds.map(async (id) => {
      try {
        const hdr = await browser.messages.get(id);
        if (!hdr) return;
        const okInbox = hdr?.folder && isInboxFolder(hdr.folder);
        if (!okInbox) return;
        const action = await readCachedActionForWeId(id);
        const accountId = hdr?.folder?.accountId || "";
        const headerMessageId = hdr?.headerMessageId || "";
        const originalTags = Array.isArray(hdr.tags) ? [...hdr.tags] : [];
        let newTags = originalTags.filter((t) => !actionTagIds.includes(t));
        const targetTag = action ? ACTION_TAG_IDS[action] : null;
        if (targetTag) newTags.push(targetTag);
        const hadNonTabMail = hasNonTabMailTags(originalTags);
        newTags = reorderTagsToPreferTabMail(newTags);
        // Always apply tags even if unchanged — idempotent and ensures Gmail folder sync fires.
        try {
          const ignoreMs = Number(SETTINGS?.actionTagging?.selfTagUpdateIgnoreMs);
          if (Number.isFinite(ignoreMs) && ignoreMs > 0) {
            selfTagUpdateIgnoreUntilByMsgId.set(hdr.id, Date.now() + ignoreMs);
            scheduleSelfTagIgnorePrune();
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
            await applyActionTagToCrossFolderCopies(accountId, headerMessageId, action);
          }
        } catch (_) {}

        // Gmail folder-based label sync (fire-and-forget)
        if (accountId) {
          syncGmailTagFolder(hdr.id, accountId, targetTag).catch((e) => {
            console.log(`[GMailTag] fire-and-forget failed (retagDisabled): ${e}`);
          });
        }
      } catch (_) {}
    });

    await Promise.all(updates);
    triggerSortRefresh();
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
