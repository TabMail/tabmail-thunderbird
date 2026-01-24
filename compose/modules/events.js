var TabMail = TabMail || {};

// Store event listener references for cleanup
TabMail._eventListeners = TabMail._eventListeners || {
  keydownHandler: null,
  selectionchangeHandler: null,
  beforeunloadHandler: null,
  compositionstartHandler: null,
  compositionendHandler: null,
  inputHandler: null,
  beforeinputHandler: null,
  focusHandler: null,
  attachedEditor: null
};

Object.assign(TabMail, {
  /**
   * Remove document/window level event listeners to prevent accumulation
   */
  cleanupEventListeners: function() {
    try {
      if (TabMail._eventListeners.keydownHandler) {
        document.removeEventListener("keydown", TabMail._eventListeners.keydownHandler, true);
        TabMail._eventListeners.keydownHandler = null;
      }
      
      if (TabMail._eventListeners.selectionchangeHandler) {
        document.removeEventListener("selectionchange", TabMail._eventListeners.selectionchangeHandler);
        TabMail._eventListeners.selectionchangeHandler = null;
      }
      
      if (TabMail._eventListeners.beforeunloadHandler) {
        window.removeEventListener("beforeunload", TabMail._eventListeners.beforeunloadHandler);
        TabMail._eventListeners.beforeunloadHandler = null;
      }
      
      if (TabMail._eventListeners.compositionstartHandler) {
        document.removeEventListener("compositionstart", TabMail._eventListeners.compositionstartHandler, true);
        TabMail._eventListeners.compositionstartHandler = null;
      }
      
      if (TabMail._eventListeners.compositionendHandler) {
        document.removeEventListener("compositionend", TabMail._eventListeners.compositionendHandler, true);
        TabMail._eventListeners.compositionendHandler = null;
      }
      
      if (TabMail._eventListeners.focusHandler) {
        window.removeEventListener("focus", TabMail._eventListeners.focusHandler);
        TabMail._eventListeners.focusHandler = null;
      }
      
      // Clean up editor-specific listeners
      if (TabMail._eventListeners.attachedEditor) {
        const editor = TabMail._eventListeners.attachedEditor;
        if (TabMail._eventListeners.inputHandler) {
          editor.removeEventListener("input", TabMail._eventListeners.inputHandler);
          TabMail._eventListeners.inputHandler = null;
        }
        if (TabMail._eventListeners.beforeinputHandler) {
          editor.removeEventListener("beforeinput", TabMail._eventListeners.beforeinputHandler);
          TabMail._eventListeners.beforeinputHandler = null;
        }
        TabMail._eventListeners.attachedEditor = null;
      }
      
      // Clean up autocomplete idle state
      if (TabMail.state) {
        if (TabMail.state.autocompleteIdleTimer) {
          clearTimeout(TabMail.state.autocompleteIdleTimer);
          TabMail.state.autocompleteIdleTimer = null;
        }
        // Reset to initial idle time on cleanup
        const config = TabMail.config.autocompleteDelay;
        if (config) {
          TabMail.state.currentIdleTime = config.INITIAL_IDLE_MS;
        }
        TabMail.state.lastSuggestionShownTime = 0;
        TabMail.state.textLengthAtLastSuggestion = 0;
        // Reset adherence tracking
        TabMail.state.lastKeystrokeAdheredToSuggestion = false;
        TabMail.state.adherenceInfo = null;
      }
      
      TabMail.log.info('events', "All event listeners cleaned up");
    } catch (e) {
      TabMail.log.error('events', `Failed to clean up event listeners: ${e}`);
    }
  },
  /**
   * Returns the inline edit wrapper element if present.
   */
  _getInlineEditWrapper: function() {
    return document.getElementById("tm-inline-edit");
  },

  /**
   * Returns the inline input element inside the wrapper if present.
   */
  _getInlineInput: function() {
    const wrapper = TabMail._getInlineEditWrapper();
    if (!wrapper) return null;
    // Prefer iframe input reference if present
    if (wrapper._tm_iinput) return wrapper._tm_iinput;
    return wrapper.querySelector('input[type="text"]');
  },

  /**
   * Determines whether a keydown represents a typing/edit key without modifiers.
   */
  _isTypingKey: function(e) {
    if (!e || e.metaKey || e.ctrlKey || e.altKey) return false;
    const k = e.key;
    return (
      (k && k.length === 1) ||
      k === 'Backspace' ||
      k === 'Delete'
    );
  },

  /**
   * Apply a single redirected key effect onto the inline input to avoid losing
   * the user's initial keystroke when designMode causes BODY to be the target.
   */
  _applyRedirectedKeyToInlineInput: function(e, inputEl) {
    try {
      const k = e.key;
      const isPrintable = k && k.length === 1;
      const isBackspace = k === 'Backspace';
      const isDelete = k === 'Delete';
      if (!(isPrintable || isBackspace || isDelete)) return false;

      if (isPrintable) {
        const start = inputEl.selectionStart ?? inputEl.value.length;
        const end = inputEl.selectionEnd ?? inputEl.value.length;
        const before = inputEl.value.slice(0, start);
        const after = inputEl.value.slice(end);
        inputEl.value = before + k + after;
        const newPos = start + k.length;
        inputEl.setSelectionRange(newPos, newPos);
      } else if (isBackspace) {
        const pos = inputEl.selectionStart ?? inputEl.value.length;
        const end = inputEl.selectionEnd ?? inputEl.value.length;
        if (pos !== end) {
          const before = inputEl.value.slice(0, pos);
          const after = inputEl.value.slice(end);
          inputEl.value = before + after;
          inputEl.setSelectionRange(pos, pos);
        } else if (pos > 0) {
          const before = inputEl.value.slice(0, pos - 1);
          const after = inputEl.value.slice(pos);
          inputEl.value = before + after;
          inputEl.setSelectionRange(pos - 1, pos - 1);
        }
      } else if (isDelete) {
        const pos = inputEl.selectionStart ?? inputEl.value.length;
        const end = inputEl.selectionEnd ?? inputEl.value.length;
        if (pos !== end) {
          const before = inputEl.value.slice(0, pos);
          const after = inputEl.value.slice(end);
          inputEl.value = before + after;
          inputEl.setSelectionRange(pos, pos);
        } else if (pos < inputEl.value.length) {
          const before = inputEl.value.slice(0, pos);
          const after = inputEl.value.slice(pos + 1);
          inputEl.value = before + after;
          inputEl.setSelectionRange(pos, pos);
        }
      }
      // Notify listeners (e.g., overlay placeholder)
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      // Ensure caret remains visible
      try {
        const pos = inputEl.selectionStart ?? inputEl.value.length;
        inputEl.setSelectionRange(pos, pos);
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  },

  /**
   * Handle all keydown logic specific to inline edit dropdown being active.
   * Returns true if the event was fully handled here and should not continue
   * through the rest of the keydown pipeline.
   */
  _handleInlineEditKeyDown: function(e) {
    if (!TabMail.state || !TabMail.state.inlineEditActive) return false;

    const wrapper = TabMail._getInlineEditWrapper();
    const inputEl = TabMail._getInlineInput();
    const hasIframeInput = !!(wrapper && wrapper._tm_iinput);
    const isInsideInline = !!(wrapper && e.target && wrapper.contains(e.target));
    const activeEl = document.activeElement;
    const isFocusInsideInline = !!(wrapper && activeEl && (activeEl === wrapper || wrapper.contains(activeEl)));

    // Log for diagnostics of focus routing under designMode
    TabMail.log.trace('events', "KeyDown:", {
      key: e.key,
      targetTag: e.target && e.target.tagName,
      targetId: e.target && e.target.id,
      inlineEditActive: true,
      isInsideInline,
      isFocusInsideInline,
    });

    // Escape: cancel inline edit gracefully
    if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (TabMail.cancelInlineEditDropdown) {
          TabMail.cancelInlineEditDropdown();
        }
      } catch (_) {}
      return true;
    }

    // Cmd/Ctrl+A should select only inline input when available
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a' && inputEl) {
      e.preventDefault();
      e.stopPropagation();
      try { inputEl.focus(); inputEl.select(); } catch (_) {}
      return true;
    }

    // If focus is inside the inline wrapper (e.g., iframe input), do not intercept
    // at the top document. Let the focused context process typing. Do not consume here.
    if (isInsideInline || isFocusInsideInline) {
      return true;
    }

    // Otherwise, if this looks like a typing key without modifiers, redirect
    // it into the inline input to avoid losing the initial keystroke.
    if (inputEl && TabMail._isTypingKey(e)) {
      // In iframe mode, do NOT synthesize; just ensure focus and consume at top level.
      if (hasIframeInput) {
        e.preventDefault();
        e.stopPropagation();
        try { inputEl.focus(); } catch (_) {}
        return true;
      }
      // Legacy non-iframe inline input: synthesize text edits to avoid losing first key.
      e.preventDefault();
      e.stopPropagation();
      try { inputEl.focus(); } catch (_) {}
      TabMail._applyRedirectedKeyToInlineInput(e, inputEl);
      return true;
    }

    // For Enter/Tab, focus input and stop bubbling so the input's own handler applies.
    if (inputEl && (e.key === 'Enter' || e.key === 'Tab')) {
      // In iframe mode, Enter is handled inside iframe; just consume here.
      try { inputEl.focus(); } catch (_) {}
      e.stopPropagation();
      e.preventDefault();
      return true;
    }

    return false;
  },

  /**
   * Handles the inline edit entry shortcut (Cmd/Ctrl+K). Returns true if handled.
   */
  _handleInlineEditShortcut: function(e) {
    const isEditShortcut = (
      (TabMail.config.keys.inlineEditCmd && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === TabMail.config.keys.inlineEditCmd.key) ||
      (TabMail.config.keys.inlineEditCtrl && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === TabMail.config.keys.inlineEditCtrl.key)
    );
    if (!isEditShortcut) return false;

    e.preventDefault();
    e.stopPropagation();
    try {
      TabMail.log.debug('inlineEdit', "Entering inlineEdit mode from keydown.", {
        key: e.key,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        activeElementTag: document.activeElement && document.activeElement.tagName,
        activeElementId: document.activeElement && document.activeElement.id,
      });
      // enter inline edit mode: disable diffs, suspend triggers/autohide
      TabMail.state.inlineEditActive = true;
      // keep diffs hidden as if user is actively typing
      if (TabMail.state.diffRestoreTimer) {
        clearTimeout(TabMail.state.diffRestoreTimer);
        TabMail.state.diffRestoreTimer = null;
      }
      TabMail.state.autoHideDiff = true;
      // Render without diffs immediately to stabilise DOM
      // const editor = TabMail.state.editorRef;
      // if (editor) {
      //   console.log("[TabMail RenderText] Rendering text without diffs immediately to stabilise DOM");
      //   TabMail.renderText((show_diffs = false), (show_newlines = true), /*force*/ true);
      // }
      if (TabMail && TabMail.showInlineEditDropdown) {
        TabMail.log.debug('inlineEdit', "Cmd/Ctrl+K pressed - showing inline edit dropdown");
        TabMail.showInlineEditDropdown();
      } else {
        TabMail.log.warn('inlineEdit', "Inline edit API not available.");
      }
    } catch (err) {
      TabMail.log.error('inlineEdit', "Failed to enter inline edit mode:", err);
    }
    return true;
  },
  /**
   * Intercept beforeinput on the editor while inline edit dropdown is active,
   * so the compose editor does not consume keystrokes that should go to the
   * inline input.
   */
  handleBeforeInput: function (e) {
    try {
      if (!TabMail.state || !TabMail.state.inlineEditActive) {
        return false;
      }
      const editor = TabMail.state.editorRef;
      if (!editor) return false;
      const inlineWrapper = document.getElementById("tm-inline-edit");
      const isTargetInEditor = editor.contains(e.target);
      const isFocusInsideInline = !!(inlineWrapper && document.activeElement && inlineWrapper.contains(document.activeElement));
      if (isTargetInEditor && !isFocusInsideInline) {
        TabMail.log.debug('inlineEdit', "Suppressing editor beforeinput due to inline edit active.", {
          inputType: e.inputType,
          isComposing: !!e.isComposing,
        });
        e.preventDefault();
        e.stopPropagation();

        // Attempt to shift focus to the inline input, then let keydown redirect logic run.
        try {
          const inputEl = inlineWrapper && inlineWrapper.querySelector('input[type="text"]');
          if (inputEl) inputEl.focus();
        } catch (_) {}
        return true;
      }
    } catch (err) {
      TabMail.log.warn('inlineEdit', "handleBeforeInput error:", err);
    }
    return false;
  },
  /**
   * Checks if a keyboard event matches a given key configuration.
   * @param {KeyboardEvent} event The keyboard event.
   * @param {object} keyConfig The key configuration object {key, shiftKey, ctrlKey, ...}.
   * @returns {boolean} True if the event matches the configuration.
   * @private
   */
  _isKeyMatch: function (event, keyConfig) {
    if (!keyConfig) return false;
    return (
      event.key === keyConfig.key &&
      event.shiftKey === (keyConfig.shiftKey || false) &&
      event.ctrlKey === (keyConfig.ctrlKey || false) &&
      event.altKey === (keyConfig.altKey || false) &&
      event.metaKey === (keyConfig.metaKey || false)
    );
  },

  /**
   * Helper to (re)schedule the correction trigger. Note that this function
   * resets the timer, so can be called multiple times and the most recent
   * call will be the timeout.
   */
  /**
   * Check for long idle period and reset idle time if needed.
   */
  _checkAndResetIdleTime: () => {
    const now = Date.now();
    const config = TabMail.config.autocompleteDelay;
    const state = TabMail.state;
    
    // Check for long idle period - reset idle time if user was away
    if (now - state.lastUserActivityTime > config.RESET_AFTER_IDLE_MS) {
      TabMail.log.debug('events', 
        `Long idle period detected (${((now - state.lastUserActivityTime) / 1000).toFixed(1)}s), ` +
        `resetting idle time to ${config.INITIAL_IDLE_MS}ms`
      );
      state.currentIdleTime = config.INITIAL_IDLE_MS;
      state.lastSuggestionShownTime = 0;
    }
  },

  scheduleTrigger: (editorInstance) => {
    if (TabMail.state && TabMail.state.inlineEditActive) {
      TabMail.log.debug('events', "scheduleTrigger: suppressed due to inlineEditActive.");
      return;
    }
    // Skip scheduling while we are inside a programmatic selection block.
    if (!TabMail.state || TabMail.state.selectionMuteDepth > 0) {
      // Note that this should almost never happen.
      TabMail.log.debug('events', "scheduleTrigger: skipping due to selection mute. (depth:",
        TabMail.state.selectionMuteDepth,
        ")"
      );
      return;
    }

    // If an IME composition is active, postpone any trigger until it ends.
    if (TabMail.state.isIMEComposing) {
      TabMail.log.debug('events', "scheduleTrigger: IME composition in progress; skipping."
      );
      return;
    }

    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed) {
      TabMail.log.debug('events', "scheduleTrigger: skipping due to active selection."
      );
      return; // User has an active selection; wait.
    }

    // Track user activity for long-idle reset
    const now = Date.now();
    TabMail.state.lastUserActivityTime = now;
    
    // Check for long idle and reset if needed
    TabMail._checkAndResetIdleTime();

    // Check if user is ignoring a previously shown suggestion
    if (TabMail.state.lastSuggestionShownTime > 0 && TabMail.state.textLengthAtLastSuggestion > 0) {
      const { originalUserMessage } = TabMail.extractUserAndQuoteTexts(editorInstance);
      const currentLength = originalUserMessage.length;
      const charsTypedSinceSuggestion = Math.abs(currentLength - TabMail.state.textLengthAtLastSuggestion);
      const config = TabMail.config.autocompleteDelay;
      
      if (charsTypedSinceSuggestion >= config.IGNORE_CHARS_THRESHOLD) {
        // User has typed enough new characters - this counts as ignoring the suggestion
        const oldIdleTime = TabMail.state.currentIdleTime;
        TabMail.state.currentIdleTime = Math.min(
          TabMail.state.currentIdleTime + config.BACKOFF_STEP_MS,
          config.MAX_IDLE_MS
        );
        
        if (TabMail.state.currentIdleTime !== oldIdleTime) {
          TabMail.log.info('events', 
            `Suggestion ignored (${charsTypedSinceSuggestion} chars typed), backing off idle time: ${oldIdleTime}ms → ${TabMail.state.currentIdleTime}ms`
          );
        }
        
        // Reset tracking so we don't count this ignore multiple times
        TabMail.state.lastSuggestionShownTime = 0;
        TabMail.state.textLengthAtLastSuggestion = 0;
      }
    }

    // Clear any existing idle timer (user is still typing)
    if (TabMail.state.autocompleteIdleTimer) {
      clearTimeout(TabMail.state.autocompleteIdleTimer);
      TabMail.state.autocompleteIdleTimer = null;
      TabMail.log.trace('events', "Cleared previous idle timer (user still typing)");
    }

    const config = TabMail.config.autocompleteDelay;
    const idleTime = TabMail.state.currentIdleTime;
    
    // Schedule LLM request after user stops typing for currentIdleTime
    TabMail.state.autocompleteIdleTimer = setTimeout(() => {
      TabMail.state.autocompleteIdleTimer = null;
      
      TabMail.log.debug('events', 
        `User idle for ${idleTime}ms, sending LOCAL LLM request #${TabMail.state.latestLocalRequestId + 1}`
      );
      
      // Send request - response will be shown immediately when it arrives
      TabMail.triggerCorrection(editorInstance);
    }, idleTime);
    
    TabMail.log.trace('events', 
      `scheduleTrigger: will send LLM request after ${idleTime}ms idle`
    );
  },

  /**
   * Attaches the autocomplete functionality to the editor element.
   * @param {HTMLElement} editor The content-editable editor element.
   */
  attachAutocomplete: function (editor) {
    // Prevent duplicate attachment to the same editor
    if (TabMail._eventListeners.attachedEditor === editor) {
      TabMail.log.warn('events', "⚠️ attachAutocomplete called multiple times for same editor - skipping duplicate attachment");
      return;
    }
    
    // Clean up any existing listeners first to prevent accumulation
    TabMail.cleanupEventListeners();
    
    TabMail.state.editorRef = editor;
    TabMail._eventListeners.attachedEditor = editor;
    TabMail.log.info('events', "Attaching autocomplete listeners to editor:", editor);

    // ------------------------------------------------------------------
    // Compose wrapping fix:
    // In some compose contexts, the editor (often BODY under designMode) inherits
    // `white-space: pre` (no wrapping). Quotes/signatures may wrap because they
    // have their own `white-space: pre-wrap` styles, but user content won't.
    // Force the editor itself to allow wrapping. Use inline !important so we
    // win over document styles.
    // ------------------------------------------------------------------
    try {
      if (!TabMail.state._tmComposeWrapFixLogged) {
        TabMail.state._tmComposeWrapFixLogged = true;
        try {
          const cs0 = window.getComputedStyle(editor);
          TabMail.log.info('events', "Compose wrap BEFORE", {
            tag: editor && editor.tagName,
            designMode: document.designMode,
            inlineWhiteSpace: editor && editor.style && editor.style.whiteSpace,
            computedWhiteSpace: cs0 && cs0.whiteSpace,
            computedOverflowWrap: cs0 && (cs0.overflowWrap || cs0.getPropertyValue("overflow-wrap")),
            computedWordBreak: cs0 && cs0.wordBreak,
          });
        } catch (_) {}
      }

      if (editor && editor.style && typeof editor.style.setProperty === "function") {
        editor.style.setProperty("white-space", "pre-wrap", "important");
        editor.style.setProperty("overflow-wrap", "anywhere", "important");
        editor.style.setProperty("word-break", "break-word", "important");

        // Also ensure the editor participates in normal block layout and is width-constrained.
        // This addresses cases where the editor behaves like shrink-to-content, preventing wrap.
        const wrapCfg = (TabMail.config && TabMail.config.composeWrap) || {};
        const widthPct =
          typeof wrapCfg.EDITOR_WIDTH_PERCENT === "number"
            ? wrapCfg.EDITOR_WIDTH_PERCENT
            : 100;
        const maxWidthPct =
          typeof wrapCfg.EDITOR_MAX_WIDTH_PERCENT === "number"
            ? wrapCfg.EDITOR_MAX_WIDTH_PERCENT
            : 100;
        const minWidthPx =
          typeof wrapCfg.EDITOR_MIN_WIDTH_PX === "number"
            ? wrapCfg.EDITOR_MIN_WIDTH_PX
            : 0;

        editor.style.setProperty("display", "block", "important");
        editor.style.setProperty("box-sizing", "border-box", "important");
        editor.style.setProperty("width", `${widthPct}%`, "important");
        editor.style.setProperty("max-width", `${maxWidthPct}%`, "important");
        editor.style.setProperty("min-width", `${minWidthPx}px`, "important");
      }

      if (!TabMail.state._tmComposeWrapFixLoggedAfter) {
        TabMail.state._tmComposeWrapFixLoggedAfter = true;
        try {
          const cs1 = window.getComputedStyle(editor);
          const r1 = editor && editor.getBoundingClientRect
            ? editor.getBoundingClientRect()
            : null;
          TabMail.log.info('events', "Compose wrap AFTER", {
            tag: editor && editor.tagName,
            inlineWhiteSpace: editor && editor.style && editor.style.whiteSpace,
            inlineDisplay: editor && editor.style && editor.style.display,
            inlineWidth: editor && editor.style && editor.style.width,
            inlineMaxWidth: editor && editor.style && editor.style.maxWidth,
            inlineMinWidth: editor && editor.style && editor.style.minWidth,
            computedWhiteSpace: cs1 && cs1.whiteSpace,
            computedOverflowWrap: cs1 && (cs1.overflowWrap || cs1.getPropertyValue("overflow-wrap")),
            computedWordBreak: cs1 && cs1.wordBreak,
            computedDisplay: cs1 && cs1.display,
            rectWidth: r1 ? r1.width : null,
            clientWidth: editor && typeof editor.clientWidth === "number" ? editor.clientWidth : null,
            scrollWidth: editor && typeof editor.scrollWidth === "number" ? editor.scrollWidth : null,
          });
        } catch (_) {}
      }
    } catch (e) {
      TabMail.log.warn('events', "Compose wrap fix failed:", e);
    }

    // Initialize autocomplete idle time from config
    if (TabMail.config.autocompleteDelay) {
      TabMail.state.currentIdleTime = TabMail.config.autocompleteDelay.INITIAL_IDLE_MS;
      TabMail.log.info('events', `Initialized autocomplete idle time to ${TabMail.state.currentIdleTime}ms`);
    }

    // --- Baseline undo snapshot ---
    if (TabMail.undoManager && !TabMail.state.undoBaselineAdded) {
      TabMail.log.debug('undo', "Queuing baseline snapshot (empty -> first input)."
      );
      TabMail.state.pendingUndoSnapshot = {
        text: "",
        cursor: 0,
        marker: "baseline",
      };
      // Note: actual commit happens upon first `input` event.
      // We set the flag to avoid duplicate queuing.
      TabMail.state.undoBaselineAdded = true;
    }

    // IME Composition tracking - handled by global document listeners below

    // Global IME event handling (capture phase to catch all events)
    TabMail._eventListeners.compositionstartHandler = (e) => {
      // console.log("[TMDBG IME] compositionstart event received");
      // Handle composition events that are related to our editor OR when using designMode
      const isRelatedToEditor = TabMail.state.editorRef && TabMail.state.editorRef.contains(e.target);
      const isDesignModeComposition = document.designMode === "on" && e.target.tagName === "HTML";
      
      if (isRelatedToEditor || isDesignModeComposition) {
        // Set the IME composition flag
        TabMail.state.isIMEComposing = true;
        
        // Handle cursor positioning and autohide diffs
        TabMail.handleCursorInInsertSpan(e);
        TabMail.handleAutohideDiff(e);
        
        // Cancel any restore timer
        if (TabMail.state.diffRestoreTimer) {
          clearTimeout(TabMail.state.diffRestoreTimer);
          TabMail.state.diffRestoreTimer = null;
        }
      }
    };
    document.addEventListener("compositionstart", TabMail._eventListeners.compositionstartHandler, true);
    
    TabMail._eventListeners.compositionendHandler = (e) => {
      // Handle composition events that are related to our editor OR when using designMode
      const isRelatedToEditor = TabMail.state.editorRef && TabMail.state.editorRef.contains(e.target);
      const isDesignModeComposition = document.designMode === "on" && e.target.tagName === "HTML";
      
      if (isRelatedToEditor || isDesignModeComposition) {
        TabMail.state.isIMEComposing = false;

        // Schedule diff restore after the standard delay
        if (TabMail.state.diffRestoreTimer) {
          clearTimeout(TabMail.state.diffRestoreTimer);
        }
        TabMail.state.diffRestoreTimer = setTimeout(() => {
          TabMail.state.autoHideDiff = false;
          // Render the diffs after updating the autoHideDiff flag
          const show_diffs = TabMail.state.showDiff && !TabMail.state.autoHideDiff;
          TabMail.log.trace('renderText', "Rendering text with diffs after IME composition end");
          TabMail.renderText(show_diffs);
          TabMail.state.diffRestoreTimer = null;
        }, TabMail.config.DIFF_RESTORE_DELAY_MS);

        // After composition ends, schedule a trigger immediately.
        TabMail.log.debug('events', "compositionend triggered, scheduling autocomplete");
        TabMail.scheduleTrigger(editor);
      }
    };
    document.addEventListener("compositionend", TabMail._eventListeners.compositionendHandler, true);

    // Input (typing)
    TabMail._eventListeners.inputHandler = (e) => {
      // Defer the trigger if an IME composition is in progress.
      // The `compositionend` event will schedule the trigger instead.
      if (TabMail.state.isIMEComposing) {
        TabMail.log.debug('events', "Input during IME composition; trigger deferred (compositionend will handle it)."
        );
        return;
      }
      
      // Check if the keystroke adhered to the current suggestion.
      // If so, skip scheduling a new completion request - the user is typing along with the suggestion.
      let skipScheduleTrigger = false;
      if (TabMail.state.lastKeystrokeAdheredToSuggestion) {
        TabMail.log.info('events', "Input adhered to suggestion - updating diffs directly");
        // Clear the flag for the next keystroke
        TabMail.state.lastKeystrokeAdheredToSuggestion = false;
        
        // Apply the adherence to modify diffs in place (prevents scattering)
        const adherenceInfo = TabMail.state.adherenceInfo;
        TabMail._applyAdherenceToDiffs(adherenceInfo);
        TabMail.state.adherenceInfo = null;
        
        // Render using the modified diffs (no recomputation)
        // Pass advanceCursorBy for special cases (e.g., Enter before newline)
        const advanceCursorBy = adherenceInfo && adherenceInfo.advanceCursorBy ? adherenceInfo.advanceCursorBy : 0;
        TabMail._renderWithExistingDiffs(advanceCursorBy);
        
        skipScheduleTrigger = true;
      }
      
      if (!skipScheduleTrigger) {
        TabMail.log.trace('events', "Input event triggered (non-IME), scheduling autocomplete trigger."
        );
        // After any input, schedule a correction.
        TabMail.scheduleTrigger(editor);
      }

      // ---------------- Undo snapshot finalisation ----------------
      const pending = TabMail.state.pendingUndoSnapshot;
      if (pending) {
        try {
          const { originalUserMessage: afterText } =
            TabMail.extractUserAndQuoteTexts(editor);
          const afterCursor = TabMail.getCursorOffsetIgnoringInserts(editor);

          // Adjust cursor for space vs newline so that UNDO places the caret sensibly.
          let beforeCursor = pending.cursor;
          if (
            e.inputType === "insertParagraph" ||
            e.inputType === "insertLineBreak"
          ) {
            beforeCursor = afterCursor;
          } else if (e.inputType === "insertText" && e.data === " ") {
            beforeCursor = Math.max(0, afterCursor - 1);
          }

          TabMail.log.trace('undo', "Snapshot committed (", e.inputType, ")");
          TabMail.pushUndoSnapshot(
            pending.text,
            beforeCursor,
            afterText,
            afterCursor,
            pending.marker || "typing"
          );

          if (pending.marker === "baseline") {
            TabMail.log.trace('undo', "Baseline snapshot committed.");
          }
        } catch (err) {
          TabMail.log.error('undo', "Failed to complete pending snapshot:",
            err
          );
        } finally {
          // Clear pending snapshot irrespective of success or failure.
          TabMail.state.pendingUndoSnapshot = null;
        }
      }
    };
    editor.addEventListener("input", TabMail._eventListeners.inputHandler);

    // Note that key down does NOT register trigger, as trigger should be
    // registered when user STOPS typing. However, some operations require us
    // to deal with the events immediately when key is pressed, so that they
    // don't appear on screen.
    TabMail._eventListeners.keydownHandler = TabMail.handleKeyDown;
    document.addEventListener("keydown", TabMail._eventListeners.keydownHandler, true);

    // Intercept typing to handle insertion inside diff spans.
    TabMail._eventListeners.beforeinputHandler = TabMail.handleBeforeInput;
    editor.addEventListener("beforeinput", TabMail._eventListeners.beforeinputHandler);

    // Add listener for cursor movement to highlight spans as well as trigger
    // for completion call to the backend.
    TabMail._eventListeners.selectionchangeHandler = () => {
      // Debounce selection change handling to avoid re-renders during multi-click/drag gestures.
      if (TabMail.state.selectionDebounceTimer) {
        clearTimeout(TabMail.state.selectionDebounceTimer);
      }

      TabMail.state.selectionDebounceTimer = setTimeout(() => {
        TabMail.state.selectionDebounceTimer = null;

        const sel = window.getSelection();
        const isCollapsed = sel && sel.isCollapsed;

        // Only render diffs when there is no active selection to avoid disrupting
        // double-/triple-click gestures.
        if (isCollapsed) {
          TabMail.log.trace('renderText', "Selection changed (collapsed) -- rendering diffs.");
          const show_diffs = TabMail.state.showDiff && !TabMail.state.autoHideDiff;
          TabMail.renderText(show_diffs);
        }

        // Always update highlighting – works for both collapsed and ranged selections.
        TabMail.handleCursorHighlighting();

        // // Handle completion call to the backend.
        // TabMail.scheduleTrigger(editor);

        // console.log(
        //   "[TabMail Events] Selection change debounce fired -- cursor highlighting handled."
        // );
      }, TabMail.config.SELECTION_DEBOUNCE_MS);
    };
    document.addEventListener("selectionchange", TabMail._eventListeners.selectionchangeHandler);

    // When window regains focus, focus editor if inline edit is not active.
    TabMail._eventListeners.focusHandler = () => {
      try {
        if (!TabMail.state.inlineEditActive && TabMail.state.editorRef) {
          TabMail.state.editorRef.focus();
        }
      } catch (_) {}
    };
    window.addEventListener("focus", TabMail._eventListeners.focusHandler);

    // When the window is about to be closed, cancel any pending correction
    // requests to prevent a final, unnecessary, and blocking network call.
    TabMail._eventListeners.beforeunloadHandler = () => {
      if (TabMail.state.typingTimer) {
        clearTimeout(TabMail.state.typingTimer);
      }
      
      // Also clean up other event listeners on unload
      TabMail.cleanupEventListeners();
    };
    window.addEventListener("beforeunload", TabMail._eventListeners.beforeunloadHandler);

    // Initialize editor content structure by rendering once with empty content
    // This ensures the inline editor can work properly even when the compose window is empty.
    // For reply/precompose, this is already done via preloaded suggestions.
    // For new compose windows, we need to do this explicitly.
    try {
      const { originalUserMessage, quoteBoundaryNode } = TabMail.extractUserAndQuoteTexts(editor);
      const isEmpty = !originalUserMessage || originalUserMessage.trim() === "";
      
      // If this is an empty reply/forward window with a quote boundary, remove trailing newlines
      // to prevent diff splitting issues. Thunderbird initially adds two newlines before the quote.
      if (isEmpty && quoteBoundaryNode) {
        // Check if there are trailing newlines (likely two) before the quote
        const trailingNewlines = originalUserMessage.match(/\n+$/);
        if (trailingNewlines && trailingNewlines[0].length >= 2) {
          TabMail.log.debug('events', `Removing ${trailingNewlines[0].length} trailing newlines from initial empty reply/forward`);
          
          // Remove trailing newlines from the DOM by finding and removing <br> elements before the quote
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.setEndBefore(quoteBoundaryNode);
          
          // Find all trailing <br> elements before the quote
          const walker = document.createTreeWalker(
            range.cloneContents(),
            NodeFilter.SHOW_ELEMENT,
            { acceptNode: (node) => node.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }
          );
          
          const brs = [];
          let node;
          while (node = walker.nextNode()) {
            brs.push(node);
          }
          
          // Remove trailing <br> elements (up to 2) from the actual DOM
          let removed = 0;
          let currentNode = quoteBoundaryNode.previousSibling;
          while (currentNode && removed < 2) {
            if (currentNode.nodeType === Node.ELEMENT_NODE && currentNode.tagName === 'BR') {
              const toRemove = currentNode;
              currentNode = currentNode.previousSibling;
              toRemove.remove();
              removed++;
            } else if (currentNode.nodeType === Node.TEXT_NODE && currentNode.textContent.trim() === '') {
              // Skip empty text nodes
              currentNode = currentNode.previousSibling;
            } else {
              break;
            }
          }
          
          TabMail.log.debug('events', `Removed ${removed} trailing <br> elements`);
        }
      }
      
      if (isEmpty) {
        TabMail.log.debug('events', "Initializing editor content structure with empty renderText call"
        );
        // Set initial state to empty so renderText has something to work with
        TabMail.state.originalText = "";
        TabMail.state.correctedText = "";
        TabMail.state.isDiffActive = false;
        // Render once with no diffs to initialize the DOM structure
        TabMail.renderText(false);
      }
    } catch (err) {
      TabMail.log.error('events', "Error initializing editor content structure:", err);
    }

    // Ask the background script if we should trigger an initial correction.
    TabMail.log.info('events', "Asking background script to check for initial trigger."
    );
    browser.runtime.sendMessage({ type: "initialTriggerCheck" });
  },

  handleUndoRedoKey: function (e) {
    // --- Undo / Redo shortcuts (Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z / Ctrl+Y) ---
    const keyLower = e.key.toLowerCase();
    const isUndoShortcut =
      (e.metaKey || e.ctrlKey) && !e.shiftKey && keyLower === "z";
    const isRedoShortcut =
      (e.metaKey || e.ctrlKey) &&
      ((e.shiftKey && keyLower === "z") || keyLower === "y");
    if ((isUndoShortcut || isRedoShortcut) && TabMail.undoManager) {
      TabMail.log.debug('undo', "shortcut", isUndoShortcut ? "UNDO" : "REDO");
      e.preventDefault();
      e.stopPropagation();
      if (isUndoShortcut) {
        TabMail.undoManager.undo();
      } else {
        TabMail.undoManager.redo();
      }
      // After state changes, re-render and schedule backend correction once.
      const editor = TabMail.state.editorRef;
      if (editor) {
        // Render Text
        // Note: only render the diffs if they are enabled and not auto-hidden.
        TabMail.log.trace('renderText', "Rendering text with diffs after undo/redo");
        const show_diffs = TabMail.state.showDiff && !TabMail.state.autoHideDiff;
        TabMail.renderText(show_diffs);
        TabMail.scheduleTrigger(editor);
      }
      return true;
    }
    return false;
  },

  handleToggleDiffViewKey: function (e) {
    // --- Key handling for Shift+Esc to toggle diffs ---
    if (TabMail._isKeyMatch(e, TabMail.config.keys.toggleDiffView)) {
      e.preventDefault();
      e.stopPropagation();

      TabMail.state.showDiff = !TabMail.state.showDiff;
      TabMail.log.debug('events', `Toggled diff visibility (css only): ${TabMail.state.showDiff}`
      );

      // Update render
      TabMail.log.trace('renderText', "Updating render after toggle diff view");
      const show_diffs = TabMail.state.showDiff && !TabMail.state.autoHideDiff;
      TabMail.renderText(show_diffs);

      return true;
    }
    
    // --- Key handling for plain Esc to hide suggestions ---
    if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Only handle if we have visible suggestions
      if (TabMail.state.correctedText && TabMail.state.showDiff && !TabMail.state.autoHideDiff) {
        e.preventDefault();
        e.stopPropagation();
        
        TabMail.log.info('events', 'ESC pressed - hiding suggestions until next typing');
        
        // Clear suggestion state
        TabMail.state.correctedText = null;
        
        // Render without diffs
        TabMail.renderText(false);
        
        // Reset tracking (ESC doesn't count as ignore - just hide)
        TabMail.state.lastSuggestionShownTime = 0;
        TabMail.state.textLengthAtLastSuggestion = 0;
        
        return true;
      }
    }
    
    return false;
  },

  handleAcceptRejectKey: function (e) {
    const editor = TabMail.state.editorRef;

    const isLocalAccept = TabMail._isKeyMatch(
      e,
      TabMail.config.keys.localAccept
    );
    const isLocalReject = TabMail._isKeyMatch(
      e,
      TabMail.config.keys.localReject
    );
    const isGlobalAccept = TabMail._isKeyMatch(
      e,
      TabMail.config.keys.globalAccept
    );
    const isNavigateForward = TabMail._isKeyMatch(
      e,
      TabMail.config.keys.navigateForward
    );
    const isNavigateBackward = TabMail._isKeyMatch(
      e,
      TabMail.config.keys.navigateBackward
    );
    const isAccept = isLocalAccept || isGlobalAccept;
    const isReject = isLocalReject; // Note: Only local reject exists.
    const isAction = isAccept || isReject;
    const isNav = isNavigateForward || isNavigateBackward;

    if (!isAction && !isNav) {
      return false; // Not a key we care about.
    }

    // 1. Determine targets based on the action scope (global vs. local).
    let targets = [];
    if (isGlobalAccept) {
      TabMail.log.debug('events', `handleKeyDown: Global Accept (Shift-Tab)`);
      const insElements = editor.querySelectorAll(
        'span[data-tabmail-diff="insert"]'
      );
      const delElements = editor.querySelectorAll(
        'span[data-tabmail-diff="delete"]'
      );
      targets = [...insElements, ...delElements];
      TabMail.log.debug('events', "Targets:", targets);
    } else if (isAction) {
      // A local action
      // Get original text and diffs from last rendered state for sentence-based span finding
      const { original: originalText, diffs: diffsToRender } = TabMail.state.lastRenderedText;
      // console.log("[TabMail DOM] Finding spans at cursor:", TabMail.state.lastRenderedText);
      targets = TabMail.findSpansAtCursor(originalText, diffsToRender);
      // console.groupCollapsed(`[TabMail Events] handleKeyDown: Local Action`);
      // console.log("Found spans:", targets);
      // console.log("Unique targets:", targets);
      // console.groupEnd();
    }

    // If we have targets, or navigating,we stop default key behavior (note
    // that if we don't have targets we should not!)
    if (targets.length > 0 || isNav) {
      e.preventDefault();
      e.stopPropagation();
    }

    // 2. If we have an action and targets, process them.
    if (isAction && targets.length > 0) {
      const initialCursorOffset = TabMail.getCursorOffset(editor);
      // Capture snapshot BEFORE we mutate DOM (only for accept actions)
      let snapshotBefore = null;
      if (isAccept && TabMail.undoManager) {
        const { originalUserMessage: beforeUserText } =
          TabMail.extractUserAndQuoteTexts(editor);
        snapshotBefore = {
          text: beforeUserText,
          cursor: TabMail.getCursorOffsetIgnoringInserts(editor),
        };
      }

      let newCursorOffset = initialCursorOffset;
      let placeCursorAfterNode = false;
      let nodeForCursor = null;

      for (const span of targets) {
        const result = TabMail.processSpanAction(
          span,
          isAccept,
          isGlobalAccept,
          newCursorOffset,
          editor
        );

        newCursorOffset = result.newCursorOffset;
        if (result.nodeForCursor) {
          nodeForCursor = result.nodeForCursor;
        }
        // This can be overwritten in the loop, which is the intended behavior
        // for handling multiple targets (e.g., global accept).
        placeCursorAfterNode = result.placeCursorAfterNode;
      }

      // Move cursor appropriately (the only case we use the node-based logic
      // is the local accept)
      if (placeCursorAfterNode && nodeForCursor) {
        TabMail.log.debug('events', "handleKeyDown: Setting cursor after node.",
          nodeForCursor
        );
        TabMail.setCursorAfterNode(nodeForCursor);
      } else {
        TabMail.log.debug('events', "handleKeyDown: Setting cursor by offset.",
          newCursorOffset
        );
        TabMail.setCursorByOffset(editor, newCursorOffset);
      }

      // Capture snapshot AFTER mutations and push to undo stack
      if (snapshotBefore) {
        const { originalUserMessage: afterUserText } =
          TabMail.extractUserAndQuoteTexts(editor);
        const snapshotAfter = {
          text: afterUserText,
          cursor: TabMail.getCursorOffsetIgnoringInserts(editor),
        };
        try {
          TabMail.log.debug('undo', "Accept - Before len", snapshotBefore.text.length, "After len", snapshotAfter.text.length);

          // Replaced manual undoManager handler with centralised helper
          TabMail.pushUndoSnapshot(
            snapshotBefore.text,
            snapshotBefore.cursor,
            snapshotAfter.text,
            snapshotAfter.cursor,
            "accept"
          );
        } catch (err) {
          TabMail.log.error('undo', "Failed to register undo snapshot:",
            err
          );
        }
      }

      // 3. If no action was taken, but a navigation key was pressed, navigate.
    } else if (isNav) {
      const direction = isNavigateBackward ? "backward" : "forward";
      const closestSpan = TabMail.findClosestSpan(direction);
      if (closestSpan) {
        TabMail.log.debug('events', "handleKeyDown: Navigating to closest span.",
          closestSpan
        );
        TabMail.setCursorBeforeNode(closestSpan);
      }
    }

    // Also un-highlight any existing spans if we lose focus.
    TabMail.updateSpanHighlighting([]);
    return true;
  },

  handleCursorInInsertSpan: function (e) {
    // Early return if we are not doing any insertions -- support both keydown
    // and beforeinput events.

    const isInsert = TabMail.isInputEvent(e);

    if (!isInsert) {
      // console.log(
      //   `[TabMail] ${e.type} ${
      //     e.key || e.inputType
      //   } Not an insert, returning.`
      // );
      return false;
    }

    TabMail.log.trace('autohideDiff', "handleCursorInInsertSpan: Insert detected, handling cursor relocation.");

    // If the caret is currently INSIDE an <span data-tabmail-diff="insert">,
    // move it *before* that span so that the cursor doesn't disappear once
    // inserts are hidden. We intentionally exclude "touching" neighbor spans
    // here – we only care about the span that actually contains the caret.
    try {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed) {
        // Only run when no active selection
        const spansAtCursorStrict = TabMail.findSpansAtCursor(false); // exclude neighbors
        if (spansAtCursorStrict.length === 1) {
          const span = spansAtCursorStrict[0];
          if (span && span.dataset.tabmailDiff === "insert") {
            TabMail.log.debug('events', "Cursor inside INSERT span – relocating to span start."
            );
            TabMail.setCursorBeforeNode(span);
          }
        }
      }
    } catch (cursorRelocateErr) {
      TabMail.log.error('events', "Failed to relocate cursor before hiding inserts:",
        cursorRelocateErr
      );
    }

    return true;
  },

  /**
   * Handles keydown events in the editor, specifically for accepting (Tab)
   * or rejecting (Shift+Tab) the diff suggestion.
   * @param {KeyboardEvent} e The keyboard event.
   */
  handleKeyDown: function (e) {
    try {
      // If inline edit is active, delegate to the dedicated handler to keep this flow readable.
      if (TabMail._handleInlineEditKeyDown(e)) return;
    } catch (_) {}

    // Cmd/Ctrl+K inline edit entry
    if (TabMail._handleInlineEditShortcut(e)) return;

    // Global Escape now handled inside _handleInlineEditKeyDown to ensure correct ordering

    // Undo/redo -- if it runs, we don't do anything else.
    const didHandleUndoRedoRun = TabMail.handleUndoRedoKey(e);
    if (didHandleUndoRedoRun) {
      TabMail.log.trace('autohideDiff', "handleUndoRedoKey");
      return;
    }

    // Toggle diff view -- again, if it runs, we don't do anything else.
    const didHandleToggleDiffViewRun = TabMail.handleToggleDiffViewKey(e);
    if (didHandleToggleDiffViewRun) {
      TabMail.log.trace('autohideDiff', "handleKeyDown: Toggle diff view");
      return;
    }

    // Handle cursor movement tooltip Tab key
    const didHandleCursorMovementRun = TabMail.handleCursorMovementKey(e);
    if (didHandleCursorMovementRun) {
      TabMail.log.trace('autohideDiff', "handleKeyDown: Cursor movement");
      return;
    }

    // Accept/reject -- if it runs, we don't do anything else either.
    const didHandleAcceptRejectRun = TabMail.handleAcceptRejectKey(e);
    if (didHandleAcceptRejectRun) {
      TabMail.log.trace('autohideDiff', "handleKeyDown: Accept/reject");
      return;
    }

    // Undo snapshot -- no need to check output for now.
    TabMail.handleUndoSnapshot(e);

    // If we have an active selection, we handle it. This also triggers early
    // exit, so that we don't ruin the action that people expect with a
    // selection.
    const didHandleInputWhileSelectionRun = TabMail.handleInputWhileSelection(e);
    if (didHandleInputWhileSelectionRun) {
      TabMail.log.trace('autohideDiff', "handleKeyDown: Input while selection");
      return;
    }
    // Note from here we are sure we don't have a selection.

    // Normalize cursor position to be before the diff span if it is inside one
    // if we are doing any insertions.
    TabMail.handleCursorInInsertSpan(e);

    // Autohide diffs -- if it runs, we don't do anything else either.
    const didHandleAutohideDiffRun = TabMail.handleAutohideDiff(e);
    if (didHandleAutohideDiffRun) {
      TabMail.log.trace('autohideDiff', "handleKeyDown: Autohide diff");
      return;
    }
  },

  /**
   * Handles Tab key for cursor movement when a tooltip is shown.
   * @param {KeyboardEvent} e The keyboard event.
   * @returns {boolean} True if the event was handled.
   */
  handleCursorMovementKey: function (e) {
    if (TabMail.state && TabMail.state.inlineEditActive) {
      // While inline edit is active, do not hijack Tab for caret jumping.
      return false;
    }
    // Check if this is a Tab key press
    if (e.key !== "Tab" || e.shiftKey) {
      return false;
    }

    const editor = TabMail.state.editorRef;
    if (!editor) {
      return false;
    }

    // Check if there's a cursor movement indicator (caret or arrow)
    const caret = editor.querySelector('.tm-fake-caret');
    const arrow = editor.querySelector('.tm-cursor-arrow');
    if (!caret && !arrow) {
      return false;
    }

    // Get the suggested cursor position from the indicator data
    const suggestedPosition = parseInt(caret?.dataset.suggestedPosition || arrow?.dataset.suggestedPosition);
    if (isNaN(suggestedPosition)) {
      return false;
    }

    TabMail.log.debug('events', "Tab key pressed - jumping to suggested cursor position:", suggestedPosition);

    // Remove the visual indicators
    if (caret) caret.remove();
    if (arrow) arrow.remove();
    // Also remove jump overlay if it exists
    if (TabMail && TabMail.removeJumpOverlay) {
      TabMail.removeJumpOverlay();
    }

    // Move cursor to the suggested position
    TabMail.setCursorByOffset(editor, suggestedPosition);

    // Re-render the diffs now that we're at the correct position, respecting the auto-hide diff setting and the global diff setting.
    const show_diffs = TabMail.state.showDiff && !TabMail.state.autoHideDiff;
    TabMail.log.trace('renderText', "Rendering text with diffs after cursor movement");
    TabMail.renderText(show_diffs);

    e.preventDefault();
    e.stopPropagation();
    return true;
  },

  handleUndoSnapshot: function (e) {
    if (TabMail.state && TabMail.state.inlineEditActive) return false;

    // We only care about this event if diffs are active and the user is
    // performing a content insertion (typing, enter, etc.).

    // Early return if we are not doing any insertions
    const isInsert = TabMail.isInputEvent(e);

    if (!isInsert) {
      // console.log(
      //   `[TabMail Autohide Diff] ${e.type} ${
      //     e.key || e.inputType
      //   } Not an insert, returning.`
      // );
      return false;
    }

    const editor = TabMail.state.editorRef;
    // For undo handling we may capture state BEFORE DOM changes.
    let snapshotBeforeText = null;
    let snapshotBeforeCursor = null;
    let snapshotMarker = "typing";
    const isWordBoundary = TabMail.isWordBoundaryEvent(e);

    // Determine if we should capture a snapshot before DOM mutations.
    const sel = window.getSelection();
    const hasSelection = sel && !sel.isCollapsed;
    // We capture when:
    // 1) User is at a word boundary (space/newline)
    // 2) There is an active (non-collapsed) selection that will be replaced

    if ((isWordBoundary || hasSelection) && editor) {
      snapshotBeforeText =
        TabMail.extractUserAndQuoteTexts(editor).originalUserMessage;
      snapshotBeforeCursor = TabMail.getCursorOffsetIgnoringInserts(editor);
      snapshotMarker = "typing";
    }

    // If we captured a snapshot, store it on state for the input handler to finalise.
    if (snapshotBeforeText !== null && TabMail.state) {
      if (!TabMail.state.pendingUndoSnapshot) {
        TabMail.state.pendingUndoSnapshot = {
          text: snapshotBeforeText,
          cursor: snapshotBeforeCursor,
          marker: snapshotMarker,
        };
      }
    }    

    return true;
  },

  handleInputWhileSelection: function (e) {
    if (TabMail.state && TabMail.state.inlineEditActive) return true;
    // If an IME is composing, early return so that we don't break the IME. The
    // `isComposing` property on the event is the most reliable way to check
    // this within `beforeinput`.
    if (e.isComposing) {
      TabMail.log.trace('autohideDiff', "handleInputWhileSelection: IME composing"
      );
      return true;
    }

    // Early return if the user is selecting text so that the text selection
    // action behaves as intended.
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) {
      TabMail.log.trace('autohideDiff', "handleInputWhileSelection: User has a selection"
      );
      
      // Check if this is an input event (typing, backspace, delete, etc.)
      const isInputEvent = TabMail.isInputEvent(e);
      
      if (!isInputEvent) {
        return true; // Not an input event, let it pass through
      }
      
      // Check if the selection overlaps with any insert spans
      const editor = TabMail.state.editorRef;
      if (editor) {
        const insertSpans = editor.querySelectorAll('span[data-tabmail-diff="insert"]');
        let hasOverlap = false;
        
        for (const span of insertSpans) {
          if (sel.getRangeAt(0).intersectsNode(span)) {
            hasOverlap = true;
            break;
          }
        }
        
        if (hasOverlap) {
          TabMail.log.trace('autohideDiff', "handleInputWhileSelection: Selection overlaps insert span - handling manually"
          );
          
          // Handle the selection deletion and cursor positioning
          TabMail.removeSelection(sel);
          
          // For backspace and delete, we're done (just deletion)
          if (TabMail.isDeletionEvent(e)) {
            
            e.preventDefault();
            e.stopPropagation();
            
            // Manually schedule trigger since we prevented the default behavior
            const editor = TabMail.state.editorRef;
            if (editor) {
              TabMail.scheduleTrigger(editor);
            }
            
            // Also let things continue as if nothing happened.
            TabMail.log.trace('autohideDiff', "handleInputWhileSelection: Returning false to let things continue as if nothing happened.");
            return false;
          }
          
          // For other input events, let the default behavior continue
          return false;
        }
      }
      
      return true;
    }

  },

  /**
   * Handles cursor movement to highlight diff spans.
   */
  handleCursorHighlighting: function () {
    if (!TabMail.state.isDiffActive || !TabMail.state.editorRef) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || !TabMail.state.editorRef.contains(selection.anchorNode)) {
      // If there's no selection, a selection range, or cursor is outside editor, do nothing.
      // Also un-highlight any existing spans if we lose focus.
      TabMail.updateSpanHighlighting([]);
      return;
    }

    // Get original text and diffs for sentence-based span finding
    const { original: originalText, diffs: diffsToRender } = TabMail.state.lastRenderedText;
    // console.log("[TabMail DOM] Finding spans at cursor:", TabMail.state.lastRenderedText);
    const targets = TabMail.findSpansAtCursor(originalText, diffsToRender);
    TabMail.updateSpanHighlighting(targets);
  },
});
