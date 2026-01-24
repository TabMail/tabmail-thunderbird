var TabMail = TabMail || {};

Object.assign(TabMail, {
  /**
   * Returns true if there is a quote/cite region AFTER the given node.
   * This is used to detect the "signature above quote" layout where Thunderbird
   * places `.moz-signature` before `.moz-cite-prefix`/`blockquote`.
   *
   * @param {HTMLElement|null} editor
   * @param {Node|null} node
   * @returns {boolean}
   */
  _hasQuoteAfterNode: function (editor, node) {
    try {
      if (!editor || !node) return false;
      const candidates = editor.querySelectorAll(
        "blockquote, .moz-cite-prefix, .moz-forward-container"
      );
      for (const el of Array.from(candidates)) {
        try {
          const rel = node.compareDocumentPosition(el);
          if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return true;
        } catch (_) {}
      }
      return false;
    } catch (_) {
      return false;
    }
  },
  /**
   * Determines if a keyboard event represents an input action (typing, deletion, etc.).
   * This function properly handles modifier keys and different event types.
   * @param {KeyboardEvent|InputEvent} e The keyboard or input event.
   * @returns {boolean} True if the event represents an input action.
   */
  isInputEvent: function (e) {
    // For IME composition events, always consider them as input
    if (e.isComposing) {
      return true;
    }

    // For composition events, always consider them as input
    if (e.type === "compositionstart" || e.type === "compositionend") {
      return true;
    }

    // For beforeinput/input events, check inputType
    if (e.type === "beforeinput" || e.type === "input") {
      return (
        e.inputType === "insertText" ||
        e.inputType === "insertLineBreak" ||
        e.inputType === "insertParagraph" ||
        e.inputType === "deleteContentBackward" ||
        e.inputType === "deleteContentForward" ||
        e.isComposing
      );
    }

    // For keydown events, check the key but exclude modifier key combinations
    if (e.type === "keydown") {
      const key = e.key;

      // If any modifier keys are pressed (except Shift for typing), it's likely not a simple input
      if (e.ctrlKey || e.altKey || e.metaKey) {
        return false;
      }

      // Keys that result in text insertion or deletion
      return (
        key.length === 1 || // Single character keys
        key === "Enter" || // Enter key
        key === "Tab" || // Tab key
        key === "Space" || // Space key
        key === "Backspace" || // Backspace key
        key === "Delete" // Delete key
      );
    }

    return false;
  },

  /**
   * Determines if a keyboard event represents a word boundary (space, tab, enter).
   * This function properly handles modifier keys.
   * @param {KeyboardEvent} e The keyboard event.
   * @returns {boolean} True if the event represents a word boundary.
   */
  isWordBoundaryEvent: function (e) {
    // If any modifier keys are pressed, it's not a simple word boundary
    if (e.ctrlKey || e.altKey || e.metaKey) {
      return false;
    }

    const key = e.key;
    return key === "Space" || key === "Tab" || key === "Enter";
  },

  /**
   * Determines if a keyboard event represents a deletion action (backspace, delete).
   * This function properly handles modifier keys.
   * @param {KeyboardEvent} e The keyboard event.
   * @returns {boolean} True if the event represents a deletion action.
   */
  isDeletionEvent: function (e) {
    // If any modifier keys are pressed, it's not a simple deletion
    if (e.ctrlKey || e.altKey || e.metaKey) {
      return false;
    }

    const key = e.key;
    return key === "Backspace" || key === "Delete";
  },

  /**
   * Finds the first node that marks the beginning of a quoted message or signature block.
   * Thunderbird uses specific selectors for these areas.
   * @param {HTMLElement} editor The content-editable editor element.
   * @returns {Node | null} The boundary node if found, otherwise null.
   */
  getQuoteBoundaryNode: function (editor) {
    if (!editor) return null;
    return editor.querySelector(
      "blockquote, .moz-cite-prefix, .moz-signature, .moz-forward-container"
    );
  },

  /**
   * A configurable, recursive function to convert editor HTML to plain text,
   * with options to handle diff-specific markup.
   * @param {HTMLElement} element The editor element or node to process.
   * @param {object} options Configuration for the text extraction.
   * @param {boolean} [options.skipInserts=false] - If true, text within insert spans is ignored.
   * @param {boolean} [options.skipDeletes=false] - If true, text within delete spans is ignored.
   * @returns {string} The structured text content of the editor.
   */
  _getCleanedEditorTextWithOptionsRecursive: function (element, options = {}) {
    let finalText = "";
    if (!element || !element.hasChildNodes()) {
      return "";
    }
    const { skipInserts = false, skipDeletes = false } = options;

    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        let textContent = child.textContent;
        if (TabMail.config && TabMail.config.DELETED_NEWLINE_VISUAL_CHAR) {
          const re = new RegExp(
            TabMail.config.DELETED_NEWLINE_VISUAL_CHAR,
            "g"
          );
          textContent = textContent.replace(re, "");
        }
        finalText += textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tagName = child.tagName.toUpperCase();
        const diffType = child.dataset ? child.dataset.tabmailDiff : null;

        // Skip TabMail UI elements (caret, arrow, newline markers, etc.)
        // These are visual indicators and should not contribute to text extraction.
        if (child.classList && (
          child.classList.contains("tm-fake-caret") ||
          child.classList.contains("tm-cursor-arrow") ||
          child.classList.contains("tm-nl") ||
          child.classList.contains("tm-inline-overlay") ||
          child.classList.contains("tm-inline-spinner") ||
          child.classList.contains("tm-quote-separator")
        )) {
          continue;
        }

        const shouldSkipInserts = skipInserts && diffType === "insert";
        const shouldSkipDeletes = skipDeletes && diffType === "delete";

        if (shouldSkipInserts || shouldSkipDeletes) {
          continue;
        }

        if (tagName === "BR") {
          finalText += "\n";
        } else {
          // Pass options down in recursive call
          const childText = this._getCleanedEditorTextWithOptionsRecursive(
            child,
            options
          );
          finalText += childText;

          const isBlock =
            tagName === "DIV" ||
            tagName === "P" ||
            tagName === "BLOCKQUOTE" ||
            (child.style && child.style.display === "block");

          // Add a newline for block elements unless they already end with one,
          // but don't add a newline for the container of a diff span.
          if (isBlock && !diffType && !childText.endsWith("\n")) {
            finalText += "\n";
          }
        }
      }
    }
    return finalText;
  },

  /**
   * A configurable function to convert editor HTML to plain text,
   * with options to handle diff-specific markup. This is a wrapper
   * that applies final formatting.
   * @param {HTMLElement} element The editor element or node to process.
   * @param {object} options Configuration for the text extraction.
   * @returns {string} The structured text content of the editor.
   */
  getCleanedEditorTextWithOptions: function (element, options = {}) {
    const finalText = this._getCleanedEditorTextWithOptionsRecursive(
      element,
      options
    );
    // Return the text as-is without trimming trailing newlines.
    // Trailing newlines are intentional and represent the structure of the document.
    return finalText;
  },

  /**
   * Helper to place the cursor after a given node.
   * @param {Node} node The node to place the cursor after.
   */
  setCursorAfterNode: function (node) {
    TabMail._beginProgrammaticSelection();
    try {
      if (!node) return;

      const range = document.createRange();
      const sel = window.getSelection();
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } finally {
      TabMail._endProgrammaticSelection();
    }
  },

  /**
   * Helper to place the cursor before a given node.
   * @param {Node} node The node to place the cursor before.
   */
  setCursorBeforeNode: function (node) {
    TabMail._beginProgrammaticSelection();
    try {
      if (!node) return;

      const range = document.createRange();
      const sel = window.getSelection();
      range.setStartBefore(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } finally {
      TabMail._endProgrammaticSelection();
    }
  },

  /**
   * Normalises the caret when it sits exactly at the first or last character
   * position inside a diff span. If the caret is moved this function returns
   * true so that the caller can exit early – a fresh `selectionchange` event
   * will be fired with the updated caret location.
   *
   * @returns {boolean} Whether the caret was repositioned.
   */
  normalizeCaretPosition: function () {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount !== 1 || !sel.isCollapsed) {
      return false;
    }

    const container = sel.anchorNode;
    const offset = sel.anchorOffset;
    if (!container) return false;

    // Find containing diff span if any.
    const baseElement =
      container.nodeType === Node.ELEMENT_NODE
        ? container
        : container.parentElement;
    if (!baseElement) return false;
    const diffSpan = baseElement.closest("[data-tabmail-diff]");
    if (!diffSpan) return false;

    let atStart = false;
    let atEnd = false;

    if (container.nodeType === Node.TEXT_NODE) {
      atStart = offset === 0;
      atEnd = offset === container.textContent.length;
    } else if (container === diffSpan) {
      atStart = offset === 0;
      atEnd = offset === diffSpan.childNodes.length;
    }

    if (atStart) {
      console.debug("[TabMail CaretNorm] Moving caret before span boundary.");
      TabMail.setCursorBeforeNode(diffSpan);
      return true;
    }

    if (atEnd) {
      console.debug("[TabMail CaretNorm] Moving caret after span boundary.");
      TabMail.setCursorAfterNode(diffSpan);
      return true;
    }

    return false;
  },

  /**
   * Traverses the editor's nodes to place the cursor at a specific character offset.
   * This version is compatible with `getCleanedEditorTextWithOptions`, accounting for newlines
   * generated by <br> tags and block-level elements.
   * @param {HTMLElement} editor The editor element.
   * @param {number} offset The character offset to place the cursor at.
   */
  setCursorByOffset: function (editor, offset, untilNode = null) {
    // Call internal implementation below, then ensure visibility.
    const _didScroll = TabMail._setCursorByOffsetInternal(editor, offset, untilNode);
    // After moving the cursor we want to scroll the viewport so that the caret is visible.
    // We defer scrolling to a helper so that consumers can call it independently as well.
    TabMail.scrollCursorIntoView(editor);
    return _didScroll;
  },

  /**
   * Ensures the current caret/selection is visible by scrolling the nearest
   * scrollable container (or the window) so that the cursor is roughly centred
   * vertically.  This is a no-op if the caret is already within the viewport.
   * @param {HTMLElement} editor The compose editor element.
   */
  scrollCursorIntoView: function (editor) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        return;
      }

      // Clone the current range so we can restore it later unchanged.
      const originalRange = sel.getRangeAt(0).cloneRange();

      // Materialise a temporary marker at the caret position in order to use
      // Element.scrollIntoView which isn’t available on Range in Gecko.
      const marker = document.createElement("span");
      // Zero-width space so it has height but no visible glyph.
      marker.textContent = "\u200B";
      marker.style.cssText =
        "display:inline-block;width:0;height:1em;padding:0;margin:0;border:0;pointer-events:none;";

      const rangeForMarker = originalRange.cloneRange();
      rangeForMarker.collapse(true);
      rangeForMarker.insertNode(marker);

      // Scroll so that the marker is visible – use nearest scrollable ancestor
      // but fall back to the window.
      let scrollTarget = marker.parentElement;
      while (
        scrollTarget &&
        scrollTarget !== document.body &&
        scrollTarget !== document.documentElement
      ) {
        const style = window.getComputedStyle(scrollTarget);
        const overflowY = style.overflowY;
        if (
          overflowY === "auto" ||
          overflowY === "scroll" ||
          overflowY === "overlay"
        ) {
          break;
        }
        scrollTarget = scrollTarget.parentElement;
      }

      const scrollOptions = { block: "center", inline: "nearest" };
      if (
        !scrollTarget ||
        scrollTarget === document.body ||
        scrollTarget === document.documentElement
      ) {
        // Use viewport scrolling
        marker.scrollIntoView(scrollOptions);
      } else {
        marker.scrollIntoView(scrollOptions);
      }

      // Clean-up: remove marker and restore original selection.
      const parent = marker.parentNode;
      if (parent) {
        parent.removeChild(marker);
      }
      sel.removeAllRanges();
      sel.addRange(originalRange);
    } catch (err) {
      console.error("[TabMail] scrollCursorIntoView error", err);
    }
  },

  /**
   * Original implementation of cursor positioning (extracted so we can hook
   * post-actions like scrolling without rewriting 1000-lines of traversal).
   * @private
   */
  _setCursorByOffsetInternal: function (editor, offset, untilNode = null) {
    TabMail._beginProgrammaticSelection();
    try {
      const sel = window.getSelection();
      if (!sel) return;

      const range = document.createRange();
      let charCount = 0;
      let found = false;

      // ------------------------------------------------------------------
      // Recursive traversal mirroring `getCleanedEditorTextWithOptions`.
      // ------------------------------------------------------------------
      //   • `charCount` tracks the character position in the *clean* plain-
      //     text representation of the editor (i.e. what we send to the
      //     backend).
      //   • When we reach the requested `offset`, we translate that clean
      //     position back to a concrete DOM position (`range.setStart`).
      //   • Special-case handling for:
      //       – <br> elements (count as a single newline character)
      //       – Block elements (<div>, <p>, <blockquote>, …) which count
      //         as a trailing newline if their content doesn’t already end
      //         with one
      //       – Our visual DELETE-newline placeholder character so that the
      //         cursor never lands *inside* that placeholder.
      function traverse(node) {
        // Respect optional boundary: do not traverse into quote/signature region.
        if (untilNode && node === untilNode) {
          return;
        }
        if (found) return;

        if (node.nodeType === Node.TEXT_NODE) {
          const originalText = node.textContent;
          let cleanText = originalText;
          let hasSpecialChars = false;

          if (TabMail.config && TabMail.config.DELETED_NEWLINE_VISUAL_CHAR) {
            if (
              originalText.includes(TabMail.config.DELETED_NEWLINE_VISUAL_CHAR)
            ) {
              const re = new RegExp(
                TabMail.config.DELETED_NEWLINE_VISUAL_CHAR,
                "g"
              );
              cleanText = originalText.replace(re, "");
              hasSpecialChars = true;
            }
          }

          const newCount = charCount + cleanText.length;
          if (!found && newCount >= offset) {
            const cleanOffsetInNode = offset - charCount;
            let dirtyOffsetInNode = cleanOffsetInNode;

            if (hasSpecialChars) {
              const specialChar = TabMail.config.DELETED_NEWLINE_VISUAL_CHAR;
              let cleanCharsSeen = 0;
              let mappedOffset = 0;

              for (let i = 0; i <= originalText.length; i++) {
                if (cleanCharsSeen === cleanOffsetInNode) {
                  mappedOffset = i;
                  break;
                }
                if (
                  i < originalText.length &&
                  originalText[i] !== specialChar
                ) {
                  cleanCharsSeen++;
                }
              }
              dirtyOffsetInNode = mappedOffset;
            }

            range.setStart(node, dirtyOffsetInNode);
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

          if (tagName === "BR") {
            // -----------------------------------------------------------
            // A <br> maps to ONE character: the newline. Therefore
            //   charCount  → position *before* the newline
            //   charCount+1 → position *after* the newline
            // -----------------------------------------------------------
            const posBefore = charCount;
            const posAfter = charCount + 1;

            if (!found && offset === posBefore) {
              range.setStartBefore(node); // place cursor before newline
              found = true;
            } else if (!found && offset === posAfter) {
              range.setStartAfter(node); // place cursor just after newline
              found = true;
            }
            // Whether we placed the cursor or not, a newline advances the
            // character count by exactly one.
            charCount++;
            return;
          }

          const isBlock =
            tagName === "DIV" ||
            tagName === "P" ||
            tagName === "BLOCKQUOTE" ||
            (node.style && node.style.display === "block");

          // -----------------------------------------------------------
          // KEY FIX: If the target `offset` is exactly at the start of a
          // block element, we should put the caret BEFORE traversing into
          // its children.  Otherwise the cursor would end up *after* the
          // first child, which is visually confusing.
          // -----------------------------------------------------------
          if (isBlock && !found && charCount === offset) {
            const leafNode = TabMail.findFirstLeaf(node);
            range.setStart(leafNode, 0);
            found = true;
            return;
          }

          for (const child of Array.from(node.childNodes)) {
            traverse(child);
            if (found) return;
          }

          // Mirror getCleanedEditorText: add a newline char for block
          // elements *unless* their textual content already ends with one.
          if (isBlock) {
            let lastMeaningfulChild = node.lastChild;
            while (
              lastMeaningfulChild &&
              lastMeaningfulChild.nodeType === Node.TEXT_NODE &&
              !lastMeaningfulChild.textContent.trim()
            ) {
              lastMeaningfulChild = lastMeaningfulChild.previousSibling;
            }
            if (!lastMeaningfulChild || lastMeaningfulChild.tagName !== "BR") {
              charCount++;
            }
          }
        }
      }

      traverse(editor);

      if (!found) {
        const fallback = document.createRange();
        fallback.selectNodeContents(editor);
        if (untilNode) {
          try { fallback.setEndBefore(untilNode); } catch (_) {}
        }
        fallback.collapse(false);
        sel.removeAllRanges();
        sel.addRange(fallback);
      } else {
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } finally {
      TabMail._endProgrammaticSelection();
    }
  },

  /**
   * Calculates the character offset of the beginning of a given node.
   * @param {Node} node The node to measure to.
   * @param {object} options Options for traversal, e.g., { skipInserts: true }.
   * @returns {number} The character offset, or -1 if unable to calculate.
   */
  getOffsetOfNodeStart: function (node, options = {}) {
    if (!node) return -1;
    const editor = TabMail.state.editorRef;
    if (!editor || !editor.contains(node)) return -1;

    // For counting, we need to find the first actual content "leaf"
    const leaf = TabMail.findFirstLeaf(node);
    const target = { targetNode: leaf, targetOffset: 0 };

    // We need to handle the case where the leaf is the node itself
    // and it's not a Text or BR node. traverseAndCount might handle this.
    // If leaf is an element, targetOffset is an index into childNodes.
    // So if the leaf is the node itself (e.g., an empty span), we are looking
    // for the offset of its 0-th child, which seems correct.

    return this.traverseAndCount(editor, target, options);
  },

  /**
   * Helper function to find the first "leaf" node (Text or BR) in a DOM subtree.
   * This is used to accurately place the cursor at the beginning of a complex
   * block element (e.g., a <div> containing <span>s).
   * @param {Node} node The starting node.
   * @returns {Node} The first leaf node found.
   */
  findFirstLeaf: function (node) {
    let currentNode = node;
    while (currentNode) {
      if (currentNode.nodeType === Node.TEXT_NODE) {
        return currentNode;
      }
      if (currentNode.tagName && currentNode.tagName.toUpperCase() === "BR") {
        return currentNode;
      }
      if (currentNode.hasChildNodes()) {
        currentNode = currentNode.firstChild;
      } else {
        break;
      }
    }
    return node; // Fallback to the original node
  },

  /**
   * Unwraps an element, moving its children to its parent and then removing it.
   * @param {HTMLElement} element The element to unwrap.
   * @returns {Node} The last child node that was moved, which can be used for cursor placement.
   */
  unwrapElement: function (element) {
    // Block programmatic selection while we unwrap the element.
    TabMail._beginProgrammaticSelection();
    try {
      const parent = element.parentNode;
      if (!parent) return null;

      const lastNode = element.lastChild;

      // Move all children out of the element, inserting them before the element.
      while (element.firstChild) {
        parent.insertBefore(element.firstChild, element);
      }

      // Remove the now-empty element.
      parent.removeChild(element);

      return lastNode;
    } finally {
      TabMail._endProgrammaticSelection();
    }
  },

  /**
   * Removes a node and returns its immediate neighbors.
   * @param {Node} node The node to remove.
   * @returns {{prev: Node, next: Node}} The siblings of the removed element.
   */
  removeNodeAndGetNeighbors: function (node) {
    // Block programmatic selection while we remove the node.
    TabMail._beginProgrammaticSelection();
    try {
      const nextSibling = node.nextSibling;
      const prevSibling = node.previousSibling;
      node.remove();
      return { prev: prevSibling, next: nextSibling };
    } finally {
      TabMail._endProgrammaticSelection();
    }
  },

  /**
   * Finds suggestion spans at or adjacent to the current cursor position, or all
   * spans that intersect with the current text selection.
   *
   * This is crucial for handling accept/reject when the cursor is not strictly
   * inside a diff span, but next to it, or when a user selects a block of text
   * containing multiple changes.
   *
   * @param {string|null|boolean} originalText - If string, finds all spans in the current sentence. If boolean, uses cursor-based logic with neighbor control. If null, uses cursor-based logic.
   * @returns {HTMLElement[]} An array of found span elements.
   */
  findSpansAtCursor: function (originalText = null, diffs = null) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return [];
    }

    const range = sel.getRangeAt(0);

    // Case 1: User has selected a range of text.
    if (!sel.isCollapsed) {
      const editor = TabMail.state.editorRef;
      if (!editor) return [];

      const allSpans = Array.from(
        editor.querySelectorAll("[data-tabmail-diff]")
      );
      return allSpans.filter((span) => {
        try {
          // range.intersectsNode() is the most reliable way to check for overlap.
          return range.intersectsNode(span);
        } catch (e) {
          console.warn("[TabMail DOM] Error checking node intersection:", e);
          return false;
        }
      });
    }

    // Case 2: Cursor is collapsed (at a single point).
    const container = range.startContainer;
    const offset = range.startOffset;

    // If originalText is a string, use sentence-based logic
    if (typeof originalText === "string") {
      // console.log("[TabMail DOM] Using sentence-based span finding with originalText:", originalText);

      const editor = TabMail.state.editorRef;
      if (!editor) return [];

      // Ensure diffs is an array
      if (!Array.isArray(diffs)) {
        console.warn(
          "[TabMail DOM] Diffs array is missing, cannot perform sentence-based filtering."
        );
        return [];
      }


      // Get current cursor position in the CORRECTED text (ignore deletes)
      const cursorPosition = TabMail.getCursorOffsetIgnoringDeletes(editor);

      // Get current visualized text skipping deletes
      const visualizedCorrectedText = TabMail.getCleanedEditorTextWithOptions(editor, { skipDeletes: true });

      // Split into sentences
      const visualizedCorrectedSentences = TabMail.splitIntoSentences(visualizedCorrectedText);

      // Find the index of the sentence containing the cursor in the visualized text
      const cursorSentenceIndexVisualized = TabMail.findSentenceContainingCursor(
        visualizedCorrectedSentences,
        cursorPosition
      );


    // // Resolve corrected text and split for diagnostics only (not used for logic)
    //   const correctedText =
    //     (TabMail.state && typeof TabMail.state.correctedText === "string")
    //       ? TabMail.state.correctedText
    //       : originalText;
    //   const sentences = TabMail.splitIntoSentences(correctedText);
    //   const cursorSentenceIndexNew = TabMail.findSentenceContainingCursor(
    //     sentences,
    //     cursorPosition
    //   );

    //   console.log("[TabMail DOM] Sentence analysis:", {
    //     cursorPosition,
    //     chars_before_cursor: correctedText.substring(0, cursorPosition),
    //     chars_after_cursor: correctedText.substring(cursorPosition),
    //     sentenceIndex: cursorSentenceIndexNew,
    //     sentence: sentences[cursorSentenceIndexNew]?.substring(0, 50),
    //     sentences,
    //   });  

      // Compute visualized sentence start/end in skipDeletes=true coordinate space
      let visualSentStart = 0;
      for (let i = 0; i < cursorSentenceIndexVisualized; i++) {
        visualSentStart += visualizedCorrectedSentences[i].length;
      }
      const visualSentEnd =
        visualSentStart + (visualizedCorrectedSentences[cursorSentenceIndexVisualized] || "").length;

      // console.log("[TabMail DOM] Visualized sentence window:", {
      //   cursorPosition,
      //   cursorSentenceIndexVisualized,
      //   visualSentStart,
      //   visualSentEnd,
      //   sampleSentence: (visualizedCorrectedSentences[cursorSentenceIndexVisualized] || "").substring(0, 80),
      // });

      // Collect all diff spans
      const allSpans = Array.from(
        editor.querySelectorAll("[data-tabmail-diff]")
      );

      // Gather visible spans whose start lies within the visualized sentence window
      const spansInVisualSentence = [];
      const sNewFrequency = new Map();

      for (const span of allSpans) {
        const diffType = span.dataset.tabmailDiff;
        const sNewStr = span.dataset.tabmailSentenceNew;
        const sNewVal = typeof sNewStr === "string" ? parseInt(sNewStr, 10) : NaN;

        const spanStart = TabMail.getOffsetOfNodeStart(span, { skipDeletes: true });

        if (spanStart >= 0 && spanStart >= visualSentStart && spanStart < visualSentEnd) {
          spansInVisualSentence.push(span);
          if (!Number.isNaN(sNewVal)) {
            sNewFrequency.set(sNewVal, (sNewFrequency.get(sNewVal) || 0) + 1);
          }
        }
      }

      // Choose target sNew by majority among spans in the visual window; fallback to nearest span
      let targetSNew = -1;
      if (sNewFrequency.size > 0) {
        targetSNew = [...sNewFrequency.entries()].sort((a, b) => b[1] - a[1])[0][0];
      } else {
        let best = null;
        let bestDelta = Infinity;
        for (const span of allSpans) {
          const sNewStr = span.dataset.tabmailSentenceNew;
          const sNewVal = typeof sNewStr === "string" ? parseInt(sNewStr, 10) : NaN;
          const pos = TabMail.getOffsetOfNodeStart(span, { skipDeletes: true });
          if (!Number.isNaN(sNewVal) && pos >= 0) {
            const delta = Math.abs(pos - visualSentStart);
            if (delta < bestDelta) {
              bestDelta = delta;
              best = sNewVal;
            }
          }
        }
        if (best != null) targetSNew = best;
      }

      // console.log("[TabMail DOM] sNew inference from visual window:", {
      //   targetSNew,
      //   spansInVisualSentence: spansInVisualSentence.length,
      // });

      if (targetSNew === -1) {
        return this._findSpansAtCursorCursorBased(container, offset);
      }

      // 1) Determine which diff entries overlap the inferred corrected sentence (sNew)
      const overlappingDiffIdx = new Set();
      for (let idx = 0; idx < diffs.length; idx++) {
        const d = diffs[idx];
        const sNewVal = typeof d[3] === "number" ? d[3] : undefined;
        const overlaps = sNewVal === targetSNew;

        // console.log("[TabMail DOM] Diff overlap check:", {
        //   idx,
        //   diff: d,
        //   targetSNew,
        //   overlaps,
        // });

        if (overlaps) {
          overlappingDiffIdx.add(String(idx));
        }
      }

      // 2) Collect spans whose diffIndex is in the overlap set.
      const spansInSentence = allSpans.filter((span) => {
        const diffIdx = span.dataset.tabmailDiffIndex;
        return diffIdx && overlappingDiffIdx.has(diffIdx);
      });

      return spansInSentence;
    }

    // Default cursor-based logic when originalText is null or boolean
    return this._findSpansAtCursorCursorBased(container, offset, originalText);
  },

  /**
   * Efficiently find spans to highlight using only the rendered diffs snapshot
   * and the cursor position in the diff view, avoiding whole-editor DOM-to-text conversion.
   * @param {Array} diffsArr - The diffs actually rendered (diffsToRender)
   * @param {number} viewCursorOffset - Cursor offset in the diff-rendered view
   * @returns {HTMLElement[]} Spans whose corrected-sentence index matches the cursor's sentence
   */
  findSpansByDiffsAndCursor: function (diffsArr, viewCursorOffset) {
    try {
      const editor = TabMail.state && TabMail.state.editorRef;
      if (!editor || !Array.isArray(diffsArr) || typeof viewCursorOffset !== "number") {
        return [];
      }

      // Build the visualized corrected text (skip deletes only)
      let viewText = "";
      for (const d of diffsArr) {
        const op = d && d[0];
        const txt = (d && d[1]) || "";
        if (op !== -1) viewText += txt;
      }

      // Determine corrected sentence index at the cursor position in view text
      const sentences = TabMail.splitIntoSentences(viewText);
      const sIdx = TabMail.findSentenceContainingCursor(sentences, viewCursorOffset);
      if (sIdx === -1) return [];

      // Select spans belonging to that corrected sentence (dataset.tabmailSentenceNew)
      const allSpans = Array.from(editor.querySelectorAll("[data-tabmail-diff]"));
      const targetStr = String(sIdx);
      const targets = allSpans.filter((span) => span.dataset && span.dataset.tabmailSentenceNew === targetStr);
      // Deduplicate while preserving order
      return [...new Set(targets)];
    } catch (e) {
      console.warn("[TabMail DOM] findSpansByDiffsAndCursor failed", e);
      return [];
    }
  },

  /**
   * Internal method for cursor-based span finding logic.
   * @param {Node} container - The container node at cursor position.
   * @param {number} offset - The offset within the container.
   * @param {boolean|null} includeNeighbors - If false, only return spans the cursor is inside. If true or null, include adjacent spans.
   * @returns {HTMLElement[]} Array of found span elements.
   */
  _findSpansAtCursorCursorBased: function (
    container,
    offset,
    includeNeighbors = null
  ) {
    let insideSpan = null;
    let afterSpan = null;

    // 1. Check for a span the cursor is INSIDE
    let parent = container;
    while (parent && parent !== TabMail.state.editorRef) {
      if (parent.nodeType === Node.ELEMENT_NODE && parent.dataset.tabmailDiff) {
        insideSpan = parent;
        break;
      }
      parent = parent.parentNode;
    }

    // 2. Check for a span immediately AFTER the cursor (only if includeNeighbors is not false)
    if (includeNeighbors !== false) {
      if (container.nodeType === Node.TEXT_NODE) {
        // If cursor is at the end of a text node, look for an adjacent span.
        if (offset === container.textContent.length) {
          let next = container.nextSibling;
          if (!next && container.parentNode.dataset.tabmailDiff) {
            // If the text node is inside a span, check the span's sibling.
            next = container.parentNode.nextSibling;
          }
          if (
            next &&
            next.nodeType === Node.ELEMENT_NODE &&
            next.dataset.tabmailDiff
          ) {
            afterSpan = next;
          }
        }
      } else if (container.nodeType === Node.ELEMENT_NODE) {
        // If cursor is between elements, check the element at the cursor position.
        const nodeAfter = container.childNodes[offset];
        if (
          nodeAfter &&
          nodeAfter.nodeType === Node.ELEMENT_NODE &&
          nodeAfter.dataset.tabmailDiff
        ) {
          afterSpan = nodeAfter;
        }
      }
    }

    // 3. Refine logic: If at the very end of a text node *inside* a span,
    // the 'inside' span is the primary target, and any following span is 'after'.
    if (
      insideSpan &&
      container.nodeType === Node.TEXT_NODE &&
      offset === container.textContent.length
    ) {
      // 'afterSpan' would have already been found by the logic above.
      // We don't want to treat the 'inside' span as also being 'after'.
      // The old logic was more complex; this is simpler. We have an inside, and we might have an after.
    }

    // Return a unique array of the found spans including the touching-neighbor span.
    return [...new Set([insideSpan, afterSpan].filter(Boolean))];
  },

  /**
   * Gets the start position of a span relative to the editor content.
   * @param {HTMLElement} span - The span element.
   * @param {HTMLElement} editor - The editor element.
   * @returns {number} The start position of the span, or -1 if not found.
   */
  _getSpanStartPosition: function (span, editor) {
    try {
      // Create a range from the start of the editor to the start of the span
      const range = document.createRange();
      range.setStart(editor, 0);
      range.setEnd(span, 0);

      // TODO: This could be problematic when dealing with fake newlines within
      // the delete diff spans.

      // Get the text content up to the span
      const textBeforeSpan = range.toString();
      return textBeforeSpan.length;
    } catch (e) {
      console.warn("[TabMail DOM] Error getting span start position:", e);
      return -1;
    }
  },

  /**
   * Gets the start position of a span in original text coordinates by traversing through diffs.
   * @param {HTMLElement} span - The span element.
   * @param {HTMLElement} editor - The editor element.
   * @param {Array<Array<number, string>>} diffs - The computed diffs.
   * @param {string} originalText - The original text.
   * @returns {number} The start position of the span in original text coordinates, or -1 if not found.
   */
  _getSpanStartPositionInOriginalText: function (
    span,
    editor,
    diffs,
    originalText
  ) {
    try {
      // Get the span's position in the current DOM
      const domPosition = this._getSpanStartPosition(span, editor);
      if (domPosition === -1) return -1;

      // Map DOM position back to original text position by traversing diffs
      let originalOffset = 0;
      let domOffset = 0;

      for (const diff of diffs) {
        const op = diff[0];
        const text = diff[1];

        // console.log("[TabMail DOM] Diff:", diff);
        // console.log("[TabMail DOM] DOM offset:", domOffset);
        // console.log("[TabMail DOM] DOM position:", domPosition);
        // console.log("[TabMail DOM] Text:", text);
        // console.log("[TabMail DOM] Original offset:", originalOffset);

        // Check if our span is in this diff's range
        if (domOffset <= domPosition && domPosition < domOffset + text.length) {
          // Return the offset of the span in the original text. (Always the
          // same logic since it is the starting point)
          // console.log("[TabMail DOM] Found span in diff:", diff);
          // console.log("[TabMail DOM] Returning offset:", originalOffset + (domPosition - domOffset));
          return originalOffset + (domPosition - domOffset);
        }

        // Update offsets
        if (op === 0 || op === -1) {
          // Equal or delete: contributes to original offset
          originalOffset += text.length;
        }
        // DOM offset always increases by the length of the diff.
        domOffset += text.length;
      }

      // If we get here, the span wasn't found in any diff
      console.warn("[TabMail DOM] Span not found in diffs");
      return -1;
    } catch (e) {
      console.warn(
        "[TabMail DOM] Error getting span start position in original text:",
        e
      );
      return -1;
    }
  },

  /**
   * Finds the closest diff span in the editor relative to the cursor,
   * either forwards or backwards, for navigation.
   * @param {string} direction - 'forward' or 'backward'.
   * @returns {HTMLElement|null} The found span element, or null.
   */
  findClosestSpan: function (direction) {
    const editor = TabMail.state.editorRef;
    if (!editor) return null;

    const allSpans = Array.from(editor.querySelectorAll("[data-tabmail-diff]"));
    if (allSpans.length === 0) return null;

    const cursorOffset = TabMail.getCursorOffset(editor);

    const spansWithOffsets = allSpans
      .map((span) => ({
        span,
        offset: TabMail.getOffsetOfNodeStart(span),
      }))
      .filter((item) => item.offset !== -1) // Filter out spans we can't get offset for
      .sort((a, b) => a.offset - b.offset);

    if (direction === "forward") {
      // Find the first span that starts after the cursor.
      const found = spansWithOffsets.find((item) => item.offset > cursorOffset);
      return found ? found.span : null;
    } else {
      // backward
      // Find all spans that start before the cursor.
      const candidates = spansWithOffsets.filter(
        (item) => item.offset < cursorOffset
      );
      // The closest one before the cursor will be the last one in this sorted list.
      return candidates.length > 0
        ? candidates[candidates.length - 1].span
        : null;
    }
  },

  /**
   * Extracts the full sentence containing a given span element.
   * It finds the nearest sentence boundaries (., !, ?, newline) around the span.
   * @param {HTMLElement} span The element to find the surrounding sentence for.
   * @param {string} diffType The type of diff ('insert' or 'delete').
   * @returns {string} The extracted sentence, or the span's text as a fallback.
   */
  extractSentenceAroundSpan: function (span, diffType) {
    try {
      if (!span || !span.textContent || !span.parentNode) {
        return "";
      }
      const rejectedText = span.textContent;

      const blockParent = span.closest(
        "div, p, blockquote, li, h1, h2, h3, h4, h5, h6"
      );
      const searchNode = blockParent || span.parentNode;

      // Choose the correct text extraction method based on the rejection type
      // to generate the context sentence that was presented to the user.
      let textExtractionOptions = {};
      if (diffType === "insert") {
        // To get the sentence *with* the suggested insertion, we must skip deletes.
        textExtractionOptions = { skipDeletes: true };
      } else if (diffType === "delete") {
        // To get the sentence *with* the original text (i.e., undoing the delete), we must skip inserts.
        textExtractionOptions = { skipInserts: true };
      }

      const fullText = TabMail.getCleanedEditorTextWithOptions(
        searchNode,
        textExtractionOptions
      );

      const spanOffsetInEditor = TabMail.getOffsetOfNodeStart(
        span,
        textExtractionOptions
      );
      const searchNodeOffsetInEditor = TabMail.getOffsetOfNodeStart(
        searchNode,
        textExtractionOptions
      );
      const rejectionIndex = spanOffsetInEditor - searchNodeOffsetInEditor;

      if (
        rejectionIndex < 0 ||
        spanOffsetInEditor < 0 ||
        searchNodeOffsetInEditor < 0
      ) {
        console.warn(
          "[TabMail DOM] Could not calculate the offset of the rejected span. Falling back."
        );
        return rejectedText.trim();
      }

      let fullSentence = rejectedText;

      const delimiters = [".", "!", "?", "\n"];
      let sentenceStart = 0;
      for (const d of delimiters) {
        const lastIndex = fullText.lastIndexOf(d, rejectionIndex);
        if (lastIndex !== -1) {
          sentenceStart = Math.max(sentenceStart, lastIndex + 1);
        }
      }

      let sentenceEnd = fullText.length;
      const searchStartIndex = rejectionIndex + rejectedText.length;
      for (const d of delimiters) {
        const firstIndex = fullText.indexOf(d, searchStartIndex);
        if (firstIndex !== -1) {
          sentenceEnd = Math.min(sentenceEnd, firstIndex + 1);
        }
      }

      fullSentence = fullText.substring(sentenceStart, sentenceEnd).trim();

      const result = fullSentence || rejectedText.trim();
      return result;
    } catch (e) {
      console.error("Error during sentence extraction:", e);
      // Fallback in case of any unexpected error
      return span ? span.textContent.trim() : "";
    }
  },

  /**
   * Updates the visual highlighting of diff spans.
   * It first removes highlights from any previously highlighted spans,
   * then applies new highlights to the provided target spans.
   * @param {Array<HTMLElement>} targets - An array of span elements to highlight.
   */
  updateSpanHighlighting: function (targets = []) {
    TabMail._beginProgrammaticSelection();
    try {
      // Expand targets to include immediate neighbor spans that participate in a
      // "replace" operation (insert followed by delete or vice-versa).
      const expandedTargets = [...targets];
      for (const span of targets) {
        if (!span) continue;
        const diffType = span.dataset.tabmailDiff;
        let neighbor = null;

        if (diffType === "insert") {
          // Look backwards for an immediately preceding delete span, ignoring
          // whitespace-only text nodes.
          neighbor = span.previousSibling;
          while (
            neighbor &&
            neighbor.nodeType === Node.TEXT_NODE &&
            neighbor.textContent.trim() === ""
          ) {
            neighbor = neighbor.previousSibling;
          }
          if (
            neighbor &&
            neighbor.nodeType === Node.ELEMENT_NODE &&
            neighbor.dataset.tabmailDiff === "delete"
          ) {
            expandedTargets.push(neighbor);
          }
        } else if (diffType === "delete") {
          // Look forwards for an immediately following insert span, ignoring
          // whitespace-only text nodes.
          neighbor = span.nextSibling;
          while (
            neighbor &&
            neighbor.nodeType === Node.TEXT_NODE &&
            neighbor.textContent.trim() === ""
          ) {
            neighbor = neighbor.nextSibling;
          }
          if (
            neighbor &&
            neighbor.nodeType === Node.ELEMENT_NODE &&
            neighbor.dataset.tabmailDiff === "insert"
          ) {
            expandedTargets.push(neighbor);
          }
        }
      }

      // Remove duplicates while preserving order.
      const uniqueTargets = [...new Set(expandedTargets)];

      // Un-highlight any previously highlighted spans
      for (const span of TabMail.state.currentlyHighlightedSpans) {
        if (document.body.contains(span)) {
          // Check if span is still in DOM
          const diffType = span.dataset.tabmailDiff;
          if (diffType === "insert") {
            span.style.backgroundColor =
              TabMail.config.getColor(TabMail.config.colors.insert.background);
            const textColor = TabMail.config.getColor(TabMail.config.colors.insert.text);
            if (textColor !== "inherit") {
              span.style.color = textColor;
            }
          } else if (diffType === "delete") {
            span.style.backgroundColor =
              TabMail.config.getColor(TabMail.config.colors.delete.background);
            const textColor = TabMail.config.getColor(TabMail.config.colors.delete.text);
            if (textColor !== "inherit") {
              span.style.color = textColor;
            }
          }
        }
      }
      TabMail.state.currentlyHighlightedSpans = [];

      // Highlight new targets (now including neighbors)
      if (uniqueTargets.length > 0) {
        for (const span of uniqueTargets) {
          if (!span) continue;
          const diffType = span.dataset.tabmailDiff;
          if (diffType === "insert") {
            span.style.backgroundColor =
              TabMail.config.getColor(TabMail.config.colors.insert.highlight.background);
            const textColor = TabMail.config.getColor(TabMail.config.colors.insert.highlight.text);
            if (textColor !== "inherit") {
              span.style.color = textColor;
            }
          } else if (diffType === "delete") {
            span.style.backgroundColor =
              TabMail.config.getColor(TabMail.config.colors.delete.highlight.background);
            const textColor = TabMail.config.getColor(TabMail.config.colors.delete.highlight.text);
            if (textColor !== "inherit") {
              span.style.color = textColor;
            }
          }
          TabMail.state.currentlyHighlightedSpans.push(span);
        }
      }
    } finally {
      TabMail._endProgrammaticSelection();
    }
  },

  /**
   * Inserts plain text at the current cursor position inside the active editor.
   * @param {string} text The text to insert.
   */
  insertTextAtCursor: function (text) {
    TabMail._beginProgrammaticSelection();
    try {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;

      const range = sel.getRangeAt(0);
      range.deleteContents();

      const textNode = document.createTextNode(text);
      range.insertNode(textNode);

      // Move cursor after inserted text
      range.setStartAfter(textNode);
      range.collapse(true);

      sel.removeAllRanges();
      sel.addRange(range);
    } finally {
      TabMail._endProgrammaticSelection();
    }
  },

  /**
   * Remove the current selection and position the cursor at the start of the selection.
   * @param {KeyboardEvent} e The keyboard event
   * @param {Selection} sel The current selection
   */
  removeSelection: function (sel) {
    TabMail._beginProgrammaticSelection();
    try {
      const range = sel.getRangeAt(0);
      const editor = TabMail.state.editorRef;
      if (!editor) return;

      // console.log("[TabMail DOM] Handling selection deletion with insert spans");

      // Store the original selection start position
      const originalStartContainer = range.startContainer;
      const originalStartOffset = range.startOffset;

      // Delete ALL content in the selection range (this includes insert spans, delete spans, and regular text)
      range.deleteContents();

      // Position cursor at the original selection start
      const newRange = document.createRange();
      newRange.setStart(originalStartContainer, originalStartOffset);
      newRange.collapse(true);

      sel.removeAllRanges();
      sel.addRange(newRange);

      // console.log("[TabMail DOM] All overlapping content deleted, cursor positioned at original start");
    } catch (err) {
      console.error(
        "[TabMail DOM] Error handling selection with insert spans:",
        err
      );
    } finally {
      TabMail._endProgrammaticSelection();
    }
  },

  /**
   * Replace the *user editable* portion of the editor (before any preserved quote)
   * with the given plain text. Newlines (\n) are converted to <br> elements.
   * The caller is responsible for wrapping this in withUndoPaused if needed.
   * @param {HTMLElement} editor
   * @param {string} plainText
   */
  setEditorPlainText: function (editor, plainText) {
    if (!editor) return;
    TabMail._beginProgrammaticSelection();
    try {
      const quoteBoundaryNode = TabMail.getQuoteBoundaryNode(editor);

      // Remove existing user content nodes (up to quote boundary if present)
      const range = document.createRange();
      range.selectNodeContents(editor);
      if (quoteBoundaryNode) {
        range.setEndBefore(quoteBoundaryNode);
      }
      range.deleteContents();

      // Build fragment from plain text
      const frag = document.createDocumentFragment();
      const lines = plainText.split("\n");
      lines.forEach((ln, idx) => {
        if (ln) frag.appendChild(document.createTextNode(ln));
        if (idx < lines.length - 1) {
          const br = document.createElement("br");
          br.setAttribute("_moz_dirty", "");
          frag.appendChild(br);
        }
      });

      // If there's a quote boundary, add the separator (skipped during extraction).
      // Use span (inline) instead of div (block) so the first <br> terminates
      // the text line rather than the block element creating an extra line.
      if (quoteBoundaryNode) {
        const sep = document.createElement("span");
        sep.classList.add("tm-quote-separator");
        sep.contentEditable = "false";
        sep.style.userSelect = "none";
        const isSig =
          quoteBoundaryNode.nodeType === Node.ELEMENT_NODE &&
          quoteBoundaryNode.classList &&
          quoteBoundaryNode.classList.contains("moz-signature");
        const cfg = (TabMail.config && TabMail.config.quoteSeparator) || {};
        const brCountDefault = typeof cfg.BR_COUNT_DEFAULT === "number" ? cfg.BR_COUNT_DEFAULT : 2;
        const brCountSigWithQuoteAfter =
          typeof cfg.BR_COUNT_WHEN_SIGNATURE_BOUNDARY_WITH_QUOTE_AFTER === "number"
            ? cfg.BR_COUNT_WHEN_SIGNATURE_BOUNDARY_WITH_QUOTE_AFTER
            : 1;
        const hasQuoteAfter = isSig ? TabMail._hasQuoteAfterNode(editor, quoteBoundaryNode) : false;
        const brCount = (isSig && hasQuoteAfter) ? brCountSigWithQuoteAfter : brCountDefault;
        TabMail.log.debug('dom', "quoteSeparator(setEditorPlainText)", {
          boundaryType: quoteBoundaryNode.tagName + (quoteBoundaryNode.className ? '.' + quoteBoundaryNode.className : ''),
          isSignature: isSig,
          hasQuoteAfter,
          brCount,
        });
        for (let i = 0; i < brCount; i++) {
          sep.appendChild(document.createElement("br"));
        }
        frag.appendChild(sep);
      }

      editor.insertBefore(frag, quoteBoundaryNode || null);
    } finally {
      TabMail._endProgrammaticSelection();
    }
  },

  /**
   * A configurable DOM traversal function to accurately count character offsets.
   * This is the core logic that powers cursor position calculations.
   *
   * @param {HTMLElement} editor The editor element.
   * @param {object} target - The target node and offset from window.getSelection().
   * @param {object} options - Configuration for the traversal.
   * @param {boolean} [options.skipInserts=false] - Whether to skip counting text in "insert" diffs.
   * @param {boolean} [options.skipDeletes=false] - Whether to skip counting text in "delete" diffs.
   * @returns {number} The calculated character offset, or -1 if the target wasn't found.
   */
  traverseAndCount: function (editor, target, options = {}) {
    const { skipInserts = false, skipDeletes = false } = options;
    const { targetNode, targetOffset } = target;

    let charCount = 0;
    let found = false;

    function shouldSkip(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      // Skip TabMail UI elements (caret, arrow, newline markers, etc.)
      if (node.classList && (
        node.classList.contains("tm-fake-caret") ||
        node.classList.contains("tm-cursor-arrow") ||
        node.classList.contains("tm-nl") ||
        node.classList.contains("tm-inline-overlay") ||
        node.classList.contains("tm-inline-spinner") ||
        node.classList.contains("tm-quote-separator")
      )) {
        return true;
      }
      if (!node.dataset) return false;
      if (skipInserts && node.dataset.tabmailDiff === "insert") return true;
      if (skipDeletes && node.dataset.tabmailDiff === "delete") return true;
      return false;
    }

    function traverse(node) {
      if (shouldSkip(node)) {
        if (node.contains(targetNode)) found = true;
        return;
      }

      if (targetNode === node) {
        if (node.nodeType === Node.TEXT_NODE) {
          charCount += targetOffset;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          for (let i = 0; i < targetOffset; i++) {
            if (i < node.childNodes.length) {
              traverse(node.childNodes[i]);
            }
          }
        }
        found = true;
        return;
      }

      if (found) return;

      if (node.nodeType === Node.TEXT_NODE) {
        let textContent = node.textContent;
        if (TabMail.config && TabMail.config.DELETED_NEWLINE_VISUAL_CHAR) {
          const re = new RegExp(
            TabMail.config.DELETED_NEWLINE_VISUAL_CHAR,
            "g"
          );
          textContent = textContent.replace(re, "");
        }
        charCount += textContent.length;
        return;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName ? node.tagName.toUpperCase() : "";

        if (tagName === "BR") {
          charCount++;
          return;
        }

        for (const child of Array.from(node.childNodes)) {
          traverse(child);
        }

        // If the cursor was located within one of the children, the count is
        // final. Do not add a newline for the container block itself.
        if (found) return;

        const isBlock =
          tagName === "DIV" ||
          tagName === "P" ||
          tagName === "BLOCKQUOTE" ||
          (node.style && node.style.display === "block");

        // Mirror getCleanedEditorText: for block elements add a newline
        // unless their content already ends with one.
        if (isBlock) {
          let lastMeaningfulChild = node.lastChild;
          while (
            lastMeaningfulChild &&
            lastMeaningfulChild.nodeType === Node.TEXT_NODE &&
            !lastMeaningfulChild.textContent.trim()
          ) {
            lastMeaningfulChild = lastMeaningfulChild.previousSibling;
          }
          if (!lastMeaningfulChild || lastMeaningfulChild.tagName !== "BR") {
            charCount++;
          }
        }
      }
    }

    traverse(editor);

    // // DEBUG: Log every invocation with a short caller hint so we can trace
    // // where unexpected offsets originate. Only logs when devtools console is
    // // open (console statements are cheap in Thunderbird compose).
    // try {
    //   const stackLine = (new Error()).stack.split('\n')[2] || '';
    //   console.log('[TMDBG TC]', {
    //     caller: stackLine.trim(),
    //     targetOffset,
    //     result: found ? charCount : -1,
    //     skipInserts,
    //     skipDeletes
    //   });
    // } catch(_) { /* ignore */ }

    return found ? charCount : -1;
  },

  /**
   * Maps a cursor offset from the original, plain text to its corresponding
   * offset within a diff-rendered HTML view. This is essential for placing
   * the cursor correctly after diffs are displayed, as the diff view contains
   * additional nodes (`<span>` for inserts/deletes) and text that don't
   * exist in the original string.
   *
   * @param {Array<Array<number, string>>} diffsArr - The diff array from `diff_match_patch`.
   * @param {number} origIdx - The character offset in the original text.
   * @returns {number} The corresponding character offset in the diff view.
   */
  mapCursorOffsetFromOriginalToDiffView: function (diffsArr, origIdx) {
    // console.log('[TMDBG SET CURSOR] in mapOriginalToDiffView', origIdx);
    let origPos = 0; // Tracks position in the original string
    let viewPos = 0; // Tracks position in the diff-rendered view

    // console.groupCollapsed(`[TMDBG MAP] Mapping origIdx: ${origIdx}`);

    for (let i = 0; i < diffsArr.length; i++) {
      const diffEntry = diffsArr[i];
      const op = diffEntry[0]; // -1: delete, 0: equal, 1: insert
      const txt = diffEntry[1];
      const len = txt.length;

      // console.log('[TMDBG MAP] Step:', { op, txt: `"${txt.replace(/\n/g, '⏎')}"`, len, origPos, viewPos });

      if (op === 0) {
        // EQUAL
        // If the target is within this "equal" segment
        if (origIdx >= origPos && origIdx <= origPos + len) {
          const finalViewPos = viewPos + (origIdx - origPos);

          // The original logic here would advance the cursor past any
          // immediately following insert operations. This created an
          // unintuitive behavior where a cursor at the end of a word
          // would jump to the end of a suggested insertion.
          // By removing that logic, the cursor now correctly stays
          // positioned *before* the insertion, as intended.

          // console.log(`[TMDBG MAP] Found in EQUAL. Returning: ${finalViewPos}`);
          // console.groupEnd();
          return finalViewPos;
        }
        origPos += len;
        viewPos += len;
      } else if (op === 1) {
        // INSERT
        // If the desired cursor position is exactly where this insertion occurs
        // in the original text, keep the caret *before* the inserted span so
        // it doesn\'t jump after the newly-added text.
        if (origIdx === origPos) {
          return viewPos;
        }
        // Insertions only exist in the view, they don\'t advance origPos
        viewPos += len;
      } else {
        // DELETE
        // If the target is within this "delete" segment
        if (origIdx >= origPos && origIdx <= origPos + len) {
          const finalViewPos = viewPos + (origIdx - origPos);
          // console.log(`[TMDBG MAP] Found in DELETE. Returning: ${finalViewPos}`);
          // console.groupEnd();
          return finalViewPos;
        }
        origPos += len;
        // Deletions exist in the view (as struck-through text)
        viewPos += len;
      }
    }

    // console.log(`[TMDBG MAP] Reached end. Returning: ${viewPos}`);
    // console.groupEnd();
    // Caret was at the very end of the original text.
    return viewPos;
  },

  /**
   * Maps a cursor offset from a diff-rendered HTML view back to its
   * corresponding offset in the original, plain text. This is the inverse
   * of `mapCursorOffsetFromOriginalToDiffView` and is crucial for restoring
   * the cursor position when diffs are hidden or accepted.
   *
   * @param {Array<Array<number, string>>} diffsArr - The diff array from `diff_match_patch`.
   * @param {number} viewIdx - The character offset in the diff-rendered view.
   * @returns {number} The corresponding character offset in the original text.
   */
  mapCursorOffsetFromDiffViewToOriginal: function (diffsArr, viewIdx) {
    let origPos = 0; // Tracks position in the original string
    let viewPos = 0; // Tracks position in the diff-rendered view

    for (const diffEntry of diffsArr) {
      const op = diffEntry[0]; // -1: delete, 0: equal, 1: insert
      const txt = diffEntry[1];
      const len = txt.length;

      const nextViewPos = viewPos + len;

      if (op === 0) {
        // EQUAL
        if (viewIdx >= viewPos && viewIdx <= nextViewPos) {
          return origPos + (viewIdx - viewPos);
        }
        origPos += len;
        viewPos = nextViewPos;
      } else if (op === 1) {
        // INSERT
        if (viewIdx >= viewPos && viewIdx <= nextViewPos) {
          // The cursor is inside an insert, which doesn't exist in the original.
          // Place the cursor at the position in the original text right
          // before where the insertion would be.
          return origPos;
        }
        // This part only exists in the view, so only viewPos advances.
        viewPos = nextViewPos;
      } else {
        // DELETE (op === -1)
        if (viewIdx >= viewPos && viewIdx <= nextViewPos) {
          return origPos + (viewIdx - viewPos);
        }
        // This part exists in both original text and diff view.
        origPos += len;
        viewPos = nextViewPos;
      }
    }

    // If the cursor was at the very end of the diff view.
    return origPos;
  },

  /**
   * Calculates the current cursor offset (character index) within the editor.
   * This offset is compatible with setCursorByOffset.
   * @param {HTMLElement} editor The editor element.
   * @returns {number} Character offset, or -1 if unavailable.
   */
  getCursorOffset: function (editor) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;

    const target = {
      targetNode: sel.anchorNode,
      targetOffset: sel.anchorOffset,
    };
    return this.traverseAndCount(editor, target, {
      skipInserts: false,
      skipDeletes: false,
    });
  },

  /**
   * Calculates the cursor offset while *ignoring* any text that was part of an
   * inserted diff segment (dataset.tabmailDiff = "insert"). This is used while
   * the suggestion diff is still visible so that, when we later restore the
   * original content, we can place the caret at the identical logical position
   * in the underlying text.
   * @param {HTMLElement} editor The editor element containing diff markup.
   * @returns {number} Character offset, or -1 if unavailable.
   */
  getCursorOffsetIgnoringInserts: function (editor) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;

    const target = {
      targetNode: sel.anchorNode,
      targetOffset: sel.anchorOffset,
    };
    // Ignore characters that belong to "insert" spans so we measure against
    // the original, uncorrected text.
    return this.traverseAndCount(editor, target, { skipInserts: true });
  },

  /**
   * Calculates a cursor offset that can be used to restore the cursor's logical
   * position after a diff is removed. It does this by ignoring any text that
   * was marked for deletion in the diff.
   * @param {HTMLElement} editor The editor element containing diff markup.
   */
  getCursorOffsetIgnoringDeletes: function (editor) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;

    const target = {
      targetNode: sel.anchorNode,
      targetOffset: sel.anchorOffset,
    };
    // To map a position from the diff view to the original text, we must
    // ignore characters inside "delete" spans.
    return this.traverseAndCount(editor, target, { skipDeletes: true });
  },

  /**
   * Extracts the user-written portion of the editor (excluding quoted reply / signature)
   * as well as the text of those quoted areas.
   * The logic mirrors what was previously duplicated in core.js.
   *
   * @param {HTMLElement} editor The content-editable compose editor element.
   * @returns {{ originalUserMessage: string, quoteAndSignatureText: string, quoteBoundaryNode: Node|null }}
   */
  extractUserAndQuoteTexts: function (editor) {
    if (!editor) {
      return {
        originalUserMessage: "",
        quoteAndSignatureText: "",
        quoteBoundaryNode: null,
      };
    }

    // Range covering everything the user has typed.
    const userContentRange = document.createRange();
    userContentRange.selectNodeContents(editor);

    const quoteBoundaryNode = TabMail.getQuoteBoundaryNode(editor);

    let quoteAndSignatureText = "";
    if (quoteBoundaryNode) {
      // Exclude quote/signature from the userContentRange.
      userContentRange.setEndBefore(quoteBoundaryNode);

      // Separate range for quote+signature portion.
      const quoteRange = document.createRange();
      quoteRange.setStartBefore(quoteBoundaryNode);
      quoteRange.setEnd(editor, editor.childNodes.length);

      const quoteFragment = quoteRange.cloneContents();
      const tmpQuoteDiv = document.createElement("div");
      tmpQuoteDiv.appendChild(quoteFragment);
      quoteAndSignatureText = TabMail.getCleanedEditorTextWithOptions(
        tmpQuoteDiv,
        { skipInserts: true }
      );
    }

    // Extract user-written text.
    const tmpUserDiv = document.createElement("div");
    tmpUserDiv.appendChild(userContentRange.cloneContents());
    let originalUserMessage = TabMail.getCleanedEditorTextWithOptions(
      tmpUserDiv,
      { skipInserts: true }
    );

    // Stripping logic removed to prevent input consumption issues.
    // We now rely on a protected separator to handle spacing.

    // Log the extracted text for debugging
    TabMail.log.debug('dom', "extractUserAndQuoteTexts:", {
      hasQuoteBoundary: !!quoteBoundaryNode,
      boundaryType: quoteBoundaryNode ? quoteBoundaryNode.tagName + (quoteBoundaryNode.className ? '.' + quoteBoundaryNode.className : '') : null,
      originalLength: originalUserMessage.length,
      endsWithNewline: originalUserMessage.endsWith("\n"),
      lastChars: JSON.stringify(originalUserMessage.slice(-10)),
    });

    return { originalUserMessage, quoteAndSignatureText, quoteBoundaryNode };
  },

});

