import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url), 'utf8');

function createExperiment() {
  const listeners = new Set();
  const eventManagers = [];
  const addListener = vi.fn(listener => listeners.add(listener));
  const removeListener = vi.fn(listener => listeners.delete(listener));
  class EventManager {
    constructor(options) { this.options = options; eventManagers.push(options); }
    api() {
      const manager = this;
      const subscriptions = new Map();
      return {
        addListener(callback) {
          const fire = { async: vi.fn(payload => callback(payload)) };
          const { register, extensionApi, event } = manager.options;
          subscriptions.set(callback, register
            ? register(fire)
            : extensionApi.PERSISTENT_EVENTS[event]({ fire }));
        },
        removeListener(callback) {
          const subscription = subscriptions.get(callback);
          if (typeof subscription === 'function') subscription();
          else subscription?.unregister();
          subscriptions.delete(callback);
        },
      };
    }
  }
  const sandbox = {
    ChromeUtils: { importESModule(path) {
      if (path.includes('ExtensionCommon')) return { ExtensionCommon: {
        ExtensionAPI: class {},
        ExtensionAPIPersistent: class {
          constructor(extension) { this.extension = extension; }
          primeListener(event, fire) { return this.PERSISTENT_EVENTS[event]({ fire }); }
        },
        EventManager,
      } };
      if (path.includes('Timer')) return { clearInterval: vi.fn(), setInterval: vi.fn(() => 1) };
      if (path.includes('MailServices')) return { MailServices: { mfn: { addListener, removeListener } } };
      if (path.includes('MailUtils')) return { MailUtils: {} };
      throw new Error(path);
    } },
    console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    Ci: { nsMsgMessageFlags: { IMAPDeleted: 1, Expunged: 2 } },
  };
  vm.runInNewContext(`${source}\nglobalThis.Experiment = tmMsgNotify;`, sandbox);
  const extension = {
    folderManager: { convert: folder => ({ id: folder.URI, path: `/${folder.URI.split('/').at(-1)}`, accountId: 'test' }) },
    messageManager: { convert: () => ({ id: 1 }) },
  };
  const instance = new sandbox.Experiment(extension);
  const api = instance.getAPI({ extension }).tmMsgNotify;
  return { api, instance, listeners, eventManagers, addListener, removeListener, errorLog: sandbox.console.error };
}

const header = {
  folder: { URI: 'mailbox://test/Inbox' }, messageId: 'synthetic@example.test',
  subject: 'synthetic', author: 'sender@example.test', dateInSeconds: 1,
  messageKey: 1, flags: 0,
};

