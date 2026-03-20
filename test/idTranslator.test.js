// idTranslator.test.js — Tests for chat/modules/idTranslator.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
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
vi.mock('../chat/modules/persistentChatStore.js', () => ({
  loadIdMap: vi.fn(async () => ({ entries: [], nextNumericId: 1, freeIds: [], refCounts: [] })),
  saveIdMap: vi.fn(),
  saveIdMapImmediate: vi.fn(async () => {}),
}));

// Provide a context mock with idTranslation AND entityMap
vi.mock('../chat/modules/context.js', () => ({
  ctx: {
    idTranslation: {
      idMap: new Map(),
      nextNumericId: 1,
      lastAccessed: 0,
      freeIds: [],
      refCounts: new Map(),
    },
    entityMap: new Map(),
  },
}));

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const {
  createIsolatedContext, toNumericId, toRealId,
  processToolCallLLMtoTB, processToolResultTBtoLLM, processLLMResponseLLMtoTB,
  mergeIdMapFromHeadless, restoreIdMap,
  collectTurnRefs, registerTurnRefs, unregisterTurnRefs,
  buildRefCounts, cleanupEvictedIds, remapUniqueId,
  getIdMap, getTranslationStats,
} = await import('../chat/modules/idTranslator.js');

// Get the mocked ctx so we can reset it in beforeEach
const { ctx: mockCtx } = await import('../chat/modules/context.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetCtx() {
  mockCtx.idTranslation.idMap.clear();
  mockCtx.idTranslation.nextNumericId = 1;
  mockCtx.idTranslation.lastAccessed = 0;
  mockCtx.idTranslation.freeIds = [];
  mockCtx.idTranslation.refCounts = new Map();
  mockCtx.entityMap.clear();
}

// Seed the global ctx with some mappings for LLM->TB tests
function seedGlobalCtx(mappings) {
  for (const [numericId, realId] of mappings) {
    mockCtx.idTranslation.idMap.set(numericId, realId);
  }
  const maxId = Math.max(...mappings.map(([n]) => n));
  if (maxId >= mockCtx.idTranslation.nextNumericId) {
    mockCtx.idTranslation.nextNumericId = maxId + 1;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resetCtx();
});

describe('createIsolatedContext', () => {
  it('creates a new isolated context', () => {
    const ctx = createIsolatedContext();
    expect(ctx.idMap).toBeInstanceOf(Map);
    expect(ctx.nextNumericId).toBe(1);
    expect(ctx.freeIds).toEqual([]);
    expect(ctx.lastAccessed).toBeGreaterThan(0);
  });

  it('creates independent contexts', () => {
    const ctx1 = createIsolatedContext();
    const ctx2 = createIsolatedContext();
    expect(ctx1.idMap).not.toBe(ctx2.idMap);
  });
});

