/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    getFullDiag: {},
    getFullCleanupIntervalMinutes: 5,
    getFullTTLSeconds: 60,
    getFullMaxCacheEntries: 10,
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({ getAndClearThink: vi.fn(() => null) }));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
const ftsGet = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../fts/engine.js', () => ({ ftsSearch: { getMessageByMsgId: (...args) => ftsGet(...args) } }));

const alarmName = 'agent-getfull-cleanup';
const key = id => `test-account:/Inbox:message-${id}`;

function setupBrowser() {
  const listeners = new Set();
  const fullCalls = new Map();
  const schedules = new Map();
  const clear = vi.fn(async name => schedules.delete(name));
  const create = vi.fn(async (name, options) => {
    schedules.set(name, { nextAt: Date.now() + options.delayInMinutes * 60_000, periodMs: options.periodInMinutes * 60_000 });
  });
  const getFull = vi.fn(async id => {
    const count = (fullCalls.get(id) ?? 0) + 1;
    fullCalls.set(id, count);
    return { body: `Synthetic message ${id}, fetch ${count}` };
  });
  globalThis.browser = {
    alarms: {
      onAlarm: {
        addListener: vi.fn(listener => listeners.add(listener)),
        removeListener: vi.fn(listener => listeners.delete(listener)),
      },
      clear,
      create,
    },
    messages: {
      get: vi.fn(async id => ({
        id,
        headerMessageId: `<message-${id}>`,
        folder: { accountId: 'test-account', path: '/Inbox' },
      })),
      getFull,
    },
  };
  return {
    listeners, fullCalls, clear, create, schedules,
    fireDue() {
      for (const [name, schedule] of schedules) {
        if (schedule.nextAt > Date.now()) continue;
        schedule.nextAt += schedule.periodMs;
        for (const listener of [...listeners]) listener({ name });
      }
    },
    fire(name = alarmName) {
      for (const listener of [...listeners]) listener({ name });
    },
  };
}

