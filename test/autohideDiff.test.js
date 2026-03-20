// autohideDiff.test.js — Tests for compose/modules/autohideDiff.js pure-logic functions
//
// The module uses `var TabMail = TabMail || {}; Object.assign(TabMail, {...})` pattern.
// We load it via readFileSync + vm.runInNewContext, same as composeDom.test.js.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

let TM;

function createState() {
  return {
    editorRef: null,
    correctedText: null,
    lastRenderedText: null,
    autoHideDiff: false,
    adherenceInfo: null,
    lastKeystrokeAdheredToSuggestion: false,
    showDiff: true,
    isDiffActive: false,
    diffRestoreTimer: null,
    currentlyHighlightedSpans: [],
  };
}

beforeAll(() => {
  const code = readFileSync(
    resolve(__dirname, '../compose/modules/autohideDiff.js'),
    'utf8'
  );

  const sandbox = {
    TabMail: {
      config: { DIFF_RESTORE_DELAY_MS: 1000 },
      log: { debug: () => {}, info: () => {}, trace: () => {}, warn: () => {} },
      state: createState(),
      isInputEvent: () => false,
      getCursorOffsetIgnoringInserts: () => 0,
      renderText: () => {},
      _beginProgrammaticSelection: () => {},
      _endProgrammaticSelection: () => {},
      extractUserAndQuoteTexts: () => ({ originalUserMessage: '', quoteBoundaryNode: null }),
    },
    console,
    Object,
    Array,
    String,
    Number,
    setTimeout,
    clearTimeout,
    window: { getSelection: () => null },
    document: {
      createRange: () => ({
        selectNodeContents: () => {},
        setEndBefore: () => {},
      }),
    },
  };

  runInNewContext(code, sandbox);
  TM = sandbox.TabMail;
});

// ─────────────────────────────────────────────────────────────
// Diff format: [op, text, origSentIdx?, newSentIdx?]
//   op: 0 = EQUAL, 1 = INSERT, -1 = DELETE
// ─────────────────────────────────────────────────────────────

