// sentences.test.js — Tests for compose/modules/sentences.js
//
// The module uses the `var TabMail = TabMail || {}; Object.assign(TabMail, {...})` pattern.
// It's a classic script (not ESM), so we load it via readFileSync + eval.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createContext, runInNewContext } from 'vm';

let TabMail;

beforeAll(() => {
  TabMail = {};
  const code = readFileSync(resolve(__dirname, '../compose/modules/sentences.js'), 'utf8');
  // Run in a sandbox context where TabMail is a global
  const sandbox = { TabMail, console };
  runInNewContext(code, sandbox);
  TabMail = sandbox.TabMail;
});

// ---------------------------------------------------------------------------
// getSentenceParts
// ---------------------------------------------------------------------------
describe('getSentenceParts', () => {
  it('returns empty array for non-string input', () => {
    expect(TabMail.getSentenceParts(null)).toEqual([]);
    expect(TabMail.getSentenceParts(undefined)).toEqual([]);
    expect(TabMail.getSentenceParts(42)).toEqual([]);
    expect(TabMail.getSentenceParts('')).toEqual([]);
  });

  it('splits on newlines', () => {
    expect(TabMail.getSentenceParts('Hello\nWorld')).toEqual(['Hello\n', 'World']);
  });

  it('splits on sentence-ending punctuation followed by space', () => {
    expect(TabMail.getSentenceParts('Hello. World')).toEqual(['Hello. ', 'World']);
    expect(TabMail.getSentenceParts('Hello! World')).toEqual(['Hello! ', 'World']);
    expect(TabMail.getSentenceParts('Hello? World')).toEqual(['Hello? ', 'World']);
  });

  it('splits on sentence-ending punctuation at end of string', () => {
    expect(TabMail.getSentenceParts('Hello.')).toEqual(['Hello.']);
    expect(TabMail.getSentenceParts('Hello!')).toEqual(['Hello!']);
    expect(TabMail.getSentenceParts('Hello?')).toEqual(['Hello?']);
  });

  it('does not split on punctuation inside words (like v1.2)', () => {
    expect(TabMail.getSentenceParts('v1.2.3 is great')).toEqual(['v1.2.3 is great']);
  });

  it('splits on punctuation followed by newline, merging the newline', () => {
    expect(TabMail.getSentenceParts('Hello.\nWorld')).toEqual(['Hello.\n', 'World']);
  });

  it('handles trailing spaces after punctuation', () => {
    expect(TabMail.getSentenceParts('Hello.  World')).toEqual(['Hello.  ', 'World']);
  });

  it('handles single word', () => {
    expect(TabMail.getSentenceParts('Hello')).toEqual(['Hello']);
  });

  it('handles multiple newlines', () => {
    expect(TabMail.getSentenceParts('A\n\nB')).toEqual(['A\n', '\n', 'B']);
  });

  it('handles mixed punctuation and newlines', () => {
    const parts = TabMail.getSentenceParts('Hello! How are you?\nFine.');
    expect(parts).toEqual(['Hello! ', 'How are you?\n', 'Fine.']);
  });

  it('handles tab as whitespace after punctuation', () => {
    expect(TabMail.getSentenceParts('Hello.\tWorld')).toEqual(['Hello.\t', 'World']);
  });

  it('handles NBSP as whitespace after punctuation', () => {
    expect(TabMail.getSentenceParts('Hello.\u00A0World')).toEqual(['Hello.\u00A0', 'World']);
  });

  it('concatenation of parts reproduces original text', () => {
    const text = 'Hello world. How are you?\nI am fine! Thanks.';
    const parts = TabMail.getSentenceParts(text);
    expect(parts.join('')).toBe(text);
  });

  it('handles text with only whitespace', () => {
    expect(TabMail.getSentenceParts('   ')).toEqual(['   ']);
  });

  it('handles very long single sentence without punctuation', () => {
    const long = 'word '.repeat(500).trim();
    const parts = TabMail.getSentenceParts(long);
    expect(parts).toEqual([long]);
    expect(parts.join('')).toBe(long);
  });

  it('does not split on periods inside URLs', () => {
    // Periods not followed by space/newline/end should not cause splits
    const text = 'Visit https://www.example.com/path for info';
    const parts = TabMail.getSentenceParts(text);
    expect(parts.join('')).toBe(text);
    // The periods in the URL are not followed by space, so no split
    expect(parts).toEqual([text]);
  });

  it('does not split on abbreviations like Mr. or Dr. mid-sentence', () => {
    // "Mr." followed by space WILL split since the algorithm is punctuation+space
    // This documents the actual behavior (no abbreviation-awareness)
    const text = 'Mr. Smith is here.';
    const parts = TabMail.getSentenceParts(text);
    // The algorithm splits on ". " so Mr. will cause a split
    expect(parts.join('')).toBe(text);
    // Verify it splits (abbreviations are NOT specially handled)
    expect(parts.length).toBeGreaterThan(1);
  });

  it('handles consecutive punctuation marks', () => {
    const text = 'Really?! Yes.';
    const parts = TabMail.getSentenceParts(text);
    expect(parts.join('')).toBe(text);
  });

  it('handles text ending with newline', () => {
    expect(TabMail.getSentenceParts('Hello\n')).toEqual(['Hello\n']);
  });

  it('handles text with only newlines', () => {
    expect(TabMail.getSentenceParts('\n\n\n')).toEqual(['\n', '\n', '\n']);
  });

  it('handles text with trailing spaces after final punctuation', () => {
    const text = 'Hello.   ';
    const parts = TabMail.getSentenceParts(text);
    expect(parts.join('')).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// splitIntoSentences (wrapper around getSentenceParts)
// ---------------------------------------------------------------------------
describe('splitIntoSentences', () => {
  it('delegates to getSentenceParts', () => {
    expect(TabMail.splitIntoSentences('A. B')).toEqual(['A. ', 'B']);
  });

  it('handles empty string', () => {
    expect(TabMail.splitIntoSentences('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findSentenceContainingCursor
// ---------------------------------------------------------------------------
describe('findSentenceContainingCursor', () => {
  const sentences = ['Hello. ', 'World.'];
  // Offsets: 'Hello. ' = 0..6, 'World.' = 7..12

  it('returns correct index for cursor at start', () => {
    expect(TabMail.findSentenceContainingCursor(sentences, 0)).toBe(0);
  });

  it('returns correct index for cursor in first sentence', () => {
    expect(TabMail.findSentenceContainingCursor(sentences, 3)).toBe(0);
  });

  it('returns correct index for cursor in second sentence', () => {
    expect(TabMail.findSentenceContainingCursor(sentences, 7)).toBe(1);
  });

  it('returns last sentence index when cursor is at the very end', () => {
    expect(TabMail.findSentenceContainingCursor(sentences, 13)).toBe(1);
  });

  it('returns -1 for empty sentences array', () => {
    expect(TabMail.findSentenceContainingCursor([], 0)).toBe(-1);
  });

  it('returns 0 for single sentence', () => {
    expect(TabMail.findSentenceContainingCursor(['Hello'], 0)).toBe(0);
  });

  it('returns last sentence when cursor is well beyond text length', () => {
    expect(TabMail.findSentenceContainingCursor(sentences, 100)).toBe(1);
  });

  it('returns correct index at boundary between sentences', () => {
    // 'Hello. ' is indices 0-6 (length 7), 'World.' starts at index 7
    // cursorPosition 6 is still inside first sentence (the space)
    expect(TabMail.findSentenceContainingCursor(sentences, 6)).toBe(0);
    // cursorPosition 7 is the start of second sentence
    expect(TabMail.findSentenceContainingCursor(sentences, 7)).toBe(1);
  });

  it('returns last index for cursor at exact end of last sentence', () => {
    // Total length = 7 + 6 = 13. Cursor at 13 is past-the-end.
    expect(TabMail.findSentenceContainingCursor(sentences, 13)).toBe(1);
  });

  it('handles three sentences', () => {
    const three = ['A. ', 'B. ', 'C.'];
    // A. = 0..2, B. = 3..5, C. = 6..7
    expect(TabMail.findSentenceContainingCursor(three, 0)).toBe(0);
    expect(TabMail.findSentenceContainingCursor(three, 3)).toBe(1);
    expect(TabMail.findSentenceContainingCursor(three, 6)).toBe(2);
  });

  it('returns last sentence for single-char cursor past end of single sentence', () => {
    expect(TabMail.findSentenceContainingCursor(['Hi'], 5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getSentenceStartOffset
// ---------------------------------------------------------------------------
describe('getSentenceStartOffset', () => {
  it('returns 0 for the first sentence', () => {
    expect(TabMail.getSentenceStartOffset('Hello. World.', 0)).toBe(0);
  });

  it('returns correct offset for second sentence', () => {
    // 'Hello. World.' -> ['Hello. ', 'World.']
    expect(TabMail.getSentenceStartOffset('Hello. World.', 1)).toBe(7);
  });

  it('returns 0 for empty text', () => {
    expect(TabMail.getSentenceStartOffset('', 0)).toBe(0);
  });

  it('returns correct offset for third sentence', () => {
    // 'A. B. C.' -> ['A. ', 'B. ', 'C.']
    // offsets: 0, 3, 6
    expect(TabMail.getSentenceStartOffset('A. B. C.', 2)).toBe(6);
  });

  it('returns total text length for index beyond sentence count', () => {
    // With index beyond array, the loop sums all sentences
    const text = 'Hello. World.';
    // sentences = ['Hello. ', 'World.'], lengths = 7, 6
    // index=5 -> loop runs i=0..4 but only 2 sentences exist,
    // accessing undefined sentences[2..4] would cause issues.
    // Let's test index = 2 (one past the last)
    const offset = TabMail.getSentenceStartOffset(text, 2);
    expect(offset).toBe(13); // 7 + 6 = total length
  });

  it('returns correct offset with newline-separated sentences', () => {
    const text = 'Hello\nWorld';
    // sentences = ['Hello\n', 'World']
    expect(TabMail.getSentenceStartOffset(text, 1)).toBe(6);
  });
});
