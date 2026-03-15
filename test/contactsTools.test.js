// contactsTools.test.js — Tests for chat/tools/contacts_add.js, contacts_edit.js, contacts_delete.js
//
// Tests contacts tool normalizeArgs, vCard building/updating, run() with mocked browser APIs.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis.browser mock
// ---------------------------------------------------------------------------
const storageData = {};
const createdContacts = [];
const updatedContacts = [];

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keysOrDefault) => {
        if (typeof keysOrDefault === 'string') {
          return { [keysOrDefault]: storageData[keysOrDefault] ?? undefined };
        }
        const result = {};
        for (const [k, def] of Object.entries(keysOrDefault)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        for (const [k, v] of Object.entries(obj)) storageData[k] = v;
      }),
    },
  },
  addressBooks: {
    list: vi.fn(async () => [{ id: 'book1', name: 'Personal' }]),
    contacts: {
      create: vi.fn(async (parentId, vCard) => {
        const id = `contact-${createdContacts.length + 1}`;
        createdContacts.push({ parentId, vCard, id });
        return id;
      }),
      get: vi.fn(async (id) => {
        if (id === 'existing-contact') {
          return {
            id: 'existing-contact',
            parentId: 'book1',
            properties: {
              DisplayName: 'Old Name',
              PrimaryEmail: 'old@example.com',
              FirstName: 'Old',
              LastName: 'Name',
            },
            vCard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Old Name\nN:Name;Old;;;\nEMAIL;TYPE=PREF:old@example.com\nEND:VCARD',
          };
        }
        if (id === 'wrong-book-contact') {
          return { id: 'wrong-book-contact', parentId: 'book2' };
        }
        throw new Error('Contact not found');
      }),
      update: vi.fn(async (id, vCard) => {
        updatedContacts.push({ id, vCard });
      }),
      query: vi.fn(async () => []),
    },
  },
  runtime: {
    sendMessage: vi.fn(async () => undefined),
  },
};

globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { debugLogging: false },
}));

vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => ({ textContent: '', classList: { add: vi.fn(), remove: vi.fn() } })),
}));

vi.mock('../chat/modules/context.js', () => ({
  ctx: {
    activePid: 0,
    awaitingPid: 0,
    activeToolCallId: null,
    fsmSessions: Object.create(null),
    state: null,
    toolExecutionMode: null,
    rawUserTexts: [],
  },
  initFsmSession: vi.fn(),
}));

vi.mock('../chat/fsm/core.js', () => ({
  executeAgentAction: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { run as contactsAddRun } from '../chat/tools/contacts_add.js';
import { run as contactsEditRun } from '../chat/tools/contacts_edit.js';

describe('contacts_add', () => {
  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    createdContacts.length = 0;
    updatedContacts.length = 0;
    vi.clearAllMocks();
  });

  describe('run', () => {
    it('should return error when no default address book and no addressbook_id', async () => {
      const result = await contactsAddRun({ name: 'Alice', email: 'alice@example.com' });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('address book') }));
    });

    it('should create contact when default address book is set', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      const result = await contactsAddRun({ name: 'Alice', email: 'alice@example.com' });
      expect(result).toBe('Contact created in address book.');
      expect(createdContacts.length).toBe(1);
      expect(createdContacts[0].parentId).toBe('book1');
    });

    it('should create contact with provided addressbook_id', async () => {
      const result = await contactsAddRun({ name: 'Alice', email: 'alice@example.com', addressbook_id: 'book1' });
      expect(result).toBe('Contact created in address book.');
    });

    it('should return error when no identifiable fields provided', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      const result = await contactsAddRun({});
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('name or an email') }));
    });

    it('should build vCard with all provided fields', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      await contactsAddRun({
        name: 'Alice Smith',
        email: 'alice@example.com',
        second_email: 'alice2@example.com',
        first_name: 'Alice',
        last_name: 'Smith',
        nickname: 'Ally',
      });
      expect(createdContacts.length).toBe(1);
      const vCard = createdContacts[0].vCard;
      expect(vCard).toContain('FN:Alice Smith');
      expect(vCard).toContain('N:Smith;Alice;;;');
      expect(vCard).toContain('NICKNAME:Ally');
      expect(vCard).toContain('EMAIL;TYPE=PREF:alice@example.com');
      expect(vCard).toContain('EMAIL:alice2@example.com');
      expect(vCard).toContain('BEGIN:VCARD');
      expect(vCard).toContain('END:VCARD');
    });

    it('should trim whitespace from fields', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      await contactsAddRun({ name: '  Alice  ', email: '  alice@example.com  ' });
      const vCard = createdContacts[0].vCard;
      expect(vCard).toContain('FN:Alice');
      expect(vCard).toContain('EMAIL;TYPE=PREF:alice@example.com');
    });

    it('should handle API failure gracefully', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      browser.addressBooks.contacts.create.mockRejectedValueOnce(new Error('API error'));
      const result = await contactsAddRun({ name: 'Alice', email: 'alice@example.com' });
      expect(result).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });
  });
});

