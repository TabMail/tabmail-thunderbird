// chatTools.test.js — Chat tool tests (TB-050 through TB-066)
//
// Tools import from agent/modules/utils.js, agent/modules/config.js,
// agent/modules/promptGenerator.js, agent/modules/patchApplier.js,
// chat/modules/chatConfig.js, chat/modules/helpers.js, and various other
// modules. We mock all browser-dependent modules and set up globalThis.browser.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis.browser mock
// ---------------------------------------------------------------------------
const storageData = {};

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keysOrDefault) => {
        if (typeof keysOrDefault === 'string') {
          return { [keysOrDefault]: storageData[keysOrDefault] ?? undefined };
        }
        // Object form: { key: defaultValue }
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
    },
  },
  runtime: {
    sendMessage: vi.fn(async (msg) => {
      // FTS search mock
      if (msg?.type === 'fts' && msg?.cmd === 'search') {
        return [
          { uniqueId: 'uid1', subject: 'Test email', author: 'alice@example.com', dateMs: Date.now(), snippet: 'hello' },
        ];
      }
      // Memory read mock
      if (msg?.type === 'fts' && msg?.cmd === 'memoryRead') {
        if (!msg.timestampMs || typeof msg.timestampMs !== 'number') {
          return { error: 'invalid timestamp' };
        }
        return [
          { dateMs: msg.timestampMs, content: 'User: hello\nAssistant: hi there' },
          { dateMs: msg.timestampMs + 1000, content: 'User: how are you?\nAssistant: doing well' },
        ];
      }
      return undefined;
    }),
    sendNativeMessage: vi.fn(async () => ({})),
    getURL: vi.fn((path) => `moz-extension://fake/${path}`),
  },
  messages: {
    query: vi.fn(async () => ({ messages: [] })),
    getFull: vi.fn(async () => ({ parts: [] })),
  },
  tmCalendar: {
    createCalendarEvent: vi.fn(async () => ({ ok: true, event_id: 'evt1' })),
    getCalendars: vi.fn(async () => ({ ok: true, calendars: [] })),
  },
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock utils.js (log, normalizeUnicode)
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: vi.fn((text) => {
    if (!text || typeof text !== 'string') return text;
    return text.normalize('NFKC');
  }),
}));

// Mock config.js
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    events: {
      userKBPromptUpdated: 'user-kb-prompt-updated',
    },
  },
}));

// Mock promptGenerator.js — getUserKBPrompt reads from our storageData
vi.mock('../agent/modules/promptGenerator.js', () => ({
  getUserKBPrompt: vi.fn(async () => {
    const key = 'user_prompts:user_kb.md';
    return storageData[key] || '';
  }),
}));

// Mock patchApplier.js with a simplified implementation
vi.mock('../agent/modules/patchApplier.js', () => ({
  applyKBPatch: vi.fn((current, patchText) => {
    const lines = patchText.trim().split('\n');
    const op = lines[0].trim().toUpperCase();
    const content = lines.slice(1).join('\n').trim();
    if (!content) return null;

    if (op === 'ADD') {
      // Check for duplicate
      const existingLines = current.split('\n').map(l => l.replace(/^-\s*/, '').trim());
      if (existingLines.includes(content)) return current; // duplicate
      const bullet = `- ${content}`;
      return current ? `${current}\n${bullet}` : bullet;
    }
    if (op === 'DEL') {
      const resultLines = current.split('\n').filter(line => {
        const trimmed = line.replace(/^-\s*/, '').trim();
        return trimmed !== content;
      });
      const result = resultLines.join('\n');
      if (result === current) return current; // not found — no change
      return result;
    }
    return null;
  }),
}));

// Mock reminderStateStore.js
vi.mock('../agent/modules/reminderStateStore.js', () => ({
  hashReminder: vi.fn((r) => `hash_${r.source}_${r.content?.slice(0, 20)}`),
  setEnabled: vi.fn(async () => {}),
}));

