import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { experiment } from './helpers/nativeLifecycleHarness.js';

const script = 'gui/experiments/tmUpdates/tmUpdates.sys.mjs';

function updateWindow() {
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

describe('update notification wake lifecycle', () => {
  it('delivers the first Later click through a primed listener after background suspension', async () => {
    const { dom, win } = updateWindow();
    try {
      const x = experiment(script, 'tmUpdates', { windows: [win] });
      const event = x.api.onNotificationAction.testPersistentRegistration();
      expect(event).toMatchObject({ module: 'tmUpdates', event: 'onNotificationAction' });
      const received = vi.fn(async () => {});
      const subscription = event.prime({ async: received });
      await x.api.showUpdateBar({ version: '99.0.0', message: 'Synthetic update' });
      expect(await x.api.isUpdateBarVisible()).toBe(true);
      expect(await x.api.getPendingUpdateVersion()).toBeNull();
      const later = [...win.document.querySelectorAll('button')].find(button => button.textContent === 'Later');
      later.click();
      await new Promise(resolve => setImmediate(resolve));
      expect(received).toHaveBeenCalledExactlyOnceWith({ action: 'dismiss' });
      expect(win.document.getElementById('tabmail-update-notification-bar')).toBeNull();

      const converted = vi.fn(async () => {});
      subscription.convert({ async: converted });
      await x.api.showUpdateBar({ version: '99.0.1', message: 'Synthetic update' });
      const restart = [...win.document.querySelectorAll('button')].find(button => button.textContent === 'Restart Thunderbird');
      restart.click();
      await new Promise(resolve => setImmediate(resolve));
      expect(converted).toHaveBeenCalledExactlyOnceWith({ action: 'restart' });
      subscription.unregister();
      x.instance.onShutdown(false);
      expect(win.document.getElementById('tabmail-update-notification-bar')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('keeps process-lifetime pending update state after Later but clears it on explicit hide', async () => {
    const { dom, win } = updateWindow();
    try {
      const x = experiment(script, 'tmUpdates', { windows: [win] });
      await x.api.setPendingUpdateVersion('99.0.0');
      await x.api.showUpdateBar({ version: '99.0.0', message: 'Synthetic update' });
      await x.api.dismissUpdateBar();
      expect(await x.api.isUpdateBarVisible()).toBe(false);
      expect(await x.api.getPendingUpdateVersion()).toBe('99.0.0');
      await x.api.hideUpdateBar();
      expect(await x.api.getPendingUpdateVersion()).toBe('99.0.0');
      await x.api.clearPendingUpdateVersion();
      expect(await x.api.getPendingUpdateVersion()).toBeNull();
      x.instance.onShutdown(false);
    } finally {
      dom.window.close();
    }
  });

  it('shows a pending bar in a new window and does not revive it after Later', async () => {
    const first = updateWindow();
    const second = updateWindow();
    const third = updateWindow();
    try {
      const x = experiment(script, 'tmUpdates', { windows: [first.win] });
      await x.api.setPendingUpdateVersion('99.0.0');
      await x.api.showUpdateBar({ version: '99.0.0', message: 'Synthetic update' });
      x.openWindow(second.win);
      expect(second.win.document.getElementById('tabmail-update-notification-bar')).not.toBeNull();
      await x.api.dismissUpdateBar();
      expect(first.win.document.getElementById('tabmail-update-notification-bar')).toBeNull();
      expect(second.win.document.getElementById('tabmail-update-notification-bar')).toBeNull();
      x.openWindow(third.win);
      expect(third.win.document.getElementById('tabmail-update-notification-bar')).toBeNull();
      expect(await x.api.getPendingUpdateVersion()).toBe('99.0.0');
      x.instance.onShutdown(false);
      expect(await x.api.getPendingUpdateVersion()).toBeNull();
    } finally {
      first.dom.window.close();
      second.dom.window.close();
      third.dom.window.close();
    }
  });

  it('does not treat a native FTS update bar as a pending add-on update', async () => {
    const { dom, win } = updateWindow();
    try {
      const x = experiment(script, 'tmUpdates', { windows: [win] });
      await x.api.showUpdateBar({ version: 'FTS 0.11.0', message: 'Synthetic native update' });
      expect(await x.api.isUpdateBarVisible()).toBe(true);
      expect(await x.api.getPendingUpdateVersion()).toBeNull();
      await x.api.hideUpdateBar();
      expect(await x.api.getPendingUpdateVersion()).toBeNull();
      x.instance.onShutdown(false);
    } finally {
      dom.window.close();
    }
  });

  it('bounds primed subscribers and stops delivery after unregister or shutdown', async () => {
    const x = experiment(script, 'tmUpdates');
    const event = x.api.onNotificationAction.testPersistentRegistration();
    for (let generation = 0; generation < 3; generation++) {
      const received = vi.fn(async () => {});
      const subscription = event.prime({ async: received });
      expect(x.instance._actionSubscriptions.size).toBe(1);
      x.context.extension.emit('onNotificationAction', { action: 'dismiss' });
      await new Promise(resolve => setImmediate(resolve));
      expect(received).toHaveBeenCalledTimes(1);
      subscription.unregister();
      x.context.extension.emit('onNotificationAction', { action: 'restart' });
      await new Promise(resolve => setImmediate(resolve));
      expect(received).toHaveBeenCalledTimes(1);
      expect(x.instance._actionSubscriptions.size).toBe(0);
    }
    const afterShutdown = vi.fn(async () => {});
    event.prime({ async: afterShutdown });
    x.instance.onShutdown(false);
    x.context.extension.emit('onNotificationAction', { action: 'dismiss' });
    await new Promise(resolve => setImmediate(resolve));
    expect(afterShutdown).not.toHaveBeenCalled();
    expect(x.instance._actionSubscriptions.size).toBe(0);
  });

  it('contains a rejected action subscriber without preventing another one', async () => {
    const x = experiment(script, 'tmUpdates');
    const rejected = vi.fn(async () => { throw Error('synthetic subscriber failure'); });
    const healthy = vi.fn(async () => {});
    x.api.onNotificationAction.addListener(rejected);
    x.api.onNotificationAction.addListener(healthy);
    x.context.extension.emit('onNotificationAction', { action: 'dismiss' });
    await new Promise(resolve => setImmediate(resolve));
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(x.logs.some(args => args.some(value =>
      String(value).includes('Notification action subscriber failed')))).toBe(true);
    x.instance.onShutdown(false);
  });
});
