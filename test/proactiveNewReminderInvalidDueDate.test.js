/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A new-reminder nudge goes out for every new reminder in a batch even when
// one of them carries a due date that is not a date ("not-a-date": the summary
// wrote something the backend could not convert, kept as written). Every
// reminder in the batch is then marked as reached out, so none is withheld
// from later batches.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reminders: [], store: {} }));

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { notifications: {} } }));
vi.mock('../agent/modules/reminderStateStore.js', () => ({ hashReminder: vi.fn((r) => `hash:${r.content}`) }));
vi.mock('../agent/modules/reminderBuilder.js', () => ({ buildReminderList: vi.fn(async () => ({ reminders: h.reminders })) }));
vi.mock('../chat/modules/chatWindowUtils.js', () => ({
  isChatWindowOpen: vi.fn(async () => true),
  openOrFocusChatWindow: vi.fn(async () => {}),
}));
vi.mock('../chat/modules/helpers.js', () => ({ getUserName: vi.fn(async () => 'Alex') }));

const { log } = await import('../agent/modules/utils.js');

/** YYYY-MM-DD for a day `n` days from today, from the local clock. */
function daysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.store = { 'notifications.proactive_enabled': true };
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          if (typeof keys === 'string') return keys in h.store ? { [keys]: h.store[keys] } : {};
          const out = {};
          for (const [k, def] of Object.entries(keys || {})) out[k] = k in h.store ? h.store[k] : def;
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(h.store, structuredClone(obj)); }),
        remove: vi.fn(async () => {}),
      },
    },
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
    runtime: { sendMessage: vi.fn(async () => {}) },
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.browser;
});

describe('new-reminder nudge with a due date that is not a date', () => {
  it('still sends the nudge for the batch and marks every reminder in it as reached out', async () => {
    h.reminders = [
      { source: 'message', action: 'reply', content: 'Reply about the planning review', dueDate: daysFromToday(2), hash: 'r-valid' },
      { source: 'message', action: 'reply', content: 'Send the signed form', dueDate: 'not-a-date', hash: 'r-bad' },
    ];
    const { onInboxUpdated } = await import('../agent/modules/proactiveCheckin.js');

    await onInboxUpdated();
    // The nudge runs after the debounce; run it, then wait until it has either finished or failed.
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => {
      const failed = log.mock.calls.some(([msg]) => String(msg).includes('Debounced new-reminder handler failed'));
      if (!failed && !h.store['notifications.last_reachout']) throw new Error('nudge still pending');
    });

    const nudges = browser.runtime.sendMessage.mock.calls.filter(([m]) => m?.command === 'proactive-checkin-message');
    expect(nudges).toHaveLength(1);
    expect(nudges[0][0].message).toContain('Reply about the planning review');
    expect(nudges[0][0].message).toContain('Send the signed form');
    const reached = h.store['notifications.reached_out_ids'] || {};
    expect(Object.keys(reached).sort()).toEqual(['r-bad', 'r-valid']);
    expect(Object.values(reached).map((r) => r.trigger)).toEqual(['new_reminder', 'new_reminder']);
  });
});
