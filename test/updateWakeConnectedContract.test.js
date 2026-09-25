import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { JSDOM } from 'jsdom';
import { experiment } from './helpers/nativeLifecycleHarness.js';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const updatesDeclaration = manifest.experiment_apis.tmUpdates;
const updatesSchema = JSON.parse(readFileSync(new URL(`../${updatesDeclaration.schema}`, import.meta.url), 'utf8'))[0];
const quietConsole = { log() {}, warn() {}, error() {} };

function pane() {
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://example.test/' });
  dom.window.document.createXULElement = tag => dom.window.document.createElement(tag);
  return {
    dom,
    win: {
      document: dom.window.document,
      location: { href: 'chrome://messenger/content/messenger.xhtml' },
      closed: false,
    },
  };
}

function selectedFunction(path, name) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const declaration = ast.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
    .find(node => node?.type === 'FunctionDeclaration' && node.id?.name === name);
  if (!declaration) throw Error(`Missing ${name} in ${path}`);
  return source.slice(declaration.start, declaration.end);
}

function startFromManifest(parent) {
  const paths = manifest.background.scripts.filter(path => path === 'updates/background.js');
  expect(paths).toEqual(['updates/background.js']);
  expect(manifest.background.scripts.indexOf(paths[0])).toBeGreaterThan(
    manifest.background.scripts.indexOf('keepalive/background.js'));
  const source = readFileSync(new URL(`../${paths[0]}`, import.meta.url), 'utf8');
  const listeners = {};
  const publicUpdates = Object.fromEntries([...updatesSchema.functions, ...updatesSchema.events]
    .map(entry => [entry.name, parent[entry.name]]));
  const browser = {
    tmUpdates: publicUpdates,
    runtime: {
      getManifest: () => manifest,
      onUpdateAvailable: { addListener: listener => { listeners.update = listener; } },
      onMessage: { addListener: listener => { listeners.message = listener; } },
      sendMessage: async message => {
        const result = listeners.message(message);
        return result === false ? undefined : await result;
      },
    },
  };
  vm.runInNewContext(source, { browser, console: quietConsole }, { filename: paths[0] });
  expect(listeners.update).toBeTypeOf('function');
  expect(listeners.message).toBeTypeOf('function');
  const unrelated = listeners.message({ command: 'unrelated' });
  expect(unrelated).toBe(false);
  expect(unrelated?.then).toBeUndefined(); // An async listener would steal other messages.
  return { browser, listeners };
}

