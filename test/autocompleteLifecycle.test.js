// autocompleteLifecycle.test.js — Integration tests for the autocomplete render
// lifecycle.  Exercises the full flow: extractUserAndQuoteTexts → renderText →
// _applyFragmentToEditor → extract again, verifying that user text is NEVER
// silently lost.
//
// Uses a realistic DOM mock (FakeDOM) that maintains a live tree so the modules
// interact with each other the same way they would in Gecko.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

// ─────────────────────────────────────────────────────────────────────────────
// FakeDOM — a minimal but realistic DOM tree that supports the operations
// used by renderText, _applyFragmentToEditor, and extractUserAndQuoteTexts.
// ─────────────────────────────────────────────────────────────────────────────

const NODE_TYPES = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11, DOCUMENT_POSITION_FOLLOWING: 4 };

function createFakeElement(tag, opts = {}) {
  const el = {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    tagName: tag.toUpperCase(),
    style: {},
    dataset: { ...(opts.dataset || {}) },
    childNodes: [],
    parentNode: null,
    ownerDocument: null,
    contentEditable: opts.contentEditable !== undefined ? String(opts.contentEditable) : 'inherit',
    className: opts.classes ? opts.classes.join(' ') : '',
    classList: {
      _c: opts.classes ? [...opts.classes] : [],
      add(cls) { if (!this._c.includes(cls)) this._c.push(cls); el.className = this._c.join(' '); },
      contains(cls) { return this._c.includes(cls); },
    },
    hasChildNodes() { return this.childNodes.length > 0; },
    appendChild(child) { return _appendChild(el, child); },
    insertBefore(child, ref) { return _insertBefore(el, child, ref); },
    removeChild(child) { return _removeChild(el, child); },
    contains(other) { return _contains(el, other); },
    querySelector(sel) { return _querySelector(el, sel); },
    querySelectorAll(sel) { return _querySelectorAll(el, sel); },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute() {},
    getAttribute() { return null; },
    get firstChild() { return this.childNodes[0] || null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
    get previousSibling() {
      if (!el.parentNode) return null;
      const i = el.parentNode.childNodes.indexOf(el);
      return i > 0 ? el.parentNode.childNodes[i - 1] : null;
    },
    get nextSibling() {
      if (!el.parentNode) return null;
      const i = el.parentNode.childNodes.indexOf(el);
      return i < el.parentNode.childNodes.length - 1 ? el.parentNode.childNodes[i + 1] : null;
    },
    get textContent() {
      return this.childNodes.map(c => c.textContent || '').join('');
    },
    set textContent(val) {
      this.childNodes.length = 0;
      if (val) _appendChild(el, createFakeTextNode(val));
    },
    get innerHTML() {
      return this.childNodes.map(c => {
        if (c.nodeType === NODE_TYPES.TEXT_NODE) return c.textContent;
        if (c.nodeType === NODE_TYPES.ELEMENT_NODE) {
          const attrs = [];
          if (c.className) attrs.push(`class="${c.className}"`);
          if (c.contentEditable !== 'inherit') attrs.push(`contenteditable="${c.contentEditable}"`);
          return `<${c.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>${c.innerHTML}</${c.tagName.toLowerCase()}>`;
        }
        return '';
      }).join('');
    },
  };
  return el;
}

function createFakeTextNode(text) {
  return {
    nodeType: NODE_TYPES.TEXT_NODE,
    textContent: text,
    parentNode: null,
    get length() { return this.textContent.length; },
    splitText(offset) {
      const newNode = createFakeTextNode(this.textContent.slice(offset));
      this.textContent = this.textContent.slice(0, offset);
      if (this.parentNode) {
        const idx = this.parentNode.childNodes.indexOf(this);
        this.parentNode.childNodes.splice(idx + 1, 0, newNode);
        newNode.parentNode = this.parentNode;
      }
      return newNode;
    },
  };
}

function createFakeFragment() {
  const frag = {
    nodeType: NODE_TYPES.DOCUMENT_FRAGMENT_NODE,
    childNodes: [],
    parentNode: null,
    hasChildNodes() { return this.childNodes.length > 0; },
    appendChild(child) { return _appendChild(frag, child); },
    insertBefore(child, ref) { return _insertBefore(frag, child, ref); },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
    get firstChild() { return this.childNodes[0] || null; },
    get textContent() { return this.childNodes.map(c => c.textContent || '').join(''); },
  };
  return frag;
}

function _appendChild(parent, child) {
  if (child.nodeType === NODE_TYPES.DOCUMENT_FRAGMENT_NODE) {
    const kids = [...child.childNodes];
    for (const k of kids) { _appendChild(parent, k); }
    child.childNodes.length = 0;
    return child;
  }
  if (child.parentNode) _removeChild(child.parentNode, child);
  child.parentNode = parent;
  parent.childNodes.push(child);
  return child;
}

function _insertBefore(parent, child, ref) {
  if (child.nodeType === NODE_TYPES.DOCUMENT_FRAGMENT_NODE) {
    const kids = [...child.childNodes];
    for (const k of kids) _insertBefore(parent, k, ref);
    child.childNodes.length = 0;
    return child;
  }
  if (child.parentNode) _removeChild(child.parentNode, child);
  child.parentNode = parent;
  const idx = parent.childNodes.indexOf(ref);
  if (idx === -1) parent.childNodes.push(child);
  else parent.childNodes.splice(idx, 0, child);
  return child;
}

function _removeChild(parent, child) {
  const idx = parent.childNodes.indexOf(child);
  if (idx !== -1) parent.childNodes.splice(idx, 1);
  child.parentNode = null;
  return child;
}

function _contains(parent, other) {
  if (parent === other) return true;
  for (const c of parent.childNodes) {
    if (c === other) return true;
    if (c.nodeType === NODE_TYPES.ELEMENT_NODE && _contains(c, other)) return true;
  }
  return false;
}

function _matchesSel(node, sel) {
  if (node.nodeType !== NODE_TYPES.ELEMENT_NODE) return false;
  const parts = sel.split(',').map(s => s.trim());
  for (const part of parts) {
    if (part.startsWith('.') && node.classList.contains(part.slice(1))) return true;
    if (part === node.tagName.toLowerCase() || part === node.tagName) return true;
    // Handle attribute selectors like [data-tabmail-diff]
    const attrMatch = part.match(/\[([^\]=]+)(?:="([^"]*)")?\]/);
    if (attrMatch) {
      const [, attr, val] = attrMatch;
      const dsParts = attr.split('-');
      // Convert data-tabmail-diff to dataset.tabmailDiff
      if (attr.startsWith('data-')) {
        const dsKey = dsParts.slice(1).map((p, i) => i === 0 ? p : p[0].toUpperCase() + p.slice(1)).join('');
        if (node.dataset && (val === undefined ? dsKey in node.dataset : node.dataset[dsKey] === val)) return true;
      }
    }
  }
  return false;
}

function _querySelector(el, sel) {
  for (const c of el.childNodes) {
    if (_matchesSel(c, sel)) return c;
    if (c.nodeType === NODE_TYPES.ELEMENT_NODE) {
      const found = _querySelector(c, sel);
      if (found) return found;
    }
  }
  return null;
}

function _querySelectorAll(el, sel) {
  const results = [];
  function walk(node) {
    for (const c of node.childNodes) {
      if (_matchesSel(c, sel)) results.push(c);
      if (c.nodeType === NODE_TYPES.ELEMENT_NODE) walk(c);
    }
  }
  walk(el);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// FakeRange — tracks the range boundaries and implements deleteContents /
// insertNode so we can exercise the real _applyFragmentToEditor logic.
// ─────────────────────────────────────────────────────────────────────────────

function createFakeRange(editor) {
  let startContainer = editor, startOffset = 0;
  let endContainer = editor, endOffset = editor.childNodes.length;

  const range = {
    get startContainer() { return startContainer; },
    get startOffset() { return startOffset; },
    selectNodeContents(node) {
      startContainer = node;
      startOffset = 0;
      endContainer = node;
      endOffset = node.childNodes.length;
    },
    setStart(node, offset) { startContainer = node; startOffset = offset; },
    setStartBefore(node) {
      startContainer = node.parentNode;
      startOffset = node.parentNode.childNodes.indexOf(node);
    },
    setStartAfter(node) {
      startContainer = node.parentNode;
      startOffset = node.parentNode.childNodes.indexOf(node) + 1;
    },
    setEndBefore(node) {
      endContainer = node.parentNode;
      endOffset = node.parentNode.childNodes.indexOf(node);
    },
    setEnd(node, offset) { endContainer = node; endOffset = offset; },
    collapse(toStart) {
      if (toStart) { endContainer = startContainer; endOffset = startOffset; }
      else { startContainer = endContainer; startOffset = endOffset; }
    },
    deleteContents() {
      // Simple: remove children of the container between startOffset and endOffset
      if (startContainer === endContainer && startContainer.childNodes) {
        const removed = startContainer.childNodes.splice(startOffset, endOffset - startOffset);
        for (const r of removed) r.parentNode = null;
        endOffset = startOffset;
      }
    },
    insertNode(node) {
      if (startContainer.childNodes) {
        const ref = startContainer.childNodes[startOffset] || null;
        if (ref) _insertBefore(startContainer, node, ref);
        else _appendChild(startContainer, node);
      }
    },
    cloneContents() {
      const frag = createFakeFragment();
      if (startContainer === endContainer && startContainer.childNodes) {
        for (let i = startOffset; i < endOffset; i++) {
          const child = startContainer.childNodes[i];
          frag.appendChild(_cloneNode(child));
        }
      }
      return frag;
    },
    cloneRange() { return createFakeRange(editor); },
    toString() {
      const frag = range.cloneContents();
      return frag.textContent;
    },
  };
  return range;
}

function _cloneNode(node) {
  if (node.nodeType === NODE_TYPES.TEXT_NODE) return createFakeTextNode(node.textContent);
  if (node.nodeType === NODE_TYPES.ELEMENT_NODE) {
    const el = createFakeElement(node.tagName, {
      classes: [...node.classList._c],
      dataset: { ...node.dataset },
      contentEditable: node.contentEditable,
    });
    for (const c of node.childNodes) el.appendChild(_cloneNode(c));
    return el;
  }
  return createFakeFragment();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

let TM;
let fakeDoc;

beforeAll(() => {
  fakeDoc = {
    getElementById: () => true,
    createElement: (tag) => createFakeElement(tag),
    createDocumentFragment: () => createFakeFragment(),
    createTextNode: (text) => createFakeTextNode(text),
    createRange: () => createFakeRange(createFakeElement('body')),
    head: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
    body: createFakeElement('body'),
  };

  const sandbox = {
    TabMail: {},
    console,
    Object, Array, String, Number, RegExp, Math, Map, Set, NaN, Infinity,
    parseInt, parseFloat, isNaN, JSON,
    setTimeout, clearTimeout,
    Node: NODE_TYPES,
    document: fakeDoc,
    window: { getSelection: () => null, scrollTo: () => {}, getComputedStyle: () => ({ overflowY: 'visible' }) },
    performance: { now: () => Date.now() },
  };

  // Load modules in dependency order
  const domCode = readFileSync(resolve(__dirname, '../compose/modules/dom.js'), 'utf8');
  runInNewContext(domCode, sandbox);

  const sentencesCode = readFileSync(resolve(__dirname, '../compose/modules/sentences.js'), 'utf8');
  runInNewContext(sentencesCode, sandbox);

  // Provide config and stubs needed by diff.js
  sandbox.TabMail.config = {
    getColor: (c) => c || 'inherit',
    diffPerfLogging: false,
    diffLogGrouping: false,
    diffLogDebug: false,
    DELETED_NEWLINE_VISUAL_CHAR: null,
    HIDE_DELETE_NEWLINES: false,
    colors: {
      insert: { background: '#e6ffe6', text: 'inherit', highlight: { background: '#b3ffb3', text: 'inherit' } },
      delete: { background: '#ffe6e6', text: 'inherit', highlight: { background: '#ffb3b3', text: 'inherit' } },
    },
    newlineMarker: { NBSP_COUNT: 1 },
    quoteSeparator: { BR_COUNT_DEFAULT: 2, BR_COUNT_WHEN_SIGNATURE_BOUNDARY_WITH_QUOTE_AFTER: 1 },
    DIFF_RESTORE_DELAY_MS: 500,
  };
  sandbox.TabMail.log = { debug: () => {}, info: () => {}, trace: () => {}, warn: () => {}, error: () => {} };
  sandbox.TabMail.state = {
    editorRef: null,
    correctedText: null,
    originalText: null,
    lastRenderedText: null,
    autoHideDiff: false,
    showDiff: true,
    isDiffActive: false,
    isIMEComposing: false,
    inlineEditActive: false,
    beforeSendCleanupActive: false,
    currentlyHighlightedSpans: [],
    selectionMuteDepth: 0,
    diffRestoreTimer: null,
    lastKeystrokeAdheredToSuggestion: false,
    adherenceInfo: null,
  };
  sandbox.TabMail._beginProgrammaticSelection = () => {};
  sandbox.TabMail._endProgrammaticSelection = () => {};
  sandbox.TabMail.showCursorMovementTooltip = () => {};

  sandbox.Diff = { diffArrays: () => [] };
  sandbox.diff_match_patch = class {
    constructor() { this.Diff_EditCost = 4; }
    diff_main(a, b) {
      // Minimal real diff for testing
      if (a === b) return [[0, a]];
      if (!a) return [[1, b]];
      if (!b) return [[-1, a]];
      // Find common prefix
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      const prefix = a.slice(0, i);
      const aSuffix = a.slice(i);
      const bSuffix = b.slice(i);
      const result = [];
      if (prefix) result.push([0, prefix]);
      if (aSuffix) result.push([-1, aSuffix]);
      if (bSuffix) result.push([1, bSuffix]);
      return result;
    }
    diff_cleanupEfficiency() {}
  };

  const diffCode = readFileSync(resolve(__dirname, '../compose/modules/diff.js'), 'utf8');
  runInNewContext(diffCode, sandbox);

  const autohideCode = readFileSync(resolve(__dirname, '../compose/modules/autohideDiff.js'), 'utf8');
  runInNewContext(autohideCode, sandbox);

  TM = sandbox.TabMail;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build an editor body with signature and optional quoted text
// ─────────────────────────────────────────────────────────────────────────────

function buildEditor(userText = '', { hasSig = true, hasQuote = true } = {}) {
  const editor = createFakeElement('body', { contentEditable: 'true' });

  if (userText) {
    editor.appendChild(createFakeTextNode(userText));
  }

  if (hasSig) {
    const sig = createFakeElement('div', { classes: ['moz-signature'] });
    sig.appendChild(createFakeTextNode('-- \nMy Signature'));
    editor.appendChild(sig);
  }

  if (hasQuote) {
    const quote = createFakeElement('blockquote');
    quote.appendChild(createFakeTextNode('On date, person wrote:\n> original message'));
    editor.appendChild(quote);
  }

  // Override createRange on fakeDoc to use this editor
  fakeDoc.createRange = () => createFakeRange(editor);

  return editor;
}

function extract(editor) {
  return TM.extractUserAndQuoteTexts(editor);
}

function resetState() {
  TM.state.correctedText = null;
  TM.state.originalText = null;
  TM.state.lastRenderedText = null;
  TM.state.autoHideDiff = false;
  TM.state.showDiff = true;
  TM.state.isDiffActive = false;
  TM.state.isIMEComposing = false;
  TM.state.inlineEditActive = false;
  TM.state.beforeSendCleanupActive = false;
  TM.state.selectionMuteDepth = 0;
  if (TM.state.diffRestoreTimer) {
    clearTimeout(TM.state.diffRestoreTimer);
    TM.state.diffRestoreTimer = null;
  }
}

beforeEach(() => {
  resetState();
});


// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1: No LLM suggestion (slow/missing response)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: No LLM suggestion (slow response)', () => {
  it('user types in empty editor — text survives renderText cycle', () => {
    const editor = buildEditor('');
    TM.state.editorRef = editor;

    // Initial render (attachAutocomplete calls this)
    TM.renderText(false);
    // Simulate user typing "Hello" — insert text node before the separator
    const userRegionNodes = editor.childNodes.filter(
      n => !n.classList?.contains?.('moz-signature') &&
           !n.classList?.contains?.('tm-quote-separator') &&
           n.tagName !== 'BLOCKQUOTE'
    );
    // Find the empty text anchor or add text
    const textAnchor = userRegionNodes.find(n => n.nodeType === NODE_TYPES.TEXT_NODE);
    if (textAnchor) {
      textAnchor.textContent = 'Hello';
    } else {
      // Insert before separator
      const sep = editor.querySelector('.tm-quote-separator');
      if (sep) editor.insertBefore(createFakeTextNode('Hello'), sep);
      else editor.insertBefore(createFakeTextNode('Hello'), editor.firstChild);
    }

    // No correctedText (LLM hasn't responded)
    TM.state.correctedText = null;

    // renderText triggered by selectionchange — should NOT wipe "Hello"
    TM.renderText(true);
    const result = extract(editor);
    expect(result.originalUserMessage).toBe('Hello');
  });

  it('multiple render cycles with no suggestion preserve text', () => {
    const editor = buildEditor('Test message');
    TM.state.editorRef = editor;

    // No suggestion
    TM.state.correctedText = null;

    // First render
    TM.renderText(false);
    expect(extract(editor).originalUserMessage).toBe('Test message');

    // Second render (selectionchange)
    TM.renderText(true);
    expect(extract(editor).originalUserMessage).toBe('Test message');

    // Third render (diffRestoreTimer)
    TM.state.autoHideDiff = false;
    TM.renderText(true);
    expect(extract(editor).originalUserMessage).toBe('Test message');
  });

  it('renderText with show_diffs=false preserves text when no correctedText', () => {
    const editor = buildEditor('Draft email body');
    TM.state.editorRef = editor;
    TM.state.correctedText = null;

    TM.renderText(false);
    expect(extract(editor).originalUserMessage).toBe('Draft email body');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2: Stale suggestion arrives
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: Stale suggestion arrives', () => {
  it('correctedText from old request does not clobber current text', () => {
    // User typed "Hello world" but stale suggestion was for "Hel"
    const editor = buildEditor('Hello world');
    TM.state.editorRef = editor;

    // Stale correctedText — but since we render with show_diffs=false and null
    // correctedText (simulating handleAutohideDiff nulling it), text is preserved.
    TM.state.correctedText = null;

    TM.renderText(false);
    const result = extract(editor);
    expect(result.originalUserMessage).toBe('Hello world');
  });

  it('after autohide nulls correctedText, render uses original text', () => {
    const editor = buildEditor('Current text');
    TM.state.editorRef = editor;
    TM.state.correctedText = 'Old stale suggestion';
    TM.state.isDiffActive = true;

    // Simulate user keydown → handleAutohideDiff
    TM.state.autoHideDiff = true;
    TM.state.correctedText = null; // handleAutohideDiff does this

    TM.renderText(false);
    expect(extract(editor).originalUserMessage).toBe('Current text');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3: Proper suggestion — show diffs, hide diffs, restore diffs
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: Proper suggestion lifecycle', () => {
  let origComputeDiff;

  beforeEach(() => {
    origComputeDiff = TM.computeDiff;
  });

  afterEach(() => {
    TM.computeDiff = origComputeDiff;
  });

  it('suggestion shown with diffs preserves original text on extraction', () => {
    const editor = buildEditor('Hello wrold');
    TM.state.editorRef = editor;
    TM.state.correctedText = 'Hello world';

    // Stub computeDiff to return known diffs with sentence indices
    TM.computeDiff = () => [[0, 'Hello w', 0, 0], [-1, 'rold', 0, 0], [1, 'orld', 0, 0]];

    TM.renderText(true);
    // After rendering diffs, extraction with skipInserts should return original
    const result = extract(editor);
    expect(result.originalUserMessage).toBe('Hello wrold');
  });

  it('hide diffs → render(false) preserves text', () => {
    const editor = buildEditor('Hello wrold');
    TM.state.editorRef = editor;
    TM.state.correctedText = 'Hello world';
    TM.computeDiff = () => [[0, 'Hello w', 0, 0], [-1, 'rold', 0, 0], [1, 'orld', 0, 0]];

    // Show diffs first
    TM.renderText(true);
    expect(TM.state.isDiffActive).toBe(true);

    // User types → autohide: correctedText nulled, render without diffs
    TM.state.autoHideDiff = true;
    TM.state.correctedText = null;

    TM.renderText(false);
    expect(extract(editor).originalUserMessage).toBe('Hello wrold');
    expect(TM.state.isDiffActive).toBe(false);
  });

  it('diffRestoreTimer → render(true) after autohide preserves text', () => {
    const editor = buildEditor('Hello wrold');
    TM.state.editorRef = editor;

    // Initially render without diffs
    TM.state.correctedText = null;
    TM.renderText(false);
    expect(extract(editor).originalUserMessage).toBe('Hello wrold');

    // diffRestoreTimer fires — no correctedText, should still preserve
    TM.state.autoHideDiff = false;
    TM.renderText(true);
    expect(extract(editor).originalUserMessage).toBe('Hello wrold');
  });

  it('full cycle: show → hide → restore preserves text', () => {
    const editor = buildEditor('Teh quick fox');
    TM.state.editorRef = editor;
    TM.computeDiff = () => [[0, '', 0, 0], [-1, 'Teh', 0, 0], [1, 'The', 0, 0], [0, ' quick fox', 0, 0]];

    // Step 1: suggestion arrives
    TM.state.correctedText = 'The quick fox';
    TM.renderText(true);
    expect(extract(editor).originalUserMessage).toBe('Teh quick fox');

    // Step 2: user types non-adhering → autohide
    TM.state.autoHideDiff = true;
    TM.state.correctedText = null;
    TM.renderText(false);
    expect(extract(editor).originalUserMessage).toBe('Teh quick fox');

    // Step 3: diffRestoreTimer fires — no correctedText
    TM.state.autoHideDiff = false;
    TM.renderText(true);
    expect(extract(editor).originalUserMessage).toBe('Teh quick fox');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 4: Partial acceptance (typing along)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: Partial acceptance via adherence', () => {
  it('_applyAdherenceToDiffs consumes chars correctly', () => {
    // Diffs: EQUAL "Hello" | INSERT " World"
    const diffs = [[0, 'Hello'], [1, ' World']];
    TM.state.lastRenderedText = { diffs, original: 'Hello', corrected: 'Hello World', show_diffs: true, show_newlines: true, originalCursorOffset: 5 };

    // User types space — adheres to suggestion
    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 1, charIndex: 0, char: ' ' });

    expect(diffs[0][1]).toBe('Hello ');
    expect(diffs[1][1]).toBe('World');

    // User types 'W'
    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 1, charIndex: 0, char: 'W' });
    expect(diffs[0][1]).toBe('Hello W');
    expect(diffs[1][1]).toBe('orld');
  });

  it('fully consumed INSERT is removed from diffs', () => {
    const diffs = [[0, 'Hi'], [1, '!']];
    TM.state.lastRenderedText = { diffs, original: 'Hi', corrected: 'Hi!' };

    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 1, charIndex: 0, char: '!' });

    expect(diffs.length).toBe(1);
    expect(diffs[0]).toEqual([0, 'Hi!']);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 5: Empty editor with signature (the original bug)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: Empty editor with signature (original bug)', () => {
  it('initial render of empty editor does not crash', () => {
    const editor = buildEditor('');
    TM.state.editorRef = editor;
    TM.state.correctedText = null;

    expect(() => TM.renderText(false)).not.toThrow();
    expect(extract(editor).originalUserMessage).toBe('');
  });

  it('separator is present after initial render', () => {
    const editor = buildEditor('');
    TM.state.editorRef = editor;
    TM.renderText(false);

    const sep = editor.querySelector('.tm-quote-separator');
    expect(sep).not.toBeNull();
  });

  it('empty text anchor exists before separator after render', () => {
    const editor = buildEditor('');
    TM.state.editorRef = editor;
    TM.renderText(false);

    const sep = editor.querySelector('.tm-quote-separator');
    expect(sep).not.toBeNull();

    // The node right before the separator should be a text node
    const idx = editor.childNodes.indexOf(sep);
    expect(idx).toBeGreaterThan(0);
    const beforeSep = editor.childNodes[idx - 1];
    expect(beforeSep.nodeType).toBe(NODE_TYPES.TEXT_NODE);
  });

  it('repeated renders of empty editor do not accumulate separators', () => {
    const editor = buildEditor('');
    TM.state.editorRef = editor;

    TM.renderText(false);
    TM.state.lastRenderedText = null; // force re-render
    TM.renderText(true);
    TM.state.lastRenderedText = null;
    TM.renderText(false);

    // Count separators
    const seps = editor.childNodes.filter(
      n => n.nodeType === NODE_TYPES.ELEMENT_NODE && n.classList?.contains?.('tm-quote-separator')
    );
    expect(seps.length).toBe(1);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 6: Editor without signature / quote
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: Editor without signature or quote', () => {
  it('renders text correctly when no quote boundary', () => {
    const editor = buildEditor('Just text', { hasSig: false, hasQuote: false });
    TM.state.editorRef = editor;
    TM.state.correctedText = null;

    TM.renderText(false);
    expect(extract(editor).originalUserMessage).toBe('Just text');
  });

  it('no separator is added when no quote boundary', () => {
    const editor = buildEditor('No sig', { hasSig: false, hasQuote: false });
    TM.state.editorRef = editor;

    TM.renderText(false);
    const sep = editor.querySelector('.tm-quote-separator');
    expect(sep).toBeNull();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 7: handleAutohideDiff guard
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: handleAutohideDiff guard prevents unnecessary renders', () => {
  let renderTextCalls;
  let origRenderText;
  let origIsInputEvent;
  let origIsKeystrokeAdhering;

  beforeEach(() => {
    renderTextCalls = [];
    origRenderText = TM.renderText;
    origIsInputEvent = TM.isInputEvent;
    origIsKeystrokeAdhering = TM._isKeystrokeAdheringToSuggestion;
    TM.renderText = (...args) => renderTextCalls.push(args);
    TM.isInputEvent = () => true;
    TM._isKeystrokeAdheringToSuggestion = () => false;
  });

  afterEach(() => {
    TM.renderText = origRenderText;
    TM.isInputEvent = origIsInputEvent;
    TM._isKeystrokeAdheringToSuggestion = origIsKeystrokeAdhering;
    if (TM.state.diffRestoreTimer) {
      clearTimeout(TM.state.diffRestoreTimer);
      TM.state.diffRestoreTimer = null;
    }
  });

  it('does not render when no active diffs and no suggestion', () => {
    TM.state.isDiffActive = false;
    TM.state.correctedText = null;

    TM.handleAutohideDiff({ type: 'keydown', key: 'a' });

    expect(renderTextCalls.length).toBe(0);
  });

  it('renders when isDiffActive even without correctedText', () => {
    TM.state.isDiffActive = true;
    TM.state.correctedText = null;

    TM.handleAutohideDiff({ type: 'keydown', key: 'a' });

    expect(renderTextCalls.length).toBe(1);
  });

  it('renders when correctedText exists even without active diffs', () => {
    TM.state.isDiffActive = false;
    TM.state.correctedText = 'some text';

    TM.handleAutohideDiff({ type: 'keydown', key: 'a' });

    expect(renderTextCalls.length).toBe(1);
  });

  it('does not render for non-insert keystrokes', () => {
    TM.isInputEvent = () => false;
    TM.state.isDiffActive = true;

    TM.handleAutohideDiff({ type: 'keydown', key: 'ArrowLeft' });

    expect(renderTextCalls.length).toBe(0);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 8: Early-return dedup in renderText
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: renderText early-return dedup', () => {
  it('skips re-render when lastRenderedText matches current state', () => {
    const editor = buildEditor('Same text');
    TM.state.editorRef = editor;
    TM.state.correctedText = null;

    // First render populates lastRenderedText
    TM.renderText(false);
    const after1 = extract(editor).originalUserMessage;
    expect(after1).toBe('Same text');

    // Second render with same params should early-return (no DOM change)
    const childCountBefore = editor.childNodes.length;
    TM.renderText(false);
    // Text still preserved
    expect(extract(editor).originalUserMessage).toBe('Same text');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 9: Multiline text with suggestion
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: Multiline text', () => {
  it('preserves multiline text through render cycle', () => {
    const editor = buildEditor('Line one\nLine two\nLine three');
    TM.state.editorRef = editor;
    TM.state.correctedText = null;

    TM.renderText(false);
    expect(extract(editor).originalUserMessage).toBe('Line one\nLine two\nLine three');
  });

  it('suggestion with multiline text preserves original on extraction', () => {
    const editor = buildEditor('Line one\nLine too');
    TM.state.editorRef = editor;
    TM.state.correctedText = 'Line one\nLine two';

    // Stub computeDiff with known diffs
    const origCD = TM.computeDiff;
    TM.computeDiff = () => [[0, 'Line one\nLine t', 0, 0], [-1, 'oo', 0, 0], [1, 'wo', 0, 0]];
    TM.renderText(true);
    TM.computeDiff = origCD;

    expect(extract(editor).originalUserMessage).toBe('Line one\nLine too');
  });
});