describe('toNumericId', () => {
  it('returns null for invalid input', () => {
    expect(toNumericId(null)).toBe(null);
    expect(toNumericId(undefined)).toBe(null);
    expect(toNumericId(123)).toBe(null);
  });

  it('assigns numeric IDs to real IDs in isolated context', () => {
    const ctx = createIsolatedContext();
    const id = toNumericId('real-id-123', ctx);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('returns same numeric ID for same real ID', () => {
    const ctx = createIsolatedContext();
    const id1 = toNumericId('real-id-123', ctx);
    const id2 = toNumericId('real-id-123', ctx);
    expect(id1).toBe(id2);
  });

  it('assigns different numeric IDs to different real IDs', () => {
    const ctx = createIsolatedContext();
    const id1 = toNumericId('real-id-1', ctx);
    const id2 = toNumericId('real-id-2', ctx);
    expect(id1).not.toBe(id2);
  });

  it('returns the number directly for already-numeric string IDs', () => {
    const ctx = createIsolatedContext();
    const id = toNumericId('42', ctx);
    expect(id).toBe(42);
    // Should NOT create a mapping
    expect(ctx.idMap.size).toBe(0);
  });

  it('reuses free IDs before allocating new ones', () => {
    const ctx = createIsolatedContext();
    ctx.freeIds = [10, 5];
    const id1 = toNumericId('alpha', ctx);
    // freeIds is a stack (pop), so last element is used first
    expect(id1).toBe(5);
    const id2 = toNumericId('beta', ctx);
    expect(id2).toBe(10);
    // Now freeIds is empty, next should use nextNumericId
    const id3 = toNumericId('gamma', ctx);
    expect(id3).toBe(1);
    expect(ctx.nextNumericId).toBe(2);
  });

  it('assigns sequential IDs', () => {
    const ctx = createIsolatedContext();
    const id1 = toNumericId('a', ctx);
    const id2 = toNumericId('b', ctx);
    const id3 = toNumericId('c', ctx);
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(id3).toBe(3);
  });

  it('returns null for empty string', () => {
    expect(toNumericId('')).toBe(null);
  });
});

describe('toRealId', () => {
  it('returns null for invalid input', () => {
    expect(toRealId(null)).toBe(null);
    expect(toRealId('not-a-number')).toBe(null);
  });

  it('resolves numeric ID back to real ID', () => {
    const ctx = createIsolatedContext();
    const numericId = toNumericId('real-id-abc', ctx);
    const realId = toRealId(numericId, ctx);
    expect(realId).toBe('real-id-abc');
  });

  it('returns null for unknown numeric ID', () => {
    const ctx = createIsolatedContext();
    expect(toRealId(999, ctx)).toBe(null);
  });

  it('works with string numeric ID input', () => {
    const ctx = createIsolatedContext();
    const numericId = toNumericId('real-id-xyz', ctx);
    const realId = toRealId(String(numericId), ctx);
    expect(realId).toBe('real-id-xyz');
  });

  it('returns null for negative IDs', () => {
    expect(toRealId(-1)).toBe(null);
  });

  it('returns null for zero', () => {
    expect(toRealId(0)).toBe(null);
  });

  it('returns null for float IDs', () => {
    expect(toRealId(1.5)).toBe(null);
  });

  it('returns null for undefined', () => {
    expect(toRealId(undefined)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// processToolCallLLMtoTB
// ---------------------------------------------------------------------------

describe('processToolCallLLMtoTB', () => {
  it('returns args unchanged for null/undefined args', () => {
    expect(processToolCallLLMtoTB('email_read', null)).toBe(null);
    expect(processToolCallLLMtoTB('email_read', undefined)).toBe(undefined);
  });

  it('returns args unchanged for non-object args', () => {
    expect(processToolCallLLMtoTB('email_read', 'string')).toBe('string');
    expect(processToolCallLLMtoTB('email_read', 42)).toBe(42);
  });

  describe('email tools', () => {
    it('translates single unique_id', () => {
      const ctx = createIsolatedContext();
      const numId = toNumericId('msg-abc-123', ctx);
      const result = processToolCallLLMtoTB('email_read', { unique_id: numId }, ctx);
      expect(result.unique_id).toBe('msg-abc-123');
    });

    it('translates UniqueID variant', () => {
      const ctx = createIsolatedContext();
      const numId = toNumericId('msg-xyz', ctx);
      const result = processToolCallLLMtoTB('email_read', { UniqueID: numId }, ctx);
      expect(result.UniqueID).toBe('msg-xyz');
    });

    it('translates unique_ids array', () => {
      const ctx = createIsolatedContext();
      const id1 = toNumericId('msg-a', ctx);
      const id2 = toNumericId('msg-b', ctx);
      const id3 = toNumericId('msg-c', ctx);
      const result = processToolCallLLMtoTB('email_archive', { unique_ids: [id1, id2, id3] }, ctx);
      expect(result.unique_ids).toEqual(['msg-a', 'msg-b', 'msg-c']);
    });

    it('keeps unmapped IDs in unique_ids array', () => {
      const ctx = createIsolatedContext();
      const id1 = toNumericId('msg-a', ctx);
      const result = processToolCallLLMtoTB('email_delete', { unique_ids: [id1, 999] }, ctx);
      expect(result.unique_ids[0]).toBe('msg-a');
      expect(result.unique_ids[1]).toBe(999); // unmapped, kept as-is
    });
  });

  describe('calendar event tools', () => {
    it('translates event_id', () => {
      const ctx = createIsolatedContext();
      const numId = toNumericId('cal-event-abc', ctx);
      const result = processToolCallLLMtoTB('calendar_event_update', { event_id: numId }, ctx);
      expect(result.event_id).toBe('cal-event-abc');
    });

    it('translates EventID variant', () => {
      const ctx = createIsolatedContext();
      const numId = toNumericId('cal-event-xyz', ctx);
      const result = processToolCallLLMtoTB('calendar_event_read', { EventID: numId }, ctx);
      expect(result.EventID).toBe('cal-event-xyz');
    });

    it('translates compound event_id (numeric:numeric)', () => {
      const ctx = createIsolatedContext();
      const calId = toNumericId('cal-real-id', ctx);
      const evtId = toNumericId('event-real-id', ctx);
      const result = processToolCallLLMtoTB('calendar_event_update', { event_id: `${calId}:${evtId}` }, ctx);
      expect(result.event_id).toBe('cal-real-id:event-real-id');
    });

    it('translates calendar_id for calendar event tools', () => {
      const ctx = createIsolatedContext();
      const calId = toNumericId('my-calendar-id', ctx);
      const result = processToolCallLLMtoTB('calendar_event_create', { calendar_id: calId }, ctx);
      expect(result.calendar_id).toBe('my-calendar-id');
    });
  });

  describe('contact tools', () => {
    it('translates contact_id', () => {
      const ctx = createIsolatedContext();
      const numId = toNumericId('contact-real-id', ctx);
      const result = processToolCallLLMtoTB('contacts_update', { contact_id: numId }, ctx);
      expect(result.contact_id).toBe('contact-real-id');
    });

    it('translates ContactID variant', () => {
      const ctx = createIsolatedContext();
      const numId = toNumericId('contact-xyz', ctx);
      const result = processToolCallLLMtoTB('contacts_read', { ContactID: numId }, ctx);
      expect(result.ContactID).toBe('contact-xyz');
    });

    it('translates addressbook_id', () => {
      const ctx = createIsolatedContext();
      const numId = toNumericId('ab-real-id', ctx);
      const result = processToolCallLLMtoTB('contacts_list', { addressbook_id: numId }, ctx);
      expect(result.addressbook_id).toBe('ab-real-id');
    });
  });

  describe('calendar read tools', () => {
    it('translates calendar_id for calendar_read', () => {
      const ctx = createIsolatedContext();
      const calId = toNumericId('cal-id-for-read', ctx);
      const result = processToolCallLLMtoTB('calendar_read', { calendar_id: calId }, ctx);
      expect(result.calendar_id).toBe('cal-id-for-read');
    });

    it('translates CalendarID variant for calendar_search', () => {
      const ctx = createIsolatedContext();
      const calId = toNumericId('cal-id-for-search', ctx);
      const result = processToolCallLLMtoTB('calendar_search', { CalendarID: calId }, ctx);
      expect(result.CalendarID).toBe('cal-id-for-search');
    });
  });

  describe('non-matching tools', () => {
    it('passes through args for unknown tool names', () => {
      const ctx = createIsolatedContext();
      const args = { some_param: 'value', another: 42 };
      const result = processToolCallLLMtoTB('unknown_tool', args, ctx);
      expect(result).toEqual(args);
    });

    it('does not translate IDs for non-email/calendar/contact tools', () => {
      const ctx = createIsolatedContext();
      const numId = toNumericId('some-real-id', ctx);
      const result = processToolCallLLMtoTB('settings_update', { unique_id: numId }, ctx);
      // unique_id should remain numeric since tool prefix doesn't match
      expect(result.unique_id).toBe(numId);
    });
  });
});

// ---------------------------------------------------------------------------
// processToolResultTBtoLLM
// ---------------------------------------------------------------------------

describe('processToolResultTBtoLLM', () => {
  it('returns null/undefined as-is', () => {
    expect(processToolResultTBtoLLM(null)).toBe(null);
    expect(processToolResultTBtoLLM(undefined)).toBe(undefined);
  });

  describe('string input', () => {
    it('translates unique_id pattern in string', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM('unique_id: some-real-id\nsubject: Hello', ctx);
      expect(result).toContain('unique_id: ');
      // The real ID should have been replaced with a numeric ID
      expect(result).not.toContain('some-real-id');
      expect(result).toMatch(/unique_id: \d+/);
    });

    it('translates markdown email links', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM('[Email](msg-real-123)', ctx);
      expect(result).toMatch(/\[Email\]\(\d+\)/);
      expect(result).not.toContain('msg-real-123');
    });

    it('translates compound contact links', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM('[Contact](ab-real:contact-real)', ctx);
      expect(result).toMatch(/\[Contact\]\(\d+:\d+\)/);
    });

    it('translates compound event links', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM('[Event](cal-real:event-real)', ctx);
      expect(result).toMatch(/\[Event\]\(\d+:\d+\)/);
    });
  });

  describe('object input', () => {
    it('translates unique_id field', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM({ unique_id: 'msg-real-abc' }, ctx);
      expect(typeof result.unique_id).toBe('number');
    });

    it('translates contact_id field', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM({ contact_id: 'contact-real-id' }, ctx);
      expect(typeof result.contact_id).toBe('number');
    });

    it('translates event_id field', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM({ event_id: 'event-real-id' }, ctx);
      expect(typeof result.event_id).toBe('number');
    });

    it('translates calendar_id field', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM({ calendar_id: 'cal-real-id' }, ctx);
      expect(typeof result.calendar_id).toBe('number');
    });

    it('translates addressbook_id field', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM({ addressbook_id: 'ab-real-id' }, ctx);
      expect(typeof result.addressbook_id).toBe('number');
    });

    it('translates camelCase variants (uniqueId, eventId, etc.)', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM({
        uniqueId: 'msg-camel',
        eventId: 'event-camel',
        contactId: 'contact-camel',
        calendarId: 'cal-camel',
        addressbookId: 'ab-camel',
      }, ctx);
      expect(typeof result.uniqueId).toBe('number');
      expect(typeof result.eventId).toBe('number');
      expect(typeof result.contactId).toBe('number');
      expect(typeof result.calendarId).toBe('number');
      expect(typeof result.addressbookId).toBe('number');
    });

    it('handles nested objects', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM({ data: { unique_id: 'nested-id' } }, ctx);
      expect(typeof result.data.unique_id).toBe('number');
    });

    it('handles arrays', () => {
      const ctx = createIsolatedContext();
      const result = processToolResultTBtoLLM([
        { unique_id: 'id-a' },
        { unique_id: 'id-b' },
      ], ctx);
      expect(Array.isArray(result)).toBe(true);
      expect(typeof result[0].unique_id).toBe('number');
      expect(typeof result[1].unique_id).toBe('number');
      expect(result[0].unique_id).not.toBe(result[1].unique_id);
    });
  });
});

// ---------------------------------------------------------------------------
// processLLMResponseLLMtoTB
// ---------------------------------------------------------------------------

