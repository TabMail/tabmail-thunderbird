/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// deviceSyncFollowsAccount.test.js — the sign-in is which devices this one syncs with (DS-DEVICE). On
// every path that changes the signed-in account (a sign-in from the popup, an automatic re-sign-in after
// an AI call is refused, from the background or a chat window, a token refresh answered for another
// account, from the background or a page, a refused refresh, a sign-out), Device Sync leaves the old
// account's devices before the new session is stored: from then on nothing this device sends reaches
// them and nothing they sent is applied. Then it syncs with the new account's devices. A sign-in or
// refresh of the same account keeps the connection. Simulated devices (bulletDevices.js) with the real
// supabaseAuth, Device Sync and prompt store; each connection joins the group of its token's account.

import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';

const AUTH = 'agent/modules/supabaseAuth.js';
const SUPABASE = 'https://auth.example.com';
const HOUR_S = 3600;

/** An access token issued to `account` (base64url, unsigned here). */
function token(account, serial = 1) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${part({ alg: 'none' })}.${part({ sub: account, serial })}.signature`;
}

function accountOf(accessToken) {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).sub;
}

/** A session of `account`, valid for an hour. */
function session(account, serial = 1) {
  return { access_token: token(account, serial), refresh_token: `refresh-${account}-${serial}`, expires_at: Math.floor(Date.now() / 1000) + HOUR_S };
}

/** An AI call's reply refused for authentication. */
function refused() {
  return { status: 401, headers: { get: () => 'text/plain' }, clone() { return this; } };
}

/** Every pending part on the groups delivered, oldest first. */
async function quiesce(groups) {
  for (let n = 0; n < 10000; n++) {
    let delivered = false;
    for (const group of groups) delivered = (await group.deliverOldest()) || delivered;
    if (!delivered) return;
  }
  throw new Error('the groups never went quiet');
}

async function kb(d) {
  return (await d.state('kb')).bullets.map((bullet) => bullet.text);
}

/** What `d` has sent on `group`: bullet snapshots per field and other messages. */
function sentBy(group, d) {
  return { kb: group.sent(d.id, 'kb'), composition: group.sent(d.id, 'composition'), action: group.sent(d.id, 'action'), legacy: group.legacy.filter(({ from }) => from === d.id).length };
}

/**
 * Device D signed in to account A, with a peer on A and one on B, each with a fact of its own. A's peer
 * then writes "Late fact from A", which is on its way to D when the path runs.
 */
async function start() {
  const groups = { A: new BulletRelay(), B: new BulletRelay() };
  const world = { signInAs: null, refreshAs: null };
  const fetch = async (url, init, bundled) => {
    const href = String(url);
    if (href.startsWith(`${SUPABASE}/auth/v1/token`)) {
      if (world.refreshAs === null) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
      return { ok: true, status: 200, json: async () => world.refreshAs };
    }
    // The backend: this session is no longer accepted (an expired subscription or session).
    if (href.startsWith('https://backend.example.com/')) return { ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => ({}) };
    return bundled(url, init);
  };
  // The sign-in window: the provider page reaches its last step at once, with `world.signInAs`.
  const browser = {
    windows: { create: async () => ({ id: 41 }), get: async () => ({ id: 41 }), remove: async () => {} },
    tabs: {
      query: async () => [{ id: 42 }],
      get: async () => ({ id: 42, url: `https://tabmail.ai/auth/tb-done#s=${Buffer.from(JSON.stringify(world.signInAs)).toString('base64')}` }),
      update: async () => {}, remove: async () => {},
    },
    webNavigation: { onCreatedNavigationTarget: { addListener() {}, removeListener() {} } },
  };
  const settings = {
    supabaseUrl: SUPABASE, supabaseAnonKey: 'synthetic-anon', authTokenRefreshRetries: 1, authTokenRefreshTimeoutMs: 5000,
    authSignInTimeoutMs: 60000, authWindow: { defaultWidth: 500, defaultHeight: 700 }, authAutoReauthEnabled: true,
  };
  const d = await new BulletDevice('D', new DeviceStore({ supabaseSession: session('A') }), groups.A, {
    files: [AUTH], settings, browser, fetch,
    globals: { atob: globalThis.atob, AbortController },
    groupFor: (url) => groups[accountOf(new URL(url).searchParams.get('token'))],
  }).start();
  const peerA = await new BulletDevice('PA', new DeviceStore(), groups.A).start();
  const peerB = await new BulletDevice('PB', new DeviceStore(), groups.B).start();
  for (const each of [peerA, peerB, d]) await each.connect();
  for (const [writer, text] of [[peerA, 'Fact from A'], [peerB, 'Fact from B'], [d, 'Fact from D']]) {
    expect((await writer.add('kb', '', text)).outcome).toBe('saved');
  }
  await quiesce([groups.A, groups.B]);
  expect(await kb(d)).toContain('Fact from A');
  expect((await peerA.add('kb', '', 'Late fact from A')).outcome).toBe('saved');
  const late = groups.A.pending.filter((entry) => entry.to === 'D').map((entry) => entry.snapshot.parts[entry.part - 1]);
  expect(late.length).toBeGreaterThan(0);
  return { groups, world, d, peerA, peerB, late };
}

/** Watches D's session write: at it, whether D is still on A's devices, what it had sent there, and
 * whether A's late message, emitted by the old connection and delivered now, is applied. */
