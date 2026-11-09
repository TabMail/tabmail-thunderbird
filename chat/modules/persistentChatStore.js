/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// persistentChatStore.js – Persistent turn storage for infinite chat (TB 145, MV3)
//
// Dual storage: browser.storage.local (ordered active buffer) + native FTS (searchable).
// Active buffer holds budgeted turns for conversation context rebuild.
// FTS holds rendered text for search; evicted turns remain in FTS until the memory size limit removes the oldest.

import { log } from "../../agent/modules/utils.js";
import { get as idbGet, set as idbSet, remove as idbRemove, getAllKeys as idbGetAllKeys } from "../../agent/modules/idbStorage.js";

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------
const TURNS_KEY = "chat_turns";
const META_KEY = "chat_meta";
const IDMAP_KEY = "chat_id_map";

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------
const MAX_EXCHANGES = 50; // max exchanges kept in active chat buffer (UI only, not token budget)
const CHARS_PER_EXCHANGE = 500; // approximate average for derived char cap

// ---------------------------------------------------------------------------
// Debounce helpers
// ---------------------------------------------------------------------------
let _saveIdMapTimer = null;
const IDMAP_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Turns: load / change / append
// ---------------------------------------------------------------------------

/**
 * The stored turns. Returns array (empty if none or corrupted).
 */
export async function loadTurns() {
  try {
    const result = await browser.storage.local.get(TURNS_KEY);
    const turns = Array.isArray(result[TURNS_KEY]) ? result[TURNS_KEY] : [];
    log(`[PersistentChat] Loaded ${turns.length} turns from storage`, 'debug');
    return turns;
  } catch (e) {
    log(`[PersistentChat] Failed to load turns: ${e}`, "error");
  }
  return [];
}

/**
 * Apply one change to a list of turns, without touching storage. The parts
 * apply in this order: clear every turn; remove these ids; remove turns older
 * than keepFrom (ms); replace turns by id; append (an id already present is
 * not added again), then keep the list within the budget. Applying a sequence
 * of changes again to its own result gives the same result.
 *
 * @param {object[]} turns - not mutated
 * @param {{ clear?: boolean, remove?: string[], keepFrom?: number, update?: object[], append?: object[] }} op
 * @returns {{ turns: object[], removed: number }}
 */
export function applyTurnsOperation(turns, op) {
  let next = [...turns];
  let removed = 0;
  const drop = shouldDrop => {
    const kept = next.filter(t => !shouldDrop(t));
    removed += next.length - kept.length;
    next = kept;
  };
  if (op.clear) drop(() => true);
  if (op.remove) {
    const ids = new Set(op.remove);
    drop(t => ids.has(t._id));
  }
  if (op.keepFrom !== undefined) drop(t => (t._ts || 0) < op.keepFrom);
  if (op.update) {
    const byId = new Map(op.update.map(t => [t._id, t]));
    next = next.map(t => byId.get(t._id) || t);
  }
  if (op.append) {
    const known = new Set(next.map(t => t._id));
    next.push(...op.append.filter(t => !known.has(t._id)));
    enforceBudget(next);
  }
  return { turns: next, removed };
}

/**
 * Change the stored turns from an extension page. Sends the operation to the
 * background (storedTurnsQueue.js), the one writer of chat_turns, which
 * applies changes one at a time in arrival order and answers once this one is
 * applied. Rejects when it was not applied.
 *
 * @param {{ clear?: boolean, remove?: string[], keepFrom?: number, update?: object[], append?: object[] }} op
 *   see storedTurnsQueue.enqueueTurnsChange
 * @returns {Promise<{ applied: true, removed: number }>}
 */
export async function changeTurns(op) {
  return requireTaken(await browser.runtime.sendMessage({ command: "chat-turns-change", op }));
}

/**
 * A reply from the stored turns' writer, if it applied the change; throws its
 * error otherwise. Every caller of the writer checks its reply here, so a
 * failed change is never taken as stored.
 */
export function requireTaken(reply) {
  if (!reply?.applied) throw new Error(reply?.error || "the background did not apply the change");
  return reply;
}

