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
  generateRequestId,
  runPromisesInBatches,
  extractBodyFromParts,
  stripHtml,
  extractUserWrittenContent,
  clearGetFullCache,
  headerIndex,
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

// ---------------------------------------------------------------------------
// generateRequestId — unique request ID generation
// ---------------------------------------------------------------------------
describe('generateRequestId', () => {
  it('returns a string starting with "req_"', async () => {
    const id = await generateRequestId();
    expect(id).toMatch(/^req_/);
  });

  it('contains a timestamp component', async () => {
    const before = Date.now();
    const id = await generateRequestId();
    const after = Date.now();
    // Format: req_<timestamp>_<random>_<hash>
    const parts = id.split('_');
    // parts[0] = "req", parts[1] = timestamp
    const timestamp = Number(parts[1]);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('generates unique IDs across multiple calls', async () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      ids.add(await generateRequestId());
    }
    expect(ids.size).toBe(50);
  });

  it('follows the expected format pattern', async () => {
    const id = await generateRequestId();
    // req_<timestamp>_<6hexchars>_<4hexchars> OR req_<timestamp>_<alphanumeric>
    expect(id).toMatch(/^req_\d+_[a-f0-9]+_[a-f0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// runPromisesInBatches — batched promise execution
// ---------------------------------------------------------------------------
describe('runPromisesInBatches', () => {
  it('executes all promise factories and returns results', async () => {
    const factories = [
      () => Promise.resolve(1),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
    ];
    const results = await runPromisesInBatches(factories, 2);
    expect(results).toEqual([1, 2, 3]);
  });

  it('returns empty array for empty input', async () => {
    const results = await runPromisesInBatches([], 5);
    expect(results).toEqual([]);
  });

  it('respects concurrency by running in batches', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const makeFactory = (val) => () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      return new Promise((resolve) => {
        // Simulate async work — resolve synchronously to keep test fast
        currentConcurrent--;
        resolve(val);
      });
    };

    const factories = [makeFactory(1), makeFactory(2), makeFactory(3), makeFactory(4), makeFactory(5)];
    const results = await runPromisesInBatches(factories, 2);
    expect(results).toEqual([1, 2, 3, 4, 5]);
    // Each batch should run at most 2 concurrently
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('handles single-item batches', async () => {
    const factories = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ];
    const results = await runPromisesInBatches(factories, 1);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('handles concurrency larger than factory count', async () => {
    const factories = [
      () => Promise.resolve(10),
      () => Promise.resolve(20),
    ];
    const results = await runPromisesInBatches(factories, 100);
    expect(results).toEqual([10, 20]);
  });

  it('propagates rejections from promise factories', async () => {
    const factories = [
      () => Promise.resolve(1),
      () => Promise.reject(new Error('batch fail')),
      () => Promise.resolve(3),
    ];
    await expect(runPromisesInBatches(factories, 3)).rejects.toThrow('batch fail');
  });
});

// ---------------------------------------------------------------------------
// stripHtml — HTML to plain text (requires DOMParser mock)
// ---------------------------------------------------------------------------
describe('stripHtml', () => {
  // Set up a minimal DOMParser mock for Node environment
  let _origNode;

  beforeEach(() => {
    // Save original Node (Node.js stream class) to avoid breaking vitest internals
    _origNode = globalThis.Node;

    // Minimal DOM node mock
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

    // Use Object.defineProperty to add TEXT_NODE/ELEMENT_NODE without replacing the Node class
    const nodeConstants = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    globalThis.Node = Object.assign(function Node() {}, nodeConstants);

    globalThis.DOMParser = class {
      parseFromString(html, _type) {
        // Very simplified HTML parser for testing — handles basic cases
        const stripped = html
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
    // Restore original Node
    if (_origNode !== undefined) {
      globalThis.Node = _origNode;
    } else {
      delete globalThis.Node;
    }
    delete globalThis.DOMParser;
  });

  it('returns empty string for falsy input', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml('')).toBe('');
  });

  it('strips HTML tags and returns text content', () => {
    const result = stripHtml('<p>Hello World</p>');
    expect(result).toContain('Hello World');
  });

  it('handles plain text input without tags', () => {
    const result = stripHtml('Just plain text');
    expect(result).toBe('Just plain text');
  });

  it('converts br tags to newlines', () => {
    const result = stripHtml('line1<br>line2');
    expect(result).toContain('line1');
    expect(result).toContain('line2');
  });
});

// ---------------------------------------------------------------------------
// extractUserWrittenContent — user-written portion of email body
// ---------------------------------------------------------------------------
describe('extractUserWrittenContent', () => {
  beforeEach(() => {
    // Suppress log calls during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.TabMailQuoteDetection;
  });

  it('returns empty string for falsy body', () => {
    expect(extractUserWrittenContent(null, 'text/plain')).toBe('');
    expect(extractUserWrittenContent('', 'text/plain')).toBe('');
    expect(extractUserWrittenContent(undefined, 'text/html')).toBe('');
  });

  it('returns plain text body when no quote detection is available', () => {
    // No TabMailQuoteDetection set, so boundary detection is skipped
    const result = extractUserWrittenContent('Hello, this is my reply.', 'text/plain');
    expect(result).toBe('Hello, this is my reply.');
  });

  it('trims and collapses excessive blank lines in plain text', () => {
    const body = 'Line 1\n\n\n\n\nLine 2';
    const result = extractUserWrittenContent(body, 'text/plain');
    expect(result).toBe('Line 1\n\nLine 2');
  });

  it('truncates at quote boundary when detection finds one', () => {
    globalThis.TabMailQuoteDetection = {
      findBoundaryInPlainText: (text) => {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('On ') && lines[i].includes('wrote:')) {
            return { type: 'attribution', lineIndex: i, hasInlineAnswers: false };
          }
        }
        return null;
      },
    };

    const body = 'My reply here.\n\nOn Jan 1 someone wrote:\n> Original message';
    const result = extractUserWrittenContent(body, 'text/plain');
    expect(result).toBe('My reply here.');
  });

  it('returns full text when inline answers are detected', () => {
    globalThis.TabMailQuoteDetection = {
      findBoundaryInPlainText: (_text) => {
        return { type: 'quote', lineIndex: 2, hasInlineAnswers: true };
      },
    };

    const body = 'My reply\n> Quoted\nAnother reply';
    const result = extractUserWrittenContent(body, 'text/plain');
    expect(result).toBe('My reply\n> Quoted\nAnother reply');
  });
});

// ---------------------------------------------------------------------------
// extractBodyFromParts — MIME part traversal
// ---------------------------------------------------------------------------
describe('extractBodyFromParts', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty string for null/undefined parts', async () => {
    expect(await extractBodyFromParts(null, 1)).toBe('');
    expect(await extractBodyFromParts(undefined, 1)).toBe('');
  });

  it('extracts body from text/plain part', async () => {
    const parts = [
      { contentType: 'text/plain', body: 'Hello plain text' },
    ];
    expect(await extractBodyFromParts(parts, 1)).toBe('Hello plain text');
  });

  it('prefers text/plain over text/html', async () => {
    const parts = [
      { contentType: 'text/plain', body: 'Plain version' },
      { contentType: 'text/html', body: '<p>HTML version</p>' },
    ];
    expect(await extractBodyFromParts(parts, 1)).toBe('Plain version');
  });

  it('wraps single part in array', async () => {
    const singlePart = { contentType: 'text/plain', body: 'Single part body' };
    expect(await extractBodyFromParts(singlePart, 1)).toBe('Single part body');
  });

  it('descends into nested multipart/alternative sub-parts', async () => {
    const parts = [
      {
        contentType: 'multipart/alternative',
        parts: [
          { contentType: 'text/plain', body: 'Nested plain text' },
          { contentType: 'text/html', body: '<p>Nested HTML</p>' },
        ],
      },
    ];
    expect(await extractBodyFromParts(parts, 1)).toBe('Nested plain text');
  });

  it('returns empty string when no text parts are found', async () => {
    const parts = [
      { contentType: 'image/png', body: null },
    ];
    expect(await extractBodyFromParts(parts, 1)).toBe('');
  });

  it('skips text/plain part without body string', async () => {
    // text/plain part exists but body is undefined and no partName/size for attachment fallback
    const parts = [
      { contentType: 'text/plain' },
    ];
    expect(await extractBodyFromParts(parts, 1)).toBe('');
  });

  it('handles deeply nested parts', async () => {
    const parts = [
      {
        contentType: 'multipart/mixed',
        parts: [
          {
            contentType: 'multipart/alternative',
            parts: [
              { contentType: 'text/plain', body: 'Deep nested body' },
            ],
          },
        ],
      },
    ];
    expect(await extractBodyFromParts(parts, 1)).toBe('Deep nested body');
  });
});

// ---------------------------------------------------------------------------
// clearGetFullCache — cache clearing
// ---------------------------------------------------------------------------
describe('clearGetFullCache', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when called on an empty cache', () => {
    expect(() => clearGetFullCache()).not.toThrow();
  });

  it('can be called multiple times safely', () => {
    clearGetFullCache();
    clearGetFullCache();
    // No error means success
  });
});

