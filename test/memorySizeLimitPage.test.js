/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// memorySizeLimitPage.test.js — the chat memory size limit on the real
// Prompts page (prompts/prompts.html) with the shipped settings: the usage row
// renders into the page's own elements, and a limit below what memory holds
// removes nothing until the user confirms it.

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
  // helper's trim brings memory to `afterTrim`.
  async function openPage({ usedBytes, stored, afterTrim = usedBytes }) {
    vi.resetModules();
    const dom = new JSDOM(readFileSync(resolve('prompts/prompts.html'), 'utf8'));
    globalThis.document = dom.window.document;
    globalThis.Option = dom.window.Option;
    const data = stored === undefined ? {} : { memorySizeLimitBytes: stored };
    let trimmed = false;
    const sendMessage = vi.fn(async msg => {
      if (msg.cmd === 'memoryStats') return { docs: 3, dbBytes: usedBytes, usedBytes: trimmed ? afterTrim : usedBytes };
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
    return { d, data, select, choose, trims, label: () => d.getElementById('history-usage-label').textContent };
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

  it.each([
    ['raising the limit', 250 * MB, GB],
    ['lowering it while still above what memory holds', GB, 500 * MB],
  ])('applies directly when %s', async (_name, stored, chosen) => {
    const { d, data, choose, trims, label } = await openPage({ usedBytes: 300 * MB, stored });
    choose(chosen);
    expect(d.getElementById('history-modal-overlay').style.display).toBe('none');
    await vi.waitFor(() => expect(label()).toBe(`Memory used: 300 MB of ${chosen === GB ? '1 GB' : '500 MB'}`));
    expect(data.memorySizeLimitBytes).toBe(chosen);
    expect(trims()).toBe(1);
  });
});
