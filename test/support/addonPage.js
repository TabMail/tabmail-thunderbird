/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// One of the add-on's pages (the prompt history, the templates, the popup) as it runs, for tests: its
// shipped HTML and its real module on a device of bulletDevices.js.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createRealm } from './deviceRealm.js';
import { settleMany } from './promptsPage.js';

const ROOT = new URL('../../', import.meta.url);
const noop = () => {};

/** `browser` for a page: the device's storage, `runtime` from `runtime`, and for anything else an API whose
 * every call resolves to nothing, recorded in `calls`. */
function pageBrowser(a, runtime, calls) {
  const any = (path) => new Proxy(function api() {}, {
    get: (_, name) => (name === 'then' ? undefined : any(`${path}.${String(name)}`)),
    apply: (_, __, args) => {
      calls.push([path, ...args]);
      return Promise.resolve(undefined);
    },
  });
  const known = { storage: a.store.api(), runtime: { getURL: (path) => `moz-extension://synthetic/${path}`, ...runtime } };
  return new Proxy(known, { get: (target, name) => target[name] ?? any(String(name)) });
}

/** One of the add-on's pages, its module loaded on device `a` with `stubs` for the imports it needs.
 * `wrapBrowser` returns the `browser` the page gets, given the one built here; `timers` replaces the
 * page's `setInterval` and `clearInterval` (by default an interval never runs). */
export async function loadPage(a, { html, files, stubs = {}, runtime = {}, wrapBrowser = (browser) => browser, timers = {} }) {
  const dom = new JSDOM(readFileSync(new URL(html, ROOT), 'utf8'));
  // JSDOM's own DOMContentLoaded goes by before the page's module is loaded; the test fires the page's.
  await settleMany(2);
  const calls = [];
  const messages = [];
  const sendMessage = async (message) => {
    messages.push(message);
    return { ok: true, connected: false, entries: [] };
  };
  const realm = createRealm({
    files,
    stubs: {
      'agent/modules/utils.js': { log: noop },
      'theme/palette/palette.js': { injectPaletteIntoDocument: async () => {} },
      ...stubs,
    },
    globals: {
      document: dom.window.document,
      window: dom.window,
      navigator: { platform: 'MacIntel' },
      getComputedStyle: dom.window.getComputedStyle,
      setTimeout: () => 1,
      clearTimeout: noop,
      setInterval: () => 1,
      clearInterval: noop,
      ...timers,
      console: { log: noop, warn: noop, error: noop, debug: noop, info: noop },
      browser: wrapBrowser(pageBrowser(a, { sendMessage, ...runtime }, calls)),
    },
  });
  for (const file of files) realm.require(file);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await settleMany();
  return { document: dom.window.document, dom, calls, messages };
}