describe('safeGetFull cleanup alarm', () => {
  let now;

  beforeEach(() => {
    vi.resetModules();
    ftsGet.mockReset().mockResolvedValue(null);
    now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.browser;
  });

  it('schedules once while cached reads keep the active body and cleanup expires an idle body', async () => {
    const h = setupBrowser();
    const { safeGetFull, _testCacheInternals } = await import('../agent/modules/utils.js');

    expect(await safeGetFull(101)).toEqual({ body: 'Synthetic message 101, fetch 1' });
    now += 30_000;
    expect(await safeGetFull(102)).toEqual({ body: 'Synthetic message 102, fetch 1' });
    now += 245_000;
    expect(await safeGetFull(102)).toEqual({ body: 'Synthetic message 102, fetch 1' });
    now += 25_001;
    h.fire('unrelated-alarm');
    expect(_testCacheInternals.getFullCache.has(key(101))).toBe(true);
    h.fireDue();

    expect(_testCacheInternals.getFullCache.has(key(101))).toBe(false);
    expect(_testCacheInternals.getFullCache.has(key(102))).toBe(true);
    expect(await safeGetFull(102)).toEqual({ body: 'Synthetic message 102, fetch 1' });
    expect(await safeGetFull(101)).toEqual({ body: 'Synthetic message 101, fetch 2' });
    expect(h.fullCalls.get(101)).toBe(2);
    expect(h.fullCalls.get(102)).toBe(1);
    expect(globalThis.browser.alarms.onAlarm.addListener).toHaveBeenCalledTimes(1);
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledWith(alarmName, {
      delayInMinutes: 5,
      periodInMinutes: 5,
    });
  });

  it('retries failed setup on the next cached read and still expires that body', async () => {
    const h = setupBrowser();
    h.create.mockRejectedValueOnce(new Error('Synthetic alarm failure'));
    const { safeGetFull, _testCacheInternals } = await import('../agent/modules/utils.js');

    expect(await safeGetFull(201)).toEqual({ body: 'Synthetic message 201, fetch 1' });
    expect(await safeGetFull(201)).toEqual({ body: 'Synthetic message 201, fetch 1' });
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.listeners.size).toBe(1);
    expect(h.schedules.has(alarmName)).toBe(true);
    expect(_testCacheInternals.getFullCache.has(key(201))).toBe(true);
    now += 300_001;
    h.fireDue();
    expect(_testCacheInternals.getFullCache.has(key(201))).toBe(false);
    expect(await safeGetFull(201)).toEqual({ body: 'Synthetic message 201, fetch 2' });
    expect(h.fullCalls.get(201)).toBe(2);
  });

  it('coalesces concurrent cache misses and cleans up both bodies', async () => {
    const h = setupBrowser();
    const { safeGetFull, _testCacheInternals } = await import('../agent/modules/utils.js');

    expect(await Promise.all([safeGetFull(301), safeGetFull(302)])).toEqual([
      { body: 'Synthetic message 301, fetch 1' },
      { body: 'Synthetic message 302, fetch 1' },
    ]);
    expect(h.create).toHaveBeenCalledTimes(1);
    now += 60_001;
    h.fire();
    expect(_testCacheInternals.getFullCache.has(key(301))).toBe(false);
    expect(_testCacheInternals.getFullCache.has(key(302))).toBe(false);
  });

  it('can schedule cleanup again after explicit stop', async () => {
    const h = setupBrowser();
    const { safeGetFull, stopGetFullCacheCleanup, _testCacheInternals } =
      await import('../agent/modules/utils.js');

    await safeGetFull(401);
    stopGetFullCacheCleanup();
    await vi.waitFor(() => expect(h.listeners.size).toBe(0));
    expect(await safeGetFull(401)).toEqual({ body: 'Synthetic message 401, fetch 1' });
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.listeners.size).toBe(1);
    now += 60_001;
    h.fire();
    expect(_testCacheInternals.getFullCache.has(key(401))).toBe(false);
  });
});

const fixtureHeader = id => ({
  id,
  headerMessageId: `<message-${id}>`,
  author: 'sender@example.com',
  subject: 'Synthetic subject',
  recipients: ['reader@example.com'],
  folder: { accountId: 'test-account', path: '/Inbox' },
});

