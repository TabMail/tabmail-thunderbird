// webRead.test.js — Tests for chat/tools/web_read.js
//
// Tests URL validation, robots.txt parsing, content extraction, and run().

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis mocks
// ---------------------------------------------------------------------------
globalThis.browser = {
  tmWebFetch: {
    fetch: vi.fn(async (url, options) => {
      if (url.endsWith('/robots.txt')) {
        return { status: 200, statusText: 'OK', responseText: '', contentType: 'text/plain' };
      }
      return {
        status: 200,
        statusText: 'OK',
        responseText: '<html><body>Hello World</body></html>',
        contentType: 'text/html',
      };
    }),
  },
};

// DOMParser mock for extractTextFromHTML
class MockDocument {
  constructor() {
    this.body = { textContent: '' };
    this._elements = [];
  }
  querySelectorAll() { return { forEach: () => {} }; }
}

globalThis.DOMParser = class {
  parseFromString(html) {
    const doc = new MockDocument();
    // Simple text extraction
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    doc.body.textContent = text;
    return doc;
  }
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { run } from '../chat/tools/web_read.js';

describe('web_read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default fetch mock
    browser.tmWebFetch.fetch.mockImplementation(async (url) => {
      if (url.endsWith('/robots.txt')) {
        return { status: 200, statusText: 'OK', responseText: '', contentType: 'text/plain' };
      }
      return {
        status: 200,
        statusText: 'OK',
        responseText: '<html><body><p>Hello World</p></body></html>',
        contentType: 'text/html',
      };
    });
  });

  // --- URL validation ---
  describe('URL validation', () => {
    it('should return error for missing url', async () => {
      const result = await run({});
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('url') }));
    });

    it('should return error for null url', async () => {
      const result = await run({ url: null });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('url') }));
    });

    it('should return error for non-string url', async () => {
      const result = await run({ url: 42 });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('url') }));
    });

    it('should return error for invalid URL format', async () => {
      const result = await run({ url: 'not-a-url' });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('Invalid URL') }));
    });

    it('should return error for non-http protocol', async () => {
      const result = await run({ url: 'ftp://example.com' });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('http') }));
    });

    it('should accept http:// URLs', async () => {
      const result = await run({ url: 'http://example.com/page' });
      expect(typeof result).toBe('string');
      expect(result).toContain('URL: http://example.com/page');
    });

    it('should accept https:// URLs', async () => {
      const result = await run({ url: 'https://example.com/page' });
      expect(typeof result).toBe('string');
    });
  });

  // --- robots.txt ---
  describe('robots.txt checking', () => {
    it('should allow when robots.txt returns 404', async () => {
      browser.tmWebFetch.fetch.mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return { status: 404, statusText: 'Not Found', responseText: '', contentType: 'text/plain' };
        }
        return { status: 200, statusText: 'OK', responseText: 'Content', contentType: 'text/plain' };
      });
      const result = await run({ url: 'https://example.com/page' });
      expect(typeof result).toBe('string');
    });

    it('should block when robots.txt disallows path', async () => {
      browser.tmWebFetch.fetch.mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return {
            status: 200,
            statusText: 'OK',
            responseText: 'User-agent: *\nDisallow: /secret/',
            contentType: 'text/plain',
          };
        }
        return { status: 200, statusText: 'OK', responseText: 'Content', contentType: 'text/plain' };
      });
      const result = await run({ url: 'https://example.com/secret/page' });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('robots.txt') }));
    });

    it('should allow when path not disallowed', async () => {
      browser.tmWebFetch.fetch.mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return {
            status: 200,
            statusText: 'OK',
            responseText: 'User-agent: *\nDisallow: /secret/',
            contentType: 'text/plain',
          };
        }
        return { status: 200, statusText: 'OK', responseText: 'Public content', contentType: 'text/plain' };
      });
      const result = await run({ url: 'https://example.com/public/page' });
      expect(typeof result).toBe('string');
    });

    it('should allow when allow rule matches before disallow', async () => {
      browser.tmWebFetch.fetch.mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return {
            status: 200,
            statusText: 'OK',
            responseText: 'User-agent: *\nAllow: /secret/public\nDisallow: /secret/',
            contentType: 'text/plain',
          };
        }
        return { status: 200, statusText: 'OK', responseText: 'Content', contentType: 'text/plain' };
      });
      const result = await run({ url: 'https://example.com/secret/public' });
      expect(typeof result).toBe('string');
    });
  });

  // --- HTTP errors ---
  describe('HTTP error handling', () => {
    it('should return error for HTTP 500', async () => {
      browser.tmWebFetch.fetch.mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return { status: 404, statusText: 'Not Found', responseText: '', contentType: 'text/plain' };
        }
        return { status: 500, statusText: 'Internal Server Error', responseText: '', contentType: 'text/html' };
      });
      const result = await run({ url: 'https://example.com/error' });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('500') }));
    });

    it('should return error for fetch failure', async () => {
      browser.tmWebFetch.fetch.mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return { status: 404, statusText: 'Not Found', responseText: '', contentType: 'text/plain' };
        }
        throw new Error('Network error');
      });
      const result = await run({ url: 'https://example.com/fail' });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('fetch') }));
    });

    it('should return error for network error response', async () => {
      browser.tmWebFetch.fetch.mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return { status: 404, statusText: 'Not Found', responseText: '', contentType: 'text/plain' };
        }
        return { error: true, errorMessage: 'DNS resolution failed' };
      });
      const result = await run({ url: 'https://example.com/fail' });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('DNS') }));
    });
  });

  // --- Content extraction ---
  describe('content handling', () => {
    it('should include URL and content type in output', async () => {
      const result = await run({ url: 'https://example.com/page' });
      expect(result).toContain('URL: https://example.com/page');
      expect(result).toContain('Content-Type:');
    });

    it('should return plain text for non-HTML content', async () => {
      browser.tmWebFetch.fetch.mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return { status: 404, statusText: 'Not Found', responseText: '', contentType: 'text/plain' };
        }
        return { status: 200, statusText: 'OK', responseText: 'Just plain text', contentType: 'text/plain' };
      });
      const result = await run({ url: 'https://example.com/text' });
      expect(result).toContain('Just plain text');
    });

    it('should extract text from HTML content', async () => {
      const result = await run({ url: 'https://example.com/page' });
      expect(result).toContain('Hello World');
    });

    it('should truncate content exceeding max length', async () => {
      const longContent = 'x'.repeat(600000);
      browser.tmWebFetch.fetch.mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return { status: 404, statusText: 'Not Found', responseText: '', contentType: 'text/plain' };
        }
        return { status: 200, statusText: 'OK', responseText: longContent, contentType: 'text/plain' };
      });
      const result = await run({ url: 'https://example.com/big' });
      expect(typeof result).toBe('string');
      // Content should be truncated to 500000 chars
      expect(result).toContain('Content-Length:');
    });
  });
});
