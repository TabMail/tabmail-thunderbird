/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// email_read reports attachments from the MIME tree it already fetched for the body. When there
// is no usable tree (a body from the FTS index, a headers-only or undecryptable message), it uses
// Thunderbird's database flag. It never
// calls listAttachments or messages.query, which parse (and may download) the message again,
// and it never prints "no" when it could not tell.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  resolveUniqueMessageKey: vi.fn(async () => ({ weFolder: { id: 'account1://INBOX' }, headerID: 'a@example.com', weID: 42 })),
  safeGetFull: vi.fn(),
  extractBodyFromParts: vi.fn(async () => ''),
  getRealSubject: vi.fn(async (h) => h.subject),
  getUniqueMessageKey: vi.fn(async () => 'account1:/INBOX:a@example.com'),
}));

vi.mock('../chat/modules/icsParser.js', () => ({
  extractIcsFromParts: vi.fn(async () => []),
  formatIcsAttachmentsAsString: vi.fn(() => ''),
}));

const { log, safeGetFull } = await import('../agent/modules/utils.js');
const { extractIcsFromParts, formatIcsAttachmentsAsString } = await import('../chat/modules/icsParser.js');
const { run } = await import('../chat/tools/email_read.js');

// The shape Thunderbird 157's messages.get returns: there is no hasAttachments property.
const header = {
  id: 42,
  date: new Date(),
  author: 'Sender <sender@example.com>',
  recipients: ['me@example.com'],
  ccList: [],
  subject: 'Invoice',
  headerMessageId: 'a@example.com',
  folder: { id: 'account1://INBOX', path: '/INBOX' },
};

const textPart = { contentType: 'text/plain', partName: '1.1', size: 0, body: '' };
const pdfPart = { contentType: 'application/pdf', name: 'invoice.pdf', partName: '1.2', size: 51200 };
const mixed = (...parts) => ({ contentType: 'message/rfc822', partName: '', parts: [{ contentType: 'multipart/mixed', partName: '1', parts }] });

const getHasAttachmentBulk = vi.fn();
const listAttachments = vi.fn();
const query = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.browser = {
    messages: { get: vi.fn(async () => header), listAttachments, query },
    tmHdr: { getMsgKey: vi.fn(async () => 7), getReplied: vi.fn(async () => false), getHasAttachmentBulk },
  };
});

const readLines = async () => {
  const out = await run({ unique_id: 'u1' });
  expect(typeof out).toBe('string');
  expect(listAttachments).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  return out.split('\n');
};

describe('email_read attachments from the fetched MIME tree', () => {
  it('reports an attachment-only email as having its attachment, and lists it after the body', async () => {
    safeGetFull.mockResolvedValue(mixed(textPart, pdfPart));
    const lines = await readLines();
    expect(lines).toContain('has_attachments: yes');
    const listAt = lines.indexOf('attachments:');
    expect(listAt).toBeGreaterThan(lines.indexOf('body:'));
    expect(lines[listAt + 1]).toBe('  - invoice.pdf (application/pdf, 51200 bytes)');
    expect(getHasAttachmentBulk).not.toHaveBeenCalled();
  });

  it('finds a single-part attachment that the database flag would miss', async () => {
    // getFull wraps the message's only part, here the PDF itself, in an outer message/rfc822.
    safeGetFull.mockResolvedValue({ contentType: 'message/rfc822', partName: '', parts: [{ ...pdfPart, partName: '1' }] });
    const lines = await readLines();
    expect(lines).toContain('has_attachments: yes');
    expect(lines).toContain('  - invoice.pdf (application/pdf, 51200 bytes)');
  });

  it('lists every file, counting an attached email once', async () => {
    const forwarded = {
      contentType: 'message/rfc822', name: 'fwd.eml', partName: '1.3', size: 900,
      parts: [{ contentType: 'multipart/mixed', parts: [{ contentType: 'image/png', name: 'inner.png', size: 5 }] }],
    };
    safeGetFull.mockResolvedValue(mixed(textPart, pdfPart, forwarded));
    const lines = await readLines();
    const listAt = lines.indexOf('attachments:');
    expect(lines.slice(listAt + 1)).toEqual([
      '  - invoice.pdf (application/pdf, 51200 bytes)',
      '  - fwd.eml (message/rfc822, 900 bytes)',
    ]);
  });

  it('counts an attachment Thunderbird gives no file name, and lists it as unnamed', async () => {
    safeGetFull.mockResolvedValue(mixed(textPart, { contentType: 'application/octet-stream', name: '', partName: '1.2', size: 10 }));
    const lines = await readLines();
    expect(lines).toContain('has_attachments: yes');
    expect(lines).toContain('  - (unnamed) (application/octet-stream, 10 bytes)');
  });

  it('does not count a vCard as an attachment, as Thunderbird\'s paperclip does not, but lists it', async () => {
    safeGetFull.mockResolvedValue(mixed(textPart, { contentType: 'text/vcard', name: 'me.vcf', partName: '1.2', size: 3 }));
    const lines = await readLines();
    expect(lines).toContain('has_attachments: no');
    expect(lines).toContain('  - me.vcf (text/vcard, 3 bytes)');
  });

  it('reports no attachments, and no list, when the MIME tree has no files', async () => {
    safeGetFull.mockResolvedValue(mixed(textPart));
    const lines = await readLines();
    expect(lines).toContain('has_attachments: no');
    expect(lines).not.toContain('attachments:');
  });
});

