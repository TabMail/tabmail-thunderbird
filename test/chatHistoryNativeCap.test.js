/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// TB-193 (#147): the Chat History tab's requests to the memory helper fit the
// native-messaging reply cap. Thunderbird refuses a helper message over 1 MiB
// and disconnects the helper; memory entries are stored whole. This runs the
// real page (prompts/prompts.html) with the shipped settings against a fake
// helper that answers memorySearch and memoryRemoveBatch as the helper does
// (previewChars cuts content in the reply, both date bounds inclusive, newest
// first, a search matching entries that hold one of its words) and refuses an
// over-cap reply. Any other command fails, so a page
// that sends one (a clear, a write) fails its test.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendToBackground } from './support/storedTurnsRoute.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/persistentChatStore.js', async importOriginal => ({ ...await importOriginal(), clearAllThinking: vi.fn() }));
// The memory writers' direct path to the helper, routed to the same message
// path their other writes take, so a test captures every row they store.
vi.mock('../fts/nativeEngine.js', () => ({
  nativeMemorySearch: { indexBatch: rows => globalThis.browser.runtime.sendMessage({ type: 'fts', cmd: 'memoryIndexBatch', rows }) },
}));

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

// `count` entries of about `chars` characters about `word`, a minute apart,
// newest first, each ending in its own marker.
function entriesOf(count, chars, newestMs = Date.now() - 60_000, word = 'planning') {
  return Array.from({ length: count }, (_, i) => ({
    memId: `${word}${i}`,
    sessionId: 'persistent_chat',
    role: 'exchange',
    content: `[USER]: ${word} ${'u'.repeat(100)}\n\n[AGENT]: ${'a'.repeat(chars)} END ${i}`,
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
  // The first n code points, reading no further than them.
  const cut = (text, n) => {
    if (!Number.isInteger(n) || n <= 0) return text;
    let out = '';
    let count = 0;
    for (const ch of text) {
      if (count === n) break;
      out += ch;
      count += 1;
    }
    return out;
  };
  const sendMessage = vi.fn(async msg => {
    if (msg.command === 'chat-turns-change') return sendToBackground(msg);
    replies.calls.push(msg);
    if (replies.calls.length > MAX_HELPER_REQUESTS) throw new Error('runaway: too many helper requests');
    switch (msg.cmd) {
      case 'memoryStats':
        return { docs: stored.length, usedBytes: 1, dbBytes: 1 };
      case 'memorySearch': {
        const words = String(msg.q).toLowerCase().split(/\s+/).filter(Boolean);
        const query = words.length > 0;
        const from = msg.ignoreDate || msg.from === undefined || msg.from === '' ? -Infinity : msg.from;
        const to = msg.ignoreDate || msg.to === undefined || msg.to === '' ? Infinity : msg.to;
        const found = stored
          .filter(e => e.dateMs >= from && e.dateMs <= to)
          .filter(e => !query || words.some(w => e.content.toLowerCase().includes(w)))
          .sort((a, b) => b.dateMs - a.dateMs)
          .slice(0, msg.limit)
          .map(e => ({ ...e, content: cut(e.content, msg.previewChars), snippet: query ? cut(e.content, msg.previewChars) : null, rank: 0 }));
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
        throw new Error(`unexpected helper command: ${msg.cmd}`);
    }
  });
  return { stored, replies, sendMessage };
}

async function openPage(helper) {
  vi.resetModules();
  const dom = new JSDOM(readFileSync(resolve('prompts/prompts.html'), 'utf8'));
  // The page's own stylesheet, which JSDOM does not load from the page's link.
  const style = dom.window.document.createElement('style');
  style.textContent = readFileSync(resolve('prompts/prompts.css'), 'utf8');
  dom.window.document.head.appendChild(style);
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
    // Each entry as shown: what was asked, and what the agent did.
    shown: () => [...d.querySelectorAll('#history-list .history-search-result-content')].map(el => ({
      request: el.querySelector('.history-search-result-request')?.textContent ?? '',
      reply: el.querySelector('.history-search-result-reply')?.textContent ?? '',
    })),
    pageInfo: () => d.getElementById('history-page-info').textContent,
    label: () => d.getElementById('history-stats').textContent.replace(/\s+/g, ' ').trim(),
    status: () => d.getElementById('status-message').textContent,
    statusIsError: () => d.getElementById('status-message').className === 'error',
  };
}

const search = async (page, query) => {
  page.d.getElementById('history-search-input').value = query;
  page.d.getElementById('history-search-btn').click();
};
// Waits until the search has answered: the stats name it. A count of entries
// shown is no sign of that, as the listing it replaces can show as many.
const searched = (page, query) => vi.waitFor(() => expect(page.label()).toContain(`Search: "${query}"`));

// What the page shows of an entry: its first 400 characters (code points), and
// an ellipsis when it goes on.
const PREVIEW_CHARS = 400;
const preview = e => ([...e.content].length > PREVIEW_CHARS ? `${[...e.content].slice(0, PREVIEW_CHARS).join('')}…` : e.content);
// That preview split as Voice shows an entry: the request after `[USER]: `, the
// reply after `[AGENT]: `; an entry not written that way is all reply.
const USER = '[USER]: ';
const AGENT = '\n\n[AGENT]: ';
const view = e => {
  const text = preview(e);
  if (!text.startsWith(USER)) return { request: '', reply: text };
  const at = text.indexOf(AGENT);
  return at < 0 ? { request: text.slice(USER.length), reply: '' } : { request: text.slice(USER.length, at), reply: text.slice(at + AGENT.length) };
};
const asReply = text => ({ request: '', reply: text });
// Said in a reply's place when a long request fills the preview.
const NOTE = 'The rest is not shown: the request is too long to preview.';
// Each entry's parts, by class, in the order shown.
const partsOf = page => [...page.d.querySelectorAll('#history-list .history-search-result-content')].map(el => [...el.children].map(c => c.className));
const REQUEST_THEN_REPLY = ['history-search-result-request', 'history-search-result-reply'];

describe('TB-193: Chat History search and the native-messaging cap', () => {
  it('shows the 100 best of 200 matching sessions of 200 KB, with every reply under the cap', async () => {
    const entries = entriesOf(200, 200_000);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);

    await search(page, 'planning');
    await searched(page, 'planning');
    expect(page.shown()).toHaveLength(20);
    expect(page.shown()).toEqual(entries.slice(0, 20).map(view));
    expect(page.shown()[0].request).toMatch(/^planning u{100}$/);
    expect(page.shown()[0].reply).toMatch(/^a+…$/);
    // Request then reply, and no note under a reply that shows.
    expect(partsOf(page)).toEqual(Array(20).fill(REQUEST_THEN_REPLY));
    // 100 everywhere (#150): the search asks for its 100 best, five pages of 20.
    expect(page.pageInfo()).toBe('Page 1 of 5');
    expect(page.d.querySelector('#history-list .search-highlight')?.textContent).toBe('planning');

    page.d.getElementById('history-next-page').click();
    expect(page.pageInfo()).toBe('Page 2 of 5');
    expect(page.shown()).toEqual(entries.slice(20, 40).map(view));
    page.d.getElementById('history-prev-page').click();
    expect(page.pageInfo()).toBe('Page 1 of 5');
    expect(page.shown()).toEqual(entries.slice(0, 20).map(view));

    expect(helper.replies.overCap).toBe(0);
    expect(helper.replies.largest).toBeLessThan(NATIVE_MESSAGE_CAP_BYTES / 4);
    // The newest entries on open, then one search; browsing changes nothing stored.
    expect(helper.replies.calls.map(m => m.cmd).filter(c => c !== 'memoryStats')).toEqual(['memorySearch', 'memorySearch']);
    expect(helper.replies.calls.filter(m => m.cmd === 'memorySearch').map(m => [m.q, m.limit])).toEqual([['', 100], ['planning', 100]]);
    expect(helper.stored).toEqual(entries);
  });

  it('shows a short entry whole, and the start of a long one from a helper that answers whole entries', async () => {
    const short = { memId: 's', sessionId: 's', role: 'exchange', content: '[USER]: planning\n\n[AGENT]: done', dateMs: Date.now() - 60_000 };
    const long = entriesOf(1, 5000, Date.now() - 120_000)[0];
    const helper = fakeHelper([short, long]);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    // An older helper ignores previewChars.
    helper.sendMessage.mockImplementation(async msg => answer({ ...msg, previewChars: undefined }));

    await search(page, 'planning');
    await searched(page, 'planning');
    expect(page.shown()).toHaveLength(2);
    expect(page.shown()).toEqual([{ request: 'planning', reply: 'done' }, view(long)]);
  });

  it('shows an entry of exactly 400 characters whole, and one of 401 cut with an ellipsis, counting characters not UTF-16 units', async () => {
    const at = Date.now() - 60_000;
    const make = (memId, content, offset) => ({ memId, sessionId: 's', role: 'exchange', content, dateMs: at - offset });
    const exact = 'planning ' + 'a'.repeat(391);
    const over = 'planning ' + 'b'.repeat(392);
    // 400 emoji: 800 UTF-16 units, 400 characters.
    const emoji = 'planning ' + '\u{1F600}'.repeat(391);
    const emojiOver = 'planning ' + '\u{1F600}'.repeat(392);
    const helper = fakeHelper([make('exact', exact, 0), make('over', over, 1), make('emoji', emoji, 2), make('emojiOver', emojiOver, 3)]);
    const page = await openPage(helper);
    await search(page, 'planning');
    await searched(page, 'planning');
    expect(page.shown()).toHaveLength(4);
    expect(page.shown()).toEqual([exact, `${over.slice(0, 400)}…`, emoji, `${[...emojiOver].slice(0, 400).join('')}…`].map(asReply));
  });

  it('shows what was asked and what the agent did, as Voice does, for every shape the memory writers store, search words highlighted in both', async () => {
    const at = Date.now() - 60_000;
    // Rows as Thunderbird's memory writers store them.
    const written = [];
    globalThis.browser = { runtime: { sendMessage: async msg => { written.push(...msg.rows); return { ok: true }; } } };
    const { indexChatTurn, indexChatSession } = await import('../fts/memoryIndexer.js');
    // A request with a line break, as extractPlainTextFromHtml renders <br>.
    await indexChatTurn('planning\nthe trip', 'Booked the planning call.', 'turn', at);
    // A greeting or a nudge: no request, in paragraphs, as extractPlainTextFromHtml renders <p>.
    await indexChatTurn('', 'Welcome back.\n\nThe planning call is at 3.', 'greeting', at - 1);
    // A request the agent never answered.
    await indexChatTurn('planning question', '', 'unanswered', at - 6);
    await indexChatSession('session', [
      { role: 'user', content: 'planning a move' },
      { role: 'assistant', content: 'Here is a checklist.' },
      { role: 'user', content: 'and the boxes?' },
      { role: 'assistant', content: 'Ordered.' },
    ], at - 2);
    expect(written.map(r => r.memId)).toEqual(['turn:turn', 'turn:greeting', 'turn:unanswered', 'chat:session']);
    const make = (memId, content, offset) => ({ memId, sessionId: 's', role: 'session', content, dateMs: at - offset });
    const helper = fakeHelper([
      ...written,
      // Written by v1.0.11 to v1.2.8, which labelled the reply [ASSISTANT].
      make('legacyTurn', '[USER]: planning a trip\n\n[ASSISTANT]: Booked the call.', 3),
      make('legacyGreeting', '[ASSISTANT]: Hello, planning starts Monday.', 4),
      make('cut', `[USER]: planning ${'r'.repeat(500)}\n\n[AGENT]: done`, 5),
    ]);
    const page = await openPage(helper);
    await search(page, 'planning');
    await searched(page, 'planning');
    expect(page.shown()).toHaveLength(7);
    expect(page.shown()).toEqual([
      { request: 'planning\nthe trip', reply: 'Booked the planning call.' },
      { request: '', reply: 'Welcome back.\n\nThe planning call is at 3.' },
      // A session of several turns: its first request, then the rest, as Voice shows one.
      { request: 'planning a move', reply: 'Here is a checklist.\n\n[USER]: and the boxes?\n\n[AGENT]: Ordered.' },
      { request: 'planning a trip', reply: 'Booked the call.' },
      { request: '', reply: 'Hello, planning starts Monday.' },
      // The preview ends before the reply: all request, and a note that says why.
      { request: `planning ${'r'.repeat(383)}…`, reply: NOTE },
      // Never answered, and shown whole: no reply and no note.
      { request: 'planning question', reply: '' },
    ]);
    // No part opens with a role label, and every row with a reply shows it.
    for (const { request, reply } of page.shown()) {
      expect(request).not.toMatch(/^\[(USER|AGENT|ASSISTANT)\]:/);
      expect(reply).not.toMatch(/^\[(USER|AGENT|ASSISTANT)\]:/);
    }
    expect(page.shown().slice(0, 6).every(e => e.reply !== '')).toBe(true);
    const entries = [...page.d.querySelectorAll('#history-list .history-search-result-content')];
    expect(entries[0].children).toHaveLength(2);
    expect(entries[1].querySelector('.history-search-result-request')).toBeNull();
    expect(entries[4].querySelector('.history-search-result-request')).toBeNull();
    expect(entries[5].querySelector('.history-search-result-note')).not.toBeNull();
    expect(entries[6].querySelector('.history-search-result-reply')).toBeNull();
    // Each request shows at most 2 lines and each reply (or the note) at most 3, as Voice shows
    // them. JSDOM does no layout, so this reads the clamp the page's stylesheet gives each part.
    const clampOf = el => {
      const style = page.d.defaultView.getComputedStyle(el);
      return [style.display, style.overflow, style.getPropertyValue('-webkit-line-clamp')];
    };
    const requests = [...page.d.querySelectorAll('#history-list .history-search-result-request')];
    const replies = [...page.d.querySelectorAll('#history-list .history-search-result-reply')];
    expect(requests.map(clampOf)).toEqual(Array(5).fill(['-webkit-box', 'hidden', '2']));
    expect(replies.map(clampOf)).toEqual(Array(6).fill(['-webkit-box', 'hidden', '3']));
    const highlighted = part => [...entries[0].querySelectorAll(`${part} .search-highlight`)].map(el => el.textContent);
    expect(highlighted('.history-search-result-request')).toEqual(['planning']);
    expect(highlighted('.history-search-result-reply')).toEqual(['planning']);
  });

  it('says why a reply is not shown when the request fills the preview, even when it ends right at the reply label, and never highlights the note', async () => {
    const at = Date.now() - 60_000;
    const make = (memId, content, offset) => ({ memId, sessionId: 's', role: 'session', content, dateMs: at - offset });
    // Requests of 381 and 377 characters: the 400-character cut ends just past `[AGENT]: ` / `[ASSISTANT]: `.
    const agent381 = make('agent381', `[USER]: request ${'q'.repeat(373)}\n\n[AGENT]: the reply`, 0);
    const assistant377 = make('assistant377', `[USER]: request ${'q'.repeat(369)}\n\n[ASSISTANT]: the reply`, 1);
    // One character of reply fits.
    const agent380 = make('agent380', `[USER]: request ${'q'.repeat(372)}\n\n[AGENT]: the reply`, 2);
    const page = await openPage(fakeHelper([agent381, assistant377, agent380]));
    await search(page, 'request');
    await searched(page, 'request');
    expect(page.shown()).toHaveLength(3);
    expect(page.shown()).toEqual([
      { request: `request ${'q'.repeat(373)}…`, reply: NOTE },
      { request: `request ${'q'.repeat(369)}…`, reply: NOTE },
      { request: `request ${'q'.repeat(372)}`, reply: 't…' },
    ]);
    expect(partsOf(page)).toEqual([
      ['history-search-result-request', 'history-search-result-reply history-search-result-note'],
      ['history-search-result-request', 'history-search-result-reply history-search-result-note'],
      REQUEST_THEN_REPLY,
    ]);
    // The search word is in the request and in the note: only the request's is highlighted.
    const notes = [...page.d.querySelectorAll('#history-list .history-search-result-note')];
    expect(notes.map(n => n.querySelector('.search-highlight'))).toEqual([null, null]);
    expect([...page.d.querySelectorAll('#history-list .history-search-result-request .search-highlight')].map(el => el.textContent)).toEqual(['request', 'request', 'request']);
  });

  it('marks every word of a search of several words, in the request and the reply, showing both exactly (#158)', async () => {
    const request = 'Plan an event for Friday.';
    const reply = 'Planned an event & sent the <plan>.';
    const entry = { memId: 'event', sessionId: 's', role: 'session', content: `[USER]: ${request}\n\n[AGENT]: ${reply}`, dateMs: Date.now() - 60_000 };
    const page = await openPage(fakeHelper([entry]));
    await search(page, 'plan an event');
    await searched(page, 'plan an event');
    expect(page.shown()).toHaveLength(1);
    expect(page.shown()).toEqual([{ request, reply }]);
    const marks = part => {
      const box = page.d.querySelector(`#history-list ${part}`);
      expect([...box.querySelectorAll('*')].map(el => [el.tagName, [...el.attributes].map(a => `${a.name}=${a.value}`)]))
        .toEqual([...box.children].map(() => ['SPAN', ['class=search-highlight']]));
      // No search word is left unmarked between the marks.
      for (const node of box.childNodes) if (node.nodeType === 3) expect(node.textContent).not.toMatch(/plan|an|event/i);
      return [...box.children].map(el => el.textContent);
    };
    expect(marks('.history-search-result-request')).toEqual(['Plan', 'an', 'event']);
    expect(marks('.history-search-result-reply')).toEqual(['Plan', 'an', 'event', 'plan']);
  });

  it('shows HTML-special characters in the request and the reply as text, highlighted, with no element made from them', async () => {
    const entry = {
      memId: 'html', sessionId: 'persistent_chat', role: 'session', dateMs: Date.now() - 60_000,
      content: `[USER]: what's <b>bold</b> & "quoted" planning?\n\n[AGENT]: it's <img src=x onerror="globalThis.__injected=1"> & planning done`,
    };
    const page = await openPage(fakeHelper([entry]));
    await search(page, 'planning');
    await searched(page, 'planning');
    expect(page.shown()).toHaveLength(1);
    expect(page.shown()).toEqual([{ request: `what's <b>bold</b> & "quoted" planning?`, reply: `it's <img src=x onerror="globalThis.__injected=1"> & planning done` }]);
    expect(page.d.querySelectorAll('#history-list img, #history-list b')).toHaveLength(0);
    expect([...page.d.querySelectorAll('#history-list .search-highlight')].map(el => el.textContent)).toEqual(['planning', 'planning']);
  });

  it('a new search opens on its first page', async () => {
    const alpha = entriesOf(60, 10, Date.now() - 60_000, 'alpha');
    const beta = entriesOf(40, 10, Date.now() - 30_000, 'beta');
    const helper = fakeHelper([...alpha, ...beta]);
    const page = await openPage(helper);
    await search(page, 'alpha');
    await vi.waitFor(() => expect(page.pageInfo()).toBe('Page 1 of 3'));
    page.d.getElementById('history-next-page').click();
    page.d.getElementById('history-next-page').click();
    expect(page.pageInfo()).toBe('Page 3 of 3');
    await search(page, 'beta');
    await vi.waitFor(() => expect(page.label()).toContain('"beta" (40 results)'));
    expect(page.pageInfo()).toBe('Page 1 of 2');
    expect(page.shown()).toEqual(beta.slice(0, 20).map(view));
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
    // The later search waits in line behind the earlier one.
    await new Promise(r => setTimeout(r, 0));
    expect(helper.sendMessage.mock.calls.filter(([msg]) => msg.cmd === 'memorySearch' && msg.q === 'planning')).toHaveLength(0);
    releaseFirst();
    await searched(page, 'planning');
    expect(page.shown()).toEqual(entries.slice(0, 20).map(view));
    expect(page.label()).not.toContain('"first"');
    expect(page.d.getElementById('history-empty').style.display).toBe('none');
    page.d.getElementById('history-next-page').click();
    expect(page.pageInfo()).toBe('Page 2 of 2');
    expect(page.shown()).toEqual(entries.slice(20, 40).map(view));
  });

  // Holds the helper's answers to `cmd` messages until released.
  function hold(helper, cmd) {
    const answer = helper.sendMessage.getMockImplementation();
    let release;
    const held = new Promise(r => { release = r; });
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === cmd) await held;
      return answer(msg);
    });
    return () => release();
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  };

  it('a page change while a search is pending pages the results shown, then shows the search', async () => {
    const alpha = entriesOf(40, 10, Date.now() - 60_000, 'alpha');
    const beta = entriesOf(5, 10, Date.now() - 30_000, 'beta');
    const helper = fakeHelper([...alpha, ...beta]);
    const page = await openPage(helper);
    await search(page, 'alpha');
    await searched(page, 'alpha');
    expect(page.shown()).toHaveLength(20);
    expect(page.shown()).toEqual(alpha.slice(0, 20).map(view));

    const releaseSearch = hold(helper, 'memorySearch');
    await search(page, 'beta');
    page.d.getElementById('history-next-page').click();
    expect(page.pageInfo()).toBe('Page 2 of 2');
    expect(page.shown()).toEqual(alpha.slice(20, 40).map(view));
    expect(page.label()).toContain('"alpha" (40 results)');

    releaseSearch();
    await vi.waitFor(() => expect(page.label()).toContain('"beta" (5 results)'));
    expect(page.shown()).toEqual(beta.map(view));
  });

  it('a search that answers after the tab reloads does not show over the newest entries', async () => {
    const newest = entriesOf(3, 10, Date.now() - 60_000, 'newest');
    const found = entriesOf(2, 10, Date.now() - 600_000, 'planning');
    const helper = fakeHelper([...newest, ...found]);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    let releaseSearch;
    const held = new Promise(r => { releaseSearch = r; });
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === 'memorySearch' && msg.q === 'planning') await held;
      return answer(msg);
    });
    await search(page, 'planning');
    const listings = () => helper.replies.calls.filter(m => m.cmd === 'memorySearch' && m.q === '').length;
    const before = listings();
    const reload = page.history.loadChatHistory();
    await settle();
    // The reload waits in line behind the search.
    expect(listings()).toBe(before);
    releaseSearch();
    await reload;
    expect(listings()).toBe(before + 1);
    expect(page.shown()).toEqual([...newest, ...found].map(view));
    expect(page.label()).not.toContain('Search:');
  });

  // An older helper's request is refused before it is sent (native-fts ADR-NF-018):
  // the page says why rather than showing an empty result.
  it('says why a search failed when the helper answers an error, and shows no results', async () => {
    const helper = fakeHelper(entriesOf(3, 10));
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg =>
      (msg.cmd === 'memorySearch' ? { error: 'Chat memory search needs a newer search helper.' } : answer(msg)));
    await search(page, 'planning');
    await settle();
    expect(page.status()).toBe('Search failed: Chat memory search needs a newer search helper.');
    // No results: the newest entries listed on open stay.
    expect(page.shown()).toEqual(entriesOf(3, 10).map(view));
    expect(page.label()).not.toContain('Search:');
  });

  // #225: a search the helper does not answer with a list failed; it never
  // shows as a search that found nothing. No listener answers while the
  // background starts or reloads.
  it.each([
    ['no reply', undefined, 'Search failed: no reply from the search helper'],
    ['an empty reply', null, 'Search failed: no reply from the search helper'],
    ['a reply that is not a list', { ok: true }, 'Search failed: no reply from the search helper'],
    ['an error', { error: 'Native RPC timed out' }, 'Search failed: Native RPC timed out'],
  ])('a search answered by %s says it failed and keeps the search shown before', async (_why, reply, said) => {
    const found = entriesOf(2, 10, Date.now() - 600_000, 'planning');
    const helper = fakeHelper([...entriesOf(3, 10, Date.now() - 60_000, 'newest'), ...found]);
    const page = await openPage(helper);
    await search(page, 'planning');
    await settle();
    expect(page.shown()).toEqual(found.map(view));
    const before = page.label();
    expect(before).toContain('planning');
    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg => (msg.cmd === 'memorySearch' && msg.q === 'harbour' ? reply : answer(msg)));
    await search(page, 'harbour');
    await settle();
    expect(page.status()).toBe(said);
    expect(page.statusIsError()).toBe(true);
    expect(page.shown()).toEqual(found.map(view));
    expect(page.label()).toBe(before);
    // Shown again after a removal, the page is still the search shown before.
    page.d.querySelector('#history-list .history-remove-btn').click();
    await settle();
    expect(page.shown()).toEqual(found.slice(1).map(view));
    expect(page.label()).toBe('Active turns: 0 Searchable entries: 4 Search: "planning" (1 results)');
  });
});

