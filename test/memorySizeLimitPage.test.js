/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// memorySizeLimitPage.test.js — the chat memory size limit on the real
// Prompts page (prompts/prompts.html) with the shipped settings: the usage row
// renders into the page's own elements, and any lower limit removes nothing
// until the user confirms it, whatever the usage shown.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/persistentChatStore.js', () => ({ clearAllThinking: vi.fn() }));

afterEach(() => {
  delete globalThis.browser;
  delete globalThis.document;
  delete globalThis.Option;
});

describe('shipped size limit settings', () => {
  it('default to 1 GB, one of the choices, and offer only positive whole byte counts', async () => {
    vi.resetModules();
    globalThis.browser = { storage: { onChanged: { addListener() {} } } };
    const { SETTINGS } = await import('../agent/modules/config.js');
    const { memorySizeLimitDefaultBytes, memorySizeLimitChoicesBytes } = SETTINGS.memoryManagement;
    expect(memorySizeLimitDefaultBytes).toBe(GB);
    expect(memorySizeLimitChoicesBytes).toContain(memorySizeLimitDefaultBytes);
    expect(memorySizeLimitChoicesBytes.length).toBeGreaterThan(1);
    for (const bytes of memorySizeLimitChoicesBytes) {
      expect(Number.isSafeInteger(bytes) && bytes > 0, String(bytes)).toBe(true);
    }
    expect([...memorySizeLimitChoicesBytes].sort((a, b) => a - b)).toEqual(memorySizeLimitChoicesBytes);
  });
});