function atTheWrite(ctx) {
  const seen = { writes: 0 };
  const check = async () => {
    seen.writes += 1;
    if (seen.writes > 1) return;
    seen.onA = ctx.groups.A.isConnected('D');
    seen.sentOnA = sentBy(ctx.groups.A, ctx.d);
    for (const text of ctx.late) await ctx.d.listener()?.({ type: 'message', data: text });
  };
  ctx.d.store.beforeSet = async (values) => { if (Object.hasOwn(values, 'supabaseSession')) await check(); };
  ctx.d.store.beforeRemove = async (keys) => { if ([keys].flat().includes('supabaseSession')) await check(); };
  return seen;
}

/** The session expires in under a minute, so the next token read refreshes it. */
function expiring(d) {
  d.store.values.supabaseSession.expires_at = Math.floor(Date.now() / 1000) + 30;
}

const PATHS = [
  { name: 'a sign-in from the popup', to: 'B', run: ({ d }) => d.auth.ensureSignedIn() },
  { name: 'an automatic re-sign-in after an AI call is refused, in the background', to: 'B', run: ({ d }) => d.auth.handleAuthError(refused()) },
  { name: 'an automatic re-sign-in after an AI call is refused, in a chat window', to: 'B', run: ({ d }) => d.page([AUTH]).require(AUTH).handleAuthError(refused()) },
  { name: 'a token refresh answered for another account, in the background', to: 'B', refresh: true, run: ({ d }) => d.auth.getAccessToken() },
  { name: 'a token refresh answered for another account, in a page', to: 'B', refresh: true, run: ({ d }) => d.page([AUTH]).require(AUTH).getAccessToken() },
  { name: 'a refused token refresh', to: null, refresh: true, run: ({ d }) => d.auth.getAccessToken() },
  { name: 'a sign-out', to: null, run: ({ d }) => d.auth.signOut() },
];

describe('Device Sync follows the signed-in account on every path (DS-DEVICE)', () => {
  it.each(PATHS)('$name: leaves the old account\'s devices before the session is stored, then syncs with the new account\'s, if any', async (path) => {
    const ctx = await start();
    const { groups, world, d, peerA, peerB } = ctx;
    if (path.to) world[path.refresh ? 'refreshAs' : 'signInAs'] = session(path.to);
    if (path.refresh) expiring(d);
    const seen = atTheWrite(ctx);

    await path.run(ctx);
    await vi.waitFor(() => expect(seen.writes).toBeGreaterThan(0));

    // At the write, D has left A's devices, and what A's old connection sent is not applied.
    expect(seen.onA).toBe(false);
    expect(await kb(d)).not.toContain('Late fact from A');
    expect(d.store.values.supabaseSession ? accountOf(d.store.values.supabaseSession.access_token) : null).toBe(path.to);

    if (path.to) {
      // D syncs with the new account's devices: they send their state on its connect, and it sends its own.
      await vi.waitFor(() => expect(groups.B.isConnected('D')).toBe(true));
      await d.listener()({ type: 'message', data: JSON.stringify({ type: 'connected', userId: path.to }) });
      await quiesce([groups.A, groups.B]);
      await peerB.add('kb', '', 'Fact from B after the change');
      await quiesce([groups.A, groups.B]);
      expect(await kb(peerB)).toContain('Fact from D');
      expect(await kb(d)).toContain('Fact from B after the change');
    } else {
      expect(groups.A.isConnected('D')).toBe(false);
      expect(groups.B.isConnected('D')).toBe(false);
    }

    // Nothing D does after the change reaches A's devices; nothing of A's arrives.
    expect((await d.add('kb', '', 'Fact after the change')).outcome).toBe('saved');
    await new Promise((resolve) => setTimeout(resolve, 650));
    await quiesce([groups.A, groups.B]);
    expect(groups.A.isConnected('D')).toBe(false);
    expect(sentBy(groups.A, d)).toEqual(seen.sentOnA);
    expect(await kb(peerA)).not.toContain('Fact after the change');
    expect(await kb(d)).not.toContain('Late fact from A');
    if (path.to) expect(await kb(peerB)).toContain('Fact after the change');
    // Nothing is removed from the device (DS-DEVICE).
    expect(await kb(d)).toEqual(expect.arrayContaining(['Fact from A', 'Fact from D']));
  });

  it.each([
    { name: 'a sign-in to the same account', run: ({ d }) => d.auth.ensureSignedIn() },
    { name: 'a token refresh of the same account', refresh: true, run: ({ d }) => d.auth.getAccessToken() },
  ])('$name keeps the connection to its devices (control)', async (path) => {
    const ctx = await start();
    const { groups, world, d, peerA } = ctx;
    world[path.refresh ? 'refreshAs' : 'signInAs'] = session('A', 2);
    if (path.refresh) expiring(d);
    const seen = atTheWrite(ctx);

    await path.run(ctx);
    await vi.waitFor(() => expect(seen.writes).toBeGreaterThan(0));

    expect(seen.onA).toBe(true);
    expect(d.store.values.supabaseSession.access_token).toBe(token('A', 2));
    expect(groups.A.isConnected('D')).toBe(true);
    expect(await kb(d)).toContain('Late fact from A');
    expect((await d.add('kb', '', 'Fact after the refresh')).outcome).toBe('saved');
    await quiesce([groups.A]);
    expect(await kb(peerA)).toContain('Fact after the refresh');
  });
});

vi.setConfig({ testTimeout: 20000 });
