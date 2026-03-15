// contacts.test.js — Tests for chat/modules/contacts.js
//
// Tests vCard parsing, contact querying, candidate finding, normalization.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis.browser mock
// ---------------------------------------------------------------------------
const mockContacts = [];
const mockBooks = [];

globalThis.browser = {
  addressBooks: {
    list: vi.fn(async () => mockBooks),
    contacts: {
      query: vi.fn(async ({ searchString, parentId } = {}) => {
        return mockContacts.filter(c => {
          if (parentId && c.parentId !== parentId) return false;
          if (!searchString) return true;
          const s = searchString.toLowerCase();
          const props = c.properties || {};
          const emails = [props.PrimaryEmail, props.SecondEmail].filter(Boolean).map(e => e.toLowerCase());
          const name = (props.DisplayName || '').toLowerCase();
          return emails.some(e => e.includes(s)) || name.includes(s);
        });
      }),
    },
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
  },
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { debugLogging: false },
}));

vi.mock('../chat/modules/context.js', () => ({
  ctx: { selectedRecipientList: [] },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import {
  parseVCardBasic,
  queryContacts,
  findContactsCandidates,
  findContactsRawRows,
  normalizeRecipients,
} from '../chat/modules/contacts.js';

describe('contacts', () => {
  beforeEach(() => {
    mockContacts.length = 0;
    mockBooks.length = 0;
    vi.clearAllMocks();
  });

  // --- parseVCardBasic ---
  describe('parseVCardBasic', () => {
    it('should return empty result for null input', () => {
      const r = parseVCardBasic(null);
      expect(r.fn).toBe('');
      expect(r.emails).toEqual([]);
    });

    it('should return empty result for empty string', () => {
      const r = parseVCardBasic('');
      expect(r.fn).toBe('');
      expect(r.emails).toEqual([]);
    });

    it('should parse FN field', () => {
      const vcard = 'BEGIN:VCARD\nFN:Alice Smith\nEND:VCARD';
      const r = parseVCardBasic(vcard);
      expect(r.fn).toBe('Alice Smith');
    });

    it('should parse N field (first and last name)', () => {
      const vcard = 'BEGIN:VCARD\nN:Smith;Alice;;;\nEND:VCARD';
      const r = parseVCardBasic(vcard);
      expect(r.firstName).toBe('Alice');
      expect(r.lastName).toBe('Smith');
    });

    it('should parse NICKNAME field', () => {
      const vcard = 'BEGIN:VCARD\nNICKNAME:Ally\nEND:VCARD';
      const r = parseVCardBasic(vcard);
      expect(r.nickName).toBe('Ally');
    });

    it('should parse single EMAIL', () => {
      const vcard = 'BEGIN:VCARD\nEMAIL:alice@example.com\nEND:VCARD';
      const r = parseVCardBasic(vcard);
      expect(r.emails).toEqual(['alice@example.com']);
      expect(r.preferredEmail).toBe('alice@example.com');
    });

    it('should parse multiple EMAIL fields', () => {
      const vcard = 'BEGIN:VCARD\nEMAIL;TYPE=PREF:alice@example.com\nEMAIL:alice2@example.com\nEND:VCARD';
      const r = parseVCardBasic(vcard);
      expect(r.emails.length).toBe(2);
      expect(r.preferredEmail).toBe('alice@example.com');
    });

    it('should identify PREF email as preferred', () => {
      const vcard = 'BEGIN:VCARD\nEMAIL:other@example.com\nEMAIL;TYPE=PREF:preferred@example.com\nEND:VCARD';
      const r = parseVCardBasic(vcard);
      expect(r.preferredEmail).toBe('preferred@example.com');
    });

    it('should handle folded lines (continuation with space)', () => {
      const vcard = 'BEGIN:VCARD\nFN:Very Long\n Name Here\nEND:VCARD';
      const r = parseVCardBasic(vcard);
      expect(r.fn).toBe('Very LongName Here');
    });

    it('should handle complete vCard', () => {
      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Bob Jones',
        'N:Jones;Bob;;;',
        'NICKNAME:Bobby',
        'EMAIL;TYPE=PREF:bob@example.com',
        'EMAIL:bob.jones@work.com',
        'END:VCARD',
      ].join('\n');
      const r = parseVCardBasic(vcard);
      expect(r.fn).toBe('Bob Jones');
      expect(r.firstName).toBe('Bob');
      expect(r.lastName).toBe('Jones');
      expect(r.nickName).toBe('Bobby');
      expect(r.emails.length).toBe(2);
      expect(r.preferredEmail).toBe('bob@example.com');
    });

    it('should handle non-string input gracefully', () => {
      const r = parseVCardBasic(42);
      expect(r.fn).toBe('');
      expect(r.emails).toEqual([]);
    });
  });

  // --- queryContacts ---
  describe('queryContacts', () => {
    it('should return matching contacts', async () => {
      mockContacts.push({
        id: 'c1',
        properties: { DisplayName: 'Alice', PrimaryEmail: 'alice@example.com' },
      });
      const { rows, didTimeout } = await queryContacts('alice', 5000);
      expect(rows.length).toBe(1);
      expect(didTimeout).toBe(false);
    });

    it('should return empty rows when no match', async () => {
      const { rows } = await queryContacts('nobody', 5000);
      expect(rows).toEqual([]);
    });

    it('should handle query API failure gracefully', async () => {
      browser.addressBooks.contacts.query.mockRejectedValueOnce(new Error('api fail'));
      const { rows, didTimeout } = await queryContacts('test', 5000);
      expect(rows).toEqual([]);
      expect(didTimeout).toBe(false);
    });
  });

  // --- findContactsCandidates ---
  describe('findContactsCandidates', () => {
    it('should return empty array for empty query', async () => {
      const result = await findContactsCandidates('', { timeoutMs: 5000 });
      expect(result).toEqual([]);
    });

    it('should return empty array for invalid timeout', async () => {
      const result = await findContactsCandidates('test', { timeoutMs: 0 });
      expect(result).toEqual([]);
    });

    it('should return candidates with name and email', async () => {
      mockContacts.push({
        id: 'c1',
        properties: { DisplayName: 'Alice Smith', PrimaryEmail: 'alice@example.com' },
        vCard: 'BEGIN:VCARD\nFN:Alice Smith\nEMAIL:alice@example.com\nEND:VCARD',
      });
      mockBooks.push({ id: 'book1', name: 'Personal' });
      const result = await findContactsCandidates('alice', { timeoutMs: 5000 });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].email).toBe('alice@example.com');
    });

    it('should skip contacts without email', async () => {
      mockContacts.push({
        id: 'c1',
        properties: { DisplayName: 'No Email Person' },
        vCard: 'BEGIN:VCARD\nFN:No Email Person\nEND:VCARD',
      });
      mockBooks.push({ id: 'book1', name: 'Personal' });
      const result = await findContactsCandidates('No Email', { timeoutMs: 5000 });
      expect(result).toEqual([]);
    });

    it('should deduplicate by email, keeping longer name', async () => {
      mockContacts.push(
        {
          id: 'c1',
          properties: { DisplayName: 'A', PrimaryEmail: 'shared@example.com' },
          vCard: 'BEGIN:VCARD\nFN:A\nEMAIL:shared@example.com\nEND:VCARD',
        },
        {
          id: 'c2',
          properties: { DisplayName: 'Alice Longname', PrimaryEmail: 'shared@example.com' },
          vCard: 'BEGIN:VCARD\nFN:Alice Longname\nEMAIL:shared@example.com\nEND:VCARD',
        }
      );
      mockBooks.push({ id: 'book1', name: 'Personal' });
      const result = await findContactsCandidates('shared', { timeoutMs: 5000 });
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('Alice Longname');
    });

    it('should respect limit option', async () => {
      for (let i = 0; i < 10; i++) {
        mockContacts.push({
          id: `c${i}`,
          properties: { DisplayName: `Person ${i}`, PrimaryEmail: `p${i}@example.com` },
          vCard: `BEGIN:VCARD\nFN:Person ${i}\nEMAIL:p${i}@example.com\nEND:VCARD`,
        });
      }
      mockBooks.push({ id: 'book1', name: 'Personal' });
      const result = await findContactsCandidates('person', { timeoutMs: 5000, limit: 3 });
      expect(result.length).toBe(3);
    });

    it('should use per-book queries when parentIds provided', async () => {
      mockContacts.push({
        id: 'c1',
        parentId: 'book1',
        properties: { DisplayName: 'Alice', PrimaryEmail: 'alice@example.com' },
        vCard: 'BEGIN:VCARD\nFN:Alice\nEMAIL:alice@example.com\nEND:VCARD',
      });
      mockBooks.push({ id: 'book1', name: 'Personal' });
      const result = await findContactsCandidates('alice', {
        timeoutMs: 5000,
        parentIds: ['book1'],
      });
      expect(result.length).toBe(1);
    });
  });

  // --- normalizeRecipients ---
  describe('findContactsRawRows', () => {
    it('returns empty array for empty query', async () => {
      const result = await findContactsRawRows('', { timeoutMs: 5000 });
      expect(result).toEqual([]);
    });

    it('returns empty array for null query', async () => {
      const result = await findContactsRawRows(null, { timeoutMs: 5000 });
      expect(result).toEqual([]);
    });

    it('returns empty array for invalid timeoutMs', async () => {
      const result = await findContactsRawRows('test', { timeoutMs: 0 });
      expect(result).toEqual([]);
    });

    it('returns empty array for negative timeoutMs', async () => {
      const result = await findContactsRawRows('test', { timeoutMs: -1 });
      expect(result).toEqual([]);
    });

    it('returns contacts matching global query', async () => {
      mockContacts.push({
        id: 'c1',
        properties: { DisplayName: 'Alice', PrimaryEmail: 'alice@example.com' },
      });
      const result = await findContactsRawRows('alice', { timeoutMs: 5000 });
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('c1');
    });

    it('falls back to per-book queries when global returns empty', async () => {
      mockBooks.push({ id: 'book1', name: 'Personal' });
      mockContacts.push({
        id: 'c2',
        parentId: 'book1',
        properties: { DisplayName: 'Bob', PrimaryEmail: 'bob@example.com' },
      });
      // Global query returns empty first, then per-book query returns the contact
      browser.addressBooks.contacts.query
        .mockResolvedValueOnce([]) // global query returns empty
        // per-book query falls through to default mock which checks mockContacts
      ;

      const result = await findContactsRawRows('bob', { timeoutMs: 5000 });
      // Per-book fallback should find the contact
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('c2');
    });

    it('uses explicit parentIds when provided', async () => {
      mockContacts.push({
        id: 'c3',
        parentId: 'book2',
        properties: { DisplayName: 'Carol', PrimaryEmail: 'carol@example.com' },
      });
      const result = await findContactsRawRows('carol', {
        timeoutMs: 5000,
        parentIds: ['book2'],
      });
      expect(result.length).toBe(1);
    });

    it('filters invalid parentIds', async () => {
      const result = await findContactsRawRows('test', {
        timeoutMs: 5000,
        parentIds: ['valid_id', '', null, 42],
      });
      // Should not throw, just filter out invalid entries
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles query throwing error gracefully', async () => {
      browser.addressBooks.contacts.query.mockRejectedValueOnce(new Error('query failed'));
      const result = await findContactsRawRows('test', { timeoutMs: 5000 });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('normalizeRecipients', () => {
    it('should return empty array for empty input', async () => {
      const result = await normalizeRecipients([]);
      expect(result).toEqual([]);
    });

    it('should return empty array for null input', async () => {
      const result = await normalizeRecipients(null);
      expect(result).toEqual([]);
    });

    it('should skip entries without email', async () => {
      const result = await normalizeRecipients([{ name: 'No Email' }]);
      expect(result).toEqual([]);
    });

    it('should preserve email from input', async () => {
      const result = await normalizeRecipients([{ email: 'test@example.com', name: 'Test' }]);
      expect(result.length).toBe(1);
      expect(result[0].email).toBe('test@example.com');
    });

    it('should override LLM name with address book name when available', async () => {
      mockContacts.push({
        id: 'c1',
        properties: { DisplayName: 'Real Name', PrimaryEmail: 'test@example.com' },
        vCard: 'BEGIN:VCARD\nFN:Real Name\nEMAIL:test@example.com\nEND:VCARD',
      });
      mockBooks.push({ id: 'book1', name: 'Personal' });
      const result = await normalizeRecipients([{ email: 'test@example.com', name: 'LLM Name' }]);
      expect(result[0].name).toBe('Real Name');
    });

    it('should keep LLM name when no address book match', async () => {
      mockBooks.push({ id: 'book1', name: 'Personal' });
      const result = await normalizeRecipients([{ email: 'unknown@example.com', name: 'LLM Name' }]);
      expect(result[0].name).toBe('LLM Name');
    });
  });
});
