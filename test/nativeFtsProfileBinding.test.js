/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The native FTS helper cannot tell which Thunderbird profile started it.
// Left to itself it opens the most recently modified profile's index, so with
// two profiles in use one would reconcile against, and remove rows from, the
// other's index. The helper must be told this profile's data directory, and
// must never be initialized without it.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { memoryManagement: { nativeRpcTimeoutMs: 1_000 } },
}));

const PROFILE_DATA_DIR = '/profiles/profile-b/browser-extension-data/thunderbird@tabmail.ai';

function makeNativePort(messages) {
  const messageListeners = [];
  return {
    onMessage: { addListener: listener => messageListeners.push(listener) },
    onDisconnect: { addListener: () => {} },
    postMessage(message) {
      messages.push(message);
      let result = { ok: true };
      if (message.method === 'hello') {
        result = { hostVersion: '0.11.5', canSelfUpdate: false, isUserInstall: true, isSystemInstall: false, installPath: '/test/fts-helper' };
      } else if (message.method === 'init') {
        result = { dbPath: '/test/fts.sqlite' };
      }
      Promise.resolve().then(() => {
        for (const listener of messageListeners) listener({ id: message.id, result });
      });
    },
    disconnect: vi.fn(),
  };
}

function freshContext(getFtsDataDir) {
  vi.resetModules();
  const messages = [];
  globalThis.browser = {
    runtime: {
      connectNative: vi.fn(() => makeNativePort(messages)),
      getManifest: vi.fn(() => ({ version: '1.9.0', browser_specific_settings: { gecko: { id: 'thunderbird@tabmail.ai' } } })),
    },
    tmMsgNotify: { getFtsDataDir: vi.fn(getFtsDataDir) },
  };
  return messages;
}

afterEach(() => {
  delete globalThis.browser;
});

describe('native FTS helper profile binding', () => {
  it("initializes the helper on this profile's data directory", async () => {
    const messages = freshContext(async () => PROFILE_DATA_DIR);
    const { initNativeFts } = await import('../fts/nativeEngine.js');

    await initNativeFts();

    const inits = messages.filter(message => message.method === 'init');
    expect(inits).toHaveLength(1);
    expect(inits[0].params.profilePath).toBe(PROFILE_DATA_DIR);
  });

  it.each([
    ['the directory lookup fails', async () => { throw new Error('experiment unavailable'); }],
    ['the directory is empty', async () => ''],
    ['the directory is missing', async () => undefined],
  ])('never initializes the helper when %s', async (_label, getFtsDataDir) => {
    const messages = freshContext(getFtsDataDir);
    const { initNativeFts, nativeFtsSearch } = await import('../fts/nativeEngine.js');

    await expect(initNativeFts()).rejects.toThrow();

    expect(messages.some(message => message.method === 'hello')).toBe(true);
    expect(messages.some(message => message.method === 'init')).toBe(false);
    expect(nativeFtsSearch.getHostStatus().status).toBe('missing');
  });
});

describe('tmMsgNotify.getFtsDataDir', () => {
  it("names the profile's data directory for this extension", async () => {
    const source = readFileSync(new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url), 'utf8');
    const sandbox = {
      ChromeUtils: { importESModule(path) {
        if (path.includes('ExtensionCommon')) return { ExtensionCommon: {
          ExtensionAPIPersistent: class { constructor(extension) { this.extension = extension; } },
          EventManager: class { api() { return {}; } },
        } };
        if (path.includes('Timer')) return { clearInterval: vi.fn(), setInterval: vi.fn(() => 1) };
        return {};
      } },
      console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
      PathUtils: {
        profileDir: '/profiles/profile-b',
        join: (...parts) => parts.join('/'),
      },
    };
    vm.runInNewContext(`${source}\nglobalThis.Experiment = tmMsgNotify;`, sandbox);
    const extension = { id: 'thunderbird@tabmail.ai', folderManager: {}, messageManager: {} };
    const api = new sandbox.Experiment(extension).getAPI({ extension }).tmMsgNotify;

    await expect(api.getFtsDataDir()).resolves.toBe(PROFILE_DATA_DIR);
  });

  it('is declared in the experiment schema', () => {
    const schema = JSON.parse(readFileSync(new URL('../agent/experiments/tmMsgNotify/schema.json', import.meta.url), 'utf8'));
    const fn = schema[0].functions.find(entry => entry.name === 'getFtsDataDir');
    expect(fn).toMatchObject({ async: true, parameters: [], returns: { type: 'string' } });
  });
});