// #153 and #154: the tab opens on memory's newest entries, as Voice's
// Settings > Memory does, and any entry shown can be removed on its own.
describe('Chat History lists the newest conversations and removes one', () => {
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  };
  // Holds the helper's answers to messages `when` picks, each answered as the
  // helper stood when it was asked, until released.
  function holdWhen(helper, when) {
    const answer = helper.sendMessage.getMockImplementation();
    let release;
    const held = new Promise(r => { release = r; });
    helper.sendMessage.mockImplementation(async msg => {
      if (!when(msg)) return answer(msg);
      const reply = await answer(msg);
      await held;
      return reply;
    });
    return () => release();
  }
  const empty = page => page.d.getElementById('history-empty');
  const header = page => page.d.querySelector('#history-list .history-section-header')?.textContent;
  const buttons = page => [...page.d.querySelectorAll('#history-list .history-remove-btn')];
  const removeAt = (page, i) => buttons(page)[i].click();
  const input = page => page.d.getElementById('history-search-input');
  const type = (page, value) => {
    input(page).value = value;
    input(page).dispatchEvent(new page.d.defaultView.Event('input'));
  };
  const removals = helper => helper.replies.calls.filter(m => m.cmd === 'memoryRemoveBatch').map(m => m.ids);
  const searches = helper => helper.replies.calls.filter(m => m.cmd === 'memorySearch');

  it('opens on the newest 100 of 250 entries of 200 KB, newest first, with every reply under the cap', async () => {
    const entries = entriesOf(250, 200_000);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    expect(header(page)).toBe('Newest Conversations');
    expect(page.shown()).toEqual(entries.slice(0, 20).map(view));
    expect(page.pageInfo()).toBe('Page 1 of 5');
    for (let p = 2; p <= 5; p++) page.d.getElementById('history-next-page').click();
    expect(page.shown()).toEqual(entries.slice(80, 100).map(view));
    expect(page.label()).toBe('Active turns: 0 Searchable entries: 250');
    expect(page.d.querySelector('#history-list .search-highlight')).toBeNull();
    expect(searches(helper).map(m => [m.q, m.limit, m.ignoreDate, m.previewChars])).toEqual([['', 100, true, 401]]);
    expect(helper.replies.overCap).toBe(0);
    expect(helper.replies.largest).toBeLessThan(NATIVE_MESSAGE_CAP_BYTES / 4);
    expect(empty(page).style.display).toBe('none');
  });

  it('says when no conversation is kept', async () => {
    const page = await openPage(fakeHelper([]));
    expect(page.shown()).toEqual([]);
    expect(empty(page).textContent).toBe('No conversations kept yet.');
    expect(empty(page).style.display).toBe('block');
    expect(page.d.getElementById('history-pagination').style.display).toBe('none');
  });

  it.each([
    ['an error', async () => ({ error: 'Native helper disconnected' }), 'Native helper disconnected'],
    ['a throw', async () => { throw new Error('Could not establish connection'); }, 'Could not establish connection'],
    ['no reply', async () => undefined, 'no reply from the search helper'],
    ['an empty reply', async () => null, 'no reply from the search helper'],
    ['a reply that is not a list', async () => ({ ok: true }), 'no reply from the search helper'],
  ])('says why it could not list, on %s, and still shows the stats', async (_, listing, why) => {
    const helper = fakeHelper(entriesOf(3, 10));
    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg => (msg.cmd === 'memorySearch' ? listing() : answer(msg)));
    const page = await openPage(helper);
    expect(page.shown()).toEqual([]);
    expect(empty(page).textContent).toBe(`Couldn't list past conversations: ${why}`);
    expect(empty(page).style.display).toBe('block');
    expect(page.label()).toBe('Active turns: 0 Searchable entries: 3');
    // A search that works shows its results in its place, and the list that works next clears it.
    helper.sendMessage.mockImplementation(answer);
    await search(page, 'planning');
    await searched(page, 'planning');
    expect(page.shown()).toHaveLength(3);
    type(page, '');
    await vi.waitFor(() => expect(header(page)).toBe('Newest Conversations'));
    expect(page.shown()).toEqual(entriesOf(3, 10).map(view));
  });

  it('goes back to the newest entries when the search box is cleared, without Enter', async () => {
    const newest = entriesOf(3, 10, Date.now() - 60_000, 'newest');
    const found = entriesOf(2, 10, Date.now() - 600_000, 'planning');
    const helper = fakeHelper([...newest, ...found]);
    const page = await openPage(helper);
    // Typing does not search, and clearing a box that holds no search lists nothing again.
    type(page, 'plan');
    type(page, '');
    expect(searches(helper)).toHaveLength(1);
    type(page, 'planning');
    page.d.getElementById('history-search-btn').click();
    await vi.waitFor(() => expect(page.label()).toContain('"planning" (2 results)'));
    expect(page.shown()).toEqual(found.map(view));
    // Spaces alone count as cleared.
    type(page, '   ');
    await vi.waitFor(() => expect(header(page)).toBe('Newest Conversations'));
    expect(page.shown()).toEqual([...newest, ...found].map(view));
    expect(page.label()).not.toContain('Search:');
    expect(input(page).value).toBe('');
    expect(searches(helper).map(m => m.q)).toEqual(['', 'planning', '']);
  });

  it('a cleared box goes back to the newest entries while its search is still pending', async () => {
    const newest = entriesOf(3, 10, Date.now() - 60_000, 'newest');
    const found = entriesOf(2, 10, Date.now() - 600_000, 'planning');
    const helper = fakeHelper([...newest, ...found]);
    const page = await openPage(helper);
    const release = holdWhen(helper, msg => msg.cmd === 'memorySearch' && msg.q === 'planning');
    await search(page, 'planning');
    type(page, '');
    await settle();
    release();
    await settle();
    expect(header(page)).toBe('Newest Conversations');
    expect(page.shown()).toEqual([...newest, ...found].map(view));
    expect(searches(helper).map(m => m.q)).toEqual(['', 'planning', '']);
  });

  it('a listing that answers late does not show over a later search', async () => {
    const newest = entriesOf(3, 10, Date.now() - 60_000, 'newest');
    const found = entriesOf(2, 10, Date.now() - 600_000, 'planning');
    const helper = fakeHelper([...newest, ...found]);
    const page = await openPage(helper);
    const release = holdWhen(helper, msg => msg.cmd === 'memorySearch' && msg.q === '');
    const reload = page.history.loadChatHistory();
    await settle();
    await search(page, 'planning');
    await settle();
    // The search waits in line behind the listing; the listing shows first.
    expect(searches(helper).filter(m => m.q === 'planning')).toHaveLength(0);
    release();
    await reload;
    await vi.waitFor(() => expect(page.label()).toContain('"planning" (2 results)'));
    expect(page.shown()).toEqual(found.map(view));
    expect(page.label()).toContain('"planning" (2 results)');
    expect(page.label()).toContain('Searchable entries: 5');
  });

  it("a listing's stats read late show once a later search shows its results", async () => {
    const found = entriesOf(2, 10, Date.now() - 600_000, 'planning');
    const helper = fakeHelper(found);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    let releaseStats;
    const held = new Promise(r => { releaseStats = r; });
    let statsAsked = 0;
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd !== 'memoryStats' || ++statsAsked > 1) return answer(msg);
      await held;
      return { docs: 7, usedBytes: 1, dbBytes: 1 };
    });
    const reload = page.history.loadChatHistory();
    await search(page, 'planning');
    await settle();
    // The search waits in line behind the listing, stats read and all.
    expect(searches(helper).filter(m => m.q === 'planning')).toHaveLength(0);
    releaseStats();
    await reload;
    await vi.waitFor(() => expect(page.label()).toContain('"planning" (2 results)'));
    expect(page.shown()).toEqual(found.map(view));
    expect(page.label()).toContain('Searchable entries: 7');
    expect(page.label()).toContain('"planning" (2 results)');
  });

  it('removes one entry on its button, with no confirmation, saying so while it is pending, and keeps the page', async () => {
    const entries = entriesOf(45, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    page.d.getElementById('history-next-page').click();
    expect(page.pageInfo()).toBe('Page 2 of 3');
    // Each button names the entry it removes, by the date shown beside it.
    expect(buttons(page).map(b => [b.textContent, b.disabled, b.getAttribute('aria-label')]))
      .toEqual(buttons(page).map(b => ['Remove', false, `Remove the c${b.previousElementSibling.textContent.slice(1)}`]));
    expect(buttons(page).map(b => b.previousElementSibling.textContent)).toEqual(entries.slice(20, 40).map(e => expect.stringMatching(/^Conversation from \w{3} \d{1,2}, \d{4}/)));
    expect(new Set(buttons(page).map(b => b.getAttribute('aria-label'))).size).toBe(20);

    const release = holdWhen(helper, msg => msg.cmd === 'memoryRemoveBatch');
    removeAt(page, 1);
    removeAt(page, 3);
    await settle();
    expect(buttons(page).map(b => [b.textContent, b.disabled]).filter(([, disabled]) => disabled))
      .toEqual([['Removing…', true], ['Removing…', true]]);
    expect([1, 3].map(i => buttons(page)[i].textContent)).toEqual(['Removing…', 'Removing…']);
    // A click on a pending button sends nothing more; a page change keeps it pending.
    buttons(page)[1].disabled = false;
    removeAt(page, 1);
    page.d.getElementById('history-prev-page').click();
    page.d.getElementById('history-next-page').click();
    expect([1, 3].map(i => buttons(page)[i].textContent)).toEqual(['Removing…', 'Removing…']);
    expect(page.d.getElementById('history-modal-overlay').style.display).toBe('none');

    release();
    await settle();
    const left = entries.filter((_, i) => i !== 21 && i !== 23);
    expect(removals(helper)).toEqual([[entries[21].memId], [entries[23].memId]]);
    expect(helper.stored).toEqual(left);
    expect(page.pageInfo()).toBe('Page 2 of 3');
    expect(page.shown()).toEqual(left.slice(20, 40).map(view));
    expect(buttons(page).every(b => b.textContent === 'Remove' && !b.disabled)).toBe(true);
    expect(page.label()).toBe('Active turns: 0 Searchable entries: 43');
    expect(page.status()).toBe('');
  });

  it('removing the last entry of the last page shows the page before it', async () => {
    const entries = entriesOf(21, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    page.d.getElementById('history-next-page').click();
    expect(page.pageInfo()).toBe('Page 2 of 2');
    removeAt(page, 0);
    await settle();
    expect(page.d.getElementById('history-pagination').style.display).toBe('none');
    expect(page.shown()).toEqual(entries.slice(0, 20).map(view));
  });

  it('removing the only entry says it was removed', async () => {
    const helper = fakeHelper(entriesOf(1, 10));
    const page = await openPage(helper);
    removeAt(page, 0);
    await settle();
    expect(page.shown()).toEqual([]);
    expect(empty(page).textContent).toBe('Removed every conversation shown.');
    expect(page.label()).toBe('Active turns: 0 Searchable entries: 0');
  });

  it('removes an entry from search results and keeps the search', async () => {
    const newest = entriesOf(3, 10, Date.now() - 60_000, 'newest');
    const found = entriesOf(3, 10, Date.now() - 600_000, 'planning');
    const helper = fakeHelper([...newest, ...found]);
    const page = await openPage(helper);
    await search(page, 'planning');
    await vi.waitFor(() => expect(page.label()).toContain('"planning" (3 results)'));
    removeAt(page, 0);
    await settle();
    expect(removals(helper)).toEqual([[found[0].memId]]);
    expect(page.shown()).toEqual(found.slice(1).map(view));
    expect(header(page)).toBe('Search Results (2 total)');
    expect(page.label()).toContain('"planning" (2 results)');
    expect(page.label()).toContain('Searchable entries: 5');
    expect(page.d.querySelector('#history-list .search-highlight')?.textContent).toBe('planning');
  });

  it.each([
    ['an error', async () => ({ error: 'Native RPC timed out' }), 'Native RPC timed out'],
    ['a throw', async () => { throw new Error('Could not establish connection'); }, 'Could not establish connection'],
    // No listener answered (the background starting or reloading): nothing confirms the removal.
    ['no reply', async () => undefined, 'the search helper did not confirm it'],
    ['a reply that does not confirm it', async () => ({ ok: false, count: 0 }), 'the search helper did not confirm it'],
  ])('says why a removal failed, on %s, and keeps the entry with its button', async (_, removal, why) => {
    const entries = entriesOf(3, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg => (msg.cmd === 'memoryRemoveBatch' ? removal() : answer(msg)));
    removeAt(page, 1);
    await settle();
    expect(page.status()).toBe(`Couldn't remove the conversation: ${why}`);
    expect(page.statusIsError()).toBe(true);
    expect(page.shown()).toEqual(entries.map(view));
    expect(buttons(page).map(b => [b.textContent, b.disabled])).toEqual(Array(3).fill(['Remove', false]));
    // The button works again.
    helper.sendMessage.mockImplementation(answer);
    removeAt(page, 1);
    await settle();
    expect(page.shown()).toEqual([entries[0], entries[2]].map(view));
  });

  it('shows a confirmed removal at once, before the stats are read again', async () => {
    const entries = entriesOf(3, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    const release = holdWhen(helper, msg => msg.cmd === 'memoryStats');
    removeAt(page, 1);
    await settle();
    expect(helper.stored).toEqual([entries[0], entries[2]]);
    expect(page.shown()).toEqual([entries[0], entries[2]].map(view));
    expect(buttons(page).map(b => [b.textContent, b.disabled])).toEqual(Array(2).fill(['Remove', false]));
    expect(page.label()).toBe('Active turns: 0 Searchable entries: 3');
    release();
    await settle();
    expect(page.label()).toBe('Active turns: 0 Searchable entries: 2');
  });

  it.each([
    ['an error', async () => ({ error: 'stats unavailable' }), 'stats unavailable'],
    ['a throw', async () => { throw new Error('stats unavailable'); }, 'stats unavailable'],
    ['no reply', async () => undefined, 'no reply from the search helper'],
  ])('says the stats could not be read after a removal, on %s, and shows them unavailable', async (_, stats, why) => {
    const entries = entriesOf(3, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg => (msg.cmd === 'memoryStats' ? stats() : answer(msg)));
    removeAt(page, 1);
    await settle();
    expect(helper.stored).toEqual([entries[0], entries[2]]);
    expect(page.shown()).toEqual([entries[0], entries[2]].map(view));
    expect(page.status()).toBe(`Couldn't read memory's size: ${why}`);
    expect(page.statusIsError()).toBe(true);
    expect(page.d.getElementById('history-usage-label').textContent).toMatch(/^Memory used: unavailable/);
    expect(buttons(page).map(b => [b.textContent, b.disabled])).toEqual(Array(2).fill(['Remove', false]));
  });

  it('says both when a removal and the stats read after it fail', async () => {
    const entries = entriesOf(3, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === 'memoryRemoveBatch') return { error: 'Native RPC timed out' };
      if (msg.cmd === 'memoryStats') throw new Error('stats unavailable');
      return answer(msg);
    });
    removeAt(page, 1);
    await settle();
    expect(page.status()).toBe("Couldn't remove the conversation: Native RPC timed out Couldn't read memory's size: stats unavailable");
    expect(page.shown()).toEqual(entries.map(view));
  });

  it('a listing sent before a removal is confirmed leaves the removed entry out', async () => {
    const entries = entriesOf(3, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    // The listing is answered as memory stood when it was asked: with the entry.
    const release = holdWhen(helper, msg => msg.cmd === 'memorySearch' && msg.q === '');
    const reload = page.history.loadChatHistory();
    await vi.waitFor(() => expect(searches(helper)).toHaveLength(2));
    removeAt(page, 0);
    await settle();
    // The removal waits in line behind the listing, and says it is pending.
    expect(removals(helper)).toHaveLength(0);
    expect(helper.stored).toEqual(entries);
    expect(buttons(page)[0].textContent).toBe('Removing…');
    release();
    await reload;
    await vi.waitFor(() => expect(helper.stored).toEqual(entries.slice(1)));
    await settle();
    expect(page.shown()).toEqual(entries.slice(1).map(view));
    expect(header(page)).toBe('Newest Conversations');
  });

  it('a search sent while a removal is pending leaves the entry out once the removal is confirmed', async () => {
    const entries = entriesOf(3, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    let releaseRemoval;
    const removalHeld = new Promise(r => { releaseRemoval = r; });
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === 'memoryRemoveBatch') await removalHeld;
      return answer(msg);
    });
    removeAt(page, 0);
    await settle();
    await search(page, 'planning');
    await settle();
    // The search waits in line behind the pending removal.
    expect(searches(helper)).toHaveLength(1);
    expect(helper.stored).toEqual(entries);
    releaseRemoval();
    await vi.waitFor(() => expect(page.label()).toContain('"planning" (2 results)'));
    expect(helper.stored).toEqual(entries.slice(1));
    expect(page.shown()).toEqual(entries.slice(1).map(view));
    expect(page.label()).toContain('"planning" (2 results)');
  });

  it("removes only the memory entry: the chat's turns, metadata, id map and thinking stay", async () => {
    const entries = entriesOf(3, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    const initial = { chat_turns: [{ role: 'user', content: 'kept turn' }], chat_meta: { kept: 'metadata' }, chat_id_map: { kept: 'mapping' } };
    const data = structuredClone(initial);
    browser.storage.local.get.mockImplementation(async key => (typeof key === 'string' ? { [key]: data[key] } : {}));
    browser.storage.local.set.mockImplementation(async patch => { Object.assign(data, patch); });
    browser.storage.local.remove.mockImplementation(async keys => { for (const key of [keys].flat()) delete data[key]; });
    const { clearAllThinking } = await import('../chat/modules/persistentChatStore.js');
    clearAllThinking.mockClear();
    removeAt(page, 0);
    await settle();
    expect(helper.stored).toEqual(entries.slice(1));
    expect(page.shown()).toEqual(entries.slice(1).map(view));
    expect(data).toEqual(initial);
    expect(clearAllThinking).not.toHaveBeenCalled();
    expect(helper.replies.calls.map(m => m.cmd).filter(c => c !== 'memoryStats' && c !== 'memorySearch')).toEqual(['memoryRemoveBatch']);
  });

  it('Delete Old, Clear All, a lower size limit and a reload each list what memory then holds', async () => {
    const recent = entriesOf(3, 10, Date.now() - 60_000, 'recent');
    const old = entriesOf(3, 10, Date.now() - 40 * DAY_MS, 'old');
    const helper = fakeHelper([...recent, ...old]);
    const page = await openPage(helper);
    expect(page.shown()).toEqual([...recent, ...old].map(view));
    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === 'memoryTrim') return { ok: true, trimmed: helper.stored.splice(-1).length, withinLimit: true };
      if (msg.cmd === 'memoryClear') { helper.stored.splice(0); return { ok: true }; }
      return answer(msg);
    });

    page.d.getElementById('delete-old-history').click();
    page.d.getElementById('delete-days-input').value = '30';
    page.d.getElementById('modal-confirm').click();
    await vi.waitFor(() => expect(page.status()).toMatch(/^Deleted /));
    await settle();
    expect(page.shown()).toEqual(recent.map(view));
    expect(page.label()).toContain('Searchable entries: 3');

    // A reload (Refresh, or coming back to the tab) shows an entry kept since.
    const kept = entriesOf(1, 10, Date.now(), 'kept')[0];
    helper.stored.unshift(kept);
    await page.history.loadChatHistory();
    expect(page.shown()).toEqual([kept, ...recent].map(view));

    const select = page.d.getElementById('history-size-limit');
    select.value = select.options[0].value;
    select.dispatchEvent(new page.d.defaultView.Event('change'));
    page.d.getElementById('modal-confirm').click();
    await vi.waitFor(() => expect(page.status()).toMatch(/^Size limit set/));
    await settle();
    expect(page.shown()).toEqual([kept, ...recent.slice(0, 2)].map(view));

    await page.history.clearChatHistory();
    expect(page.shown()).toEqual([]);
    expect(empty(page).textContent).toBe('No conversations kept yet.');
    expect(page.label()).toBe('Active turns: 0 Searchable entries: 0');
  });

  it.each([
    ['the Search button', page => page.d.getElementById('history-search-btn').click()],
    ['Enter', page => input(page).dispatchEvent(new page.d.defaultView.KeyboardEvent('keydown', { key: 'Enter' }))],
  ])('a blank search by %s lists what memory holds now', async (_, submit) => {
    const found = entriesOf(2, 10, Date.now() - 600_000, 'planning');
    const helper = fakeHelper(found);
    const page = await openPage(helper);
    await search(page, 'planning');
    await vi.waitFor(() => expect(page.label()).toContain('"planning" (2 results)'));
    const kept = entriesOf(1, 10, Date.now(), 'kept')[0];
    helper.stored.unshift(kept);
    // Set without an input event: only the submit lists.
    input(page).value = '  ';
    submit(page);
    await vi.waitFor(() => expect(header(page)).toBe('Newest Conversations'));
    expect(page.shown()).toEqual([kept, ...found].map(view));
    expect(searches(helper).map(m => m.q)).toEqual(['', 'planning', '']);
  });

  it('keeps no removal past the request it could change: what is kept is bounded, however many are removed', async () => {
    const helper = fakeHelper([]);
    const page = await openPage(helper);
    // Every Set or Map the page keeps a removed id in, to read what it still holds.
    const holders = [];
    const add = Set.prototype.add;
    const set = Map.prototype.set;
    const keep = (holder, id) => { if (typeof id === 'string' && id.startsWith('cycle') && !holders.includes(holder)) holders.push(holder); };
    const spies = [
      vi.spyOn(Set.prototype, 'add').mockImplementation(function (id) { keep(this, id); return add.call(this, id); }),
      vi.spyOn(Map.prototype, 'set').mockImplementation(function (id, value) { keep(this, id); return set.call(this, id, value); }),
    ];
    const held = () => Math.max(0, ...holders.map(holder => [...holder.keys()].filter(id => String(id).startsWith('cycle')).length));
    try {
      for (let i = 0; i < 30; i++) {
        helper.stored.unshift({ ...entriesOf(1, 10, Date.now(), 'cycle')[0], memId: `cycle${i}` });
        if (i % 2) {
          await page.history.loadChatHistory();
        } else {
          await search(page, 'cycle');
          await vi.waitFor(() => expect(page.label()).toContain('"cycle" (1 results)'));
        }
        removeAt(page, 0);
        await settle();
        expect(page.shown()).toEqual([]);
        // At most the one removal made since the last request was sent.
        expect(held()).toBeLessThanOrEqual(1);
      }
      await page.history.loadChatHistory();
      expect(held()).toBe(0);
      expect(helper.stored).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('a search sent before a removal is confirmed leaves the removed entry out; one sent after shows what memory holds', async () => {
    const found = entriesOf(3, 10, Date.now() - 600_000, 'planning');
    const helper = fakeHelper(found);
    const page = await openPage(helper);
    // The search is answered as memory stood when it was asked: with the entry.
    const release = holdWhen(helper, msg => msg.cmd === 'memorySearch' && msg.q === 'planning');
    await search(page, 'planning');
    removeAt(page, 0);
    await settle();
    // The removal waits in line behind the search.
    expect(removals(helper)).toHaveLength(0);
    expect(helper.stored).toEqual(found);
    release();
    await vi.waitFor(() => expect(page.label()).toContain('"planning" (2 results)'));
    expect(helper.stored).toEqual(found.slice(1));
    expect(page.shown()).toEqual(found.slice(1).map(view));
    // The same entry written to memory again shows in the next search.
    helper.stored.unshift(found[0]);
    await search(page, 'planning');
    await vi.waitFor(() => expect(page.label()).toContain('"planning" (3 results)'));
    expect(page.shown()).toEqual(found.map(view));
  });
});

const MEMORY_SEARCH_NEEDS_HELPER_UPDATE =
  'Chat memory search needs a newer search helper: in TabMail settings, under Full Text Search, choose Check for Updates.';

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
    expect(page.status()).toContain('then stopped: Native helper disconnected');
    expect(page.statusIsError()).toBe(true);
    expect(helper.stored).toHaveLength(700);
  });

  // No reply comes while the background starts or reloads.
  it.each([
    ['an error', { error: 'Native RPC timed out' }, 'Native RPC timed out'],
    ['no reply', undefined, 'the search helper did not confirm it'],
    ['a reply that does not confirm it', {}, 'the search helper did not confirm it'],
  ])('stops at a removal that answers with %s and does not count it', async (_name, failed, reason) => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const older = entriesOf(1200, 10, now - 31 * DAY_MS);
    const helper = fakeHelper(older);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    let removals = 0;
    helper.sendMessage.mockImplementation(async msg => {
      if (msg.cmd === 'memoryRemoveBatch' && ++removals === 2) return failed;
      return answer(msg);
    });

    await deleteOlderThan(page, 30);
    expect(page.status()).toContain('500 search entries');
    expect(page.status()).toContain(`then stopped: ${reason}`);
    expect(page.statusIsError()).toBe(true);
    expect(removals).toBe(2);
    expect(helper.stored).toHaveLength(700);
  });

  // An older helper refuses the listing before it is sent (native-fts ADR-NF-018):
  // the page says to update it rather than reporting a finished deletion.
  it('says the helper needs an update when it refuses the listing, and removes nothing', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const older = entriesOf(3, 10, now - 31 * DAY_MS);
    const helper = fakeHelper(older);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg =>
      (msg.cmd === 'memorySearch' ? { error: MEMORY_SEARCH_NEEDS_HELPER_UPDATE } : answer(msg)));

    await deleteOlderThan(page, 30);
    expect(page.status()).toContain(`0 search entries older than`);
    expect(page.status()).toContain(`then stopped: ${MEMORY_SEARCH_NEEDS_HELPER_UPDATE}`);
    expect(page.statusIsError()).toBe(true);
    expect(helper.replies.calls.filter(m => m.cmd === 'memoryRemoveBatch')).toHaveLength(0);
    expect(helper.stored).toHaveLength(3);
  });

  // Local turns are removed before the search index: a stop afterwards still
  // reports the turns it removed.
  it.each([true, false])('reports the local turns removed, whether the listing is refused (%s) or not', async refuses => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const helper = fakeHelper(entriesOf(3, 10, now - 31 * DAY_MS));
    const page = await openPage(helper);
    const fresh = { _ts: now - DAY_MS, content: 'recent turn' };
    const data = { chat_turns: [
      { _ts: now - 40 * DAY_MS, content: 'old turn one' },
      { _ts: now - 41 * DAY_MS, content: 'old turn two' },
      fresh,
    ] };
    browser.storage.local.get.mockImplementation(async key => (typeof key === 'string' ? { [key]: data[key] } : {}));
    browser.storage.local.set.mockImplementation(async values => { Object.assign(data, values); });
    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async msg =>
      (refuses && msg.cmd === 'memorySearch' ? { error: MEMORY_SEARCH_NEEDS_HELPER_UPDATE } : answer(msg)));

    await deleteOlderThan(page, 30);
    expect(data.chat_turns).toEqual([fresh]);
    expect(page.status()).toContain(`Deleted 2 turns + ${refuses ? 0 : 3} search entries`);
    expect(page.statusIsError()).toBe(refuses);
    expect(helper.stored).toHaveLength(refuses ? 3 : 0);
  });

  it('reports a finished deletion as a success', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const helper = fakeHelper(entriesOf(3, 10, now - 31 * DAY_MS));
    const page = await openPage(helper);
    await deleteOlderThan(page, 30);
    expect(page.status()).toContain('3 search entries');
    expect(page.status()).not.toContain('stopped');
    expect(page.statusIsError()).toBe(false);
  });
});



