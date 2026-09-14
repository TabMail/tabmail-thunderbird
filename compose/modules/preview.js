/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
var TabMail = TabMail || {};

TabMail.composeActionCSS = `
.tm-compose-actions { user-select: none; display: flex; flex-wrap: wrap; justify-content: flex-end; text-align: right; font: 11px/1.4 system-ui; color: var(--tm-preview-context); }

.tm-compose-actions button { pointer-events: auto; cursor: pointer; font: inherit; color: inherit; background: transparent; border: 0; border-radius: 4px; padding: 3px 6px; }
.tm-compose-actions button:disabled { cursor: default; opacity: .5; }
.tm-compose-actions button:hover, .tm-compose-actions button:focus-visible { background: var(--tm-preview-insert); color: var(--tm-preview-text); }

.tm-compose-actions .tm-placement-toggle { order: -1; margin-right: auto; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.tm-placement-toggle svg { width: 14px; height: 14px; flex: none; }

.tm-compose-actions kbd { display: inline-block; font: 10px/1.3 system-ui; border: 1px solid var(--tm-preview-border); border-radius: 3px; padding: 1px 4px; margin-right: 3px; white-space: nowrap; }
`;

// Inline stylesheet text is loaded with the compose script: Thunderbird blocks
// linked extension stylesheets inside the compose document's shadow tree.
TabMail.composePreviewCSS = `
.tm-compose-preview { color-scheme: light dark; pointer-events: none; }
.tm-compose-preview .preview { position: relative; z-index: 1; box-sizing: border-box; max-height: calc(100vh - 16px); overflow: auto; pointer-events: auto; padding: 10px 12px; border: 1px solid var(--tm-preview-border); border-radius: 8px; background: var(--tm-preview-bg); color: var(--tm-preview-text); box-shadow: 0 4px 16px var(--tm-preview-shadow); }
.tm-compose-preview .content { white-space: pre-wrap; overflow-wrap: anywhere; }
.tm-compose-preview .context { color: var(--tm-preview-context); }
.tm-compose-preview .inserted { background: var(--tm-preview-insert); box-decoration-break: clone; }
.tm-compose-preview .actions { margin-top: 6px; }
${TabMail.composeActionCSS}
.tm-compose-preview .source-underline, .tm-compose-preview .source-deletion { position: fixed; z-index: 0; height: 0; border-bottom-style: solid; border-bottom-width: 1px; border-bottom-color: var(--in-content-accent-color); pointer-events: none; }

.tm-compose-preview .source-deletion { border-bottom-width: 2px; border-bottom-color: var(--tm-preview-delete); }
`;

