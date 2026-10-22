/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// TB-193 (#147): the Chat History tab's requests to the memory helper fit the
// native-messaging reply cap. Thunderbird refuses a helper message over 1 MiB
// and disconnects the helper; memory entries are stored whole. This runs the
// real page (prompts/prompts.html) with the shipped settings against a fake
// helper that answers memorySearch, memoryRead and memoryRemoveBatch as the
// helper does (previewChars cuts content in the reply, both date bounds
// inclusive, newest first) and refuses an over-cap reply.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/persistentChatStore.js', () => ({ clearAllThinking: vi.fn() }));

const NATIVE_MESSAGE_CAP_BYTES = 1024 * 1024;
// A page that never stops asking fails here, not by exhausting the worker.
const MAX_HELPER_REQUESTS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.browser;
  delete globalThis.document;
  delete globalThis.Option;
});

// `count` entries of about `chars` characters, a minute apart, newest first,
// each ending in its own marker.
function entriesOf(count, chars, newestMs = Date.now() - 60_000) {
  return Array.from({ length: count }, (_, i) => ({
    memId: `m${i}`,
    sessionId: 'persistent_chat',
    role: 'exchange',
    content: `[USER]: planning ${'u'.repeat(100)}\n\n[AGENT]: ${'a'.repeat(chars)} END ${i}`,
    dateMs: newestMs - i * 60_000,
  }));
}

function fakeHelper(entries, { removes = true } = {}) {
  const stored = [...entries];
  const replies = { overCap: 0, largest: 0, calls: [] };
  const reply = result => {
    const bytes = Buffer.byteLength(JSON.stringify({ id: 1, result }), 'utf8');
    replies.largest = Math.max(replies.largest, bytes);
    if (bytes > NATIVE_MESSAGE_CAP_BYTES) {
      replies.overCap += 1;
      return { error: 'Native helper disconnected' };
    }
    return result;
  };
  const cut = (text, n) => (Number.isInteger(n) && n > 0 ? [...text].slice(0, n).join('') : text);
  const sendMessage = vi.fn(async msg => {
    replies.calls.push(msg);
    if (replies.calls.length > MAX_HELPER_REQUESTS) throw new Error('runaway: too many helper requests');
    switch (msg.cmd) {
      case 'memoryStats':
        return { docs: stored.length, usedBytes: 1, dbBytes: 1 };
      case 'memorySearch': {
        const query = String(msg.q).trim() !== '';
        const from = msg.ignoreDate || msg.from === undefined || msg.from === '' ? -Infinity : msg.from;
        const to = msg.ignoreDate || msg.to === undefined || msg.to === '' ? Infinity : msg.to;
        const found = stored
          .filter(e => e.dateMs >= from && e.dateMs <= to)
          .sort((a, b) => b.dateMs - a.dateMs)
          .slice(0, msg.limit)
          .map(e => ({ ...e, content: cut(e.content, msg.previewChars), snippet: query ? cut(e.content, msg.previewChars) : null, rank: 0 }));
        return reply(found);
      }
      case 'memoryRead': {
        const found = stored
          .filter(e => Math.abs(e.dateMs - msg.timestampMs) <= msg.toleranceMs)
          .sort((a, b) => a.dateMs - b.dateMs)
          .slice(0, 50);
        return reply(found);
      }
      case 'memoryRemoveBatch': {
        let count = 0;
        if (removes) {
          for (const id of msg.ids) {
            const at = stored.findIndex(e => e.memId === id);
            if (at >= 0) {
              stored.splice(at, 1);
              count += 1;
            }
          }
        }
        return reply({ ok: true, count });
      }
      default:
        return undefined;
    }
  });
  return { stored, replies, sendMessage };
}

