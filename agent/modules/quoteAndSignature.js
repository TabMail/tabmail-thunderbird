// Quote and Signature detection for TabMail (Thunderbird MV3).
//
// IMPORTANT:
// - This file intentionally contains NO `import` / `export` so it can be loaded as:
//   - a content script (classic script) in message display windows, and
//   - a side-effect module import from MV3 background scripts / ESM modules.
// - We attach a single global: `globalThis.TabMailQuoteDetection`.
//
// Used by:
// - agent/modules/utils.js (extractUserWrittenContent)
// - theme/modules/messageBubble.js (quote collapse)

(function () {
  const g = typeof globalThis !== "undefined" ? globalThis : this;

  if (g.TabMailQuoteDetection) {
    return;
  }

  // ---------------------------------------------------------------------------
  // CONFIGURATION — Tune these values here; agent + theme stay in sync
  // ---------------------------------------------------------------------------
  const config = {
    // Plain-text detection: how many lines ahead to scan for lookahead patterns
    // (e.g., dash separator needs From:/보낸 사람: in next N lines)
    lookaheadLines: 5,

    // Outlook header block detection: how many lines to scan for Sent/To/Subject
    outlookHeaderScanMaxLines: 10,

    // Outlook/Thunderbird header block detection: how many lines *backwards* to scan from "From:"
    // to find "Subject:" when Thunderbird renders "moz-header-part1" tables where Subject precedes From.
    outlookHeaderScanBackScanMaxLines: 5,

    // Two-line attribution detection ("On ...\nName <email> wrote:")
    // How many lines ahead to scan for the "wrote:" line (skipping blanks).
    twoLineAttributionScanMaxLines: 5,

    // Dash-separator lookahead: require multiple header-label hits to avoid false positives
    // from signature separators that happen to contain a single "From:"-like line.
    dashSeparatorLookaheadMinHits: 2,

    // DOM marker classnames (used by theme CSS for invisibility + reuse checks)
    dom: {
      quoteBoundaryMarkerClass: "tm-quote-boundary-marker",
      signatureBoundaryMarkerClass: "tm-signature-boundary-marker",
    },
  };

  // ---------------------------------------------------------------------------
  // REPLY BOUNDARY PATTERNS — Single source of truth
  // ---------------------------------------------------------------------------
  //
  // This is THE list to edit when adding new quote/reply boundary patterns.
  // Each entry describes:
  //   - pattern: regex to match (tested against trimmed line, or raw if useRaw=true)
  //   - type: the boundary type string returned when matched
  //   - comment: what email client / scenario this handles
  //   - forwardOnly: if true, only matches when includeForward option is true
  //   - lookahead: if set, requires one of these patterns in the next N lines (uses config.lookaheadLines)
  //   - multiLineCheck: if set, a function(lines, i, config) that returns true if context matches
  //   - eatBlankLinesBefore: how many preceding blank/whitespace lines to include (default 0)
  //   - useRaw: if true, test against raw line (not trimmed) - useful for ">" detection
  //
  // The detector iterates this list top-to-bottom and collects all matches,
  // then returns the EARLIEST (topmost) boundary in the document.
  // ---------------------------------------------------------------------------

  const replyBoundaryPatterns = [
    // =========================================================================
    // FORWARDED MESSAGE DELIMITERS
    // =========================================================================
    {
      pattern: /^-+\s*Forwarded Message\s*-+$/i,
      type: "forwarded-message",
      comment: "Thunderbird: '-------- Forwarded Message --------'",
      forwardOnly: true,
      eatBlankLinesBefore: 1,
    },

    // =========================================================================
    // ORIGINAL MESSAGE DELIMITERS (reply headers)
    // =========================================================================
    {
      pattern: /^-+\s*Original Message\s*-+\s*$/i,
      type: "original-message",
      comment: "Outlook: '-----Original Message-----'",
      eatBlankLinesBefore: 1,
    },

    // =========================================================================
    // HORIZONTAL RULE / DASH SEPARATORS (require sender header lookahead)
    // =========================================================================
    {
      pattern: /^-{10,}\s*$/,
      type: "dash-separator",
      comment: "Long dash line (72+ dashes) followed by From:/보낸 사람: etc — Outlook/Korean clients",
      eatBlankLinesBefore: 1,
      lookahead: [
        /^\*?From\s*:\*?\s*/i,                    // English: From:
        /^\*?Sent\s*:\*?\s*/i,                    // English: Sent:
        /^\*?(보낸\s*사람|보낸\s*날짜)\s*:\*?\s*/i, // Korean: 보낸 사람: / 보낸 날짜:
        /^\*?(받는\s*사람|제목)\s*:\*?\s*/i,       // Korean: 받는 사람: / 제목:
      ],
    },

    // =========================================================================
    // SENDER HEADER LINES (standalone, e.g. bold Korean headers)
    // =========================================================================
    {
      pattern: /^\*?(보낸\s*사람)\s*:\*?\s*/i,
      type: "localized-sender",
      comment: "Korean bold sender: *보낸 사람:* (standalone, no preceding dash line)",
      eatBlankLinesBefore: 0,
    },
    {
      pattern: /^\*?(보낸\s*날짜)\s*:\*?\s*/i,
      type: "localized-sender",
      comment: "Korean bold date: *보낸 날짜:* (standalone)",
      eatBlankLinesBefore: 0,
    },

    // =========================================================================
    // OUTLOOK HEADER BLOCK (From: + Sent/To/Subject nearby)
    // =========================================================================
    {
      pattern: /^From:\s*/i,
      type: "outlook-headers",
      comment: "Outlook header block: 'From:' followed by (Sent: or Date:)/To/Subject within N lines (Outlook desktop vs Outlook mobile)",
      eatBlankLinesBefore: 0,
      multiLineCheck: function (lines, i, cfg) {
        // Look for (Sent OR Date), To, Subject near the "From:" line.
        //
        // Forward scan: standard Outlook blocks have Subject after From.
        // Backward scan: Thunderbird "moz-header-part1/2" blocks often have Subject *before* From.
        //
        // Outlook mobile uses "Date:" instead of "Sent:" in the reference-message header block.
        let sawSentOrDate = false,
          sawTo = false,
          sawSubject = false;

        const forwardEnd = Math.min(lines.length, i + cfg.outlookHeaderScanMaxLines);
        for (let j = i; j < forwardEnd; j++) {
          const l = _stripQuotePrefix(String(lines[j] || "").trim());
          if (/^(Sent|Date):\s*/i.test(l)) sawSentOrDate = true;
          if (/^To:\s*/i.test(l)) sawTo = true;
          if (/^Subject:\s*/i.test(l)) sawSubject = true;
        }

        // If Subject wasn't found ahead, scan a small window backward from the From: line.
        // This is needed for Thunderbird's "moz-header-part1" rendering.
        if (!sawSubject) {
          const backMax = cfg.outlookHeaderScanBackScanMaxLines ?? config.outlookHeaderScanBackScanMaxLines;
          const backStart = Math.max(0, i - Math.max(0, backMax));
          for (let j = i - 1; j >= backStart; j--) {
            const l = _stripQuotePrefix(String(lines[j] || "").trim());
            if (/^Subject:\s*/i.test(l)) {
              sawSubject = true;
              break;
            }
          }
        }

        return sawSentOrDate && sawTo && sawSubject;
      },
    },

    // =========================================================================
    // ATTRIBUTION LINES ("On ... wrote:")
    // =========================================================================
    {
      pattern: /^On\s+.+$/i,
      type: "attribution",
      comment:
        "Two-line English attribution: 'On Tue, 6 Jan 2026 ...' then next non-empty line ends with 'wrote:' (mailing lists / plain-text replies)",
      eatBlankLinesBefore: 1,
      multiLineCheck: function (lines, i, cfg) {
        try {
          const firstLine = _stripQuotePrefix(String((lines[i] || "")).trim());
          // If the first line already contains "wrote:", let the single-line rule handle it.
          if (/wrote:\s*$/i.test(firstLine)) return false;

          const max = Math.min(lines.length, i + (cfg.twoLineAttributionScanMaxLines || config.twoLineAttributionScanMaxLines) + 1);
          for (let j = i + 1; j < max; j++) {
            const nextLine = _stripQuotePrefix(String((lines[j] || "")).trim());
            if (!nextLine) continue; // skip blank lines
            return /wrote:\s*$/i.test(nextLine);
          }
          return false;
        } catch (_) {
          return false;
        }
      },
    },
    {
      pattern: /^On\s+.+\s+wrote:\s*$/i,
      type: "attribution",
      comment: "English attribution: 'On Mon, Jan 1, 2024 at 10:00 AM John wrote:'",
      eatBlankLinesBefore: 1,
    },
    {
      pattern: /^Am\s+.+\s+schrieb\s+.+:\s*$/i,
      type: "attribution",
      comment: "German attribution: 'Am 1. Januar 2024 schrieb Max:'",
      eatBlankLinesBefore: 1,
    },
    {
      pattern: /^Le\s+.+\s+a\s+écrit\s*:\s*$/i,
      type: "attribution",
      comment: "French attribution: 'Le 1 janvier 2024, Jean a écrit :'",
      eatBlankLinesBefore: 1,
    },
    {
      pattern: /^El\s+.+\s+escribió\s*:\s*$/i,
      type: "attribution",
      comment: "Spanish attribution: 'El 1 de enero de 2024, Juan escribió:'",
      eatBlankLinesBefore: 1,
    },
    {
      pattern: /^Il\s+.+\s+ha\s+scritto\s*:\s*$/i,
      type: "attribution",
      comment: "Italian attribution: 'Il 1 gennaio 2024, Giovanni ha scritto:'",
      eatBlankLinesBefore: 1,
    },
    {
      pattern: /^Em\s+.+\s+.+\s+escreveu\s*:\s*$/i,
      type: "attribution",
      comment: "Portuguese attribution: 'Em 1 de janeiro de 2024, João escreveu:'",
      eatBlankLinesBefore: 1,
    },
    {
      pattern: /^.+님이\s*작성\s*:\s*$/,
      type: "attribution",
      comment: "Korean Gmail attribution: '2026년 1월 22일 (목) AM 4:23, Name <email>님이 작성:'",
      eatBlankLinesBefore: 1,
    },

    // =========================================================================
    // QUOTED LINES (lines starting with ">")
    // =========================================================================
    {
      pattern: /^>/,
      type: "quoted",
      comment: "Standard quote marker: lines starting with '>'",
      useRaw: true, // Don't trim — we want to detect "> " at line start
      eatBlankLinesBefore: 0,
      fallbackOnly: true, // Only use if no stronger reply/original-message boundary was found
    },
  ];

  // Signature delimiter (RFC-ish convention) — kept separate as it's not a reply boundary
  const signatureDelimiterLine = /^--\s*$/;

  // ---------------------------------------------------------------------------
  // DERIVED HELPER ARRAYS — Used by DOM detection for lookahead matching
  // These are derived from replyBoundaryPatterns to avoid duplication.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // DERIVED PATTERNS — Extracted from replyBoundaryPatterns for DOM detection
  // ---------------------------------------------------------------------------

  // Dash separator line pattern (for DOM text node detection)
  const dashSeparatorLine = (function () {
    const entry = replyBoundaryPatterns.find((e) => e.type === "dash-separator");
    return entry ? entry.pattern : /^-{10,}\s*$/;
  })();

  // Extract sender header patterns from the dash-separator entry's lookahead
  const senderHeaderPatterns = (function () {
    const entry = replyBoundaryPatterns.find((e) => e.type === "dash-separator");
    return entry && entry.lookahead ? entry.lookahead : [];
  })();

  // Extract attribution patterns from the main list
  const attributionPatterns = replyBoundaryPatterns
    .filter((e) => e.type === "attribution")
    .map((e) => e.pattern);

  // Expose patterns for observability/debugging
  const patterns = {
    replyBoundaryPatterns,
    signatureDelimiterLine,
    // Derived helpers for DOM detection
    dashSeparatorLine,
    senderHeaderLines: senderHeaderPatterns,
    attributionLines: attributionPatterns,
  };

  function _splitLinesWithCharOffsets(text) {
    const src = String(text || "");
    const lines = src.split(/\r?\n/);

    // Compute start char offset for each line in the *original* string.
    // Note: we assume '\n' as separator length 1 when reconstructing offsets
    // because we split on /\r?\n/. This is fine for splitText usage: the index
    // refers to the JS string's character indices, and the original string still
    // contains either '\n' or '\r\n'. For '\r\n', our offsets will point to the
    // '\r' of the separator; in practice, boundaries occur at line starts.
    const startOffsets = [];
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      startOffsets.push(pos);
      pos += lines[i].length + 1; // +1 for '\n' (approx)
    }
    return { src, lines, startOffsets };
  }

  function _stripQuotePrefix(s) {
    // Strip one or more leading quote prefixes like:
    //   "> ", ">>", ">    "
    // This helps detect reply markers inside quoted blocks: "> -----Original Message-----", "> From:", etc.
    return String(s || "").replace(/^(?:>\s*)+/, "");
  }

  /**
   * Find the reply/quote boundary in a plain-text email body.
   * Iterates `replyBoundaryPatterns` (single source of truth) and returns the earliest match.
   *
   * @param {string} text
   * @param {{ includeForward?: boolean }} [opts] - Options. includeForward defaults to true for agent use.
   * @returns {{ lineIndex: number, charIndex: number, type: string, eatBlankLinesBefore?: number }|null}
   */
  function findBoundaryInPlainText(text, opts = {}) {
    const includeForward = opts.includeForward !== false; // Default true
    const { src, lines, startOffsets } = _splitLinesWithCharOffsets(text);
    if (!src || !src.trim()) return null;

    // Collect all candidate boundaries with their line indices.
    // We treat some patterns as fallback-only (e.g. bare "^>") so they don't mask stronger reply headers.
    const candidates = [];
    const fallbackCandidates = [];

    for (let i = 0; i < lines.length; i++) {
      const lineTrimmed = (lines[i] || "").trim();
      const lineRaw = lines[i] || "";
      const lineNoQuotePrefix = _stripQuotePrefix(lineTrimmed);

      // Iterate the unified replyBoundaryPatterns list
      for (const entry of replyBoundaryPatterns) {
        try {
          // Skip forward-only patterns if includeForward is false
          if (entry.forwardOnly && !includeForward) continue;

          // Choose which line to test (trimmed or raw)
          // For most patterns, strip quote prefixes so we can detect "> From:" / "> -----Original Message-----".
          const testLine = entry.useRaw ? lineRaw.trimStart() : lineNoQuotePrefix;

          // Test the pattern
          if (!entry.pattern.test(testLine)) continue;

          // If lookahead is required, check that one of the lookahead patterns matches in next N lines
          let matchedLookaheadLineIndex = null;
          if (entry.lookahead && entry.lookahead.length > 0) {
            const lookAheadMax = Math.min(lines.length, i + config.lookaheadLines);
            let found = false;
            const matchedPatternIdx = new Set();
            for (let j = i + 1; j < lookAheadMax; j++) {
              const nextLine = _stripQuotePrefix((lines[j] || "").trim());
              if (!nextLine) continue; // skip blank
              for (let pIdx = 0; pIdx < entry.lookahead.length; pIdx++) {
                const laPattern = entry.lookahead[pIdx];
                if (laPattern.test(nextLine)) {
                  matchedPatternIdx.add(pIdx);
                  if (!found) {
                    found = true;
                    matchedLookaheadLineIndex = j;
                  }
                }
              }
            }

            // For dash separators, require multiple distinct header-label hits.
            // This avoids matching signature separators that contain a single "From:"-like line.
            if (entry.type === "dash-separator") {
              const minHits = config.dashSeparatorLookaheadMinHits;
              const ok = matchedPatternIdx.size >= minHits;
              try {
                console.log(
                  `[TabMailQuoteDetection] dash-separator lookahead: firstHeaderLine=${matchedLookaheadLineIndex} distinctHits=${matchedPatternIdx.size} minHits=${minHits} ok=${ok}`
                );
              } catch (_) {}
              if (!ok) continue;
            }

            if (!found) continue; // Lookahead failed, skip this match
          }

          // If multiLineCheck is required, run it
          if (entry.multiLineCheck && typeof entry.multiLineCheck === "function") {
            if (!entry.multiLineCheck(lines, i, config)) continue;
          }

          const entryRec = {
            // Keep boundary at the separator line so the separator is included in the collapsed quote.
            lineIndex: i,
            charIndex: startOffsets[i],
            type: entry.type,
            eatBlankLinesBefore: entry.eatBlankLinesBefore || 0,
          };
          // Pattern matched!
          if (entry.fallbackOnly) {
            fallbackCandidates.push(entryRec);
          } else {
            candidates.push(entryRec);
          }
        } catch (_) {
          // Ignore pattern errors
        }
      }
    }

    // Return the earliest candidate (lowest lineIndex)
    const chosenList = candidates.length > 0 ? candidates : fallbackCandidates;
    if (chosenList.length === 0) return null;
    chosenList.sort((a, b) => a.lineIndex - b.lineIndex);
    return chosenList[0];
  }

  /**
   * Split plain text into main vs quote vs signature parts.
   * Uses findQuoteRegion() to properly handle: quote from top, signature from bottom.
   *
   * @param {string} text
   * @param {{ includeForward?: boolean }} [opts] - Options. includeForward defaults to true.
   * @returns {{ main: string, quote: string, signature: string, boundaryType: string|null }}
   */
  function splitPlainTextForQuote(text, opts = {}) {
    try {
      const src = String(text || "");
      if (!src.trim()) return { main: "", quote: "", signature: "", boundaryType: null };

      const region = findQuoteRegion(src, opts);
      if (!region) {
        return { main: src.trimEnd(), quote: "", signature: "", boundaryType: null };
      }

      const lines = src.split(/\r?\n/);
      const main = lines.slice(0, region.quoteStartLine).join("\n").trimEnd();
      const quote = lines.slice(region.quoteStartLine, region.quoteEndLine).join("\n").trim();
      const signature = lines.slice(region.quoteEndLine).join("\n").trim();

      return { main, quote, signature, boundaryType: region.boundaryType };
    } catch (_) {
      return { main: String(text || ""), quote: "", signature: "", boundaryType: null };
    }
  }

  /**
   * Signature delimiter detection ("-- " on its own line).
   * @param {string} line
   */
  function isSignatureDelimiterLine(line) {
    return patterns.signatureDelimiterLine.test(String(line || "").trim());
  }

  /**
   * Check if a text blob contains a signature delimiter on a line.
   * @param {string} text
   */
  function textContainsSignatureDelimiter(text) {
    const src = String(text || "");
    if (!src) return false;
    const lines = src.split(/\r?\n/);
    for (const l of lines) {
      if (isSignatureDelimiterLine(l)) return true;
    }
    return false;
  }

  /**
   * Ensure a stable boundary element for a quote boundary found within a TEXT_NODE.
   * We create a marker <span> immediately before the matched substring.
   *
   * @param {Text} textNode
   * @param {number} matchIndex
   * @param {string} boundaryType
   * @returns {Element|null}
   */
  function ensureQuoteBoundaryMarkerForTextMatch(textNode, matchIndex, boundaryType) {
    try {
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return null;
      const parent = textNode.parentNode;
      if (!parent) return null;

      // Reuse an existing marker if it's already right before this node.
      const prev = textNode.previousSibling;
      if (
        prev &&
        prev.nodeType === Node.ELEMENT_NODE &&
        prev.classList &&
        prev.classList.contains(config.dom.quoteBoundaryMarkerClass)
      ) {
        return prev;
      }

      let boundaryTextNode = textNode;
      if (typeof matchIndex === "number" && matchIndex > 0) {
        boundaryTextNode = textNode.splitText(matchIndex);
      }

      const marker = document.createElement("span");
      marker.className = config.dom.quoteBoundaryMarkerClass;
      marker.setAttribute("data-tabmail-quote-boundary", "1");
      if (boundaryType) {
        marker.setAttribute("data-tabmail-quote-boundary-type", String(boundaryType));
      }
      parent.insertBefore(marker, boundaryTextNode);

      console.log("[TabMailQuoteDetection] Inserted quote boundary marker for type:", boundaryType || "unknown");
      return marker;
    } catch (e) {
      console.error("[TabMailQuoteDetection] ensureQuoteBoundaryMarkerForTextMatch error:", e);
      return null;
    }
  }

  /**
   * Check if a line is inside quoted content (starts with > after stripping whitespace).
   * @param {string} line
   * @returns {boolean}
   */
  function isInsideQuotedBlock(line) {
    const trimmed = String(line || "").trimStart();
    return trimmed.startsWith(">");
  }

  /**
   * Find the LAST signature delimiter from the bottom of the text.
   * Only finds signatures that are NOT inside quoted content (lines starting with >).
   * This is the signature we want to preserve (not collapse).
   * @param {string} text
   * @param {{ afterLine?: number }} [opts] - Only consider signatures after this line index
   * @returns {{ lineIndex: number, charIndex: number }|null}
   */
  function findLastSignatureFromBottom(text, opts = {}) {
    const { src, lines, startOffsets } = _splitLinesWithCharOffsets(text);
    if (!src || !src.trim()) return null;

    const afterLine = opts.afterLine ?? -1;

    // Scan from bottom to top, find last occurrence of signature delimiter
    // that is NOT inside a quoted block (line starting with >)
    for (let i = lines.length - 1; i >= 0; i--) {
      // Skip lines before the quote start (if specified)
      if (i <= afterLine) continue;

      const rawLine = lines[i] || "";
      const trimmedLine = rawLine.trim();
      
      // Skip if this line is inside a quoted block
      if (isInsideQuotedBlock(rawLine)) continue;
      
      if (isSignatureDelimiterLine(trimmedLine)) {
        return { lineIndex: i, charIndex: startOffsets[i] };
      }
    }
    return null;
  }

  /**
   * Find the quote region to collapse:
   * - From: first reply/original message boundary (NOT forward)
   * - Until: last signature that is NOT inside quoted content (lines starting with >),
   *          or end of message if no such signature exists
   * 
   * @param {string} text
   * @param {{ includeForward?: boolean }} [opts] - Options passed to findBoundaryInPlainText
   * @returns {{ quoteStartLine: number, quoteEndLine: number, quoteStartChar: number, quoteEndChar: number, boundaryType: string }|null}
   */
  function findQuoteRegion(text, opts = {}) {
    const { src, lines, startOffsets } = _splitLinesWithCharOffsets(text);
    if (!src || !src.trim()) return null;

    // Find the first quote boundary (reply/original message).
    // NOTE: includeForward defaults to TRUE here (for agent use - extracting user-written content).
    // For DOM/display collapse, callers should pass { includeForward: false } or use findQuoteBoundaryByText.
    const quoteBoundary = findBoundaryInPlainText(src, opts);
    if (!quoteBoundary) return null;

    // Find the last signature that is NOT inside quoted content and is AFTER the quote start
    const lastSig = findLastSignatureFromBottom(src, { afterLine: quoteBoundary.lineIndex });

    // Quote ends at:
    // - Just before the last non-quoted signature (if it exists after quote start)
    // - Or end of text (if no such signature exists)
    let quoteEndLine = lines.length;
    let quoteEndChar = src.length;

    if (lastSig && lastSig.lineIndex > quoteBoundary.lineIndex) {
      quoteEndLine = lastSig.lineIndex;
      quoteEndChar = startOffsets[lastSig.lineIndex];
    }

    return {
      quoteStartLine: quoteBoundary.lineIndex,
      quoteEndLine: quoteEndLine,
      quoteStartChar: quoteBoundary.charIndex,
      quoteEndChar: quoteEndChar,
      boundaryType: quoteBoundary.type,
    };
  }

  // ---------------------------------------------------------------------------
  // PURE TEXT-BASED QUOTE DETECTION FOR DOM
  // DOM text extraction is NOT reliable via `textContent` (it often omits line breaks for <br>/<div>/<p>).
  // We build a "detection text" that explicitly inserts '\n' at <br> and common block boundaries,
  // and we keep a segment map so we can translate char offsets back into (Text node, offset).
  // ---------------------------------------------------------------------------
  
  function _isBlockElementTag(tag) {
    const t = String(tag || "").toUpperCase();
    return (
      t === "DIV" ||
      t === "P" ||
      t === "TR" ||
      t === "TD" ||
      t === "TH" ||
      t === "LI" ||
      t === "UL" ||
      t === "OL" ||
      t === "TABLE" ||
      t === "TBODY" ||
      t === "THEAD" ||
      t === "TFOOT" ||
      t === "BLOCKQUOTE" ||
      t === "PRE" ||
      t === "HR"
    );
  }

  function _buildDetectionTextAndSegments(root) {
    const segments = [];
    let out = "";

    function appendText(node, text) {
      const s = String(text || "");
      if (!s) return;
      const start = out.length;
      out += s;
      segments.push({ kind: "text", node, start, end: out.length });
    }

    function appendNewline(node, reason) {
      if (out.endsWith("\n")) return;
      const start = out.length;
      out += "\n";
      segments.push({ kind: "break", node, reason: reason || "newline", start, end: out.length });
    }

    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        appendText(node, node.textContent || "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = (node.tagName || "").toUpperCase();

      // Skip Thunderbird's main message header tables (moz-main-header class).
      // These contain the CURRENT message's From/To/Subject/Date headers, NOT quoted content.
      // Without this check, the outlook-headers pattern would match the current message's headers
      // and collapse the entire email body as "quoted text".
      try {
        if (node.classList && node.classList.contains("moz-main-header")) {
          console.log("[TabMailQuoteDetection] Skipping moz-main-header element in detection text");
          return;
        }
      } catch (_) {}

      if (tag === "BR") {
        appendNewline(node, "br");
        return;
      }
      if (tag === "HR") {
        // Emit a synthetic dash line so the dash-separator pattern can match <hr> elements.
        // This ensures the detection text includes something like "----------" on its own line,
        // which allows our lookahead-based dash-separator rule to fire for HTML emails.
        appendNewline(node, "hr-pre");
        appendText(node, "----------"); // synthetic dashes (min 10 to match the pattern)
        appendNewline(node, "hr");
        return;
      }

      // Walk children
      for (let c = node.firstChild; c; c = c.nextSibling) {
        walk(c);
      }

      // Add a newline after common block-ish elements to preserve visual line breaks
      if (_isBlockElementTag(tag)) {
        appendNewline(node, "block");
      }
    }

    try {
      walk(root);
    } catch (e) {
      console.error("[TabMailQuoteDetection] _buildDetectionTextAndSegments error:", e);
    }

    return { text: out, segments };
  }

  function _locateNodeAtCharOffset(segments, target) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (target < seg.start) continue;
      if (target >= seg.end) continue;
      if (seg.kind === "text") {
        // Check if the node is actually a Text node or an Element (e.g. synthetic dashes for <hr>)
        if (seg.node && seg.node.nodeType === Node.ELEMENT_NODE) {
          // Synthetic text from an element (e.g. <hr> → "----------")
          // Return as an element boundary so callers can collapse from the element itself.
          return { kind: "element", elementNode: seg.node, charOffset: 0 };
        }
        return { kind: "text", textNode: seg.node, charOffset: target - seg.start };
      }
      // If we landed on a break, prefer returning the element node for the break
      // (especially <hr>) so callers can start collapsing from the visual boundary.
      // This fixes the "HR stays outside the collapsed quote" issue.
      if (seg.kind === "break" && seg.node && seg.node.nodeType === Node.ELEMENT_NODE) {
        return { kind: "break", elementNode: seg.node, reason: seg.reason || "", charOffset: 0 };
      }
      // Otherwise, advance to the next text segment (legacy behavior).
      for (let j = i + 1; j < segments.length; j++) {
        const next = segments[j];
        if (next.kind === "text") {
          // Same check for synthetic element text
          if (next.node && next.node.nodeType === Node.ELEMENT_NODE) {
            return { kind: "element", elementNode: next.node, charOffset: 0 };
          }
          return { kind: "text", textNode: next.node, charOffset: 0 };
        }
      }
      return null;
    }
    return null;
  }

  /**
   * Find the first quote boundary by scanning text content only.
   * Does NOT rely on HTML structure - just looks for text patterns.
   * 
   * @param {ParentNode} container - DOM container to search
   * @param {{ includeForward?: boolean }} [opts] - Options. includeForward defaults to FALSE for DOM/display
   *        (forwards should be visible, only reply quotes should collapse).
   * @returns {{ textNode?: Text|null, elementNode?: Element|null, charOffset: number, patternType: string, isForward: boolean, detectionCharIndex?: number, detectionLineIndex?: number }|null}
   */
  function findQuoteBoundaryByText(container, opts = {}) {
    try {
      if (!container) return null;
      // For DOM display/collapse: default to NOT including forwards.
      // Forwards should remain visible; only reply quotes should be collapsible.
      const includeForward = opts.includeForward === true;

      if (typeof document === "undefined") return null;
      if (!document.createTreeWalker) return null;

      const built = _buildDetectionTextAndSegments(container);
      const detectionText = built.text || "";
      const segments = built.segments || [];

      console.log(`[TabMailQuoteDetection] DOM detection text built: len=${detectionText.length} segments=${segments.length}`);
      if (!detectionText.trim()) return null;

      // Use the SAME robust line-based engine used by agent logic (handles >-prefixed reply headers, lookahead, etc.)
      const boundary = findBoundaryInPlainText(detectionText, { includeForward });
      if (!boundary) {
        console.log("[TabMailQuoteDetection] No quote boundary found in DOM detection text");
        // Debug helpers for common failure: missing line breaks or unexpected characters.
        try {
          const lines = detectionText.split(/\r?\n/);
          const interesting = [];
          for (let i = 0; i < lines.length; i++) {
            const l = String(lines[i] || "");
            const lt = l.trim();
            if (!lt) continue;
            if (/wrote:\s*$/i.test(lt) || /Original Message/i.test(lt) || /^From:\s*/i.test(lt) || /^>/.test(lt)) {
              interesting.push({ i, text: lt.slice(0, 220) });
              if (interesting.length >= 8) break;
            }
          }
          console.log("[TabMailQuoteDetection] Interesting lines (first few):", interesting);
        } catch (_) {}
        return null;
      }

      // IMPORTANT: for DOM collapsing we want to start at the beginning of the *line*,
      // so that a leading quote prefix like "> " is also collapsed.
      const { startOffsets } = _splitLinesWithCharOffsets(detectionText);
      const lineStartCharIndex =
        typeof startOffsets?.[boundary.lineIndex] === "number"
          ? startOffsets[boundary.lineIndex]
          : boundary.charIndex;

      // Log the matched line for debugging
      try {
        const lines = detectionText.split(/\r?\n/);
        const line = lines[boundary.lineIndex] || "";
        console.log(`[TabMailQuoteDetection] Quote boundary matched: type="${boundary.type}" line=${boundary.lineIndex} text="${String(line).slice(0, 180)}"`);
      } catch (_) {}

      // Special-case: if the boundary is a header line (e.g. localized sender), scan BACKWARD
      // through the segments to find a nearby <hr> element. Thunderbird reply formatting often
      // has intermediate content (toggle buttons, nested divs) between the HR and the header lines.
      //
      // This matches the common Thunderbird reply format:
      //   <hr>
      //   [possible intermediate content like toggle buttons]
      //   보낸 사람: ...
      //   ...
      let effectiveCharIndex = lineStartCharIndex;
      let foundHrElement = null;
      try {
        if (
          lineStartCharIndex > 0 &&
          (boundary.type === "localized-sender" || boundary.type === "outlook-headers" || boundary.type === "dash-separator")
        ) {
          // Scan backward through segments to find an HR within a reasonable range
          // (e.g., up to 500 characters back, which should cover most intermediate content)
          const maxBackScan = Math.min(lineStartCharIndex, 500);
          for (let si = segments.length - 1; si >= 0; si--) {
            const seg = segments[si];
            // Only consider segments before our boundary
            if (seg.start >= lineStartCharIndex) continue;
            // Stop if we've gone too far back
            if (seg.start < lineStartCharIndex - maxBackScan) break;
            // Check for HR element
            if (seg.node && seg.node.nodeType === Node.ELEMENT_NODE) {
              const tagName = String(seg.node.tagName || "").toUpperCase();
              if (tagName === "HR") {
                foundHrElement = seg.node;
                effectiveCharIndex = seg.start;
                try {
                  console.log(
                    `[TabMailQuoteDetection] Found <hr> at charIndex=${seg.start} (${lineStartCharIndex - seg.start} chars before boundary line ${boundary.lineIndex})`
                  );
                } catch (_) {}
                break;
              }
            }
            // Also check reason for break segments
            if (seg.kind === "break" && String(seg.reason || "").toLowerCase().startsWith("hr")) {
              foundHrElement = seg.node;
              effectiveCharIndex = seg.start;
              try {
                console.log(
                  `[TabMailQuoteDetection] Found <hr> break at charIndex=${seg.start} (${lineStartCharIndex - seg.start} chars before boundary line ${boundary.lineIndex})`
                );
              } catch (_) {}
              break;
            }
          }
        }
      } catch (_) {}

      // If we found an HR element by backward scanning, return it directly
      if (foundHrElement) {
        return {
          textNode: null,
          elementNode: foundHrElement,
          charOffset: 0,
          patternType: boundary.type,
          isForward: boundary.type === "forwarded-message",
          detectionCharIndex: effectiveCharIndex,
          detectionLineIndex: boundary.lineIndex,
        };
      }

      const loc = _locateNodeAtCharOffset(segments, effectiveCharIndex);
      if (!loc) {
        console.log("[TabMailQuoteDetection] Could not map quote boundary charIndex back to a text node");
        return null;
      }

      return {
        textNode: loc.kind === "text" ? loc.textNode : null,
        elementNode: (loc.kind === "break" || loc.kind === "element") ? loc.elementNode : null,
        charOffset: loc.charOffset || 0,
        patternType: boundary.type,
        isForward: boundary.type === "forwarded-message",
        // IMPORTANT: this offset is in the SAME "detection text" coordinate space
        // used by findLastSignatureByText (line breaks inserted for BR/block).
        detectionCharIndex: effectiveCharIndex,
        detectionLineIndex: boundary.lineIndex,
      };
    } catch (e) {
      console.error('[TabMailQuoteDetection] findQuoteBoundaryByText error:', e);
      return null;
    }
  }

  /**
   * Find the last signature by scanning text content only.
   * Only finds signatures that are NOT inside quoted content (lines starting with >).
   * 
   * @param {ParentNode} container - DOM container to search
   * @param {{ afterCharOffset?: number }} [opts] - Only consider signatures after this char offset
   * @returns {{ textNode: Text, charOffset: number }|null}
   */
  function findLastSignatureByText(container, opts = {}) {
    try {
      if (!container) return null;

      if (typeof document === "undefined") return null;
      if (!document.createTreeWalker) return null;

      const built = _buildDetectionTextAndSegments(container);
      const detectionText = built.text || "";
      const segments = built.segments || [];

      const afterCharOffset = opts.afterCharOffset ?? 0;
      if (!detectionText.trim()) return null;

      // Convert afterCharOffset -> afterLine by scanning line starts
      const { lines, startOffsets } = _splitLinesWithCharOffsets(detectionText);
      let afterLine = -1;
      for (let i = 0; i < startOffsets.length; i++) {
        if (startOffsets[i] <= afterCharOffset) afterLine = i;
        else break;
      }

      const lastSig = findLastSignatureFromBottom(detectionText, { afterLine });
      if (!lastSig) {
        console.log("[TabMailQuoteDetection] No non-quoted signature found in DOM detection text");
        // Debug: show last few signature-like lines and whether they were skipped due to quoting
        try {
          const lines2 = detectionText.split(/\r?\n/);
          const hits = [];
          for (let i = lines2.length - 1; i >= 0; i--) {
            const raw = String(lines2[i] || "");
            const trimmed = raw.trim();
            if (!trimmed) continue;
            if (trimmed === "--" || /^--\s*$/.test(trimmed)) {
              hits.push({ i, inQuoted: isInsideQuotedBlock(raw), text: trimmed });
              if (hits.length >= 6) break;
            }
          }
          console.log("[TabMailQuoteDetection] Signature delimiter hits from bottom (first few):", hits);
        } catch (_) {}
        return null;
      }

      try {
        const line = (detectionText.split(/\r?\n/)[lastSig.lineIndex] || "").slice(0, 180);
        console.log(`[TabMailQuoteDetection] Signature matched at line=${lastSig.lineIndex} char=${lastSig.charIndex} text="${line}"`);
      } catch (_) {}

      const loc = _locateTextNodeAtCharOffset(segments, lastSig.charIndex);
      if (!loc || !loc.textNode) {
        console.log("[TabMailQuoteDetection] Could not map signature charIndex back to a text node");
        return null;
      }

      return { textNode: loc.textNode, charOffset: loc.charOffset, detectionCharIndex: lastSig.charIndex, detectionLineIndex: lastSig.lineIndex };
    } catch (e) {
      console.error('[TabMailQuoteDetection] findLastSignatureByText error:', e);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // EXPORTS — All text-based detection functions
  // ---------------------------------------------------------------------------
  g.TabMailQuoteDetection = {
    config,
    patterns,
    
    // Plain text detection (for agent/utils.js)
    findBoundaryInPlainText,
    findLastSignatureFromBottom,
    findQuoteRegion,
    splitPlainTextForQuote,
    
    // Signature helpers
    isSignatureDelimiterLine,
    textContainsSignatureDelimiter,
    isInsideQuotedBlock,
    
    // DOM text-based detection (for messageBubble.js)
    findQuoteBoundaryByText,
    findLastSignatureByText,
    ensureQuoteBoundaryMarkerForTextMatch,
  };
})();

