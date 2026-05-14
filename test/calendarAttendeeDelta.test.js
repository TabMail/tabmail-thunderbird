// calendarAttendeeDelta.test.js — Tests for delta-based attendee editing
// (calendar_event_edit-v1.5.21). The tool schema replaced whole-list `attendees`
// with `add_attendees` / `remove_attendees`; this file covers the pure-function
// merge helper.

import { describe, it, expect, vi } from 'vitest';

// Mock the import chain pulled in by ../chat/fsm/calendarEdit.js — calendarEdit
// transitively touches agent/modules/utils.js and agent/modules/config.js which
// reference `globalThis.browser` at module load time. We only exercise the pure
// applyAttendeeDelta export, so stub everything else out.
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => ({
    textContent: '',
    classList: { add: vi.fn(), remove: vi.fn() },
  })),
}));
vi.mock('../chat/modules/context.js', () => ({
  ctx: { fsmSessions: Object.create(null), activePid: 0, activeToolCallId: null },
}));
vi.mock('../chat/modules/converse.js', () => ({
  awaitUserInput: vi.fn(),
}));
vi.mock('../chat/modules/helpers.js', () => ({
  formatNaiveIsoInTimezone: vi.fn((iso) => iso),
  formatTimestampForAgent: vi.fn((d) => String(d)),
  streamText: vi.fn(),
}));
vi.mock('../chatlink/modules/fsm.js', () => ({
  relayFsmConfirmation: vi.fn(async () => {}),
}));

import { applyAttendeeDelta } from '../chat/fsm/calendarEdit.js';

describe('applyAttendeeDelta', () => {
  const A = { email: 'alice@example.com', name: 'Alice' };
  const B = { email: 'bob@example.com', name: 'Bob' };
  const C = { email: 'carol@example.com', name: 'Carol' };

  it('returns base unchanged when adds and removes are empty', () => {
    const result = applyAttendeeDelta([A, B], [], []);
    expect(result).toEqual([
      { email: 'alice@example.com', name: 'Alice' },
      { email: 'bob@example.com', name: 'Bob' },
    ]);
  });

  it('adds a new attendee to existing list', () => {
    const result = applyAttendeeDelta([A], [{ email: 'bob@example.com', name: 'Bob' }], []);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.email)).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('removes a specific attendee by email (case-insensitive)', () => {
    const result = applyAttendeeDelta([A, B], [], [{ email: 'BOB@EXAMPLE.COM' }]);
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('alice@example.com');
  });

  it('preserves existing attendees when only adding (the original bug)', () => {
    // The bug: passing `attendees: [C]` to whole-list-replace would have wiped
    // A and B. With delta semantics, A and B survive.
    const result = applyAttendeeDelta([A, B], [{ email: 'carol@example.com', name: 'Carol' }], []);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.email).sort()).toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
    ]);
  });

  it('dedupes adds that are already in base (case-insensitive)', () => {
    const result = applyAttendeeDelta(
      [A],
      [{ email: 'ALICE@example.com', name: 'Different Alice' }],
      []
    );
    expect(result).toHaveLength(1);
    // Base entry's name wins; the second-time name is dropped.
    expect(result[0].name).toBe('Alice');
  });

  it('clears all attendees when remove list contains "*"', () => {
    const result = applyAttendeeDelta([A, B, C], [], [{ email: '*' }]);
    expect(result).toEqual([]);
  });

  it('applies "*" clear-all BEFORE adds (so adds replace the whole list)', () => {
    const result = applyAttendeeDelta(
      [A, B],
      [{ email: 'carol@example.com', name: 'Carol' }],
      [{ email: '*' }]
    );
    expect(result).toEqual([{ email: 'carol@example.com', name: 'Carol' }]);
  });

  it('silently ignores removes that do not match any base entry', () => {
    const result = applyAttendeeDelta([A], [], [{ email: 'nonexistent@example.com' }]);
    expect(result).toEqual([{ email: 'alice@example.com', name: 'Alice' }]);
  });

  it('strips mailto: prefix from base, adds, and removes', () => {
    const base = [{ email: 'mailto:alice@example.com', name: 'Alice' }];
    const adds = [{ email: 'MAILTO:bob@example.com', name: 'Bob' }];
    const removes = [{ email: 'mailto:alice@example.com' }];
    const result = applyAttendeeDelta(base, adds, removes);
    expect(result).toEqual([{ email: 'bob@example.com', name: 'Bob' }]);
  });

  it('skips empty or "*"-only adds without crashing', () => {
    const result = applyAttendeeDelta([A], [{ email: '' }, { email: '*' }, { email: '   ' }], []);
    expect(result).toEqual([{ email: 'alice@example.com', name: 'Alice' }]);
  });

  it('handles non-array inputs defensively', () => {
    expect(applyAttendeeDelta(null, null, null)).toEqual([]);
    expect(applyAttendeeDelta(undefined, undefined, undefined)).toEqual([]);
  });

  it('treats remove list with both "*" and specific emails as full clear', () => {
    // "*" wins — entire base is dropped before adds run.
    const result = applyAttendeeDelta(
      [A, B],
      [{ email: 'carol@example.com', name: 'Carol' }],
      [{ email: 'alice@example.com' }, { email: '*' }]
    );
    expect(result).toEqual([{ email: 'carol@example.com', name: 'Carol' }]);
  });
});
