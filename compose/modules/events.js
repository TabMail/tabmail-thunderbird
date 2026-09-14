/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
      TabMail.hideComposePreview?.();
      if (TabMail._eventListeners.layoutHandler) {
        window.removeEventListener("resize", TabMail._eventListeners.layoutHandler);
        document.removeEventListener("scroll", TabMail._eventListeners.layoutHandler, true);
      }
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
        TabMail.state.lastAcceptedText = "";
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
      if (TabMail.state?.applyingPreview || !TabMail.state || !TabMail.state.inlineEditActive) {
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
    if (TabMail.state && TabMail.state.autocompleteDisabled) {
      TabMail.log.debug('events', "scheduleTrigger: suppressed — autocomplete disabled by user.");
      return;
    }
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
    editor.contentEditable = "true";
    TabMail._eventListeners.attachedEditor = editor;
    TabMail.log.info('events', "Attaching autocomplete listeners to editor:", editor);

    // ------------------------------------------------------------------
    // Compose wrapping fix:
    // In some compose contexts, the editor (often BODY under designMode) inherits
    // `white-space: pre` (no wrapping). Quotes/signatures may wrap because they
    // have their own `white-space: pre-wrap` styles, but user content won't.
    // Only change the non-wrapping pre mode. Normal HTML must keep collapsing
    // source whitespace: forcing pre-wrap exposes formatting newlines in quoted
    // replies as large blank gaps. Plaintext pre/pre-wrap still preserves authored
    // newlines, and descendants with explicit whitespace styles remain intact.
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
        if (window.getComputedStyle(editor).whiteSpace === "pre") {
          editor.style.setProperty("white-space", "pre-wrap", "important");
        }
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
        // Preview content is outside the editable body.
        TabMail.handleAutohideDiff(e);
        TabMail.hideComposePreview();
        
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

    TabMail._eventListeners.layoutHandler = event => {
      if (event.target instanceof Node && TabMail.state.previewView?.host.contains(event.target)) return;
      TabMail.renderText(TabMail.state.showDiff && !TabMail.state.autoHideDiff);
    };
    window.addEventListener("resize", TabMail._eventListeners.layoutHandler);
    document.addEventListener("scroll", TabMail._eventListeners.layoutHandler, true);

    // Input (typing)
    TabMail._eventListeners.inputHandler = (e) => {
      // DEBUG: detect if this input event came from a programmatic render
      const _dbgEditable = editor.contentEditable;
      const _dbgMuteDepth = TabMail.state.selectionMuteDepth || 0;
      TabMail.log.debug('events', "inputHandler fired", {
        inputType: e.inputType,
        data: e.data,
        editorContentEditable: _dbgEditable,
        selectionMuteDepth: _dbgMuteDepth,
        isDiffActive: TabMail.state.isDiffActive,
        autoHideDiff: TabMail.state.autoHideDiff,
      });
      // Defer the trigger if an IME composition is in progress.
      // The `compositionend` event will schedule the trigger instead.
      if (TabMail.state.isIMEComposing) {
        TabMail.log.debug('events', "Input during IME composition; trigger deferred (compositionend will handle it)."
        );
        return;
      }
      
      if (TabMail.state.applyingPreview) return;
      if (TabMail.state.lastKeystrokeAdheredToSuggestion) {
        TabMail.state.lastKeystrokeAdheredToSuggestion = false;
        TabMail.state.adherenceInfo = null;
        // Native editing has already consumed the matching character. Rebuild
        // the passive preview without scheduling another request, as before.
        TabMail.renderText(TabMail.state.showDiff && !TabMail.state.autoHideDiff);
      } else {
        TabMail.state.correctedText = null;
        if (!TabMail.retainDockedComposePreview()) TabMail.hideComposePreview();
        TabMail.scheduleTrigger(editor);
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
      if (TabMail.state.selectionMuteDepth > 0 || TabMail.state.applyingPreview) return;
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
        if (!isCollapsed) TabMail.hideComposePreview();

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

    // Ask the background script if we should trigger an initial correction.
    TabMail.log.info('events', "Asking background script to check for initial trigger."
    );
    browser.runtime.sendMessage({ type: "initialTriggerCheck" });
  },

  handleUndoRedoKey: function () {
    // Native HTML editor owns history, including typing and accepted previews.
    return false;
  },

  handleEscapeKeys: function (e) {
    // --- Shift+Esc: TOGGLE autocomplete on/off (persisted) ---
    if (TabMail._isKeyMatch(e, TabMail.config.keys.disableAutocomplete)) {
      e.preventDefault();
      e.stopPropagation();

      TabMail.setAutocompleteEnabled(TabMail.state.autocompleteDisabled);

      return true;
    }

    // --- Key handling for plain Esc to hide suggestions ---
    if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Only handle if we have visible suggestions
      if (TabMail.state.previewView?.pending || (TabMail.state.correctedText && TabMail.state.showDiff && !TabMail.state.autoHideDiff)) {
        e.preventDefault();
        e.stopPropagation();
        
        TabMail.log.info('events', 'ESC pressed - hiding suggestions until next typing');
        
        // Clear suggestion state
        TabMail.dismissComposeSuggestion();
        
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

  /**
   * Turns autocomplete OFF in THIS compose window without persisting: cancels
   * any pending idle trigger, drops the visible/pending suggestion, re-renders
   * the user's own text, and refreshes the hints banner to its "off" state
   * (which advertises Shift+Esc to turn it back on). Persisting
   * (`autocompleteEnabled` storage) is the caller's responsibility, so this is
   * safe to call from the storage.onChanged mirror path too.
   */
  setAutocompleteEnabled(enabled) {
    if (enabled) TabMail.enableAutocompleteLocally();
    else TabMail.disableAutocompleteLocally();
    Promise.resolve(browser.storage.local.set({ autocompleteEnabled: enabled })).catch(error => {
      TabMail.log.warn('events', 'Could not save the suggestions preference');
    });
  },

  disableAutocompleteLocally: function () {
    TabMail.state.autocompleteDisabled = true;

    // Cancel any scheduled idle trigger.
    if (TabMail.state.autocompleteIdleTimer) {
      clearTimeout(TabMail.state.autocompleteIdleTimer);
      TabMail.state.autocompleteIdleTimer = null;
    }
    // Cancel a pending re-enable re-fetch (e.g. rapidly toggled off again).
    if (TabMail.state.reenableFetchTimer) {
      clearTimeout(TabMail.state.reenableFetchTimer);
      TabMail.state.reenableFetchTimer = null;
    }

    // Drop any visible/pending suggestion and re-render the user's own text.
    TabMail.dismissComposeSuggestion();
    TabMail.state.lastSuggestionShownTime = 0;
    TabMail.state.textLengthAtLastSuggestion = 0;
    try {
      TabMail.renderText(false);
    } catch (err) {
      TabMail.log.warn('events', `disableAutocompleteLocally: renderText failed: ${err}`);
    }

    // Keep the banner visible but switch it to the "off" hint so the user can
    // discover Shift+Esc to turn autocomplete back on.
    if (TabMail.showComposeHintsBanner) {
      TabMail.showComposeHintsBanner();
    }
  },

  /**
   * Turns autocomplete back ON in THIS compose window (counterpart to
   * disableAutocompleteLocally). Refreshes the hints banner to its "on" state
   * and immediately re-fetches a suggestion for the current text instead of
   * waiting for the next keystroke. Does not persist.
   */
  enableAutocompleteLocally: function () {
    TabMail.state.autocompleteDisabled = false;
    if (TabMail.showComposeHintsBanner) {
      TabMail.showComposeHintsBanner();
    }

    // Kick off a fresh suggestion for whatever is already in the editor. The
    // user may not have typed since the last suggestion, so the normal
    // "text unchanged / already sent" dedup in triggerCorrection would
    // short-circuit the call — clear those markers first to force a re-fetch
    // (mirrors the triggerInitialCorrection reset pattern).
    const editor = TabMail.state.editorRef;
    if (editor) {
      TabMail.state.originalText = null;
      TabMail.state.lastSentLocalText = null;
      TabMail.state.lastSentGlobalText = null;
      // Reuse a single timer so the direct (Shift+Esc) call and the
      // storage.onChanged mirror — which both fire in this same window — don't
      // schedule the re-fetch twice.
      if (TabMail.state.reenableFetchTimer) {
        clearTimeout(TabMail.state.reenableFetchTimer);
      }
      TabMail.state.reenableFetchTimer = setTimeout(() => {
        TabMail.state.reenableFetchTimer = null;
        // Bail if it was toggled back off during the brief delay.
        if (!TabMail.state.autocompleteDisabled) {
          TabMail.triggerCorrection(editor);
        }
      }, TabMail.config.INITIAL_CORRECTION_DELAY_MS);
    }
  },

  handleAcceptRejectKey: function (e) {
    if (!TabMail._isKeyMatch(e, TabMail.config.keys.localAccept) || !TabMail.state.previewModel) return false;
    e.preventDefault();
    e.stopPropagation();
    TabMail.acceptComposePreview();
    return true;
  },

  /**
   * Handles keydown events in the editor, specifically for accepting (Tab)
   * or rejecting (Shift+Tab) the diff suggestion.
   * @param {KeyboardEvent} e The keyboard event.
   */
  handleKeyDown: function (e) {
    if (TabMail.state.isIMEComposing || e.isComposing) return;
    if (TabMail._handleInlineEditKeyDown(e)) return;
    const selection = window.getSelection();
    if (!selection?.anchorNode || !TabMail.state.editorRef?.contains(selection.anchorNode)) return;
    if (TabMail._handleInlineEditShortcut(e)) return;
    if (TabMail.handleEscapeKeys(e)) return;
    if (selection.isCollapsed && TabMail.handleCursorMovementKey(e)) return;
    if (selection.isCollapsed && TabMail.handleAcceptRejectKey(e)) return;
    if (selection.isCollapsed && (TabMail._isTypingKey(e) || e.key === "Enter")) {
      // Range replacements must take the ordinary input invalidation path.
      // Supply the existing adherence detector with native text coordinates;
      // its timing policy remains independent of the preview renderer.
      const original = TabMail.extractUserAndQuoteTexts(TabMail.state.editorRef).originalUserMessage;
      TabMail.state.lastRenderedText = { diffs: TabMail.computeDiff(original, TabMail.state.correctedText || original) };
      TabMail.handleAutohideDiff(e);
    }
    // All other editing, selection and history keys belong to Thunderbird.
  },

  /**
   * Handles Tab key for cursor movement when a tooltip is shown.
   * @param {KeyboardEvent} e The keyboard event.
   * @returns {boolean} True if the event was handled.
   */
  handleCursorMovementKey: function (e) {
    if (!TabMail._isKeyMatch(e, TabMail.config.keys.localAccept) || TabMail.state.previewJumpOffset == null) return false;
    e.preventDefault();
    e.stopPropagation();
    TabMail.setCursorByOffset(TabMail.state.editorRef, TabMail.state.previewJumpOffset);
    TabMail.renderText(true);
    return true;
  },

});
