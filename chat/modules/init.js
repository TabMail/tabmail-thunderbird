// init.js – greet user and prime chat (persistent infinite chat)
// Thunderbird 145 MV3

import { SETTINGS } from "../../agent/modules/config.js";
import {
  getUserKBPrompt
} from "../../agent/modules/promptGenerator.js";
import {
  formatRemindersForDisplay,
  getRandomReminders,
} from "../../agent/modules/reminderBuilder.js";
import { ctx } from "./context.js";
import { getUserName, streamText } from "./helpers.js";

import { buildInboxContext } from "../../agent/modules/inboxContext.js";
import { log } from "../../agent/modules/utils.js";

import { createNewAgentBubble } from "../chat.js";
import { awaitUserInput } from "./converse.js";
import { updateEmailCacheForMentions } from "./mentionAutocomplete.js";

import {
  loadTurns,
  loadMeta,
  saveMeta,
  saveTurns,
  turnsToLLMMessages,
  migrateFromSessions,
  generateTurnId,
  enforceBudget,
  getMaxExchanges,
} from "./persistentChatStore.js";
import {
  initIdTranslation,
  mergeIdMapFromHeadless,
  collectTurnRefs,
  registerTurnRefs,
  unregisterTurnRefs,
  cleanupEvictedIds,
  buildRefCounts,
} from "./idTranslator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const IDLE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const LAZY_RENDER_VIEWPORT_TURNS = 10; // render this many turns first (visible viewport)

export async function initAndGreetUser() {
  // Step 1: Run one-time migration from session-based history
  try {
    await migrateFromSessions();
  } catch (e) {
    log(`[TMDBG Init] Migration failed (continuing): ${e}`, "warn");
  }

  // Step 2: Load persistent state
  const [persistedTurns, meta] = await Promise.all([
    loadTurns(),
    loadMeta(),
  ]);

  // Store on ctx for converse.js access (shared mutable references)
  ctx.persistedTurns = persistedTurns;
  ctx.chatMeta = meta;

  // Step 3: Initialize idTranslation from persistent storage (not reset)
  try {
    await initIdTranslation();
    log(`[TMDBG Init] Initialized idTranslation from persistent store`);
  } catch (e) {
    log(`[TMDBG Init] Failed to init idTranslation: ${e}`, "warn");
  }

  // Step 3b: One-time migration — compute _refs for existing turns, build refCounts
  try {
    const refsMigFlag = await browser.storage.local.get("chat_refs_migration_v1");
    if (!refsMigFlag["chat_refs_migration_v1"] && persistedTurns.length > 0) {
      log(`[TMDBG Init] Running refs migration for ${persistedTurns.length} turns`);
      for (const turn of persistedTurns) {
        turn._refs = collectTurnRefs(turn);
      }
      saveTurns(persistedTurns);
      buildRefCounts(persistedTurns);
      await browser.storage.local.set({ "chat_refs_migration_v1": Date.now() });
      log(`[TMDBG Init] Refs migration complete`);
    }
  } catch (e) {
    log(`[TMDBG Init] Refs migration failed (non-fatal): ${e}`, "warn");
  }

  // Step 4: Build inbox context and user name (needed for both returning and first-time)
  const [inboxContextJson, userName] = await Promise.all([
    buildInboxContext(),
    getUserName(),
  ]);

  let total = 0,
    countArchive = 0,
    countDelete = 0,
    countReply = 0;
  try {
    const inboxItems = JSON.parse(inboxContextJson);
    if (Array.isArray(inboxItems)) {
      total = inboxItems.length;
      inboxItems.forEach((itm) => {
        switch ((itm.action || "").toLowerCase()) {
          case "archive":
            countArchive += 1;
            break;
          case "delete":
            countDelete += 1;
            break;
          case "reply":
            countReply += 1;
            break;
          default:
            break;
        }
      });

      // Update email cache for @ mention autocomplete
      try {
        await updateEmailCacheForMentions(inboxItems);
        log(`[TMDBG Init] Updated email cache for mentions: ${inboxItems.length} emails`);
      } catch (e) {
        log(`[TMDBG Init] Failed to update email cache for mentions: ${e}`, "warn");
      }
    }
  } catch (e) {
    log(`[TMDBG Init] Failed to parse inboxContextJson: ${e}`, "error");
  }

  // Step 5: Build fresh system prompt (always use latest KB, reminders)
  const systemMessage = await _buildSystemMessage(userName);

  // Step 6: Branch — returning user (has turns) or first time
  if (persistedTurns.length > 0) {
    await _initReturningUser(persistedTurns, meta, systemMessage, userName);
  } else {
    await _initFirstTimeUser(meta, systemMessage, userName, {
      total, countArchive, countDelete, countReply,
    });
  }

  // Step 7: Decide pending suggestion
  try {
    ctx.pendingSuggestion = "anything urgent?";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}

  awaitUserInput();
}

