/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// signInAccountSwitch.test.js — the sign-in window's last step (R34): a sign-in keeps everything on this
// device, whichever account signs in; the sign-in only chooses the Device Sync group and who is billed
// (DS-DEVICE). It never reaches the prompt store: a late AI result after it is ordinary device data.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const storageData = {};
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/deviceSync.js', () => ({ cleanupDeviceSync: vi.fn(async () => {}), connect: vi.fn(async () => {}) }));
vi.mock('../agent/modules/config.js', () => ({
  getBackendUrl: vi.fn(async () => 'https://backend.example.com'),
  SETTINGS: { authSignInTimeoutMs: 60 * 1000, authWindow: { defaultWidth: 500, defaultHeight: 700 } },
}));

/** An access token whose payload is `claims` (base64url, unsigned here). */
function token(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${part({ alg: 'none' })}.${part(claims)}.signature`;
}

const NEW_SESSION = { access_token: token({ sub: 'account-two' }), refresh_token: 'synthetic-refresh', expires_at: 0, user: { id: 'account-two', email: 'user@example.com' } };
const DONE_URL = `https://tabmail.ai/auth/tb-done#s=${Buffer.from(JSON.stringify(NEW_SESSION)).toString('base64')}`;

const browserMock = {
  storage: {
    local: {
      get: vi.fn(async (keys) => {
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
        return Object.fromEntries(list.filter((key) => storageData[key] !== undefined).map((key) => [key, structuredClone(storageData[key])]));
      }),
      set: vi.fn(async (values) => {
        Object.assign(storageData, structuredClone(values));
      }),
      remove: vi.fn(async (keys) => {
        for (const key of typeof keys === 'string' ? [keys] : keys) delete storageData[key];
      }),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  windows: {
    create: vi.fn(async () => ({ id: 41 })),
    get: vi.fn(async () => ({ id: 41 })),
    remove: vi.fn(async () => {}),
  },
  tabs: {
    query: vi.fn(async () => [{ id: 42 }]),
    get: vi.fn(async () => ({ id: 42, url: DONE_URL })),
    update: vi.fn(async () => {}),
  },
  webNavigation: { onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() } },
  runtime: { getURL: (path) => `moz-extension://synthetic/${path}` },
};
globalThis.browser = browserMock;

const { ensureSignedIn, initSessionHost } = await import('../agent/modules/supabaseAuth.js');
// As the background page, the one place the session is stored.
initSessionHost();

/** Runs the sign-in to its end, the window's polls and waits passing at once. */
async function signIn() {
  const result = ensureSignedIn();
  await vi.runAllTimersAsync();
  return result;
}

beforeEach(() => {
  for (const key of Object.keys(storageData)) delete storageData[key];
  vi.clearAllMocks();
  vi.useFakeTimers();
  // The consent check after sign-in is out of scope here: it fails, which sign-in treats as non-fatal.
  globalThis.fetch = vi.fn(async () => { throw new Error('synthetic network off'); });
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.fetch;
});

describe("the sign-in window's last step (R34)", () => {
  it("keeps every text, template, history entry and setting when a different account signs in", async () => {
    const kept = {
      'user_prompts:user_kb.md': '- Fact from the previous account',
      'bullet_state:kb': { bullets: [{ label: 'aaaaaaaa00000001', section: '', text: 'Fact from the previous account' }] },
      user_templates: [{ id: 't1', name: 'Template' }],
      prompt_history: [{ id: 'h1' }],
      device_sync_auto_enabled: true,
      some_setting: 'kept',
    };
    Object.assign(storageData, structuredClone(kept), { supabaseSession: { access_token: token({ sub: 'account-one' }) } });

    expect(await signIn()).toBe(true);

    const { supabaseSession, tabmailConsentRequired, ...rest } = storageData;
    expect(rest).toEqual(kept);
    expect(supabaseSession.access_token).toBe(NEW_SESSION.access_token);
    expect(browserMock.storage.local.remove).not.toHaveBeenCalled();
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it("never reaches the prompt store, so it never waits for it", async () => {
    expect(await signIn()).toBe(true);
    expect(storageData.supabaseSession.access_token).toBe(NEW_SESSION.access_token);
    const source = readFileSync(new URL('../agent/modules/supabaseAuth.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/promptStore/);
  });
});
