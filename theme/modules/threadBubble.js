// TabMail Thread Bubble Renderer (TB 145 / MV3)
// Renders related thread messages as Gmail-like conversation bubbles.
// Loaded BEFORE messageBubble.js so the render function is available.

(function () {
  // Get dependencies from globalThis
  const CFG = globalThis.TabMailMessageBubbleConfig || {};
  const QuoteDetect = globalThis.TabMailQuoteDetection;

  // IDs and class names from config
  const WRAPPER_ID = CFG.WRAPPER_ID || 'tm-message-bubble-wrapper';
  const THREAD_CONTAINER_ID = CFG.THREAD_CONTAINER_ID || 'tm-thread-conversation';

  // Quote class names
  const Q = CFG.QUOTE_CLASSES || {};
  const QUOTE_TOGGLE_CLASS = Q.toggle || 'tm-quote-toggle';
  const QUOTE_COLLAPSED_CLASS = Q.collapsed || 'tm-quote-collapsed';
  const QUOTE_WRAPPER_CLASS = Q.wrapper || 'tm-quote-wrapper';
  const QUOTE_CONTENT_CLASS = Q.content || 'tm-quote-content';

  // Thread class names
  const TC = CFG.THREAD_CLASSES || {};
  const THREAD_HEADER_RIGHT_CLASS = TC.headerRight || 'tm-thread-header-right';
  const THREAD_ACTIONS_CLASS = TC.actions || 'tm-thread-actions';
  const THREAD_ACTION_BTN_CLASS = TC.actionBtn || 'tm-thread-action-btn';

  // Thread bubble font scale config
  const T = CFG.THREAD_BUBBLE_UI || {};

  // No font CSS vars: typography is fully defined in messageBubbleStyles.js using
  // system font presets + keyword sizing (smaller/larger/medium).

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper Functions
  // ─────────────────────────────────────────────────────────────────────────────

  function getThreadTagCssVarName(actionTagId) {
    const t = String(actionTagId || '');
    if (t === 'tm_reply') return '--tag-tm-reply';
    if (t === 'tm_archive') return '--tag-tm-archive';
    if (t === 'tm_delete') return '--tag-tm-delete';
    if (t === 'tm_none') return '--tag-tm-none';
    return '--tag-tm-untagged';
  }

  function requestThreadComposeAction(action, messageId) {
    try {
      const id = typeof messageId === 'number' ? messageId : Number(messageId);
      console.log(`[TabMail ThreadBubble] Action click: action=${action} id=${id}`);
      if (!Number.isFinite(id)) {
        console.log('[TabMail ThreadBubble] Action ignored: invalid messageId');
        return;
      }
      browser.runtime
        .sendMessage({
          command: 'tm-thread-compose-action',
          action,
          messageId: id,
        })
        .then((res) => {
          console.log(`[TabMail ThreadBubble] Compose action result action=${action} id=${id}:`, res);
        })
        .catch((e) => {
          console.log(`[TabMail ThreadBubble] Compose action failed action=${action} id=${id}: ${e}`);
        });
    } catch (e) {
      console.log(`[TabMail ThreadBubble] requestThreadComposeAction threw: ${e}`);
    }
  }

  function requestThreadMarkRead(messageId, reason) {
    try {
      const id = typeof messageId === 'number' ? messageId : Number(messageId);
      if (!Number.isFinite(id)) return;
      browser.runtime
        .sendMessage({
          command: 'tm-thread-mark-read',
          messageId: id,
          reason: String(reason || ''),
        })
        .then((res) => {
          console.log(`[TabMail ThreadBubble] markRead result id=${id}:`, res);
        })
        .catch((e) => {
          console.log(`[TabMail ThreadBubble] markRead failed id=${id}: ${e}`);
        });
    } catch (e) {
      console.log(`[TabMail ThreadBubble] requestThreadMarkRead threw: ${e}`);
    }
  }

  function splitBodyForQuote(text) {
    try {
      if (QuoteDetect && QuoteDetect.splitPlainTextForQuote) {
        const r = QuoteDetect.splitPlainTextForQuote(text, { includeForward: false });
        return { main: r.main, quote: r.quote, signature: r.signature || "" };
      }
      return { main: String(text || "").trimEnd(), quote: "", signature: "" };
    } catch (e) {
      console.log(`[TabMail ThreadBubble] splitBodyForQuote failed: ${e}`);
      return { main: String(text || ""), quote: "", signature: "" };
    }
  }

  function formatFileSize(bytes) {
    try {
      const b = typeof bytes === 'number' ? bytes : 0;
      if (b === 0) return '';
      if (b < 1024) return `${b} B`;
      if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
      return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    } catch (_) {
      return '';
    }
  }

  function getAttachmentIcon(contentType) {
    try {
      const ct = String(contentType || '').toLowerCase();
      if (ct.startsWith('image/')) return '🖼️';
      if (ct.startsWith('video/')) return '🎬';
      if (ct.startsWith('audio/')) return '🎵';
      if (ct.includes('pdf')) return '📄';
      if (ct.includes('zip') || ct.includes('compressed') || ct.includes('archive')) return '📦';
      if (ct.includes('spreadsheet') || ct.includes('excel') || ct.includes('csv')) return '📊';
      if (ct.includes('presentation') || ct.includes('powerpoint')) return '📽️';
      if (ct.includes('word') || ct.includes('document')) return '📝';
      if (ct.startsWith('text/')) return '📃';
      return '📎';
    } catch (_) {
      return '📎';
    }
  }

  function requestAttachmentDownload(messageId, partName, filename) {
    try {
      const id = typeof messageId === 'number' ? messageId : Number(messageId);
      console.log(`[TabMail ThreadBubble] Attachment download: messageId=${id} partName=${partName} filename=${filename}`);
      if (!Number.isFinite(id) || !partName) {
        console.log('[TabMail ThreadBubble] Attachment download ignored: invalid messageId or partName');
        return;
      }
      browser.runtime
        .sendMessage({
          command: 'tm-thread-download-attachment',
          messageId: id,
          partName: String(partName),
          filename: String(filename || 'attachment'),
        })
        .then((res) => {
          console.log(`[TabMail ThreadBubble] Attachment download result messageId=${id}:`, res);
        })
        .catch((e) => {
          console.log(`[TabMail ThreadBubble] Attachment download failed messageId=${id}: ${e}`);
        });
    } catch (e) {
      console.log(`[TabMail ThreadBubble] requestAttachmentDownload threw: ${e}`);
    }
  }

  function formatDate(date) {
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const isThisYear = date.getFullYear() === now.getFullYear();

    if (isToday) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } else if (isThisYear) {
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main Render Function
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Render related thread messages as conversation bubbles below the main content.
   * @param {Array} threadMessages - Array of message objects, oldest first
   */
  function renderThreadConversation(threadMessages) {
    console.log(`[TabMail ThreadBubble] Rendering ${threadMessages?.length || 0} messages`);

    if (!threadMessages || threadMessages.length === 0) {
      console.log('[TabMail ThreadBubble] No thread messages to render');
      return;
    }

    // Remove existing thread container if any
    const existing = document.getElementById(THREAD_CONTAINER_ID);
    if (existing) {
      existing.remove();
    }

    // Create thread container
    const container = document.createElement('div');
    container.id = THREAD_CONTAINER_ID;
    container.className = 'tm-thread-container';

    // Typography is CSS-only (no JS sizing/vars).

    // Render each message as a bubble (newest first, reverse chronological order)
    const reversedMessages = [...threadMessages].reverse();
    reversedMessages.forEach((msg, idx) => {
      try {
        const bubble = document.createElement('div');
        bubble.className = 'tm-thread-bubble tm-thread-collapsed';
        try {
          const weId = msg?.weId;
          if (weId != null) {
            bubble.dataset.tmWeId = String(weId);
          }
        } catch (_) {}

        // Read/unread UI state
        try {
          const isRead = !!msg?.read;
          bubble.classList.add(isRead ? 'tm-thread-is-read' : 'tm-thread-is-unread');
        } catch (_) {}

        // Action tag color -> per-bubble CSS variable (palette-driven)
        try {
          const actionTagId = msg?.actionTagId || null;
          const cssVarName = getThreadTagCssVarName(actionTagId);
          bubble.style.setProperty('--tm-thread-tag-color', `var(${cssVarName})`);
          console.log(
            `[TabMail ThreadBubble] Tag color: weId=${msg?.weId} actionTagId=${actionTagId || "(none)"} cssVar=${cssVarName}`
          );
        } catch (eTag) {
          console.log(`[TabMail ThreadBubble] Failed setting tag color var: ${eTag}`);
        }

        try {
          if (msg && msg.previewLines != null) {
            bubble.style.setProperty('--tm-thread-preview-lines', String(msg.previewLines));
          } else {
            console.log('[TabMail ThreadBubble] previewLines missing; preview clamp disabled');
          }
        } catch (_) {}

        // Header with from/date (metadata)
        const header = document.createElement('div');
        header.className = 'tm-thread-header';

        const fromEl = document.createElement('span');
        fromEl.className = 'tm-thread-from';
        fromEl.textContent = msg.from || 'Unknown';

        const dateEl = document.createElement('span');
        dateEl.className = 'tm-thread-date';
        const dateObj = msg.date ? new Date(msg.date) : null;
        dateEl.textContent = dateObj ? formatDate(dateObj) : '';

        // Attachment indicator next to sender name (shown when collapsed)
        const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
        if (attachments.length > 0) {
          const attachIndicator = document.createElement('span');
          attachIndicator.className = 'tm-thread-attachment-indicator';
          attachIndicator.textContent = `📎 ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}`;
          fromEl.appendChild(document.createTextNode(' '));
          fromEl.appendChild(attachIndicator);
        }

        const right = document.createElement('div');
        right.className = THREAD_HEADER_RIGHT_CLASS;
        right.appendChild(dateEl);

        const actions = document.createElement('div');
        actions.className = THREAD_ACTIONS_CLASS;

        function makeActionButton(action, label) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = THREAD_ACTION_BTN_CLASS;
          btn.setAttribute('data-action', String(action));
          btn.textContent = label;
          btn.title = label;
          btn.addEventListener('click', (e) => {
            try {
              e.preventDefault();
              e.stopPropagation();
            } catch (_) {}
            requestThreadComposeAction(action, msg?.weId);
          });
          return btn;
        }

        actions.appendChild(makeActionButton('reply', '↩ Reply'));
        actions.appendChild(makeActionButton('replyAll', '⤶ Reply all'));
        actions.appendChild(makeActionButton('forward', '↪ Forward'));
        right.appendChild(actions);

        header.appendChild(fromEl);
        header.appendChild(right);
        bubble.appendChild(header);

        // Make bubbles click-expandable
        header.style.cursor = 'pointer';
        header.title = 'Click to expand/collapse';
        header.addEventListener('click', (e) => {
          try {
            if (e && e.target && e.target.closest && e.target.closest(`.${QUOTE_TOGGLE_CLASS}`)) {
              return;
            }
          } catch (_) {}
          try {
            if (e && e.target && e.target.closest && e.target.closest(`.${THREAD_ACTION_BTN_CLASS}`)) {
              return;
            }
          } catch (_) {}

          const willExpand = bubble.classList.contains('tm-thread-collapsed');
          if (willExpand) {
            bubble.classList.add('tm-thread-expanded');
            bubble.classList.remove('tm-thread-collapsed');
          } else {
            bubble.classList.add('tm-thread-collapsed');
            bubble.classList.remove('tm-thread-expanded');
          }

          // When opened: mark unread messages as read
          if (willExpand) {
            try {
              if (bubble.classList.contains('tm-thread-is-unread')) {
                bubble.classList.remove('tm-thread-is-unread');
                bubble.classList.add('tm-thread-is-read');
                const id = bubble.dataset?.tmWeId != null ? Number(bubble.dataset.tmWeId) : NaN;
                requestThreadMarkRead(id, 'threadBubbleOpen');
                console.log(`[TabMail ThreadBubble] Opened -> marked read (weId=${id})`);
              }
            } catch (eRead) {
              console.log(`[TabMail ThreadBubble] Failed marking read on open: ${eRead}`);
            }
          }
        });

        // Expanded metadata (recipients/cc)
        const meta = document.createElement('div');
        meta.className = 'tm-thread-meta';
        try {
          const to = Array.isArray(msg?.recipients) ? msg.recipients : [];
          const cc = Array.isArray(msg?.ccList) ? msg.ccList : [];

          if (to.length > 0) {
            const toRow = document.createElement('div');
            toRow.className = 'tm-thread-meta-row';
            const k = document.createElement('span');
            k.className = 'tm-thread-meta-key';
            k.textContent = 'To:';
            const v = document.createElement('span');
            v.className = 'tm-thread-meta-val';
            v.textContent = to.join(', ');
            toRow.appendChild(k);
            toRow.appendChild(v);
            meta.appendChild(toRow);
          }

          if (cc.length > 0) {
            const ccRow = document.createElement('div');
            ccRow.className = 'tm-thread-meta-row';
            const k = document.createElement('span');
            k.className = 'tm-thread-meta-key';
            k.textContent = 'Cc:';
            const v = document.createElement('span');
            v.className = 'tm-thread-meta-val';
            v.textContent = cc.join(', ');
            ccRow.appendChild(k);
            ccRow.appendChild(v);
            meta.appendChild(ccRow);
          }
        } catch (eMeta) {
          console.log(`[TabMail ThreadBubble] Failed building meta rows: ${eMeta}`);
        }
        bubble.appendChild(meta);

        // Collapsed preview (2 lines, faded; newlines removed)
        const previewEl = document.createElement('div');
        previewEl.className = 'tm-thread-preview';
        try {
          const rawBodyForPreview = String(msg?.body || '');
          const compact = rawBodyForPreview
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\n+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          previewEl.textContent = compact;
        } catch (ePrev) {
          console.log(`[TabMail ThreadBubble] Failed building preview: ${ePrev}`);
          previewEl.textContent = '';
        }
        bubble.appendChild(previewEl);

        // Full body content (expanded)
        const bodyWrap = document.createElement('div');
        bodyWrap.className = 'tm-thread-body tm-thread-body-full';

        const rawBody = msg.body || '';
        if (msg.bodyIsHtml) {
          bodyWrap.textContent = rawBody;
        } else {
          const { main, quote, signature } = splitBodyForQuote(rawBody);
          let quoteText = quote || "";
          try {
            if (quoteText && signature) {
              quoteText = `${quoteText}\n\n${signature}`.trim();
              console.log(
                `[TabMail ThreadBubble] Appended signature into quote (quoteLen=${quote.length} sigLen=${signature.length})`
              );
            }
          } catch (_) {}

          if (main) {
            const mainEl = document.createElement('div');
            mainEl.className = 'tm-thread-body-main';
            mainEl.textContent = main;
            bodyWrap.appendChild(mainEl);
          }

          if (quoteText) {
            const quoteWrapper = document.createElement('div');
            quoteWrapper.className = `${QUOTE_WRAPPER_CLASS} ${QUOTE_COLLAPSED_CLASS} tm-thread-body-quote-wrapper`;

            const toggle = document.createElement('div');
            toggle.className = QUOTE_TOGGLE_CLASS;

            const toggleText = document.createElement('span');
            toggleText.className = 'tm-toggle-text';
            toggleText.textContent = 'Show quoted text';
            toggle.appendChild(toggleText);

            toggle.title = 'Click to expand quoted text';
            toggle.addEventListener('click', () => {
              quoteWrapper.classList.toggle(QUOTE_COLLAPSED_CLASS);
              const isCollapsed = quoteWrapper.classList.contains(QUOTE_COLLAPSED_CLASS);
              toggleText.textContent = isCollapsed ? 'Show quoted text' : 'Hide quoted text';
              toggle.title = isCollapsed ? 'Click to expand quoted text' : 'Click to collapse quoted text';
            });

            const quoteContent = document.createElement('div');
            quoteContent.className = `${QUOTE_CONTENT_CLASS} tm-thread-body-quote`;
            quoteContent.textContent = quoteText;

            quoteWrapper.appendChild(toggle);
            quoteWrapper.appendChild(quoteContent);
            bodyWrap.appendChild(quoteWrapper);
          }
        }

        // Render attachments list (if any)
        try {
          if (attachments.length > 0) {
            const attachWrap = document.createElement('div');
            attachWrap.className = 'tm-thread-attachments';

            const attachHeader = document.createElement('div');
            attachHeader.className = 'tm-thread-attachments-header';
            attachHeader.textContent = `📎 ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}`;
            attachWrap.appendChild(attachHeader);

            const attachList = document.createElement('div');
            attachList.className = 'tm-thread-attachments-list';

            attachments.forEach((att, attIdx) => {
              try {
                const item = document.createElement('div');
                item.className = 'tm-thread-attachment-item';

                const icon = document.createElement('span');
                icon.className = 'tm-thread-attachment-icon';
                icon.textContent = getAttachmentIcon(att?.contentType || '');
                item.appendChild(icon);

                const info = document.createElement('div');
                info.className = 'tm-thread-attachment-info';

                const nameEl = document.createElement('span');
                nameEl.className = 'tm-thread-attachment-name';
                nameEl.textContent = att?.name || 'Attachment';
                nameEl.title = att?.name || 'Attachment';
                info.appendChild(nameEl);

                const sizeEl = document.createElement('span');
                sizeEl.className = 'tm-thread-attachment-size';
                sizeEl.textContent = formatFileSize(att?.size || 0);
                info.appendChild(sizeEl);

                item.appendChild(info);

                const downloadBtn = document.createElement('button');
                downloadBtn.type = 'button';
                downloadBtn.className = 'tm-thread-attachment-download';
                downloadBtn.textContent = '⬇';
                downloadBtn.title = 'Download attachment';
                downloadBtn.addEventListener('click', (e) => {
                  try {
                    e.preventDefault();
                    e.stopPropagation();
                  } catch (_) {}
                  requestAttachmentDownload(msg?.weId, att?.partName, att?.name);
                });
                item.appendChild(downloadBtn);

                attachList.appendChild(item);
              } catch (eAtt) {
                console.log(`[TabMail ThreadBubble] Failed to render attachment ${attIdx}: ${eAtt}`);
              }
            });

            attachWrap.appendChild(attachList);
            bodyWrap.appendChild(attachWrap);
            console.log(`[TabMail ThreadBubble] Rendered ${attachments.length} attachments for weId=${msg?.weId}`);
          }
        } catch (eAttachments) {
          console.log(`[TabMail ThreadBubble] Failed to render attachments: ${eAttachments}`);
        }

        bubble.appendChild(bodyWrap);
        container.appendChild(bubble);
        console.log(`[TabMail ThreadBubble] Rendered message ${idx + 1}/${reversedMessages.length} from ${msg.from}`);
      } catch (e) {
        console.error(`[TabMail ThreadBubble] Error rendering message ${idx}:`, e);
      }
    });

    // Insert after the main wrapper
    const mainWrapper = document.getElementById(WRAPPER_ID);
    if (mainWrapper) {
      mainWrapper.parentNode.insertBefore(container, mainWrapper.nextSibling);
    } else {
      document.body.appendChild(container);
    }

    console.log('[TabMail ThreadBubble] Thread conversation rendered');
  }

  /**
   * Update thread font CSS variables on existing thread container
   */
  function updateThreadFontCssVars(_baseFontSizePx) {
    // Kept for compatibility with older callers; no-op because sizing is CSS-first now.
    console.log(`[TabMail ThreadBubble] updateFontCssVars ignored (cssSizing)`);
  }

  // Export via globalThis
  globalThis.TabMailThreadBubble = {
    render: renderThreadConversation,
    updateFontCssVars: updateThreadFontCssVars,
  };

  console.log("[TabMail ThreadBubble] threadBubble.js loaded");
})();
