/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// shownItemIdentity.test.js — two knowledge-base bullets that read the same once normalized (curly and
// straight quotes in a task, the "Reminder:" and "[Reminder]" prefixes) are two Tasks or Reminders tab
// items, and deleting one removes only its own bullet, on this device and on a connected peer
// (DS-DISPLAYED, DS-TEXT). The real reminder builder, task and reminder parsers and Unicode normalization;
// the real prompt store and Device Sync modules on simulated devices.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';

/** The device whose knowledge base the builder reads, as the background reads its own. */
const current = { device: null };

vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugMode: false, getFullDiag: {} } }));
vi.mock('../agent/modules/utils.js', async (importOriginal) => ({ ...(await importOriginal()), log: vi.fn() }));
vi.mock('../agent/modules/promptGenerator.js', () => ({ getUserKBPrompt: vi.fn(async () => '') }));
vi.mock('../agent/modules/promptStore.js', () => ({ readView: (field) => current.device.prompts.readView(field) }));
vi.mock('../agent/modules/inboxContext.js', () => ({ buildInboxContext: vi.fn(async () => '[]') }));
vi.mock('../agent/modules/summaryGenerator.js', () => ({ getSummaryWithHeaderId: vi.fn(async () => null) }));
vi.mock('../agent/modules/reminderStateStore.js', () => ({
  getDisabledHashes: vi.fn(async () => new Set()),
  getDisabledMap: vi.fn(async () => ({})),
  gcStaleEntries: vi.fn(async () => {}),
  mergeIncoming: vi.fn(async () => {}),
  hashReminder: (reminder) => `k:${reminder.content}`,
  setEnabled: vi.fn(),
}));
// The cached KB reminders, as the generator stores them: the reminders parsed from the normalized KB text.
vi.mock('../agent/modules/kbReminderGenerator.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { normalizeUnicode } = await import('../agent/modules/utils.js');
  return {
    ...actual,
    getKBReminders: async () => actual.parseRemindersFromKB(normalizeUnicode((await current.device.prompts.readView('kb')).content)),
  };
});

const { buildReminderList } = await import('../agent/modules/reminderBuilder.js');

const CASES = {
  'a task with curly quotes and one with straight quotes': {
    type: 'task',
    bullets: ['[Task] Schedule mon 09:00 [UTC], Send the “weekly” summary', '[Task] Schedule mon 09:00 [UTC], Send the "weekly" summary'],
  },
  'a reminder with the old prefix and one with the new': {
    type: 'reminder',
    bullets: ['Reminder: Call the office', '[Reminder] Call the office'],
  },
};

async function flush(relay) {
  while (await relay.deliverOldest()) { /* every pending part */ }
}

const texts = async (d) => (await d.state('kb')).bullets.map((bullet) => bullet.text);

beforeEach(() => {
  current.device = null;
});

describe('bullets that read the same once normalized are separate items, each deleting only its own bullet (DS-DISPLAYED)', () => {
  for (const [name, { type, bullets }] of Object.entries(CASES)) {
    it(`${name}: deleting one keeps the other, on both devices`, async () => {
      const relay = new BulletRelay();
      const a = await new BulletDevice('A', new DeviceStore(), relay).start();
      const b = await new BulletDevice('B', new DeviceStore(), relay).start();
      await a.connect();
      await b.connect();
      for (const text of bullets) await a.add('kb', '', text);
      await a.add('kb', '', 'Unrelated note');
      await flush(relay);
      expect(await texts(a)).toEqual(expect.arrayContaining(bullets));
      current.device = a;

      const items = (await buildReminderList({ includeDisabled: true })).reminders.filter((item) => item.type === type && item.source === 'kb');
      expect(items).toHaveLength(2);

      // The user deletes the first item: exactly one of the two bullets goes, everywhere.
      expect(await a.prompts.removeShownItem('kb', 'tab delete', items[0].labels)).toBeNull();
      await flush(relay);
      for (const d of [a, b]) {
        const left = await texts(d);
        expect(bullets.filter((text) => left.includes(text)), d.id).toHaveLength(1);
        expect(left).toContain('Unrelated note');
      }
      // The second item then deletes the other one.
      expect(await a.prompts.removeShownItem('kb', 'tab delete', items[1].labels)).toBeNull();
      await flush(relay);
      for (const d of [a, b]) expect((await texts(d)).filter((text) => bullets.includes(text)), d.id).toEqual([]);
      await a.disconnect();
      await b.disconnect();
    });
  }

  it('one bullet listed once, alone: its item carries its label (control)', async () => {
    const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay()).start();
    await a.add('kb', '', '[Reminder] Water the plants');
    current.device = a;
    const items = (await buildReminderList({ includeDisabled: true })).reminders.filter((item) => item.source === 'kb');
    expect(items).toHaveLength(1);
    expect(items[0].labels.map(([, text]) => text)).toEqual(['[Reminder] Water the plants']);
  });
});