// ---------------------------------------------------------------------------
// Returning user: rebuild conversation from persistent turns
// ---------------------------------------------------------------------------

async function _initReturningUser(persistedTurns, meta, systemMessage, userName) {
  log(`[TMDBG Init] Returning user: ${persistedTurns.length} persisted turns, lastActivity=${meta.lastActivityTs}`);

  // Strip trailing nudges (welcome_back/proactive) from persisted turns before rendering.
  // A fresh nudge will be inserted below — we never want stale nudges from prior sessions
  // lingering in the rendered history.
  let strippedCount = 0;
  while (persistedTurns.length > 0) {
    const last = persistedTurns[persistedTurns.length - 1];
    if (last._type !== "welcome_back" && last._type !== "proactive") break;
    persistedTurns.pop();
    meta.totalChars -= (last._chars || 0);
    unregisterTurnRefs(last);
    strippedCount++;
  }
  if (strippedCount > 0) {
    log(`[TMDBG Init] Stripped ${strippedCount} trailing nudge(s) from persisted turns`);
    saveTurns(persistedTurns);
    saveMeta(meta);
  }

  // Enforce budget on load (handles user lowering max_chat_exchanges since last open)
  const maxExchanges = await getMaxExchanges();
  const evictedOnLoad = enforceBudget(persistedTurns, meta, maxExchanges);
  if (evictedOnLoad.length > 0) {
    log(`[TMDBG Init] Budget enforcement on load evicted ${evictedOnLoad.length} turns (maxExchanges=${maxExchanges})`);
    cleanupEvictedIds(evictedOnLoad);
    saveTurns(persistedTurns);
    saveMeta(meta);
  }

  // Build agentConverseMessages: system prompt + all persisted turns
  ctx.agentConverseMessages = [systemMessage, ...turnsToLLMMessages(persistedTurns)];
  ctx.greetedUser = true;

  // Lazy render: render bottom (viewport) first, then older turns above
  const chatContainer = document.getElementById("chat-container");
  const totalTurns = persistedTurns.length;
  const splitIdx = Math.max(0, totalTurns - LAZY_RENDER_VIEWPORT_TURNS);

  // Show truncation indicator if turns were evicted (we can detect this from meta)
  // Also shown if budget enforcement happened during load
  const truncationIndicator = document.createElement("div");
  truncationIndicator.className = "history-truncated";
  truncationIndicator.id = "history-truncated-indicator";
  truncationIndicator.textContent = "Earlier messages moved to searchable memory";
  truncationIndicator.style.display = "none"; // show only if we know there were evictions
  if (chatContainer) chatContainer.prepend(truncationIndicator);

  // First pass: render visible viewport turns (last N) synchronously to avoid flash.
  // _renderTurnSync places all elements in the DOM in a single JS frame — browser
  // repaints only after we've scrolled to bottom, so no top-to-bottom flash.
  const viewportTurns = persistedTurns.slice(splitIdx);
  for (const turn of viewportTurns) {
    _renderTurnSync(turn, chatContainer, null); // null beforeNode = append at end
  }

  // Scroll to bottom before browser repaints
  if (chatContainer) {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  // Second pass: render older turns above (lazy, via requestIdleCallback)
  if (splitIdx > 0) {
    truncationIndicator.style.display = "";
    const olderTurns = persistedTurns.slice(0, splitIdx);
    const renderOlder = () => {
      // Insert older turns before the viewport turns
      const firstViewportElement = chatContainer?.children[1]; // [0] is truncation indicator
      for (const turn of olderTurns) {
        _renderTurnSync(turn, chatContainer, firstViewportElement);
      }
      log(`[TMDBG Init] Lazy-rendered ${olderTurns.length} older turns`);
    };

    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(renderOlder);
    } else {
      setTimeout(renderOlder, 100);
    }
  }

  // Insert nudge: proactive message (if pending) OR welcome-back with reminders.
  // These are mutually exclusive — proactive nudge takes priority.
  let proactiveText = null;
  try {
    const { consumePendingProactiveMessage } = await import("../../agent/modules/proactiveCheckin.js");
    const proactiveData = await consumePendingProactiveMessage();
    if (proactiveData?.message) {
      let text = proactiveData.message;
      if (Array.isArray(proactiveData.idMapEntries) && proactiveData.idMapEntries.length > 0) {
        try {
          text = mergeIdMapFromHeadless(proactiveData.idMapEntries, text);
          log(`[TMDBG Init] Merged ${proactiveData.idMapEntries.length} idMap entries from proactive session`);
        } catch (e) {
          log(`[TMDBG Init] Failed to merge proactive idMap: ${e}`, "warn");
        }
      }
      proactiveText = text;
      log(`[TMDBG Init] Pending proactive message found (${proactiveText.length} chars)`);
    }
  } catch (e) {
    log(`[TMDBG Init] Failed to check proactive message: ${e}`, "warn");
  }

  if (proactiveText) {
    await _insertNudge(meta, proactiveText, "proactive");
  } else {
    // Build welcome-back text with reminders
    const parts = [`Welcome back ${userName}`];
    if (SETTINGS.reminderGeneration?.showInChat) {
      try {
        const reminderData = await getRandomReminders(3);
        if (reminderData?.reminders?.length > 0) {
          const formatted = formatRemindersForDisplay(reminderData.reminders);
          parts.push(`, a few reminders:\n\n${formatted}\n\n`);
        } else {
          parts.push("!\n\n");
        }
      } catch (e) {
        parts.push("!\n\n");
      }
    } else {
      parts.push("!\n\n");
    }
    parts.push("What would you like to do?");
    await _insertNudge(meta, parts.join(""), "welcome_back");
  }

  log(`[TMDBG Init] Returning user init complete (${persistedTurns.length} turns rendered)`);
}

