// TB-069: a no-query memory listing must fit the native-messaging reply cap.
// Thunderbird caps one helper-to-extension message at 1 MiB; a reply over it
// disconnects the helper. The helper's listing returns every row's full
// content in one reply, so this runs the PRODUCTION chat settings against a
// fake helper that refuses an over-cap reply the way Thunderbird does.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: () => {} }));
vi.mock('../chat/modules/helpers.js', () => ({
  toIsoNoMs: (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
}));

const NATIVE_MESSAGE_CAP_BYTES = 1024 * 1024;

describe('TB-069: the no-query memory listing and the native-messaging cap', () => {
  it.each([
    ['3000 exchanges of 1 KB', 3000, 1000],
    ['1000 exchanges of 4 KB', 1000, 4000],
  ])('lists the newest conversations of %s', async (_name, count, agentChars) => {
    const now = Date.now();
    const rows = Array.from({ length: count }, (_, i) => ({
      content: `[USER]: ${'u'.repeat(100)}\n\n[AGENT]: ${'a'.repeat(agentChars)} #${i}`,
      dateMs: now - (i + 1) * 60_000,
    }));
    globalThis.browser = {
      runtime: {
        sendMessage: vi.fn(async (msg) => {
          if (msg?.cmd !== 'memorySearch') return undefined;
          if (String(msg.q).trim() !== '') return [];
          const listed = rows.slice(0, msg.limit).map((r) => ({ ...r, snippet: null }));
          const bytes = Buffer.byteLength(JSON.stringify({ result: listed }), 'utf8');
          return bytes > NATIVE_MESSAGE_CAP_BYTES ? { error: 'Native helper disconnected' } : listed;
        }),
      },
    };
    const memorySearch = await import('../chat/tools/memory_search.js');
    memorySearch.resetPaginationSessions();

    const listed = await memorySearch.run({});
    expect(listed).not.toHaveProperty('error');
    const shown = [...String(listed.results).matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1]));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(rows.slice(0, shown.length).map((r) => r.dateMs));
  });
});
