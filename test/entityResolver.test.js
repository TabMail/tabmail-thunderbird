// entityResolver.test.js — Tests for chat/modules/entityResolver.js
//
// Tests contact, event, and email resolution functions.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  parseUniqueId: vi.fn((uid) => {
    if (!uid || typeof uid !== 'string') return null;
    const parts = uid.split(':');
    if (parts.length < 3) return null;
    return {
      weFolder: { accountId: parts[0], path: parts[1] },
      headerID: parts[2],
    };
  }),
  headerIDToWeID: vi.fn(async () => null),
}));

// ---------------------------------------------------------------------------
// globalThis.browser mock
// ---------------------------------------------------------------------------

globalThis.browser = {
  addressBooks: {
    contacts: {
      get: vi.fn(async () => null),
    },
  },
  tmCalendar: {
    getCalendarEventDetails: vi.fn(async () => null),
  },
  messages: {
    get: vi.fn(async () => null),
  },
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { resolveContactDetails, resolveEventDetails, resolveEmailSubject } = await import('../chat/modules/entityResolver.js');
const { headerIDToWeID } = await import('../agent/modules/utils.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveContactDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when contact API is not available', async () => {
    const origGet = browser.addressBooks.contacts.get;
    browser.addressBooks.contacts.get = undefined;
    const result = await resolveContactDetails('contact-1');
    expect(result).toBe(null);
    browser.addressBooks.contacts.get = origGet;
  });

  it('returns null when contact not found', async () => {
    browser.addressBooks.contacts.get.mockResolvedValue(null);
    const result = await resolveContactDetails('contact-1');
    expect(result).toBe(null);
  });

  it('parses vCard to extract name and emails', async () => {
    browser.addressBooks.contacts.get.mockResolvedValue({
      vCard: 'BEGIN:VCARD\nFN:Alice Smith\nEMAIL:alice@example.com\nEND:VCARD',
    });
    const result = await resolveContactDetails('contact-1');
    expect(result).not.toBe(null);
    expect(result.name).toBe('Alice Smith');
    expect(result.email).toBe('alice@example.com');
    expect(result.emails).toContain('alice@example.com');
  });

  it('extracts multiple email addresses from vCard', async () => {
    browser.addressBooks.contacts.get.mockResolvedValue({
      vCard: 'BEGIN:VCARD\nFN:Bob\nEMAIL:bob@work.com\nEMAIL;TYPE=home:bob@home.com\nEND:VCARD',
    });
    const result = await resolveContactDetails('contact-2');
    expect(result.emails).toHaveLength(2);
    expect(result.emails).toContain('bob@work.com');
    expect(result.emails).toContain('bob@home.com');
  });

  it('falls back to properties when vCard has no FN', async () => {
    browser.addressBooks.contacts.get.mockResolvedValue({
      vCard: '',
      properties: {
        DisplayName: 'Charlie Brown',
        PrimaryEmail: 'charlie@example.com',
      },
    });
    const result = await resolveContactDetails('contact-3');
    expect(result.name).toBe('Charlie Brown');
    expect(result.email).toBe('charlie@example.com');
  });

  it('uses FirstName + LastName when DisplayName is missing', async () => {
    browser.addressBooks.contacts.get.mockResolvedValue({
      vCard: '',
      properties: {
        FirstName: 'Diana',
        LastName: 'Prince',
        PrimaryEmail: 'diana@example.com',
      },
    });
    const result = await resolveContactDetails('contact-4');
    expect(result.name).toBe('Diana Prince');
  });

  it('returns (No name) when no name info is available', async () => {
    browser.addressBooks.contacts.get.mockResolvedValue({
      vCard: 'BEGIN:VCARD\nEMAIL:anon@example.com\nEND:VCARD',
    });
    const result = await resolveContactDetails('contact-5');
    expect(result.name).toBe('(No name)');
    expect(result.email).toBe('anon@example.com');
  });

  it('handles API errors gracefully', async () => {
    browser.addressBooks.contacts.get.mockRejectedValue(new Error('API error'));
    const result = await resolveContactDetails('contact-err');
    expect(result).toBe(null);
  });
});

