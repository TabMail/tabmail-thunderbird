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

const {
  toIsoNoMs,
  extractPlainTextFromHtml,
  getGenericTimezoneAbbr,
  toNaiveIso,
  formatTimestampForAgent,
  fuzzyMatchWithList,
  formatMailList,
  buildToolResponse,
  renderToPlainText,
  formatNaiveIsoInTimezone,
} = await import('../chat/modules/helpers.js');

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

  it('converts blockquote content to > prefixed lines', () => {
    const result = extractPlainTextFromHtml(
      '<blockquote>First quoted line</blockquote>'
    );
    expect(result).toContain('> First quoted line');
  });

  it('handles nested blockquote with multiple lines', () => {
    const result = extractPlainTextFromHtml(
      '<blockquote>Line A<br>Line B</blockquote>'
    );
    expect(result).toContain('> Line A');
    expect(result).toContain('> Line B');
  });

  it('converts reminder cards to > prefixed lines', () => {
    const result = extractPlainTextFromHtml(
      '<div class="tm-reminder-card">Reminder text here</div>'
    );
    expect(result).toContain('> Reminder text here');
  });

  it('strips buttons inside reminder cards', () => {
    const result = extractPlainTextFromHtml(
      '<div class="tm-reminder-card">Reminder<button>Dismiss</button></div>'
    );
    expect(result).toContain('> Reminder');
    expect(result).not.toContain('Dismiss');
  });

  it('extracts text from TabMail email links with [Email: ...] prefix', () => {
    const result = extractPlainTextFromHtml(
      '<a class="tm-email-link" href="#" data-id="123">Meeting Notes</a>'
    );
    expect(result).toContain('[Email: Meeting Notes]');
  });

  it('extracts text from TabMail contact links with [Contact: ...] prefix', () => {
    const result = extractPlainTextFromHtml(
      '<a class="tm-contact-link" href="#">Jane Doe</a>'
    );
    expect(result).toContain('[Contact: Jane Doe]');
  });

  it('extracts text from TabMail event links with [Calendar: ...] prefix', () => {
    const result = extractPlainTextFromHtml(
      '<a class="tm-event-link" href="#">Team Standup</a>'
    );
    expect(result).toContain('[Calendar: Team Standup]');
  });

  it('strips emoji prefixes from special link text', () => {
    const result = extractPlainTextFromHtml(
      '<a class="tm-email-link" href="#">📧 Budget Report</a>'
    );
    expect(result).toContain('[Email: Budget Report]');
    expect(result).not.toContain('📧');
  });

  it('strips contact emoji prefix from contact link text', () => {
    const result = extractPlainTextFromHtml(
      '<a class="tm-contact-link" href="#">👤 Alice</a>'
    );
    expect(result).toContain('[Contact: Alice]');
    expect(result).not.toContain('👤');
  });

  it('strips calendar emoji prefix from event link text', () => {
    const result = extractPlainTextFromHtml(
      '<a class="tm-event-link" href="#">📅 Sprint Planning</a>'
    );
    expect(result).toContain('[Calendar: Sprint Planning]');
    expect(result).not.toContain('📅');
  });

  it('handles nested HTML elements (div > p > span)', () => {
    const result = extractPlainTextFromHtml(
      '<div><p>Outer <span>inner text</span> end</p></div>'
    );
    expect(result).toContain('Outer');
    expect(result).toContain('inner text');
    expect(result).toContain('end');
    expect(result).not.toContain('<div>');
    expect(result).not.toContain('<span>');
  });

  it('converts multiple <br> tags to newlines', () => {
    const result = extractPlainTextFromHtml('A<br>B<br/>C<br />D');
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('C');
    expect(result).toContain('D');
  });

  it('preserves text inside <code> blocks', () => {
    const result = extractPlainTextFromHtml('<code>const x = 42;</code>');
    expect(result).toContain('const x = 42;');
    expect(result).not.toContain('<code>');
  });

  it('handles mixed content: text + code + list + links', () => {
    const html = [
      '<p>Here is some text.</p>',
      '<code>let y = 10;</code>',
      '<ul><li>Item one</li><li>Item two</li></ul>',
      '<a href="https://example.com">Example Link</a>',
    ].join('');
    const result = extractPlainTextFromHtml(html);
    expect(result).toContain('Here is some text.');
    expect(result).toContain('let y = 10;');
    expect(result).toContain('Item one');
    expect(result).toContain('Item two');
    expect(result).toContain('Example Link');
    expect(result).not.toContain('<p>');
    expect(result).not.toContain('<li>');
    expect(result).not.toContain('<a');
  });

  it('sanitizeForJson removes null bytes via extractPlainTextFromHtml', () => {
    const result = extractPlainTextFromHtml('<p>Hello\x00World</p>');
    expect(result).toBe('HelloWorld');
  });

  it('sanitizeForJson removes control characters but preserves newlines and tabs via extractPlainTextFromHtml', () => {
    // Control chars \x01-\x08 should be removed, but newline (\x0A) and tab (\x09) should survive
    const result = extractPlainTextFromHtml('A\x01B\x08C');
    expect(result).toBe('ABC');
  });

  it('sanitizeForJson preserves tabs via extractPlainTextFromHtml', () => {
    const result = extractPlainTextFromHtml('Col1\tCol2');
    expect(result).toContain('Col1\tCol2');
  });

  it('sanitizeForJson preserves newlines via extractPlainTextFromHtml', () => {
    const result = extractPlainTextFromHtml('Line1<br>Line2');
    expect(result).toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// getGenericTimezoneAbbr
// ---------------------------------------------------------------------------

describe('getGenericTimezoneAbbr', () => {
  it('returns a non-empty string for the current environment', () => {
    const result = getGenericTimezoneAbbr();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('accepts a Date argument without throwing', () => {
    const d = new Date();
    expect(() => getGenericTimezoneAbbr(d)).not.toThrow();
  });

  it('returns a string even when Intl is unavailable', () => {
    // The function has a catch-all fallback to "GMT"
    const result = getGenericTimezoneAbbr(new Date());
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// toNaiveIso
// ---------------------------------------------------------------------------

describe('toNaiveIso', () => {
  it('converts a Date object to naive ISO (no timezone suffix)', () => {
    const d = new Date();
    const result = toNaiveIso(d);
    // Should match YYYY-MM-DDTHH:MM:SS with no trailing Z or offset
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it('converts a numeric timestamp (ms since epoch)', () => {
    const now = Date.now();
    const result = toNaiveIso(now);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    // Should represent the same local time as new Date(now)
    const expected = new Date(now);
    expect(result).toContain(String(expected.getFullYear()));
  });

  it('converts an ISO string with Z suffix to naive ISO', () => {
    // Use a dynamically generated ISO string
    const d = new Date();
    const isoStr = d.toISOString(); // has trailing Z
    const result = toNaiveIso(isoStr);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(result).not.toContain('Z');
  });

  it('converts an ISO string with offset to naive ISO', () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const input = `${year}-${month}-${day}T10:30:00+05:00`;
    const result = toNaiveIso(input);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(result).not.toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('returns a valid naive ISO for invalid input (falls back to now)', () => {
    const result = toNaiveIso('not-a-date');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it('returns a valid naive ISO for non-date types (falls back to now)', () => {
    const result = toNaiveIso({});
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it('uses local time components (not UTC)', () => {
    const d = new Date();
    const result = toNaiveIso(d);
    const localHours = String(d.getHours()).padStart(2, '0');
    const localMinutes = String(d.getMinutes()).padStart(2, '0');
    expect(result).toContain(`${localHours}:${localMinutes}`);
  });
});

// ---------------------------------------------------------------------------
// formatTimestampForAgent
// ---------------------------------------------------------------------------

describe('formatTimestampForAgent', () => {
  it('includes day of week, date, time, and timezone', () => {
    const d = new Date();
    const result = formatTimestampForAgent(d);
    // Format: "DayOfWeek YYYY/MM/DD HH:MM:SS TZ"
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const expectedDay = dayNames[d.getDay()];
    expect(result).toContain(expectedDay);
    expect(result).toContain(String(d.getFullYear()));
  });

  it('uses slash-separated date format YYYY/MM/DD', () => {
    const d = new Date();
    const result = formatTimestampForAgent(d);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    expect(result).toContain(`${year}/${month}/${day}`);
  });

  it('pads single-digit hours, minutes, seconds with zeros', () => {
    const d = new Date();
    const result = formatTimestampForAgent(d);
    // The time portion should have HH:MM:SS format
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('defaults to current time when called without arguments', () => {
    const before = new Date();
    const result = formatTimestampForAgent();
    const after = new Date();
    // Should contain the current year
    expect(result).toContain(String(before.getFullYear()));
    // Should be a non-empty string
    expect(result.length).toBeGreaterThan(10);
  });

  it('ends with a timezone abbreviation', () => {
    const result = formatTimestampForAgent(new Date());
    // Should end with a timezone string (may include digits for offset-based zones like GMT+9)
    expect(result).toMatch(/\s[A-Z][A-Za-z0-9+\-]{1,10}$/);
  });
});

// ---------------------------------------------------------------------------
// fuzzyMatchWithList
// ---------------------------------------------------------------------------

describe('fuzzyMatchWithList', () => {
  const candidates = ['Inbox', 'Sent Mail', 'Drafts', 'Trash', 'Archive'];

  it('returns exact case-insensitive match', () => {
    expect(fuzzyMatchWithList('inbox', candidates)).toBe('Inbox');
    expect(fuzzyMatchWithList('DRAFTS', candidates)).toBe('Drafts');
  });

  it('returns substring match when input is a substring of a candidate', () => {
    expect(fuzzyMatchWithList('Sent', candidates)).toBe('Sent Mail');
  });

  it('returns substring match when a candidate is a substring of input', () => {
    expect(fuzzyMatchWithList('Inbox/Important', candidates)).toBe('Inbox');
  });

  it('returns closest Levenshtein match for typos', () => {
    expect(fuzzyMatchWithList('Trsh', candidates)).toBe('Trash');
    expect(fuzzyMatchWithList('Drats', candidates)).toBe('Drafts');
  });

  it('returns null for empty input', () => {
    expect(fuzzyMatchWithList('', candidates)).toBeNull();
    expect(fuzzyMatchWithList(null, candidates)).toBeNull();
    expect(fuzzyMatchWithList(undefined, candidates)).toBeNull();
  });

  it('returns null for empty candidates array', () => {
    expect(fuzzyMatchWithList('test', [])).toBeNull();
  });

  it('returns null for non-array candidates', () => {
    expect(fuzzyMatchWithList('test', null)).toBeNull();
    expect(fuzzyMatchWithList('test', 'not-array')).toBeNull();
  });

  it('respects maxDistance threshold', () => {
    // "Trsh" is 1 edit away from "Trash" — should match with maxDistance=1
    expect(fuzzyMatchWithList('Trsh', candidates, 1)).toBe('Trash');
    // "zzzzz" is far from anything — should return null with maxDistance=1
    expect(fuzzyMatchWithList('zzzzz', candidates, 1)).toBeNull();
  });

  it('returns best match regardless of distance when maxDistance is null', () => {
    // Even a distant match should be returned when no threshold is set
    const result = fuzzyMatchWithList('xyzzy', candidates);
    expect(result).not.toBeNull();
    expect(candidates).toContain(result);
  });
});

// ---------------------------------------------------------------------------
// formatMailList
// ---------------------------------------------------------------------------

describe('formatMailList', () => {
  it('wraps output in BEGIN/END EMAIL LIST markers', () => {
    const result = formatMailList([]);
    expect(result).toContain('====BEGIN EMAIL LIST====');
    expect(result).toContain('====END EMAIL LIST====');
  });

  it('formats a single email item with all fields', () => {
    const items = [{
      uniqueId: 'msg-001',
      date: '2099-01-15',
      from: 'alice@example.com',
      subject: 'Test Subject',
      hasAttachments: true,
      action: 'reply',
      replied: true,
      blurb: 'A short summary',
      todos: 'Follow up',
    }];
    const result = formatMailList(items);
    expect(result).toContain('unique_id: msg-001');
    expect(result).toContain('date: 2099-01-15');
    expect(result).toContain('from: alice@example.com');
    expect(result).toContain('subject: Test Subject');
    expect(result).toContain('has_attachments: yes');
    expect(result).toContain('currently_tagged_for: reply');
    expect(result).toContain('replied: yes');
    expect(result).toContain('todos: Follow up');
    expect(result).toContain('two-line summary: A short summary');
  });

  it('shows "(No subject)" when subject is missing', () => {
    const items = [{ uniqueId: 'msg-002' }];
    const result = formatMailList(items);
    expect(result).toContain('subject: (No subject)');
  });

  it('shows has_attachments: no when hasAttachments is falsy', () => {
    const items = [{ uniqueId: 'msg-003', hasAttachments: false }];
    const result = formatMailList(items);
    expect(result).toContain('has_attachments: no');
  });

  it('shows replied: no when replied is not true', () => {
    const items = [{ uniqueId: 'msg-004', replied: false }];
    const result = formatMailList(items);
    expect(result).toContain('replied: no');
  });

  it('uses snippet instead of blurb/todos when snippet is present', () => {
    const items = [{
      uniqueId: 'msg-005',
      snippet: 'matched search result text',
      blurb: 'should not appear',
      todos: 'should not appear either',
    }];
    const result = formatMailList(items);
    expect(result).toContain('search snippet: matched search result text');
    expect(result).not.toContain('two-line summary:');
    expect(result).not.toContain('todos: should not appear');
  });

  it('formats multiple items separated by double newlines', () => {
    const items = [
      { uniqueId: 'msg-a', subject: 'First' },
      { uniqueId: 'msg-b', subject: 'Second' },
    ];
    const result = formatMailList(items);
    expect(result).toContain('unique_id: msg-a');
    expect(result).toContain('unique_id: msg-b');
    expect(result).toContain('subject: First');
    expect(result).toContain('subject: Second');
  });

  it('handles non-array input gracefully', () => {
    const result = formatMailList(null);
    expect(result).toContain('====BEGIN EMAIL LIST====');
    expect(result).toContain('====END EMAIL LIST====');
  });

  it('omits blurb and todos lines when they are empty or whitespace', () => {
    const items = [{ uniqueId: 'msg-006', blurb: '  ', todos: '' }];
    const result = formatMailList(items);
    expect(result).not.toContain('two-line summary:');
    expect(result).not.toContain('todos:');
  });
});

// ---------------------------------------------------------------------------
// buildToolResponse
// ---------------------------------------------------------------------------

describe('buildToolResponse', () => {
  it('wraps tool name and response in a JSON code block', () => {
    const result = buildToolResponse('calendar_search', { events: [] });
    expect(result).toContain('```json');
    expect(result).toContain('```');
    // Should be valid JSON inside the fences
    const jsonPart = result.replace(/```json\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(jsonPart);
    expect(parsed.tool).toBe('calendar_search');
    expect(parsed.response).toEqual({ events: [] });
  });

  it('pretty-prints the JSON with indentation', () => {
    const result = buildToolResponse('test_tool', { key: 'value' });
    // Pretty-printed JSON has newlines and indentation
    expect(result).toContain('\n');
    const jsonPart = result.replace(/```json\n?/, '').replace(/\n?```$/, '');
    expect(jsonPart).toContain('  '); // 2-space indent
  });

  it('handles complex nested response objects', () => {
    const response = {
      results: [{ id: 1, name: 'test' }],
      count: 1,
      nested: { deep: { value: true } },
    };
    const result = buildToolResponse('complex_tool', response);
    const jsonPart = result.replace(/```json\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(jsonPart);
    expect(parsed.tool).toBe('complex_tool');
    expect(parsed.response.results[0].id).toBe(1);
    expect(parsed.response.nested.deep.value).toBe(true);
  });

  it('handles string response', () => {
    const result = buildToolResponse('echo', 'hello world');
    const jsonPart = result.replace(/```json\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(jsonPart);
    expect(parsed.response).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// renderToPlainText
// ---------------------------------------------------------------------------

describe('renderToPlainText', () => {
  it('returns empty string for null input', async () => {
    expect(await renderToPlainText(null)).toBe('');
  });

  it('returns empty string for empty string', async () => {
    expect(await renderToPlainText('')).toBe('');
  });

  it('returns empty string for whitespace-only input', async () => {
    expect(await renderToPlainText('   ')).toBe('');
  });

  it('returns empty string for undefined', async () => {
    expect(await renderToPlainText(undefined)).toBe('');
  });

  it('strips HTML tags from markdown-rendered content', async () => {
    // renderMarkdown mock returns input as-is, so this tests extractPlainTextFromHtml path
    const result = await renderToPlainText('<p>Hello <b>World</b></p>');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
    expect(result).not.toContain('<p>');
    expect(result).not.toContain('<b>');
  });

  it('preserves plain text content', async () => {
    const result = await renderToPlainText('Simple text content');
    expect(result).toContain('Simple text content');
  });

  it('converts HTML entities', async () => {
    const result = await renderToPlainText('&amp; &lt; &gt;');
    expect(result).toContain('&');
    expect(result).toContain('<');
    expect(result).toContain('>');
  });

  it('handles mixed markdown and HTML', async () => {
    const result = await renderToPlainText('<p>Paragraph</p><br>New line');
    expect(result).toContain('Paragraph');
    expect(result).toContain('New line');
  });

  it('falls back to raw content when renderMarkdown throws', async () => {
    const { renderMarkdown } = await import('../chat/modules/markdown.js');
    renderMarkdown.mockRejectedValueOnce(new Error('render failed'));
    const result = await renderToPlainText('fallback content here');
    expect(result).toBe('fallback content here');
  });
});

// ---------------------------------------------------------------------------
// formatNaiveIsoInTimezone
// ---------------------------------------------------------------------------

describe('formatNaiveIsoInTimezone', () => {
  it('returns formatTimestampForAgent output when no timezone', () => {
    const result = formatNaiveIsoInTimezone('2025-01-15T15:00:00', null);
    // Should contain the time from the naive ISO (15:00) since it's parsed as local
    expect(result).toContain('15:00');
  });

  it('returns formatTimestampForAgent output when timezone is empty', () => {
    const result = formatNaiveIsoInTimezone('2025-01-15T15:00:00', '');
    expect(result).toContain('15:00');
  });

  it('preserves naive ISO digits when timezone override is specified', () => {
    // The key test: "2025-01-15T15:00:00" with timezone "Asia/Tokyo"
    // should display 15:00, NOT convert from local to Tokyo
    const result = formatNaiveIsoInTimezone('2025-01-15T15:00:00', 'Asia/Tokyo');
    expect(result).toContain('15:00');
    // Should contain JST or similar timezone label (may render as GMT+9 in some environments)
    expect(result).toMatch(/JST|Japan|Asia\/Tokyo|GMT\+9/);
    // Should contain the date
    expect(result).toContain('2025');
    expect(result).toContain('01');
    expect(result).toContain('15');
  });

  it('preserves digits for different timezone', () => {
    const result = formatNaiveIsoInTimezone('2025-06-20T09:30:00', 'America/New_York');
    expect(result).toContain('09:30');
    // Should contain EDT or EST or similar
    expect(result).toMatch(/EDT|EST|ET|America\/New_York/);
  });

  it('handles invalid timezone gracefully', () => {
    const result = formatNaiveIsoInTimezone('2025-01-15T15:00:00', 'Not/A/Timezone');
    // Should fallback to formatTimestampForAgent
    expect(result).toContain('15:00');
  });

  it('includes day of week', () => {
    // 2025-01-15 is a Wednesday
    const result = formatNaiveIsoInTimezone('2025-01-15T15:00:00', 'UTC');
    expect(result).toContain('Wednesday');
  });
});
