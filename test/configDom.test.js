// configDom.test.js — Tests for config/modules/dom.js pure-logic functions
//
// Focuses on _extractEditableRegion (pure text parsing), with additional
// coverage for $() and saveScrollPosition() via DOM mocks.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal DOM globals required by dom.js at import time
// ---------------------------------------------------------------------------

globalThis.document = globalThis.document || {
  getElementById: vi.fn(() => null),
  documentElement: { scrollTop: 0, scrollLeft: 0 },
  body: { scrollTop: 0, scrollLeft: 0 },
};
globalThis.window = globalThis.window || {
  scrollY: 0,
  scrollX: 0,
  scrollTo: vi.fn(),
  requestAnimationFrame: vi.fn((cb) => cb()),
};

// ---------------------------------------------------------------------------
// Import after globals are in place
// ---------------------------------------------------------------------------

const { $, _extractEditableRegion, saveScrollPosition, restoreScrollPosition } =
  await import('../config/modules/dom.js');

// ---------------------------------------------------------------------------
// _extractEditableRegion
// ---------------------------------------------------------------------------
describe('_extractEditableRegion', () => {
  const BEGIN = '--- BEGIN EDITABLE ---';
  const END = '--- END EDITABLE ---';

  it('extracts region between begin and end markers', () => {
    const text = [
      'Header line',
      BEGIN,
      'editable content',
      END,
      'Footer line',
    ].join('\n');

    const result = _extractEditableRegion(text, BEGIN, END);
    expect(result.editable).toBe('editable content');
    expect(result.prefix).toBe(`Header line\n${BEGIN}`);
    expect(result.suffix).toBe(`${END}\nFooter line`);
  });

  it('falls back to full text when begin marker is missing', () => {
    const text = `Some text\n${END}\nMore text`;
    const result = _extractEditableRegion(text, BEGIN, END);
    expect(result.editable).toBe(text);
    expect(result.prefix).toBe('');
    expect(result.suffix).toBe('');
  });

  it('falls back to full text when end marker is missing', () => {
    const text = `Some text\n${BEGIN}\nMore text`;
    const result = _extractEditableRegion(text, BEGIN, END);
    expect(result.editable).toBe(text);
    expect(result.prefix).toBe('');
    expect(result.suffix).toBe('');
  });

  it('falls back to full text when both markers are missing', () => {
    const text = 'Just some plain text\nwith multiple lines';
    const result = _extractEditableRegion(text, BEGIN, END);
    expect(result.editable).toBe(text);
    expect(result.prefix).toBe('');
    expect(result.suffix).toBe('');
  });

  it('falls back to full text when end marker appears before begin marker', () => {
    const text = [
      'Header',
      END,
      'middle',
      BEGIN,
      'Footer',
    ].join('\n');

    const result = _extractEditableRegion(text, BEGIN, END);
    expect(result.editable).toBe(text);
    expect(result.prefix).toBe('');
    expect(result.suffix).toBe('');
  });

  it('returns empty editable for empty string input', () => {
    const result = _extractEditableRegion('', BEGIN, END);
    expect(result.editable).toBe('');
    expect(result.prefix).toBe('');
    expect(result.suffix).toBe('');
  });

  it('returns empty editable for null input', () => {
    const result = _extractEditableRegion(null, BEGIN, END);
    expect(result.editable).toBe('');
    expect(result.prefix).toBe('');
    expect(result.suffix).toBe('');
  });

  it('preserves internal newlines in multi-line editable region', () => {
    const text = [
      BEGIN,
      'line one',
      'line two',
      'line three',
      END,
    ].join('\n');

    const result = _extractEditableRegion(text, BEGIN, END);
    expect(result.editable).toBe('line one\nline two\nline three');
  });

  it('returns empty editable when markers are on consecutive lines', () => {
    const text = [
      'Header',
      BEGIN,
      END,
      'Footer',
    ].join('\n');

    const result = _extractEditableRegion(text, BEGIN, END);
    expect(result.editable).toBe('');
    expect(result.prefix).toBe(`Header\n${BEGIN}`);
    expect(result.suffix).toBe(`${END}\nFooter`);
  });

  it('splits prefix and suffix correctly with surrounding content', () => {
    const text = [
      'prefix line 1',
      'prefix line 2',
      BEGIN,
      'edit me',
      END,
      'suffix line 1',
      'suffix line 2',
    ].join('\n');

    const result = _extractEditableRegion(text, BEGIN, END);
    expect(result.prefix).toBe(`prefix line 1\nprefix line 2\n${BEGIN}`);
    expect(result.suffix).toBe(`${END}\nsuffix line 1\nsuffix line 2`);
    expect(result.editable).toBe('edit me');
  });

  it('handles Windows-style CRLF line endings', () => {
    const text = [
      'Header',
      BEGIN,
      'editable CRLF',
      END,
      'Footer',
    ].join('\r\n');

    const result = _extractEditableRegion(text, BEGIN, END);
    expect(result.editable).toBe('editable CRLF');
  });

  it('uses first occurrence when marker text appears multiple times', () => {
    const text = [
      BEGIN,
      'first region',
      END,
      'middle',
      BEGIN,
      'second region',
      END,
    ].join('\n');

    const result = _extractEditableRegion(text, BEGIN, END);
    // findIndex returns the FIRST match for both markers
    // begin=0, end=2 — so editable is line 1 only
    expect(result.editable).toBe('first region');
    expect(result.prefix).toBe(BEGIN);
    expect(result.suffix).toBe(`${END}\nmiddle\n${BEGIN}\nsecond region\n${END}`);
  });

  it('returns undefined input as empty via fallback', () => {
    const result = _extractEditableRegion(undefined, BEGIN, END);
    expect(result.editable).toBe('');
    expect(result.prefix).toBe('');
    expect(result.suffix).toBe('');
  });

  it('handles marker appearing as substring of a line', () => {
    // lines.findIndex uses l.includes(marker), so a line containing the
    // marker as a substring should still match
    const text = [
      'Header',
      `prefix ${BEGIN} suffix`,
      'editable content',
      `prefix ${END} suffix`,
      'Footer',
    ].join('\n');

    const result = _extractEditableRegion(text, BEGIN, END);
    expect(result.editable).toBe('editable content');
  });
});

