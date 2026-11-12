/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// An all-day invitation (DTSTART;VALUE=DATE) in an email reaches the assistant through
// email_read as the date it names, marked all-day, with no clock time, in every zone.
// A DATE has no zone and no instant: read as UTC midnight and printed in the user's
// zone, it named the previous day west of UTC (#412). Runs the real email_read and the
// real ICS parser under a zone west of UTC and one east of it.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { getFullDiag: {}, verboseLogging: false, debugLogging: false, debugMode: false } }));

vi.mock('../agent/modules/utils.js', async importOriginal => ({
  ...(await importOriginal()),
  log: vi.fn(),
  resolveUniqueMessageKey: vi.fn(async () => ({ weFolder: { id: 'account1://INBOX' }, headerID: 'a@example.com', weID: 42 })),
  safeGetFull: vi.fn(),
  getRealSubject: vi.fn(async (h) => h.subject),
  getUniqueMessageKey: vi.fn(async () => 'account1:/INBOX:a@example.com'),
}));

const { safeGetFull } = await import('../agent/modules/utils.js');
const { run } = await import('../chat/tools/email_read.js');

const originalTz = process.env.TZ;
afterAll(() => { process.env.TZ = originalTz; });

if (!globalThis.DOMParser) globalThis.DOMParser = new JSDOM('').window.DOMParser;

const header = {
  id: 42,
  date: new Date(),
  author: 'Organizer <organizer@example.com>',
  recipients: ['me@example.com'],
  ccList: [],
  subject: 'Team offsite',
  headerMessageId: 'a@example.com',
  folder: { id: 'account1://INBOX', path: '/INBOX' },
};

const pad2 = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// A day as digits, read through UTC getters only, so no zone moves it.
const dayParts = (y, m, d, shift = 0) => {
  const t = new Date(Date.UTC(y, m - 1, d + shift));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: WEEKDAYS[t.getUTCDay()] };
};
const icsDate = (p) => `${p.y}${pad2(p.m)}${pad2(p.d)}`;
const shown = (p) => `${p.wd} ${p.y}/${pad2(p.m)}/${pad2(p.d)}`;

const inviteMail = (startP, endP) => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Test//EN', 'METHOD:REQUEST',
    'BEGIN:VEVENT', 'UID:allday-412@example.com', 'SUMMARY:Team offsite',
    `DTSTART;VALUE=DATE:${icsDate(startP)}`, `DTEND;VALUE=DATE:${icsDate(endP)}`,
    'ORGANIZER;CN=Organizer:mailto:organizer@example.com',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  return {
    contentType: 'message/rfc822', partName: '', parts: [{
      contentType: 'multipart/mixed', partName: '1', parts: [
        { contentType: 'text/plain', partName: '1.1', size: 0, body: 'See you there.' },
        { contentType: 'text/calendar', name: 'invite.ics', partName: '1.2', size: ics.length, body: ics },
      ],
    }],
  };
};

// The parsed invitation, after the mail's own headers (whose date has a clock time).
const icsSection = (out) => out.slice(out.indexOf('ICS Attachments (parsed):'));

const ZONES = ['America/Los_Angeles', 'Pacific/Honolulu', 'America/New_York', 'Pacific/Auckland'];

for (const zone of ZONES) {
  describe(`email_read all-day invitation in ${zone}`, () => {
    beforeEach(() => {
      process.env.TZ = zone;
      vi.clearAllMocks();
      globalThis.browser = {
        messages: { get: vi.fn(async () => header), listAttachments: vi.fn(), query: vi.fn() },
        tmHdr: { getRepliedBulk: vi.fn(async (ids) => ids.map(() => false)), getHasAttachmentBulk: vi.fn() },
      };
    });

    it('shows a one-day invitation on its own day, all-day, with no clock time', async () => {
      const start = dayParts(2099, 11, 12);
      safeGetFull.mockResolvedValue(inviteMail(start, dayParts(2099, 11, 12, 1)));
      const out = await run({ unique_id: 'u1' });
      expect(typeof out).toBe('string');
      const when = out.split('\n').find((l) => l.startsWith('When:'));
      expect(when).toBe(`When: all day, ${shown(start)}`);
      const json = JSON.parse(out.split('\n').find((l) => l.startsWith('ICS_JSON[1.1]: ')).slice('ICS_JSON[1.1]: '.length));
      expect(json.all_day).toBe(true);
      expect(json.start.date).toBe(`${start.y}-${pad2(start.m)}-${pad2(start.d)}`);
      expect(json.end.last_date).toBe(json.start.date);
      // No instant and no clock time anywhere the assistant reads.
      expect(icsSection(out)).not.toMatch(/\d{2}:\d{2}/);
    });

    it('shows a multi-day invitation from its first day to its last day (DTEND is exclusive)', async () => {
      const start = dayParts(2099, 12, 31);
      const last = dayParts(2099, 12, 31, 2);
      safeGetFull.mockResolvedValue(inviteMail(start, dayParts(2099, 12, 31, 3)));
      const out = await run({ unique_id: 'u1' });
      const when = out.split('\n').find((l) => l.startsWith('When:'));
      expect(when).toBe(`When: all day, ${shown(start)} to ${shown(last)}`);
      expect(icsSection(out)).not.toMatch(/\d{2}:\d{2}/);
    });
  });
}