describe('manifest-selected update wake contract', () => {
  it('retains a pending update across listener teardown and background recreation', async () => {
    const first = pane();
    const second = pane();
    try {
      const x = experiment(updatesDeclaration.parent.script, 'tmUpdates', { windows: [first.win] });
      const quit = vi.fn();
      x.Services.startup = { quit };
      const firstGeneration = startFromManifest(x.api);
      await firstGeneration.listeners.message({ command: 'setPendingUpdate', version: '99.0.3' });
      x.openWindow(second.win);
      expect(second.win.document.getElementById('tabmail-update-notification-bar')).not.toBeNull();

      firstGeneration.browser.tmUpdates.onNotificationAction.close();
      const recreated = x.instance.getAPI(x.context).tmUpdates;
      const secondGeneration = startFromManifest(recreated);
      expect(await secondGeneration.listeners.message({ command: 'getUpdateState' })).toMatchObject({
        updateState: 'pending', pendingVersion: '99.0.3',
      });
      const later = [...first.win.document.querySelectorAll('button')]
        .find(button => button.textContent === 'Later');
      later.click();
      await new Promise(resolve => setImmediate(resolve));
      expect(first.win.document.getElementById('tabmail-update-notification-bar')).toBeNull();
      expect(second.win.document.getElementById('tabmail-update-notification-bar')).toBeNull();
      expect(await recreated.isUpdateBarVisible()).toBe(false);
      expect(await secondGeneration.listeners.message({ command: 'getUpdateState' })).toMatchObject({
        updateState: 'pending', pendingVersion: '99.0.3',
      });
      expect(quit).not.toHaveBeenCalled();
      x.instance.onShutdown(false);
    } finally {
      first.dom.window.close();
      second.dom.window.close();
    }
  });

  it('keeps a real native-FTS bar out of the popup while preserving an add-on update', async () => {
    const p = pane();
    const popup = new JSDOM('<div id="version-status-banner"></div><span id="version-text"></span><a id="check-updates-link"></a>');
    try {
      const x = experiment(updatesDeclaration.parent.script, 'tmUpdates', { windows: [p.win] });
      const quit = vi.fn();
      x.Services.startup = { quit };
      const { browser, listeners } = startFromManifest(x.api);
      expect(x.api.onNotificationAction.testPersistentRegistration()).toBeTruthy();
      const nativeScope = { browser, log: () => {}, console: quietConsole };
      vm.runInNewContext(`${selectedFunction('fts/nativeEngine.js', 'showNativeUpdateBanner')}\nglobalThis.showNativeUpdateBanner = showNativeUpdateBanner;`, nativeScope);
      const popupScope = { browser, document: popup.window.document, console: quietConsole };
      vm.runInNewContext(`${selectedFunction('popup/popup.js', 'updateVersionStatus')}\nglobalThis.updateVersionStatus = updateVersionStatus;`, popupScope);

      await nativeScope.showNativeUpdateBanner('0.11.3');
      expect(p.win.document.getElementById('tabmail-update-notification-bar')).not.toBeNull();
      await popupScope.updateVersionStatus();
      expect(popup.window.document.getElementById('version-text').textContent).toBe(`v${manifest.version}`);
      expect(popup.window.document.getElementById('check-updates-link').classList.contains('hidden')).toBe(false);
      expect(quit).not.toHaveBeenCalled();

      await listeners.update({ version: '1.8.4' });
      expect(p.win.document.querySelector('.tm-update-message-line2')?.textContent).toContain('v1.8.4');
      await nativeScope.showNativeUpdateBanner('0.11.4');
      expect(p.win.document.querySelector('.tm-update-message-line2')?.textContent).toContain('vFTS 0.11.4');
      await popupScope.updateVersionStatus();
      expect(popup.window.document.getElementById('version-text').textContent)
        .toBe('Restart Thunderbird to update to v1.8.4');
      expect(popup.window.document.getElementById('check-updates-link').classList.contains('hidden')).toBe(true);
      const later = [...p.win.document.querySelectorAll('button')]
        .find(button => button.textContent === 'Later');
      later.click();
      await new Promise(resolve => setImmediate(resolve));
      expect(p.win.document.getElementById('tabmail-update-notification-bar')).toBeNull();
      expect(await x.api.isUpdateBarVisible()).toBe(false);
      expect(x.windowListeners.size).toBe(0);
      expect(await listeners.message({ command: 'getUpdateState' })).toMatchObject({
        updateState: 'pending', pendingVersion: '1.8.4',
      });
      expect(quit).not.toHaveBeenCalled();
      popup.window.document.getElementById('version-text').click();
      await new Promise(resolve => setImmediate(resolve));
      expect(quit).toHaveBeenCalledExactlyOnceWith(0x12);
      x.instance.onShutdown(false);
    } finally {
      p.dom.window.close();
      popup.window.close();
    }
  });

  it('routes the debug simulator through the manager and clears a visible bar in every window', async () => {
    const first = pane();
    const second = pane();
    const third = pane();
    const config = new JSDOM('<div id="status"></div><span id="update-debug-state"></span>');
    try {
      const x = experiment(updatesDeclaration.parent.script, 'tmUpdates', { windows: [first.win] });
      const { browser, listeners } = startFromManifest(x.api);
      const scope = { browser, console: quietConsole, SIMULATED_VERSION: '99.0.0',
        $: id => config.window.document.getElementById(id) };
      const functions = ['updateDebugStatusDisplay', 'simulateUpdateAvailable', 'clearUpdateState', 'showUpdateBar']
        .map(name => selectedFunction('config/modules/updateDebug.js', name)).join('\n');
      vm.runInNewContext(`${functions}\nglobalThis.runDebug = { simulateUpdateAvailable, clearUpdateState, showUpdateBar };`, scope);
      await scope.runDebug.simulateUpdateAvailable();
      expect(await listeners.message({ command: 'getUpdateState' })).toMatchObject({
        updateState: 'pending', pendingVersion: '99.0.0',
      });
      expect(first.win.document.querySelector('.tm-update-message-line2')?.textContent)
        .toContain('v99.0.0');
      await x.api.setPendingUpdateVersion('1.8.4');
      await scope.runDebug.showUpdateBar();
      expect(first.win.document.querySelector('.tm-update-message-line2')?.textContent).toContain('v1.8.4');
      await x.api.setPendingUpdateVersion('99.0.0');
      x.openWindow(second.win);
      expect(first.win.document.getElementById('tabmail-update-notification-bar')).not.toBeNull();
      expect(second.win.document.getElementById('tabmail-update-notification-bar')).not.toBeNull();
      expect(await listeners.message({ command: 'getUpdateState' })).toMatchObject({
        updateState: 'pending', pendingVersion: '99.0.0',
      });
      await scope.runDebug.clearUpdateState();
      expect(first.win.document.getElementById('tabmail-update-notification-bar')).toBeNull();
      expect(second.win.document.getElementById('tabmail-update-notification-bar')).toBeNull();
      expect(await x.api.isUpdateBarVisible()).toBe(false);
      expect(await listeners.message({ command: 'getUpdateState' })).toMatchObject({
        updateState: null, pendingVersion: null,
      });
      await scope.runDebug.showUpdateBar();
      expect(first.win.document.querySelector('.tm-update-message-line2')?.textContent)
        .toContain('v99.0.0');
      await x.api.hideUpdateBar();
      x.openWindow(third.win);
      expect(third.win.document.getElementById('tabmail-update-notification-bar')).toBeNull();
      x.instance.onShutdown(false);
    } finally {
      first.dom.window.close();
      second.dom.window.close();
      third.dom.window.close();
      config.window.close();
    }
  });

  it('passes the popup manual update result through the manager to the native bar', async () => {
    const p = pane();
    const popup = new JSDOM('<div id="version-status-banner"></div><a id="check-updates-link">Check for updates</a><span id="version-text"></span>');
    try {
      const x = experiment(updatesDeclaration.parent.script, 'tmUpdates', { windows: [p.win] });
      const { browser, listeners } = startFromManifest(x.api);
      browser.tmUpdates.checkForUpdates = async () => ({ status: 'update_available', version: '1.8.4' });
      const scope = { browser, document: popup.window.document, console: quietConsole };
      vm.runInNewContext(`${selectedFunction('popup/popup.js', 'handleCheckForUpdates')}\nglobalThis.check = handleCheckForUpdates;`, scope);
      await scope.check();
      expect(await listeners.message({ command: 'getUpdateState' })).toMatchObject({
        updateState: 'pending', pendingVersion: '1.8.4',
      });
      expect(p.win.document.querySelector('.tm-update-message-line2')?.textContent).toContain('v1.8.4');
      expect(popup.window.document.getElementById('version-text').textContent)
        .toBe('Restart Thunderbird to update to v1.8.4');
      popup.window.document.getElementById('version-text').textContent = '';
      popup.window.document.getElementById('check-updates-link').classList.remove('hidden');
      vm.runInNewContext(`${selectedFunction('popup/popup.js', 'updateVersionStatus')}\nglobalThis.refresh = updateVersionStatus;`, scope);
      await scope.refresh();
      expect(popup.window.document.getElementById('version-text').textContent)
        .toBe('Restart Thunderbird to update to v1.8.4');
      expect(popup.window.document.getElementById('check-updates-link').classList.contains('hidden')).toBe(true);
      x.instance.onShutdown(false);
    } finally {
      p.dom.window.close();
      popup.window.close();
    }
  });

  it.each([
    ['set then clear', ['setPendingUpdate', 'clearPendingUpdate'], null],
    ['clear then set', ['clearPendingUpdate', 'setPendingUpdate'], '99.0.0'],
  ])('preserves the latest debug request for %s', async (_label, commands, expectedVersion) => {
    const p = pane();
    try {
      const x = experiment(updatesDeclaration.parent.script, 'tmUpdates', { windows: [p.win] });
      const { listeners } = startFromManifest(x.api);
      await Promise.all(commands.map(command => listeners.message({ command, version: '99.0.0' })));
      expect(await listeners.message({ command: 'getUpdateState' })).toMatchObject({
        pendingVersion: expectedVersion,
        updateState: expectedVersion ? 'pending' : null,
      });
      expect(Boolean(p.win.document.getElementById('tabmail-update-notification-bar')))
        .toBe(Boolean(expectedVersion));
      expect(x.windowListeners.size).toBe(expectedVersion ? 1 : 0);
      x.instance.onShutdown(false);
    } finally {
      p.dom.window.close();
    }
  });

  it('passes a native Restart button click to the application quit service once', async () => {
    const p = pane();
    try {
      const x = experiment(updatesDeclaration.parent.script, 'tmUpdates', { windows: [p.win] });
      const quit = vi.fn();
      x.Services.startup = { quit };
      const { listeners } = startFromManifest(x.api);
      await listeners.update({ version: '99.0.0' });
      expect(p.win.document.querySelector('.tm-update-message-line2')?.textContent).toContain('v99.0.0');
      expect(quit).not.toHaveBeenCalled();
      const restart = [...p.win.document.querySelectorAll('button')]
        .find(button => button.textContent === 'Restart Thunderbird');
      expect(restart).toBeTruthy();
      restart.click();
      await new Promise(resolve => setImmediate(resolve));
      expect(quit).toHaveBeenCalledExactlyOnceWith(0x12);
      x.instance.onShutdown(false);
    } finally {
      p.dom.window.close();
    }
  });
});
