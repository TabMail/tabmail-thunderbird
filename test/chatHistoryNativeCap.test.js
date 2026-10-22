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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/persistentChatStore.js', () => ({ clearAllThinking: vi.fn() }));
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
  const cut = (text, n) => (Number.isInteger(n) && n > 0 ? [...text].slice(0, n).join('') : text);
  const sendMessage = vi.fn(async msg => {
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
  };
}

const search = async (page, query) => {
  page.d.getElementById('history-search-input').value = query;
  page.d.getElementById('history-search-btn').click();
};

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
  it('shows the start of 200 matching sessions of 200 KB, with every reply under the cap', async () => {
    const entries = entriesOf(200, 200_000);
    const helper = fakeHelper(entries);
    const page = await openPage(helper);

    await search(page, 'planning');
    await vi.waitFor(() => expect(page.shown()).toHaveLength(20));
    expect(page.shown()).toEqual(entries.slice(0, 20).map(view));
    expect(page.shown()[0].request).toMatch(/^planning u{100}$/);
    expect(page.shown()[0].reply).toMatch(/^a+…$/);
    // Request then reply, and no note under a reply that shows.
    expect(partsOf(page)).toEqual(Array(20).fill(REQUEST_THEN_REPLY));
    expect(page.pageInfo()).toBe('Page 1 of 10');
    expect(page.d.querySelector('#history-list .search-highlight')?.textContent).toBe('planning');

    page.d.getElementById('history-next-page').click();
    expect(page.pageInfo()).toBe('Page 2 of 10');
    expect(page.shown()).toEqual(entries.slice(20, 40).map(view));
    page.d.getElementById('history-prev-page').click();
    expect(page.pageInfo()).toBe('Page 1 of 10');
    expect(page.shown()).toEqual(entries.slice(0, 20).map(view));

    expect(helper.replies.overCap).toBe(0);
    expect(helper.replies.largest).toBeLessThan(NATIVE_MESSAGE_CAP_BYTES / 4);
    // One search; browsing changes nothing stored.
    expect(helper.replies.calls.map(m => m.cmd).filter(c => c !== 'memoryStats')).toEqual(['memorySearch']);
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
    await vi.waitFor(() => expect(page.shown()).toHaveLength(2));
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
    await vi.waitFor(() => expect(page.shown()).toHaveLength(4));
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
    await vi.waitFor(() => expect(page.shown()).toHaveLength(7));
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
    await vi.waitFor(() => expect(page.shown()).toHaveLength(3));
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

  it('shows HTML-special characters in the request and the reply as text, highlighted, with no element made from them', async () => {
    const entry = {
      memId: 'html', sessionId: 'persistent_chat', role: 'session', dateMs: Date.now() - 60_000,
      content: `[USER]: what's <b>bold</b> & "quoted" planning?\n\n[AGENT]: it's <img src=x onerror="globalThis.__injected=1"> & planning done`,
    };
    const page = await openPage(fakeHelper([entry]));
    await search(page, 'planning');
    await vi.waitFor(() => expect(page.shown()).toHaveLength(1));
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
    await vi.waitFor(() => expect(page.shown()).toHaveLength(20));
    releaseFirst();
    await new Promise(r => setTimeout(r, 0));
    expect(page.shown()).toEqual(entries.slice(0, 20).map(view));
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
    await vi.waitFor(() => expect(page.shown()).toHaveLength(20));
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
