/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// bodyExtract.test.js — Tests for fts/bodyExtract.js
//
// Tests the extractPlainText function which extracts plain text from MIME parts.
// Extraction is HTML-first (mirrors iOS EmailFilter.extractPlainText): prefer the
// stripped text/html part; fall back to text/plain with an HTML-document guard
// against senders that put raw HTML inside the text/plain part.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

const { extractPlainText } = await import('../fts/bodyExtract.js');

// ---------------------------------------------------------------------------
// extractPlainText
// ---------------------------------------------------------------------------
describe('extractPlainText', () => {
  // stripHtml (utils.js) needs DOMParser; set up a minimal mock for the Node
  // environment (same pattern as the stripHtml block in utils.test.js).
  let _origNode;

  beforeEach(() => {
    // Save original Node (Node.js stream class) to avoid breaking vitest internals
    _origNode = globalThis.Node;

    function createTextNode(text) {
      return { nodeType: 3, textContent: text, childNodes: [] };
    }
    function createElement(tag, children = [], textContent = '') {
      const childNodes = [...children];
      if (textContent) {
        childNodes.push(createTextNode(textContent));
      }
      return {
        nodeType: 1,
        tagName: tag.toUpperCase(),
        childNodes,
        textContent: textContent || childNodes.map(c => c.textContent || '').join(''),
      };
    }

    const nodeConstants = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    globalThis.Node = Object.assign(function Node() {}, nodeConstants);

    globalThis.DOMParser = class {
      parseFromString(html, _type) {
        // Very simplified HTML parser for testing — handles basic cases
        const stripped = html
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n')
          .replace(/<\/div>/gi, '\n')
          .replace(/<[^>]+>/g, '');
        const body = createElement('BODY', [createTextNode(stripped)]);
        return { body };
      }
    };
  });

  afterEach(() => {
    if (_origNode !== undefined) {
      globalThis.Node = _origNode;
    } else {
      delete globalThis.Node;
    }
    delete globalThis.DOMParser;
  });

  it('extracts text/plain body from a simple message', async () => {
    const full = {
      contentType: 'text/plain',
      body: 'Hello, world!',
    };
    const result = await extractPlainText(full, 1);
    expect(result).toBe('Hello, world!');
  });

  it('prefers stripped text/html over text/plain in multipart', async () => {
    const full = {
      contentType: 'multipart/alternative',
      parts: [
        { contentType: 'text/plain', body: 'Plain text version' },
        { contentType: 'text/html', body: '<p>HTML version</p>' },
      ],
    };
    const result = await extractPlainText(full, 2);
    expect(result).toBe('HTML version');
  });

  it('strips HTML when no text/plain exists', async () => {
    const full = {
      contentType: 'text/html',
      body: '<p>Hello</p>',
    };
    const result = await extractPlainText(full, 3);
    expect(result).toBe('Hello');
  });

  it('returns empty string for null input', async () => {
    const result = await extractPlainText(null, 4);
    expect(result).toBe('');
  });

  it('returns empty string when no text parts exist', async () => {
    const full = {
      contentType: 'multipart/mixed',
      parts: [
        { contentType: 'image/png', body: 'binary data' },
      ],
    };
    const result = await extractPlainText(full, 5);
    expect(result).toBe('');
  });

  it('concatenates multiple text/plain parts', async () => {
    const full = {
      contentType: 'multipart/mixed',
      parts: [
        { contentType: 'text/plain', body: 'Part 1' },
        { contentType: 'text/plain', body: 'Part 2' },
      ],
    };
    const result = await extractPlainText(full, 6);
    expect(result).toBe('Part 1\nPart 2');
  });

  it('handles deeply nested parts', async () => {
    const full = {
      contentType: 'multipart/mixed',
      parts: [
        {
          contentType: 'multipart/alternative',
          parts: [
            { contentType: 'text/plain', body: 'Deep text' },
          ],
        },
      ],
    };
    const result = await extractPlainText(full, 7);
    expect(result).toBe('Deep text');
  });

  it('skips non-text content types', async () => {
    const full = {
      contentType: 'multipart/mixed',
      parts: [
        { contentType: 'application/pdf', body: 'pdf data' },
        { contentType: 'text/plain', body: 'Actual text' },
      ],
    };
    const result = await extractPlainText(full, 8);
    expect(result).toBe('Actual text');
  });

  it('handles parts with no body', async () => {
    const full = {
      contentType: 'text/plain',
      // body is undefined
    };
    const result = await extractPlainText(full, 9);
    expect(result).toBe('');
  });

  // -------------------------------------------------------------------------
  // HTML-first preference + HTML-document guard (mislabeled text/plain)
  // -------------------------------------------------------------------------

  it('uses HTML part when text/plain contains a raw HTML document (malformed sender)', async () => {
    // Real-world case: survey sender put the full HTML document in BOTH parts.
    const htmlDoc = '<!DOCTYPE html>\n<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office">'
      + '<head><style type="text/css">body { margin: 0; }</style></head>'
      + '<body><p>Dear Customer,</p><p>Thank you for your purchase!</p></body></html>';
    const full = {
      contentType: 'multipart/alternative',
      parts: [
        { contentType: 'text/plain', body: htmlDoc },
        { contentType: 'text/html', body: htmlDoc },
      ],
    };
    const result = await extractPlainText(full, 10);
    expect(result).toContain('Dear Customer,');
    expect(result).toContain('Thank you for your purchase!');
    expect(result).not.toContain('<');
  });

  it('strips mislabeled HTML in text/plain when no HTML part exists (DOCTYPE marker)', async () => {
    const full = {
      contentType: 'text/plain',
      body: '<!DOCTYPE html><html><body><p>Mislabeled content</p></body></html>',
    };
    const result = await extractPlainText(full, 11);
    expect(result).toContain('Mislabeled content');
    expect(result).not.toContain('<');
  });

  it('strips mislabeled HTML in text/plain when no HTML part exists (<html> marker)', async () => {
    const full = {
      contentType: 'text/plain',
      body: '  <html lang="en"><body>Bare html element</body></html>',
    };
    const result = await extractPlainText(full, 12);
    expect(result).toContain('Bare html element');
    expect(result).not.toContain('<');
  });

  it('strips HTML stored in an FTS-synthetic full (polluted index entry)', async () => {
    // safeGetFull's native-FTS hit shape: single text/plain node, parts: [].
    const full = {
      __tmSynthetic: true,
      __tmSource: 'nativeFts',
      contentType: 'text/plain',
      body: '<!DOCTYPE html>\n<html><body><div>Indexed before the fix</div></body></html>',
      parts: [],
    };
    const result = await extractPlainText(full, 13);
    expect(result).toContain('Indexed before the fix');
    expect(result).not.toContain('<');
  });

  it('does NOT strip genuine plain text containing angle brackets', async () => {
    const body = 'Kwang <kwang@example.com> wrote:\nUse List<String> when x < 10.';
    const full = {
      contentType: 'multipart/alternative',
      parts: [
        { contentType: 'text/plain', body },
      ],
    };
    const result = await extractPlainText(full, 14);
    expect(result).toBe(body);
  });

  it('falls back to text/plain when the HTML part strips to blank', async () => {
    const full = {
      contentType: 'multipart/alternative',
      parts: [
        { contentType: 'text/plain', body: 'Plain content' },
        { contentType: 'text/html', body: '<img src="cid:logo">' },
      ],
    };
    const result = await extractPlainText(full, 15);
    expect(result).toBe('Plain content');
  });

  it('uses HTML part when text/plain is whitespace-only (1-char stub servers)', async () => {
    const full = {
      contentType: 'multipart/alternative',
      parts: [
        { contentType: 'text/plain', body: ' ' },
        { contentType: 'text/html', body: '<p>Real content</p>' },
      ],
    };
    const result = await extractPlainText(full, 16);
    expect(result).toBe('Real content');
  });
});
