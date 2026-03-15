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
});
