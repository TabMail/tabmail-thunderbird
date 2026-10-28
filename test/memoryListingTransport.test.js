// TB-069: memory_search replies must fit the native-messaging reply cap.
// Thunderbird caps one helper-to-extension message at 1 MiB; a reply over it
// disconnects the helper. Memory rows are stored whole, so this runs the
// PRODUCTION chat settings against a fake helper that cuts each result to the
// previewChars asked (as the helper does) and refuses an over-cap reply the way
// Thunderbird does, listing pages deep into the store and searching it.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: () => {} }));
// The tools run here as a page: nothing here starts the native helper, so what
// they ask goes to the background as a message (fts/ftsRequest.js), which
// `sendMessage` below answers. test/memoryToolsContext.test.js covers the
// background. `storage` is what the helper module reads when it loads.
const PAGE_STORAGE = { onChanged: { addListener() {} }, local: { get: async defaults => ({ ...defaults }) } };

const NATIVE_MESSAGE_CAP_BYTES = 1024 * 1024;

function rowsOf(count, agentChars) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    memId: `m${i}`,
    content: `[USER]: ${'u'.repeat(100)}\n\n[AGENT]: ${'a'.repeat(agentChars)} #${i}`,
    dateMs: now - (i + 1) * 60_000,
  }));
}

// Every row matches a query, with a snippet as long as the row. A helper from
// before previews (`whole`) ignores previewChars and answers whole rows.
function fakeHelper(rows, { whole = false } = {}) {
  globalThis.browser = {
    storage: PAGE_STORAGE,
    runtime: {
      sendMessage: vi.fn(async (msg) => {
        if (msg?.cmd !== 'memorySearch') return undefined;
        const query = String(msg.q).trim() !== '';
        const to = msg.ignoreDate || msg.to === '' ? Infinity : msg.to;
        const cut = (text) => (!whole && Number.isInteger(msg.previewChars) && msg.previewChars > 0 ? [...text].slice(0, msg.previewChars).join('') : text);
        const found = rows
          .filter((r) => r.dateMs <= to)
          .slice(0, msg.limit)
          .map((r) => ({ ...r, content: cut(r.content), snippet: query ? cut(r.content) : null }));
        const bytes = Buffer.byteLength(JSON.stringify({ result: found }), 'utf8');
        return bytes > NATIVE_MESSAGE_CAP_BYTES ? { error: 'Native helper disconnected' } : found;
      }),
    },
  };
}

async function setUp(rows, helper) {
  fakeHelper(rows, helper);
  const memorySearch = await import('../chat/tools/memory_search.js');
  memorySearch.resetPaginationSessions();
  const { CHAT_SETTINGS } = await import('../chat/modules/chatConfig.js');
  return { memorySearch, pageSize: CHAT_SETTINGS.searchPageSizeDefault, CHAT_SETTINGS };
}

const shownIn = (result) => [...String(result.results).matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1]));

describe('TB-069: memory_search and the native-messaging cap', () => {
  it.each([
    ['3000 exchanges of 1 KB', 3000, 1000],
    ['1000 exchanges of 4 KB', 1000, 4000],
    ['300 whole sessions of 100 KB', 300, 100_000],
    ['200 whole sessions of 200 KB', 200, 200_000],
  ])('lists the newest conversations of %s', async (_name, count, agentChars) => {
    const rows = rowsOf(count, agentChars);
    const { memorySearch, pageSize, CHAT_SETTINGS } = await setUp(rows);

    const first = await memorySearch.run({});
    expect(first).not.toHaveProperty('error');
    expect(shownIn(first)).toEqual(rows.slice(0, pageSize).map((r) => r.dateMs));
    const second = await memorySearch.run({ page_index: 2 });
    expect(second).not.toHaveProperty('error');
    expect(shownIn(second)).toEqual(rows.slice(pageSize, 2 * pageSize).map((r) => r.dateMs));
    // A listing ends at a search's worth (memorySearchMaxResults): a page past it is its last.
    const last = CHAT_SETTINGS.memorySearchMaxResults / pageSize;
    const deep = await memorySearch.run({ page_index: last + 1 });
    expect(deep).not.toHaveProperty('error');
    expect(deep).toMatchObject({ page: last, totalItems: CHAT_SETTINGS.memorySearchMaxResults });
    expect(shownIn(deep)).toEqual(rows.slice((last - 1) * pageSize, last * pageSize).map((r) => r.dateMs));
  });

  it.each([
    ['3000 matching exchanges of 1 KB', 3000, 1000],
    ['200 matching sessions of 200 KB', 200, 200_000],
  ])('searches %s', async (_name, count, agentChars) => {
    const rows = rowsOf(count, agentChars);
    const { memorySearch, pageSize } = await setUp(rows);

    const first = await memorySearch.run({ query: 'planning' });
    expect(first).not.toHaveProperty('error');
    expect(shownIn(first)).toEqual(rows.slice(0, pageSize).map((r) => r.dateMs));
    const second = await memorySearch.run({ query: 'planning', page_index: 2 });
    expect(shownIn(second)).toEqual(rows.slice(pageSize, 2 * pageSize).map((r) => r.dateMs));
  });

  // A helper from before previews returns whole rows: the listing's few rows
  // per request still keep long sessions under the cap, and a search of short
  // exchanges fits its 100 matches.
  it.each([
    ['3000 exchanges of 1 KB', 3000, 1000],
    ['300 whole sessions of 100 KB', 300, 100_000],
  ])('lists the newest conversations of %s from a helper without previews', async (_name, count, agentChars) => {
    const rows = rowsOf(count, agentChars);
    const { memorySearch, pageSize } = await setUp(rows, { whole: true });
    const deep = await memorySearch.run({ page_index: 5 });
    expect(deep).not.toHaveProperty('error');
    expect(shownIn(deep)).toEqual(rows.slice(4 * pageSize, 5 * pageSize).map((r) => r.dateMs));
  });

  it('searches 3000 matching exchanges of 1 KB from a helper without previews', async () => {
    const rows = rowsOf(3000, 1000);
    const { memorySearch, pageSize } = await setUp(rows, { whole: true });
    const first = await memorySearch.run({ query: 'planning' });
    expect(first).not.toHaveProperty('error');
    expect(shownIn(first)).toEqual(rows.slice(0, pageSize).map((r) => r.dateMs));
  });
});