describe('_findTypingAdherenceInfo', () => {
  it('returns adherence when cursor is at INSERT position and char matches first char', () => {
    // diffs: EQUAL "Hello" | INSERT "World"
    const diffs = [[0, 'Hello'], [1, 'World']];
    // cursor at 5 (end of "Hello"), INSERT starts at 5, first char 'W'
    const result = TM._findTypingAdherenceInfo(diffs, 5, 'W');
    expect(result).not.toBeNull();
    expect(result.type).toBe('insert');
    expect(result.diffIndex).toBe(1);
    expect(result.charIndex).toBe(0);
    expect(result.char).toBe('W');
  });

  it('returns null when cursor is at INSERT position but char does not match', () => {
    const diffs = [[0, 'Hello'], [1, 'World']];
    const result = TM._findTypingAdherenceInfo(diffs, 5, 'X');
    expect(result).toBeNull();
  });

  it('returns adherence when cursor is at end of EQUAL and INSERT follows with matching char', () => {
    const diffs = [[0, 'abc'], [1, 'def']];
    const result = TM._findTypingAdherenceInfo(diffs, 3, 'd');
    expect(result).not.toBeNull();
    expect(result.type).toBe('insert');
    expect(result.diffIndex).toBe(1);
    expect(result.char).toBe('d');
  });

  it('returns null when cursor is at end of EQUAL but INSERT first char does not match', () => {
    const diffs = [[0, 'abc'], [1, 'def']];
    const result = TM._findTypingAdherenceInfo(diffs, 3, 'z');
    expect(result).toBeNull();
  });

  it('returns adherence for replace operation (DELETE followed by INSERT) when cursor at end of DELETE and char matches INSERT', () => {
    // EQUAL "Hi" | DELETE "old" | INSERT "new"
    const diffs = [[0, 'Hi'], [-1, 'old'], [1, 'new']];
    // cursor at 5 = end of "Hi" (2) + "old" (3), char 'n' matches INSERT
    const result = TM._findTypingAdherenceInfo(diffs, 5, 'n');
    expect(result).not.toBeNull();
    expect(result.type).toBe('insert');
    expect(result.diffIndex).toBe(2);
    expect(result.char).toBe('n');
  });

  it('returns null when cursor is in the middle of an EQUAL span (no adherence possible)', () => {
    const diffs = [[0, 'Hello'], [1, 'World']];
    // cursor at 2 = middle of "Hello"
    const result = TM._findTypingAdherenceInfo(diffs, 2, 'W');
    expect(result).toBeNull();
  });

  it('returns adherence for trailing INSERT at end of text when cursor is at end', () => {
    // EQUAL "Hello" | INSERT " World"
    const diffs = [[0, 'Hello'], [1, ' World']];
    // cursor at 5 = end of EQUAL text
    const result = TM._findTypingAdherenceInfo(diffs, 5, ' ');
    expect(result).not.toBeNull();
    expect(result.type).toBe('insert');
    expect(result.diffIndex).toBe(1);
    expect(result.char).toBe(' ');
  });

  it('returns null for empty diffs array', () => {
    const result = TM._findTypingAdherenceInfo([], 0, 'a');
    expect(result).toBeNull();
  });

  it('does not match second INSERT when first INSERT does not match', () => {
    // EQUAL "ab" | INSERT "cd" | EQUAL "ef" | INSERT "gh"
    const diffs = [[0, 'ab'], [1, 'cd'], [0, 'ef'], [1, 'gh']];
    // cursor at 2 (end of first EQUAL), first INSERT starts with 'c', typing 'g' should not match
    const result = TM._findTypingAdherenceInfo(diffs, 2, 'g');
    expect(result).toBeNull();
  });

  it('handles newline character as typedChar', () => {
    const diffs = [[0, 'Hello'], [1, '\nWorld']];
    const result = TM._findTypingAdherenceInfo(diffs, 5, '\n');
    expect(result).not.toBeNull();
    expect(result.type).toBe('insert');
    expect(result.char).toBe('\n');
  });

  it('returns adherence when INSERT is at the very start of diffs and cursor is 0', () => {
    const diffs = [[1, 'prefix'], [0, 'existing']];
    const result = TM._findTypingAdherenceInfo(diffs, 0, 'p');
    expect(result).not.toBeNull();
    expect(result.diffIndex).toBe(0);
    expect(result.char).toBe('p');
  });

  it('returns null when INSERT is at start but cursor is not 0', () => {
    const diffs = [[1, 'prefix'], [0, 'existing']];
    const result = TM._findTypingAdherenceInfo(diffs, 3, 'p');
    expect(result).toBeNull();
  });

  it('skips DELETE to find INSERT in replace op at end of EQUAL', () => {
    // EQUAL "abc" | DELETE "xyz" | INSERT "123"
    const diffs = [[0, 'abc'], [-1, 'xyz'], [1, '123']];
    // cursor at 3 = end of EQUAL, lookahead should skip DELETE and find INSERT
    const result = TM._findTypingAdherenceInfo(diffs, 3, '1');
    expect(result).not.toBeNull();
    expect(result.diffIndex).toBe(2);
    expect(result.char).toBe('1');
  });

  it('returns adherence for trailing INSERT when no EQUAL precedes it', () => {
    // DELETE "old" | INSERT "new"
    const diffs = [[-1, 'old'], [1, 'new']];
    // cursor at 3 = end of DELETE text
    const result = TM._findTypingAdherenceInfo(diffs, 3, 'n');
    expect(result).not.toBeNull();
    expect(result.diffIndex).toBe(1);
  });

  it('returns null when INSERT text is empty', () => {
    const diffs = [[0, 'Hello'], [1, '']];
    const result = TM._findTypingAdherenceInfo(diffs, 5, 'a');
    expect(result).toBeNull();
  });
});


