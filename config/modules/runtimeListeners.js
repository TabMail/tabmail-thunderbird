// Note: dom.js imports removed - no longer needed since prompts are on dedicated page

// Listen for runtime message indicating prompts were updated elsewhere.
//
// NOTE: Prompts are now managed in the dedicated prompts page (prompts/prompts.html).
// This listener just logs the event for debugging purposes - no action needed on config page.
export function createPromptsUpdatedRuntimeListener(SETTINGS, log) {
  const actionEvt =
    (SETTINGS && SETTINGS.events && SETTINGS.events.userActionPromptUpdated) ||
    "user-action-prompt-updated";
  const kbEvt =
    (SETTINGS && SETTINGS.events && SETTINGS.events.userKBPromptUpdated) ||
    "user-kb-prompt-updated";

  const listener = (msg) => {
    try {
      if (!msg || !msg.command) return; // Important: return undefined synchronously for unrelated messages

      // Just log - prompts are managed on the dedicated prompts page
      if (msg.command === actionEvt && msg.key === "user_prompts:user_action.md") {
        log(`[TMDBG Config] Received ${actionEvt} (prompts managed on prompts page)`);
      }

      if (msg.command === kbEvt && msg.key === "user_prompts:user_kb.md") {
        log(`[TMDBG Config] Received ${kbEvt} (prompts managed on prompts page)`);
      }
    } catch (e) {
      console.warn(`[TMDBG Config] onMessage handler error:`, e);
    }
    // No return to ensure we don't respond to messages we don't own
  };

  return listener;
}

export function createPromptEditorsInputHandler() {
  return async (e) => {
    // Auto-resize prompt editors to fit content without inner scrollbar
    if (
      e &&
      e.target &&
      (e.target.id === "action-prompt-src" ||
        e.target.id === "composition-prompt-src" ||
        e.target.id === "kb-prompt-src")
    ) {
      try {
        const ta = e.target;
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
      } catch (err) {
        console.warn("[TMDBG Config] textarea autoresize on input failed", err);
      }
    }
  };
}