// ---------------------------------------------------------------------------
// First-time user: standard greeting flow
// ---------------------------------------------------------------------------

async function _initFirstTimeUser(meta, systemMessage, userName, inboxCounts) {
  log(`[TMDBG Init] First-time user`);

  // Check for pending proactive check-in message
  let proactiveMessage = null;
  try {
    const { consumePendingProactiveMessage } = await import("../../agent/modules/proactiveCheckin.js");
    const proactiveData = await consumePendingProactiveMessage();
    if (proactiveData?.message) {
      // Restore idMap from headless session
      if (Array.isArray(proactiveData.idMapEntries) && proactiveData.idMapEntries.length > 0) {
        try {
          const { restoreIdMap } = await import("./idTranslator.js");
          restoreIdMap(proactiveData.idMapEntries);
          log(`[TMDBG Init] Restored idMap with ${proactiveData.idMapEntries.length} entries from proactive session`);
        } catch (e) {
          log(`[TMDBG Init] Failed to restore proactive idMap: ${e}`, "warn");
        }
      }
      proactiveMessage = proactiveData.message;
      log(`[TMDBG Init] Pending proactive message found (${proactiveMessage.length} chars)`);
    }
  } catch (e) {
    log(`[TMDBG Init] Failed to check proactive message: ${e}`, "warn");
  }

  let displayText = "";
  let isProactiveBubble = false;

  if (proactiveMessage) {
    displayText = proactiveMessage;
    isProactiveBubble = true;
    ctx.greetedUser = true;
  } else if (!ctx.greetedUser) {
    const { total, countArchive, countDelete, countReply } = inboxCounts;
    const greetingParts = [
      `Hello ${userName},\n\n`,
      `You currently have a total of ${total} emails, with ${countArchive} marked for archiving, `,
      `${countDelete} marked for deletion, and ${countReply} marked for replying.\n\n`,
    ];

    // Add reminders if available and enabled
    if (SETTINGS.reminderGeneration?.showInChat) {
      try {
        const stored = await browser.storage.local.get({
          maxRemindersToShow: SETTINGS.reminderGeneration?.maxRemindersToShow || 2,
        });
        const maxReminders = stored.maxRemindersToShow || 2;

        const reminderData = await getRandomReminders(maxReminders);
        if (reminderData?.reminders?.length > 0) {
          const formattedReminders = formatRemindersForDisplay(reminderData.reminders);
          greetingParts.push(formattedReminders);
          log(`[TMDBG Init] Showing ${reminderData.reminders.length} reminders`);
        }
      } catch (e) {
        log(`[TMDBG Init] Failed to get reminders: ${e}`, "warn");
      }
    }

    greetingParts.push("What would you like to do next?");
    displayText = greetingParts.join("");
    ctx.greetedUser = true;
  } else {
    displayText = "What would you like to do next?";
  }

  // Render greeting bubble
  const agentBubble = await createNewAgentBubble("");
  agentBubble.classList.remove("loading");
  if (isProactiveBubble) {
    agentBubble.classList.add("proactive-message");
  }
  streamText(agentBubble, displayText);

  // Initialize agentConverseMessages with system prompt + greeting
  ctx.agentConverseMessages = [systemMessage];
  if (displayText && ctx.greetedUser) {
    ctx.agentConverseMessages.push({
      role: "assistant",
      content: displayText,
    });
  }

  // Persist greeting as first turn
  const greetingTurn = {
    role: "assistant",
    content: displayText,
    _id: generateTurnId(),
    _ts: Date.now(),
    _type: isProactiveBubble ? "proactive" : "greeting",
    _chars: displayText.length,
  };

  // Generate rendered HTML snapshot for persistence
  try {
    const { renderMarkdown } = await import("./markdown.js");
    greetingTurn._rendered = await renderMarkdown(displayText);
  } catch (e) {
    log(`[TMDBG Init] Failed to generate greeting snapshot: ${e}`, "warn");
  }

  greetingTurn._refs = collectTurnRefs(greetingTurn);
  registerTurnRefs(greetingTurn);

  ctx.persistedTurns.push(greetingTurn);
  meta.totalChars = greetingTurn._chars;
  meta.lastActivityTs = Date.now();
  saveMeta(meta);

  // Use direct storage save for first turn (no existing turns to append to)
  try {
    await browser.storage.local.set({ chat_turns: ctx.persistedTurns });
    log(`[TMDBG Init] Persisted greeting turn`);
  } catch (e) {
    log(`[TMDBG Init] Failed to persist greeting turn: ${e}`, "warn");
  }

  // Proactive message: use default placeholder
  if (isProactiveBubble) {
    ctx.pendingSuggestion = "";
  }

  log(`[TMDBG Init] First-time user init complete`);
}

