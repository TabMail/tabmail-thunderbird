// llmClient.test.js — LLM client response parsing tests (Tier 3 — mock-dependent)
//
// Tests the pure parsing functions exported by llm.js:
// - processJSONResponse: strips markdown fences, parses JSON
// - processEditResponse: parses Subject:/Body: format
// - processSummaryResponse: extracts todos, blurb, reminder from structured text
//
// TB-080 through TB-084 from TESTS.md. SSE stream parsing and retry logic
// are internal (not exported) and tested indirectly through the parsing functions.

import { describe, it, expect, vi } from 'vitest';

// ─── Module Mocks ────────────────────────────────────────────────────────────

// Mock utils.js — only `log` and `normalizeUnicode` are used by llm.js
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: vi.fn((s) => s), // pass-through for testing
}));

// Mock config.js
vi.mock('../agent/modules/config.js', () => ({
  getBackendUrl: vi.fn(async () => 'https://api.tabmail.ai'),
  SETTINGS: {
    sseMaxTimeoutSec: 600,
    sseToolListenTimeoutSec: 600,
    maxAgentWorkers: 32,
  },
}));

// Mock thinkBuffer.js
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  setThink: vi.fn(),
}));

// Mock privacySettings.js
vi.mock('../../chat/modules/privacySettings.js', () => ({
  assertAiBackendAllowed: vi.fn(),
}));

// Provide browser mock for the module-level code
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
  },
  runtime: {
    getManifest: vi.fn(() => ({ version: '1.0.0' })),
  },
};

// ─── Import tested functions ─────────────────────────────────────────────────

const {
  processJSONResponse,
  processEditResponse,
  processSummaryResponse,
  parseDeltaForField,
  extractLabelLine,
  splitCommaRespectingQuotes,
  splitNameAndEmail,
} = await import('../agent/modules/llm.js');

