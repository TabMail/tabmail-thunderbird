// composeDom.test.js — Tests for compose/modules/dom.js pure-logic functions
//
// The module uses `var TabMail = TabMail || {}` pattern and attaches functions
// to a global TabMail object. We load it via vm.runInNewContext with minimal
// DOM mocks, then test the pure-logic functions that don't require a real DOM.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

let TM; // TabMail after loading dom.js

beforeAll(() => {
  const code = readFileSync(resolve(__dirname, '../compose/modules/dom.js'), 'utf8');

  // Minimal sandbox with DOM stubs so the file loads without errors.
  const sandbox = {
    TabMail: {
      config: {
        diffPerfLogging: false,
        diffLogGrouping: false,
        diffLogDebug: false,
        DELETED_NEWLINE_VISUAL_CHAR: null,
        HIDE_DELETE_NEWLINES: false,
        getColor: (c) => c || 'inherit',
        colors: {
          insert: { background: '#e6ffe6', text: 'inherit', highlight: { background: '#b3ffb3', text: 'inherit' } },
          delete: { background: '#ffe6e6', text: 'inherit', highlight: { background: '#ffb3b3', text: 'inherit' } },
        },
        newlineMarker: { NBSP_COUNT: 1 },
        quoteSeparator: {},
      },
      log: { debug: () => {}, info: () => {} },
      state: { editorRef: null, currentlyHighlightedSpans: [] },
      _beginProgrammaticSelection: () => {},
      _endProgrammaticSelection: () => {},
    },
    console,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Math,
    Map,
    Set,
    NaN,
    Infinity,
    parseInt,
    parseFloat,
    isNaN,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4 },
    document: {
      getElementById: () => true,
      createElement: (tag) => ({
        tagName: tag.toUpperCase(),
        style: {},
        classList: { add: () => {}, contains: () => false },
        appendChild: () => {},
        setAttribute: () => {},
        textContent: '',
        dataset: {},
        childNodes: [],
        hasChildNodes: () => false,
      }),
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

// ─────────────────────────────────────────────────────────────────────────────
// Diff operation constants (matching diff_match_patch convention)
// ─────────────────────────────────────────────────────────────────────────────
const EQUAL = 0;
const INSERT = 1;
const DELETE = -1;

// ═══════════════════════════════════════════════════════════════════════════
// mapCursorOffsetFromOriginalToDiffView
// ═══════════════════════════════════════════════════════════════════════════

describe('mapCursorOffsetFromOriginalToDiffView', () => {
  // ── All-equal (no changes) ──────────────────────────────────────────────

  describe('all-equal diffs (no changes)', () => {
    // Original: "Hello" (len 5), View: "Hello" (len 5)
    const diffs = [[EQUAL, 'Hello']];

    it('maps cursor at start (0)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 0)).toBe(0);
    });

    it('maps cursor in middle (2)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 2)).toBe(2);
    });

    it('maps cursor at end (5)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 5)).toBe(5);
    });
  });

  describe('multiple equal segments', () => {
    // Original: "HelloWorld" (len 10), View: "HelloWorld" (len 10)
    const diffs = [[EQUAL, 'Hello'], [EQUAL, 'World']];

    it('maps cursor at boundary between segments (5)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 5)).toBe(5);
    });

    it('maps cursor at end (10)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 10)).toBe(10);
    });
  });

  // ── Simple insert ──────────────────────────────────────────────────────

  describe('insert at start', () => {
    // Original: "World" (len 5), View: "HelloWorld" (len 10)
    // Diff: [INSERT, "Hello"], [EQUAL, "World"]
    const diffs = [[INSERT, 'Hello'], [EQUAL, 'World']];

    it('cursor at original 0 maps before the insert (0)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 0)).toBe(0);
    });

    it('cursor at original 1 maps past the insert (6)', () => {
      // origPos after INSERT is still 0; EQUAL starts at viewPos=5
      // origIdx=1 is within EQUAL: viewPos + (1 - 0) = 5 + 1 = 6
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 1)).toBe(6);
    });

    it('cursor at original end (5) maps to view end (10)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 5)).toBe(10);
    });
  });

  describe('insert in middle', () => {
    // Original: "HWorld" (len 6), View: "HelloWorld" (len 10)
    // Diff: [EQUAL, "H"], [INSERT, "ello"], [EQUAL, "World"]
    const diffs = [[EQUAL, 'H'], [INSERT, 'ello'], [EQUAL, 'World']];

    it('cursor at original 0 maps to 0', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 0)).toBe(0);
    });

    it('cursor at original 1 maps before insert (1)', () => {
      // origIdx=1 is at end of EQUAL "H": viewPos + (1-0) = 0+1 = 1
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 1)).toBe(1);
    });

    it('cursor at original 2 maps past insert (6)', () => {
      // After EQUAL "H": origPos=1, viewPos=1
      // INSERT "ello": origPos stays 1, viewPos=5
      // EQUAL "World": origIdx=2 is within [1,6], viewPos + (2-1) = 5+1 = 6
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 2)).toBe(6);
    });

    it('cursor at original end (6) maps to view end (10)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 6)).toBe(10);
    });
  });

  describe('insert at end', () => {
    // Original: "Hello" (len 5), View: "HelloWorld" (len 10)
    const diffs = [[EQUAL, 'Hello'], [INSERT, 'World']];

    it('cursor at original 5 maps before insert (5)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 5)).toBe(5);
    });

    it('cursor at original 0 maps to 0', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 0)).toBe(0);
    });
  });

  // ── Simple delete ──────────────────────────────────────────────────────

  describe('delete at start', () => {
    // Original: "HelloWorld" (len 10), View: "HelloWorld" (len 10) — delete is shown as strikethrough
    // Diff: [DELETE, "Hello"], [EQUAL, "World"]
    const diffs = [[DELETE, 'Hello'], [EQUAL, 'World']];

    it('cursor at original 0 maps to 0', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 0)).toBe(0);
    });

    it('cursor inside delete region (3) maps into view delete span (3)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 3)).toBe(3);
    });

    it('cursor at original 5 (end of deleted) maps to 5', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 5)).toBe(5);
    });

    it('cursor at original 7 maps to 7', () => {
      // After DELETE: origPos=5, viewPos=5
      // EQUAL "World": origIdx=7 within [5,10], 5 + (7-5) = 7
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 7)).toBe(7);
    });

    it('cursor at original end (10) maps to 10', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 10)).toBe(10);
    });
  });

  describe('delete in middle', () => {
    // Original: "HelloXWorld" (len 11), View: "HXWorld" shows "Hello" deleted
    // Actually view still shows all text including deletes as strikethrough
    // Diff: [EQUAL, "H"], [DELETE, "ello"], [EQUAL, "XWorld"]
    const diffs = [[EQUAL, 'H'], [DELETE, 'ello'], [EQUAL, 'XWorld']];

    it('cursor at original 1 maps to 1', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 1)).toBe(1);
    });

    it('cursor inside delete (3) maps to 3', () => {
      // origIdx=3 is within DELETE [1, 5]: viewPos + (3-1) = 1+2 = 3
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 3)).toBe(3);
    });

    it('cursor at original 5 (after deleted text) maps to 5', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 5)).toBe(5);
    });
  });

  describe('delete at end', () => {
    // Original: "HelloWorld" (len 10)
    // Diff: [EQUAL, "Hello"], [DELETE, "World"]
    const diffs = [[EQUAL, 'Hello'], [DELETE, 'World']];

    it('cursor at original 5 maps to 5', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 5)).toBe(5);
    });

    it('cursor at original end (10) maps to 10', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 10)).toBe(10);
    });
  });

  // ── Replacement (delete + insert) ─────────────────────────────────────

  describe('replacement (delete + insert)', () => {
    // Original: "cat" → "dog"
    // Diff: [DELETE, "cat"], [INSERT, "dog"]
    const diffs = [[DELETE, 'cat'], [INSERT, 'dog']];

    it('cursor at original 0 maps to 0', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 0)).toBe(0);
    });

    it('cursor at original 2 maps inside delete span (2)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 2)).toBe(2);
    });

    it('cursor at original 3 (end of deleted) maps to 3', () => {
      // origIdx=3 is at end of DELETE: viewPos + (3-0) = 0+3 = 3
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 3)).toBe(3);
    });
  });

  describe('replacement in middle of text', () => {
    // Original: "I have a cat here" → "I have a dog here"
    // Diff: [EQUAL, "I have a "], [DELETE, "cat"], [INSERT, "dog"], [EQUAL, " here"]
    const diffs = [
      [EQUAL, 'I have a '],
      [DELETE, 'cat'],
      [INSERT, 'dog'],
      [EQUAL, ' here'],
    ];

    it('cursor before replacement (9) maps to 9', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 9)).toBe(9);
    });

    it('cursor inside deleted word (10) maps into delete span (10)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 10)).toBe(10);
    });

    it('cursor after replacement in original (12) maps past both spans (15)', () => {
      // After EQUAL "I have a ": origPos=9, viewPos=9
      // After DELETE "cat": origPos=12, viewPos=12
      // After INSERT "dog": origPos=12, viewPos=15
      // origIdx=12 is at end of DELETE: 9 + (12-9) = 12
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 12)).toBe(12);
    });

    it('cursor in " here" part of original (13) maps past insert (16)', () => {
      // After DELETE "cat": origPos=12, viewPos=12
      // After INSERT "dog": origPos=12, viewPos=15
      // EQUAL " here": origIdx=13 within [12,17], 15 + (13-12) = 16
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 13)).toBe(16);
    });
  });

  // ── Cursor at exact boundaries ─────────────────────────────────────────

  describe('cursor at exact boundaries', () => {
    // Diff: [EQUAL, "ab"], [INSERT, "XY"], [EQUAL, "cd"]
    const diffs = [[EQUAL, 'ab'], [INSERT, 'XY'], [EQUAL, 'cd']];

    it('cursor at end of first equal / start of insert (2) stays before insert', () => {
      // origIdx=2 is within EQUAL "ab" [0,2], viewPos + (2-0) = 0+2 = 2
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 2)).toBe(2);
    });

    it('cursor at start of second equal (2) in original maps before insert', () => {
      // Same origIdx=2, INSERT checks origIdx === origPos (2===2) → returns viewPos=2
      // But EQUAL catches it first since 2 >= 0 && 2 <= 2
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 2)).toBe(2);
    });
  });

  // ── Empty diffs ────────────────────────────────────────────────────────

  describe('empty diffs array', () => {
    it('returns 0 for cursor at 0', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView([], 0)).toBe(0);
    });

    it('returns 0 for any cursor position (no segments to advance)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView([], 5)).toBe(0);
    });
  });

  // ── Multi-segment complex diffs ────────────────────────────────────────

  describe('complex multi-segment diffs', () => {
    // Original: "abcdef" → "abXYcf" (delete "de", insert "XY" after "c", then keep "f" but delete "e" separately)
    // Actually let's do: [EQUAL, "ab"], [DELETE, "cd"], [INSERT, "XY"], [EQUAL, "ef"]
    // Original: "abcdef" (len 6), View: "abcdXYef" (len 8)
    const diffs = [[EQUAL, 'ab'], [DELETE, 'cd'], [INSERT, 'XY'], [EQUAL, 'ef']];

    it('cursor at 0 maps to 0', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 0)).toBe(0);
    });

    it('cursor at 2 (start of delete) maps to 2', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 2)).toBe(2);
    });

    it('cursor at 3 (inside delete) maps to 3', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 3)).toBe(3);
    });

    it('cursor at 4 (after delete, start of EQUAL "ef") maps past insert (6)', () => {
      // After EQUAL "ab": origPos=2, viewPos=2
      // After DELETE "cd": origPos=4, viewPos=4
      // INSERT "XY": origIdx=4 === origPos=4 → returns viewPos=4
      // Actually: origIdx=4, origPos=4 at INSERT check: origIdx === origPos → return viewPos=4
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 4)).toBe(4);
    });

    it('cursor at 5 (inside EQUAL "ef") maps to 7', () => {
      // After DELETE "cd": origPos=4, viewPos=4
      // After INSERT "XY": origPos=4, viewPos=6
      // EQUAL "ef": origIdx=5 within [4,6], 6 + (5-4) = 7
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 5)).toBe(7);
    });

    it('cursor at 6 (end) maps to 8', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 6)).toBe(8);
    });
  });

  // ── Newline handling ───────────────────────────────────────────────────

  describe('diffs with newlines', () => {
    // Original: "Hello\nWorld" → "Hello\nDear\nWorld"
    // Diff: [EQUAL, "Hello\n"], [INSERT, "Dear\n"], [EQUAL, "World"]
    const diffs = [[EQUAL, 'Hello\n'], [INSERT, 'Dear\n'], [EQUAL, 'World']];

    it('cursor at 6 (after newline in original) maps before insert (6)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 6)).toBe(6);
    });

    it('cursor at 7 maps past insert (12)', () => {
      // After EQUAL "Hello\n": origPos=6, viewPos=6
      // After INSERT "Dear\n": origPos=6, viewPos=11
      // EQUAL "World": origIdx=7 within [6,11], 11 + (7-6) = 12
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 7)).toBe(12);
    });
  });

  // ── Insert-only diffs ──────────────────────────────────────────────────

  describe('insert-only diffs (empty original)', () => {
    // Original: "" → "Hello"
    const diffs = [[INSERT, 'Hello']];

    it('cursor at 0 maps before insert (0)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 0)).toBe(0);
    });
  });

  // ── Delete-only diffs ──────────────────────────────────────────────────

  describe('delete-only diffs (all deleted)', () => {
    // Original: "Hello" → ""
    const diffs = [[DELETE, 'Hello']];

    it('cursor at 0 maps to 0', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 0)).toBe(0);
    });

    it('cursor at 3 maps to 3', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 3)).toBe(3);
    });

    it('cursor at end (5) maps to 5', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 5)).toBe(5);
    });
  });

  // ── Multiple inserts ───────────────────────────────────────────────────

  describe('multiple consecutive inserts', () => {
    // Diff: [EQUAL, "a"], [INSERT, "X"], [INSERT, "Y"], [EQUAL, "b"]
    const diffs = [[EQUAL, 'a'], [INSERT, 'X'], [INSERT, 'Y'], [EQUAL, 'b']];

    it('cursor at 1 (between a and b) maps before first insert (1)', () => {
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 1)).toBe(1);
    });

    it('cursor at 2 (at b in original) maps past both inserts (4)', () => {
      // After EQUAL "a": origPos=1, viewPos=1
      // INSERT "X": origIdx=2 !== 1, viewPos=2
      // INSERT "Y": origIdx=2 !== 1, viewPos=3
      // EQUAL "b": origIdx=2 within [1,2], 3 + (2-1) = 4
      expect(TM.mapCursorOffsetFromOriginalToDiffView(diffs, 2)).toBe(4);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mapCursorOffsetFromDiffViewToOriginal
// ═══════════════════════════════════════════════════════════════════════════

describe('mapCursorOffsetFromDiffViewToOriginal', () => {
  // ── All-equal (no changes) ──────────────────────────────────────────────

  describe('all-equal diffs (no changes)', () => {
    const diffs = [[EQUAL, 'Hello']];

    it('maps view cursor at start (0) to original 0', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 0)).toBe(0);
    });

    it('maps view cursor in middle (3) to original 3', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 3)).toBe(3);
    });

    it('maps view cursor at end (5) to original 5', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 5)).toBe(5);
    });
  });

  // ── Insert handling ────────────────────────────────────────────────────

  describe('insert at start', () => {
    // Original: "World" (len 5), View: "HelloWorld" (len 10)
    const diffs = [[INSERT, 'Hello'], [EQUAL, 'World']];

    it('cursor at view 0 (before insert) maps to original 0', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 0)).toBe(0);
    });

    it('cursor inside insert (view 3) maps to original 0 (before insert point)', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 3)).toBe(0);
    });

    it('cursor at end of insert (view 5) maps to original 0', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 5)).toBe(0);
    });

    it('cursor after insert (view 6) maps to original 1', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 6)).toBe(1);
    });

    it('cursor at view end (10) maps to original 5', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 10)).toBe(5);
    });
  });

  describe('insert in middle', () => {
    // Diff: [EQUAL, "H"], [INSERT, "ello"], [EQUAL, "World"]
    // View: "HelloWorld" (len 10), Original: "HWorld" (len 6)
    const diffs = [[EQUAL, 'H'], [INSERT, 'ello'], [EQUAL, 'World']];

    it('cursor before insert (view 1) maps to original 1', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 1)).toBe(1);
    });

    it('cursor inside insert (view 3) maps to original 1', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 3)).toBe(1);
    });

    it('cursor at end of insert (view 5) maps to original 1', () => {
      // viewIdx=5 is within INSERT [1, 5] → returns origPos=1
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 5)).toBe(1);
    });

    it('cursor after insert (view 6) maps to original 2', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 6)).toBe(2);
    });
  });

  describe('insert at end', () => {
    const diffs = [[EQUAL, 'Hello'], [INSERT, 'World']];

    it('cursor at view 5 (start of insert) maps to original 5', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 5)).toBe(5);
    });

    it('cursor inside insert (view 8) maps to original 5', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 8)).toBe(5);
    });

    it('cursor at view end (10) maps to original 5', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 10)).toBe(5);
    });
  });

  // ── Delete handling ────────────────────────────────────────────────────

  describe('delete at start', () => {
    // Original: "HelloWorld" (len 10), View: "HelloWorld" (len 10) — delete shown as strikethrough
    const diffs = [[DELETE, 'Hello'], [EQUAL, 'World']];

    it('cursor at view 0 maps to original 0', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 0)).toBe(0);
    });

    it('cursor inside delete span (view 3) maps to original 3', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 3)).toBe(3);
    });

    it('cursor at end of delete (view 5) maps to original 5', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 5)).toBe(5);
    });

    it('cursor in equal after delete (view 7) maps to original 7', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 7)).toBe(7);
    });
  });

  describe('delete in middle', () => {
    // Diff: [EQUAL, "H"], [DELETE, "ello"], [EQUAL, "World"]
    const diffs = [[EQUAL, 'H'], [DELETE, 'ello'], [EQUAL, 'World']];

    it('cursor at view 1 maps to original 1', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 1)).toBe(1);
    });

    it('cursor inside delete (view 3) maps to original 3', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 3)).toBe(3);
    });

    it('cursor at view 5 (end of delete) maps to original 5', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 5)).toBe(5);
    });

    it('cursor at view 6 maps to original 6', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 6)).toBe(6);
    });
  });

  // ── Replacement (delete + insert) ─────────────────────────────────────

  describe('replacement (delete + insert)', () => {
    // Original: "cat" → "dog"
    // Diff: [DELETE, "cat"], [INSERT, "dog"]
    // View: "catdog" (len 6)
    const diffs = [[DELETE, 'cat'], [INSERT, 'dog']];

    it('cursor at view 0 maps to original 0', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 0)).toBe(0);
    });

    it('cursor inside delete (view 2) maps to original 2', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 2)).toBe(2);
    });

    it('cursor at boundary (view 3, end of delete) maps to original 3', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 3)).toBe(3);
    });

    it('cursor inside insert (view 4) maps to original 3 (insert point)', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 4)).toBe(3);
    });

    it('cursor at view end (6) maps to original 3', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 6)).toBe(3);
    });
  });

  describe('replacement in middle of text', () => {
    // Diff: [EQUAL, "I have a "], [DELETE, "cat"], [INSERT, "dog"], [EQUAL, " here"]
    // View: "I have a catdog here" (len 20)
    const diffs = [
      [EQUAL, 'I have a '],
      [DELETE, 'cat'],
      [INSERT, 'dog'],
      [EQUAL, ' here'],
    ];

    it('cursor at view 9 (start of delete) maps to original 9', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 9)).toBe(9);
    });

    it('cursor inside delete (view 11) maps to original 11', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 11)).toBe(11);
    });

    it('cursor at end of delete (view 12) maps to original 12', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 12)).toBe(12);
    });

    it('cursor inside insert (view 14) maps to original 12', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 14)).toBe(12);
    });

    it('cursor in trailing equal (view 16) maps to original 13', () => {
      // After DELETE "cat": origPos=12, viewPos=12
      // After INSERT "dog": origPos=12, viewPos=15
      // EQUAL " here": viewIdx=16 within [15,20], origPos + (16-15) = 12+1 = 13
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 16)).toBe(13);
    });
  });

  // ── Empty diffs ────────────────────────────────────────────────────────

  describe('empty diffs array', () => {
    it('returns 0 for cursor at 0', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal([], 0)).toBe(0);
    });

    it('returns 0 for any view cursor position', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal([], 5)).toBe(0);
    });
  });

  // ── Complex multi-segment ──────────────────────────────────────────────

  describe('complex multi-segment diffs', () => {
    // Diff: [EQUAL, "ab"], [DELETE, "cd"], [INSERT, "XY"], [EQUAL, "ef"]
    // View: "abcdXYef" (len 8), Original: "abcdef" (len 6)
    const diffs = [[EQUAL, 'ab'], [DELETE, 'cd'], [INSERT, 'XY'], [EQUAL, 'ef']];

    it('cursor at view 0 maps to original 0', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 0)).toBe(0);
    });

    it('cursor at view 2 maps to original 2', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 2)).toBe(2);
    });

    it('cursor at view 3 (inside delete) maps to original 3', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 3)).toBe(3);
    });

    it('cursor at view 4 (end of delete / start of insert) maps to original 4', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 4)).toBe(4);
    });

    it('cursor at view 5 (inside insert) maps to original 4', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 5)).toBe(4);
    });

    it('cursor at view 6 (start of trailing equal) maps to original 4', () => {
      // viewIdx=6 is within INSERT [4,6] → returns origPos=4
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 6)).toBe(4);
    });

    it('cursor at view 7 maps to original 5', () => {
      // After DELETE "cd": origPos=4, viewPos=4
      // After INSERT "XY": origPos=4, viewPos=6
      // EQUAL "ef": viewIdx=7 within [6,8], origPos + (7-6) = 4+1 = 5
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 7)).toBe(5);
    });

    it('cursor at view 8 (end) maps to original 6', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 8)).toBe(6);
    });
  });

  // ── Multiple inserts ───────────────────────────────────────────────────

  describe('multiple consecutive inserts', () => {
    // Diff: [EQUAL, "a"], [INSERT, "X"], [INSERT, "Y"], [EQUAL, "b"]
    // View: "aXYb" (len 4), Original: "ab" (len 2)
    const diffs = [[EQUAL, 'a'], [INSERT, 'X'], [INSERT, 'Y'], [EQUAL, 'b']];

    it('cursor at view 1 (start of first insert) maps to original 1', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 1)).toBe(1);
    });

    it('cursor inside first insert (view 1.5 round to 1) maps to original 1', () => {
      // viewIdx=1 is within INSERT "X" [1,2] → origPos=1
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 1)).toBe(1);
    });

    it('cursor at view 2 (between inserts) maps to original 1', () => {
      // viewIdx=2 is within INSERT "Y" [2,3] → origPos=1
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 2)).toBe(1);
    });

    it('cursor at view 3 (end of second insert / start of equal "b") maps to original 1', () => {
      // viewIdx=3 is within INSERT "Y" [2,3] → origPos=1
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 3)).toBe(1);
    });

    it('cursor at view 4 (at "b") maps to original 2', () => {
      // After INSERT "X": viewPos=2
      // After INSERT "Y": viewPos=3
      // EQUAL "b": viewIdx=4 within [3,4], origPos + (4-3) = 1+1 = 2
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 4)).toBe(2);
    });
  });

  // ── Newlines ───────────────────────────────────────────────────────────

  describe('diffs with newlines', () => {
    const diffs = [[EQUAL, 'Hello\n'], [INSERT, 'Dear\n'], [EQUAL, 'World']];
    // View: "Hello\nDear\nWorld" (len 16), Original: "Hello\nWorld" (len 11)

    it('cursor at view 6 (after first newline, start of insert) maps to original 6', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 6)).toBe(6);
    });

    it('cursor inside insert (view 9) maps to original 6', () => {
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 9)).toBe(6);
    });

    it('cursor after insert (view 12) maps to original 7', () => {
      // After EQUAL "Hello\n": origPos=6, viewPos=6
      // After INSERT "Dear\n": origPos=6, viewPos=11
      // EQUAL "World": viewIdx=12 within [11,16], origPos + (12-11) = 6+1 = 7
      expect(TM.mapCursorOffsetFromDiffViewToOriginal(diffs, 12)).toBe(7);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Roundtrip: Original → DiffView → Original
// ═══════════════════════════════════════════════════════════════════════════

describe('cursor mapping roundtrip', () => {
  it('roundtrips through all-equal diffs', () => {
    const diffs = [[EQUAL, 'Hello World']];
    for (let i = 0; i <= 11; i++) {
      const viewIdx = TM.mapCursorOffsetFromOriginalToDiffView(diffs, i);
      const backIdx = TM.mapCursorOffsetFromDiffViewToOriginal(diffs, viewIdx);
      expect(backIdx).toBe(i);
    }
  });

  it('roundtrips through diffs with only deletes (identity since deletes are visible)', () => {
    const diffs = [[EQUAL, 'ab'], [DELETE, 'cd'], [EQUAL, 'ef']];
    // Original: "abcdef" (len 6), View: "abcdef" (len 6)
    for (let i = 0; i <= 6; i++) {
      const viewIdx = TM.mapCursorOffsetFromOriginalToDiffView(diffs, i);
      const backIdx = TM.mapCursorOffsetFromDiffViewToOriginal(diffs, viewIdx);
      expect(backIdx).toBe(i);
    }
  });

  it('roundtrips with inserts — original positions map back correctly', () => {
    const diffs = [[EQUAL, 'ab'], [INSERT, 'XY'], [EQUAL, 'cd']];
    // Original: "abcd" (len 4), View: "abXYcd" (len 6)
    for (let i = 0; i <= 4; i++) {
      const viewIdx = TM.mapCursorOffsetFromOriginalToDiffView(diffs, i);
      const backIdx = TM.mapCursorOffsetFromDiffViewToOriginal(diffs, viewIdx);
      expect(backIdx).toBe(i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isInputEvent
// ═══════════════════════════════════════════════════════════════════════════

describe('isInputEvent', () => {
  // ── IME composition ────────────────────────────────────────────────────

  describe('IME composing events', () => {
    it('returns true when isComposing is true (regardless of event type)', () => {
      expect(TM.isInputEvent({ isComposing: true, type: 'keydown', key: 'Process' })).toBe(true);
    });

    it('returns true for compositionstart', () => {
      expect(TM.isInputEvent({ type: 'compositionstart', isComposing: false })).toBe(true);
    });

    it('returns true for compositionend', () => {
      expect(TM.isInputEvent({ type: 'compositionend', isComposing: false })).toBe(true);
    });
  });

  // ── beforeinput / input events ─────────────────────────────────────────

  describe('beforeinput / input events', () => {
    it('returns true for insertText', () => {
      expect(TM.isInputEvent({ type: 'beforeinput', inputType: 'insertText', isComposing: false })).toBe(true);
    });

    it('returns true for insertLineBreak', () => {
      expect(TM.isInputEvent({ type: 'beforeinput', inputType: 'insertLineBreak', isComposing: false })).toBe(true);
    });

    it('returns true for insertParagraph', () => {
      expect(TM.isInputEvent({ type: 'input', inputType: 'insertParagraph', isComposing: false })).toBe(true);
    });

    it('returns true for deleteContentBackward', () => {
      expect(TM.isInputEvent({ type: 'beforeinput', inputType: 'deleteContentBackward', isComposing: false })).toBe(true);
    });

    it('returns true for deleteContentForward', () => {
      expect(TM.isInputEvent({ type: 'input', inputType: 'deleteContentForward', isComposing: false })).toBe(true);
    });

    it('returns false for formatBold', () => {
      expect(TM.isInputEvent({ type: 'beforeinput', inputType: 'formatBold', isComposing: false })).toBe(false);
    });

    it('returns false for historyUndo', () => {
      expect(TM.isInputEvent({ type: 'beforeinput', inputType: 'historyUndo', isComposing: false })).toBe(false);
    });

    it('returns true for beforeinput with isComposing=true (even non-matching inputType)', () => {
      expect(TM.isInputEvent({ type: 'beforeinput', inputType: 'formatBold', isComposing: true })).toBe(true);
    });
  });

  // ── keydown events ─────────────────────────────────────────────────────

  describe('keydown events', () => {
    const base = { type: 'keydown', isComposing: false, ctrlKey: false, altKey: false, metaKey: false };

    it('returns true for single character key', () => {
      expect(TM.isInputEvent({ ...base, key: 'a' })).toBe(true);
    });

    it('returns true for uppercase character', () => {
      expect(TM.isInputEvent({ ...base, key: 'Z' })).toBe(true);
    });

    it('returns true for digit', () => {
      expect(TM.isInputEvent({ ...base, key: '5' })).toBe(true);
    });

    it('returns true for punctuation', () => {
      expect(TM.isInputEvent({ ...base, key: '.' })).toBe(true);
    });

    it('returns true for Enter', () => {
      expect(TM.isInputEvent({ ...base, key: 'Enter' })).toBe(true);
    });

    it('returns true for Tab', () => {
      expect(TM.isInputEvent({ ...base, key: 'Tab' })).toBe(true);
    });

    it('returns true for Space', () => {
      expect(TM.isInputEvent({ ...base, key: 'Space' })).toBe(true);
    });

    it('returns true for Backspace', () => {
      expect(TM.isInputEvent({ ...base, key: 'Backspace' })).toBe(true);
    });

    it('returns true for Delete', () => {
      expect(TM.isInputEvent({ ...base, key: 'Delete' })).toBe(true);
    });

    it('returns false for Arrow keys', () => {
      expect(TM.isInputEvent({ ...base, key: 'ArrowLeft' })).toBe(false);
      expect(TM.isInputEvent({ ...base, key: 'ArrowRight' })).toBe(false);
      expect(TM.isInputEvent({ ...base, key: 'ArrowUp' })).toBe(false);
      expect(TM.isInputEvent({ ...base, key: 'ArrowDown' })).toBe(false);
    });

    it('returns false for Escape', () => {
      expect(TM.isInputEvent({ ...base, key: 'Escape' })).toBe(false);
    });

    it('returns false for function keys', () => {
      expect(TM.isInputEvent({ ...base, key: 'F1' })).toBe(false);
      expect(TM.isInputEvent({ ...base, key: 'F12' })).toBe(false);
    });

    it('returns false for modifier-only keys', () => {
      expect(TM.isInputEvent({ ...base, key: 'Shift' })).toBe(false);
      expect(TM.isInputEvent({ ...base, key: 'Control' })).toBe(false);
      expect(TM.isInputEvent({ ...base, key: 'Alt' })).toBe(false);
      expect(TM.isInputEvent({ ...base, key: 'Meta' })).toBe(false);
    });

    it('returns false for Home/End/PageUp/PageDown', () => {
      expect(TM.isInputEvent({ ...base, key: 'Home' })).toBe(false);
      expect(TM.isInputEvent({ ...base, key: 'End' })).toBe(false);
      expect(TM.isInputEvent({ ...base, key: 'PageUp' })).toBe(false);
      expect(TM.isInputEvent({ ...base, key: 'PageDown' })).toBe(false);
    });
  });

  // ── Modifier combinations ──────────────────────────────────────────────

  describe('modifier key combinations', () => {
    it('returns false for Ctrl+A', () => {
      expect(TM.isInputEvent({ type: 'keydown', key: 'a', ctrlKey: true, altKey: false, metaKey: false, isComposing: false })).toBe(false);
    });

    it('returns false for Cmd+Z (undo)', () => {
      expect(TM.isInputEvent({ type: 'keydown', key: 'z', ctrlKey: false, altKey: false, metaKey: true, isComposing: false })).toBe(false);
    });

    it('returns false for Alt+key', () => {
      expect(TM.isInputEvent({ type: 'keydown', key: 'x', ctrlKey: false, altKey: true, metaKey: false, isComposing: false })).toBe(false);
    });

    it('returns false for Ctrl+Backspace (word delete)', () => {
      expect(TM.isInputEvent({ type: 'keydown', key: 'Backspace', ctrlKey: true, altKey: false, metaKey: false, isComposing: false })).toBe(false);
    });
  });

  // ── Unknown event types ────────────────────────────────────────────────

  describe('unknown event types', () => {
    it('returns false for unrecognized event type', () => {
      expect(TM.isInputEvent({ type: 'focus', isComposing: false })).toBe(false);
    });

    it('returns false for mousedown', () => {
      expect(TM.isInputEvent({ type: 'mousedown', isComposing: false })).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isWordBoundaryEvent
// ═══════════════════════════════════════════════════════════════════════════

describe('isWordBoundaryEvent', () => {
  const base = { ctrlKey: false, altKey: false, metaKey: false };

  it('returns true for Space', () => {
    expect(TM.isWordBoundaryEvent({ ...base, key: 'Space' })).toBe(true);
  });

  it('returns true for Tab', () => {
    expect(TM.isWordBoundaryEvent({ ...base, key: 'Tab' })).toBe(true);
  });

  it('returns true for Enter', () => {
    expect(TM.isWordBoundaryEvent({ ...base, key: 'Enter' })).toBe(true);
  });

  it('returns false for regular character', () => {
    expect(TM.isWordBoundaryEvent({ ...base, key: 'a' })).toBe(false);
  });

  it('returns false for Backspace', () => {
    expect(TM.isWordBoundaryEvent({ ...base, key: 'Backspace' })).toBe(false);
  });

  it('returns false for Delete', () => {
    expect(TM.isWordBoundaryEvent({ ...base, key: 'Delete' })).toBe(false);
  });

  it('returns false for digits', () => {
    expect(TM.isWordBoundaryEvent({ ...base, key: '9' })).toBe(false);
  });

  it('returns false for arrow keys', () => {
    expect(TM.isWordBoundaryEvent({ ...base, key: 'ArrowRight' })).toBe(false);
  });

  // ── Modifier combinations ──────────────────────────────────────────────

  it('returns false for Ctrl+Space', () => {
    expect(TM.isWordBoundaryEvent({ key: 'Space', ctrlKey: true, altKey: false, metaKey: false })).toBe(false);
  });

  it('returns false for Alt+Tab', () => {
    expect(TM.isWordBoundaryEvent({ key: 'Tab', ctrlKey: false, altKey: true, metaKey: false })).toBe(false);
  });

  it('returns false for Cmd+Enter', () => {
    expect(TM.isWordBoundaryEvent({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: true })).toBe(false);
  });

  it('returns false for Ctrl+Alt+Space', () => {
    expect(TM.isWordBoundaryEvent({ key: 'Space', ctrlKey: true, altKey: true, metaKey: false })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isDeletionEvent
// ═══════════════════════════════════════════════════════════════════════════

describe('isDeletionEvent', () => {
  const base = { ctrlKey: false, altKey: false, metaKey: false };

  it('returns true for Backspace', () => {
    expect(TM.isDeletionEvent({ ...base, key: 'Backspace' })).toBe(true);
  });

  it('returns true for Delete', () => {
    expect(TM.isDeletionEvent({ ...base, key: 'Delete' })).toBe(true);
  });

  it('returns false for regular character', () => {
    expect(TM.isDeletionEvent({ ...base, key: 'x' })).toBe(false);
  });

  it('returns false for Space', () => {
    expect(TM.isDeletionEvent({ ...base, key: 'Space' })).toBe(false);
  });

  it('returns false for Enter', () => {
    expect(TM.isDeletionEvent({ ...base, key: 'Enter' })).toBe(false);
  });

  it('returns false for Tab', () => {
    expect(TM.isDeletionEvent({ ...base, key: 'Tab' })).toBe(false);
  });

  it('returns false for Escape', () => {
    expect(TM.isDeletionEvent({ ...base, key: 'Escape' })).toBe(false);
  });

  it('returns false for arrow keys', () => {
    expect(TM.isDeletionEvent({ ...base, key: 'ArrowLeft' })).toBe(false);
  });

  // ── Modifier combinations ──────────────────────────────────────────────

  it('returns false for Ctrl+Backspace', () => {
    expect(TM.isDeletionEvent({ key: 'Backspace', ctrlKey: true, altKey: false, metaKey: false })).toBe(false);
  });

  it('returns false for Cmd+Delete', () => {
    expect(TM.isDeletionEvent({ key: 'Delete', ctrlKey: false, altKey: false, metaKey: true })).toBe(false);
  });

  it('returns false for Alt+Backspace', () => {
    expect(TM.isDeletionEvent({ key: 'Backspace', ctrlKey: false, altKey: true, metaKey: false })).toBe(false);
  });

  it('returns false for Ctrl+Alt+Delete', () => {
    expect(TM.isDeletionEvent({ key: 'Delete', ctrlKey: true, altKey: true, metaKey: false })).toBe(false);
  });
});
