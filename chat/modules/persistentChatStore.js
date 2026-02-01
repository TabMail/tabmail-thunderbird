// persistentChatStore.js – Persistent turn storage for infinite chat (TB 145, MV3)
//
// Dual storage: browser.storage.local (ordered active buffer) + native FTS (searchable).
// Active buffer holds budgeted turns for conversation context rebuild.
// FTS holds rendered text for search; evicted turns remain in FTS forever.

import { log } from "../../agent/modules/utils.js";

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------
const TURNS_KEY = "chat_turns";
const META_KEY = "chat_meta";
const IDMAP_KEY = "chat_id_map";

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------
const MAX_EXCHANGES_HARD_CAP = 100; // absolute max regardless of user config
const CHARS_PER_EXCHANGE = 500; // approximate average for derived char cap

// ---------------------------------------------------------------------------
// Debounce helpers
// ---------------------------------------------------------------------------
let _saveTurnsTimer = null;
const SAVE_DEBOUNCE_MS = 500;

let _saveIdMapTimer = null;
const IDMAP_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Turns: load / save / append
// ---------------------------------------------------------------------------

/**
 * Load persisted turns from storage.
 * Returns array (empty if none or corrupted).
 */
export async function loadTurns() {
  try {
    const result = await browser.storage.local.get(TURNS_KEY);
    const turns = result[TURNS_KEY];
    if (Array.isArray(turns)) {
      log(`[PersistentChat] Loaded ${turns.length} turns from storage`);
      return turns;
    }
  } catch (e) {
    log(`[PersistentChat] Failed to load turns: ${e}`, "error");
  }
  return [];
}

/**
 * Save turns to storage (debounced).
 * Call after mutations; actual write happens after SAVE_DEBOUNCE_MS idle.
 */
export function saveTurns(turns) {
  if (_saveTurnsTimer) clearTimeout(_saveTurnsTimer);
  _saveTurnsTimer = setTimeout(async () => {
    _saveTurnsTimer = null;
    try {
      await browser.storage.local.set({ [TURNS_KEY]: turns });
      log(`[PersistentChat] Saved ${turns.length} turns (${JSON.stringify(turns).length} bytes)`);
    } catch (e) {
      log(`[PersistentChat] Failed to save turns: ${e}`, "error");
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Force-save turns immediately (bypass debounce).
 * Used on beforeunload where timers won't fire.
 */
export async function saveTurnsImmediate(turns) {
  if (_saveTurnsTimer) {
    clearTimeout(_saveTurnsTimer);
    _saveTurnsTimer = null;
  }
  try {
    await browser.storage.local.set({ [TURNS_KEY]: turns });
    log(`[PersistentChat] Force-saved ${turns.length} turns`);
  } catch (e) {
    log(`[PersistentChat] Failed to force-save turns: ${e}`, "error");
  }
}

/**
 * Append a turn, enforce budget, return { evictedTurns }.
 * Caller should handle eviction cleanup (idMap, DOM indicators).
 *
 * @param {object} turn - Turn object with _id, _ts, _type, _chars, role, content, etc.
 * @param {object[]} turns - Current turns array (mutated in place)
 * @param {object} meta - Current metadata (mutated: totalChars updated)
 * @returns {{ evictedTurns: object[] }}
 */
export async function appendTurn(turn, turns, meta) {
  turns.push(turn);
  meta.totalChars = (meta.totalChars || 0) + (turn._chars || 0);

  // Load user's max exchanges setting
  const maxExchanges = await getMaxExchanges();
  const evictedTurns = enforceBudget(turns, meta, maxExchanges);

  // Debounced save
  saveTurns(turns);
  saveMeta(meta);

  return { evictedTurns };
}

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce two-level budget: exchange count, then derived char cap.
 * Mutates turns array and meta.totalChars in place.
 *
 * @param {object[]} turns - Turns array (mutated)
 * @param {object} meta - Metadata (mutated: totalChars)
 * @param {number} maxExchanges - Max exchanges (user setting, capped at 100)
 * @returns {object[]} evicted turns
 */
export function enforceBudget(turns, meta, maxExchanges) {
  const safeMax = Math.min(Math.max(maxExchanges || MAX_EXCHANGES_HARD_CAP, 1), MAX_EXCHANGES_HARD_CAP);
  const maxMessages = safeMax * 2; // user + assistant per exchange
  const maxChars = safeMax * CHARS_PER_EXCHANGE;

  const evictedList = [];

  // Step 1: Enforce exchange count limit
  while (turns.length > maxMessages) {
    if (_isHeadProtected(turns)) break;
    const evicted = turns.shift();
    meta.totalChars -= evicted._chars || 0;
    evictedList.push(evicted);
  }

  // Step 2: Enforce derived char cap (handles unusually long messages)
  while (meta.totalChars > maxChars && turns.length > 0) {
    if (_isHeadProtected(turns)) break;
    const evicted = turns.shift();
    meta.totalChars -= evicted._chars || 0;
    evictedList.push(evicted);
  }

  if (evictedList.length > 0) {
    log(`[PersistentChat] Evicted ${evictedList.length} turns (maxExchanges=${safeMax}, maxChars=${maxChars}, remaining=${turns.length}, chars=${meta.totalChars})`);
  }

  return evictedList;
}

/**
 * Check if turns[0] is protected from eviction.
 * The last welcome_back and everything after it are protected.
 * Must recalculate each call since turns mutates during eviction.
 */
function _isHeadProtected(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]._type === "welcome_back") return i === 0;
  }
  return false; // no welcome_back → nothing protected
}

export async function getMaxExchanges() {
  try {
    const key = "user_prompts:kb_config";
    const obj = await browser.storage.local.get(key);
    const kbConfig = obj[key] || {};
    const val = kbConfig.max_chat_exchanges;
    if (typeof val === "number" && val > 0) {
      return Math.min(val, MAX_EXCHANGES_HARD_CAP);
    }
  } catch (e) {
    log(`[PersistentChat] Failed to load max_chat_exchanges: ${e}`, "warn");
  }
  return MAX_EXCHANGES_HARD_CAP; // default 100
}

// ---------------------------------------------------------------------------
// Metadata: load / save
// ---------------------------------------------------------------------------

/**
 * Load chat metadata.
 * @returns {{ lastActivityTs: number, totalChars: number, lastKbUpdateTs: number, kbCursorId: string|null }}
 */
export async function loadMeta() {
  try {
    const result = await browser.storage.local.get(META_KEY);
    const meta = result[META_KEY];
    if (meta && typeof meta === "object") {
      log(`[PersistentChat] Loaded meta: lastActivity=${meta.lastActivityTs}, chars=${meta.totalChars}, cursor=${meta.kbCursorId || "null"}`);
      return meta;
    }
  } catch (e) {
    log(`[PersistentChat] Failed to load meta: ${e}`, "error");
  }
  return {
    lastActivityTs: 0,
    totalChars: 0,
    lastKbUpdateTs: 0,
    kbCursorId: null,
  };
}

/**
 * Save metadata (debounced via saveTurns timer — piggybacks on same cycle).
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
      log(`[PersistentChat] Loaded idMap: ${(data.entries || []).length} entries, nextId=${data.nextNumericId}, freeIds=${(data.freeIds || []).length}, refCounts=${(data.refCounts || []).length}`);
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
      log(`[PersistentChat] Saved idMap: ${data.entries.length} entries, nextId=${nextNumericId}, freeIds=${data.freeIds.length}, refCounts=${data.refCounts.length}`);
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
    log(`[PersistentChat] Force-saved idMap: ${data.entries.length} entries, refCounts=${data.refCounts.length}`);
  } catch (e) {
    log(`[PersistentChat] Failed to force-save idMap: ${e}`, "error");
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
 */
export function turnsToLLMMessages(turns) {
  return turns.map(turnToLLMMessage);
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

    const { extractPlainTextFromHtml } = await import("./helpers.js");
    const { renderMarkdown } = await import("./markdown.js");

    // User text: render through markdown pipeline to resolve [Email](N) references
    const cleanUserText = userText
      ? extractPlainTextFromHtml(await renderMarkdown(userText))
      : "";

    // Assistant text: use _rendered snapshot if available (skip renderMarkdown)
    let cleanAssistantText;
    if (assistantTurn._rendered) {
      cleanAssistantText = extractPlainTextFromHtml(assistantTurn._rendered);
    } else {
      // Fallback: full render pipeline (for turns without snapshot)
      cleanAssistantText = assistantContent
        ? extractPlainTextFromHtml(await renderMarkdown(assistantContent))
        : "";
    }

    const { indexChatTurn } = await import("../../fts/memoryIndexer.js");
    await indexChatTurn(cleanUserText, cleanAssistantText, assistantTurn._id, assistantTurn._ts);
    log(`[PersistentChat] Indexed turn ${assistantTurn._id} to FTS`);
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
    log(`[PersistentChat] KB cursor ${meta.kbCursorId} not found (evicted), returning all ${turns.length} turns`);
    return [...turns];
  }

  const after = turns.slice(cursorIdx + 1);
  log(`[PersistentChat] Turns after cursor: ${after.length} (cursor at index ${cursorIdx})`);
  return after;
}

