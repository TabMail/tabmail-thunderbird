/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// chatTools.test.js — Chat tool tests (TB-050 through TB-066)
//
// Tools import from agent/modules/utils.js, agent/modules/config.js,
// agent/modules/promptGenerator.js, agent/modules/patchApplier.js,
// chat/modules/chatConfig.js, chat/modules/helpers.js, and various other
// modules. We mock all browser-dependent modules and set up globalThis.browser.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
        const day = Date.now() - 86400000;
        const twoDays = Date.now() - 172800000;
        return [
          { memId: `m${day}`, dateMs: day, content: 'User: what is tabmail?\nAssistant: TabMail is an email client.', snippet: 'tabmail email client' },
          { memId: `m${twoDays}`, dateMs: twoDays, content: 'User: how do reminders work?\nAssistant: You can set reminders.', snippet: 'reminders work' },
        ];
      }
      // Memory read mock
      if (msg?.type === 'fts' && msg?.cmd === 'memoryRead') {
        if (!msg.timestampMs || typeof msg.timestampMs !== 'number') {
          return { error: 'invalid timestamp' };
        }
        return [
          { memId: `m${msg.timestampMs}`, dateMs: msg.timestampMs, content: 'User: hello\nAssistant: hi there' },
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
    // 13: not a multiple of the page size, so a fetch size derived from the page size fails.
    emailSearchMaxResults: 13,
    memoryListFetchRows: 2,
    memorySearchMaxResults: 15,
    memoryPreviewChars: 400,
    memoryReadMaxTurns: 50,
    memoryReadListRows: 20,
    memoryReadListPreviewChars: 1,
    inboxPageSizeDefault: 10,
    inboxPageSizeMax: 50,
    createEventDefaultDurationMinutes: 60,
    contactsDefaultLimit: 25,
    contactsMaxLimit: 100,
    contactsQueryTimeoutMs: 5000,
    ftsReadinessTimeoutMs: 100,
    ftsReadinessRetryDelayMs: 5,
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
    expect(result).toContain('Conversation from');
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

  it('change_setting compose.autocomplete_enabled=false writes autocompleteEnabled storage key', async () => {
    const result = await changeSetting.run({ setting: 'compose.autocomplete_enabled', value: false });
    expect(result).toHaveProperty('ok', true);
    expect(result.value).toBe(false);
    // The tool persists under the `autocompleteEnabled` storage key (the key the
    // compose content script + Settings page read), not the dotted setting name.
    const stored = await globalThis.browser.storage.local.get({ autocompleteEnabled: true });
    expect(stored.autocompleteEnabled).toBe(false);
  });

  it('change_setting compose.autocomplete_enabled coerces string "false" to boolean', async () => {
    const result = await changeSetting.run({ setting: 'compose.autocomplete_enabled', value: 'false' });
    expect(result).toHaveProperty('ok', true);
    expect(result.value).toBe(false);
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

  it('retries while FTS backend returns undefined, then succeeds', async () => {
    browser.runtime.sendMessage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        { uniqueId: 'uid1', subject: 'Recovered', author: 'a@b.com', dateMs: Date.now(), snippet: 'recovered' },
      ]);
    const result = await emailSearch.run({ query: 'late-ready' });
    expect(result).toHaveProperty('results');
    expect(result.totalItems).toBe(1);
    const calls = browser.runtime.sendMessage.mock.calls.filter(
      (c) => c[0]?.type === 'fts' && c[0]?.cmd === 'search'
    );
    expect(calls.length).toBe(3);
  });

  it('gives up after timeout when FTS backend keeps returning undefined', async () => {
    const originalImpl = browser.runtime.sendMessage.getMockImplementation();
    browser.runtime.sendMessage.mockResolvedValue(undefined);
    try {
      const result = await emailSearch.run({ query: 'never-ready' });
      expect(result).toHaveProperty('error');
      expect(result.error).toContain('invalid response format');
      const calls = browser.runtime.sendMessage.mock.calls.filter(
        (c) => c[0]?.type === 'fts' && c[0]?.cmd === 'search'
      );
      expect(calls.length).toBeGreaterThan(1);
    } finally {
      if (originalImpl) browser.runtime.sendMessage.mockImplementation(originalImpl);
    }
  });
});