/**
 * Add a turn the chat window shows: to the window's own copy (`turns`, for
 * display and the model's context, kept within the budget; mutated in place)
 * and to the stored turns (through the background's writer).
 *
 * @param {object} turn - Turn object with _id, _ts, _type, _chars, role, content, etc.
 * @param {object[]} turns - The window's turns (mutated in place)
 * @returns {Promise<{ evictedTurns: object[] }>} the turns the window's copy dropped, for the caller's cleanup
 */
export async function appendTurn(turn, turns) {
  turns.push(turn);
  const evictedTurns = enforceBudget(turns);
  try {
    await changeTurns({ append: [turn] });
  } catch (e) {
    log(`[PersistentChat] Failed to store turn ${turn._id}: ${e}`, "error");
  }
  return { evictedTurns };
}

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce two-level budget: exchange count, then derived char cap, counted
 * from the turns themselves. Mutates turns in place.
 *
 * @param {object[]} turns - Turns array (mutated)
 * @returns {object[]} evicted turns
 */
export function enforceBudget(turns) {
  const maxMessages = MAX_EXCHANGES * 2; // user + assistant per exchange
  const maxChars = MAX_EXCHANGES * CHARS_PER_EXCHANGE;
  let totalChars = turns.reduce((sum, t) => sum + (t._chars || 0), 0);

  const evictedList = [];

  // Step 1: Enforce exchange count limit
  while (turns.length > maxMessages) {
    if (_isHeadProtected(turns)) break;
    const evicted = turns.shift();
    totalChars -= evicted._chars || 0;
    evictedList.push(evicted);
  }

  // Step 2: Enforce derived char cap (handles unusually long messages)
  while (totalChars > maxChars && turns.length > 0) {
    if (_isHeadProtected(turns)) break;
    const evicted = turns.shift();
    totalChars -= evicted._chars || 0;
    evictedList.push(evicted);
  }

  if (evictedList.length > 0) {
    log(`[PersistentChat] Evicted ${evictedList.length} turns (maxExchanges=${MAX_EXCHANGES}, maxChars=${maxChars}, remaining=${turns.length}, chars=${totalChars})`, 'debug');
  }

  return evictedList;
}

/**
 * Check if turns[0] is protected from eviction.
 * The last welcome_back or session_break and everything after it are protected.
 * Must recalculate each call since turns mutates during eviction.
 */
function _isHeadProtected(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]._type;
    if (t === "welcome_back" || t === "session_break") return i === 0;
  }
  return false; // no session boundary → nothing protected
}


// ---------------------------------------------------------------------------
// Metadata: load / save
// ---------------------------------------------------------------------------

/**
 * Load chat metadata.
 * @returns {{ lastActivityTs: number, lastKbUpdateTs: number, kbCursorId: string|null }}
 */
export async function loadMeta() {
  try {
    const result = await browser.storage.local.get(META_KEY);
    const meta = result[META_KEY];
    if (meta && typeof meta === "object") {
      log(`[PersistentChat] Loaded meta: lastActivity=${meta.lastActivityTs}, cursor=${meta.kbCursorId || "null"}`, 'debug');
      return meta;
    }
  } catch (e) {
    log(`[PersistentChat] Failed to load meta: ${e}`, "error");
  }
  return {
    lastActivityTs: 0,
    lastKbUpdateTs: 0,
    kbCursorId: null,
  };
}

/**
 * Save metadata.
 */
export function saveMeta(meta) {
  // Use immediate save for meta since it's small and important
  browser.storage.local.set({ [META_KEY]: meta }).catch(e => {
    log(`[PersistentChat] Failed to save meta: ${e}`, "error");
  });
}

/**
 * Force-save metadata immediately.
 */
export async function saveMetaImmediate(meta) {
  try {
    await browser.storage.local.set({ [META_KEY]: meta });
  } catch (e) {
    log(`[PersistentChat] Failed to force-save meta: ${e}`, "error");
  }
}

// ---------------------------------------------------------------------------
// IdMap: load / save
// ---------------------------------------------------------------------------

/**
 * Load persisted idMap.
 * @returns {{ entries: [number, string][], nextNumericId: number, freeIds: number[], refCounts: [number, number][] }}
 */
