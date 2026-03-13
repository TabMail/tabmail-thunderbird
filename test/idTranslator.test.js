// idTranslator.test.js — ID translation layer tests (Tier 3 — mock-dependent)
//
// Tests toNumericId/toRealId mapping, isolated contexts, tool call translation,
// tool result translation, restoreIdMap persistence, and numeric passthrough.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Browser Mock ────────────────────────────────────────────────────────────

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
};

// ─── Module Mocks ────────────────────────────────────────────────────────────

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../chat/modules/persistentChatStore.js', () => ({
  loadIdMap: vi.fn(async () => ({
    entries: [],
    nextNumericId: 1,
    freeIds: [],
    refCounts: [],
  })),
  saveIdMap: vi.fn(),
  saveIdMapImmediate: vi.fn(async () => {}),
}));

// ─── Import modules under test ──────────────────────────────────────────────

const { ctx } = await import('../chat/modules/context.js');

const {
  toNumericId,
  toRealId,
  createIsolatedContext,
  processToolCallLLMtoTB,
  processToolResultTBtoLLM,
  restoreIdMap,
} = await import('../chat/modules/idTranslator.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resetCtx() {
  ctx.idTranslation.idMap.clear();
  ctx.idTranslation.nextNumericId = 1;
  ctx.idTranslation.lastAccessed = Date.now();
  ctx.idTranslation.freeIds = [];
  ctx.idTranslation.refCounts = new Map();
  ctx.entityMap.clear();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ID Translator', () => {
  beforeEach(() => {
    resetCtx();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-120: toNumericId allocates sequential IDs (1, 2, 3...)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-120: toNumericId allocates sequential IDs', () => {
    it('allocates IDs starting from 1 and incrementing', () => {
      const id1 = toNumericId('imap://folder1/msg1');
      const id2 = toNumericId('imap://folder1/msg2');
      const id3 = toNumericId('imap://folder1/msg3');

      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
    });

    it('returns null for invalid inputs', () => {
      expect(toNumericId(null)).toBeNull();
      expect(toNumericId(undefined)).toBeNull();
      expect(toNumericId('')).toBeNull();
      expect(toNumericId(123)).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-121: Same realId always maps to same numericId (deterministic)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-121: Same realId always maps to same numericId', () => {
    it('returns the same numeric ID for repeated calls with the same realId', () => {
      const first = toNumericId('imap://folder1/msg-abc');
      const second = toNumericId('imap://folder1/msg-abc');
      const third = toNumericId('imap://folder1/msg-abc');

      expect(first).toBe(second);
      expect(second).toBe(third);
      expect(first).toBe(1);
    });

    it('does not waste IDs on duplicate registrations', () => {
      toNumericId('imap://folder1/msg-abc');
      toNumericId('imap://folder1/msg-abc');
      const nextNew = toNumericId('imap://folder1/msg-def');

      // Should be 2, not 3 — duplicate did not consume an ID
      expect(nextNew).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-122: toRealId reverse lookup returns correct real ID
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-122: toRealId reverse lookup returns correct real ID', () => {
    it('resolves numeric ID back to original real ID', () => {
      const numId = toNumericId('imap://folder1/msg-xyz');
      const realId = toRealId(numId);

      expect(realId).toBe('imap://folder1/msg-xyz');
    });

    it('returns null for unknown numeric IDs', () => {
      expect(toRealId(999)).toBeNull();
    });

    it('returns null for invalid inputs', () => {
      expect(toRealId(null)).toBeNull();
      expect(toRealId(undefined)).toBeNull();
      expect(toRealId(-1)).toBeNull();
      expect(toRealId(0)).toBeNull();
      expect(toRealId(1.5)).toBeNull();
    });

    it('handles string numeric IDs', () => {
      toNumericId('imap://folder1/msg-abc');
      const realId = toRealId('1');
      expect(realId).toBe('imap://folder1/msg-abc');
    });

    it('round-trips multiple IDs correctly', () => {
      const realIds = [
        'imap://folder1/msg-a',
        'imap://folder2/msg-b',
        'imap://folder3/msg-c',
      ];

      const numericIds = realIds.map((id) => toNumericId(id));

      for (let i = 0; i < realIds.length; i++) {
        expect(toRealId(numericIds[i])).toBe(realIds[i]);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-123: Isolated contexts don't interfere with each other
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-123: Isolated contexts (createIsolatedContext) don\'t interfere', () => {
    it('creates a fresh context with empty map and nextNumericId=1', () => {
      const iso = createIsolatedContext();

      expect(iso.idMap).toBeInstanceOf(Map);
      expect(iso.idMap.size).toBe(0);
      expect(iso.nextNumericId).toBe(1);
      expect(iso.freeIds).toEqual([]);
    });

    it('isolated context IDs do not pollute global context', () => {
      const iso = createIsolatedContext();

      // Register an ID in the isolated context
      const numId = toNumericId('imap://isolated/msg1', iso);
      expect(numId).toBe(1);

      // The global context should have no mappings
      expect(toRealId(1)).toBeNull();

      // The isolated context should have the mapping
      expect(toRealId(1, iso)).toBe('imap://isolated/msg1');
    });

    it('two isolated contexts are independent', () => {
      const iso1 = createIsolatedContext();
      const iso2 = createIsolatedContext();

      toNumericId('imap://session1/msg-a', iso1);
      toNumericId('imap://session2/msg-b', iso2);

      // Each context has its own mapping at ID 1
      expect(toRealId(1, iso1)).toBe('imap://session1/msg-a');
      expect(toRealId(1, iso2)).toBe('imap://session2/msg-b');
    });

    it('global registrations do not appear in isolated context', () => {
      toNumericId('imap://global/msg1');
      const iso = createIsolatedContext();

      // ID 1 is in global context, not in isolated
      expect(toRealId(1)).toBe('imap://global/msg1');
      expect(toRealId(1, iso)).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-124: processToolCallLLMtoTB translates numeric IDs in tool args
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-124: processToolCallLLMtoTB translates numeric IDs to real IDs', () => {
    it('translates email unique_id from numeric to real', () => {
      toNumericId('imap://folder1/msg-abc');

      const result = processToolCallLLMtoTB('email_read', { unique_id: 1 });
      expect(result.unique_id).toBe('imap://folder1/msg-abc');
    });

    it('translates email unique_ids array', () => {
      toNumericId('imap://folder1/msg-a');
      toNumericId('imap://folder1/msg-b');

      const result = processToolCallLLMtoTB('email_archive', {
        unique_ids: [1, 2],
      });

      expect(result.unique_ids).toEqual([
        'imap://folder1/msg-a',
        'imap://folder1/msg-b',
      ]);
    });

    it('translates calendar event_id', () => {
      toNumericId('cal-event-uuid-123');

      const result = processToolCallLLMtoTB('calendar_event_read', {
        event_id: 1,
      });

      expect(result.event_id).toBe('cal-event-uuid-123');
    });

    it('translates contact_id for contacts tools', () => {
      toNumericId('contact-uuid-456');

      const result = processToolCallLLMtoTB('contacts_read', {
        contact_id: 1,
      });

      expect(result.contact_id).toBe('contact-uuid-456');
    });

    it('translates calendar_id for calendar tools', () => {
      toNumericId('calendar-uuid-789');

      const result = processToolCallLLMtoTB('calendar_read', {
        calendar_id: 1,
      });

      expect(result.calendar_id).toBe('calendar-uuid-789');
    });

    it('returns args unchanged for null/non-object args', () => {
      expect(processToolCallLLMtoTB('email_read', null)).toBeNull();
      expect(processToolCallLLMtoTB('email_read', 'string')).toBe('string');
    });

    it('uses isolated context when provided', () => {
      const iso = createIsolatedContext();
      toNumericId('imap://iso/msg1', iso);

      const result = processToolCallLLMtoTB('email_read', { unique_id: 1 }, iso);
      expect(result.unique_id).toBe('imap://iso/msg1');

      // Global context should not resolve this — unique_id stays as-is
      const globalResult = processToolCallLLMtoTB('email_read', { unique_id: 1 });
      expect(globalResult.unique_id).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-125: processToolResultTBtoLLM translates real IDs to numeric IDs
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-125: processToolResultTBtoLLM translates real IDs to numeric IDs', () => {
    it('translates unique_id field in object result', () => {
      const numId = toNumericId('imap://folder1/msg-abc');

      const result = processToolResultTBtoLLM({
        unique_id: 'imap://folder1/msg-abc',
        subject: 'Test email',
      });

      expect(result.unique_id).toBe(numId);
      expect(result.subject).toBe('Test email');
    });

    it('translates unique_id patterns in string results', () => {
      const numId = toNumericId('imap://folder1/msg-abc');

      const result = processToolResultTBtoLLM(
        'unique_id: imap://folder1/msg-abc\nsubject: Test'
      );

      expect(result).toContain(`unique_id: ${numId}`);
      expect(result).toContain('subject: Test');
    });

    it('translates nested objects with ID fields', () => {
      const numA = toNumericId('imap://folder1/msg-a');
      const numB = toNumericId('imap://folder1/msg-b');

      const result = processToolResultTBtoLLM({
        messages: [
          { unique_id: 'imap://folder1/msg-a', subject: 'Email A' },
          { unique_id: 'imap://folder1/msg-b', subject: 'Email B' },
        ],
      });

      expect(result.messages[0].unique_id).toBe(numA);
      expect(result.messages[1].unique_id).toBe(numB);
    });

    it('handles null/undefined results gracefully', () => {
      expect(processToolResultTBtoLLM(null)).toBeNull();
      expect(processToolResultTBtoLLM(undefined)).toBeUndefined();
    });

    it('allocates new ID for previously unseen real ID in result', () => {
      const result = processToolResultTBtoLLM({
        unique_id: 'imap://new/msg-unseen',
      });

      // Should have been allocated a new numeric ID
      expect(typeof result.unique_id).toBe('number');
      expect(result.unique_id).toBeGreaterThanOrEqual(1);

      // Should be resolvable via toRealId
      expect(toRealId(result.unique_id)).toBe('imap://new/msg-unseen');
    });

    it('uses isolated context when provided', () => {
      const iso = createIsolatedContext();
      toNumericId('imap://iso/msg1', iso);

      const result = processToolResultTBtoLLM(
        { unique_id: 'imap://iso/msg1' },
        iso
      );

      expect(result.unique_id).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-126: restoreIdMap from persisted format restores state correctly
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-126: restoreIdMap from persisted format restores state', () => {
    it('restores entries from serialized array', () => {
      const entries = [
        [1, 'imap://folder1/msg-a'],
        [2, 'imap://folder1/msg-b'],
        [5, 'imap://folder1/msg-c'],
      ];

      restoreIdMap(entries);

      expect(toRealId(1)).toBe('imap://folder1/msg-a');
      expect(toRealId(2)).toBe('imap://folder1/msg-b');
      expect(toRealId(5)).toBe('imap://folder1/msg-c');
    });

    it('advances nextNumericId past restored IDs to avoid collisions', () => {
      restoreIdMap([
        [3, 'imap://folder1/msg-x'],
        [7, 'imap://folder1/msg-y'],
      ]);

      // Next new ID should be 8 (past the max restored ID of 7)
      const newId = toNumericId('imap://folder1/msg-new');
      expect(newId).toBe(8);
    });

    it('merges into existing map preserving earlier registrations', () => {
      // Pre-register an ID at slot 1
      toNumericId('imap://existing/msg1');
      expect(toRealId(1)).toBe('imap://existing/msg1');

      // Restore additional entries at different slots
      restoreIdMap([
        [5, 'imap://restored/msg-a'],
      ]);

      // Existing entry is still there
      expect(toRealId(1)).toBe('imap://existing/msg1');
      // Restored entry is accessible
      expect(toRealId(5)).toBe('imap://restored/msg-a');
    });

    it('skips invalid entries gracefully', () => {
      restoreIdMap([
        [1, 'imap://valid/msg'],
        ['not-a-number', 'imap://invalid/msg'],  // invalid: numericId not a number
        [3, 123],                                  // invalid: realId not a string
        [null, 'imap://null/msg'],                 // invalid: numericId is null
      ]);

      // Only the valid entry should be restored
      expect(toRealId(1)).toBe('imap://valid/msg');
      // Slot 3 should not have been restored (realId not a string)
      expect(toRealId(3)).toBeNull();
    });

    it('handles non-array input gracefully', () => {
      // Should not throw
      restoreIdMap(null);
      restoreIdMap(undefined);
      restoreIdMap('not-an-array');
      restoreIdMap(42);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TB-127: Already-numeric IDs are detected and passed through
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TB-127: Already-numeric IDs passed through without double-mapping', () => {
    it('returns the number directly when given a numeric string', () => {
      const result = toNumericId('42');
      expect(result).toBe(42);
    });

    it('does not create a mapping for numeric strings', () => {
      toNumericId('42');

      // No mapping should exist — 42 was passed through, not registered
      expect(toRealId(42)).toBeNull();
    });

    it('handles single-digit numeric strings', () => {
      expect(toNumericId('1')).toBe(1);
      expect(toNumericId('9')).toBe(9);
    });

    it('handles large numeric strings', () => {
      expect(toNumericId('999999')).toBe(999999);
    });

    it('does not treat non-pure-numeric strings as numeric', () => {
      // These contain digits but are NOT purely numeric — they should be mapped
      const id1 = toNumericId('imap://folder/123');
      expect(typeof id1).toBe('number');
      expect(id1).toBeGreaterThanOrEqual(1);

      const id2 = toNumericId('abc123');
      expect(typeof id2).toBe('number');
      expect(id2).toBe(id1 + 1); // sequential after previous allocation
    });
  });
});
