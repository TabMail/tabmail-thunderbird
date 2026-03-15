// helpers.test.js — Tests for chat/modules/helpers.js (pure functions)

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — helpers.js imports from several modules
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {},
}));
vi.mock('../chat/modules/context.js', () => ({
  ctx: {},
}));
vi.mock('../chat/modules/markdown.js', () => ({
  renderMarkdown: vi.fn((text) => text),
  attachSpecialLinkListeners: vi.fn(),
}));

globalThis.browser = {
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: {
    getURL: vi.fn((p) => `moz-extension://fake/${p}`),
  },
};

const { toIsoNoMs, extractPlainTextFromHtml } = await import('../chat/modules/helpers.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('toIsoNoMs', () => {
  it('removes milliseconds from ISO string', () => {
    const d = new Date('2026-03-14T10:30:00.123Z');
    expect(toIsoNoMs(d)).toBe('2026-03-14T10:30:00Z');
  });

  it('handles zero milliseconds', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(toIsoNoMs(d)).toBe('2026-01-01T00:00:00Z');
  });

  it('defaults to current time', () => {
    const result = toIsoNoMs();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('extractPlainTextFromHtml', () => {
  it('returns empty string for falsy input', () => {
    expect(extractPlainTextFromHtml('')).toBe('');
    expect(extractPlainTextFromHtml(null)).toBe('');
    expect(extractPlainTextFromHtml(undefined)).toBe('');
  });

  it('strips HTML tags', () => {
    const result = extractPlainTextFromHtml('<p>Hello <b>World</b></p>');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
    expect(result).not.toContain('<p>');
    expect(result).not.toContain('<b>');
  });

  it('converts <br> to newlines', () => {
    const result = extractPlainTextFromHtml('Line 1<br>Line 2');
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
  });

  it('decodes HTML entities', () => {
    const result = extractPlainTextFromHtml('&amp; &lt; &gt; &quot; &#39;');
    expect(result).toContain('&');
    expect(result).toContain('<');
    expect(result).toContain('>');
    expect(result).toContain('"');
    expect(result).toContain("'");
  });

  it('converts &nbsp; to space', () => {
    const result = extractPlainTextFromHtml('Hello&nbsp;World');
    expect(result).toContain('Hello World');
  });

  it('strips buttons', () => {
    const result = extractPlainTextFromHtml('<button>Click me</button>Text');
    expect(result).toContain('Text');
    expect(result).not.toContain('Click me');
  });

  it('handles blockquotes as > prefixed lines', () => {
    const result = extractPlainTextFromHtml('<blockquote>Quoted text</blockquote>');
    expect(result).toContain('> Quoted text');
  });

  it('handles horizontal rules', () => {
    const result = extractPlainTextFromHtml('Before<hr>After');
    expect(result).toContain('---');
  });

  it('extracts text from special links with type prefix', () => {
    const result = extractPlainTextFromHtml('<a class="tm-email-link" href="#">Test Subject</a>');
    expect(result).toContain('[Email: Test Subject]');
  });

  it('handles table cells with pipes', () => {
    const result = extractPlainTextFromHtml('<tr><td>Cell1</td><td>Cell2</td></tr>');
    expect(result).toContain('Cell1');
    expect(result).toContain('Cell2');
  });

  it('removes control characters', () => {
    const result = extractPlainTextFromHtml('Hello\x00\x01World');
    expect(result).toBe('HelloWorld');
  });
});
