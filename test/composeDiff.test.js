// composeDiff.test.js — Tests for compose/modules/diff.js
//
// The compose modules use `var TabMail = TabMail || {}; Object.assign(TabMail, {...})` pattern.
// We load them via readFileSync + vm.runInNewContext, same as sentences.test.js.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

let TabMail;

/**
 * Minimal DOM mocks for _renderDiffsToFragment and _createBrWithMarker.
 */
function createDOMMocks() {
  function makeElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      style: {},
      dataset: {},
      childNodes: [],
      classList: {
        _classes: [],
        add(cls) { el.classList._classes.push(cls); },
        contains(cls) { return el.classList._classes.includes(cls); },
      },
      hasChildNodes() { return el.childNodes.length > 0; },
      appendChild(child) { el.childNodes.push(child); return child; },
      setAttribute(name, value) { el[`_attr_${name}`] = value; },
      getAttribute(name) { return el[`_attr_${name}`]; },
      textContent: '',
      contentEditable: true,
      contains() { return false; },
    };
    return el;
  }

  function makeFragment() {
    const frag = {
      nodeType: 11,
      childNodes: [],
      appendChild(child) { frag.childNodes.push(child); return child; },
      hasChildNodes() { return frag.childNodes.length > 0; },
    };
    return frag;
  }

  function makeTextNode(text) {
    return { nodeType: 3, textContent: text };
  }

  return {
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
}

beforeAll(() => {
  TabMail = {};

  const domMocks = createDOMMocks();

  // Create sandbox with DOM mocks
  const sandbox = {
    TabMail,
    console,
    Node: domMocks.Node,
    document: domMocks.document,
    window: domMocks.window,
    Object,
  };

  // Load sentences.js first (provides splitIntoSentences, findSentenceContainingCursor, getSentenceStartOffset)
  const sentencesCode = readFileSync(resolve(__dirname, '../compose/modules/sentences.js'), 'utf8');
  runInNewContext(sentencesCode, sandbox);

  // Provide a minimal config and log for diff.js
  sandbox.TabMail.config = {
    getColor: (c) => c || 'inherit',
    colors: {
      insert: { background: '#e6ffe6', text: 'inherit' },
      delete: { background: '#ffe6e6', text: 'inherit' },
    },
  };
  sandbox.TabMail.log = {
    debug: () => {},
    warn: () => {},
    error: () => {},
  };

  // Load diff.js
  const diffCode = readFileSync(resolve(__dirname, '../compose/modules/diff.js'), 'utf8');
  // diff.js uses diff_match_patch and Diff.diffArrays which are external libs.
  // We don't need computeDiff for our tests — just the Object.assign'd functions.
  // Provide stubs so the file loads without errors.
  sandbox.Diff = {
    diffArrays: () => [],
  };
  sandbox.diff_match_patch = class {
    constructor() { this.Diff_EditCost = 4; }
    diff_main() { return []; }
  };
  sandbox.performance = { now: () => Date.now() };

  runInNewContext(diffCode, sandbox);
  TabMail = sandbox.TabMail;
});

