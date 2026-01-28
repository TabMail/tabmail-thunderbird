// memoryIndexer.js – Index chat sessions into memory database
// TB 145, MV3

import { log } from "../agent/modules/utils.js";

/**
 * Index a completed chat session into the memory database
 * Each session is stored as a SINGLE document (like an email), with all turns combined.
 * 
 * @param {string} sessionId - Unique identifier for the session
 * @param {Array} messages - Array of message objects with role and content
 * @param {number} sessionTimestamp - Timestamp when session started (optional)
 */
export async function indexChatSession(sessionId, messages, sessionTimestamp = null) {
  if (!sessionId || !Array.isArray(messages) || messages.length === 0) {
    log(`[TMDBG Memory Indexer] No session or messages to index`);
    return { ok: false, reason: "no messages" };
  }

  const baseTimestamp = sessionTimestamp || Date.now();

  // Combine all turns into a single document (like an email thread)
  const contentParts = [];
  let turnCount = 0;

  for (const msg of messages) {
    // Only include user and assistant messages
    if (msg.role !== "user" && msg.role !== "assistant") {
      continue;
    }

    // Skip automated greeting marker
    if (msg.content === "[automated greeting]") {
      continue;
    }

    const content = msg.content || "";
    if (!content.trim()) {
      continue;
    }

    const roleLabel = msg.role === "user" ? "[USER]" : "[ASSISTANT]";
    contentParts.push(`${roleLabel}: ${content}`);
    turnCount++;
  }

  if (contentParts.length === 0) {
    log(`[TMDBG Memory Indexer] No meaningful messages to index in session ${sessionId}`);
    return { ok: false, reason: "no meaningful messages" };
  }

  // Create a single row for the entire session
  const combinedContent = contentParts.join("\n\n");
  const rows = [{
    memId: `chat:${sessionId}`,
    role: "session", // Mark as session (contains both user and assistant)
    content: combinedContent,
    sessionId: sessionId,
    turnIndex: 0,
    dateMs: baseTimestamp,
  }];

  try {
    // Try direct API first (works during init), fall back to message passing
    let result;
    try {
      const { nativeMemorySearch } = await import("./nativeEngine.js");
      result = await nativeMemorySearch.indexBatch(rows);
    } catch (directError) {
      // Fall back to message passing (works from other contexts)
      result = await browser.runtime.sendMessage({
        type: "fts",
        cmd: "memoryIndexBatch",
        rows,
      });
    }

    if (result?.error) {
      log(`[TMDBG Memory Indexer] Failed to index session ${sessionId}: ${result.error}`, "error");
      return { ok: false, error: result.error };
    }

    log(`[TMDBG Memory Indexer] Indexed session ${sessionId} (${turnCount} turns combined)`);
    return { ok: true, count: 1 };
  } catch (e) {
    log(`[TMDBG Memory Indexer] Error indexing session ${sessionId}: ${e}`, "error");
    return { ok: false, error: String(e) };
  }
}

/**
 * Index chat sessions from the chat history queue
 * This indexes all unremembered sessions from chatHistoryQueue
 * 
 * @returns {Promise<{ok: boolean, indexed: number, sessions: number}>}
 */
export async function indexQueuedSessions() {
  try {
    const { getUnrememberedSessions, markSessionsAsRemembered } = await import("../agent/modules/chatHistoryQueue.js");
    
    const sessions = await getUnrememberedSessions();
    if (!sessions || sessions.length === 0) {
      log(`[TMDBG Memory Indexer] No unremembered sessions to index`);
      return { ok: true, indexed: 0, sessions: 0 };
    }

    log(`[TMDBG Memory Indexer] Indexing ${sessions.length} queued sessions to memory DB`);

    let totalIndexed = 0;
    const indexedSessionIds = [];

    for (const session of sessions) {
      const result = await indexChatSession(session.id, session.messages, session.timestamp);
      if (result.ok) {
        totalIndexed += result.count || 0;
        indexedSessionIds.push(session.id);
      }
    }

    // Mark successfully indexed sessions as remembered
    if (indexedSessionIds.length > 0) {
      await markSessionsAsRemembered(indexedSessionIds);
      log(`[TMDBG Memory Indexer] Marked ${indexedSessionIds.length} sessions as remembered`);
    }

    log(`[TMDBG Memory Indexer] Completed: indexed ${totalIndexed} turns from ${indexedSessionIds.length} sessions`);
    return { ok: true, indexed: totalIndexed, sessions: indexedSessionIds.length };
  } catch (e) {
    log(`[TMDBG Memory Indexer] Error indexing queued sessions: ${e}`, "error");
    return { ok: false, error: String(e), indexed: 0, sessions: 0 };
  }
}

/**
 * Get memory database stats
 */
export async function getMemoryStats() {
  try {
    const result = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "memoryStats",
    });
    return result;
  } catch (e) {
    log(`[TMDBG Memory Indexer] Error getting memory stats: ${e}`, "error");
    return { ok: false, error: String(e) };
  }
}

const MIGRATION_FLAG_KEY = "memory_fts_migration_v1_done";
const MIGRATED_SESSIONS_KEY = "memory_fts_migrated_sessions";