// Mock kbReminderGenerator.js
vi.mock('../agent/modules/kbReminderGenerator.js', () => ({
  generateKBReminders: vi.fn(async () => {}),
}));

// Mock knowledgebase.js
vi.mock('../agent/modules/knowledgebase.js', () => ({
  debouncedKbUpdate: vi.fn(),
}));

// Mock reminderBuilder.js
vi.mock('../agent/modules/reminderBuilder.js', () => ({
  buildReminderList: vi.fn(async () => ({ reminders: [] })),
}));

// Mock chatConfig.js
vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    searchPageSizeDefault: 5,
    searchPageSizeMax: 50,
    searchPrefetchPagesDefault: 4,
    searchPrefetchMaxResults: 200,
    inboxPageSizeDefault: 10,
    inboxPageSizeMax: 50,
    createEventDefaultDurationMinutes: 60,
  },
}));

// Mock helpers.js
vi.mock('../chat/modules/helpers.js', () => ({
  formatMailList: vi.fn((items) =>
    items.map((i) => `[${i.uniqueId}] ${i.subject} from ${i.from}`).join('\n')
  ),
  toNaiveIso: vi.fn((s) => s),
  toIsoNoMs: vi.fn((d) => (d || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')),
}));

// Mock inboxContext.js
vi.mock('../agent/modules/inboxContext.js', () => ({
  buildInboxContext: vi.fn(async () => '[]'),
}));

// Mock chat.js (used by calendar_event_create)
vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => ({})),
}));

// Mock context.js (used by calendar_event_create)
vi.mock('../chat/modules/context.js', () => ({
  ctx: { rawUserTexts: [], fsmSessions: {}, state: '' },
  initFsmSession: vi.fn(),
}));

// Mock entityResolver.js (used by core.js getToolActivityLabel)
vi.mock('../chat/modules/entityResolver.js', () => ({
  resolveEmailSubject: vi.fn(async () => null),
  resolveEventDetails: vi.fn(async () => null),
}));

// Mock templateManager.js (imported by promptGenerator)
vi.mock('../agent/modules/templateManager.js', () => ({
  ensureMigration: vi.fn(async () => {}),
  getTemplatesAsPrimedPrompt: vi.fn(async () => ''),
}));

// ---------------------------------------------------------------------------
// Helper: clear storage between tests
// ---------------------------------------------------------------------------
function clearStorage() {
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
}

// ---------------------------------------------------------------------------
// Import tools AFTER mocks are set up
// ---------------------------------------------------------------------------
const reminderAdd = await import('../chat/tools/reminder_add.js');
const reminderDel = await import('../chat/tools/reminder_del.js');
const emailSearch = await import('../chat/tools/email_search.js');
const kbAdd = await import('../chat/tools/kb_add.js');
const kbDel = await import('../chat/tools/kb_del.js');
const memoryRead = await import('../chat/tools/memory_read.js');
const changeSetting = await import('../chat/tools/change_setting.js');
const inboxRead = await import('../chat/tools/inbox_read.js');

// ---------------------------------------------------------------------------
// TB-050: Each tool exports a `run` function
// ---------------------------------------------------------------------------
describe('TB-050: Each tool exports a run function', () => {
  const tools = [
    ['reminder_add', reminderAdd],
    ['reminder_del', reminderDel],
    ['email_search', emailSearch],
    ['kb_add', kbAdd],
    ['kb_del', kbDel],
    ['memory_read', memoryRead],
    ['change_setting', changeSetting],
    ['inbox_read', inboxRead],
  ];

  for (const [name, mod] of tools) {
    it(`${name} exports run as a function`, () => {
      expect(typeof mod.run).toBe('function');
    });
  }
});

