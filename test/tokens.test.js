// tokens.test.js — Tests for compose/modules/tokens.js
//
// The module uses the `var TabMail = TabMail || {}; Object.assign(TabMail, {...})` pattern.
// It's a classic script (not ESM), so we load it via readFileSync + new Function.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

let TabMail;

beforeAll(() => {
  TabMail = {};
  const code = readFileSync(resolve(__dirname, '../compose/modules/tokens.js'), 'utf8');
  const sandbox = { TabMail, console };
  runInNewContext(code, sandbox);
  TabMail = sandbox.TabMail;
});

// ---------------------------------------------------------------------------
// getTokenParts
// ---------------------------------------------------------------------------
describe('getTokenParts', () => {
  it('returns empty array for non-string input', () => {
    expect(TabMail.getTokenParts(null)).toEqual([]);
    expect(TabMail.getTokenParts(undefined)).toEqual([]);
    expect(TabMail.getTokenParts(42)).toEqual([]);
    expect(TabMail.getTokenParts('')).toEqual([]);
  });

  it('splits a simple word into one token', () => {
    expect(TabMail.getTokenParts('hello')).toEqual(['hello']);
  });

  it('splits words and spaces', () => {
    const result = TabMail.getTokenParts('hello world');
    expect(result).toEqual(['hello', ' ', 'world']);
  });

  it('keeps newline as a separate token', () => {
    const result = TabMail.getTokenParts('hello\nworld');
    expect(result).toEqual(['hello', '\n', 'world']);
  });

  it('separates punctuation as individual tokens', () => {
    const result = TabMail.getTokenParts('hello, world!');
    expect(result).toEqual(['hello', ',', ' ', 'world', '!']);
  });

  it('handles underscore as word character', () => {
    const result = TabMail.getTokenParts('my_var');
    expect(result).toEqual(['my_var']);
  });

  it('handles multiple spaces', () => {
    const result = TabMail.getTokenParts('a  b');
    expect(result).toEqual(['a', ' ', ' ', 'b']);
  });

  it('handles tabs', () => {
    const result = TabMail.getTokenParts('a\tb');
    expect(result).toEqual(['a', '\t', 'b']);
  });

  it('handles CJK characters as word tokens', () => {
    // Non-ASCII chars (code > 127) are treated as word characters
    const result = TabMail.getTokenParts('hello世界');
    expect(result).toEqual(['hello世界']);
  });

  it('handles empty lines (double newline)', () => {
    const result = TabMail.getTokenParts('a\n\nb');
    expect(result).toEqual(['a', '\n', '\n', 'b']);
  });

  it('handles mixed content', () => {
    const result = TabMail.getTokenParts('Hello, World!\n');
    expect(result).toEqual(['Hello', ',', ' ', 'World', '!', '\n']);
  });

  it('handles NBSP character (code > 127, treated as word char)', () => {
    // NBSP has code 0xA0 > 127, so it's treated as a word character
    const result = TabMail.getTokenParts('a\u00A0b');
    expect(result).toEqual(['a\u00A0b']);
  });

  it('handles numbers as word tokens', () => {
    const result = TabMail.getTokenParts('test123');
    expect(result).toEqual(['test123']);
  });

  it('concatenation reproduces original text', () => {
    const text = 'Hello, World! How are you?\n';
    const tokens = TabMail.getTokenParts(text);
    expect(tokens.join('')).toBe(text);
  });

  it('handles parentheses and brackets', () => {
    const result = TabMail.getTokenParts('a(b)');
    expect(result).toEqual(['a', '(', 'b', ')']);
  });

  it('handles dots inside words (abbreviations)', () => {
    const result = TabMail.getTokenParts('e.g.');
    expect(result).toEqual(['e', '.', 'g', '.']);
  });

  it('handles text with only spaces', () => {
    const result = TabMail.getTokenParts('   ');
    expect(result).toEqual([' ', ' ', ' ']);
  });

  it('handles text with only newlines', () => {
    const result = TabMail.getTokenParts('\n\n');
    expect(result).toEqual(['\n', '\n']);
  });

  it('handles text with mixed whitespace (spaces and tabs)', () => {
    const result = TabMail.getTokenParts(' \t ');
    expect(result).toEqual([' ', '\t', ' ']);
  });

  it('handles unicode accented characters as word tokens', () => {
    // Accented chars have code > 127, treated as word characters
    const result = TabMail.getTokenParts('cafe\u0301');
    expect(result).toEqual(['cafe\u0301']);
  });

  it('handles emoji characters as word tokens (code > 127)', () => {
    const result = TabMail.getTokenParts('hi there');
    // Emoji codepoints are > 127 so treated as word chars
    // "hi" = word, " " = space, "" = word (single codepoint > 127), " " = space, "there" = word
    expect(result.join('')).toBe('hi there');
    expect(result[0]).toBe('hi');
    expect(result[2]).toContain('');
  });

  it('handles hyphens as punctuation tokens', () => {
    const result = TabMail.getTokenParts('well-known');
    expect(result).toEqual(['well', '-', 'known']);
  });

  it('handles colons and semicolons', () => {
    const result = TabMail.getTokenParts('a:b;c');
    expect(result).toEqual(['a', ':', 'b', ';', 'c']);
  });

  it('handles at-sign and hash', () => {
    const result = TabMail.getTokenParts('@user #tag');
    expect(result).toEqual(['@', 'user', ' ', '#', 'tag']);
  });

  it('handles quotes', () => {
    const result = TabMail.getTokenParts('"hi"');
    expect(result).toEqual(['"', 'hi', '"']);
  });

  it('handles single character input', () => {
    expect(TabMail.getTokenParts('a')).toEqual(['a']);
    expect(TabMail.getTokenParts('.')).toEqual(['.']);
    expect(TabMail.getTokenParts('\n')).toEqual(['\n']);
  });

  it('concatenation reproduces original for complex text', () => {
    const text = 'Dear Mr. Smith,\n\nPlease see attached (v2.1).\n\nThanks!';
    const tokens = TabMail.getTokenParts(text);
    expect(tokens.join('')).toBe(text);
  });
});
