// context.test.js — Tests for chat/modules/context.js
//
// Tests for ctx capped array proxy and initFsmSession.

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { ctx, initFsmSession } = await import('../chat/modules/context.js');

// ---------------------------------------------------------------------------
// ctx shape
// ---------------------------------------------------------------------------
describe('ctx shape', () => {
  it('has expected top-level properties', () => {
    expect(ctx).toHaveProperty('chatHistory');
    expect(ctx).toHaveProperty('actionHistory');
    expect(ctx).toHaveProperty('stateHistory');
    expect(ctx).toHaveProperty('state');
    expect(ctx).toHaveProperty('activePid');
    expect(ctx).toHaveProperty('awaitingPid');
    expect(ctx).toHaveProperty('selectedEmailList');
    expect(ctx).toHaveProperty('selectedRecipientList');
    expect(ctx).toHaveProperty('selectedMessageIds');
    expect(ctx).toHaveProperty('greetedUser');
    expect(ctx).toHaveProperty('rawUserTexts');
    expect(ctx).toHaveProperty('pendingSuggestion');
    expect(ctx).toHaveProperty('agentConverseMessages');
    expect(ctx).toHaveProperty('toolExecutionMode');
    expect(ctx).toHaveProperty('activeToolCallId');
    expect(ctx).toHaveProperty('fsmSessions');
    expect(ctx).toHaveProperty('fsmWaiters');
    expect(ctx).toHaveProperty('idTranslation');
    expect(ctx).toHaveProperty('entityMap');
    expect(ctx).toHaveProperty('lastUserMessage');
    expect(ctx).toHaveProperty('canRetry');
    expect(ctx).toHaveProperty('persistedTurns');
    expect(ctx).toHaveProperty('chatMeta');
  });

  it('activePid defaults to 0', () => {
    expect(ctx.activePid).toBe(0);
  });

  it('awaitingPid defaults to 0', () => {
    expect(ctx.awaitingPid).toBe(0);
  });

  it('greetedUser defaults to false', () => {
    expect(ctx.greetedUser).toBe(false);
  });

  it('idTranslation has correct structure', () => {
    expect(ctx.idTranslation).toHaveProperty('idMap');
    expect(ctx.idTranslation).toHaveProperty('nextNumericId');
    expect(ctx.idTranslation).toHaveProperty('lastAccessed');
    expect(ctx.idTranslation).toHaveProperty('freeIds');
    expect(ctx.idTranslation).toHaveProperty('refCounts');
    expect(ctx.idTranslation.idMap).toBeInstanceOf(Map);
    expect(ctx.idTranslation.refCounts).toBeInstanceOf(Map);
  });
});

// ---------------------------------------------------------------------------
// Capped array (rawUserTexts)
// ---------------------------------------------------------------------------
describe('rawUserTexts capped array', () => {
  it('is an array', () => {
    expect(Array.isArray(ctx.rawUserTexts)).toBe(true);
  });

  it('supports push', () => {
    const initialLen = ctx.rawUserTexts.length;
    ctx.rawUserTexts.push('test item');
    expect(ctx.rawUserTexts.length).toBe(initialLen + 1);
    expect(ctx.rawUserTexts[ctx.rawUserTexts.length - 1]).toBe('test item');
  });

  it('caps at MAX_HISTORY (100) entries', () => {
    // Clear existing items
    ctx.rawUserTexts.length = 0;

    // Push 110 items
    for (let i = 0; i < 110; i++) {
      ctx.rawUserTexts.push(`item_${i}`);
    }
    // Should be capped at 100
    expect(ctx.rawUserTexts.length).toBe(100);
    // Oldest items should be removed (shifted from front)
    expect(ctx.rawUserTexts[0]).toBe('item_10');
    expect(ctx.rawUserTexts[99]).toBe('item_109');
  });

  it('supports standard array operations (indexing, length)', () => {
    ctx.rawUserTexts.length = 0;
    ctx.rawUserTexts.push('a');
    ctx.rawUserTexts.push('b');
    expect(ctx.rawUserTexts[0]).toBe('a');
    expect(ctx.rawUserTexts[1]).toBe('b');
    expect(ctx.rawUserTexts.length).toBe(2);
  });

  it('push returns new length', () => {
    ctx.rawUserTexts.length = 0;
    const len = ctx.rawUserTexts.push('x');
    expect(len).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// initFsmSession
// ---------------------------------------------------------------------------
describe('initFsmSession', () => {
  it('returns null for falsy pid', () => {
    expect(initFsmSession(0, 'email_compose')).toBe(null);
    expect(initFsmSession(null, 'email_compose')).toBe(null);
    expect(initFsmSession('', 'email_compose')).toBe(null);
    expect(initFsmSession(undefined, 'email_compose')).toBe(null);
  });

  it('creates session for valid pid', () => {
    const sess = initFsmSession('call_123', 'email_compose');
    expect(sess).not.toBe(null);
    expect(sess.toolName).toBe('email_compose');
    expect(typeof sess.startedAt).toBe('number');
    expect(sess.fsmUserInput).toBe(null);
  });

  it('stores session on ctx.fsmSessions', () => {
    initFsmSession('call_456', 'email_reply');
    expect(ctx.fsmSessions['call_456']).toBeDefined();
    expect(ctx.fsmSessions['call_456'].toolName).toBe('email_reply');
  });

  it('defaults toolName to "tool" when not provided', () => {
    const sess = initFsmSession('call_789');
    expect(sess.toolName).toBe('tool');
  });

  it('captures current ctx.state as fsmPrevState', () => {
    ctx.state = 'some_state';
    const sess = initFsmSession('call_aaa', 'test_tool');
    expect(sess.fsmPrevState).toBe('some_state');
    ctx.state = null;
  });

  it('overwrites existing session for same pid', () => {
    initFsmSession('call_bbb', 'first_tool');
    expect(ctx.fsmSessions['call_bbb'].toolName).toBe('first_tool');

    initFsmSession('call_bbb', 'second_tool');
    expect(ctx.fsmSessions['call_bbb'].toolName).toBe('second_tool');
  });
});