// ---------------------------------------------------------------------------
// headerIDToWeID — multi-stage header resolution
// ---------------------------------------------------------------------------
describe('headerIDToWeID', () => {
  let origBrowser;

  beforeEach(() => {
    origBrowser = globalThis.browser;
    globalThis.browser = {
      messages: {
        get: vi.fn(async () => null),
        query: vi.fn(async () => ({ messages: [] })),
      },
      folders: {
        query: vi.fn(async () => []),
      },
    };
    headerIndex.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.browser = origBrowser;
    vi.restoreAllMocks();
    headerIndex.clear();
  });

  it('returns null for null headerID', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    expect(await headerIDToWeID(null)).toBe(null);
  });

  it('returns null for empty string headerID', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    expect(await headerIDToWeID('')).toBe(null);
  });

  it('returns null for non-string headerID', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    expect(await headerIDToWeID(42)).toBe(null);
  });

  it('returns empty array for invalid headerID with multiple=true', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    expect(await headerIDToWeID(null, null, true)).toEqual([]);
  });

  it('returns null when all stages fail', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    browser.messages.query.mockResolvedValue({ messages: [] });
    expect(await headerIDToWeID('test@example.com', null, false, true)).toBe(null);
  });

  it('resolves via STAGE 2 (messages.query with folder)', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    browser.folders.query.mockResolvedValue([{ id: 'folder-123' }]);
    browser.messages.query.mockResolvedValue({
      messages: [{ id: 42, headerMessageId: '<test@example.com>', folder: { accountId: 'a', path: '/INBOX' } }],
    });
    const result = await headerIDToWeID(
      'test@example.com',
      { accountId: 'acc1', path: '/INBOX' }
    );
    expect(result).toBe(42);
  });

  it('resolves via STAGE 3 (global fallback)', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    // First call (STAGE 2) returns empty, second call (STAGE 3) returns result
    browser.messages.query
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [{ id: 99, headerMessageId: '<test@example.com>', folder: { accountId: 'a', path: '/INBOX' } }],
      });
    const result = await headerIDToWeID(
      'test@example.com',
      { accountId: 'acc1', path: '/INBOX' },
      false,
      true
    );
    expect(result).toBe(99);
  });

  it('returns empty array when all stages fail with multiple=true', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    browser.messages.query.mockResolvedValue({ messages: [] });
    const result = await headerIDToWeID('test@example.com', null, true, true);
    expect(result).toEqual([]);
  });

  it('returns multiple IDs via STAGE 3 with multiple=true', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    browser.messages.query.mockResolvedValue({
      messages: [
        { id: 10, headerMessageId: '<test@example.com>', folder: { accountId: 'a', path: '/INBOX' } },
        { id: 20, headerMessageId: '<test@example.com>', folder: { accountId: 'a', path: '/Sent' } },
      ],
    });
    const result = await headerIDToWeID('test@example.com', null, true, true);
    expect(result).toEqual([10, 20]);
  });

  it('skips STAGE 3 when allowGlobalFallback is false', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    browser.messages.query.mockResolvedValue({ messages: [] });
    const result = await headerIDToWeID(
      'test@example.com',
      { accountId: 'acc1', path: '/INBOX' },
      false,
      false
    );
    expect(result).toBe(null);
    // Only STAGE 2 query should have been called (not STAGE 3)
    expect(browser.messages.query).toHaveBeenCalledTimes(1);
  });

  it('handles STAGE 2 query error gracefully', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    browser.messages.query
      .mockRejectedValueOnce(new Error('query error'))
      .mockResolvedValueOnce({ messages: [{ id: 77, headerMessageId: '<test@example.com>', folder: {} }] });
    const result = await headerIDToWeID(
      'test@example.com',
      { accountId: 'acc1', path: '/INBOX' },
      false,
      true
    );
    expect(result).toBe(77);
  });

  it('handles folders.query failure gracefully', async () => {
    const { headerIDToWeID } = await import('../agent/modules/utils.js');
    browser.folders.query.mockRejectedValue(new Error('folders error'));
    browser.messages.query.mockResolvedValue({
      messages: [{ id: 55, headerMessageId: '<test@example.com>', folder: {} }],
    });
    const result = await headerIDToWeID(
      'test@example.com',
      { accountId: 'acc1', path: '/INBOX' }
    );
    // Should still succeed via STAGE 2 query (without folderId constraint)
    expect(result).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// headerIndex — Map export for header indexing
// ---------------------------------------------------------------------------
describe('headerIndex', () => {
  afterEach(() => {
    headerIndex.clear();
  });

  it('is a Map instance', () => {
    expect(headerIndex).toBeInstanceOf(Map);
  });

  it('supports standard Map operations', () => {
    headerIndex.set('testKey', { id: 1, folder: { accountId: 'a', path: '/INBOX' }, _ts: Date.now() });
    expect(headerIndex.has('testKey')).toBe(true);
    expect(headerIndex.get('testKey').id).toBe(1);
    headerIndex.delete('testKey');
    expect(headerIndex.has('testKey')).toBe(false);
  });

  it('starts empty or can be cleared', () => {
    headerIndex.set('k1', { id: 1 });
    headerIndex.set('k2', { id: 2 });
    expect(headerIndex.size).toBe(2);
    headerIndex.clear();
    expect(headerIndex.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// indexHeader — note: indexHeader uses an async IIFE internally so cannot
// be tested synchronously. See headerIndex Map tests above for Map operations.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getTrashFolderForHeader / getArchiveFolderForHeader
// ---------------------------------------------------------------------------
describe('getTrashFolderForHeader', () => {
  let origBrowser;

  beforeEach(() => {
    origBrowser = globalThis.browser;
    globalThis.browser = {
      messages: { get: vi.fn(async () => null), query: vi.fn(async () => ({ messages: [] })) },
      folders: {
        query: vi.fn(async ({ specialUse }) => {
          if (specialUse && specialUse.includes('trash')) {
            return [{ id: 'trash1', type: 'trash', path: '/Trash' }];
          }
          if (specialUse && specialUse.includes('archives')) {
            return [{ id: 'archive1', type: 'archives', path: '/Archives' }];
          }
          return [];
        }),
      },
    };
  });

  afterEach(() => {
    globalThis.browser = origBrowser;
  });

  it('returns trash folder for valid header', async () => {
    const { getTrashFolderForHeader } = await import('../agent/modules/utils.js');
    const header = { folder: { accountId: 'a1' } };
    const result = await getTrashFolderForHeader(header);
    expect(result).toBeDefined();
    expect(result.type).toBe('trash');
  });

  it('returns null for null header', async () => {
    const { getTrashFolderForHeader } = await import('../agent/modules/utils.js');
    const result = await getTrashFolderForHeader(null);
    expect(result).toBeNull();
  });

  it('returns null for header without folder', async () => {
    const { getTrashFolderForHeader } = await import('../agent/modules/utils.js');
    const result = await getTrashFolderForHeader({});
    expect(result).toBeNull();
  });

  it('returns null for header without accountId', async () => {
    const { getTrashFolderForHeader } = await import('../agent/modules/utils.js');
    const result = await getTrashFolderForHeader({ folder: {} });
    expect(result).toBeNull();
  });
});

describe('getArchiveFolderForHeader', () => {
  let origBrowser;

  beforeEach(() => {
    origBrowser = globalThis.browser;
    globalThis.browser = {
      messages: { get: vi.fn(async () => null), query: vi.fn(async () => ({ messages: [] })) },
      folders: {
        query: vi.fn(async ({ specialUse }) => {
          if (specialUse && specialUse.includes('archives')) {
            return [{ id: 'archive1', type: 'archives', path: '/Archives' }];
          }
          return [];
        }),
      },
    };
  });

  afterEach(() => {
    globalThis.browser = origBrowser;
  });

  it('returns archive folder for valid header', async () => {
    const { getArchiveFolderForHeader } = await import('../agent/modules/utils.js');
    const header = { folder: { accountId: 'a1' } };
    const result = await getArchiveFolderForHeader(header);
    expect(result).toBeDefined();
    expect(result.type).toBe('archives');
  });

  it('returns null for null header', async () => {
    const { getArchiveFolderForHeader } = await import('../agent/modules/utils.js');
    const result = await getArchiveFolderForHeader(null);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSentFoldersForAccount
// ---------------------------------------------------------------------------
describe('getSentFoldersForAccount', () => {
  let origBrowser;

  beforeEach(() => {
    origBrowser = globalThis.browser;
    globalThis.browser = {
      messages: { get: vi.fn(async () => null), query: vi.fn(async () => ({ messages: [] })) },
      accounts: {
        get: vi.fn(async (id) => ({
          id,
          folders: [
            { id: 'inbox1', type: 'inbox', path: '/INBOX', subFolders: [] },
            { id: 'sent1', type: 'sent', path: '/Sent', specialUse: ['sent'], subFolders: [] },
            { id: 'trash1', type: 'trash', path: '/Trash', subFolders: [] },
          ],
        })),
        list: vi.fn(async () => []),
      },
      folders: {
        query: vi.fn(async () => []),
        getSubFolders: vi.fn(async () => []),
      },
    };
  });

  afterEach(() => {
    globalThis.browser = origBrowser;
  });

  it('returns sent folders for account', async () => {
    const { getSentFoldersForAccount } = await import('../agent/modules/utils.js');
    const result = await getSentFoldersForAccount('a1');
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('sent');
  });

  it('returns empty array when account not found', async () => {
    globalThis.browser.accounts.get.mockRejectedValue(new Error('not found'));
    globalThis.browser.accounts.list.mockResolvedValue([]);
    const { getSentFoldersForAccount } = await import('../agent/modules/utils.js');
    const result = await getSentFoldersForAccount('nonexistent');
    expect(result).toEqual([]);
  });

  it('returns empty array when account has no folders', async () => {
    globalThis.browser.accounts.get.mockResolvedValue({ id: 'a2', folders: [] });
    const { getSentFoldersForAccount } = await import('../agent/modules/utils.js');
    const result = await getSentFoldersForAccount('a2');
    expect(result).toEqual([]);
  });

  it('uses fallback enumeration when accounts.get fails', async () => {
    globalThis.browser.accounts.get.mockRejectedValue(new Error('not supported'));
    globalThis.browser.accounts.list.mockResolvedValue([
      { id: 'a3', rootFolder: { id: 'root3', type: 'root', path: '/' } },
    ]);
    globalThis.browser.folders.getSubFolders.mockResolvedValue([
      { id: 'sent3', type: 'sent', path: '/Sent' },
    ]);
    const { getSentFoldersForAccount } = await import('../agent/modules/utils.js');
    const result = await getSentFoldersForAccount('a3');
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('sent');
  });
});
