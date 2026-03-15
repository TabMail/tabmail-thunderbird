// persistentChatStore.test.js — Tests for chat/modules/persistentChatStore.js
//
// Tests persistent turn storage: load/save, budget enforcement, turn conversion,
// KB cursor helpers, migration, ID generation.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis.browser mock
// ---------------------------------------------------------------------------
const storageData = {};
const removedKeys = [];

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keysOrDefault) => {
        if (typeof keysOrDefault === 'string') {
          return { [keysOrDefault]: storageData[keysOrDefault] ?? undefined };
        }
        if (Array.isArray(keysOrDefault)) {
          const result = {};
          for (const k of keysOrDefault) {
            result[k] = storageData[k] ?? undefined;
          }
          return result;
        }
        const result = {};
        for (const [k, def] of Object.entries(keysOrDefault)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          storageData[k] = v;
        }
      }),
      remove: vi.fn(async (keys) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          delete storageData[k];
          removedKeys.push(k);
        }
      }),
    },
  },
  runtime: {
    sendMessage: vi.fn(async () => undefined),
  },
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../chat/modules/helpers.js', () => ({
  renderToPlainText: vi.fn(async (text) => text),
  extractPlainTextFromHtml: vi.fn((html) => html),
}));

vi.mock('../fts/memoryIndexer.js', () => ({
  indexChatTurn: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import {
  loadTurns,
  saveTurnsImmediate,
  enforceBudget,
  loadMeta,
  saveMeta,
  saveMetaImmediate,
  loadIdMap,
  saveIdMapImmediate,
  turnToLLMMessage,
  turnsToLLMMessages,
  filterAndConvertTurns,
  getTurnsAfterCursor,
  advanceCursor,
  generateTurnId,
  migrateFromSessions,
  appendTurn,
  indexTurnToFTS,
} from '../chat/modules/persistentChatStore.js';

describe('persistentChatStore', () => {
  beforeEach(() => {
    for (const key of Object.keys(storageData)) {
      delete storageData[key];
    }
    removedKeys.length = 0;
    vi.clearAllMocks();
  });

  // --- loadTurns ---
  describe('loadTurns', () => {
    it('should return empty array when no data in storage', async () => {
      const turns = await loadTurns();
      expect(turns).toEqual([]);
    });

    it('should return stored turns array', async () => {
      const fakeTurns = [
        { _id: '1', role: 'user', content: 'hello' },
        { _id: '2', role: 'assistant', content: 'hi' },
      ];
      storageData['chat_turns'] = fakeTurns;
      const turns = await loadTurns();
      expect(turns).toEqual(fakeTurns);
    });

    it('should return empty array when stored value is not an array', async () => {
      storageData['chat_turns'] = 'corrupted';
      const turns = await loadTurns();
      expect(turns).toEqual([]);
    });

    it('should return empty array when storage throws', async () => {
      browser.storage.local.get.mockRejectedValueOnce(new Error('read fail'));
      const turns = await loadTurns();
      expect(turns).toEqual([]);
    });
  });

  // --- saveTurnsImmediate ---
  describe('saveTurnsImmediate', () => {
    it('should save turns to storage immediately', async () => {
      const turns = [{ _id: '1', role: 'user', content: 'test' }];
      await saveTurnsImmediate(turns);
      expect(storageData['chat_turns']).toEqual(turns);
    });

    it('should not throw when storage write fails', async () => {
      browser.storage.local.set.mockRejectedValueOnce(new Error('write fail'));
      await expect(saveTurnsImmediate([])).resolves.toBeUndefined();
    });
  });

  // --- enforceBudget ---
  describe('enforceBudget', () => {
    it('should not evict when within limits', () => {
      const turns = [
        { _id: '1', _chars: 100, _type: 'user' },
        { _id: '2', _chars: 100, _type: 'assistant' },
      ];
      const meta = { totalChars: 200 };
      const evicted = enforceBudget(turns, meta);
      expect(evicted).toEqual([]);
      expect(turns.length).toBe(2);
    });

    it('should evict oldest turns when exceeding message limit (MAX_EXCHANGES*2=100)', () => {
      // Create 102 turns (51 exchanges) to exceed 50 exchange limit
      const turns = [];
      for (let i = 0; i < 102; i++) {
        turns.push({ _id: String(i), _chars: 10, _type: i % 2 === 0 ? 'user' : 'assistant' });
      }
      const meta = { totalChars: 1020 };
      const evicted = enforceBudget(turns, meta);
      expect(evicted.length).toBe(2);
      expect(turns.length).toBe(100);
      expect(evicted[0]._id).toBe('0');
      expect(evicted[1]._id).toBe('1');
    });

    it('should evict turns when char budget is exceeded', () => {
      // MAX_EXCHANGES * CHARS_PER_EXCHANGE = 50 * 500 = 25000
      const turns = [
        { _id: '1', _chars: 20000, _type: 'user' },
        { _id: '2', _chars: 10000, _type: 'assistant' },
      ];
      const meta = { totalChars: 30000 };
      const evicted = enforceBudget(turns, meta);
      expect(evicted.length).toBe(1);
      expect(evicted[0]._id).toBe('1');
      expect(meta.totalChars).toBe(10000);
    });

    it('should protect head turn when it is a session boundary', () => {
      const turns = [];
      // Put a session_break at the very front, then exceed limits
      turns.push({ _id: 'sb', _chars: 0, _type: 'session_break' });
      for (let i = 0; i < 101; i++) {
        turns.push({ _id: String(i), _chars: 10, _type: i % 2 === 0 ? 'user' : 'assistant' });
      }
      const meta = { totalChars: 1010 };
      const evicted = enforceBudget(turns, meta);
      // The session_break at index 0 should be protected when it's the last session boundary
      // and eviction should stop
      expect(turns[0]._type).toBe('session_break');
    });

    it('should not evict when turns is empty', () => {
      const turns = [];
      const meta = { totalChars: 0 };
      const evicted = enforceBudget(turns, meta);
      expect(evicted).toEqual([]);
    });
  });

  // --- loadMeta ---
  describe('loadMeta', () => {
    it('should return defaults when no data in storage', async () => {
      const meta = await loadMeta();
      expect(meta).toEqual({
        lastActivityTs: 0,
        totalChars: 0,
        lastKbUpdateTs: 0,
        kbCursorId: null,
      });
    });

    it('should return stored metadata', async () => {
      const fakeMeta = { lastActivityTs: 123, totalChars: 456, lastKbUpdateTs: 789, kbCursorId: 'abc' };
      storageData['chat_meta'] = fakeMeta;
      const meta = await loadMeta();
      expect(meta).toEqual(fakeMeta);
    });

    it('should return defaults when storage throws', async () => {
      browser.storage.local.get.mockRejectedValueOnce(new Error('fail'));
      const meta = await loadMeta();
      expect(meta.lastActivityTs).toBe(0);
    });
  });

  // --- saveMetaImmediate ---
  describe('saveMetaImmediate', () => {
    it('should save meta to storage', async () => {
      const meta = { lastActivityTs: 100, totalChars: 50 };
      await saveMetaImmediate(meta);
      expect(storageData['chat_meta']).toEqual(meta);
    });
  });

  // --- loadIdMap ---
  describe('loadIdMap', () => {
    it('should return defaults when no data in storage', async () => {
      const idMap = await loadIdMap();
      expect(idMap).toEqual({
        entries: [],
        nextNumericId: 1,
        freeIds: [],
        refCounts: [],
      });
    });

    it('should return stored idMap data', async () => {
      const data = {
        entries: [[1, 'real-id-1']],
        nextNumericId: 2,
        freeIds: [],
        refCounts: [[1, 3]],
      };
      storageData['chat_id_map'] = data;
      const idMap = await loadIdMap();
      expect(idMap.entries).toEqual([[1, 'real-id-1']]);
      expect(idMap.nextNumericId).toBe(2);
    });

    it('should return defaults when storage throws', async () => {
      browser.storage.local.get.mockRejectedValueOnce(new Error('fail'));
      const idMap = await loadIdMap();
      expect(idMap.entries).toEqual([]);
      expect(idMap.nextNumericId).toBe(1);
    });
  });

  // --- saveIdMapImmediate ---
  describe('saveIdMapImmediate', () => {
    it('should save idMap to storage', async () => {
      const idMap = new Map([[1, 'real-id-1']]);
      const refCounts = new Map([[1, 2]]);
      await saveIdMapImmediate(idMap, 2, [], refCounts);
      const saved = storageData['chat_id_map'];
      expect(saved.entries).toEqual([[1, 'real-id-1']]);
      expect(saved.nextNumericId).toBe(2);
      expect(saved.refCounts).toEqual([[1, 2]]);
    });

    it('should handle empty maps', async () => {
      const idMap = new Map();
      await saveIdMapImmediate(idMap, 1, [3, 4], null);
      const saved = storageData['chat_id_map'];
      expect(saved.entries).toEqual([]);
      expect(saved.freeIds).toEqual([3, 4]);
      expect(saved.refCounts).toEqual([]);
    });
  });

  // --- turnToLLMMessage ---
  describe('turnToLLMMessage', () => {
    it('should strip _-prefixed keys', () => {
      const turn = { _id: '1', _ts: 100, _type: 'user', _chars: 5, role: 'user', content: 'hello' };
      const msg = turnToLLMMessage(turn);
      expect(msg).toEqual({ role: 'user', content: 'hello' });
      expect(msg._id).toBeUndefined();
      expect(msg._ts).toBeUndefined();
    });

    it('should preserve non-underscore keys', () => {
      const turn = { role: 'assistant', content: 'hi', tool_calls: [] };
      const msg = turnToLLMMessage(turn);
      expect(msg).toEqual({ role: 'assistant', content: 'hi', tool_calls: [] });
    });
  });

  // --- turnsToLLMMessages ---
  describe('turnsToLLMMessages', () => {
    it('should convert array of turns', () => {
      const turns = [
        { _id: '1', role: 'user', content: 'hello' },
        { _id: '2', role: 'assistant', content: 'hi' },
      ];
      const msgs = turnsToLLMMessages(turns);
      expect(msgs).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);
    });

    it('should return empty array for empty input', () => {
      expect(turnsToLLMMessages([])).toEqual([]);
    });
  });

  // --- filterAndConvertTurns ---
  describe('filterAndConvertTurns', () => {
    it('should return all turns when no kb_last_summarized_ts', async () => {
      const turns = [
        { _id: '1', _ts: 100, role: 'user', content: 'hello' },
        { _id: '2', _ts: 200, role: 'assistant', content: 'hi' },
      ];
      const msgs = await filterAndConvertTurns(turns);
      expect(msgs.length).toBe(2);
      expect(msgs[0].content).toBe('hello');
    });

    it('should drop turns before session_break that predates kb marker', async () => {
      storageData['kb_last_summarized_ts'] = 500;
      const turns = [
        { _id: '1', _ts: 100, _type: 'user', role: 'user', content: 'old' },
        { _id: '2', _ts: 200, _type: 'session_break', role: 'system', content: '' },
        { _id: '3', _ts: 600, _type: 'user', role: 'user', content: 'new' },
      ];
      const msgs = await filterAndConvertTurns(turns);
      expect(msgs.length).toBe(1);
      expect(msgs[0].content).toBe('new');
    });

    it('should keep all turns when session_break is after kb marker', async () => {
      storageData['kb_last_summarized_ts'] = 50;
      const turns = [
        { _id: '1', _ts: 100, _type: 'user', role: 'user', content: 'a' },
        { _id: '2', _ts: 200, _type: 'session_break', role: 'system', content: '' },
        { _id: '3', _ts: 300, _type: 'user', role: 'user', content: 'b' },
      ];
      const msgs = await filterAndConvertTurns(turns);
      // session_break at ts=200 > marker 50, so no cutting
      expect(msgs.length).toBe(3);
    });
  });

  // --- getTurnsAfterCursor ---
  describe('getTurnsAfterCursor', () => {
    const turns = [
      { _id: 'a', content: '1' },
      { _id: 'b', content: '2' },
      { _id: 'c', content: '3' },
    ];

    it('should return all turns when cursor is null', () => {
      const result = getTurnsAfterCursor(turns, { kbCursorId: null });
      expect(result.length).toBe(3);
    });

    it('should return turns after cursor position', () => {
      const result = getTurnsAfterCursor(turns, { kbCursorId: 'a' });
      expect(result.length).toBe(2);
      expect(result[0]._id).toBe('b');
    });

    it('should return empty array when cursor is at last turn', () => {
      const result = getTurnsAfterCursor(turns, { kbCursorId: 'c' });
      expect(result.length).toBe(0);
    });

    it('should return all turns when cursor ID is evicted (not found)', () => {
      const result = getTurnsAfterCursor(turns, { kbCursorId: 'evicted' });
      expect(result.length).toBe(3);
    });
  });

  // --- advanceCursor ---
  describe('advanceCursor', () => {
    it('should set kbCursorId on meta and call saveMeta', () => {
      const meta = { kbCursorId: null };
      advanceCursor(meta, 'turn-42');
      expect(meta.kbCursorId).toBe('turn-42');
    });
  });

  // --- generateTurnId ---
  describe('generateTurnId', () => {
    it('should return a string', () => {
      const id = generateTurnId();
      expect(typeof id).toBe('string');
    });

    it('should contain a timestamp prefix', () => {
      const before = Date.now();
      const id = generateTurnId();
      const after = Date.now();
      const ts = parseInt(id.split('-')[0], 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('should generate unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateTurnId());
      }
      expect(ids.size).toBe(100);
    });
  });

  // --- migrateFromSessions ---
  describe('migrateFromSessions', () => {
    it('should run v1 migration (remove old keys) when flag not set', async () => {
      storageData['chat_history_queue'] = [1, 2, 3];
      storageData['chat_history_queue_config'] = { x: 1 };
      await migrateFromSessions();
      expect(removedKeys).toContain('chat_history_queue');
      expect(removedKeys).toContain('chat_history_queue_config');
      expect(storageData['chat_turns_migration_v1']).toBeDefined();
    });

    it('should skip v1 migration when flag is already set', async () => {
      storageData['chat_turns_migration_v1'] = Date.now();
      storageData['chat_turns_migration_v2'] = Date.now();
      await migrateFromSessions();
      expect(removedKeys.length).toBe(0);
    });

    it('should run v2 migration (FTS clear) when flag not set', async () => {
      storageData['chat_turns_migration_v1'] = Date.now();
      await migrateFromSessions();
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'fts', cmd: 'memoryClear' })
      );
      expect(storageData['chat_turns_migration_v2']).toBeDefined();
    });

    it('should not throw when FTS clear fails in v2', async () => {
      storageData['chat_turns_migration_v1'] = Date.now();
      browser.runtime.sendMessage.mockRejectedValueOnce(new Error('fts fail'));
      await expect(migrateFromSessions()).resolves.toBeUndefined();
      // v2 flag still set despite FTS failure
      expect(storageData['chat_turns_migration_v2']).toBeDefined();
    });
  });

  // --- appendTurn ---
  describe('appendTurn', () => {
    it('should append turn and update meta totalChars', async () => {
      const turns = [];
      const meta = { totalChars: 0 };
      const turn = { _id: '1', _chars: 50, role: 'user', content: 'hello' };
      const { evictedTurns } = await appendTurn(turn, turns, meta);
      expect(turns.length).toBe(1);
      expect(meta.totalChars).toBe(50);
      expect(evictedTurns).toEqual([]);
    });
  });

  // --- indexTurnToFTS ---
  describe('indexTurnToFTS', () => {
    it('should call indexChatTurn with rendered text', async () => {
      const { indexChatTurn } = await import('../fts/memoryIndexer.js');
      const userTurn = { user_message: 'hello', content: 'hello' };
      const assistantTurn = { _id: 'a1', _ts: 100, content: 'hi there' };
      await indexTurnToFTS(userTurn, assistantTurn);
      expect(indexChatTurn).toHaveBeenCalledWith('hello', 'hi there', 'a1', 100);
    });

    it('should skip when both user and assistant content are empty', async () => {
      const { indexChatTurn } = await import('../fts/memoryIndexer.js');
      indexChatTurn.mockClear();
      const userTurn = { content: '' };
      const assistantTurn = { _id: 'a2', _ts: 200, content: '  ' };
      await indexTurnToFTS(userTurn, assistantTurn);
      expect(indexChatTurn).not.toHaveBeenCalled();
    });

    it('should use _rendered snapshot when available', async () => {
      const { extractPlainTextFromHtml } = await import('../chat/modules/helpers.js');
      const userTurn = { content: 'q' };
      const assistantTurn = { _id: 'a3', _ts: 300, content: 'raw', _rendered: '<b>rendered</b>' };
      await indexTurnToFTS(userTurn, assistantTurn);
      expect(extractPlainTextFromHtml).toHaveBeenCalledWith('<b>rendered</b>');
    });

    it('should not throw on indexing failure', async () => {
      const { indexChatTurn } = await import('../fts/memoryIndexer.js');
      indexChatTurn.mockRejectedValueOnce(new Error('fts fail'));
      const userTurn = { content: 'hello' };
      const assistantTurn = { _id: 'a4', _ts: 400, content: 'hi' };
      await expect(indexTurnToFTS(userTurn, assistantTurn)).resolves.toBeUndefined();
    });
  });
});
