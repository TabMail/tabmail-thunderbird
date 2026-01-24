var TabMail = TabMail || {};

/**
 * Autohide Diff Module
 * 
 * Handles the logic for automatically hiding/showing diff suggestions
 * when the user types, and detecting when the user's input "adheres"
 * to the current suggestion (e.g., typing exactly what's suggested).
 */
Object.assign(TabMail, {
  /**
   * Checks if the current keystroke adheres to the rendered suggestion.
   * Uses the already-computed diffs from lastRenderedText to avoid recomputation.
   * If adhering, stores info in state.adherenceInfo for later diff manipulation.
   * 
   * Adherence means:
   * - For typing: the character matches the start of an INSERT at/near cursor position
   * - For deletion: the character being deleted is within a DELETE span
   * 
   * @param {KeyboardEvent} e - The keyboard event
   * @returns {boolean} True if the keystroke adheres to the suggestion
   */
  _isKeystrokeAdheringToSuggestion: function(e) {
    // Clear any previous adherence info
    TabMail.state.adherenceInfo = null;
    
    // Need correctedText and rendered diffs
    if (!TabMail.state.correctedText) {
      return false;
    }
    
    const lastRendered = TabMail.state.lastRenderedText;
    if (!lastRendered || !lastRendered.diffs || lastRendered.diffs.length === 0) {
      return false;
    }
    
    // If diffs are already hidden, don't check adherence
    if (TabMail.state.autoHideDiff) {
      return false;
    }
    
    const editor = TabMail.state.editorRef;
    if (!editor) {
      return false;
    }
    
    const diffs = lastRendered.diffs;
    const cursorPos = TabMail.getCursorOffsetIgnoringInserts(editor);
    const key = e.key;
    
    // For typing a single character (no modifiers except shift)
    if (key && key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const result = TabMail._findTypingAdherenceInfo(diffs, cursorPos, key);
      if (result) {
        TabMail.state.adherenceInfo = result;
        return true;
      }
      return false;
    }
    
    // For Enter key - check if INSERT starts with newline
    // e.key is "Enter" but diffs contain "\n"
    if (key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // First try normal adherence (cursor exactly at INSERT position)
      const result = TabMail._findTypingAdherenceInfo(diffs, cursorPos, '\n');
      if (result) {
        TabMail.state.adherenceInfo = result;
        return true;
      }
      
      // Special case: cursor is right BEFORE a newline at end of EQUAL,
      // and the following INSERT starts with "\n".
      // Example: EQUAL "Hello\n", INSERT "\nWorld", cursor at position 5 (before the \n in EQUAL)
      // When user presses Enter, we should consume the INSERT's newline.
      const specialResult = TabMail._findEnterBeforeNewlineAdherence(diffs, cursorPos);
      if (specialResult) {
        TabMail.state.adherenceInfo = specialResult;
        return true;
      }
      
      return false;
    }
    
    // For Backspace - check if deleting a character that's in a DELETE span
    if (key === 'Backspace' && cursorPos > 0) {
      const result = TabMail._findDeletionAdherenceInfo(diffs, cursorPos - 1);
      if (result) {
        TabMail.state.adherenceInfo = result;
        return true;
      }
      return false;
    }
    
    // For Delete key - check character at cursor position
    if (key === 'Delete') {
      const result = TabMail._findDeletionAdherenceInfo(diffs, cursorPos);
      if (result) {
        TabMail.state.adherenceInfo = result;
        return true;
      }
      return false;
    }
    
    return false;
  },

  /**
   * Finds adherence info for typing a character. Returns info object if adhering, null otherwise.
   * 
   * @param {Array} diffs - The computed diffs from lastRenderedText
   * @param {number} cursorPos - Cursor position in original text coordinates
   * @param {string} typedChar - The character being typed
   * @returns {Object|null} Adherence info or null
   */
  _findTypingAdherenceInfo: function(diffs, cursorPos, typedChar) {
    let origPos = 0;
    
    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      const op = diff[0];
      const text = diff[1] || '';
      
      if (op === 1) { // INSERT
        // If cursor is exactly at origPos (right before this insert) and char matches
        if (cursorPos === origPos && text.length > 0 && text[0] === typedChar) {
          TabMail.log.debug('autohideDiff', `Typing '${typedChar}' adheres to INSERT at position ${origPos}`);
          return { type: 'insert', diffIndex: i, charIndex: 0, char: typedChar };
        }
        // INSERT doesn't advance origPos (doesn't exist in original text)
        continue;
      }
      
      const segmentEnd = origPos + text.length;
      
      if (op === 0) { // EQUAL
        // If cursor is at the end of this equal section, look for INSERT after
        if (cursorPos === segmentEnd) {
          // Look ahead for INSERT (possibly after DELETE)
          for (let j = i + 1; j < diffs.length; j++) {
            const nextOp = diffs[j][0];
            const nextText = diffs[j][1] || '';
            if (nextOp === 1 && nextText.length > 0 && nextText[0] === typedChar) {
              TabMail.log.debug('autohideDiff', `Typing '${typedChar}' adheres to INSERT after EQUAL`);
              return { type: 'insert', diffIndex: j, charIndex: 0, char: typedChar };
            }
            if (nextOp === -1) continue; // Skip DELETE, keep looking for INSERT
            break; // Stop at another EQUAL
          }
        }
        origPos = segmentEnd;
      } else if (op === -1) { // DELETE
        // For replace operations: only check at the END of DELETE (right before INSERT)
        // If cursor is in the middle of DELETE, typing would go into the DELETE span
        // which would cause issues, so we only allow adherence at the boundary.
        if (cursorPos === segmentEnd) {
          // Look for INSERT after this DELETE (replace operation)
          for (let j = i + 1; j < diffs.length; j++) {
            const nextOp = diffs[j][0];
            const nextText = diffs[j][1] || '';
            if (nextOp === 1 && nextText.length > 0 && nextText[0] === typedChar) {
              TabMail.log.debug('autohideDiff', `Typing '${typedChar}' adheres to INSERT in replace operation`);
              return { type: 'insert', diffIndex: j, charIndex: 0, char: typedChar };
            }
            if (nextOp === 0) break; // Stop at EQUAL
          }
        }
        origPos = segmentEnd;
      }
    }
    
    // Check if cursor is at end and there's a trailing INSERT
    if (cursorPos === origPos) {
      for (let i = diffs.length - 1; i >= 0; i--) {
        const op = diffs[i][0];
        const text = diffs[i][1] || '';
        if (op === 1 && text.length > 0 && text[0] === typedChar) {
          TabMail.log.debug('autohideDiff', `Typing '${typedChar}' adheres to trailing INSERT`);
          return { type: 'insert', diffIndex: i, charIndex: 0, char: typedChar };
        }
        if (op !== 1) break; // Stop at first non-INSERT
      }
    }
    
    return null;
  },

  /**
   * Special case for Enter: cursor is right before a newline at end of EQUAL,
   * and the following INSERT starts with "\n".
   * 
   * Example:
   * - Original: "Hello\n" (cursor at position 5, before the \n)
   * - Corrected: "Hello\n\nWorld"
   * - Diffs: [EQUAL "Hello\n"][INSERT "\nWorld"]
   * - Normal adherence fails because cursor (5) !== INSERT position (6)
   * - But we want to consume INSERT's \n when user presses Enter
   * 
   * @param {Array} diffs - The computed diffs
   * @param {number} cursorPos - Cursor position in original text coordinates
   * @returns {Object|null} Adherence info or null
   */
  _findEnterBeforeNewlineAdherence: function(diffs, cursorPos) {
    let origPos = 0;
    
    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      const op = diff[0];
      const text = diff[1] || '';
      
      if (op === 1) { // INSERT - doesn't advance origPos
        continue;
      }
      
      const segmentEnd = origPos + text.length;
      
      if (op === 0) { // EQUAL
        // Check if cursor is right before a newline at the end of this EQUAL
        // i.e., cursor at segmentEnd - 1 and the last char is \n
        if (cursorPos === segmentEnd - 1 && text.length > 0 && text[text.length - 1] === '\n') {
          // Check if the next diff is INSERT starting with \n
          const nextDiff = diffs[i + 1];
          if (nextDiff && nextDiff[0] === 1) {
            const nextText = nextDiff[1] || '';
            if (nextText.length > 0 && nextText[0] === '\n') {
              TabMail.log.debug('autohideDiff', 
                `Enter before newline special case: cursor at ${cursorPos}, ` +
                `EQUAL ends with \\n at ${segmentEnd}, INSERT starts with \\n`
              );
              // advanceCursorBy: 1 tells the renderer to move cursor forward by 1 extra char
              // so it ends up after the consumed newline (on the correct line)
              return { type: 'insert', diffIndex: i + 1, charIndex: 0, char: '\n', advanceCursorBy: 1 };
            }
          }
        }
        origPos = segmentEnd;
      } else if (op === -1) { // DELETE
        origPos = segmentEnd;
      }
    }
    
    return null;
  },

  /**
   * Finds adherence info for deleting a character. Returns info object if adhering, null otherwise.
   * 
   * @param {Array} diffs - The computed diffs from lastRenderedText
   * @param {number} targetPos - Position of character to delete (in original text)
   * @returns {Object|null} Adherence info or null
   */
  _findDeletionAdherenceInfo: function(diffs, targetPos) {
    let origPos = 0;
    
    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      const op = diff[0];
      const text = diff[1] || '';
      
      if (op === 1) continue; // INSERT doesn't affect origPos
      
      const segmentEnd = origPos + text.length;
      
      if (op === -1) { // DELETE
        if (targetPos >= origPos && targetPos < segmentEnd) {
          const charIndex = targetPos - origPos;
          TabMail.log.debug('autohideDiff', `Deletion at position ${targetPos} adheres to DELETE span (index ${i}, char ${charIndex})`);
          return { type: 'delete', diffIndex: i, charIndex: charIndex, char: text[charIndex] };
        }
      }
      
      origPos = segmentEnd;
    }
    
    return null;
  },

  /**
   * Applies adherence info to directly modify the diffs in place.
   * This avoids recomputing diffs and prevents "scattering".
   * 
   * For INSERT adherence: removes char from INSERT, adds to preceding EQUAL
   * For DELETE adherence: removes char from DELETE
   * 
   * @param {Object} info - The adherence info from state.adherenceInfo
   */
  _applyAdherenceToDiffs: function(info) {
    if (!info) return;
    
    const lastRendered = TabMail.state.lastRenderedText;
    if (!lastRendered || !lastRendered.diffs) return;
    
    const diffs = lastRendered.diffs;
    const diff = diffs[info.diffIndex];
    if (!diff) return;
    
    const text = diff[1] || '';
    
    if (info.type === 'insert') {
      // For INSERT: the typed character becomes part of EQUAL (common text)
      // 1. Remove the first character from the INSERT span
      // 2. Add that character to the preceding EQUAL (or create one)
      
      const typedChar = info.char;
      const newInsertText = text.slice(1);
      
      // Find preceding diff that's EQUAL (skip any DELETE in between for replace ops)
      let prevEqualIndex = -1;
      for (let i = info.diffIndex - 1; i >= 0; i--) {
        if (diffs[i][0] === 0) { // EQUAL
          prevEqualIndex = i;
          break;
        } else if (diffs[i][0] === -1) { // DELETE - keep looking
          continue;
        } else {
          break; // Another INSERT - stop
        }
      }
      
      if (prevEqualIndex >= 0) {
        // Extend the existing EQUAL with the typed character
        diffs[prevEqualIndex][1] = (diffs[prevEqualIndex][1] || '') + typedChar;
        TabMail.log.debug('autohideDiff', `Extended EQUAL at index ${prevEqualIndex} with '${typedChar}'`);
      } else {
        // No preceding EQUAL found - create a new EQUAL before the INSERT
        // Find where to insert (before any DELETE that precedes the INSERT)
        let insertPos = info.diffIndex;
        for (let i = info.diffIndex - 1; i >= 0; i--) {
          if (diffs[i][0] === -1) { // DELETE
            insertPos = i;
          } else {
            break;
          }
        }
        // Create new EQUAL entry: [op, text, origSentIdx, newSentIdx]
        const sentOrig = diff[2];
        const sentNew = diff[3];
        diffs.splice(insertPos, 0, [0, typedChar, sentOrig, sentNew]);
        // Adjust diffIndex since we inserted before it
        info.diffIndex++;
        TabMail.log.debug('autohideDiff', `Created new EQUAL '${typedChar}' at index ${insertPos}`);
      }
      
      // Now update or remove the INSERT
      // Need to re-fetch since index may have shifted
      const insertDiff = diffs[info.diffIndex];
      if (newInsertText.length === 0) {
        diffs.splice(info.diffIndex, 1);
        TabMail.log.debug('autohideDiff', `Removed empty INSERT diff at index ${info.diffIndex}`);
      } else {
        insertDiff[1] = newInsertText;
        TabMail.log.debug('autohideDiff', `Updated INSERT diff: removed '${typedChar}', remaining: '${newInsertText.slice(0, 20)}...'`);
      }
      
    } else if (info.type === 'delete') {
      // For DELETE: the deleted character is removed from original text
      // Just remove it from the DELETE span - no EQUAL manipulation needed
      // (the character no longer exists in original, so it's not common)
      
      const newDeleteText = text.slice(0, info.charIndex) + text.slice(info.charIndex + 1);
      
      if (newDeleteText.length === 0) {
        // Remove the entire diff entry if empty
        diffs.splice(info.diffIndex, 1);
        TabMail.log.debug('autohideDiff', `Removed empty DELETE diff at index ${info.diffIndex}`);
      } else {
        diff[1] = newDeleteText;
        TabMail.log.debug('autohideDiff', `Updated DELETE diff: removed '${info.char}' at position ${info.charIndex}`);
      }
    }
  },

  /**
   * Renders the editor using the existing diffs without recomputation.
   * This is used after adherence to prevent diff scattering.
   * 
   * @param {number} advanceCursorBy - Optional: advance cursor by this many chars (for special cases)
   */
  _renderWithExistingDiffs: function(advanceCursorBy = 0) {
    const editor = TabMail.state.editorRef;
    if (!editor) return;
    
    const lastRendered = TabMail.state.lastRenderedText;
    if (!lastRendered || !lastRendered.diffs) return;
    
    // Update the original text to match current editor content
    const { originalUserMessage, quoteBoundaryNode } = TabMail.extractUserAndQuoteTexts(editor);
    
    // Update state
    TabMail.state.originalText = originalUserMessage;
    lastRendered.original = originalUserMessage;
    
    // Get cursor position before rendering
    const cursorOffset = TabMail.getCursorOffsetIgnoringInserts(editor);
    lastRendered.originalCursorOffset = cursorOffset;
    
    const diffs = lastRendered.diffs;
    const show_diffs = TabMail.state.showDiff && !TabMail.state.autoHideDiff;
    const show_newlines = lastRendered.show_newlines !== false;
    
    // Begin programmatic selection block
    TabMail._beginProgrammaticSelection();
    editor.contentEditable = "false";
    
    try {
      // Create range for replacement
      const rangeToReplace = document.createRange();
      rangeToReplace.selectNodeContents(editor);
      if (quoteBoundaryNode) {
        rangeToReplace.setEndBefore(quoteBoundaryNode);
      }
      
      // Build fragment from existing diffs using shared rendering function
      const fragment = TabMail._renderDiffsToFragment(diffs, show_diffs, show_newlines);
      
      // Apply the fragment to the editor and handle cursor/highlighting
      TabMail._applyFragmentToEditor(
        fragment,
        rangeToReplace,
        editor,
        quoteBoundaryNode,
        diffs,
        cursorOffset,
        show_diffs,
        advanceCursorBy
      );
      
      TabMail.state.isDiffActive = show_diffs;
      lastRendered.show_diffs = show_diffs;
      
    } finally {
      editor.contentEditable = "true";
      TabMail._endProgrammaticSelection();
    }
  },

  /**
   * Handles the autohide diff logic when the user types.
   * If the keystroke adheres to the current suggestion, keeps diffs visible.
   * Otherwise, hides diffs and invalidates the suggestion.
   * 
   * @param {KeyboardEvent} e - The keyboard event
   * @returns {boolean} True if this handler processed the event
   */
  handleAutohideDiff: function (e) {
    // When the user types anything that creates an insert, we hide the diffs.

    // Minimal IME fix: if IME composition is starting while the user has an
    // active selection, do NOT force a render. Re-rendering the editor DOM at
    // compositionstart can break the native "replace selection then compose"
    // behavior in Thunderbird/Gecko.
    try {
      if (e && e.type === "compositionstart") {
        const sel = window.getSelection();
        const hasSelection = !!(sel && sel.rangeCount && !sel.isCollapsed);
        if (hasSelection) {
          TabMail.log.debug('autohideDiff',
            "handleAutohideDiff: compositionstart with active selection; skipping forced render to preserve native IME replace-selection behavior.",
            { isComposing: !!e.isComposing }
          );
          return false;
        }
      }
    } catch (err) {
      TabMail.log.warn('autohideDiff',
        "handleAutohideDiff: failed to evaluate selection during compositionstart; proceeding with default behavior.",
        err
      );
    }

    const isInsert = TabMail.isInputEvent(e);

    // If it is not an insert we simply return and do nothing.
    if (!isInsert) {
      // console.log(
      //   `[TabMail] ${e.type} ${
      //     e.key || e.inputType
      //   } Not an insert, returning.`
      // );
      return false;
    }

    TabMail.log.trace('autohideDiff', "handleAutohideDiff: Insert detected, checking adherence.");

    // Check if the keystroke adheres to the current suggestion
    // If adhering, don't hide diffs and don't invalidate suggestion
    if (TabMail._isKeystrokeAdheringToSuggestion(e)) {
      TabMail.log.info('autohideDiff', "Keystroke adheres to suggestion - keeping diffs visible");
      // Store flag so input handler knows to skip scheduleTrigger
      TabMail.state.lastKeystrokeAdheredToSuggestion = true;
      // Don't hide diffs, don't invalidate suggestion, don't schedule restore timer
      return true;
    }
    
    // Not adhering - clear the flag
    TabMail.state.lastKeystrokeAdheredToSuggestion = false;

    // If it is an insert we hide the diffs.
    if (!TabMail.state.autoHideDiff) {
      TabMail.log.trace('autohideDiff', "Auto-hiding diffs due to user typing."
      );
    }
    TabMail.state.autoHideDiff = true;
    // Properly invalidate previous suggestions to prevent past text lingering
    TabMail.state.correctedText = null;
    
    // Render without diffs - use force flag for compositionstart events
    const force = e.type === "compositionstart";
    TabMail.log.trace('renderText', "Rendering text without diffs after compositionstart");
    const show_diffs = TabMail.state.showDiff && !TabMail.state.autoHideDiff;
    TabMail.renderText(show_diffs, (show_newlines = true), force);

    // Clear any pending restore timer and schedule a fresh one.
    if (TabMail.state.diffRestoreTimer) {
      clearTimeout(TabMail.state.diffRestoreTimer);
    }

    TabMail.state.diffRestoreTimer = setTimeout(() => {
      TabMail.state.autoHideDiff = false;
      // Render the diffs if we are supposed to show them now
      if (TabMail.state.showDiff) {
        // Note that autoHideDiff is already false at this point.
        TabMail.log.trace('renderText', "Rendering text with diffs after compositionend");
        const show_diffs = TabMail.state.showDiff && !TabMail.state.autoHideDiff;
        TabMail.renderText(show_diffs);
      }
      TabMail.state.diffRestoreTimer = null;
    }, TabMail.config.DIFF_RESTORE_DELAY_MS);

    return true;
  },
});
