/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// historyFormatting.test.js — Tests for pure functions in prompts/modules/history.js

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  getAllKeys: vi.fn(async () => []),
}));

globalThis.browser = {
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => ({})) },
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const { _testExports } = await import('../prompts/modules/history.js');
const { formatSessionTime, escapeHtml, highlightSearchTerms } = _testExports;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ---------------------------------------------------------------------------
// formatSessionTime
// ---------------------------------------------------------------------------

describe('formatSessionTime', () => {
  it('returns "Today at HH:MM" for a timestamp from today', () => {
    // Use a timestamp just 1 minute ago to guarantee "today" regardless of timezone
    const ts = Date.now() - 60_000;
    const result = formatSessionTime(ts);
    expect(result).toMatch(/^Today at /);
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it('returns "Yesterday at HH:MM" for a timestamp from yesterday', () => {
    // Use 25 hours ago to guarantee "yesterday" regardless of timezone/midnight edge
    const ts = Date.now() - 25 * 60 * 60_000;
    const result = formatSessionTime(ts);
    expect(result).toMatch(/^Yesterday at /);
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it('returns weekday name for a timestamp from 3 days ago', () => {
    const threeDaysAgo = daysAgo(3);
    threeDaysAgo.setHours(9, 15, 0, 0);
    const result = formatSessionTime(threeDaysAgo.getTime());
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const expectedDay = dayNames[threeDaysAgo.getDay()];
    expect(result).toContain(expectedDay);
    expect(result).toContain(' at ');
  });

  it('returns "Mon DD at HH:MM" format for a timestamp from 2 weeks ago', () => {
    const twoWeeksAgo = daysAgo(14);
    twoWeeksAgo.setHours(16, 0, 0, 0);
    const result = formatSessionTime(twoWeeksAgo.getTime());
    // Should NOT start with a weekday or "Today"/"Yesterday"
    expect(result).not.toMatch(/^Today/);
    expect(result).not.toMatch(/^Yesterday/);
    expect(result).toContain(' at ');
    // Should contain short month and day number
    expect(result).toMatch(/[A-Z][a-z]{2}\s+\d{1,2}\s+at\s+/);
  });

  it('returns "Unknown" for null', () => {
    expect(formatSessionTime(null)).toBe('Unknown');
  });

  it('returns "Unknown" for undefined', () => {
    expect(formatSessionTime(undefined)).toBe('Unknown');
  });

  it('returns "Unknown" for 0', () => {
    expect(formatSessionTime(0)).toBe('Unknown');
  });

  it('handles a future timestamp without error', () => {
    const future = new Date();
    future.setDate(future.getDate() + 5);
    const result = formatSessionTime(future.getTime());
    // Should produce some string without throwing
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('a "b" c')).toBe('a &quot;b&quot; c');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("a 'b' c")).toBe('a &#039;b&#039; c');
  });

  it('escapes all 5 special chars together', () => {
    expect(escapeHtml('&<>"\''))
      .toBe('&amp;&lt;&gt;&quot;&#039;');
  });

  it('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('passes through text with no special chars', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });

  it('handles mixed content', () => {
    expect(escapeHtml('<script>alert("xss")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

// ---------------------------------------------------------------------------
// highlightSearchTerms
// ---------------------------------------------------------------------------

describe('highlightSearchTerms', () => {
  it('wraps a single matching term in highlight span', () => {
    const result = highlightSearchTerms('hello world', 'hello');
    expect(result).toContain('<span class="search-highlight">hello</span>');
    expect(result).toContain(' world');
  });

  it('wraps multiple terms separately', () => {
    const result = highlightSearchTerms('the quick brown fox', 'quick fox');
    expect(result).toContain('<span class="search-highlight">quick</span>');
    expect(result).toContain('<span class="search-highlight">fox</span>');
  });

  it('matches case-insensitively', () => {
    const result = highlightSearchTerms('Hello World', 'hello');
    expect(result).toContain('<span class="search-highlight">Hello</span>');
  });

  it('ignores short terms (< 2 chars)', () => {
    const result = highlightSearchTerms('a big deal', 'a big');
    // "a" should be ignored (length 1), "big" should be highlighted
    expect(result).toContain('<span class="search-highlight">big</span>');
    // The "a" should not be wrapped
    expect(result).not.toMatch(/<span class="search-highlight">a<\/span>/);
  });

  it('returns escaped text unchanged when no match', () => {
    const result = highlightSearchTerms('hello world', 'xyz');
    expect(result).toBe('hello world');
    expect(result).not.toContain('search-highlight');
  });

  it('returns escaped text for empty query', () => {
    const result = highlightSearchTerms('hello <world>', '');
    expect(result).toBe('hello &lt;world&gt;');
  });

  it('returns escaped text for null query', () => {
    const result = highlightSearchTerms('hello <world>', null);
    expect(result).toBe('hello &lt;world&gt;');
  });

  it('returns escaped text for null text', () => {
    const result = highlightSearchTerms(null, 'test');
    expect(result).toBe('');
  });

  it('returns empty string for empty text', () => {
    const result = highlightSearchTerms('', 'test');
    expect(result).toBe('');
  });

  it('handles special regex characters in query', () => {
    const result = highlightSearchTerms('price is $10.99 today', '$10.99');
    // The term should be escaped for regex and still match literally
    expect(result).toContain('search-highlight');
  });

  it('highlights multiple occurrences of the same term', () => {
    const result = highlightSearchTerms('cat and cat and cat', 'cat');
    const matches = result.match(/<span class="search-highlight">/g);
    expect(matches).toHaveLength(3);
  });

  it('escapes HTML in text before highlighting', () => {
    const result = highlightSearchTerms('<b>bold</b> text', 'bold');
    // The < and > should be escaped
    expect(result).toContain('&lt;b&gt;');
    expect(result).toContain('<span class="search-highlight">bold</span>');
  });
});

// ---------------------------------------------------------------------------
// highlightSearchTerms: the result shows the text exactly, each search word
// marked once, whatever the words match (#158)
// ---------------------------------------------------------------------------

const { document: parseDoc } = new JSDOM('').window;

/** The highlighted text as the page shows it: its text, and each mark's text. */
function rendered(html) {
  const box = parseDoc.createElement('div');
  box.innerHTML = html;
  const marks = [...box.children];
  return { box, text: box.textContent, marks };
}

/** The words the page marks: at least two characters (UTF-16 units), as typed. */
const wordsOf = (query) => query.split(/\s+/).filter((word) => word.length >= 2);
// A word as literal text, matched in any case as JavaScript matches it (so
// "ΣΣ" matches "σσ", though "ΣΣ".toLowerCase() is "σς").
const literal = (word, flags) => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
const isWord = (text, word) => new RegExp(`^(?:${literal(word, '').source})$`, 'i').test(text);

/**
 * What every highlight must hold:
 * - it shows `text` exactly, with no markup or entity name of its own;
 * - every element is a top-level highlight span holding one search word, in any case;
 * - no search word is left unmarked inside the unmarked text between the marks.
 */
function expectHighlighted(text, query) {
  const html = highlightSearchTerms(text, query);
  const { box, text: shown, marks } = rendered(html);
  expect(shown).toBe(text);
  const words = wordsOf(query);
  for (const mark of marks) {
    expect(mark.tagName).toBe('SPAN');
    expect([...mark.attributes].map((a) => [a.name, a.value])).toEqual([['class', 'search-highlight']]);
    expect(mark.children).toHaveLength(0);
    expect(words.some((word) => isWord(mark.textContent, word)), `${mark.textContent} is not one of ${words}`).toBe(true);
  }
  for (const node of box.childNodes) {
    if (node.nodeType !== 3) continue;
    for (const word of words) expect(literal(word, 'i').test(node.textContent), `${word} unmarked in ${node.textContent}`).toBe(false);
  }
  return marks.map((mark) => mark.textContent);
}

describe('highlightSearchTerms keeps its own markup whole (#158)', () => {
  it.each([
    ['Plan an event for Friday.', 'plan an event', ['Plan', 'an', 'event']],
    ['Ran a web search for flights.', 'web search', ['web', 'search']],
    ['Booked the flight as asked.', 'flight as', ['flight', 'as', 'as']],
    ['Bought chips & salsa.', 'chips amp', ['chips']],
    ['Wrote <draft> "notes" & \'ideas\'.', 'lt quot amp 039 draft', ['draft']],
    ['Asked the class to highlight a span.', 'span class search-highlight', ['class', 'span']],
    ['Typed <b>bold</b> & "quoted" text.', '<b>bold</b> &', ['<b>bold</b>']],
    // A query is literal text, never a pattern.
    ['[ab] a b [ab]', '[ab]', ['[ab]', '[ab]']],
    ['a.b axb a.b', 'a.b', ['a.b', 'a.b']],
    ['x+y xxy (z) z', 'x+y (z)', ['x+y', '(z)']],
    ['Is it on? Ask what? now', 'what? on?', ['on?', 'what?']],
    ['a*b ab aab a*b', 'a*b', ['a*b', 'a*b']],
    ['x|y x y x|y', 'x|y', ['x|y', 'x|y']],
    ['a{2} aa a{2}', 'a{2}', ['a{2}', 'a{2}']],
    // Entity names typed as text stay text, in the marks too.
    ['Typed &lt; and AT&T and &copy.', '&lt; AT&T &copy', ['&lt;', 'AT&T', '&copy']],
    ['$1 cost ^up | a\\b', '$1 ^up | a\\b', ['$1', '^up', 'a\\b']],
    // A word is two or more UTF-16 units, so one emoji is a word.
    ['\u{1F600} & \u{1F600}', '\u{1F600}', ['\u{1F600}', '\u{1F600}']],
    // Any case, as JavaScript matches it, and words differing only by case.
    ['\u03C3\u03C3', '\u03A3\u03A3', ['\u03C3\u03C3']],
    ['Plan PLAN plan', 'plan PLAN', ['Plan', 'PLAN', 'plan']],
  ])('%j searched for %j shows the text exactly and marks %j', (text, query, expected) => {
    expect(expectHighlighted(text, query)).toEqual(expected);
  });

  it('marks the longer word where two start at one place', () => {
    expect(expectHighlighted('Planning the trip.', 'plan planning')).toEqual(['Planning']);
    expect(expectHighlighted('Planning the trip.', 'planning plan')).toEqual(['Planning']);
  });

  it('shows any text exactly, for any search, over a seeded mix of markup-like words', () => {
    // A small seeded generator, so a failure reproduces.
    let seed = 0x9e3779b9;
    const next = () => {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 0x100000000;
    };
    const pick = (list) => list[Math.floor(next() * list.length)];
    const pieces = ['an', 'as', 'a', 'plan', 'span', 'class', 'search', 'highlight', 'amp', 'lt', 'gt', 'quot', '039',
      '&', '<', '>', '"', "'", ' ', ' ', '-', '=', '/', 'Web', 'AN', 'é', 'x', '[', ']', '.', '(', '\u{1F600}', '\u03A3', '\u03C3', '\u03C2'];
    for (let i = 0; i < 3000; i++) {
      const text = Array.from({ length: 1 + Math.floor(next() * 12) }, () => pick(pieces)).join('');
      // Words of one or two pieces, so some hold markup characters.
      const word = () => (pick(pieces) + (next() < 0.5 ? pick(pieces) : '')).trim() || 'an';
      const query = Array.from({ length: 1 + Math.floor(next() * 4) }, word).join(' ');
      expectHighlighted(text, query);
    }
  });
});
