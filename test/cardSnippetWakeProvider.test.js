import { afterEach, describe, expect, it, vi } from 'vitest';

const { uniqueKey, getFull, plainText, getCached, setCached } = vi.hoisted(() => ({
  uniqueKey: vi.fn(async () => 'synthetic:Inbox:1'),
  getFull: vi.fn(async () => ({ parts: [] })),
  plainText: vi.fn(async () => 'First line\nSecond line'),
  getCached: vi.fn(async () => new Map()),
  setCached: vi.fn(async () => {}),
}));

vi.mock('../agent/modules/utils.js', () => ({
  getUniqueMessageKey: uniqueKey,
  safeGetFull: getFull,
}));
vi.mock('../fts/bodyExtract.js', () => ({ extractPlainText: plainText }));
vi.mock('../theme/modules/snippetCache.js', () => ({
  getSnippetsBatch: getCached,
  setSnippet: setCached,
  getStats: () => ({}),
}));

import { createCardSnippetProvider } from '../theme/modules/cardSnippetProvider.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('card snippet wake consumer', () => {
  it('retries failed event registration and retains ownership after failed removal', () => {
    const listeners = new Set();
    let failAdd = true;
    let failRemove = true;
    const event = {
      addListener: vi.fn(listener => {
        if (failAdd) { failAdd = false; throw new Error('synthetic add failure'); }
        listeners.add(listener);
      }),
      removeListener: vi.fn(listener => {
        if (failRemove) { failRemove = false; throw new Error('synthetic remove failure'); }
        listeners.delete(listener);
      }),
    };
    vi.stubGlobal('browser', { tmMessageListCardView: { onSnippetsNeeded: event } });
    const provider = createCardSnippetProvider({ getNeeds: vi.fn(async () => []), provideSnippets: vi.fn() });
    provider.start();
    expect(listeners.size).toBe(0);
    provider.start();
    provider.start();
    expect(listeners.size).toBe(1);
    expect(event.addListener).toHaveBeenCalledTimes(2);
    provider.stop();
    provider.start();
    expect(listeners.size).toBe(1);
    expect(event.addListener).toHaveBeenCalledTimes(2);
    provider.stop();
    expect(listeners.size).toBe(0);
  });

  it('handles a new uncached need after background load and detaches cleanly', async () => {
    const listeners = new Set();
    const event = {
      addListener: vi.fn(listener => listeners.add(listener)),
      removeListener: vi.fn(listener => listeners.delete(listener)),
      emit(info) { for (const listener of [...listeners]) listener(info); },
    };
    vi.stubGlobal('browser', { tmMessageListCardView: { onSnippetsNeeded: event } });
    const need = { hdrKey: 'synthetic-header-1', msgId: 'synthetic@example.test', weId: 1 };
    const getNeeds = vi.fn()
      .mockResolvedValueOnce([]) // Registration runs before theme experiment init.
      .mockResolvedValueOnce([need])
      .mockResolvedValue([]);
    const provideSnippets = vi.fn(async () => ({ ok: true, applied: 1 }));
    const provider = createCardSnippetProvider({ getNeeds, provideSnippets });

    provider.start();
    await vi.waitFor(() => expect(getNeeds).toHaveBeenCalledTimes(1));
    provider.start();
    expect(listeners.size).toBe(1);
    expect(event.addListener).toHaveBeenCalledTimes(1);

    event.emit({ count: 1 });
    await vi.waitFor(() => expect(provideSnippets).toHaveBeenCalledExactlyOnceWith({
      items: [{ hdrKey: 'synthetic-header-1', snippet: 'First line Second line' }],
      source: 'mv3-provider',
    }));
    expect(uniqueKey).toHaveBeenCalledExactlyOnceWith(1);
    expect(getFull).toHaveBeenCalledExactlyOnceWith(1);
    expect(plainText).toHaveBeenCalledExactlyOnceWith({ parts: [] }, 1);
    expect(getCached).toHaveBeenCalledExactlyOnceWith(['synthetic:Inbox:1']);
    expect(setCached).toHaveBeenCalledExactlyOnceWith('synthetic:Inbox:1', 'First line Second line');

    provider.stop();
    expect(listeners.size).toBe(0);
    const callsAfterStop = getNeeds.mock.calls.length;
    event.emit({ count: 2 });
    expect(getNeeds).toHaveBeenCalledTimes(callsAfterStop);

    provider.start();
    expect(listeners.size).toBe(1);
    await vi.waitFor(() => expect(getNeeds).toHaveBeenCalledTimes(callsAfterStop + 1));
    provider.stop();
    expect(listeners.size).toBe(0);
  });
});
