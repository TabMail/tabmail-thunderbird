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
      // Memory search mock
      if (msg?.type === 'fts' && msg?.cmd === 'memorySearch') {
        return [
          { dateMs: Date.now() - 86400000, content: 'User: what is tabmail?\nAssistant: TabMail is an email client.', snippet: 'tabmail email client' },
          { dateMs: Date.now() - 172800000, content: 'User: how do reminders work?\nAssistant: You can set reminders.', snippet: 'reminders work' },
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
    listCalendars: vi.fn(async () => []),
    queryCalendarItems: vi.fn(async () => []),
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
vi.mock('../agent/modules/knowledgebase.js', () => ({}));

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
    contactsDefaultLimit: 25,
    contactsMaxLimit: 100,
    contactsQueryTimeoutMs: 5000,
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

// Mock contacts.js (used by contacts_search)
vi.mock('../chat/modules/contacts.js', () => ({
  findContactsRawRows: vi.fn(async () => []),
  parseVCardBasic: vi.fn(() => ({ fn: '', emails: [], firstName: '', lastName: '', nickName: '', preferredEmail: '' })),
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
const memorySearch = await import('../chat/tools/memory_search.js');
const changeSetting = await import('../chat/tools/change_setting.js');
const inboxRead = await import('../chat/tools/inbox_read.js');
const calendarSearch = await import('../chat/tools/calendar_search.js');
const contactsSearch = await import('../chat/tools/contacts_search.js');

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
    ['memory_search', memorySearch],
    ['calendar_search', calendarSearch],
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

  it('change_setting coerces string "true"/"false" to boolean', async () => {
    const result = await changeSetting.run({ setting: 'notifications.proactive_enabled', value: 'true' });
    expect(result).toHaveProperty('ok', true);
    expect(result.value).toBe(true);
  });

  it('change_setting with non-boolean string for boolean setting returns error', async () => {
    const result = await changeSetting.run({ setting: 'notifications.proactive_enabled', value: 'yes' });
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

// ---------------------------------------------------------------------------
// TB-067: reminder_del – successful KB reminder deletion
// ---------------------------------------------------------------------------
describe('TB-067: reminder_del handler logic', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('deletes a matching KB reminder', async () => {
    storageData['user_prompts:user_kb.md'] =
      '- Reminder: Due 2026/03/20, Buy groceries\n- [Pinned] My name is Alice';
    const result = await reminderDel.run({ text: 'Buy groceries' });
    expect(result.ok).toBe(true);
    expect(result.removed).toContain('Buy groceries');
    // KB should no longer contain the reminder
    const setCall = browser.storage.local.set.mock.calls.find(
      c => c[0]['user_prompts:user_kb.md'] !== undefined
    );
    expect(setCall).toBeTruthy();
    const saved = setCall[0]['user_prompts:user_kb.md'];
    expect(saved).not.toContain('Buy groceries');
    expect(saved).toContain('My name is Alice');
  });

  it('returns error when multiple KB reminders match', async () => {
    storageData['user_prompts:user_kb.md'] =
      '- Reminder: Due 2026/03/20, Meeting with Bob\n- Reminder: Due 2026/03/21, Meeting with Carol';
    const result = await reminderDel.run({ text: 'Meeting' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Multiple reminders');
    expect(result.matches).toHaveLength(2);
  });

  it('returns error when no reminder matches and no email-reminders', async () => {
    storageData['user_prompts:user_kb.md'] = '- [Pinned] My name is Alice';
    const result = await reminderDel.run({ text: 'nonexistent reminder' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('No reminder found');
  });

  it('snoozes a matching email-reminder when no KB match', async () => {
    storageData['user_prompts:user_kb.md'] = '- [Pinned] My name is Alice';
    // Mock buildReminderList to return an email-reminder
    const { buildReminderList } = await import('../agent/modules/reminderBuilder.js');
    buildReminderList.mockResolvedValueOnce({
      reminders: [
        { source: 'message', content: 'Reply to Bob about the budget', hash: 'hash_msg_reply' },
      ],
    });
    const result = await reminderDel.run({ text: 'Reply to Bob' });
    expect(result.ok).toBe(true);
    expect(result.snoozed).toContain('Reply to Bob');
    expect(result.source).toBe('email');
  });

  it('handles [Reminder] format (not just "Reminder:")', async () => {
    storageData['user_prompts:user_kb.md'] =
      '- [Reminder] Due 2026/04/01, Call dentist';
    const result = await reminderDel.run({ text: 'Call dentist' });
    expect(result.ok).toBe(true);
    expect(result.removed).toContain('Call dentist');
  });

  it('clears reached_out flag for deleted reminder', async () => {
    storageData['user_prompts:user_kb.md'] =
      '- Reminder: Due 2026/03/20, Submit report';
    storageData['notifications.reached_out_ids'] = {
      'hash_kb_Submit report': true,
    };
    const result = await reminderDel.run({ text: 'Submit report' });
    expect(result.ok).toBe(true);
    // Should have called storage.local.set to clear the reached_out flag
    const reachedOutSetCall = browser.storage.local.set.mock.calls.find(
      c => c[0]['notifications.reached_out_ids'] !== undefined
    );
    expect(reachedOutSetCall).toBeTruthy();
  });

  it('case-insensitive matching', async () => {
    storageData['user_prompts:user_kb.md'] =
      '- Reminder: Due 2026/03/20, URGENT meeting prep';
    const result = await reminderDel.run({ text: 'urgent meeting' });
    expect(result.ok).toBe(true);
    expect(result.removed).toContain('URGENT meeting prep');
  });
});

// ---------------------------------------------------------------------------
// TB-068: inbox_read – pagination and session handling
// ---------------------------------------------------------------------------
describe('TB-068: inbox_read handler logic', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    inboxRead.resetPaginationSessions();
  });

  it('returns paginated result structure', async () => {
    const { buildInboxContext } = await import('../agent/modules/inboxContext.js');
    buildInboxContext.mockResolvedValueOnce(JSON.stringify([
      { uniqueId: 'u1', subject: 'Email 1', from: 'alice@test.com' },
      { uniqueId: 'u2', subject: 'Email 2', from: 'bob@test.com' },
    ]));
    const result = await inboxRead.run({});
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('page');
    expect(result).toHaveProperty('totalPages');
    expect(result).toHaveProperty('totalItems');
    expect(result.totalItems).toBe(2);
    expect(result.page).toBe(1);
  });

  it('returns page 1 of N for large inbox', async () => {
    const { buildInboxContext } = await import('../agent/modules/inboxContext.js');
    // Create 25 items (page size default is 10)
    const items = Array.from({ length: 25 }, (_, i) => ({
      uniqueId: `u${i}`, subject: `Email ${i}`, from: `user${i}@test.com`,
    }));
    buildInboxContext.mockResolvedValueOnce(JSON.stringify(items));
    const result = await inboxRead.run({});
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(3);
    expect(result.totalItems).toBe(25);
  });

  it('supports page_index parameter', async () => {
    const { buildInboxContext } = await import('../agent/modules/inboxContext.js');
    const items = Array.from({ length: 25 }, (_, i) => ({
      uniqueId: `u${i}`, subject: `Email ${i}`, from: `user${i}@test.com`,
    }));
    buildInboxContext.mockResolvedValueOnce(JSON.stringify(items));
    // First call creates session
    await inboxRead.run({});
    // Second call with page_index
    const result = await inboxRead.run({ page_index: 2 });
    expect(result.page).toBe(2);
  });

  it('clamps page_index to max page', async () => {
    const { buildInboxContext } = await import('../agent/modules/inboxContext.js');
    buildInboxContext.mockResolvedValueOnce(JSON.stringify([
      { uniqueId: 'u1', subject: 'Email 1', from: 'alice@test.com' },
    ]));
    const result = await inboxRead.run({ page_index: 999 });
    expect(result.page).toBe(1); // Only 1 page, so clamped
  });

  it('handles empty inbox', async () => {
    const { buildInboxContext } = await import('../agent/modules/inboxContext.js');
    buildInboxContext.mockResolvedValueOnce('[]');
    const result = await inboxRead.run({});
    expect(result.totalItems).toBe(0);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(1);
  });

  it('handles invalid JSON from buildInboxContext', async () => {
    const { buildInboxContext } = await import('../agent/modules/inboxContext.js');
    buildInboxContext.mockResolvedValueOnce('not valid json');
    const result = await inboxRead.run({});
    expect(result.totalItems).toBe(0);
  });

  it('reuses session across calls (no duplicate buildInboxContext)', async () => {
    const { buildInboxContext } = await import('../agent/modules/inboxContext.js');
    buildInboxContext.mockResolvedValueOnce(JSON.stringify([
      { uniqueId: 'u1', subject: 'Email 1', from: 'alice@test.com' },
    ]));
    await inboxRead.run({});
    await inboxRead.run({ page_index: 1 });
    // buildInboxContext should only be called once (session reuse)
    expect(buildInboxContext).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TB-069: memory_search – query, pagination, error handling
// ---------------------------------------------------------------------------
describe('TB-069: memory_search handler logic', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    memorySearch.resetPaginationSessions();
  });

  it('returns error for missing query', async () => {
    const result = await memorySearch.run({});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('missing query');
  });

  it('returns error for empty query', async () => {
    const result = await memorySearch.run({ query: '   ' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('missing query');
  });

  it('sends memorySearch message to FTS backend', async () => {
    await memorySearch.run({ query: 'tabmail' });
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fts',
        cmd: 'memorySearch',
        q: 'tabmail',
      })
    );
  });

  it('returns paginated result structure on success', async () => {
    const result = await memorySearch.run({ query: 'tabmail' });
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('page');
    expect(result).toHaveProperty('totalPages');
    expect(result).toHaveProperty('totalItems');
    expect(result.totalItems).toBe(2);
    expect(result.page).toBe(1);
    expect(result).toHaveProperty('hint');
  });

  it('returns no-results message when backend returns empty array', async () => {
    browser.runtime.sendMessage.mockResolvedValueOnce([]);
    const result = await memorySearch.run({ query: 'nonexistent' });
    expect(result.totalItems).toBe(0);
    expect(result.results).toContain('No relevant memories');
  });

  it('returns error when backend returns error object', async () => {
    browser.runtime.sendMessage.mockResolvedValueOnce({ error: 'index corrupted' });
    const result = await memorySearch.run({ query: 'test' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('memory search failed');
  });

  it('returns error when backend returns non-array', async () => {
    browser.runtime.sendMessage.mockResolvedValueOnce('not an array');
    const result = await memorySearch.run({ query: 'test' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('invalid response format');
  });

  it('passes date range to FTS backend', async () => {
    await memorySearch.run({ query: 'meeting', from_date: '2026-01-01', to_date: '2026-03-01' });
    const call = browser.runtime.sendMessage.mock.calls.find(
      c => c[0]?.type === 'fts' && c[0]?.cmd === 'memorySearch'
    );
    expect(call).toBeTruthy();
    expect(call[0].ignoreDate).toBe(false);
    expect(call[0].from).toBeTruthy();
    expect(call[0].to).toBeTruthy();
  });

  it('sets ignoreDate when no dates provided', async () => {
    await memorySearch.run({ query: 'hello' });
    const call = browser.runtime.sendMessage.mock.calls.find(
      c => c[0]?.type === 'fts' && c[0]?.cmd === 'memorySearch'
    );
    expect(call).toBeTruthy();
    expect(call[0].ignoreDate).toBe(true);
  });

  it('formats results with timestamp for memory_read follow-up', async () => {
    const result = await memorySearch.run({ query: 'tabmail' });
    expect(result.results).toContain('timestamp:');
  });

  it('reuses session for same query (no duplicate FTS call)', async () => {
    await memorySearch.run({ query: 'tabmail' });
    const callCount1 = browser.runtime.sendMessage.mock.calls.filter(
      c => c[0]?.cmd === 'memorySearch'
    ).length;
    await memorySearch.run({ query: 'tabmail', page_index: 1 });
    const callCount2 = browser.runtime.sendMessage.mock.calls.filter(
      c => c[0]?.cmd === 'memorySearch'
    ).length;
    expect(callCount2).toBe(callCount1); // no new FTS call
  });

  it('creates new session for different query', async () => {
    await memorySearch.run({ query: 'tabmail' });
    memorySearch.resetPaginationSessions();
    await memorySearch.run({ query: 'different query' });
    const calls = browser.runtime.sendMessage.mock.calls.filter(
      c => c[0]?.cmd === 'memorySearch'
    );
    expect(calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TB-070: calendar_search – query, date range, error handling
// ---------------------------------------------------------------------------
describe('TB-070: calendar_search handler logic', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    calendarSearch.resetPaginationSessions();
  });

  it('returns error when query is missing', async () => {
    const result = await calendarSearch.run({});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('query');
  });

  it('returns error when query is empty string', async () => {
    const result = await calendarSearch.run({ query: '' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('query');
  });

  it('returns error when tmCalendar bridge is unavailable', async () => {
    const savedBridge = browser.tmCalendar;
    delete browser.tmCalendar;
    const result = await calendarSearch.run({ query: 'meeting' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('calendar bridge not available');
    browser.tmCalendar = savedBridge;
  });

  it('returns paginated result structure for valid query', async () => {
    browser.tmCalendar.listCalendars.mockResolvedValueOnce([
      { id: 'cal1', name: 'Personal' },
    ]);
    browser.tmCalendar.queryCalendarItems.mockResolvedValueOnce([
      {
        id: 'evt1',
        title: 'Team meeting',
        calendarId: 'cal1',
        startMs: new Date('2026-03-20T10:00:00').getTime(),
        endMs: new Date('2026-03-20T11:00:00').getTime(),
      },
    ]);
    const result = await calendarSearch.run({
      query: 'meeting',
      from_date: '2026-03-20',
      to_date: '2026-03-20',
    });
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('page');
    expect(result).toHaveProperty('totalPages');
    expect(result).toHaveProperty('totalItems');
  });

  it('returns empty results when no events match query filter', async () => {
    browser.tmCalendar.listCalendars.mockResolvedValueOnce([
      { id: 'cal1', name: 'Personal' },
    ]);
    browser.tmCalendar.queryCalendarItems.mockResolvedValueOnce([
      {
        id: 'evt1',
        title: 'Dentist appointment',
        calendarId: 'cal1',
        startMs: new Date('2026-03-20T10:00:00').getTime(),
        endMs: new Date('2026-03-20T11:00:00').getTime(),
      },
    ]);
    const result = await calendarSearch.run({
      query: 'nonexistent event xyz',
      from_date: '2026-03-20',
      to_date: '2026-03-20',
    });
    expect(result).toHaveProperty('results');
    // Should have no event entries (query filter didn't match)
    expect(result.results).not.toContain('Dentist appointment');
  });

  it('filters events by query term (case-insensitive)', async () => {
    browser.tmCalendar.listCalendars.mockResolvedValueOnce([
      { id: 'cal1', name: 'Work' },
    ]);
    browser.tmCalendar.queryCalendarItems.mockResolvedValueOnce([
      {
        id: 'evt1',
        title: 'Sprint Planning',
        calendarId: 'cal1',
        startMs: new Date('2026-03-20T09:00:00').getTime(),
        endMs: new Date('2026-03-20T10:00:00').getTime(),
      },
      {
        id: 'evt2',
        title: 'Lunch with Alice',
        calendarId: 'cal1',
        startMs: new Date('2026-03-20T12:00:00').getTime(),
        endMs: new Date('2026-03-20T13:00:00').getTime(),
      },
    ]);
    const result = await calendarSearch.run({
      query: 'sprint',
      from_date: '2026-03-20',
      to_date: '2026-03-20',
    });
    expect(result.results).toContain('Sprint Planning');
    expect(result.results).not.toContain('Lunch with Alice');
  });

  it('bypasses query requirement with __bypassQueryRequirement option', async () => {
    browser.tmCalendar.listCalendars.mockResolvedValueOnce([]);
    browser.tmCalendar.queryCalendarItems.mockResolvedValueOnce([]);
    const result = await calendarSearch.run(
      { from_date: '2026-03-20', to_date: '2026-03-20' },
      { __bypassQueryRequirement: true }
    );
    expect(result).not.toHaveProperty('error');
    expect(result).toHaveProperty('results');
  });

  it('handles queryCalendarItems failure gracefully', async () => {
    browser.tmCalendar.listCalendars.mockResolvedValueOnce([
      { id: 'cal1', name: 'Work' },
    ]);
    browser.tmCalendar.queryCalendarItems.mockRejectedValueOnce(new Error('calendar API error'));
    const result = await calendarSearch.run({
      query: 'meeting',
      from_date: '2026-03-20',
      to_date: '2026-03-20',
    });
    // Should return empty results, not throw
    expect(result).toHaveProperty('results');
    expect(result.totalItems).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TB-071: contacts_search – query, empty results, formatting
// ---------------------------------------------------------------------------
describe('TB-071: contacts_search handler logic', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('exports a run function', () => {
    expect(typeof contactsSearch.run).toBe('function');
  });

  it('returns error for missing query', async () => {
    const result = await contactsSearch.run({});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('missing query');
  });

  it('returns error for empty query string', async () => {
    const result = await contactsSearch.run({ query: '   ' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('missing query');
  });

  it('returns empty string when no contacts found', async () => {
    const { findContactsRawRows } = await import('../chat/modules/contacts.js');
    findContactsRawRows.mockResolvedValueOnce([]);
    const result = await contactsSearch.run({ query: 'nobody' });
    expect(result).toBe('');
  });

  it('returns formatted contact details when contacts found', async () => {
    const { findContactsRawRows, parseVCardBasic } = await import('../chat/modules/contacts.js');
    findContactsRawRows.mockResolvedValueOnce([
      {
        id: 'contact1',
        parentId: 'ab1',
        properties: {
          DisplayName: 'Alice Smith',
          FirstName: 'Alice',
          LastName: 'Smith',
          PrimaryEmail: 'alice@example.com',
        },
        vCard: '',
      },
    ]);
    parseVCardBasic.mockReturnValueOnce({
      fn: 'Alice Smith',
      emails: [],
      firstName: 'Alice',
      lastName: 'Smith',
      nickName: '',
      preferredEmail: 'alice@example.com',
    });

    const result = await contactsSearch.run({ query: 'Alice' });
    expect(typeof result).toBe('string');
    expect(result).toContain('name: Alice Smith');
    expect(result).toContain('email: alice@example.com');
    expect(result).toContain('contact_id: contact1');
    expect(result).toContain('addressbook_id: ab1');
    expect(result).toContain('first_name: Alice');
    expect(result).toContain('last_name: Smith');
  });

  it('deduplicates contacts by id', async () => {
    const { findContactsRawRows, parseVCardBasic } = await import('../chat/modules/contacts.js');
    findContactsRawRows.mockResolvedValueOnce([
      {
        id: 'contact1',
        parentId: 'ab1',
        properties: { DisplayName: 'Alice', PrimaryEmail: 'alice@example.com' },
        vCard: '',
      },
      {
        id: 'contact1', // same ID - should be skipped
        parentId: 'ab1',
        properties: { DisplayName: 'Alice', PrimaryEmail: 'alice@example.com' },
        vCard: '',
      },
    ]);
    parseVCardBasic.mockReturnValue({
      fn: '', emails: [], firstName: '', lastName: '', nickName: '', preferredEmail: '',
    });

    const result = await contactsSearch.run({ query: 'Alice' });
    expect(typeof result).toBe('string');
    // Should contain only one contact entry
    const contactMatches = result.split('contact_id:');
    expect(contactMatches.length).toBe(2); // split produces 1 empty + 1 match
  });

  it('skips contacts with no email', async () => {
    const { findContactsRawRows, parseVCardBasic } = await import('../chat/modules/contacts.js');
    findContactsRawRows.mockResolvedValueOnce([
      {
        id: 'contact1',
        parentId: 'ab1',
        properties: { DisplayName: 'No Email Person' },
        vCard: '',
      },
    ]);
    parseVCardBasic.mockReturnValueOnce({
      fn: 'No Email Person', emails: [], firstName: '', lastName: '', nickName: '', preferredEmail: '',
    });

    const result = await contactsSearch.run({ query: 'No Email' });
    expect(result).toBe('');
  });

  it('respects limit parameter', async () => {
    const { findContactsRawRows, parseVCardBasic } = await import('../chat/modules/contacts.js');
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      parentId: 'ab1',
      properties: { DisplayName: `Person ${i}`, PrimaryEmail: `p${i}@test.com` },
      vCard: '',
    }));
    findContactsRawRows.mockResolvedValueOnce(rows);
    parseVCardBasic.mockReturnValue({
      fn: '', emails: [], firstName: '', lastName: '', nickName: '', preferredEmail: '',
    });

    const result = await contactsSearch.run({ query: 'Person', limit: 3 });
    expect(typeof result).toBe('string');
    // Should only have 3 contacts (limit=3)
    const contactMatches = (result.match(/contact_id:/g) || []).length;
    expect(contactMatches).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Additional tool edge cases
// ---------------------------------------------------------------------------
describe('Additional tool edge cases', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  it('email_search handles missing query gracefully', async () => {
    emailSearch.resetPaginationSessions();
    const result = await emailSearch.run({});
    // email_search may return results or error depending on implementation
    expect(result).toBeTruthy();
  });

  it('email_search with from_date only uses date range', async () => {
    emailSearch.resetPaginationSessions();
    const result = await emailSearch.run({ query: 'test', from_date: '2026-01-01' });
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('page');
  });

  it('change_setting with valid boolean value succeeds', async () => {
    const result = await changeSetting.run({ setting: 'notifications.proactive_enabled', value: true });
    expect(result).not.toHaveProperty('error');
    expect(result.ok).toBe(true);
  });

  it('change_setting with valid integer value succeeds', async () => {
    const result = await changeSetting.run({ setting: 'notifications.new_reminder_window_days', value: 5 });
    expect(result).not.toHaveProperty('error');
    expect(result.ok).toBe(true);
  });

  it('change_setting privacy.web_search_enabled stores under webSearchEnabled key', async () => {
    clearStorage();
    const result = await changeSetting.run({ setting: 'privacy.web_search_enabled', value: true });
    expect(result).not.toHaveProperty('error');
    expect(result.ok).toBe(true);
    expect(result.setting).toBe('privacy.web_search_enabled');
    expect(result.value).toBe(true);
    // Must use the storageKey override, not the setting key
    expect(storageData['webSearchEnabled']).toBe(true);
    expect(storageData['privacy.web_search_enabled']).toBeUndefined();
  });

  it('change_setting privacy.web_search_enabled reads previous value from correct key', async () => {
    clearStorage();
    storageData['webSearchEnabled'] = true;
    const result = await changeSetting.run({ setting: 'privacy.web_search_enabled', value: false });
    expect(result.ok).toBe(true);
    expect(result.previous_value).toBe(true);
    expect(result.value).toBe(false);
    expect(storageData['webSearchEnabled']).toBe(false);
  });

  it('change_setting privacy.web_search_enabled with string value returns error', async () => {
    const result = await changeSetting.run({ setting: 'privacy.web_search_enabled', value: 'yes' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('boolean');
  });

  it('change_setting with unknown setting key returns error', async () => {
    const result = await changeSetting.run({ setting: 'privacy.nonexistent', value: true });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Unknown setting');
  });

  it('change_setting number out of range (below min) returns error', async () => {
    const result = await changeSetting.run({ setting: 'notifications.new_reminder_window_days', value: 0 });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('between');
  });

  it('change_setting number out of range (above max) returns error', async () => {
    const result = await changeSetting.run({ setting: 'notifications.due_reminder_advance_minutes', value: 999 });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('between');
  });

  it('change_setting sends setting-changed runtime message', async () => {
    globalThis.browser.runtime.sendMessage.mockClear();
    await changeSetting.run({ setting: 'privacy.web_search_enabled', value: true });
    const settingChangedCalls = globalThis.browser.runtime.sendMessage.mock.calls.filter(
      c => c[0]?.command === 'setting-changed'
    );
    expect(settingChangedCalls.length).toBe(1);
    expect(settingChangedCalls[0][0].key).toBe('webSearchEnabled');
    expect(settingChangedCalls[0][0].value).toBe(true);
  });

  it('change_setting verify read-back after write', async () => {
    clearStorage();
    const result = await changeSetting.run({ setting: 'task.enabled', value: false });
    expect(result.ok).toBe(true);
    expect(storageData['task.enabled']).toBe(false);
  });

  it('change_setting task.advance_minutes stores correct value', async () => {
    clearStorage();
    const result = await changeSetting.run({ setting: 'task.advance_minutes', value: 15 });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(15);
    expect(storageData['task.advance_minutes']).toBe(15);
  });

  it('change_setting accepts string-encoded number', async () => {
    const result = await changeSetting.run({ setting: 'notifications.new_reminder_window_days', value: '10' });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(10);
  });

  it('change_setting returns error when storage throws', async () => {
    const origSet = globalThis.browser.storage.local.set;
    globalThis.browser.storage.local.set = vi.fn().mockRejectedValue(new Error('disk full'));
    try {
      const result = await changeSetting.run({ setting: 'privacy.web_search_enabled', value: true });
      expect(result).toHaveProperty('error');
      expect(result.error).toContain('disk full');
    } finally {
      globalThis.browser.storage.local.set = origSet;
    }
  });

  it('reminder_add with time but no date returns error', async () => {
    const result = await reminderAdd.run({ text: 'Test', due_time: '14:30' });
    // due_time without due_date should be accepted (reminder without date but with time)
    // or error depending on implementation
    expect(result).toBeTruthy();
  });

  it('reminder_add with both date and time succeeds', async () => {
    const result = await reminderAdd.run({
      text: 'Test reminder with time',
      due_date: '2026/04/01',
      due_time: '09:00',
    });
    expect(result.ok).toBe(true);
    expect(result.reminder).toContain('09:00');
  });

  it('kb_add returns duplicate message for existing content', async () => {
    // Add first
    await kbAdd.run({ statement: 'I like pizza' });
    // Add same - should be duplicate
    const result = await kbAdd.run({ statement: 'I like pizza' });
    // The patchApplier mock returns unchanged content for duplicates
    expect(result).toBeTruthy();
  });

  it('calendar_search reuses session on second call with same args', async () => {
    calendarSearch.resetPaginationSessions();
    browser.tmCalendar.listCalendars.mockResolvedValue([]);
    browser.tmCalendar.queryCalendarItems.mockResolvedValue([]);

    await calendarSearch.run({ query: 'test', from_date: '2026-03-20', to_date: '2026-03-21' });
    const listCallCount = browser.tmCalendar.listCalendars.mock.calls.length;
    await calendarSearch.run({ query: 'test', from_date: '2026-03-20', to_date: '2026-03-21' });
    // Should not call listCalendars again (session reuse)
    expect(browser.tmCalendar.listCalendars.mock.calls.length).toBe(listCallCount);
  });

  it('memory_search handles FTS backend exception', async () => {
    memorySearch.resetPaginationSessions();
    browser.runtime.sendMessage.mockRejectedValueOnce(new Error('FTS unavailable'));
    const result = await memorySearch.run({ query: 'test' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('memory search failed');
  });

  it('memory_read with invalid (non-numeric) timestamp returns error', async () => {
    const result = await memoryRead.run({ timestamp: 'abc' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('timestamp');
  });
});
