/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// A request to TabMail's own servers never follows a redirect (agent/modules/ownServerFetch.js):
// the helper's options, a live redirect between two loopback servers, and a source check that every
// request to our servers goes through the helper.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { ownServerFetch } from '../agent/modules/ownServerFetch.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('ownServerFetch options', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes the request on with redirect "error", over a caller\'s own redirect', async () => {
    const seen = [];
    vi.stubGlobal('fetch', async (url, init) => { seen.push([url, init]); return new Response('ok'); });
    const signal = new AbortController().signal;
    await ownServerFetch('https://api.example.com/x', {
      method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{"a":1}', signal, redirect: 'follow',
    });
    await ownServerFetch('https://api.example.com/y');
    expect(seen).toEqual([
      ['https://api.example.com/x', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{"a":1}', signal, redirect: 'error' }],
      ['https://api.example.com/y', { redirect: 'error' }],
    ]);
  });
});

/* two loopback servers: `first` answers every request with `status` and a Location on `second`; `second`
   records what reaches it and answers 200 "landed" */
async function servers(status) {
  const reached = [];
  const second = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { reached.push({ method: req.method, url: req.url, body, auth: req.headers.authorization }); res.end('landed'); });
  });
  await new Promise(r => second.listen(0, '127.0.0.1', r));
  const secondURL = `http://127.0.0.1:${second.address().port}`;
  const first = createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(status, { Location: `${secondURL}/elsewhere` }); res.end(); });
  });
  await new Promise(r => first.listen(0, '127.0.0.1', r));
  const close = () => Promise.all([first, second].map(s => new Promise(r => s.close(r))));
  return { firstURL: `http://127.0.0.1:${first.address().port}/start`, reached, close };
}

const REDIRECTS = [301, 302, 303, 307, 308];
const REQUESTS = {
  get: { method: 'GET', headers: { Authorization: 'Bearer synthetic-token' } },
  postWithBody: { method: 'POST', headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' }, body: '{"refresh_token":"synthetic"}' },
};

describe('a redirect from our server is not followed', () => {
  for (const status of REDIRECTS) for (const [name, init] of Object.entries(REQUESTS)) {
    it(`${status}, ${name}: the request fails and the other server sees nothing`, async () => {
      const s = await servers(status);
      try {
        await expect(ownServerFetch(s.firstURL, init)).rejects.toThrow(TypeError);
        expect(s.reached).toEqual([]);
      } finally { await s.close(); }
    });

    it(`${status}, ${name}: control, plain fetch follows the same redirect`, async () => {
      const s = await servers(status);
      try {
        const res = await fetch(s.firstURL, init);
        expect(await res.text()).toBe('landed');
        expect(s.reached).toHaveLength(1);
      } finally { await s.close(); }
    });
  }
});

/* every call of the global fetch in the add-on's own code, by file. A request to TabMail's own servers goes
   through ownServerFetch; only these call fetch directly. */
const BARE_FETCH_ALLOWED = {
  'agent/modules/ownServerFetch.js': 1,     // the helper itself
  'agent/modules/promptStore.js': 1,        // an add-on file (runtime.getURL)
  'agent/modules/templateManager.js': 1,    // an add-on file (runtime.getURL)
  'theme/palette/palette.js': 1,            // an add-on file (runtime.getURL)
  'welcome/modules/pageLoader.js': 1,       // an add-on file
  'fts/diagnostics.js': 1,                  // an add-on file (runtime.getURL)
  'fts/nativeEngine.js': 1,                 // the search helper's signed update manifest on the CDN, no token
  'prompts/modules/developer.js': 1,        // a developer page talking to a local backend
};
const SKIP_DIRS = new Set(['node_modules', 'test', '.git', 'coverage', 'libs']);

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) out.push(...sourceFiles(join(dir, e.name))); }
    else if (/\.m?js$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/* calls of the global fetch: `fetch(...)` and `globalThis|window|self.fetch(...)` */
function bareFetchCalls(source, file) {
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
  catch { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }); }
  let n = 0;
  const walk = node => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression') {
      const c = node.callee;
      if (c.type === 'Identifier' && c.name === 'fetch') n++;
      if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'fetch'
        && c.object.type === 'Identifier' && ['globalThis', 'window', 'self'].includes(c.object.name)) n++;
    }
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
  it('the add-on calls fetch directly only where the list says', () => {
    const counted = {};
    for (const f of sourceFiles(ROOT)) {
      const n = bareFetchCalls(readFileSync(f, 'utf8'), f);
      if (n) counted[relative(ROOT, f).split('\\').join('/')] = n;
    }
    expect(counted).toEqual(BARE_FETCH_ALLOWED);
  });

  it('the census sees a call it should count', () => {
    expect(bareFetchCalls('async function f(u) { await fetch(u, {}); return globalThis.fetch(u); }')).toBe(2);
    expect(bareFetchCalls('browser.tmWebFetch.fetch(u); ownServerFetch(u); const o = { fetch(u) {} };')).toBe(0);
  });
});
