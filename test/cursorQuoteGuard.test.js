// cursorQuoteGuard.test.js — Tests for cursor guard logic that prevents user
// input from landing inside non-editable regions (quote separator, diff inserts).
//
// Covers:
//   1. _getCleanedEditorTextWithOptionsRecursive — skips tm-quote-separator
//   2. _setCursorByOffsetInternal — skips tm-quote-separator in traverse
//   3. handleCursorInInsertSpan — ejects cursor from insert spans AND separator
//   4. _applyFragmentToEditor — empty text node anchor before separator

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

// ─────────────────────────────────────────────────────────────────────────────
// DOM mock helpers — lightweight, just enough to exercise the real code paths.
// ─────────────────────────────────────────────────────────────────────────────

function makeElement(tag, opts = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1, // ELEMENT_NODE
    style: {},
    dataset: { ...opts.dataset },
    childNodes: [],
    parentNode: opts.parentNode || null,
    classList: {
      _classes: opts.classes ? [...opts.classes] : [],
      add(cls) { this._classes.push(cls); },
      contains(cls) { return this._classes.includes(cls); },
    },
    hasChildNodes() { return this.childNodes.length > 0; },
    appendChild(child) {
      child.parentNode = el;
      this.childNodes.push(child);
      return child;
    },
    insertBefore(newChild, refChild) {
      newChild.parentNode = el;
      const idx = this.childNodes.indexOf(refChild);
      if (idx === -1) {
        this.childNodes.push(newChild);
      } else {
        this.childNodes.splice(idx, 0, newChild);
      }
      return newChild;
    },
    contains(other) {
      if (other === el) return true;
      for (const c of el.childNodes) {
        if (c === other) return true;
        if (c.nodeType === 1 && c.contains && c.contains(other)) return true;
      }
      return false;
    },
    setAttribute() {},
    getAttribute() { return null; },
    querySelector(sel) {
      // Minimal querySelector supporting class selectors
      for (const c of el.childNodes) {
        if (c.nodeType === 1) {
          if (sel.startsWith('.') && c.classList && c.classList.contains(sel.slice(1))) return c;
          if (c.tagName === sel.toUpperCase()) return c;
          if (c.querySelector) {
            const found = c.querySelector(sel);
            if (found) return found;
          }
        }
      }
      return null;
    },
    get lastChild() { return this.childNodes.length ? this.childNodes[this.childNodes.length - 1] : null; },
    get firstChild() { return this.childNodes.length ? this.childNodes[0] : null; },
    get previousSibling() {
      if (!el.parentNode) return null;
      const idx = el.parentNode.childNodes.indexOf(el);
      return idx > 0 ? el.parentNode.childNodes[idx - 1] : null;
    },
    textContent: opts.text || '',
    contentEditable: opts.contentEditable !== undefined ? opts.contentEditable : 'true',
    className: opts.classes ? opts.classes.join(' ') : '',
  };
  return el;
}

function makeTextNode(text) {
  return {
    nodeType: 3, // TEXT_NODE
    textContent: text,
    parentNode: null,
    get length() { return this.textContent.length; },
  };
}

