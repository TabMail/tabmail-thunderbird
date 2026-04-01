// historyFormatting.test.js — Tests for pure functions in prompts/modules/history.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