export async function loadIdMap() {
  try {
    const result = await browser.storage.local.get(IDMAP_KEY);
    const data = result[IDMAP_KEY];
    if (data && typeof data === "object") {
      log(`[PersistentChat] Loaded idMap: ${(data.entries || []).length} entries, nextId=${data.nextNumericId}, freeIds=${(data.freeIds || []).length}, refCounts=${(data.refCounts || []).length}`, 'debug');
      return {
        entries: Array.isArray(data.entries) ? data.entries : [],
        nextNumericId: data.nextNumericId || 1,
        freeIds: Array.isArray(data.freeIds) ? data.freeIds : [],
        refCounts: Array.isArray(data.refCounts) ? data.refCounts : [],
      };
    }
  } catch (e) {
    log(`[PersistentChat] Failed to load idMap: ${e}`, "error");
  }
  return { entries: [], nextNumericId: 1, freeIds: [], refCounts: [] };
}

/**
 * Save idMap to storage (debounced).
 * @param {Map} idMap - numericId -> realId
 * @param {number} nextNumericId
 * @param {number[]} freeIds
 * @param {Map} [refCounts] - numericId -> reference count
 */
export function saveIdMap(idMap, nextNumericId, freeIds, refCounts) {
  if (_saveIdMapTimer) clearTimeout(_saveIdMapTimer);
  _saveIdMapTimer = setTimeout(async () => {
    _saveIdMapTimer = null;
    try {
      const data = {
        entries: Array.from(idMap.entries()),
        nextNumericId,
        freeIds: Array.isArray(freeIds) ? freeIds : [],
        refCounts: refCounts instanceof Map ? Array.from(refCounts.entries()) : [],
      };
      await browser.storage.local.set({ [IDMAP_KEY]: data });
      log(`[PersistentChat] Saved idMap: ${data.entries.length} entries, nextId=${nextNumericId}, freeIds=${data.freeIds.length}, refCounts=${data.refCounts.length}`, 'debug');
    } catch (e) {
      log(`[PersistentChat] Failed to save idMap: ${e}`, "error");
    }
  }, IDMAP_DEBOUNCE_MS);
}

/**
 * Force-save idMap immediately (for beforeunload).
 * @param {Map} idMap
 * @param {number} nextNumericId
 * @param {number[]} freeIds
 * @param {Map} [refCounts]
 */
