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
    x.instance.onShutdown(false);
  });

  it('keeps independent subscribers and releases them on shutdown', async () => {
    const x = experiment(tableExperiment, 'tmMessageListTableView');
    const failing = vi.fn(() => { throw new Error('synthetic subscriber failure'); });
    const healthy = vi.fn(async () => {});
    x.api.onUntaggedInboxMessages.addListener(failing);
    x.api.onUntaggedInboxMessages.addListener(healthy);
    const payload = [{ messageKey: 8, messageId: '<another@example.test>' }];
    expect(() => x.context.extension.emit('onUntaggedInboxMessages', payload)).not.toThrow();
    await new Promise(resolve => setImmediate(resolve));
    expect(failing).toHaveBeenCalledExactlyOnceWith(payload);
    expect(healthy).toHaveBeenCalledExactlyOnceWith(payload);

    x.api.onUntaggedInboxMessages.removeListener(failing);
    x.context.extension.emit('onUntaggedInboxMessages', payload);
    await new Promise(resolve => setImmediate(resolve));
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(2);
    x.instance.onShutdown(false);
    expect(x.extensionEvents.get('onUntaggedInboxMessages')?.size).toBe(0);
  });
});
