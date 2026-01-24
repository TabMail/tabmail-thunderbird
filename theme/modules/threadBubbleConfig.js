// TabMail Thread Bubble Config (TB 145 / MV3)
// Loaded BEFORE messageBubbleConfig.js so the rest of the bubble scripts can read a stable
// thread-bubble config without hardcoding values in multiple places.
//
// This is a plain script (not a module) because it is injected as a content script.
// It intentionally attaches config to globalThis for easy access.

(function () {
  const THREAD_BUBBLE_UI = {
    unreadBorderWidthPx: 2,
    actionGapPx: 6,
    actionPaddingYPx: 2,
    actionPaddingXPx: 6,
    actionBorderRadiusPx: 10,

    // Typography (CSS-first): use system font preset + absolute keyword sizing.
    // Use absolute keywords (small/medium/large) instead of relative (smaller/larger)
    // so HTML email CSS can't shrink our UI.
    // These keywords respect TB's font.size.variable prefs.
    fontPreset: "message-box",
    fontSizeBase: "medium",
    fontSizeSubject: "medium",
    fontSizeFrom: "medium",
    fontSizeDate: "small",
    fontSizeBody: "medium",
    fontSizeMeta: "small",
    fontSizePreview: "small",
    fontSizeAttachmentIndicator: "small",
    fontSizeAttachmentsHeader: "small",
    fontSizeAction: "small",
  };

  const THREAD_CLASSES = {
    container: "tm-thread-container",
    bubble: "tm-thread-bubble",
    headerRight: "tm-thread-header-right",
    actions: "tm-thread-actions",
    actionBtn: "tm-thread-action-btn",
    subject: "tm-thread-subject",
    from: "tm-thread-from",
    date: "tm-thread-date",
    meta: "tm-thread-meta",
    preview: "tm-thread-preview",
    bodyFull: "tm-thread-body-full",
    attachmentIndicator: "tm-thread-attachment-indicator",
    attachmentsSection: "tm-thread-attachments-section",
    attachmentsHeader: "tm-thread-attachments-header",
    attachmentsList: "tm-thread-attachments-list",
    attachmentItem: "tm-thread-attachment-item",
    collapsed: "tm-thread-collapsed",
    expanded: "tm-thread-expanded",
    unread: "tm-thread-is-unread",
    read: "tm-thread-is-read",
  };

  const CONFIG = {
    THREAD_BUBBLE_UI,
    THREAD_CLASSES,
  };

  try {
    globalThis.TabMailThreadBubbleConfig = CONFIG;
    console.log("[TabMail ThreadBubble] threadBubbleConfig loaded", {
      fontSizeBase: THREAD_BUBBLE_UI.fontSizeBase,
      fontSizeDate: THREAD_BUBBLE_UI.fontSizeDate,
    });
  } catch (e) {
    console.log(`[TabMail ThreadBubble] Failed to set TabMailThreadBubbleConfig: ${e}`);
  }
})();