describe('Chat History size limit on the real page', () => {
  // The page with `usedBytes` in memory and `stored` as the chosen limit. The
  // helper's trim brings memory to `afterTrim`. `stats`, when given, answers
  // memoryStats instead (`'reject'` rejects the call); `setStats` changes it
  // after the page loaded.
  async function openPage({ usedBytes, stored, afterTrim = usedBytes, stats: givenStats }) {
    let stats = givenStats;
    vi.resetModules();
    const dom = new JSDOM(readFileSync(resolve('prompts/prompts.html'), 'utf8'));
    globalThis.document = dom.window.document;
    globalThis.Option = dom.window.Option;
    const data = stored === undefined ? {} : { memorySizeLimitBytes: stored };
    let trimmed = false;
    const sendMessage = vi.fn(async msg => {
      if (msg.cmd === 'memoryStats') {
        if (stats === 'reject') throw new Error('Could not establish connection');
        if (stats !== undefined) return stats;
        return { docs: 3, dbBytes: usedBytes, usedBytes: trimmed ? afterTrim : usedBytes };
      }
      if (msg.cmd === 'memoryTrim') {
        trimmed = true;
        return { ok: true, trimmed: afterTrim < usedBytes ? 2 : 0, usedBytes: afterTrim, withinLimit: true };
      }
      return [];
    });
    globalThis.browser = {
      storage: {
        onChanged: { addListener() {} },
        local: {
          get: vi.fn(async defaults => {
            if (typeof defaults === 'string') return defaults in data ? { [defaults]: data[defaults] } : {};
            const out = {};
            for (const [key, value] of Object.entries(defaults || {})) out[key] = key in data ? data[key] : value;
            return out;
          }),
          set: vi.fn(async values => Object.assign(data, values)),
          remove: vi.fn(async () => {}),
        },
      },
      runtime: { sendMessage },
    };
    const history = await import('../prompts/modules/history.js');
    await history.loadChatHistory();
    history.initHistoryHandlers();
    const d = dom.window.document;
    const select = d.getElementById('history-size-limit');
    const choose = bytes => {
      select.value = String(bytes);
      select.dispatchEvent(new dom.window.Event('change'));
    };
    const trims = () => sendMessage.mock.calls.filter(([m]) => m.cmd === 'memoryTrim').length;
    return {
      d, data, select, choose, trims,
      label: () => d.getElementById('history-usage-label').textContent,
      status: () => d.getElementById('status-message').textContent,
      asking: () => d.getElementById('history-modal-overlay').style.display === 'flex',
      setStats: value => { stats = value; },
    };
  }

  it('renders usage against the limit at the top of the tab, with the note shown', async () => {
    const { d, select, label } = await openPage({ usedBytes: 300 * MB, stored: 250 * MB });
    expect(d.querySelector('#history-editor .history-content').firstElementChild.id).toBe('history-usage');
    expect(label()).toBe('Memory used: 300 MB of 250 MB');
    expect([...select.options].map(o => o.text)).toEqual(['100 MB', '250 MB', '500 MB', '1 GB', '2 GB', '5 GB']);
    expect(select.value).toBe(String(250 * MB));
    const bar = d.getElementById('history-usage-bar');
    expect(bar.max).toBe(250 * MB);
    expect(bar.value).toBe(250 * MB);
    const note = d.getElementById('history-usage-note');
    expect(note.style.display).toBe('block');
    expect(note.textContent).toContain('oldest conversations are removed first');
  });

  it('asks before a limit below what memory holds, and removes nothing until confirmed', async () => {
    const { d, data, select, choose, trims } = await openPage({ usedBytes: 300 * MB, stored: GB });
    choose(100 * MB);
    const overlay = d.getElementById('history-modal-overlay');
    expect(overlay.style.display).toBe('flex');
    expect(d.getElementById('modal-content').textContent).toContain('100 MB');
    // Until confirmed, the list shows the stored limit, and nothing is stored or removed.
    expect(select.value).toBe(String(GB));
    expect(data.memorySizeLimitBytes).toBe(GB);
    expect(trims()).toBe(0);

    d.getElementById('modal-cancel').click();
    expect(overlay.style.display).toBe('none');
    await new Promise(r => setTimeout(r, 0));
    expect(data.memorySizeLimitBytes).toBe(GB);
    expect(select.value).toBe(String(GB));
    expect(trims()).toBe(0);
  });

  it('applies the lower limit once confirmed', async () => {
    const { d, data, select, choose, trims, label } = await openPage({ usedBytes: 300 * MB, stored: GB, afterTrim: 90 * MB });
    choose(100 * MB);
    d.getElementById('modal-confirm').click();
    await vi.waitFor(() => expect(label()).toBe('Memory used: 90 MB of 100 MB'));
    expect(data.memorySizeLimitBytes).toBe(100 * MB);
    expect(trims()).toBe(1);
    expect(select.value).toBe(String(100 * MB));
    expect(d.getElementById('status-message').textContent).toBe('Size limit set to 100 MB. Removed the 2 oldest entries.');
  });

  // Before confirming: the modal is shown, storage is unchanged and no trim
  // was sent. After: the limit is stored and exactly one trim was sent.
  async function expectAsksThenApplies(page, chosen, stored) {
    expect(page.asking()).toBe(true);
    expect(page.select.value).toBe(String(stored));
    expect(page.data.memorySizeLimitBytes).toBe(stored);
    expect(page.trims()).toBe(0);
    page.d.getElementById('modal-confirm').click();
    // The status is the last thing the change writes.
    await vi.waitFor(() => expect(page.status()).toMatch(/^Size limit set to /));
    expect(page.data.memorySizeLimitBytes).toBe(chosen);
    expect(page.trims()).toBe(1);
  }

  const RELEASED = { docs: 3, dbBytes: 300 * MB };
  const STATS_STATES = [
    ['a capable helper, memory below the choice', { docs: 3, dbBytes: 300 * MB, usedBytes: 300 * MB }],
    ['a capable helper, used below the choice but the file above it', { docs: 3, dbBytes: 800 * MB, usedBytes: 300 * MB }],
    ['a released helper (file size only)', RELEASED],
    ['an error reply', { error: 'Native FTS helper not connected' }],
    ['a rejected stats call', 'reject'],
  ];

  it.each(STATS_STATES)('asks before any lower limit with %s', async (_name, stats) => {
    const page = await openPage({ usedBytes: 300 * MB, stored: GB, stats });
    page.choose(500 * MB);
    await expectAsksThenApplies(page, 500 * MB, GB);
  });

  it.each(STATS_STATES)('applies a higher limit directly with %s', async (_name, stats) => {
    const page = await openPage({ usedBytes: 300 * MB, stored: 250 * MB, stats });
    page.choose(GB);
    expect(page.asking()).toBe(false);
    await vi.waitFor(() => expect(page.status()).toBe('Size limit set to 1 GB.'));
    expect(page.data.memorySizeLimitBytes).toBe(GB);
    expect(page.trims()).toBe(1);
  });

  // The comparison is with the user's stored limit, not the shipped default:
  // pairs on both sides of the default.
  it.each([
    [5 * GB, 2 * GB],
    [2 * GB, GB],
  ])('asks before lowering a stored %s limit to %s', async (stored, chosen) => {
    const page = await openPage({ usedBytes: 300 * MB, stored });
    page.choose(chosen);
    await expectAsksThenApplies(page, chosen, stored);
  });

  it.each([
    [100 * MB, 250 * MB],
    [250 * MB, 500 * MB],
    [2 * GB, 5 * GB],
  ])('applies raising a stored %s limit to %s directly', async (stored, chosen) => {
    const page = await openPage({ usedBytes: 300 * MB, stored });
    page.choose(chosen);
    expect(page.asking()).toBe(false);
    await vi.waitFor(() => expect(page.status()).toMatch(/^Size limit set to /));
    expect(page.data.memorySizeLimitBytes).toBe(chosen);
    expect(page.trims()).toBe(1);
  });

  it('asks when the stats shown are out of date: no used size at load, a capable helper at the change', async () => {
    const page = await openPage({ usedBytes: 300 * MB, stored: GB, stats: RELEASED });
    page.setStats({ docs: 3, dbBytes: 300 * MB, usedBytes: 300 * MB });
    page.choose(100 * MB);
    await expectAsksThenApplies(page, 100 * MB, GB);
  });

  it('stores nothing while arrow keys step down the list, until confirmed', async () => {
    const page = await openPage({ usedBytes: 300 * MB, stored: GB, stats: RELEASED });
    page.choose(500 * MB);
    page.choose(250 * MB);
    page.choose(100 * MB);
    await new Promise(r => setTimeout(r, 0));
    expect(page.data.memorySizeLimitBytes).toBe(GB);
    expect(page.trims()).toBe(0);
    expect(page.d.getElementById('modal-content').textContent).toContain('100 MB');
    // Only the last choice applies.
    await expectAsksThenApplies(page, 100 * MB, GB);
    await new Promise(r => setTimeout(r, 0));
    expect(page.trims()).toBe(1);
  });
});