async function openPage(helper) {
  vi.resetModules();
  const dom = new JSDOM(readFileSync(resolve('prompts/prompts.html'), 'utf8'));
  globalThis.document = dom.window.document;
  globalThis.Option = dom.window.Option;
  globalThis.browser = {
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { sendMessage: helper.sendMessage },
  };
  const history = await import('../prompts/modules/history.js');
  await history.loadChatHistory();
  history.initHistoryHandlers();
  const d = dom.window.document;
  return {
    d,
    history,
    shown: () => [...d.querySelectorAll('#history-list .history-search-result-content')].map(el => el.textContent),
    pageInfo: () => d.getElementById('history-page-info').textContent,
    label: () => d.getElementById('history-stats').textContent.replace(/\s+/g, ' ').trim(),
    status: () => d.getElementById('status-message').textContent,
  };
}

const search = async (page, query) => {
  page.d.getElementById('history-search-input').value = query;
  page.d.getElementById('history-search-btn').click();
};

describe('TB-193: Chat History search and the native-messaging cap', () => {
  it('shows 200 matching sessions of 200 KB, each entry on the page whole, with every reply under the cap', async () => {
    const entries = entriesOf(200, 200_000);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);

    await search(page, 'planning');
    await vi.waitFor(() => expect(page.shown()).toHaveLength(20));
    expect(page.shown()).toEqual(entries.slice(0, 20).map(e => e.content));
    expect(page.pageInfo()).toBe('Page 1 of 10');
    expect(page.d.querySelector('#history-list .search-highlight')?.textContent).toBe('planning');

    page.d.getElementById('history-next-page').click();
    await vi.waitFor(() => expect(page.pageInfo()).toBe('Page 2 of 10'));
    expect(page.shown()).toEqual(entries.slice(20, 40).map(e => e.content));
    page.d.getElementById('history-prev-page').click();
    await vi.waitFor(() => expect(page.pageInfo()).toBe('Page 1 of 10'));
    expect(page.shown()).toEqual(entries.slice(0, 20).map(e => e.content));

    expect(helper.replies.overCap).toBe(0);
    // Only the shown entries are read, each once.
    const reads = helper.replies.calls.filter(m => m.cmd === 'memoryRead');
    expect(reads).toHaveLength(40);
  }, 30_000);

  it('shows each entry whole when others share its millisecond, and says when one is gone', async () => {
    const now = Date.now() - 60_000;
    const entries = [
      { memId: 'a', sessionId: 's', role: 'exchange', content: 'planning one', dateMs: now },
      { memId: 'b', sessionId: 's', role: 'exchange', content: 'planning two', dateMs: now },
      { memId: 'c', sessionId: 's', role: 'exchange', content: 'planning three', dateMs: now - 1 },
    ];
    const helper = fakeHelper(entries);
    const page = await openPage(helper);

    // Removed after the search answered, before the page read it.
    const search0 = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg => {
      const result = await search0(msg);
      if (msg.cmd === 'memorySearch') helper.stored.splice(helper.stored.findIndex(e => e.memId === 'c'), 1);
      return result;
    });
    await search(page, 'planning');
    await vi.waitFor(() => expect(page.shown()).toHaveLength(3));
    expect(page.shown()).toEqual(['planning one', 'planning two', '(No longer in memory.)']);
  });

  it('a search that answers late does not show over a later one, nor change the pages it lists', async () => {
    const entries = entriesOf(40, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    let releaseFirst;
    const firstHeld = new Promise(r => { releaseFirst = r; });
    let searches = 0;
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === 'memorySearch' && ++searches === 1) {
        await firstHeld;
        return [];
      }
      return answer(msg);
    });

    await search(page, 'first');
    await search(page, 'planning');
    await vi.waitFor(() => expect(page.shown()).toHaveLength(20));
    releaseFirst();
    await new Promise(r => setTimeout(r, 0));
    expect(page.shown()).toEqual(entries.slice(0, 20).map(e => e.content));
    expect(page.d.getElementById('history-empty').style.display).toBe('none');
    page.d.getElementById('history-next-page').click();
    await vi.waitFor(() => expect(page.pageInfo()).toBe('Page 2 of 2'));
    expect(page.shown()).toEqual(entries.slice(20, 40).map(e => e.content));
  });

  it('a page that loads late does not show over a later search', async () => {
    const entries = entriesOf(40, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    await search(page, 'planning');
    await vi.waitFor(() => expect(page.shown()).toHaveLength(20));

    // Hold the reads of page 2's entries; the next search reads page 1's.
    const answer = helper.sendMessage.getMockImplementation();
    const secondPageMs = new Set(entries.slice(20).map(e => e.dateMs));
    let releaseReads;
    const readsHeld = new Promise(r => { releaseReads = r; });
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === 'memoryRead' && secondPageMs.has(msg.timestampMs)) await readsHeld;
      return answer(msg);
    });
    page.d.getElementById('history-next-page').click();
    await search(page, 'planning');
    await vi.waitFor(() => expect(helper.replies.calls.filter(m => m.cmd === 'memorySearch')).toHaveLength(2));
    await new Promise(r => setTimeout(r, 0));
    releaseReads();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(page.pageInfo()).toBe('Page 1 of 2');
    expect(page.shown()).toEqual(entries.slice(0, 20).map(e => e.content));
  });

  // Holds the helper's answers to `cmd` messages for which `match` is true until released.
  function hold(helper, cmd, match = () => true) {
    const answer = helper.sendMessage.getMockImplementation();
    let release;
    const held = new Promise(r => { release = r; });
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === cmd && match(msg)) await held;
      return answer(msg);
    });
    return () => release();
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  };

  it('a page change while a search is pending pages the results shown, then shows the search', async () => {
    const alpha = entriesOf(40, 10);
    const helper = fakeHelper(alpha);
    const page = await openPage(helper);
    await search(page, 'planning');
    await vi.waitFor(() => expect(page.shown()).toHaveLength(20));

    const releaseSearch = hold(helper, 'memorySearch');
    await search(page, 'beta');
    page.d.getElementById('history-next-page').click();
    await vi.waitFor(() => expect(page.pageInfo()).toBe('Page 2 of 2'));
    expect(page.shown()).toEqual(alpha.slice(20, 40).map(e => e.content));
    expect(page.label()).toContain('"planning" (40 results)');

    releaseSearch();
    await vi.waitFor(() => expect(page.label()).toContain('"beta" (40 results)'));
    expect(page.pageInfo()).toBe('Page 1 of 2');
    expect(page.shown()).toEqual(alpha.slice(0, 20).map(e => e.content));
  });

  it('a page change that loads late does not show over a later page change', async () => {
    const entries = entriesOf(60, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    await search(page, 'planning');
    await vi.waitFor(() => expect(page.shown()).toHaveLength(20));
    page.d.getElementById('history-next-page').click();
    await vi.waitFor(() => expect(page.pageInfo()).toBe('Page 2 of 3'));

    const thirdPageMs = new Set(entries.slice(40).map(e => e.dateMs));
    const releaseReads = hold(helper, 'memoryRead', msg => thirdPageMs.has(msg.timestampMs));
    page.d.getElementById('history-next-page').click();
    await settle();
    expect(page.pageInfo()).toBe('Page 2 of 3');
    page.d.getElementById('history-prev-page').click();
    await vi.waitFor(() => expect(page.pageInfo()).toBe('Page 1 of 3'));
    releaseReads();
    await settle();
    expect(page.pageInfo()).toBe('Page 1 of 3');
    expect(page.shown()).toEqual(entries.slice(0, 20).map(e => e.content));
  });

  it('a search that answers after the tab reloads shows nothing', async () => {
    const helper = fakeHelper(entriesOf(3, 10));
    const page = await openPage(helper);
    const releaseSearch = hold(helper, 'memorySearch');
    await search(page, 'planning');
    await page.history.loadChatHistory();
    releaseSearch();
    await settle();
    expect(page.shown()).toEqual([]);
    expect(page.d.getElementById('history-empty').textContent).toBe('Use the search bar to find past conversations.');
    expect(page.label()).not.toContain('Search:');
  });

  it('reports a failed read and keeps the page it showed', async () => {
    const entries = entriesOf(40, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    await search(page, 'planning');
    await vi.waitFor(() => expect(page.shown()).toHaveLength(20));

    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg => (msg.cmd === 'memoryRead' ? { error: 'Native helper disconnected' } : answer(msg)));
    page.d.getElementById('history-next-page').click();
    await vi.waitFor(() => expect(page.status()).toContain('Native helper disconnected'));
    expect(page.pageInfo()).toBe('Page 1 of 2');
    expect(page.shown()).toEqual(entries.slice(0, 20).map(e => e.content));
  });
});

