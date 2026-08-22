/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { memoryManagement: { nativeRpcTimeoutMs: 1_000 } },
}));

function makeNativePort(optimizeResult) {
  const messageListeners = [];
  const disconnectListeners = [];
  const messages = [];

  return {
    messages,
    onMessage: { addListener: listener => messageListeners.push(listener) },
    onDisconnect: { addListener: listener => disconnectListeners.push(listener) },
    postMessage(message) {
      messages.push(message);
      let result;
      if (message.method === 'hello') {
        result = {
          hostVersion: '0.11.2',
          canSelfUpdate: false,
          isUserInstall: true,
          isSystemInstall: false,
          installPath: '/test/fts-helper',
        };
      } else if (message.method === 'init') {
        result = { dbPath: '/test/fts.sqlite' };
      } else if (message.method === 'optimize') {
        result = optimizeResult;
      }
      Promise.resolve().then(() => {
        for (const listener of messageListeners) listener({ id: message.id, result });
      });
    },
    disconnect() {
      for (const listener of disconnectListeners) listener();
    },
  };
}

async function initializedNativeSearch(optimizeResult) {
  vi.resetModules();
  const port = makeNativePort(optimizeResult);
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

describe('native optimize RPC boundary', () => {
  it.each([
    ['exact acknowledgment', { ok: true }],
    ['forward-compatible acknowledgment', { ok: true, futureField: 1 }],
  ])('sends no invented parameters and accepts a %s', async (_label, response) => {
    const { nativeFtsSearch, port } = await initializedNativeSearch(response);

    await expect(nativeFtsSearch.optimize()).resolves.toEqual(response);

    const optimizeMessage = port.messages.find(message => message.method === 'optimize');
    expect(optimizeMessage).toMatchObject({ method: 'optimize', params: {} });
    expect(Object.keys(optimizeMessage.params)).toEqual([]);
  });

  it.each([
    ['missing ok', {}],
    ['false ok', { ok: false }],
    ['null response', null],
    ['invented slice telemetry', { steps: 3, totalChanges: 0, converged: true }],
  ])('rejects a %s response', async (_label, response) => {
    const { nativeFtsSearch } = await initializedNativeSearch(response);

    await expect(nativeFtsSearch.optimize()).rejects.toThrow(
      'Native FTS optimize returned an invalid response',
    );
  });
});
