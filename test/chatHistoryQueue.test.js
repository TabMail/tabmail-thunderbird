// chatHistoryQueue.test.js — Tests for agent/modules/chatHistoryQueue.js
//
// The module manages a persistent queue of chat sessions in browser.storage.local.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

// In-memory storage mock
let storageData = {};

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrObj) => {
        if (typeof keyOrObj === 'string') {
          return { [keyOrObj]: storageData[keyOrObj] ?? undefined };
        }
        const result = {};
        for (const [k, def] of Object.entries(keyOrObj)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          storageData[k] = v;
        }
      }),
      remove: vi.fn(async (key) => {
        delete storageData[key];
      }),
    },
  },
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const {
  loadChatHistoryQueue,
  addChatToQueue,
  markSessionsAsRemembered,
  markAllAsRemembered,
  getUnrememberedSessionIds,
  getUnrememberedSessions,
  pruneOldSessions,
  getQueueStats,
  getRecentChatHistoryForPrompt,
} = await import('../agent/modules/chatHistoryQueue.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  storageData = {};
  vi.clearAllMocks();
});

describe('loadChatHistoryQueue', () => {
  it('returns empty array when storage is empty', async () => {
    const result = await loadChatHistoryQueue();
    expect(result).toEqual([]);
  });

  it('returns stored queue', async () => {
    const queue = [{ id: 'test-1', timestamp: Date.now(), remembered: false, messages: [] }];
    storageData.chat_history_queue = queue;
    const result = await loadChatHistoryQueue();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('test-1');
  });

  it('sanitizes message content on load', async () => {
    storageData.chat_history_queue = [{
      id: 'test-1',
      timestamp: Date.now(),
      remembered: false,
      messages: [{ role: 'user', content: 'hello\x00world' }],
    }];
    const result = await loadChatHistoryQueue();
    expect(result[0].messages[0].content).toBe('helloworld');
  });
});

describe('addChatToQueue', () => {
  it('returns null for empty conversation', async () => {
    const result = await addChatToQueue([]);
    expect(result).toBeNull();
  });

  it('returns null for null input', async () => {
    const result = await addChatToQueue(null);
    expect(result).toBeNull();
  });

  it('adds a session with user and assistant messages', async () => {
    const conversation = [
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: 'Hello!' },  // First assistant = greeting
      { role: 'user', content: 'What is the weather?' },
      { role: 'assistant', content: 'It is sunny.' },
    ];
    const sessionId = await addChatToQueue(conversation);
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe('string');

    const queue = storageData.chat_history_queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe(sessionId);
    expect(queue[0].remembered).toBe(false);
  });

  it('replaces first assistant message with greeting marker', async () => {
    const conversation = [
      { role: 'assistant', content: 'Welcome! How can I help?' },
      { role: 'user', content: 'Help me' },
    ];
    await addChatToQueue(conversation);
    const queue = storageData.chat_history_queue;
    expect(queue[0].messages[0].content).toBe('[automated greeting]');
  });

  it('filters out system messages', async () => {
    const conversation = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'assistant', content: 'greeting' },
      { role: 'user', content: 'hi' },
    ];
    await addChatToQueue(conversation);
    const queue = storageData.chat_history_queue;
    const roles = queue[0].messages.map(m => m.role);
    expect(roles).not.toContain('system');
  });

  it('skips empty messages', async () => {
    const conversation = [
      { role: 'assistant', content: 'greeting' },
      { role: 'user', content: '' },
      { role: 'user', content: 'real message' },
    ];
    await addChatToQueue(conversation);
    const queue = storageData.chat_history_queue;
    // Should have greeting marker + real message only
    const userMsgs = queue[0].messages.filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe('real message');
  });
});

describe('markSessionsAsRemembered', () => {
  it('marks specified sessions', async () => {
    storageData.chat_history_queue = [
      { id: 's1', timestamp: Date.now(), remembered: false, messages: [{ role: 'user', content: 'x' }] },
      { id: 's2', timestamp: Date.now(), remembered: false, messages: [{ role: 'user', content: 'y' }] },
    ];
    await markSessionsAsRemembered(['s1']);
    const queue = storageData.chat_history_queue;
    expect(queue.find(s => s.id === 's1').remembered).toBe(true);
    expect(queue.find(s => s.id === 's2').remembered).toBe(false);
  });

  it('does nothing for empty array', async () => {
    await markSessionsAsRemembered([]);
    // Should not throw
  });

  it('does nothing for null/undefined', async () => {
    await markSessionsAsRemembered(null);
    // Should not throw
  });
});

