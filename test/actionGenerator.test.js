// actionGenerator.test.js — Tests for agent/modules/actionGenerator.js
//
// Tests the action tag generation logic: getAction (LLM-based action voting),
// purgeExpiredActionEntries (cache TTL), and internal helpers (semaphores,
// write-once records).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock stores — maintain state across calls within each test
// ---------------------------------------------------------------------------

let idbStore = {};

const mockIdbGet = vi.fn(async (keys) => {
  if (typeof keys === 'string') keys = [keys];
  const result = {};
  for (const k of keys) {
    if (idbStore[k] !== undefined) result[k] = idbStore[k];
  }
  return result;
});

const mockIdbSet = vi.fn(async (obj) => {
  Object.assign(idbStore, obj);
});

const mockIdbRemove = vi.fn(async (keys) => {
  for (const k of keys) delete idbStore[k];
});

const mockIdbGetAllKeys = vi.fn(async () => Object.keys(idbStore));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
    actionTTLSeconds: 604800,
    actionGenerationParallelCalls: 3,
  },
}));

vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));

vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

vi.mock('../agent/modules/idbStorage.js', () => ({
  get: (...args) => mockIdbGet(...args),
  set: (...args) => mockIdbSet(...args),
  remove: (...args) => mockIdbRemove(...args),
  getAllKeys: (...args) => mockIdbGetAllKeys(...args),
}));

const mockIsInternalSender = vi.fn().mockResolvedValue(false);
vi.mock('../agent/modules/senderFilter.js', () => ({
  isInternalSender: (...args) => mockIsInternalSender(...args),
}));

const mockGetUniqueMessageKey = vi.fn().mockResolvedValue('test-unique-key');
const mockExtractBodyFromParts = vi.fn().mockResolvedValue('<p>Hello world</p>');
const mockStripHtml = vi.fn((html) => html.replace(/<[^>]+>/g, ''));
const mockSafeGetFull = vi.fn().mockResolvedValue({ parts: [] });
const mockSaveChatLog = vi.fn();

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getUniqueMessageKey: (...args) => mockGetUniqueMessageKey(...args),
  extractBodyFromParts: (...args) => mockExtractBodyFromParts(...args),
  stripHtml: (...args) => mockStripHtml(...args),
  safeGetFull: (...args) => mockSafeGetFull(...args),
  saveChatLog: (...args) => mockSaveChatLog(...args),
  getRealSubject: vi.fn(async (header) => header?.subject || ""),
}));

const mockGetUserName = vi.fn().mockResolvedValue('Test User');
vi.mock('../chat/modules/helpers.js', () => ({
  getUserName: (...args) => mockGetUserName(...args),
}));

const mockGetUserActionPrompt = vi.fn().mockResolvedValue('');
vi.mock('../agent/modules/promptGenerator.js', () => ({
  getUserActionPrompt: (...args) => mockGetUserActionPrompt(...args),
}));

const mockGetSummary = vi.fn().mockResolvedValue({ blurb: 'Test summary', todos: '' });
vi.mock('../agent/modules/summaryGenerator.js', () => ({
  getSummary: (...args) => mockGetSummary(...args),
}));

const mockAnalyzeEmailForReplyFilter = vi.fn().mockResolvedValue({
  isNoReply: false,
  hasUnsubscribe: false,
});
vi.mock('../agent/modules/messagePrefilter.js', () => ({
  analyzeEmailForReplyFilter: (...args) => mockAnalyzeEmailForReplyFilter(...args),
}));

const mockActionFromLiveTagIds = vi.fn().mockReturnValue(null);
const mockIsMessageInInboxByUniqueKey = vi.fn().mockResolvedValue(true);
vi.mock('../agent/modules/tagHelper.js', () => ({
  actionFromLiveTagIds: (...args) => mockActionFromLiveTagIds(...args),
  isMessageInInboxByUniqueKey: (...args) => mockIsMessageInInboxByUniqueKey(...args),
}));

const mockResolveGmailAction = vi.fn().mockResolvedValue(null);
vi.mock('../agent/modules/gmailLabelSync.js', () => ({
  resolveGmailAction: (...args) => mockResolveGmailAction(...args),
}));

