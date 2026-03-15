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
});
