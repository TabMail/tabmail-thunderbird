// chat.js – UI for TabMail chat window
// Thunderbird 140 MV3

import { log } from "../agent/modules/utils.js";
import { applyUiFontVarsToDocument } from "../gui/modules/uiFontSizeDocument.js";
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";
import { processUserInput } from "./fsm/core.js";
import { CHAT_SETTINGS } from "./modules/chatConfig.js";
import { ctx } from "./modules/context.js";
import { awaitUserInput } from "./modules/converse.js";
import { cleanupScrollObservers, initAggressiveScrollStick, isAtBottom, scrollToBottom, setBubbleText, setStickToBottom } from "./modules/helpers.js";
import { mergeIdMapFromHeadless, persistIdMapImmediate, remapUniqueId } from "./modules/idTranslator.js";
import { checkAndInsertWelcomeBack, initAndGreetUser, insertProactiveNudge } from "./modules/init.js";
import { saveTurnsImmediate, saveMetaImmediate } from "./modules/persistentChatStore.js";
import { cleanupMentionAutocomplete, clearContentEditable, extractMarkdownFromContentEditable, initMentionAutocomplete } from "./modules/mentionAutocomplete.js";
import { addToolBubbleToGroup, cleanupToolGroups, isToolCollapseEnabled } from "./modules/toolCollapse.js";
import { shutdownToolWebSocket } from "./modules/wsTools.js";

let chatMode = "send"; // "send", "stop", or "retry"

function setChatMode(mode) {
  chatMode = mode;
  const btn = document.getElementById("send-btn");
  if (btn) {
    btn.disabled = false;
    btn.classList.remove("stop-mode", "retry-mode");
    if (mode === "send") {
      btn.innerHTML = "&#x27A4;"; // Send arrow
      btn.title = "Send ⏎";
    } else if (mode === "stop") {
      btn.innerHTML = "&#x25A0;"; // Stop square
      btn.title = "Stop (Esc)";
      btn.classList.add("stop-mode");
    } else if (mode === "retry") {
      btn.innerHTML = "&#x21BB;"; // Retry arrow (clockwise arrow)
      btn.title = "Retry ⏎";
      btn.classList.add("retry-mode");
    }
  }
  log(`[TMDBG Chat] Chat mode set to: ${mode}`);
}

/**
 * Update send button to show retry when:
 * - Input is empty
 * - canRetry is true (there was an error)
 * - chatMode is "send" (not in stop mode)
 */
function updateRetryVisibility() {
  try {
    const textarea = document.getElementById("user-input");
    const hintEl = document.getElementById("input-suggestion-hint");
    const val = (textarea?.textContent || "").trim();
    const canRetry = ctx.canRetry || false;
    const defaultPlaceholder = textarea?.getAttribute("data-default-placeholder") || 
                               "Type a message or @ to mention anything in inbox or the chat...";
    
    // Only show retry button when input is empty, can retry, and in send mode
    if (!val && canRetry && chatMode !== "stop") {
      setChatMode("retry");
      // Set placeholder to retry hint
      if (textarea) {
        textarea.setAttribute("data-placeholder", "Press Enter to retry...");
        textarea.classList.add("has-retry-suggestion");
      }
      if (hintEl) {
        hintEl.textContent = "Press Enter to retry, or type a new message";
        hintEl.hidden = false;
      }
    } else if (chatMode === "retry" && (val || !canRetry)) {
      // Switch back to send mode if user starts typing or retry is no longer available
      setChatMode("send");
      // Restore default placeholder
      if (textarea) {
        textarea.setAttribute("data-placeholder", defaultPlaceholder);
        textarea.classList.remove("has-retry-suggestion");
      }
      if (hintEl) {
        hintEl.hidden = true;
      }
    }
    
    log(`[TMDBG Chat] updateRetryVisibility: val="${val.substring(0, 20)}", canRetry=${canRetry}, chatMode=${chatMode}`);
  } catch (e) {
    log(`[TMDBG Chat] updateRetryVisibility failed: ${e}`, "warn");
  }
}

// Expose retry visibility update globally
window.tmUpdateRetryVisibility = updateRetryVisibility;

