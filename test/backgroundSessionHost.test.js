/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// backgroundSessionHost.test.js — the background page is the one place the session is stored
// (supabaseAuth.js storeSession), so Device Sync follows every account change. background.js makes itself
// that place when it loads, and its runtime-message listener stores a page's session write: a token
// refresh in a page answered for another account moves the device to the new account's devices.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';

const ROOT = new URL('../', import.meta.url);
const AUTH = 'agent/modules/supabaseAuth.js';
const SUPABASE = 'https://auth.example.com';
const SOURCE = readFileSync(new URL('agent/background.js', ROOT), 'utf8');
const AST = parse(SOURCE, { ecmaVersion: 'latest', sourceType: 'module' });

function token(account) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ sub: account })}.signature`;
}

function accountOf(accessToken) {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).sub;
}

function session(account, expiresInS) {
  return { access_token: token(account), refresh_token: `refresh-${account}`, expires_at: Math.floor(Date.now() / 1000) + expiresInS };
}

/** background.js's runtime-message listener as the background registers it, its session writes going to
 * `auth` (the background's supabaseAuth). Returns `request(message)` → the reply. */
function backgroundListener(auth) {
  const node = AST.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'setupRuntimeMessageListener');
  let listener;
  const context = vm.createContext({
    log() {}, cleanupRuntimeListeners() {},
    handleStoreSessionMessage: auth.handleStoreSessionMessage,
    browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    __import: async (path) => { throw new Error(`unexpected import ${path}`); },
  });
  vm.runInContext(SOURCE.slice(node.start, node.end).replaceAll('import(', '__import('), context);
  vm.runInContext('setupRuntimeMessageListener()', context);
  return (message) => new Promise((resolve, reject) => {
    try {
      const returned = listener(structuredClone(message), {}, (reply) => resolve(structuredClone(reply)));
      if (returned !== true) Promise.resolve(returned).then(resolve, reject);
    } catch (error) { reject(error); }
  });
}

describe('the background stores the session for every page', () => {
  it('makes itself the one place the session is stored when it loads', () => {
    const imported = AST.body.find((n) => n.type === 'ImportDeclaration' && n.source.value === './modules/supabaseAuth.js');
    expect(imported.specifiers.map((s) => s.imported.name)).toContain('initSessionHost');
    const calls = AST.body.filter((n) => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression' && n.expression.callee.name === 'initSessionHost');
    expect(calls).toHaveLength(1);
  });

  it("stores a page's token refresh answered for another account, and Device Sync moves to that account's devices", async () => {
    const groups = { A: new BulletRelay(), B: new BulletRelay() };
    const fetch = async (url, init, bundled) => (String(url).startsWith(`${SUPABASE}/auth/v1/token`)
      ? { ok: true, status: 200, json: async () => session('B', 3600) }
      : bundled(url, init));
    const d = await new BulletDevice('D', new DeviceStore({ supabaseSession: session('A', 3600) }), groups.A, {
      files: [AUTH], fetch,
      settings: { supabaseUrl: SUPABASE, supabaseAnonKey: 'synthetic-anon', authTokenRefreshRetries: 1, authTokenRefreshTimeoutMs: 5000 },
      globals: { atob: globalThis.atob, AbortController },
      groupFor: (url) => groups[accountOf(new URL(url).searchParams.get('token'))],
    }).start();
    await d.connect();
    expect(groups.A.isConnected('D')).toBe(true);
    const request = backgroundListener(d.auth);
    // A page whose runtime messages reach the background's listener.
    const page = d.page([AUTH], {}, { browser: { storage: d.store.api(), runtime: { sendMessage: request } } });
    d.store.values.supabaseSession.expires_at = Math.floor(Date.now() / 1000) + 30;

    expect(await page.require(AUTH).getAccessToken()).toBe(token('B'));

    expect(accountOf(d.store.values.supabaseSession.access_token)).toBe('B');
    expect(groups.A.isConnected('D')).toBe(false);
    await vi.waitFor(() => expect(groups.B.isConnected('D')).toBe(true));
    await d.sync.cleanupDeviceSync();
  });
});
