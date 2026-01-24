var TabMail = TabMail || {};

// Central computeDiff helper (moved from diff_utils.js)
if (!TabMail.computeDiff) {
  TabMail.computeDiff = function (text1, text2, cursorOffsetInText1 = undefined) {
    if (text1 === text2) {
      return text1 ? [[0, text1]] : [];
    }

    // No stripping of trailing newlines - texts are compared as-is.
    // The quote/signature boundary handling strips trailing newlines from
    // user text during extraction and adds separator <br>s during rendering.
    const text1Trimmed = text1;
    const text2Trimmed = text2;

    // ------------------------------------------------------------------
    // FIRST-PASS: Tokenization and token-level diff
    //
    // We keep newlines as standalone tokens and may normalize runs of spaces
    // for equality comparison only (controlled by config).
    // ------------------------------------------------------------------

    const perfEnabled = !!(TabMail.config && TabMail.config.diffPerfLogging);
    const usePerf = (function(){ try { return (typeof performance !== "undefined" && typeof performance.now === "function"); } catch (_) { return false; } })();
    function _now() { try { return usePerf ? performance.now() : Date.now(); } catch (_) { return Date.now(); } }
    const tTokStart = _now();
    const origTokens = (TabMail.getTokenParts ? TabMail.getTokenParts(text1Trimmed) : [text1Trimmed]);
    const newTokens = (TabMail.getTokenParts ? TabMail.getTokenParts(text2Trimmed) : [text2Trimmed]);
    const tTokEnd = _now();

    function _isWhitespaceNoNl(tok) {
      return typeof tok === "string" && tok.length > 0 && tok.indexOf("\n") === -1 && /^[ \t\u00A0]+$/.test(tok);
    }
    function _eqToken(a, b) {
      if (a === b) return true;
      const cfg = (TabMail.config && TabMail.config.tokens) || {};
      // Keep newline equality strict to preserve structure
      if (a === "\n" || b === "\n") return false;
      if (cfg.normalizeWhitespaceForEquality && _isWhitespaceNoNl(a) && _isWhitespaceNoNl(b)) {
        return true;
      }
      return a === b;
    }

    // Comparator used by jsdiff arrays (kept simple now that patience is removed)
    function _eqTokenWithMetrics(a, b) { return _eqToken(a, b); }

    // Use jsdiff arrays over our tokens
    // Ensure jsdiff is available (loaded via compose/background.js)
    if (!(typeof Diff !== "undefined" && Diff.diffArrays)) {
      console.error("[TabMail Diff] jsdiff not loaded in compose context; Diff.diffArrays unavailable.");
    }
    const tTokDiffStart = _now();
    const jsdiffComponents = (typeof Diff !== "undefined" && Diff.diffArrays)
      ? Diff.diffArrays(origTokens, newTokens, { comparator: _eqTokenWithMetrics })
      : [];
    const tTokDiffEnd = _now();
    const tokenOps = [];
    for (const comp of jsdiffComponents) {
      if (comp.added) {
        tokenOps.push({ op: 1, a: [], b: comp.value || [] });
      } else if (comp.removed) {
        tokenOps.push({ op: -1, a: comp.value || [], b: [] });
      } else {
        // Equal block: split into single-token equal ops to match downstream expectations
        const vals = comp.value || [];
        for (const tok of vals) {
          tokenOps.push({ op: 0, a: [tok], b: [tok] });
        }
      }
    }

    const tokenLevelDiffs = [];
    for (const blk of tokenOps) {
      if (blk.op === 0) {
        // equal: one token on each side
        tokenLevelDiffs.push([0, blk.a[0]]);
      } else if (blk.op === -1) {
        // delete: push each token individually to preserve boundaries
        for (const tok of (blk.a || [])) {
          tokenLevelDiffs.push([-1, tok]);
        }
      } else if (blk.op === 1) {
        // insert: push each token individually to preserve boundaries
        for (const tok of (blk.b || [])) {
          tokenLevelDiffs.push([1, tok]);
        }
      }
    }

    try {
      if (TabMail.config && TabMail.config.diffLogGrouping) {
        const sample = tokenLevelDiffs.slice(0, 6).map((e) => ({ op: e[0], len: (e[1]||"").length, txt: JSON.stringify((e[1]||"").slice(0, 80)) }));
        const equalsCount = tokenOps.filter((b) => b.op === 0).length;
        TabMail.log.debug('diff', "Token-level diffs (jsdiff-arrays)", { blocks: tokenLevelDiffs.length, equalsCount, sample });

        // Detailed token diff debugging similar to renderText diff debug
        try {
          const cfg = (TabMail.config && TabMail.config.tokens) || {};
          const maxTok = typeof cfg.sampleLogCount === "number" ? cfg.sampleLogCount : 20;
          console.groupCollapsed("[TabMail] Token Diff Debug");
          console.debug("[TabMail] tokenEq.normalizeWhitespace:", !!cfg.normalizeWhitespaceForEquality);
          console.debug("[TabMail] origTokens sample:", origTokens.slice(0, maxTok).map((t) => JSON.stringify(t)));
          console.debug("[TabMail] newTokens sample:", newTokens.slice(0, maxTok).map((t) => JSON.stringify(t)));
          // Table for tokenOps blocks
          const tokenOpsTable = tokenOps.slice(0, 40).map((b) => ({
            op: b.op,
            aLen: b.a ? b.a.length : 0,
            bLen: b.b ? b.b.length : 0,
            aText: JSON.stringify((b.a || []).join("").slice(0, 80)),
            bText: JSON.stringify((b.b || []).join("").slice(0, 80)),
          }));
          console.table(tokenOpsTable);
          // Table for flattened token-level diffs
          const tokenLevelTable = tokenLevelDiffs.slice(0, 40).map((d) => ({
            op: d[0],
            len: (d[1] || "").length,
            txt: JSON.stringify((d[1] || "").slice(0, 120)),
          }));
          console.table(tokenLevelTable);
          console.groupEnd();
        } catch (e) {
          console.warn("[TabMail] Unable to render token diff debug", e);
        }
      }
    } catch (_) {}

    // ------------------------------------------------------------------
    // SECOND-PASS: Char-level inner rediff inside replacement hunks only
    // ------------------------------------------------------------------

    let charDiffCount = 0;
    let charDiffTotalMs = 0;
    let charFirstStart = null;
    let charLastEnd = null;
    function refineReplacementHunks(d, cursorSkipOffset) {
      const refined = [];
      let origPos = 0;
      for (let i = 0; i < d.length; i++) {
        const cur = d[i];
        const next = d[i + 1];
        if (cur && next && cur[0] === -1 && next[0] === 1) {
          const delText = cur[1] || "";
          const insText = next[1] || "";
          const delStart = origPos;
          const delEnd = delStart + delText.length;
          // const cursorInside =
          //   typeof cursorSkipOffset === "number" &&
          //   cursorSkipOffset >= delStart &&
          //   cursorSkipOffset <= delEnd;

          // if (cursorInside) {
          //   // Keep token-level replacement at the cursor position; skip char refine
          //   refined.push(cur, next);
          //   origPos += delText.length;
          //   i++; // consume next
          //   continue;
          // }

          const subDmp = new diff_match_patch();
          subDmp.Diff_EditCost = TabMail.config.dmpEditCost || 4;
          const tCharStart = _now();
          const inner = subDmp.diff_main(delText, insText, /*checkLines*/ true);
          const tCharEnd = _now();
          charDiffCount++;
          charDiffTotalMs += tCharEnd - tCharStart;
          if (charFirstStart === null) charFirstStart = tCharStart;
          charLastEnd = tCharEnd;
          refined.push(...inner);
          origPos += delText.length;
          i++; // consumed next
        } else {
          refined.push(cur);
          if (cur && cur[0] !== 1) {
            origPos += (cur[1] || "").length;
          }
        }
      }
      return refined;
    }

    const refinedDiffs = refineReplacementHunks(tokenLevelDiffs, cursorOffsetInText1);

    if (perfEnabled) {
      try {
        const tokMs = tTokEnd - tTokStart;
        const tokDiffMs = tTokDiffEnd - tTokDiffStart;
        TabMail.log.debug('diff', "DiffPerf", {
          timingSource: usePerf ? "performance.now" : "Date.now",
          tokenization: { start: tTokStart, end: tTokEnd, ms: Number(tokMs.toFixed(3)) },
          tokenDiff: { start: tTokDiffStart, end: tTokDiffEnd, ms: Number(tokDiffMs.toFixed(3)) },
          charDiff: {
            calls: charDiffCount,
            totalMs: Number(charDiffTotalMs.toFixed(3)),
            firstStart: charFirstStart,
            lastEnd: charLastEnd,
          },
          textLens: { orig: (text1 || "").length, new: (text2 || "").length },
          counts: {
            origTokens: origTokens.length,
            newTokens: newTokens.length,
            jsdiffComponents: jsdiffComponents.length,
            tokenOps: tokenOps.length,
            tokenLevelDiffs: tokenLevelDiffs.length,
            refinedDiffs: refinedDiffs.length,
          },
        });
      } catch (_) {}
    }

    // ------------------------------------------------------------------
    // MERGE-PASS (moved): merge adjacent diffs of the same type to reduce fragmentation
    // Place this before sentence split so we merge after char-level refinement
    // ------------------------------------------------------------------
    function mergeAdjacentDiffs(diffs) {
      if (!diffs || diffs.length === 0) return diffs;
      const merged = [];
      let current = null;
      for (const diff of diffs) {
        const op = diff[0];
        const text = diff[1];
        if (current && current.op === op) {
          current.text += text;
        } else {
          if (current) merged.push([current.op, current.text]);
          current = { op, text };
        }
      }
      if (current) merged.push([current.op, current.text]);
      return merged;
    }

    const mergedAfterChar = mergeAdjacentDiffs(refinedDiffs);

    try {
      if (TabMail.config && TabMail.config.diffLogGrouping) {
        const sample = mergedAfterChar.slice(0, 6).map((e) => ({ op: e[0], len: (e[1]||"").length, txt: JSON.stringify((e[1]||"").slice(0, 80)) }));
        TabMail.log.debug('diff', "Post-merge (after char refine)", {
          refinedCount: refinedDiffs.length,
          mergedCount: mergedAfterChar.length,
          reduction: refinedDiffs.length - mergedAfterChar.length,
          sample,
        });
      }
    } catch (_) {}

    // ------------------------------------------------------------------
    // THIRD-PASS: split any insert/delete diff that still spans multiple
    // sentences so that sentence-aware features (cursor highlighting,
    // accept/reject, etc.) operate on per-sentence units.  We reuse the
    // same splitter implemented in sentences.js to guarantee identical
    // boundaries across the codebase.
    // ------------------------------------------------------------------
    function splitDiffsBySentence(d) {
      const expanded = [];
      for (const entry of d) {
        const op = entry[0];
        const txt = entry[1];
        const parts = TabMail.splitIntoSentences(txt);
        if (parts.length <= 1) {
          expanded.push(entry);
        } else {
          for (const p of parts) {
            if (p) expanded.push([op, p]);
          }
        }
      }
      return expanded;
    }

    const expandedDiffs = splitDiffsBySentence(mergedAfterChar);
    try {
      if (TabMail.config && TabMail.config.diffLogGrouping) {
        const sample = expandedDiffs.slice(0, 6).map((e) => ({ op: e[0], len: (e[1]||"").length, txt: JSON.stringify((e[1]||"").slice(0, 80)) }));
        TabMail.log.debug('diff', "Post-split sentence fragments", { count: expandedDiffs.length, sample });
        // Extra diagnostics: count of pure "\n" fragments to detect newline loss
        const newlineTokens = expandedDiffs.filter((e) => typeof e[1] === "string" && /^\n+$/.test(e[1]));
        if (newlineTokens.length > 0) {
          TabMail.log.debug('diff', "Newline-only fragments detected", {
            count: newlineTokens.length,
            lengths: newlineTokens.map((e) => e[1].length).slice(0, 10),
          });
        }
      }
    } catch (_) {}

    // ------------------------------------------------------------------
    // FOURTH-PASS: annotate each diff with sentence indices for both the
    // original and corrected texts. For op === -1, corrected index is -1;
    // for op === 1, original index is -1.
    // ------------------------------------------------------------------
    function annotateDiffsWithSentenceIndices(d, originalText, correctedText) {
      const annotated = [];
      const origSentences = TabMail.splitIntoSentences(originalText);
      const newSentences = TabMail.splitIntoSentences(correctedText);

      // Prepare sentence length arrays
      const origLens = origSentences.map((s) => s.length);
      const newLens = newSentences.map((s) => s.length);

      let origPos = 0;
      let newPos = 0;

      let origSentIdx = 0;
      let newSentIdx = 0;

      let origSentEnd = origLens.length > 0 ? origLens[0] : 0;
      let newSentEnd = newLens.length > 0 ? newLens[0] : 0;

      for (const entry of d) {
        const op = entry[0];
        const txt = entry[1] || "";
        const len = txt.length;

        // Advance sentence pointers to ensure current positions are within bounds
        while (origSentIdx < origLens.length && origPos >= origSentEnd) {
          origSentIdx++;
          origSentEnd += origLens[origSentIdx] || 0;
        }
        while (newSentIdx < newLens.length && newPos >= newSentEnd) {
          newSentIdx++;
          newSentEnd += newLens[newSentIdx] || 0;
        }

        // Determine sentence indices for this diff
        let origIdxForThis;
        if (op === 1) {
          origIdxForThis = origSentIdx;
        } else if (origSentIdx < origLens.length) {
          origIdxForThis = origSentIdx;
        } else if (origLens.length > 0) {
          origIdxForThis = origLens.length - 1;
        } else {
          origIdxForThis = -1;
        }

        let newIdxForThis;
        if (op === -1) {
          newIdxForThis = newSentIdx;
        } else if (newSentIdx < newLens.length) {
          newIdxForThis = newSentIdx;
        } else if (newLens.length > 0) {
          newIdxForThis = newLens.length - 1;
        } else {
          newIdxForThis = -1;
        }

        annotated.push([op, txt, origIdxForThis, newIdxForThis]);

        // Advance positions
        if (op !== 1) {
          origPos += len;
        }
        if (op !== -1) {
          newPos += len;
        }
      }

      return annotated;
    }

    // Use TRIMMED text for sentence annotation to match the diff content.
    const annotatedDiffs = annotateDiffsWithSentenceIndices(
      expandedDiffs,
      text1Trimmed,
      text2Trimmed
    );

    return annotatedDiffs;

  };
}