// ---------------------------------------------------------------------------
// _filterDiffsForSuggestion
// ---------------------------------------------------------------------------
describe('_filterDiffsForSuggestion', () => {

  // Helper: create a diff entry with sentence indices
  function diff(op, text, sOrig = -1, sNew = -1) {
    return [op, text, sOrig, sNew];
  }

  it('shows diffs in the cursor sentence (first sentence)', () => {
    // "Hello world. Goodbye."
    // Cursor at position 3 (in "Hello world.")
    // Diffs: equal "Hell", delete "o", insert "0", equal " world. Goodbye."
    const originalText = 'Hello world. Goodbye.';
    const correctedText = 'Hell0 world. Goodbye.';
    const diffs = [
      diff(0, 'Hell', 0, 0),
      diff(-1, 'o', 0, 0),
      diff(1, '0', 0, 0),
      diff(0, ' world. ', 0, 0),
      diff(0, 'Goodbye.', 1, 1),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 3);

    expect(result.disableCursorHinting).toBe(true);
    // The diffs in sentence 0 should be shown, sentence 1 should be equal
    const ops = result.diffs.map(d => d[0]);
    expect(ops).toContain(-1); // delete shown
    expect(ops).toContain(1);  // insert shown
  });

  it('shows diffs in the cursor sentence (middle sentence)', () => {
    // "First. Second. Third."
    // sentences: ["First. ", "Second. ", "Third."]
    // Cursor at position 8 -> in "Second. "
    const originalText = 'First. Second. Third.';
    const correctedText = 'First. SECOND. Third.';
    // Diff: equal "First. ", delete "Second", insert "SECOND", equal ". Third."
    const diffs = [
      diff(0, 'First. ', 0, 0),
      diff(-1, 'Second', 1, 1),
      diff(1, 'SECOND', 1, 1),
      diff(0, '. ', 1, 1),
      diff(0, 'Third.', 2, 2),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 8);

    expect(result.disableCursorHinting).toBe(true);
    // Delete and insert for "Second"/"SECOND" should be shown
    const nonEqualDiffs = result.diffs.filter(d => d[0] !== 0);
    expect(nonEqualDiffs.length).toBe(2);
  });

  it('hides diffs not in cursor sentence and converts deletes to equal', () => {
    // "First. Second."
    // Cursor in "First. " (position 0)
    // Change in "Second." only
    const originalText = 'First. Second.';
    const correctedText = 'First. SECOND.';
    const diffs = [
      diff(0, 'First. ', 0, 0),
      diff(-1, 'Second', 1, 1),
      diff(1, 'SECOND', 1, 1),
      diff(0, '.', 1, 1),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 0);

    // The delete "Second" should be converted to equal, insert "SECOND" should be dropped
    expect(result.disableCursorHinting).toBe(false);
    const ops = result.diffs.map(d => d[0]);
    expect(ops).not.toContain(-1);
    expect(ops).not.toContain(1);
    // firstDiffPosition should point to position 7 (start of "Second")
    expect(result.firstDiffPosition).toBe(7);
  });

  it('shows consecutive inserts after cursor sentence', () => {
    // "Hello." + cursor at end
    // AI appends " How are you?"
    const originalText = 'Hello.';
    const correctedText = 'Hello. How are you?';
    // Diffs: equal "Hello.", insert " How are you?"
    const diffs = [
      diff(0, 'Hello.', 0, 0),
      diff(1, ' How are you?', 0, 1),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 6);

    // The insert should be shown because cursor is at end of last sentence
    expect(result.disableCursorHinting).toBe(true);
    const inserts = result.diffs.filter(d => d[0] === 1);
    expect(inserts.length).toBe(1);
    expect(inserts[0][1]).toBe(' How are you?');
  });

  it('handles empty original text', () => {
    const originalText = '';
    const correctedText = 'Hello world.';
    const diffs = [
      diff(1, 'Hello world.', -1, 0),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 0);

    // With empty text, cursorSentenceIndex is -1, sentenceEnd is 0
    // The insert at position 0 = sentenceEnd should still trigger
    expect(result.diffs.length).toBeGreaterThanOrEqual(1);
  });

  it('handles single-sentence text with no changes', () => {
    const originalText = 'Hello world';
    const correctedText = 'Hello world';
    const diffs = [
      diff(0, 'Hello world', 0, 0),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 5);

    expect(result.disableCursorHinting).toBe(false);
    expect(result.firstDiffPosition).toBe(-1);
    expect(result.diffs.length).toBe(1);
    expect(result.diffs[0][0]).toBe(0);
  });

  it('shows consecutive inserts that follow the cursor sentence', () => {
    // "Hello. " with cursor at 5
    // AI changes to "Hello. World. More stuff."
    const originalText = 'Hello. ';
    const correctedText = 'Hello. World. More stuff.';
    // The original ends with trailing space in sentence 0
    // Diffs: equal "Hello. ", insert "World. More stuff."
    const diffs = [
      diff(0, 'Hello. ', 0, 0),
      diff(1, 'World. ', 0, 1),
      diff(1, 'More stuff.', 0, 2),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 5);

    // Both inserts should be shown since they follow the cursor sentence
    // and the sentence boundary had an insert, setting inConsecutiveInserts
    const inserts = result.diffs.filter(d => d[0] === 1);
    expect(inserts.length).toBe(2);
    expect(result.disableCursorHinting).toBe(true);
  });

  it('disables cursor hinting when diffs are in cursor sentence', () => {
    const originalText = 'Hello world.';
    const correctedText = 'Hello WORLD.';
    const diffs = [
      diff(0, 'Hello ', 0, 0),
      diff(-1, 'world', 0, 0),
      diff(1, 'WORLD', 0, 0),
      diff(0, '.', 0, 0),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 3);

    expect(result.disableCursorHinting).toBe(true);
  });

  it('enables cursor hinting when diffs are NOT in cursor sentence', () => {
    const originalText = 'First. Second.';
    const correctedText = 'First. SECOND.';
    const diffs = [
      diff(0, 'First. ', 0, 0),
      diff(-1, 'Second', 1, 1),
      diff(1, 'SECOND', 1, 1),
      diff(0, '.', 1, 1),
    ];
    // Cursor in first sentence
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 3);

    expect(result.disableCursorHinting).toBe(false);
    expect(result.firstDiffPosition).toBe(7);
  });

  it('handles cursor at very end of multi-sentence text with trailing insert', () => {
    const originalText = 'A. B.';
    const correctedText = 'A. B. C.';
    // sentences of original: ["A. ", "B."]
    // cursor at 5 = end of text -> last sentence
    const diffs = [
      diff(0, 'A. ', 0, 0),
      diff(0, 'B.', 1, 1),
      diff(1, ' C.', 1, 2),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 5);

    const inserts = result.diffs.filter(d => d[0] === 1);
    expect(inserts.length).toBe(1);
    expect(inserts[0][1]).toBe(' C.');
    expect(result.disableCursorHinting).toBe(true);
  });

  it('stops showing inserts after a non-insert diff breaks the consecutive chain', () => {
    // "A. B. C."
    // Cursor in sentence A
    // Changes in B (delete+insert) and insert after C
    const originalText = 'A. B. C.';
    const correctedText = 'A. X. C. D.';
    const diffs = [
      diff(0, 'A. ', 0, 0),
      diff(-1, 'B', 1, 1),
      diff(1, 'X', 1, 1),
      diff(0, '. ', 1, 1),
      diff(0, 'C.', 2, 2),
      diff(1, ' D.', 2, 3),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 1);

    // Cursor is in sentence A. Changes in B should be hidden (converted to equal / dropped).
    // The insert " D." after C should also be hidden since consecutive inserts chain was broken.
    const inserts = result.diffs.filter(d => d[0] === 1);
    expect(inserts.length).toBe(0);
  });

  it('firstDiffPosition tracks position of first non-equal diff', () => {
    const originalText = 'AAABBB';
    const correctedText = 'AAACCC';
    const diffs = [
      diff(0, 'AAA', 0, 0),
      diff(-1, 'BBB', 0, 0),
      diff(1, 'CCC', 0, 0),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 1);

    expect(result.firstDiffPosition).toBe(3);
  });

  it('handles text with only newlines as sentence boundaries', () => {
    const originalText = 'Line one\nLine two\n';
    const correctedText = 'Line one\nLine TWO\n';
    // sentences: ["Line one\n", "Line two\n"]
    // cursor at position 10 -> in "Line two\n"
    const diffs = [
      diff(0, 'Line one\n', 0, 0),
      diff(0, 'Line ', 1, 1),
      diff(-1, 'two', 1, 1),
      diff(1, 'TWO', 1, 1),
      diff(0, '\n', 1, 1),
    ];
    const result = TabMail._filterDiffsForSuggestion(diffs, originalText, correctedText, 10);

    expect(result.disableCursorHinting).toBe(true);
    const deletes = result.diffs.filter(d => d[0] === -1);
    expect(deletes.length).toBe(1);
    expect(deletes[0][1]).toBe('two');
  });
});

