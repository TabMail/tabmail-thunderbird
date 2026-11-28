/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// A request to TabMail's own servers never follows a redirect (agent/modules/ownServerFetch.js):
// the helper's options, a live redirect between two loopback servers, and a source check that every
// request to our servers goes through the helper.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { ownServerFetch } from '../agent/modules/ownServerFetch.js';
import { redirectServers } from './support/redirectServers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('ownServerFetch options', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes the request on with redirect "error", over a caller\'s own redirect', async () => {
    const seen = [];
    vi.stubGlobal('fetch', async (url, init) => { seen.push([url, init]); return new Response('ok'); });
    const signal = new AbortController().signal;
    await ownServerFetch('https://api.example.com/x', {
      method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{"a":1}', signal, credentials: 'include', redirect: 'follow',
    });
    await ownServerFetch('https://api.example.com/y');
    expect(seen).toEqual([
      ['https://api.example.com/x', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{"a":1}', signal, credentials: 'include', redirect: 'error' }],
      ['https://api.example.com/y', { redirect: 'error' }],
    ]);
  });
});

const REDIRECTS = [301, 302, 303, 307, 308];
const REQUESTS = {
  get: { method: 'GET', headers: { Authorization: 'Bearer synthetic-token' } },
  postWithBody: { method: 'POST', headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' }, body: '{"refresh_token":"synthetic"}' },
};

describe('a redirect from our server is not followed', () => {
  for (const status of REDIRECTS) for (const [name, init] of Object.entries(REQUESTS)) {
    it(`${status}, ${name}: the request fails and the other server sees nothing`, async () => {
      const s = await redirectServers(status);
      try {
        await expect(ownServerFetch(s.firstURL, init)).rejects.toThrow(TypeError);
        expect(s.reached).toEqual([]);
      } finally { await s.close(); }
    });

    it(`${status}, ${name}: control, plain fetch follows the same redirect`, async () => {
      const s = await redirectServers(status);
      try {
        const res = await fetch(s.firstURL, init);
        expect(await res.text()).toBe('landed');
        expect(s.reached).toHaveLength(1);
      } finally { await s.close(); }
    });
  }
});

/* every use of the global fetch in the add-on's own code, by file. A request to TabMail's own servers goes
   through ownServerFetch; only these use fetch directly. */
const GLOBAL_FETCH_ALLOWED = {
  'agent/modules/ownServerFetch.js': 1,     // the helper itself
  'agent/modules/promptStore.js': 1,        // an add-on file (runtime.getURL)
  'agent/modules/templateManager.js': 1,    // an add-on file (runtime.getURL)
  'theme/palette/palette.js': 1,            // an add-on file (runtime.getURL)
  'welcome/modules/pageLoader.js': 1,       // an add-on file
  'fts/diagnostics.js': 1,                  // an add-on file (runtime.getURL)
  'fts/nativeEngine.js': 1,                 // the search helper's signed update manifest on the CDN, no token
  'prompts/modules/developer.js': 1,        // a developer page talking to a local backend
};
/* the requests to TabMail's own servers, by file: the census must find each of them (a skipped folder or a
   request moved back to plain fetch changes this map) */
const OWN_SERVER_FETCH_USES = {
  'agent/modules/accessAuth.js': 2,
  'agent/modules/llm.js': 3,
  'agent/modules/supabaseAuth.js': 4,
  'chat/fsm/templateDownload.js': 1,
  'chat/fsm/templateShare.js': 1,
  'chat/tools/template_read.js': 1,
  'chat/tools/template_search.js': 1,
  'chatlink/modules/core.js': 3,
  'config/modules/byokSettings.js': 2,
  'config/modules/chatlink.js': 4,
  'config/modules/planUsage.js': 1,
  'marketplace/marketplace.js': 5,
  'popup/popup.js': 2,
  'templates/templates.js': 4,
};
const SKIP_DIRS = new Set(['node_modules', 'test', '.git', 'coverage', 'libs']);
const GLOBALS = new Set(['globalThis', 'window', 'self']);

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) out.push(...sourceFiles(join(dir, e.name))); }
    else if (/\.m?js$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/* { fetch, own }: uses of the global fetch (the name `fetch` read as a value, called or not, and
   `globalThis|window|self` `.fetch` or `["fetch"]`) and calls of ownServerFetch. A property name, an object
   key or a method named fetch is not a use. */
function fetchUses(source) {
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
  catch { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }); }
  const n = { fetch: 0, own: 0 };
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier') { if (node.name === 'fetch') n.fetch++; return; }
    if (node.type === 'MemberExpression') {
      const p = node.property;
      const named = node.computed ? (p.type === 'Literal' && p.value === 'fetch') : p.name === 'fetch';
      if (named && node.object.type === 'Identifier' && GLOBALS.has(node.object.name)) { n.fetch++; return; }
      walk(node.object);
      if (node.computed) walk(p);
      return;
    }
    if (node.type === 'Property' || node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
      if (node.computed) walk(node.key);
      walk(node.value);
      return;
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'ownServerFetch') n.own++;
    for (const k in node) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(ast);
  return n;
}

describe('every request to our servers goes through ownServerFetch', () => {
  it('the add-on uses fetch directly only where the list says, and each request to our servers is found', () => {
    const direct = {};
    const own = {};
    for (const f of sourceFiles(ROOT)) {
      const n = fetchUses(readFileSync(f, 'utf8'));
      const path = relative(ROOT, f).split('\\').join('/');
      if (n.fetch) direct[path] = n.fetch;
      if (n.own) own[path] = n.own;
    }
    expect(direct).toEqual(GLOBAL_FETCH_ALLOWED);
    expect(own).toEqual(OWN_SERVER_FETCH_USES);
  });

  it.each([
    ['a call', 'await fetch(u, {});', 1],
    ['a global object\'s fetch', 'globalThis.fetch(u); window.fetch(u); self.fetch(u);', 3],
    ['a computed global fetch', 'globalThis["fetch"](u); window[\'fetch\'](u);', 2],
    ['fetch kept under another name', 'const send = fetch; send(u);', 1],
    ['fetch handed on', 'run(fetch); const o = { fetch };', 2],
  ])('the census counts %s', (_, code, count) => {
    expect(fetchUses(code).fetch).toBe(count);
  });

  it.each([
    ['the web tool\'s experiment', 'browser.tmWebFetch.fetch(u);'],
    ['the helper', 'ownServerFetch(u, {});'],
    ['a method, a key and a property named fetch', 'const o = { fetch(u) {}, fetch2: 1 }; class C { fetch() {} } o.fetch(u); const k = { fetch: 1 };'],
  ])('the census does not count %s', (_, code) => {
    expect(fetchUses(code).fetch).toBe(0);
  });

  it('the census counts the helper\'s calls', () => {
    expect(fetchUses('ownServerFetch(a); await ownServerFetch(b, {});').own).toBe(2);
  });
});