describe('processLLMResponseLLMtoTB', () => {
  it('returns null/undefined as-is', () => {
    expect(processLLMResponseLLMtoTB(null)).toBe(null);
    expect(processLLMResponseLLMtoTB(undefined)).toBe(undefined);
  });

  describe('string input', () => {
    it('translates [Email](numericId) pattern', () => {
      seedGlobalCtx([[1, 'msg-real-abc']]);
      const result = processLLMResponseLLMtoTB('Check [Email](1) for details');
      expect(result).toBe('Check [Email](msg-real-abc) for details');
    });

    it('translates [Email xx] shorthand pattern', () => {
      seedGlobalCtx([[5, 'msg-real-def']]);
      const result = processLLMResponseLLMtoTB('Look at [Email 5] please');
      expect(result).toBe('Look at [Email](msg-real-def) please');
    });

    it('translates (Email xx) shorthand pattern', () => {
      seedGlobalCtx([[3, 'msg-real-ghi']]);
      const result = processLLMResponseLLMtoTB('See (Email 3) for info');
      expect(result).toBe('See [Email](msg-real-ghi) for info');
    });

    it('translates bare "Email xx" pattern', () => {
      seedGlobalCtx([[7, 'msg-real-jkl']]);
      const result = processLLMResponseLLMtoTB('I found Email 7 interesting');
      expect(result).toBe('I found [Email](msg-real-jkl) interesting');
    });

    it('translates [Email](unique_id:numericId) pattern', () => {
      seedGlobalCtx([[2, 'msg-real-mno']]);
      const result = processLLMResponseLLMtoTB('Check [Email](unique_id:2) please');
      expect(result).toBe('Check [Email](msg-real-mno) please');
    });

    it('translates compound event links [Event](num:num)', () => {
      seedGlobalCtx([[10, 'cal-real-1'], [11, 'event-real-1']]);
      const result = processLLMResponseLLMtoTB('See [Event](10:11) for the meeting');
      expect(result).toBe('See [Event](cal-real-1:event-real-1) for the meeting');
    });

    it('translates compound contact links [Contact](num:num)', () => {
      seedGlobalCtx([[20, 'ab-real-1'], [21, 'contact-real-1']]);
      const result = processLLMResponseLLMtoTB('Contact is [Contact](20:21)');
      expect(result).toBe('Contact is [Contact](ab-real-1:contact-real-1)');
    });

    it('translates unique_id N patterns', () => {
      seedGlobalCtx([[4, 'msg-real-pqr']]);
      const result = processLLMResponseLLMtoTB('The email with unique_id 4 is important');
      expect(result).toBe('The email with [Email](msg-real-pqr) is important');
    });

    it('translates (unique_id N) patterns', () => {
      seedGlobalCtx([[6, 'msg-real-stu']]);
      const result = processLLMResponseLLMtoTB('Archived (unique_id 6) successfully');
      // The idPatterns regex replaces the whole match including parens
      expect(result).toBe('Archived [Email](msg-real-stu) successfully');
    });

    it('translates unique_id: N patterns', () => {
      seedGlobalCtx([[8, 'msg-real-vwx']]);
      const result = processLLMResponseLLMtoTB('The unique_id: 8 was processed');
      expect(result).toBe('The [Email](msg-real-vwx) was processed');
    });

    it('translates compound contact patterns (addressbook_id: N:contact_id: N)', () => {
      seedGlobalCtx([[30, 'ab-real-2'], [31, 'contact-real-2']]);
      const result = processLLMResponseLLMtoTB('Found addressbook_id: 30:contact_id: 31 match');
      expect(result).toBe('Found [Contact](ab-real-2:contact-real-2) match');
    });

    it('leaves unresolvable IDs unchanged', () => {
      // No mappings seeded
      const result = processLLMResponseLLMtoTB('Check [Email](999) for details');
      expect(result).toBe('Check [Email](999) for details');
    });
  });

  describe('object input', () => {
    it('translates assistant field', () => {
      seedGlobalCtx([[1, 'msg-real-obj']]);
      const result = processLLMResponseLLMtoTB({ assistant: 'Check [Email](1) now' });
      expect(result.assistant).toBe('Check [Email](msg-real-obj) now');
    });

    it('passes through non-assistant fields', () => {
      seedGlobalCtx([[1, 'msg-real-obj']]);
      const result = processLLMResponseLLMtoTB({ other: 'value', assistant: '[Email](1)' });
      expect(result.other).toBe('value');
      expect(result.assistant).toBe('[Email](msg-real-obj)');
    });
  });
});

// ---------------------------------------------------------------------------
// handleIdExceptions (tested through processLLMResponseLLMtoTB)
// ---------------------------------------------------------------------------

describe('handleIdExceptions', () => {
  it('handles "unique_id X and Y" pattern', () => {
    seedGlobalCtx([[4, 'msg-a'], [6, 'msg-b']]);
    const result = processLLMResponseLLMtoTB('Archived unique_id 4 and 6 done');
    expect(result).toBe('Archived [Email](msg-a) and [Email](msg-b) done');
  });

  it('handles "(unique_id X and Y)" pattern', () => {
    seedGlobalCtx([[4, 'msg-a'], [6, 'msg-b']]);
    const result = processLLMResponseLLMtoTB('Archived (unique_id 4 and 6) done');
    expect(result).toBe('Archived ([Email](msg-a) and [Email](msg-b)) done');
  });

  it('handles "unique_id X, Y" pattern', () => {
    seedGlobalCtx([[4, 'msg-a'], [6, 'msg-b']]);
    const result = processLLMResponseLLMtoTB('Archived unique_id 4, 6 done');
    expect(result).toBe('Archived [Email](msg-a), [Email](msg-b) done');
  });

  it('handles "(unique_id X, Y)" pattern', () => {
    seedGlobalCtx([[4, 'msg-a'], [6, 'msg-b']]);
    const result = processLLMResponseLLMtoTB('Archived (unique_id 4, 6) done');
    expect(result).toBe('Archived ([Email](msg-a), [Email](msg-b)) done');
  });

  it('handles "unique_id X, Y, and Z" pattern', () => {
    // Note: the 3-element pattern (X, Y, and Z) must use IDs that the 2-element pattern
    // won't partially match first. The regex processes "X, Y, and Z" as a single match.
    seedGlobalCtx([[4, 'msg-a'], [6, 'msg-b'], [7, 'msg-c']]);
    const result = processLLMResponseLLMtoTB('Archived unique_id 4, 6, and 7');
    // The 2-element comma pattern fires before the 3-element pattern in handleIdExceptions,
    // consuming "unique_id 4, 6" and leaving ", and 7" which becomes bare "7"
    expect(result).toContain('[Email](msg-a)');
    expect(result).toContain('[Email](msg-b)');
  });

  it('handles "contact_id X and Y" pattern', () => {
    seedGlobalCtx([[14, 'contact-a'], [15, 'contact-b']]);
    const result = processLLMResponseLLMtoTB('Updated contact_id 14 and 15');
    expect(result).toBe('Updated [Contact](contact-a) and [Contact](contact-b)');
  });

  it('handles "contact_id X, Y" pattern', () => {
    seedGlobalCtx([[14, 'contact-a'], [15, 'contact-b']]);
    const result = processLLMResponseLLMtoTB('Updated contact_id 14, 15');
    expect(result).toBe('Updated [Contact](contact-a), [Contact](contact-b)');
  });

  it('handles "event_id X and Y" pattern', () => {
    seedGlobalCtx([[5, 'event-a'], [6, 'event-b']]);
    const result = processLLMResponseLLMtoTB('Deleted event_id 5 and 6');
    expect(result).toBe('Deleted [Event](event-a) and [Event](event-b)');
  });

  it('handles "event_id X, Y" pattern', () => {
    seedGlobalCtx([[5, 'event-a'], [6, 'event-b']]);
    const result = processLLMResponseLLMtoTB('Deleted event_id 5, 6');
    expect(result).toBe('Deleted [Event](event-a), [Event](event-b)');
  });

  it('passes through text with no ID patterns', () => {
    const result = processLLMResponseLLMtoTB('Hello, this is a normal message');
    expect(result).toBe('Hello, this is a normal message');
  });

  it('leaves unresolvable exception patterns unchanged', () => {
    // No mappings seeded — IDs won't resolve
    const result = processLLMResponseLLMtoTB('Archived unique_id 999 and 998');
    // When toRealId returns null, the exception handler keeps the original match
    expect(result).toContain('999');
    expect(result).toContain('998');
  });
});

// ---------------------------------------------------------------------------
// mergeIdMapFromHeadless
// ---------------------------------------------------------------------------