async function stopExecution() {
  log(`[TMDBG Chat] Stop execution requested`);
  
  try {
    // Abort the current chat operation if it exists
    if (window.currentChatAbortController) {
      window.currentChatAbortController.abort();
      log(`[TMDBG Chat] Aborted current chat operation`);
    } else {
      log(`[TMDBG Chat] No active chat operation to abort`);
    }
    
    // Clean up all pending operations
    try {
      // 1. Stop SSE tool listener if active
      try {
        const { stopToolListener } = await import("./modules/sseTools.js");
        stopToolListener();
        log(`[TMDBG Chat] Stopped SSE tool listener`);
      } catch (e) {
        log(`[TMDBG Chat] Failed to stop SSE tool listener: ${e}`, "warn");
      }
      
      // 2. Clean up all FSM waiters (resolve them with cancelled status)
      if (ctx && ctx.fsmWaiters && typeof ctx.fsmWaiters === "object") {
        const pids = Object.keys(ctx.fsmWaiters);
        log(`[TMDBG Chat] Cleaning up ${pids.length} pending FSM waiter(s)`);
        for (const pid of pids) {
          try {
            const waiter = ctx.fsmWaiters[pid];
            if (waiter && typeof waiter.resolve === "function") {
              waiter.resolve({ ok: false, output: "User stopped execution" });
              log(`[TMDBG Chat] Resolved FSM waiter for pid=${pid} with stop status`);
            }
          } catch (e) {
            log(`[TMDBG Chat] Failed to resolve FSM waiter for pid=${pid}: ${e}`, "warn");
          }
        }
        ctx.fsmWaiters = {};
      }
      
      // 3. Remove all tool bubbles (both regular and server-side) with loading indicators
      const container = document.getElementById("chat-container");
      if (container) {
        const toolBubbles = container.querySelectorAll(".agent-message.loading, .agent-message.tool.loading");
        log(`[TMDBG Chat] Removing ${toolBubbles.length} tool bubble(s) with loading indicators`);
        toolBubbles.forEach(bubble => {
          try {
            bubble.remove();
            log(`[TMDBG Chat] Removed tool bubble`);
          } catch (e) {
            log(`[TMDBG Chat] Failed to remove bubble: ${e}`, "warn");
          }
        });
      }
      
      // 4. Clear active tool call ids
      if (ctx) {
        ctx.activeToolCallId = null;
        ctx.activePid = null;
      }
      
      // 5. Show system message that user stopped
      const systemBubble = appendSystemBubble(container);
      systemBubble.textContent = "User stopped execution";
      log(`[TMDBG Chat] Added 'User stopped' system message`);
      
    } catch (cleanupError) {
      log(`[TMDBG Chat] Cleanup error: ${cleanupError}`, "error");
    }
    
    // Reset to await user input
    setChatMode("send");
    awaitUserInput();
    
    log(`[TMDBG Chat] Stop execution completed`);
  } catch (e) {
    log(`[TMDBG Chat] Error during stop execution: ${e}`, "error");
    // Still try to reset to a clean state
    setChatMode("send");
    awaitUserInput();
  }
}


window.setChatMode = setChatMode;
window.stopExecution = stopExecution;

export function appendAgentBubble(
  container = document.getElementById("chat-container")
) {
  const bubble = document.createElement("div");
  bubble.className = "agent-message";
  const content = document.createElement("span");
  content.className = "bubble-content";
  bubble.appendChild(content);
  container.appendChild(bubble);
  try {
    scrollToBottom(container, CHAT_SETTINGS?.scrollFramesOnAppend || 2);
  } catch (_) {
    container.scrollTop = container.scrollHeight;
  }
  return bubble;
}

export function appendSystemBubble(
  container = document.getElementById("chat-container")
) {
  const bubble = document.createElement("div");
  bubble.className = "system-message";
  const content = document.createElement("span");
  content.className = "bubble-content";
  bubble.appendChild(content);
  container.appendChild(bubble);
  try {
    scrollToBottom(container, CHAT_SETTINGS?.scrollFramesOnAppend || 2);
  } catch (_) {
    container.scrollTop = container.scrollHeight;
  }
  return bubble;
}

