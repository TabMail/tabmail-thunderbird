var TabMail = TabMail || {};

// Helper to read CSS variables (palette is injected by compose-autocomplete.js)
function cssVar(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch(e) {
    console.error('[TabMail] Failed to read CSS var:', name, e);
    return '';
  }
}

// Centralized configuration for TabMail modules.
TabMail.config = {
  /**
   * The character used to visually represent a newline in a diff view.
   * This helps visualize additions or deletions of blank lines.
   */
  DELETED_NEWLINE_VISUAL_CHAR: "⏎",

  /**
   * Visual marker injected after <br> when showNewlines=true.
   * We use non-breaking spaces so it has consistent width and doesn't collapse.
   */
  newlineMarker: {
    NBSP_COUNT: 2,
  },

  /**
   * Compose editor layout/wrapping controls.
   * In some TB compose contexts (designMode), the editor node can behave like
   * shrink-to-content, causing user-typed text (and our diff spans) not to wrap
   * when the compose window is resized. Quotes/signatures may still wrap due to
   * their own width/white-space styling.
   */
  composeWrap: {
    EDITOR_WIDTH_PERCENT: 98,
    EDITOR_MAX_WIDTH_PERCENT: 100,
    EDITOR_MIN_WIDTH_PX: 0,
  },

  /**
   * If true, hide the actual newline (<br>) in delete operations, showing
   * only the visual indicator character. If false, show both the actual
   * newline and the visual indicator.
   */
  HIDE_DELETE_NEWLINES: false,

  /**
   * DEPRECATED - replaced by simple delay with back-off.
   * Throttle interval in milliseconds: after an immediate (leading-edge)
   * trigger, additional triggers are suppressed for this long.
   */
  TRIGGER_THROTTLE_MS: 250,

  /**
   * Delay in milliseconds after the user stops typing before we automatically
   * show diffs again (auto-hide restoration).
   */
  DIFF_RESTORE_DELAY_MS: 500,

  /**
   * How long (ms) we suppress non-forced diff renders after `cleanupBeforeSend`.
   * This needs to cover the small window where Thunderbird snapshots the
   * compose DOM for sending, to prevent transient diff spans from flashing.
   */
  BEFORE_SEND_CLEANUP_SUPPRESS_MS: 1500,

  /**
   * Quote boundary separator (spacing inserted between user text and preserved
   * quote/signature region). This separator is skipped during text extraction.
   *
   * NOTE: Thunderbird sometimes inserts a leading <br> inside `.moz-signature`
   * when the signature appears above the quoted reply. If we always add two <br>
   * in our separator, that can create three consecutive newlines in the compose
   * view. We reduce the separator count in that specific case.
   */
  quoteSeparator: {
    BR_COUNT_DEFAULT: 2,
    // When the boundary node is a signature (.moz-signature) AND a quote/cite
    // block appears after it (signature-above-quote layout), we reduce the
    // separator to avoid creating an extra visible blank line in compose.
    BR_COUNT_WHEN_SIGNATURE_BOUNDARY_WITH_QUOTE_AFTER: 1,
  },

  /**
   * Autocomplete idle detection with back-off strategy.
   * 
   * Philosophy:
   * - Send LLM request after user stops typing (idle detection)
   * - Show response immediately once received (no display delay)
   * - Back off idle time when ignored to save tokens
   * - Reset when accepted to stay helpful
   */
  autocompleteDelay: {
    /**
     * Initial idle time (ms) after user stops typing before sending LLM request.
     * This is the baseline "user paused to think" detection.
     * Typical pause moment - feels natural for a suggestion.
     */
    INITIAL_IDLE_MS: 250,

    /**
     * Maximum idle time (ms) after backing off from repeated ignores.
     * Even when repeatedly ignored, we still eventually send a request.
     * Prevents autocomplete from feeling disconnected from what user just wrote.
     */
    MAX_IDLE_MS: 500,

    /**
     * How much to increase idle time (ms) each time a suggestion is ignored.
     * Ignored = user types ≥ IGNORE_CHARS_THRESHOLD new chars without accepting,
     * or user presses ESC to dismiss.
     */
    BACKOFF_STEP_MS: 50,

    /**
     * Minimum number of characters user must type after a suggestion is shown
     * for it to count as "ignored" (triggers back-off).
     */
    IGNORE_CHARS_THRESHOLD: 5,

    /**
     * Time (ms) of inactivity after which we reset idle time back to INITIAL_IDLE_MS.
     * If user hasn't composed anything for this long, assume new context and reset.
     */
    RESET_AFTER_IDLE_MS: 600000, // 10 minutes
  },

  /**
   * Debounce duration (ms) for selectionchange handling to avoid
   * intermediate renders during double-click / drag selections.
   */
  SELECTION_DEBOUNCE_MS: 200,

  /**
   * The minimum number of characters that must be different between the
   * original text and the suggestion for the suggestion to be shown.
   */
  CHAR_DIFF_THRESHOLD: 5,

  /**
   * Interval (ms) to poll the DOM for the compose editor when the content
   * script starts up.
   */
  COMPOSE_EDITOR_POLL_INTERVAL_MS: 250,

  /**
   * Maximum time (ms) to keep polling before giving up.
   */
  COMPOSE_EDITOR_POLL_TIMEOUT_MS: 15000,

  /**
   * Delay (ms) before issuing the very first correction after the compose
   * editor is found / on initial trigger.
   */
  INITIAL_CORRECTION_DELAY_MS: 100,  

  /**
   * Tolerance (in characters) allowed when verifying that user edits are a
   * subset of the backend suggestion. If the unmatched portion of the user's
   * edits is less than or equal to this value, we still accept the backend
   * suggestion.
   */
  SUBSET_DIFF_TOLERANCE: 5,

  /**
   * For logging, truncate texts to this length.
   */
  LOG_TRUNCATE_LENGTH: 100,

  /**
   * 
   * Logging configuration - controls verbosity of console output.
   * Levels (from least to most verbose):
   *   NONE: 0   - No logging at all
   *   ERROR: 1  - Only errors
   *   WARN: 2   - Errors and warnings
   *   INFO: 3   - Errors, warnings, and important info (default for production)
   *   DEBUG: 4  - All of above + debugging information
   *   TRACE: 5  - All of above + high-frequency events (keystrokes, cursor movements, etc)
   * 
   * Set to INFO for production, DEBUG for development, TRACE for deep debugging.
   */
  // LOG_LEVEL: 4, // DEBUG
  LOG_LEVEL: 5, // INFO

  /**
   * Individual logging categories - can override global LOG_LEVEL for specific areas.
   * Set to null to use LOG_LEVEL, or set to a specific level (0-5) to override.
   */
  logCategories: {
    autohideDiff: 3,      // TRACE logs in autohide diff logic (very frequent)
    renderText: 3,        // TRACE logs in text rendering
    events: null,         // Event handler logs (input, keydown, etc) - use global LOG_LEVEL
    backend: null,        // Backend API calls (use global LOG_LEVEL)
    diff: null,           // Diff computation (use global LOG_LEVEL)
    core: null,           // Core autocomplete logic (use global LOG_LEVEL)
    inlineEdit: null,     // Inline editor operations (use global LOG_LEVEL)
    dom: null,            // DOM operations (use global LOG_LEVEL)
    undo: null,           // Undo/redo operations (use global LOG_LEVEL)
  },

  // jsdiff removed; always use diff-match-patch with sentence anchoring

  /**
   * When using diff-match-patch, this sets Diff_EditCost (default 4).
   * We raise it to 10 for chunkier, more human–readable diffs.
   */
  dmpEditCost: 10,

  /**
   * If true, diff-match-patch will run a quick line-level pass first which
   * often groups whole sentences/paragraphs as equalities – helps avoid
   * the first-line strikethrough issue.
   */
  dmpCheckLines: true,

  // --- DMP Cleanup Pass Flags ---
  /**
   * diff_cleanupSemantic:
   *   Removes trivial equalities (e.g., very small unchanged runs) so insert /
   *   delete blocks merge together.  Usually safe and makes diffs shorter.
   */
  dmpUseSemanticCleanup: false,

  /**
   * diff_cleanupSemanticLossless:
   *   Shifts the boundaries of edits left/right to land on natural word /
   *   whitespace limits (so a space is kept with the word that follows it,
   *   for example).  Purely cosmetic.
   */
  dmpUseSemanticLossless: false,

  /**
   * diff_cleanupEfficiency:
   *   Aggressively reorders edits to minimise the *number* of separate edit
   *   sections, even if that means moving identical text blocks around.  Can
   *   cause confusing "whole-line moved" artefacts, so keep this off unless
   *   you really want the smallest patch possible.
   */
  dmpUseEfficiencyCleanup: false,

  /**
   * Group diffs by sentence after annotation to prevent scattering.
   */
  diffGroupBySentence: true,

  /**
   * Log grouping diagnostics (counts of scattered sentences, etc.).
   */
  diffLogGrouping: false,

  /**
   * Enable performance timing logs for tokenization, token diff, and char diff.
   */
  diffPerfLogging: false,

  /**
   * Enable detailed debug logging for diff computation.
   */
  diffLogDebug: false,

  // --- Tokenization for patience diff ---
  tokens: {
    /** When true, log a sample of tokens after tokenization */
    logSample: false,
    /** Number of tokens to include in the sample log */
    sampleLogCount: 20,
    /** Normalize whitespace equivalence during patience anchors */
    normalizeWhitespaceForEquality: true,
  },



  /**
   * Keybindings
   */
  keys: {
    localAccept: { key: "Tab", shiftKey: false },
    localReject: { key: "Unassigned", shiftKey: true },
    globalAccept: { key: "Tab", shiftKey: true },
    toggleDiffView: { key: "Escape", shiftKey: true },
    navigateForward: { key: "Tab", shiftKey: false },
    navigateBackward: { key: "Tab", shiftKey: true },
    // Inline edit shortcuts (platform-specific)
    inlineEditCmd: { key: "k", metaKey: true },
    inlineEditCtrl: { key: "k", ctrlKey: true },
    // Execute inline edit: Ctrl/Cmd + Enter (platform-specific)
    inlineEditExecuteCmd: { key: "Enter", metaKey: true },
    inlineEditExecuteCtrl: { key: "Enter", ctrlKey: true },
  },

  /**
   * Color configuration for diffs.
   * 
   * ⚠️ IMPORTANT: Colors are read from CSS variables injected by palette system
   * The palette is injected into the document by compose-autocomplete.js on startup.
   * All color values come from /theme/palette/palette.data.json (single source of truth).
   * 
   * This function initializes after palette injection.
   * @see /theme/palette/README.md for color definitions
   */
  colors: {
    insert: {
      background: {
        get light() { return cssVar('--tm-insert-bg-light'); },
        get dark()  { return cssVar('--tm-insert-bg-dark'); },
      },
      text: {
        get light() { return cssVar('--tm-insert-text-light'); },
        get dark()  { return cssVar('--tm-insert-text-dark'); },
      },
      highlight: {
        background: {
          get light() { return cssVar('--tm-insert-selbg-light'); },
          get dark()  { return cssVar('--tm-insert-selbg-dark'); },
        },
        text: {
          get light() { return cssVar('--tm-insert-seltext-light'); },
          get dark()  { return cssVar('--tm-insert-seltext-dark'); },
        },
      },
    },
    delete: {
      background: {
        get light() { return cssVar('--tm-delete-bg-light'); },
        get dark()  { return cssVar('--tm-delete-bg-dark'); },
      },
      text: "inherit",
      highlight: {
        background: {
          get light() { return cssVar('--tm-delete-selbg-light'); },
          get dark()  { return cssVar('--tm-delete-selbg-dark'); },
        },
        text: "inherit",
      },
    },
    cursorJump: {
      get caret() { return cssVar('--tm-cursor-indicator'); },
      get arrow() { return cssVar('--tm-cursor-indicator'); },
      offsets: {
        caretX: -1,
        caretY: 0,
        arrowX: -6,
        arrowY: -10,
      },
    },
  },


  /**
   * Inline edit dropdown UI configuration
   */
  inlineEdit: {
    zIndex: 10001,
    maxWidthPx: 520,
    marginPx: 6,
    // Use TB theme variables with sensible fallbacks
    background: "var(--arrowpanel-background, var(--in-content-page-background, #111))",
    text: "var(--arrowpanel-color, var(--in-content-page-color, #fff))",
    border: "1px solid var(--panel-separator-color, rgba(255,255,255,0.15))",
    borderRadiusPx: 8,
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    padding: "8px 10px",
    // Caret color for container styling when needed
    caretColor: "currentColor",
    // Font sizing for the inline editor (smaller than compose editor)
    fontSizeEm: 0.9,
    // Textarea line height and max visible lines before scroll
    lineHeightPx: 16,
    maxLines: 4,
    // Grace period to ignore transient blur/focus churn when toggling designMode
    // in Thunderbird compose to allow the input to keep focus.
    focusGraceMs: 150,
    // After restoring designMode='on', attempt an extra refocus after this delay (ms)
    // to counter any late focus churn.
    focusRefocusMs: 60,
    // Animation timings (ms)
    // fadeOutMs: DEPRECATED - replaced by diff wipe animation
    fadeOutMs: 500,
    // Diff wipe effect: shows diffs between old and new text, then fades them out
    diffWipeOverlayFadeMs: 150, // How fast the input overlay fades to reveal diffs
    diffWipeFadeMs: 600,        // How long the diff highlighting takes to fade out
    // Blend height in pixels for the soft feathered edge on wipe animation
    // Set to 0 to disable blend (hard edge), higher values = softer/larger blend zone
    diffWipeBlendHeightPx: 40,
    
    // Diff replay animation: applies diffs one by one like live editing
    // Set to true to use diff replay, false to use wipe transition
    useDiffReplayAnimation: false,
    diffReplayDelayMs: 5,       // Delay between each character operation
    diffReplayPauseMs: 50,      // Pause between diff chunks (delete→insert transitions)
  },

  /**
   * Helper function to get color values that respond to dark/light mode
   * @param {Object} colorConfig - Color config object that may have light/dark variants
   * @returns {string} The appropriate color for the current theme
   */
  getColor: function(colorConfig) {
    if (typeof colorConfig === 'string') {
      return colorConfig;
    }
    // Detect if we're in dark mode
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (colorConfig && typeof colorConfig === 'object') {
      return isDark ? (colorConfig.dark || colorConfig.light) : (colorConfig.light || colorConfig.dark);
    }
    return colorConfig;
  },

  /**
   * Sentence splitting configuration
   */
  sentences: {
    /**
     * If true, merge fragments that together form a URL (e.g., www.abc.com)
     * that would otherwise be split by the sentence regex at dots.
     */
    mergeUrls: false,

    /**
     * Maximum number of adjacent fragments to consider when attempting
     * a URL merge. Controls cost of lookahead.
     */
    urlMaxMergeParts: 6,

    /**
     * Case-insensitive flags for the URL regex below.
     */
    urlRegexFlags: "i",

    /**
     * URL detection pattern (without ^$ anchors). Should match common
     * schemes and www-prefixed hostnames without spaces. Do not include
     * leading and trailing slashes; those are added at runtime.
     */
    urlRegexPattern:
      "(?:(?:https?|ftp):\\/\\/|www\\.)[^\\s]+",

    /**
     * Enable extra debug logging for sentence splitting and URL merges.
     */
    logMerges: true,

    // Punctuation boundary rule is now unconditional in the splitter.
  },
};
