// Summary Bubble content script for TabMail
// 
// Note: This bubble is designed to stay OUTSIDE the message bubble wrapper
// created by messageBubble.js. The bubble script explicitly checks for this
// BUBBLE_ID and ensures the bubble stays on top, regardless of injection order.

// console.log('[TMDBG Bubble] injected in', document.location.href);

(function() {
  const CFG = globalThis.TabMailSummaryBubbleConfig;
  if (!CFG || typeof CFG !== "object") {
    console.log("[TabMail Bubble] Missing TabMailSummaryBubbleConfig; summaryBubble will not render");
    // Export a no-op API so other scripts don't crash.
    globalThis.TabMailSummaryBubble = {
      updateBaseFontSize: (base) => {
        try { console.log(`[TabMail Bubble] updateBaseFontSize ignored (missingConfig): base=${base}`); } catch (_) {}
      },
      setProcessing: () => {
        try { console.log("[TabMail Bubble] setProcessing ignored (missingConfig)"); } catch (_) {}
      },
      displaySummary: () => {
        try { console.log("[TabMail Bubble] displaySummary ignored (missingConfig)"); } catch (_) {}
      },
    };
    // Still signal ready so message display gating isn't blocked.
    try {
      window.__tmDisplayGateFlags = window.__tmDisplayGateFlags || {};
      window.__tmDisplayGateFlags.summaryReady = true;
      window.dispatchEvent(new CustomEvent("tabmail:summaryBubbleReady", { detail: { reason: "missingConfig", cycleId: 0 } }));
    } catch (_) {}
    return;
  }
  const BUBBLE_ID = String(CFG.bubbleId || "tabmail-message-bubbles");
  const _injectedAt = Date.now();
  try {
    console.log(`[TabMail Bubble] summaryBubble.js injected t=${_injectedAt}`);
  } catch (_) {}

  // Typography (CSS-first): use system preset + keyword sizing (no scaler math).
  const FONT_PRESET = String(CFG.fontPreset || "menu");
  const FONT_SIZE = String(CFG.fontSize || "smaller");
  const CSS_FONT_PRESET_VAR = "--tm-summary-bubble-font-preset";
  const CSS_FONT_SIZE_VAR = "--tm-summary-bubble-font-size";

  function applyCssTypographyToBubble(bubble, reason) {
    try {
      if (!bubble) return;
      // Use inline !important so even aggressive HTML email rules can't override.
      bubble.style.setProperty(CSS_FONT_PRESET_VAR, FONT_PRESET, "important");
      bubble.style.setProperty(CSS_FONT_SIZE_VAR, FONT_SIZE, "important");
      // NOTE: Gecko supports system font presets like "menu" / "message-box".
      bubble.style.setProperty("font", FONT_PRESET, "important");
      bubble.style.setProperty("font-size", FONT_SIZE, "important");
      if (ENABLE_DIAGNOSTICS) {
        console.log(
          `[TabMail Bubble] Applied CSS typography preset=${FONT_PRESET} size=${FONT_SIZE} (reason=${reason || "unknown"})`
        );
      }
    } catch (e) {
      console.log(`[TabMail Bubble] applyCssTypographyToBubble failed: ${e}`);
    }
  }

  /**
   * Update the font size on the bubble based on the base from TB settings
   * @param {number} baseFontSizePx - Base font size from TB prefs
   */
  function updateBaseFontSize(baseFontSizePx) {
    // Kept for compatibility with older background/bubblesRenderer messages.
    // We intentionally do nothing here; CSS handles sizing.
    try {
      console.log(
        `[TabMail Bubble] updateBaseFontSize ignored (cssSizing): base=${baseFontSizePx} preset=${FONT_PRESET} size=${FONT_SIZE}`
      );
    } catch (_) {}
  }

  function signalSummaryBubbleReady(reason) {
    try {
      window.__tmDisplayGateFlags = window.__tmDisplayGateFlags || {};
      window.__tmDisplayGateFlags.summaryReady = true;

      const cycleId =
        typeof window.__tmDisplayGateCycleId === "number" ? window.__tmDisplayGateCycleId : 0;
      if (window.__tmSummaryBubbleReadyCycleId === cycleId) {
        return;
      }
      window.__tmSummaryBubbleReadyCycleId = cycleId;
      window.dispatchEvent(
        new CustomEvent("tabmail:summaryBubbleReady", {
          detail: { reason: String(reason || "unknown"), cycleId },
        })
      );
      console.log(
        `[TabMail Bubble] Summary bubble ready (cycle=${cycleId} reason=${reason || "unknown"})`
      );
    } catch (e) {
      console.log(`[TabMail Bubble] Failed to signal summary bubble ready: ${e}`);
    }
  }
  
  // Bubble dimensions and spacing (config-driven; avoid hardcoded numeric values here)
  const BUBBLE_MARGIN_HORIZONTAL = Number(CFG.marginHorizontalPx);
  const BUBBLE_MARGIN_TOP = Number(CFG.marginTopPx);
  const BUBBLE_MARGIN_BOTTOM = Number(CFG.marginBottomPx);
  const BUBBLE_PADDING_HORIZONTAL = Number(CFG.paddingHorizontalPx);
  const BUBBLE_PADDING_VERTICAL = Number(CFG.paddingVerticalPx);
  const BUBBLE_BORDER_RADIUS = Number(CFG.borderRadiusPx);
  const ENABLE_RESIZE_OBSERVER = !!CFG.enableResizeObserver;
  const ENABLE_JS_SIZING = !!CFG.enableJsSizing;
  const ENABLE_DIAGNOSTICS = !!CFG.enableDiagnostics;

  // If a runtime message arrives before document.body exists (document_start injection),
  // keep the latest requested UI state and apply it as soon as the scaffold is ready.
  let _pendingRender = null; // { kind: 'processing' } | { kind: 'content', blurb, todos }

  function showBubbleIfNeeded(reason) {
    try {
      const bubble = document.getElementById(BUBBLE_ID);
      if (!bubble) return;
      if (bubble._tmShown) return;
      bubble._tmShown = true;
      // No animation: render-blocking is in place, so show immediately.
      bubble.style.transition = "none";
      bubble.style.opacity = "1";
      bubble.style.transform = "none";
      console.log(`[TabMail Bubble] Bubble shown (reason=${reason || "unknown"})`);
    } catch (e) {
      console.log(`[TabMail Bubble] showBubbleIfNeeded failed: ${e}`);
    }
  }

  function ensureBubble() {
    let bubble = document.getElementById(BUBBLE_ID);
    if (!bubble) {
      // If body isn't ready yet, wait once. (Registration is document_end, so this is rare.)
      if (!document.body) {
        try {
          if (!window.__tmSummaryBubbleWaitedForBody) {
            window.__tmSummaryBubbleWaitedForBody = true;
            console.log("[TabMail Bubble] document.body missing; waiting for DOMContentLoaded to insert bubble");
            document.addEventListener(
              "DOMContentLoaded",
              () => {
                try {
                  // Ensure we perform a complete initial scaffold after the body exists.
                  // This keeps document_start injection snappy without racing body creation.
                  ensureShadowScaffold();
                  // Apply any pending UI update we may have received before body existed.
                  tryApplyPendingRender("DOMContentLoaded");
                } catch (_) {}
              },
              { once: true }
            );
          }
        } catch (_) {}
        return null;
      }

      bubble = document.createElement('div');
      bubble.id = BUBBLE_ID;
      bubble.style.cssText = `
        /* Theme-aware initial paint to avoid flash before shadow styles apply */
        background: color-mix(in srgb, Canvas 80%, AccentColor 20%) !important;
        border: 1px solid color-mix(in srgb, CanvasText 15%, Canvas 85%) !important;
        border-radius: ${BUBBLE_BORDER_RADIUS}px !important;
        padding: ${BUBBLE_PADDING_VERTICAL}px ${BUBBLE_PADDING_HORIZONTAL}px;
        ${CSS_FONT_PRESET_VAR}: ${FONT_PRESET};
        ${CSS_FONT_SIZE_VAR}: ${FONT_SIZE};
        font: ${FONT_PRESET} !important;
        font-size: ${FONT_SIZE} !important;
        line-height: 1.4;
        color: CanvasText !important;
        /* Stabilize layout against aggressive email CSS */
        display: block !important;
        /* IMPORTANT: do not force width:100% here; with margins it can overflow and look "too wide". */
        width: auto !important;
        max-width: none !important;
        position: relative !important;
        box-sizing: border-box !important;
        overflow-x: hidden !important;
        margin: ${BUBBLE_MARGIN_TOP}px ${BUBBLE_MARGIN_HORIZONTAL}px ${BUBBLE_MARGIN_BOTTOM}px ${BUBBLE_MARGIN_HORIZONTAL}px !important;
        /* No animation: show immediately */
        transition: none !important;
        opacity: 1;
        transform: none;
      `;
      // Attach a shadow root so our markup/styles are isolated from the email's HTML & CSS.
      bubble.attachShadow({ mode: 'open' });
      // console.log('[TMDBG Bubble] Shadow root attached');

      const first = document.body.firstChild;
      if (first) {
        document.body.insertBefore(bubble, first);
      } else {
        document.body.appendChild(bubble);
      }
      // console.log('[TMDBG Bubble] bubble element created and inserted');
    }
    // Ensure our CSS-first sizing variable is present even when bubble already existed.
    applyCssTypographyToBubble(bubble, "ensureBubble");
    // Attach a resize observer once to track width shifts (e.g., when scrollbars appear)
    try {
      if (ENABLE_RESIZE_OBSERVER && !bubble._tmResizeObserved) {
        const ro = new ResizeObserver((entries) => {
          for (const entry of entries) {
            try {
              const cr = entry.contentRect;
              // console.log(`[TMDBG Bubble] ResizeObserver width=${cr.width} height=${cr.height}`);
            } catch (_) {}
          }
        });
        ro.observe(bubble);
        bubble._tmResizeObserved = true;
      }
    } catch (_) {}

    return bubble;
  }

  // Utility: always work against the bubble's shadow root so external CSS cannot interfere.
  function ensureShadowScaffold() {
    const bubble = ensureBubble();
    if (!bubble) return null;

    if (!bubble.shadowRoot) {
      bubble.attachShadow({ mode: 'open' });
      // console.log('[TMDBG Bubble] Shadow root (late) attached');
    }

    // One-time shadow DOM setup: keep styles stable and only update content.
    if (!bubble._tmShadowScaffold) {
      const root = bubble.shadowRoot;

      const styleEl = document.createElement("style");
      styleEl.setAttribute("data-tabmail", "summaryBubbleStyle");
      styleEl.textContent = `
        :host {
          /* Respect TB light/dark themes */
          color-scheme: light dark;
          /* Use system colors and mixes so we don't hardcode palette values */
          --tm-bubble-bg: color-mix(in srgb, Canvas 92%, AccentColor 8%);
          --tm-bubble-fg: CanvasText;
          --tm-bubble-border: color-mix(in srgb, CanvasText 15%, Canvas 85%);
          /* Typography: CSS-first (system preset + keyword size; no scaler math) */
          font: var(${CSS_FONT_PRESET_VAR}, menu) !important;
          font-size: var(${CSS_FONT_SIZE_VAR}, small) !important;
          background: var(--tm-bubble-bg) !important;
          border: 1px solid var(--tm-bubble-border) !important;
          border-radius: ${BUBBLE_BORDER_RADIUS}px !important;
          padding: ${BUBBLE_PADDING_VERTICAL}px ${BUBBLE_PADDING_HORIZONTAL}px;
          line-height: 1.4;
          color: var(--tm-bubble-fg) !important;
          margin: ${BUBBLE_MARGIN_TOP}px ${BUBBLE_MARGIN_HORIZONTAL}px ${BUBBLE_MARGIN_BOTTOM}px ${BUBBLE_MARGIN_HORIZONTAL}px !important;
          display: block !important;
          position: relative !important;
          box-sizing: border-box !important;
          overflow-x: hidden !important;
          contain: inline-size paint;
        }

        @media (prefers-color-scheme: dark) {
          :host {
            /* Lift above the email body's Canvas in dark mode and add a touch more accent */
            --tm-bubble-bg: color-mix(in srgb, Canvas 85%, AccentColor 15%);
            --tm-bubble-border: color-mix(in srgb, CanvasText 25%, Canvas 75%);
          }
        }

        .tm-list {
          margin: 4px 0 8px;
          padding-left: 1.2em;
          list-style: disc outside;
        }
        .tm-container {
          width: 100%;
          max-width: 100%;
          overflow-x: hidden;
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .tm-container, .tm-container * {
          /* Extra safety against email CSS inside the shadow root */
          box-sizing: border-box;
        }
        .tm-summary {
          margin: 4px 0;
          display: block;
          max-width: 100%;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .tm-warning {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 10px 12px;
          border-radius: 6px;
          background: ${CFG.warningBgLight};
          border: 1px solid ${CFG.warningBorder};
          color: ${CFG.warningTextLight};
        }
        .tm-warning-icon {
          font-size: 18px;
          line-height: 1.2;
          flex-shrink: 0;
        }
        .tm-warning-text {
          flex: 1;
          font-weight: 500;
        }
        @media (prefers-color-scheme: dark) {
          .tm-warning {
            background: ${CFG.warningBgDark};
            border-color: ${CFG.warningBorder};
            color: ${CFG.warningTextDark};
          }
        }
      `;

      const contentEl = document.createElement("div");
      contentEl.className = "tm-content-root";

      root.textContent = "";
      root.appendChild(styleEl);
      root.appendChild(contentEl);

      bubble._tmShadowScaffold = { root, styleEl, contentEl };
    }

    return bubble._tmShadowScaffold;
  }

  function tryApplyPendingRender(reason) {
    try {
      if (!_pendingRender) return;
      const p = _pendingRender;
      // Only clear after we successfully apply to a ready scaffold.
      const scaffold = ensureShadowScaffold();
      if (!scaffold) return;
      _pendingRender = null;
      if (p.kind === "processing") {
        setProcessing();
        console.log(`[TabMail Bubble] Applied pending render=processing (reason=${reason || "unknown"})`);
        return;
      }
      if (p.kind === "content") {
        displaySummary(p.blurb || "", p.todos || "", p.isWarning);
        console.log(`[TabMail Bubble] Applied pending render=content (reason=${reason || "unknown"})`);
        return;
      }
    } catch (e) {
      console.log(`[TabMail Bubble] tryApplyPendingRender failed: ${e}`);
    }
  }

  function logComputedHostStyles(contextLabel) {
    try {
      if (!ENABLE_DIAGNOSTICS) return;
      const bubble = document.getElementById(BUBBLE_ID);
      if (!bubble) return;
      const rect = bubble.getBoundingClientRect();
      const cs = getComputedStyle(bubble);
      // console.log(
      //   `[TMDBG Bubble] ${contextLabel} width=${rect.width}px, borderBottom="${cs.borderBottomWidth} ${cs.borderBottomStyle} ${cs.borderBottomColor}", marginLR=${cs.marginLeft}/${cs.marginRight}`
      // );
    } catch (e) {
      console.log('[TMDBG Bubble] Failed to read computed styles: ' + e);
    }
  }

  function logLayoutDiagnostics(contextLabel) {
    try {
      if (!ENABLE_DIAGNOSTICS) return;
      const de = document.documentElement;
      const body = document.body;
      const bubble = document.getElementById(BUBBLE_ID);
      const deCW = de ? de.clientWidth : 0;
      const deSW = de ? de.scrollWidth : 0;
      const bodyCW = body ? body.clientWidth : 0;
      const bodySW = body ? body.scrollWidth : 0;
      const hasHScroll = deSW > deCW || bodySW > bodyCW;
      const hostRect = bubble ? bubble.getBoundingClientRect() : { width: 0 };
      // console.log(
      //   `[TMDBG Bubble] Layout ${contextLabel} deCW=${deCW} deSW=${deSW} bodyCW=${bodyCW} bodySW=${bodySW} hasHScroll=${hasHScroll} hostW=${hostRect.width}`
      // );

      if (hasHScroll) {
        // Scan a limited set of top-level elements to find first overflow culprit
        const candidates = Array.from(document.body.children).slice(0, 20);
        for (const el of candidates) {
          try {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const elSW = el.scrollWidth;
            const elCW = el.clientWidth;
            if (elSW > elCW + 1) {
              // console.log(`[TMDBG Bubble] overflow culprit tag=<${el.tagName.toLowerCase()}> cw=${elCW} sw=${elSW} display=${cs.display} pos=${cs.position} overflowX=${cs.overflowX}`);
              break;
            }
          } catch (_) {}
        }
      }
    } catch (e) {
      console.log('[TMDBG Bubble] Layout diag failed: ' + e);
    }
  }

  function logContainerMetrics(root, contextLabel) {
    try {
      if (!ENABLE_DIAGNOSTICS) return;
      const wrap = root.querySelector('.tm-container');
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const sw = wrap.scrollWidth;
      const cw = wrap.clientWidth;
      // console.log(`[TMDBG Bubble] Container ${contextLabel} cw=${cw} sw=${sw} rectW=${rect.width}`);
    } catch (e) {
      console.log('[TMDBG Bubble] Container metrics failed: ' + e);
    }
  }

  function logContentTokenStats(blurb, todos) {
    try {
      const text = `${blurb || ''} ${todos || ''}`;
      const tokens = (text || '').split(/\s+/).filter(Boolean);
      let maxLen = 0;
      for (const t of tokens) {
        if (t.length > maxLen) maxLen = t.length;
      }
      if (maxLen > 40) {
        console.log(`[TMDBG Bubble] Long token detected, maxLen=${maxLen}`);
      }
    } catch (_) {}
  }

  function syncBubbleToViewport() {
    try {
      if (!ENABLE_JS_SIZING) return;
      const bubble = document.getElementById(BUBBLE_ID);
      if (!bubble) return;
      const body = document.body;
      const bodyCW = body ? body.clientWidth : 0;
      if (!bodyCW) return;

      // Bubble design: simple fixed margins for centered appearance
      // Set width relative to body width with fixed margins on each side
      bubble.style.width = (bodyCW - 2 * BUBBLE_MARGIN_HORIZONTAL) + 'px';
      bubble.style.maxWidth = (bodyCW - 2 * BUBBLE_MARGIN_HORIZONTAL) + 'px';
      bubble.style.marginLeft = BUBBLE_MARGIN_HORIZONTAL + 'px';
      bubble.style.marginRight = BUBBLE_MARGIN_HORIZONTAL + 'px';
      bubble.style.paddingLeft = BUBBLE_PADDING_HORIZONTAL + 'px';
      bubble.style.paddingRight = BUBBLE_PADDING_HORIZONTAL + 'px';
      bubble.style.marginTop = BUBBLE_MARGIN_TOP + 'px';
      bubble.style.marginBottom = BUBBLE_MARGIN_BOTTOM + 'px';
    } catch (e) {
      console.log('[TMDBG Bubble] syncBubbleToViewport failed: ' + e);
    }
  }

  function displaySummary(blurb, todos, isWarning) {
    const scaffold = ensureShadowScaffold();
    if (!scaffold) {
      _pendingRender = { kind: "content", blurb: blurb || "", todos: todos || "", isWarning: !!isWarning };
      return;
    }
    const { root, contentEl } = scaffold;

    // Warning message gets special visual treatment
    if (isWarning && blurb) {
      const warningHtml = `
        <div class="tm-warning">
          <span class="tm-warning-icon">⚠️</span>
          <span class="tm-warning-text">${blurb}</span>
        </div>`;
      contentEl.innerHTML = warningHtml;
      showBubbleIfNeeded("displayWarning");
      syncBubbleToViewport();
      signalSummaryBubbleReady("warning");
      console.log("[TabMail Bubble] displaySummary warning applied");
      return;
    }

    let todosHtml = '';
    if (todos && todos.trim()) {
      // Split on bullet characters for each item.
      let items = todos.split('•').map(s => s.trim()).filter(Boolean);

      // Clean up items – drop placeholders and leading bullet chars.
      items = items
        // Keep all items, including the literal "None", so it is shown in a standard
        // bullet list rather than falling back to raw text.
        .map(it => it.replace(/^[-•*\s]+/, '').trim());

      if (items.length) {
        todosHtml = '<ul class="tm-list">' +
                     items.map(it => `<li>${it}</li>`).join('') +
                     '</ul>';
      } else {
        todosHtml = todos;
      }
    }

    const contentHtml = todosHtml ? `
        <div class="tm-container">
          <strong>Todos:</strong>
          ${todosHtml}
          <strong>Summary:</strong>
          <div class="tm-summary">${blurb || 'Analyzing email…'}</div>
        </div>` : `
        <div class="tm-container">
          <strong>Summary:</strong>
          <div class="tm-summary">${blurb || 'Analyzing email…'}</div>
        </div>`;

    // Only update content; styles are one-time setup for snappy rendering.
    contentEl.innerHTML = contentHtml;
    // console.log('[TMDBG Bubble] displaySummary updated');
    showBubbleIfNeeded("displaySummary");
    syncBubbleToViewport();
    logContentTokenStats(blurb, todosHtml);
    logComputedHostStyles('After displaySummary');
    logLayoutDiagnostics('after displaySummary');
    if (ENABLE_DIAGNOSTICS) {
      setTimeout(() => logLayoutDiagnostics('post layout settle (150ms)'), 150);
    }
    logContainerMetrics(root, 'after displaySummary');
    signalSummaryBubbleReady("content");
    try {
      const tNow = Date.now();
      const dtFromInjected = tNow - _injectedAt;
      console.log(
        `[TabMail Bubble] displaySummary applied dtFromInjected=${dtFromInjected}ms`
      );
    } catch (_) {}
  }

  function setProcessing() {
    const scaffold = ensureShadowScaffold();
    if (!scaffold) {
      _pendingRender = { kind: "processing" };
      return;
    }
    scaffold.contentEl.textContent = 'Analyzing email…';
    // console.log('[TMDBG Bubble] setProcessing called');
    showBubbleIfNeeded("summaryProcessing");
    syncBubbleToViewport();
    logComputedHostStyles('After setProcessing');
    logLayoutDiagnostics('after setProcessing');
    signalSummaryBubbleReady("processing");
  }

  // Observe window resizes to detect scrollbars/layout shifts introduced by email content
  try {
    let _lastLoggedWidth = 0;
    if (window.__summaryBubbleOnResize) {
      try {
        window.removeEventListener("resize", window.__summaryBubbleOnResize);
      } catch (_) {}
    }
    window.__summaryBubbleOnResize = () => {
      if (!ENABLE_JS_SIZING && !ENABLE_DIAGNOSTICS) return;
      const w = document.documentElement ? document.documentElement.clientWidth : 0;
      if (Math.abs(w - _lastLoggedWidth) >= 1) {
        _lastLoggedWidth = w;
        syncBubbleToViewport();
        logLayoutDiagnostics('on window.resize');
      }
    };
    window.addEventListener("resize", window.__summaryBubbleOnResize, { passive: true });
  } catch (_) {}

  // Export functions via globalThis for bubblesRenderer.js to call
  globalThis.TabMailSummaryBubble = {
    displaySummary,
    setProcessing,
    updateBaseFontSize,
    ensureBubble,
    signalReady: signalSummaryBubbleReady,
  };
  console.log('[TabMail Bubble] Exported TabMailSummaryBubble to globalThis');

  // Signal ready immediately so the display gate can reveal without waiting
  // for the agent's async pipeline (privacy checks, cache lookup, message
  // passing) to send summaryProcessing/displaySummary. We don't render
  // "Analyzing…" here because the bubble is also injected for non-inbox
  // messages where no content will ever arrive — the agent handles rendering.
  try {
    signalSummaryBubbleReady("auto-init");
    console.log('[TabMail Bubble] Auto-signaled ready for fast gate reveal');
  } catch (e) {
    console.log(`[TabMail Bubble] Auto-init signal failed: ${e}`);
  }
})();

// Note: Cleanup is handled automatically by the proactive removal logic above
// when the script is re-injected. No additional cleanup function needed.