describe('email_read attachments for a body served from the FTS index', () => {
  beforeEach(() => {
    safeGetFull.mockResolvedValue({ __tmSynthetic: true, body: 'indexed body', parts: [] });
  });

  it('uses Thunderbird\'s database flag for the message, without a list', async () => {
    getHasAttachmentBulk.mockResolvedValue([true]);
    const lines = await readLines();
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([42]);
    expect(lines).toContain('has_attachments: yes');
    expect(lines).not.toContain('attachments:');
  });

  it('reports no when the flag is clear', async () => {
    getHasAttachmentBulk.mockResolvedValue([false]);
    expect(await readLines()).toContain('has_attachments: no');
  });

  it('reports unknown, not no, when the header is gone', async () => {
    getHasAttachmentBulk.mockResolvedValue([null]);
    expect(await readLines()).toContain('has_attachments: unknown');
  });

  it('reports unknown, not no, and logs an error when the flag cannot be read', async () => {
    getHasAttachmentBulk.mockRejectedValue(new Error('boom'));
    expect(await readLines()).toContain('has_attachments: unknown');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('attachment flag read failed'), 'error');
  });
});

describe('email_read attachments when the MIME tree cannot tell', () => {
  it('uses the database flag for a headers-only message, whose parts getFull drops', async () => {
    browser.messages.get.mockResolvedValue({ ...header, headersOnly: true });
    safeGetFull.mockResolvedValue({ contentType: 'message/rfc822', partName: '', parts: [{ contentType: 'multipart/mixed', partName: '1' }] });
    getHasAttachmentBulk.mockResolvedValue([true]);
    const lines = await readLines();
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([42]);
    expect(lines).toContain('has_attachments: yes');
  });

  it('uses the database flag for a message Thunderbird could not decrypt', async () => {
    safeGetFull.mockResolvedValue({ contentType: 'message/rfc822', partName: '', decryptionStatus: 'fail', parts: [] });
    getHasAttachmentBulk.mockResolvedValue([null]);
    const lines = await readLines();
    expect(getHasAttachmentBulk).toHaveBeenCalledWith([42]);
    expect(lines).toContain('has_attachments: unknown');
  });
});

describe('email_read calendar invites', () => {
  const icsText = 'ICS Attachments (parsed):\nICS[1] filename=\'invite.ics\' contentType=\'text/calendar\' part=\'1.2\'';

  it('prints the invites the index stored when the body comes from the index', async () => {
    safeGetFull.mockResolvedValue({ __tmSynthetic: true, body: 'indexed body', parts: [], parsedIcsAttachments: icsText });
    getHasAttachmentBulk.mockResolvedValue([true]);
    const lines = await readLines();
    expect(lines.slice(-2)).toEqual(icsText.split('\n'));
    expect(lines.indexOf('ICS Attachments (parsed):')).toBeGreaterThan(lines.indexOf('body:'));
    expect(extractIcsFromParts).not.toHaveBeenCalled();
  });

  it('prints no invite section when the index stored none', async () => {
    safeGetFull.mockResolvedValue({ __tmSynthetic: true, body: 'indexed body', parts: [], parsedIcsAttachments: '' });
    getHasAttachmentBulk.mockResolvedValue([false]);
    const lines = await readLines();
    expect(lines.filter((l) => l.startsWith('ICS'))).toEqual([]);
    expect(extractIcsFromParts).not.toHaveBeenCalled();
  });

  it('scans the downloaded MIME tree for invites when the message was fetched', async () => {
    const icsPart = { contentType: 'text/calendar', name: 'invite.ics', partName: '1.2', size: 300 };
    const full = mixed(textPart, icsPart);
    const found = [{ filename: 'invite.ics', contentType: 'text/calendar', partName: '1.2', text: 'BEGIN:VCALENDAR' }];
    safeGetFull.mockResolvedValue(full);
    extractIcsFromParts.mockResolvedValueOnce(found);
    formatIcsAttachmentsAsString.mockReturnValueOnce(icsText);
    const lines = await readLines();
    expect(extractIcsFromParts).toHaveBeenCalledWith(full, 42);
    expect(formatIcsAttachmentsAsString).toHaveBeenCalledWith(found);
    expect(lines.slice(-2)).toEqual(icsText.split('\n'));
  });
});
