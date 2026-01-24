var TabMail = TabMail || {};

Object.assign(TabMail, {
  /**
   * Bumps a request id safely within JS Number safe integer bounds.
   * Wraps to 1 if the counter ever reaches Number.MAX_SAFE_INTEGER.
   */
  _nextRequestId: function(current) {
    try {
      if (typeof current !== "number" || !Number.isFinite(current) || current < 0) {
        return 1;
      }
      if (current >= Number.MAX_SAFE_INTEGER) {
        return 1;
      }
      return current + 1;
    } catch (_) {
      return 1;
    }
  },

  /**
   * Invalidates any in-flight GLOBAL request so its response is ignored.
   * This is used when a LOCAL trigger happens while GLOBAL is in progress.
   */
  invalidateGlobalRequest: function(reason = "unknown") {
    try {
      const prev = TabMail.state.latestGlobalRequestId;
      TabMail.state.latestGlobalRequestId = TabMail._nextRequestId(TabMail.state.latestGlobalRequestId);
      // Clear dedupe key so a fresh GLOBAL follow-up can be re-sent even if the
      // assumed-accepted text hasn't changed but the previous GLOBAL was invalidated.
      TabMail.state.lastSentGlobalText = null;
      // Mark global as not blocking new work even if the underlying promise resolves later.
      TabMail.state.isGlobalRequestInFlight = false;
      TabMail.state.hasPendingGlobalTrigger = false;
      if (TabMail.state.globalFollowup) {
        TabMail.state.globalFollowup.displayOriginalText = null;
        TabMail.state.globalFollowup.assumedAcceptedText = null;
        TabMail.state.globalFollowup.fromLocalRequestId = null;
      }
      TabMail.log.info('core', `🧹 Invalidated GLOBAL request (prev latestGlobalRequestId=${prev}) due to: ${reason}`);
    } catch (e) {
      TabMail.log.warn('core', `Failed to invalidate GLOBAL request: ${e}`);
    }
  },

  /**
   * Starts a GLOBAL follow-up request immediately after a LOCAL completion.
   * The server receives the assumed-accepted text (LOCAL suggestion), but UI
   * rendering continues to compare suggestions against the editor's original text.
   */
  triggerGlobalFollowupAfterLocal: function(
    editor,
    displayOriginalUserMessage,
    quoteAndSignatureText,
    assumedAcceptedText,
    fromLocalRequestId
  ) {
    try {
      if (!assumedAcceptedText || !assumedAcceptedText.trim()) {
        TabMail.log.debug('core', "GLOBAL follow-up skipped (empty assumedAcceptedText)");
        return;
      }

      // If any GLOBAL is currently in flight, invalidate it and replace with this newer one.
      if (TabMail.state.isGlobalRequestInFlight) {
        TabMail.invalidateGlobalRequest("new LOCAL completion");
      }

      // Prevent duplicate GLOBAL sends for identical assumed-accepted text.
      if (TabMail.state.lastSentGlobalText === assumedAcceptedText) {
        TabMail.log.debug('core', `⚠️ Skipping GLOBAL follow-up - assumedAcceptedText already sent (length: ${assumedAcceptedText.length}).`);
        return;
      }

      TabMail.state.latestGlobalRequestId = TabMail._nextRequestId(TabMail.state.latestGlobalRequestId);
      const globalRequestId = TabMail.state.latestGlobalRequestId;

      TabMail.state.lastSentGlobalText = assumedAcceptedText;

      if (TabMail.state.globalFollowup) {
        TabMail.state.globalFollowup.displayOriginalText = displayOriginalUserMessage;
        TabMail.state.globalFollowup.assumedAcceptedText = assumedAcceptedText;
        TabMail.state.globalFollowup.fromLocalRequestId = fromLocalRequestId;
      }

      TabMail.log.info('core',
        `🌐 Starting GLOBAL follow-up request #${globalRequestId} from LOCAL #${fromLocalRequestId} ` +
        `(assumedAccepted len=${assumedAcceptedText.length}, displayOriginal len=${displayOriginalUserMessage.length})`
      );

      TabMail.triggerCorrectionBackend(
        editor,
        displayOriginalUserMessage,
        quoteAndSignatureText,
        globalRequestId,
        false, // isLocal=false (GLOBAL)
        assumedAcceptedText,
        { isFollowup: true, fromLocalRequestId }
      );
    } catch (e) {
      TabMail.log.warn('core', `Failed to start GLOBAL follow-up after LOCAL: ${e}`);
    }
  },

  /**
   * Triggers the backend correction process.
   * @param {HTMLElement} editor The editor element.
   * @param {boolean} forceGlobal If true, forces global (full email) mode instead of local (chunked).
   */
  triggerCorrection: function (editor, forceGlobal = false) {
    if (TabMail.state && TabMail.state.inlineEditActive) {
      TabMail.log.debug('core', "triggerCorrection suppressed (inlineEditActive)");
      return;
    }
    TabMail.state.lastActionWasAccept = false;

    const isLocal = !forceGlobal;

    // If LOCAL is triggered while a GLOBAL request is in flight, invalidate GLOBAL immediately.
    // This keeps typing responsive and ensures GLOBAL doesn't overwrite newer LOCAL intent.
    if (isLocal && TabMail.state.isGlobalRequestInFlight) {
      TabMail.log.info('core', "🧹 LOCAL trigger detected while GLOBAL is in-flight; invalidating GLOBAL");
      TabMail.invalidateGlobalRequest("LOCAL trigger while GLOBAL in-flight");
    }

    const { originalUserMessage, quoteAndSignatureText } =
      TabMail.extractUserAndQuoteTexts(editor);

    // Per-mode concurrency: LOCAL should not be blocked by an in-flight GLOBAL (we invalidate above),
    // but should be blocked by another LOCAL in-flight. Same for GLOBAL.
    if (isLocal) {
      if (TabMail.state.isLocalRequestInFlight) {
        TabMail.log.trace('core', "Skipping LOCAL backend call because LOCAL request is in flight. Marking LOCAL as pending.");
        TabMail.state.hasPendingLocalTrigger = true;
        return;
      }
    } else {
      if (TabMail.state.isGlobalRequestInFlight) {
        TabMail.log.trace('core', "Skipping GLOBAL backend call because GLOBAL request is in flight. Marking GLOBAL as pending.");
        TabMail.state.hasPendingGlobalTrigger = true;
        return;
      }
    }

    // Determine if the editor content has actually changed.  If it has not,
    // there is no need to contact the backend again – the cache already
    // holds the correct completion.  This prevents the double-call pattern
    // we observe when both the `input` and `selectionchange` events fire
    // in quick succession for a single keystroke.

    const isOriginalTextUpdated =
      TabMail.state.originalText !== originalUserMessage;

    // If nothing in the user-editable area has changed, bail out early.
    // We still allow a render below if needed, but we skip scheduling a
    // backend call entirely.
    if (!isOriginalTextUpdated) {
      TabMail.log.trace('core', "Skipping backend call because original text has not changed."
      );
      
      // If forceGlobal, trigger global correction even if text unchanged
      if (!isLocal) {
        TabMail.log.info('core', "📊 Triggering GLOBAL correction (forced)");
        TabMail.state.latestGlobalRequestId = TabMail._nextRequestId(TabMail.state.latestGlobalRequestId);
        TabMail.state.lastSentGlobalText = originalUserMessage;
        TabMail.triggerCorrectionBackend(
          editor,
          originalUserMessage,
          quoteAndSignatureText,
          TabMail.state.latestGlobalRequestId,
          false, // isLocal = false for global mode
          null
        );
      }
      return;
    }

    // Check if we've already sent this exact text to the backend.
    // This prevents duplicate sends when the throttle expires or multiple events
    // trigger with the same final text.
    if (isLocal) {
      if (TabMail.state.lastSentLocalText === originalUserMessage) {
        TabMail.log.debug('core', `⚠️ Skipping LOCAL backend call - this exact text was already sent (length: ${originalUserMessage.length}).`);
        // Still update originalText to reflect current state, but don't send
        TabMail.state.originalText = originalUserMessage;
        return;
      }
    } else {
      if (TabMail.state.lastSentGlobalText === originalUserMessage) {
        TabMail.log.debug('core', `⚠️ Skipping GLOBAL backend call - this exact text was already sent (length: ${originalUserMessage.length}).`);
        TabMail.state.originalText = originalUserMessage;
        return;
      }
    }

    // The text has changed – remember the latest copy.
    TabMail.state.originalText = originalUserMessage;
    
    // Clear any pending trigger flag since we're about to make a new request
    if (isLocal) {
      TabMail.state.hasPendingLocalTrigger = false;
    } else {
      TabMail.state.hasPendingGlobalTrigger = false;
    }

    // Call the backend immediately; debouncing is now handled at the
    // scheduleTrigger level. Note also that this backend call renders text as
    // necessary so we don't need to do it after.
    if (isLocal) {
      TabMail.state.latestLocalRequestId = TabMail._nextRequestId(TabMail.state.latestLocalRequestId);
      TabMail.state.lastSentLocalText = originalUserMessage;
    } else {
      TabMail.state.latestGlobalRequestId = TabMail._nextRequestId(TabMail.state.latestGlobalRequestId);
      TabMail.state.lastSentGlobalText = originalUserMessage;
    }

    const requestId = isLocal ? TabMail.state.latestLocalRequestId : TabMail.state.latestGlobalRequestId;
    TabMail.log.debug('core',
      `🚀 Starting backend request #${requestId} [${isLocal ? 'LOCAL' : 'GLOBAL'}] for text: "${originalUserMessage.substring(0, 50)}..." ` +
      `(length: ${originalUserMessage.length})`
    );
    TabMail.triggerCorrectionBackend(
      editor,
      originalUserMessage,
      quoteAndSignatureText,
      requestId,
      isLocal,
      null
    );
  },
  
  /**
   * Asynchronously triggers and processes backend correction.
   * @param {HTMLElement} editor The editor element.
   * @param {string} originalUserMessage The original, clean text of the user's message at the time the correction was initiated.
   * @param {string} quoteAndSignatureText The text of the quoted message and signature.
   * @param {number} requestId The request ID for stale response detection.
   * @param {boolean} isLocal If true, uses local (chunked) mode; if false, uses global (full email) mode. Defaults to false (global).
   */
  triggerCorrectionBackend: async function (
    editor,
    originalUserMessage,
    quoteAndSignatureText,
    requestId,
    isLocal = false, // Must be explicitly true for local mode; defaults to global
    serverUserMessage = null, // If provided, this is the text sent to the server (may differ for GLOBAL follow-ups)
    meta = null
  ) {
    if (TabMail.state && TabMail.state.inlineEditActive) {
      TabMail.log.debug('core', "triggerCorrectionBackend suppressed (inlineEditActive)");
      return;
    }
    // Mark per-mode in-flight.
    if (isLocal) {
      TabMail.state.isLocalRequestInFlight = true;
    } else {
      TabMail.state.isGlobalRequestInFlight = true;
    }

    try {
      const _tmStartTime = performance.now();

      // Always trigger a server response since the server cache might have
      // updated. Server should check if the query is identical and simply opt to
      // not re-run the LLM routine if the query is in the cache.
      const textForServer = serverUserMessage !== null ? serverUserMessage : originalUserMessage;
      if (!isLocal && serverUserMessage !== null && serverUserMessage !== originalUserMessage) {
        TabMail.log.info('core',
          `🌐 GLOBAL request #${requestId} is a follow-up: sending assumedAcceptedText to server (len=${textForServer.length}) ` +
          `while displayOriginal len=${originalUserMessage.length}`
        );
      } else if (!isLocal) {
        TabMail.log.info('core', `🌐 GLOBAL request #${requestId} origin=direct (server len=${textForServer.length})`);
      }

      const correctionData = await TabMail.getCorrectionFromServer({
        userMessage: originalUserMessage,
        quoteAndSignature: quoteAndSignatureText,
        cursorPosition: TabMail.getCursorOffsetIgnoringInserts(editor),
        isLocal: isLocal,
        // Note: getCorrectionFromServer reads userMessage from context.userMessage.
        // We pass server message via the same field to avoid adding new background protocol.
        ...(textForServer !== originalUserMessage ? { userMessage: textForServer } : {}),
      });

      const _tmDuration = performance.now() - _tmStartTime;
      TabMail.log.debug('core', `Backend request #${requestId} completed in ${_tmDuration.toFixed(1)} ms`
      );

      // Ignore stale responses (per-mode).
      const latestExpected = isLocal ? TabMail.state.latestLocalRequestId : TabMail.state.latestGlobalRequestId;
      if (requestId !== latestExpected) {
        TabMail.log.warn('core',
          `⚠️ STALE RESPONSE: Received response for request #${requestId} [${isLocal ? 'LOCAL' : 'GLOBAL'}], ` +
          `but latest is #${latestExpected}. Ignoring.`
        );
        return;
      }

      let correctedMessage = null;
      let backendUserText = originalUserMessage;
      let shouldDirectReplace = false;
      if (correctionData) {
        correctedMessage = correctionData.suggestion || null;
        backendUserText = correctionData.usertext || backendUserText;
        shouldDirectReplace = correctionData.directReplace || false;
        TabMail.log.info('core', `✓ Request #${requestId} returned suggestion: ${correctedMessage ? correctedMessage.substring(0, 50) + '...' : 'NULL'}`
        );
      } else {
        TabMail.log.warn('core', `⚠️ Request #${requestId} returned NO correction data`
        );
      }

      // Handle direct replacement mode
      if (shouldDirectReplace && correctedMessage && originalUserMessage.trim() === "") {
        TabMail.log.info('core', "Direct replacement mode: replacing empty content with suggestion");
        try {
          // Note: We no longer add trailing newlines here. setEditorPlainText
          // will add separator <br>s when there's a quote boundary.
          
          // Set the editor content (separator handled by setEditorPlainText)
          TabMail.setEditorPlainText(editor, correctedMessage);
          
          // Position cursor at the start of the content
          TabMail.setCursorByOffset(editor, 0);
          
          // Update state to reflect the content
          TabMail.state.originalText = correctedMessage;
          TabMail.state.correctedText = correctedMessage;
          TabMail.log.info('core', "Direct replacement completed successfully");
          return; // Skip the normal suggestion flow
        } catch (e) {
          TabMail.log.warn('core', `Direct replacement failed: ${e}`);
          // Fall through to normal suggestion flow
        }
      }

      // Process the corrected text (normal suggestion flow).
      let isCorrectedTextUpdated = false;
      if (correctedMessage) {
        // IMPORTANT: For GLOBAL follow-ups (server text != editor text), subset checking
        // must use the editor's display baseline, not the assumedAccepted server input.
        let processBaselineText = backendUserText;
        if (!isLocal && serverUserMessage !== null && serverUserMessage !== originalUserMessage) {
          processBaselineText = originalUserMessage;
          TabMail.log.debug('core',
            `GLOBAL follow-up #${requestId}: using display baseline for processCorrectedText (len=${processBaselineText.length})`
          );
        }

        isCorrectedTextUpdated = TabMail.processCorrectedText(
          correctedMessage,
          editor,
          processBaselineText
        );
        if (!isCorrectedTextUpdated) {
          TabMail.log.info('core', `⚠️ Request #${requestId} suggestion was rejected by processCorrectedText (user may have edited text or suggestion too similar)`
          );
        }
      }

      // Check if we are selecting some text (either mouse or keyboard).
      const selection = document.getSelection();
      const isSelecting = selection && selection.toString().length > 0;

      // Only trigger a render if we are not selecting some text and if the
      // corrected text has changed.
      const isTriggeringRender = !isSelecting && isCorrectedTextUpdated;
      if (isTriggeringRender) {
        // Render Text
        // Note: render the diffs if they are enabled and not auto-hidden.
        const show_diffs = TabMail.state.showDiff && !TabMail.state.autoHideDiff;
        TabMail.renderText(show_diffs);
        TabMail.log.debug('core', `✓ Request #${requestId} - Rendering suggestion`);
        
        // Track when suggestion was shown for back-off logic
        TabMail.state.lastSuggestionShownTime = Date.now();
        TabMail.state.textLengthAtLastSuggestion = originalUserMessage.length;
        TabMail.log.trace('core', `Tracked suggestion shown at time ${TabMail.state.lastSuggestionShownTime}, text length: ${TabMail.state.textLengthAtLastSuggestion}`);
      } else {
        if (isSelecting) {
          TabMail.log.debug('core', `Request #${requestId} - Skipping render (user is selecting text)`
          );
        } else if (!isCorrectedTextUpdated) {
          TabMail.log.debug('core', `Request #${requestId} - Skipping render (no corrected text update)`
          );
        }
      }

      // After LOCAL completion: immediately trigger GLOBAL follow-up assuming full acceptance
      // of the LOCAL suggestion. When GLOBAL returns, it replaces the correction text.
      if (isLocal) {
        if (isCorrectedTextUpdated && TabMail.state.correctedText) {
          const assumedAcceptedText = TabMail.state.correctedText;
          TabMail.log.info('core',
            `🌐 LOCAL complete (#${requestId}) -> triggering GLOBAL follow-up using assumed accepted text (len=${assumedAcceptedText.length})`
          );
          // Use setTimeout to avoid deep call stack and let the UI breathe.
          setTimeout(() => {
            TabMail.triggerGlobalFollowupAfterLocal(
              editor,
              originalUserMessage,
              quoteAndSignatureText,
              assumedAcceptedText,
              requestId
            );
          }, 0);
        } else {
          TabMail.log.debug('core', `LOCAL complete (#${requestId}) but no updated suggestion; skipping GLOBAL follow-up`);
        }
      }
    } finally {
      // Ensure the in-flight flag is cleared even if we early-return or hit an error.
      if (isLocal) {
        TabMail.state.isLocalRequestInFlight = false;
      } else {
        TabMail.state.isGlobalRequestInFlight = false;
      }
      
      // Check if a trigger was skipped while this request was in flight.
      // If so, and if the text has changed since this request was made,
      // immediately re-trigger to ensure we always have a suggestion for the latest text.
      if (isLocal ? TabMail.state.hasPendingLocalTrigger : TabMail.state.hasPendingGlobalTrigger) {
        TabMail.log.debug('core',
          `Request completed with pending ${isLocal ? 'LOCAL' : 'GLOBAL'} trigger. Checking if re-trigger needed.`
        );
        if (isLocal) {
          TabMail.state.hasPendingLocalTrigger = false;
        } else {
          TabMail.state.hasPendingGlobalTrigger = false;
        }
        
        // Get current text and compare to what we just processed
        const { originalUserMessage: currentText } = TabMail.extractUserAndQuoteTexts(editor);
        if (currentText !== originalUserMessage) {
          TabMail.log.info('core',
            `Text changed while ${isLocal ? 'LOCAL' : 'GLOBAL'} request was in flight. Re-triggering. ` +
            `(was: "${originalUserMessage.substring(0, 50)}...", now: "${currentText.substring(0, 50)}...")`
          );
          // Use setTimeout to avoid deep call stack and let the UI breathe
          setTimeout(() => TabMail.triggerCorrection(editor, !isLocal), 0);
        } else {
          TabMail.log.debug('core', "No text change detected. Skipping re-trigger.");
        }
      }
    }
  },

  /**
   * Processes the corrected text received from the server.
   * This function first checks if the content of the editor has changed since the
   * correction request was sent. If the content is unchanged, it proceeds to
   * render the differences between the original and the corrected text. This
   * prevents applying stale corrections to a modified document.
   *
   * @param {string} correctedMessage The corrected text string returned by the backend.
   * @param {HTMLElement} editor The main content-editable editor element.
   * @param {string} originalUserMessage The original, clean text of the user's message at the time the correction was initiated.
   */
  processCorrectedText: function (
    correctedMessage,
    editor,
    originalUserMessage
  ) {
    if (TabMail.state && TabMail.state.inlineEditActive) {
      TabMail.log.debug('core', "processCorrectedText suppressed (inlineEditActive)");
      return false;
    }
    // Recompute the user's current plain text via centralized helper.
    const { originalUserMessage: currentCleanedText } =
      TabMail.extractUserAndQuoteTexts(editor);

    // If the content has changed, ensure the edits made by the user are still compatible
    // with the incoming correction. We do this by checking that the diffs between the
    // original and *current* text are a (loose) subset of the diffs between the original
    // and the *corrected* text returned by the backend.
    if (currentCleanedText !== originalUserMessage) {
      TabMail.log.debug('core', `processCorrectedText: Text changed during request. ` +
        `Original: "${originalUserMessage.substring(0, 50)}...", ` +
        `Current: "${currentCleanedText.substring(0, 50)}..."`
      );
      
      const dmpSubset = new diff_match_patch();
      dmpSubset.Diff_EditCost = TabMail.config.dmpEditCost || 4;

      const diffsOriginalCurrent = TabMail.computeDiff(
        originalUserMessage,
        currentCleanedText
      );

      const diffsOriginalCorrected = TabMail.computeDiff(
        originalUserMessage,
        correctedMessage
      );

      const isSubset = TabMail._isDiffSubset(
        diffsOriginalCurrent,
        diffsOriginalCorrected
      );

      if (!isSubset) {
        TabMail.log.info('core', "❌ SUBSET CHECK FAILED: Current edits deviate from backend suggestion; discarding suggestion.");
        TabMail.log.info('core', "Current diffs vs original:",
          diffsOriginalCurrent.map(d => `[${d[0]}] "${d[1].substring(0, 30)}"`).join(", ")
        );
        TabMail.log.info('core', "Corrected diffs vs original:",
          diffsOriginalCorrected.map(d => `[${d[0]}] "${d[1].substring(0, 30)}"`).join(", ")
        );
        return false;
      } else {
        TabMail.log.debug('core', "✓ Subset check passed - suggestion is compatible with current edits");
      }
    }

    // // Logic to check changes in suggestion to smooth-out user experience.
    // if (TabMail.state.correctedText) {
    //   // Now, if we have a new suggestion, check how much it differs from the one
    //   // we currently have in terms of character count.
    //   const diffs = TabMail.computeDiff(TabMail.state.correctedText, correctedMessage);

    //   const diffCount = diffs.reduce(
    //     (acc, diff) => (diff[0] !== 0 ? acc + diff[1].length : acc),
    //     0
    //   );
    //   // console.log('[TMDBG DIFF COUNT]', diffCount, correctedMessage, TabMail.state.correctedText);

    //   // If we have less than CHAR_DIFF_THRESHOLD characters different, we
    //   // don't need to do anything.
    //   // TODO: Is it okay to just check the diff count for the corrected text?
    //   if (diffCount < TabMail.config.CHAR_DIFF_THRESHOLD) {
    //     return false;
    //   }
    // }

    // If we have more than CHAR_DIFF_THRESHOLD characters different, we need
    // to render the new suggestion after storing the new suggestion.
    // IMPORTANT: This should be the SINGLE place where we store the corrected
    // text.
    
    // Note: We no longer add trailing newlines here. The separator newlines are
    // stripped from user text during extraction and added back as <br>s during
    // rendering. This keeps the corrected text clean for diffing.
    
    TabMail.state.correctedText = correctedMessage;
    return true;
  },

  /**
   * Processes an accept or reject action on a single diff span.
   * This handles DOM manipulation, cursor offset calculations, and triggers
   * side-effects like backend notifications.
   * @param {HTMLElement} span The diff span to process.
   * @param {boolean} isAccept True if the action is 'accept', false for 'reject'.
   * @param {boolean} isGlobalAccept True if the accept action is global.
   * @param {number} currentCursorOffset The cursor's current character offset.
   * @param {HTMLElement} editor The editor instance.
   * @returns {{
   *   newCursorOffset: number,
   *   nodeForCursor: Node|null,
   *   placeCursorAfterNode: boolean
   * }} The results of the action, used for cursor placement.
   */
  processSpanAction: function (
    span,
    isAccept,
    isGlobalAccept,
    currentCursorOffset,
    editor
  ) {
    const diffType = span.dataset.tabmailDiff;
    let nodeForCursor = null;
    let placeCursorAfterNode = false;
    let newCursorOffset = currentCursorOffset;

    if (isAccept) {
      // ACCEPT action - reset idle time back to initial value
      const config = TabMail.config.autocompleteDelay;
      if (TabMail.state.currentIdleTime !== config.INITIAL_IDLE_MS) {
        const oldIdleTime = TabMail.state.currentIdleTime;
        TabMail.state.currentIdleTime = config.INITIAL_IDLE_MS;
        TabMail.log.info('core', `Suggestion accepted, resetting idle time: ${oldIdleTime}ms → ${config.INITIAL_IDLE_MS}ms`);
      }
      // Reset suggestion tracking
      TabMail.state.lastSuggestionShownTime = 0;
      TabMail.state.textLengthAtLastSuggestion = 0;
      
      if (diffType === "insert") {
        // Note that if we have a consecutive insert and delete, we accept both to perform a "replace"
        let precedingNode = span.previousSibling;
        // Skip over any whitespace-only text nodes to find the true preceding element.
        while (
          precedingNode &&
          precedingNode.nodeType === Node.TEXT_NODE &&
          precedingNode.textContent.trim() === ""
        ) {
          precedingNode = precedingNode.previousSibling;
        }

        if (
          precedingNode &&
          precedingNode.nodeType === Node.ELEMENT_NODE &&
          precedingNode.dataset.tabmailDiff === "delete"
        ) {
          // This is part of a "replace" operation, so we accept the preceding delete span.
          // By passing `isGlobalAccept` through, we ensure that if this is part of a
          // "accept all", the delete is also handled as a global accept.
          const deleteActionResult = TabMail.processSpanAction(
            precedingNode,
            true,
            isGlobalAccept,
            newCursorOffset,
            editor
          );
          newCursorOffset = deleteActionResult.newCursorOffset;
        }

        nodeForCursor = TabMail.unwrapElement(span);
        // Only move cursor by node for local actions.
        placeCursorAfterNode = !isGlobalAccept;
      } else {
        // 'delete'
        placeCursorAfterNode = false;
        const startOffset = TabMail.getOffsetOfNodeStart(span);
        if (startOffset !== -1) {
          const spanLength = span.textContent.length;
          const adjustment = Math.min(
            Math.max(0, newCursorOffset - startOffset),
            spanLength
          );
          newCursorOffset -= adjustment;
        }

        // NEW LOGIC: If a diff "delete" span is immediately followed by an
        // "insert" span (ignoring whitespace), treat the pair as a single
        // "replace" operation by accepting the following insert as well.
        // To avoid infinite recursion with the symmetrical logic in the
        // "insert" handler (which looks backward for a preceding delete), we
        // first capture the following node reference, then remove the delete
        // span, and finally process the insert span.
        let followingNode = span.nextSibling;
        while (
          followingNode &&
          followingNode.nodeType === Node.TEXT_NODE &&
          followingNode.textContent.trim() === ""
        ) {
          followingNode = followingNode.nextSibling;
        }

        // Remove the delete span (and any whitespace neighbors) before
        // processing the insert to prevent circular recursion.
        TabMail.removeNodeAndGetNeighbors(span);

        if (
          followingNode &&
          followingNode.nodeType === Node.ELEMENT_NODE &&
          followingNode.dataset.tabmailDiff === "insert"
        ) {
          const insertActionResult = TabMail.processSpanAction(
            followingNode,
            true, // isAccept
            isGlobalAccept, // propagate global flag
            newCursorOffset,
            editor
          );
          newCursorOffset = insertActionResult.newCursorOffset;
          if (!nodeForCursor) {
            nodeForCursor = insertActionResult.nodeForCursor;
            placeCursorAfterNode = insertActionResult.placeCursorAfterNode;
          }
        }
      }
      // Invalidate any pending backend operations and reset cache to prevent
      // ping-pong suggestions.
      if (TabMail.cancelPendingBackendRequest) {
        TabMail.cancelPendingBackendRequest();
      }

      // Let's disable this for now.
      // // Recompute user's current text via shared helper.
      // const { originalUserMessage: originalTextNow } = TabMail.extractUserAndQuoteTexts(editor);
      // TabMail.state.correctedText = originalTextNow;

      // After accepting, check if original === corrected (no remaining diffs).
      // Previously, we triggered GLOBAL correction here once diffs were fully accepted.
      // We no longer do that: GLOBAL is now kicked off immediately after LOCAL completes
      // (assuming full acceptance) and any new LOCAL trigger invalidates GLOBAL.
      // Keep this setTimeout to sync state after DOM mutations.
      setTimeout(() => {
        const { originalUserMessage } = TabMail.extractUserAndQuoteTexts(editor);
        TabMail.state.originalText = originalUserMessage;
        
        if (TabMail.state.originalText === TabMail.state.correctedText) {
          TabMail.log.info('core',
            "📊 No remaining diffs after accept - NOT triggering GLOBAL (GLOBAL follow-up is launched after LOCAL completion)"
          );
        }
      }, 0);
    } else {
      // REJECT action (always local)

      // OLD CODE: We disabled this because it was flooding the backend.
      // // Notify the backend of the rejection *before* altering the DOM,
      // // as notification may need to inspect the span in context.
      // if (span.textContent && TabMail.state.sessionId) {
      //   TabMail.notifyRejection(TabMail.state.sessionId, span, diffType);
      // }

      if (diffType === "insert") {
        placeCursorAfterNode = false;
        const startOffset = TabMail.getOffsetOfNodeStart(span);
        if (startOffset !== -1) {
          const spanLength = span.textContent.length;
          const adjustment = Math.min(
            Math.max(0, newCursorOffset - startOffset),
            spanLength
          );
          newCursorOffset -= adjustment;
        }
        TabMail.removeNodeAndGetNeighbors(span);
      } else {
        // 'delete'
        nodeForCursor = TabMail.unwrapElement(span);
        placeCursorAfterNode = false;
      }
    }

    return { newCursorOffset, nodeForCursor, placeCursorAfterNode };
  },

  /**
   * Utility to check if the set of diffs in `subsetDiffs` is contained within `supersetDiffs`.
   * The comparison is heuristic and operates on string inclusion of changed segments.
   * @param {Array} subsetDiffs Diffs from diff_match_patch representing the smaller set.
   * @param {Array} supersetDiffs Diffs representing the larger set.
   * @returns {boolean} True if every changed segment of subsetDiffs is found within supersetDiffs.
   */
  _isDiffSubset: function (subsetDiffs, supersetDiffs) {
    const subsetChanges = subsetDiffs
      .filter((d) => d[0] !== 0 && d[1].trim() !== "")
      .map((d) => d[1]);

    const supersetChangeText = supersetDiffs
      .filter((d) => d[0] !== 0 && d[1].trim() !== "")
      .map((d) => d[1])
      .join(" ");

    let missingChars = 0;
    for (const seg of subsetChanges) {
      if (!supersetChangeText.includes(seg)) {
        missingChars += seg.length;
      }
    }

    return missingChars <= TabMail.config.SUBSET_DIFF_TOLERANCE;
  },

  /**
   * Cancels any pending backend correction (scheduled or in-flight) and
   * invalidates responses so they are ignored when they arrive.
   */
  cancelPendingBackendRequest: function () {
    if (TabMail.state && TabMail.state.inlineEditActive) {
      // still cancel as safety, but note inline mode
      TabMail.log.debug('core', "cancelPendingBackendRequest (inlineEditActive)");
    }
    if (TabMail.state.backendTimer) {
      clearTimeout(TabMail.state.backendTimer);
      TabMail.state.backendTimer = null;
    }
    // Also clear the autocomplete idle timer
    if (TabMail.state.autocompleteIdleTimer) {
      clearTimeout(TabMail.state.autocompleteIdleTimer);
      TabMail.state.autocompleteIdleTimer = null;
      TabMail.log.trace('core', "Cleared autocomplete idle timer in cancelPendingBackendRequest");
    }
    // Bump request ids so in-flight responses can be detected as stale.
    // We invalidate BOTH modes here because this is used as a safety valve to
    // prevent ping-pong suggestions after manual accept/reject DOM mutations.
    TabMail.state.latestLocalRequestId = TabMail._nextRequestId(TabMail.state.latestLocalRequestId);
    TabMail.state.latestGlobalRequestId = TabMail._nextRequestId(TabMail.state.latestGlobalRequestId);

    // Clear pending flags and mark not blocking new work.
    TabMail.state.hasPendingLocalTrigger = false;
    TabMail.state.hasPendingGlobalTrigger = false;
    TabMail.state.isLocalRequestInFlight = false;
    TabMail.state.isGlobalRequestInFlight = false;

    if (TabMail.state.globalFollowup) {
      TabMail.state.globalFollowup.displayOriginalText = null;
      TabMail.state.globalFollowup.assumedAcceptedText = null;
      TabMail.state.globalFollowup.fromLocalRequestId = null;
    }
  },
});