/**
 * One-time migration of existing chat history to memory FTS database.
 * This runs once after the memory DB feature is introduced.
 * Indexes ALL sessions from chat_history_queue (both remembered and unremembered).
 * Uses direct native API to avoid message passing issues during init.
 * Tracks migrated sessions to allow retry of failed ones.
 * 
 * @returns {Promise<{ok: boolean, migrated: boolean, sessions: number, indexed: number}>}
 */
export async function migrateExistingChatHistory() {
  try {
    // Check if migration already done
    const flagResult = await browser.storage.local.get(MIGRATION_FLAG_KEY);
    if (flagResult[MIGRATION_FLAG_KEY]) {
      log(`[TMDBG Memory Indexer] Migration already completed, skipping`);
      return { ok: true, migrated: false, sessions: 0, indexed: 0 };
    }

    log(`[TMDBG Memory Indexer] Starting one-time migration of existing chat history`);

    // Load all sessions from queue (not just unremembered)
    const { loadChatHistoryQueue } = await import("../agent/modules/chatHistoryQueue.js");
    const allSessions = await loadChatHistoryQueue();

    if (!allSessions || allSessions.length === 0) {
      log(`[TMDBG Memory Indexer] No existing chat history to migrate`);
      await browser.storage.local.set({ [MIGRATION_FLAG_KEY]: Date.now() });
      return { ok: true, migrated: true, sessions: 0, indexed: 0 };
    }

    // Load already-migrated sessions (for retry logic)
    const migratedResult = await browser.storage.local.get(MIGRATED_SESSIONS_KEY);
    const alreadyMigrated = new Set(migratedResult[MIGRATED_SESSIONS_KEY] || []);
    
    // Filter to sessions not yet migrated
    const sessionsToMigrate = allSessions.filter(s => s.id && !alreadyMigrated.has(s.id));
    
    if (sessionsToMigrate.length === 0) {
      log(`[TMDBG Memory Indexer] All ${allSessions.length} sessions already migrated`);
      await browser.storage.local.set({ [MIGRATION_FLAG_KEY]: Date.now() });
      await browser.storage.local.remove(MIGRATED_SESSIONS_KEY); // Clean up tracking
      return { ok: true, migrated: true, sessions: 0, indexed: 0 };
    }

    log(`[TMDBG Memory Indexer] Found ${sessionsToMigrate.length} sessions to migrate (${alreadyMigrated.size} already done)`);

    // Use direct native API for migration (avoids message passing issues during init)
    const { nativeMemorySearch } = await import("./nativeEngine.js");

    let totalIndexed = 0;
    let successfulSessions = 0;
    let failedSessions = 0;
    const newlyMigrated = [];

    for (const session of sessionsToMigrate) {
      if (!session.id || !Array.isArray(session.messages)) {
        continue;
      }

      try {
        // Build a single row per session (combine all turns like an email)
        const baseTimestamp = session.timestamp || Date.now();
        const contentParts = [];

        for (const msg of session.messages) {
          if (msg.role !== "user" && msg.role !== "assistant") continue;
          if (msg.content === "[automated greeting]") continue;
          const content = msg.content || "";
          if (!content.trim()) continue;

          const roleLabel = msg.role === "user" ? "[USER]" : "[ASSISTANT]";
          contentParts.push(`${roleLabel}: ${content}`);
        }

        if (contentParts.length === 0) {
          newlyMigrated.push(session.id); // Empty session, mark as done
          continue;
        }

        const combinedContent = contentParts.join("\n\n");
        const rows = [{
          memId: `chat:${session.id}`,
          role: "session",
          content: combinedContent,
          sessionId: session.id,
          turnIndex: 0,
          dateMs: baseTimestamp,
        }];

        const result = await nativeMemorySearch.indexBatch(rows);
        if (result?.error) {
          log(`[TMDBG Memory Indexer] Migration: session ${session.id} failed: ${result.error}`, "warn");
          failedSessions++;
        } else {
          totalIndexed += 1;
          successfulSessions++;
          newlyMigrated.push(session.id);
        }
      } catch (e) {
        log(`[TMDBG Memory Indexer] Migration: session ${session.id} error: ${e}`, "warn");
        failedSessions++;
      }
    }

    // Save progress (successfully migrated sessions)
    if (newlyMigrated.length > 0) {
      const allMigrated = [...alreadyMigrated, ...newlyMigrated];
      await browser.storage.local.set({ [MIGRATED_SESSIONS_KEY]: allMigrated });
    }

    // Mark complete only if ALL sessions are now migrated
    const totalMigrated = alreadyMigrated.size + newlyMigrated.length;
    if (totalMigrated >= allSessions.length) {
      await browser.storage.local.set({ [MIGRATION_FLAG_KEY]: Date.now() });
      await browser.storage.local.remove(MIGRATED_SESSIONS_KEY); // Clean up tracking
      log(`[TMDBG Memory Indexer] Migration complete: ${totalIndexed} turns from ${successfulSessions} sessions (all ${allSessions.length} done)`);
    } else {
      log(`[TMDBG Memory Indexer] Migration progress: ${totalMigrated}/${allSessions.length} sessions, ${failedSessions} failed (will retry)`);
    }

    return { ok: successfulSessions > 0, migrated: true, sessions: successfulSessions, indexed: totalIndexed };
  } catch (e) {
    log(`[TMDBG Memory Indexer] Migration error: ${e}`, "error");
    return { ok: false, error: String(e), migrated: false, sessions: 0, indexed: 0 };
  }
}
