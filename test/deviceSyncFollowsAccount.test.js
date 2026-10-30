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

/** A promise and the function that resolves it. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

/** Resolves with `promise`'s value, or rejects once `ms` pass first (a write chain that never settles). */
function within(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A seeded generator in [0, 1) (mulberry32), so a failing schedule can be replayed. */
function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** D ends on `to`'s devices (none when null), and nothing it does afterwards reaches A's. */
async function endsOn(ctx, to) {
  const { groups, d, peerA } = ctx;
  if (to) {
    await vi.waitFor(() => expect(groups[to].isConnected('D')).toBe(true));
    await d.listener()({ type: 'message', data: JSON.stringify({ type: 'connected', userId: to }) });
  }
  await quiesce([groups.A, groups.B]);
  const sentOnA = sentBy(groups.A, d);
  expect((await d.add('kb', '', 'Fact after the change')).outcome).toBe('saved');
  await new Promise((resolve) => setTimeout(resolve, 650));
  await quiesce([groups.A, groups.B]);
  expect(groups.A.isConnected('D')).toBe(to === 'A');
  expect(groups.B.isConnected('D')).toBe(to === 'B');
  expect(sentBy(groups.A, d)).toEqual(sentOnA);
  expect(await kb(peerA)).not.toContain('Fact after the change');
}

describe('an account change is one step: nothing connects as the old account during it, and every write lands in order', () => {
  it.each([
    { name: 'a sign-in to another account', to: 'B' },
    { name: 'a sign-out', to: null },
  ])('$name: a connect asked for while the session is written does not connect as the old account', async (path) => {
    const ctx = await start();
    const { world, d } = ctx;
    world.signInAs = session('B');
    let independent = null;
    // Device Sync's own connect (startup, sync turned on) asked for at the session write, which then
    // takes a while.
    const ask = async () => {
      independent ??= d.sync.connect();
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    d.store.beforeSet = async (values) => { if (Object.hasOwn(values, 'supabaseSession')) await ask(); };
    d.store.beforeRemove = async (keys) => { if ([keys].flat().includes('supabaseSession')) await ask(); };

    expect(await (path.to ? d.auth.ensureSignedIn() : d.auth.signOut())).toBe(true);
    expect(independent).not.toBe(null);
    await independent;

    await endsOn(ctx, path.to);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('a connect asked for at a seeded point of a session write for another account (seed %i) never connects as the old account', async (seed) => {
    const ctx = await start();
    const { d } = ctx;
    const random = seeded(seed);
    const ticks = Math.floor(random() * 40);
    // The session write takes a seeded while.
    const writeMs = Math.floor(random() * 4) * 10;
    d.store.beforeSet = async (values) => {
      if (Object.hasOwn(values, 'supabaseSession')) await new Promise((resolve) => setTimeout(resolve, writeMs));
    };
    // B's session, as a page's sign-in sends it to the background.
    const write = d.auth.handleStoreSessionMessage({ session: session('B') });
    // Some microtasks and macrotasks into the write, Device Sync's own connect is asked for.
    for (let n = 0; n < ticks; n++) await (random() < 0.5 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 0)));
    const independent = d.sync.connect();
    expect((await write).ok).toBe(true);
    await independent;

    await endsOn(ctx, 'B');
  });

  it('a sign-out closes Device Sync even when the stored session cannot be read', async () => {
    const ctx = await start();
    const { d } = ctx;
    let failed = false;
    d.store.beforeGet = async (keys) => {
      if (!failed && JSON.stringify(keys ?? null).includes('supabaseSession')) {
        failed = true;
        throw new Error('storage unavailable');
      }
    };

    expect(await d.auth.signOut()).toBe(true);
    expect(failed).toBe(true);
    expect(d.store.values.supabaseSession).toBeUndefined();

    await endsOn(ctx, null);
  });

  it('a sign-in still stores the new session when leaving the old devices fails', async () => {
    const ctx = await start();
    const { groups, world, d } = ctx;
    world.signInAs = session('B');
    const leave = groups.A.leave;
    // The transport drops its socket, then its close reports an error.
    groups.A.leave = (id) => { groups.A.leave = leave; leave.call(groups.A, id); throw new Error('synthetic socket error'); };

    expect(await d.auth.ensureSignedIn()).toBe(true);

    expect(accountOf(d.store.values.supabaseSession.access_token)).toBe('B');
    await vi.waitFor(() => expect(groups.B.isConnected('D')).toBe(true));
  });

  it('a sign-out asked for while a sign-in is being written lands after it: the device ends signed out', async () => {
    const ctx = await start();
    const { world, d } = ctx;
    world.signInAs = session('B');
    const held = gate();
    const writes = [];
    d.store.beforeSet = async (values) => {
      if (!Object.hasOwn(values, 'supabaseSession')) return;
      writes.push(accountOf(values.supabaseSession.access_token));
      await held.promise;
    };
    d.store.beforeRemove = async (keys) => { if ([keys].flat().includes('supabaseSession')) writes.push(null); };

    const signIn = d.auth.ensureSignedIn();
    await vi.waitFor(() => expect(writes).toEqual(['B']), { timeout: 10000 });
    // The sign-out, from a page, while B's write has not finished.
    const signOut = d.page([AUTH]).require(AUTH).signOut();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(writes).toEqual(['B']);
    held.open();
    expect(await signIn).toBe(true);
    expect(await signOut).toBe(true);

    expect(writes).toEqual(['B', null]);
    expect(d.store.values.supabaseSession).toBeUndefined();
    await endsOn(ctx, null);
  });

  it('a session write that fails does not stop the next one', async () => {
    const ctx = await start();
    const { world, d } = ctx;
    world.signInAs = session('B');
    let failed = false;
    d.store.beforeSet = async (values) => {
      if (!failed && Object.hasOwn(values, 'supabaseSession')) {
        failed = true;
        throw new Error('storage unavailable');
      }
    };

    await d.auth.ensureSignedIn();
    expect(failed).toBe(true);
    expect(await within(d.auth.signOut(), 5000)).toBe(true);

    expect(d.store.values.supabaseSession).toBeUndefined();
    await endsOn(ctx, null);
  });

  it("a sign-in whose session must be refreshed to connect finishes, and Device Sync connects with the refreshed session", async () => {
    const ctx = await start();
    const { world, d } = ctx;
    // B's session is about to expire: connecting refreshes it, which writes the session again.
    world.signInAs = { ...session('B'), expires_at: Math.floor(Date.now() / 1000) + 30 };
    world.refreshAs = session('B', 2);

    expect(await within(d.auth.ensureSignedIn(), 5000)).toBe(true);

    await vi.waitFor(() => expect(d.store.values.supabaseSession.access_token).toBe(token('B', 2)));
    await endsOn(ctx, 'B');
  });
});

vi.setConfig({ testTimeout: 20000 });
