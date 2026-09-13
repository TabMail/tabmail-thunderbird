/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

var TabMail = TabMail || {};

Object.assign(TabMail, {
  /** One text projection for range offsets, requests, and native edits. */
  indexComposeText(root, boundary = null) {
    const entries = [];
    let text = '';
    let stopped = false;
    const append = (value, node, kind) => {
      entries.push({ start: text.length, end: text.length + value.length, node, kind });
      text += value;
    };
    const visit = node => {
      if (node === boundary) stopped = true;
      if (stopped) return;
      if (node.nodeType === Node.TEXT_NODE) {
        append(node.textContent, node, 'text');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node !== root) return;
      if (node.nodeType === Node.ELEMENT_NODE && node.matches(
        '[data-tabmail-ui], .tm-fake-caret, .tm-cursor-arrow, .tm-nl, .tm-edit-anchor, .tm-inline-overlay, .tm-inline-spinner, .tm-quote-separator, #tm-inline-edit, #tm-compose-hints-banner'
      )) return;
      if (node.nodeName === 'BR') {
        append('\n', node, 'break');
        return;
      }
      const start = text.length;
      for (const child of node.childNodes) visit(child);
      if (node !== root && !stopped && /^(DIV|P|LI|BLOCKQUOTE|H[1-6]|TR)$/.test(node.nodeName) && !text.slice(start).endsWith('\n')) {
        append('\n', node, 'block');
      }
    };
    visit(root);
    // A final block separator is layout, not authored message text.
    if (entries.at(-1)?.kind === 'block') {
      text = text.slice(0, -1);
      entries.pop();
    }
    return { root, text, entries, boundary };
  },

  composePointAt(index, offset, forward = false) {
    if (!Number.isInteger(offset) || offset < 0 || offset > index.text.length) return null;
    if (forward) {
      const entry = index.entries.find(e => e.kind === 'text' && e.start <= offset && offset < e.end);
      if (entry) return { node: entry.node, offset: offset - entry.start };
    }
    for (const entry of index.entries) {
      if (entry.kind === 'text' && offset >= entry.start && offset <= entry.end) {
        return { node: entry.node, offset: offset - entry.start };
      }
      if (offset === entry.start || offset === entry.end) {
        const parent = entry.node.parentNode;
        if (!parent) continue;
        const position = Array.prototype.indexOf.call(parent.childNodes, entry.node);
        return { node: parent, offset: position + (offset === entry.end ? 1 : 0) };
      }
    }
    const end = index.boundary;
    return end ? { node: end.parentNode, offset: Array.prototype.indexOf.call(end.parentNode.childNodes, end) } : { node: index.root, offset: index.root.childNodes.length };
  },

  composeRange(index, start, end = start) {
    const a = TabMail.composePointAt(index, start, start < end);
    const b = TabMail.composePointAt(index, end);
    if (!a || !b) return null;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  },

  composeCursorOffset(index) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !index.root.contains(selection.anchorNode)) return null;
    let offset = 0;
    const caret = document.createRange();
    caret.setStart(selection.anchorNode, selection.anchorOffset);
    caret.collapse(true);
    if (index.boundary) {
      const boundaryRange = document.createRange();
      boundaryRange.setStartBefore(index.boundary);
      boundaryRange.collapse(true);
      if (caret.compareBoundaryPoints(0, boundaryRange) > 0) return null;
    }
    for (const entry of index.entries) {
      if (entry.node === selection.anchorNode && entry.kind === 'text') return entry.start + selection.anchorOffset;
      if (entry.kind === 'block' && entry.node.contains(selection.anchorNode)) continue;
      const end = document.createRange();
      if (entry.kind === 'text') end.setStart(entry.node, entry.node.textContent.length);
      else end.setStartAfter(entry.node);
      end.collapse(true);
      if (end.compareBoundaryPoints(0, caret) <= 0) offset = entry.end;
    }
    return offset;
  },
});

Object.assign(TabMail, {
  /** Apply a complete edit as one native undoable editor command. */
  applyComposeEdits(editor, expectedText, edits) {
    const boundary = TabMail.getQuoteBoundaryNode(editor);
    const live = TabMail.indexComposeText(editor, boundary);
    if (live.text !== expectedText || TabMail.state.isIMEComposing) return false;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return false;
    const saved = selection.getRangeAt(0).cloneRange();
    const userRange = document.createRange();
    userRange.selectNodeContents(editor);
    if (boundary) userRange.setEndBefore(boundary);
    const fragment = userRange.cloneContents();
    const initial = TabMail.indexComposeText(fragment);
    if (initial.text !== expectedText) return false;
    let previous = expectedText.length;
    for (const edit of [...edits].reverse()) {
      if (edit.start < 0 || edit.end < edit.start || edit.end > previous || typeof edit.text !== 'string') return false;
      previous = edit.start;
      const index = TabMail.indexComposeText(fragment);
      const range = TabMail.composeRange(index, edit.start, edit.end);
      if (!range) return false;
      // Text-only proposals cannot authorize removing authored media or controls.
      const protectedNodes = fragment.querySelectorAll('img,svg,video,audio,iframe,object,embed,input,textarea,select,canvas,hr');
      if ([...protectedNodes].some(node => range.intersectsNode(node))) return false;
      range.deleteContents();
      const inserted = document.createDocumentFragment();
      const lines = edit.text.split('\n');
      lines.forEach((line, i) => {
        if (i) inserted.appendChild(document.createElement('br'));
        inserted.appendChild(document.createTextNode(line));
      });
      range.insertNode(inserted);
    }
    const expectedResult = edits.reduceRight((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), expectedText);
    // Block-boundary edits are accepted only when the DOM projection exactly
    // represents the proposal. Never silently commit a structurally different edit.
    if (TabMail.indexComposeText(fragment).text !== expectedResult) return false;
    const caretOffset = edits.length ? edits[edits.length - 1].end + edits.reduce((delta, edit) => delta + edit.text.length - (edit.end - edit.start), 0) : TabMail.composeCursorOffset(live);
    const container = document.createElement('div');
    container.appendChild(fragment);
    TabMail._beginProgrammaticSelection();
    TabMail.state.applyingPreview = true;
    try {
      selection.removeAllRanges();
      selection.addRange(userRange);
      const applied = document.execCommand('insertHTML', false, container.innerHTML);
      if (applied) {
        const current = TabMail.indexComposeText(editor, TabMail.getQuoteBoundaryNode(editor));
        const caret = TabMail.composeRange(current, Math.min(caretOffset ?? current.text.length, current.text.length));
        if (caret) {
          selection.removeAllRanges();
          selection.addRange(caret);
        }
      } else {
        selection.removeAllRanges();
        selection.addRange(saved);
      }
      return applied;
    } catch (error) {
      selection.removeAllRanges();
      selection.addRange(saved);
      TabMail.log.warn('compose', 'Native suggestion edit could not be applied');
      return false;
    } finally {
      TabMail.state.applyingPreview = false;
      TabMail._endProgrammaticSelection();
    }
  },
});
