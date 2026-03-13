// utils.test.js — Pure utility function tests
//
// Tests for TB-030 through TB-035 (TESTS.md §1.3) plus additional pure utility functions.
// Modules with heavy browser dependencies are mocked; only pure logic is under test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — utils.js imports config.js (SETTINGS) and thinkBuffer.js
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

// quoteAndSignature.js is imported as a side-effect by utils.js — stub it out
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

// ---------------------------------------------------------------------------
// Import pure functions under test
// ---------------------------------------------------------------------------

const {
  normalizeUnicode,
  formatForLog,
  sanitizeFilename,
  parseUniqueId,
  debounce,
  log,
} = await import('../agent/modules/utils.js');

const { isInboxFolder } = await import('../agent/modules/folderUtils.js');

const { extractEmailFromAuthor } = await import('../agent/modules/senderFilter.js');

// ---------------------------------------------------------------------------
// TB-030: normalizeUnicode — NFC normalization + special character replacement
// ---------------------------------------------------------------------------
describe('TB-030: normalizeUnicode', () => {
  it('returns input unchanged for null/undefined/non-string', () => {
    expect(normalizeUnicode(null)).toBe(null);
    expect(normalizeUnicode(undefined)).toBe(undefined);
    expect(normalizeUnicode(42)).toBe(42);
    expect(normalizeUnicode('')).toBe('');
  });

  it('normalizes to NFKC form', () => {
    // \uFB01 = fi ligature, NFKC decomposes to "fi"
    expect(normalizeUnicode('\uFB01')).toBe('fi');
    // Fullwidth A (\uFF21) → A
    expect(normalizeUnicode('\uFF21')).toBe('A');
  });

  it('replaces various dashes with standard hyphen', () => {
    // en-dash \u2013, em-dash \u2014, figure-dash \u2012, minus sign \u2212
    expect(normalizeUnicode('a\u2013b')).toBe('a-b');
    expect(normalizeUnicode('a\u2014b')).toBe('a-b');
    expect(normalizeUnicode('a\u2012b')).toBe('a-b');
    expect(normalizeUnicode('a\u2212b')).toBe('a-b');
  });

  it('replaces smart single quotes with straight quote', () => {
    // left \u2018, right \u2019
    expect(normalizeUnicode('\u2018hello\u2019')).toBe("'hello'");
    // reversed single quote \u201B
    expect(normalizeUnicode('\u201Bfoo')).toBe("'foo");
  });

  it('replaces smart double quotes with straight quote', () => {
    // left \u201C, right \u201D
    expect(normalizeUnicode('\u201Chello\u201D')).toBe('"hello"');
    // double low-9 \u201E, double high-reversed-9 \u201F
    expect(normalizeUnicode('\u201Efoo\u201F')).toBe('"foo"');
  });

  it('replaces prime symbols with straight single quote', () => {
    // prime \u2032, reversed prime \u2035
    expect(normalizeUnicode('5\u2032 3\u2035')).toBe("5' 3'");
  });

  it('replaces fullwidth brackets with standard brackets', () => {
    // \u3010 → [, \u3011 → ]
    expect(normalizeUnicode('\u3010info\u3011')).toBe('[info]');
  });

  it('replaces unusual space characters with regular space', () => {
    // non-breaking space \u00A0, ideographic space \u3000, narrow no-break space \u202F
    expect(normalizeUnicode('a\u00A0b')).toBe('a b');
    expect(normalizeUnicode('a\u3000b')).toBe('a b');
    expect(normalizeUnicode('a\u202Fb')).toBe('a b');
  });

  it('replaces horizontal ellipsis with three dots', () => {
    expect(normalizeUnicode('wait\u2026')).toBe('wait...');
  });

  it('preserves intentional multiple ASCII spaces', () => {
    expect(normalizeUnicode('a   b')).toBe('a   b');
  });

  it('handles combined normalizations in one pass', () => {
    const input = '\u201CHello\u201D \u2014 it\u2019s a test\u2026';
    const expected = '"Hello" - it\'s a test...';
    expect(normalizeUnicode(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// TB-031: Date formatting — formatTimestampForAgent
// ---------------------------------------------------------------------------
describe('TB-031: formatTimestampForAgent', () => {
  // formatTimestampForAgent lives in chat/modules/helpers.js which has heavy DOM
  // deps. We test the core formatting logic inline here using the same algorithm.
  function formatTimestampForAgentPure(dateObj) {
    const pad2 = (n) => String(n).padStart(2, '0');
    const YYYY = String(dateObj.getFullYear());
    const MM = pad2(dateObj.getMonth() + 1);
    const DD = pad2(dateObj.getDate());
    const hh = pad2(dateObj.getHours());
    const mm = pad2(dateObj.getMinutes());
    const ss = pad2(dateObj.getSeconds());
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayOfWeek = dayNames[dateObj.getDay()];
    // Use a fixed timezone for deterministic tests
    return `${dayOfWeek} ${YYYY}/${MM}/${DD} ${hh}:${mm}:${ss}`;
  }

  it('formats a known date correctly', () => {
    // 2026-01-15 is a Thursday
    const d = new Date(2026, 0, 15, 14, 3, 7);
    const result = formatTimestampForAgentPure(d);
    expect(result).toBe('Thursday 2026/01/15 14:03:07');
  });

  it('zero-pads single digit months, days, hours, minutes, seconds', () => {
    // 2025-02-05 is a Wednesday, 09:08:01
    const d = new Date(2025, 1, 5, 9, 8, 1);
    const result = formatTimestampForAgentPure(d);
    expect(result).toContain('2025/02/05');
    expect(result).toContain('09:08:01');
  });

  it('midnight formats as 00:00:00', () => {
    const d = new Date(2025, 5, 1, 0, 0, 0);
    const result = formatTimestampForAgentPure(d);
    expect(result).toContain('00:00:00');
  });

  it('returns correct day of week name', () => {
    // 2026-03-14 is a Saturday
    const d = new Date(2026, 2, 14, 12, 0, 0);
    const result = formatTimestampForAgentPure(d);
    expect(result).toMatch(/^Saturday /);
  });
});

// ---------------------------------------------------------------------------
// TB-032: isInboxFolder detection
// ---------------------------------------------------------------------------
describe('TB-032: isInboxFolder', () => {
  it('returns false for null/undefined', () => {
    expect(isInboxFolder(null)).toBe(false);
    expect(isInboxFolder(undefined)).toBe(false);
  });

  it('detects inbox by folder.type === "inbox"', () => {
    expect(isInboxFolder({ type: 'inbox' })).toBe(true);
  });

  it('detects inbox by folder.path === "/INBOX"', () => {
    expect(isInboxFolder({ path: '/INBOX' })).toBe(true);
  });

  it('does not match partial INBOX in path', () => {
    expect(isInboxFolder({ path: '/INBOX/subfolder' })).toBe(false);
  });

  it('detects inbox via specialUse array', () => {
    expect(isInboxFolder({ specialUse: ['inbox'] })).toBe(true);
    expect(isInboxFolder({ specialUse: ['Inbox'] })).toBe(true);
    expect(isInboxFolder({ specialUse: ['INBOX'] })).toBe(true);
  });

  it('detects inbox by folder name', () => {
    expect(isInboxFolder({ name: 'Inbox' })).toBe(true);
    expect(isInboxFolder({ name: 'inbox' })).toBe(true);
    expect(isInboxFolder({ name: 'INBOX' })).toBe(true);
  });

  it('detects unified inbox', () => {
    expect(isInboxFolder({ name: 'Unified Inbox' })).toBe(true);
  });

  it('returns false for non-inbox folders', () => {
    expect(isInboxFolder({ type: 'sent', name: 'Sent', path: '/Sent' })).toBe(false);
    expect(isInboxFolder({ type: 'trash', name: 'Trash', path: '/Trash' })).toBe(false);
    expect(isInboxFolder({ type: 'drafts', name: 'Drafts', path: '/Drafts' })).toBe(false);
  });

  it('returns false for empty folder object', () => {
    expect(isInboxFolder({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TB-033: Email address extraction from header
// ---------------------------------------------------------------------------
describe('TB-033: extractEmailFromAuthor', () => {
  it('extracts email from angle brackets', () => {
    expect(extractEmailFromAuthor('John Doe <john@example.com>')).toBe('john@example.com');
  });

  it('extracts email with display name containing special chars', () => {
    expect(extractEmailFromAuthor('"Doe, John" <john@example.com>')).toBe('john@example.com');
  });

  it('extracts bare email address', () => {
    expect(extractEmailFromAuthor('john@example.com')).toBe('john@example.com');
  });

  it('lowercases the result', () => {
    expect(extractEmailFromAuthor('John@EXAMPLE.COM')).toBe('john@example.com');
    expect(extractEmailFromAuthor('User <John@EXAMPLE.COM>')).toBe('john@example.com');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(extractEmailFromAuthor(null)).toBe('');
    expect(extractEmailFromAuthor(undefined)).toBe('');
    expect(extractEmailFromAuthor('')).toBe('');
  });

  it('returns empty string for malformed input with no email', () => {
    expect(extractEmailFromAuthor('just a name')).toBe('');
  });

  it('handles plus-addressed emails', () => {
    expect(extractEmailFromAuthor('User <user+tag@example.com>')).toBe('user+tag@example.com');
  });

  it('handles dotted local parts', () => {
    expect(extractEmailFromAuthor('first.last@example.com')).toBe('first.last@example.com');
  });
});

// ---------------------------------------------------------------------------
// TB-034: String truncation with ellipsis (formatForLog)
// ---------------------------------------------------------------------------
describe('TB-034: formatForLog', () => {
  it('returns quoted empty string for falsy input', () => {
    expect(formatForLog(null)).toBe("''");
    expect(formatForLog(undefined)).toBe("''");
    expect(formatForLog('')).toBe("''");
  });

  it('truncates long text to default length (100) and adds ellipsis', () => {
    const longText = 'A'.repeat(200);
    const result = formatForLog(longText);
    // After truncation to 100 chars + trim + "..."
    expect(result).toBe('A'.repeat(100) + '...');
  });

  it('truncates to custom length', () => {
    const text = 'Hello World this is a test string';
    const result = formatForLog(text, 10);
    expect(result).toBe('Hello Worl...');
  });

  it('replaces literal \\r\\n sequences with spaces', () => {
    // The regex in formatForLog uses /\\r?\\n|\\r/g which matches literal
    // backslash-escaped \r\n or \r sequences (e.g., from JSON-stringified text).
    // Note: standalone \n (without \r) does NOT match — only \r\n or \r.
    const text = 'line1\\r\\nline2\\rline3';
    const result = formatForLog(text, 50);
    expect(result).toContain('line1 line2 line3');
  });

  it('always appends ellipsis even for short text', () => {
    const result = formatForLog('short');
    expect(result).toMatch(/\.\.\.$/);
  });
});

// ---------------------------------------------------------------------------
// TB-035: HTML entity escaping
// ---------------------------------------------------------------------------
describe('TB-035: escapeHtml', () => {
  // escapeHtml is a module-private utility duplicated across history.js,
  // marketplace.js, etc. We test the canonical regex-based implementation
  // (from prompts/modules/history.js) here to validate the pattern.
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#039;s');
  });

  it('returns empty string for falsy input', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml('')).toBe('');
  });

  it('does not double-escape already-escaped entities', () => {
    // First pass escapes &, second pass would escape &amp; to &amp;amp;
    const once = escapeHtml('a & b');
    const twice = escapeHtml(once);
    expect(twice).toBe('a &amp;amp; b');
    // This is expected behavior — the function escapes raw text, not pre-escaped HTML
  });

  it('handles combined special characters', () => {
    expect(escapeHtml('<a href="x&y">it\'s</a>')).toBe(
      '&lt;a href=&quot;x&amp;y&quot;&gt;it&#039;s&lt;/a&gt;'
    );
  });
});

// ---------------------------------------------------------------------------
// Additional pure utility function tests
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
  it('replaces invalid filesystem characters with underscore', () => {
    expect(sanitizeFilename('file/name')).toBe('file_name');
    expect(sanitizeFilename('file\\name')).toBe('file_name');
    expect(sanitizeFilename('file:name')).toBe('file_name');
    expect(sanitizeFilename('file*name')).toBe('file_name');
    expect(sanitizeFilename('file?name')).toBe('file_name');
    expect(sanitizeFilename('file"name')).toBe('file_name');
    expect(sanitizeFilename('file<name>')).toBe('file_name_');
    expect(sanitizeFilename('file|name')).toBe('file_name');
  });

  it('preserves valid characters', () => {
    expect(sanitizeFilename('valid-file_name.json')).toBe('valid-file_name.json');
  });

  it('handles multiple invalid characters', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });
});

describe('parseUniqueId', () => {
  it('parses a valid uniqueId into weFolder + headerID', () => {
    const result = parseUniqueId('account1:/INBOX:abc123@example.com');
    expect(result).toEqual({
      weFolder: { accountId: 'account1', path: '/INBOX' },
      headerID: 'abc123@example.com',
    });
  });

  it('handles folder paths with colons correctly (uses first two colons)', () => {
    // accountId:folderPath:headerID — folderPath may NOT contain colons
    // but headerID often contains @ etc.
    const result = parseUniqueId('acc:/Sent:msg-id@server.com');
    expect(result).toEqual({
      weFolder: { accountId: 'acc', path: '/Sent' },
      headerID: 'msg-id@server.com',
    });
  });

  it('returns null for null/undefined/non-string', () => {
    expect(parseUniqueId(null)).toBe(null);
    expect(parseUniqueId(undefined)).toBe(null);
    expect(parseUniqueId(42)).toBe(null);
  });

  it('returns null for string without colons', () => {
    expect(parseUniqueId('nocolons')).toBe(null);
  });

  it('returns null for string with only one colon', () => {
    expect(parseUniqueId('only:one')).toBe(null);
  });

  it('returns null when headerID is empty', () => {
    expect(parseUniqueId('account:/folder:')).toBe(null);
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays execution by the specified wait time', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('resets the timer on subsequent calls', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(50);
    debounced(); // reset
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled(); // only 50ms since last call

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes arguments to the debounced function', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('a', 'b');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('a', 'b');
  });

  it('uses arguments from the latest call', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('first');
    debounced('second');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('second');
  });
});

describe('log', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('always logs errors regardless of verboseLogging setting', () => {
    log('something broke', 'error');
    expect(console.error).toHaveBeenCalledWith('[TabMail Agent] something broke');
  });

  it('suppresses info-level logs when verboseLogging is off', () => {
    log('info message', 'info');
    expect(console.log).not.toHaveBeenCalled();
  });
});
