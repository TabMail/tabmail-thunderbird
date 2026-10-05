/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The wire contract with tabmail-native-fts for getAttachmentFlags: the request is
// { method: 'getAttachmentFlags', params: { msgIds } } and the helper's { ok, flags } comes back
// unchanged. A helper error (an older helper does not know the method) rejects the call.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { memoryManagement: { nativeRpcTimeoutMs: 1_000 } },
}));

function makeNativePort(answer) {
  const messageListeners = [];
  const messages = [];

  return {
    messages,
    onMessage: { addListener: listener => messageListeners.push(listener) },
    onDisconnect: { addListener: () => {} },
    postMessage(message) {
      messages.push(message);
      let reply = { id: message.id };
      if (message.method === 'hello') {
        reply.result = {
          hostVersion: '0.11.2',
          canSelfUpdate: false,
          isUserInstall: true,
          isSystemInstall: false,
          installPath: '/test/fts-helper',
        };
      } else if (message.method === 'init') {
        reply.result = { dbPath: '/test/fts.sqlite' };
      } else if (message.method === 'getAttachmentFlags') {
        reply = { id: message.id, ...answer };
      }
      Promise.resolve().then(() => {
        for (const listener of messageListeners) listener(reply);
      });
    },
    disconnect() {},
  };
}

async function initializedNativeSearch(answer) {
  vi.resetModules();
  const port = makeNativePort(answer);
  globalThis.browser = {
    runtime: {
      connectNative: vi.fn(() => port),
      getManifest: vi.fn(() => ({
        version: '1.7.2',
        browser_specific_settings: { gecko: { id: 'thunderbird@tabmail.ai' } },
      })),
    },
  };
  const { initNativeFts, nativeFtsSearch } = await import('../fts/nativeEngine.js');
  await initNativeFts();
  return { nativeFtsSearch, port };
}

afterEach(() => {
  delete globalThis.browser;
});

describe('native getAttachmentFlags RPC boundary', () => {
  it('sends the msgIds under their wire names and returns the helper\'s answer', async () => {
    const result = { ok: true, flags: [false, null, true] };
    const { nativeFtsSearch, port } = await initializedNativeSearch({ result });
    const msgIds = ['account1:/INBOX:a@example.com', 'account1:/INBOX:b@example.com', 'account1:/INBOX:c@example.com'];

    await expect(nativeFtsSearch.getAttachmentFlags(msgIds)).resolves.toEqual(result);

    const sent = port.messages.filter(message => message.method === 'getAttachmentFlags');
    expect(sent).toHaveLength(1);
    expect(sent[0].params).toEqual({ msgIds });
  });

  it('rejects when the helper answers an error, as one too old to know the method does', async () => {
    const { nativeFtsSearch } = await initializedNativeSearch({ error: 'Unknown method: getAttachmentFlags' });

    await expect(nativeFtsSearch.getAttachmentFlags(['account1:/INBOX:a@example.com']))
      .rejects.toThrow('Unknown method: getAttachmentFlags');
  });
});
