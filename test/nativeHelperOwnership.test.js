/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Only the context that called initNativeFts (the background, through initFtsEngine) owns the
// native FTS helper. Every other extension page loads its own copy of fts/nativeEngine.js, and
// there no call may connect: the page would start, and own, a second helper process. Such pages
// reach the index through ftsRequest, which asks the background.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { memoryManagement: { nativeRpcTimeoutMs: 1_000 } },
}));

function makeNativePort() {
  const messageListeners = [];
  return {
    onMessage: { addListener: listener => messageListeners.push(listener) },
    onDisconnect: { addListener: () => {} },
    postMessage(message) {
      let result = { ok: true, flags: [true] };
      if (message.method === 'hello') {
        result = { hostVersion: '0.11.2', canSelfUpdate: false, isUserInstall: true, isSystemInstall: false, installPath: '/test/fts-helper' };
      } else if (message.method === 'init') {
        result = { dbPath: '/test/fts.sqlite' };
      }
      Promise.resolve().then(() => {
        for (const listener of messageListeners) listener({ id: message.id, result });
      });
    },
    disconnect() {},
  };
}

function freshContext() {
  vi.resetModules();
  globalThis.browser = {
    tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
    runtime: {
      connectNative: vi.fn(() => makeNativePort()),
      getManifest: vi.fn(() => ({ version: '1.7.2', browser_specific_settings: { gecko: { id: 'thunderbird@tabmail.ai' } } })),
      sendMessage: vi.fn(async () => ({ ok: true, flags: [false] })),
    },
  };
}

afterEach(() => {
  delete globalThis.browser;
});

describe('native FTS helper ownership', () => {
  it('never connects from a context that did not start the helper', async () => {
    freshContext();
    const { nativeFtsSearch, nativeMemorySearch, ownsNativeHelper } = await import('../fts/nativeEngine.js');

    expect(ownsNativeHelper()).toBe(false);
    await expect(nativeFtsSearch.getAttachmentFlags(['account1:/INBOX:a@example.com'])).rejects.toThrow('not connected');
    await expect(nativeFtsSearch.getMessageByMsgId('account1:/INBOX:a@example.com')).rejects.toThrow('not connected');
    await expect(nativeMemorySearch.indexBatch([])).rejects.toThrow('not connected');
    expect(await nativeFtsSearch.recheckAvailability()).toBe(false);
    expect(browser.runtime.connectNative).not.toHaveBeenCalled();
  });

  it('connects in the context that started the helper', async () => {
    freshContext();
    const { initNativeFts, nativeFtsSearch, ownsNativeHelper } = await import('../fts/nativeEngine.js');

    await initNativeFts();
    expect(ownsNativeHelper()).toBe(true);
    await expect(nativeFtsSearch.getAttachmentFlags(['account1:/INBOX:a@example.com'])).resolves.toEqual({ ok: true, flags: [true] });
    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(1);
  });
});

describe('ftsRequest', () => {
  it('asks the background from a context that does not own the helper', async () => {
    freshContext();
    const { ftsRequest } = await import('../fts/ftsRequest.js');
    const direct = vi.fn();

    await expect(ftsRequest('getAttachmentFlags', { msgIds: ['k'] }, direct)).resolves.toEqual({ ok: true, flags: [false] });
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ type: 'fts', cmd: 'getAttachmentFlags', msgIds: ['k'] });
    expect(direct).not.toHaveBeenCalled();
    expect(browser.runtime.connectNative).not.toHaveBeenCalled();
  });

  it('calls the engine directly in the context that owns the helper', async () => {
    freshContext();
    const { initNativeFts } = await import('../fts/nativeEngine.js');
    await initNativeFts();
    const { ftsRequest } = await import('../fts/ftsRequest.js');

    const res = await ftsRequest('getAttachmentFlags', { msgIds: ['k'] }, ({ ftsSearch }) => ftsSearch.getAttachmentFlags(['k']));
    expect(res).toEqual({ ok: true, flags: [true] });
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
