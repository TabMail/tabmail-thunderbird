// webReadRobots.test.js — Tests for isPathAllowedByRobots in chat/tools/web_read.js

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis mocks (web_read.js uses browser.tmWebFetch)
// ---------------------------------------------------------------------------
globalThis.browser = {
  tmWebFetch: { fetch: vi.fn() },
};

// DOMParser mock (web_read.js imports it for HTML extraction)
globalThis.DOMParser = class {
  parseFromString(html) {
    return { body: { textContent: '' }, querySelectorAll: () => ({ forEach: () => {} }) };
  }
};

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

const { _testIsPathAllowedByRobots: isPathAllowedByRobots } = await import('../chat/tools/web_read.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isPathAllowedByRobots', () => {
  it('should allow all paths when robots.txt is empty', () => {
    expect(isPathAllowedByRobots('', '/anything')).toBe(true);
    expect(isPathAllowedByRobots('', '/deep/nested/path')).toBe(true);
  });

  it('should allow all paths when robots.txt has only comments', () => {
    const robotsTxt = '# This is a comment\n# Another comment';
    expect(isPathAllowedByRobots(robotsTxt, '/anything')).toBe(true);
  });

  it('should disallow a specific path', () => {
    const robotsTxt = 'User-agent: *\nDisallow: /secret/';
    expect(isPathAllowedByRobots(robotsTxt, '/secret/page')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/secret/')).toBe(false);
  });

  it('should allow a path not matched by disallow rules', () => {
    const robotsTxt = 'User-agent: *\nDisallow: /secret/';
    expect(isPathAllowedByRobots(robotsTxt, '/public/page')).toBe(true);
    expect(isPathAllowedByRobots(robotsTxt, '/')).toBe(true);
  });

  it('should handle allow rules taking precedence over disallow', () => {
    const robotsTxt = 'User-agent: *\nAllow: /secret/public\nDisallow: /secret/';
    expect(isPathAllowedByRobots(robotsTxt, '/secret/public')).toBe(true);
    expect(isPathAllowedByRobots(robotsTxt, '/secret/private')).toBe(false);
  });

  it('should match wildcard user-agent by default', () => {
    const robotsTxt = 'User-agent: *\nDisallow: /admin/';
    expect(isPathAllowedByRobots(robotsTxt, '/admin/', '*')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/admin/')).toBe(false);
  });

  it('should match specific user-agent', () => {
    const robotsTxt = 'User-agent: TabMail\nDisallow: /blocked/';
    expect(isPathAllowedByRobots(robotsTxt, '/blocked/', 'TabMail')).toBe(false);
  });

  it('should apply wildcard rules to specific user-agents too', () => {
    const robotsTxt = 'User-agent: *\nDisallow: /private/';
    expect(isPathAllowedByRobots(robotsTxt, '/private/', 'SomeBot')).toBe(false);
  });

  it('should handle multiple disallow rules', () => {
    const robotsTxt = 'User-agent: *\nDisallow: /admin/\nDisallow: /secret/\nDisallow: /tmp/';
    expect(isPathAllowedByRobots(robotsTxt, '/admin/panel')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/secret/data')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/tmp/file')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/public/')).toBe(true);
  });

  it('should disallow all paths when Disallow: /', () => {
    const robotsTxt = 'User-agent: *\nDisallow: /';
    expect(isPathAllowedByRobots(robotsTxt, '/')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/anything')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/deep/nested/path')).toBe(false);
  });

  it('should use path prefix matching for disallow rules', () => {
    const robotsTxt = 'User-agent: *\nDisallow: /api';
    expect(isPathAllowedByRobots(robotsTxt, '/api')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/api/v1')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/api-docs')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/about')).toBe(true);
  });

  it('should treat path matching as case-sensitive', () => {
    const robotsTxt = 'User-agent: *\nDisallow: /Admin/';
    expect(isPathAllowedByRobots(robotsTxt, '/Admin/')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/admin/')).toBe(true);
  });

  it('should handle user-agent directive case-insensitively', () => {
    const robotsTxt = 'user-agent: *\ndisallow: /hidden/';
    expect(isPathAllowedByRobots(robotsTxt, '/hidden/page')).toBe(false);
  });

  it('should return true for null robots.txt (parse error recovery)', () => {
    // The function catches errors and returns true
    expect(isPathAllowedByRobots(null, '/anything')).toBe(true);
  });

  it('should return true for undefined robots.txt (parse error recovery)', () => {
    expect(isPathAllowedByRobots(undefined, '/anything')).toBe(true);
  });

  it('should handle empty disallow value (allow all)', () => {
    const robotsTxt = 'User-agent: *\nDisallow:';
    expect(isPathAllowedByRobots(robotsTxt, '/anything')).toBe(true);
  });

  it('should skip blank lines and handle mixed whitespace', () => {
    const robotsTxt = 'User-agent: *\n\n  Disallow: /blocked/  \n\n';
    expect(isPathAllowedByRobots(robotsTxt, '/blocked/page')).toBe(false);
    expect(isPathAllowedByRobots(robotsTxt, '/open/')).toBe(true);
  });

  it('should handle robots.txt with only Allow rules', () => {
    const robotsTxt = 'User-agent: *\nAllow: /public/';
    expect(isPathAllowedByRobots(robotsTxt, '/public/page')).toBe(true);
    expect(isPathAllowedByRobots(robotsTxt, '/other/')).toBe(true);
  });
});