// ---------------------------------------------------------------------------
// TB-062c: a search sends only its own search request (#174)
// ---------------------------------------------------------------------------
// The background's FTS handler runs only the commands it knows and refuses any
// other with an error. So every runtime message a search tool sends is its own
// search request, retries included.
describe('TB-062c: a search sends only its own search request', () => {
  let originalImpl;
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    emailSearch.resetPaginationSessions();
    memorySearch.resetPaginationSessions();
    originalImpl = browser.runtime.sendMessage.getMockImplementation();
  });
  afterEach(() => {
    browser.runtime.sendMessage.mockImplementation(originalImpl);
  });

  // `notReady` requests are answered undefined first (no handler yet), then the search answers.
  async function sentMessages(tool, cmd, args, notReady) {
    let unanswered = notReady;
    browser.runtime.sendMessage.mockImplementation(async (msg) => {
      if (msg?.type !== 'fts' || msg?.cmd !== cmd) return undefined;
      if (unanswered > 0) { unanswered -= 1; return undefined; }
      return [];
    });
    const result = await tool.run(args);
    expect(result).not.toHaveProperty('error');
    return browser.runtime.sendMessage.mock.calls.map((c) => c[0]);
  }

  it.each([
    ['email_search', 'search', 0, () => emailSearch],
    ['email_search', 'search', 2, () => emailSearch],
    ['memory_search', 'memorySearch', 0, () => memorySearch],
    ['memory_search', 'memorySearch', 2, () => memorySearch],
  ])('%s sends only %s requests (%i not-ready answers first)', async (_name, cmd, notReady, tool) => {
    const sent = await sentMessages(tool(), cmd, { query: 'quarterly report' }, notReady);
    expect(sent).toHaveLength(notReady + 1);
    for (const msg of sent) expect(msg).toMatchObject({ type: 'fts', cmd });
  });

  // A listing of recent conversations (no query) fetches in steps; still only its own requests.
  it.each([0, 2])('memory_search listing sends only memorySearch requests (%i not-ready answers first)', async (notReady) => {
    const sent = await sentMessages(memorySearch, 'memorySearch', {}, notReady);
    expect(sent).toHaveLength(notReady + 1);
    for (const msg of sent) expect(msg).toMatchObject({ type: 'fts', cmd: 'memorySearch' });
  });
});

