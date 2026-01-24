var TabMail = TabMail || {};

Object.assign(TabMail, {
  /**
   * Runs the inline edit instruction using the existing pipeline (was previously
   * in the input keydown Enter handler). Expects wrapper and spinner from the
   * parent document and executes cleanup when finished.
   */
  _runInlineEditInstruction: async function ({
    instruction,
    wrapper,
    spinner,
  }) {
    try {
      try {
        if (wrapper) wrapper._tm_executing = true;
      } catch (_) {}
      const editor = TabMail.state.editorRef;
      if (!editor) return;

      if (!instruction || !instruction.trim()) {
        if (wrapper && typeof wrapper._tm_cleanup === "function")
          wrapper._tm_cleanup();
        return;
      }

      spinner && (spinner.style.display = "flex");
      try {
        if (wrapper && wrapper._tm_container)
          wrapper._tm_container.style.filter = "grayscale(0.9) opacity(0.6)";
      } catch (_) {}

      // Show throttle message when actual throttling happens
      let throttleOverlay = null;
      let throttleMessageEl = null;
      
      // Listen for throttle events from the background script via runtime messages
      const handleThrottleMessage = (message) => {
        if (message.type === 'tabmail-throttle-start') {
          try {
            if (!throttleOverlay && spinner) {
              console.log('[TabMail InlineEdit] Throttle started - showing message');
              // Create a bright overlay matching the spinner's size
              throttleOverlay = document.createElement("div");
              throttleOverlay.style.cssText = [
                "position: absolute",
                "inset: 0",
                "background: rgba(255,255,255,0.6)",
                "backdrop-filter: blur(2px)",
                "border-radius: inherit",
                "z-index: 3", // Above the spinner overlay
                "display: flex",
                "align-items: center",
                "justify-content: center",
              ].join(";");
              
              // Create the message text on top of the bright overlay
              throttleMessageEl = document.createElement("div");
              throttleMessageEl.innerHTML = "Taking a little longer ...<br><a href='https://tabmail.ai/pricing.html' class='throttle-link' style='color: #0060df; text-decoration: underline; cursor: pointer;'>upgrade to Pro</a> for faster compose.";
              throttleMessageEl.style.cssText = [
                "font-size: 12px",
                "font-weight: 400",
                "line-height: 1.5",
                "letter-spacing: 0.3px",
                `color: ${TabMail.config.inlineEdit.text}`,
                "text-align: center",
                "user-select: none",
              ].join(";");
              
              // Add click handler to open pricing page in default browser
              const throttleLink = throttleMessageEl.querySelector('.throttle-link');
              if (throttleLink) {
                throttleLink.addEventListener('click', async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  try {
                    const pricingUrl = "https://tabmail.ai/pricing.html";
                    await browser.tabs.create({ url: pricingUrl });
                  } catch (err) {
                    console.error("[TabMail InlineEdit] Failed to open pricing page:", err);
                  }
                });
              }
              
              throttleOverlay.appendChild(throttleMessageEl);
              spinner.appendChild(throttleOverlay);
            }
          } catch (e) {
            console.error('[TabMail InlineEdit] Error showing throttle message:', e);
          }
        } else if (message.type === 'tabmail-throttle-end') {
          try {
            if (throttleOverlay) {
              console.log('[TabMail InlineEdit] Throttle ended - removing message');
              throttleOverlay.remove();
              throttleOverlay = null;
              throttleMessageEl = null;
            }
          } catch (e) {
            console.error('[TabMail InlineEdit] Error removing throttle message:', e);
          }
        }
      };
      
      browser.runtime.onMessage.addListener(handleThrottleMessage);

      // Snapshot before (user text only)
      const { originalUserMessage: beforeText } =
        TabMail.extractUserAndQuoteTexts(editor);
      const beforeCursor = TabMail.getCursorOffsetIgnoringInserts(editor);

      // Invalidate any autocompletes/pending corrections
      if (TabMail.cancelPendingBackendRequest) {
        console.log(
          "[TabMail Edit] Cancelling pending backend request before inline edit."
        );
        TabMail.cancelPendingBackendRequest();
      }

      // Delegate to background script (uniform approach with generateCorrection)
      // If user has a selection, capture the selected text from the editor DOM.
      let selectedText = "";
      try {
        // Prefer the text captured at open to avoid accidental changes due to overlay focus
        if (wrapper && typeof wrapper._tm_selectedText === "string") {
          selectedText = wrapper._tm_selectedText;
        } else {
          // Read selection text but skip any "insert" diff spans
          selectedText = TabMail._getSelectedTextSkippingInserts();
        }
      } catch (_) {}
      
      const inlineRequestStartTime = performance.now();
      try {
        console.log(
          `[TabMail InlineEdit] Sending request to BG: bodyLen=${(beforeText || "").length} reqLen=${instruction.trim().length} selLen=${selectedText.length}`
        );
      } catch (_) {}
      
      const result = await browser.runtime.sendMessage({
        type: "runInlineComposeEdit",
        body: beforeText,
        request: instruction.trim(),
        selectedText,
      });

      const inlineRequestDuration = performance.now() - inlineRequestStartTime;
      
      if (!result || !result.body) {
        console.warn(`[TabMail InlineEdit] No edit result returned after ${inlineRequestDuration.toFixed(1)}ms`);
        if (wrapper && typeof wrapper._tm_cleanup === "function")
          wrapper._tm_cleanup();
        return;
      }

      try {
        console.log(
          `[TabMail InlineEdit] Received result in ${inlineRequestDuration.toFixed(1)}ms: resultLen=${(result.body || "").length}`
        );
        console.log(
          `[TabMail InlineEdit] ⚠️ NOTE: Token usage (including thinking tokens) is logged in background.js and edit.js`
        );
      } catch (_) {}

      let afterText = result.body;
      
      // Note: We no longer add trailing newlines here. setEditorPlainText
      // will add separator <br>s when there's a quote boundary.

      // Keep the overlay visible during text replacement; do not remove wrapper yet
      // Ensure diff restore timer is cleared.
      try {
        if (TabMail.state.diffRestoreTimer) {
          clearTimeout(TabMail.state.diffRestoreTimer);
          TabMail.state.diffRestoreTimer = null;
        }
      } catch (_) {}

      // Create click blocker during animation (used by both animation modes)
      let clickBlocker = null;
      try {
        clickBlocker = document.createElement("div");
        clickBlocker.id = "tm-inline-edit-blocker";
        clickBlocker.style.cssText = [
          "position: fixed",
          "inset: 0",
          "z-index: 10000",
          "background: transparent",
          "cursor: default",
        ].join(";");
        document.body.appendChild(clickBlocker);
        console.log("[TabMail InlineEdit] Click blocker installed");
      } catch (_) {}

      // Phase 1: Fade out the inline editor UI (spinner/input)
      const overlayFadeMs = TabMail.config.inlineEdit.diffWipeOverlayFadeMs;
      try {
        wrapper.style.transition = `opacity ${overlayFadeMs}ms ease-out`;
        wrapper.style.opacity = "0";
        console.log("[TabMail InlineEdit] Fading out inline editor UI");
      } catch (_) {}
      await new Promise((r) => setTimeout(r, overlayFadeMs));

      // Choose animation mode based on config
      const useDiffReplay = TabMail.config.inlineEdit.useDiffReplayAnimation;
      
      if (useDiffReplay) {
        // === DIFF REPLAY ANIMATION ===
        // Apply diffs one by one by directly manipulating text and re-rendering
        console.log("[TabMail InlineEdit] Starting diff replay animation");
        
        // Compute diffs between old and new text
        const diffs = TabMail.computeDiff(beforeText, afterText);
        console.log(`[TabMail InlineEdit] Computed ${diffs.length} diff segments`);
        
        const charDelay = TabMail.config.inlineEdit.diffReplayDelayMs;
        const chunkPause = TabMail.config.inlineEdit.diffReplayPauseMs;
        
        // Work with the text directly - start with old text
        let currentText = beforeText;
        // Track position in original text (for reading diffs) and current text (for editing)
        let editPos = 0;
        
        for (const diff of diffs) {
          const op = diff[0];    // -1 = delete, 0 = equal, 1 = insert
          const text = diff[1];  // the text content
          
          if (op === 0) {
            // EQUAL: just advance position, no visual change
            editPos += text.length;
          } else if (op === -1) {
            // DELETE: remove characters one by one from currentText
            console.log(`[TabMail InlineEdit] Deleting ${text.length} chars at pos ${editPos}`);
            
            for (let i = 0; i < text.length; i++) {
              // Remove one character at editPos
              currentText = currentText.slice(0, editPos) + currentText.slice(editPos + 1);
              
              // Update editor display
              try {
                TabMail.withUndoPaused(() => {
                  TabMail.setEditorPlainText(editor, currentText);
                });
                // Position cursor at the edit point
                TabMail.setCursorByOffset(editor, editPos);
              } catch (updateErr) {
                console.warn("[TabMail Edit] Update failed:", updateErr);
              }
              
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, charDelay));
            }
            // Position stays the same after deletion
            
            // Pause after delete chunk
            await new Promise((r) => setTimeout(r, chunkPause));
            
          } else if (op === 1) {
            // INSERT: add characters one by one to currentText
            console.log(`[TabMail InlineEdit] Inserting ${text.length} chars at pos ${editPos}`);
            
            for (let i = 0; i < text.length; i++) {
              // Insert one character at editPos
              const char = text[i];
              currentText = currentText.slice(0, editPos) + char + currentText.slice(editPos);
              editPos++;
              
              // Update editor display
              try {
                TabMail.withUndoPaused(() => {
                  TabMail.setEditorPlainText(editor, currentText);
                });
                // Position cursor after the inserted character
                TabMail.setCursorByOffset(editor, editPos);
              } catch (updateErr) {
                console.warn("[TabMail Edit] Update failed:", updateErr);
              }
              
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, charDelay));
            }
            
            // Pause after insert chunk
            await new Promise((r) => setTimeout(r, chunkPause));
          }
        }
        
        console.log("[TabMail InlineEdit] Diff replay animation complete");
        
      } else {
        // === TOP-TO-BOTTOM WIPE TRANSITION ===
        console.log("[TabMail InlineEdit] Starting top-to-bottom wipe transition");

        const editorStyles = window.getComputedStyle(editor);
        const quoteBoundaryNode = TabMail.getQuoteBoundaryNode(editor);
        
        // Get bounds for just the user text region (excluding quote/signature)
        let editorRect;
        let quoteStartY = null;
        if (quoteBoundaryNode) {
          const userRange = document.createRange();
          userRange.selectNodeContents(editor);
          userRange.setEndBefore(quoteBoundaryNode);
          editorRect = userRange.getBoundingClientRect();
          // Track where the quote starts for smooth animation
          quoteStartY = quoteBoundaryNode.getBoundingClientRect().top;
          console.log("[TabMail InlineEdit] Using user text region bounds, quote starts at:", quoteStartY);
        } else {
          editorRect = editor.getBoundingClientRect();
          console.log("[TabMail InlineEdit] Using full editor bounds (no quote)");
        }

        // Create overlay with the NEW text (initially clipped/hidden)
        let newTextOverlay = null;
        try {
          newTextOverlay = document.createElement("div");
          newTextOverlay.id = "tm-inline-text-overlay";
          
          // Get a solid opaque background color (computed bg might be transparent)
          let bgColor = editorStyles.backgroundColor;
          if (!bgColor || bgColor === "transparent" || bgColor === "rgba(0, 0, 0, 0)") {
            const bodyBg = window.getComputedStyle(document.body).backgroundColor;
            if (bodyBg && bodyBg !== "transparent" && bodyBg !== "rgba(0, 0, 0, 0)") {
              bgColor = bodyBg;
            } else {
              const isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
              bgColor = isDark ? "#1c1b22" : "#ffffff";
            }
          }
          console.log("[TabMail InlineEdit] Overlay background color:", bgColor);
          
          // Get blend height for soft edge effect
          const blendHeight = TabMail.config.inlineEdit.diffWipeBlendHeightPx;
          const useBlend = blendHeight > 0;
          console.log(`[TabMail InlineEdit] Blend effect: ${useBlend ? `${blendHeight}px` : "disabled"}`);
          
          // Simple approach: use clip-path for reveal, add gradient feather overlay for blend
          newTextOverlay.style.cssText = [
            "position: fixed",
            `top: ${editorRect.top}px`,
            `left: ${editorRect.left}px`,
            `width: ${editorRect.width}px`,
            `height: ${editorRect.height}px`,
            "overflow: hidden",
            `background: ${bgColor}`,
            `color: ${editorStyles.color || "black"}`,
            `font-family: ${editorStyles.fontFamily}`,
            `font-size: ${editorStyles.fontSize}`,
            `line-height: ${editorStyles.lineHeight}`,
            `padding: ${editorStyles.padding}`,
            "z-index: 9998",
            "pointer-events: none",
            "white-space: pre-wrap",
            "word-wrap: break-word",
            "clip-path: inset(0 0 100% 0)",
          ].join(";");
          newTextOverlay.textContent = afterText;
          document.body.appendChild(newTextOverlay);
          
          // Create gradient feather element for soft blend edge (follows the wipe line)
          let featherOverlay = null;
          if (useBlend) {
            featherOverlay = document.createElement("div");
            featherOverlay.id = "tm-inline-feather-overlay";
            featherOverlay.style.cssText = [
              "position: fixed",
              `top: ${editorRect.top}px`,
              `left: ${editorRect.left}px`,
              `width: ${editorRect.width}px`,
              `height: ${blendHeight}px`,
              `background: linear-gradient(to bottom, ${bgColor} 0%, transparent 100%)`,
              "z-index: 9999",
              "pointer-events: none",
              // Start above the editor (out of view)
              `transform: translateY(-${blendHeight}px)`,
            ].join(";");
            document.body.appendChild(featherOverlay);
          }
          
          // Store blend settings on element for animation
          newTextOverlay._tm_useBlend = useBlend;
          newTextOverlay._tm_featherOverlay = featherOverlay;
          newTextOverlay._tm_editorHeight = editorRect.height;
          newTextOverlay._tm_blendHeight = blendHeight;
          // Store quote info for smooth animation
          newTextOverlay._tm_quoteBoundaryNode = quoteBoundaryNode;
          newTextOverlay._tm_quoteStartY = quoteStartY;
          console.log("[TabMail InlineEdit] New text overlay created (clipped)");
        } catch (overlayErr) {
          console.warn("[TabMail Edit] Failed to create text overlay:", overlayErr);
        }

        // Wipe animation
        const wipeMs = TabMail.config.inlineEdit.diffWipeFadeMs;
        try {
          if (newTextOverlay) {
            // Force reflow to ensure initial styles are applied
            // eslint-disable-next-line no-unused-expressions
            newTextOverlay.offsetHeight;
            if (newTextOverlay._tm_featherOverlay) {
              // eslint-disable-next-line no-unused-expressions
              newTextOverlay._tm_featherOverlay.offsetHeight;
            }
            
            // Set up transitions
            newTextOverlay.style.transition = `clip-path ${wipeMs}ms ease-in-out`;
            if (newTextOverlay._tm_featherOverlay) {
              newTextOverlay._tm_featherOverlay.style.transition = `transform ${wipeMs}ms ease-in-out`;
            }
            
            // Force reflow after transition setup
            // eslint-disable-next-line no-unused-expressions
            newTextOverlay.offsetHeight;
            
            // Animate clip-path to reveal content top-to-bottom
            newTextOverlay.style.clipPath = "inset(0 0 0 0)";
            
            // Animate feather overlay to follow the wipe line
            if (newTextOverlay._tm_featherOverlay) {
              const editorHeight = newTextOverlay._tm_editorHeight;
              newTextOverlay._tm_featherOverlay.style.transform = `translateY(${editorHeight}px)`;
            }
            
            console.log(`[TabMail InlineEdit] Wiping new text down over ${wipeMs}ms${newTextOverlay._tm_useBlend ? " with blend" : ""}`);
          }
        } catch (wipeErr) {
          console.warn("[TabMail Edit] Wipe animation failed:", wipeErr);
        }

        await new Promise((r) => setTimeout(r, wipeMs));

        // Store quote's original position for FLIP animation
        const storedQuoteBoundaryNode = newTextOverlay?._tm_quoteBoundaryNode;
        const oldQuoteY = newTextOverlay?._tm_quoteStartY;

        // Apply text to editor (while still hidden behind overlay)
        try {
          TabMail.withUndoPaused(() => {
            TabMail.setEditorPlainText(editor, afterText);
          });
          console.log("[TabMail InlineEdit] New text applied to editor");
        } catch (applyErr) {
          console.warn("[TabMail Edit] Failed to apply text:", applyErr);
        }

        // FLIP animation for quote section: animate from old position to new position
        const overlayFadeMs = TabMail.config.inlineEdit.diffWipeOverlayFadeMs;
        if (storedQuoteBoundaryNode && oldQuoteY !== null) {
          try {
            const newQuoteY = storedQuoteBoundaryNode.getBoundingClientRect().top;
            const deltaY = oldQuoteY - newQuoteY;
            
            if (Math.abs(deltaY) > 1) {
              console.log(`[TabMail InlineEdit] Quote moved ${deltaY}px, animating smoothly`);
              // Invert: move quote back to where it was
              storedQuoteBoundaryNode.style.transform = `translateY(${deltaY}px)`;
              storedQuoteBoundaryNode.style.transition = "none";
              // eslint-disable-next-line no-unused-expressions
              storedQuoteBoundaryNode.offsetHeight;
              // Play: animate to final position
              storedQuoteBoundaryNode.style.transition = `transform ${overlayFadeMs}ms ease-out`;
              storedQuoteBoundaryNode.style.transform = "translateY(0)";
            }
          } catch (flipErr) {
            console.warn("[TabMail Edit] Quote FLIP animation failed:", flipErr);
          }
        }

        // Fade out overlay to smoothly reveal the actual editor underneath
        try {
          if (newTextOverlay) {
            newTextOverlay.style.transition = `opacity ${overlayFadeMs}ms ease-out`;
            if (newTextOverlay._tm_featherOverlay) {
              newTextOverlay._tm_featherOverlay.style.transition = `opacity ${overlayFadeMs}ms ease-out`;
            }
            // eslint-disable-next-line no-unused-expressions
            newTextOverlay.offsetHeight;
            newTextOverlay.style.opacity = "0";
            if (newTextOverlay._tm_featherOverlay) {
              newTextOverlay._tm_featherOverlay.style.opacity = "0";
            }
            console.log(`[TabMail InlineEdit] Fading out overlay over ${overlayFadeMs}ms`);
            await new Promise((r) => setTimeout(r, overlayFadeMs));
          }
        } catch (_) {}

        // Remove overlays and clean up quote animation
        try {
          if (newTextOverlay) {
            if (newTextOverlay._tm_featherOverlay) {
              newTextOverlay._tm_featherOverlay.remove();
            }
            newTextOverlay.remove();
            newTextOverlay = null;
          }
          // Clean up quote transform styles
          if (storedQuoteBoundaryNode) {
            storedQuoteBoundaryNode.style.transform = "";
            storedQuoteBoundaryNode.style.transition = "";
          }
        } catch (_) {}
      }

      // Remove click blocker
      try {
        if (clickBlocker) {
          clickBlocker.remove();
          clickBlocker = null;
          console.log("[TabMail InlineEdit] Click blocker removed");
        }
      } catch (_) {}

      // Finalize state and cursor
      const afterCursor = Math.min(afterText.length, beforeCursor);
      TabMail.setCursorByOffset(editor, afterCursor);
      TabMail.pushUndoSnapshot(
        beforeText,
        beforeCursor,
        afterText,
        afterCursor,
        "inline-edit"
      );

      // Clean up state - set the new text as the baseline
      TabMail.state.originalText = afterText;
      TabMail.state.correctedText = "";
      TabMail.state.isDiffActive = false;
      TabMail.state.autoHideDiff = true;

      // Final render to ensure clean state
      console.log("[TabMail RenderText] Final render after crossfade");
      TabMail.renderText(false);
      // Exit via the same path as Escape for consistent focus/cleanup behaviour
      try {
        if (typeof wrapper._tm_cleanup === "function")
          wrapper._tm_cleanup("post-stream");
      } catch (_) {}
    } catch (err) {
      console.error("[TabMail Edit] Inline edit error:", err);
    } finally {
      // Clean up message listener
      try {
        browser.runtime.onMessage.removeListener(handleThrottleMessage);
      } catch (_) {}
      // Clean up throttle message overlay if it exists
      try {
        if (throttleOverlay) {
          throttleOverlay.remove();
        }
      } catch (_) {}
      // Clean up click blocker if it still exists (error case)
      try {
        const blocker = document.getElementById("tm-inline-edit-blocker");
        if (blocker) blocker.remove();
      } catch (_) {}
      // Clean up text overlay if it still exists (error case)
      try {
        const overlay = document.getElementById("tm-inline-text-overlay");
        if (overlay) overlay.remove();
      } catch (_) {}
      try {
        if (spinner) spinner.style.display = "none";
      } catch (_) {}
      try {
        if (wrapper) wrapper._tm_executing = false;
      } catch (_) {}
      // Do not cleanup here; the diff wipe path cleans up after animation.
    }
  },
  /**
   * Programmatically cancel the inline edit dropdown if present, using the same
   * cleanup path as the input Escape handler when possible.
   */
  cancelInlineEditDropdown: function () {
    try {
      const wrapper = document.getElementById("tm-inline-edit");
      if (!wrapper) {
        console.log(
          "[TabMail Edit] cancelInlineEditDropdown: no wrapper found."
        );
        return false;
      }
      // Prefer calling the internal cleanup function if available
      if (typeof wrapper._tm_cleanup === "function") {
        console.log(
          "[TabMail Edit] cancelInlineEditDropdown: invoking wrapper cleanup."
        );
        try {
          wrapper._tm_cleanup();
          return true;
        } catch (_) {}
      }
      const input = wrapper.querySelector('input[type="text"]');
      if (input) {
        console.log(
          "[TabMail Edit] cancelInlineEditDropdown: dispatching synthetic Escape to input."
        );
        const ev = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(ev);
        return true;
      }
      // Fallback: manual cleanup (mirrors the inline cleanup() routine)
      console.log(
        "[TabMail Edit] cancelInlineEditDropdown: running manual cleanup fallback."
      );
      try {
        wrapper.remove();
      } catch (_) {}
      TabMail.state.inlineEditActive = false;
      try {
        if (TabMail.state.diffRestoreTimer) {
          clearTimeout(TabMail.state.diffRestoreTimer);
          TabMail.state.diffRestoreTimer = null;
        }
        // Set autoHideDiff to true to hide diffs and add a timeout to restore it
        TabMail.state.autoHideDiff = true;
        TabMail.state.diffRestoreTimer = setTimeout(() => {
          TabMail.state.autoHideDiff = false;
          // Update render after changing the autoHideDiff flag
          const show_diffs =
            TabMail.state.showDiff && !TabMail.state.autoHideDiff;
          console.log(
            "[TabMail RenderText] Rendering text with diffs after inline edit"
          );
          TabMail.renderText(show_diffs);
          TabMail.state.diffRestoreTimer = null;
        }, TabMail.config.DIFF_RESTORE_DELAY_MS);
      } catch (_) {}
      try {
        const editor = TabMail.state.editorRef;
        if (editor) {
          editor.focus();
          try {
            const cursor = TabMail.getCursorOffsetIgnoringInserts(editor);
            TabMail.setCursorByOffset(editor, cursor);
          } catch (_) {}
        }
      } catch (_) {}
      return true;
    } catch (err) {
      console.error("[TabMail Edit] cancelInlineEditDropdown failed:", err);
      return false;
    }
  },
  /**
   * Returns the current selection as plain text while skipping text contained
   * within diff spans marked as inserts (data-tabmail-diff="insert").
   * Mirrors getCleanedEditorTextWithOptions(..., { skipInserts: true }).
   */
  _getSelectedTextSkippingInserts: function () {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
      const range = sel.getRangeAt(0).cloneRange();
      const frag = range.cloneContents();
      const tmp = document.createElement("div");
      tmp.appendChild(frag);
      const text = TabMail.getCleanedEditorTextWithOptions(tmp, {
        skipInserts: true,
      });
      try {
        console.log(
          "[TabMail Edit] Selected text (skip inserts) length:",
          (text || "").length
        );
      } catch (_) {}
      return text || "";
    } catch (e) {
      console.warn(
        "[TabMail Edit] Failed to compute selection text skipping inserts:",
        e
      );
      return "";
    }
  },
  /**
   * Creates and shows a lightweight dropdown near the caret for inline edit instructions.
   * Disappears on blur. Ctrl/Cmd+Enter triggers the edit pipeline. Enter/Shift+Enter inserts a newline.
   */
  showInlineEditDropdown: function () {
    try {
      const editor = TabMail.state.editorRef;
      if (!editor) return;

      // Remove any existing dropdown
      const existing = document.getElementById("tm-inline-edit");
      if (existing) existing.remove();

      // Measure caret position
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0).cloneRange();
      // Capture selected text (if any) at the moment the inline editor opens
      try {
        const selectedNow = TabMail._getSelectedTextSkippingInserts();
        if (selectedNow) {
          try {
            wrapper._tm_selectedText = selectedNow;
          } catch (_) {}
          console.log(
            "[TabMail Edit] Captured selected text at open (len)",
            selectedNow.length
          );
        } else {
          try {
            wrapper._tm_selectedText = "";
          } catch (_) {}
        }
      } catch (_) {}
      const probe = document.createElement("span");
      probe.textContent = "\u200B";
      probe.style.cssText =
        "display:inline-block;width:0;height:1em;overflow:hidden;padding:0;margin:0;border:0;pointer-events:none;";
      range.insertNode(probe);
      const rect = probe.getBoundingClientRect();
      const caretLeft = rect.left;
      const caretTop = rect.bottom;
      probe.remove();

      // Build dropdown
      const wrapper = document.createElement("div");
      wrapper.id = "tm-inline-edit";
      // Streaming flag to suppress premature cleanup while we rewrite behind overlay
      try {
        wrapper._tm_streaming = false;
      } catch (_) {}
      // In Thunderbird compose, the document often runs with designMode=on.
      // Mark the dropdown wrapper non-editable so form controls can receive focus.
      wrapper.setAttribute("contenteditable", "false");
      wrapper.style.cssText = [
        "position: fixed",
        `z-index: ${TabMail.config.inlineEdit.zIndex}`,
        `max-width: ${TabMail.config.inlineEdit.maxWidthPx}px`,
        `background: ${TabMail.config.inlineEdit.background}`,
        `color: ${TabMail.config.inlineEdit.text}`,
        `border: ${TabMail.config.inlineEdit.border}`,
        `border-radius: ${TabMail.config.inlineEdit.borderRadiusPx}px`,
        `box-shadow: ${TabMail.config.inlineEdit.boxShadow}`,
        `padding: ${TabMail.config.inlineEdit.padding}`,
        `font-size: ${TabMail.config.inlineEdit.fontSizeEm}em`,
        "display: flex",
        "flex-direction: column",
        "gap: 6px",
      ].join(";");

      // Build isolated focus container using an overlay iframe to avoid
      // designMode caret conflicts with the compose editor.
      const iframe = document.createElement("iframe");
      iframe.style.cssText = [
        "border: none",
        "width: 100%",
        // Height will be adjusted dynamically based on textarea content
        "height: auto",
        "background: transparent",
      ].join(";");
      const input = document.createElement("input");
      input.type = "text";
      // Use only ARIA label to avoid native placeholder duplication under designMode.
      // Visual placeholder is handled by overlay label below.
      input.placeholder = "";
      input.setAttribute("aria-label", "Describe your edit");
      // Ensure explicit focusability even under designMode.
      input.setAttribute("tabindex", "0");
      input.style.cssText = [
        "flex:1",
        "min-width: 240px",
        "background: transparent",
        "border: none",
        "outline: none",
        `color: ${TabMail.config.inlineEdit.text}`,
        "font: inherit",
        "position: relative",
        "z-index: 1",
        // Force caret visibility for input even in designMode contexts
        `caret-color: ${TabMail.config.inlineEdit.caretColor}`,
      ].join(";");

      const spinner = document.createElement("div");
      spinner.className = "tm-inline-overlay";
      spinner.style.cssText = [
        "position:absolute",
        "inset:0",
        "display:none",
        "align-items:center",
        "justify-content:center",
        "backdrop-filter: blur(1px)",
        "background: rgba(0,0,0,0.25)",
        "border-radius: inherit",
        "z-index: 2",
      ].join(";");
      const spinnerInner = document.createElement("div");
      spinnerInner.className = "tm-inline-spinner";
      spinnerInner.style.cssText = [
        "width: 28px",
        "height: 28px",
        "border-radius: 50%",
        "border: 3px solid rgba(255,255,255,0.2)",
        "border-top-color: rgba(255,255,255,0.9)",
        "animation: tmspin 1s linear infinite",
      ].join(";");
      spinner.appendChild(spinnerInner);

      // Create a placeholder label overlayed above the input when empty.
      const placeholderLabel = document.createElement("div");
      placeholderLabel.textContent = "Describe your edit…";
      placeholderLabel.style.cssText = [
        "position: absolute",
        "pointer-events: none",
        "opacity: 0.6",
        "left: 12px",
        "right: 12px",
        // Align to top for multiline
        "top: 8px",
        "transform: none",
        "white-space: normal",
        "overflow: hidden",
        "text-overflow: ellipsis",
      ].join(";");

      const container = document.createElement("div");
      container.style.cssText = [
        "position: relative",
        "flex: 1",
        "min-width: 240px",
        "display: flex",
        "align-items: stretch",
        // Isolate selection/caret painting from designMode artifacts.
        `caret-color: ${TabMail.config.inlineEdit.caretColor}`,
      ].join(";");
      container.appendChild(iframe);
      // expose container for external styling during processing
      try {
        wrapper._tm_container = container;
      } catch (_) {}

      // Top row: input container + spinner
      const topRow = document.createElement("div");
      topRow.style.cssText = [
        "display:flex",
        "gap:8px",
        "align-items:stretch",
      ].join(";");
      topRow.appendChild(container);
      topRow.appendChild(spinner);
      wrapper.appendChild(topRow);

      // Hint row
      const hint = document.createElement("div");
      try {
        const isMac = navigator.platform && /Mac/i.test(navigator.platform);
        const execCmd = TabMail.config.keys.inlineEditExecuteCmd;
        const execCtrl = TabMail.config.keys.inlineEditExecuteCtrl;
        let hintText = "";
        if (isMac && execCmd && execCmd.key === "Enter") {
          hintText = "Press ⌘ Enter to edit";
        } else if (execCtrl && execCtrl.key === "Enter") {
          hintText = "Press Ctrl Enter to edit";
        } else {
          hintText = "Press Enter to edit";
        }
        hint.textContent = hintText;
      } catch (_) {
        hint.textContent = "Press Enter to edit";
      }
      hint.style.cssText = [
        "font-size: 0.85em",
        "opacity: 0.7",
        "user-select: none",
        "padding-left: 2px",
        "color: currentColor",
      ].join(";");
      wrapper.appendChild(hint);

      document.body.appendChild(wrapper);

      // Prepare focus grace helpers early so focus code can call them safely
      let focusGraceUntil = 0;
      const armFocusGrace = () => {
        focusGraceUntil =
          Date.now() + (TabMail.config.inlineEdit.focusGraceMs || 0);
      };
      // While inline is active and we are using designMode toggling, hide the editor's
      // caret to prevent dual-caret visuals. Restore on cleanup.
      try {
        const editorEl = TabMail.state.editorRef;
        if (editorEl) {
          if (!editorEl.dataset._tmPrevCaretColor) {
            editorEl.dataset._tmPrevCaretColor =
              editorEl.style.caretColor || "";
          }
          editorEl.style.caretColor = "transparent";
          console.log(
            "[TabMail Edit] Editor caret hidden while inline active."
          );
        }
      } catch (hideCaretErr) {
        console.warn(
          "[TabMail Edit] Unable to hide editor caret:",
          hideCaretErr
        );
      }

      // Positioning
      const margin = TabMail.config.inlineEdit.marginPx;
      const vw = Math.max(
        document.documentElement.clientWidth,
        window.innerWidth || 0
      );
      const vh = Math.max(
        document.documentElement.clientHeight,
        window.innerHeight || 0
      );
      const rect2 = wrapper.getBoundingClientRect();
      let left = Math.min(Math.max(8, caretLeft), vw - rect2.width - 8);
      let top = Math.min(caretTop + margin, vh - rect2.height - 8);
      wrapper.style.left = `${left}px`;
      wrapper.style.top = `${top}px`;

      // Initialize iframe document
      try {
        const idoc = iframe.contentDocument;
        const ibody = idoc.body;
        // Basic styles for textarea and overlay placeholder in iframe
        const style = idoc.createElement("style");
        const lineH = TabMail.config.inlineEdit.lineHeightPx;
        const maxLines = TabMail.config.inlineEdit.maxLines;
        const fontSizeEm = TabMail.config.inlineEdit.fontSizeEm || 1;
        // Compute themed colors from wrapper so iframe matches TB theme
        let resolvedTextColor = "#fff";
        try {
          const cs = window.getComputedStyle(wrapper);
          resolvedTextColor = cs.color || resolvedTextColor;
        } catch (_) {}
        const initialPadV = 12; // sync with textarea padding 6px top/bottom
        const initialH = lineH + initialPadV; // 1 line + vertical padding
        style.textContent = `
          :root { --tm-inline-text: ${resolvedTextColor}; }
          html, body { margin: 0; padding: 0; background: transparent; color: var(--tm-inline-text); font-size: ${fontSizeEm}em; overflow: hidden; }
          .box { position: relative; display: block; font: inherit; color: var(--tm-inline-text); }
          textarea { display:block; width:100%; min-width: 240px; background: transparent; border: none; outline: none; color: var(--tm-inline-text); font: inherit; position: relative; z-index: 1; caret-color: currentColor; resize: none; line-height: ${lineH}px; padding: 6px 10px; box-sizing: border-box; height: ${initialH}px; overflow-y: hidden; white-space: pre-wrap; word-break: break-word; scrollbar-gutter: stable both-edges; overscroll-behavior-y: contain; }
          .ph { position: absolute; pointer-events: none; opacity: 0.6; left: 12px; right: 12px; top: 8px; transform: none; white-space: normal; overflow: hidden; text-overflow: ellipsis; color: var(--tm-inline-text); }
        `;
        idoc.head.appendChild(style);
        // Inject keyframes for spinner into top document once
        try {
          if (!document.getElementById("tm-inline-keyframes")) {
            const s = document.createElement("style");
            s.id = "tm-inline-keyframes";
            s.textContent =
              "@keyframes tmspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
            (document.head || document.documentElement).appendChild(s);
            TabMail.log.debug('inlineEdit', "Injected spinner keyframes");
          }
        } catch (_) {}
        const ibox = idoc.createElement("div");
        ibox.className = "box";
        const iinput = idoc.createElement("textarea");
        iinput.setAttribute("rows", "1");
        iinput.placeholder = "";
        const iph = idoc.createElement("div");
        iph.className = "ph";
        iph.textContent = "Describe your edit…";
        ibox.appendChild(iinput);
        ibox.appendChild(iph);
        ibody.appendChild(ibox);

        const refreshPh = () => {
          const show = !iinput.value;
          iph.style.display = show ? "block" : "none";
          // try {
          //   console.log(
          //     "[TabMail Edit] Placeholder",
          //     show ? "shown" : "hidden"
          //   );
          // } catch (_) {}
        };
        iinput.addEventListener("input", refreshPh);
        iinput.addEventListener("keydown", () => refreshPh(), true);
        refreshPh();

        // Dynamic autosize up to maxLines; then enable scroll
        // Sticky scroll flag to avoid rapid overflow toggling at the boundary
        let scrolledSticky = false;
        const autoResize = () => {
          try {
            iinput.style.height = "auto";
            const cs =
              idoc.defaultView && idoc.defaultView.getComputedStyle
                ? idoc.defaultView.getComputedStyle(iinput)
                : null;
            const padTop = cs ? parseFloat(cs.paddingTop) || 0 : 0;
            const padBottom = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
            const padV = padTop + padBottom;
            let computedLH = cs ? parseFloat(cs.lineHeight) || lineH : lineH;
            if (!isFinite(computedLH) || computedLH <= 0) computedLH = lineH;
            const maxScroll = computedLH * maxLines + padV;
            // Use scrollHeight - padding to get content height, then add padding back for final height
            const contentH = iinput.scrollHeight - padV;
            const baseline = Math.ceil(computedLH); // 1 line content baseline
            const full = Math.max(contentH, baseline) + padV; // final desired height including padding
            const clamped = Math.min(full, Math.ceil(maxScroll));
            // Add hysteresis to avoid jitter near boundary
            const EPS = 2; // pixels tolerance
            const rawWillScroll = full > maxScroll;
            if (rawWillScroll) scrolledSticky = true;
            // Once scrolled, keep it until significantly below cap
            if (full < maxScroll - 4 * EPS) scrolledSticky = false;
            const willScroll = rawWillScroll || scrolledSticky;
            iinput.style.height = clamped + "px";
            iinput.style.overflowY = willScroll ? "auto" : "hidden";
            iframe.style.height = clamped + "px";
            // If scrolling, keep caret at bottom when typing at the end to avoid jitter
            if (willScroll) {
              try {
                iinput.scrollTop = iinput.scrollHeight;
              } catch (_) {}
            }
            // console.log("[TabMail Edit] Inline textarea resized", {
            //   lineHCfg: lineH,
            //   computedLH,
            //   maxLines,
            //   padV,
            //   contentH,
            //   baseline,
            //   full,
            //   clamped,
            //   maxScroll,
            //   rawWillScroll,
            //   scrolledSticky,
            //   willScroll,
            // });
            // Reposition wrapper if it overflows viewport after resize
            try {
              const vw = Math.max(
                document.documentElement.clientWidth,
                window.innerWidth || 0
              );
              const vh = Math.max(
                document.documentElement.clientHeight,
                window.innerHeight || 0
              );
              const r = wrapper.getBoundingClientRect();
              let didAdjust = false;
              if (r.right > vw - 8) {
                const left2 = Math.max(8, vw - r.width - 8);
                wrapper.style.left = left2 + "px";
                didAdjust = true;
              }
              if (r.bottom > vh - 8) {
                const top2 = Math.max(8, vh - r.height - 8);
                wrapper.style.top = top2 + "px";
                didAdjust = true;
              }
              if (didAdjust)
                console.log(
                  "[TabMail Edit] Repositioned wrapper to avoid viewport overflow"
                );
            } catch (_) {}
          } catch (e) {
            console.warn("[TabMail Edit] Inline textarea resize failed:", e);
          }
        };
        // Hide placeholder early on any text-producing input
        iinput.addEventListener(
          "beforeinput",
          (e) => {
            try {
              if (e && e.data && e.data.length > 0) {
                iph.style.display = "none";
              }
            } catch (_) {}
          },
          true
        );

        iinput.addEventListener("input", () => {
          autoResize();
          refreshPh();
          setTimeout(() => {
            autoResize();
            refreshPh();
          }, 0);
        });
        // Run resize after first paint to avoid flicker
        requestAnimationFrame(() => {
          autoResize();
        });

        // Key handling: Config-driven execute (Cmd/Ctrl+Enter), Enter inserts newline
        iinput.addEventListener(
          "keydown",
          (ev) => {
            // If this key will insert a printable character or newline, hide placeholder immediately
            try {
              const k = ev.key;
              const isPrintable =
                k && k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
              const isNewline =
                k === "Enter" && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
              if (isPrintable || isNewline) {
                iph.style.display = "none";
              }
            } catch (_) {}
            if (
              ev.key === "Escape" &&
              !ev.shiftKey &&
              !ev.ctrlKey &&
              !ev.altKey &&
              !ev.metaKey
            ) {
              ev.preventDefault();
              ev.stopPropagation();
              try {
                if (typeof wrapper._tm_cleanup === "function")
                  wrapper._tm_cleanup();
              } catch (_) {}
              try {
                const parentWin =
                  wrapper.ownerDocument && wrapper.ownerDocument.defaultView;
                if (parentWin) parentWin.focus();
                const editor = TabMail.state && TabMail.state.editorRef;
                if (editor) editor.focus();
              } catch (_) {}
              return;
            }
            const isExecute = !!(
              TabMail._isKeyMatch &&
              (TabMail._isKeyMatch(
                ev,
                TabMail.config.keys.inlineEditExecuteCmd
              ) ||
                TabMail._isKeyMatch(
                  ev,
                  TabMail.config.keys.inlineEditExecuteCtrl
                ))
            );
            if (isExecute) {
              ev.preventDefault();
              ev.stopPropagation();
              const val = (iinput.value || "").trim();
              TabMail.log.debug('inlineEdit', "Inline execute via Ctrl/Cmd+Enter");
              TabMail._runInlineEditInstruction({
                instruction: val,
                wrapper,
                spinner,
              });
              return;
            }
            // Allow Enter/Shift+Enter to insert newline, but stop propagation to parent
            if (ev.key === "Enter") {
              ev.stopPropagation();
              return;
            }
            // Stop bubbling to parent document to avoid global handlers
            ev.stopPropagation();
          },
          true
        );

        // Events are inside an iframe; top document won't see them, so no need to swallow here.

        // Click focus inside iframe shouldn't close the wrapper
        idoc.addEventListener("mousedown", (e) => e.stopPropagation(), true);

        // Focus the iinput and place caret
        try {
          iinput.focus();
          const p = iinput.value.length;
          iinput.setSelectionRange(p, p);
        } catch (_) {}

        // Expose a ref for testing or future use
        wrapper._tm_iinput = iinput;
      } catch (iframeInitErr) {
        console.warn(
          "[TabMail Edit] Failed to initialize iframe inline input:",
          iframeInitErr
        );
      }

      // Focus flow – temporarily toggle document.designMode off→on
      input.setAttribute("autofocus", "true");
      let prevDesignMode = null;
      let didToggleDesignMode = false;
      try {
        prevDesignMode = document.designMode;
        if (prevDesignMode === "on") {
          document.designMode = "off";
          didToggleDesignMode = true;
          console.log(
            "[TabMail Edit] Temporarily toggled designMode off to focus dropdown input."
          );
        }
      } catch (dmErr) {
        console.warn("[TabMail Edit] Could not toggle designMode:", dmErr);
      }

      try {
        input.focus();
        armFocusGrace();
      } catch (_) {}
      // Second chance focus on next tick.
      setTimeout(() => {
        try {
          input.focus();
          armFocusGrace();
        } catch (_) {}
        // Optionally keep designMode off while inline edit is open to avoid caret swap
        // and restore on cleanup.
        try {
          // Record for cleanup scope
          wrapper.dataset._prevDesignMode = prevDesignMode || "";
          wrapper.dataset._didToggleDesignMode = didToggleDesignMode
            ? "1"
            : "0";
          console.log(
            "[TabMail Edit] Locking designMode off during inline edit."
          );
        } catch (_) {}
        // Extra refocus after a short delay to bring back caret if it vanished on restore.
        setTimeout(() => {
          try {
            input.focus();
            armFocusGrace();
          } catch (_) {}
        }, TabMail.config.inlineEdit.focusRefocusMs || 0);
      }, 0);

      try {
        const ae = document.activeElement;
        TabMail.log.debug('inlineEdit', "Inline dropdown focus requested.", {
          activeElementTag: ae && ae.tagName,
          activeElementId: ae && ae.id,
          isInsideWrapper: !!(ae && wrapper.contains(ae)),
          designMode: document.designMode,
          hasFocus: document.hasFocus(),
        });
      } catch (focusLogErr) {
        console.warn(
          "[TabMail Edit] Could not log activeElement after focus:",
          focusLogErr
        );
      }

      // Instrument focus/blur on the input to trace focus churn.
      const refreshPlaceholderVisibility = () => {
        try {
          const show = !input.value;
          placeholderLabel.style.display = show ? "block" : "none";
        } catch (_) {}
      };

      input.addEventListener(
        "focus",
        (ev) => {
          try {
            TabMail.log.debug('inlineEdit', "Inline input focused.", {
              targetTag: ev.target && ev.target.tagName,
              activeElementId:
                document.activeElement && document.activeElement.id,
            });
            refreshPlaceholderVisibility();
            // Force caret to be visible and at end if selection is null.
            try {
              const pos =
                typeof input.selectionStart === "number"
                  ? input.selectionStart
                  : input.value.length;
              input.setSelectionRange(pos, pos);
            } catch (_) {}
          } catch (_) {}
        },
        true
      );
      input.addEventListener(
        "blur",
        (ev) => {
          try {
            TabMail.log.debug('inlineEdit', "Inline input blurred.", {
              relatedTargetTag: ev.relatedTarget && ev.relatedTarget.tagName,
            });
          } catch (_) {}
        },
        true
      );
      input.addEventListener("input", () => {
        refreshPlaceholderVisibility();
      });
      // Hide placeholder while typing keys are redirected from document level
      input.addEventListener(
        "keydown",
        () => {
          refreshPlaceholderVisibility();
        },
        true
      );
      // Ensure initial state is correct
      refreshPlaceholderVisibility();

      // Outside-click and outside-focus detection, with focus-grace period to
      // absorb the temporary blur caused by designMode toggling.
      // Arm grace right after showing.
      armFocusGrace();

      const onDocMouseDown = (ev) => {
        try {
          if (
            wrapper._tm_streaming === true ||
            wrapper._tm_executing === true
          ) {
            console.log(
              "[TabMail Edit] Suppressing outside mousedown during streaming/executing."
            );
            return;
          }
          if (!wrapper.contains(ev.target)) {
            cleanup("document-mousedown");
          }
        } catch (_) {}
      };
      const onDocFocusIn = (ev) => {
        try {
          if (
            wrapper._tm_streaming === true ||
            wrapper._tm_executing === true
          ) {
            console.log(
              "[TabMail Edit] Suppressing focusin during streaming/executing.",
              {
                targetTag: ev && ev.target && ev.target.tagName,
              }
            );
            return;
          }
          if (ev && ev.target) {
            TabMail.log.debug('inlineEdit', "focusin detected.", {
              targetTag: ev.target.tagName,
              targetId: ev.target.id,
              insideWrapper: wrapper.contains(ev.target),
              withinGrace: Date.now() < focusGraceUntil,
            });
          }
          if (!wrapper.contains(ev.target)) {
            // If we are within the grace window, ignore this first focus shift.
            if (Date.now() < focusGraceUntil) {
              return;
            }
            cleanup("document-focusin");
          }
        } catch (_) {}
      };
      document.addEventListener("mousedown", onDocMouseDown, true);
      document.addEventListener("focusin", onDocFocusIn, true);

      const cleanup = (reason = "unknown") => {
        TabMail.log.debug('inlineEdit', "Cleaning up inline edit.", { reason });
        try {
          wrapper.remove();
        } catch {}
        // leave inline edit mode; allow normal rendering to resume
        TabMail.state.inlineEditActive = false;
        // Restore editor caret visibility
        try {
          const editorEl = TabMail.state.editorRef;
          if (editorEl) {
            const prev = editorEl.dataset._tmPrevCaretColor || "";
            editorEl.style.caretColor = prev;
            delete editorEl.dataset._tmPrevCaretColor;
            TabMail.log.debug('inlineEdit', "Editor caret restored after inline.");
          }
        } catch (showCaretErr) {
          console.warn(
            "[TabMail Edit] Unable to restore editor caret:",
            showCaretErr
          );
        }
        // If we locked designMode during inline edit, restore it now.
        try {
          const prev = wrapper.dataset._prevDesignMode || null;
          const did = wrapper.dataset._didToggleDesignMode === "1";
          if (did && prev != null) {
            document.designMode = prev;
            console.log(
              "[TabMail Edit] Restored designMode on cleanup to:",
              prev
            );
          }
        } catch (dmCleanupErr) {
          console.warn(
            "[TabMail Edit] Failed to restore designMode on cleanup:",
            dmCleanupErr
          );
        }
        // After closing, re-arm caret painter without changing selection:
        try {
          const editor = TabMail.state.editorRef;
          if (editor) {
            editor.focus();
          }
        } catch (restoreErr) {
          console.warn(
            "[TabMail Edit] Could not restore editor focus after inline edit:",
            restoreErr
          );
        }
        // Simulate a "user stopped typing" tick: schedule diff restore after timeout if diffs are enabled
        try {
          if (TabMail.state.diffRestoreTimer) {
            clearTimeout(TabMail.state.diffRestoreTimer);
            TabMail.state.diffRestoreTimer = null;
          }
          // enable autoHideDiff to hide diffs and then restore it after the timeout
          TabMail.state.autoHideDiff = true;
          TabMail.state.diffRestoreTimer = setTimeout(() => {
            TabMail.state.autoHideDiff = false;
            const show_diffs =
              TabMail.state.showDiff && !TabMail.state.autoHideDiff;
            console.log(
              "[TabMail RenderText] Rendering text with diffs after inline edit"
            );
            TabMail.renderText(show_diffs);
            TabMail.state.diffRestoreTimer = null;
          }, TabMail.config.DIFF_RESTORE_DELAY_MS);
        } catch (_) {}
        try {
          document.removeEventListener("mousedown", onDocMouseDown, true);
          document.removeEventListener("focusin", onDocFocusIn, true);
        } catch (_) {}
      };
      // Expose cleanup for external cancellation (e.g., global Escape)
      try {
        wrapper._tm_cleanup = cleanup;
      } catch (_) {}

      // Legacy fallback: if wrapper itself ever blurs and focus isn't inside, close
      wrapper.addEventListener(
        "blur",
        () => {
          setTimeout(() => {
            const ae = document.activeElement;
            // Ignore blur during grace period; only cleanup when outside grace
            // and focus truly left the wrapper.
            if (Date.now() < focusGraceUntil) return;
            if (
              wrapper._tm_streaming === true ||
              wrapper._tm_executing === true
            )
              return;
            if (!wrapper.contains(ae)) cleanup("wrapper-blur");
          }, 0);
        },
        true
      );

      // If the user clicks outside, cleanup will run; but a direct click on the input
      // should focus without toggling designMode. Add a mousedown that focuses the input
      // immediately to ensure caret lands even under designMode.
      input.addEventListener(
        "mousedown",
        (ev) => {
          try {
            ev.stopPropagation();
            // Focus asap
            input.focus();
          } catch (_) {}
        },
        true
      );

      // Stop key events inside the dropdown from bubbling to document handlers,
      // so Tab/Enter/Escape behave as intended in the input.
      wrapper.addEventListener(
        "keydown",
        (ev) => {
          try {
            if (wrapper.contains(ev.target)) {
              // Let input-level handler process Enter/Escape. Always stop bubbling to global.
              ev.stopPropagation();
              // Do not preventDefault here except when needed; keep native typing.
            }
          } catch (_) {}
        },
        true
      );

      input.addEventListener("keydown", async (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          cleanup();
          return;
        }
        const isExecuteTop = !!(
          TabMail._isKeyMatch &&
          (TabMail._isKeyMatch(ev, TabMail.config.keys.inlineEditExecuteCmd) ||
            TabMail._isKeyMatch(ev, TabMail.config.keys.inlineEditExecuteCtrl))
        );
        if (isExecuteTop) {
          ev.preventDefault();
          ev.stopPropagation();

          const instruction = (input.value || "").trim();
          if (!instruction) {
            cleanup();
            return;
          }

          try {
            // Delegate complete execute+stream flow to the shared helper
            await TabMail._runInlineEditInstruction({
              instruction,
              wrapper,
              spinner,
            });
          } catch (err) {
            console.error("[TabMail Edit] Inline edit error:", err);
          } finally {
            // cleanup handled via escape path above
          }
          return;
        }
        // Allow Enter/Shift+Enter to be a normal newline in the actual textarea (handled inside iframe)
        if (ev.key === "Enter") {
          ev.stopPropagation();
        }
      });
    } catch (e) {
      console.error("[TabMail Edit] Failed to show inline edit dropdown:", e);
    }
  },
});
