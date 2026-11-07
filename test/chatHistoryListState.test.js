/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #153 and #154: what the Chat History list says comes from the latest search
// or listing asked. Listings, searches and removals run one at a time, in the
// order asked, each waiting for the one before it to end. The list never says
// memory keeps or matches nothing when no answer said so (removing every entry
// shown says what was done). The page is the real one, against a fake memory
// helper; any request can be held.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/persistentChatStore.js', () => ({ clearAllThinking: vi.fn() }));
vi.mock('../fts/nativeEngine.js', () => ({
  nativeMemorySearch: { indexBatch: rows => globalThis.browser.runtime.sendMessage({ type: 'fts', cmd: 'memoryIndexBatch', rows }) },
}));

afterEach(() => {
  delete globalThis.browser;
  delete globalThis.document;
  delete globalThis.Option;
});

const NONE_KEPT = 'No conversations kept yet.';

// Entries about `word`, a minute apart, newest first.
function entriesOf(count, word = 'planning', newestMs = Date.now() - 60_000) {
  return Array.from({ length: count }, (_, i) => ({
    memId: `${word}${i}`,
    sessionId: 'persistent_chat',
    role: 'exchange',
    content: `[USER]: ${word} request ${i}\n\n[AGENT]: ${word} reply END ${i}`,
    dateMs: newestMs - i * 60_000,
  }));
}

