// Message Display Gate (TB 145 / MV3)
// Hides message content until both summaryBubble.js and messageBubble.js report ready.
// Keeps the summary bubble visible as soon as it exists.

(function () {
  const REVEALED_CLASS = "tm-gate-revealed";
  const SUMMARY_BUBBLE_ID = "tabmail-message-bubbles";
  const MESSAGE_WRAPPER_ID = "tm-message-bubble-wrapper";
  
  // Gate timeout config: if rendering doesn't complete within this time, reveal anyway to avoid hanging
  const GATE_TIMEOUT_MS = 1000;

  // Hot-reload safety: remove prior listeners/styles if this script is reinjected.
  try {
    if (typeof window.__tmMessageDisplayGateCleanup === "function") {
      window.__tmMessageDisplayGateCleanup();
    }
  } catch (e) {
    console.log("[TabMail Gate] Prior cleanup failed:", e);
  }

  const state = {
    summaryReady: false,
    messageBubbleReady: false,
    summaryDisabled: false,
    revealed: false,
    cycleId: 0,
  };

  // TB sometimes tears down the message pane quickly (navigation / reload / shutdown).
  // If we attempt runtime messaging during teardown, Thunderbird may log:
  // "Promise rejected after context unloaded: Actor 'Conduits' destroyed..."
  // Guard against sending messages once teardown begins.
  let _isTearingDown = false;
  let _teardownSkipLogged = false;
  
  // Timeout timer to prevent gate from hanging indefinitely
  let _gateTimeoutTimer = null;

  function markTearingDown(reason) {
    try {
      if (_isTearingDown) return;
      _isTearingDown = true;
      console.log(`[TabMail Gate] Teardown started; suppressing runtime messaging (reason=${reason || "unknown"})`);
    } catch (_) {}
  }

  function beginGateCycle(reason) {
    try {
      // Clear any existing timeout from previous cycle
      if (_gateTimeoutTimer !== null) {
        try {
          clearTimeout(_gateTimeoutTimer);
          _gateTimeoutTimer = null;
        } catch (_) {}
      }
      
      state.cycleId = (state.cycleId || 0) + 1;
      state.summaryReady = false;
      state.messageBubbleReady = false;
      state.summaryDisabled = false;
      state.revealed = false;

      window.__tmDisplayGateFlags = window.__tmDisplayGateFlags || {};
      window.__tmDisplayGateFlags.cycleId = state.cycleId;
      window.__tmDisplayGateCycleId = state.cycleId;

      try {
        document.documentElement.classList.remove(REVEALED_CLASS);
      } catch (_) {}

      console.log(`[TabMail Gate] Gate cycle begin id=${state.cycleId} reason=${reason || "unknown"}`);
      trySendDiag("beginCycle");
      trySendPreviewGate(true, "beginCycle");
      
      // Start timeout: if gate isn't revealed within GATE_TIMEOUT_MS, reveal it anyway
      const currentCycleId = state.cycleId;
      _gateTimeoutTimer = setTimeout(() => {
        try {
          // Only reveal if we're still in the same cycle and not already revealed
          if (currentCycleId === state.cycleId && !state.revealed) {
            console.log(`[TabMail Gate] Gate timeout expired (${GATE_TIMEOUT_MS}ms); forcing reveal to prevent hang (cycle=${currentCycleId})`);
            state.revealed = true;
            revealGate("timeout");
          }
        } catch (e) {
          console.log(`[TabMail Gate] Gate timeout handler failed: ${e}`);
        }
        _gateTimeoutTimer = null;
      }, GATE_TIMEOUT_MS);
    } catch (e) {
      console.log("[TabMail Gate] Failed to begin gate cycle:", e);
    }
  }

  function revealGate(reason) {
    try {
      // Clear timeout since we're revealing normally
      if (_gateTimeoutTimer !== null) {
        try {
          clearTimeout(_gateTimeoutTimer);
          _gateTimeoutTimer = null;
        } catch (_) {}
      }
      
      document.documentElement.classList.add(REVEALED_CLASS);
      console.log(`[TabMail Gate] Gate revealed (cycle=${state.cycleId} reason=${reason || "unknown"})`);
      trySendDiag("revealed");
      trySendPreviewGate(false, "revealed");
    } catch (e) {
      console.log("[TabMail Gate] Failed to reveal gate:", e);
    }
  }

  function trySendPreviewGate(gated, why) {
    try {
      if (_isTearingDown) {
        if (!_teardownSkipLogged) {
          _teardownSkipLogged = true;
          console.log("[TabMail Gate] Skipping tm-preview-gate sendMessage (teardown in progress)");
        }
        return;
      }

      // Avoid noisy duplicates from subframes.
      try {
        if (window.top && window.top !== window) {
          return;
        }
      } catch (_) {}

      browser.runtime
        .sendMessage({
          command: "tm-preview-gate",
          gated: !!gated,
          why: String(why || "unknown"),
          cycleId: state.cycleId,
          url: String(document.location && document.location.href ? document.location.href : ""),
        })
        .catch(() => {});
    } catch (_) {}
  }

  function trySendDiag(why) {
    try {
      if (_isTearingDown) {
        if (!_teardownSkipLogged) {
          _teardownSkipLogged = true;
          console.log("[TabMail Gate] Skipping tm-gate-diag sendMessage (teardown in progress)");
        }
        return;
      }

      // Avoid noisy duplicates from subframes.
      try {
        if (window.top && window.top !== window) {
          return;
        }
      } catch (_) {}

      const docEl = document.documentElement;
      const url = String(document.location && document.location.href ? document.location.href : "");
      const hasRevealedClass = !!(docEl && docEl.classList && docEl.classList.contains(REVEALED_CLASS));
      const readyState = String(document.readyState || "");

      browser.runtime
        .sendMessage({
          command: "tm-gate-diag",
          why: String(why || "unknown"),
          url,
          cycleId: state.cycleId,
          hasRevealedClass,
          readyState,
          frame: "top",
        })
        .catch(() => {});
    } catch (_) {}
  }

  function canReveal() {
    // If summary is explicitly disabled (e.g., privacy opt-out), we treat it as ready
    // so we don't blank out the message pane.
    const summaryOk = state.summaryReady || state.summaryDisabled;
    return summaryOk && state.messageBubbleReady;
  }

  function tryReveal(reason) {
    if (state.revealed) return;
    if (!canReveal()) return;
    state.revealed = true;
    console.log(
      `[TabMail Gate] Revealing message content (cycle=${state.cycleId} reason=${reason}) summaryReady=${state.summaryReady} summaryDisabled=${state.summaryDisabled} msgBubbleReady=${state.messageBubbleReady}`
    );
    revealGate(reason);
  }

  function markSummaryReady(detail) {
    if (state.summaryReady) return;
    state.summaryReady = true;
    console.log("[TabMail Gate] Summary bubble ready", detail || "");
    tryReveal("summary-ready");
  }

  function markMessageBubbleReady(detail) {
    if (state.messageBubbleReady) return;
    state.messageBubbleReady = true;
    console.log("[TabMail Gate] Message bubble ready", detail || "");
    tryReveal("message-bubble-ready");
  }

  function markSummaryDisabled(detail) {
    if (state.summaryDisabled) return;
    state.summaryDisabled = true;
    console.log("[TabMail Gate] Summary bubble disabled; will not wait for it", detail || "");
    tryReveal("summary-disabled");
  }

  const onSummaryReadyEvent = (ev) => {
    try {
      const detail = ev && ev.detail ? ev.detail : null;
      const detailCycleId = detail && typeof detail.cycleId === "number" ? detail.cycleId : null;
      if (detailCycleId != null && detailCycleId !== state.cycleId) {
        console.log(`[TabMail Gate] Ignoring summary ready for stale cycle ${detailCycleId} (current=${state.cycleId})`);
        return;
      }
      markSummaryReady(detail);
    } catch (e) {
      console.log("[TabMail Gate] summaryReady event handler failed:", e);
    }
  };

  const onMessageBubbleReadyEvent = (ev) => {
    try {
      const detail = ev && ev.detail ? ev.detail : null;
      const detailCycleId = detail && typeof detail.cycleId === "number" ? detail.cycleId : null;
      if (detailCycleId != null && detailCycleId !== state.cycleId) {
        console.log(`[TabMail Gate] Ignoring message bubble ready for stale cycle ${detailCycleId} (current=${state.cycleId})`);
        return;
      }
      markMessageBubbleReady(detail);
    } catch (e) {
      console.log("[TabMail Gate] messageBubbleReady event handler failed:", e);
    }
  };

  // Background can notify us when summary injection is skipped (e.g. privacy opt-out)
  // IMPORTANT: do NOT make this handler async (TB MV3 requirement).
  const onRuntimeMessage = (msg) => {
    try {
      if (!msg || !msg.command) return;
      if (msg.command === "tm-gate-begin-cycle") {
        beginGateCycle("runtimeMessage");
      }
      if (msg.command === "tm-gate-summary-disabled") {
        markSummaryDisabled({ from: "runtimeMessage" });
      }
      if (msg.command === "tm-gate-summary-ready") {
        markSummaryReady({ from: "runtimeMessage" });
      }
      if (msg.command === "tm-gate-message-bubble-ready") {
        markMessageBubbleReady({ from: "runtimeMessage" });
      }
    } catch (e) {
      console.log("[TabMail Gate] runtime message handler failed:", e);
    }
  };

  // Start gated by default (CSS hides body until REVEALED_CLASS is set).
  beginGateCycle("init");
  trySendDiag("init");

  // Teardown guards: pagehide/unload can happen during message swaps, window close,
  // add-on reload, or TB shutdown. Once teardown begins, stop sending runtime messages.
  let _onPageHide = null;
  let _onUnload = null;
  try {
    _onPageHide = (ev) => {
      try {
        // `persisted` true means bfcache-like; still treat as teardown for safety.
        markTearingDown(`pagehide persisted=${!!(ev && ev.persisted)}`);
      } catch (_) {}
    };
    _onUnload = () => markTearingDown("unload");
    window.addEventListener("pagehide", _onPageHide, { capture: true });
    window.addEventListener("unload", _onUnload, { capture: true });
  } catch (_) {}

  try {
    window.addEventListener("tabmail:summaryBubbleReady", onSummaryReadyEvent);
    window.addEventListener("tabmail:messageBubbleReady", onMessageBubbleReadyEvent);
  } catch (e) {
    console.log("[TabMail Gate] Failed to attach window event listeners:", e);
  }

  try {
    if (window.__tmMessageDisplayGateListener) {
      try {
        browser.runtime.onMessage.removeListener(window.__tmMessageDisplayGateListener);
      } catch (_) {}
    }
    window.__tmMessageDisplayGateListener = onRuntimeMessage;
    browser.runtime.onMessage.addListener(window.__tmMessageDisplayGateListener);
  } catch (e) {
    console.log("[TabMail Gate] Failed to attach runtime message listener:", e);
  }

  // If the other scripts were injected before us, they may have set readiness flags.
  try {
    const flags = window.__tmDisplayGateFlags || {};
    const flagsCycleId = typeof flags.cycleId === "number" ? flags.cycleId : null;
    if (flagsCycleId != null && flagsCycleId !== state.cycleId) {
      // If a previous gate cycle left flags behind, ignore them.
    } else {
      if (flags.summaryReady) markSummaryReady({ from: "preexistingFlag" });
      if (flags.messageBubbleReady) markMessageBubbleReady({ from: "preexistingFlag" });
      if (flags.summaryDisabled) markSummaryDisabled({ from: "preexistingFlag" });
    }
  } catch (e) {
    console.log("[TabMail Gate] Failed to read preexisting flags:", e);
  }

  // If we're already revealed and the message wrapper gets removed (TB replacing message body),
  // start a new cycle immediately so the new message content can't flash.
  let _mutationObserver = null;
  try {
    if (document.body && window.MutationObserver) {
      _mutationObserver = new MutationObserver((mutations) => {
        try {
          if (!state.revealed) return;
          for (const m of mutations || []) {
            const removed = Array.from(m.removedNodes || []);
            for (const n of removed) {
              try {
                if (!n || n.nodeType !== 1) continue;
                const el = n;
                if (el && el.id === MESSAGE_WRAPPER_ID) {
                  beginGateCycle("wrapper-removed");
                  return;
                }
              } catch (_) {}
            }
          }
        } catch (_) {}
      });
      _mutationObserver.observe(document.body, { childList: true });
      console.log("[TabMail Gate] MutationObserver attached for wrapper removal");
    }
  } catch (e) {
    console.log("[TabMail Gate] Failed to attach MutationObserver:", e);
  }

  window.__tmMessageDisplayGateCleanup = () => {
    try {
      markTearingDown("cleanup");
    } catch (_) {}
    try {
      // Clear timeout on cleanup
      if (_gateTimeoutTimer !== null) {
        try {
          clearTimeout(_gateTimeoutTimer);
          _gateTimeoutTimer = null;
        } catch (_) {}
      }
    } catch (_) {}
    try {
      window.removeEventListener("tabmail:summaryBubbleReady", onSummaryReadyEvent);
    } catch (_) {}
    try {
      window.removeEventListener("tabmail:messageBubbleReady", onMessageBubbleReadyEvent);
    } catch (_) {}
    try {
      if (_onPageHide) window.removeEventListener("pagehide", _onPageHide, { capture: true });
    } catch (_) {}
    try {
      if (_onUnload) window.removeEventListener("unload", _onUnload, { capture: true });
    } catch (_) {}
    try {
      if (window.__tmMessageDisplayGateListener) {
        browser.runtime.onMessage.removeListener(window.__tmMessageDisplayGateListener);
      }
    } catch (_) {}
    try {
      if (_mutationObserver) {
        try { _mutationObserver.disconnect(); } catch (_) {}
      }
    } catch (_) {}
    try {
      // Safety: on cleanup, reveal content so we don't accidentally leave the pane hidden.
      try { document.documentElement.classList.add(REVEALED_CLASS); } catch (_) {}
    } catch (_) {}
  };
})();