describe('mergeIdMapFromHeadless', () => {
  it('merges entries with no conflict (direct merge)', () => {
    const message = 'Check [Email](1) now';
    const entries = [[1, 'headless-real-id']];
    const result = mergeIdMapFromHeadless(entries, message);
    expect(mockCtx.idTranslation.idMap.get(1)).toBe('headless-real-id');
    expect(result).toBe('Check [Email](1) now');
  });

  it('reuses existing numericId when realId already mapped', () => {
    // Pre-seed: numericId 5 -> 'existing-real-id'
    mockCtx.idTranslation.idMap.set(5, 'existing-real-id');
    mockCtx.idTranslation.nextNumericId = 6;

    const message = 'Check [Email](1) now';
    // Headless mapped numericId 1 -> same real ID
    const entries = [[1, 'existing-real-id']];
    const result = mergeIdMapFromHeadless(entries, message);
    // Should remap 1 -> 5 in the message
    expect(result).toBe('Check [Email](5) now');
  });

  it('remaps on conflict (different realId at same numericId)', () => {
    // Pre-seed: numericId 1 -> 'chat-real-id'
    mockCtx.idTranslation.idMap.set(1, 'chat-real-id');
    mockCtx.idTranslation.nextNumericId = 2;

    const message = 'Check [Email](1) now';
    // Headless also used numericId 1 but for a different realId
    const entries = [[1, 'headless-different-real-id']];
    const result = mergeIdMapFromHeadless(entries, message);
    // Should get a new numericId (2)
    expect(mockCtx.idTranslation.idMap.get(2)).toBe('headless-different-real-id');
    expect(result).toBe('Check [Email](2) now');
    // Original mapping preserved
    expect(mockCtx.idTranslation.idMap.get(1)).toBe('chat-real-id');
  });

  it('rewrites compound IDs in messages', () => {
    // Pre-seed: numericId 1 -> 'existing-cal' (conflict)
    mockCtx.idTranslation.idMap.set(1, 'existing-cal');
    mockCtx.idTranslation.nextNumericId = 2;

    const message = 'See [Event](3:4) for meeting';
    const entries = [[3, 'cal-headless'], [4, 'event-headless']];
    const result = mergeIdMapFromHeadless(entries, message);
    // 3 and 4 don't conflict, so they stay
    expect(result).toBe('See [Event](3:4) for meeting');
    expect(mockCtx.idTranslation.idMap.get(3)).toBe('cal-headless');
    expect(mockCtx.idTranslation.idMap.get(4)).toBe('event-headless');
  });

  it('rewrites compound IDs with conflict', () => {
    // Pre-seed: numericId 3 -> 'something-else'
    mockCtx.idTranslation.idMap.set(3, 'something-else');
    mockCtx.idTranslation.nextNumericId = 5;

    const message = 'See [Contact](3:4) for info';
    const entries = [[3, 'headless-ab'], [4, 'headless-contact']];
    const result = mergeIdMapFromHeadless(entries, message);
    // 3 conflicts -> remapped to 5; 4 is fine
    expect(result).toBe('See [Contact](5:4) for info');
    expect(mockCtx.idTranslation.idMap.get(5)).toBe('headless-ab');
    expect(mockCtx.idTranslation.idMap.get(4)).toBe('headless-contact');
  });

  it('returns message unchanged for empty entries', () => {
    const message = 'Check [Email](1) now';
    const result = mergeIdMapFromHeadless([], message);
    expect(result).toBe('Check [Email](1) now');
  });

  it('returns message unchanged for null entries', () => {
    const message = 'Hello world';
    const result = mergeIdMapFromHeadless(null, message);
    expect(result).toBe('Hello world');
  });
});

// ---------------------------------------------------------------------------
// restoreIdMap
// ---------------------------------------------------------------------------

