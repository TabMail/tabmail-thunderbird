// bodyExtract.test.js — Tests for fts/bodyExtract.js
//
// Tests the extractPlainText function which extracts plain text from MIME parts.

import { describe, it, expect, vi } from 'vitest';

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
  it('extracts text/plain body from a simple message', async () => {
    const full = {
      contentType: 'text/plain',
      body: 'Hello, world!',
    };
    const result = await extractPlainText(full, 1);
    expect(result).toBe('Hello, world!');
  });

  it('extracts text/plain from nested multipart', async () => {
    const full = {
      contentType: 'multipart/alternative',
      parts: [
        { contentType: 'text/plain', body: 'Plain text version' },
        { contentType: 'text/html', body: '<p>HTML version</p>' },
      ],
    };
    const result = await extractPlainText(full, 2);
    expect(result).toBe('Plain text version');
  });

  it('falls back to stripping HTML when no text/plain', async () => {
    const full = {
      contentType: 'text/html',
      body: '<p>Hello</p>',
    };
    const result = await extractPlainText(full, 3);
    // stripHtml should produce something from the HTML
    expect(typeof result).toBe('string');
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
});