describe('_findEnterBeforeNewlineAdherence', () => {
  it('returns adherence when EQUAL ends with \\n, cursor right before it, and INSERT starts with \\n', () => {
    // EQUAL "Hello\n" | INSERT "\nWorld"
    // cursor at 5 = right before the \n (segmentEnd=6, cursor=segmentEnd-1=5)
    const diffs = [[0, 'Hello\n'], [1, '\nWorld']];
    const result = TM._findEnterBeforeNewlineAdherence(diffs, 5);
    expect(result).not.toBeNull();
    expect(result.type).toBe('insert');
    expect(result.diffIndex).toBe(1);
    expect(result.charIndex).toBe(0);
    expect(result.char).toBe('\n');
    expect(result.advanceCursorBy).toBe(1);
  });

  it('returns null when EQUAL does not end with \\n', () => {
    // EQUAL "Hello" | INSERT "\nWorld"
    const diffs = [[0, 'Hello'], [1, '\nWorld']];
    const result = TM._findEnterBeforeNewlineAdherence(diffs, 4);
    expect(result).toBeNull();
  });

  it('returns null when cursor is not at the position before the newline', () => {
    // EQUAL "Hello\n" | INSERT "\nWorld"
    // cursor at 3 != segmentEnd-1 (5)
    const diffs = [[0, 'Hello\n'], [1, '\nWorld']];
    const result = TM._findEnterBeforeNewlineAdherence(diffs, 3);
    expect(result).toBeNull();
  });

  it('returns null when no INSERT follows the EQUAL', () => {
    // EQUAL "Hello\n" | EQUAL "World"
    const diffs = [[0, 'Hello\n'], [0, 'World']];
    const result = TM._findEnterBeforeNewlineAdherence(diffs, 5);
    expect(result).toBeNull();
  });

  it('returns null when INSERT does not start with \\n', () => {
    // EQUAL "Hello\n" | INSERT "World"
    const diffs = [[0, 'Hello\n'], [1, 'World']];
    const result = TM._findEnterBeforeNewlineAdherence(diffs, 5);
    expect(result).toBeNull();
  });

  it('returns null when DELETE is between EQUAL and INSERT (only checks immediate next diff)', () => {
    // EQUAL "Hello\n" | DELETE "x" | INSERT "\nWorld"
    // The function checks diffs[i+1], which is the DELETE, not the INSERT
    const diffs = [[0, 'Hello\n'], [-1, 'x'], [1, '\nWorld']];
    const result = TM._findEnterBeforeNewlineAdherence(diffs, 5);
    expect(result).toBeNull();
  });

  it('returns null for empty diffs', () => {
    const result = TM._findEnterBeforeNewlineAdherence([], 0);
    expect(result).toBeNull();
  });

  it('returns null when EQUAL text is empty', () => {
    const diffs = [[0, ''], [1, '\nWorld']];
    // segmentEnd - 1 = -1, cursorPos = 0 won't match
    const result = TM._findEnterBeforeNewlineAdherence(diffs, 0);
    expect(result).toBeNull();
  });

  it('handles multiple EQUAL segments, matching on the correct one', () => {
    // EQUAL "Hi" | EQUAL "there\n" | INSERT "\nextra"
    const diffs = [[0, 'Hi'], [0, 'there\n'], [1, '\nextra']];
    // cursor at 7 = 2 + 6 - 1 = right before \n in second EQUAL
    const result = TM._findEnterBeforeNewlineAdherence(diffs, 7);
    expect(result).not.toBeNull();
    expect(result.diffIndex).toBe(2);
    expect(result.advanceCursorBy).toBe(1);
  });
});