// ---------------------------------------------------------------------------
// saveScrollPosition
// ---------------------------------------------------------------------------
describe('saveScrollPosition', () => {
  beforeEach(() => {
    globalThis.window.scrollY = 42;
    globalThis.window.scrollX = 10;
    globalThis.document.documentElement = { scrollTop: 42, scrollLeft: 10 };
    globalThis.document.body = { scrollTop: 42, scrollLeft: 10 };
  });

  it('captures all six scroll properties', () => {
    const pos = saveScrollPosition();
    expect(pos).toEqual({
      windowScrollY: 42,
      windowScrollX: 10,
      documentScrollTop: 42,
      documentScrollLeft: 10,
      bodyScrollTop: 42,
      bodyScrollLeft: 10,
    });
  });

  it('reflects updated scroll values', () => {
    globalThis.window.scrollY = 100;
    globalThis.window.scrollX = 50;
    globalThis.document.documentElement.scrollTop = 100;
    globalThis.document.documentElement.scrollLeft = 50;
    globalThis.document.body.scrollTop = 100;
    globalThis.document.body.scrollLeft = 50;

    const pos = saveScrollPosition();
    expect(pos.windowScrollY).toBe(100);
    expect(pos.windowScrollX).toBe(50);
    expect(pos.documentScrollTop).toBe(100);
    expect(pos.documentScrollLeft).toBe(50);
    expect(pos.bodyScrollTop).toBe(100);
    expect(pos.bodyScrollLeft).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// $
// ---------------------------------------------------------------------------
describe('$', () => {
  beforeEach(() => {
    globalThis.document.getElementById = vi.fn((id) => ({ id }));
  });

  it('delegates to document.getElementById', () => {
    const result = $('my-element');
    expect(globalThis.document.getElementById).toHaveBeenCalledWith('my-element');
    expect(result).toEqual({ id: 'my-element' });
  });

  it('returns null when element does not exist', () => {
    globalThis.document.getElementById = vi.fn(() => null);
    expect($('nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// restoreScrollPosition
// ---------------------------------------------------------------------------
describe('restoreScrollPosition', () => {
  beforeEach(() => {
    globalThis.window.scrollTo = vi.fn();
    globalThis.window.requestAnimationFrame = vi.fn((cb) => cb());
    globalThis.requestAnimationFrame = vi.fn((cb) => cb());
    globalThis.document.documentElement = { scrollTop: 0, scrollLeft: 0 };
    globalThis.document.body = { scrollTop: 0, scrollLeft: 0 };
  });

  it('does nothing when scrollPos is null', () => {
    restoreScrollPosition(null);
    expect(globalThis.window.scrollTo).not.toHaveBeenCalled();
  });

  it('does nothing when scrollPos is undefined', () => {
    restoreScrollPosition(undefined);
    expect(globalThis.window.scrollTo).not.toHaveBeenCalled();
  });

  it('restores window scroll position via scrollTo', () => {
    restoreScrollPosition({ windowScrollY: 200, windowScrollX: 50 });
    expect(globalThis.window.scrollTo).toHaveBeenCalledWith(50, 200);
  });

  it('restores documentElement scroll position', () => {
    restoreScrollPosition({ documentScrollTop: 300, documentScrollLeft: 25 });
    expect(globalThis.document.documentElement.scrollTop).toBe(300);
    expect(globalThis.document.documentElement.scrollLeft).toBe(25);
  });

  it('restores body scroll position', () => {
    restoreScrollPosition({ bodyScrollTop: 400, bodyScrollLeft: 15 });
    expect(globalThis.document.body.scrollTop).toBe(400);
    expect(globalThis.document.body.scrollLeft).toBe(15);
  });
});
