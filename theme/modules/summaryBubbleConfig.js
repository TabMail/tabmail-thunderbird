// TabMail Summary Bubble Config (TB 145 / MV3)
// Loaded BEFORE summaryBubble.js so the content script can read a stable config
// without hardcoding numeric values inline throughout the script.
//
// This is a plain script (not a module) because it is injected as a content script.
// It intentionally attaches config to globalThis for easy access.

(function () {
  // Keep this object small and stable; changes should be intentional because it affects
  // perceived UI "snappiness" during message pane rendering.
  //
  // Warning colors are derived from palette.data.json BASE colors:
  // - Border: BASE.YELLOW (#ffc40d)
  // - Background: BASE.YELLOW with OPACITY.SELECTED_* (40% light, 30% dark)
  // - Text: BASE.TEXT_UNREAD_* colors
  // If palette changes, update these values to match.

  const CONFIG = {
    // IDs
    bubbleId: "tabmail-message-bubbles",

    // Spacing / dimensions
    marginHorizontalPx: 8,
    marginTopPx: 8,
    marginBottomPx: 0,
    paddingHorizontalPx: 10,
    paddingVerticalPx: 8,
    borderRadiusPx: 8,

    // Typography
    // CSS-first sizing: use system UI font preset (like "font: menu") and absolute keyword sizing.
    // This avoids "random scaler numbers" and reduces layout jitter.
    // Valid examples:
    // - fontPreset: "menu" | "message-box" | "status-bar" (platform-dependent)
    // - fontSize: "x-small" | "small" | "medium" | "large" | "x-large"
    // Use absolute keywords (not "smaller") so HTML email CSS can't shrink our UI.
    // The "small" keyword respects TB's font.size.variable prefs.
    fontPreset: "message-box",
    fontSize: "small",

    // Warning colors (derived from palette.data.json BASE colors)
    // BASE.YELLOW = #ffc40d (RGB: 255, 196, 13)
    warningBgLight: "rgba(255, 196, 13, 0.15)",     // YELLOW @ lighter opacity for bright look
    warningBgDark: "rgba(255, 196, 13, 0.40)",      // YELLOW @ higher opacity for darker look
    warningBorder: "#ffc40d",                       // BASE.YELLOW
    warningTextLight: "#0b0c0e",                    // BASE.TEXT_UNREAD_LIGHT
    warningTextDark: "#f1f2f4",                     // BASE.TEXT_UNREAD_DARK

    // Performance knobs (default: optimized for snappy render)
    enableResizeObserver: false,

    // JS-based sizing: manually calculate bubble width from body.clientWidth.
    // When false (recommended), CSS handles sizing via percentages/auto.
    enableJsSizing: false,

    // Diagnostics are useful, but they can force layout. Keep them off by default.
    enableDiagnostics: false,
  };

  try {
    globalThis.TabMailSummaryBubbleConfig = CONFIG;
    console.log("[TabMail Bubble] summaryBubbleConfig loaded", {
      fontPreset: CONFIG.fontPreset,
      fontSize: CONFIG.fontSize,
      enableResizeObserver: CONFIG.enableResizeObserver,
      enableDiagnostics: CONFIG.enableDiagnostics,
    });
  } catch (e) {
    // If globalThis assignment fails, something is deeply wrong; still log for forensics.
    console.log(`[TabMail Bubble] Failed to set TabMailSummaryBubbleConfig: ${e}`);
  }
})();