function makeFragment() {
  const frag = {
    nodeType: 11,
    childNodes: [],
    hasChildNodes() { return this.childNodes.length > 0; },
    appendChild(child) { child.parentNode = frag; this.childNodes.push(child); return child; },
    insertBefore(newChild, refChild) {
      newChild.parentNode = frag;
      const idx = this.childNodes.indexOf(refChild);
      if (idx === -1) {
        this.childNodes.push(newChild);
      } else {
        this.childNodes.splice(idx, 0, newChild);
      }
      return newChild;
    },
    get lastChild() { return this.childNodes.length ? this.childNodes[this.childNodes.length - 1] : null; },
    get textContent() { return this.childNodes.map(c => c.textContent || '').join(''); },
  };
  return frag;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Text extraction — tm-quote-separator is skipped
// ═══════════════════════════════════════════════════════════════════════════════

describe('_getCleanedEditorTextWithOptionsRecursive skips tm-quote-separator', () => {
  let TM;

  beforeAll(() => {
    const code = readFileSync(resolve(__dirname, '../compose/modules/dom.js'), 'utf8');
    const sandbox = {
      TabMail: {
        config: { DELETED_NEWLINE_VISUAL_CHAR: null, HIDE_DELETE_NEWLINES: false, quoteSeparator: {} },
        log: { debug: () => {}, info: () => {} },
        state: { editorRef: null, currentlyHighlightedSpans: [] },
        _beginProgrammaticSelection: () => {},
        _endProgrammaticSelection: () => {},
      },
      console,
      Object, Array, String, Number, RegExp, Math, Map, Set, NaN, Infinity,
      parseInt, parseFloat, isNaN,
      Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4 },
      document: {
        getElementById: () => true,
        createElement: (tag) => makeElement(tag),
        createDocumentFragment: () => makeFragment(),
        createTextNode: (text) => makeTextNode(text),
        head: { appendChild: () => {} },
        documentElement: { appendChild: () => {} },
        body: { contains: () => false },
        createRange: () => ({
          selectNodeContents: () => {},
          setEndBefore: () => {},
          setEnd: () => {},
          setStart: () => {},
          setStartBefore: () => {},
          setStartAfter: () => {},
          collapse: () => {},
          deleteContents: () => {},
          insertNode: () => {},
          cloneRange: () => ({}),
        }),
      },
      window: { getSelection: () => null, scrollTo: () => {} },
    };
    runInNewContext(code, sandbox);
    TM = sandbox.TabMail;
  });

  function buildDiv(...children) {
    const div = makeElement('div');
    for (const child of children) {
      div.appendChild(child);
    }
    return div;
  }

  function makeSeparator() {
    const sep = makeElement('span', { classes: ['tm-quote-separator'], contentEditable: 'false' });
    sep.appendChild(makeElement('br'));
    return sep;
  }

  it('returns empty string when user region contains only the separator', () => {
    const root = buildDiv(makeSeparator());
    expect(TM._getCleanedEditorTextWithOptionsRecursive(root)).toBe('');
  });

  it('extracts text before the separator', () => {
    const root = buildDiv(makeTextNode('Hello'), makeSeparator());
    expect(TM._getCleanedEditorTextWithOptionsRecursive(root)).toBe('Hello');
  });

  it('does NOT extract text that Gecko placed inside the separator', () => {
    // This is the exact bug scenario — Gecko places "T" inside the separator span
    const sep = makeSeparator();
    // Simulate Gecko inserting a text node into the separator
    const textInSep = makeTextNode('T');
    sep.childNodes.unshift(textInSep);
    textInSep.parentNode = sep;

    const root = buildDiv(sep);
    // The separator and its contents must be fully skipped
    expect(TM._getCleanedEditorTextWithOptionsRecursive(root)).toBe('');
  });

  it('extracts text around separator correctly', () => {
    const root = buildDiv(
      makeTextNode('Before'),
      makeSeparator(),
    );
    expect(TM._getCleanedEditorTextWithOptionsRecursive(root)).toBe('Before');
  });

  it('skips separator but processes other spans normally', () => {
    const span = makeElement('span');
    span.appendChild(makeTextNode('content'));

    const root = buildDiv(
      makeTextNode('A'),
      makeSeparator(),
      span,
    );
    // separator skipped, but the plain span's text should be extracted
    // (the plain span appears after the separator, but extraction should still get it)
    expect(TM._getCleanedEditorTextWithOptionsRecursive(root)).toBe('Acontent');
  });

  it('skips tm-fake-caret alongside tm-quote-separator', () => {
    const caret = makeElement('span', { classes: ['tm-fake-caret'] });
    const root = buildDiv(makeTextNode('X'), caret, makeSeparator());
    expect(TM._getCleanedEditorTextWithOptionsRecursive(root)).toBe('X');
  });

  it('handles skipInserts option with separator present', () => {
    const insertSpan = makeElement('span', { dataset: { tabmailDiff: 'insert' } });
    insertSpan.appendChild(makeTextNode('added'));

    const root = buildDiv(
      makeTextNode('keep'),
      insertSpan,
      makeSeparator(),
    );
    expect(TM._getCleanedEditorTextWithOptionsRecursive(root, { skipInserts: true })).toBe('keep');
    expect(TM._getCleanedEditorTextWithOptionsRecursive(root, { skipInserts: false })).toBe('keepadded');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 2. _setCursorByOffsetInternal — skips tm-quote-separator in traverse
// ═══════════════════════════════════════════════════════════════════════════════

describe('_setCursorByOffsetInternal skips tm-quote-separator', () => {
  let TM;
  let lastRange;
  let lastSelection;

  beforeAll(() => {
    const code = readFileSync(resolve(__dirname, '../compose/modules/dom.js'), 'utf8');

    lastRange = { startNode: null, startOffset: null };
    lastSelection = null;

    const sandbox = {
      TabMail: {
        config: { DELETED_NEWLINE_VISUAL_CHAR: null, HIDE_DELETE_NEWLINES: false, quoteSeparator: {} },
        log: { debug: () => {}, info: () => {} },
        state: { editorRef: null, currentlyHighlightedSpans: [] },
        _beginProgrammaticSelection: () => {},
        _endProgrammaticSelection: () => {},
      },
      console,
      Object, Array, String, Number, RegExp, Math, Map, Set, NaN, Infinity,
      parseInt, parseFloat, isNaN,
      Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4 },
      document: {
        getElementById: () => true,
        createElement: (tag) => makeElement(tag),
        createDocumentFragment: () => makeFragment(),
        createTextNode: (text) => makeTextNode(text),
        head: { appendChild: () => {} },
        documentElement: { appendChild: () => {} },
        body: { contains: () => false },
        createRange: () => {
          const r = {
            startContainer: null,
            startOffset: null,
            setStart(node, offset) { r.startContainer = node; r.startOffset = offset; lastRange.startNode = node; lastRange.startOffset = offset; },
            setStartBefore(node) { r.startContainer = node.parentNode; r.startOffset = -1; lastRange.startNode = node; lastRange.startOffset = -1; },
            setStartAfter(node) { r.startContainer = node.parentNode; r.startOffset = -2; lastRange.startNode = node; lastRange.startOffset = -2; },
            setEndBefore(node) {},
            setEnd() {},
            collapse() {},
            selectNodeContents() {},
            cloneRange() { return r; },
          };
          return r;
        },
      },
      window: {
        getSelection: () => ({
          isCollapsed: true,
          rangeCount: 1,
          removeAllRanges: () => {},
          addRange: (r) => { lastSelection = r; },
          getRangeAt: () => ({
            cloneRange: () => ({
              collapse: () => {},
              insertNode: () => {},
            }),
          }),
        }),
        scrollTo: () => {},
        getComputedStyle: () => ({ overflowY: 'visible' }),
      },
    };
    runInNewContext(code, sandbox);
    TM = sandbox.TabMail;
  });

  beforeEach(() => {
    lastRange = { startNode: null, startOffset: null };
    lastSelection = null;
  });

  function makeSeparator() {
    const sep = makeElement('span', { classes: ['tm-quote-separator'], contentEditable: 'false' });
    sep.appendChild(makeElement('br'));
    return sep;
  }

  it('places cursor in text node before separator, not inside separator', () => {
    const editor = makeElement('body');
    const textNode = makeTextNode('Hello');
    editor.appendChild(textNode);
    editor.appendChild(makeSeparator());

    TM._setCursorByOffsetInternal(editor, 3);

    // Cursor should be at offset 3 in the text node, not inside the separator
    expect(lastRange.startNode).toBe(textNode);
    expect(lastRange.startOffset).toBe(3);
  });

  it('places cursor at end of text node (offset=5) when separator follows', () => {
    const editor = makeElement('body');
    const textNode = makeTextNode('Hello');
    editor.appendChild(textNode);
    editor.appendChild(makeSeparator());

    TM._setCursorByOffsetInternal(editor, 5);

    expect(lastRange.startNode).toBe(textNode);
    expect(lastRange.startOffset).toBe(5);
  });

  it('does not count separator BR as a character', () => {
    // Before the fix, the separator's BR would count as 1 char,
    // making offset 0 land inside the separator (before the BR).
    const editor = makeElement('body');
    const sep = makeSeparator();
    editor.appendChild(sep);

    TM._setCursorByOffsetInternal(editor, 0);

    // Cursor should NOT be inside the separator — it should use the fallback
    // (collapsed to end of user region). The separator's BR must not be counted.
    // The startNode should NOT be a child of the separator.
    if (lastRange.startNode) {
      let node = lastRange.startNode;
      while (node) {
        expect(node).not.toBe(sep);
        expect(node.classList?.contains?.('tm-quote-separator')).not.toBe(true);
        node = node.parentNode;
      }
    }
  });

  it('places cursor at offset 0 in empty text node before separator', () => {
    const editor = makeElement('body');
    const emptyText = makeTextNode('');
    editor.appendChild(emptyText);
    editor.appendChild(makeSeparator());

    TM._setCursorByOffsetInternal(editor, 0);

    expect(lastRange.startNode).toBe(emptyText);
    expect(lastRange.startOffset).toBe(0);
  });

  it('skips tm-fake-caret AND tm-quote-separator in same region', () => {
    const editor = makeElement('body');
    const textNode = makeTextNode('AB');
    const caret = makeElement('span', { classes: ['tm-fake-caret'] });
    const sep = makeSeparator();

    editor.appendChild(textNode);
    editor.appendChild(caret);
    editor.appendChild(sep);

    TM._setCursorByOffsetInternal(editor, 1);

    expect(lastRange.startNode).toBe(textNode);
    expect(lastRange.startOffset).toBe(1);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 3. handleCursorInInsertSpan — ejects cursor from forbidden regions
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleCursorInInsertSpan', () => {
  let TM;
  let setCursorBeforeNodeCalls;

  beforeAll(() => {
    // Load events.js which has handleCursorInInsertSpan
    const code = readFileSync(resolve(__dirname, '../compose/modules/events.js'), 'utf8');

    setCursorBeforeNodeCalls = [];

    const sandbox = {
      TabMail: {
        config: {
          SELECTION_DEBOUNCE_MS: 200,
          INITIAL_IDLE_MS: 250,
          autocompleteDelay: {
            INITIAL_IDLE_MS: 250,
            MAX_IDLE_MS: 2000,
            BACKOFF_STEP_MS: 250,
            IGNORE_CHARS_THRESHOLD: 5,
            LONG_IDLE_RESET_MS: 30000,
          },
        },
        log: { debug: () => {}, info: () => {}, trace: () => {}, warn: () => {}, error: () => {} },
        state: {
          editorRef: null,
          isIMEComposing: false,
          selectionMuteDepth: 0,
          isDiffActive: false,
          autoHideDiff: false,
          lastKeystrokeAdheredToSuggestion: false,
          inlineEditActive: false,
          pendingUndoSnapshot: null,
          autocompleteIdleTimer: null,
          selectionDebounceTimer: null,
          currentIdleTime: 250,
          lastUserActivityTime: 0,
          lastSuggestionShownTime: 0,
          textLengthAtLastSuggestion: 0,
          isLocalRequestInFlight: false,
          correctedText: null,
          showDiff: true,
        },
        isInputEvent: () => false,
        setCursorBeforeNode: (node) => setCursorBeforeNodeCalls.push(node),
        findSpansAtCursor: () => [],
        renderText: () => {},
        handleAutohideDiff: () => false,
        handleUndoSnapshot: () => {},
        handleInputWhileSelection: () => false,
        handleAcceptOrReject: () => false,
        handleNavigateSpan: () => false,
        _checkAndResetIdleTime: () => {},
        _beginProgrammaticSelection: () => {},
        _endProgrammaticSelection: () => {},
        extractUserAndQuoteTexts: () => ({ originalUserMessage: '', quoteBoundaryNode: null }),
        getCursorOffsetIgnoringInserts: () => 0,
        handleCursorHighlighting: () => {},
        updateSpanHighlighting: () => {},
        cleanupEventListeners: () => {},
        _applyAdherenceToDiffs: () => {},
        _renderWithExistingDiffs: () => {},
        triggerCorrection: () => {},
        pushUndoSnapshot: () => {},
      },
      console,
      Object, Array, String, Number, RegExp, Math,
      setTimeout, clearTimeout,
      Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
      window: { getSelection: () => null },
      document: {
        addEventListener: () => {},
        removeEventListener: () => {},
        designMode: 'off',
        createRange: () => ({
          selectNodeContents: () => {},
          setEndBefore: () => {},
        }),
      },
    };

    runInNewContext(code, sandbox);
    TM = sandbox.TabMail;
  });

  beforeEach(() => {
    setCursorBeforeNodeCalls = [];
    TM.isInputEvent = () => true;
  });

  afterEach(() => {
    TM.isInputEvent = () => false;
  });

  function setupSelection(anchorNode, editorRef) {
    TM.state.editorRef = editorRef || makeElement('body');
    // Mock window.getSelection via the sandbox — we need to override at call time
    // Since events.js captures `window` at load time, we override TM's reference.
    // Actually, handleCursorInInsertSpan uses the global `window.getSelection`.
    // We need to set it on the sandbox's window object.
  }

  it('returns false for non-insert events', () => {
    TM.isInputEvent = () => false;
    const result = TM.handleCursorInInsertSpan({ type: 'keydown', key: 'ArrowLeft' });
    expect(result).toBe(false);
    expect(setCursorBeforeNodeCalls.length).toBe(0);
  });

  it('returns true for insert events (always)', () => {
    TM.isInputEvent = () => true;
    // window.getSelection returns null by default
    const result = TM.handleCursorInInsertSpan({ type: 'keydown', key: 'a' });
    expect(result).toBe(true);
  });

  it('does not throw when selection is null', () => {
    TM.isInputEvent = () => true;
    expect(() => TM.handleCursorInInsertSpan({ type: 'keydown', key: 'a' })).not.toThrow();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 3b. handleCursorInInsertSpan with full DOM selection mock
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleCursorInInsertSpan cursor ejection', () => {
  let setCursorBeforeNodeCalls;
  let mockAnchorNode;
  let TM;
  let sandboxWindow;

  beforeAll(() => {
    const code = readFileSync(resolve(__dirname, '../compose/modules/events.js'), 'utf8');

    setCursorBeforeNodeCalls = [];
    mockAnchorNode = null;

    sandboxWindow = {
      getSelection: () => mockAnchorNode ? {
        isCollapsed: true,
        anchorNode: mockAnchorNode,
        rangeCount: 1,
        removeAllRanges: () => {},
        addRange: () => {},
        getRangeAt: () => ({ cloneRange: () => ({ collapse: () => {}, insertNode: () => {} }) }),
      } : null,
    };

    const sandbox = {
      TabMail: {
        config: {
          SELECTION_DEBOUNCE_MS: 200,
          INITIAL_IDLE_MS: 250,
          autocompleteDelay: {
            INITIAL_IDLE_MS: 250,
            MAX_IDLE_MS: 2000,
            BACKOFF_STEP_MS: 250,
            IGNORE_CHARS_THRESHOLD: 5,
            LONG_IDLE_RESET_MS: 30000,
          },
        },
        log: { debug: () => {}, info: () => {}, trace: () => {}, warn: () => {}, error: () => {} },
        state: {
          editorRef: null,
          isIMEComposing: false,
          selectionMuteDepth: 0,
          isDiffActive: false,
          autoHideDiff: false,
          lastKeystrokeAdheredToSuggestion: false,
          inlineEditActive: false,
          pendingUndoSnapshot: null,
          autocompleteIdleTimer: null,
          selectionDebounceTimer: null,
          currentIdleTime: 250,
          lastUserActivityTime: 0,
          lastSuggestionShownTime: 0,
          textLengthAtLastSuggestion: 0,
          isLocalRequestInFlight: false,
          correctedText: null,
          showDiff: true,
        },
        isInputEvent: () => true,
        setCursorBeforeNode: (node) => setCursorBeforeNodeCalls.push(node),
        findSpansAtCursor: () => [],
        renderText: () => {},
        handleAutohideDiff: () => false,
        handleUndoSnapshot: () => {},
        handleInputWhileSelection: () => false,
        handleAcceptOrReject: () => false,
        handleNavigateSpan: () => false,
        _checkAndResetIdleTime: () => {},
        _beginProgrammaticSelection: () => {},
        _endProgrammaticSelection: () => {},
        extractUserAndQuoteTexts: () => ({ originalUserMessage: '', quoteBoundaryNode: null }),
        getCursorOffsetIgnoringInserts: () => 0,
        handleCursorHighlighting: () => {},
        updateSpanHighlighting: () => {},
        cleanupEventListeners: () => {},
        _applyAdherenceToDiffs: () => {},
        _renderWithExistingDiffs: () => {},
        triggerCorrection: () => {},
        pushUndoSnapshot: () => {},
      },
      console,
      Object, Array, String, Number, RegExp, Math,
      setTimeout, clearTimeout,
      Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
      window: sandboxWindow,
      document: {
        addEventListener: () => {},
        removeEventListener: () => {},
        designMode: 'off',
        createRange: () => ({
          selectNodeContents: () => {},
          setEndBefore: () => {},
        }),
      },
    };

    runInNewContext(code, sandbox);
    TM = sandbox.TabMail;
  });

  beforeEach(() => {
    setCursorBeforeNodeCalls = [];
    mockAnchorNode = null;
    TM.isInputEvent = () => true;
  });

  it('ejects cursor from INSERT span', () => {
    const editor = makeElement('body');
    const insertSpan = makeElement('span', { dataset: { tabmailDiff: 'insert' } });
    const textInInsert = makeTextNode('added');
    insertSpan.appendChild(textInInsert);
    editor.appendChild(insertSpan);

    TM.state.editorRef = editor;
    mockAnchorNode = textInInsert;
    // Set parentNode chain for walk-up
    textInInsert.parentNode = insertSpan;
    insertSpan.parentNode = editor;

    TM.handleCursorInInsertSpan({ type: 'keydown', key: 'a' });

    expect(setCursorBeforeNodeCalls.length).toBe(1);
    expect(setCursorBeforeNodeCalls[0]).toBe(insertSpan);
  });

  it('ejects cursor from tm-quote-separator', () => {
    const editor = makeElement('body');
    const sep = makeElement('span', { classes: ['tm-quote-separator'], contentEditable: 'false' });
    const brInSep = makeElement('br');
    sep.appendChild(brInSep);
    editor.appendChild(sep);

    TM.state.editorRef = editor;
    mockAnchorNode = brInSep;
    brInSep.parentNode = sep;
    sep.parentNode = editor;

    TM.handleCursorInInsertSpan({ type: 'keydown', key: 'T' });

    expect(setCursorBeforeNodeCalls.length).toBe(1);
    expect(setCursorBeforeNodeCalls[0]).toBe(sep);
  });

  it('ejects cursor from text node inside separator', () => {
    // Gecko placed user text inside separator
    const editor = makeElement('body');
    const sep = makeElement('span', { classes: ['tm-quote-separator'], contentEditable: 'false' });
    const textInSep = makeTextNode('T');
    sep.appendChild(textInSep);
    editor.appendChild(sep);

    TM.state.editorRef = editor;
    mockAnchorNode = textInSep;
    textInSep.parentNode = sep;
    sep.parentNode = editor;

    TM.handleCursorInInsertSpan({ type: 'keydown', key: 'e' });

    expect(setCursorBeforeNodeCalls.length).toBe(1);
    expect(setCursorBeforeNodeCalls[0]).toBe(sep);
  });

  it('does not eject cursor from normal text node outside forbidden regions', () => {
    const editor = makeElement('body');
    const textNode = makeTextNode('Hello');
    editor.appendChild(textNode);

    TM.state.editorRef = editor;
    mockAnchorNode = textNode;
    textNode.parentNode = editor;

    TM.handleCursorInInsertSpan({ type: 'keydown', key: 'a' });

    expect(setCursorBeforeNodeCalls.length).toBe(0);
  });

  it('does not eject cursor from DELETE span (only INSERT is ejected)', () => {
    const editor = makeElement('body');
    const deleteSpan = makeElement('span', { dataset: { tabmailDiff: 'delete' } });
    const textInDelete = makeTextNode('removed');
    deleteSpan.appendChild(textInDelete);
    editor.appendChild(deleteSpan);

    TM.state.editorRef = editor;
    mockAnchorNode = textInDelete;
    textInDelete.parentNode = deleteSpan;
    deleteSpan.parentNode = editor;

    TM.handleCursorInInsertSpan({ type: 'keydown', key: 'a' });

    expect(setCursorBeforeNodeCalls.length).toBe(0);
  });

  it('does not eject cursor from EQUAL span', () => {
    const editor = makeElement('body');
    const equalSpan = makeElement('span', { dataset: { tabmailDiff: 'equal' } });
    const textInEqual = makeTextNode('same');
    equalSpan.appendChild(textInEqual);
    editor.appendChild(equalSpan);

    TM.state.editorRef = editor;
    mockAnchorNode = textInEqual;
    textInEqual.parentNode = equalSpan;
    equalSpan.parentNode = editor;

    TM.handleCursorInInsertSpan({ type: 'keydown', key: 'a' });

    expect(setCursorBeforeNodeCalls.length).toBe(0);
  });

  it('finds INSERT span through nested elements', () => {
    // anchorNode -> <b> -> <span insert> -> editor
    const editor = makeElement('body');
    const insertSpan = makeElement('span', { dataset: { tabmailDiff: 'insert' } });
    const bold = makeElement('b');
    const textNode = makeTextNode('nested');

    bold.appendChild(textNode);
    insertSpan.appendChild(bold);
    editor.appendChild(insertSpan);

    TM.state.editorRef = editor;
    mockAnchorNode = textNode;
    textNode.parentNode = bold;
    bold.parentNode = insertSpan;
    insertSpan.parentNode = editor;

    TM.handleCursorInInsertSpan({ type: 'keydown', key: 'x' });

    expect(setCursorBeforeNodeCalls.length).toBe(1);
    expect(setCursorBeforeNodeCalls[0]).toBe(insertSpan);
  });

  it('prefers innermost forbidden ancestor (INSERT inside separator)', () => {
    // Unlikely but test defensive: text -> INSERT -> separator -> editor
    const editor = makeElement('body');
    const sep = makeElement('span', { classes: ['tm-quote-separator'] });
    const insertSpan = makeElement('span', { dataset: { tabmailDiff: 'insert' } });
    const textNode = makeTextNode('x');

    insertSpan.appendChild(textNode);
    sep.appendChild(insertSpan);
    editor.appendChild(sep);

    TM.state.editorRef = editor;
    mockAnchorNode = textNode;
    textNode.parentNode = insertSpan;
    insertSpan.parentNode = sep;
    sep.parentNode = editor;

    TM.handleCursorInInsertSpan({ type: 'keydown', key: 'a' });

    // Should eject from the INSERT span (found first walking up)
    expect(setCursorBeforeNodeCalls.length).toBe(1);
    expect(setCursorBeforeNodeCalls[0]).toBe(insertSpan);
  });

  it('handles anchorNode being the editor itself (no ejection)', () => {
    const editor = makeElement('body');
    TM.state.editorRef = editor;
    mockAnchorNode = editor;

    TM.handleCursorInInsertSpan({ type: 'keydown', key: 'a' });

    expect(setCursorBeforeNodeCalls.length).toBe(0);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 4. _applyFragmentToEditor — empty text node anchor before separator
// ═══════════════════════════════════════════════════════════════════════════════

describe('_applyFragmentToEditor text node anchor', () => {
  let TM;

  beforeAll(() => {
    const domMocks = {
      Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4 },
      document: {
        getElementById: () => true,
        createElement: (tag) => makeElement(tag),
        createDocumentFragment: () => makeFragment(),
        createTextNode: (text) => makeTextNode(text),
        head: { appendChild: () => {} },
        body: { contains: () => false },
      },
      window: { getSelection: () => null },
    };

    // Load sentences.js first
    const sentencesCode = readFileSync(resolve(__dirname, '../compose/modules/sentences.js'), 'utf8');
    const sandbox = {
      TabMail: {},
      console,
      Node: domMocks.Node,
      document: domMocks.document,
      window: domMocks.window,
      Object, Array, String, Number, RegExp, Math, Map, Set, NaN, Infinity,
      parseInt, parseFloat, isNaN,
      setTimeout, clearTimeout,
      performance: { now: () => Date.now() },
    };

    runInNewContext(sentencesCode, sandbox);

    sandbox.TabMail.config = {
      getColor: (c) => c || 'inherit',
      colors: {
        insert: { background: '#e6ffe6', text: 'inherit' },
        delete: { background: '#ffe6e6', text: 'inherit' },
      },
      quoteSeparator: { BR_COUNT_DEFAULT: 2, BR_COUNT_WHEN_SIGNATURE_BOUNDARY_WITH_QUOTE_AFTER: 1 },
    };
    sandbox.TabMail.log = { debug: () => {}, warn: () => {}, error: () => {} };
    sandbox.TabMail._beginProgrammaticSelection = () => {};
    sandbox.TabMail._endProgrammaticSelection = () => {};
    sandbox.TabMail.setCursorByOffset = () => {};
    sandbox.TabMail.mapCursorOffsetFromOriginalToDiffView = () => 0;
    sandbox.TabMail.findSpansByDiffsAndCursor = () => [];
    sandbox.TabMail.updateSpanHighlighting = () => {};
    sandbox.TabMail._hasQuoteAfterNode = () => false;
    sandbox.TabMail.state = { editorRef: null };

    // Load diff.js
    const diffCode = readFileSync(resolve(__dirname, '../compose/modules/diff.js'), 'utf8');
    sandbox.Diff = { diffArrays: () => [] };
    sandbox.diff_match_patch = class {
      constructor() { this.Diff_EditCost = 4; }
      diff_main() { return []; }
    };

    runInNewContext(diffCode, sandbox);
    TM = sandbox.TabMail;
  });

  it('inserts empty text node before separator when fragment is empty', () => {
    // Simulate the exact bug scenario: empty text, quoteBoundaryNode present
    const editor = makeElement('body');
    const sigDiv = makeElement('div', { classes: ['moz-signature'] });
    editor.appendChild(sigDiv);

    const fragment = makeFragment();
    const rangeToReplace = {
      _deleted: false,
      _inserted: null,
      deleteContents() { this._deleted = true; },
      selectNodeContents() {},
      setEndBefore() {},
      insertNode(frag) { this._inserted = frag; },
      collapse() {},
      toString() { return ''; },
    };

    TM._applyFragmentToEditor(
      fragment, rangeToReplace, editor, sigDiv,
      [], // diffs
      0,  // cursorOffset
      false, // show_diffs
      0   // advanceCursorBy
    );

    // The fragment should now contain: [empty text node, separator span]
    const inserted = rangeToReplace._inserted;
    expect(inserted).not.toBeNull();
    expect(inserted.childNodes.length).toBe(2);

    // First child: empty text node
    const textAnchor = inserted.childNodes[0];
    expect(textAnchor.nodeType).toBe(3); // TEXT_NODE
    expect(textAnchor.textContent).toBe('');

    // Second child: separator span
    const sep = inserted.childNodes[1];
    expect(sep.nodeType).toBe(1); // ELEMENT_NODE
    expect(sep.classList.contains('tm-quote-separator')).toBe(true);
  });

  it('does not insert extra text node when fragment already ends with text', () => {
    const editor = makeElement('body');
    const sigDiv = makeElement('div', { classes: ['moz-signature'] });
    editor.appendChild(sigDiv);

    const fragment = makeFragment();
    // Pre-populate with a text node (simulating rendered diff text)
    fragment.appendChild(makeTextNode('Hello'));

    const rangeToReplace = {
      deleteContents() {},
      selectNodeContents() {},
      setEndBefore() {},
      insertNode(frag) { this._inserted = frag; },
      collapse() {},
      toString() { return 'Hello'; },
      _inserted: null,
    };

    TM._applyFragmentToEditor(
      fragment, rangeToReplace, editor, sigDiv,
      [[0, 'Hello']], 5, false, 0
    );

    const inserted = rangeToReplace._inserted;
    // Should have: [text "Hello", separator] — NO extra empty text node
    expect(inserted.childNodes.length).toBe(2);
    expect(inserted.childNodes[0].nodeType).toBe(3);
    expect(inserted.childNodes[0].textContent).toBe('Hello');
    expect(inserted.childNodes[1].classList.contains('tm-quote-separator')).toBe(true);
  });

  it('inserts text node when fragment ends with element (diff span)', () => {
    const editor = makeElement('body');
    const sigDiv = makeElement('div', { classes: ['moz-signature'] });
    editor.appendChild(sigDiv);

    const fragment = makeFragment();
    // Pre-populate with an element node (simulating a diff span)
    const diffSpan = makeElement('span', { dataset: { tabmailDiff: 'equal' } });
    diffSpan.appendChild(makeTextNode('text'));
    fragment.appendChild(diffSpan);

    const rangeToReplace = {
      deleteContents() {},
      selectNodeContents() {},
      setEndBefore() {},
      insertNode(frag) { this._inserted = frag; },
      collapse() {},
      toString() { return 'text'; },
      _inserted: null,
    };

    TM._applyFragmentToEditor(
      fragment, rangeToReplace, editor, sigDiv,
      [[0, 'text']], 4, false, 0
    );

    const inserted = rangeToReplace._inserted;
    // Should have: [diff span, empty text node, separator]
    expect(inserted.childNodes.length).toBe(3);
    expect(inserted.childNodes[0]).toBe(diffSpan);
    expect(inserted.childNodes[1].nodeType).toBe(3); // empty text anchor
    expect(inserted.childNodes[1].textContent).toBe('');
    expect(inserted.childNodes[2].classList.contains('tm-quote-separator')).toBe(true);
  });

  it('does not insert text node or separator when no quoteBoundaryNode', () => {
    const editor = makeElement('body');

    const fragment = makeFragment();

    const rangeToReplace = {
      deleteContents() {},
      selectNodeContents() {},
      setEndBefore() {},
      insertNode(frag) { this._inserted = frag; },
      collapse() {},
      toString() { return ''; },
      _inserted: null,
    };

    TM._applyFragmentToEditor(
      fragment, rangeToReplace, editor, null, // no quoteBoundaryNode
      [], 0, false, 0
    );

    const inserted = rangeToReplace._inserted;
    // No separator, no text anchor
    expect(inserted.childNodes.length).toBe(0);
  });
});
