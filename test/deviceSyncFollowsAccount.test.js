/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// deviceSyncFollowsAccount.test.js — the sign-in is which devices this one syncs with (DS-DEVICE). On
// every path that changes the signed-in account (a sign-in from the popup, an automatic re-sign-in after
// an AI call is refused, from the background or a chat window, a token refresh answered for another
// account, from the background or a page, a refused refresh, a sign-out), Device Sync leaves the old
// account's devices before the new session is stored: from then on nothing this device sends reaches
// them and nothing they sent is applied. Then it syncs with the new account's devices. A sign-in or
// refresh of the same account keeps the connection. The change is one step: no connect asked for during it
// connects as the old account, and session writes land in order. The stored session is the only truth: a
// token refresh that finishes after a newer sign-in or a sign-out stores nothing (#201), and every caller
// of getAccessToken gets a token of the session stored now, or none (#203). Simulated devices
// (bulletDevices.js) with the real supabaseAuth, Device Sync and prompt store; each connection joins the
// group of its token's account.

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
async function start({ refreshRetries = 1 } = {}) {
  const groups = { A: new BulletRelay(), B: new BulletRelay() };
  // refreshAs: the session a token refresh answers (null: refused), or a function of the refresh token
  // sent. refreshGate: a promise every refresh's reply waits for (a slow refresh), or a function of the
  // refresh token sent returning one. refreshes: how many refreshes were sent; sent: their refresh tokens.
  // atDone: called when the sign-in reaches its last step.
  const world = { signInAs: null, refreshAs: null, refreshGate: null, refreshes: 0, sent: [], atDone: null };
  const fetch = async (url, init, bundled) => {
    const href = String(url);
    if (href.startsWith(`${SUPABASE}/auth/v1/token`)) {
      const sent = JSON.parse(init.body).refresh_token;
      world.refreshes += 1;
      world.sent.push(sent);
      if (world.refreshGate) await (typeof world.refreshGate === 'function' ? world.refreshGate(sent) : world.refreshGate);
      const answer = typeof world.refreshAs === 'function' ? world.refreshAs(sent) : world.refreshAs;
      if (answer === null) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
      return { ok: true, status: 200, json: async () => answer };
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
      get: async () => {
        world.atDone?.();
        return { id: 42, url: `https://tabmail.ai/auth/tb-done#s=${Buffer.from(JSON.stringify(world.signInAs)).toString('base64')}` };
      },
      update: async () => {}, remove: async () => {},
    },
    webNavigation: { onCreatedNavigationTarget: { addListener() {}, removeListener() {} } },
  };
  const settings = {
    supabaseUrl: SUPABASE, supabaseAnonKey: 'synthetic-anon', authTokenRefreshRetries: refreshRetries, authTokenRefreshTimeoutMs: 5000,
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

  it('a session write that fails releases the connects waiting for it and does not stop the next write', async () => {
    const ctx = await start();
    const { groups, world, d } = ctx;
    world.signInAs = session('B');
    let failed = false;
    let waiting = null;
    d.store.beforeSet = async (values) => {
      if (!failed && Object.hasOwn(values, 'supabaseSession')) {
        failed = true;
        // Device Sync's own connect, asked for during the change, then the write fails.
        waiting = d.sync.connect();
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('storage unavailable');
      }
    };

    await d.auth.ensureSignedIn();
    expect(failed).toBe(true);
    // The waiting connect goes ahead with the session still stored: A's.
    await within(waiting, 5000);
    expect(accountOf(d.store.values.supabaseSession.access_token)).toBe('A');
    await vi.waitFor(() => expect(groups.A.isConnected('D')).toBe(true));
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

  it.each([
    { name: 'a sign-in from the popup', run: ({ d }) => d.auth.ensureSignedIn() },
    { name: 'an automatic re-sign-in in a chat window', run: ({ d }) => d.page([AUTH]).require(AUTH).handleAuthError(refused()) },
  ])('$name whose read of the stored session fails still leaves the old account\'s devices before the new session is stored', async (path) => {
    const ctx = await start();
    const { world, d } = ctx;
    world.signInAs = session('B');
    let armed = false;
    let failed = false;
    // The sign-in's session write reads the stored session first: that read fails.
    world.atDone = () => { armed = true; };
    d.store.beforeGet = async (keys) => {
      if (armed && !failed && JSON.stringify(keys ?? null).includes('supabaseSession')) {
        failed = true;
        throw new Error('storage unavailable');
      }
    };
    const seen = atTheWrite(ctx);

    await path.run(ctx);
    await vi.waitFor(() => expect(seen.writes).toBeGreaterThan(0), { timeout: 10000 });

    expect(failed).toBe(true);
    expect(seen.onA).toBe(false);
    expect(accountOf(d.store.values.supabaseSession.access_token)).toBe('B');
    await endsOn(ctx, 'B');
  });
});

/** Every account D's session was written as, in order (null for a removal). */
function sessionWrites(d) {
  const writes = [];
  const set = d.store.beforeSet;
  const remove = d.store.beforeRemove;
  d.store.beforeSet = async (values) => {
    if (Object.hasOwn(values, 'supabaseSession')) writes.push(accountOf(values.supabaseSession.access_token));
    if (set) await set(values);
  };
  d.store.beforeRemove = async (keys) => {
    if ([keys].flat().includes('supabaseSession')) writes.push(null);
    if (remove) await remove(keys);
  };
  return writes;
}

/** The session module of the background or of a page. */
function authIn(d, where) {
  return where === 'background' ? d.auth : d.page([AUTH]).require(AUTH);
}

/** Three callers of `getAccessToken` at once, as concurrent AI calls make them. */
function callers(auth) {
  return Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
}

describe('a token refresh that finishes after a newer sign-in or a sign-out never replaces it (#201)', () => {
  it.each([
    { name: 'a sign-in to another account', where: 'background', reply: 'session', newer: 'B' },
    { name: 'a sign-in to another account', where: 'page', reply: 'session', newer: 'B' },
    { name: 'a sign-in to another account', where: 'background', reply: 'refused', newer: 'B' },
    { name: 'a sign-in to another account', where: 'page', reply: 'refused', newer: 'B' },
    { name: 'a new sign-in to the same account', where: 'background', reply: 'session', newer: 'A' },
    { name: 'a new sign-in to the same account', where: 'page', reply: 'refused', newer: 'A' },
    { name: 'a sign-out', where: 'background', reply: 'session', newer: null },
    { name: 'a sign-out', where: 'page', reply: 'session', newer: null },
  ])('$name while a refresh in the $where waits for its reply ($reply): the newer session stays, and Device Sync with it', async (path) => {
    const ctx = await start();
    const { groups, world, d, peerA, peerB } = ctx;
    const slow = gate();
    world.refreshGate = slow.promise;
    world.refreshAs = path.reply === 'session' ? session('A', 3) : null;
    expiring(d);
    const writes = sessionWrites(d);
    const refresh = callers(authIn(d, path.where));
    // The refresh is sent and waits for its reply.
    await vi.waitFor(() => expect(world.refreshes).toBe(1));

    const newer = path.newer === null ? null : session(path.newer, 2);
    if (newer) {
      world.signInAs = newer;
      expect(await d.auth.ensureSignedIn()).toBe(true);
    } else {
      expect(await d.auth.signOut()).toBe(true);
    }
    const settled = writes.length;
    slow.open();
    const answers = await within(refresh, 5000);

    // The refresh stored nothing after the newer write: the old session never comes back. It was sent
    // once and not again.
    expect(writes.slice(settled)).toEqual([]);
    expect(world.refreshes).toBe(1);
    expect(d.store.values.supabaseSession?.access_token ?? null).toBe(newer?.access_token ?? null);
    // Its callers get the session that is stored now, or none.
    expect(answers).toEqual([1, 2, 3].map(() => newer?.access_token ?? null));
    if (path.newer === 'B') {
      await vi.waitFor(() => expect(groups.B.isConnected('D')).toBe(true));
      await d.listener()({ type: 'message', data: JSON.stringify({ type: 'connected', userId: 'B' }) });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(groups.A.isConnected('D')).toBe(path.newer === 'A');
    expect(groups.B.isConnected('D')).toBe(path.newer === 'B');
    if (path.newer !== 'A') {
      expect((await d.add('kb', '', 'Fact after the change')).outcome).toBe('saved');
      await new Promise((resolve) => setTimeout(resolve, 650));
      await quiesce([groups.A, groups.B]);
      expect(await kb(peerA)).not.toContain('Fact after the change');
      if (path.newer === 'B') expect(await kb(peerB)).toContain('Fact after the change');
    }
  });

  it.each([
    { where: 'background', newer: 'A' },
    { where: 'page', newer: 'A' },
    { where: 'background', newer: 'B' },
    { where: 'page', newer: 'B' },
    { where: 'background', newer: null },
    { where: 'page', newer: null },
  ])('a refresh in the $where whose session write cannot read the stored session ($newer stored meanwhile, if any) stores nothing, is not sent again, and answers the session stored now or none', async (path) => {
    // Two attempts allowed: the refresh the server answered is still not sent again.
    const ctx = await start({ refreshRetries: 2 });
    const { groups, world, d } = ctx;
    const slow = gate();
    world.refreshGate = slow.promise;
    world.refreshAs = session('A', 3);
    expiring(d);
    const refresh = callers(authIn(d, path.where));
    await vi.waitFor(() => expect(world.refreshes).toBe(1));
    // 'A': nothing newer. 'B' or null: a sign-in to another account, or a sign-out, lands meanwhile.
    if (path.newer === 'B') {
      world.signInAs = session('B', 2);
      expect(await d.auth.ensureSignedIn()).toBe(true);
      await vi.waitFor(() => expect(groups.B.isConnected('D')).toBe(true));
    } else if (path.newer === null) {
      expect(await d.auth.signOut()).toBe(true);
    }
    const before = d.store.values.supabaseSession ?? null;
    const writes = sessionWrites(d);
    // The next read of the session, the refresh's write's, fails.
    let failed = false;
    d.store.beforeGet = async (keys) => {
      if (!failed && JSON.stringify(keys ?? null).includes('supabaseSession')) {
        failed = true;
        throw new Error('storage unavailable');
      }
    };
    slow.open();

    // A's stored session is about to expire: none. B's is valid: B's.
    expect(await within(refresh, 5000)).toEqual([1, 2, 3].map(() => (path.newer === 'B' ? token('B', 2) : null)));
    expect(failed).toBe(true);
    expect(world.refreshes).toBe(1);
    expect(writes).toEqual([]);
    expect(d.store.values.supabaseSession ?? null).toEqual(before);
    if (path.newer === 'A') {
      expect(groups.A.isConnected('D')).toBe(true);
      return;
    }
    if (path.newer === 'B') await d.listener()({ type: 'message', data: JSON.stringify({ type: 'connected', userId: 'B' }) });
    await endsOn(ctx, path.newer);
  });

  it.each([
    { where: 'background', reply: 'session' },
    { where: 'page', reply: 'session' },
    { where: 'background', reply: 'refused' },
    { where: 'page', reply: 'refused' },
  ])('callers of a refresh in the $where ($reply) that finishes after a sign-in whose session is about to expire get that session refreshed, or no token: never the expired one', async (path) => {
    const ctx = await start();
    const { groups, world, d } = ctx;
    const slow = gate();
    world.refreshGate = slow.promise;
    world.refreshAs = (sent) => ({ 'refresh-A-1': path.reply === 'session' ? session('A', 3) : null, 'refresh-B-2': session('B', 3) })[sent] ?? null;
    expiring(d);
    const refresh = callers(authIn(d, path.where));
    await vi.waitFor(() => expect(world.refreshes).toBe(1));
    // A sign-in to B whose session expires within the minute. A's refresh answers once B is stored.
    world.signInAs = { ...session('B', 2), expires_at: Math.floor(Date.now() / 1000) + 30 };
    const writes = sessionWrites(d);
    const signIn = d.auth.ensureSignedIn();
    await vi.waitFor(() => expect(writes).toEqual(['B']), { timeout: 10000 });
    slow.open();

    expect(await within(signIn, 5000)).toBe(true);
    const answers = await within(refresh, 5000);
    for (const answer of answers) expect([null, token('B', 3)]).toContain(answer);
    await vi.waitFor(() => expect(d.store.values.supabaseSession.access_token).toBe(token('B', 3)));
    // Nothing of A's was stored, and nothing was removed: B's sign-in, then B's refresh.
    expect(writes).toEqual(['B', 'B']);
    expect(world.refreshes).toBe(2);
    await vi.waitFor(() => expect(groups.B.isConnected('D')).toBe(true));
    await d.listener()({ type: 'message', data: JSON.stringify({ type: 'connected', userId: 'B' }) });
    await endsOn(ctx, 'B');
  });

  /** A newer session of A that expires within the minute, stored as a sign-in stores it: same account, so
   * Device Sync keeps its connection and does not ask for a token of its own. */
  async function storeExpiringA2(d) {
    expect(await d.auth.handleStoreSessionMessage({ session: { ...session('A', 2), expires_at: Math.floor(Date.now() / 1000) + 30 } })).toEqual({ ok: true });
  }

  it.each(['background', 'page'])('a call in the %s runs at most one refresh: when its refresh finishes after a newer session that itself needs refreshing, it answers no token, and the next call refreshes that one', async (where) => {
    const { world, d } = await start();
    const slow = gate();
    world.refreshGate = (sent) => (sent === 'refresh-A-1' ? slow.promise : null);
    world.refreshAs = (sent) => ({ 'refresh-A-1': session('A', 3), 'refresh-A-2': session('A', 4) })[sent] ?? null;
    expiring(d);
    const auth = authIn(d, where);
    const first = callers(auth);
    await vi.waitFor(() => expect(world.sent).toEqual(['refresh-A-1']));
    await storeExpiringA2(d);
    slow.open();

    // The first callers ran their one refresh; A2 is not refreshed for them, and A3 was not stored.
    expect(await within(first, 5000)).toEqual([null, null, null]);
    expect(world.sent).toEqual(['refresh-A-1']);
    expect(d.store.values.supabaseSession.refresh_token).toBe('refresh-A-2');
    // The next call refreshes the stored A2.
    expect(await within(auth.getAccessToken(), 5000)).toBe(token('A', 4));
    expect(world.sent).toEqual(['refresh-A-1', 'refresh-A-2']);
    expect(d.store.values.supabaseSession.access_token).toBe(token('A', 4));
  });

  it.each(['background', 'page'])('in the %s, a call that arrives after an older refresh finishes joins the newer session\'s refresh already under way', async (where) => {
    const { world, d } = await start();
    const slowA1 = gate();
    const slowA2 = gate();
    world.refreshGate = (sent) => ({ 'refresh-A-1': slowA1.promise, 'refresh-A-2': slowA2.promise })[sent] ?? null;
    world.refreshAs = (sent) => ({ 'refresh-A-1': session('A', 3), 'refresh-A-2': session('A', 4) })[sent] ?? null;
    expiring(d);
    const auth = authIn(d, where);
    // A1's refresh is under way; a newer A2 that needs refreshing is stored, and a call starts its refresh.
    const older = auth.getAccessToken();
    await vi.waitFor(() => expect(world.sent).toEqual(['refresh-A-1']));
    await storeExpiringA2(d);
    const early = auth.getAccessToken();
    await vi.waitFor(() => expect(world.sent).toEqual(['refresh-A-1', 'refresh-A-2']));
    // A1's refresh finishes (not stored: A2 replaced its session); then another call for A2 arrives.
    slowA1.open();
    expect(await within(older, 5000)).toBe(null);
    const late = auth.getAccessToken();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // It joined: A2 was sent once.
    expect(world.sent).toEqual(['refresh-A-1', 'refresh-A-2']);
    slowA2.open();

    expect(await within(Promise.all([early, late]), 5000)).toEqual([token('A', 4), token('A', 4)]);
    expect(world.sent).toEqual(['refresh-A-1', 'refresh-A-2']);
    expect(d.store.values.supabaseSession.access_token).toBe(token('A', 4));
  });

  it('a refused refresh whose clear fails answers no token, never the expired one', async () => {
    const { world, d } = await start();
    world.refreshAs = null;
    expiring(d);
    let failed = false;
    d.store.beforeRemove = async (keys) => {
      if (!failed && [keys].flat().includes('supabaseSession')) {
        failed = true;
        throw new Error('storage unavailable');
      }
    };

    expect(await d.auth.getAccessToken()).toBe(null);
    expect(failed).toBe(true);
    expect(world.refreshes).toBe(1);
  });

  it('a refresh with nothing newer stores its session and answers it (control)', async () => {
    const { world, d } = await start();
    world.refreshAs = session('A', 3);
    expiring(d);
    expect(await callers(d.auth)).toEqual([token('A', 3), token('A', 3), token('A', 3)]);
    expect(d.store.values.supabaseSession.access_token).toBe(token('A', 3));
    expect(world.refreshes).toBe(1);
  });
});

describe('a caller only ever gets a token of the session stored now, or none (#203)', () => {
  it.each(['background', 'page'])('a refresh in the %s whose session write fails answers no token to any caller, is not sent again, and the next call refreshes the session still stored', async (where) => {
    // Two attempts allowed: the refresh the server answered is still not sent again.
    const { world, d } = await start({ refreshRetries: 2 });
    world.refreshAs = session('A', 3);
    expiring(d);
    const before = structuredClone(d.store.values.supabaseSession);
    let failed = false;
    d.store.beforeSet = async (values) => {
      if (!failed && Object.hasOwn(values, 'supabaseSession')) {
        failed = true;
        throw new Error('storage unavailable');
      }
    };
    const auth = authIn(d, where);

    expect(await within(callers(auth), 5000)).toEqual([null, null, null]);
    expect(failed).toBe(true);
    expect(world.refreshes).toBe(1);
    expect(d.store.values.supabaseSession).toEqual(before);

    // The next call refreshes the session still stored, with its own refresh token, and recovers.
    world.refreshAs = (sent) => (sent === before.refresh_token ? session('A', 4) : null);
    expect(await within(auth.getAccessToken(), 5000)).toBe(token('A', 4));
    expect(d.store.values.supabaseSession.access_token).toBe(token('A', 4));
    expect(world.refreshes).toBe(2);
  });

  it('a refresh in a page whose stored reply reaches it after a sign-in to another account answers that account\'s token', async () => {
    const ctx = await start();
    const { world, d } = ctx;
    world.refreshAs = session('A', 3);
    expiring(d);
    const reached = gate();
    const held = gate();
    // A's refreshed session is stored; the background's reply to the page is slow to arrive.
    d.beforeSessionReply = async (message) => {
      if (message.session && accountOf(message.session.access_token) === 'A') {
        d.beforeSessionReply = null;
        reached.open();
        await held.promise;
      }
    };
    const refresh = callers(authIn(d, 'page'));
    await within(reached.promise, 5000);
    expect(d.store.values.supabaseSession.access_token).toBe(token('A', 3));

    // Meanwhile the user signs in to B.
    world.signInAs = session('B', 2);
    expect(await d.auth.ensureSignedIn()).toBe(true);
    held.open();

    expect(await within(refresh, 5000)).toEqual([token('B', 2), token('B', 2), token('B', 2)]);
    expect(d.store.values.supabaseSession.access_token).toBe(token('B', 2));
    await endsOn(ctx, 'B');
  });
});

vi.setConfig({ testTimeout: 20000 });