// Memory as the helper answers it. `hold(msg)` returns `{ until }` to wait on
// before answering, or nothing. The answer is read when the request is asked,
// or when it is let go with `atRelease`, or given by `reply`.
function fakeHelper(entries) {
  const stored = [...entries];
  let hold = () => null;
  const answer = msg => {
    switch (msg.cmd) {
      case 'memoryStats':
        return { docs: stored.length, usedBytes: 1, dbBytes: 1 };
      case 'memorySearch': {
        const words = String(msg.q).toLowerCase().split(/\s+/).filter(Boolean);
        return stored
          .filter(e => words.length === 0 || words.some(w => e.content.toLowerCase().includes(w)))
          .sort((a, b) => b.dateMs - a.dateMs)
          .slice(0, msg.limit)
          .map(e => ({ ...e, snippet: words.length ? e.content : null, rank: 0 }));
      }
      case 'memoryRemoveBatch': {
        let count = 0;
        for (const id of msg.ids) {
          const at = stored.findIndex(e => e.memId === id);
          if (at >= 0) { stored.splice(at, 1); count += 1; }
        }
        return { ok: true, count };
      }
      case 'memoryClear':
        stored.splice(0);
        return { ok: true };
      default:
        throw new Error(`unexpected helper command: ${msg.cmd}`);
    }
  };
  const sendMessage = vi.fn(async msg => {
    const held = hold(msg);
    if (held) {
      const reply = typeof held.reply === 'function' ? held.reply(msg) : held.atRelease ? null : answer(msg);
      await held.until;
      if (held.atRelease) return answer(msg);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    return answer(msg);
  });
  return { stored, sendMessage, holdWith: fn => { hold = fn; } };
}

// A promise and the function that settles it.
function gate() {
  let open;
  const until = new Promise(r => { open = r; });
  return { until, open };
}

async function openPage(helper, { awaitListing = true } = {}) {
  vi.resetModules();
  const dom = new JSDOM(readFileSync(resolve('prompts/prompts.html'), 'utf8'));
  globalThis.document = dom.window.document;
  globalThis.Option = dom.window.Option;
  globalThis.browser = {
    storage: { onChanged: { addListener() {} }, local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
    runtime: { sendMessage: helper.sendMessage },
  };
  const history = await import('../prompts/modules/history.js');
  const listing = history.loadChatHistory();
  history.initHistoryHandlers();
  if (awaitListing) await listing;
  const d = dom.window.document;
  return {
    d, window: dom.window, history, listing,
    shown: () => [...d.querySelectorAll('#history-list .history-search-result-request')].map(el => el.textContent),
    list: () => d.getElementById('history-list').textContent.trim(),
    empty: () => {
      const el = d.getElementById('history-empty');
      return el.style.display === 'block' ? el.textContent : null;
    },
    stats: () => d.getElementById('history-stats').textContent.replace(/\s+/g, ' ').trim(),
    status: () => d.getElementById('status-message').textContent,
    query: () => d.getElementById('history-search-input').value,
    pageInfo: () => d.getElementById('history-page-info').textContent,
    removeButton: i => d.querySelectorAll('#history-list .history-remove-btn')[i],
  };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
};
const sent = (helper, test) => helper.sendMessage.mock.calls.filter(([msg]) => test(msg)).length;
const isListing = msg => msg.cmd === 'memorySearch' && msg.q === '';
const requestOf = (word, i) => `${word} request ${i}`;

describe('Chat History says none is kept or found only when an answer said so', () => {
  it.each([
    ['answers an error', () => ({ error: 'helper busy' }), 'Search failed: helper busy'],
    ['is rejected', () => new Error('helper disconnected'), 'Search failed: Error: helper disconnected'],
    ['gets no reply', () => undefined, 'Search failed: no reply from the search helper'],
    ['gets a reply that is not a list', () => ({ ok: true }), 'Search failed: no reply from the search helper'],
  ])('a search that %s, asked while the listing on open is pending, waits for it, then is said with the listing still shown', async (_how, reply, said) => {
    const helper = fakeHelper(entriesOf(3));
    const listing = gate();
    helper.holdWith(msg => (isListing(msg) ? { until: listing.until } : msg.cmd === 'memorySearch' ? { until: null, reply } : null));
    const page = await openPage(helper, { awaitListing: false });
    const searching = page.history.searchChatHistory('planning');
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memorySearch' && msg.q === 'planning')).toBe(0);
    expect(page.list()).toBe('Loading chat history...');
    listing.open();
    await page.listing;
    await searching;
    expect(page.status()).toBe(said);
    expect(page.shown()).toEqual([0, 1, 2].map(i => requestOf('planning', i)));
    expect(page.empty()).toBeNull();
    expect(page.stats()).toContain('Searchable entries: 3');
    expect(page.stats()).not.toContain('Search:');
  });

  // A failed search changes nothing shown: the next render (here a removal's)
  // still shows the listing, on the page it was on, with no search in the stats.
  it.each([
    ['answers an error', () => ({ error: 'helper busy' })],
    ['is rejected', () => new Error('helper disconnected')],
    ['gets no reply', () => undefined],
    ['gets a reply that is not a list', () => ({ ok: true })],
  ])('a search that %s while page 2 of the listing is shown leaves that page and no search after a removal', async (_how, reply) => {
    const helper = fakeHelper(entriesOf(25));
    const page = await openPage(helper);
    page.d.getElementById('history-next-page').click();
    expect(page.pageInfo()).toBe('Page 2 of 2');
    helper.holdWith(msg => (msg.cmd === 'memorySearch' && msg.q === 'harbour' ? { until: null, reply } : null));
    await page.history.searchChatHistory('harbour');
    expect(page.status()).toMatch(/^Search failed: /);
    page.removeButton(0).click();
    await settle();
    expect(page.pageInfo()).toBe('Page 2 of 2');
    expect(page.shown()).toEqual([21, 22, 23, 24].map(i => requestOf('planning', i)));
    expect(page.stats()).toContain('Searchable entries: 24');
    expect(page.stats()).not.toContain('Search:');
  });

  it('a search asked while the listing on open is pending waits for it, then shows its results', async () => {
    const helper = fakeHelper([...entriesOf(1, 'budget'), ...entriesOf(2)]);
    const listing = gate();
    helper.holdWith(msg => (isListing(msg) ? { until: listing.until } : null));
    const page = await openPage(helper, { awaitListing: false });
    const searching = page.history.searchChatHistory('budget');
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memorySearch' && msg.q === 'budget')).toBe(0);
    expect(page.list()).toBe('Loading chat history...');
    listing.open();
    await searching;
    expect(page.shown()).toEqual([requestOf('budget', 0)]);
    expect(page.stats()).toContain('Search: "budget" (1 results)');
  });

  it('an older search helper refusing both the listing and a quick search says why in the list', async () => {
    const refusal = { error: 'Chat memory search needs a newer search helper.' };
    const helper = fakeHelper(entriesOf(3));
    const listing = gate();
    helper.holdWith(msg => (isListing(msg) ? { until: listing.until, reply: () => refusal } : msg.cmd === 'memorySearch' ? { until: null, reply: () => refusal } : null));
    const page = await openPage(helper, { awaitListing: false });
    const searching = page.history.searchChatHistory('planning');
    listing.open();
    await searching;
    expect(page.empty()).toBe("Couldn't list past conversations: Chat memory search needs a newer search helper.");
    expect(page.status()).toBe('Search failed: Chat memory search needs a newer search helper.');
    expect(page.empty()).not.toBe(NONE_KEPT);
  });

  it('two listings asked on open run one after the other, never say none is kept, and show the entries', async () => {
    const helper = fakeHelper(entriesOf(3));
    const gates = [gate(), gate()];
    const [first, second] = gates;
    let listings = 0;
    helper.holdWith(msg => (isListing(msg) && listings < gates.length ? { until: gates[listings++].until } : null));
    const page = await openPage(helper, { awaitListing: false });
    await vi.waitFor(() => expect(sent(helper, isListing)).toBe(1));
    const refresh = page.history.loadChatHistory();
    await settle();
    expect(sent(helper, isListing)).toBe(1);
    expect(page.list()).toBe('Loading chat history...');
    first.open();
    await page.listing;
    await vi.waitFor(() => expect(sent(helper, isListing)).toBe(2));
    expect(page.empty()).toBeNull();
    expect(page.shown()).toEqual([0, 1, 2].map(i => requestOf('planning', i)));
    second.open();
    await refresh;
    expect(page.empty()).toBeNull();
    expect(page.shown()).toEqual([0, 1, 2].map(i => requestOf('planning', i)));
  });

  it('removing every entry the newest list shows says so without listing again, and listing again shows what memory still holds', async () => {
    const helper = fakeHelper(entriesOf(101));
    const page = await openPage(helper);
    expect(page.stats()).toContain('Searchable entries: 101');
    expect(page.pageInfo()).toBe('Page 1 of 5');
    // Every shown entry's Remove pressed, page by page, then all answered.
    const removals = gate();
    helper.holdWith(msg => (msg.cmd === 'memoryRemoveBatch' ? { until: removals.until, atRelease: true } : null));
    for (let p = 0; p < 5; p++) {
      const onPage = page.d.querySelectorAll('#history-list .history-remove-btn').length;
      for (let i = 0; i < onPage; i++) page.removeButton(i).click();
      page.history.nextPage();
    }
    // Removals run one at a time: one is sent, the rest wait in line, each saying so.
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memoryRemoveBatch')).toBe(1);
    expect([...page.d.querySelectorAll('#history-list .history-remove-btn')].map(b => b.textContent)).toEqual(Array(20).fill('Removing…'));
    const listings = sent(helper, isListing);
    removals.open();
    await vi.waitFor(() => expect(sent(helper, msg => msg.cmd === 'memoryRemoveBatch')).toBe(100));
    await vi.waitFor(() => expect(page.stats()).toContain('Searchable entries: 1'));
    await settle();
    expect(helper.stored.map(e => e.memId)).toEqual(['planning100']);
    expect(page.shown()).toEqual([]);
    expect(page.empty()).toBe('Removed every conversation shown.');
    expect(sent(helper, isListing)).toBe(listings);
    await page.history.loadChatHistory();
    expect(page.empty()).toBeNull();
    expect(page.shown()).toEqual([requestOf('planning', 100)]);
  });

  it('a removal that empties the listing while a later search is pending lists nothing over that search', async () => {
    const helper = fakeHelper([...entriesOf(1), ...entriesOf(1, 'budget', Date.now() - 3_600_000)]);
    const page = await openPage(helper);
    // The listing shows the one planning entry: the budget one is removed first.
    page.removeButton(1).click();
    await settle();
    expect(page.shown()).toEqual([requestOf('planning', 0)]);
    helper.stored.push(...entriesOf(1, 'budget', Date.now() - 3_600_000));
    const removal = gate();
    const search = gate();
    helper.holdWith(msg => (msg.cmd === 'memoryRemoveBatch' ? { until: removal.until, atRelease: true } : msg.cmd === 'memorySearch' && msg.q === 'budget' ? { until: search.until } : null));
    const input = page.d.getElementById('history-search-input');
    page.removeButton(0).click();
    await settle();
    input.value = 'budget';
    const searching = page.history.searchChatHistory('budget');
    const listings = sent(helper, isListing);
    removal.open();
    await settle();
    expect(sent(helper, isListing)).toBe(listings);
    expect(input.value).toBe('budget');
    search.open();
    await searching;
    await settle();
    expect(page.shown()).toEqual([requestOf('budget', 0)]);
    expect(page.stats()).toContain('Search: "budget" (1 results)');
  });

  it('of two searches the later waits for the earlier; an earlier failure is said, and the later shows', async () => {
    const helper = fakeHelper([...entriesOf(1, 'budget'), ...entriesOf(2)]);
    const page = await openPage(helper);
    const earlier = gate();
    helper.holdWith(msg => (msg.cmd === 'memorySearch' && msg.q === 'planning' ? { until: earlier.until, reply: () => new Error('helper disconnected') } : null));
    const first = page.history.searchChatHistory('planning');
    const second = page.history.searchChatHistory('budget');
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memorySearch' && msg.q === 'budget')).toBe(0);
    earlier.open();
    await first;
    expect(page.status()).toBe('Search failed: Error: helper disconnected');
    await second;
    expect(page.shown()).toEqual([requestOf('budget', 0)]);
    expect(page.stats()).toContain('Search: "budget" (1 results)');
  });

  it('of two searches the earlier, answering late, never shows over the later', async () => {
    const helper = fakeHelper([...entriesOf(1, 'budget'), ...entriesOf(2)]);
    const page = await openPage(helper);
    const earlier = gate();
    helper.holdWith(msg => (msg.cmd === 'memorySearch' && msg.q === 'planning' ? { until: earlier.until } : null));
    const first = page.history.searchChatHistory('planning');
    const second = page.history.searchChatHistory('budget');
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memorySearch' && msg.q === 'budget')).toBe(0);
    earlier.open();
    await first;
    expect(page.stats()).toContain('Search: "planning" (2 results)');
    await second;
    await settle();
    expect(page.shown()).toEqual([requestOf('budget', 0)]);
    expect(page.stats()).toContain('Search: "budget" (1 results)');
  });

  it('removing the only entry kept says what was done; a listing then says none is kept, from its answer', async () => {
    const helper = fakeHelper(entriesOf(1));
    const page = await openPage(helper);
    const listings = sent(helper, isListing);
    page.removeButton(0).click();
    await settle();
    expect(page.empty()).toBe('Removed every conversation shown.');
    expect(sent(helper, isListing)).toBe(listings);
    await page.history.loadChatHistory();
    expect(page.empty()).toBe(NONE_KEPT);
  });

  it('removing every result of a search keeps the search, saying what was done, not that none is found', async () => {
    const helper = fakeHelper([...entriesOf(1, 'budget'), ...entriesOf(2)]);
    const page = await openPage(helper);
    await page.history.searchChatHistory('budget');
    const listings = sent(helper, isListing);
    page.removeButton(0).click();
    await settle();
    expect(page.empty()).toBe('Removed every conversation shown.');
    expect(page.stats()).toContain('Search: "budget" (0 results)');
    expect(sent(helper, isListing)).toBe(listings);
  });

  it('removing every result of a search that reached the result cap never says none is found while memory holds more', async () => {
    const helper = fakeHelper(entriesOf(101, 'budget'));
    const page = await openPage(helper);
    await page.history.searchChatHistory('budget');
    expect(page.stats()).toContain('Search: "budget" (100 results)');
    const removals = gate();
    helper.holdWith(msg => (msg.cmd === 'memoryRemoveBatch' ? { until: removals.until, atRelease: true } : null));
    for (let p = 0; p < 5; p++) {
      const onPage = page.d.querySelectorAll('#history-list .history-remove-btn').length;
      for (let i = 0; i < onPage; i++) page.removeButton(i).click();
      page.history.nextPage();
    }
    // Removals run one at a time: one is sent, the rest wait in line, each saying so.
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memoryRemoveBatch')).toBe(1);
    expect([...page.d.querySelectorAll('#history-list .history-remove-btn')].map(b => b.textContent)).toEqual(Array(20).fill('Removing…'));
    removals.open();
    await vi.waitFor(() => expect(sent(helper, msg => msg.cmd === 'memoryRemoveBatch')).toBe(100));
    await vi.waitFor(() => expect(page.stats()).toContain('Searchable entries: 1'));
    await settle();
    helper.holdWith(() => null);
    expect(helper.stored.map(e => e.memId)).toEqual(['budget100']);
    expect(page.empty()).toBe('Removed every conversation shown.');
    await page.history.searchChatHistory('budget');
    expect(page.shown()).toEqual([requestOf('budget', 100)]);
  });

  it('a search with no match says none is found, from its answer', async () => {
    const helper = fakeHelper(entriesOf(2));
    const page = await openPage(helper);
    await page.history.searchChatHistory('budget');
    expect(page.empty()).toBe('No results found for "budget".');
  });

  it('after a search failed over the entries shown, removing them all says what was done, not the failure, and lists nothing', async () => {
    const helper = fakeHelper(entriesOf(2));
    const page = await openPage(helper);
    helper.holdWith(msg => (msg.cmd === 'memorySearch' && msg.q === 'budget' ? { until: null, reply: () => ({ error: 'helper busy' }) } : null));
    await page.history.searchChatHistory('budget');
    expect(page.status()).toBe('Search failed: helper busy');
    helper.holdWith(() => null);
    const listings = sent(helper, isListing);
    page.removeButton(0).click();
    await settle();
    page.removeButton(0).click();
    await settle();
    expect(page.shown()).toEqual([]);
    expect(page.empty()).toBe('Removed every conversation shown.');
    expect(sent(helper, isListing)).toBe(listings);
  });

  it.each([
    ['typed before the removal', 'before'],
    ['typed while the removal is pending', 'removal'],
    ['typed while the stats read after it is pending', 'stats'],
  ])('words %s in the search box stay when removals empty the list', async (_label, when) => {
    const helper = fakeHelper(entriesOf(1));
    const page = await openPage(helper);
    const input = page.d.getElementById('history-search-input');
    const type = () => { input.value = 'bud'; input.dispatchEvent(new page.window.Event('input')); };
    const held = gate();
    let removed = false;
    helper.holdWith(msg => {
      if (msg.cmd === 'memoryRemoveBatch') { removed = true; return when === 'removal' ? { until: held.until, atRelease: true } : null; }
      return when === 'stats' && removed && msg.cmd === 'memoryStats' ? { until: held.until, atRelease: true } : null;
    });
    if (when === 'before') type();
    page.removeButton(0).click();
    await settle();
    if (when !== 'before') { type(); held.open(); await settle(); }
    expect(helper.stored).toEqual([]);
    expect(page.empty()).toBe('Removed every conversation shown.');
    expect(input.value).toBe('bud');
  });

  it('a removal that fails does not list again', async () => {
    const helper = fakeHelper(entriesOf(1));
    const page = await openPage(helper);
    helper.holdWith(msg => (msg.cmd === 'memoryRemoveBatch' ? { until: null, reply: () => ({ error: 'locked' }) } : null));
    const listings = sent(helper, isListing);
    page.removeButton(0).click();
    await settle();
    expect(page.shown()).toEqual([requestOf('planning', 0)]);
    expect(sent(helper, isListing)).toBe(listings);
  });
});

describe('Chat History keeps the latest answer and the pending state across requests', () => {
  it('a search emptied by a removal asked while it was pending never claims it found none', async () => {
    const helper = fakeHelper([...entriesOf(1, 'budget'), ...entriesOf(1)]);
    const page = await openPage(helper);
    const held = gate();
    helper.holdWith(msg => (msg.cmd === 'memorySearch' && msg.q === 'budget' ? { until: held.until } : null));
    const searching = page.history.searchChatHistory('budget');
    await settle();
    page.removeButton(0).click();
    await settle();
    // The removal waits in line behind the search.
    expect(sent(helper, msg => msg.cmd === 'memoryRemoveBatch')).toBe(0);
    expect(helper.stored.map(e => e.memId)).toEqual(['budget0', 'planning0']);
    held.open();
    await searching;
    await vi.waitFor(() => expect(helper.stored.map(e => e.memId)).toEqual(['planning0']));
    await settle();
    expect(page.shown()).toEqual([]);
    expect(page.empty()).toBe('Removed every conversation shown.');
  });

  it('a removal pending while a search hides its entry keeps it out of the listing asked after it', async () => {
    const helper = fakeHelper([...entriesOf(1), ...entriesOf(1, 'budget', Date.now() - 3_600_000)]);
    const page = await openPage(helper);
    expect(page.shown()).toEqual([requestOf('planning', 0), requestOf('budget', 0)]);
    const removal = gate();
    const listing = gate();
    helper.holdWith(msg => (msg.cmd === 'memoryRemoveBatch' ? { until: removal.until, atRelease: true } : isListing(msg) ? { until: listing.until } : null));
    page.removeButton(0).click();
    await settle();
    const searching = page.history.searchChatHistory('budget');
    const relist = page.history.loadChatHistory();
    await settle();
    // Both wait in line behind the pending removal.
    expect(sent(helper, msg => msg.cmd === 'memorySearch')).toBe(1);
    removal.open();
    await searching;
    expect(helper.stored.map(e => e.memId)).toEqual(['budget0']);
    expect(page.shown()).toEqual([requestOf('budget', 0)]);
    listing.open();
    await relist;
    await settle();
    expect(page.shown()).toEqual([requestOf('budget', 0)]);
    expect(page.stats()).not.toContain('Search:');
  });

  it('a listing asked while a search is pending waits for it, then shows as a listing, also once it renders again', async () => {
    const helper = fakeHelper([...entriesOf(2), ...entriesOf(1, 'budget', Date.now() - 3_600_000)]);
    const page = await openPage(helper);
    const held = gate();
    helper.holdWith(msg => (msg.cmd === 'memorySearch' && msg.q === 'budget' ? { until: held.until } : null));
    const searching = page.history.searchChatHistory('budget');
    await settle();
    const relist = page.history.loadChatHistory();
    await settle();
    expect(sent(helper, isListing)).toBe(1);
    held.open();
    await searching;
    await relist;
    page.removeButton(0).click();
    await settle();
    expect(page.shown()).toEqual([requestOf('planning', 1), requestOf('budget', 0)]);
    expect(page.d.querySelector('#history-list .history-section-header').textContent).toBe('Newest Conversations');
    expect(page.stats()).not.toContain('Search:');
  });

  it('a search asked while a listing is pending shows once the listing ends, and keeps the page it is turned to', async () => {
    const helper = fakeHelper(entriesOf(45));
    const page = await openPage(helper);
    const held = gate();
    helper.holdWith(msg => (isListing(msg) ? { until: held.until } : null));
    const reload = page.history.loadChatHistory();
    await settle();
    const searching = page.history.searchChatHistory('planning');
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memorySearch' && msg.q === 'planning')).toBe(0);
    held.open();
    await reload;
    await searching;
    expect(page.stats()).toContain('Search: "planning" (45 results)');
    page.history.nextPage();
    page.history.nextPage();
    expect(page.pageInfo()).toBe('Page 3 of 3');
    await settle();
    expect(page.pageInfo()).toBe('Page 3 of 3');
  });

  it('a listing whose turns count cannot be read still shows what memory now holds', async () => {
    const helper = fakeHelper(entriesOf(2));
    const page = await openPage(helper);
    expect(page.shown()).toEqual([0, 1].map(i => requestOf('planning', i)));
    helper.stored.splice(0, helper.stored.length, ...entriesOf(1, 'budget'));
    globalThis.browser.storage.local.get.mockImplementation(async key => {
      if (key === 'chat_turns') throw new Error('turn count unavailable');
      return {};
    });
    await page.history.loadChatHistory();
    expect(page.shown()).toEqual([requestOf('budget', 0)]);
    expect(page.stats()).toContain('Active turns: 0');
    expect(page.empty()).toBeNull();
  });

  it('a listing shows the turns and memory size it read, and resets them when a later read fails', async () => {
    const helper = fakeHelper(entriesOf(2));
    const page = await openPage(helper);
    const usage = () => page.d.getElementById('history-usage-label').textContent;
    globalThis.browser.storage.local.get.mockImplementation(async key => (
      key === 'chat_turns' ? { chat_turns: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] } : {}
    ));
    await page.history.loadChatHistory();
    expect(page.stats()).toContain('Active turns: 2');
    expect(usage()).toMatch(/^Memory used: \d/);
    globalThis.browser.storage.local.get.mockImplementation(async key => {
      if (key === 'chat_turns') throw new Error('turn count unavailable');
      return {};
    });
    helper.holdWith(msg => (msg.cmd === 'memoryStats' ? { until: null, reply: () => new Error('stats unavailable') } : null));
    await page.history.loadChatHistory();
    expect(page.stats()).toContain('Active turns: 0');
    expect(usage()).toMatch(/^Memory used: unavailable/);
    expect(page.shown()).toEqual([0, 1].map(i => requestOf('planning', i)));
  });

  it('a Remove press whose first render throws still ends pending once its turn ends', async () => {
    const helper = fakeHelper(entriesOf(2));
    const page = await openPage(helper);
    const removal = gate();
    helper.holdWith(msg => (msg.cmd === 'memoryRemoveBatch' ? { until: removal.until, reply: () => ({ error: 'locked' }) } : null));
    const button = page.removeButton(1);
    // The stats bar is gone: the render the press makes throws.
    const bar = page.d.getElementById('history-stats');
    bar.remove();
    button.click();
    page.d.getElementById('history-list').before(bar);
    removal.open();
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memoryRemoveBatch')).toBe(1);
    await page.history.loadChatHistory();
    expect(page.shown()).toEqual([0, 1].map(i => requestOf('planning', i)));
    expect(page.removeButton(1).textContent).toBe('Remove');
    expect(page.removeButton(1).disabled).toBe(false);
  });

  it('a listing that fails after entries were shown says why in the list', async () => {
    const helper = fakeHelper(entriesOf(2));
    const page = await openPage(helper);
    expect(page.shown()).toEqual([requestOf('planning', 0), requestOf('planning', 1)]);
    helper.holdWith(msg => (isListing(msg) ? { until: null, reply: () => ({ error: 'helper busy' }) } : null));
    await page.history.loadChatHistory();
    expect(page.shown()).toEqual([]);
    expect(page.empty()).toBe("Couldn't list past conversations: helper busy");
  });

  it('an entry with no date is named by its Remove button as undated', async () => {
    const helper = fakeHelper([{ ...entriesOf(1)[0], dateMs: 0 }]);
    const page = await openPage(helper);
    expect(page.removeButton(0).getAttribute('aria-label')).toBe('Remove the conversation from Unknown date');
  });

  it('a listing emptied by a removal asked while it was pending never claims memory answered with none', async () => {
    const helper = fakeHelper(entriesOf(1));
    const page = await openPage(helper);
    const held = gate();
    helper.holdWith(msg => isListing(msg) ? { until: held.until } : null);
    const pending = page.history.loadChatHistory();
    await vi.waitFor(() => expect(sent(helper, isListing)).toBe(2));
    helper.stored.push(...entriesOf(1, 'budget'));
    page.removeButton(0).click();
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memoryRemoveBatch')).toBe(0);
    held.open();
    await pending;
    await vi.waitFor(() => expect(helper.stored.map(e => e.memId)).toEqual(['budget0']));
    await settle();
    expect(page.shown()).toEqual([]);
    expect(page.stats()).toContain('Searchable entries: 1');
    expect(page.empty()).toBe('Removed every conversation shown.');
    expect(page.empty()).not.toBe(NONE_KEPT);
  });

  it('of two listings with a removal asked between them, neither brings back the removed entry', async () => {
    const helper = fakeHelper(entriesOf(3));
    const page = await openPage(helper);
    const older = gate();
    let held = false;
    // Answered as memory stood when asked: with the entry.
    helper.holdWith(msg => {
      if (!isListing(msg) || held) return null;
      held = true;
      return { until: older.until };
    });
    const olderListing = page.history.loadChatHistory();
    await vi.waitFor(() => expect(sent(helper, isListing)).toBe(2));
    page.removeButton(0).click();
    await settle();
    const later = page.history.loadChatHistory();
    await settle();
    // The removal and the later listing wait in line behind the older listing.
    expect(sent(helper, msg => msg.cmd === 'memoryRemoveBatch')).toBe(0);
    expect(sent(helper, isListing)).toBe(2);
    older.open();
    await olderListing;
    await later;
    await settle();
    expect(helper.stored.map(e => e.memId)).toEqual(['planning1', 'planning2']);
    expect(page.shown()).toEqual([1, 2].map(i => requestOf('planning', i)));
  });

  it('a removal pending while a later search waits behind it still says so, and a second press sends nothing', async () => {
    const helper = fakeHelper(entriesOf(3));
    const page = await openPage(helper);
    const removal = gate();
    helper.holdWith(msg => (msg.cmd === 'memoryRemoveBatch' ? { until: removal.until, atRelease: true } : null));
    page.removeButton(0).click();
    await settle();
    const state = () => [page.removeButton(0).textContent, page.removeButton(0).disabled];
    expect(state()).toEqual(['Removing…', true]);
    const searching = page.history.searchChatHistory('planning');
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memorySearch' && msg.q === 'planning')).toBe(0);
    expect(state()).toEqual(['Removing…', true]);
    page.removeButton(0).click();
    await settle();
    removal.open();
    await searching;
    expect(sent(helper, msg => msg.cmd === 'memoryRemoveBatch')).toBe(1);
    expect(page.shown()).toEqual([1, 2].map(i => requestOf('planning', i)));
    expect(page.stats()).toContain('Search: "planning" (2 results)');
  });

  it('once the newest entries are listed again, clearing a box typed into sends nothing', async () => {
    const helper = fakeHelper(entriesOf(3));
    const page = await openPage(helper);
    const input = page.d.getElementById('history-search-input');
    const type = async text => {
      input.value = text;
      input.dispatchEvent(new page.window.Event('input'));
      await settle();
    };
    await page.history.searchChatHistory('planning');
    await page.history.loadChatHistory();
    const before = sent(helper, msg => msg.cmd === 'memorySearch');
    await type('x');
    await type('');
    expect(sent(helper, msg => msg.cmd === 'memorySearch')).toBe(before);
  });

  it('listing the newest entries again opens on the first page', async () => {
    const helper = fakeHelper(entriesOf(50));
    const page = await openPage(helper);
    page.history.nextPage();
    page.history.nextPage();
    expect(page.pageInfo()).toBe('Page 3 of 3');
    await page.history.loadChatHistory();
    expect(page.pageInfo()).toBe('Page 1 of 3');
  });

  it('a search with no match after a failed listing says no results, not the listing failure', async () => {
    const helper = fakeHelper(entriesOf(3));
    helper.holdWith(msg => (isListing(msg) ? { until: null, reply: () => ({ error: 'helper busy' }) } : null));
    const page = await openPage(helper);
    expect(page.empty()).toBe("Couldn't list past conversations: helper busy");
    await page.history.searchChatHistory('nomatchword');
    expect(page.empty()).toBe('No results found for "nomatchword".');
  });

  it('a listing that answers after a failed one says what memory holds, not the old failure', async () => {
    const helper = fakeHelper([]);
    helper.holdWith(msg => (isListing(msg) ? { until: null, reply: () => ({ error: 'helper busy' }) } : null));
    const page = await openPage(helper);
    expect(page.empty()).toBe("Couldn't list past conversations: helper busy");
    helper.holdWith(() => null);
    await page.history.loadChatHistory();
    expect(page.empty()).toBe(NONE_KEPT);
  });
});

describe('Chat History shows a listing as text and keeps what was typed after it', () => {
  it('a listing shows markup in a request and reply as that text', async () => {
    const request = 'Literal <img src=x onerror="globalThis.__historyInjected=1"> & "request"';
    const reply = 'Literal <b data-extra="unexpected">reply</b> & <a href="https://example.com/">link</a>';
    const helper = fakeHelper([{ ...entriesOf(1)[0], content: `[USER]: ${request}\n\n[AGENT]: ${reply}` }]);
    const page = await openPage(helper);
    expect(page.d.querySelector('#history-list .history-section-header').textContent).toBe('Newest Conversations');
    expect(page.shown()).toEqual([request]);
    expect(page.d.querySelector('.history-search-result-reply').textContent).toBe(reply);
    expect(page.d.querySelectorAll('#history-list img, #history-list b, #history-list a, #history-list [onerror], #history-list .search-highlight')).toHaveLength(0);
    expect(helper.stored[0].content).toBe(`[USER]: ${request}\n\n[AGENT]: ${reply}`);
  });

  it.each([false, true])('a listing answering after words were typed keeps them (searched: %s)', async submitted => {
    const helper = fakeHelper([...entriesOf(1), ...entriesOf(1, 'budget')]);
    const page = await openPage(helper);
    const held = gate();
    helper.holdWith(msg => isListing(msg) ? { until: held.until } : null);
    const reload = page.history.loadChatHistory();
    await vi.waitFor(() => expect(sent(helper, isListing)).toBe(2));
    const input = page.d.getElementById('history-search-input');
    input.value = 'budget';
    input.dispatchEvent(new page.window.Event('input'));
    const searching = submitted ? page.history.searchChatHistory(input.value) : null;
    held.open();
    await reload;
    await searching;
    await settle();
    expect(input.value).toBe('budget');
    if (submitted) {
      expect(page.shown()).toEqual([requestOf('budget', 0)]);
      expect(page.stats()).toContain('Search: "budget" (1 results)');
    } else {
      expect(page.shown()).toEqual([requestOf('planning', 0), requestOf('budget', 0)]);
    }
  });
});

describe('Chat History runs listings, searches and removals one at a time, in the order asked', () => {
  it('a listing, a search and a removal asked together are each sent only once the one before has answered', async () => {
    const helper = fakeHelper(entriesOf(3));
    const page = await openPage(helper);
    const gates = { listing: gate(), search: gate(), removal: gate() };
    const kindOf = msg => (isListing(msg) ? 'listing' : msg.cmd === 'memorySearch' ? 'search' : msg.cmd === 'memoryRemoveBatch' ? 'removal' : null);
    const order = [];
    helper.holdWith(msg => {
      const kind = kindOf(msg);
      if (!kind) return null;
      order.push(kind);
      return { until: gates[kind].until, atRelease: true };
    });
    page.removeButton(0).click();
    const listing = page.history.loadChatHistory();
    const searching = page.history.searchChatHistory('planning');
    await settle();
    expect(order).toEqual(['removal']);
    gates.removal.open();
    await vi.waitFor(() => expect(order).toEqual(['removal', 'listing']));
    await settle();
    expect(order).toEqual(['removal', 'listing']);
    gates.listing.open();
    await listing;
    expect(page.shown()).toEqual([1, 2].map(i => requestOf('planning', i)));
    await vi.waitFor(() => expect(order).toEqual(['removal', 'listing', 'search']));
    gates.search.open();
    await searching;
    expect(page.stats()).toContain('Search: "planning" (2 results)');
  });

  it('a search asked while a removal reads the stats again waits for that read', async () => {
    const helper = fakeHelper(entriesOf(3));
    const page = await openPage(helper);
    const stats = gate();
    let removed = false;
    helper.holdWith(msg => {
      if (msg.cmd === 'memoryRemoveBatch') { removed = true; return null; }
      return removed && msg.cmd === 'memoryStats' ? { until: stats.until, atRelease: true } : null;
    });
    page.removeButton(0).click();
    await vi.waitFor(() => expect(removed).toBe(true));
    await settle();
    const searching = page.history.searchChatHistory('planning');
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memorySearch' && msg.q === 'planning')).toBe(0);
    stats.open();
    await searching;
    expect(sent(helper, msg => msg.cmd === 'memorySearch' && msg.q === 'planning')).toBe(1);
    expect(page.shown()).toEqual([1, 2].map(i => requestOf('planning', i)));
    expect(page.stats()).toContain('Searchable entries: 2');
  });

  it('a failed removal stays pending until its stats read ends, so a press meanwhile sends nothing', async () => {
    const helper = fakeHelper(entriesOf(2));
    const page = await openPage(helper);
    const stats = gate();
    let failed = false;
    helper.holdWith(msg => {
      if (msg.cmd === 'memoryRemoveBatch') { failed = true; return { until: null, reply: () => ({ error: 'locked' }) }; }
      return failed && msg.cmd === 'memoryStats' ? { until: stats.until, atRelease: true } : null;
    });
    const state = () => [page.removeButton(0).textContent, page.removeButton(0).disabled];
    page.removeButton(0).click();
    await vi.waitFor(() => expect(page.status()).toBe("Couldn't remove the conversation: locked"));
    await settle();
    expect(state()).toEqual(['Removing…', true]);
    page.removeButton(0).click();
    await settle();
    stats.open();
    await settle();
    expect(sent(helper, msg => msg.cmd === 'memoryRemoveBatch')).toBe(1);
    expect(state()).toEqual(['Remove', false]);
    expect(page.shown()).toEqual([0, 1].map(i => requestOf('planning', i)));
  });

  it('a removal whose render throws still ends pending', async () => {
    const helper = fakeHelper(entriesOf(2));
    const page = await openPage(helper);
    const removal = gate();
    helper.holdWith(msg => (msg.cmd === 'memoryRemoveBatch' ? { until: removal.until, reply: () => ({ error: 'locked' }) } : null));
    page.removeButton(1).click();
    await settle();
    // The stats bar is gone: the render after the removal's reply throws.
    const bar = page.d.getElementById('history-stats');
    bar.remove();
    removal.open();
    await settle();
    expect(page.status()).toMatch(/^Chat History removal failed: /);
    page.d.getElementById('history-list').before(bar);
    await page.history.loadChatHistory();
    expect(page.shown()).toEqual([0, 1].map(i => requestOf('planning', i)));
    expect(page.removeButton(1).textContent).toBe('Remove');
    expect(page.removeButton(1).disabled).toBe(false);
  });

  it('a listing that fails unexpectedly says so, and the search asked after it still runs', async () => {
    const helper = fakeHelper(entriesOf(2));
    const page = await openPage(helper);
    // A malformed answer: an entry that is not an entry.
    helper.holdWith(msg => (isListing(msg) ? { until: null, reply: () => [null] } : null));
    const listing = page.history.loadChatHistory();
    const searching = page.history.searchChatHistory('planning');
    await listing;
    expect(page.status()).toMatch(/^Chat History listing failed: /);
    await searching;
    expect(page.shown()).toEqual([0, 1].map(i => requestOf('planning', i)));
    expect(page.stats()).toContain('Search: "planning" (2 results)');
  });
});

describe('Chat History says a listing failed when the size limit cannot be read, and shows nothing it replaced', () => {
  // From the call on, the size-limit read (an object argument) fails; other reads answer.
  const failSizeLimitRead = () => {
    globalThis.browser.storage.local.get = vi.fn(async key => {
      if (key && typeof key === 'object') throw new Error('storage unavailable');
      return {};
    });
  };
  const FAILED = "Couldn't list past conversations: storage unavailable";

  it('after a search, a page change shows none of the search results the listing replaced', async () => {
    const helper = fakeHelper(entriesOf(45));
    const page = await openPage(helper);
    await page.history.searchChatHistory('planning');
    page.history.nextPage();
    expect(page.pageInfo()).toBe('Page 2 of 3');
    failSizeLimitRead();
    await page.history.loadChatHistory();
    expect(page.empty()).toBe(FAILED);
    expect(page.query()).toBe('');
    expect(page.stats()).not.toContain('Search:');
    page.history.nextPage();
    page.history.prevPage();
    expect(page.shown()).toEqual([]);
    expect(page.empty()).toBe(FAILED);
    expect(page.stats()).not.toContain('Search:');
  });

  it('a removal settling after the failed listing shows none of the entries it replaced', async () => {
    const helper = fakeHelper(entriesOf(3));
    const page = await openPage(helper);
    const removal = gate();
    helper.holdWith(msg => (msg.cmd === 'memoryRemoveBatch' ? { until: removal.until, atRelease: true } : null));
    page.removeButton(0).click();
    await settle();
    failSizeLimitRead();
    const listing = page.history.loadChatHistory();
    removal.open();
    await listing;
    await settle();
    expect(helper.stored.map(e => e.memId)).toEqual(['planning1', 'planning2']);
    expect(page.shown()).toEqual([]);
    expect(page.empty()).toBe(FAILED);
  });

  it('a removal asked before the failed listing and settling after it shows none of the entries either', async () => {
    const helper = fakeHelper(entriesOf(3));
    const page = await openPage(helper);
    const stats = gate();
    let removed = false;
    // The removal's stats read is held until the failed listing is asked.
    helper.holdWith(msg => {
      if (msg.cmd === 'memoryRemoveBatch') { removed = true; return null; }
      return removed && msg.cmd === 'memoryStats' ? { until: stats.until, atRelease: true } : null;
    });
    page.removeButton(0).click();
    await settle();
    failSizeLimitRead();
    const listing = page.history.loadChatHistory();
    await settle();
    stats.open();
    await listing;
    page.history.nextPage();
    expect(page.shown()).toEqual([]);
    expect(page.empty()).toBe(FAILED);
  });

  it('after Clear All, a page change shows none of the cleared entries', async () => {
    const helper = fakeHelper(entriesOf(45));
    const page = await openPage(helper);
    page.history.nextPage();
    expect(page.pageInfo()).toBe('Page 2 of 3');
    failSizeLimitRead();
    await page.history.clearChatHistory();
    expect(helper.stored).toEqual([]);
    expect(page.empty()).toBe(FAILED);
    page.history.prevPage();
    expect(page.shown()).toEqual([]);
    expect(page.d.querySelector('#history-list .history-section-header')).toBeNull();
    expect(page.empty()).toBe(FAILED);
  });
});

describe('Chat History Remove button colours come from the theme', () => {
  // Every colour of the Remove button and the header row it sits in is one of
  // Thunderbird's own theme variables, which follow the light and dark themes:
  // no literal colour and no fallback that would hide a missing variable.
  const css = readFileSync(resolve('prompts/prompts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter(rule => /\.history-remove-btn\b/.test(rule.selector));
  const colourDeclarations = rules.flatMap(rule => rule.body.split(';')
    .map(d => d.trim()).filter(Boolean)
    .map(d => ({ selector: rule.selector, property: d.slice(0, d.indexOf(':')).trim(), value: d.slice(d.indexOf(':') + 1).trim() }))
    .filter(d => /^(color|background|background-color|border|border-color|outline|outline-color|box-shadow)$/.test(d.property)));

  it('styles the button in its normal, hover and disabled states', () => {
    expect(rules.map(rule => rule.selector)).toEqual(['.history-remove-btn', '.history-remove-btn:hover:not(:disabled)', '.history-remove-btn:disabled']);
    expect(colourDeclarations.map(d => d.property)).toEqual(['border', 'background', 'color', 'background']);
  });

  it.each(['color', 'background', 'border'])('every %s is a theme variable, with no literal colour and no fallback', property => {
    const declared = colourDeclarations.filter(d => d.property === property);
    expect(declared.length).toBeGreaterThan(0);
    for (const { value } of declared) {
      const vars = [...value.matchAll(/var\(([^)]*)\)/g)].map(m => m[1].trim());
      expect(vars.length).toBeGreaterThan(0);
      for (const name of vars) expect(name).toMatch(/^--(in-content|panel)-[a-z-]+$/);
      const rest = value.replace(/var\([^)]*\)/g, '').replace(/color-mix\(in srgb,|\d+(\.\d+)?(%|px)?|solid|transparent|[(),\s]/g, '');
      expect(rest).toBe('');
    }
  });
});
