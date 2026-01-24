var TabMail = TabMail || {};

Object.assign(TabMail, {
  /**
   * Shows visual indicators (fake caret and arrow) for cursor movement suggestions.
   * @param {HTMLElement} editor The editor element.
   * @param {number} suggestedPosition The suggested cursor position.
   * @param {number} currentPosition The current cursor position.
   */
  showCursorMovementTooltip(editor, suggestedPosition, currentPosition) {
    // Respect visibility toggles. If diffs are disabled, or auto-hide is on,
    // or we're in inline edit mode, suppress caret hint visuals and clean up.
    try {
      if (
        TabMail?.state && (
          TabMail.state.showDiff === false ||
          TabMail.state.autoHideDiff === true ||
          TabMail.state.inlineEditActive === true
        )
      ) {
        console.log("[CURSOR_DEBUG] showDiff is false; suppressing caret hints and diffs.");
        // Ensure any existing indicators/overlays are removed when toggled off.
        try {
          if (editor) {
            const existingCaret = editor.querySelector(".tm-fake-caret");
            const existingArrow = editor.querySelector(".tm-cursor-arrow");
            if (existingCaret) existingCaret.remove();
            if (existingArrow) existingArrow.remove();
          }
        } catch (cleanupErr) {
          console.error("[CURSOR_DEBUG] Error cleaning existing caret hints while showDiff=false:", cleanupErr);
        }
        try {
          if (TabMail.removeJumpOverlay) {
            TabMail.removeJumpOverlay();
          }
        } catch (overlayErr) {
          console.error("[CURSOR_DEBUG] Error removing jump overlay while showDiff=false:", overlayErr);
        }
        return { renderDiffs: false };
      }
    } catch (err) {
      console.error("[CURSOR_DEBUG] Error evaluating showDiff toggle:", err);
    }

    // console.log("[CURSOR_DEBUG] === SHOW CURSOR MOVEMENT TOOLTIP START ===");
    // console.log("[CURSOR_DEBUG] Parameters:", {
    //   suggestedPosition,
    //   currentPosition,
    //   editorExists: !!editor,
    // });

    // Remove any existing visual indicators
    const existingCaret = editor.querySelector(".tm-fake-caret");
    const existingArrow = editor.querySelector(".tm-cursor-arrow");
    if (existingCaret) existingCaret.remove();
    if (existingArrow) existingArrow.remove();
    // Remove any existing jump overlay when redrawing indicators
    if (TabMail.removeJumpOverlay) {
      TabMail.removeJumpOverlay();
    }

    // Check if suggested position is in the same sentence as current position
    const originalText =
      TabMail.extractUserAndQuoteTexts(editor).originalUserMessage;
    const sentences = TabMail.splitIntoSentences(originalText);
    const currentSentenceIndex = TabMail.findSentenceContainingCursor(
      sentences,
      currentPosition
    );
    const suggestedSentenceIndex = TabMail.findSentenceContainingCursor(
      sentences,
      suggestedPosition
    );

    console.log("[CURSOR_DEBUG] Sentence analysis:", {
      originalTextLength: originalText.length,
      sentencesCount: sentences.length,
      currentSentenceIndex,
      suggestedSentenceIndex,
      currentSentence: sentences[currentSentenceIndex]?.substring(0, 50),
      suggestedSentence: sentences[suggestedSentenceIndex]?.substring(0, 50),
    });

    if (currentSentenceIndex === suggestedSentenceIndex) {
      // Same sentence - render diffs for that sentence only
      // console.log("[CURSOR_DEBUG] Same sentence - rendering diffs");
      return {
        renderDiffs: true,
        filterToSentence: currentSentenceIndex,
      };
    } else {
      // Different sentence - show visual indicators
      // console.log(
      //   "[CURSOR_DEBUG] Different sentence - showing visual indicators"
      // );
      // console.log("[CURSOR_DEBUG] Cursor jump suggestion:", {
      //   suggestedPosition,
      //   currentPosition,
      //   direction: suggestedPosition < currentPosition ? "backward" : "forward",
      // });

      // Create fake caret at suggested position
      const caret = TabMail.createFakeCaret(suggestedPosition);
      caret.dataset.suggestedPosition = suggestedPosition.toString();
      editor.appendChild(caret);
      // console.log("[CURSOR_DEBUG] Created fake caret:", caret);

      // Create arrow pointing downward above the caret
      const arrow = TabMail.createArrow(suggestedPosition, "down");
      arrow.dataset.suggestedPosition = suggestedPosition.toString();
      editor.appendChild(arrow);
      // console.log("[CURSOR_DEBUG] Created arrow:", arrow);

      // Position the visual indicators
      TabMail.positionVisualIndicators(editor, suggestedPosition, caret, arrow);

      // Show or update overlay hint if the suggested position is outside the viewport
      if (TabMail.manageJumpOverlay) {
        TabMail.manageJumpOverlay(editor, caret);
      }

      return {
        renderDiffs: false,
      };
    }

    // console.log("[CURSOR_DEBUG] === SHOW CURSOR MOVEMENT TOOLTIP END ===");
  },

  /**
   * Positions visual indicators (caret and arrow) at the correct location.
   * NOTE: When a collapsed range falls immediately after a <br>, Gecko returns
   *       an empty rect (0×0 at 0,0).  In that case we retry with the previous
   *       character, whose rect is always valid, then reuse its left/top.
   * @param {HTMLElement} editor The editor element.
   * @param {number} position The position to place the indicators.
   * @param {HTMLElement} caret The fake caret element.
   * @param {HTMLElement} arrow The arrow element.
   * @param {boolean} [_retrying=false] Internal guard to avoid infinite loops.
   */
  positionVisualIndicators(editor, position, caret, arrow, _retrying = false) {
    console.log("[CURSOR_DEBUG] === POSITION VISUAL INDICATORS START ===");
    console.log("[CURSOR_DEBUG] Target position:", position);
    console.log(
      "[CURSOR_DEBUG] Editor content length:",
      editor.textContent.length
    );
    console.log(
      "[CURSOR_DEBUG] Editor HTML:",
      editor.innerHTML.substring(0, 200) + "..."
    );

    // Build a collapsed range at the requested character offset
    const range = document.createRange();
    let charCount = 0;
    let found = false;
    let foundTextNode = null;

    function traverse(node) {
      if (found) return;

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        const newCount = charCount + text.length;

        console.log("[CURSOR_DEBUG] TEXT_NODE:", {
          text: `\"${text.substring(0, 30)}\"`,
          charCount,
          newCount,
          position,
        });

        if (!found && newCount >= position) {
          const offsetInNode = position - charCount;
          range.setStart(node, offsetInNode);
          range.setEnd(node, offsetInNode);
          foundTextNode = node;
          found = true;
        } else {
          charCount = newCount;
        }
        return;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toUpperCase();

        // Skip TabMail UI elements (caret, arrow, newline markers, etc.)
        if (node.classList && (
          node.classList.contains("tm-fake-caret") ||
          node.classList.contains("tm-cursor-arrow") ||
          node.classList.contains("tm-nl") ||
          node.classList.contains("tm-inline-overlay") ||
          node.classList.contains("tm-inline-spinner")
        )) {
          return;
        }

        console.log("[CURSOR_DEBUG] ELEMENT_NODE:", {
          tagName,
          charCount,
          position,
          found,
          childNodes: node.childNodes.length,
        });

        if (tagName === "BR") {
          const posBefore = charCount;
          const posAfter = charCount + 1;
          console.log("[CURSOR_DEBUG] BR element:", { posBefore, posAfter, position });

          if (!found && position === posBefore) {
            range.setStartBefore(node);
            range.setEndBefore(node);
            found = true;
          } else if (!found && position === posAfter) {
            range.setStartAfter(node);
            range.setEndAfter(node);
            found = true;
          } else {
            charCount = posAfter;
          }
          return;
        }

        // Skip SCRIPT / STYLE
        if (tagName === "SCRIPT" || tagName === "STYLE") return;

        for (const child of node.childNodes) traverse(child);
      }
    }

    // console.log("[CURSOR_DEBUG] Starting traversal...");
    traverse(editor);

    if (!found) {
      // console.log("[CURSOR_DEBUG] Position not found, collapsing to end of editor");
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    // Try to obtain a rectangle for the collapsed range.
    // Gecko (and sometimes Chromium) can give a 0×0 rect when the range is
    // located *between* a <br> and the first inline element/text run of the next
    // line.  Rather than walking back/forward through characters, we sidestep the
    // issue by **materialising** the position with a temporary inline probe
    // element and measuring that.
    let rects = range.getClientRects();
    let rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();

    if (rect.width === 0 && rect.height === 0) {
      // console.log("[CURSOR_DEBUG] Empty rect; inserting probe span to measure position");
      const probe = document.createElement("span");
      // A zero-width space inside ensures the span acquires line-height without
      // visibly shifting content.
      probe.textContent = "\u200B";
      probe.style.cssText = "display:inline-block;width:0;height:1em;overflow:hidden;padding:0;margin:0;border:0;pointer-events:none;";

      range.insertNode(probe);
      rect = probe.getBoundingClientRect();
      probe.remove();
      // Note: range is still collapsed at the correct offset after removing probe.
    }

    const firstAttemptEmpty = rect.width === 0 && rect.height === 0;

    // console.log("[CURSOR_DEBUG] Rect after measurement:", {
    //   left: rect.left,
    //   top: rect.top,
    //   width: rect.width,
    //   height: rect.height,
    // });


    // console.log("[CURSOR_DEBUG] Final range rect:", {
    //   left: rect.left,
    //   top: rect.top,
    //   width: rect.width,
    //   height: rect.height,
    // });

    // Derive a usable top coordinate.
    let baseTop = rect.top;

    // If we *still* have an empty rect (exotic edge-case), fall back to the
    // previous text node geometry.
    if ((rect.width === 0 && rect.height === 0) && foundTextNode) {
      const nodeRect = foundTextNode.parentElement
        ? foundTextNode.parentElement.getBoundingClientRect()
        : foundTextNode.getBoundingClientRect();
      const computedLineHeight = nodeRect.height || parseFloat(window.getComputedStyle(editor).lineHeight) || 16;
      baseTop = nodeRect.top + computedLineHeight;
      // console.log("[CURSOR_DEBUG] Using parent text node rect as fallback and shifting one line:", {
      //   nodeLeft: nodeRect.left,
      //   nodeTop: nodeRect.top,
      //   lineHeight: computedLineHeight,
      // });
      // also update rect.left so that left/right calculations reuse this anchor
      rect = { ...rect, left: nodeRect.left };
    }

    // Apply configured offsets
    const offsets = TabMail.config.colors.cursorJump.offsets;
    
    // Get editor's viewport position to convert to editor-relative coordinates
    const editorRect = editor.getBoundingClientRect();
    console.log("[CURSOR_DEBUG] Editor rect:", {
      left: editorRect.left,
      top: editorRect.top,
      width: editorRect.width,
      height: editorRect.height,
    });
    
    let caretLeft = rect.left;
    if (_retrying && foundTextNode) {
      const nodeRect = foundTextNode.parentElement
        ? foundTextNode.parentElement.getBoundingClientRect()
        : rect;
      caretLeft = nodeRect.left;
      // console.log("[CURSOR_DEBUG] Using line-start left from parent node:", caretLeft);
    }

    // Convert viewport coordinates to editor-relative coordinates
    // since caret/arrow use position:absolute and are children of editor
    const editorRelativeLeft = caretLeft - editorRect.left;
    const editorRelativeTop = baseTop - editorRect.top;
    
    // Get computed line height for base vertical offset
    const computedStyle = window.getComputedStyle(editor);
    const lineHeight = parseFloat(computedStyle.lineHeight) || 16;
    const baseVerticalOffset = lineHeight / 2;
    
    // Estimate one character width for horizontal offset
    const fontSize = parseFloat(computedStyle.fontSize) || 14;
    const oneCharWidth = fontSize * 0.6; // Approximate character width
    
    console.log("[CURSOR_DEBUG] Coordinate conversion:", {
      viewportLeft: caretLeft,
      viewportTop: baseTop,
      editorRelativeLeft,
      editorRelativeTop,
      lineHeight,
      baseVerticalOffset,
      fontSize,
      oneCharWidth,
    });

    const finalCaretLeft = editorRelativeLeft + offsets.caretX + oneCharWidth;
    const finalCaretTop = editorRelativeTop + offsets.caretY + baseVerticalOffset;
    const finalArrowLeft = editorRelativeLeft + offsets.arrowX + oneCharWidth;
    const finalArrowTop = editorRelativeTop + offsets.arrowY + baseVerticalOffset;

    caret.style.left = `${finalCaretLeft}px`;
    caret.style.top = `${finalCaretTop}px`;
    arrow.style.left = `${finalArrowLeft}px`;
    arrow.style.top = `${finalArrowTop}px`;

    // console.log("[CURSOR_DEBUG] Final positioning:", {
    //   caretLeft,
    //   caretTop,
    //   arrowLeft,
    //   arrowTop,
    //   offsets,
    // });
    // console.log("[CURSOR_DEBUG] === POSITION VISUAL INDICATORS END ===");
  },

  /**
   * Creates an arrow element pointing to a position.
   * @param {number} position The position the arrow should point to.
   * @param {string} direction The direction ('up', 'down', 'left', 'right').
   * @returns {HTMLElement} The arrow element.
   */
  createArrow(position, direction = "right") {
    const arrow = document.createElement("div");
    arrow.className = "tm-cursor-arrow";
    arrow.dataset.position = position.toString();
    arrow.dataset.direction = direction;
    arrow.style.cssText = `
      position: absolute;
      width: 0;
      height: 0;
      z-index: 10000;
      pointer-events: none;
    `;

    console.log("[TMDBG Jump] Creating arrow with direction:", direction);

    // Create arrow shape based on direction
    const arrowColor = TabMail.config.colors.cursorJump.arrow;
    switch (direction) {
      case "right":
        arrow.style.borderTop = "6px solid transparent";
        arrow.style.borderBottom = "6px solid transparent";
        arrow.style.borderLeft = `8px solid ${arrowColor}`;
        break;
      case "left":
        arrow.style.borderTop = "6px solid transparent";
        arrow.style.borderBottom = "6px solid transparent";
        arrow.style.borderRight = `8px solid ${arrowColor}`;
        break;
      case "up":
        arrow.style.borderLeft = "6px solid transparent";
        arrow.style.borderRight = "6px solid transparent";
        arrow.style.borderBottom = `8px solid ${arrowColor}`;
        break;
      case "down":
        arrow.style.borderLeft = "6px solid transparent";
        arrow.style.borderRight = "6px solid transparent";
        arrow.style.borderTop = `8px solid ${arrowColor}`;
        break;
    }

    console.log("[TMDBG Jump] Arrow styles applied:", {
      borderLeft: arrow.style.borderLeft,
      borderRight: arrow.style.borderRight,
      borderTop: arrow.style.borderTop,
      borderBottom: arrow.style.borderBottom,
    });

    return arrow;
  },

  /**
   * Creates a fake caret element for visual cursor indication.
   * @param {number} position The position where the caret should appear.
   * @returns {HTMLElement} The fake caret element.
   */
  createFakeCaret(position) {
    const caret = document.createElement("div");
    caret.className = "tm-fake-caret";
    caret.dataset.position = position.toString();
    const caretColor = TabMail.config.colors.cursorJump.caret;
    caret.style.cssText = `
      position: absolute;
      width: 2px;
      height: 1.2em;
      background-color: ${caretColor};
      animation: blink 1s infinite;
      z-index: 10000;
      pointer-events: none;
      top: 0;
    `;

    // Add CSS animation for blinking effect
    if (!document.querySelector("#tm-caret-styles")) {
      const style = document.createElement("style");
      style.id = "tm-caret-styles";
      style.textContent = `
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    return caret;
  },

  /**
   * Shows or hides an overlay hint prompting the user to press Tab to jump to
   * the suggested cursor position when that position is outside of the current
   * viewport.
   * @param {HTMLElement} editor The compose editor element.
   * @param {HTMLElement} caretEl The fake caret element that marks the suggested position.
   */
  manageJumpOverlay(editor, caretEl) {
    try {
      if (!caretEl || !editor) {
        return;
      }

      const caretRect = caretEl.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

      const isAbove = caretRect.bottom < 0;
      const isBelow = caretRect.top > viewportHeight;

      // If caret is visible, remove any overlay and return.
      if (!isAbove && !isBelow) {
        TabMail.removeJumpOverlay();
        return;
      }

      let overlay = document.getElementById("tm-jump-overlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "tm-jump-overlay";
        overlay.setAttribute("contenteditable", "false");
        overlay.setAttribute("aria-hidden", "true");
        overlay.setAttribute("role", "presentation");
        overlay.style.cssText = `
          position: fixed;
          left: 50%;
          transform: translateX(-50%);
          padding: 6px 12px;
          background: rgba(0, 0, 0, 0.8);
          color: white;
          font-size: 12px;
          border-radius: 4px;
          z-index: 10000;
          pointer-events: none;
          user-select: none;
          -moz-user-select: none;
        `;
        document.body.appendChild(overlay);
      }

      const direction = isAbove ? "up" : "down";
      overlay.textContent = direction === "down" ? "Press Tab to jump ↓" : "Press Tab to jump ↑";

      if (direction === "down") {
        overlay.style.top = "";
        overlay.style.bottom = "16px";
      } else {
        overlay.style.bottom = "";
        overlay.style.top = "16px";
      }
    } catch (err) {
      console.error("[TabMail] manageJumpOverlay error", err);
    }
  },

  /**
   * Removes the jump overlay hint if it exists.
   */
  removeJumpOverlay() {
    const existing = document.getElementById("tm-jump-overlay");
    if (existing) {
      existing.remove();
    }
  },

  /**
   * Shows the compose keyboard hints banner at the bottom of the compose window.
   * The banner shows: "Tab to accept · Shift-Tab to accept all · ⌘K to edit"
   * Always visible in compose window (controlled by settings toggle).
   */
  showComposeHintsBanner() {
    try {
      // Check if banner setting is disabled
      if (TabMail.state.composeHintsBannerDisabled) {
        return;
      }

      // Check if banner already exists
      if (document.getElementById("tm-compose-hints-banner")) {
        return;
      }

      // Create the banner element
      const banner = document.createElement("div");
      banner.id = "tm-compose-hints-banner";
      banner.setAttribute("contenteditable", "false");
      banner.setAttribute("aria-hidden", "true");
      banner.setAttribute("role", "presentation");
      
      // Detect platform for shortcut display
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modKey = isMac ? "⌘" : "Ctrl+";
      
      // Subtle, unobtrusive style
      banner.style.cssText = `
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        padding: 3px 12px;
        background: transparent;
        color: var(--tm-hint-banner-text);
        font-size: 10px;
        text-align: center;
        z-index: 10000;
        pointer-events: none;
        user-select: none;
        -moz-user-select: none;
        -webkit-user-select: none;
      `;
      banner.textContent = `Tab to accept · Shift-Tab to accept all · ${modKey}K to edit`;

      // Append to documentElement (html) instead of body to avoid banner text
      // being serialized into compose content when Thunderbird changes identity/account
      document.documentElement.appendChild(banner);
      console.log(
        `[TabMail] Compose hints banner injected to documentElement (designMode=${document.designMode}, body.isContentEditable=${!!document.body && !!document.body.isContentEditable})`
      );

    } catch (err) {
      console.error("[TabMail] showComposeHintsBanner error:", err);
    }
  },

  /**
   * Hides the compose keyboard hints banner (e.g., when setting is disabled).
   */
  hideComposeHintsBanner() {
    try {
      const existing = document.getElementById("tm-compose-hints-banner");
      if (existing) {
        existing.remove();
      }
    } catch (err) {
      console.error("[TabMail] hideComposeHintsBanner error:", err);
    }
  },
});