// ---------------------------------------------------------------------------
// Build fresh system message (always latest KB, reminders, no recent_chat_history)
// ---------------------------------------------------------------------------

async function _buildSystemMessage(userName) {
  let userKBContent = "";
  try {
    userKBContent = (await getUserKBPrompt()) || "";
    log(`[TabMail KB] Loaded user KB content (${userKBContent.length} chars) for conversation.`);
  } catch (e) {
    log(`[TabMail KB] Failed to load user KB content: ${e}`, "warn");
  }

  let remindersJson = "";
  try {
    const { reminders } = await import("../../agent/modules/reminderBuilder.js").then(m => m.buildReminderList());
    if (reminders && reminders.length > 0) {
      let translatedReminders = reminders;
      try {
        const { processToolResultTBtoLLM } = await import("./idTranslator.js");
        translatedReminders = processToolResultTBtoLLM(reminders);
        log(`[TabMail Reminders] Applied ID translation to ${reminders.length} reminders`);
      } catch (e) {
        log(`[TabMail Reminders] ID translation failed, using original reminders: ${e}`, "warn");
      }
      remindersJson = JSON.stringify(translatedReminders);
      log(`[TabMail Reminders] Loaded ${reminders.length} reminders for agent context.`);
    }
  } catch (e) {
    log(`[TabMail Reminders] Failed to load reminders: ${e}`, "warn");
  }

  // No recent_chat_history — historical turns ARE the actual conversation messages now
  return {
    role: "system",
    content: "system_prompt_agent",
    user_name: userName,
    user_kb_content: userKBContent,
    user_reminders_json: remindersJson,
    recent_chat_history: "", // empty — backend will skip this section
  };
}

