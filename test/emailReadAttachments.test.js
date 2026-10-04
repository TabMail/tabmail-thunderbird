/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// email_read reports attachments from browser.messages.listAttachments. Thunderbird's
// MessageHeader has no attachment field, so the header can never be the source.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  resolveUniqueMessageKey: vi.fn(async () => ({ weFolder: { id: 'account1://INBOX' }, headerID: 'a@example.com', weID: 42 })),
  safeGetFull: vi.fn(async () => ({ __tmSynthetic: true, body: '', parts: [] })),
  extractBodyFromParts: vi.fn(async () => ''),
  getRealSubject: vi.fn(async (h) => h.subject),
  getUniqueMessageKey: vi.fn(async () => 'account1:/INBOX:a@example.com'),
}));

vi.mock('../chat/modules/icsParser.js', () => ({
  extractIcsFromParts: vi.fn(async () => []),
  formatIcsAttachmentsAsString: vi.fn(() => ''),
}));

const { log } = await import('../agent/modules/utils.js');
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

const listAttachments = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.browser = {
    messages: { get: vi.fn(async () => header), listAttachments },
    tmHdr: { getMsgKey: vi.fn(async () => 7), getReplied: vi.fn(async () => false) },
  };
});

describe('email_read attachments', () => {
  it('reports an attachment-only email as having its attachment, and lists it after the body', async () => {
    listAttachments.mockResolvedValue([
      { name: 'invoice.pdf', contentType: 'application/pdf', partName: '1.2', size: 51200 },
    ]);
    const out = await run({ unique_id: 'u1' });
    expect(typeof out).toBe('string');
    const lines = out.split('\n');
    expect(lines).toContain('has_attachments: yes');
    const bodyAt = lines.indexOf('body:');
    const listAt = lines.indexOf('attachments:');
    expect(listAt).toBeGreaterThan(bodyAt);
    expect(lines[listAt + 1]).toBe('  - invoice.pdf (application/pdf, 51200 bytes)');
    expect(listAttachments).toHaveBeenCalledWith(42);
  });

  it('lists every attachment', async () => {
    listAttachments.mockResolvedValue([
      { name: 'a.pdf', contentType: 'application/pdf', partName: '1.2', size: 10 },
      { name: 'b.png', contentType: 'image/png', partName: '1.3', size: 20 },
    ]);
    const lines = (await run({ unique_id: 'u1' })).split('\n');
    const listAt = lines.indexOf('attachments:');
    expect(lines.slice(listAt + 1, listAt + 3)).toEqual([
      '  - a.pdf (application/pdf, 10 bytes)',
      '  - b.png (image/png, 20 bytes)',
    ]);
  });

  it('reports no attachments, and no list, when the email has none', async () => {
    listAttachments.mockResolvedValue([]);
    const lines = (await run({ unique_id: 'u1' })).split('\n');
    expect(lines).toContain('has_attachments: no');
    expect(lines).not.toContain('attachments:');
  });

  it('reports no attachments when listAttachments returns nothing', async () => {
    listAttachments.mockResolvedValue(undefined);
    const lines = (await run({ unique_id: 'u1' })).split('\n');
    expect(lines).toContain('has_attachments: no');
    expect(lines).not.toContain('attachments:');
  });

  it('reports unknown, not no, and logs an error when the attachments cannot be listed', async () => {
    listAttachments.mockRejectedValue(new Error('boom'));
    const out = await run({ unique_id: 'u1' });
    expect(typeof out).toBe('string');
    const lines = out.split('\n');
    expect(lines).toContain('has_attachments: unknown');
    expect(lines).not.toContain('attachments:');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('listAttachments failed'), 'error');
  });
});
