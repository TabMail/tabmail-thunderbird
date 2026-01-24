var TabMail = TabMail || {};

TabMail.state = {
  // --- Session & Editor ---
  // The session ID for the current composition, tied to the tab ID.
  sessionId: null,
  // A reference to the content-editable editor element.
  editorRef: null,

  // --- Core State ---
  // A timer for scheduling correction triggers.
  typingTimer: null,
  // Timer used to throttle backend correction calls.
  backendTimer: null,
  // Timestamp of the last backend correction call.
  lastBackendCallTime: 0,
  
  // --- Autocomplete Idle & Back-off ---
  // Current idle time (ms) before sending LLM request after user stops typing.
  // Starts at INITIAL_IDLE_MS (2s), backs off to MAX_IDLE_MS (5s) when ignored.
  currentIdleTime: 2000, // Will be initialized from config
  // Timer for the idle detection after user stops typing.
  autocompleteIdleTimer: null,
  // Timestamp when the last suggestion was shown to the user.
  lastSuggestionShownTime: 0,
  // Text length when last suggestion was shown (to detect ignores).
  textLengthAtLastSuggestion: 0,
  // Timestamp of last user activity (typing) for long-idle reset.
  lastUserActivityTime: Date.now(),
  // --- Request IDs & Invalidation ---
  // NOTE: We track LOCAL and GLOBAL requests separately so local typing can
  // invalidate an in-flight global request without blocking.
  latestLocalRequestId: 0,
  latestGlobalRequestId: 0,
  // The user's original, unmodified text.
  originalText: "",
  // The last text that was actually sent to the backend (to prevent duplicate sends).
  // Split by mode because GLOBAL follow-ups may send "assumed accepted" text.
  lastSentLocalText: null,
  lastSentGlobalText: null,
  // The AI-corrected version of the text.
  correctedText: "",
  // A flag indicating whether a diff is currently being displayed.
  isDiffActive: false,
  // A flag to control whether diffs are shown or hidden.
  showDiff: true,
  // Temporarily hides diffs while the user is actively typing.
  autoHideDiff: false,
  // Timer for restoring diffs after typing stops.
  diffRestoreTimer: null,
  // Timer for debouncing selectionchange events.
  selectionDebounceTimer: null,
  // A flag to track if the last user action was accepting a suggestion.
  lastActionWasAccept: false,
  // A flag to indicate if an IME composition is in progress.
  isIMEComposing: false,
  
  // --- Undo Snapshot Management ---
  // Holds a snapshot captured in `beforeinput` that will be completed and
  // committed to the undo manager in the corresponding `input` event.
  pendingUndoSnapshot: null,
  // Whether the baseline (empty) snapshot has been queued/committed.
  undoBaselineAdded: false,
  
  // --- Backend Call Tracking ---
  // True while a LOCAL (chunked) correction request is in-flight.
  isLocalRequestInFlight: false,
  // True while a GLOBAL (full email) correction request is in-flight.
  isGlobalRequestInFlight: false,
  // True if a LOCAL trigger was attempted while isLocalRequestInFlight was true.
  hasPendingLocalTrigger: false,
  // True if a GLOBAL trigger was attempted while isGlobalRequestInFlight was true.
  hasPendingGlobalTrigger: false,

  // --- GLOBAL follow-up context ---
  // When a GLOBAL request is kicked off immediately after LOCAL completes, we
  // store the assumed-accepted text (LOCAL suggestion) plus the display baseline.
  globalFollowup: {
    // The editor text used for subset checking / display baseline.
    displayOriginalText: null,
    // The text actually sent to the server for the GLOBAL request.
    assumedAcceptedText: null,
    // The LOCAL request id that spawned this follow-up (for debugging).
    fromLocalRequestId: null,
  },
  
  // --- Preserved Content ---
  // Spans that are currently highlighted by cursor hover.
  currentlyHighlightedSpans: [],
  // --- Internal Flags ---
  // Depth counter for nested programmatic selection blocks. When > 0, the
  // `selectionchange` handler should be ignored.
  selectionMuteDepth: 0,

  // Whether a deferred scheduleTrigger is already queued (to avoid loops).
  triggerRetryPending: false,

  // --- Inline Edit Mode ---
  // When true, the inline edit dropdown is active and autocomplete/diff
  // routines should suspend renders, triggers, and cursor hinting.
  inlineEditActive: false,
  
  // --- Compose Hints Banner ---
  // Whether the compose hints banner is disabled by user settings.
  composeHintsBannerDisabled: false,

  // --- Pre-send Cleanup Suppression ---
  // When true, TabMail should suppress any non-forced re-renders that would
  // show diffs while Thunderbird is snapshotting the compose body for send.
  // This prevents transient "delete" spans from flashing during send.
  beforeSendCleanupActive: false,
  // Timer used to automatically clear beforeSendCleanupActive if the compose
  // window remains open due to a send error/cancel.
  beforeSendCleanupResetTimer: null,
  
  // --- Suggestion Adherence Tracking ---
  // Set to true when the last keystroke adhered to the current suggestion.
  // Used to skip scheduleTrigger in the input handler when user is typing
  // along with the suggestion.
  lastKeystrokeAdheredToSuggestion: false,
  // Stores detailed info about how the keystroke adhered (which diff, which char)
  // so we can directly manipulate the diffs without recomputation.
  // Format: { type: 'insert'|'delete', diffIndex: number, charIndex: number, char: string }
  adherenceInfo: null,
  
  // --- Last Rendered Text ---
  // The last rendered text and diffs.
  lastRenderedText: {
    original: null,
    corrected: null,
    diffs: null,
    show_diffs: null,
    show_newlines: null,
    originalCursorOffset: null,
  },
};

