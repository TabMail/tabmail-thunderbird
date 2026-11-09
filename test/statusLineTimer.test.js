/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// statusLineTimer.test.js — every extension page's status line keeps each status up for the full
// hide delay from when it appeared, whatever status came before it (#249). An earlier status's
// timer used to hide a later one early, so a failure said only in the status line could go unseen.
// Covered: the prompts, templates and marketplace pages' status line; the Settings page's
// appearance, autocomplete and search-progress lines and its shared status line; the popup's
// "Check for updates" label.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealm } from './support/deviceRealm.js';
import { STATUS_LINE_CONFIG } from '../agent/modules/statusLine.js';

const ROOT = new URL('../', import.meta.url);
const HIDE_AFTER_MS = STATUS_LINE_CONFIG.hideAfterMs;
const CHECK_RESULT_MS = STATUS_LINE_CONFIG.updateCheckResultMs;
const noop = () => {};
// Stands in for every `browser` API the pages touch at load: any property, any call, resolving to {}.
const absorb = new Proxy(function () {}, { get: (_, key) => (key === 'then' ? undefined : absorb), apply: async () => ({}) });

// Each page with a status line: its document, its script, the module that shows a status, and what
// "the status is showing" means in that page's own markup.
const PAGES = [
  {
    name: 'prompts page',
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

// The Settings page (config.html) with its real status-line modules. `replies` answers the
// background's `fts` commands by name (a list answers one call each; a pending promise keeps a scan
// running), and `storage` holds what the page reads back from storage by key.
function openSettings(replies = {}, storage = {}) {
  const dom = new JSDOM(readFileSync(new URL('config/config.html', ROOT), 'utf8'));
  const realm = createRealm({
    files: [
      'config/modules/appearance.js',
      'config/modules/dom.js',
      'config/modules/fts.js',
      'config/modules/autocompleteSettings.js',
      'config/modules/reminders.js',
      'agent/modules/statusLine.js',
    ],
    stubs: {
      'agent/modules/summaryDisplaySettings.js': { getShowAiSummariesEnabled: async () => true, setShowAiSummariesEnabled: async () => {} },
      'fts/helperPrompt.js': { FTS_HELPER_DOWNLOAD_URL: 'https://example.com', getFtsHelperPrompt: () => '' },
    },
    globals: {
      document: dom.window.document,
      window: dom.window,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      confirm: () => true,
      console: { log: noop, warn: noop, error: noop },
      browser: {
        storage: { local: { set: async () => {}, get: async (k) => (typeof k === 'string' ? { [k]: storage[k] } : k) } },
        runtime: {
          sendMessage: async (msg) => {
            const reply = replies[msg.cmd];
            return (Array.isArray(reply) ? reply.shift() : reply) ?? {};
          },
          onMessage: { addListener: noop, removeListener: noop },
        },
      },
    },
  });
  const doc = dom.window.document;
  return {
    appearance: realm.require('config/modules/appearance.js'),
    autocomplete: realm.require('config/modules/autocompleteSettings.js'),
    reminders: realm.require('config/modules/reminders.js'),
    fts: realm.require('config/modules/fts.js'),
    line: (id) => doc.getElementById(id),
  };
}

describe('the Settings page status lines keep each status up for its full time (#249)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('appearance: a status shown just before an earlier one would hide stays up for the full delay', async () => {
    const page = openSettings();
    const status = page.line('appearance-status-text');

    await page.appearance.handleAppearanceChange({ target: { id: 'show-ai-summaries', checked: true } }, {});
    vi.advanceTimersByTime(HIDE_AFTER_MS - 100);
    await page.appearance.handleAppearanceChange({ target: { id: 'tag-by-thread-enabled', checked: true } }, {});

    vi.advanceTimersByTime(100); // the earlier status's delay is over
    expect(status.textContent).toBe('✓ Tag by thread enabled');
    vi.advanceTimersByTime(HIDE_AFTER_MS - 100 - 1);
    expect(status.textContent).toBe('✓ Tag by thread enabled');
    vi.advanceTimersByTime(1);
    expect(status.textContent).toBe('');
  });

  it('autocomplete: a status shown just before an earlier one would hide stays up for the full delay', async () => {
    const page = openSettings();
    const status = page.line('autocomplete-status-text');

    await page.autocomplete.handleAutocompleteSettingsChange({ target: { id: 'autocomplete-delay', value: '300' } });
    vi.advanceTimersByTime(HIDE_AFTER_MS - 100);
    await page.autocomplete.handleAutocompleteSettingsChange({ target: { id: 'autocomplete-delay', value: '400' } });

    vi.advanceTimersByTime(100);
    expect(status.textContent).toBe('✓ Suggestion delay set to 400 ms');
    vi.advanceTimersByTime(HIDE_AFTER_MS - 100 - 1);
    expect(status.textContent).toBe('✓ Suggestion delay set to 400 ms');
    vi.advanceTimersByTime(1);
    expect(status.textContent).toBe('');
  });

  it('lines are independent: a status on one line neither cancels nor delays another line\'s hide', async () => {
    const page = openSettings();
    const appearance = page.line('appearance-status-text');
    const autocomplete = page.line('autocomplete-status-text');

    await page.appearance.handleAppearanceChange({ target: { id: 'show-ai-summaries', checked: true } }, {});
    vi.advanceTimersByTime(HIDE_AFTER_MS / 2);
    await page.autocomplete.handleAutocompleteSettingsChange({ target: { id: 'autocomplete-delay', value: '300' } });

    vi.advanceTimersByTime(HIDE_AFTER_MS / 2);
    expect(appearance.textContent).toBe('');
    expect(autocomplete.textContent).toBe('✓ Suggestion delay set to 300 ms');
    vi.advanceTimersByTime(HIDE_AFTER_MS / 2);
    expect(autocomplete.textContent).toBe('');
  });

  it('shared status line: a failed scan is not erased by an earlier update check or save', async () => {
    const page = openSettings({
      manualCheckAndUpdateHost: { ok: true, updated: false, message: 'Up to date' },
      smartReindex: { ok: false, error: 'example failure' },
    });
    const status = page.line('status');

    await page.fts.ftsManualCheckAndUpdateHost();
    await page.reminders.saveReminderSettings(noop);
    expect(status.textContent).toBe('Saved: Reminders to show = 3');
    vi.advanceTimersByTime(1000);
    await page.fts.ftsSmartReindex();

    vi.advanceTimersByTime(60000);
    expect(status.textContent).toBe('Smart reindex failed: example failure');
  });

  it('shared status line: a later status shows in the same color as when shown alone', async () => {
    const alone = openSettings();
    await alone.reminders.saveReminderSettings(noop);
    const ownColor = alone.line('status').style.color;

    const page = openSettings({ manualCheckAndUpdateHost: { ok: false, error: 'example' } });
    await page.fts.ftsManualCheckAndUpdateHost();
    expect(page.line('status').textContent).toBe('Update check failed: example');
    await page.reminders.saveReminderSettings(noop);
    expect(page.line('status').textContent).toBe('Saved: Reminders to show = 3');
    expect(page.line('status').style.color).toBe(ownColor);
  });

  // Each way a scan starts on the search-progress panel, and the answer that finishes it.
  const SCANS = [
    { name: 'a smart reindex', cmd: 'smartReindex', start: (fts) => fts.ftsSmartReindex(), done: { ok: true, indexed: 5, skipped: 0 } },
    { name: 'a full reindex', cmd: 'reindexAll', start: (fts) => fts.ftsReindexAll(), done: { ok: true, indexed: 5, batches: 1 } },
    { name: 'a maintenance scan', cmd: 'maintenanceTrigger', start: (fts) => fts.ftsMaintenanceTrigger('daily', true), done: { ok: true, indexed: 5 } },
  ];

  it.each(SCANS)('search progress: $name started before an earlier scan\'s result would hide keeps its panel, then shows its own result for the full delay', async (scan) => {
    let finish;
    const running = new Promise((resolve) => { finish = resolve; });
    const replies = { smartReindex: [{ ok: true, indexed: 10, skipped: 0 }] };
    replies[scan.cmd] = scan.cmd === 'smartReindex' ? [...replies.smartReindex, running] : running;
    const page = openSettings(replies);
    const panel = page.line('fts-progress');

    await page.fts.ftsSmartReindex();
    expect(page.line('fts-progress-text').textContent).toBe('Smart reindex completed: 10 checked');
    vi.advanceTimersByTime(HIDE_AFTER_MS - 100);
    const scanning = scan.start(page.fts);

    vi.advanceTimersByTime(60000); // the earlier result's delay is long over
    expect(panel.style.display).toBe('block');

    finish(scan.done);
    await scanning;
    vi.advanceTimersByTime(HIDE_AFTER_MS - 1);
    expect(panel.style.display).toBe('block');
    vi.advanceTimersByTime(1);
    expect(panel.style.display).toBe('none');
  });

  it('search progress: an embedding rebuild found running before an earlier scan\'s result would hide keeps its panel', async () => {
    const storage = {};
    const page = openSettings({ smartReindex: { ok: true, indexed: 10, skipped: 0 } }, storage);
    const panel = page.line('fts-progress');

    await page.fts.ftsSmartReindex();
    vi.advanceTimersByTime(HIDE_AFTER_MS - 100);
    storage.fts_scan_status = { isScanning: true, scanType: 'embeddingRebuild', progress: { processed: 1, total: 4 } };
    await page.fts.updateFtsStatus();
    expect(page.line('fts-progress-text').textContent).toMatch(/^Rebuilding embeddings/);

    vi.advanceTimersByTime(60000);
    expect(panel.style.display).toBe('block');
  });

  it('control: a failed scan shown alone stays on the shared line', async () => {
    const page = openSettings({ smartReindex: { ok: false, error: 'example failure' } });

    await page.fts.ftsSmartReindex();
    vi.advanceTimersByTime(60000);
    expect(page.line('status').textContent).toBe('Smart reindex failed: example failure');
  });
});