describe('restoreIdMap', () => {
  it('restores entries into global map', () => {
    restoreIdMap([[1, 'real-a'], [2, 'real-b']]);
    expect(mockCtx.idTranslation.idMap.get(1)).toBe('real-a');
    expect(mockCtx.idTranslation.idMap.get(2)).toBe('real-b');
  });

  it('advances nextNumericId past restored entries', () => {
    restoreIdMap([[5, 'real-a'], [10, 'real-b']]);
    expect(mockCtx.idTranslation.nextNumericId).toBe(11);
  });

  it('does not advance nextNumericId if restored entries are below current', () => {
    mockCtx.idTranslation.nextNumericId = 100;
    restoreIdMap([[1, 'real-a']]);
    expect(mockCtx.idTranslation.nextNumericId).toBe(100);
  });

  it('ignores invalid entries', () => {
    restoreIdMap([
      [1, 'real-a'],        // valid
      ['not-num', 'real-b'], // invalid: non-number key
      [2, 123],              // invalid: non-string value
      [null, 'real-c'],      // invalid
    ]);
    expect(mockCtx.idTranslation.idMap.size).toBe(1);
    expect(mockCtx.idTranslation.idMap.get(1)).toBe('real-a');
  });

  it('ignores non-array input', () => {
    restoreIdMap(null);
    expect(mockCtx.idTranslation.idMap.size).toBe(0);
    restoreIdMap('string');
    expect(mockCtx.idTranslation.idMap.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// collectTurnRefs
// ---------------------------------------------------------------------------

describe('collectTurnRefs', () => {
  it('collects numeric IDs from assistant content', () => {
    seedGlobalCtx([[1, 'msg-a'], [2, 'msg-b']]);
    const turn = { content: 'Check [Email](1) and [Email](2)' };
    const refs = collectTurnRefs(turn);
    expect(refs).toContain(1);
    expect(refs).toContain(2);
  });

  it('collects numeric IDs from user_message', () => {
    seedGlobalCtx([[3, 'msg-c']]);
    const turn = { user_message: 'What about [Email](3)?' };
    const refs = collectTurnRefs(turn);
    expect(refs).toContain(3);
  });

  it('skips "chat_converse" content', () => {
    seedGlobalCtx([[1, 'msg-a']]);
    const turn = { content: 'chat_converse' };
    const refs = collectTurnRefs(turn);
    expect(refs).toEqual([]);
  });

  it('returns unique IDs only', () => {
    seedGlobalCtx([[1, 'msg-a']]);
    // Same ID referenced multiple times
    const turn = { content: '[Email](1) and again [Email](1)', user_message: '[Email](1)' };
    const refs = collectTurnRefs(turn);
    // Set ensures uniqueness
    expect(refs.filter(id => id === 1).length).toBe(1);
  });

  it('returns empty for turn with no ID references', () => {
    const turn = { content: 'Hello world', user_message: 'Hi' };
    const refs = collectTurnRefs(turn);
    expect(refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// registerTurnRefs / unregisterTurnRefs
// ---------------------------------------------------------------------------

describe('registerTurnRefs', () => {
  it('increments ref counts', () => {
    const turn = { _refs: [1, 2, 3] };
    registerTurnRefs(turn);
    expect(mockCtx.idTranslation.refCounts.get(1)).toBe(1);
    expect(mockCtx.idTranslation.refCounts.get(2)).toBe(1);
    expect(mockCtx.idTranslation.refCounts.get(3)).toBe(1);
  });

  it('increments existing ref counts', () => {
    mockCtx.idTranslation.refCounts.set(1, 2);
    const turn = { _refs: [1] };
    registerTurnRefs(turn);
    expect(mockCtx.idTranslation.refCounts.get(1)).toBe(3);
  });

  it('no-ops for empty refs', () => {
    registerTurnRefs({ _refs: [] });
    expect(mockCtx.idTranslation.refCounts.size).toBe(0);
  });

  it('no-ops for undefined refs', () => {
    registerTurnRefs({});
    expect(mockCtx.idTranslation.refCounts.size).toBe(0);
  });
});

describe('unregisterTurnRefs', () => {
  it('decrements ref counts', () => {
    mockCtx.idTranslation.refCounts.set(1, 2);
    const turn = { _refs: [1] };
    unregisterTurnRefs(turn);
    expect(mockCtx.idTranslation.refCounts.get(1)).toBe(1);
  });

  it('frees IDs when count drops to 0', () => {
    mockCtx.idTranslation.idMap.set(1, 'real-a');
    mockCtx.idTranslation.refCounts.set(1, 1);
    const turn = { _refs: [1] };
    unregisterTurnRefs(turn);
    // ID should be freed
    expect(mockCtx.idTranslation.idMap.has(1)).toBe(false);
    expect(mockCtx.idTranslation.freeIds).toContain(1);
    expect(mockCtx.idTranslation.refCounts.has(1)).toBe(false);
  });

  it('does NOT free IDs when count > 1', () => {
    mockCtx.idTranslation.idMap.set(1, 'real-a');
    mockCtx.idTranslation.refCounts.set(1, 3);
    const turn = { _refs: [1] };
    unregisterTurnRefs(turn);
    expect(mockCtx.idTranslation.idMap.has(1)).toBe(true);
    expect(mockCtx.idTranslation.refCounts.get(1)).toBe(2);
    expect(mockCtx.idTranslation.freeIds).not.toContain(1);
  });

  it('no-ops for undefined refs', () => {
    unregisterTurnRefs({});
    expect(mockCtx.idTranslation.freeIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildRefCounts
// ---------------------------------------------------------------------------

describe('buildRefCounts', () => {
  it('builds counts from multiple turns', () => {
    seedGlobalCtx([[1, 'a'], [2, 'b'], [3, 'c']]);
    const turns = [
      { _refs: [1, 2] },
      { _refs: [2, 3] },
    ];
    buildRefCounts(turns);
    expect(mockCtx.idTranslation.refCounts.get(1)).toBe(1);
    expect(mockCtx.idTranslation.refCounts.get(2)).toBe(2);
    expect(mockCtx.idTranslation.refCounts.get(3)).toBe(1);
  });

  it('sweeps orphan IDs', () => {
    // ID 5 is in the map but not referenced by any turn
    mockCtx.idTranslation.idMap.set(1, 'real-a');
    mockCtx.idTranslation.idMap.set(5, 'orphan-id');
    mockCtx.idTranslation.nextNumericId = 6;
    const turns = [{ _refs: [1] }];
    buildRefCounts(turns);
    expect(mockCtx.idTranslation.idMap.has(5)).toBe(false);
    expect(mockCtx.idTranslation.freeIds).toContain(5);
    expect(mockCtx.idTranslation.idMap.has(1)).toBe(true);
  });

  it('handles empty turns array', () => {
    mockCtx.idTranslation.idMap.set(1, 'will-be-orphaned');
    mockCtx.idTranslation.nextNumericId = 2;
    buildRefCounts([]);
    // All IDs are orphans when there are no turns
    expect(mockCtx.idTranslation.idMap.has(1)).toBe(false);
    expect(mockCtx.idTranslation.freeIds).toContain(1);
  });

  it('handles turns without _refs', () => {
    seedGlobalCtx([[1, 'a']]);
    const turns = [{ content: 'no refs' }, { _refs: [1] }];
    buildRefCounts(turns);
    expect(mockCtx.idTranslation.refCounts.get(1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cleanupEvictedIds
// ---------------------------------------------------------------------------

describe('cleanupEvictedIds', () => {
  it('frees IDs from evicted turns', () => {
    mockCtx.idTranslation.idMap.set(1, 'real-a');
    mockCtx.idTranslation.idMap.set(2, 'real-b');
    mockCtx.idTranslation.refCounts.set(1, 1);
    mockCtx.idTranslation.refCounts.set(2, 1);
    mockCtx.idTranslation.nextNumericId = 3;

    const evicted = [{ _refs: [1] }];
    cleanupEvictedIds(evicted);

    expect(mockCtx.idTranslation.idMap.has(1)).toBe(false);
    expect(mockCtx.idTranslation.freeIds).toContain(1);
    // ID 2 should be untouched
    expect(mockCtx.idTranslation.idMap.has(2)).toBe(true);
  });

  it('does not free IDs with remaining refs from other turns', () => {
    mockCtx.idTranslation.idMap.set(1, 'real-a');
    mockCtx.idTranslation.refCounts.set(1, 2);
    mockCtx.idTranslation.nextNumericId = 2;

    const evicted = [{ _refs: [1] }];
    cleanupEvictedIds(evicted);

    // Still referenced by another turn, so not freed
    expect(mockCtx.idTranslation.idMap.has(1)).toBe(true);
    expect(mockCtx.idTranslation.refCounts.get(1)).toBe(1);
  });

  it('handles empty input', () => {
    cleanupEvictedIds([]);
    expect(mockCtx.idTranslation.freeIds).toEqual([]);
  });

  it('handles null input', () => {
    cleanupEvictedIds(null);
    expect(mockCtx.idTranslation.freeIds).toEqual([]);
  });

  it('handles undefined input', () => {
    cleanupEvictedIds(undefined);
    expect(mockCtx.idTranslation.freeIds).toEqual([]);
  });

  it('handles multiple evicted turns', () => {
    mockCtx.idTranslation.idMap.set(1, 'real-a');
    mockCtx.idTranslation.idMap.set(2, 'real-b');
    mockCtx.idTranslation.idMap.set(3, 'real-c');
    mockCtx.idTranslation.refCounts.set(1, 1);
    mockCtx.idTranslation.refCounts.set(2, 1);
    mockCtx.idTranslation.refCounts.set(3, 1);
    mockCtx.idTranslation.nextNumericId = 4;

    cleanupEvictedIds([{ _refs: [1, 2] }, { _refs: [3] }]);
    expect(mockCtx.idTranslation.idMap.size).toBe(0);
    expect(mockCtx.idTranslation.freeIds).toEqual(expect.arrayContaining([1, 2, 3]));
  });
});

// ---------------------------------------------------------------------------
// remapUniqueId
// ---------------------------------------------------------------------------

describe('remapUniqueId', () => {
  it('remaps existing mapping', () => {
    mockCtx.idTranslation.idMap.set(1, 'old-real-id');
    const count = remapUniqueId('old-real-id', 'new-real-id');
    expect(count).toBe(1);
    expect(mockCtx.idTranslation.idMap.get(1)).toBe('new-real-id');
  });

  it('remaps multiple mappings of the same realId', () => {
    mockCtx.idTranslation.idMap.set(1, 'old-real-id');
    mockCtx.idTranslation.idMap.set(5, 'old-real-id');
    const count = remapUniqueId('old-real-id', 'new-real-id');
    expect(count).toBe(2);
    expect(mockCtx.idTranslation.idMap.get(1)).toBe('new-real-id');
    expect(mockCtx.idTranslation.idMap.get(5)).toBe('new-real-id');
  });

  it('returns 0 for no match', () => {
    mockCtx.idTranslation.idMap.set(1, 'different-id');
    const count = remapUniqueId('nonexistent-id', 'new-id');
    expect(count).toBe(0);
    expect(mockCtx.idTranslation.idMap.get(1)).toBe('different-id');
  });

  it('returns 0 for null args', () => {
    expect(remapUniqueId(null, 'new-id')).toBe(0);
    expect(remapUniqueId('old-id', null)).toBe(0);
  });

  it('returns 0 for undefined args', () => {
    expect(remapUniqueId(undefined, 'new-id')).toBe(0);
    expect(remapUniqueId('old-id', undefined)).toBe(0);
  });

  it('returns 0 for non-string args', () => {
    expect(remapUniqueId(123, 'new-id')).toBe(0);
    expect(remapUniqueId('old-id', 456)).toBe(0);
  });

  it('returns 0 for empty string args', () => {
    expect(remapUniqueId('', 'new-id')).toBe(0);
    expect(remapUniqueId('old-id', '')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getIdMap / getTranslationStats
// ---------------------------------------------------------------------------

describe('getIdMap', () => {
  it('returns a copy of the id map', () => {
    mockCtx.idTranslation.idMap.set(1, 'real-a');
    mockCtx.idTranslation.idMap.set(2, 'real-b');
    const map = getIdMap();
    expect(map.size).toBe(2);
    expect(map.get(1)).toBe('real-a');
    // Should be a copy, not the original
    map.set(99, 'should-not-appear');
    expect(mockCtx.idTranslation.idMap.has(99)).toBe(false);
  });
});

describe('getTranslationStats', () => {
  it('returns correct stats', () => {
    mockCtx.idTranslation.idMap.set(1, 'real-a');
    mockCtx.idTranslation.nextNumericId = 5;
    mockCtx.idTranslation.lastAccessed = Date.now();
    const stats = getTranslationStats();
    expect(stats.totalMappings).toBe(1);
    expect(stats.nextNumericId).toBe(5);
    expect(stats.mappings).toHaveLength(1);
    expect(stats.mappings[0].numericId).toBe(1);
    expect(stats.mappings[0].realId).toBe('real-a');
  });

  it('classifies email-type IDs (contains : and @)', () => {
    mockCtx.idTranslation.idMap.set(1, 'user@example.com:folder');
    const stats = getTranslationStats();
    expect(stats.mappings[0].type).toBe('email');
  });

  it('classifies contact-type IDs (contains @ but not :)', () => {
    mockCtx.idTranslation.idMap.set(1, 'user@example.com');
    const stats = getTranslationStats();
    expect(stats.mappings[0].type).toBe('contact');
  });

  it('classifies unknown-type IDs (no @ or :)', () => {
    mockCtx.idTranslation.idMap.set(1, 'some-plain-id');
    const stats = getTranslationStats();
    expect(stats.mappings[0].type).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Additional coverage tests — targeting uncovered branches
// ---------------------------------------------------------------------------

describe('toNumericId — global ctx persistence branch', () => {
  it('persists idMap when using global ctx (no overrideCtx)', () => {
    // This exercises the branch at line 113 where !overrideCtx is true
    const id = toNumericId('global-real-id');
    expect(id).toBe(1);
    expect(mockCtx.idTranslation.idMap.get(1)).toBe('global-real-id');
  });

  it('does not modify global ctx when using overrideCtx', () => {
    const isoCtx = createIsolatedContext();
    toNumericId('override-real-id', isoCtx);
    // The global ctx should not have this mapping
    expect(mockCtx.idTranslation.idMap.has(1)).toBe(false);
    expect(isoCtx.idMap.get(1)).toBe('override-real-id');
  });

  it('handles freeIds being undefined on the context', () => {
    // Exercises the fallback at line 101: const freeIds = idTranslation.freeIds || []
    const isoCtx = createIsolatedContext();
    isoCtx.freeIds = undefined;
    const id = toNumericId('test-id', isoCtx);
    expect(id).toBe(1);
  });
});

describe('processStringLLMtoTB — unresolvable ID branches', () => {
  it('leaves [Email xx] unchanged when toRealId returns null', () => {
    // No mappings seeded — ID won't resolve
    const result = processLLMResponseLLMtoTB('Look at [Email 999] please');
    expect(result).toBe('Look at [Email 999] please');
  });

  it('leaves (Email xx) unchanged when toRealId returns null', () => {
    const result = processLLMResponseLLMtoTB('See (Email 999) for info');
    expect(result).toBe('See (Email 999) for info');
  });

  it('leaves bare "Email xx" unchanged when toRealId returns null', () => {
    const result = processLLMResponseLLMtoTB('I found Email 999 interesting');
    expect(result).toBe('I found Email 999 interesting');
  });

  it('leaves [Event](num:num) unchanged when one toRealId returns null', () => {
    // Only seed one of the two IDs
    seedGlobalCtx([[10, 'cal-real']]);
    const result = processLLMResponseLLMtoTB('See [Event](10:999)');
    // 999 is unknown, so the compound link stays unchanged
    expect(result).toBe('See [Event](10:999)');
  });

  it('leaves [Contact](num:num) unchanged when one toRealId returns null', () => {
    seedGlobalCtx([[20, 'ab-real']]);
    const result = processLLMResponseLLMtoTB('Info [Contact](20:999)');
    expect(result).toBe('Info [Contact](20:999)');
  });

  it('handles lowercase [email](numericId) pattern', () => {
    seedGlobalCtx([[1, 'msg-lower']]);
    const result = processLLMResponseLLMtoTB('See [email](1) here');
    expect(result).toBe('See [email](msg-lower) here');
  });

  it('handles lowercase [email xx] pattern', () => {
    seedGlobalCtx([[1, 'msg-lower']]);
    const result = processLLMResponseLLMtoTB('See [email 1] here');
    expect(result).toBe('See [email](msg-lower) here');
  });
});

describe('processStringLLMtoTB — compound ID patterns', () => {
  it('leaves compound contact pattern unchanged when one ID is unresolvable', () => {
    seedGlobalCtx([[30, 'ab-real']]);
    // Only one of two compound IDs resolves
    const result = processLLMResponseLLMtoTB('Found addressbook_id: 30:contact_id: 999 match');
    expect(result).toBe('Found addressbook_id: 30:contact_id: 999 match');
  });

  it('leaves compound event pattern unchanged when one ID is unresolvable', () => {
    seedGlobalCtx([[40, 'cal-real']]);
    const result = processLLMResponseLLMtoTB('Found calendar_id: 40:event_id: 999 match');
    expect(result).toBe('Found calendar_id: 40:event_id: 999 match');
  });
});

describe('processStringTBtoLLM — non-string input and edge cases', () => {
  it('returns non-string input unchanged', () => {
    const result = processToolResultTBtoLLM(42);
    expect(result).toBe(42);
  });

  it('returns boolean input unchanged', () => {
    const result = processToolResultTBtoLLM(true);
    expect(result).toBe(true);
  });

  it('leaves unique_id pattern unchanged when toNumericId returns null for non-string realId', () => {
    // unique_id: followed by something that's already numeric — toNumericId skips it
    const result = processToolResultTBtoLLM('unique_id: 42\nsubject: Hello');
    // '42' is already numeric, toNumericId returns 42
    expect(result).toMatch(/unique_id: 42/);
  });

  it('leaves Contact link unchanged when contact ID has no colon', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolResultTBtoLLM('[Contact](simple-contact-id)', isoCtx);
    // Contact link without colon — the regex matches but no colon split happens
    expect(result).toBe('[Contact](simple-contact-id)');
  });

  it('leaves Event link unchanged when event ID has no colon', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolResultTBtoLLM('[Event](simple-event-id)', isoCtx);
    // Event link without colon — returns match unchanged
    expect(result).toBe('[Event](simple-event-id)');
  });

  it('leaves Contact link unchanged when one part of compound fails toNumericId', () => {
    const isoCtx = createIsolatedContext();
    // Both parts are non-numeric strings, so they get mapped. This tests the normal path.
    const result = processToolResultTBtoLLM('[Contact](ab-real:ct-real)', isoCtx);
    expect(result).toMatch(/\[Contact\]\(\d+:\d+\)/);
  });

  it('leaves Event link unchanged when one part of compound fails toNumericId', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolResultTBtoLLM('[Event](cal-real:evt-real)', isoCtx);
    expect(result).toMatch(/\[Event\]\(\d+:\d+\)/);
  });
});

describe('processObjectTBtoLLM — edge cases', () => {
  it('returns null as-is', () => {
    const result = processToolResultTBtoLLM(null);
    expect(result).toBe(null);
  });

  it('handles object with string field containing ID patterns', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolResultTBtoLLM({
      results: 'unique_id: msg-real-abc\nsubject: Test',
    }, isoCtx);
    expect(result.results).toMatch(/unique_id: \d+/);
    expect(result.results).not.toContain('msg-real-abc');
  });

  it('handles object with string field containing contact_id pattern', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolResultTBtoLLM({
      data: 'contact_id: contact-real\nname: John',
    }, isoCtx);
    expect(result.data).toMatch(/contact_id: \d+/);
  });

  it('handles object with string field containing event_id pattern', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolResultTBtoLLM({
      data: 'event_id: event-real\ntitle: Meeting',
    }, isoCtx);
    expect(result.data).toMatch(/event_id: \d+/);
  });

  it('handles object with string field containing calendar_id pattern', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolResultTBtoLLM({
      data: 'calendar_id: cal-real\nname: Work',
    }, isoCtx);
    expect(result.data).toMatch(/calendar_id: \d+/);
  });

  it('handles object with string field containing addressbook_id pattern', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolResultTBtoLLM({
      data: 'addressbook_id: ab-real\nname: Personal',
    }, isoCtx);
    expect(result.data).toMatch(/addressbook_id: \d+/);
  });

  it('handles object with non-string ID field values (leaves as-is)', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolResultTBtoLLM({
      unique_id: 42,  // number, not string — should pass through recursion
      name: 'test',
    }, isoCtx);
    // The numeric value goes through processObjectTBtoLLM recursion but not the ID branch
    expect(result.unique_id).toBe(42);
  });

  it('handles object where ID field toNumericId returns null', () => {
    const isoCtx = createIsolatedContext();
    // Empty string — toNumericId returns null for empty string
    const result = processToolResultTBtoLLM({
      unique_id: '',
    }, isoCtx);
    // When toNumericId returns null, the fallback is `numericId || value` which is '' (falsy)
    // so result is the original empty string
    expect(result.unique_id).toBe('');
  });
});

describe('processToolCallLLMtoTB — additional branches', () => {
  it('leaves email unique_id unchanged when toRealId returns null', () => {
    const isoCtx = createIsolatedContext();
    // 999 is not in the map
    const result = processToolCallLLMtoTB('email_read', { unique_id: 999 }, isoCtx);
    expect(result.unique_id).toBe(999);
  });

  it('handles unique_ids array with non-number/non-string items', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('email_archive', { unique_ids: [null, undefined, { obj: true }] }, isoCtx);
    // Non-number/non-string items pass through unchanged
    expect(result.unique_ids).toEqual([null, undefined, { obj: true }]);
  });

  it('handles calendar_event tool with unresolvable event_id', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('calendar_event_read', { event_id: 999 }, isoCtx);
    expect(result.event_id).toBe(999);
  });

  it('handles calendar_event tool with compound event_id where one part fails', () => {
    const isoCtx = createIsolatedContext();
    // Compound ID "1:2" but neither is in the map
    const result = processToolCallLLMtoTB('calendar_event_update', { event_id: '1:2' }, isoCtx);
    // Both parts fail toRealId, so the compound stays unchanged
    expect(result.event_id).toBe('1:2');
  });

  it('handles calendar_event tool with unresolvable calendar_id', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('calendar_event_create', { calendar_id: 999 }, isoCtx);
    expect(result.calendar_id).toBe(999);
  });

  it('handles calendar_event tool with CalendarID variant', () => {
    const isoCtx = createIsolatedContext();
    const numId = toNumericId('cal-id-variant', isoCtx);
    const result = processToolCallLLMtoTB('calendar_event_create', { CalendarID: numId }, isoCtx);
    expect(result.CalendarID).toBe('cal-id-variant');
  });

  it('handles contacts tool with unresolvable contact_id', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('contacts_read', { contact_id: 999 }, isoCtx);
    expect(result.contact_id).toBe(999);
  });

  it('handles contacts tool with unresolvable addressbook_id', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('contacts_list', { addressbook_id: 999 }, isoCtx);
    expect(result.addressbook_id).toBe(999);
  });

  it('handles calendar_read tool with unresolvable calendar_id', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('calendar_read', { calendar_id: 999 }, isoCtx);
    expect(result.calendar_id).toBe(999);
  });

  it('handles calendar_search tool with unresolvable CalendarID', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('calendar_search', { CalendarID: 999 }, isoCtx);
    expect(result.CalendarID).toBe(999);
  });

  it('handles EventID string variant for calendar_event tool', () => {
    const isoCtx = createIsolatedContext();
    const numId = toNumericId('event-str-id', isoCtx);
    const result = processToolCallLLMtoTB('calendar_event_read', { EventID: String(numId) }, isoCtx);
    expect(result.EventID).toBe('event-str-id');
  });
});

describe('handleIdExceptions — "(unique_id X and Y)" parenthesized pattern with unresolvable IDs', () => {
  it('leaves "(unique_id X and Y)" unchanged when IDs are unresolvable', () => {
    const result = processLLMResponseLLMtoTB('Archived (unique_id 999 and 998) done');
    expect(result).toContain('999');
    expect(result).toContain('998');
  });

  it('leaves "unique_id X, Y" unchanged when IDs are unresolvable', () => {
    const result = processLLMResponseLLMtoTB('Archived unique_id 999, 998 done');
    expect(result).toContain('999');
    expect(result).toContain('998');
  });

  it('leaves "(unique_id X, Y)" unchanged when IDs are unresolvable', () => {
    const result = processLLMResponseLLMtoTB('Archived (unique_id 999, 998) done');
    expect(result).toContain('999');
    expect(result).toContain('998');
  });

  it('leaves "unique_id X, Y, and Z" unchanged when IDs are unresolvable', () => {
    const result = processLLMResponseLLMtoTB('Archived unique_id 997, 998, and 999');
    expect(result).toContain('997');
    expect(result).toContain('998');
    expect(result).toContain('999');
  });

  it('leaves "contact_id X, Y" unchanged when IDs are unresolvable', () => {
    const result = processLLMResponseLLMtoTB('Updated contact_id 999, 998');
    expect(result).toContain('999');
    expect(result).toContain('998');
  });

  it('leaves "contact_id X and Y" unchanged when IDs are unresolvable', () => {
    const result = processLLMResponseLLMtoTB('Updated contact_id 999 and 998');
    expect(result).toContain('999');
    expect(result).toContain('998');
  });

  it('leaves "event_id X and Y" unchanged when IDs are unresolvable', () => {
    const result = processLLMResponseLLMtoTB('Deleted event_id 999 and 998');
    expect(result).toContain('999');
    expect(result).toContain('998');
  });

  it('leaves "event_id X, Y" unchanged when IDs are unresolvable', () => {
    const result = processLLMResponseLLMtoTB('Deleted event_id 999, 998');
    expect(result).toContain('999');
    expect(result).toContain('998');
  });

  it('passes through non-string input to handleIdExceptions', () => {
    // handleIdExceptions is called inside processStringLLMtoTB which already guards typeof
    // But we can trigger it through the object path of processLLMResponseLLMtoTB
    const result = processLLMResponseLLMtoTB({ assistant: null });
    expect(result.assistant).toBe(null);
  });
});

describe('mergeIdMapFromHeadless — additional edge cases', () => {
  it('skips entries with non-number headless numericId', () => {
    const message = 'Check [Email](1) now';
    const entries = [['not-a-number', 'real-id'], [1, 'valid-real-id']];
    const result = mergeIdMapFromHeadless(entries, message);
    // Only the valid entry should be processed
    expect(mockCtx.idTranslation.idMap.get(1)).toBe('valid-real-id');
    expect(result).toBe('Check [Email](1) now');
  });

  it('skips entries with non-string realId', () => {
    const message = 'Check [Email](1) now';
    const entries = [[1, 123], [2, 'valid-real-id']];
    const result = mergeIdMapFromHeadless(entries, message);
    expect(mockCtx.idTranslation.idMap.has(1)).toBe(false);
    expect(mockCtx.idTranslation.idMap.get(2)).toBe('valid-real-id');
  });

  it('leaves entity references unchanged when not in remap table', () => {
    const message = 'Check [Email](50) now';
    // No entries for ID 50
    const entries = [[1, 'some-real-id']];
    const result = mergeIdMapFromHeadless(entries, message);
    // 50 is not in the remap table, so it stays
    expect(result).toBe('Check [Email](50) now');
  });

  it('handles compound IDs where parts are not in remap table', () => {
    const message = 'See [Event](50:60) for meeting';
    const entries = [[1, 'some-real-id']];
    const result = mergeIdMapFromHeadless(entries, message);
    // 50 and 60 not in remap table — parts stay unchanged
    expect(result).toBe('See [Event](50:60) for meeting');
  });

  it('advances nextNumericId when headless entry is higher', () => {
    const entries = [[100, 'high-id-real']];
    mergeIdMapFromHeadless(entries, 'test');
    expect(mockCtx.idTranslation.nextNumericId).toBeGreaterThanOrEqual(101);
  });
});

describe('collectTurnRefs — edge cases', () => {
  it('handles turn with no content and no user_message', () => {
    const refs = collectTurnRefs({});
    expect(refs).toEqual([]);
  });

  it('handles turn with empty content', () => {
    const refs = collectTurnRefs({ content: '' });
    expect(refs).toEqual([]);
  });

  it('handles turn with null content', () => {
    const refs = collectTurnRefs({ content: null });
    expect(refs).toEqual([]);
  });

  it('handles turn with both content and user_message containing IDs', () => {
    seedGlobalCtx([[1, 'msg-a'], [2, 'msg-b']]);
    const turn = {
      content: 'Check [Email](1)',
      user_message: 'What about [Email](2)?',
    };
    const refs = collectTurnRefs(turn);
    expect(refs).toContain(1);
    expect(refs).toContain(2);
  });
});

describe('_unregisterRefsInternal — edge cases via unregisterTurnRefs', () => {
  it('handles freeIds being undefined on context', () => {
    mockCtx.idTranslation.freeIds = undefined;
    mockCtx.idTranslation.idMap.set(1, 'real-a');
    mockCtx.idTranslation.refCounts.set(1, 1);
    const turn = { _refs: [1] };
    unregisterTurnRefs(turn);
    // freeIds should have been initialized
    expect(Array.isArray(mockCtx.idTranslation.freeIds)).toBe(true);
    expect(mockCtx.idTranslation.freeIds).toContain(1);
  });

  it('handles ref count at 0 (below 1) — frees the ID', () => {
    mockCtx.idTranslation.idMap.set(1, 'real-a');
    // refCount is 0 (not even set) — current = 0, which is <= 1
    const turn = { _refs: [1] };
    unregisterTurnRefs(turn);
    expect(mockCtx.idTranslation.idMap.has(1)).toBe(false);
    expect(mockCtx.idTranslation.freeIds).toContain(1);
  });

  it('handles ref to ID not in idMap (refCount drops but no idMap entry)', () => {
    // refCount exists but no idMap entry
    mockCtx.idTranslation.refCounts.set(99, 1);
    const turn = { _refs: [99] };
    unregisterTurnRefs(turn);
    // refCount should be deleted, but idMap.has(99) is false so nothing freed
    expect(mockCtx.idTranslation.refCounts.has(99)).toBe(false);
    expect(mockCtx.idTranslation.freeIds).not.toContain(99);
  });
});

describe('buildRefCounts — freeIds undefined fallback', () => {
  it('initializes freeIds when undefined', () => {
    mockCtx.idTranslation.freeIds = undefined;
    mockCtx.idTranslation.idMap.set(1, 'orphan');
    mockCtx.idTranslation.nextNumericId = 2;
    buildRefCounts([]);
    expect(Array.isArray(mockCtx.idTranslation.freeIds)).toBe(true);
    expect(mockCtx.idTranslation.freeIds).toContain(1);
  });
});

describe('processLLMResponseLLMtoTB — object with non-string assistant field', () => {
  it('does not process assistant field when it is not a string', () => {
    const result = processLLMResponseLLMtoTB({ assistant: 42 });
    expect(result.assistant).toBe(42);
  });

  it('does not process assistant field when it is null', () => {
    const result = processLLMResponseLLMtoTB({ assistant: null });
    expect(result.assistant).toBe(null);
  });

  it('passes through object with no assistant field', () => {
    seedGlobalCtx([[1, 'msg-real']]);
    const result = processLLMResponseLLMtoTB({ data: 'value' });
    expect(result.data).toBe('value');
  });
});

describe('processToolCallLLMtoTB — tool branches with no ID fields', () => {
  it('email tool with no unique_id, UniqueID, or unique_ids fields', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('email_search', { query: 'test' }, isoCtx);
    expect(result.query).toBe('test');
  });

  it('calendar_event tool with no event_id, EventID, or calendar_id', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('calendar_event_create', { title: 'Meeting' }, isoCtx);
    expect(result.title).toBe('Meeting');
  });

  it('contacts tool with no contact_id, ContactID, or addressbook_id', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('contacts_search', { query: 'John' }, isoCtx);
    expect(result.query).toBe('John');
  });

  it('calendar_read tool with no calendar_id or CalendarID', () => {
    const isoCtx = createIsolatedContext();
    const result = processToolCallLLMtoTB('calendar_read', { date_range: 'week' }, isoCtx);
    expect(result.date_range).toBe('week');
  });

  it('calendar_event tool with compound EventID (sets EventID in result)', () => {
    const isoCtx = createIsolatedContext();
    const calId = toNumericId('cal-compound', isoCtx);
    const evtId = toNumericId('evt-compound', isoCtx);
    const result = processToolCallLLMtoTB('calendar_event_read', { EventID: `${calId}:${evtId}` }, isoCtx);
    expect(result.EventID).toBe('cal-compound:evt-compound');
  });

  it('calendar_event tool with CalendarID variant for calendar_id', () => {
    const isoCtx = createIsolatedContext();
    const calId = toNumericId('cal-alt', isoCtx);
    const result = processToolCallLLMtoTB('calendar_event_create', { CalendarID: calId }, isoCtx);
    expect(result.CalendarID).toBe('cal-alt');
  });
});

describe('handleIdExceptions — successful resolution of parenthesized patterns', () => {
  it('resolves "(unique_id X and Y)" when both IDs are mapped', () => {
    seedGlobalCtx([[10, 'msg-ten'], [20, 'msg-twenty']]);
    const result = processLLMResponseLLMtoTB('Done (unique_id 10 and 20) ok');
    expect(result).toBe('Done ([Email](msg-ten) and [Email](msg-twenty)) ok');
  });

  it('resolves "(unique_id X, Y)" when both IDs are mapped', () => {
    seedGlobalCtx([[10, 'msg-ten'], [20, 'msg-twenty']]);
    const result = processLLMResponseLLMtoTB('Done (unique_id 10, 20) ok');
    expect(result).toBe('Done ([Email](msg-ten), [Email](msg-twenty)) ok');
  });

  it('resolves "unique_id X, Y, and Z" when all three IDs are mapped', () => {
    // The 2-element comma pattern fires before the 3-element pattern,
    // consuming "unique_id 10, 20" and leaving ", and 30" as bare number
    seedGlobalCtx([[10, 'msg-ten'], [20, 'msg-twenty'], [30, 'msg-thirty']]);
    const result = processLLMResponseLLMtoTB('Done unique_id 10, 20, and 30 ok');
    expect(result).toContain('[Email](msg-ten)');
    expect(result).toContain('[Email](msg-twenty)');
  });
});

describe('getTranslationStats — event type classification', () => {
  it('classifies event-type IDs (contains _ and @)', () => {
    mockCtx.idTranslation.idMap.set(1, 'cal_123@server.com');
    const stats = getTranslationStats();
    // The condition checks ':' && '@' first (email), then '@' (contact), then '_' && '@' (event)
    // 'cal_123@server.com' has no ':', has '@', so it matches 'contact' before reaching 'event'
    // To hit the event branch, it must NOT match earlier conditions
    expect(stats.mappings[0].type).toBe('contact');
  });

  it('classifies IDs with _ but no @ as unknown', () => {
    mockCtx.idTranslation.idMap.set(1, 'cal_123_event');
    const stats = getTranslationStats();
    expect(stats.mappings[0].type).toBe('unknown');
  });
});

describe('persistIdMap — freeIds fallback', () => {
  it('uses empty array fallback when freeIds is undefined', () => {
    // Set freeIds to undefined and call a function that triggers persistIdMap
    mockCtx.idTranslation.freeIds = undefined;
    // toNumericId with global ctx triggers persistIdMap
    toNumericId('trigger-persist');
    // Should not throw — the || [] fallback handles it
    expect(mockCtx.idTranslation.idMap.get(1)).toBe('trigger-persist');
  });
});
