/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
var TabMail = TabMail || {};

Object.assign(TabMail, {
  hideComposePreview() {
    TabMail.state.previewView?.host.remove();
    TabMail.state.previewView = null;
    TabMail.state.previewModel = null;
    TabMail.state.previewJumpOffset = null;
    TabMail.state.isDiffActive = false;
  },

  /** Measure glyph ranges without inserting measurement nodes into the draft. */
  composeLineContext(index, start, end) {
    // Inspect the sentence and its adjacent rendered line fragments only.
    // Long messages must not trigger a layout read for every character.
    while (end > start && /\s/.test(index.text[end - 1])) end--;
    const glyphAt = offset => {
      const entry = index.entries.find(e => e.kind === 'text' && offset >= e.start && offset < e.end);
      if (!entry) return null;
      const range = document.createRange();
      range.setStart(entry.node, offset - entry.start);
      range.setEnd(entry.node, offset - entry.start + 1);
      const rect = range.getBoundingClientRect();
      return rect.height && rect.width ? { offset, rect } : null;
    };
    let first, last;
    for (let i = start; i < end && !first; i++) first = glyphAt(i);
    for (let i = end - 1; i >= start && !last; i--) last = glyphAt(i);
    if (!first || !last) return null;
    const sameLine = (a, b) => Math.abs(a.top - b.top) <= TabMail.config.preview.lineTolerance;
    let lineStart = first.offset, lineEnd = last.offset + 1, left = first.rect.left;
    for (let i = first.offset - 1; i >= 0; i--) {
      const glyph = glyphAt(i);
      if (!glyph || !sameLine(glyph.rect, first.rect)) break;
      lineStart = i;
      left = Math.min(left, glyph.rect.left);
    }
    for (let i = last.offset + 1; i < index.text.length; i++) {
      const glyph = glyphAt(i);
      if (!glyph || !sameLine(glyph.rect, last.rect)) break;
      lineEnd = i + 1;
    }
    return { start: lineStart, end: lineEnd, left, top: first.rect.top, bottom: last.rect.bottom };
  },

  renderComposePreview(show = true) {
    const state = TabMail.state;
    const editor = state.editorRef;
    const sel = window.getSelection();
    if (!editor || !show || state.autocompleteDisabled || state.inlineEditActive || state.isIMEComposing || state.beforeSendCleanupActive || !sel?.isCollapsed) { TabMail.hideComposePreview(); return; }
    const index = TabMail.indexComposeText(editor, TabMail.getQuoteBoundaryNode(editor));
    const cursor = TabMail.composeCursorOffset(index);
    if (cursor === null || typeof state.correctedText !== 'string' || !state.correctedText || state.correctedText === index.text) { TabMail.hideComposePreview(); return; }
    const model = TabMail.buildPreviewModel(index.text, state.correctedText, cursor);
    if (!model.edits.length && (model.jumpOffset == null || model.jumpOffset < 0)) { TabMail.hideComposePreview(); return; }
    state.previewModel = model.edits.length ? model : null;
    state.previewJumpOffset = model.edits.length ? null : model.jumpOffset;
    const cfg = TabMail.config.preview;
    let view = state.previewView;
    if (!view) {
      const host = document.createElement('div');
      host.id = 'tm-compose-preview';
      host.setAttribute('data-tabmail-ui', '');
      host.contentEditable = 'false';
      host.className = 'tm-compose-preview';
      view = state.previewView = { host };
    }
    const { host } = view;
    host.querySelector('.preview')?.remove();
    host.querySelectorAll('.source-underline').forEach(line => line.remove());
    const bubble = document.createElement('div');
    bubble.className = 'preview';
    bubble.setAttribute('role', 'group');
    bubble.setAttribute('aria-label', 'Writing suggestion');
    const content = document.createElement('div');
    content.className = 'content';
    content.setAttribute('aria-live', 'polite');
    const sourceNode = TabMail.composePointAt(index, model.edits.length ? model.start : cursor).node;
    const sourceElement = sourceNode.nodeType === Node.ELEMENT_NODE ? sourceNode : sourceNode.parentElement;
    const style = getComputedStyle(sourceElement);
    content.style.font = style.font;
    content.style.lineHeight = style.lineHeight;
    const context = model.edits.length ? TabMail.composeLineContext(index, model.start, model.end) : null;
    const anchorRange = TabMail.composeRange(index, model.edits.length ? model.start : cursor);
    const rect = anchorRange.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    const left = context?.left ?? (rect.height ? rect.left : editorRect.left);
    const top = context?.top ?? (rect.height ? rect.top : editorRect.top);
    const bottom = context?.bottom ?? (rect.height ? rect.bottom : editorRect.top + (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * cfg.lineHeightFactor));
    const add = (text, className, offset = null) => {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      if (offset !== null) {
        const point = TabMail.composePointAt(index, offset, true);
        const element = point.node.nodeType === Node.TEXT_NODE ? point.node.parentElement : point.node;
        const typography = getComputedStyle(element);
        for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant', 'letterSpacing', 'textDecoration']) {
          span.style[property] = typography[property];
        }
      }
      content.appendChild(span);
    };
    if (model.edits.length) {
      const addOriginal = (start, end, className) => {
        for (const entry of index.entries) {
          const a = Math.max(start, entry.start), b = Math.min(end, entry.end);
          if (a < b) add(index.text.slice(a, b), className, a);
        }
      };
      if (context) addOriginal(context.start, model.start, 'context');
      const runs = model.runs.map(run => ({ ...run }));
      // Sentence tokens include the paragraph delimiter; it is not an extra
      // preview line. The acceptance payload retains it unchanged.
      while (runs.length && /\s$/.test(runs[runs.length - 1].text)) {
        runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd();
        if (runs[runs.length - 1].text) break;
        runs.pop();
      }
      for (const run of runs) {
        if (run.inserted) add(run.text, 'inserted', run.start);
        else addOriginal(run.start, run.start + run.text.length, 'unchanged');
      }
      if (context && context.end > model.end) {
        add(model.replacement.match(/[^\S\n]+$/)?.[0] || '', 'context');
        addOriginal(model.end, context.end, 'context');
      }
      // Text-node rectangles keep the underline out of authored markup and
      // work on Thunderbird versions without CSS Highlight decorations.
      for (const entry of index.entries) {
        const a = Math.max(model.start, entry.start), b = Math.min(model.end, entry.end);
        if (entry.kind !== 'text' || a >= b) continue;
        const range = document.createRange();
        range.setStart(entry.node, a - entry.start);
        range.setEnd(entry.node, b - entry.start);
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          const line = document.createElement('span');
          line.className = 'source-underline';
          line.setAttribute('aria-hidden', 'true');
          Object.assign(line.style, {left: `${rect.left}px`, top: `${rect.bottom - 1}px`, width: `${rect.width}px`});
          host.appendChild(line);
        }
      }
    } else add('Tab to jump to suggestion', 'context');
    bubble.appendChild(content);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const action = (label, title, run) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = title;
      // Keep the native compose selection when using the mouse.
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', run);
      actions.appendChild(button);
    };
    if (model.edits.length) action('Accept', 'Accept suggestion (Tab)', () => TabMail.acceptComposePreview());
    else action('Jump to suggestion', 'Jump to suggestion (Tab)', () => {
      const offset = state.previewJumpOffset;
      if (offset == null) return;
      TabMail.setCursorByOffset(editor, offset);
      TabMail.renderComposePreview();
    });
    action('Dismiss', 'Dismiss suggestion (Esc)', () => TabMail.dismissComposeSuggestion());
    action('Disable suggestions', 'Disable suggestions (Shift+Esc)', () => TabMail.setAutocompleteEnabled(false));
    bubble.appendChild(actions);
    host.appendChild(bubble);
    // At the viewport edge, reduce bubble padding instead of shifting the
    // preview text away from its corresponding source line.
    const x = Math.max(0, left - cfg.padding - 1);
    const availableWidth = Math.max(1, window.innerWidth - x);
    const width = Math.min(availableWidth, Math.max(cfg.minWidth, editorRect.right - x + cfg.padding + 1));
    bubble.style.paddingLeft = `${Math.max(0, left - x - 1)}px`;
    bubble.style.paddingRight = `${Math.max(0, x + width - editorRect.right - 1)}px`;
    Object.assign(host.style, { position: 'fixed', zIndex: String(cfg.zIndex), left: `${x}px`, top: `${bottom + cfg.gap}px`, width: `${width}px` });
    // Sibling of BODY: the native compose serializer cannot include the preview.
    if (!host.isConnected) document.documentElement.appendChild(host);
    const place = () => {
      if (!host.isConnected) return;
      const height = host.getBoundingClientRect().height;
      const y = bottom + cfg.gap + height <= window.innerHeight - cfg.margin ? bottom + cfg.gap : Math.max(cfg.margin, top - cfg.gap - height);
      host.style.top = `${y}px`;
    };
    place();
    state.isDiffActive = !!model.edits.length;
  },

  dismissComposeSuggestion() {
    TabMail.state.latestLocalRequestId = TabMail._nextRequestId(TabMail.state.latestLocalRequestId);
    TabMail.invalidateGlobalRequest('suggestion dismissed');
    TabMail.state.correctedText = null;
    TabMail.hideComposePreview();
  },

  acceptComposePreview() {
    const displayed = TabMail.state.previewModel;
    if (!displayed) return false;
    // Selection notifications may still be queued. Never commit an older
    // sentence target after a newer caret action or a changed draft/proposal.
    TabMail.renderComposePreview();
    const model = TabMail.state.previewModel;
    if (!model || model.original !== displayed.original || JSON.stringify(model.edits) !== JSON.stringify(displayed.edits)) return false;
    if (!TabMail.applyComposeEdits(TabMail.state.editorRef, model.original, model.edits)) {
      TabMail.hideComposePreview();
      return false;
    }
    TabMail.dismissComposeSuggestion();
    TabMail.state.originalText = TabMail.extractUserAndQuoteTexts(TabMail.state.editorRef).originalUserMessage;
    TabMail.state.lastActionWasAccept = true;
    return true;
  },
});