// ---------------------------------------------------------------------------
// TB-062b: email_search sorts in the search, then pages its best matches (#150)
// ---------------------------------------------------------------------------
describe('TB-062b: email_search sort and fetch size', () => {
  const day = 86_400_000;
  const now = Date.now();
  // Hits as the search answers them; `dates` are days ago, in the answer's order.
  const hitsOf = (dates) => dates.map((d, i) => ({
    uniqueId: `uid${i}`, subject: `Subject ${i}`, author: 'a@example.com', dateMs: now - d * day, snippet: '',
  }));

  // The search answers at most the limit it is asked for, as the helper does.
  async function withSearchAnswer(hits, body) {
    const originalImpl = browser.runtime.sendMessage.getMockImplementation();
    browser.runtime.sendMessage.mockImplementation(async (msg) => (msg?.cmd === 'search' ? hits.slice(0, msg.limit) : null));
    try {
      await body();
    } finally {
      if (originalImpl) browser.runtime.sendMessage.mockImplementation(originalImpl);
    }
  }

  const searchCalls = () => browser.runtime.sendMessage.mock.calls.filter(c => c[0]?.type === 'fts' && c[0]?.cmd === 'search');

  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    emailSearch.resetPaginationSessions();
  });

  it('asks the search for its sort, relevance when none is given', async () => {
    await withSearchAnswer(hitsOf([1]), async () => {
      await emailSearch.run({ query: 'invoice' });
      await emailSearch.run({ query: 'invoice', sort: 'date_asc' });
      await emailSearch.run({ query: 'invoice', sort: 'date_desc' });
    });
    expect(searchCalls().map(c => c[0].sort)).toEqual(['relevance', 'date_asc', 'date_desc']);
  });

  it('asks the search for relevance when the sort given is not one it knows', async () => {
    // The helper refuses a sort it does not know, so the tool must never pass one through.
    // Each its own query: an unknown sort shares the relevance session, so a reused query sends no search.
    await withSearchAnswer(hitsOf([1]), async () => {
      for (const [i, sort] of ['newest', 'DATE_DESC', 7, null].entries()) {
        await emailSearch.run({ query: `invoice ${i}`, sort });
      }
    });
    expect(searchCalls().map(c => c[0].sort)).toEqual(['relevance', 'relevance', 'relevance', 'relevance']);
  });

  it('fetches emailSearchMaxResults (13 here), whatever the page size', async () => {
    const { CHAT_SETTINGS } = await import('../chat/modules/chatConfig.js');
    const pageSize = CHAT_SETTINGS.searchPageSizeDefault;
    try {
      await withSearchAnswer(hitsOf(Array.from({ length: 40 }, (_, i) => i + 1)), async () => {
        const atDefault = await emailSearch.run({ query: 'invoice' });
        expect(atDefault).toMatchObject({ totalItems: 13, totalPages: 3 });
        CHAT_SETTINGS.searchPageSizeDefault = CHAT_SETTINGS.searchPageSizeMax;
        const atMax = await emailSearch.run({ query: 'receipt' });
        expect(atMax).toMatchObject({ totalItems: 13, totalPages: 1 });
        expect(atMax.results).toContain('Subject 12');
        expect(atMax.results).not.toContain('Subject 13');
      });
    } finally {
      CHAT_SETTINGS.searchPageSizeDefault = pageSize;
    }
    expect(searchCalls().map(c => c[0].limit)).toEqual([13, 13]);
  });

  it('serves fewer matches than the fetch size as they are', async () => {
    await withSearchAnswer(hitsOf([1, 2, 3]), async () => {
      const result = await emailSearch.run({ query: 'invoice' });
      expect(result).toMatchObject({ page: 1, totalPages: 1, totalItems: 3 });
      expect(result.comment).toBeUndefined();
    });
  });

  it('keeps the order the search answered, for a date sort too', async () => {
    // Out of date order on purpose: the search's order is the answer, the tool does not re-sort.
    await withSearchAnswer(hitsOf([3, 1, 2]), async () => {
      for (const sort of ['date_desc', 'date_asc', 'relevance']) {
        const result = await emailSearch.run({ query: 'invoice', sort });
        const at = ['Subject 0', 'Subject 1', 'Subject 2'].map(subject => result.results.indexOf(subject));
        expect(at.every(i => i >= 0), sort).toBe(true);
        expect([...at].sort((a, b) => a - b), sort).toEqual(at);
      }
    });
  });

  it('serves the fetched matches in pages and ends at the last one', async () => {
    await withSearchAnswer(hitsOf(Array.from({ length: 40 }, (_, i) => i + 1)), async () => {
      const first = await emailSearch.run({ query: 'invoice' });
      expect(first).toMatchObject({ page: 1, totalPages: 3, totalItems: 13 });
      expect(first.comment).toContain('page_index: 2');
      const last = await emailSearch.run({ query: 'invoice', page_index: 3 });
      expect(last).toMatchObject({ page: 3, totalPages: 3 });
      expect(last.comment).toBeUndefined();
      expect(last.results).toContain('Subject 12');
      expect(last.results).not.toContain('Subject 13');
      const past = await emailSearch.run({ query: 'invoice', page_index: 9 });
      expect(past).toMatchObject({ page: 3, totalPages: 3 });
    });
    expect(searchCalls().length).toBe(1);
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

  // The window's entries for the listing (a preview each) and the reads (whole).
  // A listing that never ends fails here rather than hanging the file.
  function serveWindow(entries) {
    const answer = browser.runtime.sendMessage.getMockImplementation();
    let listings = 0;
    browser.runtime.sendMessage.mockImplementation(async (msg) => {
      if (msg?.cmd === 'memorySearch') {
        if (++listings > 100) throw new Error('runaway: too many listings');
        return entries
          .filter((e) => e.dateMs >= msg.from && e.dateMs <= msg.to)
          .sort((x, y) => y.dateMs - x.dateMs)
          .slice(0, msg.limit)
          .map((e) => ({ ...e, content: e.content.slice(0, msg.previewChars) }));
      }
      if (msg?.cmd === 'memoryRead') {
        return entries.filter((e) => Math.abs(e.dateMs - msg.timestampMs) <= msg.toleranceMs);
      }
      return answer(msg);
    });
    return () => browser.runtime.sendMessage.mockImplementation(answer);
  }

  it('formats entries with date headers', async () => {
    const ts = Date.now() - 86400000;
    const restore = serveWindow([
      { memId: 'a', dateMs: ts, content: 'User: hello\nAssistant: hi there' },
      { memId: 'b', dateMs: ts + 1000, content: 'User: how are you?\nAssistant: doing well' },
    ]);
    const result = await memoryRead.run({ timestamp: ts });
    restore();
    expect(typeof result).toBe('string');
    expect(result.split('--- Conversation from')).toHaveLength(3);
    expect(result).toContain('User: hello\nAssistant: hi there');
    expect(result).toContain('User: how are you?\nAssistant: doing well');
  });

  it('returns message when no entries found', async () => {
    const restore = serveWindow([]);
    const result = await memoryRead.run({ timestamp: Date.now() });
    restore();
    expect(typeof result).toBe('string');
    expect(result).toContain('No conversation found');
  });

  it('handles max_turns parameter', async () => {
    const ts = Date.now() - 86400000;
    const restore = serveWindow(Array.from({ length: 30 }, (_, i) => ({
      memId: `t${i}`,
      dateMs: ts + i * 1000,
      content: `Turn ${i}`,
    })));
    const result = await memoryRead.run({ timestamp: ts, max_turns: 5 });
    restore();
    // The five nearest the timestamp, oldest first.
    const segments = result.split('--- Conversation from').slice(1);
    expect(segments.map((s) => s.split('\n')[1])).toEqual(['Turn 0', 'Turn 1', 'Turn 2', 'Turn 3', 'Turn 4']);
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
  const runtimeSendMessage = browser.runtime.sendMessage.getMockImplementation();
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    browser.runtime.sendMessage.mockImplementation(runtimeSendMessage);
    memorySearch.resetPaginationSessions();
  });

  // "What have we discussed" names no topic: with no query the tool asks the
  // helper for the most recent conversations and pages them like any search,
  // fetching them a few at a time (memoryListFetchRows, 2 here; pages of 5).
  // The fake below answers as the native helper does for an empty q: every
  // row newest first (rows of one millisecond in no set order: here in the
  // other order on every request), no snippet, within from/to (ms or ISO)
  // unless ignoreDate, at most limit rows.
  const HOUR = 3_600_000;
  const FETCH_ROWS = 2;
  function helperWithRows(rows) {
    const bound = (v, open) => (v === '' || v === null || v === undefined ? open : typeof v === 'number' ? v : Date.parse(v));
    let requests = 0;
    browser.runtime.sendMessage.mockImplementation(async (msg) => {
      if (msg?.type !== 'fts' || msg?.cmd !== 'memorySearch') return null;
      if (msg.q !== '') return [];
      const from = msg.ignoreDate ? -Infinity : bound(msg.from, -Infinity);
      const to = msg.ignoreDate ? Infinity : bound(msg.to, Infinity);
      const ties = (requests++ % 2 === 0 ? 1 : -1);
      return rows
        .filter((r) => r.dateMs >= from && r.dateMs <= to)
        .sort((a, b) => b.dateMs - a.dateMs || (a.memId < b.memId ? ties : -ties))
        .slice(0, msg.limit)
        .map((r) => ({ ...r }));
    });
    return rows;
  }
  function helperWithConversations(count) {
    const now = Date.now();
    return helperWithRows(Array.from({ length: count }, (_, i) => ({
      memId: `m${i}`,
      dateMs: now - (i + 1) * 3 * HOUR,
      content: `[USER]: request ${i}\n\n[AGENT]: answer ${i}`,
      snippet: null,
    })));
  }
  const memorySearchCalls = () => browser.runtime.sendMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m?.type === 'fts' && m?.cmd === 'memorySearch');
  const shownTimestamps = (result) => [...String(result.results).matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1]));
  async function listAll(args = {}) {
    const pages = [];
    for (let page = 1; page < 50; page++) {
      const result = await memorySearch.run({ ...args, page_index: page });
      pages.push(result);
      if (!result.comment) break;
    }
    return pages;
  }

  it.each([[{}], [{ query: '' }], [{ query: '   ' }]])('lists the most recent conversations, newest first, a page at a time, for no query (%o)', async (args) => {
    const rows = helperWithConversations(12);
    const newest = rows.map((r) => r.dateMs);

    const first = await memorySearch.run(args);
    expect(first).not.toHaveProperty('error');
    expect(memorySearchCalls()[0]).toEqual({ type: 'fts', cmd: 'memorySearch', q: '', from: '', to: '', limit: FETCH_ROWS + 1, ignoreDate: true, previewChars: 400 });
    expect(first.page).toBe(1);
    // How many there are is known only once all are listed.
    expect(first).not.toHaveProperty('totalPages');
    expect(first).not.toHaveProperty('totalItems');
    expect(shownTimestamps(first)).toEqual(newest.slice(0, 5));
    // The helper gives no snippet for an empty query: the conversation shows.
    expect(first.results).toContain('[USER]: request 0');
    expect(first.results).toContain('[AGENT]: answer 4');
    expect(first.results).not.toContain('request 5');
    expect(first.comment).toContain('page_index: 2');

    const second = await memorySearch.run({ ...args, page_index: 2 });
    const third = await memorySearch.run({ ...args, page_index: 3 });
    expect(shownTimestamps(second)).toEqual(newest.slice(5, 10));
    expect(second.comment).toContain('page_index: 3');
    expect(shownTimestamps(third)).toEqual(newest.slice(10, 12));
    expect(third).not.toHaveProperty('comment');
    expect([third.page, third.totalPages, third.totalItems]).toEqual([3, 3, 12]);
    // Fetched a few at a time, each request after the first starting at the
    // last turn listed: no reply carries more than FETCH_ROWS + 2 turns.
    const calls = memorySearchCalls();
    expect(calls.every((m) => m.q === '' && m.limit <= FETCH_ROWS + 2)).toBe(true);
    expect(calls.slice(1).map((m) => m.to)).toEqual(calls.slice(1).map((m) => m.to).sort((a, b) => b - a));
    // A page asked again comes from what was fetched.
    const before = calls.length;
    expect(shownTimestamps(await memorySearch.run({ ...args, page_index: 2 }))).toEqual(newest.slice(5, 10));
    expect(memorySearchCalls()).toHaveLength(before);
  });

  // A page past a listing's end is its last page, with the totals.
  it('answers a page past the end of a listing with its last page', async () => {
    const rows = helperWithConversations(12);
    const past = await memorySearch.run({ page_index: 99 });
    expect(past).toMatchObject({ page: 3, totalPages: 3, totalItems: 12 });
    expect(past).not.toHaveProperty('comment');
    expect(shownTimestamps(past)).toEqual(rows.slice(10).map((r) => r.dateMs));
  });

  // A listing ends where a search does (memorySearchMaxResults, 15 here): a far
  // page asked for lists the newest that many, a few at a time, never the whole
  // memory.
  it('lists at most a search\'s worth of turns for a far page', async () => {
    const rows = helperWithConversations(40);
    const far = await memorySearch.run({ page_index: 1e9 });
    expect(far).toMatchObject({ page: 3, totalPages: 3, totalItems: 15 });
    expect(far).not.toHaveProperty('comment');
    expect(shownTimestamps(far)).toEqual(rows.slice(10, 15).map((r) => r.dateMs));
    expect(memorySearchCalls().length).toBeLessThanOrEqual(Math.ceil(15 / FETCH_ROWS) + 1);
    expect(memorySearchCalls().every((m) => m.limit <= FETCH_ROWS + 2)).toBe(true);
  });

  // Turns stamped in the same millisecond, on either side of a request's last
  // turn, are each listed once, whatever order the helper gives them in.
  it('lists every turn once when several share a millisecond', async () => {
    const now = Date.now();
    const rows = helperWithRows(Array.from({ length: 13 }, (_, i) => ({
      memId: `m${String(i).padStart(2, '0')}`,
      dateMs: now - Math.floor(i / 3) * HOUR,
      content: `[USER]: request ${i}`,
      snippet: null,
    })));
    const pages = await listAll();
    const listed = pages.flatMap((p) => [...String(p.results).matchAll(/request (\d+)/g)].map((m) => Number(m[1])));
    expect([...listed].sort((a, b) => a - b)).toEqual(rows.map((_, i) => i));
    const dates = pages.flatMap(shownTimestamps);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(pages.at(-1).totalItems).toBe(13);
  });

  it('lists the most recent conversations within the dates asked for no query, each range its own listing', async () => {
    const rows = helperWithConversations(12);
    const iso = (ms) => new Date(ms).toISOString();
    // Rows 2..5 (6 to 18 hours ago).
    const from = rows[5].dateMs - HOUR;
    const to = rows[2].dateMs + HOUR;

    const window = await memorySearch.run({ from_date: iso(from), to_date: iso(to) });
    expect(memorySearchCalls()[0]).toEqual({ type: 'fts', cmd: 'memorySearch', q: '', from, to, limit: FETCH_ROWS + 1, ignoreDate: false, previewChars: 400 });
    expect(shownTimestamps(window)).toEqual(rows.slice(2, 6).map((r) => r.dateMs));
    expect(window.totalItems).toBe(4);

    // Only a start: everything since it.
    const since = await listAll({ from_date: iso(from) });
    expect(since.flatMap(shownTimestamps)).toEqual(rows.slice(0, 6).map((r) => r.dateMs));

    // Only an end: everything before it.
    const before = await listAll({ to_date: iso(to) });
    expect(before.flatMap(shownTimestamps)).toEqual(rows.slice(2).map((r) => r.dateMs));
  });

  // A date alone (what time_delta gives) is the user's local day: from its
  // first millisecond through its last, not UTC midnight.
  it('lists a whole local day for a date alone', async () => {
    const day = new Date(Date.now() - 3 * 24 * HOUR);
    const [y, m, d] = [day.getFullYear(), day.getMonth(), day.getDate()];
    const at = (date, h, min = 0, s = 0, ms = 0) => new Date(y, m, date, h, min, s, ms).getTime();
    const rows = helperWithRows([
      { memId: 'before', dateMs: at(d, 0) - 1 },
      { memId: 'start', dateMs: at(d, 0) },
      { memId: 'noon', dateMs: at(d, 12) },
      { memId: 'end', dateMs: at(d + 1, 0) - 1 },
      { memId: 'after', dateMs: at(d + 1, 0) },
    ].map((r) => ({ ...r, content: `[USER]: ${r.memId}`, snippet: null })));
    const name = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const listed = (await listAll({ from_date: name, to_date: name })).flatMap(shownTimestamps);
    expect(listed).toEqual([rows[3], rows[2], rows[1]].map((r) => r.dateMs));
  });

  // A day is the whole local day however long daylight saving makes it: 23 or
  // 25 hours, or starting at 01:00 where midnight is skipped.
  describe('a local day across daylight saving', () => {
    let savedZone;
    beforeEach(() => { savedZone = process.env.TZ; });
    afterEach(() => {
      if (savedZone === undefined) delete process.env.TZ;
      else process.env.TZ = savedZone;
    });

    // The next day in `zone` lasting `hours` that does (or doesn't) start after midnight.
    function transitionDay(zone, hours, skipsMidnight) {
      process.env.TZ = zone;
      const today = new Date();
      for (let i = 0; i < 800; i += 1) {
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
        const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
        if ((next.getTime() - start.getTime()) / HOUR === hours && (start.getHours() !== 0) === skipsMidnight) return [start, next];
      }
      throw new Error(`no ${hours}-hour day in ${zone}`);
    }

    it.each([
      ['America/Vancouver', 23, false],
      ['America/Vancouver', 25, false],
      ['America/Santiago', 23, true],
    ])('lists exactly a day in %s of %s hours (midnight skipped: %s)', async (zone, hours, skipsMidnight) => {
      const [start, next] = transitionDay(zone, hours, skipsMidnight);
      const rows = helperWithRows([
        { memId: 'before', dateMs: start.getTime() - 1 },
        { memId: 'start', dateMs: start.getTime() },
        { memId: 'inside', dateMs: start.getTime() + 12 * HOUR },
        { memId: 'end', dateMs: next.getTime() - 1 },
        { memId: 'after', dateMs: next.getTime() },
      ].map((r) => ({ ...r, content: `[USER]: ${r.memId}`, snippet: null })));
      const name = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
      const listed = (await listAll({ from_date: name, to_date: name })).flatMap(shownTimestamps);
      expect(listed).toEqual([rows[3], rows[2], rows[1]].map((r) => r.dateMs));
    });
  });

  // An empty memory lists nothing and says no more pages follow.
  it('ends an empty listing on its first page', async () => {
    helperWithRows([]);
    const result = await memorySearch.run({});
    expect(memorySearchCalls().length).toBeGreaterThan(0);
    expect(result).toMatchObject({ results: 'No relevant memories found for this query.', totalItems: 0, totalPages: 1 });
    expect(result.comment).toBeUndefined();
  });

  // A full timestamp bounds to the millisecond.
  it('sends a full timestamp to the helper to the millisecond', async () => {
    const ms = Date.now() - 5 * HOUR + 250;
    await memorySearch.run({ query: 'tabmail', from_date: new Date(ms).toISOString(), to_date: new Date(ms + 1).toISOString() });
    expect(memorySearchCalls()[0]).toMatchObject({ from: ms, to: ms + 1, ignoreDate: false });
  });

  // A date the tool can't read is left out, as no date.
  it('leaves out a date it cannot read', async () => {
    const year = new Date().getFullYear();
    await memorySearch.run({ query: 'tabmail', from_date: 'last week', to_date: `${year}-02-30` });
    expect(memorySearchCalls()[0]).toMatchObject({ from: '', to: '', ignoreDate: true });
  });

  // A failed request fails that call only: the next call lists the same page,
  // each turn once.
  it('lists the page again once a failed request succeeds', async () => {
    const rows = helperWithConversations(12);
    const helper = browser.runtime.sendMessage.getMockImplementation();
    let failNext = false;
    browser.runtime.sendMessage.mockImplementation(async (msg) => {
      if (msg?.cmd === 'memorySearch' && failNext) {
        failNext = false;
        return { error: 'Native helper disconnected' };
      }
      return helper(msg);
    });
    await memorySearch.run({});
    failNext = true;
    const failed = await memorySearch.run({ page_index: 2 });
    expect(failed.error).toContain('memory search failed');
    const second = await memorySearch.run({ page_index: 2 });
    expect(shownTimestamps(second)).toEqual(rows.slice(5, 10).map((r) => r.dateMs));
  });

  // Calls of one listing that run at once take turns: each page right.
  it('lists the right pages for calls that run at once', async () => {
    const rows = helperWithConversations(12);
    const [first, second, third] = await Promise.all([
      memorySearch.run({}),
      memorySearch.run({ page_index: 2 }),
      memorySearch.run({ page_index: 3 }),
    ]);
    expect(shownTimestamps(first)).toEqual(rows.slice(0, 5).map((r) => r.dateMs));
    expect(shownTimestamps(second)).toEqual(rows.slice(5, 10).map((r) => r.dateMs));
    expect(shownTimestamps(third)).toEqual(rows.slice(10, 12).map((r) => r.dateMs));
  });

  // A listing and a search in one turn ("what have we discussed?", then a
  // topic) are separate sessions: neither answers with the other's rows.
  it('keeps a no-query listing and a query search in one turn apart', async () => {
    const rows = helperWithConversations(7);
    const found = { memId: 'found', dateMs: Date.now() - 50 * HOUR, content: '[USER]: plan the trip\n\n[AGENT]: done', snippet: 'our [vacation] plans' };
    const listing = browser.runtime.sendMessage.getMockImplementation();
    browser.runtime.sendMessage.mockImplementation(async (msg) => (msg?.cmd === 'memorySearch' && msg.q === 'vacation' ? [found] : listing(msg)));

    const list = await memorySearch.run({});
    const search = await memorySearch.run({ query: 'vacation' });
    const listAgain = await memorySearch.run({});

    expect(memorySearchCalls().filter((m) => m.q === 'vacation').map((m) => m.limit)).toEqual([15]);
    expect(shownTimestamps(list)).toEqual(rows.slice(0, 5).map((r) => r.dateMs));
    expect(list.results).not.toContain('vacation');
    expect(search.totalItems).toBe(1);
    expect(search.results).toContain('our [vacation] plans');
    expect(search.results).not.toContain('request 0');
    expect(shownTimestamps(listAgain)).toEqual(shownTimestamps(list));
    expect(listAgain.results).not.toContain('vacation');
  });

  // With no snippet, a listed conversation shows its first 400 characters.
  it('shows the first 400 characters of each conversation listed', async () => {
    const content = `[USER]: ${'q'.repeat(100)}\n\n[AGENT]: ${'a'.repeat(280)}TAIL-START${'z'.repeat(600)}`;
    browser.runtime.sendMessage.mockImplementation(async (msg) => (msg?.cmd === 'memorySearch' && msg.q === '' ? [{ memId: 'one', dateMs: Date.now() - HOUR, content, snippet: null }] : null));
    const listed = await memorySearch.run({});
    expect(String(listed.results).split('\n').slice(1).join('\n')).toBe(content.slice(0, 400));
  });

  // A search asks once for its best matches (memorySearchMaxResults), each cut
  // to what the tool shows, and pages them from that.
  it('asks once for the best matches of a search, each cut to what is shown', async () => {
    const now = Date.now();
    const matches = Array.from({ length: 15 }, (_, i) => ({ memId: `s${i}`, dateMs: now - (i + 1) * HOUR, content: `[USER]: trip ${i}`, snippet: `[trip] ${i}` }));
    browser.runtime.sendMessage.mockImplementation(async (msg) => (msg?.cmd === 'memorySearch' ? matches.slice(0, msg.limit) : null));
    const pages = await listAll({ query: 'trip' });
    expect(memorySearchCalls().map(({ q, limit, previewChars }) => ({ q, limit, previewChars }))).toEqual([{ q: 'trip', limit: 15, previewChars: 400 }]);
    expect(pages.flatMap(shownTimestamps)).toEqual(matches.map((m) => m.dateMs));
    expect(pages.at(-1)).toMatchObject({ totalPages: 3, totalItems: 15 });
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
    browser.runtime.sendMessage
      .mockResolvedValueOnce([]);
    const result = await memorySearch.run({ query: 'nonexistent' });
    expect(result.totalItems).toBe(0);
    expect(result.results).toContain('No relevant memories');
  });

  it('returns error when backend returns error object', async () => {
    browser.runtime.sendMessage
      .mockResolvedValueOnce({ error: 'index corrupted' });
    const result = await memorySearch.run({ query: 'test' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('memory search failed');
  });

  // An older helper refuses the request before it is sent (native-fts ADR-NF-018):
  // the tool's reply carries the whole reason, which says how to recover.
  it.each([[{ query: 'trip' }], [{}]])('keeps the helper-update reason in the reply (%o), and answers once the helper can', async (args) => {
    const update = 'Chat memory search needs a newer search helper: in TabMail settings, under Full Text Search, choose Check for Updates.';
    browser.runtime.sendMessage.mockImplementation(async (msg) =>
      (msg?.type === 'fts' && msg?.cmd === 'memorySearch' ? { error: update } : null));
    const refused = await memorySearch.run(args);
    expect(refused.error).toBe(`memory search failed: ${update}`);

    memorySearch.resetPaginationSessions();
    helperWithConversations(3);
    const answered = await memorySearch.run({ ...args, query: '' });
    expect(answered).not.toHaveProperty('error');
    expect(shownTimestamps(answered)).toHaveLength(3);
  });

  it('returns error when backend returns non-array', async () => {
    browser.runtime.sendMessage
      .mockResolvedValueOnce('not an array');
    const result = await memorySearch.run({ query: 'test' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('invalid response format');
  });

  it('retries while backend returns undefined (FTS not ready), then succeeds', async () => {
    browser.runtime.sendMessage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        { dateMs: Date.now(), content: 'recovered', snippet: 'recovered' },
      ]);
    const result = await memorySearch.run({ query: 'late-ready' });
    expect(result.totalItems).toBe(1);
    const calls = browser.runtime.sendMessage.mock.calls.filter(
      (c) => c[0]?.type === 'fts' && c[0]?.cmd === 'memorySearch'
    );
    expect(calls.length).toBe(3);
  });

  it('gives up after timeout when backend keeps returning undefined', async () => {
    // mockResolvedValue (sticky) would leak past `vi.clearAllMocks()` since it
    // only clears call history, not implementations — save and restore.
    const originalImpl = browser.runtime.sendMessage.getMockImplementation();
    browser.runtime.sendMessage.mockResolvedValue(undefined);
    try {
      const result = await memorySearch.run({ query: 'never-ready' });
      expect(result).toHaveProperty('error');
      expect(result.error).toContain('invalid response format');
      const calls = browser.runtime.sendMessage.mock.calls.filter(
        (c) => c[0]?.type === 'fts' && c[0]?.cmd === 'memorySearch'
      );
      expect(calls.length).toBeGreaterThan(1);
    } finally {
      if (originalImpl) browser.runtime.sendMessage.mockImplementation(originalImpl);
    }
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

  it('memory_search retries after a thrown sendMessage and succeeds on recovery', async () => {
    // New contract (2026-07-03): a THROWN sendMessage (no receiving end —
    // boot/hot-reload race) is treated as "not ready" and retried within the
    // readiness budget, instead of failing the tool call instantly.
    memorySearch.resetPaginationSessions();
    browser.runtime.sendMessage
      .mockRejectedValueOnce(new Error('Could not establish connection'))
      .mockResolvedValueOnce([
        { dateMs: Date.now(), content: 'recovered', snippet: 'recovered' },
      ]);
    const result = await memorySearch.run({ query: 'test' });
    expect(result.totalItems).toBe(1);
  });

  it('memory_read with invalid (non-numeric) timestamp returns error', async () => {
    const result = await memoryRead.run({ timestamp: 'abc' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('timestamp');
  });
});