// ------------------------------------------------------------------
// TEMP DEBUG HELPER: prints context around a character index.
// Usage: TabMail._dbgSlice(text, index, windowSize)
// ------------------------------------------------------------------
if (typeof TabMail !== "undefined" && !TabMail._dbgSlice) {
  TabMail._dbgSlice = function (txt, i, w = 20) {
    if (typeof txt !== "string") return "";
    const start = Math.max(0, i - w);
    const end = Math.min(txt.length, i + w);
    return txt.slice(start, i) + "⦿" + txt.slice(i, end).replace(/\n/g, "⏎");
  };
  console.log("[TMDBG] _dbgSlice helper installed");
}

// Removed legacy caret normaliser; span-based newline marker eliminates need.

// Inject CSS only once for the visual newline marker.
(() => {
  if (document.getElementById("tabmail-nl-style")) return;
  try {
    const style = document.createElement("style");
    style.id = "tabmail-nl-style";
    const hideDeleteNewlinesRule = TabMail.config.HIDE_DELETE_NEWLINES
      ? `html:not(.tabmail-hide-diffs) [data-tabmail-diff="delete"] br { display:none !important; }`
      : '';
    const nbspCount =
      (TabMail.config &&
        TabMail.config.newlineMarker &&
        TabMail.config.newlineMarker.NBSP_COUNT) ||
      1;
    const marker = "\u00a0".repeat(nbspCount);
    style.textContent = `
      .tm-nl::after { content: "${marker}"; user-select: none; pointer-events: none; }
      ${hideDeleteNewlinesRule}
      .tm-quote-separator { user-select: none; pointer-events: none; }
    `;
    (document.head || document.documentElement).appendChild(style);
    TabMail.log.info('dom', "Injected visual newline CSS (space marker) (HIDE_DELETE_NEWLINES:", TabMail.config.HIDE_DELETE_NEWLINES, ")");
  } catch (e) {
    console.error("[TabMail] Failed to inject visual newline CSS:", e);
  }
})();
