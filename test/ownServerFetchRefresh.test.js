/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// The token refresh, the request that carries the refresh token in its body, against a sign-in server
// that answers with a method-keeping redirect (307 or 308) to another address: the refresh token never
// reaches the other address, the refresh fails as a transient error through its bounded retries, and the
// stored session is kept (a redirect never signs the user out). Real supabaseAuth, real fetch, two
// loopback servers (test/support/redirectServers.js).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { redirectServers } from './support/redirectServers.js';

const target = vi.hoisted(() => ({ origin: '' }));
vi.mock('../agent/modules/config.js', async () => {
  const actual = await vi.importActual('../agent/modules/config.js');
  return {
    getBackendUrl: vi.fn(async () => 'https://backend.example.com'),
    SETTINGS: new Proxy(actual.SETTINGS, { get: (o, k) => (k === 'supabaseUrl' ? target.origin : o[k]) }),
  };
});
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/deviceSync.js', () => ({ changeAccount: vi.fn(async (storeSession) => storeSession()) }));

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (key) => (storageData[key] !== undefined ? { [key]: storageData[key] } : {})),
      set: vi.fn(async (obj) => { Object.assign(storageData, obj); }),
      remove: vi.fn(async (key) => { delete storageData[key]; }),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: { getManifest: vi.fn(() => ({ version: '9.9.9' })) },
};

const { SETTINGS } = await import('../agent/modules/config.js');
const auth = await import('../agent/modules/supabaseAuth.js');
// As the background page, the one place the session is stored.
auth.initSessionHost();

const expired = () => ({
  access_token: 'synthetic-access',
  refresh_token: 'synthetic-refresh',
  expires_at: Math.floor(Date.now() / 1000) - 1,
});

describe('a token refresh answered with a redirect', () => {
  let s;
  beforeEach(() => { for (const k of Object.keys(storageData)) delete storageData[k]; });
  afterEach(async () => { await s?.close(); s = null; });

  // The bounded retries back off 1 s then 2 s between the attempts.
  const RETRY_WAIT_MS = 1000 * (2 ** (SETTINGS.authTokenRefreshRetries - 1) - 1);

  for (const status of [307, 308]) {
    it(`${status}: the refresh token goes to no other address and the session is kept`, async () => {
      s = await redirectServers(status);
      target.origin = s.firstOrigin;
      const session = expired();
      storageData.supabaseSession = structuredClone(session);

      expect(await auth.getAccessToken()).toBeNull();

      // Sent to our server, with the refresh token, once per bounded attempt.
      expect(s.asked).toHaveLength(SETTINGS.authTokenRefreshRetries);
      for (const r of s.asked) {
        expect(r.method).toBe('POST');
        expect(JSON.parse(r.body)).toEqual({ refresh_token: 'synthetic-refresh' });
      }
      // Never to the address the redirect named.
      expect(s.reached).toEqual([]);
      // A transient failure: the stored session stays.
      expect(storageData.supabaseSession).toEqual(session);
    }, RETRY_WAIT_MS + 10000);
  }
});