describe('_findDeletionAdherenceInfo', () => {
  it('returns adherence when targetPos is inside a DELETE span', () => {
    // EQUAL "abc" | DELETE "xyz"
    const diffs = [[0, 'abc'], [-1, 'xyz']];
    // targetPos=4 is inside DELETE (origPos=3, segmentEnd=6, charIndex=1 → 'y')
    const result = TM._findDeletionAdherenceInfo(diffs, 4);
    expect(result).not.toBeNull();
    expect(result.type).toBe('delete');
    expect(result.diffIndex).toBe(1);
    expect(result.charIndex).toBe(1);
    expect(result.char).toBe('y');
  });

  it('returns adherence when targetPos is at start of DELETE span', () => {
    const diffs = [[0, 'abc'], [-1, 'xyz']];
    // targetPos=3 = start of DELETE
    const result = TM._findDeletionAdherenceInfo(diffs, 3);
    expect(result).not.toBeNull();
    expect(result.charIndex).toBe(0);
    expect(result.char).toBe('x');
  });

  it('returns adherence when targetPos is at last char of DELETE span', () => {
    const diffs = [[0, 'abc'], [-1, 'xyz']];
    // targetPos=5 = last char of DELETE (charIndex=2 → 'z')
    const result = TM._findDeletionAdherenceInfo(diffs, 5);
    expect(result).not.toBeNull();
    expect(result.charIndex).toBe(2);
    expect(result.char).toBe('z');
  });

  it('returns null when targetPos is in an EQUAL span', () => {
    const diffs = [[0, 'abc'], [-1, 'xyz']];
    // targetPos=1 is inside EQUAL
    const result = TM._findDeletionAdherenceInfo(diffs, 1);
    expect(result).toBeNull();
  });

  it('returns null when targetPos is in an INSERT span (INSERTs are skipped)', () => {
    // EQUAL "abc" | INSERT "new" | DELETE "xyz"
    const diffs = [[0, 'abc'], [1, 'new'], [-1, 'xyz']];
    // INSERT doesn't advance origPos, so DELETE starts at origPos=3
    // targetPos=1 is in EQUAL
    const result = TM._findDeletionAdherenceInfo(diffs, 1);
    expect(result).toBeNull();
  });

  it('correctly skips INSERT when looking for DELETE', () => {
    // EQUAL "ab" | INSERT "new" | DELETE "cd"
    const diffs = [[0, 'ab'], [1, 'new'], [-1, 'cd']];
    // INSERT skipped, DELETE at origPos=2, targetPos=2 → charIndex=0 → 'c'
    const result = TM._findDeletionAdherenceInfo(diffs, 2);
    expect(result).not.toBeNull();
    expect(result.diffIndex).toBe(2);
    expect(result.charIndex).toBe(0);
    expect(result.char).toBe('c');
  });

  it('returns null for empty diffs', () => {
    const result = TM._findDeletionAdherenceInfo([], 0);
    expect(result).toBeNull();
  });

  it('returns null when targetPos is beyond all diffs', () => {
    const diffs = [[0, 'abc'], [-1, 'xy']];
    // total origPos = 3 + 2 = 5, targetPos=10 beyond
    const result = TM._findDeletionAdherenceInfo(diffs, 10);
    expect(result).toBeNull();
  });

  it('returns null when targetPos equals segmentEnd of DELETE (exclusive upper bound)', () => {
    const diffs = [[-1, 'abc']];
    // DELETE covers [0, 3), targetPos=3 is at segmentEnd (exclusive)
    const result = TM._findDeletionAdherenceInfo(diffs, 3);
    expect(result).toBeNull();
  });

  it('handles DELETE at start of diffs with no preceding EQUAL', () => {
    const diffs = [[-1, 'removed'], [0, 'kept']];
    const result = TM._findDeletionAdherenceInfo(diffs, 0);
    expect(result).not.toBeNull();
    expect(result.diffIndex).toBe(0);
    expect(result.charIndex).toBe(0);
    expect(result.char).toBe('r');
  });
});