describe('contacts_edit', () => {
  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    updatedContacts.length = 0;
    vi.clearAllMocks();
  });

  describe('run', () => {
    it('should return error when no contact_id provided', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      const result = await contactsEditRun({ name: 'New Name' });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('contact_id') }));
    });

    it('should return error when no default address book', async () => {
      const result = await contactsEditRun({ contact_id: 'existing-contact', name: 'New' });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('address book') }));
    });

    it('should return error when contact is not in default book', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      const result = await contactsEditRun({ contact_id: 'wrong-book-contact', name: 'New' });
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('not in the') }));
    });

    it('should update contact with new name', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      const result = await contactsEditRun({
        contact_id: 'existing-contact',
        name: 'New Name',
      });
      expect(result).toBe('Contact updated.');
      expect(updatedContacts.length).toBe(1);
      expect(updatedContacts[0].vCard).toContain('FN:New Name');
    });

    it('should update contact email', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      const result = await contactsEditRun({
        contact_id: 'existing-contact',
        email: 'new@example.com',
      });
      expect(result).toBe('Contact updated.');
      expect(updatedContacts[0].vCard).toContain('EMAIL;TYPE=PREF:new@example.com');
    });

    it('should preserve existing fields when not provided', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      await contactsEditRun({
        contact_id: 'existing-contact',
        nickname: 'NewNick',
      });
      const vCard = updatedContacts[0].vCard;
      // Should still have original name from the stored contact
      expect(vCard).toContain('FN:Old Name');
      expect(vCard).toContain('NICKNAME:NewNick');
    });

    it('should handle other_emails array', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      await contactsEditRun({
        contact_id: 'existing-contact',
        other_emails: ['extra@example.com'],
      });
      const vCard = updatedContacts[0].vCard;
      expect(vCard).toContain('EMAIL:extra@example.com');
    });

    it('should deduplicate other_emails against primary', async () => {
      storageData['defaultAddressBookId'] = 'book1';
      await contactsEditRun({
        contact_id: 'existing-contact',
        email: 'primary@example.com',
        other_emails: ['primary@example.com', 'other@example.com'],
      });
      const vCard = updatedContacts[0].vCard;
      // Primary should appear once with PREF
      const emailLines = vCard.split('\n').filter(l => l.startsWith('EMAIL'));
      const prefLines = emailLines.filter(l => l.includes('PREF'));
      expect(prefLines.length).toBe(1);
      // "other@example.com" should appear as a non-PREF email
      expect(emailLines.some(l => l.includes('other@example.com'))).toBe(true);
    });

    it('should use provided addressbook_id over default', async () => {
      storageData['defaultAddressBookId'] = 'book2';
      const result = await contactsEditRun({
        contact_id: 'existing-contact',
        addressbook_id: 'book1',
        name: 'Updated',
      });
      expect(result).toBe('Contact updated.');
    });
  });
});