Object.assign(TabMail, {
  /**
   * Creates a <br> element and, if showNewlines is true, tags it with the
   * `tm-nl` class so CSS can render the visual newline (⏎) via ::before.
   * @param {boolean} showNewlines Whether to visually mark the newline.
   * @returns {HTMLBRElement}
   */
  _createBrWithMarker(showNewlines) {
    const frag = document.createDocumentFragment();
    if (showNewlines) {
      const span = document.createElement("span");
      span.classList.add("tm-nl");
      // No text node inside; visual char rendered via ::after pseudo-element.
      span.contentEditable = "false";
      frag.appendChild(span);
    }
    const br = document.createElement("br");
    br.setAttribute("_moz_dirty", "");
    frag.appendChild(br);
    return frag;
  },

  /**
   * Shared function to render diffs to a document fragment.
   * This is the common rendering logic used by both renderText and _renderWithExistingDiffs.
   * 
   * @param {Array} diffs - The diffs to render
   * @param {boolean} show_diffs - Whether to show diffs
   * @param {boolean} show_newlines - Whether to show newlines
   * @returns {DocumentFragment} The fragment containing the rendered diffs
   */
  _renderDiffsToFragment: function(diffs, show_diffs, show_newlines) {
    const fragment = document.createDocumentFragment();
    let diffSeq = -1; // Running diff index for mapping spans to corresponding diff entry
    
    for (const diff of diffs) {
      diffSeq++;
      const op = diff[0];
      const text = diff[1];
      const sOrig = typeof diff[2] === "number" ? diff[2] : -1;
      const sNew = typeof diff[3] === "number" ? diff[3] : -1;

      if (!show_diffs && op === 1) {
        // When not showing diffs, completely ignore insert operations.
        continue;
      }

      if (!show_diffs || op === 0) {
        // For "equal" parts or when not showing diffs, don't wrap in spans.
        const parentNode = fragment;
        const subLines = text.split("\n");
        subLines.forEach((line, i) => {
          if (line) {
            parentNode.appendChild(document.createTextNode(line));
          }
          if (i < subLines.length - 1) {
            const br = TabMail._createBrWithMarker(show_newlines);
            parentNode.appendChild(br);
          }
        });
        continue; // Proceed to the next diff segment
      }

      // --- Span styling for Insert/Delete Spans ---
      const spanStyle = {};
      const spanDataset = {};
      switch (op) {
        case 1: // Insert
          spanDataset.tabmailDiff = "insert";
          spanStyle.backgroundColor = TabMail.config.getColor(TabMail.config.colors.insert.background);
          const insertTextColor = TabMail.config.getColor(TabMail.config.colors.insert.text);
          if (insertTextColor !== "inherit") {
            spanStyle.color = insertTextColor;
          }
          break;
        case -1: // Delete
          spanDataset.tabmailDiff = "delete";
          // No strikethrough - just background color to show what will be kept
          spanStyle.backgroundColor = TabMail.config.getColor(TabMail.config.colors.delete.background);
          const deleteTextColor = TabMail.config.getColor(TabMail.config.colors.delete.text);
          if (deleteTextColor !== "inherit") {
            spanStyle.color = deleteTextColor;
          }
          break;
      }
      // Attach diff index for later mapping back from DOM
      spanDataset.tabmailDiffIndex = diffSeq;
      // Attach sentence indices for debugging/logic
      spanDataset.tabmailSentenceOrig = String(sOrig);
      spanDataset.tabmailSentenceNew = String(sNew);

      // Finally, draw the span for insert/delete.
      const span = document.createElement("span");
      Object.assign(span.style, spanStyle);
      Object.assign(span.dataset, spanDataset);

      // The part might contain newlines, which need to be converted to <br>.
      const subLines = text.split("\n");
      subLines.forEach((line, i) => {
        if (line) {
          span.appendChild(document.createTextNode(line));
        }

        if (i < subLines.length - 1) {
          const br = TabMail._createBrWithMarker(show_newlines);
          span.appendChild(br);
        }
      });

      // Only append the span if it has content, preventing empty spans.
      if (span.hasChildNodes()) {
        fragment.appendChild(span);
      }
    }
    
    return fragment;
  },

  /**
   * Shared function to apply a fragment to the editor and handle cursor/highlighting.
   * This is the common logic used by both renderText and _renderWithExistingDiffs.
   * 
   * @param {DocumentFragment} fragment - The fragment to insert
   * @param {Range} rangeToReplace - The range to replace
   * @param {HTMLElement} editor - The editor element
   * @param {Node|null} quoteBoundaryNode - The quote boundary node, if any
   * @param {Array} diffs - The diffs that were rendered (for cursor mapping)
   * @param {number} originalCursorOffset - The cursor offset in original text
   * @param {boolean} show_diffs - Whether diffs are shown
   * @param {number} advanceCursorBy - Optional: advance cursor by this many chars (for special cases)
   */
  _applyFragmentToEditor: function(fragment, rangeToReplace, editor, quoteBoundaryNode, diffs, originalCursorOffset, show_diffs, advanceCursorBy = 0) {
    // Insert the fragment into the editor as a replacement for the original text.
    rangeToReplace.deleteContents();

    // After deleteContents, the range might be invalid. Recreate it to ensure valid offsets.
    rangeToReplace.selectNodeContents(editor);
    if (quoteBoundaryNode) {
      rangeToReplace.setEndBefore(quoteBoundaryNode);
    }

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
      const hasQuoteAfter = (isSig && TabMail._hasQuoteAfterNode)
        ? TabMail._hasQuoteAfterNode(editor, quoteBoundaryNode)
        : false;
      const brCount = (isSig && hasQuoteAfter) ? brCountSigWithQuoteAfter : brCountDefault;
      TabMail.log.debug('diff', "quoteSeparator(_applyFragmentToEditor)", {
        boundaryType: quoteBoundaryNode.tagName + (quoteBoundaryNode.className ? '.' + quoteBoundaryNode.className : ''),
        isSignature: isSig,
        hasQuoteAfter,
        brCount,
        show_diffs,
      });
      for (let i = 0; i < brCount; i++) {
        sep.appendChild(document.createElement("br"));
      }

      fragment.appendChild(sep);
    }

    rangeToReplace.insertNode(fragment);
    rangeToReplace.collapse(false); // Collapse range to the end

    // Move cursor to the correct position if showing diffs.
    let finalCursorOffset = -1;
    if (show_diffs) {
      // Map cursor offset from original text to diff view.
      finalCursorOffset = TabMail.mapCursorOffsetFromOriginalToDiffView(
        diffs,
        originalCursorOffset
      );
    } else {
      // Keep original cursor position.
      finalCursorOffset = originalCursorOffset;
    }
    
    // Advance cursor if requested (e.g., after consuming newline in special case)
    if (advanceCursorBy > 0) {
      finalCursorOffset += advanceCursorBy;
      TabMail.log.debug('autohideDiff', `Advanced cursor by ${advanceCursorBy} to position ${finalCursorOffset}`);
    }
    
    // Restrict traversal to user region only by passing quoteBoundaryNode
    TabMail.setCursorByOffset(editor, finalCursorOffset, quoteBoundaryNode);

    // Highlight the diff spans at the new cursor position.
    const targets = TabMail.findSpansByDiffsAndCursor(
      diffs,
      finalCursorOffset
    );
    TabMail.updateSpanHighlighting(targets);
  },

  /**
   * Filters diffs based on completion vs edit mode and cursor position.
   * Creates op=0 entries for filtered content to maintain text structure.
   * @param {Array<Array<number, string>>} diffs The computed diffs.
   * @param {string} originalText The original text.
   * @param {string} correctedText The corrected text.
   * @param {number} cursorPosition The current cursor position.
   * @returns {Object} Object containing suggestMode, filtered diffs, and suggested cursor position.
   */
  _filterDiffsForSuggestion(
    diffs,
    originalText,
    correctedText,
    cursorPosition
  ) {
    // Find the current sentence containing the cursor
    const sentences = TabMail.splitIntoSentences(originalText);
    const cursorSentenceIndex = TabMail.findSentenceContainingCursor(
      sentences,
      cursorPosition
    );

    // If we don't have the sentence index, we should treat it as a situation where we have an empty writeup.
    let sentenceStart = 0;
    let sentenceEnd = 0;
    let sentenceText = "";

    // Only if we have sentence index, we should get the sentence boundaries.
    if (cursorSentenceIndex !== -1) {
      sentenceStart = TabMail.getSentenceStartOffset(
        originalText,
        cursorSentenceIndex
      );
      sentenceEnd = sentenceStart + sentences[cursorSentenceIndex].length;
      sentenceText = sentences[cursorSentenceIndex];
    }

    // console.log("[TMDBG Filter] Sentence boundaries:", {
    //   sentenceIndex: cursorSentenceIndex,
    //   sentenceStart,
    //   sentenceEnd,
    //   sentenceText,
    // });

    // Filter diffs: show current sentence + consecutive inserts
    const filteredDiffs = [];
    let currentOffset = 0;
    let inConsecutiveInserts = false;
    let firstDiffPosition = -1;
    let disableCursorHinting = false;
    let numDiffsShown = 0;

    for (const diff of diffs) {
      const op = diff[0];
      const text = diff[1];

      // Calculate diff boundaries
      const diffStart = currentOffset;
      // Note for insert, the length is zero -- the insertion happens at the
      // location, but it does not take up any space in terms of the original
      // text.
      const diffEnd = diffStart + (op === 1 ? 0 : text.length);

      // Set the first diff position if we haven't found it yet
      if (firstDiffPosition === -1 && op !== 0) {
        firstDiffPosition = diffStart;
      }

      // Check if this diff is in the current sentence
      // Treat insertions that occur exactly at sentenceEnd as belonging to the
      // sentence so they can be accepted without moving the cursor.
      const isInCurrentSentence =
        (diffStart < sentenceEnd && diffEnd >= sentenceStart) ||
        (op === 1 && diffStart === sentenceEnd);

      // Check if we should show this diff
      let shouldShow = false;

      // console.log("[TMDBG Filter] Current diff status:", {
      //   op: op,
      //   text: text,
      //   diffStart: diffStart,
      //   diffEnd: diffEnd,
      //   isInCurrentSentence: isInCurrentSentence,
      //   inConsecutiveInserts: inConsecutiveInserts,
      //   numDiffsShown: numDiffsShown,
      //   disableCursorHinting: disableCursorHinting,
      //   sentenceStart: sentenceStart,
      //   sentenceEnd: sentenceEnd,
      //   sentenceText: sentenceText,
      // });

      if (isInCurrentSentence) {
        // Always show diffs within the current sentence
        shouldShow = true;
        // Disable cursor hinting if any diffs (op !== 0) are in the current sentence
        if (op !== 0) {
          disableCursorHinting = true;
        }
        // Set consecutive inserts flag to true if current op is an insert so that if our last diff in the sentence was an insert, we continue showing inserts afterwards.
        inConsecutiveInserts = op === 1;
      } else if (
        diffEnd === originalText.length &&
        numDiffsShown === 0 &&
        cursorSentenceIndex === sentences.length - 1 &&
        op === 1
      ) {
        // If (1) we're at the end of the original text, (2) our selected
        // sentence is the last sentence, and (3) we've not shown any diffs
        // yet, we should behave as if we're in a consecutive insert situation.
        shouldShow = true;
        // Also set the flag to true just in case.
        inConsecutiveInserts = true;
        // Also disable cursor hinting -- we are still completing the last sentence.
        disableCursorHinting = true;
      } else if (inConsecutiveInserts && op === 1) {
        // After current sentence, if we still have the consecutive inserts
        // flag (this means last diff in sentence was an insert), show the insert
        shouldShow = true;
        // Also disable cursor hinting -- we are still completing the last sentence.
        disableCursorHinting = true;
      } else {
        // In all other cases, we ran into the end of the diffs that we should show.
        shouldShow = false;
        inConsecutiveInserts = false;
      }

      if (shouldShow) {
        // Show the diff as-is
        filteredDiffs.push(diff);
        if (op !== 0) {
          numDiffsShown++;
        }
      } else {
        // Convert to equal (op=0) to hide the diff if it's not an insert
        if (op !== 1) {
          // Sanitize sentence indices – enforce numbers; log if unexpected
          let sOrig = diff[2];
          let sNew = diff[3];
          if (typeof sOrig !== "number" || typeof sNew !== "number") {
            try {
              console.warn("[TabMail Diff] Non-numeric sentence indices encountered in filtering; coercing.", {
                sOrigType: typeof sOrig,
                sNewType: typeof sNew,
                diff: diff,
              });
            } catch (_) {}
          }
          sOrig = typeof sOrig === "number" ? sOrig : -1;
          sNew = typeof sNew === "number" ? sNew : -1;
          filteredDiffs.push([0, text, sOrig, sNew]);
        }
        // Note: for op===1 (insert), we don't add, which causes it to be dropped from render.
      }

      // Update offset for next iteration (note we only count based on original
      // text, not the diffs)
      if (op === 0 || op === -1) {
        // Equal or delete
        currentOffset += text.length;
      }
    }

    // console.log("[TMDBG Filter] Filtering result:", {
    //   originalDiffsCount: diffs.length,
    //   filteredDiffsCount: filteredDiffs.length,
    //   firstDiffPosition: firstDiffPosition,
    //   inConsecutiveInserts: inConsecutiveInserts,
    //   numDiffsShown: numDiffsShown,
    //   disableCursorHinting: disableCursorHinting,
    //   sentenceStart: sentenceStart,
    //   sentenceEnd: sentenceEnd,
    //   sentenceText: sentenceText,
    // });

    return {
      diffs: filteredDiffs,
      firstDiffPosition: firstDiffPosition,
      disableCursorHinting: disableCursorHinting,
    };
  },

  /**
   * Renders the differences between the original and corrected text in the editor.
   * This version isolates the user-written content from quotes and signatures to
   * prevent an accidental modification of those sections. It now fetches the
   * original text from the editor directly and corrected text from the state
   * to prevent synchronization issues. It also blocks user input during rendering.
   * @param {boolean} show_diffs Whether to show the diffs -- if false, we render the original text.
   */
  renderText: function (
    show_diffs = true,
    show_newlines = true,
    force = false
  ) {
    if (TabMail.state && TabMail.state.inlineEditActive && !force) {
      TabMail.log.debug('diff', "renderText suppressed (inlineEditActive)");
      return;
    }
    // During pre-send cleanup, suppress any non-forced renders that would show
    // diffs. This prevents transient delete/insert spans from flashing right
    // as Thunderbird snapshots the compose DOM.
    if (TabMail.state && TabMail.state.beforeSendCleanupActive && !force && show_diffs) {
      TabMail.log.debug('diff', "renderText suppressed (beforeSendCleanupActive)", {
        show_diffs,
        show_newlines,
        autoHideDiff: TabMail.state.autoHideDiff,
        isDiffActive: TabMail.state.isDiffActive,
      });
      return;
    }
    // Begin programmatic selection block – suppress `selectionchange` side-effects.
    TabMail._beginProgrammaticSelection();

    // Block user input to prevent changes during rendering.
    TabMail.state.editorRef.contentEditable = "false";

    // Variables to store the user content and corrected text.
    let userContentOriginal = null;
    let userContentCorrected = null;
    let originalCursorOffset = null;
    let diffsToRender = null;
    let updateLastRenderedState = false;

    try {
      // Skip rendering while an IME composition is active to avoid interfering with user input.
      // However, allow hiding diffs during IME composition to prevent interference.
      // Force flag can override this check for specific cases like compositionstart.
      if (TabMail.state.isIMEComposing && !force) {
        console.log(
          "[TabMail] renderText skipped during IME composition (showing diffs)."
        );
        return;
      }

      // Ensure we have an editor reference.
      if (!TabMail.state.editorRef) {
        console.warn("[TabMail] renderText called without editor reference.");
        return;
      }

      // --- Get original text directly from the editor ---
      const { originalUserMessage: originalText, quoteBoundaryNode } =
        TabMail.extractUserAndQuoteTexts(TabMail.state.editorRef);

      // console.log("[TabMail renderText] Extracted from DOM:", {
      //   originalTextLength: originalText.length,
      //   hasQuoteBoundary: !!quoteBoundaryNode,
      //   endsWithNewline: originalText.endsWith("\n"),
      //   endsWithDoubleNewline: originalText.endsWith("\n\n"),
      //   trailingNewlines: (originalText.match(/\n*$/) || [""])[0].length,
      //   lastChars: JSON.stringify(originalText.slice(-20)),
      // });

      // --- Get corrected text from state ---
      const correctedText = TabMail.state.correctedText || originalText;

      // Get cursor position before we start rendering.
      originalCursorOffset = TabMail.getCursorOffsetIgnoringInserts(
        TabMail.state.editorRef
      );

      userContentOriginal = originalText;
      userContentCorrected = correctedText;

      // If the last rendered state is the same as the current state,
      // we can early return.
      if (
        TabMail.state.lastRenderedText &&
        TabMail.state.lastRenderedText.original === userContentOriginal &&
        TabMail.state.lastRenderedText.corrected === userContentCorrected &&
        TabMail.state.lastRenderedText.show_diffs === show_diffs &&
        TabMail.state.lastRenderedText.show_newlines === show_newlines &&
        TabMail.state.lastRenderedText.originalCursorOffset ===
          originalCursorOffset
      ) {
        // console.log("[TabMail] Skipping render due to last rendered state.");
        return;
      }
      // else if (TabMail.state.lastRenderedText) {
      //   console.log("[TabMail] Rendering diffs.");
      //   console.log(
      //     "[TabMail] lastRenderedText:",
      //     TabMail.state.lastRenderedText
      //   );
      //   console.log("[TabMail] userContentOriginal:", userContentOriginal);
      //   console.log("[TabMail] userContentCorrected:", userContentCorrected);
      //   console.log("[TabMail] show_diffs:", show_diffs);
      //   console.log("[TabMail] show_newlines:", show_newlines);
      //   console.log("[TabMail] originalCursorOffset:", originalCursorOffset);
      // }

      // --- Range-based replacement strategy ---
      const rangeToReplace = document.createRange();
      rangeToReplace.selectNodeContents(TabMail.state.editorRef);
      if (quoteBoundaryNode) {
        rangeToReplace.setEndBefore(quoteBoundaryNode);
      }

      // Below we actually start rendering, so we should update the last rendered state upon completion.
      updateLastRenderedState = true;

      // Compute the diffs. Prefer jsdiff (word-level, friendlier) if it is loaded;
      // otherwise fall back to diff-match-patch. We map jsdiff output into the
      // same triplet format expected downstream: [op, text] where op ∈ {-1, 0, 1}.
      const diffs = TabMail.computeDiff(
        userContentOriginal,
        userContentCorrected,
        originalCursorOffset
      );

      // === Debug logging for diff computation ===
      if (TabMail.config.diffLogDebug) {
        console.groupCollapsed("[TabMail] Diff Debug");
        console.debug("[TabMail] diffEngine:", TabMail.config.diffEngine);
        console.debug(
          "[TabMail] originalUserMessage:",
          JSON.stringify(userContentOriginal)
        );
        console.debug(
          "[TabMail] correctedText:",
          JSON.stringify(userContentCorrected)
        );
        try {
          // Diff entries coming from diff-match-patch may be array-likes rather than
          // true Arrays, so destructuring can fail.  Convert defensively:
          console.table(
            diffs.map((d) => {
              let op, txt, sOrig = undefined, sNew = undefined;
              if (Array.isArray(d)) {
                op = d[0];
                txt = d[1];
                sOrig = d[2];
                sNew = d[3];
              } else if (d && typeof d === "object") {
                // Support objects like {0: -1, 1: "text"}
                op = d[0] ?? d.op ?? d.operation ?? "??";
                txt = d[1] ?? d.text ?? "";
              }
              return { op, sOrig, sNew, txt: JSON.stringify(txt) };
            })
          );
        } catch (e) {
          console.warn("[TabMail] Unable to render diff table", e);
          console.log(diffs);
        }
        console.groupEnd();
      }
      // === End debug logging ===

      // Filter diffs based on completion vs edit mode
      const suggestionResult = TabMail._filterDiffsForSuggestion(
        diffs,
        userContentOriginal,
        userContentCorrected,
        originalCursorOffset
      );

      // console.log("[TabMail] Diff filtering result:", {
      //   diffsCount: diffs.length,
      //   filteredDiffsCount: suggestionResult.diffs.length,
      //   firstDiffPosition: suggestionResult.firstDiffPosition,
      //   originalCursorPosition: originalCursorOffset,
      //   disableCursorHinting: suggestionResult.disableCursorHinting,
      // });

      // Display cursor hinting according to the filtering result.
      if (suggestionResult.disableCursorHinting) {
        // Remove any existing visual indicators when cursor hinting is disabled
        const existingCaret =
          TabMail.state.editorRef.querySelector(".tm-fake-caret");
        const existingArrow =
          TabMail.state.editorRef.querySelector(".tm-cursor-arrow");
        if (existingCaret) {
          console.log(
            "[TabMail] Removing existing caret due to disableCursorHinting"
          );
          existingCaret.remove();
        }
        if (existingArrow) {
          console.log(
            "[TabMail] Removing existing arrow due to disableCursorHinting"
          );
          existingArrow.remove();
        }
      } else if (suggestionResult.firstDiffPosition !== -1) {
        // console.log(
        //   "[TabMail] Showing cursor movement tooltip at position:",
        //   suggestionResult.firstDiffPosition
        // );
        // Check if we should show a tooltip instead of rendering diffs
        TabMail.showCursorMovementTooltip(
          TabMail.state.editorRef,
          suggestionResult.firstDiffPosition,
          originalCursorOffset
        );
        // TODO: If our tooltip that we show
        // (suggestionResult.firstDiffPosition) is out of current view (ie, we
        // have to scroll to see it), we should render something like "Press
        // tab to jump <up/down arrow>"
      }
      diffsToRender = suggestionResult.diffs;

      // Create a fragment with the diffs rendered as spans with colors.
      const fragment = TabMail._renderDiffsToFragment(diffsToRender, show_diffs, show_newlines);

      // Apply the fragment to the editor and handle cursor/highlighting
      TabMail._applyFragmentToEditor(
        fragment,
        rangeToReplace,
        TabMail.state.editorRef,
        quoteBoundaryNode,
        diffsToRender,
        originalCursorOffset,
        show_diffs,
        0 // No cursor advancement for renderText
      );

      // Record the state of the diff rendering.
      if (show_diffs) {
        TabMail.state.isDiffActive = true;
      } else {
        TabMail.state.isDiffActive = false;
      }
    } finally {
      // Re-enable editing.
      TabMail.state.editorRef.contentEditable = "true";

      // Store last rendered state.
      if (updateLastRenderedState) {
        TabMail.state.lastRenderedText = {
          original: userContentOriginal,
          corrected: userContentCorrected,
          diffs: diffsToRender,
          show_diffs: show_diffs,
          show_newlines: show_newlines,
          originalCursorOffset: originalCursorOffset,
        };
      }

      // End programmatic selection block – schedule un-mute.
      TabMail._endProgrammaticSelection();
    }
  },
});