describe('tmMsgNotify independent event subscriptions', () => {
  it('primes each native event family and converts its fire without adding another native listener', () => {
    const { api, instance, listeners, eventManagers, addListener, removeListener } = createExperiment();
    expect(eventManagers.map(({ module, event, extensionApi }) => [module, event, extensionApi === instance])).toEqual([
      ['tmMsgNotify', 'onMessageAdded', true],
      ['tmMsgNotify', 'onMessageRemoved', true],
    ]);
    const agent = vi.fn();
    api.onMessageAdded.addListener(agent);
    const addedWake = vi.fn();
    const removedWake = vi.fn();
    const added = instance.primeListener('onMessageAdded', { async: addedWake });
    const removed = instance.primeListener('onMessageRemoved', { async: removedWake });
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    const native = [...listeners][0];
    native.msgAdded(header);
    native.msgsDeleted([header]);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(addedWake).toHaveBeenCalledTimes(1);
    expect(removedWake).toHaveBeenCalledTimes(1);

    const addedAfterWake = vi.fn();
    const removedAfterWake = vi.fn();
    added.convert({ async: addedAfterWake });
    removed.convert({ async: removedAfterWake });
    native.msgsClassified([header]);
    native.msgsMoveCopyCompleted(true, [header], header.folder, [header]);
    expect(addedWake).toHaveBeenCalledTimes(1);
    expect(removedWake).toHaveBeenCalledTimes(1);
    expect(addedAfterWake).toHaveBeenCalledTimes(2);
    expect(removedAfterWake).toHaveBeenCalledTimes(1);
    expect(agent).toHaveBeenCalledTimes(3);

    added.unregister();
    native.msgAdded(header);
    native.msgsDeleted([header]);
    expect(addedAfterWake).toHaveBeenCalledTimes(2);
    expect(removedAfterWake).toHaveBeenCalledTimes(2);
    expect(agent).toHaveBeenCalledTimes(4);
    removed.unregister();
    api.onMessageAdded.removeListener(agent);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('removes a primed native registration on true extension shutdown', () => {
    const { instance, listeners, removeListener } = createExperiment();
    const added = vi.fn();
    const removed = vi.fn();
    instance.primeListener('onMessageAdded', { async: added });
    instance.primeListener('onMessageRemoved', { async: removed });
    const native = [...listeners][0];
    instance.onShutdown(false);
    expect(removeListener).toHaveBeenCalledTimes(1);
    native.msgAdded(header);
    native.msgsDeleted([header]);
    expect(added).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  it.each(['first', 'second'])('delivers to both consumers and survives removing the %s subscriber', removed => {
    const { api, listeners, addListener, removeListener } = createExperiment();
    const first = vi.fn();
    const second = vi.fn();
    api.onMessageAdded.addListener(first);
    api.onMessageAdded.addListener(second);
    expect(addListener).toHaveBeenCalledTimes(1);
    for (const listener of listeners) listener.msgAdded(header);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    api.onMessageAdded.removeListener(removed === 'first' ? first : second);
    for (const listener of listeners) listener.msgAdded(header);
    expect(first).toHaveBeenCalledTimes(removed === 'first' ? 1 : 2);
    expect(second).toHaveBeenCalledTimes(removed === 'second' ? 1 : 2);
    expect(removeListener).not.toHaveBeenCalled();

    api.onMessageAdded.removeListener(removed === 'first' ? second : first);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it.each(['added', 'removed'])('keeps the other event family after %s unsubscribes', firstFamily => {
    const { api, listeners, removeListener } = createExperiment();
    const added = vi.fn();
    const removed = vi.fn();
    api.onMessageAdded.addListener(added);
    api.onMessageRemoved.addListener(removed);
    if (firstFamily === 'added') api.onMessageAdded.removeListener(added);
    else api.onMessageRemoved.removeListener(removed);
    expect(removeListener).not.toHaveBeenCalled();
    for (const listener of listeners) {
      listener.msgAdded(header);
      listener.msgsDeleted([header]);
    }
    expect(added).toHaveBeenCalledTimes(firstFamily === 'removed' ? 1 : 0);
    expect(removed).toHaveBeenCalledTimes(firstFamily === 'added' ? 1 : 0);
    if (firstFamily === 'added') api.onMessageRemoved.removeListener(removed);
    else api.onMessageAdded.removeListener(added);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it.each(['first', 'second'])('keeps the other removal subscriber when the %s unsubscribes', removed => {
    const { api, listeners, addListener, removeListener } = createExperiment();
    const first = vi.fn();
    const second = vi.fn();
    api.onMessageRemoved.addListener(first);
    api.onMessageRemoved.addListener(second);
    expect(addListener).toHaveBeenCalledTimes(1);
    for (const listener of listeners) listener.msgsDeleted([header]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    api.onMessageRemoved.removeListener(removed === 'first' ? first : second);
    for (const listener of listeners) listener.msgsDeleted([header]);
    expect(first).toHaveBeenCalledTimes(removed === 'first' ? 1 : 2);
    expect(second).toHaveBeenCalledTimes(removed === 'second' ? 1 : 2);
    expect(removeListener).not.toHaveBeenCalled();
    api.onMessageRemoved.removeListener(removed === 'first' ? second : first);
    expect(removeListener).toHaveBeenCalledTimes(1);
    const later = vi.fn();
    api.onMessageRemoved.addListener(later);
    expect(addListener).toHaveBeenCalledTimes(2);
    for (const listener of listeners) listener.msgsDeleted([header]);
    expect(later).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(removed === 'first' ? 1 : 2);
    expect(second).toHaveBeenCalledTimes(removed === 'second' ? 1 : 2);
  });

  it('isolates a rejected or pending subscriber without delaying a healthy peer', async () => {
    const { api, listeners, errorLog } = createExperiment();
    let release;
    const pending = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const rejecting = vi.fn(() => Promise.reject(new Error('synthetic rejection')));
    const healthy = vi.fn();
    api.onMessageAdded.addListener(pending);
    api.onMessageAdded.addListener(rejecting);
    api.onMessageAdded.addListener(healthy);
    for (const listener of listeners) listener.msgAdded(header);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(pending).toHaveBeenCalledTimes(1);
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('msgAdded subscriber failed'),
      expect.objectContaining({ message: 'synthetic rejection' }),
    );
    for (const listener of listeners) listener.msgAdded(header);
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('clears stale subscriptions on shutdown (app=%s)', isAppShutdown => {
    const { api, instance, listeners, removeListener } = createExperiment();
    const added = vi.fn();
    const removed = vi.fn();
    api.onMessageAdded.addListener(added);
    api.onMessageRemoved.addListener(removed);
    const nativeListener = [...listeners][0];
    nativeListener.msgAdded(header);
    nativeListener.msgsDeleted([header]);
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
    instance.onShutdown(isAppShutdown);
    expect(removeListener).toHaveBeenCalledTimes(isAppShutdown ? 0 : 1);
    nativeListener.msgAdded(header);
    nativeListener.msgsDeleted([header]);
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('delivers classification and move/copy events to every subscriber even when one fails', () => {
    const { api, listeners } = createExperiment();
    const broken = vi.fn(() => { throw new Error('synthetic callback failure'); });
    const healthy = vi.fn();
    const secondHealthy = vi.fn();
    const removed = vi.fn();
    const secondRemoved = vi.fn();
    api.onMessageAdded.addListener(broken);
    api.onMessageAdded.addListener(healthy);
    api.onMessageAdded.addListener(secondHealthy);
    api.onMessageRemoved.addListener(removed);
    api.onMessageRemoved.addListener(secondRemoved);
    for (const listener of listeners) {
      listener.msgsClassified([header]);
      listener.msgsMoveCopyCompleted(true, [header], header.folder, [header]);
      listener.msgsMoveCopyCompleted(false, [header], header.folder, [header]);
    }
    expect(healthy.mock.calls.map(([info]) => info.eventType)).toEqual([
      'classified', 'moveCompleted', 'copyCompleted',
    ]);
    expect(secondHealthy.mock.calls.map(([info]) => info.eventType)).toEqual([
      'classified', 'moveCompleted', 'copyCompleted',
    ]);
    expect(broken).toHaveBeenCalledTimes(3);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(secondRemoved).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0][0].eventType).toBe('moveCompleted');
  });

  it('reports source and destination identities separately for move and copy', () => {
    const { api, listeners } = createExperiment();
    const added = vi.fn();
    const removed = vi.fn();
    api.onMessageAdded.addListener(added);
    api.onMessageRemoved.addListener(removed);
    const source = { ...header, messageId: 'source@example.test', folder: { URI: 'mailbox://test/Source' } };
    const destination = { ...header, messageId: 'destination@example.test', folder: { URI: 'mailbox://test/Destination' } };
    for (const listener of listeners) {
      listener.msgsMoveCopyCompleted(true, [source], destination.folder, [destination]);
      listener.msgsMoveCopyCompleted(false, [source], destination.folder, [destination]);
    }
    expect(removed.mock.calls.map(([info]) => [info.headerMessageId, info.folderPath, info.eventType])).toEqual([
      ['source@example.test', '/Source', 'moveCompleted'],
    ]);
    expect(added.mock.calls.map(([info]) => [info.headerMessageId, info.folderPath, info.eventType])).toEqual([
      ['destination@example.test', '/Destination', 'moveCompleted'],
      ['destination@example.test', '/Destination', 'copyCompleted'],
    ]);
  });
});
