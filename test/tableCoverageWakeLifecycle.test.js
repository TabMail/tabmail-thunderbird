import { describe, expect, it, vi } from 'vitest';
import { experiment } from './helpers/nativeLifecycleHarness.js';

const tableExperiment = 'theme/experiments/tmMessageListTableView/tmMessageListTableView.sys.mjs';

describe('table coverage event lifecycle', () => {
  it('replays the original untagged-row payload through a primed listener', async () => {
    const x = experiment(tableExperiment, 'tmMessageListTableView');
    const persistent = x.api.onUntaggedInboxMessages.testPersistentRegistration();
    expect(persistent).toMatchObject({
      module: 'tmMessageListTableView', event: 'onUntaggedInboxMessages',
    });
    const pending = [];
    const registration = persistent.prime({
      async: messages => new Promise(resolve => pending.push({ messages, resolve })),
    });
    const original = [{ messageKey: 7, messageId: '<synthetic@example.test>', weMsgId: 91,
      folderUri: 'mailbox://synthetic/Inbox', rowIndex: 2 }];
    x.context.extension.emit('onUntaggedInboxMessages', original);
    expect(pending).toHaveLength(1);
    expect(pending[0].messages).toEqual(original);

    const resumed = vi.fn(async () => {});
    registration.convert({ async: resumed });
    x.context.extension.emit('onUntaggedInboxMessages', original);
    await new Promise(resolve => setImmediate(resolve));
    expect(resumed).toHaveBeenCalledExactlyOnceWith(original);
    registration.unregister();
    expect(x.extensionEvents.get('onUntaggedInboxMessages')?.size).toBe(0);
    expect(x.instance._untaggedSubscriptions_MLTV.size).toBe(0);
    x.instance.onShutdown(false);
  });

  it('keeps independent subscribers and releases them on shutdown', async () => {
    const x = experiment(tableExperiment, 'tmMessageListTableView');
    const failing = vi.fn(async () => { throw new Error('synthetic subscriber failure'); });
    const syncFailing = vi.fn(() => { throw new Error('synthetic synchronous failure'); });
    const healthy = vi.fn(async () => {});
    x.api.onUntaggedInboxMessages.addListener(failing);
    x.api.onUntaggedInboxMessages.addListener(syncFailing);
    x.api.onUntaggedInboxMessages.addListener(healthy);
    const payload = [{ messageKey: 8, messageId: '<another@example.test>' }];
    expect(() => x.context.extension.emit('onUntaggedInboxMessages', payload)).not.toThrow();
    await new Promise(resolve => setImmediate(resolve));
    expect(failing).toHaveBeenCalledExactlyOnceWith(payload);
    expect(syncFailing).toHaveBeenCalledExactlyOnceWith(payload);
    expect(healthy).toHaveBeenCalledExactlyOnceWith(payload);
    expect(x.logs.some(args => args.some(value =>
      String(value).includes('untagged subscriber failed')))).toBe(true);

    x.api.onUntaggedInboxMessages.removeListener(failing);
    x.context.extension.emit('onUntaggedInboxMessages', payload);
    await new Promise(resolve => setImmediate(resolve));
    expect(failing).toHaveBeenCalledTimes(1);
    expect(syncFailing).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    x.instance.onShutdown(false);
    expect(x.extensionEvents.get('onUntaggedInboxMessages')?.size).toBe(0);
    expect(x.instance._untaggedSubscriptions_MLTV.size).toBe(0);
  });

  it('contains a rejected primed event that cannot be renewed', async () => {
    const x = experiment(tableExperiment, 'tmMessageListTableView');
    const registration = x.api.onUntaggedInboxMessages.testPersistentRegistration().prime({
      async: () => Promise.reject(new Error('synthetic unrenewed listener')),
    });
    x.context.extension.emit('onUntaggedInboxMessages', [{ messageKey: 9 }]);
    await new Promise(resolve => setImmediate(resolve));
    expect(x.logs.some(args => args.some(value =>
      String(value).includes('untagged subscriber failed')))).toBe(true);
    registration.unregister();
    expect(x.instance._untaggedSubscriptions_MLTV.size).toBe(0);
    x.instance.onShutdown(false);
  });

  it('bounds subscription records across repeated prime and close cycles', async () => {
    const x = experiment(tableExperiment, 'tmMessageListTableView');
    const persistent = x.api.onUntaggedInboxMessages.testPersistentRegistration();
    for (let generation = 0; generation < 5; generation++) {
      const received = vi.fn(async () => {});
      const registration = persistent.prime({ async: received });
      expect(x.instance._untaggedSubscriptions_MLTV.size).toBe(1);
      x.context.extension.emit('onUntaggedInboxMessages', [{ messageKey: generation + 1 }]);
      await new Promise(resolve => setImmediate(resolve));
      expect(received).toHaveBeenCalledOnce();
      registration.unregister();
      expect(x.instance._untaggedSubscriptions_MLTV.size).toBe(0);
      expect(x.extensionEvents.get('onUntaggedInboxMessages')?.size).toBe(0);
    }
    x.instance.onShutdown(false);
  });
});