describe('safeGetFull cleanup across body sources and callers', () => {
  let now;
  beforeEach(() => {
    vi.resetModules();
    ftsGet.mockReset().mockResolvedValue(null);
    now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.browser;
  });

  it.each([true, false])('keeps one cleanup schedule for native FTS bodies, supplied header=%s', async preheader => {
    const h = setupBrowser();
    let reads = 0;
    ftsGet.mockImplementation(async () => ({ body: `Synthetic FTS body ${++reads}` }));
    const { safeGetFull, _testCacheInternals } = await import('../agent/modules/utils.js');
    const first = await safeGetFull(501, preheader ? fixtureHeader(501) : null);
    expect(first).toMatchObject({ __tmSynthetic: true, __tmSource: 'nativeFts', body: 'Synthetic FTS body 1' });
    now += 290_000;
    expect(await safeGetFull(502, preheader ? fixtureHeader(502) : null)).toMatchObject({ body: 'Synthetic FTS body 2' });
    expect(await safeGetFull(502, preheader ? fixtureHeader(502) : null)).toMatchObject({ body: 'Synthetic FTS body 2' });
    expect(ftsGet).toHaveBeenCalledTimes(2);
    expect(ftsGet).toHaveBeenNthCalledWith(1, key(501));
    expect(ftsGet).toHaveBeenNthCalledWith(2, key(502));
    expect(globalThis.browser.messages.getFull).not.toHaveBeenCalled();
    expect(globalThis.browser.messages.get).toHaveBeenCalledTimes(preheader ? 0 : 2);
    expect(_testCacheInternals.getFullCache.has(key(501))).toBe(true);
    now += 10_001;
    h.fireDue();
    expect(_testCacheInternals.getFullCache.has(key(501))).toBe(false);
    expect(_testCacheInternals.getFullCache.has(key(502))).toBe(true);
    expect(await safeGetFull(501, preheader ? fixtureHeader(501) : null)).toMatchObject({ body: 'Synthetic FTS body 3' });
    expect(globalThis.browser.messages.getFull).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('retains the schedule after a body-fetch failure while later bodies still expire', async () => {
    const h = setupBrowser();
    globalThis.browser.messages.getFull.mockRejectedValueOnce(new Error('Synthetic missing body'));
    const { safeGetFull, _testCacheInternals, getForegroundFetchPressure } = await import('../agent/modules/utils.js');
    await expect(safeGetFull(601)).rejects.toThrow('Synthetic missing body');
    expect(_testCacheInternals.getFullCache.has(key(601))).toBe(false);
    expect(getForegroundFetchPressure()).toMatchObject({ active: 0, waiting: 0 });
    now += 200_000;
    expect(await safeGetFull(602)).toEqual({ body: 'Synthetic message 602, fetch 1' });
    now += 100_001;
    h.fireDue();
    expect(_testCacheInternals.getFullCache.has(key(602))).toBe(false);
    expect(await safeGetFull(602)).toEqual({ body: 'Synthetic message 602, fetch 2' });
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('the production reply filter supplies its header and keeps cleanup active', async () => {
    const h = setupBrowser();
    globalThis.browser.messages.getFull.mockImplementation(async id => ({
      body: `Synthetic body for ${id}`,
      headers: { 'list-unsubscribe': ['https://example.com/preferences'] },
    }));
    const { analyzeEmailForReplyFilter } = await import('../agent/modules/messagePrefilter.js');
    const { _testCacheInternals } = await import('../agent/modules/utils.js');
    for (const id of [701, 702]) {
      expect(await analyzeEmailForReplyFilter(fixtureHeader(id), null, 'Synthetic body')).toEqual({
        hasUnsubscribe: true, isNoReply: false, skipCachedReply: false,
      });
      expect(_testCacheInternals.getFullCache.has(key(id))).toBe(true);
    }
    expect(globalThis.browser.messages.get).not.toHaveBeenCalled();
    expect(globalThis.browser.messages.getFull).toHaveBeenCalledTimes(2);
    now += 300_001;
    h.fireDue();
    expect(_testCacheInternals.getFullCache.has(key(701))).toBe(false);
    expect(_testCacheInternals.getFullCache.has(key(702))).toBe(false);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('a concurrent reader that resumes after another fills the cache refreshes idle expiry', async () => {
    const h = setupBrowser();
    let resolveLateHeader;
    const lateHeader = new Promise(resolve => { resolveLateHeader = resolve; });
    globalThis.browser.messages.get.mockImplementationOnce(() => lateHeader);
    const { safeGetFull, _testCacheInternals } = await import('../agent/modules/utils.js');
    const late = safeGetFull(801);
    const first = await safeGetFull(801);
    expect(first).toEqual({ body: 'Synthetic message 801, fetch 1' });
    now += 50_000;
    resolveLateHeader(fixtureHeader(801));
    expect(await late).toBe(first);
    expect(globalThis.browser.messages.get).toHaveBeenCalledTimes(2);
    expect(globalThis.browser.messages.getFull).toHaveBeenCalledTimes(1);
    now += 20_001;
    h.fire();
    expect(_testCacheInternals.getFullCache.has(key(801))).toBe(true);
    expect(await safeGetFull(801)).toBe(first);
    expect(globalThis.browser.messages.getFull).toHaveBeenCalledTimes(1);
    now += 60_001;
    h.fire();
    expect(_testCacheInternals.getFullCache.has(key(801))).toBe(false);
    expect(await safeGetFull(801)).toEqual({ body: 'Synthetic message 801, fetch 2' });
  });
});