// ─── Tests ───────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// TB-080: Response parsing (JSON, edit, summary)
// ═══════════════════════════════════════════════════════════════════════════
describe('processJSONResponse', () => {
  it('TB-080a: parses plain JSON correctly', () => {
    const result = processJSONResponse('{"action": "reply", "confidence": 0.9}');
    expect(result).toEqual({ action: 'reply', confidence: 0.9 });
  });

  it('TB-080b: strips markdown code fences (```json)', () => {
    const input = '```json\n{"action": "delete"}\n```';
    const result = processJSONResponse(input);
    expect(result).toEqual({ action: 'delete' });
  });

  it('TB-080c: strips markdown code fences without json tag', () => {
    const input = '```\n{"key": "value"}\n```';
    const result = processJSONResponse(input);
    expect(result).toEqual({ key: 'value' });
  });

  it('TB-080d: handles extra content after closing fence', () => {
    const input = '```json\n{"action": "archive"}\n```\nSome extra text';
    const result = processJSONResponse(input);
    expect(result).toEqual({ action: 'archive' });
  });

  it('TB-080e: falls back to {message: rawText} for non-JSON', () => {
    const input = 'This is not JSON at all';
    const result = processJSONResponse(input);
    expect(result).toEqual({ message: 'This is not JSON at all' });
  });

  it('TB-080f: handles null/undefined input', () => {
    expect(processJSONResponse(null)).toEqual({ message: null });
    expect(processJSONResponse(undefined)).toEqual({ message: undefined });
  });

  it('TB-080g: handles empty string', () => {
    const result = processJSONResponse('');
    expect(result).toEqual({ message: '' });
  });

  it('TB-080h: parses JSON array', () => {
    const result = processJSONResponse('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('TB-080i: handles whitespace around JSON', () => {
    const result = processJSONResponse('  \n  {"trimmed": true}  \n  ');
    expect(result).toEqual({ trimmed: true });
  });

  it('TB-080j: handles case-insensitive JSON fence', () => {
    const input = '```JSON\n{"upper": true}\n```';
    const result = processJSONResponse(input);
    expect(result).toEqual({ upper: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TB-081: Tool call parsing (via processJSONResponse with tool_calls)
// ═══════════════════════════════════════════════════════════════════════════
describe('processJSONResponse — tool call structures', () => {
  it('TB-081a: parses tool call JSON structure', () => {
    const input = JSON.stringify({
      tool_calls: [
        { id: 'call_1', function: { name: 'reminder_add', arguments: '{"text":"Buy milk"}' } },
      ],
    });
    const result = processJSONResponse(input);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].function.name).toBe('reminder_add');
  });

  it('TB-081b: parses nested tool arguments as JSON string', () => {
    const toolCall = {
      id: 'call_2',
      function: {
        name: 'email_search',
        arguments: JSON.stringify({ query: 'from:alice subject:meeting' }),
      },
    };
    const input = JSON.stringify({ tool_calls: [toolCall] });
    const result = processJSONResponse(input);
    const args = JSON.parse(result.tool_calls[0].function.arguments);
    expect(args.query).toBe('from:alice subject:meeting');
  });

  it('TB-081c: handles multiple tool calls', () => {
    const input = JSON.stringify({
      tool_calls: [
        { id: 'call_1', function: { name: 'reminder_add', arguments: '{}' } },
        { id: 'call_2', function: { name: 'reminder_del', arguments: '{}' } },
      ],
    });
    const result = processJSONResponse(input);
    expect(result.tool_calls).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TB-082: processEditResponse
// ═══════════════════════════════════════════════════════════════════════════
describe('processEditResponse', () => {
  it('parses Subject and Body fields', () => {
    const input = 'Subject: Re: Meeting\nBody: Hello, I wanted to follow up on...';
    const result = processEditResponse(input);
    expect(result.subject).toBe('Re: Meeting');
    expect(result.body).toBe('Hello, I wanted to follow up on...');
  });

  it('handles multiline body', () => {
    const input = 'Subject: Test\nBody: Line 1\nLine 2\nLine 3';
    const result = processEditResponse(input);
    expect(result.subject).toBe('Test');
    expect(result.body).toContain('Line 1');
    expect(result.body).toContain('Line 3');
  });

  it('handles body only (no subject)', () => {
    const input = 'Body: Just a body with no subject';
    const result = processEditResponse(input);
    expect(result.subject).toBeUndefined();
    expect(result.body).toBe('Just a body with no subject');
  });

  it('handles subject only (no body)', () => {
    const input = 'Subject: Just a subject';
    const result = processEditResponse(input);
    expect(result.subject).toBe('Just a subject');
    expect(result.body).toBeUndefined();
  });

  it('falls back to raw text when no fields found', () => {
    const input = 'Random text without fields';
    const result = processEditResponse(input);
    expect(result.message).toBe('Random text without fields');
  });

  it('handles empty input', () => {
    const result = processEditResponse('');
    expect(result.message).toBe('');
  });

  it('handles null input', () => {
    const result = processEditResponse(null);
    expect(result.message).toBe(null);
  });

  // v1.5.16+ — recipient DELTAS expressed as +To:/-To:/+Cc:/-Cc:/+Bcc:/-Bcc:
  it('parses +/- delta lines into toDelta/ccDelta/bccDelta', () => {
    const input = [
      'Response: Swapped Bob for Alice and added Carol to cc.',
      '+To: Alice Anderson <alice@example.com>',
      '-To: bob@example.com',
      '+Cc: Carol <carol@example.com>',
      'Subject: Re: Budget',
      'Body: Hi all',
    ].join('\n');
    const r = processEditResponse(input);
    expect(r.toDelta).toEqual({
      adds: [{ name: 'Alice Anderson', email: 'alice@example.com' }],
      removes: ['bob@example.com'],
    });
    expect(r.ccDelta).toEqual({
      adds: [{ name: 'Carol', email: 'carol@example.com' }],
      removes: [],
    });
    // Bcc line never appeared → no-change signal
    expect(r.bccDelta).toBeUndefined();
  });

  it('absent delta lines leave the field untouched (undefined)', () => {
    const input = 'Subject: Re: Budget\nBody: Hi team';
    const r = processEditResponse(input);
    expect(r.toDelta).toBeUndefined();
    expect(r.ccDelta).toBeUndefined();
    expect(r.bccDelta).toBeUndefined();
  });

  it('-Cc: * is a clear-all sentinel', () => {
    const input = '-Cc: *\nSubject: x\nBody: y';
    const r = processEditResponse(input);
    expect(r.ccDelta).toEqual({ adds: [], removes: ['*'] });
  });

  it('multiple emails on one -To: line are each added to removes', () => {
    const input = '-To: bob@example.com, dave@example.com\nSubject: x\nBody: y';
    const r = processEditResponse(input);
    expect(r.toDelta).toEqual({
      adds: [],
      removes: ['bob@example.com', 'dave@example.com'],
    });
  });

  it('quoted display names with commas in +To: are not split', () => {
    const input = '+To: "Doe, John" <john@example.com>, "Smith, Jane" <jane@example.com>\nSubject: x\nBody: y';
    const r = processEditResponse(input);
    expect(r.toDelta).toEqual({
      adds: [
        { name: 'Doe, John', email: 'john@example.com' },
        { name: 'Smith, Jane', email: 'jane@example.com' },
      ],
      removes: [],
    });
  });

  it('bare emails in +To: are accepted with empty name', () => {
    const input = '+To: alice@example.com, bob@example.com\nSubject: x\nBody: y';
    const r = processEditResponse(input);
    expect(r.toDelta).toEqual({
      adds: [
        { name: '', email: 'alice@example.com' },
        { name: '', email: 'bob@example.com' },
      ],
      removes: [],
    });
  });

  it('both +Cc: and -Cc: in the same response produce one delta with both sides', () => {
    const input = '+Cc: new@example.com\n-Cc: old@example.com\nSubject: x\nBody: y';
    const r = processEditResponse(input);
    expect(r.ccDelta).toEqual({
      adds: [{ name: '', email: 'new@example.com' }],
      removes: ['old@example.com'],
    });
  });

  it('-To: lowercases emails for comparison consistency', () => {
    const input = '-To: Bob@Example.COM\nSubject: x\nBody: y';
    const r = processEditResponse(input);
    expect(r.toDelta.removes).toEqual(['bob@example.com']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TB-082b: delta helper functions
// ═══════════════════════════════════════════════════════════════════════════
describe('parseDeltaForField', () => {
  it('returns undefined when neither +X: nor -X: line is present', () => {
    expect(parseDeltaForField('Subject: x\nBody: y', 'To')).toBeUndefined();
  });
  it('returns non-undefined delta even when both lines are empty', () => {
    // `+To:` with nothing after is an explicit empty add-list. Parser returns
    // a delta object rather than undefined to capture that the LLM touched the field.
    const r = parseDeltaForField('+To:\nSubject: x', 'To');
    expect(r).toEqual({ adds: [], removes: [] });
  });
  it('is case-insensitive on the label part (but not the sign)', () => {
    expect(parseDeltaForField('+to: a@b.com', 'To')).toEqual({
      adds: [{ name: '', email: 'a@b.com' }],
      removes: [],
    });
  });
});

describe('extractLabelLine', () => {
  it('returns undefined when the line is missing', () => {
    expect(extractLabelLine('Subject: x', '+', 'To')).toBeUndefined();
  });
  it('returns trimmed content after the colon', () => {
    expect(extractLabelLine('+To:   alice@x, bob@y  \nSubject: x', '+', 'To')).toBe(
      'alice@x, bob@y'
    );
  });
  it('escapes both prefix and label for regex use', () => {
    // `+` is a regex metacharacter; must be escaped. Same applies if someone
    // ever adds a label with a regex-special char.
    expect(extractLabelLine('+Cc: alice@x', '+', 'Cc')).toBe('alice@x');
  });
});

describe('splitCommaRespectingQuotes', () => {
  it('splits a simple comma-separated list', () => {
    expect(splitCommaRespectingQuotes('a@x, b@y')).toEqual(['a@x', 'b@y']);
  });
  it('does not split inside quoted display names', () => {
    expect(splitCommaRespectingQuotes('"Doe, John" <j@x>, b@y'))
      .toEqual(['"Doe, John" <j@x>', 'b@y']);
  });
  it('does not split inside angle-bracket email parts', () => {
    // Pathological but harmless: a comma inside <...> stays with the entry.
    expect(splitCommaRespectingQuotes('Alice <a,x@y>')).toEqual(['Alice <a,x@y>']);
  });
  it('returns [] for empty input', () => {
    expect(splitCommaRespectingQuotes('')).toEqual([]);
    expect(splitCommaRespectingQuotes('   ')).toEqual([]);
  });
});

describe('splitNameAndEmail', () => {
  it('splits Name <email>', () => {
    expect(splitNameAndEmail('Alice <a@b.com>')).toEqual({ name: 'Alice', email: 'a@b.com' });
  });
  it('strips surrounding quotes from the name', () => {
    expect(splitNameAndEmail('"Doe, John" <j@x.com>')).toEqual({ name: 'Doe, John', email: 'j@x.com' });
  });
  it('returns bare email with empty name when no angle brackets', () => {
    expect(splitNameAndEmail('bare@example.com')).toEqual({ name: '', email: 'bare@example.com' });
  });
  it('handles <email> alone', () => {
    expect(splitNameAndEmail('<a@b.com>')).toEqual({ name: '', email: 'a@b.com' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TB-083: processSummaryResponse
// ═══════════════════════════════════════════════════════════════════════════
describe('processSummaryResponse', () => {
  it('TB-083a: parses full summary with todos, blurb, and reminder', () => {
    const input = [
      'Todos:',
      '1. Review the attached document',
      '2. Send feedback by Friday',
      '',
      'Two-line summary:',
      'Alice is requesting a review of the Q1 report.',
      'She needs feedback before the Friday deadline.',
      '',
      'Reminder due date: 2026-03-20',
      'Reminder due time: 14:00',
      'Reminder content: Review Q1 report and send feedback to Alice',
    ].join('\n');

    const result = processSummaryResponse(input);

    expect(result.todos).toContain('Review the attached document');
    expect(result.todos).toContain('Send feedback by Friday');
    expect(result.blurb).toContain('Alice');
    expect(result.blurb).toContain('Q1 report');
    expect(result.reminder).not.toBeNull();
    expect(result.reminder.dueDate).toBe('2026-03-20');
    expect(result.reminder.dueTime).toBe('14:00');
    expect(result.reminder.content).toContain('Review Q1 report');
  });

  it('TB-083b: handles summary without reminder', () => {
    const input = [
      'Todos:',
      '- Check the invoice',
      '',
      'Two-line summary:',
      'Bob sent an invoice for services rendered.',
      '',
      'Reminder due date: none',
      'Reminder due time: none',
      'Reminder content: none',
    ].join('\n');

    const result = processSummaryResponse(input);

    expect(result.todos).toContain('Check the invoice');
    expect(result.blurb).toContain('Bob');
    expect(result.reminder).toBeNull();
  });

  it('TB-083c: handles markdown heading markers (## Todos:)', () => {
    const input = [
      '## Todos:',
      '- Task one',
      '',
      '## Two-line summary:',
      'Summary text here.',
      '',
      '## Reminder due date: none',
      '## Reminder due time: none',
      '## Reminder content: none',
    ].join('\n');

    const result = processSummaryResponse(input);

    expect(result.todos).toContain('Task one');
    expect(result.blurb).toContain('Summary text');
  });

  it('TB-083d: normalizes bullet list items (strips prefixes)', () => {
    const input = [
      'Todos:',
      '1. First item',
      '2. Second item',
      '- Third item',
      '• Fourth item',
      '',
      'Two-line summary: Short summary.',
      'Reminder due date: none',
      'Reminder content: none',
    ].join('\n');

    const result = processSummaryResponse(input);

    // All items should be bullet-prefixed with •
    expect(result.todos).toContain('• First item');
    expect(result.todos).toContain('• Second item');
    expect(result.todos).toContain('• Third item');
    expect(result.todos).toContain('• Fourth item');
  });

  it('TB-083e: handles reminder with date but no time', () => {
    const input = [
      'Todos: Check schedule',
      'Two-line summary: Meeting reminder.',
      'Reminder due date: 2026-04-01',
      'Reminder content: Prepare for quarterly meeting',
    ].join('\n');

    const result = processSummaryResponse(input);

    expect(result.reminder).not.toBeNull();
    expect(result.reminder.dueDate).toBe('2026-04-01');
    expect(result.reminder.content).toContain('quarterly meeting');
  });

  it('TB-083f: empty todos section produces empty string', () => {
    const input = [
      'Todos:',
      '',
      'Two-line summary: Nothing to do.',
      'Reminder due date: none',
      'Reminder content: none',
    ].join('\n');

    const result = processSummaryResponse(input);
    expect(result.blurb).toContain('Nothing to do');
  });

  it('TB-083g: handles unusual whitespace in sections', () => {
    const input = [
      'Todos:   ',
      '  - Item with leading spaces',
      '',
      'Two-line summary:   Summary with trailing spaces.  ',
      'Reminder due date: none',
      'Reminder content: none',
    ].join('\n');

    const result = processSummaryResponse(input);
    expect(result.todos).toContain('Item with leading spaces');
    expect(result.blurb).toContain('Summary with trailing spaces');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TB-084: Conversation state management (via JSON round-trip)
// ═══════════════════════════════════════════════════════════════════════════
describe('TB-084: Response processing round-trip', () => {
  it('processJSONResponse preserves conversation state structure', () => {
    const state = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
      metadata: { sessionId: 'sess-123', turnCount: 3 },
    };

    const serialized = JSON.stringify(state);
    const result = processJSONResponse(serialized);

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe('system');
    expect(result.metadata.sessionId).toBe('sess-123');
    expect(result.metadata.turnCount).toBe(3);
  });

  it('processJSONResponse handles deeply nested objects', () => {
    const complex = {
      response: {
        choices: [
          {
            message: {
              content: 'Nested response',
              tool_calls: [
                {
                  function: {
                    name: 'test',
                    arguments: JSON.stringify({ nested: { deep: true } }),
                  },
                },
              ],
            },
          },
        ],
      },
    };

    const result = processJSONResponse(JSON.stringify(complex));
    expect(result.response.choices[0].message.content).toBe('Nested response');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TB-085: Resilient action parsing — regex fallback for truncated JSON
// Replicates the inline parsing logic from actionGenerator.js getAction()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mirrors the exact map callback from actionGenerator.js — processJSONResponse
 * first, then regex fallback for truncated responses.
 */
function parseActionResponse(assistantText) {
  const parsed = processJSONResponse(assistantText);
  if (parsed?.action) return parsed;
  // Regex fallback for truncated JSON
  const match = assistantText.match(/"action"\s*:\s*"(\w+)"/);
  if (match) return { action: match[1] };
  return null;
}

describe('TB-085: Resilient action parsing (regex fallback)', () => {
  it('TB-085a: valid JSON is parsed normally', () => {
    const result = parseActionResponse('{"action": "reply", "confidence": 0.95}');
    expect(result).toEqual({ action: 'reply', confidence: 0.95 });
  });

  it('TB-085b: truncated JSON with only action field is recovered via regex', () => {
    // Reasoning tokens exhausted the budget — JSON was cut mid-stream
    const truncated = '{"action": "archive", "confide';
    const result = parseActionResponse(truncated);
    expect(result).toEqual({ action: 'archive' });
  });

  it('TB-085c: truncated JSON cut after action value closing quote', () => {
    const truncated = '{"action": "delete",';
    const result = parseActionResponse(truncated);
    expect(result).toEqual({ action: 'delete' });
  });

  it('TB-085d: truncated JSON with no closing brace', () => {
    const truncated = '{"action": "none"';
    const result = parseActionResponse(truncated);
    expect(result).toEqual({ action: 'none' });
  });

  it('TB-085e: totally non-JSON text returns null', () => {
    const result = parseActionResponse('I think this email should be archived.');
    expect(result).toBeNull();
  });

  it('TB-085f: empty string returns null', () => {
    const result = parseActionResponse('');
    expect(result).toBeNull();
  });

  it('TB-085g: JSON with action inside markdown fences is parsed normally', () => {
    const fenced = '```json\n{"action": "reply"}\n```';
    const result = parseActionResponse(fenced);
    expect(result).toEqual({ action: 'reply' });
  });

  it('TB-085h: truncated JSON inside incomplete markdown fence falls back to regex', () => {
    // Fence opened but never closed, JSON also truncated
    const input = '```json\n{"action": "archive", "rea';
    const result = parseActionResponse(input);
    expect(result).toEqual({ action: 'archive' });
  });

  it('TB-085i: regex handles extra whitespace around colon', () => {
    const truncated = '{"action"  :  "delete"  ,  "co';
    const result = parseActionResponse(truncated);
    expect(result).toEqual({ action: 'delete' });
  });

  it('TB-085j: regex does not match empty action value', () => {
    const truncated = '{"action": ""';
    const result = parseActionResponse(truncated);
    // processJSONResponse fails (invalid JSON), regex \w+ requires 1+ chars
    expect(result).toBeNull();
  });

  it('TB-085k: valid JSON with action=null is not matched', () => {
    const input = '{"action": null}';
    const result = parseActionResponse(input);
    // parsed.action is null (falsy) → regex fallback → no match (null is not quoted)
    expect(result).toBeNull();
  });

  it('TB-085l: action field is not first — regex still finds it', () => {
    const truncated = '{"confidence": 0.8, "action": "reply", "reas';
    const result = parseActionResponse(truncated);
    expect(result).toEqual({ action: 'reply' });
  });

  it('TB-085m: multiple action fields — regex picks first occurrence', () => {
    // Pathological: two action keys. .match() returns first.
    const input = '{"action": "archive", "nested": {"action": "reply"';
    const result = parseActionResponse(input);
    expect(result).toEqual({ action: 'archive' });
  });

  it('TB-085n: all four valid action values work via regex fallback', () => {
    for (const action of ['reply', 'archive', 'delete', 'none']) {
      const truncated = `{"action": "${action}", "conf`;
      const result = parseActionResponse(truncated);
      expect(result).toEqual({ action });
    }
  });
});