export async function saveIdMapImmediate(idMap, nextNumericId, freeIds, refCounts) {
  if (_saveIdMapTimer) {
    clearTimeout(_saveIdMapTimer);
    _saveIdMapTimer = null;
  }
  try {
    const data = {
      entries: Array.from(idMap.entries()),
      nextNumericId,
      freeIds: Array.isArray(freeIds) ? freeIds : [],
      refCounts: refCounts instanceof Map ? Array.from(refCounts.entries()) : [],
    };
    await browser.storage.local.set({ [IDMAP_KEY]: data });
    log(`[PersistentChat] Force-saved idMap: ${data.entries.length} entries, refCounts=${data.refCounts.length}`, 'debug');
  } catch (e) {
    log(`[PersistentChat] Failed to force-save idMap: ${e}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Thinking token storage (IDB)
// ---------------------------------------------------------------------------

const THINKING_PREFIX = "thinking:";

export async function saveThinking(turnId, thinkingText) {
  if (!thinkingText) return;
  await idbSet({ [`${THINKING_PREFIX}${turnId}`]: thinkingText }, { kind: "thinking" });
}

export async function loadThinkingBatch(turnIds) {
  if (!turnIds.length) return {};
  const keys = turnIds.map(id => `${THINKING_PREFIX}${id}`);
  const result = await idbGet(keys);
  const map = {};
  for (const id of turnIds) {
    map[id] = result[`${THINKING_PREFIX}${id}`] ?? null;
  }
  return map;
}

export async function removeThinking(turnIds) {
  if (!turnIds.length) return;
  await idbRemove(turnIds.map(id => `${THINKING_PREFIX}${id}`));
}

export async function clearAllThinking() {
  const allKeys = await idbGetAllKeys();
  const thinkingKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(THINKING_PREFIX));
  if (thinkingKeys.length) {
    await idbRemove(thinkingKeys);
    log(`[PersistentChat] Cleared ${thinkingKeys.length} thinking entries from IDB`, 'debug');
  }
}

// ---------------------------------------------------------------------------
// Turn <-> LLM message conversion
// ---------------------------------------------------------------------------

/**
 * Strip _-prefixed metadata fields from a turn, returning a clean LLM message.
 */
export function turnToLLMMessage(turn) {
  const msg = {};
  for (const key of Object.keys(turn)) {
    if (!key.startsWith("_")) {
      msg[key] = turn[key];
    }
  }
  return msg;
}

/**
 * Convert all turns to LLM messages.
 * Async: loads thinking tokens from IDB for assistant turns.
 */
export async function turnsToLLMMessages(turns) {
  const assistantIds = turns.filter(t => t.role === "assistant" && t._id).map(t => t._id);
  const thinkingMap = assistantIds.length > 0 ? await loadThinkingBatch(assistantIds) : {};

  return turns.map(turn => {
    const msg = {};
    for (const key of Object.keys(turn)) {
      if (!key.startsWith("_")) {
        msg[key] = turn[key];
      }
    }
    if (turn.role === "assistant" && turn._id && thinkingMap[turn._id]) {
      msg.thinking = thinkingMap[turn._id];
    }
    return msg;
  });
}

/**
 * The stored turns as the model's context: drop KB-summarized prior sessions,
 * then convert to LLM messages. Reads the stored turns, so turns Chat History
 * removed are left out even while an open window still shows them. Checks
 * kb_last_summarized_ts from storage; if a session_break predates that
 * marker, all turns up to and including it are dropped (already distilled
 * into KB).
 *
 * @returns {Promise<Array>} - LLM-format messages (without system message)
 */
export async function filterAndConvertTurns() {
  const persistedTurns = await loadTurns();
  const { kb_last_summarized_ts } = await browser.storage.local.get("kb_last_summarized_ts");

  if (!kb_last_summarized_ts) {
    return await turnsToLLMMessages(persistedTurns);
  }

  // Walk backward: find the latest session_break whose _ts <= marker
  let cutIdx = -1;
  for (let i = persistedTurns.length - 1; i >= 0; i--) {
    if (persistedTurns[i]._type === "session_break" && persistedTurns[i]._ts <= kb_last_summarized_ts) {
      cutIdx = i;
      break;
    }
  }

  if (cutIdx < 0) {
    return await turnsToLLMMessages(persistedTurns);
  }

  const kept = persistedTurns.slice(cutIdx + 1);
  log(`[PersistentChat] KB filter: dropped ${cutIdx + 1} summarized turns, keeping ${kept.length}`, 'debug');
  return await turnsToLLMMessages(kept);
}

// ---------------------------------------------------------------------------
// FTS indexing (uses the real render pipeline for future-proof text extraction)
// ---------------------------------------------------------------------------

/**
 * Index a user+assistant exchange to native FTS for immediate searchability.
 * Runs the same render pipeline as the chat DOM: renderMarkdown() to produce HTML
 * with resolved entities, then extractPlainTextFromHtml() to get searchable plain
 * text. This is identical to the old DOM-based extraction and automatically picks
 * up any future rendering changes.
 *
 * @param {object} userTurn - User turn object
 * @param {object} assistantTurn - Assistant turn object
 */
export async function indexTurnToFTS(userTurn, assistantTurn) {
  try {
    const userText = userTurn?.user_message || userTurn?.content || "";
    const assistantContent = assistantTurn?.content || "";

    if (!userText.trim() && !assistantContent.trim()) return;

    const { renderToPlainText, extractPlainTextFromHtml } = await import("./helpers.js");

    // User text: render through markdown pipeline to resolve [Email](N) references
    const cleanUserText = await renderToPlainText(userText);

    // Assistant text: use _rendered snapshot if available (skip renderMarkdown)
    let cleanAssistantText;
    if (assistantTurn._rendered) {
      cleanAssistantText = extractPlainTextFromHtml(assistantTurn._rendered);
    } else {
      cleanAssistantText = await renderToPlainText(assistantContent);
    }

    const { indexChatTurn } = await import("../../fts/memoryIndexer.js");
    await indexChatTurn(cleanUserText, cleanAssistantText, assistantTurn._id, assistantTurn._ts);
    log(`[PersistentChat] Indexed turn ${assistantTurn._id} to FTS`, 'debug');
  } catch (e) {
    log(`[PersistentChat] FTS indexing failed (non-fatal): ${e}`, "warn");
  }
}

// ---------------------------------------------------------------------------
// KB cursor helpers
// ---------------------------------------------------------------------------

/**
 * Get all turns after the KB cursor (unprocessed turns for KB refinement).
 * Returns all turns if cursor is null (nothing processed yet).
 */
export function getTurnsAfterCursor(turns, meta) {
  if (!meta.kbCursorId) return [...turns];

  const cursorIdx = turns.findIndex(t => t._id === meta.kbCursorId);
  if (cursorIdx < 0) {
    // Cursor turn was evicted — all remaining turns are after it
    log(`[PersistentChat] KB cursor ${meta.kbCursorId} not found (evicted), returning all ${turns.length} turns`, 'debug');
    return [...turns];
  }

  const after = turns.slice(cursorIdx + 1);
  log(`[PersistentChat] Turns after cursor: ${after.length} (cursor at index ${cursorIdx})`, 'debug');
  return after;
}

/**
 * Advance KB cursor to the given turn ID.
 */
export function advanceCursor(meta, lastProcessedTurnId) {
  meta.kbCursorId = lastProcessedTurnId;
  saveMeta(meta);
  log(`[PersistentChat] KB cursor advanced to ${lastProcessedTurnId}`, 'debug');
}

// ---------------------------------------------------------------------------
// Migration from session-based chat_history_queue
// ---------------------------------------------------------------------------

const MIGRATION_V1_FLAG = "chat_turns_migration_v1";
const MIGRATION_V2_FLAG = "chat_turns_migration_v2";
const MIGRATION_V3_FLAG = "chat_turns_migration_v3";

/**
 * One-time migrations for persistent chat. Runs at init before loading turns.
 * v1: Clean reset of old session-based chat_history_queue.
 * v2: Clear old session-based FTS entries (chat:* memIds) for consistency.
 * v3: Delete the persisted turns queue of 1.11.x (chat_turns_pending); changes
 *     to the stored turns are no longer kept across a restart.
 */
export async function migrateFromSessions() {
  try {
    const flags = await browser.storage.local.get([MIGRATION_V1_FLAG, MIGRATION_V2_FLAG, MIGRATION_V3_FLAG]);

    // v1: Delete old session-based storage keys
    if (!flags[MIGRATION_V1_FLAG]) {
      log(`[PersistentChat] Migration v1: clearing old session-based chat history`, 'debug');
      await browser.storage.local.remove(["chat_history_queue", "chat_history_queue_config"]);
      await browser.storage.local.set({ [MIGRATION_V1_FLAG]: Date.now() });
      log(`[PersistentChat] Migration v1 complete`, 'debug');
    }

    // v2: Clear old session-based FTS entries
    if (!flags[MIGRATION_V2_FLAG]) {
      log(`[PersistentChat] Migration v2: clearing old session-based FTS entries`, 'debug');
      try {
        await browser.runtime.sendMessage({ type: "fts", cmd: "memoryClear" });
        log(`[PersistentChat] Migration v2: FTS cleared`, 'debug');
      } catch (e) {
        log(`[PersistentChat] Migration v2: FTS clear failed (non-fatal): ${e}`, "warn");
      }
      await browser.storage.local.set({ [MIGRATION_V2_FLAG]: Date.now() });
      log(`[PersistentChat] Migration v2 complete`, 'debug');
    }

    // v3: Delete the persisted turns queue
    if (!flags[MIGRATION_V3_FLAG]) {
      await browser.storage.local.remove("chat_turns_pending");
      await browser.storage.local.set({ [MIGRATION_V3_FLAG]: Date.now() });
      log(`[PersistentChat] Migration v3 complete`, 'debug');
    }
  } catch (e) {
    log(`[PersistentChat] Migration failed: ${e}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Utility: generate unique turn ID
// ---------------------------------------------------------------------------

export function generateTurnId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