// ---------------------------------------------------------------------------
// _renderDiffsToFragment
// ---------------------------------------------------------------------------
describe('_renderDiffsToFragment', () => {

  function diff(op, text, sOrig = -1, sNew = -1) {
    return [op, text, sOrig, sNew];
  }

  /** Count child nodes of a specific nodeType (3=text, 1=element) in the fragment */
  function countNodesByType(fragment, nodeType) {
    return fragment.childNodes.filter(n => n.nodeType === nodeType).length;
  }

  /** Get all element children (nodeType 1) */
  function getElements(fragment) {
    return fragment.childNodes.filter(n => n.nodeType === 1);
  }

  it('returns fragment for equal-only diffs (no styled spans)', () => {
    const diffs = [diff(0, 'Hello world')];
    const frag = TabMail._renderDiffsToFragment(diffs, true, false);

    expect(frag.hasChildNodes()).toBe(true);
    // Should be a text node, not a styled span
    const textNodes = frag.childNodes.filter(n => n.nodeType === 3);
    expect(textNodes.length).toBe(1);
    expect(textNodes[0].textContent).toBe('Hello world');
  });

  it('creates colored spans for insert diffs when show_diffs=true', () => {
    const diffs = [diff(1, 'inserted text')];
    const frag = TabMail._renderDiffsToFragment(diffs, true, false);

    const elements = getElements(frag);
    expect(elements.length).toBe(1);
    expect(elements[0].tagName).toBe('SPAN');
    expect(elements[0].dataset.tabmailDiff).toBe('insert');
    // Check the span has a text node child with the insert text
    const spanTextNodes = elements[0].childNodes.filter(n => n.nodeType === 3);
    expect(spanTextNodes.length).toBe(1);
    expect(spanTextNodes[0].textContent).toBe('inserted text');
  });

  it('creates colored spans for delete diffs when show_diffs=true', () => {
    const diffs = [diff(-1, 'deleted text')];
    const frag = TabMail._renderDiffsToFragment(diffs, true, false);

    const elements = getElements(frag);
    expect(elements.length).toBe(1);
    expect(elements[0].dataset.tabmailDiff).toBe('delete');
  });

  it('hides insert diffs when show_diffs=false', () => {
    const diffs = [
      diff(0, 'kept'),
      diff(1, 'hidden insert'),
      diff(-1, 'shown as equal'),
    ];
    const frag = TabMail._renderDiffsToFragment(diffs, false, false);

    // Insert should be completely skipped
    // Delete should be rendered as plain text (no span)
    // So we should see text nodes for 'kept' and 'shown as equal'
    const allText = frag.childNodes
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent)
      .join('');
    expect(allText).toBe('keptshown as equal');

    // No styled spans should exist
    const spans = frag.childNodes.filter(n => n.nodeType === 1 && n.tagName === 'SPAN');
    expect(spans.length).toBe(0);
  });

  it('converts newlines to <br> elements within equal diffs', () => {
    const diffs = [diff(0, 'line1\nline2')];
    const frag = TabMail._renderDiffsToFragment(diffs, true, false);

    // Should have: textNode("line1"), fragment(br), textNode("line2")
    // The _createBrWithMarker returns a fragment with a <br> inside
    expect(frag.childNodes.length).toBe(3);
    expect(frag.childNodes[0].textContent).toBe('line1');
    expect(frag.childNodes[2].textContent).toBe('line2');
  });

  it('converts newlines to <br> elements within insert spans', () => {
    const diffs = [diff(1, 'line1\nline2')];
    const frag = TabMail._renderDiffsToFragment(diffs, true, false);

    const elements = getElements(frag);
    expect(elements.length).toBe(1);
    // The span should have 3 children: text, br-fragment, text
    expect(elements[0].childNodes.length).toBe(3);
  });

  it('returns empty fragment for empty diffs array', () => {
    const frag = TabMail._renderDiffsToFragment([], true, false);
    expect(frag.hasChildNodes()).toBe(false);
  });

  it('attaches sentence indices as dataset attributes on spans', () => {
    const diffs = [diff(1, 'text', 2, 3)];
    const frag = TabMail._renderDiffsToFragment(diffs, true, false);

    const elements = getElements(frag);
    expect(elements.length).toBe(1);
    expect(elements[0].dataset.tabmailSentenceOrig).toBe('2');
    expect(elements[0].dataset.tabmailSentenceNew).toBe('3');
  });

  it('attaches diff index as dataset attribute on spans', () => {
    const diffs = [
      diff(0, 'equal'),
      diff(1, 'insert'),
      diff(-1, 'delete'),
    ];
    const frag = TabMail._renderDiffsToFragment(diffs, true, false);

    const elements = getElements(frag);
    // The insert span (diffSeq=1) and delete span (diffSeq=2)
    expect(elements.length).toBe(2);
    expect(elements[0].dataset.tabmailDiffIndex).toBe(1);
    expect(elements[1].dataset.tabmailDiffIndex).toBe(2);
  });

  it('adds tm-nl marker span when show_newlines=true', () => {
    const diffs = [diff(0, 'a\nb')];
    const frag = TabMail._renderDiffsToFragment(diffs, true, true);

    // The br fragment should contain a span.tm-nl + br
    // Find the fragment child that is itself a fragment (from _createBrWithMarker)
    const brFrag = frag.childNodes[1]; // middle child is the br fragment
    expect(brFrag.childNodes.length).toBe(2); // span.tm-nl + br
    expect(brFrag.childNodes[0].classList._classes).toContain('tm-nl');
  });

  it('does not add tm-nl marker span when show_newlines=false', () => {
    const diffs = [diff(0, 'a\nb')];
    const frag = TabMail._renderDiffsToFragment(diffs, true, false);

    const brFrag = frag.childNodes[1];
    // Should only have the <br>, no tm-nl span
    expect(brFrag.childNodes.length).toBe(1);
    expect(brFrag.childNodes[0].tagName).toBe('BR');
  });

  it('does not create span for empty insert text', () => {
    const diffs = [diff(1, '')];
    const frag = TabMail._renderDiffsToFragment(diffs, true, false);

    // Empty text produces a span with no children, which should not be appended
    expect(frag.hasChildNodes()).toBe(false);
  });

  it('handles multiple equal segments separated by inserts and deletes', () => {
    const diffs = [
      diff(0, 'aaa'),
      diff(-1, 'bbb'),
      diff(1, 'BBB'),
      diff(0, 'ccc'),
    ];
    const frag = TabMail._renderDiffsToFragment(diffs, true, false);

    // text('aaa'), span(delete 'bbb'), span(insert 'BBB'), text('ccc')
    expect(frag.childNodes.length).toBe(4);
    expect(frag.childNodes[0].textContent).toBe('aaa');
    expect(frag.childNodes[1].dataset.tabmailDiff).toBe('delete');
    expect(frag.childNodes[2].dataset.tabmailDiff).toBe('insert');
    expect(frag.childNodes[3].textContent).toBe('ccc');
  });
});

// ---------------------------------------------------------------------------
// _createBrWithMarker
// ---------------------------------------------------------------------------
describe('_createBrWithMarker', () => {
  it('returns fragment with just <br> when showNewlines=false', () => {
    const frag = TabMail._createBrWithMarker(false);
    expect(frag.childNodes.length).toBe(1);
    expect(frag.childNodes[0].tagName).toBe('BR');
  });

  it('returns fragment with tm-nl span + <br> when showNewlines=true', () => {
    const frag = TabMail._createBrWithMarker(true);
    expect(frag.childNodes.length).toBe(2);
    expect(frag.childNodes[0].tagName).toBe('SPAN');
    expect(frag.childNodes[0].classList._classes).toContain('tm-nl');
    expect(frag.childNodes[0].contentEditable).toBe('false');
    expect(frag.childNodes[1].tagName).toBe('BR');
  });

  it('sets _moz_dirty attribute on the <br>', () => {
    const frag = TabMail._createBrWithMarker(false);
    const br = frag.childNodes[0];
    expect(br._attr__moz_dirty).toBe('');
  });
});
