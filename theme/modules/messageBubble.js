// Message Bubble wrapper for TabMail Theme
// Wraps message body content in a subtle bubble similar to summary banner
// Quote collapsing logic lives here; thread bubble rendering is in threadBubble.js

(function() {
  console.log('[TabMail MsgBubble] Script injected in', document.location.href);

  const QuoteDetect = globalThis.TabMailQuoteDetection;
  if (!QuoteDetect) {
    console.error('[TabMail MsgBubble] Missing global TabMailQuoteDetection. agent/modules/quoteAndSignature.js should be injected before messageBubble.js');
  }

  // Load config from globalThis (set by messageBubbleConfig.js) or use inline defaults
  let _missingConfigLogged = false;
  function getConfig() {
    try {
      const cfg = globalThis.TabMailMessageBubbleConfig;
      if (cfg && typeof cfg === 'object') return cfg;
      if (!_missingConfigLogged) {
        _missingConfigLogged = true;
        console.log('[TabMail MsgBubble] Missing TabMailMessageBubbleConfig; using built-in defaults');
      }
    } catch (_) {}
    // Built-in defaults for safety (should match messageBubbleConfig.js)
    return null;
  }

  const CFG = getConfig();
  
  // Element IDs
  const WRAPPER_ID = CFG?.WRAPPER_ID || 'tm-message-bubble-wrapper';
  const STYLE_ID = CFG?.STYLE_ID || 'tm-message-bubble-style';
  const THREAD_CONTAINER_ID = CFG?.THREAD_CONTAINER_ID || 'tm-thread-conversation';
  
  // Layout dimensions moved to messageBubbleStyles.js

  // Message bubble UI config (from config or inline defaults)
  const MESSAGE_BUBBLE_UI = CFG?.MESSAGE_BUBBLE_UI || {
    monoFontScale: 0.95,
    monoDetect: {
      maxCandidatesToCheck: 600,
      selector:
        "pre, code, tt, kbd, samp, font[face], *[style*='monospace'], .moz-text-plain, .moz-text-flowed, .moz-txt-fixed",
      familyNeedles: ["mono", "Menlo", "Consolas", "DejaVu Sans Mono"],
    },
  };

  // Thread bubble config (THREAD_BUBBLE_UI, THREAD_CLASSES) moved to threadBubble.js

  // Quote collapse class names
  const QUOTE_CLASSES = CFG?.QUOTE_CLASSES || {
    toggle: 'tm-quote-toggle',
    collapsed: 'tm-quote-collapsed',
    wrapper: 'tm-quote-wrapper',
    content: 'tm-quote-content',
  };

  // Thread bubble rendering moved to threadBubble.js (globalThis.TabMailThreadBubble)

  // Quote collapse class aliases
  const QUOTE_TOGGLE_CLASS = QUOTE_CLASSES.toggle;
  const QUOTE_COLLAPSED_CLASS = QUOTE_CLASSES.collapsed;
  const QUOTE_WRAPPER_CLASS = QUOTE_CLASSES.wrapper;
  const QUOTE_CONTENT_CLASS = QUOTE_CLASSES.content;

  function signalMessageBubbleReady(reason) {
    try {
      window.__tmDisplayGateFlags = window.__tmDisplayGateFlags || {};
      window.__tmDisplayGateFlags.messageBubbleReady = true;

      const cycleId =
        typeof window.__tmDisplayGateCycleId === "number" ? window.__tmDisplayGateCycleId : 0;
      if (window.__tmMessageBubbleReadyCycleId === cycleId) {
        return;
      }
      window.__tmMessageBubbleReadyCycleId = cycleId;
      window.dispatchEvent(
        new CustomEvent("tabmail:messageBubbleReady", {
          detail: { reason: String(reason || "unknown"), cycleId },
        })
      );
      console.log(
        `[TabMail MsgBubble] Message bubble ready (cycle=${cycleId} reason=${reason || "unknown"})`
      );
    } catch (e) {
      console.log(`[TabMail MsgBubble] Failed to signal message bubble ready: ${e}`);
    }
  }
  
  // -------------------------------------------------
  // Quote Collapsing Logic
  // Detection lives in agent/modules/quoteAndSignature.js (globalThis.TabMailQuoteDetection).
  // Quote block: from first reply boundary to end of message.
  // -------------------------------------------------
  
  /**
   * Collapse only the trailing quoted section when inline replies are detected.
   * Walks backwards from the last top-level blockquote to find one with no
   * non-trivial text after it — that trailing section gets collapsed.
   * If ALL blockquotes have reply text after them, nothing is collapsed.
   */
  function collapseTrailingQuote(wrapper) {
    try {
      const allBQs = wrapper.querySelectorAll('blockquote');
      const topLevelBQs = [];
      for (const bq of allBQs) {
        if (!bq.parentElement || !bq.parentElement.closest('blockquote')) {
          topLevelBQs.push(bq);
        }
      }

      if (topLevelBQs.length < 2) {
        console.log('[TabMail MsgBubble] Trailing quote: fewer than 2 top-level blockquotes, skipping');
        return false;
      }

      const minLen = QuoteDetect?.config?.inlineAnswerMinLineLength ?? 2;

      // Walk backwards to find the last blockquote with no non-trivial text after it
      let trailingBQ = null;
      for (let i = topLevelBQs.length - 1; i >= 0; i--) {
        let afterNode = topLevelBQs[i].nextSibling;
        let hasTextAfter = false;
        while (afterNode) {
          const txt = (afterNode.textContent || '').trim();
          if (txt.length >= minLen) { hasTextAfter = true; break; }
          afterNode = afterNode.nextSibling;
        }
        if (!hasTextAfter) { trailingBQ = topLevelBQs[i]; break; }
      }

      if (!trailingBQ) {
        console.log('[TabMail MsgBubble] Trailing quote: all blockquotes have replies after them, skipping');
        return false;
      }

      // Do NOT walk up to a wrapper child — the trailing BQ may be nested deep
      // inside containers (e.g. div.gmail_quote) that also hold the inline reply
      // text. Walking up would collapse the entire email. Instead, collapse from
      // the trailing blockquote directly and grab its remaining siblings.
      const quoteStart = trailingBQ;

      const toggleLabelShow = 'Show quoted text';
      const toggleLabelHide = 'Hide quoted text';

      const quoteWrapper = document.createElement('div');
      quoteWrapper.className = `${QUOTE_WRAPPER_CLASS} ${QUOTE_COLLAPSED_CLASS}`;

      const toggle = document.createElement('div');
      toggle.className = QUOTE_TOGGLE_CLASS;
      toggle.innerHTML = `<span class="tm-toggle-text">${toggleLabelShow}</span>`;
      toggle.title = 'Click to expand';
      toggle.addEventListener('click', () => {
        quoteWrapper.classList.toggle(QUOTE_COLLAPSED_CLASS);
        const isCollapsed = quoteWrapper.classList.contains(QUOTE_COLLAPSED_CLASS);
        toggle.innerHTML = `<span class="tm-toggle-text">${isCollapsed ? toggleLabelShow : toggleLabelHide}</span>`;
        toggle.title = isCollapsed ? 'Click to expand' : 'Click to collapse';
        console.log(`[TabMail MsgBubble] Trailing quote toggled, collapsed: ${isCollapsed}`);
      });

      const content = document.createElement('div');
      content.className = QUOTE_CONTENT_CLASS;

      quoteStart.parentNode.insertBefore(quoteWrapper, quoteStart);
      quoteWrapper.appendChild(toggle);
      quoteWrapper.appendChild(content);

      // Move trailing BQ and everything after it (at the same level) into content
      while (quoteStart.nextSibling) {
        content.appendChild(quoteStart.nextSibling);
      }
      content.insertBefore(quoteStart, content.firstChild);

      console.log('[TabMail MsgBubble] ✓ Trailing quote collapsed (inline reply mode)');
      return true;
    } catch (e) {
      console.error('[TabMail MsgBubble] collapseTrailingQuote error:', e);
      return false;
    }
  }

  /**
   * Find the quote region and make it collapsible.
   * Uses PURE TEXT-BASED detection from the shared quoteAndSignature module.
   */
  function setupCollapsibleQuotes() {
    console.log('[TabMail MsgBubble] Setting up collapsible quotes (text-based detection)');
    
    const wrapper = document.getElementById(WRAPPER_ID) || document.body;
    
    // Skip if already processed
    if (wrapper.querySelector('.' + QUOTE_WRAPPER_CLASS)) {
      console.log('[TabMail MsgBubble] Quote wrapper already exists');
      return;
    }
    
    // Use shared detection from quoteAndSignature.js
    if (!QuoteDetect || !QuoteDetect.findQuoteBoundaryByText) {
      console.error('[TabMail MsgBubble] Missing QuoteDetect.findQuoteBoundaryByText');
      return;
    }
    
    // NOTE: Do not rely on wrapper.textContent for boundary offsets; the detector uses a newline-normalized
    // "detection text" coordinate space and returns detectionCharIndex for consistency.
    
    // Find the first quote pattern in the text (excludes forward for collapse)
    const quoteMatch = QuoteDetect.findQuoteBoundaryByText(wrapper, { includeForward: true });
    if (!quoteMatch) {
      console.log('[TabMail MsgBubble] No quote boundary found');
      return;
    }

    // Inline reply + trailing quote collapse: when inline answers are detected,
    // the user's content is interleaved with quoted blocks. Instead of collapsing
    // from the first boundary, find the last blockquote that has no non-trivial
    // text after it (the trailing quoted section) and collapse only that.
    if (quoteMatch.hasInlineAnswers) {
      console.log('[TabMail MsgBubble] Inline answers detected — looking for trailing quote to collapse');
      if (collapseTrailingQuote(wrapper)) {
        return;
      }
      console.log('[TabMail MsgBubble] Trailing quote collapse failed — falling back to normal collapse');
    }

    const { textNode: quoteTextNode, elementNode: quoteElementNode, charOffset: quoteCharOffset, patternType, isForward } = quoteMatch;

    console.log(`[TabMail MsgBubble] Quote boundary: pattern="${patternType}" (nodeOffset=${quoteCharOffset})`);

    // Debug: log what the boundary points at
    try {
      if (quoteTextNode) {
        const t = quoteTextNode?.textContent || '';
        const preview = t.slice(Math.max(0, quoteCharOffset - 4), quoteCharOffset + 80);
        console.log(`[TabMail MsgBubble] Quote start preview around nodeOffset=${quoteCharOffset}: "${preview.replace(/\n/g, '\\n')}"`);
      } else if (quoteElementNode) {
        console.log(`[TabMail MsgBubble] Quote boundary is element node <${quoteElementNode.tagName?.toLowerCase() || 'unknown'}> (no text preview)`);
      }
    } catch (_) {}

    // --- Block-level ancestor walk (ported from iOS HTMLMessageView.collapseQuotesJS) ---
    // Instead of Range.extractContents() (which splits/clones partially-selected ancestor
    // nodes and produces broken DOM structure), we:
    //   1. Find the target text/element node from the detector
    //   2. Walk up to the closest block-level ancestor
    //   3. Walk further up, stopping when prior siblings have real text content
    //   4. Insert wrapper before that element and move siblings into it

    // Step 1: Determine the target node (the DOM node the boundary points at)
    let targetNode = quoteElementNode || quoteTextNode;
    if (!targetNode) {
      console.log('[TabMail MsgBubble] No target node for quote boundary');
      return;
    }

    // Step 2: Walk up to the closest block-level ancestor
    const BLOCK_TAGS = new Set(['DIV', 'P', 'BLOCKQUOTE', 'TABLE', 'PRE', 'UL', 'OL', 'LI', 'HR', 'BR', 'TR', 'TD', 'TH', 'TBODY', 'THEAD', 'TFOOT']);
    let quoteStart = targetNode.nodeType === Node.ELEMENT_NODE ? targetNode : targetNode.parentElement;
    while (quoteStart && quoteStart !== wrapper) {
      if (BLOCK_TAGS.has(quoteStart.tagName)) break;
      try {
        const display = window.getComputedStyle(quoteStart).display;
        if (display === 'block' || display === 'flex' || display === 'table') break;
      } catch (_) {}
      quoteStart = quoteStart.parentElement;
    }
    console.log(`[TabMail MsgBubble] quoteStart after block walk: ${quoteStart ? quoteStart.tagName + '.' + (quoteStart.className || '') : 'NULL/wrapper'}`);
    if (!quoteStart || quoteStart === wrapper) return;

    // Step 2b: If the block-level ancestor contains BOTH the user's reply
    // and the quoted text, narrow quoteStart so only the quote collapses.
    // - PRE with mid-node boundary: split the <pre> into two.
    // - Other blocks (div.moz-text-flowed, etc.) with preceding sibling
    //   content: use the boundary text node itself as quoteStart.
    if (quoteTextNode && quoteStart.contains(quoteTextNode)) {
      const textBeforeInNode = quoteCharOffset > 0
        ? (quoteTextNode.textContent || '').substring(0, quoteCharOffset).trim()
        : '';
      let precedingSibText = '';
      for (let sib = quoteTextNode.previousSibling; sib; sib = sib.previousSibling) {
        precedingSibText += (sib.textContent || '');
      }
      const hasInNodeContent = textBeforeInNode.length >= 10;
      const hasPrecedingSibContent = precedingSibText.trim().length >= 10;

      if (quoteStart.tagName === 'PRE' && (hasInNodeContent || hasPrecedingSibContent)) {
        // PRE case: split the text node and create a new <pre> to preserve formatting
        try {
          const splitNode = quoteCharOffset > 0 ? quoteTextNode.splitText(quoteCharOffset) : quoteTextNode;
          const newPre = quoteStart.cloneNode(false);
          let node = splitNode;
          while (node) {
            const next = node.nextSibling;
            newPre.appendChild(node);
            node = next;
          }
          quoteStart.parentNode.insertBefore(newPre, quoteStart.nextSibling);
          quoteStart = newPre;
          console.log('[TabMail MsgBubble] Split <pre> at boundary — quoteStart is now the second <pre>');
        } catch (e) {
          console.log(`[TabMail MsgBubble] <pre> split failed: ${e.message}`);
        }
      } else if (hasPrecedingSibContent || hasInNodeContent) {
        // Non-PRE case: narrow quoteStart to the boundary text node
        if (quoteCharOffset > 0 && hasInNodeContent) {
          quoteStart = quoteTextNode.splitText(quoteCharOffset);
        } else {
          quoteStart = quoteTextNode;
        }
        console.log('[TabMail MsgBubble] Narrowed quoteStart to text node within block element');
      }
    }

    // If inside a blockquote, use the blockquote as collapse point
    try {
      const bq = quoteStart.closest ? quoteStart.closest('blockquote') : null;
      if (bq && wrapper.contains(bq)) {
        console.log('[TabMail MsgBubble] Using closest blockquote instead');
        quoteStart = bq;
      }
    } catch (_) {}

    // Step 3: Walk quoteStart up toward a direct child of wrapper, but stop when
    // the parent has preceding siblings with real text content. This prevents
    // collapsing wrapper divs (e.g. moz-text-html) that contain BOTH the
    // user's reply and the quoted text.
    if (quoteStart.tagName !== 'BLOCKQUOTE') {
      while (quoteStart.parentNode && quoteStart.parentNode !== wrapper) {
        let hasPriorContent = false;
        for (let sib = quoteStart.previousSibling; sib; sib = sib.previousSibling) {
          if ((sib.textContent || '').trim().length >= 2) { hasPriorContent = true; break; }
        }
        if (hasPriorContent) {
          console.log(`[TabMail MsgBubble] Walk-up stopped: prior content found at ${quoteStart.tagName || '#text'}.${quoteStart.className || ''}`);
          break;
        }
        quoteStart = quoteStart.parentNode;
      }
    }
    console.log(`[TabMail MsgBubble] Final quoteStart: ${quoteStart.tagName || '#text'}.${quoteStart.className || ''}, parent=${quoteStart.parentNode ? quoteStart.parentNode.tagName : 'null'}`);

    // Insert a marker span just before quoteStart for debugging/consistency
    let quoteMarker = null;
    try {
      quoteMarker = document.createElement('span');
      quoteMarker.className = 'tm-quote-boundary-marker';
      quoteMarker.setAttribute('data-pattern', patternType);
      quoteStart.parentNode.insertBefore(quoteMarker, quoteStart);
    } catch (_) {}

    // Determine toggle label
    const toggleLabelShow = isForward ? 'Show forwarded message' : 'Show quoted text';
    const toggleLabelHide = isForward ? 'Hide forwarded message' : 'Hide quoted text';

    // Create wrapper for the quote content
    const quoteWrapper = document.createElement('div');
    quoteWrapper.className = `${QUOTE_WRAPPER_CLASS} ${QUOTE_COLLAPSED_CLASS}`;

    // Create toggle button
    const toggle = document.createElement('div');
    toggle.className = QUOTE_TOGGLE_CLASS;
    toggle.innerHTML = `<span class="tm-toggle-text">${toggleLabelShow}</span>`;
    toggle.title = 'Click to expand';
    toggle.addEventListener('click', () => {
      quoteWrapper.classList.toggle(QUOTE_COLLAPSED_CLASS);
      const isCollapsed = quoteWrapper.classList.contains(QUOTE_COLLAPSED_CLASS);
      toggle.innerHTML = `<span class="tm-toggle-text">${isCollapsed ? toggleLabelShow : toggleLabelHide}</span>`;
      toggle.title = isCollapsed ? 'Click to expand' : 'Click to collapse';
      console.log(`[TabMail MsgBubble] Quote toggled, collapsed: ${isCollapsed}`);
    });

    // Create content container
    const content = document.createElement('div');
    content.className = QUOTE_CONTENT_CLASS;

    // Step 4: Insert wrapper before quoteStart, then move quoteStart + all
    // following siblings into the content container (same approach as iOS).
    const quoteParent = quoteStart.parentNode;
    if (!quoteParent) {
      console.log('[TabMail MsgBubble] quoteStart has no parent');
      return;
    }
    quoteParent.insertBefore(quoteWrapper, quoteStart);
    quoteWrapper.appendChild(toggle);
    quoteWrapper.appendChild(content);

    // Move quoteStart and everything after it into content
    content.appendChild(quoteStart);
    while (quoteWrapper.nextSibling) {
      content.appendChild(quoteWrapper.nextSibling);
    }

    // Sweep trailing siblings of ancestor elements up to wrapper into the
    // collapse content. This catches attachment fieldsets, empty blockquote
    // wrappers, etc. that Thunderbird renders as siblings of the main
    // moz-text-html div (outside the div that contains the collapsed quote).
    let ancestor = quoteParent;
    while (ancestor && ancestor !== wrapper) {
      while (ancestor.nextSibling) {
        content.appendChild(ancestor.nextSibling);
      }
      ancestor = ancestor.parentNode;
    }

    console.log('[TabMail MsgBubble] Moved quote region into wrapper');

    // Mark as processed
    if (quoteMarker) quoteMarker.classList.add('tm-quote-processed');

    console.log(`[TabMail MsgBubble] ✓ Collapsible quotes setup complete`);
  }
  
  // Thread bubble rendering moved to threadBubble.js (see globalThis.TabMailThreadBubble)

  function logMonospaceScaleDiagnostics(phase) {
    try {
      const wrapper = document.getElementById(WRAPPER_ID) || null;
      const styleEl = document.getElementById(STYLE_ID) || null;

      const styleHasMonoRule =
        !!styleEl && typeof styleEl.textContent === "string"
          ? styleEl.textContent.includes("--tm-msgbubble-mono-scale") &&
            styleEl.textContent.includes(`#${WRAPPER_ID} pre`)
          : false;

      let wrapperVar = null;
      try {
        wrapperVar = wrapper
          ? window.getComputedStyle(wrapper).getPropertyValue("--tm-msgbubble-mono-scale")
          : null;
        } catch (_) {}

      let monoNodes = [];
        try {
        monoNodes = wrapper
          ? Array.from(wrapper.querySelectorAll("pre, code, tt, kbd, samp"))
          : [];
        } catch (_) {}

      const first = monoNodes.length ? monoNodes[0] : null;
      let firstFontSize = null;
      let firstFamily = null;
      let firstImportant = null;
      try {
        if (first) {
          const cs = window.getComputedStyle(first);
          firstFontSize = cs.fontSize;
          firstFamily = cs.fontFamily;
          try {
            // If inline style exists, it can override; this helps debugging.
            firstImportant = first.getAttribute("style") || null;
        } catch (_) {}
        }
            } catch (_) {}

      console.log("[TabMail MsgBubble] monospace scale diagnostics", {
        phase: String(phase || ""),
        href: String(document.location?.href || ""),
        monoFontScale: MESSAGE_BUBBLE_UI.monoFontScale,
        wrapperFound: !!wrapper,
        styleFound: !!styleEl,
        styleHasMonoRule,
        wrapperVar: wrapperVar != null ? String(wrapperVar).trim() : null,
        monoNodeCount: monoNodes.length,
        firstTag: first ? String(first.tagName || "") : null,
        firstClass: first ? String(first.className || "") : null,
        firstInlineStyle: firstImportant,
        firstFontSize,
        firstFamily,
      });
    } catch (e) {
      console.log("[TabMail MsgBubble] monospace scale diagnostics failed:", e);
    }
  }

  function isMonospaceFamily(fontFamily) {
    try {
      const ff = String(fontFamily || "");
      const needles = MESSAGE_BUBBLE_UI.monoDetect.familyNeedles || [];
      for (const n of needles) {
        if (ff.toLowerCase().includes(String(n).toLowerCase())) return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  function markMonospaceRuns(phase) {
    try {
      const wrapper = document.getElementById(WRAPPER_ID) || null;
      if (!wrapper) return;

      // If the whole wrapper is monospace (common for plaintext rendering), mark it once.
      try {
        const wcs = window.getComputedStyle(wrapper);
        const wff = wcs?.fontFamily || "";
        if (isMonospaceFamily(wff)) {
          wrapper.classList.add("tm-msgbubble-all-mono");
        }
      } catch (_) {}

      const selector = MESSAGE_BUBBLE_UI.monoDetect.selector;
      const max = MESSAGE_BUBBLE_UI.monoDetect.maxCandidatesToCheck;

      let candidates = [];
      try {
        candidates = Array.from(wrapper.querySelectorAll(selector));
      } catch (eSel) {
        console.log("[TabMail MsgBubble] markMonospaceRuns selector failed:", { selector, eSel });
        return;
      }

      let checked = 0;
      let tagged = 0;
      const examples = [];

      for (const el of candidates) {
        checked += 1;
        if (checked > max) break;
        try {
          const cs = window.getComputedStyle(el);
          const ff = cs?.fontFamily || "";
          if (!isMonospaceFamily(ff)) continue;
          el.classList.add("tm-msgbubble-mono");
          tagged += 1;
          if (examples.length < 6) {
            examples.push({
              tag: String(el.tagName || ""),
              className: String(el.className || ""),
              fontFamily: String(ff),
              fontSize: String(cs?.fontSize || ""),
            });
          }
                  } catch (_) {}
      }

      console.log("[TabMail MsgBubble] markMonospaceRuns", {
        phase: String(phase || ""),
        selector,
        candidates: candidates.length,
        checked,
        tagged,
        wrapperAllMono: wrapper.classList.contains("tm-msgbubble-all-mono"),
        examples,
      });
      } catch (e) {
      console.log("[TabMail MsgBubble] markMonospaceRuns failed:", e);
    }
  }

  function wrapMessageBody() {
    // Check if already wrapped
    if (document.getElementById(WRAPPER_ID)) {
      console.log('[TabMail MsgBubble] Already wrapped');
      return;
    }

    if (!document.body) {
      console.log('[TabMail MsgBubble] No body yet, waiting...');
      // Wait for body to be available
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wrapMessageBody, { once: true });
      }
      return;
    }

    try {
      console.log('[TabMail MsgBubble] Creating bubble wrapper');
      
      // Create wrapper div
      const wrapper = document.createElement('div');
      wrapper.id = WRAPPER_ID;
      
      // Move all body children into wrapper, EXCEPT the summary bubble
      // This ensures proper ordering even if bubble was injected first
      const BANNER_ID = 'tabmail-message-bubbles';
      let bannerElement = null;
      
      while (document.body.firstChild) {
        const child = document.body.firstChild;
        // Skip the summary bubble - keep it outside the bubble
        if (child.id === BANNER_ID) {
          bannerElement = child;
          document.body.removeChild(child);
          console.log('[TabMail MsgBubble] Preserving summary bubble outside bubble');
        } else {
          wrapper.appendChild(child);
        }
      }
      
      // Add wrapper to body
      document.body.appendChild(wrapper);
      
      // Re-insert bubble at the top if it existed
      if (bannerElement) {
        document.body.insertBefore(bannerElement, wrapper);
        console.log('[TabMail MsgBubble] Repositioned summary bubble before bubble');
      }
      
      // Detect near-white backgrounds BEFORE style injection overrides them.
      // We track white vs off-white separately so we can:
      // - white (#fff) → Canvas (matches dark page bg)
      // - off-white (#f2f2f2) → subtle tint (preserves frame effect)
      // Both applied via inline !important to avoid CSS specificity issues.
      const offWhiteEls = [];
      const whiteEls = [];
      try {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (isDark) {
          const bgEls = wrapper.querySelectorAll('table,td,th,tr,tbody,thead,tfoot,div:not([class*="tm-"]):not([id*="tm-"])');
          for (let k = 0; k < bgEls.length; k++) {
            const cs = window.getComputedStyle(bgEls[k]);
            const m = (cs.backgroundColor || '').match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (!m) continue;
            const r = +m[1], g = +m[2], b = +m[3], a = m[4] != null ? +m[4] : 1;
            if (a < 0.1) continue;
            const L = (r * 299 + g * 587 + b * 114) / 1000;
            const S = Math.max(r, g, b) - Math.min(r, g, b);
            if (L > 220 && S < 10) {
              if (L >= 250) {
                whiteEls.push(bgEls[k]);
              } else {
                offWhiteEls.push(bgEls[k]);
              }
            }
          }
        }
      } catch (_) {}

      // Inject styles from pre-generated CSS (loaded via messageBubbleStyles.js)
      const STYLES = globalThis.TabMailMessageBubbleStyles || {};
      const style = document.createElement('style');
      style.id = STYLES.STYLE_ID || STYLE_ID;
      style.textContent = STYLES.css || '';

      if (!STYLES.css) {
        console.error('[TabMail MsgBubble] Missing TabMailMessageBubbleStyles.css - styles file not loaded?');
      }

      if (document.head) {
        document.head.appendChild(style);
      } else {
        document.documentElement.insertBefore(style, document.body);
      }

      // Apply dark-mode background overrides via inline !important (strongest override).
      // White → Canvas (dark page bg), off-white → subtle tint (frame effect).
      for (let k = 0; k < whiteEls.length; k++) {
        whiteEls[k].style.setProperty('background-color', 'Canvas', 'important');
        whiteEls[k].style.setProperty('background', 'Canvas', 'important');
      }
      for (let k = 0; k < offWhiteEls.length; k++) {
        offWhiteEls[k].style.setProperty('background-color', 'color-mix(in srgb, CanvasText 6%, Canvas 94%)', 'important');
        offWhiteEls[k].style.setProperty('background', 'color-mix(in srgb, CanvasText 6%, Canvas 94%)', 'important');
      }

      // Strip hardcoded widths from email elements wider than the wrapper.
      // CSS max-width doesn't work on table cells (spec: undefined),
      // so we must use JS to override explicit pixel widths.
      try {
        const ww = wrapper.getBoundingClientRect().width;
        if (ww > 100) {
          const toFix = wrapper.querySelectorAll('table,td,th,div:not([class*="tm-"]):not([id*="tm-"]),p');
          for (let j = 0; j < toFix.length; j++) {
            if (toFix[j].getBoundingClientRect().width > ww + 1) {
              toFix[j].style.setProperty('width', 'auto', 'important');
              toFix[j].style.setProperty('min-width', '0', 'important');
            }
          }
        }
      } catch (widthErr) {
        console.error('[TabMail MsgBubble] Width constraining failed:', widthErr);
      }

      // Diagnostics: confirm CSS + selector actually hits monospace nodes.
      logMonospaceScaleDiagnostics("after-style-injected");
      markMonospaceRuns("after-style-injected");
      try {
        window.requestAnimationFrame(() =>
          (logMonospaceScaleDiagnostics("raf-after-style-injected"),
          markMonospaceRuns("raf-after-style-injected"))
        );
      } catch (_) {}
      
      console.log('[TabMail MsgBubble] ✓ Successfully wrapped message body in bubble');
      
      // Setup collapsible quotes after wrapping
      try {
        setupCollapsibleQuotes();
        signalMessageBubbleReady("wrapped-and-quotes-ready");
      } catch (quoteErr) {
        console.error('[TabMail MsgBubble] Failed to setup collapsible quotes:', quoteErr);
      }
    } catch (e) {
      console.error('[TabMail MsgBubble] Failed to wrap message body:', e);
    }
  }
  
  // -------------------------------------------------
  // Export functions for bubblesRenderer.js
  // -------------------------------------------------
  globalThis.TabMailMessageBubble = {
    setupCollapsibleQuotes,
    wrapMessageBody,
    signalReady: signalMessageBubbleReady,
  };
  console.log('[TabMail MsgBubble] Exported TabMailMessageBubble to globalThis');

  // Apply wrapper immediately or wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wrapMessageBody, { once: true });
  } else {
    wrapMessageBody();
  }
})();

// Note: Cleanup is handled automatically by the proactive removal logic above
// when the script is re-injected. No additional cleanup function needed.