// ---------------------------------------------------------------------------
// Welcome-back greeting (inserted after idle period)
// ---------------------------------------------------------------------------

/**
 * Insert a nudge (welcome_back or proactive) into the conversation.
 * Nudges are rendered to DOM and added to agentConverseMessages immediately, but
 * NOT persisted to chat_turns yet. They become persisted only when the user sends
 * their next message (via consumePendingNudge in converse.js). This prevents
 * trailing nudges from accumulating in storage across window opens.
 * If a previous nudge exists in this session, it is replaced.
 * Guarded by _nudgeInProgress lock to prevent async race conditions.
 */
let _nudgeInProgress = false;
let _currentNudgeDOMRow = null; // Track current nudge's DOM element for replacement
let _pendingNudgeTurn = null; // Nudge turn waiting to be persisted on next user message
async function _insertNudge(meta, text, type) {
  if (_nudgeInProgress) {
    log(`[TMDBG Init] Skipping ${type} nudge (another nudge already in progress)`);
    return;
  }
  _nudgeInProgress = true;
  try {
    log(`[TMDBG Init] Inserting ${type} nudge (idle ${Math.round((Date.now() - meta.lastActivityTs) / 60000)} min)`);

    const chatContainer = document.getElementById("chat-container");

    // Remove previous in-session nudge if one exists (e.g. repeated tab refocus)
    if (_currentNudgeDOMRow) {
      _currentNudgeDOMRow.remove();
      _currentNudgeDOMRow = null;
      _pendingNudgeTurn = null;
      // Pop the corresponding entry from agentConverseMessages
      if (ctx.agentConverseMessages.length > 1) {
        ctx.agentConverseMessages.pop();
      }
      log(`[TMDBG Init] Replaced previous in-session nudge`);
    }

    // Build the nudge turn object (not yet persisted — will be persisted when user
    // sends their next message, via consumePendingNudge())
    _pendingNudgeTurn = {
      role: "assistant",
      content: text,
      _id: generateTurnId(),
      _ts: Date.now(),
      _type: type,
      _chars: text.length,
    };

    // Generate rendered HTML snapshot for persistence (streamText is fire-and-forget,
    // so we generate _rendered via renderMarkdown directly)
    try {
      const { renderMarkdown } = await import("./markdown.js");
      _pendingNudgeTurn._rendered = await renderMarkdown(text);
    } catch (e) {
      log(`[TMDBG Init] Failed to generate nudge snapshot: ${e}`, "warn");
    }

    // Add to agentConverseMessages
    ctx.agentConverseMessages.push({
      role: "assistant",
      content: text,
    });

    // Render bubble
    const agentBubble = await createNewAgentBubble("");
    agentBubble.classList.remove("loading");
    if (type === "welcome_back") agentBubble.classList.add("welcome-back");
    if (type === "proactive") agentBubble.classList.add("proactive-message");
    streamText(agentBubble, text);

    // Track the DOM row for future replacement
    _currentNudgeDOMRow = agentBubble.closest(".message-row") || agentBubble;

    // Grey out all preceding bubbles
    if (chatContainer) {
      for (const child of chatContainer.children) {
        if (child === _currentNudgeDOMRow) break;
        if (child.classList && !child.classList.contains("history-truncated")) {
          child.classList.add("history-pre-welcome");
        }
      }
    }

    meta.lastActivityTs = Date.now();
    saveMeta(meta);

    log(`[TMDBG Init] ${type} nudge inserted (ephemeral, not persisted)`);
  } catch (e) {
    log(`[TMDBG Init] Failed to insert ${type} nudge: ${e}`, "error");
  } finally {
    _nudgeInProgress = false;
  }
}

/**
 * Insert a proactive nudge into the chat. Exported wrapper around _insertNudge
 * for use by chat.js's runtime message handler when a proactive check-in arrives
 * while the chat window is already open. This ensures the nudge system properly
 * replaces any existing welcome-back greeting.
 * @param {string} text - The proactive message text
 */
