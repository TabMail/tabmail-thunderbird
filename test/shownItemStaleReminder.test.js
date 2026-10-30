/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// shownItemStaleReminder.test.js — a cached knowledge-base reminder whose bullet was deleted is still listed
// until the cache is generated again, but it carries no label: deleting it from the Reminders tab deletes
// nothing, never another bullet (DS-DISPLAYED). The real reminder generator, its cache, the reminder builder
// and the prompt store on a simulated device.

import { expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';

/** The device whose knowledge base the builder and the generator read, as the background reads its own. */
const current = { device: null };

vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugMode: false, getFullDiag: {} } }));
vi.mock('../agent/modules/utils.js', async (importOriginal) => ({ ...(await importOriginal()), log: vi.fn() }));
vi.mock('../agent/modules/promptGenerator.js', () => ({ getUserKBPrompt: async () => current.device.prompts.readText('kb') }));
vi.mock('../agent/modules/promptStore.js', () => ({ readView: (field) => current.device.prompts.readView(field) }));
vi.mock('../agent/modules/inboxContext.js', () => ({ buildInboxContext: async () => '[]' }));
vi.mock('../agent/modules/summaryGenerator.js', () => ({ getSummaryWithHeaderId: async () => null }));
vi.mock('../agent/modules/reminderStateStore.js', () => ({
  getDisabledHashes: async () => new Set(),
  getDisabledMap: async () => ({}),
  gcStaleEntries: async () => {},
  mergeIncoming: async () => {},
  hashReminder: (reminder) => `k:${reminder.content}`,
  setEnabled: async () => {},
}));

const { buildReminderList } = await import('../agent/modules/reminderBuilder.js');
const { generateKBReminders } = await import('../agent/modules/kbReminderGenerator.js');

it('a cached reminder whose bullet was deleted deletes nothing, and an unrelated note is kept', async () => {
  const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay()).start();
  current.device = a;
  globalThis.browser = { storage: a.store.api() };
  try {
    await a.editSection('kb', '', () => ['[Reminder] Old reminder', 'Unrelated note']);
    await generateKBReminders(true);
    const listed = (await buildReminderList({ includeDisabled: true })).reminders.find((item) => item.source === 'kb');
    expect(listed.labels.map(([, text]) => text)).toEqual(['[Reminder] Old reminder']);

    await a.delete('kb', '', '[Reminder] Old reminder');
    const stale = (await buildReminderList({ includeDisabled: true })).reminders.find((item) => item.source === 'kb');
    expect(stale.content).toBe('Old reminder');

    const answer = await a.prompts.removeShownItem('kb', 'tab delete', stale.labels);
    expect(await a.prompts.readText('kb')).toContain('Unrelated note');
    expect(answer).toEqual({ error: a.prompts.ALREADY_REMOVED });
  } finally {
    delete globalThis.browser;
    await a.sync.cleanupDeviceSync();
  }
});
