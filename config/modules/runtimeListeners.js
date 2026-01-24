import { $, restoreScrollPosition, saveScrollPosition } from "./dom.js";

// Listen for runtime message indicating prompts were updated elsewhere.
//
// NOTE: Prompts are now managed in the dedicated prompts page (prompts/prompts.html).
// The runtime message handler is kept as-is (including references to loadPrompts)
// to avoid changing behavior/logs.
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

      if (msg.command === actionEvt && msg.key === "user_prompts:user_action.md") {
        log(`[TMDBG Config] Received ${actionEvt}; reloading prompts.`);
        // Do not return a Promise to avoid hijacking other sendMessage calls
        const scrollPos = saveScrollPosition();
        // eslint-disable-next-line no-undef
        loadPrompts()
          .then(() => {
            try {
              const ta = $("action-prompt-src");
              if (ta) {
                ta.classList.add("flash-ok");
                setTimeout(() => ta.classList.remove("flash-ok"), 500);
                ta.style.height = "auto";
                ta.style.height = `${ta.scrollHeight}px`;
              }
              restoreScrollPosition(scrollPos);
            } catch (_) {}
          })
          .catch((e) => {
            console.warn("[TMDBG Config] loadPrompts via message failed", e);
            restoreScrollPosition(scrollPos);
          });
      }

      if (msg.command === kbEvt && msg.key === "user_prompts:user_kb.md") {
        log(`[TMDBG Config] Received ${kbEvt}; reloading prompts.`);
        // Do not return a Promise to avoid hijacking other sendMessage calls
        const scrollPos = saveScrollPosition();
        // eslint-disable-next-line no-undef
        loadPrompts()
          .then(() => {
            try {
              const ta = $("kb-prompt-src");
              if (ta) {
                ta.classList.add("flash-ok");
                setTimeout(() => ta.classList.remove("flash-ok"), 500);
                ta.style.height = "auto";
                ta.style.height = `${ta.scrollHeight}px`;
              }
              restoreScrollPosition(scrollPos);
            } catch (_) {}
          })
          .catch((e) => {
            console.warn("[TMDBG Config] loadPrompts via message failed", e);
            restoreScrollPosition(scrollPos);
          });
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

