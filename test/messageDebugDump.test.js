// messageDebugDump.test.js — Tests for pure functions in agent/modules/messageDebugDump.js

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})),
}));

vi.mock('../agent/modules/tagHelper.js', () => ({
  ACTION_TAG_IDS: {
    delete: 'tm_delete',
    archive: 'tm_archive',
    reply: 'tm_reply',
    none: 'tm_none',
  },
}));

vi.mock('../agent/modules/utils.js', () => ({
  getUniqueMessageKey: vi.fn(async () => 'mock-key'),
  log: vi.fn(),
  safeGetFull: vi.fn(async () => null),
}));

globalThis.browser = {
  messages: {
    get: vi.fn(async () => null),
  },
};

const { _testExports } = await import('../agent/modules/messageDebugDump.js');
const { _safeJson, _isMessageNotFoundError, _pickHeaderFields } = _testExports;

// ---------------------------------------------------------------------------
// _safeJson
// ---------------------------------------------------------------------------

describe('_safeJson', () => {
  it('returns a cloned simple object', () => {
    const obj = { a: 1, b: 'hello' };
    const result = _safeJson(obj);
    expect(result).toEqual({ a: 1, b: 'hello' });
    expect(result).not.toBe(obj);
  });

  it('returns a string as-is', () => {
    expect(_safeJson('hello')).toBe('hello');
  });

  it('returns a number as-is', () => {
    expect(_safeJson(42)).toBe(42);
  });

  it('returns null for null input', () => {
    expect(_safeJson(null)).toBeNull();
  });

  it('returns "undefined" string for undefined input', () => {
    // JSON.parse(JSON.stringify(undefined)) throws, so falls back to String(undefined)
    expect(_safeJson(undefined)).toBe('undefined');
  });

  it('returns a string fallback for circular reference', () => {
    const circ = {};
    circ.self = circ;
    const result = _safeJson(circ);
    expect(typeof result).toBe('string');
  });

  it('serializes Date object to ISO string', () => {
    const date = new Date('2025-06-15T12:00:00Z');
    const result = _safeJson(date);
    expect(result).toBe('2025-06-15T12:00:00.000Z');
  });

  it('deep clones a nested object', () => {
    const nested = { a: { b: { c: 3 } } };
    const result = _safeJson(nested);
    expect(result).toEqual({ a: { b: { c: 3 } } });
    expect(result.a).not.toBe(nested.a);
  });
});

// ---------------------------------------------------------------------------
// _isMessageNotFoundError
// ---------------------------------------------------------------------------

describe('_isMessageNotFoundError', () => {
  it('returns true for Error with "message not found"', () => {
    expect(_isMessageNotFoundError(new Error('message not found'))).toBe(true);
  });

  it('returns true for case-insensitive "Message Not Found"', () => {
    expect(_isMessageNotFoundError(new Error('Message Not Found'))).toBe(true);
  });

  it('returns true for string "message not found in folder"', () => {
    expect(_isMessageNotFoundError('message not found in folder')).toBe(true);
  });

  it('returns false for Error with a different message', () => {
    expect(_isMessageNotFoundError(new Error('network timeout'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(_isMessageNotFoundError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(_isMessageNotFoundError(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(_isMessageNotFoundError('')).toBe(false);
  });

  it('returns false for non-string input like a number', () => {
    expect(_isMessageNotFoundError(12345)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _pickHeaderFields
// ---------------------------------------------------------------------------

describe('_pickHeaderFields', () => {
  it('picks the correct subset of fields from a full header', () => {
    const header = {
      id: 42,
      headerMessageId: '<abc@example.com>',
      subject: 'Test Subject',
      author: 'alice@example.com',
      recipients: ['bob@example.com'],
      ccList: ['carol@example.com'],
      bccList: [],
      date: new Date('2025-01-01'),
      read: true,
      flagged: false,
      junk: false,
      tags: ['tm_reply', 'custom_tag'],
      folder: {
        id: 'acct1:/INBOX',
        accountId: 'acct1',
        name: 'Inbox',
        path: '/INBOX',
        type: 'inbox',
        specialUse: ['inbox'],
      },
      extraField: 'should be excluded',
    };

    const result = _pickHeaderFields(header);

    expect(result.id).toBe(42);
    expect(result.headerMessageId).toBe('<abc@example.com>');
    expect(result.subject).toBe('Test Subject');
    expect(result.author).toBe('alice@example.com');
    expect(result.recipients).toEqual(['bob@example.com']);
    expect(result.ccList).toEqual(['carol@example.com']);
    expect(result.bccList).toEqual([]);
    expect(result.date).toEqual(new Date('2025-01-01'));
    expect(result.read).toBe(true);
    expect(result.flagged).toBe(false);
    expect(result.junk).toBe(false);
    expect(result.tags).toEqual(['tm_reply', 'custom_tag']);
    expect(result.folder).toEqual({
      id: 'acct1:/INBOX',
      accountId: 'acct1',
      name: 'Inbox',
      path: '/INBOX',
      type: 'inbox',
      specialUse: ['inbox'],
    });
    expect(result).not.toHaveProperty('extraField');
  });

  it('defaults missing fields to null', () => {
    const result = _pickHeaderFields({ id: 1 });
    expect(result.headerMessageId).toBeNull();
    expect(result.subject).toBeNull();
    expect(result.author).toBeNull();
    expect(result.recipients).toBeNull();
    expect(result.ccList).toBeNull();
    expect(result.bccList).toBeNull();
    expect(result.date).toBeNull();
    expect(result.read).toBeNull();
    expect(result.flagged).toBeNull();
    expect(result.junk).toBeNull();
  });

  it('returns folder as null when folder is missing', () => {
    const result = _pickHeaderFields({ id: 1 });
    expect(result.folder).toBeNull();
  });

  it('preserves array fields (recipients, ccList, bccList, tags)', () => {
    const header = {
      recipients: ['a@b.com', 'c@d.com'],
      ccList: ['e@f.com'],
      bccList: ['g@h.com'],
      tags: ['tag1', 'tag2'],
    };
    const result = _pickHeaderFields(header);
    expect(result.recipients).toEqual(['a@b.com', 'c@d.com']);
    expect(result.ccList).toEqual(['e@f.com']);
    expect(result.bccList).toEqual(['g@h.com']);
    expect(result.tags).toEqual(['tag1', 'tag2']);
  });

  it('returns null for non-array recipients', () => {
    const result = _pickHeaderFields({ recipients: 'not-an-array' });
    expect(result.recipients).toBeNull();
  });

  it('returns all null/empty defaults for empty object', () => {
    const result = _pickHeaderFields({});
    expect(result.id).toBeNull();
    expect(result.headerMessageId).toBeNull();
    expect(result.subject).toBeNull();
    expect(result.author).toBeNull();
    expect(result.recipients).toBeNull();
    expect(result.ccList).toBeNull();
    expect(result.bccList).toBeNull();
    expect(result.date).toBeNull();
    expect(result.read).toBeNull();
    expect(result.flagged).toBeNull();
    expect(result.junk).toBeNull();
    expect(result.tags).toEqual([]);
    expect(result.folder).toBeNull();
  });

  it('handles null input gracefully', () => {
    const result = _pickHeaderFields(null);
    expect(result.id).toBeNull();
    expect(result.tags).toEqual([]);
    expect(result.folder).toBeNull();
  });

  it('handles undefined input gracefully', () => {
    const result = _pickHeaderFields(undefined);
    expect(result.id).toBeNull();
    expect(result.tags).toEqual([]);
    expect(result.folder).toBeNull();
  });
});