describe('TB-193: Chat History "delete old" and the native-messaging cap', () => {
  async function deleteOlderThan(page, days) {
    page.d.getElementById('delete-old-history').click();
    page.d.getElementById('delete-days-input').value = String(days);
    page.d.getElementById('modal-confirm').click();
    await vi.waitFor(() => expect(page.status()).toMatch(/^Deleted /));
  }

  it('removes every entry older than the cutoff, past the newest 500, with every reply under the cap', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    // 200 newer than 30 days, then 1300 older; 4 KB each, so 500 whole are about 2 MB.
    const newer = entriesOf(200, 4000, now - 60_000).map((e, i) => ({ ...e, memId: `new${i}` }));
    const older = entriesOf(1300, 4000, now - 30 * DAY_MS - 1).map((e, i) => ({ ...e, memId: `old${i}` }));
    // The entry at the cutoff's millisecond stays: "older than" excludes it.
    const atCutoff = { ...newer[0], memId: 'cutoff', dateMs: now - 30 * DAY_MS };
    const helper = fakeHelper([...newer, atCutoff, ...older]);
    const page = await openPage(helper);

    await deleteOlderThan(page, 30);
    expect(helper.stored.map(e => e.memId).sort()).toEqual([...newer.map(e => e.memId), 'cutoff'].sort());
    expect(page.status()).toContain('1300 search entries');
    expect(helper.replies.overCap).toBe(0);
  });

  it('removes entries sharing one millisecond across a page boundary once each, and ends', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const tieMs = now - 40 * DAY_MS;
    const older = [
      ...entriesOf(498, 10, now - 31 * DAY_MS),
      ...Array.from({ length: 700 }, (_, i) => ({ memId: `tie${i}`, sessionId: 's', role: 'exchange', content: 'x', dateMs: tieMs })),
      ...entriesOf(300, 10, tieMs - 1).map((e, i) => ({ ...e, memId: `last${i}` })),
    ];
    for (const removes of [true, false]) {
      const helper = fakeHelper(older, { removes });
      const page = await openPage(helper);
      await deleteOlderThan(page, 30);
      const asked = helper.replies.calls.filter(m => m.cmd === 'memoryRemoveBatch').flatMap(m => m.ids);
      // Every old entry asked for removal exactly once, even when the helper removes nothing.
      expect(asked).toHaveLength(older.length);
      expect(new Set(asked).size).toBe(older.length);
      expect(helper.stored).toHaveLength(removes ? 0 : older.length);
      // The count is what the helper says it removed.
      expect(page.status()).toContain(`${removes ? older.length : 0} search entries`);
    }
  });

  it('stops at a failed request and says how many it removed', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const older = entriesOf(1200, 10, now - 31 * DAY_MS);
    const helper = fakeHelper(older);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    let searches = 0;
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === 'memorySearch' && msg.q === '' && ++searches === 2) return { error: 'Native helper disconnected' };
      return answer(msg);
    });

    await deleteOlderThan(page, 30);
    expect(page.status()).toContain('500 search entries');
    expect(helper.stored).toHaveLength(700);
  });

  it('stops at a failed removal and does not count it', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const older = entriesOf(1200, 10, now - 31 * DAY_MS);
    const helper = fakeHelper(older);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    let removals = 0;
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === 'memoryRemoveBatch' && ++removals === 2) return { error: 'Native RPC timed out' };
      return answer(msg);
    });

    await deleteOlderThan(page, 30);
    expect(page.status()).toContain('500 search entries');
    expect(removals).toBe(2);
    expect(helper.stored).toHaveLength(700);
  });
});
