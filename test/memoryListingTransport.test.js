// TB-069: a no-query memory listing must fit the native-messaging reply cap.
// Thunderbird caps one helper-to-extension message at 1 MiB; a reply over it
// disconnects the helper. The helper's listing returns every row's full
// content, so this runs the PRODUCTION chat settings against a fake helper
// that refuses an over-cap reply the way Thunderbird does, and lists pages
// deep into the store.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: () => {} }));

const NATIVE_MESSAGE_CAP_BYTES = 1024 * 1024;

describe('TB-069: the no-query memory listing and the native-messaging cap', () => {
  it.each([
    ['3000 exchanges of 1 KB', 3000, 1000],
    ['1000 exchanges of 4 KB', 1000, 4000],
    ['300 whole sessions of 100 KB', 300, 100_000],
  ])('lists the newest conversations of %s', async (_name, count, agentChars) => {
    const now = Date.now();
    const rows = Array.from({ length: count }, (_, i) => ({
      memId: `m${i}`,
      content: `[USER]: ${'u'.repeat(100)}\n\n[AGENT]: ${'a'.repeat(agentChars)} #${i}`,
      dateMs: now - (i + 1) * 60_000,
    }));
    globalThis.browser = {
      runtime: {
        sendMessage: vi.fn(async (msg) => {
          if (msg?.cmd !== 'memorySearch') return undefined;
          if (String(msg.q).trim() !== '') return [];
          const to = msg.ignoreDate || msg.to === '' ? Infinity : msg.to;
          const listed = rows.filter((r) => r.dateMs <= to).slice(0, msg.limit).map((r) => ({ ...r, snippet: null }));
          const bytes = Buffer.byteLength(JSON.stringify({ result: listed }), 'utf8');
          return bytes > NATIVE_MESSAGE_CAP_BYTES ? { error: 'Native helper disconnected' } : listed;
        }),
      },
    };
    const memorySearch = await import('../chat/tools/memory_search.js');
    memorySearch.resetPaginationSessions();

    const { CHAT_SETTINGS } = await import('../chat/modules/chatConfig.js');
    const pageSize = CHAT_SETTINGS.searchPageSizeDefault;
    const shownIn = (result) => [...String(result.results).matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1]));

    const first = await memorySearch.run({});
    expect(first).not.toHaveProperty('error');
    expect(shownIn(first)).toEqual(rows.slice(0, pageSize).map((r) => r.dateMs));
    const second = await memorySearch.run({ page_index: 2 });
    expect(second).not.toHaveProperty('error');
    expect(shownIn(second)).toEqual(rows.slice(pageSize, 2 * pageSize).map((r) => r.dateMs));
    const deep = await memorySearch.run({ page_index: 6 });
    expect(deep).not.toHaveProperty('error');
    expect(shownIn(deep)).toEqual(rows.slice(5 * pageSize, 6 * pageSize).map((r) => r.dateMs));
  });
});