// One removal settling leaves another's pending state alone, and a search
// whose request is rejected is said and leaves the page as it was.
describe('Chat History removals settle on their own, and a rejected search is said', () => {
  it('one removal failing while another is pending leaves the other pending, sent once', async () => {
    const entries = entriesOf(3, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    const answer = helper.sendMessage.getMockImplementation();
    let releaseFirst;
    let releaseSecond;
    const first = new Promise(resolve => { releaseFirst = resolve; });
    const second = new Promise(resolve => { releaseSecond = resolve; });
    helper.sendMessage.mockImplementation(async message => {
      if (message.cmd === 'memoryRemoveBatch' && message.ids[0] === entries[0].memId) {
        await first;
        return { error: 'first removal refused' };
      }
      if (message.cmd === 'memoryRemoveBatch' && message.ids[0] === entries[1].memId) await second;
      return answer(message);
    });
    const buttons = () => [...page.d.querySelectorAll('#history-list .history-remove-btn')];
    buttons()[0].click();
    buttons()[1].click();
    expect(buttons().map(button => button.disabled)).toEqual([true, true, false]);
    releaseFirst();
    await vi.waitFor(() => expect(page.status()).toContain('first removal refused'));
    try {
      expect(buttons()[0].disabled).toBe(false);
      expect(buttons()[1].disabled).toBe(true);
      expect(buttons()[1].textContent).toBe('Removing…');
      buttons()[1].click();
      expect(helper.sendMessage.mock.calls.filter(([message]) => message.cmd === 'memoryRemoveBatch' && message.ids[0] === entries[1].memId)).toHaveLength(1);
    } finally {
      releaseSecond();
      await vi.waitFor(() => expect(helper.stored).toEqual([entries[0], entries[2]]));
    }
    expect(page.shown()).toEqual([entries[0], entries[2]].map(view));
    expect(buttons().map(button => button.disabled)).toEqual([false, false]);
  });

  it('a rejected search reports its failure, keeps the displayed query and entries, and can search again', async () => {
    const entries = entriesOf(3, 10);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);
    await page.history.searchChatHistory('planning');
    const before = page.shown();
    const answer = helper.sendMessage.getMockImplementation();
    helper.sendMessage.mockImplementation(async message => {
      if (message.cmd === 'memorySearch' && message.q === 'unavailable') throw new Error('helper disconnected');
      return answer(message);
    });
    await page.history.searchChatHistory('unavailable');
    expect(helper.sendMessage.mock.calls.some(([message]) => message.cmd === 'memorySearch' && message.q === 'unavailable')).toBe(true);
    expect(page.status()).toContain('helper disconnected');
    expect(page.statusIsError()).toBe(true);
    expect(page.shown()).toEqual(before);
    expect(page.label()).toContain('"planning" (3 results)');
    expect(helper.stored).toEqual(entries);
    helper.sendMessage.mockImplementation(answer);
    await page.history.searchChatHistory('no-match');
    expect(page.shown()).toEqual([]);
    expect(page.label()).toContain('"no-match" (0 results)');
  });
});
