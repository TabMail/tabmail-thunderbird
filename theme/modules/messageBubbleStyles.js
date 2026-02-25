// TabMail Message Bubble Styles Generator (TB 145 / MV3)
// Generates CSS for message bubbles with config-driven values.
// Loaded BEFORE messageBubble.js so styles are available immediately.

(function () {
  // Get config (must be loaded before this script)
  const CFG = globalThis.TabMailMessageBubbleConfig || {};
  
  // IDs and class names
  const WRAPPER_ID = CFG.WRAPPER_ID || 'tm-message-bubble-wrapper';
  const STYLE_ID = CFG.STYLE_ID || 'tm-message-bubble-style';
  const THREAD_CONTAINER_ID = CFG.THREAD_CONTAINER_ID || 'tm-thread-conversation';
  
  // Layout
  const L = CFG.LAYOUT || {};
  const BORDER_RADIUS = L.borderRadiusPx || 8;
  const PADDING_V = L.paddingVerticalPx || 8;
  const PADDING_H = L.paddingHorizontalPx || 10;
  const MARGIN_T = L.marginTopPx || 8;
  const MARGIN_H = L.marginHorizontalPx || 8;
  const MARGIN_B = L.marginBottomPx || 8;
  
  // Thread bubble UI
  const T = CFG.THREAD_BUBBLE_UI || {};
  const UNREAD_BORDER = T.unreadBorderWidthPx || 2;
  const ACTION_GAP = T.actionGapPx || 6;
  const ACTION_PAD_Y = T.actionPaddingYPx || 2;
  const ACTION_PAD_X = T.actionPaddingXPx || 6;
  const ACTION_RADIUS = T.actionBorderRadiusPx || 10;
  
  // Quote class names
  const Q = CFG.QUOTE_CLASSES || {};
  const Q_WRAPPER = Q.wrapper || 'tm-quote-wrapper';
  const Q_COLLAPSED = Q.collapsed || 'tm-quote-collapsed';
  const Q_TOGGLE = Q.toggle || 'tm-quote-toggle';
  const Q_CONTENT = Q.content || 'tm-quote-content';
  
  // Thread class names
  const TC = CFG.THREAD_CLASSES || {};
  const T_HEADER_RIGHT = TC.headerRight || 'tm-thread-header-right';
  const T_ACTIONS = TC.actions || 'tm-thread-actions';
  const T_ACTION_BTN = TC.actionBtn || 'tm-thread-action-btn';
  
  // Generate CSS
  // Typography (CSS-first): system preset + absolute keyword sizing (small/medium/large).
  // Use absolute keywords instead of relative (smaller/larger) so HTML email CSS can't affect our UI.
  const THREAD_FONT_PRESET = String(T.fontPreset || "menu");
  const THREAD_FONT_BASE = String(T.fontSizeBase || "medium");
  const THREAD_FONT_SUBJECT = String(T.fontSizeSubject || "large");
  const THREAD_FONT_FROM = String(T.fontSizeFrom || "medium");
  const THREAD_FONT_DATE = String(T.fontSizeDate || "small");
  const THREAD_FONT_BODY = String(T.fontSizeBody || "medium");
  const THREAD_FONT_META = String(T.fontSizeMeta || "small");
  const THREAD_FONT_PREVIEW = String(T.fontSizePreview || "small");
  const THREAD_FONT_ATTACH_IND = String(T.fontSizeAttachmentIndicator || "small");
  const THREAD_FONT_ATTACH_HDR = String(T.fontSizeAttachmentsHeader || "small");
  const THREAD_FONT_ACTION = String(T.fontSizeAction || "small");

  const CSS = `
/* Reset body to remove default margins/padding */
body {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
}

/* Bubble wrapper - matches preview pane background */
#${WRAPPER_ID} {
  background: var(--tm-preview-pane-bg) !important;
  border: none !important;
  border-radius: ${BORDER_RADIUS}px !important;
  padding: ${PADDING_V}px ${PADDING_H}px !important;
  margin: ${MARGIN_T}px ${MARGIN_H}px ${MARGIN_B}px ${MARGIN_H}px !important;
  box-sizing: border-box !important;
  display: block !important;
  position: relative !important;
  overflow-x: hidden !important;
  color: CanvasText !important;
  color-scheme: light dark;
}

/* =========================================
 * Collapsible Quote Styles (Gmail-like)
 * ========================================= */

.${Q_WRAPPER} {
  position: relative;
  margin: 4px 0;
  border-radius: 12px;
  overflow: hidden;
  transition: none;
}

.${Q_WRAPPER}.${Q_COLLAPSED} {
  display: flex;
  width: fit-content;
  background: color-mix(in srgb, var(--tag-tm-untagged) 15%, Canvas 85%);
  box-shadow: 0 1px 2px color-mix(in srgb, CanvasText 10%, transparent 90%);
}

.${Q_WRAPPER}:not(.${Q_COLLAPSED}) {
  display: block;
  background: color-mix(in srgb, var(--tag-tm-untagged) 10%, Canvas 90%);
  border-radius: ${BORDER_RADIUS}px;
  box-shadow: 0 1px 3px color-mix(in srgb, CanvasText 12%, transparent 88%);
}

.${Q_TOGGLE} {
  cursor: pointer;
  padding: 3px 10px;
  margin: 0;
  background: transparent;
  border: none;
  user-select: none;
  transition: none;
}

.${Q_COLLAPSED} .${Q_TOGGLE} {
  display: inline;
}

.${Q_WRAPPER}:not(.${Q_COLLAPSED}) .${Q_TOGGLE} {
  display: block;
}

.${Q_TOGGLE}:hover {
  background: color-mix(in srgb, var(--tag-tm-untagged) 20%, Canvas 80%);
  border-radius: 8px;
}

.${Q_TOGGLE} .tm-toggle-text {
  font-size: inherit;
  color: color-mix(in srgb, CanvasText 55%, Canvas 45%);
  white-space: nowrap;
  transition: none;
}

.${Q_TOGGLE}:hover .tm-toggle-text {
  color: color-mix(in srgb, CanvasText 75%, Canvas 25%);
}

.${Q_CONTENT} {
  overflow: hidden;
}

.${Q_COLLAPSED} .${Q_CONTENT} {
  display: none !important;
}

.${Q_WRAPPER}:not(.${Q_COLLAPSED}) .${Q_CONTENT} {
  display: block;
  padding: ${PADDING_V}px ${PADDING_H}px;
  padding-top: 0;
}

.${Q_WRAPPER}:not(.${Q_COLLAPSED}) .${Q_TOGGLE} {
  border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, Canvas 90%);
  padding: ${PADDING_V}px ${PADDING_H}px;
}

[data-tabmail-quote-boundary="1"],
[data-tabmail-signature-boundary="1"] {
  display: none;
}

/* =========================================
 * Thread Conversation Bubble Styles
 * ========================================= */

#${THREAD_CONTAINER_ID} {
  margin: ${MARGIN_T}px ${MARGIN_H}px ${MARGIN_B}px ${MARGIN_H}px;
  padding: 0;
}

.tm-thread-container {
  --tm-thread-unread-border-width: ${UNREAD_BORDER}px;
  --tm-thread-action-gap: ${ACTION_GAP}px;
  --tm-thread-action-pad-y: ${ACTION_PAD_Y}px;
  --tm-thread-action-pad-x: ${ACTION_PAD_X}px;
  --tm-thread-action-radius: ${ACTION_RADIUS}px;
}

.tm-thread-bubble {
  --tm-thread-tag-color: var(--tag-tm-untagged);
  --tm-thread-bubble-bg: color-mix(in srgb, var(--tm-thread-tag-color) 10%, Canvas 90%);
  background: var(--tm-thread-bubble-bg);
  border: none;
  border-radius: ${BORDER_RADIUS}px;
  padding: ${PADDING_V}px ${PADDING_H}px;
  margin-bottom: 8px;
  color: CanvasText;
  box-sizing: border-box;
  /* Use !important so HTML email CSS cannot override bubble typography */
  font: ${THREAD_FONT_PRESET} !important;
  font-size: ${THREAD_FONT_BASE} !important;
  box-shadow: 
    0 1px 3px 0 color-mix(in srgb, var(--tm-thread-tag-color) 25%, transparent 75%),
    0 1px 2px -1px color-mix(in srgb, var(--tm-thread-tag-color) 20%, transparent 80%),
    inset 0 1px 0 0 color-mix(in srgb, Canvas 50%, transparent 50%);
}

.tm-thread-bubble.tm-thread-is-unread {
  border: var(--tm-thread-unread-border-width) solid CanvasText;
}

.tm-thread-bubble.tm-thread-is-read.tm-thread-collapsed {
  color: color-mix(in srgb, CanvasText 70%, Canvas 30%);
}

.tm-thread-bubble.tm-thread-is-read.tm-thread-collapsed .tm-thread-from,
.tm-thread-bubble.tm-thread-is-read.tm-thread-collapsed .tm-thread-date,
.tm-thread-bubble.tm-thread-is-read.tm-thread-collapsed .tm-thread-preview {
  color: color-mix(in srgb, CanvasText 62%, Canvas 38%);
}

.tm-thread-subject {
  font-size: ${THREAD_FONT_SUBJECT} !important;
  font-weight: 700;
  color: CanvasText;
  margin-bottom: 4px;
  font-style: normal;
}

.tm-thread-bubble.tm-thread-collapsed .tm-thread-meta,
.tm-thread-bubble.tm-thread-collapsed .tm-thread-body-full {
  display: none;
}

.tm-thread-bubble.tm-thread-expanded .tm-thread-preview {
  display: none;
}

.tm-thread-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, Canvas 82%);
}

.${T_HEADER_RIGHT} {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: var(--tm-thread-action-gap);
  flex-direction: column;
  flex-wrap: wrap;
}

.${T_ACTIONS} {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--tm-thread-action-gap);
  flex-wrap: wrap;
}

.tm-thread-bubble.tm-thread-collapsed .${T_ACTIONS} {
  display: none;
}

.tm-thread-attachment-indicator {
  font-size: ${THREAD_FONT_ATTACH_IND} !important;
  font-weight: normal;
  color: color-mix(in srgb, CanvasText 55%, Canvas 45%);
  margin-left: 6px;
  user-select: none;
}

.tm-thread-bubble.tm-thread-expanded .tm-thread-attachment-indicator {
  display: none;
}

.${T_ACTION_BTN} {
  font-size: ${THREAD_FONT_ACTION} !important;
  line-height: 1.2;
  color: color-mix(in srgb, CanvasText 65%, Canvas 35%);
  background: transparent;
  border: 1px solid color-mix(in srgb, CanvasText 14%, Canvas 86%);
  border-radius: var(--tm-thread-action-radius);
  padding: var(--tm-thread-action-pad-y) var(--tm-thread-action-pad-x);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.${T_ACTION_BTN}:hover {
  color: CanvasText;
  background: color-mix(in srgb, var(--tm-thread-tag-color) 18%, Canvas 82%);
  border-color: color-mix(in srgb, CanvasText 22%, Canvas 78%);
}

.tm-thread-from {
  font-style: normal;
  font-weight: bold;
  font-size: ${THREAD_FONT_FROM} !important;
  color: color-mix(in srgb, CanvasText 75%, Canvas 25%);
}

.tm-thread-date {
  font-size: ${THREAD_FONT_DATE} !important;
  color: color-mix(in srgb, CanvasText 55%, Canvas 45%);
}

.tm-thread-body {
  font-size: ${THREAD_FONT_BODY} !important;
  line-height: 1.4;
  color: CanvasText;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}

.tm-thread-meta {
  font-size: ${THREAD_FONT_META} !important;
  color: color-mix(in srgb, CanvasText 65%, Canvas 35%);
  margin-bottom: 8px;
}

.tm-thread-meta-row {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
}

.tm-thread-meta-key {
  font-weight: bold;
  color: color-mix(in srgb, CanvasText 75%, Canvas 25%);
}

.tm-thread-meta-val {
  overflow-wrap: anywhere;
  word-break: break-word;
}

.tm-thread-preview {
  font-size: ${THREAD_FONT_PREVIEW} !important;
  line-height: 1.4;
  color: CanvasText;
  white-space: normal;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--tm-thread-preview-lines);
  position: relative;
}

.tm-thread-preview::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1.2em;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--tm-thread-bubble-bg));
}

.tm-thread-body-main {
  margin-bottom: 6px;
}

.tm-thread-body-quote {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  opacity: 0.95;
}

/* =========================================
 * Thread Attachments Styles
 * ========================================= */

.tm-thread-attachments {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, CanvasText 12%, Canvas 88%);
}

.tm-thread-attachments-header {
  font-size: ${THREAD_FONT_ATTACH_HDR} !important;
  font-weight: 600;
  color: color-mix(in srgb, CanvasText 65%, Canvas 35%);
  margin-bottom: 6px;
}

.tm-thread-attachments-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tm-thread-attachment-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: color-mix(in srgb, var(--tm-thread-tag-color) 8%, Canvas 92%);
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, CanvasText 8%, Canvas 92%);
  transition: background 0.15s ease, border-color 0.15s ease;
}

.tm-thread-attachment-item:hover {
  background: color-mix(in srgb, var(--tm-thread-tag-color) 14%, Canvas 86%);
  border-color: color-mix(in srgb, CanvasText 14%, Canvas 86%);
}

.tm-thread-attachment-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.tm-thread-attachment-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tm-thread-attachment-name {
  font-size: 12px;
  font-weight: 500;
  color: CanvasText;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tm-thread-attachment-size {
  font-size: 10px;
  color: color-mix(in srgb, CanvasText 55%, Canvas 45%);
}

.tm-thread-attachment-download {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid color-mix(in srgb, CanvasText 14%, Canvas 86%);
  border-radius: 6px;
  background: transparent;
  color: color-mix(in srgb, CanvasText 65%, Canvas 35%);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.tm-thread-attachment-download:hover {
  background: color-mix(in srgb, var(--tm-thread-tag-color) 18%, Canvas 82%);
  border-color: color-mix(in srgb, CanvasText 22%, Canvas 78%);
  color: CanvasText;
}

.tm-thread-bubble.tm-thread-collapsed .tm-thread-attachments {
  display: none;
}

/* =========================================
 * Dark Mode Adjustments
 * ========================================= */

@media (prefers-color-scheme: dark) {
  .${Q_WRAPPER}.${Q_COLLAPSED} {
    background: color-mix(in srgb, var(--tag-tm-untagged) 20%, Canvas 80%);
    box-shadow: 0 1px 3px color-mix(in srgb, black 25%, transparent 75%);
  }
  
  .${Q_WRAPPER}:not(.${Q_COLLAPSED}) {
    background: color-mix(in srgb, var(--tag-tm-untagged) 14%, Canvas 86%);
    box-shadow: 0 1px 4px color-mix(in srgb, black 25%, transparent 75%);
  }
  
  .${Q_TOGGLE}:hover {
    background: color-mix(in srgb, var(--tag-tm-untagged) 25%, Canvas 75%);
  }
  
  .tm-thread-bubble {
    --tm-thread-bubble-bg: color-mix(in srgb, var(--tm-thread-tag-color) 15%, Canvas 85%);
    background: var(--tm-thread-bubble-bg);
    box-shadow: 
      0 1px 4px 0 color-mix(in srgb, black 30%, transparent 70%),
      0 1px 2px -1px color-mix(in srgb, black 20%, transparent 80%),
      inset 0 1px 0 0 color-mix(in srgb, CanvasText 8%, transparent 92%);
  }
  
  .tm-thread-header {
    border-bottom-color: color-mix(in srgb, CanvasText 22%, Canvas 78%);
  }

  .tm-thread-attachments {
    border-top-color: color-mix(in srgb, CanvasText 18%, Canvas 82%);
  }

  .tm-thread-attachment-item {
    background: color-mix(in srgb, var(--tm-thread-tag-color) 12%, Canvas 88%);
    border-color: color-mix(in srgb, CanvasText 12%, Canvas 88%);
  }

  .tm-thread-attachment-item:hover {
    background: color-mix(in srgb, var(--tm-thread-tag-color) 18%, Canvas 82%);
    border-color: color-mix(in srgb, CanvasText 18%, Canvas 82%);
  }
}

/* =========================================
 * Email Content Overrides
 * ========================================= */

#${WRAPPER_ID} p,
#${WRAPPER_ID} div,
#${WRAPPER_ID} span,
#${WRAPPER_ID} td,
#${WRAPPER_ID} th,
#${WRAPPER_ID} li,
#${WRAPPER_ID} h1,
#${WRAPPER_ID} h2,
#${WRAPPER_ID} h3,
#${WRAPPER_ID} h4,
#${WRAPPER_ID} h5,
#${WRAPPER_ID} h6 {
  color: CanvasText !important;
}

#${WRAPPER_ID} *[style*="background-color: white"],
#${WRAPPER_ID} *[style*="background-color:#fff"],
#${WRAPPER_ID} *[style*="background-color:#ffffff"],
#${WRAPPER_ID} *[style*="background-color:#FFFFFF"],
#${WRAPPER_ID} *[style*="background-color: #fff"],
#${WRAPPER_ID} *[style*="background-color: #ffffff"],
#${WRAPPER_ID} *[style*="background-color: #FFFFFF"],
#${WRAPPER_ID} *[style*="background: white"],
#${WRAPPER_ID} *[style*="background:#fff"],
#${WRAPPER_ID} *[style*="background:#ffffff"],
#${WRAPPER_ID} *[style*="background:#FFFFFF"],
#${WRAPPER_ID} *[style*="background: #fff"],
#${WRAPPER_ID} *[style*="background: #ffffff"],
#${WRAPPER_ID} *[style*="background: #FFFFFF"] {
  background-color: Canvas !important;
  background: Canvas !important;
}

#${WRAPPER_ID} *[style*="background-color: #f"],
#${WRAPPER_ID} *[style*="background-color: #e"],
#${WRAPPER_ID} *[style*="background-color: #d"],
#${WRAPPER_ID} *[style*="background-color: #c"],
#${WRAPPER_ID} *[style*="background-color: #b"],
#${WRAPPER_ID} *[style*="background-color: #a"],
#${WRAPPER_ID} *[style*="background-color: #9"],
#${WRAPPER_ID} *[style*="background-color: #8"],
#${WRAPPER_ID} *[style*="background-color: #7"],
#${WRAPPER_ID} *[style*="background-color: #6"],
#${WRAPPER_ID} *[style*="background-color: #5"],
#${WRAPPER_ID} *[style*="background-color: #4"],
#${WRAPPER_ID} *[style*="background-color: #3"],
#${WRAPPER_ID} *[style*="background-color: #2"],
#${WRAPPER_ID} *[style*="background-color: #1"] {
  background-color: Canvas !important;
  background: Canvas !important;
}

#${WRAPPER_ID} .content-outer,
#${WRAPPER_ID} .content-section,
#${WRAPPER_ID} .email-body,
#${WRAPPER_ID} .footer-text,
#${WRAPPER_ID} .header-spacing {
  background-color: Canvas !important;
  background: Canvas !important;
}

#${WRAPPER_ID} a {
  color: LinkText !important;
}

#${WRAPPER_ID} a:visited {
  color: VisitedText !important;
}

/* Constrain email layout to wrapper width */
#${WRAPPER_ID} table,
#${WRAPPER_ID} td,
#${WRAPPER_ID} th,
#${WRAPPER_ID} div:not([class*="tm-"]):not([id*="tm-"]),
#${WRAPPER_ID} p {
  max-width: 100% !important;
  box-sizing: border-box !important;
}

@media (prefers-color-scheme: dark) {
  #${WRAPPER_ID} {
    background: var(--tm-preview-pane-bg) !important;
    border: none !important;
  }
  
  #${WRAPPER_ID} *[style*="background-color: white"],
  #${WRAPPER_ID} *[style*="background-color:#fff"],
  #${WRAPPER_ID} *[style*="background-color:#ffffff"],
  #${WRAPPER_ID} *[style*="background-color:#FFFFFF"],
  #${WRAPPER_ID} *[style*="background-color: #fff"],
  #${WRAPPER_ID} *[style*="background-color: #ffffff"],
  #${WRAPPER_ID} *[style*="background-color: #FFFFFF"],
  #${WRAPPER_ID} *[style*="background: white"],
  #${WRAPPER_ID} *[style*="background:#fff"],
  #${WRAPPER_ID} *[style*="background:#ffffff"],
  #${WRAPPER_ID} *[style*="background:#FFFFFF"],
  #${WRAPPER_ID} *[style*="background: #fff"],
  #${WRAPPER_ID} *[style*="background: #ffffff"],
  #${WRAPPER_ID} *[style*="background: #FFFFFF"],
  #${WRAPPER_ID} *[style*="background-color: #f"],
  #${WRAPPER_ID} *[style*="background-color: #e"],
  #${WRAPPER_ID} *[style*="background-color: #d"],
  #${WRAPPER_ID} *[style*="background-color: #c"],
  #${WRAPPER_ID} *[style*="background-color: #b"],
  #${WRAPPER_ID} *[style*="background-color: #a"],
  #${WRAPPER_ID} *[style*="background-color: #9"],
  #${WRAPPER_ID} *[style*="background-color: #8"],
  #${WRAPPER_ID} *[style*="background-color: #7"],
  #${WRAPPER_ID} *[style*="background-color: #6"],
  #${WRAPPER_ID} *[style*="background-color: #5"],
  #${WRAPPER_ID} *[style*="background-color: #4"],
  #${WRAPPER_ID} *[style*="background-color: #3"],
  #${WRAPPER_ID} *[style*="background-color: #2"],
  #${WRAPPER_ID} *[style*="background-color: #1"] {
    background-color: Canvas !important;
    background: Canvas !important;
  }
  
  #${WRAPPER_ID} button {
    background: Canvas !important;
    background-color: Canvas !important;
    border-color: color-mix(in srgb, CanvasText 25%, Canvas 75%) !important;
  }
  
  #${WRAPPER_ID} button:hover {
    border-color: color-mix(in srgb, CanvasText 40%, Canvas 60%) !important;
  }
  
  #${WRAPPER_ID} button img {
    filter: invert(1) brightness(1.2) contrast(1.1) !important;
  }
  
  #${WRAPPER_ID} table[style*="background"],
  #${WRAPPER_ID} td[style*="background"],
  #${WRAPPER_ID} th[style*="background"],
  #${WRAPPER_ID} table[style*="background-color"],
  #${WRAPPER_ID} td[style*="background-color"],
  #${WRAPPER_ID} th[style*="background-color"] {
    background-color: Canvas !important;
    background: Canvas !important;
  }

  /* Near-white background overrides (CSS-class and inherited) are handled
     entirely by JS in messageBubble.js — it detects actual computed colors
     and only overrides elements that genuinely had near-white backgrounds.
     A blanket CSS rule here would also override elements with NO background
     (transparent), making them opaque Canvas and hiding parent tints. */
}
`;

  // Export
  globalThis.TabMailMessageBubbleStyles = {
    css: CSS,
    STYLE_ID,
  };
  
  console.log("[TabMail MsgBubble] messageBubbleStyles loaded");
})();