Object.assign(TabMail, {
  createComposePlacementToggle() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tm-placement-toggle';
    button._tm_updatePlacementLabel = () => {
      const docked = TabMail.state.composeBubblePlacement === 'bottom';
      const label = docked ? 'Follow cursor' : 'Dock at bottom';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 20 20');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', docked ? 'M5 3.5 15 10l-4.5 1-2 4.5Z' : 'M4 3.5h12a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM3 12.5h14');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      button.replaceChildren(svg, document.createTextNode(label));
      button.setAttribute('aria-label', label);
      button.title = label;
    };
    button._tm_updatePlacementLabel();
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        // Use the existing shared storage listener for live positioning and
        // persistence, including other compose windows and the Appearance page.
        await browser.storage.local.set({composeBubblePlacement: TabMail.state.composeBubblePlacement === 'bottom' ? 'cursor' : 'bottom'});
      } catch (error) {
        TabMail.log.warn('compose', 'Could not update bubble placement', error);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  },

  positionDockedComposeBubble(surface) {
    const margin = TabMail.config.preview.margin;
    Object.assign(surface.style, {
      position: 'fixed', left: `${margin}px`, width: `${Math.max(1, window.innerWidth - margin * 2)}px`,
      top: 'auto', bottom: `${margin}px`, maxHeight: `${Math.max(1, window.innerHeight - margin * 2)}px`,
      overflowY: 'auto', boxSizing: 'border-box',
    });
  },

  retainDockedComposePreview() {
    const {state} = TabMail;
    const view = state.previewView;
    if (state.composeBubblePlacement !== 'bottom' || !view?.root.querySelector('.preview')) return false;
    // Retain presentation only. Native typing invalidates the acceptance model
    // and source geometry immediately; backend scheduling remains unchanged.
    state.previewModel = null;
    state.previewJumpOffset = null;
    state.isDiffActive = false;
    view.pending = true;
    view.root.querySelectorAll('.source-underline, .source-deletion').forEach(node => node.remove());
    const accept = view.root.querySelector('[aria-label="Accept"]');
    if (accept) accept.disabled = true;
    TabMail.positionDockedComposeBubble(view.host);
    return true;
  },

  hideComposePreview() {
    TabMail.state.previewView?.host.remove();
    TabMail.removeJumpOverlay?.();
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
    if (!editor || state.autocompleteDisabled || state.inlineEditActive || state.isIMEComposing || state.beforeSendCleanupActive || !sel?.isCollapsed) { TabMail.hideComposePreview(); return; }
    if ((!show || !state.correctedText) && state.previewView?.pending && state.composeBubblePlacement === 'bottom') {
      TabMail.positionDockedComposeBubble(state.previewView.host);
      return;
    }
    if (!show) { TabMail.hideComposePreview(); return; }
    const index = TabMail.indexComposeText(editor, TabMail.getQuoteBoundaryNode(editor));
    const cursor = TabMail.composeCursorOffset(index);
    const anchorElement = sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode?.parentElement;
    const inSignature = cursor === null && editor.contains(sel.anchorNode) && !!anchorElement?.closest('.moz-signature');
    if ((cursor === null && !inSignature) || typeof state.correctedText !== 'string' || !state.correctedText || state.correctedText === index.text) { TabMail.hideComposePreview(); return; }
    // A signature cursor may navigate to a body edit, but never becomes an
    // editable offset or part of the autocomplete request projection.
    const model = inSignature
      ? { edits: [], jumpOffset: TabMail.composeEditsFromDiff(TabMail.computeDiff(index.text, state.correctedText))[0]?.start }
      : TabMail.buildPreviewModel(index.text, state.correctedText, cursor, index.entries.filter(entry => entry.kind === 'block').map(entry => entry.start));
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
      // Thunderbird encodes the whole compose document, including siblings of
      // BODY. Keep proposal text in a non-serializable shadow tree.
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = TabMail.composePreviewCSS;
      shadow.appendChild(style);
      const root = document.createElement('div');
      root.className = 'tm-compose-preview';
      shadow.appendChild(root);
      view = state.previewView = { host, root };
    }
    view.pending = false;
    const { host, root } = view;
    root.replaceChildren();
    TabMail.removeJumpOverlay();
    if (!model.edits.length) {
      // Keep the established caret/arrow hint instead of a sentence bubble.
      const caret = TabMail.createFakeCaret(model.jumpOffset);
      const caretStyle = document.getElementById('tm-caret-styles');
      if (caretStyle) root.appendChild(caretStyle.cloneNode(true));
      const arrow = TabMail.createArrow(model.jumpOffset, 'down');
      const range = TabMail.composeRange(index, model.jumpOffset);
      let rect = range.getBoundingClientRect();
      if (!rect.height && model.jumpOffset < index.text.length) {
        rect = TabMail.composeRange(index, model.jumpOffset, model.jumpOffset + 1).getBoundingClientRect();
      }
      const offsets = TabMail.config.colors.cursorJump.offsets;
      for (const [node, x, y] of [[caret, offsets.caretX, offsets.caretY], [arrow, offsets.arrowX, offsets.arrowY]]) {
        Object.assign(node.style, {position:'fixed',left:`${rect.left + x}px`,top:`${rect.top + y}px`});
        node.setAttribute('aria-hidden', 'true');
        root.appendChild(node);
      }
      host.style.cssText = `position:fixed;left:0;top:0;pointer-events:none;z-index:${cfg.zIndex}`;
      if (!host.isConnected) document.documentElement.appendChild(host);
      TabMail.manageJumpOverlay(editor, caret);
      state.isDiffActive = false;
      return;
    }
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
    content.style.fontSize = `${parseFloat(style.fontSize) * cfg.fontScale}px`;
    content.style.lineHeight = style.lineHeight === 'normal' ? 'normal' : `${parseFloat(style.lineHeight) * cfg.fontScale}px`;
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
          span.style[property] = property === 'fontSize' ? `${parseFloat(typography.fontSize) * cfg.fontScale}px` : typography[property];
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
        const segments = [{start:a,end:b,deleted:false}, ...model.edits
          .filter(edit => edit.start < b && edit.end > a)
          .map(edit => ({start:Math.max(a,edit.start),end:Math.min(b,edit.end),deleted:true}))];
        for (const segment of segments) {
          const range = document.createRange();
          range.setStart(entry.node, segment.start - entry.start);
          range.setEnd(entry.node, segment.end - entry.start);
          for (const rect of range.getClientRects()) {
            if (!rect.width || !rect.height) continue;
            const line = document.createElement('span');
            line.className = segment.deleted ? 'source-deletion' : 'source-underline';
            line.setAttribute('aria-hidden', 'true');
            Object.assign(line.style, {left: `${rect.left}px`, top: `${rect.bottom - 1}px`, width: `${rect.width}px`});
            root.appendChild(line);
          }
        }
      }
    }
    bubble.appendChild(content);
    const actions = document.createElement('div');
    actions.className = 'actions tm-compose-actions';
    const action = (label, shortcut, title, run) => {
      const button = document.createElement('button');
      button.type = 'button';
      const key = document.createElement('kbd');
      key.textContent = shortcut;
      key.setAttribute('aria-hidden', 'true');
      button.append(key, document.createTextNode(` ${label}`));
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-keyshortcuts', shortcut === '⇧Esc' ? 'Shift+Escape' : shortcut === 'Esc' ? 'Escape' : shortcut);
      button.title = title;
      // Keep the native compose selection when using the mouse.
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', run);
      actions.appendChild(button);
    };
    action('Accept', 'Tab', 'Accept suggestion (Tab)', () => TabMail.acceptComposePreview());
    action('Dismiss', 'Esc', 'Dismiss suggestion (Esc)', () => TabMail.dismissComposeSuggestion());
    action('Disable suggestions', '⇧Esc', 'Disable suggestions (Shift+Esc)', () => TabMail.setAutocompleteEnabled(false));
    actions.appendChild(TabMail.createComposePlacementToggle());
    bubble.appendChild(actions);
    root.appendChild(bubble);
    // Keep the surface inset from both viewport edges, preserving source
    // alignment wherever the available space permits.
    const x = Math.min(Math.max(cfg.margin, left - cfg.padding - 1), Math.max(cfg.margin, window.innerWidth - cfg.margin - cfg.minWidth));
    const availableWidth = Math.max(1, window.innerWidth - x - cfg.margin);
    const width = Math.min(availableWidth, Math.max(cfg.minWidth, editorRect.right - x + cfg.padding + 1));
    bubble.style.paddingLeft = `${cfg.padding}px`;
    bubble.style.paddingRight = `${cfg.padding}px`;
    Object.assign(host.style, { position: 'fixed', zIndex: String(cfg.zIndex), left: `${x}px`, top: `${bottom + cfg.gap}px`, width: `${width}px` });
    // Keep the surface out of authored BODY; shadow contents are excluded by the encoder.
    if (!host.isConnected) document.documentElement.appendChild(host);
    const place = () => {
      if (!host.isConnected) return;
      const height = host.getBoundingClientRect().height;
      const y = bottom + cfg.gap + height <= window.innerHeight - cfg.margin ? bottom + cfg.gap : Math.max(cfg.margin, top - cfg.gap - height);
      host.style.top = `${y}px`;
    };
    if (state.composeBubblePlacement === 'bottom') TabMail.positionDockedComposeBubble(host);
    else {
      host.style.bottom = '';
      host.style.maxHeight = '';
      host.style.overflowY = '';
      place();
    }
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
    // Acceptance keeps the cached remainder; dismissal alone discards it.
    TabMail.hideComposePreview();
    // Preserve processSpanAction's acceptance lifecycle, including its
    // deferred text sync. LOCAL completion owns the GLOBAL follow-up.
    TabMail.state.currentIdleTime = TabMail.config.autocompleteDelay.INITIAL_IDLE_MS;
    TabMail.state.lastSuggestionShownTime = 0;
    TabMail.state.textLengthAtLastSuggestion = 0;
    TabMail.cancelPendingBackendRequest();
    const editor = TabMail.state.editorRef;
    setTimeout(() => {
      TabMail.state.originalText = TabMail.extractUserAndQuoteTexts(editor).originalUserMessage;
    }, 0);
    TabMail.state.lastActionWasAccept = true;
    TabMail.renderComposePreview();
    return true;
  },
});