// Initialise global undo manager (single instance)
try {
  if (typeof UndoManager !== 'undefined' && !TabMail.undoManager) {
    TabMail.undoManager = new UndoManager();
    console.log('[TabMail Undo] UndoManager initialised (state.js immediate).');
  } else {
    // Library not yet loaded; defer until next tick
    setTimeout(() => {
      if (typeof UndoManager !== 'undefined' && !TabMail.undoManager) {
        TabMail.undoManager = new UndoManager();
        console.log('[TabMail Undo] UndoManager initialised (state.js deferred).');
      }
    }, 0);
  }
} catch (e) {
  console.warn('[TabMail Undo] Could not initialise UndoManager:', e);
}

// Provide global helpers for programmatic selection muting if not yet defined.
try {
  if (!TabMail._beginProgrammaticSelection) {
    TabMail._beginProgrammaticSelection = function() {
      TabMail.state.selectionMuteDepth = (TabMail.state.selectionMuteDepth || 0) + 1;
    };

    TabMail._endProgrammaticSelection = function() {
      queueMicrotask(() => {
        TabMail.state.selectionMuteDepth = Math.max(0, (TabMail.state.selectionMuteDepth || 1) - 1);
      });
    };

    // BEGIN instrumentation to trace selectionMuteDepth increments/decrements
    if (!TabMail._beginProgrammaticSelection._isInstrumented) {
      const _origBegin = TabMail._beginProgrammaticSelection;
      const _origEnd = TabMail._endProgrammaticSelection;

      TabMail._beginProgrammaticSelection = function() {
        // Instrumentation silenced – simply delegate to original.
        _origBegin.apply(this, arguments);
      };
      TabMail._beginProgrammaticSelection._isInstrumented = true;

      TabMail._endProgrammaticSelection = function() {
        // Instrumentation silenced – simply delegate to original.
        _origEnd.apply(this, arguments);
      };
      TabMail._endProgrammaticSelection._isInstrumented = true;
    }
    // END instrumentation
  }
} catch (e) {
  console.error('[TabMail State] Error initializing selection mute helpers:', e);
}