describe('resolveEventDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when calendar API is not available', async () => {
    const orig = browser.tmCalendar.getCalendarEventDetails;
    browser.tmCalendar.getCalendarEventDetails = undefined;
    const result = await resolveEventDetails('event-1');
    expect(result).toBe(null);
    browser.tmCalendar.getCalendarEventDetails = orig;
  });

  it('returns null when event not found', async () => {
    browser.tmCalendar.getCalendarEventDetails.mockResolvedValue(null);
    const result = await resolveEventDetails('event-1');
    expect(result).toBe(null);
  });

  it('returns null when event.ok is false', async () => {
    browser.tmCalendar.getCalendarEventDetails.mockResolvedValue({ ok: false });
    const result = await resolveEventDetails('event-1');
    expect(result).toBe(null);
  });

  it('returns event details when found', async () => {
    browser.tmCalendar.getCalendarEventDetails.mockResolvedValue({
      ok: true,
      title: 'Team Meeting',
      start: '2026-03-15T10:00:00',
      end: '2026-03-15T11:00:00',
      location: 'Room 42',
      attendees: 3,
      attendeeList: ['alice', 'bob', 'charlie'],
      organizer: 'alice',
    });
    const result = await resolveEventDetails('event-1');
    expect(result).not.toBe(null);
    expect(result.title).toBe('Team Meeting');
    expect(result.location).toBe('Room 42');
    expect(result.attendees).toBe(3);
    expect(result.organizer).toBe('alice');
    expect(result.ok).toBe(true);
  });

  it('uses (No title) when title is empty', async () => {
    browser.tmCalendar.getCalendarEventDetails.mockResolvedValue({
      ok: true,
      title: '',
      start: '2026-03-15T10:00:00',
    });
    const result = await resolveEventDetails('event-2');
    expect(result.title).toBe('(No title)');
  });

  it('handles API errors gracefully', async () => {
    browser.tmCalendar.getCalendarEventDetails.mockRejectedValue(new Error('API error'));
    const result = await resolveEventDetails('event-err');
    expect(result).toBe(null);
  });
});

describe('resolveEmailSubject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for invalid unique_id', async () => {
    const result = await resolveEmailSubject('invalid');
    expect(result).toBe(null);
  });

  it('returns null when headerID cannot be resolved', async () => {
    headerIDToWeID.mockResolvedValue(null);
    const result = await resolveEmailSubject('acc1:INBOX:hdr123');
    expect(result).toBe(null);
  });

  it('returns null when message header not found', async () => {
    headerIDToWeID.mockResolvedValue(42);
    browser.messages.get.mockResolvedValue(null);
    const result = await resolveEmailSubject('acc1:INBOX:hdr123');
    expect(result).toBe(null);
  });

  it('returns subject and from when message found', async () => {
    headerIDToWeID.mockResolvedValue(42);
    browser.messages.get.mockResolvedValue({
      subject: 'Test Subject',
      author: 'alice@example.com',
    });
    const result = await resolveEmailSubject('acc1:INBOX:hdr123');
    expect(result).not.toBe(null);
    expect(result.subject).toBe('Test Subject');
    expect(result.from).toBe('alice@example.com');
  });

  it('returns (No subject) when subject is empty', async () => {
    headerIDToWeID.mockResolvedValue(42);
    browser.messages.get.mockResolvedValue({
      subject: '',
      author: 'bob@example.com',
    });
    const result = await resolveEmailSubject('acc1:INBOX:hdr123');
    expect(result.subject).toBe('(No subject)');
  });

  it('handles errors gracefully', async () => {
    headerIDToWeID.mockRejectedValue(new Error('resolve error'));
    const result = await resolveEmailSubject('acc1:INBOX:hdr123');
    expect(result).toBe(null);
  });
});