describe('_applyAdherenceToDiffs', () => {
  beforeEach(() => {
    TM.state = createState();
  });

  // ── INSERT adherence ──

  it('removes first char from INSERT and appends to preceding EQUAL', () => {
    const diffs = [[0, 'Hello'], [1, 'World']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 1, charIndex: 0, char: 'W' });

    expect(diffs[0][1]).toBe('HelloW');
    expect(diffs[1][1]).toBe('orld');
  });

  it('removes INSERT entry entirely when it becomes empty', () => {
    const diffs = [[0, 'Hello'], [1, 'X']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 1, charIndex: 0, char: 'X' });

    expect(diffs[0][1]).toBe('HelloX');
    expect(diffs.length).toBe(1); // INSERT removed
  });

  it('creates new EQUAL when no preceding EQUAL exists', () => {
    const diffs = [[1, 'Hello']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 0, charIndex: 0, char: 'H' });

    // New EQUAL created at index 0, INSERT shifted to index 1
    expect(diffs.length).toBe(2);
    expect(diffs[0][0]).toBe(0); // EQUAL
    expect(diffs[0][1]).toBe('H');
    expect(diffs[1][0]).toBe(1); // INSERT
    expect(diffs[1][1]).toBe('ello');
  });

  it('creates new EQUAL and removes INSERT when INSERT becomes empty after new EQUAL', () => {
    const diffs = [[1, 'X']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 0, charIndex: 0, char: 'X' });

    // New EQUAL created, INSERT removed since it becomes empty
    expect(diffs.length).toBe(1);
    expect(diffs[0][0]).toBe(0); // EQUAL
    expect(diffs[0][1]).toBe('X');
  });

  it('handles INSERT adherence with DELETE between EQUAL and INSERT (replace op)', () => {
    // EQUAL "Hi" | DELETE "old" | INSERT "new"
    const diffs = [[0, 'Hi'], [-1, 'old'], [1, 'new']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 2, charIndex: 0, char: 'n' });

    // Preceding EQUAL found (skipping DELETE), extended with 'n'
    expect(diffs[0][1]).toBe('Hin');
    expect(diffs[2][1]).toBe('ew');
  });

  it('preserves sentence indices when creating new EQUAL', () => {
    const diffs = [[1, 'Hello', 0, 1]];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 0, charIndex: 0, char: 'H' });

    // New EQUAL should carry the sentence indices from the INSERT
    expect(diffs[0][2]).toBe(0);
    expect(diffs[0][3]).toBe(1);
  });

  it('inserts new EQUAL before DELETE when no preceding EQUAL exists in replace op', () => {
    // DELETE "old" | INSERT "new"
    const diffs = [[-1, 'old'], [1, 'new']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 1, charIndex: 0, char: 'n' });

    // New EQUAL created before DELETE
    expect(diffs.length).toBe(3);
    expect(diffs[0][0]).toBe(0); // new EQUAL
    expect(diffs[0][1]).toBe('n');
    expect(diffs[1][0]).toBe(-1); // DELETE
    expect(diffs[1][1]).toBe('old');
    expect(diffs[2][0]).toBe(1); // INSERT (now shifted)
    expect(diffs[2][1]).toBe('ew');
  });

  // ── DELETE adherence ──

  it('removes char from DELETE span', () => {
    const diffs = [[0, 'abc'], [-1, 'xyz']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'delete', diffIndex: 1, charIndex: 1, char: 'y' });

    expect(diffs[1][1]).toBe('xz');
  });

  it('removes DELETE entry entirely when it becomes empty', () => {
    const diffs = [[0, 'abc'], [-1, 'x']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'delete', diffIndex: 1, charIndex: 0, char: 'x' });

    expect(diffs.length).toBe(1);
    expect(diffs[0][1]).toBe('abc');
  });

  it('removes first char from DELETE span', () => {
    const diffs = [[-1, 'abc']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'delete', diffIndex: 0, charIndex: 0, char: 'a' });

    expect(diffs[0][1]).toBe('bc');
  });

  it('removes last char from DELETE span', () => {
    const diffs = [[-1, 'abc']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'delete', diffIndex: 0, charIndex: 2, char: 'c' });

    expect(diffs[0][1]).toBe('ab');
  });

  it('removes middle char from DELETE span', () => {
    const diffs = [[0, 'x'], [-1, 'abcde']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'delete', diffIndex: 1, charIndex: 2, char: 'c' });

    expect(diffs[1][1]).toBe('abde');
  });

  // ── null / edge cases ──

  it('does nothing when info is null', () => {
    const diffs = [[0, 'Hello'], [1, 'World']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs(null);

    expect(diffs[0][1]).toBe('Hello');
    expect(diffs[1][1]).toBe('World');
  });

  it('does nothing when lastRenderedText is null', () => {
    TM.state.lastRenderedText = null;
    // Should not throw
    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 0, charIndex: 0, char: 'a' });
  });

  it('does nothing when diffIndex is out of range', () => {
    const diffs = [[0, 'Hello']];
    TM.state.lastRenderedText = { diffs };

    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 5, charIndex: 0, char: 'a' });

    expect(diffs.length).toBe(1);
    expect(diffs[0][1]).toBe('Hello');
  });

  it('handles consecutive INSERT adherence calls correctly', () => {
    // Simulate typing "Wo" into INSERT "World"
    const diffs = [[0, 'Hello'], [1, 'World']];
    TM.state.lastRenderedText = { diffs };

    // First keystroke: 'W'
    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 1, charIndex: 0, char: 'W' });
    expect(diffs[0][1]).toBe('HelloW');
    expect(diffs[1][1]).toBe('orld');

    // Second keystroke: 'o'
    TM._applyAdherenceToDiffs({ type: 'insert', diffIndex: 1, charIndex: 0, char: 'o' });
    expect(diffs[0][1]).toBe('HelloWo');
    expect(diffs[1][1]).toBe('rld');
  });
});