/**
 * Advance KB cursor to the given turn ID.
 */
export function advanceCursor(meta, lastProcessedTurnId) {
  meta.kbCursorId = lastProcessedTurnId;
  saveMeta(meta);
  log(`[PersistentChat] KB cursor advanced to ${lastProcessedTurnId}`);
}

// ---------------------------------------------------------------------------
// Migration from session-based chat_history_queue
// ---------------------------------------------------------------------------

const MIGRATION_V1_FLAG = "chat_turns_migration_v1";
const MIGRATION_V2_FLAG = "chat_turns_migration_v2";

/**
 * One-time migrations for persistent chat. Runs at init before loading turns.
 * v1: Clean reset of old session-based chat_history_queue.
 * v2: Clear old session-based FTS entries (chat:* memIds) for consistency.
 */
export async function migrateFromSessions() {
  try {
    const flags = await browser.storage.local.get([MIGRATION_V1_FLAG, MIGRATION_V2_FLAG]);

    // v1: Delete old session-based storage keys
    if (!flags[MIGRATION_V1_FLAG]) {
      log(`[PersistentChat] Migration v1: clearing old session-based chat history`);
      await browser.storage.local.remove(["chat_history_queue", "chat_history_queue_config"]);
      await browser.storage.local.set({ [MIGRATION_V1_FLAG]: Date.now() });
      log(`[PersistentChat] Migration v1 complete`);
    }

    // v2: Clear old session-based FTS entries
    if (!flags[MIGRATION_V2_FLAG]) {
      log(`[PersistentChat] Migration v2: clearing old session-based FTS entries`);
      try {
        await browser.runtime.sendMessage({ type: "fts", cmd: "memoryClear" });
        log(`[PersistentChat] Migration v2: FTS cleared`);
      } catch (e) {
        log(`[PersistentChat] Migration v2: FTS clear failed (non-fatal): ${e}`, "warn");
      }
      await browser.storage.local.set({ [MIGRATION_V2_FLAG]: Date.now() });
      log(`[PersistentChat] Migration v2 complete`);
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