export async function createNewAgentBubble(initialText = "") {
  const container = document.getElementById("chat-container");
  const bubble = appendAgentBubble(container);
  bubble.classList.add("loading");
  
  // Check if this is a tool bubble (inside an active FSM/tool session)
  let isToolBubble = false;
  try {
    if (ctx && (ctx.awaitingPid || ctx.activePid || ctx.activeToolCallId)) {
      bubble.classList.add("tool");
      try { bubble.setAttribute("data-pid", String(ctx.awaitingPid || ctx.activePid || ctx.activeToolCallId)); } catch (_) {}
      isToolBubble = true;
    }
  } catch (_) {}
  
  if (typeof initialText === "string") {
    try {
      await setBubbleText(bubble, initialText);
    } catch (e) {
      // Keep this path noisy: if Markdown rendering fails, we want logs to diagnose quickly.
      bubble.textContent = initialText;
      try { log(`[TMDBG Chat] createNewAgentBubble initialText render failed: ${e}`, "warn"); } catch (_) {}
    }
  }

  // If this is a tool bubble and collapsing is enabled, add to tool group
  if (isToolBubble && isToolCollapseEnabled()) {
    try {
      // Pass the initialText as the activity label for the header
      const activityLabel = typeof initialText === "string" ? initialText : null;
      addToolBubbleToGroup(bubble, container, activityLabel);
    } catch (e) {
      log(`[Chat] Failed to add tool bubble to group: ${e}`, "warn");
    }
  }

  const OBS_SYM = Symbol.for("tm_scrollObserver");
  if (!bubble[OBS_SYM]) {
    const observer = new MutationObserver(() => {
      try {
        scrollToBottom(container, CHAT_SETTINGS?.scrollFramesOnMutation || 1);
      } catch (_) {
        container.scrollTop = container.scrollHeight;
      }
    });
    observer.observe(bubble, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    bubble[OBS_SYM] = observer;
  }

  await new Promise((r) => requestAnimationFrame(r));
  return bubble;
}

export function createNewUserBubble(text) {
  const container = document.getElementById("chat-container");
  const bubble = document.createElement("div");
  bubble.className = "user-message";
  const content = document.createElement("span");
  content.className = "bubble-content";
  bubble.appendChild(content);
  
  // Check if this is inside an FSM tool session
  let isToolBubble = false;
  try {
    if (ctx && (ctx.awaitingPid || ctx.activePid)) {
      bubble.classList.add("tool");
      try { bubble.setAttribute("data-pid", String(ctx.awaitingPid || ctx.activePid)); } catch (_) {}
      isToolBubble = true;
    }
  } catch (_) {}
  
  try {
    // setBubbleText is async; use explicit catch so failures don't silently become unhandled rejections.
    void setBubbleText(bubble, text || "").catch((e) => {
      content.textContent = text;
      log(`[TMDBG Chat] setBubbleText failed for user bubble: ${e}`, "warn");
    });
  } catch (e) {
    content.textContent = text;
    log(`[TMDBG Chat] setBubbleText invocation failed for user bubble: ${e}`, "warn");
  }
  
  container.appendChild(bubble);
  
  // If this is a tool session user bubble and collapsing is enabled, add to tool group
  if (isToolBubble && isToolCollapseEnabled()) {
    try {
      addToolBubbleToGroup(bubble, container);
    } catch (e) {
      log(`[Chat] Failed to add user tool bubble to group: ${e}`, "warn");
    }
  }
  
  try {
    scrollToBottom(container, CHAT_SETTINGS?.scrollFramesOnAppend || 2);
  } catch (_) {
    container.scrollTop = container.scrollHeight;
  }
}

// Message selection tracking and UI updates
let currentSelectionCount = 0;

// Context usage tracking
let currentTokenUsage = null;

function initContextUsageTracking() {
  try {
    // Listen for token usage updates from conversation flows
    window.addEventListener("tokenUsageUpdated", (event) => {
      updateContextUsageDisplay(event.detail);
    });

    // Set initial tooltip for progress bar
    const progressBar = document.getElementById("context-progress-bar");
    if (progressBar) {
      progressBar.title = "Shorter context provides better answers. Agent won't answer beyond limit.";
    }

    log("[ContextUsage] Initialized context usage tracking");
  } catch (e) {
    log(`[ContextUsage] Failed to initialize: ${e}`, "error");
  }
}

function updateContextUsageDisplay(tokenUsage) {
  try {
    currentTokenUsage = tokenUsage;

    const container = document.getElementById("context-usage-container");
    const progressBar = document.getElementById("context-progress-bar");
    const progressFill = document.getElementById("context-progress-fill");

    if (!container || !progressBar || !progressFill) {
      log("[ContextUsage] Progress bar elements not found", "warn");
      return;
    }

    // Update progress bar width
    const percentage = Math.min(
      100,
      Math.max(0, tokenUsage.usage_percentage || 0)
    );
    progressFill.style.width = `${percentage}%`;

    // Update tooltip with detailed information
    const tokensUsed = tokenUsage.total_tokens || 0;
    const contextLimit = tokenUsage.context_limit || 0;
    const remainingTokens = contextLimit - tokensUsed;

    const tooltipText =
      `${percentage}% used — Shorter context provides better answers. Agent won't answer beyond limit.`;

    progressBar.title = tooltipText;

    log(
      `[ContextUsage] Updated progress bar: ${percentage}% (${tokensUsed}/${contextLimit} tokens)`
    );
  } catch (e) {
    log(`[ContextUsage] Failed to update display: ${e}`, "error");
  }
}

// Expose functions for external use
window.updateContextUsageDisplay = updateContextUsageDisplay;

// Store listener references for cleanup
let messageSelectionListener = null;
let chatDOMListeners = {
  windowKeydownHandler: null,
  textareaInputHandler: null,
  textareaPasteHandler: null,
  windowResizeHandler: null,
  textareaKeydownHandler: null,
  sendClickHandler: null,
};

function cleanupMessageSelectionListener() {
  if (messageSelectionListener) {
    try {
      browser.runtime.onMessage.removeListener(messageSelectionListener);
      messageSelectionListener = null;
      log("[MessageSelection] Runtime message listener cleaned up");
    } catch (e) {
      log(
        `[MessageSelection] Failed to remove runtime message listener: ${e}`,
        "error"
      );
    }
  }
}

function cleanupChatDOMListeners() {
  try {
    // Remove window keydown handler
    if (chatDOMListeners.windowKeydownHandler) {
      window.removeEventListener(
        "keydown",
        chatDOMListeners.windowKeydownHandler
      );
      chatDOMListeners.windowKeydownHandler = null;
    }

    // Remove textarea input handler
    if (chatDOMListeners.textareaInputHandler) {
      const textarea = document.getElementById("user-input");
      if (textarea) {
        textarea.removeEventListener(
          "input",
          chatDOMListeners.textareaInputHandler
        );
      }
      chatDOMListeners.textareaInputHandler = null;
    }

    // Remove textarea paste handler
    if (chatDOMListeners.textareaPasteHandler) {
      const textarea = document.getElementById("user-input");
      if (textarea) {
        textarea.removeEventListener(
          "paste",
          chatDOMListeners.textareaPasteHandler
        );
      }
      chatDOMListeners.textareaPasteHandler = null;
    }

    // Remove window resize handler
    if (chatDOMListeners.windowResizeHandler) {
      window.removeEventListener(
        "resize",
        chatDOMListeners.windowResizeHandler
      );
      chatDOMListeners.windowResizeHandler = null;
    }

    // Remove textarea keydown handler
    if (chatDOMListeners.textareaKeydownHandler) {
      const textarea = document.getElementById("user-input");
      if (textarea) {
        textarea.removeEventListener(
          "keydown",
          chatDOMListeners.textareaKeydownHandler
        );
      }
      chatDOMListeners.textareaKeydownHandler = null;
    }

    // Remove send button click handler
    if (chatDOMListeners.sendClickHandler) {
      const sendBtn = document.getElementById("send-btn");
      if (sendBtn) {
        sendBtn.removeEventListener("click", chatDOMListeners.sendClickHandler);
      }
      chatDOMListeners.sendClickHandler = null;
    }

    // Clean up mention autocomplete
    cleanupMentionAutocomplete();

    // Clean up tool groups
    try {
      const chatContainer = document.getElementById("chat-container");
      if (chatContainer) {
        cleanupToolGroups(chatContainer);
      }
    } catch (e) {
      log(`[Chat] Failed to clean up tool groups: ${e}`, "warn");
    }

    log("[Chat] DOM event listeners cleaned up");
  } catch (e) {
    log(`[Chat] Failed to clean up DOM listeners: ${e}`, "error");
  }
}

async function initMessageSelectionTracking() {
  try {
    // Clean up any existing listener first
    cleanupMessageSelectionListener();

    // Listen for selection change messages from background script
    messageSelectionListener = (message, sender, sendResponse) => {
      if (message.command === "selection-changed") {
        updateSelectionFromMessage(message);
      } else if (message.command === "current-selection") {
        updateSelectionFromMessage(message);
        log("[MessageSelection] Received current selection from background");
      }
    };

    browser.runtime.onMessage.addListener(messageSelectionListener);

    // Request current selection from background script
    try {
      browser.runtime.sendMessage({ command: "get-current-selection" });
      log("[MessageSelection] Requested current selection from background");
    } catch (e) {
      log(
        `[MessageSelection] Failed to request current selection: ${e}`,
        "warn"
      );
      // Fallback to direct query with delay
      setTimeout(async () => {
        await updateSelectionIndicator();
      }, 500);
    }

    log("[MessageSelection] Initialized message selection tracking");
  } catch (e) {
    log(`[MessageSelection] Failed to initialize: ${e}`, "error");
  }
}

// Handle selection change messages from the experiment (event-driven)
// DISABLED: We now use @ mention UI instead of selection indicator
function updateSelectionFromMessage(message) {
  try {
    log(`[MessageSelection] updateSelectionFromMessage received (tracking for @ mentions):`, message);
    const selectionCount = message.selectionCount || 0;
    const selectedMessageIds = message.selectedMessageIds || [];

    log(
      `[MessageSelection] Selection count: ${selectionCount} (for @ mention autocomplete only)`
    );
    currentSelectionCount = selectionCount;
    // Track selected IDs for @ mention "selected email(s)" feature
    // The mention autocomplete will fetch email details on demand using parseUniqueId
    ctx.selectedMessageIds = selectedMessageIds;

    log(
      `[MessageSelection] Event-driven update - ${selectionCount} messages selected, IDs: ${selectedMessageIds.join(
        ", "
      )}`
    );
  } catch (e) {
    log(`[MessageSelection] Failed to update from message: ${e}`, "error");
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  // Inject TabMail palette CSS
  try {
    await injectPaletteIntoDocument(document);
    log("[TMDBG Chat] Palette CSS injected");
  } catch (e) {
    log(`[TMDBG Chat] Failed to inject palette CSS: ${e}`, "warn");
  }

  // Apply font sizes from Thunderbird prefs (UI + message) to this document.
  try {
    const res = await applyUiFontVarsToDocument({ document, source: "chat" });
    log(`[TMDBG Chat] applyUiFontVarsToDocument result: ${JSON.stringify(res)}`);
  } catch (e) {
    log(`[TMDBG Chat] applyUiFontVarsToDocument failed: ${e}`, "warn");
  }

  // Listen for idMapRemap to update per-window ID translation map
  try {
    const onIdMapRemap = (message) => {
      try {
        if (message && message.command === "idMapRemap") {
          const { oldRealId, newRealId } = message;
          const count = remapUniqueId(String(oldRealId || ""), String(newRealId || ""));
          log(`[TMDBG Chat] Applied idMap remap: ${oldRealId} -> ${newRealId} (count=${count})`);
        }
      } catch (e) {
        log(`[TMDBG Chat] Failed to apply idMapRemap: ${e}`, "warn");
      }
    };
    browser.runtime.onMessage.addListener(onIdMapRemap);
    window.addEventListener("beforeunload", () => {
      try { browser.runtime.onMessage.removeListener(onIdMapRemap); } catch (_) {}
    });
  } catch (e) {
    log(`[TMDBG Chat] Failed to attach idMapRemap listener: ${e}`, "warn");
  }

  // Listen for proactive check-in messages injected while chat is already open
  try {
    // IMPORTANT: Must NOT be async — async onMessage handlers break other listeners in TB.
    // Fire-and-forget the async work inside.
    const onProactiveCheckinMessage = (message) => {
      if (!message || message.command !== "proactive-checkin-message") return;

      const { message: proactiveText, idMapEntries } = message;
      if (!proactiveText) return;

      log(`[TMDBG Chat] Received proactive check-in message (${proactiveText.length} chars, ${(idMapEntries || []).length} idMap entries)`);

      // Fire-and-forget async — use _insertNudge via exported wrapper so proactive
      // messages properly replace any existing welcome-back greeting
      (async () => {
        try {
          // Merge headless idMap into the active chat's map and remap message references
          let displayMessage = proactiveText;
          if (Array.isArray(idMapEntries) && idMapEntries.length > 0) {
            displayMessage = mergeIdMapFromHeadless(idMapEntries, proactiveText);
            log(`[TMDBG Chat] Merged idMap from proactive session`);
          }

          // Insert via the nudge system — replaces welcome-back if present,
          // handles agentConverseMessages, grey-out, and ephemeral persistence
          await insertProactiveNudge(displayMessage);

          log(`[TMDBG Chat] Injected proactive check-in bubble into open chat`);
        } catch (e) {
          log(`[TMDBG Chat] Failed to handle proactive-checkin-message: ${e}`, "warn");
        }
      })();
    };
    browser.runtime.onMessage.addListener(onProactiveCheckinMessage);
    window.addEventListener("beforeunload", () => {
      try { browser.runtime.onMessage.removeListener(onProactiveCheckinMessage); } catch (_) {}
    });
  } catch (e) {
    log(`[TMDBG Chat] Failed to attach proactive check-in listener: ${e}`, "warn");
  }

  // Track stick-to-bottom state on user scrolling
  try {
    const container = document.getElementById("chat-container");
    if (container) {
      // Initialize stickiness based on initial position (start stuck to bottom)
      setStickToBottom(container, true);
      const onScroll = () => {
        try {
          const atBottom = isAtBottom(container);
          setStickToBottom(container, atBottom);
        } catch (_) {}
      };
      container.addEventListener("scroll", onScroll, { passive: true });
      
      // Initialize aggressive scroll sticking (ResizeObserver + container MutationObserver)
      initAggressiveScrollStick(container);
      
      // Ensure cleanup on unload
      window.addEventListener("beforeunload", () => {
        try { container.removeEventListener("scroll", onScroll); } catch (_) {}
        try { cleanupScrollObservers(container); } catch (_) {}
      });
    }
  } catch (_) {}

  // Idle detection: insert welcome-back greeting when user returns to tab
  try {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkAndInsertWelcomeBack().catch(e => {
          log(`[TMDBG Chat] checkAndInsertWelcomeBack failed: ${e}`, "warn");
        });
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("beforeunload", () => {
      try { document.removeEventListener("visibilitychange", onVisibilityChange); } catch (_) {}
    });
  } catch (e) {
    log(`[TMDBG Chat] Failed to setup visibilitychange listener: ${e}`, "warn");
  }

  // Setup the chat window and start the chat conversation

  // Create a per-window session id for MCP websocket
  try {
    if (!ctx.sessionId) {
      const rand = Math.random().toString(36).slice(2, 10);
      ctx.sessionId = `chat_${Date.now()}_${rand}`;
    }
    log(`[Chat] Prepared session_id=${ctx.sessionId} (WS will open per request)`);
  } catch (e) {
    log(`[Chat] Failed to prepare session id: ${e}`, "error");
  }

  // Initialize message selection tracking
  initMessageSelectionTracking();

  // Initialize context usage tracking
  initContextUsageTracking();

  // Window close: force-save persistent state and cleanup (BEST-EFFORT ONLY)
  window.addEventListener("beforeunload", () => {
    // Force-save persistent state first (turns, meta, idMap) — timers won't fire after unload
    try {
      if (ctx.persistedTurns) saveTurnsImmediate(ctx.persistedTurns);
      if (ctx.chatMeta) saveMetaImmediate(ctx.chatMeta);
      persistIdMapImmediate();
      log(`[TMDBG Chat] Force-saved persistent chat state on window close`);
    } catch (e) {
      log(`[TMDBG Chat] Failed to force-save persistent state: ${e}`, "warn");
    }

    // Clean up runtime message listeners
    cleanupMessageSelectionListener();

    // Clean up DOM event listeners
    cleanupChatDOMListeners();

    // Clean up any active tool websocket
    try {
      shutdownToolWebSocket();
    } catch (_) {}

    // Clean up SSE connections - abort any active requests and stop tool listener
    try {
      if (window.currentChatAbortController) {
        log(`[TMDBG Chat] Aborting active SSE request on window close`);
        window.currentChatAbortController.abort();
        window.currentChatAbortController = null;
      }
    } catch (e) {
      log(`[TMDBG Chat] Failed to abort SSE request: ${e}`, "warn");
    }

    try {
      import("./modules/sseTools.js").then(({ stopToolListener }) => {
        stopToolListener();
        log(`[TMDBG Chat] Stopped SSE tool listener on window close`);
      }).catch((e) => {
        log(`[TMDBG Chat] Failed to stop SSE tool listener: ${e}`, "warn");
      });
    } catch (e) {
      log(`[TMDBG Chat] Failed to import SSE tools cleanup: ${e}`, "warn");
    }

    // Trigger KB update for pending turns via background script
    // Turns are already persisted — background will read from persistent store
    try {
      browser.runtime.sendMessage({
        command: "kb-update-from-window-close",
      }).catch((e) => {
        log(`-- KB -- Failed to send KB update trigger to background: ${e}`, "warn");
      });
    } catch (e) {
      log(`-- KB -- Failed to trigger KB update on close: ${e}`, "warn");
    }
  });

  // Setup window keydown handler for Esc to stop
  chatDOMListeners.windowKeydownHandler = (e) => {
    if (e.key === "Escape" && chatMode === "stop") {
      e.preventDefault();
      stopExecution();
    }
  };
  window.addEventListener("keydown", chatDOMListeners.windowKeydownHandler);

  const textarea = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-btn");
  const hintEl = document.getElementById("input-suggestion-hint");
  setChatMode(chatMode);

  // Initialize mention autocomplete
  initMentionAutocomplete(textarea);

  const defaultPlaceholder =
    textarea?.getAttribute("data-placeholder") || "Type a message...";
  
  // Store default placeholder for retry visibility restoration
  if (textarea) {
    textarea.setAttribute("data-default-placeholder", defaultPlaceholder);
  }

  function updateSuggestionVisibility() {
    try {
      const val = (textarea?.textContent || "").trim();
      const suggestion = (ctx.pendingSuggestion || "").trim();
      const canRetry = ctx.canRetry || false;
      
      // log(`[TMDBG Chat] updateSuggestionVisibility: val="${val}", suggestion="${suggestion}"`, "info");
      
      // Don't override retry suggestion if in retry mode
      if (!val && canRetry && chatMode === "retry") {
        // Retry mode handles its own placeholder via updateRetryVisibility
        return;
      }
      
      if (!val && suggestion) {
        // Make the placeholder emphasize suggestion, without brackets
        if (textarea) {
          textarea.setAttribute("data-placeholder", `${suggestion}`);
          textarea.classList.add("has-fsm-suggestion");
          textarea.classList.remove("has-retry-suggestion");
          log(`[TMDBG Chat] Set placeholder to suggestion: "${suggestion}"`, "info");
        }
        if (hintEl) {
          hintEl.textContent =
            "Press Tab to accept suggestion, type your own message, refer to emails with @";
          hintEl.hidden = false;
        }
      } else if (textarea && !val) {
        textarea.setAttribute("data-placeholder", defaultPlaceholder);
        textarea.classList.remove("has-fsm-suggestion");
        textarea.classList.remove("has-retry-suggestion");
        log(`[TMDBG Chat] Set placeholder to default: "${defaultPlaceholder}"`, "info");
        if (hintEl) hintEl.hidden = true;
      } else {
        // log(`[TMDBG Chat] Hiding hint (val has content)`, "info");
        textarea.classList.remove("has-fsm-suggestion");
        textarea.classList.remove("has-retry-suggestion");
        if (hintEl) hintEl.hidden = true;
      }
    } catch (e) {
      console.log(`[TMDBG Chat] updateSuggestionVisibility failed: ${e}`);
    }
  }

  function focusInputSoon() {
    try {
      setTimeout(() => textarea?.focus(), 0);
    } catch {}
  }

  // Expose helpers for modules
  window.tmShowSuggestion = updateSuggestionVisibility;
  window.tmFocusInput = focusInputSoon;

  if (textarea) {
    // adjustHeight not needed for contenteditable (CSS handles max-height)
    const adjustHeight = () => {
      // No-op for contenteditable
    };

    // Setup textarea input handler
    chatDOMListeners.textareaInputHandler = () => {
      // log(`[TMDBG Chat] Input event fired, innerHTML: "${textarea?.innerHTML}"`, "info");
      // log(`[TMDBG Chat] Input event fired, textContent: "${textarea?.textContent}"`, "info");
      adjustHeight();
      updateSuggestionVisibility();
      updateRetryVisibility();
    };
    textarea.addEventListener("input", chatDOMListeners.textareaInputHandler);

    // Setup textarea paste handler - convert paste to plain text to avoid confusing the LLM
    chatDOMListeners.textareaPasteHandler = (e) => {
      e.preventDefault();
      const clipboardData = e.clipboardData || window.clipboardData;
      if (!clipboardData) {
        log(`[TMDBG Chat] Paste event: no clipboard data available`, "warn");
        return;
      }
      const plainText = clipboardData.getData("text/plain");
      log(`[TMDBG Chat] Paste event: converting to plain text (${plainText.length} chars)`, "info");
      // Insert plain text at cursor position
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(plainText);
        range.insertNode(textNode);
        // Move cursor to end of inserted text
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        // Fallback: append to end
        textarea.textContent += plainText;
      }
      // Trigger input event to update suggestion visibility
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };
    textarea.addEventListener("paste", chatDOMListeners.textareaPasteHandler);

    // Setup window resize handler
    chatDOMListeners.windowResizeHandler = adjustHeight;
    window.addEventListener("resize", chatDOMListeners.windowResizeHandler);

    // Setup contenteditable keydown handler
    chatDOMListeners.textareaKeydownHandler = async (e) => {
      // Check if mention autocomplete is active
      const mentionAutocompleteActive = window.mentionAutocompleteActive || false;
      
      if (e.key === "Tab") {
        // Block Tab if mention autocomplete is active
        if (mentionAutocompleteActive) {
          log(`[TMDBG Chat] Tab blocked - mention autocomplete is active`, "info");
          return; // Let autocomplete handle it
        }
        
        const val = extractMarkdownFromContentEditable(textarea).trim();
        const suggestion = (ctx.pendingSuggestion || "").trim();
        log(`[TMDBG Chat] Tab pressed: val="${val}", suggestion="${suggestion}"`, "info");
        if (!val && suggestion) {
          e.preventDefault();
          // Accept suggestion as user input
          log(`[TMDBG Chat] Accepting suggestion via Tab`, "info");
          createNewUserBubble(suggestion);
          clearContentEditable(textarea);
          adjustHeight();
          setChatMode("stop"); // Change to stop mode
          ctx.pendingSuggestion = "";
          updateSuggestionVisibility();
          try {
            await processUserInput(suggestion);
          } catch (err) {
            log(`[TMDBG Chat] processUserInput(suggestion) failed: ${err}`, "error");
          }
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // Block Enter if mention autocomplete is active
        if (mentionAutocompleteActive) {
          log(`[TMDBG Chat] Enter blocked - mention autocomplete is active`, "info");
          return; // Don't send message
        }
        
        e.preventDefault();
        
        // Handle retry mode - Enter on empty input triggers retry
        if (chatMode === "retry") {
          log(`[TMDBG Chat] Enter pressed in retry mode - triggering retry`, "info");
          if (window.tmRetryLastMessage) {
            window.tmRetryLastMessage();
          }
          return;
        }
        
        if (chatMode !== "send") return;
        const txt = extractMarkdownFromContentEditable(textarea).trim();
        log(`[TMDBG Chat] Enter pressed, sending message: "${txt}"`, "info");
        if (txt) {
          createNewUserBubble(txt);
          clearContentEditable(textarea);
          adjustHeight();
          setChatMode("stop"); // Change to stop mode
          ctx.pendingSuggestion = "";
          updateSuggestionVisibility();
          try {
            await processUserInput(txt);
          } catch (err) {
            log(`[TMDBG Chat] processUserInput(enter) failed: ${err}`, "error");
          }
        }
      }
    };
    textarea.addEventListener(
      "keydown",
      chatDOMListeners.textareaKeydownHandler
    );

    // Setup send button click handler
    chatDOMListeners.sendClickHandler = async () => {
      if (chatMode === "stop") {
        // Stop button was clicked
        await stopExecution();
        return;
      }
      
      if (chatMode === "retry") {
        // Retry button was clicked
        log(`[TMDBG Chat] Retry button clicked`, "info");
        if (window.tmRetryLastMessage) {
          window.tmRetryLastMessage();
        }
        return;
      }
      
      if (chatMode !== "send") return;
      const txt = extractMarkdownFromContentEditable(textarea).trim();
      log(`[TMDBG Chat] Send button clicked, message: "${txt}"`, "info");
      if (txt) {
        createNewUserBubble(txt);
        clearContentEditable(textarea);
        adjustHeight();
        setChatMode("stop"); // Change to stop mode
        ctx.pendingSuggestion = "";
        updateSuggestionVisibility();
        try {
          await processUserInput(txt);
        } catch (err) {
          log(`[TMDBG Chat] processUserInput(click) failed: ${err}`, "error");
        }
      }
    };
    sendBtn?.addEventListener("click", chatDOMListeners.sendClickHandler);

    adjustHeight();
    updateSuggestionVisibility();
  }

  // Once everything is set up, start the chat conversation
  initAndGreetUser();
});
