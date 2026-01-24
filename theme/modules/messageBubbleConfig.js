// TabMail Message Bubble Config (TB 145 / MV3)
// Loaded BEFORE messageBubble.js so the content script can read a stable config
// without hardcoding numeric values inline throughout the script.
//
// This is a plain script (not a module) because it is injected as a content script.
// It intentionally attaches config to globalThis for easy access.

(function () {
  const threadCfg = globalThis.TabMailThreadBubbleConfig;
  if (!threadCfg || typeof threadCfg !== "object") {
    console.log("[TabMail MsgBubble] Missing TabMailThreadBubbleConfig; aborting messageBubbleConfig init");
    return;
  }

  // Element IDs
  const WRAPPER_ID = 'tm-message-bubble-wrapper';
  const STYLE_ID = 'tm-message-bubble-style';
  const THREAD_CONTAINER_ID = 'tm-thread-conversation';

  // Layout dimensions (same as summary bubble)
  const LAYOUT = {
    marginHorizontalPx: 8,
    marginTopPx: 8,
    marginBottomPx: 8,
    paddingHorizontalPx: 10,
    paddingVerticalPx: 8,
    borderRadiusPx: 8,
  };

  // Message bubble UI config
  const MESSAGE_BUBBLE_UI = {
    // Slightly larger monospace in the message bubble improves readability.
    monoFontScale: 0.95,
    // Diagnostics/marking for monospace runs inside message content.
    monoDetect: {
      maxCandidatesToCheck: 600,
      selector:
        "pre, code, tt, kbd, samp, font[face], *[style*='monospace'], .moz-text-plain, .moz-text-flowed, .moz-txt-fixed",
      familyNeedles: ["mono", "Menlo", "Consolas", "DejaVu Sans Mono"],
    },
  };

  const THREAD_BUBBLE_UI = threadCfg.THREAD_BUBBLE_UI || null;
  const THREAD_CLASSES = threadCfg.THREAD_CLASSES || null;
  if (!THREAD_BUBBLE_UI || !THREAD_CLASSES) {
    console.log("[TabMail MsgBubble] Invalid TabMailThreadBubbleConfig; aborting messageBubbleConfig init");
    return;
  }

  // Quote collapse CSS class names
  const QUOTE_CLASSES = {
    toggle: 'tm-quote-toggle',
    collapsed: 'tm-quote-collapsed',
    wrapper: 'tm-quote-wrapper',
    content: 'tm-quote-content',
  };

  // Assemble the config object (data only, no functions)
  // Functions that need runtime state are defined in messageBubble.js
  const CONFIG = {
    WRAPPER_ID,
    STYLE_ID,
    THREAD_CONTAINER_ID,
    LAYOUT,
    MESSAGE_BUBBLE_UI,
    THREAD_BUBBLE_UI,
    QUOTE_CLASSES,
    THREAD_CLASSES,
  };

  try {
    globalThis.TabMailMessageBubbleConfig = CONFIG;
    console.log("[TabMail MsgBubble] messageBubbleConfig loaded");
  } catch (e) {
    console.log(`[TabMail MsgBubble] Failed to set TabMailMessageBubbleConfig: ${e}`);
  }
})();
