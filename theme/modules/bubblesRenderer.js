// TabMail Bubbles Renderer (TB 145 / MV3)
// Unified message listener for all bubble-related rendering.
// Coordinates: summaryBubble, threadBubble, quote collapsing in messageBubble.
//
// Injection order:
//   1. quoteAndSignature.js (quote detection)
//   2. messageBubbleConfig.js (shared config)
//   3. messageBubbleStyles.js (shared CSS)
//   4. summaryBubble.js (exports SummaryBubble via globalThis)
//   5. threadBubble.js (exports ThreadBubble via globalThis)
//   6. messageBubble.js (exports MessageBubble - quote collapsing)
//   7. bubblesRenderer.js (this file - listener & orchestration)

(function () {
  console.log('[TabMail BubblesRenderer] Loaded');

  // Get renderers from globalThis
  function getSummaryBubble() {
    return globalThis.TabMailSummaryBubble || null;
  }
  function getThreadBubble() {
    return globalThis.TabMailThreadBubble || null;
  }
  function getMessageBubble() {
    return globalThis.TabMailMessageBubble || null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message Listener - Single point of entry for all bubble messages
  // ─────────────────────────────────────────────────────────────────────────────

  // Remove any existing listener to avoid accumulation on hot-reload
  if (window.__tabmailBubblesRendererListener) {
    try {
      browser.runtime.onMessage.removeListener(window.__tabmailBubblesRendererListener);
    } catch (_) {}
  }

  window.__tabmailBubblesRendererListener = (msg) => {
    if (!msg || !msg.command) return;
    console.log('[TabMail BubblesRenderer] Message:', msg.command);

    const SummaryBubble = getSummaryBubble();
    const ThreadBubble = getThreadBubble();
    const MessageBubble = getMessageBubble();

    // NOTE: font sizing is CSS-first now; we do not use runtime JS sizing.

    // ─────────────────────────────────────────────────────────────────────────
    // Summary Processing (loading indicator)
    // ─────────────────────────────────────────────────────────────────────────
    if (msg.command === 'summaryProcessing') {
      if (SummaryBubble && SummaryBubble.setProcessing) {
        try {
          SummaryBubble.setProcessing();
        } catch (e) {
          console.error('[TabMail BubblesRenderer] setProcessing failed:', e);
        }
      } else {
        console.error('[TabMail BubblesRenderer] SummaryBubble.setProcessing not available');
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Display Summary
    // ─────────────────────────────────────────────────────────────────────────
    if (msg.command === 'displaySummary') {
      // Update summary bubble
      if (SummaryBubble) {
        try {
          if (SummaryBubble.displaySummary) {
            SummaryBubble.displaySummary(msg.blurb, msg.todos, msg.isWarning);
          }
        } catch (e) {
          console.error('[TabMail BubblesRenderer] SummaryBubble.displaySummary failed:', e);
        }
      } else {
        console.error('[TabMail BubblesRenderer] SummaryBubble not available');
      }

      // No thread font updates needed; CSS handles sizing.
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Display Thread Conversation
    // ─────────────────────────────────────────────────────────────────────────
    if (msg.command === 'displayThreadConversation') {
      console.log('[TabMail BubblesRenderer] Thread conversation:', msg.messages?.length || 0, 'messages');
      if (ThreadBubble && ThreadBubble.render) {
        try {
          ThreadBubble.render(msg.messages);
        } catch (e) {
          console.error('[TabMail BubblesRenderer] ThreadBubble.render failed:', e);
        }
      } else {
        console.error('[TabMail BubblesRenderer] ThreadBubble.render not available');
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Refresh Collapsible Quotes
    // ─────────────────────────────────────────────────────────────────────────
    if (msg.command === 'refreshCollapsibleQuotes') {
      console.log('[TabMail BubblesRenderer] Refreshing collapsible quotes');
      if (MessageBubble && MessageBubble.setupCollapsibleQuotes) {
        try {
          MessageBubble.setupCollapsibleQuotes();
        } catch (e) {
          console.error('[TabMail BubblesRenderer] setupCollapsibleQuotes failed:', e);
        }
      }
    }
  };

  browser.runtime.onMessage.addListener(window.__tabmailBubblesRendererListener);

  // Signal to background that the listener is ready
  try {
    browser.runtime.sendMessage({ command: "tm-bubbles-renderer-ready" }).catch(() => {});
    console.log('[TabMail BubblesRenderer] Sent ready signal');
  } catch (_) {}
})();