// The popup with its real script; each "Check for updates" click answers with the next result.
function openPopup(results) {
  const dom = new JSDOM(readFileSync(new URL('popup/popup.html', ROOT), 'utf8'));
  const browser = new Proxy({
    tmUpdates: { checkForUpdates: async () => results.shift() },
  }, { get: (target, name) => target[name] ?? absorb });
  createRealm({
    files: ['popup/popup.js', 'agent/modules/statusLine.js'],
    stubs: {
      'agent/modules/config.js': { getBackendUrl: async () => 'https://backend.example.com', SETTINGS: {} },
      'theme/palette/palette.js': { injectPaletteIntoDocument: async () => {} },
      'agent/modules/setupChecks.js': { checkSetupConfiguration: async () => ({}) },
      'agent/modules/billingBanner.js': { bannerFromWhoami: () => null, isZeroQuotaPlan: () => false },
      'agent/modules/byokStorage.js': { buildByokPayload: async () => ({}) },
      'fts/helperPrompt.js': { FTS_HELPER_DOWNLOAD_URL: 'https://example.com', getFtsHelperPrompt: () => null },
    },
    globals: {
      document: dom.window.document,
      window: dom.window,
      navigator: { platform: 'MacIntel' },
      getComputedStyle: dom.window.getComputedStyle,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: () => 1,
      clearInterval: noop,
      console: { log: noop, warn: noop, error: noop },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      browser,
    },
  }).require('popup/popup.js');
  return dom.window.document.getElementById('check-updates-link');
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('the popup\'s update-check label keeps each result up for its full time (#249)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a re-check before an earlier result is reset shows its own result for the full time, then the link\'s own label', async () => {
    const link = openPopup([{ status: 'error', error: 'example' }, { status: 'no_update', currentVersion: '1.0.0' }]);
    await settle();
    const ownLabel = link.textContent;

    link.click();
    await settle();
    expect(link.textContent).toBe('Check failed');
    vi.advanceTimersByTime(CHECK_RESULT_MS - 100);

    link.click();
    await settle();
    vi.advanceTimersByTime(100); // the earlier result's time is over
    expect(link.textContent).toBe('Up to date!');
    vi.advanceTimersByTime(CHECK_RESULT_MS - 100 - 1);
    expect(link.textContent).toBe('Up to date!');
    vi.advanceTimersByTime(1);
    expect(link.textContent).toBe(ownLabel);
    vi.advanceTimersByTime(60000);
    expect(link.textContent).toBe(ownLabel);
  });

  it('a re-check still running when an earlier result\'s time is over keeps saying it is checking', async () => {
    const link = openPopup([{ status: 'error', error: 'example' }, new Promise(() => {})]);
    await settle();

    link.click();
    await settle();
    expect(link.textContent).toBe('Check failed');
    vi.advanceTimersByTime(CHECK_RESULT_MS - 100);

    link.click();
    await settle();
    vi.advanceTimersByTime(60000);
    expect(link.textContent).toBe('Checking...');
  });

  it('control: one check shows its result for the full time, then the link\'s own label', async () => {
    const link = openPopup([{ status: 'no_update', currentVersion: '1.0.0' }]);
    await settle();
    const ownLabel = link.textContent;

    link.click();
    await settle();
    expect(link.textContent).toBe('Up to date!');
    vi.advanceTimersByTime(CHECK_RESULT_MS - 1);
    expect(link.textContent).toBe('Up to date!');
    vi.advanceTimersByTime(1);
    expect(link.textContent).toBe(ownLabel);
  });
});
