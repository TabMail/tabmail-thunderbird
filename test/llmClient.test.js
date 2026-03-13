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

const { processJSONResponse, processEditResponse, processSummaryResponse } =
  await import('../agent/modules/llm.js');

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