const mockSendChat = vi.fn();
const mockProcessJSONResponse = vi.fn();
vi.mock('../agent/modules/llm.js', () => ({
  sendChat: (...args) => mockSendChat(...args),
  processJSONResponse: (...args) => mockProcessJSONResponse(...args),
}));

vi.mock('../agent/modules/deviceSync.js', () => ({
  probeAICache: vi.fn().mockResolvedValue(null),
}));

// Browser mock
globalThis.browser = {
  messages: {
    get: vi.fn().mockResolvedValue({ tags: [] }),
  },
  tmHdr: {
    getFlags: vi.fn().mockResolvedValue({ exists: false }),
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
  },
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { getAction, purgeExpiredActionEntries } = await import('../agent/modules/actionGenerator.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeader(id = 1, overrides = {}) {
  return {
    id,
    subject: 'Test Subject',
    author: 'sender@example.com',
    headerMessageId: '<test@example.com>',
    folder: { id: 'folder1', path: '/INBOX', name: 'Inbox', type: 'inbox' },
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  idbStore = {};

  // Re-apply defaults after clearAllMocks
  mockIsInternalSender.mockResolvedValue(false);
  mockGetUniqueMessageKey.mockResolvedValue('test-unique-key');
  mockExtractBodyFromParts.mockResolvedValue('<p>Hello world</p>');
  mockStripHtml.mockImplementation((html) => html.replace(/<[^>]+>/g, ''));
  mockSafeGetFull.mockResolvedValue({ parts: [] });
  mockGetUserName.mockResolvedValue('Test User');
  mockGetUserActionPrompt.mockResolvedValue('');
  mockGetSummary.mockResolvedValue({ blurb: 'Test summary', todos: '' });
  mockAnalyzeEmailForReplyFilter.mockResolvedValue({ isNoReply: false, hasUnsubscribe: false });
  mockActionFromLiveTagIds.mockReturnValue(null);
  mockResolveGmailAction.mockResolvedValue(null);
  mockIsMessageInInboxByUniqueKey.mockResolvedValue(true);
  browser.messages.get.mockResolvedValue({ tags: [] });
});

// ═══════════════════════════════════════════════════════════════════════════
// getAction — core action generation
// ═══════════════════════════════════════════════════════════════════════════

describe('getAction', () => {
  // ── Internal/self-sent skip ──────────────────────────────────────────

  it('returns null for internal/self-sent messages', async () => {
    mockIsInternalSender.mockResolvedValue(true);
    const result = await getAction(makeHeader());
    expect(result).toBeNull();
    expect(mockSendChat).not.toHaveBeenCalled();
  });

  // ── Cache behavior ───────────────────────────────────────────────────

  it('returns cached action on cache HIT (no LLM call)', async () => {
    idbStore['action:test-unique-key'] = 'archive';
    idbStore['action:ts:test-unique-key'] = { ts: Date.now() };

    const result = await getAction(makeHeader());
    expect(result).toBe('archive');
    expect(mockSendChat).not.toHaveBeenCalled();
  });

  it('touches cache timestamp on cache HIT', async () => {
    const oldTs = Date.now() - 100000;
    idbStore['action:test-unique-key'] = 'reply';
    idbStore['action:ts:test-unique-key'] = { ts: oldTs };

    await getAction(makeHeader());
    // Timestamp should be updated (touched)
    const updatedTs = idbStore['action:ts:test-unique-key']?.ts;
    expect(updatedTs).toBeGreaterThan(oldTs);
  });

  it('skips cache when forceRecompute is true', async () => {
    idbStore['action:test-unique-key'] = 'archive';
    idbStore['action:ts:test-unique-key'] = { ts: Date.now() };

    // Set up LLM response for the forced recompute
    mockSendChat.mockResolvedValue({ assistant: '{"action": "reply"}' });
    mockProcessJSONResponse.mockReturnValue({ action: 'reply' });

    const result = await getAction(makeHeader(), { forceRecompute: true });
    expect(result).toBe('reply');
    expect(mockSendChat).toHaveBeenCalled();
  });

  // ── Cache-IMAP mismatch detection ────────────────────────────────────

  it('adopts remote IMAP tag when it differs from cache', async () => {
    idbStore['action:test-unique-key'] = 'archive';
    idbStore['action:ts:test-unique-key'] = { ts: Date.now() };

    // Remote tag says "reply" but cache says "archive"
    browser.messages.get.mockResolvedValue({ tags: ['tm_reply'] });
    mockActionFromLiveTagIds.mockReturnValue('reply');
    mockResolveGmailAction.mockResolvedValue('reply');

    const result = await getAction(makeHeader());
    expect(result).toBe('reply');
    // Cache should be updated
    expect(idbStore['action:test-unique-key']).toBe('reply');
  });

  it('returns cached action when IMAP tag matches cache', async () => {
    idbStore['action:test-unique-key'] = 'archive';
    idbStore['action:ts:test-unique-key'] = { ts: Date.now() };

    browser.messages.get.mockResolvedValue({ tags: ['tm_archive'] });
    mockActionFromLiveTagIds.mockReturnValue('archive');
    mockResolveGmailAction.mockResolvedValue('archive');

    const result = await getAction(makeHeader());
    expect(result).toBe('archive');
  });

  // ── IMAP "first compute wins" ────────────────────────────────────────

  it('adopts IMAP tag without LLM call when no cache exists', async () => {
    // No cache, but IMAP already has a tag from another instance
    browser.messages.get.mockResolvedValue({ tags: ['tm_delete'] });
    mockActionFromLiveTagIds.mockReturnValue('delete');
    mockResolveGmailAction.mockResolvedValue('delete');

    const result = await getAction(makeHeader());
    expect(result).toBe('delete');
    expect(mockSendChat).not.toHaveBeenCalled();
    // Should be cached
    expect(idbStore['action:test-unique-key']).toBe('delete');
  });

  // ── LLM voting logic (parallel calls + mode selection) ───────────────

  it('selects majority action from parallel LLM calls', async () => {
    mockSendChat
      .mockResolvedValueOnce({ assistant: '{"action": "reply"}' })
      .mockResolvedValueOnce({ assistant: '{"action": "archive"}' })
      .mockResolvedValueOnce({ assistant: '{"action": "reply"}' });
    mockProcessJSONResponse
      .mockReturnValueOnce({ action: 'reply' })
      .mockReturnValueOnce({ action: 'archive' })
      .mockReturnValueOnce({ action: 'reply' });

    // No IMAP tag on first check (pre-semaphore) or second check (post-semaphore)
    browser.messages.get.mockResolvedValue({ tags: [] });
    mockActionFromLiveTagIds.mockReturnValue(null);
    mockResolveGmailAction.mockResolvedValue(null);

    const result = await getAction(makeHeader());
    expect(result).toBe('reply');
    expect(mockSendChat).toHaveBeenCalledTimes(3);
  });

  it('selects unanimous action when all LLM calls agree', async () => {
    mockSendChat.mockResolvedValue({ assistant: '{"action": "archive"}' });
    mockProcessJSONResponse.mockReturnValue({ action: 'archive' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    const result = await getAction(makeHeader());
    expect(result).toBe('archive');
  });

  it('breaks ties using priority order (lowest priority wins)', async () => {
    // Tie between "reply" and "archive" — archive should win (lower priority)
    mockSendChat
      .mockResolvedValueOnce({ assistant: '{"action": "reply"}' })
      .mockResolvedValueOnce({ assistant: '{"action": "archive"}' })
      .mockResolvedValueOnce({ assistant: '{"action": "none"}' });
    mockProcessJSONResponse
      .mockReturnValueOnce({ action: 'reply' })
      .mockReturnValueOnce({ action: 'archive' })
      .mockReturnValueOnce({ action: 'none' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    const result = await getAction(makeHeader());
    // 3-way tie: delete < archive < none < reply — "archive" is lowest present
    expect(result).toBe('archive');
  });

  it('breaks tie with "delete" as lowest priority when tied', async () => {
    mockSendChat
      .mockResolvedValueOnce({ assistant: '{"action": "delete"}' })
      .mockResolvedValueOnce({ assistant: '{"action": "archive"}' })
      .mockResolvedValueOnce({ assistant: '{"action": "none"}' });
    mockProcessJSONResponse
      .mockReturnValueOnce({ action: 'delete' })
      .mockReturnValueOnce({ action: 'archive' })
      .mockReturnValueOnce({ action: 'none' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    const result = await getAction(makeHeader());
    expect(result).toBe('delete');
  });

  // ── Regex fallback for truncated JSON ────────────────────────────────

  it('extracts action via regex when JSON parsing fails', async () => {
    // Simulate truncated JSON that processJSONResponse can't parse
    const truncatedJson = '{"action": "archive", "justifica';
    mockSendChat.mockResolvedValue({ assistant: truncatedJson });
    mockProcessJSONResponse.mockReturnValue(null); // JSON parse fails
    browser.messages.get.mockResolvedValue({ tags: [] });

    const result = await getAction(makeHeader());
    expect(result).toBe('archive');
  });

  // ── Edge cases: malformed responses ──────────────────────────────────

  it('returns null when all LLM responses are empty', async () => {
    mockSendChat.mockResolvedValue({ assistant: '' });
    mockProcessJSONResponse.mockReturnValue(null);
    browser.messages.get.mockResolvedValue({ tags: [] });

    const result = await getAction(makeHeader());
    expect(result).toBeNull();
  });

  it('returns null when LLM returns null responses', async () => {
    mockSendChat.mockResolvedValue(null);
    browser.messages.get.mockResolvedValue({ tags: [] });

    const result = await getAction(makeHeader());
    expect(result).toBeNull();
  });

  it('returns null when LLM returns responses without action field', async () => {
    mockSendChat.mockResolvedValue({ assistant: '{"confidence": 0.9}' });
    mockProcessJSONResponse.mockReturnValue({ confidence: 0.9 });
    browser.messages.get.mockResolvedValue({ tags: [] });

    const result = await getAction(makeHeader());
    expect(result).toBeNull();
  });

  it('handles mixed valid and invalid LLM responses', async () => {
    mockSendChat
      .mockResolvedValueOnce({ assistant: '{"action": "reply"}' })
      .mockResolvedValueOnce(null)  // invalid
      .mockResolvedValueOnce({ assistant: '{"action": "reply"}' });
    mockProcessJSONResponse
      .mockReturnValueOnce({ action: 'reply' })
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ action: 'reply' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    const result = await getAction(makeHeader());
    expect(result).toBe('reply');
  });

  // ── Action normalization ─────────────────────────────────────────────

  it('normalizes action to lowercase', async () => {
    mockSendChat.mockResolvedValue({ assistant: '{"action": "REPLY"}' });
    mockProcessJSONResponse.mockReturnValue({ action: 'REPLY' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    const result = await getAction(makeHeader());
    expect(result).toBe('reply');
  });

  it('trims whitespace from action strings', async () => {
    mockSendChat.mockResolvedValue({ assistant: '{"action": " archive "}' });
    mockProcessJSONResponse.mockReturnValue({ action: ' archive ' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    const result = await getAction(makeHeader());
    expect(result).toBe('archive');
  });

  // ── Cache write after successful generation ──────────────────────────

  it('caches action and timestamp after successful LLM generation', async () => {
    mockSendChat.mockResolvedValue({ assistant: '{"action": "none"}' });
    mockProcessJSONResponse.mockReturnValue({ action: 'none' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    await getAction(makeHeader());

    expect(idbStore['action:test-unique-key']).toBe('none');
    expect(idbStore['action:ts:test-unique-key']).toBeDefined();
    expect(idbStore['action:ts:test-unique-key'].ts).toBeGreaterThan(0);
  });

  it('records original action once after generation', async () => {
    mockSendChat.mockResolvedValue({ assistant: '{"action": "delete"}' });
    mockProcessJSONResponse.mockReturnValue({ action: 'delete' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    await getAction(makeHeader());

    expect(idbStore['action:orig:test-unique-key']).toBe('delete');
  });

  it('records user action prompt when present', async () => {
    mockGetUserActionPrompt.mockResolvedValue('Always archive newsletters');
    mockSendChat.mockResolvedValue({ assistant: '{"action": "archive"}' });
    mockProcessJSONResponse.mockReturnValue({ action: 'archive' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    await getAction(makeHeader());

    expect(idbStore['action:userprompt:test-unique-key']).toBe('Always archive newsletters');
  });

  it('does not record user prompt when empty', async () => {
    mockGetUserActionPrompt.mockResolvedValue('');
    mockSendChat.mockResolvedValue({ assistant: '{"action": "archive"}' });
    mockProcessJSONResponse.mockReturnValue({ action: 'archive' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    await getAction(makeHeader());

    expect(idbStore['action:userprompt:test-unique-key']).toBeUndefined();
  });

  // ── Saves chat log ───────────────────────────────────────────────────

  it('saves chat log after successful generation', async () => {
    mockSendChat.mockResolvedValue({ assistant: '{"action": "reply"}' });
    mockProcessJSONResponse.mockReturnValue({ action: 'reply' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    await getAction(makeHeader());

    expect(mockSaveChatLog).toHaveBeenCalledWith(
      'tabmail_action',
      'test-unique-key',
      expect.any(Array),
      expect.any(String),
    );
  });

  // ── System message construction ──────────────────────────────────────

  it('passes correct system message to LLM with all fields', async () => {
    mockGetUserActionPrompt.mockResolvedValue('Archive spam');
    mockGetSummary.mockResolvedValue({ blurb: 'A meeting invite', todos: 'RSVP' });
    mockAnalyzeEmailForReplyFilter.mockResolvedValue({ isNoReply: true, hasUnsubscribe: true });
    mockSendChat.mockResolvedValue({ assistant: '{"action": "delete"}' });
    mockProcessJSONResponse.mockReturnValue({ action: 'delete' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    const header = makeHeader(1, { subject: 'Meeting', author: 'boss@corp.com' });
    await getAction(header);

    // Verify the system message sent to sendChat
    const call = mockSendChat.mock.calls[0];
    const messages = call[0];
    expect(messages).toHaveLength(1);
    const sysMsg = messages[0];
    expect(sysMsg.role).toBe('system');
    expect(sysMsg.content).toBe('system_prompt_action');
    expect(sysMsg.user_name).toBe('Test User');
    expect(sysMsg.user_action_prompt).toBe('Archive spam');
    expect(sysMsg.subject).toBe('Meeting');
    expect(sysMsg.from_sender).toBe('boss@corp.com');
    expect(sysMsg.todo).toBe('RSVP');
    expect(sysMsg.summary).toBe('A meeting invite');
    expect(sysMsg.is_noreply_address).toBe(true);
    expect(sysMsg.has_unsubscribe_link).toBe(true);
  });

  it('uses "Not Available" for missing subject and summary', async () => {
    mockGetSummary.mockResolvedValue(null);
    mockSendChat.mockResolvedValue({ assistant: '{"action": "none"}' });
    mockProcessJSONResponse.mockReturnValue({ action: 'none' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    const header = makeHeader(1, { subject: '', author: '' });
    await getAction(header);

    const sysMsg = mockSendChat.mock.calls[0][0][0];
    expect(sysMsg.subject).toBe('Not Available');
    expect(sysMsg.from_sender).toBe('Unknown');
    expect(sysMsg.todo).toBe('Not Available');
    expect(sysMsg.summary).toBe('Not Available');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// purgeExpiredActionEntries — cache TTL and inbox eviction
// ═══════════════════════════════════════════════════════════════════════════

describe('purgeExpiredActionEntries', () => {
  it('removes entries older than TTL', async () => {
    const oldTs = Date.now() - (604800 + 1) * 1000; // TTL + 1 second
    idbStore['action:ts:old-msg'] = { ts: oldTs };
    idbStore['action:old-msg'] = 'archive';

    await purgeExpiredActionEntries();

    expect(idbStore['action:old-msg']).toBeUndefined();
    expect(idbStore['action:ts:old-msg']).toBeUndefined();
  });

  it('keeps entries within TTL that are still in inbox', async () => {
    const freshTs = Date.now() - 1000; // 1 second ago
    idbStore['action:ts:fresh-msg'] = { ts: freshTs };
    idbStore['action:fresh-msg'] = 'reply';
    mockIsMessageInInboxByUniqueKey.mockResolvedValue(true);

    await purgeExpiredActionEntries();

    expect(idbStore['action:fresh-msg']).toBe('reply');
  });

  it('evicts entries within TTL but no longer in inbox', async () => {
    const freshTs = Date.now() - 1000; // 1 second ago
    idbStore['action:ts:moved-msg'] = { ts: freshTs };
    idbStore['action:moved-msg'] = 'archive';
    mockIsMessageInInboxByUniqueKey.mockResolvedValue(false);

    await purgeExpiredActionEntries();

    expect(idbStore['action:moved-msg']).toBeUndefined();
    expect(idbStore['action:ts:moved-msg']).toBeUndefined();
  });

  it('removes orphaned payload keys without timestamp entries', async () => {
    // Payload exists but no corresponding timestamp
    idbStore['action:orphan-msg'] = 'delete';

    await purgeExpiredActionEntries();

    expect(idbStore['action:orphan-msg']).toBeUndefined();
  });

  it('does not remove write-once metadata keys (orig, userprompt, justification)', async () => {
    idbStore['action:orig:some-msg'] = 'reply';
    idbStore['action:userprompt:some-msg'] = 'my prompt';
    idbStore['action:justification:some-msg'] = 'because...';

    await purgeExpiredActionEntries();

    expect(idbStore['action:orig:some-msg']).toBe('reply');
    expect(idbStore['action:userprompt:some-msg']).toBe('my prompt');
    expect(idbStore['action:justification:some-msg']).toBe('because...');
  });

  it('handles empty store gracefully', async () => {
    await purgeExpiredActionEntries();
    // No errors thrown, no removals
    expect(mockIdbRemove).not.toHaveBeenCalled();
  });

  it('handles entries with missing/null timestamp as expired', async () => {
    idbStore['action:ts:bad-ts'] = { ts: null };
    idbStore['action:bad-ts'] = 'none';

    await purgeExpiredActionEntries();

    expect(idbStore['action:bad-ts']).toBeUndefined();
  });

  it('handles entries with non-numeric timestamp as expired', async () => {
    idbStore['action:ts:str-ts'] = { ts: 'not-a-number' };
    idbStore['action:str-ts'] = 'reply';

    await purgeExpiredActionEntries();

    expect(idbStore['action:str-ts']).toBeUndefined();
  });

  it('purges multiple expired entries in one call', async () => {
    const oldTs = Date.now() - (604800 + 1) * 1000;
    idbStore['action:ts:msg-a'] = { ts: oldTs };
    idbStore['action:msg-a'] = 'archive';
    idbStore['action:ts:msg-b'] = { ts: oldTs };
    idbStore['action:msg-b'] = 'delete';

    await purgeExpiredActionEntries();

    expect(idbStore['action:msg-a']).toBeUndefined();
    expect(idbStore['action:msg-b']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Semaphore behavior — prevents duplicate LLM calls for same message
// ═══════════════════════════════════════════════════════════════════════════

describe('getAction semaphore', () => {
  it('second concurrent call for same message gets cached result from first', async () => {
    let resolveFirst;
    const firstCallPromise = new Promise((r) => { resolveFirst = r; });

    mockSendChat.mockImplementationOnce(async () => {
      await firstCallPromise;
      return { assistant: '{"action": "reply"}' };
    });
    mockProcessJSONResponse.mockReturnValue({ action: 'reply' });
    browser.messages.get.mockResolvedValue({ tags: [] });

    // Start both calls concurrently
    const call1 = getAction(makeHeader());

    // For the second call, once the semaphore queues it and the first
    // completes, it should find the cached result
    mockSendChat.mockResolvedValue({ assistant: '{"action": "reply"}' });
    const call2 = getAction(makeHeader());

    // Resolve first call
    resolveFirst();

    const [result1, result2] = await Promise.all([call1, call2]);
    expect(result1).toBe('reply');
    expect(result2).toBe('reply');
  });
});