export async function insertProactiveNudge(text) {
  const meta = ctx.chatMeta;
  if (!meta) {
    log(`[TMDBG Init] Cannot insert proactive nudge: no chatMeta`, "warn");
    return;
  }
  await _insertNudge(meta, text, "proactive");
}

/**
 * Consume the pending nudge turn. Called from converse.js when the user sends
 * a message — at that point the nudge is no longer trailing and should be persisted.
 * Returns the nudge turn object (caller persists it), or null if none pending.
 */
export function consumePendingNudge() {
  const nudge = _pendingNudgeTurn;
  _pendingNudgeTurn = null;
  _currentNudgeDOMRow = null; // No longer replaceable once persisted
  return nudge;
}

// ---------------------------------------------------------------------------
// Render helpers for persisted turns
// ---------------------------------------------------------------------------


/**
 * Render a turn synchronously, inserting before a reference node (for lazy render).
 */
function _renderTurnSync(turn, container, beforeNode) {
  try {
    if (!container) return;

    if (turn._type === "separator") {
      const sep = document.createElement("div");
      sep.className = "topic-separator";
      sep.textContent = turn.content?.replace("--- ", "").replace(" ---", "") || "New topic";
      container.insertBefore(sep, beforeNode);
      return;
    }

    if (turn.role === "user") {
      const text = turn.user_message || turn.content || "";
      if (text) {
        // Create a simple user bubble without the full createNewUserBubble flow
        const row = document.createElement("div");
        row.className = "message-row user-row";
        const bubble = document.createElement("div");
        bubble.className = "message user-message";
        if (turn._rendered) {
          // Use pre-rendered snapshot (resolves [Email](N) refs to readable text)
          bubble.innerHTML = turn._rendered;
          bubble.classList.add("history-static");
        } else {
          bubble.textContent = text;
        }
        row.appendChild(bubble);
        container.insertBefore(row, beforeNode);
      }
    } else if (turn.role === "assistant") {
      const row = document.createElement("div");
      row.className = "message-row agent-row";
      const bubble = document.createElement("div");
      bubble.className = "message agent-message";
      if (turn._type === "proactive") bubble.classList.add("proactive-message");
      if (turn._type === "welcome_back") bubble.classList.add("welcome-back");

      if (turn._rendered) {
        // Fast path: pre-rendered snapshot — non-clickable, no async, instant
        bubble.innerHTML = turn._rendered;
        bubble.classList.add("history-static");
      } else {
        // Fallback: live render for turns without snapshot (pre-upgrade turns)
        bubble.textContent = turn.content || "";
        import("./markdown.js").then(({ renderMarkdown, attachSpecialLinkListeners }) =>
          renderMarkdown(turn.content || "").then(html => {
            bubble.innerHTML = html;
            attachSpecialLinkListeners(bubble);
          })
        ).catch(() => {});
      }

      row.appendChild(bubble);
      container.insertBefore(row, beforeNode);
    }
  } catch (e) {
    log(`[TMDBG Init] Failed to sync-render turn ${turn._id}: ${e}`, "warn");
  }
}

// ---------------------------------------------------------------------------
// Public helpers for chat.js (idle detection, new topic)
// ---------------------------------------------------------------------------

/**
 * Check if user has been idle beyond threshold and insert welcome-back greeting.
 * Called on visibilitychange (tab focus) from chat.js.
 */
export async function checkAndInsertWelcomeBack() {
  const meta = ctx.chatMeta;
  if (!meta || !meta.lastActivityTs) return;
  const idleMs = Date.now() - meta.lastActivityTs;
  if (idleMs <= IDLE_THRESHOLD_MS) return;

  const userName = await getUserName();
  const parts = [`Welcome back ${userName}`];
  if (SETTINGS.reminderGeneration?.showInChat) {
    try {
      const reminderData = await getRandomReminders(3);
      if (reminderData?.reminders?.length > 0) {
        const formatted = formatRemindersForDisplay(reminderData.reminders);
        parts.push(`, a few reminders:\n\n${formatted}\n\n`);
      } else {
        parts.push("!\n\n");
      }
    } catch (e) {
      parts.push("!\n\n");
    }
  } else {
    parts.push("!\n\n");
  }
  parts.push("What would you like to do?");
  await _insertNudge(meta, parts.join(""), "welcome_back");
}


