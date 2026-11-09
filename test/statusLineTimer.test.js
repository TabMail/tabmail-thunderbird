/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// statusLineTimer.test.js — every extension page's status line keeps each status up for the full
// hide delay from when it appeared, whatever status came before it (#249). An earlier status's
// timer used to hide a later one early, so a failure said only in the status line could go unseen.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealm } from './support/deviceRealm.js';
import { _testExports } from '../agent/modules/statusLine.js';

const ROOT = new URL('../', import.meta.url);
const HIDE_AFTER_MS = _testExports.STATUS_LINE_CONFIG.hideAfterMs;
const noop = () => {};
// Stands in for every `browser` API the pages touch at load: any property, any call, resolving to {}.
const absorb = new Proxy(function () {}, { get: (_, key) => (key === 'then' ? undefined : absorb), apply: async () => ({}) });

// Each page with a status line: its document, its script, the module that shows a status, and what
// "the status is showing" means in that page's own markup.
const PAGES = [
  {
    name: 'settings (prompts) page',
    html: 'prompts/prompts.html',
    file: 'prompts/modules/utils.js',
    stubs: { 'agent/modules/utils.js': { log: noop } },
    showing: (el) => el.style.display === 'block',
  },
  {
    name: 'templates page',
    html: 'templates/templates.html',
    file: 'templates/templates.js',
    expose: ['showStatus'],
    stubs: {
      'agent/modules/utils.js': { log: noop },
      'agent/modules/config.js': { getTemplateWorkerUrl: async () => 'https://templates.example.com' },
      'agent/modules/templateManager.js': { TEMPLATES_BUSY_ERROR: 'busy' },
      'theme/palette/palette.js': { injectPaletteIntoDocument: async () => {} },
    },
    showing: (el) => el.className !== '' && el.textContent !== '',
  },
  {
    name: 'marketplace page',
    html: 'marketplace/marketplace.html',
    file: 'marketplace/marketplace.js',
    expose: ['showStatus'],
    stubs: {
      'agent/modules/utils.js': { log: noop },
      'agent/modules/config.js': { getTemplateWorkerUrl: async () => 'https://templates.example.com' },
      'theme/palette/palette.js': { injectPaletteIntoDocument: async () => {} },
    },
    showing: (el) => el.classList.contains('visible'),
  },
];

/** The page's showStatus and its status element, in a realm whose timers are vitest's fake ones. */
function openPage(page) {
  const dom = new JSDOM(readFileSync(new URL(page.html, ROOT), 'utf8'));
  const realm = createRealm({
    files: [page.file, 'agent/modules/statusLine.js'],
    stubs: page.stubs,
    expose: page.expose ? { [page.file]: page.expose } : {},
    globals: {
      document: dom.window.document,
      window: dom.window,
      navigator: { platform: 'MacIntel' },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: () => 1,
      clearInterval: noop,
      console: { log: noop, warn: noop, error: noop },
      browser: absorb,
    },
  });
  const status = dom.window.document.getElementById('status-message');
  return { showStatus: realm.require(page.file).showStatus, status, showing: () => page.showing(status) };
}

describe('a status line keeps each status up for the full delay (#249)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe.each(PAGES)('$name', (page) => {
    it('a failure shown just before an earlier status would hide stays up for the full delay', () => {
      const { showStatus, status, showing } = openPage(page);

      showStatus('Chat history refreshed');
      vi.advanceTimersByTime(HIDE_AFTER_MS - 100);
      showStatus('Search failed: example', true);

      vi.advanceTimersByTime(100); // the earlier status's delay is over
      expect(showing()).toBe(true);
      expect(status.textContent).toBe('Search failed: example');

      vi.advanceTimersByTime(HIDE_AFTER_MS - 100 - 1);
      expect(showing()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(showing()).toBe(false);
    });

    it('control: a status shown alone is hidden after the delay, not before', () => {
      const { showStatus, showing } = openPage(page);

      showStatus('Saved');
      expect(showing()).toBe(true);
      vi.advanceTimersByTime(HIDE_AFTER_MS - 1);
      expect(showing()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(showing()).toBe(false);
    });

    it('many statuses in a row leave one pending hide, for the last one', () => {
      const { showStatus, showing } = openPage(page);

      for (let i = 0; i < 5; i++) {
        showStatus(`Status ${i}`, i % 2 === 1);
        vi.advanceTimersByTime(HIDE_AFTER_MS / 2);
      }
      expect(vi.getTimerCount()).toBe(1);
      expect(showing()).toBe(true);
      vi.advanceTimersByTime(HIDE_AFTER_MS / 2);
      expect(showing()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