describe('markAllAsRemembered', () => {
  it('marks all sessions as remembered', async () => {
    storageData.chat_history_queue = [
      { id: 's1', timestamp: Date.now(), remembered: false, messages: [{ role: 'user', content: 'x' }] },
      { id: 's2', timestamp: Date.now(), remembered: false, messages: [{ role: 'user', content: 'y' }] },
    ];
    await markAllAsRemembered();
    const queue = storageData.chat_history_queue;
    expect(queue.every(s => s.remembered)).toBe(true);
  });
});

describe('getUnrememberedSessionIds', () => {
  it('returns only unremembered session IDs', async () => {
    storageData.chat_history_queue = [
      { id: 's1', timestamp: Date.now(), remembered: true, messages: [] },
      { id: 's2', timestamp: Date.now(), remembered: false, messages: [] },
      { id: 's3', timestamp: Date.now(), remembered: false, messages: [] },
    ];
    const ids = await getUnrememberedSessionIds();
    expect(ids).toEqual(['s2', 's3']);
  });
});

describe('getUnrememberedSessions', () => {
  it('returns unremembered sessions sorted oldest first', async () => {
    storageData.chat_history_queue = [
      { id: 's2', timestamp: 2000, remembered: false, messages: [] },
      { id: 's1', timestamp: 1000, remembered: false, messages: [] },
      { id: 's3', timestamp: 3000, remembered: true, messages: [] },
    ];
    const sessions = await getUnrememberedSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe('s1');
    expect(sessions[1].id).toBe('s2');
  });
});

describe('pruneOldSessions', () => {
  it('removes sessions older than maxAgeDays', async () => {
    const now = Date.now();
    storageData.chat_history_queue = [
      { id: 'old', timestamp: now - 40 * 86400000, remembered: false, messages: [] },
      { id: 'recent', timestamp: now - 1 * 86400000, remembered: false, messages: [] },
    ];
    await pruneOldSessions(30);
    const queue = storageData.chat_history_queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe('recent');
  });

  it('keeps all sessions when none are old', async () => {
    const now = Date.now();
    storageData.chat_history_queue = [
      { id: 's1', timestamp: now, remembered: false, messages: [] },
    ];
    await pruneOldSessions(30);
    expect(storageData.chat_history_queue).toHaveLength(1);
  });
});

describe('getQueueStats', () => {
  it('returns correct stats', async () => {
    storageData.chat_history_queue = [
      { id: 's1', remembered: true, messages: [] },
      { id: 's2', remembered: false, messages: [] },
      { id: 's3', remembered: false, messages: [] },
    ];
    const stats = await getQueueStats();
    expect(stats.total).toBe(3);
    expect(stats.remembered).toBe(1);
    expect(stats.unremembered).toBe(2);
  });

  it('returns zero counts for empty queue', async () => {
    const stats = await getQueueStats();
    expect(stats.total).toBe(0);
    expect(stats.remembered).toBe(0);
    expect(stats.unremembered).toBe(0);
  });
});

describe('getRecentChatHistoryForPrompt', () => {
  it('returns empty string when queue is empty', async () => {
    const result = await getRecentChatHistoryForPrompt(10);
    expect(result).toBe('');
  });

  it('returns empty string when maxSessions is 0', async () => {
    storageData.chat_history_queue = [
      { id: 's1', timestamp: Date.now(), remembered: false, messages: [{ role: 'user', content: 'hi' }] },
    ];
    const result = await getRecentChatHistoryForPrompt(0);
    expect(result).toBe('');
  });

  it('formats sessions with date and role prefixes', async () => {
    storageData.chat_history_queue = [
      {
        id: 's1',
        timestamp: Date.now(),
        remembered: false,
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      },
    ];
    const result = await getRecentChatHistoryForPrompt(10);
    expect(result).toContain('[USER]: Hello');
    expect(result).toContain('[AGENT]: Hi there');
    expect(result).toContain('--- Session');
  });

  it('truncates long messages to 200 chars', async () => {
    const longContent = 'x'.repeat(300);
    storageData.chat_history_queue = [
      {
        id: 's1',
        timestamp: Date.now(),
        remembered: false,
        messages: [{ role: 'user', content: longContent }],
      },
    ];
    const result = await getRecentChatHistoryForPrompt(10);
    expect(result).toContain('...');
    // Should not contain the full 300-char string
    expect(result.includes('x'.repeat(300))).toBe(false);
  });

  it('replaces automated greeting with marker text', async () => {
    storageData.chat_history_queue = [
      {
        id: 's1',
        timestamp: Date.now(),
        remembered: false,
        messages: [{ role: 'assistant', content: '[automated greeting]' }],
      },
    ];
    const result = await getRecentChatHistoryForPrompt(10);
    expect(result).toContain('(automated greeting)');
  });
});