// ---------------------------------------------------------------------------
// TB-051: run() returns JSON-serializable result
// ---------------------------------------------------------------------------
describe('TB-051: run() returns JSON-serializable result', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('reminder_add returns serializable result on success', async () => {
    const result = await reminderAdd.run({ text: 'Buy milk', due_date: '2026/03/20' });
    const serialized = JSON.stringify(result);
    expect(serialized).toBeTruthy();
    const parsed = JSON.parse(serialized);
    expect(parsed.ok).toBe(true);
    expect(parsed.reminder).toContain('Buy milk');
  });

  it('email_search returns serializable result', async () => {
    const result = await emailSearch.run({ query: 'test' });
    const serialized = JSON.stringify(result);
    expect(serialized).toBeTruthy();
    const parsed = JSON.parse(serialized);
    expect(parsed.results).toBeTruthy();
  });

  it('memory_read returns serializable result', async () => {
    const result = await memoryRead.run({ timestamp: Date.now() });
    const serialized = JSON.stringify(result);
    expect(serialized).toBeTruthy();
    // memory_read returns a formatted string on success
    expect(typeof result).toBe('string');
  });

  it('kb_add returns serializable result on success', async () => {
    const result = await kbAdd.run({ statement: 'My cat is named Whiskers' });
    const serialized = JSON.stringify(result);
    expect(serialized).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// TB-052: Missing required args -> error in result
// ---------------------------------------------------------------------------
describe('TB-052: Missing required args produce error', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('reminder_add with no text returns error', async () => {
    const result = await reminderAdd.run({});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('missing text');
  });

  it('reminder_add with empty text returns error', async () => {
    const result = await reminderAdd.run({ text: '' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('missing text');
  });

  it('kb_add with no statement returns error', async () => {
    const result = await kbAdd.run({});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('missing statement');
  });

  it('kb_del with no statement returns error', async () => {
    const result = await kbDel.run({});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('missing statement');
  });

  it('reminder_del with no text returns error', async () => {
    const result = await reminderDel.run({});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('missing text');
  });

  it('memory_read with no timestamp returns error', async () => {
    const result = await memoryRead.run({});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('timestamp');
  });

  it('change_setting with no setting key returns error', async () => {
    const result = await changeSetting.run({});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Unknown setting');
  });
});

// ---------------------------------------------------------------------------
// TB-053: Invalid arg types -> error
// ---------------------------------------------------------------------------
describe('TB-053: Invalid arg types produce error', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('reminder_add with numeric text returns error', async () => {
    const result = await reminderAdd.run({ text: 12345 });
    expect(result).toHaveProperty('error');
  });

  it('memory_read with string timestamp returns error', async () => {
    const result = await memoryRead.run({ timestamp: 'not-a-number' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('timestamp');
  });

  it('change_setting with string value for boolean setting returns error', async () => {
    const result = await changeSetting.run({ setting: 'notifications.proactive_enabled', value: 'true' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('boolean');
  });

  it('change_setting with float value for integer setting returns error', async () => {
    const result = await changeSetting.run({ setting: 'notifications.new_reminder_window_days', value: 3.5 });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('integer');
  });

  it('change_setting with out-of-range number returns error', async () => {
    const result = await changeSetting.run({ setting: 'notifications.new_reminder_window_days', value: 999 });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('between');
  });
});

// ---------------------------------------------------------------------------
// TB-060: reminder_add validates date format (YYYY/MM/DD)
// ---------------------------------------------------------------------------
describe('TB-060: reminder_add validates date format', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('accepts valid YYYY/MM/DD date', async () => {
    const result = await reminderAdd.run({ text: 'Test reminder', due_date: '2026/03/15' });
    expect(result).not.toHaveProperty('error');
    expect(result.ok).toBe(true);
  });

  it('rejects invalid date format MM/DD/YYYY', async () => {
    const result = await reminderAdd.run({ text: 'Test reminder', due_date: '03/15/2026' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('YYYY/MM/DD');
  });

  it('rejects date with dashes YYYY-MM-DD', async () => {
    const result = await reminderAdd.run({ text: 'Test reminder', due_date: '2026-03-15' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('YYYY/MM/DD');
  });

  it('rejects malformed date', async () => {
    const result = await reminderAdd.run({ text: 'Test reminder', due_date: 'tomorrow' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('YYYY/MM/DD');
  });

  it('accepts valid HH:MM time', async () => {
    const result = await reminderAdd.run({ text: 'Test reminder', due_date: '2026/03/15', due_time: '14:30' });
    expect(result).not.toHaveProperty('error');
    expect(result.ok).toBe(true);
    expect(result.reminder).toContain('14:30');
  });

  it('rejects invalid time format', async () => {
    const result = await reminderAdd.run({ text: 'Test reminder', due_date: '2026/03/15', due_time: '2:30 PM' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('HH:MM');
  });
});

// ---------------------------------------------------------------------------
// TB-061: reminder_add deduplication check
// ---------------------------------------------------------------------------
describe('TB-061: reminder_add deduplication', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('detects duplicate reminder and returns no-change message', async () => {
    // First add
    const first = await reminderAdd.run({ text: 'Water the plants' });
    expect(first.ok).toBe(true);

    // Second add with same text — should be a duplicate
    const second = await reminderAdd.run({ text: 'Water the plants' });
    expect(typeof second).toBe('string');
    expect(second).toContain('duplicate');
  });
});

// ---------------------------------------------------------------------------
// TB-062: email_search query construction
// ---------------------------------------------------------------------------
describe('TB-062: email_search query construction', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    // Reset pagination sessions between tests
    emailSearch.resetPaginationSessions();
  });

  it('sends FTS search message with query', async () => {
    await emailSearch.run({ query: 'invoice' });
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fts',
        cmd: 'search',
        q: 'invoice',
      })
    );
  });

  it('passes date range to FTS backend', async () => {
    await emailSearch.run({ query: 'meeting', from_date: '2026-01-01', to_date: '2026-03-01' });
    const call = browser.runtime.sendMessage.mock.calls.find(
      c => c[0]?.type === 'fts' && c[0]?.cmd === 'search'
    );
    expect(call).toBeTruthy();
    // When dates are provided, ignoreDate should be false
    expect(call[0].ignoreDate).toBe(false);
    expect(call[0].from).toBeTruthy();
    expect(call[0].to).toBeTruthy();
  });

  it('sets ignoreDate when no dates provided', async () => {
    await emailSearch.run({ query: 'hello' });
    const call = browser.runtime.sendMessage.mock.calls.find(
      c => c[0]?.type === 'fts' && c[0]?.cmd === 'search'
    );
    expect(call).toBeTruthy();
    expect(call[0].ignoreDate).toBe(true);
  });

  it('returns paginated result structure', async () => {
    const result = await emailSearch.run({ query: 'test' });
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('page');
    expect(result).toHaveProperty('totalPages');
    expect(result).toHaveProperty('totalItems');
  });
});

// ---------------------------------------------------------------------------
// TB-063: calendar_event_create required fields
// ---------------------------------------------------------------------------
describe('TB-063: calendar_event_create required fields', () => {
  // calendar_event_create is an FSM tool that uses requestAnimationFrame.
  // We test its run() returns the FSM marker immediately.

  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    // Provide requestAnimationFrame in test env
    globalThis.requestAnimationFrame = vi.fn((cb) => setTimeout(cb, 0));
  });

  it('returns FSM marker with tool name', async () => {
    const calendarEventCreate = await import('../chat/tools/calendar_event_create.js');
    const result = await calendarEventCreate.run(
      { title: 'Team standup', start_iso: '2026-03-20T10:00:00' },
      { callId: 'call_1' }
    );
    expect(result.fsm).toBe(true);
    expect(result.tool).toBe('calendar_event_create');
  });
});

// ---------------------------------------------------------------------------
// TB-064: kb_add appends to existing KB
// ---------------------------------------------------------------------------
describe('TB-064: kb_add appends to existing KB', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('appends statement to empty KB', async () => {
    const result = await kbAdd.run({ statement: 'I prefer dark mode' });
    expect(result).toBe('Added to knowledge base.');
    // Verify storage was updated
    expect(browser.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'user_prompts:user_kb.md': expect.stringContaining('[Pinned] I prefer dark mode'),
      })
    );
  });

  it('appends statement to existing KB content', async () => {
    storageData['user_prompts:user_kb.md'] = '- [Pinned] My name is Alice';
    const result = await kbAdd.run({ statement: 'I work at Acme Corp' });
    expect(result).toBe('Added to knowledge base.');
    // The set call should contain both old and new entries
    const setCall = browser.storage.local.set.mock.calls.find(
      c => c[0]['user_prompts:user_kb.md']
    );
    expect(setCall).toBeTruthy();
    const saved = setCall[0]['user_prompts:user_kb.md'];
    expect(saved).toContain('My name is Alice');
    expect(saved).toContain('[Pinned] I work at Acme Corp');
  });

  it('auto-prefixes statement with [Pinned]', async () => {
    const result = await kbAdd.run({ statement: 'My favorite color is blue' });
    expect(result).toBe('Added to knowledge base.');
    const setCall = browser.storage.local.set.mock.calls.find(
      c => c[0]['user_prompts:user_kb.md']
    );
    const saved = setCall[0]['user_prompts:user_kb.md'];
    expect(saved).toContain('[Pinned] My favorite color is blue');
  });
});

// ---------------------------------------------------------------------------
// TB-065: kb_del removes specific entry
// ---------------------------------------------------------------------------
describe('TB-065: kb_del removes specific entry', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('removes matching statement from KB', async () => {
    storageData['user_prompts:user_kb.md'] = '- [Pinned] My name is Alice\n- [Pinned] I like cats';
    const result = await kbDel.run({ statement: '[Pinned] I like cats' });
    expect(result).toBe('Removed from knowledge base.');
    const setCall = browser.storage.local.set.mock.calls.find(
      c => c[0]['user_prompts:user_kb.md']
    );
    expect(setCall).toBeTruthy();
    const saved = setCall[0]['user_prompts:user_kb.md'];
    expect(saved).toContain('My name is Alice');
    expect(saved).not.toContain('I like cats');
  });

  it('returns error when KB is empty', async () => {
    const result = await kbDel.run({ statement: 'nonexistent' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('empty');
  });

  it('returns error when statement not found', async () => {
    storageData['user_prompts:user_kb.md'] = '- [Pinned] My name is Alice';
    const result = await kbDel.run({ statement: 'I like dogs' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// TB-066: memory_read formats memory entries
// ---------------------------------------------------------------------------
describe('TB-066: memory_read formats memory entries', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('formats entries with date headers', async () => {
    const ts = new Date('2026-03-10T15:00:00Z').getTime();
    const result = await memoryRead.run({ timestamp: ts });
    expect(typeof result).toBe('string');
    expect(result).toContain('Conversation from');
    expect(result).toContain('User: hello');
    expect(result).toContain('Assistant: hi there');
  });

  it('returns message when no entries found', async () => {
    // Override sendMessage to return empty array for this test
    browser.runtime.sendMessage.mockResolvedValueOnce([]);
    const result = await memoryRead.run({ timestamp: Date.now() });
    expect(typeof result).toBe('string');
    expect(result).toContain('No conversation found');
  });

  it('handles max_turns parameter', async () => {
    // Return many entries
    const ts = Date.now();
    const manyEntries = Array.from({ length: 30 }, (_, i) => ({
      dateMs: ts + i * 1000,
      content: `Turn ${i}`,
    }));
    browser.runtime.sendMessage.mockResolvedValueOnce(manyEntries);
    const result = await memoryRead.run({ timestamp: ts, max_turns: 5 });
    // Should only include 5 entries
    const segments = result.split('--- Conversation from');
    // First split element is empty string before first separator
    expect(segments.length - 1).toBe(5);
  });

  it('returns error for backend failure', async () => {
    browser.runtime.sendMessage.mockResolvedValueOnce({ error: 'backend down' });
    const result = await memoryRead.run({ timestamp: Date.now() });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('memory read failed');
  });
});
